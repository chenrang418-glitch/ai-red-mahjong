import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import { discardCardsByIds, discardCardsByOwners } from '../../engine/discard-all'
import { registerSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest } from '../../engine/requests'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { GroupDecisionState } from '../../engine/types'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { skillDiscardCardUseActions } from '../../engine/cards/basic'
import { executeUseCardAction } from '../../engine/cards/basic'
import { drawCards } from '../../engine/draw'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { recover } from '../../engine/recover'
import { resolveDamage, resolveDamageSequence } from '../../engine/damage'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { suppressSkill } from '../../engine/skill-suppression'
import { effectiveCardColor, effectiveCardSuit } from '../../engine/skills/runtime'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { instantTrickActions } from '../../engine/cards/tricks'
import { createVirtualTrick, virtualTrickChoices } from '../../engine/virtual-trick'
import { flipCharacter, restoreCharacter } from '../../engine/character-state'
import { hiddenHandSlot } from '../../engine/cards/host'
import { moveCard, recordCardHandEntry } from '../../engine/zones'
import { ruleCardNumber, reshuffleDrawPile } from '../../engine/deck'
import { consumeGainCardCount } from '../../engine/card-gain-modifier'
import { DrawAttemptInterrupted } from '../../engine/draw'
import { drawsFromBottomFor } from '../../engine/skills/runtime'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { effectiveCardName } from '../../engine/zones'
import { skillOtherHandCardUseActions, declaredCardActions } from '../../engine/cards/basic'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { claimDeathCards, heldDeathCards, releaseDeathCards } from '../../engine/death-claim'
import { effectiveKingdomOf } from '../../engine/huashen'
import { giveCards } from '../../engine/hand-transfer'

const B = '-b83'
const sid = (name: string) => `${name}${B}`
const ZHANGHUAN_YIJU = sid('yiju-zhanghuan')
const ZHANGHUAN_SHUGUO = sid('shuguo-zhanghuan')
const XING_TAISHICI_ZHONGWEI = sid('zhongwei-xingtaishici')
const XING_TAISHICI_CHONGZU = sid('chongzu-xingtaishici')
const WUZHI_YUANRONG = sid('yuanrong-wuzhi')
const RENWAN_RENSHUANG = sid('renshuang-renwan')
const RENWAN_JUANJI = sid('juanji-renwan')
const WUFU_ZHONGE = sid('zhonge-wufu')
const WUFU_JUEKAI = sid('juekai-wufu')
const WUFU_ZHONGE_GROUP = `${WUFU_ZHONGE}:simultaneous-choice`
const WUZHI_WEITI = sid('weiti-wuzhi')
const WUZHI_WEITI_USES = [sid('weiti-wuzhi:1'), sid('weiti-wuzhi:2')] as const
const DONGXU_QINGLENG = sid('qingleng-dongxu')
const DONGXU_ZHENDU = sid('zhendu-dongxu')
const JIMIAO_ZOUYI = sid('zouyi-jimiaojimu')
const JIMIAO_YANXI = sid('yanxi-jimiaojimu')
const WEICAOPI_DIANLUN = sid('dianlun-weicaopi')
const WEICAOPI_SUGANG = sid('sugang-weicaopi')
const WEICAOPI_JIWEI = sid('jiwei-weicaopi')
const WEICAOPI_SUGANG_JUDGE = `${WEICAOPI_SUGANG}:judge`
const XUWEN_FUHUI = sid('fuhui-xuwen')
const XUWEN_MOHUA = sid('mohua-xuwen')
const WEISUNCE_ZHEFENG = sid('zhefeng-weisunce')
const WEISUNCE_WEIJING = sid('weijing-weisunce')

type DiscardRecord = { cardId: CardId; fromPlayerId: PlayerId | null; turnNumber: number }
type ShuguoFlow = { ownerId: PlayerId; turnNumber: number; records: DiscardRecord[]; index: number; usedCardIds: CardId[]; pendingCardId?: CardId; pendingFromPlayerId?: PlayerId | null }
function b83(state: SanguoshaState): Record<string, any> {
  const extended = state as SanguoshaState & { b83?: Record<string, any> }
  extended.b83 ??= {}
  return extended.b83
}
type ChongzuState = { distance: number; upgraded: boolean; nextUnlimited: boolean; nextDamage: boolean; pendingResume?: { sourceId: PlayerId; targetId: PlayerId } }
function chongzuState(state: SanguoshaState, ownerId: PlayerId): ChongzuState {
  const all = (b83(state).chongzu ??= {}) as Record<PlayerId, ChongzuState>
  all[ownerId] ??= { distance: 3, upgraded: false, nextUnlimited: false, nextDamage: false }
  return all[ownerId]!
}
type YuanrongRecord = { cardId: CardId; fromPlayerId: PlayerId | null; turnNumber: number }
type YuanrongFlow = { turnNumber: number; cardId?: CardId; cardName?: string; stage?: 'black-pending' | 'red-pending' }
type JuekaiPhase = { gainedPlayerIds: PlayerId[]; active: boolean }
function juekaiPhases(state: SanguoshaState): Record<PlayerId, JuekaiPhase> {
  return (b83(state).juekaiPhases ??= {}) as Record<PlayerId, JuekaiPhase>
}
function cardsWithDistinctRanks(state: SanguoshaState, playerId: PlayerId): CardId[][] {
  const hand = player(state, playerId)?.zones.hand ?? []
  const pairs: CardId[][] = []
  for (let left = 0; left < hand.length; left += 1) for (let right = left + 1; right < hand.length; right += 1) {
    const a = ruleCardNumber(state, hand[left]!)
    const b = ruleCardNumber(state, hand[right]!)
    if (a !== null && b !== null && a !== b) pairs.push([hand[left]!, hand[right]!])
  }
  return pairs
}

function drawDifferentRankCards(host: SkillHost, targetId: PlayerId): CardId[] {
  const target = player(host.state, targetId)
  if (!target?.alive) return []
  const count = consumeGainCardCount(host.state, targetId, 2)
  const attemptIndex = count > 0 && host.state.drawOperationReplay ? host.state.drawAttemptIndex ?? 0 : -1
  if (count > 0 && host.state.drawOperationReplay) host.state.drawAttemptIndex = attemptIndex + 1
  if (count > 0) {
    const attempt = host.dispatch('DrawAttempt', { playerId: targetId, count, isDraw: true, attemptIndex })
    const interrupt = host.state.drawAttemptInterrupt?.attemptIndex === attemptIndex ? host.state.drawAttemptInterrupt : undefined
    if (interrupt) delete host.state.drawAttemptInterrupt
    if (interrupt || attempt.cancelled) {
      const replacementCardIds = interrupt?.replacementCardIds
        ?? (attempt.event.payload as { replacementCardIds?: CardId[] }).replacementCardIds
      if (replacementCardIds) return replacementCardIds
      if (host.state.drawOperationReplay) throw new DrawAttemptInterrupted(targetId, count, attemptIndex)
      return []
    }
  }

  const forbiddenRanks = new Set(target.zones.hand.map((cardId) => ruleCardNumber(host.state, cardId)).filter((rank): rank is number => rank !== null))
  const drawn: CardId[] = []
  const fromBottom = drawsFromBottomFor(host.state, targetId)
  while (drawn.length < count) {
    if (host.state.zones.drawPile.length === 0 && reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload)) === 0) break
    let candidateIndex = -1
    const start = fromBottom ? host.state.zones.drawPile.length - 1 : 0
    const step = fromBottom ? -1 : 1
    for (let index = start; index >= 0 && index < host.state.zones.drawPile.length; index += step) {
      const rank = ruleCardNumber(host.state, host.state.zones.drawPile[index]!)
      if (rank !== null && !forbiddenRanks.has(rank)) { candidateIndex = index; break }
    }
    if (candidateIndex < 0) break
    const cardId = host.state.zones.drawPile[candidateIndex]!
    const rank = ruleCardNumber(host.state, cardId)!
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
    forbiddenRanks.add(rank)
    drawn.push(cardId)
  }
  if (drawn.length) host.dispatch('GainCard', { playerId: targetId, cardIds: drawn, reason: WUZHI_WEITI, isDraw: true },
    { targetId, cardIds: drawn })
  return drawn
}
type WufuFlow = { targetId: PlayerId; operations: Array<'draw' | 'slash'>; operationIndex: number; actorIndex: number; actorRepeatIndex: number; ownerRepeatCount: number; pendingSlash?: PlayerId }
type QinglengFlow = { sourceId: PlayerId; cardId: CardId; cardName: string; discardTargetId?: PlayerId }
type ZhenduFlow = { cardIds: CardId[]; index: number; activeCardId?: CardId }
type ZouyiFlow = { selected: Array<'discard' | 'gift'>; index: number }
type YanxiFlow = { targetId: PlayerId }

registerGroupDecision(WUFU_ZHONGE_GROUP, (groupHost, decision: GroupDecisionState) => {
  const host = groupHost as unknown as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const targetId = decision.data.targetId as PlayerId
  const ownerChoice = decision.responses[ownerId]
  const targetChoice = decision.responses[targetId]
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  if (!owner?.alive || !target?.alive || !['draw', 'slash'].includes(ownerChoice ?? '') || !['draw', 'slash'].includes(targetChoice ?? '')) return
  const differs = ownerChoice !== targetChoice
  const operations = differs ? ['draw', 'slash'] as Array<'draw' | 'slash'> : [ownerChoice as 'draw' | 'slash']
  host.queueSkill({ skillId: WUFU_ZHONGE, ownerId, step: 'resolve', data: {
    targetId, operations, operationIndex: 0, actorIndex: 0, actorRepeatIndex: 0, ownerRepeatCount: differs ? 2 : 1,
  } satisfies WufuFlow })
})

registerSkillRuntime({
  id: WUZHI_WEITI,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== WUZHI_WEITI) return
    const targetId = context.event.targetId
    if (!targetId || !player(host.state, targetId)?.alive) return
    host.queueSkill({ skillId: WUZHI_WEITI, ownerId, step: 'draw-different-ranks', data: { targetId } })
  } }],
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.currentPlayerId === ownerId && state.phase === 'play' && owner?.alive
      && WUZHI_WEITI_USES.some((useId) => !usedThisPhase(state, ownerId, useId))
      ? [{ id: `${WUZHI_WEITI}:activate`, label: '伪涕：选择一项令一名角色执行' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    const availableUse = WUZHI_WEITI_USES.find((useId) => !usedThisPhase(host.state, ownerId, useId))
    if (actionId !== `${WUZHI_WEITI}:activate` || !owner?.alive || !availableUse
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    markUsedThisPhase(host.state, ownerId, availableUse)
    host.askSkill({ skillId: WUZHI_WEITI, ownerId, step: 'mode', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【伪涕】：选择一项令一名角色执行', timeoutMs: 25_000,
      optional: false, options: [
        { id: 'damage-draw', label: '受到1点伤害，然后摸2张与手牌点数均不同的牌' },
        { id: 'recover-discard', label: '回复1点体力，然后弃置2张点数不同的牌' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode !== 'damage-draw' && mode !== 'recover-discard') return
      const candidateIds = host.state.players.filter((entry) => entry.alive).map((entry) => entry.id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: WUZHI_WEITI, ownerId, step: 'target', data: { mode }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【伪涕】：选择执行此项的角色', timeoutMs: 25_000,
        optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const mode = resolution.data.mode as string
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!target?.alive) return
      if (mode === 'damage-draw') {
        resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, sourceSkillId: WUZHI_WEITI, reason: WUZHI_WEITI })
        return
      }
      if (mode !== 'recover-discard') return
      recover(host as never, target.id, 1, ownerId)
      const validPairs = cardsWithDistinctRanks(host.state, target.id)
      if (!validPairs.length) return
      host.askSkill({ skillId: WUZHI_WEITI, ownerId, step: 'discard-distinct', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: target.id, prompt: '【伪涕】：弃置两张点数不同的牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }) })
      return
    }
    if (resolution.step !== 'discard-distinct') return
    const targetId = resolution.data.targetId as PlayerId
    const target = player(host.state, targetId)
    const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const hand = new Set(target?.zones.hand ?? [])
    const ranks = chosen.map((cardId) => ruleCardNumber(host.state, cardId))
    if (!target?.alive || chosen.length !== 2 || chosen.some((cardId) => !hand.has(cardId))
      || ranks.some((rank) => rank === null) || ranks[0] === ranks[1]) return
    discardCardsByIds(host as never, target.id, chosen, WUZHI_WEITI)
  },
  startQueued(host, _ownerId, prompt) {
    if (prompt.step !== 'draw-different-ranks') return
    drawDifferentRankCards(host, (prompt.data as { targetId: PlayerId }).targetId)
  },
})

function advanceWufuFlow(flow: WufuFlow): void {
  if (flow.actorIndex === 0) {
    flow.actorRepeatIndex += 1
    if (flow.actorRepeatIndex < flow.ownerRepeatCount) return
  }
  flow.actorIndex += 1
  flow.actorRepeatIndex = 0
  if (flow.actorIndex >= 2) { flow.actorIndex = 0; flow.operationIndex += 1 }
}

export const HISTORICAL_BATCH83_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'zhang-huan-b83', name: '张奂', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGHUAN_YIJU, name: '义拒', locked: true, description: '锁定技，其他角色使用牌指定你为唯一目标后，你弃置一张牌。' },
    { id: ZHANGHUAN_SHUGUO, name: '戍国', description: '每回合结束时，你可以依次使用本回合因弃置而置入弃牌堆的牌直到你使用了其他角色弃置的牌。若你的手牌数不为全场唯一最多，每有一张本回合弃置的牌没有使用，你摸一张牌（至多摸5）。' },
  ] },
  { id: 'wu-zhi-b83', name: '吴质', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: sid('weiti-wuzhi'), name: '伪涕', description: '出牌阶段限两次，选择一项令一名角色执行：1.受到1点伤害，然后摸2张与手牌点数均不同的牌；2.回复1点体力，然后弃置2张点数不同的牌。' },
    { id: sid('yuanrong-wuzhi'), name: '圆融', description: '回合结束时，你可将本回合进入弃牌堆的1张黑色牌当作任意普通锦囊牌使用，然后将本回合进入弃牌堆的1张红色牌当作任意基本牌使用。' },
  ] },
  { id: 'ren-wan-b83', name: '任婉', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: sid('juanji-renwan'), name: '狷急', description: '出牌阶段每项限一次，你可以：1.令你与一名其他角色各回复X点体力，然后对你与其各造成X点伤害；2.弃置至多X名其他角色各1张牌，然后将你的武将牌翻面；3.摸X张牌，然后你弃置等量张牌。X为本回合此技能发动次数。' },
    { id: sid('renshuang-renwan'), name: '纫霜', locked: true, description: '锁定技，你的体力值变为1时，复原你的武将牌，然后你可视为使用1张普通锦囊牌（每种牌名每轮限一次）。' },
  ] },
  { id: 'wei-caopi-b83', name: '威·曹丕', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: sid('sugang-weicaopi'), name: '肃纲', description: '出牌阶段开始时，你可以进行判定并获得生效的判定牌，然后你选择至多2项：1.此牌本回合可以当任意伤害牌使用；2.展示一张手牌，然后本回合所有角色均只能使用判定结果与展示牌点数之间的手牌；3.本回合获得“行殇”且“典论”中的“等量”改为“两倍”。' },
    { id: sid('dianlun-weicaopi'), name: '典论', description: '出牌阶段限一次，你可以弃置任意张点数差相同的手牌，然后摸等量的牌，这些牌本回合不受“肃纲”的使用限制且无距离和次数限制。' },
    { id: sid('jiwei-weicaopi'), name: '极威', description: '其他魏势力角色的出牌阶段限一次，其可交给你一张手牌，然后你可令其发动一次至多弃置3张牌的“典论”。' },
  ] },
  { id: 'dong-xu-b83', name: '董絮', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: sid('qingleng-dongxu'), name: '清冷', description: '你成为黑色非转化牌的目标后，你可以弃置任意一名角色一张牌。若此弃牌是装备牌，该黑色牌对你无效；若不是装备牌，你可将该黑色牌视为列入下次“酖毒”可使用的牌中。' },
    { id: sid('zhendu-dongxu'), name: '酖毒', description: '出牌阶段结束时，你可以展示至多5张基本或普通锦囊牌，然后你的下个回合开始时视为依次使用这些牌（无距离限制）。你使用这些牌期间有角色回复体力或受到伤害后，你摸一张牌（因此摸到的牌不计本回合手牌上限）。' },
  ] },
  { id: 'xing-taishici-b83', name: '星·太史慈', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: sid('zhongwei-xingtaishici'), name: '重围', locked: true, description: '锁定技，你计算与其他角色的距离+3。当你造成伤害后，此数值-1。减至0时，回复1点体力并摸当前体力值张牌，然后“冲阻”增加一个选项，失去此技能。' },
    { id: sid('chongzu-xingtaishici'), name: '冲阻', description: '你使用指定自己为目标的牌结算后，可选择一项：1.你使用的下一张牌无次数和距离限制；2.摸两张牌，然后此选项本回合失效。重围移除时增加选项：你使用的下一张牌指定其他角色为目标后，可对其中一个目标造成1点伤害。' },
  ] },
  { id: 'ji-miao-jimu-b83', name: '吉邈吉穆', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: sid('zouyi-jimiaojimu'), name: '诹议', description: '出牌阶段限一次，你可选择至多两项发动：1.你摸两张牌并可弃置一名其他角色一张牌；2.你弃置一张牌并可令一名其他角色摸两张牌。结算后“掩袭”使用次数增加手牌数与你相同的角色数并回复等量体力。' },
    { id: sid('yanxi-jimiaojimu'), name: '掩袭', description: '每局游戏限零次，其他角色回合结束时，你可视为对其使用一张【杀】；若此【杀】造成伤害，此伤害改为失去体力。结算后若此技能可使用次数不为0，再次发动直至此技能无使用次数或其阵亡。' },
  ] },
  { id: 'xu-wen-b83', name: '徐妏', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: sid('fuhui-xuwen'), name: '赋绘', description: '你可将两张手牌当作任意一张基本牌或普通锦囊牌使用，若两张手牌的花色组合为本回合首次，你可摸一张牌。每种牌名每回合限一次。' },
    { id: sid('mohua-xuwen'), name: '摹画', description: '每轮限一次，其他角色回合结束时，你可依序使用其出牌阶段使用的相同牌名的基本牌或普通锦囊牌（视为该角色使用），若此牌目标与其使用该牌时存在相同目标，你摸此牌相同目标数的牌。' },
  ] },
  { id: 'wei-sunce-b83', name: '威·孙策', kingdom: 'wu', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: sid('zhefeng-weisunce'), name: '猘锋', description: '你的手牌数大于体力值时，可将至少一张黑牌当不计入次数的【酒】使用；小于体力值时，可将一张红色牌当无距离限制的任意【杀】使用或打出，然后将手牌摸至体力上限；等于体力值时，可将任意张牌当【决斗】对至多两名目标使用（每回合限游戏人数次）。' },
    { id: sid('weijing-weisunce'), name: '威靖', description: '其他吴势力角色的回合开始时，你可选择一项令其执行：1.受到你造成的1点伤害；2.交给你一张牌，然后其可发动一次对应条件的“猘锋”。' },
  ] },
  { id: 'wu-fu-b83', name: '伍孚', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: sid('zhonge-wufu'), name: '忠锷', description: '出牌阶段限一次，你可以将手牌调整至体力上限，然后与一名其他角色同时选择一项并依次执行：1.你与其依次摸一张牌；2.你与其依次视为对对方使用一张【杀】。若其选择的项与你不同，每项操作在你执行时均多执行一次。' },
    { id: sid('juekai-wufu'), name: '绝忾', description: '限定技，出牌阶段，你可以重置“忠锷”，然后直到出牌阶段结束，此阶段获得过牌的角色无法再使用手牌。' },
  ] },
]

function player(state: SanguoshaState, id: PlayerId) {
  return state.players.find((entry) => entry.id === id)
}

function dianlunRanksHaveEqualGaps(state: SanguoshaState, cardIds: readonly CardId[]): boolean {
  if (!cardIds.length) return false
  const ranks = cardIds.map((cardId) => ruleCardNumber(state, cardId))
  if (ranks.some((rank) => rank === null)) return false
  const sorted = ranks as number[]
  sorted.sort((left, right) => left - right)
  if (sorted.length < 3) return true
  const gap = sorted[1]! - sorted[0]!
  return sorted.slice(2).every((rank, index) => rank - sorted[index + 1]! === gap)
}

registerJudgmentContinuation(WEICAOPI_SUGANG_JUDGE, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = player(host.state, ownerId)
  if (!owner?.alive || !host.state.zones.discardPile.includes(judged.id)) return
  moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
  b83(host.state).sugangJudgmentRank ??= {}
  b83(host.state).sugangJudgmentRank[ownerId] = judged.rank
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [judged.id], isDraw: false, reason: WEICAOPI_SUGANG },
    { targetId: ownerId, cardIds: [judged.id] })
  host.queueSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'choose-effects', data: { judgedId: judged.id } })
})

registerSkillRuntime({
  id: WEICAOPI_SUGANG,
  viewAs(state, ownerId): ViewAsOption[] {
    const turn = b83(state).sugangDamageCardTurn?.[ownerId]
    if (turn !== state.turnNumber) return []
    const cardId = b83(state).sugangDamageCard?.[ownerId] as CardId | undefined
    if (!cardId || !player(state, ownerId)?.zones.hand.includes(cardId)) return []
    return ['杀', ...DAMAGE_TRICKS].map((asCardName) => ({
      cardId, asCardName, label: `【肃纲】：将判定牌当【${asCardName}】使用`,
    }))
  },
  globallyProhibitsCardUse(state, ownerId, actorId, cardId) {
    const limit = b83(state).sugangPointLimits?.[ownerId]
    if (!limit || limit.turnNumber !== state.turnNumber || !player(state, actorId)?.zones.hand.includes(cardId)) return false
    if (Object.values((b83(state).dianlunFreeCards ?? {}) as Record<PlayerId, CardId[]>).some((ids) => ids.includes(cardId))) return false
    const rank = ruleCardNumber(state, cardId)
    return rank === null || rank < limit.low || rank > limit.high
  },
  claimsDeathCards(state, ownerId, deadId) {
    return ownerId !== deadId && player(state, ownerId)?.alive === true
      && b83(state).sugangXingshangTurn?.[ownerId] === state.turnNumber
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play')
        host.queueSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'ask-judge', data: {} })
    } },
    { event: 'Death', handle(host, ownerId) {
      const claim = host.state.deathClaim
      if (claim?.claimantId === ownerId && claim.skillId === WEICAOPI_SUGANG)
        host.queueSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'ask-xingshang', data: { deadId: claim.deadId } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnNumber = (context.event.payload as { turnNumber?: number }).turnNumber
      if (b83(host.state).sugangDamageCardTurn?.[ownerId] === turnNumber) {
        delete b83(host.state).sugangDamageCardTurn[ownerId]
        delete b83(host.state).sugangDamageCard[ownerId]
      }
      if (b83(host.state).sugangPointLimits?.[ownerId]?.turnNumber === turnNumber) delete b83(host.state).sugangPointLimits[ownerId]
      if (b83(host.state).sugangXingshangTurn?.[ownerId] === turnNumber) delete b83(host.state).sugangXingshangTurn[ownerId]
      if (b83(host.state).sugangDoubledDianlun?.[ownerId] === turnNumber) delete b83(host.state).sugangDoubledDianlun[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-judge') {
      host.askSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'ask-judge', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【肃纲】：是否进行判定并获得判定牌？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '判定并获得此牌' }, { id: 'no', label: '放弃' }],
      }) })
      return
    }
    if (prompt.step === 'choose-effects') {
      const judgedId = prompt.data.judgedId as CardId
      const options = [
        { id: 'damage-card', label: '本回合可将此牌当任意伤害牌使用' },
        ...(player(host.state, ownerId)?.zones.hand.length ? [{ id: 'point-limit', label: '展示一张手牌，限制本回合所有角色使用手牌的点数范围' }] : []),
        { id: 'xingshang', label: '本回合获得【行殇】且【典论】摸牌数翻倍' },
      ]
      host.askSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'choose-effects', data: { judgedId }, build: (id): ChooseOptionsRequest => ({
        id, kind: 'choose-options', playerId: ownerId, prompt: '【肃纲】：选择至多两项效果',
        timeoutMs: 25_000, optional: false, options, min: 0, max: 2,
      }) })
      return
    }
    if (prompt.step === 'ask-xingshang') {
      const claim = host.state.deathClaim
      if (!claim || claim.claimantId !== ownerId || claim.skillId !== WEICAOPI_SUGANG) return
      const cards = heldDeathCards(host.state)
      if (!cards.length || !player(host.state, ownerId)?.alive) { releaseDeathCards(host); return }
      const dead = player(host.state, prompt.data.deadId as PlayerId)
      host.askSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'ask-xingshang', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【行殇】：是否获得${dead?.nickname ?? '阵亡角色'}的所有牌？`,
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '获得所有牌' }, { id: 'no', label: '放弃' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask-judge') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      performJudgment(host as never, ownerId, '肃纲', { tag: WEICAOPI_SUGANG_JUDGE, data: { ownerId } })
      return
    }
    if (resolution.step === 'choose-effects') {
      const selected = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const allowed = new Set(['damage-card', 'point-limit', 'xingshang'])
      if (selected.length > 2 || new Set(selected).size !== selected.length || selected.some((id) => !allowed.has(id))) return
      const judgedId = resolution.data.judgedId as CardId
      if (!player(host.state, ownerId)?.zones.hand.includes(judgedId)) return
      if (selected.includes('damage-card')) {
        b83(host.state).sugangDamageCard ??= {}; b83(host.state).sugangDamageCard[ownerId] = judgedId
        b83(host.state).sugangDamageCardTurn ??= {}; b83(host.state).sugangDamageCardTurn[ownerId] = host.state.turnNumber
      }
      if (selected.includes('point-limit')) {
        host.askSkill({ skillId: WEICAOPI_SUGANG, ownerId, step: 'show-card', data: {}, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【肃纲】：展示一张手牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: [...player(host.state, ownerId)!.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      if (selected.includes('xingshang')) {
        b83(host.state).sugangXingshangTurn ??= {}; b83(host.state).sugangXingshangTurn[ownerId] = host.state.turnNumber
        b83(host.state).sugangDoubledDianlun ??= {}; b83(host.state).sugangDoubledDianlun[ownerId] = host.state.turnNumber
      }
      host.dispatch('SkillActivated', { skillId: WEICAOPI_SUGANG, skillName: '肃纲', playerId: ownerId,
        result: 'choose-effects', optionIds: selected, cardIds: [judgedId] }, { sourceId: ownerId, cardIds: [judgedId] })
      return
    }
    if (resolution.step === 'show-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      const rank = cardId && owner?.zones.hand.includes(cardId) ? ruleCardNumber(host.state, cardId) : null
      if (!cardId || rank === null) return
      const judgmentRank = b83(host.state).sugangJudgmentRank?.[ownerId] as number | undefined
      const low = Math.min(rank, judgmentRank ?? rank), high = Math.max(rank, judgmentRank ?? rank)
      b83(host.state).sugangPointLimits ??= {}; b83(host.state).sugangPointLimits[ownerId] = { turnNumber: host.state.turnNumber, low, high }
      host.dispatch('SkillActivated', { skillId: WEICAOPI_SUGANG, skillName: '肃纲', playerId: ownerId,
        result: 'show-point-limit', cardIds: [cardId], low, high,
        logText: `${player(host.state, ownerId)?.nickname}发动【肃纲】，展示手牌并将本回合可用牌点数限制在${low}至${high}`,
      }, { sourceId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'ask-xingshang') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') claimDeathCards(host, ownerId, '行殇')
      else releaseDeathCards(host)
    }
  },
})

registerSkillRuntime({
  id: WEICAOPI_DIANLUN,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !player(state, ownerId)?.alive) return []
    const freeCards = (state as SanguoshaState & { b83?: Record<string, any> }).b83?.dianlunFreeCards?.[ownerId] as CardId[] | undefined
    const freeActions = (freeCards ?? []).flatMap((cardId) => player(state, ownerId)?.zones.hand.includes(cardId)
      ? skillOtherHandCardUseActions(state, ownerId, ownerId, cardId, undefined, WEICAOPI_DIANLUN,
        undefined, { allowSelf: true, ignoreDistance: true, ignoreUsageLimits: true })
        .map((action) => ({ id: `${WEICAOPI_DIANLUN}:free:${action.id}`, label: `典论牌：${action.label}` }))
      : [])
    return [
      ...(!usedThisPhase(state, ownerId, WEICAOPI_DIANLUN) && (player(state, ownerId)?.zones.hand.length ?? 0) > 0
        ? [{ id: `${WEICAOPI_DIANLUN}:activate`, label: '典论：弃置等差点数手牌并摸牌' }] : []),
      ...freeActions,
    ]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    if (actionId === `${WEICAOPI_DIANLUN}:activate`) {
      if (usedThisPhase(host.state, ownerId, WEICAOPI_DIANLUN) || !owner.zones.hand.length) return
      markUsedThisPhase(host.state, ownerId, WEICAOPI_DIANLUN)
      const cardIds = [...owner.zones.hand]
      host.askSkill({ skillId: WEICAOPI_DIANLUN, ownerId, step: 'select', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【典论】：弃置任意张点数差相同的手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: cardIds.length,
      }) })
      return
    }
    const freeCards = ((b83(host.state).dianlunFreeCards as Record<PlayerId, CardId[]> | undefined)?.[ownerId] ?? [])
    const selected = freeCards.flatMap((cardId) => skillOtherHandCardUseActions(host.state, ownerId, ownerId, cardId,
      undefined, WEICAOPI_DIANLUN, undefined, { allowSelf: true, ignoreDistance: true, ignoreUsageLimits: true })
      .map((action) => ({ cardId, action }))).find(({ action }) => `${WEICAOPI_DIANLUN}:free:${action.id}` === actionId)
    if (!selected) return
    if (!host.beginSkillCardUseFromOtherHand(ownerId, ownerId, selected.cardId, WEICAOPI_DIANLUN, selected.action.id,
      undefined, undefined, { allowSelf: true, ignoreDistance: true, ignoreUsageLimits: true })) return
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'select') return
    const owner = player(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const hand = new Set(owner?.zones.hand ?? [])
    if (!owner?.alive || selected.length === 0 || selected.length !== new Set(selected).size
      || selected.some((cardId) => !hand.has(cardId)) || !dianlunRanksHaveEqualGaps(host.state, selected)) {
      clearUsedThisPhase(host.state, ownerId, WEICAOPI_DIANLUN)
      return
    }
    discardCardsByIds(host as never, ownerId, selected, WEICAOPI_DIANLUN)
    const doubledUntilTurn = (b83(host.state).sugangDoubledDianlun as Record<PlayerId, number> | undefined)?.[ownerId]
    const count = selected.length * (doubledUntilTurn === host.state.turnNumber ? 2 : 1)
    const drawn = drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload)) as CardId[]
    const all = (b83(host.state).dianlunFreeCards ??= {}) as Record<PlayerId, CardId[]>
    all[ownerId] ??= []
    all[ownerId]!.push(...drawn.filter((cardId) => !all[ownerId]!.includes(cardId)))
    host.dispatch('SkillActivated', { skillId: WEICAOPI_DIANLUN, skillName: '典论', playerId: ownerId,
      discardedCardIds: selected, drawnCardIds: drawn, logText: `威曹丕发动【典论】，弃置${selected.length}张牌并摸${drawn.length}张牌` },
    { sourceId: ownerId, cardIds: [...selected, ...drawn] })
  },
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      if (turnPlayerId) delete (b83(host.state).dianlunFreeCards as Record<PlayerId, CardId[]> | undefined)?.[turnPlayerId]
      if (turnPlayerId === ownerId) delete (b83(host.state).sugangDoubledDianlun as Record<PlayerId, number> | undefined)?.[ownerId]
    } },
  ],
  unlimitedCardUses(state, ownerId, cardId) {
    return Boolean(cardId && (state as SanguoshaState & { b83?: Record<string, any> }).b83?.dianlunFreeCards?.[ownerId]?.includes(cardId))
  },
  ignoresDistanceTo(state, ownerId, _targetId, cardId) {
    return Boolean(cardId && (state as SanguoshaState & { b83?: Record<string, any> }).b83?.dianlunFreeCards?.[ownerId]?.includes(cardId))
  },
  globalUnlimitedCardUses(state, _ownerId, actorId, cardId) {
    return Boolean((b83(state).dianlunFreeCards as Record<PlayerId, CardId[]> | undefined)?.[actorId]?.includes(cardId))
  },
  globalIgnoresDistanceToCard(state, _ownerId, actorId, _targetId, cardId) {
    return Boolean((b83(state).dianlunFreeCards as Record<PlayerId, CardId[]> | undefined)?.[actorId]?.includes(cardId))
  },
  globallyProhibitsCardUse(state, ownerId, actorId, cardId) {
    const limit = (state as SanguoshaState & { b83?: Record<string, any> }).b83?.sugangPointLimits?.[ownerId]
    if (!limit || limit.turnNumber !== state.turnNumber || !player(state, actorId)?.zones.hand.includes(cardId)) return false
    if (Object.values((b83(state).dianlunFreeCards ?? {}) as Record<PlayerId, CardId[]>).some((ids) => ids.includes(cardId))) return false
    const rank = ruleCardNumber(state, cardId)
    return rank === null || rank < limit.low || rank > limit.high
  },
})

function validDianlunSubsets(state: SanguoshaState, playerId: PlayerId, maxCount: number): CardId[][] {
  const hand = player(state, playerId)?.zones.hand ?? []
  const result: CardId[][] = []
  const visit = (start: number, picked: CardId[]) => {
    if (picked.length && dianlunRanksHaveEqualGaps(state, picked)) result.push([...picked])
    if (picked.length >= maxCount) return
    for (let index = start; index < hand.length; index += 1) visit(index + 1, [...picked, hand[index]!])
  }
  visit(0, [])
  return result
}

registerSkillRuntime({
  id: WEICAOPI_JIWEI,
  grantsPlayActions(state, ownerId, actorId) {
    const owner = player(state, ownerId), actor = player(state, actorId)
    return owner?.alive && actor?.alive && actorId !== ownerId && state.phase === 'play'
      && state.currentPlayerId === actorId && effectiveKingdomOf(state, actorId) === 'wei'
      && !usedThisPhase(state, actorId, WEICAOPI_JIWEI) && actor.zones.hand.length
      ? [{ id: `${WEICAOPI_JIWEI}:grant`, label: '【极威】：交给威曹丕一张手牌' }] : []
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    const owner = player(host.state, ownerId), actor = player(host.state, actorId)
    if (actionId !== `${WEICAOPI_JIWEI}:grant` || !owner?.alive || !actor?.alive
      || usedThisPhase(host.state, actorId, WEICAOPI_JIWEI) || effectiveKingdomOf(host.state, actorId) !== 'wei') return
    host.askSkill({ skillId: WEICAOPI_JIWEI, ownerId, step: 'give', data: { actorId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: actorId, prompt: '【极威】：交给威曹丕一张手牌，然后其可令你发动【典论】',
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give') {
      const actorId = resolution.data.actorId as PlayerId
      const actor = player(host.state, actorId), owner = player(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !actor?.alive || !owner?.alive || !actor.zones.hand.includes(cardId)) return
      if (!giveCards(host as never, actorId, ownerId, [cardId], WEICAOPI_JIWEI).length) return
      markUsedThisPhase(host.state, actorId, WEICAOPI_JIWEI)
      host.askSkill({ skillId: WEICAOPI_JIWEI, ownerId, step: 'authorize', data: { actorId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【极威】：是否令${actor.nickname}发动一次【典论】？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '令其发动【典论】' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (resolution.step === 'authorize') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const actorId = resolution.data.actorId as PlayerId
      const maximum = Math.min(3, player(host.state, actorId)?.zones.hand.length ?? 0)
      if (!validDianlunSubsets(host.state, actorId, maximum).length) return
      host.askSkill({ skillId: WEICAOPI_JIWEI, ownerId, step: 'discard', data: { actorId, maximum }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: '【极威·典论】：弃置至多三张点数差相同的手牌',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...player(host.state, actorId)!.zones.hand],
        hiddenCardSlots: [], min: 1, max: maximum,
      }) })
      return
    }
    if (resolution.step !== 'discard') return
    const actorId = resolution.data.actorId as PlayerId
    const actor = player(host.state, actorId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!actor?.alive || selected.length < 1 || selected.length > 3 || selected.length !== new Set(selected).size
      || selected.some((id) => !actor.zones.hand.includes(id)) || !dianlunRanksHaveEqualGaps(host.state, selected)) {
      const maximum = Math.min(3, actor?.zones.hand.length ?? 0)
      if (actor?.alive && validDianlunSubsets(host.state, actorId, maximum).length)
        host.askSkill({ skillId: WEICAOPI_JIWEI, ownerId, step: 'discard', data: { actorId, maximum }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: actorId, prompt: '选择至少一张、至多三张点数差相同的手牌（刚才选择不合法）',
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: maximum,
        }) })
      return
    }
    discardCardsByIds(host as never, actorId, selected, WEICAOPI_JIWEI)
    const drawn = drawCards(host.state, host.rng, actorId, selected.length, (name, payload) => host.dispatch(name, payload)) as CardId[]
    const free = (b83(host.state).dianlunFreeCards ??= {}) as Record<PlayerId, CardId[]>
    free[actorId] ??= []; free[actorId]!.push(...drawn.filter((id) => !free[actorId]!.includes(id)))
    host.dispatch('SkillActivated', { skillId: WEICAOPI_JIWEI, skillName: '极威', playerId: ownerId,
      delegatedSkill: '典论', actorId, discardedCardIds: selected, drawnCardIds: drawn },
    { sourceId: ownerId, targetId: actorId, cardIds: [...selected, ...drawn] })
  },
})

const FUHUI_NAMES = ['杀', '闪', '桃', '酒', ...INSTANT_TRICKS] as const
type FuhuiStoredAction = { action: Extract<LegalAction, { kind: 'use-card' }>; carrierId: CardId; materialId: CardId }
function fuhuiUseRecord(state: SanguoshaState, ownerId: PlayerId): { turnNumber: number; names: string[]; suitPairs: string[] } {
  const all = (b83(state).fuhuiUses ??= {}) as Record<PlayerId, { turnNumber: number; names: string[]; suitPairs: string[] }>
  const record = all[ownerId] ?? { turnNumber: state.turnNumber, names: [], suitPairs: [] }
  if (record.turnNumber !== state.turnNumber) { record.turnNumber = state.turnNumber; record.names = []; record.suitPairs = [] }
  all[ownerId] = record
  return record
}

registerSkillRuntime({
  id: XUWEN_FUHUI,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const record = fuhuiUseRecord(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && owner.zones.hand.length >= 2
      && FUHUI_NAMES.some((name) => !record.names.includes(name))
      ? [{ id: `${XUWEN_FUHUI}:activate`, label: '赋绘：将两张手牌当基本牌或普通锦囊使用' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${XUWEN_FUHUI}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || owner.zones.hand.length < 2) return
    host.askSkill({ skillId: XUWEN_FUHUI, ownerId, step: 'materials', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【赋绘】：选择两张手牌作为牌的材料',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'optional-draw') {
      if ((response.payload as { optionId?: string }).optionId === 'yes' && player(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      return
    }
    if (resolution.step === 'materials') {
      const owner = player(host.state, ownerId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || cardIds.length !== 2 || new Set(cardIds).size !== 2 || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      const stored: FuhuiStoredAction[] = []
      for (const [carrierId, materialId] of [[cardIds[0]!, cardIds[1]!], [cardIds[1]!, cardIds[0]!]] as const) {
        for (const asCardName of FUHUI_NAMES) {
          if (fuhuiUseRecord(host.state, ownerId).names.includes(asCardName)) continue
          const actions = declaredCardActions(host.state, ownerId, carrierId, asCardName,
            `【赋绘】：两张手牌当【${asCardName}】使用`, { sourceSkillId: XUWEN_FUHUI })
          for (const action of actions) {
            if (action.kind !== 'use-card') continue
            stored.push({ action: { ...action, cardIds: [carrierId, materialId] }, carrierId, materialId })
          }
        }
      }
      if (!stored.length) return
      const options = stored.map((entry, index) => ({ id: `use:${index}`, label: entry.action.label }))
      host.askSkill({ skillId: XUWEN_FUHUI, ownerId, step: 'choose-use', data: { cardIds, stored }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【赋绘】：选择本次要使用的基本牌或普通锦囊牌及目标',
        timeoutMs: 25_000, optional: false, options,
      }) })
      return
    }
    if (resolution.step === 'choose-use') {
      const index = Number((response.payload as { optionId?: string }).optionId?.replace('use:', ''))
      const stored = (resolution.data.stored as FuhuiStoredAction[])[index]
      const owner = player(host.state, ownerId)
      const cardIds = resolution.data.cardIds as CardId[]
      if (!stored || !owner?.alive || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      const record = fuhuiUseRecord(host.state, ownerId)
      const name = stored.action.asCardName
      if (record.names.includes(name)) return
      const fresh = declaredCardActions(host.state, ownerId, stored.carrierId, name,
        `【赋绘】：两张手牌当【${name}】使用`, { sourceSkillId: XUWEN_FUHUI })
        .find((action) => action.kind === 'use-card'
          && action.targetIds.length === stored.action.targetIds.length
          && action.targetIds.every((targetId, targetIndex) => targetId === stored.action.targetIds[targetIndex]))
      if (!fresh || fresh.kind !== 'use-card') return
      const suits = cardIds.map((cardId) => effectiveCardSuit(host.state, ownerId, cardId) ?? 'none').sort()
      const suitPair = suits.join(':')
      const drawForPair = !record.suitPairs.includes(suitPair)
      record.names.push(name)
      if (drawForPair) record.suitPairs.push(suitPair)
      const committed = { ...fresh, cardIds: [stored.carrierId, stored.materialId] }
      b83(host.state).fuhuiPending ??= {}
      b83(host.state).fuhuiPending[stored.carrierId] = { ownerId, drawForPair }
      executeUseCardAction(host as never, ownerId, committed)
      return
    }
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId }
    const pending = payload.cardId ? b83(host.state).fuhuiPending?.[payload.cardId] : undefined
    if (!pending || pending.ownerId !== ownerId) return
    delete b83(host.state).fuhuiPending[payload.cardId!]
    if (pending.drawForPair && player(host.state, ownerId)?.alive)
      host.queueSkill({ skillId: XUWEN_FUHUI, ownerId, step: 'optional-draw', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'optional-draw' || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: XUWEN_FUHUI, ownerId, step: 'optional-draw', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【赋绘】：是否摸一张牌？', timeoutMs: 20_000,
      optional: true, options: [{ id: 'yes', label: '摸一张牌' }, { id: 'no', label: '不摸' }],
    }) })
  },
})

type MohuaRecord = { cardName: string; targetIds: PlayerId[] }
type MohuaFlow = { actorId: PlayerId; turnNumber: number; entries: MohuaRecord[]; index: number }
function mohuaEntries(state: SanguoshaState, actorId: PlayerId, turnNumber: number): MohuaRecord[] {
  const record = (b83(state).mohuaRecords as Record<PlayerId, { turnNumber: number; entries: MohuaRecord[] }> | undefined)?.[actorId]
  return record?.turnNumber === turnNumber ? record.entries : []
}
function makeMohuaVirtualCard(host: SkillHost, actorId: PlayerId, cardName: string): CardId {
  const cardId = `virtual:${XUWEN_MOHUA}:${host.state.turnNumber}:${host.state.seq}:${host.state.decisions.length}` as CardId
  const basic = ['杀', '桃', '酒'].includes(cardName)
  host.state.cards[cardId] = { id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: cardName,
    suit: 'spade', rank: 1, color: 'black', category: basic ? 'basic' : 'trick', virtual: true, sourceSkillId: XUWEN_MOHUA }
  player(host.state, actorId)!.zones.hand.push(cardId)
  recordCardHandEntry(host.state, cardId)
  return cardId
}
function discardMohuaVirtualCard(host: SkillHost, actorId: PlayerId, cardId: CardId): void {
  const actor = player(host.state, actorId)
  if (actor?.zones.hand.includes(cardId)) actor.zones.hand = actor.zones.hand.filter((id) => id !== cardId)
  delete host.state.cards[cardId]
}
function askNextMohuaUse(host: SkillHost, ownerId: PlayerId, flow: MohuaFlow): void {
  const actor = player(host.state, flow.actorId)
  while (actor?.alive && flow.index < flow.entries.length) {
    const entry = flow.entries[flow.index]!
    const cardId = makeMohuaVirtualCard(host, flow.actorId, entry.cardName)
    const actions = declaredCardActions(host.state, flow.actorId, cardId, entry.cardName,
      `【摹画】：视为${actor.nickname}使用【${entry.cardName}】`, { sourceSkillId: XUWEN_MOHUA })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card' && !action.id.startsWith('play:recast:'))
    if (!actions.length) { discardMohuaVirtualCard(host, flow.actorId, cardId); flow.index += 1; continue }
    host.askSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'choose-replay', data: { flow, cardId, actions, originalTargetIds: entry.targetIds },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【摹画】：选择${actor.nickname}的【${entry.cardName}】目标`, timeoutMs: 25_000, optional: false,
        options: actions.map((action, index) => ({ id: `action:${index}`, label: action.label })),
      }) })
    return
  }
  const records = b83(host.state).mohuaRecords as Record<PlayerId, { turnNumber: number; entries: MohuaRecord[] }> | undefined
  if (records) delete records[flow.actorId]
}

registerSkillRuntime({
  id: XUWEN_MOHUA,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const actorId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      const recordable = payload.cardName && (['杀', '桃', '酒'].includes(payload.cardName) || INSTANT_TRICKS.has(payload.cardName))
      if (!actorId || actorId === ownerId || host.state.phase !== 'play' || host.state.currentPlayerId !== actorId || !recordable) return
      const records = (b83(host.state).mohuaRecords ??= {}) as Record<PlayerId, { turnNumber: number; entries: MohuaRecord[] }>
      const previous = records[actorId]
      const record = previous?.turnNumber === host.state.turnNumber ? previous : { turnNumber: host.state.turnNumber, entries: [] }
      record.entries.push({ cardName: payload.cardName!, targetIds: [...(payload.targetIds ?? [])] })
      records[actorId] = record
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const pending = cardId ? b83(host.state).mohuaPending?.[cardId] : undefined
      if (!pending || pending.ownerId !== ownerId) return
      delete b83(host.state).mohuaPending[cardId!]
      const actual = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const overlap = actual.filter((targetId) => pending.originalTargetIds.includes(targetId)).length
      if (overlap && player(host.state, ownerId)?.alive)
        drawCards(host.state, host.rng, ownerId, overlap, (name, data) => host.dispatch(name, data))
      pending.flow.index += 1
      host.queueSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'mohua-next', data: pending.flow })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const actorId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!actorId || actorId === ownerId || !player(host.state, ownerId)?.alive) return
      const entries = mohuaEntries(host.state, actorId, host.state.turnNumber)
      if (!entries.length || b83(host.state).mohuaUsedRound?.[ownerId] === host.state.roundNumber) {
        const records = b83(host.state).mohuaRecords as Record<PlayerId, unknown> | undefined
        if (records) delete records[actorId]
        return
      }
      host.queueSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'offer', data: { actorId, turnNumber: host.state.turnNumber, entries } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'offer') {
      const actorId = prompt.data.actorId as PlayerId
      const actor = player(host.state, actorId)
      if (!actor?.alive || !player(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'offer', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【摹画】：是否依序模仿${actor.nickname}本回合出牌阶段用过的牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动摹画' }, { id: 'no', label: '放弃' }],
      }) })
      return
    }
    if (prompt.step === 'mohua-next') askNextMohuaUse(host, ownerId, prompt.data as MohuaFlow)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      const actorId = resolution.data.actorId as PlayerId
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        const records = b83(host.state).mohuaRecords as Record<PlayerId, unknown> | undefined
        if (records) delete records[actorId]
        return
      }
      b83(host.state).mohuaUsedRound ??= {}; b83(host.state).mohuaUsedRound[ownerId] = host.state.roundNumber
      askNextMohuaUse(host, ownerId, { actorId, turnNumber: resolution.data.turnNumber as number,
        entries: resolution.data.entries as MohuaRecord[], index: 0 })
      return
    }
    if (resolution.step !== 'choose-replay') return
    const flow = resolution.data.flow as MohuaFlow
    const cardId = resolution.data.cardId as CardId
    const actions = resolution.data.actions as Array<Extract<LegalAction, { kind: 'use-card' }>>
    const index = Number((response.payload as { optionId?: string }).optionId?.replace('action:', ''))
    const selected = actions[index]
    const actor = player(host.state, flow.actorId)
    if (!selected || !actor?.alive || !actor.zones.hand.includes(cardId)) {
      discardMohuaVirtualCard(host, flow.actorId, cardId); flow.index += 1
      host.queueSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'mohua-next', data: flow }); return
    }
    const fresh = declaredCardActions(host.state, flow.actorId, cardId, selected.asCardName,
      `【摹画】：视为${actor.nickname}使用【${selected.asCardName}】`, { sourceSkillId: XUWEN_MOHUA })
      .find((action) => action.kind === 'use-card' && action.targetIds.length === selected.targetIds.length
        && action.targetIds.every((targetId, targetIndex) => targetId === selected.targetIds[targetIndex]))
    if (!fresh || fresh.kind !== 'use-card') {
      discardMohuaVirtualCard(host, flow.actorId, cardId); flow.index += 1
      host.queueSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'mohua-next', data: flow }); return
    }
    b83(host.state).mohuaPending ??= {}
    b83(host.state).mohuaPending[cardId] = { ownerId, originalTargetIds: resolution.data.originalTargetIds as PlayerId[], flow }
    executeUseCardAction(host as never, flow.actorId, fresh)
    if (actor.zones.hand.includes(cardId)) {
      delete b83(host.state).mohuaPending[cardId]; discardMohuaVirtualCard(host, flow.actorId, cardId)
      flow.index += 1; host.queueSkill({ skillId: XUWEN_MOHUA, ownerId, step: 'mohua-next', data: flow })
    }
  },
})

type ZhefengDuelFlow = { cardIds: CardId[]; actions: Array<Extract<LegalAction, { kind: 'use-card' }>> }
function zhefengDuelUses(state: SanguoshaState, ownerId: PlayerId): { turnNumber: number; count: number } {
  const all = (b83(state).zhefengDuelUses ??= {}) as Record<PlayerId, { turnNumber: number; count: number }>
  const record = all[ownerId] ?? { turnNumber: state.turnNumber, count: 0 }
  if (record.turnNumber !== state.turnNumber) { record.turnNumber = state.turnNumber; record.count = 0 }
  all[ownerId] = record
  return record
}
function zhefengDuelActionChoices(state: SanguoshaState, ownerId: PlayerId, cardIds: CardId[]): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  const choices: Array<Extract<LegalAction, { kind: 'use-card' }>> = []
  for (const [carrierId, ...extraCardIds] of [cardIds, [...cardIds].reverse()]) {
    const actions = declaredCardActions(state, ownerId, carrierId!, '决斗', '猘锋：以所选手牌使用【决斗】', { sourceSkillId: WEISUNCE_ZHEFENG })
    for (const action of actions) if (action.kind === 'use-card')
      choices.push({ ...action, cardIds: [carrierId!, ...extraCardIds] })
  }
  return choices
}

registerSkillRuntime({
  id: WEISUNCE_ZHEFENG,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = player(state, ownerId)
    if (!owner?.alive) return []
    if (owner.zones.hand.length < owner.hp) return owner.zones.hand.filter((id) => effectiveCardColor(state, ownerId, id) === 'red')
      .map((cardId) => ({ cardId, asCardName: '杀', label: '猘锋：红色牌当无距离限制的【杀】使用或打出' }))
    return []
  },
  unlimitedWineFor(state, ownerId, cardId) {
    return Boolean(cardId && player(state, ownerId)?.zones.hand.length! > (player(state, ownerId)?.hp ?? 0)
      && effectiveCardColor(state, ownerId, cardId) === 'black')
  },
  slashIgnoresDistance(state, ownerId, cardId) {
    return Boolean(cardId && player(state, ownerId)?.zones.hand.length! < (player(state, ownerId)?.hp ?? 0)
      && effectiveCardColor(state, ownerId, cardId) === 'red')
  },
  additionalTargetSetsForTrick(state, ownerId, cardId, cardName) {
    const owner = player(state, ownerId)
    if (cardName !== '决斗' || !owner?.alive || owner.zones.hand.length !== owner.hp
      || !owner.zones.hand.includes(cardId) || zhefengDuelUses(state, ownerId).count >= state.players.length) return []
    const targets = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    return targets.flatMap((left, index) => targets.slice(index + 1).flatMap((right) => [[left, right], [right, left]]))
  },
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const usage = zhefengDuelUses(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    const actions: Array<{ id: string; label: string }> = []
    if (owner.zones.hand.length > owner.hp && owner.zones.hand.some((id) => effectiveCardColor(state, ownerId, id) === 'black'))
      actions.push({ id: `${WEISUNCE_ZHEFENG}:wine`, label: '猘锋：将至少一张黑牌当不计次数的【酒】使用' })
    if (owner.zones.hand.length === owner.hp && owner.zones.hand.length > 0 && usage.count < state.players.length)
      actions.push({ id: `${WEISUNCE_ZHEFENG}:duel`, label: '猘锋：将任意张手牌当【决斗】对至多两名角色使用' })
    return actions
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId === `${WEISUNCE_ZHEFENG}:wine` && owner?.alive && host.state.currentPlayerId === ownerId
      && host.state.phase === 'play' && owner.zones.hand.length > owner.hp) {
      const blackCards = owner.zones.hand.filter((id) => effectiveCardColor(host.state, ownerId, id) === 'black')
      if (!blackCards.length) return
      host.askSkill({ skillId: WEISUNCE_ZHEFENG, ownerId, step: 'wine-materials', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【猘锋】：选择至少一张黑牌当不计次数的【酒】使用',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: blackCards, hiddenCardSlots: [], min: 1, max: blackCards.length,
      }) })
      return
    }
    if (actionId !== `${WEISUNCE_ZHEFENG}:duel` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || owner.zones.hand.length !== owner.hp
      || zhefengDuelUses(host.state, ownerId).count >= host.state.players.length) return
    host.askSkill({ skillId: WEISUNCE_ZHEFENG, ownerId, step: 'duel-materials', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【猘锋】：选择至少一张手牌作为【决斗】材料',
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'wine-materials') {
      const owner = player(host.state, ownerId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
        || owner.zones.hand.length <= owner.hp || cardIds.length < 1 || cardIds.length !== new Set(cardIds).size
        || cardIds.some((id) => !owner.zones.hand.includes(id) || effectiveCardColor(host.state, ownerId, id) !== 'black')) return
      const actions = declaredCardActions(host.state, ownerId, cardIds[0]!, '酒', '猘锋：将黑牌当【酒】使用',
        { sourceSkillId: WEISUNCE_ZHEFENG, ignoreUsageLimits: true })
      const action = actions.find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === 1
        && candidate.targetIds[0] === ownerId)
      if (!action || action.kind !== 'use-card') return
      executeUseCardAction(host as never, ownerId, { ...action, cardIds }, { ignoreUsageLimits: true })
      return
    }
    if (resolution.step === 'duel-materials') {
      const owner = player(host.state, ownerId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || owner.zones.hand.length !== owner.hp || cardIds.length < 1
        || cardIds.length !== new Set(cardIds).size || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      const actions = zhefengDuelActionChoices(host.state, ownerId, cardIds)
      if (!actions.length) return
      host.askSkill({ skillId: WEISUNCE_ZHEFENG, ownerId, step: 'duel-use', data: { cardIds, actions }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【猘锋】：选择【决斗】目标（可同时选择至多两名）',
        timeoutMs: 25_000, optional: false, options: actions.map((action, index) => ({ id: `action:${index}`, label: action.label })),
      }) })
      return
    }
    if (resolution.step !== 'duel-use') return
    const index = Number((response.payload as { optionId?: string }).optionId?.replace('action:', ''))
    const stored = (resolution.data.actions as ZhefengDuelFlow['actions'])[index]
    const cardIds = resolution.data.cardIds as CardId[]
    const owner = player(host.state, ownerId)
    if (!stored || !owner?.alive || owner.zones.hand.length !== owner.hp || cardIds.some((id) => !owner.zones.hand.includes(id))) return
    const fresh = zhefengDuelActionChoices(host.state, ownerId, cardIds).find((action) => action.targetIds.length === stored.targetIds.length
      && action.targetIds.every((targetId, targetIndex) => targetId === stored.targetIds[targetIndex]))
    if (!fresh) return
    zhefengDuelUses(host.state, ownerId).count += 1
    executeUseCardAction(host as never, ownerId, fresh)
    if (owner.zones.hand.includes(fresh.cardIds[0]!)) zhefengDuelUses(host.state, ownerId).count -= 1
  },
  globalResponseViewAs(state, ownerId, responderId, requiredCardName) {
    const grant = b83(state).zhefengGranted?.[ownerId]
    const responder = player(state, responderId)
    if (requiredCardName !== '杀' || grant?.actorId !== responderId || grant.turnNumber !== state.turnNumber
      || !responder || responder.zones.hand.length >= responder.hp) return []
    return responder.zones.hand.filter((cardId) => effectiveCardColor(state, responderId, cardId) === 'red')
      .map((cardId) => ({ cardId, asCardName: '杀', label: '猘锋：红色牌当【杀】打出' }))
  },
  globalIgnoresDistanceToCard(state, ownerId, actorId, _targetId, cardId) {
    const grant = b83(state).zhefengGranted?.[ownerId]
    const actor = player(state, actorId)
    return grant?.actorId === actorId && grant.turnNumber === state.turnNumber && Boolean(actor && actor.zones.hand.length < actor.hp)
      && effectiveCardColor(state, actorId, cardId) === 'red'
  },
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const sourceId = context.event.sourceId
      if (!sourceId || !payload.cardId || payload.cardName !== '杀' || context.event.sourceSkillId !== WEISUNCE_ZHEFENG) return
      const source = player(host.state, sourceId)
      if (source?.alive) {
        const count = Math.max(0, source.maxHp - source.zones.hand.length)
        if (count) drawCards(host.state, host.rng, sourceId, count, (name, data) => host.dispatch(name, data))
      }
      if (b83(host.state).zhefengGranted?.[ownerId]?.actorId === sourceId) delete b83(host.state).zhefengGranted[ownerId]
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string }
      if (context.event.sourceSkillId !== WEISUNCE_ZHEFENG || payload.cardName !== '杀' || !payload.playerId) return
      const responder = player(host.state, payload.playerId)
      if (responder?.alive) {
        const count = Math.max(0, responder.maxHp - responder.zones.hand.length)
        if (count) drawCards(host.state, host.rng, responder.id, count, (name, data) => host.dispatch(name, data))
      }
      if (b83(host.state).zhefengGranted?.[ownerId]?.actorId === payload.playerId) delete b83(host.state).zhefengGranted[ownerId]
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (b83(host.state).zhefengGranted?.[ownerId]?.actorId === playerId) delete b83(host.state).zhefengGranted[ownerId]
    } },
  ],
})

function delegatedZhefengDuelActions(state: SanguoshaState, actorId: PlayerId, cardIds: CardId[]): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  const base: Array<Extract<LegalAction, { kind: 'use-card' }>> = []
  for (const [carrierId, ...extraCardIds] of [cardIds, [...cardIds].reverse()]) {
    base.push(...declaredCardActions(state, actorId, carrierId!, '决斗', '威靖：以所选手牌使用【决斗】',
      { sourceSkillId: WEISUNCE_ZHEFENG }).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
      .map((action) => ({ ...action, cardIds: [carrierId!, ...extraCardIds] })))
  }
  const singleTargetActions = base.filter((action) => action.targetIds.length === 1)
  const byTarget = new Map(singleTargetActions.map((action) => [action.targetIds[0]!, action]))
  const targets = [...byTarget.keys()]
  for (const left of targets) for (const right of targets) {
    if (left === right) continue
    const action = byTarget.get(left)!
    base.push({ ...action, id: `${action.id}:two:${left}:${right}`, targetIds: [left, right],
      label: `威靖：对${player(state, left)?.nickname}和${player(state, right)?.nickname}使用【决斗】` })
  }
  return base
}
function askWeijingMaterials(host: SkillHost, ownerId: PlayerId, actorId: PlayerId): void {
  const actor = player(host.state, actorId)
  if (!actor?.alive) return
  const h = actor.zones.hand.length
  if (h === actor.hp && zhefengDuelUses(host.state, actorId).count >= host.state.players.length) {
    delete b83(host.state).zhefengGranted?.[ownerId]
    return
  }
  const eligible = h > actor.hp ? actor.zones.hand.filter((id) => effectiveCardColor(host.state, actorId, id) === 'black')
    : h < actor.hp ? actor.zones.hand.filter((id) => effectiveCardColor(host.state, actorId, id) === 'red')
      : [...actor.zones.hand]
  if (!eligible.length) return
  host.askSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'materials', data: { actorId, condition: h > actor.hp ? 'wine' : h < actor.hp ? 'slash' : 'duel' },
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: actorId,
      prompt: `【威靖·猘锋】：按当前手牌与体力关系选择牌（${h > actor.hp ? '黑牌当酒' : h < actor.hp ? '红牌当杀' : '当决斗'}）`,
      timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: eligible, hiddenCardSlots: [],
      min: 1, max: h > actor.hp ? eligible.length : 1,
    }) })
}

registerSkillRuntime({
  id: WEISUNCE_WEIJING,
  triggers: [{ event: 'TurnStart', handle(host, ownerId, context) {
    const actorId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (!actorId || actorId === ownerId || !player(host.state, ownerId)?.alive || !player(host.state, actorId)?.alive
      || effectiveKingdomOf(host.state, actorId) !== 'wu') return
    host.queueSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'choose', data: { actorId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const actorId = prompt.data.actorId as PlayerId
    const actor = player(host.state, actorId)
    if (!actor?.alive || !player(host.state, ownerId)?.alive) return
    const options = [{ id: 'damage', label: `受到威·孙策造成的1点伤害` },
      ...(actor.zones.hand.length ? [{ id: 'give', label: '交给威·孙策一张牌，然后可发动对应条件的【猘锋】' }] : [])]
    host.askSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'choose', data: { actorId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【威靖】：令${actor.nickname}执行一项`, timeoutMs: 25_000,
      optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose') {
      const actorId = resolution.data.actorId as PlayerId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'damage') {
        resolveDamage(host as never, { sourceId: ownerId, targetId: actorId, amount: 1, nature: 'normal', cardName: '威靖', sourceSkillId: WEISUNCE_WEIJING })
      } else if (optionId === 'give') {
        const actor = player(host.state, actorId)
        if (!actor?.alive || !actor.zones.hand.length) return
        host.askSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'give', data: { actorId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: actorId, prompt: '【威靖】：交给威·孙策一张牌', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'give') {
      const actorId = resolution.data.actorId as PlayerId
      const actor = player(host.state, actorId), owner = player(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!actor?.alive || !owner?.alive || !cardId || !actor.zones.hand.includes(cardId)) return
      if (!giveCards(host as never, actorId, ownerId, [cardId], WEISUNCE_WEIJING).length) return
      host.askSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'activate-zhefeng', data: { actorId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: actorId, prompt: '【威靖】：是否发动一次对应条件的【猘锋】？', timeoutMs: 25_000,
        optional: true, options: [{ id: 'yes', label: '发动【猘锋】' }, { id: 'no', label: '放弃' }],
      }) })
      return
    }
    if (resolution.step === 'activate-zhefeng') {
      const actorId = resolution.data.actorId as PlayerId
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      b83(host.state).zhefengGranted ??= {}; b83(host.state).zhefengGranted[ownerId] = { actorId, turnNumber: host.state.turnNumber }
      askWeijingMaterials(host, ownerId, actorId)
      return
    }
    if (resolution.step === 'materials') {
      const actorId = resolution.data.actorId as PlayerId
      const condition = resolution.data.condition as 'wine' | 'slash' | 'duel'
      const actor = player(host.state, actorId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!actor?.alive || !cardIds.length || cardIds.length !== new Set(cardIds).size || cardIds.some((id) => !actor.zones.hand.includes(id))) {
        delete b83(host.state).zhefengGranted?.[ownerId]; return
      }
      if (condition === 'wine' && cardIds.some((id) => effectiveCardColor(host.state, actorId, id) !== 'black')) {
        delete b83(host.state).zhefengGranted?.[ownerId]; return
      }
      if (condition === 'slash' && (cardIds.length !== 1 || effectiveCardColor(host.state, actorId, cardIds[0]!) !== 'red')) {
        delete b83(host.state).zhefengGranted?.[ownerId]; return
      }
      const names = condition === 'wine' ? ['酒'] : condition === 'slash' ? ['杀'] : ['决斗']
      const actions: Array<Extract<LegalAction, { kind: 'use-card' }>> = []
      for (const [carrierId, ...extras] of [cardIds, [...cardIds].reverse()]) {
        for (const name of names) {
          const options = declaredCardActions(host.state, actorId, carrierId!, name, `【威靖·猘锋】：使用【${name}】`, {
            sourceSkillId: WEISUNCE_ZHEFENG, ignoreDistance: condition === 'slash', ignoreUsageLimits: condition === 'wine',
          }).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
            .map((action) => ({ ...action, cardIds: [carrierId!, ...extras] }))
          actions.push(...options)
        }
      }
      if (condition === 'duel') actions.push(...delegatedZhefengDuelActions(host.state, actorId, cardIds))
      const unique = actions.filter((action, index) => actions.findIndex((other) => other.targetIds.join(',') === action.targetIds.join(',')
        && other.cardIds.join(',') === action.cardIds.join(',')) === index)
      if (!unique.length || (condition === 'duel' && zhefengDuelUses(host.state, actorId).count >= host.state.players.length)) {
        delete b83(host.state).zhefengGranted?.[ownerId]; return
      }
      host.askSkill({ skillId: WEISUNCE_WEIJING, ownerId, step: 'use-zhefeng', data: { actorId, actions: unique, condition }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: actorId, prompt: '【威靖·猘锋】：选择合法牌及目标', timeoutMs: 25_000,
        optional: false, options: unique.map((action, index) => ({ id: `action:${index}`, label: action.label })),
      }) })
      return
    }
    if (resolution.step === 'use-zhefeng') {
      const actorId = resolution.data.actorId as PlayerId
      const actor = player(host.state, actorId)
      const actions = resolution.data.actions as Array<Extract<LegalAction, { kind: 'use-card' }>>
      const index = Number((response.payload as { optionId?: string }).optionId?.replace('action:', ''))
      const selected = actions[index]
      if (!actor?.alive || !selected || selected.cardIds.some((id) => !actor.zones.hand.includes(id))) {
        delete b83(host.state).zhefengGranted?.[ownerId]; return
      }
      const fresh = resolution.data.condition === 'duel'
        ? delegatedZhefengDuelActions(host.state, actorId, selected.cardIds)
          .find((action) => action.targetIds.join(',') === selected.targetIds.join(','))
        : declaredCardActions(host.state, actorId, selected.cardIds[0]!, selected.asCardName,
          '【威靖·猘锋】：使用牌', { sourceSkillId: WEISUNCE_ZHEFENG,
            ignoreDistance: resolution.data.condition === 'slash', ignoreUsageLimits: resolution.data.condition === 'wine' })
          .find((action) => action.kind === 'use-card' && action.targetIds.join(',') === selected.targetIds.join(','))
      if (!fresh || fresh.kind !== 'use-card') { delete b83(host.state).zhefengGranted?.[ownerId]; return }
      if (resolution.data.condition === 'duel') zhefengDuelUses(host.state, actorId).count += 1
      executeUseCardAction(host as never, actorId, { ...fresh, cardIds: selected.cardIds },
        { ignoreUsageLimits: resolution.data.condition === 'wine' })
      if (resolution.data.condition === 'duel' && actor.zones.hand.includes(selected.cardIds[0]!))
        zhefengDuelUses(host.state, actorId).count -= 1
      return
    }
  },
})

registerSkillRuntime({
  id: DONGXU_QINGLENG,
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || effectiveCardColor(host.state, ownerId, context.cardId) !== 'black') return false
    // A conversion leaves an alias on the physical card; ordinary black cards retain their printed name.
    if (host.state.cardAliases[context.cardId] || host.state.equipmentTransformations?.[context.cardId]
      || effectiveCardName(host.state, context.cardId) !== context.cardName) return false
    if (context.category !== 'basic' && context.category !== 'trick') return false
    const candidates = host.state.players.filter((entry) => entry.alive
      && (entry.zones.hand.length > 0 || Object.values(entry.zones.equipment).some(Boolean)))
    if (!candidates.length) return false
    host.askSkill({ skillId: DONGXU_QINGLENG, ownerId, step: 'offer', data: {
      sourceId: context.sourceId, cardId: context.cardId, cardName: context.cardName,
    } satisfies QinglengFlow, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【清冷】：是否弃置一名角色一张牌？若弃置装备牌，此【${context.cardName}】对你无效；否则可将此牌列入下次【酖毒】。`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '弃置一张牌' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const flow = resolution.data as QinglengFlow
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumeCardTarget(); return }
      const candidates = host.state.players.filter((entry) => entry.alive
        && (entry.zones.hand.length > 0 || Object.values(entry.zones.equipment).some(Boolean))).map((entry) => entry.id)
      if (!candidates.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: DONGXU_QINGLENG, ownerId, step: 'discard-target', data: flow,
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【清冷】：选择一名有牌的角色', timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      const cardIds = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!target?.alive || !cardIds.length || !targetId) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: DONGXU_QINGLENG, ownerId, step: 'discard-card', data: { ...flow, discardTargetId: targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【清冷】：弃置${target.nickname}一张牌`, timeoutMs: 25_000, optional: false,
          purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'discard-card') {
      const target = flow.discardTargetId ? player(host.state, flow.discardTargetId) : undefined
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owned = target && cardId && (target.zones.hand.includes(cardId)
        || Object.values(target.zones.equipment).includes(cardId))
      if (!target?.alive || !cardId || !owned) { host.resumeCardTarget(); return }
      const wasEquipment = Object.values(target.zones.equipment).includes(cardId)
      discardCardsByOwners(host as never, [{ playerId: target.id, cardId }], DONGXU_QINGLENG)
      if (wasEquipment) {
        cancelCardTargetForOwner(host, ownerId)
        host.resumeCardTarget()
      } else host.askSkill({ skillId: DONGXU_QINGLENG, ownerId, step: 'add-poison', data: flow,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: `【清冷】：是否将此【${flow.cardName}】加入下次【酖毒】的可使用牌？`, timeoutMs: 25_000, optional: true,
          options: [{ id: 'yes', label: '加入' }, { id: 'no', label: '不加入' }] }) })
      return
    }
    if (resolution.step === 'add-poison') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        const records = (b83(host.state).dongxuPoisonCards ??= {}) as Record<PlayerId, CardId[]>
        const queue = records[ownerId] ??= []
        if (!queue.includes(flow.cardId)) queue.push(flow.cardId)
      }
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: DONGXU_ZHENDU,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = (context.event.payload as { phase?: string; playerId?: PlayerId }).phase
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (phase !== 'play' || turnPlayerId !== ownerId) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const handCardIds = owner.zones.hand.filter((cardId) => {
        const card = host.state.cards[cardId]
        return card?.category === 'basic' || (card?.category === 'trick' && INSTANT_TRICKS.has(card.name))
      })
      const extraCardIds = ((b83(host.state).dongxuPoisonCards as Record<PlayerId, CardId[]> | undefined)?.[ownerId] ?? [])
        .filter((cardId) => host.state.zones.discardPile.includes(cardId))
      const cardIds = [...new Set([...handCardIds, ...extraCardIds])]
      if (!cardIds.length) return
      host.askSkill({ skillId: DONGXU_ZHENDU, ownerId, step: 'show', data: { extraCardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【酖毒】：展示至多五张基本牌或普通锦囊牌，回合开始时依次使用',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: Math.min(5, cardIds.length),
      }) })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      const queue = (b83(host.state).dongxuPoisonQueue as Record<PlayerId, CardId[]> | undefined)?.[ownerId]
      if (turnPlayerId !== ownerId || !queue?.length) return
      delete (b83(host.state).dongxuPoisonQueue as Record<PlayerId, CardId[]>)[ownerId]
      host.queueSkill({ skillId: DONGXU_ZHENDU, ownerId, step: 'next', data: { cardIds: queue, index: 0 } satisfies ZhenduFlow })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const all = b83(host.state).dongxuPoisonFlows as Record<PlayerId, ZhenduFlow> | undefined
      const flow = all?.[ownerId]
      if (!flow?.activeCardId || context.event.sourceId !== ownerId || context.event.sourceSkillId !== DONGXU_ZHENDU) return
      delete flow.activeCardId
      flow.index += 1
      host.queueSkill({ skillId: DONGXU_ZHENDU, ownerId, step: 'next', data: flow })
    } },
    { event: 'Recover', handle(host, ownerId) { drawDuringZhendu(host, ownerId) } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      if ((payload.finalAmount ?? 0) > 0) drawDuringZhendu(host, ownerId)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      if (turnPlayerId !== ownerId) return
      const exempt = b83(host.state).dongxuPoisonDrawn as Record<PlayerId, CardId[]> | undefined
      if (exempt) delete exempt[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const flow = prompt.data as ZhenduFlow
    const all = (b83(host.state).dongxuPoisonFlows ??= {}) as Record<PlayerId, ZhenduFlow>
    all[ownerId] = flow
    if (prompt.step === 'next') {
      if (!player(host.state, ownerId)?.alive) { delete all[ownerId]; return }
      while (flow.index < flow.cardIds.length) {
        const cardId = flow.cardIds[flow.index]!
        const card = host.state.cards[cardId]
        const isInHand = player(host.state, ownerId)?.zones.hand.includes(cardId) ?? false
        const isInDiscard = host.state.zones.discardPile.includes(cardId)
        if ((!isInHand && !isInDiscard) || !card
          || !(card.category === 'basic' || (card.category === 'trick' && INSTANT_TRICKS.has(card.name)))) {
          flow.index += 1
          continue
        }
        const actions = isInHand
          ? skillOtherHandCardUseActions(host.state, ownerId, ownerId, cardId, undefined, DONGXU_ZHENDU,
            undefined, { allowSelf: true, ignoreDistance: true })
          : skillDiscardCardUseActions(host.state, ownerId, cardId, DONGXU_ZHENDU, undefined, { ignoreDistance: true })
        if (!actions.length) { flow.index += 1; continue }
        host.askSkill({ skillId: DONGXU_ZHENDU, ownerId, step: 'use', data: { ...flow, activeCardId: cardId, actionIds: actions.map((action) => action.id) },
          build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
            prompt: `【酖毒】：选择【${card.name}】的目标`, timeoutMs: 25_000, optional: false,
            options: actions.map((action) => ({ id: action.id, label: action.label })) }) })
        return
      }
      delete all[ownerId]
      return
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'show') {
      const owner = player(host.state, ownerId)
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || selected.length > 5) return
      const extraCardIds = (resolution.data.extraCardIds as CardId[] | undefined) ?? []
      const valid = [...new Set(selected)].filter((cardId) => (owner.zones.hand.includes(cardId)
        || (extraCardIds.includes(cardId) && host.state.zones.discardPile.includes(cardId)))
        && (host.state.cards[cardId]?.category === 'basic'
          || (host.state.cards[cardId]?.category === 'trick' && INSTANT_TRICKS.has(host.state.cards[cardId]!.name))))
      if (!valid.length) return
      ;((b83(host.state).dongxuPoisonQueue ??= {}) as Record<PlayerId, CardId[]>)[ownerId] = valid
      delete (b83(host.state).dongxuPoisonCards as Record<PlayerId, CardId[]> | undefined)?.[ownerId]
      host.dispatch('SkillActivated', { skillId: DONGXU_ZHENDU, skillName: '酖毒', playerId: ownerId,
        cardIds: valid, logText: `${owner.nickname}发动【酖毒】，展示${valid.length}张牌` }, { sourceId: ownerId, cardIds: valid })
      return
    }
    if (resolution.step !== 'use') return
    const flow = resolution.data as ZhenduFlow & { actionIds?: string[] }
    const actionId = (response.payload as { optionId?: string }).optionId
    const cardId = flow.activeCardId
    if (!cardId || !actionId || !flow.actionIds?.includes(actionId)) return
    const all = (b83(host.state).dongxuPoisonFlows ??= {}) as Record<PlayerId, ZhenduFlow>
    all[ownerId] = { cardIds: flow.cardIds, index: flow.index, activeCardId: cardId }
    const started = player(host.state, ownerId)?.zones.hand.includes(cardId)
      ? host.beginSkillCardUseFromOtherHand(ownerId, ownerId, cardId, DONGXU_ZHENDU, actionId,
        undefined, undefined, { allowSelf: true, ignoreDistance: true })
      : host.beginSkillCardUseFromDiscard(ownerId, cardId, DONGXU_ZHENDU, actionId, undefined, { ignoreDistance: true })
    if (!started) {
      delete all[ownerId]!.activeCardId
      host.queueSkill({ skillId: DONGXU_ZHENDU, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } })
    }
  },
  handLimitExempt(state, ownerId, cardId) {
    return (state as SanguoshaState & { b83?: Record<string, any> }).b83?.dongxuPoisonDrawn?.[ownerId]?.includes(cardId) ?? false
  },
})

function drawDuringZhendu(host: SkillHost, ownerId: PlayerId): void {
  const flow = (b83(host.state).dongxuPoisonFlows as Record<PlayerId, ZhenduFlow> | undefined)?.[ownerId]
  if (!flow?.activeCardId || !player(host.state, ownerId)?.alive) return
  const drawn = drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload)) as CardId[]
  if (!drawn.length) return
  const all = (b83(host.state).dongxuPoisonDrawn ??= {}) as Record<PlayerId, CardId[]>
  all[ownerId] ??= []
  all[ownerId]!.push(...drawn)
}

registerSkillRuntime({
  id: JIMIAO_ZOUYI,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && player(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, JIMIAO_ZOUYI)
      ? [{ id: `${JIMIAO_ZOUYI}:activate`, label: '诹议：选择至多两项' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${JIMIAO_ZOUYI}:activate` || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || !player(host.state, ownerId)?.alive || usedThisPhase(host.state, ownerId, JIMIAO_ZOUYI)) return
    markUsedThisPhase(host.state, ownerId, JIMIAO_ZOUYI)
    const owner = player(host.state, ownerId)!
    const options = [{ id: 'discard', label: '摸两张牌，然后可弃置一名其他角色一张牌' },
      ...(owner.zones.hand.length || Object.values(owner.zones.equipment).some(Boolean)
        ? [{ id: 'gift', label: '弃置一张牌，然后可令一名其他角色摸两张牌' }] : [])]
    if (!options.length) return
    host.askSkill({ skillId: JIMIAO_ZOUYI, ownerId, step: 'options', data: {}, build: (id): ChooseOptionsRequest => ({
      id, kind: 'choose-options', playerId: ownerId, prompt: '【诹议】：选择至多两项依次发动', timeoutMs: 25_000,
      optional: false, options, min: 1, max: Math.min(2, options.length),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'options') {
      const optionIds = (response.payload as { optionIds?: string[] }).optionIds ?? []
      const selected = [...new Set(optionIds)].filter((id): id is 'discard' | 'gift' => id === 'discard' || id === 'gift')
        .filter((id) => id !== 'gift' || Boolean(player(host.state, ownerId)?.zones.hand.length
          || Object.values(player(host.state, ownerId)?.zones.equipment ?? {}).some(Boolean)))
      if (selected.length) startZouyiOption(host, ownerId, { selected, index: 0 })
      return
    }
    const flow = resolution.data as ZouyiFlow & { targetId?: PlayerId }
    if (resolution.step === 'discard-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) { startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 }); return }
      const target = player(host.state, targetId)
      const cardIds = target?.alive ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!cardIds.length) { startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 }); return }
      host.askSkill({ skillId: JIMIAO_ZOUYI, ownerId, step: 'discard-target-card', data: { ...flow, targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【诹议】：弃置${target!.nickname}一张牌`, timeoutMs: 25_000, optional: false,
          purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'discard-target-card') {
      const targetId = flow.targetId
      const target = targetId ? player(host.state, targetId) : undefined
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (target?.alive && cardId && (target.zones.hand.includes(cardId) || Object.values(target.zones.equipment).includes(cardId)))
        discardCardsByOwners(host as never, [{ playerId: target.id, cardId }], JIMIAO_ZOUYI)
      startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 })
      return
    }
    if (resolution.step === 'discard-self') {
      const owner = player(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || (!owner.zones.hand.includes(cardId) && !Object.values(owner.zones.equipment).includes(cardId))) {
        startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 }); return
      }
      discardCardsByIds(host as never, ownerId, [cardId], JIMIAO_ZOUYI)
      askZouyiDrawTarget(host, ownerId, flow)
      return
    }
    if (resolution.step === 'draw-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && player(host.state, targetId)?.alive)
        drawCards(host.state, host.rng, targetId, 2, (name, payload) => host.dispatch(name, payload))
      startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 })
    }
  },
})

function startZouyiOption(host: SkillHost, ownerId: PlayerId, flow: ZouyiFlow): void {
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  if (flow.index >= flow.selected.length) {
    const equalHandCount = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length === owner.zones.hand.length).length
    const uses = (b83(host.state).jimiaoYanxiUses ??= {}) as Record<PlayerId, number>
    uses[ownerId] = (uses[ownerId] ?? 0) + equalHandCount
    if (equalHandCount > 0) recover(host as never, ownerId, equalHandCount, ownerId)
    host.dispatch('SkillActivated', { skillId: JIMIAO_ZOUYI, skillName: '诹议', playerId: ownerId,
      amount: equalHandCount, logText: `吉邈吉穆发动【诹议】，增加${equalHandCount}次【掩袭】并回复${equalHandCount}点体力` }, { sourceId: ownerId })
    return
  }
  const next: ZouyiFlow = { selected: flow.selected, index: flow.index }
  if (flow.selected[flow.index] === 'discard') {
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
      && (candidate.zones.hand.length || Object.values(candidate.zones.equipment).some(Boolean))).map((candidate) => candidate.id)
    host.askSkill({ skillId: JIMIAO_ZOUYI, ownerId, step: 'discard-target', data: next,
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【诹议】：可选择一名其他角色弃置其一张牌', timeoutMs: 25_000, optional: true,
        candidateIds, min: 0, max: 1 }) })
    return
  }
  const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
  if (!cardIds.length) { startZouyiOption(host, ownerId, { selected: flow.selected, index: flow.index + 1 }); return }
  host.askSkill({ skillId: JIMIAO_ZOUYI, ownerId, step: 'discard-self', data: next,
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
      prompt: '【诹议】：弃置一张牌', timeoutMs: 25_000, optional: false, purpose: 'skill',
      cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
}

function askZouyiDrawTarget(host: SkillHost, ownerId: PlayerId, flow: ZouyiFlow): void {
  const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  host.askSkill({ skillId: JIMIAO_ZOUYI, ownerId, step: 'draw-target', data: flow,
    build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: '【诹议】：可令一名其他角色摸两张牌', timeoutMs: 25_000, optional: true,
      candidateIds, min: 0, max: 1 }) })
}

registerSkillRuntime({
  id: JIMIAO_YANXI,
  triggers: [
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      const charges = (b83(host.state).jimiaoYanxiUses as Record<PlayerId, number> | undefined)?.[ownerId] ?? 0
      if (!targetId || targetId === ownerId || charges <= 0 || !player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive) return
      host.askSkill({ skillId: JIMIAO_YANXI, ownerId, step: 'activate', data: { targetId } satisfies YanxiFlow,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: `【掩袭】：是否对回合结束的${player(host.state, targetId)!.nickname}使用【杀】？若造成伤害则改为失去体力。`,
          timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '使用【杀】' }, { id: 'no', label: '不发动' }] }) })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== JIMIAO_YANXI) return
      const flow = (b83(host.state).jimiaoYanxiFlow as Record<PlayerId, YanxiFlow> | undefined)?.[ownerId]
      if (!flow) return
      if (((b83(host.state).jimiaoYanxiUses as Record<PlayerId, number> | undefined)?.[ownerId] ?? 0) > 0
        && player(host.state, flow.targetId)?.alive)
        host.queueSkill({ skillId: JIMIAO_YANXI, ownerId, step: 'repeat', data: flow })
      else delete (b83(host.state).jimiaoYanxiFlow as Record<PlayerId, YanxiFlow>)[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'repeat') return
    const flow = prompt.data as YanxiFlow
    startYanxiSlash(host, ownerId, flow.targetId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'activate' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    startYanxiSlash(host, ownerId, (resolution.data as YanxiFlow).targetId)
  },
  replacesDamageWithHpLoss(state, ownerId, context) {
    const resolution = state.cardResolution
    return context.cardName === '杀' && resolution?.kind === 'slash' && resolution.sourceId === ownerId
      && resolution.targetId === context.targetId && state.cards[resolution.cardId]?.sourceSkillId === JIMIAO_YANXI
  },
})

function startYanxiSlash(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = player(host.state, ownerId)
  const target = player(host.state, targetId)
  const allUses = (b83(host.state).jimiaoYanxiUses ??= {}) as Record<PlayerId, number>
  const uses = allUses[ownerId] ?? 0
  if (!owner?.alive || !target?.alive || uses <= 0) {
    delete (b83(host.state).jimiaoYanxiFlow as Record<PlayerId, YanxiFlow> | undefined)?.[ownerId]
    return
  }
  allUses[ownerId] = uses - 1
  ;((b83(host.state).jimiaoYanxiFlow ??= {}) as Record<PlayerId, YanxiFlow>)[ownerId] = { targetId }
  if (!host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JIMIAO_YANXI, ignoreDistance: true })) {
    allUses[ownerId] += 1
    delete (b83(host.state).jimiaoYanxiFlow as Record<PlayerId, YanxiFlow>)[ownerId]
  }
}

registerSkillRuntime({
  id: ZHANGHUAN_YIJU,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const payload = context.event.payload as { targetIds?: PlayerId[] }
    if (!sourceId || sourceId === ownerId || payload.targetIds?.length !== 1 || payload.targetIds[0] !== ownerId) return
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    const cardIds = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (!cardIds.length) return
    host.askSkill({ skillId: ZHANGHUAN_YIJU, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【义拒】：弃置一张牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  } }],
  resume(host: SkillHost, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = player(host.state, ownerId)
    const owned = new Set([...owner?.zones.hand ?? [], ...Object.values(owner?.zones.equipment ?? {}).filter((id): id is CardId => Boolean(id))])
    if (chosen.length !== 1 || !owned.has(chosen[0]!)) return
    discardCardsByIds(host as never, ownerId, chosen, ZHANGHUAN_YIJU)
  },
})

registerSkillRuntime({
  id: ZHANGHUAN_SHUGUO,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; reason?: string }
      if (!payload.cardId || payload.reason !== 'discard') return
      const data = b83(host.state)
      data.shuguoDiscards ??= []
      const records = data.shuguoDiscards as DiscardRecord[]
      if (!records.some((entry) => entry.cardId === payload.cardId && entry.turnNumber === host.state.turnNumber))
        records.push({ cardId: payload.cardId, fromPlayerId: payload.fromPlayerId ?? null, turnNumber: host.state.turnNumber })
      void ownerId
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turnOwnerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      if (!turnOwnerId) return
      const all = (b83(host.state).shuguoDiscards as DiscardRecord[] | undefined) ?? []
      const records = all.filter((entry) => entry.turnNumber === host.state.turnNumber)
      b83(host.state).shuguoDiscards = all.filter((entry) => entry.turnNumber > host.state.turnNumber)
      if (!records.length) return
      host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: {
        ownerId, turnNumber: host.state.turnNumber, records, index: 0, usedCardIds: [],
      } satisfies ShuguoFlow })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const flow = b83(host.state).shuguoFlow as ShuguoFlow | undefined
      if (!flow || flow.ownerId !== ownerId || context.event.sourceSkillId !== ZHANGHUAN_SHUGUO) return
      if (flow.pendingCardId && !flow.usedCardIds.includes(flow.pendingCardId)) flow.usedCardIds.push(flow.pendingCardId)
      const usedOpponentCard = flow.pendingFromPlayerId !== null && flow.pendingFromPlayerId !== ownerId
      delete flow.pendingCardId
      delete flow.pendingFromPlayerId
      if (usedOpponentCard) finishShuguo(host, ownerId, flow)
      else host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } satisfies ShuguoFlow })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const flow = prompt.data as ShuguoFlow
    if (prompt.step === 'next') {
      b83(host.state).shuguoFlow = flow
      if (flow.turnNumber !== host.state.turnNumber || !player(host.state, ownerId)?.alive) { finishShuguo(host, ownerId, flow); return }
      while (flow.index < flow.records.length) {
        const record = flow.records[flow.index]!
        if (!host.state.zones.discardPile.includes(record.cardId)) { flow.index += 1; continue }
        const actions = skillDiscardCardUseActions(host.state, ownerId, record.cardId, ZHANGHUAN_SHUGUO)
        if (!actions.length) { flow.index += 1; continue }
        host.askSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'choose', data: flow, build: (id): ChooseOptionRequest => ({
          id, kind: 'choose-option', playerId: ownerId, prompt: `【戍国】：是否使用本回合因弃置进入弃牌堆的【${host.state.cards[record.cardId]?.name ?? ''}】？`,
          timeoutMs: 25_000, optional: true, options: [{ id: 'use', label: '使用' }, { id: 'skip', label: '不使用' }],
        }) })
        return
      }
      finishShuguo(host, ownerId, flow)
      return
    }
    if (prompt.step === 'actions') {
      const record = flow.records[flow.index]
      if (!record || !host.state.zones.discardPile.includes(record.cardId)) {
        host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } satisfies ShuguoFlow })
        return
      }
      const actions = skillDiscardCardUseActions(host.state, ownerId, record.cardId, ZHANGHUAN_SHUGUO)
      if (!actions.length) {
        host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } satisfies ShuguoFlow })
        return
      }
      host.askSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'action', data: flow, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【戍国】：选择此牌的合法使用方式', timeoutMs: 25_000, optional: false,
        options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const flow = resolution.data as ShuguoFlow
    if (resolution.step === 'choose') {
      if ((response.payload as { optionId?: string }).optionId !== 'use') {
        host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } satisfies ShuguoFlow })
      } else host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'actions', data: flow })
      return
    }
    if (resolution.step !== 'action') return
    const record = flow.records[flow.index]
    const actionId = (response.payload as { optionId?: string }).optionId
    if (!record || !actionId) return
    flow.pendingCardId = record.cardId
    flow.pendingFromPlayerId = record.fromPlayerId
    b83(host.state).shuguoFlow = flow
    if (!host.beginSkillCardUseFromDiscard(ownerId, record.cardId, ZHANGHUAN_SHUGUO, actionId)) {
      delete flow.pendingCardId
      delete flow.pendingFromPlayerId
      host.queueSkill({ skillId: ZHANGHUAN_SHUGUO, ownerId, step: 'next', data: { ...flow, index: flow.index + 1 } satisfies ShuguoFlow })
    }
  },
})

registerSkillRuntime({
  id: WUZHI_YUANRONG,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; reason?: string }
      if (!payload.cardId || payload.reason !== 'discard') return
      const records = (b83(host.state).yuanrongDiscards ??= []) as YuanrongRecord[]
      if (!records.some((record) => record.cardId === payload.cardId && record.turnNumber === host.state.turnNumber))
        records.push({ cardId: payload.cardId, fromPlayerId: payload.fromPlayerId ?? null, turnNumber: host.state.turnNumber })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId ?? context.event.sourceId
      if (playerId !== ownerId) return
      const all = (b83(host.state).yuanrongDiscards as YuanrongRecord[] | undefined) ?? []
      const records = all.filter((record) => record.turnNumber === host.state.turnNumber)
      b83(host.state).yuanrongDiscards = all.filter((record) => record.turnNumber > host.state.turnNumber)
      if (!records.length) return
      host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: 'black-pick', data: { turnNumber: host.state.turnNumber, records } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const flow = (b83(host.state).yuanrongFlow as Record<PlayerId, YuanrongFlow> | undefined)?.[ownerId]
      if (!flow || context.event.sourceId !== ownerId || context.event.sourceSkillId !== WUZHI_YUANRONG) return
      if (flow.stage === 'black-pending') {
        flow.stage = undefined
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: 'red-pick', data: flow })
      } else if (flow.stage === 'red-pending') {
        delete (b83(host.state).yuanrongFlow as Record<PlayerId, YuanrongFlow>)[ownerId]
      }
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const flow = prompt.data as YuanrongFlow & { records?: YuanrongRecord[] }
    const records = flow.records ?? ((b83(host.state).yuanrongDiscards as YuanrongRecord[] | undefined) ?? [])
    const optionsForColor = (color: 'red' | 'black') => records.filter((record) => host.state.zones.discardPile.includes(record.cardId)
      && effectiveCardColor(host.state, ownerId, record.cardId) === color)
    if (prompt.step === 'black-pick' || prompt.step === 'red-pick') {
      const color = prompt.step === 'black-pick' ? 'black' : 'red'
      const candidates = optionsForColor(color)
      if (!candidates.length) {
        if (color === 'black') host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: 'red-pick', data: flow })
        else delete (b83(host.state).yuanrongFlow as Record<PlayerId, YuanrongFlow> | undefined)?.[ownerId]
        return
      }
      host.askSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step, data: { ...flow, records }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【圆融】：选择一张本回合因弃置进入弃牌堆的${color === 'black' ? '黑色' : '红色'}牌`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'skip', label: '不使用' }, ...candidates.map(({ cardId }) => ({
          id: cardId, label: `【${host.state.cards[cardId]?.name ?? '未知牌'}】`,
        }))],
      }) })
      return
    }
    if (prompt.step === 'black-name' || prompt.step === 'red-name') {
      const cardId = flow.cardId
      if (!cardId || !host.state.zones.discardPile.includes(cardId)) {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step === 'black-name' ? 'red-pick' : 'finish', data: flow })
        return
      }
      const names = prompt.step === 'black-name' ? [...INSTANT_TRICKS] : ['杀', '闪', '桃', '酒']
      const legal = names.filter((name) => skillDiscardCardUseActions(host.state, ownerId, cardId, WUZHI_YUANRONG, name).length > 0)
      if (!legal.length) {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step === 'black-name' ? 'red-pick' : 'finish', data: flow })
        return
      }
      host.askSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step, data: flow, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId,
        prompt: `【圆融】：将这张牌当作哪张${prompt.step === 'black-name' ? '普通锦囊' : '基本牌'}使用？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'skip', label: '不使用' }, ...legal.map((name) => ({ id: name, label: `【${name}】` }))],
      }) })
      return
    }
    if (prompt.step === 'black-actions' || prompt.step === 'red-actions') {
      if (!flow.cardId || !flow.cardName) return
      const actions = skillDiscardCardUseActions(host.state, ownerId, flow.cardId, WUZHI_YUANRONG, flow.cardName)
      if (!actions.length) {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step === 'black-actions' ? 'red-pick' : 'finish', data: flow })
        return
      }
      host.askSkill({ skillId: WUZHI_YUANRONG, ownerId, step: prompt.step, data: flow, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【圆融】：选择【${flow.cardName}】的使用目标`, timeoutMs: 25_000, optional: true,
        options: [{ id: 'skip', label: '不使用' }, ...actions.map((action) => ({ id: action.id, label: action.label }))],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const flow = resolution.data as YuanrongFlow & { records?: YuanrongRecord[] }
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'black-pick' || resolution.step === 'red-pick') {
      const black = resolution.step === 'black-pick'
      if (!optionId || optionId === 'skip') {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'red-pick' : 'finish', data: flow })
        return
      }
      const cardId = optionId as CardId
      const color = effectiveCardColor(host.state, ownerId, cardId)
      const wasDiscardedThisTurn = (flow.records ?? []).some((record) => record.cardId === cardId
        && record.turnNumber === flow.turnNumber)
      if (!wasDiscardedThisTurn || !host.state.zones.discardPile.includes(cardId)
        || color !== (black ? 'black' : 'red')) {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'black-pick' : 'red-pick', data: flow })
        return
      }
      host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'black-name' : 'red-name', data: { ...flow, cardId } })
      return
    }
    if (resolution.step === 'black-name' || resolution.step === 'red-name') {
      const black = resolution.step === 'black-name'
      if (!optionId || optionId === 'skip') {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'red-pick' : 'finish', data: flow })
        return
      }
      const cardId = flow.cardId!
      const legal = skillDiscardCardUseActions(host.state, ownerId, cardId, WUZHI_YUANRONG, optionId)
      if (!legal.length) {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'black-name' : 'red-name', data: flow })
        return
      }
      host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'black-actions' : 'red-actions', data: { ...flow, cardName: optionId } })
      return
    }
    if (resolution.step === 'black-actions' || resolution.step === 'red-actions') {
      const black = resolution.step === 'black-actions'
      if (!optionId || optionId === 'skip') {
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'red-pick' : 'finish', data: flow })
        return
      }
      const flowByOwner = (b83(host.state).yuanrongFlow ??= {}) as Record<PlayerId, YuanrongFlow>
      flowByOwner[ownerId] = { ...flow, stage: black ? 'black-pending' : 'red-pending' }
      if (!host.beginSkillCardUseFromDiscard(ownerId, flow.cardId!, WUZHI_YUANRONG, optionId, flow.cardName)) {
        delete flowByOwner[ownerId]
        host.queueSkill({ skillId: WUZHI_YUANRONG, ownerId, step: black ? 'red-pick' : 'finish', data: flow })
      }
      return
    }
    if (resolution.step === 'finish') delete (b83(host.state).yuanrongFlow as Record<PlayerId, YuanrongFlow> | undefined)?.[ownerId]
  },
})

type RenshuangRoundNames = { roundNumber: number; names: string[] }
type UseCardAction = Extract<LegalAction, { kind: 'use-card' }>

function renshuangActions(host: SkillHost, ownerId: PlayerId, cardId: CardId, cardName: string): UseCardAction[] {
  return instantTrickActions(host.state, ownerId, cardId, cardName)
    .filter((action): action is UseCardAction => action.kind === 'use-card')
}

function triggerRenshuang(host: SkillHost, ownerId: PlayerId, changedToOne: boolean): void {
  if (!changedToOne || player(host.state, ownerId)?.hp !== 1) return
  restoreCharacter(host as never, ownerId, RENWAN_RENSHUANG)
  host.queueSkill({ skillId: RENWAN_RENSHUANG, ownerId, step: 'choose-name', data: { roundNumber: host.state.roundNumber } })
}

function juanjiCount(state: SanguoshaState, ownerId: PlayerId): number {
  const counts = b83(state).juanjiCount as Record<PlayerId, { turnNumber: number; count: number }> | undefined
  const current = counts?.[ownerId]
  return current?.turnNumber === state.turnNumber ? current.count : 0
}

function juanjiModeId(mode: 1 | 2 | 3): string { return `${RENWAN_JUANJI}:${mode}` }

function ownedCardIds(target: NonNullable<ReturnType<typeof player>>): CardId[] {
  return [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
}

function requestJuanjiDiscard(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  if (index >= targetIds.length) { flipCharacter(host as never, ownerId, RENWAN_JUANJI); return }
  const targetId = targetIds[index]!
  const target = player(host.state, targetId)
  if (!target?.alive || !ownedCardIds(target).length) {
    host.queueSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'discard-next', data: { targetIds, index: index + 1 } })
    return
  }
  host.askSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'discard-one', data: { targetIds, index, targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【狷急】：弃置${target.nickname}一张牌`, timeoutMs: 25_000,
    optional: false, purpose: 'skill',
    cardIds: Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
    hiddenCardSlots: target.zones.hand.map((_, handIndex) => hiddenHandSlot(targetId, handIndex)), min: 1, max: 1,
  }) })
}

registerSkillRuntime({
  id: RENWAN_JUANJI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !player(state, ownerId)?.alive) return []
    return ([1, 2, 3] as const)
      .filter((mode) => mode !== 1 || state.players.some((candidate) => candidate.alive && candidate.id !== ownerId))
      .filter((mode) => !usedThisPhase(state, ownerId, juanjiModeId(mode)))
      .map((mode) => ({ id: juanjiModeId(mode), label: `发动【狷急】${mode}` }))
  },
  invokeActive(host, ownerId, actionId) {
    const mode = ([1, 2, 3] as const).find((candidate) => actionId === juanjiModeId(candidate))
    if (!mode || usedThisPhase(host.state, ownerId, juanjiModeId(mode))) return
    const count = juanjiCount(host.state, ownerId) + 1
    const counts = (b83(host.state).juanjiCount ??= {}) as Record<PlayerId, { turnNumber: number; count: number }>
    counts[ownerId] = { turnNumber: host.state.turnNumber, count }
    markUsedThisPhase(host.state, ownerId, juanjiModeId(mode))
    if (mode === 1) {
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (!candidates.length) return
      host.askSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'heal-damage-target', data: { count }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【狷急】：选择一名角色（你与其各回复${count}点体力，然后各受到${count}点伤害）`,
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (mode === 2) {
      const candidates = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && ownedCardIds(candidate).length)
        .map((candidate) => candidate.id)
      host.askSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'discard-targets', data: { count }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【狷急】：选择至多${count}名有牌的其他角色，各弃置其一张牌后你翻面`,
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 0, max: Math.min(count, candidates.length),
      }) })
      return
    }
    const drawn = drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
    const discardCount = Math.min(drawn.length, player(host.state, ownerId)?.zones.hand.length ?? 0)
    if (!discardCount) return
    host.askSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'draw-discard', data: { discardCount }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【狷急】：弃置${discardCount}张手牌`, timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...(player(host.state, ownerId)?.zones.hand ?? [])],
      hiddenCardSlots: [], min: discardCount, max: discardCount,
    }) })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard-next') return
    const { targetIds, index } = prompt.data as { targetIds: PlayerId[]; index: number }
    requestJuanjiDiscard(host, ownerId, targetIds, index)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'heal-damage-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const count = Number(resolution.data.count)
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive) return
      recover(host as never, ownerId, count, RENWAN_JUANJI)
      recover(host as never, targetId, count, RENWAN_JUANJI)
      resolveDamageSequence(host as never, { sourceId: ownerId, targetIds: [ownerId, targetId], amount: count,
        nature: 'normal', cardId: null, cardName: '狷急', sourceSkillId: RENWAN_JUANJI })
      return
    }
    if (resolution.step === 'discard-targets') {
      const count = Number(resolution.data.count)
      const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const ordered = [...new Set(selected)].filter((targetId) => targetId !== ownerId && player(host.state, targetId)?.alive
        && ownedCardIds(player(host.state, targetId)!).length)
        .sort((left, right) => (player(host.state, left)?.seat ?? 0) - (player(host.state, right)?.seat ?? 0)).slice(0, count)
      requestJuanjiDiscard(host, ownerId, ordered, 0)
      return
    }
    if (resolution.step === 'discard-one') {
      const { targetIds, index, targetId } = resolution.data as { targetIds: PlayerId[]; index: number; targetId: PlayerId }
      const target = player(host.state, targetId)
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (target?.alive && selected) {
        const handIndex = target.zones.hand.findIndex((_, cardIndex) => hiddenHandSlot(targetId, cardIndex) === selected)
        const cardId = handIndex >= 0 ? target.zones.hand[handIndex] : selected as CardId
        if (ownedCardIds(target).includes(cardId)) discardCardsByOwners(host as never, [{ playerId: targetId, cardId }], RENWAN_JUANJI)
      }
      host.queueSkill({ skillId: RENWAN_JUANJI, ownerId, step: 'discard-next', data: { targetIds, index: index + 1 } })
      return
    }
    if (resolution.step === 'draw-discard') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const count = Number(resolution.data.discardCount)
      const hand = new Set(player(host.state, ownerId)?.zones.hand ?? [])
      if (selected.length !== count || selected.some((cardId) => !hand.has(cardId))) return
      discardCardsByIds(host as never, ownerId, selected, RENWAN_JUANJI)
    }
  },
})

registerSkillRuntime({
  id: RENWAN_RENSHUANG,
  triggers: [
    { event: 'HpSet', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; previousHp?: number; hp?: number }
      if (payload.playerId !== ownerId) return
      triggerRenshuang(host, ownerId, payload.previousHp !== 1 && payload.hp === 1)
    } },
    { event: 'LoseHp', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; amount?: number; hp?: number }
      if (payload.playerId !== ownerId) return
      triggerRenshuang(host, ownerId, Number(payload.amount) > 0 && payload.hp === 1)
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; amount?: number; hp?: number }
      if (payload.playerId !== ownerId) return
      triggerRenshuang(host, ownerId, Number(payload.amount) > 0 && payload.hp === 1)
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      triggerRenshuang(host, ownerId, player(host.state, ownerId)?.hp === 1)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choose-name') {
      const roundNumber = Number(prompt.data.roundNumber)
      const used = (b83(host.state).renshuangNames as Record<PlayerId, RenshuangRoundNames> | undefined)?.[ownerId]
      const names = virtualTrickChoices(host.state, ownerId).filter((name) => !(used?.roundNumber === roundNumber && used.names.includes(name)))
      if (!names.length || !player(host.state, ownerId)?.alive) return
      host.askSkill({ skillId: RENWAN_RENSHUANG, ownerId, step: 'choose-name', data: { roundNumber }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【纫霜】：是否视为使用一张本轮未使用过的普通锦囊？',
        timeoutMs: 25_000, optional: true,
        options: [{ id: 'skip', label: '不使用' }, ...names.map((name) => ({ id: name, label: `【${name}】` }))],
      }) })
      return
    }
    if (prompt.step === 'choose-action') {
      const { cardId, cardName } = prompt.data as { cardId: CardId; cardName: string }
      const actions = renshuangActions(host, ownerId, cardId, cardName)
      if (!actions.length) return
      host.askSkill({ skillId: RENWAN_RENSHUANG, ownerId, step: 'choose-action', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【纫霜】：选择【${cardName}】的合法目标`,
        timeoutMs: 25_000, optional: false,
        options: actions.map((action, index) => ({
          id: String(index),
          label: action.targetIds.length
            ? `对${action.targetIds.map((targetId) => player(host.state, targetId)?.nickname ?? targetId).join('、')}使用`
            : `使用【${cardName}】`,
        })),
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-name') {
      const cardName = (response.payload as { optionId?: string }).optionId
      if (!cardName || cardName === 'skip' || !INSTANT_TRICKS.has(cardName)) return
      const roundNumber = Number(resolution.data.roundNumber)
      const used = (b83(host.state).renshuangNames ??= {}) as Record<PlayerId, RenshuangRoundNames>
      const record = used[ownerId]?.roundNumber === roundNumber ? used[ownerId]! : { roundNumber, names: [] }
      if (record.names.includes(cardName) || roundNumber !== host.state.roundNumber) return
      const cardId = createVirtualTrick(host.state, ownerId, cardName, RENWAN_RENSHUANG)
      const actions = renshuangActions(host, ownerId, cardId, cardName)
      if (!actions.length) {
        const owner = player(host.state, ownerId)
        if (owner) owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId)
        delete host.state.cards[cardId]
        return
      }
      record.names = [...record.names, cardName]
      used[ownerId] = record
      host.queueSkill({ skillId: RENWAN_RENSHUANG, ownerId, step: 'choose-action', data: { cardId, cardName, actionIds: actions.map((action) => action.id) } })
      return
    }
    if (resolution.step !== 'choose-action') return
    const index = Number((response.payload as { optionId?: string }).optionId)
    const { cardId, cardName, actionIds } = resolution.data as { cardId: CardId; cardName: string; actionIds: string[] }
    const action = renshuangActions(host, ownerId, cardId, cardName)[index]
    if (!action || action.id !== actionIds[index]) return
    executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
  },
})

registerSkillRuntime({
  id: XING_TAISHICI_ZHONGWEI,
  onGameStart(host, ownerId) { chongzuState(host.state, ownerId) },
  distanceModifier: { toOthers: (state, ownerId) => chongzuState(state, ownerId).distance },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || Number((context.event.payload as { finalAmount?: number }).finalAmount) <= 0) return
    const state = chongzuState(host.state, ownerId)
    if (state.distance <= 0) return
    state.distance -= 1
    if (state.distance !== 0) return
    state.upgraded = true
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    recover(host as never, ownerId, 1, XING_TAISHICI_ZHONGWEI)
    const afterRecover = player(host.state, ownerId)
    if (afterRecover?.alive && afterRecover.hp > 0)
      drawCards(host.state, host.rng, ownerId, afterRecover.hp, (name, payload) => host.dispatch(name, payload))
    suppressSkill(host.state, { targetId: ownerId, skillId: XING_TAISHICI_ZHONGWEI, sourceId: ownerId,
      sourceSkillId: XING_TAISHICI_ZHONGWEI, expiresAt: 'never', armedAtTurn: host.state.turnNumber })
  } }],
})

registerSkillRuntime({
  id: XING_TAISHICI_CHONGZU,
  unlimitedCardUses: (state, ownerId) => chongzuState(state, ownerId).nextUnlimited,
  slashIgnoresDistance(state, ownerId) { return chongzuState(state, ownerId).nextUnlimited },
  ignoresTrickDistance(state, ownerId) { return chongzuState(state, ownerId).nextUnlimited },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId === ownerId && chongzuState(host.state, ownerId).nextUnlimited)
        chongzuState(host.state, ownerId).nextUnlimited = false
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      if (!payload.cardId) return
      const state = chongzuState(host.state, ownerId)
      const targetIds = payload.targetIds ?? cardUseTargetsOf(host.state, payload.cardId)?.targetIds ?? []
      if (!targetIds.includes(ownerId)) return
      const options = [
        { id: 'unlimited', label: '令你使用的下一张牌无次数和距离限制' },
        ...(!usedThisTurn(host.state, ownerId, `${XING_TAISHICI_CHONGZU}:draw`) ? [{ id: 'draw', label: '摸两张牌（本回合此项限一次）' }] : []),
        ...(state.upgraded ? [{ id: 'damage', label: '令你使用的下一张指定其他角色为目标后，对其中一名目标造成1点伤害' }] : []),
      ]
      host.askSkill({ skillId: XING_TAISHICI_CHONGZU, ownerId, step: 'choose-option', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【冲阻】：选择一项', timeoutMs: 25_000, optional: true,
        options: [{ id: 'decline', label: '不发动' }, ...options],
      }) })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const state = chongzuState(host.state, ownerId)
      if (!state.pendingResume) return
      if (context.event.sourceId !== state.pendingResume.sourceId || context.event.targetId !== state.pendingResume.targetId
        || context.event.sourceSkillId !== XING_TAISHICI_CHONGZU) return
      delete state.pendingResume
      host.resumeCardTarget()
    } },
  ],
  interceptSourceTarget(host, ownerId, context) {
    const state = chongzuState(host.state, ownerId)
    if (!state.nextDamage || context.sourceId !== ownerId) return false
    const targetIds = cardUseTargetsOf(host.state, context.cardId)?.targetIds ?? []
    const candidateIds = targetIds.filter((id) => id !== ownerId && player(host.state, id)?.alive)
    if (!candidateIds.length) return false
    state.nextDamage = false
    host.askSkill({ skillId: XING_TAISHICI_CHONGZU, ownerId, step: 'damage-target', data: { cardId: context.cardId, candidateIds }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【冲阻】：选择此牌的一名其他目标，令其受到1点伤害',
      timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage-target') return
    const candidateIds = (prompt.data as { candidateIds?: PlayerId[] }).candidateIds ?? []
    host.askSkill({ skillId: XING_TAISHICI_CHONGZU, ownerId, step: 'damage-target', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【冲阻】：选择此牌的一名其他目标，令其受到1点伤害',
      timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'choose-option') {
      const option = (response.payload as { optionId?: string }).optionId
      const state = chongzuState(host.state, ownerId)
      if (option === 'unlimited') state.nextUnlimited = true
      else if (option === 'draw' && !usedThisTurn(host.state, ownerId, `${XING_TAISHICI_CHONGZU}:draw`)) {
        markUsedThisTurn(host.state, ownerId, `${XING_TAISHICI_CHONGZU}:draw`)
        drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      } else if (option === 'damage' && state.upgraded) state.nextDamage = true
      return
    }
    if (resolution.step !== 'damage-target') return
    const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const candidateIds = new Set((resolution.data.candidateIds as PlayerId[] | undefined) ?? [])
    if (!selected) { host.resumeCardTarget(); return }
    if (!candidateIds.has(selected) || !player(host.state, selected)?.alive) { host.resumeCardTarget(); return }
    const state = chongzuState(host.state, ownerId)
    state.pendingResume = { sourceId: ownerId, targetId: selected }
    resolveDamage(host as never, { sourceId: ownerId, targetId: selected, amount: 1, nature: 'normal', cardId: null,
      cardName: '冲阻', reason: XING_TAISHICI_CHONGZU })
    if (!host.state.dying && !host.state.pendingRequests.length && state.pendingResume) {
      delete state.pendingResume
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: WUFU_ZHONGE,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const flow = b83(host.state).wufuFlow as WufuFlow | undefined
    const attackerId = flow?.pendingSlash
    if (!flow || !attackerId || context.event.sourceSkillId !== WUFU_ZHONGE || context.event.sourceId !== attackerId) return
    delete flow.pendingSlash
    advanceWufuFlow(flow)
    host.queueSkill({ skillId: WUFU_ZHONGE, ownerId, step: 'resolve', data: flow })
  } }],
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    const hasTarget = state.players.some((entry) => entry.alive && entry.id !== ownerId)
    return state.currentPlayerId === ownerId && state.phase === 'play' && owner?.alive && hasTarget
      && !usedThisPhase(state, ownerId, WUFU_ZHONGE)
      ? [{ id: `${WUFU_ZHONGE}:activate`, label: '忠锷：调整手牌并与一名角色同时选择行动' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    if (actionId !== `${WUFU_ZHONGE}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, WUFU_ZHONGE)
      || !host.state.players.some((entry) => entry.alive && entry.id !== ownerId)) return
    markUsedThisPhase(host.state, ownerId, WUFU_ZHONGE)
    const difference = owner.maxHp - owner.zones.hand.length
    if (difference < 0) {
      const cardIds = [...owner.zones.hand]
      host.askSkill({ skillId: WUFU_ZHONGE, ownerId, step: 'adjust-hand', data: { discardCount: -difference }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【忠锷】：弃置${-difference}张手牌，将手牌数调整至体力上限`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: -difference, max: -difference,
      }) })
      return
    }
    if (difference > 0) drawCards(host.state, host.rng, ownerId, difference, (name, payload) => host.dispatch(name, payload))
    askWufuTarget(host, ownerId)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'resolve') return
    const flow = prompt.data as WufuFlow
    if (flow.pendingSlash) return
    while (flow.operationIndex < flow.operations.length) {
      const operation = flow.operations[flow.operationIndex]!
      if (operation === 'draw') {
        const actorId = flow.actorIndex === 0 ? ownerId : flow.targetId
        const repeat = flow.actorIndex === 0 ? flow.ownerRepeatCount : 1
        if (player(host.state, actorId)?.alive)
          for (let index = 0; index < repeat; index += 1) drawCards(host.state, host.rng, actorId, 1,
            (name, payload) => host.dispatch(name, payload))
        advanceWufuFlow(flow)
      } else {
        const attackerId = flow.actorIndex === 0 ? ownerId : flow.targetId
        const targetId = flow.actorIndex === 0 ? flow.targetId : ownerId
        if (!player(host.state, attackerId)?.alive || !player(host.state, targetId)?.alive) {
          advanceWufuFlow(flow)
        } else {
          flow.pendingSlash = attackerId
          const started = host.beginVirtualSlash({ sourceId: attackerId, targetId, sourceSkillId: WUFU_ZHONGE })
          if (started) { b83(host.state).wufuFlow = flow; return }
          delete flow.pendingSlash
          advanceWufuFlow(flow)
        }
      }
    }
    delete b83(host.state).wufuFlow
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'adjust-hand') {
      const owner = player(host.state, ownerId)
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const discardCount = Number(resolution.data.discardCount)
      const hand = new Set(owner?.zones.hand ?? [])
      if (!owner?.alive || chosen.length !== discardCount || chosen.some((cardId) => !hand.has(cardId))) return
      discardCardsByIds(host as never, ownerId, chosen, WUFU_ZHONGE)
      askWufuTarget(host, ownerId)
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || targetId === ownerId || !player(host.state, targetId)?.alive) return
      startGroupDecision(host, { id: `${WUFU_ZHONGE}:${host.state.seq}`, tag: WUFU_ZHONGE_GROUP, skillId: WUFU_ZHONGE,
        playerIds: [ownerId, targetId], prompt: '【忠锷】：同时秘密选择一项',
        options: [{ id: 'draw', label: '你与其依次摸一张牌' }, { id: 'slash', label: '依次视为对对方使用【杀】' }],
        defaultOptionId: 'draw', timeoutMs: 25_000, data: { ownerId, targetId },
      })
    }
  },
})

function askWufuTarget(host: SkillHost, ownerId: PlayerId): void {
  const candidateIds = host.state.players.filter((entry) => entry.alive && entry.id !== ownerId).map((entry) => entry.id)
  if (!candidateIds.length || !player(host.state, ownerId)?.alive) return
  host.askSkill({ skillId: WUFU_ZHONGE, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【忠锷】：选择一名其他角色', timeoutMs: 25_000,
    optional: false, candidateIds, min: 1, max: 1,
  }) })
}

registerSkillRuntime({
  id: WUFU_JUEKAI,
  limited: true,
  globallyProhibitsCardUse(state, ownerId, targetId, cardId) {
    const phase = juekaiPhases(state)[ownerId]
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !phase?.active || !phase.gainedPlayerIds.includes(targetId)) return false
    return Boolean(state.players.find((entry) => entry.id === targetId)?.zones.hand.includes(cardId))
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play') return
      juekaiPhases(host.state)[ownerId] = { gainedPlayerIds: [], active: false }
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const phases = juekaiPhases(host.state)
      const phase = phases[ownerId]
      if (!phase || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      const payload = context.event.payload as { playerId?: PlayerId }
      const recipientId = payload.playerId ?? context.event.targetId
      if (recipientId && !phase.gainedPlayerIds.includes(recipientId)) phase.gainedPlayerIds.push(recipientId)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') delete juekaiPhases(host.state)[ownerId]
    } },
  ],
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    return state.currentPlayerId === ownerId && state.phase === 'play' && owner?.alive
      && usedThisPhase(state, ownerId, WUFU_ZHONGE) && !(owner.marks['绝忾'] ?? 0)
      ? [{ id: `${WUFU_JUEKAI}:activate`, label: '绝忾：重置忠锷并禁止本阶段获得过牌的角色使用手牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = player(host.state, ownerId)
    const phase = juekaiPhases(host.state)[ownerId]
    if (actionId !== `${WUFU_JUEKAI}:activate` || !owner?.alive || !phase || phase.active
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || !usedThisPhase(host.state, ownerId, WUFU_ZHONGE) || (owner.marks['绝忾'] ?? 0)) return
    owner.marks['绝忾'] = 1
    clearUsedThisPhase(host.state, ownerId, WUFU_ZHONGE)
    phase.active = true
  },
})

function finishShuguo(host: SkillHost, ownerId: PlayerId, flow: ShuguoFlow): void {
  delete b83(host.state).shuguoFlow
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  const maximum = Math.max(...host.state.players.filter((entry) => entry.alive).map((entry) => entry.zones.hand.length))
  const uniqueMaximum = host.state.players.filter((entry) => entry.alive && entry.zones.hand.length === maximum).length === 1
    && owner.zones.hand.length === maximum
  const unused = Math.min(5, Math.max(0, flow.records.length - new Set(flow.usedCardIds).size))
  if (!uniqueMaximum && unused > 0) drawCards(host.state, host.rng, ownerId, unused, (name, payload) => host.dispatch(name, payload))
}
