// 武将册第40批（登记序号516–525）。只在十将全部技能接通并验证后汇入角色池。
import type { CharacterDefinition } from './types'
import { registerSkillRuntime, effectiveCardColor } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { drawCards } from '../../engine/draw'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { executeUseCardAction } from '../../engine/cards/basic'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { effectiveGenderOf } from '../../engine/huashen'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { GameResponse } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'

type Batch40State = SanguoshaState & {
  jieQingnangTargets?: Record<PlayerId, PlayerId[]>
  jiuyuanRedirectCards?: Record<PlayerId, CardId[]>
}

const player = (state: SanguoshaState, id: PlayerId) => state.players.find(p => p.id === id)
const alive = (state: SanguoshaState) => state.players.filter(p => p.alive)
const hand = (state: SanguoshaState, id: PlayerId): CardId[] => player(state, id)?.zones.hand ?? []
const draw = (host: SkillHost, id: PlayerId, count: number, reason: string): CardId[] => {
  const ids = drawCards(host.state, host.rng, id, count, (name, payload) => host.dispatch(name, payload))
  if (ids.length) host.dispatch('GainCard', { playerId: id, cardIds: ids, reason }, { targetId: id, cardIds: ids })
  return ids
}
const yesNo = (host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, data: Record<string, unknown> = {}) => host.askSkill({
  skillId, ownerId, step, data,
  build: id => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }] }),
})
const askCards = (host: SkillHost, skillId: string, ownerId: PlayerId, step: string, cardIds: CardId[], prompt: string, min: number, max: number, data: Record<string, unknown> = {}, optional = false) => host.askSkill({
  skillId, ownerId, step, data,
  build: id => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }),
})
const askTargets = (host: SkillHost, skillId: string, ownerId: PlayerId, step: string, candidateIds: PlayerId[], prompt: string, min: number, max: number, data: Record<string, unknown> = {}) => host.askSkill({
  skillId, ownerId, step, data,
  build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional: false, candidateIds, min, max }),
})
const respondedYes = (response: GameResponse) => (response.payload as { optionId?: string }).optionId === 'yes'
const JIE_JIUYUAN = 'jie-jiuyuan-b40'

// 界孙权【救援】：其他吴角色对自己用桃时，若体力高于主公，可改令主公回复并摸牌。
registerSkillRuntime({ id: JIE_JIUYUAN, lord: true,
  interceptPlayAction(host, lordId, action) {
    const lord = player(host.state, lordId), user = player(host.state, action.playerId)
    const cardId = action.cardIds[0]
    if (lord?.identity !== 'lord' || !user?.alive || user.id === lordId || effectiveKingdomOf(host.state, user.id) !== 'wu'
      || (action.asCardName ?? host.state.cards[cardId]?.name) !== '桃' || action.targetIds.length !== 1 || action.targetIds[0] !== user.id
      || user.hp <= lord.hp || lord.hp >= lord.maxHp || host.state.skillResolution) return false
    host.askSkill({ skillId: JIE_JIUYUAN, ownerId: lordId, step: 'redirect', data: { action }, build: id => ({
      id, kind: 'choose-option', playerId: user.id, prompt: `【救援】：是否改为令主公${lord.nickname}回复1点体力？若如此做，你摸一张牌`, timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '令主公回复并摸一张牌' }, { id: 'no', label: '自己回复' }],
    }) })
    return true
  },
  resume(host, lordId, resolution, response) {
    if (resolution.step !== 'redirect') return
    const original = resolution.data.action as Parameters<typeof executeUseCardAction>[2]
    const user = player(host.state, original.playerId)
    const lord = player(host.state, lordId)
    if (!user?.alive || !lord?.alive) return
    if (respondedYes(response) && lord.hp < lord.maxHp && user.hp > lord.hp && effectiveKingdomOf(host.state, user.id) === 'wu') {
      original.targetIds = [lordId]
      const state = host.state as Batch40State
      state.jiuyuanRedirectCards ??= {}
      state.jiuyuanRedirectCards[user.id] = [...new Set([...(state.jiuyuanRedirectCards[user.id] ?? []), original.cardIds[0]])]
    }
    executeUseCardAction(host as never, original.playerId, original, { skipPlayInterceptors: true })
  },
  triggers: [
    { event: 'Recover', handle(host, lordId, context) {
      if (context.event.targetId !== lordId || !context.event.sourceId) return
      const user = player(host.state, context.event.sourceId)
      const state = host.state as Batch40State
      const pending = state.jiuyuanRedirectCards?.[context.event.sourceId] ?? []
      const recoveredCardId = context.event.cardIds?.[0]
      if (!recoveredCardId || !pending.includes(recoveredCardId)) return
      state.jiuyuanRedirectCards![context.event.sourceId] = pending.filter(id => id !== recoveredCardId)
      if (user?.alive) draw(host, context.event.sourceId, 1, '救援')
    } },
    { event: 'AfterCardUse', handle(host, lordId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      const userId = context.event.sourceId
      if (!userId || payload.cardName !== '桃' || payload.targetIds?.[0] !== lordId || !payload.cardId) return
      const state = host.state as Batch40State
      const pending = state.jiuyuanRedirectCards?.[userId] ?? []
      if (!pending.includes(payload.cardId)) return
      state.jiuyuanRedirectCards![userId] = pending.filter(id => id !== payload.cardId)
    } },
  ],
})

// 界张辽【突袭】：放弃摸牌阶段的两张牌，改为从等量的不同角色各取得一张暗牌。
const JIE_TUXI = 'jie-tuxi-b40'
registerSkillRuntime({
  id: JIE_TUXI,
  triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || host.state.skillResolution || !alive(host.state).some(p => p.id !== ownerId && p.zones.hand.length > 0)) return
    context.cancel()
    yesNo(host, JIE_TUXI, ownerId, 'invoke', '发动【突袭】？少摸任意张牌，改为获得等量其他角色的手牌')
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if (!respondedYes(response)) { draw(host, ownerId, 2, '摸牌阶段'); return }
      const possible = alive(host.state).filter(p => p.id !== ownerId && p.zones.hand.length > 0).length
      if (!possible) { draw(host, ownerId, 2, '摸牌阶段'); return }
      host.askSkill({ skillId: JIE_TUXI, ownerId, step: 'count', build: id => ({ id, kind: 'choose-number', playerId: ownerId, prompt: '选择少摸的牌数', timeoutMs: 20_000, optional: false, min: 1, max: Math.min(2, possible) }) })
      return
    }
    if (resolution.step === 'count') {
      const count = Number((response.payload as { number?: number }).number)
      const candidates = alive(host.state).filter(p => p.id !== ownerId && p.zones.hand.length > 0).map(p => p.id)
      if (!Number.isInteger(count) || count < 1 || count > 2 || candidates.length < count) { draw(host, ownerId, 2, '摸牌阶段'); return }
      askTargets(host, JIE_TUXI, ownerId, 'targets', candidates, '选择等量的不同角色，各获得其一张手牌', count, count, { count })
      return
    }
    const targets = (response.payload as { targetIds: PlayerId[] }).targetIds
    const taken: CardId[] = []
    for (const targetId of targets) {
      const victim = player(host.state, targetId)
      if (!victim?.alive || !victim.zones.hand.length) continue
      const cardId = victim.zones.hand[host.rng.nextInt(victim.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '突袭' }, { targetId, cardIds: [cardId] })
      taken.push(cardId)
    }
    if (taken.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: '突袭' }, { targetId: ownerId, cardIds: taken })
    // 目标在请求挂起期间失去手牌时，已放弃的摸牌不会凭空补回；以结算时实际可取得的牌为准。
  },
})

// 界许褚【裸衣】：三张公开牌择取符合类型者；获得至少一张才跳过本次摸牌阶段。
const JIE_LUOYI = 'jie-luoyi-b40'
registerSkillRuntime({ id: JIE_LUOYI, triggers: [{ event: 'DrawPhase', handle(host, ownerId, context) {
  if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
  const owner = player(host.state, ownerId), top = host.state.zones.drawPile.slice(0, 3)
  if (!owner?.alive || host.state.skillResolution || !top.length) return
  context.cancel()
  host.dispatch('SkillActivated', {
    skillId: JIE_LUOYI, skillName: '裸衣', playerId: ownerId, cardIds: top,
    logText: `${owner.nickname}发动【裸衣】，亮出${top.length}张牌：${top.map(id => host.state.cards[id]?.name ?? '未知牌').join('、')}`,
  }, { sourceId: ownerId, cardIds: top })
  const legal = top.filter(cardId => {
    const card = host.state.cards[cardId]
    return card?.category === 'basic' || card?.name === '决斗' || (card?.category === 'equipment' && card.equipmentSlot === 'weapon')
  })
  if (!legal.length) {
    for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    draw(host, ownerId, 2, '摸牌阶段')
    return
  }
  host.askSkill({ skillId: JIE_LUOYI, ownerId, step: 'choose', data: { top, legal }, build: id => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【裸衣】：从亮出的牌中获得任意张基本牌、武器牌或【决斗】', timeoutMs: 25_000,
    optional: true, purpose: 'skill', cardIds: legal, viewOnlyCardIds: top, hiddenCardSlots: [], min: 0, max: legal.length,
  }) })
} }, { event: 'TurnStart', handle(host, ownerId, context) {
  if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete player(host.state, ownerId)?.marks.luoyi
} }], resume(host, ownerId, resolution, response) {
  const top = resolution.data.top as CardId[]
  const legal = resolution.data.legal as CardId[]
  const chosen = (response.payload as { cardIds: CardId[] }).cardIds.filter(id => legal.includes(id) && host.state.zones.drawPile.includes(id))
  for (const id of top) {
    if (!host.state.zones.drawPile.includes(id)) continue
    moveCard(host.state, id, { kind: 'drawPile' }, chosen.includes(id) ? { kind: 'hand', playerId: ownerId } : { kind: 'discardPile' })
  }
  if (!chosen.length) { draw(host, ownerId, 2, '摸牌阶段'); return }
  player(host.state, ownerId)!.marks.luoyi = 1
  host.dispatch('GainCard', { playerId: ownerId, cardIds: chosen, reason: '裸衣' }, { targetId: ownerId, cardIds: chosen })
} })

// 界华佗【青囊】：红色手牌支付后可继续发动，但同回合目标不重复。
const JIE_QINGNANG = 'jie-qingnang-b40'
registerSkillRuntime({ id: JIE_QINGNANG,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, JIE_QINGNANG) || !owner.zones.hand.length) return []
    const chosen = new Set((state as Batch40State).jieQingnangTargets?.[ownerId] ?? [])
    const hasTarget = alive(state).some(target => target.hp < target.maxHp && !chosen.has(target.id))
    return hasTarget ? [{ id: `skill:${JIE_QINGNANG}`, label: '发动【青囊】：弃置一张手牌令一名角色回复1点体力' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_QINGNANG}`) throw new Error('青囊动作不匹配')
    markUsedThisPhase(host.state, ownerId, JIE_QINGNANG)
    askCards(host, JIE_QINGNANG, ownerId, 'cost', hand(host.state, ownerId), '【青囊】：弃置一张手牌', 1, 1)
  },
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) delete (host.state as Batch40State).jieQingnangTargets?.[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost' || resolution.step === 'repeat-cost') {
      const cardId = (response.payload as { cardIds: CardId[] }).cardIds?.[0]
      if (!cardId || !hand(host.state, ownerId).includes(cardId)) return
      const red = effectiveCardColor(host.state, ownerId, cardId) === 'red'
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '青囊' }, { sourceId: ownerId, cardIds: [cardId] })
      const used = new Set((host.state as Batch40State).jieQingnangTargets?.[ownerId] ?? [])
      const candidates = alive(host.state).filter(target => target.hp < target.maxHp && !used.has(target.id)).map(target => target.id)
      if (!candidates.length) return
      askTargets(host, JIE_QINGNANG, ownerId, 'target', candidates, '【青囊】：选择一名未于本回合选择过的角色回复1点体力', 1, 1, { red })
      return
    }
    if (resolution.step === 'repeat') {
      if (!respondedYes(response) || !player(host.state, ownerId)?.alive || !hand(host.state, ownerId).length) return
      askCards(host, JIE_QINGNANG, ownerId, 'repeat-cost', hand(host.state, ownerId), '再次发动【青囊】：弃置一张手牌', 1, 1)
      return
    }
    const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    const owner = player(host.state, ownerId)
    if (!owner?.alive || !target?.alive || target.hp >= target.maxHp) return
    const state = host.state as Batch40State
    const used = new Set(state.jieQingnangTargets?.[ownerId] ?? [])
    if (used.has(targetId)) return
    used.add(targetId); state.jieQingnangTargets ??= {}; state.jieQingnangTargets[ownerId] = [...used]
    recover(host, targetId, 1, ownerId)
    const canRepeat = Boolean(resolution.data.red) && owner.alive && hand(host.state, ownerId).length > 0
      && alive(host.state).some(candidate => candidate.hp < candidate.maxHp && !used.has(candidate.id))
    if (canRepeat) yesNo(host, JIE_QINGNANG, ownerId, 'repeat', '弃置的是红色牌：是否再次发动【青囊】？')
  },
})

// 界华佗【急救】可以使用红色手牌或装备牌当桃；救援入口也接受装备区实体牌。
const JIE_JIJIU = 'jie-jijiu-b40'
registerSkillRuntime({ id: JIE_JIJIU, viewAs(state, ownerId) {
  if (state.currentPlayerId === ownerId) return []
  const owner = player(state, ownerId)
  if (!owner) return []
  const ids = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  return ids.filter(id => effectiveCardColor(state, ownerId, id) === 'red').map(cardId => ({
    asCardName: '桃', cardId, label: `将【${state.cards[cardId]?.name ?? '红色牌'}】当【桃】使用`,
  }))
} })

// 界吕布【利驭】：伤害后获得目标区域牌；装备牌分支由受伤者决定决斗对象。
const JIE_LIYU = 'jie-liyu-b40'
registerSkillRuntime({ id: JIE_LIYU,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    const event = context.event
    if (event.sourceId !== ownerId || event.payload.cardName !== '杀' || !event.targetId || event.targetId === ownerId) return
    const target = player(host.state, event.targetId)
    if (!target?.alive || !hasPickableCards(host.state, event.targetId, { includeJudgingArea: true })) return
    host.queueSkill({ skillId: JIE_LIYU, ownerId, step: 'ask', data: { targetId: event.targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!player(host.state, ownerId)?.alive || !target?.alive) return
    const pickable = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
    if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
    host.askSkill({ skillId: JIE_LIYU, ownerId, step: 'take', data: { targetId }, build: id => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【利驭】：获得${target.nickname}区域里的一张牌`, timeoutMs: 25_000, optional: true,
      purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take') {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const owner = player(host.state, ownerId)
      const selected = (response.payload as { cardIds: CardId[] }).cardIds?.[0]
      if (!target?.alive || !owner?.alive || !selected) return
      const cardId = resolvePickedCard(host.state, targetId, selected)
      const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
      if (!cardId || !from) return
      const isEquipment = from.kind === 'equipment' && host.state.cards[cardId]?.category === 'equipment'
      if (!movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      if (isEquipment) host.dispatch('LoseEquipment', { playerId: targetId, cardIds: [cardId], reason: '利驭' }, { targetId, cardIds: [cardId] })
      else host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: '利驭' }, { targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: '利驭' }, { targetId: ownerId, cardIds: [cardId] })
      if (!isEquipment) { if (target.alive) draw(host, targetId, 1, '利驭'); return }
      const candidates = alive(host.state).filter(p => p.id !== targetId).map(p => p.id)
      if (!candidates.length) return
      host.askSkill({ skillId: JIE_LIYU, ownerId, step: 'duel-target', data: { targetId }, build: id => ({
        id, kind: 'choose-targets', playerId: targetId, prompt: '【利驭】：选择一名角色，令其成为【决斗】目标', timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    const [duelTargetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    if (duelTargetId && player(host.state, ownerId)?.alive && player(host.state, duelTargetId)?.alive) {
      host.beginVirtualTrick({ sourceId: ownerId, targetId: duelTargetId, cardName: '决斗', sourceSkillId: JIE_LIYU })
    }
  },
})

// SP黄月英【机巧】：弃置装备牌后翻开等量双倍牌，收取其中全部锦囊牌。
const SP_JIQIAO = 'sp-jiqiao-b40'
const SP_LINGLONG = 'sp-linglong-b40'
registerSkillRuntime({ id: SP_JIQIAO, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
  const owner = player(host.state, ownerId)
  if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.alive || host.state.skillResolution) return
  const handEquip = owner.zones.hand.filter(id => host.state.cards[id]?.category === 'equipment')
  const equipped = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
  if (!handEquip.length && !equipped.length) return
  yesNo(host, SP_JIQIAO, ownerId, 'invoke', '【机巧】：是否弃置装备牌并亮出牌堆顶两倍数量的牌？', { candidates: [...handEquip, ...equipped] })
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if (!respondedYes(response)) return
    const candidates = (resolution.data.candidates as CardId[]).filter(id => {
      const owner = player(host.state, ownerId)
      return Boolean(owner?.zones.hand.includes(id) || Object.values(owner?.zones.equipment ?? {}).includes(id))
    })
    askCards(host, SP_JIQIAO, ownerId, 'discard', candidates, '【机巧】：选择要弃置的装备牌', 1, candidates.length)
    return
  }
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
  const discarded: CardId[] = []
  for (const cardId of cardIds) {
    if (owner.zones.hand.includes(cardId)) {
      if (host.state.cards[cardId]?.category !== 'equipment') continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }); discarded.push(cardId)
    } else {
      const slot = (Object.keys(owner.zones.equipment) as EquipmentSlot[]).find(key => owner.zones.equipment[key] === cardId)
      if (!slot) continue
      moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
      host.dispatch('LoseEquipment', { playerId: ownerId, cardIds: [cardId], reason: '机巧' }, { targetId: ownerId, cardIds: [cardId] })
      discarded.push(cardId)
    }
  }
  if (!discarded.length) return
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: '机巧' }, { sourceId: ownerId, cardIds: discarded })
  const revealed = host.state.zones.drawPile.slice(0, discarded.length * 2)
  const tricks = revealed.filter(id => host.state.cards[id]?.category === 'trick')
  host.dispatch('SkillActivated', {
    skillId: SP_JIQIAO, skillName: '机巧', playerId: ownerId, cardIds: revealed,
    logText: `${owner.nickname}发动【机巧】，亮出${revealed.length}张牌：${revealed.map(id => host.state.cards[id]?.name ?? '未知牌').join('、')}`,
  }, { sourceId: ownerId, cardIds: revealed })
  for (const cardId of revealed) {
    if (!host.state.zones.drawPile.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'drawPile' }, tricks.includes(cardId) ? { kind: 'hand', playerId: ownerId } : { kind: 'discardPile' })
  }
  if (tricks.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: tricks, reason: '机巧', revealed: true }, { targetId: ownerId, cardIds: tricks })
} })
registerSkillRuntime({ id: SP_LINGLONG,
  ignoresTrickDistance: true,
  virtualArmor(state, ownerId) {
    return player(state, ownerId)?.zones.equipment.armor ? null : '八卦阵'
  },
  maxCardsBonus(state, ownerId) {
    const equipment = player(state, ownerId)?.zones.equipment
    return equipment && !equipment.offensiveHorse && !equipment.defensiveHorse ? 1 : 0
  },
})

// 界黄月英【集智】【奇才】。
const JIE_JIZHI = 'jie-jizhi-b40'
const JIE_QICAI = 'jie-qicai-b40'
registerSkillRuntime({ id: JIE_JIZHI,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.sourceId !== ownerId || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (!card || card.category !== 'trick' || ['乐不思蜀', '兵粮寸断', '闪电'].includes(card.name)) return
      if (!player(host.state, ownerId)?.alive || host.state.skillResolution) return
      yesNo(host, JIE_JIZHI, ownerId, 'draw', '发动【集智】：摸一张牌', { usedCardId: payload.cardId })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId && player(host.state, ownerId)) delete player(host.state, ownerId)!.marks.jieJizhiHandLimit
    } },
  ],
  maxCardsBonus(state, ownerId) { return player(state, ownerId)?.marks.jieJizhiHandLimit ?? 0 },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw') {
      if (!respondedYes(response) || !player(host.state, ownerId)?.alive) return
      const cardId = draw(host, ownerId, 1, '集智')[0]
      if (cardId && host.state.cards[cardId]?.category === 'basic') yesNo(host, JIE_JIZHI, ownerId, 'discard-basic', '是否弃置刚摸到的基本牌，并令本回合手牌上限+1？', { cardId })
      return
    }
    if (resolution.step !== 'discard-basic' || !respondedYes(response)) return
    const cardId = resolution.data.cardId as CardId
    if (!hand(host.state, ownerId).includes(cardId) || host.state.cards[cardId]?.category !== 'basic') return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '集智' }, { sourceId: ownerId, cardIds: [cardId] })
    const owner = player(host.state, ownerId)
    if (owner) owner.marks.jieJizhiHandLimit = (owner.marks.jieJizhiHandLimit ?? 0) + 1
  },
})
registerSkillRuntime({ id: JIE_QICAI,
  ignoresTrickDistance: true,
  protectsCardFromDiscard(state, ownerId, cardId, sourceId) {
    if (sourceId === ownerId) return false
    const slot = (Object.keys(player(state, ownerId)?.zones.equipment ?? {}) as EquipmentSlot[]).find(key => player(state, ownerId)?.zones.equipment[key] === cardId)
    return Boolean(slot && (slot === 'armor' || slot === 'treasure'))
  },
})

// 界诸葛亮【观星】：准备阶段观顶；全部置底时才获得结束阶段再观一次的机会。
const JIE_GUANXING = 'jie-guanxing-b40'
const GUANXING_REPEAT = 'jieGuanxingRepeatB40'
function requestGuanxing(host: SkillHost, ownerId: PlayerId, step: string): void {
  const living = alive(host.state).length
  const count = Math.min(living < 4 ? 3 : 5, host.state.zones.drawPile.length)
  if (!count) return
  const cardIds = host.state.zones.drawPile.slice(0, count)
  host.askSkill({ skillId: JIE_GUANXING, ownerId, step, data: { cardIds }, build: id => ({
    id, kind: 'arrange-cards', playerId: ownerId,
    prompt: `【观星】：查看牌堆顶${count}张，以任意顺序放回牌堆顶或牌堆底`, timeoutMs: 30_000, optional: false,
    cardIds, minTop: 0, maxTop: count, allowBottom: true,
  }) })
}
registerSkillRuntime({ id: JIE_GUANXING,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare' || !player(host.state, ownerId)?.alive || host.state.skillResolution) return
      yesNo(host, JIE_GUANXING, ownerId, 'prepare-invoke', '是否发动【观星】？')
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'finish' || !player(host.state, ownerId)?.marks[GUANXING_REPEAT] || host.state.skillResolution) return
      delete player(host.state, ownerId)!.marks[GUANXING_REPEAT]
      yesNo(host, JIE_GUANXING, ownerId, 'finish-invoke', '准备阶段曾将观星牌全部置于牌堆底，是否于结束阶段再次观星？')
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId && player(host.state, ownerId)) delete player(host.state, ownerId)!.marks[GUANXING_REPEAT]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'prepare-invoke') {
      if (respondedYes(response)) requestGuanxing(host, ownerId, 'prepare-arrange')
      return
    }
    if (resolution.step === 'finish-invoke') {
      if (respondedYes(response)) requestGuanxing(host, ownerId, 'finish-arrange')
      return
    }
    const original = resolution.data.cardIds as CardId[]
    const { top, bottom } = response.payload as { top: CardId[]; bottom: CardId[] }
    const observed = new Set(original)
    const stillThere = (id: CardId) => host.state.zones.drawPile.includes(id)
    const untouched = host.state.zones.drawPile.filter(id => !observed.has(id))
    host.state.zones.drawPile = [...top.filter(stillThere), ...untouched, ...bottom.filter(stillThere)]
    const owner = player(host.state, ownerId)
    if (owner) owner.marks[GUANXING_REPEAT] = resolution.step === 'prepare-arrange' && top.length === 0 ? 1 : 0
  },
})

// 界孙权【制衡】：弃置区域内任意张牌，若弃掉全部手牌则额外摸一张。
const JIE_ZHIHENG = 'jie-zhiheng-b40'
registerSkillRuntime({ id: JIE_ZHIHENG,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const field = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, JIE_ZHIHENG) || !field.length) return []
    return [{ id: `skill:${JIE_ZHIHENG}`, label: '发动【制衡】：弃置任意张牌并摸等量牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_ZHIHENG}`) throw new Error('制衡动作不匹配')
    const owner = player(host.state, ownerId)!
    const field = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    askCards(host, JIE_ZHIHENG, ownerId, 'discard', field, '【制衡】：选择要弃置的牌', 1, field.length)
  },
  resume(host, ownerId, _resolution, response) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    const originalHandCount = owner.zones.hand.length
    const selected = (response.payload as { cardIds: CardId[] }).cardIds
    const discardedHandCount = selected.filter(id => owner.zones.hand.includes(id)).length
    const discarded: CardId[] = []
    for (const cardId of selected) {
      if (owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }); discarded.push(cardId)
      } else {
        const slot = (Object.keys(owner.zones.equipment) as EquipmentSlot[]).find(key => owner.zones.equipment[key] === cardId)
        if (!slot) continue
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        host.dispatch('LoseEquipment', { playerId: ownerId, cardIds: [cardId], reason: '制衡' }, { targetId: ownerId, cardIds: [cardId] })
        discarded.push(cardId)
      }
    }
    if (!discarded.length) return
    markUsedThisPhase(host.state, ownerId, JIE_ZHIHENG)
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: '制衡' }, { sourceId: ownerId, cardIds: discarded })
    draw(host, ownerId, discarded.length + (originalHandCount > 0 && discardedHandCount === originalHandCount ? 1 : 0), '制衡')
  },
})

// 界孙尚香【结姻】：先选男性角色，再弃手牌或把装备移入其对应装备栏。
const JIE_JIEYIN = 'jie-jieyin-b40'
function jieyinInstallCandidates(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[] {
  const owner = player(state, ownerId)
  if (!owner) return []
  const equipment = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  return equipment.filter(cardId => {
    const card = state.cards[cardId]
    return card?.category === 'equipment' && !!card.equipmentSlot && equipmentSlotsOf(state, targetId).includes(card.equipmentSlot)
  })
}
function askJieyinMethod(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = player(host.state, ownerId), target = player(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  const options = [
    ...(owner.zones.hand.length ? [{ id: 'discard', label: '弃置一张手牌' }] : []),
    ...(jieyinInstallCandidates(host.state, ownerId, targetId).length ? [{ id: 'install', label: '将一张装备牌置入其装备区' }] : []),
  ]
  if (!options.length) return
  host.askSkill({ skillId: JIE_JIEYIN, ownerId, step: 'method', data: { targetId }, build: id => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【结姻】：选择对${target.nickname}交付牌的方式`, timeoutMs: 25_000, optional: false, options,
  }) })
}
registerSkillRuntime({ id: JIE_JIEYIN,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, JIE_JIEYIN)) return []
    const males = alive(state).filter(target => target.id !== ownerId && target.characterId && effectiveGenderOf(state, target.id) === 'male')
    const canPay = owner.zones.hand.length > 0 || males.some(target => jieyinInstallCandidates(state, ownerId, target.id).length > 0)
    return males.length && canPay ? [{ id: `skill:${JIE_JIEYIN}`, label: '发动【结姻】：选择男性角色并交付一张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${JIE_JIEYIN}`) throw new Error('结姻动作不匹配')
    const candidates = alive(host.state).filter(target => target.id !== ownerId && target.characterId && effectiveGenderOf(host.state, target.id) === 'male').map(target => target.id)
    askTargets(host, JIE_JIEYIN, ownerId, 'target', candidates, '【结姻】：选择一名男性角色', 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined, owner = player(host.state, ownerId)
      if (!owner?.alive || !target?.alive || !target.characterId || effectiveGenderOf(host.state, targetId!) !== 'male') return
      askJieyinMethod(host, ownerId, targetId!)
      return
    }
    if (resolution.step === 'method') {
      const targetId = resolution.data.targetId as PlayerId
      const method = (response.payload as { optionId?: string }).optionId
      const cardIds = method === 'discard' ? hand(host.state, ownerId) : method === 'install' ? jieyinInstallCandidates(host.state, ownerId, targetId) : []
      if (!cardIds.length) return
      askCards(host, JIE_JIEYIN, ownerId, 'payment', cardIds, method === 'discard' ? '【结姻】：选择弃置的一张手牌' : '【结姻】：选择置入目标装备区的装备牌', 1, 1, { targetId, method })
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const owner = player(host.state, ownerId), target = player(host.state, targetId)
    const cardId = (response.payload as { cardIds: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !target?.alive || !cardId || usedThisPhase(host.state, ownerId, JIE_JIEYIN)) return
    const method = resolution.data.method as 'discard' | 'install'
    const sourceSlot = (Object.keys(owner.zones.equipment) as EquipmentSlot[]).find(slot => owner.zones.equipment[slot] === cardId)
    if (method === 'discard') {
      if (!owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '结姻' }, { sourceId: ownerId, cardIds: [cardId] })
    } else {
      const slot = sourceSlot ?? host.state.cards[cardId]?.equipmentSlot
      if (!slot || !jieyinInstallCandidates(host.state, ownerId, targetId).includes(cardId) || !equipmentSlotsOf(host.state, targetId).includes(slot)) return
      const from = sourceSlot ? { kind: 'equipment' as const, playerId: ownerId, slot: sourceSlot } : { kind: 'hand' as const, playerId: ownerId }
      const replaced = target.zones.equipment[slot]
      moveCard(host.state, cardId, from, { kind: 'equipment', playerId: targetId, slot })
      if (sourceSlot) {
        handleEquipmentLost(host as never, ownerId, cardId)
        host.dispatch('FieldCardMoved', { cardId, fromPlayerId: ownerId, toPlayerId: targetId, zone: 'equipment', slot }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      } else host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: '结姻' }, { sourceId: ownerId, cardIds: [cardId] })
      if (replaced) handleEquipmentLost(host as never, targetId, replaced)
    }
    markUsedThisPhase(host.state, ownerId, JIE_JIEYIN)
    const currentOwner = player(host.state, ownerId), currentTarget = player(host.state, targetId)
    if (!currentOwner?.alive || !currentTarget?.alive) return
    if (currentOwner.hp > currentTarget.hp) {
      draw(host, ownerId, 1, '结姻')
      recover(host, targetId, 1, ownerId)
    } else if (currentOwner.hp < currentTarget.hp) {
      recover(host, ownerId, 1, ownerId)
      draw(host, targetId, 1, '结姻')
    } // 体力值相同，无高低者，依技能文本不执行两项互斥效果。
  },
})

export const HISTORICAL_BATCH38_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-zhangliao-b40', name: '界·张辽', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_TUXI, name: '突袭', description: '摸牌阶段，你可以少摸任意张牌并获得等量的其他角色各一张手牌。' },
  ] },
  { id: 'jie-xuchu-b40', name: '界·许褚', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_LUOYI, name: '裸衣', description: '摸牌阶段开始时，你亮出牌堆顶三张牌，然后你可以获得其中的基本牌、武器牌和【决斗】。若如此做，你放弃摸牌，且你为伤害来源的【杀】和【决斗】造成的伤害+1直到你的下回合开始。' },
  ] },
  { id: 'jie-guojia-b40', name: '界·郭嘉', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: 'tiandu', name: '天妒', description: '当你的判定牌生效后，你可以获得此牌。' },
    { id: 'yiji', name: '遗计', description: '当你受到1点伤害后，你可以摸两张牌，然后你可以将至多两张手牌交给一至两名其他角色。' },
  ] },
  { id: 'jie-huatuo-b40', name: '界·华佗', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIE_JIJIU, name: '急救', description: '你的回合外，你可以将一张红色牌当【桃】使用。' },
    { id: JIE_QINGNANG, name: '青囊', description: '出牌阶段限一次，你可以弃置一张手牌并令一名角色回复1点体力。若你弃置的牌为红色，则可以再次发动此技能，但不能选择本回合选择过的角色。' },
  ] },
  { id: 'jie-lvbu-b40', name: '界·吕布', kingdom: 'qun', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: 'wushuang', name: '无双', description: '锁定技，你使用的【杀】需两张【闪】才能抵消；与你进行【决斗】的角色每次需打出两张【杀】。' },
    { id: JIE_LIYU, name: '利驭', description: '当你使用【杀】对一名其他角色造成伤害后，你可获得其区域里的一张牌。然后若获得的牌不是装备牌，其摸一张牌；若获得的牌是装备牌，则视为你对由其指定的另一名角色使用一张【决斗】。' },
  ] },
  { id: 'sp-huangyueying-b40', name: 'SP·黄月英', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: SP_JIQIAO, name: '机巧', description: '出牌阶段开始时，你可以弃置任意张装备牌，然后你亮出牌堆顶两倍数量的牌，获得其中的锦囊牌。' },
    { id: SP_LINGLONG, name: '玲珑', description: '锁定技，你视为拥有“奇才”；若你的装备区里没有防具牌，你视为装备着【八卦阵】；若你的装备区里没有坐骑牌，你的手牌上限+1。' },
  ] },
  { id: 'jie-huangyueying-b40', name: '界·黄月英', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: JIE_JIZHI, name: '集智', description: '当你使用一张普通锦囊牌时，你可以摸一张牌。若此牌是基本牌，你可以弃置此牌然后本回合手牌上限+1。' },
    { id: JIE_QICAI, name: '奇才', description: '锁定技，你使用锦囊牌无距离限制；其他角色不能弃置你装备区里的防具和宝物牌。' },
  ] },
  { id: 'jie-zhugeliang-b40', name: '界·诸葛亮', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIE_GUANXING, name: '观星', description: '准备阶段，你可以观看牌堆顶的五张牌（存活人数小于4时改为三张），然后以任意顺序放回牌堆顶或牌堆底。若你将这些牌均放至牌堆底，则结束阶段你可以再进行一次“观星”。' },
    { id: 'kongcheng', name: '空城', description: '锁定技，若你没有手牌，则你不能被选择为【杀】或【决斗】的目标。' },
  ] },
  { id: 'jie-sunquan-b40', name: '界·孙权', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: JIE_ZHIHENG, name: '制衡', description: '出牌阶段限一次，你可以弃置任意张牌，然后摸等量的牌。若你以此法弃置了所有的手牌，则额外摸一张牌。' },
    { id: JIE_JIUYUAN, name: '救援', description: '主公技，其他吴势力角色对其自己使用【桃】时，若其体力值大于你，则该角色可以改为令你回复1点体力，然后其摸一张牌。' },
  ] },
  { id: 'jie-sunshangxiang-b40', name: '界·孙尚香', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: JIE_JIEYIN, name: '结姻', description: '出牌阶段限一次，选择一名男性角色，弃置一张手牌或将一张装备牌置入其装备区：你与其体力值较高的角色摸一张牌，体力值较低的角色回复1点体力。' },
    { id: 'xiaoji', name: '枭姬', description: '当你失去装备区里的一张牌时，你可以摸两张牌。' },
  ] },
]
