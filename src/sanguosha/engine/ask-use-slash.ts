import { responseViewAsOptions, skillIdsOf } from '../data/characters/standard'
import { canTarget } from './distance'
import { isTargetProhibited } from './skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from './types'

/**
 * 「令某名角色对某人使用一张【杀】」的公共入口。
 *
 * 姜维【挑衅】是第一个用户；以后的「你需对我使用一张杀，否则……」一类技能
 * 一律复用这里。
 *
 * 三条纪律：
 *
 * 1. **必须是真正的「使用」**，不是「打出」。所以最终要走
 *    `SkillHost.beginVirtualSlash`，完整经过指定目标、求闪、伤害、
 *    享乐、无双、铁骑、烈弓这一整条 SlashResolution，而不是直接结算伤害。
 * 2. **不能只看手上有没有实体【杀】。** 武圣、龙胆、蛊惑这些转化技同样
 *    产得出【杀】，漏掉它们等于对这些武将单方面放宽了规则。
 *    这里和求闪、决斗共用同一份 `responseViewAsOptions`。
 * 3. **目标是固定的。** 调用方指定谁挨这一刀，玩家不能拿这个机会去杀别人；
 *    服务端在生成候选和落地前都要按这个固定目标校验。
 */

/**
 * `userId` 现在能拿哪些牌对 `targetId` 使用【杀】。
 *
 * 返回的是**实体牌 id**：既有真【杀】，也有能转化成【杀】的牌，
 * 两者在后续流程里一视同仁（转化由 `beginVirtualSlash` 的 `cardId` 承载）。
 * 空数组表示他现在使不出【杀】。
 */
export function slashUseOptions(state: SanguoshaState, userId: PlayerId, targetId: PlayerId): CardId[] {
  const user = state.players.find((candidate) => candidate.id === userId)
  const target = state.players.find((candidate) => candidate.id === targetId)
  if (!user?.alive || !target?.alive || userId === targetId) return []
  // 帷幕这类「不能成为目标」在这里就要挡掉，不能等到杀已经开始才发现没有合法目标
  if (isTargetProhibited(state, userId, targetId, '杀', skillIdsOf)) return []

  const options = new Set(user.zones.hand.filter((cardId) => state.cards[cardId]?.name === '杀'))
  for (const option of responseViewAsOptions(state, userId, '杀')) options.add(option.cardId)
  return [...options]
}

/** 他现在使得出【杀】吗。没有就不该发一个只能拒绝的请求。 */
export function canUseSlashAt(state: SanguoshaState, userId: PlayerId, targetId: PlayerId): boolean {
  return slashUseOptions(state, userId, targetId).length > 0
}

/**
 * `candidateId` 的**攻击范围里有没有** `targetId`。
 *
 * 注意方向：问的是「他能不能砍到我」，不是「我能不能砍到他」。
 * 姜维【挑衅】选的是前者，写反就变成了完全不同的技能。
 * 武器、+1/-1 马、马术、屯田的距离修正全部由 `canTarget` 统一算，
 * 技能不自己读座位距离。
 */
export function attackRangeCovers(state: SanguoshaState, candidateId: PlayerId, targetId: PlayerId): boolean {
  const candidate = state.players.find((player) => player.id === candidateId)
  if (!candidate?.alive || candidateId === targetId) return false
  return canTarget(state, candidateId, targetId)
}
