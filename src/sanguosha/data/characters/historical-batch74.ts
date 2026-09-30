import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { ALL_CHARACTERS } from './standard'
import { registerSkillRuntime, grantSkill, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { drawCards } from '../../engine/draw'
import { recover, recoverTo } from '../../engine/recover'
import { loseHp, loseMaxHp, gainMaxHp } from '../../engine/hp'
import { discardCardsByIds } from '../../engine/discard-all'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { getAttackRange, getDistance } from '../../engine/distance'
import { effectiveCardColor, effectiveCardSuit } from '../../engine/skills/runtime'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'

const B = '-b74'
const sid = (name: string) => `${name}${B}`
const LIYI_DOUZHEN = sid('douzhen-liyixiejing')
const SUNHUAN_NIJI = sid('niji-sunhuan')
const ZHANGYAO_YUYU = sid('yuyu-zhangyao')
const ZHANGYAO_XIYAN = sid('xiyan-zhangyao')
const QUANHUI_HUISHU = sid('huishu-quanhuijie')
const QUANHUI_YISHU = sid('yishu-quanhuijie')
const QUANHUI_LIGONG = sid('ligong-quanhuijie')
const XIELINGYU_YUANDI = sid('yuandi-xielingyu')
const XIELINGYU_XINYOU = sid('xinyou-xielingyu')
const GANMI_CHANJUAN = sid('chanjuan-ganmifuren')
const GANMI_XUNBIE = sid('xunbie-ganmifuren')
const WUBAN_YOUZHAN = sid('youzhan-wuban')
const FURONG_XUEWEI = sid('xuewei-furongfuqian')
const FURONG_YUGUAN = sid('yuguan-furongfuqian')
const GAOXIANG_CHIYING = sid('chiying-gaoxiang')
const QINYILU_PIAOPING = sid('piaoping-qinyilu')
const QINYILU_TUOXIAN = sid('tuoxian-qinyilu')
const QINYILU_ZHUILI = sid('zhuili-qinyilu')
const YUAN_PILE = '怨'
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

type B74State = SanguoshaState & { b74?: Record<string, any> }
function s74(state: SanguoshaState): Record<string, any> {
  const mutable = state as B74State
  mutable.b74 ??= {}
  return mutable.b74
}
function p(state: SanguoshaState, id: PlayerId) { return state.players.find((candidate) => candidate.id === id) }
function living(state: SanguoshaState) { return state.players.filter((candidate) => candidate.alive) }
function makeOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function chooseCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, cardIds: CardId[],
  min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function chooseTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidateIds: PlayerId[],
  prompt: string, data: Record<string, unknown> = {}, playerId = ownerId, min = 1, max = 1) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: false, candidateIds, min, max }) })
}
function chooseManyOptions(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, min: number, max: number, data: Record<string, unknown> = {}) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionsRequest => ({ id, kind: 'choose-options', playerId,
    prompt, timeoutMs: 25_000, optional: false, options, min, max }) })
}
function beginConversionToggle(host: SkillHost, ownerId: PlayerId): void {
  const state = toggleConversionState(host.state, ownerId, LIYI_DOUZHEN)
  host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: LIYI_DOUZHEN, state },
    { sourceId: ownerId, sourceSkillId: LIYI_DOUZHEN })
}

registerSkillRuntime({
  id: LIYI_DOUZHEN,
  forcedCardIdentity(state, ownerId, cardId) {
    if (state.currentPlayerId !== ownerId || state.currentTurnKind === 'extra' && state.currentPlayerId !== ownerId) return null
    const card = state.cards[cardId]
    if (card?.category !== 'basic') return null
    const mode = conversionStateOf(state, ownerId, LIYI_DOUZHEN)
    if (mode === 'yang' && effectiveCardColor(state, ownerId, cardId) === 'black') return { asCardName: '决斗' }
    if (mode === 'yin' && effectiveCardColor(state, ownerId, cardId) === 'red') return { asCardName: '杀' }
    return null
  },
  unlimitedSlashFor(state, ownerId, cardId) {
    return Boolean(cardId && state.currentPlayerId === ownerId && conversionStateOf(state, ownerId, LIYI_DOUZHEN) === 'yin'
      && state.cards[cardId]?.category === 'basic' && effectiveCardColor(state, ownerId, cardId) === 'red')
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      if (context.event.sourceSkillId === LIYI_DOUZHEN) beginConversionToggle(host, ownerId)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId === ownerId && host.state.currentPlayerId === ownerId && context.event.sourceSkillId === LIYI_DOUZHEN)
        beginConversionToggle(host, ownerId)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== LIYI_DOUZHEN) return
      const targetId = (context.event.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !p(host.state, targetId)?.alive) return
      const choices = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
      if (choices.cardIds.length || choices.hiddenCardSlots.length) host.askSkill({ skillId: LIYI_DOUZHEN, ownerId, step: 'steal', data: { targetId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【斗阵】：获得目标角色一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: choices.cardIds, hiddenCardSlots: choices.hiddenCardSlots, min: 1, max: 1,
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'steal') return
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && resolvePickedCard(host.state, targetId, selected)
    if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId }))
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: LIYI_DOUZHEN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: SUNHUAN_NIJI,
  triggers: [
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || context.event.sourceId === ownerId) return
      const payload = context.event.payload as { cardName?: string; cardCategory?: string; cardId?: CardId }
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (card && card.category !== 'basic' && card.category !== 'trick') return
      if (!payload.cardName && !card) return
      host.queueSkill({ skillId: SUNHUAN_NIJI, ownerId, step: 'offer-draw', data: { turnNumber: host.state.turnNumber } })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = (context.event.payload as { phase?: TurnPhase }).phase
      if (phase !== 'finish') return
      const turnNumber = host.state.turnNumber
      const ids = s74(host.state).nijiCards?.[ownerId]?.filter((id: CardId) => p(host.state, ownerId)?.zones.hand.includes(id)) ?? []
      if (!ids.length) return
      makeOption(host, SUNHUAN_NIJI, ownerId, 'use-one', ownerId,
        '【逆击】：可以先使用一张本回合以此法摸到的牌；否则弃置这些牌',
        [{ id: 'use', label: '先使用其中一张牌' }, { id: 'discard', label: '不使用，弃置这些牌' }], { turnNumber, cardIds: ids })
    } },
    { event: 'TurnStart', handle(host, ownerId) {
      const old = s74(host.state).nijiCards?.[ownerId] as CardId[] | undefined
      if (old?.length) for (const id of old) if (p(host.state, ownerId)?.zones.hand.includes(id)) discardCardsByIds(host as never, ownerId, [id], SUNHUAN_NIJI)
      if (s74(host.state).nijiCards) delete s74(host.state).nijiCards[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer-draw') {
      makeOption(host, SUNHUAN_NIJI, ownerId, 'draw', ownerId, '【逆击】：是否摸一张牌？', [{ id: 'yes', label: '摸一张牌' }], prompt.data)
      return
    }
    if (prompt.step !== 'draw') return
    const id = drawCards(host.state, host.rng, ownerId, 1)[0]
    if (id) (s74(host.state).nijiCards ??= {})[ownerId] = [...(s74(host.state).nijiCards?.[ownerId] ?? []), id]
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') host.queueSkill({ skillId: SUNHUAN_NIJI, ownerId, step: 'draw', data: resolution.data })
      return
    }
    if (resolution.step === 'use-one') {
      const ids = (resolution.data.cardIds as CardId[]).filter((id) => p(host.state, ownerId)?.zones.hand.includes(id))
      if ((response.payload as { optionId?: string }).optionId !== 'use' || !ids.length) {
        discardCardsByIds(host as never, ownerId, ids, SUNHUAN_NIJI)
        if (s74(host.state).nijiCards) delete s74(host.state).nijiCards[ownerId]
        return
      }
      chooseCards(host, SUNHUAN_NIJI, ownerId, 'select-use', ownerId, ids, 1, 1, '【逆击】：选择一张牌使用', { turnNumber: resolution.data.turnNumber, cardIds: ids })
      return
    }
    if (resolution.step === 'select-use') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !p(host.state, ownerId)?.zones.hand.includes(cardId)) return
      const card = host.state.cards[cardId]!
      const actions = declaredCardActions(host.state, ownerId, cardId, card.name, `【逆击】使用【${card.name}】`)
        .filter((action) => action.kind === 'use-card')
      if (!actions.length) {
        const rest = (resolution.data.cardIds as CardId[]).filter((id) => id !== cardId && p(host.state, ownerId)?.zones.hand.includes(id))
        discardCardsByIds(host as never, ownerId, rest, SUNHUAN_NIJI)
        delete s74(host.state).nijiCards?.[ownerId]
        return
      }
      makeOption(host, SUNHUAN_NIJI, ownerId, 'resolve-use', ownerId, '【逆击】：选择此牌的合法目标',
        actions.map((action) => ({ id: action.id, label: action.label })), { cardId, cardIds: resolution.data.cardIds })
      return
    }
    if (resolution.step === 'resolve-use') {
      const actionId = (response.payload as { optionId?: string }).optionId
      const action = actionId ? declaredCardActions(host.state, ownerId, resolution.data.cardId as CardId,
        host.state.cards[resolution.data.cardId as CardId]?.name ?? '', '【逆击】使用此牌').find((candidate) => candidate.kind === 'use-card' && candidate.id === actionId)
        : undefined
      const ids = (resolution.data.cardIds as CardId[]).filter((id) => id !== resolution.data.cardId && p(host.state, ownerId)?.zones.hand.includes(id))
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      discardCardsByIds(host as never, ownerId, ids, SUNHUAN_NIJI)
      delete s74(host.state).nijiCards?.[ownerId]
    }
  },
})

registerSkillRuntime({
  id: ZHANGYAO_YUYU,
  activeActions(state, ownerId) {
    const own = p(state, ownerId)
    return own?.alive && living(state).some((player) => player.id !== ownerId) && state.currentPlayerId === ownerId
      && state.phase === 'play' && !usedThisPhase(state, ownerId, ZHANGYAO_YUYU)
      ? [{ id: `skill:${ZHANGYAO_YUYU}`, label: '发动【怨语】' }] : []
  },
  invokeActive(host, ownerId) {
    const own = p(host.state, ownerId)
    if (!own?.alive || !living(host.state).some((player) => player.id !== ownerId) || usedThisPhase(host.state, ownerId, ZHANGYAO_YUYU)) return
    if (!own.zones.hand.length) { drawCards(host.state, host.rng, ownerId, 1); markUsedThisPhase(host.state, ownerId, ZHANGYAO_YUYU); return }
    drawCards(host.state, host.rng, ownerId, 1)
    const hand = [...own.zones.hand]
    if (!hand.length) return
    chooseCards(host, ZHANGYAO_YUYU, ownerId, 'place-first', ownerId, hand, 1, 1, '【怨语】：选择一张手牌置于武将牌上作为“怨”')
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'place-first') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !p(host.state, ownerId)?.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: YUAN_PILE })
      markUsedThisPhase(host.state, ownerId, ZHANGYAO_YUYU)
      chooseTargets(host, ZHANGYAO_YUYU, ownerId, 'mark-target', living(host.state).filter((x) => x.id !== ownerId).map((x) => x.id),
        '【怨语】：选择一名其他角色', { firstCardId: cardId })
      return
    }
    if (resolution.step === 'mark-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !p(host.state, targetId)?.alive) return
      ;(s74(host.state).yuyuTargets ??= {})[ownerId] = targetId
      return
    }
    if (resolution.step === 'add-resentment') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const playerId = resolution.data.playerId as PlayerId
      if (!cardId || !p(host.state, playerId)?.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'characterPile', playerId: ownerId, pile: YUAN_PILE })
      const pile = p(host.state, ownerId)?.characterPiles[YUAN_PILE] ?? []
      const suits = new Set(pile.map((id) => effectiveCardSuit(host.state, ownerId, id)))
      if (suits.size >= 4) host.queueSkill({ skillId: ZHANGYAO_XIYAN, ownerId, step: 'offer', data: { sourcePlayerId: playerId } })
      if (resolution.data.fromDamage) {
        const pending = s74(host.state).yuyuDamagePending?.[ownerId]
        if (pending) {
          pending.remaining -= 1
          if (pending.remaining > 0 && p(host.state, playerId)?.zones.hand.length)
            host.queueSkill({ skillId: ZHANGYAO_YUYU, ownerId, step: 'damage-resentment', data: { sourceId: playerId } })
          else delete s74(host.state).yuyuDamagePending[ownerId]
        }
      }
      return
    }
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if ((payload.phase !== 'discard' || (payload.playerId !== ownerId && payload.playerId !== s74(host.state).yuyuTargets?.[ownerId]))) return
      const playerId = payload.playerId!
      const own = p(host.state, playerId)
      if (own?.zones.hand.length) chooseCards(host, ZHANGYAO_YUYU, ownerId, 'add-resentment', playerId, [...own.zones.hand], 1, 1,
        '【怨语】：将一张手牌置为“怨”', { playerId })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const amount = Math.floor(Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0))
      if (!sourceId || sourceId !== s74(host.state).yuyuTargets?.[ownerId] || amount <= 0 || !p(host.state, sourceId)?.zones.hand.length) return
      s74(host.state).yuyuDamagePending ??= {}
      s74(host.state).yuyuDamagePending[ownerId] = { sourceId, remaining: amount }
      host.queueSkill({ skillId: ZHANGYAO_YUYU, ownerId, step: 'damage-resentment', data: { sourceId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage-resentment') return
    const pending = s74(host.state).yuyuDamagePending?.[ownerId]
    const playerId = pending?.sourceId as PlayerId | undefined
    const hand = playerId ? [...(p(host.state, playerId)?.zones.hand ?? [])] : []
    if (!playerId || !hand.length || pending.remaining <= 0) { delete s74(host.state).yuyuDamagePending?.[ownerId]; return }
    chooseCards(host, ZHANGYAO_YUYU, ownerId, 'add-resentment', playerId, hand, 1, 1,
      '【怨语】：将一张手牌置为“怨”', { playerId, fromDamage: true })
  },
  maxCardsBonus(state, ownerId) { const record = s74(state).yuyuHandBonus?.[ownerId]; return record?.turnNumber === state.turnNumber ? record.amount : 0 },
  unlimitedCardUses(state, ownerId) { return s74(state).yuyuUnbounded?.[ownerId] === state.turnNumber },
  prohibitsCardUse(state, _ownerId, context) {
    const lock = s74(state).xiyanLocks?.[context.userId]
    return lock?.turnNumber === state.turnNumber && lock.noBasic === true && ['杀', '桃', '酒'].includes(context.cardName)
  },
  globalMaxCardsBonus(state, _ownerId, targetId) {
    const lock = s74(state).xiyanLocks?.[targetId]
    return lock?.turnNumber === state.turnNumber ? Number(lock.maxCards ?? 0) : 0
  },
})

registerSkillRuntime({
  id: ZHANGYAO_XIYAN,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    makeOption(host, ZHANGYAO_XIYAN, ownerId, 'choice', ownerId, '【夕颜】：是否获得所有“怨”？',
      [{ id: 'yes', label: '获得所有“怨”' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const pile = [...(p(host.state, ownerId)?.characterPiles[YUAN_PILE] ?? [])]
    for (const cardId of pile) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YUAN_PILE }, { kind: 'hand', playerId: ownerId })
    if (pile.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: pile, reason: ZHANGYAO_XIYAN },
      { sourceId: ownerId, targetId: ownerId, cardIds: pile })
    if (host.state.currentPlayerId === ownerId) {
      clearUsedThisPhase(host.state, ownerId, ZHANGYAO_YUYU)
      s74(host.state).yuyuUnbounded ??= {}
      s74(host.state).yuyuUnbounded[ownerId] = host.state.turnNumber
      s74(host.state).yuyuHandBonus ??= {}
      s74(host.state).yuyuHandBonus[ownerId] = { turnNumber: host.state.turnNumber, amount: 4 }
    } else if (host.state.currentPlayerId) {
      const targetId = host.state.currentPlayerId
      s74(host.state).xiyanLocks ??= {}
      s74(host.state).xiyanLocks[targetId] = { turnNumber: host.state.turnNumber, maxCards: -4, noBasic: true }
    }
  },
})

registerSkillRuntime({
  id: QUANHUI_HUISHU,
  onGameStart(host, ownerId) {
    s74(host.state).huishuValues ??= {}
    s74(host.state).huishuValues[ownerId] = [3, 1, 2]
    const owner = p(host.state, ownerId)
    if (owner) {
      owner.marks['慧'] = 3
      owner.marks['淑'] = 1
      owner.marks['贤'] = 2
    }
  },
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId === ownerId && payload.phase === 'draw' && p(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: QUANHUI_HUISHU, ownerId, step: 'draw-three', data: {} })
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { fromPlayerId?: PlayerId; reason?: string }
      if (host.state.currentPlayerId !== ownerId || payload.fromPlayerId !== ownerId || payload.reason !== 'discard'
        || !s74(host.state).huishuDiscardBonus?.[ownerId]) return
      const count = (s74(host.state).huishuDiscardCount ??= {})[ownerId] = Number(s74(host.state).huishuDiscardCount?.[ownerId] ?? 0) + 1
      if (count <= 2 || s74(host.state).huishuRewarded?.[ownerId]) return
      const available = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.category !== 'basic')
      const selected = host.rng.shuffle(available).slice(0, count)
      for (const id of selected) moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      if (selected.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: selected, reason: QUANHUI_HUISHU },
        { sourceId: ownerId, targetId: ownerId, cardIds: selected })
      s74(host.state).huishuRewarded ??= {}
      s74(host.state).huishuRewarded[ownerId] = true
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      delete s74(host.state).huishuDiscardBonus?.[ownerId]
      delete s74(host.state).huishuDiscardCount?.[ownerId]
      delete s74(host.state).huishuRewarded?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'draw-three') makeOption(host, QUANHUI_HUISHU, ownerId, 'draw-choice', ownerId,
      '【慧淑】：是否额外摸三张牌，然后弃置一张手牌？', [{ id: 'yes', label: '摸三张并弃置一张手牌' }])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !p(host.state, ownerId)?.alive) return
      drawCards(host.state, host.rng, ownerId, 3)
      const hand = [...p(host.state, ownerId)!.zones.hand]
      if (hand.length) {
        s74(host.state).huishuDiscardBonus ??= {}
        s74(host.state).huishuDiscardBonus[ownerId] = true
        chooseCards(host, QUANHUI_HUISHU, ownerId, 'discard-one', ownerId, hand, 1, 1, '【慧淑】：弃置一张手牌')
      }
      return
    }
    if (resolution.step === 'discard-one') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !p(host.state, ownerId)?.zones.hand.includes(cardId)) return
      discardCardsByIds(host as never, ownerId, [cardId], QUANHUI_HUISHU)
    }
  },
})

registerSkillRuntime({
  id: QUANHUI_YISHU,
  triggers: [{ event: 'CardZoneMoved', handle(host, ownerId, context) {
    const payload = context.event.payload as { fromPlayerId?: PlayerId; fromKind?: string }
    if (payload.fromPlayerId !== ownerId || payload.fromKind === 'drawPile' || host.state.phase === 'play') return
    const values = s74(host.state).huishuValues?.[ownerId] as number[] | undefined
    if (!values?.length) return
    let minIndex = 0; let maxIndex = values.length - 1
    for (let i = 1; i < values.length; i++) if (values[i]! < values[minIndex]!) minIndex = i
    for (let i = values.length - 2; i >= 0; i--) if (values[i]! > values[maxIndex]!) maxIndex = i
    if (minIndex === maxIndex) maxIndex = values.length - 1
    const next = [...values]
    next[minIndex] = next[minIndex]! + 2
    next[maxIndex] = next[maxIndex]! - 1
    s74(host.state).huishuValues[ownerId] = next
    const owner = p(host.state, ownerId)
    if (owner) {
      owner.marks['慧'] = next[0]!
      owner.marks['淑'] = next[1]!
      owner.marks['贤'] = next[2]!
    }
  } }],
})

registerSkillRuntime({
  id: QUANHUI_LIGONG,
  awakening: {
    phase: 'prepare',
    ready: (state, ownerId) => Boolean((s74(state).huishuValues?.[ownerId] as number[] | undefined)?.some((value) => value >= 5)),
    invoke(host, ownerId) { host.queueSkill({ skillId: QUANHUI_LIGONG, ownerId, step: 'awaken', data: {} }) },
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'awaken') return
    const candidates = host.rng.shuffle(ALL_CHARACTERS.filter((character) => character.kingdom === 'wu' && character.gender === 'female'
      && character.id !== 'quanhui-b74')).slice(0, 4)
    const skillOptions = candidates.flatMap((character) => character.skills.map((skill) => ({
      id: `${character.id}::${skill.id}`, label: `${character.name}【${skill.name}】`, skillId: skill.id,
    })))
    gainMaxHp(host as never, ownerId, 1, QUANHUI_LIGONG)
    recover(host as never, ownerId, 1, ownerId)
    const owner = p(host.state, ownerId)
    if (owner) {
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(QUANHUI_YISHU)) owner.permanentlyLostSkills.push(QUANHUI_YISHU)
    }
    if (!owner) return
    owner.awakenedSkills ??= []
    if (!owner.awakenedSkills.includes(QUANHUI_LIGONG)) owner.awakenedSkills.push(QUANHUI_LIGONG)
    if (!skillOptions.length) { drawCards(host.state, host.rng, ownerId, 3); return }
    chooseManyOptions(host, QUANHUI_LIGONG, ownerId, 'choose-skills', ownerId,
      '【离宫】：选择至多两个技能获得；不选择则保留【慧淑】并摸三张牌',
      skillOptions.map(({ id, label }) => ({ id, label })), 0, Math.min(2, skillOptions.length), { skillOptions })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-skills') return
    const selected = (response.payload as { optionIds?: string[] }).optionIds ?? []
    const options = resolution.data.skillOptions as Array<{ id: string; skillId: string }>
    const chosen = selected.filter((id) => options.some((option) => option.id === id)).slice(0, 2)
    if (!chosen.length) { drawCards(host.state, host.rng, ownerId, 3); return }
    const owner = p(host.state, ownerId)
    if (owner) {
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(QUANHUI_HUISHU)) owner.permanentlyLostSkills.push(QUANHUI_HUISHU)
      delete owner.marks['慧']
      delete owner.marks['淑']
      delete owner.marks['贤']
    }
    for (const id of chosen) grantSkill(host.state, ownerId, options.find((option) => option.id === id)!.skillId)
  },
})

registerSkillRuntime({
  id: XIELINGYU_YUANDI,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const actorId = context.event.sourceId
    if (!actorId || actorId === ownerId || host.state.phase !== 'play') return
    const key = `${actorId}:${host.state.turnNumber}:${host.state.extraPhase?.instanceId ?? 'normal'}`
    if (s74(host.state).yuandiFirst?.[key]) return
    s74(host.state).yuandiFirst ??= {}
    s74(host.state).yuandiFirst[key] = true
    const payload = context.event.payload as { targetIds?: PlayerId[]; targets?: PlayerId[] }
    const targets = payload.targetIds ?? payload.targets ?? []
    if (targets.some((id) => id !== actorId)) return
    host.queueSkill({ skillId: XIELINGYU_YUANDI, ownerId, step: 'offer', data: { actorId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const actorId = prompt.data.actorId as PlayerId
    if (!p(host.state, actorId)?.alive || !p(host.state, ownerId)?.alive) return
    makeOption(host, XIELINGYU_YUANDI, ownerId, 'choice', ownerId,
      `【元嫡】：是否对${p(host.state, actorId)?.nickname ?? '其'}发动？`,
      [{ id: 'discard', label: '弃置其一张手牌' }, { id: 'draw', label: '你与其各摸一张牌' }], { actorId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choice') {
      const actorId = resolution.data.actorId as PlayerId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!p(host.state, actorId)?.alive || !p(host.state, ownerId)?.alive) return
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1)
        drawCards(host.state, host.rng, actorId, 1)
      } else if (optionId === 'discard') {
        const hand = [...p(host.state, actorId)!.zones.hand]
        if (hand.length) chooseCards(host, XIELINGYU_YUANDI, ownerId, 'discard-card', ownerId, hand, 1, 1,
          '【元嫡】：弃置其一张手牌', { actorId })
      }
      return
    }
    if (resolution.step === 'discard-card') {
      const actorId = resolution.data.actorId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && p(host.state, actorId)?.zones.hand.includes(cardId)) discardCardsByIds(host as never, actorId, [cardId], XIELINGYU_YUANDI)
    }
  },
})

registerSkillRuntime({
  id: XIELINGYU_XINYOU,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, XIELINGYU_XINYOU)
      ? [{ id: `skill:${XIELINGYU_XINYOU}`, label: '发动【心幽】' }] : []
  },
  invokeActive(host, ownerId) {
    const own = p(host.state, ownerId)
    if (!own?.alive || usedThisPhase(host.state, ownerId, XIELINGYU_XINYOU)) return
    const recovered = Math.max(0, own.maxHp - own.hp)
    const drawn = Math.max(0, own.maxHp - own.zones.hand.length)
    if (recovered) recover(host as never, ownerId, recovered, ownerId)
    if (drawn) drawCards(host.state, host.rng, ownerId, drawn)
    markUsedThisPhase(host.state, ownerId, XIELINGYU_XINYOU)
    s74(host.state).xinyouPenalty ??= {}
    s74(host.state).xinyouPenalty[ownerId] = { turnNumber: host.state.turnNumber, drawn, recovered }
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const penalty = s74(host.state).xinyouPenalty?.[ownerId]
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || penalty?.turnNumber !== host.state.turnNumber) return
    delete s74(host.state).xinyouPenalty[ownerId]
    if (penalty.drawn > 2) loseHp(host as never, ownerId, 1, XIELINGYU_XINYOU)
    const hand = p(host.state, ownerId)?.zones.hand ?? []
    if (penalty.recovered > 0 && hand.length) discardCardsByIds(host as never, ownerId, [host.rng.pick(hand)], XIELINGYU_XINYOU)
  } }],
})

registerSkillRuntime({
  id: WUBAN_YOUZHAN,
  handLimitExempt(state, ownerId, cardId) {
    const record = s74(state).wubanBonus?.[cardId]
    return record?.ownerId === ownerId && record.turnNumber === state.turnNumber
  },
  globalOutgoingDamage(state, ownerId, _sourceId, context) {
    const record = s74(state).wubanDamage?.[context.targetId]
    return record?.ownerId === ownerId && record.turnNumber === state.turnNumber ? { amount: context.amount + 1 } : null
  },
  triggers: [
    { event: 'CardZoneMoved', handle(host, ownerId, context) {
      if (host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { fromPlayerId?: PlayerId; fromKind?: string }
      const targetId = payload.fromPlayerId
      if (!targetId || targetId === ownerId || !['hand', 'equipment', 'judgingArea'].includes(payload.fromKind ?? '')) return
      const gained = drawCards(host.state, host.rng, ownerId, 1)
      const cardId = gained[0]
      if (cardId) (s74(host.state).wubanBonus ??= {})[cardId] = { ownerId, turnNumber: host.state.turnNumber }
      s74(host.state).wubanDamage ??= {}
      s74(host.state).wubanDamage[targetId] = { ownerId, turnNumber: host.state.turnNumber }
      s74(host.state).wubanLost ??= {}
      s74(host.state).wubanLost[`${ownerId}:${targetId}:${host.state.turnNumber}`] =
        Number(s74(host.state).wubanLost[`${ownerId}:${targetId}:${host.state.turnNumber}`] ?? 0) + 1
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { targetId?: PlayerId }).targetId
      if (targetId) (s74(host.state).wubanDamaged ??= {})[`${ownerId}:${targetId}:${host.state.turnNumber}`] = true
      if (targetId && s74(host.state).wubanDamage?.[targetId]?.ownerId === ownerId) delete s74(host.state).wubanDamage[targetId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId !== ownerId || payload.phase !== 'finish') return
      for (const key of Object.keys(s74(host.state).wubanLost ?? {})) {
        const [turnOwner, targetId, turnNumber] = key.split(':')
        if (turnOwner !== ownerId || Number(turnNumber) !== host.state.turnNumber) continue
        const count = Number(s74(host.state).wubanLost[key] ?? 0)
        if (count && !s74(host.state).wubanDamaged?.[`${ownerId}:${targetId}:${host.state.turnNumber}`])
          drawCards(host.state, host.rng, targetId!, Math.min(3, count))
        delete s74(host.state).wubanLost[key]
      }
      for (const key of Object.keys(s74(host.state).wubanDamaged ?? {})) if (key.startsWith(`${ownerId}:`)) delete s74(host.state).wubanDamaged[key]
    } },
  ],
})

registerSkillRuntime({
  id: FURONG_XUEWEI,
  interceptGlobalIncomingDamage(host, ownerId, targetId) {
    const record = s74(host.state).xuewei?.[ownerId]
    if (!record || record.targetId !== targetId || record.expiresOnOwnerTurn !== undefined && host.state.currentPlayerId === ownerId
      || !p(host.state, ownerId)?.alive) return false
    loseHp(host as never, ownerId, 1, FURONG_XUEWEI)
    drawCards(host.state, host.rng, ownerId, 1)
    drawCards(host.state, host.rng, targetId, 1)
    return true
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete s74(host.state).xuewei?.[ownerId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId !== ownerId || payload.phase !== 'finish' || !p(host.state, ownerId)?.alive) return
      const candidates = living(host.state).filter((candidate) => candidate.hp <= (p(host.state, ownerId)?.hp ?? 0)).map((candidate) => candidate.id)
      if (candidates.length) host.askSkill({ skillId: FURONG_XUEWEI, ownerId, step: 'target', data: {}, build: (id) => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【血卫】：是否选择一名角色保护至你的下回合开始？',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (targetId && p(host.state, targetId)?.alive && p(host.state, targetId)!.hp <= (p(host.state, ownerId)?.hp ?? -1))
      (s74(host.state).xuewei ??= {})[ownerId] = { targetId, expiresOnOwnerTurn: host.state.turnNumber + 1 }
  },
})

registerSkillRuntime({
  id: FURONG_YUGUAN,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId) {
    const own = p(host.state, ownerId)
    if (!own?.alive) return
    const lost = own.maxHp - own.hp
    const maxLost = Math.max(...living(host.state).map((candidate) => candidate.maxHp - candidate.hp))
    if (lost < maxLost) return
    host.queueSkill({ skillId: FURONG_YUGUAN, ownerId, step: 'offer', data: { lost } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    makeOption(host, FURONG_YUGUAN, ownerId, 'accept', ownerId, '【御关】：是否减1点体力上限并令角色摸至体力上限？',
      [{ id: 'yes', label: '减1点体力上限并执行' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'accept') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      loseMaxHp(host as never, ownerId, 1, FURONG_YUGUAN)
      const count = Math.max(0, p(host.state, ownerId)!.maxHp - p(host.state, ownerId)!.hp)
      const candidateIds = living(host.state).map((candidate) => candidate.id)
      const max = Math.min(count, candidateIds.length)
      if (!max) return
      host.askSkill({ skillId: FURONG_YUGUAN, ownerId, step: 'targets', data: { count: max }, build: (id) => ({ id, kind: 'choose-targets',
        playerId: ownerId, prompt: '【御关】：选择X名角色，其将手牌摸至体力上限', timeoutMs: 25_000,
        optional: false, candidateIds, min: max, max }) })
      return
    }
    if (resolution.step !== 'targets') return
    const selected = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    const count = Number(resolution.data.count ?? 0)
    if (selected.length !== count || selected.some((id) => !p(host.state, id)?.alive)) return
    for (const targetId of selected) {
      const target = p(host.state, targetId)!
      const amount = Math.max(0, target.maxHp - target.zones.hand.length)
      if (amount) drawCards(host.state, host.rng, targetId, amount)
    }
  },
})

registerSkillRuntime({
  id: GAOXIANG_CHIYING,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && p(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, GAOXIANG_CHIYING)
      ? [{ id: `skill:${GAOXIANG_CHIYING}`, label: '发动【驰应】' }] : []
  },
  invokeActive(host, ownerId) {
    if (!p(host.state, ownerId)?.alive || usedThisPhase(host.state, ownerId, GAOXIANG_CHIYING)) return
    markUsedThisPhase(host.state, ownerId, GAOXIANG_CHIYING)
    const ownHp = p(host.state, ownerId)!.hp
    const candidateIds = living(host.state).filter((candidate) => candidate.hp <= ownHp).map((candidate) => candidate.id)
    if (!candidateIds.length) return
    chooseTargets(host, GAOXIANG_CHIYING, ownerId, 'choose-recipient', candidateIds, '【驰应】：选择一名角色', {})
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-recipient') {
      const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!recipientId || !p(host.state, recipientId)?.alive || p(host.state, recipientId)!.hp > p(host.state, ownerId)!.hp) return
      const candidates = living(host.state).filter((target) => target.id !== recipientId && getDistance(host.state, recipientId, target.id) <= getAttackRange(host.state, recipientId))
      if (!candidates.length) return
      chooseTargets(host, GAOXIANG_CHIYING, ownerId, 'choose-victims', candidates.map((target) => target.id),
        `【驰应】：选择${p(host.state, recipientId)?.nickname ?? '该角色'}攻击范围内任意名其他角色`, { recipientId }, recipientId, 0, candidates.length)
      return
    }
    if (resolution.step === 'choose-victims') {
      const recipientId = resolution.data.recipientId as PlayerId
      const selected = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      const allowed = living(host.state).filter((target) => target.id !== recipientId && getDistance(host.state, recipientId, target.id) <= getAttackRange(host.state, recipientId)).map((target) => target.id)
      if (selected.some((id) => !allowed.includes(id))) return
      s74(host.state).chiying ??= {}
      s74(host.state).chiying[ownerId] = { recipientId, victims: selected, next: 0, basicIds: [] }
      host.queueSkill({ skillId: GAOXIANG_CHIYING, ownerId, step: 'discard-next', data: {} })
      return
    }
    if (resolution.step !== 'discard-one') return
    const pending = s74(host.state).chiying?.[ownerId]
    if (!pending) return
    const victimId = pending.victims[pending.next] as PlayerId | undefined
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = victimId && selected && resolvePickedCard(host.state, victimId, selected)
    if (victimId && cardId && locateOwnedCard(host.state, victimId, cardId)) {
      const card = host.state.cards[cardId]!
      discardCardsByIds(host as never, victimId, [cardId], GAOXIANG_CHIYING)
      if (p(host.state, ownerId)?.alive && card.category === 'basic') pending.basicIds.push(cardId)
    }
    pending.next += 1
    host.queueSkill({ skillId: GAOXIANG_CHIYING, ownerId, step: 'discard-next', data: {} })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-next') return
    const pending = s74(host.state).chiying?.[ownerId]
    const recipientId = pending?.recipientId as PlayerId | undefined
    const victimId = pending?.victims[pending.next] as PlayerId | undefined
    if (!pending || !recipientId || !victimId) {
      if (pending?.recipientId !== ownerId && p(host.state, pending?.recipientId)?.alive) {
        for (const cardId of pending.basicIds as CardId[]) if (host.state.zones.discardPile.includes(cardId))
          moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: recipientId! })
        if (pending.basicIds.length) host.dispatch('GainCard', { playerId: recipientId, cardIds: pending.basicIds, reason: GAOXIANG_CHIYING },
          { sourceId: ownerId, targetId: recipientId, cardIds: pending.basicIds })
      }
      delete s74(host.state).chiying?.[ownerId]
      return
    }
    if (!p(host.state, victimId)?.alive) { pending.next += 1; host.queueSkill({ skillId: GAOXIANG_CHIYING, ownerId, step: 'discard-next', data: {} }); return }
    const pick = pickableCardsOf(host.state, victimId, { discarderId: recipientId })
    const choices = [...pick.cardIds, ...pick.hiddenCardSlots]
    if (!choices.length) { pending.next += 1; host.queueSkill({ skillId: GAOXIANG_CHIYING, ownerId, step: 'discard-next', data: {} }); return }
    host.askSkill({ skillId: GAOXIANG_CHIYING, ownerId, step: 'discard-one', data: { recipientId, victimId }, build: (id) => ({
      id, kind: 'choose-cards', playerId: recipientId, prompt: `【驰应】：弃置${p(host.state, victimId)?.nickname ?? '该角色'}区域内一张牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: 1, max: 1,
    }) })
  },
})

registerSkillRuntime({
  id: QINYILU_PIAOPING,
  onGameStart(host, ownerId) {
    s74(host.state).tuoxianQuota ??= {}
    s74(host.state).tuoxianUses ??= {}
    s74(host.state).tuoxianQuota[ownerId] = 1
    s74(host.state).tuoxianUses[ownerId] = 0
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || s74(host.state).piaopingDisabled?.[ownerId] === host.state.turnNumber) return
      const count = (s74(host.state).piaopingCount ??= {})[ownerId] =
        (s74(host.state).piaopingCount?.[ownerId]?.turn === host.state.turnNumber ? s74(host.state).piaopingCount[ownerId].count : 0) + 1
      s74(host.state).piaopingCount[ownerId] = { turn: host.state.turnNumber, count }
      const x = Math.min(count, p(host.state, ownerId)?.hp ?? 0)
      const mode = conversionStateOf(host.state, ownerId, QINYILU_PIAOPING)
      if (mode === 'yang' && x > 0) drawCards(host.state, host.rng, ownerId, x)
      else if (mode === 'yin' && x > 0) host.queueSkill({ skillId: QINYILU_PIAOPING, ownerId, step: 'discard', data: { count: x } })
      const next = toggleConversionState(host.state, ownerId, QINYILU_PIAOPING)
      host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: QINYILU_PIAOPING, state: next }, { sourceId: ownerId, sourceSkillId: QINYILU_PIAOPING })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
        delete s74(host.state).piaopingCount?.[ownerId]
        delete s74(host.state).piaopingDisabled?.[ownerId]
        delete s74(host.state).zhuiliDisabled?.[ownerId]
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const count = Number(prompt.data.count ?? 0)
    const pick = pickableCardsOf(host.state, ownerId, { discarderId: ownerId })
    const amount = Math.min(count, pick.cardIds.length + pick.hiddenCardSlots.length)
    if (!amount) return
    host.askSkill({ skillId: QINYILU_PIAOPING, ownerId, step: 'choose-discard', data: { amount }, build: (id) => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【漂萍】：弃置${amount}张牌`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: amount, max: amount,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-discard') return
    const amount = Number(resolution.data.amount ?? 0)
    const selectedTokens = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
    const ids = selectedTokens.map((token) => resolvePickedCard(host.state, ownerId, token)).filter((id): id is CardId => Boolean(id))
    if (ids.length !== amount) return
    const quota = Number(s74(host.state).tuoxianQuota?.[ownerId] ?? 1)
    const uses = Number(s74(host.state).tuoxianUses?.[ownerId] ?? 0)
    s74(host.state).piaopingPending ??= {}
    s74(host.state).piaopingPending[ownerId] = ids
    if (uses < quota && living(host.state).some((candidate) => candidate.id !== ownerId)) chooseTargets(host, QINYILU_TUOXIAN, ownerId, 'offer-tuoxian', living(host.state).filter((candidate) => candidate.id !== ownerId).map((candidate) => candidate.id),
      '【托献】：选择一名其他角色接收这些牌；取消则正常弃置', { cardIds: ids, amount }, ownerId, 0, 1)
    else { discardCardsByIds(host as never, ownerId, ids, QINYILU_PIAOPING); delete s74(host.state).piaopingPending[ownerId] }
  },
})

registerSkillRuntime({
  id: QINYILU_TUOXIAN,
  onGameStart(host, ownerId) {
    s74(host.state).tuoxianQuota ??= {}
    s74(host.state).tuoxianUses ??= {}
    s74(host.state).tuoxianQuota[ownerId] = 1
    s74(host.state).tuoxianUses[ownerId] = 0
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer-tuoxian') {
      const ids = (s74(host.state).piaopingPending?.[ownerId] as CardId[] | undefined) ?? []
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !p(host.state, targetId)?.alive) { discardCardsByIds(host as never, ownerId, ids, QINYILU_PIAOPING); delete s74(host.state).piaopingPending?.[ownerId]; return }
      for (const id of ids) {
        const from = locateOwnedCard(host.state, ownerId, id)
        if (from) moveCard(host.state, id, from, { kind: 'hand', playerId: targetId })
      }
      delete s74(host.state).piaopingPending?.[ownerId]
      if (ids.length) host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: targetId, cardIds: ids, reason: QINYILU_TUOXIAN },
        { sourceId: ownerId, targetId, cardIds: ids, sourceSkillId: QINYILU_TUOXIAN })
      s74(host.state).tuoxianUses ??= {}
      s74(host.state).tuoxianUses[ownerId] = Number(s74(host.state).tuoxianUses[ownerId] ?? 0) + 1
      const targetPick = pickableCardsOf(host.state, targetId, { discarderId: targetId })
      const options = [{ id: 'disable', label: '令【漂萍】本回合失效' }]
      if (targetPick.cardIds.length + targetPick.hiddenCardSlots.length >= ids.length)
        options.unshift({ id: 'discard', label: `弃置${ids.length}张区域牌` })
      makeOption(host, QINYILU_TUOXIAN, ownerId, 'target-choice', targetId,
        '【托献】：弃置你区域内等量的牌，或令秦宜禄本回合【漂萍】失效', options, { targetId, amount: ids.length })
      return
    }
    if (resolution.step === 'target-choice') {
      const targetId = resolution.data.targetId as PlayerId
      if ((response.payload as { optionId?: string }).optionId === 'disable') {
        s74(host.state).piaopingDisabled ??= {}
        s74(host.state).piaopingDisabled[ownerId] = host.state.turnNumber
        return
      }
      const amount = Number(resolution.data.amount ?? 0)
      const pick = pickableCardsOf(host.state, targetId, { discarderId: targetId })
      if (pick.cardIds.length + pick.hiddenCardSlots.length < amount) {
        s74(host.state).piaopingDisabled ??= {}
        s74(host.state).piaopingDisabled[ownerId] = host.state.turnNumber
        return
      }
      host.askSkill({ skillId: QINYILU_TUOXIAN, ownerId, step: 'discard-target', data: { targetId, count: amount }, build: (id) => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: `【托献】：弃置你区域内${amount}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: amount, max: amount,
      }) })
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = resolution.data.targetId as PlayerId
      const count = Number(resolution.data.count ?? 0)
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const ids = selected.slice(0, count).map((id) => resolvePickedCard(host.state, targetId, id)).filter((id): id is CardId => Boolean(id))
      if (ids.length === count && new Set(ids).size === count && ids.every((id) => locateOwnedCard(host.state, targetId, id)))
        discardCardsByIds(host as never, targetId, ids, QINYILU_TUOXIAN)
    }
  },
})

registerSkillRuntime({ id: GANMI_CHANJUAN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || !payload.cardId || !payload.cardName || payload.targetIds?.length !== 1) return
      const card = host.state.cards[payload.cardId]
      if (!card || card.virtual || (card.category !== 'basic' && card.category !== 'trick') || DELAYED_TRICK_NAMES.has(payload.cardName)) return
      ;(s74(host.state).chanjuanOriginals ??= {})[payload.cardId] = { name: payload.cardName, targetId: payload.targetIds[0] }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || !payload.cardId) return
      if (payload.sourceSkillId === GANMI_CHANJUAN) {
        const repeat = s74(host.state).chanjuanRepeats?.[payload.cardId]
        if (repeat && payload.targetIds?.length === 1 && payload.targetIds[0] === repeat.targetId) drawCards(host.state, host.rng, ownerId, 1)
        delete s74(host.state).chanjuanRepeats?.[payload.cardId]
        return
      }
      const original = s74(host.state).chanjuanOriginals?.[payload.cardId]
      delete s74(host.state).chanjuanOriginals?.[payload.cardId]
      if (!original || payload.targetIds?.length !== 1 || payload.targetIds[0] !== original.targetId) return
      const key = `${ownerId}:${host.state.turnNumber}:${original.name}`
      if ((s74(host.state).chanjuanUses?.[key] ?? 0) >= 2) return
      host.queueSkill({ skillId: GANMI_CHANJUAN, ownerId, step: 'repeat-offer', data: original })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      for (const key of Object.keys(s74(host.state).chanjuanUses ?? {})) if (key.startsWith(`${ownerId}:`)) delete s74(host.state).chanjuanUses[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'repeat-offer') makeOption(host, GANMI_CHANJUAN, ownerId, 'repeat-choice', ownerId,
      `【婵娟】：是否再次对原目标使用【${prompt.data.name}】？`,
      [{ id: 'yes', label: '再次使用' }, { id: 'no', label: '不使用' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'repeat-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const name = String(resolution.data.name)
      const originalTarget = resolution.data.targetId as PlayerId
      const owner = p(host.state, ownerId)
      if (!owner?.alive) return
      const cardId = `virtual:${GANMI_CHANJUAN}:${host.state.seq + 1}:${host.state.decisions.length}`
      const category = ['杀', '桃', '酒'].includes(name) ? 'basic' : 'trick'
      host.state.cards[cardId] = { id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name,
        suit: 'spade', rank: 1, color: 'black', category, virtual: true, sourceSkillId: GANMI_CHANJUAN }
      owner.zones.hand.push(cardId)
      const actions = declaredCardActions(host.state, ownerId, cardId, name, `【婵娟】使用【${name}】`, { sourceSkillId: GANMI_CHANJUAN })
        .filter((action) => action.kind === 'use-card')
      if (!actions.length) { owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId); delete host.state.cards[cardId]; return }
      const uses = s74(host.state).chanjuanUses ??= {}
      const key = `${ownerId}:${host.state.turnNumber}:${name}`
      if ((uses[key] ?? 0) >= 2) { owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId); delete host.state.cards[cardId]; return }
      uses[key] = (uses[key] ?? 0) + 1
      s74(host.state).chanjuanRepeats ??= {}
      s74(host.state).chanjuanRepeats[cardId] = { targetId: originalTarget }
      makeOption(host, GANMI_CHANJUAN, ownerId, 'repeat-use', ownerId, `【婵娟】：选择【${name}】的合法使用目标`,
        actions.map((action) => ({ id: action.id, label: action.label })), { cardId, name })
      return
    }
    if (resolution.step === 'repeat-use') {
      const cardId = resolution.data.cardId as CardId
      const owner = p(host.state, ownerId)
      const selected = (response.payload as { optionId?: string }).optionId
      if (!owner?.zones.hand.includes(cardId)) { delete host.state.cards[cardId]; delete s74(host.state).chanjuanRepeats?.[cardId]; return }
      const actions = declaredCardActions(host.state, ownerId, cardId, String(resolution.data.name), `【婵娟】使用【${resolution.data.name}】`,
        { sourceSkillId: GANMI_CHANJUAN }).filter((action) => action.kind === 'use-card')
      const action = actions.find((candidate) => candidate.id === selected && candidate.kind === 'use-card')
      if (action?.kind === 'use-card') executeUseCardAction(host as never, ownerId, action)
      else {
        owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId)
        delete host.state.cards[cardId]
        delete s74(host.state).chanjuanRepeats?.[cardId]
      }
    }
  },
})

const GANMI_XUNBIE_IMMUNITY = sid('xunbie-immunity-ganmifuren')
registerSkillRuntime({ id: GANMI_XUNBIE_IMMUNITY,
  interceptGlobalIncomingDamage(host, ownerId, targetId) {
    return ownerId === targetId && s74(host.state).xunbieImmune?.[ownerId] === host.state.turnNumber
  },
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    if ((context.event.payload as { turnNumber?: number }).turnNumber !== host.state.turnNumber
      || s74(host.state).xunbieImmune?.[ownerId] !== host.state.turnNumber) return
    delete s74(host.state).xunbieImmune[ownerId]
    const player = p(host.state, ownerId)
    if (player) player.temporaryGrantedSkills = (player.temporaryGrantedSkills ?? []).filter((entry) => entry.source !== GANMI_XUNBIE)
  } }],
})
registerSkillRuntime({ id: GANMI_XUNBIE,
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || s74(host.state).xunbieUsed?.[ownerId]) return
    const choices = [{ id: 'ganfuren', label: '甘夫人' }, { id: 'mi-furen', label: '糜夫人' }]
      .filter((choice) => !living(host.state).some((player) => player.id !== ownerId && player.characterId === choice.id))
    if (!choices.length) return
    host.askSkill({ skillId: GANMI_XUNBIE, ownerId, step: 'transform', data: { choices }, build: (id) => ({ id, kind: 'choose-option',
      playerId: ownerId, prompt: '【殉别】：将武将牌改为一名场上没有的甘夫人或糜夫人', timeoutMs: 25_000,
      optional: true, options: choices.map(({ id: optionId, label }) => ({ id: optionId, label })) }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'transform') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const choices = resolution.data.choices as Array<{ id: string; label: string }>
    const selected = choices.find((choice) => choice.id === optionId)
    const player = p(host.state, ownerId)
    if (!selected || !player || living(host.state).some((other) => other.id !== ownerId && other.characterId === selected.id)) return
    s74(host.state).xunbieUsed ??= {}
    s74(host.state).xunbieUsed[ownerId] = true
    player.characterId = selected.id
    host.dispatch('GeneralSlotChanged', { playerId: ownerId, slot: 'main', characterId: selected.id, revealed: true }, { targetId: ownerId })
    recoverTo(host as never, ownerId, 1, ownerId, GANMI_XUNBIE)
    s74(host.state).xunbieImmune ??= {}
    s74(host.state).xunbieImmune[ownerId] = host.state.turnNumber
    replaceTemporarySkill(host.state, ownerId, GANMI_XUNBIE, GANMI_XUNBIE_IMMUNITY)
  },
})

registerSkillRuntime({ id: QINYILU_ZHUILI, triggers: [{ event: 'TargetConfirmed', handle(host, ownerId, context) {
  const payload = context.event.payload as { cardId?: CardId }
  if (context.event.targetId !== ownerId || context.event.sourceId === ownerId || !payload.cardId
    || effectiveCardColor(host.state, ownerId, payload.cardId) !== 'black'
    || s74(host.state).zhuiliDisabled?.[ownerId] === host.state.turnNumber) return
  if (conversionStateOf(host.state, ownerId, QINYILU_PIAOPING) === 'yin') {
    const state = toggleConversionState(host.state, ownerId, QINYILU_PIAOPING)
    host.dispatch('ConversionStateToggled', { playerId: ownerId, skillId: QINYILU_PIAOPING, state }, { sourceId: ownerId, sourceSkillId: QINYILU_ZHUILI })
    return
  }
  s74(host.state).tuoxianQuota ??= {}
  s74(host.state).tuoxianQuota[ownerId] = Number(s74(host.state).tuoxianQuota[ownerId] ?? 1) + 1
  if (s74(host.state).tuoxianQuota[ownerId] > 3) {
    s74(host.state).zhuiliDisabled ??= {}
    s74(host.state).zhuiliDisabled[ownerId] = host.state.turnNumber
  }
} }] })

export const HISTORICAL_BATCH74_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'liyixiejing-b74', name: '李异谢旌', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LIYI_DOUZHEN, name: '斗阵', description: '转换技，锁定技，你的回合内，阳：你须将黑色基本牌当【决斗】使用并获得目标一张牌；阴：你须将红色基本牌当无次数限制的【杀】使用或打出。', locked: true },
  ] },
  { id: 'sunhuan-b74', name: '孙桓', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SUNHUAN_NIJI, name: '逆击', description: '当你成为基本牌或锦囊牌的目标后，你可以摸一张牌。每个结束阶段，你弃置所有本回合以此法摸到的牌。弃牌前你可以先使用其中一张牌。' },
  ] },
  { id: 'zhangyao-b74', name: '张媱', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGYAO_YUYU, name: '怨语', description: '出牌阶段限一次，你可以摸一张牌并将一张手牌置于武将牌上，称为“怨”。然后选择一名其他角色，你与其的弃牌阶段开始时，或该角色每次造成1点伤害后，其须放置一张“怨”直到你触发“夕颜”。' },
    { id: ZHANGYAO_XIYAN, name: '夕颜', description: '每次增加“怨”时，若“怨”的花色数达到4种，你可以获得所有“怨”。然后若此时是你的回合，你的“怨语”视为未发动过，本回合手牌上限+4且使用牌无次数限制；若不是你的回合，你可令当前回合角色本回合手牌上限-4且本回合不能使用基本牌。' },
  ] },
  { id: 'quanhui-b74', name: '全惠解', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: QUANHUI_HUISHU, name: '慧淑', description: '摸牌阶段结束时，你可以摸3张牌然后弃置1张手牌。若如此做，你本回合弃置超过2张牌时，从弃牌堆中随机获得等量的非基本牌。' },
    { id: QUANHUI_YISHU, name: '易数', description: '锁定技，当你于出牌阶段外失去牌后，“慧淑”中最小的一个数字+2且最大的一个数字-1。', locked: true },
    { id: QUANHUI_LIGONG, name: '离宫', description: '觉醒技，准备阶段，若“慧淑”有数字达到5，你加1点体力上限并回复1点体力，失去“慧淑”和“易数”，然后从已开通的随机四个吴国女性武将中选择至多两个技能获得（如果不获得技能则不失去“慧淑”并摸三张牌）。' },
  ] },
  { id: 'xielingyu-b74', name: '谢灵毓', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: XIELINGYU_YUANDI, name: '元嫡', description: '其他角色于其出牌阶段使用第一张牌时，若此牌没有选择除该角色以外的角色为目标，你可以选择一项：1.弃置其一张手牌；2.你与其各摸一张牌。' },
    { id: XIELINGYU_XINYOU, name: '心幽', description: '出牌阶段限一次，你可以回满体力并将手牌摸至体力上限。若你因此摸超过2张牌，结束阶段你失去1点体力；若你因此回复体力，结束阶段你弃置一张牌。' },
  ] },
  { id: 'ganmifuren-b74', name: '甘夫人糜夫人', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: GANMI_CHANJUAN, name: '婵娟', description: '你使用手中指定唯一目标的基本牌或普通锦囊牌结算完毕后，可视为使用一张此牌，若目标与之前完全相同，你摸一张牌。每种牌名限两次。' },
    { id: GANMI_XUNBIE, name: '殉别', description: '限定技，当你进入濒死状态时，你可以将武将牌改为甘夫人或糜夫人（不能选择场上已有的武将），然后回复体力至1并防止所有伤害直到回合结束。' },
  ] },
  { id: 'wuban-b74', name: '吴班', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WUBAN_YOUZHAN, name: '诱战', description: '锁定技，其他角色在你的回合失去牌后，你摸一张牌且此牌本回合不计手牌上限，其本回合下次受到伤害+1。结束阶段，若该角色本回合未受伤，其摸X张牌（X为其本回合失去的牌的次数且最多为3）。', locked: true },
  ] },
  { id: 'furongfuqian-b74', name: '傅肜傅佥', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: FURONG_XUEWEI, name: '血卫', description: '结束阶段，你可以选择一名体力值小于等于你的角色。直到你的下回合开始前，该角色每次受到伤害时，防止此伤害，然后你失去1点体力并与其各摸一张牌。' },
    { id: FURONG_YUGUAN, name: '御关', description: '每个回合结束时，若你是损失体力值最多的角色，你可以减1点体力上限，然后令X名角色将手牌摸至体力上限（X为你已损失的体力值）。' },
  ] },
  { id: 'gaoxiang-b74', name: '高翔', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GAOXIANG_CHIYING, name: '驰应', description: '出牌阶段限一次，你可以选择一名体力值小于等于你的角色，其可以选择弃置其攻击范围内任意名其他角色各一张牌。若你选择的是其他角色，该角色获得其中的基本牌。' },
  ] },
  { id: 'qinyilu-b74', name: '秦宜禄', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: QINYILU_PIAOPING, name: '漂萍', description: '锁定技，转换技，当你使用一张牌时，阳：你摸X张牌；阴：你弃置X张牌。（X为本回合“漂萍”发动次数且至多为你当前体力值）', locked: true },
    { id: QINYILU_TUOXIAN, name: '托献', description: '每局游戏限一次，当你因“漂萍”弃置牌时，你可以改为将这些牌交给一名其他角色，然后令该角色选择一项：1.其弃置其区域内等量的牌；2.令你的“漂萍”技能本回合失效。' },
    { id: QINYILU_ZHUILI, name: '惴栗', description: '锁定技，当你成为其他角色使用黑色牌的目标时，若此时你的“漂萍”技能状态为：阳，令你的“托献”技能使用次数+1，然后若“托献”可使用次数超过3，则此技能本回合失效；阴，令你的“漂萍”状态转换为阳。', locked: true },
  ] },
]
