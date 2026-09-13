import { moveCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, DistributeCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蔡邕（三国杀 OL 经典身份 SP）。
 *
 * 【辟撰】：你使用黑桃牌，或成为其他角色使用黑桃牌的目标后，可以将牌堆顶
 *          1张牌置于武将牌上，称为"书"（至多4张）；手牌上限+书的数量。
 * 【通博】：摸牌阶段结束后，可以用任意张自己的牌替换等量的"书"；若替换后
 *          书恰好集齐黑桃/红桃/梅花/方块四种花色，将所有书分配给任意名
 *          其他角色。
 */

const PIZHUAN = 'pizhuan'
const TONGBO = 'tongbo'
const PILE = 'book'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bookOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[PILE] ?? []
}

function offerBook(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || bookOf(host.state, ownerId).length >= 4 || host.state.zones.drawPile.length === 0) return
  host.queueSkill({ skillId: PIZHUAN, ownerId, step: 'ask', data: {} })
}

registerSkillRuntime({
  id: PIZHUAN,
  maxCardsBonus(state, ownerId) { return bookOf(state, ownerId).length },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId || host.state.cards[payload.cardId]?.suit !== 'spade') return
        offerBook(host, ownerId)
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || context.event.sourceId === ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        if (!payload.cardId || host.state.cards[payload.cardId]?.suit !== 'spade') return
        offerBook(host, ownerId)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: PIZHUAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【辟撰】：是否将牌堆顶1张牌置于武将牌上？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (bookOf(host.state, ownerId).length >= 4 || host.state.zones.drawPile.length === 0) return
    const cardId = host.state.zones.drawPile[0]
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
    host.dispatch('SkillActivated', { skillId: PIZHUAN, skillName: '辟撰', playerId: ownerId, logText: `${owner.nickname}发动【辟撰】，获得1张"书"` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: TONGBO,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || bookOf(host.state, ownerId).length === 0) return
      host.queueSkill({ skillId: TONGBO, ownerId, step: 'pick-own', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-own') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const max = Math.min(owner.zones.hand.length, bookOf(host.state, ownerId).length)
    if (max <= 0) return
    host.askSkill({
      skillId: TONGBO, ownerId, step: 'pick-own', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【通博】：选择至多${max}张自己的牌替换等量的"书"`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-own') {
      const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner?.zones.hand.includes(id))
      if (!owner?.alive || picked.length === 0) return
      const book = bookOf(host.state, ownerId)
      const n = Math.min(picked.length, book.length)
      if (n <= 0) return
      host.askSkill({
        skillId: TONGBO, ownerId, step: 'pick-book', data: { picked: picked.slice(0, n) },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【通博】：选择${n}张"书"换回来`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: book, hiddenCardSlots: [], min: n, max: n,
        }),
      })
      return
    }
    if (resolution.step === 'pick-book') {
      const { picked } = resolution.data as { picked: CardId[] }
      const bookPicked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => bookOf(host.state, ownerId).includes(id))
      if (!owner?.alive || bookPicked.length !== picked.length) return
      for (const cardId of picked) {
        if (!owner.zones.hand.includes(cardId)) continue
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
      }
      for (const cardId of bookPicked) {
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'hand', playerId: ownerId })
      }
      host.dispatch('GainCard', { playerId: ownerId, cardIds: bookPicked, reason: TONGBO }, { targetId: ownerId, cardIds: bookPicked })
      host.dispatch('SkillActivated', { skillId: TONGBO, skillName: '通博', playerId: ownerId, logText: `${owner.nickname}发动【通博】，替换了${picked.length}张"书"` }, { sourceId: ownerId })
      const book = bookOf(host.state, ownerId)
      const suits = new Set(book.map((id) => host.state.cards[id]?.suit).filter(Boolean))
      if (book.length === 4 && suits.size === 4) {
        const recipientIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (recipientIds.length === 0) return
        host.askSkill({
          skillId: TONGBO, ownerId, step: 'distribute', data: { book },
          build: (requestId): DistributeCardsRequest => ({
            id: requestId, kind: 'distribute-cards', playerId: ownerId,
            prompt: '【通博】："书"集齐四种花色，全部分配给其他角色', timeoutMs: 20_000, optional: false,
            cardIds: book, recipientIds, min: book.length, max: book.length,
          }),
        })
      }
      return
    }
    if (resolution.step === 'distribute') {
      const { book } = resolution.data as { book: CardId[] }
      const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
      const currentBook = new Set(bookOf(host.state, ownerId))
      const byRecipient = new Map<PlayerId, CardId[]>()
      for (const entry of assignments) {
        if (!entry?.cardId || !entry.recipientId || entry.recipientId === ownerId) continue
        if (!currentBook.has(entry.cardId) || !book.includes(entry.cardId)) continue
        if (!playerOf(host.state, entry.recipientId)?.alive) continue
        byRecipient.set(entry.recipientId, [...(byRecipient.get(entry.recipientId) ?? []), entry.cardId])
      }
      const assigned = new Set([...byRecipient.values()].flat())
      // 没被分配到的书兜底交给第一名候选者，保证"全部分给其他角色"不留剩余
      const leftover = book.filter((id) => currentBook.has(id) && !assigned.has(id))
      if (leftover.length > 0) {
        const fallbackId = [...byRecipient.keys()][0] ?? host.state.players.find((candidate) => candidate.alive && candidate.id !== ownerId)?.id
        if (fallbackId) byRecipient.set(fallbackId, [...(byRecipient.get(fallbackId) ?? []), ...leftover])
      }
      for (const [recipientId, cardIds] of byRecipient) {
        for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'hand', playerId: recipientId })
        host.dispatch('GainCard', { playerId: recipientId, cardIds, reason: TONGBO }, { sourceId: ownerId, targetId: recipientId, cardIds })
      }
    }
  },
})

export const CAIYONG: CharacterDefinition = {
  id: 'caiyong',
  name: '蔡邕',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: PIZHUAN, name: '辟撰', description: '你使用黑桃牌，或成为其他角色使用黑桃牌的目标后，可以将牌堆顶1张牌置于武将牌上，称为"书"（至多4张）；手牌上限+书的数量。' },
    { id: TONGBO, name: '通博', description: '摸牌阶段结束后，可以用任意张自己的牌替换等量的"书"；若替换后书恰好集齐四种花色，将所有书分配给任意名其他角色。' },
  ],
}
