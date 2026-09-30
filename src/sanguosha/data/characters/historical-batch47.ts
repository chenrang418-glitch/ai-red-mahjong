import { drawCards } from '../../engine/draw'
import { resolveDamage, resumeDamageModifier } from '../../engine/damage'
import { isTargetProhibited, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { newDiscardEntries } from '../../engine/discard-provenance'
import { reshuffleDrawPile } from '../../engine/deck'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { flipCharacter } from '../../engine/character-state'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { executeUseCardAction } from '../../engine/cards/basic'
import { useAction } from '../../engine/cards/host'
import { moveCard } from '../../engine/zones'
import { canPindian, claimPindianCards, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { forgetTurnDiscardedCard, hasTurnCardCategory } from '../../engine/turn-card-categories'
import { locateOwnedCard } from '../../engine/zones'
import { skipPhase } from '../../engine/turn'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards } from '../../engine/private-zone'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { getCharacter, skillIdsOf } from './standard'
import { TRICK_CARD_INFO } from '../ruleset-v1/card-info'

const B = '-b47'
const JINGCE = `jingce${B}`
const DANSHOU = `danshou${B}`
const ZONGXUAN = `zongxuan${B}`
const ZHIYAN = `zhiyan${B}`
const JUNXING = `junxing${B}`
const YUCE = `yuce${B}`
const XUNYI = `xunyi${B}`
const XUNYI_MARK = `xunyi-mark${B}`
const ZHENKONG = `zhenkong${B}`
const QIUYUAN = `qiuyuan${B}`
const ZHENKONG_CONTINUATION = `${ZHENKONG}:settle`
const ZHENKONG_ROUND_MARK = `${ZHENKONG}:round`
const DINGPIN = `dingpin${B}`
const FAEN = `faen${B}`
const DINGPIN_JUDGE = `${DINGPIN}:judge`
const JULIA = `juliao${B}`
const TAOMIE = `taomie${B}`
const TAOMIE_MARK = `${TAOMIE}:mark`
const QIAOSHUO = `qiaoshuo${B}`
const ZONGSHI = `zongshi-jianyong${B}`
const QIAOSHUO_TAG = `${QIAOSHUO}:pindian`
const QIAOSHUO_BONUS = `${QIAOSHUO}:bonus`
const QIAOSHUO_FAILED = `${QIAOSHUO}:failed`
const YUFENG = `yufeng-nanhua${B}`
const TIANSU = `tianshu-nanhua${B}`
const TAIPING_EQUIPMENT = 'taiping-yaoshu'
const WINDFLIGHT_MARK = `${YUFENG}:skip`
const WINDFLIGHT_LEVEL = `${YUFENG}:level`
const WINDFLIGHT_LENGTH = 18
const WINDFLIGHT_OBSTACLES = [3, 6, 9, 12, 15, 18]
const WINDFLIGHT_STARS = [2, 6, 11, 16]
const ZONGXUAN_CURSOR = `${ZONGXUAN}:cursor`
const JINGCE_COUNT_MARK = `${JINGCE}:count`
const JINGCE_TURN_MARK = `${JINGCE}:turn`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function countUsedDiscardCards(state: SanguoshaState, ownerId: PlayerId) {
  const owner = playerOf(state, ownerId)
  return owner?.marks[JINGCE_TURN_MARK] === state.turnNumber ? owner.marks[JINGCE_COUNT_MARK] ?? 0 : 0
}

function recordJingceDiscard(state: SanguoshaState, ownerId: PlayerId) {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  if (owner.marks[JINGCE_TURN_MARK] !== state.turnNumber) {
    owner.marks[JINGCE_TURN_MARK] = state.turnNumber
    owner.marks[JINGCE_COUNT_MARK] = 0
  }
  owner.marks[JINGCE_COUNT_MARK] = (owner.marks[JINGCE_COUNT_MARK] ?? 0) + 1
}

registerSkillRuntime({
  id: JINGCE,
  triggers: [
    {
      event: 'CardResolved',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; virtual?: boolean }
        if (context.event.sourceId !== ownerId || !payload.cardId || payload.virtual) return
        if (host.state.zones.discardPile.includes(payload.cardId)) recordJingceDiscard(host.state, ownerId)
      },
    },
    {
      event: 'CardEnteredDiscard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; reason?: string }
        if (payload.playerId !== ownerId || payload.reason !== 'response' || !payload.cardId) return
        if (host.state.zones.discardPile.includes(payload.cardId)) recordJingceDiscard(host.state, ownerId)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.playerId !== ownerId || payload.phase !== 'finish') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || countUsedDiscardCards(host.state, ownerId) < owner.hp) return
        host.askSkill({
          skillId: JINGCE, ownerId, step: 'draw',
          build: (id): ChooseOptionRequest => ({
            id, kind: 'choose-option', playerId: ownerId, prompt: '【精策】：是否摸两张牌？',
            timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' }],
          }),
        })
      },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'draw' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  },
})

function recordTargeting(host: SkillHost, ownerId: PlayerId, activePlayerId: PlayerId) {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  const countMark = `${DANSHOU}:count:${activePlayerId}`
  const turnMark = `${DANSHOU}:turn:${activePlayerId}`
  if (owner.marks[turnMark] !== host.state.turnNumber) {
    owner.marks[turnMark] = host.state.turnNumber
    owner.marks[countMark] = 0
  }
  owner.marks[countMark] = (owner.marks[countMark] ?? 0) + 1
}

function targetingCountByMarks(state: SanguoshaState, ownerId: PlayerId, activePlayerId: PlayerId) {
  const owner = playerOf(state, ownerId)
  if (owner?.marks[`${DANSHOU}:turn:${activePlayerId}`] !== state.turnNumber) return 0
  return owner.marks[`${DANSHOU}:count:${activePlayerId}`] ?? 0
}

registerSkillRuntime({
  id: DANSHOU,
  triggers: [
    {
      event: 'TargetSpecified',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { targetIds?: PlayerId[]; cardId?: CardId }
        const activePlayerId = context.event.sourceId
        if (!activePlayerId || activePlayerId === ownerId || !payload.cardId || !payload.targetIds?.includes(ownerId)) return
        if (host.state.currentPlayerId !== activePlayerId) return
        recordTargeting(host, ownerId, activePlayerId)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        const activePlayerId = payload.playerId
        if (!activePlayerId || activePlayerId === ownerId || payload.phase !== 'finish') return
        if (host.state.currentPlayerId !== activePlayerId) return
        const owner = playerOf(host.state, ownerId)
        const targetCount = targetingCountByMarks(host.state, ownerId, activePlayerId)
        if (!owner?.alive) return
        if (targetCount === 0) {
          drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
          return
        }
        const pickable = pickableCardsOf(host.state, ownerId)
        const available = pickable.cardIds.length + pickable.hiddenCardSlots.length
        if (available < targetCount) return
        host.askSkill({
          skillId: DANSHOU, ownerId, step: 'discard', data: { activePlayerId, targetCount },
          build: (id): ChooseCardsRequest => ({
            id, kind: 'choose-cards', playerId: ownerId,
            prompt: `【胆守】：是否弃置${targetCount}张牌，对${playerOf(host.state, activePlayerId)?.nickname ?? '该角色'}造成1点伤害？`,
            timeoutMs: 20_000, optional: true, purpose: 'skill', ...pickable,
            min: targetCount, max: targetCount,
          }),
        })
      },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const { activePlayerId, targetCount } = resolution.data as { activePlayerId: PlayerId; targetCount: number }
    const selected = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
    if (selected.length !== targetCount || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, activePlayerId)?.alive) return
    for (const selection of selected) {
      const cardId = resolvePickedCard(host.state, ownerId, selection)
      if (!cardId) return
    }
    for (const selection of selected) {
      const cardId = resolvePickedCard(host.state, ownerId, selection)
      if (cardId) movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })
    }
    resolveDamage(host as never, { sourceId: ownerId, targetId: activePlayerId, amount: 1, nature: 'normal', cardName: null })
  },
})

export const B47_GUOHUAI: CharacterDefinition = {
  id: 'guohuai-jie-b47', name: '界·郭淮', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: JINGCE, name: '精策', description: '结束阶段，若此回合内因使用或打出而置入弃牌堆的牌数量不小于你的体力值，则你可以摸两张牌。' }],
}

export const B47_ZHU_RAN: CharacterDefinition = {
  id: 'zhuran-jie-b47', name: '界·朱然', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: DANSHOU, name: '胆守', description: '其他角色的结束阶段，若你本回合未成为过其使用牌的目标，你摸一张牌；否则你可以弃置X张牌对其造成1点伤害（X为你本回合成为其使用牌的目标次数）。' }],
}

function advanceZongxuanCursor(state: SanguoshaState, ownerId: PlayerId) {
  const owner = playerOf(state, ownerId)
  if (owner) owner.marks[ZONGXUAN_CURSOR] = state.seq
}

registerSkillRuntime({
  id: ZONGXUAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && !usedThisPhase(state, ownerId, ZONGXUAN)
      ? [{ id: ZONGXUAN, label: '纵玄：摸一张牌，然后将一张手牌置于牌堆顶' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZONGXUAN || usedThisPhase(host.state, ownerId, ZONGXUAN)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    markUsedThisPhase(host.state, ownerId, ZONGXUAN)
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const updatedOwner = playerOf(host.state, ownerId)
    if (!updatedOwner?.alive || updatedOwner.zones.hand.length === 0) return
    host.askSkill({
      skillId: ZONGXUAN, ownerId, step: 'place-top',
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【纵玄】：选择一张手牌置于牌堆顶', timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: [...updatedOwner.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }),
    })
  },
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      host.queueSkill({ skillId: ZONGXUAN, ownerId, step: 'redirect', data: { cursor: playerOf(host.state, ownerId)?.marks[ZONGXUAN_CURSOR] ?? 0 } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'redirect') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cursor = owner.marks[ZONGXUAN_CURSOR] ?? 0
    const candidates = newDiscardEntries(host.state, cursor, (entry) => entry.reason === 'discard' && entry.ownerId === ownerId)
    if (!candidates.length) { advanceZongxuanCursor(host.state, ownerId); return }
    host.askSkill({ skillId: ZONGXUAN, ownerId, step: 'redirect',
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【纵玄】：按选择顺序将任意张此次因弃置进入弃牌堆的牌置于牌堆顶',
        timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: candidates.length }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'place-top') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && owner?.zones.hand.includes(cardId)) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    if (resolution.step !== 'redirect') return
    advanceZongxuanCursor(host.state, ownerId)
    if (!owner?.alive) return
    const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => host.state.zones.discardPile.includes(cardId))
    for (const cardId of [...picked].reverse()) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'drawPile' }, { toTop: true })
  },
})

registerSkillRuntime({
  id: ZHIYAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'finish') host.queueSkill({ skillId: ZHIYAN, ownerId, step: 'target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target' || !playerOf(host.state, ownerId)?.alive) return
    const candidateIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: ZHIYAN, ownerId, step: 'target',
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【直言】：选择一名角色，其摸一张牌并展示', timeoutMs: 20_000, optional: true, candidateIds, min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    const recipientId = target.id
    if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    const cardId = host.state.zones.drawPile[0]
    if (!cardId) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { playerId: recipientId, cardIds: [cardId], reason: ZHIYAN, revealed: true }, { sourceId: ownerId, targetId: recipientId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: recipientId })
    host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: ZHIYAN }, { targetId: recipientId, cardIds: [cardId] })
    const revealedCard = host.state.cards[cardId]
    if (revealedCard?.category !== 'equipment') return
    const action = useAction(cardId, recipientId, revealedCard.name, [], '')
    if (action.kind !== 'use-card') return
    executeUseCardAction(host as never, recipientId, action)
    recover(host as never, recipientId, 1, ZHIYAN)
  },
})

export const B47_YU_FAN: CharacterDefinition = {
  id: 'yufan-jie-b47', name: '界·虞翻', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: ZONGXUAN, name: '纵玄', description: '当你的牌因弃置而置入弃牌堆后，你可以将其中任意张牌置于牌堆顶。出牌阶段限一次，你可以摸一张牌然后将一张牌置于牌堆顶。' },
    { id: ZHIYAN, name: '直言', description: '结束阶段，你可以令一名角色摸一张牌并展示之，若此牌为装备牌，则该角色使用此牌，然后其回复1点体力。' },
  ],
}

function discardableCardIds(state: SanguoshaState, playerId: PlayerId) {
  return pickableCardsOf(state, playerId)
}

registerSkillRuntime({
  id: JUNXING,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && !usedThisPhase(state, ownerId, JUNXING)
      ? [{ id: JUNXING, label: '峻刑：弃置任意张手牌并令一名其他角色选择' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JUNXING || usedThisPhase(host.state, ownerId, JUNXING)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({ skillId: JUNXING, ownerId, step: 'cost',
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【峻刑】：弃置任意张手牌（可不弃）', timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisPhase(host.state, ownerId, JUNXING)) return
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner.zones.hand.includes(cardId))
      const chosenTargets = host.state.players.filter((player) => player.alive && player.id !== ownerId)
      if (!chosenTargets.length || cardIds.length !== ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).length) return
      for (const cardId of cardIds) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JUNXING }, { sourceId: ownerId, cardIds: [cardId] })
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      }
      markUsedThisPhase(host.state, ownerId, JUNXING)
      host.askSkill({ skillId: JUNXING, ownerId, step: 'target', data: { cardCount: cardIds.length },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【峻刑】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds: chosenTargets.map((player) => player.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const cardCount = resolution.data.cardCount as number
      const options = [{ id: 'turn-draw', label: `翻面，然后摸${cardCount}张牌` }]
      if (discardableCardIds(host.state, target.id).cardIds.length + discardableCardIds(host.state, target.id).hiddenCardSlots.length >= cardCount) {
        options.unshift({ id: 'discard-lose-hp', label: `弃置${cardCount}张牌并失去1点体力` })
      }
      host.askSkill({ skillId: JUNXING, ownerId, step: 'choice', data: { targetId, cardCount },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: target.id,
          prompt: '【峻刑】：选择一项', timeoutMs: 20_000, optional: false, options }) })
      return
    }
    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      const cardCount = resolution.data.cardCount as number
      if (optionId === 'turn-draw') {
        flipCharacter(host as never, targetId, JUNXING, !target.faceDown)
        drawCards(host.state, host.rng, targetId, cardCount, (name, payload) => host.dispatch(name, payload))
        return
      }
      if (optionId !== 'discard-lose-hp') return
      const pickable = discardableCardIds(host.state, targetId)
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length < cardCount) return
      host.askSkill({ skillId: JUNXING, ownerId, step: 'target-discard', data: { targetId, cardCount },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
          prompt: `【峻刑】：弃置${cardCount}张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', ...pickable, min: cardCount, max: cardCount }) })
      return
    }
    if (resolution.step === 'target-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const cardCount = resolution.data.cardCount as number
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const selected = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
      if (selected.length !== cardCount || selected.some((id) => !resolvePickedCard(host.state, targetId, id))) return
      for (const selection of selected) {
        const cardId = resolvePickedCard(host.state, targetId, selection)
        if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
      }
      loseHp(host as never, targetId, 1, JUNXING)
    }
  },
})

registerSkillRuntime({
  id: YUCE,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      host.queueSkill({ skillId: YUCE, ownerId, step: 'show-card', data: { sourceId: context.event.sourceId ?? null } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'show-card') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length) return
    host.askSkill({ skillId: YUCE, ownerId, step: 'show-card', data: prompt.data,
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【御策】：是否展示一张手牌？', timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'show-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const category = host.state.cards[cardId]?.category
      if (!category) return
      const sourceId = resolution.data.sourceId as PlayerId | null
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!source?.alive) { recover(host as never, ownerId, 1, YUCE); return }
      const eligible = source.zones.hand.filter((candidate) => host.state.cards[candidate]?.category !== category)
      if (!eligible.length) { recover(host as never, ownerId, 1, YUCE); return }
      host.askSkill({ skillId: YUCE, ownerId, step: 'source-discard', data: { sourceId, category },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: source.id,
          prompt: '【御策】：是否弃置一张类别与展示牌不同的手牌，以阻止满宠回复体力？',
          timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'source-discard') return
    const sourceId = resolution.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    const picked = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const legal = picked && source?.alive && source.zones.hand.includes(picked)
      && host.state.cards[picked]?.category !== resolution.data.category
    if (legal) {
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: [picked], reason: YUCE }, { sourceId, cardIds: [picked] })
      moveCard(host.state, picked, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
    } else if (owner?.alive) recover(host as never, ownerId, 1, YUCE)
  },
})

export const B47_MANCHONG: CharacterDefinition = {
  id: 'manchong-jie-b47', name: '界·满宠', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: JUNXING, name: '峻刑', description: '出牌阶段限一次，你可以弃置任意张手牌并选择一名其他角色，然后令其选择一项：1.弃置等量牌并失去1点体力；2.翻面，然后摸等量的牌。' },
    { id: YUCE, name: '御策', description: '当你受到伤害后，你可以展示一张手牌。若如此做，除非伤害来源弃置与你展示的牌类别不同的一张手牌，否则你回复1点体力。' },
  ],
}

function xunyiPartner(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.find((player) => player.alive && player.id !== ownerId && player.marks[XUNYI_MARK] > 0)
}

function xunyiMarkedPlayer(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.find((player) => player.id !== ownerId && player.marks[XUNYI_MARK] > 0)
}

function queueXunyiDiscard(host: SkillHost, ownerId: PlayerId, playerId: PlayerId, remaining: number) {
  const player = playerOf(host.state, playerId)
  if (!player?.alive || discardableCardIds(host.state, playerId).cardIds.length + discardableCardIds(host.state, playerId).hiddenCardSlots.length === 0) return
  host.askSkill({ skillId: XUNYI, ownerId, step: 'discard-partner-card', data: { playerId, remaining },
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
      prompt: `【殉义】：弃置一张牌（剩余${remaining}次）`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', ...discardableCardIds(host.state, playerId), min: 1, max: 1 }) })
}

registerSkillRuntime({
  id: XUNYI,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        if (host.state.players.filter((player) => player.alive && player.id !== ownerId).length)
          host.queueSkill({ skillId: XUNYI, ownerId, step: 'choose-partner', data: {} })
      },
    },
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        const partner = xunyiPartner(host.state, ownerId)
        const amount = (context.event.payload as { amount?: number }).amount ?? 0
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        if (!partner || amount < 1) return
        if (sourceId === ownerId && targetId !== partner.id) {
          drawCards(host.state, host.rng, partner.id, amount, (name, payload) => host.dispatch(name, payload))
        } else if (sourceId === partner.id && targetId !== ownerId) {
          drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
        }
        if (targetId === ownerId && sourceId !== partner.id) {
          host.queueSkill({ skillId: XUNYI, ownerId, step: 'partner-discard', data: { playerId: partner.id, amount } })
          return
        }
        if (targetId === partner.id && sourceId !== ownerId) {
          host.queueSkill({ skillId: XUNYI, ownerId, step: 'owner-discard', data: { playerId: ownerId, amount } })
        }
      },
    },
    {
      event: 'Death',
      handle(host, ownerId, context) {
        const deadId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
        const partner = xunyiMarkedPlayer(host.state, ownerId)
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !partner || partner.id !== deadId) return
        partner.marks[XUNYI_MARK] = 0
        const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
        if (!candidateIds.length) return
        host.queueSkill({ skillId: XUNYI, ownerId, step: 'move-mark', data: { candidateIds } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-partner' || prompt.step === 'move-mark') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = prompt.step === 'move-mark'
        ? (prompt.data.candidateIds as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive && id !== ownerId)
        : host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: XUNYI, ownerId, step: prompt.step, data: prompt.data,
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: prompt.step === 'choose-partner' ? '【殉义】：选择一名其他角色获得“义”标记' : '【殉义】：是否将“义”标记移动给一名其他角色？',
          timeoutMs: 20_000, optional: true, candidateIds, min: 1, max: 1 }) })
      return
    }
    if (prompt.step === 'partner-discard' || prompt.step === 'owner-discard') {
      const playerId = prompt.data.playerId as PlayerId
      queueXunyiDiscard(host, ownerId, playerId, prompt.data.amount as number)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-partner' || resolution.step === 'move-mark') {
      const [partnerId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const partner = partnerId ? playerOf(host.state, partnerId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !partner?.alive || partnerId === ownerId) return
      for (const candidate of host.state.players) if (candidate.marks[XUNYI_MARK]) candidate.marks[XUNYI_MARK] = 0
      partner.marks[XUNYI_MARK] = 1
      return
    }
    if (resolution.step !== 'discard-partner-card') return
    const { playerId, remaining } = resolution.data as { playerId: PlayerId; remaining: number }
    const player = playerOf(host.state, playerId)
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && player?.alive ? resolvePickedCard(host.state, playerId, selected) : null
    if (!player?.alive || !cardId || !movePickedCard(host as never, playerId, cardId, { kind: 'discardPile' })) return
    if (remaining > 1) queueXunyiDiscard(host, ownerId, playerId, remaining - 1)
  },
})

export const B47_WANGFU_ZHAOLEI: CharacterDefinition = {
  id: 'wangfu-zhaolei-b47', name: '王甫赵累', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: XUNYI, name: '殉义', description: '游戏开始时，你选择一名其他角色，令其获得“义”标记。当你/其受到1点伤害后（伤害来源不为其/你），其/你弃置1张牌；当你/其对除其/你以外的角色造成1点伤害后，其/你摸1张牌。当拥有“义”标记的角色死亡时，你可移动此标记。' }],
}

registerPindianContinuation(ZHENKONG_CONTINUATION, (pindianHost, result) => {
  const { ownerId, targetId, turnNumber } = result.data as { ownerId: PlayerId; targetId: PlayerId; turnNumber: number }
  const owner = playerOf(pindianHost.state, ownerId)
  const target = playerOf(pindianHost.state, targetId)
  if (!owner?.alive || !target?.alive) return
  if (result.outcome === 'initiator-win') {
    owner.marks[`${ZHENKONG}:lock:${targetId}`] = turnNumber
    return
  }
  const gained = claimPindianCards(pindianHost, ownerId, [result.opponentCardId])
  if (!gained.length || !target.alive || !owner.alive) return
  ;(pindianHost as unknown as SkillHost).beginVirtualSlash({
    sourceId: targetId, targetId: ownerId, sourceSkillId: ZHENKONG, countUsage: true,
  })
})

registerSkillRuntime({
  id: ZHENKONG,
  triggers: [{
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId || target.hp < owner.hp
        || !canPindian(host.state, ownerId) || !canPindian(host.state, target.id)
        || owner.marks[ZHENKONG_ROUND_MARK] === host.state.roundNumber) return
      host.queueSkill({ skillId: ZHENKONG, ownerId, step: 'ask-pindian', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-pindian' || !playerOf(host.state, ownerId)?.alive) return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    host.askSkill({ skillId: ZHENKONG, ownerId, step: 'ask-pindian', data: { targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【惴恐】：是否与${target.nickname}拼点？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '拼点' }, { id: 'no', label: '不发动' }] }) })
  },
  globalProhibitsSourceTarget(state, ownerId, sourceId, targetId) {
    const owner = playerOf(state, ownerId)
    return !!owner?.alive && sourceId !== targetId && owner.marks[`${ZHENKONG}:lock:${sourceId}`] === state.turnNumber
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask-pindian' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)
      || owner.marks[ZHENKONG_ROUND_MARK] === host.state.roundNumber) return
    owner.marks[ZHENKONG_ROUND_MARK] = host.state.roundNumber
    startPindian(host as never, {
      id: `zhenkong-${host.state.seq}-${ownerId}-${targetId}`, initiatorId: ownerId, opponentId: targetId,
      reason: ZHENKONG, continuationTag: ZHENKONG_CONTINUATION,
      data: { ownerId, targetId, turnNumber: host.state.turnNumber },
    })
  },
})

registerSkillRuntime({
  id: QIUYUAN,
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId) return false
    const current = host.state.cardResolution
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || current?.kind !== 'slash' || current.targetId !== ownerId) return false
    const alreadyTargeted = new Set([current.sourceId, current.targetId, ...(current.resolvedTargetIds ?? []), ...current.remainingTargetIds])
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && !alreadyTargeted.has(candidate.id)
      && !isTargetProhibited(host.state, current.sourceId, candidate.id, '杀', skillIdsOf, current.cardId)).map((candidate) => candidate.id)
    if (!candidateIds.length) return false
    host.askSkill({ skillId: QIUYUAN, ownerId, step: 'helper', data: { sourceId: current.sourceId },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【求援】：选择另一名角色；其交给你一张非【杀】的基本牌可令其不成为此【杀】目标',
        timeoutMs: 20_000, optional: true, candidateIds, min: 1, max: 1 }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const slash = host.state.cardResolution
    if (resolution.step === 'helper') {
      const helperId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!helperId || slash?.kind !== 'slash' || !playerOf(host.state, helperId)?.alive) { host.resumeCardTarget(); return }
      const helper = playerOf(host.state, helperId)!
      const eligible = helper.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'basic' && host.state.cards[cardId]?.name !== '杀')
      if (!eligible.length) {
        slash.remainingTargetIds.push(helperId)
        host.resumeCardTarget()
        return
      }
      host.askSkill({ skillId: QIUYUAN, ownerId, step: 'give-basic', data: { helperId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: helperId,
          prompt: `【求援】：是否交给${playerOf(host.state, ownerId)?.nickname ?? '伏皇后'}一张非【杀】的基本牌？`,
          timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'give-basic') return
    const helperId = resolution.data.helperId as PlayerId
    const helper = playerOf(host.state, helperId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const validCard = selected && helper?.alive && helper.zones.hand.includes(selected)
      && host.state.cards[selected]?.category === 'basic' && host.state.cards[selected]?.name !== '杀'
    if (validCard) {
      moveCard(host.state, selected, { kind: 'hand', playerId: helperId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: helperId, cardIds: [selected], reason: QIUYUAN }, { sourceId: helperId, targetId: ownerId, cardIds: [selected] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: QIUYUAN }, { sourceId: helperId, targetId: ownerId, cardIds: [selected] })
    } else if (slash?.kind === 'slash' && helper?.alive && !slash.remainingTargetIds.includes(helperId)) {
      slash.remainingTargetIds.push(helperId)
    }
    host.resumeCardTarget()
  },
})

export const B47_FU_HUANGHOU: CharacterDefinition = {
  id: 'fuhuanghou-jie-b47', name: '界·伏皇后', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: ZHENKONG, name: '惴恐', description: '每轮限一次，其他角色的回合开始时，若其体力值不小于你，你可与其拼点。若你赢，其本回合无法使用牌指定除其以外的角色为目标；若你没赢，你获得其拼点的牌，然后其视为对你使用一张普通【杀】。' },
    { id: QIUYUAN, name: '求援', description: '当你成为【杀】的目标时，你可以选择另一名其他角色。除非该角色交给你一张【杀】以外的基本牌，否则其也成为此【杀】的目标。' },
  ],
}

registerJudgmentContinuation(DINGPIN_JUDGE, (judgmentHost, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const targetId = data.targetId as PlayerId
  const costCardId = data.costCardId as CardId
  const owner = playerOf(judgmentHost.state, ownerId)
  const target = playerOf(judgmentHost.state, targetId)
  if (judged.suit === 'heart') {
    forgetTurnDiscardedCard(judgmentHost.state, ownerId, costCardId)
    return
  }
  if (judged.suit === 'diamond') {
    if (owner?.alive) flipCharacter(judgmentHost as never, ownerId, DINGPIN, !owner.faceDown)
    return
  }
  if (!target?.alive || !owner?.alive) return
  const historyKey = `${DINGPIN}:black-target:${targetId}`
  owner.marks[historyKey] = judgmentHost.state.turnNumber
  drawCards(judgmentHost.state, (judgmentHost as unknown as SkillHost).rng, targetId, Math.min(3, Math.max(0, target.hp)), (name, payload) => judgmentHost.dispatch(name, payload))
})

registerSkillRuntime({
  id: DINGPIN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner?.alive) return []
    const available = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .some((cardId) => {
        const category = state.cards[cardId]?.category
        return !!category && !hasTurnCardCategory(state, ownerId, category)
      })
    return available ? [{ id: DINGPIN, label: '定品：弃置一张未使用或弃置过类别的牌并令一名角色判定' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== DINGPIN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((cardId) => {
        const category = host.state.cards[cardId]?.category
        return !!category && !hasTurnCardCategory(host.state, ownerId, category)
      })
    if (!cardIds.length) return
    const candidateIds = host.state.players.filter((target) => target.alive
      && owner.marks[`${DINGPIN}:black-target:${target.id}`] !== host.state.turnNumber).map((target) => target.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: DINGPIN, ownerId, step: 'cost', data: { candidateIds },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【定品】：弃置一张本回合未使用或弃置过类别的牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const owner = playerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const location = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      const card = cardId ? host.state.cards[cardId] : null
      if (!owner?.alive || !cardId || !location || (location.kind !== 'hand' && location.kind !== 'equipment')
        || !card || hasTurnCardCategory(host.state, ownerId, card.category)) return
      const candidateIds = (resolution.data.candidateIds as PlayerId[]).filter((id) => {
        const target = playerOf(host.state, id)
        return target?.alive && owner.marks[`${DINGPIN}:black-target:${id}`] !== host.state.turnNumber
      })
      if (!candidateIds.length) return
      moveCard(host.state, cardId, location, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: DINGPIN }, { sourceId: ownerId, cardIds: [cardId] })
      host.askSkill({ skillId: DINGPIN, ownerId, step: 'target', data: { costCardId: cardId, candidateIds },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【定品】：选择一名角色进行判定', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const costCardId = resolution.data.costCardId as CardId
    if (!owner?.alive || !target?.alive || !(resolution.data.candidateIds as PlayerId[]).includes(targetId!)
      || owner.marks[`${DINGPIN}:black-target:${targetId}`] === host.state.turnNumber) return
    const validTargetId = target.id
    performJudgment(host as never, validTargetId, DINGPIN, { tag: DINGPIN_JUDGE, data: { ownerId, targetId: validTargetId, costCardId } })
  },
})

registerSkillRuntime({
  id: FAEN,
  triggers: [
    { event: 'CharacterFlip', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.targetId
      if (targetId && playerOf(host.state, targetId)?.alive) host.queueSkill({ skillId: FAEN, ownerId, step: 'draw-target', data: { targetId } })
    } },
    { event: 'CharacterChained', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.targetId
      if (targetId && playerOf(host.state, targetId)?.alive) host.queueSkill({ skillId: FAEN, ownerId, step: 'draw-target', data: { targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw-target') return
    const owner = playerOf(host.state, ownerId)
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    host.askSkill({ skillId: FAEN, ownerId, step: 'draw-target', data: { targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【法恩】：是否令${target.nickname}摸一张牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '令其摸一张牌' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'draw-target' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
  },
})

export const B47_CHEN_QUN: CharacterDefinition = {
  id: 'chenqun-jie-b47', name: '界·陈群', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: DINGPIN, name: '定品', description: '出牌阶段，你可以弃置一张牌（不能是你本回合使用或弃置过的类型）并选择一名角色，令其进行判定，若结果为：黑色，该角色摸X张牌（X为当前体力值且最大为3），然后你于此回合内不能对其发动“定品”；红桃，你此次发动定品弃置的牌不计入弃置过的类型；方块，你翻面。' },
    { id: FAEN, name: '法恩', description: '当一名角色翻面或铁索连环后，你可以令其摸一张牌。' },
  ],
}

const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])
const ALL_TRICK_NAMES = new Set(TRICK_CARD_INFO.map((card) => card.name))
const NORMAL_TRICK_NAMES = new Set([...ALL_TRICK_NAMES].filter((name) => !DELAYED_TRICK_NAMES.has(name)))
registerPindianContinuation(QIAOSHUO_TAG, (_host, result) => {
  const owner = playerOf(_host.state, result.initiatorId)
  if (!owner?.alive) return
  owner.marks[QIAOSHUO_BONUS] = result.outcome === 'initiator-win' ? 1 : 0
  owner.marks[QIAOSHUO_FAILED] = result.outcome === 'initiator-win' ? 0 : 1
})

registerSkillRuntime({
  id: QIAOSHUO,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && playerOf(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, QIAOSHUO) && canPindian(state, ownerId)
      ? [{ id: QIAOSHUO, label: '巧说：与一名角色拼点' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QIAOSHUO || usedThisPhase(host.state, ownerId, QIAOSHUO)) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId && canPindian(host.state, target.id)).map((target) => target.id)
    if (!candidates.length) return
    host.askSkill({ skillId: QIAOSHUO, ownerId, step: 'pindian-target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【巧说】：选择一名有手牌的其他角色进行拼点', timeoutMs: 20_000, optional: false,
        candidateIds: candidates, min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pindian-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    markUsedThisPhase(host.state, ownerId, QIAOSHUO)
    startPindian(host as never, { id: `${QIAOSHUO}:${host.state.seq}`, initiatorId: ownerId,
      opponentId: targetId, reason: QIAOSHUO, continuationTag: QIAOSHUO_TAG })
  },
  modifiesNextCardTargets(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.marks[QIAOSHUO_BONUS] === 1
  },
  prohibitsCardUse(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    return context.userId === ownerId && owner?.marks[QIAOSHUO_FAILED] === 1
      && ALL_TRICK_NAMES.has(context.cardName)
  },
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const category = payload.cardId ? host.state.cards[payload.cardId]?.category : undefined
      if (category === 'basic' || (category === 'trick' && NORMAL_TRICK_NAMES.has(payload.cardName ?? ''))) {
        const owner = playerOf(host.state, ownerId)
        if (owner) delete owner.marks[QIAOSHUO_BONUS]
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (owner) { delete owner.marks[QIAOSHUO_BONUS]; delete owner.marks[QIAOSHUO_FAILED] }
    } },
  ],
})

registerSkillRuntime({
  id: ZONGSHI,
  triggers: [{ event: 'PindianEnd', handle(host, ownerId, context) {
    const result = context.event.payload as { initiatorId: PlayerId; opponentId: PlayerId; initiatorCardId: CardId; opponentCardId: CardId; initiatorRank: number; opponentRank: number }
    if (result.initiatorId !== ownerId && result.opponentId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.pendingRequests.length > 0) return
    const eligible = result.initiatorRank < result.opponentRank ? [result.initiatorCardId]
      : result.opponentRank < result.initiatorRank ? [result.opponentCardId]
        : [result.initiatorCardId, result.opponentCardId]
    const held = eligible.filter((cardId) => host.state.zones.processingArea.includes(cardId))
    if (!held.length) return
    const zoneId = `${ZONGSHI}:${ownerId}:${host.state.seq}`
    openPrivateZone(host.state, zoneId, ownerId, 'pindian')
    for (const cardId of held) moveIntoPrivateZone(host.state, cardId, { kind: 'processingArea' }, zoneId)
    reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    const topId = host.state.zones.drawPile[0]
    if (topId) moveIntoPrivateZone(host.state, topId, { kind: 'drawPile' }, zoneId)
    const choices = [...held, ...(topId ? [topId] : [])]
    if (!choices.length) return
    host.askSkill({ skillId: ZONGSHI, ownerId, step: 'choose-gain', data: { held, topId: topId ?? null, zoneId },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【纵适】：获得牌堆顶牌或点数较小的拼点牌（可不获得）', timeoutMs: 20_000,
        optional: true, purpose: 'skill', cardIds: choices, hiddenCardSlots: [], min: 0, max: 1 }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-gain') return
    const held = resolution.data.held as CardId[]
    const topId = resolution.data.topId as CardId | null
    const zoneId = resolution.data.zoneId as string
    const choice = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const all = [...held, ...(topId ? [topId] : [])]
    const validChoice = choice && playerOf(host.state, ownerId)?.alive && all.includes(choice)
      && privateZoneCards(host.state, zoneId).includes(choice) ? choice : null
    for (const cardId of all) {
      if (!privateZoneCards(host.state, zoneId).includes(cardId)) continue
      if (cardId === validChoice) moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'hand', playerId: ownerId })
      else if (cardId === topId) {
        moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'drawPile' })
        const index = host.state.zones.drawPile.lastIndexOf(cardId)
        if (index >= 0) host.state.zones.drawPile.splice(index, 1)
        host.state.zones.drawPile.unshift(cardId)
      } else moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'discardPile' })
    }
    closePrivateZone(host.state, zoneId)
    if (validChoice) host.dispatch('GainCard', { playerId: ownerId, cardIds: [validChoice], reason: ZONGSHI }, { targetId: ownerId, cardIds: [validChoice] })
  },
})

export const B47_JIANYONG: CharacterDefinition = {
  id: 'jianyong-b47', name: '界·简雍', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: QIAOSHUO, name: '巧说', description: '出牌阶段限一次，你可以与一名角色拼点：若你赢，本阶段你使用下一张基本牌或普通锦囊牌可以多选择或少选择一个目标（无距离限制）；若你没赢，你本阶段不能使用锦囊牌。' },
    { id: ZONGSHI, name: '纵适', description: '当你拼点后，你观看牌堆顶的一张牌，并可以选择一项：获得牌堆顶的这张牌，或获得两张拼点牌中点数较小的一张。' },
  ],
}

function windFlightRequest(host: SkillHost, ownerId: PlayerId, flight: Record<string, any>): void {
  const gapFrame = (flight.obstacles as number[]).find((frame) => frame >= flight.frame + 1) ?? WINDFLIGHT_LENGTH
  const starFrame = WINDFLIGHT_STARS.find((frame) => frame >= flight.frame + 1 && flight.stars[String(frame)] !== undefined) ?? 0
  const options = [
    { id: 'flap', label: '拍翼上升' },
    { id: 'glide', label: '滑翔下落' },
  ]
  host.askSkill({ skillId: YUFENG, ownerId, step: 'flight', data: flight,
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
      prompt: `【御风】：第${flight.frame + 1}/${WINDFLIGHT_LENGTH}拍，避开山岩并收集星星`, timeoutMs: 30_000,
      optional: false, options, interaction: { kind: 'nanhua-flight', frame: flight.frame,
        courseLength: WINDFLIGHT_LENGTH, altitude: Math.max(0, Math.min(4, Math.round(flight.y))), score: flight.score,
        maxScore: flight.maxScore, nextObstacleFrame: gapFrame, gapRow: flight.gaps[String(gapFrame)],
        nextStarFrame: starFrame, starRow: starFrame ? flight.stars[String(starFrame)] : -1 } }) })
}

function endWindFlight(host: SkillHost, ownerId: PlayerId, flight: Record<string, any>, success: boolean): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (!success) {
    owner.marks[WINDFLIGHT_LEVEL] = 1
    if (flight.score > 0) drawCards(host.state, host.rng, ownerId, flight.score, (name, payload) => host.dispatch(name, payload))
    host.dispatch('SkillActivated', { skillId: YUFENG, playerId: ownerId, result: 'flight-failed', score: flight.score,
      logText: `南华老仙【御风】飞行失败，获得${flight.score}分并摸${flight.score}张牌` }, { sourceId: ownerId })
    return
  }
  owner.marks[WINDFLIGHT_LEVEL] = Math.min(3, Math.max(1, owner.marks[WINDFLIGHT_LEVEL] ?? 1) + 1)
  host.dispatch('SkillActivated', { skillId: YUFENG, playerId: ownerId, result: 'flight-success', score: flight.score,
    logText: `南华老仙【御风】飞行成功，获得${flight.score}分` }, { sourceId: ownerId })
  const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
  host.askSkill({ skillId: YUFENG, ownerId, step: 'targets', data: { score: flight.score },
    build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: `【御风】：选择至多${flight.score}名其他角色，其下个准备阶段进行判定；未分配分数改为摸牌`,
      timeoutMs: 30_000, optional: true, candidateIds: candidates, min: 0, max: Math.min(flight.score, candidates.length) }) })
}

registerSkillRuntime({
  id: YUFENG,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && playerOf(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, YUFENG)
      ? [{ id: YUFENG, label: '御风：开始飞行' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YUFENG || usedThisPhase(host.state, ownerId, YUFENG)) return
    markUsedThisPhase(host.state, ownerId, YUFENG)
    const level = Math.min(3, Math.max(1, playerOf(host.state, ownerId)?.marks[WINDFLIGHT_LEVEL] ?? 1))
    const gaps: Record<string, number> = {}
    const stars: Record<string, number> = {}
    const obstacles = WINDFLIGHT_OBSTACLES.slice(0, 3 + level)
    for (const frame of obstacles) gaps[String(frame)] = 1 + host.rng.nextInt(3)
    for (const frame of WINDFLIGHT_STARS.slice(0, level)) stars[String(frame)] = host.rng.nextInt(5)
    windFlightRequest(host, ownerId, { frame: 0, y: 2, velocity: 0, score: 0, maxScore: level, gaps, stars, obstacles })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const score = Math.max(0, Number(resolution.data.score ?? 0))
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const selected = [...new Set(targetIds)].filter((targetId) => targetId !== ownerId && playerOf(host.state, targetId)?.alive).slice(0, score)
      for (const targetId of selected) {
        const target = playerOf(host.state, targetId)!
        target.marks[`${WINDFLIGHT_MARK}:${ownerId}`] = 1
      }
      const remainder = score - selected.length
      if (remainder > 0 && playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, remainder, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step !== 'flight') return
    const flight = resolution.data as Record<string, any>
    const option = (response.payload as { optionId?: string }).optionId
    if (option !== 'flap' && option !== 'glide') return
    let velocity = option === 'flap' ? -0.82 : Math.min(1.15, Number(flight.velocity) + 0.26)
    const y = Number(flight.y) + velocity
    const frame = Number(flight.frame) + 1
    const row = Math.round(y)
    let score = Number(flight.score)
    const collidedWithBoundary = y < 0 || y > 4
    const hitRock = (flight.obstacles as number[]).includes(frame) && row !== Number(flight.gaps[String(frame)])
    if (!collidedWithBoundary && !hitRock && WINDFLIGHT_STARS.includes(frame) && row === Number(flight.stars[String(frame)])) score += 1
    const updated = { ...flight, frame, y, velocity, score }
    if (collidedWithBoundary || hitRock) { endWindFlight(host, ownerId, updated, false); return }
    if (frame >= WINDFLIGHT_LENGTH) { endWindFlight(host, ownerId, updated, score > 0); return }
    windFlightRequest(host, ownerId, updated)
  },
  triggers: [{ event: 'PhaseStart', allowDeadOwner: true, priority: 100,
    handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.phase !== 'judge' || !phase.playerId) return
      const target = playerOf(host.state, phase.playerId)
      const key = `${WINDFLIGHT_MARK}:${ownerId}`
      if (!target?.marks[key]) return
      target.marks[key] = 0
      performJudgment(host as never, target.id, YUFENG, { tag: `${YUFENG}:skip`, data: { ownerId, targetId: target.id } })
    } }],
})

registerJudgmentContinuation(`${YUFENG}:skip`, (judgmentHost, judged, data) => {
  const targetId = data.targetId as PlayerId
  const target = playerOf(judgmentHost.state, targetId)
  if (!target?.alive) return
  if (judged.color === 'black') {
    skipPhase(judgmentHost.state, 'play')
    skipPhase(judgmentHost.state, 'discard')
  } else skipPhase(judgmentHost.state, 'draw')
})

function taipingInPile(state: SanguoshaState): CardId | null {
  return [...state.zones.drawPile, ...state.zones.discardPile].find((cardId) => state.cards[cardId]?.name === '太平要术') ?? null
}

function taipingCanBeCreatedOrReused(state: SanguoshaState): boolean {
  if (taipingInPile(state)) return true
  const activeCardIds = [
    ...state.zones.processingArea,
    ...(state.privateZones ?? []).flatMap((zone) => zone.cards),
    ...state.players.flatMap((player) => [
      ...player.zones.hand,
      ...Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
      ...player.zones.judgingArea,
    ]),
  ]
  return !activeCardIds.some((cardId) => state.cards[cardId]?.name === '太平要术')
}

function taipingCard(host: SkillHost): CardId {
  const existingId = taipingInPile(host.state)
  if (existingId) {
    const card = host.state.cards[existingId]
    card.specialEquipment = TAIPING_EQUIPMENT
    card.equipmentSlot = 'armor'
    return existingId
  }
  const cardId = `${TAIPING_EQUIPMENT}:${host.state.seq}`
  host.state.cards[cardId] = { id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard',
    name: '太平要术', suit: 'heart', rank: 3, color: 'red', category: 'equipment', equipmentSlot: 'armor',
    specialEquipment: TAIPING_EQUIPMENT, sourceSkillId: TIANSU }
  host.state.zones.processingArea.push(cardId)
  return cardId
}

registerSkillRuntime({
  id: TIANSU,
  triggers: [{ event: 'PhaseStart', priority: 90, handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play' || usedThisPhase(host.state, ownerId, TIANSU)
      || !taipingCanBeCreatedOrReused(host.state) || !playerOf(host.state, ownerId)?.alive) return
    const pickable = pickableCardsOf(host.state, ownerId)
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
    markUsedThisPhase(host.state, ownerId, TIANSU)
    host.queueSkill({ skillId: TIANSU, ownerId, step: 'confirm', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'confirm') return
    host.askSkill({ skillId: TIANSU, ownerId, step: 'confirm', data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【天书】：是否弃置一张牌令一名角色获得并使用【太平要术】？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动天书' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'confirm') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !playerOf(host.state, ownerId)?.alive || !taipingCanBeCreatedOrReused(host.state)) return
      const pickable = pickableCardsOf(host.state, ownerId)
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
      host.askSkill({ skillId: TIANSU, ownerId, step: 'cost', data: {},
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【天书】：弃置一张牌', timeoutMs: 20_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'cost') {
      const selection = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selection ? resolvePickedCard(host.state, ownerId, selection) : null
      const location = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      if (!cardId || !location || !playerOf(host.state, ownerId)?.alive || !taipingCanBeCreatedOrReused(host.state)) return
      moveCard(host.state, cardId, location, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: TIANSU }, { sourceId: ownerId, cardIds: [cardId] })
      const candidateIds = host.state.players.filter((target) => target.alive && equipmentSlotsOf(host.state, target.id).includes('armor')).map((target) => target.id)
      host.askSkill({ skillId: TIANSU, ownerId, step: 'recipient', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【天书】：选择一名角色获得并使用【太平要术】', timeoutMs: 20_000,
          optional: false, candidateIds, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !taipingCanBeCreatedOrReused(host.state)) return
      const cardId = taipingCard(host)
      if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: target.id })
      else moveCard(host.state, cardId, host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' } : { kind: 'discardPile' }, { kind: 'hand', playerId: target.id })
      host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: TIANSU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      executeUseCardAction(host as never, target.id, { id: `${TIANSU}:use:${cardId}`, kind: 'use-card', playerId: target.id,
        label: '【天书】：使用【太平要术】', cardIds: [cardId], targetIds: [target.id], targetMin: 1,
        targetMax: 1, asCardName: '太平要术', equipmentSlot: 'armor' } as never)
    }
  },
})

registerSkillRuntime({
  id: TAIPING_EQUIPMENT,
  preventsDamage(_state, ownerId, side, context) {
    return side === 'target' && context.targetId === ownerId && context.nature !== 'normal'
  },
  maxCardsBonus(state, ownerId) {
    const kingdom = getCharacter(playerOf(state, ownerId)?.characterId ?? '')?.kingdom
    return kingdom ? state.players.filter((candidate) => candidate.alive && candidate.characterId
      && getCharacter(candidate.characterId)?.kingdom === kingdom).length : 0
  },
  triggers: [{ event: 'LoseEquipment', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; specialEquipment?: string }
    if (payload.playerId !== ownerId || payload.specialEquipment !== TAIPING_EQUIPMENT) return
    if (!playerOf(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
    if (playerOf(host.state, ownerId)?.alive) loseHp(host as never, ownerId, 1, TIANSU)
  } }],
})

export const B47_NANHUA_LAOXIAN: CharacterDefinition = {
  id: 'nanhualaoxian-b47', name: '南华老仙', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: YUFENG, name: '御风', description: '出牌阶段限一次，你可以进行一次御风飞行。若失败你摸X张牌；若成功，则你可选择至多X名其他角色，其下一个准备阶段进行一次判定：若结果为黑色，其跳过接下来的出牌和弃牌阶段；若结果为红色，其跳过接下来的摸牌阶段（若选择角色数不足X则多余的分数改为摸牌）（X为御风飞行得分）。' },
    { id: TIANSU, name: '天书', description: '出牌阶段开始时，若【太平要术】不在游戏内、在牌堆或弃牌堆中，你可以弃置一张牌，并选择一名角色，其将获得【太平要术※】并使用之。' },
  ],
}

function taomieMarkedPlayer(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.find((player) => player.alive && player.id !== ownerId && player.marks[TAOMIE_MARK] > 0)
}

function taomiePendingKey(targetId: PlayerId, cardId: CardId | null) {
  return `${TAOMIE}:pending:${targetId}:${cardId ?? 'skill'}`
}

registerSkillRuntime({
  id: JULIA,
  distanceModifier: { fromOthers: (state) => Math.max(0, livingKingdomCount(state) - 1) },
})

registerSkillRuntime({
  id: TAOMIE,
  globalIgnoresDistanceTo(state, ownerId, attackerId, targetId) {
    const marked = taomieMarkedPlayer(state, ownerId)
    return !!marked && ((attackerId === ownerId && targetId === marked.id) || (attackerId === marked.id && targetId === ownerId))
  },
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      const cardId = (context.event.payload as { cardId?: CardId | null }).cardId ?? null
      const counterpartId = sourceId === ownerId ? targetId : targetId === ownerId ? sourceId : null
      if (!counterpartId || counterpartId === ownerId) return
      const pendingKey = taomiePendingKey(counterpartId, cardId)
      const pendingChoice = owner.marks[pendingKey]
      if (sourceId === ownerId && pendingChoice) {
        delete owner.marks[pendingKey]
        host.queueSkill({ skillId: TAOMIE, ownerId, step: 'gain-card', data: { targetId: counterpartId, backwater: pendingChoice === 2 } })
        return
      }
      const marked = taomieMarkedPlayer(host.state, ownerId)
      if (marked?.id === counterpartId) return
      host.queueSkill({ skillId: TAOMIE, ownerId, step: 'set-mark', data: { targetId: counterpartId } })
    },
  }, {
    event: 'DamageSettled',
    handle(host, ownerId, context) {
      if (Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0) return
      const targetId = context.event.targetId
      const cardId = (context.event.payload as { cardId?: CardId | null }).cardId ?? null
      const owner = playerOf(host.state, ownerId)
      if (targetId && owner) delete owner.marks[taomiePendingKey(targetId, cardId)]
    },
  }],
  offersDamageModifierAsk(host, ownerId, side, context) {
    if (side !== 'source' || context.sourceId !== ownerId || !playerOf(host.state, ownerId)?.alive) return false
    const marked = taomieMarkedPlayer(host.state, ownerId)
    if (!marked || marked.id !== context.targetId) return false
    const pickable = pickableCardsOf(host.state, marked.id)
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) {
      host.askSkill({ skillId: TAOMIE, ownerId, step: 'damage-choice', data: { targetId: marked.id, cardId: context.cardId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【讨灭】：是否令此伤害+1？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'increase', label: '此伤害+1' }, { id: 'none', label: '不发动' }] }) })
      return true
    }
    host.askSkill({ skillId: TAOMIE, ownerId, step: 'damage-choice', data: { targetId: marked.id, cardId: context.cardId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【讨灭】：选择一项', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'increase', label: '此伤害+1' },
          { id: 'gain', label: '获得其区域里的一张牌' },
          { id: 'backwater', label: '背水：获得其区域里的一张牌并弃置其“讨灭”标记' },
        ] }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'damage-choice') {
      const { targetId, cardId } = resolution.data as { targetId: PlayerId; cardId: CardId | null }
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive || !target?.alive || taomieMarkedPlayer(host.state, ownerId)?.id !== targetId) {
        resumeDamageModifier(host as never, TAOMIE, 0); return
      }
      if (optionId === 'increase') { resumeDamageModifier(host as never, TAOMIE, 1); return }
      if (optionId !== 'gain' && optionId !== 'backwater') { resumeDamageModifier(host as never, TAOMIE, 0); return }
      if (optionId === 'backwater') target.marks[TAOMIE_MARK] = 0
      owner.marks[taomiePendingKey(targetId, cardId)] = optionId === 'backwater' ? 2 : 1
      resumeDamageModifier(host as never, TAOMIE, 0)
      return
    }
    if (resolution.step === 'set-mark') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive || !target?.alive) return
      const marked = taomieMarkedPlayer(host.state, ownerId)
      if (marked) marked.marks[TAOMIE_MARK] = 0
      target.marks[TAOMIE_MARK] = 1
      return
    }
    if (resolution.step === 'gain-card') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const pickable = pickableCardsOf(host.state, targetId)
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      const selection = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selection ? resolvePickedCard(host.state, targetId, selection) : null
      if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: TAOMIE }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      const recipients = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!recipients.length || !owner.zones.hand.includes(cardId)) return
      host.askSkill({ skillId: TAOMIE, ownerId, step: 'give-card', data: { cardId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【讨灭】：是否将刚获得的牌交给一名其他角色？', timeoutMs: 20_000, optional: true,
          candidateIds: recipients, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'give-card') {
      const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!owner?.alive || !recipient?.alive || recipient.id === ownerId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipient.id })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: TAOMIE }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: recipient.id, cardIds: [cardId], reason: TAOMIE }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
    }
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'set-mark') {
      const owner = playerOf(host.state, ownerId)
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || target.id === ownerId || taomieMarkedPlayer(host.state, ownerId)?.id === targetId) return
      host.askSkill({ skillId: TAOMIE, ownerId, step: 'set-mark', data: { targetId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: `【讨灭】：是否令${target.nickname}获得“讨灭”标记？${taomieMarkedPlayer(host.state, ownerId) ? '现有标记将转移。' : ''}`,
          timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '令其获得标记' }, { id: 'no', label: '不发动' }] }) })
    } else if (prompt.step === 'gain-card') {
      const owner = playerOf(host.state, ownerId)
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (owner?.alive && target?.alive) {
        const pickable = pickableCardsOf(host.state, targetId)
        if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
        host.askSkill({ skillId: TAOMIE, ownerId, step: 'gain-card', data: prompt.data,
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: `【讨灭】：获得${target.nickname}区域里的一张牌`, timeoutMs: 20_000, optional: false,
            purpose: 'skill', ...pickable, min: 1, max: 1 }) })
      }
    }
  },
})

export const B47_GONGSUN_KANG: CharacterDefinition = {
  id: 'gongsunkang-b47', name: '公孙康', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: JULIA, name: '据辽', description: '锁定技，其他角色计算与你的距离始终+X（X为场上势力数-1）。' },
    { id: TAOMIE, name: '讨灭', description: '当你受到伤害后或你造成伤害后，你可以令伤害来源或受伤角色获得“讨灭”标记（如场上已有标记则转移给该角色），你和拥有“讨灭”标记的角色互相视为在对方的攻击范围内；当你对有标记的角色造成伤害时，选择一项：1.此伤害+1；2.你获得其区域内的一张牌并可将之交给另一名角色；背水：弃置其“讨灭”标记，且此次伤害不再令其获得“讨灭”标记。' },
  ],
}

export const HISTORICAL_BATCH47_CHARACTERS = [
  B47_MANCHONG, B47_JIANYONG, B47_YU_FAN, B47_ZHU_RAN, B47_GONGSUN_KANG,
  B47_GUOHUAI, B47_FU_HUANGHOU, B47_NANHUA_LAOXIAN, B47_CHEN_QUN, B47_WANGFU_ZHAOLEI,
] as const
