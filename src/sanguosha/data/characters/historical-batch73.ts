import type { CardId, PlayerId, SanguoshaState, TurnPhase } from '../../engine/types'
import type { CharacterDefinition } from './types'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { discardCardsByIds } from '../../engine/discard-all'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { getDistance } from '../../engine/distance'
import { effectiveCardSuit, effectiveCardColor } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { restoreCharacter } from '../../engine/character-state'
import { queueExtraTurn } from '../../engine/turn'
import { startPindian, registerPindianContinuation } from '../../engine/pindian'
import { beginSkillCardUseFromProcessingAs, declaredCardActions, executeUseCardAction, withNextCardTargetChoices } from '../../engine/cards/basic'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { reshuffleDrawPile } from '../../engine/deck'

const B = '-b73'
const sid = (name: string) => `${name}${B}`
const WANGYUE_HUGUAN = sid('huguan-wangyue')
const WANGYUE_MINGLUAN = sid('mingluan-wangyue')
const ZHAOYAN_JINHUI = sid('jinhui-zhaoyan')
const ZHAOYAN_QINGMAN = sid('qingman-zhaoyan')
const ZHANGXUAN_TONGLI = sid('tongli-zhangxuan')
const ZHANGXUAN_SHEZANG = sid('shezang-zhangxuan')
const CHENJIAO_XIESHOU = sid('xieshou-chenjiao')
const CHENJIAO_QINGYAN = sid('qingyan-chenjiao')
const CHENJIAO_QIZI = sid('qizi-chenjiao')
const MIFANGFUSHIREN_FENGSHI = sid('fengshi-mifangfushiren')
const LICAIWEI_YIJIAO = sid('yijiao-licaiwei')
const LICAIWEI_QIBIE = sid('qibie-licaiwei')
const LICAIWEI_MARK = 'yi-licaiwei'
const WUFAN_TIANYUN = sid('tianyun-wufan')
const WUFAN_YUYAN = sid('yuyan-wufan')
const HAOMENG_XIONGMANG = sid('xiongmang-haomeng')
const WANGWEI_RUIZHAN = sid('ruizhan-wangwei')
const WANGWEI_SHILIE = sid('shilie-wangwei')
const MUSHUN_JINGJIAN = sid('jingjian-mushun')
const MUSHUN_SHIZHAO = sid('shizhao-mushun')

function tongliPhaseKey(state: SanguoshaState): string {
  return `${state.turnNumber}:${state.extraPhase?.instanceId ?? 'normal'}`
}

const JINHUI_DAMAGE_NAMES = new Set(['杀', '决斗', '南蛮入侵', '万箭齐发', '火攻', '闪电'])
function jinhuiTargetFor(state: SanguoshaState, actorId: PlayerId, counterpartId: PlayerId, cardId: CardId): PlayerId[] | null {
  const targets = jinhuiTargetIdsFor(state, actorId, counterpartId, cardId)
  return targets.length ? [targets[0]!] : null
}
function jinhuiTargetIdsFor(state: SanguoshaState, actorId: PlayerId, counterpartId: PlayerId, cardId: CardId): PlayerId[] {
  const card = state.cards[cardId]
  if (!card || card.category === 'equipment' || card.damageNature || JINHUI_DAMAGE_NAMES.has(card.name)) return []
  const actions = declaredCardActions(state, actorId, cardId, card.name, `【锦绘】使用【${card.name}】`, {
    sourceSkillId: ZHAOYAN_JINHUI, ignoreDistance: true, ignoreUsageLimits: true,
  }).filter((action): action is Extract<typeof action, { kind: 'use-card' }> => action.kind === 'use-card'
    && action.targetIds.length === 1 && !action.id.startsWith('play:recast:'))
  return [...new Set(actions.map((action) => action.targetIds[0]!)
    .filter((targetId) => targetId === actorId || targetId === counterpartId))]
}

function discardJinhuiCard(host: SkillHost, cardId: CardId): void {
  if (host.state.zones.processingArea.includes(cardId))
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
}

type B73State = SanguoshaState & { b73?: Record<string, any> }
const s73 = (state: SanguoshaState) => (state as B73State).b73 ??= {}
const player = (state: SanguoshaState, id: PlayerId) => state.players.find((p) => p.id === id)
const alive = (state: SanguoshaState) => state.players.filter((p) => p.alive)
function option(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId, prompt,
    timeoutMs: 25_000, optional, options }) })
}
function cards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId, cardIds: CardId[], min: number, max: number,
  prompt: string, data: Record<string, unknown> = {}, optional = true, hiddenCardSlots: string[] = []) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId, prompt,
    timeoutMs: 25_000, optional, purpose: 'skill', cardIds, hiddenCardSlots, min, max }) })
}
function targets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidateIds: PlayerId[], prompt: string,
  data: Record<string, unknown> = {}, optional = true, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId, prompt,
    timeoutMs: 25_000, optional, candidateIds, min: 1, max: 1 }) })
}

// 王悦【护关】与王桃同文同规则，但发动者状态按本人分开保存。
registerSkillRuntime({
  id: WANGYUE_HUGUAN,
  globalHandLimitExempt(state, ownerId, targetId, cardId) {
    const record = s73(state).huguan?.[`${ownerId}:${targetId}:${state.turnNumber}`]
    return Boolean(record && player(state, ownerId)?.alive && effectiveCardSuit(state, targetId, cardId) === record.suit)
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.phase === 'play' && p.playerId) (s73(host.state).huguanFirst ??= {})[`${ownerId}:${p.playerId}:${host.state.turnNumber}`] = true
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const actorId = context.event.sourceId
      if (!actorId || actorId === ownerId) return
      const key = `${ownerId}:${actorId}:${host.state.turnNumber}`
      if (!s73(host.state).huguanFirst?.[key]) return
      delete s73(host.state).huguanFirst[key]
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const ids = p.cardIds?.length ? p.cardIds : p.cardId ? [p.cardId] : []
      if (!ids.some((id) => effectiveCardColor(host.state, actorId, id) === 'red')) return
      host.queueSkill({ skillId: WANGYUE_HUGUAN, ownerId, step: 'suit', data: { actorId } })
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const turn = (context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber
      for (const key of Object.keys(s73(host.state).huguan ?? {})) if (Number(key.split(':').at(-1)) <= turn) delete s73(host.state).huguan[key]
      for (const key of Object.keys(s73(host.state).huguanFirst ?? {})) if (Number(key.split(':').at(-1)) <= turn) delete s73(host.state).huguanFirst[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'suit') return
    const actorId = prompt.data.actorId as PlayerId
    if (!player(host.state, actorId)?.alive) return
    option(host, WANGYUE_HUGUAN, ownerId, 'suit', ownerId, `【护关】：声明${player(host.state, actorId)?.nickname ?? '该角色'}本回合手牌上限豁免花色`,
      [{ id: 'spade', label: '♠️' }, { id: 'heart', label: '♥️' }, { id: 'club', label: '♣️' }, { id: 'diamond', label: '♦️' }], { actorId })
  },
  resume(host, ownerId, resolution, response) {
    const suit = (response.payload as { optionId?: string }).optionId
    const actorId = resolution.data.actorId as PlayerId
    if (resolution.step !== 'suit' || !['spade', 'heart', 'club', 'diamond'].includes(suit ?? '') || !player(host.state, actorId)?.alive) return
    (s73(host.state).huguan ??= {})[`${ownerId}:${actorId}:${host.state.turnNumber}`] = { suit }
  },
})

registerSkillRuntime({
  id: WANGYUE_MINGLUAN,
  triggers: [
    { event: 'Recover', handle(host) { s73(host.state).mingluanRecoveredTurn = host.state.turnNumber } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId === ownerId || p.phase !== 'finish' || s73(host.state).mingluanRecoveredTurn !== host.state.turnNumber
        || !player(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: WANGYUE_MINGLUAN, ownerId, step: 'offer', data: { turnPlayerId: p.playerId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const own = player(host.state, ownerId)
    const pickable = own ? pickableCardsOf(host.state, ownerId) : { cardIds: [], hiddenCardSlots: [] }
    if (!own || !(pickable.cardIds.length + pickable.hiddenCardSlots.length)) {
      option(host, WANGYUE_MINGLUAN, ownerId, 'resolve', ownerId, '【鸣鸾】：摸牌数不超过5且等于当前回合角色的手牌数（不能弃牌）',
        [{ id: 'keep', label: '不弃牌直接摸牌' }], prompt.data)
      return
    }
    option(host, WANGYUE_MINGLUAN, ownerId, 'discard-offer', ownerId, '【鸣鸾】：是否弃置任意张牌后摸牌？',
      [{ id: 'yes', label: '弃置并摸牌' }, { id: 'no', label: '不发动' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer' || resolution.step === 'discard-offer') {
      if (resolution.step === 'discard-offer' && (response.payload as { optionId?: string }).optionId !== 'yes') return
      const own = player(host.state, ownerId)
      if (!own) return
      const pickable = pickableCardsOf(host.state, ownerId)
      host.askSkill({ skillId: WANGYUE_MINGLUAN, ownerId, step: 'discard', data: resolution.data, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【鸣鸾】：选择弃置任意张牌', timeoutMs: 25_000, optional: false,
        purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 0,
        max: pickable.cardIds.length + pickable.hiddenCardSlots.length,
      }) })
      return
    }
    if (resolution.step === 'resolve' && (response.payload as { optionId?: string }).optionId !== 'keep') return
    if (resolution.step !== 'discard' && resolution.step !== 'resolve') return
    const own = player(host.state, ownerId)
    if (!own?.alive) return
    if (resolution.step === 'discard') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = ids.filter((id) => locateOwnedCard(host.state, ownerId, id))
      if (valid.length) discardCardsByIds(host as never, ownerId, valid, WANGYUE_MINGLUAN)
    }
    const turnPlayer = player(host.state, resolution.data.turnPlayerId as PlayerId)
    const cap = Math.min(5, turnPlayer?.zones.hand.length ?? 0)
    const count = Math.max(0, cap)
    if (count) drawCards(host.state, host.rng, ownerId, count)
  },
})

registerSkillRuntime({
  id: ZHAOYAN_QINGMAN,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const currentId = (context.event.payload as { playerId?: PlayerId }).playerId ?? host.state.currentPlayerId
    const current = currentId ? player(host.state, currentId) : null
    const own = player(host.state, ownerId)
    if (!current || !own?.alive) return
    const empty = Object.values(current.zones.equipment).filter((cardId) => !cardId).length
    if (own.zones.hand.length < empty) drawCards(host.state, host.rng, ownerId, empty - own.zones.hand.length)
  } }],
})

registerSkillRuntime({
  id: ZHAOYAN_JINHUI,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && player(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, ZHAOYAN_JINHUI)
      && state.zones.drawPile.some((id) => state.cards[id]?.category !== 'equipment')
      ? [{ id: `skill:${ZHAOYAN_JINHUI}`, label: '发动【锦绘】' }] : []
  },
  invokeActive(host, ownerId) {
    if (!player(host.state, ownerId)?.alive || usedThisPhase(host.state, ownerId, ZHAOYAN_JINHUI)) return
    const pool = host.state.zones.drawPile.filter((id) => {
      const card = host.state.cards[id]
      return card && (card.category === 'basic' || card.category === 'trick')
        && !card.damageNature && !JINHUI_DAMAGE_NAMES.has(card.name)
    })
    const byName = new Map<string, CardId[]>()
    for (const id of pool) byName.set(host.state.cards[id]!.name, [...(byName.get(host.state.cards[id]!.name) ?? []), id])
    const candidates = host.rng.shuffle([...byName.values()].flatMap((ids) => ids.length ? [host.rng.pick(ids)] : [])).slice(0, 3)
    if (candidates.length !== 3) return
    for (const cardId of candidates) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    markUsedThisPhase(host.state, ownerId, ZHAOYAN_JINHUI)
    const targetIds = alive(host.state).filter((candidate) => candidate.id !== ownerId
      && candidates.some((cardId) => jinhuiTargetFor(host.state, candidate.id, ownerId, cardId) !== null)).map(({ id }) => id)
    if (!targetIds.length) {
      candidates.forEach((id) => discardJinhuiCard(host, id))
      return
    }
    targets(host, ZHAOYAN_JINHUI, ownerId, 'target', targetIds, '【锦绘】：选择一名其他角色', { cardIds: candidates }, false)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-card') {
      const targetId = prompt.data.targetId as PlayerId
      const cardIds = (prompt.data.cardIds as CardId[]).filter((id) => host.state.zones.processingArea.includes(id)
        && jinhuiTargetIdsFor(host.state, targetId, ownerId, id).length > 0)
      if (!cardIds.length) {
        (prompt.data.cardIds as CardId[]).forEach((id) => discardJinhuiCard(host, id))
        return
      }
      option(host, ZHAOYAN_JINHUI, ownerId, 'choose-card', targetId, '【锦绘】：选择并使用一张亮出的牌',
        cardIds.map((id) => ({ id, label: `使用【${host.state.cards[id]!.name}】` })), { ...prompt.data, cardIds }, false)
      return
    }
    if (prompt.step !== 'follow-up') return
    const pending = s73(host.state).jinhuiPending?.[ownerId] as { targetId: PlayerId; cardIds: CardId[]; nextIndex: number } | undefined
    if (!pending) return
    const cardId = pending.cardIds[pending.nextIndex]
    if (!cardId) {
      pending.cardIds.forEach((id) => discardJinhuiCard(host, id))
      delete s73(host.state).jinhuiPending[ownerId]
      return
    }
    if (!host.state.zones.processingArea.includes(cardId)) {
      pending.nextIndex += 1
      host.queueSkill({ skillId: ZHAOYAN_JINHUI, ownerId, step: 'follow-up', data: {} })
      return
    }
    const targetIds = jinhuiTargetIdsFor(host.state, ownerId, pending.targetId, cardId)
    if (!targetIds.length) {
      discardJinhuiCard(host, cardId)
      pending.nextIndex += 1
      host.queueSkill({ skillId: ZHAOYAN_JINHUI, ownerId, step: 'follow-up', data: {} })
      return
    }
    option(host, ZHAOYAN_JINHUI, ownerId, 'use-extra', ownerId,
      `【锦绘】：是否对${player(host.state, pending.targetId)?.nickname ?? '该角色'}使用剩余的【${host.state.cards[cardId]!.name}】？`,
      [{ id: 'yes', label: '使用' }, { id: 'no', label: '不使用' }], { cardId, targetIds }, true)
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceSkillId !== ZHAOYAN_JINHUI) return
    const pending = s73(host.state).jinhuiPending?.[ownerId]
    if (pending) host.queueSkill({ skillId: ZHAOYAN_JINHUI, ownerId, step: 'follow-up', data: {} })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardIds = resolution.data.cardIds as CardId[]
      if (!targetId || !player(host.state, targetId)?.alive) { cardIds.forEach((id) => discardJinhuiCard(host, id)); return }
      host.queueSkill({ skillId: ZHAOYAN_JINHUI, ownerId, step: 'choose-card', data: { targetId, cardIds } })
      return
    }
    if (resolution.step === 'choose-card') {
      const cardId = (response.payload as { optionId?: string }).optionId as CardId | undefined
      const targetId = resolution.data.targetId as PlayerId
      const cardIds = resolution.data.cardIds as CardId[]
      const useTargets = cardId ? jinhuiTargetIdsFor(host.state, targetId, ownerId, cardId) : []
      if (!cardId || !cardIds.includes(cardId) || !useTargets?.length) {
        cardIds.forEach((id) => discardJinhuiCard(host, id))
        return
      }
      const remaining = cardIds.filter((id) => id !== cardId)
      s73(host.state).jinhuiPending ??= {}
      s73(host.state).jinhuiPending[ownerId] = { targetId, cardIds: remaining, nextIndex: 0 }
      if (useTargets.length > 1) {
        targets(host, ZHAOYAN_JINHUI, ownerId, 'chosen-target', useTargets,
          '【锦绘】：为此牌选择目标（若选择其他角色，只能选择你与赵嫣中的另一方）',
          { targetId, cardId, cardIds }, false, targetId)
      } else if (!beginSkillCardUseFromProcessingAs(host as never, { playerId: targetId, cardId, targetIds: useTargets,
        sourceSkillId: ZHAOYAN_JINHUI, ignoreDistance: true, ignoreUsageLimits: true })) {
        cardIds.forEach((id) => discardJinhuiCard(host, id))
        delete s73(host.state).jinhuiPending[ownerId]
      }
      return
    }
    if (resolution.step === 'chosen-target') {
      const actorId = resolution.data.targetId as PlayerId
      const cardId = resolution.data.cardId as CardId
      const chosenTarget = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const allowed = jinhuiTargetIdsFor(host.state, actorId, ownerId, cardId)
      const cardIds = resolution.data.cardIds as CardId[]
      if (!chosenTarget || !allowed.includes(chosenTarget)
        || !beginSkillCardUseFromProcessingAs(host as never, { playerId: actorId, cardId, targetIds: [chosenTarget],
          sourceSkillId: ZHAOYAN_JINHUI, ignoreDistance: true, ignoreUsageLimits: true })) {
        cardIds.forEach((id) => discardJinhuiCard(host, id))
        delete s73(host.state).jinhuiPending?.[ownerId]
      }
      return
    }
    if (resolution.step !== 'use-extra' && resolution.step !== 'extra-target') return
    const pending = s73(host.state).jinhuiPending?.[ownerId] as { targetId: PlayerId; cardIds: CardId[]; nextIndex: number } | undefined
    if (!pending) return
    const cardId = resolution.data.cardId as CardId
    const useChosen = resolution.step === 'extra-target' || (response.payload as { optionId?: string }).optionId === 'yes'
    const chosenTarget = resolution.step === 'extra-target'
      ? (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      : undefined
    const allowedTargets = resolution.data.targetIds as PlayerId[]
    if (resolution.step === 'use-extra') pending.nextIndex += 1
    if (useChosen && allowedTargets.length > 1 && !chosenTarget) {
      targets(host, ZHAOYAN_JINHUI, ownerId, 'extra-target', allowedTargets,
        '【锦绘】：为此牌选择目标（若选择其他角色，只能选择目标角色）', { cardId, targetIds: allowedTargets }, false, ownerId)
      return
    }
    const targetId = chosenTarget ?? allowedTargets[0]
    const used = useChosen && Boolean(targetId) && beginSkillCardUseFromProcessingAs(host as never, { playerId: ownerId, cardId,
      targetIds: [targetId!], sourceSkillId: ZHAOYAN_JINHUI, ignoreDistance: true, ignoreUsageLimits: true })
    if (!used) discardJinhuiCard(host, cardId)
    if (!used) host.queueSkill({ skillId: ZHAOYAN_JINHUI, ownerId, step: 'follow-up', data: {} })
  },
})

registerSkillRuntime({
  id: ZHANGXUAN_TONGLI,
  repeatTargetEffectCount(state, _ownerId, targetId, cardId) {
    const entry = s73(state).tongliRepeats?.[cardId]
    return entry?.targetIds.includes(targetId) ? Number(entry.count) : 0
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
      const payload = context.event.payload as { cardIds?: CardId[]; cardId?: CardId }
      const count = payload.cardIds?.length || (payload.cardId ? 1 : 0)
      if (!count) return
      const key = `${ownerId}:${tongliPhaseKey(host.state)}`
      s73(host.state).tongliUsedCount ??= {}
      s73(host.state).tongliUsedCount[key] = Number(s73(host.state).tongliUsedCount[key] ?? 0) + count
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const cardId = payload.cardId
      const targetIds = [...new Set(payload.targetIds ?? [])].filter((id) => player(host.state, id)?.alive)
      if (!cardId || !targetIds.length) return
      const used = Number(s73(host.state).tongliUsedCount?.[`${ownerId}:${tongliPhaseKey(host.state)}`] ?? 0)
      const suits = new Set((player(host.state, ownerId)?.zones.hand ?? [])
        .map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean)).size
      if (!suits || suits !== used) return
      host.queueSkill({ skillId: ZHANGXUAN_TONGLI, ownerId, step: 'offer', data: { cardId, targetIds, count: suits } })
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      delete s73(host.state).tongliRepeats?.[cardId]
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (phase.playerId === ownerId && phase.phase === 'play')
        delete s73(host.state).tongliUsedCount?.[`${ownerId}:${tongliPhaseKey(host.state)}`]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    option(host, ZHANGXUAN_TONGLI, ownerId, 'offer', ownerId,
      `【同礼】：是否令此牌效果额外执行${Number(prompt.data.count)}次？`,
      [{ id: 'yes', label: '额外执行' }], prompt.data)
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'offer' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const cardId = resolution.data.cardId as CardId
    if (!host.state.cards[cardId] || !host.state.cardResolution
      || !['slash', 'trick'].includes(host.state.cardResolution.kind)) return
    s73(host.state).tongliRepeats ??= {}
    s73(host.state).tongliRepeats[cardId] = {
      targetIds: resolution.data.targetIds as PlayerId[], count: Number(resolution.data.count),
    }
  },
})

registerSkillRuntime({
  id: WUFAN_TIANYUN,
  onGameStart(host, ownerId) {
    const own = player(host.state, ownerId)
    if (!own?.alive) return
    const currentSuits = new Set(own.zones.hand.map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean))
    const missing = (['spade', 'heart', 'club', 'diamond'] as const).filter((suit) => !currentSuits.has(suit))
    const gained: CardId[] = []
    for (const suit of missing) {
      const choices = host.state.zones.drawPile.filter((id) => effectiveCardSuit(host.state, ownerId, id) === suit)
      const cardId = choices.length ? host.rng.pick(choices) : undefined
      if (cardId) {
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
        gained.push(cardId)
      }
    }
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: WUFAN_TIANYUN }, { targetId: ownerId, cardIds: gained })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      const current = playerId ? player(host.state, playerId) : null
      if (!current || current.seat + 1 !== host.state.roundNumber) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const count = new Set(owner.zones.hand.map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean)).size
      if (host.state.zones.drawPile.length < count) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
      const observed = host.state.zones.drawPile.slice(0, count)
      if (observed.length) host.queueSkill({ skillId: WUFAN_TIANYUN, ownerId, step: 'watch', data: { observed, count, turnPlayerId: playerId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'watch') return
    const observed = (prompt.data.observed as CardId[]).filter((id) => host.state.zones.drawPile.includes(id))
    if (!observed.length) return
    host.askSkill({ skillId: WUFAN_TIANYUN, ownerId, step: 'arrange', data: { ...prompt.data, observed }, build: (id): ArrangeCardsRequest => ({
      id, kind: 'arrange-cards', playerId: ownerId, prompt: `【天运】：观看牌堆顶${observed.length}张，以任意顺序置于牌堆顶或牌堆底`,
      timeoutMs: 30_000, optional: false, cardIds: observed, minTop: 0, maxTop: observed.length, allowBottom: true,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'arrange') {
      const observed = resolution.data.observed as CardId[]
      const { top, bottom } = response.payload as { top?: CardId[]; bottom?: CardId[] }
      const allowed = new Set(observed)
      if (!top || !bottom || top.length + bottom.length !== observed.length
        || [...top, ...bottom].some((id) => !allowed.has(id)) || new Set([...top, ...bottom]).size !== observed.length
        || observed.some((id, index) => host.state.zones.drawPile[index] !== id)) return
      host.state.zones.drawPile.splice(0, observed.length)
      host.state.zones.drawPile.unshift(...top)
      host.state.zones.drawPile.push(...bottom)
      if (!top.length) option(host, WUFAN_TIANYUN, ownerId, 'bottom-choice', ownerId,
        '【天运】：你将观看的牌全部置于牌堆底，是否令一名角色摸牌？', [{ id: 'yes', label: '令一名角色摸牌，然后你失去1点体力' }],
        { count: new Set((player(host.state, ownerId)?.zones.hand ?? []).map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean)).size })
      return
    }
    if (resolution.step === 'bottom-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const count = Number(resolution.data.count)
      if (!count) { loseHp(host as never, ownerId, 1, WUFAN_TIANYUN); return }
      targets(host, WUFAN_TIANYUN, ownerId, 'draw-target', alive(host.state).map((p) => p.id), '【天运】：选择一名角色摸牌', { count }, false)
      return
    }
    if (resolution.step === 'draw-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const count = Number(resolution.data.count)
      if (!targetId || !player(host.state, targetId)?.alive) return
      drawCards(host.state, host.rng, targetId, count)
      if (player(host.state, ownerId)?.alive) loseHp(host as never, ownerId, 1, WUFAN_TIANYUN)
    }
  },
})

const LIUZAN_FENYIN = 'fenyin-b36'
registerSkillRuntime({
  id: WUFAN_YUYAN,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const round = (context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber
      if (s73(host.state).yuyanRound !== round) {
        s73(host.state).yuyanRound = round
        s73(host.state).yuyanFirstDying = null
        s73(host.state).yuyanFirstDamage = null
      }
      if (player(host.state, ownerId)?.alive)
        targets(host, WUFAN_YUYAN, ownerId, 'select', alive(host.state).map((p) => p.id), '【预言】：选择一名角色', { round }, false)
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      const dyingId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!dyingId) return
      const round = host.state.roundNumber
      s73(host.state).yuyanFirstDying ??= {}
      const first = s73(host.state).yuyanFirstDying[String(round)] ??= dyingId
      const selected = s73(host.state).yuyanTarget?.[ownerId]
      if (first === selected?.targetId && selected.round === round && player(host.state, ownerId)?.alive)
        replaceTemporarySkill(host.state, ownerId, WUFAN_YUYAN, LIUZAN_FENYIN)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0 || !context.event.sourceId) return
      const round = host.state.roundNumber
      s73(host.state).yuyanFirstDamage ??= {}
      const first = s73(host.state).yuyanFirstDamage[String(round)] ??= context.event.sourceId
      const selected = s73(host.state).yuyanTarget?.[ownerId]
      if (first === selected?.targetId && selected.round === round && player(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, 2)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        replaceTemporarySkill(host.state, ownerId, WUFAN_YUYAN, null)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'select') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive) return
    s73(host.state).yuyanTarget ??= {}
    s73(host.state).yuyanTarget[ownerId] = { targetId, round: Number(resolution.data.round) }
  },
})

registerSkillRuntime({
  id: ZHANGXUAN_SHEZANG,
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    const dyingId = (context.event.payload as { playerId?: PlayerId }).playerId
    const owner = player(host.state, ownerId)
    const key = `${ownerId}:${host.state.roundNumber}`
    if (!owner?.alive || !dyingId || (dyingId !== ownerId && host.state.currentPlayerId !== ownerId)
      || s73(host.state).shezangUsed?.[key]) return
    const availableSuits = new Set(host.state.zones.drawPile.map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean))
    if (!availableSuits.size) return
    host.queueSkill({ skillId: ZHANGXUAN_SHEZANG, ownerId, step: 'offer', data: { key } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') option(host, ZHANGXUAN_SHEZANG, ownerId, 'offer', ownerId, '【奢葬】：是否从牌堆获得不同花色的牌各一张？',
      [{ id: 'yes', label: '获得不同花色的牌' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'offer' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const key = resolution.data.key as string
    if (s73(host.state).shezangUsed?.[key]) return
    const suits = ['spade', 'heart', 'club', 'diamond'] as const
    const gained: CardId[] = []
    for (const suit of suits) {
      const id = host.state.zones.drawPile.find((cardId) => effectiveCardSuit(host.state, ownerId, cardId) === suit)
      if (!id) continue
      moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      gained.push(id)
    }
    s73(host.state).shezangUsed ??= {}
    s73(host.state).shezangUsed[key] = true
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: ZHANGXUAN_SHEZANG }, { targetId: ownerId, cardIds: gained })
  },
})

registerSkillRuntime({
  id: CHENJIAO_XIESHOU,
  maxCardsBonus(state, ownerId) { return Number(s73(state).xieshouPenalty?.[ownerId] ?? 0) },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
    if (!targetId || amount <= 0 || usedThisTurn(host.state, ownerId, CHENJIAO_XIESHOU)
      || getDistance(host.state, ownerId, targetId) > 2 || !player(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: CHENJIAO_XIESHOU, ownerId, step: 'offer', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') option(host, CHENJIAO_XIESHOU, ownerId, 'offer', ownerId,
      '【协守】：是否令手牌上限-1，并令受伤角色选择回复1点体力或复原武将牌并摸两张牌？',
      [{ id: 'yes', label: '发动协守' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      if (!player(host.state, targetId)?.alive || getDistance(host.state, ownerId, targetId) > 2) return
      markUsedThisTurn(host.state, ownerId, CHENJIAO_XIESHOU)
      s73(host.state).xieshouPenalty ??= {}
      s73(host.state).xieshouPenalty[ownerId] = Number(s73(host.state).xieshouPenalty[ownerId] ?? 0) - 1
      option(host, CHENJIAO_XIESHOU, ownerId, 'target-choice', targetId,
        '【协守】：选择一项：回复1点体力，或复原武将牌并摸两张牌',
        [{ id: 'recover', label: '回复1点体力' }, { id: 'restore-draw', label: '复原武将牌并摸两张牌' }], { targetId }, false)
      return
    }
    if (resolution.step !== 'target-choice') return
    const targetId = resolution.data.targetId as PlayerId
    if (!player(host.state, targetId)?.alive) return
    const pick = (response.payload as { optionId?: string }).optionId
    if (pick === 'recover') recover(host as never, targetId, 1, CHENJIAO_XIESHOU)
    else if (pick === 'restore-draw') {
      restoreCharacter(host as never, targetId, CHENJIAO_XIESHOU)
      drawCards(host.state, host.rng, targetId, 2)
    }
  },
})

registerSkillRuntime({
  id: CHENJIAO_QINGYAN,
  maxCardsBonus(state, ownerId) { return Number(s73(state).qingyanBonus?.[ownerId] ?? 0) },
  triggers: [{ event: 'TargetConfirmed', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    if (!sourceId || sourceId === ownerId || context.event.targetId !== ownerId
      || !payload.cardId || effectiveCardColor(host.state, sourceId, payload.cardId) !== 'black'
      || Number(s73(host.state).qingyanCount?.[`${ownerId}:${host.state.turnNumber}`] ?? 0) >= 2) return
    const own = player(host.state, ownerId)
    if (!own?.alive) return
    if (own.zones.hand.length < own.hp)
      host.queueSkill({ skillId: CHENJIAO_QINGYAN, ownerId, step: 'draw-offer', data: {} })
    else if (own.zones.hand.length >= own.hp && own.zones.hand.length)
      host.queueSkill({ skillId: CHENJIAO_QINGYAN, ownerId, step: 'choice', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'draw-offer') {
      option(host, CHENJIAO_QINGYAN, ownerId, 'draw-offer', ownerId, '【清严】：是否将手牌摸至体力上限？',
        [{ id: 'yes', label: '摸牌' }])
      return
    }
    if (prompt.step === 'draw') {
      const own = player(host.state, ownerId)
      if (own) {
        s73(host.state).qingyanCount ??= {}
        s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] = Number(s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] ?? 0) + 1
        drawCards(host.state, host.rng, ownerId, Math.max(0, own.maxHp - own.zones.hand.length))
      }
    }
    else if (prompt.step === 'choice') option(host, CHENJIAO_QINGYAN, ownerId, 'choice', ownerId, '【清严】：是否弃置一张手牌令手牌上限+1？', [{ id: 'yes', label: '弃置并增加上限' }])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        const own = player(host.state, ownerId)
        if (own?.alive && own.zones.hand.length < own.maxHp) {
          s73(host.state).qingyanCount ??= {}
          s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] = Number(s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] ?? 0) + 1
          drawCards(host.state, host.rng, ownerId, Math.max(0, own.maxHp - own.zones.hand.length))
        }
      }
      return
    }
    if (resolution.step === 'choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const own = player(host.state, ownerId)
      if (!own?.zones.hand.length) return
      cards(host, CHENJIAO_QINGYAN, ownerId, 'discard', ownerId, [...own.zones.hand], 1, 1, '【清严】：弃置一张手牌')
      return
    }
    if (resolution.step !== 'discard') return
    const id = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!id || !player(host.state, ownerId)?.zones.hand.includes(id)) return
    discardCardsByIds(host as never, ownerId, [id], CHENJIAO_QINGYAN)
    s73(host.state).qingyanBonus ??= {}
    s73(host.state).qingyanBonus[ownerId] = Number(s73(host.state).qingyanBonus[ownerId] ?? 0) + 1
    s73(host.state).qingyanCount ??= {}
    s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] = Number(s73(host.state).qingyanCount[`${ownerId}:${host.state.turnNumber}`] ?? 0) + 1
  },
})

registerSkillRuntime({
  id: CHENJIAO_QIZI,
  prohibitsOwnResponse(state, ownerId, cardName) {
    const dying = state.dying
    return cardName === '桃' && Boolean(dying && dying.playerId !== ownerId && getDistance(state, ownerId, dying.playerId) > 2)
  },
})

registerSkillRuntime({
  id: HAOMENG_XIONGMANG,
  globalSlashUses(state, ownerId, targetId) {
    return ownerId === targetId && state.currentPlayerId === ownerId && state.phase === 'play'
      ? Number(s73(state).xiongmangExtraUse?.[ownerId]?.turn === state.turnNumber
        ? s73(state).xiongmangExtraUse[ownerId].count : 0) : 0
  },
  slashTargetExpansionForAction(state, ownerId, cardId, targetIds) {
    const count = Number(s73(state).xiongmangMaterials?.[cardId] ?? 0)
    if (count <= targetIds.length) return null
    return { maxAdditionalTargets: count - 1, candidateIds: alive(state).filter((p) => p.id !== ownerId && !targetIds.includes(p.id)).map((p) => p.id) }
  },
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const p = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardId = p.cardId
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== HAOMENG_XIONGMANG || p.cardName !== '杀' || !cardId) return
      if (cardDamageDealt(host.state, cardId) > 0) {
        s73(host.state).xiongmangExtraUse ??= {}
        const current = s73(host.state).xiongmangExtraUse[ownerId]
        s73(host.state).xiongmangExtraUse[ownerId] = {
          turn: host.state.turnNumber, count: Number(current?.turn === host.state.turnNumber ? current.count : 0) + 1,
        }
      } else loseMaxHp(host as never, ownerId, 1, HAOMENG_XIONGMANG)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (p.playerId === ownerId && p.phase === 'play') delete s73(host.state).xiongmangExtraUse?.[ownerId]
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) delete s73(host.state).xiongmangMaterials?.[cardId]
    } },
  ],
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && player(state, ownerId)?.alive
      ? [{ id: `skill:${HAOMENG_XIONGMANG}`, label: '发动【雄莽】' }] : []
  },
  invokeActive(host, ownerId) {
    const hand = player(host.state, ownerId)?.zones.hand ?? []
    if (hand.length) cards(host, HAOMENG_XIONGMANG, ownerId, 'materials', ownerId, [...hand], 1, Math.min(4, hand.length),
      '【雄莽】：选择任意张花色各不相同的手牌当【杀】（目标数等于牌数）', {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'materials') {
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const own = player(host.state, ownerId)
      const suits = selected.map((id) => host.state.cards[id]?.suit)
      const valid = own && selected.length > 0 && selected.length <= 4 && selected.every((id) => own.zones.hand.includes(id))
        && suits.every(Boolean) && new Set(suits).size === selected.length
      if (!valid) {
        if (own?.zones.hand.length) cards(host, HAOMENG_XIONGMANG, ownerId, 'materials', ownerId, [...own.zones.hand], 1,
          Math.min(4, own.zones.hand.length), '【雄莽】：所选牌须为不同花色，请重新选择', {}, false)
        return
      }
      s73(host.state).xiongmangMaterials ??= {}
      s73(host.state).xiongmangMaterials[selected[0]!] = selected.length
      const actions = withNextCardTargetChoices(host.state, ownerId,
        declaredCardActions(host.state, ownerId, selected[0]!, '杀', '【雄莽】', { sourceSkillId: HAOMENG_XIONGMANG }))
        .filter((action) => action.kind === 'use-card' && action.targetIds.length === selected.length)
      if (!actions.length) { delete s73(host.state).xiongmangMaterials[selected[0]!]; return }
      option(host, HAOMENG_XIONGMANG, ownerId, 'targets', ownerId, '【雄莽】：选择【杀】的目标组合',
        actions.map((action) => ({ id: action.id, label: action.label })), { selected }, false)
      return
    }
    if (resolution.step !== 'targets') return
    const selected = resolution.data.selected as CardId[]
    const actionId = (response.payload as { optionId?: string }).optionId
    const base = withNextCardTargetChoices(host.state, ownerId,
      declaredCardActions(host.state, ownerId, selected[0]!, '杀', '【雄莽】', { sourceSkillId: HAOMENG_XIONGMANG }))
      .find((action) => action.kind === 'use-card' && action.id === actionId && action.targetIds.length === selected.length)
    if (!base || base.kind !== 'use-card' || selected.some((id) => !player(host.state, ownerId)?.zones.hand.includes(id))) {
      delete s73(host.state).xiongmangMaterials?.[selected[0]!]
      return
    }
    executeUseCardAction(host as never, ownerId, { ...base, cardIds: selected, sourceSkillId: HAOMENG_XIONGMANG }, { countSlashUsage: true })
  },
})

const JINGJIAN_TAG = `${MUSHUN_JINGJIAN}:pindian`
registerPindianContinuation(JINGJIAN_TAG, (rawHost, result) => {
  if (result.outcome === 'initiator-win') {
    const host = rawHost as unknown as SkillHost
    const ownerId = result.data.skillOwnerId as PlayerId
    if (player(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, MUSHUN_JINGJIAN)
  }
})

registerSkillRuntime({
  id: MUSHUN_JINGJIAN,
  attackRangeBonus(state, ownerId) { return Number(player(state, ownerId)?.marks['jin-mushun'] ?? 0) },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
    const isParticipant = context.event.sourceId === ownerId || context.event.targetId === ownerId
    const owner = player(host.state, ownerId)
    if (!isParticipant || amount <= 0 || !owner?.alive) return
    owner.marks['jin-mushun'] = Number(owner.marks['jin-mushun'] ?? 0) + 1
    const sourceId = context.event.sourceId
    if (!sourceId || sourceId === ownerId || !player(host.state, sourceId)?.alive || !owner.zones.hand.length
      || !(player(host.state, sourceId)?.zones.hand.length)) return
    host.queueSkill({ skillId: MUSHUN_JINGJIAN, ownerId, step: 'pindian-offer', data: { sourceId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pindian-offer') option(host, MUSHUN_JINGJIAN, ownerId, 'pindian-offer', ownerId,
      `【劲坚】：是否与伤害来源${player(host.state, prompt.data.sourceId as PlayerId)?.nickname ?? '拼点'}？`,
      [{ id: 'yes', label: '拼点' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pindian-offer' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const opponentId = resolution.data.sourceId as PlayerId
    if (player(host.state, ownerId)?.zones.hand.length && player(host.state, opponentId)?.zones.hand.length)
      startPindian(host as never, { id: `${MUSHUN_JINGJIAN}:${host.state.seq}`, initiatorId: ownerId, opponentId,
        reason: MUSHUN_JINGJIAN, continuationTag: JINGJIAN_TAG, data: { skillOwnerId: ownerId } })
  },
})

registerSkillRuntime({
  id: MUSHUN_SHIZHAO,
  incomingDamage(state, ownerId, context) {
    if (s73(state).shizhaoDamageTurn?.[ownerId] !== state.turnNumber) return null
    return { amount: context.amount + 1 }
  },
  triggers: [
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId }
      const owner = player(host.state, ownerId)
      const key = `${ownerId}:${host.state.turnNumber}`
      if (p.playerId !== ownerId || host.state.currentPlayerId === ownerId || !owner?.alive || owner.zones.hand.length !== 0
        || s73(host.state).shizhaoUsed?.[key]) return
      s73(host.state).shizhaoUsed ??= {}
      s73(host.state).shizhaoUsed[key] = true
      const marks = Number(owner.marks['jin-mushun'] ?? 0)
      if (marks > 0) {
        owner.marks['jin-mushun'] = marks - 1
        if (owner.marks['jin-mushun'] <= 0) delete owner.marks['jin-mushun']
        drawCards(host.state, host.rng, ownerId, 2)
      } else {
        s73(host.state).shizhaoDamageTurn ??= {}
        s73(host.state).shizhaoDamageTurn[ownerId] = host.state.turnNumber
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && s73(host.state).shizhaoDamageTurn?.[ownerId] === host.state.turnNumber)
        delete s73(host.state).shizhaoDamageTurn[ownerId]
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      delete s73(host.state).shizhaoDamageTurn?.[ownerId]
    } },
  ],
})

registerSkillRuntime({
  id: LICAIWEI_YIJIAO,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, LICAIWEI_YIJIAO)
      && alive(state).some((p) => p.id !== ownerId) ? [{ id: `skill:${LICAIWEI_YIJIAO}`, label: '发动【异教】' }] : []
  },
  invokeActive(host, ownerId) {
    const candidates = alive(host.state).filter((p) => p.id !== ownerId).map((p) => p.id)
    if (candidates.length) targets(host, LICAIWEI_YIJIAO, ownerId, 'target', candidates, '【异教】：选择一名其他角色')
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const actorId = context.event.sourceId
      if (!actorId) return
      const p = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const ids = p.cardIds?.length ? p.cardIds : p.cardId ? [p.cardId] : []
      const value = ids.reduce((sum, id) => sum + (host.state.cards[id]?.rank ?? 0), 0)
      const entry = s73(host.state).yijiao?.[ownerId] as { targetId: PlayerId; turn: number; sum: number } | undefined
      if (entry?.targetId === actorId && entry.turn === host.state.turnNumber) entry.sum += value
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const entry = s73(host.state).yijiao?.[ownerId]
      if (p.phase !== 'finish' || p.playerId !== entry?.targetId || entry.turn !== host.state.turnNumber) return
      const owner = player(host.state, ownerId); const target = player(host.state, entry.targetId)
      if (!owner?.alive || !target?.alive) { delete s73(host.state).yijiao[ownerId]; return }
      delete s73(host.state).yijiao[ownerId]
      if (entry.sum < entry.threshold) {
        const count = Math.min(target.zones.hand.length, host.rng.nextInt(3) + 1)
        const chosen = host.rng.shuffle([...target.zones.hand]).slice(0, count)
        if (chosen.length) discardCardsByIds(host as never, target.id, chosen, LICAIWEI_YIJIAO)
      } else if (entry.sum === entry.threshold) {
        drawCards(host.state, host.rng, ownerId, 2)
        queueExtraTurn(host.state, target.id, { playerId: ownerId, skillId: LICAIWEI_YIJIAO })
      } else drawCards(host.state, host.rng, ownerId, 3)
      target.marks[LICAIWEI_MARK] = Math.max(0, Number(target.marks[LICAIWEI_MARK] ?? 0) - entry.threshold)
      if (!target.marks[LICAIWEI_MARK]) delete target.marks[LICAIWEI_MARK]
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      const entry = s73(host.state).yijiao?.[ownerId]
      if (entry?.targetId !== playerId) return
      const target = player(host.state, playerId!)
      if (target) {
        target.marks[LICAIWEI_MARK] = Math.max(0, Number(target.marks[LICAIWEI_MARK] ?? 0) - entry.threshold)
        if (!target.marks[LICAIWEI_MARK]) delete target.marks[LICAIWEI_MARK]
      }
      delete s73(host.state).yijiao[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive) return
      option(host, LICAIWEI_YIJIAO, ownerId, 'number', ownerId, '【异教】：选择一个数字（该角色获得其十倍“异”标记）',
        [1, 2, 3, 4].map((n) => ({ id: String(n), label: String(n) })), { targetId }, false)
      return
    }
    if (resolution.step !== 'number') return
    const targetId = resolution.data.targetId as PlayerId
    const amount = Number((response.payload as { optionId?: string }).optionId)
    const target = player(host.state, targetId)
    if (![1, 2, 3, 4].includes(amount) || !target?.alive) return
    markUsedThisPhase(host.state, ownerId, LICAIWEI_YIJIAO)
    s73(host.state).yijiao ??= {}
    s73(host.state).yijiao[ownerId] = { targetId, threshold: amount * 10, sum: 0, turn: host.state.turnNumber }
    target.marks[LICAIWEI_MARK] = Number(target.marks[LICAIWEI_MARK] ?? 0) + amount * 10
  },
})

registerSkillRuntime({
  id: LICAIWEI_QIBIE,
  triggers: [{ event: 'Death', handle(host, ownerId) {
    const own = player(host.state, ownerId)
    if (own?.alive && own.zones.hand.length) host.queueSkill({ skillId: LICAIWEI_QIBIE, ownerId, step: 'offer', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') option(host, LICAIWEI_QIBIE, ownerId, 'offer', ownerId, '【泣别】：是否弃置所有手牌，回复1点体力并摸弃置数+2张牌？',
      [{ id: 'yes', label: '弃置所有手牌并执行' }])
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const own = player(host.state, ownerId)
      if (!own?.alive || !own.zones.hand.length) return
      cards(host, LICAIWEI_QIBIE, ownerId, 'discard-all', ownerId, [...own.zones.hand], own.zones.hand.length, own.zones.hand.length,
        '【泣别】：弃置所有手牌', {}, false)
      return
    }
    if (resolution.step !== 'discard-all') return
    const own = player(host.state, ownerId)
    const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = own ? ids.filter((id) => own.zones.hand.includes(id)) : []
    if (!own?.alive || !valid.length || valid.length !== own.zones.hand.length) return
    discardCardsByIds(host as never, ownerId, valid, LICAIWEI_QIBIE)
    recover(host as never, ownerId, 1, LICAIWEI_QIBIE)
    drawCards(host.state, host.rng, ownerId, valid.length + 2)
  },
})

const SHILIE_PILE = WANGWEI_SHILIE
const RUIZHAN_TAG = `${WANGWEI_RUIZHAN}:pindian`
registerPindianContinuation(RUIZHAN_TAG, (rawHost, result) => {
  const host = rawHost as unknown as SkillHost
  const ownerId = result.data.skillOwnerId as PlayerId
  const targetId = result.opponentId
  const won = result.outcome === 'initiator-win'
  const revealedSlash = host.state.cards[result.initiatorCardId]?.name === '杀'
  if (!won && !revealedSlash) return
  const both = won && revealedSlash
  if (both) (s73(host.state).ruizhanSteal ??= {})[ownerId] = targetId
  if (player(host.state, ownerId)?.alive && player(host.state, targetId)?.alive)
    (host as unknown as SkillHost).beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: WANGWEI_RUIZHAN, countUsage: false })
})

registerSkillRuntime({
  id: WANGWEI_RUIZHAN,
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== WANGWEI_RUIZHAN) return
      const targetId = (context.event.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && s73(host.state).ruizhanSteal?.[ownerId] === targetId)
        delete s73(host.state).ruizhanSteal[ownerId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const p = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const target = p.playerId ? player(host.state, p.playerId) : null
      const own = player(host.state, ownerId)
      if (p.phase === 'prepare' && target && target.id !== ownerId && own?.alive && target.alive
        && target.zones.hand.length >= target.hp && own.zones.hand.length && target.zones.hand.length)
        host.queueSkill({ skillId: WANGWEI_RUIZHAN, ownerId, step: 'offer', data: { targetId: target.id } })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (context.event.sourceSkillId !== WANGWEI_RUIZHAN || context.event.sourceId !== ownerId
        || s73(host.state).ruizhanSteal?.[ownerId] !== targetId
        || ((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      delete s73(host.state).ruizhanSteal[ownerId]
      const pickable = pickableCardsOf(host.state, targetId!)
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: WANGWEI_RUIZHAN, ownerId, step: 'gain', data: { targetId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【锐战】：获得${player(host.state, targetId!)?.nickname ?? '该角色'}一张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') option(host, WANGWEI_RUIZHAN, ownerId, 'offer', ownerId,
      `【锐战】：是否与${player(host.state, prompt.data.targetId as PlayerId)?.nickname ?? '该角色'}拼点？`, [{ id: 'yes', label: '拼点' }], prompt.data)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      if (!player(host.state, ownerId)?.zones.hand.length || !player(host.state, targetId)?.zones.hand.length) return
      startPindian(host as never, { id: `${WANGWEI_RUIZHAN}:${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
        reason: WANGWEI_RUIZHAN, continuationTag: RUIZHAN_TAG, data: { skillOwnerId: ownerId } })
      return
    }
    if (resolution.step !== 'gain') return
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && resolvePickedCard(host.state, targetId, selected)
    if (!cardId || !player(host.state, targetId)?.alive || !player(host.state, ownerId)?.alive) return
    if (movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId }))
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WANGWEI_RUIZHAN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: WANGWEI_SHILIE,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && player(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, WANGWEI_SHILIE)
      ? [{ id: `skill:${WANGWEI_SHILIE}`, label: '发动【示烈】' }] : []
  },
  invokeActive(host, ownerId) {
    const own = player(host.state, ownerId)
    if (!own?.alive || usedThisPhase(host.state, ownerId, WANGWEI_SHILIE)) return
    option(host, WANGWEI_SHILIE, ownerId, 'mode', ownerId, '【示烈】：选择一项',
      [{ id: 'store', label: '回复1点体力，然后将至多两张牌置于武将牌上' }, { id: 'retrieve', label: '失去1点体力，然后获得武将牌上的至多两张牌' }], {}, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode !== 'store' && mode !== 'retrieve') return
      markUsedThisPhase(host.state, ownerId, WANGWEI_SHILIE)
      if (mode === 'store') {
        recover(host as never, ownerId, 1, WANGWEI_SHILIE)
        const own = player(host.state, ownerId)!
        const capacity = Math.max(0, host.state.players.length - (own.characterPiles[SHILIE_PILE]?.length ?? 0))
        const count = Math.min(2, own.zones.hand.length, capacity)
        if (count) cards(host, WANGWEI_SHILIE, ownerId, 'store-cards', ownerId, [...own.zones.hand], count, count,
          '【示烈】：将牌置于武将牌上', { count }, false)
      } else {
        loseHp(host as never, ownerId, 1, WANGWEI_SHILIE)
        const pile = [...(player(host.state, ownerId)?.characterPiles[SHILIE_PILE] ?? [])]
        const count = Math.min(2, pile.length)
        if (count) cards(host, WANGWEI_SHILIE, ownerId, 'take-cards', ownerId, pile, count, count, '【示烈】：获得武将牌上的牌', {}, false)
      }
      return
    }
    if (resolution.step === 'store-cards') {
      const own = player(host.state, ownerId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const count = Number(resolution.data.count)
      if (!own || ids.length !== count || ids.some((id) => !own.zones.hand.includes(id))) return
      own.characterPiles[SHILIE_PILE] ??= []
      if (own.characterPiles[SHILIE_PILE].length + ids.length > host.state.players.length) return
      for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: SHILIE_PILE })
      return
    }
    if (resolution.step === 'take-cards') {
      const own = player(host.state, ownerId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const pile = own?.characterPiles[SHILIE_PILE] ?? []
      const count = Math.min(2, pile.length)
      if (!own || ids.length !== count || ids.some((id) => !pile.includes(id))) return
      for (const id of ids) moveCard(host.state, id, { kind: 'characterPile', playerId: ownerId, pile: SHILIE_PILE }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: ids, reason: WANGWEI_SHILIE }, { targetId: ownerId, cardIds: ids })
      return
    }
    if (resolution.step !== 'death-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const sourceId = resolution.data.sourceId as PlayerId | undefined
    const own = player(host.state, ownerId); const target = targetId ? player(host.state, targetId) : null
    if (!own || !target?.alive || targetId === sourceId) return
    const pile = [...(own.characterPiles[SHILIE_PILE] ?? [])]
    for (const id of pile) moveCard(host.state, id, { kind: 'characterPile', playerId: ownerId, pile: SHILIE_PILE }, { kind: 'hand', playerId: target.id })
    if (pile.length) {
      host.dispatch('GainCard', { playerId: target.id, cardIds: pile, reason: WANGWEI_SHILIE }, { sourceId: ownerId, targetId: target.id, cardIds: pile })
      host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: target.id, cardIds: pile, reason: WANGWEI_SHILIE }, { sourceId: ownerId, targetId: target.id, cardIds: pile })
    }
  },
  triggers: [{ event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const own = player(host.state, ownerId)
    const pile = own?.characterPiles[SHILIE_PILE] ?? []
    const sourceId = context.event.sourceId
    const receivers = alive(host.state).filter((p) => p.id !== ownerId && p.id !== sourceId)
    if (pile.length && receivers.length) host.queueSkill({ skillId: WANGWEI_SHILIE, ownerId, step: 'death-target', data: { sourceId }, allowDeadOwner: true })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'death-target') return
    const sourceId = prompt.data.sourceId as PlayerId | undefined
    const candidates = alive(host.state).filter((p) => p.id !== ownerId && p.id !== sourceId).map((p) => p.id)
    if (candidates.length) targets(host, WANGWEI_SHILIE, ownerId, 'death-target', candidates,
      '【示烈】：将武将牌上的牌交给一名非伤害来源的角色', { sourceId }, false)
  },
})

registerSkillRuntime({
  id: MIFANGFUSHIREN_FENGSHI,
  outgoingDamage(state, ownerId, context) {
    const key = s73(state).fengshiOutgoing?.[`${ownerId}:${context.cardId ?? ''}`]
    return key?.includes(context.targetId) ? { amount: context.amount + 1 } : null
  },
  incomingDamage(state, ownerId, context) {
    const key = s73(state).fengshiIncoming?.[`${ownerId}:${context.cardId ?? ''}`]
    return key ? { amount: context.amount + 1 } : null
  },
  triggers: [
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { targetIds?: PlayerId[]; cardId?: CardId; cardIds?: CardId[] }
      const source = player(host.state, ownerId)
      const candidates = [...new Set(payload.targetIds ?? (context.event.targetId ? [context.event.targetId] : []))]
        .filter((id) => player(host.state, id)?.alive && (player(host.state, id)?.zones.hand.length ?? 0) < (source?.zones.hand.length ?? 0))
      if (candidates.length) host.queueSkill({ skillId: MIFANGFUSHIREN_FENGSHI, ownerId, step: 'outgoing-target', data: {
        sourceId: ownerId, targetIds: candidates, event: context.event,
      } })
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId && context.event.sourceId !== ownerId) host.queueSkill({ skillId: MIFANGFUSHIREN_FENGSHI, ownerId, step: 'incoming-check', data: { sourceId: context.event.sourceId, targetId: context.event.targetId, event: context.event } })
    } },
    { event: 'AfterCardUse', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      for (const key of Object.keys(s73(host.state).fengshiOutgoing ?? {})) if (key.endsWith(`:${cardId}`)) delete s73(host.state).fengshiOutgoing[key]
      for (const key of Object.keys(s73(host.state).fengshiIncoming ?? {})) if (key.endsWith(`:${cardId}`)) delete s73(host.state).fengshiIncoming[key]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'outgoing-target') {
      targets(host, MIFANGFUSHIREN_FENGSHI, ownerId, 'outgoing-target', prompt.data.targetIds as PlayerId[],
        '【锋势】：选择一名手牌数小于你的目标', prompt.data)
      return
    }
    if (prompt.step !== 'outgoing-check' && prompt.step !== 'incoming-check') return
    const sourceId = prompt.data.sourceId as PlayerId; const targetId = prompt.data.targetId as PlayerId
    const a = player(host.state, sourceId); const b = player(host.state, targetId)
    if (!a || !b || !player(host.state, ownerId)?.alive) return
    const outgoing = prompt.step === 'outgoing-check' && sourceId === ownerId && b.zones.hand.length < a.zones.hand.length
    const incoming = prompt.step === 'incoming-check' && targetId === ownerId && sourceId !== ownerId && a.zones.hand.length > b.zones.hand.length
    if (!outgoing && !incoming) return
    option(host, MIFANGFUSHIREN_FENGSHI, ownerId, 'discard-offer', ownerId,
      `【锋势】：是否弃置你与${player(host.state, outgoing ? targetId : sourceId)?.nickname ?? '其'}各一张牌，使此牌对其伤害+1？`,
      [{ id: 'yes', label: '弃置各一张牌' }], { outgoing, sourceId, targetId, event: prompt.data.event })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'outgoing-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !(resolution.data.targetIds as PlayerId[] | undefined)?.includes(targetId)
        || !player(host.state, targetId)?.alive || (player(host.state, targetId)?.zones.hand.length ?? 0)
          >= (player(host.state, ownerId)?.zones.hand.length ?? 0)) return
      host.queueSkill({ skillId: MIFANGFUSHIREN_FENGSHI, ownerId, step: 'outgoing-check', data: {
        sourceId: ownerId, targetId, outgoing: true, event: resolution.data.event,
      } })
      return
    }
    if (resolution.step === 'discard-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const data = resolution.data; const otherId = data.outgoing ? data.targetId as PlayerId : data.sourceId as PlayerId
      const own = pickableCardsOf(host.state, ownerId); const choices = [...own.cardIds, ...own.hiddenCardSlots]
      if (!choices.length || !player(host.state, otherId)?.alive) return
      host.askSkill({ skillId: MIFANGFUSHIREN_FENGSHI, ownerId, step: 'pick-own', data, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【锋势】：选择弃置你的一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: own.cardIds, hiddenCardSlots: own.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'pick-own') {
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const ownCardId = picked && resolvePickedCard(host.state, ownerId, picked)
      const otherId = resolution.data.outgoing ? resolution.data.targetId as PlayerId : resolution.data.sourceId as PlayerId
      const otherPick = pickableCardsOf(host.state, otherId, { discarderId: ownerId })
      if (!ownCardId || !locateOwnedCard(host.state, ownerId, ownCardId) || !otherPick.cardIds.length && !otherPick.hiddenCardSlots.length) return
      host.askSkill({ skillId: MIFANGFUSHIREN_FENGSHI, ownerId, step: 'pick-other', data: { ...resolution.data, ownCardId }, build: (id) => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【锋势】：选择弃置${player(host.state, otherId)?.nickname ?? '其'}的一张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: otherPick.cardIds, hiddenCardSlots: otherPick.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'pick-other') return
    const data = resolution.data; const targetId = data.targetId as PlayerId
    const otherId = data.outgoing ? targetId : data.sourceId as PlayerId
    const ownCardId = data.ownCardId as CardId
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const otherCardId = picked && resolvePickedCard(host.state, otherId, picked)
    if (!otherCardId || !locateOwnedCard(host.state, ownerId, ownCardId) || !player(host.state, otherId)?.alive) return
    discardCardsByIds(host as never, ownerId, [ownCardId], MIFANGFUSHIREN_FENGSHI)
    if (!movePickedCard(host as never, otherId, otherCardId, { kind: 'discardPile' })) return
    host.dispatch('LoseCard', { playerId: otherId, cardIds: [otherCardId], reason: MIFANGFUSHIREN_FENGSHI }, { sourceId: ownerId, targetId: otherId, cardIds: [otherCardId] })
    const event = data.event as { payload?: { cardId?: CardId; cardIds?: CardId[] } }
    const cardId = event.payload?.cardId ?? event.payload?.cardIds?.[0]
    if (!cardId) return
    if (data.outgoing) (s73(host.state).fengshiOutgoing ??= {})[`${ownerId}:${cardId}`] = [targetId]
    else (s73(host.state).fengshiIncoming ??= {})[`${ownerId}:${cardId}`] = true
  },
})

export const HISTORICAL_BATCH73_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'wangyue-b73', name: '王悦', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: WANGYUE_HUGUAN, name: '护关', description: '一名角色于其出牌阶段使用的第一张牌若为红色，则你可声明一个花色，本回合该花色的牌不计入该角色的手牌上限。' },
    { id: WANGYUE_MINGLUAN, name: '鸣鸾', description: '其他角色的结束阶段，若本回合有角色回复过体力，则你可以弃置任意张牌，然后摸等同于当前回合角色手牌数的牌（最多摸至五张）。' },
  ] },
  { id: 'zhaoyan-b73', name: '赵嫣', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHAOYAN_JINHUI, name: '锦绘', description: '出牌阶段限一次，你可以随机亮出牌堆中三张不同名且仅指定单一目标的非伤害牌，然后选择一名其他角色，该角色选择并使用其中一张，然后你可以依次使用其余两张（目标不为自己的牌必须选择对方为目标，无距离和次数限制）。' },
    { id: ZHAOYAN_QINGMAN, name: '轻幔', description: '锁定技，每个回合结束时，你将手牌数摸至X（X为当前回合角色装备区内的空位数）。', locked: true },
  ] },
  { id: 'zhangxuan-b73', name: '张嫙', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANGXUAN_TONGLI, name: '同礼', description: '出牌阶段，当你使用牌指定目标后，若你手牌中的花色数等于你此阶段已使用牌的张数，你可令此牌效果额外执行X次（X为你手牌中的花色数）。' },
    { id: ZHANGXUAN_SHEZANG, name: '奢葬', description: '每轮限一次，当你或你回合内有角色进入濒死状态时，你可以从牌堆获得不同花色的牌各一张。' },
  ] },
  { id: 'chenjiao-b73', name: '陈矫', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: CHENJIAO_XIESHOU, name: '协守', description: '每回合限一次，当有角色受到伤害后，若你与其距离小于等于2，你可以令你的手牌上限-1，然后其选择一项：1.回复1点体力；2.将武将牌复原并摸两张牌。' },
    { id: CHENJIAO_QINGYAN, name: '清严', description: '每回合限两次，当你成为其他角色使用黑色牌的目标后：若你的手牌小于体力值，你可将手牌摸至体力上限；若你的手牌数不小于体力值，你可以弃置一张手牌令手牌上限+1。' },
    { id: CHENJIAO_QIZI, name: '弃子', description: '锁定技，其他角色处于濒死状态时，若你与其距离大于2，你不能对其使用【桃】。', locked: true },
  ] },
  { id: 'mifangfushiren-b73', name: '糜芳傅士仁', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MIFANGFUSHIREN_FENGSHI, name: '锋势', description: '当你使用牌指定目标后，若有目标角色的手牌数小于你，你可以弃置你与其各一张牌，然后此牌对其伤害+1；当你成为其他角色使用牌的目标后，若你的手牌数小于使用者，你可以弃置你与其各一张牌，然后此牌对你伤害+1。' },
  ] },
  { id: 'licaiwei-b73', name: '李采薇', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LICAIWEI_YIJIAO, name: '异教', description: '出牌阶段限一次，你可以选择一名其他角色并在1~4之间选择一个数字，该角色获得此数字十倍的“异”标记。有“异”标记的角色的结束阶段，若其本回合使用牌的点数之和：1.小于“异”标记数，其随机弃置1~3张手牌；2.等于“异”标记数，你摸2张牌且该角色回合结束后进行一个额外的回合；3.大于“异”标记数，你摸3张牌。回合结束后移去“异”标记。' },
    { id: LICAIWEI_QIBIE, name: '泣别', description: '一名角色阵亡后，若你有手牌，你可以弃置所有手牌，然后回复1点体力值并摸比弃置牌多2张的牌。' },
  ] },
  { id: 'wufan-b73', name: '吴范', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WUFAN_TIANYUN, name: '天运', description: '获得起始手牌后，你再从牌堆中随机获得手牌中没有的花色各一张牌。一名角色的回合开始时，若其座位号和游戏轮数相同，你可以观看牌堆顶的X张牌，然后以任意顺序置于牌堆顶或牌堆底。若你将所有牌均置于牌堆底，则你可以令一名角色摸X张牌（X为你手牌中的花色数），若如此做，你失去1点体力。' },
    { id: WUFAN_YUYAN, name: '预言', description: '每轮游戏开始时，你选择一名角色，若其是本轮第一个进入濒死状态的角色，则你获得技能“奋音”直到你的回合结束。若其是本轮第一个造成伤害的角色，则你摸两张牌。' },
  ] },
  { id: 'haomeng-b73', name: '郝萌', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: HAOMENG_XIONGMANG, name: '雄莽', description: '你可以将任意张花色不同的手牌当【杀】使用。此【杀】的可选择的目标数等于这张【杀】所用的花色数。若此【杀】没有造成伤害，则你减1点体力上限。若此【杀】造成了伤害，此阶段你可使用【杀】次数+1。' },
  ] },
  { id: 'wangwei-b73', name: '王威', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WANGWEI_RUIZHAN, name: '锐战', description: '其他的角色准备阶段，若其手牌数大于等于体力值，你可以与其进行一次拼点；若你赢或者拼点牌有【杀】，你视为对其使用一张【杀】；若两项均满足，此【杀】造成伤害后你获得其一张牌。' },
    { id: WANGWEI_SHILIE, name: '示烈', description: '出牌阶段限一次，你可以选择一项：1.回复1点体力，然后将两张牌置于武将牌上（不足则全放，且总数不能超过游戏人数）；2.失去1点体力，然后获得武将牌上的两张牌。你死亡时，你可将武将牌上的牌交给除伤害来源外的一名其他角色。' },
  ] },
  { id: 'mushun-b73', name: '穆顺', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MUSHUN_JINGJIAN, name: '劲坚', description: '锁定技，当你造成或受到伤害后，你获得一个“劲”标记，然后你可以与伤害来源拼点：若你赢，你回复1点体力。（每个“劲”令你攻击范围+1）', locked: true },
    { id: MUSHUN_SHIZHAO, name: '失诏', description: '锁定技，你的回合外，当你每回合第一次失去最后一张手牌时：若你有“劲”，你移去一个“劲”并摸两张牌；若你没有“劲”，则你本回合下一次受到的伤害值+1。', locked: true },
  ] },
]
