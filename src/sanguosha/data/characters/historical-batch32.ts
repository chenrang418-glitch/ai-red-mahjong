// 武将册续开发第34批：仅登记完整实现的当前选定规则版本。
// 立绘、语音沿用通用 fallback 接口。
// @ts-nocheck
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { continueDyingAssists, resolveDamage, resumeTargetDamagePrevention } from '../../engine/damage'
import { executeUseCardAction } from '../../engine/cards/basic'
import { beginVirtualSlash } from '../../engine/cards/basic'
import { instantTrickActions } from '../../engine/cards/tricks'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { getDistance, getAttackRange } from '../../engine/distance'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { effectiveCardSuit, isTargetProhibited, registerSkillRuntime, skillsOf, type SkillHost } from '../../engine/skills/runtime'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { setChained } from '../../engine/character-state'
import { swapHands } from '../../engine/hand-transfer'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { effectiveCardName } from '../../engine/zones'
import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { handleEquipmentLost } from '../../engine/equipment'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { skillIdsOf } from './standard'

type B34 = SanguoshaState & { b34?: Record<string, any> }
const st = (s: SanguoshaState) => s as B34
const player = (s: SanguoshaState, id: PlayerId) => s.players.find(x => x.id === id)
const aliveOthers = (s: SanguoshaState, id: PlayerId) => s.players.filter(x => x.alive && x.id !== id)
const hand = (s: SanguoshaState, id: PlayerId) => player(s, id)?.zones.hand ?? []
const owned = (s: SanguoshaState, id: PlayerId) => [...hand(s, id), ...Object.values(player(s, id)?.zones.equipment ?? {}).filter(Boolean)]
const get = (s: SanguoshaState, key: string) => st(s).b34?.[key]
const set = (s: SanguoshaState, key: string, value: any) => { st(s).b34 ??= {}; st(s).b34[key] = value; return value }
const handSize = (s: SanguoshaState, id: PlayerId) => hand(s, id).length
const isHurt = (s: SanguoshaState, id: PlayerId) => (player(s, id)?.hp ?? 0) < (player(s, id)?.maxHp ?? 0)

function askOption(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, step: string, prompt: string, options: Array<{ id: string; label: string }>, data: any = {}, optional = true) {
  h.askSkill({ skillId, ownerId, step, data, build: requestId => ({ id: requestId, kind: 'choose-option', playerId, prompt, timeoutMs: 20_000, optional, options }) })
}
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, ids: PlayerId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1, step = 'target') {
  h.askSkill({ skillId, ownerId, step, data, build: requestId => ({ id: requestId, kind: 'choose-targets', playerId, prompt, timeoutMs: 20_000, optional, candidateIds: ids, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, ids: CardId[], prompt: string, min: number, max: number, data: any = {}, optional = false) {
  h.askSkill({ skillId, ownerId, step: 'cards', data, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId, prompt, timeoutMs: 20_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}
function discard(h: SkillHost, ownerId: PlayerId, ids: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(ids)]) {
    const from = locateOwnedCard(h.state, ownerId, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'discardPile' })
    moved.push(cardId)
  }
  if (moved.length) h.dispatch('LoseCard', { playerId: ownerId, cardIds: moved, reason }, { sourceId: ownerId, cardIds: moved })
  return moved
}
function gain(h: SkillHost, ownerId: PlayerId, cardIds: CardId[], from: any, reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(cardIds)]) {
    if (!h.state.cards[cardId]) continue
    const actual = locateOwnedCard(h.state, from.playerId, cardId)
    if (!actual || actual.kind !== from.kind || (from.kind === 'hand' && !hand(h.state, from.playerId).includes(cardId))) continue
    moveCard(h.state, cardId, actual, { kind: 'hand', playerId: ownerId })
    moved.push(cardId)
  }
  if (moved.length) h.dispatch('GainCard', { playerId: ownerId, cardIds: moved, reason }, { targetId: ownerId, cardIds: moved })
  return moved
}
function askFieldCard(h: SkillHost, skillId: string, ownerId: PlayerId, targetId: PlayerId, step: string, prompt: string, includeJudgingArea = false, data: any = {}, optional = true): boolean {
  const choices = pickableCardsOf(h.state, targetId, { includeJudgingArea })
  if (!choices.cardIds.length && !choices.hiddenCardSlots.length) return false
  h.askSkill({ skillId, ownerId, step, data: { ...data, targetId }, build: requestId => ({
    id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 20_000, optional,
    purpose: 'skill', cardIds: choices.cardIds, hiddenCardSlots: choices.hiddenCardSlots, min: 1, max: 1,
  }) })
  return true
}
function discardPickedFieldCard(h: SkillHost, targetId: PlayerId, picked: string, reason: string): CardId | null {
  const cardId = resolvePickedCard(h.state, targetId, picked)
  if (!cardId) return null
  const from = locateOwnedCard(h.state, targetId, cardId)
  if (!from) return null
  moveCard(h.state, cardId, from, { kind: 'discardPile' })
  if (from.kind === 'equipment') handleEquipmentLost(h as never, targetId, cardId)
  h.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason }, { sourceId: targetId, cardIds: [cardId] })
  return cardId
}
function virtualDuel(h: SkillHost, sourceId: PlayerId, targetId: PlayerId, skillId: string) {
  const cardId = createVirtualTrick(h.state, sourceId, '决斗', skillId)
  executeUseCardAction(h as never, sourceId, { id: `${skillId}:${cardId}`, kind: 'use-card', playerId: sourceId, label: `【${skillId}】视为使用【决斗】`, cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1, asCardName: '决斗' } as never, { skipPlayInterceptors: true })
}

const WUKE_ANDA = 'anda-b34'
const WUKE_ZHUGUO = 'zhuguo-b34'
registerSkillRuntime({
  id: WUKE_ANDA,
  dyingAssist(h, ownerId, dyingPlayerId, sourceId) {
    const usedRound = get(h.state, `${WUKE_ANDA}:round:${ownerId}`)
    if (usedRound === h.state.roundNumber) return false
    askOption(h, WUKE_ANDA, ownerId, ownerId, 'offer', '【谙达】：是否令伤害来源交给濒死角色两张颜色不同的牌？否则其回复1点体力。', [
      { id: 'yes', label: '发动谙达' }, { id: 'no', label: '不发动' },
    ], { dyingPlayerId, sourceId })
    return 'pending'
  },
  resume(h, ownerId, r, res) {
    if (r.step === 'offer') {
      if (res.payload.optionId !== 'yes') { continueDyingAssists(h as never); return }
      set(h.state, `${WUKE_ANDA}:round:${ownerId}`, h.state.roundNumber)
      const dyingPlayerId = r.data.dyingPlayerId as PlayerId
      const sourceId = r.data.sourceId as PlayerId | null
      if (!sourceId || !player(h.state, sourceId)?.alive || hand(h.state, sourceId).length < 2) {
        if (player(h.state, dyingPlayerId)?.alive) recover(h, dyingPlayerId, 1, ownerId)
        continueDyingAssists(h as never)
        return
      }
      askCards(h, WUKE_ANDA, ownerId, sourceId, hand(h.state, sourceId), '【谙达】：交给濒死角色两张颜色不同的手牌；若未交付，则其回复1点体力。', 2, 2, { dyingPlayerId, sourceId })
      return
    }
    if (r.step !== 'cards') return
    const dyingPlayerId = r.data.dyingPlayerId as PlayerId
    const sourceId = r.data.sourceId as PlayerId
    const ids = (res.payload.cardIds ?? []).filter((id: CardId) => hand(h.state, sourceId).includes(id)) as CardId[]
    const colors = ids.map(id => h.state.cards[id]?.color)
    const differentColors = ids.length === 2 && colors.every(Boolean) && colors[0] !== colors[1]
    const given = differentColors ? giveCards(h, sourceId, dyingPlayerId, ids, WUKE_ANDA) : []
    if (!given.length && player(h.state, dyingPlayerId)?.alive) recover(h, dyingPlayerId, 1, ownerId)
    continueDyingAssists(h as never)
  },
})

registerSkillRuntime({
  id: WUKE_ZHUGUO,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, WUKE_ZHUGUO)
      ? [{ id: WUKE_ZHUGUO, label: '助国：令一名角色调整手牌' }]
      : []
  },
  invokeActive(h, id) {
    askTargets(h, WUKE_ZHUGUO, id, id, h.state.players.filter(x => x.alive).map(x => x.id), '【助国】：选择一名角色')
  },
  resume(h, ownerId, r, res) {
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      const target = targetId && player(h.state, targetId)
      if (!target?.alive) return
      markUsedThisPhase(h.state, ownerId, WUKE_ZHUGUO)
      const targetHand = Math.min(target.maxHp, 5)
      const before = hand(h.state, targetId).length
      if (before < targetHand) {
        drawCards(h.state, h.rng, targetId, targetHand - before, (name, payload) => h.dispatch(name, payload))
        const drew = hand(h.state, targetId).length > before
        const maximum = Math.max(...h.state.players.filter(x => x.alive).map(x => hand(h.state, x.id).length))
        if (drew && hand(h.state, targetId).length === maximum) {
          const candidates = aliveOthers(h.state, targetId).map(x => x.id)
          if (candidates.length) {
            askOption(h, WUKE_ZHUGUO, ownerId, ownerId, 'choose-slash-target', '【助国】：选择一名角色，令其选择是否对该角色使用无距离、次数限制的【杀】', [
              { id: 'choose', label: '指定目标' },
            ], { beneficiaryId: targetId, candidateIds: candidates }, false)
            return
          }
        }
        if (!drew && isHurt(h.state, targetId)) recover(h, targetId, 1, ownerId)
        return
      }
      if (before > targetHand) {
        askCards(h, WUKE_ZHUGUO, ownerId, targetId, hand(h.state, targetId), '【助国】：弃置手牌至体力上限', 1, before - targetHand, { targetId, discardCount: before - targetHand })
        return
      }
      if (isHurt(h.state, targetId)) recover(h, targetId, 1, ownerId)
      return
    }
    if (r.step === 'cards') {
      const targetId = r.data.targetId as PlayerId
      const ids = (res.payload.cardIds ?? []).filter((cardId: CardId) => hand(h.state, targetId).includes(cardId)).slice(0, r.data.discardCount)
      discard(h, targetId, ids, WUKE_ZHUGUO)
      if (isHurt(h.state, targetId)) recover(h, targetId, 1, ownerId)
      return
    }
    if (r.step === 'choose-slash-target') {
      const candidates = (r.data.candidateIds as PlayerId[]).filter(id => player(h.state, id)?.alive && id !== r.data.beneficiaryId)
      if (candidates.length) askTargets(h, WUKE_ZHUGUO, ownerId, ownerId, candidates, '【助国】：选择【杀】的目标', { beneficiaryId: r.data.beneficiaryId }, false, 1, 1, 'slash-target')
      return
    }
    if (r.step === 'slash-target') {
      const beneficiaryId = r.data.beneficiaryId as PlayerId
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      if (!targetId || !player(h.state, beneficiaryId)?.alive || !player(h.state, targetId)?.alive) return
      askOption(h, WUKE_ZHUGUO, ownerId, beneficiaryId, 'use-slash', '【助国】：是否对指定角色使用一张无距离、次数限制的【杀】？', [
        { id: 'yes', label: '使用【杀】' }, { id: 'no', label: '不使用' },
      ], { targetId, beneficiaryId })
      return
    }
    if (r.step === 'use-slash' && res.payload.optionId === 'yes') {
      const beneficiaryId = r.data.beneficiaryId as PlayerId
      const targetId = r.data.targetId as PlayerId
      if (beneficiaryId && player(h.state, beneficiaryId)?.alive && player(h.state, targetId)?.alive) {
        h.beginVirtualSlash({ sourceId: beneficiaryId, targetId, sourceSkillId: WUKE_ZHUGUO })
      }
    }
  },
})

export const WUKE_B34: CharacterDefinition = {
  id: 'wuke', name: '吴珂', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [{ id: WUKE_ANDA, name: '谙达', description: '每轮限一次，当一名角色进入濒死状态时，你可以令伤害来源交给其两张颜色不同的牌，否则其回复1点体力。' }, { id: WUKE_ZHUGUO, name: '助国', description: '出牌阶段限一次，你可以令一名角色将手牌调整至其体力上限（至多5张）；若其因此没有摸牌，其回复1点体力；若其因此摸牌且手牌数全场最多，你可以令其选择是否对你指定的另一名角色使用一张不计次数且无距离限制的【杀】。' }],
}

const LIUZHANG_JUTU = 'jutu-b34'
const LIUZHANG_YAOHU = 'yaohu-b34'
const LIUZHANG_HUAIBI = 'huaibi-b34'
const LIUZHANG_FACTIONS = ['wei', 'shu', 'wu', 'qun', 'jin', 'god']
const LIUZHANG_DAMAGE_CARDS = new Set(['杀', '决斗', '南蛮入侵', '万箭齐发', '火攻', '闪电'])

function liuzhangSheng(s: SanguoshaState, id: PlayerId): CardId[] {
  return player(s, id)?.characterPiles?.sheng ?? []
}
function countSelectedFaction(s: SanguoshaState, id: PlayerId): number {
  const faction = get(s, `${LIUZHANG_YAOHU}:faction:${id}`)
  return faction ? s.players.filter(x => x.alive && x.id !== id && effectiveKingdomOf(s, x.id) === faction).length : 0
}
function settleTargetCancellation(h: SkillHost, ownerId: PlayerId, context: any) {
  const resolution = h.state.cardResolution as any
  if (!resolution || resolution.cardId !== context.cardId) return
  if (resolution.kind === 'slash') resolution.targetCancelled = true
  else if (!resolution.cancelledTargetIds.includes(ownerId)) resolution.cancelledTargetIds.push(ownerId)
}

registerSkillRuntime({
  id: LIUZHANG_JUTU,
  triggers: [{
    event: 'PhaseStart',
    handle(h, id, context) {
      const d = context.event.payload as any
      const owner = player(h.state, id)
      if (!owner?.alive) return
      if (d.playerId === id && d.phase === 'prepare') {
        const x = countSelectedFaction(h.state, id)
        const pile = liuzhangSheng(h.state, id)
        for (const cardId of [...pile]) {
          moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: 'sheng' }, { kind: 'hand', playerId: id })
        }
        if (pile.length) h.dispatch('GainCard', { playerId: id, cardIds: pile, reason: LIUZHANG_JUTU }, { targetId: id, cardIds: pile })
        drawCards(h.state, h.rng, id, x + 1, (name, payload) => h.dispatch(name, payload))
        const choices = hand(h.state, id).slice(0, x)
        if (choices.length) askCards(h, LIUZHANG_JUTU, id, id, hand(h.state, id), `【据土】：将${x}张手牌置为“生”`, choices.length, choices.length, { pileCount: x })
        return
      }
      if (d.phase !== 'play' || d.playerId === id) return
      const selectedFaction = get(h.state, `${LIUZHANG_YAOHU}:faction:${id}`)
      const active = player(h.state, d.playerId)
      if (!selectedFaction || effectiveKingdomOf(h.state, d.playerId) !== selectedFaction) return
      const pile = liuzhangSheng(h.state, id)
      const cardId = pile[0]
      if (cardId) {
        moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: 'sheng' }, { kind: 'hand', playerId: active.id })
        h.dispatch('GainCard', { playerId: active.id, cardIds: [cardId], reason: LIUZHANG_YAOHU }, { targetId: active.id, cardIds: [cardId] })
      }
      const slashTargets = h.state.players.filter(target => target.alive && target.id !== active.id
        && getDistance(h.state, active.id, target.id) <= getAttackRange(h.state, active.id)
        && !isTargetProhibited(h.state, active.id, target.id, '杀', skillIdsOf)).map(target => target.id)
      askOption(h, LIUZHANG_YAOHU, id, active.id, 'choice', '【邀虎】：选择一项', [
        ...(slashTargets.length ? [{ id: 'slash', label: `对${slashTargets.length}名攻击范围内角色之一使用不计次数的【杀】` }] : []),
        { id: 'protect', label: '本阶段对刘璋使用伤害牌须交给其两张牌，否则此目标无效' },
      ], { activeId: active.id, slashTargets })
    },
  }],
  resume(h, id, r, res) {
    if (r.step === 'cards') {
      const x = Math.min(r.data.pileCount, hand(h.state, id).length)
      const ids = (res.payload.cardIds ?? []).filter((cardId: CardId) => hand(h.state, id).includes(cardId)).slice(0, x)
      const owner = player(h.state, id)
      if (!owner) return
      owner.characterPiles.sheng ??= []
      for (const cardId of ids) moveCard(h.state, cardId, { kind: 'hand', playerId: id }, { kind: 'characterPile', playerId: id, pile: 'sheng' })
      if (ids.length) h.dispatch('LoseCard', { playerId: id, cardIds: ids, reason: LIUZHANG_JUTU }, { sourceId: id, cardIds: ids })
      return
    }
    if (r.step === 'choice') {
      const activeId = r.data.activeId as PlayerId
      if (res.payload.optionId === 'protect') {
        set(h.state, `${LIUZHANG_YAOHU}:protected:${activeId}`, { ownerId: id, turn: h.state.turnNumber })
        return
      }
      const candidates = (r.data.slashTargets as PlayerId[]).filter(targetId => player(h.state, targetId)?.alive)
      if (candidates.length) askTargets(h, LIUZHANG_YAOHU, id, id, candidates, '【邀虎】：选择【杀】的目标', { activeId }, false, 1, 1, 'slash-target')
      return
    }
    if (r.step === 'slash-target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      const activeId = r.data.activeId as PlayerId
      if (targetId && player(h.state, activeId)?.alive && player(h.state, targetId)?.alive) h.beginVirtualSlash({ sourceId: activeId, targetId, sourceSkillId: LIUZHANG_YAOHU })
      return
    }
  },
})

registerSkillRuntime({
  id: LIUZHANG_YAOHU,
  triggers: [{
    event: 'TurnStart',
    handle(h, id, c) {
      if (c.event.payload.playerId !== id) return
      if (get(h.state, `${LIUZHANG_YAOHU}:used-round:${id}`) === h.state.roundNumber) return
      const factions = [...new Set(h.state.players.filter(x => x.alive).map(x => x.kingdom).filter(x => LIUZHANG_FACTIONS.includes(x)))]
      if (!factions.length) return
      askOption(h, LIUZHANG_YAOHU, id, id, 'faction', '【邀虎】：选择一个势力', factions.map(faction => ({ id: faction, label: ({ wei: '魏', shu: '蜀', wu: '吴', qun: '群', jin: '晋', god: '神' } as any)[faction] })), { round: h.state.roundNumber }, false)
    },
  }],
  resume(h, id, r, res) {
    if (r.step === 'faction') {
      if (r.data.round !== h.state.roundNumber || !LIUZHANG_FACTIONS.includes(res.payload.optionId)) return
      set(h.state, `${LIUZHANG_YAOHU}:faction:${id}`, res.payload.optionId)
      set(h.state, `${LIUZHANG_YAOHU}:used-round:${id}`, h.state.roundNumber)
      return
    }
    if (r.step === 'pay-target') {
      const ids = (res.payload.cardIds ?? []).filter((cardId: CardId) => hand(h.state, r.data.sourceId).includes(cardId)).slice(0, 2)
      const paid = ids.length === 2 ? giveCards(h, r.data.sourceId, id, ids, LIUZHANG_YAOHU) : []
      if (paid.length !== 2) settleTargetCancellation(h, id, r.data.context)
      h.resumeCardTarget()
    }
    if (r.step === 'cards') {
      const sourceId = r.data.sourceId as PlayerId
      const ids = (res.payload.cardIds ?? []).filter((cardId: CardId) => hand(h.state, sourceId).includes(cardId)).slice(0, 2)
      const paid = ids.length === 2 && player(h.state, sourceId)?.alive ? giveCards(h, sourceId, id, ids, LIUZHANG_YAOHU) : []
      if (paid.length !== 2) settleTargetCancellation(h, id, r.data.context)
      h.resumeCardTarget()
    }
  },
  interceptTarget(h, id, context) {
    const active = get(h.state, `${LIUZHANG_YAOHU}:protected:${context.sourceId}`)
    if (!active || active.ownerId !== id || active.turn !== h.state.turnNumber || context.targetId !== id
      || !LIUZHANG_DAMAGE_CARDS.has(context.cardName) || !player(h.state, context.sourceId)?.alive) return false
    const sourceId = context.sourceId
    const contextData = { ...context }
    if (hand(h.state, sourceId).length < 2) {
      settleTargetCancellation(h, id, contextData)
      h.resumeCardTarget()
      return true
    }
    askCards(h, LIUZHANG_YAOHU, id, sourceId, hand(h.state, sourceId), `【邀虎】：交给刘璋两张手牌，否则此伤害牌对其无效`, 2, 2, { sourceId, context: contextData }, false)
    return true
  },
})

registerSkillRuntime({
  id: LIUZHANG_HUAIBI,
  lord: true,
  maxCardsBonus(s, id) { return countSelectedFaction(s, id) },
})

export const LIUZHANG_B34: CharacterDefinition = {
  id: 'liuzhang-yinghu', name: '刘璋', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: LIUZHANG_JUTU, name: '据土', description: '锁定技，准备阶段，获得武将牌上的“生”，摸X+1张牌并将X张手牌置为“生”（X为邀虎选择势力的存活其他角色数）。' },
    { id: LIUZHANG_YAOHU, name: '邀虎', description: '每轮限一次，回合开始选择势力；该势力其他角色出牌阶段开始时获得一张“生”，选择视为对刘璋指定的攻击范围内角色使用不计次数的【杀】，或本阶段对刘璋使用伤害牌须交给刘璋两张手牌，否则此目标无效。' },
    { id: LIUZHANG_HUAIBI, name: '怀璧', description: '主公技，锁定技，手牌上限增加“邀虎”选择势力的其他存活角色数。' },
  ],
}

const SIMAZHAO_DAIGONG = 'daigong-sp-b34'
const SIMAZHAO_ZHAOXIN = 'zhaoxin-sp-b34'

function absentSuitCards(s: SanguoshaState, sourceId: PlayerId, ownerId: PlayerId): CardId[] {
  const heldSuits = new Set(hand(s, ownerId).map(cardId => effectiveCardSuit(s, ownerId, cardId)).filter(Boolean))
  return hand(s, sourceId).filter(cardId => {
    const suit = effectiveCardSuit(s, sourceId, cardId)
    return Boolean(suit) && !heldSuits.has(suit)
  })
}

registerSkillRuntime({
  id: SIMAZHAO_DAIGONG,
  offersTargetDamagePreventionAsk(h, ownerId, context) {
    const sourceId = context.sourceId
    if (!sourceId || !player(h.state, ownerId)?.alive || !player(h.state, sourceId)?.alive || usedThisTurn(h.state, ownerId, SIMAZHAO_DAIGONG)) return false
    markUsedThisTurn(h.state, ownerId, SIMAZHAO_DAIGONG)
    h.dispatch('CardMove', { cardIds: [...hand(h.state, ownerId)], reason: SIMAZHAO_DAIGONG, revealed: true }, { sourceId: ownerId, targetId: sourceId, cardIds: [...hand(h.state, ownerId)] })
    const options = [{ id: 'prevent', label: '防止此伤害' }]
    if (absentSuitCards(h.state, sourceId, ownerId).length) options.unshift({ id: 'give', label: '交给其一张其手牌中没有花色的牌' })
    askOption(h, SIMAZHAO_DAIGONG, ownerId, sourceId, 'choice', '【怠攻】：司马昭展示了所有手牌，请选择', options, { sourceId }, false)
    return true
  },
  resume(h, ownerId, r, res) {
    if (r.step === 'choice') {
      const sourceId = r.data.sourceId as PlayerId
      if (!player(h.state, sourceId)?.alive || !player(h.state, ownerId)?.alive) { resumeTargetDamagePrevention(h as never, false); return }
      if (res.payload.optionId === 'prevent') { resumeTargetDamagePrevention(h as never, true, SIMAZHAO_DAIGONG); return }
      const candidates = absentSuitCards(h.state, sourceId, ownerId)
      if (!candidates.length) { resumeTargetDamagePrevention(h as never, false); return }
      askCards(h, SIMAZHAO_DAIGONG, ownerId, sourceId, candidates, '【怠攻】：选择一张交给司马昭', 1, 1, { sourceId })
      return
    }
    if (r.step === 'cards') {
      const sourceId = r.data.sourceId as PlayerId
      const cardId = res.payload.cardIds?.[0] as CardId | undefined
      if (cardId && absentSuitCards(h.state, sourceId, ownerId).includes(cardId)) giveCards(h, sourceId, ownerId, [cardId], SIMAZHAO_DAIGONG)
      resumeTargetDamagePrevention(h as never, false)
    }
  },
})

registerSkillRuntime({
  id: SIMAZHAO_ZHAOXIN,
  activeActions(s, id) {
    const pileCount = player(s, id)?.characterPiles?.wang?.length ?? 0
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, SIMAZHAO_ZHAOXIN) && pileCount < 3 && owned(s, id).length > 0
      ? [{ id: SIMAZHAO_ZHAOXIN, label: '昭心：置牌并摸牌' }]
      : []
  },
  invokeActive(h, id) {
    const remaining = 3 - (player(h.state, id)?.characterPiles?.wang?.length ?? 0)
    askCards(h, SIMAZHAO_ZHAOXIN, id, id, owned(h.state, id), `【昭心】：将至多${remaining}张牌置为“望”`, 0, Math.min(remaining, owned(h.state, id).length), {}, true)
  },
  resume(h, id, r, res) {
    if (r.step === 'cards') {
      const cap = 3 - (player(h.state, id)?.characterPiles?.wang?.length ?? 0)
      const ids = [...new Set((res.payload.cardIds ?? []) as CardId[])].filter(cardId => owned(h.state, id).includes(cardId)).slice(0, cap)
      if (!ids.length) return
      markUsedThisPhase(h.state, id, SIMAZHAO_ZHAOXIN)
      const owner = player(h.state, id)!
      owner.characterPiles.wang ??= []
      for (const cardId of ids) {
        const from = locateOwnedCard(h.state, id, cardId)
        if (from) moveCard(h.state, cardId, from, { kind: 'characterPile', playerId: id, pile: 'wang' })
      }
      h.dispatch('LoseCard', { playerId: id, cardIds: ids, reason: SIMAZHAO_ZHAOXIN }, { sourceId: id, cardIds: ids })
      drawCards(h.state, h.rng, id, ids.length, (name, payload) => h.dispatch(name, payload))
      return
    }
    if (r.step === 'ask-wang') {
      const targetId = r.data.targetId as PlayerId
      const pile = player(h.state, id)?.characterPiles?.wang ?? []
      const cardId = pile[0]
      if (res.payload.optionId !== 'take' || !player(h.state, targetId)?.alive || !cardId) return
      moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: 'wang' }, { kind: 'hand', playerId: targetId })
      h.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: SIMAZHAO_ZHAOXIN }, { targetId, cardIds: [cardId] })
      askOption(h, SIMAZHAO_ZHAOXIN, id, id, 'damage-after-gain', '【昭心】：是否对其造成1点伤害？', [
        { id: 'yes', label: '造成1点伤害' }, { id: 'no', label: '不造成伤害' },
      ], { targetId })
      return
    }
    if (r.step === 'damage-after-gain' && res.payload.optionId === 'yes' && player(h.state, r.data.targetId)?.alive) {
      resolveDamage(h as never, { sourceId: id, targetId: r.data.targetId, amount: 1, nature: 'normal', cardName: null })
    }
  },
  triggers: [{ event: 'PhaseEnd', handle(h, id, c) {
    const d = c.event.payload as any
    if (d.phase !== 'draw' || !player(h.state, id)?.alive) return
    const range = getAttackRange(h.state, id)
    const affected = h.state.players.find(target => target.alive && target.id === d.playerId && (target.id === id || getDistance(h.state, id, target.id) <= range))
    if (affected && player(h.state, id)?.characterPiles?.wang?.length) h.queueSkill({ skillId: SIMAZHAO_ZHAOXIN, ownerId: id, step: 'offer-wang', data: { targetId: affected.id } })
  } }],
  startQueued(h, id, q) {
    if (q.step !== 'offer-wang') return
    const targetId = q.data.targetId as PlayerId
    if (!player(h.state, targetId)?.alive || !player(h.state, id)?.characterPiles?.wang?.length) return
    askOption(h, SIMAZHAO_ZHAOXIN, id, targetId, 'ask-wang', '【昭心】：是否获得一张“望”？', [
      { id: 'take', label: '获得一张“望”' }, { id: 'decline', label: '不获得' },
    ], { targetId })
  },
})

export const SIMAZHAO_SP_B34: CharacterDefinition = {
  id: 'simazhao-sp', name: 'SP·司马昭', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
  skills: [
    { id: SIMAZHAO_DAIGONG, name: '怠攻', description: '每回合限一次，当你受到伤害时，展示所有手牌，令伤害来源选择交给你一张你手牌中没有的花色的牌，或防止此伤害。' },
    { id: SIMAZHAO_ZHAOXIN, name: '昭心', description: '出牌阶段限一次，将任意张牌置为“望”（至多3张）并摸等量牌；你和攻击范围内角色摸牌阶段结束后，其可获得一张“望”，然后你可对其造成1点伤害。' },
  ],
}

const MOUYUANSHAO_LUANJI = 'luanji-mou-b34'
const MOUYUANSHAO_XUEYI = 'xueyi-mou-b34'
registerSkillRuntime({
  id: MOUYUANSHAO_LUANJI,
  activeActionUsesCard: true,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, MOUYUANSHAO_LUANJI) && hand(s, id).length >= 2
      ? [{ id: MOUYUANSHAO_LUANJI, label: '乱击：将两张手牌当【万箭齐发】使用' }]
      : []
  },
  invokeActive(h, id) {
    askCards(h, MOUYUANSHAO_LUANJI, id, id, hand(h.state, id), '【乱击】：选择两张手牌当【万箭齐发】使用', 2, 2, {}, true)
  },
  resume(h, id, r, res) {
    if (r.step !== 'cards') return
    const ids = [...new Set((res.payload.cardIds ?? []) as CardId[])]
    if (ids.length !== 2 || ids.some(cardId => !hand(h.state, id).includes(cardId))) return
    const [carrier, extra] = ids
    const [action] = instantTrickActions(h.state, id, carrier, '万箭齐发')
    if (!action || action.kind !== 'use-card') return
    markUsedThisPhase(h.state, id, MOUYUANSHAO_LUANJI)
    executeUseCardAction(h as never, id, { ...action, cardIds: [carrier, extra] })
  },
  triggers: [{ event: 'CardResponded', handle(h, id, c) {
    const current = h.state.cardResolution as any
    const d = c.event.payload as any
    if (current?.kind !== 'trick' || current.cardName !== '万箭齐发' || current.sourceId !== id || d.cardName !== '闪' || d.asking === true) return
    let record = get(h.state, `${MOUYUANSHAO_LUANJI}:response-draws:${id}`)
    if (!record || record.turn !== h.state.turnNumber) record = set(h.state, `${MOUYUANSHAO_LUANJI}:response-draws:${id}`, { turn: h.state.turnNumber, count: 0 })
    if (record.count >= 3) return
    record.count += 1
    drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
  } }],
})

function mouYuanshaoOtherQun(s: SanguoshaState, id: PlayerId): PlayerId[] {
  return s.players.filter(x => x.alive && x.id !== id && effectiveKingdomOf(s, x.id) === 'qun').map(x => x.id)
}
registerSkillRuntime({
  id: MOUYUANSHAO_XUEYI,
  lord: true,
  maxCardsBonus(s, id) { return player(s, id)?.identity === 'lord' ? mouYuanshaoOtherQun(s, id).length * 2 : 0 },
  triggers: [{ event: 'CardUsed', handle(h, id, c) {
    const d = c.event.payload as any
    const targets = mouYuanshaoOtherQun(h.state, id)
    if (c.event.sourceId !== id || !d.targetIds?.some((targetId: PlayerId) => targets.includes(targetId))) return
    let record = get(h.state, `${MOUYUANSHAO_XUEYI}:draws:${id}`)
    if (!record || record.turn !== h.state.turnNumber) record = set(h.state, `${MOUYUANSHAO_XUEYI}:draws:${id}`, { turn: h.state.turnNumber, count: 0 })
    if (record.count >= 2) return
    record.count += 1
    drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
  } }],
})

export const MOUYUANSHAO_B34: CharacterDefinition = {
  id: 'yuanshao-mou', name: '谋·袁绍', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'mou',
  skills: [
    { id: MOUYUANSHAO_LUANJI, name: '乱击', description: '出牌阶段限一次，你可以将两张手牌当【万箭齐发】使用。其他角色因响应此【万箭齐发】打出【闪】时，你摸一张牌，每回合至多因此摸三张。' },
    { id: MOUYUANSHAO_XUEYI, name: '血裔', description: '主公技，锁定技，手牌上限+X（X为其他群势力角色数的两倍）。你使用牌指定其他群势力角色为目标后摸一张牌，每回合至多两次。' },
  ],
}

const MOU_LIUCHENG_LUEYING = 'lueying-mou-b34'
const MOU_LIUCHENG_YINGWU = 'yingwu-mou-b34'
registerSkillRuntime({
  id: MOU_LIUCHENG_LUEYING,
  activeActionUsesCard: false,
  triggers: [
    { event: 'CardUsed', handle(h, id, c) {
      const d = c.event.payload as any
      if (h.state.phase !== 'play' || h.state.currentPlayerId !== id || c.event.sourceId !== id || d.cardName !== '杀' || !d.targetIds?.some((targetId: PlayerId) => targetId !== id)) return
      const count = get(h.state, `${MOU_LIUCHENG_LUEYING}:count:${id}`) ?? 0
      if (count >= 2) return
      set(h.state, `${MOU_LIUCHENG_LUEYING}:count:${id}`, count + 1)
      const marks = (player(h.state, id)!.marks['mou-liucheng-zhui'] ?? 0) + 1
      player(h.state, id)!.marks['mou-liucheng-zhui'] = marks
    } },
    { event: 'PhaseStart', handle(h, id, c) {
      if ((c.event.payload as any).playerId === id && (c.event.payload as any).phase === 'play') {
        set(h.state, `${MOU_LIUCHENG_LUEYING}:count:${id}`, 0)
        if (player(h.state, id)) player(h.state, id)!.marks['mou-liucheng-zhui'] = 0
      }
    } },
    { event: 'AfterCardUse', handle(h, id, c) {
      const d = c.event.payload as any
      if (h.state.phase !== 'play' || h.state.currentPlayerId !== id || c.event.sourceId !== id || d.cardName !== '杀' || (player(h.state, id)?.marks['mou-liucheng-zhui'] ?? 0) < 2) return
      player(h.state, id)!.marks['mou-liucheng-zhui'] -= 2
      drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
      const candidates = h.state.players.filter(x => x.alive).map(x => x.id)
      if (!candidates.length) return
      askTargets(h, MOU_LIUCHENG_LUEYING, id, id, candidates, '【掠影】：选择【过河拆桥】的目标', {}, true, 1, 1, 'dismantle-target')
    } },
  ],
  resume(h, id, r, res) {
    if (r.step === 'dismantle-target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      if (targetId && player(h.state, targetId)?.alive) {
        const cardId = createVirtualTrick(h.state, id, '过河拆桥', MOU_LIUCHENG_LUEYING)
        const [action] = instantTrickActions(h.state, id, cardId, '过河拆桥')
        if (action?.kind === 'use-card') executeUseCardAction(h as never, id, { ...action, targetIds: [targetId] })
      }
    }
  },
})
registerSkillRuntime({
  id: MOU_LIUCHENG_YINGWU,
  triggers: [
    { event: 'CardUsed', handle(h, id, c) {
      const d = c.event.payload as any
      if (h.state.phase !== 'play' || h.state.currentPlayerId !== id || c.event.sourceId !== id || !['无中生有', '过河拆桥', '顺手牵羊', '无懈可击', '铁索连环', '五谷丰登', '桃园结义', '借刀杀人'].includes(d.cardName) || !d.targetIds?.some((x: PlayerId) => x !== id)) return
      const count = get(h.state, `${MOU_LIUCHENG_YINGWU}:count:${id}`) ?? 0
      if (count >= 2) return
      set(h.state, `${MOU_LIUCHENG_YINGWU}:count:${id}`, count + 1)
      const owner = player(h.state, id)!
      owner.marks['mou-liucheng-zhui'] = (owner.marks['mou-liucheng-zhui'] ?? 0) + 1
    } },
    { event: 'PhaseStart', handle(h, id, c) {
      if ((c.event.payload as any).playerId === id && (c.event.payload as any).phase === 'play') {
        set(h.state, `${MOU_LIUCHENG_YINGWU}:count:${id}`, 0)
        if (player(h.state, id)) player(h.state, id)!.marks['mou-liucheng-zhui'] = 0
      }
    } },
    { event: 'AfterCardUse', handle(h, id, c) {
      const d = c.event.payload as any
      if (h.state.phase !== 'play' || h.state.currentPlayerId !== id || c.event.sourceId !== id || !['无中生有', '过河拆桥', '顺手牵羊', '无懈可击', '铁索连环', '五谷丰登', '桃园结义', '借刀杀人'].includes(d.cardName) || (player(h.state, id)?.marks['mou-liucheng-zhui'] ?? 0) < 2) return
      player(h.state, id)!.marks['mou-liucheng-zhui'] -= 2
      drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
      h.queueSkill({ skillId: MOU_LIUCHENG_YINGWU, ownerId: id, step: 'bonus-slash', data: {} })
    } },
  ],
  startQueued(h, id, q) {
    if (q.step !== 'bonus-slash') return
    const targets = h.state.players.filter(x => x.alive && x.id !== id).map(x => x.id)
    if (targets.length) askTargets(h, MOU_LIUCHENG_YINGWU, id, id, targets, '【莺舞】：选择视为使用普通【杀】的目标', {}, true, 1, 1, 'bonus-slash-target')
  },
  resume(h, id, r, res) {
    if (r.step !== 'bonus-slash-target') return
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    if (targetId && player(h.state, targetId)?.alive) h.beginVirtualSlash({ sourceId: id, targetId, sourceSkillId: MOU_LIUCHENG_YINGWU })
  },
})

export const MOU_LIUCHENG_B34: CharacterDefinition = {
  id: 'liucheng-mou', name: '谋·刘赪', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'mou',
  skills: [
    { id: MOU_LIUCHENG_LUEYING, name: '掠影', description: '出牌阶段内，你使用【杀】指定其他角色为目标时，出牌阶段限两次获得“椎”；此【杀】结算结束后，若你有至少两个“椎”，移除两个，摸一张牌并可视为对一名角色使用【过河拆桥】。' },
    { id: MOU_LIUCHENG_YINGWU, name: '莺舞', description: '出牌阶段内，你使用非伤害类普通锦囊指定其他角色为目标时（需拥有“掠影”），出牌阶段限两次获得“椎”；此牌结算结束后，若你有至少两个“椎”，移除两个，摸一张牌并可视为对一名角色使用不计次数的普通【杀】。' },
  ],
}

const SHI_HUANGZU_CHIZHANG = 'chizhang-shi-b34'
const SHI_HUANGZU_DUANYANG = 'duanyang-shi-b34'
const HUANGZU_COLOR_LOCK = 'shi-huangzu-color-lock'
const HUANGZU_DUANYANG_PILE = 'duanyang'
const HUANGZU_DUANYANG_STATE = 'shi-huangzu-duanyang-state'
const HUANGZU_DAMAGE_CARDS = new Set(['杀', '决斗', '南蛮入侵', '万箭齐发', '火攻'])

function isInDiscardPile(s: SanguoshaState, cardId: CardId): boolean {
  return s.zones.discardPile.includes(cardId)
}

function resumeHuangzu(h: SkillHost, id: PlayerId, r: any, res: any): void {
  if (r.step === 'take-kill') {
    if (res.payload.optionId !== 'yes') return
    const cardId = r.data.cardId as CardId
    if (!isInDiscardPile(h.state, cardId) || effectiveCardName(h.state, cardId) !== '杀') return
    const owner = player(h.state, id)
    if (!owner) return
    markUsedThisTurn(h.state, id, SHI_HUANGZU_DUANYANG)
    owner.characterPiles[HUANGZU_DUANYANG_PILE] ??= []
    moveCard(h.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: id, pile: HUANGZU_DUANYANG_PILE })
    set(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`, { cardId, phase: r.data.phase, turnNumber: r.data.turnNumber })
    h.dispatch('CardMove', { cardIds: [cardId], reason: SHI_HUANGZU_DUANYANG, destinationZone: HUANGZU_DUANYANG_PILE }, { sourceId: id, cardIds: [cardId] })
    return
  }
  if (r.step === 'target') {
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    const cardId = r.data.cardId as CardId
    const pile = player(h.state, id)?.characterPiles[HUANGZU_DUANYANG_PILE] ?? []
    if (!targetId || !pile.includes(cardId) || !player(h.state, targetId)?.alive) return
    set(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`, { ...get(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`), usedCardId: cardId })
    beginVirtualSlash(h as never, { sourceId: id, targetId, sourceSkillId: SHI_HUANGZU_DUANYANG, cardId })
    return
  }
  if (r.step === 'recast' && res.payload.optionId === 'yes') {
    const targetId = r.data.targetId as PlayerId
    const choices = pickableCardsOf(h.state, targetId, { includeJudgingArea: true })
    if (!choices.cardIds.length && !choices.hiddenCardSlots.length) {
      drawCards(h.state, h.rng, id, 4, (name, payload) => h.dispatch(name, payload))
      return
    }
    h.askSkill({ skillId: SHI_HUANGZU_DUANYANG, ownerId: id, step: 'recast-cards', data: { targetId }, build: requestId => ({
      id: requestId, kind: 'choose-cards', playerId: id, prompt: '【断鞅】：选择受伤角色区域内至多两张牌重铸', timeoutMs: 20_000,
      optional: false, purpose: 'skill', cardIds: choices.cardIds, hiddenCardSlots: choices.hiddenCardSlots, min: 0, max: Math.min(2, choices.cardIds.length + choices.hiddenCardSlots.length),
    }) })
    return
  }
  if (r.step === 'recast-cards') {
    const targetId = r.data.targetId as PlayerId
    for (const item of [...new Set((res.payload.cardIds ?? []) as string[])].slice(0, 2)) discardPickedFieldCard(h, targetId, item, SHI_HUANGZU_DUANYANG)
    drawCards(h.state, h.rng, id, 4, (name, payload) => h.dispatch(name, payload))
  }
}

function xuyeEffect(h: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = player(h.state, targetId)
  if (!target?.alive) return
  drawCards(h.state, h.rng, targetId, 2, (name, payload) => h.dispatch(name, payload))
  const living = h.state.players.filter(candidate => candidate.alive)
  const maximum = Math.max(0, ...living.map(candidate => handSize(h.state, candidate.id)))
  if (handSize(h.state, targetId) !== maximum) return
  askFieldCard(h, PANGXI_XUYE, ownerId, targetId, 'top-card', '【蓄业】：将其区域里一张牌置于牌堆顶', true, { targetId }, false)
}

const PANGXI_XUYE = 'xuye-pangxi-b34'
const PANGXI_KUANGXIANG = 'kuangxiang-pangxi-b34'
const PANGXI_EXCHANGE = 'pangxi-kuangxiang-exchange'

registerSkillRuntime({
  id: PANGXI_XUYE,
  triggers: [{ event: 'DamageSettled', handle(h, id, c) {
    const damagedId = c.event.targetId
    if (!damagedId || !player(h.state, damagedId)?.alive || Number((c.event.payload as any).finalAmount ?? 0) <= 0 || usedThisTurn(h.state, id, PANGXI_XUYE)) return
    const living = h.state.players.filter(candidate => candidate.alive)
    if (!living.length) return
    const minimum = Math.min(...living.map(candidate => handSize(h.state, candidate.id)))
    if (handSize(h.state, damagedId) !== minimum) return
    h.queueSkill({ skillId: PANGXI_XUYE, ownerId: id, step: 'invoke', data: { targetId: damagedId } })
  } }],
  startQueued(h, id, q) {
    if (q.step === 'grant-invoke') {
      askOption(h, PANGXI_XUYE, id, id, `invoke-${q.data.sourcePlayerId}`, '【匡襄】：是否执行一次“蓄业”效果？', [
        { id: 'yes', label: '发动蓄业' }, { id: 'no', label: '不发动' },
      ], { candidates: q.data.candidates, sourcePlayerId: q.data.sourcePlayerId })
      return
    }
    if (q.step !== 'invoke') return
    const targetId = q.data.targetId as PlayerId
    askOption(h, PANGXI_XUYE, id, id, 'invoke', '【蓄业】：是否令手牌数全场最少的受伤角色摸两张牌？', [
      { id: 'yes', label: '发动蓄业' }, { id: 'no', label: '不发动' },
    ], { targetId })
  },
  resume(h, id, r, res) {
    if (r.step === 'invoke' && res.payload.optionId === 'yes') {
      const targetId = r.data.targetId as PlayerId
      if (!player(h.state, targetId)?.alive) return
      markUsedThisTurn(h.state, id, PANGXI_XUYE)
      xuyeEffect(h, id, targetId)
      return
    }
    if (r.step.startsWith('invoke-')) { resolvePangxiGrantedXuye(h, id, r, res); return }
    if (r.step === 'target-grant') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      if (targetId && (r.data.candidates as PlayerId[]).includes(targetId)) xuyeEffect(h, id, targetId)
      return
    }
    if (r.step === 'top-card') {
      const targetId = r.data.targetId as PlayerId
      const picked = res.payload.cardIds?.[0] as string | undefined
      const cardId = picked && resolvePickedCard(h.state, targetId, picked)
      const from = cardId && locateOwnedCard(h.state, targetId, cardId)
      if (!cardId || !from) return
      moveCard(h.state, cardId, from, { kind: 'drawPile' }, { toTop: true })
      if (from.kind === 'equipment') handleEquipmentLost(h as never, targetId, cardId)
      h.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: PANGXI_XUYE }, { sourceId: targetId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: PANGXI_KUANGXIANG,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, PANGXI_KUANGXIANG)
      && aliveOthers(s, id).some(target => handSize(s, target.id) <= handSize(s, id))
      ? [{ id: PANGXI_KUANGXIANG, label: '匡襄：交换手牌' }] : []
  },
  invokeActive(h, id) {
    const candidates = aliveOthers(h.state, id).filter(target => handSize(h.state, target.id) <= handSize(h.state, id)).map(target => target.id)
    if (candidates.length) askTargets(h, PANGXI_KUANGXIANG, id, id, candidates, '【匡襄】：选择一名手牌数小于等于你的其他角色')
  },
  resume(h, id, r, res) {
    if (r.step !== 'target') return
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    if (!targetId || !player(h.state, targetId)?.alive || targetId === id || handSize(h.state, targetId) > handSize(h.state, id)) return
    const ownerCards = [...hand(h.state, id)]
    const targetCards = [...hand(h.state, targetId)]
    swapHands(h as never, id, targetId, PANGXI_KUANGXIANG)
    markUsedThisPhase(h.state, id, PANGXI_KUANGXIANG)
    set(h.state, `${PANGXI_EXCHANGE}:${id}`, {
      targetId, turnNumber: h.state.turnNumber,
      ownerReceived: targetCards, targetReceived: ownerCards,
      ownerEffectUsed: false, targetEffectUsed: false,
    })
  },
  triggers: [
    { event: 'LoseCard', handle: (h, id, c) => checkPangxiExchange(h, id, c.event.payload as any) },
    { event: 'CardUsed', handle: (h, id, c) => checkPangxiExchange(h, id, c.event.payload as any) },
    { event: 'CardResponded', handle: (h, id, c) => checkPangxiExchange(h, id, c.event.payload as any) },
    { event: 'PhaseStart', handle(h, id, c) {
      const d = c.event.payload as any
      if (d.playerId === id && d.phase === 'play' && get(h.state, `${PANGXI_EXCHANGE}:${id}`))
        delete (st(h.state).b34 ?? {})[`${PANGXI_EXCHANGE}:${id}`]
    } },
  ],
})

function checkPangxiExchange(h: SkillHost, ownerId: PlayerId, payload: any): void {
  const key = `${PANGXI_EXCHANGE}:${ownerId}`
  const exchange = get(h.state, key)
  if (!exchange) return
  const changedId = payload.playerId ?? payload.sourceId
  const cardIds = (payload.cardIds ?? (payload.cardId ? [payload.cardId] : [])) as CardId[]
  if (!cardIds.length) return
  const sides: Array<{ id: PlayerId; field: 'ownerReceived' | 'targetReceived'; used: 'ownerEffectUsed' | 'targetEffectUsed' }> = [
    { id: ownerId, field: 'ownerReceived', used: 'ownerEffectUsed' },
    { id: exchange.targetId, field: 'targetReceived', used: 'targetEffectUsed' },
  ]
  for (const side of sides) {
    if (changedId !== side.id || exchange[side.used] || !exchange[side.field].some((cardId: CardId) => cardIds.includes(cardId))) continue
    if (exchange[side.field].some((cardId: CardId) => hand(h.state, side.id).includes(cardId))) continue
    exchange[side.used] = true
    const living = h.state.players.filter(candidate => candidate.alive)
    if (!living.length) continue
    const minimum = Math.min(...living.map(candidate => handSize(h.state, candidate.id)))
    const candidates = living.filter(candidate => handSize(h.state, candidate.id) === minimum).map(candidate => candidate.id)
    h.queueSkill({ skillId: PANGXI_XUYE, ownerId, step: 'grant-invoke', data: { candidates, sourcePlayerId: side.id } })
    break
  }
}

function resolvePangxiGrantedXuye(h: SkillHost, ownerId: PlayerId, r: any, res: any): void {
  if (!r.step.startsWith('invoke-') || res.payload.optionId !== 'yes') return
  const candidates = (r.data.candidates as PlayerId[]).filter(id => player(h.state, id)?.alive)
  if (!candidates.length) return
  if (candidates.length === 1) { xuyeEffect(h, ownerId, candidates[0], true); return }
  askTargets(h, PANGXI_XUYE, ownerId, ownerId, candidates, '【匡襄】：选择一名手牌数全场最少的角色执行“蓄业”', { candidates }, false, 1, 1, 'target-grant')
}

registerSkillRuntime({
  id: SHI_HUANGZU_CHIZHANG,
  slashIgnoresDistance(s, id, cardId) { return Boolean(cardId && HUANGZU_DAMAGE_CARDS.has(effectiveCardName(s, cardId))) },
  trickDistanceBonus(s, id, _targetId, cardName) { return HUANGZU_DAMAGE_CARDS.has(cardName) ? 99 : 0 },
  prohibitsResponseCard(s, id, responderId, responseCardId, responseName) {
    const current = s.cardResolution as any
    const record = get(s, `${HUANGZU_COLOR_LOCK}:${current?.cardId}`)
    if (!record || responderId === id || current?.sourceId !== id || !record.colors.length) return false
    const color = effectiveCardColor(s, responderId, responseCardId)
    return record.colors.includes(color)
  },
  interceptSourceTarget(h, id, context) {
    if (!HUANGZU_DAMAGE_CARDS.has(context.cardName) || context.cardName === '闪电') return false
    const source = player(h.state, id)
    if (!source?.zones.hand.length) return false
    askCards(h, SHI_HUANGZU_CHIZHANG, id, id, source.zones.hand, '【鸱张】：可弃置任意张手牌；其他角色不能用与这些牌颜色相同的【闪】或【无懈可击】响应此牌。', 0, source.zones.hand.length, { cardId: context.cardId }, true)
    return true
  },
  resume(h, id, r, res) {
    if (r.step === 'cards') {
      const usedCardId = r.data.cardId as CardId
      const ids = [...new Set((res.payload.cardIds ?? []) as CardId[])].filter(cardId => hand(h.state, id).includes(cardId))
      const colors = [...new Set(ids.map(cardId => effectiveCardColor(h.state, id, cardId)).filter((color): color is 'red' | 'black' => color === 'red' || color === 'black'))]
      if (ids.length) discard(h, id, ids, SHI_HUANGZU_CHIZHANG)
      if (colors.length) set(h.state, `${HUANGZU_COLOR_LOCK}:${usedCardId}`, { colors, ownerId: id })
      h.resumeCardTarget()
      return
    }
  },
  triggers: [{ event: 'AfterCardUse', handle(h, id, c) {
    const cardId = (c.event.payload as any).cardId as CardId | undefined
    if (c.event.sourceId === id && cardId) {
      const record = get(h.state, `${HUANGZU_COLOR_LOCK}:${cardId}`)
      if (record?.ownerId === id) delete (st(h.state).b34 ?? {})[`${HUANGZU_COLOR_LOCK}:${cardId}`]
    }
  } }],
})

registerSkillRuntime({
  id: SHI_HUANGZU_DUANYANG,
  startQueued(h, id, q) {
    if (q.step === 'take-kill') {
      if (usedThisTurn(h.state, id, SHI_HUANGZU_DUANYANG)) return
      const cardId = q.data.cardId as CardId
      if (!isInDiscardPile(h.state, cardId) || effectiveCardName(h.state, cardId) !== '杀') return
      askOption(h, SHI_HUANGZU_DUANYANG, id, id, 'take-kill', '【断鞅】：是否将进入弃牌堆的手牌【杀】置于武将牌上？', [
        { id: 'yes', label: '置为“断鞅”牌' }, { id: 'no', label: '不发动' },
      ], q.data)
      return
    }
    if (q.step === 'use-kill') {
      const saved = get(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`)
      const pile = player(h.state, id)?.characterPiles[HUANGZU_DUANYANG_PILE] ?? []
      if (!saved || !pile.includes(saved.cardId)) return
      askTargets(h, SHI_HUANGZU_DUANYANG, id, id, aliveOthers(h.state, id).map(x => x.id), '【断鞅】：选择【杀】的目标', { cardId: saved.cardId }, false)
      return
    }
    if (q.step === 'recast') {
      const targetId = q.data.targetId as PlayerId
      if (player(h.state, targetId)?.alive) askOption(h, SHI_HUANGZU_DUANYANG, id, id, 'recast', '【断鞅】：是否重铸受伤角色区域内至多两张牌，然后摸四张牌？', [
        { id: 'yes', label: '选择至多两张牌重铸' }, { id: 'no', label: '不发动' },
      ], { targetId })
    }
  },
  triggers: [
    { event: 'LoseCard', handle(h, id, c) {
      const d = c.event.payload as any
      if (d.playerId !== id || usedThisTurn(h.state, id, SHI_HUANGZU_DUANYANG)) return
      const candidates = (d.cardIds as CardId[] ?? []).filter(cardId => isInDiscardPile(h.state, cardId) && effectiveCardName(h.state, cardId) === '杀')
      if (!candidates.length) return
      const cardId = h.rng.pick(candidates)
      h.queueSkill({ skillId: SHI_HUANGZU_DUANYANG, ownerId: id, step: 'take-kill', data: { cardId, phase: h.state.phase, turnNumber: h.state.turnNumber } })
    } },
    { event: 'CardEnteredDiscard', handle(h, id, c) {
      const d = c.event.payload as any
      const cardId = d.cardId as CardId | undefined
      if (d.playerId !== id || d.fromKind !== 'hand' || !cardId || effectiveCardName(h.state, cardId) !== '杀' || usedThisTurn(h.state, id, SHI_HUANGZU_DUANYANG)) return
      h.queueSkill({ skillId: SHI_HUANGZU_DUANYANG, ownerId: id, step: 'take-kill', data: { cardId, phase: h.state.phase, turnNumber: h.state.turnNumber } })
    } },
    { event: 'PhaseEnd', handle(h, id, c) {
      const d = c.event.payload as any
      const saved = get(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`)
      if (d.playerId !== id || !saved || saved.turnNumber !== h.state.turnNumber || saved.phase !== d.phase || !player(h.state, id)?.alive) return
      const pile = player(h.state, id)!.characterPiles[HUANGZU_DUANYANG_PILE] ?? []
      if (!pile.includes(saved.cardId)) return
      h.queueSkill({ skillId: SHI_HUANGZU_DUANYANG, ownerId: id, step: 'use-kill', data: { cardId: saved.cardId } })
    } },
    { event: 'DamageSettled', handle(h, id, c) {
      const d = c.event.payload as any
      const cardId = d.cardId as CardId | undefined
      const saved = get(h.state, `${HUANGZU_DUANYANG_STATE}:${id}`)
      if (c.event.sourceId !== id || !cardId || saved?.usedCardId !== cardId || Number(d.finalAmount ?? 0) < 1) return
      const targetId = c.event.targetId
      if (!targetId || !player(h.state, targetId)?.alive) return
      h.queueSkill({ skillId: SHI_HUANGZU_DUANYANG, ownerId: id, step: 'recast', data: { targetId } })
    } },
  ],
  resume(h, id, r, res) { resumeHuangzu(h, id, r, res) },
})

export const SHI_HUANGZU_B34: CharacterDefinition = {
  id: 'huangzu-shi', name: '势·黄祖', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'shi',
  skills: [
    { id: SHI_HUANGZU_CHIZHANG, name: '鸱张', description: '你使用伤害类牌无距离限制；当你使用手牌中除【闪电】外的伤害类牌指定目标后，可弃置任意张手牌，其他角色不能使用或打出与这些牌颜色相同的牌响应此牌。' },
    { id: SHI_HUANGZU_DUANYANG, name: '断鞅', description: '每回合限一次，当你的手牌非因使用进入弃牌堆时，可将其中随机一张【杀】置于武将牌上，本阶段结束时无次数限制使用之；以此法使用的【杀】造成伤害后，可重铸受伤角色区域内至多两张牌，然后摸四张牌。' },
  ],
}

export const PANGXI_B34: CharacterDefinition = {
  id: 'pangxi', name: '庞羲', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: PANGXI_XUYE, name: '蓄业', description: '每回合限一次，当全场手牌数最少的角色受到伤害后，你可以令其摸两张牌，然后若其手牌数全场最多，你将其区域里的一张牌置于牌堆顶。' },
    { id: PANGXI_KUANGXIANG, name: '匡襄', description: '出牌阶段限一次，你可以与一名手牌数小于等于你的其他角色交换手牌，且直到你的下个出牌阶段开始，你或其失去所有因此获得的手牌后，你可以执行一次“蓄业”的效果（不受发动次数影响）。' },
  ],
}

const SHI_TAISHICI_HANZHAN = 'hanzhan-shi-b34'
const SHI_TAISHICI_ZHANLIE = 'zhanlie-shi-b34'
const SHI_TAISHICI_ZHENFENG = 'zhenfeng-shi-b34'
const TAISHI_LIE_MARK = 'shi-taishici-lie'
const TAISHI_HANZHAN_X = 'shi-taishici-hanzhan-x'
const TAISHI_ZHANLIE_X = 'shi-taishici-zhanlie-x'

function countAlive(s: SanguoshaState): number { return s.players.filter(x => x.alive).length }
function taishiFormulaValue(s: SanguoshaState, id: PlayerId, markKey: string, fallback: number): number {
  const mode = get(s, `${markKey}:${id}`)
  const owner = player(s, id)
  if (mode === 'hp') return Math.max(0, owner?.hp ?? 0)
  if (mode === 'lost') return Math.max(0, (owner?.maxHp ?? 0) - (owner?.hp ?? 0))
  if (mode === 'alive') return countAlive(s)
  return fallback
}
function taishiValueForPlayer(s: SanguoshaState, id: PlayerId, mode: unknown, fallback: number): number {
  const owner = player(s, id)
  if (mode === 'hp') return Math.max(0, owner?.hp ?? 0)
  if (mode === 'lost') return Math.max(0, (owner?.maxHp ?? 0) - (owner?.hp ?? 0))
  if (mode === 'alive') return countAlive(s)
  return fallback
}

registerSkillRuntime({
  id: SHI_TAISHICI_HANZHAN,
  activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, SHI_TAISHICI_HANZHAN) && aliveOthers(s, id).length > 0 ? [{ id: SHI_TAISHICI_HANZHAN, label: '酣战：选择角色决斗' }] : [] },
  invokeActive(h, id) { askTargets(h, SHI_TAISHICI_HANZHAN, id, id, aliveOthers(h.state, id).map(x => x.id), '【酣战】：选择一名其他角色') },
  resume(h, id, r, res) {
    if (r.step !== 'target') return
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    const target = targetId && player(h.state, targetId)
    if (!target?.alive || targetId === id) return
    markUsedThisPhase(h.state, id, SHI_TAISHICI_HANZHAN)
    const owner = player(h.state, id)!
    const ownerLimit = taishiFormulaValue(h.state, id, TAISHI_HANZHAN_X, owner.maxHp)
    const targetLimit = taishiValueForPlayer(h.state, targetId, get(h.state, `${TAISHI_HANZHAN_X}:${id}`), target.maxHp)
    drawCards(h.state, h.rng, id, Math.min(3, Math.max(0, ownerLimit - handSize(h.state, id))), (name, payload) => h.dispatch(name, payload))
    drawCards(h.state, h.rng, targetId, Math.min(3, Math.max(0, targetLimit - handSize(h.state, targetId))), (name, payload) => h.dispatch(name, payload))
    virtualDuel(h, id, targetId, SHI_TAISHICI_HANZHAN)
  },
})

function scanNewDiscardedSlashes(h: SkillHost, id: PlayerId): void {
  const recordKey = `${SHI_TAISHICI_ZHANLIE}:discard-scan:${id}`
  const record = get(h.state, recordKey) ?? { known: [] as CardId[], turn: h.state.turnNumber, remaining: 0 }
  if (record.turn !== h.state.turnNumber) return
  const current = [...h.state.zones.discardPile]
  const known = new Set((record.known as CardId[]).filter(cardId => current.includes(cardId)))
  const max = Math.max(0, Math.trunc(record.remaining as number))
  for (const cardId of current) {
    if (known.has(cardId)) continue
    known.add(cardId)
    if (h.state.cards[cardId]?.name !== '杀' || record.processed >= max) continue
    record.processed = (record.processed ?? 0) + 1
    const owner = player(h.state, id)
    if (owner) owner.marks[TAISHI_LIE_MARK] = Math.min(6, (owner.marks[TAISHI_LIE_MARK] ?? 0) + 1)
  }
  record.known = current
  set(h.state, recordKey, record)
}

registerSkillRuntime({
  id: SHI_TAISHICI_ZHANLIE,
  triggers: [
    { event: 'TurnStart', handle(h, id) {
      const x = Math.max(0, Math.trunc(taishiFormulaValue(h.state, id, TAISHI_ZHANLIE_X, getAttackRange(h.state, id))))
      set(h.state, `${SHI_TAISHICI_ZHANLIE}:discard-scan:${id}`, { known: [...h.state.zones.discardPile], turn: h.state.turnNumber, remaining: x, processed: 0 })
    } },
    ...(['CardResolved', 'AfterCardUse', 'CardResponded', 'DuelResult', 'LoseCard', 'PhaseEnd', 'TurnEnd'] as const).map(event => ({ event, handle(h: SkillHost, id: PlayerId) { scanNewDiscardedSlashes(h, id) } })),
    { event: 'PhaseEnd', handle(h, id, c) {
      const d = c.event.payload as any
      const owner = player(h.state, id)
      const amount = owner?.marks[TAISHI_LIE_MARK] ?? 0
      if (d.playerId !== id || d.phase !== 'play' || amount < 1) return
      askOption(h, SHI_TAISHICI_ZHANLIE, id, id, 'invoke', '【战烈】：是否移去所有“烈”并使用强化【杀】？', [{ id: 'yes', label: `移去${amount}个“烈”并使用【杀】` }, { id: 'no', label: '不发动' }], { amount })
    } },
    { event: 'AfterCardUse', handle(h, id, c) {
      const d = c.event.payload as any
      if (c.event.sourceId !== id || d.sourceSkillId !== SHI_TAISHICI_ZHANLIE || !get(h.state, `${SHI_TAISHICI_ZHANLIE}:draw-after:${id}`)) return
      set(h.state, `${SHI_TAISHICI_ZHANLIE}:draw-after:${id}`, false)
      drawCards(h.state, h.rng, id, 2, (name, payload) => h.dispatch(name, payload))
    } },
  ],
  resume(h, id, r, res) {
    if (r.step === 'invoke') {
      if (res.payload.optionId !== 'yes') return
      const amount = player(h.state, id)?.marks[TAISHI_LIE_MARK] ?? 0
      if (amount < 1) return
      player(h.state, id)!.marks[TAISHI_LIE_MARK] = 0
      const max = Math.min(4, Math.floor(amount / 3))
      h.askSkill({ skillId: SHI_TAISHICI_ZHANLIE, ownerId: id, step: 'options', data: { amount }, build: requestId => ({ id: requestId, kind: 'choose-options', playerId: id, prompt: `【战烈】：选择至多${max}项强化`, timeoutMs: 20_000, optional: false, options: [
        { id: 'extra-target', label: '此【杀】目标数上限+1' }, { id: 'damage', label: '此【杀】基础伤害+1' },
        { id: 'discard-to-respond', label: '目标需额外弃置一张牌方可响应' }, { id: 'draw', label: '此【杀】结算后摸两张牌' },
      ], min: 0, max } as any) })
      return
    }
    if (r.step === 'options') {
      const optionIds = [...new Set((res.payload.optionIds ?? []) as string[])]
      const extra = optionIds.includes('extra-target') ? 1 : 0
      const candidates = aliveOthers(h.state, id).map(x => x.id)
      if (!candidates.length) return
      askTargets(h, SHI_TAISHICI_ZHANLIE, id, id, candidates, '【战烈】：选择强化【杀】的目标', { optionIds, maxTargets: 1 + extra }, false, 1, 1 + extra, 'targets')
      return
    }
    if (r.step === 'targets') {
      const targetIds = (res.payload.targetIds ?? []).filter((targetId: PlayerId) => player(h.state, targetId)?.alive && targetId !== id) as PlayerId[]
      if (targetIds.length < 1) return
      const optionIds = r.data.optionIds as string[]
      const used = beginVirtualSlash(h as never, {
        sourceId: id, targetIds, sourceSkillId: SHI_TAISHICI_ZHANLIE,
        maxTargets: r.data.maxTargets as number,
        damageBonus: optionIds.includes('damage') ? 1 : 0,
        responseDiscardCostTargetIds: optionIds.includes('discard-to-respond') ? targetIds : [],
      })
      if (!used) return
      if (optionIds.includes('draw')) set(h.state, `${SHI_TAISHICI_ZHANLIE}:draw-after:${id}`, true)
    }
  },
})

registerSkillRuntime({
  id: SHI_TAISHICI_ZHENFENG,
  limited: true,
  activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !get(s, `${SHI_TAISHICI_ZHENFENG}:used:${id}`) ? [{ id: SHI_TAISHICI_ZHENFENG, label: '振锋：回复体力或调整技能数值' }] : [] },
  invokeActive(h, id) { askOption(h, SHI_TAISHICI_ZHENFENG, id, id, 'mode', '【振锋】：选择一项', [{ id: 'recover', label: '回复2点体力' }, { id: 'modify', label: '修改“酣战”及“战烈”的X' }]) },
  resume(h, id, r, res) {
    if (r.step === 'mode') {
      set(h.state, `${SHI_TAISHICI_ZHENFENG}:used:${id}`, true)
      if (res.payload.optionId === 'recover') { recover(h, id, 2, id); return }
      const ownedSkills = new Set(skillsOf(h.state, id).map(skill => skill.id))
      const enabled = [SHI_TAISHICI_HANZHAN, SHI_TAISHICI_ZHANLIE].filter(skillId => ownedSkills.has(skillId))
      if (!enabled.length) return
      set(h.state, `${SHI_TAISHICI_ZHENFENG}:modify-index:${id}`, 0)
      askOption(h, SHI_TAISHICI_ZHENFENG, id, id, 'modify', `【振锋】：选择${enabled[0] === SHI_TAISHICI_HANZHAN ? '酣战' : '战烈'}的X`, [
        { id: 'hp', label: '当前体力值' }, { id: 'lost', label: '已损失体力值' }, { id: 'alive', label: '存活角色数' },
      ], { enabled }, false)
      return
    }
    if (r.step === 'modify') {
      const mode = res.payload.optionId
      if (!['hp', 'lost', 'alive'].includes(mode)) return
      const enabled = r.data.enabled as string[]
      const index = r.data.index as number ?? 0
      const skill = enabled[index]
      if (skill === SHI_TAISHICI_HANZHAN) set(h.state, `${TAISHI_HANZHAN_X}:${id}`, mode)
      if (skill === SHI_TAISHICI_ZHANLIE) set(h.state, `${TAISHI_ZHANLIE_X}:${id}`, mode)
      if (index + 1 < enabled.length) askOption(h, SHI_TAISHICI_ZHENFENG, id, id, 'modify', '【振锋】：选择另一个技能的X', [
        { id: 'hp', label: '当前体力值' }, { id: 'lost', label: '已损失体力值' }, { id: 'alive', label: '存活角色数' },
      ], { enabled, index: index + 1 }, false)
    }
  },
})

export const SHI_TAISHICI_B34: CharacterDefinition = {
  id: 'taishici-shi', name: '势·太史慈', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'shi',
  skills: [
    { id: SHI_TAISHICI_HANZHAN, name: '酣战', description: '出牌阶段限一次，选择一名其他角色，你与其依次摸牌至X张（X为各自体力上限，每人每次至多摸3张），然后视为你对其使用一张【决斗】。' },
    { id: SHI_TAISHICI_ZHANLIE, name: '战烈', description: '每名角色回合开始时记录X（你的攻击范围）；本回合前X张【杀】进入弃牌堆时获得“烈”（至多6）。出牌阶段结束时可移去全部“烈”视为使用无次数限制的【杀】，至多选择⌊烈数/3⌋项：目标数+1、基础伤害+1、目标响应此【杀】前须额外弃置一张牌、结算后摸2张。' },
    { id: SHI_TAISHICI_ZHENFENG, name: '振锋', description: '限定技，出牌阶段选择回复2点体力，或分别将“酣战”及“战烈”的X改为当前体力值、已损失体力值、存活角色数中的一项（拥有对应技能方可选择）。' },
  ],
}

const SHI_SUNCHEN_NIGU = 'nigu-shi-b34'
const SHI_SUNCHEN_LULIAN = 'lulian-shi-b34'
const SHI_SUNCHEN_CHENGSHI = 'chengshi-shi-b34'
const SUNCHEN_DAMAGE_BONUS = 'shi-sunchen-next-damage-bonus'
const SUNCHEN_GROUP_TAG = 'shi-sunchen-nigu-group-b34'

registerGroupCardDecision(SUNCHEN_GROUP_TAG, (rawHost, decision) => {
  const h = rawHost as unknown as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const owner = player(h.state, ownerId)
  if (!owner?.alive) return
  let declined = 0
  for (const responderId of decision.playerIds) {
    if (!player(h.state, responderId)?.alive) continue
    const requested = decision.responses[responderId] ?? []
    const cardId = requested.find(id => hand(h.state, responderId).includes(id))
    if (!cardId || giveCards(h, responderId, ownerId, [cardId], SHI_SUNCHEN_NIGU).length !== 1) declined += 1
  }
  owner.marks[SUNCHEN_DAMAGE_BONUS] = (owner.marks[SUNCHEN_DAMAGE_BONUS] ?? 0) + declined
})

registerSkillRuntime({
  id: SHI_SUNCHEN_NIGU,
  activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, SHI_SUNCHEN_NIGU) ? [{ id: SHI_SUNCHEN_NIGU, label: '逆固：弃置牌并同时索取手牌' }] : [] },
  invokeActive(h, id) { askCards(h, SHI_SUNCHEN_NIGU, id, id, owned(h.state, id), '【逆固】：弃置任意张花色各不相同的牌', 0, owned(h.state, id).length, {}, true) },
  resume(h, id, r, res) {
    if (r.step !== 'cards') return
    const chosen = [...new Set((res.payload.cardIds ?? []) as CardId[])].filter(cardId => owned(h.state, id).includes(cardId))
    const suits = new Set<string>()
    const costs = chosen.filter(cardId => {
      const suit = effectiveCardSuit(h.state, id, cardId)
      if (!suit || suits.has(suit)) return false
      suits.add(suit)
      return true
    })
    markUsedThisPhase(h.state, id, SHI_SUNCHEN_NIGU)
    discard(h, id, costs, SHI_SUNCHEN_NIGU)
    const range = getAttackRange(h.state, id)
    const participants = h.state.players.filter(target => target.alive && target.id !== id && getDistance(h.state, id, target.id) <= range).map(target => target.id)
    startGroupCardDecision(h as never, {
      id: `${SUNCHEN_GROUP_TAG}:${h.state.turnNumber}:${h.state.seq}`,
      tag: SUNCHEN_GROUP_TAG,
      skillId: SHI_SUNCHEN_NIGU,
      playerIds: participants,
      prompt: '【逆固】：秘密选择是否交给孙綝一张手牌；不交牌则本回合其伤害增加次数+1',
      cardIdsFor: responderId => hand(h.state, responderId),
      min: 0,
      max: 1,
      timeoutMs: 20_000,
      data: { ownerId: id },
    })
  },
  triggers: [{ event: 'DamageCaused', handle(h, id, c) {
    const owner = player(h.state, id)
    const payload = c.event.payload as any
    if (c.event.sourceId !== id || !owner || (owner.marks[SUNCHEN_DAMAGE_BONUS] ?? 0) <= 0) return
    payload.amount = Math.max(0, Number(payload.amount ?? 0)) + 1
    owner.marks[SUNCHEN_DAMAGE_BONUS] -= 1
  } }, { event: 'TurnEnd', handle(h, id, c) {
    if ((c.event.payload as any).playerId === id && player(h.state, id)) delete player(h.state, id)!.marks[SUNCHEN_DAMAGE_BONUS]
  } }],
})

function categoryForName(s: SanguoshaState, cardName: string): string | null {
  return Object.values(s.cards).find(card => card.name === cardName)?.category ?? null
}

registerSkillRuntime({
  id: SHI_SUNCHEN_LULIAN,
  triggers: [{ event: 'AfterCardUse', handle(h, id, c) {
    if (c.event.sourceId !== id) return
    const d = c.event.payload as any
    const usedCardIds = [...new Set([...(d.cardIds ?? []), ...(d.cardId ? [d.cardId] : [])])] as CardId[]
    if (!usedCardIds.length) return
    const usedName = d.cardName as string
    const category = categoryForName(h.state, usedName)
    if (!category || usedCardIds.every(cardId => !h.state.cards[cardId] || h.state.cards[cardId].virtual)) return
    if (hand(h.state, id).some(cardId => h.state.cards[cardId]?.category === category)) return
    const owner = player(h.state, id)
    if (!owner) return
    const targets = (d.targetIds as PlayerId[] ?? []).filter(targetId => player(h.state, targetId)?.alive)
    const eligibleTargets = targets.filter(targetId => (player(h.state, targetId)?.hp ?? Infinity) <= owner.hp)
    if (eligibleTargets.length) {
      for (const targetId of targets) setChained(h as never, targetId, SHI_SUNCHEN_LULIAN, true)
    }
    const equipmentCount = Object.values(owner.zones.equipment).filter(Boolean).length
    if (eligibleTargets.some(targetId => Object.values(player(h.state, targetId)!.zones.equipment).filter(Boolean).length <= equipmentCount)) {
      drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
    }
    h.queueSkill({ skillId: SHI_SUNCHEN_CHENGSHI, ownerId: id, step: 'choose-target', data: { sourceCardId: d.cardId } })
  } }],
})

registerSkillRuntime({
  id: SHI_SUNCHEN_CHENGSHI,
  startQueued(h, id, q) {
    if (q.step !== 'choose-target') return
    const living = h.state.players.filter(target => target.alive)
    if (!living.length) return
    const minimumHp = Math.min(...living.map(target => target.hp))
    const candidates = living.filter(target => target.hp > minimumHp).map(target => target.id)
    if (candidates.length) askTargets(h, SHI_SUNCHEN_CHENGSHI, id, id, candidates, '【乘势】：选择一名体力值不为全场最小的角色', { sourceCardId: q.data.sourceCardId })
  },
  resume(h, id, r, res) {
    if (r.step !== 'target') return
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    if (targetId && player(h.state, targetId)?.alive) resolveDamage(h as never, { sourceId: id, targetId, amount: 1, nature: 'fire', cardName: null })
  },
})

export const SHI_SUNCHEN_B34: CharacterDefinition = {
  id: 'sunchen-shi', name: '势·孙綝', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'shi',
  skills: [
    { id: SHI_SUNCHEN_NIGU, name: '逆固', description: '出牌阶段限一次，弃置任意张花色各不相同的牌，令攻击范围内角色同时选择是否交给你一张牌；本回合你造成的下X次伤害+1（X为未交牌角色数）。' },
    { id: SHI_SUNCHEN_LULIAN, name: '戮连', description: '锁定技，使用手牌结算后，若没有此类别手牌且有目标角色体力值小于等于你，此牌所有目标横置；若你的装备数小于等于全场最少装备数，你摸一张牌。' },
    { id: SHI_SUNCHEN_CHENGSHI, name: '乘势', description: '戮连结算后，你可以对一名体力值不为全场最小的角色造成1点火焰伤害。' },
  ],
}

const MOU_GONGSUNZAN_YICONG = 'yicong-mou-b34'
const MOU_GONGSUNZAN_QIAOMENG = 'qiaomeng-mou-b34'
const GONGSUN_CHARGE = 'mou-gongsun-charge'
const GONGSUN_HU_PILE = 'hu'

function gongsunCharge(s: SanguoshaState, id: PlayerId): number { return player(s, id)?.marks[GONGSUN_CHARGE] ?? 0 }
function gongsunHu(s: SanguoshaState, id: PlayerId): CardId[] { return player(s, id)?.characterPiles?.[GONGSUN_HU_PILE] ?? [] }

registerSkillRuntime({
  id: MOU_GONGSUNZAN_YICONG,
  onGameStart(h, id) { const owner = player(h.state, id); if (owner) owner.marks[GONGSUN_CHARGE] = 2 },
  distanceModifier: {
    toOthers(s, id) { const mode = get(s, `${MOU_GONGSUNZAN_YICONG}:mode:${id}`); return mode?.round === s.roundNumber && mode.kind === 'attack' ? -1 : 0 },
    fromOthers(s, id) { const mode = get(s, `${MOU_GONGSUNZAN_YICONG}:mode:${id}`); return mode?.round === s.roundNumber && mode.kind === 'defense' ? 1 : 0 },
  },
  viewAs(s, id) {
    return gongsunHu(s, id).flatMap(cardId => {
      const card = s.cards[cardId]
      return card && (card.name === '杀' || card.name === '闪')
        ? [{ cardId, asCardName: card.name, label: `【义从】将“扈”中的【${card.name}】作为手牌使用或打出` }]
        : []
    })
  },
  triggers: [{ event: 'RoundStart', handle(h, id) {
    const owner = player(h.state, id)
    const room = Math.min(4 - gongsunHu(h.state, id).length, gongsunCharge(h.state, id))
    if (!owner?.alive || room <= 0) return
    askOption(h, MOU_GONGSUNZAN_YICONG, id, id, 'mode', '【义从】：是否消耗蓄力点并调整本轮距离？', [
      { id: 'attack', label: '进攻：你与其他角色距离-1，获得“扈”【杀】' },
      { id: 'defense', label: '防御：其他角色与你距离+1，获得“扈”【闪】' },
      { id: 'cancel', label: '不发动' },
    ], { round: h.state.roundNumber })
  } }],
  resume(h, id, r, res) {
    if (r.step === 'mode') {
      const mode = res.payload.optionId
      if ((r.data.round as number) !== h.state.roundNumber || !['attack', 'defense'].includes(mode)) return
      const room = Math.min(4 - gongsunHu(h.state, id).length, gongsunCharge(h.state, id))
      const cardName = mode === 'attack' ? '杀' : '闪'
      const available = h.state.zones.drawPile.filter(cardId => h.state.cards[cardId]?.name === cardName).length
      const max = Math.min(room, available)
      if (max <= 0) return
      h.askSkill({ skillId: MOU_GONGSUNZAN_YICONG, ownerId: id, step: 'amount', data: { mode, round: h.state.roundNumber }, build: requestId => ({
        id: requestId, kind: 'choose-number', playerId: id, prompt: `【义从】：消耗多少蓄力点并取${max}张上限的【${cardName}】？`, timeoutMs: 20_000, optional: false, min: 1, max,
      }) })
      return
    }
    if (r.step === 'amount') {
      const amount = Number(res.payload.number)
      if (!Number.isInteger(amount) || amount < 1 || amount > Math.min(gongsunCharge(h.state, id), 4 - gongsunHu(h.state, id).length)) return
      const mode = r.data.mode as 'attack' | 'defense'
      const cardName = mode === 'attack' ? '杀' : '闪'
      const matching = h.state.zones.drawPile.filter(cardId => h.state.cards[cardId]?.name === cardName)
      const actualCount = Math.min(amount, matching.length)
      if (actualCount < 1) return
      player(h.state, id)!.marks[GONGSUN_CHARGE] = gongsunCharge(h.state, id) - actualCount
      set(h.state, `${MOU_GONGSUNZAN_YICONG}:mode:${id}`, { kind: mode, round: h.state.roundNumber })
      const owner = player(h.state, id)!
      owner.characterPiles[GONGSUN_HU_PILE] ??= []
      const selected: CardId[] = []
      for (let index = 0; index < actualCount; index += 1) {
        const remaining = h.state.zones.drawPile.filter(cardId => h.state.cards[cardId]?.name === cardName)
        if (!remaining.length) break
        const cardId = h.rng.pick(remaining)
        moveCard(h.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: id, pile: GONGSUN_HU_PILE })
        selected.push(cardId)
      }
      if (selected.length) h.dispatch('CardMove', { cardIds: selected, reason: MOU_GONGSUNZAN_YICONG, destinationZone: GONGSUN_HU_PILE }, { sourceId: id, cardIds: selected })
    }
  },
})

registerSkillRuntime({
  id: MOU_GONGSUNZAN_QIAOMENG,
  triggers: [{ event: 'DamageSettled', handle(h, id, c) {
    const d = c.event.payload as any
    const targetId = c.event.targetId
    if (c.event.sourceId !== id || d.cardName !== '杀' || Number(d.finalAmount) < 1 || !targetId || !player(h.state, id)?.alive) return
    h.queueSkill({ skillId: MOU_GONGSUNZAN_QIAOMENG, ownerId: id, step: 'choose', data: { targetId } })
  } }],
  startQueued(h, id, q) {
    if (q.step !== 'choose') return
    const targetId = q.data.targetId as PlayerId
    const canGain = gongsunCharge(h.state, id) < 4
    const canDiscard = Boolean(player(h.state, targetId)?.alive && (Object.values(player(h.state, targetId)!.zones.equipment).some(Boolean)
      || player(h.state, targetId)!.zones.hand.length || player(h.state, targetId)!.zones.judgingArea.length))
    askOption(h, MOU_GONGSUNZAN_QIAOMENG, id, id, 'mode', '【趫猛】：选择一项', [
      ...(canDiscard ? [{ id: 'discard', label: '弃置其区域内一张牌，然后摸一张牌' }] : []),
      ...(canGain ? [{ id: 'charge', label: '获得3点蓄力点（至多4点）' }] : []),
    ], { targetId })
  },
  resume(h, id, r, res) {
    if (r.step === 'mode') {
      const targetId = r.data.targetId as PlayerId
      if (res.payload.optionId === 'charge') {
        const owner = player(h.state, id)
        if (owner) owner.marks[GONGSUN_CHARGE] = Math.min(4, gongsunCharge(h.state, id) + 3)
      } else if (res.payload.optionId === 'discard' && player(h.state, targetId)?.alive) {
        askFieldCard(h, MOU_GONGSUNZAN_QIAOMENG, id, targetId, 'field-card', '【趫猛】：选择其区域内一张牌弃置', true, { drawForOwner: true })
      }
      return
    }
    if (r.step === 'field-card') {
      const targetId = r.data.targetId as PlayerId
      const picked = res.payload.cardIds?.[0] as string | undefined
      if (picked && player(h.state, targetId)?.alive && discardPickedFieldCard(h, targetId, picked, MOU_GONGSUNZAN_QIAOMENG)) {
        drawCards(h.state, h.rng, id, 1, (name, payload) => h.dispatch(name, payload))
      }
    }
  },
})

export const MOU_GONGSUNZAN_B34: CharacterDefinition = {
  id: 'gongsunzan-mou', name: '谋·公孙瓒', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'mou',
  skills: [
    { id: MOU_GONGSUNZAN_YICONG, name: '义从', description: '蓄力技（2/4）。每轮开始可消耗至多X点蓄力点，选择本轮你与其他角色距离-1并将等量【杀】置为“扈”，或其他角色与你距离+1并将等量【闪】置为“扈”；“扈”至多4张，可当作手牌使用或打出。' },
    { id: MOU_GONGSUNZAN_QIAOMENG, name: '趫猛', description: '你使用【杀】造成伤害后，若拥有“义从”，可选择弃置受伤角色区域内一张牌并摸一张牌，或获得3点蓄力点（至多4点）。' },
  ],
}

