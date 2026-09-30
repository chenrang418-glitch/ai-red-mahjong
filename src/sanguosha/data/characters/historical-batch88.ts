import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'

export const MOU_MASU_CHENGCE = 'chengce-mou-masu'
export const MOU_MASU_XINZHAN = 'xin-zhan-mou-masu'

type PendingGuess = { ownerId: PlayerId; targetId: PlayerId; cardId: CardId; expectedResponse: boolean; turnNumber: number }
type MouMaSuState = {
  guesses?: Record<CardId, PendingGuess>
  responded?: Record<CardId, boolean>
  guessedKinds?: Record<PlayerId, { turnNumber: number; slash: boolean; trick: boolean }>
  slashCards?: Record<CardId, PlayerId>
}
const stateOf = (state: SanguoshaState): MouMaSuState => {
  const root = state as SanguoshaState & { paperMouMaSu?: MouMaSuState }
  return root.paperMouMaSu ??= {}
}
const alive = (host: SkillHost, id: PlayerId) => host.state.players.find((player) => player.id === id)?.alive === true
const isDamage = (name: string) => name === '杀' || name === '火杀' || name === '雷杀' || DAMAGE_TRICKS.has(name)
const topCardsOfType = (host: SkillHost, category: 'damage' | 'non-damage', count: number) =>
  host.state.zones.drawPile.filter((id) => {
    const card = host.state.cards[id]
    return card && (category === 'damage' ? isDamage(card.name) : !isDamage(card.name))
  }).slice(0, count)

registerSkillRuntime({
  id: MOU_MASU_CHENGCE,
  triggers: [{ event: 'RoundStart', handle(host, ownerId) {
    if (alive(host, ownerId)) host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'offer', data: { roundNumber: host.state.roundNumber } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【呈策】：是否观看牌堆顶两张牌并进行交换？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动呈策' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'exchange') {
      const top = host.state.zones.drawPile.slice(0, 2)
      const hand = host.state.players.find((player) => player.id === ownerId)?.zones.hand ?? []
      host.askSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'exchange-top', data: { top }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【呈策】：观看并选择牌堆顶中任意张牌，之后以等量手牌替换',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: top, hiddenCardSlots: [], min: 0, max: Math.min(top.length, hand.length),
      }) })
      return
    }
    if (prompt.step === 'exchange-hand') {
      const top = (prompt.data.top as CardId[]).filter((cardId) => host.state.zones.drawPile.includes(cardId))
      const hand = host.state.players.find((player) => player.id === ownerId)?.zones.hand ?? []
      const count = Math.min(top.length, hand.length)
      if (!count) {
        host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'target', data: {} })
        return
      }
      host.askSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'exchange-cards', data: { top }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【呈策】：选择${count}张手牌替换刚才选定的牌堆顶牌（仅你可见）`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: hand, viewOnlyCardIds: top,
        hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (prompt.step === 'target') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId)
      if (!candidates.length || host.state.zones.drawPile.length === 0) return
      host.askSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【呈策】：选择一名其他角色观看牌堆顶两张牌并获得其中一张',
        timeoutMs: 25_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'target-take') {
      const targetId = prompt.data.targetId as PlayerId
      const top = host.state.zones.drawPile.slice(0, 2)
      if (!alive(host, targetId) || !top.length) return
      host.askSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'take-top', data: { targetId, top }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【呈策】：观看牌堆顶两张牌并获得其中一张',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: top, viewOnlyCardIds: top,
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'yes' && alive(host, ownerId))
        host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'exchange', data: {} })
      return
    }
    if (resolution.step === 'exchange-top') {
      const selectedTop = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => (resolution.data.top as CardId[]).includes(cardId) && host.state.zones.drawPile.includes(cardId))
        .slice(0, 2)
      if (selectedTop.length) host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'exchange-hand', data: { top: selectedTop } })
      else host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'exchange-cards') {
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].slice(0, 2)
      const top = (resolution.data.top as CardId[]).filter((id) => host.state.zones.drawPile.includes(id))
      const hand = host.state.players.find((player) => player.id === ownerId)?.zones.hand ?? []
      if (ids.length === top.length) {
        const count = top.length
        for (let i = 0; i < count; i += 1) {
          const handId = ids[i]!
          const topId = top[i]!
          if (!hand.includes(handId) || !host.state.zones.drawPile.includes(topId)) continue
          const index = host.state.zones.drawPile.indexOf(topId)
          moveCard(host.state, topId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          moveCard(host.state, handId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
          const movedIndex = host.state.zones.drawPile.indexOf(handId)
          if (movedIndex >= 0) host.state.zones.drawPile.splice(movedIndex, 1)
          host.state.zones.drawPile.splice(Math.min(index, host.state.zones.drawPile.length), 0, handId)
        }
      }
      host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && targetId !== ownerId && alive(host, targetId))
        host.queueSkill({ skillId: MOU_MASU_CHENGCE, ownerId, step: 'target-take', data: { targetId } })
      return
    }
    if (resolution.step !== 'take-top') return
    const targetId = resolution.data.targetId as PlayerId
    const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const top = resolution.data.top as CardId[]
    if (!picked || !top.includes(picked) || !host.state.zones.drawPile.includes(picked) || !alive(host, targetId)) return
    const name = host.state.cards[picked]?.name ?? ''
    moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [picked], reason: MOU_MASU_CHENGCE }, { sourceId: ownerId, targetId, cardIds: [picked] })
    const type = isDamage(name) ? 'damage' : 'non-damage'
    const reward = topCardsOfType(host, type, 3)
    for (const cardId of reward) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    if (reward.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: reward, reason: MOU_MASU_CHENGCE }, { sourceId: ownerId, targetId: ownerId, cardIds: reward })
    if (type === 'non-damage') replaceTemporarySkill(host.state, targetId, `mou-masu-chengce:${ownerId}`, MOU_MASU_XINZHAN)
    else {
      const hand = host.state.players.find((player) => player.id === targetId)?.zones.hand ?? []
      const nonDamage = host.rng.shuffle(hand.filter((id) => host.state.cards[id] && !isDamage(host.state.cards[id]!.name))).slice(0, 3)
      stateOf(host.state).slashCards ??= {}
      for (const cardId of nonDamage) stateOf(host.state).slashCards![cardId] = targetId
    }
  },
})

registerSkillRuntime({
  id: MOU_MASU_XINZHAN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const cardId = payload.cardId
      const targetIds = payload.targetIds ?? []
      if (!cardId || targetIds.length !== 1 || targetIds[0] === ownerId || !alive(host, ownerId)) return
      const kind = payload.cardName === '杀' || payload.cardName === '火杀' || payload.cardName === '雷杀'
        ? 'slash' : (host.state.cards[cardId]?.category === 'trick' && !['闪电', '乐不思蜀', '兵粮寸断'].includes(payload.cardName ?? '') ? 'trick' : null)
      if (!kind) return
      const state = stateOf(host.state)
      const used = state.guessedKinds ??= {}
      let marks = used[ownerId]
      if (!marks || marks.turnNumber !== host.state.turnNumber) marks = used[ownerId] = { turnNumber: host.state.turnNumber, slash: false, trick: false }
      if (marks[kind]) return
      marks[kind] = true
      host.queueSkill({ skillId: MOU_MASU_XINZHAN, ownerId, step: 'guess', data: { cardId, targetId: targetIds[0], kind, turnNumber: host.state.turnNumber } })
    } },
    { event: 'CardResponded', handle(host, _ownerId, context) {
      const payload = context.event.payload as { slashCardId?: CardId }
      const active = host.state.cardResolution as { kind?: string; cardId?: CardId } | null
      const cardId = payload.slashCardId ?? (active?.kind === 'trick' ? active.cardId : undefined)
      if (cardId && stateOf(host.state).guesses?.[cardId]) stateOf(host.state).responded![cardId] = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const cardId = payload.cardId
      const record = cardId ? stateOf(host.state).guesses?.[cardId] : undefined
      if (!record || record.ownerId !== ownerId) return
      delete stateOf(host.state).guesses![cardId!]
      const wasResponded = stateOf(host.state).responded?.[cardId!] === true
      delete stateOf(host.state).responded?.[cardId!]
      if (record.turnNumber !== host.state.turnNumber || !alive(host, ownerId) || !alive(host, record.targetId)) return
      host.queueSkill({ skillId: MOU_MASU_XINZHAN, ownerId,
        step: record.expectedResponse === wasResponded ? 'correct' : 'wrong', data: { targetId: record.targetId } })
    } },
    { event: 'RoundEnd', handle(host) {
      stateOf(host.state).slashCards = {}
      for (const player of host.state.players) {
        const sources = (player.temporaryGrantedSkills ?? [])
          .filter((entry) => entry.skillId === MOU_MASU_XINZHAN && entry.source.startsWith('mou-masu-chengce:'))
          .map((entry) => entry.source)
        for (const source of sources) replaceTemporarySkill(host.state, player.id, source, null)
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'guess') {
      host.askSkill({ skillId: MOU_MASU_XINZHAN, ownerId, step: 'make-guess', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId,
        prompt: '【心战】：猜测此牌是否会被响应', timeoutMs: 25_000, optional: false,
        options: [{ id: 'responded', label: '会被响应' }, { id: 'not-responded', label: '不会被响应' }],
      }) })
      return
    }
    if (prompt.step === 'correct') {
      const targetId = prompt.data.targetId as PlayerId
      const hand = host.state.players.find((player) => player.id === targetId)?.zones.hand ?? []
      if (!hand.length) return
      host.askSkill({ skillId: MOU_MASU_XINZHAN, ownerId, step: 'take-hand', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【心战】：观看目标手牌并获得其中一张',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: hand, viewOnlyCardIds: hand,
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'wrong') {
      const targetId = prompt.data.targetId as PlayerId
      if (alive(host, ownerId) && alive(host, targetId)) host.beginVirtualTrick({
        sourceId: targetId, targetId: ownerId, cardName: '决斗', sourceSkillId: MOU_MASU_XINZHAN,
      })
    }
  },
  globalViewAs(state, _ownerId, actorId) {
    const tags = stateOf(state).slashCards ?? {}
    return (state.players.find((player) => player.id === actorId)?.zones.hand ?? [])
      .filter((cardId) => tags[cardId] === actorId && state.cards[cardId])
      .map((cardId) => ({ cardId, asCardName: '杀', label: '【呈策】：将此牌当【杀】使用' }))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'make-guess') {
      const data = resolution.data as { cardId: CardId; targetId: PlayerId; turnNumber: number }
      if (data.turnNumber !== host.state.turnNumber || !alive(host, ownerId)) return
      const state = stateOf(host.state)
      state.guesses ??= {}
      state.responded ??= {}
      state.guesses[data.cardId] = { ownerId, targetId: data.targetId,
        cardId: data.cardId, expectedResponse: (response.payload as { optionId?: string }).optionId === 'responded', turnNumber: data.turnNumber }
      delete state.responded[data.cardId]
      return
    }
    if (resolution.step === 'take-hand') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const hand = host.state.players.find((player) => player.id === targetId)?.zones.hand ?? []
      if (picked && hand.includes(picked) && alive(host, ownerId)) {
        moveCard(host.state, picked, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: MOU_MASU_XINZHAN },
          { sourceId: ownerId, targetId: ownerId, cardIds: [picked] })
      }
    }
  },
})

export const MOU_MASU_B88: CharacterDefinition = {
  id: 'mou-masu-b88', name: '谋·马谡', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: MOU_MASU_CHENGCE, name: '呈策', description: '每轮开始时，你可观看牌堆顶2张牌并用任意张手牌替换其中等量牌，然后你令一名其他角色观看牌堆顶2张牌并获得其中1张。若其获得的牌为非伤害牌，你获得3张非伤害牌，其获得“心战”直到本轮结束；若其获得的牌为伤害牌，你获得3张伤害牌，其随机3张非伤害手牌视为〖杀〗直到本轮结束。' },
    { id: MOU_MASU_XINZHAN, name: '心战', description: '你每回合首次使用〖杀〗或普通锦囊牌指定其他角色为唯一目标时，可各猜测一次此牌是否被响应。此牌结算完毕后，若你猜对，观看此牌目标的手牌并获得其中1张；若你猜错，其视为对你使用〖决斗〗。' },
  ],
}

export const HISTORICAL_BATCH88_CHARACTERS: readonly CharacterDefinition[] = [MOU_MASU_B88]
