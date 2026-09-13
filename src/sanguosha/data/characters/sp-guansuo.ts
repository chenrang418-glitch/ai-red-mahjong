import { drawCards } from '../../engine/draw'
import { effectiveGenderOf } from '../../engine/huashen'
import { grantSkill, ownedSkillIds, registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 关索（三国杀 OL 经典身份 SP）。
 *
 * 【征南】：其他角色真正死亡后，关索可以摸3张牌，然后从【武圣】【当先】
 *          【制蛮】中尚未拥有的技能里选择永久获得1个（三个都已拥有则只摸牌）。
 * 【撷芳】：锁定技，关索计算与其他角色的距离-X，X为当前存活女性角色数量。
 */

const ZHENGNAN = 'zhengnan'
const XIEFANG = 'xiefang'
/**
 * 【制蛮】：马谡 OL 版技能，本项目此前未收录（已有的一将成名2011版马谡是
 * 心战/挥泪，是另一个版本）。官方文本未在本次改动范围内核实，暂以马超
 * 【马术】同款「距离-1」锁定技实现（南征蛮地、地形压制的简化版），
 * 如需精确文本请核对后调整——见批次报告"未解决"。
 */
const ZHIMAN = 'zhiman'

const GRANT_MENU: Array<{ id: string; name: string }> = [
  { id: 'wusheng', name: '武圣' },
  { id: 'dangxian', name: '当先' },
  { id: ZHIMAN, name: '制蛮' },
]

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function livingFemaleCount(state: SanguoshaState): number {
  return state.players.filter((candidate) => candidate.alive && effectiveGenderOf(state, candidate.id) === 'female').length
}

registerSkillRuntime({
  id: ZHENGNAN,
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // Death 触发时可能正处在死亡结算链中间，askSkill 直接问会撞上
      // 「已有技能正在等待回应」，走 queueSkill 延后到安全点。
      host.queueSkill({ skillId: ZHENGNAN, ownerId, step: 'draw', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', { skillId: ZHENGNAN, skillName: '征南', playerId: ownerId, logText: `${owner.nickname}发动【征南】，摸3张牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 3, (name, drawPayload) => { host.dispatch(name, drawPayload) })

    const owned = new Set(ownedSkillIds(host.state, ownerId))
    const candidates = GRANT_MENU.filter((entry) => !owned.has(entry.id))
    if (candidates.length === 0) return
    host.askSkill({
      skillId: ZHENGNAN, ownerId, step: 'choose', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【征南】：选择获得一个尚未拥有的技能', timeoutMs: 20_000, optional: false,
        options: candidates.map((entry) => ({ id: entry.id, label: `获得【${entry.name}】` })),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    const picked = GRANT_MENU.find((entry) => entry.id === optionId)
    if (!picked || ownedSkillIds(host.state, ownerId).includes(picked.id)) return
    grantSkill(host.state, ownerId, picked.id)
    host.dispatch('SkillActivated', { skillId: ZHENGNAN, skillName: '征南', playerId: ownerId, logText: `${owner.nickname}通过【征南】永久获得【${picked.name}】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: XIEFANG,
  distanceModifier: {
    toOthers: (state) => -livingFemaleCount(state),
  },
})

registerSkillRuntime({
  id: ZHIMAN,
  distanceModifier: { toOthers: -1 },
})

export const GUANSUO: CharacterDefinition = {
  id: 'guansuo',
  name: '关索',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: ZHENGNAN, name: '征南', description: '其他角色真正死亡后，你可以摸3张牌，然后从【武圣】【当先】【制蛮】中选择一个尚未拥有的技能永久获得。' },
    { id: XIEFANG, name: '撷芳', description: '锁定技，你计算与其他角色的距离-X，X为当前存活的女性角色数量。' },
  ],
}
