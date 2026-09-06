import type { CardId, CharacterId, PhysicalCard, PlayerId, SanguoshaState } from './types'

/**
 * 「武将牌当装备用」的实例（神典韦【挈挟】）。
 *
 * 这类东西**不是牌堆里的牌**，但它确实躺在装备区里，所以引擎的其他部分
 * （攻击范围、装备技能、界面）都要能像看一张装备那样看它。做法是给它一个
 * 正常的卡牌对象，同时打上两个标记：`characterId` 说明它来自哪张武将牌，
 * `generatedBy` 说明它是被生成出来的、不属于牌堆构成。
 *
 * 三条硬性质，缺一条都会出事：
 *
 * 1. **没有花色、没有点数、没有颜色。** 借用 `virtual: true` 这个既有约定——
 *    引擎里所有按花色 / 点数判断的地方都已经要求先看 `virtual`。
 *    否则它会被当成一张黑色的、点数 1 的武器牌，被顺手牵羊、被判定、被算点数。
 * 2. **离开装备区就销毁。** 不进手牌、不进弃牌堆、不进牌堆——
 *    被拆被顺被替换都一样。销毁在 `moveCard` 那个唯一出口统一处理。
 * 3. **不参与牌堆守恒的「一副牌」概念，但参与「每张牌只在一个区域」**。
 *    它在 `state.cards` 里有条目，也确实在装备区，所以守恒仍然成立；
 *    销毁时要把条目一起删掉，否则就成了「有牌却不在任何区域」。
 */

/** 判断一张牌是不是武将牌变的装备。 */
export function isCharacterEquipment(state: SanguoshaState, cardId: CardId): boolean {
  return state.cards[cardId]?.generatedBy === 'character-equipment'
}

/** 这张武将装备背后是哪名武将。 */
export function characterOfEquipment(state: SanguoshaState, cardId: CardId): CharacterId | null {
  const card = state.cards[cardId]
  if (card?.generatedBy !== 'character-equipment') return null
  return card.characterId ?? null
}

/**
 * 造一张武将牌武器，放进 `state.cards` 并**暂存到处理区**。
 *
 * 暂存这一步不能省：牌张守恒要求每张牌在任何一刻都待在某个区域里，
 * 只写进 `state.cards` 就成了「有牌却不在任何区域」。调用方拿到 id 之后
 * 用 `moveCard` 从处理区搬进装备栏——那条路径也才走得通。
 *
 * 攻击范围取的是**武将牌上的体力上限**，不是持有者当前的体力值：
 * 一张 4 血武将牌永远是 4 的攻击范围，哪怕拿着它的人只剩 1 血。
 */
export function createCharacterWeapon(
  state: SanguoshaState,
  characterId: CharacterId,
  characterName: string,
  maxHp: number,
): CardId {
  const cardId = `character-equipment:${characterId}:${state.seq + 1}:${Object.keys(state.cards).length}`
  const card: PhysicalCard = {
    id: cardId,
    ruleset: state.rulesetVersion,
    expansion: 'standard',
    name: characterName,
    /*
     * 花色、点数、颜色都是占位：这三个字段在类型上是必填的，
     * 但 `virtual: true` 已经声明了「这张牌没有真实花色和点数」，
     * 规则判断必须查 `virtual`，不能读这三个字段。
     */
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'equipment',
    equipmentSlot: 'weapon',
    attackRange: Math.max(1, maxHp),
    virtual: true,
    characterId,
    generatedBy: 'character-equipment',
  }
  state.cards[cardId] = card
  state.zones.processingArea.push(cardId)
  return cardId
}

/**
 * 销毁一张武将装备：从它所在的区域摘掉，并从 `state.cards` 里删除。
 *
 * 只在它**已经离开装备区**之后调用。返回是否真的销毁了。
 */
export function destroyCharacterEquipment(state: SanguoshaState, cardId: CardId): boolean {
  if (!isCharacterEquipment(state, cardId)) return false
  state.zones.drawPile = state.zones.drawPile.filter((id) => id !== cardId)
  state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
  state.zones.processingArea = state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) player.zones.equipment[slot as keyof typeof player.zones.equipment] = null
    }
    for (const [pile, ids] of Object.entries(player.characterPiles ?? {})) {
      if (ids.includes(cardId)) player.characterPiles![pile] = ids.filter((id) => id !== cardId)
    }
  }
  for (const zone of state.privateZones ?? []) {
    zone.cards = zone.cards.filter((id) => id !== cardId)
  }
  delete state.cards[cardId]
  return true
}

/** 某名角色装备区里的武将装备。 */
export function characterEquipmentOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  return Object.values(player.zones.equipment)
    .filter((cardId): cardId is CardId => !!cardId && isCharacterEquipment(state, cardId))
}

/** 场上所有武将装备正在占用哪些武将（不能重复取样同一名武将）。 */
export function occupiedCharacterIds(state: SanguoshaState): CharacterId[] {
  return Object.values(state.cards)
    .filter((card) => card.generatedBy === 'character-equipment' && card.characterId)
    .map((card) => card.characterId!)
}
