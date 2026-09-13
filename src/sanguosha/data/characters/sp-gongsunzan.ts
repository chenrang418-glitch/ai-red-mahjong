import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 公孙瓒（三国杀 OL 经典身份 SP）。
 *
 * 【义从】：锁定技，公孙瓒计算与其他角色的距离-1；若他当前体力值≤2，
 *          则其他角色计算与他的距离+1（动态判定，不缓存，体力回升立即失效）。
 */

const YICONG = 'yicong'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YICONG,
  distanceModifier: {
    toOthers: -1,
    fromOthers: (state, ownerId) => ((playerOf(state, ownerId)?.hp ?? 99) <= 2 ? 1 : 0),
  },
})

export const GONGSUNZAN: CharacterDefinition = {
  id: 'gongsunzan',
  name: '公孙瓒',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: YICONG, name: '义从', description: '锁定技，你计算与其他角色的距离-1；当你的体力值≤2时，其他角色计算与你的距离+1。' },
  ],
}
