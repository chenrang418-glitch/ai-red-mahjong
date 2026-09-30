// 第31批独立历史人物。仅接入规则与资源接口字段，立绘、语音后续补齐。
// 公孙修、丁奉、伏完的技能文本按当前官方公开武将页核对；其余人物采用标准包规则体系。
// @ts-nocheck
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { executeUseCardAction } from '../../engine/cards/basic'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { getDistance } from '../../engine/distance'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

type B31 = SanguoshaState & { b31?: Record<string, any> }
const st = (h: SkillHost) => h.state as B31
const player = (s: SanguoshaState, id: PlayerId) => s.players.find(x => x.id === id)
const others = (s: SanguoshaState, id: PlayerId) => s.players.filter(x => x.alive && x.id !== id)
const hand = (s: SanguoshaState, id: PlayerId) => player(s, id)?.zones.hand ?? []
const owned = (s: SanguoshaState, id: PlayerId) => [...hand(s, id), ...Object.values(player(s, id)?.zones.equipment ?? {}).filter(Boolean)]
const get = (h: SkillHost, key: string) => st(h).b31?.[key]
const set = (h: SkillHost, key: string, value: any) => { st(h).b31 ??= {}; st(h).b31[key] = value; return value }
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, ids: PlayerId[], prompt: string, data: any = {}) { h.askSkill({ skillId, ownerId, step: 'target', data, build: requestId => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 20_000, optional: false, candidateIds: ids, min: 1, max: 1 }) }) }
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, ids: CardId[], prompt: string, min: number, max: number, data: any = {}) { h.askSkill({ skillId, ownerId, step: 'cards', data, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) }) }
function discard(h: SkillHost, id: PlayerId, ids: CardId[], reason: string) { const moved: CardId[] = []; for (const cardId of ids) { const from = locateOwnedCard(h.state, id, cardId); if (!from) continue; moveCard(h.state, cardId, from, { kind: 'discardPile' }); moved.push(cardId) } if (moved.length) h.dispatch('LoseCard', { playerId: id, cardIds: moved, reason }, { sourceId: id, cardIds: moved }); return moved }
function gain(h: SkillHost, id: PlayerId, cardId: CardId, from: any, reason: string) { if (!cardId) return; moveCard(h.state, cardId, from, { kind: 'hand', playerId: id }); h.dispatch('GainCard', { playerId: id, cardIds: [cardId], reason }, { targetId: id, cardIds: [cardId] }) }
function duel(h: SkillHost, sourceId: PlayerId, targetId: PlayerId, skillId: string) { const cardId = createVirtualTrick(h.state, sourceId, '决斗', skillId); executeUseCardAction(h as never, sourceId, { id: `${skillId}:${cardId}`, kind: 'use-card', playerId: sourceId, label: `【${skillId}】视为使用【决斗】`, cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1, asCardName: '决斗' } as never, { skipPlayInterceptors: true }) }

const GONGSUNXIU_GANGU = 'gangu-b31'
const GONGSUNXIU_KUIZHEN = 'kuizhen-b31'
registerSkillRuntime({ id: GONGSUNXIU_GANGU, triggers: [{ event: 'DamageSettled', handle(h, id, c) { const d = c.event.payload as any; if (!c.event.targetId || c.event.targetId === id || Number(d.finalAmount ?? 0) <= 0 || usedThisTurn(h.state, id, GONGSUNXIU_GANGU)) return; const q = get(h, `${GONGSUNXIU_GANGU}:${id}`); if (q === h.state.turnNumber) return; set(h, `${GONGSUNXIU_GANGU}:${id}`, h.state.turnNumber); drawCards(h.state, h.rng, id, 3, (n, p) => h.dispatch(n, p)); loseHp(h.state, id, 1, id) } }] })
registerSkillRuntime({
  id: GONGSUNXIU_KUIZHEN,
  activeActions(s, id) {
    const me = player(s, id)
    const candidates = others(s, id).filter(x => x.zones.hand.length >= (me?.zones.hand.length ?? 0) || x.hp >= (me?.hp ?? 0))
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, GONGSUNXIU_KUIZHEN) && candidates.length ? [{ id: GONGSUNXIU_KUIZHEN, label: '溃阵：视为对角色使用【决斗】' }] : []
  },
  invokeActive(h, id) {
    askTargets(h, GONGSUNXIU_KUIZHEN, id, others(h.state, id).filter(x => x.zones.hand.length >= hand(h.state, id).length || x.hp >= (player(h.state, id)?.hp ?? 0)).map(x => x.id), '【溃阵】：选择一名角色')
  },
  resume(h, id, r, res) {
    if (r.step !== 'target') return
    const targetId = res.payload.targetIds?.[0]
    if (!targetId) return
    markUsedThisPhase(h.state, id, GONGSUNXIU_KUIZHEN)
    set(h, `${GONGSUNXIU_KUIZHEN}:${id}`, { targetId, turn: h.state.turnNumber, damaged: false })
    duel(h, id, targetId, GONGSUNXIU_KUIZHEN)
  },
  triggers: [
    { event: 'DamageSettled', handle(h, id, c) {
      const d = c.event.payload as any
      const r = get(h, `${GONGSUNXIU_KUIZHEN}:${id}`)
      if (!r || r.turn !== h.state.turnNumber) return
      if (c.event.sourceId === id && c.event.targetId === r.targetId && d.cardName === '决斗' && Number(d.finalAmount ?? 0) > 0) {
        r.damaged = true
        for (const cardId of [...hand(h.state, r.targetId)].filter(x => h.state.cards[x]?.name === '杀')) gain(h, id, cardId, { kind: 'hand', playerId: r.targetId }, GONGSUNXIU_KUIZHEN)
      }
    } },
    { event: 'CardResolved', handle(h, id, c) {
      const d = c.event.payload as any
      const r = get(h, `${GONGSUNXIU_KUIZHEN}:${id}`)
      if (r?.turn === h.state.turnNumber && d.sourceId === id && d.cardName === '决斗' && !r.damaged) loseHp(h.state, r.targetId, 1, id)
    } },
  ],
})

const DINGFENG_DUANBING = 'duanbing-b31'
const DINGFENG_FENXUN = 'fenxun-b31'
registerSkillRuntime({ id: DINGFENG_DUANBING, extraSlashTargets(s, id) { return others(s, id).some(x => getDistance(s, id, x.id) === 1) ? 1 : 0 } })
registerSkillRuntime({ id: DINGFENG_FENXUN, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, DINGFENG_FENXUN) && owned(s, id).length && others(s, id).length ? [{ id: DINGFENG_FENXUN, label: '奋迅：弃牌令距离视为1' }] : [] }, invokeActive(h, id) { askCards(h, DINGFENG_FENXUN, id, owned(h.state, id), '【奋迅】：弃置一张牌', 1, 1) }, resume(h, id, r, res) { if (r.step === 'cards') { const cardId = res.payload.cardIds?.[0]; if (!cardId || !owned(h.state, id).includes(cardId)) return; askTargets(h, DINGFENG_FENXUN, id, others(h.state, id).map(x => x.id), '【奋迅】：选择一名其他角色', { cardId }) } else if (r.step === 'target') { const targetId = res.payload.targetIds?.[0]; if (!targetId || !r.data.cardId) return; discard(h, id, [r.data.cardId], DINGFENG_FENXUN); markUsedThisPhase(h.state, id, DINGFENG_FENXUN); set(h, `${DINGFENG_FENXUN}:${id}`, { targetId, turn: h.state.turnNumber }) } }, distanceModifier(s, id, from, to) { const r = (s as B31).b31?.[`${DINGFENG_FENXUN}:${id}`]; return r?.turn === s.turnNumber && (from === id && to === r.targetId || from === r.targetId && to === id) ? -99 : 0 } })

const FUWAN_MOUKUI = 'moukui-b31'
registerSkillRuntime({
  id: FUWAN_MOUKUI,
  triggers: [
    { event: 'CardUsed', handle(h, id, c) {
      const d = c.event.payload as any
      if (d.sourceId !== id || d.cardName !== '杀' || !d.targetIds?.length || !d.cardId) return
      h.queueSkill({ skillId: FUWAN_MOUKUI, ownerId: id, step: 'option', data: { cardId: d.cardId, targetIds: d.targetIds } })
    } },
    { event: 'CardResolved', handle(h, id, c) {
      const d = c.event.payload as any
      const pending = read(h, `${FUWAN_MOUKUI}:${id}`)
      if (!pending || d.cardId !== pending.cardId || d.cancelled !== true || !hand(h.state, id).length || !p(h.state, pending.targetId)?.alive) return
      h.askSkill({ skillId: FUWAN_MOUKUI, ownerId: id, step: 'recoil', data: pending, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: pending.targetId, prompt: '【谋溃】：选择一张牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: hand(h.state, id), hiddenCardSlots: [], min: 1, max: 1 }) })
    } },
  ],
  startQueued(h, id, q) {
    h.askSkill({ skillId: FUWAN_MOUKUI, ownerId: id, step: 'option', data: q.data, build: requestId => ({ id: requestId, kind: 'choose-options', playerId: id, prompt: '【谋溃】：可选择任意项', timeoutMs: 20_000, optional: true, options: [{ id: 'draw', label: '摸一张牌' }, { id: 'discard', label: '弃置其中一名目标角色一张牌' }], min: 0, max: 2 }) })
  },
  resume(h, id, r, res) {
    if (r.step === 'option') {
      const chosen = (res.payload.optionIds ?? []) as string[]
      if (!chosen.length) return
      if (chosen.includes('draw')) drawCards(h.state, h.rng, id, 1, (n, p) => h.dispatch(n, p))
      if (chosen.includes('discard')) {
        const candidates = (r.data.targetIds as PlayerId[]).filter(targetId => p(h.state, targetId)?.alive && hand(h.state, targetId).length)
        if (candidates.length) askTargets(h, FUWAN_MOUKUI, id, candidates, '【谋溃】：选择要弃置其手牌的目标角色', { ...r.data, both: chosen.includes('draw') })
      }
      if (!chosen.includes('discard')) write(h, `${FUWAN_MOUKUI}:${id}`, { ...r.data, both: false })
      return
    }
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0]
      if (!targetId || !hand(h.state, targetId).length) return
      write(h, `${FUWAN_MOUKUI}:${id}`, { ...r.data, targetId })
      askCards(h, FUWAN_MOUKUI, id, hand(h.state, targetId), '【谋溃】：选择目标的一张手牌弃置', 1, 1, { ...r.data, targetId })
      return
    }
    if (r.step === 'cards') {
      const targetId = r.data.targetId as PlayerId
      const cardId = res.payload.cardIds?.[0]
      if (cardId && hand(h.state, targetId).includes(cardId)) discard(h, targetId, [cardId], FUWAN_MOUKUI)
      return
    }
    if (r.step === 'recoil') {
      const cardId = res.payload.cardIds?.[0]
      if (cardId && hand(h.state, id).includes(cardId)) discard(h, id, [cardId], FUWAN_MOUKUI)
    }
  },
})

const LITONG_FUNING = 'funing-b31'
registerSkillRuntime({ id: LITONG_FUNING,
  triggers: [{ event: 'CardUsed', handle(h, id, c) { if (c.event.sourceId !== id) return; const n = (get(h, `${LITONG_FUNING}:${id}`)?.turn === h.state.turnNumber ? get(h, `${LITONG_FUNING}:${id}`).n : 0) + 1; set(h, `${LITONG_FUNING}:${id}`, { turn: h.state.turnNumber, n }); drawCards(h.state, h.rng, id, 1, (x, y) => h.dispatch(x, y)); if (n > 1 && hand(h.state, id).length) h.queueSkill({ skillId: LITONG_FUNING, ownerId: id, step: 'discard', data: {} }) } }],
  startQueued(h, id) { if (hand(h.state, id).length) askCards(h, LITONG_FUNING, id, hand(h.state, id), '【福宁】：选择一张手牌弃置', 1, 1) },
  resume(h, id, r, res) { if (r.step !== 'cards') return; const cardId = res.payload.cardIds?.[0]; if (cardId && hand(h.state, id).includes(cardId)) discard(h, id, [cardId], LITONG_FUNING) },
})

const WUYAN_JISHI = 'jishi-b31'
registerSkillRuntime({ id: WUYAN_JISHI, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, WUYAN_JISHI) && others(s, id).length ? [{ id: WUYAN_JISHI, label: '济世：令角色回复体力' }] : [] }, invokeActive(h, id) { askTargets(h, WUYAN_JISHI, id, others(h.state, id).map(x => x.id), '【济世】：选择一名其他角色') }, resume(h, id, r, res) { if (r.step !== 'target') return; const targetId = res.payload.targetIds?.[0]; if (!targetId) return; markUsedThisPhase(h.state, id, WUYAN_JISHI); recover(h.state, targetId, 1, id) } })


const JIANGJI_JINGLUE = 'jinglue-b31'
registerSkillRuntime({ id: JIANGJI_JINGLUE, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, JIANGJI_JINGLUE) && hand(s, id).length ? [{ id: JIANGJI_JINGLUE, label: '经略：弃牌摸牌' }] : [] }, invokeActive(h, id) { askCards(h, JIANGJI_JINGLUE, id, hand(h.state, id), '【经略】：弃置一张牌', 1, 1) }, resume(h, id, r, res) { if (r.step !== 'cards') return; const cardId = res.payload.cardIds?.[0]; if (!cardId || !hand(h.state, id).includes(cardId)) return; discard(h, id, [cardId], JIANGJI_JINGLUE); markUsedThisPhase(h.state, id, JIANGJI_JINGLUE); drawCards(h.state, h.rng, id, 2, (n, p) => h.dispatch(n, p)) } })

const PEIXIU_ZHITU = 'zhitu-b31'
registerSkillRuntime({ id: PEIXIU_ZHITU, distanceModifier(s, id, from, to) { return from === id ? 1 : 0 } })


export const HISTORICAL_BATCH31_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'gongsunxiu', name: '公孙修', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: GONGSUNXIU_GANGU, name: '干蛊', description: '锁定技，每回合限一次，当有其他角色失去体力后，你摸三张牌并失去1点体力。' }, { id: GONGSUNXIU_KUIZHEN, name: '溃阵', description: '出牌阶段限一次，令手牌数或体力值不小于你的角色视为对你使用【决斗】；你受伤则观看其手牌并获得其中所有【杀】，否则其失去1点体力。' }] },
  { id: 'dingfeng', name: '丁奉', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: DINGFENG_DUANBING, name: '短兵', description: '你使用【杀】能额外选择一名距离为1的角色为目标。' }, { id: DINGFENG_FENXUN, name: '奋迅', description: '出牌阶段限一次，弃置一张牌并选择一名其他角色，你与其的距离视为1直到回合结束。' }] },
  { id: 'fuwan', name: '伏完', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: FUWAN_MOUKUI, name: '谋溃', description: '你使用【杀】指定目标后，可摸一张牌或弃置其中一名目标的一张牌。' }] },
  { id: 'litong', name: '李通', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: LITONG_FUNING, name: '抚宁', description: '你使用牌后摸一张牌；本回合第二次及以后发动时改为摸牌并弃置一张牌。' }] },
  { id: 'wuyan', name: '吾彦', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: WUYAN_JISHI, name: '济世', description: '出牌阶段限一次，令一名其他角色回复1点体力。' }] },
  { id: 'jiangji', name: '蒋济', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: JIANGJI_JINGLUE, name: '经略', description: '出牌阶段限一次，你可以弃置一张牌，然后摸两张牌。' }] },
  { id: 'peixiu', name: '裴秀', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: PEIXIU_ZHITU, name: '制图', description: '锁定技，你计算与其他角色的距离时始终+1。' }] },
]
