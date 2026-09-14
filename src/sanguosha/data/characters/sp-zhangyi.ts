import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime, replaceTemporarySkills } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张翼（三国杀 OL 经典身份 SP）。
 *
 * 【殿军】：锁定技，你回合结束时，你受到1点伤害，然后（若你仍然存活）
 *          获得一个额外的出牌阶段。
 * 【亢锐】：每名角色于其自己回合内第一次受到伤害后，你可以摸1张牌，然后
 *          选择一项：令其回复1点体力；或令其本回合下一次造成的伤害+1。
 *          此后其本回合首次造成伤害时，其本回合手牌上限视为0。
 */

const DIANJUN = 'dianjun'
const KANGRUI = 'kangrui'
const KANGRUI_LOCK = 'kangrui-lock'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DIANJUN,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks['dianjun-used-turn'] === host.state.turnNumber) return
      owner.marks['dianjun-used-turn'] = host.state.turnNumber
      host.dispatch('SkillActivated', { skillId: DIANJUN, skillName: '殿军', playerId: ownerId, logText: `${owner.nickname}发动【殿军】` }, { sourceId: ownerId })
      resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'normal', cardName: null })
      if (!playerOf(host.state, ownerId)?.alive) return
      host.state.extraPhase = {
        phase: 'play', resumeSlot: 'finish', playerId: ownerId,
        skillId: DIANJUN, instanceId: host.state.seq, preSkipped: host.state.skippedPhases.includes('play'),
      }
    },
  }],
})

registerSkillRuntime({
  id: KANGRUI,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const targetId = context.event.targetId
        if (!targetId || targetId !== host.state.currentPlayerId) return
        const target = playerOf(host.state, targetId)
        if (!target?.alive || target.marks['kangrui-first-turn'] === host.state.turnNumber) return
        target.marks['kangrui-first-turn'] = host.state.turnNumber
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: KANGRUI, ownerId, step: 'ask-draw', data: { targetId } })
      },
    },
    {
      event: 'BeforeDamage',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId) return
        const source = playerOf(host.state, sourceId)
        if (!source?.alive || source.marks['kangrui-armed-turn'] !== host.state.turnNumber) return
        if (source.marks['kangrui-dealt-turn'] === host.state.turnNumber) return
        source.marks['kangrui-dealt-turn'] = host.state.turnNumber
        if (source.marks['kangrui-bonus-turn'] === host.state.turnNumber && source.marks['kangrui-bonus']) {
          const payload = context.event.payload as { amount?: number }
          payload.amount = (typeof payload.amount === 'number' ? payload.amount : 0) + 1
          delete source.marks['kangrui-bonus']
        }
        source.marks['kangrui-maxcards-turn'] = host.state.turnNumber
        replaceTemporarySkills(host.state, sourceId, KANGRUI, [KANGRUI_LOCK])
        void ownerId
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-draw') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: KANGRUI, ownerId, step: 'ask-draw', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【亢锐】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-draw') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', { skillId: KANGRUI, skillName: '亢锐', playerId: ownerId, targetId, logText: `${owner.nickname}发动【亢锐】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: KANGRUI, ownerId, step: 'choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【亢锐】：选择一项', timeoutMs: 20_000, optional: false,
          options: [{ id: 'recover', label: '令其回复1点体力' }, { id: 'bonus', label: '令其本回合下一次造成的伤害+1' }],
        }),
      })
      return
    }
    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'recover' && target.hp < target.maxHp) recover(host as never, targetId, 1, ownerId)
      else if (choice === 'bonus') {
        target.marks['kangrui-bonus-turn'] = host.state.turnNumber
        target.marks['kangrui-bonus'] = 1
      }
      target.marks['kangrui-armed-turn'] = host.state.turnNumber
    }
  },
})

registerSkillRuntime({
  id: KANGRUI_LOCK,
  fixedMaxCards(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.marks['kangrui-maxcards-turn'] === state.turnNumber ? 0 : null
  },
})

export const ZHANGYI: CharacterDefinition = {
  id: 'zhangyi',
  name: '张翼',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: DIANJUN, name: '殿军', description: '锁定技，你回合结束时，你受到1点伤害，然后（若你仍然存活）获得一个额外的出牌阶段。' },
    { id: KANGRUI, name: '亢锐', description: '每名角色于其自己回合内第一次受到伤害后，你可以摸1张牌，然后选择一项：令其回复1点体力；或令其本回合下一次造成的伤害+1。此后其本回合首次造成伤害时，其本回合手牌上限视为0。' },
  ],
}
