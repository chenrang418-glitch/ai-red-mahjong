import { drawCards } from '../../engine/draw'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { hasPickableCards, pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 严颜（三国杀 OL 经典身份 SP）。
 *
 * 【拒战】：转换技。阳：严颜成为其他角色使用【杀】的目标后，可以发动：
 *          双方各摸1张牌，然后直到本回合结束该角色不能对严颜使用牌，然后
 *          切换为阴。阴：严颜使用【杀】指定目标后，可以发动：获得目标1张
 *          牌，然后直到本回合结束严颜不能对该目标使用牌，然后切换为阳。
 *          多目标【杀】时阴拒战只处理其中一个目标。
 */

const JUZHAN = 'juzhan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JUZHAN,
  prohibitsTarget(state, ownerId, sourceId) {
    const entry = state.yanyanBlockedByOthers?.[ownerId]
    return !!entry && entry.turnNumber === state.turnNumber && entry.blockedSourceId === sourceId
  },
  prohibitsSourceTarget(state, ownerId, targetId) {
    const entry = state.yanyanSelfBlocked?.[ownerId]
    return !!entry && entry.turnNumber === state.turnNumber && entry.blockedTargetId === targetId
  },
  triggers: [
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        const payload = context.event.payload as { cardName?: string }
        if (!sourceId || sourceId === ownerId || targetId !== ownerId || payload.cardName !== '杀') return
        if (conversionStateOf(host.state, ownerId, JUZHAN) !== 'yang') return
        host.queueSkill({ skillId: JUZHAN, ownerId, step: 'yang-ask', data: { sourceId } })
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        const payload = context.event.payload as { cardName?: string }
        if (sourceId !== ownerId || !targetId || targetId === ownerId || payload.cardName !== '杀') return
        if (conversionStateOf(host.state, ownerId, JUZHAN) !== 'yin') return
        host.queueSkill({ skillId: JUZHAN, ownerId, step: 'yin-ask', data: { targetId } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'yang-ask') {
      const { sourceId } = prompt.data as { sourceId: PlayerId }
      if (conversionStateOf(host.state, ownerId, JUZHAN) !== 'yang' || !playerOf(host.state, sourceId)?.alive) return
      host.askSkill({
        skillId: JUZHAN, ownerId, step: 'yang-confirm', data: { sourceId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【拒战】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动：双方各摸1张牌，此后对方本回合不能对你使用牌' }, { id: 'cancel', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'yin-ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      if (conversionStateOf(host.state, ownerId, JUZHAN) !== 'yin' || !playerOf(host.state, targetId)?.alive) return
      host.askSkill({
        skillId: JUZHAN, ownerId, step: 'yin-confirm', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【拒战】：是否发动？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动：获得目标1张牌，此后你本回合不能对其使用牌' }, { id: 'cancel', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId

    if (resolution.step === 'yang-confirm') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const source = playerOf(host.state, sourceId)
      if (optionId !== 'yes' || !source?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      drawCards(host.state, host.rng, sourceId, 1, (name, payload) => { host.dispatch(name, payload) })
      host.state.yanyanBlockedByOthers ??= {}
      host.state.yanyanBlockedByOthers[ownerId] = { turnNumber: host.state.turnNumber, blockedSourceId: sourceId }
      toggleConversionState(host.state, ownerId, JUZHAN)
      host.dispatch('SkillActivated', { skillId: JUZHAN, skillName: '拒战', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【拒战】（阳）` }, { sourceId: ownerId, targetId: sourceId })
      return
    }

    if (resolution.step === 'yin-confirm') {
      if (optionId !== 'yes') return
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.state.yanyanSelfBlocked ??= {}
      host.state.yanyanSelfBlocked[ownerId] = { turnNumber: host.state.turnNumber, blockedTargetId: targetId }
      toggleConversionState(host.state, ownerId, JUZHAN)
      host.dispatch('SkillActivated', { skillId: JUZHAN, skillName: '拒战', playerId: ownerId, targetId, logText: `${owner.nickname}发动【拒战】（阴）` }, { sourceId: ownerId, targetId })
      if (!hasPickableCards(host.state, targetId)) return
      const pickable = pickableCardsOf(host.state, targetId)
      host.askSkill({
        skillId: JUZHAN, ownerId, step: 'yin-gain', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【拒战】：获得${target.nickname}的一张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'yin-gain') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const realId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (!realId) return
      movePickedCard(host as never, targetId, realId, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: JUZHAN }, { sourceId: ownerId, targetId, cardIds: [realId] })
    }
  },
})

export const YANYAN: CharacterDefinition = {
  id: 'yanyan',
  name: '严颜',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JUZHAN, name: '拒战', description: '转换技。阳：严颜成为其他角色使用【杀】的目标后，可以双方各摸1张牌，然后直到本回合结束该角色不能对严颜使用牌，然后切换为阴。阴：严颜使用【杀】指定目标后，可以获得目标1张牌，然后直到本回合结束严颜不能对该目标使用牌，然后切换为阳。' },
  ],
}
