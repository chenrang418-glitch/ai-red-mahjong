import type { CharacterDefinition } from './types'
import type { CardId, EquipmentSlot, PhysicalCard, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseSuitRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { getAttackRange, getDistance } from '../../engine/distance'
import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { discardCardsByIds } from '../../engine/discard-all'
import { resolveDamage } from '../../engine/damage'
import { giveCards } from '../../engine/hand-transfer'
import { hiddenHandSlot } from '../../engine/cards/host'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { skipPhase } from '../../engine/turn'
import { queueExtraPhaseAfterCurrent } from '../../engine/extra-phase'
import { equipmentSlotsOf, SLOT_LABELS } from '../../engine/equipment-slots'
import { isSoleTargetOf } from '../../engine/card-use-targets'

const b58 = (id: string) => `${id}:b58`
const ZJ_DINGZHEN = b58('dingzhen-zhangji')
const ZJ_YOUYE = b58('youye-zhangji')
const ZL_CHONGLEI = b58('chonglei-ji-zhangliao')
const ZL_DANGSHI = b58('dangshi-ji-zhangliao')
const ZL_HEYU = b58('heyu-ji-zhangliao')
const LD_DUANJIN = b58('duanjin-ji-lidian')
const LD_KAIGONG = b58('kaigong-ji-lidian')
const LD_HEYU = b58('heyu-ji-lidian')
const LJ_XIANJIAN = b58('xianjian-ji-lejin')
const LJ_ZHERUI = b58('zherui-ji-lejin')
const LJ_HEYU = b58('heyu-ji-lejin')
const FZ_CANGJIA = b58('cangjia-xing-fazheng')
const FZ_DUOHUI = b58('duohui-xing-fazheng')
const FZ_YUYUAN = b58('yuyuan-xing-fazheng')
const YQ_CANGJIA = b58('cangjia-yangqiu')
const YQ_DUOHUI = b58('duohui-yangqiu')
const YQ_YUYUAN = b58('yuyuan-yangqiu')
const ZR_ZHENWEI = b58('zhenwei-mou-zhuran')
const ZR_HEYUAN = b58('heyuan-mou-zhuran')
const ZH_QIAOBIAN = b58('qiaobian-mou-zhanghe')
const ZH_LIAOSHI = b58('liaoshi-mou-zhanghe')
const TY_ZHENXI = b58('zhenxi-mou-tianyu')
const TY_YANGSHI = b58('yangshi-mou-tianyu')
const ZR_GROUP = `${ZR_ZHENWEI}:simultaneous`

type B58State = SanguoshaState & {
  b58ZhangJi?: {
    dingzhenLocks: Record<PlayerId, { ownerId: PlayerId; throughRound: number }>
    damagedByInTurn: Record<number, PlayerId[]>
  }
  b58TianYu?: { attackRange: Record<PlayerId, number> }
  b58Flavor?: Record<PlayerId, { suits: Suit[]; yuYuanTurn: number }>
  b58TianYuUses?: Record<PlayerId, number>
  b58ResponseRob?: { phaseUses: Record<PlayerId, { turnNumber: number; count: number }>; roundDiscardChoices?: { roundNumber: number; count: number } }
  b58TurnCardUsers?: { turnNumber: number; players: PlayerId[] }
  b58ZhuRan?: Record<PlayerId, { usedTurn?: number; lastDiscardCount: number; lastEffect: 'damage' | 'draw' | null; lastTargetId?: PlayerId; aidedTargetId?: PlayerId; assisted?: Record<PlayerId, boolean> }>
  b58ZhangHe?: Record<PlayerId, { turnNumber: number; skipped: string[]; acquiredCardIds: CardId[]; usedAsBasic: boolean; extraPhaseQueued?: boolean }>
  b58LejinTraps?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; originalCard: PhysicalCard }>
  b58LejinPendingTraps?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; originalCard: PhysicalCard; sourceSkillId: string; queued?: boolean }>
}

function qiaobianOwnedCards(host: SkillHost, ownerId: PlayerId): CardId[] {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea] : []
}

function qiaobianZone(owner: NonNullable<SanguoshaState['players'][number]>, cardId: CardId): 'hand' | 'equipment' | 'judging' | null {
  if (owner.zones.hand.includes(cardId)) return 'hand'
  if (Object.values(owner.zones.equipment).includes(cardId)) return 'equipment'
  if (owner.zones.judgingArea.includes(cardId)) return 'judging'
  return null
}

function askQiaobianCost(host: SkillHost, ownerId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  const cardIds = qiaobianOwnedCards(host, ownerId)
  if (!owner || !cardIds.length) return
  host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'cost', data: { cardIds }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【巧变】：可从手牌、装备区、判定区各选择一张牌弃置',
    timeoutMs: 25_000, optional: true, cardIds, hiddenCardSlots: [], min: 0, max: Math.min(3, cardIds.length), purpose: 'skill',
  }) })
}

function askQiaobianPhases(host: SkillHost, ownerId: PlayerId, cardCount: number): void {
  const options = [
    { id: 'judge', label: '跳过判定阶段' }, { id: 'draw', label: '跳过摸牌阶段' },
    { id: 'play', label: '跳过出牌阶段' }, { id: 'discard', label: '跳过弃牌阶段' },
    { id: 'finish', label: '跳过结束阶段' },
  ]
  host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'phases', data: { cardCount }, build: (id): ChooseOptionsRequest => ({
    id, kind: 'choose-options', playerId: ownerId, prompt: `【巧变】：选择至多${cardCount}个阶段跳过`, timeoutMs: 25_000,
    optional: true, options, min: 0, max: Math.min(cardCount, options.length),
  }) })
}

function askQiaobianStealTargets(host: SkillHost, ownerId: PlayerId): void {
  const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
  if (!candidates.length) return
  host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'steal-targets', data: { candidates }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【巧变】：选择至多两名其他角色各获得一张手牌', timeoutMs: 25_000,
    optional: true, candidateIds: candidates, min: 0, max: Math.min(2, candidates.length),
  }) })
}

function qiaobianAskStealNext(host: SkillHost, ownerId: PlayerId, targets: PlayerId[], index: number): void {
  const targetId = targets[index]
  if (!targetId) return
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target?.zones.hand.length) { qiaobianAskStealNext(host, ownerId, targets, index + 1); return }
  host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'steal-card', data: { targets, index, targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【巧变】：获得${target.nickname}的一张手牌`, timeoutMs: 25_000,
    optional: false, cardIds: [], hiddenCardSlots: target.zones.hand.map((_, handIndex) => hiddenHandSlot(targetId, handIndex)), min: 1, max: 1, purpose: 'skill',
  }) })
}

function qiaobianCardCount(host: SkillHost, playerId: PlayerId): number {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  return (player?.zones.hand.length ?? 0)
    + Object.values(player?.zones.equipment ?? {}).filter(Boolean).length
    + (player?.zones.judgingArea.length ?? 0)
}

function askQiaobianMove(host: SkillHost, ownerId: PlayerId, cardCountBefore: number): void {
  const movable = fieldCards(host.state).filter((field) => fieldMoveDestinations(host.state, field.cardId).length > 0)
  if (!movable.length) return
  host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'move-card', data: { cardCountBefore, cardIds: movable.map((field) => field.cardId) }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【巧变】：移动场上的一张牌', timeoutMs: 25_000,
    optional: true, cardIds: movable.map((field) => field.cardId), hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
  }) })
}

registerSkillRuntime({ id: ZH_QIAOBIAN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId === ownerId && phase.phase === 'prepare') askQiaobianCost(host, ownerId)
      if (phase.playerId === ownerId && phase.phase === 'finish') {
        const record = (host.state as B58State).b58ZhangHe?.[ownerId]
        const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
        const living = host.state.players.filter((player) => player.alive).length
        if (record?.turnNumber === host.state.turnNumber && record.skipped.includes('discard')
          && owner && owner.zones.hand.length >= living && !record.extraPhaseQueued) {
          queueExtraPhaseAfterCurrent(host.state, ownerId, 'play', ZH_QIAOBIAN, 'finish')
          record.extraPhaseQueued = true
        }
      }
    } },
    { event: 'PhaseSkipped', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string; turnNumber?: number }
      const record = (host.state as B58State).b58ZhangHe?.[ownerId]
      if (phase.playerId !== ownerId || phase.turnNumber !== host.state.turnNumber || !phase.phase
        || record?.turnNumber !== host.state.turnNumber || !record.skipped.includes(phase.phase)) return
      host.queueSkill({ skillId: ZH_QIAOBIAN, ownerId, step: `skipped-${phase.phase}`, data: {} })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete (host.state as B58State).b58ZhangHe?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'select-phases') askQiaobianPhases(host, ownerId, Number(prompt.data.cardCount))
    else if (prompt.step === 'skipped-draw') askQiaobianStealTargets(host, ownerId)
    else if (prompt.step === 'skipped-play') {
      askQiaobianMove(host, ownerId, qiaobianCardCount(host, ownerId))
    } else if (prompt.step === 'skipped-discard') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B58State
    if (resolution.step === 'cost') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) { host.resumePhaseEntry(); return }
      if (selected.length > 3 || new Set(selected.map((cardId) => qiaobianZone(owner, cardId))).size !== selected.length
        || selected.some((cardId) => !qiaobianZone(owner, cardId))) { askQiaobianCost(host, ownerId); return }
      const equippedOrHand = selected.filter((cardId) => qiaobianZone(owner, cardId) !== 'judging')
      if (equippedOrHand.length) discardCardsByIds(host, ownerId, equippedOrHand, '巧变')
      const judging = selected.filter((cardId) => owner.zones.judgingArea.includes(cardId))
      for (const cardId of judging) moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
      if (judging.length) host.dispatch('LoseCard', { playerId: ownerId, cardIds: judging, reason: '巧变' }, { sourceId: ownerId, cardIds: judging })
      if (!selected.length) { host.resumePhaseEntry(); return }
      host.queueSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'select-phases', data: { cardCount: selected.length } })
      return
    }
    if (resolution.step === 'phases') {
      const max = Number(resolution.data.cardCount)
      const phases = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const valid = [...new Set(phases)].filter((phase) => ['judge', 'draw', 'play', 'discard', 'finish'].includes(phase)).slice(0, max)
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (owner && valid.length) {
        ;(state.b58ZhangHe ??= {})[ownerId] = { turnNumber: host.state.turnNumber, skipped: valid, acquiredCardIds: [], usedAsBasic: false }
        for (const phase of valid) skipPhase(host.state, phase as 'judge' | 'draw' | 'play' | 'discard' | 'finish')
        host.dispatch('SkillActivated', { skillId: ZH_QIAOBIAN, playerId: ownerId, result: valid }, { sourceId: ownerId })
      }
      host.resumePhaseEntry()
      return
    }
    if (resolution.step === 'steal-targets') {
      const candidates = resolution.data.candidates as PlayerId[]
      const targets = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? []).filter((id) => candidates.includes(id)).slice(0, 2)
      qiaobianAskStealNext(host, ownerId, targets, 0)
      return
    }
    if (resolution.step === 'steal-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (cardId && owner && target?.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '巧变' }, { sourceId: targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '巧变' }, { targetId: ownerId, cardIds: [cardId] })
        const active = state.b58ZhangHe?.[ownerId]
        if (active?.turnNumber === host.state.turnNumber) active.acquiredCardIds.push(cardId)
      }
      qiaobianAskStealNext(host, ownerId, resolution.data.targets as PlayerId[], Number(resolution.data.index) + 1)
      return
    }
    if (resolution.step === 'move-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId) return
      const destinations = fieldMoveDestinations(host.state, cardId)
      if (!destinations.length) return
      host.askSkill({ skillId: ZH_QIAOBIAN, ownerId, step: 'move-target', data: { cardId, handBefore: resolution.data.handBefore }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【巧变】：选择移动目标', timeoutMs: 25_000,
        optional: false, candidateIds: destinations, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'move-target') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const beforeCardCount = Number(resolution.data.cardCountBefore)
      if (targetId && fieldMoveDestinations(host.state, cardId).includes(targetId)) moveFieldCard(host, cardId, targetId)
      const afterCardCount = qiaobianCardCount(host, ownerId)
      if (afterCardCount <= beforeCardCount && targetId) drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step.startsWith('skipped-')) {
      const phase = resolution.step.slice('skipped-'.length)
      if (phase === 'draw') askQiaobianStealTargets(host, ownerId)
      else if (phase === 'play') askQiaobianMove(host, ownerId, qiaobianCardCount(host, ownerId))
      else if (phase === 'discard') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      return
    }
  },
})

registerSkillRuntime({ id: ZH_LIAOSHI,
  viewAs(state, ownerId) {
    const record = (state as B58State).b58ZhangHe?.[ownerId]
    if (!record || record.turnNumber !== state.turnNumber || record.usedAsBasic) return []
    const owner = state.players.find((player) => player.id === ownerId)
    return (record.acquiredCardIds ?? []).filter((cardId) => owner?.zones.hand.includes(cardId)).flatMap((cardId) => [
      { cardId, asCardName: '杀', label: '【料势】当【杀】使用' },
      { cardId, asCardName: '闪', label: '【料势】当【闪】使用或打出' },
    ])
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const record = (host.state as B58State).b58ZhangHe?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.sourceId === ownerId && record?.turnNumber === host.state.turnNumber
        && payload.cardId && record.acquiredCardIds.includes(payload.cardId)) record.usedAsBasic = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const record = (host.state as B58State).b58ZhangHe?.[ownerId]
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.sourceId === ownerId && record?.turnNumber === host.state.turnNumber
        && payload.cardId && record.acquiredCardIds.includes(payload.cardId)) record.usedAsBasic = true
    } },
  ],
})

registerGroupCardDecision(ZR_GROUP, (groupHost, decision) => {
  const host = groupHost as SkillHost
  const data = decision.data as { ownerId: PlayerId; targetId: PlayerId; helperId?: PlayerId }
  const ownerId = data.ownerId
  const targetId = data.targetId
  const ownerCards = decision.responses[ownerId] ?? []
  const targetCards = decision.responses[targetId] ?? []
  const helperCards = data.helperId ? decision.responses[data.helperId] ?? [] : []
  const discard = (playerId: PlayerId, cardIds: CardId[]) => {
    const player = host.state.players.find((candidate) => candidate.id === playerId)
    const valid = cardIds.filter((cardId) => player?.zones.hand.includes(cardId)
      || Object.values(player?.zones.equipment ?? {}).includes(cardId))
    if (valid.length) discardCardsByIds(host, playerId, valid, '镇围')
    return valid
  }
  const primaryDiscarded = discard(ownerId, ownerCards)
  const helperDiscarded = data.helperId ? discard(data.helperId, helperCards) : []
  const ownerDiscarded = [...primaryDiscarded, ...helperDiscarded]
  const targetDiscarded = discard(targetId, targetCards)
  const ownerSuits = new Set([
    ...discardedSuits(host, ownerId, primaryDiscarded),
    ...(data.helperId ? discardedSuits(host, data.helperId, helperDiscarded) : []),
  ])
  const targetSuits = new Set(targetDiscarded.map((cardId) => effectiveCardSuit(host.state, targetId, cardId)).filter(Boolean))
  const maxEffects = Number(ownerDiscarded.length >= targetDiscarded.length) + Number(ownerSuits.size >= targetSuits.size)
  const state = host.state as B58State
  const playerUsage = state.b58ZhuRan ??= {}
  playerUsage[ownerId] = { ...(playerUsage[ownerId] ?? {}), lastDiscardCount: ownerDiscarded.length, lastEffect: null, lastTargetId: targetId }
  if (!maxEffects) return
  host.askSkill({ skillId: ZR_ZHENWEI, ownerId, step: 'effects', data: { targetId, maxEffects }, build: (id): ChooseOptionsRequest => ({
    id, kind: 'choose-options', playerId: ownerId, prompt: `【镇围】：至多执行${maxEffects}项效果`, timeoutMs: 25_000,
    optional: true, options: [{ id: 'damage', label: '对其造成1点伤害' }, { id: 'draw', label: '摸三张牌' }], min: 0, max: maxEffects,
  }) })
})

function discardedSuits(host: SkillHost, playerId: PlayerId, cardIds: CardId[]): Suit[] {
  return cardIds.filter((cardId) => host.state.cards[cardId])
    .map((cardId) => effectiveCardSuit(host.state, playerId, cardId)).filter((suit): suit is Suit => Boolean(suit))
}

registerSkillRuntime({ id: ZR_ZHENWEI,
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive)
    const usage = (state as B58State).b58ZhuRan?.[ownerId]
    return owner && state.currentPlayerId === ownerId && state.phase === 'play' && usage?.usedTurn !== state.turnNumber
      ? [{ id: ZR_ZHENWEI, label: '镇围' }] : []
  },
  invokeActive(host, ownerId) {
    host.askSkill({ skillId: ZR_ZHENWEI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇围】：选择一名其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id), min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as B58State
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
      const usage = state.b58ZhuRan ??= {}
      ;(usage[ownerId] ??= { lastDiscardCount: 0, lastEffect: null }).usedTurn = host.state.turnNumber
      const helperId = usage[ownerId]?.aidedTargetId !== targetId ? usage[ownerId]?.aidedTargetId : undefined
      const participants = [ownerId, targetId, ...(helperId && host.state.players.some((player) => player.id === helperId && player.alive) ? [helperId] : [])]
      startGroupCardDecision(host, {
        id: `${ZR_ZHENWEI}:${host.state.seq}`, tag: ZR_GROUP, skillId: ZR_ZHENWEI,
        playerIds: participants, prompt: '【镇围】：同时秘密选择任意张牌弃置',
        cardIdsFor: (playerId) => {
          const player = host.state.players.find((candidate) => candidate.id === playerId)
          return player ? [...player.zones.hand, ...Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
        },
        min: 0, max: Math.max(...participants.map((playerId) => {
          const player = host.state.players.find((candidate) => candidate.id === playerId)
          return (player?.zones.hand.length ?? 0) + Object.values(player?.zones.equipment ?? {}).filter(Boolean).length
        })),
        timeoutMs: 25_000, data: { ownerId, targetId, helperId: participants.length > 2 ? helperId : undefined },
      })
    } else if (resolution.step === 'effects') {
      const data = resolution.data as { targetId: PlayerId; maxEffects: number }
      const choices = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const effects = choices.filter((choice) => choice === 'damage' || choice === 'draw').slice(0, data.maxEffects)
      for (const effect of effects) {
        if (effect === 'damage' && host.state.players.some((player) => player.id === data.targetId && player.alive)) {
          resolveDamage(host, { sourceId: ownerId, targetId: data.targetId, amount: 1, cardName: null, cardId: null })
        } else if (effect === 'draw' && host.state.players.some((player) => player.id === ownerId && player.alive)) {
          drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
        }
        const usage = state.b58ZhuRan?.[ownerId]
        if (usage) { usage.lastEffect = effect; usage.aidedTargetId = data.targetId; usage.lastTargetId = data.targetId }
      }
    }
  },
})

function finishHeYuan(host: SkillHost, ownerId: PlayerId, helperId: PlayerId): void {
  const state = host.state as B58State
  const usage = state.b58ZhuRan?.[ownerId]
  const helper = host.state.players.find((player) => player.id === helperId && player.alive)
  if (!usage || !helper || !usage.lastEffect) return
  const assisted = usage.assisted ??= {}
  if (assisted[helperId]) return
  assisted[helperId] = true
  usage.aidedTargetId = helperId
  if (usage.lastEffect === 'draw') {
    drawCards(host.state, host.rng, helperId, 3, (name, payload) => host.dispatch(name, payload))
  } else if (usage.lastTargetId && host.state.players.some((player) => player.id === usage.lastTargetId && player.alive)) {
    resolveDamage(host, { sourceId: helperId, targetId: usage.lastTargetId, amount: 1, cardName: null, cardId: null })
  }
}

registerSkillRuntime({ id: ZR_HEYUAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const usage = (host.state as B58State).b58ZhuRan?.[ownerId]
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !usage?.lastEffect || !owner) return
    const candidates = host.state.players.filter((player) => player.alive && player.hp < player.maxHp && !usage.assisted?.[player.id])
    if (!candidates.length) return
    host.askSkill({ skillId: ZR_HEYUAN, ownerId, step: 'target', data: { candidates: candidates.map((player) => player.id) }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【合援】：选择一名已受伤且未因合援协助过的角色',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const usage = (host.state as B58State).b58ZhuRan?.[ownerId]
    if (!usage?.lastEffect) return
    if (resolution.step === 'target') {
      const helperId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!helperId || !(resolution.data.candidates as PlayerId[]).includes(helperId) || usage.assisted?.[helperId]) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
      const required = usage.lastDiscardCount
      if (cards.length < required) return
      host.askSkill({ skillId: ZR_HEYUAN, ownerId, step: 'discard-cost', data: { helperId, cards, required }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【合援】：弃置${required}张牌，令其执行上次镇围的最后一项`,
        timeoutMs: 25_000, optional: false, cardIds: cards, hiddenCardSlots: [], min: required, max: required, purpose: 'skill',
      }) })
    } else if (resolution.step === 'discard-cost') {
      const helperId = resolution.data.helperId as PlayerId
      const cards = resolution.data.cards as CardId[]
      const required = Number(resolution.data.required)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const valid = selected.filter((cardId) => cards.includes(cardId) && (owner?.zones.hand.includes(cardId)
        || Object.values(owner?.zones.equipment ?? {}).includes(cardId)))
      if (valid.length !== required) return
      if (valid.length) discardCardsByIds(host, ownerId, valid, '合援')
      finishHeYuan(host, ownerId, helperId)
    }
  },
})

function zhangJiState(state: SanguoshaState): NonNullable<B58State['b58ZhangJi']> {
  const extended = state as B58State
  return extended.b58ZhangJi ??= { dingzhenLocks: {}, damagedByInTurn: {} }
}

function queueDingZhenTargets(host: SkillHost, ownerId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!owner) return
  const limit = Math.max(0, owner.hp)
  const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
    && getDistance(host.state, ownerId, player.id) <= limit).map((player) => player.id)
  const max = Math.min(limit, candidates.length)
  if (!max) return
  host.askSkill({ skillId: ZJ_DINGZHEN, ownerId, step: 'targets', data: { candidates, max }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【定镇】：选择至多体力值名距离内的角色', timeoutMs: 25_000,
    optional: true, candidateIds: candidates, min: 0, max,
  }) })
}

function askDingZhenTarget(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  const targetId = targetIds[index]
  if (!targetId) return
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target) { askDingZhenTarget(host, ownerId, targetIds, index + 1); return }
  const slashes = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
  const options = [
    ...(slashes.length ? [{ id: 'discard-slash', label: '弃置一张【杀】' }] : []),
    { id: 'lock-trick', label: '本轮其回合内不能指定张既为锦囊牌目标' },
  ]
  host.askSkill({ skillId: ZJ_DINGZHEN, ownerId, step: 'target-choice', data: { targetIds, index, targetId, slashIds: slashes }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: targetId, prompt: '【定镇】：选择一项', timeoutMs: 25_000, optional: false, options,
  }) })
}

function queueYouYeDistribution(host: SkillHost, ownerId: PlayerId): void {
  const pile = host.state.players.find((player) => player.id === ownerId)?.characterPiles[ZJ_YOUYE] ?? []
  const recipients = host.state.players.filter((player) => player.alive).map((player) => player.id)
  if (!pile.length || !recipients.length) return
  host.askSkill({ skillId: ZJ_YOUYE, ownerId, step: 'distribute', data: { cardIds: [...pile], recipients }, build: (id): DistributeCardsRequest => ({
    id, kind: 'distribute-cards', playerId: ownerId, prompt: '【攸业】：将所有“蓄”分配给任意角色', timeoutMs: 30_000,
    optional: false, cardIds: [...pile], recipientIds: recipients, min: pile.length, max: pile.length,
  }) })
}

registerSkillRuntime({ id: ZJ_DINGZHEN,
  triggers: [{ event: 'RoundStart', handle(host, ownerId) { queueDingZhenTargets(host, ownerId) } }],
  prohibitsTarget(state, ownerId, sourceId, cardName, cardId) {
    const lock = zhangJiState(state).dingzhenLocks[sourceId]
    if (!lock || lock.ownerId !== ownerId || lock.throughRound < state.roundNumber
      || state.currentPlayerId !== sourceId || state.phase !== 'play') return false
    const category = cardId ? state.cards[cardId]?.category
      : Object.values(state.cards).find((card) => card.name === cardName)?.category
    return category === 'trick'
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const candidates = new Set(resolution.data.candidates as PlayerId[])
      const chosen = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const targets = chosen.filter((id) => candidates.has(id) && host.state.players.some((p) => p.id === id && p.alive))
        .slice(0, Number(resolution.data.max)).sort((a, b) =>
          (host.state.players.find((p) => p.id === a)?.seat ?? 0) - (host.state.players.find((p) => p.id === b)?.seat ?? 0))
      askDingZhenTarget(host, ownerId, targets, 0)
      return
    }
    if (resolution.step === 'target-choice') {
      const targetIds = resolution.data.targetIds as PlayerId[]
      const index = Number(resolution.data.index)
      const targetId = resolution.data.targetId as PlayerId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'lock-trick' && host.state.players.some((p) => p.id === targetId && p.alive)) {
        zhangJiState(host.state).dingzhenLocks[targetId] = { ownerId, throughRound: host.state.roundNumber }
        askDingZhenTarget(host, ownerId, targetIds, index + 1)
      } else if (optionId === 'discard-slash') {
        const slashIds = (resolution.data.slashIds as CardId[]).filter((cardId) =>
          host.state.players.find((p) => p.id === targetId)?.zones.hand.includes(cardId)
          && host.state.cards[cardId]?.name === '杀')
        if (!slashIds.length) { askDingZhenTarget(host, ownerId, targetIds, index + 1); return }
        host.askSkill({ skillId: ZJ_DINGZHEN, ownerId, step: 'discard-slash', data: { targetIds, index, targetId, slashIds }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: targetId, prompt: '【定镇】：弃置一张【杀】', timeoutMs: 25_000,
          optional: false, cardIds: slashIds, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }) })
      } else askDingZhenTarget(host, ownerId, targetIds, index + 1)
      return
    }
    if (resolution.step === 'discard-slash') {
      const targetId = resolution.data.targetId as PlayerId
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (target && cardId && target.zones.hand.includes(cardId) && host.state.cards[cardId]?.name === '杀') {
        discardCardsByIds(host, targetId, [cardId], '定镇')
      }
      askDingZhenTarget(host, ownerId, resolution.data.targetIds as PlayerId[], Number(resolution.data.index) + 1)
    }
  },
})

registerSkillRuntime({ id: ZJ_YOUYE,
  triggers: [
    { event: 'TurnStart', handle(host) {
      zhangJiState(host.state).damagedByInTurn[host.state.turnNumber] = []
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceId?: PlayerId | null; targetId?: PlayerId; finalAmount?: number }
      if (payload.finalAmount === 0 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
      host.queueSkill({ skillId: ZJ_YOUYE, ownerId, step: 'distribute', data: {} })
    } },
    { event: 'DamageSettled', handle(host, _ownerId, context) {
      const targetId = context.event.targetId
      if (context.event.sourceId && targetId) {
        const records = zhangJiState(host.state).damagedByInTurn[host.state.turnNumber] ??= []
        if (!records.includes(targetId)) records.push(targetId)
      }
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.phase !== 'finish' || !phase.playerId || phase.playerId === ownerId) return
      const damaged = zhangJiState(host.state).damagedByInTurn[host.state.turnNumber] ?? []
      const pile = host.state.players.find((p) => p.id === ownerId)?.characterPiles[ZJ_YOUYE] ?? []
      if (damaged.includes(ownerId) || pile.length >= 5 || !host.state.zones.drawPile.length) return
      const cardId = host.state.zones.drawPile[0]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: ZJ_YOUYE })
      host.dispatch('CharacterPileMoved', { ownerId, pile: ZJ_YOUYE, direction: 'enter', cardIds: [cardId] }, { targetId: ownerId, cardIds: [cardId] })
    } },
  ],
  startQueued(host, ownerId, prompt) { if (prompt.step === 'distribute') queueYouYeDistribution(host, ownerId) },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'distribute') return
    const cardIds = resolution.data.cardIds as CardId[]
    const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
    for (const { cardId, recipientId } of assignments) {
      const pile = host.state.players.find((p) => p.id === ownerId)?.characterPiles[ZJ_YOUYE] ?? []
      const target = host.state.players.find((p) => p.id === recipientId && p.alive)
      if (!cardIds.includes(cardId) || !pile.includes(cardId) || !target) continue
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: ZJ_YOUYE }, { kind: 'hand', playerId: recipientId })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: '攸业' }, { sourceId: ownerId, targetId: recipientId, cardIds: [cardId] })
    }
  },
})

function flavorState(state: SanguoshaState, ownerId: PlayerId): NonNullable<B58State['b58Flavor']>[PlayerId] {
  const flavors = (state as B58State).b58Flavor ??= {}
  return flavors[ownerId] ??= { suits: [], yuYuanTurn: 0 }
}

function hasUnrecordedSuit(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): boolean {
  const suit = effectiveCardSuit(state, ownerId, cardId)
  return Boolean(suit && !flavorState(state, ownerId).suits.includes(suit))
}

function askFlavorDuoHui(host: SkillHost, skillId: string, ownerId: PlayerId, giverId: PlayerId): void {
  const giver = host.state.players.find((player) => player.id === giverId && player.alive)
  if (!giver?.zones.hand.length) return
  host.askSkill({ skillId, ownerId, step: 'give', data: { giverId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: giverId, prompt: '【堕洄】：是否交给技能拥有者一张手牌？', timeoutMs: 25_000,
    optional: true, cardIds: [...giver.zones.hand], hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
  }) })
}

function chooseDuoHuiEffect(host: SkillHost, skillId: string, ownerId: PlayerId, giverId: PlayerId, suit: Suit): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!owner) return
  const sameSuit = owner.zones.hand.filter((cardId) => host.state.cards[cardId]
    && effectiveCardSuit(host.state, ownerId, cardId) === suit)
  host.askSkill({ skillId, ownerId, step: 'effect', data: { giverId, suit, sameSuit }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【堕洄】：选择一项', timeoutMs: 25_000, optional: false, options: [
      ...(sameSuit.length ? [{ id: 'return', label: '交给其另一张同花色的牌' }] : []),
      { id: 'draw', label: '令其摸一张牌' },
    ],
  }) })
}

function makeFlavorRuntimes(config: { characterId: string; ownerKey: 'fazheng' | 'yangqiu'; ids: { cangjia: string; duohui: string; yuyuan: string } }): void {
  const { characterId, ids } = config
  registerSkillRuntime({ id: ids.cangjia,
    triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || (host.state.currentPlayerId === ownerId && host.state.phase === 'play')) return
      const state = flavorState(host.state, ownerId)
      for (const cardId of payload.cardIds ?? []) {
        const suit = effectiveCardSuit(host.state, ownerId, cardId)
        if (suit && !state.suits.includes(suit)) state.suits.push(suit)
      }
    } }],
    prohibitsCardUse(state, ownerId, context) {
      if (context.userId !== ownerId || state.currentPlayerId !== ownerId || state.phase !== 'play') return false
      return (context.cardIds ?? []).some((cardId) => hasUnrecordedSuit(state, ownerId, cardId))
    },
    interceptTarget(host, ownerId, context) {
      if (context.targetId !== ownerId || context.sourceId === ownerId || !hasUnrecordedSuit(host.state, ownerId, context.cardId)) return false
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return false
      host.askSkill({ skillId: ids.cangjia, ownerId, step: 'pay-target', data: { targetId: ownerId, cardId: context.cardId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【藏铗】：弃置一张牌，令此牌对你有效；否则此牌对你无效', timeoutMs: 25_000,
        optional: true, cardIds: [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))],
        hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
      }) })
      return true
    },
    resume(host, ownerId, resolution, response) {
      if (resolution.step !== 'pay-target') return
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = host.state.players.find((player) => player.id === ownerId && player.alive)
      const canPay = cardId && target && [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))].includes(cardId)
      if (canPay) discardCardsByIds(host, ownerId, [cardId], '藏铗')
      else {
        const active = host.state.cardResolution
        if (active) {
          const sourceId = active.kind === 'slash' ? active.sourceId : active.sourceId
          const activeTarget = active.kind === 'slash' ? active.targetId : active.targetIds[active.targetIndex]
          if (sourceId !== ownerId && activeTarget === ownerId) {
            if (active.kind === 'slash') (active as unknown as { targetCancelled?: boolean }).targetCancelled = true
            else if (!active.cancelledTargetIds.includes(ownerId)) active.cancelledTargetIds.push(ownerId)
          }
        }
      }
      const active = host.state.cardResolution
      if (active?.kind === 'slash') host.resumeCardTarget()
      else if (active?.kind === 'trick') host.resumeCardTarget()
    },
  })
  registerSkillRuntime({ id: ids.duohui,
    triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.phase !== 'prepare' || !phase.playerId || phase.playerId === ownerId) return
      askFlavorDuoHui(host, ids.duohui, ownerId, phase.playerId)
    } }],
    resume(host, ownerId, resolution, response) {
      const giverId = resolution.data.giverId as PlayerId
      if (resolution.step === 'give') {
        const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
        const giver = host.state.players.find((player) => player.id === giverId && player.alive)
        const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
        if (!cardId || !giver?.zones.hand.includes(cardId) || !owner) return
        const suit = effectiveCardSuit(host.state, giverId, cardId)
        if (!suit) return
        giveCards(host, giverId, ownerId, [cardId], '堕洄')
        chooseDuoHuiEffect(host, ids.duohui, ownerId, giverId, suit)
      } else if (resolution.step === 'effect') {
        const optionId = (response.payload as { optionId?: string }).optionId
        const giver = host.state.players.find((player) => player.id === giverId && player.alive)
        if (optionId === 'draw' && giver) drawCards(host.state, host.rng, giverId, 1, (name, payload) => host.dispatch(name, payload))
        else if (optionId === 'return') {
          const cards = (resolution.data.sameSuit as CardId[]).filter((cardId) => host.state.players.find((p) => p.id === ownerId)?.zones.hand.includes(cardId))
          if (!cards.length || !giver) return
          host.askSkill({ skillId: ids.duohui, ownerId, step: 'return-card', data: { giverId, cards }, build: (id): ChooseCardsRequest => ({
            id, kind: 'choose-cards', playerId: ownerId, prompt: '【堕洄】：选择另一张同花色牌交给其', timeoutMs: 25_000,
            optional: false, cardIds: cards, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
          }) })
        }
      } else if (resolution.step === 'return-card') {
        const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
        const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
        const giver = host.state.players.find((player) => player.id === giverId && player.alive)
        if (cardId && owner?.zones.hand.includes(cardId) && giver) giveCards(host, ownerId, giverId, [cardId], '堕洄')
      }
    },
  })
  registerSkillRuntime({ id: ids.yuyuan,
    activeActions(state, ownerId) {
      const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === characterId)
      const record = (state as B58State).b58Flavor?.[ownerId]
      return owner && state.phase === 'play' && state.currentPlayerId === ownerId && record?.suits.length
        && record.yuYuanTurn !== state.turnNumber ? [{ id: 'draw', label: '跃渊' }] : []
    },
    invokeActive(host, ownerId) {
      const record = flavorState(host.state, ownerId)
      if (!record.suits.length || record.yuYuanTurn === host.state.turnNumber) return
      record.yuYuanTurn = host.state.turnNumber
      drawCards(host.state, host.rng, ownerId, record.suits.length, (name, payload) => host.dispatch(name, payload))
      const suits = [...record.suits]
      host.askSkill({ skillId: ids.yuyuan, ownerId, step: 'clear-suit', data: { suits }, build: (id): ChooseSuitRequest => ({
        id, kind: 'choose-suit', playerId: ownerId, prompt: '【跃渊】：清除一种已记录的花色', timeoutMs: 25_000,
        optional: false, suits,
      }) })
    },
    resume(host, ownerId, resolution, response) {
      if (resolution.step !== 'clear-suit') return
      const suit = (response.payload as { suit?: Suit }).suit
      const record = flavorState(host.state, ownerId)
      if (suit && (resolution.data.suits as Suit[]).includes(suit)) record.suits = record.suits.filter((entry) => entry !== suit)
    },
  })
}

makeFlavorRuntimes({ characterId: 'xing-fazheng-b58', ownerKey: 'fazheng', ids: { cangjia: FZ_CANGJIA, duohui: FZ_DUOHUI, yuyuan: FZ_YUYUAN } })
makeFlavorRuntimes({ characterId: 'yangqiu-b58', ownerKey: 'yangqiu', ids: { cangjia: YQ_CANGJIA, duohui: YQ_DUOHUI, yuyuan: YQ_YUYUAN } })

function askZhenXiChoice(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!owner || !target || (host.state as B58State).b58TianYuUses?.[ownerId] === host.state.turnNumber) return
  const handCount = target.zones.hand.length
  const field = fieldCards(host.state).filter((card) => card.ownerId === targetId)
  const canDiscard = handCount > 0
  const canMove = field.some((card) => fieldMoveDestinations(host.state, card.cardId).length > 0)
  if (!canDiscard && !canMove) return
  const backwater = target.hp >= Math.max(...host.state.players.filter((player) => player.alive).map((player) => player.hp))
    || target.hp > owner.hp
  const options = [
    ...(canDiscard ? [{ id: 'discard', label: `弃置其至多${Math.min(getDistance(host.state, ownerId, targetId), handCount)}张手牌` }] : []),
    ...(canMove ? [{ id: 'move', label: '移动其场上的一张牌' }] : []),
    ...(backwater && canDiscard && canMove ? [{ id: 'backwater', label: '背水：依次执行上述两项' }] : []),
  ]
  host.askSkill({ skillId: TY_ZHENXI, ownerId, step: 'choice', data: { targetId, cardId, backwater }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【震袭】：选择一项', timeoutMs: 25_000, optional: true, options,
  }) })
}

function askZhenXiDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId, maximum: number, thenMove: boolean): void {
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target) return
  const slots = target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index))
  const max = Math.min(maximum, slots.length)
  host.askSkill({ skillId: TY_ZHENXI, ownerId, step: 'discard', data: { targetId, cardId, thenMove, max }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【震袭】：选择弃置目标的手牌', timeoutMs: 25_000,
    optional: true, cardIds: [], hiddenCardSlots: slots, min: 0, max, purpose: 'skill',
  }) })
}

function askZhenXiFieldCard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): void {
  const cards = fieldCards(host.state).filter((field) => field.ownerId === targetId
    && fieldMoveDestinations(host.state, field.cardId).length > 0)
  if (!cards.length) return
  host.askSkill({ skillId: TY_ZHENXI, ownerId, step: 'field-card', data: { targetId, cardId, fieldCardIds: cards.map((field) => field.cardId) }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【震袭】：选择移动其场上的一张牌', timeoutMs: 25_000,
    optional: false, cardIds: cards.map((field) => field.cardId), hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
  }) })
}

registerSkillRuntime({ id: TY_ZHENXI,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || payload.cardName !== '杀'
      || (host.state as B58State).b58TianYuUses?.[ownerId] === host.state.turnNumber) return
    const targetId = payload.targetIds?.find((id) => host.state.players.some((player) => player.id === id && player.alive))
    if (targetId && payload.cardId) askZhenXiChoice(host, ownerId, targetId, payload.cardId)
  } }],
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const slashId = resolution.data.cardId as CardId
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'choice') {
      if (!choice) return
      ;((host.state as B58State).b58TianYuUses ??= {})[ownerId] = host.state.turnNumber
      const backwater = choice === 'backwater'
      const discard = choice === 'discard' || backwater
      const move = choice === 'move' || backwater
      if (discard) {
        const target = host.state.players.find((player) => player.id === targetId && player.alive)
        const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
        if (target && owner) {
          const amount = Math.min(getDistance(host.state, ownerId, targetId), target.zones.hand.length)
          if (amount > 0) { askZhenXiDiscard(host, ownerId, targetId, slashId, amount, move); return }
        }
      }
      if (move) askZhenXiFieldCard(host, ownerId, targetId, slashId)
      return
    }
    if (resolution.step === 'discard') {
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const realCards = selected.map((id) => resolvePickedCard(host.state, targetId, id))
        .filter((id): id is CardId => Boolean(id && target?.zones.hand.includes(id)))
        .slice(0, Number(resolution.data.max))
      if (realCards.length) discardCardsByIds(host, targetId, realCards, '震袭')
      if (resolution.data.thenMove) askZhenXiFieldCard(host, ownerId, targetId, slashId)
      return
    }
    if (resolution.step === 'field-card') {
      const fieldCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const fieldInfo = fieldCardId && (resolution.data.fieldCardIds as CardId[]).includes(fieldCardId)
        ? fieldCards(host.state).find((card) => card.cardId === fieldCardId && card.ownerId === targetId)
        : undefined
      const destinations = fieldInfo ? fieldMoveDestinations(host.state, fieldInfo.cardId) : []
      if (!fieldInfo || !destinations.length) return
      host.askSkill({ skillId: TY_ZHENXI, ownerId, step: 'field-target', data: { targetId, cardId: slashId, fieldCardId, destinations }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【震袭】：选择移动目标', timeoutMs: 25_000,
        optional: false, candidateIds: destinations, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'field-target') {
      const destination = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const fieldCardId = resolution.data.fieldCardId as CardId
      if (destination && (resolution.data.destinations as PlayerId[]).includes(destination)
        && fieldMoveDestinations(host.state, fieldCardId).includes(destination)) moveFieldCard(host, fieldCardId, destination)
    }
  },
})

registerSkillRuntime({ id: TY_YANGSHI,
  attackRangeBonus(state, ownerId) {
    return (state as B58State).b58TianYu?.attackRange[ownerId] ?? 0
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
    const others = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    const range = getAttackRange(host.state, ownerId)
    const coversAll = others.every((target) => getDistance(host.state, ownerId, target.id) <= range)
    if (coversAll) {
      const slash = host.state.zones.drawPile.find((cardId) => host.state.cards[cardId]?.name === '杀')
      if (slash) {
        moveCard(host.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [slash], reason: '扬师' }, { targetId: ownerId, cardIds: [slash] })
      }
    } else {
      const extensions = host.state as B58State
      const state = extensions.b58TianYu ??= { attackRange: {} }
      state.attackRange[ownerId] = (state.attackRange[ownerId] ?? 0) + 1
    }
  } }],
})

function turnCardUsers(state: SanguoshaState): PlayerId[] {
  const usage = (state as B58State).b58TurnCardUsers
  return usage?.turnNumber === state.turnNumber ? usage.players : []
}

function askLidianDiscard(host: SkillHost, skillId: string, ownerId: PlayerId, targetId: PlayerId): void {
  const pick = pickableCardsOf(host.state, targetId)
  if (!pick.cardIds.length && !pick.hiddenCardSlots.length) return
  host.askSkill({ skillId, ownerId, step: 'target-card', data: { targetId, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【${skillId === LD_DUANJIN ? '断津' : '慨公'}】：选择${host.state.players.find((player) => player.id === targetId)?.nickname ?? '该角色'}的一张牌弃置`,
    timeoutMs: 25_000, optional: true, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: 0, max: 1, purpose: 'skill',
  }) })
}

function makeLidianRuntime(skillId: string): void {
  registerSkillRuntime({ id: skillId,
    triggers: [
      { event: 'CardUsed', handle(host, _ownerId, context) {
        const userId = context.event.sourceId
        if (!userId) return
        const extended = host.state as B58State
        const usage = extended.b58TurnCardUsers
        if (!usage || usage.turnNumber !== host.state.turnNumber) extended.b58TurnCardUsers = { turnNumber: host.state.turnNumber, players: [userId] }
        else if (!usage.players.includes(userId)) usage.players.push(userId)
      } },
      { event: 'CardResolved', handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (context.event.sourceId !== ownerId || !payload.cardId || host.state.cards[payload.cardId]?.category !== 'basic') return
        const eligible = turnCardUsers(host.state).filter((id) => id !== ownerId
          && host.state.players.some((player) => player.id === id && player.alive)
          && (() => { const pick = pickableCardsOf(host.state, id); return pick.cardIds.length + pick.hiddenCardSlots.length > 0 })())
        if (eligible.length) host.queueSkill({ skillId, ownerId, step: 'target', data: { eligible } })
      } },
    ],
    startQueued(host, ownerId, prompt) {
      if (prompt.step !== 'target') return
      const eligible = (prompt.data.eligible as PlayerId[]).filter((id) => host.state.players.some((p) => p.id === id && p.alive)
        && (() => { const pick = pickableCardsOf(host.state, id); return pick.cardIds.length + pick.hiddenCardSlots.length > 0 })())
      if (!eligible.length) return
      host.askSkill({ skillId, ownerId, step: 'target', data: { eligible }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【${skillId === LD_DUANJIN ? '断津' : '慨公'}】：选择本回合使用过牌的一名其他角色`,
        timeoutMs: 25_000, optional: true, candidateIds: eligible, min: 0, max: 1,
      }) })
    },
    resume(host, ownerId, resolution, response) {
      if (resolution.step === 'target') {
        const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
        if (!targetId || !(resolution.data.eligible as PlayerId[]).includes(targetId) || !host.state.players.some((p) => p.id === targetId && p.alive)) return
        askLidianDiscard(host, skillId, ownerId, targetId)
      } else if (resolution.step === 'target-card') {
        const targetId = resolution.data.targetId as PlayerId
        const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
        if (!selected || ![...(resolution.data.cardIds as CardId[]), ...(resolution.data.hiddenCardSlots as string[])].includes(selected)) return
        const cardId = resolvePickedCard(host.state, targetId, selected)
        if (cardId) discardCardsByIds(host, targetId, [cardId], skillId === LD_DUANJIN ? '断津' : '慨公')
      }
    },
  })
}

makeLidianRuntime(LD_DUANJIN)
makeLidianRuntime(LD_KAIGONG)

function askZhangLiaoSteal(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const pick = pickableCardsOf(host.state, targetId)
  if (!pick.cardIds.length && !pick.hiddenCardSlots.length) return
  host.askSkill({ skillId: ZL_CHONGLEI, ownerId, step: 'take-card', data: { targetId, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【冲垒】：获得该角色区域里的一张牌', timeoutMs: 25_000,
    optional: false, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: 1, max: 1, purpose: 'skill',
  }) })
}

function damageCardTargets(host: SkillHost, ownerId: PlayerId, cardName: string, targetIds: PlayerId[]): PlayerId[] {
  if (cardName !== '杀' && !DAMAGE_TRICKS.has(cardName)) return []
  return targetIds.filter((id) => id !== ownerId && host.state.players.some((player) => player.id === id && player.alive))
}

function askDangShiTarget(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], cardId: CardId, cardName: string): void {
  const candidates = damageCardTargets(host, ownerId, cardName, targetIds)
  if (!candidates.length) return
  host.askSkill({ skillId: ZL_DANGSHI, ownerId, step: 'target', data: { candidates, cardId }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【荡势】：选择此伤害牌的一名其他目标', timeoutMs: 25_000,
    optional: true, candidateIds: candidates, min: 0, max: 1,
  }) })
}

function askDangShiChoice(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): void {
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target) return
  const roundState = (host.state as B58State).b58ResponseRob ??= { phaseUses: {} }
  const discardCount = roundState.roundDiscardChoices?.roundNumber === host.state.roundNumber
    ? roundState.roundDiscardChoices.count : 0
  const cards = pickableCardsOf(host.state, targetId)
  const requiredDiscardCount = Math.max(1, discardCount + 1)
  const options = [
    ...(cards.cardIds.length + cards.hiddenCardSlots.length >= requiredDiscardCount ? [{ id: 'discard', label: `弃置${requiredDiscardCount}张牌` }] : []),
    { id: 'damage', label: '张辽对你造成1点伤害' },
  ]
  host.askSkill({ skillId: ZL_DANGSHI, ownerId, step: 'choice', data: { targetId, cardId, discardCount }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: targetId, prompt: '【荡势】：选择一项', timeoutMs: 25_000, optional: false, options,
  }) })
}

function lejinTrapIds(host: SkillHost, targetId: PlayerId): CardId[] {
  const traps = (host.state as B58State).b58LejinTraps ?? {}
  return Object.entries(traps)
    .filter(([cardId, trap]) => trap.targetId === targetId
      && host.state.players.some((player) => player.id === targetId && Object.values(player.zones.equipment).includes(cardId)))
    .map(([cardId]) => cardId)
}

function lejinFieldCardCount(host: SkillHost, targetId: PlayerId): number {
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target) return 0
  return target.zones.hand.length + Object.values(target.zones.equipment).filter(Boolean).length + target.zones.judgingArea.length
}

function askLejinEffect(host: SkillHost, ownerId: PlayerId, skillId: string, sourceId: PlayerId, cardId: CardId, allowTrap: boolean, optional = false): boolean {
  const source = host.state.players.find((player) => player.id === sourceId && player.alive)
  if (!source) return false
  const pick = pickableCardsOf(host.state, sourceId)
  const canDiscard = pick.cardIds.length + pick.hiddenCardSlots.length > 0
  const emptySlots = equipmentSlotsOf(host.state, sourceId).filter((slot) => source.zones.equipment[slot] === null)
  const canTrap = allowTrap && !Boolean((host.state as B58State).b58LejinPendingTraps?.[cardId])
    && emptySlots.length > 0 && !host.state.cards[cardId]?.virtual
  const options = [
    ...(canDiscard ? [{ id: 'discard', label: '你摸一张牌，其弃置牌' }] : []),
    ...(canTrap ? [{ id: 'trap', label: '此【杀】结算后置入其空装备栏' }] : []),
  ]
  if (!options.length) return false
  host.askSkill({ skillId, ownerId, step: 'effect', data: { sourceId, cardId, canTrap }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: skillId === LJ_ZHERUI ? sourceId : ownerId,
    prompt: skillId === LJ_ZHERUI ? '【折锐】：选择“陷坚”的一项效果' : '【陷坚】：选择一项效果',
    timeoutMs: 25_000, optional, options,
  }) })
  return true
}

function queueLejinTrapPlacement(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const state = host.state as B58State
  const pending = state.b58LejinPendingTraps?.[cardId]
  if (!pending || pending.ownerId !== ownerId || pending.queued) return
  if (!host.state.zones.discardPile.includes(cardId)) { delete state.b58LejinPendingTraps?.[cardId]; return }
  pending.queued = true
  host.queueSkill({ skillId: pending.sourceSkillId, ownerId, step: 'place-trap', data: { cardId } })
}

function askLejinTrapPlacement(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const state = host.state as B58State
  const pending = state.b58LejinPendingTraps?.[cardId]
  if (!pending || pending.ownerId !== ownerId) return
  const target = host.state.players.find((player) => player.id === pending.targetId && player.alive)
  const slots = target ? equipmentSlotsOf(host.state, target.id).filter((slot) => target.zones.equipment[slot] === null) : []
  if (!slots.length || !host.state.zones.discardPile.includes(cardId)) {
    delete state.b58LejinPendingTraps?.[cardId]
    return
  }
  host.askSkill({ skillId: pending.sourceSkillId, ownerId, step: 'place-trap', data: { cardId, targetId: pending.targetId, slots }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【陷坚】：选择放置此牌的装备栏', timeoutMs: 25_000,
    optional: false, options: slots.map((slot) => ({ id: slot, label: SLOT_LABELS[slot] })),
  }) })
}

function settleLejinTrap(host: SkillHost, ownerId: PlayerId, resolution: import('../../engine/types').SkillResolutionState,
  response: import('../../engine/requests').GameResponse): void {
  const state = host.state as B58State
  const data = resolution.data as { sourceId: PlayerId; cardId: CardId; targetId?: PlayerId; canTrap?: boolean; count?: number; slots?: EquipmentSlot[] }
  if (resolution.step === 'effect') {
    const optionId = (response.payload as { optionId?: string }).optionId
    const source = host.state.players.find((player) => player.id === data.sourceId && player.alive)
    if (!source) return
    if (optionId === 'discard') {
      const count = Math.min(Math.max(1, lejinFieldCardCount(host, source.id)), pickableCardsOf(host.state, source.id).cardIds.length + pickableCardsOf(host.state, source.id).hiddenCardSlots.length)
      if (!count) return
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      const pick = pickableCardsOf(host.state, source.id)
      host.askSkill({ skillId: resolution.skillId, ownerId, step: 'discard', data: { sourceId: source.id, count }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: source.id, prompt: `【陷坚】：弃置${count}张牌`, timeoutMs: 25_000,
        optional: false, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: count, max: count, purpose: 'skill',
      }) })
      return
    }
    if (optionId === 'trap' && data.canTrap && !host.state.cards[data.cardId]?.virtual
      && !state.b58LejinPendingTraps?.[data.cardId]) {
      state.b58LejinPendingTraps ??= {}
      state.b58LejinPendingTraps[data.cardId] = {
        ownerId, targetId: source.id, originalCard: structuredClone(host.state.cards[data.cardId]!), sourceSkillId: resolution.skillId,
      }
    }
    return
  }
  if (resolution.step === 'discard') {
    const source = data.sourceId
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const real = selected.map((id) => resolvePickedCard(host.state, source, id)).filter((id): id is CardId => Boolean(id))
    if (real.length === data.count) discardCardsByIds(host as never, source, real, '陷坚')
    return
  }
  if (resolution.step === 'place-trap') {
    const pending = state.b58LejinPendingTraps?.[data.cardId]
    const target = host.state.players.find((player) => player.id === data.targetId && player.alive)
    const slot = (response.payload as { optionId?: string }).optionId as EquipmentSlot | undefined
    if (!pending || pending.ownerId !== ownerId || !target || !slot || !data.slots?.includes(slot)
      || target.zones.equipment[slot] !== null || !host.state.zones.discardPile.includes(data.cardId)) {
      delete state.b58LejinPendingTraps?.[data.cardId]
      return
    }
    const card = host.state.cards[data.cardId]
    if (!card || card.virtual) { delete state.b58LejinPendingTraps?.[data.cardId]; return }
    host.state.cards[data.cardId] = { ...pending.originalCard, name: '陷坚', category: 'equipment', equipmentSlot: slot }
    moveCard(host.state, data.cardId, { kind: 'discardPile' }, { kind: 'equipment', playerId: target.id, slot })
    const traps = state.b58LejinTraps ??= {}
    traps[data.cardId] = { ownerId, targetId: target.id, originalCard: pending.originalCard }
    delete state.b58LejinPendingTraps?.[data.cardId]
    host.dispatch('CardMove', { cardIds: [data.cardId], sourceZone: 'discardPile', destinationZone: 'equipment', destinationPlayerId: target.id, reason: '陷坚置入装备区' },
      { sourceId: ownerId, targetId: target.id, cardIds: [data.cardId] })
  }
}

function settleLejinTrapAfterLoss(host: SkillHost, cardId: CardId): void {
  const state = host.state as B58State
  const trap = state.b58LejinTraps?.[cardId]
  if (!trap) return
  const equipped = host.state.players.find((player) => Object.values(player.zones.equipment).includes(cardId))
  if (equipped) {
    const slot = Object.entries(equipped.zones.equipment).find(([, current]) => current === cardId)?.[0] as EquipmentSlot | undefined
    if (slot) {
      state.b58LejinTraps![cardId] = { ...trap, targetId: equipped.id }
      host.state.cards[cardId] = { ...trap.originalCard, name: '陷坚', category: 'equipment', equipmentSlot: slot }
      return
    }
  }
  host.state.cards[cardId] = structuredClone(trap.originalCard)
  delete state.b58LejinTraps![cardId]
}

function askZherui(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId, cardId: CardId): boolean {
  if (!lejinTrapIds(host, sourceId).length) return false
  host.askSkill({ skillId: LJ_ZHERUI, ownerId, step: 'invoke', data: { sourceId, cardId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【折锐】：是否发动“陷坚”？', timeoutMs: 25_000,
    optional: true, options: [{ id: 'yes', label: '发动折锐' }],
  }) })
  return true
}

registerSkillRuntime({ id: LJ_XIANJIAN,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (!payload.cardId) return
      const pending = (host.state as B58State).b58LejinPendingTraps?.[payload.cardId]
      if (!pending || pending.ownerId !== ownerId) return
      if (payload.cancelled) { delete (host.state as B58State).b58LejinPendingTraps![payload.cardId]; return }
      queueLejinTrapPlacement(host, ownerId, payload.cardId)
    } },
  ],
  interceptSourceTarget(host, ownerId, context) {
    if (context.sourceId !== ownerId || context.cardName !== '杀' || context.targetId === ownerId
      || !isSoleTargetOf(host.state, context.cardId, context.targetId)) return false
    return askLejinEffect(host, ownerId, LJ_XIANJIAN, context.targetId, context.cardId, true, true)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'place-trap') askLejinTrapPlacement(host, ownerId, prompt.data.cardId as CardId)
  },
  resume(host, ownerId, resolution, response) {
    settleLejinTrap(host, ownerId, resolution, response)
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'discard' || (resolution.step === 'effect' && option !== 'discard')) host.resumeCardTarget()
  },
})

registerSkillRuntime({ id: LJ_ZHERUI,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
      if (!payload.cardId) return
      const pending = (host.state as B58State).b58LejinPendingTraps?.[payload.cardId]
      if (!pending || pending.ownerId !== ownerId) return
      if (payload.cancelled) { delete (host.state as B58State).b58LejinPendingTraps![payload.cardId]; return }
      queueLejinTrapPlacement(host, ownerId, payload.cardId)
    } },
    { event: 'LoseEquipment', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (!payload.cardId || !payload.playerId || !(host.state as B58State).b58LejinTraps?.[payload.cardId]) return
      const victim = host.state.players.find((player) => player.id === payload.playerId && player.alive)
      if (victim) resolveDamage(host as never, { sourceId: ownerId, targetId: victim.id, amount: 1, cardId: null, cardName: '折锐' })
    } },
    { event: 'EquipmentLossSettled', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (payload.cardId) settleLejinTrapAfterLoss(host, payload.cardId)
    } },
  ],
  interceptSourceTarget(host, ownerId, context) {
    return context.cardName === '杀' && askZherui(host, ownerId, context.sourceId, context.cardId)
  },
  interceptTarget(host, ownerId, context) {
    return context.cardName === '杀' && askZherui(host, ownerId, context.sourceId, context.cardId)
  },
  interceptBystanderTarget(host, ownerId, context) {
    return context.cardName === '杀' && askZherui(host, ownerId, context.sourceId, context.cardId)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'place-trap') askLejinTrapPlacement(host, ownerId, prompt.data.cardId as CardId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const sourceId = resolution.data.sourceId as PlayerId
      const cardId = resolution.data.cardId as CardId
      if (!askLejinEffect(host, ownerId, LJ_ZHERUI, sourceId, cardId, true)) host.resumeCardTarget()
      return
    }
    settleLejinTrap(host, ownerId, resolution, response)
    const option = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'discard' || (resolution.step === 'effect' && option !== 'discard')) host.resumeCardTarget()
  },
})

registerSkillRuntime({ id: ZL_CHONGLEI,
  prohibitsCardUse(state, ownerId, context) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || context.userId === ownerId || context.cardName === '闪') return false
    const player = state.players.find((candidate) => candidate.id === context.userId)
    return Boolean(player && (context.cardIds ?? []).some((cardId) => player.zones.hand.includes(cardId)
      && state.cards[cardId]?.category !== 'basic'))
  },
  prohibitsResponseCard(state, ownerId, responderId, responseCardId, cardName) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || responderId === ownerId) return false
    const responder = state.players.find((player) => player.id === responderId)
    return Boolean(responder?.zones.hand.includes(responseCardId)
      && state.cards[responseCardId]?.category !== 'basic' && cardName !== '闪')
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId === ownerId && phase.phase === 'play') {
        (host.state as B58State).b58ResponseRob ??= { phaseUses: {} }
        ;(host.state as B58State).b58ResponseRob!.phaseUses[ownerId] = { turnNumber: host.state.turnNumber, count: 0 }
      }
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { asking?: boolean }
      if (payload.asking || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      const first = context.event.sourceId
      const second = context.event.targetId
      if (!first || !second || (first !== ownerId && second !== ownerId)) return
      const targetId = first === ownerId ? second : first
      if (targetId === ownerId || !host.state.players.some((player) => player.id === targetId && player.alive)) return
      const rob = (host.state as B58State).b58ResponseRob ??= { phaseUses: {} }
      const use = rob.phaseUses[ownerId]?.turnNumber === host.state.turnNumber ? rob.phaseUses[ownerId] : { turnNumber: host.state.turnNumber, count: 0 }
      const max = host.state.players.filter((player) => player.alive && player.id !== ownerId).length
      const pick = pickableCardsOf(host.state, targetId)
      if (use.count >= max || (!pick.cardIds.length && !pick.hiddenCardSlots.length)) return
      rob.phaseUses[ownerId] = { turnNumber: host.state.turnNumber, count: use.count + 1 }
      host.queueSkill({ skillId: ZL_CHONGLEI, ownerId, step: 'take-card', data: { targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'take-card' && prompt.skillId === ZL_CHONGLEI) askZhangLiaoSteal(host, ownerId, prompt.data.targetId as PlayerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (!selected || ![...(resolution.data.cardIds as CardId[]), ...(resolution.data.hiddenCardSlots as string[])].includes(selected)) return
      const cardId = resolvePickedCard(host.state, targetId, selected)
      if (cardId && movePickedCard(host, targetId, cardId, { kind: 'hand', playerId: ownerId })) host.dispatch('GainCard', {
        playerId: ownerId, cardIds: [cardId], reason: '冲垒',
      }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({ id: ZL_DANGSHI,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || !payload.cardId || !payload.cardName || !Array.isArray(payload.targetIds)) return
    if (!damageCardTargets(host, ownerId, payload.cardName, payload.targetIds).length) return
    host.queueSkill({ skillId: ZL_DANGSHI, ownerId, step: 'target', data: { targetIds: payload.targetIds, cardId: payload.cardId, cardName: payload.cardName } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'target') askDangShiTarget(host, ownerId, prompt.data.targetIds as PlayerId[], prompt.data.cardId as CardId, String(prompt.data.cardName))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !(resolution.data.candidates as PlayerId[]).includes(targetId)) return
      askDangShiChoice(host, ownerId, targetId, resolution.data.cardId as CardId)
    } else if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'damage') resolveDamage(host, { sourceId: ownerId, targetId, amount: 1, cardName: null, cardId: null })
      else if (optionId === 'discard') {
        const rob = (host.state as B58State).b58ResponseRob ??= { phaseUses: {} }
        const count = Number(resolution.data.discardCount)
        rob.roundDiscardChoices = { roundNumber: host.state.roundNumber, count: count + 1 }
        const pick = pickableCardsOf(host.state, targetId)
        const required = Math.max(1, count + 1)
        if (pick.cardIds.length + pick.hiddenCardSlots.length < required) return
        host.askSkill({ skillId: ZL_DANGSHI, ownerId, step: 'discard', data: { targetId, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, required }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: targetId, prompt: `【荡势】：弃置${required}张牌`, timeoutMs: 25_000,
          optional: false, cardIds: pick.cardIds, hiddenCardSlots: pick.hiddenCardSlots, min: required, max: required, purpose: 'skill',
        }) })
      }
    } else if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const real = selected.map((id) => resolvePickedCard(host.state, targetId, id)).filter((id): id is CardId => Boolean(id))
      const required = Number(resolution.data.required)
      if (real.length === required) discardCardsByIds(host, targetId, real, '荡势')
    }
  },
})

registerSkillRuntime({ id: ZL_HEYU })
registerSkillRuntime({ id: LD_HEYU })
registerSkillRuntime({ id: LJ_HEYU })

export const HISTORICAL_BATCH58_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'zhangji-b58', name: '张既', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZJ_DINGZHEN, name: '定镇', description: '每轮开始时，你可令与你距离X以内的至多X名其他角色依次选择一项（X为你的体力值）：1.弃一张【杀】；2.本轮其于回合内不能指定你为锦囊牌的目标。' },
    { id: ZJ_YOUYE, name: '攸业', description: '锁定技，本回合未对你造成过伤害的其他角色的结束阶段，你将牌堆顶的一张牌置于你的武将牌上，称为“蓄”（至多五张）。你造成或受到伤害后，将所有“蓄”分配给任意角色。' },
  ] },
  { id: 'ji-zhangliao-b58', name: '骥·张辽', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZL_CHONGLEI, name: '冲垒', description: '锁定技，你的出牌阶段内，所有其他角色的非基本手牌均只能作为【闪】使用或打出；出牌阶段内限X次（X为其他角色数），你使用的牌被其他角色响应后，或你响应其他角色使用的牌后，你获得该角色一张牌。' },
    { id: ZL_DANGSHI, name: '荡势', description: '你使用伤害牌结算后，你可令一名是此牌目标的其他角色选择一项：1.弃置X张牌（X为所有角色本轮选择过此选项的次数，且至少为1）；2.你对其造成1点伤害。' },
    { id: ZL_HEYU, name: '合御', description: '军争：此模式无效。排位、斗地主：锁定技，若骥·乐进在场且与你阵营相同，将“冲垒”中的“非基本手牌”改为“手牌”；若骥·李典在场且与你阵营相同，将“荡势”中的X固定为3。' },
  ] },
  { id: 'ji-lidian-b58', name: '骥·李典', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LD_DUANJIN, name: '断津', description: '你使用基本牌结算后，可弃置一名本回合使用过牌的其他角色的一张牌。' },
    { id: LD_KAIGONG, name: '慨公', description: '你使用基本牌结算后，可弃置一名本回合使用过牌的其他角色的一张牌。' },
    { id: LD_HEYU, name: '合御', description: '此模式无效。排位、斗地主：若骥·乐进在场且与你阵营相同，你获得因“断津”弃置的牌；若骥·张辽在场且与你阵营相同，“慨公”使用的牌不可被响应。' },
  ] },
  { id: 'ji-lejin-b58', name: '骥·乐进', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LJ_XIANJIAN, name: '陷坚', description: '你使用【杀】指定唯一目标后，可选择一项：1.你摸一张牌，其弃置X张牌（X为其场上牌数，且至少为1）；2.此【杀】结算后，你将此【杀】置入其一个装备栏中，称为“陷坚”牌。' },
    { id: LJ_ZHERUI, name: '折锐', description: '有“陷坚”牌的角色使用【杀】指定目标后，你可对其发动一次选项由其选择的“陷坚”；有角色失去装备区里的一张“陷坚”牌后，你对其造成1点伤害。' },
    { id: LJ_HEYU, name: '合御', description: '军争：此模式无效。排位、斗地主：锁定技，若骥·张辽在场且与你阵营相同，你发动“陷坚”的【杀】造成伤害后，可对目标角色执行未选择的一项；若骥·李典在场且与你阵营相同，每回合首次有角色失去“陷坚”牌后，你摸一张牌。' },
  ] },
  { id: 'xing-fazheng-b58', name: '星·法正', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: FZ_CANGJIA, name: '藏铗', description: '锁定技，你于出牌阶段外获得牌时，记录此牌花色。你不能于出牌阶段使用未记录花色的牌；你成为其他角色使用的未记录花色的牌的目标后，除非其弃置一张牌，否则此牌对你无效。' },
    { id: FZ_DUOHUI, name: '堕洄', description: '其他角色的准备阶段，其可交给你一张牌，然后你选择一项：1.交给其另一张同花色的牌；2.令其摸一张牌。' },
    { id: FZ_YUYUAN, name: '跃渊', description: '出牌阶段限一次，你可摸X张牌（X为当前记录花色数），然后清除一个花色记录。' },
  ] },
  { id: 'yangqiu-b58', name: '阳球', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: YQ_CANGJIA, name: '藏铗', description: '锁定技，你于出牌阶段外获得牌时，记录此牌花色。你不能于出牌阶段使用未记录花色的牌；你成为其他角色使用的未记录花色的牌的目标后，除非其弃置一张牌，否则此牌对你无效。' },
    { id: YQ_DUOHUI, name: '堕洄', description: '其他角色的准备阶段，其可交给你一张牌，然后你选择一项：1.交给其另一张同花色的牌；2.令其摸一张牌。' },
    { id: YQ_YUYUAN, name: '跃渊', description: '出牌阶段限一次，你可摸X张牌（X为当前记录花色数），然后清除一个花色记录。' },
  ] },
  { id: 'mou-zhuran-b58', name: '谋·朱然', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZR_ZHENWEI, name: '镇围', description: '出牌阶段限一次，你可与一名其他角色同时选择是否弃置任意张牌。然后你可执行至多X项（X为你弃置牌大于等于其的条件数：1.牌数；2.花色数）：1.对其造成1点伤害；2.摸三张牌。' },
    { id: ZR_HEYUAN, name: '合援', description: '每名角色限一次，结束阶段，你可选择一名已受伤角色并弃置X张牌（X为你上次发动镇围时弃置的牌数），令其执行上次“镇围”执行的最后一项，且此后你对除其以外的角色发动“镇围”时，该角色也可选择弃置牌（视为你弃置的牌）。' },
  ] },
  { id: 'mou-zhanghe-b58', name: '谋·张郃', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZH_QIAOBIAN, name: '巧变', description: '准备阶段，你可弃置任意区域内各一张牌，跳过等量个阶段，并于对应阶段跳过后执行相应效果。若你以此法跳过：1.摸牌阶段：你可获得至多两名其他角色各一张手牌；2.出牌阶段：你可移动场上一张牌，然后若你牌数未增加，你可令因此场上牌数增加的角色摸两张牌；3.弃牌阶段：你摸一张牌，结束阶段，若你手牌数大于等于场上角色数，你于之后执行一个额外的出牌阶段。' },
    { id: ZH_LIAOSHI, name: '料势', description: '每回合限一次，你可将因“巧变”获得的牌当【杀】或【闪】使用或打出。' },
  ] },
  { id: 'mou-tianyu-b58', name: '谋·田豫', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: TY_ZHENXI, name: '震袭', description: '每回合限一次，你使用【杀】指定目标后，可选择一项：1. 弃置其至多X张手牌（X为你与其的距离）；2. 移动其场上的一张牌。背水：其体力值为全场最高或大于你时方可选择。' },
    { id: TY_YANGSHI, name: '扬师', description: '锁定技，你受到伤害后，若你攻击范围内包含所有其他角色，你从牌堆中获得一张【杀】；否则你攻击范围+1。' },
  ] },
]
