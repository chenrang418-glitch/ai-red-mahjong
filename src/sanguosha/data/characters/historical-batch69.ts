import type { CharacterDefinition } from './types'
import type { CardCategory, CardId, PhysicalCard, PlayerId, Rank, SanguoshaState, Suit } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, ChooseSuitRequest, RespondCardRequest } from '../../engine/requests'
import { clanOfCharacter, registerSkillRuntime, type DamagePreventionContext, type SkillHost } from '../../engine/skills/runtime'
import { discardCardsByIds, discardCardsByOwners } from '../../engine/discard-all'
import { handleEquipmentLost } from '../../engine/equipment'
import { dispatchEquipmentZoneLoss } from '../../engine/equipment-zone-loss'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { moveCard } from '../../engine/zones'
import { locateOwnedCard } from '../../engine/zones'
import { queueExtraTurn } from '../../engine/turn'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { canTarget, getAttackRange, getSeatDistance } from '../../engine/distance'
import { isTargetProhibited, isCardUseProhibited, isCardResponseProhibited, effectiveCardSuit } from '../../engine/skills/runtime'
import { skillIdsOf } from './standard'
import { destroySpecialEquipment } from '../../engine/special-equipment'
import { declaredCardActions, skillHandCardUseActions, skillOtherHandDeclaredCardUseActions } from '../../engine/cards/basic'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { canPindian, finishPindianSettlement, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { giveOwnedCards } from '../../engine/hand-transfer'
import { recover } from '../../engine/recover'
import { completeVirtualBasicResponse, resumeCardResponseAsPass } from '../../engine/cards/basic'
import { completeVirtualTrickBasicResponse } from '../../engine/cards/tricks'
import { resolvePickedCard } from '../../engine/card-pick'
import { lockCardCategory } from '../../engine/card-play-lock'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { continueDyingRescue } from '../../engine/damage'
import type { LegalAction } from '../../engine/actions'

const B = '-b69'
const sid = (key: string) => `${key}${B}`
const FENNU = sid('fennu-luji')
const ZELEI = 'zelei-clan-lu-b69'
const SHIZE = sid('shize-chenqun')
const KUDU = sid('kudu-yangzhong')
const TANFENG = sid('tanfeng-lujing')
const GAILAN = sid('gailan-luji')
const HUNTIANYI = 'huntianyi-b69'
const HUNTIANYI_RANKS = [1, 3, 10, 12] as const
const JIANJI = sid('jianji-wangguang')
const LILUN = sid('lilun-wangguang')
const SHIXI = sid('shixi-luyusheng')
const JIANBAI = sid('jianbai-luyusheng')
const GEZHI = sid('gezhi-chenqun')
const JUEWEI = sid('juewei-lujing')
const QINGJUE = sid('qingjue-xunshi')
const SHENGMO = sid('shengmo-wangmingshan')
const sk = (key: string, name: string, description: string, locked = false) => ({ id: sid(key), name, description, ...(locked ? { locked: true } : {}) })
const zhongliu = { id: 'zhongliu-clan-wang', name: '中流', description: '宗族技，锁定技，当你使用牌时，若不为同族角色的手牌，你视为未发动武将牌上的技能。', locked: true }
const quhuo = { id: 'quhuo-clan-yang-b67', name: '去惑', description: '宗族技，当你每回合首次不因使用、打出或弃置，失去手牌中的【酒】或装备牌后，你可令一名同族角色回复1点体力。' }
const zelei = { id: 'zelei-clan-lu-b69', name: '泽烈', description: '宗族技，当同族角色失去其场上的所有牌后，你可令一名角色本回合下一次摸牌/弃牌后，其再摸一张牌/弃一张牌。' }
const daojie = { id: 'daojie-clan-xun-b66', name: '蹈节', description: '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。', locked: true }
const shize = sk('shize-chenqun', '士则', '宗族技，锁定技，你于回合内使用牌首次被响应后，你令一名同族角色攻击范围+1，直到其下次受到伤害。', true)
type Batch69State = SanguoshaState & { b69?: {
  tanquePrevious?: Record<PlayerId, { turnNumber: number; rank: number }>
  tanqueUsed?: Record<PlayerId, number>
  jiannan?: Record<PlayerId, { turnNumber: number; uses: number; usedOptions: string[] }>
  jiannanTurnCount?: Record<PlayerId, { turnNumber: number; count: number }>
  yichiPending?: Record<PlayerId, { targetId: PlayerId; count: number; nextOption: number }>
  jiannanMarks?: Record<CardId, true>
  fennuRecord?: Record<PlayerId, number>
  fennuPending?: Record<PlayerId, { targetIds: PlayerId[]; index: number; cardIds: CardId[] }>
  zeleiPending?: Record<PlayerId, PlayerId>
  zeleiFollowup?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  shizeUsedTurn?: Record<PlayerId, number>
  shizeBonus?: Record<PlayerId, number>
  kuduPending?: Record<PlayerId, KuduPending>
  tanfengPending?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId }>
  huntianyiInjected?: boolean
  jianjiTargetedTurn?: Record<PlayerId, number>
  yingxiangCards?: Record<CardId, { ownerId: PlayerId; holderId: PlayerId }>
  yingxiangPendingOwner?: Record<CardId, PlayerId>
  dinganDyingBaseline?: Record<PlayerId, { turnNumber: number; entries: number }>
  dinganUsedPlayers?: Record<PlayerId, Record<PlayerId, number>>
  mingdianUsedNames?: Record<PlayerId, { roundNumber: number; names: string[] }>
  funingTriggeredRound?: Record<PlayerId, number>
  qingjueHpTurn?: Record<PlayerId, number>
  qingjueUsedRound?: Record<PlayerId, number>
  qingjuePending?: Record<PlayerId, { cardIds: CardId[]; remaining: number; targetId?: PlayerId }>
  shengmoDiscardTurn?: Record<CardId, number>
  shengmoChosenRanks?: Record<PlayerId, number[]>
  shengmoUsedNames?: Record<PlayerId, string[]>
  shengmoUsedRound?: Record<PlayerId, number>
  lilunRecastNames?: Record<PlayerId, { turnNumber: number; names: string[] }>
  shixiRecords?: Record<PlayerId, Array<{ name: string; suit: Suit }>>
  jianbaiUsedTypes?: Record<PlayerId, { turnNumber: number; types: string[] }>
  jianbaiRetained?: Record<PlayerId, Record<CardId, number>>
  gezhiUsedTurn?: Record<PlayerId, number>
  jueweiUsedTurn?: Record<PlayerId, number>
  jueweiPromptedCards?: Record<CardId, true>
  jueweiPendingReplay?: Record<CardId, { ownerId: PlayerId; targets: PlayerId[]; cardName: string }>
} }
type KuduPending = { targetId: PlayerId; waitTurns: number; turnsDone: number; armedTurn: number }
const stateOf = (host: SkillHost) => (host.state as Batch69State).b69 ??= {}
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((player) => player.id === playerId)
const handOf = (state: SanguoshaState, playerId: PlayerId) => playerOf(state, playerId)?.zones.hand ?? []
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, candidateIds: PlayerId[], data: Record<string, unknown> = {}, optional = true, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId, prompt, timeoutMs: 25_000, optional, candidateIds, min: 1, max: 1 }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, playerId: PlayerId, cardIds: CardId[], data: Record<string, unknown> = {}, count = 1) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: count, max: count }) })
}
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, data: Record<string, unknown> = {}, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }] }) })
}
function markJianNanCards(host: SkillHost, cardIds: CardId[]) {
  const state = stateOf(host)
  state.jiannanMarks ??= {}
  for (const cardId of cardIds) state.jiannanMarks[cardId] = true
}
function askJianNanOptions(host: SkillHost, ownerId: PlayerId, entry: { turnNumber: number; uses: number; usedOptions: string[] }) {
  const options = [
    { id: 'discard', label: '令一名角色弃置两张牌' },
    { id: 'draw', label: '令一名角色摸两张牌' },
    { id: 'recast', label: '令一名角色重铸所有装备牌' },
    { id: 'top-or-hp', label: '令一名角色将锦囊牌置于牌堆顶或失去1点体力' },
  ].filter((option) => !entry.usedOptions.includes(option.id))
  if (!options.length) return
  host.askSkill({ skillId: JIANNAN, ownerId, step: 'effect', data: { options: options.map((option) => option.id) }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【间难】：选择一项尚未发动的效果', timeoutMs: 25_000, optional: false, options }) })
}
registerSkillRuntime({ id: GAILAN, triggers: [
  { event: 'GameStart', handle(host, _ownerId) {
    const state = stateOf(host)
    if (state.huntianyiInjected) return
    state.huntianyiInjected = true
    HUNTIANYI_RANKS.forEach((rank, index) => createHunTianYi(host.state, rank, index))
    host.state.zones.drawPile = host.rng.shuffle(host.state.zones.drawPile)
  } },
  { event: 'TurnStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    if (payload.playerId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const cards = availableHunTianYi(host)
    if (cards.length) askCards(host, GAILAN, ownerId, 'equip', '【该览】：选择牌堆或弃牌堆中的一张【浑天仪】置入装备区', ownerId, cards)
  } },
  { event: 'LoseEquipment', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; specialEquipment?: string }
    if (payload.playerId !== ownerId || payload.specialEquipment !== HUNTIANYI || !payload.cardId) return
    const rank = host.state.specialEquipmentRemovalRank?.[payload.cardId] ?? host.state.cards[payload.cardId]?.rank
    if (rank === undefined) return
    const candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.category === 'trick'
      && host.state.cards[cardId]?.rank === rank)
    const gained = host.rng.shuffle(candidates).slice(0, 2)
    for (const cardId of gained) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: HUNTIANYI }, { targetId: ownerId, cardIds: gained })
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'equip') return
  const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
  if (cardId) installHunTianYi(host, ownerId, cardId)
}, preventsDamage(state, ownerId, side) {
  if (side !== 'target') return false
  const cardId = playerOf(state, ownerId)?.zones.equipment.treasure
  return Boolean(cardId && state.cards[cardId]?.specialEquipment === HUNTIANYI)
}, onDamagePrevented(host, ownerId, side, _context: DamagePreventionContext) {
  if (side !== 'target') return
  const cardId = playerOf(host.state, ownerId)?.zones.equipment.treasure
  if (!cardId || host.state.cards[cardId]?.specialEquipment !== HUNTIANYI) return
  moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot: 'treasure' }, { kind: 'discardPile' })
  handleEquipmentLost(host as never, ownerId, cardId)
  dispatchEquipmentZoneLoss(host as never, ownerId, [cardId])
  destroySpecialEquipment(host.state, cardId)
  if (host.state.specialEquipmentRemoval) delete host.state.specialEquipmentRemoval[cardId]
} })

function fieldCardCount(player: NonNullable<ReturnType<typeof playerOf>>) {
  return player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length + player.zones.judgingArea.length
}
function createHunTianYi(state: SanguoshaState, rank: typeof HUNTIANYI_RANKS[number], copyIndex: number): CardId {
  const cardId = `${HUNTIANYI}:${state.seq}:${copyIndex}:${Object.keys(state.cards).length}`
  const card: PhysicalCard = {
    id: cardId, ruleset: state.rulesetVersion, expansion: 'standard', name: '浑天仪',
    suit: 'diamond', rank, color: 'red', category: 'equipment', equipmentSlot: 'treasure',
    specialEquipment: HUNTIANYI, persistInDiscard: true, sourceSkillId: GAILAN,
  }
  state.cards[cardId] = card
  state.zones.drawPile.push(cardId)
  return cardId
}
function askFennuNextCard(host: SkillHost, ownerId: PlayerId) {
  const pending = stateOf(host).fennuPending?.[ownerId]
  if (!pending) return
  while (pending.index < pending.targetIds.length) {
    const targetId = pending.targetIds[pending.index]!
    const target = playerOf(host.state, targetId)
    const cardIds = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (target?.alive && cardIds.length) {
      askCards(host, FENNU, ownerId, 'card', `【奋驽】：选择${target.nickname}弃置的一张牌置为“逸”`, targetId, cardIds, { targetId })
      return
    }
    pending.index += 1
  }
  delete stateOf(host).fennuPending?.[ownerId]
}

function availableHunTianYi(host: SkillHost): CardId[] {
  return [...host.state.zones.drawPile, ...host.state.zones.discardPile]
    .filter((cardId) => host.state.cards[cardId]?.specialEquipment === HUNTIANYI)
}

function installHunTianYi(host: SkillHost, ownerId: PlayerId, cardId: CardId): boolean {
  const owner = playerOf(host.state, ownerId)
  const source = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const }
    : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : undefined
  if (!owner?.alive || !source || host.state.cards[cardId]?.specialEquipment !== HUNTIANYI) return false
  const previousId = owner.zones.equipment.treasure
  if (previousId) {
    moveCard(host.state, previousId, { kind: 'equipment', playerId: ownerId, slot: 'treasure' }, { kind: 'discardPile' })
    handleEquipmentLost(host as never, ownerId, previousId)
    dispatchEquipmentZoneLoss(host as never, ownerId, [previousId])
  }
  moveCard(host.state, cardId, source, { kind: 'equipment', playerId: ownerId, slot: 'treasure' })
  return true
}

function askZeleiTarget(host: SkillHost, ownerId: PlayerId) {
  const owner = playerOf(host.state, ownerId)
  const family = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  const candidates = host.state.players.filter((player) => player.alive && player.characterId
    && family && clanOfCharacter(player.characterId) === family).map((player) => player.id)
  if (!candidates.length) return
  host.askSkill({ skillId: ZELEI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【泽烈】：选择一名角色，其本回合下一次摸牌或弃牌后再摸一张或弃一张牌',
    timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
  }) })
}

function queueZeleiAfterFieldLoss(host: SkillHost, ownerId: PlayerId, lostPlayerId: PlayerId | undefined) {
  if (!lostPlayerId) return
  const owner = playerOf(host.state, ownerId)
  const source = playerOf(host.state, lostPlayerId)
  const family = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  if (!source?.characterId || !family || clanOfCharacter(source.characterId) !== family || fieldCardCount(source) > 0) return
  const state = stateOf(host)
  state.zeleiPending ??= {}
  if (state.zeleiPending[ownerId] === lostPlayerId) return
  state.zeleiPending[ownerId] = lostPlayerId
  host.queueSkill({ skillId: ZELEI, ownerId, step: 'trigger', data: { lostPlayerId } })
}

registerSkillRuntime({ id: ZELEI, triggers: [
  { event: 'LoseCard', handle(host, ownerId, context) {
    const lost = context.event.payload as { playerId?: PlayerId }
    queueZeleiAfterFieldLoss(host, ownerId, lost.playerId)
  } },
  { event: 'FieldCardMoved', handle(host, ownerId, context) {
    const movement = context.event.payload as { fromPlayerId?: PlayerId }
    queueZeleiAfterFieldLoss(host, ownerId, movement.fromPlayerId)
  } },
  { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
    const movement = context.event.payload as { fromPlayerId?: PlayerId; fromKind?: string }
    if (movement.fromKind !== 'equipment' && movement.fromKind !== 'judgingArea') return
    queueZeleiAfterFieldLoss(host, ownerId, movement.fromPlayerId)
  } },
  { event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; isDraw?: boolean }
    const state = stateOf(host)
    const followup = payload.playerId ? state.zeleiFollowup?.[ownerId] : undefined
    if (!followup || followup.targetId !== payload.playerId || !payload.isDraw
      || followup.turnNumber !== host.state.turnNumber) return
    delete state.zeleiFollowup?.[ownerId]
    drawCards(host.state, host.rng, followup.targetId, 1, (name, data) => host.dispatch(name, data))
  } },
  { event: 'LoseCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
    const state = stateOf(host)
    const followup = payload.playerId ? state.zeleiFollowup?.[ownerId] : undefined
    if (!followup || followup.targetId !== payload.playerId || followup.turnNumber !== host.state.turnNumber) return
    const discarded = (payload.cardIds ?? []).some((cardId) => host.state.zones.discardPile.includes(cardId))
    if (!discarded) return
    const target = playerOf(host.state, followup.targetId)
    if (!target?.alive) { delete state.zeleiFollowup?.[ownerId]; return }
    const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cards.length) { delete state.zeleiFollowup?.[ownerId]; return }
    delete state.zeleiFollowup?.[ownerId]
    host.queueSkill({ skillId: ZELEI, ownerId, step: 'extra-discard', data: { targetId: followup.targetId } })
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId }
    const state = stateOf(host)
    if (state.zeleiFollowup?.[ownerId]?.turnNumber === host.state.turnNumber) delete state.zeleiFollowup[ownerId]
    if (payload.playerId === state.zeleiPending?.[ownerId] && state.zeleiPending) delete state.zeleiPending[ownerId]
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'trigger') {
    if (!playerOf(host.state, ownerId)?.alive) return
    askZeleiTarget(host, ownerId)
  } else if (prompt.step === 'extra-discard') {
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cards = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (target?.alive && cards.length) askCards(host, ZELEI, ownerId, 'extra-discard', '【泽烈】：额外弃置一张牌', targetId, cards, { targetId })
  }
}, resume(host, ownerId, resolution, response) {
  const state = stateOf(host)
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    const owner = playerOf(host.state, ownerId)
    const family = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
    const lostPlayerId = state.zeleiPending?.[ownerId]
    if (!family || !lostPlayerId) return
    if (state.zeleiPending) delete state.zeleiPending[ownerId]
    state.zeleiFollowup ??= {}
    state.zeleiFollowup[ownerId] = { targetId, turnNumber: host.state.turnNumber }
    return
  }
  if (resolution.step === 'extra-discard') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (cardId && locateOwnedCard(host.state, targetId, cardId)) discardCardsByIds(host as never, targetId, [cardId], ZELEI)
  }
} })

registerSkillRuntime({ id: SHIZE, triggers: [
  { event: 'CardResponded', handle(host, ownerId, context) {
    const payload = context.event.payload as { asking?: boolean }
    const resolution = host.state.cardResolution as { sourceId?: PlayerId } | null
    if (payload.asking || host.state.currentPlayerId !== ownerId || resolution?.sourceId !== ownerId) return
    const state = stateOf(host)
    state.shizeUsedTurn ??= {}
    if (state.shizeUsedTurn[ownerId] === host.state.turnNumber) return
    const owner = playerOf(host.state, ownerId)
    const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
    const candidates = host.state.players.filter((player) => player.alive && player.characterId && clan
      && clanOfCharacter(player.characterId) === clan).map((player) => player.id)
    if (!candidates.length) return
    state.shizeUsedTurn[ownerId] = host.state.turnNumber
    host.queueSkill({ skillId: SHIZE, ownerId, step: 'grant', data: {} })
  } },
  { event: 'Damaged', handle(host, _ownerId, context) {
    const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
    if (!targetId) return
    const state = stateOf(host)
    const count = state.shizeBonus?.[targetId] ?? 0
    if (!count) return
    const target = playerOf(host.state, targetId)
    if (target) target.attackRangeBonus -= count
    delete state.shizeBonus?.[targetId]
  } },
  { event: 'Death', handle(host, _ownerId, context) {
    const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
    if (!targetId) return
    const state = stateOf(host)
    const count = state.shizeBonus?.[targetId] ?? 0
    const target = playerOf(host.state, targetId)
    if (count && target) target.attackRangeBonus -= count
    if (state.shizeBonus) delete state.shizeBonus[targetId]
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'grant') return
  const owner = playerOf(host.state, ownerId)
  const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  const candidates = host.state.players.filter((player) => player.alive && player.characterId && clan
    && clanOfCharacter(player.characterId) === clan).map((player) => player.id)
  if (candidates.length) askTargets(host, SHIZE, ownerId, 'target', '【士则】：令一名同族角色攻击范围+1，直到其受到伤害', candidates, {}, false)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'target') return
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const owner = playerOf(host.state, ownerId)
  const target = targetId ? playerOf(host.state, targetId) : undefined
  const clan = owner?.characterId ? clanOfCharacter(owner.characterId) : undefined
  if (!target?.alive || !target.characterId || !clan || clanOfCharacter(target.characterId) !== clan) return
  target.attackRangeBonus += 1
  const state = stateOf(host)
  state.shizeBonus ??= {}
  state.shizeBonus[targetId!] = (state.shizeBonus[targetId!] ?? 0) + 1
} })

export const HISTORICAL_BATCH69_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'clan-yangbiao-b69', name: '族·杨彪', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'hongnong-yang', skills: [quhuo, sk('jiannan-yangbiao', '间难', '出牌阶段开始时，你可以摸两张牌。然后此阶段有角色失去所有“间难”牌或所有手牌后，若没有角色处于濒死状态，你令一名角色执行一项：1.弃置两张牌；2.摸两张牌；3.重铸所有装备牌；4.将一张锦囊牌置于牌堆顶或失去1点体力。每回合每项限一次。'), sk('yichi-yangbiao', '义叱', '结束阶段，你可以拼点，若你赢，没赢的角色依次执行“间难”前X项（X为你本回合发动“间难”次数）。')] },
  { id: 'clan-luji-b69', name: '族·陆绩', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', clan: 'lujiang-lu', skills: [sk('gailan-luji', '该览', '锁定技，游戏开始时，你将四张【浑天仪】洗入牌堆。回合开始时，你将牌堆或弃牌堆中一张【浑天仪】置于装备区。', true), sk('fennu-luji', '奋驽', '出牌阶段开始时，你可以令至多X名角色各弃置一张牌，将这些牌置于你的武将牌上，称为“逸”（X为你当前体力值）。若你武将牌上有“逸”，你使用牌指定目标时，记录此牌点数。准备阶段，若记录点数大于“逸”的点数和，你清除记录并获得所有“逸”。'), zelei] },
  { id: 'clan-wangguang-b69', name: '族·王广', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [zhongliu, sk('lilun-wangguang', '离论', '出牌阶段限一次，你可以重铸两张同名牌（不能是本回合重铸过的牌名）并使用其中一张牌。'), sk('jianji-wangguang', '见机', '限定技，每名角色的回合结束时，若其相邻角色此回合：1.未使用过牌，你可以与其各摸一张牌；2.未成为过牌的目标，你可以视为使用一张【杀】。')] },
  { id: 'clan-wangmingshan-b69', name: '族·王明山', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [zhongliu, sk('tanque-wangmingshan', '弹雀', '每回合限一次，当你使用牌后，你可以对一名体力值为X的角色造成1点伤害（X为此牌点数与你上一张使用的牌的点数之差且不为0）。'), sk('shengmo-wangmingshan', '剩墨', '每轮限一次，当你需要使用基本牌时，你可以获得本回合弃牌堆中的一张牌（不能是以此法选择过的点数）。若此牌点数不为最大或最小，你视为使用未以此法使用过的基本牌。')] },
  { id: 'clan-yangzhong-b69', name: '族·杨众', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', clan: 'hongnong-yang', skills: [quhuo, sk('juetu-yangzhong', '绝途', '锁定技，弃牌阶段开始时，你改为保留手牌中每个花色各一张，将其余手牌置入弃牌堆。然后你令一名角色展示一张手牌，若你手牌中没有此花色的牌，你对其造成1点伤害；若有，你将其展示牌当【过河拆桥】使用。', true), sk('kudu-yangzhong', '苦渡', '限定技，出牌阶段，你可以重铸两张牌，令一名角色下X个回合结束时摸一张牌，第X个回合后其执行一个额外回合（X为你重铸牌点数差且至多为5）。')] },
  { id: 'clan-lujing-b69', name: '族·陆景', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', clan: 'wu-lu', skills: [zelei, sk('tanfeng-lujing', '探锋', '出牌阶段限一次，你可对一名角色视为使用一张无视防具的【杀】（不计次数）。若此【杀】造成伤害，你摸X张牌（X为其装备区与你装备区内牌数量的差）；若未造成伤害，其可视为对你使用一张【杀】。'), sk('juewei-lujing', '绝围', '每回合限一次，当你使用伤害牌指定目标后，或成为伤害牌的目标后，你可选择一项：重铸一张装备牌，此伤害牌结算完成后，你视为对其中一个除自己外的目标使用此牌；弃置一张装备牌，令此牌无效。')] },
  { id: 'clan-xunyu-b69', name: '族·荀彧', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-xun', skills: [daojie, sk('dingan-xunyu', '定安', '锁定技，当一个牌名的牌每回合第二次被使用后，若本回合未有角色进入过濒死状态，你与一名非目标角色各摸一张牌（每回合每名角色限一次），然后你对手牌最多的其他角色造成1点伤害，或令其弃置手牌中最多的同名牌。', true), sk('funing-xunyu', '抚宁', '每轮你的体力值首次变化后，你可将至少X张牌交给一名角色（X为你已损失体力值）。若交给的牌颜色均相同，你回复1点体力；数量大于本回合受到过伤害的角色数，你将手牌调整至体力上限。')] },
  { id: 'clan-chenqun-b69', name: '族·陈群', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-chen', skills: [shize, sk('gezhi-chenqun', '革制', '每回合限一次，当你或你攻击范围内的角色受到其他角色的伤害后，你可弃置你与伤害来源各一张牌，且可任意分配。若弃置牌的类别不同，你与伤害来源本回合只能使用这些类别的牌。'), sk('mingdian-chenqun', '明典', '出牌阶段或当你受到伤害后，你可重铸任意张基本牌（每轮每个牌名限一次）。若重铸了你本回合使用过的牌名，你获得一张手牌中未拥有牌名的基本牌。')] },
  { id: 'clan-xunshi-b69', name: '族·荀莳', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', clan: 'yingchuan-xun', skills: [daojie, sk('qingjue-xunshi', '清绝', '锁定技，你手牌中每个花色仅一张的牌，不计入手牌上限。当你每回合体力值首次变化后，你弃置手牌中任意张花色数量不为一的牌，并执行以下等量项：1.将这些牌交给一名其他角色；2.获得手牌中未拥有花色的牌各一张。', true), sk('yingxiang-xunshi', '萦香', '锁定技，其他角色获得你的牌称为“萦香”。“萦香”被使用后，你和有“萦香”的角色各摸一张牌。若“萦香”不因使用而失去，你发动一次“清绝”（每轮限一次）。', true)] },
  { id: 'clan-luyusheng-b69', name: '族·陆郁生', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', clan: 'wu-lu', skills: [zelei, sk('shixi-luyusheng', '拾昔', '你首次使用一个花色的单目标普通锦囊牌时，记录牌名和花色。当你需要使用记录牌时，你可将所有对应花色的牌置入弃牌堆，视为使用之。'), sk('jianbai-luyusheng', '坚白', '锁定技，你每回合首次使用一种类型的牌后，你保留一个花色，重铸其余牌。此回合结束时，你交给一名其他角色一张牌并摸X张牌（X为此牌本回合被保留的次数）。', true)] },
]

const JIANNAN = sid('jiannan-yangbiao')
registerSkillRuntime({ id: JIANNAN, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const state = stateOf(host)
    state.jiannan ??= {}
    if (state.jiannan[ownerId]?.turnNumber === host.state.turnNumber) return
    state.jiannan[ownerId] = { turnNumber: host.state.turnNumber, uses: 0, usedOptions: [] }
    host.askSkill({ skillId: JIANNAN, ownerId, step: 'invoke', data: {}, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【间难】：是否摸两张牌？', timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '摸两张牌并发动间难' }, { id: 'no', label: '不发动' }] }) })
  } },
  { event: 'HandCardLeft', handle(host, ownerId, context) {
    const state = stateOf(host)
    const entry = state.jiannan?.[ownerId]
    if (!entry || entry.uses <= 0 || entry.turnNumber !== host.state.turnNumber || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || entry.usedOptions.length >= 4 || host.state.dying) return
    const movement = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
    const playerId = movement.playerId
    if (!playerId) return
    const player = playerOf(host.state, playerId)
    if (!player) return
    const markedLeft = Boolean(movement.cardId && state.jiannanMarks?.[movement.cardId])
    const remainingMarked = player.zones.hand.some((cardId) => state.jiannanMarks?.[cardId])
    const lostAllMarked = markedLeft && !remainingMarked
    const lostAllHand = player.zones.hand.length === 0
    if (!lostAllMarked && !lostAllHand) return
    host.queueSkill({ skillId: JIANNAN, ownerId, step: 'trigger', data: { playerId } })
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play') return
    const state = stateOf(host)
    const entry = state.jiannan?.[ownerId]
    if (entry?.turnNumber === host.state.turnNumber) {
      state.jiannanTurnCount ??= {}
      state.jiannanTurnCount[ownerId] = { turnNumber: host.state.turnNumber, count: entry.uses }
      state.jiannanMarks = {}
      delete state.jiannan?.[ownerId]
    }
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'trigger') return
  const entry = stateOf(host).jiannan?.[ownerId]
  if (!entry || entry.turnNumber !== host.state.turnNumber || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play' || host.state.dying) return
  askJianNanOptions(host, ownerId, entry)
}, resume(host, ownerId, resolution, response) {
  const state = stateOf(host)
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes' || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    const entry = state.jiannan?.[ownerId]
    if (!entry || entry.turnNumber !== host.state.turnNumber) return
    entry.uses = 1
    markJianNanCards(host, drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data)))
    return
  }
  if (resolution.step === 'effect') {
    const optionId = (response.payload as { optionId?: string }).optionId
    const entry = state.jiannan?.[ownerId]
    const allowed = resolution.data.options as string[]
    if (!optionId || !allowed.includes(optionId) || !entry || entry.turnNumber !== host.state.turnNumber || entry.usedOptions.includes(optionId)) return
    entry.usedOptions.push(optionId)
    entry.uses += 1
    const candidates = host.state.players.filter((player) => player.alive && (optionId !== 'discard' || player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length >= 2)).map((player) => player.id)
    if (candidates.length) askTargets(host, JIANNAN, ownerId, 'target', '【间难】：选择执行此项的角色', candidates, { optionId, uses: entry.uses }, false)
    return
  }
  if (resolution.step === 'target') {
    const optionId = resolution.data.optionId as string
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    if (optionId === 'discard') {
      const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
      if (cards.length >= 2) askCards(host, JIANNAN, ownerId, 'discard', '【间难】：选择两张牌弃置', targetId!, cards, { targetId }, 2)
    } else if (optionId === 'draw') {
      markJianNanCards(host, drawCards(host.state, host.rng, targetId!, 2, (name, data) => host.dispatch(name, data)))
    } else if (optionId === 'recast') {
      const equipmentIds = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
        .filter((cardId) => host.state.cards[cardId]?.category === 'equipment')
      if (equipmentIds.length) {
        discardCardsByIds(host as never, targetId!, equipmentIds, `${JIANNAN}:recast`, 'other')
        markJianNanCards(host, drawCards(host.state, host.rng, targetId!, equipmentIds.length, (name, data) => host.dispatch(name, data)))
      }
    } else if (optionId === 'top-or-hp') {
      const tricks = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'trick')
      if (!tricks.length) { loseHp(host as never, targetId!, 1, JIANNAN); return }
      host.askSkill({ skillId: JIANNAN, ownerId, step: 'top-mode', data: { targetId, trickIds: tricks }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: targetId!, prompt: '【间难】：将一张手牌锦囊置于牌堆顶，或失去1点体力', timeoutMs: 25_000, optional: false, options: [{ id: 'top', label: '将锦囊牌置于牌堆顶' }, { id: 'lose-hp', label: '失去1点体力' }] }) })
    }
    return
  }
  if (resolution.step === 'discard') {
    const targetId = resolution.data.targetId as PlayerId
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (cards.length === 2 && cards.every((cardId) => handOf(host.state, targetId).includes(cardId) || Object.values(playerOf(host.state, targetId)?.zones.equipment ?? {}).includes(cardId))) discardCardsByIds(host as never, targetId, cards, JIANNAN)
    return
  }
  if (resolution.step === 'top-mode') {
    const targetId = resolution.data.targetId as PlayerId
    if ((response.payload as { optionId?: string }).optionId === 'top') askCards(host, JIANNAN, ownerId, 'top-card', '【间难】：选择置于牌堆顶的锦囊牌', targetId, (resolution.data.trickIds as CardId[]).filter((cardId) => handOf(host.state, targetId).includes(cardId)), { targetId })
    else loseHp(host as never, targetId, 1, JIANNAN)
    return
  }
  if (resolution.step === 'top-card') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (cardId && handOf(host.state, targetId).includes(cardId) && host.state.cards[cardId]?.category === 'trick') moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' }, { toTop: true })
  }
} })

registerSkillRuntime({ id: FENNU, triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
    const owner = playerOf(host.state, ownerId)
    if (!payload.targetIds?.length || !owner?.characterPiles[FENNU]?.length) return
    const rank = payload.cardId ? host.state.cards[payload.cardId]?.rank : undefined
    if (rank === undefined) return
    const state = stateOf(host)
    state.fennuRecord ??= {}
    state.fennuRecord[ownerId] = (state.fennuRecord[ownerId] ?? 0) + rank
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (phase.phase === 'play') {
      const candidates = host.state.players.filter((player) => player.alive && player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length > 0)
      const max = Math.min(owner.hp, candidates.length)
      if (!max) return
      host.askSkill({ skillId: FENNU, ownerId, step: 'targets', data: {}, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: `【奋驽】：选择至多${max}名角色，各弃置一张牌置为“逸”`, timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max }) })
    } else if (phase.phase === 'prepare') {
      const pile = owner.characterPiles[FENNU] ?? []
      const points = pile.reduce((sum, cardId) => sum + (host.state.cards[cardId]?.rank ?? 0), 0)
      if (!pile.length || (stateOf(host).fennuRecord?.[ownerId] ?? 0) <= points) return
      stateOf(host).fennuRecord![ownerId] = 0
      const gained = [...pile]
      for (const cardId of gained) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: FENNU }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: FENNU }, { targetId: ownerId, cardIds: gained })
      host.dispatch('SkillActivated', { skillId: FENNU, skillName: '奋驽', playerId: ownerId, logText: `${owner.nickname}获得所有“逸”` }, { sourceId: ownerId })
    }
  } },
], resume(host, ownerId, resolution, response) {
  const state = stateOf(host)
  if (resolution.step === 'targets') {
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      .filter((targetId) => playerOf(host.state, targetId)?.alive)
    state.fennuPending ??= {}
    state.fennuPending[ownerId] = { targetIds, index: 0, cardIds: [] }
    askFennuNextCard(host, ownerId)
    return
  }
  if (resolution.step !== 'card') return
  const targetId = resolution.data.targetId as PlayerId
  const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
  const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : undefined
  if (cardId && from && (from.kind === 'hand' || from.kind === 'equipment')) {
    const target = playerOf(host.state, targetId)
    moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: FENNU })
    state.fennuPending?.[ownerId]?.cardIds.push(cardId)
    if (from.kind === 'equipment' && target) {
      handleEquipmentLost(host as never, targetId, cardId, { batched: true })
      dispatchEquipmentZoneLoss(host as never, targetId, [cardId])
    }
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: FENNU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  }
  if (state.fennuPending?.[ownerId]) state.fennuPending[ownerId]!.index += 1
  askFennuNextCard(host, ownerId)
} })

const JUETU = sid('juetu-yangzhong')
registerSkillRuntime({ id: JUETU, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
  if (phase.playerId !== ownerId || phase.phase !== 'discard') return
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const keep = new Set<string>()
  const suitCounts = new Map<string, number>()
  const discarded: CardId[] = []
  for (const cardId of [...owner.zones.hand]) {
    const suit = host.state.cards[cardId]?.suit
    if (!suit) continue
    if ((suitCounts.get(suit) ?? 0) === 0) keep.add(cardId)
    suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1)
    if (!keep.has(cardId)) discarded.push(cardId)
  }
  if (discarded.length) discardCardsByIds(host as never, ownerId, discarded, JUETU)
  const candidates = host.state.players.filter((player) => player.alive && player.zones.hand.length > 0).map((player) => player.id)
  if (candidates.length) askTargets(host, JUETU, ownerId, 'target', '【绝途】：令一名角色弃置一张手牌', candidates, {}, false)
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId && playerOf(host.state, targetId)?.alive && handOf(host.state, targetId).length) askCards(host, JUETU, ownerId, 'reveal-target', '【绝途】：展示一张手牌', targetId, handOf(host.state, targetId), { targetId })
    return
  }
  if (resolution.step === 'reveal-target') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const target = playerOf(host.state, targetId)
    if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
    const suit = host.state.cards[cardId]?.suit
    const owner = playerOf(host.state, ownerId)
    host.dispatch('SkillActivated', { skillId: JUETU, skillName: '绝途', playerId: ownerId,
      logText: `${target.nickname}展示了一张手牌：${host.state.cards[cardId]?.name ?? ''}` }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    const stillHasSuit = owner?.zones.hand.some((heldId) => host.state.cards[heldId]?.suit === suit) ?? false
    if (suit && !stillHasSuit) {
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: JUETU })
      return
    }
    if (!target.alive || !owner?.alive) return
    const actions = skillOtherHandDeclaredCardUseActions(host.state, ownerId, targetId, cardId, '过河拆桥', JUETU)
    const candidates = [...new Set(actions.flatMap((action) => action.targetIds))]
    if (!candidates.length) return
    host.askSkill({ skillId: JUETU, ownerId, step: 'use-dismantlement', data: { cardId, physicalOwnerId: targetId }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【绝途】：将展示牌当【过河拆桥】使用，选择目标',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
    return
  }
  if (resolution.step === 'use-dismantlement') {
    const cardId = resolution.data.cardId as CardId
    const physicalOwnerId = resolution.data.physicalOwnerId as PlayerId
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId) host.beginSkillDeclaredCardUseFromOtherHand({
      playerId: ownerId, physicalOwnerId, cardId, asCardName: '过河拆桥', targetIds: [targetId], sourceSkillId: JUETU,
    })
  }
} })

registerSkillRuntime({ id: KUDU, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    const available = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (phase.playerId !== ownerId || phase.phase !== 'play' || !owner?.alive
      || owner.usedLimitedSkills.includes(KUDU) || available.length < 2) return
    askCards(host, KUDU, ownerId, 'recast', '【苦渡】：重铸两张牌', ownerId, available, {}, 2)
  } },
  { event: 'TurnEnd', handle(host, _ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
    if (!payload.playerId) return
    for (const [ownerId, pending] of Object.entries(stateOf(host).kuduPending ?? {}) as Array<[PlayerId, KuduPending]>) {
      const state = stateOf(host)
      if (pending.targetId !== payload.playerId || pending.armedTurn === payload.turnNumber) continue
      const target = playerOf(host.state, pending.targetId)
      if (!target?.alive) { delete state.kuduPending?.[ownerId]; continue }
      pending.turnsDone += 1
      drawCards(host.state, host.rng, pending.targetId, 1, (name, data) => host.dispatch(name, data))
      if (pending.turnsDone >= pending.waitTurns) {
        delete state.kuduPending?.[ownerId]
        queueExtraTurn(host.state, pending.targetId, { skillId: KUDU, playerId: ownerId })
      }
    }
  } },
], resume(host, ownerId, resolution, response) {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (resolution.step === 'recast') {
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const selected = [...new Set(cardIds)].filter((cardId) => locateOwnedCard(host.state, ownerId, cardId)?.kind === 'hand'
      || locateOwnedCard(host.state, ownerId, cardId)?.kind === 'equipment')
    if (selected.length !== 2 || owner.usedLimitedSkills.includes(KUDU)) return
    const ranks = selected.map((cardId) => host.state.cards[cardId]?.rank ?? 0)
    const lostEquipment = selected.filter((cardId) => locateOwnedCard(host.state, ownerId, cardId)?.kind === 'equipment')
    discardCardsByIds(host as never, ownerId, selected, `${KUDU}:recast`, 'other')
    for (const cardId of lostEquipment) handleEquipmentLost(host as never, ownerId, cardId, { batched: true })
    if (lostEquipment.length) dispatchEquipmentZoneLoss(host as never, ownerId, lostEquipment)
    drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
    host.askSkill({ skillId: KUDU, ownerId, step: 'target', data: { waitTurns: Math.min(5, Math.abs(ranks[0]! - ranks[1]!)) }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【苦渡】：选择一名角色；其之后的回合结束时摸牌并在最后执行额外回合',
      timeoutMs: 25_000, optional: false, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
    }) })
    return
  }
  if (resolution.step !== 'target') return
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  if (!targetId || !playerOf(host.state, targetId)?.alive || owner.usedLimitedSkills.includes(KUDU)) return
  owner.usedLimitedSkills.push(KUDU)
  const waitTurns = Number(resolution.data.waitTurns)
  if (waitTurns === 0) {
    queueExtraTurn(host.state, targetId, { skillId: KUDU, playerId: ownerId })
    return
  }
  stateOf(host).kuduPending ??= {}
  stateOf(host).kuduPending![ownerId] = { targetId, waitTurns, turnsDone: 0, armedTurn: host.state.turnNumber }
} })

const TANQUE = sid('tanque-wangmingshan')
registerSkillRuntime({ id: TANFENG, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play' || usedThisPhase(host.state, ownerId, TANFENG)
      || isCardUseProhibited(host.state, ownerId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && canTarget(host.state, ownerId, target.id)
      && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf, undefined, TANFENG))
    if (!candidates.length) return
    host.askSkill({ skillId: TANFENG, ownerId, step: 'invoke', data: { candidates: candidates.map((target) => target.id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【探锋】：是否视为使用一张无视防具且不计次数的【杀】？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动探锋' }, { id: 'no', label: '不发动' }],
    }) })
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== TANFENG || !payload.cardId) return
    stateOf(host).tanfengPending ??= {}
    const cardId = payload.cardId
    const targetId = (payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId) stateOf(host).tanfengPending![cardId] = { ownerId, targetId }
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const pending = cardId ? stateOf(host).tanfengPending?.[cardId] : undefined
    if (!cardId || !pending || pending.ownerId !== ownerId) return
    delete stateOf(host).tanfengPending?.[cardId]
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, pending.targetId)
    if (cardDamageDealt(host.state, cardId) > 0) {
      if (!owner || !target) return
      const ownerEquipment = Object.values(owner.zones.equipment).filter(Boolean).length
      const targetEquipment = Object.values(target.zones.equipment).filter(Boolean).length
      drawCards(host.state, host.rng, ownerId, Math.abs(targetEquipment - ownerEquipment), (name, data) => host.dispatch(name, data))
      return
    }
    if (!target?.alive || !owner?.alive || !canTarget(host.state, pending.targetId, ownerId)
      || isTargetProhibited(host.state, pending.targetId, ownerId, '杀', skillIdsOf, undefined, TANFENG)
      || isCardUseProhibited(host.state, pending.targetId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return
    host.queueSkill({ skillId: TANFENG, ownerId, step: 'backlash', data: { targetId: pending.targetId } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'backlash') return
  const targetId = prompt.data.targetId as PlayerId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive || !canTarget(host.state, targetId, ownerId)
    || isTargetProhibited(host.state, targetId, ownerId, '杀', skillIdsOf, undefined, TANFENG)
    || isCardUseProhibited(host.state, targetId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return
  askOption(host, TANFENG, ownerId, 'backlash', '【探锋】：是否视为对陆景使用一张【杀】？', { targetId }, targetId)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const candidates = (resolution.data.candidates as PlayerId[]).filter((targetId) => {
      const target = playerOf(host.state, targetId)
      return target?.alive && canTarget(host.state, ownerId, targetId)
        && !isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf, undefined, TANFENG)
    })
    if (!candidates.length) return
    askTargets(host, TANFENG, ownerId, 'target', '【探锋】：选择【杀】的目标', candidates, {}, false)
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive || !canTarget(host.state, ownerId, targetId)
      || isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf, undefined, TANFENG)) return
    markUsedThisPhase(host.state, ownerId, TANFENG)
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: TANFENG, ignoreArmor: true, countUsage: false })
    return
  }
  if (resolution.step === 'backlash') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive || !playerOf(host.state, ownerId)?.alive
      || !canTarget(host.state, targetId, ownerId)
      || isTargetProhibited(host.state, targetId, ownerId, '杀', skillIdsOf, undefined, TANFENG)) return
    host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: TANFENG, countUsage: false })
  }
} })

registerSkillRuntime({ id: TANQUE, triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
  if (context.event.sourceId !== ownerId) return
  const payload = context.event.payload as { cardId?: CardId }
  const cardId = payload.cardId
  const rank = cardId ? host.state.cards[cardId]?.rank : undefined
  if (rank === undefined) return
  const state = stateOf(host)
  const previous = state.tanquePrevious?.[ownerId]
  state.tanquePrevious ??= {}
  state.tanquePrevious[ownerId] = { turnNumber: host.state.turnNumber, rank }
  if (!previous || previous.turnNumber !== host.state.turnNumber || state.tanqueUsed?.[ownerId] === host.state.turnNumber) return
  const difference = Math.abs(rank - previous.rank)
  if (difference === 0) return
  const candidates = host.state.players.filter((player) => player.alive && player.hp === difference).map((player) => player.id)
  if (candidates.length) askOption(host, TANQUE, ownerId, 'invoke', `【弹雀】：是否对体力值为${difference}的角色造成1点伤害？`, { difference, candidates })
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const difference = Number(resolution.data.difference)
    stateOf(host).tanqueUsed ??= {}
    stateOf(host).tanqueUsed![ownerId] = host.state.turnNumber
    askTargets(host, TANQUE, ownerId, 'target', `【弹雀】：选择体力值为${difference}的角色`, resolution.data.candidates as PlayerId[], { difference })
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const difference = Number(resolution.data.difference)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (target?.alive && target.hp === difference) resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, reason: TANQUE })
  }
} })

const SHENGMO_BASIC_NAMES = ['杀', '闪', '桃', '酒'] as const
function shengmoCandidateCards(host: SkillHost, ownerId: PlayerId): CardId[] {
  const chosen = new Set(stateOf(host).shengmoChosenRanks?.[ownerId] ?? [])
  return host.state.zones.discardPile.filter((cardId) =>
    stateOf(host).shengmoDiscardTurn?.[cardId] === host.state.turnNumber
    && !chosen.has(host.state.cards[cardId]?.rank ?? -1))
}
function shengmoPointExtremes(host: SkillHost): { min: number; max: number } | null {
  const ranks = host.state.zones.discardPile
    .filter((cardId) => stateOf(host).shengmoDiscardTurn?.[cardId] === host.state.turnNumber)
    .map((cardId) => host.state.cards[cardId]?.rank)
    .filter((rank): rank is Rank => typeof rank === 'number')
  return ranks.length ? { min: Math.min(...ranks), max: Math.max(...ranks) } : null
}
registerSkillRuntime({ id: SHENGMO,
  triggers: [{ event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId) return
    ;(stateOf(host).shengmoDiscardTurn ??= {})[cardId] = host.state.turnNumber
  } }],
  virtualBasicResponse(state, ownerId, requiredCardName) {
    const runtimeHost = { state } as SkillHost
    return SHENGMO_BASIC_NAMES.includes(requiredCardName as typeof SHENGMO_BASIC_NAMES[number])
      && !isCardResponseProhibited(state, ownerId, requiredCardName, skillIdsOf)
      && (state.roundNumber ?? 1) !== stateOf(runtimeHost).shengmoUsedRound?.[ownerId]
      && shengmoCandidateCards(runtimeHost, ownerId).length > 0
  },
  rescueActions(state, ownerId) {
    const runtimeHost = { state } as SkillHost
    if ((state.roundNumber ?? 1) === stateOf(runtimeHost).shengmoUsedRound?.[ownerId]
      || !shengmoCandidateCards(runtimeHost, ownerId).length
      || isCardUseProhibited(state, ownerId, '桃', { dyingPlayerId: state.dying?.playerId ?? null })) return []
    return [{ id: `${SHENGMO}:rescue`, label: '剩墨：选择本回合弃牌堆中的一张牌，尝试作为【桃】使用' }]
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== `${SHENGMO}:rescue` || host.state.dying?.playerId !== dyingPlayerId
      || (host.state.roundNumber ?? 1) === stateOf(host).shengmoUsedRound?.[ownerId]) return false
    const cardIds = shengmoCandidateCards(host, ownerId)
    if (!cardIds.length) return false
    askCards(host, SHENGMO, ownerId, 'rescue-card', '【剩墨】：选择本回合弃牌堆中的一张牌获得；若点数不为极值，视为使用【桃】', ownerId, cardIds, { dyingPlayerId })
    return 'deferred'
  },
  beginVirtualBasicResponse(host, ownerId, requiredCardName, rawRequest) {
    if (!rawRequest || rawRequest.kind !== 'respond-card'
      || !SHENGMO_BASIC_NAMES.includes(requiredCardName as typeof SHENGMO_BASIC_NAMES[number])
      || (host.state.roundNumber ?? 1) === stateOf(host).shengmoUsedRound?.[ownerId]) return false
    const cardIds = shengmoCandidateCards(host, ownerId)
    if (!cardIds.length) return false
    host.askSkill({ skillId: SHENGMO, ownerId, step: 'discard-card', data: { request: rawRequest, requiredCardName }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【剩墨】：选择本回合弃牌堆中的一张牌获得；若点数不为最大或最小，视为使用【${requiredCardName}】`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'rescue-card') {
      const dyingPlayerId = resolution.data.dyingPlayerId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const state = stateOf(host)
      const roundNumber = host.state.roundNumber ?? 1
      if (!cardId || !shengmoCandidateCards(host, ownerId).includes(cardId)
        || !host.state.zones.discardPile.includes(cardId) || host.state.dying?.playerId !== dyingPlayerId) {
        const dying = host.state.dying
        if (dying) { dying.responderIndex += 1; continueDyingRescue(host as never) }
        return
      }
      const card = host.state.cards[cardId]
      const extremes = shengmoPointExtremes(host)
      state.shengmoUsedRound ??= {}
      state.shengmoUsedRound[ownerId] = roundNumber
      state.shengmoChosenRanks ??= {}
      state.shengmoChosenRanks[ownerId] ??= []
      state.shengmoChosenRanks[ownerId]!.push(card?.rank ?? -1)
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHENGMO }, { targetId: ownerId, cardIds: [cardId] })
      const usedNames = state.shengmoUsedNames?.[ownerId] ?? []
      const canUsePeach = Boolean(card && extremes && card.rank !== extremes.min && card.rank !== extremes.max
        && !usedNames.includes('桃') && !isCardUseProhibited(host.state, ownerId, '桃', { dyingPlayerId }))
      if (canUsePeach && host.useVirtualPeachDuringDying(ownerId, dyingPlayerId, SHENGMO, [cardId])) {
        state.shengmoUsedNames ??= {}
        state.shengmoUsedNames[ownerId] ??= []
        state.shengmoUsedNames[ownerId]!.push('桃')
        return
      }
      const dying = host.state.dying
      if (dying) { dying.responderIndex += 1; continueDyingRescue(host as never) }
      return
    }
    if (resolution.step !== 'discard-card') return
    const request = resolution.data.request as RespondCardRequest
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const roundNumber = host.state.roundNumber ?? 1
    const eligible = shengmoCandidateCards(host, ownerId)
    if (!cardId || !eligible.includes(cardId) || !host.state.zones.discardPile.includes(cardId)) {
      resumeCardResponseAsPass(host as never, request)
      return
    }
    const card = host.state.cards[cardId]
    if (!card) { resumeCardResponseAsPass(host as never, request); return }
    const extremes = shengmoPointExtremes(host)
    const state = stateOf(host)
    state.shengmoUsedRound ??= {}
    state.shengmoUsedRound[ownerId] = roundNumber
    state.shengmoChosenRanks ??= {}
    state.shengmoChosenRanks[ownerId] ??= []
    state.shengmoChosenRanks[ownerId]!.push(card.rank)
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHENGMO }, { targetId: ownerId, cardIds: [cardId] })
    const usedNames = state.shengmoUsedNames?.[ownerId] ?? []
    const canUse = Boolean(extremes && card.rank !== extremes.min && card.rank !== extremes.max
      && !usedNames.includes(request.requiredCardName)
      && !isCardResponseProhibited(host.state, ownerId, request.requiredCardName, skillIdsOf))
    if (canUse) {
      const completed = host.state.cardResolution?.kind === 'trick'
        ? completeVirtualTrickBasicResponse(host as never, ownerId, request.requiredCardName, SHENGMO, [cardId])
        : completeVirtualBasicResponse(host as never, ownerId, request.requiredCardName, SHENGMO, [cardId])
      if (completed) {
        state.shengmoUsedNames ??= {}
        state.shengmoUsedNames[ownerId] ??= []
        state.shengmoUsedNames[ownerId]!.push(request.requiredCardName)
        return
      }
    }
    resumeCardResponseAsPass(host as never, request)
  },
})

function jianjiTargetsForTurn(host: SkillHost, turnOwnerId: PlayerId, turnNumber: number): PlayerId[] {
  if (!playerOf(host.state, turnOwnerId)?.alive) return []
  const state = stateOf(host)
  return host.state.players.filter((candidate) => candidate.alive && candidate.id !== turnOwnerId
    && getSeatDistance(host.state, turnOwnerId, candidate.id) === 1
    && (!host.state.cardUseHistory?.some((use) => use.turnNumber === turnNumber && use.sourceId === candidate.id)
      || state.jianjiTargetedTurn?.[candidate.id] !== turnNumber))
    .map((candidate) => candidate.id)
}

function lilunPreviewActions(host: SkillHost, ownerId: PlayerId, cardId: CardId) {
  const snapshot = structuredClone(host.state)
  snapshot.zones.discardPile = snapshot.zones.discardPile.filter((id) => id !== cardId)
  const owner = snapshot.players.find((player) => player.id === ownerId)
  if (!owner || !snapshot.cards[cardId]) return []
  owner.zones.hand.push(cardId)
  return skillHandCardUseActions(snapshot, ownerId, cardId)
}
function lilunUsableNameGroups(host: SkillHost, ownerId: PlayerId): Map<string, CardId[]> {
  const recast = stateOf(host).lilunRecastNames?.[ownerId]
  const alreadyRecast = recast?.turnNumber === host.state.turnNumber ? new Set(recast.names) : new Set<string>()
  const groups = new Map<string, CardId[]>()
  for (const cardId of handOf(host.state, ownerId)) {
    const card = host.state.cards[cardId]
    if (!card?.name || alreadyRecast.has(card.name)) continue
    groups.set(card.name, [...(groups.get(card.name) ?? []), cardId])
  }
  for (const [name, ids] of groups) {
    if (ids.length < 2 || !ids.some((cardId) => lilunPreviewActions(host, ownerId, cardId).length)) groups.delete(name)
  }
  return groups
}
function askLilunCardPair(host: SkillHost, ownerId: PlayerId, name: string) {
  const ids = lilunUsableNameGroups(host, ownerId).get(name) ?? []
  if (ids.length < 2) return
  askCards(host, LILUN, ownerId, 'recast-pair', `【离论】：选择两张【${name}】重铸`, ownerId, ids, { name }, 2)
}
function askLilunUseChoice(host: SkillHost, ownerId: PlayerId, cardId: CardId) {
  const actions = lilunPreviewActions(host, ownerId, cardId)
  if (!actions.length) return
  host.askSkill({ skillId: LILUN, ownerId, step: 'use-card', data: { cardId, actionIds: actions.map((action) => action.id) }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【离论】：选择如何使用重铸的【${host.state.cards[cardId]?.name ?? '牌'}】`,
    timeoutMs: 25_000, optional: false,
    options: actions.map((action) => ({ id: action.id, label: action.label })),
  }) })
}
registerSkillRuntime({ id: LILUN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, LILUN)) return []
    const names = lilunUsableNameGroups({ state } as SkillHost, ownerId)
    return names.size ? [{ id: `skill:${LILUN}`, label: '离论：重铸两张同名牌并使用其中一张' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${LILUN}`) throw new Error('离论动作不匹配')
    const names = [...lilunUsableNameGroups(host, ownerId).entries()]
    if (!names.length) return
    host.askSkill({ skillId: LILUN, ownerId, step: 'choose-name', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【离论】：选择一个本回合尚未重铸过的牌名',
      timeoutMs: 25_000, optional: false, options: names.map(([name, ids]) => ({ id: name, label: `重铸两张【${name}】（${ids.length}张可选）` })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-name') {
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !(lilunUsableNameGroups(host, ownerId).get(name)?.length)) return
      askLilunCardPair(host, ownerId, name)
      return
    }
    if (resolution.step === 'recast-pair') {
      const name = String(resolution.data.name ?? '')
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const legal = new Set(lilunUsableNameGroups(host, ownerId).get(name) ?? [])
      if (ids.length !== 2 || !ids.every((cardId) => legal.has(cardId) && handOf(host.state, ownerId).includes(cardId))) return
      const discarded = discardCardsByIds(host as never, ownerId, ids, `${LILUN}:recast`, 'other')
      if (discarded.length !== 2) return
      markUsedThisPhase(host.state, ownerId, LILUN)
      const record = stateOf(host).lilunRecastNames ??= {}
      if (record[ownerId]?.turnNumber !== host.state.turnNumber) record[ownerId] = { turnNumber: host.state.turnNumber, names: [] }
      if (!record[ownerId]!.names.includes(name)) record[ownerId]!.names.push(name)
      drawCards(host.state, host.rng, ownerId, 2, (eventName, payload) => host.dispatch(eventName, payload))
      const useable = ids.filter((cardId) => host.state.zones.discardPile.includes(cardId)
        && lilunPreviewActions(host, ownerId, cardId).length)
      if (useable.length) askCards(host, LILUN, ownerId, 'choose-used-card', `【离论】：选择一张重铸牌使用`, ownerId, useable, { cardIds: useable }, 1)
      return
    }
    if (resolution.step === 'choose-used-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !((resolution.data as Record<string, unknown>).cardIds as CardId[] | undefined)?.includes(cardId)) return
      if (!host.state.zones.discardPile.includes(cardId)) return
      askLilunUseChoice(host, ownerId, cardId)
      return
    }
    if (resolution.step === 'use-card') {
      const cardId = resolution.data.cardId as CardId
      const actionId = (response.payload as { optionId?: string }).optionId
      if (!actionId || !(resolution.data.actionIds as string[]).includes(actionId)
        || !host.state.zones.discardPile.includes(cardId) || !lilunPreviewActions(host, ownerId, cardId).some((action) => action.id === actionId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
      if (!host.beginSkillCardUseFromProcessing(ownerId, cardId, LILUN, actionId)
        && host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
  },
})

function shixiRecords(state: SanguoshaState, ownerId: PlayerId): Array<{ name: string; suit: Suit }> {
  return (state as Batch69State).b69?.shixiRecords?.[ownerId] ?? []
}
function shixiUseActions(host: SkillHost, ownerId: PlayerId, record: { name: string; suit: string }) {
  if (!INSTANT_TRICKS.has(record.name)) return []
  const carriers = handOf(host.state, ownerId).filter((cardId) =>
    effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf) === record.suit)
  return carriers.flatMap((cardId) => declaredCardActions(host.state, ownerId, cardId, record.name,
    `【拾昔】：将${record.suit}牌当【${record.name}】使用`))
    .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
}
function shixiActionId(record: { name: string; suit: Suit }) {
  return `skill:${SHIXI}:${encodeURIComponent(record.suit)}:${encodeURIComponent(record.name)}`
}
function askShixiUse(host: SkillHost, ownerId: PlayerId, record: { name: string; suit: Suit }) {
  const actions = shixiUseActions(host, ownerId, record)
  if (!actions.length) return
  const carrierByAction = Object.fromEntries(actions.map((action) => [action.id, action.cardIds[0]]))
  host.askSkill({ skillId: SHIXI, ownerId, step: 'choose-use', data: { record, carrierByAction, actionIds: actions.map((action) => action.id) }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【拾昔】：选择如何使用记录的【${record.name}】`,
    timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
  }) })
}
registerSkillRuntime({ id: SHIXI,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; virtual?: boolean }
    if (!payload.cardId || payload.virtual || !payload.cardName || !INSTANT_TRICKS.has(payload.cardName)
      || payload.targetIds?.length !== 1) return
    const records = stateOf(host).shixiRecords ??= {}
    const ownerRecords = records[ownerId] ??= []
    const suit = effectiveCardSuit(host.state, ownerId, payload.cardId, skillIdsOf)
    if (ownerRecords.some((record) => record.suit === suit)) return
    ownerRecords.push({ name: payload.cardName, suit })
  } }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    return shixiRecords(state, ownerId).filter((record) => shixiUseActions({ state } as SkillHost, ownerId, record).length)
      .map((record) => ({ id: shixiActionId(record), label: `拾昔：用${record.suit}牌当【${record.name}】` }))
  },
  invokeActive(host, ownerId, actionId) {
    const record = shixiRecords(host.state, ownerId).find((candidate) => shixiActionId(candidate) === actionId)
    if (record) askShixiUse(host, ownerId, record)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-use') return
    const record = resolution.data.record as { name: string; suit: Suit }
    const actionId = (response.payload as { optionId?: string }).optionId
    const carrierByAction = resolution.data.carrierByAction as Record<string, CardId>
    const carrierId = actionId ? carrierByAction[actionId] : undefined
    const action = actionId && shixiUseActions(host, ownerId, record).find((candidate) => candidate.id === actionId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !carrierId || !action || !owner.zones.hand.includes(carrierId)) return
    const matching = owner.zones.hand.filter((cardId) => effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf) === record.suit)
    if (!matching.includes(carrierId) || !matching.length) return
    const extras = matching.filter((cardId) => cardId !== carrierId)
    if (extras.length && discardCardsByIds(host as never, ownerId, extras, `${SHIXI}:cost`, 'other').length !== extras.length) return
    if (!host.beginVirtualTrick({ sourceId: ownerId, targetIds: action.targetIds, cardName: record.name,
      sourceSkillId: SHIXI, cardId: carrierId, extraCardIds: extras })) {
      for (const cardId of extras) if (host.state.zones.discardPile.includes(cardId))
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    }
  },
})

function jianbaiCardType(host: SkillHost, cardId: CardId, cardName?: string): 'basic' | 'trick' | 'equipment' | null {
  if (['杀', '火杀', '雷杀', '闪', '桃', '酒'].includes(cardName ?? '')) return 'basic'
  if (INSTANT_TRICKS.has(cardName ?? '') || DELAYED_TRICKS.has(cardName ?? '')) return 'trick'
  const category = host.state.cards[cardId]?.category
  return category === 'basic' || category === 'trick' || category === 'equipment' ? category : null
}
function jianbaiChooseTarget(host: SkillHost, ownerId: PlayerId) {
  const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
  const retained = stateOf(host).jianbaiRetained?.[ownerId] ?? {}
  const cards = handOf(host.state, ownerId).filter((cardId) => (retained[cardId] ?? 0) > 0)
  if (!targets.length || !cards.length || !playerOf(host.state, ownerId)?.alive) return
  askTargets(host, JIANBAI, ownerId, 'finish-target', '【坚白】：选择一名其他角色获得你一张被保留过的手牌', targets, { cardIds: cards }, false)
}
registerSkillRuntime({ id: JIANBAI, triggers: [
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    if (!payload.cardId) return
    const type = jianbaiCardType(host, payload.cardId, payload.cardName)
    if (!type) return
    const used = stateOf(host).jianbaiUsedTypes ??= {}
    if (used[ownerId]?.turnNumber !== host.state.turnNumber) used[ownerId] = { turnNumber: host.state.turnNumber, types: [] }
    if (used[ownerId]!.types.includes(type)) return
    used[ownerId]!.types.push(type)
    const suits = [...new Set(handOf(host.state, ownerId).map((cardId) => effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf)))]
    if (!suits.length) return
    host.askSkill({ skillId: JIANBAI, ownerId, step: 'retain-suit', data: { turnNumber: host.state.turnNumber, type }, build: (id): ChooseSuitRequest => ({
      id, kind: 'choose-suit', playerId: ownerId, prompt: '【坚白】：选择保留一种花色的手牌，其余手牌重铸',
      timeoutMs: 25_000, optional: false, suits,
    }) })
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) jianbaiChooseTarget(host, ownerId)
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'retain-suit') {
    const suit = (response.payload as { suit?: string }).suit
    const legalSuits = new Set<Suit>(handOf(host.state, ownerId).map((cardId) => effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf)))
    if (!suit || !legalSuits.has(suit as Suit) || Number(resolution.data.turnNumber) !== host.state.turnNumber) return
    const kept = handOf(host.state, ownerId).filter((cardId) => effectiveCardSuit(host.state, ownerId, cardId, skillIdsOf) === suit)
    const discarded = handOf(host.state, ownerId).filter((cardId) => !kept.includes(cardId))
    const actuallyDiscarded = discardCardsByIds(host as never, ownerId, discarded, `${JIANBAI}:recast`, 'other')
    if (actuallyDiscarded.length) drawCards(host.state, host.rng, ownerId, actuallyDiscarded.length, (name, payload) => host.dispatch(name, payload))
    const retained = stateOf(host).jianbaiRetained ??= {}
    const counts = retained[ownerId] ??= {}
    for (const cardId of kept) counts[cardId] = (counts[cardId] ?? 0) + 1
    return
  }
  if (resolution.step === 'finish-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const legal = new Set((resolution.data.cardIds as CardId[] | undefined) ?? [])
    if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
    const cards = handOf(host.state, ownerId).filter((cardId) => legal.has(cardId)
      && (stateOf(host).jianbaiRetained?.[ownerId]?.[cardId] ?? 0) > 0)
    if (!cards.length) return
    askCards(host, JIANBAI, ownerId, 'finish-card', '【坚白】：选择交给其的手牌', ownerId, cards, { targetId }, 1)
    return
  }
  if (resolution.step === 'finish-card') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const count = cardId ? stateOf(host).jianbaiRetained?.[ownerId]?.[cardId] ?? 0 : 0
    if (!cardId || count <= 0 || !handOf(host.state, ownerId).includes(cardId) || !playerOf(host.state, targetId)?.alive) return
    const given = giveOwnedCards(host as never, ownerId, targetId, [cardId], JIANBAI)
    if (given.length) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
  }
} })

function jianjiSlashTargets(host: SkillHost, ownerId: PlayerId): PlayerId[] {
  if (!playerOf(host.state, ownerId)?.alive
    || isCardUseProhibited(host.state, ownerId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })) return []
  return host.state.players.filter((target) => target.alive && target.id !== ownerId
    && canTarget(host.state, ownerId, target.id)
    && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf, undefined, JIANJI))
    .map((target) => target.id)
}

registerSkillRuntime({ id: JIANJI, triggers: [
  { event: 'RoundStart', handle(host) { stateOf(host).jianjiTargetedTurn = {} } },
  { event: 'TargetSpecified', handle(host, _ownerId, context) {
    const payload = context.event.payload as { targetIds?: PlayerId[]; targetId?: PlayerId }
    const targetIds = payload.targetIds ?? (payload.targetId ? [payload.targetId] : [])
    if (!targetIds.length) return
    const map = stateOf(host).jianjiTargetedTurn ??= {}
    for (const targetId of targetIds) map[targetId] = host.state.turnNumber
  } },
  { event: 'TargetConfirmed', handle(host, _ownerId, context) {
    const targetId = context.event.targetId ?? (context.event.payload as { targetId?: PlayerId }).targetId
    if (targetId) (stateOf(host).jianjiTargetedTurn ??= {})[targetId] = host.state.turnNumber
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
    const owner = playerOf(host.state, ownerId)
    const turnOwnerId = payload.playerId
    const turnNumber = payload.turnNumber ?? host.state.turnNumber
    if (!owner?.alive || owner.usedLimitedSkills.includes(JIANJI) || !turnOwnerId) return
    const adjacentIds = jianjiTargetsForTurn(host, turnOwnerId, turnNumber)
    if (!adjacentIds.length) return
    host.askSkill({ skillId: JIANJI, ownerId, step: 'neighbor', data: { turnOwnerId, turnNumber, adjacentIds }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【见机】：选择一名符合条件的相邻角色',
      timeoutMs: 25_000, optional: true, candidateIds: adjacentIds, min: 1, max: 1,
    }) })
  } },
], resume(host, ownerId, resolution, response) {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.usedLimitedSkills.includes(JIANJI)) return
  if (resolution.step === 'neighbor') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const turnNumber = Number(resolution.data.turnNumber)
    const valid = jianjiTargetsForTurn(host, resolution.data.turnOwnerId as PlayerId, turnNumber)
    if (!targetId || !valid.includes(targetId)) return
    const options = [] as Array<{ id: string; label: string }>
    if (!host.state.cardUseHistory?.some((use) => use.turnNumber === turnNumber && use.sourceId === targetId))
      options.push({ id: 'draw', label: '你与其各摸一张牌' })
    if (stateOf(host).jianjiTargetedTurn?.[targetId] !== turnNumber && jianjiSlashTargets(host, ownerId).length)
      options.push({ id: 'slash', label: '视为使用一张【杀】' })
    if (!options.length) return
    host.askSkill({ skillId: JIANJI, ownerId, step: 'effect', data: { targetId, turnNumber, options: options.map((option) => option.id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【见机】：选择一项', timeoutMs: 25_000, optional: true,
      options: [...options, { id: 'cancel', label: '不发动' }],
    }) })
    return
  }
  if (resolution.step === 'effect') {
    const optionId = (response.payload as { optionId?: string }).optionId
    const targetId = resolution.data.targetId as PlayerId
    const turnNumber = Number(resolution.data.turnNumber)
    if (!(resolution.data.options as string[]).includes(optionId ?? '')) return
    if (optionId === 'draw') {
      if (host.state.cardUseHistory?.some((use) => use.turnNumber === turnNumber && use.sourceId === targetId)) return
      owner.usedLimitedSkills.push(JIANJI)
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
      return
    }
    if (optionId !== 'slash' || stateOf(host).jianjiTargetedTurn?.[targetId] === turnNumber) return
    const targets = jianjiSlashTargets(host, ownerId)
    if (!targets.length) return
    host.askSkill({ skillId: JIANJI, ownerId, step: 'slash-target', data: { targets }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【见机】：选择【杀】的目标', timeoutMs: 25_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
    return
  }
  if (resolution.step === 'slash-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !(resolution.data.targets as PlayerId[]).includes(targetId) || !jianjiSlashTargets(host, ownerId).includes(targetId)) return
    owner.usedLimitedSkills.push(JIANJI)
    if (!host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JIANJI }))
      owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== JIANJI)
  }
} })

function qingjueEligibleCards(host: SkillHost, ownerId: PlayerId): CardId[] {
  const hand = handOf(host.state, ownerId)
  const suitCounts = new Map<string, number>()
  for (const cardId of hand) {
    const suit = host.state.cards[cardId]?.suit
    if (suit) suitCounts.set(suit, (suitCounts.get(suit) ?? 0) + 1)
  }
  return hand.filter((cardId) => {
    const suit = host.state.cards[cardId]?.suit
    return !suit || suitCounts.get(suit) !== 1
  })
}
function qingjueAskCards(host: SkillHost, ownerId: PlayerId, source: 'hp' | 'yingxiang') {
  const cardIds = qingjueEligibleCards(host, ownerId)
  if (!cardIds.length) return
  host.askSkill({ skillId: QINGJUE, ownerId, step: 'discard', data: { source }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【清绝】：选择任意张花色数量不为一的手牌弃置',
    timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: cardIds.length,
  }) })
}
function queueQingjueFromYingxiang(host: SkillHost, ownerId: PlayerId) {
  const roundNumber = host.state.roundNumber ?? 1
  const used = stateOf(host).qingjueUsedRound ??= {}
  if (used[ownerId] === roundNumber || !playerOf(host.state, ownerId)?.alive) return
  used[ownerId] = roundNumber
  host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'yingxiang' } })
}
function qingjueChooseNext(host: SkillHost, ownerId: PlayerId) {
  const pending = stateOf(host).qingjuePending?.[ownerId]
  if (!pending || pending.remaining <= 0 || !playerOf(host.state, ownerId)?.alive) {
    delete stateOf(host).qingjuePending?.[ownerId]
    return
  }
  const options = [{ id: 'gain-suits', label: '获得手牌中没有的花色牌各一张' }]
  if (pending.cardIds.some((cardId) => host.state.zones.discardPile.includes(cardId))
    && host.state.players.some((player) => player.alive && player.id !== ownerId))
    options.unshift({ id: 'give-discarded', label: '将本次弃置的牌交给一名其他角色' })
  host.askSkill({ skillId: QINGJUE, ownerId, step: 'effect', data: {}, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【清绝】：执行一项效果', timeoutMs: 25_000,
    optional: false, options,
  }) })
}
function qingjueGainMissingSuits(host: SkillHost, ownerId: PlayerId) {
  const present = new Set<Suit>(handOf(host.state, ownerId).map((cardId) => host.state.cards[cardId]!.suit))
  const missing = (['spade', 'heart', 'club', 'diamond'] as Suit[]).filter((suit) => !present.has(suit))
  for (const suit of missing) {
    const draw = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.suit === suit)
    if (!draw.length || !playerOf(host.state, ownerId)?.alive) continue
    const cardId = host.rng.pick(draw)
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QINGJUE }, { targetId: ownerId, cardIds: [cardId] })
    present.add(suit)
  }
}
registerSkillRuntime({ id: QINGJUE,
  handLimitExempt(state, ownerId, cardId) {
    const card = state.cards[cardId]
    if (!card?.suit) return false
    const owner = playerOf(state, ownerId)
    return Boolean(owner && owner.zones.hand.filter((heldId) => state.cards[heldId]?.suit === card.suit).length === 1)
  },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const turn = host.state.turnNumber
      const used = stateOf(host).qingjueHpTurn ??= {}
      if (used[ownerId] === turn) return
      used[ownerId] = turn
      host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'hp' } })
    } },
    { event: 'LoseHp', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const used = stateOf(host).qingjueHpTurn ??= {}
      if (used[ownerId] === host.state.turnNumber) return
      used[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'hp' } })
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const used = stateOf(host).qingjueHpTurn ??= {}
      if (used[ownerId] === host.state.turnNumber) return
      used[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'hp' } })
    } },
    { event: 'HpExchanged', handle(host, ownerId, context) {
      const payload = context.event.payload as { leftId?: PlayerId; rightId?: PlayerId; leftBefore?: number; rightBefore?: number; leftAfter?: number; rightAfter?: number }
      const changed = (payload.leftId === ownerId && payload.leftBefore !== payload.leftAfter)
        || (payload.rightId === ownerId && payload.rightBefore !== payload.rightAfter)
      const used = stateOf(host).qingjueHpTurn ??= {}
      if (!changed || used[ownerId] === host.state.turnNumber) return
      used[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'hp' } })
    } },
    { event: 'MaxHpChange', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; trimmed?: number }
      if (payload.playerId !== ownerId || (payload.trimmed ?? 0) <= 0) return
      const used = stateOf(host).qingjueHpTurn ??= {}
      if (used[ownerId] === host.state.turnNumber) return
      used[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: QINGJUE, ownerId, step: 'hp-change', data: { source: 'hp' } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'hp-change') qingjueAskCards(host, ownerId, prompt.data.source === 'yingxiang' ? 'yingxiang' : 'hp')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const legal = new Set(qingjueEligibleCards(host, ownerId))
      const cards = selected.filter((cardId) => legal.has(cardId) && handOf(host.state, ownerId).includes(cardId))
      if (!cards.length) return
      discardCardsByIds(host as never, ownerId, cards, `${QINGJUE}:cost`, 'other')
      stateOf(host).qingjuePending ??= {}
      stateOf(host).qingjuePending![ownerId] = { cardIds: cards, remaining: cards.length }
      qingjueChooseNext(host, ownerId)
      return
    }
    if (resolution.step === 'effect') {
      const pending = stateOf(host).qingjuePending?.[ownerId]
      if (!pending) return
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'give-discarded') {
        const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
        if (!targets.length) return
        askTargets(host, QINGJUE, ownerId, 'give-target', '【清绝】：选择获得本次弃置牌的角色', targets)
        return
      }
      if (option !== 'gain-suits') return
      qingjueGainMissingSuits(host, ownerId)
      pending.remaining -= 1
      qingjueChooseNext(host, ownerId)
      return
    }
    if (resolution.step === 'give-target') {
      const pending = stateOf(host).qingjuePending?.[ownerId]
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!pending || !targetId || !playerOf(host.state, targetId)?.alive || targetId === ownerId) return
      const cards = pending.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId))
      for (const cardId of cards) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      if (cards.length) host.dispatch('GainCard', { playerId: targetId, cardIds: cards, reason: QINGJUE }, { targetId, cardIds: cards })
      pending.cardIds = pending.cardIds.filter((cardId) => !cards.includes(cardId))
      pending.remaining -= 1
      qingjueChooseNext(host, ownerId)
    }
  },
})

const YINGXIANG = sid('yingxiang-xunshi')
registerSkillRuntime({ id: YINGXIANG, triggers: [
  { event: 'HandCardLeft', handle(host, ownerId, context) {
    const movement = context.event.payload as { cardId?: CardId; playerId?: PlayerId; destination?: { kind?: string; playerId?: PlayerId } | null }
    const cardId = movement.cardId
    if (!cardId || !movement.playerId) return
    const tags = stateOf(host).yingxiangCards ??= {}
    const destination = movement.destination
    if (movement.playerId === ownerId && destination?.kind === 'hand' && destination.playerId && destination.playerId !== ownerId) {
      tags[cardId] = { ownerId, holderId: destination.playerId }
      return
    }
    if (movement.playerId === ownerId && destination?.kind === 'processingArea') {
      (stateOf(host).yingxiangPendingOwner ??= {})[cardId] = ownerId
      return
    }
    const tag = tags[cardId]
    if (tag?.holderId !== movement.playerId) return
    if (destination?.kind === 'hand' && destination.playerId) tag.holderId = destination.playerId
    else if (destination?.kind !== 'processingArea' && destination?.kind !== 'equipment') delete tags[cardId]
  } },
  { event: 'AfterCardUse', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId) return
    const tags = stateOf(host).yingxiangCards
    const tag = tags?.[cardId]
    delete stateOf(host).yingxiangPendingOwner?.[cardId]
    if (!tag) return
    delete tags![cardId]
    if (!playerOf(host.state, tag.ownerId)?.alive || !playerOf(host.state, tag.holderId)?.alive) return
    drawCards(host.state, host.rng, tag.ownerId, 1, (name, data) => host.dispatch(name, data))
    drawCards(host.state, host.rng, tag.holderId, 1, (name, data) => host.dispatch(name, data))
    if (handOf(host.state, tag.holderId).includes(cardId)) queueQingjueFromYingxiang(host, tag.ownerId)
  } },
  { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; reason?: string }
    if (!payload.cardId) return
    delete stateOf(host).yingxiangPendingOwner?.[payload.cardId]
    if (payload.reason === 'discard') delete stateOf(host).yingxiangCards?.[payload.cardId]
  } },
  { event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (!payload.playerId || payload.playerId === ownerId) return
    const state = stateOf(host)
    for (const cardId of payload.cardIds ?? []) {
      if (state.yingxiangPendingOwner?.[cardId] !== ownerId) continue
      state.yingxiangCards ??= {}
      state.yingxiangCards[cardId] = { ownerId, holderId: payload.playerId }
      delete state.yingxiangPendingOwner?.[cardId]
    }
  } },
  { event: 'FieldCardMoved', handle(host, ownerId, context) {
    const movement = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId; toPlayerId?: PlayerId }
    if (!movement.cardId || movement.fromPlayerId !== ownerId || !movement.toPlayerId || movement.toPlayerId === ownerId) return
    const tags = stateOf(host).yingxiangCards ??= {}
    tags[movement.cardId] = { ownerId, holderId: movement.toPlayerId }
  } },
  { event: 'CardResponded', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId | null }).cardId
    if (cardId) delete stateOf(host).yingxiangCards?.[cardId]
  } },
] })

const DINGAN = sid('dingan-xunyu')
function totalDyingEntries(state: SanguoshaState): number {
  return state.players.reduce((sum, player) => sum + (player.dyingEntryCount ?? 0), 0)
}
function dinganMaxHandTargets(host: SkillHost, ownerId: PlayerId): PlayerId[] {
  const others = host.state.players.filter((player) => player.alive && player.id !== ownerId)
  if (!others.length) return []
  const maximum = Math.max(...others.map((player) => player.zones.hand.length))
  return others.filter((player) => player.zones.hand.length === maximum).map((player) => player.id)
}
function dinganSameNameDiscardOptions(host: SkillHost, targetId: PlayerId): Array<{ id: string; label: string }> {
  const target = playerOf(host.state, targetId)
  if (!target?.alive || !target.zones.hand.length) return []
  const counts = new Map<string, number>()
  for (const cardId of target.zones.hand) {
    const name = host.state.cards[cardId]?.name
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const maximum = Math.max(0, ...counts.values())
  return [...counts].filter(([, count]) => count === maximum)
    .map(([name]) => ({ id: name, label: `弃置所有【${name}】` }))
}
registerSkillRuntime({ id: DINGAN, triggers: [
  { event: 'TurnStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { turnNumber?: number }
    stateOf(host).dinganDyingBaseline ??= {}
    stateOf(host).dinganDyingBaseline![ownerId] = {
      turnNumber: payload.turnNumber ?? host.state.turnNumber,
      entries: totalDyingEntries(host.state),
    }
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardName = (context.event.payload as { cardName?: string; targetIds?: PlayerId[] }).cardName
    if (!cardName || !host.state.cardUseHistory) return
    const turnNumber = host.state.turnNumber
    const baseline = stateOf(host).dinganDyingBaseline?.[ownerId]
    if (!baseline || baseline.turnNumber !== turnNumber || totalDyingEntries(host.state) !== baseline.entries) return
    const used = stateOf(host).dinganUsedPlayers?.[ownerId] ?? {}
    if (used[ownerId] === turnNumber) return
    const uses = host.state.cardUseHistory.filter((entry) => entry.turnNumber === turnNumber && entry.cardName === cardName).length
    if (uses !== 2) return
    const excluded = new Set((context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
    const targetIds = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && !excluded.has(player.id) && used[player.id] !== turnNumber).map((player) => player.id)
    if (candidates.length) askTargets(host, DINGAN, ownerId, 'draw-target', '【定安】：选择一名本回合未因此摸牌且未成为此牌目标的角色', candidates, { turnNumber, cardTargetIds: targetIds }, false)
  } },
], resume(host, ownerId, resolution, response) {
  const used = stateOf(host).dinganUsedPlayers ??= {}
  used[ownerId] ??= {}
  const turnNumber = Number(resolution.data.turnNumber ?? host.state.turnNumber)
  if (resolution.step === 'draw-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive || used[ownerId]![ownerId] === turnNumber
      || used[ownerId]![targetId] === turnNumber) return
    const excluded = new Set((resolution.data.cardTargetIds as PlayerId[] | undefined) ?? [])
    if (excluded.has(targetId)) return
    used[ownerId]![ownerId] = turnNumber
    used[ownerId]![targetId] = turnNumber
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
    const candidates = dinganMaxHandTargets(host, ownerId).filter((id) => used[ownerId]![id] !== turnNumber)
    if (candidates.length) askTargets(host, DINGAN, ownerId, 'max-hand-target', '【定安】：选择一名手牌最多且本回合未因此受影响的角色', candidates, { turnNumber }, false)
    return
  }
  if (resolution.step === 'max-hand-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || used[ownerId]![targetId] === turnNumber || !dinganMaxHandTargets(host, ownerId).includes(targetId)) return
    const options = dinganSameNameDiscardOptions(host, targetId)
    if (!playerOf(host.state, targetId)?.alive) return
    host.askSkill({ skillId: DINGAN, ownerId, step: 'max-hand-effect', data: { targetId, options: options.map(({ id }) => id), turnNumber }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【定安】：选择一项', timeoutMs: 25_000, optional: false,
      options: [{ id: 'damage', label: '对其造成1点伤害' }, ...(options.length ? [{ id: 'discard', label: '令其弃置手牌中最多的同名牌' }] : [])],
    }) })
    return
  }
  if (resolution.step === 'max-hand-effect') {
    const targetId = resolution.data.targetId as PlayerId
    const optionId = (response.payload as { optionId?: string }).optionId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || used[ownerId]![targetId] === turnNumber || !dinganMaxHandTargets(host, ownerId).includes(targetId)) return
    if (optionId === 'damage') resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, reason: DINGAN })
    else if (optionId === 'discard') {
      const options = dinganSameNameDiscardOptions(host, targetId)
      if (!options.length || !(resolution.data.options as string[]).length) return
      host.askSkill({ skillId: DINGAN, ownerId, step: 'discard-name', data: { targetId, turnNumber, names: options.map(({ id }) => id) }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【定安】：选择一种并列最多的手牌牌名', timeoutMs: 25_000, optional: false,
        options,
      }) })
      return
    } else return
    used[ownerId]![targetId] = turnNumber
    return
  }
  if (resolution.step === 'discard-name') {
    const targetId = resolution.data.targetId as PlayerId
    const name = (response.payload as { optionId?: string }).optionId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || used[ownerId]![targetId] === turnNumber || !name
      || !dinganSameNameDiscardOptions(host, targetId).some((option) => option.id === name)) return
    const cards = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === name)
    if (!cards.length) return
    discardCardsByIds(host as never, targetId, cards, DINGAN)
    used[ownerId]![targetId] = turnNumber
  }
} })

const MINGDIAN = sid('mingdian-chenqun')
function mingdianCandidates(host: SkillHost, ownerId: PlayerId): CardId[] {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return []
  const current = stateOf(host).mingdianUsedNames?.[ownerId]
  const usedNames = current?.roundNumber === (host.state.roundNumber ?? 1) ? new Set(current.names) : new Set<string>()
  return owner.zones.hand.filter((cardId) => {
    const card = host.state.cards[cardId]
    return card?.category === 'basic' && card.name && !usedNames.has(card.name)
  })
}
function askMingdianRecast(host: SkillHost, ownerId: PlayerId) {
  const cardIds = mingdianCandidates(host, ownerId)
  if (!cardIds.length) return
  host.askSkill({ skillId: MINGDIAN, ownerId, step: 'recast', data: {}, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【明典】：选择任意张本轮未以此法重铸过牌名的基本牌重铸',
    timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: cardIds.length,
  }) })
}
registerSkillRuntime({ id: MINGDIAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || !mingdianCandidates({ state } as SkillHost, ownerId).length) return []
    return [{ id: `skill:${MINGDIAN}`, label: '明典：重铸任意张基本牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MINGDIAN}`) throw new Error('明典动作不匹配')
    askMingdianRecast(host, ownerId)
  },
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !mingdianCandidates(host, ownerId).length) return
    askOption(host, MINGDIAN, ownerId, 'invoke-after-damage', '【明典】：是否重铸任意张基本牌？')
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke-after-damage') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') askMingdianRecast(host, ownerId)
      return
    }
    if (resolution.step !== 'recast') return
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const legal = new Set(mingdianCandidates(host, ownerId))
    const cardIds = selected.filter((cardId) => legal.has(cardId) && handOf(host.state, ownerId).includes(cardId))
    if (!cardIds.length) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const names = [...new Set(cardIds.map((cardId) => host.state.cards[cardId]?.name).filter((name): name is string => Boolean(name)))]
    const roundNumber = host.state.roundNumber ?? 1
    const record = stateOf(host).mingdianUsedNames?.[ownerId]
    const usedNames = record?.roundNumber === roundNumber ? record.names : []
    const historyNames = new Set((host.state.cardUseHistory ?? [])
      .filter((entry) => entry.turnNumber === host.state.turnNumber && entry.sourceId === ownerId)
      .map((entry) => entry.cardName))
    const bonus = names.some((name) => historyNames.has(name))
    stateOf(host).mingdianUsedNames ??= {}
    stateOf(host).mingdianUsedNames![ownerId] = { roundNumber, names: [...new Set([...usedNames, ...names])] }
    discardCardsByIds(host as never, ownerId, cardIds, `${MINGDIAN}:recast`, 'other')
    drawCards(host.state, host.rng, ownerId, cardIds.length, (name, data) => host.dispatch(name, data))
    if (!bonus || !playerOf(host.state, ownerId)?.alive) return
    const heldNames = new Set(handOf(host.state, ownerId).map((cardId) => host.state.cards[cardId]?.name))
    const candidates = host.state.zones.drawPile.filter((cardId) => {
      const card = host.state.cards[cardId]
      return card?.category === 'basic' && card.name && !heldNames.has(card.name)
    })
    if (!candidates.length) return
    const gained = host.rng.pick(candidates)
    moveCard(host.state, gained, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: MINGDIAN }, { targetId: ownerId, cardIds: [gained] })
  },
})

function gezhiPickOptions(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId) {
  const owner = playerOf(host.state, ownerId)
  const source = playerOf(host.state, sourceId)
  if (!owner?.alive || !source?.alive || ownerId === sourceId) return { cardIds: [] as CardId[], hiddenCardSlots: [] as string[] }
  const visible = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)),
    ...Object.values(source.zones.equipment).filter((id): id is CardId => Boolean(id))]
  const hiddenCardSlots = source.zones.hand.map((_, index) => `hidden:${sourceId}:${index}`)
  return { cardIds: [...new Set(visible)], hiddenCardSlots }
}
registerSkillRuntime({ id: GEZHI,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (stateOf(host).gezhiUsedTurn?.[ownerId] === host.state.turnNumber) return
    const targetId = context.event.targetId
    const sourceId = context.event.sourceId
    const payload = context.event.payload as { finalAmount?: number }
    if (!targetId || !sourceId || sourceId === targetId || (payload.finalAmount ?? 0) <= 0) return
    const inRange = targetId === ownerId || getSeatDistance(host.state, ownerId, targetId) <= getAttackRange(host.state, ownerId)
    if (!inRange) return
    const pick = gezhiPickOptions(host, ownerId, sourceId)
    if (pick.cardIds.length + pick.hiddenCardSlots.length < 2) return
    askOption(host, GEZHI, ownerId, 'invoke', '【革制】：是否弃置你与伤害来源共两张牌？', { sourceId })
  } }],
  resume(host, ownerId, resolution, response) {
    const sourceId = resolution.data.sourceId as PlayerId
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const pick = gezhiPickOptions(host, ownerId, sourceId)
      if (pick.cardIds.length + pick.hiddenCardSlots.length < 2) return
      host.askSkill({ skillId: GEZHI, ownerId, step: 'discard', data: { sourceId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【革制】：选择你与伤害来源的共两张牌弃置（可任意分配）',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pick.cardIds,
        hiddenCardSlots: pick.hiddenCardSlots, min: 2, max: 2,
      }) })
      return
    }
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive || sourceId === ownerId) return
    const rawIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    if (rawIds.length !== 2) return
    const chosen: Array<{ ownerId: PlayerId; cardId: CardId }> = []
    for (const rawId of rawIds) {
      if (rawId.startsWith(`hidden:${sourceId}:`)) {
        const cardId = resolvePickedCard(host.state, sourceId, rawId)
        if (!cardId || !source.zones.hand.includes(cardId)) return
        chosen.push({ ownerId: sourceId, cardId })
      } else if (owner.zones.hand.includes(rawId) || Object.values(owner.zones.equipment).includes(rawId)) {
        chosen.push({ ownerId, cardId: rawId })
      } else if (Object.values(source.zones.equipment).includes(rawId)) {
        chosen.push({ ownerId: sourceId, cardId: rawId })
      } else return
    }
    if (new Set(chosen.map((entry) => entry.cardId)).size !== 2) return
    const categories = [...new Set(chosen.map((entry) => host.state.cards[entry.cardId]?.category).filter((category): category is CardCategory => Boolean(category)))]
    const discarded = discardCardsByOwners(host as never, chosen.map(({ ownerId: playerId, cardId }) => ({ playerId, cardId })), GEZHI)
    if (discarded.length !== 2) return
    stateOf(host).gezhiUsedTurn ??= {}
    stateOf(host).gezhiUsedTurn![ownerId] = host.state.turnNumber
    if (categories.length > 1) {
      const allowed = new Set(categories)
      const allCategories: CardCategory[] = ['basic', 'trick', 'equipment']
      for (const playerId of [ownerId, sourceId]) for (const category of allCategories) {
        if (!allowed.has(category)) lockCardCategory(host.state, { targetId: playerId, category, sourceId: ownerId, skillId: GEZHI })
      }
    }
  },
})

function jueweiEquipment(host: SkillHost, ownerId: PlayerId): CardId[] {
  const owner = playerOf(host.state, ownerId)
  return owner ? Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
}

function beginJuewei(host: SkillHost, ownerId: PlayerId, context: import('../../engine/skills/runtime').TargetedCardContext): boolean {
  const state = stateOf(host)
  if (!playerOf(host.state, ownerId)?.alive || state.jueweiUsedTurn?.[ownerId] === host.state.turnNumber
    || state.jueweiPromptedCards?.[context.cardId]
    || (!DAMAGE_TRICKS.has(context.cardName) && context.cardName !== '杀') || !jueweiEquipment(host, ownerId).length) return false
  const targets = cardUseTargetsOf(host.state, context.cardId)?.targetIds ?? [context.targetId]
  const replayTargets = [...new Set(targets)].filter((targetId) => targetId !== ownerId && playerOf(host.state, targetId)?.alive)
  state.jueweiPromptedCards ??= {}
  state.jueweiPromptedCards[context.cardId] = true
  host.askSkill({ skillId: JUEWEI, ownerId, step: 'option', data: { cardId: context.cardId, cardName: context.cardName, targets: replayTargets }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【绝围】：选择一项效果', timeoutMs: 25_000, optional: true,
    options: [
      ...(replayTargets.length ? [{ id: 'recast', label: '重铸一张装备牌，此牌结算后对其中一名原目标再使用' }] : []),
      { id: 'invalidate', label: '弃置一张装备牌，令此牌无效' },
    ],
  }) })
  return true
}

registerSkillRuntime({ id: JUEWEI,
  interceptTarget(host, ownerId, context) { return beginJuewei(host, ownerId, context) },
  interceptSourceTargetEach(host, ownerId, context) { return beginJuewei(host, ownerId, context) },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (cardId && host.state.invalidatedCardUses?.[cardId]?.skillId === JUEWEI) delete host.state.invalidatedCardUses[cardId]
    if (cardId) delete stateOf(host).jueweiPromptedCards?.[cardId]
    const pending = cardId ? stateOf(host).jueweiPendingReplay?.[cardId] : undefined
    if (!cardId || pending?.ownerId !== ownerId) return
    delete stateOf(host).jueweiPendingReplay?.[cardId]
    const candidates = pending.targets.filter((targetId) => playerOf(host.state, targetId)?.alive)
    if (candidates.length) askTargets(host, JUEWEI, ownerId, 'replay-target', `【绝围】：选择一名原目标，再次使用【${pending.cardName}】`, candidates, { cardName: pending.cardName })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'option') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option !== 'recast' && option !== 'invalidate') { host.resumeCardTarget(); return }
      const cards = jueweiEquipment(host, ownerId)
      if (!cards.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: JUEWEI, ownerId, step: 'cost', data: { ...resolution.data, option }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【绝围】：选择一张装备区里的牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'cost') {
      const cardId = (resolution.data.cardId as CardId)
      const cost = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cost || !jueweiEquipment(host, ownerId).includes(cost)) { host.resumeCardTarget(); return }
      const discarded = discardCardsByIds(host as never, ownerId, [cost], JUEWEI, 'other')
      if (discarded.length !== 1) { host.resumeCardTarget(); return }
      stateOf(host).jueweiUsedTurn ??= {}
      stateOf(host).jueweiUsedTurn![ownerId] = host.state.turnNumber
      const option = resolution.data.option as string
      if (option === 'recast') {
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
        const replay = stateOf(host).jueweiPendingReplay ??= {}
        replay[cardId] = { ownerId, targets: resolution.data.targets as PlayerId[], cardName: resolution.data.cardName as string }
      } else {
        host.state.invalidatedCardUses ??= {}
        host.state.invalidatedCardUses[cardId] = { sourceId: ownerId, skillId: JUEWEI }
        host.dispatch('SkillActivated', { skillId: JUEWEI, skillName: '绝围', playerId: ownerId, logText: `陆景发动【绝围】，令【${resolution.data.cardName as string}】无效` }, { sourceId: ownerId, cardIds: [cardId] })
      }
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'replay-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardName = resolution.data.cardName as string
      if (!targetId || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
      if (cardName === '杀') host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JUEWEI })
      else host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName, sourceSkillId: JUEWEI })
    }
  },
})

const YICHI = sid('yichi-yangbiao')
const YICHI_PINDIAN = `${YICHI}:pindian`
function continueYichi(host: SkillHost, ownerId: PlayerId): boolean {
  const pending = stateOf(host).yichiPending?.[ownerId]
  if (!pending) return false
  const target = playerOf(host.state, pending.targetId)
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || !target?.alive) {
    delete stateOf(host).yichiPending?.[ownerId]
    finishPindianSettlement(host as never)
    return false
  }
  // 失去体力进入濒死时，义叱后续项必须等濒死流程完整结束；不能提前结算拼点牌。
  if (host.state.dying) return true
  pending.count = Math.min(4, Math.max(0, pending.count))
  while (pending.nextOption < pending.count) {
    const option = pending.nextOption + 1
    if (option === 1) {
      const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
      pending.nextOption += 1
      if (cards.length < 2) continue
      askCards(host, YICHI, ownerId, 'discard-two', '【义叱】：弃置两张牌', target.id, cards, { targetId: target.id }, 2)
      return true
    }
    if (option === 2) {
      pending.nextOption += 1
      drawCards(host.state, host.rng, target.id, 2, (name, data) => host.dispatch(name, data))
      continue
    }
    if (option === 3) {
      pending.nextOption += 1
      const equipment = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
        .filter((cardId) => host.state.cards[cardId]?.category === 'equipment')
      if (!equipment.length) continue
      discardCardsByIds(host as never, target.id, equipment, `${YICHI}:recast`, 'other')
      drawCards(host.state, host.rng, target.id, equipment.length, (name, data) => host.dispatch(name, data))
      continue
    }
    const tricks = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'trick')
    pending.nextOption += 1
    if (!tricks.length) {
      loseHp(host as never, target.id, 1, YICHI)
      if (host.state.dying) return true
      continue
    }
    host.askSkill({ skillId: YICHI, ownerId, step: 'trick-or-hp', data: { targetId: target.id }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: target.id, prompt: '【义叱】：将一张手牌锦囊置于牌堆顶，或失去1点体力',
      timeoutMs: 25_000, optional: false,
      options: [{ id: 'top', label: '将一张手牌锦囊置于牌堆顶' }, { id: 'lose-hp', label: '失去1点体力' }],
    }) })
    return true
  }
  delete stateOf(host).yichiPending?.[ownerId]
  finishPindianSettlement(host as never)
  return false
}
registerPindianContinuation(YICHI_PINDIAN, (rawHost, result) => {
  if (result.outcome !== 'initiator-win') return
  const host = rawHost as unknown as SkillHost
  const count = Number(result.data.optionCount ?? 0)
  if (count <= 0 || !playerOf(host.state, result.initiatorId)?.alive) return
  stateOf(host).yichiPending ??= {}
  stateOf(host).yichiPending![result.initiatorId] = { targetId: result.opponentId, count, nextOption: 0 }
  return continueYichi(host, result.initiatorId) ? 'defer-settlement' : undefined
})
registerSkillRuntime({ id: YICHI, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'end' || !canPindian(host.state, ownerId)) return
    const record = stateOf(host).jiannanTurnCount?.[ownerId]
    if (!record || record.turnNumber !== host.state.turnNumber || record.count <= 0) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id)).map((player) => player.id)
    if (candidates.length) askTargets(host, YICHI, ownerId, 'pindian-target', '【义叱】：选择一名角色拼点', candidates, { optionCount: Math.min(4, record.count) })
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId === ownerId && phase.phase === 'end') delete stateOf(host).jiannanTurnCount?.[ownerId]
  } },
  { event: 'QuitDying', handle(host, ownerId, context) {
    const pending = stateOf(host).yichiPending?.[ownerId]
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (pending && playerId === pending.targetId)
      host.queueSkill({ skillId: YICHI, ownerId, step: 'resume-after-dying', data: {} })
  } },
  { event: 'Death', handle(host, ownerId, context) {
    const pending = stateOf(host).yichiPending?.[ownerId]
    const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!pending || (deadId !== ownerId && deadId !== pending.targetId)) return
    delete stateOf(host).yichiPending?.[ownerId]
    finishPindianSettlement(host as never)
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'resume-after-dying' || host.state.dying) return
  const targetId = stateOf(host).yichiPending?.[ownerId]?.targetId
  if (!targetId || !playerOf(host.state, targetId)?.alive) {
    delete stateOf(host).yichiPending?.[ownerId]
    finishPindianSettlement(host as never)
    return
  }
  continueYichi(host, ownerId)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'pindian-target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const count = Number(resolution.data.optionCount)
    if (!targetId || count <= 0 || !playerOf(host.state, ownerId)?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    startPindian(host as never, { id: `b69-yichi-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: YICHI, continuationTag: YICHI_PINDIAN, data: { optionCount: count } })
    return
  }
  const pending = stateOf(host).yichiPending?.[ownerId]
  if (!pending || host.state.dying?.playerId === pending.targetId) return
  const target = playerOf(host.state, pending.targetId)
  if (!target?.alive) { continueYichi(host, ownerId); return }
  if (resolution.step === 'discard-two') {
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const legal = new Set([...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))])
    discardCardsByIds(host as never, target.id, cards.filter((cardId) => legal.has(cardId)).slice(0, 2), YICHI)
    continueYichi(host, ownerId)
    return
  }
  if (resolution.step === 'trick-or-hp') {
    const option = (response.payload as { optionId?: string }).optionId
    if (option === 'top') {
      const tricks = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'trick')
      if (tricks.length) askCards(host, YICHI, ownerId, 'trick-top', '【义叱】：选择置于牌堆顶的手牌锦囊', target.id, tricks, { targetId: target.id })
      else continueYichi(host, ownerId)
      return
    }
    if (option === 'lose-hp') {
      loseHp(host as never, target.id, 1, YICHI)
      if (!host.state.dying) continueYichi(host, ownerId)
    }
    return
  }
  if (resolution.step === 'trick-top') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (cardId && target.zones.hand.includes(cardId) && host.state.cards[cardId]?.category === 'trick')
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'drawPile' }, { toTop: true })
    continueYichi(host, ownerId)
  }
} })

const FUNING = sid('funing-xunyu')
function tryFuning(host: SkillHost, ownerId: PlayerId) {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const roundNumber = host.state.roundNumber ?? 1
  const state = stateOf(host)
  if (state.funingTriggeredRound?.[ownerId] === roundNumber) return
  state.funingTriggeredRound ??= {}
  state.funingTriggeredRound[ownerId] = roundNumber
  const minimum = Math.max(0, owner.maxHp - owner.hp)
  const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  if (cards.length < minimum) return
  host.askSkill({ skillId: FUNING, ownerId, step: 'invoke', data: { minimum, roundNumber }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【抚宁】：是否交给一名角色至少${minimum}张牌？`,
    timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动抚宁' }, { id: 'no', label: '不发动' }],
  }) })
}
registerSkillRuntime({ id: FUNING, triggers: [
  { event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId) tryFuning(host, ownerId)
  } },
  { event: 'LoseHp', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) tryFuning(host, ownerId)
  } },
  { event: 'Recover', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) tryFuning(host, ownerId)
  } },
  { event: 'HpExchanged', handle(host, ownerId, context) {
    const payload = context.event.payload as { leftId?: PlayerId; rightId?: PlayerId; leftBefore?: number; rightBefore?: number; leftAfter?: number; rightAfter?: number }
    if ((payload.leftId === ownerId && payload.leftBefore !== payload.leftAfter)
      || (payload.rightId === ownerId && payload.rightBefore !== payload.rightAfter)) tryFuning(host, ownerId)
  } },
  { event: 'MaxHpChange', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; trimmed?: number }
    if (payload.playerId === ownerId && (payload.trimmed ?? 0) > 0) tryFuning(host, ownerId)
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const minimum = Number(resolution.data.minimum)
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!candidates.length) return
    askTargets(host, FUNING, ownerId, 'target', `【抚宁】：选择获得至少${minimum}张牌的角色`, candidates, { minimum }, false)
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const minimum = Number(resolution.data.minimum)
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const cardIds = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (!target?.alive || !owner?.alive || cardIds.length < minimum) return
    host.askSkill({ skillId: FUNING, ownerId, step: 'give-cards', data: { targetId, minimum }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【抚宁】：选择至少${minimum}张牌交给${target.nickname}`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: minimum, max: cardIds.length,
    }) })
    return
  }
  if (resolution.step === 'give-cards') {
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    const minimum = Number(resolution.data.minimum)
    const chosen = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const legal = new Set(owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : [])
    const cards = chosen.filter((cardId) => legal.has(cardId))
    if (!owner?.alive || !target?.alive || cards.length < minimum) return
    const given = giveOwnedCards(host as never, ownerId, targetId, cards, FUNING)
    if (given.length < minimum) return
    if (given.length > 0 && new Set(given.map((cardId) => host.state.cards[cardId]?.color)).size === 1)
      recover(host as never, ownerId, 1, ownerId)
    const damaged = new Set((host.state.damageHistory ?? [])
      .filter((entry) => entry.turnNumber === host.state.turnNumber).map((entry) => entry.targetId)).size
    if (given.length <= damaged || !playerOf(host.state, ownerId)?.alive) return
    const hand = handOf(host.state, ownerId)
    const targetHandCount = playerOf(host.state, ownerId)?.hp ?? 0
    if (hand.length < targetHandCount) drawCards(host.state, host.rng, ownerId, targetHandCount - hand.length, (name, data) => host.dispatch(name, data))
    else if (hand.length > targetHandCount) {
      const excess = hand.length - targetHandCount
      askCards(host, FUNING, ownerId, 'adjust-hand', '【抚宁】：弃置手牌至体力值张', ownerId, hand, { excess }, excess)
    }
    return
  }
  if (resolution.step === 'adjust-hand') {
    const excess = Number(resolution.data.excess)
    const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (chosen.length !== excess || !chosen.every((cardId) => handOf(host.state, ownerId).includes(cardId))) return
    discardCardsByIds(host as never, ownerId, chosen, FUNING)
  }
} })
