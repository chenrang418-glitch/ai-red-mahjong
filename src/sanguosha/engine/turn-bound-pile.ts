import { handleEquipmentLost, type EquipmentHost } from './equipment'
import { dispatchEquipmentZoneLoss } from './equipment-zone-loss'
import { locateOwnedCard, moveCard } from './zones'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 「暂时扣置到武将牌旁、当前回合结束后归还」的公共牌区。
 *
 * 徐盛【破军】是第一个用户：把目标的若干张牌扣在他自己的武将牌旁，
 * 这一整个回合结束之后再还给他。以后凡是「先拿走、稍后还回来」的效果
 * 一律复用这里。
 *
 * 六条纪律：
 *
 * 1. **牌真的离开原来的区。** 装备是真的离开装备区——枭姬、旋风、
 *    白银狮子照常触发。「只是暂时扣置」不能成为绕过装备离场的理由。
 * 2. **一次扣置是一次原子移动。** 多张牌同时走，不是一张一张搬；
 *    装备那一批整体只算一次「失去装备区里的牌」（旋风按次数）。
 * 3. **可见性跟着来源走。** 原来暗的（手牌）扣置之后仍然只有主人看得见；
 *    原来明置的（装备）仍然公开。所以分成两个堆：暗的那个登记进
 *    `hiddenCharacterPiles`，明的那个不登记。**不是「发了再让前端别显示」**，
 *    是根本不下发。
 * 4. **绑定的是「这一个回合」**，不是轮次、也不是施加者的下一个回合。
 *    额外回合各自独立。
 * 5. **归还一律进手牌。** 原本是装备的也一样，不会自动重新装备。
 * 6. **主人死亡时这些牌直接进弃牌堆**，而且原因是「专属牌堆清理」——
 *    不是「弃置」。它们此刻既不是他的手牌也不是他的装备，
 *    所以行殇拿不到，落英也接不住。
 */

/** 暗置的那一堆：只有主人看得见牌面。 */
export const DETAINED_HIDDEN_PILE = 'detained'
/** 明置的那一堆：原本就公开的牌（装备）扣置之后仍然公开。 */
export const DETAINED_OPEN_PILE = 'detained-open'

export interface DetainedCardEntry {
  cardId: CardId
  /** 这张牌是谁的，回合结束后还给他。 */
  ownerId: PlayerId
  /** 谁扣的。战报和调试用；也让「同一个来源本回合扣的牌」可以被找出来。 */
  sourceId: PlayerId
  skillId: string
  /** 扣置时的回合序号。**归还绑定的是这一个回合**，不是轮次。 */
  turnNumber: number
  /** 在哪一堆里（暗 / 明），决定它的可见性。 */
  pile: string
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 这名角色现在被扣置着的牌。 */
export function detainedCardsOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return (state.detainedCards ?? []).filter((entry) => entry.ownerId === ownerId).map((entry) => entry.cardId)
}

/** 这张牌现在是不是被扣置着（被扣的牌不能使用、打出、弃置）。 */
export function isDetained(state: SanguoshaState, cardId: CardId): boolean {
  return (state.detainedCards ?? []).some((entry) => entry.cardId === cardId)
}

export interface DetainOptions {
  ownerId: PlayerId
  sourceId: PlayerId
  skillId: string
  cardIds: readonly CardId[]
}

/**
 * 把若干张牌扣置到主人的武将牌旁。
 *
 * 只认**此刻确实在主人手牌或装备区**的牌：判定区不在范围内，
 * 已经被别的效果拿走的牌也不能再扣一次（那会凭空多出一张）。
 * 返回真正扣下来的牌。
 */
export function detainCards(host: EquipmentHost, options: DetainOptions): CardId[] {
  const owner = playerOf(host.state, options.ownerId)
  if (!owner?.alive) return []

  const detained: CardId[] = []
  const equipmentLost: CardId[] = []
  const seen = new Set<CardId>()
  for (const cardId of options.cardIds) {
    if (seen.has(cardId)) continue
    seen.add(cardId)
    const from = locateOwnedCard(host.state, options.ownerId, cardId)
    // 只收手牌和装备区：判定区、别的专属牌堆一概不动
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) continue
    const fromEquipment = from.kind === 'equipment'
    const pile = fromEquipment ? DETAINED_OPEN_PILE : DETAINED_HIDDEN_PILE
    moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: options.ownerId, pile })
    host.state.detainedCards ??= []
    host.state.detainedCards.push({
      cardId,
      ownerId: options.ownerId,
      sourceId: options.sourceId,
      skillId: options.skillId,
      turnNumber: host.state.turnNumber,
      pile,
    })
    if (fromEquipment) equipmentLost.push(cardId)
    detained.push(cardId)
  }
  if (detained.length === 0) return []

  /*
   * 暗的那一堆登记成「只有主人看得见」。明的那一堆不登记——
   * 装备本来就是公开信息，扣置之后没有理由变成秘密。
   */
  if (detained.some((cardId) => pileOf(host.state, cardId) === DETAINED_HIDDEN_PILE)) {
    owner.hiddenCharacterPiles = [...new Set([...(owner.hiddenCharacterPiles ?? []), DETAINED_HIDDEN_PILE])]
  }
  /*
   * 装备离场统一在**牌全部搬完之后**跑：离场处理会触发技能，
   * 那些技能读到的必须是这次扣置完成后的场面。
   * 每张一条 `LoseEquipment`（枭姬按张数），整批一条 `EquipmentZoneLoss`（旋风按次数）。
   */
  for (const cardId of equipmentLost) handleEquipmentLost(host, options.ownerId, cardId, { batched: true })
  dispatchEquipmentZoneLoss(host, options.ownerId, equipmentLost)
  host.dispatch('LoseCard', {
    playerId: options.ownerId, cardIds: detained, reason: options.skillId,
  }, { targetId: options.ownerId, cardIds: detained })
  return detained
}

function pileOf(state: SanguoshaState, cardId: CardId): string | null {
  return (state.detainedCards ?? []).find((entry) => entry.cardId === cardId)?.pile ?? null
}

/**
 * 把这一个回合扣置的牌全部还给各自的主人。
 *
 * **一律进手牌**：原本是装备的也一样，不会自动重新装备。
 * 主人已经不在场上时不还——那些牌在他死亡时就已经清理掉了。
 */
export function returnDetainedCards(
  state: SanguoshaState,
  turnNumber: number,
  emit?: (name: 'GainCard', payload: Record<string, unknown>) => void,
): void {
  const entries = (state.detainedCards ?? []).filter((entry) => entry.turnNumber === turnNumber)
  if (entries.length === 0) return
  state.detainedCards = (state.detainedCards ?? []).filter((entry) => entry.turnNumber !== turnNumber)

  const byOwner = new Map<PlayerId, CardId[]>()
  for (const entry of entries) {
    const owner = playerOf(state, entry.ownerId)
    if (!owner?.alive) continue
    // 牌可能已经被别的效果从堆里拿走了，那就不再搬一次
    if (!(owner.characterPiles?.[entry.pile] ?? []).includes(entry.cardId)) continue
    moveCard(
      state, entry.cardId,
      { kind: 'characterPile', playerId: entry.ownerId, pile: entry.pile },
      { kind: 'hand', playerId: entry.ownerId },
    )
    byOwner.set(entry.ownerId, [...(byOwner.get(entry.ownerId) ?? []), entry.cardId])
  }
  for (const [ownerId, cardIds] of byOwner) {
    emit?.('GainCard', { playerId: ownerId, cardIds, reason: 'detained-return' })
  }
  clearEmptyHiddenPiles(state)
}

/**
 * 主人死亡：他被扣置的牌**直接进弃牌堆**。
 *
 * 原因写成 `special-pile-cleanup` 而不是 `discard`：这些牌此刻既不是他的手牌
 * 也不是他的装备，所以「获得死亡角色的牌」（行殇）拿不到它们，
 * 「因弃置进入弃牌堆」（落英）也不该被它们触发。
 */
export function cleanupDetainedCardsOf(host: EquipmentHost, ownerId: PlayerId): CardId[] {
  const entries = (host.state.detainedCards ?? []).filter((entry) => entry.ownerId === ownerId)
  if (entries.length === 0) return []
  host.state.detainedCards = (host.state.detainedCards ?? []).filter((entry) => entry.ownerId !== ownerId)

  const owner = playerOf(host.state, ownerId)
  const cleaned: CardId[] = []
  for (const entry of entries) {
    if (!(owner?.characterPiles?.[entry.pile] ?? []).includes(entry.cardId)) continue
    moveCard(
      host.state, entry.cardId,
      { kind: 'characterPile', playerId: ownerId, pile: entry.pile },
      { kind: 'discardPile' },
      { discardReason: 'other' },
    )
    cleaned.push(entry.cardId)
  }
  if (cleaned.length > 0) {
    host.dispatch('CardMove', {
      cardIds: cleaned, reason: 'special-pile-cleanup', sourcePlayerId: ownerId, revealed: true,
    }, { targetId: ownerId, cardIds: cleaned })
  }
  clearEmptyHiddenPiles(host.state)
  return cleaned
}

/** 堆空了就把「只有主人看得见」的登记撤掉，免得它越积越长。 */
function clearEmptyHiddenPiles(state: SanguoshaState): void {
  for (const player of state.players) {
    if (!player.hiddenCharacterPiles?.includes(DETAINED_HIDDEN_PILE)) continue
    if ((player.characterPiles?.[DETAINED_HIDDEN_PILE] ?? []).length > 0) continue
    player.hiddenCharacterPiles = player.hiddenCharacterPiles.filter((pile) => pile !== DETAINED_HIDDEN_PILE)
  }
}

/** 这张牌在哪个栏位上（给测试和调试读）。 */
export function detainedEntryOf(state: SanguoshaState, cardId: CardId): DetainedCardEntry | null {
  return (state.detainedCards ?? []).find((entry) => entry.cardId === cardId) ?? null
}
