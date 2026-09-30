import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerPindianContinuation, canPindian, startPindian } from '../../engine/pindian'
import { canTarget } from '../../engine/distance'
import { resolveDamage, resumeTargetDamagePrevention } from '../../engine/damage'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { fieldCards } from '../../engine/field-move'
import { fieldMoveDestinations, moveFieldCard } from '../../engine/field-move'
import { handleEquipmentLost } from '../../engine/equipment'
import { dispatchEquipmentZoneLoss } from '../../engine/equipment-zone-loss'
import { equipmentSlotsForSkillUse, useEquipmentFromSkill } from '../../engine/skill-equipment-use'
import { effectiveKingdomOf } from '../../engine/huashen'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { grantSkill } from '../../engine/skills/runtime'
import { loseHp } from '../../engine/hp'
import { resumeJudgmentResult } from '../../engine/judgment'
import { beginJudgmentPhase } from '../../engine/judgment'
import { completeDiscardPhaseSelection } from '../../engine/phase'
import { flipCharacter } from '../../engine/character-state'
import { skipPhase } from '../../engine/turn'
import { startGroupDecision, registerGroupDecision } from '../../engine/group-decision'
import type { CardId, PlayerId, SanguoshaState, Suit, TurnPhase } from '../../engine/types'
import type { CharacterDefinition } from './types'

const B44 = '-b44'
const JIE_SHENSU = `jie-shensu${B44}`
const JIE_JUSHOU = `jie-jushou${B44}`
const JIE_JIEWEI = `jie-jiewei${B44}`
const JIE_TIANXIANG = `jie-tianxiang${B44}`
const JIE_HONGYAN = `jie-hongyan${B44}`
const SHUANGREN = `shuangren${B44}`
const SHENGXI = `shengxi${B44}`
const SHOUCHENG = `shoucheng${B44}`
const ZHENGRONG = `zhengrong${B44}`
const HONGJU = `hongju${B44}`
const QINGCE = `qingce${B44}`
const YONGSI = `yongsi${B44}`
const WEIDI = `weidi${B44}`
const FUHAI = `fuhai${B44}`
const TONGQU = `tongqu${B44}`
const WANLAN = `wanlan${B44}`

const RONG = `rong${B44}`
const JIE_SHENSU_PENDING = `jie-shensu-pending${B44}`
const YONGSI_DAMAGE = `yongsi-damage${B44}`
const YONGSI_HAND_LIMIT = `yongsi-hand-limit${B44}`
const ZHENGRONG_COUNT = `${ZHENGRONG}:uses`
const HONGJU_DRAWN = `${HONGJU}:drawn`
const TONGQU_MARK = `${TONGQU}:canal`
const TONGQU_DRAW_PENDING = `${TONGQU}:draw-pending`
const SHUANGREN_TAG = SHUANGREN
const FUHAI_TAG = FUHAI

function player(state: SanguoshaState, id: PlayerId) {
  return state.players.find((entry) => entry.id === id)
}

function aliveOthers(state: SanguoshaState, id: PlayerId) {
  return state.players.filter((entry) => entry.alive && entry.id !== id)
}

function ownedHandEquip(state: SanguoshaState, id: PlayerId): CardId[] {
  const owner = player(state, id)
  return owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((card): card is CardId => Boolean(card))] : []
}

function rongCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return player(state, ownerId)?.characterPiles[RONG] ?? []
}

function jieXiaoqiaoHearts(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return player(state, ownerId)?.zones.hand.filter((cardId) => effectiveCardSuit(state, ownerId, cardId) === 'heart') ?? []
}

export const HISTORICAL_BATCH42_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'jie-xiahouyuan-b44', name: '界·夏侯渊', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind', skills: [
    { id: JIE_SHENSU, name: '神速', description: '你可以做出如下选择：1.跳过判定阶段和摸牌阶段；2.跳过出牌阶段并弃置一张装备牌；3.跳过弃牌阶段并翻面。你每选择一项，便视为你使用一张无距离限制的【杀】。' },
  ] },
  { id: 'jie-caoren-b44', name: '界·曹仁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'wind', skills: [
    { id: JIE_JUSHOU, name: '据守', description: '结束阶段，你可以翻面并摸四张牌，然后弃置一张手牌，若以此法弃置的是装备牌，则你改为使用之。' },
    { id: JIE_JIEWEI, name: '解围', description: '你可以将装备区里的牌当【无懈可击】使用；当你从背面翻至正面时，你可以弃置一张手牌，然后移动场上的一张牌。' },
  ] },
  { id: 'jie-xiaoqiao-b44', name: '界·小乔', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'wind', skills: [
    { id: JIE_TIANXIANG, name: '天香', description: '当你受到伤害时，你可以弃置一张红桃手牌，防止此次伤害并选择一名其他角色，你选择一项：令其受到1点伤害，然后摸X张牌（X为其已损失体力值且至多为5）；令其失去1点体力，然后其获得你弃置的牌。' },
    { id: JIE_HONGYAN, name: '红颜', description: '锁定技，你的黑桃手牌只能当做红桃牌使用、打出、弃置或交给其他角色。你的黑桃判定牌只能当做红桃判定牌。当一张判定牌生效前，如果此判定牌为红桃，你将判定结果改为由你指定的一种花色。' },
  ] },
  { id: 'jiling-b44', name: '纪灵', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard', skills: [
    { id: SHUANGREN, name: '双刃', description: '出牌阶段开始时，你可以与一名角色拼点。若你赢，你视为对其或与其势力相同的另一名角色使用一张【杀】（不计次数）；若你没赢，你结束出牌阶段。' },
  ] },
  { id: 'jiangwanfeiyi-b44', name: '蒋琬费祎', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'yjcm2012', skills: [
    { id: SHENGXI, name: '生息', description: '弃牌阶段开始时，若你未于此回合内造成过伤害，你可以摸两张牌。' },
    { id: SHOUCHENG, name: '守成', description: '当与你势力相同的一名角色于其回合外失去手牌后，若该角色没有手牌，你可以令其摸一张牌。' },
  ] },
  { id: 'jie-wuguotai-b44', name: '界·吴国太', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'yjcm2011', skills: [
    { id: 'ganlu', name: '甘露', description: '出牌阶段限一次，你可以选择两名装备区里的牌数之差不大于你已损失的体力值的角色，交换他们装备区里的牌；若你选择的角色中含有你，则不受牌数之差的限制。' },
    { id: 'buyi', name: '补益', description: '当一名角色进入濒死状态时，你可以展示其一张手牌，然后若此牌不为基本牌，则该角色弃置此牌，然后回复1点体力。' },
  ] },
  { id: 'mao-qiujian-b44', name: '毌丘俭', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'yjcm2015', skills: [
    { id: ZHENGRONG, name: '征荣', description: '锁定技，每当你于你的出牌阶段对其他角色使用累计偶数张牌后，你选择一名其他角色，随机将其一张牌置于你的武将牌上，称为“荣”。' },
    { id: HONGJU, name: '鸿举', description: '觉醒技，准备阶段，若“荣”的数量不小于3且场上有角色死亡，则你摸等于“荣”数量的牌，然后以任意张手牌替换等量的“荣”，之后你扣减1点体力上限并获得技能“清侧”（出牌阶段，你可以移去一张“荣”，然后弃置场上的一张牌）。' },
    { id: QINGCE, name: '清侧', description: '出牌阶段，你可以移去一张“荣”，然后弃置场上的一张牌。', granted: true },
  ] },
  { id: 'zhongdi-yuanshu-b44', name: '仲帝袁术', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: YONGSI, name: '庸肆', description: '锁定技，摸牌阶段，你改为摸X张牌（X为存活势力数）；出牌阶段结束时，若你此阶段：1.没有造成伤害，将手牌摸至当前体力值；2.造成伤害数超过1点，本回合手牌上限改为已损失体力值。' },
    { id: WEIDI, name: '伪帝', description: '主公技，你于弃牌阶段弃置的牌可以交给任意名其他群雄角色各一张。' },
  ] },
  { id: 'weiwen-zhugezhi-b44', name: '卫温诸葛直', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: FUHAI, name: '浮海', description: '出牌阶段限一次，你可令所有其他角色同时声明“潮起”“潮落”中的一项，并依次展示结果。然后自你下家开始若选择了连续相同的结果，则你摸X张牌（X为自你下家开始连续相同结果的数量）。' },
  ] },
  { id: 'jia-kui-b44', name: '贾逵', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: TONGQU, name: '通渠', description: '游戏开始时，你拥有一个“渠”标记。准备阶段，你可以失去1点体力令一名没有“渠”标记的角色获得“渠”标记。有“渠”的角色摸牌阶段额外摸一张牌，然后将一张牌交给其他有“渠”的角色或弃置，若以此法给出的装备牌则使用之。当有“渠”的角色进入濒死状态时，移除其“渠”标记。' },
    { id: WANLAN, name: '挽澜', description: '当一名角色受到会令其进入濒死状态的伤害时，你可以弃置装备区中的所有牌（至少一张）防止此伤害。' },
  ] },
]

registerSkillRuntime({
  id: SHENGXI,
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const amount = Number((context.event.payload as { finalAmount?: unknown }).finalAmount ?? 0)
      if (context.event.sourceId === ownerId && amount > 0 && host.state.currentPlayerId === ownerId) {
        player(host.state, ownerId)!.marks[`${SHENGXI}:damaged`] = host.state.turnNumber
      }
    } },
    { event: 'DiscardPhase', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const owner = player(host.state, ownerId)
      if (!owner?.alive || owner.marks[`${SHENGXI}:damaged`] === host.state.turnNumber) return
      host.askSkill({ skillId: SHENGXI, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【生息】：是否摸两张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '摸两张牌' }, { id: 'no', label: '不发动' }],
      }) })
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (player(host.state, ownerId)?.alive) drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: SHOUCHENG,
  triggers: [{ event: 'LoseCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    const targetId = payload.playerId
    const owner = player(host.state, ownerId)
    const target = targetId ? player(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || target.id === ownerId || target.zones.hand.length !== 0 || host.state.currentPlayerId === target.id) return
    if (!payload.cardIds?.length || effectiveKingdomOf(host.state, ownerId) !== effectiveKingdomOf(host.state, target.id)) return
    host.askSkill({ skillId: SHOUCHENG, ownerId, step: 'invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: `【守成】：是否令${target.nickname}摸一张牌？`, timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '令其摸一张牌' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    if (player(host.state, targetId)?.alive && player(host.state, targetId)!.zones.hand.length === 0) {
      drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

registerSkillRuntime({
  id: JIE_SHENSU,
  triggers: [
    { event: 'JudgePhase', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || host.state.currentPlayerId !== ownerId || !aliveOthers(host.state, ownerId).length) return
      context.cancel()
      askShensuChoice(host, ownerId, 'judge')
    } },
    { event: 'PlayPhase', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId || host.state.currentPlayerId !== ownerId || !aliveOthers(host.state, ownerId).length || !ownedHandEquip(host.state, ownerId).some((id) => host.state.cards[id]?.category === 'equipment')) return
      askShensuChoice(host, ownerId, 'play')
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceSkillId?: string }
      if (context.event.sourceId !== ownerId || payload.sourceSkillId !== JIE_SHENSU) return
      const stageNumber = player(host.state, ownerId)?.marks[JIE_SHENSU_PENDING]
      if (stageNumber !== 1 && stageNumber !== 2 && stageNumber !== 3) return
      delete player(host.state, ownerId)!.marks[JIE_SHENSU_PENDING]
      const stage = stageNumber === 1 ? 'judge' : stageNumber === 2 ? 'play' : 'discard'
      host.queueSkill({ skillId: JIE_SHENSU, ownerId, step: 'advance', data: { stage } })
    } },
  ],
  offerPhaseSkip(host, ownerId, phase) {
    if (phase !== 'discard' || host.state.currentPlayerId !== ownerId || !aliveOthers(host.state, ownerId).length) return false
    host.askSkill({ skillId: JIE_SHENSU, ownerId, step: 'third-choice', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: '【神速】③：是否跳过弃牌阶段并翻面，视为使用一张无距离限制的【杀】？',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '跳过弃牌阶段并翻面' }, { id: 'no', label: '正常弃牌' }],
    }) })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'advance') return
    const stage = prompt.data.stage as string
    if (stage === 'judge') host.advancePhase()
    else if (stage === 'play') host.endPlayPhaseEarly(ownerId)
    else host.resumePhaseEntry()
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'third-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.resumePhaseEntry(); return }
      skipPhase(host.state, 'discard')
      flipCharacter(host, ownerId, JIE_SHENSU, true)
      askShensuTarget(host, ownerId, 'discard')
      return
    }
    if (resolution.step === 'choice') {
      const stage = resolution.data.stage as 'judge' | 'play'
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        if (stage === 'judge') beginJudgmentPhase(host as never)
        return
      }
      if (stage === 'judge') {
        skipPhase(host.state, 'draw')
        askShensuTarget(host, ownerId, stage)
      } else {
        const equipmentIds = ownedHandEquip(host.state, ownerId).filter((id) => host.state.cards[id]?.category === 'equipment')
        if (!equipmentIds.length) return
        host.askSkill({ skillId: JIE_SHENSU, ownerId, step: 'play-cost', data: { stage }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【神速】②：弃置一张装备牌并跳过出牌阶段',
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: equipmentIds, hiddenCardSlots: [], min: 1, max: 1,
        }) })
      }
      return
    }
    if (resolution.step === 'play-cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
      if (!cardId || !from || (from.kind !== 'hand' && from.kind !== 'equipment') || host.state.cards[cardId]?.category !== 'equipment') return
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
      else host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_SHENSU }, { sourceId: ownerId, cardIds: [cardId] })
      skipPhase(host.state, 'play')
      askShensuTarget(host, ownerId, 'play')
      return
    }
    if (resolution.step === 'target') {
      const stage = resolution.data.stage as 'judge' | 'play' | 'discard'
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !aliveOthers(host.state, ownerId).some((target) => target.id === targetId)) {
        host.queueSkill({ skillId: JIE_SHENSU, ownerId, step: 'advance', data: { stage } })
        return
      }
      player(host.state, ownerId)!.marks[JIE_SHENSU_PENDING] = stage === 'judge' ? 1 : stage === 'play' ? 2 : 3
      if (!host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JIE_SHENSU })) {
        host.queueSkill({ skillId: JIE_SHENSU, ownerId, step: 'advance', data: { stage } })
      }
    }
  },
})

function askShensuChoice(host: SkillHost, ownerId: PlayerId, stage: 'judge' | 'play'): void {
  host.askSkill({ skillId: JIE_SHENSU, ownerId, step: 'choice', data: { stage }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId,
    prompt: stage === 'judge' ? '【神速】①：是否跳过判定和摸牌阶段，视为使用一张无距离限制的【杀】？' : '【神速】②：是否弃置一张装备牌并跳过出牌阶段，视为使用一张无距离限制的【杀】？',
    timeoutMs: 20_000, optional: true,
    options: [{ id: 'yes', label: '发动神速' }, { id: 'no', label: '不发动' }],
  }) })
}

function askShensuTarget(host: SkillHost, ownerId: PlayerId, stage: 'judge' | 'play' | 'discard'): void {
  const targets = aliveOthers(host.state, ownerId)
  if (!targets.length) {
    host.queueSkill({ skillId: JIE_SHENSU, ownerId, step: 'advance', data: { stage } })
    return
  }
  host.askSkill({ skillId: JIE_SHENSU, ownerId, step: 'target', data: { stage }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: `【神速】：选择一名【杀】的目标`,
    timeoutMs: 20_000, optional: false, candidateIds: targets.map((target) => target.id), min: 1, max: 1,
  }) })
}

registerSkillRuntime({
  id: JIE_HONGYAN,
  cardSuit(_state, _ownerId, _cardId, suit) { return suit === 'spade' ? 'heart' : suit },
  beforeJudgmentResult(host, ownerId, cardId, suit) {
    if (suit !== 'heart' || !host.state.retrial || !player(host.state, ownerId)?.alive) return false
    host.askSkill({ skillId: JIE_HONGYAN, ownerId, step: 'result-suit', data: { cardId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【红颜】：将这张红桃判定牌的结果改为一种花色',
      timeoutMs: 20_000, optional: false,
      options: [
        { id: 'spade', label: '黑桃' }, { id: 'heart', label: '红桃' },
        { id: 'club', label: '梅花' }, { id: 'diamond', label: '方块' },
      ],
    }) })
    return true
  },
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'result-suit') return
    const suit = (response.payload as { optionId?: string }).optionId
    if (suit !== 'spade' && suit !== 'heart' && suit !== 'club' && suit !== 'diamond') throw new Error('红颜选择的判定花色非法')
    resumeJudgmentResult(host as never, suit as Suit)
  },
})

registerSkillRuntime({
  id: JIE_JUSHOU,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !player(host.state, ownerId)?.alive) return
    host.askSkill({ skillId: JIE_JUSHOU, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【据守】：是否翻面并摸四张牌，然后弃置一张手牌（装备牌改为使用）？',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动据守' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      flipCharacter(host, ownerId, JIE_JUSHOU)
      drawCards(host.state, host.rng, ownerId, 4, (name, payload) => { host.dispatch(name, payload) })
      const hand = player(host.state, ownerId)?.zones.hand ?? []
      if (!hand.length) return
      host.askSkill({ skillId: JIE_JUSHOU, ownerId, step: 'discard', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【据守】：选择一张手牌弃置；若为装备牌则改为使用',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'discard') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = player(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      if (host.state.cards[cardId]?.category !== 'equipment') {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_JUSHOU }, { sourceId: ownerId, cardIds: [cardId] })
        return
      }
      const slots = equipmentSlotsForSkillUse(host.state, ownerId, cardId)
      if (!slots.length) { discardJushouCost(host, ownerId, cardId); return }
      if (slots.length === 1) {
        if (!useEquipmentFromSkill(host as never, ownerId, cardId, slots[0])) discardJushouCost(host, ownerId, cardId)
        return
      }
      host.askSkill({ skillId: JIE_JUSHOU, ownerId, step: 'equip-slot', data: { cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【据守】：选择装备栏使用此装备',
        timeoutMs: 20_000, optional: false, options: slots.map((slot) => ({ id: slot, label: slot === 'weapon2' ? '副武器栏' : '武器栏' })),
      }) })
      return
    }
    if (resolution.step !== 'equip-slot') return
    const cardId = resolution.data.cardId as CardId
    const slot = (response.payload as { optionId?: string }).optionId as any
    if (!equipmentSlotsForSkillUse(host.state, ownerId, cardId).includes(slot) || !useEquipmentFromSkill(host as never, ownerId, cardId, slot)) {
      discardJushouCost(host, ownerId, cardId)
    }
  },
})

function discardJushouCost(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  const owner = player(host.state, ownerId)
  if (!owner?.zones.hand.includes(cardId)) return
  moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_JUSHOU }, { sourceId: ownerId, cardIds: [cardId] })
}

registerSkillRuntime({
  id: JIE_JIEWEI,
  viewAs(state, ownerId) {
    const owner = player(state, ownerId)
    if (!owner?.alive) return []
    return Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)).map((cardId) => ({
      asCardName: '无懈可击', cardId, label: `将装备区的【${state.cards[cardId]?.name ?? '装备牌'}】当【无懈可击】使用`,
    }))
  },
  triggers: [{ event: 'CharacterFlip', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; faceDown?: boolean }
    if (payload.playerId !== ownerId || payload.faceDown !== false || !player(host.state, ownerId)?.alive) return
    const movable = fieldCards(host.state).some((card) => fieldMoveDestinations(host.state, card.cardId).length > 0)
    if (!player(host.state, ownerId)!.zones.hand.length || !movable) return
    host.askSkill({ skillId: JIE_JIEWEI, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【解围】：是否弃置一张手牌并移动场上的一张牌？',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动解围' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const hand = player(host.state, ownerId)?.zones.hand ?? []
      if (!hand.length) return
      host.askSkill({ skillId: JIE_JIEWEI, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【解围】：弃置一张手牌', timeoutMs: 20_000,
        optional: false, purpose: 'skill', cardIds: [...hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !player(host.state, ownerId)?.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_JIEWEI }, { sourceId: ownerId, cardIds: [cardId] })
      const candidates = fieldCards(host.state).filter((card) => fieldMoveDestinations(host.state, card.cardId).length > 0)
      if (!candidates.length) return
      host.askSkill({ skillId: JIE_JIEWEI, ownerId, step: 'field-card', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【解围】：选择一张场上的装备牌或延时锦囊牌移动',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: candidates.map((card) => card.cardId), hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'field-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const destinations = cardId ? fieldMoveDestinations(host.state, cardId) : []
      if (!cardId || !destinations.length) return
      host.askSkill({ skillId: JIE_JIEWEI, ownerId, step: 'destination', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【解围】：选择此牌移动到的角色',
        timeoutMs: 20_000, optional: false, candidateIds: destinations, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'destination') return
    const cardId = resolution.data.cardId as CardId
    const toPlayerId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (toPlayerId && fieldMoveDestinations(host.state, cardId).includes(toPlayerId)) moveFieldCard(host as never, cardId, toPlayerId)
  },
})

registerSkillRuntime({
  id: JIE_TIANXIANG,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (context.targetId !== ownerId || host.state.dying || !player(host.state, ownerId)?.alive) return false
    if (!jieXiaoqiaoHearts(host.state, ownerId).length || !aliveOthers(host.state, ownerId).length) return false
    host.queueSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'invoke', data: { targetId: context.targetId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'after-damage') {
      const target = player(host.state, prompt.data.targetId as PlayerId)
      const owner = player(host.state, ownerId)
      const count = target ? Math.min(5, Math.max(0, target.maxHp - target.hp)) : 0
      if (owner?.alive && count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    if (prompt.step === 'after-lose-hp') {
      const targetId = prompt.data.targetId as PlayerId
      const cardId = prompt.data.cardId as CardId
      const target = player(host.state, targetId)
      if (target?.alive && !target.zones.hand.includes(cardId) && host.state.zones.discardPile.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: targetId })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: JIE_TIANXIANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
      return
    }
    if (prompt.step !== 'invoke') return
    if (!player(host.state, ownerId)?.alive || !host.state.pendingTargetDamage) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    host.askSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【天香】：是否弃置一张红桃手牌防止此伤害？',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动天香' }, { id: 'no', label: '承受伤害' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { resumeTargetDamagePrevention(host as never, false); return }
      const cardIds = jieXiaoqiaoHearts(host.state, ownerId)
      if (!cardIds.length || !host.state.pendingTargetDamage) { resumeTargetDamagePrevention(host as never, false); return }
      host.askSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【天香】：弃置一张红桃手牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !jieXiaoqiaoHearts(host.state, ownerId).includes(cardId)) { resumeTargetDamagePrevention(host as never, false); return }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_TIANXIANG }, { sourceId: ownerId, cardIds: [cardId] })
      const candidateIds = aliveOthers(host.state, ownerId).map((entry) => entry.id)
      if (!candidateIds.length || !host.state.pendingTargetDamage) { resumeTargetDamagePrevention(host as never, false); return }
      host.askSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'target', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【天香】：选择一名其他角色',
        timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !aliveOthers(host.state, ownerId).some((entry) => entry.id === targetId) || !host.state.pendingTargetDamage) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
      host.askSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'effect', data: { ...resolution.data, targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【天香】：选择对目标角色的效果',
        timeoutMs: 20_000, optional: false,
        options: [{ id: 'damage', label: '令其受到1点伤害，然后你摸其已损失体力值张牌（至多5张）' }, { id: 'lose-hp', label: '令其失去1点体力，然后其获得弃置的红桃牌' }],
      }) })
      return
    }
    if (resolution.step !== 'effect') return
    const targetId = resolution.data.targetId as PlayerId
    const cardId = resolution.data.cardId as CardId
    const target = player(host.state, targetId)
    const owner = player(host.state, ownerId)
    const choice = (response.payload as { optionId?: string }).optionId
    if (!owner?.alive || !target?.alive || !host.state.pendingTargetDamage) { resumeTargetDamagePrevention(host as never, false); return }
    // 先终止原伤害，再执行天香后续，避免一笔尚未续接的伤害上重入第二笔伤害。
    resumeTargetDamagePrevention(host as never, true, JIE_TIANXIANG)
    if (choice === 'damage') {
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '天香' })
      host.queueSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'after-damage', data: { targetId } })
    } else if (choice === 'lose-hp') {
      loseHp(host as never, targetId, 1, JIE_TIANXIANG)
      host.queueSkill({ skillId: JIE_TIANXIANG, ownerId, step: 'after-lose-hp', data: { targetId, cardId } })
    }
  },
})

registerSkillRuntime({
  id: YONGSI,
  triggers: [
    { event: 'DrawPhase', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      if (payload.playerId === ownerId) payload.count = livingKingdomCount(host.state)
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId === ownerId && payload.phase === 'play') player(host.state, ownerId)!.marks[YONGSI_DAMAGE] = 0
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      if (context.event.sourceId === ownerId && host.state.currentPlayerId === ownerId && host.state.phase === 'play') {
        const owner = player(host.state, ownerId)
        if (owner && Number(payload.finalAmount ?? 0) > 0) owner.marks[YONGSI_DAMAGE] = (owner.marks[YONGSI_DAMAGE] ?? 0) + Number(payload.finalAmount)
      }
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const owner = player(host.state, ownerId)
      if (!owner?.alive || payload.playerId !== ownerId || payload.phase !== 'play') return
      const damage = owner.marks[YONGSI_DAMAGE] ?? 0
      if (damage === 0) {
        const count = Math.max(0, owner.hp - owner.zones.hand.length)
        if (count) drawCards(host.state, host.rng, ownerId, count, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      } else if (damage > 1) owner.marks[YONGSI_HAND_LIMIT] = host.state.turnNumber
    } },
    { event: 'TurnEnd', handle(host, ownerId) {
      const owner = player(host.state, ownerId)
      if (owner) { delete owner.marks[YONGSI_DAMAGE]; delete owner.marks[YONGSI_HAND_LIMIT] }
    } },
  ],
  fixedMaxCards(state, ownerId) {
    const owner = player(state, ownerId)
    return owner?.marks[YONGSI_HAND_LIMIT] === state.turnNumber ? Math.max(0, owner.maxHp - owner.hp) : null
  },
})

registerSkillRuntime({
  id: SHUANGREN,
  triggers: [{ event: 'PlayPhase', handle(host, ownerId, context) {
    if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
    if (!canPindian(host.state, ownerId) || !aliveOthers(host.state, ownerId).some((target) => canPindian(host.state, target.id))) return
    host.askSkill({ skillId: SHUANGREN, ownerId, step: 'ask', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【双刃】：是否与一名角色拼点？若没赢则结束出牌阶段。',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动双刃' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'slash-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const opponentId = resolution.data.opponentId as PlayerId
      const faction = effectiveKingdomOf(host.state, opponentId)
      if (!targetId || !player(host.state, ownerId)?.alive || !aliveOthers(host.state, ownerId).some((candidate) =>
        candidate.id === targetId && (candidate.id === opponentId || effectiveKingdomOf(host.state, candidate.id) === faction)
          && canTarget(host.state, ownerId, candidate.id),
      )) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: SHUANGREN })
      return
    }
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidates = aliveOthers(host.state, ownerId).filter((target) => canPindian(host.state, target.id)).map((target) => target.id)
      if (!candidates.length) return
      host.askSkill({ skillId: SHUANGREN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【双刃】：选择一名有手牌的角色拼点',
        timeoutMs: 20_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !aliveOthers(host.state, ownerId).some((entry) => entry.id === targetId && canPindian(host.state, entry.id))) return
    startPindian(host, { id: `shuangren-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId, reason: SHUANGREN, continuationTag: SHUANGREN_TAG })
  },
})

registerPindianContinuation(SHUANGREN_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const owner = player(host.state, result.initiatorId)
  const opponent = player(host.state, result.opponentId)
  if (!owner?.alive || !opponent?.alive) return
  if (result.outcome !== 'initiator-win') {
    skillHost.endPlayPhaseEarly(owner.id)
    return
  }
  const faction = effectiveKingdomOf(host.state, opponent.id)
  const targets = aliveOthers(host.state, owner.id).filter((candidate) =>
    (candidate.id === opponent.id || effectiveKingdomOf(host.state, candidate.id) === faction)
      && canTarget(host.state, owner.id, candidate.id),
  )
  if (!targets.length) return
  skillHost.askSkill({ skillId: SHUANGREN, ownerId: owner.id, step: 'slash-target', data: { opponentId: opponent.id }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: owner.id, prompt: '【双刃】：选择【杀】的目标（拼点对象或与其势力相同的角色）',
    timeoutMs: 20_000, optional: false, candidateIds: targets.map((entry) => entry.id), min: 1, max: 1,
  }) })
})

registerGroupDecision(FUHAI_TAG, (groupHost, decision) => {
  const host = groupHost as unknown as SkillHost
  const ownerId = decision.data.ownerId as PlayerId
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  const first = decision.playerIds[0]
  if (!first) return
  const firstChoice = decision.responses[first]
  let count = 0
  for (const playerId of decision.playerIds) {
    if (decision.responses[playerId] !== firstChoice) break
    count += 1
  }
  if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
})

registerSkillRuntime({
  id: FUHAI,
  activeActions(state, ownerId) {
    const owner = player(state, ownerId)
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner?.alive || usedThisPhase(state, ownerId, FUHAI)) return []
    return [{ id: `skill:${FUHAI}`, label: '发动【浮海】：令所有其他角色同时选择潮起或潮落' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${FUHAI}`) throw new Error('浮海动作不匹配')
    const owner = player(host.state, ownerId)
    if (!owner?.alive || usedThisPhase(host.state, ownerId, FUHAI)) return
    markUsedThisPhase(host.state, ownerId, FUHAI)
    const playerIds = aliveOthers(host.state, ownerId).sort((left, right) => {
      const leftOffset = (left.seat - owner.seat + host.state.players.length) % host.state.players.length
      const rightOffset = (right.seat - owner.seat + host.state.players.length) % host.state.players.length
      return leftOffset - rightOffset
    }).map((entry) => entry.id)
    startGroupDecision(host, {
      id: `fuhai-${host.state.seq}`, tag: FUHAI_TAG, skillId: FUHAI, playerIds,
      prompt: '【浮海】：秘密选择“潮起”或“潮落”',
      options: [{ id: 'rise', label: '潮起' }, { id: 'fall', label: '潮落' }],
      defaultOptionId: 'rise', timeoutMs: 20_000, data: { ownerId },
    })
  },
})

registerSkillRuntime({
  id: ZHENGRONG,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (payload.playerId === ownerId && payload.phase === 'play') player(host.state, ownerId)!.marks[ZHENGRONG_COUNT] = 0
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      if (!(payload.targetIds ?? []).some((targetId) => targetId !== ownerId && player(host.state, targetId)?.alive)) return
      const owner = player(host.state, ownerId)
      if (!owner) return
      owner.marks[ZHENGRONG_COUNT] = (owner.marks[ZHENGRONG_COUNT] ?? 0) + 1
      if (owner.marks[ZHENGRONG_COUNT] % 2 !== 0) return
      const targetAvailable = aliveOthers(host.state, ownerId).some((target) => ownedHandEquip(host.state, target.id).length > 0)
      if (targetAvailable) host.queueSkill({ skillId: ZHENGRONG, ownerId, step: 'target', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target' || !player(host.state, ownerId)?.alive) return
    const candidateIds = aliveOthers(host.state, ownerId).filter((target) => ownedHandEquip(host.state, target.id).length > 0).map((target) => target.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: ZHENGRONG, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【征荣】：选择一名有手牌或装备牌的其他角色，随机获得其一张牌置为“荣”',
      timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? player(host.state, targetId) : undefined
    const pool = targetId ? ownedHandEquip(host.state, targetId) : []
    if (!target?.alive || target.id === ownerId || !pool.length) return
    const cardId = host.rng.pick(pool)
    const from = locateOwnedCard(host.state, target.id, cardId)
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) return
    moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: RONG })
    if (from.kind === 'equipment') handleEquipmentLost(host, target.id, cardId)
    host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: ZHENGRONG }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: ZHENGRONG, targetId: target.id, cardId, mark: '荣' }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: HONGJU,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      return rongCards(state, ownerId).length >= 3 && state.players.some((entry) => !entry.alive)
    },
    invoke(host, ownerId) {
      const owner = player(host.state, ownerId)
      if (!owner?.alive) return
      const count = rongCards(host.state, ownerId).length
      const drawn = drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) }).length
      owner.marks[HONGJU_DRAWN] = Math.min(drawn, rongCards(host.state, ownerId).length)
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: HONGJU, drawn }, { sourceId: ownerId })
      askHongjuHand(host, ownerId)
    },
  },
  resume(host, ownerId, resolution, response) {
    const owner = player(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'replace-hand') {
      const drawn = owner.marks[HONGJU_DRAWN] ?? 0
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardIds.length > drawn || cardIds.some((id) => !owner.zones.hand.includes(id))) return
      if (!cardIds.length) { finishHongju(host, ownerId); return }
      host.askSkill({ skillId: HONGJU, ownerId, step: 'replace-rong', data: { handCardIds: cardIds }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【鸿举】：选择${cardIds.length}张“荣”与所选手牌交换`,
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: rongCards(host.state, ownerId), hiddenCardSlots: [], min: cardIds.length, max: cardIds.length,
      }) })
      return
    }
    if (resolution.step !== 'replace-rong') return
    const handCardIds = (resolution.data.handCardIds as CardId[]) ?? []
    const rongIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const pile = rongCards(host.state, ownerId)
    if (handCardIds.length !== rongIds.length || handCardIds.some((id) => !owner.zones.hand.includes(id)) || rongIds.some((id) => !pile.includes(id))) return
    for (let index = 0; index < handCardIds.length; index += 1) {
      moveCard(host.state, handCardIds[index], { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: RONG })
      moveCard(host.state, rongIds[index], { kind: 'characterPile', playerId: ownerId, pile: RONG }, { kind: 'hand', playerId: ownerId })
    }
    if (rongIds.length) host.dispatch('GainCard', { playerId: ownerId, cardIds: rongIds, reason: HONGJU }, { sourceId: ownerId, targetId: ownerId, cardIds: rongIds })
    finishHongju(host, ownerId)
  },
})

function askHongjuHand(host: SkillHost, ownerId: PlayerId): void {
  const owner = player(host.state, ownerId)
  const count = owner?.marks[HONGJU_DRAWN] ?? 0
  if (!owner?.alive || count <= 0) { finishHongju(host, ownerId); return }
  host.askSkill({ skillId: HONGJU, ownerId, step: 'replace-hand', build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【鸿举】：可选择至多${count}张手牌与等量“荣”交换`,
    timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(count, owner.zones.hand.length),
  }) })
}

function finishHongju(host: SkillHost, ownerId: PlayerId): void {
  const owner = player(host.state, ownerId)
  if (!owner?.alive) return
  delete owner.marks[HONGJU_DRAWN]
  loseMaxHp(host as never, ownerId, 1, HONGJU)
  grantSkill(host.state, ownerId, QINGCE)
  host.dispatch('SkillActivated', { playerId: ownerId, skillId: HONGJU, grantedSkillId: QINGCE }, { sourceId: ownerId })
}

registerSkillRuntime({
  id: QINGCE,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || rongCards(state, ownerId).length === 0) return []
    return fieldCards(state).some((card) => card.ownerId !== ownerId)
      ? [{ id: `skill:${QINGCE}`, label: '发动【清侧】：移去一张“荣”，弃置其他角色场上的一张牌' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${QINGCE}`) throw new Error('清侧动作不匹配')
    const pile = rongCards(host.state, ownerId)
    if (!pile.length || !fieldCards(host.state).some((card) => card.ownerId !== ownerId)) return
    host.askSkill({ skillId: QINGCE, ownerId, step: 'cost', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【清侧】：移去一张“荣”', timeoutMs: 20_000,
      optional: false, purpose: 'skill', cardIds: pile, hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !rongCards(host.state, ownerId).includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: RONG }, { kind: 'discardPile' })
      const candidates = fieldCards(host.state).filter((card) => card.ownerId !== ownerId).map((card) => card.cardId)
      if (!candidates.length) return
      host.askSkill({ skillId: QINGCE, ownerId, step: 'field-card', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【清侧】：选择一张其他角色装备区或判定区里的牌弃置',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step !== 'field-card') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const card = cardId ? fieldCards(host.state).find((entry) => entry.cardId === cardId && entry.ownerId !== ownerId) : undefined
    if (!cardId || !card) return
    const from = card.slot
      ? { kind: 'equipment' as const, playerId: card.ownerId, slot: card.slot }
      : { kind: 'judgingArea' as const, playerId: card.ownerId }
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (card.slot) handleEquipmentLost(host, card.ownerId, cardId)
    host.dispatch('LoseCard', { playerId: card.ownerId, cardIds: [cardId], reason: QINGCE }, { sourceId: ownerId, targetId: card.ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: QINGCE, targetId: card.ownerId, cardId }, { sourceId: ownerId, targetId: card.ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: TONGQU,
  onGameStart(_host, ownerId) {
    const owner = player(_host.state, ownerId)
    if (owner?.alive) owner.marks[TONGQU_MARK] = 1
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      if (event.playerId !== ownerId || event.phase !== 'prepare' || !player(host.state, ownerId)?.alive) return
      const candidates = host.state.players.filter((target) => target.alive && !target.marks[TONGQU_MARK])
      if (!candidates.length) return
      host.askSkill({ skillId: TONGQU, ownerId, step: 'channel-invoke', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【通渠】：是否失去1点体力令一名角色获得“渠”？',
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '失去1点体力并开渠' }, { id: 'no', label: '不发动' }],
      }) })
    } },
    { event: 'DrawPhase', handle(host, _ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; count?: number }
      const drawer = event.playerId ? player(host.state, event.playerId) : undefined
      if (drawer?.marks[TONGQU_MARK]) {
        event.count = Number(event.count ?? 2) + 1
        drawer.marks[TONGQU_DRAW_PENDING] = 1
      }
    } },
    { event: 'PhaseEnd', handle(host, _ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: TurnPhase }
      const drawer = event.playerId ? player(host.state, event.playerId) : undefined
      if (event.phase !== 'draw' || !drawer?.marks[TONGQU_DRAW_PENDING]) return
      delete drawer.marks[TONGQU_DRAW_PENDING]
      if (!drawer.zones.hand.length) return
      host.askSkill({ skillId: TONGQU, ownerId: drawer.id, step: 'give-card', build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: drawer.id, prompt: '【通渠】：选择一张手牌交给其他有“渠”的角色，或随后弃置',
        timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...drawer.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
    } },
    { event: 'EnterDying', handle(host, _ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      const target = targetId ? player(host.state, targetId) : undefined
      if (target) delete target.marks[TONGQU_MARK]
    } },
  ],
  resume(host, ownerId, resolution, response) {
    const owner = player(host.state, ownerId)
    if (resolution.step === 'channel-invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) return
      const candidates = host.state.players.filter((target) => target.alive && !target.marks[TONGQU_MARK])
      if (!candidates.length) return
      host.askSkill({ skillId: TONGQU, ownerId, step: 'channel-target', build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【通渠】：选择一名没有“渠”的角色', timeoutMs: 20_000,
        optional: false, candidateIds: candidates.map((target) => target.id), min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'channel-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.marks[TONGQU_MARK]) return
      loseHp(host as never, ownerId, 1, TONGQU)
      if (target.alive) target.marks[TONGQU_MARK] = 1
      return
    }
    if (resolution.step === 'give-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const candidates = aliveOthers(host.state, ownerId).filter((target) => target.marks[TONGQU_MARK])
      host.askSkill({ skillId: TONGQU, ownerId, step: 'give-target', data: { cardId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【通渠】：选择一名有“渠”的其他角色（不选则弃置）',
        timeoutMs: 20_000, optional: true, candidateIds: candidates.map((target) => target.id), min: 0, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give-target') {
      const cardId = resolution.data.cardId as CardId
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? player(host.state, targetId) : undefined
      if (!owner?.zones.hand.includes(cardId)) return
      if (!targetId || !target?.alive || !target.marks[TONGQU_MARK] || target.id === ownerId) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: TONGQU }, { sourceId: ownerId, cardIds: [cardId] })
        return
      }
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: TONGQU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: TONGQU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: target.id, cardIds: [cardId], reason: TONGQU }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
      if (host.state.cards[cardId]?.category !== 'equipment') return
      const slots = equipmentSlotsForSkillUse(host.state, target.id, cardId)
      if (!slots.length) return
      if (slots.length === 1) { useEquipmentFromSkill(host as never, target.id, cardId, slots[0]); return }
      host.askSkill({ skillId: TONGQU, ownerId: target.id, step: 'equip-slot', data: { cardId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: target.id, prompt: '【通渠】：选择装备栏使用获得的装备牌', timeoutMs: 20_000, optional: false,
        options: slots.map((slot) => ({ id: slot, label: slot })),
      }) })
      return
    }
    if (resolution.step === 'equip-slot') {
      const cardId = resolution.data.cardId as CardId
      const slot = (response.payload as { optionId?: string }).optionId
      if (slot && equipmentSlotsForSkillUse(host.state, ownerId, cardId).includes(slot as never)) useEquipmentFromSkill(host as never, ownerId, cardId, slot as never)
    }
  },
})

registerSkillRuntime({
  id: WANLAN,
  offersGlobalDamagePreventionAsk(host, ownerId, context) {
    const target = player(host.state, context.targetId)
    const owner = player(host.state, ownerId)
    if (!target || target.hp > context.amount || !owner || !Object.values(owner.zones.equipment).some(Boolean)) return false
    host.queueSkill({ skillId: WANLAN, ownerId, step: 'invoke', data: { targetId: context.targetId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const targetId = prompt.data.targetId as PlayerId
    const equipment = player(host.state, ownerId)?.zones.equipment
    if (!player(host.state, ownerId)?.alive || !player(host.state, targetId)?.alive || !equipment || !Object.values(equipment).some(Boolean)) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    host.askSkill({ skillId: WANLAN, ownerId, step: 'invoke', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【挽澜】：是否弃置装备区里的所有牌防止此次令其濒死的伤害？',
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '弃置所有装备并防止伤害' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') { resumeTargetDamagePrevention(host as never, false); return }
    const owner = player(host.state, ownerId)
    const equipment = owner?.zones.equipment
    const cardIds = equipment ? Object.values(equipment).filter((id): id is CardId => Boolean(id)) : []
    if (!cardIds.length || !player(host.state, resolution.data.targetId as PlayerId)?.alive) { resumeTargetDamagePrevention(host as never, false); return }
    for (const [slot, cardId] of Object.entries(equipment!)) {
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot: slot as never }, { kind: 'discardPile' })
    }
    for (const cardId of cardIds) handleEquipmentLost(host as never, ownerId, cardId, { batched: true })
    dispatchEquipmentZoneLoss(host as never, ownerId, cardIds)
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: WANLAN }, { sourceId: ownerId, cardIds })
    resumeTargetDamagePrevention(host as never, true, WANLAN)
  },
})

registerSkillRuntime({
  id: WEIDI,
  lord: true,
  interceptDiscardPhaseSelection(host, ownerId, request, response) {
    const lord = player(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const candidates = aliveOthers(host.state, ownerId).filter((target) => effectiveKingdomOf(host.state, target.id) === 'qun')
    if (lord?.identity !== 'lord' || !selected.length || !candidates.length) return false
    host.askSkill({ skillId: WEIDI, ownerId, step: 'recipients', data: { selectedCardIds: selected, discardRequestId: request.id }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【伪帝】：可将所选弃牌各交给一名不同的其他群雄角色（未分配的牌正常弃置）',
      timeoutMs: 20_000, optional: true, candidateIds: candidates.map((target) => target.id), min: 0, max: Math.min(selected.length, candidates.length),
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'recipients') return
    const selected = resolution.data.selectedCardIds as CardId[]
    const targets = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const candidates = aliveOthers(host.state, ownerId).filter((target) => effectiveKingdomOf(host.state, target.id) === 'qun').map((target) => target.id)
    const discardRequest = { id: resolution.data.discardRequestId as string, playerId: ownerId } as ChooseCardsRequest
    const discardResponse = { requestId: discardRequest.id, playerId: ownerId, payload: { cardIds: selected } } as never
    const valid = new Set(targets).size === targets.length && targets.length <= selected.length && targets.every((id) => candidates.includes(id))
    completeDiscardPhaseSelection(host as never, discardRequest, discardResponse, valid ? targets : [])
  },
})

// 其余技能运行时在本文件后续区段注册；角色池导入发生在本批代码完整之后。

// 其余技能运行时在本文件后续区段注册；角色池导入发生在本批代码完整之后。
