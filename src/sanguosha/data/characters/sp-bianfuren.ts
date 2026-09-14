import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { gainEntryOf } from '../../engine/card-gain-provenance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 卞夫人（三国杀 OL 经典身份 SP）。
 *
 * 【挽危】：每个 TurnInstance 限一次，你的牌被其他角色弃置或获得后，你可以
 *          从牌堆中获得1张与其同名的牌（多个不同牌名时任选其一；无同名
 *          则你摸1张）。
 * 【约俭】：每个 TurnInstance 限2次，其他角色使用的、以你为目标的实体牌
 *          最终进入弃牌堆后，你可以展示所有手牌，若你当前所有手牌的花色
 *          都不同于这张牌（无手牌视为满足），你获得这张牌。
 */

const WANWEI = 'wanwei'
const YUEJIAN = 'yuejian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function handleWanwei(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.turnUsedSkills.includes(WANWEI) || cardIds.length === 0) return
  const names = [...new Set(cardIds.map((cardId) => host.state.cards[cardId]?.name).filter((name): name is string => Boolean(name)))]
  if (names.length === 0) return
  owner.turnUsedSkills.push(WANWEI)
  let found: CardId | undefined
  for (const candidate of names) {
    found = host.state.zones.drawPile.find((cardId) => host.state.cards[cardId]?.name === candidate)
    if (found) break
  }
  host.dispatch('SkillActivated', { skillId: WANWEI, skillName: '挽危', playerId: ownerId, logText: `${owner.nickname}发动【挽危】` }, { sourceId: ownerId })
  if (!found) {
    drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    return
  }
  moveCard(host.state, found, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [found], reason: WANWEI }, { targetId: ownerId, cardIds: [found] })
}

registerSkillRuntime({
  id: WANWEI,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
        if (payload.playerId !== ownerId || payload.reason === WANWEI) return
        handleWanwei(host, ownerId, payload.cardIds ?? [])
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
        if (!payload.playerId || payload.playerId === ownerId || payload.reason === WANWEI) return
        const mine = (payload.cardIds ?? []).filter((cardId) => gainEntryOf(host.state, cardId)?.fromId === ownerId)
        handleWanwei(host, ownerId, mine)
      },
    },
  ],
})

registerSkillRuntime({
  id: YUEJIAN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[]; virtual?: boolean }
      if (payload.virtual || !payload.cardId || !(payload.targetIds ?? []).includes(ownerId)) return
      if (!host.state.zones.discardPile.includes(payload.cardId)) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const used = owner.marks['yuejian-turn'] === host.state.turnNumber ? (owner.marks['yuejian-count'] ?? 0) : 0
      if (used >= 2) return
      host.queueSkill({ skillId: YUEJIAN, ownerId, step: 'ask', data: { cardId: payload.cardId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: YUEJIAN, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【约俭】：是否展示全部手牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { cardId } = resolution.data as { cardId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !host.state.zones.discardPile.includes(cardId) || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (owner.marks['yuejian-turn'] !== host.state.turnNumber) { owner.marks['yuejian-turn'] = host.state.turnNumber; owner.marks['yuejian-count'] = 0 }
    owner.marks['yuejian-count'] = (owner.marks['yuejian-count'] ?? 0) + 1
    if (owner.zones.hand.length > 0) {
      host.dispatch('CardMove', { cardIds: [...owner.zones.hand], reason: YUEJIAN, revealed: true }, { sourceId: ownerId })
    }
    const cardSuit = host.state.cards[cardId]?.suit
    const allDifferent = owner.zones.hand.every((id) => host.state.cards[id]?.suit !== cardSuit)
    if (!allDifferent) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YUEJIAN }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: YUEJIAN, skillName: '约俭', playerId: ownerId, logText: `${owner.nickname}发动【约俭】` }, { sourceId: ownerId })
  },
})

export const BIANFUREN: CharacterDefinition = {
  id: 'bianfuren',
  name: '卞夫人',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WANWEI, name: '挽危', description: '每个 TurnInstance 限一次，你的牌被其他角色弃置或获得后，你可以从牌堆中获得1张与其同名的牌；无同名则你摸1张。' },
    { id: YUEJIAN, name: '约俭', description: '每个 TurnInstance 限2次，其他角色使用的、以你为目标的实体牌最终进入弃牌堆后，你可以展示所有手牌，若你当前所有手牌的花色都不同于这张牌，你获得这张牌。' },
  ],
}
