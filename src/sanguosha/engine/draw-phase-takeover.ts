import type { EventContext } from './events'
import type { SkillHost } from './skills/runtime'
import type { PlayerId } from './types'

/**
 * 「摸牌阶段，你可以放弃摸牌，改为……」的公共接管入口。
 *
 * 张辽【突袭】、典韦【裸衣】、法正【眩惑】走的是同一条路，三件事一件都不能少：
 *
 * 1. **必须是自己的摸牌阶段。** `DrawPhase` 是全局事件，每个人的摸牌阶段
 *    都会发一条；不比对 `playerId` 的话，别人摸牌时技能也会跳出来。
 * 2. **接管之后引擎不再默认摸牌。** 取消默认摸牌和「技能负责把牌补上」
 *    是同一个承诺的两半：只取消不补，玩家白白少摸两张；只补不取消，
 *    他这一阶段摸了四张。所以接管方**必须**在自己的分支里
 *    要么发动、要么按原样摸牌。
 * 3. **有别的技能正在等回应时不能接管。** 单个挂起槽已经被占，
 *    这时候再发问会直接抛「已有技能正在等待回应」，整局崩在摸牌阶段。
 *    让位的结果是照常摸牌，这比崩掉好。
 *
 * 返回 true 表示接管成功，调用方接着发问；返回 false 表示这次轮不到它，
 * 调用方**什么都不要做**——默认摸牌还在原地。
 */
export function takeOverDrawPhase(host: SkillHost, ownerId: PlayerId, context: EventContext): boolean {
  const payload = context.event.payload as { playerId?: PlayerId }
  if (payload.playerId !== ownerId) return false
  const owner = host.state.players.find((candidate) => candidate.id === ownerId)
  if (!owner?.alive) return false
  if (host.state.skillResolution) return false
  context.cancel()
  return true
}
