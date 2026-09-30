import { gainMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { drawCards } from '../../engine/draw'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 诸葛诞（三国杀 OL 经典身份 SP）。
 *
 * 【功獒】：锁定技，一名其他角色真正死亡后，诸葛诞体力上限+1，然后回复
 *          1点体力。
 * 【举义】：觉醒技，准备阶段，若诸葛诞已受伤且体力上限大于当前存活角色
 *          数量，摸牌至体力上限，然后获得【崩坏】和【威重】。
 * 【崩坏】：直接复用董卓的锁定技实现（`forest-dongzhuo.ts` 里已注册的
 *          技能 id `benghuai`），不重新实现。
 * 【威重】：锁定技，诸葛诞体力上限发生变化后摸一张牌——因为这个技能是
 *          举义觉醒后才通过 `grantSkill` 动态获得的，觉醒前的体力上限
 *          变化（功獒）天然不会触发它，不需要额外的时间戳回溯判断。
 */

const GONGAO = 'gongao'
const JUYI = 'juyi'
const WEIZHONG = 'weizhong'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: GONGAO,
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      const deadId = context.event.targetId
      if (!deadId || deadId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.dispatch('SkillActivated', { skillId: GONGAO, skillName: '功獒', playerId: ownerId, logText: `${owner.nickname}发动【功獒】` }, { sourceId: ownerId })
      gainMaxHp(host as never, ownerId, 1, GONGAO)
      recover(host as never, ownerId, 1, ownerId)
    },
  }],
})

registerSkillRuntime({
  id: JUYI,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      if (!owner?.alive || owner.hp >= owner.maxHp) return false
      const aliveCount = state.players.filter((candidate) => candidate.alive).length
      return owner.maxHp > aliveCount
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const need = Math.max(0, owner.maxHp - owner.zones.hand.length)
      if (need > 0) drawCards(host.state, host.rng, ownerId, need, (name, payload) => { host.dispatch(name, payload) })
      grantSkill(host.state, ownerId, 'benghuai')
      grantSkill(host.state, ownerId, WEIZHONG)
      host.dispatch('SkillActivated', { skillId: JUYI, skillName: '举义', playerId: ownerId, logText: `${owner.nickname}发动【举义】，觉醒` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: WEIZHONG,
  triggers: [{
    event: 'MaxHpChange',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: WEIZHONG, skillName: '威重', playerId: ownerId, logText: `${owner.nickname}发动【威重】，摸牌` }, { sourceId: ownerId })
    },
  }],
})

export const ZHUGE_DAN: CharacterDefinition = {
  id: 'zhugedan',
  name: '诸葛诞',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: GONGAO, name: '功獒', description: '锁定技，一名其他角色真正死亡后，诸葛诞体力上限+1，然后回复1点体力。' },
    { id: JUYI, name: '举义', description: '觉醒技，准备阶段，若诸葛诞已受伤且体力上限大于当前存活角色数量，摸牌至体力上限，然后获得【崩坏】和【威重】。' },
    { id: WEIZHONG, name: '威重', description: '锁定技，诸葛诞体力上限发生变化后，摸一张牌（觉醒后获得）。', granted: true },
  ],
}
