import { extraSlashTargetsOf, globalSlashUsesOf, ignoresSlashUsesTo } from './skills/runtime'
import type { DamageNature, PlayerId, SanguoshaState } from './types'

/**
 * 回合内临时的【杀】规则修正。
 *
 * 技能要改「这一回合的杀怎么用」时走这里，**不要**在 `basic.ts` 的杀主干里写
 * `if (characterId === 'taishici')`，也不要各自往 state 上挂一个私有布尔量。
 *
 * 存在 `player.marks` 里（本来就是个可序列化的数字表），所以：
 * - 断线重连之后本回合的效果仍在；
 * - `turn.ts` 在回合结束时统一清掉，技能不需要各自注册清理——散着写漏一个
 *   就会变成永久效果，【青囊】当年就是这么坏的。
 *
 * 目前只需要表达经典【天义】要的四件事。真有新需求再加字段，不预先设计。
 */

/** +N 次出杀机会。 */
const EXTRA_USES = 'slash-extra-uses'
/** 每张杀可以多指定 N 个目标。 */
const EXTRA_TARGETS = 'slash-extra-targets'
/** 这一回合的杀无距离限制。 */
const IGNORE_DISTANCE = 'slash-ignore-distance'
/** 这一回合不能使用杀。 */
const PROHIBITED = 'slash-prohibited'

/** 回合结束时要抹掉的临时标记，由 `turn.ts` 统一清理。 */
export const TURN_SLASH_MARKS = [EXTRA_USES, EXTRA_TARGETS, IGNORE_DISTANCE, PROHIBITED] as const

export interface SlashRules {
  /** 额外的出杀次数。 */
  extraUses: number
  /** 每张杀额外可指定的目标数。 */
  extraTargets: number
  ignoreDistance: boolean
  /** 本回合完全不能使用杀。 */
  prohibited: boolean
}

function markOf(state: SanguoshaState, playerId: PlayerId, key: string): number {
  return state.players.find((candidate) => candidate.id === playerId)?.marks[key] ?? 0
}

export function slashRules(state: SanguoshaState, playerId: PlayerId): SlashRules {
  return {
    extraUses: markOf(state, playerId, EXTRA_USES),
    extraTargets: markOf(state, playerId, EXTRA_TARGETS),
    ignoreDistance: markOf(state, playerId, IGNORE_DISTANCE) > 0,
    prohibited: markOf(state, playerId, PROHIBITED) > 0,
  }
}

/**
 * 这一回合还能不能再使用【杀】。
 *
 * `unlimited` 由调用方给（诸葛连弩、张飞【咆哮】那类）。**已经无限时再加次数
 * 不会把它变回有限**——聚合规则是「无限优先」，两个 modifier 不会互相盖掉。
 */
/**
 * 本**回合**内使用【杀】的次数。
 *
 * 和 `state.turnUsage.slashUses` 的区别：后者按出牌阶段实例算，
 * 进入每个出牌阶段时归零（廖化【当先】的两个出牌阶段各有一次）。
 * 「本回合是否使用过【杀】」这类判据必须读这一个，
 * 否则第二个出牌阶段一开始就把前面那张【杀】忘了。
 *
 * 旧存档里没有这个字段，退回按阶段那本账——那时一个回合只有一个出牌阶段，
 * 两者本来就相等。
 */
export function slashUsesThisTurn(state: SanguoshaState): number {
  return state.turnUsage.slashUsesThisTurn ?? state.turnUsage.slashUses
}

export function canUseSlash(state: SanguoshaState, playerId: PlayerId, unlimited: boolean): boolean {
  const rules = slashRules(state, playerId)
  if (rules.prohibited) return false
  if (unlimited) return true
  // 全场效果给的次数加成（神甘宁的「营」）和本回合的临时加成一起算
  return state.turnUsage.slashUses < 1 + rules.extraUses + globalSlashUsesOf(state, playerId)
}

/**
 * 对这一组目标使用【杀】现在合不合次数规则。
 *
 * 定向的次数豁免（高顺【陷阵】胜利后）只有在**每个目标都被豁免**时才成立。
 * 写成「任一目标被豁免就放行」的话，捎带一个普通目标就能无限出杀。
 *
 * 「本回合不能使用杀」（陷阵失败）优先于一切豁免。
 */
export function canUseSlashAtTargets(
  state: SanguoshaState,
  playerId: PlayerId,
  unlimited: boolean,
  targetIds: readonly PlayerId[],
): boolean {
  if (slashRules(state, playerId).prohibited) return false
  if (canUseSlash(state, playerId, unlimited)) return true
  if (targetIds.length === 0) return false
  return targetIds.every((targetId) => ignoresSlashUsesTo(state, playerId, targetId))
}

/** 场上现在有没有「对他出杀不计次数」的目标。用于决定要不要继续生成动作。 */
export function hasSlashUsesBypass(state: SanguoshaState, playerId: PlayerId): boolean {
  return state.players.some((candidate) => candidate.alive
    && candidate.id !== playerId
    && ignoresSlashUsesTo(state, playerId, candidate.id))
}

/** 一张杀最多能指定几个目标。 */
/**
 * 这一张【杀】最多能指定几个目标。
 *
 * `nature` 是这张【杀】**最终的**属性：程普【疠火】的「使用火【杀】时可以多
 * 选择一个目标」按属性给，本来就是火【杀】的也算，所以这个参数必须一路
 * 传到动作生成那一层——写成「程普出杀就多一个目标」是错的。
 */
export function slashTargetLimit(
  state: SanguoshaState,
  playerId: PlayerId,
  nature: DamageNature = 'normal',
): number {
  return 1 + slashRules(state, playerId).extraTargets + extraSlashTargetsOf(state, playerId, nature)
}

function addMark(state: SanguoshaState, playerId: PlayerId, key: string, amount: number): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  const next = (player.marks[key] ?? 0) + amount
  if (next > 0) player.marks[key] = next
  else delete player.marks[key]
}

/** 本回合多一次出杀机会、多指定 N 个目标、并且无距离限制（【天义】成功）。 */
export function grantTurnSlashBonus(
  state: SanguoshaState,
  playerId: PlayerId,
  bonus: { extraUses?: number; extraTargets?: number; ignoreDistance?: boolean },
): void {
  if (bonus.extraUses) addMark(state, playerId, EXTRA_USES, bonus.extraUses)
  if (bonus.extraTargets) addMark(state, playerId, EXTRA_TARGETS, bonus.extraTargets)
  if (bonus.ignoreDistance) addMark(state, playerId, IGNORE_DISTANCE, 1)
}

/**
 * 撤销之前加过的本回合出杀加成。
 *
 * 「下一张牌不限次数」这类效果用掉之后要收回来（神孙权【圣质】）——
 * 只加不撤的话，一次武装会让他整个回合都不限次。
 */
export function revokeTurnSlashBonus(
  state: SanguoshaState,
  playerId: PlayerId,
  bonus: { extraUses?: number; extraTargets?: number; ignoreDistance?: boolean },
): void {
  if (bonus.extraUses) addMark(state, playerId, EXTRA_USES, -bonus.extraUses)
  if (bonus.extraTargets) addMark(state, playerId, EXTRA_TARGETS, -bonus.extraTargets)
  if (bonus.ignoreDistance) addMark(state, playerId, IGNORE_DISTANCE, -1)
}

/** 本回合不能使用杀（【天义】失败）。 */
export function prohibitSlashThisTurn(state: SanguoshaState, playerId: PlayerId): void {
  addMark(state, playerId, PROHIBITED, 1)
}

/** 回合结束时抹掉本回合的全部临时杀规则。 */
export function clearTurnSlashRules(state: SanguoshaState): void {
  for (const player of state.players) {
    for (const key of TURN_SLASH_MARKS) delete player.marks[key]
  }
}
