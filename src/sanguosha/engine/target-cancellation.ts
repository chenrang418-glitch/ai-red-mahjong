import type { SkillHost } from './skills/runtime'
import type { PlayerId } from './types'

/**
 * 「此牌对**我**无效」——成为目标之后，只取消自己这一个目标。
 *
 * 刘禅【享乐】和王异【贞烈】要的是同一件事，只是触发条件不同。
 * 【杀】和普通锦囊走的是两条结算管线，取消的出口也不一样，
 * 所以收在这里，技能不必各自认路。
 *
 * 三条纪律：
 *
 * 1. **只取消自己这一个目标，不是整张牌。** 南蛮万箭对别人照常结算——
 *    把整张牌作废是完全不同的效果（那是【无懈可击】）。
 * 2. **不能改成「把伤害改成 0」。** 那样这张牌仍然算命中了我，
 *    求闪、铁骑、麒麟弓这些「命中之后」的时机照样跑一遍。
 * 3. **取消之后要把控制权交回结算管线**（`resumeCardTarget`），
 *    否则整张牌停在「成为目标」那一步。
 */
export function cancelCardTargetForOwner(host: SkillHost, ownerId: PlayerId): boolean {
  const resolution = host.state.cardResolution
  if (!resolution) return false

  if (resolution.kind === 'slash') {
    if (resolution.targetId !== ownerId) return false
    resolution.targetCancelled = true
    return true
  }

  if (resolution.kind === 'trick') {
    // 只认**正在结算的那个目标**：多目标锦囊里别人的那一份不受影响
    if (resolution.targetIds[resolution.targetIndex] !== ownerId) return false
    if (!resolution.cancelledTargetIds.includes(ownerId)) resolution.cancelledTargetIds.push(ownerId)
    return true
  }

  return false
}

/** 当前正在结算的这张牌，对 `ownerId` 来说是不是「其他角色使用的」。 */
export function currentCardUserIsOther(host: SkillHost, ownerId: PlayerId): boolean {
  const resolution = host.state.cardResolution
  if (!resolution) return false
  return resolution.sourceId !== ownerId
}
