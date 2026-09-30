import { getDistance } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 麹义（三国杀 OL 经典身份 SP）。
 *
 * 【伏骑】：锁定技，与麹义距离为1的其他角色不能响应麹义使用的牌；
 *          目标响应、锦囊无懈及决斗等牌效响应均按使用者和响应者统一拦截。
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
  blocksResponseToCard(state, ownerId, responderId) {
    return ownerId !== responderId && getDistance(state, ownerId, responderId) === 1
  },
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
    { id: FUQI, name: '伏骑', description: '锁定技，与麹义距离为1的其他角色不能使用或打出牌响应麹义使用的牌。' },
    { id: JIAOZI, name: '骄恣', description: '锁定技，若麹义的手牌数在全场唯一最多，其造成和受到的伤害都+1。' },
  ],
}
