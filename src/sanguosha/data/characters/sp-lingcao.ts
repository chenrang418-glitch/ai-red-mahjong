import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 凌操（三国杀 OL 经典身份 SP）。
 *
 * 【独进】：摸牌阶段，凌操可以额外摸 X+1 张牌（X = ceil(装备数/2)）——
 *          接管整个摸牌阶段事件（取消引擎默认的摸2张，由技能自己补上
 *          基础的2张和奖励），保留“是否发动”的选择。
 */

const DUJIN = 'dujin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function equipCount(state: SanguoshaState, playerId: PlayerId): number {
  const owner = playerOf(state, playerId)
  return owner ? Object.values(owner.zones.equipment).filter(Boolean).length : 0
}

registerSkillRuntime({
  id: DUJIN,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      context.cancel()
      host.queueSkill({ skillId: DUJIN, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    const bonus = Math.ceil(equipCount(host.state, ownerId) / 2) + 1
    host.askSkill({
      skillId: DUJIN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【独进】：是否额外摸${bonus}张牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: `发动（额外摸${bonus}张）` }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const activate = (response.payload as { optionId?: string }).optionId === 'yes'
    const bonus = activate ? Math.ceil(equipCount(host.state, ownerId) / 2) + 1 : 0
    if (activate) host.dispatch('SkillActivated', { skillId: DUJIN, skillName: '独进', playerId: ownerId, logText: `${owner.nickname}发动【独进】，额外摸${bonus}张牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 2 + bonus, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const LINGCAO: CharacterDefinition = {
  id: 'lingcao',
  name: '凌操',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: DUJIN, name: '独进', description: '摸牌阶段，凌操可以额外摸X+1张牌，X为装备数除以2向上取整。' },
  ],
}
