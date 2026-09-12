import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { lockCardId, clearCardIdLocksOf, isCardIdLocked } from '../../engine/card-play-lock'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 董白（三国杀 OL 经典身份 SP）。
 *
 * 【连诛】：出牌阶段限一次，展示自己一张牌并交给一名其他角色；若这张牌
 *          为黑色，target选择：董白摸2张，或target弃置2张。
 * 【黠慧】：锁定技，董白的黑色手牌不计入手牌上限（`maxCardsBonus` 返回
 *          当前黑色手牌数）；其他角色获得董白的黑色牌后，这些具体
 *          Card ID 被锁定（不能使用/打出/在弃牌阶段被强制弃置，见新增的
 *          `card-play-lock.ts` 第四类禁令），直到该角色体力值下降才解锁。
 */

const LIANZHU = 'lianzhu'
const XIAHUI = 'xiahui'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LIANZHU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(LIANZHU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: LIANZHU, label: '连诛：展示一张牌并交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIANZHU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(LIANZHU)) return
    host.askSkill({
      skillId: LIANZHU, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【连诛】：展示一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      owner.turnUsedSkills.push(LIANZHU)
      host.dispatch('SkillActivated', { skillId: LIANZHU, skillName: '连诛', playerId: ownerId, logText: `${owner.nickname}发动【连诛】，展示【${host.state.cards[cardId]?.name ?? ''}】` }, { sourceId: ownerId, cardIds: [cardId] })
      host.askSkill({
        skillId: LIANZHU, ownerId, step: 'target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【连诛】：交给一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !owner.zones.hand.includes(cardId)) return
      const color = host.state.cards[cardId]?.color
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: LIANZHU }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: LIANZHU }, { targetId, cardIds: [cardId] })
      if (color !== 'black') return
      lockCardId(host.state, { targetId, cardId, sourceId: ownerId, skillId: XIAHUI })
      host.dispatch('SkillActivated', { skillId: XIAHUI, skillName: '黠慧', playerId: ownerId, targetId, logText: `${target.nickname}获得的黑色牌被【黠慧】锁定` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: LIANZHU, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: `${owner.nickname}给你的是黑色牌，选择一项`, timeoutMs: 20_000, optional: false,
          options: [{ id: 'draw', label: `令${owner.nickname}摸2张牌` }, { id: 'discard', label: '弃置2张手牌' }],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      const target = playerOf(host.state, targetId)
      const discardable = target?.zones.hand.filter((cardId) => !isCardIdLocked(host.state, targetId, cardId)) ?? []
      if (!target?.alive || discardable.length === 0) return
      host.askSkill({
        skillId: LIANZHU, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【连诛】：弃置2张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: discardable, hiddenCardSlots: [],
          min: Math.min(2, discardable.length), max: Math.min(2, discardable.length),
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const discarderId = response.playerId
      const discarder = playerOf(host.state, discarderId)
      const valid = cardIds.filter((cardId) => discarder?.zones.hand.includes(cardId))
      if (!discarder?.alive || valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: discarderId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: discarderId, cardIds: valid, reason: LIANZHU }, { sourceId: discarderId, cardIds: valid })
    }
  },
})

registerSkillRuntime({
  id: XIAHUI,
  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return 0
    return owner.zones.hand.filter((cardId) => state.cards[cardId]?.color === 'black').length
  },
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { amount?: number }
        if (context.event.targetId !== ownerId || (payload.amount ?? 0) <= 0) return
        clearCardIdLocksOf(host.state, ownerId)
      },
    },
    {
      event: 'LoseHp',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; amount?: number }
        if (payload.playerId !== ownerId || (payload.amount ?? 0) <= 0) return
        clearCardIdLocksOf(host.state, ownerId)
      },
    },
  ],
})

export const DONGBAI: CharacterDefinition = {
  id: 'dongbai',
  name: '董白',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: LIANZHU, name: '连诛', description: '出牌阶段限一次，展示自己一张牌并交给一名其他角色；若这张牌为黑色，其选择：令董白摸2张牌，或弃置2张手牌。' },
    { id: XIAHUI, name: '黠慧', description: '锁定技，董白的黑色手牌不计入手牌上限；其他角色获得董白的黑色牌后，这些牌被锁定不能使用/打出/弃置，直到该角色体力值下降。' },
  ],
}
