import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, CardCategory, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 牵招（三国杀 OL 经典身份 SP）。
 *
 * 【威抚】：出牌阶段，牵招可以弃置1张牌然后进行判定；判定后记录判定牌的
 *          类别，直到本回合结束，牵招下一次使用与该类别相同的牌无距离
 *          限制、可以额外指定1个合法目标（该"额外目标"只对【杀】的多
 *          目标生效，普通锦囊的目标结构没有通用扩展入口，这部分是已知
 *          简化）；若弃置牌类别与判定牌类别相同，牵招摸1张牌。多次发动
 *          分别记录，不覆盖。
 * 【款塞】：每个 TurnInstance 限一次，一次 CardUse 指定目标后，若目标数
 *          不少于牵招当前体力，牵招可以选择其中一名目标，令其选择交给
 *          牵招1张牌或令牵招回复1点体力。
 */

const WEIFU = 'weifu'
const KUANSAI = 'kuansai'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function activeModifiers(state: SanguoshaState, ownerId: PlayerId): Array<{ category: CardCategory; turnNumber: number }> {
  return (state.qianzhaoModifiers?.[ownerId] ?? []).filter((entry) => entry.turnNumber === state.turnNumber)
}

registerSkillRuntime({
  id: WEIFU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    return [{ id: WEIFU, label: '威抚：弃置一张牌进行判定' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== WEIFU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: WEIFU, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【威抚】：弃置一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    const discardedCategory = host.state.cards[cardId]?.category
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WEIFU }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: WEIFU, skillName: '威抚', playerId: ownerId, logText: `${owner.nickname}发动【威抚】` }, { sourceId: ownerId })

    const judgeCardId = host.state.zones.drawPile[0]
    if (!judgeCardId) return
    moveCard(host.state, judgeCardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { cardIds: [judgeCardId], reason: WEIFU, revealed: true }, { sourceId: ownerId, cardIds: [judgeCardId] })
    const judgeCategory = host.state.cards[judgeCardId]?.category
    moveCard(host.state, judgeCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    if (!judgeCategory) return

    host.state.qianzhaoModifiers ??= {}
    host.state.qianzhaoModifiers[ownerId] ??= []
    host.state.qianzhaoModifiers[ownerId].push({ category: judgeCategory, turnNumber: host.state.turnNumber })

    if (discardedCategory === judgeCategory) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },

  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cancelled || !payload.cardId) return
      const category = host.state.cards[payload.cardId]?.category
      const list = host.state.qianzhaoModifiers?.[ownerId]
      if (!list || !category) return
      const index = list.findIndex((entry) => entry.turnNumber === host.state.turnNumber && entry.category === category)
      if (index >= 0) list.splice(index, 1)
    },
  }],

  ignoresDistanceTo(state, ownerId) {
    return activeModifiers(state, ownerId).length > 0
  },
  extraSlashTargets(state, ownerId) {
    return activeModifiers(state, ownerId).some((entry) => entry.category === 'basic') ? 1 : 0
  },
})

registerSkillRuntime({
  id: KUANSAI,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(KUANSAI)) return
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      const targetIds = payload.targetIds ?? (context.event.targetId ? [context.event.targetId] : [])
      if (targetIds.length < owner.hp) return
      const validTargets = targetIds.filter((id) => playerOf(host.state, id)?.alive)
      if (validTargets.length === 0) return
      host.queueSkill({ skillId: KUANSAI, ownerId, step: 'pick', data: { targetIds: validTargets } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANSAI)) return
    const { targetIds } = prompt.data as { targetIds: PlayerId[] }
    host.askSkill({
      skillId: KUANSAI, ownerId, step: 'pick',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【款塞】：选择一名目标', timeoutMs: 20_000, optional: true, candidateIds: targetIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(KUANSAI)) return

    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      owner.turnUsedSkills.push(KUANSAI)
      host.dispatch('SkillActivated', { skillId: KUANSAI, skillName: '款塞', playerId: ownerId, targetId, logText: `${owner.nickname}发动【款塞】` }, { sourceId: ownerId, targetId })
      const options = [
        ...(target.zones.hand.length > 0 ? [{ id: 'give', label: `交给${owner.nickname}1张牌` }] : []),
        { id: 'recover', label: `令${owner.nickname}回复1点体力` },
      ]
      host.askSkill({
        skillId: KUANSAI, ownerId, step: 'choose', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【款塞】：请选择', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }

    if (resolution.step === 'choose') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'recover') { recover(host as never, ownerId, 1, targetId); return }
      if (target.zones.hand.length === 0) return
      host.askSkill({
        skillId: KUANSAI, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【款塞】：交给${owner.nickname}1张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: KUANSAI }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: KUANSAI }, { targetId: ownerId, cardIds: [cardId] })
    }
  },
})

export const QIANZHAO: CharacterDefinition = {
  id: 'qianzhao',
  name: '牵招',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: WEIFU, name: '威抚', description: '出牌阶段，牵招可以弃置1张牌然后进行判定；直到本回合结束，牵招下一次使用与判定牌类别相同的牌无距离限制、可以额外指定1个目标；若弃置牌类别与判定牌类别相同，摸1张牌。' },
    { id: KUANSAI, name: '款塞', description: '每个 TurnInstance 限一次，一次使用牌指定目标后，若目标数不少于牵招当前体力，牵招可以选择其中一名目标，令其交给牵招1张牌或令牵招回复1点体力。' },
  ],
}
