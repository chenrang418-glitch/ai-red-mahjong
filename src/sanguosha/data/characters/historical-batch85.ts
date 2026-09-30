import type { CharacterDefinition } from './types'
import type { CardCategory, CardId, PlayerId, Suit, SanguoshaState } from '../../engine/types'
import { effectiveCardColor, prohibitsBeingPindianTargetOf, registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, UseCardRequest } from '../../engine/requests'
import type { LegalAction } from '../../engine/actions'
import type { EventContext } from '../../engine/events'
import { executeUseCardAction, resumeCardTarget, skillHandCardUseActions, skillOtherHandCardUseActions } from '../../engine/cards/basic'
import { drawCards } from '../../engine/draw'
import { resolveDamage, resolveDamageSequence, resumeDamageModifier, killPlayer, continueDyingAssists } from '../../engine/damage'
import { discardCardsByIds } from '../../engine/discard-all'
import { moveCard } from '../../engine/zones'
import { pickableCardsOf } from '../../engine/card-pick'
import { resolvePickedCard } from '../../engine/card-pick'
import { isCardProtectedFromDiscard } from '../../engine/skills/runtime'
import { maxCardsOf } from '../../engine/phase'
import { ruleCardNumber, reshuffleDrawPile } from '../../engine/deck'
import { usedThisPhase, markUsedThisPhase } from '../../engine/phase-usage'
import { locateOwnedCard } from '../../engine/zones'
import { notifyHandCardLeft } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { dispatchEquipmentZoneLoss } from '../../engine/equipment-zone-loss'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { giveOwnedCards, giveCards } from '../../engine/hand-transfer'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { phaseSlotOf } from '../../engine/phase-replacement'
import { canPindian, claimPindianCards, continuePindianCardSelection, finishPindianSettlement, startPindian, registerPindianContinuation, type PindianResult } from '../../engine/pindian'
import { getDistance } from '../../engine/distance'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { effectiveKingdomOf } from '../../engine/huashen'

const B = '-b85'
const sid = (name: string) => `${name}${B}`
const HANS_HIDDEN = sid('yinbi-hansong')
const HANS_LUYAN = sid('luyan-hansong')
const YANLIANG_JIZHAN = sid('jizhan-xingyanliang')
const YANLIANG_CUXIA = sid('cuxia-xingyanliang')
const SUYUE_GONGTU = sid('gongtu-suyue')
const SUYUE_HANGZHU = sid('hangzhu-suyue')
const GUOTIYING_KANYU = sid('kanyu-guotiying')
const GUOTIYING_ZHE = sid('zhe-e-guotiying')
const HUANJIE_JIANLI = sid('jianli-huanjie')
const HUANJIE_QINGZHENG = sid('qingzheng-huanjie')
const CUILIE_ZIJUE = sid('zijue-cuilie')
const CUILIE_CHIBI = sid('chibi-cuilie')
const WEICAO_DUOYUE = sid('duoyue-weicao')
const WEICAO_JUNHE = sid('junhe-weicao')
const WEICAO_XIONGWEI = sid('xiongwei-weicao')
const MOJIANG_MINGFANG = sid('mingfang-mojianggan')
const MOJIANG_JIBIAN = sid('jibian-mojianggan')
const CHUNYU_LINGSHU = sid('lingshu-chunyukiong')
const CHUNYU_KANGKANG = sid('kang-kang-chunyukiong')
const WELIUBEI_LIEXIANG = sid('liexiang-weiliubei')
const WELIUBEI_RENGOU = sid('rengou-weiliubei')
const CUILIE_CHIBI_TAG = sid('chibi-pindian-cuilie')
const DAMAGE_TRICKS = new Set(['南蛮入侵', '万箭齐发', '决斗', '火攻'])

type JunheState = { remaining: number; criterion: 'color' | 'category'; value: string }
function junheStates(state: SanguoshaState, ownerId: PlayerId): JunheState[] {
  return (b85(state).junhe?.[ownerId] ?? []) as JunheState[]
}
function matchesJunhe(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, record: JunheState): boolean {
  const card = state.cards[cardId]
  if (!card) return false
  return record.criterion === 'color'
    ? effectiveCardColor(state, ownerId, cardId) === record.value
    : card.category === record.value
}

const alivePlayers = (state: SanguoshaState) => state.players.filter((player) => player.alive)
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((player) => player.id === playerId)
const handCount = (state: SanguoshaState, playerId: PlayerId) => playerOf(state, playerId)?.zones.hand.length ?? 0
function jianliUseCount(state: SanguoshaState, ownerId: PlayerId): number {
  const records = b85(state).jianliUseCount ??= {}
  return Number(records[ownerId] ?? 0)
}
function setJianliUseCount(state: SanguoshaState, ownerId: PlayerId, count: number): void {
  ;(b85(state).jianliUseCount ??= {})[ownerId] = count
}
type JianliFlow = { targetId: PlayerId; cardId?: CardId; dealtDamage: boolean }
function jianliFlows(state: SanguoshaState): Record<PlayerId, JianliFlow> {
  return (b85(state).jianliFlows ??= {}) as Record<PlayerId, JianliFlow>
}
type QingzhengTurn = { turnNumber: number; usedOptions: string[]; unlimitedHandUsage: boolean; unlimitedCardIds: CardId[] }
function qingzhengTurn(state: SanguoshaState, ownerId: PlayerId): QingzhengTurn {
  const records = b85(state).qingzhengTurn ??= {}
  const current = records[ownerId] as QingzhengTurn | undefined
  if (!current || current.turnNumber !== state.turnNumber)
    records[ownerId] = { turnNumber: state.turnNumber, usedOptions: [], unlimitedHandUsage: false, unlimitedCardIds: [] }
  return records[ownerId] as QingzhengTurn
}
function qingzhengValue(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  return owner ? Number(owner.hp === 1) + Number(owner.zones.hand.length === 1)
    + Number(Object.values(owner.zones.equipment).filter(Boolean).length === 1) : 0
}
function b85(state: SanguoshaState): Record<string, any> {
  const extended = state as SanguoshaState & { b85?: Record<string, any> }
  extended.b85 ??= {}
  return extended.b85
}
function cuilieDistance(state: SanguoshaState, ownerId: PlayerId): number {
  const record = b85(state).cuilieDistance?.[ownerId] as { amount: number } | undefined
  return record?.amount ?? 0
}
function chibiUsedThisTurn(state: SanguoshaState, ownerId: PlayerId): boolean {
  return Number(b85(state).chibiUsedTurn?.[ownerId] ?? -1) === state.turnNumber
}
function mingfangRecord(state: SanguoshaState, ownerId: PlayerId): { targetId: PlayerId; cardId: CardId } | undefined {
  return b85(state).mingfang?.[ownerId] as { targetId: PlayerId; cardId: CardId } | undefined
}
const WEICAO_DUOYUE_TAG = sid('duoyue-pindian-weicao')
function beginWeicaoDuoYue(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, attempt = 1): void {
  if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive
    || !handCount(host.state, ownerId) || !handCount(host.state, targetId)) return
  startPindian(host as never, { id: `${WEICAO_DUOYUE}:${host.state.turnNumber}:${attempt}:${ownerId}`,
    initiatorId: ownerId, opponentId: targetId, reason: WEICAO_DUOYUE, continuationTag: WEICAO_DUOYUE_TAG, data: { attempt } })
}
function continueWeicaoDuoYue(host: SkillHost, ownerId: PlayerId, attempt: number): void {
  const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
  if (attempt >= 3 || !playerOf(host.state, ownerId)?.alive || !handCount(host.state, ownerId) || !others.length) {
    finishPindianSettlement(host as never)
    return
  }
  host.askSkill({ skillId: WEICAO_DUOYUE, ownerId, step: 'continue-target', data: { attempt }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: `【掇月】：是否进行第${attempt + 1}次拼点`, timeoutMs: 25_000,
    optional: true, candidateIds: others.map(({ id }) => id), min: 0, max: 1,
  }) })
}
registerPindianContinuation(WEICAO_DUOYUE_TAG, (pindianHost, result: PindianResult) => {
  const host = pindianHost as unknown as SkillHost
  const attempt = Number(result.data.attempt ?? 1)
  const winnerId = result.outcome === 'initiator-win' ? result.initiatorId
    : result.outcome === 'opponent-win' ? result.opponentId : undefined
  const effectOptions: { id: string; label: string }[] = [{ id: 'pass', label: '不发动' }, ...(winnerId ? [{ id: 'draw', label: `令拼点赢的角色摸${attempt}张牌` }] : [])]
  if (result.outcome === 'initiator-win') effectOptions.push({ id: 'damage', label: '改为造成1点伤害并终止后续拼点' })
  host.askSkill({ skillId: WEICAO_DUOYUE, ownerId: result.initiatorId, step: 'choose-effect',
    data: { attempt, winnerId }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: result.initiatorId,
      prompt: `【掇月】：第${attempt}次拼点结算`, timeoutMs: 25_000, optional: false, options: effectOptions }) })
  return 'defer-settlement'
})
type YanliangRound = { roundNumber: number; damagedBy: PlayerId[] }
function yanliangRound(state: SanguoshaState, ownerId: PlayerId): YanliangRound {
  const records = b85(state).yanliangRound ??= {}
  if (!records[ownerId] || records[ownerId].roundNumber !== state.roundNumber)
    records[ownerId] = { roundNumber: state.roundNumber, damagedBy: [] }
  return records[ownerId] as YanliangRound
}
type YanliangAttack = { turnNumber: number; checked: boolean; nonDamageUses: number; cardId?: CardId; targetId?: PlayerId; bonus: number; dealtDamage: boolean }
function yanliangAttack(state: SanguoshaState, ownerId: PlayerId): YanliangAttack {
  const records = b85(state).yanliangAttack ??= {}
  if (!records[ownerId] || records[ownerId].turnNumber !== state.turnNumber)
    records[ownerId] = { turnNumber: state.turnNumber, checked: false, nonDamageUses: 0, bonus: 0, dealtDamage: false }
  return records[ownerId] as YanliangAttack
}
function isYanliangDamageCard(name: string): boolean {
  return name === '杀' || name === '火杀' || name === '雷杀' || DAMAGE_TRICKS.has(name)
}
type GongtuState = { categories?: [CardCategory, CardCategory]; previousCategory?: CardCategory }
function gongtuState(state: SanguoshaState, ownerId: PlayerId): GongtuState {
  const records = b85(state).gongtu ??= {}
  return (records[ownerId] ??= {}) as GongtuState
}
const cardCategories: readonly CardCategory[] = ['basic', 'trick', 'equipment']
const categoryNames: Record<CardCategory, string> = { basic: '基本牌', trick: '锦囊牌', equipment: '装备牌' }
const suyuePileId = (ownerId: PlayerId) => `${SUYUE_HANGZHU}:${ownerId}`
type HangzhuLock = { targetId: PlayerId; ranks: number[] }
function hangzhuLocks(state: SanguoshaState): Record<PlayerId, HangzhuLock> {
  return (b85(state).hangzhuLocks ??= {}) as Record<PlayerId, HangzhuLock>
}

function hangzhuPile(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const pileId = suyuePileId(ownerId)
  owner.characterPiles[pileId] ??= []
  return owner.characterPiles[pileId]!
}

function hangzhuMaterials(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
}

function hangzhuRanks(state: SanguoshaState, ownerId: PlayerId): number[] {
  return [...new Set(hangzhuPile(state, ownerId).map((cardId) => ruleCardNumber(state, cardId)).filter((rank): rank is number => rank !== null))]
}

function placeHangzhuMaterials(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): boolean {
  const owner = playerOf(host.state, ownerId)
  if (!owner || !cardIds.length || new Set(cardIds).size !== cardIds.length) return false
  const locations = cardIds.map((cardId) => locateOwnedCard(host.state, ownerId, cardId))
  if (locations.some((zone) => !zone || (zone.kind !== 'hand' && zone.kind !== 'equipment'))) return false
  const pileId = suyuePileId(ownerId)
  const equipmentIds: CardId[] = []
  for (const [index, cardId] of cardIds.entries()) {
    const zone = locations[index]!
    moveCard(host.state, cardId, zone, { kind: 'characterPile', playerId: ownerId, pile: pileId }, { characterPileMoveReason: 'rule' })
    if (zone.kind === 'hand') notifyHandCardLeft(host.state, { cardId, playerId: ownerId, destination: { kind: 'characterPile', playerId: ownerId, pile: pileId } })
    else equipmentIds.push(cardId)
  }
  for (const cardId of equipmentIds) handleEquipmentLost(host, ownerId, cardId, { batched: true })
  dispatchEquipmentZoneLoss(host, ownerId, equipmentIds)
  host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: SUYUE_HANGZHU }, { sourceId: ownerId, cardIds })
  host.dispatch('CharacterPileMoved', { playerId: ownerId, pile: pileId, cardIds, direction: 'in', reason: SUYUE_HANGZHU },
    { sourceId: ownerId, targetId: ownerId, cardIds })
  return true
}

function resolveHangzhuDuplicateBases(host: SkillHost, ownerId: PlayerId): number {
  const pileId = suyuePileId(ownerId)
  const cards = hangzhuPile(host.state, ownerId)
  const counts = new Map<number, number>()
  for (const cardId of cards) {
    const rank = ruleCardNumber(host.state, cardId)
    if (rank !== null) counts.set(rank, (counts.get(rank) ?? 0) + 1)
  }
  const duplicateRanks = new Set([...counts].filter(([, count]) => count > 1).map(([rank]) => rank))
  if (!duplicateRanks.size) return 0
  const removed = cards.filter((cardId) => duplicateRanks.has(ruleCardNumber(host.state, cardId) ?? -1))
  for (const cardId of removed)
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: pileId }, { kind: 'discardPile' }, { discardReason: 'discard' })
  host.dispatch('CharacterPileMoved', { playerId: ownerId, pile: pileId, cardIds: removed, direction: 'out', reason: 'duplicate-rank' },
    { sourceId: ownerId, targetId: ownerId, cardIds: removed })
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: removed, reason: SUYUE_HANGZHU }, { sourceId: ownerId, cardIds: removed })
  drawCards(host.state, host.rng, ownerId, removed.length, (name, payload) => { host.dispatch(name, payload) })
  return removed.length
}

function grantHangzhuRankLock(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId, ranks: number[]): void {
  hangzhuLocks(state)[ownerId] = { targetId, ranks: [...new Set(ranks)] }
}

registerSkillRuntime({
  id: SUYUE_HANGZHU,
  activeActions(state, ownerId) {
    if (state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || usedThisPhase(state, ownerId, SUYUE_HANGZHU) || !hangzhuMaterials(state, ownerId).length) return []
    return [{ id: `${SUYUE_HANGZHU}:activate`, kind: 'invoke-skill', playerId: ownerId,
      skillId: SUYUE_HANGZHU, cardIds: [], targetIds: [], label: '发动【夯筑】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${SUYUE_HANGZHU}:activate` || usedThisPhase(host.state, ownerId, SUYUE_HANGZHU)) return
    const cardIds = hangzhuMaterials(host.state, ownerId)
    if (!cardIds.length) return
    host.askSkill({ skillId: SUYUE_HANGZHU, ownerId, step: 'choose-materials', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【夯筑】：将任意张手牌或装备牌置为“基”', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: cardIds.length,
    }) })
  },
  globallyProhibitsCardUse(state, ownerId, targetId, cardId) {
    const lock = hangzhuLocks(state)[ownerId]
    const rank = ruleCardNumber(state, cardId)
    return Boolean(lock && lock.targetId === targetId && rank !== null && lock.ranks.includes(rank))
  },
  prohibitsResponseCard(state, ownerId, responderId, cardId) {
    const lock = hangzhuLocks(state)[ownerId]
    const rank = ruleCardNumber(state, cardId)
    return Boolean(lock && lock.targetId === responderId && rank !== null && lock.ranks.includes(rank))
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (playerId === ownerId) delete hangzhuLocks(host.state)[ownerId]
  } }, { event: 'Death', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId) delete hangzhuLocks(host.state)[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { cardIds?: CardId[]; targetIds?: PlayerId[] }
    if (resolution.step === 'choose-materials') {
      const selected = payload.cardIds ?? []
      if (!placeHangzhuMaterials(host, ownerId, selected)) return
      markUsedThisPhase(host.state, ownerId, SUYUE_HANGZHU)
      host.askSkill({ skillId: SUYUE_HANGZHU, ownerId, step: 'choose-target', data: { ranks: selected.map((id) => ruleCardNumber(host.state, id)).filter((rank): rank is number => rank !== null) }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【夯筑】：选择一名其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      const ranks = [...new Set((resolution.data.ranks as number[]).filter((rank) => Number.isInteger(rank)))]
      grantHangzhuRankLock(host.state, ownerId, targetId, ranks)
      const target = playerOf(host.state, targetId)!
      const rankSet = new Set(ranks)
      const matching = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((cardId) => rankSet.has(ruleCardNumber(host.state, cardId) ?? -1)
          && !isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId))
      if (matching.length) discardCardsByIds(host as never, targetId, matching, SUYUE_HANGZHU)
      resolveHangzhuDuplicateBases(host, ownerId)
      if (hangzhuRanks(host.state, ownerId).length === 13) host.askSkill({
        skillId: SUYUE_HANGZHU, ownerId, step: 'gift-bases', data: {}, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【夯筑】：将所有“基”交给一名角色，其回复至体力上限', timeoutMs: 25_000,
          optional: true, candidateIds: host.state.players.filter((player) => player.alive).map(({ id }) => id), min: 1, max: 1,
        }) })
      return
    }
    if (resolution.step === 'gift-bases') {
      const targetId = payload.targetIds?.[0]
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const pileId = suyuePileId(ownerId)
      const cardIds = [...hangzhuPile(host.state, ownerId)]
      for (const cardId of cardIds)
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: pileId }, { kind: 'hand', playerId: targetId })
      host.dispatch('CharacterPileMoved', { playerId: ownerId, pile: pileId, cardIds, direction: 'out', reason: 'gift' },
        { sourceId: ownerId, targetId, cardIds })
      if (cardIds.length) host.dispatch('GainCard', { playerId: targetId, cardIds, reason: SUYUE_HANGZHU }, { sourceId: ownerId, targetId, cardIds })
      if (target.hp < target.maxHp) recover(host as never, targetId, target.maxHp - target.hp, ownerId)
    }
  },
})

function hansongEqualHandCount(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const count = handCount(state, ownerId)
  return alivePlayers(state).filter((player) => player.id !== ownerId && player.zones.hand.length === count).map(({ id }) => id)
}

function hansongPromptDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
  if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
  host.askSkill({ skillId: HANS_LUYAN, ownerId, step: 'choose-discard', data: { targetId }, build: (id): ChooseCardsRequest => ({
    id,
    kind: 'choose-cards',
    playerId: ownerId,
    prompt: '【率言】：弃置其一张牌',
    timeoutMs: 25_000,
    optional: false,
    purpose: 'skill',
    cardIds: pickable.cardIds,
    hiddenCardSlots: pickable.hiddenCardSlots,
    min: 1,
    max: 1,
  }) })
}

function resolveHansongChoice(host: SkillHost, ownerId: PlayerId, optionId: string, targetId?: PlayerId): void {
  if (optionId === 'draw') {
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    return
  }
  if (optionId === 'discard' && targetId && playerOf(host.state, targetId)?.alive) hansongPromptDiscard(host, ownerId, targetId)
}

registerSkillRuntime({
  id: HANS_HIDDEN,
  fixedMaxCards(state, ownerId) {
    const candidates = alivePlayers(state).filter((player) => player.id !== ownerId)
    const ownerHp = playerOf(state, ownerId)?.hp ?? 0
    if (!candidates.length) return ownerHp
    return Math.max(ownerHp, ...candidates.map((player) => maxCardsOf(state, player.id)))
  },
  unlimitedCardUses(state, ownerId) {
    return hansongEqualHandCount(state, ownerId).length === 0
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    return targetId !== ownerId && hansongEqualHandCount(state, ownerId).length === 0
  },
})

registerSkillRuntime({
  id: HANS_LUYAN,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const actorId = payload.playerId
    const phase = payload.phase
    if (!actorId || (phase !== 'draw' && phase !== 'discard') || !playerOf(host.state, ownerId)?.alive) return
    if (actorId === ownerId) {
      const count = alivePlayers(host.state).filter((player) => player.zones.hand.length === handCount(host.state, ownerId)).length
      if (count > 0) host.askSkill({ skillId: HANS_LUYAN, ownerId, step: 'choose-own-draw', data: { count }, build: (id): ChooseOptionRequest => ({
        id,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `【率言】：是否摸${count}张牌？`,
        timeoutMs: 25_000,
        optional: true,
        options: [{ id: 'draw', label: `摸${count}张牌` }],
      }) })
      return
    }
    if (!playerOf(host.state, actorId)?.alive || handCount(host.state, actorId) !== handCount(host.state, ownerId)) return
    const pickable = pickableCardsOf(host.state, actorId, { discarderId: ownerId })
    const options = [{ id: 'draw', label: '摸一张牌' }]
    if (pickable.cardIds.length || pickable.hiddenCardSlots.length) options.push({ id: 'discard', label: '弃置其一张牌' })
    host.askSkill({ skillId: HANS_LUYAN, ownerId, step: 'choose-effect', data: { targetId: actorId }, build: (id): ChooseOptionRequest => ({
      id,
      kind: 'choose-option',
      playerId: ownerId,
      prompt: '【率言】：选择一项',
      timeoutMs: 25_000,
      optional: true,
      options,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (!playerOf(host.state, ownerId)?.alive) return
    const payload = response.payload as { optionId?: string; cardIds?: CardId[] }
    if (resolution.step === 'choose-own-draw') {
      if (payload.optionId === 'draw') drawCards(host.state, host.rng, ownerId, Number(resolution.data.count),
        (name, data) => { host.dispatch(name, data) })
      return
    }
    if (resolution.step === 'choose-effect') {
      const targetId = resolution.data.targetId as PlayerId
      if (playerOf(host.state, targetId)?.alive && handCount(host.state, targetId) === handCount(host.state, ownerId))
        resolveHansongChoice(host, ownerId, payload.optionId ?? '', targetId)
      return
    }
    if (resolution.step === 'choose-discard') {
      const targetId = resolution.data.targetId as PlayerId
      if (!playerOf(host.state, targetId)?.alive || !payload.cardIds?.length) return
      const cardId = resolvePickedCard(host.state, targetId, payload.cardIds[0]!)
      if (!cardId || isCardProtectedFromDiscard(host.state, targetId, cardId, ownerId)) return
      discardCardsByIds(host as never, targetId, [cardId], HANS_LUYAN)
    }
  },
})

registerSkillRuntime({
  id: YANLIANG_CUXIA,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || Number(context.event.payload.finalAmount ?? 0) <= 0) return
      const sourceId = context.event.sourceId
      if (sourceId && sourceId !== ownerId && !yanliangRound(host.state, ownerId).damagedBy.includes(sourceId))
        yanliangRound(host.state, ownerId).damagedBy.push(sourceId)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      const sourceId = context.event.sourceId
      const owner = playerOf(host.state, ownerId)
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!owner?.alive || !source?.alive || source.id === ownerId || !payload.targetIds?.includes(ownerId)) return
      const greaterHp = source.hp > owner.hp
      const damagedThisRound = yanliangRound(host.state, ownerId).damagedBy.includes(source.id)
      if (!greaterHp && !damagedThisRound) return
      if (source.zones.hand.length) {
        const cardId = source.zones.hand[host.rng.nextInt(source.zones.hand.length)]!
        discardCardsByIds(host as never, source.id, [cardId], YANLIANG_CUXIA)
      }
      if (greaterHp && damagedThisRound)
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    } },
  ],
})

registerSkillRuntime({
  id: YANLIANG_JIZHAN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const state = yanliangAttack(host.state, ownerId)
      const cardName = payload.cardName ?? ''
      if (!isYanliangDamageCard(cardName)) {
        state.nonDamageUses += 1
        return
      }
      if (state.checked || !payload.cardId || !payload.targetIds?.length) return
      state.checked = true
      const candidates = payload.targetIds.filter((id) => playerOf(host.state, id)?.alive)
      if (!candidates.length) return
      host.askSkill({ skillId: YANLIANG_JIZHAN, ownerId, step: 'choose-target', data: {
        cardId: payload.cardId, targetIds: candidates, bonus: Math.max(0, 2 - state.nonDamageUses),
      }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【急战】：选择此牌伤害增加${Math.max(0, 2 - state.nonDamageUses)}点的目标`,
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
      }) })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const flow = yanliangAttack(host.state, ownerId)
      const payload = context.event.payload as { cardId?: CardId; finalAmount?: number }
      if (context.event.sourceId === ownerId && flow.cardId === payload.cardId && Number(payload.finalAmount ?? 0) > 0)
        flow.dealtDamage = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const flow = yanliangAttack(host.state, ownerId)
      const payload = context.event.payload as { cardId?: CardId }
      if (!flow.cardId || payload.cardId !== flow.cardId || !flow.targetId) return
      if (!flow.dealtDamage && playerOf(host.state, ownerId)?.alive && playerOf(host.state, flow.targetId)?.alive)
        resolveDamage(host as never, { sourceId: flow.targetId, targetId: ownerId, amount: 1, nature: 'normal', sourceSkillId: YANLIANG_JIZHAN })
      flow.cardId = undefined
      flow.targetId = undefined
      flow.bonus = 0
      flow.dealtDamage = false
    } },
  ],
  outgoingDamage(state, ownerId, context) {
    const flow = yanliangAttack(state, ownerId)
    if (flow.cardId && flow.cardId === context.cardId && flow.targetId === context.targetId && flow.bonus > 0)
      return { amount: context.amount + flow.bonus }
    return null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const validTargets = resolution.data.targetIds as PlayerId[]
    if (!targetId || !validTargets.includes(targetId) || !playerOf(host.state, targetId)?.alive) return
    const flow = yanliangAttack(host.state, ownerId)
    flow.cardId = resolution.data.cardId as CardId
    flow.targetId = targetId
    flow.bonus = Number(resolution.data.bonus)
  },
})

registerSkillRuntime({
  id: SUYUE_GONGTU,
  onGameStart(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: SUYUE_GONGTU, ownerId, step: 'activate', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【宫图】：是否依次选择两种牌类别？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '选择' }],
    }) })
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const selected = gongtuState(host.state, ownerId).categories
    const payload = context.event.payload as { cardId?: CardId }
    const category = payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
    if (!selected || !category) return
    const data = gongtuState(host.state, ownerId)
    if (data.previousCategory === selected[0] && category === selected[1]) {
      if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, value) => { host.dispatch(name, value) })
      const ranks = [...new Set(host.state.zones.drawPile.map((cardId) => ruleCardNumber(host.state, cardId)).filter((rank): rank is number => rank !== null))]
      if (ranks.length >= 2) host.askSkill({ skillId: SUYUE_GONGTU, ownerId, step: 'choose-first-rank', data: { ranks }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【宫图】：选择第一张牌的点数', timeoutMs: 25_000,
        optional: true, options: ranks.map((rank) => ({ id: String(rank), label: `${rank}点` })),
      }) })
    }
    data.previousCategory = category
  } }],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string }
    if (resolution.step === 'activate') {
      if (payload.optionId !== 'yes' || !playerOf(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: SUYUE_GONGTU, ownerId, step: 'choose-first-category', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【宫图】：选择连续使用牌的第一种类别', timeoutMs: 25_000,
        optional: false, options: cardCategories.map((category) => ({ id: category, label: categoryNames[category] })),
      }) })
      return
    }
    if (resolution.step === 'choose-first-category') {
      const first = payload.optionId as CardCategory | undefined
      if (!first || !cardCategories.includes(first)) return
      host.askSkill({ skillId: SUYUE_GONGTU, ownerId, step: 'choose-second-category', data: { first }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【宫图】：选择连续使用牌的第二种类别', timeoutMs: 25_000,
        optional: false, options: cardCategories.map((category) => ({ id: category, label: categoryNames[category] })),
      }) })
      return
    }
    if (resolution.step === 'choose-second-category') {
      const first = resolution.data.first as CardCategory
      const second = payload.optionId as CardCategory | undefined
      if (second && cardCategories.includes(second)) gongtuState(host.state, ownerId).categories = [first, second]
      return
    }
    const ranks = resolution.data.ranks as number[]
    if (resolution.step === 'choose-first-rank') {
      const firstRank = Number(payload.optionId)
      if (!ranks.includes(firstRank)) return
      const candidates = ranks.filter((rank) => rank !== firstRank)
      host.askSkill({ skillId: SUYUE_GONGTU, ownerId, step: 'choose-second-rank', data: { firstRank, candidates }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【宫图】：选择另一种点数', timeoutMs: 25_000,
        optional: false, options: candidates.map((rank) => ({ id: String(rank), label: `${rank}点` })),
      }) })
      return
    }
    if (resolution.step === 'choose-second-rank') {
      const firstRank = Number(resolution.data.firstRank)
      const secondRank = Number(payload.optionId)
      const candidates = resolution.data.candidates as number[]
      if (!candidates.includes(secondRank)) return
      const gained: CardId[] = []
      for (const rank of [firstRank, secondRank]) {
        const cardId = host.state.zones.drawPile.find((candidate) => ruleCardNumber(host.state, candidate) === rank)
        if (!cardId) continue
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        gained.push(cardId)
      }
      if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: SUYUE_GONGTU, isDraw: false }, { targetId: ownerId, cardIds: gained })
    }
  },
})

function placeLightning(host: SkillHost, ownerId: PlayerId, source: 'drawPile' | 'discardPile'): boolean {
  const cardId = (source === 'drawPile' ? host.state.zones.drawPile : host.state.zones.discardPile)
    .find((id) => host.state.cards[id]?.name === '闪电')
  if (!cardId || !playerOf(host.state, ownerId)?.alive) return false
  moveCard(host.state, cardId, { kind: source }, { kind: 'judgingArea', playerId: ownerId })
  host.dispatch('CardMove', { cardIds: [cardId], reason: GUOTIYING_ZHE, from: source, to: 'judgingArea' },
    { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  return true
}

function kanyuOffer(host: SkillHost, ownerId: PlayerId, trigger: string): void {
  if (!playerOf(host.state, ownerId)?.alive) return
  if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
  const top = host.state.zones.drawPile[0]
  const exposed: CardId[] = []
  if (top) {
    moveCard(host.state, top, { kind: 'drawPile' }, { kind: 'processingArea' })
    exposed.push(top)
  }
  const bottom = host.state.zones.drawPile.at(-1)
  if (bottom && bottom !== top) {
    moveCard(host.state, bottom, { kind: 'drawPile' }, { kind: 'processingArea' })
    exposed.push(bottom)
  }
  if (!exposed.length) return
  host.askSkill({ skillId: GUOTIYING_KANYU, ownerId, step: 'choose-gain', data: { trigger, exposed }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【堪舆】：获得其中任意张牌，其余牌以任意顺序置于牌堆顶',
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: exposed, hiddenCardSlots: [], min: 0, max: exposed.length,
  }) })
}

registerSkillRuntime({
  id: GUOTIYING_KANYU,
  triggers: [
    { event: 'JudgeStart', handle(host, ownerId, context) {
      const judgingPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (judgingPlayerId) kanyuOffer(host, ownerId, `judge:${judgingPlayerId}`)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
      if (context.event.targetId === ownerId && amount > 0) kanyuOffer(host, ownerId, 'damage')
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'arrange-top') {
      const remaining = (resolution.data.remaining as CardId[]).filter((cardId) => host.state.zones.processingArea.includes(cardId))
      const top = (response.payload as { top?: CardId[] }).top ?? []
      if (top.length !== remaining.length || new Set(top).size !== remaining.length || top.some((cardId) => !remaining.includes(cardId))) return
      for (const cardId of [...top].reverse()) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    const exposed = (resolution.data.exposed as CardId[]).filter((cardId) => host.state.zones.processingArea.includes(cardId))
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const gained = [...new Set(selected.filter((cardId) => exposed.includes(cardId))) ]
    for (const cardId of gained) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: GUOTIYING_KANYU }, { sourceId: ownerId, targetId: ownerId, cardIds: gained })
    if (gained.length) {
      const state = host.state as SanguoshaState & {
        additionalDelayedTrickHitFaces?: Partial<Record<PlayerId, Partial<Record<string, Array<{ suit: Suit; rank: number }>>>>>
      }
      const faces = state.additionalDelayedTrickHitFaces ??= {}
      const lightningFaces = faces[ownerId] ??= {}
      const extra = lightningFaces['闪电'] ??= []
      for (const cardId of gained) {
        const card = host.state.cards[cardId]
        if (card && !extra.some((face) => face.suit === card.suit && face.rank === card.rank))
          extra.push({ suit: card.suit, rank: card.rank })
      }
    }
    const remaining = exposed.filter((cardId) => !gained.includes(cardId) && host.state.zones.processingArea.includes(cardId))
    if (!remaining.length) return
    host.askSkill({ skillId: GUOTIYING_KANYU, ownerId, step: 'arrange-top', data: { remaining, gained }, build: (id): ArrangeCardsRequest => ({
      id, kind: 'arrange-cards', playerId: ownerId, prompt: '【堪舆】：将其余牌按任意顺序置于牌堆顶（第一张在最上方）',
      timeoutMs: 25_000, optional: false, cardIds: remaining, minTop: remaining.length, maxTop: remaining.length, allowBottom: false,
    }) })
  },
})

registerSkillRuntime({
  id: GUOTIYING_ZHE,
  onGameStart(host, ownerId) {
    placeLightning(host, ownerId, 'drawPile')
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive) return
    placeLightning(host, ownerId, 'discardPile')
  } }],
})

function finishJianli(host: SkillHost, ownerId: PlayerId): void {
  const flow = jianliFlows(host.state)[ownerId]
  if (!flow) return
  delete jianliFlows(host.state)[ownerId]
  if (!flow.dealtDamage && playerOf(host.state, ownerId)?.alive && playerOf(host.state, flow.targetId)?.alive)
    resolveDamage(host as never, { sourceId: flow.targetId, targetId: ownerId, amount: 1, nature: 'normal', reason: HUANJIE_JIANLI })
}

registerSkillRuntime({
  id: HUANJIE_JIANLI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || jianliUseCount(state, ownerId) >= 2
      || !playerOf(state, ownerId)?.alive) return []
    return [{ id: `${HUANJIE_JIANLI}:activate`, label: `发动【谏立】（${2 - jianliUseCount(state, ownerId)}次）` }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${HUANJIE_JIANLI}:activate` || jianliUseCount(host.state, ownerId) >= 2) return
    setJianliUseCount(host.state, ownerId, jianliUseCount(host.state, ownerId) + 1)
    host.askSkill({ skillId: HUANJIE_JIANLI, ownerId, step: 'choose-recipient', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【谏立】：选择一名其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: alivePlayers(host.state).filter((player) => player.id !== ownerId).map(({ id }) => id), min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') setJianliUseCount(host.state, ownerId, 0)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const flow = jianliFlows(host.state)[ownerId]
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      if (flow?.cardId && context.event.sourceId === flow.targetId && payload.cardId === flow.cardId && (payload.finalAmount ?? 0) > 0)
        flow.dealtDamage = true
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const pending = jianliFlows(host.state)[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      if (pending?.cardId && context.event.sourceId === pending.targetId && payload.cardId === pending.cardId)
        finishJianli(host, ownerId)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      const owner = playerOf(host.state, ownerId)
      const cardIds = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      host.askSkill({ skillId: HUANJIE_JIANLI, ownerId, step: 'choose-gifts', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【谏立】：交给其至多两张牌', timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: Math.min(2, cardIds.length),
      }) })
      return
    }
    if (resolution.step === 'choose-gifts') {
      const targetId = resolution.data.targetId as PlayerId
      if (!playerOf(host.state, targetId)?.alive) return
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      giveOwnedCards(host, ownerId, targetId, selected.slice(0, 2), HUANJIE_JIANLI)
      const target = playerOf(host.state, targetId)!
      const actions = target.zones.hand.flatMap((cardId) => skillHandCardUseActions(host.state, targetId, cardId))
        .filter((action) => action.cardIds.length === 1 && action.cardOwnerId !== ownerId)
      if (!actions.length) {
        jianliFlows(host.state)[ownerId] = { targetId, dealtDamage: false }
        finishJianli(host, ownerId)
        return
      }
      const actionIds = [...actions.map(({ id }) => id), 'respond-pass']
      host.askSkill({ skillId: HUANJIE_JIANLI, ownerId, step: 'use-hand-card', data: { targetId, actionIds }, build: (id): UseCardRequest => ({
        id, kind: 'use-card', playerId: targetId, prompt: '【谏立】：你可使用一张手牌', timeoutMs: 25_000,
        optional: false, actionIds,
      }) })
      return
    }
    if (resolution.step !== 'use-hand-card') return
    const targetId = resolution.data.targetId as PlayerId
    const actionIds = resolution.data.actionIds as string[]
    const selectedId = (response.payload as { actionId?: string }).actionId
    if (selectedId === 'respond-pass' || !selectedId || !actionIds.includes(selectedId)) {
      jianliFlows(host.state)[ownerId] = { targetId, dealtDamage: false }
      finishJianli(host, ownerId)
      return
    }
    const target = playerOf(host.state, targetId)
    const action = target?.zones.hand.flatMap((cardId) => skillHandCardUseActions(host.state, targetId, cardId))
      .find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.id === selectedId && candidate.cardIds.length === 1)
    if (!action) {
      jianliFlows(host.state)[ownerId] = { targetId, dealtDamage: false }
      finishJianli(host, ownerId)
      return
    }
    jianliFlows(host.state)[ownerId] = { targetId, cardId: action.cardIds[0], dealtDamage: false }
    executeUseCardAction(host as never, targetId, action)
  },
})

function queueQingzheng(host: SkillHost, ownerId: PlayerId, eventId: string): void {
  const count = qingzhengValue(host.state, ownerId)
  if (!playerOf(host.state, ownerId)?.alive || count < 1) return
  const record = qingzhengTurn(host.state, ownerId)
  const options = ['draw', 'recover', 'equip'].filter((option) => !record.usedOptions.includes(option))
  if (options.length) host.queueSkill({ skillId: HUANJIE_QINGZHENG, ownerId, step: 'offer', data: { count, options, eventId } })
}

function qingzhengEquip(host: SkillHost, ownerId: PlayerId, count: number): void {
  const slots = equipmentSlotsOf(host.state, ownerId)
  const owner = playerOf(host.state, ownerId)
  if (!owner || !slots.length) return
  const installed: CardId[] = []
  while (installed.length < count) {
    let selected: { cardId: CardId; slot: keyof typeof owner.zones.equipment } | undefined
    for (const cardId of host.state.zones.drawPile) {
      const card = host.state.cards[cardId]
      if (card?.category !== 'equipment' || !card.equipmentSlot) continue
      const compatible = slots.filter((slot) => card.equipmentSlot === 'weapon'
        ? slot === 'weapon' || slot === 'weapon2'
        : slot === card.equipmentSlot)
      if (!compatible.length) continue
      const slot = compatible.find((candidate) => !owner.zones.equipment[candidate]) ?? compatible[0]!
      selected = { cardId, slot }
      break
    }
    if (!selected) break
    const previous = owner.zones.equipment[selected.slot]
    moveCard(host.state, selected.cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: ownerId, slot: selected.slot },
      { replaceEquipmentTo: { kind: 'discardPile' } })
    if (previous) handleEquipmentLost(host, ownerId, previous)
    installed.push(selected.cardId)
    host.dispatch('CardMove', { cardIds: [selected.cardId], reason: HUANJIE_QINGZHENG, from: 'drawPile', to: 'equipment' },
      { sourceId: ownerId, targetId: ownerId, cardIds: [selected.cardId] })
  }
}

registerSkillRuntime({
  id: HUANJIE_QINGZHENG,
  unlimitedCardUses(state, ownerId, cardId) {
    return Boolean(cardId && playerOf(state, ownerId)?.zones.hand.includes(cardId)
      && qingzhengTurn(state, ownerId).unlimitedHandUsage && qingzhengTurn(state, ownerId).unlimitedCardIds.includes(cardId))
  },
  triggers: [
    ...(['HpSet', 'LoseHp', 'Recover', 'DamageSettled'] as const).map((event) => ({
      event,
      handle(host: SkillHost, ownerId: PlayerId, context: EventContext) {
        if (context.event.targetId === ownerId || (context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
          queueQingzheng(host, ownerId, context.event.id)
      },
    })),
    { event: 'HpExchanged', handle(host, ownerId, context) {
      const payload = context.event.payload as { leftId?: PlayerId; rightId?: PlayerId }
      if (payload.leftId === ownerId || payload.rightId === ownerId) queueQingzheng(host, ownerId, context.event.id)
    } },
    { event: 'CardZoneMoved', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromKind?: string; fromPlayerId?: PlayerId | null; toKind?: string; toPlayerId?: PlayerId | null }
      const changed = (payload.fromPlayerId === ownerId && (payload.fromKind === 'hand' || payload.fromKind === 'equipment'))
        || (payload.toPlayerId === ownerId && (payload.toKind === 'hand' || payload.toKind === 'equipment'))
      if (changed) queueQingzheng(host, ownerId, context.event.id)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        Object.assign(qingzhengTurn(host.state, ownerId), { unlimitedHandUsage: false, unlimitedCardIds: [] })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const options = prompt.data.options as string[]
    const count = Number(prompt.data.count)
    if (!playerOf(host.state, ownerId)?.alive || count < 1 || !options.length) return
    host.askSkill({ skillId: HUANJIE_QINGZHENG, ownerId, step: 'choose-effect', data: { count, options }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【清政】：选择一项（X=${count}）`, timeoutMs: 25_000,
      optional: true, options: options.map((option) => ({ id: option, label: option === 'draw' ? `摸${count}张牌`
        : option === 'recover' ? `回复${count}点体力` : `将${count}张装备牌置入装备区` })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-effect') return
    const payload = response.payload as { optionId?: string }
    const option = payload.optionId
    const allowed = resolution.data.options as string[]
    if (!option || !allowed.includes(option) || !playerOf(host.state, ownerId)?.alive) return
    const record = qingzhengTurn(host.state, ownerId)
    const count = Number(resolution.data.count)
    if (count > 2) {
      record.usedOptions = []
      record.unlimitedHandUsage = true
      record.unlimitedCardIds = [...(playerOf(host.state, ownerId)?.zones.hand ?? [])]
    } else {
      if (record.usedOptions.includes(option)) return
      record.usedOptions.push(option)
    }
    if (option === 'draw') drawCards(host.state, host.rng, ownerId, count, (name, data) => { host.dispatch(name, data) })
    else if (option === 'recover') recover(host as never, ownerId, count, ownerId)
    else if (option === 'equip') qingzhengEquip(host, ownerId, count)
  },
})

registerSkillRuntime({
  id: CUILIE_ZIJUE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, CUILIE_ZIJUE)
      || !playerOf(state, ownerId)?.alive || alivePlayers(state).filter((player) => player.id !== ownerId).length === 0) return []
    return [{ id: `${CUILIE_ZIJUE}:activate`, label: '发动【赀爵】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${CUILIE_ZIJUE}:activate` || usedThisPhase(host.state, ownerId, CUILIE_ZIJUE)) return
    markUsedThisPhase(host.state, ownerId, CUILIE_ZIJUE)
    host.askSkill({ skillId: CUILIE_ZIJUE, ownerId, step: 'choose-recipient', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【赀爵】：选择一名其他角色令其声明数字', timeoutMs: 25_000,
      optional: false, candidateIds: alivePlayers(host.state).filter((player) => player.id !== ownerId).map(({ id }) => id), min: 1, max: 1,
    }) })
  },
  distanceModifier: { toOthers: (state, ownerId) => cuilieDistance(state, ownerId), fromOthers: (state, ownerId) => cuilieDistance(state, ownerId) },
  pindianRankOverride(state, ownerId, card) {
    const amount = cuilieDistance(state, ownerId)
    return amount ? card.rank + amount : undefined
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        delete b85(host.state).cuilieDistance?.[ownerId]
      }
    } },
    { event: 'PindianEnd', handle(host, ownerId, context) {
      const result = context.event.payload as { initiatorId?: PlayerId; outcome?: string }
      if (result.initiatorId === ownerId && result.outcome === 'initiator-win' && cuilieDistance(host.state, ownerId))
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string; cardIds?: CardId[] }
    if (resolution.step === 'choose-recipient') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      host.askSkill({ skillId: CUILIE_ZIJUE, ownerId, step: 'declare-number', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: targetId, prompt: '【赀爵】：声明一个数字', timeoutMs: 25_000,
        optional: false, options: [2, 3, 4].map((value) => ({ id: String(value), label: String(value) })),
      }) })
      return
    }
    if (resolution.step === 'declare-number') {
      const count = Number(payload.optionId)
      const targetId = resolution.data.targetId as PlayerId
      if (![2, 3, 4].includes(count) || !playerOf(host.state, targetId)?.alive) return
      const owner = playerOf(host.state, ownerId)
      const cards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      host.askSkill({ skillId: CUILIE_ZIJUE, ownerId, step: 'choose-mode', data: { targetId, count, canGive: cards.length >= count }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【赀爵】：声明数字为${count}，选择是否交牌`, timeoutMs: 25_000,
        optional: false, options: [
          { id: 'draw', label: `不交牌，摸${count}张` },
          ...(cards.length >= count ? [{ id: 'give', label: `交给其${count}张牌并回复1点体力` }] : []),
        ],
      }) })
      return
    }
    if (resolution.step === 'choose-mode') {
      const targetId = resolution.data.targetId as PlayerId
      const count = Number(resolution.data.count)
      if (payload.optionId !== 'give') {
        b85(host.state).cuilieDistance ??= {}
        b85(host.state).cuilieDistance[ownerId] = { amount: count }
        drawCards(host.state, host.rng, ownerId, count, (name, data) => { host.dispatch(name, data) })
        return
      }
      const owner = playerOf(host.state, ownerId)
      const cards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (cards.length < count || !playerOf(host.state, targetId)?.alive) return
      host.askSkill({ skillId: CUILIE_ZIJUE, ownerId, step: 'give-cards', data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【赀爵】：交给其${count}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (resolution.step !== 'give-cards') return
    const targetId = resolution.data.targetId as PlayerId
    const count = Number(resolution.data.count)
    const cards = [...new Set(payload.cardIds ?? [])]
    if (!playerOf(host.state, targetId)?.alive) return
    if (cards.length !== count) return
    const given = giveOwnedCards(host, ownerId, targetId, cards, CUILIE_ZIJUE)
    if (given.length !== count) return
    recover(host as never, ownerId, 1, ownerId)
    b85(host.state).cuilieDistance ??= {}
    b85(host.state).cuilieDistance[ownerId] = { amount: count }
  },
})

registerPindianContinuation(CUILIE_CHIBI_TAG, (pindianHost, result: PindianResult) => {
  const { ownerId, sourceId, targetId, cardId } = result.data as {
    ownerId: PlayerId; sourceId: PlayerId; targetId: PlayerId; cardId: CardId
  }
  const resolution = pindianHost.state.cardResolution
  if (!resolution || resolution.cardId !== cardId || !playerOf(pindianHost.state, ownerId)?.alive) {
    resumeCardTarget(pindianHost as never)
    return
  }
  if (result.outcome === 'initiator-win') {
    if (resolution.kind === 'slash') resolution.targetCancelled = true
    else if (!resolution.cancelledTargetIds.includes(targetId)) resolution.cancelledTargetIds.push(targetId)
    if (pindianHost.state.zones.processingArea.includes(cardId)) {
      moveCard(pindianHost.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      pindianHost.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CUILIE_CHIBI },
        { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    }
    pindianHost.dispatch('SkillActivated', { skillId: CUILIE_CHIBI, skillName: '斥避', playerId: ownerId,
      targetIds: [sourceId, targetId], cardIds: [cardId], result: 'card-cancelled', logText: '拼点赢，令此牌无效并获得之' },
    { sourceId: ownerId, targetId, cardIds: [cardId] })
    resumeCardTarget(pindianHost as never)
    return
  }
  b85(pindianHost.state).chibiUsedTurn ??= {}
  b85(pindianHost.state).chibiUsedTurn[ownerId] = pindianHost.state.turnNumber
  if (resolution.kind === 'slash') {
    if (!resolution.remainingTargetIds.includes(ownerId)) resolution.remainingTargetIds.push(ownerId)
  } else if (!resolution.targetIds.includes(ownerId)) resolution.targetIds.push(ownerId)
  const targets = cardUseTargetsOf(pindianHost.state, cardId)
  if (targets && !targets.targetIds.includes(ownerId)) targets.targetIds.push(ownerId)
  pindianHost.dispatch('SkillActivated', { skillId: CUILIE_CHIBI, skillName: '斥避', playerId: ownerId,
    targetIds: [sourceId, targetId, ownerId], result: 'added-as-target', logText: '拼点未赢，成为此牌的额外目标且本回合不能再发动【斥避】' },
  { sourceId: ownerId, targetId: ownerId })
  resumeCardTarget(pindianHost as never)
})

registerSkillRuntime({
  id: CUILIE_CHIBI,
  interceptBystanderTarget(host, ownerId, context) {
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, context.sourceId)
    const target = playerOf(host.state, context.targetId)
    const resolution = host.state.cardResolution
    const useTargets = cardUseTargetsOf(host.state, context.cardId)
    if (!owner?.alive || !source?.alive || !target?.alive || !resolution || resolution.cardId !== context.cardId
      || source.id === ownerId || target.id === ownerId || chibiUsedThisTurn(host.state, ownerId)
      || !useTargets || useTargets.targetIds.length !== 1 || useTargets.targetIds[0] !== target.id
      || getDistance(host.state, source.id, target.id) <= 1 || !canPindian(host.state, ownerId)
      || !canPindian(host.state, source.id) || prohibitsBeingPindianTargetOf(host.state, source.id)) return false
    host.askSkill({ skillId: CUILIE_CHIBI, ownerId, step: 'pindian-choice', data: {
      sourceId: source.id, targetId: target.id, cardId: context.cardId,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【斥避】：是否与使用者拼点？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '拼点' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pindian-choice') return
    const { sourceId, targetId, cardId } = resolution.data as { sourceId: PlayerId; targetId: PlayerId; cardId: CardId }
    const cardResolution = host.state.cardResolution
    if ((response.payload as { optionId?: string }).optionId !== 'yes'
      || !cardResolution || cardResolution.cardId !== cardId || !playerOf(host.state, ownerId)?.alive
      || !playerOf(host.state, sourceId)?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, sourceId)) {
      resumeCardTarget(host as never)
      return
    }
    const pindianId = `${CUILIE_CHIBI_TAG}:${host.state.turnNumber}:${host.state.seq}`
    startPindian(host as never, {
      id: pindianId, initiatorId: ownerId, opponentId: sourceId, reason: CUILIE_CHIBI,
      continuationTag: CUILIE_CHIBI_TAG, data: { ownerId, sourceId, targetId, cardId },
    })
    if (host.state.pindian?.id !== pindianId) resumeCardTarget(host as never)
  },
})

registerSkillRuntime({
  id: WEICAO_DUOYUE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId === ownerId && payload.phase === 'play' && playerOf(host.state, ownerId)?.alive
      && handCount(host.state, ownerId) > 0 && alivePlayers(host.state).some((player) => player.id !== ownerId && player.zones.hand.length > 0))
      host.queueSkill({ skillId: WEICAO_DUOYUE, ownerId, step: 'choose-opponent', data: { attempt: 1 } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-opponent') return
    const candidateIds = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0).map(({ id }) => id)
    if (!candidateIds.length || !handCount(host.state, ownerId)) return
    host.askSkill({ skillId: WEICAO_DUOYUE, ownerId, step: 'choose-opponent', data: { attempt: Number(prompt.data.attempt ?? 1) }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【掇月】：选择第${Number(prompt.data.attempt ?? 1)}次拼点的角色`, timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string }
    const attempt = Number(resolution.data.attempt ?? 1)
    if (resolution.step === 'choose-opponent' || resolution.step === 'continue-target') {
      const targetId = payload.targetIds?.[0]
      if (resolution.step === 'continue-target') finishPindianSettlement(host as never)
      if (targetId) beginWeicaoDuoYue(host, ownerId, targetId, attempt)
      else finishPindianSettlement(host as never)
      return
    }
    if (resolution.step === 'choose-effect') {
      const winnerId = resolution.data.winnerId as PlayerId | undefined
      if (payload.optionId === 'damage') {
        const candidates = alivePlayers(host.state).map(({ id }) => id)
        if (!candidates.length) { finishPindianSettlement(host as never); return }
        host.askSkill({ skillId: WEICAO_DUOYUE, ownerId, step: 'damage-target', data: { attempt }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【掇月】：选择受到1点伤害的角色', timeoutMs: 25_000,
          optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
        return
      }
      finishPindianSettlement(host as never)
      if (payload.optionId === 'draw' && winnerId && playerOf(host.state, winnerId)?.alive)
        drawCards(host.state, host.rng, winnerId, attempt, (name, data) => { host.dispatch(name, data) })
      continueWeicaoDuoYue(host, ownerId, attempt)
      return
    }
    if (resolution.step === 'damage-target') {
      const targetId = payload.targetIds?.[0]
      finishPindianSettlement(host as never)
      if (targetId && playerOf(host.state, targetId)?.alive)
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', reason: WEICAO_DUOYUE })
    }
  },
})

registerSkillRuntime({
  id: WEICAO_JUNHE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    const gifted = owner?.temporaryGrantedSkills.some((skill) => skill.skillId === WEICAO_JUNHE)
    if (phase.playerId === ownerId && phase.phase === 'prepare' && owner?.alive && !gifted && owner.zones.hand.length)
      host.queueSkill({ skillId: WEICAO_JUNHE, ownerId, step: 'choose-group', data: {} })
  } }, {
    event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && junheStates(host.state, ownerId).some((record) => record.remaining > 0))
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    },
  }, {
    event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      const records = junheStates(host.state, ownerId)
      if (!records.length || amount <= 0 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
      records[0]!.remaining -= 1
      if (records[0]!.remaining <= 0) records.shift()
      if (!records.length) {
        delete b85(host.state).junhe?.[ownerId]
        if (playerOf(host.state, ownerId)?.temporaryGrantedSkills.some((skill) => skill.source === WEICAO_JUNHE))
          replaceTemporarySkill(host.state, ownerId, WEICAO_JUNHE, null)
      }
    },
  }, {
    event: 'PindianEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { initiatorId?: PlayerId; opponentId?: PlayerId; initiatorCardId?: CardId; opponentCardId?: CardId }
      const targetId = data.initiatorId === ownerId ? data.opponentId : data.opponentId === ownerId ? data.initiatorId : undefined
      if (!playerOf(host.state, ownerId)?.alive || effectiveKingdomOf(host.state, targetId!) !== 'wei') return
      const targetCard = data.initiatorId === ownerId ? data.opponentCardId : data.initiatorCardId
      if (!targetCard || !claimPindianCards(host as never, ownerId, [targetCard]).includes(targetCard)) return
      const available = junheStates(host.state, ownerId).reduce((sum, record) => sum + Math.max(0, record.remaining), 0)
      if (!available || junheStates(host.state, targetId!).length) return
      host.queueSkill({ skillId: WEICAO_XIONGWEI, ownerId, step: 'transfer-junhe', data: { targetId, max: available } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-group' || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: WEICAO_JUNHE, ownerId, step: 'choose-group', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【军合】：选择展示牌的相同条件', timeoutMs: 25_000,
      optional: true, options: [
        { id: 'color:red', label: '颜色均为红色' }, { id: 'color:black', label: '颜色均为黑色' },
        { id: 'category:basic', label: '类别均为基本牌' }, { id: 'category:trick', label: '类别均为锦囊牌' },
        { id: 'category:equipment', label: '类别均为装备牌' },
      ],
    }) })
  },
  offersDamageModifierAsk(host, ownerId, side, context) {
    const records = junheStates(host.state, ownerId).filter((record) => record.remaining > 0)
    if (side !== 'source' || context.sourceId !== ownerId || !records.length) return false
    const owner = playerOf(host.state, ownerId)
    const cards = owner?.zones.hand.filter((cardId) => records.some((record) => matchesJunhe(host.state, ownerId, cardId, record))) ?? []
    host.askSkill({ skillId: WEICAO_JUNHE, ownerId, step: 'boost-damage', data: { cardIds: cards }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【军合】：可弃置一张符合展示牌条件的手牌令此伤害+1',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[] }
    if (resolution.step === 'choose-group') {
      const [criterion, value] = (payload.optionId ?? '').split(':')
      if ((criterion !== 'color' && criterion !== 'category') || !value) return
      const owner = playerOf(host.state, ownerId)
      const cardIds = owner?.zones.hand.filter((cardId) => {
        const card = host.state.cards[cardId]
        return criterion === 'color' ? effectiveCardColor(host.state, ownerId, cardId) === value : card?.category === value
      }) ?? []
      if (!cardIds.length) return
      host.askSkill({ skillId: WEICAO_JUNHE, ownerId, step: 'show-cards', data: { criterion, value, allowed: cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【军合】：展示任意张符合条件的手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: cardIds.length,
      }) })
      return
    }
    if (resolution.step === 'show-cards') {
      const allowed = resolution.data.allowed as CardId[]
      const chosen = [...new Set(payload.cardIds ?? [])].filter((cardId) => allowed.includes(cardId)
        && playerOf(host.state, ownerId)?.zones.hand.includes(cardId))
      if (!chosen.length) return
      const record = { remaining: chosen.length + 1, criterion: resolution.data.criterion as JunheState['criterion'], value: String(resolution.data.value) }
      b85(host.state).junhe ??= {}
      ;(b85(host.state).junhe[ownerId] ??= []).push(record)
      host.dispatch('SkillActivated', { skillId: WEICAO_JUNHE, skillName: '军合', playerId: ownerId,
        cardIds: chosen, result: 'revealed', logText: `展示${chosen.length}张牌，获得${record.remaining}次“军合”效果` },
      { sourceId: ownerId, targetId: ownerId, cardIds: chosen })
      return
    }
    if (resolution.step !== 'boost-damage') return
    const cardId = (payload.cardIds ?? [])[0]
    const record = junheStates(host.state, ownerId).find((grant) => grant.remaining > 0
      && matchesJunhe(host.state, ownerId, cardId ?? '', grant))
    if (!cardId || !record || !(resolution.data.cardIds as CardId[]).includes(cardId)
      || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId) || !matchesJunhe(host.state, ownerId, cardId, record)) {
      resumeDamageModifier(host as never, WEICAO_JUNHE, 0)
      return
    }
    discardCardsByIds(host as never, ownerId, [cardId], WEICAO_JUNHE)
    resumeDamageModifier(host as never, WEICAO_JUNHE, 1)
  },
})

registerSkillRuntime({
  id: WEICAO_XIONGWEI,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'transfer-junhe') return
    const targetId = prompt.data.targetId as PlayerId
    const max = junheStates(host.state, ownerId).reduce((sum, record) => sum + Math.max(0, record.remaining), 0)
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive || junheStates(host.state, targetId).length || !max) return
    host.askSkill({ skillId: WEICAO_XIONGWEI, ownerId, step: 'choose-transfer-count', data: { targetId, max }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【雄威】：选择转移给其的“军合”次数', timeoutMs: 25_000,
      optional: true, options: Array.from({ length: max + 1 }, (_, count) => ({ id: String(count), label: count ? `转移${count}次` : '不转移' })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-transfer-count') return
    const targetId = resolution.data.targetId as PlayerId
    const count = Number((response.payload as { optionId?: string }).optionId)
    const target = playerOf(host.state, targetId)
    const source = junheStates(host.state, ownerId)
    const available = source.reduce((sum, record) => sum + Math.max(0, record.remaining), 0)
    if (!target?.alive || !playerOf(host.state, ownerId)?.alive || target.temporaryGrantedSkills.some((skill) => skill.skillId === WEICAO_JUNHE)
      || junheStates(host.state, targetId).length || !Number.isInteger(count) || count < 1 || count > available) return
    b85(host.state).junhe ??= {}
    b85(host.state).junhe[targetId] ??= []
    const recipient = b85(host.state).junhe[targetId] as JunheState[]
    let left = count
    while (left > 0 && source.length) {
      const grant = source[0]!
      const moved = Math.min(left, grant.remaining)
      recipient.push({ ...grant, remaining: moved })
      grant.remaining -= moved
      left -= moved
      if (grant.remaining <= 0) source.shift()
    }
    if (recipient.length) replaceTemporarySkill(host.state, targetId, WEICAO_JUNHE, WEICAO_JUNHE)
    if (!source.length) delete b85(host.state).junhe?.[ownerId]
    host.dispatch('SkillActivated', { skillId: WEICAO_XIONGWEI, skillName: '雄威', playerId: ownerId,
      targetIds: [targetId], amount: count - left, result: 'military-orders-transferred',
      logText: `将${count - left}次“军合”转移给${target.nickname}` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: MOJIANG_MINGFANG,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
      if (candidates.length) host.queueSkill({ skillId: MOJIANG_MINGFANG, ownerId, step: 'choose-target', data: {} })
    } },
    { event: 'CardZoneMoved', handle(host, ownerId) {
      const record = mingfangRecord(host.state, ownerId)
      if (record && !playerOf(host.state, record.targetId)?.zones.hand.includes(record.cardId)) delete b85(host.state).mingfang?.[ownerId]
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const record = mingfangRecord(host.state, ownerId)
      if (context.event.targetId === ownerId || context.event.targetId === record?.targetId) delete b85(host.state).mingfang?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-target') return
    const candidateIds = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0).map(({ id }) => id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: MOJIANG_MINGFANG, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【明访】：选择一名有手牌的其他角色', timeoutMs: 25_000,
      optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  globalIncomingDamage(state, ownerId, targetId, context) {
    const record = mingfangRecord(state, ownerId)
    return record?.targetId === targetId && playerOf(state, targetId)?.zones.hand.includes(record.cardId)
      ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId || !target.zones.hand.length) return
      host.askSkill({ skillId: MOJIANG_MINGFANG, ownerId, step: 'show-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId!, prompt: '【明访】：展示一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'show-card') return
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const target = playerOf(host.state, targetId)
    if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
    b85(host.state).mingfang ??= {}
    b85(host.state).mingfang[ownerId] = { targetId, cardId }
    host.dispatch('SkillActivated', { skillId: MOJIANG_MINGFANG, skillName: '明访', playerId: ownerId,
      targetIds: [targetId], cardIds: [cardId], result: 'revealed', logText: `${target.nickname}展示了一张手牌` },
    { sourceId: ownerId, targetId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: MOJIANG_JIBIAN,
  offersPindianSelectionAsk(host, ownerId, pindianId) {
    if (!playerOf(host.state, ownerId)?.alive || !host.state.pindian || host.state.pindian.id !== pindianId) return false
    host.askSkill({ skillId: MOJIANG_JIBIAN, ownerId, step: 'draw-before-pindian', data: { pindianId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【急辩】：摸至多三张牌，本次拼点牌的点数减去摸牌数', timeoutMs: 25_000,
      optional: true, options: [1, 2, 3].map((count) => ({ id: String(count), label: `摸${count}张` })),
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw-before-pindian') return
    const pindian = host.state.pindian
    if (!pindian || pindian.id !== resolution.data.pindianId || pindian.stage !== 'selecting') {
      continuePindianCardSelection(host as never, ownerId)
      return
    }
    const count = Number((response.payload as { optionId?: string }).optionId ?? 0)
    if ([1, 2, 3].includes(count) && playerOf(host.state, ownerId)?.alive) {
      const drawn = drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
      pindian.rankAdjustments[ownerId] = drawn.length
      host.dispatch('SkillActivated', { skillId: MOJIANG_JIBIAN, skillName: '急辩', playerId: ownerId,
        result: 'pindian-rank-modified', amount: drawn.length, logText: `摸${drawn.length}张牌，本次拼点点数-${drawn.length}` },
      { sourceId: ownerId, targetId: ownerId })
    }
    continuePindianCardSelection(host as never, ownerId)
  },
})

type LingShuTurn = { turnNumber: number; damaged: boolean }
function lingShuTurn(state: SanguoshaState, ownerId: PlayerId): LingShuTurn {
  const records = b85(state).lingShuTurn ??= {}
  const current = records[ownerId] as LingShuTurn | undefined
  if (!current || current.turnNumber !== state.turnNumber)
    records[ownerId] = { turnNumber: state.turnNumber, damaged: false }
  return records[ownerId] as LingShuTurn
}
type KangKangState = { turnNumber: number; sourceId: PlayerId | null; count: number; awaitingCardId?: CardId }
function kangKangState(state: SanguoshaState, ownerId: PlayerId): KangKangState | undefined {
  return b85(state).kangKang?.[ownerId] as KangKangState | undefined
}
function setKangKangState(state: SanguoshaState, ownerId: PlayerId, next?: KangKangState): void {
  b85(state).kangKang ??= {}
  if (next) b85(state).kangKang[ownerId] = next
  else delete b85(state).kangKang[ownerId]
}

registerSkillRuntime({
  id: CHUNYU_LINGSHU,
  viewAs(state, ownerId) {
    const turn = b85(state).lingShuTurn?.[ownerId] as LingShuTurn | undefined
    if (turn?.turnNumber === state.turnNumber && turn.damaged) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const conversions = ['杀', '火杀', '雷杀', '闪', '桃', '酒']
    return owner.zones.hand.flatMap((cardId) => {
      const card = state.cards[cardId]
      if (!card || card.category === 'basic') return []
      return conversions.map((asCardName) => ({ asCardName, cardId, label: `【领戍】${card.name}当${asCardName}` }))
    })
  },
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId) return
      const store = b85(host.state)
      if (!store.lingShuDiscard || store.lingShuDiscard.turnNumber !== host.state.turnNumber)
        store.lingShuDiscard = { turnNumber: host.state.turnNumber, cardIds: [] }
      const record = store.lingShuDiscard as { turnNumber: number; cardIds: CardId[] }
      if (!record.cardIds.includes(payload.cardId)) record.cardIds.push(payload.cardId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const finalAmount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (finalAmount < 1 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
      const turn = lingShuTurn(host.state, ownerId)
      if (turn.damaged) return
      turn.damaged = true
      const entered = b85(host.state).lingShuDiscard as { turnNumber: number; cardIds: CardId[] } | undefined
      const candidates = entered?.turnNumber === host.state.turnNumber
        ? entered.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId)) : []
      if (candidates.length && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: CHUNYU_LINGSHU, ownerId, step: 'gain-random-discard', data: { candidates } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'gain-random-discard' || !playerOf(host.state, ownerId)?.alive) return
    const candidates = (prompt.data.candidates as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
    if (!candidates.length) return
    host.askSkill({ skillId: CHUNYU_LINGSHU, ownerId, step: 'gain-random-discard', data: { candidates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【领戍】：是否随机获得一张本回合进入弃牌堆的牌？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '随机获得一张' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain-random-discard' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const candidates = (resolution.data.candidates as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
    const cardId = candidates.length ? candidates[host.rng.nextInt(candidates.length)] : undefined
    if (!cardId || !playerOf(host.state, ownerId)?.alive) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CHUNYU_LINGSHU }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  },
})

function kangKangSlashActions(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId): Extract<LegalAction, { kind: 'use-card' }>[] {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || !playerOf(host.state, sourceId)?.alive || host.state.pendingRequests.length || host.state.cardResolution) return []
  return owner.zones.hand.flatMap((cardId) => {
    const card = host.state.cards[cardId]
    if (!card || (card.name !== '杀' && card.name !== '火杀' && card.name !== '雷杀')) return []
    return skillOtherHandCardUseActions(host.state, ownerId, ownerId, cardId, card.name, CHUNYU_KANGKANG,
      undefined, { allowSelf: true, ignoreUsageLimits: true }).filter((action) => action.targetIds.includes(sourceId))
  })
}
function continueKangKang(host: SkillHost, ownerId: PlayerId): void {
  const state = kangKangState(host.state, ownerId)
  if (!state?.count || state.turnNumber !== host.state.turnNumber) return
  if (!playerOf(host.state, ownerId)?.alive) { setKangKangState(host.state, ownerId); return }
  if (!state.sourceId || !playerOf(host.state, state.sourceId)?.alive) { setKangKangState(host.state, ownerId); return }
  const actions = kangKangSlashActions(host, ownerId, state.sourceId)
  if (!actions.length) {
    killPlayer(host as never, ownerId, state.sourceId, CHUNYU_KANGKANG)
    setKangKangState(host.state, ownerId)
    return
  }
  host.askSkill({ skillId: CHUNYU_KANGKANG, ownerId, step: 'use-slash', data: { sourceId: state.sourceId, count: state.count,
    actionIds: actions.map(({ id }) => id) }, build: (id): UseCardRequest => ({
    id, kind: 'use-card', playerId: ownerId, prompt: `【顽抗】：对伤害来源使用【杀】（“抗”×${state.count}）；停止将会阵亡`, timeoutMs: 25_000,
    optional: true, actionIds: actions.map(({ id: actionId }) => actionId),
  }) })
}
registerSkillRuntime({
  id: CHUNYU_KANGKANG,
  dyingIntercept(host, ownerId) {
    const dying = host.state.dying
    if (!dying || dying.playerId !== ownerId) return false
    host.askSkill({ skillId: CHUNYU_KANGKANG, ownerId, step: 'dying-offer', data: { sourceId: dying.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【顽抗】：是否回复1点体力、获得1枚“抗”并摸两张牌？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '顽抗' }, { id: 'no', label: '不发动' }],
    }) })
    return 'pending'
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
    const record = kangKangState(host.state, ownerId)
    if (!record || Number(payload.turnNumber ?? host.state.turnNumber) !== record.turnNumber || !record.count) return
    if (record.awaitingCardId) return
    continueKangKang(host, ownerId)
  } }, { event: 'AfterCardUse', handle(host, ownerId, context) {
    const record = kangKangState(host.state, ownerId)
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!record?.awaitingCardId || record.awaitingCardId !== cardId) return
    record.awaitingCardId = undefined
    record.count -= 1
    if (record.count <= 0) { setKangKangState(host.state, ownerId); return }
    if (!record.sourceId || !playerOf(host.state, record.sourceId)?.alive) { setKangKangState(host.state, ownerId); return }
    host.queueSkill({ skillId: CHUNYU_KANGKANG, ownerId, step: 'continue-slash', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'continue-slash') { continueKangKang(host, ownerId); return }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'dying-offer') {
      const dying = host.state.dying
      if (!dying || dying.playerId !== ownerId) return
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        const sourceId = dying.sourceId
        recover(host as never, ownerId, 1, ownerId)
        const previous = kangKangState(host.state, ownerId)
        const current = previous?.turnNumber === host.state.turnNumber
          ? { ...previous, sourceId, count: previous.count + 1 }
          : { turnNumber: host.state.turnNumber, sourceId, count: 1 }
        setKangKangState(host.state, ownerId, current)
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      }
      if (playerOf(host.state, ownerId)?.hp! > 0) {
        host.dispatch('QuitDying', { playerId: ownerId, hp: playerOf(host.state, ownerId)?.hp ?? 0, reason: CHUNYU_KANGKANG }, { targetId: ownerId })
        host.state.dying = null
        host.resumeAfterDying()
      } else continueDyingAssists(host as never)
      return
    }
    if (resolution.step !== 'use-slash') return
    const record = kangKangState(host.state, ownerId)
    if (!record) return
    if (!record.sourceId || !playerOf(host.state, record.sourceId)?.alive) { setKangKangState(host.state, ownerId); return }
    const actionId = (response.payload as { actionId?: string }).actionId
    if (!actionId) {
      killPlayer(host as never, ownerId, record.sourceId, CHUNYU_KANGKANG)
      setKangKangState(host.state, ownerId)
      return
    }
    const action = kangKangSlashActions(host, ownerId, record.sourceId!).find((candidate) => candidate.id === actionId
      && (resolution.data.actionIds as string[]).includes(candidate.id))
    if (!action) { continueKangKang(host, ownerId); return }
    record.awaitingCardId = action.cardIds[0]
    executeUseCardAction(host as never, ownerId, action)
  },
})

type LiexiangUse = { phaseKey: string; used: number; lowBranchUnlocked: boolean }
type LiexiangFlow = { actorId: PlayerId; targetId: PlayerId; count: number; isGranted: boolean }
type LiexiangLock = { remaining: number; activeTurnNumber: number | null }
function liexiangPhaseKey(state: SanguoshaState): string {
  return `${state.turnNumber}:${state.extraPhase?.instanceId ?? 'normal'}:${phaseSlotOf(state)}:${state.currentPlayerId}`
}
function liexiangUse(state: SanguoshaState, actorId: PlayerId): LiexiangUse {
  const records = b85(state).liexiangUse ??= {}
  const key = liexiangPhaseKey(state)
  const previous = records[actorId] as LiexiangUse | undefined
  if (!previous || previous.phaseKey !== key) records[actorId] = { phaseKey: key, used: 0, lowBranchUnlocked: false }
  return records[actorId] as LiexiangUse
}
function liexiangFlows(state: SanguoshaState): Record<PlayerId, LiexiangFlow> {
  return (b85(state).liexiangFlows ??= {}) as Record<PlayerId, LiexiangFlow>
}
function liexiangLock(state: SanguoshaState, targetId: PlayerId): LiexiangLock | undefined {
  return b85(state).liexiangLocks?.[targetId] as LiexiangLock | undefined
}
function clearLiexiangLock(state: SanguoshaState, targetId: PlayerId): void {
  delete b85(state).liexiangLocks?.[targetId]
}
function askLiexiangTarget(host: SkillHost, skillOwnerId: PlayerId, actorId: PlayerId, maxDraw: number, isGranted: boolean): void {
  const candidates = alivePlayers(host.state).filter((player) => player.id !== actorId).map(({ id }) => id)
  if (!candidates.length) return
  host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId: skillOwnerId, step: 'choose-target', data: { actorId, maxDraw, isGranted }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: actorId, prompt: '【烈骧】：选择一名其他角色', timeoutMs: 25_000,
    optional: false, candidateIds: candidates, min: 1, max: 1,
  }) })
}
function askLiexiangCount(host: SkillHost, skillOwnerId: PlayerId, actorId: PlayerId, targetId: PlayerId, maxDraw: number, isGranted: boolean): void {
  host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId: skillOwnerId, step: 'choose-draw-count', data: { actorId, targetId, maxDraw, isGranted }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: actorId, prompt: `【烈骧】：摸0至${maxDraw}张牌并对目标造成1点伤害`, timeoutMs: 25_000,
    optional: false, options: Array.from({ length: maxDraw + 1 }, (_, count) => ({ id: String(count), label: `摸${count}张` })),
  }) })
}
function startLiexiangFlow(host: SkillHost, skillOwnerId: PlayerId, flow: LiexiangFlow): void {
  if (!playerOf(host.state, flow.actorId)?.alive || !playerOf(host.state, flow.targetId)?.alive) return
  const use = liexiangUse(host.state, flow.actorId)
  if (use.used >= (use.lowBranchUnlocked ? 2 : 1)) return
  use.used += 1
  drawCards(host.state, host.rng, flow.actorId, flow.count, (name, payload) => { host.dispatch(name, payload) })
  liexiangFlows(host.state)[skillOwnerId] = flow
  resolveDamageSequence(host as never, { sourceId: flow.actorId, targetIds: [flow.targetId], amount: 1,
    nature: 'normal', cardId: null, cardName: null, sourceSkillId: WELIUBEI_LIEXIANG })
}
function requestLiexiangGift(host: SkillHost, skillOwnerId: PlayerId, flow: LiexiangFlow): void {
  const actor = playerOf(host.state, flow.actorId)
  if (!actor?.alive || !flow.count) return
  const recipients = alivePlayers(host.state).filter((player) => player.id !== flow.actorId).map(({ id }) => id)
  if (!recipients.length) return
  host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId: skillOwnerId, step: 'gift-recipient', data: { ...flow }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: flow.actorId, prompt: `【烈骧】：可交给一名其他角色至多${flow.count}张手牌`, timeoutMs: 25_000,
    optional: true, candidateIds: recipients, min: 0, max: 1,
  }) })
}
function resolveLiexiangBranch(host: SkillHost, skillOwnerId: PlayerId): void {
  const flow = liexiangFlows(host.state)[skillOwnerId]
  if (!flow) return
  delete liexiangFlows(host.state)[skillOwnerId]
  const actor = playerOf(host.state, flow.actorId)
  const target = playerOf(host.state, flow.targetId)
  if (!actor?.alive || !target) return
  const use = liexiangUse(host.state, flow.actorId)
  if (actor.zones.hand.length > target.zones.hand.length) {
    b85(host.state).liexiangSlashBonus ??= {}
    b85(host.state).liexiangSlashBonus[skillOwnerId] ??= {}
    b85(host.state).liexiangSlashBonus[skillOwnerId][flow.actorId] = liexiangPhaseKey(host.state)
    requestLiexiangGift(host, skillOwnerId, flow)
    return
  }
  if (actor.zones.hand.length === target.zones.hand.length) {
    const lockCount = Math.max(0, flow.count)
    if (lockCount) {
      b85(host.state).liexiangLocks ??= {}
      b85(host.state).liexiangLocks[flow.targetId] = { remaining: lockCount, activeTurnNumber: null }
    }
    const pickable = pickableCardsOf(host.state, flow.targetId)
    if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
    host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId: skillOwnerId, step: 'take-card', data: { targetId: flow.targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: flow.actorId, prompt: '【烈骧】：获得目标一张手牌或装备牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }) })
    return
  }
  use.lowBranchUnlocked = true
  const candidates = alivePlayers(host.state).filter((player) => player.id !== flow.actorId && player.id !== flow.targetId).map(({ id }) => id)
  host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId: skillOwnerId, step: 'low-extra-targets', data: { ...flow, candidates }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: flow.actorId, prompt: `【烈骧】：失去${flow.count}点体力，并可额外选择至多${flow.count}名角色`, timeoutMs: 25_000,
    optional: true, candidateIds: candidates, min: 0, max: Math.min(flow.count, candidates.length),
  }) })
}

registerSkillRuntime({
  id: WELIUBEI_LIEXIANG,
  activeActions(state, ownerId) {
    if (state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const use = liexiangUse(state, ownerId)
    if (use.used >= (use.lowBranchUnlocked ? 2 : 1) || alivePlayers(state).length < 2) return []
    return [{ id: `${WELIUBEI_LIEXIANG}:activate`, kind: 'invoke-skill', playerId: ownerId,
      skillId: WELIUBEI_LIEXIANG, cardIds: [], targetIds: [], label: '发动【烈骧】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${WELIUBEI_LIEXIANG}:activate`) return
    const use = liexiangUse(host.state, ownerId)
    if (use.used >= (use.lowBranchUnlocked ? 2 : 1)) return
    askLiexiangTarget(host, ownerId, ownerId, 5, false)
  },
  globalSlashUses(state, ownerId, actorId) {
    return b85(state).liexiangSlashBonus?.[ownerId]?.[actorId] === liexiangPhaseKey(state) ? 1 : 0
  },
  triggers: [
    { event: 'DamageSequenceResolved', handle(host, ownerId, context) {
      if ((context.event.payload as { sourceSkillId?: string }).sourceSkillId === WELIUBEI_LIEXIANG)
        resolveLiexiangBranch(host, ownerId)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase === 'play' && payload.playerId) delete b85(host.state).liexiangSlashBonus?.[ownerId]?.[payload.playerId]
    } },
    { event: 'TurnStart', handle(host, _ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const lock = liexiangLock(host.state, targetId)
      if (lock) lock.activeTurnNumber = host.state.turnNumber
    } },
    { event: 'BeforeCardUse', allowDeadOwner: true, handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const lock = liexiangLock(host.state, sourceId)
      if (!lock || lock.activeTurnNumber !== host.state.turnNumber || lock.remaining < 1) return
      lock.remaining -= 1
      context.cancel()
      host.dispatch('SkillActivated', { skillId: WELIUBEI_LIEXIANG, skillName: '烈骧', playerId: sourceId,
        result: 'next-turn-card-invalidated', remaining: lock.remaining, logText: `其本回合第${Math.max(1, Number((b85(host.state).liexiangLocksUsed?.[sourceId] ?? 0) + 1))}张牌无效` },
      { sourceId, targetId: sourceId })
      b85(host.state).liexiangLocksUsed ??= {}
      b85(host.state).liexiangLocksUsed[sourceId] = Number(b85(host.state).liexiangLocksUsed[sourceId] ?? 0) + 1
      if (lock.remaining <= 0) clearLiexiangLock(host.state, sourceId)
    } },
    { event: 'TurnEnd', allowDeadOwner: true, handle(host, _ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const lock = liexiangLock(host.state, targetId)
      if (lock && lock.activeTurnNumber === host.state.turnNumber) {
        clearLiexiangLock(host.state, targetId)
        delete b85(host.state).liexiangLocksUsed?.[targetId]
      }
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; optionId?: string; cardIds?: CardId[]; actionId?: string }
    if (resolution.step === 'choose-target') {
      const actorId = resolution.data.actorId as PlayerId
      const targetId = payload.targetIds?.[0]
      if (!targetId || targetId === actorId || !playerOf(host.state, targetId)?.alive) return
      askLiexiangCount(host, ownerId, actorId, targetId, Number(resolution.data.maxDraw), Boolean(resolution.data.isGranted))
      return
    }
    if (resolution.step === 'choose-draw-count') {
      const count = Number(payload.optionId)
      const actorId = resolution.data.actorId as PlayerId
      const targetId = resolution.data.targetId as PlayerId
      const maxDraw = Number(resolution.data.maxDraw)
      if (!Number.isInteger(count) || count < 0 || count > maxDraw || !playerOf(host.state, actorId)?.alive || !playerOf(host.state, targetId)?.alive) return
      startLiexiangFlow(host, ownerId, { actorId, targetId, count, isGranted: Boolean(resolution.data.isGranted) })
      return
    }
    if (resolution.step === 'low-extra-targets') {
      const flow = resolution.data as unknown as LiexiangFlow
      const chosen = [...new Set(payload.targetIds ?? [])].filter((id) => id !== flow.actorId && id !== flow.targetId && playerOf(host.state, id)?.alive)
        .slice(0, flow.count)
      if (flow.count > 0) loseHp(host as never, flow.actorId, flow.count, WELIUBEI_LIEXIANG)
      if (chosen.length) resolveDamageSequence(host as never, { sourceId: flow.actorId, targetIds: chosen, amount: 1,
        nature: 'normal', cardId: null, cardName: null, sourceSkillId: WELIUBEI_LIEXIANG })
      return
    }
    if (resolution.step === 'gift-recipient') {
      const flow = resolution.data as unknown as LiexiangFlow
      const recipientId = payload.targetIds?.[0]
      const actor = playerOf(host.state, flow.actorId)
      if (!recipientId || recipientId === flow.actorId || !playerOf(host.state, recipientId)?.alive || !actor?.alive) return
      const cards = [...actor.zones.hand]
      if (!cards.length) return
      host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId, step: 'gift-cards', data: { ...flow, recipientId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: flow.actorId, prompt: `【烈骧】：选择交给目标的至多${flow.count}张手牌`, timeoutMs: 25_000,
        optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: Math.min(flow.count, cards.length),
      }) })
      return
    }
    if (resolution.step === 'gift-cards') {
      const flow = resolution.data as unknown as LiexiangFlow
      const recipientId = resolution.data.recipientId as PlayerId
      const actor = playerOf(host.state, flow.actorId)
      if (!actor?.alive || !playerOf(host.state, recipientId)?.alive) return
      giveCards(host as never, flow.actorId, recipientId, (payload.cardIds ?? []).slice(0, flow.count), WELIUBEI_LIEXIANG)
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = payload.cardIds?.[0]
      const cardId = picked && resolvePickedCard(host.state, targetId, picked)
      const zone = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
      if (!cardId || !zone) return
      moveCard(host.state, cardId, zone, { kind: 'hand', playerId: ownerId })
      if (zone.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WELIUBEI_LIEXIANG }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      return
    }
  },
})

registerSkillRuntime({
  id: WELIUBEI_RENGOU,
  grantsPlayActions(state, ownerId, actorId) {
    const actor = playerOf(state, actorId)
    if (state.phase !== 'play' || state.currentPlayerId !== actorId || actorId === ownerId || !actor?.alive
      || effectiveKingdomOf(state, actorId) !== 'shu') return []
    const key = liexiangPhaseKey(state)
    if (b85(state).rengouUsed?.[actorId] === key
      || ![...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))].length) return []
    return [{ id: `${WELIUBEI_RENGOU}:activate:${actorId}`, label: '发动【仁彀】' }]
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== `${WELIUBEI_RENGOU}:activate:${actorId}`) return
    const actor = playerOf(host.state, actorId)
    const cards = actor ? [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (host.state.status !== 'playing' || host.state.phase !== 'play' || host.state.currentPlayerId !== actorId
      || !actor?.alive || actorId === ownerId || effectiveKingdomOf(host.state, actorId) !== 'shu' || !cards.length) return
    const key = liexiangPhaseKey(host.state)
    b85(host.state).rengouUsed ??= {}
    if (b85(host.state).rengouUsed[actorId] === key) return
    b85(host.state).rengouUsed[actorId] = key
    host.askSkill({ skillId: WELIUBEI_RENGOU, ownerId, step: 'choose-cost', data: { actorId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: actorId, prompt: '【仁彀】：弃置一张牌并令威·刘备回复1点体力', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const actorId = resolution.data.actorId as PlayerId
    const actor = playerOf(host.state, actorId)
    if (resolution.step === 'choose-cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      const zone = cardId ? locateOwnedCard(host.state, actorId, cardId) : null
      if (!actor?.alive || !owner?.alive || !cardId || !zone || (zone.kind !== 'hand' && zone.kind !== 'equipment')) return
      if (!discardCardsByIds(host as never, actorId, [cardId], WELIUBEI_RENGOU).includes(cardId)) return
      recover(host as never, ownerId, 1, actorId, WELIUBEI_RENGOU)
      host.askSkill({ skillId: WELIUBEI_RENGOU, ownerId, step: 'grant-liexiang', data: { actorId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【仁彀】：是否令${actor?.nickname ?? '该角色'}发动一次至多摸两张牌的【烈骧】？`, timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '令其发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (resolution.step !== 'grant-liexiang' || (response.payload as { optionId?: string }).optionId !== 'yes' || !actor?.alive) return
    host.askSkill({ skillId: WELIUBEI_LIEXIANG, ownerId, step: 'choose-target', data: { actorId, maxDraw: 2, isGranted: true }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: actorId, prompt: '【仁彀】：选择【烈骧】的目标角色', timeoutMs: 25_000,
      optional: false, candidateIds: alivePlayers(host.state).filter((player) => player.id !== actorId).map(({ id }) => id), min: 1, max: 1,
    }) })
  },
})

export const HISTORICAL_BATCH85_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'huan-jie-b85', name: '桓阶', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HUANJIE_JIANLI, name: '谏立', description: '出牌阶段限两次，你可交给一名其他角色至多两张牌并令其可使用一张手牌，若其未造成伤害，你受到其造成的1点伤害。' },
    { id: HUANJIE_QINGZHENG, name: '清政', description: '每回合每项限一次，当你的体力值、手牌区、装备区牌数发生变化后，若值为一，你可选择一项发动：1.摸X张牌;2.回复X点体力;3.从牌堆中将X张装备牌置入你的装备区。若X大于2，此技能视为未发动过且使用当前手牌时无次数限制。（X为你体力值、手牌区、装备区值为一的数量）' },
  ] },
  { id: 'xing-yanliang-b85', name: '星·颜良', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YANLIANG_JIZHAN, name: '急战', description: '当你于回合内使用第一张伤害牌指定目标后，你可令此牌对其中一名目标角色伤害+2（你本回合每使用过一张非伤害牌，此数值便-1）。然后若此牌没有造成过伤害，该角色对你造成1点伤害。' },
    { id: YANLIANG_CUXIA, name: '促狭', locked: true, description: '当其他角色对你使用牌时，若其体力值大于你或本轮对你造成过伤害，其随机弃置一张手牌，若皆满足，则你摸一张牌。' },
  ] },
  { id: 'cui-lie-b85', name: '崔烈', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CUILIE_ZIJUE, name: '赀爵', description: '出牌阶段限一次，你可令一名其他角色声明2~4之间的一个数字。你可交给其X张牌并回复1点体力，然后直到你的下回合开始，其他角色与你计算距离+X，你使用牌拼点时点数+X且拼点赢时摸1张牌；若你未交给其牌，则你摸X张牌。（X为其声明的数字）' },
    { id: CUILIE_CHIBI, name: '斥避', description: '其他角色使用牌指定距离其大于1的角色为唯一目标时，你可与其拼点；若你赢，你令此牌无效并获得此牌；若你没赢，你成为此牌的额外目标，且此技能本回合失效。' },
  ] },
  { id: 'su-yue-b85', name: '苏越', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SUYUE_GONGTU, name: '宫图', description: '游戏开始时，你可以依次选择两种牌类别。每当连续两张被使用的牌类别与你选择的顺序相同时，你可以从牌堆获得两张点数不同的牌。' },
    { id: SUYUE_HANGZHU, name: '夯筑', description: '出牌阶段限一次，你可以将任意张牌置于武将牌上称为“基”，然后令一名其他角色弃置所有这些点数的牌。若“基”中有重复点数，弃置所有重复点数的“基”并摸等量张牌；若包含全部13种点数，你可将所有“基”交给一名角色并令其回复至体力上限。' },
  ] },
  { id: 'guo-tiying-b85', name: '郭缇萦', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: GUOTIYING_KANYU, name: '堪舆', description: '角色判定或你受到伤害时，你可观看牌堆顶与牌堆底各一张牌，你可获得其中任意张牌并将其余牌以任意顺序放回牌堆顶。若你因此获得牌，本局【闪电】对你生效的范围增加你所获得牌的花色点数。' },
    { id: GUOTIYING_ZHE, name: '谪厄', locked: true, description: '游戏开始时，从牌堆中将【闪电】置入你的判定区。每个回合结束时，若弃牌堆中存在【闪电】，则置入你的判定区。' },
  ] },
  { id: 'wei-cao-cao-b85', name: '威·曹操', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WEICAO_DUOYUE, name: '掇月', description: '出牌阶段开始时，你可进行至多三次拼点。每次拼点结算后，你可令本次拼点赢的角色摸当前拼点次数张牌；若你赢，你可改为对一名角色造成1点伤害并终止后续拼点。' },
    { id: WEICAO_JUNHE, name: '军合', description: '准备阶段，你可展示任意张颜色或类别相同的牌并获得“军合”效果：你下X次造成伤害时，可弃置一张与展示牌颜色或类别相同的牌令此伤害+1；受到伤害后摸两张牌。（X为展示牌数+1）' },
    { id: WEICAO_XIONGWEI, name: '雄威', description: '你和魏势力角色拼点后，你获得其拼点牌。若如此做，且该角色没有“军合”效果，则你可以将任意次数的“军合”转移给该角色。' },
  ] },
  { id: 'chunyu-qiong-b85', name: '谋·淳于琼', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CHUNYU_LINGSHU, name: '领戍', description: '若你当前回合没有造成或受到过伤害，你可以将一张非基本牌当基本牌使用或打出。你每回合首次造成或受到伤害后，可随机获得一张本回合进入弃牌堆的牌。' },
    { id: CHUNYU_KANGKANG, name: '顽抗', description: '当你处于濒死状态时，你可以回复1点体力，然后获得一个“抗”标记并摸两张牌。若如此做，此回合结束时，你可以对伤害来源使用任意张〖杀〗，每使用一张移去一个“抗”（若伤害来源死亡则移去所有“抗”）。停止使用〖杀〗后若仍然有“抗”，则你阵亡。' },
  ] },
  { id: 'mojianggan-b85', name: '谋·蒋干', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MOJIANG_MINGFANG, name: '明访', description: '回合开始时，你可令一名其他角色展示一张手牌，以此法展示的牌在其手牌中时，其受到的伤害+1。' },
    { id: MOJIANG_JIBIAN, name: '急辩', description: '你拼点时，可以摸至多三张牌。若如此做，你本次拼点的牌点数-X。（X为本次摸牌数）' },
  ] },
  { id: 'wei-liu-bei-b85', name: '威·刘备', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WELIUBEI_LIEXIANG, name: '烈骧', description: '出牌阶段限一次，你可以摸至多5张牌并对一名其他角色造成1点伤害。若你的手牌数大于其，本阶段你出〖杀〗次数+1且可交给一名角色至多X张牌；若相等，你获得其一张牌且其下回合使用的前X张牌无效；若小于，你失去X点体力，本阶段此技能改为限两次且可额外选择X名其他角色。（X为你选择的摸牌数）' },
    { id: WELIUBEI_RENGOU, name: '仁彀', description: '其他蜀势力角色出牌阶段限一次，其可弃置一张牌并令你回复1点体力，然后你可令其发动一次至多摸2张牌的“烈骧”。' },
  ] },
  { id: 'han-song-b85', name: '韩嵩', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HANS_HIDDEN, name: '隐避', locked: true, description: '你的手牌上限等同于场上手牌上限最多的角色。若没有角色手牌数与你相等，你使用牌无距离及次数限制。' },
    { id: HANS_LUYAN, name: '率言', description: '其他角色摸牌阶段或弃牌阶段结束时，若其手牌数与你相等，你可以摸一张牌或弃置其一张牌。你的摸牌阶段或弃牌阶段结束时，你可以摸X张牌（X为与你手牌数相等的角色数）。' },
  ] },
]
