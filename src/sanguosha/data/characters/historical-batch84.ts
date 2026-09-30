import type { CharacterDefinition } from './types'
import type { CardId, EquipmentSlot, PlayerId, Suit, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { effectiveCardColor, effectiveCardSuit } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseOptionsRequest, ChooseTargetsRequest, UseCardRequest } from '../../engine/requests'
import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { canTarget, getAttackRange, getDistance } from '../../engine/distance'
import { skillHandCardUseActions, skillOtherHandCardUseActions, executeUseCardAction } from '../../engine/cards/basic'
import { forceDistance } from '../../engine/distance-override'
import { clearUsedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { effectiveCardName, locateOwnedCard, moveCard, type ZoneRef } from '../../engine/zones'
import { giveCards, swapSelectedHandCards } from '../../engine/hand-transfer'
import { isCardProtectedFromDiscard, isTargetProhibited } from '../../engine/skills/runtime'
import { pickableCardsOf } from '../../engine/card-pick'
import { skillIdsOf } from './standard'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { fieldCards, fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { revealTopCards } from '../../engine/draw'
import { ABOLISHABLE_SLOTS, abolishableSlotsOf, abolishedSlotsOf, abolishSlot, equipmentSlotsOf, restoreSlot } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { recover } from '../../engine/recover'
import { discardCardsByIds } from '../../engine/discard-all'
import { equipmentSlotsForSkillUse, useEquipmentFromSkill } from '../../engine/skill-equipment-use'
import { resolveDamage } from '../../engine/damage'
import { reshuffleDrawPile } from '../../engine/deck'
import { withNextCardTargetChoices } from '../../engine/cards/basic'

const B = '-b84'
const sid = (name: string) => `${name}${B}`
const getPlayer = (state: SanguoshaState, id: PlayerId) => state.players.find((candidate) => candidate.id === id)
const turnPlayerId = (context: { event: { sourceId?: PlayerId; payload: Record<string, unknown> } }): PlayerId | undefined =>
  (context.event.payload.playerId as PlayerId | undefined) ?? context.event.sourceId
function b84(state: SanguoshaState): Record<string, any> {
  const target = state as SanguoshaState & { b84?: Record<string, any> }
  target.b84 ??= {}
  return target.b84
}
const B84_SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']

const CUI_HUASHANG = sid('huashang-cuilingyi'), CUI_YUZHI = sid('yuzhi-cuilingyi')
const MACHAO_ZHONGTAO = sid('zhongtao-weimachao'), MACHAO_JIZHAN = sid('jizhan-weimachao')
const MATIE_QUIXIAN = sid('quxian-matie'), MATIE_ZHUIJI = sid('zhuiji-matie')
const LING_SHOUHU = sid('shouhu-linglie'), LING_NINGZHUN = sid('ningzhun-linglie')
const JIANG_ZHENTING = sid('zhenting-xingjiangwan'), JIANG_CHIGUO = sid('chiguo-xingjiangwan')
const TAO_ZHIJUE = sid('zhijue-taohuang'), TAO_WEIWEI = sid('weiwei-taohuang')
const SUN_SHUREN = sid('shuren-weisunshangxiang'), SUN_SARAN = sid('saran-weisunshangxiang')
const XU_YIZHEN = sid('yizhen-mouxusheng'), XU_QINQIANG = sid('qinjiang-mouxusheng')
const LUO_JUCE = sid('juce-mouluotong'), LUO_KANGMING = sid('kangming-mouluotong')
const HUANG_QIAODUI = sid('qiaodui-mouhuangquan'), HUANG_TUICHENG = sid('tuicheng-mouhuangquan')
const huashangPileId = (ownerId: PlayerId) => `${CUI_HUASHANG}:${ownerId}`
function huashangCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return getPlayer(state, ownerId)?.characterPiles[huashangPileId(ownerId)] ?? []
}
function huashangEquipmentCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return [...Object.values(getPlayer(state, ownerId)?.zones.equipment ?? {}).filter((id): id is CardId => id !== null),
    ...huashangCards(state, ownerId)]
}
type QiaoduiRecord = { turn: number; used: boolean; repeatCardIds: CardId[] }
function qiaoduiRecord(state: SanguoshaState, ownerId: PlayerId): QiaoduiRecord {
  const records = b84(state).qiaodui ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, used: false, repeatCardIds: [] }
  return records[ownerId] as QiaoduiRecord
}
type ZhentingRecord = { turn: number; damaged: PlayerId[]; sources: PlayerId[]; discarded: CardId[] }
function zhentingRecord(state: SanguoshaState): ZhentingRecord {
  const data = b84(state)
  if (!data.zhenting || data.zhenting.turn !== state.turnNumber)
    data.zhenting = { turn: state.turnNumber, damaged: [], sources: [], discarded: [] }
  return data.zhenting as ZhentingRecord
}
type WeiweiClaim = { turn: number; cardId: CardId; sourceId: PlayerId; receivedCardId: CardId; givenCardId: CardId; prompted: boolean }
type WeiweiRecord = { turn: number; used: boolean; claims: WeiweiClaim[] }
function weiweiRecord(state: SanguoshaState, ownerId: PlayerId): WeiweiRecord {
  const records = b84(state).weiwei ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, used: false, claims: [] }
  return records[ownerId] as WeiweiRecord
}

type JizhanState = { turn: number; previousWasEquipment: boolean; uses: number; disabled: boolean }
function jizhanState(state: SanguoshaState, ownerId: PlayerId): JizhanState {
  const records = b84(state).jizhan ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, previousWasEquipment: false, uses: 0, disabled: false }
  return records[ownerId] as JizhanState
}

function askJizhanDiscard(host: SkillHost, ownerId: PlayerId, remaining: number): void {
  const choices = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    .map((player) => pickableCardsOf(host.state, player.id, { discarderId: ownerId }))
  const cardIds = [...new Set(choices.flatMap((choice) => choice.cardIds))]
  const hiddenCardSlots = choices.flatMap((choice) => choice.hiddenCardSlots)
  if (remaining <= 0 || !cardIds.length && !hiddenCardSlots.length) return
  host.askSkill({ skillId: MACHAO_JIZHAN, ownerId, step: 'discard-cards', data: { turn: host.state.turnNumber, remaining }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【极斩】：弃置其他角色的牌（还可选择${remaining}张；取消结束此项）`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds, hiddenCardSlots, min: 1, max: 1,
  }) })
}

function discardJizhanChoice(host: SkillHost, ownerId: PlayerId, selected: string): boolean {
  const hidden = /^hidden:([^:]+):(\d+)$/.exec(selected)
  if (hidden) {
    const target = getPlayer(host.state, hidden[1] as PlayerId)
    const index = Number(hidden[2])
    const cardId = target?.zones.hand[index]
    if (!target?.alive || target.id === ownerId || !cardId || isCardProtectedFromDiscard(host.state, target.id, cardId, ownerId)) return false
    return discardCardsByIds(host as never, target.id, [cardId], MACHAO_JIZHAN).length > 0
  }
  const owner = host.state.players.find((player) => player.alive && player.id !== ownerId
    && Object.values(player.zones.equipment).includes(selected as CardId)
    && !isCardProtectedFromDiscard(host.state, player.id, selected as CardId, ownerId))
  if (!owner) return false
  const slot = (Object.entries(owner.zones.equipment).find(([, id]) => id === selected)?.[0]) as EquipmentSlot | undefined
  if (!slot) return false
  const discarded = discardCardsByIds(host as never, owner.id, [selected as CardId], MACHAO_JIZHAN)
  return discarded.length > 0
}

registerSkillRuntime({
  id: MACHAO_JIZHAN,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const state = jizhanState(host.state, ownerId)
      const payload = context.event.payload as { cardId?: CardId; fromKind?: string }
      const cardId = payload.cardId
      const isBlack = Boolean(cardId && effectiveCardColor(host.state, ownerId, cardId, skillIdsOf) === 'black')
      const combo = state.previousWasEquipment && isBlack && !state.disabled
      state.previousWasEquipment = Boolean(cardId && host.state.cards[cardId]?.category === 'equipment')
      if (combo) {
        state.uses += 1
        host.queueSkill({ skillId: MACHAO_JIZHAN, ownerId, step: 'choose-mode', data: { turn: state.turn, uses: state.uses } })
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) delete b84(host.state).jizhan?.[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-mode') return
    const state = jizhanState(host.state, ownerId)
    if (!getPlayer(host.state, ownerId)?.alive || state.disabled || state.turn !== Number(prompt.data.turn)) return
    const uses = Number(prompt.data.uses)
    host.askSkill({ skillId: MACHAO_JIZHAN, ownerId, step: 'choose-mode', data: { ...prompt.data, uses }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【极斩】：选择一项', timeoutMs: 25_000, optional: false,
      options: [
        { id: 'discard', label: `弃置其他角色共计至多${uses}张牌` },
        ...host.state.players.some((player) => player.alive && player.id !== ownerId)
          ? [{ id: 'damage', label: `对一名其他角色造成${uses}点伤害（本回合极斩失效）` }] : [],
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; targetIds?: PlayerId[]; cardIds?: string[] }
    const state = jizhanState(host.state, ownerId)
    if (!getPlayer(host.state, ownerId)?.alive || state.turn !== Number(resolution.data.turn)) return
    if (resolution.step === 'choose-mode') {
      if (payload.optionId === 'discard') askJizhanDiscard(host, ownerId, Number(resolution.data.uses))
      else if (payload.optionId === 'damage') host.askSkill({ skillId: MACHAO_JIZHAN, ownerId, step: 'damage-target', data: resolution.data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【极斩】：选择一名其他角色', timeoutMs: 25_000,
        optional: false, candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'damage-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || targetId === ownerId || !getPlayer(host.state, targetId)?.alive) return
      state.disabled = true
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: Number(resolution.data.uses), nature: 'normal', sourceSkillId: MACHAO_JIZHAN })
      return
    }
    if (resolution.step === 'discard-cards') {
      const selected = payload.cardIds?.[0]
      if (!selected) return
      const discarded = discardJizhanChoice(host, ownerId, selected)
      if (discarded) askJizhanDiscard(host, ownerId, Number(resolution.data.remaining) - 1)
      else askJizhanDiscard(host, ownerId, Number(resolution.data.remaining))
    }
  },
})

export const HISTORICAL_BATCH84_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'cui-lingyi-b84', name: '崔令仪', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: CUI_HUASHANG, name: '华裳', description: '游戏开始时，将每种颜色各一张牌置入你的装备区。若你的装备区存在两种颜色，你使用牌无距离限制。你使用牌结算后，可将一张相同花色的非装备手牌置入装备区。当你的手牌数少于装备区牌的花色数时，将手牌补至等同于装备区牌的花色数。' },
    { id: CUI_YUZHI, name: '逾制', locked: true, description: '当你成为【杀】的目标时，选择一项：弃置一张装备区里的牌视为使用【闪】并失去此选项至你的回合开始；或令此【杀】伤害+1。' },
  ] },
  { id: 'wei-machao-b84', name: '威·马超', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MACHAO_ZHONGTAO, name: '众讨', description: '出牌阶段限一次，你可以选择一种花色（每有1点已损失体力可额外选择一种），然后随机从场上、弃牌堆或牌堆获得你选择花色的各一张牌。若如此做，你使用过三种类别的牌后，此技能视为未发动过。' },
    { id: MACHAO_JIZHAN, name: '极斩', description: '连招技（装备牌+黑色牌）：你选择一项：1.弃置其他角色共计至多X张牌；2.对一名其他角色造成X点伤害，然后此技能本回合失效（X为此技能本回合发动次数）。' },
  ] },
  { id: 'ma-tie-b84', name: '马铁', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MATIE_QUIXIAN, name: '驱险', description: '回合开始与结束时，你可从牌堆获得一张【杀】并选择一名其他角色。若其在其他角色的攻击范围内，这些角色依次可对其使用【杀】，每有一名角色使用【杀】你摸一张牌。然后若其未因此受到伤害，未使用【杀】的角色各失去X点体力（X为以此法使用【杀】的角色数）。' },
    { id: MATIE_ZHUIJI, name: '追击', locked: true, description: '你对其他角色使用牌结算后，本回合你计算与其的距离视为1。' },
  ] },
  { id: 'ling-lie-b84', name: '凌烈', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LING_SHOUHU, name: '狩虎', description: '出牌阶段限一次，你视为对一名其他角色使用一张【杀】。结算后本回合你与其计算距离+1；若其因此阵亡，你将手牌摸至体力上限，且以此法获得的牌无次数限制。本阶段若有角色进入你的攻击范围，此技能视为未发动过。' },
    { id: LING_NINGZHUN, name: '凝准', description: '每回合每项限一次。你本回合每使用两张牌结算后，可选择一项：攻击范围-1、攻击范围+1、移动场上一张牌。若本回合你执行了所有选项，此技能视为未发动过。' },
  ] },
  { id: 'xing-jiangwan-b84', name: '星·蒋琬', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIANG_ZHENTING, name: '镇庭', description: '一名角色的回合结束时，若本回合至少两名角色受到过伤害，你选择一项：令本回合受到伤害的一名角色回复1点体力并摸一张牌；或令本回合造成伤害的一名角色获得本回合进入弃牌堆的两张牌。' },
    { id: JIANG_CHIGUO, name: '持国', description: '出牌阶段开始时，你可以观看牌堆底三张牌。若如此做，本阶段每当你使用牌时，亮出牌堆底一张牌：若其与此牌花色相同，你为此牌增加或减少一个目标（目标数至少为一），然后将该牌置入弃牌堆；若不同，你将此牌交给其中一名目标角色。' },
  ] },
  { id: 'tao-huang-b84', name: '陶璜', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: TAO_ZHIJUE, name: '制绝', locked: true, description: '你计算与其他角色的距离-2。当你造成伤害后，若你的手牌数小于体力上限，你将手牌摸至体力上限，然后此技能失效至回合结束。' },
    { id: TAO_WEIWEI, name: '维卫', description: '每回合限一次，你成为其他角色使用牌的目标后，可与其各摸两张牌，然后交换一张手牌。此牌结算后你可使用其交给你的牌；若你交给其的牌此回合结束时仍在其手中，你可对其造成1点伤害。' },
  ] },
  { id: 'wei-sunshangxiang-b84', name: '威·孙尚香', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: SUN_SHUREN, name: '淑任', description: '出牌阶段限一次，你可废除一个装备栏，亮出牌堆顶三张牌并获得其中一张，可令一名其他角色获得其中一张。若该栏原有牌，此技能视为未发动过并回复1点体力。' },
    { id: SUN_SARAN, name: '飒然', description: '你的装备区每有一张牌，你出牌阶段使用【杀】的次数上限+1。你受到或造成1点伤害后，从牌堆或弃牌堆随机使用一张装备牌；若有废除的装备栏，可先选择一个装备栏恢复。' },
  ] },
  { id: 'mou-xusheng-b84', name: '谋·徐盛', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XU_YIZHEN, name: '疑阵', description: '当你受到伤害后，你可以与伤害来源互相观看手牌，然后各弃置其中一张牌；若这两张牌颜色相同，你获得之。' },
    { id: XU_QINQIANG, name: '勤强', description: '每回合每项限一次，你使用手牌时，可选择一项：令此牌伤害+X；或摸X张牌（X为你本回合当前与此牌连续使用的同颜色牌数）。' },
  ] },
  { id: 'mou-luotong-b84', name: '谋·骆统', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: LUO_JUCE, name: '举策', description: '你于回合内第一次使用基本牌或普通锦囊牌指定目标时，可多选择一个目标。若如此做，该角色下回合使用的首张基本牌或普通锦囊牌须额外指定你为目标。' },
    { id: LUO_KANGMING, name: '抗明', description: '以你为目标的牌结算后，你摸一张牌并选择一项：展示一张本回合未展示过的【杀】或普通锦囊牌视为对使用者使用；或再摸三张牌且此技能失效至你的回合开始（若为你的回合则至回合结束）。' },
  ] },
  { id: 'mou-huangquan-b84', name: '谋·黄权', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HUANG_QIAODUI, name: '巧对', description: '每回合限一次，你使用牌指定其他角色为目标/成为其他角色使用牌的目标后，可交给一名其他角色至多两张牌，令此牌额外结算一次/失效。' },
    { id: HUANG_TUICHENG, name: '推诚', locked: true, description: '锁定技，你交给其他角色牌后，该角色须交给你等量张牌（不能选择你本回合交给其的牌），否则你摸等量张牌。' },
  ] },
]

registerSkillRuntime({
  id: JIANG_ZHENTING,
  triggers: [
    { event: 'DamageSettled', handle(host, _ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      const targetId = context.event.targetId
      const sourceId = context.event.sourceId
      if (Number(payload.finalAmount ?? 0) < 1 || !targetId) return
      const record = zhentingRecord(host.state)
      if (!record.damaged.includes(targetId)) record.damaged.push(targetId)
      if (sourceId && !record.sources.includes(sourceId)) record.sources.push(sourceId)
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
      const record = zhentingRecord(host.state)
      if (!record.discarded.includes(cardId)) record.discarded.push(cardId)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const record = zhentingRecord(host.state)
      const turn = Number((context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber)
      if (record.turn !== turn || record.damaged.length < 2 || !getPlayer(host.state, ownerId)?.alive) return
      const canRecover = record.damaged.some((id) => getPlayer(host.state, id)?.alive)
      const availableDiscarded = record.discarded.filter((id) => host.state.zones.discardPile.includes(id))
      const canGain = availableDiscarded.length >= 2 && record.sources.some((id) => getPlayer(host.state, id)?.alive)
      if (!canRecover && !canGain) return
      host.queueSkill({ skillId: JIANG_ZHENTING, ownerId, step: 'choose-mode', data: { turn } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose-mode') return
    const owner = getPlayer(host.state, ownerId)
    const record = zhentingRecord(host.state)
    if (!owner?.alive || record.turn !== Number(prompt.data.turn) || record.damaged.length < 2) return
    const options = [
      ...(record.damaged.some((id) => getPlayer(host.state, id)?.alive) ? [{ id: 'recover', label: '令一名本回合受到过伤害的角色回复1点体力并摸一张牌' }] : []),
      ...(record.discarded.filter((id) => host.state.zones.discardPile.includes(id)).length >= 2
        && record.sources.some((id) => getPlayer(host.state, id)?.alive)
        ? [{ id: 'gain', label: '令一名本回合造成过伤害的角色获得本回合进入弃牌堆的两张牌' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: JIANG_ZHENTING, ownerId, step: 'choose-mode', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【镇庭】：选择一项', timeoutMs: 25_000,
      optional: true, options: [...options, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; targetIds?: PlayerId[]; cardIds?: CardId[] }
    const record = zhentingRecord(host.state)
    if (record.turn !== Number(resolution.data.turn) || !getPlayer(host.state, ownerId)?.alive) return
    if (resolution.step === 'choose-mode') {
      if (payload.optionId === 'recover') {
        const candidates = record.damaged.filter((id) => getPlayer(host.state, id)?.alive)
        if (!candidates.length) return
        host.askSkill({ skillId: JIANG_ZHENTING, ownerId, step: 'recover-target', data: resolution.data, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇庭】：选择本回合受到过伤害的一名角色', timeoutMs: 25_000,
          optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
      } else if (payload.optionId === 'gain') {
        const candidates = record.sources.filter((id) => getPlayer(host.state, id)?.alive)
        const cards = record.discarded.filter((id) => host.state.zones.discardPile.includes(id))
        if (!candidates.length || cards.length < 2) return
        host.askSkill({ skillId: JIANG_ZHENTING, ownerId, step: 'gain-target', data: resolution.data, build: (id): ChooseTargetsRequest => ({
          id, kind: 'choose-targets', playerId: ownerId, prompt: '【镇庭】：选择本回合造成过伤害的一名角色', timeoutMs: 25_000,
          optional: false, candidateIds: candidates, min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'recover-target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || !record.damaged.includes(targetId) || !getPlayer(host.state, targetId)?.alive) return
      recover(host as never, targetId, 1, ownerId)
      drawCards(host.state, host.rng, targetId, 1, (name, data) => host.dispatch(name, data))
      return
    }
    if (resolution.step === 'gain-target') {
      const targetId = payload.targetIds?.[0]
      const cards = record.discarded.filter((id) => host.state.zones.discardPile.includes(id))
      if (!targetId || !record.sources.includes(targetId) || !getPlayer(host.state, targetId)?.alive || cards.length < 2) return
      host.askSkill({ skillId: JIANG_ZHENTING, ownerId, step: 'gain-cards', data: { turn: resolution.data.turn, targetId, candidates: cards }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【镇庭】：选择交给${getPlayer(host.state, targetId)!.nickname}的两张牌`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 2, max: 2,
      }) })
      return
    }
    if (resolution.step === 'gain-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const chosen = payload.cardIds ?? []
      if (!record.sources.includes(targetId) || !getPlayer(host.state, targetId)?.alive || chosen.length !== 2
        || new Set(chosen).size !== 2 || chosen.some((id) => !record.discarded.includes(id) || !host.state.zones.discardPile.includes(id))) return
      for (const cardId of chosen) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: chosen, reason: JIANG_ZHENTING }, { sourceId: ownerId, targetId, cardIds: chosen })
    }
  },
})

registerSkillRuntime({
  id: CUI_HUASHANG,
  onGameStart(host, ownerId) {
    const owner = getPlayer(host.state, ownerId)
    if (!owner?.alive || huashangCards(host.state, ownerId).length) return
    const pile = huashangPileId(ownerId)
    for (const color of ['red', 'black'] as const) {
      const candidates = host.state.zones.drawPile.filter((cardId) => effectiveCardColor(host.state, ownerId, cardId) === color)
      if (!candidates.length) continue
      const cardId = host.rng.pick(candidates)
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: ownerId, pile })
    }
  },
  ignoresDistanceTo(state, ownerId) {
    const colors = new Set(huashangCards(state, ownerId).map((cardId) => effectiveCardColor(state, ownerId, cardId)).filter(Boolean))
    return colors.has('red') && colors.has('black')
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const owner = getPlayer(host.state, ownerId)
    if (context.event.sourceId !== ownerId || !owner?.alive) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const suit = cardId ? effectiveCardSuit(host.state, ownerId, cardId) : null
    if (!suit) return
    const matchingHand = owner.zones.hand.filter((id) => effectiveCardSuit(host.state, ownerId, id) === suit
      && host.state.cards[id]?.category !== 'equipment')
    if (matchingHand.length) host.queueSkill({ skillId: CUI_HUASHANG, ownerId, step: 'place-card', data: { suit } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'place-card') return
    const owner = getPlayer(host.state, ownerId)
    const suit = prompt.data.suit as Suit
    const cards = owner?.zones.hand.filter((id) => effectiveCardSuit(host.state, ownerId, id) === suit
      && host.state.cards[id]?.category !== 'equipment') ?? []
    if (!owner?.alive || !cards.length) return
    host.askSkill({ skillId: CUI_HUASHANG, ownerId, step: 'place-card', data: { suit }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【华裳】：可将一张与刚使用牌花色相同的非装备手牌置入装备区',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'place-card') return
    const owner = getPlayer(host.state, ownerId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const suit = resolution.data.suit as Suit
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || effectiveCardSuit(host.state, ownerId, cardId) !== suit
      || host.state.cards[cardId]?.category === 'equipment') return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: huashangPileId(ownerId) })
    const equipSuits = new Set(huashangCards(host.state, ownerId).map((id) => effectiveCardSuit(host.state, ownerId, id)).filter(Boolean))
    if (owner.zones.hand.length < equipSuits.size)
      drawCards(host.state, host.rng, ownerId, equipSuits.size - owner.zones.hand.length, (name, data) => host.dispatch(name, data))
  },
})

registerSkillRuntime({
  id: CUI_YUZHI,
  viewAs(state, ownerId) {
    const currentCardId = state.cardResolution?.cardId
    if (!currentCardId || b84(state).yuzhiDodgeCard?.[ownerId] !== currentCardId) return []
    const owner = getPlayer(state, ownerId)
    if (!owner?.alive) return []
    return huashangEquipmentCards(state, ownerId)
      .map((cardId) => ({ asCardName: '闪', cardId, label: '【逾制】：将此装备牌当【闪】使用' }))
  },
  globalOutgoingDamage(state, ownerId, sourceId, context) {
    const binding = context.cardId ? b84(state).yuzhiBonus?.[context.cardId] : undefined
    return binding?.ownerId === ownerId && binding.sourceId === sourceId
      ? { amount: context.amount + 1 }
      : null
  },
  interceptTarget(host, ownerId, context) {
    const owner = getPlayer(host.state, ownerId)
    if (context.targetId !== ownerId || context.cardName !== '杀' || !owner?.alive) return false
    const availableDodge = huashangEquipmentCards(host.state, ownerId).length > 0
      && !b84(host.state).yuzhiDodgeUnavailableUntilTurn?.[ownerId]
    const options = [
      ...(availableDodge ? [{ id: 'dodge', label: '弃置一张装备牌视为使用【闪】（直到你的回合开始前不可再选此项）' }] : []),
      { id: 'damage', label: '令此【杀】伤害+1' },
    ]
    host.askSkill({ skillId: CUI_YUZHI, ownerId, step: 'choose-effect', data: { cardId: context.cardId, sourceId: context.sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【逾制】：选择一项', timeoutMs: 25_000, optional: false, options,
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-effect') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const cardId = resolution.data.cardId as CardId
    const sourceId = resolution.data.sourceId as PlayerId
    if (optionId === 'dodge') {
      const owner = getPlayer(host.state, ownerId)
      if (owner && huashangEquipmentCards(host.state, ownerId).length > 0
        && !b84(host.state).yuzhiDodgeUnavailableUntilTurn?.[ownerId]) {
        b84(host.state).yuzhiDodgeUnavailableUntilTurn ??= {}
        b84(host.state).yuzhiDodgeUnavailableUntilTurn[ownerId] = true
        b84(host.state).yuzhiDodgeCard ??= {}
        b84(host.state).yuzhiDodgeCard[ownerId] = cardId
      }
    } else if (optionId === 'damage') {
      b84(host.state).yuzhiBonus ??= {}
      b84(host.state).yuzhiBonus[cardId] = { ownerId, sourceId }
    }
    host.resumeCardTarget()
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) delete b84(host.state).yuzhiDodgeUnavailableUntilTurn?.[ownerId]
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const slashCardId = (context.event.payload as { slashCardId?: CardId }).slashCardId
      if (slashCardId && b84(host.state).yuzhiDodgeCard?.[ownerId] === slashCardId) delete b84(host.state).yuzhiDodgeCard[ownerId]
    } },
    { event: 'CardResolved', handle(host, _ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId && b84(host.state).yuzhiBonus) delete b84(host.state).yuzhiBonus[cardId]
    } },
  ],
})

type LocatedB84Card = { cardId: CardId; zone: ZoneRef }
function zhongtaoCandidates(state: SanguoshaState, suit: Suit): LocatedB84Card[] {
  const found = new Map<CardId, ZoneRef>()
  for (const owner of state.players) {
    if (!owner.alive) continue
    for (const cardId of [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => id !== null), ...owner.zones.judgingArea]) {
      const zone = locateOwnedCard(state, owner.id, cardId)
      if (zone && state.cards[cardId]?.suit === suit) found.set(cardId, zone)
    }
  }
  for (const cardId of [...state.zones.discardPile, ...state.zones.drawPile]) {
    if (state.cards[cardId]?.suit === suit) found.set(cardId,
      state.zones.discardPile.includes(cardId) ? { kind: 'discardPile' } : { kind: 'drawPile' })
  }
  return [...found].map(([cardId, zone]) => ({ cardId, zone }))
}

registerSkillRuntime({
  id: MACHAO_ZHONGTAO,
  activeActions(state, ownerId) {
    const owner = getPlayer(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play' && !usedThisPhase(state, ownerId, MACHAO_ZHONGTAO)
      ? [{ id: `${MACHAO_ZHONGTAO}:activate`, label: '众讨：选择花色获得场上、弃牌堆或牌堆中的牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    const owner = getPlayer(host.state, ownerId)
    if (actionId !== `${MACHAO_ZHONGTAO}:activate` || !owner?.alive || host.state.currentPlayerId !== ownerId
      || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, MACHAO_ZHONGTAO)) return
    host.askSkill({ skillId: MACHAO_ZHONGTAO, ownerId, step: 'choose-suits', data: {}, build: (id): ChooseOptionsRequest => ({
      id, kind: 'choose-options', playerId: ownerId, prompt: '【众讨】：选择一种或多种花色（每点已损失体力额外选择一种）',
      timeoutMs: 25_000, optional: false, options: B84_SUITS.map((suit) => ({ id: suit, label: suit === 'spade' ? '♠ 黑桃' : suit === 'heart' ? '♥ 红桃' : suit === 'club' ? '♣ 梅花' : '♦ 方块' })),
      min: 1, max: Math.min(B84_SUITS.length, 1 + owner.maxHp - owner.hp),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-suits') return
    const owner = getPlayer(host.state, ownerId)
    const suits = (response.payload as { optionIds?: string[] }).optionIds ?? []
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId || usedThisPhase(host.state, ownerId, MACHAO_ZHONGTAO)
      || suits.length < 1 || suits.length > 1 + owner.maxHp - owner.hp || new Set(suits).size !== suits.length
      || suits.some((suit) => !B84_SUITS.includes(suit as Suit))) return
    markUsedThisPhase(host.state, ownerId, MACHAO_ZHONGTAO)
    b84(host.state).zhongtaoCategories ??= {}
    b84(host.state).zhongtaoCategories[ownerId] = []
    const gained: CardId[] = []
    for (const suit of suits as Suit[]) {
      const candidates = zhongtaoCandidates(host.state, suit)
      if (!candidates.length) continue
      const selected = host.rng.pick(candidates)
      moveCard(host.state, selected.cardId, selected.zone, { kind: 'hand', playerId: ownerId })
      gained.push(selected.cardId)
    }
    if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: MACHAO_ZHONGTAO }, { targetId: ownerId, cardIds: gained })
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || !usedThisPhase(host.state, ownerId, MACHAO_ZHONGTAO)) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    const category = cardId ? host.state.cards[cardId]?.category : undefined
    if (!category) return
    const categories = (b84(host.state).zhongtaoCategories[ownerId] ??= []) as string[]
    if (!categories.includes(category)) categories.push(category)
    if (new Set(categories).size >= 3) {
      clearUsedThisPhase(host.state, ownerId, MACHAO_ZHONGTAO)
      delete b84(host.state).zhongtaoCategories[ownerId]
    }
  } }],
})

registerSkillRuntime({
  id: TAO_ZHIJUE,
  distanceModifier: { toOthers: (state, ownerId) => b84(state).taoZhijueDisabled?.[ownerId] ? 0 : -2 },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const owner = getPlayer(host.state, ownerId)
      const { finalAmount = 0 } = context.event.payload as { finalAmount?: number }
      if (context.event.sourceId !== ownerId || !owner?.alive || owner.zones.hand.length >= owner.maxHp
        || finalAmount < 1 || b84(host.state).taoZhijueDisabled?.[ownerId]) return
      b84(host.state).taoZhijueDisabled ??= {}
      b84(host.state).taoZhijueDisabled[ownerId] = true
      drawCards(host.state, host.rng, ownerId, owner.maxHp - owner.zones.hand.length, (name, data) => host.dispatch(name, data))
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      if (b84(host.state).taoZhijueDisabled?.[ownerId]) delete b84(host.state).taoZhijueDisabled[ownerId]
    } },
  ],
})

registerSkillRuntime({
  id: TAO_WEIWEI,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const record = weiweiRecord(host.state, ownerId)
      const claim = record.claims.find((entry) => entry.cardId === cardId && !entry.prompted)
      const owner = getPlayer(host.state, ownerId)
      if (!claim || !owner?.alive || !owner.zones.hand.includes(claim.receivedCardId)) return
      claim.prompted = true
      const actions = skillHandCardUseActions(host.state, ownerId, claim.receivedCardId)
      if (actions.length) host.queueSkill({ skillId: TAO_WEIWEI, ownerId, step: 'use-received-card', data: {
        cardId: claim.cardId, sourceId: claim.sourceId, receivedCardId: claim.receivedCardId,
        actionIds: actions.map(({ id }) => id),
      } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const record = weiweiRecord(host.state, ownerId)
      const turn = Number((context.event.payload as { turnNumber?: number }).turnNumber ?? host.state.turnNumber)
      const claim = record.claims.find((entry) => entry.turn === turn && getPlayer(host.state, entry.sourceId)?.alive
        && getPlayer(host.state, entry.sourceId)?.zones.hand.includes(entry.givenCardId))
      if (record.turn === turn && getPlayer(host.state, ownerId)?.alive && claim)
        host.queueSkill({ skillId: TAO_WEIWEI, ownerId, step: 'damage-offer', data: { sourceId: claim.sourceId, givenCardId: claim.givenCardId, turn } })
    } },
  ],
  interceptTarget(host, ownerId, context) {
    const record = weiweiRecord(host.state, ownerId)
    const owner = getPlayer(host.state, ownerId), source = getPlayer(host.state, context.sourceId)
    if (context.targetId !== ownerId || context.sourceId === ownerId || !owner?.alive || !source?.alive || record.used) return false
    host.askSkill({ skillId: TAO_WEIWEI, ownerId, step: 'invoke', data: { cardId: context.cardId, sourceId: context.sourceId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【维卫】：是否与${source.nickname}各摸两张牌并交换一张手牌？`, timeoutMs: 25_000, optional: true,
        options: [{ id: 'yes', label: '摸牌并交换手牌' }, { id: 'no', label: '不发动' }],
      }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'use-received-card') {
      const cardId = prompt.data.receivedCardId as CardId
      const actions = skillHandCardUseActions(host.state, ownerId, cardId).filter((action) =>
        (prompt.data.actionIds as string[]).includes(action.id))
      if (!actions.length) return
      host.askSkill({ skillId: TAO_WEIWEI, ownerId, step: 'use-received-card', data: prompt.data, build: (id): UseCardRequest => ({
        id, kind: 'use-card', playerId: ownerId, prompt: '【维卫】：可使用你交换得到的手牌', timeoutMs: 25_000,
        optional: true, actionIds: actions.map(({ id: actionId }) => actionId),
      }) })
    } else if (prompt.step === 'damage-offer') {
      const source = getPlayer(host.state, prompt.data.sourceId as PlayerId)
      if (!source?.alive || !source.zones.hand.includes(prompt.data.givenCardId as CardId)) return
      host.askSkill({ skillId: TAO_WEIWEI, ownerId, step: 'damage-offer', data: prompt.data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【维卫】：${source.nickname}仍持有你交给其的牌，是否对其造成1点伤害？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '造成1点伤害' }, { id: 'no', label: '不造成伤害' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[]; actionId?: string }
    const record = weiweiRecord(host.state, ownerId)
    if (resolution.step === 'invoke') {
      const sourceId = resolution.data.sourceId as PlayerId
      const owner = getPlayer(host.state, ownerId), source = getPlayer(host.state, sourceId)
      if (payload.optionId !== 'yes' || !owner?.alive || !source?.alive || record.used) { host.resumeCardTarget(); return }
      record.used = true
      drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      drawCards(host.state, host.rng, sourceId, 2, (name, data) => host.dispatch(name, data))
      const left = getPlayer(host.state, ownerId), right = getPlayer(host.state, sourceId)
      if (!left?.zones.hand.length || !right?.zones.hand.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: TAO_WEIWEI, ownerId, step: 'choose-left-card', data: resolution.data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【维卫】：选择一张手牌与${right.nickname}交换`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...left.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-left-card') {
      const sourceId = resolution.data.sourceId as PlayerId
      const ownerCardId = payload.cardIds?.[0]
      const owner = getPlayer(host.state, ownerId), source = getPlayer(host.state, sourceId)
      if (!owner?.alive || !source?.alive || !ownerCardId || !owner.zones.hand.includes(ownerCardId) || !source.zones.hand.length) {
        host.resumeCardTarget(); return
      }
      host.askSkill({ skillId: TAO_WEIWEI, ownerId, step: 'choose-right-card', data: { ...resolution.data, ownerCardId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: sourceId, prompt: `【维卫】：选择一张手牌与${owner.nickname}交换`, timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-right-card') {
      const sourceId = resolution.data.sourceId as PlayerId
      const ownerCardId = resolution.data.ownerCardId as CardId
      const sourceCardId = payload.cardIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!sourceCardId || !swapSelectedHandCards(host as never, ownerId, sourceId, ownerCardId, sourceCardId, TAO_WEIWEI)) {
        host.resumeCardTarget(); return
      }
      record.claims.push({ turn: host.state.turnNumber, cardId, sourceId, receivedCardId: sourceCardId, givenCardId: ownerCardId, prompted: false })
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'use-received-card') {
      const actionId = payload.actionId
      if (!actionId) return
      const cardId = resolution.data.receivedCardId as CardId
      const action = skillHandCardUseActions(host.state, ownerId, cardId).find((candidate) => candidate.id === actionId)
      if (action && (resolution.data.actionIds as string[]).includes(action.id)) executeUseCardAction(host as never, ownerId, action)
      return
    }
    if (resolution.step === 'damage-offer' && payload.optionId === 'yes') {
      const sourceId = resolution.data.sourceId as PlayerId
      const givenCardId = resolution.data.givenCardId as CardId
      if (getPlayer(host.state, ownerId)?.alive && getPlayer(host.state, sourceId)?.alive
        && getPlayer(host.state, sourceId)?.zones.hand.includes(givenCardId))
        resolveDamage(host as never, { sourceId: ownerId, targetId: sourceId, amount: 1, nature: 'normal', cardName: null })
    }
  },
})

registerSkillRuntime({
  id: MATIE_ZHUIJI,
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const payload = context.event.payload as { targetIds?: PlayerId[] }
    for (const targetId of payload.targetIds ?? []) {
      if (targetId !== ownerId && getPlayer(host.state, targetId)?.alive)
        forceDistance(host.state, { fromId: ownerId, toId: targetId, distance: 1, sourceSkillId: MATIE_ZHUIJI })
    }
  } }],
})

function shouhuState(state: SanguoshaState): Record<string, any> {
  return b84(state).shouhu ??= { distance: {}, freeCards: {}, rangeSnapshot: {} }
}
function refreshShouhuRange(state: SanguoshaState, ownerId: PlayerId, clearOnEntry = true): void {
  const current = state.players.filter((target) => target.alive && target.id !== ownerId
    && canTarget(state, ownerId, target.id)).map(({ id }) => id)
  const previous = shouhuState(state).rangeSnapshot[ownerId] as PlayerId[] | undefined
  if (clearOnEntry && previous && current.some((id) => !previous.includes(id))) clearUsedThisPhase(state, ownerId, LING_SHOUHU)
  shouhuState(state).rangeSnapshot[ownerId] = current
}
registerSkillRuntime({
  id: LING_SHOUHU,
  globalDistanceModifier(state, _ownerId, fromId, toId) {
    return shouhuState(state).distance?.[fromId]?.[toId] ? 1 : 0
  },
  unlimitedCardUses(state, ownerId, cardId) {
    const record = shouhuState(state).freeCards?.[ownerId]
    return Boolean(cardId && record?.turn === state.turnNumber && record.cardIds.includes(cardId))
  },
  activeActions(state, ownerId) {
    const owner = getPlayer(state, ownerId)
    return owner?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && !usedThisPhase(state, ownerId, LING_SHOUHU)
      ? [{ id: `${LING_SHOUHU}:activate`, label: '狩虎：视为对一名角色使用【杀】' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${LING_SHOUHU}:activate` || !getPlayer(host.state, ownerId)?.alive
      || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play' || usedThisPhase(host.state, ownerId, LING_SHOUHU)) return
    const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId
      && canTarget(host.state, ownerId, target.id)
      && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf)).map(({ id }) => id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: LING_SHOUHU, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【狩虎】：选择【杀】的目标', timeoutMs: 25_000,
      optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      refreshShouhuRange(host.state, ownerId, false)
    } },
    ...(['CardZoneMoved', 'FieldCardMoved', 'SeatOrderChanged', 'Death', 'CardResolved', 'CardUsed', 'DamageSettled',
      'Recover', 'HpSet', 'MaxHpChange', 'GeneralSlotChanged', 'HealthColorChanged', 'LoseEquipment',
      'EquipmentLossSettled', 'GainCard', 'LoseCard', 'CharacterFlip', 'ConversionStateToggled'] as const).map((event) => ({
      event, handle(host: SkillHost, ownerId: PlayerId) {
        if (host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
        refreshShouhuRange(host.state, ownerId)
      },
    })),
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || context.event.sourceSkillId !== LING_SHOUHU) return
      const targetIds = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const pairs = shouhuState(host.state).distance
      for (const targetId of targetIds) if (targetId !== ownerId && getPlayer(host.state, targetId)?.alive) {
        pairs[ownerId] ??= {}; pairs[targetId] ??= {}
        pairs[ownerId][targetId] = true; pairs[targetId][ownerId] = true
      }
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const resolution = host.state.cardResolution
      const cardId = resolution?.cardId
      const sourceSkillId = cardId ? host.state.cardUseSourceSkills?.[cardId] ?? host.state.cards[cardId]?.sourceSkillId : undefined
      const owner = getPlayer(host.state, ownerId)
      const resolutionTargetId = resolution && 'targetId' in resolution ? resolution.targetId : undefined
      if (!owner?.alive || !targetId || context.event.sourceId !== ownerId || resolutionTargetId !== targetId
        || sourceSkillId !== LING_SHOUHU) return
      const drawn = drawCards(host.state, host.rng, ownerId, Math.max(0, owner.maxHp - owner.zones.hand.length), (name, data) => host.dispatch(name, data)) as CardId[]
      if (drawn.length) shouhuState(host.state).freeCards[ownerId] = { turn: host.state.turnNumber, cardIds: drawn }
      clearUsedThisPhase(host.state, ownerId, LING_SHOUHU)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const record = shouhuState(host.state).freeCards?.[ownerId]
      if (cardId && record) record.cardIds = record.cardIds.filter((id: CardId) => id !== cardId)
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (turnPlayerId(context) !== ownerId) return
      delete shouhuState(host.state).distance[ownerId]
      for (const byOwner of Object.values(shouhuState(host.state).distance) as Array<Record<string, boolean>>)
        delete byOwner[ownerId]
      delete shouhuState(host.state).freeCards[ownerId]
      delete shouhuState(host.state).rangeSnapshot[ownerId]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !getPlayer(host.state, ownerId)?.alive || !getPlayer(host.state, targetId)?.alive
      || !canTarget(host.state, ownerId, targetId) || isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf)) return
    if (host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: LING_SHOUHU }))
      markUsedThisPhase(host.state, ownerId, LING_SHOUHU)
  },
})

type NingzhunRecord = { turn: number; resolved: number; range: number; used: string[]; pending: boolean }
function ningzhunRecord(state: SanguoshaState, ownerId: PlayerId): NingzhunRecord {
  const records = b84(state).ningzhun ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, resolved: 0, range: 0, used: [], pending: false }
  return records[ownerId] as NingzhunRecord
}
function ningzhunOptions(state: SanguoshaState, used: string[]) {
  return [
    ...(!used.includes('minus') ? [{ id: 'minus', label: '攻击范围-1' }] : []),
    ...(!used.includes('plus') ? [{ id: 'plus', label: '攻击范围+1' }] : []),
    ...(!used.includes('move') && fieldCards(state).some(({ cardId }) => fieldMoveDestinations(state, cardId).length)
      ? [{ id: 'move', label: '移动场上一张牌' }] : []),
  ]
}
registerSkillRuntime({
  id: LING_NINGZHUN,
  attackRangeBonus(state, ownerId) { return ningzhunRecord(state, ownerId).range },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) {
        b84(host.state).ningzhun ??= {}
        b84(host.state).ningzhun[ownerId] = { turn: host.state.turnNumber, resolved: 0, range: 0, used: [], pending: false }
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName && DELAYED_TRICKS.has(payload.cardName)) return
      const record = ningzhunRecord(host.state, ownerId)
      record.resolved += 1
      if (record.resolved % 2 !== 0 || record.pending || !ningzhunOptions(host.state, record.used).length) return
      record.pending = true
      host.queueSkill({ skillId: LING_NINGZHUN, ownerId, step: 'choose', data: {} })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) delete b84(host.state).ningzhun[ownerId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const record = ningzhunRecord(host.state, ownerId)
    const options = ningzhunOptions(host.state, record.used)
    if (!options.length) { record.pending = false; return }
    host.askSkill({ skillId: LING_NINGZHUN, ownerId, step: 'choose', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【凝准】：选择一项', timeoutMs: 25_000, optional: true,
      options: [...options, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const record = ningzhunRecord(host.state, ownerId)
    if (resolution.step === 'choose') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId || optionId === 'no') { record.pending = false; return }
      if (optionId === 'minus' || optionId === 'plus') {
        if (record.used.includes(optionId)) { record.pending = false; return }
        record.range += optionId === 'plus' ? 1 : -1
        record.used.push(optionId)
        record.pending = false
        refreshShouhuRange(host.state, ownerId)
      } else if (optionId === 'move') {
        const cards = fieldCards(host.state).filter(({ cardId }) => fieldMoveDestinations(host.state, cardId).length)
        if (!cards.length || record.used.includes('move')) { record.pending = false; return }
        host.askSkill({ skillId: LING_NINGZHUN, ownerId, step: 'field-card', data: {}, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【凝准】：选择一张场上牌移动', timeoutMs: 25_000,
          optional: false, purpose: 'skill', cardIds: cards.map(({ cardId }) => cardId), hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      if (record.used.length === 3) record.used = []
      return
    }
    if (resolution.step === 'field-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !fieldCards(host.state).some((entry) => entry.cardId === cardId)
        || !fieldMoveDestinations(host.state, cardId).length) { record.pending = false; return }
      const destinationIds = fieldMoveDestinations(host.state, cardId)
      host.askSkill({ skillId: LING_NINGZHUN, ownerId, step: 'destination', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【凝准】：选择场上牌移动至的角色', timeoutMs: 25_000,
        optional: false, candidateIds: destinationIds, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'destination') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !fieldMoveDestinations(host.state, cardId).includes(targetId)) { record.pending = false; return }
      moveFieldCard(host as never, cardId, targetId)
      if (!record.used.includes('move')) record.used.push('move')
      record.pending = false
      if (record.used.length === 3) record.used = []
    }
  },
})

type QuxianFlow = { targetId: PlayerId; actors: PlayerId[]; index: number; used: PlayerId[]; usedCount: number; damaged: boolean; penalties: PlayerId[]; penaltyIndex: number }
function quxianFlow(state: SanguoshaState, ownerId: PlayerId): QuxianFlow | undefined {
  return b84(state).quxianFlow?.[ownerId] as QuxianFlow | undefined
}
function setQuxianFlow(state: SanguoshaState, ownerId: PlayerId, flow: QuxianFlow | undefined): void {
  b84(state).quxianFlow ??= {}
  if (flow) b84(state).quxianFlow[ownerId] = flow
  else delete b84(state).quxianFlow[ownerId]
}
function quxianActors(state: SanguoshaState, targetId: PlayerId): PlayerId[] {
  const target = getPlayer(state, targetId)
  if (!target) return []
  const alive = state.players.filter((candidate) => candidate.alive).sort((left, right) => left.seat - right.seat)
  const startSeat = getPlayer(state, state.currentPlayerId ?? '')?.seat ?? target.seat
  const ordered = [...alive].sort((left, right) => ((left.seat - startSeat + state.players.length) % state.players.length)
    - ((right.seat - startSeat + state.players.length) % state.players.length))
  return ordered.filter((candidate) => candidate.id !== targetId && getDistance(state, candidate.id, targetId) <= getAttackRange(state, candidate.id))
    .map((candidate) => candidate.id)
}
function askQuxianStart(host: SkillHost, ownerId: PlayerId, timing: 'start' | 'end'): void {
  const owner = getPlayer(host.state, ownerId)
  if (!owner?.alive || !host.state.zones.drawPile.some((cardId) => host.state.cards[cardId]?.name === '杀')) return
  host.askSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'activate', data: { timing }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【驱险】：是否于回合${timing === 'start' ? '开始' : '结束'}发动？`,
    timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '获得牌并选择目标' }, { id: 'no', label: '不发动' }],
  }) })
}
function askQuxianTarget(host: SkillHost, ownerId: PlayerId): void {
  const targets = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
  if (!targets.length) return
  host.askSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'target', data: {}, build: (id) => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【驱险】：选择一名其他角色作为目标', timeoutMs: 25_000,
    optional: false, candidateIds: targets, min: 1, max: 1,
  }) })
}
function quxianUseActions(state: SanguoshaState, actorId: PlayerId, targetId: PlayerId): Array<Extract<LegalAction, { kind: 'use-card' }>> {
  const actor = getPlayer(state, actorId)
  if (!actor?.alive || getDistance(state, actorId, targetId) > getAttackRange(state, actorId)) return []
  return actor.zones.hand.flatMap((cardId) => state.cards[cardId]?.name === '杀'
    ? skillOtherHandCardUseActions(state, actorId, actorId, cardId, '杀', MATIE_QUIXIAN, undefined, { allowSelf: true })
      .filter((action) => action.targetIds.length === 1 && action.targetIds[0] === targetId)
    : [])
}
function finishQuxianActors(host: SkillHost, ownerId: PlayerId): void {
  const flow = quxianFlow(host.state, ownerId)
  if (!flow) return
  if (flow.damaged || flow.usedCount === 0) { setQuxianFlow(host.state, ownerId, undefined); return }
  flow.penalties = flow.actors.filter((actorId) => !flow.used.includes(actorId))
  flow.penaltyIndex = 0
  setQuxianFlow(host.state, ownerId, flow)
  host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'penalty', data: {} })
}
function askQuxianActor(host: SkillHost, ownerId: PlayerId): void {
  const flow = quxianFlow(host.state, ownerId)
  const actorId = flow?.actors[flow.index]
  const actions = flow && actorId ? quxianUseActions(host.state, actorId, flow.targetId) : []
  if (!flow || !actorId) { finishQuxianActors(host, ownerId); return }
  if (!actions.length) {
    flow.index += 1; setQuxianFlow(host.state, ownerId, flow)
    host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'ask-actor', data: {} }); return
  }
  host.askSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'ask-actor', data: { actorId }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: actorId, prompt: `【驱险】：是否对${getPlayer(host.state, flow.targetId)?.nickname ?? '目标'}使用【杀】？`,
    timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '使用【杀】' }, { id: 'no', label: '不使用' }],
  }) })
}
registerSkillRuntime({
  id: MATIE_QUIXIAN,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) askQuxianStart(host, ownerId, 'start')
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (turnPlayerId(context) === ownerId) askQuxianStart(host, ownerId, 'end')
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== MATIE_QUIXIAN) return
      const flow = quxianFlow(host.state, ownerId), actorId = context.event.sourceId
      if (flow && actorId === flow.actors[flow.index] && actorId && !flow.used.includes(actorId)) {
        flow.used.push(actorId); flow.usedCount += 1; setQuxianFlow(host.state, ownerId, flow)
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const flow = quxianFlow(host.state, ownerId)
      const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
      if (flow && context.event.sourceSkillId === MATIE_QUIXIAN && context.event.targetId === flow.targetId && amount > 0) {
        flow.damaged = true; setQuxianFlow(host.state, ownerId, flow)
      }
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== MATIE_QUIXIAN) return
      const flow = quxianFlow(host.state, ownerId)
      if (!flow) return
      const actorId = flow.actors[flow.index]
      if (actorId) drawCards(host.state, host.rng, actorId, 1, (name, data) => host.dispatch(name, data))
      flow.index += 1; setQuxianFlow(host.state, ownerId, flow)
      host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'ask-actor', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask-actor') { askQuxianActor(host, ownerId); return }
    if (prompt.step === 'penalty') {
      const flow = quxianFlow(host.state, ownerId), actorId = flow?.penalties[flow.penaltyIndex]
      if (!flow || !actorId) { setQuxianFlow(host.state, ownerId, undefined); return }
      if (getPlayer(host.state, actorId)?.alive) loseHp(host as never, actorId, flow.usedCount, MATIE_QUIXIAN)
      flow.penaltyIndex += 1; setQuxianFlow(host.state, ownerId, flow)
      host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'penalty', data: {} })
    }
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; actionId?: string; targetIds?: PlayerId[] }
    if (resolution.step === 'activate') {
      if (payload.optionId !== 'yes') return
      const slash = host.state.zones.drawPile.find((cardId) => host.state.cards[cardId]?.name === '杀')
      if (!slash) return
      moveCard(host.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [slash], reason: MATIE_QUIXIAN }, { targetId: ownerId, cardIds: [slash] })
      askQuxianTarget(host, ownerId); return
    }
    if (resolution.step === 'target') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || targetId === ownerId || !getPlayer(host.state, targetId)?.alive) return
      setQuxianFlow(host.state, ownerId, { targetId, actors: quxianActors(host.state, targetId), index: 0,
        used: [], usedCount: 0, damaged: false, penalties: [], penaltyIndex: 0 })
      host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'ask-actor', data: {} }); return
    }
    if (resolution.step === 'ask-actor') {
      const flow = quxianFlow(host.state, ownerId), actorId = resolution.data.actorId as PlayerId
      if (!flow) return
      if (payload.optionId !== 'yes' || actorId !== flow.actors[flow.index]) {
        flow.index += 1; setQuxianFlow(host.state, ownerId, flow)
        host.queueSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'ask-actor', data: {} }); return
      }
      const actions = quxianUseActions(host.state, actorId, flow.targetId)
      host.askSkill({ skillId: MATIE_QUIXIAN, ownerId, step: 'use-actor', data: { actorId, targetId: flow.targetId }, build: (id): UseCardRequest => ({
        id, kind: 'use-card', playerId: actorId, prompt: '【驱险】：选择一张【杀】对目标使用', timeoutMs: 25_000,
        optional: false, actionIds: actions.map((action) => action.id),
      }) })
      return
    }
    if (resolution.step === 'use-actor') {
      const actorId = resolution.data.actorId as PlayerId, targetId = resolution.data.targetId as PlayerId
      const action = quxianUseActions(host.state, actorId, targetId).find((candidate) => candidate.id === payload.actionId)
      if (action) executeUseCardAction(host as never, actorId, action)
    }
  },
})

registerSkillRuntime({
  id: SUN_SARAN,
  globalSlashUses(state, ownerId, actorId) {
    if (ownerId !== actorId) return 0
    const actor = getPlayer(state, actorId)
    return actor ? Object.values(actor.zones.equipment).filter((cardId) => cardId !== null).length : 0
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
      if (amount < 1 || !getPlayer(host.state, ownerId)?.alive
        || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
      host.queueSkill({ skillId: SUN_SARAN, ownerId, step: 'recover-slot', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'recover-slot' && prompt.step !== 'find-equipment') return
    const owner = getPlayer(host.state, ownerId)
    if (!owner?.alive) return
    const abolished = abolishedSlotsOf(host.state, ownerId).filter((slot) => ABOLISHABLE_SLOTS.includes(slot))
    if (prompt.step === 'recover-slot' && abolished.length) {
      host.askSkill({ skillId: SUN_SARAN, ownerId, step: 'recover-slot', data: {}, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【飒然】：选择恢复一个装备栏', timeoutMs: 25_000,
        optional: false, options: [...abolished.map((slot) => ({ id: slot, label: SUNSHUREN_SLOT_LABEL[slot] })),
          { id: 'skip', label: '不恢复装备栏' }],
      }) })
      return
    }
    equipRandomSaranCard(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'recover-slot') return
    const slot = (response.payload as { optionId?: EquipmentSlot }).optionId
    if ((response.payload as { optionId?: string }).optionId === 'skip') {
      equipRandomSaranCard(host, ownerId)
      return
    }
    if (!slot || !(host.state.abolishedSlots?.[ownerId] ?? []).includes(slot) || !restoreSlot(host.state, ownerId, slot)) return
    equipRandomSaranCard(host, ownerId)
  },
})

function equipRandomSaranCard(host: SkillHost, ownerId: PlayerId): void {
  const owner = getPlayer(host.state, ownerId)
  if (!owner?.alive) return
  const candidates = [...host.state.zones.drawPile, ...host.state.zones.discardPile].filter((cardId) => {
    const card = host.state.cards[cardId]
    return card?.category === 'equipment' && !!card.equipmentSlot && equipmentSlotsOf(host.state, ownerId).some((slot) =>
      card.equipmentSlot === 'weapon' ? slot === 'weapon' || slot === 'weapon2' : slot === card.equipmentSlot)
  })
  if (!candidates.length) return
  const cardId = candidates[host.rng.nextInt(candidates.length)]!
  const from = host.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
  moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SUN_SARAN }, { targetId: ownerId, cardIds: [cardId] })
  const slots = equipmentSlotsForSkillUse(host.state, ownerId, cardId)
  const slot = slots[0]
  if (!slot || !useEquipmentFromSkill(host as never, ownerId, cardId, slot)) {
    if (owner.zones.hand.includes(cardId)) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, from)
  }
}

const SUNSHUREN_SLOT_LABEL: Record<EquipmentSlot, string> = {
  weapon: '武器栏', weapon2: '第二武器栏', armor: '防具栏', offensiveHorse: '-1坐骑栏', defensiveHorse: '+1坐骑栏', treasure: '宝物栏',
}
function finishShurenReveal(host: SkillHost, ownerId: PlayerId, cardIds: CardId[]): void {
  const discarded = cardIds.filter((cardId) => host.state.zones.processingArea.includes(cardId))
  for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  if (discarded.length) host.dispatch('CardMove', { cardIds: discarded, reason: SUN_SHUREN }, { sourceId: ownerId, cardIds: discarded })
}
registerSkillRuntime({
  id: SUN_SHUREN,
  activeActions(state, ownerId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && getPlayer(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, SUN_SHUREN)
      ? [{ id: `${SUN_SHUREN}:activate`, label: '淑任：废除装备栏并展示牌堆顶三张牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${SUN_SHUREN}:activate` || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
      || usedThisPhase(host.state, ownerId, SUN_SHUREN) || !getPlayer(host.state, ownerId)?.alive) return
    const slots = abolishableSlotsOf(host.state, ownerId)
    if (!slots.length) return
    host.askSkill({ skillId: SUN_SHUREN, ownerId, step: 'slot', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【淑任】：选择要废除的装备栏', timeoutMs: 25_000,
      optional: false, options: slots.map((slot) => ({ id: slot, label: SUNSHUREN_SLOT_LABEL[slot] })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[]; targetIds?: PlayerId[] }
    if (resolution.step === 'slot') {
      const slot = payload.optionId as EquipmentSlot | undefined
      const owner = getPlayer(host.state, ownerId)
      if (!slot || !owner?.alive || !abolishableSlotsOf(host.state, ownerId).includes(slot)) return
      const equipped = owner.zones.equipment[slot]
      markUsedThisPhase(host.state, ownerId, SUN_SHUREN)
      if (equipped) {
        moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, equipped)
      }
      abolishSlot(host.state, ownerId, slot)
      if (equipped) {
        clearUsedThisPhase(host.state, ownerId, SUN_SHUREN)
        recover(host as never, ownerId, 1, ownerId)
      }
      const revealed = revealTopCards(host.state, host.rng, 3, SUN_SHUREN, (name, data) => host.dispatch(name, data)) as CardId[]
      if (!revealed.length) return
      host.askSkill({ skillId: SUN_SHUREN, ownerId, step: 'take', data: { revealed }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【淑任】：选择获得其中一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: revealed, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    const revealed = resolution.data.revealed as CardId[]
    if (!Array.isArray(revealed)) return
    if (resolution.step === 'take') {
      const cardId = payload.cardIds?.[0]
      if (!cardId || !revealed.includes(cardId) || !host.state.zones.processingArea.includes(cardId)) {
        finishShurenReveal(host, ownerId, revealed); return
      }
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SUN_SHUREN }, { targetId: ownerId, cardIds: [cardId] })
      const remaining = revealed.filter((id) => id !== cardId && host.state.zones.processingArea.includes(id))
      const recipients = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map(({ id }) => id)
      if (!remaining.length || !recipients.length) { finishShurenReveal(host, ownerId, remaining); return }
      host.askSkill({ skillId: SUN_SHUREN, ownerId, step: 'recipient', data: { revealed: remaining }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【淑任】：可选择一名其他角色获得其中一张牌', timeoutMs: 25_000,
        optional: true, candidateIds: recipients, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'recipient') {
      const targetId = payload.targetIds?.[0]
      if (!targetId || !getPlayer(host.state, targetId)?.alive || targetId === ownerId) {
        finishShurenReveal(host, ownerId, revealed); return
      }
      host.askSkill({ skillId: SUN_SHUREN, ownerId, step: 'give', data: { revealed, targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【淑任】：选择交给该角色的一张牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: revealed.filter((cardId) => host.state.zones.processingArea.includes(cardId)),
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = payload.cardIds?.[0]
      if (cardId && revealed.includes(cardId) && host.state.zones.processingArea.includes(cardId) && getPlayer(host.state, targetId)?.alive) {
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: SUN_SHUREN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      finishShurenReveal(host, ownerId, revealed)
    }
  },
})

registerSkillRuntime({
  id: HUANG_TUICHENG,
  triggers: [{ event: 'CardGiven', handle(host, ownerId, context) {
    const payload = context.event.payload as { fromId?: PlayerId; toId?: PlayerId; cardIds?: CardId[] }
    const given = payload.cardIds ?? context.event.cardIds ?? []
    if (payload.fromId !== ownerId || !payload.toId || payload.toId === ownerId || !given.length
      || !getPlayer(host.state, ownerId)?.alive || !getPlayer(host.state, payload.toId)?.alive) return
    host.queueSkill({ skillId: HUANG_TUICHENG, ownerId, step: 'repay', data: { recipientId: payload.toId, givenCardIds: given } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'repay') return
    const recipientId = prompt.data.recipientId as PlayerId
    const givenCardIds = prompt.data.givenCardIds as CardId[]
    const recipient = getPlayer(host.state, recipientId)
    const owner = getPlayer(host.state, ownerId)
    if (!owner?.alive || !recipient?.alive || recipientId === ownerId || !givenCardIds?.length) return
    const selectable = recipient.zones.hand.filter((cardId) => !givenCardIds.includes(cardId))
    if (selectable.length < givenCardIds.length) {
      drawCards(host.state, host.rng, ownerId, givenCardIds.length, (name, data) => host.dispatch(name, data))
      return
    }
    host.askSkill({ skillId: HUANG_TUICHENG, ownerId, step: 'repay', data: { recipientId, givenCardIds }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: recipientId,
      prompt: `【推诚】：交给${owner.nickname} ${givenCardIds.length}张牌（不能交还刚获得的牌）`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: selectable, hiddenCardSlots: [],
      min: givenCardIds.length, max: givenCardIds.length,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'repay') return
    const recipientId = resolution.data.recipientId as PlayerId
    const givenCardIds = resolution.data.givenCardIds as CardId[]
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = getPlayer(host.state, ownerId), recipient = getPlayer(host.state, recipientId)
    if (!owner?.alive || !recipient?.alive || selected.length !== givenCardIds.length
      || new Set(selected).size !== selected.length || selected.some((cardId) => givenCardIds.includes(cardId)
        || !recipient.zones.hand.includes(cardId))) {
      if (owner?.alive) drawCards(host.state, host.rng, ownerId, givenCardIds.length, (name, data) => host.dispatch(name, data))
      return
    }
    giveCards(host as never, recipientId, ownerId, selected, HUANG_TUICHENG)
  },
})

registerSkillRuntime({
  id: HUANG_QIAODUI,
  repeatTargetEffectCount(state, ownerId, _targetId, cardId) {
    return qiaoduiRecord(state, ownerId).repeatCardIds.includes(cardId) ? 1 : 0
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId) return
    const record = qiaoduiRecord(host.state, ownerId)
    record.repeatCardIds = record.repeatCardIds.filter((id) => id !== cardId)
  } }],
  interceptSourceTarget(host, ownerId, context) {
    const owner = getPlayer(host.state, ownerId)
    const resolution = host.state.cardResolution
    const targets = resolution?.kind === 'trick' ? resolution.targetIds : resolution?.kind === 'slash'
      ? [resolution.targetId, ...resolution.remainingTargetIds] : [context.targetId]
    if (context.sourceId !== ownerId || !owner?.alive || qiaoduiRecord(host.state, ownerId).used
      || !targets.some((targetId) => targetId !== ownerId) || !(context.category === 'basic' || context.category === 'trick')) return false
    host.askSkill({ skillId: HUANG_QIAODUI, ownerId, step: 'choose-recipient',
      data: { cardId: context.cardId, mode: 'repeat' }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【巧对】：可交给一名其他角色至多两张牌，使此牌额外结算一次',
        timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map(({ id: playerId }) => playerId),
        min: 1, max: 1,
      }) })
    return true
  },
  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId || context.sourceId === ownerId || !getPlayer(host.state, ownerId)?.alive
      || qiaoduiRecord(host.state, ownerId).used
      || !(context.category === 'basic' || context.category === 'trick')) return false
    host.askSkill({ skillId: HUANG_QIAODUI, ownerId, step: 'choose-recipient',
      data: { cardId: context.cardId, sourceId: context.sourceId, mode: 'invalidate' }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【巧对】：可交给一名其他角色至多两张牌，令此牌失效',
        timeoutMs: 25_000, optional: true, candidateIds: host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map(({ id: playerId }) => playerId),
        min: 1, max: 1,
      }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { targetIds?: PlayerId[]; cardIds?: CardId[] }
    const record = qiaoduiRecord(host.state, ownerId)
    if (resolution.step === 'choose-recipient') {
      const recipientId = payload.targetIds?.[0]
      if (!recipientId) { host.resumeCardTarget(); return }
      const recipient = getPlayer(host.state, recipientId), owner = getPlayer(host.state, ownerId)
      if (!recipient?.alive || recipientId === ownerId || !owner?.alive) { host.resumeCardTarget(); return }
      const cards = [...owner.zones.hand]
      if (!cards.length) { host.resumeCardTarget(); return }
      host.askSkill({ skillId: HUANG_QIAODUI, ownerId, step: 'give-cards',
        data: { ...resolution.data, recipientId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: `【巧对】：选择交给${recipient.nickname}的牌（至多两张）`,
          timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: Math.min(2, cards.length),
        }) })
      return
    }
    if (resolution.step !== 'give-cards') return
    const cardIds = payload.cardIds ?? []
    const recipientId = resolution.data.recipientId as PlayerId
    const owner = getPlayer(host.state, ownerId), recipient = getPlayer(host.state, recipientId)
    if (!owner?.alive || !recipient?.alive || !cardIds.length || cardIds.length > 2 || new Set(cardIds).size !== cardIds.length
      || cardIds.some((cardId) => !owner.zones.hand.includes(cardId))) { host.resumeCardTarget(); return }
    const given = giveCards(host as never, ownerId, recipientId, cardIds, HUANG_QIAODUI)
    if (!given.length) { host.resumeCardTarget(); return }
    record.used = true
    const cardId = resolution.data.cardId as CardId
    if (resolution.data.mode === 'repeat') record.repeatCardIds.push(cardId)
    else {
      host.state.invalidatedCardUses ??= {}
      host.state.invalidatedCardUses[cardId] = { sourceId: ownerId, skillId: HUANG_QIAODUI }
    }
    host.resumeCardTarget()
  },
})

type QinqiangRecord = { turn: number; lastColor: 'red' | 'black' | null; streak: number; usedDamage: boolean; usedDraw: boolean; bonusByCard: Record<CardId, number> }
function qinqiangRecord(state: SanguoshaState, ownerId: PlayerId): QinqiangRecord {
  const records = b84(state).qinqiang ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, lastColor: null, streak: 0, usedDamage: false, usedDraw: false, bonusByCard: {} }
  return records[ownerId] as QinqiangRecord
}
const QINQIANG_DAMAGE_CARDS = new Set(['杀', '决斗', '火攻', '南蛮入侵', '万箭齐发', '闪电'])
registerSkillRuntime({
  id: XU_QINQIANG,
  outgoingDamage(state, ownerId, context) {
    const bonus = context.cardId ? qinqiangRecord(state, ownerId).bonusByCard[context.cardId] : 0
    return bonus ? { amount: context.amount + bonus } : null
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; cardName?: string; fromKind?: string }
      const cardId = payload.cardId ?? payload.cardIds?.[0]
      const card = cardId ? host.state.cards[cardId] : undefined
      if (!cardId || !card || payload.fromKind !== 'hand') return
      const color = effectiveCardColor(host.state, ownerId, cardId)
      if (!color) return
      const record = qinqiangRecord(host.state, ownerId)
      const x = record.lastColor === color ? record.streak + 1 : 1
      record.streak = record.lastColor === color ? record.streak + 1 : 1
      record.lastColor = color
      if (record.usedDamage && record.usedDraw) return
      const isDamage = Boolean(card.damageNature || QINQIANG_DAMAGE_CARDS.has(payload.cardName ?? card.name))
      host.queueSkill({ skillId: XU_QINQIANG, ownerId, step: 'choice', data: { cardId, x, isDamage } })
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) delete qinqiangRecord(host.state, ownerId).bonusByCard[cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const record = qinqiangRecord(host.state, ownerId)
    const options = [
      ...(!record.usedDamage && prompt.data.isDamage ? [{ id: 'damage', label: `此牌伤害+${Number(prompt.data.x)}` }] : []),
      ...(!record.usedDraw ? [{ id: 'draw', label: `摸${Number(prompt.data.x)}张牌` }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: XU_QINQIANG, ownerId, step: 'choice', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【勤强】：选择一项（X=${Number(prompt.data.x)}）`,
      timeoutMs: 25_000, optional: true, options: [...options, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choice') return
    const record = qinqiangRecord(host.state, ownerId)
    const optionId = (response.payload as { optionId?: string }).optionId
    const cardId = resolution.data.cardId as CardId
    const x = Number(resolution.data.x)
    if (!Number.isInteger(x) || x < 1 || !cardId) return
    if (optionId === 'damage' && resolution.data.isDamage && !record.usedDamage) {
      record.usedDamage = true
      record.bonusByCard[cardId] = x
    } else if (optionId === 'draw' && !record.usedDraw) {
      record.usedDraw = true
      drawCards(host.state, host.rng, ownerId, x, (name, data) => host.dispatch(name, data))
    }
  },
})

registerSkillRuntime({
  id: XU_YIZHEN,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const sourceId = context.event.sourceId
    const owner = getPlayer(host.state, ownerId), source = sourceId ? getPlayer(host.state, sourceId) : undefined
    const finalAmount = Number((context.event.payload as { finalAmount?: number }).finalAmount ?? 0)
    if (context.event.targetId !== ownerId || finalAmount < 1 || !owner?.alive || !source?.alive
      || sourceId === ownerId || owner.zones.hand.length === 0 || source.zones.hand.length === 0) return
    host.queueSkill({ skillId: XU_YIZHEN, ownerId, step: 'offer', data: { sourceId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const sourceId = prompt.data.sourceId as PlayerId
    const owner = getPlayer(host.state, ownerId), source = getPlayer(host.state, sourceId)
    if (!owner?.alive || !source?.alive || !owner.zones.hand.length || !source.zones.hand.length) return
    host.askSkill({ skillId: XU_YIZHEN, ownerId, step: 'offer', data: { sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【疑阵】：是否与伤害来源互相观看手牌并弃置牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动疑阵' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[] }
    const sourceId = resolution.data.sourceId as PlayerId
    const owner = getPlayer(host.state, ownerId), source = getPlayer(host.state, sourceId)
    if (resolution.step === 'offer') {
      if (payload.optionId !== 'yes' || !owner?.alive || !source?.alive || !owner.zones.hand.length || !source.zones.hand.length) return
      host.askSkill({ skillId: XU_YIZHEN, ownerId, step: 'choose-source-card', data: { sourceId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【疑阵】：选择弃置${source.nickname}的一张手牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...source.zones.hand], viewOnlyCardIds: [...source.zones.hand],
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'choose-source-card') {
      const cardId = payload.cardIds?.[0]
      if (!owner?.alive || !source?.alive || !cardId || !source.zones.hand.includes(cardId) || !owner.zones.hand.length) return
      host.askSkill({ skillId: XU_YIZHEN, ownerId, step: 'choose-owner-card', data: { sourceId, sourceCardId: cardId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: sourceId, prompt: `【疑阵】：选择弃置${owner.nickname}的一张手牌`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], viewOnlyCardIds: [...owner.zones.hand],
        hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'choose-owner-card') return
    const sourceCardId = resolution.data.sourceCardId as CardId
    const ownerCardId = payload.cardIds?.[0]
    if (!owner?.alive || !source?.alive || !source.zones.hand.includes(sourceCardId)
      || !ownerCardId || !owner.zones.hand.includes(ownerCardId)) return
    const sourceColor = effectiveCardColor(host.state, sourceId, sourceCardId)
    const ownerColor = effectiveCardColor(host.state, ownerId, ownerCardId)
    const sourceDiscarded = discardCardsByIds(host as never, sourceId, [sourceCardId], XU_YIZHEN)
    const ownerDiscarded = discardCardsByIds(host as never, ownerId, [ownerCardId], XU_YIZHEN)
    if (sourceColor && sourceColor === ownerColor && sourceDiscarded.includes(sourceCardId) && ownerDiscarded.includes(ownerCardId)) {
      const gained: CardId[] = []
      for (const cardId of [sourceCardId, ownerCardId]) if (host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        gained.push(cardId)
      }
      if (gained.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: XU_YIZHEN }, { targetId: ownerId, cardIds: gained })
    }
  },
})

type KangmingState = { shownTurn: number; shownCardIds: CardId[]; resolvedCardIds: CardId[]; disabled: boolean; untilOwnTurn: boolean }
function kangmingState(state: SanguoshaState, ownerId: PlayerId): KangmingState {
  const records = b84(state).kangming ??= {}
  if (!records[ownerId]) records[ownerId] = { shownTurn: state.turnNumber, shownCardIds: [], resolvedCardIds: [], disabled: false, untilOwnTurn: false }
  const record = records[ownerId] as KangmingState
  if (record.shownTurn !== state.turnNumber) {
    record.shownTurn = state.turnNumber
    record.shownCardIds = []
    record.resolvedCardIds = []
  }
  return record
}

function kangmingCardActions(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId, selectedCardId?: CardId): Map<CardId, Extract<LegalAction, { kind: 'use-card' }>[] > {
  const record = kangmingState(host.state, ownerId)
  const revealedThisTurn = host.state.revealedCardIdsThisTurn?.turnNumber === host.state.turnNumber
    ? host.state.revealedCardIdsThisTurn.cardIds : []
  const candidates = new Map<CardId, Extract<LegalAction, { kind: 'use-card' }>[]>()
  for (const cardId of getPlayer(host.state, ownerId)?.zones.hand ?? []) {
    if (cardId !== selectedCardId && (record.shownCardIds.includes(cardId) || revealedThisTurn.includes(cardId))) continue
    const name = host.state.cards[cardId] ? effectiveCardName(host.state, cardId) : ''
    if (name !== '杀' && !INSTANT_TRICKS.has(name)) continue
    const actions = skillHandCardUseActions(host.state, ownerId, cardId)
      .filter((action) => action.targetIds.includes(sourceId))
    if (actions.length) candidates.set(cardId, actions)
  }
  return candidates
}

registerSkillRuntime({
  id: LUO_KANGMING,
  triggers: [
    { event: 'CardResolved', handle(host, ownerId, context) {
      const targets = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const sourceId = context.event.sourceId
      const owner = getPlayer(host.state, ownerId)
      const record = kangmingState(host.state, ownerId)
      if (!owner?.alive || !cardId || !targets.includes(ownerId) || !sourceId || sourceId === ownerId
        || record.disabled || record.resolvedCardIds.includes(cardId)) return
      record.resolvedCardIds.push(cardId)
      host.queueSkill({ skillId: LUO_KANGMING, ownerId, step: 'offer', data: { sourceId } })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if (turnPlayerId(context) !== ownerId) return
      const record = kangmingState(host.state, ownerId)
      if (record.disabled && record.untilOwnTurn) {
        record.disabled = false
        record.untilOwnTurn = false
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      if (turnPlayerId(context) !== ownerId) return
      const record = kangmingState(host.state, ownerId)
      if (record.disabled && !record.untilOwnTurn) record.disabled = false
      record.untilOwnTurn = false
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const owner = getPlayer(host.state, ownerId)
    const sourceId = prompt.data.sourceId as PlayerId
    const source = getPlayer(host.state, sourceId)
    const record = kangmingState(host.state, ownerId)
    if (!owner?.alive || record.disabled) return
    drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    const canUse = Boolean(source?.alive && kangmingCardActions(host, ownerId, sourceId).size)
    host.askSkill({ skillId: LUO_KANGMING, ownerId, step: 'choose-mode', data: { sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【抗明】：选择一项', timeoutMs: 25_000, optional: false,
      options: [
        ...(canUse ? [{ id: 'use', label: `展示一张本回合未展示过的【杀】或普通锦囊牌，对${source!.nickname}使用` }] : []),
        { id: 'draw', label: '再摸三张牌，此技能失效至你的回合开始' },
      ],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[] }
    const sourceId = resolution.data.sourceId as PlayerId
    const owner = getPlayer(host.state, ownerId)
    const record = kangmingState(host.state, ownerId)
    if (!owner?.alive || record.disabled) return
    if (resolution.step === 'choose-mode') {
      if (payload.optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 3, (name, data) => host.dispatch(name, data))
        record.disabled = true
        record.untilOwnTurn = host.state.currentPlayerId !== ownerId
      } else if (payload.optionId === 'use') {
        const candidates = kangmingCardActions(host, ownerId, sourceId)
        const cardIds = [...candidates.keys()]
        if (!cardIds.length) return
        host.askSkill({ skillId: LUO_KANGMING, ownerId, step: 'choose-card', data: { sourceId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【抗明】：展示一张本回合未展示过的【杀】或普通锦囊牌',
          timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'choose-card') {
      const cardId = payload.cardIds?.[0]
      const actions = cardId ? kangmingCardActions(host, ownerId, sourceId).get(cardId) : undefined
      if (!cardId || !actions?.length) return
      record.shownCardIds.push(cardId)
      host.dispatch('CardMove', { cardIds: [cardId], reason: LUO_KANGMING, revealed: true }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
      host.askSkill({ skillId: LUO_KANGMING, ownerId, step: 'choose-use', data: { sourceId, cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【抗明】：选择对${getPlayer(host.state, sourceId)?.nickname ?? '使用者'}使用此牌的合法目标`,
        timeoutMs: 25_000, optional: false, options: actions.map((action) => ({ id: action.id, label: action.label })),
      }) })
      return
    }
    if (resolution.step === 'choose-use') {
      const cardId = resolution.data.cardId as CardId
      const actionId = payload.optionId
      if (!actionId) return
      const action = kangmingCardActions(host, ownerId, sourceId, cardId).get(cardId)?.find((candidate) => candidate.id === actionId)
      if (action) executeUseCardAction(host as never, ownerId, action)
    }
  },
})

type JuceFollowup = { targetId: PlayerId; armed: boolean }
type JuceState = { turn: number; used: boolean; followups: JuceFollowup[] }
function juceState(state: SanguoshaState, ownerId: PlayerId): JuceState {
  const records = b84(state).juce ??= {}
  if (!records[ownerId] || records[ownerId].turn !== state.turnNumber)
    records[ownerId] = { turn: state.turnNumber, used: false, followups: records[ownerId]?.followups ?? [] }
  return records[ownerId] as JuceState
}
function juceCardEligible(cardName: string): boolean {
  return ['杀', '闪', '桃', '酒'].includes(cardName) || INSTANT_TRICKS.has(cardName)
}

type ChiguoPhase = { turn: number; active: boolean; adjustment?: 'add' | 'remove' }
function chiguoPhase(state: SanguoshaState, ownerId: PlayerId): ChiguoPhase {
  const phases = b84(state).chiguo ??= {}
  if (!phases[ownerId] || phases[ownerId].turn !== state.turnNumber)
    phases[ownerId] = { turn: state.turnNumber, active: false }
  return phases[ownerId] as ChiguoPhase
}

function chiguoAdjustedActions(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, mode: 'add' | 'remove') {
  const owner = getPlayer(host.state, ownerId)
  if (!owner) return []
  const phase = chiguoPhase(host.state, ownerId)
  phase.adjustment = mode
  const originalGranted = owner.grantedSkills
  if (!(originalGranted ?? []).includes(JIANG_CHIGUO)) owner.grantedSkills = [...(originalGranted ?? []), JIANG_CHIGUO]
  try {
    const variants = withNextCardTargetChoices(host.state, ownerId, [structuredClone(action)])
    return variants.filter((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card'
      && (mode === 'add' ? candidate.targetIds.length === action.targetIds.length + 1
        && candidate.targetExpansionSkillId === JIANG_CHIGUO
        : candidate.targetIds.length === action.targetIds.length - 1 && candidate.id.includes(':target-minus:')))
  } finally {
    owner.grantedSkills = originalGranted ?? []
    delete phase.adjustment
  }
}

function finishChiguoReveal(host: SkillHost, cardId: CardId, to: ZoneRef): void {
  if (host.state.zones.processingArea.includes(cardId)) moveCard(host.state, cardId, { kind: 'processingArea' }, to)
}

function replayChiguoAction(host: SkillHost, action: Extract<LegalAction, { kind: 'use-card' }>): void {
  const cleanAction = { ...action }
  if (cleanAction.targetExpansionSkillId === JIANG_CHIGUO) {
    delete cleanAction.targetExpansionSkillId
    delete cleanAction.targetExpansionTargetId
  }
  executeUseCardAction(host as never, action.playerId, cleanAction)
}

registerSkillRuntime({
  id: JIANG_CHIGUO,
  modifiesNextCardTargets(state, ownerId) {
    const phase = b84(state).chiguo?.[ownerId] as ChiguoPhase | undefined
    return phase?.turn === state.turnNumber && phase.adjustment !== undefined
  },
  nextCardTargetExpansion(state, ownerId, _cardId, _cardName) {
    const phase = b84(state).chiguo?.[ownerId] as ChiguoPhase | undefined
    if (phase?.turn !== state.turnNumber || phase.adjustment !== 'add') return null
    return { maxAdditionalTargets: 1, candidateIds: state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id) }
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'play' || !getPlayer(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: JIANG_CHIGUO, ownerId, step: 'activate', data: { turn: host.state.turnNumber } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') delete b84(host.state).chiguo?.[ownerId]
    } },
  ],
  interceptPlayAction(host, ownerId, action) {
    const phase = chiguoPhase(host.state, ownerId)
    if (!phase.active || phase.turn !== host.state.turnNumber || host.state.phase !== 'play'
      || host.state.currentPlayerId !== ownerId || action.playerId !== ownerId) return false
    if (host.state.zones.drawPile.length === 0) reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
    const revealedId = host.state.zones.drawPile.at(-1)
    if (!revealedId) return false
    moveCard(host.state, revealedId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { cardIds: [revealedId], reason: JIANG_CHIGUO, revealed: true }, { sourceId: ownerId, cardIds: [revealedId] })
    const usedSuit = effectiveCardSuit(host.state, ownerId, action.cardIds[0], skillIdsOf)
    const revealedSuit = host.state.cards[revealedId]?.suit
    if (revealedSuit && revealedSuit === usedSuit) {
      const addActions = chiguoAdjustedActions(host, ownerId, action, 'add')
      const removeActions = chiguoAdjustedActions(host, ownerId, action, 'remove')
      const variants = [...addActions, ...removeActions]
      if (!variants.length) {
        finishChiguoReveal(host, revealedId, { kind: 'discardPile' })
        return false
      }
      host.askSkill({ skillId: JIANG_CHIGUO, ownerId, step: 'adjust-targets', data: { action, revealedId, variants }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【持国】：为此牌增加或减少一个目标', timeoutMs: 25_000,
        optional: false, options: variants.map((variant) => ({ id: variant.id, label: variant.label })),
      }) })
      return true
    }
    const targets = action.targetIds.filter((targetId) => getPlayer(host.state, targetId)?.alive)
    if (!targets.length) {
      finishChiguoReveal(host, revealedId, { kind: 'drawPile' })
      return false
    }
    host.askSkill({ skillId: JIANG_CHIGUO, ownerId, step: 'give-target', data: { action, revealedId, targets }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【持国】：将亮出的牌交给其中一名目标角色', timeoutMs: 25_000,
      optional: false, candidateIds: targets, min: 1, max: 1,
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'activate') return
    if (!getPlayer(host.state, ownerId)?.alive || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
    host.askSkill({ skillId: JIANG_CHIGUO, ownerId, step: 'activate', data: prompt.data, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【持国】：是否观看牌堆底三张牌？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '观看并启用持国' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const payload = response.payload as { optionId?: string; cardIds?: CardId[]; targetIds?: PlayerId[] }
    if (resolution.step === 'activate') {
      if (payload.optionId !== 'yes' || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      if (!host.state.zones.drawPile.length) reshuffleDrawPile(host.state, host.rng, (name, data) => host.dispatch(name, data))
      const viewOnlyCardIds = host.state.zones.drawPile.slice(-3).reverse()
      if (!viewOnlyCardIds.length) return
      host.askSkill({ skillId: JIANG_CHIGUO, ownerId, step: 'view-bottom', data: { turn: host.state.turnNumber }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【持国】：观看牌堆底三张牌（确认继续）', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [], viewOnlyCardIds, hiddenCardSlots: [], min: 0, max: 0,
      }) })
      return
    }
    if (resolution.step === 'view-bottom') {
      if (host.state.currentPlayerId !== ownerId || host.state.phase !== 'play'
        || Number(resolution.data.turn) !== host.state.turnNumber) return
      chiguoPhase(host.state, ownerId).active = true
      return
    }
    const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
    const revealedId = resolution.data.revealedId as CardId
    if (resolution.step === 'give-target') {
      const targetId = payload.targetIds?.[0]
      const allowed = resolution.data.targets as PlayerId[]
      if (!targetId || !allowed.includes(targetId) || !getPlayer(host.state, targetId)?.alive) return
      finishChiguoReveal(host, revealedId, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [revealedId], reason: JIANG_CHIGUO, revealed: true }, { sourceId: ownerId, targetId, cardIds: [revealedId] })
      replayChiguoAction(host, action)
      return
    }
    if (resolution.step === 'adjust-targets') {
      const chosen = (resolution.data.variants as Extract<LegalAction, { kind: 'use-card' }>[])?.find((variant) => variant.id === payload.optionId)
      if (!chosen) return
      finishChiguoReveal(host, revealedId, { kind: 'discardPile' })
      replayChiguoAction(host, chosen)
    }
  },
})

registerSkillRuntime({
  id: LUO_JUCE,
  modifiesNextCardTargets(state, ownerId, _cardId, cardName) {
    return !juceState(state, ownerId).used && juceCardEligible(cardName)
  },
  nextCardTargetExpansion(state, ownerId, _cardId, cardName) {
    if (!juceCardEligible(cardName)) return null
    return { maxAdditionalTargets: 1, candidateIds: state.players.filter((player) => player.alive && player.id !== ownerId).map(({ id }) => id) }
  },
  forcedAdditionalTargetsOnUse(state, ownerId, sourceId, cardId, cardName, currentTargetIds, skillIds) {
    const followup = juceState(state, ownerId).followups.find((entry) => entry.targetId === sourceId && entry.armed)
    if (!followup || !juceCardEligible(cardName) || currentTargetIds.includes(ownerId)
      || isTargetProhibited(state, sourceId, ownerId, cardName, skillIds, cardId)) return []
    return [ownerId]
  },
  triggers: [
    { event: 'TargetExpansionSelected', handle(host, ownerId, context) {
      if (context.event.sourceSkillId !== LUO_JUCE) return
      const addedTargetId = (context.event.payload as { addedTargetId?: PlayerId }).addedTargetId
      if (!addedTargetId || addedTargetId === ownerId || !getPlayer(host.state, ownerId)?.alive) return
      const state = juceState(host.state, ownerId)
      if (!state.followups.some((entry) => entry.targetId === addedTargetId))
        state.followups.push({ targetId: addedTargetId, armed: false })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const cardName = (context.event.payload as { cardName?: string }).cardName ?? ''
      if (context.event.sourceId === ownerId && juceCardEligible(cardName)) juceState(host.state, ownerId).used = true
      const sourceId = context.event.sourceId
      if (!sourceId || !juceCardEligible(cardName)) return
      const targetIds = (context.event.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const state = juceState(host.state, ownerId)
      if (targetIds.includes(ownerId) && state.followups.some((entry) => entry.targetId === sourceId && entry.armed))
        state.followups = state.followups.filter((entry) => entry.targetId !== sourceId)
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = turnPlayerId(context)
      if (!targetId) return
      const state = juceState(host.state, ownerId)
      for (const followup of state.followups) if (followup.targetId === targetId) followup.armed = true
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const targetId = turnPlayerId(context)
      if (!targetId) return
      const state = juceState(host.state, ownerId)
      state.followups = state.followups.filter((followup) => followup.targetId !== targetId || !followup.armed)
    } },
  ],
})
