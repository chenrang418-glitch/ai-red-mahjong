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
  // 主公打谁，谁就更像反贼——主公的身份是公开的，他的攻击是最可信的信号
  if (sourceId === lord) {
    suspicion[targetId] = (suspicion[targetId] ?? 0) + 2
    return
  }
  // 打了一个已经很像反贼的人，说明自己更可能是主忠
  if ((suspicion[targetId] ?? 0) > 0) suspicion[sourceId] = (suspicion[sourceId] ?? 0) - 1
  // 反过来：被一个很像反贼的人打，说明自己更可能是主忠
  if ((suspicion[sourceId] ?? 0) > 0) suspicion[targetId] = (suspicion[targetId] ?? 0) - 1
}

/** 观察一次回复：给主公回血的人更像忠臣。 */
export function observeRecover(suspicion: SuspicionMap, view: PlayerView, sourceId: PlayerId | null, targetId: PlayerId): void {
  if (!sourceId || sourceId === targetId) return
  const lord = lordOf(view)
  if (targetId === lord) suspicion[sourceId] = (suspicion[sourceId] ?? 0) - 2
}

/**
 * 把一条引擎事件喂给身份推断。
 *
 * **必须真的挂上去。**在此之前 `observeDamage` / `observeRecover` 谁都没有调用，
 * suspicion 永远是全零，整套推断等于没跑——AI 只会按已公开的身份行动。
 *
 * 这里只读公开事件（谁打了谁、谁给谁回血），所以一份 suspicion 可以给所有 AI 共用：
 * 它表达的是「从旁观角度看，这个人有多像反贼」，不含任何隐藏信息。
 */
export function observeEvent(
  suspicion: SuspicionMap,
  view: PlayerView,
  event: { name: string; sourceId?: PlayerId; targetId?: PlayerId; payload: Record<string, unknown> },
): void {
  if (event.name === 'Damaged') {
    if (event.targetId) observeDamage(suspicion, view, event.sourceId ?? null, event.targetId)
    return
  }
  if (event.name === 'Recover') {
    const targetId = (event.payload.playerId as PlayerId | undefined) ?? event.targetId
    if (targetId) observeRecover(suspicion, view, event.sourceId ?? null, targetId)
  }
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

/** 敌意打分低于这个值就绝不选为目标（自己人、主公）。 */
export const PROTECTED = -50

/**
 * 对某个目标的敌意：正数想打，负数想保护。
 *
 * 之前只有 `isLikelyEnemy` 这个布尔判断，导致两个问题，压测里反贼胜率高到离谱：
 * 1. 开局所有 suspicion 都是 0，**忠臣眼里没有任何敌人**，只能按血量乱打，
 *    经常反过来打主公；而反贼因为主公身份公开，第一回合就能协同集火。
 * 2. 没有任何「保护」的表达，谁都可能被选成目标。
 *
 * 这里只用 PlayerView 看得到的信息：我自己的身份、已公开的身份、行为推断出的 suspicion。
 * **不读别人的隐藏身份**——那在 PlayerView 里本来就是 null。
 */
export function hostility(view: PlayerView, suspicion: SuspicionMap, targetId: PlayerId): number {
  if (targetId === view.viewerId) return PROTECTED
  const me = view.players.find((player) => player.id === view.viewerId)
  const target = view.players.find((player) => player.id === targetId)
  if (!me || !target?.alive) return PROTECTED

  const lord = lordOf(view)
  const score = suspicion[targetId] ?? 0
  const aliveCount = view.players.filter((player) => player.alive).length

  switch (me.identity) {
    case 'lord':
      if (target.identity === 'loyalist') return PROTECTED
      if (target.identity === 'rebel' || target.identity === 'renegade') return 14
      // 未知身份：只靠行为推断，别乱杀自己人
      return score * 3

    case 'loyalist':
      if (targetId === lord) return PROTECTED
      if (target.identity === 'rebel' || target.identity === 'renegade') return 14
      // 未知的人里反贼占多数（5 人局 2/3，8 人局 4/6），所以给一个温和的正向先验，
      // 否则忠臣开局完全没有目标，只会按血量乱打
      return 4 + score * 3

    case 'rebel':
      // 杀死主公直接获胜，永远是首选
      if (targetId === lord) return 20
      if (target.identity === 'loyalist') return 10
      return 2 - score * 3

    case 'renegade': {
      // 内奸要留主公到最后单挑，人少了才动手
      if (targetId === lord) return aliveCount <= 2 ? 20 : PROTECTED
      const lordPlayer = view.players.find((player) => player.id === lord)
      // 主公快撑不住时反过来打反贼：内奸要的是最后单挑，不是让反贼提前赢
      if (lordPlayer && lordPlayer.alive && lordPlayer.hp <= 2) return score > 0 ? 14 : -2
      return 8
    }

    default:
      return 0
  }
}
