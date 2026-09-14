import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { restoreCharacter } from '../../engine/character-state'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 环淑君（三国杀 OL 经典身份 SP）。
 *
 * 【环佩】：每轮限一次，你的出牌阶段可以发动：将手牌调整至体力值上限
 *          （摸/弃差额），然后视为使用一张【杀】。
 * 【温宜】：全局限一次（妙心可恢复次数），一名角色本回合内体力值首次变为
 *          1时，你可以令其回复1点体力，或交给其1张装备牌。
 * 【妙心】：锁定技，你每受到1点伤害后，若温宜剩余次数>0则摸2张；否则摸
 *          1张并令温宜剩余次数+1。
 *
 * 已知简化：环佩固定视为使用【杀】（不覆盖桃/酒等其它基本牌窗口）；
 * 温宜选项B只将装备牌交给目标（不代其自动装备），均为最小可用范围。
 */

const HUANPEI = 'huanpei'
const WENYI = 'wenyi'
const MIAOXIN = 'miaoxin'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUANPEI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      if (host.state.huanpeiRound === host.state.roundNumber) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: HUANPEI, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: HUANPEI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【环佩】：是否将手牌调整至体力值并视为使用一张杀？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.state.huanpeiRound = host.state.roundNumber
      if (owner.zones.hand.length < owner.hp) {
        drawCards(host.state, host.rng, ownerId, owner.hp - owner.zones.hand.length, (n, p) => { host.dispatch(n, p) })
      } else if (owner.zones.hand.length > owner.hp) {
        const discard = owner.zones.hand.slice(0, owner.zones.hand.length - owner.hp)
        for (const cardId of discard) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: discard, reason: HUANPEI }, { sourceId: ownerId, cardIds: discard })
      }
      host.dispatch('SkillActivated', { skillId: HUANPEI, skillName: '环佩', playerId: ownerId, logText: `${owner.nickname}发动【环佩】` }, { sourceId: ownerId })
      host.askSkill({
        skillId: HUANPEI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【环佩】：视为使用一张杀', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: HUANPEI })
    }
  },
})

registerSkillRuntime({
  id: WENYI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.hp !== 1) return
      if (target.marks['wenyi-turn'] === host.state.turnNumber) return
      target.marks['wenyi-turn'] = host.state.turnNumber
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (host.state.wenyiRemaining ?? 1) <= 0) return
      host.queueSkill({ skillId: WENYI, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (host.state.wenyiRemaining ?? 1) <= 0) return
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: WENYI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【温宜】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'peach', label: '视为使用一张桃' }, { id: 'equip', label: '交给其1张装备牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || (host.state.wenyiRemaining ?? 1) <= 0) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'peach') {
      if (target.hp >= target.maxHp) return
      host.state.wenyiRemaining = (host.state.wenyiRemaining ?? 1) - 1
      recover(host as never, targetId, 1, ownerId)
      restoreCharacter(host as never, ownerId, WENYI)
      host.dispatch('SkillActivated', { skillId: WENYI, skillName: '温宜', playerId: ownerId, targetId, logText: `${owner.nickname}发动【温宜】` }, { sourceId: ownerId, targetId })
    } else if (optionId === 'equip') {
      const equipCardId = owner.zones.hand.find((cardId) => host.state.cards[cardId]?.category === 'equipment')
      if (!equipCardId) return
      host.state.wenyiRemaining = (host.state.wenyiRemaining ?? 1) - 1
      moveCard(host.state, equipCardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [equipCardId], reason: WENYI }, { sourceId: ownerId, cardIds: [equipCardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [equipCardId], reason: WENYI }, { sourceId: ownerId, targetId, cardIds: [equipCardId] })
      restoreCharacter(host as never, ownerId, WENYI)
      host.dispatch('SkillActivated', { skillId: WENYI, skillName: '温宜', playerId: ownerId, targetId, logText: `${owner.nickname}发动【温宜】` }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: MIAOXIN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const payload = context.event.payload as { amount?: number }
      const points = Math.max(1, Math.trunc(payload.amount ?? 1))
      for (let i = 0; i < points; i += 1) {
        if ((host.state.wenyiRemaining ?? 1) > 0) {
          drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
        } else {
          drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
          host.state.wenyiRemaining = (host.state.wenyiRemaining ?? 0) + 1
        }
      }
    },
  }],
})

export const HUANSHUJUN: CharacterDefinition = {
  id: 'huanshujun',
  name: '环淑君',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: HUANPEI, name: '环佩', description: '每轮限一次，你的出牌阶段可以发动：将手牌调整至体力值，然后视为使用一张杀。' },
    { id: WENYI, name: '温宜', description: '全局限一次，一名角色本回合内体力值首次变为1时，你可以令其回复1点体力，或交给其1张装备牌；然后复原武将牌。' },
    { id: MIAOXIN, name: '妙心', description: '锁定技，你每受到1点伤害后，若温宜剩余次数大于0则摸2张；否则摸1张并令温宜剩余次数+1。' },
  ],
}
