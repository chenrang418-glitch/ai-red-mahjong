import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import { drawCards } from '../../engine/draw'
import { canTarget, getDistance, getAttackRange, getSeatDistance } from '../../engine/distance'
import { canUseSlash, hasSlashUsesBypass } from '../../engine/slash-rules'
import { giveCards } from '../../engine/hand-transfer'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { queueExtraTurn } from '../../engine/turn'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { createVirtualSlashCard, declaredCardActions } from '../../engine/cards/basic'
import { characterPileCardUseActions } from '../../engine/cards/basic'
import { hiddenHandSlot } from '../../engine/cards/host'
import { moveCard } from '../../engine/zones'
import { characterSkillIdsOf, effectiveCardColor, effectiveCardSuit, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { isCardProtectedFromDiscard } from '../../engine/skills/runtime'
import { weaponCardsOf } from '../../engine/equipment-slots'
import { isTargetProhibited } from '../../engine/skills/runtime'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import type { LegalAction } from '../../engine/actions'
import { discardCardsByIds } from '../../engine/discard-all'
import { resolvePickedCard } from '../../engine/card-pick'
import { handleEquipmentLost } from '../../engine/equipment'
import { isSlotAbolished } from '../../engine/equipment-slots'
import type { CharacterDefinition } from './types'
import { SP_LIU_BEI_B62 } from './historical-batch62-sp-liubei'

const b62 = (id: string) => `${id}:b62`
const ZHANGSHIPING_BINJI = b62('binji-zhangshiping')
const ZHANGSHIPING_ZAOMAO = b62('zaomao-zhangshiping')
const DUANJIONG_SAOGU = b62('saogu-duanjiong')
const MAWAN_MASHU = b62('mashu-mawan')
const MAWAN_HUNJIANG = b62('hunjiang-mawan')
const DINGSHANGWAN_FUDIAO = b62('fudiao-dingshangwan')
const DINGSHANGWAN_FENGYAN = b62('fengyan-dingshangwan')
const LIWAN_LIANJU = b62('lianju-liwan')
const LIWAN_SILU = b62('silu-liwan')
const LUBOSHE_FUSHI = b62('fushi-luboshe')
const LUBOSHE_DONGDAO = b62('dongdao-luboshe')
const YADAN_QINGYA = b62('qingya-yadan')
const YADAN_TIELUN = b62('tielun-yadan')
const YADAN_QINGYA_PILE = YADAN_QINGYA
const LIYI_CHANSHUANG = b62('chanshuang-liyi')
const LIYI_ZHANJIN = b62('zhanjin-liyi')
const LIUPAN_PIJING = b62('pijing-liupan')
const SUNCE_LIANTAO = b62('liantao-sp-sunce')
const HUNJIANG_GROUP = `${MAWAN_HUNJIANG}:group`
const CHANSHUANG_GROUP = `${LIYI_CHANSHUANG}:group`

type Batch62State = SanguoshaState & {
  b62ZhangShipingGifted?: Record<CardId, PlayerId>
  b62ZaomaoUses?: Record<PlayerId, { phaseKey: string; count: number }>
  b62DuanjiongYin?: Record<PlayerId, boolean>
  b62DuanjiongDiscardedSuits?: Record<PlayerId, { phaseKey: string; suits: string[] }>
  b62DuanjiongUseCounts?: Record<PlayerId, number>
  b62MaWanTargets?: Record<PlayerId, { phaseKey: string; targetIds: PlayerId[] }>
  b62DingshangwanHandCount?: Record<PlayerId, number>
  b62DingshangwanUsedEndTurn?: Record<PlayerId, number>
  b62LiwanUsedCards?: Record<PlayerId, Array<{ turnNumber: number; cardId: CardId; color: 'red' | 'black' }>>
  b62LiwanDelayed?: Array<{ ownerId: PlayerId; targetId: PlayerId; color: 'red' | 'black'; sourceTurn: number }>
  b62LiwanMarks?: Record<CardId, PlayerId>
  b62LubosheSlashPile?: Record<PlayerId, CardId[]>
  b62LubosheStance?: Record<PlayerId, 'yang' | 'yin'>
  b62LandlordMode?: { landlordId: PlayerId; farmerIds: PlayerId[] }
  b62LubosheSlashAdjustments?: Record<CardId, Record<PlayerId, number>>
  b62YadanDeferredCards?: Record<PlayerId, Array<{ cardIds: CardId[]; afterSeq: number }>>
  b62YadanRoundUses?: Record<PlayerId, number>
  b62LiyiItems?: Record<PlayerId, { turnNumber: number; counts: Record<string, number>; actions: string[] }>
  b62LiyiEndTurn?: Record<PlayerId, number>
  b62LiyiPending?: Record<PlayerId, { entries: Array<{ actorId: PlayerId; optionId: string }>; index: number; recordOwnerItems: boolean; cardId: CardId; actorId: PlayerId }>
  b62LiupanBeneficiaries?: Record<PlayerId, PlayerId[]>
  b62LiupanUsedTurn?: Record<PlayerId, number>
  b62SunceNoSlash?: Record<PlayerId, number>
  b62SunceMaxCardsBonus?: Record<PlayerId, number>
  b62SunceResolution?: Record<PlayerId, { targetId: PlayerId; color: 'red' | 'black'; damage: number; cardIds: CardId[]; index: number; activeCardId?: CardId; halted?: boolean }>
}

function p(state: SanguoshaState, id: PlayerId) { return state.players.find((player) => player.id === id) }
function s(host: SkillHost): Batch62State { return host.state as Batch62State }
function askOption(host: SkillHost, ownerId: PlayerId, skillId: string, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options }) })
}
function askCards(host: SkillHost, ownerId: PlayerId, skillId: string, step: string, prompt: string, cardIds: CardId[], min: number, max: number, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional: min === 0, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function askTargets(host: SkillHost, ownerId: PlayerId, skillId: string, step: string, prompt: string, candidateIds: PlayerId[], min: number, max: number, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional: min === 0, candidateIds, min, max }) })
}
function currentPhaseKey(state: SanguoshaState): string { return `${state.turnNumber}:${state.phase}:${state.extraPhase?.instanceId ?? ''}` }

function horseCardsInPublicPools(state: SanguoshaState): CardId[] {
  return [...state.zones.drawPile, ...state.zones.discardPile].filter((id) => {
    const card = state.cards[id]
    return card?.category === 'equipment' && (card.equipmentSlot === 'offensiveHorse' || card.equipmentSlot === 'defensiveHorse')
  })
}

function zhangShipingDiscardableDiamonds(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = p(state, ownerId)
  if (!owner) return []
  const handAndEquipment = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  return handAndEquipment.filter((id) => effectiveCardSuit(state, ownerId, id) === 'diamond'
    && !isCardProtectedFromDiscard(state, ownerId, id, ownerId))
}

function horseSlotsOf(state: SanguoshaState, playerId: PlayerId): EquipmentSlot[] {
  return (['offensiveHorse', 'defensiveHorse'] as const).filter((slot) => !isSlotAbolished(state, playerId, slot))
}

function horseEquipmentOf(player: NonNullable<ReturnType<typeof p>>, state: SanguoshaState): Array<{ cardId: CardId; slot: EquipmentSlot }> {
  return (['offensiveHorse', 'defensiveHorse'] as const).flatMap((slot) => {
    const cardId = player.zones.equipment[slot]
    return cardId && state.cards[cardId] ? [{ cardId, slot }] : []
  })
}

function areAdjacentTargets(state: SanguoshaState, targetIds: PlayerId[]): boolean {
  if (targetIds.length < 2) return false
  const alive = state.players.filter((candidate) => candidate.alive).sort((a, b) => a.seat - b.seat)
  const indexes = targetIds.map((id) => alive.findIndex((candidate) => candidate.id === id)).sort((a, b) => a - b)
  if (indexes.some((index) => index < 0)) return false
  for (let start = 0; start < indexes.length; start += 1) {
    const sequence = Array.from({ length: indexes.length }, (_, offset) => (indexes[start]! + offset) % alive.length)
    if (sequence.every((index) => indexes.includes(index))) return true
  }
  return false
}

function lubosheCanTarget(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  return p(state, targetId)?.alive === true && targetId !== ownerId && canTarget(state, ownerId, targetId)
    && !isTargetProhibited(state, ownerId, targetId, '杀', characterSkillIdsOf)
}

function lubosheSlashAvailable(state: SanguoshaState, ownerId: PlayerId): boolean {
  return canUseSlash(state, ownerId, false) || hasSlashUsesBypass(state, ownerId)
}

function lubosheFreeTargetPairs(state: SanguoshaState, ownerId: PlayerId): Array<[PlayerId, PlayerId]> {
  const candidates = state.players.filter((target) => lubosheCanTarget(state, ownerId, target.id)).map(({ id }) => id)
  const pairs: Array<[PlayerId, PlayerId]> = []
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (getSeatDistance(state, candidates[left]!, candidates[right]!) === 1) pairs.push([candidates[left]!, candidates[right]!])
    }
  }
  return pairs
}

function resolveHunjiang(groupHost: import('../../engine/group-decision').GroupDecisionHost, decision: import('../../engine/types').GroupDecisionState): void {
  const host = groupHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const targetIds = decision.playerIds.filter((id) => decision.responses[id] !== undefined)
  const chosen = targetIds.map((id) => decision.responses[id])
  const allSame = chosen.length > 0 && chosen.every((choice) => choice === chosen[0])
  const owner = p(host.state, ownerId)
  if (!owner?.alive) return
  const data = s(host)
  const bonus = data.b62MaWanTargets ??= {}
  const extraTargets = targetIds.filter((id) => {
    const choice = decision.responses[id]
    return choice === 'slash-target' || (allSame && choice === 'draw')
  })
  const draws = targetIds.filter((id) => {
    const choice = decision.responses[id]
    return choice === 'draw' || (allSame && choice === 'slash-target')
  }).length
  if (extraTargets.length) bonus[ownerId] = { phaseKey: currentPhaseKey(host.state), targetIds: extraTargets }
  else delete bonus[ownerId]
  if (draws) drawCards(host.state, host.rng, ownerId, draws, host.dispatch.bind(host))
}

registerGroupDecision(HUNJIANG_GROUP, resolveHunjiang)

function resolveChanshuang(groupHost: import('../../engine/group-decision').GroupDecisionHost, decision: import('../../engine/types').GroupDecisionState): void {
  const host = groupHost as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const entries = decision.playerIds.flatMap((actorId) => {
    const optionId = decision.responses[actorId]
    return optionId ? [{ actorId, optionId }] : []
  })
  if (!p(host.state, ownerId)?.alive || !entries.length) return
  host.queueSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'resolve-sequence', data: { entries, index: 0, recordOwnerItems: true } })
}

registerGroupDecision(CHANSHUANG_GROUP, resolveChanshuang)

function chanshuangSlashActions(state: SanguoshaState, actorId: PlayerId, cardId: CardId): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  return declaredCardActions(state, actorId, cardId, '杀', '【缠双】使用【杀】', { sourceSkillId: LIYI_CHANSHUANG, ignoreSlashQuota: true })
    .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
}

function chanshuangOptions(state: SanguoshaState, actorId: PlayerId): Array<{ id: string; label: string }> {
  const actor = p(state, actorId)
  if (!actor?.alive) return []
  const discardable = [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter((id) => !isCardProtectedFromDiscard(state, actorId, id, actorId))
  return [
    ...(actor.zones.hand.length ? [{ id: 'recast', label: '重铸一张手牌' }] : []),
    ...(actor.zones.hand.some((id) => state.cards[id]?.name === '杀' && chanshuangSlashActions(state, actorId, id).length)
      ? [{ id: 'slash', label: '使用一张【杀】' }] : []),
    ...(discardable.length >= 2 ? [{ id: 'discard', label: '弃置两张牌' }] : []),
  ]
}

function queueNextChanshuang(host: SkillHost, ownerId: PlayerId, entries: Array<{ actorId: PlayerId; optionId: string }>, index: number, recordOwnerItems: boolean): void {
  if (index >= entries.length) return
  host.queueSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'resolve-sequence', data: { entries, index, recordOwnerItems } })
}

function recordChanshuangItem(host: SkillHost, ownerId: PlayerId, actorId: PlayerId, optionId: string, enabled: boolean): void {
  if (!enabled || ownerId !== actorId) return
  const data = s(host).b62LiyiItems ??= {}
  const previous = data[ownerId]
  const record = previous?.turnNumber === host.state.turnNumber
    ? previous
    : (data[ownerId] = { turnNumber: host.state.turnNumber, counts: {}, actions: [] })
  record.counts[optionId] = (record.counts[optionId] ?? 0) + 1
  record.actions.push(optionId)
}

function startChanshuangSequence(
  host: SkillHost,
  ownerId: PlayerId,
  entries: Array<{ actorId: PlayerId; optionId: string }>,
  index: number,
  recordOwnerItems: boolean,
): void {
  if (index >= entries.length || !p(host.state, ownerId)?.alive) return
  const { actorId, optionId } = entries[index]!
  const actor = p(host.state, actorId)
  if (!actor?.alive) { queueNextChanshuang(host, ownerId, entries, index + 1, recordOwnerItems); return }
  const continueWith = () => queueNextChanshuang(host, ownerId, entries, index + 1, recordOwnerItems)
  if (optionId === 'recast') {
    if (!actor.zones.hand.length) { continueWith(); return }
    host.askSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'recast-card', data: { entries, index, recordOwnerItems, actorId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: actorId, prompt: '【缠双】：选择一张手牌重铸', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }) })
    return
  }
  if (optionId === 'discard') {
    const ids = [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => !isCardProtectedFromDiscard(host.state, actorId, id, actorId))
    if (ids.length < 2) { continueWith(); return }
    host.askSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'discard-two', data: { entries, index, recordOwnerItems, actorId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: actorId, prompt: '【缠双】：选择两张牌弃置', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 2, max: 2,
    }) })
    return
  }
  if (optionId !== 'slash') { continueWith(); return }
  const slashIds = actor.zones.hand.filter((id) => host.state.cards[id]?.name === '杀' && chanshuangSlashActions(host.state, actorId, id).length > 0)
  if (!slashIds.length) { continueWith(); return }
  host.askSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'slash-card', data: { entries, index, recordOwnerItems, actorId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: actorId, prompt: '【缠双】：选择一张【杀】使用', timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds: slashIds, hiddenCardSlots: [], min: 1, max: 1,
  }) })
}

registerSkillRuntime({ id: LIYI_CHANSHUANG,
  activeActions(state, ownerId) {
    const owner = p(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, LIYI_CHANSHUANG)
      || !chanshuangOptions(state, ownerId).length) return []
    return state.players.some((target) => target.alive && target.id !== ownerId && chanshuangOptions(state, target.id).length)
      ? [{ id: LIYI_CHANSHUANG, label: '缠双：与一名角色同时选择一项' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIYI_CHANSHUANG || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play'
      || usedThisPhase(host.state, ownerId, LIYI_CHANSHUANG)) return
    const ownerOptions = chanshuangOptions(host.state, ownerId)
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && chanshuangOptions(host.state, target.id).length)
    if (!ownerOptions.length || !candidates.length) return
    askTargets(host, ownerId, LIYI_CHANSHUANG, 'target', '【缠双】：选择一名其他角色', candidates.map(({ id }) => id), 1, 1)
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const record = s(host).b62LiyiItems?.[ownerId]
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !p(host.state, ownerId)?.alive
      || record?.turnNumber !== host.state.turnNumber || !record.actions.length
      || s(host).b62LiyiEndTurn?.[ownerId] === host.state.turnNumber) return
    ;(s(host).b62LiyiEndTurn ??= {})[ownerId] = host.state.turnNumber
    host.queueSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'end-sequence', data: { actions: [...record.actions], index: 0 } })
  } }, { event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    const pending = s(host).b62LiyiPending?.[ownerId]
    if (payload.sourceSkillId !== LIYI_CHANSHUANG || !pending || context.event.sourceId !== pending.actorId) return
    delete s(host).b62LiyiPending![ownerId]
    queueNextChanshuang(host, ownerId, pending.entries, pending.index + 1, pending.recordOwnerItems)
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'resolve-sequence') {
      const { entries, index, recordOwnerItems } = prompt.data as { entries: Array<{ actorId: PlayerId; optionId: string }>; index: number; recordOwnerItems: boolean }
      startChanshuangSequence(host, ownerId, entries, index, recordOwnerItems)
      return
    }
    if (prompt.step === 'end-sequence') {
      const { actions, index } = prompt.data as { actions: string[]; index: number }
      if (index >= actions.length) return
      startChanshuangSequence(host, ownerId, actions.slice(index).map((optionId) => ({ actorId: ownerId, optionId })), 0, false)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const target = p(host.state, targetId)
      if (!target?.alive || !chanshuangOptions(host.state, targetId).length) return
      const orderedIds = [ownerId, targetId]
      const optionsFor = (playerId: PlayerId) => chanshuangOptions(host.state, playerId)
      const defaultFor = (playerId: PlayerId) => optionsFor(playerId)[0]!.id
      markUsedThisPhase(host.state, ownerId, LIYI_CHANSHUANG)
      host.dispatch('SkillActivated', { skillId: LIYI_CHANSHUANG, skillName: '缠双' }, { sourceId: ownerId, targetId })
      startGroupDecision(host, { id: `${resolution.requestId}:choice`, tag: CHANSHUANG_GROUP, skillId: LIYI_CHANSHUANG,
        playerIds: orderedIds, prompt: '【缠双】：同时选择一项执行', options: [
          { id: 'recast', label: '重铸一张手牌' }, { id: 'slash', label: '使用一张【杀】' }, { id: 'discard', label: '弃置两张牌' },
        ], optionsFor, defaultOptionId: 'recast', defaultOptionIdFor: defaultFor, timeoutMs: 25_000, data: { ownerId } })
      return
    }
    const data = resolution.data as { entries?: Array<{ actorId: PlayerId; optionId: string }>; index?: number; recordOwnerItems?: boolean; actorId?: PlayerId }
    const entries = data.entries ?? []
    const index = data.index ?? 0
    const actorId = data.actorId
    const actor = actorId ? p(host.state, actorId) : undefined
    if (!actor?.alive) return
    if (resolution.step === 'recast-card') {
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      if (!cardId || !actor.zones.hand.includes(cardId) || isCardProtectedFromDiscard(host.state, actorId!, cardId, actorId!)) return
      const entry = entries[index]!
      recordChanshuangItem(host, ownerId, actorId!, entry.optionId, data.recordOwnerItems ?? false)
      moveCard(host.state, cardId, { kind: 'hand', playerId: actorId! }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: 'recast' }, { sourceId: actorId, cardIds: [cardId] })
      drawCards(host.state, host.rng, actorId!, 1, host.dispatch.bind(host))
      queueNextChanshuang(host, ownerId, entries, index + 1, data.recordOwnerItems ?? false)
      return
    }
    if (resolution.step === 'discard-two') {
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => {
        const inHand = actor.zones.hand.includes(id)
        const inEquipment = Object.values(actor.zones.equipment).includes(id)
        return (inHand || inEquipment) && !isCardProtectedFromDiscard(host.state, actorId!, id, actorId!)
      })
      if (ids.length !== 2 || new Set(ids).size !== 2) return
      recordChanshuangItem(host, ownerId, actorId!, entries[index]!.optionId, data.recordOwnerItems ?? false)
      discardCardsByIds(host as never, actorId!, ids, LIYI_CHANSHUANG)
      queueNextChanshuang(host, ownerId, entries, index + 1, data.recordOwnerItems ?? false)
      return
    }
    if (resolution.step === 'slash-card') {
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      if (!cardId || !actor.zones.hand.includes(cardId)) return
      const legalTargetSets = chanshuangSlashActions(host.state, actorId!, cardId).map((action) => action.targetIds)
      const candidateIds = [...new Set(legalTargetSets.flat())]
      if (!candidateIds.length) return
      const entry = entries[index]!
      host.askSkill({ skillId: LIYI_CHANSHUANG, ownerId, step: 'slash-targets', data: { entries, index, recordOwnerItems: data.recordOwnerItems, actorId, cardId, legalTargetSets }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: actorId!, prompt: '【缠双】：选择此【杀】的合法目标', timeoutMs: 25_000,
        optional: false, candidateIds, min: 1, max: Math.max(...legalTargetSets.map((ids) => ids.length)),
      }) })
      void entry
      return
    }
    if (resolution.step === 'slash-targets') {
      const { cardId, legalTargetSets } = resolution.data as { cardId: CardId; legalTargetSets: PlayerId[][] }
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds
      if (!legalTargetSets.some((ids) => ids.length === targetIds.length && ids.every((id) => targetIds.includes(id)))) return
      recordChanshuangItem(host, ownerId, actorId!, entries[index]!.optionId, data.recordOwnerItems ?? false)
      const pending = { entries, index, recordOwnerItems: data.recordOwnerItems ?? false, cardId }
      ;(s(host).b62LiyiPending ??= {})[ownerId] = { ...pending, actorId: actorId! }
      if (!host.beginSkillBasicUse({ sourceId: actorId!, cardId, cardName: '杀', targetIds, sourceSkillId: LIYI_CHANSHUANG })) {
        delete s(host).b62LiyiPending![ownerId]
        queueNextChanshuang(host, ownerId, entries, index + 1, data.recordOwnerItems ?? false)
      }
    }
  },
})

registerSkillRuntime({ id: ZHANGSHIPING_BINJI, triggers: [
  { event: 'RoundStart', handle(host, ownerId) {
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    askOption(host, ownerId, ZHANGSHIPING_BINJI, 'invoke', '【镔济】：是否摸三张牌并分给至多三名其他角色？', [
      { id: 'yes', label: '发动镔济' }, { id: 'no', label: '不发动' },
    ], { roundNumber: host.state.roundNumber })
  } },
  { event: 'HandCardLeft', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
    if (!payload.cardId || !payload.playerId) return
    const data = s(host)
    if (data.b62ZhangShipingGifted?.[payload.cardId] !== ownerId || payload.playerId === ownerId) return
    delete data.b62ZhangShipingGifted[ payload.cardId ]
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    const weaponIds = [...host.state.zones.drawPile, ...host.state.zones.discardPile]
      .filter((id) => host.state.cards[id]?.category === 'equipment' && host.state.cards[id]?.equipmentSlot === 'weapon')
    if (!weaponIds.length) return
    const gainedId = host.rng.pick(weaponIds)
    const fromDraw = host.state.zones.drawPile.includes(gainedId)
    if (!p(host.state, payload.playerId)?.alive) return
    moveCard(host.state, gainedId, { kind: fromDraw ? 'drawPile' : 'discardPile' }, { kind: 'hand', playerId: payload.playerId })
    host.dispatch('GainCard', { playerId: payload.playerId, cardIds: [gainedId], reason: ZHANGSHIPING_BINJI }, { targetId: payload.playerId, cardIds: [gainedId] })
    drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
  } },
], resume(host, ownerId, resolution, response) {
  const owner = p(host.state, ownerId)
  if (!owner?.alive) return
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId: string }).optionId !== 'yes') return
    drawCards(host.state, host.rng, ownerId, 3, host.dispatch.bind(host))
    const recipients = host.state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id)
    const cardIds = [...owner.zones.hand]
    if (!recipients.length || !cardIds.length) return
    host.askSkill({ skillId: ZHANGSHIPING_BINJI, ownerId, step: 'distribute', data: {}, build: (id): DistributeCardsRequest => ({
      id, kind: 'distribute-cards', playerId: ownerId, prompt: '【镔济】：将至多三张手牌分给不同的其他角色，每人至多一张', timeoutMs: 25_000,
      optional: true, cardIds, recipientIds: recipients, min: 0, max: Math.min(3, cardIds.length, recipients.length),
    }) })
    return
  }
  if (resolution.step !== 'distribute') return
  const assignments = (response.payload as { assignments: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments
  const usedCards = new Set<CardId>()
  const usedTargets = new Set<PlayerId>()
  for (const assignment of assignments) {
    if (usedCards.has(assignment.cardId) || usedTargets.has(assignment.recipientId)
      || !owner.zones.hand.includes(assignment.cardId) || assignment.recipientId === ownerId) continue
    const target = p(host.state, assignment.recipientId)
    if (!target?.alive) continue
    usedCards.add(assignment.cardId)
    usedTargets.add(assignment.recipientId)
    const gifted = s(host).b62ZhangShipingGifted ??= {}
    gifted[assignment.cardId] = ownerId
    const given = giveCards(host, ownerId, assignment.recipientId, [assignment.cardId], ZHANGSHIPING_BINJI)
    if (!given.length) delete gifted[assignment.cardId]
  }
} })

registerSkillRuntime({ id: ZHANGSHIPING_ZAOMAO,
  activeActions(state, ownerId) {
    const owner = p(state, ownerId)
    const useState = (state as Batch62State).b62ZaomaoUses?.[ownerId]
    const count = useState?.phaseKey === currentPhaseKey(state) ? useState.count : 0
    const handDiamonds = owner?.zones.hand.filter((id) => effectiveCardSuit(state, ownerId, id) === 'diamond') ?? []
    const discardableDiamonds = zhangShipingDiscardableDiamonds(state, ownerId)
    const horsesInPools = horseCardsInPublicPools(state)
    const targets = state.players.filter((target) => target.alive && target.id !== ownerId)
    const mode2 = targets.some((target) => horseEquipmentOf(target, state).length > 0) && handDiamonds.length > 0
    const mode3 = owner?.zones.hand.some((id) => {
      const slot = state.cards[id]?.equipmentSlot
      return (slot === 'offensiveHorse' || slot === 'defensiveHorse') && targets.some((target) =>
        target.zones.hand.length >= 2 && horseSlotsOf(state, target.id).includes(slot))
    })
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && count < 3
      && (horsesInPools.length > 0 && discardableDiamonds.length > 0 || mode2 || mode3)
      ? [{ id: ZHANGSHIPING_ZAOMAO, label: `驵贸：选择一项（本阶段${count}/3）` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHANGSHIPING_ZAOMAO || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play') return
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    const useState = s(host).b62ZaomaoUses?.[ownerId]
    const count = useState?.phaseKey === currentPhaseKey(host.state) ? useState.count : 0
    if (count >= 3) return
    const handDiamondIds = owner.zones.hand.filter((id) => effectiveCardSuit(host.state, ownerId, id) === 'diamond')
    const discardableDiamondIds = zhangShipingDiscardableDiamonds(host.state, ownerId)
    const poolIds = horseCardsInPublicPools(host.state)
    const mode2Targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && horseEquipmentOf(target, host.state).length)
    const mode3Targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length >= 2
      && owner.zones.hand.some((id) => {
        const slot = host.state.cards[id]?.equipmentSlot
        return (slot === 'offensiveHorse' || slot === 'defensiveHorse') && horseSlotsOf(host.state, target.id).includes(slot)
      }))
    const options = [
      ...(discardableDiamondIds.length && poolIds.length ? [{ id: 'pool', label: '弃置方块牌，随机获得等量坐骑牌' }] : []),
      ...(handDiamondIds.length && mode2Targets.length ? [{ id: 'steal', label: '交给一名角色一张方块牌，获得其一张坐骑牌' }] : []),
      ...(mode3Targets.length ? [{ id: 'equip', label: '将一张坐骑牌置入一名角色装备区，其交给你两张手牌' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: ZHANGSHIPING_ZAOMAO, ownerId, step: 'mode', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【驵贸】：选择一项', timeoutMs: 25_000, optional: true,
      options: [...options, { id: 'cancel', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'equip-give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const giver = p(host.state, targetId)
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => giver?.zones.hand.includes(id)).slice(0, 2)
      if (giver?.alive && p(host.state, ownerId)?.alive && ids.length === 2) giveCards(host, targetId, ownerId, ids, ZHANGSHIPING_ZAOMAO)
      return
    }
    const owner = p(host.state, ownerId)
    if (!owner?.alive || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play') return
    const data = s(host)
    const countEntry = data.b62ZaomaoUses?.[ownerId]
    const count = countEntry?.phaseKey === currentPhaseKey(host.state) ? countEntry.count : 0
    if (count >= 3) return
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId: string }).optionId
      if (mode === 'cancel') return
      data.b62ZaomaoUses ??= {}
      data.b62ZaomaoUses[ownerId] = { phaseKey: currentPhaseKey(host.state), count: count + 1 }
      if (mode === 'pool') {
        const ids = zhangShipingDiscardableDiamonds(host.state, ownerId)
        const max = Math.min(ids.length, horseCardsInPublicPools(host.state).length)
        if (!max) return
        askCards(host, ownerId, ZHANGSHIPING_ZAOMAO, 'pool-cost', '【驵贸】：选择任意张方块牌弃置', ids, 1, max)
      } else if (mode === 'steal') {
        const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && horseEquipmentOf(target, host.state).length)
        if (targets.length) askTargets(host, ownerId, ZHANGSHIPING_ZAOMAO, 'steal-target', '【驵贸】：选择一名有坐骑牌的其他角色', targets.map(({ id }) => id), 1, 1)
      } else if (mode === 'equip') {
        const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length >= 2
          && owner.zones.hand.some((id) => {
            const slot = host.state.cards[id]?.equipmentSlot
            return (slot === 'offensiveHorse' || slot === 'defensiveHorse') && horseSlotsOf(host.state, target.id).includes(slot)
          }))
        if (targets.length) askTargets(host, ownerId, ZHANGSHIPING_ZAOMAO, 'equip-target', '【驵贸】：选择一名能装备坐骑牌的其他角色', targets.map(({ id }) => id), 1, 1)
      }
      return
    }
    if (resolution.step === 'pool-cost') {
      const validDiamonds = new Set(zhangShipingDiscardableDiamonds(host.state, ownerId))
      const ids = [...new Set((response.payload as { cardIds: CardId[] }).cardIds)].filter((id) => validDiamonds.has(id))
      if (!ids.length) return
      discardCardsByIds(host as never, ownerId, ids, ZHANGSHIPING_ZAOMAO)
      const available = horseCardsInPublicPools(host.state)
      const count = Math.min(ids.length, available.length)
      for (let index = 0; index < count; index += 1) {
        const pool = horseCardsInPublicPools(host.state)
        if (!pool.length) break
        const cardId = host.rng.pick(pool)
        if (!cardId) break
        const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
        moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHANGSHIPING_ZAOMAO }, { targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step === 'steal-target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const target = p(host.state, targetId)
      const diamonds = owner.zones.hand.filter((id) => effectiveCardSuit(host.state, ownerId, id) === 'diamond')
      if (!target?.alive || !horseEquipmentOf(target, host.state).length || !diamonds.length) return
      askCards(host, ownerId, ZHANGSHIPING_ZAOMAO, 'steal-give', `【驵贸】：交给${target.nickname}一张方块手牌`, diamonds, 1, 1, { targetId })
      return
    }
    if (resolution.step === 'steal-give') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = p(host.state, targetId)
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId) || effectiveCardSuit(host.state, ownerId, cardId) !== 'diamond') return
      if (!giveCards(host, ownerId, targetId, [cardId], ZHANGSHIPING_ZAOMAO).length) return
      const mounts = horseEquipmentOf(target, host.state)
      if (!mounts.length) return
      askOption(host, ownerId, ZHANGSHIPING_ZAOMAO, 'steal-card', `【驵贸】：获得${target.nickname}装备区的一张坐骑牌`, mounts.map(({ cardId: id }) => ({ id, label: `获得【${host.state.cards[id]?.name ?? '坐骑'}】` })), { targetId, mounts })
      return
    }
    if (resolution.step === 'steal-card') {
      const { targetId, mounts } = resolution.data as { targetId: PlayerId; mounts: Array<{ cardId: CardId; slot: EquipmentSlot }> }
      const target = p(host.state, targetId)
      const cardId = (response.payload as { optionId: CardId }).optionId
      const mount = mounts.find((entry) => entry.cardId === cardId)
      if (!target?.alive || !mount || target.zones.equipment[mount.slot] !== cardId) return
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot: mount.slot }, { kind: 'hand', playerId: ownerId })
      handleEquipmentLost(host, targetId, cardId)
      host.dispatch('CardMove', { cardId, reason: ZHANGSHIPING_ZAOMAO }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHANGSHIPING_ZAOMAO }, { targetId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'equip-target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const target = p(host.state, targetId)
      if (!target?.alive || targetId === ownerId || target.zones.hand.length < 2) return
      const slots = horseSlotsOf(host.state, targetId)
      const cards = owner.zones.hand.filter((id) => {
        const slot = host.state.cards[id]?.equipmentSlot
        return (slot === 'offensiveHorse' || slot === 'defensiveHorse') && slots.includes(slot)
      })
      if (cards.length) askCards(host, ownerId, ZHANGSHIPING_ZAOMAO, 'equip-card', `【驵贸】：选择一张坐骑牌置入${target.nickname}的装备区`, cards, 1, 1, { targetId })
      return
    }
    if (resolution.step === 'equip-card') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = p(host.state, targetId)
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      const slot = host.state.cards[cardId]?.equipmentSlot
      if (!target?.alive || target.zones.hand.length < 2 || !owner.zones.hand.includes(cardId)
        || (slot !== 'offensiveHorse' && slot !== 'defensiveHorse') || !horseSlotsOf(host.state, targetId).includes(slot)) return
      const replaced = target.zones.equipment[slot]
      if (replaced) moveCard(host.state, replaced, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'equipment', playerId: targetId, slot })
      if (replaced) handleEquipmentLost(host, targetId, replaced)
      host.dispatch('CardMove', { cardId, reason: ZHANGSHIPING_ZAOMAO }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.askSkill({ skillId: ZHANGSHIPING_ZAOMAO, ownerId, step: 'equip-give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【驵贸】：交给张世平两张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }) })
    }
  },
})

registerSkillRuntime({ id: DUANJIONG_SAOGU,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = p(host.state, ownerId)
    const targets = host.state.players.some((player) => player.alive && player.id !== ownerId)
    const costs = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)) : []
    if (!owner?.alive || event.playerId !== ownerId || event.phase !== 'finish' || !targets || !costs.length) return
    askOption(host, ownerId, DUANJIONG_SAOGU, 'end-invoke', '【扫谷】：是否弃置一张牌令一名其他角色执行当前项？', [
      { id: 'yes', label: '弃置一张牌并令其执行' }, { id: 'no', label: '不发动' },
    ], { stance: s(host).b62DuanjiongYin?.[ownerId] ? 'yin' : 'yang' })
  } }, { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; reason?: string }
    if (!payload.cardId || payload.fromPlayerId !== ownerId || payload.reason !== 'discard'
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const suit = effectiveCardSuit(host.state, ownerId, payload.cardId)
    const record = s(host).b62DuanjiongDiscardedSuits ??= {}
    const previous = record[ownerId]?.phaseKey === currentPhaseKey(host.state) ? record[ownerId]!.suits : []
    record[ownerId] = { phaseKey: currentPhaseKey(host.state), suits: [...new Set([...previous, suit])] }
  } }],
  activeActions(state, ownerId) {
    const owner = p(state, ownerId)
    const yin = (state as Batch62State).b62DuanjiongYin?.[ownerId] ?? false
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    if (yin) return [{ id: `${DUANJIONG_SAOGU}:yin`, label: '扫谷：摸一张牌' }]
    const discarded = (state as Batch62State).b62DuanjiongDiscardedSuits?.[ownerId]
    const suits = discarded?.phaseKey === currentPhaseKey(state) ? discarded.suits : []
    const candidates = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(state, ownerId, id, ownerId)
      && !suits.includes(effectiveCardSuit(state, ownerId, id)) && state.cards[id]?.name === '杀'
      && declaredCardActions(state, ownerId, id, '杀', '【扫谷】目标检查', { ignoreSlashQuota: true })
        .some((action) => action.kind === 'use-card' && action.targetIds.length === 1))
    const costs = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    return candidates.length > 0 && costs.some((id) => !isCardProtectedFromDiscard(state, ownerId, id, ownerId)
      && !suits.includes(effectiveCardSuit(state, ownerId, id)) && !candidates.includes(id))
      ? [{ id: `${DUANJIONG_SAOGU}:yang`, label: '扫谷：弃置两张牌并使用其中的【杀】' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId === `${DUANJIONG_SAOGU}:yin`) {
      if (!(s(host).b62DuanjiongYin?.[ownerId] ?? false) || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play') return
      host.dispatch('SkillActivated', { skillId: DUANJIONG_SAOGU, skillName: '扫谷' }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
      ;(s(host).b62DuanjiongYin ??= {})[ownerId] = false
      return
    }
    if (actionId !== `${DUANJIONG_SAOGU}:yang` || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play') return
    const owner = p(host.state, ownerId)
    const data = s(host)
    const previous = data.b62DuanjiongDiscardedSuits?.[ownerId]
    const excluded = previous?.phaseKey === currentPhaseKey(host.state) ? previous.suits : []
    const eligible = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)
        && !excluded.includes(effectiveCardSuit(host.state, ownerId, id))) : []
    const eligibleSlashIds = eligible.filter((id) => host.state.cards[id]?.name === '杀'
      && declaredCardActions(host.state, ownerId, id, '杀', '【扫谷】目标检查', { ignoreSlashQuota: true })
        .some((action) => action.kind === 'use-card' && action.targetIds.length === 1))
    if (!eligibleSlashIds.length || eligible.length < 2) return
    host.askSkill({ skillId: DUANJIONG_SAOGU, ownerId, step: 'discard-slash', data: { actorId: ownerId, fromEndPhase: false }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【扫谷】：选择两张本阶段未弃置过花色的牌，其中必须有一张【杀】',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 2, max: 2,
    }) })
  },
  extraSlashTargets() { return 0 },
  resume(host, ownerId, resolution, response) {
    const data = s(host)
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard-slash') {
      const actorId = (resolution.data as { actorId?: PlayerId }).actorId ?? ownerId
      const actor = p(host.state, actorId)
      if (!actor?.alive) return
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => actor.zones.hand.includes(id)
        || Object.values(actor.zones.equipment).includes(id))
      const slashId = ids.find((id) => actor.zones.hand.includes(id) && host.state.cards[id]?.name === '杀')
      if (ids.length !== 2 || !slashId || new Set(ids).size !== 2) return
      const prior = data.b62DuanjiongDiscardedSuits?.[actorId]
      const excluded = prior?.phaseKey === currentPhaseKey(host.state) ? prior.suits : []
      if (ids.some((id) => isCardProtectedFromDiscard(host.state, actorId, id, actorId)
        || excluded.includes(effectiveCardSuit(host.state, actorId, id)))) return
      const actions = declaredCardActions(host.state, actorId, slashId, '杀', '【扫谷】使用此【杀】', { sourceSkillId: DUANJIONG_SAOGU, ignoreSlashQuota: true })
        .filter((action) => action.kind === 'use-card' && action.targetIds.length === 1)
      const legalTargetSets = actions.map((action) => action.kind === 'use-card' ? action.targetIds : [])
      const targetIds = [...new Set(legalTargetSets.flat())]
      if (!targetIds.length) return
      discardCardsByIds(host as never, actorId, ids, DUANJIONG_SAOGU)
      if (actorId === ownerId) {
        data.b62DuanjiongYin ??= {}
        data.b62DuanjiongYin[ownerId] = true
      }
      askTargets(host, ownerId, DUANJIONG_SAOGU, 'slash-targets', '【扫谷】：选择此【杀】的目标', targetIds, 1, 1, { slashId, legalTargetSets, actorId, fromEndPhase: (resolution.data as { fromEndPhase?: boolean }).fromEndPhase })
      return
    }
    if (resolution.step === 'slash-targets') {
      const { slashId, legalTargetSets } = resolution.data as { slashId: CardId; legalTargetSets: PlayerId[][] }
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!targetId || !legalTargetSets.some((candidate) => candidate[0] === targetId)
        || !host.state.zones.discardPile.includes(slashId)) return
      const actorId = (resolution.data as { actorId?: PlayerId }).actorId ?? ownerId
      host.beginSkillSlashFromDiscard({ sourceId: actorId, cardId: slashId, targetId, sourceSkillId: DUANJIONG_SAOGU })
      return
    }
    if (resolution.step === 'end-invoke') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (!cardIds.length) return
      askCards(host, ownerId, DUANJIONG_SAOGU, 'end-cost', '【扫谷】：弃置一张牌', cardIds, 1, 1, resolution.data as Record<string, unknown>)
      return
    }
    if (resolution.step === 'end-cost') {
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      if (!cardId || (!owner.zones.hand.includes(cardId) && !Object.values(owner.zones.equipment).includes(cardId))
        || isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId)) return
      discardCardsByIds(host as never, ownerId, [cardId], DUANJIONG_SAOGU)
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id)
      if (targets.length) askTargets(host, ownerId, DUANJIONG_SAOGU, 'end-target', '【扫谷】：选择一名其他角色执行当前项', targets, 1, 1,
        { stance: s(host).b62DuanjiongYin?.[ownerId] ? 'yin' : 'yang' })
      return
    }
    if (resolution.step === 'end-target') {
      const { stance } = resolution.data as { stance: 'yin' | 'yang' }
      const actorId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const actor = p(host.state, actorId)
      if (!actor?.alive || actorId === ownerId) return
      if (stance === 'yin') {
        drawCards(host.state, host.rng, actorId, 1, host.dispatch.bind(host))
        ;(data.b62DuanjiongYin ??= {})[ownerId] = false
        return
      }
      const previous = data.b62DuanjiongDiscardedSuits?.[actorId]
      const excluded = previous?.phaseKey === currentPhaseKey(host.state) ? previous.suits : []
      const eligible = [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((id) => !isCardProtectedFromDiscard(host.state, actorId, id, actorId)
          && !excluded.includes(effectiveCardSuit(host.state, actorId, id)))
      const slashIds = actor.zones.hand.filter((id) => eligible.includes(id) && host.state.cards[id]?.name === '杀'
        && declaredCardActions(host.state, actorId, id, '杀', '【扫谷】目标检查', { ignoreSlashQuota: true })
          .some((action) => action.kind === 'use-card' && action.targetIds.length === 1))
      if (!slashIds.length || eligible.length < 2) return
      ;(data.b62DuanjiongYin ??= {})[ownerId] = true
      host.askSkill({ skillId: DUANJIONG_SAOGU, ownerId, step: 'discard-slash', data: { actorId, fromEndPhase: true }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: '【扫谷】：选择两张未弃置过花色的牌，其中必须有一张【杀】',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 2, max: 2,
      }) })
    }
  },
})

function startSunCeDuelAt(host: SkillHost, ownerId: PlayerId): void {
  const run = s(host).b62SunceResolution?.[ownerId]
  if (!run || run.halted || !p(host.state, ownerId)?.alive || !p(host.state, run.targetId)?.alive) {
    finishSunCeLiantao(host, ownerId)
    return
  }
  while (run.index < run.cardIds.length) {
    const cardId = run.cardIds[run.index++]!
    if (!p(host.state, ownerId)!.zones.hand.includes(cardId)) continue
    run.activeCardId = cardId
    if (host.beginVirtualTrick({ sourceId: ownerId, targetId: run.targetId, cardName: '决斗', sourceSkillId: SUNCE_LIANTAO, cardId })) return
    run.activeCardId = undefined
  }
  finishSunCeLiantao(host, ownerId)
}

function finishSunCeLiantao(host: SkillHost, ownerId: PlayerId): void {
  const run = s(host).b62SunceResolution?.[ownerId]
  if (!run) return
  delete s(host).b62SunceResolution![ownerId]
  if (run.damage > 0) {
    drawCards(host.state, host.rng, ownerId, run.damage, host.dispatch.bind(host))
    return
  }
  if (!p(host.state, ownerId)?.alive) return
  drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
  ;(s(host).b62SunceNoSlash ??= {})[ownerId] = host.state.turnNumber
  ;(s(host).b62SunceMaxCardsBonus ??= {})[ownerId] = host.state.turnNumber
}

registerSkillRuntime({ id: SUNCE_LIANTAO,
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '杀'
      && (state as Batch62State).b62SunceNoSlash?.[ownerId] === state.turnNumber
  },
  prohibitsOwnResponse(state, ownerId, cardName) {
    return cardName === '杀' && (state as Batch62State).b62SunceNoSlash?.[ownerId] === state.turnNumber
  },
  maxCardsBonus(state, ownerId) {
    return (state as Batch62State).b62SunceMaxCardsBonus?.[ownerId] === state.turnNumber ? 1 : 0
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId !== ownerId || event.phase !== 'play' || !p(host.state, ownerId)?.alive) return
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id)
      if (targets.length) askTargets(host, ownerId, SUNCE_LIANTAO, 'target', '【连讨】：选择一名其他角色', targets, 1, 1)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const run = s(host).b62SunceResolution?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId; finalAmount?: number }
      if (!run || payload.cardId !== run.activeCardId || context.event.sourceId !== ownerId || context.event.targetId !== run.targetId) return
      run.damage += Math.max(0, payload.finalAmount ?? 0)
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      const run = s(host).b62SunceResolution?.[ownerId]
      if (!run) return
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId === ownerId || playerId === run.targetId) run.halted = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const run = s(host).b62SunceResolution?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      if (!run || context.event.sourceId !== ownerId || payload.cardId !== run.activeCardId) return
      run.activeCardId = undefined
      if (run.halted) finishSunCeLiantao(host, ownerId)
      else startSunCeDuelAt(host, ownerId)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const target = p(host.state, targetId)
      if (!target?.alive || targetId === ownerId) return
      host.dispatch('SkillActivated', { skillId: SUNCE_LIANTAO, skillName: '连讨' }, { sourceId: ownerId, targetId })
      host.askSkill({ skillId: SUNCE_LIANTAO, ownerId, step: 'color', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId, prompt: '【连讨】：选择一种颜色', timeoutMs: 25_000, optional: false,
        options: [{ id: 'red', label: '红色' }, { id: 'black', label: '黑色' }],
      }) })
      return
    }
    if (resolution.step !== 'color') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const color = (response.payload as { optionId: string }).optionId
    if ((color !== 'red' && color !== 'black') || !p(host.state, targetId)?.alive) return
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    const cardIds = [...owner.zones.hand].filter((cardId) => effectiveCardColor(host.state, ownerId, cardId) === color)
    host.dispatch('SkillActivated', { skillId: SUNCE_LIANTAO, skillName: '连讨', shownCardIds: [...owner.zones.hand], color }, { sourceId: ownerId, targetId, cardIds: [...owner.zones.hand] })
    ;(s(host).b62SunceResolution ??= {})[ownerId] = { targetId, color, damage: 0, cardIds, index: 0 }
    startSunCeDuelAt(host, ownerId)
  },
})

registerSkillRuntime({ id: LUBOSHE_FUSHI,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; virtual?: boolean }
    const sourceId = context.event.sourceId
    const cardId = payload.cardId
    const owner = p(host.state, ownerId)
    const source = sourceId ? p(host.state, sourceId) : undefined
    if (!owner?.alive || !source?.alive || payload.cardName !== '杀' || payload.virtual || !cardId
      || !host.state.zones.discardPile.includes(cardId) || getDistance(host.state, ownerId, source.id) > 1) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: LUBOSHE_FUSHI })
  } }, { event: 'AfterCardUse', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId && s(host).b62LubosheSlashAdjustments) delete s(host).b62LubosheSlashAdjustments![cardId]
  } }],
  activeActions(state, ownerId) {
    const owner = p(state, ownerId)
    const pile = owner?.characterPiles[LUBOSHE_FUSHI] ?? []
    const slashAvailable = lubosheSlashAvailable(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && pile.length > 0
      && (slashAvailable
        ? state.players.some((target) => lubosheCanTarget(state, ownerId, target.id))
        : pile.length >= 2 && lubosheFreeTargetPairs(state, ownerId).length > 0)
      ? [{ id: LUBOSHE_FUSHI, label: '缚豕：弃置“缚豕”牌并使用强化【杀】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LUBOSHE_FUSHI || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play') return
    const pile = p(host.state, ownerId)?.characterPiles[LUBOSHE_FUSHI] ?? []
    const max = Math.min(3, pile.length)
    const min = lubosheSlashAvailable(host.state, ownerId) ? 1 : 2
    if (max < min || (!lubosheSlashAvailable(host.state, ownerId) && !lubosheFreeTargetPairs(host.state, ownerId).length)) return
    host.askSkill({ skillId: LUBOSHE_FUSHI, ownerId, step: 'cost', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【缚豕】：选择1至3张“缚豕”牌置入弃牌堆并摸等量牌',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...pile], hiddenCardSlots: [], min, max,
    }) })
  },
  outgoingDamage(state, _ownerId, context) {
    const delta = (state as Batch62State).b62LubosheSlashAdjustments?.[context.cardId ?? '']?.[context.targetId]
    return delta === undefined ? null : { amount: Math.max(0, context.amount + delta) }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const owner = p(host.state, ownerId)
      const picked = (response.payload as { cardIds: CardId[] }).cardIds
      if (!owner?.alive || picked.length < 1 || picked.length > 3 || new Set(picked).size !== picked.length
        || picked.some((id) => !owner.characterPiles[LUBOSHE_FUSHI]?.includes(id))) return
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: LUBOSHE_FUSHI }, { kind: 'discardPile' })
      drawCards(host.state, host.rng, ownerId, picked.length, host.dispatch.bind(host))
      const slashAvailable = lubosheSlashAvailable(host.state, ownerId)
      const effects = !slashAvailable && picked.length === 2
        ? [{ id: '1', label: '目标数+1' }, { id: '2', label: '对一个目标造成的伤害-1' }]
        : !slashAvailable
          ? [{ id: '1', label: '目标数+1' }, { id: '2', label: '对一个目标造成的伤害-1' }, { id: '3', label: '对一个目标造成的伤害+1' }]
          : [{ id: '1', label: '目标数+1' }, { id: '2', label: '对一个目标造成的伤害-1' }, { id: '3', label: '对一个目标造成的伤害+1' }]
      host.askSkill({ skillId: LUBOSHE_FUSHI, ownerId, step: 'effects', data: { count: picked.length, slashAvailable }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: `【缚豕】：选择${picked.length}项效果`, timeoutMs: 25_000,
        optional: false, options: effects, min: picked.length, max: picked.length,
      }) })
      return
    }
    if (resolution.step === 'effects') {
      const options = (response.payload as { optionIds: string[] }).optionIds
      const { count, slashAvailable } = resolution.data as { count: number; slashAvailable: boolean }
      if (options.length !== count || new Set(options).size !== count || options.some((id) => !['1', '2', '3'].includes(id))) return
      const candidates = host.state.players.filter((target) => lubosheCanTarget(host.state, ownerId, target.id)).map(({ id }) => id)
      if (!slashAvailable && (count < 2 || !options.includes('1')
        || !options.map(Number).sort((a, b) => a - b).every((n, i, all) => i === 0 || n === all[i - 1]! + 1))) return
      const firstCandidates = !slashAvailable
        ? [...new Set(lubosheFreeTargetPairs(host.state, ownerId).flatMap((pair) => pair))]
        : candidates
      host.askSkill({ skillId: LUBOSHE_FUSHI, ownerId, step: 'targets', data: { options, slashAvailable }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【缚豕】：选择【杀】的首个目标', timeoutMs: 25_000,
        optional: false, candidateIds: firstCandidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'targets') {
      const { options, slashAvailable } = resolution.data as { options: string[]; slashAvailable: boolean }
      const firstTargetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!firstTargetId || !lubosheCanTarget(host.state, ownerId, firstTargetId)) return
      const maxTargets = options.includes('1') ? 2 : 1
      if (maxTargets === 1) {
        const adjustments: Record<PlayerId, number> = {}
        if (!options.includes('2') && !options.includes('3')) { startLubosheSlash(host, ownerId, options, [firstTargetId], adjustments); return }
        const modOptions = options.filter((id) => id === '2' || id === '3')
        askLubosheModifierTarget(host, ownerId, options, [firstTargetId], modOptions, 0, adjustments)
        return
      }
      const secondCandidates = host.state.players.filter((target) => target.id !== firstTargetId
        && lubosheCanTarget(host.state, ownerId, target.id)
        && (slashAvailable || getSeatDistance(host.state, firstTargetId, target.id) === 1)).map(({ id }) => id)
      if (!secondCandidates.length) return
      host.askSkill({ skillId: LUBOSHE_FUSHI, ownerId, step: 'second-target', data: { options, firstTargetId, slashAvailable }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【缚豕】：选择【杀】的另一名目标', timeoutMs: 25_000,
        optional: false, candidateIds: secondCandidates, min: 1, max: 1,
      }) })
    }
    if (resolution.step === 'second-target') {
      const { options, firstTargetId, slashAvailable } = resolution.data as { options: string[]; firstTargetId: PlayerId; slashAvailable: boolean }
      const secondTargetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const targetIds = [firstTargetId, secondTargetId]
      if (!secondTargetId || !lubosheCanTarget(host.state, ownerId, secondTargetId)
        || (!slashAvailable && !areAdjacentTargets(host.state, targetIds))) return
      const adjustments: Record<PlayerId, number> = {}
      if (!options.includes('2') && !options.includes('3')) { startLubosheSlash(host, ownerId, options, targetIds, adjustments); return }
      const modOptions = options.filter((id) => id === '2' || id === '3')
      askLubosheModifierTarget(host, ownerId, options, targetIds, modOptions, 0, adjustments)
    }
    if (resolution.step === 'modifier-target') {
      const data = resolution.data as { options: string[]; targetIds: PlayerId[]; modOptions: string[]; modIndex: number; adjustments: Record<PlayerId, number> }
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!data.targetIds.includes(targetId)) return
      data.adjustments[targetId] = (data.adjustments[targetId] ?? 0) + (data.modOptions[data.modIndex] === '2' ? -1 : 1)
      if (data.modIndex + 1 < data.modOptions.length) askLubosheModifierTarget(host, ownerId, data.options, data.targetIds, data.modOptions, data.modIndex + 1, data.adjustments)
      else startLubosheSlash(host, ownerId, data.options, data.targetIds, data.adjustments)
    }
  },
})

registerSkillRuntime({ id: LUBOSHE_DONGDAO,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const mode = s(host).b62LandlordMode
    const endingId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!mode || !endingId || !mode.farmerIds.includes(endingId) || !p(host.state, ownerId)?.alive) return
    const stance = s(host).b62LubosheStance?.[ownerId] ?? 'yang'
    const destinationId = stance === 'yang' ? mode.landlordId : endingId
    if (!p(host.state, destinationId)?.alive) return
    const promptPlayerId = stance === 'yang' ? ownerId : endingId
    host.askSkill({ skillId: LUBOSHE_DONGDAO, ownerId, step: 'extra-turn', data: { destinationId, stance }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: promptPlayerId,
      prompt: stance === 'yang' ? '【东道】：是否令地主执行一个额外回合？' : '【东道】：是否执行一个额外回合？',
      timeoutMs: 25_000, optional: true, options: [
        { id: 'yes', label: '执行额外回合' }, { id: 'no', label: '不执行' },
      ],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'extra-turn') return
    const { destinationId, stance } = resolution.data as { destinationId: PlayerId; stance: 'yang' | 'yin' }
    if ((response.payload as { optionId: string }).optionId !== 'yes' || !p(host.state, destinationId)?.alive) return
    queueExtraTurn(host.state, destinationId, { skillId: LUBOSHE_DONGDAO, playerId: ownerId })
    ;(s(host).b62LubosheStance ??= {})[ownerId] = stance === 'yang' ? 'yin' : 'yang'
    host.dispatch('SkillActivated', { skillId: LUBOSHE_DONGDAO, skillName: '东道', result: 'extra-turn', stance }, { sourceId: ownerId, targetId: destinationId })
  },
})

function askLubosheModifierTarget(host: SkillHost, ownerId: PlayerId, options: string[], targetIds: PlayerId[], modOptions: string[], modIndex: number, adjustments: Record<PlayerId, number>): void {
  host.askSkill({ skillId: LUBOSHE_FUSHI, ownerId, step: 'modifier-target', data: { options, targetIds, modOptions, modIndex, adjustments }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: `【缚豕】：选择选项${modOptions[modIndex]}对应的目标`, timeoutMs: 25_000,
    optional: false, candidateIds: targetIds, min: 1, max: 1,
  }) })
}

function startLubosheSlash(host: SkillHost, ownerId: PlayerId, options: string[], targetIds: PlayerId[], adjustments: Record<PlayerId, number>): void {
  const consecutiveOptions = options.length > 1 && options.map(Number).sort((a, b) => a - b).every((n, i, all) => i === 0 || n === all[i - 1]! + 1)
  const free = targetIds.length > 1 && areAdjacentTargets(host.state, targetIds) && consecutiveOptions
  const cardId = createVirtualSlashCard(host.state, ownerId, LUBOSHE_FUSHI)
  ;(s(host).b62LubosheSlashAdjustments ??= {})[cardId] = adjustments
  if (host.beginVirtualSlash({ sourceId: ownerId, targetIds, maxTargets: targetIds.length, sourceSkillId: LUBOSHE_FUSHI, cardId, countUsage: !free })) {
    return
  }
  delete s(host).b62LubosheSlashAdjustments![cardId]
  const owner = p(host.state, ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId)
  delete host.state.cards[cardId]
}

registerSkillRuntime({ id: DINGSHANGWAN_FUDIAO,
  onGameStart(host, ownerId) {
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    drawCards(host.state, host.rng, ownerId, 3, host.dispatch.bind(host))
    const discardable = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId).map(({ id }) => id)
    if (!candidates.length) {
      askCards(host, ownerId, DINGSHANGWAN_FUDIAO, 'setup-discard', '【抚悼】：弃置任意张手牌并记录手牌数', discardable, 0, discardable.length)
      return
    }
    askTargets(host, ownerId, DINGSHANGWAN_FUDIAO, 'setup-target', '【抚悼】：选择一名其他角色交给其至多三张手牌', candidates, 1, 1)
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const owner = p(host.state, ownerId)
    const endingId = (context.event.payload as { playerId?: PlayerId }).playerId
    const ending = endingId ? p(host.state, endingId) : undefined
    const recorded = s(host).b62DingshangwanHandCount?.[ownerId]
    if (!owner?.alive || !ending?.alive || recorded === undefined || ending.zones.hand.length !== recorded) return
    askOption(host, ownerId, DINGSHANGWAN_FUDIAO, 'turn-end', `【抚悼】：${ending.nickname}的手牌数为${recorded}，是否与其各摸一张牌？`, [
      { id: 'yes', label: '与其各摸一张牌' }, { id: 'no', label: '不发动' },
    ], { endingId, turnNumber: host.state.turnNumber })
  } }],
  resume(host, ownerId, resolution, response) {
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'setup-target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      if (!targetId || !p(host.state, targetId)?.alive) return
      const cardIds = [...owner.zones.hand]
      askCards(host, ownerId, DINGSHANGWAN_FUDIAO, 'setup-give', '【抚悼】：选择交给该角色的至多三张手牌', cardIds, 0, Math.min(3, cardIds.length), { targetId })
      return
    }
    if (resolution.step === 'setup-give') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => owner.zones.hand.includes(id)).slice(0, 3)
      if (ids.length && p(host.state, targetId)?.alive) giveCards(host, ownerId, targetId, ids, DINGSHANGWAN_FUDIAO)
      const remaining = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      askCards(host, ownerId, DINGSHANGWAN_FUDIAO, 'setup-discard', '【抚悼】：弃置任意张手牌，然后记录手牌数', remaining, 0, remaining.length)
      return
    }
    if (resolution.step === 'setup-discard') {
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => owner.zones.hand.includes(id)
        && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId))
      if (ids.length) discardCardsByIds(host as never, ownerId, ids, DINGSHANGWAN_FUDIAO)
      ;(s(host).b62DingshangwanHandCount ??= {})[ownerId] = owner.zones.hand.length
      return
    }
    if (resolution.step === 'turn-end') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      const target = p(host.state, (resolution.data as { endingId: PlayerId }).endingId)
      if (!target?.alive || target.zones.hand.length !== s(host).b62DingshangwanHandCount?.[ownerId]) return
      drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
      drawCards(host.state, host.rng, target.id, 1, host.dispatch.bind(host))
    }
  },
})

registerSkillRuntime({ id: DINGSHANGWAN_FENGYAN,
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
      host.queueSkill({ skillId: DINGSHANGWAN_FENGYAN, ownerId, step: 'choice', data: { actorId: context.event.sourceId, reason: 'damage' } })
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const responder = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      const actorId = context.event.targetId
      if (responder !== ownerId || !actorId || actorId === ownerId) return
      host.queueSkill({ skillId: DINGSHANGWAN_FENGYAN, ownerId, step: 'choice', data: { actorId, reason: 'response' } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const actorId = (prompt.data as { actorId?: PlayerId }).actorId
    if (!actorId || !p(host.state, actorId)?.alive || !p(host.state, ownerId)?.alive) return
    askOption(host, ownerId, DINGSHANGWAN_FENGYAN, 'choice', '【讽言】：选择一项', [
      { id: 'give', label: '你摸一张牌，然后交给其一张牌' },
      { id: 'discard', label: '其摸一张牌，然后弃置两张牌' },
    ], { actorId }, false)
  },
  resume(host, ownerId, resolution, response) {
    const actorId = (resolution.data as { actorId?: PlayerId }).actorId
    const owner = p(host.state, ownerId)
    const actor = actorId ? p(host.state, actorId) : undefined
    if (resolution.step === 'choice') {
      if (!owner?.alive || !actor?.alive) return
      if ((response.payload as { optionId: string }).optionId === 'give') {
        drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
        if (!owner.zones.hand.length) return
        askCards(host, ownerId, DINGSHANGWAN_FENGYAN, 'give-card', `【讽言】：交给${actor.nickname}一张手牌`, [...owner.zones.hand], 1, 1, { actorId })
      } else {
        drawCards(host.state, host.rng, actor.id, 1, host.dispatch.bind(host))
        const discardable = actor.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, actor.id, id, ownerId))
        const count = Math.min(2, discardable.length)
        if (!count) return
        askCards(host, ownerId, DINGSHANGWAN_FENGYAN, 'discard-cards', `【讽言】：弃置${actor.nickname}两张手牌`, discardable, count, count, { actorId })
      }
      return
    }
    if (!owner?.alive || !actor?.alive) return
    if (resolution.step === 'give-card') {
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds[0]
      if (cardId && owner.zones.hand.includes(cardId)) giveCards(host, ownerId, actor.id, [cardId], DINGSHANGWAN_FENGYAN)
    } else if (resolution.step === 'discard-cards') {
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => actor.zones.hand.includes(id)
        && !isCardProtectedFromDiscard(host.state, actor.id, id, ownerId)).slice(0, 2)
      if (ids.length) discardCardsByIds(host as never, actor.id, ids, DINGSHANGWAN_FENGYAN)
    }
  },
})

registerSkillRuntime({ id: LIWAN_LIANJU,
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const userId = context.event.sourceId
      if (!userId) return
      const cardId = context.event.cardIds?.[0]
      const color = cardId ? effectiveCardColor(host.state, userId, cardId) : null
      if (!cardId || (color !== 'red' && color !== 'black')) return
      const uses = (s(host).b62LiwanUsedCards ??= {})[userId] ??= []
      uses.push({ turnNumber: host.state.turnNumber, cardId, color })
    } },
    { event: 'TurnStart', handle(host, _ownerId) {
      const data = s(host)
      for (const [playerId, uses] of Object.entries(data.b62LiwanUsedCards ?? {})) {
        data.b62LiwanUsedCards![playerId] = uses.filter((entry) => entry.turnNumber === host.state.turnNumber)
      }
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !p(host.state, ownerId)?.alive) return
      const drawn = drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
      if (drawn.length) (s(host).b62LiwanMarks ??= {})[drawn[0]!] = ownerId
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string; fromPlayerId?: PlayerId | null; reason?: string }
      if (!payload.cardId || payload.fromKind !== 'hand' || !payload.fromPlayerId || payload.reason !== 'discard'
        || (s(host).b62LiwanMarks?.[payload.cardId] !== ownerId)) return
      const source = p(host.state, payload.fromPlayerId)
      if (!source?.alive || !host.state.zones.discardPile.includes(payload.cardId)) return
      delete s(host).b62LiwanMarks![payload.cardId]
      moveCard(host.state, payload.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: source.id })
      host.dispatch('GainCard', { playerId: source.id, cardIds: [payload.cardId], reason: LIWAN_SILU }, { targetId: source.id, cardIds: [payload.cardId] })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || !payload.playerId || !p(host.state, ownerId)?.alive) return
      if (payload.playerId !== ownerId) {
        const delayed = s(host).b62LiwanDelayed ?? []
        const due = delayed.filter((entry) => entry.ownerId === ownerId && entry.targetId === payload.playerId
          && host.state.turnNumber > entry.sourceTurn)
        if (!due.length) return
        s(host).b62LiwanDelayed = delayed.filter((entry) => !due.includes(entry))
        const target = p(host.state, payload.playerId)
        if (!target?.alive) return
        const colors = new Set(due.map((entry) => entry.color === 'red' ? 'black' : 'red'))
        const cardIds = [...new Set((s(host).b62LiwanUsedCards?.[target.id] ?? [])
          .filter((entry) => entry.turnNumber === host.state.turnNumber && colors.has(entry.color)
            && host.state.zones.discardPile.includes(entry.cardId))
          .map((entry) => entry.cardId))]
        if (cardIds.length) host.queueSkill({ skillId: LIWAN_LIANJU, ownerId, step: 'take-next-turn-cards', data: { targetId: target.id, cardIds } })
        return
      }
      const uses = (s(host).b62LiwanUsedCards?.[ownerId] ?? []).filter((entry) => entry.turnNumber === host.state.turnNumber
        && host.state.zones.discardPile.includes(entry.cardId))
      const red = uses.filter((entry) => entry.color === 'red')
      const black = uses.filter((entry) => entry.color === 'black')
      if (!red.length && !black.length) return
      const options = [ ...(red.length ? [{ id: 'red', label: '选择本回合使用的红色牌' }] : []), ...(black.length ? [{ id: 'black', label: '选择本回合使用的黑色牌' }] : []) ]
      askOption(host, ownerId, LIWAN_LIANJU, 'choose-color', '【联句】：令一名其他角色获得弃牌堆中本回合你使用的至多两张同色牌', options, { turnNumber: host.state.turnNumber })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take-next-turn-cards') return
    const { targetId, cardIds } = prompt.data as { targetId: PlayerId; cardIds: CardId[] }
    const target = p(host.state, targetId)
    const owner = p(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    const legalIds = cardIds.filter((id) => host.state.zones.discardPile.includes(id))
    if (!legalIds.length) return
    askCards(host, ownerId, LIWAN_LIANJU, 'take-next-turn-cards', `【联句】：获得${target.nickname}本回合使用并进入弃牌堆的至多两张另一颜色牌`, legalIds, 0, Math.min(2, legalIds.length))
  },
  resume(host, ownerId, resolution, response) {
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'choose-color') {
      const color = (response.payload as { optionId: 'red' | 'black' }).optionId
      const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId).map(({ id }) => id)
      const cardIds = (s(host).b62LiwanUsedCards?.[ownerId] ?? []).filter((entry) => entry.turnNumber === host.state.turnNumber && entry.color === color && host.state.zones.discardPile.includes(entry.cardId)).map(({ cardId }) => cardId)
      if (!candidates.length || !cardIds.length) return
      askTargets(host, ownerId, LIWAN_LIANJU, 'choose-target', '【联句】：选择一名角色获得这些牌', candidates, 1, 1, { color, cardIds })
      return
    }
    if (resolution.step === 'choose-target') {
      const { color, cardIds } = resolution.data as { color: 'red' | 'black'; cardIds: CardId[] }
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds[0]
      const target = p(host.state, targetId)
      if (!target?.alive) return
      askCards(host, ownerId, LIWAN_LIANJU, 'take-used-cards', `【联句】：选择弃牌堆中至多两张${color === 'red' ? '红色' : '黑色'}牌给${target.nickname}`, cardIds.filter((id) => host.state.zones.discardPile.includes(id)), 0, 2, { color, targetId, sourceTurn: host.state.turnNumber })
      return
    }
    if (resolution.step === 'take-used-cards') {
      const { color, targetId, sourceTurn } = resolution.data as { color: 'red' | 'black'; targetId: PlayerId; sourceTurn: number }
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => host.state.zones.discardPile.includes(id)
        && effectiveCardColor(host.state, ownerId, id) === color).slice(0, 2)
      for (const id of ids) {
        moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
        ;(s(host).b62LiwanMarks ??= {})[id] = ownerId
      }
      if (ids.length) host.dispatch('GainCard', { playerId: targetId, cardIds: ids, reason: LIWAN_LIANJU }, { targetId, cardIds: ids })
      if (ids.length) (s(host).b62LiwanDelayed ??= []).push({ ownerId, targetId, color, sourceTurn })
      return
    }
    if (resolution.step === 'take-next-turn-cards') {
      const ids = (response.payload as { cardIds: CardId[] }).cardIds.filter((id) => host.state.zones.discardPile.includes(id)).slice(0, 2)
      for (const id of ids) {
        moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        ;(s(host).b62LiwanMarks ??= {})[id] = ownerId
      }
      if (ids.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: ids, reason: LIWAN_LIANJU }, { targetId: ownerId, cardIds: ids })
    }
  },
})

registerSkillRuntime({ id: LIWAN_SILU })
registerSkillRuntime({ id: LIYI_ZHANJIN, virtualWeapon(state, ownerId) {
  return p(state, ownerId)?.alive && weaponCardsOf(state, ownerId).length === 0 ? '贯石斧' : null
} })
registerSkillRuntime({ id: YADAN_TIELUN,
  distanceModifier: { toOthers: (state, ownerId) => -((state as Batch62State).b62YadanRoundUses?.[ownerId] ?? 0) },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) { (s(host).b62YadanRoundUses ??= {})[ownerId] = 0 } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const counts = s(host).b62YadanRoundUses ??= {}
      counts[ownerId] = (counts[ownerId] ?? 0) + 1
    } },
  ],
})

function yadanBetweenPlayers(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): PlayerId[] {
  const living = state.players.filter((player) => player.alive).sort((left, right) => left.seat - right.seat)
  const ownerIndex = living.findIndex((player) => player.id === ownerId)
  const targetIndex = living.findIndex((player) => player.id === targetId)
  if (ownerIndex < 0 || targetIndex < 0 || ownerIndex === targetIndex) return []
  const clockwise = (targetIndex - ownerIndex + living.length) % living.length
  const counterclockwise = living.length - clockwise
  const paths = clockwise === counterclockwise ? [1, -1] : clockwise < counterclockwise ? [1] : [-1]
  const between = new Set<PlayerId>()
  for (const direction of paths) {
    const steps = direction === 1 ? clockwise : counterclockwise
    for (let step = 1; step < steps; step += 1) {
      const index = (ownerIndex + direction * step + living.length) % living.length
      between.add(living[index]!.id)
    }
  }
  return [...between]
}

function finishYadanSlash(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, cardIds: CardId[]): void {
  const owner = p(host.state, ownerId)
  if (!owner?.alive) return
  if (cardIds.length) (s(host).b62YadanDeferredCards ??= {})[ownerId] ??= []
  if (cardIds.length) s(host).b62YadanDeferredCards![ownerId]!.push({ cardIds: [...cardIds], afterSeq: host.state.seq })
  executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
}

registerSkillRuntime({ id: YADAN_QINGYA,
  interceptPlayAction(host, ownerId, action) {
    if (action.kind !== 'use-card' || action.playerId !== ownerId || action.asCardName !== '杀' || action.targetIds.length !== 1) return false
    const intermediates = yadanBetweenPlayers(host.state, ownerId, action.targetIds[0]!)
      .filter((id) => (p(host.state, id)?.zones.hand.length ?? 0) > 0)
    if (!intermediates.length) return false
    host.askSkill({ skillId: YADAN_QINGYA, ownerId, step: 'invoke', data: { action, intermediates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【倾轧】：是否弃置你与此【杀】目标之间角色各一张手牌，并于本回合下个阶段结束时使用其中一张？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动【倾轧】' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    if (payload.playerId !== ownerId || !p(host.state, ownerId)?.alive) return
    const deferred = s(host).b62YadanDeferredCards ??= {}
    const batches = deferred[ownerId] ?? []
    const due = batches.filter((batch) => batch.afterSeq < context.event.seq)
    deferred[ownerId] = batches.filter((batch) => !due.includes(batch))
    for (const batch of due) {
      const cardIds = batch.cardIds.filter((cardId) => (p(host.state, ownerId)?.characterPiles[YADAN_QINGYA_PILE] ?? []).includes(cardId))
      if (cardIds.length) host.queueSkill({ skillId: YADAN_QINGYA, ownerId, step: 'deferred-use', data: { cardIds } })
    }
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'deferred-use') return
    const cardIds = (prompt.data as { cardIds: CardId[] }).cardIds
      .filter((cardId) => (p(host.state, ownerId)?.characterPiles[YADAN_QINGYA_PILE] ?? []).includes(cardId))
    const actions = cardIds.flatMap((cardId) => characterPileCardUseActions(host.state, ownerId, ownerId, cardId, YADAN_QINGYA))
    if (!actions.length) {
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YADAN_QINGYA_PILE }, { kind: 'discardPile' })
      return
    }
    askOption(host, ownerId, YADAN_QINGYA, 'deferred-choice', '【倾轧】：选择使用其中一张牌或放弃', [
      ...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'pass', label: '放弃使用' },
    ], { cardIds, actions }, false)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { action?: Extract<LegalAction, { kind: 'use-card' }>; intermediates?: PlayerId[]; index?: number; cardIds?: CardId[]; actions?: LegalAction[] }
    if (resolution.step === 'invoke') {
      const action = data.action
      if (!action) return
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      advanceYadanDiscard(host, ownerId, action, data.intermediates ?? [], 0, [])
      return
    }
    if (resolution.step === 'discard-between') {
      const action = data.action!
      const intermediates = data.intermediates ?? []
      const index = data.index ?? 0
      const targetId = intermediates[index]!
      const target = p(host.state, targetId)
      const selection = (response.payload as { cardIds: string[] }).cardIds[0]
      const cardId = target && selection ? resolvePickedCard(host.state, targetId, selection) : null
      const taken: CardId[] = [...(data.cardIds ?? [])]
      if (cardId && target?.zones.hand.includes(cardId) && !isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' }, { discardReason: 'discard' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: YADAN_QINGYA }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        if (host.state.zones.discardPile.includes(cardId)) {
          moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: YADAN_QINGYA_PILE })
          taken.push(cardId)
        }
      }
      advanceYadanDiscard(host, ownerId, action, intermediates, index + 1, taken)
      return
    }
    if (resolution.step === 'deferred-choice') {
      const { cardIds = [], actions = [] } = data
      const optionId = (response.payload as { optionId: string }).optionId
      const action = actions.find((candidate) => candidate.kind === 'use-card' && candidate.id === optionId)
      const usedCardId = action?.kind === 'use-card' ? action.cardIds[0] : null
      const owner = p(host.state, ownerId)
      if (action && usedCardId && owner?.characterPiles[YADAN_QINGYA_PILE]?.includes(usedCardId)
        && characterPileCardUseActions(host.state, ownerId, ownerId, usedCardId, YADAN_QINGYA).some((candidate) => candidate.id === action.id)) {
        for (const cardId of cardIds) if (cardId !== usedCardId && owner.characterPiles[YADAN_QINGYA_PILE]?.includes(cardId))
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YADAN_QINGYA_PILE }, { kind: 'discardPile' })
        host.performSkillCardAction({ playerId: ownerId, cardOwnerId: ownerId, cardId: usedCardId, sourceSkillId: YADAN_QINGYA, actionId: action.id })
      } else {
        for (const cardId of cardIds) if (owner?.characterPiles[YADAN_QINGYA_PILE]?.includes(cardId))
          moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YADAN_QINGYA_PILE }, { kind: 'discardPile' })
      }
    }
  },
})

function advanceYadanDiscard(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, intermediates: PlayerId[], index: number, cardIds: CardId[]): void {
  while (index < intermediates.length) {
    const targetId = intermediates[index]!
    const target = p(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) { index += 1; continue }
    host.askSkill({ skillId: YADAN_QINGYA, ownerId, step: 'discard-between', data: { action, intermediates, index, cardIds }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【倾轧】：暗选${target.nickname}的一张手牌弃置`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: target.zones.hand.map((_, slot) => hiddenHandSlot(targetId, slot)), min: 1, max: 1,
    }) })
    return
  }
  finishYadanSlash(host, ownerId, action, cardIds)
}

function liupanCardIsEligible(state: SanguoshaState, action: LegalAction): action is Extract<LegalAction, { kind: 'use-card' }> {
  if (action.kind !== 'use-card' || action.targetIds.length === 0) return false
  const card = state.cards[action.cardIds[0]]
  return Boolean(card && (card.category === 'basic'
    || (card.category === 'trick' && !DELAYED_TRICKS.has(action.asCardName))))
}

function liupanTargets(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, step: string, candidateIds: PlayerId[], max: number, data: Record<string, unknown>): void {
  askTargets(host, ownerId, LIUPAN_PIJING, step, '【披荆】：选择至多X名角色使其成为或不再成为此牌目标', candidateIds, 0, max, { action, ...data })
}

function finishLiupan(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, addIds: PlayerId[], removeIds: PlayerId[]): void {
  const data = s(host)
  const originalTargets = action.targetIds
  const finalTargets = originalTargets.filter((id) => !removeIds.includes(id)).concat(addIds)
  const affected = [...new Set([...addIds, ...removeIds])]
  for (const targetId of affected) {
    const target = p(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) continue
    const cardId = host.rng.pick(target.zones.hand)
    if (cardId) giveCards(host, targetId, ownerId, [cardId], LIUPAN_PIJING)
    const beneficiaries = data.b62LiupanBeneficiaries ??= {}
    beneficiaries[targetId] = [...new Set([...(beneficiaries[targetId] ?? []), ownerId])]
  }
  executeUseCardAction(host as never, ownerId, { ...action, targetIds: finalTargets.length ? finalTargets : originalTargets }, { skipPlayInterceptors: true })
}

registerSkillRuntime({ id: LIUPAN_PIJING,
  interceptPlayAction(host, ownerId, action) {
    if (!liupanCardIsEligible(host.state, action)) return false
    const state = s(host)
    const beneficiaries = state.b62LiupanBeneficiaries?.[action.playerId] ?? []
    if (action.playerId !== ownerId && action.targetIds.length === 1 && beneficiaries.includes(ownerId)) {
      const liupan = p(host.state, ownerId)
    if (!liupan?.alive || isTargetProhibited(host.state, action.playerId, ownerId, action.asCardName, characterSkillIdsOf, action.cardIds[0])) {
        state.b62LiupanBeneficiaries![action.playerId] = beneficiaries.filter((id) => id !== ownerId)
        executeUseCardAction(host as never, action.playerId, action, { skipPlayInterceptors: true })
        return true
      }
      host.askSkill({ skillId: LIUPAN_PIJING, ownerId, step: 'benefit-choice', data: { action, actorId: action.playerId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: action.playerId, prompt: `${liupan.nickname}的【披荆】效果：选择一项`, timeoutMs: 25_000, optional: false,
        options: [{ id: 'extra-target', label: `令${liupan.nickname}成为此牌额外目标` }, { id: 'draw-owner', label: `令${liupan.nickname}摸一张牌` }],
      }) })
      return true
    }
    if (action.playerId !== ownerId || state.b62LiupanUsedTurn?.[ownerId] === host.state.turnNumber) return false
    const available = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length > 0)
    if (!available.length) return false
    host.askSkill({ skillId: LIUPAN_PIJING, ownerId, step: 'invoke', data: { action }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '是否发动【披荆】？选择至多X名其他角色使其成为或不再成为此牌目标，并随机获得其一张手牌', timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '发动【披荆】' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const data = s(host)
    if (resolution.step === 'benefit-choice') {
      const actorId = (resolution.data as { actorId: PlayerId }).actorId
      const action = (resolution.data as { action: Extract<LegalAction, { kind: 'use-card' }> }).action
      const beneficiaries = data.b62LiupanBeneficiaries?.[actorId] ?? []
      if (!p(host.state, actorId)?.alive || !p(host.state, ownerId)?.alive || !beneficiaries.includes(ownerId)) return
      data.b62LiupanBeneficiaries![actorId] = beneficiaries.filter((id) => id !== ownerId)
      if ((response.payload as { optionId: string }).optionId === 'extra-target') {
        executeUseCardAction(host as never, actorId, { ...action, targetIds: [...action.targetIds, ownerId] }, { skipPlayInterceptors: true })
      } else {
        drawCards(host.state, host.rng, ownerId, 1, host.dispatch.bind(host))
        executeUseCardAction(host as never, actorId, action, { skipPlayInterceptors: true })
      }
      return
    }
    const action = (resolution.data as { action: Extract<LegalAction, { kind: 'use-card' }> }).action
    const owner = p(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') {
        executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
        return
      }
      data.b62LiupanUsedTurn ??= {}
      data.b62LiupanUsedTurn[ownerId] = host.state.turnNumber
      const cardId = action.cardIds[0]
      const validTargets = declaredCardActions(host.state, ownerId, cardId, action.asCardName, '披荆目标').flatMap((candidate) => candidate.kind === 'use-card' ? candidate.targetIds : [])
      const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && target.zones.hand.length > 0
        && (action.targetIds.includes(target.id) || validTargets.includes(target.id))).map(({ id }) => id)
      const maximum = Math.min(Math.max(1, owner.maxHp - owner.hp), candidates.length)
      if (!maximum) { executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true }); return }
      const addCandidates = candidates.filter((id) => !action.targetIds.includes(id))
      if (addCandidates.length) {
        liupanTargets(host, ownerId, action, 'select-add', addCandidates, maximum, { maximum })
      } else {
        const removeCandidates = action.targetIds.filter((id) => p(host.state, id)?.alive && p(host.state, id)!.zones.hand.length > 0)
        const removeMax = Math.min(maximum, Math.max(0, action.targetIds.length - 1))
        if (removeCandidates.length && removeMax > 0) askTargets(host, ownerId, LIUPAN_PIJING, 'select-remove', '【披荆】：选择至多X名当前目标令其不再成为此牌目标', removeCandidates, 0, removeMax,
          { action, addIds: [], maximum })
        else finishLiupan(host, ownerId, action, [], [])
      }
      return
    }
    if (resolution.step === 'select-add') {
      const addIds = (response.payload as { targetIds: PlayerId[] }).targetIds.filter((id) => p(host.state, id)?.alive
        && p(host.state, id)!.zones.hand.length > 0 && !action.targetIds.includes(id))
      const maximum = (resolution.data as { maximum: number }).maximum
      const removeCandidates = action.targetIds.filter((id) => p(host.state, id)?.alive && p(host.state, id)!.zones.hand.length > 0)
      const removeMax = Math.min(maximum - addIds.length, Math.max(0, action.targetIds.length + addIds.length - 1))
      if (!removeCandidates.length || removeMax <= 0) {
        finishLiupan(host, ownerId, action, addIds, [])
        return
      }
      askTargets(host, ownerId, LIUPAN_PIJING, 'select-remove', '【披荆】：选择至多X名当前目标令其不再成为此牌目标', removeCandidates, 0, removeMax,
        { action, addIds, maximum })
      return
    }
    if (resolution.step === 'select-remove') {
      const addIds = (resolution.data as { addIds: PlayerId[] }).addIds
      const removeIds = (response.payload as { targetIds: PlayerId[] }).targetIds
      finishLiupan(host, ownerId, action, addIds, removeIds)
    }
  },
})

registerSkillRuntime({ id: MAWAN_MASHU, distanceModifier: { toOthers: -1 } })
registerSkillRuntime({
  id: MAWAN_HUNJIANG,
  activeActions(state, ownerId) {
    const owner = p(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, MAWAN_HUNJIANG)) return []
    const targets = state.players.filter((target) => target.alive && target.id !== ownerId && getDistance(state, ownerId, target.id) <= getAttackRange(state, ownerId))
    return targets.length ? [{ id: MAWAN_HUNJIANG, label: '浑疆：令攻击范围内角色同时选择' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== MAWAN_HUNJIANG) return
    const owner = p(host.state, ownerId)
    if (!owner?.alive || ownerId !== host.state.currentPlayerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, MAWAN_HUNJIANG)) return
    const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId))
    if (!targets.length) return
    markUsedThisPhase(host.state, ownerId, MAWAN_HUNJIANG)
    host.dispatch('SkillActivated', { skillId: MAWAN_HUNJIANG, skillName: '浑疆' }, { sourceId: ownerId })
    askTargets(host, ownerId, MAWAN_HUNJIANG, 'targets', '【浑疆】：选择任意名攻击范围内的其他角色同时决定', targets.map(({ id }) => id), 1, targets.length)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds.filter((id) => p(host.state, id)?.alive)
    if (!targetIds.length) return
    const hostOwner = p(host.state, ownerId)
    if (!hostOwner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
    startGroupDecision(host, { id: `${resolution.requestId}:choice`, tag: HUNJIANG_GROUP, skillId: MAWAN_HUNJIANG, playerIds: targetIds,
      prompt: '【浑疆】：选择一项：本阶段成为马玩【杀】的额外目标，或令马玩摸一张牌',
      options: [{ id: 'slash-target', label: '本阶段成为其【杀】的额外目标' }, { id: 'draw', label: '令马玩摸一张牌' }],
      defaultOptionId: 'draw', timeoutMs: 25_000, data: { ownerId } })
  },
  extraSlashTargets(state, ownerId) {
    const entry = (state as Batch62State).b62MaWanTargets?.[ownerId]
    return entry?.phaseKey === currentPhaseKey(state) ? entry.targetIds.length : 0
  },
  extraSlashTargetIds(state, ownerId) {
    const entry = (state as Batch62State).b62MaWanTargets?.[ownerId]
    return entry?.phaseKey === currentPhaseKey(state) ? entry.targetIds : []
  },
})

export const ZHANG_SHIPING_B62: CharacterDefinition = {
  id: 'zhang-shiping-b62', name: '张世平', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGSHIPING_BINJI, name: '镔济', description: '每轮开始时，你可摸3张牌然后交给至多三名其他角色各1张牌；这些角色失去这些牌时从牌堆或弃牌堆随机获得1张武器牌，然后你摸1张牌。' },
    { id: ZHANGSHIPING_ZAOMAO, name: '驵贸', description: '出牌阶段限三次，你可以：1.弃置任意张方块牌，然后从牌堆或弃牌堆随机获得等量张坐骑牌；2.交给一名其他角色1张方块牌，然后获得其装备区1张坐骑牌；3.将1张坐骑牌置入一名其他角色装备区，然后其交给你2张手牌。' },
  ],
}
export const DUAN_JIONG_B62: CharacterDefinition = { id: 'duan-jiong-b62', name: '段颎', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: DUANJIONG_SAOGU, name: '扫谷', description: '转换技，出牌阶段，阳：你可以弃置两张牌（不能包含你本阶段弃置过的花色），使用其中的【杀】；阴：你可以摸一张牌。结束阶段，你可以弃置一张牌令一名其他角色执行当前项。' }] }
export const MA_WAN_B62: CharacterDefinition = { id: 'ma-wan-b62', name: '马玩', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: MAWAN_MASHU, name: '马术', locked: true, description: '锁定技，你计算与其他角色的距离-1。' }, { id: MAWAN_HUNJIANG, name: '浑疆', description: '出牌阶段限一次，你可以令攻击范围内任意名其他角色同时选择一项：1.令你本阶段使用【杀】可以指定其为额外目标；2.令你摸一张牌。若这些角色皆选择了同一项，也须执行另一项。' }] }
export const DING_SHANGWAN_B62: CharacterDefinition = { id: 'ding-shangwan-b62', name: '丁尚涴', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: DINGSHANGWAN_FUDIAO, name: '抚悼', description: '游戏开始时，你摸三张牌，交给一名其他角色至多三张手牌，弃置任意张手牌，然后记录你的手牌数。每回合结束时，若当前回合角色手牌数等于此数值，你可以与其各摸一张牌。' }, { id: DINGSHANGWAN_FENGYAN, name: '讽言', locked: true, description: '锁定技，当你受到其他角色的伤害，或响应其他角色的牌后，你选择一项：1.摸一张牌并交给其一张牌；2.其摸一张牌并弃置两张牌。' }] }
export const LI_WAN_B62: CharacterDefinition = { id: 'li-wan-b62', name: '李婉', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: LIWAN_LIANJU, name: '联句', description: '结束阶段，你可以令一名其他角色获得弃牌堆中本回合你使用的至多两张颜色相同的牌，然后其下个结束阶段，你可获得弃牌堆中该回合其使用的至多两张另一种颜色的牌。' }, { id: LIWAN_SILU, name: '思闾', locked: true, description: '锁定技，因“联句”获得的牌称为“闾”；当你受到伤害后，你摸一张牌并称为“闾”。“闾”因弃置进入弃牌堆后，失去此牌的角色获得之。' }] }
export const YA_DAN_B62: CharacterDefinition = { id: 'ya-dan-b62', name: '雅丹', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: YADAN_QINGYA, name: '倾轧', description: '当你使用【杀】指定唯一目标后，你可以弃置你与其之间的角色各一张手牌，然后可以于本回合下个阶段结束时使用其中一张牌。' }, { id: YADAN_TIELUN, name: '铁轮', locked: true, description: '锁定技，你计算与其他角色的距离-X（X为你本轮使用的牌数）。' }] }
export const LI_YI_B62: CharacterDefinition = { id: 'li-yi-b62', name: '李异', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: LIYI_CHANSHUANG, name: '缠双', description: '出牌阶段限一次，你可以与一名其他角色同时选择一项执行：1.重铸一张牌；2.使用一张【杀】；3.弃置两张牌。结束阶段，你依次执行X项（X为你本回合以任意方式执行过的项数）。' }, { id: LIYI_ZHANJIN, name: '蘸金', locked: true, description: '锁定技，若你的装备区里没有武器牌，你视为装备着【贯石斧】。' }] }
export const LIU_PAN_B62: CharacterDefinition = { id: 'liu-pan-b62', name: '刘磐', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: LIUPAN_PIJING, name: '披荆', description: '每回合限一次，当你使用【杀】或普通锦囊牌指定目标后，你可以令至多X名其他角色成为或不成为此牌目标并随机交给你一张牌（X为你已损失体力值且至少为1），这些角色下次使用基本牌或普通锦囊牌指定唯一目标时，可指定你为额外目标或摸一张牌。' }] }
export const SP_SUN_CE_B62: CharacterDefinition = { id: 'sp-sun-ce-b62', name: 'SP·孙策', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: SUNCE_LIANTAO, name: '连讨', description: '出牌阶段开始时，你可令一名其他角色选择一种颜色，然后你展示所有手牌，并依次将此颜色的手牌当【决斗】对其使用直到有一方进入濒死状态，然后你摸X张牌（X为你以此法对目标角色造成的伤害数）。若该角色没有因此受到伤害，你摸一张牌，本回合手牌上限+1且本回合不能使用【杀】。' }] }

export const HISTORICAL_BATCH62_CHARACTERS: readonly CharacterDefinition[] = [ZHANG_SHIPING_B62, DUAN_JIONG_B62, MA_WAN_B62, DING_SHANGWAN_B62, LI_WAN_B62, YA_DAN_B62, LI_YI_B62, LIU_PAN_B62, SP_SUN_CE_B62, SP_LIU_BEI_B62]
