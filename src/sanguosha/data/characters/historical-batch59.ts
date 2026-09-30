import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { ArrangeOptionsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { effectiveCardColor, effectiveCardSuit, ownedSkillIds, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import type { SkillHost, TargetedCardContext } from '../../engine/skills/runtime'
import { characterPileCardUseActions, createVirtualSlashCard, executeUseCardAction } from '../../engine/cards/basic'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { resolveDamage, resumeDamageModifier } from '../../engine/damage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { slashUsesThisTurn } from '../../engine/slash-rules'
import { drawCards } from '../../engine/draw'
import { discardCardsByIds } from '../../engine/discard-all'
import { hiddenHandSlot } from '../../engine/cards/host'
import { closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards } from '../../engine/private-zone'
import { reshuffleDrawPile } from '../../engine/deck'
import { moveCard } from '../../engine/zones'
import { giveCards } from '../../engine/hand-transfer'
import { setChained } from '../../engine/character-state'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { isSoleTargetOf } from '../../engine/card-use-targets'
import { canPindian, startPindian, registerPindianContinuation, finishPindianSettlement, type PindianResult } from '../../engine/pindian'
import { queueExtraTurn } from '../../engine/turn'
import { getAttackRange, getDistance } from '../../engine/distance'
import { prohibitsBeingPindianTargetOf } from '../../engine/skills/runtime'

const b59 = (id: string) => `${id}:b59`
const QICHE = b59('qicheng-cheliji')
const QIANGYONG = b59('qiangyong-cheliji')
const XIONGTU = b59('xiongtu-sunjun')
const XIANSHUAI = b59('xianshuai-sunjun')
const SIFENG = b59('sifeng-caozhen')
const SIFENG_PILE = (ownerId: PlayerId) => `${SIFENG}:${ownerId}`
const HEYUN = b59('heyun-shixiao-qiao')
const YINHUI = b59('yinhui-shixiao-qiao')
const YINHUI_SOURCE = `${YINHUI}:copied`
const CHIYUN = b59('chiyun-shiyu-zhouyu')
const YANHUI = b59('yanhui-shiyu-zhouyu')
const FENTAO = b59('fentao-shiyu-zhouyu')
const XIONGZI = b59('xiongzi-shiyu-zhouyu')
const LIANGYIN = b59('liangyin-zhoufei-jie')
const KONGSHENG = b59('kongsheng-zhoufei-jie')
const KONGSHENG_PILE = (ownerId: PlayerId) => `${KONGSHENG}:${ownerId}`
const JUZHAN = b59('juzhan-jie-yanyan')
const CHENGSHI = b59('chengshi-jie-yanyan')
const FUYU = b59('fuyu-xing-wanglang')
const ZHANSHI = b59('zhanshi-xing-wanglang')
const FUYU_CONTINUATION = `${FUYU}:pindian`
const FENGYING = b59('fengying-cuiyan-maojie')
const ZHENGPI = b59('zhengpi-cuiyan-maojie')
const FENGYING_LIMIT = `${FENGYING}:limited`
const HEQI_SHANXI = b59('shanxi-shiheqi')
const HEQI_QIZHOU = b59('qizhou-shiheqi')

type Batch59ZhouFeiEntry = {
  roundNumber: number
  liangyinTargets: PlayerId[]
  pendingKongsheng?: { targetId: PlayerId; cardId: CardId }
}

type Batch59YanYanEntry = {
  mode: 'yin' | 'yang'
  count: number
  seenSlashTargets: string[]
  seenSlashUses: CardId[]
  blockedUses: Array<{ sourceId: PlayerId; targetId: PlayerId; turnNumber: number }>
}

type Batch59State = SanguoshaState & {
  b59SunJun?: Record<PlayerId, {
    turnNumber: number
    usedSuits: Suit[]
    discardedSuits: Suit[]
    playPhaseSeq: number
    xiongtuUses: number
    xiongtuLimit: number
    pendingXiongtuDamage?: { targetId: PlayerId }
  }>
  b59XiaoQiao?: Record<PlayerId, { turnNumber: number; phaseSeq: number; uses: number }>
  b59ZhouYu?: Record<PlayerId, {
    turnNumber: number
    phaseSeq: number
    gainedThisPhase: boolean
    revealedCardIds: CardId[]
    revealedPlayerIds: PlayerId[]
    revealedPlayersThisPhase: PlayerId[]
    discardedPlayersThisPhase: PlayerId[]
    yanhuiUsedThisPhase: boolean
    pendingRechain?: PlayerId
    turnOnly: boolean
  }>
  b59ZhouFei?: Record<PlayerId, Batch59ZhouFeiEntry>
  b59YanYan?: Record<PlayerId, Batch59YanYanEntry>
  b59WangLang?: Record<PlayerId, { turnNumber: number; targetUsed: boolean; sourceUsed: boolean; lastWon?: boolean }>
  b59WangLangPending?: Record<PlayerId, { cardId: CardId; sourceId: PlayerId; targetId: PlayerId; repeat: boolean }>
  b59ZhanShi?: Record<PlayerId, Array<{ pindianId: string; participants: PlayerId[] | null; winners: PlayerId[] | null }>>
  b59CuiMao?: Record<PlayerId, {
    selectedTargets: PlayerId[]
    zhengpiSession?: { remaining: number }
    zhengpiPending?: { actorId: PlayerId; receivedCount: number; stage: 'take' | 'give' }
    fengyingPending?: { targetId: PlayerId; actorIds: PlayerId[]; index: number; activeCardId?: CardId }
  }>
  b59HeQi?: Record<PlayerId, { marked: CardId[]; slashChainPending: boolean; playPhaseSerial: number; usedTargets: Record<string, number> }>
}

function wangLangState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch59State
  data.b59WangLang ??= {}
  let entry = data.b59WangLang[ownerId]
  if (!entry || entry.turnNumber !== state.turnNumber) entry = data.b59WangLang[ownerId] = { turnNumber: state.turnNumber, targetUsed: false, sourceUsed: false, lastWon: entry?.lastWon }
  return entry
}

function heQiState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch59State
  data.b59HeQi ??= {}
  return data.b59HeQi[ownerId] ??= { marked: [], slashChainPending: false, playPhaseSerial: 0, usedTargets: {} }
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function beginFuyu(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext, side: 'source' | 'target'): boolean {
  if (!isSoleTargetOf(host.state, context.cardId, context.targetId)
    || (context.category !== 'basic' && context.category !== 'trick')
    || ['乐不思蜀', '兵粮寸断', '闪电'].includes(context.cardName)
    || host.state.pindian || host.state.pindianSettlement
    || !canPindian(host.state, ownerId) || !canPindian(host.state, side === 'source' ? context.targetId : context.sourceId)
    || prohibitsBeingPindianTargetOf(host.state, side === 'source' ? context.targetId : context.sourceId)) return false
  const entry = wangLangState(host.state, ownerId)
  if ((side === 'source' && entry.sourceUsed) || (side === 'target' && entry.targetUsed)) return false
  host.askSkill({ skillId: FUYU, ownerId, step: 'invoke', data: { ...context, side }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: '【负隅】：是否与此牌的使用者拼点？', timeoutMs: 25_000, optional: true,
    options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
  }) })
  return true
}

function finishZhanShiIfReady(host: SkillHost, ownerId: PlayerId, pindianId: string): void {
  const data = host.state as Batch59State
  const records = data.b59ZhanShi?.[ownerId]
  const index = records?.findIndex((entry) => entry.pindianId === pindianId) ?? -1
  if (index < 0) return
  const record = records![index]
  if (!record.participants || !record.winners) return
  const winnerCount = record.participants.filter((id) => record.winners!.includes(id)).length
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (winnerCount && owner) drawCards(host.state, host.rng, ownerId, winnerCount * 3, (name, payload) => host.dispatch(name, payload))
  records!.splice(index, 1)
}

registerPindianContinuation(FUYU_CONTINUATION, (pindianHost, result: PindianResult) => {
  const host = pindianHost as unknown as SkillHost
  const ownerId = result.data.ownerId as PlayerId
  const pending = (host.state as Batch59State).b59WangLangPending?.[ownerId]
  if (!pending) { finishPindianSettlement(host); return }
  const ownerWon = result.initiatorId === ownerId
    ? result.outcome === 'initiator-win'
    : result.outcome === 'opponent-win'
  const entry = wangLangState(host.state, ownerId)
  if (entry.lastWon !== undefined && entry.lastWon === ownerWon) {
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  }
  entry.lastWon = ownerWon
  const sourceWon = result.initiatorId === pending.sourceId
    ? result.outcome === 'initiator-win'
    : result.outcome === 'opponent-win'
  pending.repeat = sourceWon
  const resolution = host.state.cardResolution
  if (!sourceWon && resolution?.kind === 'slash' && resolution.cardId === pending.cardId) {
    resolution.targetCancelled = true
  } else if (!sourceWon && resolution?.kind === 'trick' && resolution.cardId === pending.cardId
    && !resolution.cancelledTargetIds.includes(pending.targetId)) {
    resolution.cancelledTargetIds.push(pending.targetId)
  }
  host.resumeCardTarget()
  finishPindianSettlement(host)
})

registerSkillRuntime({ id: FUYU,
  interceptTarget(host, ownerId, context) { return beginFuyu(host, ownerId, context, 'target') },
  interceptSourceTargetEach(host, ownerId, context) { return beginFuyu(host, ownerId, context, 'source') },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const pending = (host.state as Batch59State).b59WangLangPending?.[ownerId]
    const resolvedCardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!pending?.repeat || pending.cardId !== resolvedCardId) return
    delete (host.state as Batch59State).b59WangLangPending?.[ownerId]
    if (!host.state.players.some((player) => player.id === pending.sourceId && player.alive)
      || !host.state.players.some((player) => player.id === pending.targetId && player.alive)) return
    const original = host.state.cards[pending.cardId]
    if (!original) return
    const name = original.name
    const cardId = name === '杀' ? createVirtualSlashCard(host.state, pending.sourceId, FUYU) : createVirtualTrick(host.state, pending.sourceId, name, FUYU)
    const action = {
      id: `repeat:${cardId}`, kind: 'use-card' as const, playerId: pending.sourceId,
      label: '【负隅】：额外结算', cardIds: [cardId], targetIds: [pending.targetId],
      targetMin: 1, targetMax: 1, asCardName: name, sourceSkillId: FUYU,
    }
    executeUseCardAction(host as never, pending.sourceId, action as never, { skipPlayInterceptors: true, countSlashUsage: false })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    const data = resolution.data as unknown as TargetedCardContext & { side: 'source' | 'target' }
    if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
    const entry = wangLangState(host.state, ownerId)
    if (data.side === 'source') entry.sourceUsed = true
    else entry.targetUsed = true
    ;((host.state as Batch59State).b59WangLangPending ??= {})[ownerId] = {
      cardId: data.cardId, sourceId: data.sourceId, targetId: data.targetId, repeat: false,
    }
    startPindian(host as never, {
      id: `${FUYU}:${host.state.seq}:${ownerId}`, initiatorId: ownerId,
      opponentId: data.sourceId === ownerId ? data.targetId : data.sourceId,
      reason: FUYU, continuationTag: FUYU_CONTINUATION, timeoutMs: 25_000, data: { ownerId },
    })
  },
})

registerSkillRuntime({ id: ZHANSHI,
  triggers: [
    { event: 'PindianStart', handle(host, ownerId, context) {
      const data = context.event.payload as { pindianId: string; initiatorId: PlayerId; opponentId: PlayerId }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const pickable = pickableCardsOf(host.state, ownerId)
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length < 1) return
      const records = (host.state as Batch59State).b59ZhanShi ??= {}
      const own = records[ownerId] ??= []
      if (own.some((item) => item.pindianId === data.pindianId)) return
      own.push({ pindianId: data.pindianId, participants: null, winners: null })
      host.queueSkill({ skillId: ZHANSHI, ownerId, step: 'participants', data: { pindianId: data.pindianId, candidates: [data.initiatorId, data.opponentId] } })
    } },
    { event: 'PindianEnd', handle(host, ownerId, context) {
      const data = context.event.payload as { pindianId?: string; initiatorId: PlayerId; opponentId: PlayerId; outcome: PindianResult['outcome'] }
      if (!data.pindianId) return
      const winner = data.outcome === 'tie' ? [] : [data.outcome === 'initiator-win' ? data.initiatorId : data.opponentId]
      const entry = (host.state as Batch59State).b59ZhanShi?.[ownerId]?.find((item) => item.pindianId === data.pindianId)
      if (!entry) return
      entry.winners = winner
      finishZhanShiIfReady(host, ownerId, data.pindianId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'participants') return
    const data = prompt.data as { pindianId: string; candidates: PlayerId[] }
    const pickable = pickableCardsOf(host.state, ownerId)
    const max = Math.min(2, pickable.cardIds.length + pickable.hiddenCardSlots.length)
    host.askSkill({ skillId: ZHANSHI, ownerId, step: 'participants', data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【瞻势】：选择此次拼点中的任意名角色并弃置等量牌',
      timeoutMs: 25_000, optional: true, candidateIds: data.candidates, min: 0, max,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'participants') {
      const data = resolution.data as { pindianId: string }
      const participants = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])].slice(0, 2)
      const record = (host.state as Batch59State).b59ZhanShi?.[ownerId]?.find((item) => item.pindianId === data.pindianId)
      if (!record || !participants.length) {
        const records = (host.state as Batch59State).b59ZhanShi?.[ownerId]
        if (records) (host.state as Batch59State).b59ZhanShi![ownerId] = records.filter((item) => item.pindianId !== data.pindianId)
        return
      }
      const pickable = pickableCardsOf(host.state, ownerId)
      const count = participants.length
      if (pickable.cardIds.length + pickable.hiddenCardSlots.length < count) return
      host.askSkill({ skillId: ZHANSHI, ownerId, step: 'discard', data: { pindianId: data.pindianId, participants }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【瞻势】：弃置${count}张牌`, timeoutMs: 25_000,
        optional: false, ...pickable, min: count, max: count, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const data = resolution.data as { pindianId: string; participants: PlayerId[] }
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardIds = [...new Set(selected)].map((id) => resolvePickedCard(host.state, ownerId, id)).filter((id): id is CardId => Boolean(id))
      if (cardIds.length !== data.participants.length) return
      discardCardsByIds(host as never, ownerId, cardIds, ZHANSHI)
      const record = (host.state as Batch59State).b59ZhanShi?.[ownerId]?.find((item) => item.pindianId === data.pindianId)
      if (!record) return
      record.participants = data.participants
      finishZhanShiIfReady(host, ownerId, data.pindianId)
    }
  },
})

registerSkillRuntime({ id: ZHENGPI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.playerId !== ownerId || data.phase !== 'prepare') return
    const state = host.state as Batch59State
    const entry = (state.b59CuiMao ??= {})[ownerId] ??= { selectedTargets: [] }
    entry.zhengpiSession = { remaining: 1 }
    promptNextZhengpi(host, ownerId)
  } }],
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch59State
    const entry = state.b59CuiMao?.[ownerId]
    if (!entry) return
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!target || !owner || entry.selectedTargets.includes(target.id)) { delete entry.zhengpiSession; return }
      const pickable = pickableCardsOf(host.state, target.id, { includeJudgingArea: true })
      const max = Math.min(3, owner.zones.hand.length, pickable.cardIds.length + pickable.hiddenCardSlots.length)
      if (max < 1) { delete entry.zhengpiSession; return }
      entry.selectedTargets.push(target.id)
      entry.zhengpiPending = { actorId: target.id, receivedCount: 0, stage: 'take' }
      host.askSkill({ skillId: ZHENGPI, ownerId, step: 'target-give', data: { targetId: target.id }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: target.id, prompt: `【征辟】：选择交给${owner.nickname}的一至${max}张区域牌`,
        timeoutMs: 25_000, optional: false, ...pickable, min: 1, max, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'target-give') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardIds = [...new Set(selected)].map((id) => resolvePickedCard(host.state, targetId, id)).filter((id): id is CardId => Boolean(id))
      const moved: CardId[] = []
      for (const cardId of cardIds.slice(0, 3)) {
        if (movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) moved.push(cardId)
      }
      if (!moved.length) { delete entry.zhengpiPending; delete entry.zhengpiSession; return }
      host.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason: ZHENGPI }, { sourceId: targetId, targetId: ownerId, cardIds: moved })
      entry.zhengpiPending = { actorId: targetId, receivedCount: moved.length, stage: 'give' }
      continueZhengpi(host, ownerId)
      return
    }
    if (resolution.step === 'source-give') {
      const data = resolution.data as { actorId: PlayerId; receivedCount: number }
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const cardIds = selected.filter((id) => owner?.zones.hand.includes(id)).slice(0, data.receivedCount)
      if (cardIds.length === data.receivedCount) giveCards(host as never, ownerId, data.actorId, cardIds, ZHENGPI)
      if (cardIds.length === 3 && entry.zhengpiSession) entry.zhengpiSession.remaining += 1
      delete entry.zhengpiPending
      if (entry.zhengpiSession) entry.zhengpiSession.remaining -= 1
      promptNextZhengpi(host, ownerId)
    }
  },
})

registerSkillRuntime({ id: FENGYING,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId
      && !playerOf(state, ownerId)?.marks[FENGYING_LIMIT]
      ? [{ id: FENGYING, label: '奉迎：令攻击范围内角色使用【无中生有】' }] : []
  },
  invokeActive(host, ownerId) {
    host.askSkill({ skillId: FENGYING, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【奉迎】：选择一名角色', timeoutMs: 25_000,
      optional: false, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const pending = (host.state as Batch59State).b59CuiMao?.[ownerId]?.fengyingPending
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!pending?.activeCardId || pending.activeCardId !== cardId) return
    delete pending.activeCardId
    pending.index += 1
    promptFengyingActor(host, ownerId)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      owner.marks[FENGYING_LIMIT] = 1
      const count = host.state.players.length
      const actorIds = host.state.players.filter((player) => player.alive && player.id !== target.id
        && player.zones.hand.length > 0 && getDistance(host.state, target.id, player.id) <= getAttackRange(host.state, target.id))
        .sort((left, right) => ((left.seat - target.seat + count) % count) - ((right.seat - target.seat + count) % count))
        .map((player) => player.id)
      const entry = (host.state as Batch59State).b59CuiMao ??= {}
      const own = entry[ownerId] ??= { selectedTargets: [] }
      own.fengyingPending = { targetId: target.id, actorIds, index: 0 }
      promptFengyingActor(host, ownerId)
      return
    }
    if (resolution.step !== 'give-card') return
    const data = resolution.data as { actorId: PlayerId }
    const pending = (host.state as Batch59State).b59CuiMao?.[ownerId]?.fengyingPending
    const actor = host.state.players.find((player) => player.id === data.actorId && player.alive)
    const target = pending && host.state.players.find((player) => player.id === pending.targetId && player.alive)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!pending || !actor || !target || !cardId || !actor.zones.hand.includes(cardId)) { if (pending) { pending.index += 1; promptFengyingActor(host, ownerId) }; return }
    const action = { id: `play:${FENGYING}:${cardId}:${target.id}`, kind: 'use-card' as const, playerId: actor.id,
      label: '【奉迎】：将手牌当【无中生有】对指定角色使用', cardIds: [cardId], targetIds: [target.id], targetMin: 1, targetMax: 1,
      asCardName: '无中生有', sourceSkillId: FENGYING }
    pending.activeCardId = cardId
    executeUseCardAction(host as never, actor.id, action as never, { skipPlayInterceptors: true, preserveTargets: true })
    if (actor.zones.hand.includes(cardId)) {
      delete pending.activeCardId
      pending.index += 1
      promptFengyingActor(host, ownerId)
    }
  },
})

registerSkillRuntime({ id: HEQI_SHANXI,
  viewAs(state, ownerId) {
    const entry = heQiState(state, ownerId)
    const owner = state.players.find((player) => player.id === ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    return entry.marked.filter((cardId) => owner.zones.hand.includes(cardId)).map((cardId) => ({
      cardId, asCardName: '决斗', label: '【闪袭】：将“应机”牌当【决斗】使用',
    }))
  },
  prohibitsSourceTarget(state, ownerId, targetId, cardName, sourceSkillId) {
    if (sourceSkillId !== HEQI_SHANXI || cardName !== '决斗') return false
    const entry = heQiState(state, ownerId)
    return entry.usedTargets[`${state.turnNumber}:${entry.playPhaseSerial}:${targetId}`] === 1
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceSkillId !== HEQI_SHANXI || context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
    if (payload.cardName !== '决斗') return
    const entry = heQiState(host.state, ownerId)
    for (const targetId of payload.targetIds ?? []) entry.usedTargets[`${host.state.turnNumber}:${entry.playPhaseSerial}:${targetId}`] = 1
  } }],
})

registerSkillRuntime({ id: HEQI_QIZHOU,
  triggers: [
    { event: 'FieldCardEntered', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (payload.playerId !== ownerId || !payload.cardId) return
      const entry = heQiState(host.state, ownerId)
      const prompt = { cardId: payload.cardId, nextSlash: host.state.cards[payload.cardId]?.name === '杀', grantDraw: entry.slashChainPending }
      host.queueSkill({ skillId: HEQI_QIZHOU, ownerId, step: 'mark-target', data: prompt })
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      const entry = heQiState(host.state, ownerId)
      if (payload.phase === 'play') entry.playPhaseSerial += 1
      if (payload.phase !== 'draw') return
      const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data)) as CardId[]
      entry.marked.push(...drawn.filter((id) => !entry.marked.includes(id)))
    } },
    { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId) {
      const entry = (host.state as Batch59State).b59HeQi?.[ownerId]
      if (!entry) return
      const due = new Map<PlayerId, CardId[]>()
      for (const cardId of entry.marked) {
        const holder = host.state.players.find((player) => player.zones.hand.includes(cardId))
        if (holder) due.set(holder.id, [...(due.get(holder.id) ?? []), cardId])
      }
      entry.marked = []
      for (const [playerId, cardIds] of due) discardCardsByIds(host as never, playerId, cardIds, HEQI_QIZHOU)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mark-target') return
    const data = prompt.data as { cardId: CardId; nextSlash: boolean; grantDraw: boolean }
    const candidates = host.state.players.filter((player) => player.alive && player.zones.hand.some((id) => !heQiState(host.state, ownerId).marked.includes(id)))
    if (!candidates.length) return
    host.askSkill({ skillId: HEQI_QIZHOU, ownerId, step: 'mark-target', data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【绮胄】：选择一名有未标记手牌的角色',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mark-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const data = resolution.data as { cardId: CardId; nextSlash: boolean; grantDraw: boolean }
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target) return
      const marked = new Set(heQiState(host.state, ownerId).marked)
      const hiddenSlots = target.zones.hand.flatMap((cardId, index) => marked.has(cardId) ? [] : [hiddenHandSlot(target.id, index)])
      if (!hiddenSlots.length) return
      host.askSkill({ skillId: HEQI_QIZHOU, ownerId, step: 'mark-card', data: { ...data, targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【绮胄】：标记${target.nickname}的一张手牌为“应机”牌`,
        timeoutMs: 25_000, optional: false, cardIds: [], hiddenCardSlots: hiddenSlots, min: 1, max: 1, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'mark-card') {
      const data = resolution.data as { cardId: CardId; nextSlash: boolean; grantDraw: boolean; targetId: PlayerId }
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, data.targetId, selected) : null
      const target = host.state.players.find((player) => player.id === data.targetId)
      if (!cardId || !target?.zones.hand.includes(cardId)) return
      const entry = heQiState(host.state, ownerId)
      if (!entry.marked.includes(cardId)) entry.marked.push(cardId)
      if (data.grantDraw) {
        const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload)) as CardId[]
        entry.marked.push(...drawn.filter((id) => !entry.marked.includes(id)))
      }
      entry.slashChainPending = data.nextSlash
    }
  },
})

function continueZhengpi(host: SkillHost, ownerId: PlayerId): void {
  const entry = (host.state as Batch59State).b59CuiMao?.[ownerId]
  const pending = entry?.zhengpiPending
  if (!pending || pending.stage !== 'give') return
  const actor = host.state.players.find((player) => player.id === pending.actorId && player.alive)
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!actor || !owner || owner.zones.hand.length < pending.receivedCount) return
  host.askSkill({ skillId: ZHENGPI, ownerId, step: 'source-give', data: { actorId: actor.id, receivedCount: pending.receivedCount }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【征辟】：交给${actor.nickname}等量手牌`,
    timeoutMs: 25_000, optional: false, cardIds: [...(host.state.players.find((player) => player.id === ownerId)?.zones.hand ?? [])],
    hiddenCardSlots: [], min: pending.receivedCount, max: pending.receivedCount, purpose: 'skill',
  }) })
}

function promptNextZhengpi(host: SkillHost, ownerId: PlayerId): void {
  const entry = (host.state as Batch59State).b59CuiMao?.[ownerId]
  const session = entry?.zhengpiSession
  if (!entry || !session || session.remaining <= 0) { if (entry) delete entry.zhengpiSession; return }
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
    && !entry.selectedTargets.includes(player.id)
    && pickableCardsOf(host.state, player.id, { includeJudgingArea: true }).cardIds.length
      + pickableCardsOf(host.state, player.id, { includeJudgingArea: true }).hiddenCardSlots.length > 0)
  if (!owner?.zones.hand.length || !candidates.length) { delete entry.zhengpiSession; return }
  host.askSkill({ skillId: ZHENGPI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【征辟】：选择一名尚未选择过的其他角色',
    timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1,
  }) })
}

function promptFengyingActor(host: SkillHost, ownerId: PlayerId): void {
  const pending = (host.state as Batch59State).b59CuiMao?.[ownerId]?.fengyingPending
  if (!pending) return
  while (pending.index < pending.actorIds.length) {
    const actorId = pending.actorIds[pending.index]
    const actor = host.state.players.find((player) => player.id === actorId && player.alive)
    if (actor?.zones.hand.length) {
      host.askSkill({ skillId: FENGYING, ownerId, step: 'give-card', data: { actorId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: '【奉迎】：选择一张手牌当【无中生有】使用',
        timeoutMs: 25_000, optional: false, cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }) })
      return
    }
    pending.index += 1
  }
  const target = host.state.players.find((player) => player.id === pending.targetId && player.alive)
  const maximumHp = Math.max(...host.state.players.filter((player) => player.alive).map((player) => player.maxHp))
  if (target && target.maxHp === maximumHp) queueExtraTurn(host.state, ownerId, { skillId: FENGYING, playerId: ownerId })
  delete (host.state as Batch59State).b59CuiMao?.[ownerId]?.fengyingPending
}

function zhouYuState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch59State
  data.b59ZhouYu ??= {}
  let entry = data.b59ZhouYu[ownerId]
  if (!entry || entry.turnNumber !== state.turnNumber) {
    const turnOnly = entry?.turnOnly ?? false
    entry = data.b59ZhouYu[ownerId] = {
      turnNumber: state.turnNumber, phaseSeq: 0, gainedThisPhase: false,
      revealedCardIds: [], revealedPlayerIds: [], revealedPlayersThisPhase: [],
      discardedPlayersThisPhase: [], yanhuiUsedThisPhase: false, turnOnly,
    }
  }
  return entry
}

function zhouYuSkillOnTurn(state: SanguoshaState, ownerId: PlayerId): boolean {
  const entry = (state as Batch59State).b59ZhouYu?.[ownerId]
  return !entry?.turnOnly || state.currentPlayerId === ownerId
}

function zhouFeiState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch59State
  data.b59ZhouFei ??= {}
  let entry = data.b59ZhouFei[ownerId]
  if (!entry || entry.roundNumber !== state.roundNumber) {
    entry = data.b59ZhouFei[ownerId] = { roundNumber: state.roundNumber, liangyinTargets: [] }
  }
  return entry
}

function setKongshengPileVisibility(state: SanguoshaState, playerId: PlayerId, ownerId: PlayerId, hidden: boolean): void {
  const target = state.players.find((player) => player.id === playerId)
  if (!target) return
  target.hiddenCharacterPiles ??= []
  const pile = KONGSHENG_PILE(ownerId)
  if (hidden && !target.hiddenCharacterPiles.includes(pile)) target.hiddenCharacterPiles.push(pile)
  if (!hidden) target.hiddenCharacterPiles = target.hiddenCharacterPiles.filter((item) => item !== pile)
}

function yanYanState(state: SanguoshaState, ownerId: PlayerId): Batch59YanYanEntry {
  const data = state as Batch59State
  data.b59YanYan ??= {}
  return data.b59YanYan[ownerId] ?? (data.b59YanYan[ownerId] = {
    mode: 'yin', count: 0, seenSlashTargets: [], seenSlashUses: [], blockedUses: [],
  })
}

function yanYanTargetInterceptor(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean {
  if (context.cardName !== '杀' || !host.state.players.some((player) => player.id === ownerId && player.alive)) return false
  const entry = yanYanState(host.state, ownerId)
  let triggered = false
  if (entry.mode === 'yang') {
    const eventKey = `${context.cardId}:${context.targetId}`
    if (!entry.seenSlashTargets.includes(eventKey)) {
      entry.seenSlashTargets.push(eventKey)
      entry.count += 1
    }
    triggered = context.targetId === ownerId || entry.count % 3 === 0
    if (!triggered || !host.state.players.some((player) => player.id === context.sourceId && player.alive)) return false
    host.askSkill({ skillId: JUZHAN, ownerId, step: 'activate-yang', data: { sourceId: context.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【拒战·阳】：是否令你与此【杀】使用者各摸一张牌，并令其本回合不能对你使用牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '各摸一张牌并限制其对你使用牌' }],
    }) })
    return true
  }

  if (!entry.seenSlashUses.includes(context.cardId)) {
    entry.seenSlashUses.push(context.cardId)
    entry.count += 1
  }
  triggered = context.sourceId === ownerId || entry.count % 3 === 0
  const target = host.state.players.find((player) => player.id === context.targetId && player.alive)
  const pickable = target ? pickableCardsOf(host.state, target.id) : null
  if (!triggered || !target || !pickable || pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return false
  host.askSkill({ skillId: JUZHAN, ownerId, step: 'activate-yin', data: { targetId: context.targetId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【拒战·阴】：是否获得${target.nickname}的一张牌，并令你本回合不能对其使用牌？`,
    timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '获得其一张牌并限制你对其使用牌' }],
  }) })
  return true
}

function sunJunState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch59State
  data.b59SunJun ??= {}
  let entry = data.b59SunJun[ownerId]
  if (!entry || entry.turnNumber !== state.turnNumber) {
    entry = data.b59SunJun[ownerId] = {
      turnNumber: state.turnNumber, usedSuits: [], discardedSuits: [],
      playPhaseSeq: 0, xiongtuUses: 0, xiongtuLimit: 1,
    }
  }
  return entry
}

function discardForXiongtu(host: { state: SanguoshaState }, ownerId: PlayerId, cardIds: CardId[]) {
  if (cardIds.length) discardCardsByIds(host as never, ownerId, cardIds, XIONGTU)
}

function livingNeighbors(state: SanguoshaState, centerId: PlayerId, omitId: PlayerId): PlayerId[] {
  const living = state.players.filter((player) => player.alive).sort((left, right) => left.seat - right.seat)
  const center = living.findIndex((player) => player.id === centerId)
  if (center < 0 || living.length < 2) return []
  return [...new Set([
    living[(center - 1 + living.length) % living.length]?.id,
    living[(center + 1) % living.length]?.id,
  ])].filter((id): id is PlayerId => Boolean(id) && id !== omitId)
}

registerSkillRuntime({ id: QICHE,
  slashIgnoresDistance: () => true,
  prohibitsSourceTarget(state, ownerId, targetId, cardName, sourceSkillId) {
    return cardName === '杀' && sourceSkillId !== QICHE && !livingNeighbors(state, ownerId, targetId).includes(targetId)
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as {
      cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; slashUsageCounted?: boolean; sourceSkillId?: string
    }
    const targetId = payload.targetIds?.[0]
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || payload.targetIds?.length !== 1
      || !targetId || payload.sourceSkillId === QICHE || cardDamageDealt(host.state, payload.cardId ?? '') > 0) return
    const nextTargets = livingNeighbors(host.state, targetId, ownerId)
    if (!nextTargets.length) return
    host.queueSkill({ skillId: QICHE, ownerId, step: 'follow-up-target', data: {
      originalTargetId: targetId, candidateIds: nextTargets, refundUse: payload.slashUsageCounted === true,
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'follow-up-target') return
    const { originalTargetId, candidateIds, refundUse } = prompt.data as {
      originalTargetId: PlayerId; candidateIds: PlayerId[]; refundUse: boolean
    }
    const candidates = candidateIds.filter((id) => livingNeighbors(host.state, originalTargetId, ownerId).includes(id))
    if (!candidates.length) return
    host.askSkill({ skillId: QICHE, ownerId, step: 'follow-up-target', data: { candidates, refundUse }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【驱乘】：选择对目标的上家或下家使用普通【杀】', timeoutMs: 25_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'follow-up-target') return
    const data = resolution.data as { candidates: PlayerId[]; refundUse: boolean }
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !data.candidates.includes(targetId)) return
    if (data.refundUse) {
      host.state.turnUsage.slashUses = Math.max(0, host.state.turnUsage.slashUses - 1)
      host.state.turnUsage.slashUsesThisTurn = Math.max(0, slashUsesThisTurn(host.state) - 1)
    }
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: QICHE, countUsage: false, ignoreDistance: true })
  },
})

registerSkillRuntime({ id: QIANGYONG,
  offersDamageModifierAsk(host, ownerId, side, context) {
    if (side !== 'source' || context.sourceId !== ownerId || context.cardName !== '杀'
      || context.chainTransfer || !host.state.players.some((player) => player.id === ownerId && player.alive)) return false
    const target = host.state.players.find((player) => player.id === context.targetId && player.alive)
    if (!target) return false
    const pickable = pickableCardsOf(host.state, target.id, { discarderId: ownerId })
    const available = pickable.cardIds.length + pickable.hiddenCardSlots.length
    const required = Math.min(slashUsesThisTurn(host.state), available)
    if (required === 0) {
      resumeDamageModifier(host as never, QIANGYONG, target.zones.hand.length === 0 ? 1 : 0)
      return true
    }
    host.askSkill({ skillId: QIANGYONG, ownerId, step: 'discard', data: { targetId: target.id, required }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【羌勇】：弃置${target.nickname}区域里的${required}张牌`, timeoutMs: 25_000,
      optional: false, cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: required, max: required, purpose: 'skill',
    }) })
    return true
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const { targetId, required } = resolution.data as { targetId: PlayerId; required: number }
    const target = host.state.players.find((player) => player.id === targetId && player.alive)
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const realIds = selected.map((picked) => resolvePickedCard(host.state, targetId, picked)).filter((id): id is CardId => Boolean(id))
    const valid = target && realIds.length === required && new Set(realIds).size === required
    if (valid) {
      for (const cardId of realIds) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
    }
    resumeDamageModifier(host as never, QIANGYONG, target?.zones.hand.length === 0 ? 1 : 0)
  },
})

registerSkillRuntime({ id: XIONGTU,
  activeActions(state, ownerId) {
    const entry = (state as Batch59State).b59SunJun?.[ownerId]
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !entry
      || entry.turnNumber !== state.turnNumber || entry.playPhaseSeq === 0
      || entry.xiongtuUses >= entry.xiongtuLimit) return []
    return state.players.some((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
      ? [{ id: XIONGTU, label: '凶图：展示一张手牌并选择效果' }] : []
  },
  invokeActive(host, ownerId) {
    const entry = sunJunState(host.state, ownerId)
    if (entry.xiongtuUses >= entry.xiongtuLimit) return
    entry.xiongtuUses += 1
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
    if (!candidates.length) { entry.xiongtuUses -= 1; return }
    host.askSkill({ skillId: XIONGTU, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【凶图】：选择一名有手牌的其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const entry = sunJunState(host.state, ownerId)
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive && player.zones.hand.length)) return
      host.askSkill({ skillId: XIONGTU, ownerId, step: 'reveal', data: { targetId }, build: (id): ChooseCardsRequest => {
        const target = host.state.players.find((player) => player.id === targetId)!
        return { id, kind: 'choose-cards', playerId: ownerId, prompt: '【凶图】：选择展示其一张手牌', timeoutMs: 25_000,
          optional: false, cardIds: [], viewOnlyCardIds: [], hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index)), min: 1, max: 1, purpose: 'skill' }
      } })
      return
    }
    if (resolution.step === 'reveal') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (!cardId || !host.state.players.find((player) => player.id === targetId)?.zones.hand.includes(cardId)) return
      host.dispatch('CardMove', { playerId: targetId, cardIds: [cardId], reason: XIONGTU, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      const discardable = pickableCardsOf(host.state, ownerId, { discarderId: ownerId })
      const ownCardCount = discardable.cardIds.length + host.state.players.find((player) => player.id === ownerId)!.zones.hand.length
      const x = Math.max(0, 4 - entry.discardedSuits.length)
      const options = [{ id: 'discard', label: '弃置此牌' }, ...(ownCardCount >= x ? [{ id: 'damage', label: `弃置${x}张牌，对其造成1点伤害` }] : [])]
      host.askSkill({ skillId: XIONGTU, ownerId, step: 'effect', data: { targetId, cardId, x }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【凶图】：选择一项', timeoutMs: 25_000,
        optional: false, options,
      }) })
      return
    }
    if (resolution.step === 'effect') {
      const { targetId, cardId, x } = resolution.data as { targetId: PlayerId; cardId: CardId; x: number }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard') {
        if (resolvePickedCard(host.state, targetId, cardId)) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      } else if (optionId === 'damage') {
        const cards = [...host.state.players.find((player) => player.id === ownerId)!.zones.hand,
          ...pickableCardsOf(host.state, ownerId, { discarderId: ownerId }).cardIds]
        if (cards.length < x) return
        host.askSkill({ skillId: XIONGTU, ownerId, step: 'cost', data: { targetId, x }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【凶图】：弃置${x}张牌`, timeoutMs: 25_000,
          optional: false, cardIds: cards, hiddenCardSlots: [], min: x, max: x, purpose: 'skill',
        }) })
      }
      return
    }
    if (resolution.step === 'cost') {
      const { targetId, x } = resolution.data as { targetId: PlayerId; x: number }
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = host.state.players.find((player) => player.id === ownerId)
      const legalIds = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      const valid = selected.length === x && new Set(selected).size === x && selected.every((id) => legalIds.includes(id))
      if (!valid || !host.state.players.some((player) => player.id === targetId && player.alive)) return
      discardForXiongtu(host, ownerId, selected)
      entry.pendingXiongtuDamage = { targetId }
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: XIONGTU })
    }
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (data.playerId === ownerId && data.phase === 'play') {
        const entry = sunJunState(host.state, ownerId)
        entry.playPhaseSeq = context.event.seq
        entry.xiongtuUses = 0
        entry.xiongtuLimit = 1
      }
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null }
      if (!data.cardId) return
      const suit = data.fromPlayerId
        ? effectiveCardSuit(host.state, data.fromPlayerId, data.cardId)
        : host.state.cards[data.cardId]?.suit
      if (!suit) return
      const entry = sunJunState(host.state, ownerId)
      if (!entry.discardedSuits.includes(suit)) entry.discardedSuits.push(suit)
    } },
    { event: 'CardEnteredDiscard', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      if (!data.cardId) return
      const suit = data.playerId
        ? effectiveCardSuit(host.state, data.playerId, data.cardId)
        : host.state.cards[data.cardId]?.suit
      if (!suit) return
      const entry = sunJunState(host.state, ownerId)
      if (!entry.discardedSuits.includes(suit)) entry.discardedSuits.push(suit)
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId }
      if (data.playerId === ownerId) {
        const entry = sunJunState(host.state, ownerId)
        entry.usedSuits = []
        entry.discardedSuits = []
        entry.playPhaseSeq = 0
        entry.xiongtuUses = 0
        entry.xiongtuLimit = 1
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const data = context.event.payload as { cardName?: string | null; finalAmount?: number }
      const entry = (host.state as Batch59State).b59SunJun?.[ownerId]
      if (context.event.sourceId !== ownerId || data.cardName !== XIONGTU || !entry?.pendingXiongtuDamage) return
      delete entry.pendingXiongtuDamage
      if ((data.finalAmount ?? 0) > 0) return
      entry.xiongtuLimit = 2
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    } },
  ],
})

registerSkillRuntime({ id: XIANSHUAI,
  slashUseQuotaBypass(state, ownerId, cardId) {
    if (!cardId) return false
    const suit = effectiveCardSuit(state, ownerId, cardId)
    if (!suit) return false
    return !sunJunState(state, ownerId).usedSuits.includes(suit)
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const data = context.event.payload as { cardId?: CardId; fromKind?: string; cardOwnerId?: PlayerId }
    if (context.event.sourceId !== ownerId || data.fromKind !== 'hand' || (data.cardOwnerId && data.cardOwnerId !== ownerId) || !data.cardId) return
    const suit = effectiveCardSuit(host.state, ownerId, data.cardId)
    if (!suit) return
    const entry = sunJunState(host.state, ownerId)
    if (!entry.usedSuits.includes(suit)) entry.usedSuits.push(suit)
  } }],
})

function setSifengPileVisibility(state: SanguoshaState, playerId: PlayerId, pile: string, hidden: boolean): void {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return
  player.hiddenCharacterPiles ??= []
  if (hidden && !player.hiddenCharacterPiles.includes(pile)) player.hiddenCharacterPiles.push(pile)
  if (!hidden) player.hiddenCharacterPiles = player.hiddenCharacterPiles.filter((candidate) => candidate !== pile)
}

function discardSifeng(host: { state: SanguoshaState }, targetId: PlayerId, cardIds: CardId[]): void {
  const pile = SIFENG_PILE(host.state.players.find((player) => player.id === targetId)?.id ?? '')
  for (const cardId of cardIds) {
    if (host.state.players.find((player) => player.id === targetId)?.characterPiles[pile]?.includes(cardId))
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: targetId, pile }, { kind: 'discardPile' })
  }
  if (!(host.state.players.find((player) => player.id === targetId)?.characterPiles[pile]?.length))
    setSifengPileVisibility(host.state, targetId, pile, false)
}

registerSkillRuntime({ id: SIFENG,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (data.playerId === ownerId && data.phase === 'finish'
        && host.state.zones.drawPile.length + host.state.zones.discardPile.length >= 3
        && host.state.players.some((player) => player.alive && player.id !== ownerId)) {
        host.queueSkill({ skillId: SIFENG, ownerId, step: 'offer', data: {} })
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string }
      const targetId = context.event.sourceId
      if (!targetId || targetId === ownerId || host.state.currentPlayerId !== targetId || !data.cardId) return
      const pile = SIFENG_PILE(ownerId)
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const cardId = target?.characterPiles[pile]?.[0]
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: targetId, pile }, { kind: 'discardPile' })
      if (!target.characterPiles[pile]?.length) setSifengPileVisibility(host.state, targetId, pile, false)
      const usedColor = effectiveCardColor(host.state, targetId, data.cardId)
      const tokenColor = host.state.cards[cardId]?.color
      if (usedColor === tokenColor || !target.zones.hand.length) return
      host.askSkill({ skillId: SIFENG, ownerId, step: 'discard-hand', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【伺锋】：弃置一张手牌', timeoutMs: 25_000,
        optional: false, cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }) })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId || targetId === ownerId) return
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (!(target?.characterPiles[SIFENG_PILE(ownerId)]?.length)) return
      host.queueSkill({ skillId: SIFENG, ownerId, step: 'end-choice', data: { targetId } })
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
      const pile = SIFENG_PILE(ownerId)
      if (deadId === ownerId) {
        for (const target of host.state.players) discardSifeng(host, target.id, [...(target.characterPiles[pile] ?? [])])
        for (const zone of [...host.state.privateZones]) if (zone.ownerId === ownerId && zone.reason === SIFENG)
          closePrivateZone(host.state, zone.id)
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: SIFENG, ownerId, step: 'offer', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【伺锋】：是否将牌堆顶三张牌分配给其他角色？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '发动伺锋' }],
      }) })
      return
    }
    if (prompt.step === 'assign') {
      const data = prompt.data as { zoneId: string; cards: CardId[]; ordered: CardId[]; index: number; targets: PlayerId[] }
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!candidates.length || data.index >= data.ordered.length) {
        if (!candidates.length) closePrivateZone(host.state, data.zoneId)
        return
      }
      host.askSkill({ skillId: SIFENG, ownerId, step: 'assign', data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【伺锋】：为第${data.index + 1}张牌选择一名角色（${host.state.cards[data.ordered[data.index]]?.name ?? '牌'}）`,
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'end-choice') {
      const targetId = (prompt.data as { targetId: PlayerId }).targetId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const cards = target?.characterPiles[SIFENG_PILE(ownerId)] ?? []
      if (!target || !cards.length) return
      host.askSkill({ skillId: SIFENG, ownerId, step: 'end-choice', data: { targetId, cards: [...cards] }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【伺锋】：处理${target.nickname}武将牌上的${cards.length}张“伺锋”`, timeoutMs: 25_000,
        optional: false, options: [{ id: 'gain', label: '获得这些牌' }, { id: 'damage', label: '移去这些牌并对其造成1点伤害' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const available = Math.min(3, host.state.zones.drawPile.length + host.state.zones.discardPile.length)
      if (!available) return
      const zoneId = `${SIFENG}:select:${ownerId}:${host.state.turnNumber}:${host.state.seq}`
      openPrivateZone(host.state, zoneId, ownerId, SIFENG)
      while (privateZoneCards(host.state, zoneId).length < available) {
        if (!host.state.zones.drawPile.length && !reshuffleDrawPile(host.state, host.rng, (name, data) => host.dispatch(name, data))) break
        const cardId = host.state.zones.drawPile[0]
        if (!cardId) break
        moveIntoPrivateZone(host.state, cardId, { kind: 'drawPile' }, zoneId)
      }
      const cards = privateZoneCards(host.state, zoneId)
      if (!cards.length) { closePrivateZone(host.state, zoneId); return }
      if (cards.length === 1) {
        host.queueSkill({ skillId: SIFENG, ownerId, step: 'assign', data: { zoneId, cards, ordered: cards, index: 0, targets: [] } })
        return
      }
      host.askSkill({ skillId: SIFENG, ownerId, step: 'order', data: { zoneId, cards }, build: (id): ArrangeOptionsRequest => ({
        id, kind: 'arrange-options', playerId: ownerId, prompt: '【伺锋】：排列将要分配的牌', timeoutMs: 25_000, optional: false,
        options: cards.map((cardId) => ({ id: cardId, label: `【${host.state.cards[cardId]?.name ?? '牌'}】${host.state.cards[cardId]?.suit ?? ''}${host.state.cards[cardId]?.rank ?? ''}` })),
      }) })
      return
    }
    if (resolution.step === 'order') {
      const data = resolution.data as { zoneId: string; cards: CardId[] }
      const ordered = (response.payload as { optionIds?: CardId[] }).optionIds ?? []
      if (ordered.length !== data.cards.length || new Set(ordered).size !== data.cards.length || ordered.some((cardId) => !data.cards.includes(cardId))) return
      host.queueSkill({ skillId: SIFENG, ownerId, step: 'assign', data: { ...data, ordered, index: 0, targets: [] } })
      return
    }
    if (resolution.step === 'assign') {
      const data = resolution.data as { zoneId: string; cards: CardId[]; ordered: CardId[]; index: number; targets: PlayerId[] }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive && player.id !== ownerId)
        || !privateZoneCards(host.state, data.zoneId).includes(data.ordered[data.index])) return
      data.targets.push(targetId)
      data.index += 1
      if (data.index < data.ordered.length) {
        host.queueSkill({ skillId: SIFENG, ownerId, step: 'assign', data })
        return
      }
      data.ordered.forEach((cardId, index) => {
        const destinationId = data.targets[index]
        const target = host.state.players.find((player) => player.id === destinationId)
        if (!target) return
        moveOutOfPrivateZone(host.state, cardId, data.zoneId, { kind: 'characterPile', playerId: destinationId, pile: SIFENG_PILE(ownerId) })
        setSifengPileVisibility(host.state, destinationId, SIFENG_PILE(ownerId), true)
      })
      closePrivateZone(host.state, data.zoneId)
      return
    }
    if (resolution.step === 'discard-hand') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = host.state.players.find((player) => player.id === targetId)
      if (cardId && target?.zones.hand.includes(cardId)) discardCardsByIds(host as never, targetId, [cardId], SIFENG)
      return
    }
    if (resolution.step === 'end-choice') {
      const { targetId, cards } = resolution.data as { targetId: PlayerId; cards: CardId[] }
      const target = host.state.players.find((player) => player.id === targetId)
      if (!target) return
      const pile = SIFENG_PILE(ownerId)
      const remains = cards.filter((cardId) => target.characterPiles[pile]?.includes(cardId))
      if (!remains.length) return
      if ((response.payload as { optionId?: string }).optionId === 'gain') {
        for (const cardId of remains) moveCard(host.state, cardId, { kind: 'characterPile', playerId: targetId, pile }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: remains, reason: SIFENG }, { sourceId: ownerId, targetId: ownerId, cardIds: remains })
      } else {
        discardSifeng(host, targetId, remains)
        if (target.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: SIFENG })
      }
    }
  },
})

function sharedSkillIds(state: SanguoshaState, leftId: PlayerId, rightId: PlayerId): string[] {
  const right = new Set(ownedSkillIds(state, rightId))
  return ownedSkillIds(state, leftId).filter((skillId) => right.has(skillId))
}

registerSkillRuntime({ id: HEYUN,
  activeActions(state, ownerId) {
    const entry = (state as Batch59State).b59XiaoQiao?.[ownerId]
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !entry
      || entry.turnNumber !== state.turnNumber || entry.phaseSeq === 0 || entry.uses >= 2) return []
    return state.players.some((player) => player.alive && player.id !== ownerId
      && sharedSkillIds(state, ownerId, player.id).length > 0)
      ? [{ id: HEYUN, label: '合韵：失去共有技能令其摸牌' }] : []
  },
  invokeActive(host, ownerId) {
    const state = host.state as Batch59State
    const entry = state.b59XiaoQiao?.[ownerId]
    if (!entry || entry.turnNumber !== host.state.turnNumber || entry.uses >= 2) return
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && sharedSkillIds(host.state, ownerId, player.id).length > 0).map((player) => player.id)
    if (!targets.length) return
    entry.uses += 1
    host.askSkill({ skillId: HEYUN, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【合韵】：选择一名与你拥有相同技能的角色', timeoutMs: 25_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.playerId !== ownerId || data.phase !== 'play') return
    const state = host.state as Batch59State
    state.b59XiaoQiao ??= {}
    state.b59XiaoQiao[ownerId] = { turnNumber: host.state.turnNumber, phaseSeq: context.event.seq, uses: 0 }
  } }],
  resume(host, ownerId, resolution, response) {
    const entry = (host.state as Batch59State).b59XiaoQiao?.[ownerId]
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const common = targetId ? sharedSkillIds(host.state, ownerId, targetId) : []
      const ownSkills = ownedSkillIds(host.state, ownerId)
      if (!targetId || !common.length || !ownSkills.length || !host.state.players.some((player) => player.id === targetId && player.alive)) {
        if (entry) entry.uses = Math.max(0, entry.uses - 1)
        return
      }
      host.askSkill({ skillId: HEYUN, ownerId, step: 'lose-skill', data: { targetId, skillIds: ownSkills }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: '【合韵】：选择失去的一个技能', timeoutMs: 25_000,
        optional: false, options: ownSkills.map((skillId) => ({ id: skillId, label: `失去【${skillId}】` })), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'lose-skill') {
      const { targetId, skillIds } = resolution.data as { targetId: PlayerId; skillIds: string[] }
      const skillId = (response.payload as { optionIds?: string[] }).optionIds?.[0]
      if (!skillId || !skillIds.includes(skillId) || !ownedSkillIds(host.state, ownerId).includes(skillId)
        || !sharedSkillIds(host.state, ownerId, targetId).length) return
      const owner = host.state.players.find((player) => player.id === ownerId)
      if (!owner) return
      owner.permanentlyLostSkills ??= []
      if (!owner.permanentlyLostSkills.includes(skillId)) owner.permanentlyLostSkills.push(skillId)
      drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: YINHUI,
  triggers: [{ event: 'RoundStart', handle(host, ownerId) {
    const hasCandidates = host.state.players.some((player) => player.alive && player.id !== ownerId && ownedSkillIds(host.state, player.id).length)
    if (hasCandidates) host.queueSkill({ skillId: YINHUI, ownerId, step: 'offer', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: YINHUI, ownerId, step: 'offer', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【音洄】：是否清除上次因此技能获得的技能并重新选择？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '清除并选择新技能' }],
      }) })
      return
    }
    if (prompt.step !== 'choose-skill') return
    const options = host.state.players.filter((player) => player.alive && player.id !== ownerId)
      .flatMap((player) => ownedSkillIds(host.state, player.id).map((skillId) => ({
        id: `${player.id}::${skillId}`, label: `${player.nickname}的【${skillId}】`,
      })))
    if (!options.length) { replaceTemporarySkill(host.state, ownerId, YINHUI_SOURCE, null); return }
    host.askSkill({ skillId: YINHUI, ownerId, step: 'choose-skill', data: { optionIds: options.map((option) => option.id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【音洄】：选择一名其他角色当前拥有的一个技能获得', timeoutMs: 25_000,
      optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      host.queueSkill({ skillId: YINHUI, ownerId, step: 'choose-skill', data: {} })
      return
    }
    if (resolution.step !== 'choose-skill') return
    const selected = (response.payload as { optionId?: string }).optionId
    const allowed = (resolution.data as { optionIds: string[] }).optionIds
    if (!selected || !allowed.includes(selected)) return
    const split = selected.indexOf('::')
    if (split < 1) return
    const targetId = selected.slice(0, split)
    const skillId = selected.slice(split + 2)
    if (!host.state.players.some((player) => player.id === targetId && player.alive
      && ownedSkillIds(host.state, targetId).includes(skillId))) return
    replaceTemporarySkill(host.state, ownerId, YINHUI_SOURCE, skillId)
  },
})

registerSkillRuntime({ id: CHIYUN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId) {
    const entry = zhouYuState(host.state, ownerId)
    entry.gainedThisPhase = false
    entry.phaseSeq = host.state.seq
  } }, { event: 'GainCard', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (data.playerId !== ownerId || !data.cardIds?.length || !zhouYuSkillOnTurn(host.state, ownerId)) return
    const entry = zhouYuState(host.state, ownerId)
    if (entry.gainedThisPhase) return
    entry.gainedThisPhase = true
    if (host.state.players.some((player) => player.alive && player.id !== ownerId))
      host.queueSkill({ skillId: CHIYUN, ownerId, step: 'target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!owner || !owner.zones.hand.length || !candidates.length) return
    host.askSkill({ skillId: CHIYUN, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【炽沄】：选择一名其他角色并交给其任意张手牌',
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!targetId || !owner?.zones.hand.length || !host.state.players.some((player) => player.id === targetId && player.alive && player.id !== ownerId)) return
      host.askSkill({ skillId: CHIYUN, ownerId, step: 'give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【炽沄】：选择交给目标的手牌（至少一张）',
        timeoutMs: 25_000, optional: true, cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'choice') {
      const { targetId, colors } = resolution.data as { targetId: PlayerId; colors: Array<'red' | 'black'> }
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target) return
      if (optionId === 'draw-chain') {
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
        setChained(host as never, targetId, CHIYUN, true)
      } else if (optionId === 'reveal-fire') {
        const matching = target.zones.hand.filter((cardId) => {
          const color = effectiveCardColor(host.state, targetId, cardId)
          return color !== null && colors.includes(color)
        })
        for (const cardId of matching) host.dispatch('CardMove', {
          playerId: targetId, cardIds: [cardId], reason: CHIYUN, revealed: true,
        }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardName: CHIYUN })
      }
      return
    }
    if (resolution.step !== 'give') return
    const targetId = (resolution.data as { targetId: PlayerId }).targetId
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner || !host.state.players.some((player) => player.id === targetId && player.alive)) return
    const legal = selected.filter((cardId) => owner.zones.hand.includes(cardId))
    const given = giveCards(host, ownerId, targetId, legal, CHIYUN)
    if (!given.length) return
    const colors = new Set(given.map((cardId) => effectiveCardColor(host.state, targetId, cardId)).filter((color): color is 'red' | 'black' => color !== null))
    host.askSkill({ skillId: CHIYUN, ownerId, step: 'choice', data: { targetId, colors: [...colors] }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: targetId, prompt: '【炽沄】：选择一项', timeoutMs: 25_000, optional: false,
      options: [
        { id: 'reveal-fire', label: '展示所有与这些牌颜色相同的手牌，你对其造成1点火焰伤害' },
        { id: 'draw-chain', label: '你摸两张牌，其进入连环状态' },
      ],
    }) })
  },
})

registerSkillRuntime({ id: YANHUI,
  interceptSourceTargetEach(host, ownerId, context) {
    if (context.sourceId !== ownerId || !zhouYuSkillOnTurn(host.state, ownerId)) return false
    const target = host.state.players.find((player) => player.id === context.targetId && player.alive)
    if (!target?.zones.hand.length) return false
    host.askSkill({ skillId: YANHUI, ownerId, step: 'reveal', data: {
      targetId: context.targetId, cardId: context.cardId,
    }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【焰洄】：可展示此目标的一张手牌',
      timeoutMs: 25_000, optional: true, cardIds: [], viewOnlyCardIds: [...target.zones.hand],
      hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(target.id, index)), min: 0, max: 1, purpose: 'skill',
    }) })
    return true
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { phase?: string }
    const entry = zhouYuState(host.state, ownerId)
    entry.phaseSeq = context.event.seq
    entry.gainedThisPhase = false
    entry.revealedPlayersThisPhase = []
    entry.discardedPlayersThisPhase = []
    entry.yanhuiUsedThisPhase = false
    void data
  } }, { event: 'PhaseEnd', handle(host, ownerId, context) {
    const entry = (host.state as Batch59State).b59ZhouYu?.[ownerId]
    const data = context.event.payload as { playerId?: PlayerId }
    if (!entry || !entry.yanhuiUsedThisPhase || data.playerId !== host.state.currentPlayerId) return
    host.queueSkill({ skillId: YANHUI, ownerId, step: 'phase-end', data: {
      phaseSeq: entry.phaseSeq, discardedPlayers: [...entry.discardedPlayersThisPhase],
      revealedCount: entry.revealedPlayerIds.length,
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'phase-end') return
    const data = prompt.data as { phaseSeq: number; discardedPlayers: PlayerId[]; revealedCount: number }
    if (data.phaseSeq !== (host.state as Batch59State).b59ZhouYu?.[ownerId]?.phaseSeq) return
    const options = [
      ...(data.discardedPlayers.some((id) => host.state.players.some((player) => player.id === id && player.alive))
        ? [{ id: 'fire', label: '对一名因此技能弃置过牌的角色造成1点火焰伤害' }] : []),
      { id: 'draw', label: `摸${data.revealedCount}张牌` },
    ]
    host.askSkill({ skillId: YANHUI, ownerId, step: 'phase-end-choice', data: { ...data, options: options.map((item) => item.id) }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【焰洄】：选择一项', timeoutMs: 25_000, optional: false, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const entry = zhouYuState(host.state, ownerId)
    if (resolution.step === 'reveal') {
      const { targetId } = resolution.data as { targetId: PlayerId; cardId: CardId }
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (cardId && host.state.players.find((player) => player.id === targetId)?.zones.hand.includes(cardId)) {
        const repeated = entry.revealedCardIds.includes(cardId)
        host.dispatch('CardMove', { playerId: targetId, cardIds: [cardId], reason: YANHUI, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        if (!entry.revealedCardIds.includes(cardId)) entry.revealedCardIds.push(cardId)
        if (!entry.revealedPlayerIds.includes(targetId)) entry.revealedPlayerIds.push(targetId)
        if (!entry.revealedPlayersThisPhase.includes(targetId)) entry.revealedPlayersThisPhase.push(targetId)
        entry.yanhuiUsedThisPhase = true
        if (repeated) {
          movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
          if (!entry.discardedPlayersThisPhase.includes(targetId)) entry.discardedPlayersThisPhase.push(targetId)
        }
      }
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'phase-end-choice') {
      const data = resolution.data as { discardedPlayers: PlayerId[]; revealedCount: number; options: string[] }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'fire' && data.options.includes('fire')) {
        const candidates = data.discardedPlayers.filter((id) => host.state.players.some((player) => player.id === id && player.alive))
        if (!candidates.length) { drawCards(host.state, host.rng, ownerId, data.revealedCount, (name, payload) => host.dispatch(name, payload)); return }
        host.askSkill({ skillId: YANHUI, ownerId, step: 'fire-target', data: {}, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【焰洄】：选择一名因此技能弃置过牌的角色',
          timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
      } else {
        drawCards(host.state, host.rng, ownerId, data.revealedCount, (name, payload) => host.dispatch(name, payload))
      }
      return
    }
    if (resolution.step === 'fire-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && entry.discardedPlayersThisPhase.includes(targetId) && host.state.players.some((player) => player.id === targetId && player.alive))
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardName: YANHUI })
    }
  },
})

registerSkillRuntime({ id: FENTAO,
  offersGlobalDamageModifierAsk(host, ownerId, side, context) {
    const target = host.state.players.find((player) => player.id === context.targetId && player.alive)
    if (side !== 'target' || !target || target.id === ownerId || context.nature !== 'fire'
      || (!target.chained && !context.chainTransfer) || !zhouYuSkillOnTurn(host.state, ownerId)) return false
    const cards = pickableCardsOf(host.state, target.id, { discarderId: target.id })
    const count = Math.ceil((cards.cardIds.length + cards.hiddenCardSlots.length) / 2)
    host.askSkill({ skillId: FENTAO, ownerId, step: 'choice', data: { targetId: context.targetId, count }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: target.id, prompt: '【焚涛】：选择一项', timeoutMs: 25_000, optional: false,
      options: [
        { id: 'increase', label: '此次传导中的伤害+1' },
        { id: 'discard', label: `弃置${count}张牌，此伤害结算后进入连环状态` },
      ],
    }) })
    return true
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const entry = (host.state as Batch59State).b59ZhouYu?.[ownerId]
    if (!targetId || entry?.pendingRechain !== targetId) return
    delete entry.pendingRechain
    if (host.state.players.some((player) => player.id === targetId && player.alive)) setChained(host as never, targetId, FENTAO, true)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choice') {
      const { targetId, count } = resolution.data as { targetId: PlayerId; count: number }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'increase') { resumeDamageModifier(host as never, FENTAO, 1); return }
      if (optionId !== 'discard') { resumeDamageModifier(host as never, FENTAO, 0); return }
      if (count === 0) {
        zhouYuState(host.state, ownerId).pendingRechain = targetId
        resumeDamageModifier(host as never, FENTAO, 0)
        return
      }
      const cards = pickableCardsOf(host.state, targetId, { discarderId: targetId })
      host.askSkill({ skillId: FENTAO, ownerId, step: 'discard', data: { targetId, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: `【焚涛】：弃置${count}张牌`, timeoutMs: 25_000,
        optional: false, cardIds: cards.cardIds, hiddenCardSlots: cards.hiddenCardSlots, min: count, max: count, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const { targetId, count } = resolution.data as { targetId: PlayerId; count: number }
      const chosen = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const actual = chosen.map((item) => resolvePickedCard(host.state, targetId, item)).filter((id): id is CardId => Boolean(id))
      if (actual.length === count && new Set(actual).size === count) {
        for (const cardId of actual) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
        zhouYuState(host.state, ownerId).pendingRechain = targetId
      }
      resumeDamageModifier(host as never, FENTAO, 0)
    }
  },
})

registerSkillRuntime({ id: XIONGZI,
  limited: true,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (data.playerId !== ownerId || data.phase !== 'prepare' || !owner?.alive || owner.usedLimitedSkills.includes(XIONGZI)) return
    host.queueSkill({ skillId: XIONGZI, ownerId, step: 'offer', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    host.askSkill({ skillId: XIONGZI, ownerId, step: 'offer', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【雄姿】：是否发动限定技？', timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '令三项技能仅在你的回合发动，并保留一项或两项' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner || owner.usedLimitedSkills.includes(XIONGZI)) return
      owner.usedLimitedSkills.push(XIONGZI)
      const options = [CHIYUN, YANHUI, FENTAO].filter((skillId) => ownedSkillIds(host.state, ownerId).includes(skillId))
      host.askSkill({ skillId: XIONGZI, ownerId, step: 'retain', data: { options }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: '【雄姿】：选择保留的一项或两项技能', timeoutMs: 25_000,
        optional: false, options: options.map((skillId) => ({ id: skillId, label: `保留【${skillId}】` })), min: 1, max: Math.min(2, options.length),
      }) })
      return
    }
    if (resolution.step !== 'retain' || !owner) return
    const data = resolution.data as { options: string[] }
    const selected = (response.payload as { optionIds?: string[] }).optionIds ?? []
    if (selected.length < 1 || selected.length > 2 || new Set(selected).size !== selected.length || selected.some((skillId) => !data.options.includes(skillId))) return
    owner.permanentlyLostSkills ??= []
    for (const skillId of data.options) if (!selected.includes(skillId) && !owner.permanentlyLostSkills.includes(skillId)) owner.permanentlyLostSkills.push(skillId)
    zhouYuState(host.state, ownerId).turnOnly = true
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  },
})

registerSkillRuntime({ id: LIANGYIN,
  triggers: [{ event: 'CharacterPileMoved', handle(host, ownerId, context) {
    const movement = context.event.payload as { direction?: string; destinationKind?: string; overflow?: boolean }
    if (movement.overflow) return
    if (movement.direction === 'enter') host.queueSkill({ skillId: LIANGYIN, ownerId, step: 'draw-target', data: {} })
    else if (movement.direction === 'leave' && movement.destinationKind === 'hand')
      host.queueSkill({ skillId: LIANGYIN, ownerId, step: 'discard-target', data: {} })
  } }, { event: 'RoundEnd', handle(host, ownerId, context) {
    const data = context.event.payload as { roundNumber?: number }
    const currentRound = Number(data.roundNumber ?? host.state.roundNumber)
    const entries = (host.state as Batch59State).b59ZhouFei
    const entry = entries?.[ownerId]
    if (!entry || currentRound !== entry.roundNumber) return
    const targets = [...entry.liangyinTargets]
    const livingIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
    const uniqueHit = targets.length === 1 && livingIds.includes(targets[0]) ? targets[0] : null
    const missed = livingIds.filter((id) => !targets.includes(id))
    const uniqueMiss = missed.length === 1 ? missed[0] : null
    entry.roundNumber = currentRound + 1
    entry.liangyinTargets = []
    if (uniqueHit || uniqueMiss) host.queueSkill({ skillId: LIANGYIN, ownerId, step: 'round-choice', data: {
      roundNumber: currentRound - 1, uniqueHit, uniqueMiss,
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'round-choice') {
      const data = prompt.data as { roundNumber: number; uniqueHit: PlayerId | null; uniqueMiss: PlayerId | null }
      const options = [
        ...(data.uniqueHit ? [{ id: 'recover', label: '令本轮唯一成为“良姻”目标的角色回复1点体力' }] : []),
        ...(data.uniqueMiss ? [{ id: 'lose-hp', label: '令本轮唯一未成为“良姻”目标的角色失去1点体力' }] : []),
      ]
      if (options.length) host.askSkill({ skillId: LIANGYIN, ownerId, step: 'round-choice', data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【良姻】：处理第${data.roundNumber}轮的目标记录`,
        timeoutMs: 25_000, optional: true, options,
      }) })
      return
    }
    if (prompt.step === 'draw-target' || prompt.step === 'discard-target') {
      const mode = prompt.step === 'draw-target' ? 'draw' : 'discard'
      const candidates = host.state.players.filter((player) => player.alive && (mode === 'draw'
        || pickableCardsOf(host.state, player.id, { discarderId: ownerId }).cardIds.length + pickableCardsOf(host.state, player.id, { discarderId: ownerId }).hiddenCardSlots.length > 0))
        .map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: LIANGYIN, ownerId, step: `${mode}-target`, data: { mode }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: mode === 'draw' ? '【良姻】：令一名角色摸一张牌' : '【良姻】：令一名角色弃置一张牌',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target' || resolution.step === 'draw-target' || resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const entry = zhouFeiState(host.state, ownerId)
      if (!targetId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
      if (!entry.liangyinTargets.includes(targetId)) entry.liangyinTargets.push(targetId)
      if (resolution.step === 'draw-target') drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      else {
        const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
        if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
        host.askSkill({ skillId: LIANGYIN, ownerId, step: 'discard-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: targetId, prompt: '【良姻】：弃置一张牌', timeoutMs: 25_000,
          optional: false, ...pickable, min: 1, max: 1, purpose: 'skill',
        }) })
      }
      return
    }
    if (resolution.step === 'discard-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      return
    }
    if (resolution.step === 'round-choice') {
      const data = resolution.data as { uniqueHit: PlayerId | null; uniqueMiss: PlayerId | null }
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'recover' && data.uniqueHit && host.state.players.some((player) => player.id === data.uniqueHit && player.alive)) recover(host as never, data.uniqueHit, 1, ownerId)
      else if (choice === 'lose-hp' && data.uniqueMiss && host.state.players.some((player) => player.id === data.uniqueMiss && player.alive)) loseHp(host as never, data.uniqueMiss, 1, LIANGYIN)
      return
    }
  },
})

registerSkillRuntime({ id: KONGSHENG,
  triggers: [{ event: 'CharacterPileMoved', handle(host, ownerId, context) {
    const movement = context.event.payload as { direction?: string; overflow?: boolean }
    if (movement.direction === 'enter' && !movement.overflow) zhouFeiState(host.state, ownerId)
  } }, { event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.playerId === ownerId && data.phase === 'prepare') host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'collect', data: { targetId: ownerId } })
  } }, { event: 'Recover', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
      host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'collect', data: { targetId: host.state.currentPlayerId } })
  } }, { event: 'LoseHp', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
      host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'collect', data: { targetId: host.state.currentPlayerId } })
  } }, { event: 'PhaseEnd', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.phase !== 'finish' || !data.playerId) return
    if ((host.state.players.find((player) => player.id === data.playerId)?.characterPiles[KONGSHENG_PILE(ownerId)]?.length ?? 0) > 0)
      host.queueSkill({ skillId: KONGSHENG, ownerId, step: 'finish', data: { targetId: data.playerId } })
  } }, { event: 'AfterCardUse', handle(host, ownerId, context) {
    const entry = (host.state as Batch59State).b59ZhouFei?.[ownerId]
    const payload = context.event.payload as { cardId?: CardId }
    const pending = entry?.pendingKongsheng
    if (context.event.sourceId !== ownerId || !pending || pending.cardId !== payload.cardId) return
    delete entry.pendingKongsheng
    const target = host.state.players.find((player) => player.id === pending.targetId && player.alive)
    const pile = KONGSHENG_PILE(ownerId)
    const remains = target?.characterPiles[pile] ?? []
    for (const cardId of [...remains]) moveCard(host.state, cardId, { kind: 'characterPile', playerId: pending.targetId, pile }, { kind: 'hand', playerId: pending.targetId })
    if (remains.length) host.dispatch('GainCard', { playerId: pending.targetId, cardIds: remains, reason: KONGSHENG }, { targetId: pending.targetId, cardIds: remains })
    if (!target?.characterPiles[pile]?.length) setKongshengPileVisibility(host.state, pending.targetId, ownerId, false)
  } }],
  slashUseQuotaBypass(state) { return state.phase === 'finish' },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'collect') {
      const targetId = (prompt.data as { targetId?: PlayerId }).targetId
      const target = targetId ? host.state.players.find((player) => player.id === targetId && player.alive) : undefined
      if (!target || target.id !== host.state.currentPlayerId) return
      const pickable = pickableCardsOf(host.state, target.id, { includeJudgingArea: true })
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: KONGSHENG, ownerId, step: 'collect-cards', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【箜声】：可将${target.nickname}区域里任意张牌扣置于其武将牌上`,
        timeoutMs: 25_000, optional: true, ...pickable, min: 1, max: pickable.cardIds.length + pickable.hiddenCardSlots.length, purpose: 'skill',
      }) })
      return
    }
    if (prompt.step !== 'finish') return
    const targetId = (prompt.data as { targetId: PlayerId }).targetId
    const pile = host.state.players.find((player) => player.id === targetId)?.characterPiles[KONGSHENG_PILE(ownerId)] ?? []
    if (!pile.length) return
    host.askSkill({ skillId: KONGSHENG, ownerId, step: 'use-offer', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【箜声】：是否使用${host.state.players.find((player) => player.id === targetId)?.nickname ?? '该角色'}武将牌上的一张“箜声”牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '选择并使用其中一张牌' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'collect-cards') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const unique = [...new Set(selected)]
      const pile = KONGSHENG_PILE(ownerId)
      let placed = 0
      for (const selectedId of unique) {
        const cardId = resolvePickedCard(host.state, targetId, selectedId)
        if (!cardId) continue
        if (movePickedCard(host as never, targetId, cardId, { kind: 'characterPile', playerId: targetId, pile })) placed += 1
      }
      if (placed) setKongshengPileVisibility(host.state, targetId, ownerId, true)
      return
    }
    if (resolution.step === 'use-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const pile = host.state.players.find((player) => player.id === targetId)?.characterPiles[KONGSHENG_PILE(ownerId)] ?? []
      const actions = pile.flatMap((cardId) => characterPileCardUseActions(host.state, ownerId, targetId, cardId, KONGSHENG))
      if (!actions.length) return
      host.askSkill({ skillId: KONGSHENG, ownerId, step: 'use-card', data: { targetId, actions: actions.map(({ id, cardIds }) => ({ id, cardId: cardIds[0] })) }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【箜声】：选择一张合法的“箜声”牌并选择使用目标',
        timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    if (resolution.step === 'use-card') {
      const { targetId, actions } = resolution.data as { targetId: PlayerId; actions: Array<{ id: string; cardId: CardId }> }
      const actionId = (response.payload as { optionId?: string }).optionId
      const action = actions.find((candidate) => candidate.id === actionId)
      const source = host.state.players.find((player) => player.id === ownerId && player.alive)
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (!action || !source || !target?.characterPiles[KONGSHENG_PILE(ownerId)]?.includes(action.cardId)) return
      const valid = characterPileCardUseActions(host.state, ownerId, targetId, action.cardId, KONGSHENG).some((candidate) => candidate.id === action.id)
      if (!valid) return
      const entry = zhouFeiState(host.state, ownerId)
      entry.pendingKongsheng = { targetId, cardId: action.cardId }
      host.performSkillCardAction({ playerId: ownerId, cardOwnerId: targetId, cardId: action.cardId, sourceSkillId: KONGSHENG, actionId: action.id })
    }
  },
})

registerSkillRuntime({ id: JUZHAN,
  interceptTarget(host, ownerId, context) { return yanYanTargetInterceptor(host, ownerId, context) },
  interceptSourceTargetEach(host, ownerId, context) { return yanYanTargetInterceptor(host, ownerId, context) },
  interceptBystanderTarget(host, ownerId, context) { return yanYanTargetInterceptor(host, ownerId, context) },
  globalProhibitsSourceTarget(state, ownerId, sourceId, targetId) {
    return yanYanState(state, ownerId).blockedUses.some((restriction) => restriction.sourceId === sourceId
      && restriction.targetId === targetId && restriction.turnNumber === state.turnNumber)
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId) {
    const entry = yanYanState(host.state, ownerId)
    entry.seenSlashTargets = []
    entry.seenSlashUses = []
    entry.blockedUses = entry.blockedUses.filter((restriction) => restriction.turnNumber >= host.state.turnNumber)
  } }],
  resume(host, ownerId, resolution, response) {
    const entry = yanYanState(host.state, ownerId)
    if (resolution.step === 'activate-yang') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const sourceId = (resolution.data as { sourceId: PlayerId }).sourceId
      if (!host.state.players.some((player) => player.id === sourceId && player.alive)
        || !host.state.players.some((player) => player.id === ownerId && player.alive)) { host.resumeCardTarget(); return }
      entry.mode = 'yin'
      entry.count = 0
      entry.blockedUses.push({ sourceId, targetId: ownerId, turnNumber: host.state.turnNumber })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      drawCards(host.state, host.rng, sourceId, 1, (name, payload) => host.dispatch(name, payload))
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'activate-yin') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const pickable = target ? pickableCardsOf(host.state, targetId) : null
      if (!target || !pickable || pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) { host.resumeCardTarget(); return }
      entry.mode = 'yang'
      entry.count = 0
      host.askSkill({ skillId: JUZHAN, ownerId, step: 'yin-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【拒战·阴】：获得${target.nickname}区域里的一张牌`,
        timeoutMs: 25_000, optional: false, ...pickable, min: 1, max: 1, purpose: 'skill',
      }) })
      return
    }
    if (resolution.step === 'yin-card') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JUZHAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
        entry.blockedUses.push({ sourceId: ownerId, targetId, turnNumber: host.state.turnNumber })
      }
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({ id: CHENGSHI,
  globalSlashUses(_state, ownerId, targetId) { return ownerId === targetId ? 1 : 0 },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const data = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = data.cardId
    if (context.event.sourceId !== ownerId || data.cardName !== '杀' || !cardId || !host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CHENGSHI }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  } }],
})

const HISTORICAL_BATCH59_UNORDERED: readonly CharacterDefinition[] = [
  { id: 'cheli-ji-b59', name: '彻里吉', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: QICHE, name: '驱乘', description: '锁定技，你使用【杀】无距离限制，且不因此技能使用的【杀】只能指定上家/下家为目标。当你使用指定唯一目标的【杀】结算后，若此【杀】目标角色的上家/下家不是你且未造成伤害，此【杀】不计入次数，然后你视为对其的上家/下家使用一张普通【杀】。' },
    { id: QIANGYONG, name: '羌勇', description: '锁定技，你使用【杀】造成伤害时，弃置受伤角色的X张牌（X为本回合你使用【杀】的次数），然后若其没有手牌，此【杀】伤害+1。' },
  ] },
  { id: 'sun-jun-shi-b59', name: '势·孙峻', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XIONGTU, name: '凶图', description: '出牌阶段限一次，你可展示一名其他角色的一张手牌，并选择一项：1.弃置之；2.弃置X张牌并对其造成1点伤害（X为本回合未进入过弃牌堆的花色数）。若如此做，本回合你不因此技能造成伤害后，你摸一张牌，然后此技能本阶段改为限两次。' },
    { id: XIANSHUAI, name: '先率', description: '锁定技，你回合内首次使用一种花色的手牌时，不计入次数且无次数限制。' },
  ] },
  { id: 'cao-zhen-shi-b59', name: '势·曹真', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SIFENG, name: '伺锋', description: '结束阶段，你可将牌堆顶的三张牌以任意顺序分配并扣置于任意名其他角色的武将牌上，称为“伺锋”。武将牌上有“伺锋”的角色：于其回合内使用牌后，你移去其武将牌上的首张“伺锋”，若其使用的牌与移去“伺锋”颜色不同，其弃置一张手牌；其回合结束时，若有“伺锋”未被移去，你选择一项：1.获得其武将牌上的“伺锋”；2.移去其武将牌上剩余的“伺锋”，然后对其造成1点伤害。' },
  ] },
  { id: 'zhou-yu-shi-b59', name: '势·周瑜', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CHIYUN, name: '炽沄', description: '你每阶段首次获得牌后，可交给一名其他角色任意张手牌，其选择一项：1.展示所有与这些牌颜色相同的手牌，你对其造成1点火焰伤害；2.你摸两张牌，其进入连环状态。' },
    { id: YANHUI, name: '焰洄', description: '你使用牌指定目标后，可展示一名目标角色的一张手牌，若此牌本回合已被展示过，你弃置之。此阶段结束时，你选择一项：1.对一名本阶段因此因弃置而失去过牌的角色造成1点火焰伤害；2.摸X张牌（X为本回合展示过牌的角色数）。' },
    { id: FENTAO, name: '焚涛', description: '锁定技，有连环状态的其他角色受到火焰伤害时，其选择一项：1.此次传导中的伤害+1；2.弃置一半牌（向上取整），此伤害结算后其进入连环状态。' },
    { id: XIONGZI, name: '雄姿', description: '限定技，准备阶段，你可令本局游戏的“炽沄”，“焰洄”和“焚涛”只能在你的回合内发动，然后仅保留其中全部的一选项或二选项，并摸两张牌。' },
  ] },
  { id: 'shi-xiao-qiao-b59', name: '势·小乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: HEYUN, name: '合韵', description: '出牌阶段限两次，你可选择一名与你有相同技能的角色，然后你失去一个技能并令其摸两张牌。' },
    { id: YINHUI, name: '音洄', description: '每轮开始时，你可清除因此获得的技能，然后你选择一名其他角色当前拥有的一个技能获得之。' },
  ] },
  { id: 'zhou-fei-jie-b59', name: '界周妃', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LIANGYIN, name: '良姻', description: '当有牌被置于武将牌上时，你可令一名角色摸一张牌；当任意角色获得一名角色武将牌上的牌时，你可令一名角色弃置一张牌。每轮结束时，你可令本轮内：唯一成为“良姻”目标的角色回复1点体力，或唯一未成为“良姻”目标的角色失去1点体力。' },
    { id: KONGSHENG, name: '箜声', description: '准备阶段，或你回复或失去体力后，你可将当前回合角色任意张牌扣置于其武将牌上；其结束阶段，你可使用其中一张牌，其获得其余的牌。' },
  ] },
  { id: 'yan-yan-jie-b59', name: '界严颜', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JUZHAN, name: '拒战', description: '转换技，若你初始势力为蜀，此技能初始状态为阴。阳：你或此状态下第3次有角色成为【杀】目标后，你可与此【杀】使用者各摸一张牌，其本回合不能对你使用牌；阴：你或此状态下第3次有角色使用【杀】指定目标后，你可获得此【杀】目标一张牌，你本回合不能对其使用牌。' },
    { id: CHENGSHI, name: '乘势', description: '你的出【杀】次数+1，并于此【杀】结算后获得之。' },
  ] },
  { id: 'wanglang-star-b59', name: '星·王朗', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: FUYU, name: '负隅', description: '每回合各限一次，你成为其他角色使用基本牌或普通锦囊牌的唯一目标时，或你使用基本牌或普通锦囊牌指定其他角色为唯一目标时，你可与其拼点，若此牌使用者赢，此牌额外结算一次；没赢，此牌无效。若你的拼点结果与上次发动此技能时相同，你摸两张牌。' },
    { id: ZHANSHI, name: '瞻势', description: '有角色进行拼点时，你可选择此次拼点中的任意名角色并弃置等量张牌，此次拼点结算后，所选角色中每有一名角色赢，你摸三张牌。' },
  ] },
  { id: 'cuiyan-maojie-b59', name: '崔琰毛玠', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHENGPI, name: '征辟', description: '准备阶段，你可以选择至多一名其他角色，其选择令你获得其区域内的一至三张牌，然后你交给其等量张牌。每名角色限一次，若其选择三，则你因“征辟”中选择的角色数+1。' },
    { id: FENGYING, name: '奉迎', description: '限定技，出牌阶段，你可以选择一名角色，然后你令其攻击范围内的所有其他角色必须将一张手牌当作【无中生有】对其使用；然后若该角色的体力上限为全场最多，则你于此回合结束后执行一个额外的回合。' },
  ] },
  { id: 'heqi-shi-b59', name: '势·贺齐', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: HEQI_SHANXI, name: '闪袭', description: '出牌阶段，你可以将一张“应机”牌当【决斗】对一名其他角色使用（每名角色每阶段限一次）。' },
    { id: HEQI_QIZHOU, name: '绮胄', description: '①有牌进入你的判定区或装备区后，你可以选择一名有手牌的角色，标记其一张手牌为“应机”牌；若此牌为【杀】，则你下次以此法发动后摸两张牌并标记为“应机”牌。②摸牌阶段，你额外摸两张牌并标记为“应机”牌。“应机”牌于任意角色回合结束时，若仍在手牌区，则弃置之。' },
  ] },
]

const HISTORICAL_BATCH59_ORDER = [
  'cheli-ji-b59', 'sun-jun-shi-b59', 'zhou-yu-shi-b59', 'zhou-fei-jie-b59', 'wanglang-star-b59',
  'cao-zhen-shi-b59', 'shi-xiao-qiao-b59', 'yan-yan-jie-b59', 'cuiyan-maojie-b59', 'heqi-shi-b59',
]
const HISTORICAL_BATCH59_ORDER_INDEX = new Map(HISTORICAL_BATCH59_ORDER.map((id, index) => [id, index]))
export const HISTORICAL_BATCH59_CHARACTERS: readonly CharacterDefinition[] = [...HISTORICAL_BATCH59_UNORDERED]
  .sort((left, right) => HISTORICAL_BATCH59_ORDER_INDEX.get(left.id)! - HISTORICAL_BATCH59_ORDER_INDEX.get(right.id)!)
