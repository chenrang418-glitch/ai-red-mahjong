import type { PlayerId, SanguoshaState } from './types'

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
export function canUseSlash(state: SanguoshaState, playerId: PlayerId, unlimited: boolean): boolean {
  const rules = slashRules(state, playerId)
  if (rules.prohibited) return false
  if (unlimited) return true
  return state.turnUsage.slashUses < 1 + rules.extraUses
}

/** 一张杀最多能指定几个目标。 */
export function slashTargetLimit(state: SanguoshaState, playerId: PlayerId): number {
  return 1 + slashRules(state, playerId).extraTargets
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
