import type { EquipmentHost } from './equipment'
import type { CardId, PlayerId } from './types'

/**
 * 「一次失去装备区里的牌」——**按原子操作计数**的装备离场事件。
 *
 * 已经有的 `LoseEquipment` 是**每张一条**：孙尚香【枭姬】要的就是那个粒度，
 * 一次失去两件装备就摸四张牌。但凌统【旋风】要的是另一个粒度：
 * 「每当你失去装备区里的牌后」，甘露一次换掉三件装备只给**一次**发动机会，
 * 不是三次。
 *
 * 两个粒度都真实存在，所以两条事件都要有，不能拿一条去凑另一条：
 *
 * - 用 `LoseEquipment` 去数「几次」，一次换三件就变成三次旋风；
 * - 用这条去数「几张」，枭姬就只摸两张。
 *
 * 约定：**任何让牌离开装备区的路径，恰好发出一条 `EquipmentZoneLoss`。**
 * 单张路径由 `handleEquipmentLost` 自己发；成批路径（弃置所有牌、甘露互换）
 * 先把每张都按 `batched` 处理，最后由调用方发一条总的。
 */
export function dispatchEquipmentZoneLoss(
  host: EquipmentHost,
  playerId: PlayerId,
  cardIds: readonly CardId[],
): void {
  if (cardIds.length === 0) return
  host.dispatch('EquipmentZoneLoss', { playerId, cardIds: [...cardIds] }, { targetId: playerId, cardIds: [...cardIds] })
}
