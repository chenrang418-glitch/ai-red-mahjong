import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { resolveDamage } from '../../engine/damage'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const SHIYU = 'wangyuanji-shiyu'
const LVJIAN = 'wangyuanji-lvjian'
const CATEGORIES: CardCategory[] = ['basic', 'trick', 'equipment']
type GuessState = { round: number; targetId: PlayerId; guesses: CardCategory[]; used: boolean }
type RoundUsage = { round: number; used: number; limit: number }
type WState = SanguoshaState & {
  wangyuanjiGuesses?: Record<PlayerId, GuessState>
  wangyuanjiRoundUsage?: Record<PlayerId, RoundUsage>
  wangyuanjiTurnCards?: Record<PlayerId, { round: number; categories: CardCategory[] }>
  wangyuanjiProtection?: Record<PlayerId, Record<PlayerId, { round: number; count: number }>>
}

function player(state: SanguoshaState, id: PlayerId) {
  return state.players.find((candidate) => candidate.id === id)
}

function usage(state: SanguoshaState, ownerId: PlayerId): RoundUsage {
  const s = state as WState
  s.wangyuanjiRoundUsage ??= {}
  const current = s.wangyuanjiRoundUsage[ownerId]
  if (!current || current.round !== state.roundNumber) {
    return (s.wangyuanjiRoundUsage[ownerId] = { round: state.roundNumber, used: 0, limit: 1 })
  }
  return current
}

function askGuess(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  host.askSkill({
    skillId: SHIYU, ownerId, step: 'invoke', data: { targetId },
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【识预】：是否猜测${player(host.state, targetId)?.nickname ?? '该角色'}本回合会使用的牌类别？`,
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动【识预】' }, { id: 'no', label: '不发动' }],
    }),
  })
}

function askGuessCategories(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  host.askSkill({
    skillId: SHIYU, ownerId, step: 'guess', data: { targetId, round: host.state.roundNumber },
    build: (id): ChooseOptionsRequest => ({
      id, kind: 'choose-options', playerId: ownerId,
      prompt: '【识预】：秘密选择你猜测本回合会被使用的牌类别（未选即猜测不会使用）',
      timeoutMs: 20_000, optional: false,
      options: CATEGORIES.map((category) => ({ id: category, label: category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌' })),
      min: 0, max: CATEGORIES.length,
    }),
  })
}

function addProtection(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId): void {
  const s = state as WState
  s.wangyuanjiProtection ??= {}
  s.wangyuanjiProtection[ownerId] ??= {}
  const entry = s.wangyuanjiProtection[ownerId]![sourceId]
  if (entry?.round === state.roundNumber) entry.count += 1
  else s.wangyuanjiProtection[ownerId]![sourceId] = { round: state.roundNumber, count: 1 }
}

function takeProtection(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId): boolean {
  const protections = (state as WState).wangyuanjiProtection?.[ownerId]
  const entry = protections?.[sourceId]
  if (!entry || entry.round !== state.roundNumber || entry.count <= 0) return false
  entry.count -= 1
  return true
}

function hasProtection(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId): boolean {
  const entry = (state as WState).wangyuanjiProtection?.[ownerId]?.[sourceId]
  return Boolean(entry && entry.round === state.roundNumber && entry.count > 0)
}

function processForecast(host: SkillHost, ownerId: PlayerId, stateData: { targetId: PlayerId; guesses: CardCategory[]; round: number; index?: number; correctCount?: number }): void {
  const owner = player(host.state, ownerId)
  const target = player(host.state, stateData.targetId)
  if (!owner?.alive || !target?.alive || stateData.round !== host.state.roundNumber) return
  const index = stateData.index ?? 0
  if (index >= CATEGORIES.length) {
    if ((stateData.correctCount ?? 0) === CATEGORIES.length) {
      const current = usage(host.state, ownerId)
      current.limit += 1
    }
    return
  }
  const category = CATEGORIES[index]!
  const actual = (host.state as WState).wangyuanjiTurnCards?.[stateData.targetId]
  const wasUsed = actual?.round === stateData.round && actual.categories.includes(category)
  const predicted = stateData.guesses.includes(category)
  const next = { ...stateData, index: index + 1, correctCount: (stateData.correctCount ?? 0) + (wasUsed === predicted ? 1 : 0) }

  if (wasUsed === predicted) {
    addProtection(host.state, ownerId, stateData.targetId)
    const pickable = pickableCardsOf(host.state, stateData.targetId, { includeJudgingArea: true })
    if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) {
      processForecast(host, ownerId, next)
      return
    }
    host.askSkill({
      skillId: SHIYU, ownerId, step: 'gain-correct', data: { ...next, targetId: stateData.targetId },
      build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId,
        prompt: `【识预】：猜对${category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌'}，获得${target.nickname}一张牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }),
    })
    return
  }

  host.dispatch('SkillActivated', {
    skillId: SHIYU, skillName: '识预', playerId: ownerId, targetId: stateData.targetId,
    logText: `${owner.nickname}发动【识预】猜错牌类别`,
  }, { sourceId: ownerId, targetId: stateData.targetId })
  resolveDamage(host, { sourceId: ownerId, targetId: stateData.targetId, amount: 1, sourceSkillId: SHIYU })
  if (player(host.state, ownerId)?.alive && player(host.state, stateData.targetId)?.alive) {
    resolveDamage(host, { sourceId: stateData.targetId, targetId: ownerId, amount: 1, sourceSkillId: SHIYU })
  }
  processForecast(host, ownerId, next)
}

function highestCountTargets(state: SanguoshaState, area: 'hand' | 'equipment'): PlayerId[] {
  const alive = state.players.filter((candidate) => candidate.alive)
  const counts = alive.map((candidate) => area === 'hand'
    ? candidate.zones.hand.length
    : Object.values(candidate.zones.equipment).filter(Boolean).length)
  const maximum = Math.max(0, ...counts)
  if (maximum === 0) return []
  return alive.filter((candidate) => (area === 'hand'
    ? candidate.zones.hand.length
    : Object.values(candidate.zones.equipment).filter(Boolean).length) === maximum).map(({ id }) => id)
}

function selectedAreaCards(state: SanguoshaState, targetId: PlayerId, area: 'hand' | 'equipment'): CardId[] {
  const target = player(state, targetId)
  if (!target) return []
  return area === 'hand' ? [...target.zones.hand] : Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
}

function neededDiscardCount(state: SanguoshaState, targetId: PlayerId, area: 'hand' | 'equipment'): number {
  const target = player(state, targetId)
  if (!target) return 0
  const value = (candidate: typeof target) => area === 'hand'
    ? candidate.zones.hand.length
    : Object.values(candidate.zones.equipment).filter(Boolean).length
  const others = state.players.filter((candidate) => candidate.alive && candidate.id !== targetId).map(value)
  if (!others.length) return 0
  return Math.max(0, value(target) - Math.max(...others) + 1)
}

function askRateTarget(host: SkillHost, ownerId: PlayerId, area: 'hand' | 'equipment'): void {
  const targets = highestCountTargets(host.state, area)
  if (!targets.length) return
  host.askSkill({
    skillId: LVJIAN, ownerId, step: 'rate-discard-target', data: { area },
    build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId,
      prompt: `【率俭】：选择手牌数／装备数最多的角色，令其弃置至不再为全场最多`,
      timeoutMs: 20_000, optional: false, candidateIds: targets, min: 1, max: 1,
    }),
  })
}

function askDrawTarget(host: SkillHost, ownerId: PlayerId, area: 'hand' | 'equipment', amount: number): void {
  if (amount <= 0) return
  const candidates = host.state.players.filter((candidate) => candidate.alive).map(({ id }) => id)
  if (!candidates.length) return
  host.askSkill({
    skillId: LVJIAN, ownerId, step: 'rate-draw-target', data: { area, amount },
    build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId,
      prompt: area === 'hand' ? `【率俭】：令一名角色摸${amount}张牌` : `【率俭】：令一名角色回复${amount}点体力`,
      timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: SHIYU,
  preventsDamage(state, ownerId, side, context) {
    return side === 'target' && context.targetId === ownerId && context.sourceId !== null
      && hasProtection(state, ownerId, context.sourceId)
  },
  onDamagePrevented(host, ownerId, side, context) {
    if (side === 'target' && context.sourceId) takeProtection(host.state, ownerId, context.sourceId)
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      const s = host.state as WState
      s.wangyuanjiRoundUsage ??= {}
      s.wangyuanjiRoundUsage[ownerId] = { round: host.state.roundNumber, used: 0, limit: 1 }
      if (s.wangyuanjiProtection?.[ownerId]) delete s.wangyuanjiProtection[ownerId]
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const owner = player(host.state, ownerId)
      if (!targetId) return
      const s = host.state as WState
      s.wangyuanjiTurnCards ??= {}
      s.wangyuanjiTurnCards[targetId] = { round: host.state.roundNumber, categories: [] }
      if (targetId === ownerId || !owner?.alive) return
      const current = usage(host.state, ownerId)
      if (current.used >= current.limit) return
      askGuess(host, ownerId, targetId)
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const targetId = context.event.sourceId
      if (!targetId) return
      const category = cardCategoryOfName(payload.cardName) ?? (payload.cardId ? host.state.cards[payload.cardId]?.category : null)
      if (!category) return
      const s = host.state as WState
      s.wangyuanjiTurnCards ??= {}
      const entry = s.wangyuanjiTurnCards[targetId]
      if (!entry || entry.round !== host.state.roundNumber) s.wangyuanjiTurnCards[targetId] = { round: host.state.roundNumber, categories: [category] }
      else if (!entry.categories.includes(category)) entry.categories.push(category)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const s = host.state as WState
      const pending = s.wangyuanjiGuesses?.[ownerId]
      if (!targetId || !pending?.used || pending.targetId !== targetId || pending.round !== host.state.roundNumber) return
      delete s.wangyuanjiGuesses![ownerId]
      host.queueSkill({ skillId: SHIYU, ownerId, step: 'resolve-forecast', data: { targetId, guesses: pending.guesses, round: pending.round } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'resolve-forecast') processForecast(host, ownerId, prompt.data as { targetId: PlayerId; guesses: CardCategory[]; round: number })
  },
  resume(host, ownerId, resolution, response) {
    const s = host.state as WState
    if (resolution.step === 'invoke') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !player(host.state, targetId)?.alive) return
      usage(host.state, ownerId).used += 1
      const owner = player(host.state, ownerId)
      host.dispatch('SkillActivated', { skillId: SHIYU, skillName: '识预', playerId: ownerId, targetId, logText: `${owner?.nickname ?? '王元姬'}发动【识预】` }, { sourceId: ownerId, targetId })
      s.wangyuanjiGuesses ??= {}
      s.wangyuanjiGuesses[ownerId] = { round: host.state.roundNumber, targetId, guesses: [], used: true }
      askGuessCategories(host, ownerId, targetId)
      return
    }
    if (resolution.step === 'guess') {
      const { targetId, round } = resolution.data as { targetId: PlayerId; round: number }
      const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
      if (!player(host.state, targetId)?.alive || round !== host.state.roundNumber) return
      s.wangyuanjiGuesses ??= {}
      s.wangyuanjiGuesses[ownerId] = { round, targetId, guesses: CATEGORIES.filter((category) => optionIds.includes(category)), used: true }
      return
    }
    if (resolution.step === 'gain-correct') {
      const data = resolution.data as { targetId: PlayerId; round: number; guesses: CardCategory[]; index: number; correctCount: number }
      const target = player(host.state, data.targetId)
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const realId = picked && target ? resolvePickedCard(host.state, data.targetId, picked) : null
      if (realId && target && movePickedCard(host, data.targetId, realId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('LoseCard', { playerId: data.targetId, cardIds: [realId], reason: SHIYU }, { sourceId: data.targetId, cardIds: [realId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: SHIYU }, { sourceId: data.targetId, targetId: ownerId, cardIds: [realId] })
      }
      processForecast(host, ownerId, data)
      return
    }
  },
})

registerSkillRuntime({
  id: LVJIAN,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (playerId === ownerId) askRateChoice(host, ownerId)
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (playerId === ownerId) askRateChoice(host, ownerId)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'rate-choice') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'hand' || option === 'equipment') askRateTarget(host, ownerId, option)
      return
    }
    if (resolution.step === 'rate-discard-target') {
      const { area } = resolution.data as { area: 'hand' | 'equipment' }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      const amount = neededDiscardCount(host.state, targetId, area)
      const cards = selectedAreaCards(host.state, targetId, area)
      if (amount <= 0 || amount > cards.length) return
      host.askSkill({
        skillId: LVJIAN, ownerId, step: 'rate-discard', data: { area, targetId, amount },
        build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: targetId,
          prompt: `【率俭】：弃置${amount}张${area === 'hand' ? '手牌' : '装备区的牌'}`,
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: amount, max: amount,
        }),
      })
      return
    }
    if (resolution.step === 'rate-discard') {
      const { area, targetId, amount } = resolution.data as { area: 'hand' | 'equipment'; targetId: PlayerId; amount: number }
      const target = player(host.state, targetId)
      if (!target?.alive) return
      const chosen = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => selectedAreaCards(host.state, targetId, area).includes(cardId)).slice(0, amount)
      let discarded = 0
      for (const cardId of chosen) {
        if (!movePickedCard(host, targetId, cardId, { kind: 'discardPile' })) continue
        discarded += 1
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: LVJIAN }, { sourceId: targetId, cardIds: [cardId] })
      }
      if (discarded) askDrawTarget(host, ownerId, area, discarded)
      return
    }
    if (resolution.step === 'rate-draw-target') {
      const { area, amount } = resolution.data as { area: 'hand' | 'equipment'; amount: number }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !player(host.state, targetId)?.alive) return
      if (area === 'hand') drawCards(host.state, host.rng, targetId, amount, (name, payload) => host.dispatch(name, payload))
      else recover(host, targetId, amount, ownerId)
    }
  },
})

function askRateChoice(host: SkillHost, ownerId: PlayerId): void {
  if (!player(host.state, ownerId)?.alive) return
  const available = (['hand', 'equipment'] as const).filter((area) => highestCountTargets(host.state, area).length > 0)
  if (!available.length) return
  host.askSkill({
    skillId: LVJIAN, ownerId, step: 'rate-choice', data: {},
    build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【率俭】：选择一项执行，或取消', timeoutMs: 20_000, optional: true,
      options: [
        ...(available.includes('hand') ? [{ id: 'hand', label: '令手牌数最多的角色弃牌，然后令一名角色摸等量牌' }] : []),
        ...(available.includes('equipment') ? [{ id: 'equipment', label: '令装备数最多的角色弃牌，然后令一名角色回复等量体力' }] : []),
      ],
    }),
  })
}

export const CURRENT_WANGYUANJI: CharacterDefinition = {
  id: 'wangyuanji', name: '王元姬', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp',
  skills: [
    { id: SHIYU, name: '识预', description: '每轮限一次，其他角色的回合开始时，你可秘密猜测每种类型的牌本回合内是否被该角色使用，其回合结束时，你每猜对一种，获得其1张牌并防止其本轮下次对你造成的伤害；每猜错一种，你与其依次对对方造成1点伤害。若你全部猜对，本轮此技能可使用次数+1。' },
    { id: LVJIAN, name: '率俭', description: '你的回合开始和结束时，你可以选择一项执行：1.令手牌数最多的一名角色将手牌弃置至不为全场最多，然后你令一名角色摸弃牌数张牌；2.令装备区牌数最多的一名角色将装备区牌弃置至不为全场最多，然后你令一名角色回复弃牌数点体力。' },
  ],
}
