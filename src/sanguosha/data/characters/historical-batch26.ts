import { drawCards } from '../../engine/draw'
import { armNextGainCardMultiplier, consumeGainCardCount } from '../../engine/card-gain-modifier'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { restoreCharacter } from '../../engine/character-state'
import { createVirtualSlashCard, executeUseCardAction } from '../../engine/cards/basic'
import { DAMAGE_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { getAttackRange, getDistance } from '../../engine/distance'
import { damageCardCategory } from '../../engine/damage-provenance'
import { queueExtraTurn } from '../../engine/turn'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { abolishableSlotsOf, abolishSlot, abolishedSlotsOf, restoreSlot } from '../../engine/equipment-slots'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { abolishJudgmentArea, isJudgmentAreaAbolished, restoreJudgmentArea } from '../../engine/judgment-area'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { ZoneRef } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/** 第 26 批历史人物。资源先走现有 fallback，技能状态全部放在可序列化牌局状态中。 */
type Batch26State = SanguoshaState & {
  wangkuang?: Record<PlayerId, { first: 'discard' | 'draw'; turn: number }>
  wangshuangFloors?: Record<CardId, Record<PlayerId, number>>
  zhangyanLangdao?: Record<CardId, { ownerId: PlayerId; targetId: PlayerId; options: string[]; kill: boolean }>
  zhangyanDisabled?: Record<PlayerId, string[]>
  sunlangInvalid?: Record<CardId, PlayerId[]>
  pangshanCaisi?: Record<PlayerId, { turn: number; count: number; disabled: boolean; doubleNextGain?: boolean }>
  pangshanTurnLedger?: Record<PlayerId, { turn: number; uses: number; gains: number }>
  zhouxuanUsed?: Record<PlayerId, { round: number; dream?: boolean; names: string[] }>
  zhouxuanSnapshot?: { ownerId: PlayerId; turn: number; hp: Record<PlayerId, number> }
  zhouxuanPendingDream?: { ownerId: PlayerId; targetId: PlayerId }
  zhouxuanWatch?: { turn: number; name: string }
  zhouxuanFire?: { ownerId: PlayerId; targetId: PlayerId }
  fengyuShao?: Record<PlayerId, number>
  fengyuDraw?: Record<PlayerId, { turn: number; count: number }>
  huzhaoHuomo?: Record<PlayerId, number>
  huzhaoJudgingAbolished?: Record<PlayerId, boolean>
  huzhaoAbolished?: Record<PlayerId, EquipmentSlot[]>
  fuganQiaojian?: Record<PlayerId, { ownerId: PlayerId; targetId: PlayerId; turn: number; slash: boolean; trick: boolean; ban: boolean }>
  fuganIgnored?: Record<PlayerId, CardId[]>
  sufeiDismantle?: Record<PlayerId, { ownerId: PlayerId; targetId: PlayerId; n: number; index: number }>
  fuganXicha?: Record<PlayerId, { targetId: PlayerId; cards: CardId[] }>
  fuganXichaCapture?: Record<PlayerId, { targetId: PlayerId; cards: CardId[] }>
  fuganPendingRepeat?: Record<PlayerId, { targetId: PlayerId; cardName: string; targetIds: PlayerId[] }>
  fuganUsed?: Record<PlayerId, Record<PlayerId, number>>
  sufeiCount?: Record<PlayerId, { turn: number; count: number; disabled: boolean }>
}

function stateOf(host: SkillHost): Batch26State { return host.state as Batch26State }
function playerOf(state: SanguoshaState, id: PlayerId) { return state.players.find((player) => player.id === id) }
function others(state: SanguoshaState, id: PlayerId) { return state.players.filter((player) => player.alive && player.id !== id) }
function equipmentIds(state: SanguoshaState, id: PlayerId): CardId[] {
  const player = playerOf(state, id)
  return player ? Object.values(player.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)) : []
}
function ownedIds(state: SanguoshaState, id: PlayerId): CardId[] {
  const player = playerOf(state, id)
  return player ? [...player.zones.hand, ...equipmentIds(state, id)] : []
}
function discardOwned(host: SkillHost, playerId: PlayerId, ids: CardId[], reason: string): CardId[] {
  const moved: CardId[] = []
  for (const id of ids) {
    const from = locateOwnedCard(host.state, playerId, id)
    if (!from) continue
    moveCard(host.state, id, from, { kind: 'discardPile' })
    moved.push(id)
  }
  if (moved.length) host.dispatch('LoseCard', { playerId, cardIds: moved, reason }, { sourceId: playerId, cardIds: moved })
  return moved
}
function gainOne(host: SkillHost, targetId: PlayerId, cardId: CardId, from: ZoneRef, reason: string): boolean {
  if (!host.state.cards[cardId]) return false
  if (from.kind === 'discardPile' && !host.state.zones.discardPile.includes(cardId)) return false
  const zone = from.kind === 'hand' || from.kind === 'equipment' ? locateOwnedCard(host.state, from.playerId, cardId) : from
  if (!zone) return false
  const count = consumeGainCardCount(host.state, targetId, 1)
  const gained = [cardId]
  const pool = from.kind === 'discardPile' ? host.state.zones.discardPile : from.kind === 'drawPile' ? host.state.zones.drawPile : []
  for (const extraId of pool) {
    if (gained.length >= count || extraId === cardId || !host.state.cards[extraId]) continue
    gained.push(extraId)
  }
  for (const gainedId of gained) {
    const source = gainedId === cardId ? zone : from
    moveCard(host.state, gainedId, source, { kind: 'hand', playerId: targetId })
  }
  host.dispatch('GainCard', { playerId: targetId, cardIds: gained, reason }, { sourceId: targetId, targetId, cardIds: gained })
  return true
}
function basicDamageCard(state: SanguoshaState, id: CardId): boolean {
  return damageCardCategory(state, { cardId: id }) === 'trick'
}
function isDamageCard(state: SanguoshaState, id: CardId): boolean { const card = state.cards[id]; return card?.name === '杀' || (card?.category === 'trick' && DAMAGE_TRICKS.has(card.name)) }
function randomCardId(host: SkillHost, predicate: (id: CardId) => boolean): CardId | null { const ids = host.state.zones.drawPile.filter((id) => Boolean(host.state.cards[id]) && predicate(id)); return ids.length ? host.rng.pick(ids) : null }
function gainDrawnCard(host: SkillHost, ownerId: PlayerId, cardId: CardId, reason: string): void { if (!host.state.zones.drawPile.includes(cardId)) return; gainOne(host, ownerId, cardId, { kind: 'drawPile' }, reason) }
function repeatCardUse(host: SkillHost, sourceId: PlayerId, cardName: string, targetIds: PlayerId[], skillId: string): void { const cardId = cardName === '杀' ? createVirtualSlashCard(host.state, sourceId, skillId) : createVirtualTrick(host.state, sourceId, cardName, skillId); const action = { id: `repeat:${cardId}`, kind: 'use-card' as const, playerId: sourceId, label: `【${skillId}】额外结算`, cardIds: [cardId], targetIds: [...targetIds], targetMin: targetIds.length, targetMax: targetIds.length, asCardName: cardName }; executeUseCardAction(host as never, sourceId, action as never, { skipPlayInterceptors: true }) }
function hasSlashOrDamageTrick(state: SanguoshaState, id: PlayerId): boolean {
  return ownedIds(state, id).some((cardId) => state.cards[cardId]?.name === '杀' || basicDamageCard(state, cardId))
}
function promptCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, cardIds: CardId[], prompt: string, min: number, max: number, data: Record<string, unknown> = {}): void {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 20_000, optional: min === 0, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}

// 王匡【任侠】
const RENXIA = 'renxia'
function renxiaLoop(host: SkillHost, ownerId: PlayerId, mode: 'discard' | 'draw'): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  if (mode === 'draw') {
    if (hasSlashOrDamageTrick(host.state, ownerId) || host.state.zones.drawPile.length === 0) return
    drawCards(host.state, host.rng, ownerId, Math.min(2, host.state.zones.drawPile.length), (name, data) => host.dispatch(name, data))
    renxiaLoop(host, ownerId, mode)
    return
  }
  const candidates = ownedIds(host.state, ownerId)
  if (hasSlashOrDamageTrick(host.state, ownerId) || candidates.length < 2) return
  promptCards(host, RENXIA, ownerId, 'discard-loop', candidates, '【任侠】：弃置两张牌', 2, 2, { mode })
}
registerSkillRuntime({
  id: RENXIA,
  activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, RENXIA) ? [{ id: RENXIA, label: '任侠：选择摸牌或弃牌循环' }] : [] },
  invokeActive(host, ownerId) { markUsedThisPhase(host.state, ownerId, RENXIA); host.askSkill({ skillId: RENXIA, ownerId, step: 'mode', data: {}, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【任侠】：选择本阶段先执行的分支', timeoutMs: 20_000, optional: false, options: [{ id: 'draw', label: '摸两张，直到手牌有【杀】或伤害锦囊' }, { id: 'discard', label: '弃两张，直到手牌没有【杀】或伤害锦囊' }] }) }) },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) { const p = context.event.payload as { phase?: string; playerId?: PlayerId }; if (p.phase !== 'play' || p.playerId !== ownerId) return; const first = stateOf(host).wangkuang?.[ownerId]?.first; if (first) renxiaLoop(host, ownerId, first === 'draw' ? 'discard' : 'draw') } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') { const mode = (response.payload as { optionId?: 'draw' | 'discard' }).optionId; if (!mode) return; stateOf(host).wangkuang ??= {}; stateOf(host).wangkuang![ownerId] = { first: mode, turn: host.state.turnNumber }; renxiaLoop(host, ownerId, mode); return }
    if (resolution.step === 'discard-loop') { const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []; if (discardOwned(host, ownerId, ids, RENXIA).length === 2) renxiaLoop(host, ownerId, 'discard') }
  },
})

// 王双【追猎】
const ZHUILIE = 'zhuilie'
const ZHUILIE_JUDGE = 'zhuilie-judge'
registerSkillRuntime({
  id: ZHUILIE,
  slashIgnoresDistance: () => true,
  triggers: [{ event: 'TargetSpecified', handle(host, ownerId, context) { const p = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }; if (context.event.sourceId !== ownerId || p.cardName !== '杀' || !p.cardId) return; const outside = (p.targetIds ?? []).filter((id) => getDistance(host.state, ownerId, id) > getAttackRange(host.state, ownerId)); if (!outside.length) return; const state = stateOf(host); const floors = state.wangshuangFloors ??= {}; floors[p.cardId] = {}; for (const targetId of outside) performJudgment(host as never, targetId, '追猎', { tag: ZHUILIE_JUDGE, data: { ownerId, targetId, cardId: p.cardId } }); } }, { event: 'AfterCardUse', handle(host, ownerId, context) { const p = context.event.payload as { cardId?: CardId; cardName?: string }; if (context.event.sourceId !== ownerId || p.cardName !== '杀' || !p.cardId || !stateOf(host).wangshuangFloors?.[p.cardId]) return; host.state.turnUsage.slashUses = Math.max(0, host.state.turnUsage.slashUses - 1); host.state.turnUsage.slashUsesThisTurn = Math.max(0, (host.state.turnUsage.slashUsesThisTurn ?? 1) - 1); } }],
  outgoingDamage(state, _ownerId, context) { if (!context.cardId) return null; const floor = (state as Batch26State).wangshuangFloors?.[context.cardId]?.[context.targetId]; return floor ? { amount: Math.max(context.amount, floor) } : null },
})
registerJudgmentContinuation(ZHUILIE_JUDGE, (host, judged, data) => { const d = data as { ownerId: PlayerId; targetId: PlayerId; cardId: CardId }; const card = host.state.cards[judged.id]; const owner = playerOf(host.state, d.ownerId); if (card?.equipmentSlot === 'weapon' || card?.equipmentSlot === 'offensiveHorse' || card?.equipmentSlot === 'defensiveHorse') { const state = stateOf(host); const floors = state.wangshuangFloors ??= {}; const targets = floors[d.cardId] ??= {}; targets[d.targetId] = playerOf(host.state, d.targetId)?.hp ?? 0 } else if (owner?.alive) loseHp(host as never, d.ownerId, 1, ZHUILIE) })

// 张燕【肃疾】【狼蹈】
const SUJI = 'suji'; const LANGDAO = 'langdao'; const LANGDAO_GROUP = 'langdao-group'
registerGroupDecision(LANGDAO_GROUP, (host, decision) => {
  const d = decision.data as { cardId: CardId; ownerId: PlayerId; targetId: PlayerId }
  const choices = Object.values(decision.responses).filter((choice): choice is string => Boolean(choice))
  const state = host.state as Batch26State; state.zhangyanLangdao ??= {}
  state.zhangyanLangdao[d.cardId] = { ownerId: d.ownerId, targetId: d.targetId, options: choices, kill: false }
  if (choices.includes('target')) {
    const resolution = host.state.cardResolution
    if (resolution?.kind === 'slash') {
      const occupied = new Set([resolution.targetId, ...resolution.remainingTargetIds])
      const candidateIds = host.state.players
        .filter((player) => player.alive && player.id !== resolution.sourceId && !occupied.has(player.id))
        .filter((player) => getDistance(host.state, resolution.sourceId, player.id) <= getAttackRange(host.state, resolution.sourceId))
        .map((player) => player.id)
      if (candidateIds.length) host.state.skillQueue.push({ skillId: LANGDAO, ownerId: d.ownerId, step: 'extra-target', data: { cardId: d.cardId, candidateIds } })
    }
  }
})
registerSkillRuntime({
  id: SUJI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) { const p = context.event.payload as { phase?: string; playerId?: PlayerId }; const target = p.playerId ? playerOf(host.state, p.playerId) : undefined; if (p.phase !== 'play' || !target?.alive || target.id === ownerId || target.hp >= target.maxHp) return; const blacks = target.zones.hand.filter((id) => host.state.cards[id]?.color === 'black'); if (!blacks.length) return; host.queueSkill({ skillId: SUJI, ownerId, step: 'ask', data: { targetId: target.id, cards: blacks } }) } }, { event: 'Damaged', handle(host, ownerId, context) { const p = context.event.payload as { cardId?: CardId; amount?: number }; const source = context.event.sourceId; const target = context.event.targetId; if (!source || source !== ownerId || !target || !p.cardId) return; const card = host.state.cards[p.cardId]; if (card?.sourceSkillId !== SUJI) return; const victim = playerOf(host.state, target); const give = victim?.zones.hand[0] ?? equipmentIds(host.state, target)[0]; if (give) gainOne(host, ownerId, give, locateOwnedCard(host.state, target, give) as never, SUJI) } }],
  startQueued(host, ownerId, prompt) { if (prompt.step !== 'ask') return; const d = prompt.data as { targetId: PlayerId; cards: CardId[] }; host.askSkill({ skillId: SUJI, ownerId, step: 'ask', data: d, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【肃疾】：是否将黑牌当【杀】对受伤角色使用？', timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }] }) }) },
  resume(host, ownerId, resolution, response) { if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'yes') return; const d = resolution.data as { targetId: PlayerId; cards: CardId[] }; const cardId = d.cards.find((id) => locateOwnedCard(host.state, d.targetId, id)); if (cardId && playerOf(host.state, d.targetId)?.alive && getDistance(host.state, ownerId, d.targetId) <= getAttackRange(host.state, ownerId)) host.beginVirtualSlash({ sourceId: ownerId, targetId: d.targetId, sourceSkillId: SUJI, cardId }) },
})
registerSkillRuntime({
  id: LANGDAO,
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const targetId = p.targetIds?.length === 1 ? p.targetIds[0] : undefined
      if (context.event.sourceId !== ownerId || p.cardName !== '杀' || !p.cardId || !targetId) return
      startGroupDecision(host, {
        id: `${LANGDAO}:${host.state.seq}`, tag: LANGDAO_GROUP, skillId: LANGDAO,
        playerIds: [ownerId, targetId], prompt: '【狼蹈】：双方同时秘密选择一项',
        options: [{ id: 'damage', label: '此杀伤害+1' }, { id: 'target', label: '此杀目标数+1' }, { id: 'unresponsive', label: '此杀不可被响应' }],
        defaultOptionId: 'damage', timeoutMs: 20_000, data: { cardId: p.cardId, ownerId, targetId },
      })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'extra-target') return
    const data = prompt.data as { cardId: CardId; candidateIds: PlayerId[] }
    host.askSkill({ skillId: LANGDAO, ownerId, step: 'extra-target', data: { cardId: data.cardId }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【狼蹈】：选择此【杀】的额外目标', timeoutMs: 20_000, optional: false, candidateIds: data.candidateIds, min: 1, max: 1 }) })
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'extra-target') return
    const extraId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const cardId = (resolution.data as { cardId: CardId }).cardId
    const cardResolution = host.state.cardResolution
    if (!extraId || cardResolution?.kind !== 'slash' || cardResolution.cardId !== cardId) return
    const occupied = new Set([cardResolution.targetId, ...cardResolution.remainingTargetIds])
    if (occupied.has(extraId) || !playerOf(host.state, extraId)?.alive || getDistance(host.state, cardResolution.sourceId, extraId) > getAttackRange(host.state, cardResolution.sourceId)) return
    cardResolution.remainingTargetIds.push(extraId)
  },
  outgoingDamage(state, ownerId, context) { if (!context.cardId) return null; const record = (state as Batch26State).zhangyanLangdao?.[context.cardId]; return record?.ownerId === ownerId && record.options.includes('damage') ? { amount: context.amount + 1 } : null },
  slashUndodgeable(state, ownerId, targetId, cardId) { const record = cardId ? stateOf({ state } as SkillHost).zhangyanLangdao?.[cardId] : undefined; return record?.ownerId === ownerId && record.targetId === targetId && record.options.includes('unresponsive') },
})

// 孙狼【铤险】【奔矢】
const TINGXIAN = 'tingxian'; const BENSHE = 'benshe'
registerSkillRuntime({
  id: BENSHE,
  onGameStart(host, ownerId) { const player = playerOf(host.state, ownerId); if (player) player.attackRangeBonus += 1 },
  modifySlashTargets(host, ownerId, targetIds, candidateIds) { const selected = new Set(targetIds); const range = getAttackRange(host.state, ownerId); for (const id of candidateIds) if (!selected.has(id) && getDistance(host.state, ownerId, id) <= range) selected.add(id); return [...selected] },
})
registerSkillRuntime({
  id: TINGXIAN,
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || p.cardName !== '杀' || !p.cardId || usedThisTurn(host.state, ownerId, TINGXIAN)) return
      const x = equipmentIds(host.state, ownerId).length + 1
      markUsedThisTurn(host.state, ownerId, TINGXIAN)
      drawCards(host.state, host.rng, ownerId, x, (name, data) => host.dispatch(name, data))
      host.askSkill({
        skillId: TINGXIAN, ownerId, step: 'cancel', data: { cardId: p.cardId, x, targetIds: p.targetIds ?? [] },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: `【铤险】：至多选择${x}名目标令此杀无效`, timeoutMs: 20_000, optional: true, candidateIds: p.targetIds ?? [], min: 0, max: Math.min(x, p.targetIds?.length ?? 0) }),
      })
    },
  }, { event: 'AfterCardUse', handle(host, _ownerId, context) { const cardId = (context.event.payload as { cardId?: CardId }).cardId; if (cardId) delete stateOf(host).sunlangInvalid?.[cardId] } }],
  cardEffectInvalid(state, ownerId, sourceId, cardName, _cardColor, targetId) { const records = stateOf({ state } as SkillHost).sunlangInvalid; if (sourceId !== ownerId || cardName !== '杀' || !records || !targetId) return false; return Object.values(records).some((targets) => targets.includes(targetId)) },
  resume(host, _ownerId, resolution, response) { if (resolution.step !== 'cancel') return; const d = resolution.data as { cardId: CardId }; const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []; (stateOf(host).sunlangInvalid ??= {})[d.cardId] = ids },
})

// 庞山民【才思】【擢吏】
const CAISI = 'caisi'; const ZHUOLI = 'zhuoli'
function randomNonBasic(host: SkillHost, source: 'draw' | 'discard'): CardId | null { const ids = (source === 'draw' ? host.state.zones.drawPile : host.state.zones.discardPile).filter((id) => host.state.cards[id] && host.state.cards[id].category !== 'basic'); return ids.length ? host.rng.pick(ids) : null }
registerSkillRuntime({
  id: CAISI,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) { const p = context.event.payload as { cardId?: CardId }; const source = context.event.sourceId; if (!p.cardId || source !== ownerId || host.state.cards[p.cardId]?.category !== 'basic') return; const state = stateOf(host); state.pangshanCaisi ??= {}; const record = state.pangshanCaisi[ownerId] ?? { turn: host.state.turnNumber, count: 0, disabled: false }; if (record.turn !== host.state.turnNumber) Object.assign(record, { turn: host.state.turnNumber, count: 0, disabled: false }); if (record.disabled || record.count > (playerOf(host.state, ownerId)?.maxHp ?? 0)) return; host.queueSkill({ skillId: CAISI, ownerId, step: 'ask', data: {} }) } }, { event: 'TurnEnd', handle(host, ownerId, context) { if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) { const state = stateOf(host); if (state.pangshanCaisi?.[ownerId]) state.pangshanCaisi[ownerId].count = 0; } } }],
  startQueued(host, ownerId, prompt) { if (prompt.step !== 'ask') return; host.askSkill({ skillId: CAISI, ownerId, step: 'ask', data: {}, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【才思】：获得一张非基本牌', timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }] }) }) },
  resume(host, ownerId, _resolution, response) { if ((response.payload as { optionId?: string }).optionId !== 'yes') return; const state = stateOf(host); const records = state.pangshanCaisi ??= {}; const record = records[ownerId] ?? { turn: host.state.turnNumber, count: 0, disabled: false }; record.count += 1; record.disabled = record.count > (playerOf(host.state, ownerId)?.maxHp ?? 0); if (record.disabled) return; records[ownerId] = record; const source = host.state.currentPlayerId === ownerId ? 'draw' : 'discard'; const id = randomNonBasic(host, source); if (!id) return; let gained = false; if (source === 'draw' && host.state.zones.drawPile.includes(id)) gained = gainOne(host, ownerId, id, { kind: 'drawPile' }, CAISI); else gained = gainOne(host, ownerId, id, { kind: 'discardPile' }, CAISI); if (gained) { armNextGainCardMultiplier(host.state, ownerId, 2); state.pangshanCaisi[ownerId].doubleNextGain = true } },
})
registerSkillRuntime({ id: ZHUOLI, triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) { if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return; const owner = playerOf(host.state, ownerId); if (!owner) return; const ledger = stateOf(host).pangshanTurnLedger?.[ownerId]; if (ledger && (ledger.uses > owner.hp || ledger.gains > owner.hp) && owner.maxHp < host.state.players.length) { owner.maxHp += 1; recover(host as never, ownerId, 1, ownerId) } } }, { event: 'CardUsed', handle(host, ownerId, context) { const state = stateOf(host); state.pangshanTurnLedger ??= {}; const record = state.pangshanTurnLedger[ownerId] ?? { turn: host.state.turnNumber, uses: 0, gains: 0 }; if (record.turn !== host.state.turnNumber) Object.assign(record, { turn: host.state.turnNumber, uses: 0, gains: 0 }); if (context.event.sourceId === ownerId) record.uses += 1; state.pangshanTurnLedger[ownerId] = record } }, { event: 'GainCard', handle(host, ownerId, context) { const p = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }; if (p.playerId !== ownerId) return; const state = stateOf(host); state.pangshanTurnLedger ??= {}; const record = state.pangshanTurnLedger[ownerId] ?? { turn: host.state.turnNumber, uses: 0, gains: 0 }; record.gains += p.cardIds?.length ?? 0; state.pangshanTurnLedger[ownerId] = record } }] })

// 周宣【寤寐】【占梦】
const WUMEI = 'wumei'; const ZHANMENG = 'zhanmeng'
 registerSkillRuntime({ id: WUMEI, activeActions(state, ownerId) { return state.phase === 'prepare' && state.currentPlayerId !== ownerId && !usedThisPhase(state, ownerId, WUMEI) ? [{ id: WUMEI, label: '寤寐：令一名角色执行额外回合' }] : [] }, invokeActive(host, ownerId) { markUsedThisPhase(host.state, ownerId, WUMEI); host.askSkill({ skillId: WUMEI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【寤寐】：选择一名角色执行额外回合', timeoutMs: 20_000, optional: false, candidateIds: others(host.state, ownerId).map((p) => p.id), min: 1, max: 1 }) }) }, resume(host, ownerId, _resolution, response) { const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]; if (!targetId) return; stateOf(host).zhouxuanPendingDream = { ownerId, targetId }; queueExtraTurn(host.state, targetId, { skillId: WUMEI, playerId: ownerId }) }, triggers: [{ event: 'TurnStart', handle(host, _ownerId, context) { const pending = stateOf(host).zhouxuanPendingDream; const p = context.event.payload as { playerId?: PlayerId; kind?: string; turnNumber?: number }; if (!pending || p.kind !== 'extra' || p.playerId !== pending.targetId) return; const hp: Record<PlayerId, number> = {}; for (const player of host.state.players.filter((candidate) => candidate.alive)) hp[player.id] = player.hp; stateOf(host).zhouxuanSnapshot = { ownerId: pending.ownerId, turn: p.turnNumber ?? host.state.turnNumber, hp }; delete stateOf(host).zhouxuanPendingDream } }, { event: 'TurnEnd', handle(host, _ownerId, context) { const snapshot = stateOf(host).zhouxuanSnapshot; if (!snapshot || (context.event.payload as { turnNumber?: number }).turnNumber !== snapshot.turn) return; for (const [id, hp] of Object.entries(snapshot.hp)) { const player = playerOf(host.state, id); if (player?.alive) player.hp = Math.min(player.maxHp, hp) } delete stateOf(host).zhouxuanSnapshot } }] })
 registerSkillRuntime({ id: ZHANMENG, triggers: [{ event: 'CardUsed', handle(host, ownerId, context) { const state = stateOf(host); const p = context.event.payload as { cardName?: string }; if (!p.cardName) return; const watch = state.zhouxuanWatch; if (watch?.turn === host.state.turnNumber && watch.name === p.cardName) { const id = randomCardId(host, (cardId) => !isDamageCard(host.state, cardId)); if (id) gainDrawnCard(host, ownerId, id, ZHANMENG); delete state.zhouxuanWatch } state.zhouxuanUsed ??= {}; const used = state.zhouxuanUsed[ownerId] ?? { round: host.state.turnNumber, names: [] }; if (used.round !== host.state.turnNumber) { used.round = host.state.turnNumber; used.names = [] } if (used.names.includes(p.cardName)) return; host.queueSkill({ skillId: ZHANMENG, ownerId, step: 'choose', data: { cardName: p.cardName } }) } }, { event: 'TurnEnd', handle(host, _ownerId, context) { const watch = stateOf(host).zhouxuanWatch; if (watch && watch.turn === (context.event.payload as { turnNumber?: number }).turnNumber) delete stateOf(host).zhouxuanWatch; } }], startQueued(host, ownerId, prompt) { if (prompt.step === 'fire') { const targetId = (prompt.data as { targetId: PlayerId }).targetId; const target = playerOf(host.state, targetId); if (!target || target.zones.hand.length < 2) return; host.askSkill({ skillId: ZHANMENG, ownerId, step: 'fire', data: { targetId }, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId, prompt: '【占梦】：选择弃置两张牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 2, max: 2 }) }); return } if (prompt.step !== 'choose') return; const cardName = (prompt.data as { cardName: string }).cardName; const state = stateOf(host); const used = state.zhouxuanUsed?.[ownerId]; const options = [{ id: 'previous', label: '占梦：上一回合未出现同名牌则获得非伤害牌' }, { id: 'watch', label: '占梦：记录下一回合同名牌' }, ...others(host.state, ownerId).filter((p) => p.zones.hand.length >= 2).map((p) => ({ id: `fire:${p.id}`, label: `占梦：弃置${p.nickname}两张牌` }))].filter((option) => !used?.names.includes(option.id) && (option.id !== 'previous' || !host.state.cardUseHistory?.some((entry) => entry.turnNumber === host.state.turnNumber - 1 && entry.cardName === cardName))); if (!options.length) return; host.askSkill({ skillId: ZHANMENG, ownerId, step: 'choose', data: { cardName, options: options.map((option) => option.id) }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: `【占梦】：为本次【${cardName}】选择一项`, timeoutMs: 20_000, optional: true, options }) }) }, resume(host, ownerId, resolution, response) { if (resolution.step === 'fire') { const targetId = (resolution.data as { targetId: PlayerId }).targetId; const target = playerOf(host.state, targetId); const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []; if (!target || ids.length !== 2 || !ids.every((id) => target.zones.hand.includes(id))) return; const discarded = discardOwned(host, targetId, ids, ZHANMENG); const sum = discarded.reduce((total, id) => total + (host.state.cards[id]?.rank ?? 0), 0); if (sum > 10) (host as never as { damage: (options: Record<string, unknown>) => void }).damage({ sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardId: null, cardName: '占梦' }); return } if (resolution.step !== 'choose') return; const data = resolution.data as { cardName: string; options: string[] }; const optionId = (response.payload as { optionId?: string }).optionId; if (!optionId || !data.options.includes(optionId)) return; const state = stateOf(host); state.zhouxuanUsed ??= {}; const used = state.zhouxuanUsed[ownerId] ?? { round: host.state.turnNumber, names: [] }; used.names.push(optionId); state.zhouxuanUsed[ownerId] = used; if (optionId === 'previous') { const id = randomCardId(host, (cardId) => !isDamageCard(host.state, cardId)); if (id) gainDrawnCard(host, ownerId, id, ZHANMENG) } else if (optionId === 'watch') state.zhouxuanWatch = { turn: host.state.turnNumber + 1, name: data.cardName }; else if (optionId.startsWith('fire:')) { const targetId = optionId.slice(6); state.zhouxuanFire = { ownerId, targetId }; if (playerOf(host.state, targetId)) host.queueSkill({ skillId: ZHANMENG, ownerId, step: 'fire', data: { targetId } }) } }, })

// 冯妤【涕泣】【宝梳】
const TIQI = 'tiqi'; const BAOSHU = 'baoshu'
 registerSkillRuntime({ id: TIQI, maxCardsBonus(state, ownerId) { const target = playerOf(state, ownerId); return target?.marks.tiqiMaxCardsTurn === state.turnNumber ? target.marks.tiqiMaxCards ?? 0 : 0 }, triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) { const p = context.event.payload as { playerId?: PlayerId; count?: number }; if (!p.playerId || p.playerId === ownerId) return; const state = stateOf(host); state.fengyuDraw ??= {}; state.fengyuDraw[p.playerId] = { turn: host.state.turnNumber, count: p.count ?? 0 }; const delta = Math.abs((p.count ?? 0) - 2); if (!delta) return; host.queueSkill({ skillId: TIQI, ownerId, step: 'target', data: { targetId: p.playerId, delta } }) } }], startQueued(host, ownerId, prompt) { const d = prompt.data as { targetId: PlayerId; delta: number }; host.askSkill({ skillId: TIQI, ownerId, step: 'target', data: d, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: `【涕泣】：令目标本回合手牌上限增加或减少${d.delta}`, timeoutMs: 20_000, optional: true, options: [{ id: 'plus', label: '增加' }, { id: 'minus', label: '减少' }, { id: 'none', label: '不修改' }] }) }) }, resume(host, _ownerId, resolution, response) { const d = resolution.data as { targetId: PlayerId; delta: number }; const mode = (response.payload as { optionId?: string }).optionId; const target = playerOf(host.state, d.targetId); if (target && mode === 'plus') { target.marks.tiqiMaxCards = d.delta; target.marks.tiqiMaxCardsTurn = host.state.turnNumber } if (target && mode === 'minus') { target.marks.tiqiMaxCards = -d.delta; target.marks.tiqiMaxCardsTurn = host.state.turnNumber } if (target && mode === 'none') delete target.marks.tiqiMaxCards } })
  registerSkillRuntime({ id: BAOSHU, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) { const p = context.event.payload as { phase?: string; playerId?: PlayerId }; if (p.phase === 'draw') { const target = playerOf(host.state, p.playerId ?? ''); const bonus = target?.marks.baoshu ?? 0; if (target && bonus > 0) { restoreCharacter(host as never, target.id, BAOSHU); const payload = context.event.payload as { count?: number }; payload.count = Math.max(0, Math.trunc(Number(payload.count ?? 2))) + bonus; delete target.marks.baoshu } return } if (p.phase !== 'prepare' || p.playerId !== ownerId || usedThisTurn(host.state, ownerId, BAOSHU)) return; markUsedThisTurn(host.state, ownerId, BAOSHU); const x = playerOf(host.state, ownerId)?.maxHp ?? 0; host.askSkill({ skillId: BAOSHU, ownerId, step: 'target', data: { x }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【宝梳】：选择角色获得“梳”', timeoutMs: 20_000, optional: true, candidateIds: host.state.players.filter((p) => p.alive).map((p) => p.id), min: 0, max: Math.min(x, host.state.players.filter((p) => p.alive).length) }) }) } }], resume(host, _ownerId, resolution, response) { if (resolution.step !== 'target') return; const x = resolution.data.x as number; const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []; const each = ids.length ? 1 + (x - ids.length) : 0; for (const id of ids) { const target = playerOf(host.state, id); if (target) { restoreCharacter(host as never, target.id, BAOSHU); target.marks.baoshu = each } } } })

// 胡昭【弥笃】【贤望】，以及临时【活墨】
const MIDU = 'midu'; const XIANWANG = 'xianwang'; const HUOMO = 'huzhao-huomo'
registerSkillRuntime({ id: XIANWANG, distanceModifier: { fromOthers: (state, ownerId) => { const n = abolishedSlotsOf(state, ownerId).length; return n >= 3 ? 2 : n >= 1 ? 1 : 0 }, toOthers: (state, ownerId) => { const n = abolishedSlotsOf(state, ownerId).length; return n >= 3 ? -2 : n >= 1 ? -1 : 0 } } })
registerSkillRuntime({ id: HUOMO, viewAs(state, ownerId) { const owner = playerOf(state, ownerId); if (!owner || state.phase !== 'play') return []; return owner.zones.hand.filter((id) => state.cards[id]?.color === 'black' && state.cards[id]?.category !== 'basic').map((cardId) => ({ asCardName: '桃', cardId, label: '活墨：当【桃】使用' })) }, triggers: [{ event: 'TurnStart', handle(host, ownerId) { const expiry = stateOf(host).huzhaoHuomo?.[ownerId]; if (expiry && host.state.turnNumber >= expiry) { replaceTemporarySkill(host.state, ownerId, `${MIDU}:${ownerId}`, null); delete stateOf(host).huzhaoHuomo?.[ownerId] } } }] })
function askMiduDraw(host: SkillHost, ownerId: PlayerId, count: number): void { const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id); if (!candidates.length || count <= 0) return; host.askSkill({ skillId: MIDU, ownerId, step: 'draw-target', data: { count }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: `【弥笃】：选择一名角色摸${count}张牌`, timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1 }) }) }
registerSkillRuntime({ id: MIDU, activeActions(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, MIDU) ? [{ id: MIDU, label: '弥笃：废除或恢复装备栏/判定区' }] : [] }, invokeActive(host, ownerId) { markUsedThisPhase(host.state, ownerId, MIDU); const available: Array<EquipmentSlot | 'judgingArea'> = [...abolishableSlotsOf(host.state, ownerId), ...(isJudgmentAreaAbolished(host.state, ownerId) ? [] : ['judgingArea' as const])]; const abolished: Array<EquipmentSlot | 'judgingArea'> = [...abolishedSlotsOf(host.state, ownerId), ...(isJudgmentAreaAbolished(host.state, ownerId) ? ['judgingArea' as const] : [])]; host.askSkill({ skillId: MIDU, ownerId, step: 'mode', data: { available, abolished }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【弥笃】：选择废除或恢复', timeoutMs: 20_000, optional: false, options: [...(available.length ? [{ id: 'abolish', label: '废除区域（可多选）' }] : []), ...(abolished.length ? [{ id: 'restore', label: '恢复一个区域' }] : [])] }) }) }, resume(host, ownerId, resolution, response) { const payload = response.payload as { optionId?: string; optionIds?: string[]; targetIds?: PlayerId[] }; if (resolution.step === 'mode') { const d = resolution.data as { available: Array<EquipmentSlot | 'judgingArea'>; abolished: Array<EquipmentSlot | 'judgingArea'> }; const mode = payload.optionId; if (mode === 'abolish' && d.available.length) host.askSkill({ skillId: MIDU, ownerId, step: 'areas', data: { mode, options: d.available }, build: (id): ChooseOptionsRequest => ({ id, kind: 'choose-options', playerId: ownerId, prompt: '【弥笃】：选择要同时废除的区域', timeoutMs: 20_000, optional: false, options: d.available.map((area) => ({ id: area, label: area === 'judgingArea' ? '判定区' : area })), min: 1, max: d.available.length }) }); else if (mode === 'restore' && d.abolished.length) host.askSkill({ skillId: MIDU, ownerId, step: 'areas', data: { mode, options: d.abolished }, build: (id): ChooseOptionsRequest => ({ id, kind: 'choose-options', playerId: ownerId, prompt: '【弥笃】：选择要恢复的一个区域', timeoutMs: 20_000, optional: false, options: d.abolished.map((area) => ({ id: area, label: area === 'judgingArea' ? '判定区' : area })), min: 1, max: 1 }) }); return } if (resolution.step === 'areas') { const d = resolution.data as { mode: string; options: Array<EquipmentSlot | 'judgingArea'> }; const selected = (payload.optionIds ?? []).filter((area): area is EquipmentSlot | 'judgingArea' => d.options.includes(area as EquipmentSlot | 'judgingArea')); if (d.mode === 'abolish') { let count = 0; for (const area of selected) { if (area === 'judgingArea') { if (!abolishJudgmentArea(host.state, ownerId)) continue; const state = stateOf(host); state.huzhaoJudgingAbolished ??= {}; state.huzhaoJudgingAbolished[ownerId] = true; for (const cardId of [...(playerOf(host.state, ownerId)?.zones.judgingArea ?? [])]) moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' }); count += 1 } else if (abolishSlot(host.state, ownerId, area)) count += 1 } if (count) askMiduDraw(host, ownerId, count) } else { const area = selected[0]; const restored = area === 'judgingArea' ? restoreJudgmentArea(host.state, ownerId) : restoreSlot(host.state, ownerId, area); if (restored) { if (area === 'judgingArea') delete stateOf(host).huzhaoJudgingAbolished?.[ownerId]; replaceTemporarySkill(host.state, ownerId, `${MIDU}:${ownerId}`, HUOMO); const state = stateOf(host); state.huzhaoHuomo ??= {}; state.huzhaoHuomo[ownerId] = host.state.turnNumber + 1 } } return } if (resolution.step === 'draw-target') { const targetId = (payload.targetIds ?? [])[0]; const count = (resolution.data as { count: number }).count; if (targetId && playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, count, (name, data) => host.dispatch(name, data)) } } })

// 弥笃的恢复分支沿用同一运行时的第二步续接。

// 傅干【巧谏】【析察】
const QIAOJIAN = 'qiaojian'; const XICHA = 'xicha'
 registerSkillRuntime({ id: QIAOJIAN, handLimitExempt(state, ownerId, cardId) { return stateOf({ state } as SkillHost).fuganIgnored?.[ownerId]?.includes(cardId) ?? false }, prohibitsCardUse(state, ownerId, context) { const effect = Object.values(stateOf({ state } as SkillHost).fuganQiaojian ?? {}).find((record) => record.ownerId === ownerId && record.targetId === context.userId && record.turn === state.turnNumber); return Boolean(effect?.ban && (context.cardName === '杀' || DAMAGE_TRICKS.has(context.cardName))) }, prohibitsOwnResponse(state, ownerId, cardName) { const effect = Object.values(stateOf({ state } as SkillHost).fuganQiaojian ?? {}).find((record) => record.ownerId === ownerId && record.targetId === ownerId && record.turn === state.turnNumber); return Boolean(effect?.ban && (cardName === '杀' || DAMAGE_TRICKS.has(cardName))) }, prohibitsCardResponse(state, ownerId, responderId, cardName) { const effect = Object.values(stateOf({ state } as SkillHost).fuganQiaojian ?? {}).find((record) => record.ownerId === ownerId && record.targetId === responderId && record.turn === state.turnNumber); return Boolean(effect?.ban && (cardName === '杀' || DAMAGE_TRICKS.has(cardName))) }, triggers: [{ event: 'CardUsed', handle(host, ownerId, context) { const sourceId = context.event.sourceId; const p = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }; if (!sourceId || !p.cardName) return; const effect = Object.values(stateOf(host).fuganQiaojian ?? {}).find((record) => record.ownerId === ownerId && record.targetId === sourceId && record.turn === host.state.turnNumber); if (!effect || (p.cardName !== '杀' && !DAMAGE_TRICKS.has(p.cardName))) return; if ((p.cardName === '杀' && !effect.slash) || (DAMAGE_TRICKS.has(p.cardName) && !effect.trick)) return; const pendingRepeats = stateOf(host).fuganPendingRepeat ??= {}; pendingRepeats[ownerId] = { targetId: sourceId, cardName: p.cardName, targetIds: p.targetIds ?? [] }; if (p.cardName === '杀') effect.slash = false; if (DAMAGE_TRICKS.has(p.cardName)) effect.trick = false } }, { event: 'CardResolved', handle(host, ownerId) { const pending = stateOf(host).fuganPendingRepeat?.[ownerId]; if (!pending) return; delete stateOf(host).fuganPendingRepeat?.[ownerId]; repeatCardUse(host, pending.targetId, pending.cardName, pending.targetIds, QIAOJIAN) } }], activeActions(state, ownerId) { const used = stateOf({ state } as SkillHost).fuganUsed?.[ownerId] ?? {}; const hasUnusedTarget = others(state, ownerId).some((candidate) => used[candidate.id] !== state.turnNumber); return state.phase === 'play' && state.currentPlayerId === ownerId && hasUnusedTarget ? [{ id: QIAOJIAN, label: '巧谏：与一名角色同时弃牌' }] : [] }, invokeActive(host, ownerId) { host.askSkill({ skillId: QIAOJIAN, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【巧谏】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds: others(host.state, ownerId).filter((candidate) => (stateOf(host).fuganUsed?.[ownerId]?.[candidate.id] ?? -1) !== host.state.turnNumber).map((p) => p.id), min: 1, max: 1 }) }) }, startQueued(host, ownerId, prompt) { if (prompt.step !== 'effect') return; const targetId = (prompt.data as { targetId: PlayerId }).targetId; host.askSkill({ skillId: QIAOJIAN, ownerId, step: 'effect', data: { targetId }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: '【巧谏】：选择下个回合效果', timeoutMs: 20_000, optional: false, options: [{ id: 'slash', label: '下回合首次【杀】额外结算' }, { id: 'trick', label: '下回合首次伤害锦囊额外结算' }, { id: 'ban', label: '下回合不能使用伤害牌' }] }) }) }, resume(host, ownerId, resolution, response) { if (resolution.step === 'target') { const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]; if (!targetId) return; const owner = playerOf(host.state, ownerId); const target = playerOf(host.state, targetId); startGroupCardDecision(host, { id: `${QIAOJIAN}:${host.state.seq}`, tag: `${QIAOJIAN}-cards`, skillId: QIAOJIAN, playerIds: [ownerId, targetId], prompt: '【巧谏】：同时秘密选择要弃置的牌', cardIdsFor: (playerId) => [...(playerOf(host.state, playerId)?.zones.hand ?? [])], min: 0, max: Math.max(owner?.zones.hand.length ?? 0, target?.zones.hand.length ?? 0), timeoutMs: 20_000, data: { ownerId, targetId } }); } else if (resolution.step === 'effect') { const targetId = (resolution.data as { targetId: PlayerId }).targetId; const mode = (response.payload as { optionId?: 'slash' | 'trick' | 'ban' }).optionId; if (!mode) return; const state = stateOf(host); state.fuganQiaojian ??= {}; const prior = state.fuganQiaojian[targetId]; state.fuganQiaojian[targetId] = { ownerId, targetId, turn: host.state.turnNumber + 1, slash: prior?.slash ?? mode === 'slash', trick: prior?.trick ?? mode === 'trick', ban: prior?.ban ?? mode === 'ban' } } } })
 registerGroupCardDecision(`${QIAOJIAN}-cards`, (groupHost, decision) => { const host = groupHost as SkillHost; const d = decision.data as { ownerId: PlayerId; targetId: PlayerId }; const owner = playerOf(host.state, d.ownerId); const target = playerOf(host.state, d.targetId); if (!owner || !target) return; const ownerIds = (decision.responses[d.ownerId] ?? []).filter((id) => owner.zones.hand.includes(id)); const targetIds = (decision.responses[d.targetId] ?? []).filter((id) => target.zones.hand.includes(id)); const ownerDiscarded = discardOwned(host, d.ownerId, ownerIds, QIAOJIAN); const targetDiscarded = discardOwned(host, d.targetId, targetIds, QIAOJIAN); const ownerSum = ownerDiscarded.reduce((sum, id) => sum + (host.state.cards[id]?.rank ?? 0), 0); const targetSum = targetDiscarded.reduce((sum, id) => sum + (host.state.cards[id]?.rank ?? 0), 0); const state = stateOf(host); state.fuganUsed ??= {}; state.fuganUsed[d.ownerId] ??= {}; state.fuganUsed[d.ownerId][d.targetId] = host.state.turnNumber; if (ownerDiscarded.length && ownerSum > targetSum) { recover(host as never, d.ownerId, 1, d.ownerId); host.state.skillQueue.push({ skillId: QIAOJIAN, ownerId: d.ownerId, step: 'effect', data: { targetId: d.targetId } }) } else if (ownerSum <= targetSum) { for (const id of [...ownerDiscarded, ...targetDiscarded]) if (host.state.zones.discardPile.includes(id) && gainOne(host, d.ownerId, id, { kind: 'discardPile' }, QIAOJIAN)) { state.fuganIgnored ??= {}; state.fuganIgnored[d.ownerId] = [...(state.fuganIgnored[d.ownerId] ?? []), id] } } })
registerSkillRuntime({ id: XICHA, triggers: [{ event: 'Damaged', handle(host, ownerId, context) { const sourceId = context.event.sourceId; const target = sourceId ? playerOf(host.state, sourceId) : undefined; if (!sourceId || sourceId === ownerId || !target || target.zones.hand.length < 2) return; host.queueSkill({ skillId: XICHA, ownerId, step: 'watch', data: { targetId: sourceId } }) } }, { event: 'BeforeCardUse', handle(host, ownerId, context) { const state = stateOf(host); const watch = state.fuganXicha?.[ownerId]; const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }; if (!watch || context.event.sourceId !== watch.targetId) return; const usedIds = p.cardIds ?? (p.cardId ? [p.cardId] : []); const hit = usedIds.some((id) => watch.cards.includes(id)); delete state.fuganXicha?.[ownerId]; if (!hit) return; context.cancel(); const captures = state.fuganXichaCapture ??= {}; captures[ownerId] = { targetId: watch.targetId, cards: watch.cards } } }, { event: 'CardResolved', handle(host, ownerId) { const pending = stateOf(host).fuganXichaCapture?.[ownerId]; if (!pending) return; const ids = pending.cards.filter((id) => host.state.zones.discardPile.includes(id)); delete stateOf(host).fuganXichaCapture?.[ownerId]; for (const id of ids) if (gainOne(host, ownerId, id, { kind: 'discardPile' }, XICHA)) { const state = stateOf(host); state.fuganIgnored ??= {}; state.fuganIgnored[ownerId] = [...(state.fuganIgnored[ownerId] ?? []), id] } } }], startQueued(host, ownerId, prompt) { const targetId = (prompt.data as { targetId: PlayerId }).targetId; const target = playerOf(host.state, targetId); if (!target) return; promptCards(host, XICHA, ownerId, 'watch', target.zones.hand, '【析察】：秘密选择两张牌', 2, 2, { targetId }) }, resume(host, ownerId, resolution, response) { if (resolution.step !== 'watch') return; const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []; const records = stateOf(host).fuganXicha ??= {}; records[ownerId] = { targetId: (resolution.data as { targetId: PlayerId }).targetId, cards: ids } } })

// 苏飞【数荐】
const SHUJIAN = 'shujian'
 registerSkillRuntime({ id: SHUJIAN, activeActions(state, ownerId) { const r = stateOf({ state } as SkillHost).sufeiCount?.[ownerId]; if (state.phase !== 'play' || state.currentPlayerId !== ownerId || r?.disabled || (r?.turn === state.turnNumber && r.count >= 3)) return []; return others(state, ownerId).some((p) => p.alive) && ownedIds(state, ownerId).length ? [{ id: SHUJIAN, label: '数荐：给一名角色一张牌' }] : [] }, invokeActive(host, ownerId) { const r = stateOf(host).sufeiCount?.[ownerId]; const count = r?.turn === host.state.turnNumber ? r.count : 0; host.askSkill({ skillId: SHUJIAN, ownerId, step: 'target', data: { n: 3 - count }, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: `【数荐】：选择一名角色（本次摸${3 - count}张）`, timeoutMs: 20_000, optional: false, candidateIds: others(host.state, ownerId).map((p) => p.id), min: 1, max: 1 }) }) }, resume(host, ownerId, resolution, response) { if (resolution.step === 'discard') { const targetId = (resolution.data as { targetId: PlayerId }).targetId; const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []; discardOwned(host, targetId, ids, SHUJIAN); return } if (resolution.step === 'target') { const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]; const id = ownedIds(host.state, ownerId)[0]; const n = (resolution.data as { n: number }).n; if (targetId && id) { const source = locateOwnedCard(host.state, ownerId, id); if (source) gainOne(host, targetId, id, source, SHUJIAN); host.askSkill({ skillId: SHUJIAN, ownerId, step: 'mode', data: { targetId, n }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: targetId, prompt: '【数荐】：选择摸牌或依次使用过河拆桥', timeoutMs: 20_000, optional: false, options: [{ id: 'draw', label: '摸牌并弃牌' }, { id: 'dismantle', label: '依次使用过河拆桥' }] }) }) } } else if (resolution.step === 'mode') { const n = (resolution.data as { n: number }).n; const targetId = (resolution.data as { targetId: PlayerId }).targetId; const mode = (response.payload as { optionId?: string }).optionId; const state = stateOf(host); const counts = state.sufeiCount ??= {}; const current = counts[ownerId]; counts[ownerId] = { turn: host.state.turnNumber, count: (current?.turn === host.state.turnNumber ? current.count : 0) + 1, disabled: mode === 'dismantle' }; if (mode === 'draw') { drawCards(host.state, host.rng, targetId, n, (name, data) => host.dispatch(name, data)); const target = playerOf(host.state, targetId); const discardCount = Math.min(Math.max(0, n - 1), target?.zones.hand.length ?? 0); if (target && discardCount > 0) host.askSkill({ skillId: SHUJIAN, ownerId, step: 'discard', data: { targetId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【数荐】：弃置${discardCount}张牌`, timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: discardCount, max: discardCount }) }) } else if (mode === 'dismantle') { for (let index = 0; index < n; index += 1) { const virtualId = createVirtualTrick(host.state, targetId, '过河拆桥', SHUJIAN); const action = instantTrickActions(host.state, targetId, virtualId, '过河拆桥').find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length > 0); if (!action || action.kind !== 'use-card') { delete host.state.cards[virtualId]; const hand = playerOf(host.state, targetId)?.zones.hand; if (hand) hand.splice(hand.indexOf(virtualId), 1); break } executeUseCardAction(host as never, targetId, action) } } } } })

export const HISTORICAL_BATCH26_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'wangkuang', name: '王匡', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: RENXIA, name: '任侠', description: '出牌阶段限一次，选择摸牌或弃牌循环；本阶段结束时执行另一分支。' }] },
  { id: 'wangshuang', name: '王双', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: ZHUILIE, name: '追猎', description: '锁定技，你使用【杀】无距离限制；对攻击范围外目标进行判定，武器或坐骑使伤害至少等于其当前体力，否则你失去1点体力。' }] },
  { id: 'zhangyan', name: '张燕', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: SUJI, name: '肃疾', description: '受伤角色出牌阶段开始时，你可将黑牌当【杀】对其使用，造成伤害后获得其一张牌。' }, { id: LANGDAO, name: '狼蹈', description: '你对唯一目标使用【杀】时，可与其同时秘密选择令此杀伤害增加、目标数增加或不可响应。' }] },
  { id: 'sunlang', name: '孙狼', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: TINGXIAN, name: '铤险', description: '每回合使用【杀】指定目标后，按装备数加一摸牌并可令至多等量目标无效。' }, { id: BENSHE, name: '奔矢', description: '锁定技，攻击范围加一；使用【杀】须指定所有攻击范围内的合法角色。' }] },
  { id: 'pangshanmin', name: '庞山民', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: CAISI, name: '才思', description: '使用基本牌后可从牌堆或弃牌堆随机获得一张非基本牌。' }, { id: ZHUOLI, name: '擢吏', description: '锁定技，真实回合结束时，若本回合使用牌数或获得牌数大于体力值，增加体力上限并回复1点体力。' }] },
  { id: 'zhouxuan', name: '周宣', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: WUMEI, name: '寤寐', description: '每轮限一次，令一名角色执行一个额外回合，并在额外回合结束时恢复存活角色的体力快照。' }, { id: ZHANMENG, name: '占梦', description: '每次使用牌时记录本回合牌名选项，按上一真实回合的用牌历史获得非伤害牌。' }] },
  { id: 'fengyu', name: '冯妤', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: TIQI, name: '涕泣', description: '其他角色摸牌阶段开始前，按其实际摸牌数与2的差值摸牌并选择其本回合手牌上限变化。' }, { id: BAOSHU, name: '宝梳', description: '准备阶段选择角色令其获得“梳”，其摸牌阶段额外摸等量牌后移除。' }] },
  { id: 'huzhao', name: '胡昭', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: MIDU, name: '弥笃', description: '出牌阶段限一次，废除或恢复装备栏并在成功恢复时获得临时【活墨】。' }, { id: XIANWANG, name: '贤望', description: '锁定技，按废除装备栏数量改变与其他角色的距离；判定区不计入阈值。' }] },
  { id: 'fugan', name: '傅干', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [{ id: QIAOJIAN, name: '巧谏', description: '出牌阶段对每名其他角色限一次，与其同时秘密弃牌并比较数量，成功后施加下一真实回合效果。' }, { id: XICHA, name: '析察', description: '受到其他角色伤害后，可秘密查看并选择其两张手牌，目标下一次使用其中牌时整张牌无效。' }] },
  { id: 'sufei', name: '苏飞', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: SHUJIAN, name: '数荐', description: '出牌阶段最多三次，依次按3、2、1给其他角色一张牌，令其摸牌弃牌或依次使用等量【过河拆桥】；选择后本回合失效。' }] },
] as const
