// 第30批独立历史人物。资源继续使用 fallback，立绘与语音只保留接入字段。
// 孔融的规则参考三国杀 OL 公开文本；其余保留人物按已登记的官方规则实现。
// @ts-nocheck
import { drawCards } from '../../engine/draw'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const p = (s: SanguoshaState, id: PlayerId) => s.players.find(x => x.id === id)
const others = (s: SanguoshaState, id: PlayerId) => s.players.filter(x => x.alive && x.id !== id)
const hand = (s: SanguoshaState, id: PlayerId) => p(s, id)?.zones.hand ?? []
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, ids: PlayerId[], prompt: string, min = 1, max = 1, data: any = {}) { h.askSkill({ skillId, ownerId, step: 'target', data, build: requestId => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 20_000, optional: min === 0, candidateIds: ids, min, max }) }) }
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, ids: CardId[], prompt: string, min: number, max: number, data: any = {}) { h.askSkill({ skillId, ownerId, step: 'cards', data, build: requestId => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt, timeoutMs: 20_000, optional: min === 0, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) }) }
function discard(h: SkillHost, id: PlayerId, ids: CardId[], reason: string) { const moved: CardId[] = []; for (const cardId of ids) { const from = locateOwnedCard(h.state, id, cardId); if (!from) continue; moveCard(h.state, cardId, from, { kind: 'discardPile' }); moved.push(cardId) } if (moved.length) h.dispatch('LoseCard', { playerId: id, cardIds: moved, reason }, { sourceId: id, cardIds: moved }); return moved }

const KONGRONG_MINGSHI = 'mingshi-b30', KONGRONG_LIRANG = 'lirang-b30'
registerSkillRuntime({ id: KONGRONG_MINGSHI, incomingDamage(s, id, c) { const source = c.sourceId && p(s, c.sourceId); return source?.marks.generalHidden ? { amount: Math.max(0, c.amount - 1) } : null } })
registerSkillRuntime({ id: KONGRONG_LIRANG, triggers: [{ event: 'CardMove', handle(h, id, c) { const d = c.event.payload as any; if (d.sourcePlayerId !== id || d.destinationZone !== 'discardPile' || d.reason !== 'discard') return; const ids = (d.cardIds ?? []).filter(x => h.state.zones.discardPile.includes(x)); if (ids.length && others(h.state, id).length) h.queueSkill({ skillId: KONGRONG_LIRANG, ownerId: id, step: 'target', data: { ids } }) } }], startQueued(h, id, q) { askTargets(h, KONGRONG_LIRANG, id, others(h.state, id).map(x => x.id), '【礼让】：选择一名角色获得弃置牌') }, resume(h, id, r, res) { if (r.step !== 'target') return; const targetId = res.payload.targetIds?.[0]; const ids = r.data.ids ?? []; if (!targetId) return; for (const cardId of ids) if (h.state.zones.discardPile.includes(cardId)) moveCard(h.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId }) } })

const ZHONGYU_ZANMING = 'zanming-b30'
registerSkillRuntime({ id: ZHONGYU_ZANMING, triggers: [{ event: 'PhaseStart', handle(h, id, c) { const d = c.event.payload as any; if (d.playerId !== id || d.phase !== 'play') return; const candidates = others(h.state, id).filter(x => x.zones.hand.length); if (candidates.length) h.queueSkill({ skillId: ZHONGYU_ZANMING, ownerId: id, step: 'target', data: {} }) } }], startQueued(h, id) { askTargets(h, ZHONGYU_ZANMING, id, others(h.state, id).filter(x => x.zones.hand.length).map(x => x.id), '【赞明】：选择一名有手牌的角色') }, resume(h, id, r, res) { if (r.step === 'target') { const targetId = res.payload.targetIds?.[0]; if (!targetId) return; const n = Math.min(2, hand(h.state, targetId).length); askCards(h, ZHONGYU_ZANMING, id, hand(h.state, targetId), '【赞明】：选择其手牌作为代价', n, n, { targetId }); return } if (r.step === 'cards') { const targetId = r.data.targetId as PlayerId; const ids = (res.payload.cardIds ?? []).filter(x => hand(h.state, targetId).includes(x)); discard(h, targetId, ids, ZHONGYU_ZANMING); if (ids.length) drawCards(h.state, h.rng, id, ids.length, (n, d) => h.dispatch(n, d)) } } })

const PUYANGXING_HEZHONG = 'hezhong-b30'
registerSkillRuntime({ id: PUYANGXING_HEZHONG, activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, PUYANGXING_HEZHONG) && hand(s, id).length ? [{ id: PUYANGXING_HEZHONG, label: '合众：交牌令角色摸牌' }] : [] }, invokeActive(h, id) { askCards(h, PUYANGXING_HEZHONG, id, hand(h.state, id), '【合众】：选择一张牌', 1, 1) }, resume(h, id, r, res) { if (r.step === 'cards') { const cardId = res.payload.cardIds?.[0]; if (!cardId || !hand(h.state, id).includes(cardId)) return; askTargets(h, PUYANGXING_HEZHONG, id, others(h.state, id).map(x => x.id), '【合众】：选择一名其他角色', 1, 1, { cardId }); return } const targetId = res.payload.targetIds?.[0], cardId = r.data.cardId; if (r.step === 'target' && targetId && cardId && hand(h.state, id).includes(cardId)) { markUsedThisPhase(h.state, id, PUYANGXING_HEZHONG); moveCard(h.state, cardId, { kind: 'hand', playerId: id }, { kind: 'hand', playerId: targetId }); drawCards(h.state, h.rng, targetId, 2, (n, d) => h.dispatch(n, d)) } } })






export const HISTORICAL_BATCH30_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'kongrong', name: '孔融', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: KONGRONG_MINGSHI, name: '名士', description: '来源有暗置武将牌时受到的伤害-1。' }, { id: KONGRONG_LIRANG, name: '礼让', description: '牌因弃置进入弃牌堆时可交给其他角色。' }] },
  { id: 'zhongyu', name: '钟毓', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: ZHONGYU_ZANMING, name: '赞明', description: '出牌阶段开始时选择角色处理其手牌。' }] },
  { id: 'puyangxing', name: '濮阳兴', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'standard', skills: [{ id: PUYANGXING_HEZHONG, name: '合众', description: '交牌令一名角色摸两张牌。' }] },
]
