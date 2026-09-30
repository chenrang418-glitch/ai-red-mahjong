import type { CharacterDefinition } from './types'
import type { LegalAction } from '../../engine/actions'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, clanOfCharacter, skillsOf, type SkillHost } from '../../engine/skills/runtime'
import { effectiveCardColor } from '../../engine/skills/runtime'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { getCharacter, skillIdsOf } from './standard'
import { discardCardsByIds } from '../../engine/discard-all'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { setChained } from '../../engine/character-state'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { queueExtraPhaseAfterCurrent } from '../../engine/extra-phase'
import { hiddenHandSlot } from '../../engine/cards/host'
import { resolvePickedCard } from '../../engine/card-pick'
import { giveCards } from '../../engine/hand-transfer'
import { declaredCardActions, executeUseCardAction, skillHandCardUseActions } from '../../engine/cards/basic'
import { revealTopCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { beginJudgmentRetention } from '../../engine/judgment-retention'
import { discardEntryOf } from '../../engine/discard-provenance'

const B = '-b68'
const sid = (name: string) => `${name}${B}`
const ids = {
  zhongyu: 'clan-zhongyu-b68', zhonghui: 'clan-zhonghui-b68', xunyou: 'clan-xunyou-b68',
  wanghun: 'clan-wanghun-b68', wanglun: 'clan-wanglun-b68', wuqiao: 'clan-wuqiao-b68',
  zhongyao: 'clan-zhongyao-b68', wangshen: 'clan-wangshen-b68', yangci: 'clan-yangci-b68', yangxiu: 'clan-yangxiu-b68',
}
const sk = (key: string, name: string, description: string, locked = false) => ({ id: sid(key), name, description, ...(locked ? { locked: true } : {}) })
const BAIZU = 'baizu-clan-zhong-b67'
const ZHONGLIU = 'zhongliu-clan-wang'
const QUHUO = 'quhuo-clan-yang-b67'
const MUYIN = 'muyin-clan-wu-b67'
const playerOf = (state: SanguoshaState, playerId: PlayerId) => state.players.find((p) => p.id === playerId)
type B68State = SanguoshaState & { b68?: Record<string, any> }
const stateOf = (host: SkillHost) => (host.state as B68State).b68 ??= {}
const handOf = (state: SanguoshaState, playerId: PlayerId): CardId[] => playerOf(state, playerId)?.zones.hand ?? []
const equipmentOf = (state: SanguoshaState, playerId: PlayerId): CardId[] => {
  const equipment = playerOf(state, playerId)?.zones.equipment
  return equipment ? Object.values(equipment).filter((cardId): cardId is CardId => Boolean(cardId)) : []
}

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  options: Array<{ id: string; label: string }>, data: Record<string, unknown> = {}, optional = true, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}
function askCards(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  cardIds: CardId[], min: number, max: number, data: Record<string, unknown> = {}, optional = true, playerId = ownerId) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000, optional,
    purpose: 'skill', cardIds, hiddenCardSlots: [], min, max,
  }) })
}
function askTargets(host: SkillHost, skillId: string, ownerId: PlayerId, step: string, prompt: string,
  candidateIds: PlayerId[], min = 1, max = 1, data: Record<string, unknown> = {}, optional = true) {
  host.askSkill({ skillId, ownerId, step, data, build: (requestId): ChooseTargetsRequest => ({
    id: requestId, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional, candidateIds, min, max,
  }) })
}
function activate(host: SkillHost, ownerId: PlayerId, id: string, name: string, targets: PlayerId[] = []) {
  host.dispatch('SkillActivated', { skillId: id, skillName: name, playerId: ownerId, targetIds: targets }, { sourceId: ownerId, targetId: targets[0] })
}
function nameLength(name: string | null | undefined) { return [...(name ?? '')].length }
function living(host: SkillHost) { return host.state.players.filter((p) => p.alive) }
function clanmates(host: SkillHost, ownerId: PlayerId) {
  const clan = playerOf(host.state, ownerId)?.characterId
  const clanId = clan ? clanOfCharacter(clan) : undefined
  return clanId ? living(host).filter((p) => p.characterId && clanOfCharacter(p.characterId) === clanId) : []
}

const baizu = { id: BAIZU, name: '保族', description: '宗族技，限定技，当同族角色进入濒死状态时，你可以令其进入连环状态并回复1点体力。' }
const zhongliu = { id: ZHONGLIU, name: '中流', description: '宗族技，锁定技，当你使用牌时，若不为同族角色的手牌，你视为未发动武将牌上的技能。', locked: true }
const quhuo = { id: QUHUO, name: '去惑', description: '宗族技，当你每回合首次不因使用、打出或弃置，失去手牌中的【酒】或装备牌后，你可令一名同族角色回复1点体力。' }
const muyin = { id: MUYIN, name: '穆荫', description: '宗族技，回合开始时，你可以令一名手牌上限不为全场最大的同族角色手牌上限+1。' }

export const HISTORICAL_BATCH68_CHARACTERS: readonly CharacterDefinition[] = [
  { id: ids.zhongyu, name: '族·钟毓', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-zhong', skills: [baizu, sk('jiejian-zhongyu', '捷谏', '当你每回合使用第X张牌指定目标后，若不为装备牌，你可以令其中一个目标摸X张牌。（X为此牌牌名字数）'), sk('huanghan-zhongyu', '惶汗', '当你受到牌的伤害后，你可以摸X张牌（X为此牌牌名字数）并弃置你已损失体力值张牌，若不为本回合首次发动，你视为未发动宗族技。')] },
  { id: ids.zhonghui, name: '族·钟会', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-zhong', skills: [baizu, sk('yuzhi-zhonghui', '迂志', '锁定技，每轮开始时，你展示一张手牌并摸X张牌（X为此牌牌名字数）。每轮结束时，你弃置展示的手牌，若你本轮使用牌数或上轮以此法摸牌数小于X，你受到1点雷电伤害或失去宗族技。', true), sk('xieshu-zhonghui', '挟术', '当你造成或受到牌的伤害后，你可进入连环状态，弃置X张牌（X为此牌牌名字数），摸已损失体力张牌。你以此法摸牌后，若本回合有角色进入过濒死，本技能失效至回合结束。')] },
  { id: ids.xunyou, name: '族·荀攸', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-xun', skills: [{ id: 'daojie-clan-xun-b66', name: '蹈节', description: '宗族技，锁定技，当你每回合首次使用非伤害锦囊牌后，你失去1点体力或一个锁定技令一名同族角色获得此牌。', locked: true }, sk('baichu-xunyou', '百出', '锁定技，当你使用牌后，若此牌：花色和类型组合为你首次使用，你记录一张普通锦囊牌；若不为你首次使用，你于本轮获得“奇策”；牌名以此法记录过，你摸一张牌或回复1点体力。', true)] },
  { id: ids.wanghun, name: '族·王浑', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [zhongliu, sk('fuxun-wanghun', '抚循', '出牌阶段限一次，你可以获得或交给一名其他角色一张手牌，若其手牌数与你相同且本阶段仅因此法变化过，你可以将一张牌当任意基本牌使用。'), sk('chenya-wanghun', '沉雅', '当一名角色发动“出牌阶段限一次”的技能后，你可以令其重铸任意张牌名字数为X的牌（X为其手牌数）。')] },
  { id: ids.wanglun, name: '族·王沦', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [zhongliu, sk('qiuxin-wanglun', '求心', '出牌阶段限一次，你可以令一名其他角色声明一项：1.你对其使用一张【杀】；2.你对其使用任意普通锦囊牌。你下次执行此项后视为执行另一项。'), sk('jianyuan-wanglun', '简远', '当一名角色发动“出牌阶段限一次”的技能后，你可以令其重铸任意张牌名字数为X的牌（X为其本阶段使用牌数）。')] },
  { id: ids.wuqiao, name: '族·吴乔', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', clan: 'chenliu-wu', skills: [muyin, sk('qiajue-wuqiao', '跒倔', '摸牌阶段开始时，你可以弃置一张黑色牌并于本阶段结束时展示手牌，若点数和大于30，你的手牌上限-2，否则你执行一个额外的摸牌阶段。')] },
  { id: ids.zhongyao, name: '族·钟繇', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'yingchuan-zhong', skills: [baizu, sk('chengqi-zhongyao', '承启', '你可将至少两张手牌当一张本回合未使用过的基本牌或普通锦囊牌使用（转化后的牌名字数不大于转化前牌名字数之和，若恰好相等，你令一名角色摸一张牌）。'), sk('jieli-zhongyao', '诫厉', '结束阶段，你可选择一名角色，观看其牌名字数最多的手牌和牌堆顶的X张牌，然后你可交换其中等量牌（X为你本回合使用的牌名字数的最大值）。')] },
  { id: ids.wangshen, name: '族·王沈', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'taiyuan-wang', skills: [zhongliu, sk('anran-wangshen', '岸然', '出牌阶段开始时或你受到伤害后，你可以选择一项：1.摸X张牌；2.令至多X名角色各摸一张牌。然后以此法获得牌的角色本回合使用的下一张牌不能是这些牌（X为此技能发动次数且至多为4）。'), sk('gaobian-wangshen', '告变', '锁定技，其他角色回合结束时，若本回合仅有一名角色受到过伤害，此受伤角色须使用本回合进入弃牌堆的一张【杀】，或失去1点体力。', true)] },
  { id: ids.yangci, name: '族·杨赐', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', clan: 'hongnong-yang', skills: [sk('qieyi-yangci', '切议', '出牌阶段开始时，你可观看牌堆顶两张牌。若如此做，本回合你使用每个花色的第一张牌结算完成后，展示牌堆顶的一张牌，若展示牌与你使用牌的类别或颜色相同，你获得展示牌；若均不同，你将一张牌置于牌堆顶。'), sk('jianzheng-yangci', '谏直', '锁定技，结束阶段，你进行至多X次连续判定（X为你本回合“切议”的发动次数）。你将判定牌其中与你本回合使用花色相同的牌分配给任意角色；若判定牌中有你本回合未使用过花色的牌，你受到一点无来源雷电伤害。', true), quhuo] },
  { id: ids.yangxiu, name: '族·杨修', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', clan: 'hongnong-yang', skills: [quhuo, sk('jiewu-yangxiu', '捷悟', '出牌阶段开始时，你可以令一名角色的手牌此阶段始终对你可见。然后你此阶段使用牌指定其他角色为目标后，你可以展示“捷悟”角色一张手牌，若两张牌花色相同，你摸一张牌；若此牌本回合以此法展示过，你将你与其之中手牌较多的角色一张手牌置于牌堆顶。'), sk('gaoshi-yangxiu', '高视', '结束阶段，你可以依次亮出牌堆顶的牌，直到你亮出了本回合你使用过的牌名，或亮出了至少X张牌（X为本回合你发动“捷悟”次数）。然后你可以使用亮出的牌，若你因此使用了所有亮出牌，你摸两张牌。')] },
]

// Runtime implementations follow below; all state is serializable and keyed per skill/turn.

const JIEJIAN = sid('jiejian-zhongyu')
registerSkillRuntime({ id: JIEJIAN,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
    const cardId = payload.cardId
    const targets = payload.targetIds ?? []
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!card) return
    const state = stateOf(host)
    const countRec = state.jiejianCount?.[ownerId]
    const count = countRec?.turnNumber === host.state.turnNumber ? countRec.count + 1 : 1
    state.jiejianCount ??= {}
    state.jiejianCount[ownerId] = { turnNumber: host.state.turnNumber, count }
    if (card.category === 'equipment' || !targets.length) return
    const amount = nameLength(payload.cardName ?? card.name)
    if (count !== amount) return
    const valid = targets.filter((id) => playerOf(host.state, id)?.alive)
    if (!valid.length) return
    host.askSkill({ skillId: JIEJIAN, ownerId, step: 'target', data: { count, amount, candidates: valid }, build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: `【捷谏】：令此牌的一名目标摸${amount}张牌`, timeoutMs: 25_000, optional: true, candidateIds: valid, min: 1, max: 1,
    }) })
  } }],
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const amount = Number(resolution.data.amount ?? 0)
    if (targetId && playerOf(host.state, targetId)?.alive && amount > 0) drawCards(host.state, host.rng, targetId, amount, (name, payload) => host.dispatch(name, payload))
  },
})

const HUANGHAN = sid('huanghan-zhongyu')
registerSkillRuntime({ id: HUANGHAN,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !context.event.cardIds?.length) return
    const cardId = context.event.cardIds[0]!
    const amount = nameLength((context.event.payload as { cardName?: string }).cardName ?? host.state.cards[cardId]?.name)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || amount <= 0) return
    const state = stateOf(host)
    state.huanghanUse ??= {}
    const previous = state.huanghanUse[ownerId]
    const uses = previous?.turnNumber === host.state.turnNumber ? previous.uses : 0
    host.askSkill({ skillId: HUANGHAN, ownerId, step: 'invoke', data: { amount, lostHp: owner.maxHp - owner.hp, uses }, build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【惶汗】：是否摸${amount}张牌并弃置${owner.maxHp - owner.hp}张牌？`, timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke' && (response.payload as { optionId?: string }).optionId === 'yes') {
      const amount = Number(resolution.data.amount ?? 0)
      const previousUses = Number(resolution.data.uses ?? 0)
      const uses = previousUses + 1
      const state = stateOf(host)
      state.huanghanUse ??= {}
      state.huanghanUse[ownerId] = { turnNumber: host.state.turnNumber, uses }
      drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
      const discard = Math.min(Number(resolution.data.lostHp ?? 0), handOf(host.state, ownerId).length)
      if (discard > 0) askCards(host, HUANGHAN, ownerId, 'discard', `【惶汗】：弃置${discard}张手牌`, handOf(host.state, ownerId), discard, discard, { uses })
      else if (uses > 1) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== BAIZU)
      }
      activate(host, ownerId, HUANGHAN, '惶汗')
    } else if (resolution.step === 'discard') {
      const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cards.length === Number(resolution.data.discard) && cards.every((id) => handOf(host.state, ownerId).includes(id))) discardCardsByIds(host as never, ownerId, cards, HUANGHAN)
      if (Number(resolution.data.uses ?? 0) > 1) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.usedLimitedSkills = owner.usedLimitedSkills.filter((skillId) => skillId !== BAIZU)
      }
    }
  },
})

const YUZHI = sid('yuzhi-zhonghui')
registerSkillRuntime({ id: YUZHI, triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const state = stateOf(host)
    state.yuzhiUses ??= {}
    const round = host.state.roundNumber ?? 1
    const prior = state.yuzhiUses[ownerId]
    state.yuzhiUses[ownerId] = { round, uses: (prior?.round === round ? prior.uses : 0) + 1 }
  } },
  { event: 'RoundStart', handle(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length) return
    const round = host.state.roundNumber ?? 1
    askCards(host, YUZHI, ownerId, 'show', '【迂志】：展示一张手牌并摸等同于其牌名字数的牌', handOf(host.state, ownerId), 1, 1, { round }, false)
  } },
  { event: 'RoundEnd', handle(host, ownerId) {
    const state = stateOf(host)
    const record = state.yuzhiShown?.[ownerId]
    if (!record || record.round !== (host.state.roundNumber ?? 1)) return
    const hand = handOf(host.state, ownerId)
    if (hand.includes(record.cardId)) discardCardsByIds(host as never, ownerId, [record.cardId], YUZHI)
    const uses = state.yuzhiUses?.[ownerId]
    const usedLess = (uses?.round === record.round ? uses.uses : 0) < record.amount
    const previousDrawLess = record.previousDraw < record.amount
    state.yuzhiLastDraw ??= {}
    state.yuzhiLastDraw[ownerId] = record.amount
    if (!usedLess && !previousDrawLess) { delete state.yuzhiShown[ownerId]; return }
    askOption(host, YUZHI, ownerId, 'penalty', '【迂志】：本轮未达成志向，选择承受1点雷电伤害或失去宗族技【保族】', [
      { id: 'damage', label: '受到1点雷电伤害' }, { id: 'lose', label: '失去宗族技【保族】' },
    ], { round: record.round })
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'show') {
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const owner = playerOf(host.state, ownerId)
    if (!cardId || !owner?.zones.hand.includes(cardId)) return
    const amount = nameLength(host.state.cards[cardId]?.name)
    const round = Number(resolution.data.round)
    const previousDraw = stateOf(host).yuzhiLastDraw?.[ownerId] ?? 0
    stateOf(host).yuzhiShown ??= {}
    stateOf(host).yuzhiShown[ownerId] = { cardId, amount, round, previousDraw }
    drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
    return
  }
  if (resolution.step === 'penalty') {
    const option = (response.payload as { optionId?: string }).optionId
    if (option === 'damage') resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'thunder', cardId: null, cardName: YUZHI })
    else if (option === 'lose') {
      const owner = playerOf(host.state, ownerId)
      if (owner && !owner.permanentlyLostSkills?.includes(BAIZU)) {
        owner.permanentlyLostSkills ??= []
        owner.permanentlyLostSkills.push(BAIZU)
        host.dispatch('SkillActivated', { skillId: YUZHI, skillName: '迂志', playerId: ownerId, logText: `${owner.nickname}失去宗族技【保族】` }, { sourceId: ownerId })
      }
    }
  }
} })

const XIESHU = sid('xieshu-zhonghui')
registerSkillRuntime({ id: XIESHU, triggers: [
  { event: 'EnterDying', handle(host) {
    const state = stateOf(host)
    state.xieshuDyingTurn = host.state.turnNumber
  } },
  { event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || context.event.sourceId === ownerId || !context.event.cardIds?.length) return
    const payload = context.event.payload as { cardName?: string }
    const amount = nameLength(payload.cardName)
    const owner = playerOf(host.state, ownerId)
    const state = stateOf(host)
    if (!owner?.alive || amount < 1 || state.xieshuDyingTurn === host.state.turnNumber
      || handOf(host.state, ownerId).length + equipmentOf(host.state, ownerId).length < amount) return
    askOption(host, XIESHU, ownerId, 'invoke', `【挟术】：是否进入连环状态、弃置${amount}张牌并摸${owner.maxHp - owner.hp}张牌？`, [
      { id: 'yes', label: '发动【挟术】' }, { id: 'no', label: '不发动' },
    ], { amount, draw: owner.maxHp - owner.hp })
  } },
  { event: 'AfterDamage', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || !context.event.cardIds?.length) return
    const payload = context.event.payload as { cardName?: string }
    const amount = nameLength(payload.cardName)
    const owner = playerOf(host.state, ownerId)
    const state = stateOf(host)
    if (!owner?.alive || amount < 1 || state.xieshuDyingTurn === host.state.turnNumber
      || handOf(host.state, ownerId).length + equipmentOf(host.state, ownerId).length < amount) return
    askOption(host, XIESHU, ownerId, 'invoke', `【挟术】：是否进入连环状态、弃置${amount}张牌并摸${owner.maxHp - owner.hp}张牌？`, [
      { id: 'yes', label: '发动【挟术】' }, { id: 'no', label: '不发动' },
    ], { amount, draw: owner.maxHp - owner.hp })
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const amount = Number(resolution.data.amount)
    const allOwned = [...handOf(host.state, ownerId), ...equipmentOf(host.state, ownerId)]
    if (allOwned.length < amount) return
    setChained(host as never, ownerId, XIESHU, true)
    stateOf(host).xieshuPending ??= {}
    stateOf(host).xieshuPending[ownerId] = { amount, draw: Number(resolution.data.draw), turn: host.state.turnNumber }
    askCards(host, XIESHU, ownerId, 'discard', `【挟术】：弃置${amount}张牌`, allOwned, amount, amount)
    return
  }
  if (resolution.step === 'discard') {
    const record = stateOf(host).xieshuPending?.[ownerId]
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!record || record.turn !== host.state.turnNumber || cards.length !== record.amount) return
    const owner = playerOf(host.state, ownerId)
    const valid = cards.every((cardId) => handOf(host.state, ownerId).includes(cardId) || equipmentOf(host.state, ownerId).includes(cardId))
    if (!valid) return
    discardCardsByIds(host as never, ownerId, cards, XIESHU)
    stateOf(host).xieshuUsed ??= {}
    stateOf(host).xieshuUsed[ownerId] = host.state.turnNumber
    const amount = Math.min(record.draw, Math.max(0, (owner?.maxHp ?? 0) - (owner?.hp ?? 0)))
    if (amount) drawCards(host.state, host.rng, ownerId, amount, (name, payload) => host.dispatch(name, payload))
    delete stateOf(host).xieshuPending[ownerId]
  }
} })

const BAICHU = sid('baichu-xunyou')
registerSkillRuntime({ id: BAICHU,
  viewAs(state, ownerId) {
    const record = (state as B68State).b68?.baichu?.[ownerId]
    if (!record || record.round !== (state.roundNumber ?? 1) || !record.qice) return []
    return (playerOf(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => record.names.map((name: string) => ({
      cardId, asCardName: name, label: `【百出】：将此牌当【${name}】使用`,
    })))
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (!card) return
      const state = stateOf(host)
      state.baichu ??= {}
      const round = host.state.roundNumber ?? 1
      const record = state.baichu[ownerId] ?? { round, combos: [], names: [], qice: false, seenNames: [] }
      if (record.round !== round) Object.assign(record, { round, combos: [], names: [], qice: false, seenNames: [] })
      const combo = `${effectiveCardSuit(host.state, ownerId, card.id)}:${card.category}`
      if (payload.cardName && record.names.includes(payload.cardName)) {
        state.baichuReward ??= {}
        state.baichuReward[ownerId] = { name: payload.cardName, cardId: card.id }
      }
      if (record.combos.includes(combo)) record.qice = true
      else {
        record.combos.push(combo)
        const available = [...INSTANT_TRICKS]
        state.baichuPendingRecord ??= {}
        state.baichuPendingRecord[ownerId] = { cardId: card.id, round, combo, available }
      }
      state.baichu[ownerId] = record
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const state = stateOf(host)
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const record = state.baichuPendingRecord?.[ownerId]
      const reward = state.baichuReward?.[ownerId]
      if (record?.cardId === cardId) {
        delete state.baichuPendingRecord[ownerId]
        delete state.baichuReward?.[ownerId]
        host.askSkill({ skillId: BAICHU, ownerId, step: 'record-trick', data: { round: record.round, combo: record.combo, available: record.available, rewardName: reward?.cardId === cardId ? reward.name : undefined }, build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【百出】：记录一张普通锦囊牌名', timeoutMs: 25_000, optional: false,
          options: (record.available as string[]).map((name) => ({ id: name, label: `记录【${name}】` })),
        }) })
        return
      }
      const name = reward?.cardId === cardId ? reward.name : undefined
      if (!name) return
      delete state.baichuReward[ownerId]
      askOption(host, BAICHU, ownerId, 'recorded-name-reward', `【百出】：因使用已记录牌名【${name}】，选择摸牌或回复`, [
        { id: 'draw', label: '摸一张牌' }, { id: 'recover', label: '回复1点体力' },
      ], { name })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'record-trick') {
      const name = (response.payload as { optionId?: string }).optionId
      const record = stateOf(host).baichu?.[ownerId]
      const available = resolution.data.available as string[] | undefined
      if (name && available?.includes(name) && record && record.round === Number(resolution.data.round)) {
        if (!record.names.includes(name)) record.names.push(name)
      }
      const rewardName = resolution.data.rewardName as string | undefined
      if (rewardName) askOption(host, BAICHU, ownerId, 'recorded-name-reward', `【百出】：因使用已记录牌名【${rewardName}】，选择摸牌或回复`, [
        { id: 'draw', label: '摸一张牌' }, { id: 'recover', label: '回复1点体力' },
      ], { name: rewardName })
      return
    }
    if (resolution.step === 'recorded-name-reward') {
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'draw') drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      else if (option === 'recover') recover(host as never, ownerId, 1, ownerId)
    }
  },
})

const ANRAN = sid('anran-wangshen')
registerSkillRuntime({ id: ANRAN,
  prohibitsCardUse(state, _ownerId, context) {
    const lock = (state as B68State).b68?.anranLocks?.[context.userId]
    return lock?.turn === state.turnNumber && context.cardIds?.some((cardId) => lock.cardIds.includes(cardId)) === true
  },
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const actorId = context.event.sourceId
      if (!actorId) return
      const lock = stateOf(host).anranLocks?.[actorId]
      if (lock?.turn === host.state.turnNumber) delete stateOf(host).anranLocks[actorId]
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      askAnran(host, ownerId)
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) askAnran(host, ownerId)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const option = (response.payload as { optionId?: string }).optionId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (option !== 'self' && option !== 'others')) return
      const state = stateOf(host)
      state.anranUses ??= {}
      const old = state.anranUses[ownerId]
      const uses = old?.turn === host.state.turnNumber ? old.count + 1 : 1
      if (uses > 4) return
      state.anranUses[ownerId] = { turn: host.state.turnNumber, count: uses }
      const amount = Math.min(4, uses)
      if (option === 'self') {
        const drawn = drawCards(host.state, host.rng, ownerId, amount, (name, data) => host.dispatch(name, data))
        state.anranLocks ??= {}
        state.anranLocks[ownerId] = { turn: host.state.turnNumber, cardIds: drawn }
      } else {
        const candidates = living(host).filter((p) => p.id !== ownerId)
        if (!candidates.length) return
        askTargets(host, ANRAN, ownerId, 'targets', `【岸然】：选择至多${amount}名角色各摸一张牌`, candidates.map((p) => p.id), 0, Math.min(amount, candidates.length), { amount })
      }
      activate(host, ownerId, ANRAN, '岸然')
    } else if (resolution.step === 'targets') {
      const chosen = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const amount = Number(resolution.data.amount)
      if (chosen.length > amount || chosen.some((id) => !playerOf(host.state, id)?.alive || id === ownerId)) return
      for (const targetId of chosen) {
        const drawn = drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
        if (drawn.length) {
          stateOf(host).anranLocks ??= {}
          const previous = stateOf(host).anranLocks[targetId]
          stateOf(host).anranLocks[targetId] = { turn: host.state.turnNumber, cardIds: [...(previous?.turn === host.state.turnNumber ? previous.cardIds : []), ...drawn] }
        }
      }
    }
  },
})

function askAnran(host: SkillHost, ownerId: PlayerId) {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const old = stateOf(host).anranUses?.[ownerId]
  const used = old?.turn === host.state.turnNumber ? old.count : 0
  if (used >= 4) return
  const amount = Math.min(4, used + 1)
  askOption(host, ANRAN, ownerId, 'mode', `【岸然】：第${amount}次发动，选择摸牌方式`, [
    { id: 'self', label: `自己摸${amount}张牌` },
    ...(living(host).some((p) => p.id !== ownerId) ? [{ id: 'others', label: `令至多${amount}名角色各摸一张牌` }] : []),
  ], { amount })
}

const QIAJUE = sid('qiajue-wuqiao')
registerSkillRuntime({ id: QIAJUE,
  maxCardsBonus(state, ownerId) { return -((state as B68State).b68?.qiajuePenalty?.[ownerId] ?? 0) },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'draw' || usedThisPhase(host.state, ownerId, QIAJUE)
        || host.state.extraPhase?.skillId === QIAJUE) return
      const black = handOf(host.state, ownerId).filter((cardId) => host.state.cards[cardId]?.color === 'black')
      if (!black.length) return
      host.askSkill({ skillId: QIAJUE, ownerId, step: 'cost', build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【跒倔】：可弃置一张黑色牌；摸牌阶段结束时展示手牌', timeoutMs: 25_000, optional: true,
        purpose: 'skill', cardIds: black, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const record = stateOf(host).qiajuePending?.[ownerId]
      if (phase.playerId !== ownerId || phase.phase !== 'draw' || record?.turn !== host.state.turnNumber) return
      delete stateOf(host).qiajuePending[ownerId]
      const total = handOf(host.state, ownerId).reduce((sum, cardId) => sum + (host.state.cards[cardId]?.rank ?? 0), 0)
      if (total > 30) {
        stateOf(host).qiajuePenalty ??= {}
        stateOf(host).qiajuePenalty[ownerId] = (stateOf(host).qiajuePenalty[ownerId] ?? 0) + 2
      } else {
        queueExtraPhaseAfterCurrent(host.state, ownerId, 'draw', QIAJUE, 'play')
      }
      activate(host, ownerId, QIAJUE, '跒倔')
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cost') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !handOf(host.state, ownerId).includes(cardId) || host.state.cards[cardId]?.color !== 'black') { host.resumePhaseEntry(); return }
    markUsedThisPhase(host.state, ownerId, QIAJUE)
    discardCardsByIds(host as never, ownerId, [cardId], QIAJUE)
    stateOf(host).qiajuePending ??= {}
    stateOf(host).qiajuePending[ownerId] = { turn: host.state.turnNumber }
    host.resumePhaseEntry()
  },
})

const FUXUN = sid('fuxun-wanghun')
const FUXUN_BASIC = ['杀', '火杀', '雷杀', '冰杀', '闪', '桃', '酒']
registerSkillRuntime({ id: FUXUN,
  viewAs(state, ownerId) {
    const player = playerOf(state, ownerId)
    const available = (state as B68State).b68?.fuxunGranted?.[ownerId]
    if (!player?.alive || !available || available.phaseKey !== `${state.turnNumber}:${state.phase}` || available.used
      || state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    return player.zones.hand.flatMap((cardId) => FUXUN_BASIC.map((asCardName) => ({
      cardId, asCardName, label: `【抚循】：将此牌当【${asCardName}】使用`,
    })))
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') {
        stateOf(host).fuxunPhase ??= {}
        stateOf(host).fuxunPhase[ownerId] = { phaseKey: `${host.state.turnNumber}:${host.state.phase}`, changed: [], exempt: false }
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') {
        delete stateOf(host).fuxunPhase?.[ownerId]
        delete stateOf(host).fuxunGranted?.[ownerId]
      }
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const phase = stateOf(host).fuxunPhase?.[ownerId]
      if (!phase || phase.phaseKey !== `${host.state.turnNumber}:play` || phase.exempt || !payload.playerId) return
      if (!phase.changed.includes(payload.playerId)) phase.changed.push(payload.playerId)
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
      const phase = stateOf(host).fuxunPhase?.[ownerId]
      if (!phase || phase.phaseKey !== `${host.state.turnNumber}:play` || payload.reason === FUXUN || !payload.playerId) return
      if (!phase.changed.includes(payload.playerId)) phase.changed.push(payload.playerId)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== FUXUN) return
      const grant = stateOf(host).fuxunGranted?.[ownerId]
      if (grant) grant.used = true
    } },
  ],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, FUXUN)
      || !living({ state } as SkillHost).some((target) => target.id !== ownerId && target.zones.hand.length > 0)) return []
    return [{ id: `skill:${FUXUN}`, label: '发动【抚循】：获得或交给一名其他角色一张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${FUXUN}` || usedThisPhase(host.state, ownerId, FUXUN)) return
    const candidates = living(host).filter((target) => target.id !== ownerId && target.zones.hand.length > 0)
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, FUXUN)
    askTargets(host, FUXUN, ownerId, 'target', '【抚循】：选择一名其他角色', candidates.map((target) => target.id), 1, 1)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || target.id === ownerId || !target.zones.hand.length) return
      askOption(host, FUXUN, ownerId, 'direction', `【抚循】：获得${target.nickname}一张手牌，或交给其一张手牌？`, [
        { id: 'gain', label: '获得其一张手牌' }, { id: 'give', label: '交给其一张手牌' },
      ], { targetId })
      return
    }
    if (resolution.step === 'direction') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      const direction = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive || !target?.alive || (direction !== 'gain' && direction !== 'give')) return
      const cards = direction === 'gain' ? target.zones.hand : owner.zones.hand
      if (!cards.length) return
      if (direction === 'gain') {
        host.askSkill({ skillId: FUXUN, ownerId, step: 'take-card', data: { targetId, handBefore: owner.zones.hand.length }, build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【抚循】：选择获得${target.nickname}的一张手牌`, timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: [], hiddenCardSlots: cards.map((_, index) => hiddenHandSlot(targetId, index)), min: 1, max: 1,
        }) })
      } else askCards(host, FUXUN, ownerId, 'give-card', `【抚循】：选择交给${target.nickname}的一张手牌`, cards, 1, 1, { targetId, handBefore: owner.zones.hand.length }, false)
      return
    }
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const phase = stateOf(host).fuxunPhase?.[ownerId]
    if (!owner?.alive || !target?.alive || !phase) return
    phase.exempt = true
    let moved = false
    if (resolution.step === 'take-card') {
      const chosen = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = chosen ? resolvePickedCard(host.state, targetId, chosen) : null
      if (cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: FUXUN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: FUXUN }, { targetId: ownerId, cardIds: [cardId] })
        moved = true
      }
    } else if (resolution.step === 'give-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && owner.zones.hand.includes(cardId)) { giveCards(host as never, ownerId, targetId, [cardId], FUXUN); moved = true }
    }
    phase.exempt = false
    if (!moved) return
    if (owner.zones.hand.length === target.zones.hand.length && !phase.changed.includes(ownerId) && !phase.changed.includes(targetId)) {
      stateOf(host).fuxunGranted ??= {}
      stateOf(host).fuxunGranted[ownerId] = { phaseKey: phase.phaseKey, used: false }
    }
  },
})

const CHENYA = sid('chenya-wanghun')
const JIANYUAN = sid('jianyuan-wanglun')
function isPlayOnceSkill(host: SkillHost, playerId: PlayerId, skillId: string | undefined): boolean {
  const characterId = playerOf(host.state, playerId)?.characterId
  if (!characterId || !skillId) return false
  return getCharacter(characterId)?.skills.find((skill) => skill.id === skillId)?.description.includes('出牌阶段限一次') ?? false
}
function registerReforgeTrigger(skillId: string, kind: 'hand-count' | 'phase-use') {
  registerSkillRuntime({ id: skillId, triggers: [
    { event: 'PhaseStart', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || !payload.playerId) return
      stateOf(host).playPhaseUses ??= {}
      stateOf(host).playPhaseUses[payload.playerId] = { key: `${host.state.turnNumber}:${payload.playerId}`, count: 0 }
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const actorId = context.event.sourceId
      if (!actorId || host.state.phase !== 'play') return
      stateOf(host).playPhaseUses ??= {}
      const key = `${host.state.turnNumber}:${actorId}`
      const record = stateOf(host).playPhaseUses[actorId]
      stateOf(host).playPhaseUses[actorId] = { key, count: record?.key === key ? record.count + 1 : 1 }
    } },
    { event: 'SkillActivated', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; skillId?: string }
      const targetId = payload.playerId ?? context.event.sourceId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || host.state.phase !== 'play' || !isPlayOnceSkill(host, target.id, payload.skillId)) return
      const x = kind === 'hand-count' ? target.zones.hand.length : (stateOf(host).playPhaseUses?.[target.id]?.count ?? 0)
      const candidates = target.zones.hand.filter((cardId) => nameLength(host.state.cards[cardId]?.name) === x)
      if (!candidates.length || x < 0) return
      host.queueSkill({ skillId, ownerId, step: 'invoke', data: { targetId, x } })
    } },
  ], startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const x = Number(prompt.data.x)
    const candidates = target?.zones.hand.filter((cardId) => nameLength(host.state.cards[cardId]?.name) === x) ?? []
    if (!target?.alive || !candidates.length || x < 0 || host.state.phase !== 'play') return
    host.askSkill({ skillId, ownerId, step: 'invoke', data: { targetId, x, candidates }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【${skillId === CHENYA ? '沉雅' : '简远'}】：是否令${target.nickname}重铸牌名字数为${x}的手牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
  }, resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cards = (resolution.data.candidates as CardId[]).filter((cardId) => target?.zones.hand.includes(cardId))
      if (!target?.alive || !cards.length) return
      host.askSkill({ skillId, ownerId, step: 'cards', data: { targetId }, build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId, prompt: `【${skillId === CHENYA ? '沉雅' : '简远'}】：选择任意张牌重铸`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: cards.length,
      }) })
      return
    }
    if (resolution.step !== 'cards') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = target?.alive && cards.length === new Set(cards).size && cards.every((cardId) => target.zones.hand.includes(cardId))
    if (!valid || !cards.length) return
    for (const cardId of cards) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: 'recast' }, { sourceId: targetId, cardIds: [cardId] })
    }
    drawCards(host.state, host.rng, targetId, cards.length, (name, payload) => host.dispatch(name, payload))
    activate(host, ownerId, skillId, skillId === CHENYA ? '沉雅' : '简远', [targetId])
  },
  })
}
registerReforgeTrigger(CHENYA, 'hand-count')
registerReforgeTrigger(JIANYUAN, 'phase-use')

registerSkillRuntime({ id: QUHUO, triggers: [{ event: 'HandCardLeft', handle(host, ownerId, context) {
  const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; destination?: { kind?: string } | null }
  if (payload.playerId !== ownerId || !payload.cardId || ['processingArea', 'equipment'].includes(payload.destination?.kind ?? '')) return
  if (payload.destination?.kind === 'discardPile' && discardEntryOf(host.state, payload.cardId)?.reason !== 'other') return
  const card = host.state.cards[payload.cardId]
  if (!card || (card.name !== '酒' && card.category !== 'equipment')) return
  const state = stateOf(host)
  state.quhuoUsed ??= {}
  if (state.quhuoUsed[ownerId] === host.state.turnNumber) return
  state.quhuoUsed[ownerId] = host.state.turnNumber
  const candidates = clanmates(host, ownerId).filter((player) => player.hp < player.maxHp)
  if (!candidates.length) return
  askTargets(host, QUHUO, ownerId, 'target', '【去惑】：令一名同族角色回复1点体力', candidates.map((player) => player.id))
} }], resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'target') return
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const target = targetId ? playerOf(host.state, targetId) : undefined
  if (target?.alive && target.hp < target.maxHp && clanmates(host, ownerId).some((player) => player.id === targetId)) {
    recover(host as never, targetId!, 1, ownerId)
    activate(host, ownerId, QUHUO, '去惑', [targetId!])
  }
} })

const GAOBIAN = sid('gaobian-wangshen')
registerSkillRuntime({ id: GAOBIAN, triggers: [
  { event: 'DamageSettled', handle(host, _ownerId, context) {
    const payload = context.event.payload as { finalAmount?: number }
    const targetId = context.event.targetId
    if (!targetId || Number(payload.finalAmount ?? 0) <= 0) return
    const record = stateOf(host).gaobianDamage
    if (record?.turn === host.state.turnNumber) {
      if (!record.players.includes(targetId)) record.players.push(targetId)
    } else stateOf(host).gaobianDamage = { turn: host.state.turnNumber, players: [targetId] }
  } },
  { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId }
    const cardId = payload.cardId
    if (!cardId || host.state.cards[cardId]?.name !== '杀') return
    const state = stateOf(host)
    state.gaobianSlashes ??= {}
    const prior = state.gaobianSlashes[host.state.turnNumber] ?? []
    if (!prior.includes(cardId)) prior.push(cardId)
    state.gaobianSlashes[host.state.turnNumber] = prior
  } },
  { event: 'TurnEnd', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
    if (!payload.playerId || payload.playerId === ownerId) return
    const record = stateOf(host).gaobianDamage
    if (record?.turn !== payload.turnNumber || record.players.length !== 1) return
    const targetId = record.players[0]!
    const target = playerOf(host.state, targetId)
    const slashIds = (stateOf(host).gaobianSlashes?.[payload.turnNumber ?? host.state.turnNumber] ?? [])
      .filter((cardId: CardId) => host.state.zones.discardPile.includes(cardId) && host.state.cards[cardId]?.name === '杀')
    if (!target?.alive) return
    const actions: Extract<LegalAction, { kind: 'use-card' }>[] = []
    for (const cardId of slashIds as CardId[]) actions.push(...declaredCardActions(host.state, targetId, cardId, '杀', '【告变】：使用弃牌堆中的【杀】', { sourceSkillId: GAOBIAN })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card'))
    if (!actions.length) { loseHp(host as never, targetId, 1, GAOBIAN); return }
    askOption(host, GAOBIAN, ownerId, 'compel', `【告变】：${target.nickname}须使用本回合进入弃牌堆的一张【杀】，否则失去1点体力`, [
      ...actions.map((action) => ({ id: action.id, label: action.label })),
      { id: 'lose-hp', label: '失去1点体力' },
    ], { targetId, actions: actions.map((action) => ({ id: action.id, cardId: action.cardIds[0] })) }, false, targetId)
  } },
], resume(host, _ownerId, resolution, response) {
  if (resolution.step !== 'compel') return
  const targetId = resolution.data.targetId as PlayerId
  const selected = (response.payload as { optionId?: string }).optionId
  const entry = (resolution.data.actions as Array<{ id: string; cardId: CardId }>).find((action) => action.id === selected)
  if (!entry || !host.state.zones.discardPile.includes(entry.cardId)) { loseHp(host as never, targetId, 1, GAOBIAN); return }
  moveCard(host.state, entry.cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
  if (!host.beginSkillCardUseFromProcessing(targetId, entry.cardId, GAOBIAN, entry.id)) {
    if (host.state.zones.processingArea.includes(entry.cardId)) moveCard(host.state, entry.cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    loseHp(host as never, targetId, 1, GAOBIAN)
  }
} })

const QIEYI = sid('qieyi-yangci')
registerSkillRuntime({ id: QIEYI, triggers: [
  { event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    stateOf(host).qieyi ??= {}
    stateOf(host).qieyi[ownerId] = { turn: host.state.turnNumber, uses: 0, suits: [] }
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (payload.playerId !== ownerId || payload.phase !== 'play' || !owner?.alive || !host.state.zones.drawPile.length) return
    const top = host.state.zones.drawPile.slice(0, 2)
    host.askSkill({ skillId: QIEYI, ownerId, step: 'view-top', data: { turn: host.state.turnNumber, top }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【切议】：观看牌堆顶至多两张牌（不选择牌）', timeoutMs: 25_000,
      optional: true, purpose: 'skill', cardIds: top, hiddenCardSlots: [], min: 0, max: 0,
    }) })
  } },
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { cardId?: CardId }
    const cardId = payload.cardId
    const card = cardId ? host.state.cards[cardId] : undefined
    if (!card) return
    const state = stateOf(host)
    state.qieyi ??= {}
    const record = state.qieyi[ownerId] ?? { turn: host.state.turnNumber, uses: 0, suits: [] }
    if (record.turn !== host.state.turnNumber) Object.assign(record, { turn: host.state.turnNumber, uses: 0, suits: [] })
    const suit = effectiveCardSuit(host.state, ownerId, cardId!)
    if (record.suits.includes(suit)) return
    record.suits.push(suit)
    if (!record.uses) { state.qieyi[ownerId] = record; return }
    state.qieyiPending ??= {}
    state.qieyiPending[ownerId] = { cardId, category: card.category as CardCategory, color: effectiveCardColor(host.state, ownerId, cardId!) }
    state.qieyi[ownerId] = record
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const pending = stateOf(host).qieyiPending?.[ownerId]
    const usedCardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!pending || pending.cardId !== usedCardId) return
    delete stateOf(host).qieyiPending[ownerId]
    const top = revealTopCards(host.state, host.rng, 1, QIEYI, (name, payload) => host.dispatch(name, payload))[0]
    if (!top) return
    const revealed = host.state.cards[top]!
    if (revealed.category === pending.category || effectiveCardColor(host.state, ownerId, top) === pending.color) {
      moveCard(host.state, top, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [top], reason: QIEYI }, { sourceId: ownerId, targetId: ownerId, cardIds: [top] })
      return
    }
    const hand = handOf(host.state, ownerId)
    if (!hand.length) { moveCard(host.state, top, { kind: 'processingArea' }, { kind: 'discardPile' }); return }
    stateOf(host).qieyiPending ??= {}
    stateOf(host).qieyiPending[ownerId] = { top, cardId: usedCardId }
    askCards(host, QIEYI, ownerId, 'put-top', '【切议】：将一张手牌置于牌堆顶', hand, 1, 1, { top }, false)
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'view-top') {
    if ((response.payload as { cardIds?: CardId[] }).cardIds?.length) return
    const state = stateOf(host)
    state.qieyi ??= {}
    const record = state.qieyi[ownerId] ?? { turn: host.state.turnNumber, uses: 0, suits: [] }
    if (record.turn !== host.state.turnNumber) Object.assign(record, { turn: host.state.turnNumber, uses: 0, suits: [] })
    record.uses += 1
    state.qieyi[ownerId] = record
    activate(host, ownerId, QIEYI, '切议')
    return
  }
  if (resolution.step !== 'put-top') return
  const top = resolution.data.top as CardId
  const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
  if (cardId && handOf(host.state, ownerId).includes(cardId)) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
  if (host.state.zones.processingArea.includes(top)) moveCard(host.state, top, { kind: 'processingArea' }, { kind: 'discardPile' })
} })

const JIANZHENG = sid('jianzheng-yangci')
const JIANZHENG_TAG = 'historical-batch68-jianzheng'
function continueJianzhengDistribution(host: SkillHost, ownerId: PlayerId): void {
  const pending = stateOf(host).jianzhengPending?.[ownerId]
  if (!pending) return
  const cardId = pending.remaining.shift() as CardId | undefined
  if (!cardId) {
    delete stateOf(host).jianzhengPending[ownerId]
    if (pending.penalty && playerOf(host.state, ownerId)?.alive)
      resolveDamage(host as never, { sourceId: null, targetId: ownerId, amount: 1, nature: 'thunder', cardId: null, cardName: JIANZHENG })
    return
  }
  const candidates = living(host)
  if (!candidates.length) {
    if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    continueJianzhengDistribution(host, ownerId)
    return
  }
  askTargets(host, JIANZHENG, ownerId, `distribute:${cardId}`, '【谏直】：将此判定牌分配给一名角色', candidates.map((player) => player.id), 1, 1, { cardId }, false)
}

registerJudgmentContinuation(JIANZHENG_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const progress = stateOf(host as SkillHost).jianzhengProgress?.[ownerId]
  if (!progress) {
    if (host.state.judgmentRetention) host.state.judgmentRetention = null
    if (host.state.zones.processingArea.includes(judged.id)) moveCard(host.state, judged.id, { kind: 'processingArea' }, { kind: 'discardPile' })
    return
  }
  progress.results.push({ cardId: judged.id, suit: judged.suit })
  progress.remaining -= 1
  if (progress.remaining > 0) {
    performJudgment(host, ownerId, '谏直', { tag: JIANZHENG_TAG, data: { ownerId } })
    return
  }
  const retention = host.state.judgmentRetention
  const retainedIds = retention?.cardIds ?? []
  const matching = progress.results.filter((result: { cardId: CardId; suit: string }) => progress.usedSuits.includes(result.suit))
    .map((result: { cardId: CardId }) => result.cardId)
  const mismatching = retainedIds.filter((cardId) => !matching.includes(cardId))
  host.state.judgmentRetention = null
  for (const cardId of mismatching) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  stateOf(host as SkillHost).jianzhengPending ??= {}
  stateOf(host as SkillHost).jianzhengPending[ownerId] = { remaining: matching, penalty: mismatching.length > 0 }
  delete stateOf(host as SkillHost).jianzhengProgress[ownerId]
  continueJianzhengDistribution(host as SkillHost, ownerId)
})

registerSkillRuntime({ id: JIANZHENG, triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
  const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
  const record = stateOf(host).qieyi?.[ownerId]
  if (phase.playerId !== ownerId || phase.phase !== 'finish' || record?.turn !== host.state.turnNumber || record.uses < 1) return
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  stateOf(host).jianzhengProgress ??= {}
  stateOf(host).jianzhengProgress[ownerId] = { remaining: record.uses, usedSuits: [...record.suits], results: [] }
  beginJudgmentRetention(host.state, ownerId, JIANZHENG_TAG)
  performJudgment(host as never, ownerId, '谏直', { tag: JIANZHENG_TAG, data: { ownerId } })
} }], resume(host, ownerId, resolution, response) {
  if (!resolution.step.startsWith('distribute:')) return
  const cardId = resolution.data.cardId as CardId
  const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
  const target = targetId ? playerOf(host.state, targetId) : undefined
  if (target?.alive && host.state.zones.processingArea.includes(cardId)) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId! })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: JIANZHENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  } else if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  continueJianzhengDistribution(host, ownerId)
} })

const JIELI = sid('jieli-zhongyao')
registerSkillRuntime({ id: JIELI, triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const cardName = (context.event.payload as { cardName?: string }).cardName
    const length = nameLength(cardName)
    if (length) {
      stateOf(host).jieliMaxUsedName ??= {}
      stateOf(host).jieliMaxUsedName[ownerId] = Math.max(stateOf(host).jieliMaxUsedName[ownerId] ?? 0, length)
    }
  } },
  { event: 'TurnStart', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId) {
      stateOf(host).jieliMaxUsedName ??= {}
      stateOf(host).jieliMaxUsedName[ownerId] = 0
    }
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const amount = stateOf(host).jieliMaxUsedName?.[ownerId] ?? 0
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || amount < 1) return
    const candidates = living(host).filter((target) => target.zones.hand.length > 0)
    if (!candidates.length) return
    askTargets(host, JIELI, ownerId, 'target', `【诫厉】：选择一名角色，观看其牌名字数最多的手牌及牌堆顶${amount}张牌`, candidates.map((target) => target.id))
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const amount = stateOf(host).jieliMaxUsedName?.[ownerId] ?? 0
    if (!target?.alive || amount < 1) return
    const maxLength = Math.max(...target.zones.hand.map((cardId) => nameLength(host.state.cards[cardId]?.name)))
    const handCandidates = target.zones.hand.filter((cardId) => nameLength(host.state.cards[cardId]?.name) === maxLength)
    const revealed = revealTopCards(host.state, host.rng, amount, JIELI, (name, payload) => host.dispatch(name, payload))
    if (!handCandidates.length || !revealed.length) {
      for (const cardId of [...revealed].reverse()) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    stateOf(host).jieliPending ??= {}
    stateOf(host).jieliPending[ownerId] = { targetId, handCandidates, revealed, amount }
    host.askSkill({ skillId: JIELI, ownerId, step: 'hand-cards', data: { targetId, handCandidates, revealed }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【诫厉】：选择至多${Math.min(handCandidates.length, revealed.length)}张该角色牌名字数最多的手牌`,
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: handCandidates, hiddenCardSlots: [], min: 0, max: Math.min(handCandidates.length, revealed.length),
    }) })
    return
  }
  if (resolution.step === 'hand-cards') {
    const pending = stateOf(host).jieliPending?.[ownerId]
    const target = pending ? playerOf(host.state, pending.targetId) : undefined
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!pending || !target?.alive || selected.length !== new Set(selected).size || selected.some((id) => !pending.handCandidates.includes(id) || !target.zones.hand.includes(id))) {
      if (pending) for (const cardId of [...pending.revealed].reverse()) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      delete stateOf(host).jieliPending?.[ownerId]
      return
    }
    if (!selected.length) {
      for (const cardId of [...pending.revealed].reverse()) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      delete stateOf(host).jieliPending[ownerId]
      return
    }
    host.askSkill({ skillId: JIELI, ownerId, step: 'top-cards', data: { selected, targetId: pending.targetId, revealed: pending.revealed }, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: `【诫厉】：选择${selected.length}张牌堆顶亮出的牌与其交换`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: pending.revealed, hiddenCardSlots: [], min: selected.length, max: selected.length,
    }) })
    return
  }
  if (resolution.step !== 'top-cards') return
  const pending = stateOf(host).jieliPending?.[ownerId]
  const selectedHand = (resolution.data.selected as CardId[]).filter((cardId) => playerOf(host.state, resolution.data.targetId as PlayerId)?.zones.hand.includes(cardId))
  const selectedTop = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
  if (!pending || selectedTop.length !== selectedHand.length || selectedTop.length !== new Set(selectedTop).size || selectedTop.some((id) => !pending.revealed.includes(id) || !host.state.zones.processingArea.includes(id))) {
    if (pending) for (const cardId of [...pending.revealed].reverse()) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    delete stateOf(host).jieliPending?.[ownerId]
    return
  }
  const targetId = pending.targetId
  const target = playerOf(host.state, targetId)
  if (!target?.alive) {
    for (const cardId of [...pending.revealed].reverse()) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    delete stateOf(host).jieliPending?.[ownerId]
    return
  }
  const positions = selectedTop.map((cardId) => pending.revealed.indexOf(cardId))
  const replacements = [...selectedHand]
  for (let index = pending.revealed.length - 1; index >= 0; index -= 1) {
    const revealedId = pending.revealed[index]!
    const replaceAt = positions.indexOf(index)
    if (replaceAt >= 0) {
      const handId = replacements[replaceAt]!
      moveCard(host.state, handId, { kind: 'hand', playerId: targetId }, { kind: 'drawPile' }, { toTop: true })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [handId], reason: JIELI }, { sourceId: ownerId, targetId, cardIds: [handId] })
      moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [revealedId], reason: JIELI }, { sourceId: ownerId, targetId, cardIds: [revealedId] })
    } else if (host.state.zones.processingArea.includes(revealedId)) moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
  delete stateOf(host).jieliPending[ownerId]
  activate(host, ownerId, JIELI, '诫厉', [targetId])
} })

const QIUXIN = sid('qiuxin-wanglun')
function qiuxinUseActions(state: SanguoshaState, ownerId: PlayerId, mode: 'slash' | 'trick'): Extract<LegalAction, { kind: 'use-card' }>[] {
  const hand = handOf(state, ownerId)
  const runtimes = skillsOf(state, ownerId, skillIdsOf).filter((runtime) => runtime.id !== QIUXIN)
  const actions = hand.flatMap((cardId) => {
    const card = state.cards[cardId]
    if (!card) return []
    const declarations = [
      { name: card.name, skillId: undefined as string | undefined },
      ...runtimes.flatMap((runtime) => (runtime.viewAs?.(state, ownerId) ?? [])
        .filter((option) => option.cardId === cardId).map((option) => ({ name: option.asCardName, skillId: runtime.id }))),
    ]
    return declarations.flatMap(({ name, skillId }) => {
      const allowed = mode === 'slash' ? name === '杀' : INSTANT_TRICKS.has(name)
      if (!allowed) return []
      return declaredCardActions(state, ownerId, cardId, name, `【求心】使用【${name}】`, skillId ? { sourceSkillId: skillId } : {})
    })
  })
  const useActions = actions.filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
  return [...new Map(useActions.map((action) => [action.id, action])).values()]
}
registerSkillRuntime({ id: QIUXIN,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    if (context.event.sourceId !== ownerId || payload.sourceSkillId !== QIUXIN) return
    const state = stateOf(host)
    state.qiuxinMode ??= {}
    state.qiuxinMode[ownerId] = state.qiuxinMode[ownerId] === 'trick' ? 'slash' : 'trick'
    delete state.qiuxinPending?.[ownerId]
  } }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const mode = (state as B68State).b68?.qiuxinMode?.[ownerId] ?? 'slash'
    const hasAction = qiuxinUseActions(state, ownerId, mode).some((action) => action.targetIds.some((targetId) => targetId !== ownerId))
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && hasAction && !usedThisPhase(state, ownerId, QIUXIN)
      ? [{ id: `skill:${QIUXIN}`, label: `发动【求心】：令一名角色选择使用【${mode === 'slash' ? '杀' : '普通锦囊'}】` }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${QIUXIN}` || usedThisPhase(host.state, ownerId, QIUXIN)) return
    const candidates = living(host).filter((player) => player.id !== ownerId)
    if (!candidates.length) return
    markUsedThisPhase(host.state, ownerId, QIUXIN)
    askTargets(host, QIUXIN, ownerId, 'target', '【求心】：选择一名其他角色', candidates.map((player) => player.id))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const mode = stateOf(host).qiuxinMode?.[ownerId] ?? 'slash'
      askOption(host, QIUXIN, ownerId, 'declare', `【求心】：声明要${mode === 'slash' ? '使用【杀】' : '使用一张普通锦囊牌'}`, [
        { id: 'accept', label: '声明执行此项' }, { id: 'refuse', label: '拒绝' },
      ], { targetId, mode }, true, targetId)
      return
    }
    if (resolution.step === 'use-card') {
      const actionId = (response.payload as { optionId?: string }).optionId
      const mode = resolution.data.mode as 'slash' | 'trick' | undefined
      const action = mode ? qiuxinUseActions(host.state, ownerId, mode).find((candidate) => candidate.id === actionId) : undefined
      if (!action || !action.targetIds.includes(resolution.data.targetId as PlayerId)) return
      executeUseCardAction(host as never, ownerId, { ...action, sourceSkillId: QIUXIN })
      return
    }
    if (resolution.step !== 'declare') return
    const data = resolution.data as { targetId: PlayerId; mode: 'slash' | 'trick' }
    if ((response.payload as { optionId?: string }).optionId !== 'accept') return
      const actions = qiuxinUseActions(host.state, ownerId, data.mode)
      .filter((action) => data.mode === 'slash'
        ? action.asCardName === '杀' && action.targetIds.includes(data.targetId)
        : INSTANT_TRICKS.has(action.asCardName) && action.targetIds.includes(data.targetId))
    if (!actions.length) return
    stateOf(host).qiuxinPending ??= {}
    stateOf(host).qiuxinPending[ownerId] = { targetId: data.targetId, mode: data.mode, actionIds: actions.map((action) => action.id) }
    askOption(host, QIUXIN, ownerId, 'use-card', '【求心】：选择一张合法牌对其使用', [
      ...actions.map((action) => ({ id: action.id, label: action.label })),
    ], { targetId: data.targetId, mode: data.mode, actions: actions.map((action) => ({ ...action })) }, false)
  },
})

const CHENGQI = sid('chengqi-zhongyao')
function chengqiNames(state: SanguoshaState) {
  const names = new Set(Object.values(state.cards).filter((card) => card.category === 'basic'
    || (card.category === 'trick' && INSTANT_TRICKS.has(card.name))).map((card) => card.name))
  return [...names]
}
registerSkillRuntime({ id: CHENGQI,
  viewAs(state, ownerId) {
    const pending = (state as B68State).b68?.chengqiPending?.[ownerId]
    if (!pending || pending.turn !== state.turnNumber || !playerOf(state, ownerId)?.zones.hand.includes(pending.carrierId)) return []
    return [{ cardId: pending.carrierId, asCardName: pending.name, label: `【承启】：将所选手牌当【${pending.name}】使用` }]
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const used = (state as B68State).b68?.chengqiUsed?.[ownerId]
    const usedNames = used?.turn === state.turnNumber ? used.names : []
    const hasNames = chengqiNames(state).some((name) => !usedNames.includes(name))
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && owner.zones.hand.length >= 2
      && hasNames && !(state as B68State).b68?.chengqiPending?.[ownerId]
      ? [{ id: `skill:${CHENGQI}`, label: '发动【承启】：将至少两张手牌当本回合未使用过的基本牌或普通锦囊牌使用' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${CHENGQI}`) return
    const used = stateOf(host).chengqiUsed?.[ownerId]
    const usedNames = used?.turn === host.state.turnNumber ? used.names : []
    const names = chengqiNames(host.state).filter((name) => !usedNames.includes(name))
    if (names.length) askOption(host, CHENGQI, ownerId, 'name', '【承启】：选择要使用的牌名', names.map((name) => ({ id: name, label: `当【${name}】使用` })), { names }, false)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== CHENGQI) return
      const pending = stateOf(host).chengqiPending?.[ownerId]
      const name = (context.event.payload as { cardName?: string }).cardName
      if (!pending || !name || pending.name !== name) return
      stateOf(host).chengqiUsed ??= {}
      const previous = stateOf(host).chengqiUsed[ownerId]
      const names = previous?.turn === host.state.turnNumber ? previous.names : []
      stateOf(host).chengqiUsed[ownerId] = { turn: host.state.turnNumber, names: [...new Set([...names, name])] }
      if (pending.totalNameLength === nameLength(name)) stateOf(host).chengqiReward ??= {}, stateOf(host).chengqiReward[ownerId] = true
      delete stateOf(host).chengqiPending[ownerId]
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId !== CHENGQI || !stateOf(host).chengqiReward?.[ownerId]) return
      delete stateOf(host).chengqiReward[ownerId]
      askTargets(host, CHENGQI, ownerId, 'draw-target', '【承启】：令一名角色摸一张牌', living(host).map((player) => player.id))
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'name') {
      const name = (response.payload as { optionId?: string }).optionId
      const allowed = resolution.data.names as string[] | undefined
      if (!name || !allowed?.includes(name) || !handOf(host.state, ownerId).length) return
      askCards(host, CHENGQI, ownerId, 'materials', `【承启】：选择至少两张手牌（牌名字数之和须不少于${nameLength(name)}）`, handOf(host.state, ownerId), 2, handOf(host.state, ownerId).length, { name })
      return
    }
    if (resolution.step === 'materials') {
      const name = resolution.data.name as string
      const cards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const unique = [...new Set(cards)]
      const totalNameLength = unique.reduce((sum, id) => sum + nameLength(host.state.cards[id]?.name), 0)
      if (unique.length < 2 || unique.length !== cards.length || unique.some((id) => !handOf(host.state, ownerId).includes(id)) || totalNameLength < nameLength(name)) {
        askCards(host, CHENGQI, ownerId, 'materials', `【承启】：选择至少两张手牌（牌名字数之和须不少于${nameLength(name)}）`, handOf(host.state, ownerId), 2, handOf(host.state, ownerId).length, { name })
        return
      }
      askCards(host, CHENGQI, ownerId, 'carrier', '【承启】：选择一张作为使用牌的载体', unique, 1, 1, { name, materials: unique, totalNameLength }, false)
      return
    }
    if (resolution.step === 'carrier') {
      const carrierId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const materials = resolution.data.materials as CardId[]
      const name = resolution.data.name as string
      const totalNameLength = Number(resolution.data.totalNameLength)
      if (!carrierId || !materials.includes(carrierId) || materials.some((id) => !handOf(host.state, ownerId).includes(id))) return
      stateOf(host).chengqiPending ??= {}
      stateOf(host).chengqiPending[ownerId] = { name, carrierId, materials, totalNameLength, turn: host.state.turnNumber }
      const actions = skillHandCardUseActions(host.state, ownerId, carrierId).filter((action) => action.asCardName === name)
      if (!actions.length) { delete stateOf(host).chengqiPending[ownerId]; return }
      askOption(host, CHENGQI, ownerId, 'use', `【承启】：使用【${name}】`, actions.map((action) => ({ id: action.id, label: action.label })), { actions: actions.map((action) => action.id), materials, carrierId }, false)
      return
    }
    if (resolution.step === 'use') {
      const actionId = (response.payload as { optionId?: string }).optionId
      const pending = stateOf(host).chengqiPending?.[ownerId]
      const action = pending && skillHandCardUseActions(host.state, ownerId, pending.carrierId).find((candidate) => candidate.id === actionId && candidate.asCardName === pending.name)
      if (!pending || !action || pending.materials.some((id: CardId) => !handOf(host.state, ownerId).includes(id))) { delete stateOf(host).chengqiPending?.[ownerId]; return }
      const costs = pending.materials.filter((id: CardId) => id !== pending.carrierId)
      if (costs.length) discardCardsByIds(host as never, ownerId, costs, CHENGQI)
      executeUseCardAction(host as never, ownerId, action)
      return
    }
    if (resolution.step === 'draw-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
    }
  },
})

const JIEWU = sid('jiewu-yangxiu')
const GAOSHI = sid('gaoshi-yangxiu')
registerSkillRuntime({ id: JIEWU, triggers: [
  { event: 'TurnStart', handle(host, ownerId) {
    stateOf(host).jiewuShown ??= {}
    stateOf(host).jiewuShown[ownerId] = []
  } },
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play' || usedThisPhase(host.state, ownerId, JIEWU)) return
    const candidates = living(host).filter((player) => player.zones.hand.length > 0)
    if (candidates.length) askTargets(host, JIEWU, ownerId, 'target', '【捷悟】：选择一名角色，其手牌于此阶段对你可见', candidates.map((player) => player.id))
  } },
  { event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'play') return
    const state = host.state
    const targetId = stateOf(host).jiewuTarget?.[ownerId]?.targetId
    if (targetId) {
      const viewers = state.privateRevealedHands?.[ownerId]?.filter((id) => id !== targetId) ?? []
      if (viewers.length) state.privateRevealedHands![ownerId] = viewers
      else delete state.privateRevealedHands?.[ownerId]
      delete stateOf(host).jiewuTarget[ownerId]
    }
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const targetId = stateOf(host).jiewuTarget?.[ownerId]?.targetId as PlayerId | undefined
    const targets = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !targets.some((id) => id !== ownerId) || !handOf(host.state, targetId).length) return
    const cardId = context.event.cardIds?.[0]
    const suit = cardId ? effectiveCardSuit(host.state, ownerId, cardId) : null
    askOption(host, JIEWU, ownerId, 'invoke', '【捷悟】：是否展示该角色一张手牌', [
      { id: 'yes', label: '展示一张手牌' }, { id: 'no', label: '不展示' },
    ], { targetId, suit }, true)
  } },
], resume(host, ownerId, resolution, response) {
  if (resolution.step === 'target') {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    stateOf(host).jiewuTarget ??= {}
    stateOf(host).jiewuTarget[ownerId] = { targetId, turn: host.state.turnNumber }
    markUsedThisPhase(host.state, ownerId, JIEWU)
    stateOf(host).jiewuUses ??= {}
    const previous = stateOf(host).jiewuUses[ownerId]
    stateOf(host).jiewuUses[ownerId] = { turn: host.state.turnNumber, count: (previous?.turn === host.state.turnNumber ? previous.count : 0) + 1 }
    host.state.privateRevealedHands ??= {}
    host.state.privateRevealedHands[ownerId] = [...new Set([...(host.state.privateRevealedHands[ownerId] ?? []), targetId])]
    activate(host, ownerId, JIEWU, '捷悟', [targetId])
    return
  }
  if (resolution.step === 'invoke') {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const cards = handOf(host.state, targetId)
    if (cards.length) askCards(host, JIEWU, ownerId, 'show-card', '【捷悟】：展示所选角色一张手牌', cards, 1, 1, { targetId, suit: resolution.data.suit })
    return
  }
  if (resolution.step === 'show-card') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !handOf(host.state, targetId).includes(cardId)) return
    const wasShown = (stateOf(host).jiewuShown?.[ownerId] ?? []).includes(cardId)
    stateOf(host).jiewuShown ??= {}
    stateOf(host).jiewuShown[ownerId] = [...new Set([...(stateOf(host).jiewuShown[ownerId] ?? []), cardId])]
    const usedSuit = resolution.data.suit as string | null
    if (usedSuit && effectiveCardSuit(host.state, targetId, cardId) === usedSuit)
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    if (wasShown) {
      const ownerHand = handOf(host.state, ownerId)
      const targetHand = handOf(host.state, targetId)
      if (ownerHand.length > targetHand.length) askCards(host, JIEWU, ownerId, 'put-top', '【捷悟】：将你的一张手牌置于牌堆顶', ownerHand, 1, 1, { targetId })
      else if (targetHand.length > ownerHand.length) askCards(host, JIEWU, ownerId, 'put-top', '【捷悟】：将该角色的一张手牌置于牌堆顶', targetHand, 1, 1, { targetId })
    }
    return
  }
  if (resolution.step === 'put-top') {
    const targetId = resolution.data.targetId as PlayerId
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const ownerHand = handOf(host.state, ownerId)
    const targetHand = handOf(host.state, targetId)
    const fromOwner = ownerHand.length > targetHand.length
    const fromTarget = targetHand.length > ownerHand.length
    const sourceId = fromOwner ? ownerId : fromTarget ? targetId : null
    if (!sourceId || !cardId || !handOf(host.state, sourceId).includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'drawPile' }, { toTop: true })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: JIEWU }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
  }
} })

registerSkillRuntime({ id: GAOSHI,
  triggers: [
  { event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'finish') return
    const count = stateOf(host).jiewuUses?.[ownerId]
    const amount = count?.turn === host.state.turnNumber ? count.count : 0
    if (amount > 0) askOption(host, GAOSHI, ownerId, 'invoke', `【高视】：是否亮出并使用牌堆顶牌（至少${amount}张）`, [
      { id: 'yes', label: '发动【高视】' }, { id: 'no', label: '不发动' },
    ], { amount })
  } },
  { event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    if (context.event.sourceId !== ownerId || payload.sourceSkillId !== GAOSHI) return
    const pending = stateOf(host).gaoshiPending?.[ownerId]
    const cardId = pending?.awaiting as CardId | undefined
    if (!pending || !cardId) return
    pending.used.push(cardId)
    pending.processed.push(cardId)
    delete pending.awaiting
    continueGaoshi(host, ownerId)
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const amount = Number(resolution.data.amount ?? 0)
      const usedNames = (host.state.cardUseHistory ?? []).filter((entry) => entry.turnNumber === host.state.turnNumber && entry.sourceId === ownerId).map((entry) => entry.cardName)
      const revealIds: CardId[] = []
      while (host.state.zones.drawPile.length && revealIds.length < amount) {
        const [cardId] = revealTopCards(host.state, host.rng, 1, GAOSHI, (name, payload) => host.dispatch(name, payload))
        if (!cardId) break
        revealIds.push(cardId)
        if (usedNames.includes(host.state.cards[cardId]?.name ?? '')) break
      }
      if (!revealIds.length) return
      stateOf(host).gaoshiPending ??= {}
      stateOf(host).gaoshiPending[ownerId] = { revealed: revealIds, used: [], processed: [] }
      continueGaoshi(host, ownerId)
      return
    }
    const pending = stateOf(host).gaoshiPending?.[ownerId]
    if (!pending || resolution.step !== 'use-cards') return
    const chosen = (response.payload as { optionId?: string }).optionId
    if (chosen === 'stop') {
      pending.processed.push(...pending.revealed.filter((id: CardId) => !pending.processed.includes(id)))
      continueGaoshi(host, ownerId)
      return
    }
    const action = (resolution.data.actions as LegalAction[] | undefined)?.find((entry) => entry.id === chosen)
    const cardId = action?.kind === 'use-card' ? action.cardIds[0] : undefined
    if (!action || !cardId || !pending.revealed.includes(cardId) || pending.processed.includes(cardId)
      || !host.state.zones.processingArea.includes(cardId)) return
    const currentAction = processingCardUseActions(host, ownerId, cardId).find((entry) => entry.id === action.id)
    if (!currentAction) return
    pending.awaiting = cardId
    const started = host.beginSkillCardUseFromProcessing(ownerId, cardId, GAOSHI, currentAction.id)
    if (!started) {
      delete pending.awaiting
      pending.processed.push(cardId)
      continueGaoshi(host, ownerId)
    }
  },
})

function continueGaoshi(host: SkillHost, ownerId: PlayerId) {
  const pending = stateOf(host).gaoshiPending?.[ownerId]
  if (!pending) return
  if (!playerOf(host.state, ownerId)?.alive) {
    for (const cardId of pending.revealed) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    delete stateOf(host).gaoshiPending[ownerId]
    return
  }
  const remaining = pending.revealed.filter((id: CardId) => !pending.processed.includes(id)) as CardId[]
  if (!remaining.length) {
    const allUsed = pending.used.length === pending.revealed.length
    for (const cardId of pending.revealed) if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    delete stateOf(host).gaoshiPending[ownerId]
    if (allUsed) drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    activate(host, ownerId, GAOSHI, '高视')
    return
  }
  const actions = remaining.flatMap((cardId) => host.state.zones.processingArea.includes(cardId)
    ? processingCardUseActions(host, ownerId, cardId) : [])
  if (!actions.length) {
    pending.processed.push(...remaining)
    continueGaoshi(host, ownerId)
    return
  }
  askOption(host, GAOSHI, ownerId, 'use-cards', '【高视】：选择一张亮出的牌使用，或结束使用', [
    ...actions.map((action) => ({ id: action.id, label: action.label })), { id: 'stop', label: '结束使用' },
  ], { actions }, false)
}

function processingCardUseActions(host: SkillHost, ownerId: PlayerId, cardId: CardId): Extract<LegalAction, { kind: 'use-card' }>[] {
  const owner = playerOf(host.state, ownerId)
  if (!owner || !host.state.zones.processingArea.includes(cardId)) return []
  const originalHand = owner.zones.hand
  owner.zones.hand = [...originalHand, cardId]
  try {
    return skillHandCardUseActions(host.state, ownerId, cardId)
  } finally {
    owner.zones.hand = originalHand
  }
}
