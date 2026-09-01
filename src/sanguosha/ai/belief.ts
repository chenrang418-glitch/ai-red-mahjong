import type { PlayerId } from '../engine/types'
import type { PlayerView } from '../engine/view'

/**
 * 身份推测。
 *
 * **AI 只能看 PlayerView，未公开身份在那里就是 null，物理上读不到。**
 * 所以阵营判断只能靠行为推断——这也是任务书明确要求的：
 * 不允许「困难 AI 偷看所有身份」这种做法来提升难度。
 *
 * 这里用最朴素的怀疑度累加，不做机器学习：
 * 打主公 → 更像反贼；救主公、打反贼 → 更像忠臣。
 */

/** 正数表示更像反贼，负数表示更像主忠。 */
export type SuspicionMap = Record<PlayerId, number>

export interface BeliefInput {
  view: PlayerView
  /** 已经观察到的行为记录，由调用方在每次收到新视图时累加 */
  history: SuspicionMap
}

export function emptySuspicion(view: PlayerView): SuspicionMap {
  return Object.fromEntries(view.players.map((player) => [player.id, 0]))
}

/** 找出已经公开身份的主公。身份局开局就公开主公。 */
export function lordOf(view: PlayerView): PlayerId | null {
  return view.players.find((player) => player.identity === 'lord')?.id ?? null
}

/**
 * 观察一次伤害并更新怀疑度。
 * 调用方在 Damaged 事件对应的视图更新时调用。
 */
export function observeDamage(
  suspicion: SuspicionMap,
  view: PlayerView,
  sourceId: PlayerId | null,
  targetId: PlayerId,
): void {
  if (!sourceId || sourceId === targetId) return
  const lord = lordOf(view)
  if (!lord) return
  if (targetId === lord) {
    suspicion[sourceId] = (suspicion[sourceId] ?? 0) + 2
    return
  }
  // 打了一个已经很像反贼的人，说明自己更可能是主忠
  if ((suspicion[targetId] ?? 0) > 0) suspicion[sourceId] = (suspicion[sourceId] ?? 0) - 1
}

/** 观察一次回复：给主公回血的人更像忠臣。 */
export function observeRecover(suspicion: SuspicionMap, view: PlayerView, sourceId: PlayerId | null, targetId: PlayerId): void {
  if (!sourceId || sourceId === targetId) return
  const lord = lordOf(view)
  if (targetId === lord) suspicion[sourceId] = (suspicion[sourceId] ?? 0) - 2
}

/**
 * 从我的身份出发，判断某人是不是敌人。
 *
 * 我自己的身份是知道的（PlayerView 里 viewer 自己的 identity 不会被抹掉），
 * 但别人的只能靠 suspicion 猜。
 */
export function isLikelyEnemy(view: PlayerView, suspicion: SuspicionMap, targetId: PlayerId): boolean {
  const me = view.players.find((player) => player.id === view.viewerId)
  if (!me || targetId === view.viewerId) return false
  const target = view.players.find((player) => player.id === targetId)
  if (!target?.alive) return false

  // 身份已经公开的直接按阵营算
  if (target.identity) {
    if (me.identity === 'rebel') return target.identity === 'lord' || target.identity === 'loyalist'
    if (me.identity === 'loyalist') return target.identity === 'rebel' || target.identity === 'renegade'
    if (me.identity === 'lord') return target.identity === 'rebel' || target.identity === 'renegade'
    // 内奸谁都可能打，先跟着场面走
    return false
  }

  const score = suspicion[targetId] ?? 0
  if (me.identity === 'rebel') {
    // 反贼优先打主公，其次打看起来像忠臣的
    return score < 0
  }
  if (me.identity === 'loyalist' || me.identity === 'lord') return score > 0
  // 内奸：谁血多打谁，交给目标估值处理
  return false
}
