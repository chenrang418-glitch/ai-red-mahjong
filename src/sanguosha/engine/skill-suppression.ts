import { isLockedSkill } from './locked-skills'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 「某名角色的某个技能暂时失效」的公共机制。
 *
 * 神张辽【夺锐】要的：令目标武将牌上的一个技能于其下回合结束之前无效。
 *
 * **和蔡文姬【断肠】不是一回事，不能共用一个布尔。**
 *
 * - 断肠：永久、对方**所有**武将技能、没有来源概念 → `player.characterSkillsDisabled`。
 * - 夺锐：临时、**单个**技能、绑定施加者、到期自动解除。
 *
 * 两者在 `ownedSkillIds` 里汇总，各自独立：
 * 被断肠的人技能全没了，被夺锐的人只少那一个。
 */

export interface SkillSuppression {
  /** 谁的技能失效了。 */
  targetId: PlayerId
  /** 单技能压制（夺锐）压的是哪一个；范围压制不写这个字段。 */
  skillId?: string
  /**
   * 压制范围。
   *
   * - `'skill'`（默认）：只压 `skillId` 这一个。
   * - `'non-locked'`：压目标的**全部非锁定技**（神马超【霆威】）。
   *
   * 范围压制不能退化成「把当前技能 id 列一遍」：那样期间新获得的非锁定技
   * 会漏网，而这恰恰是这条规则最要紧的一半。所以存的是范围，
   * 每次查询时现算。
   */
  scope?: 'skill' | 'non-locked'
  /** 谁让它失效的。到期和清理都按这个来源走。 */
  sourceId: PlayerId
  /** 施加它的技能，用于战报和调试。 */
  sourceSkillId: string
  /**
   * 施加时的回合序号。
   *
   * 期限是「目标的**下一个实际回合**结束」，所以判据是
   * 「正在结束的回合属于目标，且不是施加它的那个回合」——
   * 目标先拿到一个额外回合的话，那个额外回合结束就到期，
   * 不是固定 round+1，也不是只认正常回合。
   */
  armedAtTurn: number
}

/** 这个技能此刻是不是被压制了。单技能压制和范围压制在这里统一聚合。 */
export function isSkillSuppressed(state: SanguoshaState, targetId: PlayerId, skillId: string): boolean {
  return (state.skillSuppressions ?? []).some((entry) => {
    if (entry.targetId !== targetId) return false
    if (entry.scope === 'non-locked') return !isLockedSkill(skillId)
    return entry.skillId === skillId
  })
}

/**
 * 这名角色现在有哪些**具名**技能被压制。
 *
 * 范围压制列不进来——它压的是一个条件，不是一份名单。要判断某个技能
 * 现在有没有失效，走 `isSkillSuppressed`。
 */
export function suppressedSkillsOf(state: SanguoshaState, targetId: PlayerId): string[] {
  return (state.skillSuppressions ?? [])
    .filter((entry) => entry.targetId === targetId && entry.scope !== 'non-locked')
    .map((entry) => entry.skillId)
    .filter((skillId): skillId is string => !!skillId)
}

/** 某个来源当前压制着的那一条（夺锐同时最多一条）。 */
export function suppressionBySource(state: SanguoshaState, sourceId: PlayerId, sourceSkillId: string): SkillSuppression | null {
  return (state.skillSuppressions ?? []).find((entry) => (
    entry.sourceId === sourceId && entry.sourceSkillId === sourceSkillId
  )) ?? null
}

export function suppressSkill(state: SanguoshaState, entry: SkillSuppression): void {
  state.skillSuppressions ??= []
  if (entry.scope === 'non-locked') {
    // 同一个来源对同一个人只压一次；重复施加只该刷新期限，不该堆叠两条
    const existing = state.skillSuppressions.find((candidate) => candidate.targetId === entry.targetId
      && candidate.scope === 'non-locked'
      && candidate.sourceId === entry.sourceId
      && candidate.sourceSkillId === entry.sourceSkillId)
    if (existing) {
      existing.armedAtTurn = entry.armedAtTurn
      return
    }
    state.skillSuppressions.push(entry)
    return
  }
  if (!entry.skillId || isSkillSuppressed(state, entry.targetId, entry.skillId)) return
  state.skillSuppressions.push(entry)
}

/**
 * 回合结束时到期检查。返回被解除的条目，调用方据此收尾
 * （夺锐要同时收回神张辽临时获得的那个技能）。
 *
 * 由 `turn.ts` 在 `TurnEnd` 之后调一次，技能不各自注册清理。
 */
export function expireSkillSuppressions(
  state: SanguoshaState,
  endingTurnPlayerId: PlayerId,
  turnNumber: number,
): SkillSuppression[] {
  const all = state.skillSuppressions ?? []
  const expired = all.filter((entry) => (
    entry.targetId === endingTurnPlayerId && turnNumber > entry.armedAtTurn
  ))
  if (expired.length > 0) {
    state.skillSuppressions = all.filter((entry) => !expired.includes(entry))
  }
  return expired
}

/**
 * 角色死亡时的清理：他身上的压制、以及**由他施加**的压制都收掉。
 * 返回被解除的条目，调用方据此收尾。
 */
export function clearSkillSuppressionsOf(state: SanguoshaState, playerId: PlayerId): SkillSuppression[] {
  const all = state.skillSuppressions ?? []
  const removed = all.filter((entry) => entry.targetId === playerId || entry.sourceId === playerId)
  if (removed.length > 0) {
    state.skillSuppressions = all.filter((entry) => !removed.includes(entry))
  }
  return removed
}
