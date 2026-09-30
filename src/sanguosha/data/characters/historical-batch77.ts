import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'
import { registerSkillRuntime, effectiveCardColor, effectiveCardSuit, isTargetProhibited, type SkillHost } from '../../engine/skills/runtime'
import { drawCards, revealTopCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { discardCardsByIds } from '../../engine/discard-all'
import { loseHp } from '../../engine/hp'
import { recover, recoverTo } from '../../engine/recover'
import { giveCards } from '../../engine/hand-transfer'
import { resolveDamageSequence } from '../../engine/damage'
import { resumeDamageModifier } from '../../engine/damage'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { getDistance, canTarget } from '../../engine/distance'
import { skillIdsOf } from './standard'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest, UseCardRequest } from '../../engine/requests'

const B = '-b77'
const sid = (name: string) => `${name}${B}`
const RUOXUE_QIONGYING = sid('qiongying-zhugeruoxue')
const RUOXUE_NUANHUI = sid('nuanhui-zhugeruoxue')
const ZHOUFEI_LINGKONG = sid('lingkong-lezhoufei')
const ZHOUFEI_XIANSHU = sid('xianshu-lezhoufei')
const LINGLI_LIMA = sid('lima-malingli')
const LINGLI_XIAOYIN = sid('xiaoyin-malingli')
const LINGLI_HUAHUO = sid('huahuo-malingli')
const KUAQIANG_LIANGXIU = sid('liangxiu-kuaqi')
const KUAQIANG_XUNJIE = sid('xunjie-kuaqi')
const NIHENG_JIGU = sid('jigu-leniheng')
const NIHENG_SIRUI = sid('sirui-leniheng')
const STARCAOREN_SUJUN = sid('sujun-star-caoren')
const STARCAOREN_LIFENG = sid('lifeng-star-caoren')
const WULUXUN_XIONGMU = sid('xiongmu-wuluxun')
const WULUXUN_ZHANGCAI = sid('zhangcai-wuluxun')
const WULUXUN_RUXIAN = sid('ruxian-wuluxun')
const CAOYI_MIYI = sid('miyi-caoyi')
const CAOYI_YINJUN = sid('yinjun-caoyi')
const CHENSHI_QINGBEI = sid('qingbei-chenshi')
const SUNLI_KANGLI = sid('kangli-sunli')

type B77State = SanguoshaState & { b77?: Record<string, any> }
function s77(state: SanguoshaState): Record<string, any> { const target = state as B77State; target.b77 ??= {}; return target.b77 }
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function living(state: SanguoshaState) { return state.players.filter((entry) => entry.alive) }
function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId,
    prompt, timeoutMs: 25_000, optional, options }) })
}
function askOptions(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, min = 0, max = options.length) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionsRequest => ({ id, kind: 'choose-options', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, options, min, max }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  cardIds: CardId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, purpose: 'skill', hiddenCardSlots: [], cardIds, min, max }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  targetIds: PlayerId[], prompt: string, data: Record<string, unknown> = {}, min = 1, max = min) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId,
    prompt, timeoutMs: 25_000, optional: min === 0, min, max, candidateIds: targetIds }) })
}
function askUseActions(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, playerId: PlayerId,
  actions: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}) {
  if (!actions.length) return
  host.askSkill({ skillId, ownerId, step, data, build: (id): UseCardRequest => ({ id, kind: 'use-card', playerId,
    prompt: `【${skillId.split('-')[0]}】：选择使用的牌`, timeoutMs: 25_000, optional: false, actionIds: actions.map(({ id }) => id) }) })
}
function discard(host: SkillHost, ownerId: PlayerId, cardIds: CardId[], reason: string) {
  if (cardIds.length) discardCardsByIds(host as never, ownerId, cardIds, reason)
}
function handCount(state: SanguoshaState, id: PlayerId) { return player(state, id)?.zones.hand.length ?? 0 }
function handAndEquipment(state: SanguoshaState, id: PlayerId): CardId[] {
  const owner = player(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))] : []
}
function fieldMovementTargets(state: SanguoshaState, cardId: CardId) { return fieldMoveDestinations(state, cardId) }
function rank8Cards(state: SanguoshaState, ownerId: PlayerId) {
  return player(state, ownerId)?.zones.hand.filter((id) => state.cards[id]?.rank === 8) ?? []
}

export const HISTORICAL_BATCH77_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'zhugeruoxue-b77', name: '诸葛若雪', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: RUOXUE_QIONGYING, name: '琼英', description: '出牌阶段限一次，你可以移动场上一张牌，然后你弃置一张同花色的手牌（若没有需展示手牌）。' },
    { id: RUOXUE_NUANHUI, name: '暖惠', description: '结束阶段，你可以选择一名角色，该角色可视为使用X张基本牌（X为其装备区牌数且至少为1）。若其使用了同名牌，弃置装备区所有牌。' },
  ] },
  { id: 'lezhoufei-b77', name: '乐周妃', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZHOUFEI_LINGKONG, name: '灵箜', description: '锁定技，游戏开始时，你的初始手牌增加“箜篌”标记且不计入手牌上限。你每回合首次摸牌阶段外获得的牌标记为“箜篌”。', locked: true },
    { id: ZHOUFEI_XIANSHU, name: '贤淑', description: '出牌阶段，你可以交给一名其他角色一张“箜篌”并摸X张牌（X为你与该角色体力值之差且至多为5）。若此牌为红色，且该角色体力值小于等于你，该角色回复1点体力；若此牌为黑色，且该角色体力值大于等于你，该角色失去1点体力。' },
  ] },
  { id: 'malingli-b77', name: '马伶俐', kingdom: 'shu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: LINGLI_LIMA, name: '骊马', description: '锁定技，场上每有一张坐骑牌，你计算与其他角色的距离-1（至少为1）。', locked: true },
    { id: LINGLI_XIAOYIN, name: '硝引', description: '准备阶段，你可以亮出牌堆顶X张牌（X为场上你距离其1以内的角色数），获得其中红色牌，将任意张黑色牌放置在等量名连续其他角色的武将牌上。有硝引牌的角色受到伤害时，若为火焰伤害：伤害来源可以弃置硝引牌并弃置一张与硝引牌同类型的牌令此伤害+1；若为非火焰伤害：伤害来源可以获得硝引牌并将此伤害改为火焰伤害。' },
    { id: LINGLI_HUAHUO, name: '花火', description: '出牌阶段限一次，你可以将一张红色手牌当做不计次数的火【杀】使用。若目标有硝引牌，此【杀】可改为指定所有有硝引牌的角色为目标。' },
  ] },
  { id: 'kuaiqi-b77', name: '蒯祺', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: KUAQIANG_LIANGXIU, name: '良秀', description: '出牌阶段，你可以弃置两张不同类型的牌，然后获得两张与你弃置牌类型均不同的牌并交给任意角色（每种类型的牌限一次）。' },
    { id: KUAQIANG_XUNJIE, name: '殉节', description: '每个回合结束时，若你本回合获得过手牌（摸牌阶段除外），你可以令一名角色将手牌调整至等于其体力值或将体力值调整至等于其手牌数。每项每轮限一次。' },
  ] },
  { id: 'leniheng-b77', name: '乐祢衡', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: NIHENG_JIGU, name: '激鼓', description: '锁定技，游戏开始时，你的初始手牌增加“激鼓”标记且不计入手牌上限。当你造成或受到伤害后，若你手中“激鼓”等于你装备区牌张数，你摸装备区空位数张牌（发动次数达到已开始过回合的角色数时本轮失效）。', locked: true },
    { id: NIHENG_SIRUI, name: '思锐', description: '出牌阶段限一次，你可以将一张牌当字数相等的基本牌或普通锦囊牌使用（无距离和次数限制）。' },
  ] },
  { id: 'star-caoren-b77', name: '星·曹仁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: STARCAOREN_SUJUN, name: '肃军', description: '当你使用一张牌时，若你手牌中基本牌与非基本牌的数量相等，你可以摸两张牌。' },
    { id: STARCAOREN_LIFENG, name: '砺锋', description: '你可将一张本回合未使用过的颜色的手牌当不计次数的【杀】或【无懈可击】使用。' },
  ] },
  { id: 'wuluxun-b77', name: '武陆逊', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WULUXUN_XIONGMU, name: '雄幕', description: '每轮开始时，你可以将手牌摸至体力上限，然后将任意张牌随机置入牌堆，从牌堆或弃牌堆中获得等量的点数为8的牌，这些牌不计入你的手牌上限。你每回合受到第一次伤害时，若你的手牌数小于等于体力值，此伤害-1。' },
    { id: WULUXUN_ZHANGCAI, name: '彰才', description: '你使用或打出点数为8的牌时，可以摸X张牌（X为手牌中剩余点数为8的牌数量且至少为1）。' },
    { id: WULUXUN_RUXIAN, name: '儒贤', description: '限定技，出牌阶段，你可令“彰才”改为所有点数均可触发摸牌直到你的下回合开始。', },
  ] },
  { id: 'caoyi-b77', name: '曹轶', kingdom: 'wei', gender: 'female', maxHp: 4, pack: 'sp', skills: [
    { id: CAOYI_MIYI, name: '蜜饴', description: '准备阶段，你可以选择一项：1.回复一点体力；2.受到一点你造成的伤害。然后令任意名角色依次执行该项。若如此做，结束阶段这些角色执行另一项。' },
    { id: CAOYI_YINJUN, name: '寅君', description: '当你对其他角色使用手牌中唯一目标的【杀】或锦囊牌结算后，可以视为对其使用一张【杀】（此杀造成的伤害无来源）。若你此技能本回合发动次数大于你当前体力值，此技能本回合失效。' },
  ] },
  { id: 'chenshi-b77', name: '陈式', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CHENSHI_QINGBEI, name: '擎北', description: '每轮开始时，你选择任意种花色，然后你本轮无法使用这些花色的牌且使用手牌后摸选择花色数张牌。' },
  ] },
  { id: 'sunli-b77', name: '孙礼', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SUNLI_KANGLI, name: '伉厉', description: '当你造成或受到伤害后，你可摸两张牌，然后你下次造成伤害时弃置这些牌。' },
  ] },
]

registerSkillRuntime({ id: ZHOUFEI_LINGKONG,
  onGameStart(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner) return
    s77(host.state).lingkongCards ??= {}
    s77(host.state).lingkongCards[ownerId] = [...owner.zones.hand]
  },
  handLimitExempt(state, ownerId, cardId) { return (s77(state).lingkongCards?.[ownerId] ?? []).includes(cardId) },
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const event = context.event
    const data = event.payload as { playerId?: PlayerId; cardIds?: CardId[]; isDraw?: boolean }
    if (data.playerId !== ownerId || host.state.phase === 'draw') return
    s77(host.state).lingkongMarkedTurn ??= {}
    if (s77(host.state).lingkongMarkedTurn[ownerId] === host.state.turnNumber) return
    const ids = (data.cardIds ?? event.cardIds ?? []).filter((id) => player(host.state, ownerId)?.zones.hand.includes(id))
    if (!ids.length) return
    s77(host.state).lingkongCards ??= {}
    s77(host.state).lingkongCards[ownerId] = [...new Set([...(s77(host.state).lingkongCards[ownerId] ?? []), ...ids])]
    s77(host.state).lingkongMarkedTurn[ownerId] = host.state.turnNumber
  } }],
})

registerSkillRuntime({ id: LINGLI_LIMA, distanceModifier: {
  toOthers(state) {
    return -state.players.flatMap((entry) => Object.values(entry.zones.equipment)).filter((cardId) => cardId
      && ['offensiveHorse', 'defensiveHorse'].includes(state.cards[cardId]?.equipmentSlot ?? '')).length
  },
} })

registerSkillRuntime({ id: NIHENG_JIGU,
  onGameStart(host, ownerId) {
    const owner = player(host.state, ownerId)
    if (!owner) return
    s77(host.state).jiguCards ??= {}
    s77(host.state).jiguCards[ownerId] = [...owner.zones.hand]
  },
  handLimitExempt(state, ownerId, cardId) { return (s77(state).jiguCards?.[ownerId] ?? []).includes(cardId) },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      s77(host.state).jiguActivations ??= {}
      s77(host.state).jiguTurnsStarted ??= {}
      s77(host.state).jiguActivations[ownerId] = 0
      s77(host.state).jiguTurnsStarted[ownerId] = []
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const activeId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!activeId) return
      s77(host.state).jiguTurnsStarted ??= {}
      const started = (s77(host.state).jiguTurnsStarted[ownerId] ??= []) as PlayerId[]
      if (!started.includes(activeId)) started.push(activeId)
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const { finalAmount } = context.event.payload as { finalAmount?: number }
      if (Number(finalAmount) <= 0 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
      const owner = player(host.state, ownerId)
      if (!owner) return
      const marked = (s77(host.state).jiguCards?.[ownerId] ?? []).filter((id: CardId) => owner.zones.hand.includes(id))
      s77(host.state).jiguCards[ownerId] = marked
      const horseAndEquipCount = Object.values(owner.zones.equipment).filter(Boolean).length
      if (marked.length !== horseAndEquipCount) return
      s77(host.state).jiguActivations ??= {}
      const cap = (s77(host.state).jiguTurnsStarted?.[ownerId] as PlayerId[] | undefined)?.length ?? 0
      if (!cap || Number(s77(host.state).jiguActivations[ownerId] ?? 0) >= cap) return
      const empty = equipmentSlotsOf(host.state, ownerId).filter((slot) => !owner.zones.equipment[slot]).length
      s77(host.state).jiguActivations[ownerId] += 1
      if (empty > 0) drawCards(host.state, host.rng, ownerId, empty, (name, payload) => host.dispatch(name, payload))
    } },
  ],
})

registerSkillRuntime({ id: STARCAOREN_SUJUN, triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
  if (context.event.sourceId !== ownerId) return
  const owner = player(host.state, ownerId)
  if (!owner) return
  const basic = owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'basic').length
  const nonbasic = owner.zones.hand.length - basic
  if (basic === nonbasic) host.queueSkill({ skillId: STARCAOREN_SUJUN, ownerId, step: 'draw', data: {} })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'draw') askOption(host, STARCAOREN_SUJUN, ownerId, 'invoke', ownerId, '【肃军】：是否摸两张牌？',
    [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' }])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke' && (response.payload as { optionId?: string }).optionId === 'yes')
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
} })
registerSkillRuntime({ id: STARCAOREN_LIFENG,
  viewAs(state, ownerId) {
    const colors = usedLifengColors(state, ownerId)
    return (player(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => {
      const card = state.cards[cardId]
      const color = effectiveCardColor(state, ownerId, cardId)
      if (!card || (color !== 'red' && color !== 'black') || colors.includes(color)) return []
      return [
        { cardId, asCardName: '杀', label: `将【${card.name}】当不计次数的【杀】使用` },
        { cardId, asCardName: '无懈可击', label: `将【${card.name}】当【无懈可击】使用` },
      ]
    })
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    const card = cardId ? state.cards[cardId] : undefined
    const color = card ? effectiveCardColor(state, ownerId, card.id) : null
    return Boolean(card && player(state, ownerId)?.zones.hand.includes(card.id)
      && (color === 'red' || color === 'black') && !usedLifengColors(state, ownerId).includes(color))
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== STARCAOREN_LIFENG) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) markLifengColor(host.state, ownerId, effectiveCardColor(host.state, ownerId, cardId))
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const data = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string; fromKind?: string }
    if (context.event.sourceSkillId !== STARCAOREN_LIFENG || data.playerId !== ownerId
      || data.cardName !== '无懈可击' || data.fromKind !== 'hand' || !data.cardId
        || host.state.cards[data.cardId]?.name === '无懈可击') return
      markLifengColor(host.state, ownerId, effectiveCardColor(host.state, ownerId, data.cardId))
    } },
  ],
})
function usedLifengColors(state: SanguoshaState, ownerId: PlayerId): string[] {
  const record = s77(state).lifengColors?.[ownerId]
  return record?.turn === state.turnNumber ? record.colors as string[] : []
}
function markLifengColor(state: SanguoshaState, ownerId: PlayerId, color: string | null | undefined) {
  if (color !== 'red' && color !== 'black') return
  s77(state).lifengColors ??= {}
  const record = s77(state).lifengColors[ownerId]
  if (!record || record.turn !== state.turnNumber) s77(state).lifengColors[ownerId] = { turn: state.turnNumber, colors: [color] }
  else if (!record.colors.includes(color)) record.colors.push(color)
}
registerSkillRuntime({ id: WULUXUN_XIONGMU, handLimitExempt(state, ownerId, cardId) {
  return (s77(state).xiongmu8Cards?.[ownerId] ?? []).includes(cardId)
}, incomingDamage(state, ownerId, context) {
  if (context.amount <= 0) return null
  s77(state).xiongmuDamageTurns ??= {}
  if (s77(state).xiongmuDamageTurns[ownerId] === state.turnNumber) return null
  s77(state).xiongmuDamageTurns[ownerId] = state.turnNumber
  if (handCount(state, ownerId) > (player(state, ownerId)?.hp ?? 0)) return null
  return { amount: Math.max(0, context.amount - 1) }
}, triggers: [{ event: 'RoundStart', handle(host, ownerId) {
  host.queueSkill({ skillId: WULUXUN_XIONGMU, ownerId, step: 'prepare', data: { round: host.state.roundNumber } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'prepare' || prompt.data.round !== host.state.roundNumber) return
  askOption(host, WULUXUN_XIONGMU, ownerId, 'invoke', ownerId, '【雄幕】：是否摸牌并置换点数为8的牌？', [
    { id: 'yes', label: '发动雄幕' }, { id: 'no', label: '不发动' },
  ], { round: prompt.data.round })
},
resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || resolution.data.round !== host.state.roundNumber) return
      const owner = player(host.state, ownerId)
      if (!owner) return
      const needed = Math.max(0, owner.maxHp - owner.zones.hand.length)
      if (needed) drawCards(host.state, host.rng, ownerId, needed, (name, payload) => host.dispatch(name, payload))
      const eightCount = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.rank === 8).length
        + host.state.zones.discardPile.filter((id) => host.state.cards[id]?.rank === 8).length
      const maxReturn = Math.min(owner.zones.hand.length, eightCount)
      askOption(host, WULUXUN_XIONGMU, ownerId, 'return', ownerId, '【雄幕】：选择随机置入牌堆并换取点数8牌的数量',
        Array.from({ length: maxReturn + 1 }, (_, count) => ({ id: String(count), label: `${count}张` })), {}, false)
      return
    }
    if (resolution.step === 'take-eight') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const candidates = new Set(host.state.zones.discardPile.filter((id) => host.state.cards[id]?.rank === 8))
      const target = player(host.state, ownerId)
      if (!target) return
      const selectedDiscard = [...new Set(ids)].filter((id) => candidates.has(id)).slice(0, Number(resolution.data.count ?? 0))
      for (const id of selectedDiscard) {
        moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      }
      const needed = Math.max(0, Number(resolution.data.count ?? 0) - selectedDiscard.length)
      const deckEights = host.state.zones.drawPile.filter((id) => host.state.cards[id]?.rank === 8)
      const selectedDeck = host.rng.shuffle(deckEights).slice(0, needed)
      for (const id of selectedDeck) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      const selected = [...selectedDiscard, ...selectedDeck]
      s77(host.state).xiongmu8Cards ??= {}
      s77(host.state).xiongmu8Cards[ownerId] = [...new Set([...(s77(host.state).xiongmu8Cards[ownerId] ?? []), ...selected])]
      if (selected.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: selected, reason: WULUXUN_XIONGMU }, { targetId: ownerId, cardIds: selected })
      return
    }
  if (resolution.step === 'return') {
    const count = Number((response.payload as { optionId?: string }).optionId)
    const hand = player(host.state, ownerId)?.zones.hand ?? []
    if (!Number.isInteger(count) || count < 0 || count > hand.length) return
    if (!count) return
    askCards(host, WULUXUN_XIONGMU, ownerId, 'select-return', ownerId, hand, '【雄幕】：选择置入牌堆的牌', { count }, count, count)
    return
  }
  if (resolution.step !== 'select-return') return
  const data = resolution.data as { count?: number }
  const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
  const owner = player(host.state, ownerId)
  const returning = [...new Set(ids)].filter((id) => owner?.zones.hand.includes(id)).slice(0, Number(data.count ?? 0))
  for (const id of returning) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
  if (returning.length) host.state.zones.drawPile = host.rng.shuffle(host.state.zones.drawPile)
  const available = host.state.zones.discardPile.filter((id) => host.state.cards[id]?.rank === 8)
  const takeCount = Math.min(returning.length, available.length)
  if (!returning.length) return
  askCards(host, WULUXUN_XIONGMU, ownerId, 'take-eight', ownerId, available, '【雄幕】：选择从弃牌堆获得点数为8的牌，其余从牌堆随机获得',
    { count: returning.length, takeCount }, 0, takeCount)
},
})

registerSkillRuntime({ id: WULUXUN_ZHANGCAI, triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const data = context.event.payload as { cardId?: CardId }
    const card = data.cardId ? host.state.cards[data.cardId] : undefined
    const generalized = Boolean(s77(host.state).ruxianActive?.[ownerId])
    if ((card?.rank === 8 || generalized) && data.cardId)
      host.queueSkill({ skillId: WULUXUN_ZHANGCAI, ownerId, step: 'offer', data: {} })
  } },
  { event: 'CardResponded', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
    if (data.playerId !== ownerId || !data.cardId) return
    const card = host.state.cards[data.cardId]
    if (card?.rank !== 8 && !s77(host.state).ruxianActive?.[ownerId]) return
    host.queueSkill({ skillId: WULUXUN_ZHANGCAI, ownerId, step: 'offer', data: {} })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'offer') askOption(host, WULUXUN_ZHANGCAI, ownerId, 'invoke', ownerId, '【彰才】：是否摸牌？', [
    { id: 'yes', label: `摸${Math.max(1, rank8Cards(host.state, ownerId).length)}张牌` }, { id: 'no', label: '不发动' },
  ])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke' && (response.payload as { optionId?: string }).optionId === 'yes')
    drawCards(host.state, host.rng, ownerId, Math.max(1, rank8Cards(host.state, ownerId).length), (name, payload) => host.dispatch(name, payload))
} })
registerSkillRuntime({ id: WULUXUN_RUXIAN, limited: true, activeActions(state, ownerId) {
  return state.currentPlayerId === ownerId && state.phase === 'play' && !player(state, ownerId)?.usedLimitedSkills.includes(WULUXUN_RUXIAN)
    ? [{ id: 'ruxian:activate', label: '【儒贤】令【彰才】改为任意点数' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'ruxian:activate' || !player(host.state, ownerId) || player(host.state, ownerId)!.usedLimitedSkills.includes(WULUXUN_RUXIAN)) return
  player(host.state, ownerId)!.usedLimitedSkills.push(WULUXUN_RUXIAN)
  s77(host.state).ruxianActive ??= {}
  s77(host.state).ruxianActive[ownerId] = true
}, triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
  const data = context.event.payload as { playerId?: PlayerId }
  if (data.playerId === ownerId) delete s77(host.state).ruxianActive?.[ownerId]
} }] })

registerSkillRuntime({ id: CHENSHI_QINGBEI, locksOwnSuits(state, ownerId) {
  const record = s77(state).qingbei?.[ownerId]
  return record?.round === state.roundNumber ? record.suits as Suit[] : []
}, triggers: [
  { event: 'RoundStart', handle(host, ownerId) {
    askOptions(host, CHENSHI_QINGBEI, ownerId, 'suits', ownerId, '【擎北】：选择本轮禁止使用的花色',
      ['spade', 'heart', 'club', 'diamond'].map((id) => ({ id, label: ({ spade: '♠黑桃', heart: '♥红桃', club: '♣梅花', diamond: '♦方块' } as Record<string, string>)[id]! })),
      { round: host.state.roundNumber }, 0, 4)
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const data = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; fromKind?: string }
    if (data.fromKind !== 'hand') return
    const record = s77(host.state).qingbei?.[ownerId]
    if (record?.round === host.state.roundNumber && record.suits?.length)
      drawCards(host.state, host.rng, ownerId, record.suits.length, (name, payload) => host.dispatch(name, payload))
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'suits' || resolution.data.round !== host.state.roundNumber) return
  const ids = (response.payload as { optionIds?: string[] }).optionIds ?? []
  s77(host.state).qingbei ??= {}
  s77(host.state).qingbei[ownerId] = { round: host.state.roundNumber, suits: [...new Set(ids)].filter((id): id is Suit => ['spade', 'heart', 'club', 'diamond'].includes(id)) }
} })

registerSkillRuntime({ id: SUNLI_KANGLI, triggers: [
  { event: 'DamageSettled', handle(host, ownerId, context) {
    const { finalAmount } = context.event.payload as { finalAmount?: number }
    if (Number(finalAmount) <= 0 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
    if (context.event.sourceId === ownerId) {
      const pending = (s77(host.state).kangliCards?.[ownerId] ?? []) as CardId[]
      const inHand = pending.filter((id) => player(host.state, ownerId)?.zones.hand.includes(id))
      if (inHand.length) discard(host, ownerId, inHand, SUNLI_KANGLI)
      delete s77(host.state).kangliCards?.[ownerId]
    }
    host.queueSkill({ skillId: SUNLI_KANGLI, ownerId, step: 'offer', data: {} })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'offer') return
  askOption(host, SUNLI_KANGLI, ownerId, 'invoke', ownerId, '【伉厉】：是否摸两张牌？', [
    { id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' },
  ])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const ids = drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
  s77(host.state).kangliCards ??= {}
  s77(host.state).kangliCards[ownerId] = [...new Set([...(s77(host.state).kangliCards[ownerId] ?? []), ...ids])]
} })

registerSkillRuntime({ id: RUOXUE_QIONGYING, activeActions(state, ownerId) {
  if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, RUOXUE_QIONGYING)) return []
  return fieldCards(state).length ? [{ id: 'qiongying:activate', label: '【琼英】移动场上一张牌' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'qiongying:activate' || usedThisPhase(host.state, ownerId, RUOXUE_QIONGYING)) return
  const cards = fieldCards(host.state)
  if (!cards.length) return
  askCards(host, RUOXUE_QIONGYING, ownerId, 'card', ownerId, cards.map((entry) => entry.cardId), '【琼英】：选择场上一张牌')
}, resume(host, ownerId, resolution, response) {
  const data = resolution.data as { cardId?: CardId; suit?: Suit }
  if (resolution.step === 'card') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const entry = cardId ? fieldCards(host.state).find((candidate) => candidate.cardId === cardId) : undefined
    if (!entry) return
    const destinations = fieldMovementTargets(host.state, entry.cardId)
    if (!destinations.length) return
    const suit = effectiveCardSuit(host.state, ownerId, entry.cardId)
    if (!suit) return
    askTargets(host, RUOXUE_QIONGYING, ownerId, 'destination', ownerId, destinations, '【琼英】：选择移动目标', { cardId, suit })
    return
  }
  if (resolution.step !== 'destination') return
  const cardId = data.cardId
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  if (!cardId || !targetId || !fieldMovementTargets(host.state, cardId).includes(targetId)) return
  const suit = effectiveCardSuit(host.state, ownerId, cardId)
  moveFieldCard(host as never, cardId, targetId)
  const hand = player(host.state, ownerId)?.zones.hand ?? []
  const matches = hand.filter((id) => effectiveCardSuit(host.state, ownerId, id) === suit)
  if (matches.length) askCards(host, RUOXUE_QIONGYING, ownerId, 'discard-match', ownerId, matches, '【琼英】：弃置一张同花色手牌', {}, 1, 1)
  else {
    host.askSkill({ skillId: RUOXUE_QIONGYING, ownerId, step: 'show-hand', data: {}, build: (id) => ({ id,
      kind: 'choose-cards', playerId: ownerId, prompt: '【琼英】：你没有同花色手牌，展示手牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds: [...hand], hiddenCardSlots: [], min: 0, max: 0 }) })
  }
  markUsedThisPhase(host.state, ownerId, RUOXUE_QIONGYING)
},
})

registerSkillRuntime({ id: RUOXUE_NUANHUI, triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
  const data = context.event.payload as { playerId?: PlayerId; phase?: string }
  if (data.playerId === ownerId && data.phase === 'finish')
    host.queueSkill({ skillId: RUOXUE_NUANHUI, ownerId, step: 'target', data: {} })
} }, { event: 'AfterCardUse', handle(host, ownerId, context) {
  const state = s77(host.state).nuanhuiUse?.[ownerId]
  if (!state || context.event.sourceSkillId !== RUOXUE_NUANHUI || context.event.sourceId !== state.targetId) return
  recordNuanhuiUse(host, ownerId, String((context.event.payload as { cardName?: string }).cardName ?? ''))
  host.queueSkill({ skillId: RUOXUE_NUANHUI, ownerId, step: 'continue', data: {} })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'continue') { continueNuanhui(host, ownerId); return }
  if (prompt.step !== 'target') return
  askOption(host, RUOXUE_NUANHUI, ownerId, 'invoke', ownerId, '【暖惠】：是否令一名角色使用基本牌？', [
    { id: 'yes', label: '发动暖惠' }, { id: 'no', label: '不发动' },
  ])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targets = living(host.state).map(({ id }) => id)
    if (targets.length) askTargets(host, RUOXUE_NUANHUI, ownerId, 'choose-target', ownerId, targets, '【暖惠】：选择可以使用基本牌的角色')
    return
  }
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  if (resolution.step === 'choose-target') {
    const target = targetId ? player(host.state, targetId) : undefined
    if (!target?.alive) return
    const count = Math.max(1, Object.values(target.zones.equipment).filter(Boolean).length)
    s77(host.state).nuanhuiUse ??= {}
    s77(host.state).nuanhuiUse[ownerId] = { targetId, count, used: 0, names: [] }
    continueNuanhui(host, ownerId)
    return
  }
  if (resolution.step === 'name') {
    const state = s77(host.state).nuanhuiUse?.[ownerId]
    const choice = (response.payload as { optionId?: string }).optionId
    if (!state || !choice || choice === 'stop') { finishNuanhui(host, ownerId); return }
    const target = player(host.state, state.targetId)
    if (!target?.alive) { finishNuanhui(host, ownerId); return }
    if (choice === '杀') {
      const targets = living(host.state).filter((item) => item.id !== state.targetId && canTarget(host.state, state.targetId, item.id)).map(({ id }) => id)
      if (!targets.length) { continueNuanhui(host, ownerId); return }
      askTargets(host, RUOXUE_NUANHUI, ownerId, 'slash-target', state.targetId, targets, '【暖惠】：选择【杀】的目标', { name: choice })
      return
    }
    if ((choice === '桃' && target.hp >= target.maxHp) || !['桃', '酒'].includes(choice)) { continueNuanhui(host, ownerId); return }
    const ok = host.beginVirtualBasic({ sourceId: state.targetId, targetIds: [state.targetId], cardName: choice, sourceSkillId: RUOXUE_NUANHUI })
    if (!ok) continueNuanhui(host, ownerId)
    return
  }
  if (resolution.step === 'slash-target') {
    const state = s77(host.state).nuanhuiUse?.[ownerId]
    const picked = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const targetId = state?.targetId
    if (!state || !targetId || !picked || !canTarget(host.state, targetId, picked)) { continueNuanhui(host, ownerId); return }
    if (!host.beginVirtualBasic({ sourceId: targetId, targetIds: [picked], cardName: '杀', sourceSkillId: RUOXUE_NUANHUI })) continueNuanhui(host, ownerId)
  }
},
})
function availableNuanhuiNames(state: SanguoshaState, targetId: PlayerId): string[] {
  const owner = player(state, targetId)
  if (!owner) return []
  return [
    ...(living(state).some((candidate) => candidate.id !== targetId && canTarget(state, targetId, candidate.id)) ? ['杀'] : []),
    ...(owner.hp < owner.maxHp ? ['桃'] : []),
    '酒',
  ]
}
function continueNuanhui(host: SkillHost, ownerId: PlayerId) {
  const state = s77(host.state).nuanhuiUse?.[ownerId]
  const target = state ? player(host.state, state.targetId) : undefined
  if (!state || !target?.alive || state.used >= state.count) { finishNuanhui(host, ownerId); return }
  const names = availableNuanhuiNames(host.state, state.targetId)
  if (!names.length) { finishNuanhui(host, ownerId); return }
  askOption(host, RUOXUE_NUANHUI, ownerId, 'name', state.targetId, `【暖惠】：再使用一张基本牌（${state.used}/${state.count}）`,
    [{ id: 'stop', label: '停止' }, ...names.map((name) => ({ id: name, label: `使用【${name}】` }))])
}
function recordNuanhuiUse(host: SkillHost, ownerId: PlayerId, cardName: string) {
  const state = s77(host.state).nuanhuiUse?.[ownerId]
  if (!state) return
  state.used += 1
  if (state.names.includes(cardName)) {
    const target = player(host.state, state.targetId)
    const equipment = Object.values(target?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))
    discard(host, state.targetId, equipment, RUOXUE_NUANHUI)
  }
  else state.names.push(cardName)
}
function finishNuanhui(host: SkillHost, ownerId: PlayerId) { delete s77(host.state).nuanhuiUse?.[ownerId] }

registerSkillRuntime({ id: KUAQIANG_XUNJIE, triggers: [
  { event: 'GainCard', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId }
    if (data.playerId === ownerId && host.state.phase !== 'draw') {
      s77(host.state).xunjieGainedTurn ??= {}
      s77(host.state).xunjieGainedTurn[ownerId] = host.state.turnNumber
    }
  } },
  { event: 'TurnEnd', handle(host, ownerId) {
    if (!player(host.state, ownerId)?.alive || s77(host.state).xunjieGainedTurn?.[ownerId] !== host.state.turnNumber) return
    s77(host.state).xunjieRoundUse ??= {}
    const used = s77(host.state).xunjieRoundUse[ownerId]?.[host.state.roundNumber] ?? []
    const options = ['hand-to-hp', 'hp-to-hand'].filter((key) => !used.includes(key))
    if (options.length) host.queueSkill({ skillId: KUAQIANG_XUNJIE, ownerId, step: 'target', data: { options } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'target') return
  askOption(host, KUAQIANG_XUNJIE, ownerId, 'invoke', ownerId, '【殉节】：是否调整一名角色的手牌数或体力值？', [
    { id: 'yes', label: '发动殉节' }, { id: 'no', label: '不发动' },
  ], { options: prompt.data.options })
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const candidates = living(host.state).map(({ id }) => id)
    if (candidates.length) askTargets(host, KUAQIANG_XUNJIE, ownerId, 'target', ownerId, candidates, '【殉节】：选择一名角色')
    return
  }
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !player(host.state, targetId)?.alive) return
    const used = s77(host.state).xunjieRoundUse?.[ownerId]?.[host.state.roundNumber] ?? []
    const options = ['hand-to-hp', 'hp-to-hand'].filter((key) => !used.includes(key))
    if (options.length) askOption(host, KUAQIANG_XUNJIE, ownerId, 'mode', ownerId, '【殉节】：选择调整方式', options.map((key) => ({
      id: key, label: key === 'hand-to-hp' ? '令其手牌数调整至体力值' : '令其体力值调整至手牌数',
    })), { targetId }, false)
    return
  }
  if (resolution.step === 'discard-to-hp') {
    const targetId = response.playerId
    const target = player(host.state, targetId)
    const count = Number(resolution.data.count ?? 0)
    const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => target?.zones.hand.includes(id)).slice(0, count)
    if (ids.length === count) discard(host, targetId, ids, KUAQIANG_XUNJIE)
    return
  }
  if (resolution.step !== 'mode') return
  const { targetId } = resolution.data as { targetId?: PlayerId }
  const mode = (response.payload as { optionId?: string }).optionId
  const target = targetId ? player(host.state, targetId) : undefined
  if (!target?.alive || !mode || !['hand-to-hp', 'hp-to-hand'].includes(mode)) return
  s77(host.state).xunjieRoundUse ??= {}
  s77(host.state).xunjieRoundUse[ownerId] ??= {}
  const used = s77(host.state).xunjieRoundUse[ownerId][host.state.roundNumber] ??= []
  if (used.includes(mode)) return
  used.push(mode)
  if (mode === 'hp-to-hand') {
    const diff = target.zones.hand.length - target.hp
    if (diff > 0) recoverTo(host as never, target.id, target.zones.hand.length, ownerId, KUAQIANG_XUNJIE)
    else if (diff < 0) loseHp(host as never, target.id, -diff, KUAQIANG_XUNJIE)
    return
  }
  const diff = target.zones.hand.length - target.hp
  if (diff < 0) drawCards(host.state, host.rng, target.id, -diff, (name, payload) => host.dispatch(name, payload))
  else if (diff > 0) {
    const cardIds = [...target.zones.hand]
    askCards(host, KUAQIANG_XUNJIE, ownerId, 'discard-to-hp', target.id, cardIds, '【殉节】：弃置至体力值张数', { count: diff }, diff, diff)
  }
},
})

registerSkillRuntime({ id: KUAQIANG_LIANGXIU, activeActions(state, ownerId) {
  if (state.currentPlayerId !== ownerId || state.phase !== 'play') return []
  const hand = handAndEquipment(state, ownerId)
  const hasDifferent = new Set(hand.map((id) => state.cards[id]?.category).filter(Boolean)).size >= 2
  const remaining = [...new Set(hand.map((id) => state.cards[id]?.category).filter((value): value is NonNullable<typeof value> => value !== undefined))]
    .filter((category) => !usedThisPhase(state, ownerId, `${KUAQIANG_LIANGXIU}:category:${category}`))
  return hasDifferent && remaining.length >= 2
    ? [{ id: 'liangxiu:activate', label: '【良秀】弃置两张不同类别的牌' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'liangxiu:activate') return
    const ids = handAndEquipment(host.state, ownerId)
    const choices = ids.filter((id) => {
      const category = host.state.cards[id]?.category
      return category && !usedThisPhase(host.state, ownerId, `${KUAQIANG_LIANGXIU}:category:${category}`)
    })
    if (new Set(choices.map((id) => host.state.cards[id]?.category)).size >= 2)
      askCards(host, KUAQIANG_LIANGXIU, ownerId, 'cost', ownerId, choices, '【良秀】：弃置两张类别不同的牌', {}, 2, 2)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'cost') {
    const target = player(host.state, ownerId)
    const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => target && handAndEquipment(host.state, ownerId).includes(id)).slice(0, 2)
    if (ids.length !== 2 || host.state.cards[ids[0]!]?.category === host.state.cards[ids[1]!]?.category) return
    const categories = ids.map((id) => host.state.cards[id]!.category)
    discard(host, ownerId, ids, KUAQIANG_LIANGXIU)
    for (const category of categories) markUsedThisPhase(host.state, ownerId, `${KUAQIANG_LIANGXIU}:category:${category}`)
    const excluded = new Set(categories)
    const discardChoices = host.state.zones.discardPile.filter((id) => {
      const category = host.state.cards[id]?.category
      return category && !excluded.has(category)
    })
    const drawChoices = host.state.zones.drawPile.filter((id) => {
      const category = host.state.cards[id]?.category
      return category && !excluded.has(category)
    })
    s77(host.state).liangxiuDrawChoices ??= {}
    s77(host.state).liangxiuDrawChoices[ownerId] = drawChoices
    if (discardChoices.length + drawChoices.length >= 2) askCards(host, KUAQIANG_LIANGXIU, ownerId, 'obtain-discard', ownerId, discardChoices,
      '【良秀】：选择弃牌堆中的牌，其余从牌堆随机获得', { excludedCategories: [...excluded] }, 0, 2)
    return
  }
  if (resolution.step === 'obtain-discard') {
    const data = resolution.data as { excludedCategories?: string[] }
    const excluded = new Set(data.excludedCategories ?? [])
    const selectedDiscard = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => host.state.zones.discardPile.includes(id) && !excluded.has(host.state.cards[id]?.category ?? '')).slice(0, 2)
    const categories = s77(host.state).liangxiuDrawChoices?.[ownerId] as CardId[] | undefined ?? []
    const randomDraw = host.rng.shuffle(categories.filter((id) => host.state.zones.drawPile.includes(id)
      && !excluded.has(host.state.cards[id]?.category ?? ''))).slice(0, 2 - selectedDiscard.length)
    const result = [...selectedDiscard, ...randomDraw]
    delete s77(host.state).liangxiuDrawChoices?.[ownerId]
    if (result.length !== 2) return
    for (const id of selectedDiscard) moveCard(host.state, id, { kind: 'discardPile' }, { kind: 'processingArea' })
    for (const id of randomDraw) moveCard(host.state, id, { kind: 'drawPile' }, { kind: 'processingArea' })
    s77(host.state).liangxiuCards ??= {}
    s77(host.state).liangxiuCards[ownerId] = result
    askTargets(host, KUAQIANG_LIANGXIU, ownerId, 'recipient', ownerId, living(host.state).map(({ id }) => id),
      `【良秀】：选择第1张牌的获得者（${result.length}张可分给同一角色）`, { cardIds: result, index: 0 }, 1, 1)
    return
  }
  if (resolution.step === 'recipient') {
    const cardIds = (resolution.data.cardIds as CardId[] | undefined) ?? (s77(host.state).liangxiuCards?.[ownerId] ?? [])
    const index = Number(resolution.data.index ?? 0)
    const recipients = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const toId = recipients.find((id) => player(host.state, id)?.alive)
    const cardId = cardIds[index]
    if (!toId || !cardId || !host.state.zones.processingArea.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: toId })
    host.dispatch('GainCard', { playerId: toId, cardIds: [cardId], reason: KUAQIANG_LIANGXIU }, { sourceId: ownerId, targetId: toId, cardIds: [cardId] })
    if (index + 1 < cardIds.length) askTargets(host, KUAQIANG_LIANGXIU, ownerId, 'recipient', ownerId,
      living(host.state).map(({ id }) => id), `【良秀】：选择第${index + 2}张牌的获得者`, { cardIds, index: index + 1 }, 1, 1)
    else delete s77(host.state).liangxiuCards?.[ownerId]
  }
},
})

registerSkillRuntime({ id: NIHENG_SIRUI, activeActions(state, ownerId) {
  if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, NIHENG_SIRUI)) return []
  const hand = player(state, ownerId)?.zones.hand ?? []
  return hand.some((id) => siruiActions(state, ownerId, id).length)
    ? [{ id: 'sirui:activate', label: '【思锐】将一张牌转化为等字数牌' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'sirui:activate') return
  const hand = player(host.state, ownerId)?.zones.hand ?? []
  const cards = hand.filter((id) => siruiActions(host.state, ownerId, id).length)
  if (cards.length) askCards(host, NIHENG_SIRUI, ownerId, 'card', ownerId, cards, '【思锐】：选择转化材料')
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'card') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !player(host.state, ownerId)?.zones.hand.includes(cardId)) return
    const actions = siruiActions(host.state, ownerId, cardId)
    const names = [...new Set(actions.map((action) => action.asCardName))]
    if (names.length) askOption(host, NIHENG_SIRUI, ownerId, 'name', ownerId, '【思锐】：选择要使用的牌名', names.map((name) => ({ id: name, label: `当【${name}】使用` })), { cardId }, false)
    return
  }
  if (resolution.step === 'name') {
    const cardId = (resolution.data as { cardId?: CardId }).cardId
    const name = (response.payload as { optionId?: string }).optionId
    if (!cardId || !name) return
    const actions = siruiActions(host.state, ownerId, cardId).filter((action) => action.asCardName === name)
    if (actions.length) askUseActions(host, NIHENG_SIRUI, ownerId, 'use', ownerId,
      actions.map((action) => ({ id: action.id, label: action.label })), { cardId, name })
    return
  }
  if (resolution.step !== 'use') return
  const { cardId, name } = resolution.data as { cardId?: CardId; name?: string }
  const actionId = (response.payload as { actionId?: string }).actionId
  if (!cardId || !name || !actionId) return
  const action = siruiActions(host.state, ownerId, cardId).find((candidate) => candidate.id === actionId && candidate.asCardName === name)
  if (!action) return
  markUsedThisPhase(host.state, ownerId, NIHENG_SIRUI)
  executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true, countSlashUsage: false, ignoreUsageLimits: true })
},
})
function siruiActions(state: SanguoshaState, ownerId: PlayerId, cardId: CardId) {
  const physical = state.cards[cardId]
  const playerState = player(state, ownerId)
  if (!physical || !playerState?.zones.hand.includes(cardId)) return []
  const length = Array.from(physical.name).length
  const names = [...new Set(Object.values(state.cards).filter((card) => Array.from(card.name).length === length
    && (card.category === 'basic' || (card.category === 'trick' && INSTANT_TRICKS.has(card.name)))
    && !card.virtual).map((card) => card.name))]
  return names.flatMap((name) => declaredCardActions(state, ownerId, cardId, name, `【思锐】视为使用【${name}】`,
    { sourceSkillId: NIHENG_SIRUI, ignoreDistance: true, ignoreUsageLimits: true })
    .filter((action): action is Extract<typeof action, { kind: 'use-card' }> => action.kind === 'use-card'))
}

registerSkillRuntime({ id: CAOYI_MIYI, triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.playerId === ownerId && data.phase === 'prepare')
      host.queueSkill({ skillId: CAOYI_MIYI, ownerId, step: 'mode', data: {} })
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (data.playerId !== ownerId || data.phase !== 'finish') return
    const state = s77(host.state).miyi?.[ownerId]
    if (!state || state.turn !== host.state.turnNumber || !state.targetIds.length) return
    delete s77(host.state).miyi[ownerId]
    const inverse = state.mode === 'recover' ? 'damage' : 'recover'
    if (inverse === 'recover') {
      for (const targetId of state.targetIds) if (player(host.state, targetId)?.alive) recover(host as never, targetId, 1, ownerId, CAOYI_MIYI)
    } else resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: state.targetIds, amount: 1,
      nature: 'normal', cardId: null, cardName: null })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'mode') return
  askOption(host, CAOYI_MIYI, ownerId, 'choose-mode', ownerId, '【蜜饴】：选择一项并令任意名角色依次执行', [
    { id: 'recover', label: '回复1点体力' },
    { id: 'damage', label: '受到1点你造成的伤害' },
  ])
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'choose-mode') {
    const mode = (response.payload as { optionId?: string }).optionId
    if (!mode || !['recover', 'damage'].includes(mode)) return
    const candidates = living(host.state).map(({ id }) => id)
    askTargets(host, CAOYI_MIYI, ownerId, 'targets', ownerId, candidates, '【蜜饴】：选择依次执行此项的角色', { mode }, 0, candidates.length)
    return
  }
  if (resolution.step !== 'targets') return
  const mode = (resolution.data as { mode?: string }).mode
  const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
  const targetIds = [...new Set(selected)].filter((id) => player(host.state, id)?.alive)
  s77(host.state).miyi ??= {}
  if (targetIds.length) s77(host.state).miyi[ownerId] = { mode, targetIds, turn: host.state.turnNumber }
  if (mode === 'recover') {
    if (player(host.state, ownerId)?.alive) recover(host as never, ownerId, 1, ownerId, CAOYI_MIYI)
    for (const targetId of targetIds) if (player(host.state, targetId)?.alive) recover(host as never, targetId, 1, ownerId, CAOYI_MIYI)
  } else {
    resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [ownerId, ...targetIds], amount: 1,
      nature: 'normal', cardId: null, cardName: null })
  }
},
})

registerSkillRuntime({ id: CAOYI_YINJUN, triggers: [
  { event: 'TurnStart', handle(host, ownerId, context) {
    const data = context.event.payload as { playerId?: PlayerId }
    if (data.playerId === ownerId) {
      s77(host.state).yinjunUses ??= {}
      s77(host.state).yinjunUses[ownerId] = 0
      s77(host.state).yinjunCards ??= {}
      s77(host.state).yinjunCards[ownerId] = {}
    }
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; fromKind?: string }
    const card = data.cardId ? host.state.cards[data.cardId] : undefined
    if (!data.cardId || data.fromKind !== 'hand' || !card || data.targetIds?.length !== 1
      || data.targetIds[0] === ownerId || (data.cardName !== '杀' && card.category !== 'trick')) return
    s77(host.state).yinjunCards ??= {}
    s77(host.state).yinjunCards[ownerId] ??= {}
    s77(host.state).yinjunCards[ownerId][data.cardId] = { targetId: data.targetIds[0], turn: host.state.turnNumber }
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const data = context.event.payload as { cardId?: CardId }
    const record = data.cardId ? s77(host.state).yinjunCards?.[ownerId]?.[data.cardId] : undefined
    if (!record || record.turn !== host.state.turnNumber || context.event.sourceId !== ownerId) return
    delete s77(host.state).yinjunCards[ownerId][data.cardId!]
    if (context.event.sourceSkillId === CAOYI_YINJUN || !player(host.state, record.targetId)?.alive
      || Number(s77(host.state).yinjunUses?.[ownerId] ?? 0) > (player(host.state, ownerId)?.hp ?? 0)
      || !canTarget(host.state, ownerId, record.targetId)) return
    host.queueSkill({ skillId: CAOYI_YINJUN, ownerId, step: 'offer', data: { targetId: record.targetId } })
  } },
], startQueued(host, ownerId, prompt) {
  if (prompt.step !== 'offer') return
  const targetId = prompt.data.targetId as PlayerId
  const targets = [targetId].filter((id) => player(host.state, id)?.alive && canTarget(host.state, ownerId, id))
  if (targets.length) askOption(host, CAOYI_YINJUN, ownerId, 'invoke', ownerId, '【寅君】：是否视为对该角色使用【杀】？', [
    { id: 'yes', label: '视为使用【杀】' }, { id: 'no', label: '不发动' },
  ], { targetId }, true)
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
  const { targetId } = resolution.data as { targetId?: PlayerId }
  if (!targetId || !canTarget(host.state, ownerId, targetId) || !player(host.state, ownerId)?.alive) return
  if (!host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: CAOYI_YINJUN, damageSourceId: null })) return
  s77(host.state).yinjunUses ??= {}
  s77(host.state).yinjunUses[ownerId] = Number(s77(host.state).yinjunUses[ownerId] ?? 0) + 1
},
})

const XIAOYIN_PILE = 'xiaoyin-malingli'
registerSkillRuntime({ id: LINGLI_XIAOYIN, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const data = context.event.payload as { playerId?: PlayerId; phase?: string }
  if (data.playerId === ownerId && data.phase === 'prepare')
    host.queueSkill({ skillId: LINGLI_XIAOYIN, ownerId, step: 'reveal', data: { turn: host.state.turnNumber } })
} }], startQueued(host, ownerId, prompt) {
  if (prompt.step === 'reveal') {
    if (prompt.data.turn !== host.state.turnNumber) return
    askOption(host, LINGLI_XIAOYIN, ownerId, 'invoke', ownerId, '【硝引】：是否亮出牌堆顶牌？', [
      { id: 'yes', label: '发动硝引' }, { id: 'no', label: '不发动' },
    ], { turn: prompt.data.turn })
    return
  }
  if (prompt.step !== 'reveal-cards' || prompt.data.turn !== host.state.turnNumber) return
  const count = living(host.state).filter((target) => target.id !== ownerId && getDistance(host.state, ownerId, target.id) <= 1).length
  if (!count) return
  const ids = revealTopCards(host.state, host.rng, count, LINGLI_XIAOYIN, (name, payload) => host.dispatch(name, payload))
  const red = ids.filter((id) => effectiveCardColor(host.state, ownerId, id) === 'red')
  const black = ids.filter((id) => effectiveCardColor(host.state, ownerId, id) !== 'red')
  for (const id of red) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  if (red.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: red, reason: LINGLI_XIAOYIN }, { targetId: ownerId, cardIds: red })
  const limit = Math.min(black.length, living(host.state).filter((target) => target.id !== ownerId).length)
  if (limit) askCards(host, LINGLI_XIAOYIN, ownerId, 'black-cards', ownerId, black, '【硝引】：选择任意张黑色牌置于连续角色武将牌上', { black, limit }, 0, limit)
  else for (const id of black) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
},
resume(host, ownerId, resolution, response) {
  if (resolution.step === 'damage-choice' || resolution.step === 'damage-payment') {
    resumeXiaoyinDamage(host, ownerId, resolution, response)
    return
  }
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId === 'yes' && resolution.data.turn === host.state.turnNumber)
      host.queueSkill({ skillId: LINGLI_XIAOYIN, ownerId, step: 'reveal-cards', data: { turn: resolution.data.turn } })
    return
  }
  if (resolution.step === 'black-cards') {
    const data = resolution.data as { black?: CardId[]; limit?: number }
    const black = data.black ?? []
    const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((id) => black.includes(id) && host.state.zones.processingArea.includes(id)).slice(0, Number(data.limit ?? 0))
    const extras = black.filter((id) => !selected.includes(id) && host.state.zones.processingArea.includes(id))
    for (const id of extras) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
    if (!selected.length) return
    const candidates = living(host.state).filter((target) => target.id !== ownerId).map(({ id }) => id)
    if (candidates.length) askTargets(host, LINGLI_XIAOYIN, ownerId, 'start-seat', ownerId, candidates,
      '【硝引】：选择连续放置的起始角色', { selected })
    else for (const id of selected) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
    return
  }
  if (resolution.step !== 'start-seat') return
  const selected = (resolution.data as { selected?: CardId[] }).selected ?? []
  const startId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const ordered = living(host.state).filter((target) => target.id !== ownerId)
  const start = ordered.findIndex((target) => target.id === startId)
  if (start < 0) {
    for (const id of selected) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
    return
  }
  for (let index = 0; index < selected.length; index += 1) {
    const cardId = selected[index]!
    const target = ordered[(start + index) % ordered.length]!
    if (!host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: target.id, pile: XIAOYIN_PILE })
    target.marks['硝引'] = (target.marks['硝引'] ?? 0) + 1
  }
},
offersGlobalDamageModifierAsk(host, ownerId, side, context) {
  if (side !== 'target' || !context.sourceId || !context.targetId) return false
  const target = player(host.state, context.targetId)
  const source = player(host.state, context.sourceId)
  const tagged = target?.characterPiles[XIAOYIN_PILE] ?? []
  if (!source?.alive || !target?.alive || !tagged.length) return false
  let choices: Array<{ id: string; label: string }>
  if (context.nature === 'fire') {
    const paymentIds = handAndEquipment(host.state, source.id)
    choices = tagged.filter((markerId) => paymentIds.some((cardId) =>
      host.state.cards[cardId]?.category === host.state.cards[markerId]?.category))
      .map((markerId) => ({ id: markerId, label: `弃置一张“硝引”牌及一张同类别牌，令伤害+1` }))
  } else choices = tagged.map((markerId) => ({ id: markerId, label: '获得一张“硝引”牌，并将此伤害改为火焰伤害' }))
  if (!choices.length) return false
  s77(host.state).xiaoyinDamage ??= {}
  s77(host.state).xiaoyinDamage[ownerId] = { sourceId: source.id, targetId: target.id, nature: context.nature }
  askOption(host, LINGLI_XIAOYIN, ownerId, 'damage-choice', source.id,
    context.nature === 'fire' ? '【硝引】：是否弃置标记牌与同类别手牌令伤害+1？' : '【硝引】：是否获得标记牌并改为火焰伤害？',
    [{ id: 'pass', label: '不发动' }, ...choices])
  return true
},
})
function resumeXiaoyinDamage(host: SkillHost, ownerId: PlayerId, resolution: { step: string; data: Record<string, unknown> }, response: { playerId: PlayerId; payload: unknown }) {
  const pending = s77(host.state).xiaoyinDamage?.[ownerId]
  if (!pending) { resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0); return }
  const optionId = (response.payload as { optionId?: string }).optionId
  if (resolution.step === 'damage-choice' && (!optionId || optionId === 'pass')) {
    delete s77(host.state).xiaoyinDamage[ownerId]
    resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0)
    return
  }
  const target = player(host.state, pending.targetId)
  const source = player(host.state, pending.sourceId)
  if (!target || !source) { delete s77(host.state).xiaoyinDamage[ownerId]; resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0); return }
  if (pending.nature === 'fire' && resolution.step === 'damage-choice') {
    const markerId = optionId
    if (!markerId || !target.characterPiles[XIAOYIN_PILE]?.includes(markerId)) {
      delete s77(host.state).xiaoyinDamage[ownerId]
      resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0)
      return
    }
    const payments = handAndEquipment(host.state, source.id).filter((cardId) =>
      host.state.cards[cardId]?.category === host.state.cards[markerId]?.category)
    if (!payments.length) { delete s77(host.state).xiaoyinDamage[ownerId]; resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0); return }
    host.askSkill({ skillId: LINGLI_XIAOYIN, ownerId, step: 'damage-payment', data: { markerId }, build: (id) => ({
      id, kind: 'choose-cards', playerId: source.id, prompt: '【硝引】：弃置一张同类别牌以增加火焰伤害',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: payments, hiddenCardSlots: [], min: 0, max: 1,
    }) })
    return
  }
  if (pending.nature === 'fire' && resolution.step === 'damage-payment') {
    const markerId = resolution.data.markerId as CardId
    const paymentId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const validPayments = handAndEquipment(host.state, source.id)
    if (!paymentId || !validPayments.includes(paymentId) || !target.characterPiles[XIAOYIN_PILE]?.includes(markerId)
      || host.state.cards[paymentId]?.category !== host.state.cards[markerId]?.category) {
      delete s77(host.state).xiaoyinDamage[ownerId]
      resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0)
      return
    }
    moveCard(host.state, markerId, { kind: 'characterPile', playerId: target.id, pile: XIAOYIN_PILE }, { kind: 'discardPile' })
    target.characterPiles[XIAOYIN_PILE] = target.characterPiles[XIAOYIN_PILE].filter((id: CardId) => id !== markerId)
    target.marks['硝引'] = Math.max(0, (target.marks['硝引'] ?? 0) - 1)
    discard(host, source.id, [paymentId], LINGLI_XIAOYIN)
    delete s77(host.state).xiaoyinDamage[ownerId]
    resumeDamageModifier(host as never, LINGLI_XIAOYIN, 1)
    return
  }
  if (pending.nature === 'fire') { delete s77(host.state).xiaoyinDamage[ownerId]; resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0); return }
  const markerId = optionId
  if (!markerId || !target.characterPiles[XIAOYIN_PILE]?.includes(markerId)) {
    delete s77(host.state).xiaoyinDamage[ownerId]
    resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0)
    return
  }
  moveCard(host.state, markerId, { kind: 'characterPile', playerId: target.id, pile: XIAOYIN_PILE }, { kind: 'hand', playerId: source.id })
  target.characterPiles[XIAOYIN_PILE] = target.characterPiles[XIAOYIN_PILE].filter((id: CardId) => id !== markerId)
  target.marks['硝引'] = Math.max(0, (target.marks['硝引'] ?? 0) - 1)
  delete s77(host.state).xiaoyinDamage[ownerId]
  host.dispatch('GainCard', { playerId: source.id, cardIds: [markerId], reason: LINGLI_XIAOYIN }, { sourceId: target.id, targetId: source.id, cardIds: [markerId] })
  const pendingDamage = host.state.pendingDamageModifier?.options as { nature?: string } | undefined
  if (pendingDamage) pendingDamage.nature = 'fire'
  resumeDamageModifier(host as never, LINGLI_XIAOYIN, 0)
}

registerSkillRuntime({ id: LINGLI_HUAHUO, activeActions(state, ownerId) {
  if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, LINGLI_HUAHUO)) return []
  return (player(state, ownerId)?.zones.hand ?? []).some((id) => effectiveCardColor(state, ownerId, id) === 'red')
    ? [{ id: 'huahuo:activate', label: '【花火】将红色手牌当火【杀】使用' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'huahuo:activate') return
  const cards = (player(host.state, ownerId)?.zones.hand ?? []).filter((id) => effectiveCardColor(host.state, ownerId, id) === 'red')
  if (cards.length) askCards(host, LINGLI_HUAHUO, ownerId, 'card', ownerId, cards, '【花火】：选择一张红色手牌')
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'card') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !player(host.state, ownerId)?.zones.hand.includes(cardId) || effectiveCardColor(host.state, ownerId, cardId) !== 'red') return
    const actions = huahuoActions(host.state, ownerId, cardId, false)
    if (actions.length) askUseActions(host, LINGLI_HUAHUO, ownerId, 'choose-target', ownerId,
      actions.map((action) => ({ id: action.id, label: action.label })), { cardId })
    return
  }
  if (resolution.step === 'choose-target') {
    const cardId = (resolution.data as { cardId?: CardId }).cardId
    const actionId = (response.payload as { actionId?: string }).actionId
    const action = cardId ? huahuoActions(host.state, ownerId, cardId, false).find((candidate) => candidate.id === actionId) : undefined
    if (!action) return
    const chosen = action.targetIds[0]
    if (chosen && markedXiaoyinCount(host.state, chosen) > 0) {
      const allMarked = living(host.state).filter((target) => target.id !== ownerId && markedXiaoyinCount(host.state, target.id) > 0).map(({ id }) => id)
      const possible = allMarked.length > 1 && allMarked.every((id) => canTarget(host.state, ownerId, id)
        && !isTargetProhibited(host.state, ownerId, id, '杀', skillIdsOf, cardId, LINGLI_HUAHUO))
      if (possible) {
        host.askSkill({ skillId: LINGLI_HUAHUO, ownerId, step: 'mode', data: { cardId, actionId }, build: (id) => ({ id,
          kind: 'choose-option', playerId: ownerId, prompt: '【花火】：是否改为指定所有拥有“硝引”的角色？',
          timeoutMs: 25_000, optional: false, options: [{ id: 'single', label: '仅指定所选目标' }, { id: 'all', label: '改为指定所有有“硝引”的角色' }] }) })
        return
      }
    }
    completeHuahuo(host, ownerId, action)
    return
  }
  if (resolution.step !== 'mode') return
  const data = resolution.data as { cardId?: CardId; actionId?: string }
  const all = (response.payload as { optionId?: string }).optionId === 'all'
  const base = data.cardId ? huahuoActions(host.state, ownerId, data.cardId, false).find((candidate) => candidate.id === data.actionId) : undefined
  if (!base || !all) { if (base) completeHuahuo(host, ownerId, base); return }
  const fixedTargetIds = living(host.state).filter((target) => target.id !== ownerId && markedXiaoyinCount(host.state, target.id) > 0).map(({ id }) => id)
  const groupAction = huahuoActions(host.state, ownerId, data.cardId!, true, fixedTargetIds)[0]
  if (groupAction) completeHuahuo(host, ownerId, groupAction)
},
})
function markedXiaoyinCount(state: SanguoshaState, playerId: PlayerId) { return player(state, playerId)?.characterPiles[XIAOYIN_PILE]?.length ?? 0 }
function huahuoActions(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, allMarked: boolean, fixedTargetIds?: PlayerId[]) {
  if (!player(state, ownerId)?.zones.hand.includes(cardId) || effectiveCardColor(state, ownerId, cardId) !== 'red') return []
  return declaredCardActions(state, ownerId, cardId, '杀', '【花火】视为使用火【杀】', {
    sourceSkillId: LINGLI_HUAHUO, nature: 'fire', ignoreSlashQuota: true,
    ...(allMarked && fixedTargetIds?.length ? { fixedTargetIds, maxTargetsOverride: fixedTargetIds.length } : {}),
  }).filter((action): action is Extract<typeof action, { kind: 'use-card' }> => action.kind === 'use-card')
}
function completeHuahuo(host: SkillHost, ownerId: PlayerId, action: Extract<ReturnType<typeof huahuoActions>[number], { kind: 'use-card' }>) {
  if (!player(host.state, ownerId)?.zones.hand.includes(action.cardIds[0]!)) return
  markUsedThisPhase(host.state, ownerId, LINGLI_HUAHUO)
  executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true, countSlashUsage: false, ignoreUsageLimits: true })
}

registerSkillRuntime({ id: ZHOUFEI_XIANSHU, activeActions(state, ownerId) {
  const hand = player(state, ownerId)?.zones.hand ?? []
  const marked = (s77(state).lingkongCards?.[ownerId] ?? []).filter((id: CardId) => hand.includes(id))
  s77(state).lingkongCards ??= {}
  s77(state).lingkongCards[ownerId] = marked
  return state.currentPlayerId === ownerId && state.phase === 'play' && marked.length
    ? [{ id: 'xianshu:activate', label: '【贤淑】交给一名角色一张“箜篌”' }] : []
}, invokeActive(host, ownerId, actionId) {
  if (actionId !== 'xianshu:activate') return
  const targets = living(host.state).filter((entry) => entry.id !== ownerId).map(({ id }) => id)
  if (targets.length) askTargets(host, ZHOUFEI_XIANSHU, ownerId, 'target', ownerId, targets, '【贤淑】：选择获得“箜篌”的角色')
}, resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    if (!target?.alive || targetId === ownerId) return
    const cards = (s77(host.state).lingkongCards?.[ownerId] ?? []).filter((id: CardId) => player(host.state, ownerId)?.zones.hand.includes(id)) as CardId[]
    if (cards.length) askCards(host, ZHOUFEI_XIANSHU, ownerId, 'card', ownerId, cards, '【贤淑】：选择交给其的“箜篌”', { targetId })
    return
  }
  if (resolution.step !== 'card') return
  const targetId = (resolution.data as { targetId?: PlayerId }).targetId
  const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
  const owner = player(host.state, ownerId)
  const target = targetId ? player(host.state, targetId) : undefined
  if (!owner || !target?.alive || !cardId || !owner.zones.hand.includes(cardId)
    || !(s77(host.state).lingkongCards?.[ownerId] ?? []).includes(cardId)) return
  const color = effectiveCardColor(host.state, ownerId, cardId)
  const given = giveCards(host as never, ownerId, target.id, [cardId], ZHOUFEI_XIANSHU)
  if (!given.length) return
  const amount = Math.min(5, Math.abs(owner.hp - target.hp))
  if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
  if (color === 'red' && target.hp <= owner.hp) recover(host as never, target.id, 1, ownerId, ZHOUFEI_XIANSHU)
  else if (color === 'black' && target.hp >= owner.hp) loseHp(host as never, target.id, 1, ZHOUFEI_XIANSHU)
} })

