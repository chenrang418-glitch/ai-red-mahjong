import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蒋干（三国杀 OL 经典身份 SP）。
 *
 * 【伪诚】：蒋干将手牌交给其他角色，或其他角色获得蒋干的手牌后，若蒋干
 *          当前手牌数小于体力值，可以摸一张牌。
 * 【盗书】：出牌阶段限一次，蒋干选择一名角色并声明一种花色，然后随机获得
 *          其一张手牌；若猜中，蒋干对其造成1点伤害，且【盗书】视为本
 *          出牌阶段未发动过；若猜错，蒋干须交给其一张与刚获得的牌花色
 *          不同的手牌（没有则展示所有手牌）。
 *
 * 伪诚只覆盖两条能被引擎既有事件明确定位来源/去向的路径：
 * 蒋干自己用 `giveCards` 把牌交出去（`LoseCard.sourceId === 蒋干`），
 * 以及顺手牵羊式的直接摘取（`CardMove.targetId === 蒋干`）；这是「蒋干
 * 手牌离开、别人的手牌区变化」里能明确判定来源的两种最常见走向。
 */

const WEICHENG = 'weicheng'
const DAOSHU = 'daoshu'
const SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']
const SUIT_LABELS: Record<Suit, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WEICHENG,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        host.queueSkill({ skillId: WEICHENG, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'CardMove',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
        host.queueSkill({ skillId: WEICHENG, ownerId, step: 'ask', data: {} })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length >= owner.hp) return
    host.askSkill({
      skillId: WEICHENG, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【伪诚】：是否摸一张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: WEICHENG, skillName: '伪诚', playerId: ownerId, logText: `${owner.nickname}发动【伪诚】，摸牌` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: DAOSHU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DAOSHU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.zones.hand.length > 0)) return []
    return [{ id: DAOSHU, label: '盗书：选择一名角色并声明花色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== DAOSHU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DAOSHU)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: DAOSHU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【盗书】：选择一名角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      host.askSkill({
        skillId: DAOSHU, ownerId, step: 'suit', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【盗书】：声明${target.nickname}一张手牌的花色`, timeoutMs: 20_000, optional: false,
          options: SUITS.map((suit) => ({ id: suit, label: SUIT_LABELS[suit] })),
        }),
      })
      return
    }

    if (resolution.step === 'suit') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const declared = (response.payload as { optionId?: string }).optionId as Suit | undefined
      if (!target?.alive || target.zones.hand.length === 0 || !declared) return
      if (!owner.turnUsedSkills.includes(DAOSHU)) owner.turnUsedSkills.push(DAOSHU)
      const picked = host.rng.pick(target.zones.hand)
      moveCard(host.state, picked, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: DAOSHU }, { targetId: ownerId, cardIds: [picked] })
      const actualSuit = host.state.cards[picked]?.suit
      host.dispatch('SkillActivated', { skillId: DAOSHU, skillName: '盗书', playerId: ownerId, targetId, logText: `${owner.nickname}发动【盗书】，声明${SUIT_LABELS[declared]}` }, { sourceId: ownerId, targetId })

      if (actualSuit === declared) {
        owner.turnUsedSkills = owner.turnUsedSkills.filter((id) => id !== DAOSHU)
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
        return
      }

      const payCandidates = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit !== actualSuit)
      if (payCandidates.length === 0) {
        host.dispatch('SkillActivated', { skillId: DAOSHU, skillName: '盗书', playerId: ownerId, logText: `${owner.nickname}没有可以交出的手牌，展示所有手牌` }, { sourceId: ownerId, cardIds: [...owner.zones.hand] })
        return
      }
      host.askSkill({
        skillId: DAOSHU, ownerId, step: 'pay', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【盗书】：交给对方一张花色不同的手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: payCandidates, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pay') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      giveCards(host as never, ownerId, targetId, [cardId], DAOSHU)
    }
  },
})

export const JIANGGAN: CharacterDefinition = {
  id: 'jianggan',
  name: '蒋干',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WEICHENG, name: '伪诚', description: '蒋干将手牌交给其他角色，或其他角色获得蒋干的手牌后，若蒋干当前手牌数小于体力值，可以摸一张牌。' },
    { id: DAOSHU, name: '盗书', description: '出牌阶段限一次，选择一名角色并声明一种花色，然后随机获得其一张手牌；若猜中，对其造成1点伤害，且【盗书】视为本阶段未发动过；若猜错，须交给其一张花色不同的手牌（没有则展示所有手牌）。' },
  ],
}
