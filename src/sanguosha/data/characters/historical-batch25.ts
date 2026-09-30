import { drawCards, revealTopCards } from '../../engine/draw'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { resolvePickedCard } from '../../engine/card-pick'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { registerPindianContinuation, startPindian } from '../../engine/pindian'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { MultiCardViewAsSpec } from '../../engine/multi-card-viewas'
import { effectiveGenderOf } from '../../engine/huashen'
import { getAttackRange, getDistance } from '../../engine/distance'
import { executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import type { ArrangeOptionsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/** 历史人物第二十五批。保留实体牌 ID 与公开/隐藏信息边界，资源稍后接入。 */
type Batch25State = SanguoshaState & {
  liuyaoKannan?: Record<PlayerId, { targets: PlayerId[]; used: number; disabled: boolean }>
  liuyaoNextSlash?: Record<PlayerId, boolean>
  buzhiDingpan?: Record<PlayerId, number>
  zhanggongXin?: CardId[]
  zhanggongPending?: { ownerId: PlayerId; playerIds: PlayerId[]; index: number; cards: CardId[] }
  wangcanSanwen?: { ownerId: PlayerId; gained: CardId[] }
  simalangJunbing?: { ownerId: PlayerId; targetId: PlayerId; returned: number }
  hucheerFirstWeapon?: Record<PlayerId, boolean>
  hucheerSlashLock?: Record<PlayerId, number>
  lisuZhu?: Record<PlayerId, number>
  lisuJudgment?: Record<PlayerId, { cardId: CardId; rank: number }>
  yinfurenEndEnabled?: Record<PlayerId, boolean>
  yinfurenPairs?: Record<PlayerId, { targetId: PlayerId; maxBonus: number; damageReduction: boolean }[]>
  yanfurenDuel?: Record<PlayerId, { sourceId: PlayerId; cardId: CardId; count: number; targetId?: PlayerId }>
  wangcanDenglou?: Record<PlayerId, { cards: CardId[]; index: number }>
}

function playerOf(state: SanguoshaState, id: PlayerId) { return state.players.find((player) => player.id === id) }
function others(state: SanguoshaState, id: PlayerId) { return state.players.filter((player) => player.alive && player.id !== id) }
function equipmentIds(state: SanguoshaState, id: PlayerId): CardId[] {
  const player = playerOf(state, id)
  return player ? Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)) : []
}
function discardOwned(host: SkillHost, playerId: PlayerId, cardIds: CardId[], reason: string): CardId[] {
  const moved: CardId[] = []
  for (const cardId of cardIds) {
    const from = locateOwnedCard(host.state, playerId, cardId)
    if (!from) continue
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    moved.push(cardId)
  }
  if (moved.length) host.dispatch('LoseCard', { playerId, cardIds: moved, reason }, { sourceId: playerId, cardIds: moved })
  return moved
}
function gainFrom(host: SkillHost, cardIds: CardId[], from: { playerId: PlayerId; cardIds: CardId[] }, toId: PlayerId, reason: string): void {
  const moved: CardId[] = []
  for (const cardId of cardIds) {
    const zone = locateOwnedCard(host.state, from.playerId, cardId)
    if (!zone) continue
    moveCard(host.state, cardId, zone, { kind: 'hand', playerId: toId })
    moved.push(cardId)
  }
  if (moved.length) host.dispatch('GainCard', { playerId: toId, cardIds: moved, reason }, { sourceId: from.playerId, targetId: toId, cardIds: moved })
}

const KANNAN = 'kannan'
registerSkillRuntime({
  id: KANNAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    const record = (state as Batch25State).liuyaoKannan?.[ownerId]
    if (!owner || !record || record.disabled || record.used >= owner.hp) return []
    const candidates = others(state, ownerId).filter((player) => !record.targets.includes(player.id) && player.zones.hand.length > 0)
    return candidates.length ? [{ id: KANNAN, label: '戡难：与一名有手牌的角色拼点' }] : []
  },
  onGameStart(host, ownerId) { (host.state as Batch25State).liuyaoKannan ??= {}; (host.state as Batch25State).liuyaoKannan![ownerId] = { targets: [], used: 0, disabled: false } },
  outgoingDamage(state, ownerId, context) {
    if (context.cardName !== '杀' || !(state as Batch25State).liuyaoNextSlash?.[ownerId]) return null
    delete (state as Batch25State).liuyaoNextSlash?.[ownerId]
    return { amount: context.amount + 1 }
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase === 'play' && payload.playerId === ownerId) {
        const state = host.state as Batch25State
        state.liuyaoKannan ??= {}
        state.liuyaoKannan[ownerId] = { targets: [], used: 0, disabled: false }
      }
    },
  }],
  invokeActive(host, ownerId, actionId) {
    if (actionId !== KANNAN) return
    const state = host.state as Batch25State
    const record = state.liuyaoKannan?.[ownerId]
    if (!record) return
    const owner = playerOf(host.state, ownerId)
    const candidates = others(host.state, ownerId).filter((player) => !record.targets.includes(player.id) && player.zones.hand.length > 0)
    if (!owner || !candidates.length || record.used >= owner.hp) return
    host.askSkill({ skillId: KANNAN, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【戡难】：选择一名有手牌的角色拼点', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    const state = host.state as Batch25State
    const record = state.liuyaoKannan?.[ownerId]
    if (!target?.alive || !owner?.alive || !record || !target.zones.hand.length || record.used >= owner.hp) return
    record.targets.push(target.id)
    record.used += 1
    startPindian(host as never, { id: `kannan-${host.state.seq}`, initiatorId: ownerId, opponentId: target.id, reason: KANNAN, continuationTag: KANNAN, data: {} })
  },
})

const DAOJI = 'daoji'
const FUZHONG = 'fuzhong'
registerSkillRuntime({
  id: FUZHONG,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || host.state.currentPlayerId === ownerId || !(payload.cardIds?.length)) return
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.fuzhong = (owner.marks.fuzhong ?? 0) + 1
    },
  }, {
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      if (context.event.payload.playerId !== ownerId) return
      const count = playerOf(host.state, ownerId)?.marks.fuzhong ?? 0
      if (count > 0) (context.event.payload as { count?: number }).count = 2 + 1
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const owner = playerOf(host.state, ownerId)
      if (payload.phase !== 'finish' || payload.playerId !== ownerId || !owner || (owner.marks.fuzhong ?? 0) < 4) return
      host.queueSkill({ skillId: FUZHONG, ownerId, step: 'target', data: {} })
    },
  }],
  distanceModifier: { toOthers: (state, ownerId) => (playerOf(state, ownerId)?.marks.fuzhong ?? 0) >= 2 ? -2 : 0 },
  maxCardsBonus(state, ownerId) { return (playerOf(state, ownerId)?.marks.fuzhong ?? 0) >= 3 ? 3 : 0 },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = others(host.state, ownerId)
    if (!candidates.length) return
    host.askSkill({ skillId: FUZHONG, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【负重】：选择一名角色造成1点伤害并移去4枚“重”', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = playerOf(host.state, ownerId)
    if (!targetId || !owner || (owner.marks.fuzhong ?? 0) < 4) return
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
    owner.marks.fuzhong -= 4
  },
})
registerSkillRuntime({
  id: DAOJI,
  triggers: [{
    event: 'BeforeCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId || host.state.cards[payload.cardId ?? '']?.equipmentSlot !== 'weapon') return
      const state = host.state as Batch25State
      state.hucheerFirstWeapon ??= {}
      if (state.hucheerFirstWeapon[sourceId]) return
      state.hucheerFirstWeapon[sourceId] = true
      const cardId = payload.cardId
      if (!cardId || !host.state.zones.processingArea.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      context.cancel()
      host.askSkill({ skillId: DAOJI, ownerId, step: 'choice', data: { sourceId, cardId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【盗戟】：选择获得该武器，或令其本回合不能使用/打出【杀】', timeoutMs: 20_000, optional: false, options: [{ id: 'steal', label: '获得武器牌' }, { id: 'block', label: '其本回合不能使用或打出【杀】' }] }) })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId) { const state = host.state as Batch25State; if (state.hucheerSlashLock?.[ownerId] === host.state.turnNumber) delete state.hucheerSlashLock[ownerId] },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    const data = resolution.data as { sourceId: PlayerId; cardId?: CardId }
    const optionId = (response.payload as { optionId?: string }).optionId
    const cardId = data.cardId
    if (!cardId || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId)) return
    if (optionId === 'steal') {
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DAOJI }, { targetId: ownerId, cardIds: [cardId] })
    } else if (optionId === 'block') {
      const state = host.state as Batch25State
      state.hucheerSlashLock ??= {}
      state.hucheerSlashLock[data.sourceId] = host.state.turnNumber
      discardOwned(host, ownerId, [cardId], DAOJI)
    }
  },
  interceptPlayAction(host, ownerId, action) {
    const state = host.state as Batch25State
    if (action.playerId === ownerId && state.hucheerSlashLock?.[ownerId] === host.state.turnNumber && action.asCardName === '杀') return true
    return false
  },
})

const LIXUN = 'lixun'
const KUIZHU = 'kuizhu_lisu'
const LIXUN_JUDGMENT = 'lixun-judgment'
registerSkillRuntime({
  id: LIXUN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase === 'prepare' && payload.playerId === ownerId) performJudgment(host as never, ownerId, '利熏', { tag: LIXUN_JUDGMENT, data: { ownerId } })
    },
  }],
  interceptIncomingDamage(host, ownerId, context) {
    if (context.amount <= 0) return false
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks.lisuZhu = (owner.marks.lisuZhu ?? 0) + context.amount
    return true
  },
})
registerJudgmentContinuation(LIXUN_JUDGMENT, (host, judged, data) => {
  const ownerId = (data as { ownerId: PlayerId }).ownerId
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const zhu = owner.marks.lisuZhu ?? 0
  if (judged.rank < zhu) {
    const hand = [...owner.zones.hand]
    const discarded = discardOwned(host as never, ownerId, hand.slice(0, zhu), LIXUN)
    if (discarded.length < zhu) loseHp(host as never, ownerId, zhu - discarded.length, LIXUN)
  }
})
registerSkillRuntime({
  id: KUIZHU,
  activeActions(state, ownerId) {
    if (state.phase !== 'finish' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, KUIZHU)) return []
    const zhu = playerOf(state, ownerId)?.marks.lisuZhu ?? 0
    return others(state, ownerId).some((player) => player.hp === Math.max(...state.players.filter((p) => p.alive).map((p) => p.hp))) ? [{ id: KUIZHU, label: `馈珠：选择体力最高角色（珠${zhu}）` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== KUIZHU) return
    markUsedThisPhase(host.state, ownerId, KUIZHU)
    const maxHp = Math.max(...host.state.players.filter((player) => player.alive).map((player) => player.hp))
    const candidates = others(host.state, ownerId).filter((player) => player.hp === maxHp)
    host.askSkill({ skillId: KUIZHU, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【馈珠】：选择体力最高的角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!target || !owner) return
      drawCards(host.state, host.rng, ownerId, Math.max(0, Math.min(5, target.zones.hand.length) - owner.zones.hand.length), (name, data) => host.dispatch(name, data))
      host.askSkill({ skillId: KUIZHU, ownerId, step: 'discard', data: { targetId: target.id }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: target.id, prompt: '【馈珠】：可弃置任意张手牌', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: target.zones.hand.length }) })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const discarded = discardOwned(host, targetId, ids, KUIZHU)
      if (!discarded.length) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.zones.hand.length) return
      const count = Math.min(discarded.length, owner.zones.hand.length)
      host.askSkill({ skillId: KUIZHU, ownerId, step: 'take', data: { targetId, count }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【馈珠】：从李肃手牌中选择等量牌获得', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: count, max: count }) })
      return
    }
    if (resolution.step === 'take') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      gainFrom(host, ids, { playerId: ownerId, cardIds: ids }, targetId, KUIZHU)
      if (ids.length > 1) host.askSkill({ skillId: KUIZHU, ownerId, step: 'bonus', data: { targetId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【馈珠】：选择后续效果', timeoutMs: 20_000, optional: false, options: [...((playerOf(host.state, ownerId)?.marks.lisuZhu ?? 0) > 0 ? [{ id: 'remove', label: '移去一枚“珠”' }] : []), { id: 'damage', label: '令其对攻击范围内角色造成1点伤害' }] }) })
      return
    }
    if (resolution.step === 'bonus') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'remove') {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.lisuZhu = Math.max(0, (owner.marks.lisuZhu ?? 0) - 1)
      } else if (optionId === 'damage') {
        const targetId = (resolution.data as { targetId: PlayerId }).targetId
        const range = getAttackRange(host.state, targetId)
        const candidates = others(host.state, targetId).filter((player) => getDistance(host.state, targetId, player.id) <= range)
        if (candidates.length) host.askSkill({ skillId: KUIZHU, ownerId, step: 'bonus-target', data: { targetId }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: targetId, prompt: '【馈珠】：选择攻击范围内角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
      }
      return
    }
    if (resolution.step === 'bonus-target') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const victimId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (victimId) resolveDamage(host as never, { sourceId: targetId, targetId: victimId, amount: 1, nature: 'normal', cardName: null })
    }
  },
})

const SHUSHEN = 'shushen'
const SHENZHI = 'shenzhi'
registerSkillRuntime({
  id: SHUSHEN,
  triggers: [{
    event: 'Recover',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const amount = Math.max(1, Math.trunc(Number((context.event.payload as { amount?: number }).amount ?? 1)))
      host.queueSkill({ skillId: SHUSHEN, ownerId, step: 'target', data: { remaining: amount } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const remaining = (prompt.data as { remaining: number }).remaining
    if (remaining <= 0) return
    const ids = others(host.state, ownerId).map((player) => player.id)
    if (!ids.length) return
    host.askSkill({ skillId: SHUSHEN, ownerId, step: 'target', data: { remaining }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【淑慎】：令一名其他角色摸一张牌', timeoutMs: 20_000, optional: true, candidateIds: ids, min: 0, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId) drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
    const remaining = (resolution.data as { remaining: number }).remaining - 1
    if (remaining > 0) host.queueSkill({ skillId: SHUSHEN, ownerId, step: 'target', data: { remaining } })
  },
})
registerSkillRuntime({
  id: SHENZHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase === 'prepare' && payload.playerId === ownerId && playerOf(host.state, ownerId)?.alive) host.queueSkill({ skillId: SHENZHI, ownerId, step: 'discard', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    host.askSkill({ skillId: SHENZHI, ownerId, step: 'discard', data: {}, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【神智】：弃置所有手牌，若数量不少于当前体力则回复1点', timeoutMs: 20_000, optional: owner.zones.hand.length === 0, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: owner.zones.hand.length, max: owner.zones.hand.length }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner || ids.length !== owner.zones.hand.length) return
    const count = discardOwned(host, ownerId, ids, SHENZHI).length
    if (count >= owner.hp) recover(host as never, ownerId, 1, ownerId)
  },
})

const YINGYU = 'yingyu'
const YONGBI = 'yongbi'
registerSkillRuntime({
  id: YINGYU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const state = host.state as Batch25State
      if ((payload.phase === 'prepare' || payload.phase === 'finish' && state.yinfurenEndEnabled?.[ownerId]) && payload.playerId === ownerId) host.queueSkill({ skillId: YINGYU, ownerId, step: 'targets', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'targets') return
    const candidates = host.state.players.filter((player) => player.alive && player.zones.hand.length > 0)
    if (candidates.length < 2) return
    host.askSkill({ skillId: YINGYU, ownerId, step: 'targets', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【媵予】：选择两名各有手牌的角色', timeoutMs: 20_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 2, max: 2 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (ids.length !== 2) return
      for (const id of ids) {
        const target = playerOf(host.state, id)
        if (!target?.zones.hand.length) return
      }
      host.askSkill({ skillId: YINGYU, ownerId, step: 'card-a', data: { ids }, build: (requestId): ChooseCardsRequest => { const id = ids[0]; const target = playerOf(host.state, id)!; return { id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【媵予】：选择第一名角色展示的一张手牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: target.zones.hand.map((_, index) => `hidden:${id}:${index}`), min: 1, max: 1 } } })
      return
    }
    if (resolution.step === 'card-a' || resolution.step === 'card-b') {
      const ids = (resolution.data as { ids: PlayerId[]; cardA?: CardId }).ids
      const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const actual = picked ? resolvePickedCard(host.state, ids[resolution.step === 'card-a' ? 0 : 1], picked) : null
      if (!actual) return
      if (resolution.step === 'card-a') {
        const id = ids[1]; const target = playerOf(host.state, id)!; host.askSkill({ skillId: YINGYU, ownerId, step: 'card-b', data: { ids, cardA: actual }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【媵予】：选择第二名角色展示的一张手牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: target.zones.hand.map((_, index) => `hidden:${id}:${index}`), min: 1, max: 1 }) })
        return
      }
      const first = playerOf(host.state, ids[0]); const second = playerOf(host.state, ids[1]); const cardA = (resolution.data as { cardA: CardId }).cardA
      if (!first || !second || !cardA) return
      if (host.state.cards[cardA]?.suit === host.state.cards[actual]?.suit) return
      host.askSkill({ skillId: YINGYU, ownerId, step: 'choose-gain', data: { ids, cardA, cardB: actual }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【媵予】：选择一方获得另一方展示牌', timeoutMs: 20_000, optional: false, options: [{ id: ids[0], label: first.nickname }, { id: ids[1], label: second.nickname }] }) })
      return
    }
    if (resolution.step === 'choose-gain') {
      const { ids, cardA, cardB } = resolution.data as { ids: PlayerId[]; cardA: CardId; cardB: CardId }
      const receiverId = (response.payload as { optionId?: string }).optionId
      const giveId = receiverId === ids[0] ? ids[1] : receiverId === ids[1] ? ids[0] : null
      if (!giveId || !receiverId) return
      const cardId = giveId === ids[0] ? cardA : cardB
      gainFrom(host, [cardId], { playerId: giveId, cardIds: [cardId] }, receiverId, YINGYU)
    }
  },
})
registerSkillRuntime({
  id: YONGBI,
  limited: true,
  activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !playerOf(state, ownerId)?.usedLimitedSkills.includes(YONGBI) && (playerOf(state, ownerId)?.zones.hand.length ?? 0) > 0 ? [{ id: YONGBI, label: '拥嬖：将手牌交给一名男性角色' }] : [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YONGBI) return
    const candidates = others(host.state, ownerId).filter((player) => effectiveGenderOf(host.state, player.id) === 'male')
    host.askSkill({ skillId: YONGBI, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【拥嬖】：选择一名男性角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!target || !owner || effectiveGenderOf(host.state, target.id) !== 'male') return
    const ids = [...owner.zones.hand]
    const suits = new Set(ids.map((id) => host.state.cards[id]?.suit).filter(Boolean))
    gainFrom(host, ids, { playerId: ownerId, cardIds: ids }, target.id, YONGBI)
    owner.usedLimitedSkills.push(YONGBI)
    const state = host.state as Batch25State
    state.yinfurenPairs ??= {}
    state.yinfurenPairs[ownerId] ??= []
    state.yinfurenPairs[ownerId].push({ targetId: target.id, maxBonus: suits.size >= 2 ? 2 : 0, damageReduction: suits.size >= 3 })
    if (suits.size >= 2) { owner.marks.yinfurenMaxBonus = (owner.marks.yinfurenMaxBonus ?? 0) + 2; target.marks.yinfurenMaxBonus = (target.marks.yinfurenMaxBonus ?? 0) + 2 }
    if (suits.size >= 3) { state.yinfurenPairs[ownerId].at(-1)!.damageReduction = true }
    state.yinfurenEndEnabled ??= {}; state.yinfurenEndEnabled[ownerId] = true
  },
  maxCardsBonus(state, ownerId) { return playerOf(state, ownerId)?.marks.yinfurenMaxBonus ?? 0 },
  incomingDamage(state, ownerId, context) { const pairs = (state as Batch25State).yinfurenPairs?.[ownerId] ?? []; return pairs.some((pair) => pair.damageReduction) && context.amount > 1 ? { amount: context.amount - 1 } : null },
})
registerPindianContinuation(KANNAN, (host, result) => {
  const state = host.state as Batch25State
  const owner = playerOf(host.state, result.initiatorId)
  const target = playerOf(host.state, result.opponentId)
  if (!owner || !target) return
  if (result.outcome === 'initiator-win') {
    state.liuyaoNextSlash ??= {}
    state.liuyaoNextSlash[owner.id] = true
    if (state.liuyaoKannan?.[owner.id]) state.liuyaoKannan[owner.id].disabled = true
  } else if (result.outcome === 'opponent-win') {
    state.liuyaoNextSlash ??= {}
    state.liuyaoNextSlash[target.id] = true
  }
})

const HONGDE = 'hongde'
const DINGPAN = 'dingpan'
registerSkillRuntime({
  id: HONGDE,
  triggers: [{
    event: 'CardMove',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardIds?: CardId[]; sourcePlayerId?: PlayerId; destinationPlayerId?: PlayerId }
      const ids = payload.cardIds ?? []
      if (ids.length < 2 || (payload.sourcePlayerId !== ownerId && payload.destinationPlayerId !== ownerId)) return
      const candidates = others(host.state, ownerId)
      if (candidates.length) host.queueSkill({ skillId: HONGDE, ownerId, step: 'target', data: { candidates: candidates.map((player) => player.id) } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const ids = (prompt.data as { candidates: PlayerId[] }).candidates.filter((id) => playerOf(host.state, id)?.alive)
    if (!ids.length) return
    host.askSkill({ skillId: HONGDE, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【弘德】：令一名其他角色摸一张牌', timeoutMs: 20_000, optional: true, candidateIds: ids, min: 0, max: 1 }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId) drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
  },
})
registerSkillRuntime({
  id: DINGPAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const x = state.players.filter((player) => player.alive && player.identity === 'rebel').length
    const used = (state as Batch25State).buzhiDingpan?.[ownerId] ?? 0
    return used < x && others(state, ownerId).some((player) => equipmentIds(state, player.id).length) ? [{ id: DINGPAN, label: `定叛：本阶段还可发动${x - used}次` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DINGPAN) return
    const state = host.state as Batch25State
    const x = host.state.players.filter((player) => player.alive && player.identity === 'rebel').length
    state.buzhiDingpan ??= {}
    if ((state.buzhiDingpan[ownerId] ?? 0) >= x) return
    const candidates = others(host.state, ownerId).filter((player) => equipmentIds(host.state, player.id).length)
    host.askSkill({ skillId: DINGPAN, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【定叛】：选择有装备的角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = playerOf(host.state, targetId)
      if (!target) return
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'take') {
        for (const cardId of equipmentIds(host.state, targetId)) {
          const from = locateOwnedCard(host.state, targetId, cardId)
          if (from) moveCard(host.state, cardId, from, { kind: 'hand', playerId: targetId })
        }
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      } else if (mode === 'discard') {
        const ids = equipmentIds(host.state, targetId)
        host.askSkill({ skillId: DINGPAN, ownerId, step: 'discard-equipment', data: { targetId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【定叛】：选择要弃置的装备', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 1, max: 1 }) })
      }
      return
    }
    if (resolution.step === 'discard-equipment') {
      discardOwned(host, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [], DINGPAN)
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive || !equipmentIds(host.state, target.id).length) return
    const state = host.state as Batch25State
    state.buzhiDingpan ??= {}
    state.buzhiDingpan[ownerId] = (state.buzhiDingpan[ownerId] ?? 0) + 1
    drawCards(host.state, host.rng, target.id, 1, (name, data) => host.dispatch(name, data))
    host.askSkill({ skillId: DINGPAN, ownerId, step: 'mode', data: { targetId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: target.id, prompt: '【定叛】：选择处理装备的方式', timeoutMs: 20_000, optional: false, options: [{ id: 'discard', label: '令步骘弃置你的一张装备' }, { id: 'take', label: '你获得装备区全部牌，然后受到1点伤害' }] }) })
  },
})

const QIANXIN = 'qianxin'
const ZHENXING = 'zhenxing'
const QIANXIN_GROUP = 'qianxin-secret'
registerGroupCardDecision(QIANXIN_GROUP, (host, decision) => {
  const state = host.state as Batch25State
  const cards = decision.playerIds.map((playerId) => {
    const selected = (decision.responses[playerId] as CardId[] | undefined)?.[0]
    return selected ? { playerId, cardId: selected } : null
  }).filter((entry): entry is { playerId: PlayerId; cardId: CardId } => Boolean(entry))
  const tagged: CardId[] = []
  for (const { playerId, cardId } of cards) {
    const from = locateOwnedCard(state, playerId, cardId)
    if (!from) continue
    moveCard(state, cardId, from, { kind: 'drawPile' })
    const index = state.zones.drawPile.indexOf(cardId)
    if (index >= 0) {
      state.zones.drawPile.splice(index, 1)
      const upperHalf = Math.ceil(state.zones.drawPile.length / 2)
      const insertion = host.rng ? host.rng.nextInt(upperHalf + 1) : 0
      state.zones.drawPile.splice(insertion, 0, cardId)
      tagged.push(cardId)
    }
  }
  state.zhanggongXin = tagged
  state.zhanggongPending = undefined
})
registerSkillRuntime({
  id: QIANXIN,
  activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, QIANXIN) && !(state as Batch25State).zhanggongXin?.length ? [{ id: QIANXIN, label: '遣信：各选择一张手牌置于牌堆上方' }] : [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIANXIN) return
    markUsedThisPhase(host.state, ownerId, QIANXIN)
    const playerIds = host.state.players.filter((player) => player.alive && player.zones.hand.length).map((player) => player.id)
    startGroupCardDecision(host as never, {
      id: `qianxin-${host.state.seq}`,
      tag: QIANXIN_GROUP,
      skillId: QIANXIN,
      playerIds,
      prompt: '【遣信】：秘密选择一张手牌作为“信”',
      cardIdsFor: (playerId) => playerOf(host.state, playerId)?.zones.hand ?? [],
      min: 1,
      max: 1,
      timeoutMs: 20_000,
      data: { ownerId },
    })
  },
})
registerSkillRuntime({
  id: ZHENXING,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) { const p = context.event.payload as { phase?: string; playerId?: PlayerId }; if (p.phase === 'finish' && p.playerId === ownerId) host.queueSkill({ skillId: ZHENXING, ownerId, step: 'reveal', data: {} }) } }, {
    event: 'Damaged', handle(host, ownerId) { host.queueSkill({ skillId: ZHENXING, ownerId, step: 'reveal', data: {} }) },
  }, { event: 'GainCard', handle(host, ownerId, context) { const ids = ((context.event.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => (host.state as Batch25State).zhanggongXin?.includes(id)); if (!ids.length) return; const state = host.state as Batch25State; state.zhanggongXin = (state.zhanggongXin ?? []).filter((id) => !ids.includes(id)); const owner = playerOf(host.state, ownerId); if (owner) drawCards(host.state, host.rng, ownerId, Math.max(0, 4 - owner.zones.hand.length), (name, data) => host.dispatch(name, data)); const turnOwner = playerOf(host.state, host.state.currentPlayerId); if (turnOwner) turnOwner.marks.zhanggongMaxCardsMinus2 = host.state.turnNumber } }],
  startQueued(host, ownerId, prompt) { if (prompt.step !== 'reveal') return; const top = revealTopCards(host.state, host.rng, 3, ZHENXING, (name, data) => host.dispatch(name, data)); const candidates = top.filter((id) => top.filter((other) => other !== id).every((other) => host.state.cards[other]?.suit !== host.state.cards[id]?.suit)); if (!candidates.length) { for (const id of top.slice().reverse()) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true }); return } host.askSkill({ skillId: ZHENXING, ownerId, step: 'pick', data: { top }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【镇行】：选择一张符合花色条件的牌获得', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1 }) }) },
  resume(host, ownerId, resolution, response) { if (resolution.step !== 'pick') return; const top = (resolution.data as { top: CardId[] }).top; const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]; if (!picked || !top.includes(picked)) return; const remaining = top.filter((id) => id !== picked); for (const id of remaining.slice().reverse()) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true }); moveCard(host.state, picked, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId }); const state = host.state as Batch25State; state.zhanggongXin = [...remaining]; host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: ZHENXING }, { targetId: ownerId, cardIds: [picked] }) },
  globalMaxCardsBonus(state, _ownerId, targetId) { return playerOf(state, targetId)?.marks.zhanggongMaxCardsMinus2 === state.turnNumber ? -2 : 0 },
})

const SANWEN = 'sanwen'
const QIAI = 'qiai'
const DENGLou = 'denglou'
registerSkillRuntime({
  id: SANWEN,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || usedThisTurn(host.state, ownerId, SANWEN)) return
      const gained = (context.event.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner || !gained.length) return
      const valid = gained.filter((id) => owner.zones.hand.includes(id) && owner.zones.hand.some((other) => other !== id && host.state.cards[other]?.name === host.state.cards[id]?.name))
      if (valid.length) host.queueSkill({ skillId: SANWEN, ownerId, step: 'show', data: { gained: valid } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'show') return
    const ids = (prompt.data as { gained: CardId[] }).gained.filter((id) => playerOf(host.state, ownerId)?.zones.hand.includes(id))
    if (!ids.length) return
    host.askSkill({ skillId: SANWEN, ownerId, step: 'show', data: { gained: ids }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【散文】：选择本次获得的同名牌弃置', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 0, max: ids.length }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'show') return
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!ids.length) return
    markUsedThisTurn(host.state, ownerId, SANWEN)
    const discarded = discardOwned(host, ownerId, ids, SANWEN)
    if (discarded.length) drawCards(host.state, host.rng, ownerId, discarded.length * 2, (name, data) => host.dispatch(name, data))
  },
})
registerSkillRuntime({
  id: QIAI,
  limited: true,
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    if (dyingPlayerId !== ownerId || !owner?.alive || owner.usedLimitedSkills.includes(QIAI)) return []
    return others(state, ownerId).some((player) => player.zones.hand.length) ? [{ id: QIAI, label: '七哀：令其他存活角色各交给你一张牌' }] : []
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== QIAI || dyingPlayerId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(QIAI)) return false
    owner.usedLimitedSkills.push(QIAI)
    for (const target of others(host.state, ownerId)) {
      const cardId = target.zones.hand[0]
      if (cardId) gainFrom(host, [cardId], { playerId: target.id, cardIds: [cardId] }, ownerId, QIAI)
    }
    return true
  },
})
registerSkillRuntime({
  id: DENGLou,
  limited: true,
  triggers: [{
    event: 'CardResolved',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const pending = (host.state as Batch25State).wangcanDenglou?.[ownerId]
      if (pending && !host.state.pendingRequests.length) continueDenglou(host, ownerId)
    },
  }],
  activeActions(state, ownerId) { return state.phase === 'finish' && state.currentPlayerId === ownerId && !playerOf(state, ownerId)?.usedLimitedSkills.includes(DENGLou) && playerOf(state, ownerId)?.zones.hand.length === 0 ? [{ id: DENGLou, label: '登楼：观看牌堆顶四张牌' }] : [] },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DENGLou) return
    playerOf(host.state, ownerId)?.usedLimitedSkills.push(DENGLou)
    const top = revealTopCards(host.state, host.rng, 4, DENGLou, (name, data) => host.dispatch(name, data))
    const nonBasic = top.filter((id) => host.state.cards[id]?.category !== 'basic')
    const basic = top.filter((id) => host.state.cards[id]?.category === 'basic')
    for (const id of nonBasic) { moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId }); host.dispatch('GainCard', { playerId: ownerId, cardIds: [id], reason: DENGLou }, { targetId: ownerId, cardIds: [id] }) }
    for (const id of basic) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    const state = host.state as Batch25State
    state.wangcanDenglou ??= {}
    state.wangcanDenglou[ownerId] = { cards: basic, index: 0 }
    if (!basic.length) return
    host.askSkill({ skillId: DENGLou, ownerId, step: 'order', data: { cards: basic }, build: (requestId): ArrangeOptionsRequest => ({ id: requestId, kind: 'arrange-options', playerId: ownerId, prompt: '【登楼】：选择依次尝试使用基本牌的顺序', timeoutMs: 30_000, optional: false, options: basic.map((id) => ({ id, label: host.state.cards[id]?.name ?? id })) }) })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch25State
    const pending = state.wangcanDenglou?.[ownerId]
    if (!pending) return
    if (resolution.step === 'order') {
      const ordered = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const allowed = new Set(pending.cards)
      if (ordered.length !== pending.cards.length || ordered.some((id) => !allowed.has(id)) || new Set(ordered).size !== ordered.length) return
      pending.cards = ordered
      pending.index = 0
      continueDenglou(host, ownerId)
      return
    }
    if (resolution.step !== 'use') return
    const cardId = pending.cards[pending.index]
    const actionId = (response.payload as { optionId?: string }).optionId
    const action = legalPlayActions(host.state, ownerId).find((candidate) => candidate.kind === 'use-card' && candidate.id === actionId && candidate.cardIds.includes(cardId))
    pending.index += 1
    if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
    if (!host.state.pendingRequests.length) continueDenglou(host, ownerId)
  },
})
function continueDenglou(host: SkillHost, ownerId: PlayerId): void {
  const pending = (host.state as Batch25State).wangcanDenglou?.[ownerId]
  if (!pending) return
  while (pending.index < pending.cards.length) {
    const cardId = pending.cards[pending.index]
    const owner = playerOf(host.state, ownerId)
    if (!owner?.zones.hand.includes(cardId)) { pending.index += 1; continue }
    const actions = legalPlayActions(host.state, ownerId).filter((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(cardId))
    if (!actions.length) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      pending.index += 1
      continue
    }
    host.askSkill({ skillId: DENGLou, ownerId, step: 'use', data: { cardId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【登楼】：尝试使用【${host.state.cards[cardId]?.name ?? ''}】`, timeoutMs: 30_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })) }) })
    return
  }
  delete (host.state as Batch25State).wangcanDenglou?.[ownerId]
}

const JUNBING = 'junbing'
const QUJI = 'quji'
registerSkillRuntime({
  id: JUNBING,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const target = payload.playerId ? playerOf(host.state, payload.playerId) : undefined
      if (payload.phase === 'finish' && target?.alive && target.zones.hand.length < 2 && playerOf(host.state, ownerId)?.alive) host.queueSkill({ skillId: JUNBING, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = (prompt.data as { targetId: PlayerId }).targetId
    if (!playerOf(host.state, targetId)?.alive) return
    host.askSkill({ skillId: JUNBING, ownerId, step: 'ask', data: { targetId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: targetId, prompt: '【郡兵】：摸一张牌并将手牌交给司马朗？', timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!target || !owner) return
      const ids = [...target.zones.hand]
      gainFrom(host, ids, { playerId: targetId, cardIds: ids }, ownerId, JUNBING)
      const received = ids.filter((id) => owner.zones.hand.includes(id))
      if (received.length) host.askSkill({ skillId: JUNBING, ownerId, step: 'return', data: { targetId, count: received.length }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【郡兵】：选择等量手牌交还', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: Math.min(received.length, owner.zones.hand.length), max: Math.min(received.length, owner.zones.hand.length) }) })
      return
    }
    if (resolution.step === 'return') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      gainFrom(host, ids, { playerId: ownerId, cardIds: ids }, targetId, JUNBING)
    }
  },
})
registerSkillRuntime({
  id: QUJI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, QUJI)) return []
    const owner = playerOf(state, ownerId)
    return owner && owner.hp < owner.maxHp && owner.zones.hand.length >= owner.maxHp - owner.hp ? [{ id: QUJI, label: `去疾：弃置${owner.maxHp - owner.hp}张牌令受伤角色回复` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QUJI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const x = owner.maxHp - owner.hp
    markUsedThisPhase(host.state, ownerId, QUJI)
    const candidates = host.state.players.filter((player) => player.alive && player.hp < player.maxHp)
    host.askSkill({ skillId: QUJI, ownerId, step: 'targets', data: { x }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【去疾】：选择至多X名受伤角色', timeoutMs: 20_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: Math.min(x, candidates.length) }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetIds.length) return
      const x = (resolution.data as { x: number }).x
      host.askSkill({ skillId: QUJI, ownerId, step: 'cards', data: { targetIds }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【去疾】：弃置${x}张牌`, timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...(playerOf(host.state, ownerId)?.zones.hand ?? [])], hiddenCardSlots: [], min: x, max: x }) })
      return
    }
    if (resolution.step !== 'cards') return
    const owner = playerOf(host.state, ownerId)
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const discarded = discardOwned(host, ownerId, ids, QUJI)
    if (!owner || discarded.length !== ids.length) return
    for (const targetId of (resolution.data as { targetIds: PlayerId[] }).targetIds) recover(host as never, targetId, 1, ownerId)
    if (discarded.some((id) => host.state.cards[id]?.color === 'black')) loseHp(host as never, ownerId, 1, QUJI)
  },
})

const CHANNI = 'channi'
const NIFU = 'nifu'
registerSkillRuntime({
  id: CHANNI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, CHANNI)) return []
    const owner = playerOf(state, ownerId)
    return owner?.zones.hand.length && others(state, ownerId).length ? [{ id: CHANNI, label: '谗逆：交给一名角色并令其将牌当作决斗' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== CHANNI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    host.askSkill({ skillId: CHANNI, ownerId, step: 'give', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【谗逆】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds: others(host.state, ownerId).map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (!targetId || !owner) return
      host.askSkill({ skillId: CHANNI, ownerId, step: 'cards', data: { targetId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【谗逆】：选择交给目标的手牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length }) })
      return
    }
    if (resolution.step === 'cards') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const moved = ids.filter((id) => playerOf(host.state, ownerId)?.zones.hand.includes(id))
      if (!moved.length) return
      gainFrom(host, moved, { playerId: ownerId, cardIds: moved }, targetId, CHANNI)
      const target = playerOf(host.state, targetId)
      if (!target) return
      markUsedThisPhase(host.state, ownerId, CHANNI)
      host.askSkill({ skillId: CHANNI, ownerId, step: 'subcards', data: { targetId, count: moved.length }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【谗逆】：选择用于【决斗】的手牌（可放弃）', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: moved.length }) })
      return
    }
    if (resolution.step === 'subcards') {
      const data = resolution.data as { targetId: PlayerId; count: number }
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!ids.length) {
        replaceTemporarySkill(host.state, data.targetId, `${CHANNI}:${ownerId}`, null)
        delete (host.state as Batch25State).yanfurenDuel?.[data.targetId]
        return
      }
      if (ids.length > data.count) return
      const state = host.state as Batch25State
      state.yanfurenDuel ??= {}
      state.yanfurenDuel[data.targetId] = { sourceId: data.targetId, cardId: ids[0], count: ids.length }
      replaceTemporarySkill(host.state, data.targetId, `${CHANNI}:${ownerId}`, CHANNI)
    }
  },
  multiCardViewAs(state, ownerId): MultiCardViewAsSpec | null {
    const duel = (state as Batch25State).yanfurenDuel?.[ownerId]
    if (!duel) return null
    return { skillId: CHANNI, skillName: '谗逆', requiredCount: duel.count, suitToCardName: {}, sameSuit: false, anySuitCardNames: ['决斗'], handOnly: true }
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      const sourceId = context.event.sourceId
      const duel = (host.state as Batch25State).yanfurenDuel?.[sourceId ?? '']
      if (payload.cardName !== '决斗' || !sourceId || !duel || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) discardOwned(host, ownerId, [...owner.zones.hand], CHANNI)
    },
  }, {
    event: 'CardResolved',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const duel = (host.state as Batch25State).yanfurenDuel?.[sourceId ?? '']
      const payload = context.event.payload as { cardName?: string }
      if (!sourceId || !duel || payload.cardName !== '决斗') return
      replaceTemporarySkill(host.state, sourceId, `${CHANNI}:${ownerId}`, null)
      const state = host.state as Batch25State
      delete state.yanfurenDuel?.[sourceId]
      if (sourceId === ownerId) drawCards(host.state, host.rng, ownerId, duel.count, (name, data) => host.dispatch(name, data))
    },
  }],
})
registerSkillRuntime({
  id: NIFU,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      if (owner.zones.hand.length < 3) drawCards(host.state, host.rng, ownerId, 3 - owner.zones.hand.length, (name, data) => host.dispatch(name, data))
      else if (owner.zones.hand.length > 3) host.queueSkill({ skillId: NIFU, ownerId, step: 'discard', data: { count: owner.zones.hand.length - 3 } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const count = (prompt.data as { count: number }).count
    if (!owner || count <= 0) return
    host.askSkill({ skillId: NIFU, ownerId, step: 'discard', data: {}, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【匿伏】：弃置手牌至三张', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: count, max: count }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') discardOwned(host, ownerId, (response.payload as { cardIds?: CardId[] }).cardIds ?? [], NIFU)
  },
})

export const HISTORICAL_BATCH25_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'liuyao', name: '刘繇', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: KANNAN, name: '戡难', description: '出牌阶段限X次，与一名有手牌的角色拼点并根据胜负强化下一张【杀】。X为你的体力值。' }] },
  { id: 'buzhi', name: '步骘', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: HONGDE, name: '弘德', description: '当一次卡牌移动涉及你且移动牌数不少于两张时，你可令一名其他角色摸一张牌。' }, { id: DINGPAN, name: '定叛', description: '出牌阶段限X次，令有装备的角色摸一张牌并选择弃置一件装备或获得全部装备并受到一点伤害。X为存活反贼数。' }] },
  { id: 'zhanggong', name: '张恭', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: QIANXIN, name: '遣信', description: '出牌阶段限一次，令存活角色各选择一张手牌作为“信”置于牌堆上半部。' }, { id: ZHENXING, name: '镇行', description: '结束阶段或受伤后观看牌堆顶三张，获得其中花色各不相同的一张。获得“信”后摸至四张并令当前回合角色手牌上限本回合减二。' }] },
  { id: 'wangcan', name: '王粲', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: SANWEN, name: '散文', description: '每回合一次，获得与手牌同名的牌后可弃置其中若干张并摸两倍数量。' }, { id: QIAI, name: '七哀', description: '限定技，你进入濒死时令其他存活角色各交给你一张牌。' }, { id: DENGLou, name: '登楼', description: '限定技，结束阶段手牌为零时观看牌堆顶四张，获得其中非基本牌并处理基本牌。' }] },
  { id: 'simalang', name: '司马朗', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: JUNBING, name: '郡兵', description: '角色结束阶段手牌少于两张时可摸一张并将手牌交给你，你等量交还手牌。' }, { id: QUJI, name: '去疾', description: '出牌阶段，弃置X张牌令至多X名受伤角色各回复一点；弃置黑牌后你失去一点体力。' }] },
  { id: 'hucheer', name: '胡车儿', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: DAOJI, name: '盗戟', description: '每名其他角色首次使用武器牌时，你获得之或令其本回合不能使用或打出【杀】。' }, { id: FUZHONG, name: '负重', description: '回合外获得手牌后记录一次“重”，按层数增加摸牌、距离和手牌上限，并可移去四枚造成伤害。' }] },
  { id: 'lisu', name: '李肃', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: LIXUN, name: '利熏', description: '锁定技，防止受到的伤害并获得等量“珠”。准备阶段判定并按结果弃牌或失去体力。' }, { id: KUIZHU, name: '馈珠', description: '结束阶段令一名体力值最高的角色观看你的手牌并交换手牌；交换多张后移去“珠”或令其造成伤害。' }] },
  { id: 'ganfuren', name: '甘夫人', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: SHUSHEN, name: '淑慎', description: '你回复一点体力后可令一名其他角色摸一张牌。' }, { id: SHENZHI, name: '神智', description: '准备阶段可弃置所有手牌，若不少于当前体力则回复一点体力。' }] },
  { id: 'yinfuren', name: '尹夫人', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: YINGYU, name: '媵予', description: '准备阶段或拥嬖后结束阶段各选择两名有手牌角色展示手牌，花色不同则令一方获得另一方的牌。' }, { id: YONGBI, name: '拥嬖', description: '限定技，将所有手牌交给一名男性角色；花色达到两种或三种时获得永久强化。' }] },
  { id: 'yanfuren', name: '严夫人', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: CHANNI, name: '谗逆', description: '出牌阶段限一次，交给一名其他角色若干手牌，令其将其中若干张当【决斗】使用；其造成伤害后摸等量牌，受到伤害后你弃置所有手牌。' }, { id: NIFU, name: '匿伏', description: '回合结束时将手牌调整至三张。' }] },
] as const
