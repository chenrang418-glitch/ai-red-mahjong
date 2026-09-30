import { drawCards } from '../../engine/draw'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { getAttackRange, getDistance } from '../../engine/distance'
import { weaponCardsOf } from '../../engine/equipment-slots'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { queueDamagePoint, queueNextDamagePoint, damagePointsOf, remainingDamagePoints } from '../../engine/per-damage-point'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerPindianContinuation, canPindian, startPindian } from '../../engine/pindian'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { schedulePhaseSkipForPlayer } from '../../engine/turn'
import { handleEquipmentLost } from '../../engine/equipment'
import { effectiveCardName, effectiveDamageNature, locateOwnedCard, moveCard, setCardNature } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { clearDeclinedThisPhase, declinedThisPhase, markDeclinedThisPhase } from '../../engine/phase-usage'
import { loseHp } from '../../engine/hp'
import { useVirtualWine } from '../../engine/virtual-wine'
import { grantSkill } from '../../engine/skills/runtime'
import { resolveDamage } from '../../engine/damage'
import { clearTemporaryCardSkillTag, hasTemporaryCardSkillTag, setTemporaryCardSkillTag } from '../../engine/temporary-card-skill-tags'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const B45 = '-b45'
const ZHAOHAN = `zhaohan${B45}`
const RANGJIE = `rangjie${B45}`
const YIZHENG = `yizheng${B45}`
const JIEYUE = `jieyue${B45}`
const XUANFENG = `xuanfeng${B45}`
const JIE_GONGQI = `gongqi${B45}`
const JIE_JIEFAN = `jiefan${B45}`
const JIE_LIHUO = `lihuo${B45}`
const JIE_CHUNLAO = `chunlao${B45}`
const JIE_QUANJI = `quanji${B45}`
const JIE_ZILI = `zili${B45}`
const JIE_PAIYI = `paiyi${B45}`
const JIEFAN_DECISION = `jiefan-decision${B45}`
const DISCARD_ONE = 'discard-one'
const MOVE_EQUIPMENT = 'move-equipment'

function playerOf(state: SanguoshaState, id: PlayerId) { return state.players.find((player) => player.id === id) }

function rangjieMovable(state: SanguoshaState): CardId[] {
  return fieldCards(state).filter(({ cardId }) => fieldMoveDestinations(state, cardId).length > 0).map(({ cardId }) => cardId)
}

type CardCategory = 'basic' | 'trick' | 'equipment'
function rangjieAvailableTypes(state: SanguoshaState): CardCategory[] {
  return (['basic', 'trick', 'equipment'] as const).filter((category) => state.zones.discardPile.some((id) => state.cards[id]?.category === category)
    || state.zones.drawPile.some((id) => state.cards[id]?.category === category))
}

function askRangjieDraw(host: SkillHost, ownerId: PlayerId, remaining: number): void {
  host.askSkill({ skillId: RANGJIE, ownerId, step: 'draw', data: { remaining }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: '【让节】：摸一张牌', timeoutMs: 20_000,
    optional: false, options: [{ id: 'draw', label: '摸一张牌' }],
  }) })
}

function rangjieDrawType(host: SkillHost, ownerId: PlayerId, category: CardCategory, remaining: number): void {
  const discardCandidates = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.category === category)
  const drawAvailable = host.state.zones.drawPile.some((id) => host.state.cards[id]?.category === category)
  if (discardCandidates.length && drawAvailable) {
    host.askSkill({ skillId: RANGJIE, ownerId, step: 'source', data: { category, remaining }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【让节】：选择从哪个牌区获得牌', timeoutMs: 20_000,
      optional: false, options: [{ id: 'discard', label: '从弃牌堆选择' }, { id: 'draw', label: '从牌堆获得' }],
    }) })
    return
  }
  if (discardCandidates.length) {
    host.askSkill({ skillId: RANGJIE, ownerId, step: 'discard-card', data: { category, remaining }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【让节】：选择弃牌堆中一张符合类型的牌获得',
      timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: discardCandidates, hiddenCardSlots: [], min: 1, max: 1,
    }) })
    return
  }
  const drawCandidates = drawAvailable ? host.state.zones.drawPile.filter((id) => host.state.cards[id]?.category === category) : []
  const drawCard = drawCandidates.length ? host.rng.pick(drawCandidates) : undefined
  if (!drawCard) { finishRangjiePoint(host, ownerId, remaining); return }
  host.state.zones.drawPile.splice(host.state.zones.drawPile.indexOf(drawCard), 1)
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { finishRangjiePoint(host, ownerId, remaining); return }
  owner.zones.hand.push(drawCard)
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [drawCard], reason: RANGJIE }, { targetId: ownerId, cardIds: [drawCard] })
  askRangjieDraw(host, ownerId, remaining)
}

function finishRangjiePoint(host: SkillHost, ownerId: PlayerId, remaining: number): void {
  queueNextDamagePoint(host, { skillId: RANGJIE, ownerId, step: 'invoke', remaining })
}

registerSkillRuntime({
  id: ZHAOHAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const count = owner.marks[`${ZHAOHAN}:count`] ?? 0
    if (count >= 7) return
    owner.marks[`${ZHAOHAN}:count`] = count + 1
    if (count < 4) {
      gainMaxHp(host as never, ownerId, 1, ZHAOHAN)
      recover(host as never, ownerId, 1, ownerId)
    } else loseMaxHp(host as never, ownerId, 1, ZHAOHAN)
  } }],
})

registerSkillRuntime({
  id: RANGJIE,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const amount = damagePointsOf((context.event.payload as { amount?: unknown }).amount)
    if (amount > 0) queueDamagePoint(host, { skillId: RANGJIE, ownerId, step: 'invoke', remaining: amount })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke' || !playerOf(host.state, ownerId)?.alive) return
    const remaining = remainingDamagePoints(prompt.data)
    if (remaining <= 0) return
    const categories = rangjieAvailableTypes(host.state)
    const canMove = rangjieMovable(host.state).length > 0
    if (!canMove && categories.length === 0) { finishRangjiePoint(host, ownerId, remaining); return }
    host.askSkill({ skillId: RANGJIE, ownerId, step: 'invoke', data: { remaining }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【让节】：是否选择一项并摸一张牌？',
      timeoutMs: 20_000, optional: true, options: [
        ...(canMove ? [{ id: 'move', label: '移动场上一张牌' }] : []),
        ...categories.map((category) => ({ id: `gain-${category}`, label: `从牌堆或弃牌堆获得一张${category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌'}` })),
        { id: 'no', label: '不发动' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const remaining = remainingDamagePoints(resolution.data)
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'invoke') {
      if (optionId === 'move') {
        const candidates = rangjieMovable(host.state)
        if (!candidates.length) { finishRangjiePoint(host, ownerId, remaining); return }
        host.askSkill({ skillId: RANGJIE, ownerId, step: 'move-card', data: { remaining }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【让节】：选择一张场上的牌移动到另一名角色的对应区域',
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else if (optionId?.startsWith('gain-')) {
        const category = optionId.slice(5)
        if (category === 'basic' || category === 'trick' || category === 'equipment') rangjieDrawType(host, ownerId, category, remaining)
      }
      else finishRangjiePoint(host, ownerId, remaining)
      return
    }
    if (resolution.step === 'discard-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: RANGJIE }, { targetId: ownerId, cardIds: [cardId] })
      }
      if (cardId) askRangjieDraw(host, ownerId, remaining)
      else finishRangjiePoint(host, ownerId, remaining)
      return
    }
    if (resolution.step === 'source') {
      const category = resolution.data.category as CardCategory
      if (optionId === 'discard') {
        const cardIds = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.category === category)
        if (!cardIds.length) { finishRangjiePoint(host, ownerId, remaining); return }
        host.askSkill({ skillId: RANGJIE, ownerId, step: 'discard-card', data: { category, remaining }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【让节】：选择弃牌堆中一张符合类型的牌获得',
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      } else {
        const drawCandidates = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.category === category)
        const drawCard = drawCandidates.length ? host.rng.pick(drawCandidates) : undefined
        const owner = playerOf(host.state, ownerId)
        if (!drawCard || !owner?.alive) { finishRangjiePoint(host, ownerId, remaining); return }
        host.state.zones.drawPile.splice(host.state.zones.drawPile.indexOf(drawCard), 1)
        owner.zones.hand.push(drawCard)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [drawCard], reason: RANGJIE }, { targetId: ownerId, cardIds: [drawCard] })
        askRangjieDraw(host, ownerId, remaining)
      }
      return
    }
    if (resolution.step === 'move-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const targets = cardId ? fieldMoveDestinations(host.state, cardId) : []
      if (!cardId || !targets.length) { finishRangjiePoint(host, ownerId, remaining); return }
      host.askSkill({ skillId: RANGJIE, ownerId, step: 'move-target', data: { remaining, cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【让节】：选择这张牌的移动目标',
        timeoutMs: 20_000, optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'move-target') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && fieldMoveDestinations(host.state, cardId).includes(targetId)) moveFieldCard(host as never, cardId, targetId)
      askRangjieDraw(host, ownerId, remaining)
      return
    }
    if (resolution.step === 'draw') {
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      finishRangjiePoint(host, ownerId, remaining)
    }
  },
})

function yizhengCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || !canPindian(state, ownerId)) return []
  return state.players.filter((target) => target.alive && target.id !== ownerId && target.hp <= owner.hp && canPindian(state, target.id)).map((target) => target.id)
}

registerSkillRuntime({
  id: YIZHENG,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, YIZHENG)
      && yizhengCandidates(state, ownerId).length ? [{ id: YIZHENG, label: '义争：与一名体力值不大于你的角色拼点' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YIZHENG) return
    const candidateIds = yizhengCandidates(host.state, ownerId)
    if (!candidateIds.length) return
    host.askSkill({ skillId: YIZHENG, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【义争】：选择一名体力值不大于你的角色拼点',
      timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !yizhengCandidates(host.state, ownerId).includes(targetId)) return
    markUsedThisPhase(host.state, ownerId, YIZHENG)
    startPindian(host, { id: `${YIZHENG}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId, reason: YIZHENG, continuationTag: YIZHENG })
  },
})
registerPindianContinuation(YIZHENG, (host, result) => {
  if (result.outcome === 'initiator-win') schedulePhaseSkipForPlayer(host.state, result.opponentId, 'draw')
  else loseMaxHp(host as never, result.initiatorId, 1, YIZHENG)
})

const YANG_BIAO: CharacterDefinition = { id: 'yangbiao-b45', name: '杨彪', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
  { id: ZHAOHAN, name: '昭汉', description: '锁定技，你于游戏的前四个准备阶段增加1点体力上限并回复1点体力；之后的三个准备阶段减1点体力上限。', locked: true },
  { id: RANGJIE, name: '让节', description: '当你受到1点伤害后，你可以选择一项并摸一张牌：1.移动场上的一张牌；2.从牌堆或弃牌堆中获得一张你指定类型的牌。' },
  { id: YIZHENG, name: '义争', description: '出牌阶段限一次，你可以选择一名体力值不大于你的角色拼点：若你赢，跳过其下个摸牌阶段；若你没赢，你减1点体力上限。' },
] }

export const HISTORICAL_BATCH45_PART1: readonly CharacterDefinition[] = [YANG_BIAO]

function yujinRecipients(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
}

function yujinAskChoice(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const hasHand = target.zones.hand.length > 0
  const hasEquipment = Object.values(target.zones.equipment).some(Boolean)
  const options = [
    ...(hasHand && hasEquipment ? [{ id: 'keep', label: '保留一张手牌和一张装备，弃置其他牌' }] : []),
    { id: 'draw', label: '令于禁摸三张牌' },
  ]
  host.askSkill({ skillId: JIEYUE, ownerId, step: 'choice', data: { targetId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: targetId, prompt: '【节钺】：选择一项', timeoutMs: 20_000, optional: false, options,
  }) })
}

function yujinFinishDiscard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, keepHandId?: CardId, keepEquipmentId?: CardId): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const discards = target.zones.hand.filter((cardId) => cardId !== keepHandId)
  for (const [slot, cardId] of Object.entries(target.zones.equipment)) {
    if (cardId && cardId !== keepEquipmentId) {
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot: slot as never }, { kind: 'discardPile' })
      handleEquipmentLost(host, targetId, cardId)
      discards.push(cardId)
    }
  }
  for (const cardId of discards) {
    if (!host.state.zones.discardPile.includes(cardId)) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
  }
  if (discards.length) host.dispatch('LoseCard', { playerId: targetId, cardIds: discards, reason: JIEYUE }, { sourceId: ownerId, targetId, cardIds: discards })
}

registerSkillRuntime({
  id: JIEYUE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive) return
    const candidateIds = yujinRecipients(host.state, ownerId)
    if (!candidateIds.length) return
    host.askSkill({ skillId: JIEYUE, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【节钺】：交给一名其他角色一张牌',
      timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const targetId = (resolution.data.targetId as PlayerId | undefined) ?? (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (resolution.step === 'target') {
      if (!targetId || !yujinRecipients(host.state, ownerId).includes(targetId)) return
      const owner = playerOf(host.state, ownerId)
      const cards = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
      if (!cards.length) return
      host.askSkill({ skillId: JIEYUE, ownerId, step: 'gift', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【节钺】：选择交给目标角色的一张牌',
        timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
      }) })
      return
    }
    if (resolution.step === 'gift') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      const receiver = targetId ? playerOf(host.state, targetId) : undefined
      if (!cardId || !from || !receiver?.alive || from.kind === 'judgingArea') return
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: receiver.id })
      if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIEYUE }, { sourceId: ownerId, targetId: receiver.id, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: receiver.id, cardIds: [cardId], reason: JIEYUE }, { sourceId: ownerId, targetId: receiver.id, cardIds: [cardId] })
      yujinAskChoice(host, ownerId, receiver.id)
      return
    }
    if (resolution.step === 'choice') {
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      if ((response.payload as { optionId?: string }).optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      const target = playerOf(host.state, targetId)!
      if (!target.zones.hand.length || !Object.values(target.zones.equipment).some(Boolean)) return
      host.askSkill({ skillId: JIEYUE, ownerId, step: 'keep-hand', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId, prompt: '【节钺】：保留一张手牌', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'keep-hand') {
      const keepHandId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !keepHandId || !target.zones.hand.includes(keepHandId)) return
      const equipment = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
      if (!equipment.length) return yujinFinishDiscard(host, ownerId, targetId!, keepHandId)
      host.askSkill({ skillId: JIEYUE, ownerId, step: 'keep-equipment', data: { targetId, keepHandId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: targetId!, prompt: '【节钺】：保留一张装备区里的牌', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'keep-equipment') {
      const keepHandId = resolution.data.keepHandId as CardId
      const keepEquipmentId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!targetId || !keepEquipmentId || !locateOwnedCard(host.state, targetId, keepEquipmentId)) return
      yujinFinishDiscard(host, ownerId, targetId, keepHandId, keepEquipmentId)
    }
  },
})

const JIE_YUJIN: CharacterDefinition = { id: 'jie-yujin-b45', name: '界·于禁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: JIEYUE, name: '节钺', description: '结束阶段，你可以交给一名其他角色一张牌，令其选择一项：1.保留一张手牌和一张装备区里的牌，然后弃置其余的牌；2.令你摸三张牌。' },
] }

function xuanfengDiscardCount(state: SanguoshaState, ownerId: PlayerId): number {
  const ledger = state.discardPhaseLedger
  if (!ledger || ledger.ownerPlayerId !== ownerId) return 0
  return ledger.records.filter((entry) => entry.sourcePlayerId === ownerId && entry.moveReason === 'discard').length
}

function xuanfengFieldEquipment(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return fieldCards(state).filter((entry) => entry.ownerId !== ownerId && entry.slot !== null
    && fieldMoveDestinations(state, entry.cardId).length > 0).map((entry) => entry.cardId)
}

function xuanfengContinueDiscard(host: SkillHost, ownerId: PlayerId, remaining: number, chosenTargets: PlayerId[]): void {
  if (!playerOf(host.state, ownerId)?.alive || remaining <= 0) return
  const uniqueTargets = [...new Set(chosenTargets)]
  const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId
    && hasPickableCards(host.state, target.id) && (uniqueTargets.includes(target.id) || uniqueTargets.length < 2)).map((target) => target.id)
  if (!candidates.length) return
  host.askSkill({ skillId: XUANFENG, ownerId, step: 'discard-target', data: { remaining, chosenTargets: uniqueTargets }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【旋风】：选择角色弃置一张牌（最多两名不同角色，共两张）',
    timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 0, max: 1,
  }) })
}

function beginXuanfengMove(host: SkillHost, ownerId: PlayerId): void {
  const cards = xuanfengFieldEquipment(host.state, ownerId)
  if (!cards.length) return
  host.askSkill({ skillId: XUANFENG, ownerId, step: 'move-card', build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【旋风】：选择一张其他角色装备区内的牌移动',
    timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
  }) })
}

registerSkillRuntime({
  id: XUANFENG,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'discard' && xuanfengDiscardCount(host.state, ownerId) >= 2) {
        host.queueSkill({ skillId: XUANFENG, ownerId, step: 'mode', data: { cause: 'discard' } })
      }
    } },
    { event: 'EquipmentZoneLoss', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId === ownerId && payload.cardIds?.length) host.queueSkill({ skillId: XUANFENG, ownerId, step: 'mode', data: { cause: 'equipment' } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mode' || !playerOf(host.state, ownerId)?.alive) return
    const canDiscard = host.state.players.some((target) => target.alive && target.id !== ownerId && hasPickableCards(host.state, target.id))
    const canMove = xuanfengFieldEquipment(host.state, ownerId).length > 0
    if (!canDiscard && !canMove) return
    host.askSkill({ skillId: XUANFENG, ownerId, step: 'mode', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【旋风】：选择一项', timeoutMs: 20_000, optional: true,
      options: [
        ...(canDiscard ? [{ id: DISCARD_ONE, label: '弃置至多两名其他角色的共计两张牌' }] : []),
        ...(canMove ? [{ id: MOVE_EQUIPMENT, label: '移动一名其他角色装备区的一张牌至另一名角色对应区域' }] : []),
        { id: 'cancel', label: '不发动' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; targetIds?: PlayerId[]; cardIds?: string[] }
    if (resolution.step === 'mode') {
      if (payload.optionId === DISCARD_ONE) xuanfengContinueDiscard(host, ownerId, 2, [])
      else if (payload.optionId === MOVE_EQUIPMENT) beginXuanfengMove(host, ownerId)
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId) return
      const pickable = pickableCardsOf(host.state, targetId)
      host.askSkill({ skillId: XUANFENG, ownerId, step: 'discard-card', data: {
        targetId, remaining: resolution.data.remaining,
        chosenTargets: [...(resolution.data.chosenTargets as PlayerId[]), targetId],
      }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【旋风】：弃置${playerOf(host.state, targetId)?.nickname ?? '该角色'}一张牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = payload.cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XUANFENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      if (cardId) xuanfengContinueDiscard(host, ownerId, (resolution.data.remaining as number) - 1, resolution.data.chosenTargets as PlayerId[])
      return
    }
    if (resolution.step === 'move-card') {
      const cardId = payload.cardIds?.[0]
      if (!cardId) return
      const source = fieldCards(host.state).find((entry) => entry.cardId === cardId)
      const candidates = fieldMoveDestinations(host.state, cardId).filter((targetId) => targetId !== source?.ownerId)
      if (!source || !candidates.length) return
      host.askSkill({ skillId: XUANFENG, ownerId, step: 'move-target', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【旋风】：选择接收这张装备牌的另一名角色',
        timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'move-target') {
      const cardId = resolution.data.cardId as CardId
      const targetId = payload.targetIds?.[0]
      if (targetId && fieldMoveDestinations(host.state, cardId).includes(targetId)) moveFieldCard(host as never, cardId, targetId)
    }
  },
})

const JIE_LINGTONG: CharacterDefinition = { id: 'jie-lingtong-b45', name: '界·凌统', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: XUANFENG, name: '旋风', description: '当你于弃牌阶段弃置过至少两张牌，或当你失去装备区里的牌后，你可以选择一项：弃置至多两名其他角色的共计两张牌；将一名其他角色装备区内的一张牌移动到另一名其他角色的对应区域。' },
] }

function gongqiCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter((cardId) => state.cards[cardId]?.category !== 'basic')
}
function gongqiTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((target) => target.alive && target.id !== ownerId && hasPickableCards(state, target.id)).map((target) => target.id)
}

registerSkillRuntime({
  id: JIE_GONGQI,
  announcesSelf: true,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, JIE_GONGQI)
      && gongqiCandidates(state, ownerId).length > 0 && gongqiTargets(state, ownerId).length > 0
      ? [{ id: JIE_GONGQI, label: '弓骑：弃置一张非基本牌，然后弃置一名角色一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIE_GONGQI || usedThisPhase(host.state, ownerId, JIE_GONGQI)) return
    const cardIds = gongqiCandidates(host.state, ownerId)
    if (!cardIds.length) return
    host.askSkill({ skillId: JIE_GONGQI, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【弓骑】：弃置一张非基本牌', timeoutMs: 20_000,
      optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  overridesAttackRange(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner && (owner.zones.equipment.offensiveHorse || owner.zones.equipment.defensiveHorse) ? Number.POSITIVE_INFINITY : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId) return
      const from = locateOwnedCard(host.state, ownerId, cardId)
      if (!from || (from.kind !== 'hand' && from.kind !== 'equipment') || host.state.cards[cardId]?.category === 'basic') return
      markUsedThisPhase(host.state, ownerId, JIE_GONGQI)
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_GONGQI }, { sourceId: ownerId, cardIds: [cardId] })
      const candidateIds = gongqiTargets(host.state, ownerId)
      if (!candidateIds.length) return
      host.askSkill({ skillId: JIE_GONGQI, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【弓骑】：选择一名有牌的其他角色', timeoutMs: 20_000,
        optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !gongqiTargets(host.state, ownerId).includes(targetId)) return
      const pickable = pickableCardsOf(host.state, targetId)
      host.askSkill({ skillId: JIE_GONGQI, ownerId, step: 'discard', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【弓骑】：弃置${playerOf(host.state, targetId)?.nickname ?? '该角色'}一张牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIE_GONGQI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
  },
})

function jiefanAffected(state: SanguoshaState, protectedId: PlayerId): PlayerId[] {
  return state.players.filter((attacker) => attacker.alive && getDistance(state, attacker.id, protectedId) <= getAttackRange(state, attacker.id)).map((attacker) => attacker.id)
}

function resolveJiefanChoices(host: SkillHost, ownerId: PlayerId, playerIds: PlayerId[], choices: Record<string, string | undefined>, index: number, draws: number): void {
  for (let cursor = index; cursor < playerIds.length; cursor += 1) {
    const playerId = playerIds[cursor]
    const actor = playerOf(host.state, playerId)
    if (!actor?.alive) continue
    if (choices[playerId] !== 'weapon') { draws += 1; continue }
    const weapons = weaponCardsOf(host.state, playerId)
    if (!weapons.length) { draws += 1; continue }
    if (weapons.length > 1) {
      host.askSkill({ skillId: JIE_JIEFAN, ownerId, step: 'weapon', data: { playerIds, choices, index: cursor, draws }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId, prompt: '【解烦】：选择弃置一张武器牌', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: weapons, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    discardJiefanWeapon(host, ownerId, playerId, weapons[0])
  }
  if (draws && playerOf(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, draws, (name, payload) => { host.dispatch(name, payload) })
}

function discardJiefanWeapon(host: SkillHost, ownerId: PlayerId, playerId: PlayerId, cardId: CardId): boolean {
  const from = locateOwnedCard(host.state, playerId, cardId)
  if (!from || from.kind !== 'equipment' || !weaponCardsOf(host.state, playerId).includes(cardId)) return false
  moveCard(host.state, cardId, from, { kind: 'discardPile' })
  handleEquipmentLost(host, playerId, cardId)
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: JIE_JIEFAN }, { sourceId: ownerId, targetId: playerId, cardIds: [cardId] })
  return true
}

registerGroupDecision(JIEFAN_DECISION, (host, decision) => {
  const ownerId = decision.data.ownerId as PlayerId
  resolveJiefanChoices(host as unknown as SkillHost, ownerId, [...decision.playerIds], { ...decision.responses }, 0, 0)
})

registerSkillRuntime({
  id: JIE_JIEFAN,
  limited: true,
  announcesSelf: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive && !owner.usedLimitedSkills.includes(JIE_JIEFAN)
      ? [{ id: JIE_JIEFAN, label: '解烦（限定技）：选择角色，令攻击范围内含有其的角色各选择一项' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (actionId !== JIE_JIEFAN || !owner?.alive || owner.usedLimitedSkills.includes(JIE_JIEFAN)) return
    const candidates = host.state.players.filter((target) => target.alive).map((target) => target.id)
    if (!candidates.length) return
    owner.usedLimitedSkills.push(JIE_JIEFAN)
    host.askSkill({ skillId: JIE_JIEFAN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【解烦】：选择一名角色', timeoutMs: 20_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'weapon') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const data = resolution.data as { playerIds: PlayerId[]; choices: Record<string, string | undefined>; index: number; draws: number }
      const playerId = data.playerIds[data.index]
      const discarded = cardId ? discardJiefanWeapon(host, ownerId, playerId, cardId) : false
      resolveJiefanChoices(host, ownerId, data.playerIds, data.choices, data.index + 1, data.draws + (discarded ? 0 : 1))
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    const playerIds = jiefanAffected(host.state, targetId)
    startGroupDecision(host as never, {
      id: `${JIEFAN_DECISION}:${host.state.seq}`, tag: JIEFAN_DECISION, skillId: JIE_JIEFAN,
      playerIds, prompt: '【解烦】：弃置一张武器牌，或令韩当摸一张牌', timeoutMs: 20_000,
      options: [{ id: 'weapon', label: '弃置一张武器牌' }, { id: 'draw', label: '令韩当摸一张牌' }],
      optionsFor: (playerId) => weaponCardsOf(host.state, playerId).length
        ? [{ id: 'weapon', label: '弃置一张武器牌' }, { id: 'draw', label: '令韩当摸一张牌' }]
        : [{ id: 'draw', label: '令韩当摸一张牌' }],
      defaultOptionId: 'draw', data: { ownerId },
    })
  },
})

const JIE_HANDANG: CharacterDefinition = { id: 'jie-handang-b45', name: '界·韩当', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: JIE_GONGQI, name: '弓骑', description: '当你的坐骑区有牌时，你的攻击范围无限；出牌阶段限一次，你可以弃置一张非基本牌并选择一名其他角色，然后你弃置其一张牌。' },
  { id: JIE_JIEFAN, name: '解烦', description: '限定技，出牌阶段，你可以选择一名角色，然后令攻击范围内含有该角色的所有角色各选择一项：1.弃置一张武器牌；2.令你摸一张牌。' },
] }

const LIHUO_ACTION = `${JIE_LIHUO}:use`
const CHUNLAO_PILE = 'chun-b45'
const CHUNLAO_RESCUE = `${JIE_CHUNLAO}:rescue`

function jieLihuoSlashes(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => effectiveCardName(state, cardId) === '杀'
    && effectiveDamageNature(state, cardId) === 'normal'
    && declaredCardActions(state, ownerId, cardId, '杀', JIE_LIHUO, { nature: 'fire' }).some((action) => action.kind === 'use-card'))
}

registerSkillRuntime({
  id: JIE_LIHUO,
  activeActionUsesCard: true,
  announcesSelf: true,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !declinedThisPhase(state, ownerId, JIE_LIHUO)
      && jieLihuoSlashes(state, ownerId).length > 0 ? [{ id: LIHUO_ACTION, label: '疠火：将一张普通【杀】改为火【杀】使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIHUO_ACTION) return
    const candidates = jieLihuoSlashes(host.state, ownerId)
    if (!candidates.length) return
    host.askSkill({ skillId: JIE_LIHUO, ownerId, step: 'card', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【疠火】：选择一张普通【杀】改为火【杀】使用',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  outgoingDamage(state, _ownerId, context) {
    if (!context.cardId || context.chainTransfer || context.nature !== 'fire' || context.cardName !== '杀'
      || !hasTemporaryCardSkillTag(state, context.cardId, JIE_LIHUO) || !playerOf(state, context.targetId)?.chained) return null
    return { amount: context.amount + 1 }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId) { markDeclinedThisPhase(host.state, ownerId, JIE_LIHUO); return }
      if (!owner?.alive || !jieLihuoSlashes(host.state, ownerId).includes(cardId)) return
      markDeclinedThisPhase(host.state, ownerId, JIE_LIHUO)
      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', JIE_LIHUO, { nature: 'fire' }).filter((action) => action.kind === 'use-card')
      if (!actions.length) return
      const candidateIds = [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))]
      const max = Math.max(...actions.map((action) => action.kind === 'use-card' ? action.targetIds.length : 0))
      host.askSkill({ skillId: JIE_LIHUO, ownerId, step: 'targets', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【疠火】：选择火【杀】的目标', timeoutMs: 20_000,
        optional: false, candidateIds, min: 1, max,
      }) })
      return
    }
    if (resolution.step !== 'targets') return
    const cardId = resolution.data.cardId as CardId
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const action = declaredCardActions(host.state, ownerId, cardId, '杀', JIE_LIHUO, { nature: 'fire' })
      .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === targetIds.length
        && candidate.targetIds.every((targetId) => targetIds.includes(targetId)))
    if (!owner?.alive || !action || action.kind !== 'use-card') { markDeclinedThisPhase(host.state, ownerId, JIE_LIHUO); return }
    setCardNature(host.state, cardId, 'fire')
    setTemporaryCardSkillTag(host.state, cardId, JIE_LIHUO)
    host.dispatch('SkillActivated', { skillId: JIE_LIHUO, skillName: '疠火', playerId: ownerId, cardIds: [cardId], logText: `${owner.nickname}发动【疠火】，将普通【杀】改为火【杀】` }, { sourceId: ownerId, cardIds: [cardId] })
    clearDeclinedThisPhase(host.state, ownerId, JIE_LIHUO)
    executeUseCardAction(host as never, ownerId, action)
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    if (context.event.sourceId !== ownerId || !cardId || payload.cardName !== '杀' || effectiveDamageNature(host.state, cardId) !== 'fire') return
    const loss = Math.floor(cardDamageDealt(host.state, cardId) / 2)
    const owner = playerOf(host.state, ownerId)
    if (loss > 0 && owner?.alive) loseHp(host as never, ownerId, loss, JIE_LIHUO)
    if (hasTemporaryCardSkillTag(host.state, cardId, JIE_LIHUO)) {
      setCardNature(host.state, cardId, null)
      clearTemporaryCardSkillTag(host.state, cardId)
    }
  } }],
})

function chunCards(state: SanguoshaState, ownerId: PlayerId): CardId[] { return playerOf(state, ownerId)?.characterPiles?.[CHUNLAO_PILE] ?? [] }
registerSkillRuntime({
  id: JIE_CHUNLAO,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !owner?.alive || chunCards(host.state, ownerId).length) return
    const slashes = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
    if (!slashes.length) return
    host.askSkill({ skillId: JIE_CHUNLAO, ownerId, step: 'store', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【醇醪】：将任意张手牌中的【杀】置于武将牌上作为“醇”',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: slashes, hiddenCardSlots: [], min: 0, max: slashes.length,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'store') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || chunCards(host.state, ownerId).length) return
    const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => owner.zones.hand.includes(id) && host.state.cards[id]?.name === '杀')
    if (!ids.length) return
    for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: CHUNLAO_PILE })
    host.dispatch('SkillActivated', { skillId: JIE_CHUNLAO, skillName: '醇醪', playerId: ownerId, cardIds: ids, logText: `${owner.nickname}将${ids.length}张【杀】置为“醇”` }, { sourceId: ownerId, cardIds: ids })
  },
  rescueActions(state, ownerId) {
    return playerOf(state, ownerId)?.alive && chunCards(state, ownerId).length ? [{ id: CHUNLAO_RESCUE, label: '醇醪：移去一张“醇”，视为濒死角色使用【酒】' }] : []
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== CHUNLAO_RESCUE) return false
    const owner = playerOf(host.state, ownerId)
    const chunId = chunCards(host.state, ownerId)[0]
    if (!owner?.alive || !chunId || !playerOf(host.state, dyingPlayerId)?.alive) return false
    if (!useVirtualWine(host, dyingPlayerId, JIE_CHUNLAO)) return false
    moveCard(host.state, chunId, { kind: 'characterPile', playerId: ownerId, pile: CHUNLAO_PILE }, { kind: 'discardPile' })
    host.dispatch('SkillActivated', { skillId: JIE_CHUNLAO, skillName: '醇醪', playerId: ownerId, cardIds: [chunId], logText: `${owner.nickname}移去一张“醇”，令濒死角色视为使用【酒】` }, { sourceId: ownerId, targetId: dyingPlayerId, cardIds: [chunId] })
    recover(host as never, dyingPlayerId, 1, dyingPlayerId)
    return true
  },
})

const JIE_CHENGPU: CharacterDefinition = { id: 'jie-chengpu-b45', name: '界·程普', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: JIE_LIHUO, name: '疠火', description: '当你使用普通【杀】时，你可以将此【杀】改为火【杀】；若此【杀】的目标处于连环状态，此【杀】对其造成的伤害+1。你使用的火【杀】结算结束后，此火【杀】每造成2点伤害，你失去1点体力。' },
  { id: JIE_CHUNLAO, name: '醇醪', description: '结束阶段，若你没有“醇”，你可以将任意张【杀】置于武将牌上，称为“醇”；当一名角色处于濒死状态时，你可以移去一张“醇”，视为该角色使用一张【酒】。' },
] }

function quanCount(state: SanguoshaState, ownerId: PlayerId): number { return playerOf(state, ownerId)?.characterPiles?.[B45_PILE]?.length ?? 0 }
const B45_PILE = 'quan-b45'
function queueQuanji(host: SkillHost, ownerId: PlayerId, amount: number): void {
  if (amount > 0) queueDamagePoint(host, { skillId: JIE_QUANJI, ownerId, step: 'ask', remaining: amount })
}
registerSkillRuntime({
  id: JIE_QUANJI,
  triggers: [
    { event: 'AfterDamage', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && playerOf(host.state, ownerId)?.alive) queueQuanji(host, ownerId, damagePointsOf((context.event.payload as { amount?: unknown }).amount))
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = playerOf(host.state, ownerId)
      if (payload.playerId === ownerId && payload.phase === 'play' && owner?.alive && owner.zones.hand.length > owner.hp) queueQuanji(host, ownerId, 1)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask' || !playerOf(host.state, ownerId)?.alive) return
    const remaining = remainingDamagePoints(prompt.data)
    if (!remaining) return
    host.askSkill({ skillId: JIE_QUANJI, ownerId, step: 'ask', data: { remaining }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【权计】：是否摸一张牌，然后将一张手牌置为“权”？',
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动权计' }, { id: 'no', label: '不发动' }],
    }) })
  },
  maxCardsBonus(state, ownerId) { return quanCount(state, ownerId) },
  resume(host, ownerId, resolution, response) {
    const remaining = remainingDamagePoints(resolution.data)
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) {
        queueNextDamagePoint(host, { skillId: JIE_QUANJI, ownerId, step: 'ask', remaining }); return
      }
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      if (!owner.zones.hand.length) { queueNextDamagePoint(host, { skillId: JIE_QUANJI, ownerId, step: 'ask', remaining }); return }
      host.askSkill({ skillId: JIE_QUANJI, ownerId, step: 'place', data: { remaining }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【权计】：将一张手牌置于武将牌上作为“权”', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'place') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && owner?.alive && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: B45_PILE })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_QUANJI }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      }
      queueNextDamagePoint(host, { skillId: JIE_QUANJI, ownerId, step: 'ask', remaining })
    }
  },
})

registerSkillRuntime({
  id: JIE_ZILI,
  awakening: {
    phase: 'prepare', ready(state, ownerId) { return quanCount(state, ownerId) >= 3 },
    invoke(host, ownerId) {
      if (!playerOf(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: JIE_ZILI, ownerId, step: 'choice', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【自立】：选择一项', timeoutMs: 20_000,
        optional: false, options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸两张牌' }],
      }) })
    },
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice' || !playerOf(host.state, ownerId)?.alive) return
    const option = (response.payload as { optionId?: string }).optionId
    if (option === 'recover') recover(host as never, ownerId, 1, ownerId)
    else drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    loseMaxHp(host as never, ownerId, 1, JIE_ZILI)
    grantSkill(host.state, ownerId, JIE_PAIYI)
  },
})

const JIE_PAIYI_ACTION = `${JIE_PAIYI}:invoke`
registerSkillRuntime({
  id: JIE_PAIYI,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, JIE_PAIYI)
      && quanCount(state, ownerId) > 0 ? [{ id: JIE_PAIYI_ACTION, label: '排异：弃一张“权”，令一名角色摸两张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIE_PAIYI_ACTION) return
    const quan = playerOf(host.state, ownerId)?.characterPiles?.[B45_PILE] ?? []
    if (!quan.length) return
    host.askSkill({ skillId: JIE_PAIYI, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【排异】：将一张“权”置入弃牌堆', timeoutMs: 20_000,
      optional: true, purpose: 'skill', cardIds: [...quan], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !owner?.alive || !(owner.characterPiles?.[B45_PILE] ?? []).includes(cardId)) return
      markUsedThisPhase(host.state, ownerId, JIE_PAIYI)
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: B45_PILE }, { kind: 'discardPile' }, { discardReason: 'discard' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_PAIYI }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      const candidates = host.state.players.filter((target) => target.alive).map((target) => target.id)
      host.askSkill({ skillId: JIE_PAIYI, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【排异】：选择一名角色令其摸两张牌', timeoutMs: 20_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      drawCards(host.state, host.rng, target.id, 2, (name, payload) => { host.dispatch(name, payload) })
      if (target.zones.hand.length > owner.zones.hand.length) {
        resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal' })
      }
    }
  },
})

const JIE_ZHONGHUI: CharacterDefinition = { id: 'jie-zhonghui-b45', name: '界·钟会', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind', skills: [
  { id: JIE_QUANJI, name: '权计', description: '出牌阶段结束时，若你的手牌数大于体力值，或当你受到1点伤害后，你可以摸一张牌，然后将一张手牌置于武将牌上，称为“权”；你的手牌上限+X（X为“权”的数量）。' },
  { id: JIE_ZILI, name: '自立', description: '觉醒技，准备阶段，若“权”的数量不小于3，你选择一项：1.回复1点体力；2.摸两张牌。然后你减1点体力上限，获得技能“排异”。' },
  { id: JIE_PAIYI, name: '排异', description: '出牌阶段限一次，你可以将一张“权”置入弃牌堆，然后选择一名角色，其摸两张牌。若其手牌数大于你的手牌数，你对其造成1点伤害。', granted: true },
] }

export const HISTORICAL_BATCH45_PART2: readonly CharacterDefinition[] = [JIE_YUJIN, JIE_LINGTONG, JIE_HANDANG, JIE_CHENGPU, JIE_ZHONGHUI]
