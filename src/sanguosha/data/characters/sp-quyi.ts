import { getDistance } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 麹义（三国杀 OL 经典身份 SP）。
 *
 * 【伏骑】：锁定技，与麹义距离为1的其他角色，不能响应麹义使用的牌。
 *          目前通过 `slashUndodgeable`（杀不可闪）与 `trickUnresponsive`
 *          （锦囊目标完全不能响应）两个既有的“使用者方向”钩子实现；
 *          引擎目前没有面向旁观者的无懈可击/决斗响应封锁通用钩子，
 *          这两类间接响应不在本次实现范围内。
 * 【骄恣】：锁定技，若麹义当前手牌数是全场唯一最多，其造成和受到的伤害
 *          各+1（每次伤害结算时动态判断，不缓存）。
 */

const FUQI = 'fuqi'
const JIAOZI = 'jiaozi'

function isUniqueHandMax(state: SanguoshaState, ownerId: PlayerId): boolean {
  const alive = state.players.filter((candidate) => candidate.alive)
  const owner = alive.find((candidate) => candidate.id === ownerId)
  if (!owner) return false
  const max = Math.max(...alive.map((candidate) => candidate.zones.hand.length))
  if (owner.zones.hand.length !== max) return false
  return alive.filter((candidate) => candidate.zones.hand.length === max).length === 1
}

registerSkillRuntime({
  id: FUQI,
  slashUndodgeable(state, ownerId, targetId) {
    return getDistance(state, ownerId, targetId) === 1
  },
  trickUnresponsive(state, ownerId, targetId) {
    return getDistance(state, ownerId, targetId) === 1
  },
})

registerSkillRuntime({
  id: JIAOZI,
  outgoingDamage(state, ownerId, context) {
    if (!isUniqueHandMax(state, ownerId)) return null
    return { amount: context.amount + 1 }
  },
  incomingDamage(state, ownerId, context) {
    if (!isUniqueHandMax(state, ownerId)) return null
    return { amount: context.amount + 1 }
  },
})

export const QUYI: CharacterDefinition = {
  id: 'quyi',
  name: '麹义',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: FUQI, name: '伏骑', description: '锁定技，与麹义距离为1的其他角色，不能响应麹义使用的杀（不可闪）和锦囊牌（目标不可响应）。' },
    { id: JIAOZI, name: '骄恣', description: '锁定技，若麹义的手牌数在全场唯一最多，其造成和受到的伤害都+1。' },
  ],
}
