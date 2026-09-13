import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 袁姬（三国杀 OL 经典身份 SP）。
 *
 * 【节言】：一名角色一次性恰好失去2张手牌后，袁姬可以发动：袁姬从牌堆一端
 *          摸1张，该角色从另一端摸1张，均展示；若两张牌花色不同，本回合
 *          【节言】失效。
 * 【镜花】：锁定技，每轮开始时摸2张牌，记为"镜花牌"；自己回合开始时，仍
 *          持有的"镜花牌"置于牌堆底。
 * 【水月】：锁定技，自己回合结束时摸2张牌，记为"水月牌"；每轮结束（下一次
 *          RoundStart）时，仍持有的"水月牌"按记录顺序置于牌堆顶。
 */

const JIEYAN = 'jieyan'
const JINGHUA = 'jinghua'
const SHUIYUE = 'shuiyue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function jieyanDisabled(state: SanguoshaState, ownerId: PlayerId): boolean {
  return playerOf(state, ownerId)?.marks[JIEYAN + '-disabled-turn'] === state.turnNumber
}

registerSkillRuntime({
  id: JIEYAN,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      if (jieyanDisabled(host.state, ownerId)) return
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const targetId = payload.playerId
      if (!targetId || targetId === ownerId || (payload.cardIds?.length ?? 0) !== 2) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || host.state.zones.drawPile.length < 2) return
      host.queueSkill({ skillId: JIEYAN, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    host.askSkill({
      skillId: JIEYAN, ownerId, step: 'end-pick', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【节言】：是否发动？选择你摸牌的一端', timeoutMs: 20_000, optional: true,
        options: [{ id: 'top', label: '牌堆顶' }, { id: 'bottom', label: '牌堆底' }, { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'end-pick') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const end = (response.payload as { optionId?: string }).optionId
    if (!owner?.alive || !target?.alive || (end !== 'top' && end !== 'bottom') || host.state.zones.drawPile.length < 2) return
    const drawPile = host.state.zones.drawPile
    const ownerCardId = end === 'top' ? drawPile[0] : drawPile[drawPile.length - 1]
    moveCard(host.state, ownerCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [ownerCardId], reason: JIEYAN }, { targetId: ownerId, cardIds: [ownerCardId] })
    const drawPile2 = host.state.zones.drawPile
    const targetCardId = end === 'top' ? drawPile2[drawPile2.length - 1] : drawPile2[0]
    moveCard(host.state, targetCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [targetCardId], reason: JIEYAN }, { targetId, cardIds: [targetCardId] })
    host.dispatch('CardMove', { cardIds: [ownerCardId, targetCardId], reason: JIEYAN, revealed: true }, { sourceId: ownerId, targetId })
    host.dispatch('SkillActivated', { skillId: JIEYAN, skillName: '节言', playerId: ownerId, logText: `${owner.nickname}发动【节言】` }, { sourceId: ownerId, targetId })
    const suit1 = host.state.cards[ownerCardId]?.suit
    const suit2 = host.state.cards[targetCardId]?.suit
    if (suit1 !== suit2) owner.marks[JIEYAN + '-disabled-turn'] = host.state.turnNumber
  },
})

registerSkillRuntime({
  id: JINGHUA,
  triggers: [{
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      host.state.yuanjiJinghua = { ownerId, cardIds: drawn }
      host.dispatch('SkillActivated', { skillId: JINGHUA, skillName: '镜花', playerId: ownerId, logText: `${owner.nickname}发动【镜花】，摸2张牌` }, { sourceId: ownerId })
    },
  }, {
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const entry = host.state.yuanjiJinghua
      if (!entry || entry.ownerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const remaining = entry.cardIds.filter((id) => owner.zones.hand.includes(id))
      host.state.yuanjiJinghua = undefined
      for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
      if (remaining.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds: remaining, reason: JINGHUA }, { sourceId: ownerId, cardIds: remaining })
    },
  }],
})

registerSkillRuntime({
  id: SHUIYUE,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.state.yuanjiShuiyue ??= []
      host.state.yuanjiShuiyue.push({ roundNumber: host.state.roundNumber, cardIds: drawn })
      host.dispatch('SkillActivated', { skillId: SHUIYUE, skillName: '水月', playerId: ownerId, logText: `${owner.nickname}发动【水月】，摸2张牌` }, { sourceId: ownerId })
    },
  }, {
    event: 'RoundStart',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      const list = host.state.yuanjiShuiyue
      if (!owner?.alive || !list || list.length === 0) return
      const newRound = (context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber
      const due = list.filter((entry) => entry.roundNumber < newRound)
      if (due.length === 0) return
      host.state.yuanjiShuiyue = list.filter((entry) => entry.roundNumber >= newRound)
      const cardIds = due.flatMap((entry) => entry.cardIds).filter((id) => owner.zones.hand.includes(id))
      if (cardIds.length === 0) return
      for (let index = cardIds.length - 1; index >= 0; index -= 1) {
        moveCard(host.state, cardIds[index], { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: SHUIYUE }, { sourceId: ownerId, cardIds })
    },
  }],
})

export const YUANJI: CharacterDefinition = {
  id: 'yuanji',
  name: '袁姬',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JIEYAN, name: '节言', description: '一名角色一次性恰好失去2张手牌后，你可以发动：你从牌堆一端摸1张，其从另一端摸1张，均展示；若两张牌花色不同，本回合【节言】失效。' },
    { id: JINGHUA, name: '镜花', description: '锁定技，每轮开始时摸2张牌；自己回合开始时，仍持有的这些牌置于牌堆底。' },
    { id: SHUIYUE, name: '水月', description: '锁定技，自己回合结束时摸2张牌；每轮结束时，仍持有的这些牌置于牌堆顶。' },
  ],
}
