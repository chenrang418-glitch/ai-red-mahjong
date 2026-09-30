import { destroyCharacterEquipment, isCharacterEquipment } from './character-equipment'
import { destroySpecialEquipment, isSpecialEquipment } from './special-equipment'
import { clearCardColorOverride } from './card-color'
import { clearGainEntry, recordGainEntry } from './card-gain-provenance'
import { clearDiscardEntry, recordDiscardEntry, type DiscardReason } from './discard-provenance'
import { recordTurnCardCategory } from './turn-card-categories'
import type { CardId, DamageNature, EquipmentSlot, PlayerId, SanguoshaState } from './types'

export type ZoneRef =
  | { kind: 'drawPile' }
  | { kind: 'discardPile' }
  | { kind: 'processingArea' }
  | { kind: 'hand'; playerId: PlayerId }
  | { kind: 'judgingArea'; playerId: PlayerId }
  | { kind: 'equipment'; playerId: PlayerId; slot: EquipmentSlot }
  /** 武将专属牌堆，`pile` 是技能 id（周泰的「创」是 'buqu'）。 */
  | { kind: 'characterPile'; playerId: PlayerId; pile: string }
  /** 私有暂存区，`zoneId` 是 state.privateZones 里那一项的 id。 */
  | { kind: 'privateZone'; zoneId: string }

/** 记录一张牌进入某名角色手牌的轮次。开局分发手牌按第一轮持有处理。 */
export function recordCardHandEntry(state: SanguoshaState, cardId: CardId, round = state.roundNumber || 1): void {
  const card = state.cards[cardId]
  if (card) card.handEnteredRound = Math.max(1, Math.trunc(round))
}

/** 当前牌已在手牌区经历的轮数；正在结算的牌保留其使用者最后一次入手时间。 */
export function cardHandRounds(state: SanguoshaState, cardId: CardId): number {
  const entered = state.cards[cardId]?.handEnteredRound
  if (!Number.isInteger(entered)) return 1
  return Math.max(1, Math.trunc(state.roundNumber || 1) - entered! + 1)
}

export interface CharacterPileMovement {
  ownerId: PlayerId
  pile: string
  direction: 'enter' | 'leave'
  overflow: boolean
  /** 公开移动方向摘要，供依赖“获得武将牌上牌”的规则使用；不包含牌面信息。 */
  destinationKind?: ZoneRef['kind']
  destinationPlayerId?: PlayerId
}

const characterPileMoveObservers = new WeakMap<SanguoshaState, (movement: CharacterPileMovement) => void>()
export interface HandCardLeftMovement { cardId: CardId; playerId: PlayerId; destination: ZoneRef | null }
const handCardLeftObservers = new WeakMap<SanguoshaState, (movement: HandCardLeftMovement) => void>()
export interface CardEnteredDiscardMovement { cardId: CardId; from: ZoneRef; reason: DiscardReason }
const discardEntryObservers = new WeakMap<SanguoshaState, (movement: CardEnteredDiscardMovement) => void>()
export interface FieldCardEntryMovement { cardId: CardId; playerId: PlayerId; zone: 'equipment' | 'judgingArea'; from: ZoneRef }
const fieldEntryObservers = new WeakMap<SanguoshaState, (movement: FieldCardEntryMovement) => void>()
export interface CardZoneMovement { cardId: CardId; from: ZoneRef; to: ZoneRef; color: 'red' | 'black' | null }
const cardZoneObservers = new WeakMap<SanguoshaState, (movement: CardZoneMovement) => void>()

/** 为单局引擎绑定专属牌堆区域变化监听；状态对象作键，互不串台。 */
export function observeCharacterPileMoves(
  state: SanguoshaState,
  observer: (movement: CharacterPileMovement) => void,
): void {
  characterPileMoveObservers.set(state, observer)
}

/** 监听实体手牌离开原持有者手牌区，供“此牌离开其手牌区时”类规则使用。 */
export function observeHandCardLeaves(
  state: SanguoshaState,
  observer: (movement: HandCardLeftMovement) => void,
): void {
  handCardLeftObservers.set(state, observer)
}

/** 统一监听所有实际进入弃牌堆的牌；来源区域由移动真相入口提供。 */
export function observeDiscardPileEntries(
  state: SanguoshaState,
  observer: (movement: CardEnteredDiscardMovement) => void,
): void {
  discardEntryObservers.set(state, observer)
}

/** 监听实体牌进入任一角色装备区或判定区，用于依赖“进入场上区域”的武将技能。 */
export function observeFieldCardEntries(
  state: SanguoshaState,
  observer: (movement: FieldCardEntryMovement) => void,
): void {
  fieldEntryObservers.set(state, observer)
}

/** Observe every completed zone move with the physical card identity. */
export function observeCardZoneMoves(
  state: SanguoshaState,
  observer: (movement: CardZoneMovement) => void,
): void {
  cardZoneObservers.set(state, observer)
}

export function notifyHandCardLeft(state: SanguoshaState, movement: HandCardLeftMovement): void {
  handCardLeftObservers.get(state)?.(movement)
}

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

export function zoneCards(state: SanguoshaState, zone: ZoneRef): CardId[] {
  switch (zone.kind) {
    case 'drawPile': return state.zones.drawPile
    case 'discardPile': return state.zones.discardPile
    case 'processingArea': return state.zones.processingArea
    case 'hand': return player(state, zone.playerId).zones.hand
    case 'judgingArea': return player(state, zone.playerId).zones.judgingArea
    case 'characterPile': {
      const owner = player(state, zone.playerId)
      // 读的时候顺手建空堆：调用方拿到的永远是同一个数组引用，push 才生效
      return owner.characterPiles[zone.pile] ?? (owner.characterPiles[zone.pile] = [])
    }
    case 'privateZone': {
      const found = (state.privateZones ?? []).find((candidate) => candidate.id === zone.zoneId)
      if (!found) throw new Error(`私有牌区不存在：${zone.zoneId}`)
      return found.cards
    }
    case 'equipment': {
      const id = player(state, zone.playerId).zones.equipment[zone.slot]
      return id ? [id] : []
    }
  }
}

function removeCard(state: SanguoshaState, zone: ZoneRef, cardId: CardId): void {
  if (zone.kind === 'equipment') {
    const equipment = player(state, zone.playerId).zones.equipment
    if (equipment[zone.slot] !== cardId) throw new Error('卡牌不在指定装备槽')
    equipment[zone.slot] = null
    return
  }
  const cards = zoneCards(state, zone)
  const index = cards.indexOf(cardId)
  if (index < 0) throw new Error('卡牌不在来源区域')
  cards.splice(index, 1)
}

function addCard(state: SanguoshaState, zone: ZoneRef, cardId: CardId, toTop: boolean, toIndex?: number): CardId | null {
  if (zone.kind === 'equipment') {
    const equipment = player(state, zone.playerId).zones.equipment
    const replaced = equipment[zone.slot]
    equipment[zone.slot] = cardId
    return replaced
  }
  const cards = zoneCards(state, zone)
  if (zone.kind === 'drawPile' && toIndex !== undefined) cards.splice(Math.max(0, Math.min(toIndex, cards.length)), 0, cardId)
  else if (zone.kind === 'drawPile' && toTop) cards.unshift(cardId)
  else cards.push(cardId)
  return null
}

export interface MoveCardOptions {
  toTop?: boolean
  /** Insert into the draw pile at an exact zero-based position (top is 0). */
  toIndex?: number
  replaceEquipmentTo?: ZoneRef
  /**
   * 这张牌进弃牌堆的原因。
   *
   * 不传就按来源区推断（手牌 / 装备区 / 判定区算「被弃置」，处理区算「其他」）。
   * 从处理区进弃牌堆的既可能是用完的牌、也可能是判定牌，**只有调用方知道**，
   * 所以判定那几处要显式说明。见 `engine/discard-provenance.ts`。
   */
  discardReason?: DiscardReason
  /** 标记专属牌堆移出的规则原因；“堆溢出”不触发离堆奖励。 */
  characterPileMoveReason?: 'overflow' | 'rule'
}

/** 单一卡牌移动真相入口；装备替换默认把旧装备移入弃牌堆。 */
export function moveCard(state: SanguoshaState, cardId: CardId, from: ZoneRef, to: ZoneRef, options: MoveCardOptions = {}): void {
  if (!state.cards[cardId]) throw new Error(`未知卡牌：${cardId}`)
  const sameHand = from.kind === 'hand' && to.kind === 'hand' && from.playerId === to.playerId
  if (to.kind === 'hand' && !sameHand) recordCardHandEntry(state, cardId)
  const movedCardColor = state.cardColorOverrides?.[cardId] ?? state.cards[cardId]?.color ?? null
  if (from.kind === 'hand' && !state.cards[cardId]?.virtual
    && !(to.kind === 'hand' && to.playerId === from.playerId)) {
    if (state.handCardLossThisTurn?.turnNumber !== state.turnNumber)
      state.handCardLossThisTurn = { turnNumber: state.turnNumber, counts: {} }
    state.handCardLossThisTurn.counts[from.playerId] = (state.handCardLossThisTurn.counts[from.playerId] ?? 0) + 1
  }
  const recordRedDiscard = (movedId: CardId, source: ZoneRef, destination: ZoneRef) => {
    if (destination.kind !== 'discardPile' || source.kind === 'discardPile') return
    const override = state.cardColorOverrides?.[movedId]
    const color = override === undefined ? state.cards[movedId]?.color : override
    if (color !== 'red') return
    if (state.turnRedDiscardCount?.turnNumber !== state.turnNumber) state.turnRedDiscardCount = { turnNumber: state.turnNumber, count: 0 }
    state.turnRedDiscardCount.count += 1
  }
  removeCard(state, from, cardId)
  const replaced = addCard(state, to, cardId, options.toTop ?? false, options.toIndex)
  const virtualDelayedTrickDiscard = from.kind === 'judgingArea' && to.kind === 'discardPile' && Boolean(state.cards[cardId]?.virtual)
  if (from.kind === 'hand' && !(to.kind === 'hand' && to.playerId === from.playerId)) {
    const faceUp = state.faceUpHandCards?.[from.playerId]
    if (faceUp) {
      state.faceUpHandCards![from.playerId] = faceUp.filter((id) => id !== cardId)
      if (state.faceUpHandCards![from.playerId].length === 0) delete state.faceUpHandCards![from.playerId]
    }
  }
  recordRedDiscard(cardId, from, to)
  if (replaced) {
    const replacedTo = options.replaceEquipmentTo ?? { kind: 'discardPile' }
    addCard(state, replacedTo, replaced, false)
    if (to.kind === 'equipment') recordRedDiscard(replaced, to, replacedTo)
  }
  /*
   * 武将牌变的装备（神典韦【挈挟】）**一离开装备区就销毁**。
   *
   * 收在这个唯一出口，而不是在每个可能拿走装备的效果里各写一遍：
   * 顺手牵羊、过河拆桥、替换、技能取牌……任何一条路都会经过这里。
   * 漏一条，一张没有花色没有点数的「牌」就会跑进别人手里或者弃牌堆，
   * 之后被当成普通牌使用、判定、计点数。
   */
  /*
   * 进出弃牌堆时维护「它为什么在这儿」的记录：进去时记，离开时清。
   * 清这一步不能省——不清的话，一张被拿走又弃回来的牌会顶着上一次的原因。
   */
  if (to.kind === 'discardPile' && !virtualDelayedTrickDiscard) {
    recordDiscardEntry(state, cardId, from.kind, 'playerId' in from ? from.playerId : null, options.discardReason)
    const sourcePlayerId = 'playerId' in from ? from.playerId : null
    const category = state.cards[cardId]?.category
    const inferredReason = options.discardReason ?? (from.kind === 'hand' || from.kind === 'equipment' || from.kind === 'judgingArea' ? 'discard' : 'other')
    if (sourcePlayerId && inferredReason === 'discard' && category && from.kind !== 'privateZone') {
      recordTurnCardCategory(state, sourcePlayerId, category, 'discarded', cardId)
    }
  } else {
    clearDiscardEntry(state, cardId)
  }
  /*
   * 进出手牌时维护「它是从谁那里来的」：进手牌时记来源，离开手牌时清掉。
   * 法正【恩怨】按这个来源分组数张数，所以必须在移动这一刻记，
   * 事后回头看已经分不清一张手牌是摸来的还是抢来的了。
   */
  if (to.kind === 'hand') {
    recordGainEntry(state, cardId, 'playerId' in from ? from.playerId : null, to.playerId)
  } else {
    clearGainEntry(state, cardId)
  }
  // 这类装备只在「离开装备区」时销毁；从牌堆或处理区先进入手牌并不算失去装备。
  // 天书等效果会先令角色获得特殊装备，再立即使用，必须允许 hand -> processing -> equipment。
  if (from.kind === 'equipment' && to.kind !== 'equipment' && isCharacterEquipment(state, cardId)) destroyCharacterEquipment(state, cardId)
  if (from.kind === 'equipment' && to.kind !== 'equipment' && isSpecialEquipment(state, cardId)) {
    const card = state.cards[cardId]
    if (to.kind === 'discardPile' && card?.persistInDiscard && card.specialEquipment) {
      state.specialEquipmentRemoval ??= {}
      state.specialEquipmentRemoval[cardId] = card.specialEquipment
      if (card.rank !== undefined) {
        state.specialEquipmentRemovalRank ??= {}
        state.specialEquipmentRemovalRank[cardId] = card.rank
      }
    } else destroySpecialEquipment(state, cardId)
  }
  if (replaced && isCharacterEquipment(state, replaced)) destroyCharacterEquipment(state, replaced)
  if (replaced && isSpecialEquipment(state, replaced)) destroySpecialEquipment(state, replaced)
  // 「当作什么用」只在结算途中有意义。牌回到手牌、弃牌堆或牌堆就该忘掉，
  // 否则下次再摸到它还会顶着上一次的身份。闪电要在判定区之间流转，所以留着。
  if (to.kind !== 'judgingArea' && to.kind !== 'processingArea') {
    delete state.cardAliases[cardId]
    delete state.cardNatures[cardId]
    // 颜色改写和「当作什么用」同寿命：牌回到手牌、弃牌堆或牌堆就该忘掉
    clearCardColorOverride(state, cardId)
  }
  const observe = characterPileMoveObservers.get(state)
  if (observe && from.kind === 'characterPile') {
    observe({ ownerId: from.playerId, pile: from.pile, direction: 'leave', overflow: options.characterPileMoveReason === 'overflow',
      destinationKind: to.kind, destinationPlayerId: 'playerId' in to ? to.playerId : undefined })
  }
  if (observe && to.kind === 'characterPile') {
    observe({ ownerId: to.playerId, pile: to.pile, direction: 'enter', overflow: false })
  }
  if (from.kind === 'hand' && !state.cards[cardId]?.virtual
    && !(to.kind === 'hand' && to.playerId === from.playerId))
    notifyHandCardLeft(state, { cardId, playerId: from.playerId, destination: structuredClone(to) })
  if (to.kind === 'discardPile' && from.kind !== 'discardPile' && !virtualDelayedTrickDiscard) {
    const reason = options.discardReason ?? (from.kind === 'hand' || from.kind === 'equipment' || from.kind === 'judgingArea' ? 'discard' : 'other')
    discardEntryObservers.get(state)?.({ cardId, from: structuredClone(from), reason })
  }
  if (virtualDelayedTrickDiscard) {
    state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
    clearDiscardEntry(state, cardId)
    delete state.cards[cardId]
  }
  if (to.kind === 'equipment' || to.kind === 'judgingArea') {
    fieldEntryObservers.get(state)?.({ cardId, playerId: to.playerId, zone: to.kind, from: structuredClone(from) })
  }
  cardZoneObservers.get(state)?.({ cardId, from: structuredClone(from), to: structuredClone(to), color: movedCardColor })
}

/** 这张牌当前按什么牌名结算：有转化就用转化后的，否则用牌面上印的。 */
/**
 * 找出某张牌现在在这名角色的哪个区。
 *
 * 「弃置一张牌」在规则上包含手牌和装备，但调用方往往图省事写死
 * `{ kind: 'hand' }`——貂蝉【离间】就是这么坏的：用装备当代价时
 * `moveCard` 直接抛「卡牌不在来源区域」，整局崩掉。
 * 凡是让玩家从「手牌 + 装备」里挑牌的技能，都该用这个函数定位来源。
 */
export interface LocateOwnedCardOptions {
  /**
   * 连武将专属牌堆一起找（邓艾把「田」当【顺手牵羊】用）。
   *
   * **默认关闭**，而且必须由调用方显式打开：绝大多数调用点是「弃置 / 拆掉
   * 你的一张牌」，专属牌堆里的牌不该被这些流程碰到。周泰的「创」要是能被
   * 过河拆桥拆走，不屈就白写了。只有转化技使用牌的那条路径需要它。
   */
  includeCharacterPiles?: boolean
}

export function locateOwnedCard(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  options: LocateOwnedCardOptions = {},
): ZoneRef | null {
  const owner = state.players.find((candidate) => candidate.id === playerId)
  if (!owner) return null
  if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId }
  for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
    if (equipped === cardId) return { kind: 'equipment', playerId, slot: slot as EquipmentSlot }
  }
  if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId }
  if (options.includeCharacterPiles) {
    for (const [pile, ids] of Object.entries(owner.characterPiles ?? {})) {
      if (ids.includes(cardId)) return { kind: 'characterPile', playerId, pile }
    }
  }
  return null
}

export function effectiveCardName(state: SanguoshaState, cardId: CardId): string {
  return state.equipmentTransformations?.[cardId] ?? state.cardAliases[cardId] ?? state.cards[cardId]?.name ?? ''
}

/** Resolve an equipment card's permanent face modification without changing its physical slot. */
export function effectiveEquipmentName(state: SanguoshaState, cardId: CardId): string {
  return state.equipmentTransformations?.[cardId] ?? state.cards[cardId]?.name ?? ''
}

export function setEquipmentTransformation(state: SanguoshaState, cardId: CardId, name: string): void {
  state.equipmentTransformations ??= {}
  state.equipmentTransformations[cardId] = name
}

/** 记下一张牌「被当作什么用」。和牌面同名时不留记录，免得别名表越积越大。 */
export function setCardAlias(state: SanguoshaState, cardId: CardId, asName: string): void {
  if (state.cards[cardId]?.name === asName) delete state.cardAliases[cardId]
  else state.cardAliases[cardId] = asName
}

/**
 * 这次结算里这张牌算什么伤害属性。
 *
 * 默认取牌面自带的属性（【火杀】【雷杀】印在牌上）。但转化技可以把一张
 * 普通牌当作**火焰**【杀】使用（神赵云【龙魂】的方块），这时属性不在牌面上，
 * 只属于这一次使用，所以和 `cardAliases` 一样跟着牌走、离开结算区就清掉。
 */
export function effectiveDamageNature(state: SanguoshaState, cardId: CardId): DamageNature {
  return state.cardNatures[cardId] ?? state.cards[cardId]?.damageNature ?? 'normal'
}

/** 设定本次结算的伤害属性。传 null 清除。 */
export function setCardNature(state: SanguoshaState, cardId: CardId, nature: DamageNature | null): void {
  if (!nature || nature === (state.cards[cardId]?.damageNature ?? 'normal')) delete state.cardNatures[cardId]
  else state.cardNatures[cardId] = nature
}

export function allLocatedCardIds(state: SanguoshaState): CardId[] {
  const ids = [...state.zones.drawPile, ...state.zones.discardPile, ...state.zones.processingArea]
  for (const candidate of state.players) {
    ids.push(...candidate.zones.hand, ...candidate.zones.judgingArea)
    ids.push(...Object.values(candidate.zones.equipment).filter((id): id is CardId => Boolean(id)))
    // 专属牌堆也要算进守恒：漏了这里，一张牌进「创」就等于凭空消失
    for (const pile of Object.values(candidate.characterPiles ?? {})) ids.push(...pile)
  }
  // 私有暂存区同理：牌看不见不代表它不在场上
  for (const zone of state.privateZones ?? []) ids.push(...zone.cards)
  return ids
}

/** 诊断用：列出某张牌当前出现在哪些区域。正常只会有一个。 */
function zonesHolding(state: SanguoshaState, cardId: CardId): string[] {
  const found: string[] = []
  if (state.zones.drawPile.includes(cardId)) found.push('drawPile')
  if (state.zones.discardPile.includes(cardId)) found.push('discardPile')
  if (state.zones.processingArea.includes(cardId)) found.push('processingArea')
  for (const player of state.players) {
    if (player.zones.hand.includes(cardId)) found.push(`hand:${player.id}`)
    if (player.zones.judgingArea.includes(cardId)) found.push(`judge:${player.id}`)
    for (const [slot, id] of Object.entries(player.zones.equipment)) if (id === cardId) found.push(`equip:${player.id}:${slot}`)
    for (const [pile, ids] of Object.entries(player.characterPiles ?? {})) if (ids.includes(cardId)) found.push(`pile:${player.id}:${pile}`)
  }
  for (const zone of state.privateZones ?? []) if (zone.cards.includes(cardId)) found.push(`private:${zone.id}`)
  return found
}

export function assertCardConservation(state: SanguoshaState): void {
  const located = allLocatedCardIds(state)
  const unique = new Set(located)
  if (unique.size !== located.length) {
    // 只说「有重复」定位不了问题，把是哪张牌、在哪几个区域一起报出来
    const seen = new Set<CardId>()
    const duplicated = located.filter((cardId) => (seen.has(cardId) ? true : (seen.add(cardId), false)))
    throw new Error(`同一张牌同时出现在多个区域：${[...new Set(duplicated)].map((cardId) => `${cardId}@${zonesHolding(state, cardId).join('+')}`).join('，')}`)
  }
  const known = Object.keys(state.cards)
  if (unique.size !== known.length || known.some((id) => !unique.has(id))) throw new Error('牌张不守恒：存在丢失或未知位置的牌')
}
