import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 许靖（三国杀 OL 经典身份 SP）。
 *
 * 【誉虚】：许靖于出牌阶段使用一张牌后，若没有「誉虚待偿」，可以摸一张
 *          牌并建立「誉虚待偿」；有「誉虚待偿」时，下一次使用牌后必须
 *          弃置一张牌，然后清除「誉虚待偿」。
 * 【实荐】：一名角色在其回合内使用第二张牌后，许靖可以弃置一张牌，令其
 *          直到当前回合结束获得【誉虚】。
 *
 * 「誉虚待偿」用一个数字 mark 记（1 表示待偿），出牌阶段结束时统一清除，
 * 不遗留到下一个出牌阶段。
 */

const YUXU = 'yuxu'
const SHIJIAN = 'shijian'
const YUXU_DEBT_MARK = 'yuxu-debt'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YUXU,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (owner.marks[YUXU_DEBT_MARK]) {
          delete owner.marks[YUXU_DEBT_MARK]
          if (owner.zones.hand.length > 0) host.queueSkill({ skillId: YUXU, ownerId, step: 'discard', data: {} })
          return
        }
        host.queueSkill({ skillId: YUXU, ownerId, step: 'ask-draw', data: {} })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner) delete owner.marks[YUXU_DEBT_MARK]
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'discard') {
      host.askSkill({
        skillId: YUXU, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【誉虚】：弃置一张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'ask-draw') {
      host.askSkill({
        skillId: YUXU, ownerId, step: 'ask-draw', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【誉虚】：是否摸一张牌？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: YUXU }, { sourceId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'ask-draw') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      owner.marks[YUXU_DEBT_MARK] = 1
      host.dispatch('SkillActivated', { skillId: YUXU, skillName: '誉虚', playerId: ownerId, logText: `${owner.nickname}发动【誉虚】，摸牌` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: SHIJIAN,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const actorId = context.event.sourceId
        if (!actorId || actorId === ownerId || host.state.currentPlayerId !== actorId) return
        const owner = playerOf(host.state, ownerId)
        const actor = playerOf(host.state, actorId)
        if (!owner?.alive || !actor?.alive) return
        const entry = host.state.turnCardUseCount?.[actorId]
        const count = entry?.turnNumber === host.state.turnNumber ? entry.count + 1 : 1
        host.state.turnCardUseCount ??= {}
        host.state.turnCardUseCount[actorId] = { turnNumber: host.state.turnNumber, count }
        if (count !== 2 || owner.zones.hand.length === 0) return
        const alreadyHasYuxu = actor.grantedSkills?.includes(YUXU) || (actor.temporaryGrantedSkills ?? []).some((entry2) => entry2.skillId === YUXU)
        if (alreadyHasYuxu) return
        host.queueSkill({ skillId: SHIJIAN, ownerId, step: 'ask', data: { actorId } })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (!payload.playerId) return
        replaceTemporarySkill(host.state, payload.playerId, SHIJIAN, null)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { actorId } = prompt.data as { actorId: PlayerId }
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive) return
    host.askSkill({
      skillId: SHIJIAN, ownerId, step: 'ask', data: { actorId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【实荐】：弃置一张牌，令${actor.nickname}直到本回合结束获得【誉虚】？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { actorId } = resolution.data as { actorId: PlayerId }
      const actor = playerOf(host.state, actorId)
      if (!actor?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: SHIJIAN, ownerId, step: 'discard', data: { actorId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【实荐】：弃置一张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const { actorId } = resolution.data as { actorId: PlayerId }
      const actor = playerOf(host.state, actorId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!actor?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: SHIJIAN }, { sourceId: ownerId, cardIds: [cardId] })
      replaceTemporarySkill(host.state, actorId, SHIJIAN, YUXU)
      host.dispatch('SkillActivated', { skillId: SHIJIAN, skillName: '实荐', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【实荐】，${actor.nickname}获得【誉虚】` }, { sourceId: ownerId, targetId: actorId })
    }
  },
})

export const XUJING: CharacterDefinition = {
  id: 'xujing',
  name: '许靖',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YUXU, name: '誉虚', description: '许靖于出牌阶段使用一张牌后，若没有“誉虚待偿”，可以摸一张牌并建立“誉虚待偿”；有“誉虚待偿”时，下一次使用牌后必须弃置一张牌，然后清除“誉虚待偿”。' },
    { id: SHIJIAN, name: '实荐', description: '一名角色在其回合内使用第二张牌后，许靖可以弃置一张牌，令其直到当前回合结束获得【誉虚】。' },
  ],
}
