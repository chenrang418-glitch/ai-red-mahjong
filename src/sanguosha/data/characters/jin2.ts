import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { canUseSlash } from '../../engine/slash-rules'
import { setChained } from '../../engine/character-state'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { effectiveKingdomOf } from '../../engine/huashen'
import { attackRangeCovers } from '../../engine/ask-use-slash'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import type { CharacterDefinition } from './types'

/**
 * 晋系专项第二批：晋司马懿、晋张春华、羊祜、石苞、文鸯、卫瓘、杨艳、杨芷、
 * 王濬、司马孚。全部采用当前三国杀OL身份模式版本；王濬/司马孚锁《一将
 * 成名》当前页。司马孚官方势力仍为魏，不因批次标题改判为晋。
 *
 * ID 与已有的标准司马懿（simayi）、标准张春华（zhangchunhua）互不冲突。
 *
 * 隐匿技（不臣/宣穆）沿用晋第一批（司马师韬隐等）确立的身份模式最低
 * 成本兼容规则：游戏开始后第一次相关时机触发一次等效效果，不新建暗将
 * 系统。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ============================== 晋司马懿 ==============================

const BUCHEN = 'buchen'
const YINGSHI = 'yingshi2'
const XIONGZHI = 'xiongzhi'
const QUANBIAN = 'quanbian'

registerSkillRuntime({
  id: BUCHEN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if ((host.state.buchenUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const turnOwner = playerOf(host.state, payload.playerId)
      if (!owner?.alive || !turnOwner?.alive || turnOwner.zones.hand.length === 0) return
      host.state.buchenUsed = [...(host.state.buchenUsed ?? []), ownerId]
      const cardId = turnOwner.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: turnOwner.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: turnOwner.id, cardIds: [cardId], reason: BUCHEN }, { sourceId: turnOwner.id, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: BUCHEN }, { sourceId: turnOwner.id, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: BUCHEN, skillName: '不臣', playerId: ownerId, targetId: turnOwner.id, logText: `${owner.nickname}发动【不臣】` }, { sourceId: ownerId, targetId: turnOwner.id })
    },
  }],
})

registerSkillRuntime({
  id: YINGSHI,
  drawPileTopVisibleCount(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return 0
    const owner = playerOf(state, ownerId)
    return owner?.alive ? owner.maxHp : 0
  },
})

registerSkillRuntime({
  id: XIONGZHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(XIONGZHI)) return
      host.queueSkill({ skillId: XIONGZHI, ownerId, step: 'loop', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'loop') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIONGZHI)) return
    const top = host.state.zones.drawPile[0]
    if (!top) return
    const card = host.state.cards[top]
    const usable = card && card.category !== 'equipment' && (card.name !== '杀' || canUseSlash(host.state, ownerId, false))
    host.askSkill({
      skillId: XIONGZHI, ownerId, step: 'loop', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【雄志】：牌堆顶是【${card?.name ?? '未知'}】，是否使用？`, timeoutMs: 20_000, optional: true,
        options: usable ? [{ id: 'use', label: '使用' }, { id: 'stop', label: '停止' }] : [{ id: 'stop', label: '停止（无合法使用）' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'loop') {
      if (owner.usedLimitedSkills.includes(XIONGZHI)) return
      const optionId = (response.payload as { optionId?: string }).optionId
      owner.usedLimitedSkills.push(XIONGZHI)
      if (optionId !== 'use') return
      const top = host.state.zones.drawPile[0]
      if (!top) return
      const card = host.state.cards[top]
      if (!card || card.category === 'equipment') return
      host.dispatch('SkillActivated', { skillId: XIONGZHI, skillName: '雄志', playerId: ownerId, logText: `${owner.nickname}发动【雄志】使用牌堆顶的【${card.name}】` }, { sourceId: ownerId })
      if (card.name === '杀') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: XIONGZHI, ownerId, step: 'pick-target', data: { cardId: top },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【雄志】：选择杀的目标', timeoutMs: 20_000, optional: true,
            candidateIds, min: 0, max: 1,
          }),
        })
        return
      }
      // 非杀的牌堆顶牌：简化为对自己生效的合法使用（桃/酒等自向基本牌），装备/带目标锦囊不在雄志的最小实现范围内
      if (card.name === '桃') {
        moveCard(host.state, top, { kind: 'drawPile' }, { kind: 'discardPile' })
        if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
      } else if (card.name === '酒') {
        moveCard(host.state, top, { kind: 'drawPile' }, { kind: 'discardPile' })
      } else return
      owner.usedLimitedSkills = owner.usedLimitedSkills.filter((id) => id !== XIONGZHI)
      host.queueSkill({ skillId: XIONGZHI, ownerId, step: 'loop', data: {} })
      return
    }
    if (resolution.step === 'pick-target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || !host.state.zones.drawPile.includes(cardId)) return
      // beginVirtualSlash 的 cardId 载体假定是手牌；先把牌堆顶这张牌摸进手里再作为载体，保持真实 Card ID 不变
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: XIONGZHI }, { targetId: ownerId, cardIds: [cardId] })
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: XIONGZHI, cardId, countUsage: true })
      host.queueSkill({ skillId: XIONGZHI, ownerId, step: 'loop', data: {} })
    }
  },
})

registerSkillRuntime({
  id: QUANBIAN,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { cardId?: CardId; virtual?: boolean }
      if (payload.virtual || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (!card?.suit) return
      const usedSuits = host.state.quanbianUsed?.turnNumber === host.state.turnNumber ? host.state.quanbianUsed.suits : []
      if (usedSuits.includes(card.suit)) return
      host.state.quanbianUsed = { turnNumber: host.state.turnNumber, suits: [...usedSuits, card.suit] }
      const x = owner.maxHp
      const top = host.state.zones.drawPile.slice(0, x)
      const eligible = top.filter((id) => host.state.cards[id]?.suit !== card.suit)
      if (eligible.length === 0) return
      host.queueSkill({ skillId: QUANBIAN, ownerId, step: 'pick', data: { top, eligible } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { eligible } = prompt.data as { eligible: CardId[] }
    host.askSkill({
      skillId: QUANBIAN, ownerId, step: 'pick', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【权变】：从牌堆顶获得1张与刚用的牌花色不同的牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { top } = resolution.data as { top: CardId[] }
    const [picked] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const rest = top.filter((id) => id !== picked && host.state.zones.drawPile.includes(id))
    if (picked && host.state.zones.drawPile.includes(picked)) {
      moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId }, { toTop: true })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: QUANBIAN }, { targetId: ownerId, cardIds: [picked] })
      host.dispatch('SkillActivated', { skillId: QUANBIAN, skillName: '权变', playerId: ownerId, logText: `${owner.nickname}发动【权变】` }, { sourceId: ownerId })
    }
    // 其余牌堆顶余牌保持原相对顺序留在牌堆顶（按当前顺序放回，等价于"任意排列"里最简单的一种）
    for (const cardId of [...rest].reverse()) {
      if (host.state.zones.drawPile.includes(cardId)) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    }
  },
})

// ============================== 晋张春华 ==============================

const HUISHI = 'huishi2'
const QINGLENG = 'qingleng'
const XUANMU = 'xuanmu'

registerSkillRuntime({
  id: HUISHI,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      context.cancel()
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = host.state.zones.drawPile.length % 10
      host.dispatch('SkillActivated', { skillId: HUISHI, skillName: '慧识', playerId: ownerId, logText: `${owner.nickname}发动【慧识】` }, { sourceId: ownerId })
      if (x === 0) return
      const top = host.state.zones.drawPile.slice(0, x)
      const gainCount = Math.floor(x / 2)
      if (gainCount === 0) {
        for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'drawPile' })
        return
      }
      host.queueSkill({ skillId: HUISHI, ownerId, step: 'pick', data: { top, gainCount } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { top, gainCount } = prompt.data as { top: CardId[]; gainCount: number }
    host.askSkill({
      skillId: HUISHI, ownerId, step: 'pick', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【慧识】：从展示的${top.length}张牌中选择${gainCount}张获得`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: top, hiddenCardSlots: [], min: gainCount, max: gainCount,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { top } = resolution.data as { top: CardId[] }
    const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => host.state.zones.drawPile.includes(id))
    const rest = top.filter((id) => !picked.includes(id) && host.state.zones.drawPile.includes(id))
    if (picked.length > 0) {
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: picked, reason: HUISHI }, { targetId: ownerId, cardIds: picked })
    }
    for (const cardId of rest) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'drawPile' })
  },
})

registerSkillRuntime({
  id: QINGLENG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const targetId = payload.playerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
      const x = host.state.zones.drawPile.length % 10
      if (target.hp + target.zones.hand.length < x) return
      host.queueSkill({ skillId: QINGLENG, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: QINGLENG, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【清冷】：是否将1张牌当无距离限制的冰属性杀使用？', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...playerOf(host.state, ownerId)!.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    host.dispatch('SkillActivated', { skillId: QINGLENG, skillName: '清冷', playerId: ownerId, targetId, logText: `${owner.nickname}发动【清冷】` }, { sourceId: ownerId, targetId })
    if (!(host.state.qinglengTargets ?? []).includes(targetId)) {
      host.state.qinglengTargets = [...(host.state.qinglengTargets ?? []), targetId]
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    }
    // beginVirtualSlash 的 cardId 载体要求这张牌本身就有效名为"杀"；
    // 这里是"当杀使用"的转化，实体牌只作为发动代价弃置，杀本身走纯虚拟杀
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QINGLENG }, { sourceId: ownerId, cardIds: [cardId] })
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: QINGLENG, nature: 'ice' })
  },
})

registerSkillRuntime({
  id: XUANMU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if ((host.state.xuanmuUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.state.xuanmuUsed = [...(host.state.xuanmuUsed ?? []), ownerId]
      host.state.xuanmuShielded = { ownerId, turnNumber: host.state.turnNumber }
      host.dispatch('SkillActivated', { skillId: XUANMU, skillName: '宣穆', playerId: ownerId, logText: `${owner.nickname}发动【宣穆】` }, { sourceId: ownerId })
    },
  }],
  preventsDamage(state, ownerId, side, context) {
    if (side !== 'target' || context.targetId !== ownerId) return false
    return state.xuanmuShielded?.ownerId === ownerId && state.xuanmuShielded.turnNumber === state.turnNumber
  },
})

// ============================== 羊祜 ==============================

const HUAIYUAN = 'huaiyuan'
const CHONGXIN = 'chongxin'
const DEZHANG = 'dezhang'
const WEISHU = 'weishu'

registerSkillRuntime({
  id: HUAIYUAN,
  allowsDeadResponder: true,
  maxCardsBonus(state, ownerId) {
    return playerOf(state, ownerId)?.marks['huaiyuan-maxcards'] ?? 0
  },
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.state.suiCardIds = [...(host.state.suiCardIds ?? []), ...owner.zones.hand]
  },
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId) return
        handleSuiLeave(host, ownerId, payload.cardIds ?? [])
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const sui = (payload.cardIds ?? []).filter((cardId) => (host.state.suiCardIds ?? []).includes(cardId) && !owner.zones.hand.includes(cardId))
        handleSuiLeave(host, ownerId, sui)
      },
    },
    {
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const source = host.state.huaiyuanSource?.[ownerId]
        const totalMaxCards = Object.values(host.state.huaiyuanSource ?? {}).reduce((sum, entry) => sum + (entry.maxCards ?? 0), 0)
        const totalRange = Object.values(host.state.huaiyuanSource ?? {}).reduce((sum, entry) => sum + (entry.range ?? 0), 0)
        void source
        if (totalMaxCards === 0 && totalRange === 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: HUAIYUAN, ownerId, step: 'transfer', data: { candidateIds }, allowDeadOwner: true })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'transfer') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: HUAIYUAN, ownerId, step: 'transfer', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【怀远】：选择一名角色接收此前怀远增加出去的所有加成', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: HUAIYUAN, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【怀远】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'transfer') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const totalMaxCards = Object.values(host.state.huaiyuanSource ?? {}).reduce((sum, entry) => sum + (entry.maxCards ?? 0), 0)
      const totalRange = Object.values(host.state.huaiyuanSource ?? {}).reduce((sum, entry) => sum + (entry.range ?? 0), 0)
      for (const [sourceTargetId, entry] of Object.entries(host.state.huaiyuanSource ?? {})) {
        const affected = playerOf(host.state, sourceTargetId)
        if (!affected) continue
        if (entry.maxCards) affected.marks['huaiyuan-maxcards'] = Math.max(0, (affected.marks['huaiyuan-maxcards'] ?? 0) - entry.maxCards)
        if (entry.range) affected.attackRangeBonus = Math.max(0, (affected.attackRangeBonus ?? 0) - entry.range)
      }
      host.state.huaiyuanSource = {}
      if (totalMaxCards > 0) target.marks['huaiyuan-maxcards'] = (target.marks['huaiyuan-maxcards'] ?? 0) + totalMaxCards
      if (totalRange > 0) target.attackRangeBonus = (target.attackRangeBonus ?? 0) + totalRange
      host.state.huaiyuanSource = { [targetId]: { maxCards: totalMaxCards, range: totalRange } }
      host.dispatch('SkillActivated', { skillId: HUAIYUAN, skillName: '怀远', playerId: ownerId, targetId, logText: `${target.nickname}继承了羊祜的怀远加成` }, { sourceId: ownerId, targetId })
      return
    }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({
        skillId: HUAIYUAN, ownerId, step: 'option', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【怀远】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'maxcards', label: '手牌上限+1' },
            { id: 'range', label: '攻击范围+1' },
            { id: 'draw', label: '摸1张牌' },
          ],
        }),
      })
      return
    }
    if (resolution.step === 'option') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      host.dispatch('SkillActivated', { skillId: HUAIYUAN, skillName: '怀远', playerId: ownerId, targetId, logText: `${owner.nickname}发动【怀远】` }, { sourceId: ownerId, targetId })
      if (optionId === 'maxcards') {
        target.marks['huaiyuan-maxcards'] = (target.marks['huaiyuan-maxcards'] ?? 0) + 1
        host.state.huaiyuanSource ??= {}
        host.state.huaiyuanSource[targetId] = { ...(host.state.huaiyuanSource[targetId] ?? {}), maxCards: (host.state.huaiyuanSource[targetId]?.maxCards ?? 0) + 1 }
      } else if (optionId === 'range') {
        target.attackRangeBonus = (target.attackRangeBonus ?? 0) + 1
        host.state.huaiyuanSource ??= {}
        host.state.huaiyuanSource[targetId] = { ...(host.state.huaiyuanSource[targetId] ?? {}), range: (host.state.huaiyuanSource[targetId]?.range ?? 0) + 1 }
      } else if (optionId === 'draw') {
        drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
      }
    }
  },
})

function handleSuiLeave(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || cardIds.length === 0) return
  const leftSui = cardIds.filter((cardId) => (host.state.suiCardIds ?? []).includes(cardId))
  if (leftSui.length === 0) return
  host.state.suiCardIds = (host.state.suiCardIds ?? []).filter((id) => !leftSui.includes(id))
  const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
  if (candidateIds.length === 0) return
  for (let i = 0; i < leftSui.length; i += 1) {
    host.queueSkill({ skillId: HUAIYUAN, ownerId, step: 'pick', data: { candidateIds } })
  }
}

registerSkillRuntime({
  id: CHONGXIN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, CHONGXIN)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0 || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: CHONGXIN, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, CHONGXIN)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: CHONGXIN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【崇信】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0 || owner.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, CHONGXIN)
      host.dispatch('SkillActivated', { skillId: CHONGXIN, skillName: '崇信', playerId: ownerId, targetId, logText: `${owner.nickname}发动【崇信】` }, { sourceId: ownerId, targetId })
      const ownCard = owner.zones.hand[0]
      moveCard(host.state, ownCard, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [ownCard], reason: CHONGXIN }, { sourceId: ownerId, cardIds: [ownCard] })
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.askSkill({
        skillId: CHONGXIN, ownerId, step: 'target-recast', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【崇信】：重铸1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-recast') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CHONGXIN }, { sourceId: targetId, cardIds: [cardId] })
      drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
    }
  },
})

registerSkillRuntime({
  id: DEZHANG,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive) return false
      return !owner.zones.hand.some((cardId) => (state.suiCardIds ?? []).includes(cardId))
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, DEZHANG)
      if (!playerOf(host.state, ownerId)?.alive) return
      grantSkill(host.state, ownerId, WEISHU)
      host.dispatch('SkillActivated', { skillId: DEZHANG, skillName: '德彰', playerId: ownerId, logText: `${owner.nickname}发动【德彰】，觉醒获得【卫戍】` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: WEISHU,
  triggers: [
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
        if (payload.playerId !== ownerId || payload.reason !== 'draw' || host.state.phase === 'draw' || host.state.weishuDrawGuard) return
        const owner = playerOf(host.state, ownerId)
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        if (!owner?.alive || candidateIds.length === 0) return
        host.queueSkill({ skillId: WEISHU, ownerId, step: 'draw-target', data: { candidateIds } })
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
        if (payload.playerId !== ownerId || host.state.phase === 'discard' || payload.reason === WEISHU) return
        const owner = playerOf(host.state, ownerId)
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (!owner?.alive || candidateIds.length === 0) return
        host.queueSkill({ skillId: WEISHU, ownerId, step: 'discard-target', data: { candidateIds } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'draw-target') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: WEISHU, ownerId, step: 'draw-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【卫戍】：选择一名角色摸1张牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'discard-target') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: WEISHU, ownerId, step: 'discard-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【卫戍】：选择一名其他角色弃置其1张牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'draw-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.state.weishuDrawGuard = true
      drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
      host.state.weishuDrawGuard = false
      host.dispatch('SkillActivated', { skillId: WEISHU, skillName: '卫戍', playerId: ownerId, targetId, logText: `${owner.nickname}发动【卫戍】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'discard-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const cardId = target.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WEISHU }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: WEISHU, skillName: '卫戍', playerId: ownerId, targetId, logText: `${owner.nickname}发动【卫戍】` }, { sourceId: ownerId, targetId })
    }
  },
})

// ============================== 石苞 ==============================

const ZHUOSHENG = 'zhuosheng'
const ZHUOSHENG_SINGLE_TARGET_TRICKS = new Set(['决斗', '过河拆桥', '顺手牵羊', '火攻', '借刀杀人'])
const ZHUOSHENG_FIXED_TARGET_TRICKS = new Set(['南蛮入侵', '万箭齐发'])

registerSkillRuntime({
  id: ZHUOSHENG,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const payload = context.event.payload as { cardId?: CardId; virtual?: boolean; targetIds?: PlayerId[] }
      if (payload.virtual || !payload.cardId) return
      if ((host.state.zhuoshengObtained?.round === host.state.roundNumber ? host.state.zhuoshengObtained.ids : []).includes(payload.cardId)) return
      const card = host.state.cards[payload.cardId]
      if (!card) return
      if (card.category === 'basic') {
        host.state.zhuoshengBonus = { ownerId, cardId: payload.cardId }
        host.dispatch('SkillActivated', { skillId: ZHUOSHENG, skillName: '擢升', playerId: ownerId, logText: `${owner.nickname}发动【擢升】` }, { sourceId: ownerId })
      } else if (card.category === 'equipment') {
        host.dispatch('SkillActivated', { skillId: ZHUOSHENG, skillName: '擢升', playerId: ownerId, logText: `${owner.nickname}发动【擢升】` }, { sourceId: ownerId })
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        const gained = host.state.zones.drawPile[0]
        if (gained) host.state.zhuoshengObtained = { round: host.state.roundNumber, ids: [...(host.state.zhuoshengObtained?.round === host.state.roundNumber ? host.state.zhuoshengObtained.ids : []), gained] }
      } else if (card.category === 'trick') {
        // 普通锦囊的目标数±1已经在动作生成阶段（instantTrickActions）定好，这里只按目标数判断石苞是否真的选了修改过的那一档并补报"发动"
        const count = payload.targetIds?.length ?? 0
        const modified = ZHUOSHENG_SINGLE_TARGET_TRICKS.has(card.name)
          ? count > 1
          : ZHUOSHENG_FIXED_TARGET_TRICKS.has(card.name) && count < host.state.players.filter((p) => p.alive && p.id !== ownerId).length
        if (modified) host.dispatch('SkillActivated', { skillId: ZHUOSHENG, skillName: '擢升', playerId: ownerId, logText: `${owner.nickname}发动【擢升】` }, { sourceId: ownerId })
      }
    },
  }],
  modifiesTrickTargetCount() {
    return true
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    void targetId
    return state.zhuoshengBonus?.ownerId === ownerId
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    void targetId
    return state.zhuoshengBonus?.ownerId === ownerId
  },
})

// ============================== 文鸯 ==============================

const LVLI = 'lvli'
const CHOUJUE = 'choujue'
const BEISHUI = 'beishui'
const QINGJIAO = 'qingjiao'

registerSkillRuntime({
  id: LVLI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const beishui = host.state.beishuiActive === ownerId
      const relevant = context.event.sourceId === ownerId || (beishui && context.event.targetId === ownerId)
      if (!relevant) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const isOwnTurn = host.state.currentPlayerId === ownerId
      const cap = host.state.choujueAwakened && isOwnTurn ? 2 : 1
      const turnKey = host.state.turnNumber
      if (owner.marks['lvli-turn'] !== turnKey) { owner.marks['lvli-turn'] = turnKey; owner.marks['lvli-count'] = 0 }
      if ((owner.marks['lvli-count'] ?? 0) >= cap) return
      owner.marks['lvli-count'] = (owner.marks['lvli-count'] ?? 0) + 1
      host.queueSkill({ skillId: LVLI, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const options: Array<{ id: string; label: string }> = []
    if (owner.zones.hand.length < owner.hp) options.push({ id: 'draw', label: `将手牌摸至体力值（摸${owner.hp - owner.zones.hand.length}张）` })
    if (owner.hp < owner.zones.hand.length && owner.hp < owner.maxHp) options.push({ id: 'recover', label: '将体力回复至手牌数' })
    if (options.length === 0) return
    options.push({ id: 'no', label: '不发动' })
    host.askSkill({
      skillId: LVLI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【膂力】：请选择', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'draw' && owner.zones.hand.length < owner.hp) {
      host.dispatch('SkillActivated', { skillId: LVLI, skillName: '膂力', playerId: ownerId, logText: `${owner.nickname}发动【膂力】` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, owner.hp - owner.zones.hand.length, (n, p) => { host.dispatch(n, p) })
    } else if (optionId === 'recover' && owner.hp < owner.zones.hand.length && owner.hp < owner.maxHp) {
      const amount = Math.min(owner.zones.hand.length - owner.hp, owner.maxHp - owner.hp)
      if (amount > 0) {
        host.dispatch('SkillActivated', { skillId: LVLI, skillName: '膂力', playerId: ownerId, logText: `${owner.nickname}发动【膂力】` }, { sourceId: ownerId })
        recover(host as never, ownerId, amount, ownerId)
      }
    }
  },
})

registerSkillRuntime({
  id: CHOUJUE,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      if ((host.state.choujueAwakened)) return
      const payload = context.event.payload as { phase?: string }
      if (payload.phase !== 'finish') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (Math.abs(owner.zones.hand.length - owner.hp) < 3) return
      host.state.choujueAwakened = true
      loseMaxHp(host as never, ownerId, 1, CHOUJUE)
      if (!playerOf(host.state, ownerId)?.alive) return
      grantSkill(host.state, ownerId, BEISHUI)
      host.dispatch('SkillActivated', { skillId: CHOUJUE, skillName: '仇决', playerId: ownerId, logText: `${owner.nickname}发动【仇决】，觉醒获得【背水】` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: BEISHUI,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive) return false
      return owner.zones.hand.length < 2 || owner.hp < 2
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, BEISHUI)
      if (!playerOf(host.state, ownerId)?.alive) return
      grantSkill(host.state, ownerId, QINGJIAO)
      host.state.beishuiActive = ownerId
      host.dispatch('SkillActivated', { skillId: BEISHUI, skillName: '背水', playerId: ownerId, logText: `${owner.nickname}发动【背水】，觉醒获得【清剿】` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: QINGJIAO,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: QINGJIAO, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        if (host.state.qingjiaoActiveTurn !== host.state.turnNumber) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        const cardIds = [...owner.zones.hand]
        for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: QINGJIAO }, { sourceId: ownerId, cardIds })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: QINGJIAO, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【清剿】：是否弃置所有手牌，随机获得8张牌名各不相同的牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (owner.zones.hand.length > 0) {
      const cardIds = [...owner.zones.hand]
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: QINGJIAO }, { sourceId: ownerId, cardIds })
    }
    const pool = [...host.state.zones.drawPile, ...host.state.zones.discardPile]
    const seenNames = new Set<string>()
    const gained: CardId[] = []
    const shuffled = [...pool]
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = host.rng.nextInt(i + 1)
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    for (const cardId of shuffled) {
      if (gained.length >= 8) break
      const name = host.state.cards[cardId]?.name
      if (!name || seenNames.has(name)) continue
      seenNames.add(name)
      gained.push(cardId)
    }
    for (const cardId of gained) {
      const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
    }
    if (gained.length > 0) {
      host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: QINGJIAO }, { targetId: ownerId, cardIds: gained })
      host.state.qingjiaoActiveTurn = host.state.turnNumber
    }
    host.dispatch('SkillActivated', { skillId: QINGJIAO, skillName: '清剿', playerId: ownerId, logText: `${owner.nickname}发动【清剿】` }, { sourceId: ownerId })
  },
})

// ============================== 卫瓘 ==============================

const ZHONGYUN = 'zhongyun'
const SHENPIN = 'shenpin'

registerSkillRuntime({
  id: ZHONGYUN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId && context.event.sourceId !== ownerId) return
        if (context.event.targetId !== ownerId) return
        zhongyunHpCheck(host, ownerId)
      },
    },
    {
      event: 'Recover',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        zhongyunHpCheck(host, ownerId)
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        zhongyunHandCheck(host, ownerId)
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        zhongyunHandCheck(host, ownerId)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'hp-branch') {
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && attackRangeCovers(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
      host.askSkill({
        skillId: ZHONGYUN, ownerId, step: 'hp-branch', data: { candidateIds },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【忠允】：体力值等于手牌数，请选择', timeoutMs: 20_000, optional: true,
          options: [
            { id: 'recover', label: '回复1点体力' },
            ...(candidateIds.length > 0 ? [{ id: 'damage', label: '对攻击范围内一名角色造成1点伤害' }] : []),
          ],
        }),
      })
      return
    }
    if (prompt.step === 'hand-branch') {
      host.askSkill({
        skillId: ZHONGYUN, ownerId, step: 'hand-branch', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【忠允】：体力值等于手牌数，请选择', timeoutMs: 20_000, optional: true,
          options: [{ id: 'draw', label: '摸1张牌' }, { id: 'discard', label: '弃置一名其他角色1张牌' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'hp-branch') {
      const optionId = (response.payload as { optionId?: string }).optionId
      host.dispatch('SkillActivated', { skillId: ZHONGYUN, skillName: '忠允', playerId: ownerId, logText: `${owner.nickname}发动【忠允】` }, { sourceId: ownerId })
      if (optionId === 'recover') {
        if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
        return
      }
      if (optionId === 'damage') {
        const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
        host.askSkill({
          skillId: ZHONGYUN, ownerId, step: 'hp-damage-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【忠允】：选择攻击范围内一名角色', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
      }
      return
    }
    if (resolution.step === 'hp-damage-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      return
    }
    if (resolution.step === 'hand-branch') {
      const optionId = (response.payload as { optionId?: string }).optionId
      host.dispatch('SkillActivated', { skillId: ZHONGYUN, skillName: '忠允', playerId: ownerId, logText: `${owner.nickname}发动【忠允】` }, { sourceId: ownerId })
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        return
      }
      if (optionId === 'discard') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: ZHONGYUN, ownerId, step: 'hand-discard-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【忠允】：选择一名其他角色', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
      }
      return
    }
    if (resolution.step === 'hand-discard-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const cardId = target.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZHONGYUN }, { sourceId: ownerId, cardIds: [cardId] })
    }
  },
})

function zhongyunHpCheck(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || usedThisTurn(host.state, ownerId, `${ZHONGYUN}-hp`)) return
  if (owner.hp !== owner.zones.hand.length) return
  markUsedThisTurn(host.state, ownerId, `${ZHONGYUN}-hp`)
  host.queueSkill({ skillId: ZHONGYUN, ownerId, step: 'hp-branch', data: {} })
}
function zhongyunHandCheck(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || usedThisTurn(host.state, ownerId, `${ZHONGYUN}-hand`)) return
  if (owner.hp !== owner.zones.hand.length) return
  markUsedThisTurn(host.state, ownerId, `${ZHONGYUN}-hand`)
  host.queueSkill({ skillId: ZHONGYUN, ownerId, step: 'hand-branch', data: {} })
}

registerSkillRuntime({
  id: SHENPIN,
  retrial(state, ownerId, judgingPlayerId) {
    void judgingPlayerId
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const judgeCardId = state.retrial?.judgeCardId
    const judgeColor = judgeCardId ? state.cards[judgeCardId]?.color : null
    if (!judgeColor) return []
    // 官方文本只写"一张颜色不同的牌"，不限手牌——装备区的牌同样能拿来改判
    const equipped = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
    return [...owner.zones.hand, ...equipped].filter((cardId) => {
      const color = state.cards[cardId]?.color
      return color && color !== judgeColor
    })
  },
  triggers: [{
    // 改判真正换牌时引擎才派发 CardResponded（reason 改判），弃权不会走到这里
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
      if (payload.reason !== '改判' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      host.dispatch('SkillActivated', { skillId: SHENPIN, skillName: '神品', playerId: ownerId, logText: `${owner.nickname}发动【神品】` }, { sourceId: ownerId })
    },
  }],
})

// ============================== 杨艳 ==============================

const XIANWAN = 'xianwan'
const XUANBEI = 'xuanbei'

registerSkillRuntime({
  id: XIANWAN,
  // 未连环 → 连环，视为打出一张闪：复用鲁芝【卫境】开创的虚拟闪挂载点，
  // 由引擎在求闪 Request 里加一条 `virtual-dodge:${skillId}` 选项，
  // 不必自己拼 CardResponded/续接伤害链那一整套。
  virtualDodge(state, ownerId) {
    return !playerOf(state, ownerId)?.chained
  },
  consumeVirtualDodge(host, ownerId) {
    setChained(host, ownerId, XIANWAN, true)
    const owner = playerOf(host.state, ownerId)
    if (owner) host.dispatch('SkillActivated', { skillId: XIANWAN, skillName: '娴婉', playerId: ownerId, logText: `${owner.nickname}发动【娴婉】` }, { sourceId: ownerId })
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || !owner.chained) return []
    return [{ id: 'skill:xianwan-slash', label: '发动【娴婉】：解除连环，视为使用一张杀' }]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (actionId === 'skill:xianwan-slash' && owner.chained) {
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: XIANWAN, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【娴婉】：视为使用一张杀', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.chained) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    setChained(host, ownerId, XIANWAN, false)
    host.dispatch('SkillActivated', { skillId: XIANWAN, skillName: '娴婉', playerId: ownerId, targetId, logText: `${owner.nickname}发动【娴婉】` }, { sourceId: ownerId, targetId })
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: XIANWAN })
  },
})

registerSkillRuntime({
  id: XUANBEI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, XUANBEI)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: XUANBEI, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, XUANBEI)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: XUANBEI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【选备】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const pickable = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
      // 杨艳不能先看见点数花色再挑：手牌只给占位槽，复用顺手牵羊/过河拆桥同一套隐私纪律
      host.askSkill({
        skillId: XUANBEI, ownerId, step: 'pick-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【选备】：选择该角色区域内1张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (!cardId) return
      markUsedThisTurn(host.state, ownerId, XUANBEI)
      host.state.xuanbeiPending = { ownerId, targetId }
      host.dispatch('SkillActivated', { skillId: XUANBEI, skillName: '选备', playerId: ownerId, targetId, logText: `${owner.nickname}发动【选备】` }, { sourceId: ownerId, targetId })
      // beginVirtualSlash 的 cardId 载体要求有效牌名已经是"杀"；这里是"当杀
      // 使用"的转化，选中的实体牌按弃置处理，杀本身走纯虚拟杀
      movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XUANBEI }, { sourceId: targetId, cardIds: [cardId] })
      host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: XUANBEI, countUsage: false })
    }
  },
})

// ============================== 杨芷 ==============================

const MAIHUO = 'maihuo'
const WANYI = 'wanyi'
const HUO_PILE = 'huo'
const WANYI_PILE = 'wanyi-pile'

registerSkillRuntime({
  id: MAIHUO,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId) return
        const holderId = payload.playerId
        const holder = playerOf(host.state, holderId)
        const pile = holder?.characterPiles?.[HUO_PILE] ?? []
        if (!holder?.alive || pile.length === 0) return
        const cardId = pile[0]
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const legal = canUseSlash(host.state, holderId, false)
        if (legal) {
          // beginVirtualSlash 的 cardId 载体必须在使用者手牌里，先归还手牌再让它照常走一次真实杀的结算
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: holderId, pile: HUO_PILE }, { kind: 'hand', playerId: holderId })
          host.dispatch('SkillActivated', { skillId: MAIHUO, skillName: '埋祸', playerId: ownerId, targetId: holderId, logText: `${holder.nickname}被迫使用"祸"对${owner.nickname}发动一张杀` }, { sourceId: ownerId, targetId: holderId })
          host.beginVirtualSlash({ sourceId: holderId, targetId: ownerId, sourceSkillId: MAIHUO, cardId, countUsage: false })
        } else {
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: holderId, pile: HUO_PILE }, { kind: 'discardPile' })
        }
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const targetId = context.event.targetId
        if (!targetId) return
        const target = playerOf(host.state, targetId)
        const pile = target?.characterPiles?.[HUO_PILE] ?? []
        if (!target?.alive || pile.length === 0) return
        for (const cardId of [...pile]) moveCard(host.state, cardId, { kind: 'characterPile', playerId: targetId, pile: HUO_PILE }, { kind: 'discardPile' })
      },
    },
  ],
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    const usedCard = host.state.cards[context.cardId]
    // 扣为"祸"要求印着"杀"的实体牌：虚拟杀没有实体载体，转化杀（别名生效期已过）之后重新使用会不是"杀"
    if (!usedCard || usedCard.virtual || usedCard.name !== '杀') return false
    const source = playerOf(host.state, context.sourceId)
    const owner = playerOf(host.state, ownerId)
    if (!source?.alive || !owner?.alive) return false
    if ((source.characterPiles?.[HUO_PILE] ?? []).length > 0) return false
    host.askSkill({
      skillId: MAIHUO, ownerId, step: 'ask', data: { sourceId: context.sourceId, cardId: context.cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【埋祸】：是否令这张杀对你无效，并将其扣为"祸"？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { sourceId, cardId } = resolution.data as { sourceId: PlayerId; cardId: CardId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive) { host.resumeCardTarget(); return }
    if (!source?.alive || (response.payload as { optionId?: string }).optionId !== 'yes' || !host.state.zones.processingArea.includes(cardId)) {
      host.resumeCardTarget()
      return
    }
    const current = host.state.cardResolution
    if (current?.kind === 'slash') current.targetCancelled = true
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: sourceId, pile: HUO_PILE })
    host.dispatch('SkillActivated', { skillId: MAIHUO, skillName: '埋祸', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【埋祸】` }, { sourceId: ownerId, targetId: sourceId })
    host.resumeCardTarget()
  },
})

registerSkillRuntime({
  id: WANYI,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[]; virtual?: boolean; cardName?: string }
        if (payload.virtual || !payload.cardId || (payload.targetIds ?? []).length !== 1) return
        const card = host.state.cards[payload.cardId]
        if (!card || (card.name !== '杀' && card.category !== 'trick')) return
        if (DELAYED_TRICK_NAMES2.has(card.name)) return
        const [targetId] = payload.targetIds!
        if (targetId === ownerId) return
        host.queueSkill({ skillId: WANYI, ownerId, step: 'pick', data: { targetId } })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        releaseOneWanyi(host, ownerId)
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        releaseOneWanyi(host, ownerId)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const pool = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
      if (pool.length === 0) return
      host.askSkill({
        skillId: WANYI, ownerId, step: 'confirm', data: { targetId, cardId: pool[host.rng.nextInt(pool.length)] },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【婉嫕】：是否将该角色1张牌置于你的武将牌上？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'release') {
      const { candidates } = prompt.data as { candidates: PlayerId[] }
      host.askSkill({
        skillId: WANYI, ownerId, step: 'release', data: prompt.data,
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【婉嫕】：选择一名角色获得1张婉嫕牌', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'confirm') {
      const { targetId, cardId } = resolution.data as { targetId: PlayerId; cardId: CardId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const from = target.zones.hand.includes(cardId)
        ? { kind: 'hand' as const, playerId: targetId }
        : target.zones.judgingArea.includes(cardId)
          ? { kind: 'judgingArea' as const, playerId: targetId }
          : { kind: 'equipment' as const, playerId: targetId, slot: (Object.entries(target.zones.equipment).find(([, id]) => id === cardId)?.[0] as never) }
      moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: WANYI_PILE })
      host.dispatch('SkillActivated', { skillId: WANYI, skillName: '婉嫕', playerId: ownerId, targetId, logText: `${owner.nickname}发动【婉嫕】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'release') {
      const { pile } = resolution.data as { pile: CardId[] }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const cardId = pile[0]
      if (!target?.alive || !cardId || !owner.characterPiles?.[WANYI_PILE]?.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: WANYI_PILE }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: WANYI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
  },
  // 婉嫕牌压着哪些花色，杨芷就不能使用/打出/弃置那些花色的牌
  locksOwnSuits(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const pile = owner?.characterPiles?.[WANYI_PILE] ?? []
    return [...new Set(pile.map((cardId) => state.cards[cardId]?.suit).filter((suit): suit is Suit => Boolean(suit)))]
  },
})

const DELAYED_TRICK_NAMES2 = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

function releaseOneWanyi(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const pile = owner?.characterPiles?.[WANYI_PILE] ?? []
  if (!owner?.alive || pile.length === 0) return
  const candidates = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
  if (candidates.length === 0) return
  host.queueSkill({ skillId: WANYI, ownerId, step: 'release', data: { candidates, pile: [pile[0]] } })
}

// ============================== 王濬 ==============================

const CHANGQU = 'changqu'
const TONGYE = 'tongye'

registerSkillRuntime({
  id: CHANGQU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, CHANGQU)) return
      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
      if (others.length === 0) return
      host.queueSkill({ skillId: CHANGQU, ownerId, step: 'ask-direction', data: {} })
    },
  }, {
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      void ownerId
      const bonus = host.state.changquElementalBonus
      if (!bonus || context.event.targetId !== bonus.targetId) return
      const payload = context.event.payload as { amount?: number; nature?: string }
      if (payload.nature !== 'fire' && payload.nature !== 'thunder' && payload.nature !== 'ice') return
      host.state.changquElementalBonus = undefined
      payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + bonus.amount
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, CHANGQU)) return
    if (prompt.step === 'ask-direction') {
      host.askSkill({
        skillId: CHANGQU, ownerId, step: 'ask-direction', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【长驱】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'up', label: '从上家方向连续座次展开' }, { id: 'down', label: '从下家方向连续座次展开' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'holder') {
      const chain = host.state.changquChain
      if (!chain || chain.ownerId !== ownerId) return
      const holderId = chain.order[chain.index]
      const holder = playerOf(host.state, holderId)
      if (!holder?.alive) { advanceChangqu(host, ownerId); return }
      const x = Math.max(1, chain.option1Count)
      const canGive = holder.zones.hand.length >= x
      host.askSkill({
        skillId: CHANGQU, ownerId, step: 'holder', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: holderId,
          prompt: '【长驱】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            ...(canGive ? [{ id: 'give', label: `交给王濬${x}张手牌，战舰移交下一名角色` }] : []),
            { id: 'damage', label: `下一次受到属性伤害+${x}并进入连环` },
          ],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask-direction') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'up' && optionId !== 'down') return
      markUsedThisTurn(host.state, ownerId, CHANGQU)
      const alive = host.state.players.filter((candidate) => candidate.alive)
      const startIndex = alive.findIndex((candidate) => candidate.id === ownerId)
      const order: PlayerId[] = []
      for (let offset = 1; offset < alive.length; offset += 1) {
        const index = optionId === 'up' ? (startIndex - offset + alive.length) % alive.length : (startIndex + offset) % alive.length
        order.push(alive[index].id)
      }
      host.dispatch('SkillActivated', { skillId: CHANGQU, skillName: '长驱', playerId: ownerId, logText: `${owner.nickname}发动【长驱】` }, { sourceId: ownerId })
      host.state.changquChain = { ownerId, order, index: 0, option1Count: 0 }
      host.queueSkill({ skillId: CHANGQU, ownerId, step: 'holder', data: {} })
      return
    }
    if (resolution.step === 'holder') {
      const chain = host.state.changquChain
      if (!chain || chain.ownerId !== ownerId) return
      const holderId = chain.order[chain.index]
      const holder = playerOf(host.state, holderId)
      if (!holder?.alive) { advanceChangqu(host, ownerId); return }
      const x = Math.max(1, chain.option1Count)
      const canGive = holder.zones.hand.length >= x
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'give' && canGive) {
        chain.option1Count += 1
        const cardIds = holder.zones.hand.slice(0, x)
        for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: holderId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: holderId, cardIds, reason: CHANGQU }, { sourceId: holderId, cardIds })
        host.dispatch('GainCard', { playerId: ownerId, cardIds, reason: CHANGQU }, { sourceId: holderId, targetId: ownerId, cardIds })
        advanceChangqu(host, ownerId)
        return
      }
      host.state.changquElementalBonus = { targetId: holderId, amount: x }
      setChained(host, holderId, CHANGQU, true)
      host.dispatch('SkillActivated', { skillId: CHANGQU, skillName: '长驱', playerId: ownerId, targetId: holderId, logText: `${holder.nickname}受到下一次属性伤害+${x}` }, { sourceId: ownerId, targetId: holderId })
    }
  },
})

function advanceChangqu(host: SkillHost, ownerId: PlayerId): void {
  const chain = host.state.changquChain
  if (!chain || chain.ownerId !== ownerId) return
  chain.index += 1
  if (chain.index >= chain.order.length) { host.state.changquChain = undefined; return }
  const holderId = chain.order[chain.index]
  const holder = playerOf(host.state, holderId)
  if (!holder?.alive) { advanceChangqu(host, ownerId); return }
  host.queueSkill({ skillId: CHANGQU, ownerId, step: 'holder', data: {} })
}

registerSkillRuntime({
  id: TONGYE,
  onGameStart(host, ownerId) {
    tongyeRecompute(host, ownerId)
  },
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      void context
      tongyeRecompute(host, ownerId)
    },
  }, {
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      if (payload.playerId !== ownerId) return
      const bonus = host.state.tongyeDrawBonus
      if (bonus?.ownerId !== ownerId) return
      host.state.tongyeDrawBonus = undefined
      payload.count = (typeof payload.count === 'number' ? payload.count : 2) + 1
    },
  }],
  maxCardsBonus(state, ownerId) {
    return state.tongyeState?.ownerId === ownerId ? state.tongyeState.maxCards : 0
  },
  globalSlashUses(state, ownerId, targetId) {
    if (targetId !== ownerId || state.tongyeState?.ownerId !== ownerId) return 0
    return state.tongyeState.slash
  },
})

function livingKingdomCount(state: SanguoshaState): number {
  return new Set(state.players.filter((candidate) => candidate.alive).map((candidate) => effectiveKingdomOf(state, candidate.id))).size
}

function tongyeRecompute(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const k = livingKingdomCount(host.state)
  const prev = host.state.tongyeState ?? { ownerId, maxCards: 0, range: 0, slash: 0 }
  owner.attackRangeBonus = Math.max(0, (owner.attackRangeBonus ?? 0) - prev.range)
  const maxCards = k <= 4 ? 3 : 0
  const range = k <= 3 ? 3 : 0
  const slash = k <= 2 ? 3 : 0
  owner.attackRangeBonus = (owner.attackRangeBonus ?? 0) + range
  const qualifying = [maxCards > 0, range > 0, slash > 0].filter(Boolean).length
  host.state.tongyeState = { ownerId, maxCards, range, slash }
  host.dispatch('SkillActivated', { skillId: TONGYE, skillName: '统业', playerId: ownerId, logText: `${owner.nickname}发动【统业】（当前势力数：${k}）` }, { sourceId: ownerId })
  if (qualifying > 1) host.state.tongyeDrawBonus = { ownerId, turnNumber: host.state.turnNumber === 0 ? -1 : host.state.turnNumber }
  if (k === 1 && owner.hp < owner.maxHp) recover(host as never, ownerId, Math.min(3, owner.maxHp - owner.hp), ownerId)
}

// ============================== 司马孚 ==============================

const BEIYU = 'beiyu'
const DUCHI = 'duchi'

registerSkillRuntime({
  id: BEIYU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, BEIYU)) return
      host.queueSkill({ skillId: BEIYU, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, BEIYU)) return
    host.askSkill({
      skillId: BEIYU, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【备预】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      markUsedThisTurn(host.state, ownerId, BEIYU)
      if (owner.zones.hand.length < owner.hp) drawCards(host.state, host.rng, ownerId, owner.hp - owner.zones.hand.length, (n, p) => { host.dispatch(n, p) })
      const suits = [...new Set(owner.zones.hand.map((cardId) => host.state.cards[cardId]?.suit).filter((suit): suit is Suit => Boolean(suit)))]
      if (suits.length === 0) { host.dispatch('SkillActivated', { skillId: BEIYU, skillName: '备预', playerId: ownerId, logText: `${owner.nickname}发动【备预】` }, { sourceId: ownerId }); return }
      host.askSkill({
        skillId: BEIYU, ownerId, step: 'pick-suit', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【备预】：选择一种花色，将该花色所有手牌置于牌堆底', timeoutMs: 20_000, optional: false,
          options: suits.map((suit) => ({ id: suit, label: SUIT_NAMES[suit] })),
        }),
      })
      return
    }
    if (resolution.step === 'pick-suit') {
      const suit = (response.payload as { optionId?: string }).optionId as Suit | undefined
      if (!suit) return
      const cardIds = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === suit)
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
      if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: BEIYU }, { sourceId: ownerId, cardIds })
      host.dispatch('SkillActivated', { skillId: BEIYU, skillName: '备预', playerId: ownerId, logText: `${owner.nickname}发动【备预】` }, { sourceId: ownerId })
    }
  },
})

const SUIT_NAMES: Record<Suit, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }

registerSkillRuntime({
  id: DUCHI,
  // 督持没有真正的互动询问（摸牌、展示、判定颜色都是确定性效果），
  // 全程同步完成并直接 return false——按 interceptTarget 的约定，
  // 没有真正发问就不能 return true / 调用 resumeCardTarget。
  interceptTarget(host, ownerId, context) {
    if (context.sourceId === ownerId || usedThisTurn(host.state, ownerId, DUCHI)) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    markUsedThisTurn(host.state, ownerId, DUCHI)
    if (host.state.zones.drawPile.length > 0) {
      const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DUCHI }, { targetId: ownerId, cardIds: [cardId] })
    }
    host.dispatch('SkillActivated', { skillId: DUCHI, skillName: '督持', playerId: ownerId, logText: `${owner.nickname}发动【督持】` }, { sourceId: ownerId })
    if (owner.zones.hand.length > 0) host.dispatch('CardMove', { cardIds: [...owner.zones.hand], reason: DUCHI, revealed: true }, { sourceId: ownerId })
    const colors = new Set(owner.zones.hand.map((cardId) => host.state.cards[cardId]?.color).filter(Boolean))
    if (colors.size === 1) {
      const current = host.state.cardResolution
      if (current?.kind === 'slash' && current.targetId === ownerId) current.targetCancelled = true
    }
    return false
  },
})

export const JIN2_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'jin_simayi', name: '晋司马懿', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: BUCHEN, name: '不臣', description: '游戏开始后第一次进入其他角色回合时，可以获得当前回合角色1张牌（身份局兼容版）。' },
      { id: YINGSHI, name: '鹰视', description: '锁定技，出牌阶段期间，牌堆顶体力上限张牌始终对你可见。' },
      { id: XIONGZHI, name: '雄志', description: '限定技，出牌阶段，观看牌堆顶的牌，可以连续使用当前合法的牌，直到你选择停止或没有合法牌可用；杀仍受使用次数限制。' },
      { id: QUANBIAN, name: '权变', description: '出牌阶段，本阶段第一次使用/打出某花色手牌后（每种花色限一次），观看牌堆顶体力上限张牌并获得其中1张与该花色不同的牌，其余牌保持原顺序放回牌堆顶；你每回合最多使用体力上限张非装备手牌。' },
    ],
  },
  {
    id: 'jin_zhangchunhua', name: '晋张春华', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: HUISHI, name: '慧识', description: '摸牌阶段，你可以改为观看牌堆顶X张牌（X为当前牌堆剩余牌数的个位数）并获得其中floor(X/2)张，其余置于牌堆底。' },
      { id: QINGLENG, name: '清冷', description: '结束阶段，X为当前牌堆牌数个位数，若某角色体力值与手牌数之和不小于X，你可以将1张牌当无距离限制的冰属性杀对其使用；本局对每名角色第一次发动清冷时摸1张。' },
      { id: XUANMU, name: '宣穆', description: '游戏开始后第一次进入其他角色回合时，本回合防止你受到的所有伤害（身份局兼容版）。' },
    ],
  },
  {
    id: 'yanghu', name: '羊祜', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: HUAIYUAN, name: '怀远', description: '你初始的手牌均标记为"绥"；每失去一张仍标记为"绥"的牌，你选择一名角色令其手牌上限+1/攻击范围+1/摸1张牌之一。' },
      { id: CHONGXIN, name: '崇信', description: '出牌阶段限一次，选择一名有手牌的其他角色，你与其各重铸1张牌。' },
      { id: DEZHANG, name: '德彰', description: '觉醒技，准备阶段，若你没有任何仍标记为"绥"的牌，失去1点体力上限，获得【卫戍】。' },
      { id: WEISHU, name: '卫戍', description: '锁定技，你于摸牌阶段外摸牌后，令一名角色摸1张牌；你于弃牌阶段外弃牌后，弃置一名其他角色1张牌。' },
    ],
  },
  {
    id: 'shibao', name: '石苞', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: ZHUOSHENG, name: '擢升', description: '出牌阶段，你使用本轮未因擢升获得的牌时：基本牌无距离和次数限制；普通锦囊可以额外或减少一个目标；装备牌摸1张牌。' },
    ],
  },
  {
    id: 'wenyang', name: '文鸯', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: LVLI, name: '膂力', description: '每回合限一次（你的回合内在仇决后改为限两次），你造成伤害后（背水后改为造成或受到伤害后），可以将手牌摸至体力值或将体力回复至手牌数。' },
      { id: CHOUJUE, name: '仇决', description: '觉醒技，一名角色的回合结束时，若你的手牌数与体力值的差值至少为3，你减1点体力上限，获得【背水】，然后膂力于你的回合内改为限两次。' },
      { id: BEISHUI, name: '背水', description: '觉醒技，准备阶段，若你的手牌数或体力值小于2，你减1点体力上限，获得【清剿】，然后膂力"造成伤害后"改为"造成或受到伤害后"。' },
    ],
  },
  {
    id: 'weiguan', name: '卫瓘', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: ZHONGYUN, name: '忠允', description: '每回合各限一次：你受到伤害或回复体力后，若体力值等于手牌数，你可以回复1点体力或对攻击范围内一名角色造成1点伤害；你获得或失去手牌后，若体力值等于手牌数，你可以摸1张牌或弃置一名其他角色1张牌。' },
      { id: SHENPIN, name: '神品', description: '任意角色的判定牌生效前，你可以用1张颜色与之不同的牌进行改判。' },
    ],
  },
  {
    id: 'yangyan', name: '杨艳', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: XIANWAN, name: '娴婉', description: '你可以进入连环状态视为使用一张闪；你可以解除连环状态视为使用一张杀。' },
      { id: XUANBEI, name: '选备', description: '出牌阶段限一次，选择一名其他角色区域内1张牌，令其当无距离限制的杀对你使用；未造成伤害你摸1张，造成伤害则摸2张。' },
    ],
  },
  {
    id: 'yangzhi', name: '杨芷', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: MAIHUO, name: '埋祸', description: '其他角色使用的实体杀指定你为唯一目标后，若其没有"祸"，你可以令这张杀无效并将其扣为"祸"；其下个出牌阶段开始须尝试用"祸"对你使用杀，不合法则移去；你对其造成伤害后移去其"祸"。' },
      { id: WANYI, name: '婉嫕', description: '你使用杀或普通锦囊指定唯一其他角色为目标后，可以将其1张牌置于你的武将牌上，称为"婉嫕牌"；你不能使用/打出/弃置武将牌上存在婉嫕牌的花色的牌；结束阶段或你受到伤害后，交给一名角色1张婉嫕牌。' },
    ],
  },
  {
    id: 'wangjun', name: '王濬', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: CHANGQU, name: '长驱', description: '出牌阶段限一次，从上家或下家方向选择一组连续座次的其他角色，第一名获得"战舰"；持有战舰者选择交给你X张牌（战舰移交下一人）或下次受到的属性伤害+X并进入连环（X为此前选择交牌的次数，最小为1）。' },
      { id: TONGYE, name: '统业', description: '锁定技，游戏开始或任意角色死亡后，根据存活势力数动态获得手牌上限/攻击范围/杀次数+3（分别当势力数不大于4/3/2时成立）；势力数为1时回复3点体力；同时满足超过1项时下个摸牌阶段+1。' },
    ],
  },
  {
    id: 'simafu', name: '司马孚', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: BEIYU, name: '备预', description: '出牌阶段限一次，将手牌摸至体力值，然后选择一种花色，将该花色的所有手牌置于牌堆底。' },
      { id: DUCHI, name: '督持', description: '每回合限一次，你成为其他角色使用牌的目标后，从牌堆底摸1张牌，然后展示所有手牌，若颜色均相同，这张牌对你无效。' },
    ],
  },
]

