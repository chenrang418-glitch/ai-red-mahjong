import { moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张琪瑛（三国杀 OL 经典身份 SP）。
 *
 * 【法箓】：锁定技，游戏开始获得四类标记（黑桃-紫微/梅花-后土/红桃-玉清/
 *          方片-勾陈，各最多1枚）；张琪瑛的牌因弃置进入弃牌堆后，按花色
 *          补齐尚未持有的标记。
 * 【真仪】：
 *   紫微：一张判定牌即将生效前，可以移除紫微，令结果强制视为黑桃5或
 *         红桃5（`judgmentRankOverride`/`cardSuit` 组合，只能影响张琪瑛
 *         自己的判定，因为这两个钩子都按判定角色自己的技能聚合）。
 *   后土：处于濒死时，可以移除后土，将1张手牌当【桃】使用（引擎没有
 *         "求救时选一张任意手牌"的交互点，`invokeRescueAction` 是同步
 *         的，这里简化为随机选1张手牌，不做逐张询问）。
 *   玉清：造成伤害时可以移除玉清进行判定，黑色则这次伤害+1（简化为
 *         直接查看牌堆顶并弃置，不走完整可改判的判定管线，避免在同步的
 *         伤害数值钩子里再嵌一层交互式改判）。
 *   勾陈：受到属性伤害后可以移除勾陈，从牌堆获得基本牌/普通锦囊/装备牌
 *         各1张（若某类不存在则只取实际存在的部分）。
 * 【点化】：准备阶段或结束阶段，观看牌堆顶X张（X=当前持有的法箓标记数），
 *          可以选择保持原顺序或整体倒序放回（简化的重排实现）。
 */

const FALU = 'falu'
const ZHENYI = 'zhenyi'
const DIANHUA = 'dianhua'
const ZIWEI_MARK = 'ziwei'
const HOUTU_MARK = 'houtu'
const YUQING_MARK = 'yuqing'
const GOUCHEN_MARK = 'gouchen'

const SUIT_MARK: Record<Suit, string> = { spade: ZIWEI_MARK, club: HOUTU_MARK, heart: YUQING_MARK, diamond: GOUCHEN_MARK }

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function faluMarkCount(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  return [ZIWEI_MARK, HOUTU_MARK, YUQING_MARK, GOUCHEN_MARK].filter((mark) => (owner.marks[mark] ?? 0) > 0).length
}

registerSkillRuntime({
  id: FALU,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        owner.marks[ZIWEI_MARK] = 1
        owner.marks[HOUTU_MARK] = 1
        owner.marks[YUQING_MARK] = 1
        owner.marks[GOUCHEN_MARK] = 1
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
        if (payload.reason !== 'discard' || payload.playerId !== ownerId || !payload.cardIds) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        for (const cardId of payload.cardIds) {
          const suit = host.state.cards[cardId]?.suit
          if (!suit) continue
          const mark = SUIT_MARK[suit]
          if ((owner.marks[mark] ?? 0) <= 0) owner.marks[mark] = 1
        }
      },
    },
  ],
})

registerSkillRuntime({
  id: ZHENYI,
  cardSuit(state, ownerId, cardId, printedSuit) {
    const active = state.zhangqiyingZiweiChoice
    if (!active || active.ownerId !== ownerId || active.cardId !== cardId) return printedSuit
    return active.suit
  },
  judgmentRankOverride(state, ownerId, cardId) {
    const active = state.zhangqiyingZiweiChoice
    if (!active || active.ownerId !== ownerId || active.cardId !== cardId) return null
    return 5
  },

  triggers: [
    {
      event: 'JudgeStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; judgeCardId?: CardId }
        if (payload.playerId !== ownerId || !payload.judgeCardId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || (owner.marks[ZIWEI_MARK] ?? 0) <= 0) return
        host.queueSkill({ skillId: ZHENYI, ownerId, step: 'ziwei', data: { cardId: payload.judgeCardId } })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || context.event.damageNature === 'normal') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || (owner.marks[GOUCHEN_MARK] ?? 0) <= 0) return
        host.queueSkill({ skillId: ZHENYI, ownerId, step: 'gouchen-ask', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ziwei') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (owner.marks[ZIWEI_MARK] ?? 0) <= 0) return
      host.askSkill({
        skillId: ZHENYI, ownerId, step: 'ziwei', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【真仪·紫微】：是否移除紫微，令判定结果改为黑桃5或红桃5？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'none', label: '不发动' }, { id: 'spade', label: '黑桃5' }, { id: 'heart', label: '红桃5' }],
        }),
      })
      return
    }
    if (prompt.step === 'gouchen-ask') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (owner.marks[GOUCHEN_MARK] ?? 0) <= 0) return
      host.askSkill({
        skillId: ZHENYI, ownerId, step: 'gouchen-ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【真仪·勾陈】：是否移除勾陈，获得基本牌/普通锦囊/装备牌各1张？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ziwei') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'spade' && optionId !== 'heart') return
      const { cardId } = resolution.data as { cardId: CardId }
      owner.marks[ZIWEI_MARK] = 0
      host.state.zhangqiyingZiweiChoice = { ownerId, cardId, suit: optionId }
      host.dispatch('SkillActivated', { skillId: ZHENYI, skillName: '真仪', playerId: ownerId, logText: `${owner.nickname}发动【真仪·紫微】` }, { sourceId: ownerId })
      return
    }

    if (resolution.step === 'gouchen-ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || (owner.marks[GOUCHEN_MARK] ?? 0) <= 0) return
      owner.marks[GOUCHEN_MARK] = 0
      host.dispatch('SkillActivated', { skillId: ZHENYI, skillName: '真仪', playerId: ownerId, logText: `${owner.nickname}发动【真仪·勾陈】` }, { sourceId: ownerId })
      for (const category of ['basic', 'trick', 'equipment'] as const) {
        const found = host.state.zones.drawPile.find((cardId) => host.state.cards[cardId]?.category === category)
        if (!found) continue
        moveCard(host.state, found, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [found], reason: ZHENYI }, { targetId: ownerId, cardIds: [found] })
      }
    }
  },

  rescueActions(state, ownerId, dyingPlayerId) {
    if (dyingPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || (owner.marks[HOUTU_MARK] ?? 0) <= 0 || owner.zones.hand.length === 0) return []
    return [{ id: 'zhenyi-houtu', label: '发动【真仪·后土】：移除后土，将1张手牌当【桃】使用' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== 'zhenyi-houtu' || dyingPlayerId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (owner.marks[HOUTU_MARK] ?? 0) <= 0 || owner.zones.hand.length === 0) return false
    owner.marks[HOUTU_MARK] = 0
    const cardId = owner.zones.hand[host.rng.nextInt(owner.zones.hand.length)]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHENYI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: ZHENYI, skillName: '真仪', playerId: ownerId, logText: `${owner.nickname}发动【真仪·后土】，视为使用一张【桃】` }, { sourceId: ownerId })
    recover(host as never, ownerId, 1, ownerId)
    return true
  },

  outgoingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    if (!owner || (owner.marks[YUQING_MARK] ?? 0) <= 0) return null
    const cardId = state.zones.drawPile[0]
    if (!cardId) return null
    owner.marks[YUQING_MARK] = 0
    const suit = state.cards[cardId]?.suit
    moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    if (suit !== 'spade' && suit !== 'club') return null
    return { amount: context.amount + 1 }
  },
})

registerSkillRuntime({
  id: DIANHUA,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if ((payload.phase !== 'prepare' && payload.phase !== 'end') || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      const x = faluMarkCount(host.state, ownerId)
      if (!owner?.alive || x <= 0) return
      host.queueSkill({ skillId: DIANHUA, ownerId, step: 'ask', data: { x } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { x } = prompt.data as { x: number }
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: DIANHUA, ownerId, step: 'ask', data: { x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【点化】：观看牌堆顶${x}张，是否倒序放回？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'keep', label: '保持原顺序' }, { id: 'reverse', label: '倒序放回' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { x } = resolution.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId !== 'reverse') return
    const top = host.state.zones.drawPile.slice(0, x).reverse()
    host.state.zones.drawPile.splice(0, x, ...top)
    host.dispatch('SkillActivated', { skillId: DIANHUA, skillName: '点化', playerId: ownerId, logText: `${owner.nickname}发动【点化】` }, { sourceId: ownerId })
  },
})

export const ZHANGQIYING: CharacterDefinition = {
  id: 'zhangqiying',
  name: '张琪瑛',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: FALU, name: '法箓', description: '锁定技，游戏开始获得紫微/后土/玉清/勾陈四类标记各1枚；因弃置进入弃牌堆的牌按花色为张琪瑛补齐尚未持有的标记。' },
    { id: ZHENYI, name: '真仪', description: '紫微：判定牌生效前可以移除紫微，令结果改为黑桃5或红桃5；后土：濒死时可以移除后土，将1张手牌当桃使用；玉清：造成伤害时可以移除玉清进行判定，黑色则伤害+1；勾陈：受到属性伤害后可以移除勾陈，获得基本牌/普通锦囊/装备牌各1张。' },
    { id: DIANHUA, name: '点化', description: '准备阶段或结束阶段，观看牌堆顶X张（X为当前持有的法箓标记数），可以选择保持顺序或整体倒序放回。' },
  ],
}
