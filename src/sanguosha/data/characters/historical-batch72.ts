import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { EventContext, GameEventName } from '../../engine/events'
import type { CharacterDefinition } from './types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { getSkillRuntime, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { gainMaxHp, loseHp, loseMaxHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { resolveDamage, resumeDamageModifier } from '../../engine/damage'
import { discardCardsByIds } from '../../engine/discard-all'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { getAttackRange, getDistance } from '../../engine/distance'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { legalPlayActions } from '../../engine/cards/basic'
import { setChained } from '../../engine/character-state'
import { reshuffleDrawPile } from '../../engine/deck'
import { ALL_CHARACTERS } from './standard'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { hiddenHandSlot } from '../../engine/cards/host'

const B = '-b72'
const sid = (name: string) => `${name}${B}`
const MANGYACHANG_JIEDAO = sid('jiedao-mangyachang')
const GUANLU_TUIYAN = sid('tuiyan-guanlu')
const GUANLU_BUSUAN = sid('busuan-guanlu')
const GUANLU_MINGJIE = sid('mingjie-guanlu')
const XUSHAO_PINGJIAN = sid('pingjian-xushao')
const DUKUI_FANYIN = sid('fanyin-dukui')
const DUKUI_PEIQI = sid('peiqi-dukui')
const XINGDAORONG_XUHE = sid('xuhe-xingdaorong')
const CAIYANG_XUNJI = sid('xunji-caiyang')
const CAIYANG_JIAOFENG = sid('jiaofeng-caiyang')
const ZHOUSHAN_MIYUN = sid('miyun-zhoushan')
const ZHOUSHAN_DANYING = sid('danying-zhoushan')
const WANNIANZHENGZHUGONGZHEN = sid('zhengzhu-wanniangongzhu')
const WANNIANXINGHAN = sid('xinghan-wanniangongzhu')
const CAIMAOSHANGLIANZHOU = sid('lianzhou-caimaozhangyun')
const CAIMAOSHANGJINGLAN = sid('jinglan-caimaozhangyun')
const WANGTAO_HUGUAN = sid('huguan-wangtao')
const WANGTAO_YAOPEI = sid('yaopei-wangtao')

type B72State = SanguoshaState & { b72?: Record<string, any> }
const stateOf = (state: SanguoshaState) => (state as B72State).b72 ??= {}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
const living = (state: SanguoshaState) => state.players.filter((player) => player.alive)

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  if (!options.length) return
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  cardIds: CardId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true,
  viewOnlyCardIds: CardId[] = []) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill',
    cardIds, viewOnlyCardIds, hiddenCardSlots: [], min, max,
  }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  candidateIds: PlayerId[], min: number, max: number, prompt: string, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId, prompt, timeoutMs: 25_000, optional, candidateIds, min, max,
  }) })
}

registerSkillRuntime({
  id: MANGYACHANG_JIEDAO,
  offersDamageModifierAsk(host, ownerId, side, context) {
    const owner = playerOf(host.state, ownerId)
    const damageKey = `${ownerId}:${host.state.turnNumber}`
    if (side !== 'source' || context.sourceId !== ownerId || !owner?.alive
      || stateOf(host.state).jiedaoUsed?.[damageKey] || stateOf(host.state).jiedaoPending?.[damageKey]) return false
    const maxBonus = Math.max(0, owner.maxHp - owner.hp)
    host.askSkill({ skillId: MANGYACHANG_JIEDAO, ownerId, step: 'bonus', data: { damageKey, targetId: context.targetId, maxBonus },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【截刀】：此伤害增加多少（至多${maxBonus}）？`, timeoutMs: 25_000, optional: true,
        options: Array.from({ length: maxBonus + 1 }, (_, index) => ({ id: String(index), label: index ? `增加${index}点伤害` : '不增加' })) }) })
    return true
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const p = context.event.payload as { finalAmount?: number }
      const targetId = context.event.targetId
      const key = `${ownerId}:${host.state.turnNumber}`
      const pending = stateOf(host.state).jiedaoPending?.[key]
      if (!pending || context.event.sourceId !== ownerId || targetId !== pending.targetId) return
      delete stateOf(host.state).jiedaoPending[key]
      if ((p.finalAmount ?? 0) <= 0) return
      stateOf(host.state).jiedaoUsed ??= {}
      stateOf(host.state).jiedaoUsed[key] = true
      if (pending.bonus <= 0 || !playerOf(host.state, targetId!)?.alive) return
      const owner = playerOf(host.state, ownerId)
      const available = owner ? owner.zones.hand.length + Object.values(owner.zones.equipment).filter(Boolean).length : 0
      const count = Math.min(pending.bonus, available)
      if (count) host.queueSkill({ skillId: MANGYACHANG_JIEDAO, ownerId, step: 'discard', data: { count } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      for (const key of Object.keys(stateOf(host.state).jiedaoUsed ?? {})) if (key.startsWith(`${ownerId}:`) && Number(key.split(':').at(-1)) <= turn) delete stateOf(host.state).jiedaoUsed[key]
      for (const key of Object.keys(stateOf(host.state).jiedaoPending ?? {})) if (key.startsWith(`${ownerId}:`) && Number(key.split(':').at(-1)) <= turn) delete stateOf(host.state).jiedaoPending[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const available = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    const count = Math.min(Number(prompt.data.count), available.length)
    if (count) askCards(host, MANGYACHANG_JIEDAO, ownerId, 'discard', ownerId, available, count, count,
      `【截刀】：弃置${count}张牌`, {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'bonus') {
      const damageKey = resolution.data.damageKey as string
      const bonus = Math.max(0, Math.min(Number(resolution.data.maxBonus), Number((response.payload as { optionId?: string }).optionId ?? 0)))
      stateOf(host.state).jiedaoPending ??= {}
      stateOf(host.state).jiedaoPending[damageKey] = { targetId: resolution.data.targetId, bonus }
      resumeDamageModifier(host as never, MANGYACHANG_JIEDAO, bonus)
      return
    }
    if (resolution.step === 'discard') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const valid = ids.filter((id) => owner && (owner.zones.hand.includes(id)
        || Object.values(owner.zones.equipment).includes(id)))
      if (valid.length) discardCardsByIds(host as never, ownerId, valid, MANGYACHANG_JIEDAO)
    }
  },
})

registerSkillRuntime({
  id: GUANLU_TUIYAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (p.playerId !== ownerId || p.phase !== 'play' || usedThisPhase(host.state, ownerId, GUANLU_TUIYAN)) return
    const top = host.state.zones.drawPile.slice(0, 3)
    if (top.length) host.queueSkill({ skillId: GUANLU_TUIYAN, ownerId, step: 'offer', data: { top } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askOption(host, GUANLU_TUIYAN, ownerId, 'offer', ownerId, '【推演】：是否观看牌堆顶三张牌？',
        [{ id: 'yes', label: '观看' }], prompt.data)
      return
    }
    if (prompt.step === 'view') {
      const top = (prompt.data.top as CardId[]).filter((id) => host.state.zones.drawPile.includes(id))
      if (!top.length) return
      askCards(host, GUANLU_TUIYAN, ownerId, 'view', ownerId, [], 0, 0, '【推演】：观看牌堆顶三张牌', {}, false, top)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer' && (response.payload as { optionId?: string }).optionId === 'yes')
      host.queueSkill({ skillId: GUANLU_TUIYAN, ownerId, step: 'view', data: resolution.data })
  },
})

registerSkillRuntime({
  id: GUANLU_BUSUAN,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, GUANLU_BUSUAN)
      && living(state).some((p) => p.id !== ownerId) ? [{ id: `skill:${GUANLU_BUSUAN}`, label: '发动【卜算】' }] : []
  },
  invokeActive(host, ownerId) {
    const targets = living(host.state).filter((p) => p.id !== ownerId).map((p) => p.id)
    if (targets.length) askTargets(host, GUANLU_BUSUAN, ownerId, 'target', ownerId, targets, 1, 1, '【卜算】：选择一名其他角色', {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const names = [...new Set(Object.values(host.state.cards).filter((card) => card.category === 'basic' || card.category === 'trick')
        .map((card) => card.name))]
      stateOf(host.state).busuan ??= {}
      stateOf(host.state).busuan[ownerId] = { targetId, names: [] }
      askOption(host, GUANLU_BUSUAN, ownerId, 'name1', ownerId, '【卜算】：选择第一种牌名', names.map((name) => ({ id: name, label: name })), { targetId }, false)
      return
    }
    if (resolution.step === 'name1' || resolution.step === 'name2') {
      const targetId = resolution.data.targetId as PlayerId
      const name = (response.payload as { optionId?: string }).optionId
      if (!name || !playerOf(host.state, targetId)?.alive) return
      const entry = (stateOf(host.state).busuan as Record<string, { names: string[]; targetId: PlayerId; turnNumber?: number; armed?: boolean }>)[ownerId]
      if (name !== 'done') entry.names.push(name)
      const remaining = [...new Set(Object.values(host.state.cards).filter((card) => card.category === 'basic' || card.category === 'trick')
        .map((card) => card.name))].filter((candidate) => !entry.names.includes(candidate))
      if (resolution.step === 'name1' && remaining.length)
        askOption(host, GUANLU_BUSUAN, ownerId, 'name2', ownerId, '【卜算】：可选择第二种不同牌名，或结束选择',
          [{ id: 'done', label: '结束选择' }, ...remaining.map((candidate) => ({ id: candidate, label: candidate }))], { targetId }, true)
      else {
        entry.turnNumber = host.state.turnNumber
        entry.targetId = targetId
        entry.armed = true
        markUsedThisPhase(host.state, ownerId, GUANLU_BUSUAN)
      }
      return
    }
  },
  triggers: [{ event: 'DrawAttempt', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; count?: number; isDraw?: boolean; replacementCardIds?: CardId[] }
    const entry = stateOf(host.state).busuan?.[ownerId]
    if (context.cancelled || !p.isDraw || p.playerId !== entry?.targetId || !entry.armed
      || host.state.phase !== 'draw' || host.state.currentPlayerId !== p.playerId) return
    const names = entry.names as string[]
    const chosen: CardId[] = []
    for (const name of names) {
      let cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.name === name)
      if (!cardId) cardId = host.state.zones.discardPile.find((id) => host.state.cards[id]?.name === name)
      if (!cardId) continue
      const from = locateOwnedCard(host.state, ownerId, cardId)
      const fromZone = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : from
      if (fromZone) { moveCard(host.state, cardId, fromZone, { kind: 'hand', playerId: p.playerId! }); chosen.push(cardId) }
    }
    delete entry.armed
    delete stateOf(host.state).busuan[ownerId]
    p.replacementCardIds = chosen
    if (chosen.length) host.dispatch('GainCard', { playerId: p.playerId, cardIds: chosen, reason: GUANLU_BUSUAN, isDraw: true }, { targetId: p.playerId, cardIds: chosen })
    context.cancel()
  } }, { event: 'PhaseSkipped', handle(host, _ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const entries = (stateOf(host.state).busuan ?? {}) as Record<string, { targetId?: PlayerId }>
    if (p.phase === 'draw' && p.playerId) for (const [ownerId, entry] of Object.entries(entries))
      if (entry.targetId === p.playerId) delete stateOf(host.state).busuan[ownerId]
  } }],
})

registerSkillRuntime({
  id: GUANLU_MINGJIE,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (p.playerId === ownerId && p.phase === 'finish' && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: GUANLU_MINGJIE, ownerId, step: 'offer', data: { count: 0 } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    if (prompt.step === 'offer') {
      askOption(host, GUANLU_MINGJIE, ownerId, 'offer', ownerId, '【命戒】：是否摸一张牌？',
        [{ id: 'yes', label: '摸一张牌' }], {}, true)
      return
    }
    if (prompt.step !== 'draw') return
    const count = Number(prompt.data.count)
    const cards = drawCards(host.state, host.rng, ownerId, 1)
    const id = cards[0]
    if (!id) return
    if (host.state.cards[id]?.color === 'black') {
      if ((playerOf(host.state, ownerId)?.hp ?? 1) > 1) loseHp(host as never, ownerId, 1, GUANLU_MINGJIE)
      return
    }
    if (count < 2) askOption(host, GUANLU_MINGJIE, ownerId, 'repeat', ownerId, '【命戒】：此牌为红色，是否继续摸牌？',
      [{ id: 'yes', label: '继续' }], { count: count + 1 })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer' && (response.payload as { optionId?: string }).optionId === 'yes') {
      host.queueSkill({ skillId: GUANLU_MINGJIE, ownerId, step: 'draw', data: { count: 0 } })
      return
    }
    if (resolution.step === 'repeat' && (response.payload as { optionId?: string }).optionId === 'yes')
      host.queueSkill({ skillId: GUANLU_MINGJIE, ownerId, step: 'draw', data: resolution.data })
  },
})

registerSkillRuntime({ id: CAIMAOSHANGLIANZHOU,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (p.playerId !== ownerId || p.phase !== 'prepare') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    setChained(host as never, ownerId, CAIMAOSHANGLIANZHOU, true)
    const targets = living(host.state).filter((player) => player.id !== ownerId && player.hp === owner.hp).map((player) => player.id)
    if (targets.length) host.queueSkill({ skillId: CAIMAOSHANGLIANZHOU, ownerId, step: 'chain-targets', data: { targets } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'chain-targets') return
    const targets = (prompt.data.targets as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
    if (targets.length) askTargets(host, CAIMAOSHANGLIANZHOU, ownerId, 'chain-targets', ownerId, targets, 0, targets.length,
      '【连舟】：选择任意名体力值等于你的角色横置', {}, false)
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'chain-targets') return
    const targets = new Set((resolution.data.targets as PlayerId[]))
    for (const targetId of (response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
      if (targets.has(targetId) && playerOf(host.state, targetId)?.alive)
        setChained(host as never, targetId, CAIMAOSHANGLIANZHOU, true)
  },
})

registerSkillRuntime({
  id: WANGTAO_HUGUAN,
  globalHandLimitExempt(state, ownerId, targetId, cardId) {
    const record = stateOf(state).huguan?.[`${ownerId}:${targetId}:${state.turnNumber}`]
    if (!record || !state.players.some((player) => player.id === ownerId && player.alive)) return false
    return effectiveCardSuit(state, targetId, cardId) === record.suit
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.phase !== 'play' || !p.playerId) return
      stateOf(host.state).huguanFirstCard ??= {}
      stateOf(host.state).huguanFirstCard[`${ownerId}:${p.playerId}:${host.state.turnNumber}`] = true
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string }
      const actorId = context.event.sourceId
      if (!actorId || actorId === ownerId) return
      const key = `${ownerId}:${actorId}:${host.state.turnNumber}`
      if (!stateOf(host.state).huguanFirstCard?.[key]) return
      delete stateOf(host.state).huguanFirstCard[key]
      const cardIds = p.cardIds?.length ? p.cardIds : p.cardId ? [p.cardId] : []
      const isRed = cardIds.some((id) => host.state.cards[id]?.color === 'red')
      if (!isRed) return
      host.queueSkill({ skillId: WANGTAO_HUGUAN, ownerId, step: 'suit', data: { actorId } })
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const endedTurn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      for (const key of Object.keys(stateOf(host.state).huguan ?? {}))
        if (Number(key.split(':').at(-1)) <= endedTurn) delete stateOf(host.state).huguan[key]
      for (const key of Object.keys(stateOf(host.state).huguanFirstCard ?? {}))
        if (Number(key.split(':').at(-1)) <= endedTurn) delete stateOf(host.state).huguanFirstCard[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'suit') return
    const actorId = prompt.data.actorId as PlayerId
    if (!playerOf(host.state, actorId)?.alive) return
    askOption(host, WANGTAO_HUGUAN, ownerId, 'suit', ownerId,
      `【护关】：声明一个花色，本回合${playerOf(host.state, actorId)?.nickname ?? '该角色'}手牌中的此花色不计入手牌上限`,
      [{ id: 'spade', label: '♠️' }, { id: 'heart', label: '♥️' }, { id: 'club', label: '♣️' }, { id: 'diamond', label: '♦️' }],
      { actorId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'suit') return
    const suit = (response.payload as { optionId?: string }).optionId
    const actorId = resolution.data.actorId as PlayerId
    if (!['spade', 'heart', 'club', 'diamond'].includes(suit ?? '') || !playerOf(host.state, actorId)?.alive) return
    stateOf(host.state).huguan ??= {}
    stateOf(host.state).huguan[`${ownerId}:${actorId}:${host.state.turnNumber}`] = { suit }
    stateOf(host.state).yaopeiTargets ??= {}
    stateOf(host.state).yaopeiTargets[`${ownerId}:${actorId}:${host.state.turnNumber}`] = true
  },
})

function askDiscardFromRole(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, index: number, targets: PlayerId[]) {
  const choices = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
  if (!choices.cardIds.length && !choices.hiddenCardSlots.length) {
    host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'discard-next', data: { index: index + 1, targets } })
    return
  }
  host.askSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'discard-one', data: { targetId, index, targets }, build: (id) => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【虚猲】：选择弃置${playerOf(host.state, targetId)?.nickname ?? '该角色'}的一张牌`,
    timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: choices.cardIds,
    hiddenCardSlots: choices.hiddenCardSlots, min: 1, max: 1,
  }) })
}

registerSkillRuntime({
  id: XINGDAORONG_XUHE,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId === ownerId && p.phase === 'play' && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'start-offer', data: {} })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId !== ownerId || p.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.maxHp >= Math.max(...living(host.state).map((player) => player.maxHp))) return
      host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'end-offer', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'start-offer') {
      askOption(host, XINGDAORONG_XUHE, ownerId, 'start-offer', ownerId, '【虚猲】：是否减1点体力上限并执行效果？',
        [{ id: 'yes', label: '发动' }])
      return
    }
    if (prompt.step === 'mode') {
      const targets = (prompt.data.targets as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      if (!targets.length) return
      askOption(host, XINGDAORONG_XUHE, ownerId, 'mode', ownerId, '【虚猲】：令这些角色各弃置一张牌，或各摸一张牌？',
        [{ id: 'discard', label: '你弃置其各一张牌' }, { id: 'draw', label: '这些角色各摸一张牌' }], { targets }, false)
      return
    }
    if (prompt.step === 'discard-next') {
      const targets = (prompt.data.targets as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      const index = Number(prompt.data.index)
      if (index < targets.length) askDiscardFromRole(host, ownerId, targets[index]!, index, targets)
      return
    }
    if (prompt.step === 'end-offer')
      askOption(host, XINGDAORONG_XUHE, ownerId, 'end-choice', ownerId, '【虚猲】：增加1点体力上限后，选择一项',
        [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸两张牌' }], {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'start-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.maxHp <= 1) return
      loseMaxHp(host as never, ownerId, 1, XINGDAORONG_XUHE)
      const targets = living(host.state).filter((player) => getDistance(host.state, ownerId, player.id) <= 1).map((player) => player.id)
      if (targets.length) host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'mode', data: { targets } })
      return
    }
    if (resolution.step === 'mode') {
      const option = (response.payload as { optionId?: string }).optionId
      const targets = (resolution.data.targets as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      if (option === 'draw') {
        for (const targetId of targets) drawCards(host.state, host.rng, targetId, 1)
      } else if (option === 'discard') host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'discard-next', data: { index: 0, targets } })
      return
    }
    if (resolution.step === 'discard-one') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected && resolvePickedCard(host.state, targetId, selected)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      host.queueSkill({ skillId: XINGDAORONG_XUHE, ownerId, step: 'discard-next',
        data: { index: Number(resolution.data.index) + 1, targets: resolution.data.targets } })
      return
    }
    if (resolution.step === 'end-choice') {
      const option = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      gainMaxHp(host as never, ownerId, 1, XINGDAORONG_XUHE)
      if (option === 'recover') recover(host as never, ownerId, 1, XINGDAORONG_XUHE)
      else if (option === 'draw') drawCards(host.state, host.rng, ownerId, 2)
    }
  },
})

registerSkillRuntime({
  id: CAIYANG_XUNJI,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, CAIYANG_XUNJI)
      && living(state).some((player) => player.id !== ownerId)
      ? [{ id: `skill:${CAIYANG_XUNJI}`, label: '发动【寻嫉】' }] : []
  },
  invokeActive(host, ownerId) {
    const targets = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
    if (targets.length) askTargets(host, CAIYANG_XUNJI, ownerId, 'target', ownerId, targets, 1, 1, '【寻嫉】：选择一名其他角色', {}, false)
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId }
      const record = stateOf(host.state).xunji?.[ownerId]
      if (record?.targetId === p.playerId && playerOf(host.state, ownerId)?.alive)
        stateOf(host.state).xunji[ownerId] = { ...record, active: true, usedBlack: false, turnNumber: host.state.turnNumber }
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const record = stateOf(host.state).xunji?.[ownerId]
      const actorId = context.event.sourceId
      if (!record?.active || record.targetId !== actorId || record.turnNumber !== host.state.turnNumber) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const ids = payload.cardIds?.length ? payload.cardIds : payload.cardId ? [payload.cardId] : []
      if (ids.some((id) => host.state.cards[id]?.color === 'black')) record.usedBlack = true
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const record = stateOf(host.state).xunji?.[ownerId]
      if (!record?.active || p.playerId !== record.targetId || p.phase !== 'finish' || record.turnNumber !== host.state.turnNumber) return
      record.active = false
      if (record.usedBlack && playerOf(host.state, ownerId)?.alive && playerOf(host.state, record.targetId)?.alive)
        host.queueSkill({ skillId: CAIYANG_XUNJI, ownerId, step: 'duel-offer', data: { targetId: record.targetId } })
      else delete stateOf(host.state).xunji[ownerId]
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const p = context.event.payload as { finalAmount?: number }
      const record = stateOf(host.state).xunji?.[ownerId]
      if (context.event.sourceSkillId !== CAIYANG_XUNJI || context.event.sourceId !== ownerId
        || context.event.targetId !== record?.targetId || (p.finalAmount ?? 0) <= 0) return
      delete stateOf(host.state).xunji[ownerId]
      resolveDamage(host as never, { sourceId: record.targetId, targetId: ownerId, amount: p.finalAmount, sourceSkillId: CAIYANG_XUNJI })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const record = stateOf(host.state).xunji?.[ownerId]
      if (context.event.sourceSkillId === CAIYANG_XUNJI && context.event.sourceId === ownerId && record)
        delete stateOf(host.state).xunji[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'duel-offer') return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    askOption(host, CAIYANG_XUNJI, ownerId, 'duel-offer', ownerId,
      `【寻嫉】：是否视为对${playerOf(host.state, targetId)?.nickname ?? '该角色'}使用【决斗】？`,
      [{ id: 'yes', label: '使用【决斗】' }], { targetId })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target' && resolution.step !== 'duel-offer') return
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      stateOf(host.state).xunji ??= {}
      stateOf(host.state).xunji[ownerId] = { targetId, active: false, usedBlack: false }
      markUsedThisPhase(host.state, ownerId, CAIYANG_XUNJI)
      return
    }
    if ((response.payload as { optionId?: string }).optionId !== 'yes') {
      delete stateOf(host.state).xunji?.[ownerId]
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    if (playerOf(host.state, ownerId)?.alive && playerOf(host.state, targetId)?.alive)
      host.beginVirtualTrick({ sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: CAIYANG_XUNJI })
    else delete stateOf(host.state).xunji?.[ownerId]
  },
})

registerSkillRuntime({
  id: CAIYANG_JIAOFENG,
  outgoingDamage(state, ownerId, context) {
    const key = `${ownerId}:${state.turnNumber}`
    if (stateOf(state).jiaofengUsed?.[key]) return null
    const owner = playerOf(state, ownerId)
    return owner && owner.maxHp - owner.hp > 1 ? { amount: context.amount + 1 } : null
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const p = context.event.payload as { finalAmount?: number }
    const key = `${ownerId}:${host.state.turnNumber}`
    if (context.event.sourceId !== ownerId || stateOf(host.state).jiaofengUsed?.[key] || (p.finalAmount ?? 0) <= 0) return
    stateOf(host.state).jiaofengUsed ??= {}
    stateOf(host.state).jiaofengUsed[key] = true
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const lostHp = owner.maxHp - owner.hp
    if (lostHp > 0) drawCards(host.state, host.rng, ownerId, 1)
    if (lostHp > 2) recover(host as never, ownerId, 1, CAIYANG_JIAOFENG)
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
    delete stateOf(host.state).jiaofengUsed?.[`${ownerId}:${turn}`]
  } }],
})

registerSkillRuntime({
  id: WANNIANZHENGZHUGONGZHEN,
  attackRangeBonus(state, ownerId) {
    return Object.values(stateOf(state).zhengzhu ?? {}).reduce((sum: number, entry: any) =>
      sum + (entry.targetId === ownerId ? Number(entry.bonus ?? 0) : 0), 0)
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (p.playerId === ownerId && p.phase === 'prepare' && playerOf(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: WANNIANZHENGZHUGONGZHEN, ownerId, step: 'target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'target') {
      const targets = living(host.state).map((player) => player.id)
      if (targets.length) askTargets(host, WANNIANZHENGZHUGONGZHEN, ownerId, 'target', ownerId, targets, 1, 1,
        '【枕戈】：选择一名角色，其本局攻击范围+1（至多+5）', {}, true)
      return
    }
    if (prompt.step === 'slash-offer') {
      const attackerId = prompt.data.attackerId as PlayerId
      const targets = living(host.state).filter((player) => player.id !== attackerId
        && getDistance(host.state, attackerId, player.id) <= getAttackRange(host.state, attackerId)).map((player) => player.id)
      if (targets.length) askOption(host, WANNIANZHENGZHUGONGZHEN, ownerId, 'slash-choice', ownerId,
        `【枕戈】：是否令${playerOf(host.state, attackerId)?.nickname ?? '该角色'}视为对一名攻击范围内角色使用【杀】？`,
        [{ id: 'yes', label: '使用【杀】' }], { attackerId, targets })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : null
      if (!targetId || !target?.alive) return
      stateOf(host.state).zhengzhu ??= {}
      const key = `${ownerId}:${targetId}`
      const old = stateOf(host.state).zhengzhu[key]?.bonus ?? 0
      if (old >= 5) return
      stateOf(host.state).zhengzhu[key] = { targetId, bonus: old + 1 }
      const allInRange = living(host.state).every((player) =>
        getDistance(host.state, targetId, player.id) <= getAttackRange(host.state, targetId))
      if (allInRange) host.queueSkill({ skillId: WANNIANZHENGZHUGONGZHEN, ownerId, step: 'slash-offer', data: { attackerId: targetId } })
      return
    }
    if (resolution.step === 'slash-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const attackerId = resolution.data.attackerId as PlayerId
      const targets = (resolution.data.targets as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive && id !== attackerId
        && getDistance(host.state, attackerId, id) <= getAttackRange(host.state, attackerId))
      if (targets.length) askTargets(host, WANNIANZHENGZHUGONGZHEN, ownerId, 'slash-target', ownerId, targets, 1, 1,
        '【枕戈】：选择【杀】的目标', { attackerId }, false)
      return
    }
    if (resolution.step === 'slash-target') {
      const attackerId = resolution.data.attackerId as PlayerId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, attackerId)?.alive && playerOf(host.state, targetId)?.alive)
        host.beginVirtualSlash({ sourceId: attackerId, targetId, sourceSkillId: WANNIANZHENGZHUGONGZHEN, countUsage: true })
    }
  },
})

registerSkillRuntime({
  id: WANNIANXINGHAN,
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cardIds?: CardId[] }
      if (payload.cardName !== '杀') return
      const key = String(host.state.turnNumber)
      const first = stateOf(host.state).xinghanFirstSlash ??= {}
      if (first[key]) return
      first[key] = { cardId: payload.cardId ?? payload.cardIds?.[0], sourceId: context.event.sourceId, settled: false }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number; cardId?: CardId; cardName?: string }
      const key = String(host.state.turnNumber)
      const first = stateOf(host.state).xinghanFirstSlash?.[key]
      if (!first || first.settled || (payload.finalAmount ?? 0) <= 0
        || first.sourceId !== context.event.sourceId || (first.cardId && first.cardId !== payload.cardId)
        || (payload.cardName && payload.cardName !== '杀')) return
      first.settled = true
      const usedOn = Object.entries(stateOf(host.state).zhengzhu ?? {}).some(([key, entry]: [string, any]) =>
        key.startsWith(`${ownerId}:`) && entry.targetId === first.sourceId)
      if (!usedOn || !playerOf(host.state, ownerId)?.alive) return
      const alive = living(host.state)
      const ownerHand = playerOf(host.state, ownerId)?.zones.hand.length ?? 0
      const most = Math.max(...alive.map((player) => player.zones.hand.length))
      const tied = alive.filter((player) => player.zones.hand.length === most).length !== 1 || ownerHand !== most
      const count = tied ? Math.min(5, Math.max(0, getAttackRange(host.state, first.sourceId))) : 1
      if (count) drawCards(host.state, host.rng, ownerId, count)
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      delete stateOf(host.state).xinghanFirstSlash?.[String(turn)]
    } },
  ],
})

registerSkillRuntime({
  id: CAIMAOSHANGJINGLAN,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    const owner = playerOf(host.state, ownerId)
    if (context.event.sourceId !== ownerId || (payload.finalAmount ?? 0) <= 0 || !owner?.alive) return
    if (owner.zones.hand.length > owner.hp)
      host.queueSkill({ skillId: CAIMAOSHANGJINGLAN, ownerId, step: 'discard-four', data: {} })
    else if (owner.zones.hand.length === owner.hp)
      host.queueSkill({ skillId: CAIMAOSHANGJINGLAN, ownerId, step: 'discard-one-recover', data: {} })
    else {
      stateOf(host.state).jinglanPending ??= {}
      stateOf(host.state).jinglanPending[ownerId] = true
      resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'fire', sourceSkillId: CAIMAOSHANGJINGLAN })
      const afterDamage = playerOf(host.state, ownerId)
      if (afterDamage?.alive && afterDamage.hp > 0 && stateOf(host.state).jinglanPending[ownerId]) {
        delete stateOf(host.state).jinglanPending[ownerId]
        drawCards(host.state, host.rng, ownerId, 5, (name, payload) => host.dispatch(name, payload))
      }
    }
  } },
    { event: 'QuitDying', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId
        || !stateOf(host.state).jinglanPending?.[ownerId] || !playerOf(host.state, ownerId)?.alive) return
      delete stateOf(host.state).jinglanPending[ownerId]
      drawCards(host.state, host.rng, ownerId, 5, (name, payload) => host.dispatch(name, payload))
    } },
    { event: 'Death', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        delete stateOf(host.state).jinglanPending?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'discard-four') {
      const count = Math.min(4, owner.zones.hand.length)
      if (count) askCards(host, CAIMAOSHANGJINGLAN, ownerId, 'discard-four', ownerId, [...owner.zones.hand], count, count,
        '【惊澜】：弃置四张手牌', {}, false)
      return
    }
    if (prompt.step === 'discard-one-recover') {
      const available = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
      if (!available.length) { recover(host as never, ownerId, 1, CAIMAOSHANGJINGLAN); return }
      askCards(host, CAIMAOSHANGJINGLAN, ownerId, 'discard-one-recover', ownerId, available, 1, 1,
        '【惊澜】：弃置一张牌并回复1点体力', {}, false)
    }
  },
  resume(host, ownerId, resolution, response) {
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !ids.length) return
    const valid = ids.filter((id) => owner.zones.hand.includes(id)
      || (resolution.step === 'discard-one-recover' && Object.values(owner.zones.equipment).includes(id)))
    const expected = resolution.step === 'discard-four' ? Math.min(4, owner.zones.hand.length) : 1
    if (valid.length !== expected) return
    discardCardsByIds(host as never, ownerId, valid, CAIMAOSHANGJINGLAN)
    if (resolution.step === 'discard-one-recover') recover(host as never, ownerId, 1, CAIMAOSHANGJINGLAN)
  },
})

registerSkillRuntime({
  id: ZHOUSHAN_MIYUN,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      const candidates = living(host.state).filter((player) => player.id !== ownerId)
        .filter((player) => { const cards = pickableCardsOf(host.state, player.id); return cards.cardIds.length + cards.hiddenCardSlots.length > 0 })
        .map((player) => player.id)
      if (candidates.length) host.queueSkill({ skillId: ZHOUSHAN_MIYUN, ownerId, step: 'take-target', data: { candidates } })
    } },
    { event: 'RoundEnd', handle(host, ownerId) {
      if (playerOf(host.state, ownerId)?.alive && living(host.state).some((player) => player.id !== ownerId))
        host.queueSkill({ skillId: ZHOUSHAN_MIYUN, ownerId, step: 'give-target', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'take-target') {
      const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      if (candidates.length) askTargets(host, ZHOUSHAN_MIYUN, ownerId, 'take-target', ownerId, candidates, 1, 1,
        '【密运】：选择一名其他角色，展示并获得其一张牌置于武将牌上，称为“安”', {}, false)
      return
    }
    if (prompt.step === 'give-target') {
      const candidates = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
      if (candidates.length) askTargets(host, ZHOUSHAN_MIYUN, ownerId, 'give-target', ownerId, candidates, 1, 1,
        '【密运】：选择一名其他角色，交给其任意张手牌（可包括“安”）', {}, false)
      return
    }
    if (prompt.step === 'give-cards') {
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const cards = [...owner.zones.hand]
      askCards(host, ZHOUSHAN_MIYUN, ownerId, 'give-cards', ownerId, cards, 0, cards.length,
        '【密运】：选择要交给该角色的任意张手牌及“安”', prompt.data, false)
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const pickable = pickableCardsOf(host.state, targetId)
      host.askSkill({ skillId: ZHOUSHAN_MIYUN, ownerId, step: 'take-card', data: { targetId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【密运】：选择展示并获得${playerOf(host.state, targetId)?.nickname ?? '该角色'}的一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pickable.cardIds,
        hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked && resolvePickedCard(host.state, targetId, picked)
      if (!cardId || !playerOf(host.state, ownerId)?.alive) return
      const moved = movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
      if (moved) {
        stateOf(host.state).anCards ??= {}
        stateOf(host.state).anCards[ownerId] ??= []
        stateOf(host.state).anCards[ownerId].push(cardId)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHOUSHAN_MIYUN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step === 'give-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive)
        host.queueSkill({ skillId: ZHOUSHAN_MIYUN, ownerId, step: 'give-cards', data: { targetId } })
      return
    }
    if (resolution.step === 'give-cards') {
      const owner = playerOf(host.state, ownerId)
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = [...new Set(selected)].filter((id) => owner.zones.hand.includes(id))
      const anCards = (stateOf(host.state).anCards?.[ownerId] ?? []) as CardId[]
      const givenAn = valid.filter((id) => anCards.includes(id))
      for (const cardId of valid) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      }
      stateOf(host.state).anCards[ownerId] = anCards.filter((id) => !valid.includes(id))
      if (valid.length) {
        host.dispatch('GainCard', { playerId: targetId, cardIds: valid, reason: ZHOUSHAN_MIYUN }, { sourceId: ownerId, targetId, cardIds: valid })
        host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: targetId, cardIds: valid, reason: ZHOUSHAN_MIYUN }, { sourceId: ownerId, targetId, cardIds: valid })
      }
      if (!givenAn.length) loseHp(host as never, ownerId, 1, ZHOUSHAN_MIYUN)
      const currentOwner = playerOf(host.state, ownerId)
      if (currentOwner?.alive) {
        const count = Math.max(0, currentOwner.maxHp - currentOwner.zones.hand.length)
        if (count) drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
      }
    }
  },
})

registerSkillRuntime({
  id: ZHOUSHAN_DANYING,
  viewAs(state, ownerId) {
    if (usedThisTurn(state, ownerId, ZHOUSHAN_DANYING)) return []
    const hand = playerOf(state, ownerId)?.zones.hand ?? []
    const anCards = (stateOf(state).anCards?.[ownerId] ?? []) as CardId[]
    const cards = hand.filter((cardId) => anCards.includes(cardId))
    return cards.flatMap((cardId) => [
      { asCardName: '杀', cardId, label: '【胆迎】：将“安”当【杀】使用' },
      { asCardName: '闪', cardId, label: '【胆迎】：将“安”当【闪】打出' },
    ])
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== ZHOUSHAN_DANYING) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const usedId = payload.cardId ?? payload.cardIds?.[0]
      const data = stateOf(host.state)
      data.anCards ??= {}
      if (usedId) data.anCards[ownerId] = ((data.anCards[ownerId] ?? []) as CardId[]).filter((id) => id !== usedId)
      markUsedThisTurn(host.state, ownerId, ZHOUSHAN_DANYING)
      data.danyingPending ??= {}
      data.danyingPending[ownerId] = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if ((payload.playerId ?? context.event.sourceId) !== ownerId || context.event.sourceSkillId !== ZHOUSHAN_DANYING) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const data = stateOf(host.state)
      data.anCards ??= {}
      if (cardId) data.anCards[ownerId] = ((data.anCards[ownerId] ?? []) as CardId[]).filter((id) => id !== cardId)
      markUsedThisTurn(host.state, ownerId, ZHOUSHAN_DANYING)
      data.danyingPending ??= {}
      data.danyingPending[ownerId] = true
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (payload.playerId !== ownerId || !payload.cardId) return
      const data = stateOf(host.state)
      if (data.anCards?.[ownerId]) data.anCards[ownerId] = data.anCards[ownerId].filter((id: CardId) => id !== payload.cardId)
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (!stateOf(host.state).danyingPending?.[ownerId] || context.event.targetId !== ownerId) return
      delete stateOf(host.state).danyingPending[ownerId]
      const sourceId = context.event.sourceId
      if (!sourceId || !playerOf(host.state, sourceId)?.alive) return
      const choices = pickableCardsOf(host.state, ownerId, { discarderId: sourceId })
      if (!choices.cardIds.length && !choices.hiddenCardSlots.length) return
      host.askSkill({ skillId: ZHOUSHAN_DANYING, ownerId, step: 'targeted-discard', data: { sourceId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: sourceId, prompt: `【胆迎】：弃置${playerOf(host.state, ownerId)?.nickname ?? '该角色'}的一张牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: choices.cardIds,
        hiddenCardSlots: choices.hiddenCardSlots, min: 1, max: 1,
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'targeted-discard') return
    const sourceId = resolution.data.sourceId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && resolvePickedCard(host.state, ownerId, selected)
    if (!cardId || !locateOwnedCard(host.state, ownerId, cardId) || !playerOf(host.state, sourceId)?.alive) return
    if (!movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHOUSHAN_DANYING }, { sourceId, targetId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: WANGTAO_YAOPEI,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    const targetId = p.playerId
    const currentTurn = host.state.turnNumber
    if (!targetId || targetId === ownerId || p.phase !== 'discard'
      || !stateOf(host.state).yaopeiTargets?.[`${ownerId}:${targetId}:${currentTurn}`]
      || !playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
    const ledger = host.state.discardPhaseLedger
    const spentSuits = new Set((ledger?.ownerPlayerId === targetId ? ledger.records : [])
      .filter((entry) => entry.sourcePlayerId === targetId)
      .map((entry) => effectiveCardSuit(host.state, targetId, entry.cardId)).filter(Boolean))
    const suits = (['spade', 'heart', 'club', 'diamond'] as const).filter((suit) => !spentSuits.has(suit))
    if (!suits.length) return
    host.queueSkill({ skillId: WANGTAO_YAOPEI, ownerId, step: 'discard-offer', data: { targetId, suits } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'discard-offer') {
      const targetId = prompt.data.targetId as PlayerId
      if (!playerOf(host.state, targetId)?.alive) return
      askOption(host, WANGTAO_YAOPEI, ownerId, 'discard-offer', ownerId,
        `【摇佩】：是否弃置${playerOf(host.state, targetId)?.nickname ?? '该角色'}一张本阶段未弃置过花色的牌？`,
        [{ id: 'yes', label: '弃置一张牌' }], prompt.data)
      return
    }
    if (prompt.step === 'choose-card') {
      const targetId = prompt.data.targetId as PlayerId
      const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
      const suits = new Set(prompt.data.suits as string[])
      const cardIds = pickable.cardIds.filter((id) => suits.has(effectiveCardSuit(host.state, targetId, id) ?? ''))
      const pickableHiddenSlots = new Set(pickable.hiddenCardSlots)
      const hiddenCardSlots = playerOf(host.state, targetId)?.zones.hand.flatMap((cardId, index) =>
        pickableHiddenSlots.has(hiddenHandSlot(targetId, index))
          && suits.has(effectiveCardSuit(host.state, targetId, cardId) ?? '') ? [hiddenHandSlot(targetId, index)] : []) ?? []
      if (!cardIds.length && !hiddenCardSlots.length) return
      host.askSkill({ skillId: WANGTAO_YAOPEI, ownerId, step: 'choose-card', data: prompt.data, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【摇佩】：选择${playerOf(host.state, targetId)?.nickname ?? '该角色'}一张花色符合条件的牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      host.queueSkill({ skillId: WANGTAO_YAOPEI, ownerId, step: 'choose-card', data: resolution.data })
      return
    }
    if (resolution.step === 'choose-card') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked && resolvePickedCard(host.state, targetId, picked)
      const suits = resolution.data.suits as string[]
      if (!cardId || !suits.includes(effectiveCardSuit(host.state, targetId, cardId) ?? '')
        || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: WANGTAO_YAOPEI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      askOption(host, WANGTAO_YAOPEI, ownerId, 'recover-choice', ownerId, '【摇佩】：选择回复体力的角色，另一名角色摸两张牌',
        [{ id: 'owner', label: '你回复1点体力，该角色摸两张牌' }, { id: 'target', label: '该角色回复1点体力，你摸两张牌' }], { targetId }, false)
      return
    }
    if (resolution.step === 'recover-choice') {
      const targetId = resolution.data.targetId as PlayerId
      const option = (response.payload as { optionId?: string }).optionId
      if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive) return
      if (option === 'owner') {
        recover(host as never, ownerId, 1, WANGTAO_YAOPEI)
        drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
      } else if (option === 'target') {
        recover(host as never, targetId, 1, WANGTAO_YAOPEI)
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      }
    }
  },
})

type PingjianTiming = 'play' | 'finish' | 'damaged'
type PingjianCandidate = { characterId: string; characterName: string; skillId: string; skillName: string; actionIds?: string[] }
function pingjianCandidates(state: SanguoshaState, ownerId: PlayerId, timing: PingjianTiming): PingjianCandidate[] {
  const owner = playerOf(state, ownerId)
  const used = new Set((stateOf(state).pingjianUsed?.[ownerId] ?? []) as string[])
  const candidates: PingjianCandidate[] = []
  for (const character of ALL_CHARACTERS) {
    if (character.pack === 'entertainment' || character.id === owner?.characterId) continue
    for (const skill of character.skills) {
      if (skill.locked || used.has(skill.id)) continue
      const runtime = getSkillRuntime(skill.id)
      if (!runtime || runtime.limited || runtime.awakening) continue
      if (timing === 'play') {
        const actionIds = runtime.activeActions?.(state, ownerId).map((action) => action.id) ?? []
        if (actionIds.length) candidates.push({ characterId: character.id, characterName: character.name, skillId: skill.id, skillName: skill.name, actionIds })
      } else {
        const eventName: GameEventName = timing === 'finish' ? 'PhaseStart' : 'Damaged'
        if (runtime.triggers?.some((trigger) => trigger.event === eventName))
          candidates.push({ characterId: character.id, characterName: character.name, skillId: skill.id, skillName: skill.name })
      }
    }
  }
  return candidates
}

function choosePingjian(host: SkillHost, ownerId: PlayerId, timing: PingjianTiming, data: Record<string, unknown> = {}) {
  const byCharacter = new Map<string, PingjianCandidate[]>()
  for (const item of pingjianCandidates(host.state, ownerId, timing)) {
    const list = byCharacter.get(item.characterId) ?? []
    list.push(item)
    byCharacter.set(item.characterId, list)
  }
  const candidates = host.rng.shuffle([...byCharacter.values()].map((list) => host.rng.shuffle(list)[0]!)).slice(0, 3)
  if (!candidates.length) return
  askOption(host, XUSHAO_PINGJIAN, ownerId, `choose-${timing}`, ownerId,
    '【评荐】：选择一张武将牌并发动其当前时机可发动的技能',
    candidates.map((item) => ({ id: item.skillId, label: `${item.characterName}【${item.skillName}】` })),
    { ...data, timing, candidates }, false)
}

registerSkillRuntime({
  id: XUSHAO_PINGJIAN,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, XUSHAO_PINGJIAN)
      && pingjianCandidates(state, ownerId, 'play').length
      ? [{ id: `skill:${XUSHAO_PINGJIAN}`, label: '发动【评荐】' }] : []
  },
  invokeActive(host, ownerId) {
    markUsedThisPhase(host.state, ownerId, XUSHAO_PINGJIAN)
    choosePingjian(host, ownerId, 'play')
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId === ownerId && p.phase === 'finish' && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: XUSHAO_PINGJIAN, ownerId, step: 'finish-candidates', data: { event: context.event } })
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: XUSHAO_PINGJIAN, ownerId, step: 'damaged-candidates', data: { event: context.event } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const timing = prompt.step === 'finish-candidates' ? 'finish' : prompt.step === 'damaged-candidates' ? 'damaged' : null
    if (timing) choosePingjian(host, ownerId, timing, { event: prompt.data.event })
  },
  resume(host, ownerId, resolution, response) {
    if (!resolution.step.startsWith('choose-')) return
    const skillId = (response.payload as { optionId?: string }).optionId
    const candidate = (resolution.data.candidates as PingjianCandidate[]).find((item) => item.skillId === skillId)
    const runtime = candidate && getSkillRuntime(candidate.skillId)
    if (!candidate || !runtime) return
    stateOf(host.state).pingjianUsed ??= {}
    stateOf(host.state).pingjianUsed[ownerId] ??= []
    if (stateOf(host.state).pingjianUsed[ownerId].includes(candidate.skillId)) return
    stateOf(host.state).pingjianUsed[ownerId].push(candidate.skillId)
    const timing = resolution.data.timing as PingjianTiming
    if (timing === 'play') {
      const action = runtime.activeActions?.(host.state, ownerId).find((entry) => candidate.actionIds?.includes(entry.id))
      if (action) runtime.invokeActive?.(host, ownerId, action.id)
      return
    }
    const event = resolution.data.event as EventContext['event'] | undefined
    if (!event) return
    const context: EventContext = { event, cancelled: false, cancel() { context.cancelled = true } }
    const eventName = timing === 'finish' ? 'PhaseStart' : 'Damaged'
    for (const trigger of runtime.triggers ?? []) if (trigger.event === eventName) trigger.handle(host, ownerId, context)
  },
})

function allRolesInAllAttackRanges(state: SanguoshaState): boolean {
  const players = living(state)
  return players.every((source) => players.every((target) => source.id === target.id
    || getDistance(state, source.id, target.id) <= getAttackRange(state, source.id)))
}

registerSkillRuntime({
  id: DUKUI_PEIQI,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId === ownerId && playerOf(host.state, ownerId)?.alive
      && fieldCards(host.state).some((card) => fieldMoveDestinations(host.state, card.cardId).length))
      host.queueSkill({ skillId: DUKUI_PEIQI, ownerId, step: 'move-offer', data: { second: false } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'move-offer' && prompt.step !== 'move-card') return
    const choices = fieldCards(host.state).filter((card) => fieldMoveDestinations(host.state, card.cardId).length)
    if (!choices.length) return
    if (prompt.step === 'move-offer') {
      askOption(host, DUKUI_PEIQI, ownerId, 'move-offer', ownerId,
        `【配器】：是否移动场上一张牌？${prompt.data.second ? '（可再移动一张）' : ''}`,
        [{ id: 'yes', label: '移动一张牌' }], prompt.data)
      return
    }
    askCards(host, DUKUI_PEIQI, ownerId, 'move-card', ownerId, choices.map((card) => card.cardId), 1, 1,
      '【配器】：选择要移动的场上牌', prompt.data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'move-offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: DUKUI_PEIQI, ownerId, step: 'move-card', data: resolution.data })
      return
    }
    if (resolution.step === 'move-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !fieldMoveDestinations(host.state, cardId).length) return
      const targets = fieldMoveDestinations(host.state, cardId)
      askTargets(host, DUKUI_PEIQI, ownerId, 'move-target', ownerId, targets, 1, 1,
        '【配器】：选择移动目的角色', { cardId, second: Boolean(resolution.data.second) }, false)
      return
    }
    if (resolution.step === 'move-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!targetId || !fieldMoveDestinations(host.state, cardId).includes(targetId)) return
      moveFieldCard(host as never, cardId, targetId)
      if (!resolution.data.second && allRolesInAllAttackRanges(host.state))
        host.queueSkill({ skillId: DUKUI_PEIQI, ownerId, step: 'move-offer', data: { second: true } })
    }
  },
})

function revealFanyinCard(host: SkillHost, ownerId: PlayerId, rank?: number) {
  if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
  const pile = host.state.zones.drawPile
  const cardId = rank === undefined
    ? pile.reduce<CardId | null>((lowest, id) => !lowest || host.state.cards[id]!.rank < host.state.cards[lowest]!.rank ? id : lowest, null)
    : pile.find((id) => host.state.cards[id]?.rank === rank) ?? null
  if (!cardId) return false
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  host.dispatch('CardMove', { cardIds: [cardId], reason: DUKUI_FANYIN, revealed: true }, { sourceId: ownerId, cardIds: [cardId] })
  const card = host.state.cards[cardId]
  if (card) host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'choose', data: { cardId, nextRank: card.rank * 2 } })
  return true
}

registerSkillRuntime({
  id: DUKUI_FANYIN,
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    return Boolean(cardId && stateOf(state).fanyinNoDistance?.[ownerId] === cardId)
  },
  modifiesNextCardTargets(state, ownerId, cardId) {
    const card = state.cards[cardId]
    return Boolean(stateOf(state).fanyinExtraTarget?.[ownerId] && card
      && (card.category === 'basic' || card.category === 'trick'))
  },
  nextCardTargetExpansion(state, ownerId, _cardId, _cardName) {
    if (!stateOf(state).fanyinExtraTarget?.[ownerId]) return null
    return { maxAdditionalTargets: 1, candidateIds: living(state).map((player) => player.id) }
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId === ownerId && p.phase === 'play' && playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'start-offer', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId && stateOf(host.state).fanyinExtraTarget?.[ownerId])
        delete stateOf(host.state).fanyinExtraTarget[ownerId]
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const pending = cardId && stateOf(host.state).fanyinContinuation?.[cardId]
      if (!pending) return
      delete stateOf(host.state).fanyinContinuation[cardId]
      if (playerOf(host.state, ownerId)?.alive) host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'reveal-next', data: pending })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'start-offer') {
      askOption(host, DUKUI_FANYIN, ownerId, 'start-offer', ownerId, '【泛音】：是否开始依点数连续亮牌？',
        [{ id: 'yes', label: '发动【泛音】' }])
      return
    }
    if (prompt.step === 'reveal-first') { revealFanyinCard(host, ownerId); return }
    if (prompt.step === 'reveal-next') { revealFanyinCard(host, ownerId, Number(prompt.data.rank)); return }
    if (prompt.step !== 'choose') return
    const cardId = prompt.data.cardId as CardId
    if (!host.state.zones.processingArea.includes(cardId)) return
    // 临时进手牌只用于生成标准合法动作；立刻放回处理区，保留“亮牌待选”的真实位置。
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    stateOf(host.state).fanyinNoDistance ??= {}
    stateOf(host.state).fanyinNoDistance[ownerId] = cardId
    const actions = legalPlayActions(host.state, ownerId).filter((action) => action.kind === 'use-card' && action.cardIds.includes(cardId))
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'processingArea' })
    const choices = [
      ...actions.map((action) => ({ id: `use:${action.id}`, label: action.label })),
      { id: 'extra-target', label: '令你本回合使用的下一张牌可额外选择一个目标' },
    ]
    askOption(host, DUKUI_FANYIN, ownerId, 'choose', ownerId, `【泛音】：选择如何处理亮出的【${host.state.cards[cardId]?.name ?? '牌'}】`,
      choices, prompt.data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'start-offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'reveal-first', data: {} })
      return
    }
    if (resolution.step !== 'choose') return
    const option = (response.payload as { optionId?: string }).optionId ?? ''
    const cardId = resolution.data.cardId as CardId
    const nextRank = Number(resolution.data.nextRank)
    if (option === 'extra-target') {
      stateOf(host.state).fanyinExtraTarget ??= {}
      stateOf(host.state).fanyinExtraTarget[ownerId] = true
      if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'reveal-next', data: { rank: nextRank } })
      return
    }
    if (!option.startsWith('use:') || !host.state.zones.processingArea.includes(cardId)) return
    const actionId = option.slice(4)
    stateOf(host.state).fanyinNoDistance ??= {}
    stateOf(host.state).fanyinNoDistance[ownerId] = cardId
    stateOf(host.state).fanyinContinuation ??= {}
    stateOf(host.state).fanyinContinuation[cardId] = { rank: nextRank }
    const started = host.beginSkillCardUseFromProcessing(ownerId, cardId, DUKUI_FANYIN, actionId)
    delete stateOf(host.state).fanyinNoDistance[ownerId]
    if (!started) {
      delete stateOf(host.state).fanyinContinuation[cardId]
      if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      host.queueSkill({ skillId: DUKUI_FANYIN, ownerId, step: 'reveal-next', data: { rank: nextRank } })
    }
  },
})

const HISTORICAL_BATCH72_UNSORTED: CharacterDefinition[] = [
  { id: 'mangyachang-b72', name: '忙牙长', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MANGYACHANG_JIEDAO, name: '截刀', description: '当你每回合第一次造成伤害时，你可令此伤害至多+X（X为你损失的体力值）。若受到此伤害的角色没有阵亡，你弃置等同于此伤害加值的牌。' },
  ] },
  { id: 'guanlu-b72', name: '管辂', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: GUANLU_TUIYAN, name: '推演', description: '出牌阶段开始时，你可以观看牌堆顶的三张牌。' },
    { id: GUANLU_BUSUAN, name: '卜算', description: '出牌阶段限一次，你可以选择一名其他角色，然后选择至多两张不同的卡牌名称（限基本牌或锦囊牌）。该角色下次摸牌阶段摸牌时，改为从牌堆或弃牌堆中获得你选择的牌。' },
    { id: GUANLU_MINGJIE, name: '命戒', description: '结束阶段，你可以摸一张牌，若此牌为红色，你可以重复此流程直到摸到黑色牌或摸到第三张牌。当你以此法摸到黑色牌时，若你的体力值大于1，你失去1点体力。' },
  ] },
  { id: 'xushao-b72', name: '许劭', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: XUSHAO_PINGJIAN, name: '评荐', description: '你可以于以下时机发动“评荐”：1.出牌阶段限一次；2.结束阶段；3.当你受到伤害后。从你的已开通武将中随机出现3张拥有此时机可发动技能的武将牌，你选择其中1个武将并发动其技能。每个技能只能发动一次。' },
  ] },
  { id: 'dukui-b72', name: '杜夔', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: DUKUI_FANYIN, name: '泛音', description: '出牌阶段开始时，你可从牌堆亮出点数最小的一张牌并选择一项：使用之（无距离限制）；或令你本回合使用的下一张牌可额外选择一个目标。然后从牌堆亮出点数翻倍的牌并重复此流程。' },
    { id: DUKUI_PEIQI, name: '配器', description: '当你受到伤害后，你可移动场上一张牌。然后若所有角色均在所有角色攻击范围内，你可再移动场上一张牌。' },
  ] },
  { id: 'xingdaorong-b72', name: '邢道荣', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XINGDAORONG_XUHE, name: '虚猲', description: '出牌阶段开始时，你可以减1点体力上限，然后你弃置距离1以内的每名角色各一张牌或这些角色各摸一张牌。出牌阶段结束时，若你体力上限不为全场最高，你加1点体力上限，然后选择回复1点体力或摸两张牌。' },
  ] },
  { id: 'caiyang-b72', name: '蔡阳', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CAIYANG_XUNJI, name: '寻嫉', description: '出牌阶段限一次，你可以选择一名其他角色。然后若该角色于其下个回合内使用过黑色牌，则其结束阶段你视为对其使用一张【决斗】。此【决斗】对其造成伤害后，其对你造成等量的伤害。' },
    { id: CAIYANG_JIAOFENG, name: '交锋', description: '锁定技，当你每回合首次造成伤害时，若你已损失的体力值：大于0，你摸一张牌；大于1，此伤害+1；大于2，你回复1点体力。', locked: true },
  ] },
  { id: 'zhoushan-b72', name: '周善', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHOUSHAN_MIYUN, name: '密运', description: '锁定技，每轮开始时，你展示并获得一名其他角色的一张牌，称为“安”；每轮结束时，你将包括“安”在内的任意张手牌交给一名其他角色，然后你将手牌摸至体力上限。你不以此法失去“安”时，你失去1点体力。', locked: true },
    { id: ZHOUSHAN_DANYING, name: '胆迎', description: '每回合限一次，你可展示手牌中的“安”，然后视为使用或打出一张【杀】或【闪】。若如此做，本回合你下次成为牌的目标后，使用者弃置你一张牌。' },
  ] },
  { id: 'wanniangongzhu-b72', name: '万年公主', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: WANNIANZHENGZHUGONGZHEN, name: '枕戈', description: '准备阶段，你可以选择一名角色，该角色本局游戏的攻击范围+1（至多+5）。若此时全场角色都在该角色的攻击范围内，你可以令其视为对另一名角色使用了一张【杀】。' },
    { id: WANNIANXINGHAN, name: '兴汉', description: '锁定技，每回合的第一张【杀】造成伤害后，若此【杀】的使用者是你对其发动过“枕戈”的角色，你摸一张牌。若你的手牌数不是全场唯一最多的，则改为摸X张牌（X为该角色的攻击范围且最多为5）。', locked: true },
  ] },
  { id: 'caimaozhangyun-b72', name: '蔡瑁张允', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CAIMAOSHANGLIANZHOU, name: '连舟', description: '锁定技，准备阶段，将你的武将牌横置，然后横置任意名体力值等于你的角色。', locked: true },
    { id: CAIMAOSHANGJINGLAN, name: '惊澜', description: '锁定技，当你造成伤害后，若你的手牌数：大于体力值，你弃四张手牌；等于体力值，你弃一张牌并回复1点体力；小于体力值，你受到1点火焰伤害并摸五张牌。', locked: true },
  ] },
  { id: 'wangtao-b72', name: '王桃', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: WANGTAO_HUGUAN, name: '护关', description: '一名角色于其出牌阶段使用的第一张牌若为红色，则你可声明一个花色，本回合该花色的牌不计入该角色的手牌上限。' },
    { id: WANGTAO_YAOPEI, name: '摇佩', description: '其他角色弃牌阶段结束时，若你本回合对其发动过“护关”，你可以弃置其此阶段没弃置过的花色的一张牌，然后令你与其中的一名角色回复1点体力，另一名角色摸两张牌。' },
  ] },
]
export const HISTORICAL_BATCH72_CHARACTERS: readonly CharacterDefinition[] = HISTORICAL_BATCH72_UNSORTED
