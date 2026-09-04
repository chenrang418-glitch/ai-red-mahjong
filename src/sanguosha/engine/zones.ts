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

function addCard(state: SanguoshaState, zone: ZoneRef, cardId: CardId, toTop: boolean): CardId | null {
  if (zone.kind === 'equipment') {
    const equipment = player(state, zone.playerId).zones.equipment
    const replaced = equipment[zone.slot]
    equipment[zone.slot] = cardId
    return replaced
  }
  const cards = zoneCards(state, zone)
  if (zone.kind === 'drawPile' && toTop) cards.unshift(cardId)
  else cards.push(cardId)
  return null
}

export interface MoveCardOptions {
  toTop?: boolean
  replaceEquipmentTo?: ZoneRef
}

/** 单一卡牌移动真相入口；装备替换默认把旧装备移入弃牌堆。 */
export function moveCard(state: SanguoshaState, cardId: CardId, from: ZoneRef, to: ZoneRef, options: MoveCardOptions = {}): void {
  if (!state.cards[cardId]) throw new Error(`未知卡牌：${cardId}`)
  removeCard(state, from, cardId)
  const replaced = addCard(state, to, cardId, options.toTop ?? false)
  if (replaced) addCard(state, options.replaceEquipmentTo ?? { kind: 'discardPile' }, replaced, false)
  // 「当作什么用」只在结算途中有意义。牌回到手牌、弃牌堆或牌堆就该忘掉，
  // 否则下次再摸到它还会顶着上一次的身份。闪电要在判定区之间流转，所以留着。
  if (to.kind !== 'judgingArea' && to.kind !== 'processingArea') {
    delete state.cardAliases[cardId]
    delete state.cardNatures[cardId]
  }
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
  return state.cardAliases[cardId] ?? state.cards[cardId]?.name ?? ''
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
