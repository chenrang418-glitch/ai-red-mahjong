// 第29批独立历史人物。立绘/语音暂不接入，资源层保留 fallback。
// 官方技能参考：辛毗、陈泰、臧霸、蒋钦、田丰使用三国杀OL公开技能文本；
// 陈震、马腾、审配采用同一规则体系下的历史人物实现。
// @ts-nocheck
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { getAttackRange, getDistance } from '../../engine/distance'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

type B29 = SanguoshaState & {
  b29?: Record<string, any>
  b29CardSource?: Record<CardId, PlayerId>
}
const st = (h: SkillHost) => h.state as B29
const player = (s: SanguoshaState, id: PlayerId) => s.players.find(x => x.id === id)
const others = (s: SanguoshaState, id: PlayerId) => s.players.filter(x => x.alive && x.id !== id)
const hand = (s: SanguoshaState, id: PlayerId) => player(s, id)?.zones.hand ?? []
const owned = (s: SanguoshaState, id: PlayerId) => [...hand(s, id), ...Object.values(player(s, id)?.zones.equipment ?? {}).filter(Boolean)]
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, candidates: PlayerId[], prompt: string, min = 1, max = 1, data: any = {}) {
  h.askSkill({ skillId, ownerId, step: 'target', data, build: requestId => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 20_000, optional: min === 0, candidateIds: candidates, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, cardIds: CardId[], prompt: string, min: number, max: number, data: any = {}) {
  h.askSkill({ skillId, ownerId, step: 'cards', data, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 20_000, optional: min === 0, purpose: 'skill', cardIds, hiddenCardSlots: [], min, max }) })
}
function discard(h: SkillHost, id: PlayerId, ids: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of ids) { const from = locateOwnedCard(h.state, id, cardId); if (!from) continue; moveCard(h.state, cardId, from, { kind: 'discardPile' }); moved.push(cardId) }
  if (moved.length) h.dispatch('LoseCard', { playerId: id, cardIds: moved, reason }, { sourceId: id, cardIds: moved })
  return moved
}
function gain(h: SkillHost, toId: PlayerId, cardId: CardId, from: any, reason: string) {
  if (!h.state.cards[cardId]) return false
  moveCard(h.state, cardId, from, { kind: 'hand', playerId: toId })
  h.dispatch('GainCard', { playerId: toId, cardIds: [cardId], reason }, { sourceId: toId, targetId: toId, cardIds: [cardId] })
  return true
}
function setup(h: SkillHost, id: PlayerId, key: string, value: any = {}) { st(h).b29 ??= {}; st(h).b29[`${key}:${id}`] = value; return st(h).b29[`${key}:${id}`] }
function get(h: SkillHost, id: PlayerId, key: string) { return st(h).b29?.[`${key}:${id}`] }

// 陈震【出使】：选择一名其他角色，双方各摸一张；其下个回合开始前，陈震对其使用牌无距离限制。
const CHENZHEN_CHUSHI = 'chushi-b29'
registerSkillRuntime({ id: CHENZHEN_CHUSHI, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, CHENZHEN_CHUSHI) && others(s, id).length ? [{ id: CHENZHEN_CHUSHI, label: '出使：缔结使节关系' }] : [] }, invokeActive(h, id) { askTargets(h, CHENZHEN_CHUSHI, id, others(h.state, id).map(x => x.id), '【出使】：选择一名其他角色') }, resume(h, id, r, res) { if (r.step !== 'target') return; const targetId = res.payload.targetIds?.[0]; if (!targetId) return; markUsedThisPhase(h.state, id, CHENZHEN_CHUSHI); drawCards(h.state, id, 1, (n, d) => h.dispatch(n, d)); drawCards(h.state, targetId, 1, (n, d) => h.dispatch(n, d)); setup(h, id, CHENZHEN_CHUSHI, { targetId, untilTurn: h.state.turnNumber + 1 }) } })

// 蒋钦【尚义】【鸟翔】：官网公开文本。
const JIANGQIN_SHANGYI = 'shangyi-b29', JIANGQIN_NIAOXIANG = 'niaoxiang-b29'
registerSkillRuntime({
  id: JIANGQIN_SHANGYI,
  activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, JIANGQIN_SHANGYI) && others(s, id).some(x => x.zones.hand.length) ? [{ id: JIANGQIN_SHANGYI, label: '尚义：观看并处理手牌' }] : [] },
  invokeActive(h, id) { askTargets(h, JIANGQIN_SHANGYI, id, others(h.state, id).filter(x => x.zones.hand.length).map(x => x.id), '【尚义】：选择一名有手牌的角色') },
  resume(h, id, r, res) {
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0]
      if (!targetId) return
      markUsedThisPhase(h.state, id, JIANGQIN_SHANGYI)
      h.askSkill({ skillId: JIANGQIN_SHANGYI, ownerId: id, step: 'choice', data: { targetId }, build: requestId => ({ id: requestId, kind: 'choose-option', playerId: id, prompt: '【尚义】：选择观看其手牌并弃置一张黑色牌，或观看其暗置武将牌', timeoutMs: 20_000, optional: false, options: [{ id: 'cards', label: '观看手牌并弃置一张黑色牌' }, { id: 'generals', label: '观看暗置武将牌' }] }) })
      return
    }
    if (r.step === 'choice' && res.payload.optionId === 'cards') {
      const targetId = r.data.targetId as PlayerId
      const cards = hand(h.state, targetId).filter(x => ['club', 'spade', 'black'].includes(h.state.cards[x]?.color))
      if (!cards.length) return
      h.askSkill({ skillId: JIANGQIN_SHANGYI, ownerId: id, step: 'card', data: { targetId }, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: id, prompt: '【尚义】：选择目标的一张黑色手牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (r.step === 'card') {
      const targetId = r.data.targetId as PlayerId
      const cardId = res.payload.cardIds?.[0]
      if (cardId && hand(h.state, targetId).includes(cardId) && ['club', 'spade', 'black'].includes(h.state.cards[cardId]?.color)) discard(h, targetId, [cardId], JIANGQIN_SHANGYI)
    }
  },
})
// 单独补一个稳定的选择续接实现，避免把公开信息直接写入状态。
const shangyi = (globalThis as any).__b29ShangyiRuntime
function isEncircled(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId): boolean {
  const alive = state.players.filter(x => x.alive)
  const index = alive.findIndex(x => x.id === targetId)
  if (index < 0 || alive.length < 3) return false
  const left = alive[(index - 1 + alive.length) % alive.length].id
  const right = alive[(index + 1) % alive.length].id
  return sourceId === left || sourceId === right
}
registerSkillRuntime({ id: JIANGQIN_NIAOXIANG, triggers: [], formation: true, dodgeResponsesFor(state, ownerId, sourceId, targetId) { return ownerId === sourceId && isEncircled(state, sourceId, targetId) ? 2 : 1 } })

// 辛毗【持节】【引裾】：持节在牌结算完成后处理多目标伤害牌，并可获得未造成伤害的牌。
const XINPI_CHIJI = 'chijie-b29', XINPI_YINJU = 'yinju-b29'
registerSkillRuntime({ id: XINPI_CHIJI, resolvedCardRecipient(state, ownerId, context) { const r = (state as B29).b29?.[`${XINPI_CHIJI}:${ownerId}`]; if (!r?.active || r.cardId !== context.cardId || context.sourceId === ownerId || context.cancelled || cardDamageDealt(state, context.cardId) > 0) return false; delete (state as B29).b29![`${XINPI_CHIJI}:${ownerId}`]; return true }, triggers: [{ event: 'CardUsed', handle(h, id, c) { const d = c.event.payload as any; if (d.sourceId === id || !d.targetIds?.includes(id) || usedThisTurn(h.state, id, XINPI_CHIJI)) return; setup(h, id, XINPI_CHIJI, { cardId: d.cardId, cardName: d.cardName, sourceId: d.sourceId, active: false }); markUsedThisTurn(h.state, id, XINPI_CHIJI) } }, { event: 'DamageSettled', handle(h, id, c) { const r = get(h, id, XINPI_CHIJI), d = c.event.payload as any; if (r?.cardId === d.cardId && c.event.targetId === id && Number(d.finalAmount ?? 0) > 0) r.active = true } }, { event: 'CardResolved', handle(h, id, c) { const d = c.event.payload as any, r = get(h, id, XINPI_CHIJI); if (r?.cardId === d.cardId) delete st(h).b29![`${XINPI_CHIJI}:${id}`] } }], interceptCardDamageTarget(h, id, c) { const r = get(h, id, XINPI_CHIJI); if (!r?.active || c.cardId !== r.cardId || c.targetId === id || c.sourceId === id) return false; r.active = false; return true } })
registerSkillRuntime({ id: XINPI_YINJU, activeActions(s, id) { const owner = player(s, id); return s.phase === 'play' && s.currentPlayerId === id && owner?.marks.b29Yinju !== 1 && others(s, id).length ? [{ id: XINPI_YINJU, label: '引裾：指定一名角色' }] : [] }, invokeActive(h, id) { askTargets(h, XINPI_YINJU, id, others(h.state, id).map(x => x.id), '【引裾】：选择一名其他角色') }, outgoingDamage(s, id, c) { const r = (s as B29).b29?.[`${XINPI_YINJU}:${id}`]; if (r?.turn === s.turnNumber && r.targetId === c.targetId) return { amount: 0 }; return null }, triggers: [{ event: 'CardUsed', handle(h, id, c) { const r = get(h, id, XINPI_YINJU), d = c.event.payload as any; if (r?.turn === h.state.turnNumber && d.sourceId === id && d.targetIds?.includes(r.targetId)) { drawCards(h.state, id, 1, (n, x) => h.dispatch(n, x)); drawCards(h.state, r.targetId, 1, (n, x) => h.dispatch(n, x)) } } }], resume(h, id, r, res) { if (r.step !== 'target') return; const targetId = res.payload.targetIds?.[0]; if (!targetId) return; player(h.state, id)!.marks.b29Yinju = 1; setup(h, id, XINPI_YINJU, { targetId, turn: h.state.turnNumber }) } })

// 陈泰【救陷】【沉勇】：官网公开文本。
const CHENTAI_JIUXIAN = 'jiuxian-b29', CHENTAI_CHENYONG = 'chenyong-b29'
registerSkillRuntime({ id: CHENTAI_JIUXIAN, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, CHENTAI_JIUXIAN) && hand(s, id).length ? [{ id: CHENTAI_JIUXIAN, label: '救陷：重铸手牌视为决斗' }] : [] }, invokeActive(h, id) { const n = Math.ceil(hand(h.state, id).length / 2); askCards(h, CHENTAI_JIUXIAN, id, hand(h.state, id), `【救陷】：重铸${n}张手牌`, n, n) }, triggers: [{ event: 'CardResolved', handle(h, id, c) { const d = c.event.payload as any; if (d.sourceSkillId !== CHENTAI_JIUXIAN || d.cardName !== '决斗' || cardDamageDealt(h.state, d.cardId) <= 0) return; const target = player(h.state, d.targetIds?.[0]); const candidates = target ? h.state.players.filter(x => x.alive && x.id !== target.id && getDistance(h.state, target.id, x.id) <= getAttackRange(h.state, target.id)).map(x => x.id) : []; if (candidates.length) askTargets(h, CHENTAI_JIUXIAN, id, candidates, '【救陷】：选择一名角色回复1点体力', 1, 1, { heal: true }) } }], resume(h, id, r, res) { if (r.step === 'cards') { const ids = res.payload.cardIds ?? []; if (!ids.length) return; markUsedThisPhase(h.state, id, CHENTAI_JIUXIAN); discard(h, id, ids, CHENTAI_JIUXIAN); askTargets(h, CHENTAI_JIUXIAN, id, others(h.state, id).map(x => x.id), '【救陷】：选择【决斗】目标', 1, 1); return } if (r.step === 'target' && r.data?.heal) { const targetId = res.payload.targetIds?.[0]; if (targetId) recover(h as never, targetId, 1, id); return } if (r.step === 'target') { const targetId = res.payload.targetIds?.[0]; if (!targetId) return; const cardId = createVirtualTrick(h.state, id, '决斗', CHENTAI_JIUXIAN); const action = { id: `${CHENTAI_JIUXIAN}:${cardId}`, kind: 'use-card', playerId: id, label: '【救陷】视为使用【决斗】', cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1, asCardName: '决斗' }; executeUseCardAction(h as never, id, action as never, { skipPlayInterceptors: true }); } } })
registerSkillRuntime({ id: CHENTAI_CHENYONG, triggers: [{ event: 'PhaseEnd', handle(h, id, c) { const d = c.event.payload as any; if (d.playerId !== id || d.phase !== 'finish') return; const count = get(h, id, CHENTAI_CHENYONG)?.types ?? 0; if (count) drawCards(h.state, id, Math.min(3, count), (n, x) => h.dispatch(n, x)); setup(h, id, CHENTAI_CHENYONG, { types: 0 }) } }, { event: 'CardUsed', handle(h, id, c) { if (c.event.sourceId !== id) return; const r = get(h, id, CHENTAI_CHENYONG) ?? { types: 0, seen: [] }; const name = (c.event.payload as any).cardName; const type = h.state.cards[(c.event.payload as any).cardId]?.category ?? name; if (type && !r.seen.includes(type)) { r.seen.push(type); r.types = r.seen.length; setup(h, id, CHENTAI_CHENYONG, r) } } }] })

// 臧霸【横江】：官网公开文本。
const ZANGBA_HENGJIANG = 'hengjiang-b29'
registerSkillRuntime({ id: ZANGBA_HENGJIANG, triggers: [{ event: 'DamageSettled', handle(h, id, c) { if (c.event.targetId !== id || Number((c.event.payload as any).finalAmount ?? (c.event.payload as any).amount ?? 0) !== 1) return; const sourceId = c.event.sourceId; const source = sourceId && player(h.state, sourceId); if (!source) return; source.marks.b29HengjiangLimit = (source.marks.b29HengjiangLimit ?? 0) + 1; setup(h, id, ZANGBA_HENGJIANG, { sourceId, turn: h.state.turnNumber }) } }, { event: 'CardMove', handle(h, id, c) { const d = c.event.payload as any; if (d.sourcePlayerId && d.destinationZone === 'discardPile' && d.reason === 'discard') player(h.state, d.sourcePlayerId)?.marks && (player(h.state, d.sourcePlayerId)!.marks.b29Discarded = 1) } }, { event: 'PhaseEnd', handle(h, id, c) { const d = c.event.payload as any, r = get(h, id, ZANGBA_HENGJIANG); if (d.phase !== 'discard' || !r || d.playerId !== r.sourceId || r.turn !== h.state.turnNumber) return; const source = player(h.state, r.sourceId); if (source && !(source.marks.b29Discarded ?? 0)) drawCards(h.state, id, 1, (n, x) => h.dispatch(n, x)); delete source?.marks.b29HengjiangLimit; delete source?.marks.b29Discarded } }] , maxCardsBonus(s, id) { return 0 } })


// 马腾【雄异】：准备阶段选择一名其他角色，本回合计算距离-1并可多使用一张杀。
const MATENG_XIONGYI = 'xiongyi-b29'
registerSkillRuntime({ id: MATENG_XIONGYI, triggers: [{ event: 'PhaseStart', handle(h, id, c) { const d = c.event.payload as any; if (d.playerId === id && d.phase === 'prepare') askTargets(h, MATENG_XIONGYI, id, others(h.state, id).map(x => x.id), '【雄异】：选择一名其他角色') } }], directedDistanceTo(s, id, targetId) { return get({ state: s } as any, id, MATENG_XIONGYI)?.targetId === targetId ? -1 : 0 }, resume(h, id, r, res) { if (r.step === 'target') { const targetId = res.payload.targetIds?.[0]; setup(h, id, MATENG_XIONGYI, { targetId, turn: h.state.turnNumber }); grantTurnSlashBonus(h.state, id, { extraUses: 1 }) } } })

// 田丰【死谏】【随势】：官网公开文本。
const TIANFENG_SIJIAN = 'sijian-b29', TIANFENG_SUIshi = 'suishi-b29'
registerSkillRuntime({ id: TIANFENG_SIJIAN,
  triggers: [{ event: 'LoseCard', handle(h, id, c) { if (c.event.playerId !== id || hand(h.state, id).length) return; const candidates = others(h.state, id).filter(x => owned(h.state, x.id).length); if (candidates.length) h.queueSkill({ skillId: TIANFENG_SIJIAN, ownerId: id, step: 'target', data: {} }) } }],
  startQueued(h, id) { askTargets(h, TIANFENG_SIJIAN, id, others(h.state, id).filter(x => owned(h.state, x.id).length).map(x => x.id), '【死谏】：选择一名其他角色') },
  resume(h, id, r, res) {
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0]
      if (!targetId) return
      const ids = owned(h.state, targetId)
      if (!ids.length) return
      h.askSkill({ skillId: TIANFENG_SIJIAN, ownerId: id, step: 'card', data: { targetId, ids }, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: id, prompt: '【死谏】：选择该角色区域内的一张牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (r.step !== 'card') return
    const targetId = r.data.targetId as PlayerId
    const cardId = res.payload.cardIds?.[0]
    if (cardId && (r.data.ids as CardId[]).includes(cardId) && locateOwnedCard(h.state, targetId, cardId)) discard(h, targetId, [cardId], TIANFENG_SIJIAN)
  },
})
registerSkillRuntime({ id: TIANFENG_SUIshi, triggers: [{ event: 'DamageSettled', handle(h, id, c) { const source = player(h.state, c.event.sourceId), target = player(h.state, c.event.targetId); if (target?.id !== c.event.targetId || !source || source.kingdom !== player(h.state, id)?.kingdom) return; if (target.hp <= 0) drawCards(h.state, id, 1, (n, x) => h.dispatch(n, x)) } }, { event: 'Death', handle(h, id, c) { const dead = player(h.state, (c.event.payload as any).playerId); if (dead?.kingdom === player(h.state, id)?.kingdom) (player(h.state, id)!.hp = Math.max(0, player(h.state, id)!.hp - 1)) } }] })

// 审配【刚直】【备战】：按当前官方身份局文本实现。
const SHENPEI_GANGZHI = 'gangzhi-b29', SHENPEI_BEIZHAN = 'beizhan-b29'
registerSkillRuntime({ id: SHENPEI_GANGZHI, replacesDamageWithHpLoss(s, ownerId, c) { return c.targetId !== ownerId && c.sourceId === ownerId }, interceptIncomingDamage(h, ownerId, c) { if (c.sourceId === ownerId) return false; loseHp(h as never, ownerId, c.amount, SHENPEI_GANGZHI); return true } })
registerSkillRuntime({ id: SHENPEI_BEIZHAN, triggers: [{ event: 'PhaseEnd', handle(h, id, c) { const d = c.event.payload as any; if (d.playerId !== id || d.phase !== 'finish') return; h.queueSkill({ skillId: SHENPEI_BEIZHAN, ownerId: id, step: 'target', data: {} }) } }, { event: 'PhaseStart', handle(h, id, c) { const d = c.event.payload as any, r = get(h, id, SHENPEI_BEIZHAN); if (d.phase !== 'prepare' || !r?.targetId || d.playerId !== r.targetId) return; const target = player(h.state, r.targetId); if (!target) return; const max = Math.max(...h.state.players.filter(x => x.alive).map(x => x.zones.hand.length)); if (target.zones.hand.length === max && h.state.players.filter(x => x.alive && x.id !== target.id).every(x => x.zones.hand.length < max)) r.activeTurn = h.state.turnNumber } }], startQueued(h, id, q) { if (q.step !== 'target') return; askTargets(h, SHENPEI_BEIZHAN, id, h.state.players.filter(x => x.alive).map(x => x.id), '【备战】：选择一名角色'); }, resume(h, id, r, res) { if (r.step !== 'target') return; const targetId = res.payload.targetIds?.[0]; if (!targetId) return; const target = player(h.state, targetId); if (!target) return; const n = Math.max(0, Math.min(5, target.maxHp) - target.zones.hand.length); if (n) drawCards(h.state, targetId, n, (name, data) => h.dispatch(name, data)); setup(h, id, SHENPEI_BEIZHAN, { targetId, activeTurn: null }) }, prohibitsSourceTarget(s, ownerId, targetId) { const r = (s as B29).b29?.[`${SHENPEI_BEIZHAN}:${ownerId}`]; return Boolean(r?.activeTurn === s.turnNumber && targetId !== ownerId) } })


export const HISTORICAL_BATCH29_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'chenzhen', name: '陈震', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: CHENZHEN_CHUSHI, name: '出使', description: '出牌阶段限一次，选择一名其他角色，双方各摸一张牌。' }] },
  { id: 'jiangqin', name: '蒋钦', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: JIANGQIN_SHANGYI, name: '尚义', description: '出牌阶段限一次，令一名其他角色观看你的手牌并选择观看其手牌或暗置武将牌。' }, { id: JIANGQIN_NIAOXIANG, name: '鸟翔', description: '阵法技：围攻关系中，令目标需依次使用两张闪抵消杀。' }] },
  { id: 'xinpi', name: '辛毗', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: XINPI_CHIJI, name: '持节', description: '每回合限一次，成为其他角色使用牌的目标后，可令后续对你的伤害牌无效；牌未造成伤害时获得之。' }, { id: XINPI_YINJU, name: '引裾', description: '限定技，指定一名角色，本回合你对其造成的伤害改为回复，并在指定其为目标后双方摸牌。' }] },
  { id: 'chentai', name: '陈泰', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: CHENTAI_JIUXIAN, name: '救陷', description: '出牌阶段限一次，重铸一半手牌并视为对目标使用决斗。' }, { id: CHENTAI_CHENYONG, name: '沉勇', description: '结束阶段摸本回合使用过的牌类别数张牌。' }] },
  { id: 'zangba', name: '臧霸', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: ZANGBA_HENGJIANG, name: '横江', description: '受到1点伤害后令当前回合角色本回合手牌上限减1，若其弃牌阶段未弃牌则你摸一张牌。' }] },
  { id: 'mateng', name: '马腾', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [{ id: MATENG_XIONGYI, name: '雄异', description: '准备阶段选择一名角色，本回合对其距离减少且可额外使用一张杀。' }] },
  { id: 'tianfeng', name: '田丰', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: TIANFENG_SIJIAN, name: '死谏', description: '失去最后一张手牌时弃置一名其他角色的一张牌。' }, { id: TIANFENG_SUIshi, name: '随势', description: '同势力角色进入濒死时摸牌，同势力角色死亡时失去体力。' }] },
  { id: 'shenpei', name: '审配', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: SHENPEI_GANGZHI, name: '刚直', description: '锁定技，其他角色对你造成的伤害，和你对其他角色造成的伤害均视为失去体力。' }, { id: SHENPEI_BEIZHAN, name: '备战', description: '回合结束后令一名角色将手牌摸至其体力上限且至多为五张；其下回合手牌全场唯一最多时，不能使用牌指定其他角色为目标。' }] },
]
