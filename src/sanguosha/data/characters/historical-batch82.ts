import type { CharacterDefinition } from './types'
import type { CardId, DamageNature, EquipmentSlot, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { effectiveCardColor, effectiveCardSuit, grantSkill, registerSkillRuntime, type DamagePreventionContext, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest, DistributeCardsRequest } from '../../engine/requests'
import { loseHp } from '../../engine/hp'
import { discardCardsByIds } from '../../engine/discard-all'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { gainMaxHp } from '../../engine/hp'
import { forceDistance } from '../../engine/distance-override'
import { canTarget, getDistance } from '../../engine/distance'
import { giveCards } from '../../engine/hand-transfer'
import { getAttackRange } from '../../engine/distance'
import { isCardProtectedFromDiscard } from '../../engine/skills/runtime'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { locateOwnedCard } from '../../engine/zones'
import { effectiveCardName } from '../../engine/zones'
import { pickableCardsOf, movePickedCard, resolvePickedCard } from '../../engine/card-pick'
import { cardHandRounds, moveCard } from '../../engine/zones'
import { hiddenHandSlot } from '../../engine/cards/host'
import { suppressSkill } from '../../engine/skill-suppression'
import { finalizeDamage } from '../../engine/damage'
import { lockCardId } from '../../engine/card-play-lock'
import { revealTopCards } from '../../engine/draw'
import { queueExtraTurn } from '../../engine/turn'
import { abolishableSlotsOf, abolishSlot, SLOT_LABELS } from '../../engine/equipment-slots'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { abolishedSlotsOf, restoreSlot } from '../../engine/equipment-slots'
import { recover } from '../../engine/recover'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { useVirtualWine, applyWineEffect } from '../../engine/virtual-wine'
import { canUseWineThisTurn } from '../../engine/virtual-wine'
import { isCardUseProhibited, isTargetProhibited } from '../../engine/skills/runtime'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { skillIdsOf } from './standard'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { INSTANT_TRICKS, instantTrickActions } from '../../engine/cards/tricks'
import { executeUseCardAction } from '../../engine/cards/basic'

const B = '-b82'
const sid = (name: string) => `${name}${B}`

const XING_ZHANGRANG_DUHAI = sid('duhai-xing-zhangrang')
const XING_ZHANGRANG_LINGSE = sid('lingse-xing-zhangrang')
const XING_ZHANGRANG_LINGSE_SLASH = sid('lingse-shortage-xing-zhangrang')
const MOU_XUNYU_BIZUO = sid('bizuo-mou-xunyu')
const MOU_XUNYU_SHIMOU = sid('shimou-mou-xunyu')
const LE_CAIYONG_JIAOWEI = sid('jiaowei-le-caiyong')
const LE_CAIYONG_FEIBAI = sid('feibai-le-caiyong')
const MOU_DONGCHENG_BAOJIA = sid('baojia-mou-dongcheng')
const MOU_DONGCHENG_DOUWEI = sid('douwei-mou-dongcheng')
const MOU_CAO_HONG_YINGJIA = sid('yingjia-mou-caohong')
const MOU_CAO_HONG_XIANJU = sid('xianju-mou-caohong')
const SHEN_ZHONGHUI_LINJIE = sid('linjie-shen-zhonghui')
const SHEN_ZHONGHUI_DUZHANG = sid('duzhang-shen-zhonghui')
const SHEN_ZHONGHUI_JIANGHUO = sid('jianghuo-shen-zhonghui')
const SHEN_ZHONGHUI_LISHI = sid('lishi-shen-zhonghui')
const ZHUGEJUN_GENGDU = sid('gengdu-zhugejun')
const ZHUGEJUN_GUMAI = sid('gumai-zhugejun')
const MOU_HULIE_CHUANYU = sid('chuanyu-mou-hulie')
const MOU_HULIE_YITOU = sid('yitou-mou-hulie')
const CHEZHOU_SHEFU = sid('shefu-chezou')
const CHEZHOU_PIGUA = sid('pigua-chezou')
const ZHUSHUO_SHUHE = sid('shuhe-zhushuo')
const ZHUSHUO_JILIE = sid('jilie-zhushuo')

type ChuanyuState = { round: number; cards: CardId[]; recipients: PlayerId[] }
function chuanyuState(state: SanguoshaState, ownerId: PlayerId): ChuanyuState {
  b82(state).chuanyu ??= {}
  const all = b82(state).chuanyu as Record<PlayerId, ChuanyuState>
  if (!all[ownerId] || all[ownerId].round !== state.roundNumber) all[ownerId] = { round: state.roundNumber, cards: [], recipients: [] }
  return all[ownerId]
}

export const HISTORICAL_BATCH82_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'xing-zhangrang-b82', name: '星·张让', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: XING_ZHANGRANG_DUHAI, name: '蠹害', description: '当你成为其他角色使用牌的目标后，你可以选择一种花色，令其获得该花色的“蠹”。其回合结束时，若手牌中有这些花色的牌，则其失去各花色对应数量的体力并移去对应“蠹”。' },
    { id: XING_ZHANGRANG_LINGSE, name: '令色', description: '出牌阶段限一次，你可以交给一名其他角色一张牌，然后随机获得其两张与此牌类型相同的牌；不足两张则视为其对你使用【杀】。若此【杀】造成伤害，此技能视为未发动过。' },
  ] },
  { id: 'mou-xunyu-b82', name: '谋·荀彧', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MOU_XUNYU_BIZUO, name: '弼佐', description: '限定技，每名角色回合结束时，若一号位体力值全场最低，你可以令一名角色立即执行额外回合；该回合除你与该角色外，其余角色非锁定技失效。回合结束后，你分配本回合所有非因弃置进入弃牌堆的牌。' },
    { id: MOU_XUNYU_SHIMOU, name: '势谋', description: '转换技，游戏开始时自选阴阳。出牌阶段限一次，令手牌数全场最低（阳）或最高（阴）的角色将手牌调整至体力上限（至多摸5），并视为使用一张由你指定牌名和目标的普通锦囊；若因此摸牌，此牌可多选一个目标；若因此弃牌，此牌额外结算一次。' },
  ] },
  { id: 'le-caiyong-b82', name: '乐蔡邕', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LE_CAIYONG_JIAOWEI, name: '焦尾', locked: true, description: '锁定技，游戏开始时，初始手牌增加“弦”标记且不计入手牌上限；失去“弦”后，防止你本回合下一次受到的伤害。' },
    { id: LE_CAIYONG_FEIBAI, name: '飞白', description: '使用牌后，你可以从随机两张字数为X的牌中选择一张获得；X为此牌与本回合上一张使用牌字数之和。' },
  ] },
  { id: 'mou-dongcheng-b82', name: '谋·董承', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MOU_DONGCHENG_BAOJIA, name: '保驾', description: '游戏开始时选择一名其他角色。你与其每回合首次受到卡牌伤害时，可废除一个装备栏防止此伤害，且该牌结算完毕后获得之。' },
    { id: MOU_DONGCHENG_DOUWEI, name: '斗围', description: '出牌阶段，你可弃置一张伤害牌，视为对攻击范围内包含你的任意名其他角色使用此牌；若有角色因此进入濒死，你回复1点体力并恢复一个装备栏，然后本回合此技能失效。' },
  ] },
  { id: 'mou-caohong-b82', name: '谋·曹洪', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MOU_CAO_HONG_YINGJIA, name: '迎驾', locked: true, description: '锁定技，你对其他角色使用牌后，本回合你与其距离视为1；若你与所有其他角色距离均为1，可获得一名角色所有手牌并交给其等量牌，每名角色每回合限一次。' },
    { id: MOU_CAO_HONG_XIANJU, name: '险拒', description: '出牌阶段限一次，你可获得攻击范围内所有角色各一张牌；若如此做，出牌阶段结束时弃置攻击范围外角色数张牌。' },
  ] },
  { id: 'shen-zhonghui-b82', name: '神·钟会', kingdom: 'shen', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SHEN_ZHONGHUI_LINJIE, name: '凛界', description: '每轮开始时，你可对一名没有“凛”的角色造成1点伤害，然后令其获得“凛”。有“凛”的其他角色受到伤害后随机弃置一张手牌；若因此弃置最后一张手牌，你对其造成1点伤害并移去其“凛”。' },
    { id: SHEN_ZHONGHUI_DUZHANG, name: '独仗', description: '每回合限一次，当你使用黑色牌指定唯一目标或成为黑色牌唯一目标后，你摸一张牌并获得一个“凛”。你的手牌上限+X（X为“凛”数）。' },
    { id: SHEN_ZHONGHUI_JIANGHUO, name: '降祸', description: '觉醒技，回合开始时，若所有角色均受到过伤害，你将所有“凛”移至武将牌上并摸等量牌，然后增加1点体力上限，失去“凛界”并获得“立世”。' },
    { id: SHEN_ZHONGHUI_LISHI, name: '立世', granted: true, description: '锁定技，结束阶段，若你没有“凛”，你受到1点雷电伤害；若你有“凛”，你移去任意个“凛”并令所有其他角色依次执行等量不同选项：1.下个准备阶段和结束阶段非锁定技失效；2.下个判定阶段依次判定【闪电】、【乐不思蜀】、【兵粮寸断】中的两种；3.下个摸牌阶段摸牌若颜色相同则全部弃置；4.下个出牌阶段每种类型手牌限使用一张；5.下个弃牌阶段弃置的牌改为由你获得。' },
  ] },
  { id: 'zhuge-jun-b82', name: '诸葛均', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHUGEJUN_GENGDU, name: '耕读', description: '出牌阶段开始时，你可亮出牌堆顶四张并选择一种颜色获得。黑色：本阶段限X次，使用黑色牌后摸两张；本回合这些牌不能使用或打出且不计入手牌上限。红色：本阶段限X次，可将一张红色牌当作本回合未使用过的普通锦囊使用。X为此次未以此法获得的牌数。' },
    { id: ZHUGEJUN_GUMAI, name: '孤脉', description: '每轮限一次，当你造成或受到伤害时，可展示所有手牌并令此伤害+1或-1。若展示牌花色相同，你可弃置一张手牌令此技能视为未发动过。' },
  ] },
  { id: 'mou-hulie-b82', name: '谋·胡烈', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MOU_HULIE_CHUANYU, name: '传舆', description: '每轮开始时，你可交给一名角色一张牌，称为“舆”。“舆”因使用进入弃牌堆时，可交给本轮未获得过“舆”的角色。回合结束时弃置所有“舆”，你可令本轮所有获得过“舆”的角色依次视为对你指定角色使用【杀】（无距离限制）。' },
    { id: MOU_HULIE_YITOU, name: '倚投', description: '其他角色出牌阶段开始时，若其手牌数全场最多，你可将所有手牌交给其；直到本回合结束，其造成伤害后你摸一张牌。' },
  ] },
  { id: 'chezou-b82', name: '车胄', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: CHEZHOU_SHEFU, name: '慑伏', locked: true, description: '锁定技，你的牌造成的伤害及其他角色的牌对你造成的伤害均改为X，X为该牌在手中的轮数。' },
    { id: CHEZHOU_PIGUA, name: '披挂', description: '你对其他角色造成大于1点伤害后，可获得其至多当前轮数张手牌；这些牌本回合不计入手牌上限。' },
  ] },
  { id: 'zhu-shuo-b82', name: '朱铄', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHUSHUO_SHUHE, name: '疏和', description: '每回合限一次，其他角色使用伤害牌时，你可从牌堆获得一张【酒】，令其选择：视为使用一张【酒】且此牌无效；或令你摸一张牌。' },
    { id: ZHUSHUO_JILIE, name: '急烈', description: '出牌阶段限一次，你弃置当前体力值张牌；弃置牌中每种花色可进行两次判定，若判定结果为【杀】，你视为使用此【杀】，其伤害值为你本回合使用【杀】的次数。' },
  ] },
]

type B82State = SanguoshaState & { b82?: Record<string, any> }
function b82(state: SanguoshaState): Record<string, any> {
  const extended = state as B82State
  extended.b82 ??= {}
  return extended.b82
}
function player(state: SanguoshaState, id: PlayerId) { return state.players.find((entry) => entry.id === id) }
function askB82Option(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}

const DUHAI_MARK_PREFIX = `${XING_ZHANGRANG_DUHAI}:suit:`
const SUITS: readonly Suit[] = ['spade', 'heart', 'club', 'diamond']
const SUIT_LABELS: Record<Suit, string> = { spade: '♠️ 黑桃', heart: '♥️ 红桃', club: '♣️ 梅花', diamond: '♦️ 方块' }
const LISHI_OPTION_IDS = ['1', '2', '3', '4', '5'] as const
const LISHI_TRICKS = ['闪电', '乐不思蜀', '兵粮寸断'] as const
const GENGDU_TRICKS = ['无中生有', '桃园结义', '南蛮入侵', '万箭齐发', '决斗', '瞒天过海', '过河拆桥', '顺手牵羊', '五谷丰登', '火攻', '借刀杀人', '铁索连环'] as const

registerSkillRuntime({ id: MOU_XUNYU_BIZUO, limited: true,
  globallyInvalidatesOtherSkills(state, ownerId, targetId) {
    const active = b82(state).bizuoExtraTurn?.[ownerId] as { turn: number; playerId: PlayerId } | undefined
    return Boolean(active && active.turn === state.turnNumber && targetId !== ownerId && targetId !== active.playerId)
  },
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId) {
      const owner = player(host.state, ownerId)
      if (!owner?.alive || b82(host.state).bizuoUsed?.[ownerId]) return
      const firstSeat = host.state.players.find((candidate) => candidate.alive && candidate.seat === 0)
      const living = host.state.players.filter((candidate) => candidate.alive)
      if (!firstSeat || !living.every((candidate) => firstSeat.hp <= candidate.hp)) return
      host.queueSkill({ skillId: MOU_XUNYU_BIZUO, ownerId, step: 'offer', data: {} })
    } },
    { event: 'TurnStart', priority: 1000, handle(host, ownerId, context) {
      const turn = context.event.payload as { playerId?: PlayerId; turnNumber?: number; kind?: string; sourceSkillId?: string }
      if (turn.kind !== 'extra' || turn.sourceSkillId !== MOU_XUNYU_BIZUO || !turn.playerId) return
      b82(host.state).bizuoExtraTurn ??= {}
      b82(host.state).bizuoExtraTurn[ownerId] = { turn: Number(turn.turnNumber ?? host.state.turnNumber), playerId: turn.playerId, cardIds: [] }
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const active = b82(host.state).bizuoExtraTurn?.[ownerId] as { turn: number; cardIds: CardId[] } | undefined
      const movement = context.event.payload as { cardId?: CardId; reason?: string }
      if (!active || active.turn !== host.state.turnNumber || movement.reason === 'discard' || !movement.cardId) return
      if (!active.cardIds.includes(movement.cardId)) active.cardIds.push(movement.cardId)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const active = b82(host.state).bizuoExtraTurn?.[ownerId] as { turn: number; playerId: PlayerId; cardIds: CardId[] } | undefined
      // TurnEnd payload intentionally has no `kind`; the active record was only
      // created by this skill's extra TurnStart, so player + turn number identify it.
      const turn = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      if (!active || turn.playerId !== active.playerId || Number(turn.turnNumber) !== active.turn) return
      const cards = active.cardIds.filter((cardId) => host.state.zones.discardPile.includes(cardId))
      delete b82(host.state).bizuoExtraTurn[ownerId]
      if (player(host.state, ownerId)?.alive && cards.length)
        host.queueSkill({ skillId: MOU_XUNYU_BIZUO, ownerId, step: 'distribute', data: { cardIds: cards } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askB82Option(host, MOU_XUNYU_BIZUO, ownerId, 'offer', '【弼佐】：是否令一名角色执行一个额外回合？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ])
      return
    }
    if (prompt.step === 'choose-target') {
      const candidates = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_XUNYU_BIZUO, ownerId, step: prompt.step, data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【弼佐】：选择执行额外回合的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'distribute') {
      const cardIds = (prompt.data.cardIds as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
      const recipientIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (!cardIds.length || !recipientIds.length) return
      host.askSkill({ skillId: MOU_XUNYU_BIZUO, ownerId, step: prompt.step, data: { cardIds }, build: (id): DistributeCardsRequest => ({
        id, kind: 'distribute-cards', playerId: ownerId, prompt: '【弼佐】：分配额外回合中非因弃置进入弃牌堆的牌',
        timeoutMs: 25_000, optional: false, cardIds, recipientIds, min: cardIds.length, max: cardIds.length,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: MOU_XUNYU_BIZUO, ownerId, step: 'choose-target', data: {} })
      return
    }
    if (resolution.step === 'choose-target') {
      const playerId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!playerId || !player(host.state, playerId)?.alive || b82(host.state).bizuoUsed?.[ownerId]) return
      b82(host.state).bizuoUsed ??= {}
      b82(host.state).bizuoUsed[ownerId] = true
      queueExtraTurn(host.state, playerId, { skillId: MOU_XUNYU_BIZUO, playerId: ownerId })
      return
    }
    if (resolution.step !== 'distribute') return
    const valid = new Set((resolution.data.cardIds as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId)))
    const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
    const destinations = new Map<CardId, PlayerId>()
    for (const assignment of assignments) {
      if (!valid.has(assignment.cardId) || destinations.has(assignment.cardId) || !player(host.state, assignment.recipientId)?.alive) continue
      destinations.set(assignment.cardId, assignment.recipientId)
    }
    const fallback = host.state.players.find((candidate) => candidate.alive)?.id
    for (const cardId of valid) if (!destinations.has(cardId) && fallback) destinations.set(cardId, fallback)
    for (const [cardId, recipientId] of destinations) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: recipientId })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: MOU_XUNYU_BIZUO }, { sourceId: ownerId, targetId: recipientId, cardIds: [cardId] })
    }
  },
})

type LishiEffectRecord = { sourceId: PlayerId; options: string[]; armedAtTurn: number }
function lishiPending(state: SanguoshaState): Record<PlayerId, LishiEffectRecord[]> {
  const memory = b82(state)
  memory.lishiPending ??= {}
  return memory.lishiPending as Record<PlayerId, LishiEffectRecord[]>
}

function hasLishiEffect(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, option: string) {
  return (lishiPending(state)[targetId] ?? []).find((entry) => entry.sourceId === sourceId && entry.options.includes(option))
}

function consumeLishiEffect(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, option: string) {
  const pending = lishiPending(state)[targetId] ?? []
  const index = pending.findIndex((entry) => entry.sourceId === sourceId && entry.options.includes(option))
  if (index < 0) return
  const record = pending[index]
  record.options = record.options.filter((value) => value !== option)
  if (!record.options.length) pending.splice(index, 1)
  if (!pending.length) delete lishiPending(state)[targetId]
}

function applyLishi(host: SkillHost, ownerId: PlayerId, optionIds: string[]) {
  const selected = [...new Set(optionIds)].filter((id) => LISHI_OPTION_IDS.includes(id as typeof LISHI_OPTION_IDS[number]))
  const owner = player(host.state, ownerId)
  if (!owner || !selected.length) return
  owner.marks['凛'] = Math.max(0, (owner.marks['凛'] ?? 0) - selected.length)
  if (!owner.marks['凛']) delete owner.marks['凛']
  for (const target of host.state.players) {
    if (!target.alive || target.id === ownerId) continue
    const pending = lishiPending(host.state)
    pending[target.id] ??= []
    pending[target.id].push({ sourceId: ownerId, options: [...selected], armedAtTurn: host.state.turnNumber })
    if (selected.includes('1')) suppressSkill(host.state, {
      targetId: target.id, scope: 'non-locked', sourceId: ownerId, sourceSkillId: SHEN_ZHONGHUI_LISHI,
      expiresAt: 'turn-end', armedAtTurn: host.state.turnNumber,
    })
  }
}

registerSkillRuntime({ id: SHEN_ZHONGHUI_LISHI,
  globallyProhibitsCardUse(state, ownerId, targetId, cardId) {
    if (state.currentPlayerId !== targetId || state.phase !== 'play') return false
    const pending = hasLishiEffect(state, ownerId, targetId, '4')
    if (!pending || state.turnNumber <= pending.armedAtTurn) return false
    const category = state.cards[cardId]?.category
    const used = b82(state).lishiUsedCategories?.[targetId] as { turn: number; categories: string[] } | undefined
    return Boolean(category && used?.turn === state.turnNumber && used.categories.includes(category))
  },
  globallyRedirectsDiscardPhaseCard(state, ownerId, targetId) {
    const pending = hasLishiEffect(state, ownerId, targetId, '5')
    return state.phase === 'discard' && state.currentPlayerId === targetId && pending
      && state.turnNumber > pending.armedAtTurn ? ownerId : null
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
      const pending = playerId && phase === 'play' ? hasLishiEffect(host.state, ownerId, playerId, '4') : undefined
      if (!playerId || !pending || host.state.turnNumber <= pending.armedAtTurn) return
      b82(host.state).lishiUsedCategories ??= {}
      b82(host.state).lishiUsedCategories[playerId] = { turn: host.state.turnNumber, categories: [] }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'finish') {
        const owner = player(host.state, ownerId)
        if (!owner?.alive || !owner.awakenedSkills.includes(SHEN_ZHONGHUI_JIANGHUO)) return
        if (!(owner.marks['凛'] ?? 0)) {
          resolveDamage(host as never, { sourceId: ownerId, targetId: ownerId, amount: 1, nature: 'thunder', cardName: '立世' })
          return
        }
        host.queueSkill({ skillId: SHEN_ZHONGHUI_LISHI, ownerId, step: 'choose-effects', data: { max: Math.min(5, owner.marks['凛']) } })
      }
      if (payload.phase === 'discard' && payload.playerId) {
        const pending = hasLishiEffect(host.state, ownerId, payload.playerId, '5')
        if (pending && host.state.turnNumber > pending.armedAtTurn) consumeLishiEffect(host.state, ownerId, payload.playerId, '5')
      }
      if (payload.phase === 'play' && payload.playerId) {
        const used = b82(host.state).lishiUsedCategories as Record<PlayerId, unknown> | undefined
        if (used) delete used[payload.playerId]
        const pending = hasLishiEffect(host.state, ownerId, payload.playerId, '4')
        if (pending && host.state.turnNumber > pending.armedAtTurn) consumeLishiEffect(host.state, ownerId, payload.playerId, '4')
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      const pending = targetId ? hasLishiEffect(host.state, ownerId, targetId, '1') : undefined
      if (targetId && pending && host.state.turnNumber > pending.armedAtTurn) consumeLishiEffect(host.state, ownerId, targetId, '1')
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const targetId = context.event.sourceId
      if (!targetId || host.state.currentPlayerId !== targetId || host.state.phase !== 'play') return
      const { cardId } = context.event.payload as { cardId?: CardId }
      const category = cardId ? host.state.cards[cardId]?.category : undefined
      const pending = hasLishiEffect(host.state, ownerId, targetId, '4')
      if (!category || !pending || host.state.turnNumber <= pending.armedAtTurn) return
      b82(host.state).lishiUsedCategories ??= {}
      const previous = b82(host.state).lishiUsedCategories[targetId] as { turn: number; categories: string[] } | undefined
      const categories = previous?.turn === host.state.turnNumber ? previous.categories : []
      b82(host.state).lishiUsedCategories[targetId] = { turn: host.state.turnNumber, categories: [...new Set([...categories, category])] }
    } },
    { event: 'DrawPhaseResolved', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const pending = targetId ? hasLishiEffect(host.state, ownerId, targetId, '3') : undefined
      if (!targetId || !pending || host.state.turnNumber <= pending.armedAtTurn) return
      const cardIds = (context.event.payload as { cardIds?: CardId[] }).cardIds ?? []
      const colors = cardIds.map((id) => effectiveCardColor(host.state, targetId, id))
      if (colors.length > 0 && colors.every((color) => color !== null && color === colors[0]))
        discardCardsByIds(host as never, targetId, cardIds, SHEN_ZHONGHUI_LISHI)
      consumeLishiEffect(host.state, ownerId, targetId, '3')
    } },
    { event: 'JudgePhase', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const pending = targetId ? hasLishiEffect(host.state, ownerId, targetId, '2') : undefined
      if (!targetId || !pending || host.state.turnNumber <= pending.armedAtTurn) return
      context.cancel()
      host.queueSkill({ skillId: SHEN_ZHONGHUI_LISHI, ownerId, step: 'choose-judgments', data: { targetId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-effects') {
      const max = Math.min(Number(prompt.data.max), player(host.state, ownerId)?.marks['凛'] ?? 0)
      if (max <= 0) return
      host.askSkill({ skillId: SHEN_ZHONGHUI_LISHI, ownerId, step: prompt.step, data: {}, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: '【立世】：移去等量“凛”，选择互不重复的效果',
        timeoutMs: 25_000, optional: true, options: [
          { id: '1', label: '下个准备阶段和结束阶段非锁定技失效' },
          { id: '2', label: '下个判定阶段依次判定三种延时锦囊中的两种' },
          { id: '3', label: '下个摸牌阶段若摸到的牌颜色相同，则全部弃置' },
          { id: '4', label: '下个出牌阶段每种类型的手牌限使用一张' },
          { id: '5', label: '下个弃牌阶段弃置的牌改为由你获得' },
        ], min: 0, max,
      }) })
      return
    }
    if (prompt.step === 'choose-judgments') {
      const targetId = prompt.data.targetId as PlayerId
      if (!player(host.state, targetId)?.alive) return
      host.askSkill({ skillId: SHEN_ZHONGHUI_LISHI, ownerId, step: prompt.step, data: { targetId }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: targetId, prompt: '【立世】：选择依次判定的两种延时锦囊',
        timeoutMs: 25_000, optional: false, options: LISHI_TRICKS.map((name) => ({ id: name, label: name })), min: 2, max: 2,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-effects') {
      applyLishi(host, ownerId, (response.payload as { optionIds?: string[] }).optionIds ?? [])
      return
    }
    if (resolution.step === 'choose-judgments') {
      const targetId = resolution.data.targetId as PlayerId
      const target = player(host.state, targetId)
      const tricks = (response.payload as { optionIds?: string[] }).optionIds ?? []
      if (!target?.alive || tricks.length !== 2 || tricks.some((name) => !LISHI_TRICKS.includes(name as typeof LISHI_TRICKS[number]))) return
      for (const cardName of tricks) {
        // 已有同名延时锦囊仍会在本阶段结算；不重复塞入判定区。
        const exists = target.zones.judgingArea.some((cardId) => host.state.cards[cardId]?.name === cardName)
        if (!exists) host.beginVirtualDelayedTrick({ sourceId: ownerId, targetId, cardName, sourceSkillId: SHEN_ZHONGHUI_LISHI })
      }
      consumeLishiEffect(host.state, ownerId, targetId, '2')
      host.resumePhaseEntry()
    }
  },
})

registerSkillRuntime({ id: ZHUGEJUN_GUMAI,
  triggers: [{ event: 'BeforeDamage', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId ?? null
    const targetId = context.event.targetId
    if (sourceId !== ownerId && targetId !== ownerId) return
    const owner = player(host.state, ownerId)
    const round = host.state.roundNumber ?? 1
    if (!owner?.alive || b82(host.state).gumaiUsedRound?.[ownerId] === round || host.state.pendingDamageModifier) return
    const payload = context.event.payload as { amount?: number; cardId?: CardId | null; cardName?: string | null; redirectedBy?: string | null; chainTransfer?: boolean }
    const amount = Number(payload.amount ?? 0)
    if (amount <= 0) return
    const side = targetId === ownerId ? 'target' : 'source'
    const hand = [...owner.zones.hand]
    host.dispatch('SkillActivated', { skillId: ZHUGEJUN_GUMAI, playerId: ownerId, revealCardIds: hand,
      logText: `【孤脉】：展示${hand.length}张手牌` }, { sourceId: ownerId, cardIds: hand })
    context.cancel()
    const damage = { targetId: targetId!, sourceId, amount, nature: context.event.damageNature ?? 'normal',
      cardId: payload.cardId ?? null, cardName: payload.cardName ?? null, redirectedBy: payload.redirectedBy ?? null,
      chainTransfer: Boolean(payload.chainTransfer), side, round }
    host.state.pendingDamageModifier = { side, skillId: ZHUGEJUN_GUMAI, options: damage }
    host.askSkill({ skillId: ZHUGEJUN_GUMAI, ownerId, step: 'modify', data: damage, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【孤脉】：是否令此伤害${side === 'source' ? '+1' : '-1'}？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'modify' && resolution.step !== 'reset') return
    const data = resolution.data as { targetId: PlayerId; sourceId: PlayerId | null; amount: number; nature: DamageNature;
      cardId: CardId | null; cardName: string | null; redirectedBy: string | null; chainTransfer: boolean; side: 'source' | 'target'; round: number }
    const owner = player(host.state, ownerId)
    const pending = host.state.pendingDamageModifier
    const finalize = (modified: boolean) => {
      host.state.pendingDamageModifier = undefined
      if (modified) {
        b82(host.state).gumaiUsedRound ??= {}
        b82(host.state).gumaiUsedRound[ownerId] = data.round
      }
      const target = player(host.state, data.targetId)
      if (target?.alive) finalizeDamage(host as never, target as never, data.sourceId, Math.max(0, data.amount + (modified ? (data.side === 'source' ? 1 : -1) : 0)),
        data.nature, data.cardId, data.cardName, data.redirectedBy, data.chainTransfer)
      host.resumeAfterDying()
    }
    if (!pending || pending.skillId !== ZHUGEJUN_GUMAI) return
    if (resolution.step === 'modify') {
      const modified = (response.payload as { optionId?: string }).optionId === 'yes'
      if (!modified || !owner?.alive) { finalize(false); return }
      const hand = owner.zones.hand
      const suits = new Set(hand.map((cardId) => effectiveCardSuit(host.state, ownerId, cardId)))
      if (hand.length > 0 && suits.size === 1 && hand.length > 0) {
        host.askSkill({ skillId: ZHUGEJUN_GUMAI, ownerId, step: 'reset', data: { ...data, modified }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【孤脉】：手牌花色相同，可弃置一张手牌令本轮发动次数重置',
          timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: 0, max: 1,
        }) })
        return
      }
      finalize(true)
      return
    }
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = selected.filter((cardId) => owner?.zones.hand.includes(cardId))
    if (valid.length) {
      discardCardsByIds(host as never, ownerId, [valid[0]], ZHUGEJUN_GUMAI)
      const marks = b82(host.state).gumaiUsedRound as Record<PlayerId, number> | undefined
      if (marks) delete marks[ownerId]
      finalize(true)
      return
    }
    finalize(true)
  },
})

registerSkillRuntime({ id: ZHUGEJUN_GENGDU,
  handLimitExempt(state, ownerId, cardId) {
    const locked = b82(state).gengduLockedCards?.[ownerId] as { turn: number; cardIds: CardId[] } | undefined
    return locked?.turn === state.turnNumber && locked.cardIds.includes(cardId)
  },
  viewAs(state, ownerId): ViewAsOption[] {
    const branch = b82(state).gengduBranch?.[ownerId] as { turn: number; phaseId: string; color: 'red' | 'black'; limit: number; used: number } | undefined
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || branch?.color !== 'red'
      || branch.turn !== state.turnNumber || branch.used >= branch.limit) return []
    const alreadyUsed = new Set((state.cardUseHistory ?? []).filter((entry) => entry.sourceId === ownerId && entry.turnNumber === state.turnNumber)
      .map((entry) => entry.cardName))
    return (player(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => {
      if (effectiveCardColor(state, ownerId, cardId) !== 'red') return []
      return GENGDU_TRICKS.filter((name) => !alreadyUsed.has(name)).map((asCardName) => ({
        asCardName, cardId, label: `耕读：红色牌当【${asCardName}】使用`,
      }))
    })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const { playerId, phase } = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (playerId !== ownerId || phase !== 'play') return
      host.queueSkill({ skillId: ZHUGEJUN_GENGDU, ownerId, step: 'offer', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const branch = b82(host.state).gengduBranch?.[ownerId] as { turn: number; color: string; limit: number; used: number } | undefined
      if (!branch || branch.turn !== host.state.turnNumber || branch.color !== 'black' || branch.used >= branch.limit
        || !payload.cardId || effectiveCardColor(host.state, ownerId, payload.cardId) !== 'black') return
      branch.used += 1
      const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data)) as CardId[]
      b82(host.state).gengduLockedCards ??= {}
      const existing = b82(host.state).gengduLockedCards[ownerId] as { turn: number; cardIds: CardId[] } | undefined
      const cardIds = existing?.turn === host.state.turnNumber ? existing.cardIds : []
      const lockedIds = [...new Set([...cardIds, ...drawn])]
      b82(host.state).gengduLockedCards[ownerId] = { turn: host.state.turnNumber, cardIds: lockedIds }
      for (const cardId of drawn) lockCardId(host.state, { targetId: ownerId, cardId, sourceId: ownerId, skillId: ZHUGEJUN_GENGDU })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== ZHUGEJUN_GENGDU) return
      const branch = b82(host.state).gengduBranch?.[ownerId] as { turn: number; phaseId: string; color: string; limit: number; used: number } | undefined
      if (!branch || branch.turn !== host.state.turnNumber || branch.color !== 'red' || branch.used >= branch.limit) return
      branch.used += 1
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      delete b82(host.state).gengduBranch?.[ownerId]
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      if (turnPlayerId !== ownerId) return
      host.state.cardIdLocks = (host.state.cardIdLocks ?? []).filter((entry) => !(entry.sourceId === ownerId && entry.skillId === ZHUGEJUN_GENGDU))
      delete b82(host.state).gengduLockedCards?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      if (!host.state.zones.drawPile.length && !host.state.zones.discardPile.length) return
      askB82Option(host, ZHUGEJUN_GENGDU, ownerId, 'offer', '是否发动【耕读】，亮出牌堆顶四张牌？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ])
      return
    }
    if (prompt.step === 'choose-color') {
      const revealed = prompt.data.cardIds as CardId[]
      const colors = [...new Set(revealed.map((cardId) => host.state.cards[cardId]?.color).filter((color): color is 'red' | 'black' => color === 'red' || color === 'black'))]
      if (!colors.length) {
        for (const cardId of revealed) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
        return
      }
      host.askSkill({ skillId: ZHUGEJUN_GENGDU, ownerId, step: 'choose-color', data: { cardIds: revealed }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【耕读】：选择获得一种颜色的牌', timeoutMs: 25_000,
        optional: false, options: colors.map((color) => ({ id: color, label: color === 'red' ? '红色' : '黑色' })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const cardIds = revealTopCards(host.state, host.rng, 4, ZHUGEJUN_GENGDU, (name, data) => host.dispatch(name, data)) as CardId[]
      if (!cardIds.length) return
      host.queueSkill({ skillId: ZHUGEJUN_GENGDU, ownerId, step: 'choose-color', data: { cardIds } })
      return
    }
    if (resolution.step !== 'choose-color') return
    const cardIds = resolution.data.cardIds as CardId[]
    const color = (response.payload as { optionId?: string }).optionId
    if (color !== 'red' && color !== 'black') return
    const gained = cardIds.filter((cardId) => host.state.zones.processingArea.includes(cardId) && host.state.cards[cardId]?.color === color)
    const remaining = cardIds.filter((cardId) => host.state.zones.processingArea.includes(cardId) && !gained.includes(cardId))
    for (const cardId of gained) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: ZHUGEJUN_GENGDU }, { targetId: ownerId, cardIds: gained })
    for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    const phaseId = `gengdu-${host.state.turnNumber}-${host.state.seq}`
    b82(host.state).gengduBranch ??= {}
    b82(host.state).gengduBranch[ownerId] = { turn: host.state.turnNumber, phaseId, color, limit: remaining.length, used: 0 }
  },
})

registerSkillRuntime({ id: XING_ZHANGRANG_DUHAI,
  triggers: [
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
      const sourceId = context.event.sourceId
      if (!player(host.state, sourceId)?.alive) return
      host.queueSkill({ skillId: XING_ZHANGRANG_DUHAI, ownerId, step: 'ask', data: { sourceId } })
    } },
    { event: 'TurnEnd', handle(host, _ownerId, context) {
      const targetId = context.event.sourceId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive) return
      let hpLoss = 0
      for (const suit of SUITS) {
        const markKey = `${DUHAI_MARK_PREFIX}${suit}`
        const markCount = target.marks[markKey] ?? 0
        if (!markCount) continue
        const count = target.zones.hand.filter((cardId) => effectiveCardSuit(host.state, target.id, cardId) === suit).length
        if (count > 0) {
          hpLoss += markCount
          delete target.marks[markKey]
        }
      }
      if (hpLoss > 0) loseHp(host as never, target.id, hpLoss, XING_ZHANGRANG_DUHAI)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const sourceId = prompt.data.sourceId as PlayerId
      if (!player(host.state, sourceId)?.alive) return
      askB82Option(host, XING_ZHANGRANG_DUHAI, ownerId, 'ask', '是否发动【蠹害】，令此牌使用者获得一种花色的“蠹”？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ], { sourceId })
    } else if (prompt.step === 'suit') {
      askB82Option(host, XING_ZHANGRANG_DUHAI, ownerId, 'suit', '【蠹害】：选择“蠹”的花色',
        SUITS.map((suit) => ({ id: suit, label: SUIT_LABELS[suit] })),
        prompt.data, false)
    }
  },
  resume(host, ownerId, resolution, response) {
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'ask') {
      const sourceId = resolution.data.sourceId as PlayerId
      if (optionId === 'yes' && player(host.state, sourceId)?.alive)
        host.queueSkill({ skillId: XING_ZHANGRANG_DUHAI, ownerId, step: 'suit', data: { sourceId } })
      return
    }
    if (resolution.step === 'suit' && SUITS.includes(optionId as Suit)) {
      const source = player(host.state, resolution.data.sourceId as PlayerId)
      if (source?.alive) {
        const key = `${DUHAI_MARK_PREFIX}${optionId}`
        source.marks[key] = (source.marks[key] ?? 0) + 1
      }
    }
  },
})

registerSkillRuntime({ id: XING_ZHANGRANG_LINGSE,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || usedThisPhase(state, ownerId, XING_ZHANGRANG_LINGSE) || owner.zones.hand.length === 0) return []
    return state.players.some((target) => target.alive && target.id !== ownerId)
      ? [{ id: XING_ZHANGRANG_LINGSE, label: '令色：交给一名角色一张牌' }] : []
  },
  invokeActive(host, ownerId) {
    if (usedThisPhase(host.state, ownerId, XING_ZHANGRANG_LINGSE)) return
    const candidates = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
    if (!candidates.length || !(player(host.state, ownerId)?.zones.hand.length)) return
    markUsedThisPhase(host.state, ownerId, XING_ZHANGRANG_LINGSE)
    host.askSkill({ skillId: XING_ZHANGRANG_LINGSE, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【令色】：选择一名其他角色', timeoutMs: 25_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const pending = b82(host.state).lingseShortage?.[ownerId] as { attackerId: PlayerId; hit?: boolean } | undefined
      if (pending && context.event.sourceId === pending.attackerId && context.event.targetId === ownerId
        && (context.event.payload as { cardName?: string }).cardName === '杀'
        && Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) > 0) pending.hit = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const pending = b82(host.state).lingseShortage?.[ownerId] as { hit?: boolean } | undefined
      if (!pending || context.event.sourceSkillId !== XING_ZHANGRANG_LINGSE_SLASH) return
      if (pending.hit) clearUsedThisPhase(host.state, ownerId, XING_ZHANGRANG_LINGSE)
      delete b82(host.state).lingseShortage[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'give') {
      const targetId = prompt.data.targetId as PlayerId
      const owner = player(host.state, ownerId)
      const target = player(host.state, targetId)
      if (!owner?.alive || !target?.alive || !owner.zones.hand.length) return
      host.askSkill({ skillId: XING_ZHANGRANG_LINGSE, ownerId, step: 'give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【令色】：选择交给其的一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive)
        host.queueSkill({ skillId: XING_ZHANGRANG_LINGSE, ownerId, step: 'give', data: { targetId } })
      return
    }
    if (resolution.step !== 'give') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = player(host.state, ownerId)
    const target = player(host.state, targetId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!owner?.alive || !target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    const category = host.state.cards[cardId]?.category
    if (!category || giveCards(host as never, ownerId, targetId, [cardId], XING_ZHANGRANG_LINGSE).length !== 1) return
    const matching = target.zones.hand.filter((candidate) => host.state.cards[candidate]?.category === category)
    if (matching.length >= 2) {
      const gained = host.rng.shuffle(matching).slice(0, 2)
      const received = giveCards(host as never, targetId, ownerId, gained, XING_ZHANGRANG_LINGSE)
      if (received.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: received, reason: XING_ZHANGRANG_LINGSE }, { sourceId: targetId, targetId: ownerId, cardIds: received })
      return
    }
    b82(host.state).lingseShortage ??= {}
    b82(host.state).lingseShortage[ownerId] = { attackerId: targetId, hit: false }
    const began = host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: XING_ZHANGRANG_LINGSE_SLASH, countUsage: true })
    if (!began) delete b82(host.state).lingseShortage[ownerId]
  },
})

registerSkillRuntime({ id: LE_CAIYONG_JIAOWEI,
  onGameStart(host, ownerId) {
    const held = [...(player(host.state, ownerId)?.zones.hand ?? [])]
    b82(host.state).jiaoweiStrings ??= {}
    b82(host.state).jiaoweiStrings[ownerId] = held
  },
  handLimitExempt(state, ownerId, cardId) {
    return ((b82(state).jiaoweiStrings?.[ownerId] as CardId[] | undefined) ?? []).includes(cardId)
  },
  preventsDamage(state, ownerId, side) {
    return side === 'target' && b82(state).jiaoweiPreventTurn?.[ownerId] === state.turnNumber
  },
  onDamagePrevented(host, ownerId, side, _context: DamagePreventionContext) {
    if (side !== 'target') return
    const prevents = b82(host.state).jiaoweiPreventTurn as Record<PlayerId, number> | undefined
    if (prevents) delete prevents[ownerId]
  },
  triggers: [{ event: 'HandCardLeft', handle(host, ownerId, context) {
    const movement = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
    if (movement.playerId !== ownerId || !movement.cardId) return
    const strings = (b82(host.state).jiaoweiStrings?.[ownerId] as CardId[] | undefined) ?? []
    if (!strings.includes(movement.cardId)) return
    b82(host.state).jiaoweiStrings[ownerId] = strings.filter((id) => id !== movement.cardId)
    b82(host.state).jiaoweiPreventTurn ??= {}
    b82(host.state).jiaoweiPreventTurn[ownerId] = host.state.turnNumber
  } }],
})

function addJiaoweiStrings(state: SanguoshaState, ownerId: PlayerId, ids: CardId[]) {
  if (!ids.length) return
  b82(state).jiaoweiStrings ??= {}
  const existing = b82(state).jiaoweiStrings[ownerId] as CardId[] | undefined
  b82(state).jiaoweiStrings[ownerId] = [...new Set([...(existing ?? []), ...ids])]
}

function resolveFeibaiFallback(host: SkillHost, ownerId: PlayerId) {
  const drawn = drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload)) as CardId[]
  addJiaoweiStrings(host.state, ownerId, drawn)
  b82(host.state).feibaiDisabledTurn ??= {}
  b82(host.state).feibaiDisabledTurn[ownerId] = host.state.turnNumber
}

registerSkillRuntime({ id: LE_CAIYONG_FEIBAI,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || b82(host.state).feibaiDisabledTurn?.[ownerId] === host.state.turnNumber) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    if (!payload.cardId || !payload.cardName) return
    const history = host.state.cardUseHistory ?? []
    const previous = history.slice(0, -1).reverse().find((entry) => entry.sourceId === ownerId && entry.turnNumber === host.state.turnNumber)
    const amount = [...payload.cardName].length + (previous ? [...previous.cardName].length : 0)
    host.queueSkill({ skillId: LE_CAIYONG_FEIBAI, ownerId, step: 'offer', data: { amount } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      askB82Option(host, LE_CAIYONG_FEIBAI, ownerId, 'offer', '是否发动【飞白】？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ], { amount: Number(prompt.data.amount) })
      return
    }
    if (prompt.step === 'choose-card') {
      const records = b82(host.state).feibaiPending?.[ownerId] as Array<{ cardId: CardId; index: number }> | undefined
      const cardIds = records?.map((record) => record.cardId).filter((cardId) => host.state.zones.processingArea.includes(cardId)) ?? []
      if (!cardIds.length) { resolveFeibaiFallback(host, ownerId); return }
      host.askSkill({ skillId: LE_CAIYONG_FEIBAI, ownerId, step: 'choose-card', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【飞白】：选择获得一张展示的牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const amount = Math.max(1, Number(resolution.data.amount))
      // 【飞白】的牌源是牌堆；弃牌堆里的同名牌不能混入随机候选。
      const pool = host.state.zones.drawPile.map((cardId, index) => ({ cardId, index }))
        .filter(({ cardId }) => !host.state.cards[cardId]?.virtual && [...(host.state.cards[cardId]?.name ?? '')].length === amount)
      const chosen = host.rng.shuffle(pool).slice(0, 2)
      if (!chosen.length) { resolveFeibaiFallback(host, ownerId); return }
      b82(host.state).feibaiPending ??= {}
      b82(host.state).feibaiPending[ownerId] = chosen
      for (const record of chosen) moveCard(host.state, record.cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
      host.dispatch('CardMove', { cardIds: chosen.map((record) => record.cardId), reason: LE_CAIYONG_FEIBAI, revealed: true }, { cardIds: chosen.map((record) => record.cardId) })
      host.queueSkill({ skillId: LE_CAIYONG_FEIBAI, ownerId, step: 'choose-card', data: {} })
      return
    }
    if (resolution.step !== 'choose-card') return
    const records = (b82(host.state).feibaiPending?.[ownerId] as Array<{ cardId: CardId; index: number }> | undefined) ?? []
    const pickedId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const picked = records.find((record) => record.cardId === pickedId && host.state.zones.processingArea.includes(record.cardId))
    if (picked && player(host.state, ownerId)?.alive) {
      moveCard(host.state, picked.cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked.cardId], reason: LE_CAIYONG_FEIBAI }, { targetId: ownerId, cardIds: [picked.cardId] })
    } else resolveFeibaiFallback(host, ownerId)
    for (const record of records) {
      if (record.cardId === picked?.cardId || !host.state.zones.processingArea.includes(record.cardId)) continue
      moveCard(host.state, record.cardId, { kind: 'processingArea' }, { kind: 'drawPile' },
        { toIndex: Math.min(record.index, host.state.zones.drawPile.length) })
    }
    delete b82(host.state).feibaiPending?.[ownerId]
  },
})

function grantDuzhang(host: SkillHost, ownerId: PlayerId) {
  if (!player(host.state, ownerId)?.alive || usedThisTurn(host.state, ownerId, SHEN_ZHONGHUI_DUZHANG)) return
  markUsedThisTurn(host.state, ownerId, SHEN_ZHONGHUI_DUZHANG)
  const owner = player(host.state, ownerId)!
  owner.marks['凛'] = (owner.marks['凛'] ?? 0) + 1
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
}

registerSkillRuntime({ id: SHEN_ZHONGHUI_DUZHANG,
  maxCardsBonus(state, ownerId) { return player(state, ownerId)?.marks['凛'] ?? 0 },
  triggers: [
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      if (!payload.cardId || (payload.targetIds?.length ?? 0) !== 1
        || effectiveCardColor(host.state, ownerId, payload.cardId) !== 'black') return
      grantDuzhang(host, ownerId)
    } },
    { event: 'TargetConfirmed', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || context.event.sourceId === ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      if (!payload.cardId || cardUseTargetsOf(host.state, payload.cardId)?.targetIds.length !== 1
        || effectiveCardColor(host.state, context.event.sourceId!, payload.cardId) !== 'black') return
      grantDuzhang(host, ownerId)
    } },
  ],
})

registerSkillRuntime({ id: SHEN_ZHONGHUI_JIANGHUO,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive || owner.awakenedSkills.includes(SHEN_ZHONGHUI_JIANGHUO)
      || !host.state.players.every((entry) => entry.hasTakenDamage === true)) return
    owner.awakenedSkills.push(SHEN_ZHONGHUI_JIANGHUO)
    let transferred = 0
    for (const role of host.state.players) {
      const count = role.marks['凛'] ?? 0
      transferred += count
      if (role.id !== ownerId) delete role.marks['凛']
    }
    if (transferred > 0) owner.marks['凛'] = transferred
    owner.permanentlyLostSkills ??= []
    if (!owner.permanentlyLostSkills.includes(SHEN_ZHONGHUI_LINJIE))
      owner.permanentlyLostSkills.push(SHEN_ZHONGHUI_LINJIE)
    grantSkill(host.state, ownerId, SHEN_ZHONGHUI_LISHI)
    gainMaxHp(host as never, ownerId, 1, SHEN_ZHONGHUI_JIANGHUO)
    if (transferred > 0) drawCards(host.state, host.rng, ownerId, transferred, (name, payload) => host.dispatch(name, payload))
    host.dispatch('SkillAwakened', { playerId: ownerId, skillId: SHEN_ZHONGHUI_JIANGHUO, skillName: '降祸' }, { sourceId: ownerId })
  } }],
})

registerSkillRuntime({ id: SHEN_ZHONGHUI_LINJIE,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const owner = player(host.state, ownerId)
      const round = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber)
      if (!owner?.alive || b82(host.state).linjieRoundUsed?.[ownerId] === round) return
      b82(host.state).linjieRoundUsed ??= {}
      b82(host.state).linjieRoundUsed[ownerId] = round
      host.queueSkill({ skillId: SHEN_ZHONGHUI_LINJIE, ownerId, step: 'offer', data: {} })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const target = targetId ? player(host.state, targetId) : undefined
      if (!targetId || !target?.alive || targetId === ownerId || !(target.marks['凛'] ?? 0)
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      const hand = [...target.zones.hand]
      if (!hand.length) return
      const [discarded] = host.rng.shuffle(hand).slice(0, 1)
      if (!discarded) return
      discardCardsByIds(host as never, targetId, [discarded], SHEN_ZHONGHUI_LINJIE)
      if (target.zones.hand.length === 0) {
        delete target.marks['凛']
        if (target.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '凛界' })
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId && !(entry.marks['凛'] ?? 0))
      if (!candidates.length) return
      askB82Option(host, SHEN_ZHONGHUI_LINJIE, ownerId, 'offer', '【凛界】：是否选择一名没有“凛”的角色并对其造成1点伤害？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ])
    } else if (prompt.step === 'target') {
      const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId && !(entry.marks['凛'] ?? 0)).map((entry) => entry.id)
      if (!candidates.length) return
      host.askSkill({ skillId: SHEN_ZHONGHUI_LINJIE, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【凛界】：选择一名没有“凛”的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId === 'yes')
        host.queueSkill({ skillId: SHEN_ZHONGHUI_LINJIE, ownerId, step: 'target', data: {} })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!targetId || !target?.alive || (target.marks['凛'] ?? 0)) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '凛界' })
      if (target.alive) target.marks['凛'] = (target.marks['凛'] ?? 0) + 1
    }
  },
})

registerSkillRuntime({ id: MOU_CAO_HONG_YINGJIA,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { targetIds?: PlayerId[] }
    const targets = (payload.targetIds ?? []).filter((id) => id !== ownerId && player(host.state, id)?.alive)
    if (!targets.length) return
    for (const targetId of targets) {
      forceDistance(host.state, { fromId: ownerId, toId: targetId, distance: 1, sourceSkillId: MOU_CAO_HONG_YINGJIA })
      forceDistance(host.state, { fromId: targetId, toId: ownerId, distance: 1, sourceSkillId: MOU_CAO_HONG_YINGJIA })
    }
    if (!host.state.players.filter((entry) => entry.alive && entry.id !== ownerId)
      .every((entry) => getDistance(host.state, ownerId, entry.id) === 1)) return
    const record = b82(host.state).yingjiaUsed?.[ownerId] as { turn: number; targetIds: PlayerId[] } | undefined
    const used = record?.turn === host.state.turnNumber ? record.targetIds : []
    const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId && entry.zones.hand.length > 0
      && !used.includes(entry.id)).map((entry) => entry.id)
    if (candidates.length) host.queueSkill({ skillId: MOU_CAO_HONG_YINGJIA, ownerId, step: 'choose-target', data: { candidates } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-target') {
      const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => {
        const target = player(host.state, id)
        return target?.alive && target.zones.hand.length > 0
      })
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_CAO_HONG_YINGJIA, ownerId, step: 'choose-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【迎驾】：选择获得其所有手牌的角色', timeoutMs: 25_000,
        optional: true, candidateIds: candidates, min: 0, max: 1,
      }) })
      return
    }
    if (prompt.step === 'return-cards') {
      const targetId = prompt.data.targetId as PlayerId
      const count = Number(prompt.data.count)
      const hand = player(host.state, ownerId)?.zones.hand ?? []
      const actual = Math.min(count, hand.length)
      if (!player(host.state, targetId)?.alive || actual === 0) return
      host.askSkill({ skillId: MOU_CAO_HONG_YINGJIA, ownerId, step: 'return-cards', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【迎驾】：交给该角色${actual}张手牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: actual, max: actual,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!targetId || !target?.alive || target.zones.hand.length === 0) return
      const record = b82(host.state).yingjiaUsed?.[ownerId] as { turn: number; targetIds: PlayerId[] } | undefined
      const targetIds = record?.turn === host.state.turnNumber ? record.targetIds : []
      if (targetIds.includes(targetId)) return
      b82(host.state).yingjiaUsed ??= {}
      b82(host.state).yingjiaUsed[ownerId] = { turn: host.state.turnNumber, targetIds: [...targetIds, targetId] }
      const gained = giveCards(host as never, targetId, ownerId, [...target.zones.hand], MOU_CAO_HONG_YINGJIA)
      if (gained.length) host.queueSkill({ skillId: MOU_CAO_HONG_YINGJIA, ownerId, step: 'return-cards', data: { targetId, count: gained.length } })
      return
    }
    if (resolution.step === 'return-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = player(host.state, ownerId)
      if (owner?.alive && player(host.state, targetId)?.alive)
        giveCards(host as never, ownerId, targetId, ids.filter((cardId) => owner.zones.hand.includes(cardId)), MOU_CAO_HONG_YINGJIA)
    }
  },
})

function queueXianjuTarget(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number, gained: number) {
  const nextIndex = targetIds.findIndex((id, candidateIndex) => candidateIndex >= index && pickableCardsOf(host.state, id).cardIds.length
    + pickableCardsOf(host.state, id).hiddenCardSlots.length > 0)
  if (nextIndex < 0) {
    b82(host.state).xianjuGained ??= {}
    b82(host.state).xianjuGained[ownerId] = gained
    return
  }
  host.queueSkill({ skillId: MOU_CAO_HONG_XIANJU, ownerId, step: 'take-one', data: { targetIds, index: nextIndex, gained } })
}

registerSkillRuntime({ id: MOU_CAO_HONG_XIANJU,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, MOU_CAO_HONG_XIANJU)) return []
    const range = getAttackRange(state, ownerId)
    const candidates = state.players.filter((entry) => entry.alive && entry.id !== ownerId
      && getDistance(state, ownerId, entry.id) <= range && pickableCardsOf(state, entry.id).cardIds.length + entry.zones.hand.length > 0)
    return candidates.length ? [{ id: MOU_CAO_HONG_XIANJU, label: '险拒：获得攻击范围内角色各一张牌' }] : []
  },
  invokeActive(host, ownerId) {
    if (usedThisPhase(host.state, ownerId, MOU_CAO_HONG_XIANJU)) return
    const range = getAttackRange(host.state, ownerId)
    const targets = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId
      && getDistance(host.state, ownerId, entry.id) <= range
      && pickableCardsOf(host.state, entry.id).cardIds.length + entry.zones.hand.length > 0).map((entry) => entry.id)
    if (!targets.length) return
    markUsedThisPhase(host.state, ownerId, MOU_CAO_HONG_XIANJU)
    b82(host.state).xianjuGained ??= {}
    b82(host.state).xianjuGained[ownerId] = 0
    queueXianjuTarget(host, ownerId, targets, 0, 0)
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'play' || !usedThisPhase(host.state, ownerId, MOU_CAO_HONG_XIANJU)
      || Number(b82(host.state).xianjuGained?.[ownerId] ?? 0) < 1) return
    const range = getAttackRange(host.state, ownerId)
    const outsideCount = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId
      && getDistance(host.state, ownerId, entry.id) > range).length
    const discardable = [...(player(host.state, ownerId)?.zones.hand ?? []),
      ...Object.values(player(host.state, ownerId)?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))]
      .filter((cardId) => !isCardProtectedFromDiscard(host.state, ownerId, cardId, ownerId))
    const count = Math.min(outsideCount, discardable.length)
    if (!count) return
    host.queueSkill({ skillId: MOU_CAO_HONG_XIANJU, ownerId, step: 'discard', data: { count, cardIds: discardable } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'take-one') {
      const targetIds = prompt.data.targetIds as PlayerId[]
      const index = Number(prompt.data.index)
      const targetId = targetIds[index]
      if (!targetId || !player(host.state, targetId)?.alive) { queueXianjuTarget(host, ownerId, targetIds, index + 1, Number(prompt.data.gained)); return }
      const pickable = pickableCardsOf(host.state, targetId)
      const available = [...pickable.cardIds, ...pickable.hiddenCardSlots]
      if (!available.length) { queueXianjuTarget(host, ownerId, targetIds, index + 1, Number(prompt.data.gained)); return }
      host.askSkill({ skillId: MOU_CAO_HONG_XIANJU, ownerId, step: 'take-one', data: { targetIds, index, gained: prompt.data.gained }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【险拒】：选择获得该角色的一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'discard') {
      const ids = prompt.data.cardIds as CardId[]
      const count = Math.min(Number(prompt.data.count), ids.length)
      host.askSkill({ skillId: MOU_CAO_HONG_XIANJU, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【险拒】：弃置${count}张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'discard-phase', cardIds: ids, hiddenCardSlots: [], min: count, max: count,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-one') {
      const targetIds = resolution.data.targetIds as PlayerId[]
      const index = Number(resolution.data.index)
      const targetId = targetIds[index]
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      let gained = Number(resolution.data.gained)
      if (targetId && picked && player(host.state, targetId)?.alive) {
        const cardId = resolvePickedCard(host.state, targetId, picked)
        const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
        if (cardId && from && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
          gained += 1
          if (from.kind === 'equipment') host.dispatch('LoseEquipment', { playerId: targetId, cardIds: [cardId], reason: MOU_CAO_HONG_XIANJU }, { targetId, cardIds: [cardId] })
          else host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: MOU_CAO_HONG_XIANJU }, { sourceId: targetId, cardIds: [cardId] })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_CAO_HONG_XIANJU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        }
      }
      queueXianjuTarget(host, ownerId, targetIds, index + 1, gained)
      return
    }
    if (resolution.step === 'discard') {
      const owner = player(host.state, ownerId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (owner) discardCardsByIds(host as never, ownerId, ids.filter((id) => (owner.zones.hand.includes(id)
        || Object.values(owner.zones.equipment).includes(id)) && !isCardProtectedFromDiscard(host.state, ownerId, id, ownerId)), MOU_CAO_HONG_XIANJU)
    }
  },
})

registerSkillRuntime({ id: CHEZHOU_SHEFU,
  outgoingDamage(state, _ownerId, context) {
    return context.cardId ? { amount: cardHandRounds(state, context.cardId) } : null
  },
  incomingDamage(state, ownerId, context) {
    return context.sourceId && context.sourceId !== ownerId && context.cardId
      ? { amount: cardHandRounds(state, context.cardId) } : null
  },
})

registerSkillRuntime({ id: CHEZHOU_PIGUA,
  handLimitExempt(state, ownerId, cardId) {
    const record = b82(state).piguaCards?.[ownerId] as { turn: number; cardIds: CardId[] } | undefined
    return record?.turn === state.turnNumber && record.cardIds.includes(cardId)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const target = targetId ? player(host.state, targetId) : undefined
    if (context.event.sourceId !== ownerId || !target?.alive || targetId === ownerId
      || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 1 || !target.zones.hand.length) return
    host.queueSkill({ skillId: CHEZHOU_PIGUA, ownerId, step: 'gain', data: { targetId,
      max: Math.min(target.zones.hand.length, Math.max(1, host.state.roundNumber ?? 1)) } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'gain') return
    const targetId = prompt.data.targetId as PlayerId
    const target = player(host.state, targetId)
    if (!target?.alive || !target.zones.hand.length) return
    const max = Math.min(Number(prompt.data.max), target.zones.hand.length)
    if (!max) return
    host.askSkill({ skillId: CHEZHOU_PIGUA, ownerId, step: 'gain', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【披挂】：获得其至多${max}张手牌`, timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: [], hiddenCardSlots: target.zones.hand.map((_, index) => hiddenHandSlot(targetId, index)), min: 0, max,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain') return
    const targetId = resolution.data.targetId as PlayerId
    const target = player(host.state, targetId)
    const selected = (response.payload as { cardIds?: string[] }).cardIds ?? []
    if (!target?.alive || !selected.length) return
    const gained: CardId[] = []
    for (const choice of selected) {
      const hiddenIndex = target.zones.hand.findIndex((_, index) => hiddenHandSlot(targetId, index) === choice)
      const cardId = hiddenIndex >= 0 ? target.zones.hand[hiddenIndex] : choice as CardId
      if (!cardId || !target.zones.hand.includes(cardId)) continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      gained.push(cardId)
    }
    if (!gained.length) return
    b82(host.state).piguaCards ??= {}
    const existing = b82(host.state).piguaCards[ownerId] as { turn: number; cardIds: CardId[] } | undefined
    const cardIds = existing?.turn === host.state.turnNumber ? existing.cardIds : []
    b82(host.state).piguaCards[ownerId] = { turn: host.state.turnNumber, cardIds: [...new Set([...cardIds, ...gained])] }
    host.dispatch('LoseCard', { playerId: targetId, cardIds: gained, reason: CHEZHOU_PIGUA }, { sourceId: targetId, cardIds: gained })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: CHEZHOU_PIGUA }, { sourceId: targetId, targetId: ownerId, cardIds: gained })
  },
})

registerSkillRuntime({ id: MOU_HULIE_YITOU,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const actorId = payload.playerId
      const owner = player(host.state, ownerId)
      const actor = actorId ? player(host.state, actorId) : undefined
      if (payload.phase !== 'play' || !actorId || actorId === ownerId || !owner?.alive || !actor?.alive
        || !owner.zones.hand.length) return
      const maxHand = Math.max(...host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.zones.hand.length))
      if (actor.zones.hand.length !== maxHand) return
      host.queueSkill({ skillId: MOU_HULIE_YITOU, ownerId, step: 'offer', data: { actorId, turn: host.state.turnNumber } })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const actorId = context.event.sourceId
      const record = b82(host.state).yitouRecipients?.[ownerId] as { actorId: PlayerId; turn: number } | undefined
      if (!record || record.actorId !== actorId || record.turn !== host.state.turnNumber
        || Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0) <= 0) return
      if (player(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const actorId = prompt.data.actorId as PlayerId
    if (!player(host.state, actorId)?.alive || !player(host.state, ownerId)?.zones.hand.length) return
    askB82Option(host, MOU_HULIE_YITOU, ownerId, 'offer', '【倚投】：是否将所有手牌交给该角色？', [
      { id: 'yes', label: '交给其所有手牌' }, { id: 'no', label: '不发动' },
    ], { actorId, turn: Number(prompt.data.turn) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'offer' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const actorId = resolution.data.actorId as PlayerId
    const owner = player(host.state, ownerId)
    if (!owner?.alive || !player(host.state, actorId)?.alive || !owner.zones.hand.length) return
    giveCards(host as never, ownerId, actorId, [...owner.zones.hand], MOU_HULIE_YITOU)
    b82(host.state).yitouRecipients ??= {}
    b82(host.state).yitouRecipients[ownerId] = { actorId, turn: Number(resolution.data.turn) }
  },
})

registerSkillRuntime({ id: MOU_HULIE_CHUANYU,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const owner = player(host.state, ownerId)
      const round = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber)
      if (!owner?.alive || !owner.zones.hand.length || !host.state.players.some((entry) => entry.alive && entry.id !== ownerId)) return
      b82(host.state).chuanyu ??= {}
      ;(b82(host.state).chuanyu as Record<PlayerId, ChuanyuState>)[ownerId] = { round, cards: [], recipients: [] }
      host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'offer', data: { round } })
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const movement = context.event.payload as { cardId?: CardId }
      const current = chuanyuState(host.state, ownerId)
      if (!movement.cardId || !host.state.zones.discardPile.includes(movement.cardId) || !current.cards.includes(movement.cardId)) return
      const candidates = host.state.players.filter((entry) => entry.alive && !current.recipients.includes(entry.id))
      if (candidates.length) host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'reassign', data: { cardId: movement.cardId, round: current.round } })
    } },
    { event: 'RoundEnd', handle(host, ownerId, context) {
      const current = chuanyuState(host.state, ownerId)
      const round = Number((context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber)
      if (current.round !== round) return
      for (const cardId of [...current.cards]) {
        const holder = host.state.players.find((entry) => locateOwnedCard(host.state, entry.id, cardId, { includeCharacterPiles: true }))
        const location = holder ? locateOwnedCard(host.state, holder.id, cardId, { includeCharacterPiles: true }) : null
        if (holder && location) {
          if (location.kind === 'hand' || location.kind === 'equipment')
            discardCardsByIds(host as never, holder.id, [cardId], MOU_HULIE_CHUANYU)
          else {
            moveCard(host.state, cardId, location, { kind: 'discardPile' }, { discardReason: 'discard' })
            host.dispatch('LoseCard', { playerId: holder.id, cardIds: [cardId], reason: MOU_HULIE_CHUANYU }, { targetId: holder.id, cardIds: [cardId] })
          }
        } else if (host.state.zones.drawPile.includes(cardId))
          moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' }, { discardReason: 'discard' })
        else if (host.state.zones.processingArea.includes(cardId))
          moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'discard' })
      }
      b82(host.state).chuanyu ??= {}
      ;(b82(host.state).chuanyu as Record<PlayerId, ChuanyuState>)[ownerId] = { round, cards: [], recipients: [...current.recipients] }
      if (player(host.state, ownerId)?.alive && current.recipients.some((id) => player(host.state, id)?.alive))
        host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'round-end-offer', data: { recipients: [...current.recipients] } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'offer', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【传舆】：选择一名角色获得“舆”', timeoutMs: 25_000,
        optional: true, candidateIds: host.state.players.filter((entry) => entry.alive && entry.id !== ownerId).map((entry) => entry.id), min: 0, max: 1,
      }) })
      return
    }
    if (prompt.step === 'card') {
      const cards = player(host.state, ownerId)?.zones.hand ?? []
      if (!cards.length) return
      host.askSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'card', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【传舆】：选择一张牌作为“舆”', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'reassign') {
      const current = chuanyuState(host.state, ownerId)
      const cardId = prompt.data.cardId as CardId
      if (!current.cards.includes(cardId) || !host.state.zones.discardPile.includes(cardId)) return
      const candidates = host.state.players.filter((entry) => entry.alive && !current.recipients.includes(entry.id)).map((entry) => entry.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'reassign', data: { cardId, round: current.round }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【传舆】：将“舆”交给一名本轮未获得过“舆”的角色', timeoutMs: 25_000,
        optional: true, candidateIds: candidates, min: 0, max: 1,
      }) })
      return
    }
    if (prompt.step === 'round-end-offer') {
      askB82Option(host, MOU_HULIE_CHUANYU, ownerId, 'round-end-offer', '【传舆】：是否令本轮获得过“舆”的角色依次对你指定的角色使用【杀】？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ], { recipients: prompt.data.recipients })
      return
    }
    if (prompt.step === 'slash-target') {
      const recipients = prompt.data.recipients as PlayerId[]
      const index = Number(prompt.data.index)
      const targetId = prompt.data.targetId as PlayerId
      const actorId = recipients[index]
      if (!actorId || !player(host.state, actorId)?.alive) {
        if (index + 1 < recipients.length) host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'slash-target', data: { recipients, index: index + 1, targetId } })
        return
      }
      if (targetId && targetId !== actorId && player(host.state, targetId)?.alive)
        host.beginVirtualSlash({ sourceId: actorId, targetId, sourceSkillId: MOU_HULIE_CHUANYU, ignoreDistance: true })
      if (index + 1 < recipients.length)
        host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'slash-target', data: { recipients, index: index + 1, targetId } })
      return
    }
    if (prompt.step === 'choose-slash-target') {
      const candidates = host.state.players.filter((entry) => entry.alive).map((entry) => entry.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'choose-slash-target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【传舆】：为本轮获得过“舆”的角色共同选择【杀】目标', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive && player(host.state, ownerId)?.zones.hand.length)
        host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'card', data: { targetId, round: Number(resolution.data.round) } })
      return
    }
    if (resolution.step === 'card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !player(host.state, targetId)?.alive || !player(host.state, ownerId)?.zones.hand.includes(cardId)) return
      const moved = giveCards(host as never, ownerId, targetId, [cardId], MOU_HULIE_CHUANYU)
      if (!moved.length) return
      const current = chuanyuState(host.state, ownerId)
      if (!current.cards.includes(cardId)) current.cards.push(cardId)
      if (!current.recipients.includes(targetId)) current.recipients.push(targetId)
      return
    }
    if (resolution.step === 'reassign') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const current = chuanyuState(host.state, ownerId)
      if (!targetId || !player(host.state, targetId)?.alive || current.round !== Number(resolution.data.round)
        || !current.cards.includes(cardId) || current.recipients.includes(targetId) || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: MOU_HULIE_CHUANYU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      current.recipients.push(targetId)
      return
    }
    if (resolution.step === 'round-end-offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const recipients = (resolution.data.recipients as PlayerId[]).filter((id) => player(host.state, id)?.alive)
      host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'choose-slash-target', data: { recipients } })
      return
    }
    if (resolution.step === 'choose-slash-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const recipients = (resolution.data.recipients as PlayerId[]).filter((id) => player(host.state, id)?.alive)
      if (targetId && player(host.state, targetId)?.alive && recipients.length)
        host.queueSkill({ skillId: MOU_HULIE_CHUANYU, ownerId, step: 'slash-target', data: { recipients, index: 0, targetId } })
    }
  },
})

registerSkillRuntime({ id: MOU_DONGCHENG_BAOJIA,
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      if (!player(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: MOU_DONGCHENG_BAOJIA, ownerId, step: 'choose-ally', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const cardId = payload.cardId
      const pending = b82(host.state).baojiaPending?.[ownerId] as CardId[] | undefined
      if (!cardId || !pending?.includes(cardId)) return
      b82(host.state).baojiaPending[ownerId] = pending.filter((id) => id !== cardId)
      const card = host.state.cards[cardId]
      if (card?.virtual || !host.state.zones.discardPile.includes(cardId) || !player(host.state, ownerId)?.alive) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_DONGCHENG_BAOJIA }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
    } },
  ],
  offersGlobalDamagePreventionAsk(host, ownerId, context) {
    const allyId = b82(host.state).baojiaAlly?.[ownerId] as PlayerId | undefined
    const targetId = context.targetId
    if (!allyId || (targetId !== ownerId && targetId !== allyId) || !context.cardId || context.chainTransfer
      || !player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive) return false
    const use = b82(host.state).baojiaUsed?.[ownerId] as { turn: number; targets: PlayerId[] } | undefined
    if (use?.turn === host.state.turnNumber && use.targets.includes(targetId)) return false
    if (!abolishableSlotsOf(host.state, ownerId).length) return false
    host.queueSkill({ skillId: MOU_DONGCHENG_BAOJIA, ownerId, step: 'prevent', data: { targetId, cardId: context.cardId, turn: host.state.turnNumber } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-ally') {
      const candidates = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId).map((entry) => entry.id)
      if (!candidates.length) return
      host.askSkill({ skillId: MOU_DONGCHENG_BAOJIA, ownerId, step: 'choose-ally', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【保驾】：选择一名其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'prevent') {
      const { targetId, cardId, turn } = prompt.data as { targetId: PlayerId; cardId: CardId; turn: number }
      if (!player(host.state, targetId)?.alive || !host.state.pendingTargetDamage || !host.state.cards[cardId]) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
      const slots = abolishableSlotsOf(host.state, ownerId)
      if (!slots.length) { resumeTargetDamagePrevention(host as never, false); return }
      host.askSkill({ skillId: MOU_DONGCHENG_BAOJIA, ownerId, step: 'prevent', data: { targetId, cardId, turn }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【保驾】：废除一个装备栏，防止此卡牌伤害', timeoutMs: 25_000,
        optional: true, options: slots.map((slot) => ({ id: slot, label: `废除${SLOT_LABELS[slot]}` })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-ally') {
      const allyId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (allyId && allyId !== ownerId && player(host.state, allyId)?.alive) {
        b82(host.state).baojiaAlly ??= {}
        b82(host.state).baojiaAlly[ownerId] = allyId
      }
      return
    }
    if (resolution.step !== 'prevent') return
    const { targetId, cardId, turn } = resolution.data as { targetId: PlayerId; cardId: CardId; turn: number }
    const slot = (response.payload as { optionId?: EquipmentSlot }).optionId
    if (!slot || !abolishableSlotsOf(host.state, ownerId).includes(slot) || !player(host.state, targetId)?.alive
      || !host.state.cards[cardId] || !host.state.pendingTargetDamage) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    const current = b82(host.state).baojiaUsed?.[ownerId] as { turn: number; targets: PlayerId[] } | undefined
    const targets = current?.turn === turn ? current.targets : []
    if (targets.includes(targetId)) { resumeTargetDamagePrevention(host as never, false); return }
    const equipped = player(host.state, ownerId)?.zones.equipment[slot]
    if (equipped) discardCardsByIds(host as never, ownerId, [equipped], MOU_DONGCHENG_BAOJIA)
    if (!abolishSlot(host.state, ownerId, slot)) { resumeTargetDamagePrevention(host as never, false); return }
    b82(host.state).baojiaUsed ??= {}
    b82(host.state).baojiaUsed[ownerId] = { turn, targets: [...targets, targetId] }
    b82(host.state).baojiaPending ??= {}
    const pending = b82(host.state).baojiaPending[ownerId] as CardId[] | undefined
    b82(host.state).baojiaPending[ownerId] = [...new Set([...(pending ?? []), cardId])]
    resumeTargetDamagePrevention(host as never, true, MOU_DONGCHENG_BAOJIA)
  },
})

function shimouMode(state: SanguoshaState, ownerId: PlayerId): 'yang' | 'yin' {
  return b82(state).shimouMode?.[ownerId] === 'yin' ? 'yin' : 'yang'
}
function shimouActionOptions(host: SkillHost, actorId: PlayerId, cardName: string, cardId: CardId) {
  const actions = instantTrickActions(host.state, actorId, cardId, cardName).filter((action) => action.kind === 'use-card')
  return actions.map((action, index) => ({
    id: `action-${index}`,
    label: action.targetIds.length ? `目标：${action.targetIds.map((id) => player(host.state, id)?.nickname ?? id).join('、')}` : `使用【${cardName}】`,
    action,
  }))
}
registerSkillRuntime({ id: MOU_XUNYU_SHIMOU,
  globalExtraTargetsForTrick(state, ownerId, actorId, _cardName, cardId) {
    const pending = b82(state).shimouTargetBonus?.[ownerId] as { actorId: PlayerId; cardId: CardId; drawn: boolean } | undefined
    return pending?.drawn && pending.actorId === actorId && pending.cardId === cardId ? 1 : 0
  },
  globalRepeatTargetEffectCount(state, ownerId, _sourceId, _targetId, cardId) {
    const record = b82(state).shimouRepeat?.[ownerId] as { cardId: CardId; repeat: boolean } | undefined
    return record?.cardId === cardId && record.repeat ? 1 : 0
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, MOU_XUNYU_SHIMOU)) return []
    return state.players.some((candidate) => candidate.alive) ? [{ id: MOU_XUNYU_SHIMOU, label: '发动【势谋】' }] : []
  },
  activeActionUsesCard: true,
  invokeActive(host, ownerId, actionId) {
    if (actionId !== MOU_XUNYU_SHIMOU || usedThisPhase(host.state, ownerId, MOU_XUNYU_SHIMOU)) return
    const mode = shimouMode(host.state, ownerId)
    const living = host.state.players.filter((entry) => entry.alive)
    const handCounts = living.map((entry) => entry.zones.hand.length)
    const edge = mode === 'yang' ? Math.min(...handCounts) : Math.max(...handCounts)
    const candidates = living.filter((entry) => entry.zones.hand.length === edge).map((entry) => entry.id)
    if (!candidates.length) return
    host.askSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'target', data: { mode }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【势谋·${mode === 'yang' ? '阳' : '阴'}】：选择手牌数${mode === 'yang' ? '全场最低' : '全场最高'}的角色`,
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'GameStart', handle(host, ownerId) {
      host.queueSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'choose-mode', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (payload.sourceSkillId !== MOU_XUNYU_SHIMOU) return
      delete b82(host.state).shimouTargetBonus?.[ownerId]
      const current = b82(host.state).shimouRepeat?.[ownerId] as { cardId: CardId } | undefined
      if (current?.cardId === payload.cardId) delete b82(host.state).shimouRepeat[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-mode') {
      host.askSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'choose-mode', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【势谋】：选择初始转换状态', timeoutMs: 25_000, optional: false,
        options: [{ id: 'yang', label: '阳：手牌数全场最低' }, { id: 'yin', label: '阴：手牌数全场最高' }],
      }) })
      return
    }
    if (prompt.step === 'adjust-discard') {
      const actorId = prompt.data.actorId as PlayerId
      const count = Number(prompt.data.count)
      const hand = player(host.state, actorId)?.zones.hand ?? []
      if (hand.length < count) return
      host.askSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'adjust-discard', data: prompt.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: `【势谋】：弃置${count}张手牌至体力上限`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: count, max: count,
      }) })
      return
    }
    if (prompt.step === 'trick-name') {
      const actorId = prompt.data.actorId as PlayerId
      const drawn = Boolean(prompt.data.drawn)
      const options = [...INSTANT_TRICKS].filter((name) => {
        const probe = createVirtualTrick(host.state, actorId, name, MOU_XUNYU_SHIMOU)
        if (drawn) { b82(host.state).shimouTargetBonus ??= {}; b82(host.state).shimouTargetBonus[ownerId] = { actorId, cardId: probe, drawn: true } }
        const legal = instantTrickActions(host.state, actorId, probe, name).length > 0
        delete b82(host.state).shimouTargetBonus?.[ownerId]
        const actor = player(host.state, actorId)
        if (actor) actor.zones.hand = actor.zones.hand.filter((id) => id !== probe)
        delete host.state.cards[probe]
        return legal
      })
      if (!player(host.state, actorId)?.alive || !options.length) return
      host.askSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'trick-name', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【势谋】：选择普通锦囊牌名', timeoutMs: 25_000, optional: false,
        options: options.map((name) => ({ id: name, label: `【${name}】` })),
      }) })
      return
    }
    if (prompt.step === 'trick-action') {
      const { actorId, cardId, cardName } = prompt.data as { actorId: PlayerId; cardId: CardId; cardName: string }
      const options = shimouActionOptions(host, actorId, cardName, cardId)
      if (!options.length) { delete host.state.cards[cardId]; const actor = player(host.state, actorId); if (actor) actor.zones.hand = actor.zones.hand.filter((id) => id !== cardId); return }
      host.askSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'trick-action', data: { actorId, cardId, cardName }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【势谋】：为${player(host.state, actorId)?.nickname ?? '角色'}选择【${cardName}】的合法目标`, timeoutMs: 25_000, optional: false,
        options: options.map(({ id: optionId, label }) => ({ id: optionId, label })),
      }) })
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-mode') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'yang' || choice === 'yin') { b82(host.state).shimouMode ??= {}; b82(host.state).shimouMode[ownerId] = choice }
      return
    }
    if (resolution.step === 'target') {
      const mode = resolution.data.mode as 'yang' | 'yin'
      const actorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const living = host.state.players.filter((entry) => entry.alive)
      if (!actorId || !player(host.state, actorId)?.alive) return
      const values = living.map((entry) => entry.zones.hand.length)
      const edge = mode === 'yang' ? Math.min(...values) : Math.max(...values)
      if (player(host.state, actorId)!.zones.hand.length !== edge) return
      markUsedThisPhase(host.state, ownerId, MOU_XUNYU_SHIMOU)
      b82(host.state).shimouMode[ownerId] = mode === 'yang' ? 'yin' : 'yang'
      const handCount = player(host.state, actorId)!.zones.hand.length
      const maxHp = player(host.state, actorId)!.maxHp
      const adjustment = { actorId, mode, drawn: handCount < maxHp, repeated: handCount > maxHp }
      if (handCount > maxHp) host.queueSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'adjust-discard', data: { ...adjustment, count: handCount - maxHp } })
      else {
        if (handCount < maxHp) drawCards(host.state, host.rng, actorId, Math.min(5, maxHp - handCount), (name, payload) => host.dispatch(name, payload))
        host.queueSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'trick-name', data: adjustment })
      }
      return
    }
    if (resolution.step === 'adjust-discard') {
      const actorId = resolution.data.actorId as PlayerId
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const actor = player(host.state, actorId)
      const count = Number(resolution.data.count)
      if (!actor?.alive || ids.length !== count || ids.some((id) => !actor.zones.hand.includes(id))) return
      discardCardsByIds(host as never, actorId, ids, MOU_XUNYU_SHIMOU)
      host.queueSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'trick-name', data: { ...resolution.data, drawn: false, repeated: true } })
      return
    }
    if (resolution.step === 'trick-name') {
      const actorId = resolution.data.actorId as PlayerId
      const cardName = (response.payload as { optionId?: string }).optionId
      if (!cardName || !player(host.state, actorId)?.alive) return
      const cardId = createVirtualTrick(host.state, actorId, cardName, MOU_XUNYU_SHIMOU)
      if (resolution.data.drawn) { b82(host.state).shimouTargetBonus ??= {}; b82(host.state).shimouTargetBonus[ownerId] = { actorId, cardId, drawn: true } }
      host.queueSkill({ skillId: MOU_XUNYU_SHIMOU, ownerId, step: 'trick-action', data: { ...resolution.data, actorId, cardId, cardName } })
      return
    }
    if (resolution.step === 'trick-action') {
      const { actorId, cardId, cardName } = resolution.data as { actorId: PlayerId; cardId: CardId; cardName: string }
      const optionId = (response.payload as { optionId?: string }).optionId
      const action = shimouActionOptions(host, actorId, cardName, cardId).find((item) => item.id === optionId)?.action
      if (!action || action.kind !== 'use-card') return
      b82(host.state).shimouRepeat ??= {}
      b82(host.state).shimouRepeat[ownerId] = { cardId, repeat: Boolean(resolution.data.repeated) }
      executeUseCardAction(host as never, actorId, action)
    }
  },
})

function douweiCard(state: SanguoshaState, cardId: CardId): boolean {
  const name = effectiveCardName(state, cardId)
  return name === '杀' || DAMAGE_TRICKS.has(name)
}
function douweiCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((target) => target.alive && target.id !== ownerId
    && getDistance(state, target.id, ownerId) <= getAttackRange(state, target.id)).map((target) => target.id)
}
function douweiCombinations(ids: PlayerId[]): PlayerId[][] {
  const result: PlayerId[][] = []
  const visit = (index: number, chosen: PlayerId[]) => {
    if (index === ids.length) { if (chosen.length) result.push(chosen); return }
    visit(index + 1, chosen)
    visit(index + 1, [...chosen, ids[index]!])
  }
  visit(0, [])
  return result
}
registerSkillRuntime({ id: MOU_DONGCHENG_DOUWEI,
  ignoresTrickDistance(state, ownerId, cardId) {
    return (b82(state).douweiPending?.[ownerId] as { cardId?: CardId } | undefined)?.cardId === cardId
  },
  additionalTargetSetsForTrick(state, ownerId, cardId, cardName) {
    const pending = b82(state).douweiPending?.[ownerId] as { cardId: CardId; cardName: string; targetIds: PlayerId[] } | undefined
    return pending?.cardId === cardId && pending.cardName === cardName ? douweiCombinations(pending.targetIds) : []
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId
      || b82(state).douweiDisabled?.[ownerId] === state.turnNumber) return []
    return player(state, ownerId)?.zones.hand.some((id) => douweiCard(state, id)) && douweiCandidates(state, ownerId).length
      ? [{ id: MOU_DONGCHENG_DOUWEI, label: '发动【斗围】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== MOU_DONGCHENG_DOUWEI) return
    const cardIds = player(host.state, ownerId)?.zones.hand.filter((id) => douweiCard(host.state, id)) ?? []
    if (!cardIds.length || !douweiCandidates(host.state, ownerId).length) return
    host.askSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'cost', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【斗围】：弃置一张伤害牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'EnterDying', handle(host, ownerId) {
      const current = b82(host.state).douweiUsing?.[ownerId] as { cardId: CardId; turn: number } | undefined
      if (!current || current.turn !== host.state.turnNumber || host.state.cardResolution?.cardId !== current.cardId
        || b82(host.state).douweiDisabled?.[ownerId] === host.state.turnNumber) return
      b82(host.state).douweiDisabled ??= {}
      b82(host.state).douweiDisabled[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'reward', data: {} })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
      if (payload.sourceSkillId === MOU_DONGCHENG_DOUWEI) delete b82(host.state).douweiUsing?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'targets') {
      const { cardId, cardName, targetIds } = prompt.data as { cardId: CardId; cardName: string; targetIds: PlayerId[] }
      const actions = instantTrickActions(host.state, ownerId, cardId, cardName).filter((action) => action.kind === 'use-card'
        && action.targetIds.length > 0 && action.targetIds.every((id) => targetIds.includes(id)))
      if (!actions.length) return
      host.askSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'targets', data: { cardId, cardName, targetIds }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【斗围】：选择对哪些角色使用【${cardName}】`, timeoutMs: 25_000,
        optional: false, options: actions.map((action, index) => ({ id: String(index), label: action.kind === 'use-card'
          ? `目标：${action.targetIds.map((targetId) => player(host.state, targetId)?.nickname ?? targetId).join('、')}` : `动作${index + 1}` })),
      }) })
      return
    }
    if (prompt.step === 'reward') {
      if (!player(host.state, ownerId)?.alive) return
      recover(host as never, ownerId, 1, MOU_DONGCHENG_DOUWEI)
      const slots = abolishedSlotsOf(host.state, ownerId)
      if (slots.length) host.askSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'restore', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【斗围】：恢复一个已废除的装备栏', timeoutMs: 25_000,
        optional: false, options: slots.map((slot) => ({ id: slot, label: `恢复${SLOT_LABELS[slot]}` })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !player(host.state, ownerId)?.zones.hand.includes(cardId) || !douweiCard(host.state, cardId)) return
      const cardName = effectiveCardName(host.state, cardId)
      discardCardsByIds(host as never, ownerId, [cardId], MOU_DONGCHENG_DOUWEI)
      const candidates = douweiCandidates(host.state, ownerId)
      if (!candidates.length) return
      if (cardName === '杀') {
        host.askSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'slash-targets', data: { candidates }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【斗围】：选择任意名攻击范围内包含你的角色', timeoutMs: 25_000,
          optional: false, candidateIds: candidates, min: 1, max: candidates.length,
        }) })
      } else {
        const virtualId = createVirtualTrick(host.state, ownerId, cardName, MOU_DONGCHENG_DOUWEI)
        b82(host.state).douweiPending ??= {}
        b82(host.state).douweiPending[ownerId] = { cardId: virtualId, cardName, targetIds: candidates }
        host.queueSkill({ skillId: MOU_DONGCHENG_DOUWEI, ownerId, step: 'targets', data: { cardId: virtualId, cardName, targetIds: candidates } })
      }
      return
    }
    if (resolution.step === 'slash-targets') {
      const candidates = new Set(douweiCandidates(host.state, ownerId))
      const selected = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])].filter((id) => candidates.has(id))
      if (!selected.length || !host.beginVirtualSlash({ sourceId: ownerId, targetIds: selected, maxTargets: selected.length,
        sourceSkillId: MOU_DONGCHENG_DOUWEI, ignoreDistance: true, countUsage: true })) return
      const cardId = host.state.cardResolution?.cardId
      if (cardId) { b82(host.state).douweiUsing ??= {}; b82(host.state).douweiUsing[ownerId] = { cardId, turn: host.state.turnNumber } }
      return
    }
    if (resolution.step === 'targets') {
      const { cardId, cardName, targetIds } = resolution.data as { cardId: CardId; cardName: string; targetIds: PlayerId[] }
      const actions = instantTrickActions(host.state, ownerId, cardId, cardName).filter((action) => action.kind === 'use-card'
        && action.targetIds.length > 0 && action.targetIds.every((id) => targetIds.includes(id)))
      const chosen = actions[Number((response.payload as { optionId?: string }).optionId)]
      if (!chosen || chosen.kind !== 'use-card') return
      delete b82(host.state).douweiPending?.[ownerId]
      b82(host.state).douweiUsing ??= {}
      b82(host.state).douweiUsing[ownerId] = { cardId, turn: host.state.turnNumber }
      executeUseCardAction(host as never, ownerId, chosen)
      return
    }
    if (resolution.step === 'restore') {
      const slot = (response.payload as { optionId?: EquipmentSlot }).optionId
      if (slot && abolishedSlotsOf(host.state, ownerId).includes(slot)) restoreSlot(host.state, ownerId, slot)
    }
  },
})

registerSkillRuntime({ id: ZHUSHUO_SHUHE,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const actorId = context.event.sourceId
    const payload = context.event.payload as { cardId?: CardId; cardName?: string }
    const cardId = payload.cardId
    if (!actorId || actorId === ownerId || !cardId || !payload.cardName
      || (payload.cardName !== '杀' && !DAMAGE_TRICKS.has(payload.cardName))
      || usedThisTurn(host.state, ownerId, ZHUSHUO_SHUHE)
      || !player(host.state, ownerId)?.alive || !host.state.zones.drawPile.some((id) => effectiveCardName(host.state, id) === '酒')) return
    host.queueSkill({ skillId: ZHUSHUO_SHUHE, ownerId, step: 'offer', data: { actorId, cardId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      if (usedThisTurn(host.state, ownerId, ZHUSHUO_SHUHE)) return
      askB82Option(host, ZHUSHUO_SHUHE, ownerId, 'offer', '【疏和】：是否获得一张【酒】并令其选择？', [
        { id: 'yes', label: '发动' }, { id: 'no', label: '不发动' },
      ], prompt.data)
      return
    }
    if (prompt.step === 'choice') {
      const actorId = prompt.data.actorId as PlayerId
      const cardId = prompt.data.cardId as CardId
      if (!player(host.state, actorId)?.alive || !host.state.cardResolution || host.state.cardResolution.cardId !== cardId) return
      const canWine = canUseWineThisTurn(host) && !isCardUseProhibited(host.state, actorId, '酒', { dyingPlayerId: host.state.dying?.playerId ?? null })
      host.askSkill({ skillId: ZHUSHUO_SHUHE, ownerId, step: 'choice', data: { actorId, cardId, canWine }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: actorId, prompt: '【疏和】：选择一项', timeoutMs: 25_000, optional: false,
        options: [
          ...(canWine ? [{ id: 'wine', label: '视为使用一张【酒】，令本次牌无效' }] : []),
          { id: 'draw', label: '令朱铄摸一张牌' },
        ],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || usedThisTurn(host.state, ownerId, ZHUSHUO_SHUHE)) return
      const wineId = host.state.zones.drawPile.find((id) => effectiveCardName(host.state, id) === '酒')
      if (!wineId || !player(host.state, ownerId)?.alive) return
      markUsedThisTurn(host.state, ownerId, ZHUSHUO_SHUHE)
      moveCard(host.state, wineId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [wineId], reason: ZHUSHUO_SHUHE }, { sourceId: ownerId, targetId: ownerId, cardIds: [wineId] })
      host.queueSkill({ skillId: ZHUSHUO_SHUHE, ownerId, step: 'choice', data: resolution.data })
      return
    }
    if (resolution.step !== 'choice') return
    const { actorId, cardId, canWine } = resolution.data as { actorId: PlayerId; cardId: CardId; canWine: boolean }
    const option = (response.payload as { optionId?: string }).optionId
    if (!player(host.state, actorId)?.alive || host.state.cardResolution?.cardId !== cardId) return
    if (option === 'wine' && canWine && canUseWineThisTurn(host)) {
      host.state.invalidatedCardUses ??= {}
      host.state.invalidatedCardUses[cardId] = { sourceId: ownerId, skillId: ZHUSHUO_SHUHE }
      if (useVirtualWine(host, actorId, ZHUSHUO_SHUHE)) applyWineEffect(host)
      else delete host.state.invalidatedCardUses[cardId]
    } else if (option === 'draw') {
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    }
  },
})

const JILIE_JUDGMENT_TAG = `${ZHUSHUO_JILIE}:judgment`
registerJudgmentContinuation(JILIE_JUDGMENT_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const state = b82(host.state).jilie?.[ownerId] as { suits: Suit[]; suitIndex: number; attempt: number; pendingCardId?: CardId } | undefined
  if (!state || state.suitIndex !== Number(data.suitIndex) || state.attempt !== Number(data.attempt)) return
  if (judged.name !== '杀' || !host.state.zones.discardPile.includes(judged.id)) {
    state.attempt += 1
    if (state.attempt >= 2) { state.suitIndex += 1; state.attempt = 0 }
    host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
    return
  }
  const targets = host.state.players.filter((target) => target.alive && target.id !== ownerId
    && getDistance(host.state, ownerId, target.id) <= getAttackRange(host.state, ownerId)
    && canTarget(host.state, ownerId, target.id, undefined, judged.id)
    && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf, judged.id))
  if (!targets.length) {
    state.attempt += 1
    if (state.attempt >= 2) { state.suitIndex += 1; state.attempt = 0 }
    host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
    return
  }
  state.pendingCardId = judged.id
  host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'slash-target', data: { cardId: judged.id, candidateIds: targets.map(({ id }) => id) } })
})

registerSkillRuntime({ id: ZHUSHUO_JILIE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, ZHUSHUO_JILIE)) return []
    const owner = player(state, ownerId)
    const owned = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
    return owner && owned.length >= owner.hp ? [{ id: ZHUSHUO_JILIE, label: '发动【急烈】' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHUSHUO_JILIE || usedThisPhase(host.state, ownerId, ZHUSHUO_JILIE)) return
    const owner = player(host.state, ownerId)
    if (!owner) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    const count = owner.hp
    if (count <= 0 || cardIds.length < count) return
    host.askSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'cost', data: { count }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【急烈】：弃置${count}张牌`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: count, max: count,
    }) })
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
    const record = b82(host.state).jilie?.[ownerId] as { pendingCardId?: CardId; suitIndex: number; attempt: number; suits: Suit[] } | undefined
    if (payload.sourceSkillId !== ZHUSHUO_JILIE || !record?.pendingCardId || payload.cardId !== record.pendingCardId) return
    record.pendingCardId = undefined
    record.attempt += 1
    if (record.attempt >= 2) { record.suitIndex += 1; record.attempt = 0 }
    host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'judge-next') {
      const record = b82(host.state).jilie?.[ownerId] as { suits: Suit[]; suitIndex: number; attempt: number } | undefined
      if (!record || record.suitIndex >= record.suits.length || !player(host.state, ownerId)?.alive) { delete b82(host.state).jilie?.[ownerId]; return }
      performJudgment(host as never, ownerId, `【急烈】${record.suits[record.suitIndex]}`, {
        tag: JILIE_JUDGMENT_TAG, data: { ownerId, suitIndex: record.suitIndex, attempt: record.attempt },
      })
      return
    }
    if (prompt.step === 'slash-target') {
      const candidates = prompt.data.candidateIds as PlayerId[]
      host.askSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'slash-target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【急烈】：视为使用判定牌【杀】', timeoutMs: 25_000,
        optional: true, candidateIds: candidates, min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const count = Number(resolution.data.count)
      const owner = player(host.state, ownerId)
      const owned = new Set(owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : [])
      if (ids.length !== count || ids.some((id) => !owned.has(id))) return
      const suits = [...new Set(ids.map((id) => effectiveCardSuit(host.state, ownerId, id)).filter((suit): suit is Suit => Boolean(suit)))]
      markUsedThisPhase(host.state, ownerId, ZHUSHUO_JILIE)
      b82(host.state).jilie ??= {}
      b82(host.state).jilie[ownerId] = { suits, suitIndex: 0, attempt: 0 }
      discardCardsByIds(host as never, ownerId, ids, ZHUSHUO_JILIE)
      host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
      return
    }
    if (resolution.step !== 'slash-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const cardId = resolution.data.cardId as CardId
    const state = b82(host.state).jilie?.[ownerId] as { pendingCardId?: CardId; suitIndex: number; attempt: number } | undefined
    if (!targetId || !player(host.state, targetId)?.alive || !host.state.zones.discardPile.includes(cardId)) {
      if (state) { state.pendingCardId = undefined; state.attempt += 1; if (state.attempt >= 2) { state.suitIndex += 1; state.attempt = 0 } }
      host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
      return
    }
    if (!host.beginSkillSlashFromDiscard({ sourceId: ownerId, cardId, targetId, sourceSkillId: ZHUSHUO_JILIE })) {
      if (state) { state.pendingCardId = undefined; state.attempt += 1; if (state.attempt >= 2) { state.suitIndex += 1; state.attempt = 0 } }
      host.queueSkill({ skillId: ZHUSHUO_JILIE, ownerId, step: 'judge-next', data: {} })
      return
    }
    const uses = (host.state.turnUsage.slashUsesThisTurn ?? 0) + 1
    host.state.turnUsage.slashUsesThisTurn = uses
    if (host.state.cardResolution?.kind === 'slash') host.state.cardResolution.damageAmount = uses
  },
})
