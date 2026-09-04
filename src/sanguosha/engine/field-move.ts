import { DELAYED_TRICKS } from './cards/tricks'
import type { EquipmentHost } from './equipment'
import { handleEquipmentLost } from './equipment'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from './types'
import { effectiveCardName, moveCard, type ZoneRef } from './zones'

/**
 * 「移动场上的一张牌」的公共实现。
 *
 * 场上的牌指**装备区和判定区**的牌，不含手牌、牌堆、弃牌堆和武将专属牌堆。
 * 张郃【巧变】跳过出牌阶段后用它；以后同类效果（移动装备、转移延时锦囊）
 * 一律复用这里，不要各写一份。
 *
 * 两条硬约束：
 *
 * 1. **必须是直接移动，保留同一个 Card ID。** 不能实现成「先弃置再获得」——
 *    那会多触发一次弃牌时机，延时锦囊还会因为路过弃牌堆而丢掉判定区身份。
 * 2. **合法位置由这里统一判定。** 装备只能进同名装备槽且该槽为空，
 *    延时锦囊只能进判定区且目标没有同名延时锦囊。调用方不要按牌名
 *    自己写一遍规则。
 */


export interface FieldCard {
  cardId: CardId
  ownerId: PlayerId
  /** 装备区牌带槽位；判定区牌没有。 */
  slot: EquipmentSlot | null
  /** 结算时按这个名字判合法性，转化过的延时锦囊按转化后的名字算。 */
  name: string
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

/** 场上现在有哪些可以被移动的牌。死人身上的牌不算——他已经不在场上了。 */
export function fieldCards(state: SanguoshaState): FieldCard[] {
  const result: FieldCard[] = []
  for (const owner of state.players) {
    if (!owner.alive) continue
    for (const [slot, cardId] of Object.entries(owner.zones.equipment)) {
      if (!cardId) continue
      result.push({ cardId, ownerId: owner.id, slot: slot as EquipmentSlot, name: effectiveCardName(state, cardId) })
    }
    for (const cardId of owner.zones.judgingArea) {
      result.push({ cardId, ownerId: owner.id, slot: null, name: effectiveCardName(state, cardId) })
    }
  }
  return result
}

/** 这张场上的牌现在在谁那里、在哪个区。不在场上返回 null。 */
export function locateFieldCard(state: SanguoshaState, cardId: CardId): FieldCard | null {
  return fieldCards(state).find((candidate) => candidate.cardId === cardId) ?? null
}

function hasDelayedTrick(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return playerOf(state, playerId).zones.judgingArea.some((candidate) => effectiveCardName(state, candidate) === name)
}

/**
 * 这张场上的牌能移动到谁那里。
 *
 * 装备：目标的同名装备槽必须是空的。规则上一个人只能装一把武器，
 * 所以不允许挤掉已有装备——那是「替换」不是「移动」。
 * 延时锦囊：目标判定区不能已经有同名的延时锦囊（含【闪电】）。
 */
export function fieldMoveDestinations(state: SanguoshaState, cardId: CardId): PlayerId[] {
  const source = locateFieldCard(state, cardId)
  if (!source) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== source.ownerId)
    .filter((candidate) => (source.slot
      ? candidate.zones.equipment[source.slot] === null
      : DELAYED_TRICKS.has(source.name) && !hasDelayedTrick(state, candidate.id, source.name)))
    .map((candidate) => candidate.id)
}

/**
 * 把场上的一张牌移动到另一名角色的对应区域。
 *
 * 装备离场仍然走 `handleEquipmentLost`（白银狮子回血、孙尚香【枭姬】都挂在那里），
 * 所以移动装备的时机链和被拆、被顺走是同一条。
 */
export function moveFieldCard(host: EquipmentHost, cardId: CardId, toPlayerId: PlayerId): void {
  const source = locateFieldCard(host.state, cardId)
  if (!source) throw new Error('这张牌不在场上')
  if (!fieldMoveDestinations(host.state, cardId).includes(toPlayerId)) throw new Error('目标区域不能放置这张牌')

  const from: ZoneRef = source.slot
    ? { kind: 'equipment', playerId: source.ownerId, slot: source.slot }
    : { kind: 'judgingArea', playerId: source.ownerId }
  const to: ZoneRef = source.slot
    ? { kind: 'equipment', playerId: toPlayerId, slot: source.slot }
    : { kind: 'judgingArea', playerId: toPlayerId }

  moveCard(host.state, cardId, from, to)
  host.dispatch('FieldCardMoved', {
    cardId,
    fromPlayerId: source.ownerId,
    toPlayerId,
    zone: source.slot ? 'equipment' : 'judgingArea',
    ...(source.slot ? { slot: source.slot } : {}),
  }, { sourceId: source.ownerId, targetId: toPlayerId, cardIds: [cardId] })

  // 装备确实离开了原主的装备区，走和被拆、被顺走同一条失去时机
  if (source.slot) handleEquipmentLost(host, source.ownerId, cardId)
}
