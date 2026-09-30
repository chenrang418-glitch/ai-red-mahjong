// 武将册第36批（武将册序号475–485，跳过已登记的SP·公孙瓒）。
// @ts-nocheck
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { registerSkillRuntime, type SkillHost, effectiveCardColor, effectiveCardSuit, characterSkillIdsOf, getSkillRuntime, grantSkill } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { gainMaxHp, loseMaxHp, loseHp } from '../../engine/hp'
import { moveCard, locateOwnedCard, setCardAlias } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { suppressSkill } from '../../engine/skill-suppression'
import { detainCards } from '../../engine/turn-bound-pile'
import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { resolveDamage, resumeDamageModifier } from '../../engine/damage'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { skipPhase } from '../../engine/turn'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { getAttackRange as attackRangeOf } from '../../engine/distance'
import { revealTopCards } from '../../engine/draw'

type S36 = SanguoshaState & { b36?: Record<string, any> }
const s36 = (h: SkillHost) => h.state as S36
const player = (s: SanguoshaState, id: PlayerId) => s.players.find(p => p.id === id)
const alive = (s: SanguoshaState) => s.players.filter(p => p.alive)
const others = (s: SanguoshaState, id: PlayerId) => alive(s).filter(p => p.id !== id)
const key = (skill: string, suffix = '') => suffix ? `${skill}:${suffix}` : skill
const get = (s: S36, k: string) => s.b36?.[k]
const put = (h: SkillHost, k: string, v: any) => { s36(h).b36 ??= {}; s36(h).b36[k] = v; return v }
const remove = (s: S36, k: string) => { if (s.b36) delete s.b36[k] }
function askOption(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string, options: any[], data: any = {}, optional = true, interaction?: any) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 30_000, optional, options, ...(interaction ? { interaction } : {}) }) })
}
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, ids: PlayerId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds: ids, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, step: string, ids: CardId[], prompt: string, min: number, max: number, data: any = {}, optional = false) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 25_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}
function discard(h: SkillHost, ownerId: PlayerId, cardIds: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(cardIds)]) {
    const from = locateOwnedCard(h.state, ownerId, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(h as never, ownerId, cardId)
    moved.push(cardId)
  }
  if (moved.length) h.dispatch('LoseCard', { playerId: ownerId, cardIds: moved, reason }, { sourceId: ownerId, cardIds: moved })
  return moved
}
function gain(h: SkillHost, ownerId: PlayerId, cardId: CardId, reason: string) {
  if (!h.state.zones.discardPile.includes(cardId)) return false
  moveCard(h.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
  h.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason }, { targetId: ownerId, cardIds: [cardId] })
  return true
}

const LIUZAN_FENYIN = 'fenyin-b36'
const RUANHUI_MINGCHA = 'mingcha-b36', RUANHUI_JINGZHONG = 'jingzhong-b36'
const XUSHENG_POJUN = 'pojun', XUSHENG_ZHENFENG = 'zhenfeng-jie-b36'
const GUANYU_WUSHENG_DISTANCE = 'wusheng-jie-distance-b36', GUANYU_YIJUE = 'yijue-jie-b36'
const SUNHAN_CHONGXU = 'chongxu-b36', SUNHAN_MIAOJIAN = 'miaojian-b36', SUNHAN_LIANHUA = 'lianhua-b36'
const LINGJU_JIEYUAN = 'jieyuan-b36', LINGJU_FENXIN = 'fenxin-b36'
const YUANSHU_YONGSI = 'yongsi-jie-b36', YUANSHU_JIXI = 'jixi-b36', YUANSHU_WANGZUN = 'wangzun-b36'
const SUNSHANG_LIANGZHU = 'liangzhu-sp-b36', SUNSHANG_FANXIANG = 'fanxiang-sp-b36', SUNSHANG_XIAOJI = 'xiaoji-sp-b36'
const PANDE_MASHU = 'mashu-sp-pande-b36', PANDE_JUESI = 'juesi-sp-pande-b36'
const SPGUAN_DANQI = 'danqi-sp-guanyu-b36', SPGUAN_NUZHAN = 'nuzhan-sp-guanyu-b36'
const LIANHUA_JUDGE = 'sunhanhua-lianhua-b36'

function sunHanAssassinationTargets(state: SanguoshaState, ownerId: PlayerId) {
  return others(state, ownerId).filter(p => canTarget(state, ownerId, p.id) && getDistance(state, ownerId, p.id) <= attackRangeOf(state, ownerId))
}

function swapIdentity(host: SkillHost, aId: PlayerId, bId: PlayerId) {
  const a = player(host.state, aId), b = player(host.state, bId)
  if (!a || !b || a.identity === b.identity) return
  const lordBonus = host.state.players.length >= 5
  const aWasLord = a.identity === 'lord', bWasLord = b.identity === 'lord'
  ;[a.identity, b.identity] = [b.identity, a.identity]
  a.identityRevealed = true
  b.identityRevealed = true
  if (lordBonus && aWasLord !== bWasLord) {
    const newLord = aWasLord ? b : a, formerLord = aWasLord ? a : b
    newLord.maxHp += 1
    formerLord.maxHp = Math.max(1, formerLord.maxHp - 1)
    formerLord.hp = Math.min(formerLord.hp, formerLord.maxHp)
  }
}

// 留赞【奋音】：当前回合的牌色与上一张使用牌色不同才摸牌；无色牌不会覆盖上次颜色。
registerSkillRuntime({ id: LIUZAN_FENYIN, triggers: [{ event: 'CardUsed', handle(h, id, c) {
  if (c.event.sourceId !== id || h.state.currentPlayerId !== id) return
  const p = c.event.payload as any, cardId = p.cardId as CardId | undefined
  if (!cardId) return
  const card = h.state.cards[cardId]
  if (!card || card.virtual) return
  const color = effectiveCardColor(h.state, id, cardId)
  if (!color) return
  const k = key(LIUZAN_FENYIN, `${id}:${h.state.turnNumber}`), previous = get(s36(h), k)
  if (previous && previous !== color) drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data))
  put(h, k, color)
} }] })

// 阮慧【明察】：合法牌替代摸牌，揭示三张顶牌；每张点数≤8可获得，拿牌即放弃正常摸牌。
registerSkillRuntime({ id: RUANHUI_MINGCHA, triggers: [{ event: 'DrawPhase', handle(h, id, c) {
  if (!takeOverDrawPhase(h, id, c)) return
  const top = revealTopCards(h.state, h.rng, 3, RUANHUI_MINGCHA, (n, data) => h.dispatch(n, data))
  if (!top.length) return
  const eligible = top.filter(cardId => (h.state.cards[cardId]?.rank ?? 14) <= 8)
  if (!eligible.length) {
    for (const cardId of top.slice().reverse()) moveCard(h.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    drawCards(h.state, h.rng, id, 2, (n, data) => h.dispatch(n, data)); return
  }
  askCards(h, RUANHUI_MINGCHA, id, 'take', eligible, '【明察】：获得其中点数不大于8的牌（若获得则放弃摸牌）', 0, eligible.length, { top })
} }], resume(h, id, r, res) {
  if (r.step === 'rob') {
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined, target = targetId && player(h.state, targetId)
    if (!target?.alive || target.id === id) return
    const cards = [...target.zones.hand, ...Object.values(target.zones.equipment).filter(Boolean), ...target.zones.judgingArea]
    if (!cards.length) return
    const cardId = cards[h.rng.nextInt(cards.length)]
    const from = locateOwnedCard(h.state, target.id, cardId)
    if (!from) return
    moveCard(h.state, cardId, from, { kind: 'hand', playerId: id })
    if (from.kind === 'equipment') handleEquipmentLost(h, target.id, cardId)
    h.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: RUANHUI_MINGCHA }, { sourceId: target.id, targetId: id, cardIds: [cardId] })
    h.dispatch('GainCard', { playerId: id, cardIds: [cardId], reason: RUANHUI_MINGCHA }, { sourceId: target.id, targetId: id, cardIds: [cardId] })
    return
  }
  if (r.step !== 'take') return
  const chosen = [...new Set(res.payload.cardIds ?? [])].filter(cardId => r.data.top.includes(cardId) && h.state.zones.processingArea.includes(cardId) && h.state.cards[cardId]?.rank <= 8)
  if (!chosen.length) {
    for (const cardId of r.data.top.slice().reverse()) if (h.state.zones.processingArea.includes(cardId)) moveCard(h.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    drawCards(h.state, h.rng, id, 2, (n, data) => h.dispatch(n, data)); return
  }
  for (const cardId of chosen) moveCard(h.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: id })
  for (const cardId of r.data.top.filter((cardId: CardId) => !chosen.includes(cardId)).reverse()) {
    if (h.state.zones.processingArea.includes(cardId)) moveCard(h.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
  h.dispatch('GainCard', { playerId: id, cardIds: chosen, reason: RUANHUI_MINGCHA }, { targetId: id, cardIds: chosen })
  const targets = others(h.state, id).filter(p => p.zones.hand.length || p.zones.judgingArea.length || Object.values(p.zones.equipment).some(Boolean))
  if (targets.length) askTargets(h, RUANHUI_MINGCHA, id, 'rob', targets.map(p => p.id), '【明察】：随机获得一名其他角色的一张牌', { targets: targets.map(p => p.id) }, true)
} })

// 阮慧【敬重】：仅在本次弃牌阶段弃置至少两张黑牌后建立一个目标回合窗口；
// 对方每张使用后仍留在弃牌堆的牌，逐张询问是否取回，最多成功取回三张。
registerSkillRuntime({ id: RUANHUI_JINGZHONG,
  triggers: [
    { event: 'LoseCard', handle(h, id, c) {
      const p = c.event.payload as any
      if (p.playerId !== id || p.reason !== 'discard-phase' || c.event.phase !== 'discard') return
      const count = (p.cardIds ?? []).filter((cardId: CardId) => effectiveCardColor(h.state, id, cardId) === 'black').length
      if (!count) return
      const mark = key(RUANHUI_JINGZHONG, `discard:${id}:${h.state.turnNumber}`)
      put(h, mark, (get(s36(h), mark) ?? 0) + count)
    } },
    { event: 'PhaseEnd', handle(h, id, c) {
      const p = c.event.payload as any
      if (p.playerId !== id || p.phase !== 'discard') return
      const mark = key(RUANHUI_JINGZHONG, `discard:${id}:${h.state.turnNumber}`)
      if ((get(s36(h), mark) ?? 0) < 2) { remove(s36(h), mark); return }
      remove(s36(h), mark)
      const targets = others(h.state, id)
      if (!targets.length) return
      askTargets(h, RUANHUI_JINGZHONG, id, 'target', targets.map(p => p.id), '【敬重】：选择一名角色，在其下个出牌阶段追还使用后仍在弃牌堆的牌', {}, true)
    } },
    { event: 'AfterCardUse', handle(h, id, c) {
      const p = c.event.payload as any, current = h.state.currentPlayerId
      const window = get(s36(h), key(RUANHUI_JINGZHONG, `window:${id}`))
      if (!window || window.targetId !== current || h.state.phase !== 'play' || !p.cardId || !h.state.zones.discardPile.includes(p.cardId) || window.gained >= 3) return
      h.queueSkill({ skillId: RUANHUI_JINGZHONG, ownerId: id, step: 'claim', data: { targetId: current, cardId: p.cardId, cardName: p.cardName, turnNumber: h.state.turnNumber } })
    } },
    { event: 'TurnEnd', handle(h, id, c) {
      const p = c.event.payload as any
      const window = get(s36(h), key(RUANHUI_JINGZHONG, `window:${id}`))
      if (window?.targetId === p.playerId) remove(s36(h), key(RUANHUI_JINGZHONG, `window:${id}`))
    } },
  ],
  resume(h, id, r, res) {
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      if (targetId && targetId !== id && player(h.state, targetId)?.alive) put(h, key(RUANHUI_JINGZHONG, `window:${id}`), { targetId, gained: 0 })
      return
    }
    if (r.step === 'offer') {
      const window = get(s36(h), key(RUANHUI_JINGZHONG, `window:${id}`)), cardId = r.data.cardId as CardId
      if (res.payload.optionId !== 'yes' || !window || window.targetId !== r.data.targetId || window.gained >= 3
        || h.state.turnNumber !== r.data.turnNumber || !h.state.zones.discardPile.includes(cardId)) return
      if (gain(h, id, cardId, RUANHUI_JINGZHONG)) window.gained += 1
      return
    }
  },
  startQueued(h, id, q) {
    if (q.step !== 'claim') return
    const window = get(s36(h), key(RUANHUI_JINGZHONG, `window:${id}`)), cardId = q.data.cardId as CardId
    if (!window || window.targetId !== q.data.targetId || window.gained >= 3 || h.state.turnNumber !== q.data.turnNumber || !h.state.zones.discardPile.includes(cardId)) return
    askOption(h, RUANHUI_JINGZHONG, id, 'offer', `【敬重】：是否追还${q.data.cardName ? `【${q.data.cardName}】` : '此牌'}？`, [
      { id: 'yes', label: '尝试追还' }, { id: 'no', label: '跳过这张牌' },
    ], { ...q.data })
  },
})

// 界袁术【庸肆】【觊玺】【妄尊】。
registerSkillRuntime({ id: YUANSHU_YONGSI,
  triggers: [
    { event: 'DrawPhase', handle(h, id, c) {
      if (!takeOverDrawPhase(h, id, c)) return
      const count = livingKingdomCount(h.state)
      if (count) drawCards(h.state, h.rng, id, count, (n, data) => h.dispatch(n, data))
    } },
    { event: 'DiscardPhase', handle(h, id, c) {
      if ((c.event.payload as any).playerId !== id || !player(h.state, id)?.alive) return
      const owner = player(h.state, id)
      const discardable = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter(Boolean)]
      if (!discardable.length) { loseHp(h, id, 1, YUANSHU_YONGSI); return }
      askOption(h, YUANSHU_YONGSI, id, 'discard-choice', '【庸肆】：弃置一张牌或失去1点体力', [
        { id: 'discard', label: '弃置一张牌' }, { id: 'hp', label: '失去1点体力' },
      ], {}, false)
    } },
  ],
  resume(h, id, r, res) {
    if (r.step === 'discard-choice' && res.payload.optionId === 'discard') {
      const owner = player(h.state, id)
      const discardable = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter(Boolean)] : []
      if (discardable.length) askCards(h, YUANSHU_YONGSI, id, 'discard-card', discardable, '【庸肆】：弃置一张牌', 1, 1)
      else loseHp(h, id, 1, YUANSHU_YONGSI)
    } else if (r.step === 'discard-choice' && res.payload.optionId === 'hp') loseHp(h, id, 1, YUANSHU_YONGSI)
    else if (r.step === 'discard-card') {
      const cardId = res.payload.cardIds?.[0] as CardId | undefined
      if (cardId && locateOwnedCard(h.state, id, cardId)) discard(h, id, [cardId], YUANSHU_YONGSI)
    }
  },
})
function availableLordSkills(state: SanguoshaState, ownerId: PlayerId) {
  const lord = state.players.find(p => p.alive && p.identity === 'lord')
  if (!lord?.characterId) return []
  return characterSkillIdsOf(lord.characterId).filter(skillId => getSkillRuntime(skillId)?.lord
    && !characterSkillIdsOf(player(state, ownerId)?.characterId ?? '').includes(skillId))
}
registerSkillRuntime({ id: YUANSHU_JIXI, triggers: [
  { event: 'LoseHp', handle(h, id, c) {
    if ((c.event.payload as any).playerId !== id) return
    put(h, key(YUANSHU_JIXI, `lost:${id}:${h.state.turnNumber}`), true)
    put(h, key(YUANSHU_JIXI, `streak:${id}`), 0)
  } },
  { event: 'TurnEnd', handle(h, id, c) {
    if ((c.event.payload as any).playerId !== id || !player(h.state, id)?.alive) return
    const lostKey = key(YUANSHU_JIXI, `lost:${id}:${h.state.turnNumber}`), lost = get(s36(h), lostKey)
    remove(s36(h), lostKey)
    const streakKey = key(YUANSHU_JIXI, `streak:${id}`), streak = lost ? 0 : (get(s36(h), streakKey) ?? 0) + 1
    put(h, streakKey, streak)
    const owner = player(h.state, id)
    if (streak < 3 || owner.awakenedSkills.includes(YUANSHU_JIXI)) return
    owner.awakenedSkills.push(YUANSHU_JIXI)
    h.dispatch('SkillAwakened', { playerId: id, skillId: YUANSHU_JIXI, skillName: '觊玺' }, { sourceId: id })
    gainMaxHp(h, id, 1, YUANSHU_JIXI)
    if (owner.hp < owner.maxHp) recover(h, id, 1, id)
    const rewards = [{ id: 'wangzun', label: '获得【妄尊】' }]
    if (availableLordSkills(h.state, id).length) rewards.push({ id: 'lord-skill', label: '摸两张牌并获得主公技' })
    askOption(h, YUANSHU_JIXI, id, 'reward', '【觊玺】：选择觉醒收益', rewards, {}, false)
  } },
], resume(h, id, r, res) {
  if (r.step !== 'reward' && r.step !== 'choose-lord-skill') return
  if (r.step === 'choose-lord-skill') {
    if (r.data.candidates.includes(res.payload.optionId)) grantSkill(h.state, id, res.payload.optionId)
    return
  }
  if (res.payload.optionId === 'wangzun') { grantSkill(h.state, id, YUANSHU_WANGZUN); return }
  if (res.payload.optionId !== 'lord-skill') return
  drawCards(h.state, h.rng, id, 2, (n, data) => h.dispatch(n, data))
  const skills = availableLordSkills(h.state, id)
  if (!skills.length) return
  if (skills.length === 1) grantSkill(h.state, id, skills[0])
  else if (skills.length > 1) askOption(h, YUANSHU_JIXI, id, 'choose-lord-skill', '【觊玺】：选择获得一项主公技', skills.map(skillId => ({ id: skillId, label: `获得【${skillId}】` })), { candidates: skills }, false)
} })
registerSkillRuntime({ id: YUANSHU_WANGZUN,
  triggers: [{ event: 'PhaseStart', handle(h, id, c) {
    const p = c.event.payload as any, lord = player(h.state, p.playerId)
    if (p.phase !== 'prepare' || !lord?.alive || lord.identity !== 'lord' || lord.id === id) return
    askOption(h, YUANSHU_WANGZUN, id, 'invoke', `【妄尊】：是否于${lord.nickname}的准备阶段摸一张牌并令其本回合手牌上限-1？`, [
      { id: 'yes', label: '摸一张牌并令其手牌上限-1' }, { id: 'no', label: '不发动' },
    ], { lordId: lord.id })
  } }],
  globalMaxCardsBonus(state, id, targetId) {
    const effect = get(state as S36, key(YUANSHU_WANGZUN, `target:${id}`))
    return effect?.targetId === targetId && effect.turnNumber === state.turnNumber ? -1 : 0
  },
  resume(h, id, r, res) {
    if (r.step !== 'invoke' || res.payload.optionId !== 'yes') return
    const lord = player(h.state, r.data.lordId)
    if (!lord?.alive || lord.identity !== 'lord') return
    drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data))
    put(h, key(YUANSHU_WANGZUN, `target:${id}`), { targetId: lord.id, turnNumber: h.state.turnNumber })
  },
})

// 徐盛【破军】复用基础实现；界版额外伤害依据目标手牌数与装备数分别比较。
registerSkillRuntime({ id: XUSHENG_ZHENFENG, outgoingDamage(state, id, c) {
  if (c.cardName !== '杀' || !state.players.some(p => p.id === id && p.alive)) return null
  const owner = player(state, id), target = player(state, c.targetId)
  if (!owner || !target || !target.alive) return null
  const equipmentCount = (p: any) => Object.values(p.zones.equipment).filter(Boolean).length
  return target.zones.hand.length <= owner.zones.hand.length && equipmentCount(target) <= equipmentCount(owner) ? { amount: c.amount + 1 } : null
} })

// 界关羽武圣无距离限制只对方块杀（包括由方块实体牌转化的杀）。
registerSkillRuntime({ id: GUANYU_WUSHENG_DISTANCE, slashIgnoresDistance(state, id, cardId) { return !!cardId && state.cards[cardId]?.suit === 'diamond' } })
registerSkillRuntime({ id: GUANYU_YIJUE,
  activeActions(state, id) {
    const p = player(state, id)
    if (!p?.alive || state.phase !== 'play' || state.currentPlayerId !== id || usedThisPhase(state, id, GUANYU_YIJUE)) return []
    if (!p.zones.hand.length && !Object.values(p.zones.equipment).some(Boolean)) return []
    return [{ id: `skill:${GUANYU_YIJUE}`, label: '发动【义绝】：弃一张牌并令一名角色展示手牌' }]
  },
  invokeActive(h, id, action) {
    if (action !== `skill:${GUANYU_YIJUE}`) throw new Error('义绝动作无效')
    markUsedThisPhase(h.state, id, GUANYU_YIJUE)
    const p = player(h.state, id), ids = [...p.zones.hand, ...Object.values(p.zones.equipment).filter(Boolean)]
    askCards(h, GUANYU_YIJUE, id, 'cost', ids, '【义绝】：弃置一张牌', 1, 1)
  },
  resume(h, id, r, res) {
    if (r.step === 'cost') {
      const cost = res.payload.cardIds?.[0] as CardId | undefined
      if (!cost || !locateOwnedCard(h.state, id, cost)) return
      discard(h, id, [cost], GUANYU_YIJUE)
      const targets = others(h.state, id).filter(p => p.zones.hand.length)
      if (targets.length) askTargets(h, GUANYU_YIJUE, id, 'show-target', targets.map(p => p.id), '【义绝】：选择一名有手牌的其他角色', { cost })
      return
    }
    if (r.step === 'show-target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined, target = targetId && player(h.state, targetId)
      if (!target?.alive || !target.zones.hand.length) return
      h.askSkill({ skillId: GUANYU_YIJUE, ownerId: id, step: 'reveal', data: { targetId }, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【义绝】：展示一张手牌', timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }) })
    }
    if (r.step === 'reveal') {
      const targetId = r.data.targetId as PlayerId, target = player(h.state, targetId), cardId = res.payload.cardIds?.[0] as CardId | undefined
      if (!target?.alive || !cardId || !target.zones.hand.includes(cardId)) return
      const card = h.state.cards[cardId]
      h.dispatch('CardMove', { playerId: targetId, cardIds: [cardId], reason: GUANYU_YIJUE, revealed: true }, { sourceId: id, targetId, cardIds: [cardId] })
      if (effectiveCardColor(h.state, targetId, cardId) === 'black') {
        put(h, key(GUANYU_YIJUE, `${targetId}:${h.state.turnNumber}`), true)
        h.state.skillSuppressions ??= []
        // 范围压制期间新获得的非锁定技同样失效。
        suppressSkill(h.state, { targetId, scope: 'non-locked', sourceId: id, sourceSkillId: GUANYU_YIJUE, armedAtTurn: h.state.turnNumber })
        const locks = h.state as SanguoshaState & { handUseBlockedUntilTurnEnd?: Record<PlayerId, number>; handResponseBlockedUntilTurnEnd?: Record<PlayerId, number> }
        locks.handUseBlockedUntilTurnEnd ??= {}
        locks.handResponseBlockedUntilTurnEnd ??= {}
        locks.handUseBlockedUntilTurnEnd[targetId] = h.state.turnNumber
        locks.handResponseBlockedUntilTurnEnd[targetId] = h.state.turnNumber
      } else {
        moveCard(h.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: id })
        h.dispatch('GainCard', { playerId: id, cardIds: [cardId], reason: GUANYU_YIJUE }, { sourceId: targetId, targetId: id, cardIds: [cardId] })
        askOption(h, GUANYU_YIJUE, id, 'recover', `【义绝】：是否令${target.nickname}回复1点体力？`, [{ id: 'yes', label: '回复1点体力' }, { id: 'no', label: '不回复' }], { targetId })
      }
    } else if (r.step === 'recover' && res.payload.optionId === 'yes') recover(h, r.data.targetId, 1, id)
  },
  outgoingDamage(state, id, c) { return c.cardName === '杀' && !!c.cardId && effectiveCardSuit(state, id, c.cardId) === 'heart' && get(state as S36, key(GUANYU_YIJUE, `${c.targetId}:${state.turnNumber}`)) ? { amount: c.amount + 1 } : null },
})

registerSkillRuntime({ id: LINGJU_FENXIN,
  limited: true,
  triggers: [{ event: 'Death', handle(h, id, c) {
    const deadId = (c.event.payload as any).playerId as PlayerId
    if (c.event.sourceId !== id || deadId === id || !player(h.state, id)?.alive || player(h.state, id)?.identity === 'lord'
      || h.state.setup.mode !== 'identity' || player(h.state, id)?.usedLimitedSkills.includes(LINGJU_FENXIN)) return
    h.queueSkill({ skillId: LINGJU_FENXIN, ownerId: id, step: 'offer', data: { deadId } })
  } }],
  startQueued(h, id, q) {
    if (q.step !== 'offer' || player(h.state, id)?.identity === 'lord' || player(h.state, q.data.deadId)?.alive) return
    askOption(h, LINGJU_FENXIN, id, 'offer', '【焚心】：是否与刚才杀死的角色交换身份？', [{ id: 'yes', label: '交换身份' }, { id: 'no', label: '不发动' }], q.data)
  },
  resume(h, id, r, res) {
    if (r.step !== 'offer' || res.payload.optionId !== 'yes') return
    const owner = player(h.state, id), dead = player(h.state, r.data.deadId)
    if (!owner?.alive || !dead || owner.identity === 'lord') return
    owner.usedLimitedSkills.push(LINGJU_FENXIN)
    swapIdentity(h, id, dead.id)
  },
})

registerSkillRuntime({ id: SUNSHANG_LIANGZHU, triggers: [{ event: 'Recover', handle(h, id, c) {
  const p = c.event.payload as any, healed = player(h.state, p.playerId)
  if (h.state.phase !== 'play' || !healed?.alive) return
  h.queueSkill({ skillId: SUNSHANG_LIANGZHU, ownerId: id, step: 'choice', data: { healedId: healed.id, turnNumber: h.state.turnNumber } })
} }], startQueued(h, id, q) {
  if (q.step !== 'choice' || h.state.turnNumber !== q.data.turnNumber || h.state.phase !== 'play' || !player(h.state, q.data.healedId)?.alive) return
  askOption(h, SUNSHANG_LIANGZHU, id, 'choice', '【良助】：选择摸一张牌，或令回复体力的角色摸两张牌', [{ id: 'self', label: '你摸一张牌' }, { id: 'healed', label: '令其摸两张牌' }], q.data)
}, resume(h, id, r, res) {
  if (r.step !== 'choice') return
  if (res.payload.optionId === 'self') drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data))
  else if (res.payload.optionId === 'healed' && player(h.state, r.data.healedId)?.alive) {
    drawCards(h.state, h.rng, r.data.healedId, 2, (n, data) => h.dispatch(n, data))
    const healedId = r.data.healedId, given = get(s36(h), key(SUNSHANG_FANXIANG, `${id}:helped`)) ?? []
    put(h, key(SUNSHANG_FANXIANG, `${id}:helped`), [...new Set([...given, healedId])])
  }
} })
registerSkillRuntime({ id: SUNSHANG_FANXIANG, awakening: {
  phase: 'prepare',
  ready(state, id) {
    const healed = get(state as S36, key(SUNSHANG_FANXIANG, `${id}:helped`)) ?? []
    return healed.some((targetId: PlayerId) => { const p = player(state, targetId); return p?.alive && p.hp < p.maxHp })
  },
  invoke(h, id) {
    gainMaxHp(h, id, 1, SUNSHANG_FANXIANG)
    recover(h, id, 1, id)
    const p = player(h.state, id)
    if (p) {
      p.permanentlyLostSkills ??= []
      if (!p.permanentlyLostSkills.includes(SUNSHANG_LIANGZHU)) p.permanentlyLostSkills.push(SUNSHANG_LIANGZHU)
    }
    grantSkill(h.state, id, SUNSHANG_XIAOJI)
  },
} })
registerSkillRuntime({ id: SUNSHANG_XIAOJI, triggers: [{ event: 'LoseEquipment', handle(h, id, c) {
  if ((c.event.payload as any).playerId !== id || !player(h.state, id)?.alive) return
  h.queueSkill({ skillId: SUNSHANG_XIAOJI, ownerId: id, step: 'offer', data: { cardId: c.event.cardIds?.[0] } })
} }], startQueued(h, id, q) {
  if (q.step === 'offer' && player(h.state, id)?.alive) askOption(h, SUNSHANG_XIAOJI, id, 'offer', '【枭姬】：是否摸两张牌？', [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不摸' }], q.data)
}, resume(h, id, r, res) {
  if (r.step === 'offer' && res.payload.optionId === 'yes') drawCards(h.state, h.rng, id, 2, (n, data) => h.dispatch(n, data))
} })

registerSkillRuntime({ id: PANDE_MASHU, distanceModifier: { toOthers: -1 } })
registerSkillRuntime({ id: PANDE_JUESI, activeActions(state, id) {
  const p = player(state, id)
  return p?.alive && state.phase === 'play' && state.currentPlayerId === id && p.zones.hand.some(cardId => state.cards[cardId]?.name === '杀')
    ? [{ id: `skill:${PANDE_JUESI}`, label: '发动【决死】' }] : []
}, invokeActive(h, id) {
  const cards = player(h.state, id)?.zones.hand.filter(cardId => h.state.cards[cardId]?.name === '杀') ?? []
  askCards(h, PANDE_JUESI, id, 'cost', cards, '【决死】：弃置一张【杀】', 1, 1)
}, resume(h, id, r, res) {
  if (r.step === 'cost') {
    const cardId = res.payload.cardIds?.[0] as CardId | undefined
    if (!cardId || h.state.cards[cardId]?.name !== '杀' || !locateOwnedCard(h.state, id, cardId)) return
    discard(h, id, [cardId], PANDE_JUESI)
      const targets = others(h.state, id).filter(p => {
        const options = pickableCardsOf(h.state, p.id)
        return canTarget(h.state, id, p.id) && getDistance(h.state, id, p.id) <= getAttackRange(h.state, id)
          && options.cardIds.length + options.hiddenCardSlots.length > 0
      })
    if (targets.length) askTargets(h, PANDE_JUESI, id, 'target', targets.map(p => p.id), '【决死】：选择一名攻击范围内的角色', {}, false)
  } else if (r.step === 'target') {
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined, target = targetId && player(h.state, targetId)
    if (!target?.alive) return
    const options = pickableCardsOf(h.state, target.id)
    if (options.cardIds.length + options.hiddenCardSlots.length) h.askSkill({ skillId: PANDE_JUESI, ownerId: id, step: 'victim-discard', data: { targetId: target.id }, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: target.id, prompt: '【决死】：请弃置一张牌', timeoutMs: 25_000, optional: false, purpose: 'skill', ...options, min: 1, max: 1 }) })
  } else if (r.step === 'victim-discard') {
    const targetId = r.data.targetId as PlayerId, target = player(h.state, targetId), cardId = res.payload.cardIds?.[0] as CardId | undefined
    const actualCardId = target?.alive && cardId ? resolvePickedCard(h.state, target.id, cardId) : null
    if (!target?.alive || !actualCardId) return
    const wasSlash = h.state.cards[actualCardId]?.name === '杀'
    discard(h, target.id, [actualCardId], PANDE_JUESI)
    const owner = player(h.state, id)
    if (!wasSlash && owner?.alive && owner.hp <= target.hp) h.beginVirtualTrick({ sourceId: id, targetId, cardName: '决斗', sourceSkillId: PANDE_JUESI })
  }
} })

registerSkillRuntime({ id: SPGUAN_DANQI, awakening: {
  phase: 'prepare',
  ready(state, id) {
    const owner = player(state, id), lord = state.players.find(p => p.identity === 'lord')
    return !!owner?.alive && owner.zones.hand.length > owner.hp && !owner.awakenedSkills.includes(SPGUAN_DANQI)
      && !['liubei', 'liubei-jie', 'liubei-mou'].includes(lord?.characterId ?? '')
  },
  invoke(h, id) {
    loseMaxHp(h, id, 1, SPGUAN_DANQI)
    grantSkill(h.state, id, PANDE_MASHU)
    grantSkill(h.state, id, SPGUAN_NUZHAN)
  },
} })
registerSkillRuntime({ id: SPGUAN_NUZHAN,
  viewAs(state, id) {
    return (player(state, id)?.zones.hand ?? []).flatMap(cardId => {
      const card = state.cards[cardId]
      return card?.category === 'trick' || card?.category === 'equipment' ? [{ asCardName: '杀', cardId, label: `将【${card.name}】当【杀】使用` }] : []
    })
  },
  unlimitedSlashFor(state, _id, cardId) { return !!cardId && state.cards[cardId]?.category === 'trick' },
  outgoingDamage(state, id, c) { return c.cardName === '杀' && !!c.cardId && state.cards[c.cardId]?.category === 'equipment' ? { amount: c.amount + 1 } : null },
})

// 孙寒华集灵挑战：服务端预生成固定轨迹/分值，逐个输入只传方向；结束后仅使用服务器保存的分数。
const LOTUS_CELLS = 15
function offerSunHanRewards(h: SkillHost, id: PlayerId, newlyEarned: number) {
  const points = newlyEarned
  const owner = player(h.state, id)
  if (!owner?.alive || points < 2) return
  const options: Array<{ id: string; label: string }> = []
  if (points >= 3 && (owner.marks[SUNHAN_MIAOJIAN] ?? 1) < 3) options.push({ id: 'miaojian', label: '消耗3分升级【妙剑】' })
  if (points >= 3 && (owner.marks[SUNHAN_LIANHUA] ?? 1) < 3) options.push({ id: 'lianhua', label: '消耗3分升级【莲华】' })
  if (points >= 2) options.push({ id: 'draw', label: '消耗2分摸一张牌' })
  options.push({ id: 'done', label: '暂不分配' })
  askOption(h, SUNHAN_CHONGXU, id, 'spend', `【冲虚】：本次飞升成功，获得${points}分，选择分配`, options, { remainingPoints: points }, false)
}
function requestGathering(h: SkillHost, id: PlayerId, state: any) {
  const hazard = state.obstacles[state.index]
  const options = [
    ...(state.lane > 0 ? [{ id: 'left', label: '← 左移' }] : []),
    { id: 'stay', label: '↓ 接取 / 躲避' },
    ...(state.lane < 2 ? [{ id: 'right', label: '右移 →' }] : []),
  ]
  askOption(h, SUNHAN_CHONGXU, id, 'collect', `【集灵】：选择位置接住莲花或躲开电球（第${state.index + 1}拍）`, options, state, false, {
    kind: 'spirit-gathering', index: state.index, score: state.score, cellCount: LOTUS_CELLS,
    lane: state.lane, fallingLane: hazard.lane, falling: hazard.kind,
  })
}
registerSkillRuntime({ id: SUNHAN_CHONGXU,
  activeActions(state, id) {
    return state.phase === 'play' && state.currentPlayerId === id && player(state, id)?.alive && !usedThisPhase(state, id, SUNHAN_CHONGXU)
      ? [{ id: `skill:${SUNHAN_CHONGXU}`, label: '发动【冲虚】：开始集灵' }] : []
  },
  invokeActive(h, id, action) {
    if (action !== `skill:${SUNHAN_CHONGXU}`) throw new Error('冲虚动作无效')
    markUsedThisPhase(h.state, id, SUNHAN_CHONGXU)
    const obstacles = Array.from({ length: LOTUS_CELLS }, () => ({
      lane: h.rng.nextInt(3), kind: (h.rng.nextInt(5) === 0 ? 'thunder' : h.rng.nextInt(2) ? 'lotus-red' : 'lotus-white'),
    }))
    requestGathering(h, id, { obstacles, index: 0, lane: 1, score: 0 })
  },
  resume(h, id, r, res) {
    if (r.step === 'collect') {
      const state = r.data, i = Number(state.index ?? 0), choice = String(res.payload.optionId ?? '')
      if (choice === 'left') state.lane = Math.max(0, state.lane - 1)
      if (choice === 'right') state.lane = Math.min(2, state.lane + 1)
      const result = state.obstacles[i]
      if (state.lane === result.lane && result.kind !== 'thunder') state.score = Math.min(5, state.score + 1)
      if (state.lane === result.lane && result.kind === 'thunder') state.score = Math.max(0, state.score - 1)
      state.index = i + 1
      if (state.index < LOTUS_CELLS && state.score < 5) {
        requestGathering(h, id, state)
        return
      }
      const earned = state.score
      h.dispatch('SkillActivated', {
        playerId: id, skillId: SUNHAN_CHONGXU, result: earned >= 2 ? 'ascent-success' : 'ascent-failed', score: earned,
        logText: `孙寒华【冲虚】集灵${earned}分，${earned >= 2 ? '飞升成功' : '未达到飞升所需的2分'}`,
      }, { sourceId: id })
      offerSunHanRewards(h, id, earned)
      return
    }
    if (r.step === 'spend') {
      const option = res.payload.optionId, points = Number(r.data.remainingPoints ?? 0)
      let spent = 0
      if (option === 'miaojian' && points >= 3 && (player(h.state, id).marks[SUNHAN_MIAOJIAN] ?? 1) < 3) {
        player(h.state, id).marks[SUNHAN_MIAOJIAN] = (player(h.state, id).marks[SUNHAN_MIAOJIAN] ?? 1) + 1; spent = 3
      }
      if (option === 'lianhua' && points >= 3 && (player(h.state, id).marks[SUNHAN_LIANHUA] ?? 1) < 3) {
        player(h.state, id).marks[SUNHAN_LIANHUA] = (player(h.state, id).marks[SUNHAN_LIANHUA] ?? 1) + 1; spent = 3
      }
      if (option === 'draw' && points >= 2) { drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data)); spent = 2 }
      const remaining = points - spent
      if (remaining >= 2 && player(h.state, id)?.alive && option !== 'done') offerSunHanRewards(h, id, remaining)
    }
  },
})
// Sun Han Hua minigame panel is a dedicated request interaction; request details never decide rewards.
registerSkillRuntime({ id: SUNHAN_MIAOJIAN, activeActions(state, id) {
  const p = player(state, id), level = p?.marks[SUNHAN_MIAOJIAN] ?? 1
  if (!p?.alive || state.phase !== 'play' || state.currentPlayerId !== id || usedThisPhase(state, id, SUNHAN_MIAOJIAN)) return []
  const canAssassinate = sunHanAssassinationTargets(state, id).length > 0
  const hasKillCost = canAssassinate && p.zones.hand.some(cardId => {
    const c = state.cards[cardId]
    return level === 1 ? c?.name === '杀' : level === 2 ? c?.category === 'basic' : false
  })
  const hasDrawCost = p.zones.hand.some(cardId => {
    const c = state.cards[cardId]
    return level === 1 ? c?.category === 'trick' : level === 2 ? c?.category !== 'basic' : false
  })
  return level >= 3 || hasKillCost || hasDrawCost
    ? [{ id: `skill:${SUNHAN_MIAOJIAN}`, label: `发动【妙剑】（${level}级）` }] : []
}, invokeActive(h, id) {
  const level = player(h.state, id)?.marks[SUNHAN_MIAOJIAN] ?? 1
  const p = player(h.state, id)!
  const options = [] as Array<{ id: string; label: string }>
  const killCost = p.zones.hand.some(cardId => level === 1 ? h.state.cards[cardId]?.name === '杀' : level === 2 && h.state.cards[cardId]?.category === 'basic')
  const drawCost = p.zones.hand.some(cardId => level === 1 ? h.state.cards[cardId]?.category === 'trick' : level === 2 && h.state.cards[cardId]?.category !== 'basic')
  if ((killCost || level >= 3) && sunHanAssassinationTargets(h.state, id).length) options.push({ id: 'assassinate', label: '使用【刺杀】' })
  if (drawCost || level >= 3) options.push({ id: 'draw2', label: '使用【无中生有】' })
  askOption(h, SUNHAN_MIAOJIAN, id, 'choose', '【妙剑】：选择使用一张【刺杀】或【无中生有】', options, { level }, false)
}, resume(h, id, r, res) {
  if (r.step === 'choose') {
    const mode = res.payload.optionId, level = r.data.level as number
    if (!['assassinate', 'draw2'].includes(mode)) return
    const required = mode === 'assassinate'
      ? (cardId: CardId) => level === 1 ? h.state.cards[cardId]?.name === '杀' : level === 2 ? h.state.cards[cardId]?.category === 'basic' : false
      : (cardId: CardId) => level === 1 ? h.state.cards[cardId]?.category === 'trick' : level === 2 ? h.state.cards[cardId]?.category !== 'basic' : false
    if (level < 3) {
      const cardIds = player(h.state, id)!.zones.hand.filter(required)
      if (!cardIds.length) return
      askCards(h, SUNHAN_MIAOJIAN, id, 'cost', cardIds, `【妙剑】：选择用作${mode === 'assassinate' ? '【刺杀】' : '【无中生有】'}的实体牌`, 1, 1, { mode, level }, false)
      return
    }
    put(h, key(SUNHAN_MIAOJIAN, `${id}:selected`), { mode, level })
    if (mode === 'draw2') h.beginVirtualTrick({ sourceId: id, targetId: id, cardName: '无中生有', sourceSkillId: SUNHAN_MIAOJIAN })
    else {
      const targets = sunHanAssassinationTargets(h.state, id)
      if (targets.length) askTargets(h, SUNHAN_MIAOJIAN, id, 'target', targets.map(p => p.id), '【刺杀】：选择攻击范围内的目标', { mode }, false)
    }
    markUsedThisPhase(h.state, id, SUNHAN_MIAOJIAN)
    return
  }
  if (r.step === 'cost') {
    const cardId = res.payload.cardIds?.[0] as CardId | undefined
    if (!cardId || !player(h.state, id)?.zones.hand.includes(cardId)) return
    const mode = r.data.mode as string
    markUsedThisPhase(h.state, id, SUNHAN_MIAOJIAN)
    if (mode === 'draw2') {
      h.beginVirtualTrick({ sourceId: id, targetId: id, cardName: '无中生有', sourceSkillId: SUNHAN_MIAOJIAN, cardId })
    } else {
      put(h, key(SUNHAN_MIAOJIAN, `${id}:selected`), { mode, level: r.data.level, cardId })
      const targets = sunHanAssassinationTargets(h.state, id)
      if (targets.length) askTargets(h, SUNHAN_MIAOJIAN, id, 'target', targets.map(p => p.id), '【刺杀】：选择攻击范围内的目标', { mode, cardId }, false)
    }
    return
  }
  if (r.step === 'target') {
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined, chosen = get(s36(h), key(SUNHAN_MIAOJIAN, `${id}:selected`)) ?? r.data
    const target = targetId && player(h.state, targetId)
    if (!target?.alive || !canTarget(h.state, id, target.id) || getDistance(h.state, id, target.id) > attackRangeOf(h.state, id)) return
    const cardId = chosen.cardId as CardId | undefined
    if (cardId) setCardAlias(h.state, cardId, '杀')
    h.beginVirtualSlash({ sourceId: id, targetId: target.id, sourceSkillId: SUNHAN_MIAOJIAN, cardId, countUsage: true, responseDiscardCostTargetIds: [target.id] })
    remove(s36(h), key(SUNHAN_MIAOJIAN, `${id}:selected`))
  }
} })

registerJudgmentContinuation(LIANHUA_JUDGE, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const resolution = host.state.cardResolution
  if (judged.suit === 'spade' && resolution?.kind === 'slash' && resolution.targetId === ownerId) resolution.targetCancelled = true
  host.resumeCardTarget()
})
registerSkillRuntime({ id: SUNHAN_LIANHUA, interceptTarget(h, id, c) {
  if (c.cardName !== '杀' || c.targetId !== id || c.sourceId === id) return false
  const level = player(h.state, id)?.marks[SUNHAN_LIANHUA] ?? 1
  drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data))
  if (level === 2) {
    performJudgment(h as never, id, '莲华', { tag: LIANHUA_JUDGE, data: { ownerId: id } })
    return true
  }
  if (level === 3) {
    const sourceId = c.sourceId, source = player(h.state, sourceId)
    const options = source ? pickableCardsOf(h.state, sourceId) : { cardIds: [], hiddenCardSlots: [] }
    if (!source?.alive || options.cardIds.length + options.hiddenCardSlots.length === 0) {
      if (h.state.cardResolution?.kind === 'slash') h.state.cardResolution.targetCancelled = true
      h.resumeCardTarget()
      return true
    }
    h.askSkill({ skillId: SUNHAN_LIANHUA, ownerId: id, step: 'discard', data: { sourceId }, build: requestId => ({
      id: requestId, kind: 'choose-cards', playerId: sourceId, prompt: '【莲华】：请弃置一张牌；若不如此做，此【杀】对你无效', timeoutMs: 25_000,
      optional: true, purpose: 'skill', ...options, min: 0, max: 1,
    }) })
    return true
  }
  return false
}, resume(h, _id, r, res) {
  if (r.step !== 'discard') return
  const sourceId = r.data.sourceId as PlayerId, picked = res.payload.cardIds?.[0] as string | undefined
  const cardId = picked ? resolvePickedCard(h.state, sourceId, picked) : null
  const resolution = h.state.cardResolution
  if (!cardId) { if (resolution?.kind === 'slash') resolution.targetCancelled = true }
  else discard(h, sourceId, [cardId], SUNHAN_LIANHUA)
  h.resumeCardTarget()
} })

// 灵雎【竭缘】：询问、付牌、修改同一笔伤害；不把增减伤伪装成另一次伤害。
registerSkillRuntime({ id: LINGJU_JIEYUAN,
  offersDamageModifierAsk(h, id, side, c) {
    const owner = player(h.state, id)
    const counterpart = side === 'source' ? player(h.state, c.targetId) : c.sourceId && player(h.state, c.sourceId)
    if (!owner?.alive || !counterpart?.alive || counterpart.id === id || counterpart.hp < owner.hp) return false
    const color = side === 'source' ? 'black' : 'red'
    const costs = owner.zones.hand.filter(cardId => effectiveCardColor(h.state, id, cardId) === color)
    if (!costs.length) return false
    askOption(h, LINGJU_JIEYUAN, id, 'invoke', `【竭缘】：是否弃置一张${color === 'black' ? '黑色手牌令此伤害+1' : '红色手牌令此伤害-1'}？`, [
      { id: 'yes', label: '弃置并修正伤害' }, { id: 'no', label: '不发动' },
    ], { side, targetId: c.targetId, sourceId: c.sourceId, costs, amount: c.amount })
    return true
  },
  resume(h, id, r, res) {
    if (r.step === 'invoke') {
      if (res.payload.optionId !== 'yes') { resumeDamageModifier(h as never, LINGJU_JIEYUAN, 0); return }
      const owner = player(h.state, id), color = r.data.side === 'source' ? 'black' : 'red'
      const costs = r.data.costs.filter(cardId => owner?.zones.hand.includes(cardId) && effectiveCardColor(h.state, id, cardId) === color)
      if (!costs.length) { resumeDamageModifier(h as never, LINGJU_JIEYUAN, 0); return }
      askCards(h, LINGJU_JIEYUAN, id, 'pay', costs, `【竭缘】：弃置一张${color === 'black' ? '黑色' : '红色'}手牌`, 1, 1, { ...r.data })
      return
    }
    if (r.step === 'pay') {
      const cardId = res.payload.cardIds?.[0] as CardId | undefined, owner = player(h.state, id)
      const color = r.data.side === 'source' ? 'black' : 'red'
      if (!cardId || !owner?.zones.hand.includes(cardId) || effectiveCardColor(h.state, id, cardId) !== color || !discard(h, id, [cardId], LINGJU_JIEYUAN).length) {
        resumeDamageModifier(h as never, LINGJU_JIEYUAN, 0); return
      }
      resumeDamageModifier(h as never, LINGJU_JIEYUAN, r.data.side === 'source' ? 1 : -1)
    }
  },
})


export const LIUZAN_B36: CharacterDefinition = { id: 'liuzan-b36', name: '留赞', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: LIUZAN_FENYIN, name: '奋音', description: '你的回合内，每当你使用了一张与上一张颜色不同的牌时，你摸一张牌。' }] }
export const RUANHUI_B36: CharacterDefinition = { id: 'ruanhui-b36', name: '阮慧', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: RUANHUI_MINGCHA, name: '明察', description: '摸牌阶段开始时，你亮出牌堆顶三张牌，然后你可获得其中点数不大于8的牌，若如此做，你放弃摸牌。若你以此法获得了牌，你可选择一名其他角色，随机获得其一张牌。' }, { id: RUANHUI_JINGZHONG, name: '敬重', description: '弃牌阶段结束时，若你于此阶段内弃置过至少两张黑色牌，你可以选择一名其他角色，其下个回合出牌阶段内使用的牌结算结束后，若此牌仍在弃牌堆中，你获得之（本阶段至多以此法获得三次牌）。' }] }
export const JIE_XUSHENG_B36: CharacterDefinition = { id: 'xusheng-jie-b36', name: '界·徐盛', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: XUSHENG_POJUN, name: '破军', description: '你使用【杀】指定一个目标后，你可以将其至多X张牌扣置于其武将牌旁（X为其体力值）；若如此做，当前回合结束后，该角色获得这些牌。' }, { id: XUSHENG_ZHENFENG, name: '振锋', description: '你使用【杀】对手牌数与装备数均不大于你的角色造成伤害时，此伤害+1。', locked: true }] }
export const JIE_GUANYU_B36: CharacterDefinition = { id: 'guanyu-jie-b36', name: '界·关羽', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: 'wusheng', name: '武圣', description: '你可以将一张红色牌当【杀】使用或打出。' }, { id: GUANYU_WUSHENG_DISTANCE, name: '武圣·方块杀', description: '你使用方块【杀】无距离限制。', locked: true }, { id: GUANYU_YIJUE, name: '义绝', description: '出牌阶段限一次，你可以弃置一张牌，然后令一名其他角色展示一张手牌。若此牌为黑色，则其本回合非锁定技失效且不能使用或打出手牌，你对其使用的红桃【杀】伤害+1；若此牌为红色，则你获得之，然后你可令该角色回复1点体力。' }] }
export const SUNHANHUA_B36: CharacterDefinition = { id: 'sunhanhua-b36', name: '孙寒华', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: SUNHAN_CHONGXU, name: '冲虚', description: '出牌阶段限一次，你可以进行一次集灵来获得分数，然后你可以用分数升级妙剑、升级莲华或摸牌。' }, { id: SUNHAN_MIAOJIAN, name: '妙剑', description: '1级，出牌阶段限一次，你可以将一张【杀】当【刺杀】使用，或将一张锦囊牌当【无中生有】使用；2级，你可以将一张基本牌当【刺杀】使用，或将一张非基本牌当【无中生有】使用；3级，出牌阶段限一次，你可以视为使用一张【刺杀】或【无中生有】。' }, { id: SUNHAN_LIANHUA, name: '莲华', description: '1级，你成为其他角色使用【杀】的目标时，你摸一张牌。2级，你成为其他角色使用【杀】的目标时，你摸一张牌，然后进行判定，若判定结果为黑桃，则取消之。3级，你成为其他角色使用【杀】的目标时，你摸一张牌，除非该角色弃置一张牌，否则取消之。' }] }
export const LINGJU_B36: CharacterDefinition = { id: 'lingju-b36', name: '灵雎', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: LINGJU_JIEYUAN, name: '竭缘', description: '当你对其他角色造成伤害时，若其体力值不小于你，你可以弃置一张黑色手牌，然后此伤害+1；当你受到其他角色造成的伤害时，若其体力值不小于你，你可以弃置一张红色手牌，然后此伤害-1。' }, { id: LINGJU_FENXIN, name: '焚心', description: '限定技，当你杀死一名角色时，若你不为主公，则你可以与其交换身份牌。' }] }
export const JIE_YUANSHU_B36: CharacterDefinition = { id: 'yuanshu-jie-b36', name: '界·袁术', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: YUANSHU_YONGSI, name: '庸肆', description: '锁定技，摸牌阶段，你改为摸X张牌（X为全场势力数）；弃牌阶段开始时，你弃置一张牌或失去1点体力。', locked: true }, { id: YUANSHU_JIXI, name: '觊玺', description: '觉醒技，回合结束时，若你已连续三个自己的回合没有失去过体力，你加1点体力上限，然后回复1点体力，选择一项：获得妄尊；或摸两张牌，然后获得主公的主公技。' }, { id: YUANSHU_WANGZUN, name: '妄尊', description: '主公的准备阶段开始时，你可以摸一张牌。若如此做，直到回合结束，主公的手牌上限-1。', granted: true }] }
export const SP_SUNSHANGXIANG_B36: CharacterDefinition = { id: 'sunshangxiang-sp-b36', name: 'SP·孙尚香', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [{ id: SUNSHANG_LIANGZHU, name: '良助', description: '一名角色于其出牌阶段内回复体力后，你可以选择一项：摸一张牌，或令该角色摸两张牌。' }, { id: SUNSHANG_FANXIANG, name: '返乡', description: '觉醒技，准备阶段，若有至少一名已受伤且你发动过良助令其摸牌的角色，你加1点体力上限并回复1点体力，失去良助并获得枭姬。' }, { id: SUNSHANG_XIAOJI, name: '枭姬', description: '当你失去装备区里的一张牌后，你可以摸两张牌。', granted: true }] }
export const SP_PANDE_B36: CharacterDefinition = { id: 'pande-sp-b36', name: 'SP·庞德', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: PANDE_MASHU, name: '马术', description: '锁定技，你计算与其他角色的距离-1。', locked: true }, { id: PANDE_JUESI, name: '决死', description: '出牌阶段，你可以弃置一张【杀】并选择你攻击范围内的一名其他角色，然后该角色弃置一张牌。若其弃置的不是【杀】且你的体力值不大于该角色，则你视为对其使用【决斗】。' }] }
export const SP_GUANYU_B36: CharacterDefinition = { id: 'guanyu-sp-b36', name: 'SP·关羽', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [{ id: 'wusheng', name: '武圣', description: '你可以将一张红色牌当【杀】使用或打出。' }, { id: SPGUAN_DANQI, name: '单骑', description: '觉醒技，准备阶段，若你的手牌数大于体力值且本局主公不是刘备、界刘备或谋刘备，你减1点体力上限，然后获得马术与怒斩。' }, { id: PANDE_MASHU, name: '马术', description: '锁定技，你计算与其他角色的距离-1。', granted: true }, { id: SPGUAN_NUZHAN, name: '怒斩', description: '锁定技，你使用锦囊牌转化的【杀】不计入次数；你使用装备牌转化的【杀】伤害+1。', granted: true }] }

export const HISTORICAL_BATCH34_CHARACTERS = [LIUZAN_B36, RUANHUI_B36, JIE_XUSHENG_B36, JIE_GUANYU_B36, SUNHANHUA_B36, LINGJU_B36, JIE_YUANSHU_B36, SP_SUNSHANGXIANG_B36, SP_PANDE_B36, SP_GUANYU_B36] as const
