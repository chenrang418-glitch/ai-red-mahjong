import type { CharacterDefinition } from './types'
import type { CardCategory, CardId, EquipmentSlot, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { effectiveCardSuit, effectiveCardColor, isTargetProhibited, isCardUseProhibited, registerSkillRuntime, replaceTemporarySkill, isCardProtectedFromDiscard, skillsOf, type SkillHost, type TargetedCardContext } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseSuitRequest, ChooseTargetsRequest } from '../../engine/requests'
import { abolishableSlotsOf, abolishSlot, restoreSlot } from '../../engine/equipment-slots'
import { moveCard } from '../../engine/zones'
import { discardCardsByIds } from '../../engine/discard-all'
import { drawCards } from '../../engine/draw'
import { revealTopCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { effectiveKingdomOf } from '../../engine/huashen'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { hiddenHandSlot } from '../../engine/cards/host'
import { discardAllCards } from '../../engine/discard-all'
import { queueExtraTurn } from '../../engine/turn'
import { shuffleDrawAndDiscardPiles } from '../../engine/deck'
import { swapHands } from '../../engine/hand-transfer'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { giveCards } from '../../engine/hand-transfer'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { effectiveCardName, setCardAlias } from '../../engine/zones'
import { slashUseOptions } from '../../engine/ask-use-slash'
import { resolveDamage } from '../../engine/damage'
import { skillIdsOf } from './standard'

const b57 = (id: string) => `${id}:b57`
const XY_JIEJIE = b57('jiejie-shi-xinxianying')
const XY_QINGSHI = b57('qingshi-shi-xinxianying')
const MQ_CUIZHEN = b57('cuizhen-xuan-maoqiujian')
const MQ_KUILI = b57('kuili-xuan-maoqiujian')
const CF_CAIQIU = b57('caiqiu-cui-fu')
const CF_XISHANG = b57('xishang-cui-fu')
const SL_QUANCHONG = b57('quanchong-shi-chenzhi')
const SL_RENXING = b57('renxing-shi-chenzhi')
const SLU_DIMENG = b57('dimeng-shi-lusu')
const SLU_HAOSHI = b57('haoshi-shi-lusu')
const YJ_ZHENJUN = b57('zhenjun-sp-yujin')
const HJ_GONGMOU = b57('gongmou-shi-huanjie')
const HJ_ZHENGSHUO = b57('zhengshuo-shi-huanjie')
const WC_KAIJI = b57('kaiji-shi-wangchang')
const WC_SHEPAN = b57('shepan-shi-wangchang')
const ZH_SIZI = b57('sizi-shi-zhonghui')
const ZH_XIEZHI = b57('xiezhi-shi-zhonghui')
const ZH_YUNAN = b57('yunan-shi-zhonghui')
const ZH_KECHANG = b57('kechang-shi-zhonghui')
const DA_TUNTIAN = b57('tuntian-shi-dengai')
const DA_ZAOXIAN = b57('zaoxian-shi-dengai')
const DA_JIXI = b57('jixi-shi-dengai')

type B57State = SanguoshaState & {
  b57Xinying?: { phaseTurnByPlayer: Record<PlayerId, number>; roundCounts: Record<PlayerId, { roundNumber: number; count: number }>; suitCounts: Record<PlayerId, { roundNumber: number; count: number }>; unlimitedSuit?: Record<PlayerId, Array<{ sourceOwnerId: PlayerId; turnNumber: number; suit: Suit }>> }
  b57MaoWeaponRestore?: Record<PlayerId, EquipmentSlot>
  b57CuiFu?: {
    shape: Record<PlayerId, 1 | 2 | 3>
    recordedNames: Record<PlayerId, { roundNumber: number; names: string[] }>
    roundSelection?: Record<PlayerId, { roundNumber: number; cardIds: CardId[] }>
    shape2Uses?: Record<PlayerId, { turnNumber: number; trick: boolean; equipment: boolean; basic: boolean; basicCardId?: CardId; basicCardName?: string }>
    shape2PendingFaceUp?: Record<PlayerId, { turnNumber: number; cardId: CardId; categoryCount: number }>
    shape2PreparedBasicUse?: Record<PlayerId, { turnNumber: number; cardId: CardId; cardName: string; eligible: boolean }>
    shape3Uses?: Record<PlayerId, { turnNumber: number; used: string[] }>
    shape1Uses?: Record<PlayerId, number>
    faceUpProgress?: Record<PlayerId, number>
    statChange?: Record<PlayerId, { draw: number; slash: number; hand: number }>
  }
  b57ChenZhi?: {
    quanChongRoundUses: Record<PlayerId, { roundNumber: number; count: number }>
    renXingRoundUses: Record<PlayerId, { roundNumber: number; count: number }>
    renXingTurnPrompted: Record<PlayerId, number>
    slashUsersByTurn: Record<number, PlayerId[]>
  }
  b57HuanJie?: Record<PlayerId, { targetId: PlayerId; turnNumber: number }>
  b57WangChang?: Record<PlayerId, { turnNumber: number; roundNumber: number; names: string[] }>
  b57WangChangDyingPlayers?: PlayerId[]
  b57ShiLuSuDimengUsedTurn?: Record<PlayerId, number>
  b57ShiLuSuHaoshi?: Record<PlayerId, { borrowerId: PlayerId }>
  b57ShiLuSuHaoshiRefills?: Record<PlayerId, number>
  b57YuJinZhenjun?: Record<PlayerId, { pendingSlashes: Record<CardId, { userId: PlayerId; damage: number }> }>
  b57ZhongHui?: {
    active?: Record<PlayerId, { remainingTurns: number; noSlashPenalty: boolean }>
    activatedTurn?: Record<PlayerId, number>
    slashUsersByTurn?: Record<number, PlayerId[]>
    deathRoundByPlayer?: Record<PlayerId, number>
    kechangLevel?: Record<PlayerId, 1 | 2>
    awakened?: PlayerId[]
  }
  b57DengAi?: {
    activatedTurn?: Record<PlayerId, number>
    targetsByTurn?: Record<PlayerId, { turnNumber: number; targetIds: PlayerId[] }>
  }
}

const SUTS: Suit[] = ['spade', 'heart', 'club', 'diamond']
const SUIT_LABEL: Record<Suit, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }

function xinyingChooseSuit(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, shownIds: CardId[]): void {
  const state = host.state as B57State
  const usage = state.b57Xinying ??= { phaseTurnByPlayer: {}, roundCounts: {}, suitCounts: {} }
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
  usage.phaseTurnByPlayer[targetId] = host.state.turnNumber
  const roundCount = usage.roundCounts[ownerId]?.roundNumber === host.state.roundNumber
    ? usage.roundCounts[ownerId].count : 0
  usage.roundCounts[ownerId] = { roundNumber: host.state.roundNumber, count: roundCount + 1 }
  const uniqueSuits = new Set(shownIds.map((cardId) => effectiveCardSuit(host.state, targetId, cardId)))
  usage.suitCounts[targetId] = { roundNumber: host.state.roundNumber, count: uniqueSuits.size }
  host.askSkill({ skillId: XY_JIEJIE, ownerId, step: 'choose-suit', data: { targetId, shownIds }, build: (id): ChooseSuitRequest => ({
    id, kind: 'choose-suit', playerId: ownerId, prompt: `【诫节】：选择一种花色（${target.nickname}的手牌已展示）`,
    timeoutMs: 25_000, optional: false, suits: SUTS, viewOnlyCardIds: [...shownIds],
  }) })
}

function askQingShiTarget(host: SkillHost, ownerId: PlayerId, candidates: PlayerId[], prompt: string): void {
  if (!candidates.length) return
  host.askSkill({ skillId: XY_QINGSHI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt, timeoutMs: 25_000, optional: true,
    candidateIds: candidates, min: 0, max: 1,
  }) })
}

function qingShiWinner(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): boolean {
  const usage = (host.state as B57State).b57Xinying
  const targetScore = usage?.suitCounts[targetId]
  if (!targetScore || targetScore.roundNumber !== host.state.roundNumber) return false
  const activeScores = Object.entries(usage.suitCounts).filter(([playerId, entry]) => entry.roundNumber === host.state.roundNumber
    && host.state.players.some((player) => player.alive && player.id === playerId))
  const maximum = Math.max(...activeScores.map(([, entry]) => entry.count), 0)
  return targetScore.count === maximum && activeScores.filter(([, entry]) => entry.count === maximum).length === 1
    && host.state.players.some((player) => player.id === ownerId && player.alive)
}

function finishXinying(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  if (!qingShiWinner(host, ownerId, targetId)) return
  askQingShiTarget(host, ownerId, [targetId], `【诫节】：${host.state.players.find((player) => player.id === targetId)?.nickname ?? '该角色'}本轮展示的花色数唯一最多，是否视为对其发动【清识】？`)
}

function xinyingSameCamp(state: SanguoshaState, leftId: PlayerId, rightId: PlayerId): boolean {
  const left = state.players.find((player) => player.id === leftId)
  const right = state.players.find((player) => player.id === rightId)
  if (!left || !right) return false
  const camp = (identity: typeof left.identity) => identity === 'lord' || identity === 'loyalist'
    ? 'lord' : identity
  return camp(left.identity) === camp(right.identity)
}

function grantXinyingSuitUse(host: SkillHost, sourceOwnerId: PlayerId, targetId: PlayerId, suit: Suit): void {
  const state = host.state as B57State
  const grantsByTarget = (state.b57Xinying ??= { phaseTurnByPlayer: {}, roundCounts: {}, suitCounts: {} }).unlimitedSuit ??= {}
  const grants = grantsByTarget[targetId] ??= []
  const current = grants.find((grant) => grant.sourceOwnerId === sourceOwnerId && grant.turnNumber === host.state.turnNumber)
  if (current) current.suit = suit
  else grants.push({ sourceOwnerId, turnNumber: host.state.turnNumber, suit })
  replaceTemporarySkill(host.state, targetId, `b57-xinying:${sourceOwnerId}`, XY_JIEJIE)
}

function gainXinyingSuit(host: SkillHost, targetId: PlayerId, cardId: CardId, from: 'drawPile' | 'discardPile'): void {
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  const suit = effectiveCardSuit(host.state, targetId, cardId)
  const pile = from === 'drawPile' ? host.state.zones.drawPile : host.state.zones.discardPile
  if (!target || !suit || !pile.includes(cardId)) return
  moveCard(host.state, cardId, { kind: from }, { kind: 'hand', playerId: targetId })
  host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: '诫节' }, { targetId, cardIds: [cardId] })
}

function qingShiPickable(host: SkillHost, ownerId: PlayerId, actorId: PlayerId) {
  const actor = host.state.players.find((player) => player.id === actorId && player.alive)
  if (!actor) return { cardIds: [] as CardId[], hiddenCardSlots: [] as string[] }
  if (actorId === ownerId) {
    const cardIds = [...actor.zones.hand, ...Object.values(actor.zones.equipment).filter((id): id is CardId => Boolean(id))]
      .filter((cardId) => !isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId))
    return { cardIds, hiddenCardSlots: [] as string[] }
  }
  const pickable = pickableCardsOf(host.state, actorId, { discarderId: ownerId })
  pickable.hiddenCardSlots = actor.zones.hand.flatMap((cardId, index) =>
    isCardProtectedFromDiscard(host.state, actorId, cardId, ownerId) ? [] : [hiddenHandSlot(actorId, index)])
  return pickable
}

function askQingShiCard(host: SkillHost, ownerId: PlayerId, data: { targetId: PlayerId; actorId: PlayerId; nextActorId: PlayerId | null }): void {
  const actor = host.state.players.find((player) => player.id === data.actorId && player.alive)
  const pickable = qingShiPickable(host, ownerId, data.actorId)
  if (!actor || (!pickable.cardIds.length && !pickable.hiddenCardSlots.length)) return
  host.askSkill({ skillId: XY_QINGSHI, ownerId, step: 'discard-card', data, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【清识】：选择${actor.nickname}区域里的一张牌弃置`, timeoutMs: 25_000,
    optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
  }) })
}

function cuiFaceUpCategories(state: SanguoshaState, ownerId: PlayerId): Set<string> {
  const owner = state.players.find((player) => player.id === ownerId)
  const handIds = new Set(owner?.zones.hand ?? [])
  const marked = (state.faceUpHandCards?.[ownerId] ?? []).filter((cardId) => handIds.has(cardId))
  const equipmentIds = Object.values(owner?.zones.equipment ?? {}).filter((cardId): cardId is CardId => Boolean(cardId))
  return new Set([...marked, ...equipmentIds].map((cardId) => state.cards[cardId]?.category)
    .filter((category): category is CardCategory => Boolean(category)))
}

function cuiFaceUpSuits(state: SanguoshaState, ownerId: PlayerId): Set<Suit> {
  const owner = state.players.find((player) => player.id === ownerId)
  const handIds = new Set(owner?.zones.hand ?? [])
  const marked = (state.faceUpHandCards?.[ownerId] ?? []).filter((cardId) => handIds.has(cardId))
  const equipmentIds = Object.values(owner?.zones.equipment ?? {}).filter((cardId): cardId is CardId => Boolean(cardId))
  return new Set([...marked, ...equipmentIds]
    .map((cardId) => effectiveCardSuit(state, ownerId, cardId))
    .filter((suit): suit is Suit => Boolean(suit)))
}

function cuiHasFaceUpCards(state: SanguoshaState, ownerId: PlayerId): boolean {
  return cuiFaceUpCategories(state, ownerId).size > 0
}

function cuiShape3Uses(host: SkillHost, ownerId: PlayerId): { turnNumber: number; used: string[] } {
  const state = host.state as B57State
  const cui = state.b57CuiFu ??= { shape: {}, recordedNames: {} }
  cui.shape3Uses ??= {}
  const current = cui.shape3Uses[ownerId]
  if (current?.turnNumber === host.state.turnNumber) return current
  const next = { turnNumber: host.state.turnNumber, used: [] as string[] }
  cui.shape3Uses[ownerId] = next
  return next
}

function finishCuiShape3Use(host: SkillHost, ownerId: PlayerId, cardId: CardId, cardName?: string): void {
  const key = cardName === '杀' ? 'weapon' : cardName === '闪' ? 'armor'
    : cardName === '桃' ? 'defensiveHorse' : cardName === '酒' ? 'offensiveHorse' : null
  if (!key || !host.state.cards[cardId]) return
  const usage = cuiShape3Uses(host, ownerId)
  if (usage.used.includes(key)) return
  usage.used.push(key)
  const suit = effectiveCardSuit(host.state, ownerId, cardId)
  if (suit) host.queueSkill({ skillId: CF_XISHANG, ownerId, step: 'shape3-gain', data: { suit } })
}

function queueHaoShiRefill(host: SkillHost, ownerId: PlayerId, userId: PlayerId, cardOwnerId: PlayerId | undefined): void {
  if (cardOwnerId !== ownerId || !userId) return
  const state = host.state as B57State
  if (state.b57ShiLuSuHaoshi?.[ownerId]?.borrowerId !== userId) return
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-lusu-b57')
  if (!owner || owner.zones.hand.length > 0) return
  const used = state.b57ShiLuSuHaoshiRefills?.[ownerId] ?? 0
  if (used >= 2) return
  ;(state.b57ShiLuSuHaoshiRefills ??= {})[ownerId] = used + 1
  host.queueSkill({ skillId: SLU_HAOSHI, ownerId, step: 'refill-to-three', data: {} })
}

function isCuiShape3Material(state: SanguoshaState, cardId: CardId, cardName?: string): boolean {
  const slot = cardName === '杀' ? 'weapon' : cardName === '闪' ? 'armor'
    : cardName === '桃' ? 'defensiveHorse' : cardName === '酒' ? 'offensiveHorse' : null
  return Boolean(slot && state.cards[cardId]?.category === 'equipment' && state.cards[cardId]?.equipmentSlot === slot)
}

function cuiShape2Usage(host: SkillHost, ownerId: PlayerId): { turnNumber: number; trick: boolean; equipment: boolean; basic: boolean; basicCardId?: CardId; basicCardName?: string } {
  const state = host.state as B57State
  const cui = state.b57CuiFu ??= { shape: {}, recordedNames: {} }
  cui.shape2Uses ??= {}
  const current = cui.shape2Uses[ownerId]
  if (current?.turnNumber === host.state.turnNumber) return current
  const next = { turnNumber: host.state.turnNumber, trick: false, equipment: false, basic: false }
  cui.shape2Uses[ownerId] = next
  return next
}

function isBasicCardName(cardName: string | undefined): cardName is '杀' | '闪' | '桃' | '酒' {
  return cardName === '杀' || cardName === '闪' || cardName === '桃' || cardName === '酒'
}

function askCuiTrickGain(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = host.state.players.find((player) => player.id === targetId && player.alive)
  if (!target) return
  const pickable = pickableCardsOf(host.state, targetId)
  if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
  host.askSkill({ skillId: CF_XISHANG, ownerId, step: 'shape2-trick-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【褽装】：获得${target.nickname}区域里的一张牌`, timeoutMs: 25_000,
    optional: true, purpose: 'skill', ...pickable, min: 0, max: 1,
  }) })
}

type CuiShape1Stat = 'draw' | 'slash' | 'hand' | 'hp'

function askCuiCaiqiu(host: SkillHost, ownerId: PlayerId, roundNumber: number): void {
  const cardIds = revealTopCards(host.state, host.rng, host.state.players.length, CF_CAIQIU, (name, data) => host.dispatch(name, data))
  if (!cardIds.length) return
  const state = host.state as B57State
  const cui = state.b57CuiFu ??= { shape: {}, recordedNames: {} }
  cui.roundSelection ??= {}
  cui.roundSelection[ownerId] = { roundNumber, cardIds: [...cardIds] }
  host.askSkill({ skillId: CF_CAIQIU, ownerId, step: 'take-top', data: { roundNumber, cardIds }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: '【裁裘】：获得其中任意张牌（未获得的牌置入弃牌堆）',
    timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: [...cardIds], hiddenCardSlots: [], min: 0, max: cardIds.length,
  }) })
}

function askCuiShape1Stat(host: SkillHost, ownerId: PlayerId, step: 'shape1-decrease' | 'shape1-increase', index?: number): void {
  host.askSkill({ skillId: CF_XISHANG, ownerId, step, data: index === undefined ? {} : { index }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: step === 'shape1-decrease' ? '【褽装·桂殿】：选择令一项数值-1并发动【裁裘】' : '【褽装·桂殿】：选择令一项数值+1',
    timeoutMs: 25_000, optional: true, options: [
      { id: 'draw', label: '摸牌阶段摸牌数' },
      { id: 'slash', label: '使用【杀】次数' },
      { id: 'hand', label: '手牌上限' },
      { id: 'hp', label: '体力值' },
    ],
  }) })
}

function applyCuiShape1Stat(host: SkillHost, ownerId: PlayerId, stat: CuiShape1Stat, direction: -1 | 1): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!owner) return
  if (stat === 'hp') {
    if (direction < 0) loseHp(host as never, ownerId, 1, CF_XISHANG)
    else recover(host as never, ownerId, 1, ownerId)
    return
  }
  const state = host.state as B57State
  const changes = ((state.b57CuiFu ??= { shape: {}, recordedNames: {} }).statChange ??= {})[ownerId]
    ??= { draw: 0, slash: 0, hand: 0 }
  changes[stat] += direction
}

function zhonghuiCharge(owner: { marks: Record<string, number> }): number {
  return Math.max(0, Math.trunc(owner.marks['肆恣蓄力'] ?? 0))
}

function changeZhonghuiCharge(host: SkillHost, ownerId: PlayerId, amount: number): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  if (!owner || amount <= 0) return
  const current = zhonghuiCharge(owner)
  const total = current + Math.trunc(amount)
  owner.marks['肆恣蓄力'] = Math.min(4, total)
  const overflow = Math.max(0, total - 4)
  if (overflow) {
    owner.marks['肆恣手牌上限'] = (owner.marks['肆恣手牌上限'] ?? 0) + overflow
    owner.marks['肆恣杀次数'] = (owner.marks['肆恣杀次数'] ?? 0) + overflow
  }
}

function zhonghuiActive(state: SanguoshaState, ownerId: PlayerId): { remainingTurns: number; noSlashPenalty: boolean } | null {
  const active = (state as B57State).b57ZhongHui?.active?.[ownerId]
  return active && active.remainingTurns > 0 ? active : null
}

registerSkillRuntime({ id: XY_JIEJIE,
  unlimitedWineFor(state, ownerId, cardId) {
    const records = (state as B57State).b57Xinying?.unlimitedSuit?.[ownerId] ?? []
    const suit = cardId ? effectiveCardSuit(state, ownerId, cardId) : undefined
    return records.some((record) => record.turnNumber === state.turnNumber && record.suit === suit)
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    const records = (state as B57State).b57Xinying?.unlimitedSuit?.[ownerId] ?? []
    const suit = cardId ? effectiveCardSuit(state, ownerId, cardId) : undefined
    return records.some((record) => record.turnNumber === state.turnNumber && record.suit === suit)
  },
  triggers: [{ event: 'PlayPhase', handle(host, ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    const state = host.state as B57State
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-xinxianying-b57')
    const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
    const usage = state.b57Xinying ??= { phaseTurnByPlayer: {}, roundCounts: {}, suitCounts: {} }
    if (!owner || !target || !targetId || usage.phaseTurnByPlayer[targetId] === host.state.turnNumber
      || (usage.roundCounts[ownerId]?.roundNumber === host.state.roundNumber && usage.roundCounts[ownerId].count >= 2)) return
    host.askSkill({ skillId: XY_JIEJIE, ownerId, step: 'consent', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: targetId, prompt: `【诫节】：是否令辛宪英观看${target.id === ownerId ? '你的' : `${target.nickname}的`}手牌并选择一种花色？`,
      timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '展示手牌并执行诫节' }, { id: 'no', label: '不发动' }],
    }) })
  } }, { event: 'TurnEnd', handle(host, ownerId, context) {
    const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
    if (targetId !== ownerId) return
    const state = host.state as B57State
    const grants = state.b57Xinying?.unlimitedSuit?.[ownerId]
    if (!grants?.length) return
    for (const grant of grants) replaceTemporarySkill(host.state, ownerId, `b57-xinying:${grant.sourceOwnerId}`, null)
    delete state.b57Xinying!.unlimitedSuit![ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId: PlayerId; shownIds?: CardId[] }
    if (resolution.step === 'consent') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const target = host.state.players.find((player) => player.id === data.targetId && player.alive)
      if (!target) return
      xinyingChooseSuit(host, ownerId, target.id, [...target.zones.hand])
      return
    }
    if (resolution.step === 'gain-source') {
      const { targetId, chosenSuit } = resolution.data as { targetId: PlayerId; chosenSuit: Suit }
      if ((response.payload as { optionId?: string }).optionId === 'draw') {
        const candidates = host.state.zones.drawPile.filter((cardId) => effectiveCardSuit(host.state, targetId, cardId) === chosenSuit)
        if (candidates.length) gainXinyingSuit(host, targetId, host.rng.pick(candidates), 'drawPile')
        finishXinying(host, ownerId, targetId)
      } else if ((response.payload as { optionId?: string }).optionId === 'discard') {
        const candidateIds = host.state.zones.discardPile.filter((cardId) => effectiveCardSuit(host.state, targetId, cardId) === chosenSuit)
        if (!candidateIds.length) { finishXinying(host, ownerId, targetId); return }
        host.askSkill({ skillId: XY_JIEJIE, ownerId, step: 'gain-discard', data: { targetId, chosenSuit }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: targetId, prompt: `【诫节】：选择一张${SUIT_LABEL[chosenSuit]}牌获得`, timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: candidateIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'gain-discard') {
      const { targetId, chosenSuit } = resolution.data as { targetId: PlayerId; chosenSuit: Suit }
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && host.state.zones.discardPile.includes(cardId) && effectiveCardSuit(host.state, targetId, cardId) === chosenSuit)
        gainXinyingSuit(host, targetId, cardId, 'discardPile')
      finishXinying(host, ownerId, targetId)
      return
    }
    if (resolution.step !== 'choose-suit') return
    const chosenSuit = (response.payload as { suit?: Suit }).suit
    const target = host.state.players.find((player) => player.id === data.targetId && player.alive)
    if (!target || !chosenSuit || !SUTS.includes(chosenSuit)) return
    const currentHand = [...target.zones.hand]
    const chosenHasSuit = currentHand.some((cardId) => effectiveCardSuit(host.state, target.id, cardId) === chosenSuit)
    if (chosenHasSuit) {
      const toDiscard = currentHand.filter((cardId) => effectiveCardSuit(host.state, target.id, cardId) !== chosenSuit
        && !isCardProtectedFromDiscard(host.state, target.id, cardId, target.id))
      if (toDiscard.length) discardCardsByIds(host as never, target.id, toDiscard, XY_JIEJIE)
      grantXinyingSuitUse(host, ownerId, target.id, chosenSuit)
    } else {
      const drawPileCandidates = host.state.zones.drawPile.filter((cardId) => effectiveCardSuit(host.state, target.id, cardId) === chosenSuit)
      const discardCandidates = host.state.zones.discardPile.filter((cardId) => effectiveCardSuit(host.state, target.id, cardId) === chosenSuit)
      const options = [
        ...(drawPileCandidates.length ? [{ id: 'draw', label: `从牌堆随机获得一张${SUIT_LABEL[chosenSuit]}牌` }] : []),
        ...(discardCandidates.length ? [{ id: 'discard', label: `从弃牌堆选择一张${SUIT_LABEL[chosenSuit]}牌` }] : []),
      ]
      if (options.length) {
        host.askSkill({ skillId: XY_JIEJIE, ownerId, step: 'gain-source', data: { targetId: target.id, chosenSuit }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: target.id, prompt: `【诫节】：从牌堆或弃牌堆获得一张${SUIT_LABEL[chosenSuit]}牌`,
        timeoutMs: 25_000, optional: false, options,
        }) })
        return
      }
    }
    finishXinying(host, ownerId, target.id)
  },
})

registerSkillRuntime({ id: XY_QINGSHI,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
    const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
    askQingShiTarget(host, ownerId, candidates, '【清识】：选择一名角色（与其势力相同则各摸一张，不同则弃置双方各一张牌）')
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const target = targetId && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!owner || !target) return
      if (xinyingSameCamp(host.state, ownerId, target.id)) {
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
        drawCards(host.state, host.rng, target.id, 1, (name, data) => host.dispatch(name, data))
        return
      }
      const ownCards = qingShiPickable(host, ownerId, ownerId)
      const targetCards = qingShiPickable(host, ownerId, target.id)
      if (!ownCards.cardIds.length && !ownCards.hiddenCardSlots.length) return
      if (!targetCards.cardIds.length && !targetCards.hiddenCardSlots.length) return
      askQingShiCard(host, ownerId, { targetId: target.id, actorId: ownerId, nextActorId: target.id })
      return
    }
    if (resolution.step !== 'discard-card') return
    const data = resolution.data as { targetId: PlayerId; actorId: PlayerId; nextActorId: PlayerId | null }
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? resolvePickedCard(host.state, data.actorId, selected) : null
    if (!cardId || isCardProtectedFromDiscard(host.state, data.actorId, cardId, ownerId)
      || !movePickedCard(host as never, data.actorId, cardId, { kind: 'discardPile' })) {
      askQingShiCard(host, ownerId, data)
      return
    }
    host.dispatch('LoseCard', { playerId: data.actorId, cardIds: [cardId], reason: XY_QINGSHI }, { sourceId: ownerId, targetId: data.actorId, cardIds: [cardId] })
    if (data.nextActorId && host.state.players.some((player) => player.id === data.nextActorId && player.alive))
      askQingShiCard(host, ownerId, { targetId: data.targetId, actorId: data.nextActorId, nextActorId: null })
  },
})

registerSkillRuntime({ id: MQ_CUIZHEN,
  onGameStart(host, ownerId) {
    const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId && abolishableSlotsOf(host.state, player.id).includes('weapon')).map((player) => player.id)
    if (!targets.length) return
    host.askSkill({ skillId: MQ_CUIZHEN, ownerId, step: 'game-start', data: { targets }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【摧阵】：游戏开始时，指定至多三名其他角色废除武器栏',
      timeoutMs: 25_000, optional: true, candidateIds: targets, min: 0, max: Math.min(3, targets.length),
    }) })
  },
  triggers: [
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[] }
      const isDamage = payload.cardName === '杀' || Boolean(payload.cardName && DAMAGE_TRICKS.has(payload.cardName))
      if (sourceId !== ownerId || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
        || !isDamage || !payload.targetIds?.length) return
      const eligible = payload.targetIds.filter((targetId) => {
        const target = host.state.players.find((player) => player.id === targetId && player.alive && player.id !== ownerId)
        return Boolean(target && target.zones.hand.length >= target.hp && abolishableSlotsOf(host.state, targetId).includes('weapon'))
      })
      if (!eligible.length) return
      host.queueSkill({ skillId: MQ_CUIZHEN, ownerId, step: 'target', data: { cardId: payload.cardId, eligible } })
    } },
    { event: 'DrawPhase', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const count = host.state.players.filter((player) => host.state.abolishedSlots?.[player.id]?.includes('weapon')).length
      ;(context.event.payload as { count?: number }).count = 2 + Math.min(3, count + 1)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const eligible = (prompt.data.eligible as PlayerId[]).filter((targetId) => {
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      return Boolean(target && target.zones.hand.length >= target.hp && abolishableSlotsOf(host.state, targetId).includes('weapon'))
    })
    if (!eligible.length) return
    host.askSkill({ skillId: MQ_CUIZHEN, ownerId, step: 'abolish', data: { cardId: prompt.data.cardId, eligible }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【摧阵】：选择任意名符合条件的伤害牌目标废除其武器栏',
      timeoutMs: 25_000, optional: true, candidateIds: eligible, min: 0, max: eligible.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'game-start') {
      if (!host.state.players.some((player) => player.id === ownerId && player.alive)) return
      const eligible = new Set((resolution.data.targets as PlayerId[]) ?? [])
      const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])].slice(0, 3)
      for (const targetId of targets) if (eligible.has(targetId) && abolishableSlotsOf(host.state, targetId).includes('weapon')) abolishSlot(host.state, targetId, 'weapon')
      return
    }
    if (resolution.step !== 'abolish') return
    if (!host.state.players.some((player) => player.id === ownerId && player.alive)) return
    const eligible = new Set(resolution.data.eligible as PlayerId[])
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    for (const targetId of targetIds) {
      if (!eligible.has(targetId)) continue
      const target = host.state.players.find((player) => player.id === targetId && player.alive && player.zones.hand.length >= player.hp)
      if (target && abolishableSlotsOf(host.state, targetId).includes('weapon')) abolishSlot(host.state, targetId, 'weapon')
    }
  },
})

registerSkillRuntime({ id: MQ_KUILI,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    if (context.event.targetId !== ownerId || !sourceId || !host.state.abolishedSlots?.[sourceId]?.includes('weapon')) return
    restoreSlot(host.state, sourceId, 'weapon')
  } }],
})

registerSkillRuntime({ id: CF_XISHANG,
  basicCardUseValueBonus(state, ownerId, cardId, cardName) {
    const cui = (state as B57State).b57CuiFu
    const use = cui?.shape2Uses?.[ownerId]
    return cui?.shape[ownerId] === 2 && use?.turnNumber === state.turnNumber
      && use.basicCardId === cardId && use.basicCardName === cardName ? 1 : 0
  },
  outgoingDamage(state, ownerId, context) {
    const cui = (state as B57State).b57CuiFu
    const use = cui?.shape2Uses?.[ownerId]
    return cui?.shape[ownerId] === 2 && use?.turnNumber === state.turnNumber
      && use.basicCardId === context.cardId && use.basicCardName === '杀' && context.cardName === '杀'
      ? { amount: context.amount + 1 } : null
  },
  viewAs(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
    const cui = (state as B57State).b57CuiFu
    if (!owner || cui?.shape[ownerId] !== 3) return []
    const usage = cui.shape3Uses?.[ownerId]
    const used = usage?.turnNumber === state.turnNumber ? usage.used : []
    const keep = cuiFaceUpSuits(state, ownerId).size === SUTS.length
    const options: Array<{ slot: EquipmentSlot; key: string; cardName: string; label: string }> = [
      { slot: 'weapon', key: 'weapon', cardName: '杀', label: '武器牌当【杀】' },
      { slot: 'armor', key: 'armor', cardName: '闪', label: '防具牌当【闪】' },
      { slot: 'defensiveHorse', key: 'defensiveHorse', cardName: '桃', label: '防御坐骑牌当【桃】' },
      { slot: 'offensiveHorse', key: 'offensiveHorse', cardName: '酒', label: '进攻坐骑牌当【酒】' },
    ]
    return options.flatMap(({ slot, key, cardName, label }) => {
      const cardId = owner.zones.equipment[slot]
      const card = cardId ? state.cards[cardId] : null
      return cardId && card?.category === 'equipment' && !used.includes(key)
        ? [{ cardId, asCardName: cardName, label, retainCard: keep }]
        : []
    })
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    const cui = (state as B57State).b57CuiFu
    const owner = state.players.find((player) => player.id === ownerId)
    return cui?.shape[ownerId] === 3 && owner?.zones.equipment.weapon === cardId
  },
  maxCardsBonus(state, ownerId) {
    const cui = (state as B57State).b57CuiFu
    return cui?.shape[ownerId] === 1 ? (cui.statChange?.[ownerId]?.hand ?? 0) : 0
  },
  globalSlashUses(state, ownerId, targetId) {
    const cui = (state as B57State).b57CuiFu
    return targetId === ownerId && cui?.shape[ownerId] === 1 ? (cui.statChange?.[ownerId]?.slash ?? 0) : 0
  },
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
    if (!owner) return
    host.askSkill({ skillId: CF_XISHANG, ownerId, step: 'choose-shape', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【袭裳】：选择本局形象对应的分支（官网技能页按此顺序列出）',
      timeoutMs: 30_000, optional: false, options: [
        { id: 'shape-1', label: '第一形象：结束阶段调整规则数值并发动裁裘' },
        { id: 'shape-2', label: '第二形象：按明置牌类别数强化牌效果' },
        { id: 'shape-3', label: '第三形象：褽装，装备牌转化基本牌' },
      ],
    }) })
  },
  triggers: [
    { event: 'BeforeCardUse', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; fromKind?: string }
      const cui = (host.state as B57State).b57CuiFu
      if (sourceId !== ownerId || cui?.shape[ownerId] !== 2 || !payload.cardId || !isBasicCardName(payload.cardName)) return
      const usage = cuiShape2Usage(host, ownerId)
      if (usage.basic) return
      const pending = cui.shape2PendingFaceUp?.[ownerId]
      let categoryCount = cuiFaceUpCategories(host.state, ownerId).size
      if (pending?.turnNumber === host.state.turnNumber && pending.cardId === payload.cardId)
        categoryCount = Math.max(categoryCount, pending.categoryCount)
      if (payload.fromKind === 'equipment' && host.state.cards[payload.cardId]?.category === 'equipment')
        categoryCount = Math.max(categoryCount, 1)
      cui.shape2PreparedBasicUse ??= {}
      cui.shape2PreparedBasicUse[ownerId] = {
        turnNumber: host.state.turnNumber, cardId: payload.cardId, cardName: payload.cardName, eligible: categoryCount > 0,
      }
      delete cui.shape2PendingFaceUp?.[ownerId]
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (sourceId !== ownerId || !payload.cardId || !isBasicCardName(payload.cardName)) return
      const cui = (host.state as B57State).b57CuiFu
      const prepared = cui?.shape2PreparedBasicUse?.[ownerId]
      if (!cui || cui.shape[ownerId] !== 2 || prepared?.turnNumber !== host.state.turnNumber
        || prepared.cardId !== payload.cardId || prepared.cardName !== payload.cardName || !prepared.eligible) return
      const usage = cuiShape2Usage(host, ownerId)
      if (!usage.basic) {
        usage.basic = true
        usage.basicCardId = payload.cardId
        usage.basicCardName = payload.cardName
      }
      delete cui.shape2PreparedBasicUse?.[ownerId]
    } },
    { event: 'DrawPhase', handle(host, ownerId, context) {
      const cui = (host.state as B57State).b57CuiFu
      if (context.event.sourceId !== ownerId || cui?.shape[ownerId] !== 1) return
      const payload = context.event.payload as { count?: number }
      payload.count = Math.max(0, (payload.count ?? 2) + (cui.statChange?.[ownerId]?.draw ?? 0))
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const cui = (host.state as B57State).b57CuiFu
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const playerCount = host.state.players.length
      const hasFaceUp = payload.playerId ? cuiHasFaceUpCards(host.state, payload.playerId) : false
      const uses = cui?.shape1Uses?.[ownerId] ?? 0
      if (cui?.shape[ownerId] !== 1 || payload.phase !== 'finish' || !hasFaceUp || uses >= playerCount + 1) return
      host.queueSkill({ skillId: CF_XISHANG, ownerId, step: 'shape1-decrease', data: {} })
    } },
    { event: 'GainCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; isDraw?: boolean }
      if (payload.playerId !== ownerId || payload.isDraw === true) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
      if (!owner) return
      const faceUpByPlayer = (host.state.faceUpHandCards ??= {})
      const faceUp = faceUpByPlayer[ownerId] ??= []
      let newlyFaceUp = 0
      for (const cardId of payload.cardIds ?? [])
        if (owner.zones.hand.includes(cardId) && !faceUp.includes(cardId)) { faceUp.push(cardId); newlyFaceUp += 1 }
      if (newlyFaceUp && (host.state as B57State).b57CuiFu?.shape[ownerId] === 1) {
        const cui = (host.state as B57State).b57CuiFu!
        const threshold = host.state.players.length + 1
        const oldProgress = cui.faceUpProgress?.[ownerId] ?? 0
        const total = oldProgress + newlyFaceUp
        const awards = Math.floor(total / threshold)
        cui.faceUpProgress ??= {}
        cui.faceUpProgress[ownerId] = total % threshold
        for (let index = 0; index < awards; index += 1)
          host.queueSkill({ skillId: CF_XISHANG, ownerId, step: 'shape1-increase', data: { index } })
      }
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; destination?: { kind?: string } | null }
      if (payload.playerId !== ownerId || !payload.cardId) return
      const faceUp = host.state.faceUpHandCards?.[ownerId]
      if (!faceUp) return
      const cui = (host.state as B57State).b57CuiFu
      if (cui?.shape[ownerId] === 2 && payload.destination?.kind === 'processingArea' && faceUp.includes(payload.cardId)) {
        const categoryCount = new Set([...cuiFaceUpCategories(host.state, ownerId), host.state.cards[payload.cardId]?.category]
          .filter((category): category is CardCategory => Boolean(category))).size
        ;(cui.shape2PendingFaceUp ??= {})[ownerId] = { turnNumber: host.state.turnNumber, cardId: payload.cardId, categoryCount }
      }
      host.state.faceUpHandCards![ownerId] = faceUp.filter((cardId) => cardId !== payload.cardId)
      if (!host.state.faceUpHandCards![ownerId]!.length) delete host.state.faceUpHandCards![ownerId]
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      const state = host.state as B57State
      const sourceId = context.event.sourceId
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (!owner || sourceId !== ownerId || state.b57CuiFu?.shape[ownerId] !== 2 || !payload.cardId
        || host.state.cards[payload.cardId]?.category !== 'trick' || cuiFaceUpCategories(host.state, ownerId).size < 2) return
      const eligible = (payload.targetIds ?? []).filter((targetId) => {
        const pickable = pickableCardsOf(host.state, targetId)
        return host.state.players.some((player) => player.id === targetId && player.alive)
          && (pickable.cardIds.length > 0 || pickable.hiddenCardSlots.length > 0)
      })
      if (!eligible.length || cuiShape2Usage(host, ownerId).trick) return
      host.queueSkill({ skillId: CF_XISHANG, ownerId, step: 'shape2-trick-target', data: { eligible } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const state = host.state as B57State
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean; sourceSkillId?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
      if (owner && sourceId === ownerId && state.b57CuiFu?.shape[ownerId] === 3 && payload.cardId
        && (payload.sourceSkillId === CF_XISHANG || isCuiShape3Material(host.state, payload.cardId, payload.cardName))) {
        finishCuiShape3Use(host, ownerId, payload.cardId, payload.cardName)
      }
      if (!owner || sourceId !== ownerId || state.b57CuiFu?.shape[ownerId] !== 2 || payload.cancelled || !payload.cardId
        || host.state.cards[payload.cardId]?.category !== 'equipment' || cuiFaceUpCategories(host.state, ownerId).size < 3) return
      const eligible = host.state.players.filter((player) => player.alive && cuiHasFaceUpCards(host.state, player.id)).map((player) => player.id)
      if (!eligible.length || cuiShape2Usage(host, ownerId).equipment) return
      host.queueSkill({ skillId: CF_XISHANG, ownerId, step: 'shape2-equipment-target', data: { eligible } })
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { asking?: boolean; cardId?: CardId; cardName?: string; fromKind?: string }
      if (payload.asking || context.event.sourceId !== ownerId || !payload.cardId) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
      const card = host.state.cards[payload.cardId]
      if (owner && (host.state as B57State).b57CuiFu?.shape[ownerId] === 3
        && (card?.sourceSkillId === CF_XISHANG || (payload.fromKind === 'equipment' && isCuiShape3Material(host.state, payload.cardId, payload.cardName))))
        finishCuiShape3Use(host, ownerId, payload.cardId, payload.cardName)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'shape3-gain') {
      const suit = prompt.data.suit as Suit
      const cardIds = [...host.state.zones.drawPile, ...host.state.zones.discardPile]
        .filter((cardId) => host.state.cards[cardId]?.suit === suit)
      if (!cardIds.length) return
      host.askSkill({ skillId: CF_XISHANG, ownerId, step: 'shape3-gain', data: { suit, cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【褽装】：选择获得一张${SUIT_LABEL[suit]}牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } else if (prompt.step === 'shape1-decrease' || prompt.step === 'shape1-increase') {
      askCuiShape1Stat(host, ownerId, prompt.step, typeof prompt.data.index === 'number' ? prompt.data.index : undefined)
    } else if (prompt.step === 'shape2-trick-target') {
      const eligible = (prompt.data.eligible as PlayerId[]).filter((targetId) => {
        const target = host.state.players.find((player) => player.id === targetId && player.alive)
        const pickable = pickableCardsOf(host.state, targetId)
        return Boolean(target && (pickable.cardIds.length || pickable.hiddenCardSlots.length))
      })
      if (!eligible.length) return
      host.askSkill({ skillId: CF_XISHANG, ownerId, step: 'shape2-trick-choose-target', data: { eligible }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【褽装】：是否获得一名锦囊牌目标的一张牌？', timeoutMs: 25_000,
        optional: true, candidateIds: eligible, min: 0, max: 1,
      }) })
    } else if (prompt.step === 'shape2-equipment-target') {
      const eligible = (prompt.data.eligible as PlayerId[]).filter((targetId) => {
        const target = host.state.players.find((player) => player.id === targetId && player.alive)
        return Boolean(target && cuiHasFaceUpCards(host.state, targetId))
      })
      if (!eligible.length) return
      host.askSkill({ skillId: CF_XISHANG, ownerId, step: 'shape2-equipment-choose-target', data: { eligible }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【褽装】：是否令一名有明置牌的角色摸两张牌？', timeoutMs: 25_000,
        optional: true, candidateIds: eligible, min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'shape3-gain') {
      const suit = resolution.data.suit as Suit
      const requested = new Set(resolution.data.cardIds as CardId[])
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !requested.has(cardId) || host.state.cards[cardId]?.suit !== suit) return
      const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const }
        : host.state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' as const } : null
      if (!from) return
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CF_XISHANG }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'choose-shape') {
      const option = (response.payload as { optionId?: string }).optionId
      const shape = option === 'shape-1' ? 1 : option === 'shape-2' ? 2 : option === 'shape-3' ? 3 : null
      if (!shape || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
      const cui = (host.state as B57State).b57CuiFu ??= { shape: {}, recordedNames: {} }
      cui.shape[ownerId] = shape
      return
    }
    if (resolution.step === 'shape1-decrease' || resolution.step === 'shape1-increase') {
      const stat = (response.payload as { optionId?: string }).optionId as CuiShape1Stat | undefined
      if (stat !== 'draw' && stat !== 'slash' && stat !== 'hand' && stat !== 'hp') return
      if (!host.state.players.some((player) => player.id === ownerId && player.alive)) return
      if (resolution.step === 'shape1-decrease') {
        const cui = (host.state as B57State).b57CuiFu ??= { shape: {}, recordedNames: {} }
        const uses = cui.shape1Uses?.[ownerId] ?? 0
        if (uses >= host.state.players.length + 1) return
        cui.shape1Uses ??= {}
        cui.shape1Uses[ownerId] = uses + 1
        applyCuiShape1Stat(host, ownerId, stat, -1)
        askCuiCaiqiu(host, ownerId, host.state.roundNumber)
      } else applyCuiShape1Stat(host, ownerId, stat, 1)
      return
    }
    if (resolution.step === 'shape2-trick-choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !(resolution.data.eligible as PlayerId[]).includes(targetId)) return
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      const pickable = pickableCardsOf(host.state, targetId)
      if (!target || (!pickable.cardIds.length && !pickable.hiddenCardSlots.length)) return
      cuiShape2Usage(host, ownerId).trick = true
      askCuiTrickGain(host, ownerId, targetId)
      return
    }
    if (resolution.step === 'shape2-trick-card') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CF_XISHANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CF_XISHANG }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'shape2-equipment-choose-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !(resolution.data.eligible as PlayerId[]).includes(targetId)) return
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target || !cuiHasFaceUpCards(host.state, targetId)) return
      cuiShape2Usage(host, ownerId).equipment = true
      drawCards(host.state, host.rng, targetId, 2, (name, data) => host.dispatch(name, data))
    }
  },
})

registerSkillRuntime({ id: CF_CAIQIU,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId, context) {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'cui-fu-b57')
      if (!owner) return
      const roundNumber = (context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber
      const cardIds = revealTopCards(host.state, host.rng, host.state.players.length, CF_CAIQIU, (name, data) => host.dispatch(name, data))
      if (!cardIds.length) return
      ;((host.state as B57State).b57CuiFu ??= { shape: {}, recordedNames: {} }).roundSelection ??= {}
      ;((host.state as B57State).b57CuiFu!.roundSelection!)[ownerId] = { roundNumber, cardIds: [...cardIds] }
      host.askSkill({ skillId: CF_CAIQIU, ownerId, step: 'take-top', data: { roundNumber, cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【裁裘】：获得其中任意张牌（未获得的牌置入弃牌堆）',
        timeoutMs: 30_000, optional: true, purpose: 'skill', cardIds: [...cardIds], hiddenCardSlots: [], min: 0, max: cardIds.length,
      }) })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string }
      const state = host.state as B57State
      const recorded = state.b57CuiFu?.recordedNames[ownerId]
      if (!sourceId || sourceId === ownerId || !payload.cardName || recorded?.roundNumber !== host.state.roundNumber
        || !recorded.names.includes(payload.cardName)) return
      loseHp(host as never, ownerId, 1, CF_CAIQIU)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'take-top') return
    const data = resolution.data as { roundNumber: number; cardIds: CardId[] }
    const available = new Set(host.state.zones.processingArea.filter((cardId) => data.cardIds.includes(cardId)))
    const chosen = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((cardId) => available.has(cardId))
    const chosenSet = new Set(chosen)
    const state = host.state as B57State
    const cui = state.b57CuiFu ??= { shape: {}, recordedNames: {} }
    const recorded = cui.recordedNames[ownerId]?.roundNumber === data.roundNumber
      ? cui.recordedNames[ownerId]! : { roundNumber: data.roundNumber, names: [] as string[] }
    for (const cardId of data.cardIds) {
      if (!available.has(cardId)) continue
      if (chosenSet.has(cardId)) {
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
        recorded.names.push(host.state.cards[cardId]!.name)
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CF_CAIQIU }, { targetId: ownerId, cardIds: [cardId] })
      } else moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
    cui.recordedNames[ownerId] = recorded
  },
})

registerSkillRuntime({ id: SL_QUANCHONG,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-chenzhi-b57')
      if (phase.playerId !== ownerId || phase.phase !== 'finish' || !owner) return
      const state = host.state as B57State
      const quanChong = (state.b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} }).quanChongRoundUses
      const usage = quanChong[ownerId]
      if (usage?.roundNumber === host.state.roundNumber && usage.count >= 1) return
      host.queueSkill({ skillId: SL_QUANCHONG, ownerId, step: 'invoke', data: { roundNumber: host.state.roundNumber } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; kind?: string; sourceSkillId?: string; sourcePlayerId?: PlayerId }
      if (event.playerId !== ownerId || event.kind !== 'extra' || event.sourceSkillId !== SL_QUANCHONG
        || event.sourcePlayerId !== ownerId) return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      if (!owner) return
      const living = host.state.players.filter((player) => player.alive)
      const maximum = Math.max(...living.map((player) => player.hp))
      if (owner.hp === maximum && living.filter((player) => player.hp === maximum).length === 1) return
      loseHp(host as never, ownerId, 1, SL_QUANCHONG)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-chenzhi-b57')
    const state = host.state as B57State
    const usage = state.b57ChenZhi?.quanChongRoundUses[ownerId]
    if (!owner || (usage?.roundNumber === host.state.roundNumber && usage.count >= 1)) return
    host.askSkill({ skillId: SL_QUANCHONG, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: '【权宠】：弃置所有手牌和装备牌，执行一个额外回合；若额外回合开始时你的体力值不是全场唯一最大，则失去1点体力',
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '弃置所有牌并执行额外回合' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    const state = host.state as B57State
    const chen = state.b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} }
    const usage = chen.quanChongRoundUses[ownerId]
    if (usage?.roundNumber === host.state.roundNumber && usage.count >= 1) return
    chen.quanChongRoundUses[ownerId] = { roundNumber: host.state.roundNumber, count: (usage?.roundNumber === host.state.roundNumber ? usage.count : 0) + 1 }
    discardAllCards(host as never, ownerId, SL_QUANCHONG)
    queueExtraTurn(host.state, ownerId, { skillId: SL_QUANCHONG, playerId: ownerId })
  },
})

registerSkillRuntime({ id: SL_RENXING,
  triggers: [
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const movement = context.event.payload as { fromPlayerId?: PlayerId | null; reason?: string }
      if (movement.reason !== 'discard' || !movement.fromPlayerId || host.state.phase === 'discard') return
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-chenzhi-b57')
      if (!owner) return
      const state = host.state as B57State
      const chen = state.b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} }
      if (chen.renXingTurnPrompted[ownerId] === host.state.turnNumber) return
      const usage = chen.renXingRoundUses[ownerId]
      if (usage?.roundNumber === host.state.roundNumber && usage.count >= 2) return
      chen.renXingTurnPrompted[ownerId] = host.state.turnNumber
      host.queueSkill({ skillId: SL_RENXING, ownerId, step: 'invoke', data: { turnNumber: host.state.turnNumber, roundNumber: host.state.roundNumber } })
    } },
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string }
      if (!sourceId || payload.cardName !== '杀') return
      const chen = ((host.state as B57State).b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} })
      const users = chen.slashUsersByTurn[host.state.turnNumber] ??= []
      if (!users.includes(sourceId)) users.push(sourceId)
    } },
    { event: 'CardResponded', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string; cardId?: CardId }
      const cardName = payload.cardName ?? (payload.cardId ? host.state.cards[payload.cardId]?.name : undefined)
      if (!sourceId || cardName !== '杀') return
      const chen = ((host.state as B57State).b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} })
      const users = chen.slashUsersByTurn[host.state.turnNumber] ??= []
      if (!users.includes(sourceId)) users.push(sourceId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-chenzhi-b57')
    const chen = (host.state as B57State).b57ChenZhi
    const usage = chen?.renXingRoundUses[ownerId]
    if (!owner || (usage?.roundNumber === host.state.roundNumber && usage.count >= 2)) return
    const turnPlayer = host.state.players.find((player) => player.id === host.state.currentPlayerId && player.alive)
    const slashUsers = chen?.slashUsersByTurn[host.state.turnNumber] ?? []
    const discardCandidates = host.state.players.filter((player) => player.alive && !slashUsers.includes(player.id)
      && (() => { const cards = pickableCardsOf(host.state, player.id, { discarderId: ownerId }); return cards.cardIds.length > 0 || cards.hiddenCardSlots.length > 0 })()).map((player) => player.id)
    const options = [
      ...(turnPlayer ? [{ id: 'draw', label: '你与当前回合角色各摸一张牌' }] : []),
      ...(discardCandidates.length ? [{ id: 'discard', label: '弃置一名本回合未使用或打出过【杀】的角色一张牌' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: SL_RENXING, ownerId, step: 'invoke', data: { ...prompt.data, discardCandidates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【任行】：选择一项', timeoutMs: 25_000,
      optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const chen = (host.state as B57State).b57ChenZhi ??= { quanChongRoundUses: {}, renXingRoundUses: {}, renXingTurnPrompted: {}, slashUsersByTurn: {} }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const eligible = resolution.data.eligible as PlayerId[]
      const target = targetId && eligible.includes(targetId) && host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target) return
      const pickable = pickableCardsOf(host.state, target.id, { discarderId: ownerId })
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: SL_RENXING, ownerId, step: 'discard', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【任行】：弃置${target.nickname}一张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
      if (!cardId || !movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: SL_RENXING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }
    const usage = chen.renXingRoundUses[ownerId]
    if (usage?.roundNumber === host.state.roundNumber && usage.count >= 2) return
    const option = (response.payload as { optionId?: string }).optionId
    if (option !== 'draw' && option !== 'discard') return
    chen.renXingRoundUses[ownerId] = { roundNumber: host.state.roundNumber, count: (usage?.roundNumber === host.state.roundNumber ? usage.count : 0) + 1 }
    if (option === 'draw') {
      const turnPlayerId = host.state.currentPlayerId
      if (!host.state.players.some((player) => player.id === ownerId && player.alive)) return
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      if (host.state.players.some((player) => player.id === turnPlayerId && player.alive))
        drawCards(host.state, host.rng, turnPlayerId, 1, (name, data) => host.dispatch(name, data))
      return
    }
    if (resolution.step !== 'invoke') return
    const eligible = (resolution.data.discardCandidates as PlayerId[]).filter((playerId) => {
      const target = host.state.players.find((player) => player.id === playerId && player.alive)
      if (!target || (chen.slashUsersByTurn[host.state.turnNumber] ?? []).includes(playerId)) return false
      const cards = pickableCardsOf(host.state, playerId, { discarderId: ownerId })
      return cards.cardIds.length > 0 || cards.hiddenCardSlots.length > 0
    })
    if (!eligible.length) return
    host.askSkill({ skillId: SL_RENXING, ownerId, step: 'target', data: { eligible }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【任行】：选择一名本回合未使用或打出过【杀】的角色',
      timeoutMs: 25_000, optional: false, candidateIds: eligible, min: 1, max: 1,
    }) })
  },
})

registerSkillRuntime({ id: SLU_HAOSHI,
  onGameStart(host, ownerId) {
    const state = host.state as B57State
    ;(state.b57ShiLuSuHaoshiRefills ??= {})[ownerId] = 0
  },
  sharedHandCards(state, ownerId, userId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-lusu-b57')
    const active = (state as B57State).b57ShiLuSuHaoshi?.[ownerId]
    return owner && active?.borrowerId === userId ? [...owner.zones.hand] : []
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-lusu-b57')
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!owner || phase.playerId !== ownerId || phase.phase !== 'finish' || !targets.length) return
      host.askSkill({ skillId: SLU_HAOSHI, ownerId, step: 'borrower', data: { targets }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【好施】：选择一名其他角色，令其在你下回合开始前可使用或打出你的手牌',
        timeoutMs: 25_000, optional: true, candidateIds: targets, min: 0, max: 1,
      }) })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const current = (context.event.payload as { playerId?: PlayerId }).playerId
      if (current === ownerId) delete (host.state as B57State).b57ShiLuSuHaoshi?.[ownerId]
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardOwnerId?: PlayerId }
      queueHaoShiRefill(host, ownerId, context.event.sourceId ?? '', payload.cardOwnerId)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { asking?: boolean; cardOwnerId?: PlayerId }
      if (!payload.asking) queueHaoShiRefill(host, ownerId, context.event.sourceId ?? '', payload.cardOwnerId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'refill-to-three') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (owner) drawCards(host.state, host.rng, ownerId, Math.max(0, 3 - owner.zones.hand.length), (name, data) => host.dispatch(name, data))
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'borrower') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !(resolution.data.targets as PlayerId[]).includes(targetId)
      || !host.state.players.some((player) => player.id === targetId && player.alive && player.id !== ownerId)) return
    ;((host.state as B57State).b57ShiLuSuHaoshi ??= {})[ownerId] = { borrowerId: targetId }
  },
})

registerSkillRuntime({ id: SLU_DIMENG,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-lusu-b57')
    if (!owner || phase.playerId !== ownerId || phase.phase !== 'play'
      || (host.state as B57State).b57ShiLuSuDimengUsedTurn?.[ownerId] === host.state.turnNumber) return
    const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
    if (candidates.length < 2) return
    host.askSkill({ skillId: SLU_DIMENG, ownerId, step: 'first-target', data: { candidates }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【缔盟】：选择第一名角色（可包括自己）',
      timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: 1,
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-lusu-b57')
    if (!owner) return
    const selected = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (resolution.step === 'first-target') {
      const candidates = new Set(resolution.data.candidates as PlayerId[])
      const first = selected && candidates.has(selected) && host.state.players.find((player) => player.id === selected && player.alive)
      if (!first) return
      const secondCandidates = host.state.players.filter((player) => player.alive && player.id !== first.id
        && Math.abs(player.zones.hand.length - first.zones.hand.length) <= 3).map((player) => player.id)
      if (!secondCandidates.length) return
      host.askSkill({ skillId: SLU_DIMENG, ownerId, step: 'second-target', data: { firstId: first.id, candidates: secondCandidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【缔盟】：选择第二名角色（与${first.nickname}手牌数之差须不大于3）`,
        timeoutMs: 25_000, optional: true, candidateIds: secondCandidates, min: 0, max: 1,
      }) })
      return
    }
    if (resolution.step === 'second-target') {
      const { firstId, candidates } = resolution.data as { firstId: PlayerId; candidates: PlayerId[] }
      const first = host.state.players.find((player) => player.id === firstId && player.alive)
      const second = selected && candidates.includes(selected) && host.state.players.find((player) => player.id === selected && player.alive)
      if (!first || !second || first.id === second.id || Math.abs(first.zones.hand.length - second.zones.hand.length) > 3) return
      swapHands(host as never, first.id, second.id, SLU_DIMENG)
      const state = host.state as B57State
      ;(state.b57ShiLuSuDimengUsedTurn ??= {})[ownerId] = host.state.turnNumber
      const minimumCount = Math.min(first.zones.hand.length, second.zones.hand.length)
      const drawTargets = [first, second].filter((player) => player.zones.hand.length === minimumCount).map((player) => player.id)
      const lostHp = Math.max(0, owner.maxHp - owner.hp)
      host.askSkill({ skillId: SLU_DIMENG, ownerId, step: 'choice', data: { drawTargets, lostHp }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId,
        prompt: '【缔盟】：选择一项：令交换后手牌数较少的角色摸X张牌，或弃置X张牌（X为你已损失的体力值）',
        timeoutMs: 25_000, optional: false, options: [
          { id: 'draw', label: `令手牌较少的角色摸${lostHp}张牌` },
          { id: 'discard', label: `弃置${lostHp}张牌（不足则全弃）` },
        ],
      }) })
      return
    }
    if (resolution.step === 'choice') {
      const { drawTargets, lostHp } = resolution.data as { drawTargets: PlayerId[]; lostHp: number }
      const option = (response.payload as { optionId?: string }).optionId
      if (option === 'draw') {
        const eligible = drawTargets.filter((playerId) => host.state.players.some((player) => player.alive && player.id === playerId))
        if (!eligible.length || lostHp === 0) return
        host.askSkill({ skillId: SLU_DIMENG, ownerId, step: 'draw-target', data: { eligible, lostHp }, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【缔盟】：选择一名手牌数较少的角色摸牌',
          timeoutMs: 25_000, optional: false, candidateIds: eligible, min: 1, max: 1,
        }) })
      } else if (option === 'discard') {
        const required = Math.min(lostHp, owner.zones.hand.length)
        if (required === 0) return
        host.askSkill({ skillId: SLU_DIMENG, ownerId, step: 'discard', data: { required }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【缔盟】：弃置${required}张手牌`, timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: required, max: required,
        }) })
      }
      return
    }
    if (resolution.step === 'draw-target') {
      const { eligible, lostHp } = resolution.data as { eligible: PlayerId[]; lostHp: number }
      const targetId = selected
      if (!targetId || !eligible.includes(targetId)) return
      const target = host.state.players.find((player) => player.alive && player.id === targetId)
      if (target && lostHp > 0) drawCards(host.state, host.rng, targetId, lostHp, (name, data) => host.dispatch(name, data))
      return
    }
    if (resolution.step === 'discard') {
      const required = Math.min(Number(resolution.data.required ?? 0), owner.zones.hand.length)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      if (cardIds.length !== required || cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) return
      if (cardIds.length) discardCardsByIds(host as never, ownerId, cardIds, SLU_DIMENG)
    }
  },
})

function nonBlackSlashIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = state.players.find((candidate) => candidate.id === playerId && candidate.alive)
  if (!player) return []
  const targets = state.players.filter((target) => target.alive && target.id !== playerId && canTarget(state, playerId, target.id))
  const options = new Set(targets.flatMap((target) => slashUseOptions(state, playerId, target.id)))
  return [...options].filter((cardId) => effectiveCardColor(state, playerId, cardId) !== 'black')
}

function yuJinSlashTargets(state: SanguoshaState, userId: PlayerId, cardId?: CardId): PlayerId[] {
  return state.players.filter((target) => target.alive && target.id !== userId
    && canTarget(state, userId, target.id) && !isTargetProhibited(state, userId, target.id, '杀', skillIdsOf, cardId)
    && (!cardId || slashUseOptions(state, userId, target.id).includes(cardId))).map((target) => target.id)
}

function yuJinDamageTargets(state: SanguoshaState, userId: PlayerId): PlayerId[] {
  const range = getAttackRange(state, userId)
  return state.players.filter((target) => target.alive && (target.id === userId
    || getDistance(state, userId, target.id) <= range)).map((target) => target.id)
}

function askYuJinFallback(host: SkillHost, ownerId: PlayerId, userId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  const user = host.state.players.find((player) => player.id === userId && player.alive)
  const targets = yuJinDamageTargets(host.state, userId)
  if (!owner || !user || !targets.length) return
  host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'fallback-choice', data: { userId, targets }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: `【镇军】：${user.nickname}未使用非黑色【杀】，是否对其或其攻击范围内的一名角色造成1点伤害？`,
    timeoutMs: 25_000, optional: false, options: [
      { id: 'damage', label: '造成1点伤害' }, { id: 'pass', label: '不造成伤害' },
    ],
  }) })
}

registerSkillRuntime({ id: YJ_ZHENJUN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'sp-yujin-b57')
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!owner || phase.playerId !== ownerId || phase.phase !== 'play' || !owner.zones.hand.length || !candidates.length) return
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'recipient', data: { candidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇军】：选择一名其他角色并交给其一张手牌',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: 1,
      }) })
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const entries = (host.state as B57State).b57YuJinZhenjun?.[ownerId]?.pendingSlashes
      const payload = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      const entry = payload.cardId ? entries?.[payload.cardId] : undefined
      if (!entry || context.event.sourceId !== entry.userId) return
      entry.damage += Math.max(0, Math.trunc(payload.finalAmount ?? 0))
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const state = host.state as B57State
      const entries = state.b57YuJinZhenjun?.[ownerId]?.pendingSlashes
      const payload = context.event.payload as { cardId?: CardId }
      const entry = payload.cardId ? entries?.[payload.cardId] : undefined
      if (!entry || context.event.sourceId !== entry.userId || !payload.cardId) return
      delete entries![payload.cardId]
      if (host.state.players.some((player) => player.alive && player.id === ownerId))
        drawCards(host.state, host.rng, ownerId, Math.min(5, entry.damage + 1), (name, data) => host.dispatch(name, data))
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'sp-yujin-b57')
    if (!owner) return
    const payload = response.payload as { targetIds?: PlayerId[]; cardIds?: CardId[]; optionId?: string }
    if (resolution.step === 'recipient') {
      const userId = payload.targetIds?.[0]
      if (!userId || !(resolution.data.candidates as PlayerId[]).includes(userId)
        || !host.state.players.some((player) => player.alive && player.id === userId && player.id !== ownerId)) return
      const cardIds = [...owner.zones.hand]
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'give-card', data: { userId, cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【镇军】：选择一张手牌交给该角色', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give-card') {
      const userId = resolution.data.userId as PlayerId
      const cardId = payload.cardIds?.[0]
      if (!cardId || !owner.zones.hand.includes(cardId) || !host.state.players.some((player) => player.alive && player.id === userId)) return
      if (!giveCards(host as never, ownerId, userId, [cardId], YJ_ZHENJUN).length) return
      const slashes = nonBlackSlashIds(host.state, userId)
      const targets = yuJinSlashTargets(host.state, userId)
      if (!slashes.length || !targets.length) { askYuJinFallback(host, ownerId, userId); return }
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'use-slash', data: { userId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: userId, prompt: '【镇军】：是否使用一张非黑色【杀】？',
        timeoutMs: 25_000, optional: false, options: [
          { id: 'use', label: '使用一张非黑色【杀】' }, { id: 'decline', label: '不使用' },
        ],
      }) })
      return
    }
    if (resolution.step === 'use-slash') {
      const userId = resolution.data.userId as PlayerId
      const slashes = nonBlackSlashIds(host.state, userId)
      if (payload.optionId !== 'use' || !slashes.length) { askYuJinFallback(host, ownerId, userId); return }
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'slash-card', data: { userId, cardIds: slashes }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: userId, prompt: '【镇军】：选择使用一张非黑色【杀】', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: slashes, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'slash-card') {
      const userId = resolution.data.userId as PlayerId
      const cardId = payload.cardIds?.[0]
      const cardIds = resolution.data.cardIds as CardId[]
      if (!cardId || !cardIds.includes(cardId) || !nonBlackSlashIds(host.state, userId).includes(cardId)) { askYuJinFallback(host, ownerId, userId); return }
      const targets = yuJinSlashTargets(host.state, userId, cardId)
      if (!targets.length) { askYuJinFallback(host, ownerId, userId); return }
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'slash-target', data: { userId, cardId, targets }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: userId, prompt: '【镇军】：选择【杀】的目标',
        timeoutMs: 25_000, optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'slash-target') {
      const { userId, cardId, targets } = resolution.data as { userId: PlayerId; cardId: CardId; targets: PlayerId[] }
      const targetId = payload.targetIds?.[0]
      if (!targetId || !targets.includes(targetId) || !host.state.players.some((player) => player.alive && player.id === userId)
        || !nonBlackSlashIds(host.state, userId).includes(cardId)
        || !yuJinSlashTargets(host.state, userId, cardId).includes(targetId)) { askYuJinFallback(host, ownerId, userId); return }
      if (effectiveCardName(host.state, cardId) !== '杀') setCardAlias(host.state, cardId, '杀')
      const entries = (((host.state as B57State).b57YuJinZhenjun ??= {})[ownerId] ??= { pendingSlashes: {} }).pendingSlashes
      entries[cardId] = { userId, damage: 0 }
      if (!host.beginVirtualSlash({ sourceId: userId, targetId, sourceSkillId: YJ_ZHENJUN, cardId, countUsage: false })) {
        delete entries[cardId]
        askYuJinFallback(host, ownerId, userId)
      }
      return
    }
    if (resolution.step === 'fallback-choice') {
      if (payload.optionId !== 'damage') return
      const targets = (resolution.data.targets as PlayerId[]).filter((targetId) => host.state.players.some((player) => player.alive && player.id === targetId))
      if (!targets.length) return
      host.askSkill({ skillId: YJ_ZHENJUN, ownerId, step: 'fallback-target', data: { targets }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇军】：选择受到1点伤害的角色',
        timeoutMs: 25_000, optional: false, candidateIds: targets, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'fallback-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || !(resolution.data.targets as PlayerId[]).includes(targetId)
        || !host.state.players.some((player) => player.alive && player.id === targetId)) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '镇军' })
    }
  },
})

registerSkillRuntime({ id: HJ_GONGMOU,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-huanjie-b57')
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      if (!owner || phase.playerId !== ownerId || phase.phase !== 'prepare' || !candidates.length) return
      host.askSkill({ skillId: HJ_GONGMOU, ownerId, step: 'target', data: { candidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【共谋】：选择一名其他角色交换手牌，然后你获得【奇策】，其获得【看破】至本回合结束',
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: 1,
      }) })
    } },
    { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId, context) {
      const turn = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const grants = (host.state as B57State).b57HuanJie?.[ownerId]
      if (!grants || turn.playerId !== ownerId || grants.turnNumber !== turn.turnNumber) return
      const source = `b57-huanjie:${ownerId}`
      replaceTemporarySkill(host.state, ownerId, source, null)
      replaceTemporarySkill(host.state, grants.targetId, source, null)
      delete (host.state as B57State).b57HuanJie?.[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const eligible = resolution.data.candidates as PlayerId[]
    if (!targetId || !eligible.includes(targetId) || !host.state.players.some((player) => player.id === targetId && player.alive)
      || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
    swapHands(host as never, ownerId, targetId, HJ_GONGMOU)
    const source = `b57-huanjie:${ownerId}`
    replaceTemporarySkill(host.state, ownerId, source, 'qice')
    replaceTemporarySkill(host.state, targetId, source, 'kanpo')
    ;((host.state as B57State).b57HuanJie ??= {})[ownerId] = { targetId, turnNumber: host.state.turnNumber }
  },
})

function discardAllHuanJieHands(host: SkillHost, sourceId: PlayerId): void {
  for (const player of host.state.players.filter((candidate) => candidate.alive)) {
    const cardIds = [...player.zones.hand]
    for (const cardId of cardIds)
      moveCard(host.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' }, { discardReason: 'discard' })
    if (cardIds.length)
      host.dispatch('LoseCard', { playerId: player.id, cardIds, reason: HJ_ZHENGSHUO }, { sourceId, targetId: player.id, cardIds })
  }
}

registerSkillRuntime({ id: HJ_ZHENGSHUO, limited: true,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-huanjie-b57')
    if (!owner || phase.playerId !== ownerId || phase.phase !== 'play' || owner.usedLimitedSkills.includes(HJ_ZHENGSHUO)) return
    host.askSkill({ skillId: HJ_ZHENGSHUO, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【正朔】：令所有角色弃置所有手牌并洗牌，然后所有角色各摸四张牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'invoke', label: '弃置所有手牌、洗牌并各摸四张' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'invoke') return
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-huanjie-b57')
    if (!owner || owner.usedLimitedSkills.includes(HJ_ZHENGSHUO)) return
    owner.usedLimitedSkills.push(HJ_ZHENGSHUO)
    discardAllHuanJieHands(host, ownerId)
    shuffleDrawAndDiscardPiles(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    for (const player of [...host.state.players].sort((left, right) => left.seat - right.seat)) {
      if (!player.alive || host.state.status !== 'playing') continue
      drawCards(host.state, host.rng, player.id, 4, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: WC_KAIJI,
  triggers: [
    { event: 'EnterDying', handle(host, _ownerId, context) {
      const enteredId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      if (!enteredId) return
      const players = (host.state as B57State).b57WangChangDyingPlayers ??= []
      if (!players.includes(enteredId)) players.push(enteredId)
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-wangchang-b57')
      if (!owner || phase.playerId !== ownerId || phase.phase !== 'prepare') return
      const dyingCount = ((host.state as B57State).b57WangChangDyingPlayers ?? [])
        .filter((playerId) => host.state.players.some((player) => player.id === playerId && player.alive)).length
      const maximum = Math.max(1, dyingCount)
      const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
      host.askSkill({ skillId: WC_KAIJI, ownerId, step: 'targets', data: { candidates, maximum }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId,
        prompt: `【开济】：令至多${maximum}名角色各摸一张牌；若有人因此获得非基本牌，你摸一张牌`,
        timeoutMs: 25_000, optional: true, candidateIds: candidates, min: 0, max: Math.min(maximum, candidates.length),
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    const eligible = new Set(resolution.data.candidates as PlayerId[])
    const maximum = Math.max(1, Math.trunc(Number(resolution.data.maximum ?? 1)))
    const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      .filter((targetId) => eligible.has(targetId) && host.state.players.some((player) => player.id === targetId && player.alive))
      .slice(0, maximum)
    let gainedNonBasic = false
    for (const targetId of targets) {
      const target = host.state.players.find((player) => player.id === targetId && player.alive)
      if (!target) continue
      const drawn = drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      if (drawn.some((cardId) => host.state.cards[cardId]?.category !== 'basic')) gainedNonBasic = true
    }
    if (gainedNonBasic && host.state.players.some((player) => player.id === ownerId && player.alive))
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  },
})

function isDamageCard(cardName: string, category: CardCategory): boolean {
  return cardName === '杀' || (category === 'trick' && DAMAGE_TRICKS.has(cardName))
}

function markShePanUse(host: SkillHost, ownerId: PlayerId, cardName: string): void {
  const records = (host.state as B57State).b57WangChang ??= {}
  const current = records[ownerId]
  const record = current?.roundNumber === host.state.roundNumber
    ? current : { turnNumber: host.state.turnNumber, roundNumber: host.state.roundNumber, names: [] as string[] }
  record.turnNumber = host.state.turnNumber
  if (!record.names.includes(cardName)) record.names.push(cardName)
  records[ownerId] = record
}

function finishShePan(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId): void {
  const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
  const source = host.state.players.find((player) => player.id === sourceId && player.alive)
  if (owner && source && owner.zones.hand.length === source.zones.hand.length)
    cancelCardTargetForOwner(host, ownerId)
  host.resumeCardTarget()
}

registerSkillRuntime({ id: WC_SHEPAN,
  interceptTarget(host, ownerId, context: TargetedCardContext) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-wangchang-b57')
    if (!owner || context.targetId !== ownerId || context.sourceId === ownerId || !isDamageCard(context.cardName, context.category)) return false
    const state = host.state as B57State
    const previous = state.b57WangChang?.[ownerId]
    if (previous?.turnNumber === host.state.turnNumber
      || (previous?.roundNumber === host.state.roundNumber && previous.names.includes(context.cardName))) return false
    const source = host.state.players.find((player) => player.id === context.sourceId && player.alive)
    if (!source) return false
    host.askSkill({ skillId: WC_SHEPAN, ownerId, step: 'invoke', data: { sourceId: source.id, cardName: context.cardName }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【慑叛】：${source.nickname}对你使用【${context.cardName}】，选择一项`,
      timeoutMs: 25_000, optional: true, options: [
        { id: 'draw', label: '摸一张牌' },
        ...(source.zones.hand.length ? [{ id: 'top', label: '将其一张手牌置于牌堆顶' }] : []),
      ],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const { sourceId, cardName } = resolution.data as { sourceId: PlayerId; cardName: string }
    if (resolution.step === 'invoke') {
      const option = (response.payload as { optionId?: string }).optionId
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
      const source = host.state.players.find((player) => player.id === sourceId && player.alive)
      if (!owner || !source || (option !== 'draw' && option !== 'top')) { host.resumeCardTarget(); return }
      markShePanUse(host, ownerId, cardName)
      if (option === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        finishShePan(host, ownerId, sourceId)
        return
      }
      const currentHand = [...source.zones.hand]
      if (!currentHand.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: WC_SHEPAN, ownerId, step: 'top-card', data: { sourceId, cardName }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【慑叛】：选择${source.nickname}一张手牌置于牌堆顶`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [],
        hiddenCardSlots: currentHand.map((_, index) => hiddenHandSlot(sourceId, index)), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'top-card') return
    const source = host.state.players.find((player) => player.id === sourceId && player.alive)
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected && source ? resolvePickedCard(host.state, sourceId, selected) : null
    if (!source || !cardId || !source.zones.hand.includes(cardId)) { host.resumeCardTarget(); return }
    moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'drawPile' }, { toTop: true })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: WC_SHEPAN }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
    finishShePan(host, ownerId, sourceId)
  },
})

registerSkillRuntime({ id: ZH_SIZI,
  globalOutgoingDamage(_state, ownerId, _sourceId, context) {
    if (zhonghuiActive(_state, ownerId) && context.cardName === '杀') return { amount: context.amount + 1 }
    return null
  },
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    owner.marks['肆恣蓄力'] = 4
    const zhonghui = (host.state as B57State).b57ZhongHui ??= {}
    zhonghui.kechangLevel ??= {}
    zhonghui.kechangLevel[ownerId] ??= 1
  },
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-zhonghui-b57')
    if (!owner || zhonghuiCharge(owner) <= 0
      || (state as B57State).b57ZhongHui?.activatedTurn?.[ownerId] === state.turnNumber) return []
    return [{ id: `${ZH_SIZI}:activate`, label: `【肆恣】消耗蓄力点（当前${zhonghuiCharge(owner)}点）` }]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-zhonghui-b57')
    if (!owner || actionId !== `${ZH_SIZI}:activate` || zhonghuiCharge(owner) <= 0
      || (host.state as B57State).b57ZhongHui?.activatedTurn?.[ownerId] === host.state.turnNumber) return
    const charge = zhonghuiCharge(owner)
    host.askSkill({ skillId: ZH_SIZI, ownerId, step: 'spend-charge', data: { charge }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【肆恣】：选择消耗的蓄力点数，效果持续至X个回合结束后或你的回合开始',
      timeoutMs: 25_000, optional: false,
      options: Array.from({ length: charge }, (_, index) => ({ id: `spend-${index + 1}`, label: `消耗${index + 1}点` })),
    }) })
  },
  triggers: [
    { event: 'CardUsed', handle(host, _ownerId, context) {
      const sourceId = context.event.sourceId
      const payload = context.event.payload as { cardName?: string }
      if (!sourceId || payload.cardName !== '杀') return
      const state = host.state as B57State
      const zhonghui = state.b57ZhongHui ??= {}
      const users = zhonghui.slashUsersByTurn ??= {}
      const turn = host.state.turnNumber
      const used = users[turn] ??= []
      if (!used.includes(sourceId)) used.push(sourceId)
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const state = host.state as B57State
      const zhonghui = state.b57ZhongHui
      if (!zhonghui) return
      const currentTurn = payload.turnNumber ?? host.state.turnNumber
      for (const turn of Object.keys(zhonghui.slashUsersByTurn ?? {}))
        if (Number(turn) < currentTurn) delete zhonghui.slashUsersByTurn![Number(turn)]
      if (payload.playerId === ownerId && zhonghui.active?.[ownerId]) delete zhonghui.active[ownerId]
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-zhonghui-b57')
      const state = host.state as B57State
      const active = zhonghuiActive(host.state, ownerId)
      if (!owner || !active) return
      const payload = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const turn = payload.turnNumber ?? host.state.turnNumber
      const slashUsers = [...new Set(state.b57ZhongHui?.slashUsersByTurn?.[turn] ?? [])]
      const zhonghui = state.b57ZhongHui!
      const remainingTurns = active.remainingTurns - 1
      if (remainingTurns <= 0) delete zhonghui.active?.[ownerId]
      else zhonghui.active![ownerId] = { ...active, remainingTurns }
      drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      for (const playerId of slashUsers) loseHp(host as never, playerId, 1, ZH_SIZI)
      if (active.noSlashPenalty && slashUsers.length === 0 && payload.playerId)
        loseHp(host as never, payload.playerId, 1, ZH_SIZI)
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'spend-charge') return
    const option = (response.payload as { optionId?: string }).optionId ?? ''
    const spent = Number(option.replace(/^spend-/u, ''))
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-zhonghui-b57')
    if (!owner || !Number.isInteger(spent) || spent < 1 || spent > zhonghuiCharge(owner)) return
    owner.marks['肆恣蓄力'] = zhonghuiCharge(owner) - spent
    const state = host.state as B57State
    const zhonghui = state.b57ZhongHui ??= {}
    zhonghui.active ??= {}
    zhonghui.active[ownerId] = { remainingTurns: spent, noSlashPenalty: spent > owner.hp }
    zhonghui.activatedTurn ??= {}
    zhonghui.activatedTurn[ownerId] = host.state.turnNumber
  },
})

registerSkillRuntime({ id: ZH_XIEZHI,
  maxCardsBonus(state, ownerId) {
    return state.players.find((player) => player.id === ownerId)?.marks['肆恣手牌上限'] ?? 0
  },
  globalSlashUses(state, ownerId, targetId) {
    return targetId === ownerId ? (state.players.find((player) => player.id === ownerId)?.marks['肆恣杀次数'] ?? 0) : 0
  },
  triggers: [
    { event: 'LoseHp', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; amount?: number }
      if (payload.playerId === ownerId) changeZhonghuiCharge(host, ownerId, payload.amount ?? 0)
    } },
    { event: 'Recover', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; amount?: number }
      if (payload.playerId === ownerId) changeZhonghuiCharge(host, ownerId, payload.amount ?? 0)
    } },
    { event: 'Damaged', handle(host, ownerId, context) {
      const payload = context.event.payload as { amount?: number }
      if (context.event.targetId === ownerId) changeZhonghuiCharge(host, ownerId, payload.amount ?? 0)
    } },
    { event: 'MaxHpChange', handle(host, ownerId, context) {
      const payload = context.event.payload as { trimmed?: number }
      if (context.event.targetId === ownerId) changeZhonghuiCharge(host, ownerId, payload.trimmed ?? 0)
    } },
  ],
})

registerSkillRuntime({ id: ZH_YUNAN,
  awakening: { phase: 'prepare', ready: () => false, invoke() {} },
  triggers: [
    { event: 'Death', handle(host, _ownerId, context) {
      const victimId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      if (!victimId) return
      const state = host.state as B57State
      const records = state.b57ZhongHui ??= {}
      records.deathRoundByPlayer ??= {}
      records.deathRoundByPlayer[victimId] = host.state.roundNumber
    } },
    { event: 'EnterDying', handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      const state = host.state as B57State
      const records = state.b57ZhongHui ??= {}
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-zhonghui-b57')
      if (!owner || context.event.sourceId !== ownerId || !targetId || records.awakened?.includes(ownerId)
        || !Object.values(records.deathRoundByPlayer ?? {}).some((round) => round === host.state.roundNumber)) return
      records.awakened ??= []
      records.awakened.push(ownerId)
      owner.kingdomOverride = 'qun'
      ;(records.kechangLevel ??= {})[ownerId] = 2
      host.dispatch('SkillActivated', { skillId: ZH_YUNAN, skillName: '迂难', targetIds: [targetId], awakened: true }, { sourceId: ownerId, targetId })
    } },
  ],
})

registerSkillRuntime({ id: ZH_KECHANG,
  lord: true,
  globalSlashIgnoresDistanceTo(state, ownerId, attackerId) {
    if (state.players.find((player) => player.id === ownerId)?.identity !== 'lord') return false
    const level = (state as B57State).b57ZhongHui?.kechangLevel?.[ownerId] ?? 1
    return level >= 1 && effectiveKingdomOf(state, attackerId) === 'qun'
  },
  slashUndodgeable(state, ownerId) {
    return state.players.find((player) => player.id === ownerId)?.identity === 'lord'
      && ((state as B57State).b57ZhongHui?.kechangLevel?.[ownerId] ?? 1) >= 2
  },
})

function dengAiHearts(state: SanguoshaState): CardId[] {
  return [...state.zones.drawPile, ...state.zones.discardPile]
    .filter((cardId) => state.cards[cardId]?.suit === 'heart' && !state.cards[cardId]?.virtual)
}

function dengAiTargetsForJixi(host: SkillHost, ownerId: PlayerId, targetIds: readonly PlayerId[]): PlayerId[] {
  return [...new Set(targetIds)].filter((targetId) => targetId !== ownerId
    && host.state.players.some((player) => player.id === targetId && player.alive)
    && (pickableCardsOf(host.state, targetId).cardIds.length > 0 || pickableCardsOf(host.state, targetId).hiddenCardSlots.length > 0)
    && !isTargetProhibited(host.state, ownerId, targetId, '顺手牵羊', skillIdsOf))
}

function obtainDengAiRandomHeart(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const pool = dengAiHearts(host.state)
  if (!pool.length) return
  const cardId = host.rng.pick(pool)
  const zone = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
  moveCard(host.state, cardId, zone, { kind: 'hand', playerId: targetId })
  host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: DA_TUNTIAN, sourceId: ownerId }, { sourceId: ownerId, targetId, cardIds: [cardId] })
}

function obtainDengAiTianXian(host: SkillHost, ownerId: PlayerId, spent: number): void {
  if (!skillsOf(host.state, ownerId, skillIdsOf).some((runtime) => runtime.id === DA_ZAOXIAN)) return
  for (const [threshold, cardName] of [[3, '无中生有'], [5, '无懈可击'], [7, '五谷丰登']] as const) {
    if (spent < threshold) continue
    const cardId = host.state.zones.discardPile.find((id) => host.state.cards[id]?.name === cardName)
    if (!cardId) continue
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: DA_ZAOXIAN }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
  }
}

registerSkillRuntime({ id: DA_ZAOXIAN })

registerSkillRuntime({ id: DA_TUNTIAN,
  onGameStart(host, ownerId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive)
    if (!owner) return
    owner.marks['势邓艾蓄力点'] = 0
    owner.marks['势邓艾蓄力上限'] = 0
    ;((host.state as B57State).b57DengAi ??= {}).activatedTurn ??= {}
  },
  activeActions(state, ownerId) {
    const owner = state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
    const charge = owner?.marks['势邓艾蓄力点'] ?? 0
    if (!owner || charge < 1 || (state as B57State).b57DengAi?.activatedTurn?.[ownerId] === state.turnNumber) return []
    return [{ id: `${DA_TUNTIAN}:activate`, label: `【屯田】消耗蓄力点（当前${charge}点）` }]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
    const charge = owner?.marks['势邓艾蓄力点'] ?? 0
    if (!owner || actionId !== `${DA_TUNTIAN}:activate` || charge < 1
      || (host.state as B57State).b57DengAi?.activatedTurn?.[ownerId] === host.state.turnNumber) return
    host.askSkill({ skillId: DA_TUNTIAN, ownerId, step: 'spend-charge', data: { charge }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【屯田】：选择消耗的蓄力点数', timeoutMs: 25_000, optional: false,
      options: Array.from({ length: charge }, (_, index) => ({ id: `spend-${index + 1}`, label: `消耗${index + 1}点` })),
    }) })
  },
  distanceModifier: { toOthers: 0 },
  triggers: [
    { event: 'LoseCard', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
      if (payload.playerId !== ownerId || !owner || !(payload.cardIds ?? []).some((cardId) => {
        const card = host.state.cards[cardId]
        return card && !isDamageCard(card.name, card.category)
      })) return
      const charge = Math.max(0, Math.trunc(owner.marks['势邓艾蓄力点'] ?? 0))
      const cap = Math.max(0, Math.trunc(owner.marks['势邓艾蓄力上限'] ?? 0))
      owner.marks['势邓艾蓄力点'] = Math.min(cap, charge + 1)
    } },
    { event: 'TurnStart', handle(host, ownerId) {
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
      if (!owner) return
      const charge = owner.marks['势邓艾蓄力点'] ?? 0
      const cap = owner.marks['势邓艾蓄力上限'] ?? 0
      if (charge !== cap) return
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      owner.marks['势邓艾蓄力上限'] = cap + 1
    } },
    { event: 'TargetSpecified', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      const state = host.state as B57State
      const targets = state.b57DengAi ??= {}
      targets.targetsByTurn ??= {}
      const existing = targets.targetsByTurn[ownerId]?.turnNumber === host.state.turnNumber
        ? targets.targetsByTurn[ownerId]!.targetIds : []
      targets.targetsByTurn[ownerId] = {
        turnNumber: host.state.turnNumber,
        targetIds: [...new Set([...existing, ...(payload.targetIds ?? []).filter((id) => id !== ownerId)])],
      }
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId !== ownerId) return
      const state = host.state as B57State
      if (state.b57DengAi?.targetsByTurn) delete state.b57DengAi.targetsByTurn[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'spend-charge') {
      const option = (response.payload as { optionId?: string }).optionId ?? ''
      const spent = Number(option.replace(/^spend-/u, ''))
      const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
      const charge = owner?.marks['势邓艾蓄力点'] ?? 0
      if (!owner || !Number.isInteger(spent) || spent < 1 || spent > charge) return
      owner.marks['势邓艾蓄力点'] = charge - spent
      const state = host.state as B57State
      ;((state.b57DengAi ??= {}).activatedTurn ??= {})[ownerId] = host.state.turnNumber
      host.askSkill({ skillId: DA_TUNTIAN, ownerId, step: 'targets', data: { spent }, build: (id): ChooseTargetsRequest => {
        const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
        const max = Math.min(spent, candidates.length)
        return { id, kind: 'choose-targets', playerId: ownerId, prompt: `【屯田】：至多选择${max}名角色各随机获得一张红桃牌`,
          timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 0, max }
      } })
      return
    }
    if (resolution.step !== 'targets') return
    const spent = Math.max(0, Math.trunc(Number(resolution.data.spent ?? 0)))
    const candidates = new Set(host.state.players.filter((player) => player.alive).map((player) => player.id))
    const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      .filter((targetId) => candidates.has(targetId)).slice(0, spent)
    for (const targetId of targets) obtainDengAiRandomHeart(host, ownerId, targetId)
    obtainDengAiTianXian(host, ownerId, spent)
  },
})

registerSkillRuntime({ id: DA_JIXI,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId, context) {
    const owner = host.state.players.find((player) => player.id === ownerId && player.alive && player.characterId === 'shi-dengai-b57')
    const turn = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
    const record = (host.state as B57State).b57DengAi?.targetsByTurn?.[ownerId]
    if (!owner || !turn.playerId || !record || record.turnNumber !== (turn.turnNumber ?? host.state.turnNumber)
      || !dengAiTargetsForJixi(host, ownerId, record.targetIds).length
      || (!pickableCardsOf(host.state, turn.playerId, { discarderId: ownerId }).cardIds.length
        && !pickableCardsOf(host.state, turn.playerId).hiddenCardSlots.length)) return
    host.queueSkill({ skillId: DA_JIXI, ownerId, step: 'invoke', data: { turnNumber: turn.turnNumber ?? host.state.turnNumber, activePlayerId: turn.playerId, targetIds: record.targetIds } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const activePlayerId = prompt.data.activePlayerId as PlayerId
    const targets = dengAiTargetsForJixi(host, ownerId, prompt.data.targetIds as PlayerId[])
    if (!host.state.players.some((player) => player.id === activePlayerId && player.alive) || !targets.length
      || isCardUseProhibited(host.state, ownerId, '顺手牵羊', { dyingPlayerId: null }, skillIdsOf)) return
    const pickable = pickableCardsOf(host.state, activePlayerId, { discarderId: ownerId })
    if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
    host.askSkill({ skillId: DA_JIXI, ownerId, step: 'invoke', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【急袭】：是否弃置${host.state.players.find((player) => player.id === activePlayerId)?.nickname ?? '当前回合角色'}一张牌，使用多目标【顺手牵羊】？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动急袭' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { activePlayerId: PlayerId; targetIds: PlayerId[] }
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targets = dengAiTargetsForJixi(host, ownerId, data.targetIds)
      const pickable = pickableCardsOf(host.state, data.activePlayerId, { discarderId: ownerId })
      if (!targets.length || (!pickable.cardIds.length && !pickable.hiddenCardSlots.length)
        || isCardUseProhibited(host.state, ownerId, '顺手牵羊', { dyingPlayerId: null }, skillIdsOf)) return
      host.askSkill({ skillId: DA_JIXI, ownerId, step: 'discard-card', data: { ...data, targetIds: targets }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【急袭】：选择当前回合角色一张手牌或装备牌弃置', timeoutMs: 25_000,
        optional: false, purpose: 'skill', ...pickable, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard-card') {
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selected ? resolvePickedCard(host.state, data.activePlayerId, selected) : null
      const pickable = pickableCardsOf(host.state, data.activePlayerId, { discarderId: ownerId })
      if (!cardId || !(data.targetIds as PlayerId[]).length
        || !(pickable.cardIds.includes(cardId) || host.state.players.find((player) => player.id === data.activePlayerId)?.zones.hand.includes(cardId))) return
      if (isCardProtectedFromDiscard(host.state, data.activePlayerId, cardId, ownerId)) return
      if (!discardCardsByIds(host as never, data.activePlayerId, [cardId], DA_JIXI).length) return
      const targets = dengAiTargetsForJixi(host, ownerId, data.targetIds)
      if (!targets.length) return
      host.askSkill({ skillId: DA_JIXI, ownerId, step: 'targets', data: { targetIds: targets }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【急袭】：选择其中任意名角色作为【顺手牵羊】目标',
        timeoutMs: 25_000, optional: false, candidateIds: targets, min: 1, max: targets.length,
      }) })
      return
    }
    if (resolution.step === 'targets') {
      const candidates = new Set(dengAiTargetsForJixi(host, ownerId, resolution.data.targetIds as PlayerId[]))
      const targets = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((targetId) => candidates.has(targetId))
      if (targets.length) host.beginVirtualTrick({ sourceId: ownerId, targetIds: targets, cardName: '顺手牵羊', sourceSkillId: DA_JIXI })
    }
  },
})

export const HISTORICAL_BATCH57_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'shi-xinxianying-b57', name: '势·辛宪英', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: XY_JIEJIE, name: '诫节', description: '每名角色的出牌阶段限一次，当前回合角色可以令你观看其手牌，然后你可以选择一种花色。若其手牌包含此花色，其弃置所有不为此花色的手牌，本回合使用此花色的牌无次数限制；若不包含，其从牌堆或弃牌堆获得一张此花色的牌。每轮限两次；若该角色本轮以此法令你观看的牌所包含的花色数唯一最多，你视为对其发动【清识】。' },
    { id: XY_QINGSHI, name: '清识', description: '当你受到伤害后，你可以选择一名角色，然后若你与其阵营相同，你与其各摸一张牌；不同，你弃置你与其的各一张牌。' },
  ] },
  { id: 'xuan-maoqiujian-b57', name: '玄·毌丘俭', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MQ_CUIZHEN, name: '摧阵', description: '游戏开始时，你可指定至多三名其他角色，废除其武器区。出牌阶段，你使用伤害类卡牌指定一名其他角色为目标后，若其手牌数大于等于体力值，则你可废除其武器区。摸牌阶段，你额外摸X张牌（X为场上被废除的武器区数+1，且至多为3）。' },
    { id: MQ_KUILI, name: '溃离', description: '锁定技。当你受到伤害后，若伤害来源的武器区被废除，则恢复之。' },
  ] },
  { id: 'cui-fu-b57', name: '崔芙', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CF_CAIQIU, name: '裁裘', description: '每轮开始时，你观看牌堆顶X张牌（X为游戏人数），然后可以获得其中任意张牌。其他角色本轮使用牌结算结束后，若该牌与你因此获得的牌同名，你失去1点体力。' },
    { id: CF_XISHANG, name: '袭裳', description: '锁定技，游戏开始时，你选择本局形象；当你不因摸牌而获得牌时，明置之。你的明置手牌于被其他角色选择时不可见。桂殿：有明置牌的角色结束阶段，你可令摸牌数、使用【杀】次数、手牌上限或体力值-1以发动一次【裁裘】；本局限游戏人数+1次，每有游戏人数+1张牌被明置后可令其中一项+1。东郊：每回合每项限一次，明置牌类别数至少为1/2/3时，基本牌数值+1/使用锦囊指定目标后获得一名目标角色一张牌/装备牌结算后令有明置牌角色摸两张牌。绣阁：每回合每项限一次，弃置武器/防具/防御坐骑/进攻坐骑视为使用【杀】/【闪】/【桃】/【酒】，不计次数且无次数限制，结算后获得牌堆或弃牌堆一张同花色牌；明置牌含四种花色时改为展示。' },
  ] },
  { id: 'shi-lusu-b57', name: '势·鲁肃', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SLU_HAOSHI, name: '好施', description: '结束阶段，你可以选择一名其他角色，直到你的下个回合开始，其可以如手牌般使用或打出你的手牌。然后你前两次因此失去最后的手牌时，你将手牌摸至三张。' },
    { id: SLU_DIMENG, name: '缔盟', description: '出牌阶段限一次，你可以令两名手牌数之差小于等于3的角色交换手牌，然后你选择一项：交换后手牌数较少的角色摸X张牌；弃置X张牌（不足则全弃）。X为你已损失的体力值。' },
  ] },
  { id: 'shi-chenzhi-b57', name: '势·陈祗', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SL_QUANCHONG, name: '权宠', description: '锁定技，每轮限一次，结束阶段，你弃置所有牌，执行一个额外的回合；若你体力值不为全场唯一最大，则以此法执行的回合开始时你失去1点体力。' },
    { id: SL_RENXING, name: '任行', description: '每轮限两次，每回合首次有牌不于弃牌阶段被弃置时，你可以选择一项：与当前回合角色各摸一张牌；或弃置一名本回合未使用或打出过【杀】的角色一张牌。' },
  ] },
  { id: 'shi-zhonghui-b57', name: '势·钟会', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZH_SIZI, name: '肆恣', description: '蓄力技（4/4）。出牌阶段限一次，你可以减少任意点蓄力点，然后执行以下效果，直至X个回合结束后或你的回合开始时（X为本次消减少的蓄力点数）：所有角色使用【杀】造成的伤害+1；一名角色的回合结束时，你摸两张牌且本回合使用过【杀】的角色各失去1点体力。若X大于你的体力值，额外令一名角色的回合结束时，若本回合无人使用过【杀】，当前回合角色失去1点体力。' },
    { id: ZH_XIEZHI, name: '挟志', description: '锁定技，当你的体力值变化后，你获得X点蓄力点（X为本次变化的值）。若因此获得超额蓄力点，你的手牌上限与使用【杀】的次数永久+1。' },
    { id: ZH_YUNAN, name: '迂难', description: '觉醒技，你的登场势力为魏；当你令一名角色进入濒死状态时，若本轮已有角色死亡，你将势力变更为群，然后获得或升级技能【克昌】。' },
    { id: ZH_KECHANG, name: '克昌', description: '一级：主公技，锁定技，群势力角色使用【杀】无距离限制。二级：群势力角色使用【杀】无距离限制；你使用的【杀】不可被响应。', locked: true },
  ] },
  { id: 'shi-wangchang-b57', name: '势·王昶', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WC_KAIJI, name: '开济', description: '准备阶段，你可以令至多X名角色各摸一张牌，若有角色因此获得非基本牌，你摸一张牌（X为进入过濒死状态的存活角色数且至少为1）。' },
    { id: WC_SHEPAN, name: '慑叛', description: '每轮每种牌名限一次，每回合限一次，当你成为其他角色使用伤害类卡牌的目标后，你可以摸一张牌或将其一张手牌置于牌堆顶。然后若你与其手牌数相同，则此牌对你无效。' },
  ] },
  { id: 'sp-yujin-b57', name: 'SP·于禁', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YJ_ZHENJUN, name: '镇军', description: '出牌阶段开始时，你可以交给一名其他角色一张牌，然后令其选择是否使用一张非黑色的【杀】，且此【杀】结算结束后你摸X张牌（X为此【杀】造成的伤害值+1且至多为5）；若其不执行，你可以对其或其攻击范围内的一名角色造成1点伤害。' },
  ] },
  { id: 'shi-dengai-b57', name: '势·邓艾', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: DA_TUNTIAN, name: '屯田', description: '蓄力技（0/0），你失去非伤害牌后，获得1点蓄力点；出牌阶段限一次，你可消耗任意点蓄力点，令至多等量名角色随机获得一张红桃牌；一名角色的回合开始时，若你蓄力点已满，你摸一张牌且蓄力点上限+1。' },
    { id: DA_ZAOXIAN, name: '凿险', description: '锁定技，你一次性消耗的蓄力点数量大于等于3/5/7时，你从弃牌堆获得【无中生有】/【无懈可击】/【五谷丰登】。' },
    { id: DA_JIXI, name: '急袭', description: '一名角色的回合结束时，若存在本回合成为过你牌目标的其他角色，你可弃置当前回合角色一张牌，以使用一张指定其中任意名角色为目标的无视距离【顺手牵羊】。' },
  ] },
  { id: 'shi-huanjie-b57', name: '势·桓阶', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HJ_GONGMOU, name: '共谋', description: '准备阶段，你可与一名其他角色交换手牌，然后本回合内，你获得【奇策】且其获得【看破】。' },
    { id: HJ_ZHENGSHUO, name: '正朔', description: '限定技，出牌阶段，你可令所有角色弃置所有手牌并洗牌，然后所有角色各摸四张牌。' },
  ] },
]
