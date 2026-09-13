import { moveCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 何进（三国杀 OL 经典身份 SP）。
 *
 * 【谋诛】：出牌阶段限一次，选择一名其他角色A，A交给何进1张手牌（A自己
 *          选择）；若此后A.handCount<何进.handCount，A选择视为对何进使用
 *          一张【杀】或【决斗】。
 * 【延祸】：何进死亡时，若存在杀死他的角色K，何进可以弃置K至多X张牌
 *          （X=何进死亡时拥有的牌数，手牌+装备+判定区）。
 */

const MOUZHU = 'mouzhu'
const YANHUO = 'yanhuo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function ownedCardCount(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  if (!player) return 0
  return player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length + player.zones.judgingArea.length
}

registerSkillRuntime({
  id: MOUZHU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MOUZHU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)) return []
    return [{ id: MOUZHU, label: '谋诛：选择一名角色，其交给你1张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== MOUZHU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MOUZHU)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(MOUZHU)
    host.askSkill({
      skillId: MOUZHU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【谋诛】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.dispatch('SkillActivated', { skillId: MOUZHU, skillName: '谋诛', playerId: ownerId, logText: `${owner.nickname}发动【谋诛】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: MOUZHU, ownerId, step: 'give-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【谋诛】：交给何进1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOUZHU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      if (target.zones.hand.length >= owner.zones.hand.length) return
      host.askSkill({
        skillId: MOUZHU, ownerId, step: 'choose-card-type', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【谋诛】：视为对何进使用一张杀或决斗', timeoutMs: 20_000, optional: true,
          options: [{ id: '杀', label: '视为使用【杀】' }, { id: '决斗', label: '视为使用【决斗】' }, { id: 'none', label: '不发动' }],
        }),
      })
      return
    }

    if (resolution.step === 'choose-card-type') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const cardName = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || (cardName !== '杀' && cardName !== '决斗')) return
      host.dispatch('SkillActivated', { skillId: MOUZHU, skillName: '谋诛', playerId: ownerId, logText: `${target.nickname}视为对${owner.nickname}使用【${cardName}】` }, { sourceId: targetId, targetId: ownerId })
      if (cardName === '杀') {
        host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: MOUZHU })
        return
      }
      const virtualId = createVirtualTrick(host.state, targetId, '决斗', MOUZHU)
      executeUseCardAction(host as never, targetId, {
        kind: 'use-card', id: `mouzhu:${virtualId}`, playerId: targetId,
        cardIds: [virtualId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
        asCardName: '决斗', label: '【谋诛】：视为使用【决斗】',
      })
    }
  },
})

registerSkillRuntime({
  id: YANHUO,
  triggers: [{
    event: 'Death',
    allowDeadOwner: true,
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const killerId = context.event.sourceId
      if (!killerId) return
      const killer = playerOf(host.state, killerId)
      if (!killer?.alive) return
      const x = ownedCardCount(host.state, ownerId)
      if (x <= 0) return
      host.queueSkill({ skillId: YANHUO, ownerId, step: 'discard-ask', data: { killerId, x } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-ask') return
    const { killerId, x } = prompt.data as { killerId: PlayerId; x: number }
    const killer = playerOf(host.state, killerId)
    if (!killer?.alive || killer.zones.hand.length === 0) return
    host.askSkill({
      skillId: YANHUO, ownerId, step: 'discard', data: { killerId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【延祸】：弃置${killer.nickname}至多${Math.min(x, killer.zones.hand.length)}张牌，选择数量`, timeoutMs: 20_000, optional: true,
        options: [
          ...Array.from({ length: Math.min(x, killer.zones.hand.length) }, (_, index) => ({ id: String(index + 1), label: `弃${index + 1}张` })),
          { id: '0', label: '不弃置' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const { killerId } = resolution.data as { killerId: PlayerId }
    const killer = playerOf(host.state, killerId)
    const count = Number((response.payload as { optionId?: string }).optionId ?? '0')
    if (!killer?.alive || count <= 0) return
    const pool = [...killer.zones.hand]
    const picked: CardId[] = []
    for (let index = 0; index < count && pool.length > 0; index += 1) {
      const [cardId] = pool.splice(host.rng.nextInt(pool.length), 1)
      picked.push(cardId)
    }
    for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: killerId }, { kind: 'discardPile' })
    if (picked.length > 0) host.dispatch('LoseCard', { playerId: killerId, cardIds: picked, reason: YANHUO }, { sourceId: ownerId, targetId: killerId, cardIds: picked })
  },
})

export const HEJIN: CharacterDefinition = {
  id: 'hejin',
  name: '何进',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: MOUZHU, name: '谋诛', description: '出牌阶段限一次，选择一名其他角色，其交给你1张手牌；若此后其手牌数少于你，其可以选择视为对你使用一张【杀】或【决斗】。' },
    { id: YANHUO, name: '延祸', description: '你死亡时，若存在杀死你的角色，你可以弃置其至多X张牌（X为你死亡时拥有的牌数）。' },
  ],
}
