import { moveCard } from '../../engine/zones'
import { revealTopCards } from '../../engine/draw'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘辟（三国杀 OL 经典身份 SP）。
 *
 * 【易城】：出牌阶段限一次，若有手牌，展示牌堆顶X张牌（X=体力上限）；可用
 *          任意张手牌交换其中等量张展示牌；若展示牌点数之和因此增加，可以
 *          用当前所有手牌交换等量展示牌；结算后仍留在展示区的牌按当前顺序
 *          放回牌堆顶。
 */

const YICHENG = 'yicheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function sumRank(state: SanguoshaState, cardIds: CardId[]): number {
  return cardIds.reduce((sum, id) => sum + (state.cards[id]?.rank ?? 0), 0)
}

registerSkillRuntime({
  id: YICHENG,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(YICHENG)) return []
    return [{ id: YICHENG, label: '易城：展示牌堆顶X张牌，用手牌交换' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YICHENG) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(YICHENG)) return
    owner.turnUsedSkills.push(YICHENG)
    const x = Math.max(0, owner.maxHp)
    const revealed = revealTopCards(host.state, host.rng, x, YICHENG, (name, payload) => { host.dispatch(name, payload) })
    if (revealed.length === 0) return
    host.dispatch('SkillActivated', { skillId: YICHENG, skillName: '易城', playerId: ownerId, logText: `${owner.nickname}发动【易城】，展示牌堆顶${revealed.length}张牌` }, { sourceId: ownerId })
    askFirstSwap(host, ownerId, revealed)
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-hand-1') {
      const { revealed } = resolution.data as { revealed: CardId[] }
      const handIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (handIds.length === 0) { finishYicheng(host, ownerId, revealed); return }
      host.askSkill({
        skillId: YICHENG, ownerId, step: 'pick-revealed-1', data: { revealed, handIds },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【易城】：选择${handIds.length}张展示牌交换`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...revealed], hiddenCardSlots: [], min: handIds.length, max: handIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'pick-revealed-1') {
      const { revealed, handIds } = resolution.data as { revealed: CardId[]; handIds: CardId[] }
      const chosen = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => revealed.includes(id))
      if (chosen.length !== handIds.length) { finishYicheng(host, ownerId, revealed); return }
      const s0 = sumRank(host.state, revealed)
      const nextRevealed = revealed.filter((id) => !chosen.includes(id))
      for (const cardId of handIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      for (const cardId of chosen) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      nextRevealed.push(...handIds)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: chosen, reason: YICHENG }, { targetId: ownerId, cardIds: chosen })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: handIds, reason: YICHENG }, { sourceId: ownerId, cardIds: handIds })
      const s1 = sumRank(host.state, nextRevealed)
      host.dispatch('SkillActivated', { skillId: YICHENG, skillName: '易城', playerId: ownerId, logText: `${owner.nickname}发动【易城】，交换${chosen.length}张牌` }, { sourceId: ownerId })
      if (s1 > s0 && owner.zones.hand.length > 0) {
        host.askSkill({
          skillId: YICHENG, ownerId, step: 'second-ask', data: { revealed: nextRevealed },
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: '【易城】：展示牌点数增加，是否用所有手牌交换等量展示牌？', timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: '交换' }, { id: 'no', label: '不交换' }],
          }),
        })
        return
      }
      finishYicheng(host, ownerId, nextRevealed)
      return
    }

    if (resolution.step === 'second-ask') {
      const { revealed } = resolution.data as { revealed: CardId[] }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'yes' || owner.zones.hand.length === 0) { finishYicheng(host, ownerId, revealed); return }
      const n = Math.min(owner.zones.hand.length, revealed.length)
      const handIds = owner.zones.hand.slice(0, n)
      const swapIds = revealed.slice(0, n)
      const rest = revealed.slice(n)
      for (const cardId of handIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
      for (const cardId of swapIds) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      const nextRevealed = [...rest, ...handIds]
      host.dispatch('GainCard', { playerId: ownerId, cardIds: swapIds, reason: YICHENG }, { targetId: ownerId, cardIds: swapIds })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: handIds, reason: YICHENG }, { sourceId: ownerId, cardIds: handIds })
      host.dispatch('SkillActivated', { skillId: YICHENG, skillName: '易城', playerId: ownerId, logText: `${owner.nickname}发动【易城】，用所有手牌交换展示牌` }, { sourceId: ownerId })
      finishYicheng(host, ownerId, nextRevealed)
    }
  },
})

function askFirstSwap(host: SkillHost, ownerId: PlayerId, revealed: CardId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) { finishYicheng(host, ownerId, revealed); return }
  host.askSkill({
    skillId: YICHENG, ownerId, step: 'pick-hand-1', data: { revealed },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: '【易城】：选择任意张手牌与等量展示牌交换', timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(owner.zones.hand.length, revealed.length),
    }),
  })
}

function finishYicheng(host: SkillHost, _ownerId: PlayerId, revealed: CardId[]): void {
  // 逐张插到牌堆顶：倒序处理，让 revealed[0] 最后插入、真正落在最顶端
  for (let index = revealed.length - 1; index >= 0; index -= 1) {
    const cardId = revealed[index]
    if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
}

export const LIUPI: CharacterDefinition = {
  id: 'liupi',
  name: '刘辟',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YICHENG, name: '易城', description: '出牌阶段限一次，若有手牌，展示牌堆顶X张牌（X为体力上限），可用任意张手牌交换等量展示牌；若展示牌点数之和因此增加，可以用所有手牌交换等量展示牌。' },
  ],
}
