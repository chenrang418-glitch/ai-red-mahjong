import { moveCard } from '../../engine/zones'
import { lockCardCategory } from '../../engine/card-play-lock'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 高览（三国杀 OL 经典身份 SP）。
 *
 * 【袭营】：出牌阶段开始时，高览可以弃置一张非基本牌；若如此做，其他
 *          存活角色依次选择弃置一张牌，或直到本回合结束不能使用或打出
 *          任何牌；高览若本出牌阶段造成过伤害，结束阶段可以获得牌堆中
 *          的一张【杀】或一张伤害类锦囊牌。
 *
 * 「不能使用或打出任何牌」直接对基本/锦囊/装备三个类别各挂一条颜色禁令
 * 同款的类别禁令（`lockCardCategory`），三条各自独立叠加，和杨修
 * 【鸡肋】共用同一套回合结束清理，不新写状态。
 */

const XIYING = 'xiying'
const XIYING_DAMAGED_MARK = `${XIYING}-damaged`
const DAMAGE_TRICK_NAMES = new Set(['决斗', '南蛮入侵', '万箭齐发', '火攻'])
const CATEGORIES: CardCategory[] = ['basic', 'trick', 'equipment']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function aliveOthersInOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const alive = state.players.filter((candidate) => candidate.alive).sort((left, right) => left.seat - right.seat)
  const startIndex = alive.findIndex((candidate) => candidate.id === ownerId)
  if (startIndex < 0) return []
  const ordered = [...alive.slice(startIndex + 1), ...alive.slice(0, startIndex)]
  return ordered.map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: XIYING,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !owner.zones.hand.some((cardId) => host.state.cards[cardId]?.category !== 'basic')) return
        host.queueSkill({ skillId: XIYING, ownerId, step: 'discard-ask', data: {} })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId === ownerId) markUsedThisPhase(host.state, ownerId, XIYING_DAMAGED_MARK)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        if (!usedThisPhase(host.state, ownerId, XIYING_DAMAGED_MARK)) return
        const cardId = host.state.zones.drawPile.find((candidate) => {
          const name = host.state.cards[candidate]?.name ?? ''
          return name === '杀' || DAMAGE_TRICK_NAMES.has(name)
        })
        if (!cardId) return
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: XIYING }, { targetId: ownerId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: XIYING, skillName: '袭营', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【袭营】，获得一张牌` }, { sourceId: ownerId })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'discard-ask') {
      const candidates = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== 'basic')
      if (candidates.length === 0) return
      host.askSkill({
        skillId: XIYING, ownerId, step: 'discard-ask', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【袭营】：可以弃置一张非基本牌', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'discard-ask') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XIYING }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: XIYING, skillName: '袭营', playerId: ownerId, logText: `${owner.nickname}发动【袭营】` }, { sourceId: ownerId })
      const order = aliveOthersInOrder(host.state, ownerId)
      askXiyingChoice(host, ownerId, order, 0)
      return
    }

    if (resolution.step === 'choice') {
      const { order, index, actorId } = resolution.data as { order: PlayerId[]; index: number; actorId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      const actor = playerOf(host.state, actorId)
      if (actor?.alive) {
        if (optionId === 'lock') {
          for (const category of CATEGORIES) lockCardCategory(host.state, { targetId: actorId, category, sourceId: ownerId, skillId: `${XIYING}-${category}` })
        } else if (actor.zones.hand.length > 0) {
          host.askSkill({
            skillId: XIYING, ownerId, step: 'discard-actor', data: { order, index, actorId },
            build: (requestId): ChooseCardsRequest => ({
              id: requestId, kind: 'choose-cards', playerId: actorId,
              prompt: '【袭营】：弃置一张牌', timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
            }),
          })
          return
        }
      }
      askXiyingChoice(host, ownerId, order, index + 1)
      return
    }

    if (resolution.step === 'discard-actor') {
      const { order, index, actorId } = resolution.data as { order: PlayerId[]; index: number; actorId: PlayerId }
      const actor = playerOf(host.state, actorId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (actor?.alive && cardId && actor.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: actorId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: XIYING }, { sourceId: actorId, cardIds: [cardId] })
      }
      askXiyingChoice(host, ownerId, order, index + 1)
    }
  },
})

function askXiyingChoice(host: SkillHost, ownerId: PlayerId, order: PlayerId[], index: number): void {
  if (index >= order.length) return
  const actorId = order[index]
  const actor = playerOf(host.state, actorId)
  if (!actor?.alive) { askXiyingChoice(host, ownerId, order, index + 1); return }
  const options: Array<{ id: string; label: string }> = actor.zones.hand.length > 0
    ? [{ id: 'discard', label: '弃置一张牌' }, { id: 'lock', label: '直到本回合结束不能使用或打出任何牌' }]
    : [{ id: 'lock', label: '直到本回合结束不能使用或打出任何牌' }]
  host.askSkill({
    skillId: XIYING, ownerId, step: 'choice', data: { order, index, actorId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: actorId,
      prompt: '【袭营】：选择一项', timeoutMs: 20_000, optional: false, options,
    }),
  })
}

export const GAOLAN: CharacterDefinition = {
  id: 'gaolan',
  name: '高览',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: XIYING, name: '袭营', description: '出牌阶段开始时，高览可以弃置一张非基本牌；若如此做，其他存活角色依次选择弃置一张牌，或直到本回合结束不能使用或打出任何牌；高览若本出牌阶段造成过伤害，结束阶段可以获得牌堆中的一张【杀】或一张伤害类锦囊牌。' },
  ],
}
