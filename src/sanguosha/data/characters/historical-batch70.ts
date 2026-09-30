import type { CharacterDefinition } from './types'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { ArrangeCardsRequest, ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse, UseCardRequest } from '../../engine/requests'
import { registerSkillRuntime, effectiveCardColor, getSkillRuntime, grantSkill, replaceTemporarySkills, isCardUseProhibited, isTargetProhibited, type SkillHost } from '../../engine/skills/runtime'
import { isSkillSuppressed, suppressSkill } from '../../engine/skill-suppression'
import { drawCards } from '../../engine/draw'
import { giveOwnedCards, giveCards } from '../../engine/hand-transfer'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { setCurrentHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { moveCard, setCardAlias } from '../../engine/zones'
import { executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import type { LegalAction } from '../../engine/actions'
import type { EventContext, GameEventName } from '../../engine/events'
import type { TargetedCardContext } from '../../engine/skills/runtime'
import { getDistance, getAttackRange, canTarget } from '../../engine/distance'
import { locateOwnedCard } from '../../engine/zones'
import { skillIdByCharacterAndName, skillIdsOf } from './standard'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { scheduleExtraPhaseForPlayer } from '../../engine/extra-phase'
import { hiddenHandSlot } from '../../engine/cards/host'
import { resolvePickedCard } from '../../engine/card-pick'
import { registerGroupCardDecision, startGroupCardDecision } from '../../engine/group-card-decision'
import { resolveDamage } from '../../engine/damage'
import { loseHp } from '../../engine/hp'
import { discardCardsByIds } from '../../engine/discard-all'
import { reshuffleDrawPile } from '../../engine/deck'
import { isSoleTargetOf } from '../../engine/card-use-targets'
import { redirectCurrentCardTarget } from '../../engine/target-cancellation'
import { healthColorOf, type HealthColor } from '../../engine/health-color'
import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { flipCharacter } from '../../engine/character-state'
import { killPlayer } from '../../engine/damage'
import { loseMaxHp } from '../../engine/hp'
import { queueExtraTurn } from '../../engine/turn'
import { applySeatPermutation } from '../../engine/seat-permutation'
import { setCardColorOverride } from '../../engine/card-color'
import { ALL_CARD_INFO } from '../ruleset-v1/card-info'

const B = '-b70'
const sid = (name: string) => `${name}${B}`
type MoSunquanRecord = {
  choiceRound: number
  choices: Record<PlayerId, string>
  usedChoices: Record<PlayerId, string[]>
  usedTianEn: { turnNumber: number; options: string[] }
  exemptSlashIds: CardId[]
  demon: boolean
}
type B70State = SanguoshaState & { b70?: {
  simayi?: Record<PlayerId, { recordedNames: string[]; flashIds: CardId[]; observedHp: number; used: { turnNumber: number; names: string[] }; transformed: boolean; damagedThisRound: PlayerId[]; dealtDamageThisRound: boolean; slashQueue: PlayerId[] }>
  lubu?: Record<PlayerId, { qiCardIds: CardId[]; pairedTargetId?: PlayerId; pairedHitTurn: number; pairedHitUsed: boolean; transformed: boolean; lastCardWasQi: boolean; qiDamageTurn: number; qiDamagedTargets: PlayerId[] }>
  caocao?: Record<PlayerId, { demon: boolean; demonTurn: number; noNonBasicRecipients: PlayerId[] }>
  diaochan?: Record<PlayerId, { controlled: Record<PlayerId, { turnNumber: number; usesLeft: number }>; demon: boolean; taggedCards: Record<CardId, PlayerId>; usedTaggedCards: Record<CardId, boolean>; redirectedCards: Record<CardId, boolean> }>
  zhanghu?: Record<PlayerId, { redTrick: boolean; redBasic: boolean; exchangeRemoved: boolean; targetId?: PlayerId }>
  qingshi?: Record<PlayerId, { turnNumber: number; names: string[]; disabled: boolean }>
  qingshiDamage?: Record<CardId, PlayerId>
  zhizheCopies?: Record<CardId, { ownerId: PlayerId; returnPending: boolean; blockedTurn?: number }>
  moZhangfei?: Record<PlayerId, { transformed: boolean; slashDuelDamage: number; seenColors: Record<PlayerId, HealthColor[]>; greenDrawTargets: Record<PlayerId, boolean> }>
  moSunquan?: Record<PlayerId, MoSunquanRecord>
  shenDengAi?: Record<PlayerId, { damageCount: number; developed: string[]; awakened: boolean; cardOrigins: Record<CardId, string> }>
  shenZhangfei?: Record<PlayerId, { usesThisPhase: number; phaseKey: string; extraUseCap: number }>
  shenZhangfeiHandledEvents?: Record<string, true>
  shenZhangfeiPenalizingPlayers?: Record<PlayerId, true>
} }
const stateOf = (state: SanguoshaState) => (state as B70State).b70 ??= {}
const playerOf = (state: SanguoshaState, id: PlayerId) => state.players.find((player) => player.id === id)
const living = (state: SanguoshaState) => state.players.filter((player) => player.alive)
function moZhangfeiRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).moZhangfei ??= {}
  return records[ownerId] ??= {
    transformed: false,
    slashDuelDamage: 0,
    seenColors: Object.fromEntries(state.players.map((player) => [player.id, [healthColorOf(player.hp, player.maxHp)]])),
    greenDrawTargets: {},
  }
}
const ZHANGHU_CUIJIAN = sid('cuijian-zhanghu')
const ZHANGHU_TONGYUAN = sid('tongyuan-zhanghu')
const WUZHUGE_JINCU = sid('jincui-wuzhuge')
const WUZHUGE_QINGSHI = sid('qingshi-wuzhuge')
const WUZHUGE_ZHIZHE = sid('zhizhe-wuzhuge')
const MO_SIMAYI_GUIFU = sid('guifu-mosimayi')
const MO_SIMAYI_MOUBIAN = sid('moubian-mosimayi')
const MO_SIMAYI_ZOUXI = sid('zouxie-mosimayi')
const MO_LUBU_KUANGMO = sid('kuangmo-molubu')
const MO_LUBU_DUOQI = sid('duoqi-molubu')
const MO_LUBU_GANGQUAN = sid('gangquan-molubu')
const MO_CAOCAO_FUZAI = sid('fuzai-mocaocao')
const MO_CAOCAO_BACHAO = sid('bachao-mocaocao')
const MO_CAOCAO_GROUP = sid('bachao-mocaocao-group')
const MO_DIAOCHAN_HUANHUO = sid('huanhuo-modiaochan')
const MO_DIAOCHAN_QINGSHI = sid('qingshi-modiaochan')
const MO_ZHANGFEI_JIAOHUN = sid('jiaohun-mozhangfei')
const MO_ZHANGFEI_CHENSHI = sid('chenshi-mozhangfei')
const MO_SUNQUAN_QUANYU = sid('quanyu-mosunquan')
const MO_SUNQUAN_TIANEN = sid('tianen-mosunquan')
const MO_SUNQUAN_QIANGANG = sid('qiangang-mosunquan')
const MO_SUNQUAN_GROUP = sid('quanyu-round-choice')
const SUNQUAN_OPTIONS = [
  { id: 'damage', label: '白虹：伤害+1' },
  { id: 'target', label: '青冥：目标+1' },
  { id: 'armor', label: '辟邪：无视防具' },
  { id: 'unresponsive', label: '紫电：不可响应' },
  { id: 'repeat', label: '百里：额外结算' },
  { id: 'unlimited', label: '流星：无次数限制' },
] as const
const SHEN_ZHANGFEI_SHENCAI = sid('shencai-shenzhangfei')
const SHEN_ZHANGFEI_XUNSHI = sid('xunshi-shenzhangfei')
const SHEN_ZHANGFEI_JUDGE = sid('shenzhangfei-shencai-judge')
const SHEN_ZHANGFEI_MARKS = ['笞', '杖', '徒', '流'] as const
const SHEN_DENGAI_TUOYU = sid('tuoyu-shendengai')
const SHEN_DENGAI_XIANJIN = sid('xianjin-shendengai')
const SHEN_DENGAI_QIJING = sid('qijing-shendengai')
const SHEN_DENGAI_CUIXIN = sid('cuixin-shendengai')
const SHEN_DENGAI_ZONES = ['丰田', '清渠', '峻山'] as const
const SHEN_ZHANGFEI_MULTI_TARGET_TRICKS = new Set(['南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登', '铁索连环'])
function claimShenZhangfeiEvent(state: SanguoshaState, eventId: string, kind: string): boolean {
  const b70 = stateOf(state)
  const events = b70.shenZhangfeiHandledEvents ??= {}
  const key = `${kind}:${eventId}`
  if (events[key]) return false
  events[key] = true
  return true
}
function shenDengAiRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).shenDengAi ??= {}
  return records[ownerId] ??= { damageCount: 0, developed: [], awakened: false, cardOrigins: {} }
}
function shenDengAiCardPile(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): string | null {
  const recorded = (state as B70State).b70?.shenDengAi?.[ownerId]?.cardOrigins[cardId]
  if (recorded) return recorded
  const zone = locateOwnedCard(state, ownerId, cardId, { includeCharacterPiles: true })
  return zone?.kind === 'characterPile' ? zone.pile : null
}

function sunquanRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).moSunquan ??= {}
  return records[ownerId] ??= { choiceRound: state.roundNumber, choices: {}, usedChoices: {}, usedTianEn: { turnNumber: state.turnNumber, options: [] }, exemptSlashIds: [], demon: false }
}

function sunquanSlashEffects(record: MoSunquanRecord, ownerId: PlayerId, targetId: PlayerId): string[] {
  return record.demon
    ? [...(record.usedChoices[targetId] ?? [])]
    : record.choices[ownerId] ? [record.choices[ownerId]] : []
}

registerGroupDecision(MO_SUNQUAN_GROUP, (groupHost, decision) => {
  const skillHost = groupHost as unknown as SkillHost
  const state = skillHost.state as B70State
  const ownerId = decision.data.ownerId as PlayerId
  const roundNumber = decision.data.roundNumber as number
  const ownerRecord = sunquanRecord(state, ownerId)
  ownerRecord.choiceRound = roundNumber
  ownerRecord.choices = { ...(decision.responses as Record<PlayerId, string>) }
  for (const [playerId, choice] of Object.entries(ownerRecord.choices)) {
    const used = ownerRecord.usedChoices[playerId] ??= []
    if (!used.includes(choice)) used.push(choice)
  }
  const ownerChoice = ownerRecord.choices[ownerId]
  if (!ownerChoice || !playerOf(state, ownerId)?.alive) return
  const matches = Object.values(ownerRecord.choices).filter((choice) => choice === ownerChoice).length
  drawCards(state, skillHost.rng, ownerId, Math.min(3, matches), (name, data) => skillHost.dispatch(name, data))
})

function caoCaoRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).caocao ??= {}
  return records[ownerId] ??= { demon: false, demonTurn: -1, noNonBasicRecipients: [] }
}

registerGroupCardDecision(MO_CAOCAO_GROUP, (groupHost, decision) => {
  const state = groupHost.state as B70State
  const ownerId = decision.data.ownerId as PlayerId
  const record = caoCaoRecord(state, ownerId)
  const participants = decision.playerIds.filter((playerId) => playerId !== ownerId)
  const gifts = participants.flatMap((playerId) => {
    const cardId = decision.responses[playerId]?.[0]
    return cardId ? [{ playerId, cardId }] : []
  })
  record.noNonBasicRecipients = participants.filter((playerId) => {
    const gift = gifts.find((entry) => entry.playerId === playerId)
    return !gift || state.cards[gift.cardId]?.category === 'basic'
  })
  groupHost.state.skillQueue.push({ skillId: MO_CAOCAO_BACHAO, ownerId, step: 'settle-gifts', data: { gifts } })
})

registerSkillRuntime({
  id: MO_CAOCAO_FUZAI,
  viewAs(state, ownerId) {
    const player = playerOf(state, ownerId)
    return (player?.zones.hand ?? []).flatMap((cardId) => {
      if (state.cards[cardId]?.category !== 'equipment') return []
      return [
        { asCardName: '借刀杀人', cardId, label: '【覆载】：将装备牌当【借刀杀人】使用' },
        { asCardName: '无中生有', cardId, label: '【覆载】：将装备牌当【无中生有】使用' },
      ]
    })
  },
  prohibitsCardUse(state, ownerId, context) {
    if (context.userId !== ownerId || !context.cardIds?.length) return false
    return context.cardIds.some((cardId) => state.cards[cardId]?.category === 'equipment'
      && context.cardName === state.cards[cardId]?.name)
  },
  unlimitedSlash(state, ownerId) {
    const record = (state as B70State).b70?.caocao?.[ownerId]
    return Boolean(record?.demon && record.demonTurn === state.turnNumber && state.phase === 'play')
  },
  slashIgnoresDistance(state, ownerId) {
    const record = (state as B70State).b70?.caocao?.[ownerId]
    return Boolean(record?.demon && record.demonTurn === state.turnNumber && state.phase === 'play')
  },
  ignoresTrickDistance(state, ownerId) {
    const record = (state as B70State).b70?.caocao?.[ownerId]
    return Boolean(record?.demon && record.demonTurn === state.turnNumber && state.phase === 'play')
  },
})

registerSkillRuntime({
  id: MO_CAOCAO_BACHAO,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: MO_CAOCAO_BACHAO, ownerId, step: 'invoke', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') {
      host.askSkill({ skillId: MO_CAOCAO_BACHAO, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【霸朝】：是否令所有其他角色同时选择是否交给你一张手牌？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动霸朝' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'settle-gifts') {
      const gifts = prompt.data.gifts as Array<{ playerId: PlayerId; cardId: CardId }>
      for (const gift of gifts) {
        const giver = playerOf(host.state, gift.playerId)
        if (giver?.alive && giver.zones.hand.includes(gift.cardId))
          giveCards(host, gift.playerId, ownerId, [gift.cardId], MO_CAOCAO_BACHAO)
      }
      host.queueSkill({ skillId: MO_CAOCAO_BACHAO, ownerId, step: 'damage-target', data: { candidates: caoCaoRecord(host.state, ownerId).noNonBasicRecipients } })
      return
    }
    if (prompt.step === 'damage-target') {
      const candidates = (prompt.data.candidates as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive)
      const candidateIds = [...new Set([ownerId, ...candidates])]
      host.askSkill({ skillId: MO_CAOCAO_BACHAO, ownerId, step: 'damage-target', data: { candidateIds }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【霸朝】：可对一名未交给你非基本牌的角色造成1点伤害；选择自己则本阶段手牌无距离和次数限制并入魔',
        timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      startGroupCardDecision(host, {
        id: `${MO_CAOCAO_GROUP}:${host.state.seq}`, tag: MO_CAOCAO_GROUP, skillId: MO_CAOCAO_BACHAO,
        playerIds: living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id),
        prompt: '【霸朝】：秘密选择一张手牌交给魔曹操，或不交',
        cardIdsFor: (playerId) => playerOf(host.state, playerId)?.zones.hand ?? [],
        min: 0, max: 1, timeoutMs: 25_000, data: { ownerId },
      })
      return
    }
    if (resolution.step === 'damage-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId) return
      if (targetId === ownerId) {
        const record = caoCaoRecord(host.state, ownerId)
        record.demon = true
        record.demonTurn = host.state.turnNumber
        host.dispatch('SkillActivated', { skillId: MO_CAOCAO_BACHAO, skillName: '霸朝', logText: '入魔：本阶段使用手牌无次数和距离限制' }, { sourceId: ownerId })
      } else if (caoCaoRecord(host.state, ownerId).noNonBasicRecipients.includes(targetId)) {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, sourceSkillId: MO_CAOCAO_BACHAO, cardName: '霸朝', cardId: null })
      }
    }
  },
})

function lubuRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).lubu ??= {}
  return records[ownerId] ??= { qiCardIds: [], pairedHitTurn: state.turnNumber, pairedHitUsed: false, transformed: false,
    lastCardWasQi: false, qiDamageTurn: state.turnNumber, qiDamagedTargets: [] }
}

function seatAdjacent(state: SanguoshaState, leftId: PlayerId, rightId: PlayerId): boolean {
  const alive = state.players.filter((player) => player.alive).sort((left, right) => left.seat - right.seat)
  const left = alive.findIndex((player) => player.id === leftId)
  const right = alive.findIndex((player) => player.id === rightId)
  if (left < 0 || right < 0 || left === right) return false
  const offset = Math.abs(left - right)
  return offset === 1 || offset === alive.length - 1
}

function diaochanRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).diaochan ??= {}
  const record = records[ownerId] ??= { controlled: {}, demon: false, taggedCards: {}, usedTaggedCards: {}, redirectedCards: {} }
  record.redirectedCards ??= {}
  return record
}

function qingshiRedirectCandidates(state: SanguoshaState, sourceId: PlayerId, oldTargetId: PlayerId, cardName: string): PlayerId[] {
  return living(state).filter((target) => target.id !== sourceId && target.id !== oldTargetId
    && (cardName !== '火攻' || target.zones.hand.length > 0)
    && !isTargetProhibited(state, sourceId, target.id, cardName, skillIdsOf))
    .map((target) => target.id)
}

function interceptQingshiTarget(host: SkillHost, ownerId: PlayerId, context: TargetedCardContext): boolean {
  const record = diaochanRecord(host.state, ownerId)
  if (context.sourceId === ownerId || !record.taggedCards[context.cardId]
    || record.redirectedCards[context.cardId] || !isSoleTargetOf(host.state, context.cardId, context.targetId)) return false
  const candidates = qingshiRedirectCandidates(host.state, context.sourceId, context.targetId, context.cardName)
  const owner = playerOf(host.state, ownerId)
  if (!owner || !candidates.length || (owner.zones.hand.length === 0 && !Object.values(owner.zones.equipment).some(Boolean))) return false
  host.askSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'redirect-invoke',
    data: { ...context, candidates }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【倾世】：是否弃置一张牌，重选【${context.cardName}】的目标？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '弃牌并重选目标' }, { id: 'no', label: '不发动' }],
    }) })
  return true
}

function dealQingshiCards(host: SkillHost, ownerId: PlayerId): void {
  const record = diaochanRecord(host.state, ownerId)
  const targets = living(host.state)
  for (const target of targets) {
    let candidates = host.state.zones.drawPile.filter((cardId) => {
      const card = host.state.cards[cardId]
      return card && (card.name === '杀' || card.name === '决斗' || card.name === '火攻')
        && !card.virtual && !card.equipmentSlot
    })
    if (!candidates.length) {
      reshuffleDrawPile(host.state, host.rng, (name, payload) => host.dispatch(name, payload))
      candidates = host.state.zones.drawPile.filter((cardId) => {
        const card = host.state.cards[cardId]
        return card && (card.name === '杀' || card.name === '决斗' || card.name === '火攻')
          && !card.virtual && !card.equipmentSlot
      })
    }
    if (!candidates.length) break
    const cardId = host.rng.pick(candidates)
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    record.taggedCards[cardId] = target.id
    host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: MO_DIAOCHAN_QINGSHI }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
  }
}

registerSkillRuntime({
  id: MO_DIAOCHAN_QINGSHI,
  interceptTarget(host, ownerId, context) { return interceptQingshiTarget(host, ownerId, context) },
  interceptBystanderTarget(host, ownerId, context) { return interceptQingshiTarget(host, ownerId, context) },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare' || !playerOf(host.state, ownerId)?.alive) return
      const record = diaochanRecord(host.state, ownerId)
      if (record.demon) {
        const allLeftHand = Object.entries(record.taggedCards).every(([cardId, originalHolder]) =>
          !playerOf(host.state, originalHolder)?.zones.hand.includes(cardId))
        if (allLeftHand) host.queueSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'distribute', data: {} })
        return
      }
      host.queueSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'invoke', data: {} })
    } },
    { event: 'HandCardLeft', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; playerId?: PlayerId }
      if (!payload.cardId || !payload.playerId || diaochanRecord(host.state, ownerId).taggedCards[payload.cardId] !== payload.playerId) return
      host.queueSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'reclaim', data: { cardId: payload.cardId, originalHolderId: payload.playerId } })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[] }
      const record = diaochanRecord(host.state, ownerId)
      for (const cardId of payload.cardIds ?? (payload.cardId ? [payload.cardId] : []))
        if (record.taggedCards[cardId]) record.usedTaggedCards[cardId] = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (payload.cardId && diaochanRecord(host.state, ownerId).taggedCards[payload.cardId])
        diaochanRecord(host.state, ownerId).usedTaggedCards[payload.cardId] = true
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const record = diaochanRecord(host.state, ownerId)
      if (!cardId) return
      delete record.redirectedCards[cardId]
      if (!record.usedTaggedCards[cardId]) return
      delete record.taggedCards[cardId]
      delete record.usedTaggedCards[cardId]
    } },
    { event: 'CardEnteredDiscard', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      const record = diaochanRecord(host.state, ownerId)
      if (record.taggedCards[cardId] && record.usedTaggedCards[cardId]) {
        delete record.taggedCards[cardId]
        delete record.usedTaggedCards[cardId]
      }
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number; cardId?: CardId }
      const cardId = payload.cardId ?? context.event.cardIds?.[0]
      const record = diaochanRecord(host.state, ownerId)
      if (!payload.finalAmount || !cardId || !record.taggedCards[cardId]) return
      drawCards(host.state, host.rng, ownerId, 1, (name, eventPayload) => host.dispatch(name, eventPayload))
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'distribute') {
      const record = diaochanRecord(host.state, ownerId)
      record.taggedCards = {}
      record.usedTaggedCards = {}
      dealQingshiCards(host, ownerId)
      return
    }
    if (prompt.step === 'reclaim') {
      const { cardId, originalHolderId } = prompt.data as { cardId: CardId; originalHolderId: PlayerId }
      const record = diaochanRecord(host.state, ownerId)
      if (record.usedTaggedCards[cardId] || record.taggedCards[cardId] !== originalHolderId) return
      record.usedTaggedCards[cardId] = true
      const holder = host.state.players.find((player) => player.id !== ownerId && player.zones.hand.includes(cardId))
      if (holder) {
        delete record.taggedCards[cardId]
        delete record.usedTaggedCards[cardId]
        giveCards(host, holder.id, ownerId, [cardId], MO_DIAOCHAN_QINGSHI)
        return
      }
      const equipmentHolder = host.state.players.find((player) => player.id !== ownerId
        && Object.values(player.zones.equipment).includes(cardId))
      if (equipmentHolder) {
        delete record.taggedCards[cardId]
        delete record.usedTaggedCards[cardId]
        giveOwnedCards(host, equipmentHolder.id, ownerId, [cardId], MO_DIAOCHAN_QINGSHI)
        return
      }
      if (host.state.zones.discardPile.includes(cardId)) {
        delete record.taggedCards[cardId]
        delete record.usedTaggedCards[cardId]
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MO_DIAOCHAN_QINGSHI }, { targetId: ownerId, cardIds: [cardId] })
      } else delete record.usedTaggedCards[cardId]
      return
    }
    if (prompt.step === 'invoke') host.askSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'invoke', build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【倾世】：是否入魔并令所有角色获得一张单目标伤害牌？',
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '入魔并发动倾世' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'redirect-invoke') {
      const data = resolution.data as unknown as TargetedCardContext & { candidates: PlayerId[] }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        diaochanRecord(host.state, ownerId).redirectedCards[data.cardId] = true
        host.resumeCardTarget()
        return
      }
      const owner = playerOf(host.state, ownerId)
      const cardIds = owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
      if (!cardIds.length) {
        diaochanRecord(host.state, ownerId).redirectedCards[data.cardId] = true
        host.resumeCardTarget()
        return
      }
      host.askSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'redirect-discard', data: data as unknown as Record<string, unknown>, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【倾世】：弃置一张牌以重选此牌目标', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'redirect-discard') {
      const data = resolution.data as unknown as TargetedCardContext & { candidates: PlayerId[] }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const validIds = new Set(owner ? [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))] : [])
      if (cardIds.length !== 1 || !validIds.has(cardIds[0])
        || discardCardsByIds(host as never, ownerId, cardIds, MO_DIAOCHAN_QINGSHI).length !== 1) {
        diaochanRecord(host.state, ownerId).redirectedCards[data.cardId] = true
        host.resumeCardTarget()
        return
      }
      const candidates = qingshiRedirectCandidates(host.state, data.sourceId, data.targetId, data.cardName)
      if (!candidates.length) {
        diaochanRecord(host.state, ownerId).redirectedCards[data.cardId] = true
        host.resumeCardTarget()
        return
      }
      host.askSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'redirect-target', data: { ...data, candidates }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: `【倾世】：为【${data.cardName}】选择新目标`, timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'redirect-target') {
      const data = resolution.data as unknown as TargetedCardContext & { candidates: PlayerId[] }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const candidates = qingshiRedirectCandidates(host.state, data.sourceId, data.targetId, data.cardName)
      const redirected = Boolean(targetId && candidates.includes(targetId)
        && redirectCurrentCardTarget(host.state, data.targetId, targetId))
      diaochanRecord(host.state, ownerId).redirectedCards[data.cardId] = true
      if (!redirected) host.dispatch('SkillActivated', { skillId: MO_DIAOCHAN_QINGSHI, skillName: '倾世', result: 'redirect-failed' }, { sourceId: ownerId })
      host.resumeCardTarget()
      return
    }
    if (resolution.step !== 'invoke' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const record = diaochanRecord(host.state, ownerId)
    record.demon = true
    host.dispatch('SkillActivated', { skillId: MO_DIAOCHAN_QINGSHI, skillName: '倾世', logText: '入魔并令全场获得“倾世”牌' }, { sourceId: ownerId })
    host.queueSkill({ skillId: MO_DIAOCHAN_QINGSHI, ownerId, step: 'distribute', data: {} })
  },
})

registerSkillRuntime({
  id: MO_DIAOCHAN_HUANHUO,
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
      if (!playerOf(host.state, ownerId)?.alive) return
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
      host.queueSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'discard', data: {} })
    } },
    { event: 'TurnStart', allowDeadOwner: true, handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (!targetId) return
      const controlled = diaochanRecord(host.state, ownerId).controlled[targetId]
      if (controlled && playerOf(host.state, targetId)?.alive) controlled.turnNumber = host.state.turnNumber
    } },
    { event: 'PhaseStart', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || !payload.playerId) return
      const controlled = diaochanRecord(host.state, ownerId).controlled[payload.playerId]
      if (!controlled || controlled.turnNumber !== host.state.turnNumber || controlled.usesLeft <= 0) return
      host.queueSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'forced-use', data: { targetId: payload.playerId }, allowDeadOwner: true })
    } },
    { event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
      const targetId = context.event.sourceId
      if (!targetId) return
      const controlled = diaochanRecord(host.state, ownerId).controlled[targetId]
      if (!controlled || controlled.turnNumber !== host.state.turnNumber || controlled.usesLeft <= 0) return
      const hand = playerOf(host.state, targetId)?.zones.hand ?? []
      if (hand.length) discardCardsByIds(host as never, targetId, [host.rng.pick(hand)], MO_DIAOCHAN_HUANHUO)
      controlled.usesLeft -= 1
      if (controlled.usesLeft > 0)
        host.queueSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'forced-use', data: { targetId }, allowDeadOwner: true })
      else delete diaochanRecord(host.state, ownerId).controlled[targetId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'discard') {
      const player = playerOf(host.state, ownerId)
      if (!player?.alive) return
      host.askSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'discard', data: {}, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【幻惑】：弃置至多两张手牌，并选择等量其他角色',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...player.zones.hand], hiddenCardSlots: [], min: 0, max: Math.min(2, player.zones.hand.length),
      }) })
      return
    }
    if (prompt.step === 'choose-targets') {
      const candidateIds = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
      const count = Math.min(Number(prompt.data.count) || 0, candidateIds.length)
      if (!count) return
      host.askSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'choose-targets', data: { count }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【幻惑】：选择与弃牌数相同的其他角色',
        timeoutMs: 25_000, optional: false, candidateIds, min: count, max: count,
      }) })
      return
    }
    if (prompt.step === 'forced-use') {
      const targetId = prompt.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const controlled = diaochanRecord(host.state, ownerId).controlled[targetId]
      if (!target?.alive || !controlled || controlled.turnNumber !== host.state.turnNumber) return
      const actionIds = legalPlayActions(host.state, targetId)
        .filter((action) => action.kind === 'use-card' && action.cardIds.length > 0
          && action.cardIds.every((cardId) => target.zones.hand.includes(cardId)))
        .map((action) => action.id)
      if (!actionIds.length) { delete diaochanRecord(host.state, ownerId).controlled[targetId]; return }
      host.askSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'forced-use', data: { targetId, actionIds }, build: (id): UseCardRequest => ({
        id, kind: 'use-card', playerId: targetId, prompt: `【幻惑】：必须选择一张可用手牌使用（尚需使用${controlled.usesLeft}张）`,
        timeoutMs: 25_000, optional: false, actionIds,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const player = playerOf(host.state, ownerId)
      if (!player || cardIds.length > 2 || cardIds.some((cardId) => !player.zones.hand.includes(cardId))) return
      if (cardIds.length) discardCardsByIds(host as never, ownerId, cardIds, MO_DIAOCHAN_HUANHUO)
      if (cardIds.length) host.queueSkill({ skillId: MO_DIAOCHAN_HUANHUO, ownerId, step: 'choose-targets', data: { count: cardIds.length } })
      return
    }
    if (resolution.step === 'choose-targets') {
      const count = resolution.data.count as number
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetIds.length !== count || new Set(targetIds).size !== count
        || targetIds.some((id) => !playerOf(host.state, id)?.alive || id === ownerId)) return
      const controlled = diaochanRecord(host.state, ownerId).controlled
      for (const targetId of targetIds) controlled[targetId] = { turnNumber: -1, usesLeft: 2 }
      return
    }
    if (resolution.step === 'forced-use') {
      const targetId = resolution.data.targetId as PlayerId
      const actionIds = resolution.data.actionIds as string[]
      const selectedId = (response.payload as { actionIds?: string[] }).actionIds?.[0]
      if (!selectedId || !actionIds.includes(selectedId)) return
      const action = legalPlayActions(host.state, targetId).find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.id === selectedId && candidate.kind === 'use-card')
      if (action) executeUseCardAction(host as never, targetId, action)
    }
  },
})

function simayiRecord(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).simayi ??= {}
  const owner = playerOf(state, ownerId)
  return records[ownerId] ??= { recordedNames: [], flashIds: [], observedHp: owner?.hp ?? 0, used: { turnNumber: state.turnNumber, names: [] }, transformed: false, damagedThisRound: [], dealtDamageThisRound: false, slashQueue: [] }
}

function gainGuifuFlash(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const record = simayiRecord(host.state, ownerId)
  const cardId = `virtual:${MO_SIMAYI_GUIFU}:${host.state.seq + 1}:${host.state.decisions.length}` as CardId
  host.state.cards[cardId] = {
    id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: '闪',
    suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true, sourceSkillId: MO_SIMAYI_GUIFU,
  }
  owner.zones.hand.push(cardId)
  record.flashIds.push(cardId)
  host.state.skillHandLimitExemptCardIds ??= {}
  const exempt = host.state.skillHandLimitExemptCardIds[ownerId] ??= []
  exempt.push(cardId)
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MO_SIMAYI_GUIFU }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
}

function namesAvailableToGuifu(state: SanguoshaState, ownerId: PlayerId): string[] {
  const record = (state as B70State).b70?.simayi?.[ownerId]
  if (!record) return []
  if (record.used.turnNumber !== state.turnNumber) record.used = { turnNumber: state.turnNumber, names: [] }
  const printableNames = new Set(Object.values(state.cards).map((card) => card.name))
  const names = new Set(record.recordedNames.filter((entry) => printableNames.has(entry)))
  return [...names].filter((name) => !record.used.names.includes(name))
}

function markGuifuNameUsed(host: SkillHost, ownerId: PlayerId, cardId: CardId, cardName: string | undefined): void {
  if (!cardName || !(host.state as B70State).b70?.simayi?.[ownerId]?.flashIds.includes(cardId)) return
  const record = simayiRecord(host.state, ownerId)
  if (record.used.turnNumber !== host.state.turnNumber) record.used = { turnNumber: host.state.turnNumber, names: [] }
  if (!record.used.names.includes(cardName)) record.used.names.push(cardName)
}

registerSkillRuntime({
  id: MO_SIMAYI_GUIFU,
  onGameStart(host, ownerId) { simayiRecord(host.state, ownerId).observedHp = playerOf(host.state, ownerId)?.hp ?? 0 },
  viewAs(state, ownerId) {
    const record = (state as B70State).b70?.simayi?.[ownerId]
    if (!record) return []
    return record.flashIds.filter((cardId) => playerOf(state, ownerId)?.zones.hand.includes(cardId))
      .flatMap((cardId) => namesAvailableToGuifu(state, ownerId).map((asCardName) => ({
        asCardName, cardId, label: `【诡伏】：将【闪】当【${asCardName}】使用`,
      })))
  },
  slashUseQuotaBypass(state, ownerId, cardId) {
    return Boolean(cardId && (state as B70State).b70?.simayi?.[ownerId]?.flashIds.includes(cardId))
  },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) { gainGuifuFlash(host, ownerId) } },
    ...(['Damaged', 'Recover', 'LoseHp', 'HpSet', 'HpExchanged', 'MaxHpChange'] satisfies GameEventName[]).map((event) => ({
      event,
      handle(host: SkillHost, ownerId: PlayerId, context: EventContext) {
        const payload = context.event.payload as { playerId?: PlayerId; leftId?: PlayerId; rightId?: PlayerId }
        if (context.event.targetId !== ownerId && payload.playerId !== ownerId
          && payload.leftId !== ownerId && payload.rightId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const record = simayiRecord(host.state, ownerId)
        if (record.observedHp === owner.hp) return
        record.observedHp = owner.hp
        gainGuifuFlash(host, ownerId)
      },
    })),
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string | null; finalAmount?: number }
      if (!payload.finalAmount) return
      const record = simayiRecord(host.state, ownerId)
      if (context.event.sourceId === ownerId) record.dealtDamageThisRound = true
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const name = cardId ? payload.cardName : context.event.sourceSkillId ?? payload.cardName
      if (name && !record.recordedNames.includes(name)) record.recordedNames.push(name)
      const sourceId = context.event.sourceId
      if (context.event.targetId === ownerId && sourceId && sourceId !== ownerId && !record.damagedThisRound.includes(sourceId))
        record.damagedThisRound.push(sourceId)
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const cardId = payload.cardId ?? context.event.cardIds?.[0]
      if (cardId) markGuifuNameUsed(host, ownerId, cardId, payload.cardName)
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId; cardName?: string }
      if (payload.playerId === ownerId && payload.cardId) markGuifuNameUsed(host, ownerId, payload.cardId, payload.cardName)
    } },
  ],
})

registerSkillRuntime({
  id: MO_SIMAYI_MOUBIAN,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    const record = simayiRecord(host.state, ownerId)
    if (payload.playerId !== ownerId || payload.phase !== 'prepare' || record.transformed || record.recordedNames.length < 3) return
    host.askSkill({ skillId: MO_SIMAYI_MOUBIAN, ownerId, step: 'transform', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【谋变】：是否入魔并获得已记录的技能及【骤袭】？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '入魔' }, { id: 'no', label: '暂不入魔' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'transform' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const record = simayiRecord(host.state, ownerId)
    if (record.transformed || record.recordedNames.length < 3) return
    record.transformed = true
    for (const skillId of record.recordedNames) if (getSkillRuntime(skillId)) grantSkill(host.state, ownerId, skillId)
    grantSkill(host.state, ownerId, MO_SIMAYI_ZOUXI)
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: MO_SIMAYI_MOUBIAN, skillName: '谋变', logText: `${playerOf(host.state, ownerId)?.nickname ?? '角色'}发动【谋变】入魔` }, { sourceId: ownerId })
  },
})

const MO_SIMAYI_ZOUXI_POOL: ReadonlyArray<readonly [string, string]> = [
  ['蒋干', '盗书'], ['关银屏', '雪恨'], ['界·张角', '雷击'], ['神·张角', '天劫'],
  ['孙亮', '溃诛'], ['界·李儒', '绝策'], ['何太后', '鸩毒'], ['族·荀采', '烈誓'],
  ['荀彧', '驱虎'], ['韩馥', '束辎'], ['典韦', '强袭'], ['郭槐', '哲妇'],
  ['诸葛恪', '黩武'], ['界·夏侯惇', '刚烈'], ['张华', '剑合'], ['马谡', '散谣'],
]

registerSkillRuntime({
  id: MO_SIMAYI_ZOUXI,
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId === ownerId)
        replaceTemporarySkills(host.state, ownerId, MO_SIMAYI_ZOUXI, [])
    } },
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
      const choices = host.rng.shuffle(MO_SIMAYI_ZOUXI_POOL
        .map(([character, skill]) => ({ skillId: skillIdByCharacterAndName(character, skill), character, skill }))
        .filter((entry): entry is { skillId: string; character: string; skill: string } => Boolean(entry.skillId && getSkillRuntime(entry.skillId)))
        .filter((entry) => !(playerOf(host.state, ownerId)?.grantedSkills ?? []).includes(entry.skillId)))
        .slice(0, 3)
      if (!choices.length) return
      host.askSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'gain', data: { choices }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【骤袭】：从随机出现的技能中选择一个，获得至下回合开始',
        timeoutMs: 25_000, optional: false,
        options: choices.map((entry) => ({ id: entry.skillId, label: `${entry.skill}（${entry.character}）` })),
      }) })
    } },
    { event: 'RoundEnd', handle(host, ownerId) {
      const record = simayiRecord(host.state, ownerId)
      if (record.transformed && !record.dealtDamageThisRound && playerOf(host.state, ownerId)?.alive) {
        loseHp(host as never, ownerId, 1, MO_SIMAYI_ZOUXI)
      }
      record.dealtDamageThisRound = false
      record.slashQueue = [...record.damagedThisRound]
      record.damagedThisRound = []
      if (record.slashQueue.length) host.queueSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'forced-slash', data: {} })
    } },
    { event: 'CardResolved', handle(host, ownerId, context) {
      const payload = context.event.payload as { sourceSkillId?: string }
      if (payload.sourceSkillId !== MO_SIMAYI_ZOUXI) return
      if (simayiRecord(host.state, ownerId).slashQueue.length)
        host.queueSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'forced-slash', data: {} })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'forced-slash') return
    const record = simayiRecord(host.state, ownerId)
    const targetId = record.slashQueue.shift()
    const source = playerOf(host.state, targetId ?? '')
    const target = playerOf(host.state, ownerId)
    if (!source?.alive || !target?.alive) {
      if (record.slashQueue.length) host.queueSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'forced-slash', data: {} })
      return
    }
    const legalByRange = getDistance(host.state, source.id, target.id) <= getAttackRange(host.state, source.id)
    const legalByLock = !isTargetProhibited(host.state, source.id, target.id, '杀', skillIdsOf, undefined, MO_SIMAYI_ZOUXI)
      && !isCardUseProhibited(host.state, source.id, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null }, skillIdsOf)
    if (!legalByRange || !legalByLock) {
      if (record.slashQueue.length) host.queueSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'forced-slash', data: {} })
      return
    }
    const used = host.beginVirtualSlash({ sourceId: source.id, targetId: target.id, sourceSkillId: MO_SIMAYI_ZOUXI, countUsage: true })
    if (!used && record.slashQueue.length) host.queueSkill({ skillId: MO_SIMAYI_ZOUXI, ownerId, step: 'forced-slash', data: {} })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain') return
    const choices = resolution.data.choices as Array<{ skillId: string; character: string; skill: string }>
    const selected = (response.payload as { optionId?: string }).optionId
    if (selected && choices.some((entry) => entry.skillId === selected))
      replaceTemporarySkills(host.state, ownerId, MO_SIMAYI_ZOUXI, [selected])
  },
})

registerSkillRuntime({
  id: MO_LUBU_DUOQI,
  onGameStart(host, ownerId) {
    const record = lubuRecord(host.state, ownerId)
    record.qiCardIds = host.state.players.flatMap((player) => player.zones.hand)
    const firstSeat = [...host.state.players].sort((left, right) => left.seat - right.seat)[0]
    if (firstSeat) scheduleExtraPhaseForPlayer(host.state, firstSeat.id, 'play', MO_LUBU_DUOQI)
  },
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && state.extraPhase?.playerId === ownerId
      && state.extraPhase.skillId === MO_LUBU_DUOQI && DELAYED_TRICKS.has(context.cardName)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'gain-qi') return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const qiIds = lubuRecord(host.state, ownerId).qiCardIds
    if (!target?.alive) return
    const hiddenCardSlots = target.zones.hand.flatMap((cardId, index) => qiIds.includes(cardId) ? [hiddenHandSlot(targetId, index)] : [])
    if (!hiddenCardSlots.length) return
    host.askSkill({ skillId: MO_LUBU_DUOQI, ownerId, step: 'gain-qi', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【夺炁】：获得${target.nickname}的一张“炁”`,
      timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain-qi') return
    const targetId = resolution.data.targetId as PlayerId
    const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
    const target = playerOf(host.state, targetId)
    const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
    if (!cardId || !target?.alive || !lubuRecord(host.state, ownerId).qiCardIds.includes(cardId)
      || !target.zones.hand.includes(cardId)) return
    giveOwnedCards(host, targetId, ownerId, [cardId], MO_LUBU_DUOQI)
  },
  triggers: [
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      if (!payload.finalAmount) return
      const record = lubuRecord(host.state, ownerId)
      if (record.pairedTargetId && (context.event.sourceId === ownerId && context.event.targetId === record.pairedTargetId
        || context.event.sourceId === record.pairedTargetId && context.event.targetId === ownerId)) {
        record.pairedHitTurn = host.state.turnNumber
        record.pairedHitUsed = true
      }
      if (context.event.sourceId !== ownerId || !context.event.targetId || context.event.targetId === ownerId) return
      if (record.qiDamageTurn !== host.state.turnNumber) {
        record.qiDamageTurn = host.state.turnNumber
        record.qiDamagedTargets = []
      }
      if (record.qiDamagedTargets.includes(context.event.targetId)) return
      record.qiDamagedTargets.push(context.event.targetId)
      const victim = playerOf(host.state, context.event.targetId)
      if (victim?.alive && victim.zones.hand.some((cardId) => record.qiCardIds.includes(cardId)))
        host.queueSkill({ skillId: MO_LUBU_DUOQI, ownerId, step: 'gain-qi', data: { targetId: victim.id } })
    } },
    { event: 'BeforeDeath', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const record = lubuRecord(host.state, ownerId)
      if (context.event.sourceId !== ownerId || !targetId || targetId !== record.pairedTargetId) return
      const victim = playerOf(host.state, targetId)
      if (!victim) return
      const qi = victim.zones.hand.filter((cardId) => record.qiCardIds.includes(cardId))
      if (qi.length) giveOwnedCards(host, targetId, ownerId, qi, MO_LUBU_KUANGMO)
    } },
    { event: 'Death', handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const record = lubuRecord(host.state, ownerId)
      if (targetId !== record.pairedTargetId) return
      record.pairedTargetId = undefined
      if (playerOf(host.state, ownerId)?.alive)
        host.queueSkill({ skillId: MO_LUBU_KUANGMO, ownerId, step: 'reselect', data: {} })
    } },
  ],
},
)

registerSkillRuntime({
  id: MO_LUBU_KUANGMO,
  activeActions(state, ownerId) {
    const record = (state as B70State).b70?.lubu?.[ownerId]
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || record?.transformed || !playerOf(state, ownerId)?.alive
      || !living(state).some((player) => player.id !== ownerId)) return []
    return [{ id: `skill:${MO_LUBU_KUANGMO}`, label: '狂魔：入魔并选择“狂”角色' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MO_LUBU_KUANGMO}`) return
    const candidateIds = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
    host.askSkill({ skillId: MO_LUBU_KUANGMO, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【狂魔】：选择一名其他角色成为“狂”角色',
      timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
  outgoingDamage(state, ownerId, context) {
    const record = (state as B70State).b70?.lubu?.[ownerId]
    if (!record?.pairedTargetId || context.targetId !== record.pairedTargetId) return null
    return record.pairedHitTurn !== state.turnNumber || !record.pairedHitUsed ? { amount: context.amount + 1 } : null
  },
  incomingDamage(state, ownerId, context) {
    const record = (state as B70State).b70?.lubu?.[ownerId]
    if (!record?.pairedTargetId || context.sourceId !== record.pairedTargetId) return null
    return record.pairedHitTurn !== state.turnNumber || !record.pairedHitUsed ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const record = lubuRecord(host.state, ownerId)
    if (!targetId || !living(host.state).some((player) => player.id === targetId && player.id !== ownerId)) return
    record.transformed = true
    record.pairedTargetId = targetId
    record.pairedHitTurn = host.state.turnNumber
    record.pairedHitUsed = false
    host.dispatch('SkillActivated', { playerId: ownerId, skillId: MO_LUBU_KUANGMO, skillName: '狂魔', logText: `角色入魔，${playerOf(host.state, targetId)?.nickname ?? '目标'}成为“狂”角色` }, { sourceId: ownerId, targetId })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'reselect') return
    const candidateIds = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: MO_LUBU_KUANGMO, ownerId, step: 'reselect', build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【狂魔】：原“狂”角色死亡，请重新选择一名其他角色',
      timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1,
    }) })
  },
})

registerSkillRuntime({
  id: MO_LUBU_GANGQUAN,
  viewAs(state, ownerId) {
    const record = (state as B70State).b70?.lubu?.[ownerId]
    if (!record) return []
    return (playerOf(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => {
      const card = state.cards[cardId]
      if (!card) return []
      if (record.lastCardWasQi && card.category === 'equipment') return [{
        asCardName: '杀', cardId, nature: 'fire' as const, label: '【罡拳】：将装备牌当火【杀】使用',
      }]
      if (!record.lastCardWasQi && card.category === 'trick') return [{
        asCardName: '决斗', cardId, label: '【罡拳】：将锦囊牌当【决斗】使用',
      }]
      return []
    })
  },
  prohibitsSourceTarget(state, ownerId, targetId, cardName, sourceSkillId) {
    return sourceSkillId === MO_LUBU_GANGQUAN && cardName === '杀' && !seatAdjacent(state, ownerId, targetId)
  },
  triggers: [
  { event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const record = lubuRecord(host.state, ownerId)
    const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
    record.lastCardWasQi = Boolean(cardId && record.qiCardIds.includes(cardId))
  } },
  { event: 'TurnStart', handle(host, ownerId) {
    const record = lubuRecord(host.state, ownerId)
    if (record.pairedHitTurn !== host.state.turnNumber) {
      record.pairedHitTurn = host.state.turnNumber
      record.pairedHitUsed = false
    }
  } }],
  activeActions(_state) { return [] },
})

function qingshiState(state: SanguoshaState, ownerId: PlayerId) {
  const records = stateOf(state).qingshi ??= {}
  const current = records[ownerId]
  if (!current || current.turnNumber !== state.turnNumber) records[ownerId] = { turnNumber: state.turnNumber, names: [], disabled: false }
  return records[ownerId]!
}

function qingshiDamageCard(state: SanguoshaState, cardId: CardId, cardName: string, hasNature: boolean): boolean {
  const card = state.cards[cardId]
  return cardName === '杀' || hasNature || card?.damageNature !== undefined
    || (INSTANT_TRICKS.has(cardName) && ['火攻', '决斗', '南蛮入侵', '万箭齐发'].includes(cardName))
}

function askQingshiOption(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, cardId: CardId, cardName: string, targetIds: PlayerId[]): void {
  const options = [
    ...(qingshiDamageCard(host.state, cardId, cardName, Boolean(action.nature)) && targetIds.length ? [{ id: 'damage', label: '令此牌对一名目标造成的伤害+1' }] : []),
    { id: 'draw', label: '令任意名其他角色各摸一张牌' },
    { id: 'three', label: '摸三张牌，本回合【情势】失效' },
  ]
  host.askSkill({ skillId: WUZHUGE_QINGSHI, ownerId, step: 'option', data: { action, cardId, cardName, targetIds }, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId: ownerId, prompt: `【情势】：为本次使用的【${cardName}】选择一项`, timeoutMs: 25_000,
    optional: true, options,
  }) })
}

function resumeQingshiTarget(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, cardId: CardId, cardName: string, targetIds: PlayerId[]): void {
  host.askSkill({ skillId: WUZHUGE_QINGSHI, ownerId, step: 'damage-target', data: { action, cardId, cardName, targetIds }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【情势】：选择此牌的一名目标，令其受到的伤害+1', timeoutMs: 25_000,
    optional: false, candidateIds: targetIds, min: 1, max: 1,
  }) })
}

function askQingshiDrawTargets(host: SkillHost, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, cardId: CardId, cardName: string): void {
  const candidateIds = living(host.state).filter((player) => player.id !== ownerId).map((player) => player.id)
  host.askSkill({ skillId: WUZHUGE_QINGSHI, ownerId, step: 'draw-targets', data: { action, cardId, cardName }, build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【情势】：选择任意名其他角色各摸一张牌', timeoutMs: 25_000,
    optional: false, candidateIds, min: 0, max: candidateIds.length,
  }) })
}

registerSkillRuntime({
  id: WUZHUGE_QINGSHI,
  interceptPlayAction(host, ownerId, action) {
    if (action.playerId !== ownerId || host.state.currentPlayerId !== ownerId || host.state.phase !== 'play') return false
    const cardId = action.cardIds[0]
    const card = cardId ? host.state.cards[cardId] : undefined
    const cardName = action.asCardName || card?.name
    const usedCardIds = new Set(action.cardIds)
    if (!cardId || !card || !cardName
      || !playerOf(host.state, ownerId)?.zones.hand.some((id) => !usedCardIds.has(id) && host.state.cards[id]?.name === cardName)) return false
    const record = qingshiState(host.state, ownerId)
    if (record.disabled || record.names.includes(cardName)) return false
    record.names.push(cardName)
    askQingshiOption(host, ownerId, action, cardId, cardName, action.targetIds)
    return true
  },
  outgoingDamage(state, _ownerId, context) {
    return context.cardId && stateOf(state).qingshiDamage?.[context.cardId] === context.targetId
      ? { amount: context.amount + 1 } : null
  },
  resume(host, ownerId, resolution, response) {
    const { action, cardId, cardName, targetIds = [] } = resolution.data as { action?: Extract<LegalAction, { kind: 'use-card' }>; cardId: CardId; cardName: string; targetIds?: PlayerId[] }
    const resumeAction = () => {
      if (action) executeUseCardAction(host as never, ownerId, action)
    }
    if (resolution.step === 'option') {
      const choice = (response.payload as { optionId?: string }).optionId
      if (choice === 'damage' && targetIds.length && action) resumeQingshiTarget(host, ownerId, action, cardId, cardName, targetIds)
      else if (choice === 'draw' && action) askQingshiDrawTargets(host, ownerId, action, cardId, cardName)
      else if (choice === 'three') {
        qingshiState(host.state, ownerId).disabled = true
        drawCards(host.state, host.rng, ownerId, 3, (name, payload) => host.dispatch(name, payload))
        resumeAction()
      } else resumeAction()
      return
    }
    if (resolution.step === 'damage-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && targetIds.includes(targetId) && playerOf(host.state, targetId)?.alive) {
        stateOf(host.state).qingshiDamage ??= {}
        stateOf(host.state).qingshiDamage![cardId] = targetId
      }
      resumeAction()
      return
    }
    if (resolution.step === 'draw-targets') {
      for (const targetId of (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []) {
        if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      }
      resumeAction()
    }
  },
  triggers: [{ event: 'AfterCardUse', handle(host, _ownerId, context) {
    const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
    if (cardId && stateOf(host.state).qingshiDamage?.[cardId]) delete stateOf(host.state).qingshiDamage![cardId]
  } }],
})

registerSkillRuntime({
  id: WUZHUGE_JINCU,
  initialHandCount: () => 7,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
    const desiredHp = Math.max(1, host.state.zones.drawPile.reduce((count, cardId) => count + (host.state.cards[cardId]?.rank === 7 ? 1 : 0), 0))
    setCurrentHp(host, ownerId, desiredHp, WUZHUGE_JINCU)
    const observed = host.state.zones.drawPile.slice(0, desiredHp)
    if (!observed.length) return
    host.askSkill({ skillId: WUZHUGE_JINCU, ownerId, step: 'arrange', data: { observed }, build: (id): ArrangeCardsRequest => ({
      id, kind: 'arrange-cards', playerId: ownerId,
      prompt: `【尽瘁】：观看牌堆顶${observed.length}张牌，以任意顺序放回牌堆顶或牌堆底`,
      timeoutMs: 30_000, optional: false, cardIds: observed, minTop: 0, maxTop: observed.length, allowBottom: true,
    }) })
  } }],
  resume(_host, _ownerId, _resolution, _response: GameResponse) {
    const host = _host
    const observed = _resolution.data.observed as CardId[]
    const { top, bottom } = _response.payload as { top: CardId[]; bottom: CardId[] }
    const known = new Set(observed)
    const live = (cardId: CardId) => host.state.zones.drawPile.includes(cardId)
    const untouched = host.state.zones.drawPile.filter((cardId) => !known.has(cardId))
    host.state.zones.drawPile = [...top.filter(live), ...untouched, ...bottom.filter(live)]
  },
})

registerSkillRuntime({
  id: WUZHUGE_ZHIZHE,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !owner?.alive
      || owner.usedLimitedSkills.includes(WUZHUGE_ZHIZHE) || owner.zones.hand.length === 0) return []
    return [{ id: `skill:${WUZHUGE_ZHIZHE}`, label: '智哲：复制一张手牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${WUZHUGE_ZHIZHE}`) return
    const cardIds = zhanghuHandIds(host.state, ownerId)
    if (!cardIds.length) return
    host.askSkill({ skillId: WUZHUGE_ZHIZHE, ownerId, step: 'copy', build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【智哲】：选择一张手牌进行复制', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: [...cardIds], hiddenCardSlots: [], min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'copy') return
    const owner = playerOf(host.state, ownerId)
    const [originalId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const original = originalId ? host.state.cards[originalId] : undefined
    if (!owner?.alive || !original || !owner.zones.hand.includes(originalId!) || owner.usedLimitedSkills.includes(WUZHUGE_ZHIZHE)) return
    const copyId = `copy:${WUZHUGE_ZHIZHE}:${host.state.seq + 1}:${host.state.decisions.length}` as CardId
    host.state.cards[copyId] = {
      id: copyId, ruleset: original.ruleset, expansion: original.expansion, name: original.name,
      suit: original.suit, rank: original.rank, color: original.color, category: original.category,
      ...(original.damageNature ? { damageNature: original.damageNature } : {}),
      ...(original.equipmentSlot ? { equipmentSlot: original.equipmentSlot } : {}),
      ...(original.attackRange === undefined ? {} : { attackRange: original.attackRange }),
      sourceSkillId: WUZHUGE_ZHIZHE,
    }
    owner.zones.hand.push(copyId)
    owner.usedLimitedSkills.push(WUZHUGE_ZHIZHE)
    stateOf(host.state).zhizheCopies ??= {}
    stateOf(host.state).zhizheCopies![copyId] = { ownerId, returnPending: false }
    host.dispatch('SkillActivated', { skillId: WUZHUGE_ZHIZHE, skillName: '智哲', playerId: ownerId, cardIds: [originalId], logText: `${owner.nickname}发动【智哲】复制了一张牌` }, { sourceId: ownerId, cardIds: [originalId, copyId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [copyId], reason: WUZHUGE_ZHIZHE }, { sourceId: ownerId, cardIds: [copyId] })
  },
  prohibitsCardUse(state, _ownerId, context) {
    return (context.cardIds ?? []).some((cardId) => stateOf(state).zhizheCopies?.[cardId]?.blockedTurn === state.turnNumber)
  },
  prohibitsResponseCard(state, _ownerId, _responderId, cardId) {
    return stateOf(state).zhizheCopies?.[cardId]?.blockedTurn === state.turnNumber
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const copy = cardId ? stateOf(host.state).zhizheCopies?.[cardId] : undefined
      if (copy?.ownerId === ownerId) copy.returnPending = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      const copy = payload.cardId ? stateOf(host.state).zhizheCopies?.[payload.cardId] : undefined
      if (payload.playerId === ownerId && copy?.ownerId === ownerId) copy.returnPending = true
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const copy = cardId ? stateOf(host.state).zhizheCopies?.[cardId] : undefined
      if (!cardId || !copy?.returnPending || !host.state.zones.discardPile.includes(cardId)) return
      const recipient = playerOf(host.state, copy.ownerId)
      if (!recipient?.alive) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: copy.ownerId })
      copy.returnPending = false
      copy.blockedTurn = host.state.turnNumber
      host.dispatch('GainCard', { playerId: copy.ownerId, cardIds: [cardId], reason: WUZHUGE_ZHIZHE }, { sourceId: ownerId, targetId: copy.ownerId, cardIds: [cardId] })
    } },
  ],
})

function zhanghuRecord(state: SanguoshaState, ownerId: PlayerId) {
  const all = stateOf(state).zhanghu ??= {}
  return all[ownerId] ??= { redTrick: false, redBasic: false, exchangeRemoved: false }
}

function zhanghuCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return living(state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
}

function zhanghuDodgeArmorIds(state: SanguoshaState, targetId: PlayerId): CardId[] {
  const target = playerOf(state, targetId)
  if (!target) return []
  const dodges = target.zones.hand.filter((id) => state.cards[id]?.name === '闪')
  const armor = target.zones.equipment.armor
  return armor ? [...dodges, armor] : dodges
}

function zhanghuHandIds(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.zones.hand ?? []
}

function askZhanghuTarget(host: SkillHost, ownerId: PlayerId): void {
  const candidateIds = zhanghuCandidates(host.state, ownerId)
  if (!candidateIds.length) return
  host.askSkill({ skillId: ZHANGHU_CUIJIAN, ownerId, step: 'target', build: (id): ChooseTargetsRequest => ({
    id, kind: 'choose-targets', playerId: ownerId, prompt: '【摧坚】：选择一名有手牌的角色', timeoutMs: 25_000,
    optional: true, candidateIds, min: 0, max: 1,
  }) })
}

function askZhanghuReturn(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, gained: CardId[]): void {
  const current = zhanghuHandIds(host.state, ownerId)
  const giveCount = Math.min(gained.length, current.length)
  if (!giveCount) return
  host.askSkill({ skillId: ZHANGHU_CUIJIAN, ownerId, step: 'return', data: { targetId, gained, giveCount }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【摧坚】：交给其${giveCount}张牌`, timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds: current, hiddenCardSlots: [], min: giveCount, max: giveCount,
  }) })
}

registerSkillRuntime({
  id: ZHANGHU_CUIJIAN,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || usedThisPhase(state, ownerId, ZHANGHU_CUIJIAN)
      || zhanghuCandidates(state, ownerId).length === 0) return []
    return [{ id: `skill:${ZHANGHU_CUIJIAN}`, label: '摧坚：选择角色并收取其闪与防具' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId === `skill:${ZHANGHU_CUIJIAN}`) askZhanghuTarget(host, ownerId)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !zhanghuCandidates(host.state, ownerId).includes(targetId)) return
      markUsedThisPhase(host.state, ownerId, ZHANGHU_CUIJIAN)
      const target = playerOf(host.state, targetId)!
      const dodges = target.zones.hand.filter((id) => host.state.cards[id]?.name === '闪')
      zhanghuRecord(host.state, ownerId).targetId = targetId
      if (!dodges.length) {
        const record = zhanghuRecord(host.state, ownerId)
        if (record.redTrick) drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
        return
      }
      const gained = giveOwnedCards(host, targetId, ownerId, zhanghuDodgeArmorIds(host.state, targetId), ZHANGHU_CUIJIAN)
      const record = zhanghuRecord(host.state, ownerId)
      if (record.exchangeRemoved) return
      askZhanghuReturn(host, ownerId, targetId, gained)
      return
    }
    if (resolution.step !== 'return') return
    const targetId = resolution.data.targetId as PlayerId
    const giveCount = resolution.data.giveCount as number
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner || !target?.alive || cardIds.length !== giveCount || new Set(cardIds).size !== giveCount
      || cardIds.some((id) => !owner.zones.hand.includes(id))) return
    giveCards(host, ownerId, targetId, cardIds, ZHANGHU_CUIJIAN)
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
      const card = cardId ? host.state.cards[cardId] : undefined
      if (!card || effectiveCardColor(host.state, ownerId, cardId!) !== 'red') return
      const record = zhanghuRecord(host.state, ownerId)
      if (card.category === 'basic') record.redBasic = true
      if (card.category === 'trick' && INSTANT_TRICKS.has(card.name)) record.redTrick = true
    } },
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
      if (payload.playerId !== ownerId || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (card?.category === 'basic' && effectiveCardColor(host.state, ownerId, payload.cardId) === 'red') {
        const record = zhanghuRecord(host.state, ownerId)
        record.redBasic = true
        record.exchangeRemoved = true
      }
    } },
  ],
})

registerSkillRuntime({
  id: ZHANGHU_TONGYUAN,
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId ?? context.event.cardIds?.[0]
    if (!cardId || host.state.cards[cardId]?.category !== 'basic' || effectiveCardColor(host.state, ownerId, cardId) !== 'red') return
    const record = zhanghuRecord(host.state, ownerId)
    record.redBasic = true
    record.exchangeRemoved = true
  } }],
  trickUnresponsive(state, ownerId, targetId, cardName, cardId) {
    const record = (state as B70State).b70?.zhanghu?.[ownerId]
    return Boolean(record?.redTrick && record.redBasic && cardId && state.cards[cardId]?.category === 'trick'
      && INSTANT_TRICKS.has(cardName) && effectiveCardColor(state, ownerId, cardId) === 'red' && playerOf(state, targetId)?.alive)
  },
  nextCardTargetExpansion(state, ownerId, cardId, _cardName) {
    const record = (state as B70State).b70?.zhanghu?.[ownerId]
    if (!record?.redTrick || !record.redBasic || state.cards[cardId]?.category !== 'basic'
      || effectiveCardColor(state, ownerId, cardId) !== 'red') return null
    return { maxAdditionalTargets: 1, candidateIds: living(state).filter((player) => player.id !== ownerId).map((player) => player.id) }
  },
})

registerSkillRuntime({
  id: MO_ZHANGFEI_JIAOHUN,
  onGameStart(host, ownerId) {
    const record = moZhangfeiRecord(host.state, ownerId)
    record.seenColors = Object.fromEntries(host.state.players.map((player) => [player.id, [healthColorOf(player.hp, player.maxHp)]]))
  },
  viewAs(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play') return []
    return (playerOf(state, ownerId)?.zones.hand ?? []).flatMap((cardId) => state.cards[cardId]?.name === '闪'
      ? [{ asCardName: '杀', cardId, label: '【灼魂】：将【闪】当【杀】使用' }]
      : [])
  },
  prohibitsOwnResponse(state, ownerId, cardName) {
    return state.currentPlayerId === ownerId && cardName === '闪'
  },
  triggers: [
    { event: 'HealthColorChanged', handle(host, ownerId, context) {
      if (!playerOf(host.state, ownerId)?.alive) return
      const payload = context.event.payload as { playerId?: PlayerId; to?: HealthColor }
      if (!payload.playerId || !payload.to) return
      const record = moZhangfeiRecord(host.state, ownerId)
      const colors = record.seenColors[payload.playerId] ??= []
      if (colors.includes(payload.to)) return
      colors.push(payload.to)
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      const targetHandCount = record.transformed ? owner.maxHp : owner.zones.hand.length + 1
      drawCards(host.state, host.rng, ownerId, Math.max(0, targetHandCount - owner.zones.hand.length), (name, data) => host.dispatch(name, data))
      if (!record.transformed) return
      if (payload.to === 'green') record.greenDrawTargets[payload.playerId] = true
      else if (payload.to === 'yellow') {
        suppressSkill(host.state, {
          targetId: payload.playerId, scope: 'non-locked', sourceId: ownerId,
          sourceSkillId: MO_ZHANGFEI_JIAOHUN, expiresAt: 'turn-end',
          armedAtTurn: payload.playerId === host.state.currentPlayerId ? host.state.turnNumber - 1 : host.state.turnNumber,
        })
      } else if (payload.to === 'red') {
        host.queueSkill({ skillId: MO_ZHANGFEI_JIAOHUN, ownerId, step: 'red-gem', data: {
          targetId: payload.playerId, allowedAtChange: !host.state.dying,
        } })
      }
    } },
    { event: 'DrawAttempt', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number; isDraw?: boolean; replacementCardIds?: CardId[] }
      const targetId = payload.playerId
      const record = moZhangfeiRecord(host.state, ownerId)
      if (!targetId || !payload.isDraw || !record.greenDrawTargets[targetId] || host.state.currentPlayerId !== targetId
        || host.state.phase !== 'draw' || context.cancelled) return
      const count = Math.max(0, Math.trunc(payload.count ?? 0))
      const drawn: CardId[] = []
      while (drawn.length < count) {
        let slashes = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
        if (!slashes.length) {
          if (!reshuffleDrawPile(host.state, host.rng, (name, data) => host.dispatch(name, data))) break
          slashes = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
          if (!slashes.length) break
        }
        const cardId = host.rng.pick(slashes)
        moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
        drawn.push(cardId)
      }
      delete record.greenDrawTargets[targetId]
      if (drawn.length) host.dispatch('GainCard', { playerId: targetId, cardIds: drawn, reason: MO_ZHANGFEI_JIAOHUN, isDraw: true }, { targetId, cardIds: drawn })
      payload.replacementCardIds = drawn
      context.cancel()
    } },
    { event: 'PhaseEnd', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase === 'draw' && payload.playerId) delete moZhangfeiRecord(host.state, ownerId).greenDrawTargets[payload.playerId]
    } },
    { event: 'PhaseSkipped', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase === 'draw' && payload.playerId) delete moZhangfeiRecord(host.state, ownerId).greenDrawTargets[payload.playerId]
    } },
    { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (targetId) delete moZhangfeiRecord(host.state, ownerId).greenDrawTargets[targetId]
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
      const targetId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (targetId) delete moZhangfeiRecord(host.state, ownerId).greenDrawTargets[targetId]
    } },
  ],
  startQueued(host, _ownerId, prompt) {
    if (prompt.step !== 'red-gem' || !prompt.data.allowedAtChange || host.state.dying) return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (target?.alive && target.hp > 0) loseHp(host as never, targetId, target.hp, MO_ZHANGFEI_JIAOHUN)
  },
})

registerSkillRuntime({
  id: MO_ZHANGFEI_CHENSHI,
  useCardNameOverride(state, ownerId, sourceId, _cardId, cardName, targetIds) {
    if (cardName !== '杀' || targetIds.length !== 1) return null
    const otherId = sourceId === ownerId ? targetIds[0] : targetIds[0] === ownerId ? sourceId : null
    if (!otherId) return null
    const owner = playerOf(state, ownerId)
    const other = playerOf(state, otherId)
    return owner?.alive && other?.alive && healthColorOf(owner.hp, owner.maxHp) === healthColorOf(other.hp, other.maxHp)
      ? '决斗' : null
  },
  slashTargetExpansionForAction(state, ownerId, cardId, targetIds) {
    if (effectiveCardColor(state, ownerId, cardId) !== 'black' || !targetIds.length) return null
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return null
    const color = healthColorOf(owner.hp, owner.maxHp)
    if (targetIds.some((targetId) => healthColorOf(playerOf(state, targetId)?.hp ?? 0,
      playerOf(state, targetId)?.maxHp ?? 1) === color)) return null
    const candidateIds = living(state)
      .filter((target) => target.id !== ownerId && !targetIds.includes(target.id) && healthColorOf(target.hp, target.maxHp) !== color)
      .map((target) => target.id)
    return candidateIds.length ? { maxAdditionalTargets: candidateIds.length, candidateIds } : null
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string | null; finalAmount?: number }
    if (!payload.finalAmount || !['杀', '决斗'].includes(payload.cardName ?? '')
      || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const record = moZhangfeiRecord(host.state, ownerId)
    if (record.transformed) return
    record.slashDuelDamage += payload.finalAmount
    if (record.slashDuelDamage < 3) return
    record.transformed = true
    recover(host as never, ownerId, 1, ownerId)
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: MO_ZHANGFEI_CHENSHI, skillName: '瞋视', result: 'transformed',
      logText: `${owner.nickname}发动【瞋视】，回复1点体力并入魔`,
    }, { sourceId: ownerId, targetId: ownerId })
  } }],
})

registerSkillRuntime({
  id: MO_SUNQUAN_QUANYU,
  onGameStart(host, ownerId) { sunquanRecord(host.state, ownerId) },
  triggers: [
    { event: 'RoundStart', handle(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive || host.state.groupDecision || host.state.groupCardDecision) return
    const ownerRecord = sunquanRecord(host.state, ownerId)
    ownerRecord.choices = {}
    const playerIds = living(host.state).sort((left, right) => left.seat - right.seat)
      .filter((player) => (ownerRecord.usedChoices[player.id]?.length ?? 0) < SUNQUAN_OPTIONS.length)
      .map((player) => player.id)
    if (!playerIds.includes(ownerId)) return
    startGroupDecision(host, {
      id: `${MO_SUNQUAN_GROUP}:${host.state.roundNumber}:${host.state.seq}`,
      tag: MO_SUNQUAN_GROUP, skillId: MO_SUNQUAN_QUANYU, playerIds,
      prompt: '【权御】：秘密选择一项权御效果', options: SUNQUAN_OPTIONS,
      optionsFor: (playerId) => SUNQUAN_OPTIONS.filter((option) => !ownerRecord.usedChoices[playerId]?.includes(option.id)),
      defaultOptionId: SUNQUAN_OPTIONS.find((option) => !ownerRecord.usedChoices[ownerId]?.includes(option.id))!.id,
      defaultOptionIdFor: (playerId) => SUNQUAN_OPTIONS.find((option) => !ownerRecord.usedChoices[playerId]?.includes(option.id))!.id,
      timeoutMs: 25_000,
      data: { ownerId, roundNumber: host.state.roundNumber },
    })
    } },
  ],
  outgoingDamage(state, ownerId, context) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    const isUniqueSlash = context.cardName === '杀' && isSoleTargetOf(state, context.cardId, context.targetId)
    return record && isUniqueSlash && sunquanSlashEffects(record, ownerId, context.targetId).includes('damage')
      ? { amount: context.amount + 1 } : null
  },
  ignoresArmorFor(state, ownerId, targetId) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    const resolution = state.cardResolution
    return Boolean(record && resolution?.kind === 'slash' && resolution.sourceId === ownerId
      && resolution.targetId === targetId && isSoleTargetOf(state, resolution.cardId, targetId)
      && sunquanSlashEffects(record, ownerId, targetId).includes('armor'))
  },
  slashUndodgeable(state, ownerId, targetId) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    const resolution = state.cardResolution
    return Boolean(record && resolution?.kind === 'slash' && resolution.sourceId === ownerId
      && resolution.targetId === targetId && isSoleTargetOf(state, resolution.cardId, targetId)
      && sunquanSlashEffects(record, ownerId, targetId).includes('unresponsive'))
  },
  ignoresSlashUsesTo(state, ownerId, targetId, targetIds) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    return Boolean(record && targetIds?.length === 1 && targetIds[0] === targetId
      && sunquanSlashEffects(record, ownerId, targetId).includes('unlimited'))
  },
  repeatSlashTarget(state, ownerId, targetId, cardId) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    return Boolean(record && isSoleTargetOf(state, cardId, targetId)
      && sunquanSlashEffects(record, ownerId, targetId).includes('repeat'))
  },
  slashTargetExpansionForAction(state, ownerId, _cardId, targetIds) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    if (!record || targetIds.length !== 1
      || !sunquanSlashEffects(record, ownerId, targetIds[0]).includes('target')) return null
    const candidateIds = living(state).filter((player) => player.id !== ownerId && !targetIds.includes(player.id)).map((player) => player.id)
    return candidateIds.length ? { maxAdditionalTargets: 1, candidateIds } : null
  },
})

registerSkillRuntime({
  id: MO_SUNQUAN_TIANEN,
  handLimitExempt(state, ownerId, cardId) {
    return (state as B70State).b70?.moSunquan?.[ownerId]?.exemptSlashIds.includes(cardId) ?? false
  },
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
    if (context.event.sourceId !== ownerId || payload.targetIds?.length !== 1 || !playerOf(host.state, ownerId)?.alive) return
    const record = sunquanRecord(host.state, ownerId)
    if (record.demon || record.choiceRound !== host.state.roundNumber) return
    if (record.usedTianEn.turnNumber !== host.state.turnNumber) record.usedTianEn = { turnNumber: host.state.turnNumber, options: [] }
    const targetId = payload.targetIds[0]
    const ownChoice = record.choices[ownerId]
    const targetChoice = record.choices[targetId]
    if (!ownChoice || !targetChoice || record.usedTianEn.options.includes(ownChoice)) return
    record.usedTianEn.options.push(ownChoice)
    if (targetChoice === ownChoice) {
      let candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      if (!candidates.length && reshuffleDrawPile(host.state, host.rng, (name, data) => host.dispatch(name, data)))
        candidates = host.state.zones.drawPile.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      const slashId = candidates.length ? host.rng.pick(candidates) : null
      if (!slashId) return
      moveCard(host.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      record.exemptSlashIds.push(slashId)
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [slashId], reason: MO_SUNQUAN_TIANEN },
        { sourceId: ownerId, targetId: ownerId, cardIds: [slashId] })
      return
    }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    if (target.zones.hand.length) {
      const cardId = host.rng.pick(target.zones.hand)
      discardCardsByIds(host as never, targetId, [cardId], MO_SUNQUAN_TIANEN)
    }
    const candidateIds = ownChoice === 'target'
      ? living(host.state).filter((candidate) => candidate.id !== ownerId && candidate.id !== targetId
        && canTarget(host.state, ownerId, candidate.id)
        && !isTargetProhibited(host.state, ownerId, candidate.id, '杀', skillIdsOf)).map((candidate) => candidate.id)
      : []
    host.queueSkill({ skillId: MO_SUNQUAN_TIANEN, ownerId, step: candidateIds.length ? 'choose-target' : 'resolve-slash',
      data: { targetId, candidateIds } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive) return
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    if (prompt.step === 'choose-target') {
      const candidateIds = (prompt.data.candidateIds as PlayerId[]).filter((candidateId) =>
        playerOf(host.state, candidateId)?.alive && canTarget(host.state, ownerId, candidateId)
        && !isTargetProhibited(host.state, ownerId, candidateId, '杀', skillIdsOf))
      host.askSkill({ skillId: MO_SUNQUAN_TIANEN, ownerId, step: 'choose-target', data: { targetId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【天恩】：选择【权御】额外指定的目标（可不选）',
        timeoutMs: 25_000, optional: true, candidateIds, min: 0, max: 1,
      }) })
      return
    }
    if (prompt.step === 'resolve-slash') host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: MO_SUNQUAN_TIANEN })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose-target') return
    const targetId = resolution.data.targetId as PlayerId
    const extraTargetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const targetIds = [targetId, ...(extraTargetId ? [extraTargetId] : [])]
    if (targetIds.some((id) => !playerOf(host.state, id)?.alive)) return
    host.beginVirtualSlash({ sourceId: ownerId, targetIds, maxTargets: 2, sourceSkillId: MO_SUNQUAN_TIANEN })
  },
})

registerSkillRuntime({
  id: MO_SUNQUAN_QIANGANG,
  activeActions(state, ownerId) {
    const record = (state as B70State).b70?.moSunquan?.[ownerId]
    return state.currentPlayerId === ownerId && state.phase === 'play' && playerOf(state, ownerId)?.alive
      && !record?.demon && !isSkillSuppressed(state, ownerId, MO_SUNQUAN_TIANEN)
      ? [{ id: `skill:${MO_SUNQUAN_QIANGANG}`, label: '乾纲：失去天恩并入魔' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MO_SUNQUAN_QIANGANG}`) return
    const record = sunquanRecord(host.state, ownerId)
    if (record.demon || !playerOf(host.state, ownerId)?.alive) return
    record.demon = true
    suppressSkill(host.state, {
      targetId: ownerId, skillId: MO_SUNQUAN_TIANEN, sourceId: ownerId,
      sourceSkillId: MO_SUNQUAN_QIANGANG, expiresAt: 'never', armedAtTurn: host.state.turnNumber,
    })
    host.dispatch('SkillActivated', { skillId: MO_SUNQUAN_QIANGANG, skillName: '乾纲', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【乾纲】并入魔` }, { sourceId: ownerId })
  },
})

registerJudgmentContinuation(SHEN_ZHANGFEI_JUDGE, (host, judged, data) => {
  const targetId = data.targetId as PlayerId
  const judgeText = ALL_CARD_INFO.find((card) => card.name === judged.name)?.description ?? ''
  const target = playerOf(host.state, targetId)
  const ownerId = data.ownerId as PlayerId
  const judging = host.state.players.find((candidate) => candidate.id === ownerId)
  if (judging?.alive && host.state.zones.discardPile.includes(judged.id))
    moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
  if (!target?.alive) return
  const contents = [
    judgeText.includes('体力') ? '笞' : null,
    judgeText.includes('武器') ? '杖' : null,
    judgeText.includes('打出') ? '徒' : null,
    judgeText.includes('距离') ? '流' : null,
  ].filter((mark): mark is string => Boolean(mark))
  if (!contents.length) {
    target.marks['死'] = (target.marks['死'] ?? 0) + 1
    target.marks['神裁手牌上限'] = target.marks['死']
    host.queueSkill({ skillId: SHEN_ZHANGFEI_SHENCAI, ownerId, step: 'take-area', data: { targetId } })
    return
  }
  for (const old of SHEN_ZHANGFEI_MARKS) delete target.marks[old]
  for (const mark of contents) target.marks[mark] = 1
})

registerSkillRuntime({
  id: SHEN_ZHANGFEI_SHENCAI,
  activeActions(state, ownerId) {
    const player = playerOf(state, ownerId)
    const records = (((state as B70State).b70 ??= {}).shenZhangfei ??= {})
    const record = records[ownerId] ??= { usesThisPhase: 0, phaseKey: '', extraUseCap: 0 }
    const phaseKey = `${state.turnNumber}:${state.phase}`
    if (record.phaseKey !== phaseKey) { record.phaseKey = phaseKey; record.usesThisPhase = 0 }
    const cap = Math.min(5, 1 + record.extraUseCap)
    return player?.alive && state.currentPlayerId === ownerId && state.phase === 'play'
      && record.usesThisPhase < cap
      ? [{ id: `skill:${SHEN_ZHANGFEI_SHENCAI}`, label: '神裁：令一名角色判定' }]
      : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SHEN_ZHANGFEI_SHENCAI}`) return
    const candidateIds = living(host.state).filter((candidate) => candidate.id !== ownerId).map((candidate) => candidate.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: SHEN_ZHANGFEI_SHENCAI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【神裁】：选择一名其他角色判定', timeoutMs: 25_000, optional: false,
      candidateIds, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'take-area') {
      const targetId = resolution.data.targetId as PlayerId
      const area = (response.payload as { optionId?: string }).optionId
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !area) return
      if (area === 'hand') {
        const cardId = target.zones.hand.length ? host.rng.pick(target.zones.hand) : null
        if (cardId) giveCards(host as never, targetId, ownerId, [cardId], SHEN_ZHANGFEI_SHENCAI)
        return
      }
      const cardIds = area === 'equipment'
        ? Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
        : area === 'judgingArea' ? [...target.zones.judgingArea] : []
      if (cardIds.length === 1) {
        const from = locateOwnedCard(host.state, targetId, cardIds[0])
        if (from) moveCard(host.state, cardIds[0], from, { kind: 'hand', playerId: ownerId })
      } else if (cardIds.length > 1) {
        host.askSkill({ skillId: SHEN_ZHANGFEI_SHENCAI, ownerId, step: 'take-card', data: { targetId }, build: (id): ChooseCardsRequest => ({
          id, kind: 'choose-cards', playerId: ownerId, prompt: '【神裁】：选择获得其中一张牌', timeoutMs: 25_000,
          cardIds, hiddenCardSlots: [], min: 1, max: 1, optional: false,
        }) })
      }
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId && locateOwnedCard(host.state, targetId, cardId)
      if (cardId && from && from.kind !== 'hand') moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
      return
    }
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    const records = (((host.state as B70State).b70 ??= {}).shenZhangfei ??= {})
    const record = records[ownerId] ??= { usesThisPhase: 0, phaseKey: `${host.state.turnNumber}:${host.state.phase}`, extraUseCap: 0 }
    record.usesThisPhase += 1
    performJudgment(host as never, targetId, SHEN_ZHANGFEI_SHENCAI, { tag: SHEN_ZHANGFEI_JUDGE, data: { ownerId, targetId } })
  },
  triggers: [
    { event: 'DamageSettled', allowDeadOwner: true, handle(host, _ownerId, context) {
      const payload = context.event.payload as { finalAmount?: number }
      const targetId = context.event.targetId
      if (!payload.finalAmount || !targetId || !claimShenZhangfeiEvent(host.state, context.event.id, 'damage')) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      if (target.marks['笞']) loseHp(host as never, targetId, payload.finalAmount, SHEN_ZHANGFEI_SHENCAI)
    } },
    { event: 'HandCardLeft', handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; destination?: { kind?: string } }
      if (!payload.playerId || (host.state as B70State).b70?.shenZhangfeiPenalizingPlayers?.[payload.playerId]
        || payload.destination?.kind === 'characterPile' || payload.destination?.kind === 'processingArea'
        || !claimShenZhangfeiEvent(host.state, context.event.id, 'hand-loss')) return
      const target = playerOf(host.state, payload.playerId)
      if (target?.marks['徒'] && target.zones.hand.length) {
        const discarded = host.rng.pick(target.zones.hand)
        const b70 = stateOf(host.state)
        const penalizing = b70.shenZhangfeiPenalizingPlayers ??= {}
        penalizing[payload.playerId] = true
        try { discardCardsByIds(host as never, payload.playerId, [discarded], SHEN_ZHANGFEI_SHENCAI) }
        finally { delete penalizing[payload.playerId] }
      }
    } },
    { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const targetId = payload.playerId
      const target = targetId ? playerOf(host.state, targetId) : null
      if (targetId && target?.alive && (target.marks['死'] ?? 0) > living(host.state).length)
        killPlayer(host as never, targetId, ownerId, SHEN_ZHANGFEI_SHENCAI)
    } },
    { event: 'PhaseEnd', allowDeadOwner: true, handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const target = payload.playerId ? playerOf(host.state, payload.playerId) : null
      if (target?.alive && payload.phase === 'finish' && target.marks['流']
        && claimShenZhangfeiEvent(host.state, context.event.id, 'flip'))
        flipCharacter(host as never, target.id, SHEN_ZHANGFEI_SHENCAI)
    } },
  ],
  globalMaxCardsBonus(state, _ownerId, targetId) {
    const firstOwner = living(state).filter((player) => player.characterId && skillIdsOf(player.characterId).includes(SHEN_ZHANGFEI_SHENCAI))
      .sort((left, right) => left.seat - right.seat)[0]?.id
    if (firstOwner !== _ownerId) return 0
    return -(playerOf(state, targetId)?.marks['神裁手牌上限'] ?? 0)
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'take-area') return
    const target = playerOf(host.state, prompt.data.targetId as PlayerId)
    if (!target?.alive) return
    const options = [
      ...(target.zones.hand.length ? [{ id: 'hand', label: `手牌（${target.zones.hand.length}）` }] : []),
      ...(Object.values(target.zones.equipment).some(Boolean) ? [{ id: 'equipment', label: '装备区' }] : []),
      ...(target.zones.judgingArea.length ? [{ id: 'judgingArea', label: '判定区' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: SHEN_ZHANGFEI_SHENCAI, ownerId, step: 'take-area', data: { targetId: target.id }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【神裁】：选择获得其一个区域内的一张牌', timeoutMs: 25_000,
      options, optional: false,
    }) })
  },
})

registerSkillRuntime({
  id: SHEN_ZHANGFEI_XUNSHI,
  activeActionUsesCard: true,
  activeActions(state, ownerId) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || !playerOf(state, ownerId)?.alive) return []
    return (playerOf(state, ownerId)?.zones.hand ?? []).filter((cardId) => {
      const card = state.cards[cardId]
      return card?.category === 'trick' && SHEN_ZHANGFEI_MULTI_TARGET_TRICKS.has(card.name)
    }).map((cardId) => ({ id: `skill:${SHEN_ZHANGFEI_XUNSHI}:slash:${cardId}`, label: `巡使：将【${state.cards[cardId]?.name}】当无色【杀】使用` }))
  },
  invokeActive(host, ownerId, actionId) {
    const prefix = `skill:${SHEN_ZHANGFEI_XUNSHI}:slash:`
    if (!actionId.startsWith(prefix)) return
    const cardId = actionId.slice(prefix.length)
    const card = host.state.cards[cardId]
    const owner = playerOf(host.state, ownerId)
    if (!owner?.zones.hand.includes(cardId) || card?.category !== 'trick' || !SHEN_ZHANGFEI_MULTI_TARGET_TRICKS.has(card.name)) return
    const candidateIds = living(host.state).filter((target) => target.id !== ownerId
      && !isTargetProhibited(host.state, ownerId, target.id, '杀', skillIdsOf, cardId, SHEN_ZHANGFEI_XUNSHI)).map((target) => target.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: SHEN_ZHANGFEI_XUNSHI, ownerId, step: 'slash-targets', data: { cardId, candidateIds }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: `【巡使】：选择【${card.name}】当【杀】的目标（可多选）`, timeoutMs: 25_000,
      candidateIds, min: 1, max: candidateIds.length, optional: false,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'slash-targets') return
    const cardId = resolution.data.cardId as CardId
    const card = host.state.cards[cardId]
    const owner = playerOf(host.state, ownerId)
    const candidateIds = new Set(resolution.data.candidateIds as PlayerId[])
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      .filter((targetId) => candidateIds.has(targetId) && playerOf(host.state, targetId)?.alive
        && !isTargetProhibited(host.state, ownerId, targetId, '杀', skillIdsOf, cardId, SHEN_ZHANGFEI_XUNSHI))
    if (!owner?.zones.hand.includes(cardId) || card?.category !== 'trick' || !targetIds.length) return
    setCardAlias(host.state, cardId, '杀')
    setCardColorOverride(host.state, cardId, null)
    host.beginVirtualSlash({ sourceId: ownerId, targetIds, maxTargets: targetIds.length, cardId,
      sourceSkillId: SHEN_ZHANGFEI_XUNSHI, countUsage: false, ignoreDistance: true,
      allowMultipleTargetsWithPhysicalCard: true })
  },
  prohibitsCardUse(_state, ownerId, context) {
    return context.userId === ownerId && SHEN_ZHANGFEI_MULTI_TARGET_TRICKS.has(context.cardName)
  },
  slashIgnoresDistance(state, ownerId, cardId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === null)
  },
  unlimitedSlashFor(state, ownerId, cardId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === null)
  },
  unlimitedWineFor(state, ownerId, cardId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === null)
  },
  ignoresTrickDistance(state, ownerId, cardId) {
    return state.currentPlayerId === ownerId && state.phase === 'play' && Boolean(cardId && effectiveCardColor(state, ownerId, cardId) === null)
  },
  slashTargetExpansionForAction(state, ownerId, cardId, targetIds) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || effectiveCardColor(state, ownerId, cardId) !== null) return null
    return { maxAdditionalTargets: state.players.length, candidateIds: living(state).filter((target) => target.id !== ownerId && !targetIds.includes(target.id)).map((target) => target.id) }
  },
  nextCardTargetExpansion(state, ownerId, cardId, cardName) {
    if (state.currentPlayerId !== ownerId || state.phase !== 'play' || effectiveCardColor(state, ownerId, cardId) !== null
      || !INSTANT_TRICKS.has(cardName)) return null
    return { maxAdditionalTargets: state.players.length, candidateIds: living(state).filter((target) => target.id !== ownerId).map((target) => target.id) }
  },
  cannotBeNullified(state, ownerId) {
    const resolution = state.cardResolution
    return Boolean(resolution?.kind === 'trick' && resolution.sourceId === ownerId
      && effectiveCardColor(state, ownerId, resolution.cardId) === null)
  },
  slashUndodgeable(state, ownerId, targetId) {
    const resolution = state.cardResolution
    return Boolean(resolution?.kind === 'slash' && resolution.sourceId === ownerId
      && resolution.targetId === targetId && effectiveCardColor(state, ownerId, resolution.cardId) === null)
  },
  triggers: [{ event: 'CardUsed', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId) return
    const cardId = (context.event.payload as { cardId?: CardId }).cardId
    if (!cardId || effectiveCardColor(host.state, ownerId, cardId) !== null) return
    const records = (((host.state as B70State).b70 ??= {}).shenZhangfei ??= {})
    const phaseKey = `${host.state.turnNumber}:${host.state.phase}`
    const record = records[ownerId] ??= { usesThisPhase: 0, phaseKey, extraUseCap: 0 }
    if (record.phaseKey !== phaseKey) { record.phaseKey = phaseKey; record.usesThisPhase = 0; record.extraUseCap = 0 }
    record.extraUseCap = Math.min(4, record.extraUseCap + 1)
  } }],
})

registerSkillRuntime({
  id: SHEN_DENGAI_XIANJIN,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.hiddenCharacterPiles = [...new Set([...(owner.hiddenCharacterPiles ?? []), ...SHEN_DENGAI_ZONES])]
    shenDengAiRecord(host.state, ownerId)
  },
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    const amount = (context.event.payload as { finalAmount?: number }).finalAmount ?? 0
    if (amount <= 0 || (context.event.sourceId !== ownerId && context.event.targetId !== ownerId)) return
    const record = shenDengAiRecord(host.state, ownerId)
    record.damageCount += 1
    if (record.damageCount < 2 || record.developed.length >= SHEN_DENGAI_ZONES.length) return
    record.damageCount -= 2
    host.queueSkill({ skillId: SHEN_DENGAI_XIANJIN, ownerId, step: 'develop', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'develop' || !playerOf(host.state, ownerId)?.alive) return
    const record = shenDengAiRecord(host.state, ownerId)
    const options = SHEN_DENGAI_ZONES.filter((zone) => !record.developed.includes(zone))
    if (!options.length) return
    host.askSkill({ skillId: SHEN_DENGAI_XIANJIN, ownerId, step: 'develop', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【险进】：选择开发一个手牌副区域', timeoutMs: 25_000,
      optional: false, options: options.map((zone) => ({ id: zone, label: zone })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'develop') return
    const zone = (response.payload as { optionId?: string }).optionId
    const record = shenDengAiRecord(host.state, ownerId)
    if (!zone || !(SHEN_DENGAI_ZONES as readonly string[]).includes(zone) || record.developed.includes(zone)) return
    record.developed.push(zone)
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive) owner.hiddenCharacterPiles = (owner.hiddenCharacterPiles ?? []).filter((pile) => pile !== zone)
    const handCounts = living(host.state).map((player) => player.zones.hand.length)
    drawCards(host.state, host.rng, ownerId, handCounts.every((count) => count <= (owner?.zones.hand.length ?? 0)) ? 1 : record.developed.length,
      host.dispatch.bind(host))
  },
})

registerSkillRuntime({
  id: SHEN_DENGAI_TUOYU,
  playableCharacterPiles(state, ownerId) {
    return shenDengAiRecord(state, ownerId).developed
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const record = shenDengAiRecord(host.state, ownerId)
      if (payload.playerId === ownerId && payload.phase === 'play' && record.developed.length)
        host.queueSkill({ skillId: SHEN_DENGAI_TUOYU, ownerId, step: 'assign', data: { zones: record.developed, index: 0 } })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      const record = shenDengAiRecord(host.state, ownerId)
      if (payload.playerId === ownerId && payload.phase === 'play' && record.developed.length)
        host.queueSkill({ skillId: SHEN_DENGAI_TUOYU, ownerId, step: 'assign', data: { zones: record.developed, index: 0 } })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; fromPile?: string }
      if (payload.cardId && payload.fromPile && SHEN_DENGAI_ZONES.includes(payload.fromPile as typeof SHEN_DENGAI_ZONES[number]))
        shenDengAiRecord(host.state, ownerId).cardOrigins[payload.cardId] = payload.fromPile
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (payload.cardId) delete shenDengAiRecord(host.state, ownerId).cardOrigins[payload.cardId]
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'assign' || !playerOf(host.state, ownerId)?.alive) return
    const zones = prompt.data.zones as string[]
    const index = prompt.data.index as number
    const hand = playerOf(host.state, ownerId)!.zones.hand
    if (!zones[index] || !hand.length) return
    if (index === zones.length - 1) {
      for (const cardId of [...hand]) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: zones[index] })
      return
    }
    host.askSkill({ skillId: SHEN_DENGAI_TUOYU, ownerId, step: 'assign-cards', data: { zones, index, cardIds: [...hand] }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: `【拓域】：选择置入「${zones[index]}」的手牌，其余牌继续分配`, timeoutMs: 25_000,
      cardIds: [...hand], hiddenCardSlots: [], min: 0, max: hand.length, optional: false,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'assign-cards') return
    const zones = resolution.data.zones as string[]
    const index = resolution.data.index as number
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const legalIds = new Set(resolution.data.cardIds as CardId[])
    for (const cardId of selected) if (legalIds.has(cardId) && playerOf(host.state, ownerId)?.zones.hand.includes(cardId))
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: zones[index] })
    host.queueSkill({ skillId: SHEN_DENGAI_TUOYU, ownerId, step: 'assign', data: { zones, index: index + 1 } })
  },
  outgoingDamage(state, ownerId, context) {
    return context.cardId && shenDengAiCardPile(state, ownerId, context.cardId) === '丰田'
      ? { amount: context.amount + 1 } : null
  },
  recoverAmountBonus(state, ownerId, _sourceId, sourceCardId) {
    return sourceCardId && shenDengAiCardPile(state, ownerId, sourceCardId) === '丰田' ? 1 : 0
  },
  slashIgnoresDistance(state, ownerId, cardId) {
    return state.phase === 'play' && Boolean(cardId && shenDengAiCardPile(state, ownerId, cardId) === '清渠')
  },
  unlimitedSlashFor(state, ownerId, cardId) {
    return state.phase === 'play' && Boolean(cardId && shenDengAiCardPile(state, ownerId, cardId) === '清渠')
  },
  unlimitedWineFor(state, ownerId, cardId) {
    return state.phase === 'play' && Boolean(cardId && shenDengAiCardPile(state, ownerId, cardId) === '清渠')
  },
  ignoresTrickDistance(state, ownerId, cardId) {
    return state.phase === 'play' && Boolean(cardId && shenDengAiCardPile(state, ownerId, cardId) === '清渠')
  },
  slashUndodgeable(state, ownerId, targetId) {
    const resolution = state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.sourceId !== ownerId) return false
    const pile = (state as B70State).b70?.shenDengAi?.[ownerId]?.cardOrigins[resolution.cardId]
    return pile === '峻山' && resolution.targetId === targetId
  },
  cannotBeNullified(state, ownerId) {
    const resolution = state.cardResolution
    return Boolean(resolution?.kind === 'trick' && (state as B70State).b70?.shenDengAi?.[ownerId]?.cardOrigins[resolution.cardId] === '峻山')
  },
})

registerSkillRuntime({
  id: SHEN_DENGAI_QIJING,
  triggers: [{ event: 'TurnEnd', handle(host, ownerId) {
    const record = shenDengAiRecord(host.state, ownerId)
    if (record.awakened || record.developed.length !== SHEN_DENGAI_ZONES.length || !playerOf(host.state, ownerId)?.alive) return
    record.awakened = true
    loseMaxHp(host as never, ownerId, 1, SHEN_DENGAI_QIJING)
    grantSkill(host.state, ownerId, SHEN_DENGAI_CUIXIN)
    host.queueSkill({ skillId: SHEN_DENGAI_QIJING, ownerId, step: 'seat', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'seat') return
    const others = living(host.state).filter((player) => player.id !== ownerId).sort((a, b) => a.seat - b.seat)
    const options = others.flatMap((player, index) => {
      const right = others[(index + 1) % others.length]
      return right ? [{ id: `${player.id}|${right.id}`, label: `移动至${player.nickname}与${right.nickname}之间` }] : []
    })
    if (!options.length) { queueExtraTurn(host.state, ownerId, { skillId: SHEN_DENGAI_QIJING, playerId: ownerId }); return }
    host.askSkill({ skillId: SHEN_DENGAI_QIJING, ownerId, step: 'seat-choice', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【奇径】：选择插入的相邻座位', timeoutMs: 25_000,
      options, optional: false,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'seat-choice') return
    const choice = (response.payload as { optionId?: string }).optionId
    const pair = choice?.split('|') as [PlayerId, PlayerId] | undefined
    const owner = playerOf(host.state, ownerId)
    const first = pair && playerOf(host.state, pair[0])
    const second = pair && playerOf(host.state, pair[1])
    if (owner && first && second) {
      const livingOthers = living(host.state).filter((player) => player.id !== ownerId).sort((a, b) => a.seat - b.seat)
      const firstIndex = livingOthers.findIndex((player) => player.id === first.id)
      const secondIndex = livingOthers.findIndex((player) => player.id === second.id)
      if ((firstIndex + 1) % livingOthers.length === secondIndex) {
        const allOthers = host.state.players.filter((player) => player.id !== ownerId).sort((a, b) => a.seat - b.seat)
        const insertAt = allOthers.findIndex((player) => player.id === first.id) + 1
        allOthers.splice(insertAt, 0, owner)
        const orderedIds = allOthers.map((player) => player.id)
        applySeatPermutation(host.state, orderedIds)
        host.dispatch('SeatOrderChanged', { reason: SHEN_DENGAI_QIJING, playerIds: orderedIds }, { sourceId: ownerId })
      }
    }
    queueExtraTurn(host.state, ownerId, { skillId: SHEN_DENGAI_QIJING, playerId: ownerId })
  },
})

registerSkillRuntime({
  id: SHEN_DENGAI_CUIXIN,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[]; sourceSkillId?: string }
    if (context.event.sourceId !== ownerId || payload.sourceSkillId === SHEN_DENGAI_CUIXIN || payload.targetIds?.length !== 1
      || !playerOf(host.state, ownerId)?.alive) return
    const targetId = payload.targetIds[0]
    const others = living(host.state).sort((a, b) => a.seat - b.seat)
    const index = others.findIndex((player) => player.id === ownerId)
    const previous = others[(index - 1 + others.length) % others.length]?.id
    const next = others[(index + 1) % others.length]?.id
    if (targetId !== previous && targetId !== next) return
    const opposite = targetId === previous ? next : previous
    if (!opposite || !playerOf(host.state, opposite)?.alive) return
    host.queueSkill({ skillId: SHEN_DENGAI_CUIXIN, ownerId, step: 'repeat', data: { cardName: payload.cardName, targetId: opposite } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'repeat') return
    const cardName = prompt.data.cardName as string
    const targetId = prompt.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    if (!INSTANT_TRICKS.has(cardName) && !['杀', '桃', '酒'].includes(cardName)) return
    host.askSkill({ skillId: SHEN_DENGAI_CUIXIN, ownerId, step: 'repeat-choice', data: { cardName, targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【摧心】：是否对${playerOf(host.state, targetId)?.nickname}视为使用【${cardName}】？`, timeoutMs: 25_000,
      options: [{ id: 'yes', label: '使用' }, { id: 'no', label: '不使用' }], optional: false,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'repeat-choice' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const cardName = resolution.data.cardName as string
    const targetId = resolution.data.targetId as PlayerId
    if (!playerOf(host.state, targetId)?.alive) return
    if (['杀', '桃', '酒'].includes(cardName)) host.beginVirtualBasic({ sourceId: ownerId, targetIds: [targetId], cardName, sourceSkillId: SHEN_DENGAI_CUIXIN })
    else if (DELAYED_TRICKS.has(cardName)) host.beginVirtualDelayedTrick({ sourceId: ownerId, targetId, cardName, sourceSkillId: SHEN_DENGAI_CUIXIN })
    else host.beginVirtualTrick({ sourceId: ownerId, targetIds: [targetId], cardName, sourceSkillId: SHEN_DENGAI_CUIXIN })
  },
})

const HISTORICAL_BATCH70_CHARACTERS_UNSORTED: readonly CharacterDefinition[] = [
  { id: 'mo-simayi-b70', name: '魔·司马懿', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: MO_SIMAYI_GUIFU, name: '诡伏', description: '每轮开始时或你体力值变化后，你获得一张不计入手牌上限的【闪】。技能或牌造成伤害后，你记录此技能或牌名。你可将因此技能获得的【闪】当做记录的牌名使用（不计入次数限制，每回合每种牌名限一次）。' },
    { id: MO_SIMAYI_MOUBIAN, name: '谋变', description: '准备阶段，若你“诡伏”记录数至少为3，你可入魔，获得你“诡伏”记录的技能，并获得“骤袭”。' },
    { id: MO_SIMAYI_ZOUXI, name: '骤袭', description: '准备阶段，你从技能池中随机获得三个技能中的一个，直到下回合开始。回合结束时，本回合对你造成过伤害的角色依次视为对你使用一张【杀】。入魔后，每轮结束时，若本轮你未造成过伤害，你失去1点体力。', granted: true },
  ] },
  { id: 'mo-lubu-b70', name: '魔·吕布', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MO_LUBU_KUANGMO, name: '狂魔', description: '出牌阶段，你可以入魔并选择一名其他角色，你与其成为“狂”角色：每回合对彼此首次造成的伤害+1；击败对方后，获得对方所有“炁”；“狂”角色死亡后，你重新指定。' },
    { id: MO_LUBU_DUOQI, name: '夺炁', description: '锁定技，一号位首个回合开始前，你执行一个不能使用延时锦囊牌的额外出牌阶段。所有角色的初始手牌称为“炁”。你每回合对一名角色首次造成伤害后，你获得其一张“炁”。' },
    { id: MO_LUBU_GANGQUAN, name: '罡拳', description: '若你使用的上一张牌为“炁”，你可以将一张装备牌当指定相邻角色为目标的火【杀】使用；否则，你可以将一张锦囊牌当【决斗】使用。' },
  ] },
  { id: 'mo-caocao-b70', name: '魔·曹操', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MO_CAOCAO_FUZAI, name: '覆载', description: '锁定技，你的装备牌只能当【借刀杀人】或【无中生有】使用。若你的装备区里没有牌，你视为装备着一张武器牌和防具牌。', locked: true },
    { id: MO_CAOCAO_BACHAO, name: '霸朝', description: '出牌阶段开始时，你可以令所有其他角色同时选择是否交给你一张牌，然后你可对未以此法交给你非基本牌的一名角色造成1点伤害；若你选择自己，本阶段你使用当前手牌无次数和距离限制并入魔。' },
  ] },
  { id: 'mo-diaochan-b70', name: '魔·貂蝉', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: MO_DIAOCHAN_HUANHUO, name: '幻惑', description: '每轮开始时，你摸两张牌，然后弃置至多两张牌并选择等量其他角色。其下回合出牌阶段强制选中一张可用的手牌，且每使用一张牌后随机弃一张牌，直到其使用了两张牌后。' },
    { id: MO_DIAOCHAN_QINGSHI, name: '倾世', description: '准备阶段，你可入魔，令所有角色获得一张单目标伤害牌；其他角色使用此牌指定唯一目标时，你可弃置一张牌，重新指定牌的目标（无距离限制）。这些牌造成伤害后你摸一张牌；未因使用进入弃牌堆后你获得之。准备阶段，若这些牌均离开其手牌区，你再令所有角色获得牌。' },
  ] },
  { id: 'zhanghu-b70', name: '张虎', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGHU_CUIJIAN, name: '摧坚', description: '出牌阶段限一次，你可以选择一名有手牌的角色，若其手牌中有【闪】，其将所有【闪】和防具牌交给你，然后你交给其等量的牌。' },
    { id: ZHANGHU_TONGYUAN, name: '同援', description: '锁定技，你使用红色锦囊牌后，“摧坚”增加描述“若其没有【闪】，你摸两张牌”；你使用或打出红色基本牌后，“摧坚”将“交给”的效果删除。若以上两个效果都已触发，则你本局游戏接下来使用红色普通锦囊牌无法响应，使用红色基本牌可以额外指定一个目标。', locked: true },
  ] },
  { id: 'wuzhuge-b70', name: '武诸葛亮', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WUZHUGE_JINCU, name: '尽瘁', description: '锁定技，游戏开始时，你将手牌摸至7张。准备阶段，你的体力值调整为与牌堆中点数为7的游戏牌数量相等（至少为1）。然后你观看牌堆顶X张牌，将这些牌以任意顺序放回牌堆顶或牌堆底（X为你的体力值）。', locked: true },
    { id: WUZHUGE_QINGSHI, name: '情势', description: '你于出牌阶段内使用一张牌时（每种牌名每回合限1次），若手牌中有同名牌，你可以选择一项：1.令此牌对其中1个目标造成的伤害值+1；2.令任意名其他角色各摸1张牌；3.摸3张牌，然后此技能本回合失效。' },
    { id: WUZHUGE_ZHIZHE, name: '智哲', description: '限定技，出牌阶段，你可以“复制”一张手牌。此牌因你使用或打出进入弃牌堆时，改为将此牌收回手牌且本回合不能再使用或打出。' },
  ] },
  { id: 'mo-sunquan-b70', name: '魔·孙权', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: MO_SUNQUAN_QUANYU, name: '权御', description: '锁定技，每轮开始时，所有角色同时选择一项（每人每项限一次），然后若其中有角色与你的“权御”效果相同，你摸X张牌（X为其中与你相同的角色数且至多为3）：白虹：伤害+1；青冥：目标+1；辟邪：无视防具；紫电：不可响应；百里：额外结算；流星：无次数限制。你的【杀】指定唯一目标时，执行你选择的效果。', locked: true },
    { id: MO_SUNQUAN_TIANEN, name: '天恩', description: '锁定技，每回合每项各限一次，你使用牌指定唯一目标后：若本轮你与其选择的“权御”效果不同，你随机弃置其一张牌，对其发动一次“权御”；若与你相同，你获得一张不计入手牌上限的【杀】。', locked: true },
    { id: MO_SUNQUAN_QIANGANG, name: '乾纲', description: '出牌阶段，你可失去“天恩”并入魔，然后你的【杀】指定唯一目标时，执行目标选择过的所有“权御”效果。' },
  ] },
  { id: 'mo-zhangfei-b70', name: '魔·张飞', kingdom: 'shu', gender: 'male', maxHp: 5, pack: 'sp', skills: [
    { id: MO_ZHANGFEI_JIAOHUN, name: '灼魂', description: '锁定技，你的回合内：你的【闪】均视为【杀】；一名角色的勾玉首次变为一个颜色后，你摸一张牌。入魔后，该角色勾玉颜色首次变化时，你将手牌摸至体力上限，并执行对应效果：绿色，其本回合摸牌改为从牌堆获得等量【杀】；黄色，其本回合非锁定技失效；红色，若无角色处于濒死状态，其失去所有体力。', locked: true },
    { id: MO_ZHANGFEI_CHENSHI, name: '瞋视', description: '锁定技，若其他角色的勾玉颜色与你不同，你使用黑色【杀】能额外指定其为目标；相同，你对其，或其对你使用的黑色【杀】改为【决斗】。你因【杀】和【决斗】首次造成了或受到了至少3点伤害后，你回复1点体力，修改“灼魂”并入魔。', locked: true },
  ] },
  { id: 'shen-zhangfei-b70', name: '神·张飞', kingdom: 'shen', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SHEN_ZHANGFEI_SHENCAI, name: '神裁', description: '出牌阶段限一次，你可以令一名其他角色进行判定且你获得判定牌。判定牌包含“体力、武器、打出、距离”对应内容时，其获得对应“笞、杖、徒、流”标记（已有则替换）；否则获得“死”标记、手牌上限减少其“死”标记数，你获得其区域内一张牌。“死”标记数大于存活人数时，该角色回合结束时死亡。' },
    { id: SHEN_ZHANGFEI_XUNSHI, name: '巡使', description: '锁定技，你的多目标锦囊牌视为无色【杀】；你使用无色牌无距离和次数限制且可额外指定任意目标，每次使用令“神裁”次数上限+1（至多5）。' },
  ] },
  { id: 'shen-dengai-b70', name: '神·邓艾', kingdom: 'shen', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: SHEN_DENGAI_TUOYU, name: '拓域', description: '锁定技，你的手牌区添加“丰田、清渠、峻山”三个手牌副区域，分别令牌伤害与回复值+1、无次数及距离限制、无法响应。出牌阶段开始及结束时，你将手牌分配至已开发的副区域。' },
    { id: SHEN_DENGAI_XIANJIN, name: '险进', description: '锁定技，你每累计造成或受到2次伤害后，开发一个副区域，然后摸等同已开发副区域数的牌；若你手牌数为全场最多则改为摸一张。' },
    { id: SHEN_DENGAI_QIJING, name: '奇径', description: '觉醒技，每个回合结束后，若手牌副区域均已开发，你减1点体力上限，获得“摧心”，移动至两名其他相邻角色之间并获得一个额外回合。' },
    { id: SHEN_DENGAI_CUIXIN, name: '摧心', description: '当你对上家/下家使用牌结算结束后，若此牌不为以此法视为使用的牌，你可以视为对下家/上家使用一张与此牌牌名相同的牌。', granted: true },
  ] },
]

const HISTORICAL_BATCH70_ROSTER_ORDER = [
  'mo-simayi-b70', 'mo-lubu-b70', 'mo-diaochan-b70', 'mo-caocao-b70', 'mo-sunquan-b70',
  'mo-zhangfei-b70', 'shen-zhangfei-b70', 'shen-dengai-b70', 'wuzhuge-b70', 'zhanghu-b70',
]
const HISTORICAL_BATCH70_ORDER_INDEX = new Map(HISTORICAL_BATCH70_ROSTER_ORDER.map((id, index) => [id, index]))
export const HISTORICAL_BATCH70_CHARACTERS: readonly CharacterDefinition[] = [...HISTORICAL_BATCH70_CHARACTERS_UNSORTED]
  .sort((left, right) => (HISTORICAL_BATCH70_ORDER_INDEX.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (HISTORICAL_BATCH70_ORDER_INDEX.get(right.id) ?? Number.MAX_SAFE_INTEGER))

