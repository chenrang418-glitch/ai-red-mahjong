// 武将册第38批（武将册序号496–505）。
// @ts-nocheck
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { gainOriginCounts } from '../../engine/card-gain-provenance'
import { giveCards } from '../../engine/hand-transfer'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { reshuffleDrawPile } from '../../engine/deck'
import { queueDamagePoint, damagePointsOf } from '../../engine/per-damage-point'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { forceDistance } from '../../engine/distance-override'
import { suppressSkill } from '../../engine/skill-suppression'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { resolveDamage } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { createVirtualSlashCard, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'

type B38 = SanguoshaState & { b38?: Record<string, any> }
const st = (h: SkillHost) => h.state as B38
const pof = (s: SanguoshaState, id: PlayerId) => s.players.find(p => p.id === id)
const hand = (s: SanguoshaState, id: PlayerId): CardId[] => pof(s, id)?.zones.hand ?? []
const alive = (s: SanguoshaState) => s.players.filter(p => p.alive)
const others = (s: SanguoshaState, id: PlayerId) => alive(s).filter(p => p.id !== id)
const put = (h: SkillHost, key: string, value: any) => { st(h).b38 ??= {}; st(h).b38[key] = value }
const get = (s: B38, key: string) => s.b38?.[key]
function draw(h: SkillHost, id: PlayerId, count: number) { if (count > 0) drawCards(h.state, h.rng, id, count, (name, payload) => h.dispatch(name, payload)) }
function askOption(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: any[], data: any = {}, optional = true) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options }) })
}
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidates: PlayerId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds: candidates, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, ids: CardId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}

function yajiaoOwnedCards(h: SkillHost, id: PlayerId): CardId[] {
  const p = pof(h.state, id)
  return p ? [...p.zones.hand, ...Object.values(p.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
}
function discardOwnedCard(h: SkillHost, id: PlayerId, cardId: CardId): boolean {
  const from = locateOwnedCard(h.state, id, cardId)
  if (!from) return false
  moveCard(h.state, cardId, from, { kind: 'discardPile' })
  if (from.kind === 'equipment') handleEquipmentLost(h as never, id, cardId)
  h.dispatch('LoseCard', { playerId: id, cardIds: [cardId], reason: YAJIAO }, { sourceId: id, cardIds: [cardId] })
  return true
}

const ENYUAN = 'enyuan-jie-b38'
const FENJI = 'fenji-jie-b38'
const TISHEN = 'tishen-jie-b38'
const YAJIAO = 'yajiao-jie-b38'
const TIEQI = 'tieqi-jie-b38'
const LEIJI = 'leiji-jie-b38'
const JIE_YUJI = 'jie-yuji-b38'
const PAOXIAO = 'paoxiao-jie-b38'
const RENDE = 'rende-jie-b38'
const BUQU = 'buqu-jie-b38'
const CHANYUAN = 'chanyuan-jie-b38'
const RENDE_BASICS = ['杀', '闪', '桃', '酒'] as const

registerSkillRuntime({ id: CHANYUAN, invalidatesOtherSkills(state, ownerId) { return pof(state, ownerId)?.hp === 1 } })

// 界张飞【咆哮】：不限次数；本阶段已使用过【杀】后，后续【杀】无距离限制。
registerSkillRuntime({ id: PAOXIAO,
  unlimitedSlash: true,
  triggers: [{ event: 'CardUsed', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (context.event.sourceId === ownerId && h.state.phase === 'play' && p.cardName === '杀') markUsedThisPhase(h.state, ownerId, PAOXIAO)
  } }],
  slashIgnoresDistance(state, ownerId) { return state.phase === 'play' && state.currentPlayerId === ownerId && usedThisPhase(state, ownerId, PAOXIAO) },
})

function rendeCountKey(ownerId: PlayerId) { return `${RENDE}:${ownerId}:given` }
function rendeRecipientMark(ownerId: PlayerId) { return `${RENDE}:${ownerId}:recipient` }
function virtualRendeBasic(h: SkillHost, ownerId: PlayerId, name: '桃' | '酒'): CardId {
  const cardId = `virtual:${RENDE}:${h.state.seq + 1}:${h.state.decisions.length}`
  h.state.cards[cardId] = { id: cardId, ruleset: h.state.rulesetVersion, expansion: 'standard', name, suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true, sourceSkillId: RENDE } as never
  pof(h.state, ownerId)!.zones.hand.push(cardId)
  return cardId
}
function previewRendeSlashTargets(h: SkillHost, ownerId: PlayerId): PlayerId[] {
  const cardId = createVirtualSlashCard(h.state, ownerId, RENDE)
  const targets = [...new Set(declaredCardActions(h.state, ownerId, cardId, '杀', '【仁德】').flatMap(action => action.kind === 'use-card' ? action.targetIds : []))]
  const owner = pof(h.state, ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter(id => id !== cardId)
  delete h.state.cards[cardId]
  return targets
}

// 界刘备【仁德】：每名受赠者本出牌阶段限一次；阶段内给出第二张时可使用基本牌。
registerSkillRuntime({ id: RENDE,
  activeActions(state, ownerId) {
    const owner = pof(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner.zones.hand.length) return []
    const recipients = state.players.filter(p => p.alive && p.id !== ownerId && !usedThisPhase(state, p.id, rendeRecipientMark(ownerId)))
    return recipients.length ? [{ id: `skill:${RENDE}`, label: '发动【仁德】：将手牌交给本阶段未获得过仁德牌的角色' }] : []
  },
  invokeActive(h, ownerId, actionId) {
    if (actionId !== `skill:${RENDE}`) return
    const cards = hand(h.state, ownerId)
    if (cards.length) askCards(h, RENDE, ownerId, 'cards', cards, '【仁德】：选择要交给其他角色的手牌', {}, false, 1, cards.length)
  },
  triggers: [{ event: 'PhaseStart', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId === ownerId && p.phase === 'play') put(h, rendeCountKey(ownerId), 0)
  } }],
  resume(h, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const cards = [...new Set(((response.payload as any).cardIds ?? []) as CardId[])].filter(id => hand(h.state, ownerId).includes(id))
      const candidates = others(h.state, ownerId).filter(p => !usedThisPhase(h.state, p.id, rendeRecipientMark(ownerId))).map(p => p.id)
      if (cards.length && candidates.length) askTargets(h, RENDE, ownerId, 'recipient', candidates, '【仁德】：选择一名本阶段未获得仁德牌的角色', { cards })
      return
    }
    if (resolution.step === 'recipient') {
      const data = resolution.data as any
      const cards = data.cards as CardId[]
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      if (!targetId || !pof(h.state, targetId)?.alive || usedThisPhase(h.state, targetId, rendeRecipientMark(ownerId))) return
      const given = giveCards(h as never, ownerId, targetId, cards.filter(id => hand(h.state, ownerId).includes(id)), RENDE)
      if (!given.length) return
      markUsedThisPhase(h.state, targetId, rendeRecipientMark(ownerId))
      const previous = Number(get(st(h), rendeCountKey(ownerId)) ?? 0)
      const total = previous + given.length
      put(h, rendeCountKey(ownerId), total)
      if (previous < 2 && total >= 2 && !usedThisPhase(h.state, ownerId, `${RENDE}:basic`)) {
        markUsedThisPhase(h.state, ownerId, `${RENDE}:basic`)
        const options = [...(previewRendeSlashTargets(h, ownerId).length ? [{ id: '杀', label: '视为使用【杀】' }] : []),
          ...(pof(h.state, ownerId)!.hp < pof(h.state, ownerId)!.maxHp ? [{ id: '桃', label: '视为使用【桃】' }] : []),
          ...(h.state.turnUsage.wineUses < 1 ? [{ id: '酒', label: '视为使用【酒】' }] : []),
          { id: 'pass', label: '不使用基本牌' }]
        askOption(h, RENDE, ownerId, 'basic', '【仁德】：可以视为使用一张基本牌', options)
      }
      return
    }
    if (resolution.step === 'basic') {
      const name = (response.payload as any).optionId as string
      if (!RENDE_BASICS.includes(name as any) || name === '闪' || !pof(h.state, ownerId)?.alive) return
      if (name === '杀') {
        const cardId = createVirtualSlashCard(h.state, ownerId, RENDE)
        const actions = declaredCardActions(h.state, ownerId, cardId, '杀', '【仁德】视为使用【杀】').filter(a => a.kind === 'use-card')
        const candidates = [...new Set(actions.flatMap(a => a.targetIds))]
        if (!candidates.length) { pof(h.state, ownerId)!.zones.hand = hand(h.state, ownerId).filter(id => id !== cardId); delete h.state.cards[cardId]; return }
        askTargets(h, RENDE, ownerId, 'slash-target', candidates, '【仁德】：为【杀】选择目标', { cardId })
      } else {
        const cardId = virtualRendeBasic(h, ownerId, name as '桃' | '酒')
        executeUseCardAction(h as never, ownerId, { kind: 'use-card', id: `${RENDE}:${cardId}`, playerId: ownerId, label: `【仁德】使用【${name}】`, cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1, asCardName: name } as never)
      }
      return
    }
    if (resolution.step === 'slash-target') {
      const cardId = (resolution.data as any).cardId as CardId
      const targets = (response.payload as any).targetIds ?? []
      const action = declaredCardActions(h.state, ownerId, cardId, '杀', '【仁德】视为使用【杀】')
        .find(a => a.kind === 'use-card' && a.targetIds.length === targets.length && a.targetIds.every(id => targets.includes(id)))
      if (action?.kind === 'use-card') executeUseCardAction(h as never, ownerId, action)
    }
  },
})

// 界周泰【不屈】：重复点数的这张新牌直接弃置；不屈牌数量替代手牌上限。
function buquCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return pof(state, ownerId)?.characterPiles[BUQU] ?? []
}
registerSkillRuntime({ id: BUQU,
  survivesAtZeroHp(state, ownerId) {
    const cards = buquCards(state, ownerId)
    const ranks = cards.map(id => state.cards[id]?.rank)
    return cards.length > 0 && new Set(ranks).size === ranks.length
  },
  fixedMaxCards(state, ownerId) {
    const count = buquCards(state, ownerId).length
    return count > 0 ? count : null
  },
  dyingIntercept(h, ownerId) {
    const owner = pof(h.state, ownerId)
    if (!owner?.alive) return false
    if (!h.state.zones.drawPile.length && !reshuffleDrawPile(h.state, h.rng, (name, payload) => h.dispatch(name, payload))) return false
    const drawn = h.state.zones.drawPile[0]
    const duplicate = buquCards(h.state, ownerId).some(id => h.state.cards[id]?.rank === h.state.cards[drawn]?.rank)
    if (duplicate) {
      moveCard(h.state, drawn, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'other' })
      h.dispatch('CardMove', { playerId: ownerId, cardIds: [drawn], reason: BUQU, revealed: true, duplicateRank: true }, { sourceId: ownerId, cardIds: [drawn] })
      h.dispatch('SkillActivated', { skillId: BUQU, skillName: '不屈', playerId: ownerId, survived: false, rank: h.state.cards[drawn]?.rank }, { sourceId: ownerId })
      return false
    }
    moveCard(h.state, drawn, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile: BUQU })
    h.dispatch('GainCard', { playerId: ownerId, cardIds: [drawn], reason: BUQU, pile: BUQU, revealed: true }, { targetId: ownerId, cardIds: [drawn] })
    if (owner.hp < 1) recover(h as never, ownerId, 1 - owner.hp, ownerId)
    h.dispatch('SkillActivated', { skillId: BUQU, skillName: '不屈', playerId: ownerId, survived: true, rank: h.state.cards[drawn]?.rank }, { sourceId: ownerId })
    return true
  },
})

// 界马超【铁骑】：压制目标非锁定技，并要求其弃置与判定同花色的牌才能闪。
const TIEQI_TAG = 'tieqi-jie-b38'
registerSkillRuntime({ id: TIEQI,
  interceptSourceTarget(h, ownerId, context) {
    if (context.cardName !== '杀' || !pof(h.state, context.targetId)?.alive) return false
    h.askSkill({ skillId: TIEQI, ownerId, step: 'invoke', data: { targetId: context.targetId }, build: id => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【铁骑】：令${pof(h.state, context.targetId)?.nickname ?? '该角色'}本回合非锁定技失效，并判定？`,
      timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '发动【铁骑】' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    const targetId = (resolution.data as any).targetId as PlayerId
    if ((response.payload as any).optionId !== 'yes' || !pof(h.state, targetId)?.alive) {
      h.resumeCardTarget(); return
    }
    suppressSkill(h.state, { targetId, sourceId: ownerId, sourceSkillId: TIEQI, scope: 'non-locked', armedAtTurn: h.state.turnNumber })
    performJudgment(h as never, ownerId, '铁骑', { tag: TIEQI_TAG, data: { targetId } })
  },
})
registerJudgmentContinuation(TIEQI_TAG, (h, judged, data) => {
  const resolution = h.state.cardResolution
  if (resolution?.kind === 'slash' && resolution.targetId === data.targetId) {
    resolution.responseDiscardCostRequirements ??= []
    resolution.responseDiscardCostRequirements.push({ targetId: data.targetId as PlayerId, suit: judged.suit })
  }
  h.resumeCardTarget()
})

// 界赵云【涯角】：回合外使用/打出手牌后展示牌堆顶牌并交给任意角色，类别不同时弃一张牌。
registerSkillRuntime({ id: YAJIAO,
  triggers: [
    { event: 'CardUsed', handle(h, ownerId, context) {
      const p = context.event.payload as any
      if (p.playerId === ownerId || context.event.sourceId !== ownerId || p.fromKind !== 'hand' || !p.cardId || h.state.currentPlayerId === ownerId) return
      h.queueSkill({ skillId: YAJIAO, ownerId, step: 'reveal', data: { cardId: p.cardId } })
    } },
    { event: 'CardResponded', handle(h, ownerId, context) {
      const p = context.event.payload as any
      if (p.playerId !== ownerId || p.fromKind !== 'hand' || !p.cardId || h.state.currentPlayerId === ownerId) return
      h.queueSkill({ skillId: YAJIAO, ownerId, step: 'reveal', data: { cardId: p.cardId } })
    } },
  ],
  startQueued(h, ownerId, prompt) {
    if (prompt.step !== 'reveal' || !pof(h.state, ownerId)?.alive) return
    if (!h.state.zones.drawPile.length) reshuffleDrawPile(h.state, h.rng, (name, payload) => h.dispatch(name, payload))
    const topId = h.state.zones.drawPile[0]
    if (!topId) return
    const top = h.state.cards[topId]
    moveCard(h.state, topId, { kind: 'drawPile' }, { kind: 'processingArea' })
    const cardId = prompt.data.cardId as CardId
    h.dispatch('CardMove', { playerId: ownerId, cardIds: [topId], reason: YAJIAO, revealed: true, revealedCardName: top.name }, { sourceId: ownerId, cardIds: [topId] })
    askTargets(h, YAJIAO, ownerId, 'recipient', alive(h.state).map(p => p.id), `【涯角】：展示牌堆顶【${top.name}】，选择一名角色获得此牌`, {
      cardId, cardCategory: h.state.cards[cardId]?.category ?? null, topId, topCategory: top.category,
    })
  },
  resume(h, ownerId, resolution, response) {
    const data = resolution.data as any
    if (resolution.step === 'recipient') {
      const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
      const topId = data.topId as CardId
      if (!topId || !h.state.zones.processingArea.includes(topId)) return
      if (!targetId || !pof(h.state, targetId)?.alive) {
        if (pof(h.state, ownerId)?.alive) askTargets(h, YAJIAO, ownerId, 'recipient', alive(h.state).map(p => p.id), '【涯角】：选择一名角色获得展示牌', data)
        else moveCard(h.state, topId, { kind: 'processingArea' }, { kind: 'discardPile' })
        return
      }
      moveCard(h.state, topId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
      h.dispatch('GainCard', { playerId: targetId, cardIds: [topId], reason: YAJIAO, revealed: true }, { sourceId: ownerId, targetId, cardIds: [topId] })
      if (data.cardCategory !== data.topCategory) {
        const discardables = yajiaoOwnedCards(h, ownerId)
        if (discardables.length && pof(h.state, ownerId)?.alive) askCards(h, YAJIAO, ownerId, 'discard', discardables, '【涯角】：两张牌类别不同，弃置一张牌')
      }
      return
    }
    if (resolution.step === 'discard') {
      const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
      if (cardId) discardOwnedCard(h, ownerId, cardId)
    }
  },
})

// 界张飞【替身】：结束出牌阶段后弃置锦囊与坐骑；至下回合开始前，收回未对你造成伤害的实体【杀】。
registerSkillRuntime({ id: TISHEN,
  triggers: [
    { event: 'PhaseEnd', handle(h, ownerId, context) {
      const p = context.event.payload as any
      if (p.playerId === ownerId && p.phase === 'play' && pof(h.state, ownerId)?.alive) h.queueSkill({ skillId: TISHEN, ownerId, step: 'invoke', data: {} })
    } },
    { event: 'CardUsed', handle(h, ownerId, context) {
      if (!get(st(h), `${TISHEN}:${ownerId}:active`)) return
      const p = context.event.payload as any
      const cardId = p.cardId as CardId | undefined
      if (context.event.sourceId !== ownerId && p.cardName === '杀' && !p.virtual && cardId && (p.targetIds ?? []).includes(ownerId)) {
        const watched = get(st(h), `${TISHEN}:${ownerId}:watched`) as Record<string, boolean> ?? {}
        watched[cardId] = false
        put(h, `${TISHEN}:${ownerId}:watched`, watched)
      }
    } },
    { event: 'DamageSettled', handle(h, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const p = context.event.payload as any
      if (!(Number(p.finalAmount) > 0) || !p.cardId) return
      const watched = get(st(h), `${TISHEN}:${ownerId}:watched`) as Record<string, boolean> | undefined
      if (watched && Object.prototype.hasOwnProperty.call(watched, p.cardId)) watched[p.cardId] = true
    } },
    { event: 'CardResolved', handle(h, ownerId, context) {
      const p = context.event.payload as any
      const watched = get(st(h), `${TISHEN}:${ownerId}:watched`) as Record<string, boolean> | undefined
      const cardId = p.cardId as CardId | undefined
      if (!watched || !cardId || !Object.prototype.hasOwnProperty.call(watched, cardId)) return
      const damaged = watched[cardId]
      delete watched[cardId]
      if (damaged || !pof(h.state, ownerId)?.alive || !h.state.zones.discardPile.includes(cardId)) return
      moveCard(h.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      h.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: TISHEN }, { sourceId: context.event.sourceId, targetId: ownerId, cardIds: [cardId] })
    } },
    { event: 'TurnStart', handle(h, ownerId, context) {
      const p = context.event.payload as any
      if (p.playerId !== ownerId) return
      put(h, `${TISHEN}:${ownerId}:active`, false)
      put(h, `${TISHEN}:${ownerId}:watched`, {})
    } },
  ],
  startQueued(h, ownerId, prompt) {
    if (prompt.step === 'invoke' && pof(h.state, ownerId)?.alive) askOption(h, TISHEN, ownerId, 'discard', '【替身】：弃置所有手牌与装备区里的锦囊牌和坐骑牌，并在下回合开始前获得未对你造成伤害的【杀】？', [{ id: 'yes', label: '发动【替身】' }, { id: 'no', label: '不发动' }])
  },
  resume(h, ownerId, resolution, response) {
    if (resolution.step !== 'discard' || (response.payload as any).optionId !== 'yes' || !pof(h.state, ownerId)?.alive) return
    put(h, `${TISHEN}:${ownerId}:active`, true)
    put(h, `${TISHEN}:${ownerId}:watched`, {})
    const discardIds = yajiaoOwnedCards(h, ownerId).filter(cardId => {
      const card = h.state.cards[cardId]
      return card?.category === 'trick' || card?.equipmentSlot === 'offensiveHorse' || card?.equipmentSlot === 'defensiveHorse'
    })
    for (const cardId of discardIds) discardOwnedCard(h, ownerId, cardId)
  },
})

export const JIE_FA_ZHENG_B38: CharacterDefinition = { id: 'jie-fazheng-b38', name: '界·法正', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: ENYUAN, name: '恩怨', description: '当你获得一名其他角色两张或更多的牌后，你可以令其摸一张牌；当你受到1点伤害后，你可以令伤害来源选择一项：将一张手牌交给你，或失去1点体力。' },
  { id: 'xuanhuo', name: '眩惑', description: '摸牌阶段，你可以改为令一名其他角色摸两张牌，然后除非该角色对其攻击范围内你选择的另一名角色使用一张【杀】，否则你获得其两张牌。' },
] }
export const JIE_WANG_YI_B38: CharacterDefinition = { id: 'jie-wangyi-b38', name: '界·王异', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
  { id: 'zhenlie', name: '贞烈', description: '当你成为其他角色使用【杀】或普通锦囊牌的目标后，你可以失去1点体力。若如此做，此牌对你无效，然后你弃置其一张牌。' },
  { id: 'miji', name: '秘计', description: '结束阶段，你可以摸至多X张牌（X为你已损失的体力值），然后你可以将等量的手牌交给其他角色。' },
] }
export const JIE_GUANXING_ZHANGBAO_B38: CharacterDefinition = { id: 'jie-guanxingzhangbao-b38', name: '界·关兴张苞', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: 'fuhun', name: '父魂', description: '你可以将两张手牌当普通【杀】使用或打出；当你于出牌阶段内以此法使用的【杀】造成伤害后，你获得技能【武圣】和【咆哮】，直到回合结束。' },
] }
export const JIE_ZHOUTAI_B38: CharacterDefinition = { id: 'jie-zhoutai-b38', name: '界·周泰', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: BUQU, name: '不屈', locked: true, description: '锁定技，当你处于濒死状态时，你将牌堆顶的一张牌置于武将牌上，称为“创”。若此牌点数与已有“创”点数均不同，则你将体力回复至1点；若点数重复，则将此牌置入弃牌堆。若你有“创”，手牌上限为“创”的数量。' },
  { id: FENJI, name: '奋激', description: '一名角色的回合结束时，若其没有手牌，你可以令其摸两张牌，然后你失去1点体力。' },
] }
export const JIE_YUJI_B38: CharacterDefinition = { id: JIE_YUJI, name: '界·于吉', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: 'guhuo', name: '蛊惑', description: '每名角色的回合限一次，你可以扣置一张手牌当任意一张基本牌或普通锦囊牌使用或打出。此时，一旦有其他角色质疑则翻开此牌：若为假则此牌作废，若为真则质疑角色获得技能【缠怨】。' },
  { id: CHANYUAN, name: '缠怨', granted: true, locked: true, description: '锁定技，你不能质疑【蛊惑】；若你的体力值为1，则你的其他技能失效。' },
] }
export const JIE_ZHANGJIAO_B38: CharacterDefinition = { id: 'jie-zhangjiao-b38', name: '界·张角', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: LEIJI, name: '雷击', description: '每当你使用或打出【闪】时，你可以令一名其他角色进行判定：若为黑桃，你对其造成2点雷电伤害；若为梅花，你回复1点体力，然后对其造成1点雷电伤害。' },
  { id: 'guidao', name: '鬼道', description: '一名角色的判定牌生效前，你可以打出一张黑色牌替换之。' },
  { id: 'huangtian', name: '黄天', locked: true, description: '主公技，其他群势力角色的出牌阶段限一次，该角色可以将一张【闪】或【闪电】交给你。' },
] }
export const JIE_LIUBEI_B38: CharacterDefinition = { id: 'jie-liubei-b38', name: '界·刘备', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: RENDE, name: '仁德', description: '出牌阶段，你可以将任意张手牌交给一名本阶段未获得过“仁德”牌的其他角色。当你于本阶段给出第二张“仁德”牌时，你可以视为使用一张基本牌。' },
  { id: 'jijiang', name: '激将', description: '主公技，当你需要使用或打出【杀】时，你可以令其他蜀势力角色选择是否替你打出一张【杀】（视为由你使用或打出）。' },
] }
export const JIE_ZHANGFEI_B38: CharacterDefinition = { id: 'jie-zhangfei-b38', name: '界·张飞', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: PAOXIAO, name: '咆哮', locked: true, description: '锁定技，你使用【杀】无次数限制。你的出牌阶段，若你于当前阶段内使用过【杀】，你于此阶段使用【杀】无距离限制。' },
  { id: TISHEN, name: '替身', description: '出牌阶段结束时，你可以弃置所有手牌和装备区里的锦囊牌与坐骑牌。然后直到你的下回合开始，获得所有以你为目标且未对你造成伤害的【杀】。' },
] }
export const JIE_ZHAOYUN_B38: CharacterDefinition = { id: 'jie-zhaoyun-b38', name: '界·赵云', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: 'longdan', name: '龙胆', description: '你可以将一张【杀】当【闪】、【闪】当【杀】使用或打出。' },
  { id: YAJIAO, name: '涯角', description: '当你于回合外使用或打出手牌时，你可以展示牌堆顶一张牌并将其交给任意一名角色。若这两张牌类别不同，你弃置一张牌。' },
] }
export const JIE_MACHAO_B38: CharacterDefinition = { id: 'jie-machao-b38', name: '界·马超', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离-1。' },
  { id: TIEQI, name: '铁骑', description: '当你使用【杀】指定一个目标后，你可以令其本回合内非锁定技失效，然后你进行判定，除非该角色弃置一张与判定结果花色相同的牌，否则不能使用【闪】响应此【杀】。' },
] }

export const HISTORICAL_BATCH36_CHARACTERS: readonly CharacterDefinition[] = [
  JIE_FA_ZHENG_B38, JIE_WANG_YI_B38, JIE_GUANXING_ZHANGBAO_B38, JIE_ZHOUTAI_B38,
  JIE_YUJI_B38, JIE_ZHANGJIAO_B38, JIE_LIUBEI_B38, JIE_ZHANGFEI_B38, JIE_ZHAOYUN_B38, JIE_MACHAO_B38,
]

// 界法正【恩怨】：受伤后是否启动由法正选，交牌/失去体力由伤害来源选。
registerSkillRuntime({ id: ENYUAN, triggers: [
  { event: 'GainCard', handle(h, ownerId, context) {
    const p = context.event.payload as any
    if (p.playerId !== ownerId) return
    for (const [sourceId, count] of gainOriginCounts(h.state, ownerId, p.cardIds ?? [])) {
      if (count < 2 || !pof(h.state, sourceId)?.alive) continue
      h.queueSkill({ skillId: ENYUAN, ownerId, step: 'gift-draw', data: { sourceId } })
    }
  } },
  { event: 'Damaged', handle(h, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const sourceId = context.event.sourceId as PlayerId | undefined
    if (!sourceId || sourceId === ownerId) return
    const amount = damagePointsOf((context.event.payload as any).amount)
    if (amount) queueDamagePoint(h, { skillId: ENYUAN, ownerId, step: 'yuan-offer', remaining: amount, data: { sourceId } })
  } },
], startQueued(h, ownerId, prompt) {
  if (prompt.step === 'gift-draw') {
    const sourceId = prompt.data.sourceId as PlayerId
    if (pof(h.state, ownerId)?.alive && pof(h.state, sourceId)?.alive) askOption(h, ENYUAN, ownerId, 'gift-draw', '【恩怨】：可以令给你两张或更多牌的角色摸一张牌', [{ id: 'yes', label: '令其摸一张' }, { id: 'no', label: '不发动' }], prompt.data)
    return
  }
  if (prompt.step === 'yuan-offer') askOption(h, ENYUAN, ownerId, 'yuan-offer', '【恩怨】：是否令伤害来源选择交给你一张手牌或失去1点体力？', [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
}, resume(h, ownerId, resolution, response) {
  const data = resolution.data as any
  if (resolution.step === 'gift-draw') {
    const sourceId = data.sourceId as PlayerId
    if ((response.payload as any).optionId === 'yes' && pof(h.state, sourceId)?.alive) draw(h, sourceId, 1)
    return
  }
  const continuePoints = () => queueDamagePoint(h, { skillId: ENYUAN, ownerId, step: 'yuan-offer', remaining: Number(data.remaining ?? 1) - 1, data: { sourceId: data.sourceId } })
  if (resolution.step === 'yuan-offer') {
    if ((response.payload as any).optionId !== 'yes') { continuePoints(); return }
    const sourceId = data.sourceId as PlayerId
    if (!pof(h.state, sourceId)?.alive) { continuePoints(); return }
    const options = [{ id: 'lose', label: '失去1点体力' }]
    if (hand(h.state, sourceId).length) options.unshift({ id: 'give', label: `交给${pof(h.state, ownerId)?.nickname ?? '法正'}一张手牌` })
    h.askSkill({ skillId: ENYUAN, ownerId, step: 'yuan-choice', data, build: id => ({ id, kind: 'choose-option', playerId: sourceId, prompt: '【恩怨】：选择一项', timeoutMs: 25_000, optional: false, options }) })
    return
  }
  if (resolution.step === 'yuan-choice') {
    const sourceId = data.sourceId as PlayerId
    if ((response.payload as any).optionId === 'give' && hand(h.state, sourceId).length) { askCards(h, ENYUAN, ownerId, 'yuan-card', hand(h.state, sourceId), '【恩怨】：选择交给法正的一张手牌', data); return }
    if (pof(h.state, sourceId)?.alive) loseHp(h as never, sourceId, 1, ENYUAN)
    continuePoints(); return
  }
  if (resolution.step === 'yuan-card') {
    const sourceId = data.sourceId as PlayerId
    const cardId = (response.payload as any).cardIds?.[0] as CardId | undefined
    if (cardId && hand(h.state, sourceId).includes(cardId)) giveCards(h as never, sourceId, ownerId, [cardId], ENYUAN)
    else if (pof(h.state, sourceId)?.alive) loseHp(h as never, sourceId, 1, ENYUAN)
    continuePoints()
  }
} })

// 界周泰【奋激】：任何角色的回合结束且其无手牌时，周泰可失去体力令其摸二张。
registerSkillRuntime({ id: FENJI, triggers: [{ event: 'TurnEnd', handle(h, ownerId, context) {
  const targetId = (context.event.payload as any).playerId as PlayerId
  if (pof(h.state, targetId)?.alive && hand(h.state, targetId).length === 0 && pof(h.state, ownerId)?.alive) h.queueSkill({ skillId: FENJI, ownerId, step: 'invoke', data: { targetId } })
} }], startQueued(h, ownerId, prompt) {
  const targetId = prompt.data.targetId as PlayerId
  if (prompt.step === 'invoke' && pof(h.state, targetId)?.alive && hand(h.state, targetId).length === 0) askOption(h, FENJI, ownerId, 'resolve', `【奋激】：失去1点体力令${pof(h.state, targetId)?.nickname ?? '其'}摸两张牌？`, [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }], prompt.data)
}, resume(h, ownerId, resolution, response) {
  if (resolution.step !== 'resolve' || (response.payload as any).optionId !== 'yes') return
  const targetId = (resolution.data as any).targetId as PlayerId
  if (!pof(h.state, ownerId)?.alive || !pof(h.state, targetId)?.alive || hand(h.state, targetId).length) return
  draw(h, targetId, 2)
  if (pof(h.state, ownerId)?.alive) loseHp(h as never, ownerId, 1, FENJI)
} })

// 界张角【雷击】：梅花分支同时回复自身并造成一点雷电伤害。
const LEIJI_TAG = 'leiji-jie-b38'
registerSkillRuntime({ id: LEIJI, triggers: [{ event: 'CardResponded', handle(h, ownerId, context) {
  const p = context.event.payload as any
  if (p.playerId === ownerId && p.cardName === '闪' && pof(h.state, ownerId)?.alive) h.queueSkill({ skillId: LEIJI, ownerId, step: 'ask', data: {} })
} }], startQueued(h, ownerId, prompt) {
  if (prompt.step === 'ask') askOption(h, LEIJI, ownerId, 'invoke', '是否发动【雷击】令一名角色判定？', [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }])
}, resume(h, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as any).optionId !== 'yes') return
    const targets = others(h.state, ownerId).map(p => p.id)
    if (targets.length) askTargets(h, LEIJI, ownerId, 'target', targets, '【雷击】：选择一名角色进行判定')
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as any).targetIds?.[0] as PlayerId | undefined
    if (targetId && pof(h.state, targetId)?.alive) performJudgment(h as never, targetId, '雷击', { tag: LEIJI_TAG, data: { ownerId, targetId } })
  }
} })

registerJudgmentContinuation(LEIJI_TAG, (h, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const targetId = data.targetId as PlayerId
  if (!pof(h.state, ownerId)?.alive || !pof(h.state, targetId)?.alive) return
  if (judged.suit === 'spade') resolveDamage(h as never, { sourceId: ownerId, targetId, amount: 2, nature: 'thunder', cardName: '雷击' })
  else if (judged.suit === 'club') {
    const owner = pof(h.state, ownerId)!
    if (owner.hp < owner.maxHp) recover(h as never, ownerId, 1, ownerId)
    if (pof(h.state, targetId)?.alive) resolveDamage(h as never, { sourceId: ownerId, targetId, amount: 1, nature: 'thunder', cardName: '雷击' })
  }
})
