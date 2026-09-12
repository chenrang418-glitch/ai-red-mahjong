import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹纯（三国杀 OL 经典身份 SP）。
 *
 * 【缮甲】：出牌阶段开始时，曹纯可以摸 3 张牌，然后弃置 max(0, 3-X) 张牌
 *          （X 为曹纯本局至今失去过的装备牌数量，X 最大按 3 算）；若此次
 *          弃置的牌中没有基本牌和锦囊牌（含不需要弃牌的情况），曹纯可以
 *          视为使用一张无距离限制的【杀】。
 *
 * 两处最容易做错的：
 *
 * 1. **X 是持久累计的「失去过的装备牌数量」**，挂在 `LoseEquipment` 事件上
 *    （只认曹纯自己失去的），不按当前装备区剩余数量算，也不随时间重置。
 * 2. **虚拟【杀】仍计入正常出杀次数**，只是无距离限制；不消耗实体牌。
 */

const SHANJIA = 'shanjia'
const LOST_EQUIPMENT_MARK = 'shanjia-lost-equipment'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHANJIA,
  announcesSelf: true,

  triggers: [{
    event: 'LoseEquipment',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      owner.marks[LOST_EQUIPMENT_MARK] = (owner.marks[LOST_EQUIPMENT_MARK] ?? 0) + 1
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: SHANJIA, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: SHANJIA, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【缮甲】：摸 3 张牌，然后弃置 max(0, 3-X) 张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【缮甲】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.dispatch('SkillActivated', {
        skillId: SHANJIA, skillName: '缮甲', playerId: ownerId,
        logText: `${owner.nickname}发动【缮甲】，摸 3 张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
      const x = Math.min(3, owner.marks[LOST_EQUIPMENT_MARK] ?? 0)
      const discardCount = Math.min(Math.max(0, 3 - x), owner.zones.hand.length)
      if (discardCount <= 0) {
        finishShanjia(host, ownerId, [])
        return
      }
      host.askSkill({
        skillId: SHANJIA, ownerId, step: 'discard',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【缮甲】：弃置 ${discardCount} 张牌`,
          timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const owner = playerOf(host.state, ownerId)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner?.zones.hand.includes(cardId))
      if (!owner?.alive) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: SHANJIA }, { targetId: ownerId, cardIds })
      finishShanjia(host, ownerId, cardIds)
      return
    }

    if (resolution.step === 'slash-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: SHANJIA, countUsage: true })
    }
  },
})

function finishShanjia(host: SkillHost, ownerId: PlayerId, discarded: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const hasNonEquipment = discarded.some((cardId) => host.state.cards[cardId]?.category !== 'equipment')
  if (hasNonEquipment) return
  const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  if (candidateIds.length === 0) return
  host.askSkill({
    skillId: SHANJIA, ownerId, step: 'slash-target', data: {},
    build: (requestId) => ({
      id: requestId, kind: 'choose-targets' as const, playerId: ownerId,
      prompt: '【缮甲】：视为使用一张无距离限制的【杀】',
      timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
    }),
  })
}

export const CAOCHUN: CharacterDefinition = {
  id: 'caochun',
  name: '曹纯',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: SHANJIA,
      name: '缮甲',
      description: '出牌阶段开始时，曹纯可以摸 3 张牌，然后弃置 max(0, 3-X) 张牌（X 为曹纯本局至今失去过的装备牌数量，最大按 3 计）；若此次弃置的牌中没有基本牌和锦囊牌，曹纯可以视为使用一张无距离限制的【杀】。',
    },
  ],
}
