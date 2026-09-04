import { replaceTemporarySkill } from './skills/runtime'
import { clearSkillSuppressionsOf, expireSkillSuppressions } from './skill-suppression'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 夺锐的到期收尾。
 *
 * 「技能失效」和「神张辽临时获得该技能」是**一对**，必须同时结束——
 * 只解除其中一半会出现「对方拿回来了，神张辽也还留着」的双份技能。
 *
 * 放在独立文件里是为了避开 import 环：`turn.ts` 要调它，
 * 它又要调 `skills/runtime` 的临时技能授予。
 */

/** 临时技能的来源标记，和施加压制时用的 sourceSkillId 一致。 */
const DUORUI_GRANT_SOURCE = 'duorui'

function releaseGrant(state: SanguoshaState, sourceId: PlayerId): void {
  replaceTemporarySkill(state, sourceId, DUORUI_GRANT_SOURCE, null)
}

/** 回合结束时的到期检查。 */
export function expireStolenSkills(state: SanguoshaState, endingTurnPlayerId: PlayerId, turnNumber: number): void {
  for (const entry of expireSkillSuppressions(state, endingTurnPlayerId, turnNumber)) {
    releaseGrant(state, entry.sourceId)
  }
}

/** 角色死亡时的清理：目标死了要提前结束，施加者死了同样收掉。 */
export function releaseStolenSkillsOf(state: SanguoshaState, playerId: PlayerId): void {
  for (const entry of clearSkillSuppressionsOf(state, playerId)) {
    releaseGrant(state, entry.sourceId)
  }
}
