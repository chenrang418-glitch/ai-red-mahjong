// 武将册第35批（武将册序号465–474）。仅登记规则运行时已实现的角色。
// @ts-nocheck
import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { gainMaxHp } from '../../engine/hp'
import { moveCard, locateOwnedCard, effectiveEquipmentName, setEquipmentTransformation } from '../../engine/zones'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { usedThisTurn } from '../../engine/turn-usage'
import { resolveDamage, resumeTargetDamagePrevention, killPlayer, continueDyingRescue } from '../../engine/damage'
import { getDistance, getAttackRange } from '../../engine/distance'
import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { registerPindianContinuation, startPindian } from '../../engine/pindian'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { prohibitsBeingPindianTargetOf } from '../../engine/skills/runtime'
import { equipmentSlotsOf, isSlotAbolished, weaponCardsOf } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { skipPhase } from '../../engine/turn'
import { reshuffleDrawPile } from '../../engine/deck'
import { setChained } from '../../engine/character-state'

type B35State = SanguoshaState & { b35?: Record<string, any> }
const st = (h: SkillHost) => h.state as B35State
const pl = (s: SanguoshaState, id: PlayerId) => s.players.find(p => p.id === id)
const alive = (s: SanguoshaState) => s.players.filter(p => p.alive)
const others = (s: SanguoshaState, id: PlayerId) => alive(s).filter(p => p.id !== id)
const nextPlayersAfter = (s: SanguoshaState, id: PlayerId) => {
  const ordered = alive(s).sort((a, b) => a.seat - b.seat)
  const ownerIndex = ordered.findIndex(p => p.id === id)
  return ownerIndex < 0 ? ordered : [...ordered.slice(ownerIndex + 1), ...ordered.slice(0, ownerIndex)]
}
const hand = (s: SanguoshaState, id: PlayerId): CardId[] => pl(s, id)?.zones.hand ?? []
const skillState = (s: B35State, key: string) => s.b35?.[key]
const put = (h: SkillHost, key: string, value: any) => { st(h).b35 ??= {}; st(h).b35[key] = value; return value }
const remove = (s: B35State, key: string) => { if (s.b35) delete s.b35[key] }
function askOption(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, step: string, prompt: string, options: Array<{id: string; label: string}>, data: any = {}, optional = true) {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-option', playerId, prompt, timeoutMs: 20_000, optional, options }) })
}
function askTargets(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, ids: PlayerId[], prompt: string, data: any = {}, optional = false, min = 1, max = 1, step = 'target') {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-targets', playerId, prompt, timeoutMs: 20_000, optional, candidateIds: ids, min, max }) })
}
function askCards(h: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId, ids: CardId[], prompt: string, min: number, max: number, data: any = {}, optional = false, step = 'cards') {
  h.askSkill({ skillId, ownerId, step, data, build: id => ({ id, kind: 'choose-cards', playerId, prompt, timeoutMs: 20_000, optional, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min, max }) })
}
function discard(h: SkillHost, id: PlayerId, ids: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(ids)]) {
    const from = locateOwnedCard(h.state, id, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(h as never, id, cardId)
    moved.push(cardId)
  }
  if (moved.length) h.dispatch('LoseCard', { playerId: id, cardIds: moved, reason }, { sourceId: id, cardIds: moved })
  return moved
}
function give(h: SkillHost, fromId: PlayerId, toId: PlayerId, ids: CardId[], reason: string) {
  const moved: CardId[] = []
  for (const cardId of [...new Set(ids)]) {
    const from = locateOwnedCard(h.state, fromId, cardId)
    if (!from) continue
    moveCard(h.state, cardId, from, { kind: 'hand', playerId: toId }); moved.push(cardId)
  }
  if (moved.length) h.dispatch('GainCard', { playerId: toId, cardIds: moved, reason }, { sourceId: fromId, targetId: toId, cardIds: moved })
  return moved
}
function pile(h: SkillHost, id: PlayerId, name: string): CardId[] {
  const p = pl(h.state, id)
  if (!p) return []
  p.characterPiles ??= {}
  p.characterPiles[name] ??= []
  return p.characterPiles[name]
}
function drawTopByColor(h: SkillHost, id: PlayerId, color: 'red'|'black', pileName: string) {
  const i = h.state.zones.drawPile.findIndex(cardId => h.state.cards[cardId]?.color === color)
  if (i < 0) return null
  const cardId = h.state.zones.drawPile[i]
  moveCard(h.state, cardId, { kind: 'drawPile', index: i }, { kind: 'characterPile', playerId: id, pile: pileName })
  h.dispatch('CardMoved', { cardId, to: pileName, reason: 'skill' }, { targetId: id, cardIds: [cardId] })
  return cardId
}
function gainFromPile(h: SkillHost, id: PlayerId, name: string, ids: CardId[]) {
  const source = pile(h, id, name)
  const moved = ids.filter(cardId => source.includes(cardId))
  for (const cardId of moved) moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: name }, { kind: 'hand', playerId: id })
  if (moved.length) h.dispatch('GainCard', { playerId: id, cardIds: moved, reason: name }, { targetId: id, cardIds: moved })
  return moved
}

const ZERONG_FUTU = 'futu-b35', ZERONG_JINGTU = 'jingtu-b35', ZERONG_JIEBIAN = 'jiebian-b35', ZERONG_FOZONG = 'fozong-b35'
const MIFUREN_GUIXIU = 'guixiu-b35', MIFUREN_QINGYU = 'qingyu-b35', MIFUREN_XUANCUN = 'xuancun-b35'
const LIRU_JUECE = 'juece-jie-b35', LIRU_MIEJI = 'mieji-jie-b35', LIRU_FENCHENG = 'fencheng-jie-b35'
const MAJUN_JINGXIE = 'jingxie-b35', MAJUN_QIAOSI = 'qiaosi-b35'
const PANZHANG_DUODAO = 'duodao-jie-b35', PANZHANG_ANJIAN = 'anjian-jie-b35'
const PANGDEGONG_PINGCAI = 'pingcai-b35', PANGDEGONG_YINSHI = 'yinshi-b35'
const PINGCAI_CELL_COUNT = 16
type PingcaiTreasure = 'wolong' | 'fengchu' | 'shuijing' | 'xuanjian'
const PINGCAI_TREASURES: Array<{ id: PingcaiTreasure; name: string }> = [
  { id: 'wolong', name: '卧龙' }, { id: 'fengchu', name: '凤雏' },
  { id: 'shuijing', name: '水镜' }, { id: 'xuanjian', name: '玄剑' },
]
const LIFENG_TUNCHU = 'tunchu-b35', LIFENG_SHULIANG = 'shuliang-b35'
const YANBAIHU_ZHIDAO = 'zhidao-b35', YANBAIHU_JILI = 'jili-b35'
const LAIMIN_LAISHOU = 'laishou-b35', LAIMIN_LUANQUN = 'luanqun-b35'
const MALIAN_ZISHU = 'zishu-b35', MALIAN_YINGYUAN = 'yingyuan-b35'

export const ZERONG_B35: CharacterDefinition = { id: 'zherong', name: '笮融', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: ZERONG_FUTU, name: '浮图', description: '每回合结束时，若你于此回合内造成伤害最多，你将牌堆顶的首张黑色牌置于你的武将牌上；若令角色回复体力最多，你将牌堆顶的首张红色牌置于你的武将牌上，称为“业”。当你受到伤害时，你可以将一张“业”置入弃牌堆防止之。' },
  { id: ZERONG_JINGTU, name: '净土', description: '限定技，出牌阶段，你可以选择获得所有黑色“业”并对一名角色造成等量伤害，或获得所有红色“业”并令一名角色增加等量体力上限且回复等量体力。若两种颜色“业”数相等且均大于1，可背水。然后你失去“浮图”并获得“佛宗”。' },
  { id: ZERONG_JIEBIAN, name: '劫辨', description: '一名角色的出牌阶段结束时，若本阶段没有角色受到过伤害，你可以与当前回合角色或体力值最低的角色拼点（可用“业”拼点）；若赢，你对其造成1点伤害，或令其回复1点体力并摸一张牌，然后获得其两张牌。' },
  { id: ZERONG_FOZONG, name: '佛宗', description: '锁定技，你与因“净土”获得的牌颜色相同的牌不计入手牌上限，且你造成伤害与回复体力的值均+1。', granted: true },
] }
export const MIFUREN_B35: CharacterDefinition = { id: 'mi-furen', name: '糜夫人', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
  { id: MIFUREN_GUIXIU, name: '闺秀', description: '锁定技，结束阶段，若你的体力值为单数则摸一张牌，否则回复1点体力。' },
  { id: MIFUREN_QINGYU, name: '清玉', description: '使命技。当你受到伤害时，你弃置两张牌并防止之。成功：准备阶段，若你体力已满且没有手牌，你获得“悬存”。失败：成功前进入濒死时，你减少1点体力上限。' },
  { id: MIFUREN_XUANCUN, name: '悬存', description: '其他角色的回合结束时，若你的手牌数小于体力值，你可以令其摸X张牌（X为差值且至多为2）。', granted: true },
] }
export const LIRU_JIE_B35: CharacterDefinition = { id: 'li-ru-jie', name: '界·李儒', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: LIRU_JUECE, name: '绝策', description: '结束阶段，你可以对本回合失去过牌的一名其他角色造成1点伤害。' },
  { id: LIRU_MIEJI, name: '灭计', description: '出牌阶段限一次，你可以展示一张黑色锦囊牌并将之置于牌堆顶，令一名有牌的其他角色选择：交给你一张锦囊牌，或弃置两张非锦囊牌（不足则尽可能弃置）。' },
  { id: LIRU_FENCHENG, name: '焚城', description: '限定技，出牌阶段，你令所有其他角色依次选择：弃置至少X张牌（X为上一名角色因此弃置的数量+1），或受到你造成的2点火焰伤害。' },
] }
export const MAJUN_B35: CharacterDefinition = { id: 'ma-jun', name: '马钧', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: MAJUN_JINGXIE, name: '精械', description: '出牌阶段，你可以展示手牌或装备区的一张防具牌或【诸葛连弩】，将其改造为对应精械装备并获得相应效果。进入濒死时，你可以重铸一张防具牌，若如此做，将体力回复至1点。' },
  { id: MAJUN_QIAOSI, name: '巧思', description: '出牌阶段限一次，你可以操作“水转百戏图”小游戏获得对应牌，然后弃置等量的牌或将等量的牌交给一名其他角色。' },
] }
export const PANZHANG_MAZHONG_JIE_B35: CharacterDefinition = { id: 'panzhang-mazhong-jie', name: '界·潘璋马忠', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: PANZHANG_DUODAO, name: '夺刀', description: '当你受到伤害后，你可以获得伤害来源装备区里的武器牌。' },
  { id: PANZHANG_ANJIAN, name: '暗箭', description: '锁定技，当你使用【杀】指定目标后，若你不在其攻击范围内，你令其不能响应此【杀】，或令此【杀】对其伤害+1。' },
] }
export const PANGDEGONG_B35: CharacterDefinition = { id: 'pang-degong', name: '庞德公', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: PANGDEGONG_PINGCAI, name: '评才', description: '出牌阶段限一次，你可以选择“卧龙、凤雏、水镜、玄剑”之一并进行对应宝物小游戏。成功后执行对应效果；场上存活的诸葛亮、庞统、司马徽或徐庶可强化相应效果。' },
  { id: PANGDEGONG_YINSHI, name: '隐世', description: '锁定技，你只有摸牌、出牌和弃牌阶段；你不能成为延时锦囊牌的目标。' },
] }
export const LIFENG_B35: CharacterDefinition = { id: 'li-feng', name: '李丰', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: LIFENG_TUNCHU, name: '屯储', description: '摸牌阶段，若没有“粮”，你可以额外摸两张牌，然后可以将任意张手牌置于武将牌上称为“粮”；若有“粮”，你不能使用【杀】。' },
  { id: LIFENG_SHULIANG, name: '输粮', description: '一名角色的结束阶段开始时，若其手牌数小于体力值，你可以将一张“粮”置入弃牌堆，然后其摸两张牌。' },
] }
export const YANBAIHU_B35: CharacterDefinition = { id: 'yan-baihu', name: '严白虎', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
  { id: YANBAIHU_ZHIDAO, name: '雉盗', description: '锁定技，你于出牌阶段内第一次对其他角色造成伤害后，若其区域内有牌，你获得其手牌、装备区和判定区里各一张牌，然后其他角色不能成为你使用牌的目标直到回合结束。' },
  { id: YANBAIHU_JILI, name: '寄篱', description: '锁定技，当一名其他角色成为红色基本牌或红色普通锦囊牌的目标时，若其与你距离为1且你不是此牌的使用者或目标，你成为此牌的额外目标。' },
] }
export const LAIMIN_B35: CharacterDefinition = { id: 'lai-min', name: '来敏', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: LAIMIN_LAISHOU, name: '来寿', description: '锁定技，当你受到伤害且此伤害会令你进入濒死时，若体力上限小于9，你防止此伤害并增加等量体力上限。准备阶段，若体力上限不小于9，你死亡。' },
  { id: LAIMIN_LUANQUN, name: '乱群', description: '出牌阶段限一次，所有角色同时展示一张手牌；你获得其他角色至多四张与所展示牌颜色相同的牌（规则册选定军争数值）。颜色不同者获得“乱群”标记；其出牌阶段第一张【杀】只能指定你且你不能响应，该角色回合结束时移除标记。' },
] }
export const MALIANG_B35: CharacterDefinition = { id: 'ma-liang', name: '马良', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
  { id: MALIAN_ZISHU, name: '自书', description: '锁定技，你的回合外获得的牌于当前角色回合结束时置入弃牌堆；你的回合内，当你不因该技能效果获得牌时，摸一张牌。' },
  { id: MALIAN_YINGYUAN, name: '应援', description: '当你于回合内使用的牌置入弃牌堆后，你可以将之交给一名其他角色；每回合每种牌名限一次。' },
] }

const LUANQUN_TAG = 'luanqun-simultaneous-b35'
const JIEBIAN_TAG = 'zherong-jiebian-pindian-b35'
const ZERONG_PILE = 'ye'
const MIFUREN_MISSION = 'mifuren-mission-b35'
const LIRU_DAMAGE_LEDGER = 'li-ru-loss-ledger-b35'
const LIRU_LOCKED = 'li-ru-fencheng-b35'
const LAIMIN_MARK = 'luanqun-b35'
const deal = (h: SkillHost, sourceId: PlayerId, targetId: PlayerId, amount: number, nature: 'normal'|'fire', cardName: string) =>
  resolveDamage(h as never, { sourceId, targetId, amount, nature, cardName })

function askFenchengNext(h: SkillHost, ownerId: PlayerId) {
  const state = skillState(st(h), `${LIRU_LOCKED}:${ownerId}`)
  if (!state) return
  if (state.index >= state.targets.length) { remove(st(h), `${LIRU_LOCKED}:${ownerId}`); return }
  const targetId = state.targets[state.index] as PlayerId
  const target = pl(h.state, targetId)
  if (!target?.alive) { state.previousDiscard = 0; state.index += 1; askFenchengNext(h, ownerId); return }
  const options = [{ id: 'damage', label: '受到2点火焰伤害' }]
  const cards = [...hand(h.state, targetId), ...Object.values(target.zones.equipment).filter(Boolean)]
  if (cards.length >= state.previousDiscard + 1) options.unshift({ id: 'discard', label: `弃置至少${state.previousDiscard + 1}张牌` })
  askOption(h, LIRU_FENCHENG, ownerId, targetId, 'fencheng-mode', '【焚城】：选择一项', options, {}, false)
}

// 糜夫人：使命伤害防止使用统一的可挂起伤害续接，不在伤害事件后补血模拟。
registerSkillRuntime({
  id: MIFUREN_QINGYU,
  onGameStart(_h, id) { put(_h, `${MIFUREN_MISSION}:${id}`, { complete: false }) },
  offersTargetDamagePreventionAsk(h, id, context) {
    if (context.targetId !== id || !pl(h.state, id)?.alive) return false
    const mission = skillState(st(h), `${MIFUREN_MISSION}:${id}`)
    const cards = [...hand(h.state, id), ...Object.values(pl(h.state, id)?.zones.equipment ?? {}).filter(Boolean)]
    if (cards.length < 2) return false
    h.queueSkill({ skillId: MIFUREN_QINGYU, ownerId: id, step: 'prevent', data: { amount: context.amount } })
    return true
  },
  startQueued(h, id, q) {
    if (q.step !== 'prevent') return
    const cards = [...hand(h.state, id), ...Object.values(pl(h.state, id)?.zones.equipment ?? {}).filter(Boolean)]
    if (!pl(h.state, id)?.alive || cards.length < 2) {
      resumeTargetDamagePrevention(h as never, false); return
    }
    askCards(h, MIFUREN_QINGYU, id, id, cards, '【清玉】：弃置两张牌防止此伤害', 2, 2, { amount: q.data.amount }, false)
  },
  resume(h, id, r, res) {
    const ids = (res.payload.cardIds ?? []).filter(cardId => locateOwnedCard(h.state, id, cardId))
    if (r.step === 'cards' && ids.length === 2 && discard(h, id, ids, MIFUREN_QINGYU).length === 2) {
      resumeTargetDamagePrevention(h as never, true, MIFUREN_QINGYU)
    } else resumeTargetDamagePrevention(h as never, false)
  },
  triggers: [
    { event: 'PhaseStart', handle(h, id, c) {
      const p = c.event.payload as any
      const mission = skillState(st(h), `${MIFUREN_MISSION}:${id}`)
      const owner = pl(h.state, id)
      if (p.phase === 'prepare' && p.playerId === id && owner?.alive && !mission?.complete && owner.hp === owner.maxHp && hand(h.state, id).length === 0) {
        put(h, `${MIFUREN_MISSION}:${id}`, { complete: true })
        owner.grantedSkills ??= []
        if (!owner.grantedSkills.includes(MIFUREN_XUANCUN)) owner.grantedSkills.push(MIFUREN_XUANCUN)
        h.dispatch('SkillActivated', { skillId: MIFUREN_QINGYU, skillName: '清玉', playerId: id, result: 'mission-complete', grantedSkillId: MIFUREN_XUANCUN })
      }
    } },
    { event: 'EnterDying', handle(h, id, c) {
      if (c.event.targetId !== id || skillState(st(h), `${MIFUREN_MISSION}:${id}`)?.complete) return
      const owner = pl(h.state, id)
      if (!owner?.alive || owner.maxHp <= 0) return
      const oldMax = owner.maxHp
      owner.maxHp -= 1
      owner.hp = Math.min(owner.hp, owner.maxHp)
      h.dispatch('MaxHpChange', { playerId: id, amount: -1, maxHp: owner.maxHp, hp: owner.hp, trimmed: Math.max(0, 1 - owner.maxHp), reason: MIFUREN_QINGYU }, { targetId: id })
      put(h, `${MIFUREN_MISSION}:${id}`, { complete: false, failed: true, previousMaxHp: oldMax })
    } },
  ],
})

// 笮融【浮图】跨角色统计每名角色一个回合内实际造成的伤害与回复量。
registerSkillRuntime({
  id: ZERONG_FUTU,
  offersTargetDamagePreventionAsk(h, id, context) {
    if (context.targetId !== id || !pile(h, id, ZERONG_PILE).length) return false
    h.queueSkill({ skillId: ZERONG_FUTU, ownerId: id, step: 'prevent', data: { amount: context.amount } })
    return true
  },
  startQueued(h, id, q) {
    if (q.step !== 'prevent') return
    const cards = pile(h, id, ZERONG_PILE)
    if (!pl(h.state, id)?.alive || !cards.length) { resumeTargetDamagePrevention(h as never, false); return }
    askOption(h, ZERONG_FUTU, id, id, 'prevent-choice', '【浮图】：是否弃置一张“业”防止此伤害？', [{ id: 'yes', label: '弃置一张“业”并防止伤害' }, { id: 'no', label: '不防止' }], { amount: q.data.amount }, true)
  },
  triggers: [
    { event: 'DamageSettled', handle(h, _id, c) {
      const amount = Number((c.event.payload as any).finalAmount ?? 0)
      const actor = c.event.sourceId
      if (!actor || amount <= 0) return
      const key = `${ZERONG_FUTU}:damage:${h.state.turnNumber}`
      const totals = skillState(st(h), key) ?? {}
      totals[actor] = Number(totals[actor] ?? 0) + amount
      put(h, key, totals)
    } },
    { event: 'Recover', handle(h, _id, c) {
      const amount = Number((c.event.payload as any).amount ?? 0)
      const actor = c.event.sourceId
      if (!actor || amount <= 0) return
      const key = `${ZERONG_FUTU}:recover:${h.state.turnNumber}`
      const totals = skillState(st(h), key) ?? {}
      totals[actor] = Number(totals[actor] ?? 0) + amount
      put(h, key, totals)
    } },
    { event: 'TurnEnd', priority: -50, handle(h, id, c) {
      const p = c.event.payload as any
      const turn = Number(p.turnNumber)
      const damage = skillState(st(h), `${ZERONG_FUTU}:damage:${turn}`) ?? {}
      const recoveries = skillState(st(h), `${ZERONG_FUTU}:recover:${turn}`) ?? {}
      const maximumDamage = Math.max(0, ...Object.values(damage).map(Number))
      const maximumRecover = Math.max(0, ...Object.values(recoveries).map(Number))
      if (pl(h.state, id)?.alive && Number(damage[id] ?? 0) === maximumDamage) drawTopByColor(h, id, 'black', ZERONG_PILE)
      if (pl(h.state, id)?.alive && Number(recoveries[id] ?? 0) === maximumRecover) drawTopByColor(h, id, 'red', ZERONG_PILE)
      if (p.playerId === id) {
        remove(st(h), `${ZERONG_FUTU}:damage:${turn}`)
        remove(st(h), `${ZERONG_FUTU}:recover:${turn}`)
      }
    } },
  ],
  // resume also owns the actual “业” payment; use of this skill is optional, payment is not.
  resume(h, id, r, res) {
    if (r.step === 'prevent-choice') {
      if (res.payload.optionId !== 'yes') { resumeTargetDamagePrevention(h as never, false); return }
      const cards = pile(h, id, ZERONG_PILE)
      if (!cards.length) { resumeTargetDamagePrevention(h as never, false); return }
      askCards(h, ZERONG_FUTU, id, id, cards, '【浮图】：选择一张“业”置入弃牌堆', 1, 1, {}, false, 'ye-card')
      return
    }
    if (r.step !== 'ye-card') return
    const cardId = res.payload.cardIds?.[0]
    const cards = pile(h, id, ZERONG_PILE)
    if (!cardId || !cards.includes(cardId)) { resumeTargetDamagePrevention(h as never, false); return }
    moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: ZERONG_PILE }, { kind: 'discardPile' })
    h.dispatch('LoseCard', { playerId: id, cardIds: [cardId], reason: ZERONG_FUTU }, { sourceId: id, cardIds: [cardId] })
    resumeTargetDamagePrevention(h as never, true, ZERONG_FUTU)
  },
})

registerSkillRuntime({
  id: ZERONG_FOZONG,
  handLimitExempt(s, id, cardId) {
    const colors = skillState(st({ state: s } as SkillHost), `${ZERONG_FOZONG}:${id}:colors`) ?? []
    return colors.includes(s.cards[cardId]?.color)
  },
  outgoingDamage(s, id, context) {
    return (pl(s, id)?.grantedSkills ?? []).includes(ZERONG_FOZONG) ? { amount: context.amount + 1 } : null
  },
  recoverAmountBonus(s, id) { return (pl(s, id)?.grantedSkills ?? []).includes(ZERONG_FOZONG) ? 1 : 0 },
})

registerSkillRuntime({
  id: MIFUREN_GUIXIU,
  triggers: [{ event: 'PhaseStart', handle(h, id, c) {
    const p = c.event.payload as any
    if (p.phase !== 'finish' || p.playerId !== id) return
    const owner = pl(h.state, id)
    if (!owner?.alive) return
    if (Math.abs(owner.hp % 2) === 1) drawCards(h.state, h.rng, id, 1, (n, data) => h.dispatch(n, data))
    else recover(h, id, 1, id)
  } }],
})

const MAJUN_EQUIPMENT_UPGRADES: Record<string, string> = {
  '诸葛连弩': '元戎精械弩',
  '八卦阵': '先天八卦阵',
  '仁王盾': '仁王金刚盾',
  '白银狮子': '照月狮子盔',
  '藤甲': '桐油百韧甲',
}
const MAJUN_ARMORS = new Set(['八卦阵', '仁王盾', '藤甲', '白银狮子'])
function maJunUpgradeableCards(s: SanguoshaState, id: PlayerId): CardId[] {
  const owner = pl(s, id)
  if (!owner) return []
  const candidates = [...hand(s, id), ...Object.values(owner.zones.equipment).filter(Boolean)] as CardId[]
  return candidates.filter(cardId => !s.equipmentTransformations?.[cardId]
    && Object.hasOwn(MAJUN_EQUIPMENT_UPGRADES, s.cards[cardId]?.name ?? '')
    && (s.cards[cardId]?.category === 'equipment'))
}
registerSkillRuntime({
  id: MAJUN_JINGXIE,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && maJunUpgradeableCards(s, id).length
      ? [{ id: MAJUN_JINGXIE, label: '精械：改造一张防具牌或【诸葛连弩】' }] : []
  },
  invokeActive(h, id) {
    const candidates = maJunUpgradeableCards(h.state, id)
    if (!candidates.length) return
    askCards(h, MAJUN_JINGXIE, id, id, candidates, '【精械】：选择并展示一张防具牌或【诸葛连弩】', 1, 1)
  },
  unlimitedSlashFor(s, id) {
    return weaponCardsOf(s, id).some(cardId => effectiveEquipmentName(s, cardId) === '元戎精械弩')
  },
  triggers: [{ event: 'LoseEquipment', handle(h, id, c) {
    const p = c.event.payload as any
    const cardId = p.cardId as CardId | undefined
    if (p.playerId !== id || !cardId || effectiveEquipmentName(h.state, cardId) !== '照月狮子盔' || !pl(h.state, id)?.alive) return
    drawCards(h.state, h.rng, id, 2, (name, data) => h.dispatch(name, data))
  } }],
  dyingIntercept(h, id) {
    const armor = hand(h.state, id).filter(cardId => MAJUN_ARMORS.has(effectiveEquipmentName(h.state, cardId)))
    if (!armor.length) return false
    askOption(h, MAJUN_JINGXIE, id, id, 'dying-invoke', '你处于濒死状态，是否重铸一张防具牌并将体力回复至1点？', [
      { id: 'yes', label: '重铸一张防具牌，回复至1点体力' }, { id: 'no', label: '不发动' },
    ], {}, true)
    return 'pending'
  },
  resume(h, id, r, res) {
    if (r.step === 'cards') {
      const cardId = res.payload.cardIds?.[0] as CardId | undefined
      if (!cardId || !maJunUpgradeableCards(h.state, id).includes(cardId)) return
      const newName = MAJUN_EQUIPMENT_UPGRADES[h.state.cards[cardId]?.name ?? '']
      if (!newName) return
      setEquipmentTransformation(h.state, cardId, newName)
      h.dispatch('CardMove', { playerId: id, cardIds: [cardId], reason: MAJUN_JINGXIE, revealed: true, transformedName: newName }, { sourceId: id, cardIds: [cardId] })
      h.dispatch('SkillActivated', { skillId: MAJUN_JINGXIE, skillName: '精械', playerId: id, cardId, transformedName: newName }, { sourceId: id, cardIds: [cardId] })
      return
    }
    if (r.step === 'dying-invoke') {
      if (res.payload.optionId !== 'yes') {
        continueDyingRescue(h as never)
        if (!h.state.dying) h.resumeAfterDying()
        return
      }
      const armor = hand(h.state, id).filter(cardId => MAJUN_ARMORS.has(effectiveEquipmentName(h.state, cardId)))
      if (!armor.length) { continueDyingRescue(h as never); return }
      askCards(h, MAJUN_JINGXIE, id, id, armor, '【精械】：选择一张防具牌重铸', 1, 1, {}, false, 'recast-armor')
      return
    }
    if (r.step === 'recast-armor') {
      const cardId = res.payload.cardIds?.[0] as CardId | undefined
      if (!cardId || !hand(h.state, id).includes(cardId) || !MAJUN_ARMORS.has(effectiveEquipmentName(h.state, cardId))) {
        continueDyingRescue(h as never); return
      }
      moveCard(h.state, cardId, { kind: 'hand', playerId: id }, { kind: 'discardPile' })
      h.dispatch('LoseCard', { playerId: id, cardIds: [cardId], reason: MAJUN_JINGXIE }, { sourceId: id, cardIds: [cardId] })
      drawCards(h.state, h.rng, id, 1, (name, data) => h.dispatch(name, data))
      const owner = pl(h.state, id)
      if (owner?.alive && h.state.dying?.playerId === id) {
        const before = owner.hp
        owner.hp = 1
        h.dispatch('Recover', { playerId: id, amount: Math.max(0, 1 - before), reason: MAJUN_JINGXIE }, { targetId: id })
        h.dispatch('QuitDying', { playerId: id, hp: owner.hp, reason: MAJUN_JINGXIE }, { targetId: id })
        h.state.dying = null
        h.resumeAfterDying()
      }
    }
  },
})

const MAJUN_WATERWHEEL = 'ma-jun-waterwheel-b35'
const WATERWHEEL_LIMITS = [3, 2, 1, 1, 2, 3]
type WaterwheelReward = 'trick' | 'equipment' | 'offensive-basic' | 'defensive-basic'
const WATERWHEEL_REWARDS: WaterwheelReward[][] = [
  ['trick', 'trick'], ['equipment'], ['offensive-basic'], ['defensive-basic'], ['trick'], ['equipment', 'equipment'],
]

function rollWaterwheelReward(h: SkillHost, puppet: number): WaterwheelReward {
  // 商人、士人偶有小概率偏出对应的攻击/防御基本牌；牌名在牌堆现存牌中抽取。
  if (puppet === 1 && h.rng.nextInt(4) === 0) return 'offensive-basic'
  if (puppet === 4 && h.rng.nextInt(4) === 0) return 'defensive-basic'
  return WATERWHEEL_REWARDS[puppet][puppet === 0 || puppet === 5 ? (h.rng.nextInt(2)) : 0]
}

function waterwheelCardName(h: SkillHost, reward: WaterwheelReward): string | null {
  if (reward === 'offensive-basic') return h.rng.nextInt(4) === 0 ? '酒' : '杀'
  if (reward === 'defensive-basic') return h.rng.nextInt(4) === 0 ? '桃' : '闪'
  return null
}

function askWaterwheel(h: SkillHost, id: PlayerId): void {
  const state = skillState(st(h), `${MAJUN_WATERWHEEL}:${id}`)
  if (!state) return
  const remainingMs = Math.max(0, state.deadlineAt - Date.now())
  h.askSkill({
    skillId: MAJUN_QIAOSI, ownerId: id, step: 'waterwheel', data: {},
    build: requestId => ({
      id: requestId, kind: 'choose-option', playerId: id,
      prompt: '【巧思】：点击水阀操作水转百戏图（点亮三个人偶或10秒结束）',
      timeoutMs: Math.max(1, remainingMs), optional: true,
      options: [
        ...WATERWHEEL_LIMITS.map((limit, index) => ({ id: `valve:${index}`, label: `水阀${index + 1}（${state.progress[index]}/${limit}）` })),
      ],
      interaction: { kind: 'waterwheel', progress: [...state.progress], active: [...state.active] },
    }),
  })
}

function finishWaterwheel(h: SkillHost, id: PlayerId): void {
  const key = `${MAJUN_WATERWHEEL}:${id}`
  const state = skillState(st(h), key)
  if (!state) return
  remove(st(h), key)
  const gained: CardId[] = []
  for (const puppet of state.active as number[]) {
    for (const reward of WATERWHEEL_REWARDS[puppet]) {
      const rolledReward = rollWaterwheelReward(h, puppet)
      const resolvedReward = reward === 'equipment' && rolledReward === 'offensive-basic' ? rolledReward
        : reward === 'trick' && rolledReward === 'defensive-basic' ? rolledReward : reward
      const category = resolvedReward === 'trick' ? 'trick' : resolvedReward === 'equipment' ? 'equipment' : 'basic'
      const desiredName = waterwheelCardName(h, resolvedReward)
      if (!h.state.zones.drawPile.length) reshuffleDrawPile(h.state, h.rng, (name, data) => h.dispatch(name, data))
      if (!h.state.zones.drawPile.length) break
      let candidates = h.state.zones.drawPile.filter(cardId => h.state.cards[cardId]?.category === category
        && (!desiredName || h.state.cards[cardId]?.name === desiredName))
      if (!candidates.length && desiredName) candidates = h.state.zones.drawPile.filter(cardId => h.state.cards[cardId]?.category === category)
      // 牌堆缺少对应类别时，按牌堆中现存牌补足，不凭空生成奖励牌。
      if (!candidates.length) candidates = [...h.state.zones.drawPile]
      const cardId = candidates[h.rng.nextInt(candidates.length)]
      const fromIndex = h.state.zones.drawPile.indexOf(cardId)
      if (fromIndex < 0) continue
      moveCard(h.state, cardId, { kind: 'drawPile', index: fromIndex }, { kind: 'hand', playerId: id })
      gained.push(cardId)
    }
  }
  if (gained.length) h.dispatch('GainCard', { playerId: id, cardIds: gained, reason: MAJUN_QIAOSI }, { targetId: id, cardIds: gained })
  h.dispatch('SkillActivated', { skillId: MAJUN_QIAOSI, skillName: '巧思', playerId: id, cardIds: gained, puppets: [...state.active] }, { sourceId: id, cardIds: gained })
  if (gained.length) {
    const ownedCount = hand(h.state, id).length + Object.values(pl(h.state, id)?.zones.equipment ?? {}).filter(Boolean).length
    const options = [
      ...(ownedCount >= gained.length ? [{ id: 'discard', label: `弃置${gained.length}张牌` }] : []),
      ...(others(h.state, id).length && hand(h.state, id).length >= gained.length ? [{ id: 'give', label: `交给一名其他角色${gained.length}张牌` }] : []),
    ]
    if (options.length) askOption(h, MAJUN_QIAOSI, id, id, 'payment-mode', `【巧思】：选择一项（获得${gained.length}张牌）`, options, { gainedCount: gained.length }, false)
  }
}

registerSkillRuntime({
  id: MAJUN_QIAOSI,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, MAJUN_QIAOSI)
      ? [{ id: MAJUN_QIAOSI, label: '巧思：操作水转百戏图' }] : []
  },
  invokeActive(h, id) {
    if (usedThisPhase(h.state, id, MAJUN_QIAOSI)) return
    markUsedThisPhase(h.state, id, MAJUN_QIAOSI)
    put(h, `${MAJUN_WATERWHEEL}:${id}`, { deadlineAt: Date.now() + 10_000, progress: [0, 0, 0, 0, 0, 0], active: [] })
    askWaterwheel(h, id)
  },
  resume(h, id, request, response) {
    if (request.step === 'waterwheel') {
      const state = skillState(st(h), `${MAJUN_WATERWHEEL}:${id}`)
      if (!state) return
      if (Date.now() >= state.deadlineAt) { finishWaterwheel(h, id); return }
      const match = /^valve:([0-5])$/.exec(String(response.payload.optionId ?? ''))
      if (match) {
        const index = Number(match[1])
        if (!state.active.includes(index)) {
          state.progress[index] = Math.min(WATERWHEEL_LIMITS[index], state.progress[index] + 1)
          if (state.progress[index] >= WATERWHEEL_LIMITS[index]) state.active.push(index)
        }
        if (state.active.length >= 3 || Date.now() >= state.deadlineAt) { finishWaterwheel(h, id); return }
      }
      askWaterwheel(h, id)
      return
    }
    if (request.step === 'payment-mode') {
      const count = Number(request.data.gainedCount) || 0
      if (response.payload.optionId === 'discard') {
        const cards = [...hand(h.state, id), ...Object.values(pl(h.state, id)?.zones.equipment ?? {}).filter(Boolean)] as CardId[]
        if (cards.length < count || !count) return
        askCards(h, MAJUN_QIAOSI, id, id, cards, `【巧思】：弃置${count}张牌`, count, count, { count }, false, 'payment-discard')
      } else if (response.payload.optionId === 'give') {
        const targets = others(h.state, id).map(player => player.id)
        if (targets.length) askTargets(h, MAJUN_QIAOSI, id, id, targets, `【巧思】：选择获得${count}张牌的角色`, { count }, false, 1, 1, 'payment-target')
      }
      return
    }
    if (request.step === 'payment-discard') {
      discard(h, id, response.payload.cardIds as CardId[], MAJUN_QIAOSI)
      return
    }
    if (request.step === 'payment-target') {
      const targetId = response.payload.targetIds?.[0] as PlayerId | undefined
      if (!targetId || !others(h.state, id).some(player => player.id === targetId)) return
      const cards = hand(h.state, id)
      if (cards.length < Number(request.data.count)) return
      askCards(h, MAJUN_QIAOSI, id, id, cards, `【巧思】：交给${pl(h.state, targetId)?.name ?? '目标角色'}等量手牌`, Number(request.data.count), Number(request.data.count), { targetId }, false, 'payment-give')
      return
    }
    if (request.step === 'payment-give') {
      const targetId = request.data.targetId as PlayerId
      if (pl(h.state, targetId)?.alive) give(h, id, targetId, response.payload.cardIds as CardId[], MAJUN_QIAOSI)
    }
  },
})

function startJingtuTargetRequest(h: SkillHost, ownerId: PlayerId, mode: 'black'|'red', stage: number) {
  askTargets(h, ZERONG_JINGTU, ownerId, ownerId, alive(h.state).map(p => p.id),
    mode === 'black' ? '【净土】：选择一名角色，受到X点伤害' : '【净土】：选择一名角色，加Y点体力上限并回复Y点体力',
    { mode, stage }, false, 1, 1, 'net-target')
}
function finishJingtu(h: SkillHost, ownerId: PlayerId, colors: Array<'red'|'black'>) {
  const owner = pl(h.state, ownerId)
  if (!owner) return
  owner.permanentlyLostSkills ??= []
  if (!owner.permanentlyLostSkills.includes(ZERONG_FUTU)) owner.permanentlyLostSkills.push(ZERONG_FUTU)
  owner.grantedSkills ??= []
  if (!owner.grantedSkills.includes(ZERONG_FOZONG)) owner.grantedSkills.push(ZERONG_FOZONG)
  put(h, `${ZERONG_FOZONG}:${ownerId}:colors`, [...new Set(colors)])
  h.dispatch('SkillActivated', { skillId: ZERONG_JINGTU, skillName: '净土', playerId: ownerId, result: 'transformed', lostSkillId: ZERONG_FUTU, gainedSkillId: ZERONG_FOZONG }, { sourceId: ownerId })
}
registerSkillRuntime({
  id: ZERONG_JINGTU,
  limited: true,
  activeActions(s, id) {
    const p = pl(s, id)
    const ye = p?.characterPiles?.[ZERONG_PILE] ?? []
    const black = ye.filter(cardId => s.cards[cardId]?.color === 'black').length
    const red = ye.filter(cardId => s.cards[cardId]?.color === 'red').length
    return s.phase === 'play' && s.currentPlayerId === id && !p?.usedLimitedSkills.includes(ZERONG_JINGTU) && (black > 0 || red > 0)
      ? [{ id: ZERONG_JINGTU, label: '净土：清算“业”并改变技能' }] : []
  },
  invokeActive(h, id) {
    const ye = pile(h, id, ZERONG_PILE)
    const black = ye.filter(cardId => h.state.cards[cardId]?.color === 'black').length
    const red = ye.filter(cardId => h.state.cards[cardId]?.color === 'red').length
    const options = [
      ...(black ? [{ id: 'black', label: `获得${black}张黑色“业”，对一名角色造成${black}点伤害` }] : []),
      ...(red ? [{ id: 'red', label: `获得${red}张红色“业”，令一名角色加${red}点体力上限并回复${red}点体力` }] : []),
      ...(black > 1 && red > 1 && black === red ? [{ id: 'backwater', label: '背水：依次执行黑色与红色两项' }] : []),
    ]
    if (!options.length) return
    askOption(h, ZERONG_JINGTU, id, id, 'select', '【净土】：选择一项', options, { black, red }, false)
  },
  resume(h, id, r, res) {
    if (r.step === 'select') {
      const choice = res.payload.optionId
      const owner = pl(h.state, id)
      if (!owner || owner.usedLimitedSkills.includes(ZERONG_JINGTU)) return
      const ye = pile(h, id, ZERONG_PILE)
      const black = ye.filter(cardId => h.state.cards[cardId]?.color === 'black').length
      const red = ye.filter(cardId => h.state.cards[cardId]?.color === 'red').length
      const allowed = choice === 'black' ? black > 0 : choice === 'red' ? red > 0 : choice === 'backwater' && black > 1 && red > 1 && black === red
      if (!allowed) return
      owner.usedLimitedSkills.push(ZERONG_JINGTU)
      const modes = choice === 'backwater' ? ['black', 'red'] : [choice]
      startJingtuTargetRequest(h, id, modes[0], 0)
      put(h, `${ZERONG_JINGTU}:${id}:modes`, modes)
      return
    }
    if (r.step !== 'net-target') return
    const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
    const mode = r.data.mode as 'black'|'red'
    if (!targetId || !pl(h.state, targetId)?.alive) return
    const ye = pile(h, id, ZERONG_PILE)
    const colored = ye.filter(cardId => h.state.cards[cardId]?.color === mode)
    const n = colored.length
    if (!n) return
    const won = gainFromPile(h, id, ZERONG_PILE, colored)
    const colors = won.map(cardId => h.state.cards[cardId]?.color).filter(Boolean) as Array<'red'|'black'>
    const accumulatedColors = [...new Set([...(skillState(st(h), `${ZERONG_JINGTU}:${id}:colors`) ?? []), ...colors])]
    put(h, `${ZERONG_JINGTU}:${id}:colors`, accumulatedColors)
    if (mode === 'black') resolveDamage(h as never, { sourceId: id, targetId, amount: n, nature: 'normal', cardName: ZERONG_JINGTU })
    else { gainMaxHp(h as never, targetId, n, ZERONG_JINGTU); recover(h, targetId, n, id) }
    const modes = skillState(st(h), `${ZERONG_JINGTU}:${id}:modes`) ?? [mode]
    const nextMode = modes[Number(r.data.stage) + 1]
    if (nextMode && pl(h.state, id)?.alive) { startJingtuTargetRequest(h, id, nextMode, Number(r.data.stage) + 1); return }
    finishJingtu(h, id, accumulatedColors)
  },
})

registerSkillRuntime({
  id: ZERONG_JIEBIAN,
  triggers: [
    { event: 'PhaseStart', handle(h, _id, c) {
      const p = c.event.payload as any
      if (p.phase === 'play') put(h, `${ZERONG_JIEBIAN}:phase`, { playerId: p.playerId, turn: h.state.turnNumber, damaged: false })
    } },
    { event: 'DamageSettled', handle(h, _id, c) {
      const record = skillState(st(h), `${ZERONG_JIEBIAN}:phase`)
      if (record?.turn === h.state.turnNumber && h.state.phase === 'play' && Number((c.event.payload as any).finalAmount ?? 0) > 0) record.damaged = true
    } },
    { event: 'PhaseEnd', handle(h, id, c) {
      const p = c.event.payload as any
      const record = skillState(st(h), `${ZERONG_JIEBIAN}:phase`)
      if (p.phase !== 'play' || !record || record.playerId !== p.playerId || record.turn !== h.state.turnNumber || record.damaged || !pl(h.state, id)?.alive) return
      const candidates = alive(h.state).filter(x => x.id !== id && x.zones.hand.length > 0 && !prohibitsBeingPindianTargetOf(h.state, x.id))
      const current = p.playerId as PlayerId
      const minimumHp = Math.min(...alive(h.state).map(x => x.hp))
      const allowed = candidates.filter(x => x.id === current || x.hp === minimumHp).map(x => x.id)
      if (!allowed.length || (!hand(h.state, id).length && !pile(h, id, ZERONG_PILE).length)) return
      askTargets(h, ZERONG_JIEBIAN, id, id, allowed, '【劫辨】：选择当前回合角色或体力值最低的角色拼点', { initiatorTurn: h.state.turnNumber }, true)
    } },
  ],
  resume(h, id, r, res) {
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      const eligible = alive(h.state).filter(x => x.id !== id && x.zones.hand.length && (x.id === targetId) && !prohibitsBeingPindianTargetOf(h.state, x.id))
      const choices = [...hand(h.state, id), ...pile(h, id, ZERONG_PILE)]
      if (!targetId || !eligible.length || !choices.length) return
      askCards(h, ZERONG_JIEBIAN, id, id, choices, '【劫辨】：选择一张手牌或“业”用于拼点', 1, 1, { targetId }, false, 'pindian-card')
      return
    }
    if (r.step === 'pindian-card') {
      const targetId = r.data.targetId as PlayerId
      const cardId = res.payload.cardIds?.[0] as CardId | undefined
      const fromYe = Boolean(cardId && pile(h, id, ZERONG_PILE).includes(cardId))
      if (!cardId || (!hand(h.state, id).includes(cardId) && !fromYe) || !pl(h.state, targetId)?.alive || !hand(h.state, targetId).length) return
      startPindian(h as never, { id: `${ZERONG_JIEBIAN}:${h.state.seq}`, initiatorId: id, opponentId: targetId, reason: ZERONG_JIEBIAN,
        continuationTag: JIEBIAN_TAG, initiatorForcedCardId: cardId, data: { ownerId: id, targetId, fromYe } })
      return
    }
    if (r.step === 'win-effect') {
      const targetId = r.data.targetId as PlayerId
      if (!pl(h.state, targetId)?.alive) return
      if (res.payload.optionId === 'damage') resolveDamage(h as never, { sourceId: id, targetId, amount: 1, nature: 'normal', cardName: ZERONG_JIEBIAN })
      else if (res.payload.optionId === 'recover') {
        recover(h, targetId, 1, id)
        drawCards(h.state, h.rng, targetId, 1, (n, data) => h.dispatch(n, data))
        const pickable = pickableCardsOf(h.state, targetId, { includeJudgingArea: true })
        const all = [...pickable.cardIds, ...pickable.hiddenCardSlots]
        if (all.length) askCards(h, ZERONG_JIEBIAN, id, id, all, '【劫辨】：获得其两张牌', 1, Math.min(2, all.length), { targetId }, false, 'take-cards')
      }
      return
    }
    if (r.step === 'take-cards') {
      const targetId = r.data.targetId as PlayerId
      for (const picked of (res.payload.cardIds ?? []).slice(0, 2)) {
        const cardId = resolvePickedCard(h.state, targetId, picked)
        if (cardId && locateOwnedCard(h.state, targetId, cardId)) give(h, targetId, id, [cardId], ZERONG_JIEBIAN)
      }
    }
  },
  startQueued(h, id, q) {
    if (q.step !== 'win-effect') return
    const targetId = q.data.targetId as PlayerId
    if (!pl(h.state, id)?.alive || !pl(h.state, targetId)?.alive) return
    askOption(h, ZERONG_JIEBIAN, id, id, 'win-effect', '【劫辨】：选择一项', [{ id: 'damage', label: '对其造成1点伤害' }, { id: 'recover', label: '令其回复1点体力并摸一张牌，然后获得其两张牌' }], { targetId }, false)
  },
})

registerPindianContinuation(JIEBIAN_TAG, (rawHost, result) => {
  if (result.outcome !== 'initiator-win') return
  const h = rawHost as unknown as SkillHost
  const ownerId = result.data.ownerId as PlayerId
  const targetId = result.data.targetId as PlayerId
  if (!pl(h.state, ownerId)?.alive || !pl(h.state, targetId)?.alive) return
  h.queueSkill({ skillId: ZERONG_JIEBIAN, ownerId, step: 'win-effect', data: { targetId } })
})

registerSkillRuntime({
  id: MIFUREN_XUANCUN,
  triggers: [{ event: 'TurnEnd', handle(h, id, c) {
    const current = (c.event.payload as any).playerId as PlayerId | undefined
    const owner = pl(h.state, id)
    if (!current || current === id || !owner?.alive || hand(h.state, id).length >= owner.hp) return
    askOption(h, MIFUREN_XUANCUN, id, id, 'invoke', '【悬存】：是否令当前角色摸牌？', [{ id: 'yes', label: `令其摸${Math.min(2, owner.hp - hand(h.state, id).length)}张牌` }, { id: 'no', label: '不发动' }], { targetId: current }, true)
  } }],
  resume(h, id, r, res) {
    if (r.step !== 'invoke' || res.payload.optionId !== 'yes') return
    const targetId = r.data.targetId as PlayerId
    const owner = pl(h.state, id)
    const target = pl(h.state, targetId)
    if (!owner?.alive || !target?.alive || targetId === id || hand(h.state, id).length >= owner.hp) return
    drawCards(h.state, h.rng, targetId, Math.min(2, owner.hp - hand(h.state, id).length), (n, data) => h.dispatch(n, data))
  },
})

// 李儒【绝策】记录本回合实际失去过牌的角色；【焚城】逐座位挂起，不能批量自动扣牌。
registerSkillRuntime({
  id: LIRU_JUECE,
  triggers: [
    { event: 'LoseCard', handle(h, _id, c) {
      const p = c.event.payload as any
      if (!p.playerId || !Array.isArray(p.cardIds) || !p.cardIds.length) return
      const ledger = skillState(st(h), LIRU_DAMAGE_LEDGER) ?? { turn: h.state.turnNumber, ids: [] }
      if (ledger.turn !== h.state.turnNumber) { ledger.turn = h.state.turnNumber; ledger.ids = [] }
      if (!ledger.ids.includes(p.playerId)) ledger.ids.push(p.playerId)
      put(h, LIRU_DAMAGE_LEDGER, ledger)
    } },
    { event: 'PhaseStart', handle(h, id, c) {
      const p = c.event.payload as any
      if (p.phase !== 'finish' || p.playerId !== id) return
      const ledger = skillState(st(h), LIRU_DAMAGE_LEDGER)
      const candidates = others(h.state, id).filter(x => ledger?.turn === h.state.turnNumber && ledger.ids.includes(x.id)).map(x => x.id)
      if (candidates.length) askTargets(h, LIRU_JUECE, id, id, candidates, '【绝策】：选择本回合失去过牌的一名角色', {}, true)
    } },
  ],
  resume(h, id, r, res) {
    if (r.step !== 'target') return
    const targetId = res.payload.targetIds?.[0]
    if (targetId && skillState(st(h), LIRU_DAMAGE_LEDGER)?.ids?.includes(targetId) && pl(h.state, targetId)?.alive) {
      deal(h, id, targetId, 1, 'normal', LIRU_JUECE)
    }
  },
})

registerSkillRuntime({
  id: LIRU_MIEJI,
  activeActions(s, id) {
    const blackTricks = hand(s, id).filter(cardId => s.cards[cardId]?.category === 'trick' && effectiveCardColor(s, id, cardId) === 'black')
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, LIRU_MIEJI) && blackTricks.length && others(s, id).some(p => [...p.zones.hand, ...Object.values(p.zones.equipment).filter(Boolean)].length)
      ? [{ id: LIRU_MIEJI, label: '灭计：展示黑色锦囊' }] : []
  },
  invokeActive(h, id) {
    const candidates = hand(h.state, id).filter(cardId => h.state.cards[cardId]?.category === 'trick' && effectiveCardColor(h.state, id, cardId) === 'black')
    askCards(h, LIRU_MIEJI, id, id, candidates, '【灭计】：展示并置于牌堆顶一张黑色锦囊牌', 1, 1)
  },
  resume(h, id, r, res) {
    if (r.step === 'cards') {
      const cardId = res.payload.cardIds?.[0]
      if (!cardId || !hand(h.state, id).includes(cardId) || h.state.cards[cardId]?.category !== 'trick' || effectiveCardColor(h.state, id, cardId) !== 'black') return
      moveCard(h.state, cardId, { kind: 'hand', playerId: id }, { kind: 'drawPile' })
      markUsedThisPhase(h.state, id, LIRU_MIEJI)
      const targets = others(h.state, id).filter(p => [...p.zones.hand, ...Object.values(p.zones.equipment).filter(Boolean)].length).map(p => p.id)
      if (targets.length) askTargets(h, LIRU_MIEJI, id, id, targets, '【灭计】：选择一名有牌的其他角色', { cardId })
      return
    }
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0]
      if (!targetId || !pl(h.state, targetId)?.alive) return
      const targetHand = hand(h.state, targetId)
      const tricks = targetHand.filter(cardId => h.state.cards[cardId]?.category === 'trick')
      const targetOwned = [...targetHand, ...Object.values(pl(h.state, targetId)?.zones.equipment ?? {}).filter(Boolean)] as CardId[]
      const nonTricks = targetOwned.filter(cardId => h.state.cards[cardId]?.category !== 'trick')
      const options = [ ...(tricks.length ? [{ id: 'give', label: '交给李儒一张锦囊牌' }] : []), ...(nonTricks.length ? [{ id: 'discard', label: `弃置${Math.min(2, nonTricks.length)}张非锦囊牌` }] : []) ]
      askOption(h, LIRU_MIEJI, id, targetId, 'choice', '【灭计】：选择一项', options, { targetId, modeOptions: options }, false)
      return
    }
    if (r.step === 'choice') {
      const targetId = r.data.targetId as PlayerId
      const mode = res.payload.optionId
      const targetOwned = [...hand(h.state, targetId), ...Object.values(pl(h.state, targetId)?.zones.equipment ?? {}).filter(Boolean)] as CardId[]
      const candidates = targetOwned.filter(cardId => mode === 'give' ? h.state.cards[cardId]?.category === 'trick' : h.state.cards[cardId]?.category !== 'trick')
      if (!candidates.length) return
      askCards(h, LIRU_MIEJI, id, targetId, candidates, mode === 'give' ? '【灭计】：交给李儒一张锦囊牌' : '【灭计】：弃置非锦囊牌', mode === 'give' ? 1 : Math.min(2, candidates.length), mode === 'give' ? 1 : Math.min(2, candidates.length), { targetId, mode }, false, 'resolve-cards')
      return
    }
    if (r.step === 'resolve-cards') {
      const targetId = r.data.targetId as PlayerId
      const targetOwned = [...hand(h.state, targetId), ...Object.values(pl(h.state, targetId)?.zones.equipment ?? {}).filter(Boolean)] as CardId[]
      const ids = (res.payload.cardIds ?? []).filter(cardId => targetOwned.includes(cardId))
      if (r.data.mode === 'give') give(h, targetId, id, ids.slice(0, 1), LIRU_MIEJI)
      else discard(h, targetId, ids.slice(0, 2), LIRU_MIEJI)
    }
  },
})

registerSkillRuntime({
  id: LIRU_FENCHENG,
  limited: true,
  activeActions(s, id) { return s.phase === 'play' && s.currentPlayerId === id && !pl(s, id)?.usedLimitedSkills.includes(LIRU_FENCHENG) && others(s, id).length ? [{ id: LIRU_FENCHENG, label: '焚城：令所有其他角色逐一弃牌或受火焰伤害' }] : [] },
  invokeActive(h, id) {
    const owner = pl(h.state, id)
    if (!owner || owner.usedLimitedSkills.includes(LIRU_FENCHENG)) return
    const players = nextPlayersAfter(h.state, id).map(p => p.id)
    owner.usedLimitedSkills.push(LIRU_FENCHENG)
    put(h, `${LIRU_LOCKED}:${id}`, { targets: players, index: 0, previousDiscard: 0, turn: h.state.turnNumber })
    askFenchengNext(h, id)
  },
  resume(h, id, r, res) {
    const state = skillState(st(h), `${LIRU_LOCKED}:${id}`)
    if (!state) return
    if (r.step === 'fencheng-mode') {
      const targetId = state.targets[state.index]
      if (res.payload.optionId === 'damage') {
        deal(h, id, targetId, 2, 'fire', LIRU_FENCHENG)
        state.previousDiscard = 0; state.index += 1; askFenchengNext(h, id); return
      }
      const target = pl(h.state, targetId)
      if (!target?.alive) { state.previousDiscard = 0; state.index += 1; askFenchengNext(h, id); return }
      const cards = [...hand(h.state, targetId), ...Object.values(target.zones.equipment).filter(Boolean)] as CardId[]
      const required = state.previousDiscard + 1
      if (cards.length < required) { state.previousDiscard = 0; state.index += 1; askFenchengNext(h, id); return }
      askCards(h, LIRU_FENCHENG, id, targetId, cards, `【焚城】：弃置至少${required}张牌`, required, cards.length, { targetId }, false, 'fencheng-cards')
      return
    }
    if (r.step === 'fencheng-cards') {
      const targetId = state.targets[state.index]
      const target = pl(h.state, targetId)
      const available = [...hand(h.state, targetId), ...Object.values(target?.zones.equipment ?? {}).filter(Boolean)]
      const selected = (res.payload.cardIds ?? []).filter(cardId => available.includes(cardId))
      const required = state.previousDiscard + 1
      if (selected.length < required) {
        deal(h, id, targetId, 2, 'fire', LIRU_FENCHENG)
        state.previousDiscard = 0
      } else { state.previousDiscard = discard(h, targetId, selected, LIRU_FENCHENG).length }
      state.index += 1; askFenchengNext(h, id)
    }
  },
})

// 界潘璋马忠：死亡/伤害后的武器选择与逐目标【杀】选项。
registerSkillRuntime({
  id: PANZHANG_DUODAO,
  triggers: [{ event: 'DamageSettled', handle(h, id, c) {
    if (c.event.targetId !== id || Number((c.event.payload as any).finalAmount ?? 0) <= 0) return
    const sourceId = c.event.sourceId
    const weapons = sourceId ? weaponCardsOf(h.state, sourceId) : []
    if (!sourceId || !pl(h.state, sourceId)?.alive || !weapons.length) return
    h.queueSkill({ skillId: PANZHANG_DUODAO, ownerId: id, step: 'take', data: { sourceId } })
  } }],
  startQueued(h, id, q) {
    if (q.step !== 'take') return
    const sourceId = q.data.sourceId as PlayerId
    const weapons = weaponCardsOf(h.state, sourceId)
    if (!pl(h.state, sourceId)?.alive || !pl(h.state, id)?.alive || !weapons.length) return
    askCards(h, PANZHANG_DUODAO, id, id, weapons, '【夺刀】：获得伤害来源装备区里的一张武器牌', 1, 1, { sourceId })
  },
  resume(h, id, r, res) {
    if (r.step !== 'cards') return
    const sourceId = r.data.sourceId as PlayerId
    const cardId = res.payload.cardIds?.[0]
    if (cardId && weaponCardsOf(h.state, sourceId).includes(cardId) && pl(h.state, sourceId)?.alive) give(h, sourceId, id, [cardId], PANZHANG_DUODAO)
  },
})

registerSkillRuntime({
  id: PANZHANG_ANJIAN,
  interceptSourceTargetEach(h, id, context) {
    if (context.cardName !== '杀' || !h.state.cardResolution || h.state.cardResolution.kind !== 'slash') return false
    const target = pl(h.state, context.targetId)
    const targetRange = target ? getAttackRange(h.state, context.targetId) : 1
    if (!target?.alive || getDistance(h.state, context.targetId, id) <= targetRange) return false
    const key = `${PANZHANG_ANJIAN}:${context.cardId}:${context.targetId}`
    if (skillState(st(h), key)) return false
    h.askSkill({ skillId: PANZHANG_ANJIAN, ownerId: id, step: 'mode', data: { key, targetId: context.targetId }, build: requestId => ({
      id: requestId, kind: 'choose-option', playerId: id, prompt: '【暗箭】：选择一项', timeoutMs: 20_000, optional: false,
      options: [{ id: 'no-response', label: '此【杀】不可响应' }, { id: 'damage', label: '此【杀】伤害+1' }],
    }) })
    return true
  },
  resume(h, id, r, res) {
    if (r.step !== 'mode') return
    const targetId = r.data.targetId as PlayerId
    const key = r.data.key as string
    if (res.payload.optionId === 'no-response') put(h, key, { mode: 'no-response', turn: h.state.turnNumber })
    else put(h, key, { mode: 'damage', turn: h.state.turnNumber })
    h.resumeCardTarget()
  },
  slashUndodgeable(s, id, targetId, cardId) {
    const effect = cardId ? skillState(st({ state: s } as SkillHost), `${PANZHANG_ANJIAN}:${cardId}:${targetId}`) : null
    return effect?.mode === 'no-response' && effect.turn === s.turnNumber
  },
  outgoingDamage(s, id, c) {
    const effect = c.cardId ? skillState(st({ state: s } as SkillHost), `${PANZHANG_ANJIAN}:${c.cardId}:${c.targetId}`) : null
    return effect?.mode === 'damage' && effect.turn === s.turnNumber ? { amount: c.amount + 1 } : null
  },
})

// 李丰【屯储】使用统一阶段入口挂起选择；额外摸两张完成后再继续正常摸牌阶段。
registerSkillRuntime({
  id: LIFENG_TUNCHU,
  prohibitsCardUse(s, id, context) { return context.cardName === '杀' && pile({ state: s } as SkillHost, id, 'grain').length > 0 },
  prohibitsOwnResponse(s, id, cardName) { return cardName === '杀' && pile({ state: s } as SkillHost, id, 'grain').length > 0 },
  triggers: [{ event: 'PhaseStart', handle(h, id, c) {
    const p = c.event.payload as any
    if (p.playerId !== id || p.phase !== 'draw' || pile(h, id, 'grain').length || !pl(h.state, id)?.alive) return
    h.askSkill({ skillId: LIFENG_TUNCHU, ownerId: id, step: 'invoke', data: {}, build: requestId => ({
      id: requestId, kind: 'choose-option', playerId: id, prompt: '【屯储】：是否额外摸两张牌，然后可将任意张手牌置为“粮”？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '额外摸两张牌并置粮' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(h, id, r, res) {
    if (r.step === 'invoke') {
      if (res.payload.optionId !== 'yes' || !pl(h.state, id)?.alive || pile(h, id, 'grain').length) return
      drawCards(h.state, h.rng, id, 2, (n, data) => h.dispatch(n, data))
      if (hand(h.state, id).length) askCards(h, LIFENG_TUNCHU, id, id, hand(h.state, id), '【屯储】：可将任意张手牌置为“粮”', 0, hand(h.state, id).length, {}, true, 'place-grain')
      return
    }
    if (r.step === 'place-grain') {
      const selected = (res.payload.cardIds ?? []).filter(cardId => hand(h.state, id).includes(cardId))
      const targetPile = pile(h, id, 'grain')
      for (const cardId of selected) {
        moveCard(h.state, cardId, { kind: 'hand', playerId: id }, { kind: 'characterPile', playerId: id, pile: 'grain' }); targetPile.push(cardId)
      }
      if (selected.length) h.dispatch('CardMove', { playerId: id, cardIds: selected, destinationZone: 'characterPile', pile: 'grain', reason: LIFENG_TUNCHU }, { sourceId: id, cardIds: selected })
    }
  },
})

registerSkillRuntime({
  id: LIFENG_SHULIANG,
  triggers: [{ event: 'PhaseStart', handle(h, id, c) {
    const p = c.event.payload as any
    if (p.phase !== 'finish' || hand(h.state, p.playerId).length >= (pl(h.state, p.playerId)?.hp ?? 0)) return
    const grains = pile(h, id, 'grain')
    if (!grains.length || !pl(h.state, id)?.alive) return
    askOption(h, LIFENG_SHULIANG, id, id, 'target', '【输粮】：是否交出一张“粮”，令该角色摸两张牌？', [{ id: 'yes', label: '交出一张“粮”' }, { id: 'no', label: '不发动' }], { targetId: p.playerId })
  } }],
  resume(h, id, r, res) {
    if (r.step === 'target') {
      if (res.payload.optionId !== 'yes') return
      const targetId = r.data.targetId as PlayerId
      const grains = pile(h, id, 'grain')
      if (!pl(h.state, targetId)?.alive || hand(h.state, targetId).length >= (pl(h.state, targetId)?.hp ?? 0) || !grains.length) return
      askCards(h, LIFENG_SHULIANG, id, id, grains, '【输粮】：选择一张“粮”置入弃牌堆', 1, 1, { targetId }, false, 'grain-card')
      return
    }
    if (r.step === 'grain-card') {
      const targetId = r.data.targetId as PlayerId
      const cardId = res.payload.cardIds?.[0]
      const grains = pile(h, id, 'grain')
      if (!cardId || !grains.includes(cardId) || !pl(h.state, targetId)?.alive) return
      moveCard(h.state, cardId, { kind: 'characterPile', playerId: id, pile: 'grain' }, { kind: 'discardPile' })
      h.dispatch('LoseCard', { playerId: id, cardIds: [cardId], reason: LIFENG_SHULIANG }, { sourceId: id, cardIds: [cardId] })
      drawCards(h.state, h.rng, targetId, 2, (n, data) => h.dispatch(n, data))
    }
  },
})

// 严白虎：伤害后按区域各取一张，并用源目标通用拦截规则封锁后续出牌目标。
registerSkillRuntime({
  id: YANBAIHU_ZHIDAO,
  triggers: [{ event: 'DamageSettled', handle(h, id, c) {
    const targetId = c.event.targetId
    const damage = c.event.payload as any
    if (Number(damage.finalAmount ?? 0) <= 0 || c.event.sourceId !== id || !targetId || targetId === id || !pl(h.state, targetId)?.alive || h.state.currentPlayerId !== id || h.state.phase !== 'play') return
    const rec = skillState(st(h), `${YANBAIHU_ZHIDAO}:${id}`) ?? { turn: h.state.turnNumber, hit: false }
    if (rec.turn === h.state.turnNumber && rec.hit) return
    put(h, `${YANBAIHU_ZHIDAO}:${id}`, { turn: h.state.turnNumber, hit: true, targetId, stepIndex: 0 })
    h.queueSkill({ skillId: YANBAIHU_ZHIDAO, ownerId: id, step: 'take-zones', data: { targetId, stepIndex: 0 } })
  } }],
  startQueued(h, id, q) {
    if (q.step !== 'take-zones') return
    const targetId = q.data.targetId as PlayerId
    const stepIndex = Number(q.data.stepIndex ?? 0)
    const target = pl(h.state, targetId)
    if (!target?.alive || !pl(h.state, id)?.alive || stepIndex >= 3) return
    const area = ['hand', 'equipment', 'judgingArea'][stepIndex]
    const pickable = pickableCardsOf(h.state, targetId, { includeJudgingArea: true })
    const candidates = area === 'hand' ? pickable.hiddenCardSlots : area === 'equipment'
      ? Object.values(target.zones.equipment).filter(Boolean)
      : target.zones.judgingArea
    if (!candidates.length) { h.queueSkill({ skillId: YANBAIHU_ZHIDAO, ownerId: id, step: 'take-zones', data: { targetId, stepIndex: stepIndex + 1 } }); return }
    h.askSkill({ skillId: YANBAIHU_ZHIDAO, ownerId: id, step: 'take-zone-card', data: { targetId, area, stepIndex }, build: requestId => ({
      id: requestId, kind: 'choose-cards', playerId: id, prompt: `【雉盗】：选择其${area === 'hand' ? '手牌区' : area === 'equipment' ? '装备区' : '判定区'}一张牌获得`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: area === 'hand' ? [] : candidates, hiddenCardSlots: area === 'hand' ? candidates : [], min: 1, max: 1,
    }) })
  },
  resume(h, id, r, res) {
    if (r.step !== 'take-zone-card') return
    const targetId = r.data.targetId as PlayerId
    const area = r.data.area as string
    const stepIndex = Number(r.data.stepIndex)
    const picked = res.payload.cardIds?.[0]
    const cardId = picked && (area === 'hand' ? resolvePickedCard(h.state, targetId, picked) : picked)
    const target = pl(h.state, targetId)
    if (cardId && target?.alive) {
      const from = locateOwnedCard(h.state, targetId, cardId)
      if (from && (area !== 'equipment' || from.kind === 'equipment') && (area !== 'judgingArea' || from.kind === 'judgingArea')) give(h, targetId, id, [cardId], YANBAIHU_ZHIDAO)
    }
    if (stepIndex < 2 && target?.alive) h.queueSkill({ skillId: YANBAIHU_ZHIDAO, ownerId: id, step: 'take-zones', data: { targetId, stepIndex: stepIndex + 1 } })
  },
  prohibitsSourceTarget(s, id, targetId) {
    const effect = skillState(st({ state: s } as SkillHost), `${YANBAIHU_ZHIDAO}:${id}`)
    return effect?.turn === s.turnNumber && effect.hit === true && targetId !== id
  },
})

registerSkillRuntime({
  id: YANBAIHU_JILI,
  additionalTargetsOnUse(s, id, sourceId, cardId, cardName, currentTargets) {
    if (sourceId === id || !pl(s, id)?.alive || !['basic', 'trick'].includes(s.cards[cardId]?.category ?? '') || effectiveCardColor(s, sourceId, cardId) !== 'red') return []
    if (new Set(['乐不思蜀', '兵粮寸断', '闪电']).has(cardName)) return []
    return currentTargets.some(targetId => getDistance(s, id, targetId) === 1) ? [id] : []
  },
})

registerSkillRuntime({
  id: LAIMIN_LAISHOU,
  triggers: [
    { event: 'DamageInflicted', priority: 100, handle(h, id, c) {
      const target = pl(h.state, id)
      const amount = Number((c.event.payload as any).amount ?? 0)
      if (c.event.targetId !== id || !target?.alive || target.maxHp >= 9 || target.hp - amount > 0) return
      c.cancel()
      gainMaxHp(h as never, id, amount, LAIMIN_LAISHOU)
      h.dispatch('SkillActivated', { skillId: LAIMIN_LAISHOU, skillName: '来寿', playerId: id, prevented: amount }, { sourceId: id, targetId: id })
    } },
    { event: 'PhaseStart', handle(h, id, c) {
      const p = c.event.payload as any
      if (p.phase === 'prepare' && p.playerId === id && (pl(h.state, id)?.maxHp ?? 0) >= 9) {
        killPlayer(h as never, id, id, LAIMIN_LAISHOU)
      }
    } },
  ],
})

registerSkillRuntime({
  id: LAIMIN_LUANQUN,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && hand(s, id).length > 0 && !usedThisPhase(s, id, LAIMIN_LUANQUN)
      ? [{ id: LAIMIN_LUANQUN, label: '乱群：同时展示全场一张手牌' }] : []
  },
  invokeActive(h, id) {
    if (!hand(h.state, id).length || usedThisPhase(h.state, id, LAIMIN_LUANQUN)) return
    markUsedThisPhase(h.state, id, LAIMIN_LUANQUN)
    startGroupCardDecision(h as never, {
      id: `${LAIMIN_LUANQUN}:${h.state.seq}`, tag: LUANQUN_TAG, skillId: LAIMIN_LUANQUN,
      playerIds: alive(h.state).map(p => p.id), prompt: '【乱群】：同时秘密选择一张手牌展示',
      cardIdsFor: playerId => hand(h.state, playerId), minFor: (_playerId, cards) => cards.length ? 1 : 0,
      max: 1, timeoutMs: 20_000, data: { ownerId: id },
    })
  },
  resume(h, ownerId, r, res) {
    if (r.step !== 'cards') return
    const holders = r.data.holders as Record<CardId, PlayerId>
    for (const cardId of (res.payload.cardIds ?? []).slice(0, 4)) {
      const fromId = holders[cardId]
      if (fromId && hand(h.state, fromId).includes(cardId)) give(h, fromId, ownerId, [cardId], LAIMIN_LUANQUN)
    }
  },
  globalProhibitsSourceTarget(s, id, sourceId, targetId, cardName) {
    if (cardName !== '杀' || sourceId === id) return false
    const mark = pl(s, sourceId)?.marks?.[LAIMIN_MARK]
    if (!mark) return false
    const priorSlashes = s.cardUseHistory.filter(entry => entry.sourceId === sourceId && entry.turnNumber === s.turnNumber && entry.cardName === '杀').length
    return priorSlashes === 0 && targetId !== id
  },
  prohibitsOwnResponse(s, id, cardName) {
    if (cardName !== '闪' || s.cardResolution?.kind !== 'slash') return false
    const sourceId = s.cardResolution.sourceId
    return Boolean(pl(s, sourceId)?.marks?.[LAIMIN_MARK])
      && s.cardUseHistory.filter(entry => entry.sourceId === sourceId && entry.turnNumber === s.turnNumber && entry.cardName === '杀').length === 1
  },
  triggers: [{ event: 'TurnEnd', handle(h, _id, c) {
    const p = c.event.payload as any
    const owner = p.playerId as PlayerId | undefined
    if (owner && pl(h.state, owner)?.marks?.[LAIMIN_MARK]) delete pl(h.state, owner).marks[LAIMIN_MARK]
  } }],
})

registerSkillRuntime({
  id: PANGDEGONG_YINSHI,
  offerPhaseSkip(h, id, phase) {
    if (pl(h.state, id)?.alive && ['prepare', 'judge', 'finish'].includes(phase)) skipPhase(h.state, phase)
    return false
  },
  prohibitsTarget(_s, id, _sourceId, cardName) {
    return ['乐不思蜀', '兵粮寸断', '闪电'].includes(cardName)
  },
})

function hasLivingPingcaiFriend(h: SkillHost, characterId: string): boolean {
  return alive(h.state).some(player => player.characterId === characterId)
}

function equipmentLocation(s: SanguoshaState, ownerId: PlayerId, cardId: CardId): { playerId: PlayerId; slot: string } | null {
  for (const player of s.players) {
    for (const [slot, equippedId] of Object.entries(player.zones.equipment)) {
      if (equippedId === cardId) return { playerId: player.id, slot }
    }
  }
  return null
}

function legalPingcaiEquipmentTargets(h: SkillHost, sourceId: PlayerId, cardId: CardId): PlayerId[] {
  const equipmentSlot = h.state.cards[cardId]?.equipmentSlot
  if (!equipmentSlot) return []
  return others(h.state, sourceId).filter(target => {
    const slots = equipmentSlotsOf(h.state, target.id)
    const compatible = equipmentSlot === 'weapon'
      ? slots.filter(slot => slot === 'weapon' || slot === 'weapon2')
      : slots.filter(slot => slot === equipmentSlot)
    return compatible.length > 0
  }).map(target => target.id)
}

function pingcaiDestinationSlot(h: SkillHost, targetId: PlayerId, cardId: CardId): string | null {
  const equipmentSlot = h.state.cards[cardId]?.equipmentSlot
  if (!equipmentSlot) return null
  const compatible = equipmentSlotsOf(h.state, targetId).filter(slot => equipmentSlot === 'weapon'
    ? slot === 'weapon' || slot === 'weapon2'
    : slot === equipmentSlot)
  if (!compatible.length) return null
  const target = pl(h.state, targetId)
  return compatible.find(slot => !target?.zones.equipment[slot as keyof typeof target.zones.equipment]) ?? compatible[0]
}

function pingcaiEquipmentSources(h: SkillHost, ownerId: PlayerId): PlayerId[] {
  const canMoveAny = hasLivingPingcaiFriend(h, 'simahui')
  return alive(h.state).filter(source => source.zones.equipment
    && Object.entries(source.zones.equipment).some(([slot, cardId]) => {
      if (!cardId || source.id === ownerId && !others(h.state, ownerId).length) return false
      const card = h.state.cards[cardId]
      if (!card?.equipmentSlot || (!canMoveAny && card.equipmentSlot !== 'armor')) return false
      if (isSlotAbolished(h.state, source.id, slot as never)) return false
      return legalPingcaiEquipmentTargets(h, source.id, cardId).some(targetId => targetId !== source.id)
    })).map(source => source.id)
}

function askPingcaiScratch(h: SkillHost, ownerId: PlayerId, treasure: PingcaiTreasure): void {
  // 本项目将客户端未公开的擦拭结果建模为引擎 RNG 决定的二态抽签；UI 只负责呈现擦拭过程。
  const success = h.rng.nextInt(2) === 0
  h.askSkill({
    skillId: PANGDEGONG_PINGCAI, ownerId, step: 'scratch', data: { treasure, success },
    build: requestId => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【评才】：擦拭宝物上的灰尘', timeoutMs: 30_000, optional: false,
      options: [
        { id: 'scratch-complete', label: '擦拭完成' },
        { id: 'scratch-stop', label: '停止（未成功）' },
      ],
      interaction: { kind: 'pingcai-scratch', treasure, cellCount: PINGCAI_CELL_COUNT, success },
    }),
  })
}

function askPingcaiEffect(h: SkillHost, ownerId: PlayerId, treasure: PingcaiTreasure): void {
  const name = PINGCAI_TREASURES.find(item => item.id === treasure)?.name ?? treasure
  h.dispatch('SkillActivated', { skillId: PANGDEGONG_PINGCAI, skillName: '评才', playerId: ownerId, treasure, success: true }, { sourceId: ownerId })
  if (treasure === 'wolong') {
    const maximum = hasLivingPingcaiFriend(h, 'zhugeliang') ? 2 : 1
    askTargets(h, PANGDEGONG_PINGCAI, ownerId, ownerId, alive(h.state).map(player => player.id),
      `【评才·${name}】：对至多${maximum}名角色各造成1点火焰伤害`, { treasure }, false, 1, maximum, 'effect-targets')
  } else if (treasure === 'fengchu') {
    const maximum = hasLivingPingcaiFriend(h, 'pangtong') ? 4 : 3
    const candidates = alive(h.state).filter(player => !player.chained).map(player => player.id)
    askTargets(h, PANGDEGONG_PINGCAI, ownerId, ownerId, candidates,
      `【评才·${name}】：令至多${maximum}名角色进入连环状态`, { treasure }, false, 0, Math.min(maximum, candidates.length), 'effect-targets')
  } else if (treasure === 'shuijing') {
    const sourceIds = pingcaiEquipmentSources(h, ownerId)
    const options = sourceIds.map(sourceId => {
      const source = pl(h.state, sourceId)!
      const allowed = Object.entries(source.zones.equipment).filter(([slot, cardId]) => {
        if (!cardId || isSlotAbolished(h.state, sourceId, slot as never)) return false
        const card = h.state.cards[cardId]
        return Boolean(card?.equipmentSlot && (hasLivingPingcaiFriend(h, 'simahui') || card.equipmentSlot === 'armor')
          && legalPingcaiEquipmentTargets(h, sourceId, cardId).length)
      })
      return { id: sourceId, label: `${source.name ?? sourceId}（${allowed.length}件可移动）` }
    })
    if (options.length) askOption(h, PANGDEGONG_PINGCAI, ownerId, ownerId, 'equipment-source', `【评才·${name}】：选择装备来源角色`, options, { treasure }, false)
  } else {
    askTargets(h, PANGDEGONG_PINGCAI, ownerId, ownerId, alive(h.state).map(player => player.id),
      `【评才·${name}】：令一名角色摸一张牌并回复1点体力`, { treasure }, false, 1, 1, 'effect-targets')
  }
}

registerSkillRuntime({
  id: PANGDEGONG_PINGCAI,
  activeActions(s, id) {
    return s.phase === 'play' && s.currentPlayerId === id && !usedThisPhase(s, id, PANGDEGONG_PINGCAI)
      ? [{ id: PANGDEGONG_PINGCAI, label: '评才：选择并擦拭一件宝物' }] : []
  },
  invokeActive(h, id) {
    if (usedThisPhase(h.state, id, PANGDEGONG_PINGCAI)) return
    const sourceIds = pingcaiEquipmentSources(h, id)
    const options = PINGCAI_TREASURES.filter(treasure => treasure.id !== 'shuijing' || sourceIds.length > 0)
      .map(treasure => ({ id: treasure.id, label: treasure.name }))
    if (!options.length) return
    markUsedThisPhase(h.state, id, PANGDEGONG_PINGCAI)
    askOption(h, PANGDEGONG_PINGCAI, id, id, 'select-treasure', '【评才】：选择一件宝物并擦拭', options, {}, false)
  },
  resume(h, id, request, response) {
    if (request.step === 'select-treasure') {
      const treasure = String(response.payload.optionId ?? '') as PingcaiTreasure
      if (!PINGCAI_TREASURES.some(item => item.id === treasure)
        || (treasure === 'shuijing' && !pingcaiEquipmentSources(h, id).length)) return
      askPingcaiScratch(h, id, treasure)
      return
    }
    if (request.step === 'scratch') {
      const treasure = request.data.treasure as PingcaiTreasure
      const success = request.data.success === true
      const payload = response.payload as { optionId?: string; scratchedCells?: unknown }
      const cells = Array.isArray(payload.scratchedCells) ? payload.scratchedCells : []
      const complete = payload.optionId === 'scratch-complete'
        && cells.length === PINGCAI_CELL_COUNT
        && new Set(cells).size === PINGCAI_CELL_COUNT
        && cells.every((cell, index) => cell === index)
      if (!complete || !success) {
        h.dispatch('SkillActivated', { skillId: PANGDEGONG_PINGCAI, skillName: '评才', playerId: id, treasure, success: false }, { sourceId: id })
        return
      }
      askPingcaiEffect(h, id, treasure)
      return
    }
    if (request.step === 'effect-targets') {
      const treasure = request.data.treasure as PingcaiTreasure
      const targets = (response.payload.targetIds ?? []) as PlayerId[]
      if (treasure === 'wolong') {
        const max = hasLivingPingcaiFriend(h, 'zhugeliang') ? 2 : 1
        const selected = [...new Set(targets)].filter(targetId => pl(h.state, targetId)?.alive).slice(0, max)
        for (const targetId of selected) deal(h, id, targetId, 1, 'fire', PANGDEGONG_PINGCAI)
      } else if (treasure === 'fengchu') {
        const max = hasLivingPingcaiFriend(h, 'pangtong') ? 4 : 3
        const selected = [...new Set(targets)].filter(targetId => pl(h.state, targetId)?.alive && !pl(h.state, targetId)?.chained).slice(0, max)
        for (const targetId of selected) setChained(h as never, targetId, PANGDEGONG_PINGCAI, true)
      } else if (treasure === 'xuanjian') {
        const targetId = targets[0]
        if (!targetId || !pl(h.state, targetId)?.alive) return
        drawCards(h.state, h.rng, targetId, 1, (name, data) => h.dispatch(name, data))
        recover(h, targetId, 1, id)
        if (hasLivingPingcaiFriend(h, 'xushu') && pl(h.state, id)?.alive) {
          drawCards(h.state, h.rng, id, 1, (name, data) => h.dispatch(name, data))
        }
      }
      return
    }
    if (request.step === 'equipment-source') {
      const sourceId = String(response.payload.optionId ?? '') as PlayerId
      if (!pingcaiEquipmentSources(h, id).includes(sourceId)) return
      const canMoveAny = hasLivingPingcaiFriend(h, 'simahui')
      const cardIds = Object.entries(pl(h.state, sourceId)?.zones.equipment ?? {})
        .filter(([slot, cardId]) => cardId && !isSlotAbolished(h.state, sourceId, slot as never)
          && (canMoveAny || h.state.cards[cardId]?.equipmentSlot === 'armor')
          && legalPingcaiEquipmentTargets(h, sourceId, cardId).length > 0)
        .map(([, cardId]) => cardId as CardId)
      if (cardIds.length) askCards(h, PANGDEGONG_PINGCAI, id, id, cardIds, '【评才·水镜】：选择要移动的装备牌', 1, 1, { sourceId }, false, 'equipment-card')
      return
    }
    if (request.step === 'equipment-card') {
      const sourceId = request.data.sourceId as PlayerId
      const cardId = (response.payload.cardIds ?? [])[0] as CardId | undefined
      const from = cardId ? equipmentLocation(h.state, id, cardId) : null
      if (!cardId || !from || from.playerId !== sourceId) return
      const targets = legalPingcaiEquipmentTargets(h, sourceId, cardId)
      if (targets.length) askTargets(h, PANGDEGONG_PINGCAI, id, id, targets, '【评才·水镜】：选择装备牌移动至的角色', { sourceId, cardId, sourceSlot: from.slot }, false, 1, 1, 'equipment-destination')
      return
    }
    if (request.step === 'equipment-destination') {
      const sourceId = request.data.sourceId as PlayerId
      const cardId = request.data.cardId as CardId
      const targetId = (response.payload.targetIds ?? [])[0] as PlayerId | undefined
      const from = equipmentLocation(h.state, id, cardId)
      if (!targetId || !from || from.playerId !== sourceId || !legalPingcaiEquipmentTargets(h, sourceId, cardId).includes(targetId)) return
      const destinationSlot = pingcaiDestinationSlot(h, targetId, cardId)
      if (!destinationSlot) return
      const replaced = (pl(h.state, targetId)?.zones.equipment as any)?.[destinationSlot] ?? null
      moveCard(h.state, cardId, { kind: 'equipment', playerId: sourceId, slot: from.slot as never }, { kind: 'equipment', playerId: targetId, slot: destinationSlot as never })
      handleEquipmentLost(h as never, sourceId, cardId)
      if (replaced) handleEquipmentLost(h as never, targetId, replaced)
      h.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: PANGDEGONG_PINGCAI }, { sourceId, targetId, cardIds: [cardId] })
      h.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: PANGDEGONG_PINGCAI }, { sourceId, targetId, cardIds: [cardId] })
      if (replaced) h.dispatch('LoseCard', { playerId: targetId, cardIds: [replaced], reason: PANGDEGONG_PINGCAI }, { sourceId: targetId, targetId, cardIds: [replaced] })
    }
  },
})

registerGroupCardDecision(LUANQUN_TAG, (rawHost, decision) => {
  const h = rawHost as unknown as SkillHost
  const ownerId = String(decision.data.ownerId) as PlayerId
  const shownByPlayer = new Map<PlayerId, CardId>()
  for (const participantId of decision.playerIds) {
    const cardId = decision.responses[participantId]?.[0]
    if (cardId && hand(h.state, participantId).includes(cardId)) shownByPlayer.set(participantId, cardId)
  }
  const ownerCard = shownByPlayer.get(ownerId)
  const ownerColor = ownerCard ? h.state.cards[ownerCard]?.color ?? null : null
  const takeable: CardId[] = []
  const holderByCard = new Map<CardId, PlayerId>()
  for (const [playerId, cardId] of shownByPlayer) {
    h.dispatch('CardMove', { playerId, cardIds: [cardId], reason: LAIMIN_LUANQUN, revealed: true }, { sourceId: playerId, cardIds: [cardId] })
    const color = h.state.cards[cardId]?.color ?? null
    if (playerId === ownerId) continue
    if (ownerColor && color === ownerColor) { takeable.push(cardId); holderByCard.set(cardId, playerId) }
    else {
      const player = pl(h.state, playerId)
      if (player) { player.marks[LAIMIN_MARK] = 1; }
    }
  }
  if (!takeable.length || !pl(h.state, ownerId)?.alive) return
  askCards(h, LAIMIN_LUANQUN, ownerId, ownerId, takeable, '【乱群】：获得至多四张与你展示牌颜色相同的牌', 0, Math.min(4, takeable.length), { holders: Object.fromEntries(holderByCard) }, true)
})

// 马良【自书】【应援】：逐张记录真正获得的牌；应援只看本人回合内使用后进入弃牌堆的实体牌。
registerSkillRuntime({
  id: MALIAN_ZISHU,
  triggers: [
    { event: 'GainCard', handle(h, id, c) {
      const p = c.event.payload as any
      if (p.playerId !== id || !Array.isArray(p.cardIds) || !p.cardIds.length || !pl(h.state, id)?.alive) return
      if (h.state.currentPlayerId !== id) {
        const key = `${MALIAN_ZISHU}:cleanup:${h.state.turnNumber}:${h.state.currentPlayerId ?? 'none'}`
        const cards = skillState(st(h), key) ?? []
        put(h, key, [...new Set([...cards, ...p.cardIds])])
        return
      }
      if (skillState(st(h), `${MALIAN_ZISHU}:drawing:${id}`)) return
      put(h, `${MALIAN_ZISHU}:drawing:${id}`, true)
      drawCards(h.state, h.rng, id, 1, (name, data) => h.dispatch(name, data))
      remove(st(h), `${MALIAN_ZISHU}:drawing:${id}`)
    } },
    { event: 'TurnEnd', handle(h, id, c) {
      const p = c.event.payload as any
      const key = `${MALIAN_ZISHU}:cleanup:${Number(p.turnNumber)}:${p.playerId ?? 'none'}`
      const cards = skillState(st(h), key) as CardId[] | undefined
      if (!cards) return
      remove(st(h), key)
      const stillOwned = cards.filter(cardId => locateOwnedCard(h.state, id, cardId))
      if (stillOwned.length) discard(h, id, stillOwned, MALIAN_ZISHU)
    } },
  ],
})

registerSkillRuntime({
  id: MALIAN_YINGYUAN,
  triggers: [
    { event: 'AfterCardUse', handle(h, id, c) {
      const p = c.event.payload as any
      if (c.event.sourceId !== id || h.state.currentPlayerId !== id || !p.cardId || !h.state.zones.discardPile.includes(p.cardId)) return
      const cardId = p.cardId as CardId
      const cardName = String(p.cardName ?? h.state.cards[cardId]?.name ?? '')
      if (!cardName || usedThisTurn(h.state, id, `${MALIAN_YINGYUAN}:${cardName}`)) return
      const targets = others(h.state, id)
      if (!targets.length) return
      h.queueSkill({ skillId: MALIAN_YINGYUAN, ownerId: id, step: 'invoke', data: { cardId, cardName } })
    } },
  ],
  startQueued(h, id, q) {
    if (q.step !== 'invoke') return
    const cardId = q.data.cardId as CardId
    if (!h.state.zones.discardPile.includes(cardId) || !others(h.state, id).length) return
    askOption(h, MALIAN_YINGYUAN, id, id, 'invoke', `【应援】：是否将【${q.data.cardName}】交给一名其他角色？`, [
      { id: 'yes', label: '交给一名其他角色' }, { id: 'no', label: '不发动' },
    ], { cardId, cardName: q.data.cardName })
  },
  resume(h, id, r, res) {
    if (r.step === 'invoke') {
      if (res.payload.optionId !== 'yes') return
      const cardId = r.data.cardId as CardId
      const targets = others(h.state, id)
      if (!h.state.zones.discardPile.includes(cardId) || !targets.length) return
      askTargets(h, MALIAN_YINGYUAN, id, id, targets.map(p => p.id), '【应援】：选择获得此牌的角色', { cardId, cardName: r.data.cardName }, false)
      return
    }
    if (r.step === 'target') {
      const targetId = res.payload.targetIds?.[0] as PlayerId | undefined
      const cardId = r.data.cardId as CardId
      if (!targetId || !others(h.state, id).some(p => p.id === targetId) || !h.state.zones.discardPile.includes(cardId)) return
      moveCard(h.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      h.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: MALIAN_YINGYUAN }, { sourceId: id, targetId, cardIds: [cardId] })
      markUsedThisTurn(h.state, id, `${MALIAN_YINGYUAN}:${String(r.data.cardName)}`)
    }
  },
})

