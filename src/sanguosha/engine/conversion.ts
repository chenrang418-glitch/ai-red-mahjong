import type { PlayerId, SanguoshaState } from './types'

/**
 * 转换技的公共状态。
 *
 * 转换技在阴阳两态之间交替：每次**成功发动**之后切换到另一态。
 * 神刘备【龙怒】是本项目第一个，后面的现代武将还会有。
 *
 * 三条纪律：
 *
 * 1. **不能按回合奇偶或轮次推导。** 龙怒只在出牌阶段开始时触发，
 *    出牌阶段被跳过时既不结算也不切换——按回合数推导必然对不上。
 * 2. **是持久状态**，跟着牌局序列化，重连不能丢，回合结束也不清除。
 * 3. **切换发生在成功结算之后**，不是发问之前。
 */

export type ConversionState = 'yang' | 'yin'

/** 状态的键：一名角色的一个技能一份。同一人有两个转换技时互不干扰。 */
function keyOf(playerId: PlayerId, skillId: string): string {
  return `${playerId}:${skillId}`
}

/** 当前处于阴还是阳。**初始为阳**，没有记录时就是初始态。 */
export function conversionStateOf(
  state: SanguoshaState,
  playerId: PlayerId,
  skillId: string,
): ConversionState {
  return state.conversionStates?.[keyOf(playerId, skillId)] ?? 'yang'
}

/** 切换到另一态。只在技能真正结算完成之后调用。 */
export function toggleConversionState(
  state: SanguoshaState,
  playerId: PlayerId,
  skillId: string,
): ConversionState {
  state.conversionStates ??= {}
  const next: ConversionState = conversionStateOf(state, playerId, skillId) === 'yang' ? 'yin' : 'yang'
  state.conversionStates[keyOf(playerId, skillId)] = next
  return next
}

/** 显式设定，主要给测试和重连校验用。 */
export function setConversionState(
  state: SanguoshaState,
  playerId: PlayerId,
  skillId: string,
  value: ConversionState,
): void {
  state.conversionStates ??= {}
  state.conversionStates[keyOf(playerId, skillId)] = value
}
