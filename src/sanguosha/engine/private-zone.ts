import type { CardId, PlayerId, PrivateCardZone, SanguoshaState } from './types'
import { moveCard, type ZoneRef } from './zones'

/**
 * 私有暂存牌区的读写入口。
 *
 * 处理区是完全公开的，任何进去的牌全场都能在 PlayerView 里看到牌名花色点数。
 * 「先扣一张牌、稍后才揭示」的效果必须走这里——把牌塞进处理区再让前端别显示，
 * 网络包里照样是明文。
 *
 * 技能不要直接改 `state.privateZones`：建区、放牌、取回、清理都走这几个函数，
 * 牌张守恒和清理才有唯一的入口。
 */

/** 建一个私有区并返回它的 id。同一个 id 建两次是调用方的 bug。 */
export function openPrivateZone(state: SanguoshaState, id: string, ownerId: PlayerId, reason: string): string {
  const zones = state.privateZones ?? (state.privateZones = [])
  if (zones.some((zone) => zone.id === id)) throw new Error(`私有牌区重复创建：${id}`)
  if (!state.players.some((player) => player.id === ownerId)) throw new Error(`私有牌区的主人不存在：${ownerId}`)
  zones.push({ id, ownerId, reason, cards: [] })
  return id
}

export function findPrivateZone(state: SanguoshaState, id: string): PrivateCardZone | undefined {
  return (state.privateZones ?? []).find((zone) => zone.id === id)
}

/** 私有区里现在有哪些牌。区不存在时返回空数组，调用方不必先判空。 */
export function privateZoneCards(state: SanguoshaState, id: string): CardId[] {
  return findPrivateZone(state, id)?.cards ?? []
}

/** 把一张牌从某处移进私有区。 */
export function moveIntoPrivateZone(state: SanguoshaState, cardId: CardId, from: ZoneRef, zoneId: string): void {
  if (!findPrivateZone(state, zoneId)) throw new Error(`私有牌区不存在：${zoneId}`)
  moveCard(state, cardId, from, { kind: 'privateZone', zoneId })
}

/** 把私有区里的一张牌移到别处。 */
export function moveOutOfPrivateZone(state: SanguoshaState, cardId: CardId, zoneId: string, to: ZoneRef): void {
  if (!findPrivateZone(state, zoneId)) throw new Error(`私有牌区不存在：${zoneId}`)
  moveCard(state, cardId, { kind: 'privateZone', zoneId }, to)
}

/**
 * 关掉一个私有区。
 *
 * 里面还剩的牌一律送进 `fallback`（默认弃牌堆）——**绝不能连区带牌一起删掉**，
 * 那就是凭空销毁实体牌。任何退出路径（正常结束、取消、超时、主人死亡、
 * 牌局结束）都要调用它。
 */
export function closePrivateZone(
  state: SanguoshaState,
  id: string,
  fallback: ZoneRef = { kind: 'discardPile' },
): CardId[] {
  const zones = state.privateZones ?? []
  const zone = zones.find((candidate) => candidate.id === id)
  if (!zone) return []
  const leftover = [...zone.cards]
  for (const cardId of leftover) moveCard(state, cardId, { kind: 'privateZone', zoneId: id }, fallback)
  state.privateZones = zones.filter((candidate) => candidate.id !== id)
  return leftover
}
