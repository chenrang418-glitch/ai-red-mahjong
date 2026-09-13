import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 阎圃（三国杀 OL 经典身份 SP）。
 *
 * 【缓图】：每轮限一次，摸牌阶段开始前，阎圃可以交给攻击范围内一名其他
 *          角色A 1张牌，令A跳过本次摸牌阶段；A当前回合结束阶段，阎圃
 *          选择：A回复1点体力然后摸2张，或阎圃摸3张然后交给A 2张手牌。
 * 【避祸】：限定技，一名角色成功脱离濒死后，阎圃可以发动：该角色摸3张
 *          牌，然后当前轮内，其他角色计算与其的距离+X（X=当前存活角色
 *          数，复用既有 `distanceFromOthers` 字段，轮结束清理）。
 */

const HUANTU = 'huantu'
const BIHUO = 'bihuo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUANTU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return

        if (payload.phase === 'draw' && payload.playerId && payload.playerId !== ownerId) {
          if ((owner.marks['huantu-used'] ?? 0) > 0 || owner.zones.hand.length === 0) return
          if (!canTarget(host.state, ownerId, payload.playerId)) return
          host.queueSkill({ skillId: HUANTU, ownerId, step: 'ask', data: { targetId: payload.playerId } })
          return
        }
        if (payload.phase === 'end' && payload.playerId) {
          const pending = host.state.yanpuHuantuPending
          if (!pending || pending.targetId !== payload.playerId || pending.turnNumber !== host.state.turnNumber) return
          host.state.yanpuHuantuPending = undefined
          host.queueSkill({ skillId: HUANTU, ownerId, step: 'compensate', data: { targetId: payload.playerId } })
        }
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks['huantu-used'] = 0
      },
    },
    {
      event: 'DrawPhase',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const pending = host.state.yanpuSkipDraw
        if (!pending || !payload.playerId || pending.targetId !== payload.playerId || pending.turnNumber !== host.state.turnNumber) return
        context.cancel()
        host.state.yanpuSkipDraw = undefined
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      if ((owner.marks['huantu-used'] ?? 0) > 0 || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: HUANTU, ownerId, step: 'ask', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【缓图】：是否交给${playerOf(host.state, targetId)?.nickname}1张牌，令其跳过摸牌阶段？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'compensate') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const options = [{ id: 'a', label: `${target.nickname}回复1点体力然后摸2张` }]
      if (owner.zones.hand.length >= 2) options.push({ id: 'b', label: '阎圃摸3张然后交给其2张手牌' })
      host.askSkill({
        skillId: HUANTU, ownerId, step: 'compensate', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【缓图】：结束阶段补偿', timeoutMs: 20_000, optional: false, options,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || owner.zones.hand.length === 0) return
      const { targetId } = resolution.data as { targetId: PlayerId }
      host.askSkill({
        skillId: HUANTU, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【缓图】：交给1张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      owner.marks['huantu-used'] = 1
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: HUANTU }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: HUANTU }, { targetId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: HUANTU, skillName: '缓图', playerId: ownerId, targetId, logText: `${owner.nickname}发动【缓图】` }, { sourceId: ownerId, targetId })
      host.state.yanpuHuantuPending = { targetId, turnNumber: host.state.turnNumber }
      host.state.yanpuSkipDraw = { targetId, turnNumber: host.state.turnNumber }
      return
    }

    if (resolution.step === 'compensate') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'a') {
        recover(host as never, targetId, 1, targetId)
        drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      if (optionId === 'b') {
        drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
        const current = playerOf(host.state, ownerId)
        if (!current?.alive) return
        const give = current.zones.hand.slice(0, 2)
        if (give.length === 0) return
        for (const cardId of give) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: give, reason: HUANTU }, { sourceId: ownerId, cardIds: give })
        host.dispatch('GainCard', { playerId: targetId, cardIds: give, reason: HUANTU }, { targetId, cardIds: give })
      }
    }
  },
})

registerSkillRuntime({
  id: BIHUO,
  triggers: [
    {
      event: 'QuitDying',
      handle(host, ownerId, context) {
        const rescuedId = context.event.targetId
        const owner = playerOf(host.state, ownerId)
        if (!rescuedId || !owner?.alive || owner.usedLimitedSkills.includes(BIHUO)) return
        host.queueSkill({ skillId: BIHUO, ownerId, step: 'ask', data: { rescuedId } })
      },
    },
    {
      event: 'RoundStart',
      handle(host) {
        const active = host.state.yanpuBihuoActive
        if (!active || active.roundNumber === host.state.roundNumber) return
        const rescued = playerOf(host.state, active.playerId)
        if (rescued) rescued.distanceFromOthers -= active.amount
        host.state.yanpuBihuoActive = undefined
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(BIHUO)) return
    const { rescuedId } = prompt.data as { rescuedId: PlayerId }
    if (!playerOf(host.state, rescuedId)?.alive) return
    host.askSkill({
      skillId: BIHUO, ownerId, step: 'ask', data: { rescuedId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【避祸】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    const { rescuedId } = resolution.data as { rescuedId: PlayerId }
    const rescued = playerOf(host.state, rescuedId)
    if (!owner?.alive || !rescued?.alive) return
    owner.usedLimitedSkills.push(BIHUO)
    host.dispatch('SkillActivated', { skillId: BIHUO, skillName: '避祸', playerId: ownerId, targetId: rescuedId, logText: `${owner.nickname}发动【避祸】` }, { sourceId: ownerId, targetId: rescuedId })
    drawCards(host.state, host.rng, rescuedId, 3, (name, payload) => { host.dispatch(name, payload) })
    const x = host.state.players.filter((candidate) => candidate.alive).length
    rescued.distanceFromOthers += x
    host.state.yanpuBihuoActive = { playerId: rescuedId, amount: x, roundNumber: host.state.roundNumber }
  },
})

export const YANPU: CharacterDefinition = {
  id: 'yanpu',
  name: '阎圃',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: HUANTU, name: '缓图', description: '每轮限一次，摸牌阶段开始前，可以交给攻击范围内一名其他角色1张牌，令其跳过本次摸牌阶段；其结束阶段，阎圃选择令其回复1点体力然后摸2张，或阎圃摸3张然后交给其2张手牌。' },
    { id: BIHUO, name: '避祸', description: '限定技，一名角色成功脱离濒死后，阎圃可以发动：其摸3张牌，当前轮内其他角色计算与其的距离+X（X为当前存活角色数）。' },
  ],
}
