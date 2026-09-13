import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { beginJudgmentRetention, endJudgmentRetention } from '../../engine/judgment-retention'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张曼成（三国杀 OL 经典身份 SP，狂信/雷噬——不是掠城/螽集版本）。
 *
 * 【狂信】：锁定技，出牌阶段开始时，失去任意点体力，摸等量的牌，然后展示
 *          lostHp+1张手牌；结束阶段将体力值调整回上个准备阶段的快照。
 * 【雷噬】：出牌阶段限X次（X=本回合狂信展示的牌数），使用本回合狂信展示
 *          过的具体牌结算完成后可以发动：进行判定，获得判定牌；花色与刚
 *          使用的牌相同则对一名角色造成1点雷电伤害，不同则展示1张手牌，
 *          建立本回合下一次判定替换。
 */

const KUANGXIN = 'kuangxin'
const LEISHI = 'leishi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KUANGXIN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (payload.phase === 'prepare' && payload.playerId === ownerId) {
          host.state.zhangmanchengHpSnapshot = owner.hp
          return
        }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        host.queueSkill({ skillId: KUANGXIN, ownerId, step: 'losehp-ask', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        const snapshot = host.state.zhangmanchengHpSnapshot
        if (!owner?.alive || snapshot === undefined) return
        if (owner.hp < snapshot) recover(host as never, ownerId, snapshot - owner.hp, ownerId)
        else if (owner.hp > snapshot) loseHp(host as never, ownerId, owner.hp - snapshot, KUANGXIN)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'losehp-ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: KUANGXIN, ownerId, step: 'losehp', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【狂信】：选择失去的体力点数', timeoutMs: 20_000, optional: false,
        options: Array.from({ length: Math.max(1, owner.hp) }, (_, index) => ({ id: String(index + 1), label: `失去${index + 1}点体力` })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'losehp') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const n = Number((response.payload as { optionId?: string }).optionId ?? '0')
    if (n <= 0) return
    loseHp(host as never, ownerId, n, KUANGXIN)
    if (host.state.status !== 'playing' || !playerOf(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, n, (name, payload) => { host.dispatch(name, payload) })
    const owner2 = playerOf(host.state, ownerId)!
    const showCount = Math.min(n + 1, owner2.zones.hand.length)
    const shown = owner2.zones.hand.slice(0, showCount)
    host.state.zhangmanchengShown = { turnNumber: host.state.turnNumber, cardIds: shown }
    if (shown.length > 0) host.dispatch('CardMove', { cardIds: shown, reason: KUANGXIN, revealed: true }, { sourceId: ownerId })
    host.dispatch('SkillActivated', { skillId: KUANGXIN, skillName: '狂信', playerId: ownerId, logText: `${owner2.nickname}发动【狂信】，失去${n}点体力，摸${n}张牌` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: LEISHI,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const shown = host.state.zhangmanchengShown
      if (!shown || shown.turnNumber !== host.state.turnNumber) return
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (payload.cancelled || !payload.cardId || !shown.cardIds.includes(payload.cardId)) return
      const owner = playerOf(host.state, ownerId)
      const usedCount = owner?.marks['leishi-used-turn'] === host.state.turnNumber ? (owner.marks['leishi-count'] ?? 0) : 0
      if (!owner?.alive || usedCount >= shown.cardIds.length) return
      owner.marks['leishi-used-turn'] = host.state.turnNumber
      owner.marks['leishi-count'] = usedCount + 1
      const effectiveSuit = payload.cardId ? host.state.cards[payload.cardId]?.suit : undefined
      host.queueSkill({ skillId: LEISHI, ownerId, step: 'ask', data: { effectiveSuit } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    host.askSkill({
      skillId: LEISHI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【雷噬】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const { effectiveSuit } = resolution.data as { effectiveSuit?: string }
      const optionId = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (optionId !== 'yes' || !owner?.alive) return
      host.dispatch('SkillActivated', { skillId: LEISHI, skillName: '雷噬', playerId: ownerId, logText: `${owner.nickname}发动【雷噬】` }, { sourceId: ownerId })
      // 判定牌要收进张曼成手里而不是直接进弃牌堆，用既有的判定暂存机制
      // 让 finishJudgment 把它留在处理区，续接里再统一转手。
      beginJudgmentRetention(host.state, ownerId, LEISHI)
      performJudgment(host, ownerId, LEISHI, { tag: LEISHI, data: { ownerId, effectiveSuit } })
      return
    }
    if (resolution.step === 'damage-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'thunder', cardName: null })
      return
    }
    if (resolution.step === 'show-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      host.dispatch('CardMove', { cardIds: [cardId], reason: LEISHI, revealed: true }, { sourceId: ownerId })
      host.state.zhangmanchengJudgeReplace = { turnNumber: host.state.turnNumber, cardId }
      host.dispatch('SkillActivated', { skillId: LEISHI, skillName: '雷噬', playerId: ownerId, logText: `${owner.nickname}发动【雷噬】，建立下一次判定替换` }, { sourceId: ownerId })
    }
  },
  forcedJudgmentCard(host, ownerId, judgingPlayerId) {
    if (judgingPlayerId !== ownerId) return null
    const pending = host.state.zhangmanchengJudgeReplace
    if (!pending || pending.turnNumber !== host.state.turnNumber) return null
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.includes(pending.cardId)) { host.state.zhangmanchengJudgeReplace = undefined; return null }
    host.state.zhangmanchengJudgeReplace = undefined
    moveCard(host.state, pending.cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
    return pending.cardId
  },
})

registerJudgmentContinuation(LEISHI, (host, judged, data) => {
  const { ownerId, effectiveSuit } = data as { ownerId: PlayerId; effectiveSuit?: string }
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { endJudgmentRetention(host.state, null); return }
  endJudgmentRetention(host.state, ownerId)
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], reason: LEISHI }, { targetId: ownerId, cardIds: [judged.id] })
  const skillHost = host as unknown as SkillHost
  if (judged.suit === effectiveSuit) {
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    skillHost.askSkill({
      skillId: LEISHI, ownerId, step: 'damage-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【雷噬】：选择一名角色，造成1点雷电伤害', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
    return
  }
  if (owner.zones.hand.length === 0) return
  skillHost.askSkill({
    skillId: LEISHI, ownerId, step: 'show-card', data: {},
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: '【雷噬】：展示1张手牌，建立下一次判定替换', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
})

export const ZHANGMANCHENG: CharacterDefinition = {
  id: 'zhangmancheng',
  name: '张曼成',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: KUANGXIN, name: '狂信', description: '锁定技，出牌阶段开始时，失去任意点体力，摸等量的牌，然后展示lostHp+1张手牌；结束阶段将体力值调整回上个准备阶段的快照。' },
    { id: LEISHI, name: '雷噬', description: '出牌阶段限X次（X=本回合狂信展示的牌数），使用本回合狂信展示过的具体牌结算完成后可以发动：进行判定，获得判定牌；花色与刚使用的牌相同则对一名角色造成1点雷电伤害，不同则展示1张手牌，建立本回合下一次判定替换。' },
  ],
}
