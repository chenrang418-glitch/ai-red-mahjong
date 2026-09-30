import type { CharacterDefinition } from './types'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { revealTopCards } from '../../engine/draw'
import { DAMAGE_TRICKS } from '../../engine/cards/tricks'
import { effectiveCardColor, effectiveCardSuit, isCardProtectedFromDiscard, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { isCardUseProhibited, isTargetProhibited } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import { loseMaxHp } from '../../engine/hp'
import { drawCards } from '../../engine/draw'
import { closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards } from '../../engine/private-zone'
import { moveCard } from '../../engine/zones'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { getCharacter, skillIdsOf } from './standard'
import { responseViewAsOptions } from './standard'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { recover, recoverTo } from '../../engine/recover'
import { suppressSkill } from '../../engine/skill-suppression'
import { getAttackRange, getDistance } from '../../engine/distance'
import { giveCards } from '../../engine/hand-transfer'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { effectiveCardName, setCardAlias } from '../../engine/zones'
import { resumeSourceDamagePrevention } from '../../engine/damage'
import { abolishSlot, abolishedSlotsOf, equipmentSlotsOf, restoreSlot } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { canTarget } from '../../engine/distance'
import { canUseSlashAtTargets } from '../../engine/slash-rules'
import { wineUseAllowed } from '../../engine/cards/basic'
import { instantTrickActions } from '../../engine/cards/tricks'

const b60 = (id: string) => `${id}:b60`
const HUAYONG_SHIYONG = b60('shiyong-jianghuaxiong')
const GAOGAN_JUGUAN = b60('juguan-gaogan')
const ZHANGHE_ZHOUXUAN = b60('zhouxuan-zhanghe')
const ZHANGHE_PILE = (ownerId: PlayerId) => `${ZHANGHE_ZHOUXUAN}:${ownerId}`
const ZUOFEN_LISI = b60('lisi-zuofen')
const ZUOFEN_ZHAOSONG = b60('zhaosong-zuofen')
const WANGJI_QIZHI = b60('qizhi-jie-wangji')
const WANGJI_JINQU = b60('jinqu-jie-wangji')
const LVKUANG_QIGONG = b60('qigong-lvkuang-lvxiang')
const LVKUANG_LIEHOU = b60('liehou-lvkuang-lvxiang')
const ZHANGLIAO_MUBING = b60('mubing-sp-zhangliao')
const ZHANGLIAO_ZIQU = b60('ziqu-sp-zhangliao')
const ZHANGLIAO_TIAOLING = b60('tiaoling-sp-zhangliao')
const WOLONG_YOULONG = b60('youlong-wolong-fengchu')
const WOLONG_LUANFENG = b60('luanfeng-wolong-fengchu')
const HUANGCHENGYAN_GUANXU = b60('guanxu-huangchengyan')
const HUANGCHENGYAN_YASHI = b60('yashi-huangchengyan')
const FANJIANG_YUANCHOU = b60('yuanchou-fanjiang-zhangda')
const FANJIANG_JUESHENG = b60('juesheng-fanjiang-zhangda')

type Batch60State = SanguoshaState & {
  b60Gaogan?: Record<PlayerId, { turnNumber: number; playPhaseSerial: number; usedPhaseSerial?: number }>
  b60GaoganDamage?: Record<PlayerId, Array<{ turnNumber: number; cardId: CardId; hitTargetIds: PlayerId[]; hitOwner: boolean }>>
  b60GaoganDrawBonus?: Record<PlayerId, boolean>
  b60Zhanghe?: Record<PlayerId, { storedAtTurn: number }>
  b60ZuofenOutsideUses?: Record<PlayerId, Record<CardId, number>>
  b60ZuofenToken?: Record<PlayerId, { kind: 'lei' | 'fu' | 'song'; sourceId: PlayerId }>
  b60Wangji?: Record<PlayerId, { phaseRecipients: PlayerId[]; usedCards: number; chargeMaximumThisTurn: number }>
  b60FanjiangPending?: Record<PlayerId, PlayerId>
  b60FanjiangGrantedAt?: Record<PlayerId, Array<{ sourceId: PlayerId; turnNumber: number }>>
  b60Zhangliao?: Record<PlayerId, { qualifyingAcquired: number; awakened: boolean }>
  b60ZiquUsed?: Record<PlayerId, PlayerId[]>
  b60Youlong?: Record<PlayerId, { roundNumber: number; side: 'yang' | 'yin'; usedSides: Array<'yang' | 'yin'>; usedCardNames: string[] }>
}

function ownerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function optionalOwnerOf(state: SanguoshaState, playerId?: PlayerId | null) {
  return playerId ? ownerOf(state, playerId) : undefined
}

function cardRank(state: SanguoshaState, cardId: CardId): number {
  const card = state.cards[cardId]
  return card && !card.virtual ? card.rank : 0
}

function zuofenTokenOf(state: SanguoshaState, playerId?: PlayerId | null) {
  return playerId ? (state as Batch60State).b60ZuofenToken?.[playerId] : undefined
}

function clearZuofenToken(state: SanguoshaState, holderId: PlayerId, sourceId?: PlayerId): void {
  const data = state as Batch60State
  const token = data.b60ZuofenToken?.[holderId]
  if (!token || (sourceId && token.sourceId !== sourceId)) return
  const holder = ownerOf(state, holderId)
  if (holder) {
    delete holder.marks.zuofenLei
    delete holder.marks.zuofenFu
    delete holder.marks.zuofenSong
  }
  delete data.b60ZuofenToken![holderId]
}

function assignZuofenToken(state: SanguoshaState, holderId: PlayerId, sourceId: PlayerId, kind: 'lei' | 'fu' | 'song'): void {
  clearZuofenToken(state, holderId)
  const holder = ownerOf(state, holderId)
  if (!holder) return
  const key = kind === 'lei' ? 'zuofenLei' : kind === 'fu' ? 'zuofenFu' : 'zuofenSong'
  holder.marks[key] = 1
  ;((state as Batch60State).b60ZuofenToken ??= {})[holderId] = { kind, sourceId }
}

function gaoganState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch60State
  data.b60Gaogan ??= {}
  const current = data.b60Gaogan[ownerId]
  if (!current || current.turnNumber !== state.turnNumber) {
    return data.b60Gaogan[ownerId] = { turnNumber: state.turnNumber, playPhaseSerial: 0 }
  }
  return current
}

function wangjiState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch60State
  data.b60Wangji ??= {}
  return data.b60Wangji[ownerId] ??= { phaseRecipients: [], usedCards: 0, chargeMaximumThisTurn: 0 }
}

function chargeCap(state: SanguoshaState, playerId: PlayerId): number {
  const player = ownerOf(state, playerId)
  if (!player) return 0
  const ids = [player.characterId, player.deputyCharacterId].filter((id): id is string => Boolean(id))
  if (ids.includes('jie-wangji-b60')) return 2
  const maximums = ids.flatMap((id) => getCharacter(id)?.skills ?? [])
    .map((skill) => skill.description.match(/蓄力技[（(]\d+\/(\d+)[）)]/u)?.[1])
    .filter((value): value is string => Boolean(value)).map(Number)
  return maximums.length ? Math.max(...maximums) : 99
}

function gainCharge(state: SanguoshaState, playerId: PlayerId): void {
  const player = ownerOf(state, playerId)
  if (!player?.alive) return
  player.marks['蓄力点'] = Math.min(chargeCap(state, playerId), (player.marks['蓄力点'] ?? 0) + 1)
}

function updateWangjiChargeMaximum(host: SkillHost, ownerId: PlayerId): void {
  const charge = ownerOf(host.state, ownerId)?.marks['蓄力点'] ?? 0
  const entry = wangjiState(host.state, ownerId)
  entry.chargeMaximumThisTurn = Math.max(entry.chargeMaximumThisTurn, charge)
}

function isWangjiTrackedUse(state: SanguoshaState, cardId?: CardId, cardName?: string): boolean {
  if (!cardId || !cardName) return false
  const card = state.cards[cardId]
  return card?.category === 'basic' || (card?.category === 'trick' && INSTANT_TRICKS.has(cardName))
}

function askWangjiDiscard(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  const targetId = targetIds[index]
  if (!targetId) return
  const target = ownerOf(host.state, targetId)
  if (!target?.alive || !target.zones.hand.length) return askWangjiDiscard(host, ownerId, targetIds, index + 1)
  host.askSkill({ skillId: WANGJI_QIZHI, ownerId, step: 'discard-after-use', data: { targetIds, index, targetId }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId,
    prompt: `【奇制】：观看${target.nickname}的手牌并弃置其中一张`, timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
  }) })
}

registerSkillRuntime({ id: WANGJI_QIZHI,
  onGameStart(host, ownerId) {
    const owner = ownerOf(host.state, ownerId)
    if (owner) owner.marks['蓄力点'] = Math.min(2, Math.max(1, owner.marks['蓄力点'] ?? 1))
    const entry = wangjiState(host.state, ownerId)
    entry.chargeMaximumThisTurn = owner?.marks['蓄力点'] ?? 1
  },
  activeActions(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || (owner.marks['蓄力点'] ?? 0) < 1) return []
    const entry = wangjiState(state, ownerId)
    if (!state.players.some((player) => player.alive && !entry.phaseRecipients.includes(player.id))) return []
    return [{ id: WANGJI_QIZHI, label: '奇制：消耗蓄力点令角色摸牌' }]
  },
  invokeActive(host, ownerId) {
    const entry = wangjiState(host.state, ownerId)
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive || (owner.marks['蓄力点'] ?? 0) < 1) return
    const candidates = host.state.players.filter((player) => player.alive && !entry.phaseRecipients.includes(player.id)).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: WANGJI_QIZHI, ownerId, step: 'draw-target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【奇制】：消耗1点蓄力点，选择一名角色摸两张牌',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId === ownerId && event.phase === 'play') wangjiState(host.state, ownerId).phaseRecipients = []
      if (event.playerId !== ownerId || event.phase !== 'finish') return
      host.queueSkill({ skillId: WANGJI_JINQU, ownerId, step: 'end-draw', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; cardName?: string; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || !isWangjiTrackedUse(host.state, data.cardId, data.cardName)) return
      if ((data.targetIds?.length ?? 0) > 0) {
        const recipients = wangjiState(host.state, ownerId).phaseRecipients.filter((id) => ownerOf(host.state, id)?.alive)
        if (recipients.length) host.queueSkill({ skillId: WANGJI_QIZHI, ownerId, step: 'discard-after-use', data: { targetIds: recipients, index: 0 } })
      }
      const entry = wangjiState(host.state, ownerId)
      entry.usedCards += 1
      if (entry.usedCards % 2 === 0) host.queueSkill({ skillId: WANGJI_JINQU, ownerId, step: 'gain-charge', data: {} })
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      if ((context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
      const entry = wangjiState(host.state, ownerId)
      entry.usedCards = 0
      entry.chargeMaximumThisTurn = ownerOf(host.state, ownerId)?.marks['蓄力点'] ?? 0
    } },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const owner = ownerOf(host.state, ownerId)
      const target = optionalOwnerOf(host.state, targetId)
      const entry = wangjiState(host.state, ownerId)
      if (!owner?.alive || (owner.marks['蓄力点'] ?? 0) < 1 || !target?.alive || entry.phaseRecipients.includes(target.id)) return
      owner.marks['蓄力点'] -= 1
      updateWangjiChargeMaximum(host, ownerId)
      entry.phaseRecipients.push(target.id)
      drawCards(host.state, host.rng, target.id, 2, (name, payload) => host.dispatch(name, payload))
      return
    }
    if (resolution.step === 'discard-after-use') {
      const data = resolution.data as { targetIds: PlayerId[]; index: number; targetId: PlayerId }
      const target = ownerOf(host.state, data.targetId)
      const chosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (target?.alive && chosen && target.zones.hand.includes(chosen)) {
        moveCard(host.state, chosen, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: target.id, cardIds: [chosen], reason: WANGJI_QIZHI }, { sourceId: ownerId, targetId: target.id, cardIds: [chosen] })
      }
      askWangjiDiscard(host, ownerId, data.targetIds, data.index + 1)
    }
  },
})

registerSkillRuntime({ id: WANGJI_JINQU,
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'gain-charge') {
      const candidates = host.state.players.filter((player) => player.alive).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: WANGJI_JINQU, ownerId, step: 'gain-target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【进趋】：选择一名角色获得1点蓄力点',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'end-draw' && ownerOf(host.state, ownerId)?.alive) {
      const count = wangjiState(host.state, ownerId).chargeMaximumThisTurn
      drawCards(host.state, host.rng, ownerId, count, (name, payload) => host.dispatch(name, payload))
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gain-target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId || !ownerOf(host.state, targetId)?.alive) return
    gainCharge(host.state, targetId)
    updateWangjiChargeMaximum(host, ownerId)
  },
})
/*
 * 将华雄【恃勇】按已经结算的伤害判断，不在 DamageInflicted 阶段提前触发：
 * 伤害被防止或被改为失去体力时，都不算“受到……造成的伤害”。
 */
registerSkillRuntime({ id: HUAYONG_SHIYONG, triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
  if (context.event.targetId !== ownerId) return
  const payload = context.event.payload as { finalAmount?: number; cardId?: CardId | null; cardName?: string | null }
  if ((payload.finalAmount ?? 0) <= 0 || !payload.cardId || payload.cardName !== '杀') return
  const card = host.state.cards[payload.cardId]
  const wineBoosted = (host.state.wineBoostedSlashCardIds ?? []).includes(payload.cardId)
  if (!card || (effectiveCardColor(host.state, ownerId, payload.cardId) !== 'red' && !wineBoosted)) return
  loseMaxHp(host, ownerId, 1, HUAYONG_SHIYONG)
} }],
})

registerSkillRuntime({ id: GAOGAN_JUGUAN,
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId === ownerId && payload.phase === 'play') gaoganState(host.state, ownerId).playPhaseSerial += 1
    } },
    { event: 'DamageSettled', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId | null; finalAmount?: number }
      const records = (host.state as Batch60State).b60GaoganDamage?.[ownerId]
      if (!records?.length || !data.finalAmount || data.finalAmount <= 0) return
      if (context.event.sourceId === ownerId && data.cardId && context.event.targetId) {
        const record = records.find((candidate) => candidate.cardId === data.cardId)
        if (record && !record.hitTargetIds.includes(context.event.targetId)) record.hitTargetIds.push(context.event.targetId)
      }
      if (context.event.targetId === ownerId && context.event.sourceId) {
        for (const record of records) if (record.hitTargetIds.includes(context.event.sourceId)) record.hitOwner = true
      }
    } },
    { event: 'TurnStart', handle(host, ownerId, context) {
      const turnPlayerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (turnPlayerId !== ownerId) return
      const data = host.state as Batch60State
      const pending = data.b60GaoganDamage?.[ownerId]
      if (!pending?.length || host.state.turnNumber <= Math.max(...pending.map((record) => record.turnNumber))) return
      // The deadline is the start of Gao Gan's next turn, not the end of the
      // marked target's turn. A target that dealt any damage to him in time cancels it.
      const bonus = pending.some((record) => record.hitTargetIds.length > 0 && !record.hitOwner)
      if (bonus) ((data.b60GaoganDrawBonus ??= {})[ownerId] = true)
      delete data.b60GaoganDamage![ownerId]
    } },
    { event: 'DrawPhase', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const data = host.state as Batch60State
      if (data.b60GaoganDrawBonus?.[ownerId]) {
        const payload = context.event.payload as { count?: number }
        payload.count = (payload.count ?? 2) + 2
        delete data.b60GaoganDrawBonus![ownerId]
      }
    } },
  ],
  viewAs(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    const progress = gaoganState(state, ownerId)
    if (!owner?.alive || state.currentPlayerId !== ownerId || state.phase !== 'play'
      || progress.usedPhaseSerial === progress.playPhaseSerial) return []
    return owner.zones.hand.flatMap((cardId) => [
      { asCardName: '杀', cardId, label: '拒关：手牌当【杀】' },
      { asCardName: '决斗', cardId, label: '拒关：手牌当【决斗】' },
    ])
  },
  interceptPlayAction(host, ownerId, action) {
    if (action.sourceSkillId !== GAOGAN_JUGUAN || (action.asCardName !== '杀' && action.asCardName !== '决斗')) return false
    const owner = ownerOf(host.state, ownerId)
    const progress = gaoganState(host.state, ownerId)
    if (!owner?.alive || ownerId !== action.playerId || !owner.zones.hand.includes(action.cardIds[0])
      || progress.usedPhaseSerial === progress.playPhaseSerial) return false
    progress.usedPhaseSerial = progress.playPhaseSerial
    const data = host.state as Batch60State
    data.b60GaoganDamage ??= {}
    data.b60GaoganDamage[ownerId] ??= []
    data.b60GaoganDamage[ownerId].push({
      turnNumber: host.state.turnNumber, cardId: action.cardIds[0], hitTargetIds: [], hitOwner: false,
    })
    return false
  },
})

function hasUniqueMostCards(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = ownerOf(state, ownerId)
  if (!owner) return false
  const handCount = owner.zones.hand.length
  return state.players.every((player) => !player.alive || player.id === ownerId || player.zones.hand.length < handCount)
}

function startZhangheRotation(host: SkillHost, ownerId: PlayerId, prompt: { step: string; data: Record<string, unknown> }) {
  if (prompt.step === 'store') {
    const owner = ownerOf(host.state, ownerId)
    if (!owner) return
    const maximum = Math.min(5, owner.zones.hand.length)
    host.askSkill({ skillId: ZHANGHE_ZHOUXUAN, ownerId, step: 'store-cards', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【周旋】：选择至多五张手牌暗置为“旋”',
      timeoutMs: 25_000, optional: true, cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: maximum, purpose: 'skill',
    }) })
    return
  }
  if (prompt.step === 'consume') {
    const cards = privateZoneCards(host.state, ZHANGHE_PILE(ownerId))
    if (!cards.length) return
    host.askSkill({ skillId: ZHANGHE_ZHOUXUAN, ownerId, step: 'consume-card', data: prompt.data, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: ownerId, prompt: '【周旋】：移去一张“旋”并摸牌',
      timeoutMs: 25_000, optional: false, cardIds: cards, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
    }) })
  }
}

registerSkillRuntime({ id: ZHANGHE_ZHOUXUAN,
  onGameStart(host, ownerId) {
    openPrivateZone(host.state, ZHANGHE_PILE(ownerId), ownerId, 'SP张郃“旋”')
  },
  triggers: [
    { event: 'PhaseStart', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (event.playerId !== ownerId || event.phase !== 'discard') return
      if (privateZoneCards(host.state, ZHANGHE_PILE(ownerId)).length) return
      host.queueSkill({ skillId: ZHANGHE_ZHOUXUAN, ownerId, step: 'store', data: {} })
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || !privateZoneCards(host.state, ZHANGHE_PILE(ownerId)).length) return
      host.queueSkill({ skillId: ZHANGHE_ZHOUXUAN, ownerId, step: 'consume', data: {} })
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const entry = (host.state as Batch60State).b60Zhanghe?.[ownerId]
      if (event.playerId !== ownerId || event.phase !== 'play' || !entry || host.state.turnNumber <= entry.storedAtTurn) return
      closePrivateZone(host.state, ZHANGHE_PILE(ownerId))
      delete (host.state as Batch60State).b60Zhanghe![ownerId]
    } },
    { event: 'Death', handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      closePrivateZone(host.state, ZHANGHE_PILE(ownerId))
      delete (host.state as Batch60State).b60Zhanghe?.[ownerId]
    } },
  ],
  startQueued: startZhangheRotation,
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'store-cards') {
      const owner = ownerOf(host.state, ownerId)
      if (!owner) return
      const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => owner.zones.hand.includes(id)).slice(0, 5)
      for (const id of ids) moveIntoPrivateZone(host.state, id, { kind: 'hand', playerId: ownerId }, ZHANGHE_PILE(ownerId))
      if (ids.length) ((host.state as Batch60State).b60Zhanghe ??= {})[ownerId] = { storedAtTurn: host.state.turnNumber }
      return
    }
    if (resolution.step !== 'consume-card') return
    const zoneId = ZHANGHE_PILE(ownerId)
    const cards = privateZoneCards(host.state, zoneId)
    const chosen = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const removed = chosen && cards.includes(chosen) ? chosen : cards[0]
    if (!removed) return
    moveOutOfPrivateZone(host.state, removed, zoneId, { kind: 'discardPile' })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
    const remaining = privateZoneCards(host.state, zoneId).length
    if (remaining && !hasUniqueMostCards(host.state, ownerId)) {
      drawCards(host.state, host.rng, ownerId, remaining, (name, payload) => host.dispatch(name, payload))
    }
  },
})

registerSkillRuntime({ id: ZUOFEN_LISI,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId === ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (!cardId) return
      (((host.state as Batch60State).b60ZuofenOutsideUses ??= {})[ownerId] ??= {})[cardId] = host.state.turnNumber
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (context.event.sourceId !== ownerId || !cardId || host.state.zones.discardPile.includes(cardId)) return
      delete (host.state as Batch60State).b60ZuofenOutsideUses?.[ownerId]?.[cardId]
    } },
    { event: 'CardEnteredDiscardByMove', handle(host, ownerId, context) {
      const data = context.event.payload as { cardId?: CardId; fromPlayerId?: PlayerId | null; reason?: string }
      if (!data.cardId || data.fromPlayerId !== ownerId) return
      const uses = (host.state as Batch60State).b60ZuofenOutsideUses?.[ownerId]
      const usedAtTurn = uses?.[data.cardId]
      if (usedAtTurn === undefined) return
      delete uses![data.cardId]
      if (usedAtTurn !== host.state.turnNumber || !host.state.players.some((player) => player.id === ownerId && player.alive)) return
      const owner = ownerOf(host.state, ownerId)
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
        && player.zones.hand.length <= (owner?.zones.hand.length ?? -1))
      if (!candidates.length) return
      host.queueSkill({ skillId: ZUOFEN_LISI, ownerId, step: 'recipient', data: { cardId: data.cardId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'recipient') return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId
      && player.zones.hand.length <= (ownerOf(host.state, ownerId)?.zones.hand.length ?? -1))
    if (!candidates.length) return
    host.askSkill({ skillId: ZUOFEN_LISI, ownerId, step: 'recipient', data: prompt.data, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【离思】：令一名手牌数不大于你的其他角色获得此牌',
      timeoutMs: 25_000, optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'recipient') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const cardId = (resolution.data as { cardId?: CardId }).cardId
    const owner = ownerOf(host.state, ownerId)
    const target = optionalOwnerOf(host.state, targetId)
    if (!cardId || !owner?.alive || !target?.alive || target.id === ownerId
      || target.zones.hand.length > owner.zones.hand.length
      || !host.state.zones.discardPile.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: target.id })
    host.dispatch('GainCard', { playerId: target.id, cardIds: [cardId], reason: ZUOFEN_LISI }, { targetId: target.id, cardIds: [cardId] })
  },
})

registerSkillRuntime({ id: ZUOFEN_ZHAOSONG,
  triggers: [
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const targetId = event.playerId
      if (event.phase !== 'draw' || !targetId || targetId === ownerId || (host.state as Batch60State).b60ZuofenToken?.[targetId]) return
      const owner = ownerOf(host.state, ownerId)
      const target = ownerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive || !target.zones.hand.length) return
      host.queueSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'offer', data: { targetId } })
    } },
    { event: 'EnterDying', allowDeadOwner: true, handle(host, ownerId, context) {
      const targetId = context.event.targetId
      const token = zuofenTokenOf(host.state, targetId)
      if (!targetId || token?.sourceId !== ownerId || token.kind !== 'lei') return
      host.queueSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'lei', data: { targetId } })
    } },
    { event: 'PhaseStart', allowDeadOwner: true, handle(host, ownerId, context) {
      const event = context.event.payload as { playerId?: PlayerId; phase?: string }
      const token = zuofenTokenOf(host.state, event.playerId)
      if (event.phase !== 'play' || token?.sourceId !== ownerId || token.kind !== 'fu') return
      host.queueSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'fu', data: { holderId: event.playerId } })
    } },
    { event: 'AfterCardUse', allowDeadOwner: true, handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const event = context.event.payload as { cardName?: string }
      if (!sourceId || event.cardName !== '杀') return
      const token = (host.state as Batch60State).b60ZuofenToken?.[sourceId]
      if (token?.sourceId === ownerId && token.kind === 'song' && !(ownerOf(host.state, sourceId)?.marks.zuofenSong)) {
        delete (host.state as Batch60State).b60ZuofenToken![sourceId]
      }
    } },
    { event: 'Death', allowDeadOwner: true, handle(host, _ownerId, context) {
      const deadId = context.event.targetId
      if (deadId) clearZuofenToken(host.state, deadId)
    } },
  ],
  startQueued(host, ownerId, prompt) {
    const data = prompt.data as { targetId?: PlayerId; holderId?: PlayerId }
    if (prompt.step === 'offer') {
      const targetId = data.targetId
      const target = optionalOwnerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.length || (host.state as Batch60State).b60ZuofenToken?.[target.id]) return
      host.askSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'offer-choice', data: { targetId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【诏颂】：是否令${target.nickname}正面朝上交给你一张手牌？`,
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'lei' || prompt.step === 'fu') {
      const holderId = prompt.step === 'lei' ? data.targetId : data.holderId
      const holder = optionalOwnerOf(host.state, holderId)
      const token = zuofenTokenOf(host.state, holderId)
      if (!holder?.alive || token?.sourceId !== ownerId || token.kind !== prompt.step) return
      host.askSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: `${prompt.step}-use`, data: { holderId }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: holder.id,
        prompt: prompt.step === 'lei' ? '【诔】：是否移除此标记，回复至1点体力并摸一张牌？' : '【赋】：是否移除此标记，弃置一名角色区域内至多两张牌？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { targetId?: PlayerId; holderId?: PlayerId }
    if (resolution.step === 'offer-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const targetId = data.targetId
      const target = optionalOwnerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.length || (host.state as Batch60State).b60ZuofenToken?.[target.id]) return
      host.askSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'give', data: { targetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: target.id, prompt: '【诏颂】：正面朝上选择一张手牌交给左棻',
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give') {
      const targetId = data.targetId
      const target = optionalOwnerOf(host.state, targetId)
      const owner = ownerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!target?.alive || !owner?.alive || !cardId || !target.zones.hand.includes(cardId)
        || (host.state as Batch60State).b60ZuofenToken?.[target.id]) return
      const card = host.state.cards[cardId]
      const kind = card?.category === 'trick' ? 'lei' : card?.category === 'equipment' ? 'fu' : card?.category === 'basic' ? 'song' : null
      if (!kind) return
      host.dispatch('CardMove', { playerId: target.id, cardIds: [cardId], reason: ZUOFEN_ZHAOSONG, revealed: true, keepOwner: true }, { targetId: target.id, cardIds: [cardId] })
      moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: ZUOFEN_ZHAOSONG }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZUOFEN_ZHAOSONG }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('CardGiven', { fromId: target.id, toId: ownerId, cardIds: [cardId], reason: ZUOFEN_ZHAOSONG }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      assignZuofenToken(host.state, target.id, ownerId, kind)
      return
    }
    if (resolution.step === 'lei-use') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const holderId = data.holderId
      const holder = optionalOwnerOf(host.state, holderId)
      const token = zuofenTokenOf(host.state, holderId)
      if (!holder?.alive || token?.sourceId !== ownerId || token.kind !== 'lei') return
      clearZuofenToken(host.state, holder.id, ownerId)
      if (holder.hp <= 0) recover(host as never, holder.id, Math.max(1, 1 - holder.hp), ownerId)
      drawCards(host.state, host.rng, holder.id, 1, (name, payload) => host.dispatch(name, payload))
      if (host.state.dying?.playerId === holder.id && holder.hp > 0) host.resumeAfterDying()
      return
    }
    if (resolution.step === 'fu-use') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const holderId = data.holderId
      const holder = optionalOwnerOf(host.state, holderId)
      const token = zuofenTokenOf(host.state, holderId)
      if (!holder?.alive || token?.sourceId !== ownerId || token.kind !== 'fu') return
      const candidates = host.state.players.filter((player) => player.alive
        && pickableCardsOf(host.state, player.id, { includeJudgingArea: true, discarderId: holder.id }).cardIds.length
          + pickableCardsOf(host.state, player.id, { includeJudgingArea: true, discarderId: holder.id }).hiddenCardSlots.length > 0)
        .map((player) => player.id)
      if (!candidates.length) return
      clearZuofenToken(host.state, holder.id, ownerId)
      host.askSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'fu-target', data: { holderId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: holder.id, prompt: '【赋】：选择一名角色弃置其区域内至多两张牌',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'fu-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = optionalOwnerOf(host.state, targetId)
      const holder = optionalOwnerOf(host.state, data.holderId)
      if (!target?.alive || !holder?.alive) return
      const pickable = pickableCardsOf(host.state, target.id, { includeJudgingArea: true, discarderId: holder.id })
      const available = pickable.cardIds.length + pickable.hiddenCardSlots.length
      if (!available) return
      host.askSkill({ skillId: ZUOFEN_ZHAOSONG, ownerId, step: 'fu-cards', data: { holderId: holder.id, targetId: target.id }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: holder.id, prompt: '【赋】：选择弃置其中至多两张牌',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 0, max: Math.min(2, available),
      }) })
      return
    }
    if (resolution.step === 'fu-cards') {
      const targetId = data.targetId
      const holderId = data.holderId
      const target = optionalOwnerOf(host.state, targetId)
      const holder = optionalOwnerOf(host.state, holderId)
      if (!target?.alive || !holder?.alive) return
      const selected = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
      selected.sort((left, right) => {
        const leftIndex = left.startsWith(`hidden:${target.id}:`) ? Number(left.slice(left.lastIndexOf(':') + 1)) : -1
        const rightIndex = right.startsWith(`hidden:${target.id}:`) ? Number(right.slice(right.lastIndexOf(':') + 1)) : -1
        return rightIndex - leftIndex
      })
      for (const selectedId of selected.slice(0, 2)) {
        const cardId = resolvePickedCard(host.state, target.id, selectedId)
        if (!cardId || !movePickedCard(host as never, target.id, cardId, { kind: 'discardPile' })) continue
        host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: ZUOFEN_ZHAOSONG }, { sourceId: holder.id, targetId: target.id, cardIds: [cardId] })
      }
    }
  },
})

function zhangliaoData(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch60State
  data.b60Zhangliao ??= {}
  return data.b60Zhangliao[ownerId] ??= { qualifyingAcquired: 0, awakened: false }
}

function pointValue(state: SanguoshaState, cardId: CardId): number {
  const card = state.cards[cardId]
  return card && !card.virtual ? card.rank : 0
}

function mubingQualifying(state: SanguoshaState, cardId: CardId): boolean {
  const card = state.cards[cardId]
  return card?.name === '杀' || (card?.category === 'trick' && DAMAGE_TRICKS.has(effectiveCardName(state, cardId)))
    || (card?.category === 'equipment' && card.equipmentSlot === 'weapon')
}

function qigongSlashCards(state: SanguoshaState, playerId: PlayerId, targetId: PlayerId): CardId[] {
  const player = ownerOf(state, playerId)
  if (!player?.alive || !ownerOf(state, targetId)?.alive || playerId === targetId
    || isCardUseProhibited(state, playerId, '杀', { dyingPlayerId: state.dying?.playerId ?? null })) return []
  const converted = new Set(responseViewAsOptions(state, playerId, '杀').map((option) => option.cardId))
  return player.zones.hand.filter((cardId) => (
    effectiveCardName(state, cardId) === '杀' || converted.has(cardId)
  ) && !isTargetProhibited(state, playerId, targetId, '杀', skillIdsOf, cardId, LVKUANG_QIGONG))
}

registerSkillRuntime({ id: LVKUANG_QIGONG,
  triggers: [{ event: 'CardResponded', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string; slashCardId?: CardId }
    if (payload.cardName !== '闪' || !payload.slashCardId) return
    const use = cardUseTargetsOf(host.state, payload.slashCardId)
    if (use?.sourceId !== ownerId || use.targetIds.length !== 1) return
    host.queueSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'offer', data: { slashCardId: payload.slashCardId, targetId: use.targetIds[0] } })
  } }],
  startQueued(host, ownerId, prompt) {
    const data = prompt.data as { slashCardId?: CardId; targetId?: PlayerId; actorId?: PlayerId }
    if (!data.slashCardId || !data.targetId) return
    if (prompt.step === 'offer') {
      host.askSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'offer-choice', data, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: '【齐攻】：是否令一名角色对原目标无距离限制使用不可响应的【杀】？',
        timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }) })
      return
    }
    if (prompt.step === 'actor') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== data.targetId
        && qigongSlashCards(host.state, player.id, data.targetId!).length > 0).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'actor-choice', data, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【齐攻】：选择一名对原目标使用【杀】的角色', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (prompt.step === 'use') {
      const actorId = data.actorId
      const cards = actorId ? qigongSlashCards(host.state, actorId, data.targetId) : []
      if (!actorId || !cards.length) return
      host.askSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'slash-card', data, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: actorId, prompt: '【齐攻】：选择实际使用为【杀】的一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { slashCardId: CardId; targetId: PlayerId; actorId?: PlayerId }
    if (resolution.step === 'offer-choice') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      host.queueSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'actor', data })
      return
    }
    if (resolution.step === 'actor-choice') {
      const actorId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (actorId && qigongSlashCards(host.state, actorId, data.targetId).length) {
        host.queueSkill({ skillId: LVKUANG_QIGONG, ownerId, step: 'use', data: { ...data, actorId } })
      }
      return
    }
    if (resolution.step !== 'slash-card') return
    const actorId = data.actorId
    const target = ownerOf(host.state, data.targetId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!actorId || !target?.alive || !cardId || !qigongSlashCards(host.state, actorId, target.id).includes(cardId)) return
    if (effectiveCardName(host.state, cardId) !== '杀') setCardAlias(host.state, cardId, '杀')
    host.beginVirtualSlash({ sourceId: actorId, targetId: target.id, sourceSkillId: LVKUANG_QIGONG,
      cardId, ignoreDistance: true, noDodgeTargetIds: [target.id] })
  },
})

function lvkuangInRange(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  return ownerId !== targetId && getDistance(state, ownerId, targetId) <= getAttackRange(state, ownerId)
}

registerSkillRuntime({ id: LVKUANG_LIEHOU,
  activeActions(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, LVKUANG_LIEHOU)) return []
    const inRange = state.players.filter((player) => player.alive && lvkuangInRange(state, ownerId, player.id))
    return inRange.some((player) => player.zones.hand.length > 0) && inRange.length >= 2
      ? [{ id: LVKUANG_LIEHOU, label: '列侯：令范围内角色交牌，再将牌交给另一角色' }] : []
  },
  invokeActive(host, ownerId) {
    const candidates = host.state.players.filter((player) => player.alive && player.zones.hand.length > 0 && lvkuangInRange(host.state, ownerId, player.id)).map((player) => player.id)
    if (!candidates.length || usedThisPhase(host.state, ownerId, LVKUANG_LIEHOU)) return
    markUsedThisPhase(host.state, ownerId, LVKUANG_LIEHOU)
    host.askSkill({ skillId: LVKUANG_LIEHOU, ownerId, step: 'giver', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【列侯】：选择一名攻击范围内有手牌的角色交给你一张手牌',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { firstTargetId?: PlayerId }
    if (resolution.step === 'giver') {
      const firstTargetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const firstTarget = optionalOwnerOf(host.state, firstTargetId)
      if (!firstTarget?.alive || !firstTarget.zones.hand.length || !lvkuangInRange(host.state, ownerId, firstTarget.id)) return
      host.askSkill({ skillId: LVKUANG_LIEHOU, ownerId, step: 'take-card', data: { firstTargetId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: firstTarget.id, prompt: '【列侯】：交给吕旷吕翔一张手牌', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: [...firstTarget.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'take-card') {
      const firstTarget = optionalOwnerOf(host.state, data.firstTargetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!firstTarget?.alive || !cardId || !firstTarget.zones.hand.includes(cardId) || !lvkuangInRange(host.state, ownerId, firstTarget.id)) return
      if (!giveCards(host as never, firstTarget.id, ownerId, [cardId], LVKUANG_LIEHOU).length) return
      const candidates = host.state.players.filter((player) => player.alive && player.id !== firstTarget.id && lvkuangInRange(host.state, ownerId, player.id)).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: LVKUANG_LIEHOU, ownerId, step: 'recipient', data: { firstTargetId: data.firstTargetId }, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【列侯】：选择攻击范围内另一名其他角色接收一张手牌',
        timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'recipient') {
      const recipientId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const recipient = optionalOwnerOf(host.state, recipientId)
      const owner = ownerOf(host.state, ownerId)
      if (!recipient?.alive || !owner?.zones.hand.length || recipient.id === data.firstTargetId || !lvkuangInRange(host.state, ownerId, recipient.id)) return
      host.askSkill({ skillId: LVKUANG_LIEHOU, ownerId, step: 'give-card', data: { recipientId }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: `【列侯】：选择一张手牌交给${recipient.nickname}`,
        timeoutMs: 25_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'give-card') {
      const recipientId = (resolution.data as { recipientId?: PlayerId }).recipientId
      const recipient = optionalOwnerOf(host.state, recipientId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (recipient?.alive && cardId && ownerOf(host.state, ownerId)?.zones.hand.includes(cardId)) giveCards(host as never, ownerId, recipient.id, [cardId], LVKUANG_LIEHOU)
    }
  },
})

registerSkillRuntime({ id: ZHANGLIAO_MUBING,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'share-next') return
    const [cardId, ...remaining] = ((prompt.data as { remaining?: CardId[] }).remaining ?? [])
    const owner = ownerOf(host.state, ownerId)
    if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)
      || !host.state.players.some((p) => p.alive && p.id !== ownerId)) return
    host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share', data: { cardId, remaining }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【调令】：是否将【${host.state.cards[cardId]?.name}】交给其他角色？`, timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '交给其他角色' }, { id: 'no', label: '留在手牌' }],
    }) })
  },
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const event = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (event.playerId !== ownerId || event.phase !== 'play') return
    host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'invoke', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【募兵】：是否亮出牌堆顶的牌并交换？', timeoutMs: 25_000,
      optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  } }],
  resume(host, ownerId, resolution, response) {
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const revealed = revealTopCards(host.state, host.rng, zhangliaoData(host.state, ownerId).awakened ? 4 : 3, ZHANGLIAO_MUBING, (name, payload) => host.dispatch(name, payload))
      const hand = owner.zones.hand.filter((id) => !isCardProtectedFromDiscard(host.state, ownerId, id))
      host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'pay', data: { revealed }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【募兵】：弃置任意张手牌，其点数之和作为获得牌的上限',
        timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: hand, hiddenCardSlots: [], min: 0, max: hand.length,
      }) })
      return
    }
    if (resolution.step === 'pay') {
      const revealed = (resolution.data as { revealed?: CardId[] }).revealed ?? []
      const paid = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => owner.zones.hand.includes(id) && !isCardProtectedFromDiscard(host.state, ownerId, id))
      const sum = paid.reduce((n, id) => n + pointValue(host.state, id), 0)
      for (const id of paid) { moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }); host.dispatch('LoseCard', { playerId: ownerId, cardIds: [id], reason: ZHANGLIAO_MUBING }, { sourceId: ownerId, targetId: ownerId, cardIds: [id] }) }
      const subsets: CardId[][] = [[]]
      for (const id of revealed.filter((cardId) => host.state.zones.processingArea.includes(cardId))) for (const prior of [...subsets]) {
        const next = [...prior, id]
        if (next.reduce((n, cardId) => n + pointValue(host.state, cardId), 0) <= sum) subsets.push(next)
      }
      host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'gain', data: { revealed, subsets }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【募兵】：选择点数之和不大于${sum}的亮出牌`, timeoutMs: 25_000, optional: false,
        options: subsets.map((set, i) => ({ id: `set:${i}`, label: set.length ? set.map((cardId) => `${host.state.cards[cardId]?.name}(${pointValue(host.state, cardId)})`).join('、') : '不获得牌' })),
      }) })
      return
    }
    if (resolution.step === 'gain') {
      const data = resolution.data as { revealed: CardId[]; subsets: CardId[][] }
      const index = Number((response.payload as { optionId?: string }).optionId?.split(':')[1])
      const gained = new Set(data.subsets[index] ?? [])
      const acquired: CardId[] = []
      for (const id of data.revealed) if (host.state.zones.processingArea.includes(id)) {
        if (gained.has(id)) {
          moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [id], reason: ZHANGLIAO_MUBING }, { sourceId: ownerId, targetId: ownerId, cardIds: [id] })
          acquired.push(id)
          if (mubingQualifying(host.state, id)) zhangliaoData(host.state, ownerId).qualifyingAcquired++
        } else moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'discardPile' })
      }
      if (zhangliaoData(host.state, ownerId).awakened) {
        const shareNext = (ids: CardId[]) => {
          const [cardId, ...remaining] = ids
          if (!cardId || !owner.zones.hand.includes(cardId) || !host.state.players.some((p) => p.alive && p.id !== ownerId)) return
          host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share', data: { cardId, remaining }, build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【调令】：是否将【${host.state.cards[cardId]?.name}】交给其他角色？`, timeoutMs: 25_000, optional: true,
            options: [{ id: 'yes', label: '交给其他角色' }, { id: 'no', label: '留在手牌' }],
          }) })
        }
        if (acquired.length) shareNext(acquired)
      }
      return
    }
    if (resolution.step === 'share') {
      const data = resolution.data as { cardId: CardId; remaining: CardId[] }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { host.queueSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share-next', data: { remaining: data.remaining } }); return }
      const candidateIds = host.state.players.filter((p) => p.alive && p.id !== ownerId).map((p) => p.id)
      host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share-target', data, build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId, prompt: '【调令】：选择获得此牌的角色', timeoutMs: 25_000, optional: false, candidateIds, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'share-target') {
      const data = resolution.data as { cardId: CardId; remaining: CardId[] }
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = optionalOwnerOf(host.state, targetId)
      if (target?.alive && owner.zones.hand.includes(data.cardId)) {
        moveCard(host.state, data.cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [data.cardId], reason: ZHANGLIAO_MUBING }, { sourceId: ownerId, targetId: target.id, cardIds: [data.cardId] })
        host.dispatch('GainCard', { playerId: target.id, cardIds: [data.cardId], reason: ZHANGLIAO_MUBING }, { sourceId: ownerId, targetId: target.id, cardIds: [data.cardId] })
        host.dispatch('CardGiven', { fromId: ownerId, toId: target.id, cardIds: [data.cardId], reason: ZHANGLIAO_MUBING }, { sourceId: ownerId, targetId: target.id, cardIds: [data.cardId] })
      }
      host.queueSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share-next', data: { remaining: data.remaining } })
    }
    if (resolution.step === 'share-next') {
      const [cardId, ...remaining] = ((resolution.data as { remaining?: CardId[] }).remaining ?? [])
      if (cardId && owner.zones.hand.includes(cardId)) {
        const queue = [cardId, ...remaining]
        host.askSkill({ skillId: ZHANGLIAO_MUBING, ownerId, step: 'share', data: { cardId: queue[0], remaining: queue.slice(1) }, build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId, prompt: `【调令】：是否将【${host.state.cards[queue[0]]?.name}】交给其他角色？`, timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '交给其他角色' }, { id: 'no', label: '留在手牌' }] }) })
      }
    }
  },
})

registerSkillRuntime({ id: ZHANGLIAO_TIAOLING, awakening: {
  phase: 'prepare',
  ready(state, ownerId) { return Boolean(ownerOf(state, ownerId)?.alive && !zhangliaoData(state, ownerId).awakened && zhangliaoData(state, ownerId).qualifyingAcquired >= 6) },
  invoke(host, ownerId) {
    zhangliaoData(host.state, ownerId).awakened = true
    host.askSkill({ skillId: ZHANGLIAO_TIAOLING, ownerId, step: 'awakening-choice', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【调令】：选择回复1点体力或摸两张牌', timeoutMs: 25_000, optional: false,
      options: [{ id: 'recover', label: '回复1点体力' }, { id: 'draw', label: '摸两张牌' }],
    }) })
  },
}, resume(host, ownerId, resolution, response) {
  if (resolution.step !== 'awakening-choice') return
  if ((response.payload as { optionId?: string }).optionId === 'recover') recover(host as never, ownerId, 1, ownerId)
  else drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
} })

registerSkillRuntime({ id: ZHANGLIAO_ZIQU,
  offersSourceDamagePreventionAsk(host, ownerId, context) {
    const targetId = context.targetId
    const target = targetId ? ownerOf(host.state, targetId) : undefined
    const pickable = targetId ? pickableCardsOf(host.state, targetId, { includeJudgingArea: true }) : null
    if (context.sourceId !== ownerId || !targetId || targetId === ownerId
      || (host.state as Batch60State).b60ZiquUsed?.[ownerId]?.includes(targetId)
      || !ownerOf(host.state, ownerId)?.alive || !target?.alive
      || !pickable || (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0)) return false
    host.queueSkill({ skillId: ZHANGLIAO_ZIQU, ownerId, step: 'ask', data: { targetId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = (prompt.data as { targetId?: PlayerId }).targetId
    const target = optionalOwnerOf(host.state, targetId)
    if (!targetId || !target?.alive || !host.state.pendingSourceDamage) { resumeSourceDamagePrevention(host as never, false); return }
    host.askSkill({ skillId: ZHANGLIAO_ZIQU, ownerId, step: 'choice', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【资取】：是否防止对${target.nickname}造成的伤害，并令其交给你点数最大的牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '防止并获得最大点数牌' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    if (!targetId) return
    if (resolution.step === 'give') {
      const target = ownerOf(host.state, targetId)
      const selectedId = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = selectedId && resolvePickedCard(host.state, targetId, selectedId)
      if (!target?.alive || !cardId) return
      const options = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
      const available = [...options.cardIds, ...options.hiddenCardSlots]
        .map((id) => ({ id, cardId: resolvePickedCard(host.state, targetId, id) }))
        .filter((entry): entry is { id: string; cardId: CardId } => Boolean(entry.cardId))
      const highest = Math.max(-1, ...available.map((entry) => cardRank(host.state, entry.cardId)))
      if (cardRank(host.state, cardId) !== highest) return
      if (movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHANGLIAO_ZIQU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('CardGiven', { fromId: targetId, toId: ownerId, cardIds: [cardId], reason: ZHANGLIAO_ZIQU }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      return
    }
    if (resolution.step !== 'choice') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') { resumeSourceDamagePrevention(host as never, false); return }
    ;(((host.state as Batch60State).b60ZiquUsed ??= {})[ownerId] ??= []).push(targetId)
    resumeSourceDamagePrevention(host as never, true, ZHANGLIAO_ZIQU)
    const target = ownerOf(host.state, targetId)
    if (!target?.alive) return
    const choices = pickableCardsOf(host.state, targetId, { includeJudgingArea: true })
    const ranked = [...choices.cardIds, ...choices.hiddenCardSlots].map((id) => ({ id, cardId: resolvePickedCard(host.state, targetId, id) }))
      .filter((entry): entry is { id: string; cardId: CardId } => Boolean(entry.cardId))
    if (!ranked.length) return
    const highest = Math.max(...ranked.map((entry) => cardRank(host.state, entry.cardId)))
    const maxIds = ranked.filter((entry) => cardRank(host.state, entry.cardId) === highest).map((entry) => entry.id)
    host.askSkill({ skillId: ZHANGLIAO_ZIQU, ownerId, step: 'give', data: { targetId }, build: (id): ChooseCardsRequest => ({
      id, kind: 'choose-cards', playerId: target.id, prompt: '【资取】：交给SP张辽一张点数最大的牌', timeoutMs: 25_000,
      optional: false, purpose: 'skill', cardIds: maxIds.filter((value) => !value.startsWith('hidden:')),
      hiddenCardSlots: maxIds.filter((value) => value.startsWith('hidden:')), min: 1, max: 1,
    }) })
  },
})

function askGuanxuExchange(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, fromYashi: boolean): void {
  const target = ownerOf(host.state, targetId)
  const top = host.state.zones.drawPile.slice(0, 5)
  if (!target?.alive || target.id === ownerId || !target.zones.hand.length || !top.length) return
  host.askSkill({ skillId: fromYashi ? HUANGCHENGYAN_YASHI : HUANGCHENGYAN_GUANXU, ownerId, step: 'hand-card', data: { targetId, top, fromYashi }, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId: ownerId, prompt: `【观虚】：观看${target.nickname}的手牌，选择其中一张牌与牌堆顶五张牌中的一张交换`,
    timeoutMs: 25_000, optional: true, purpose: 'skill', cardIds: [...target.zones.hand], viewOnlyCardIds: top, hiddenCardSlots: [], min: 0, max: 1,
  }) })
}

function sameSuitTriples(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[][] {
  const target = ownerOf(state, targetId)
  if (!target) return []
  const cards = target.zones.hand.filter((id) => !isCardProtectedFromDiscard(state, ownerId, id))
  const groups = new Map<string, CardId[]>()
  for (const id of cards) {
    const suit = effectiveCardSuit(state, ownerId, id, skillIdsOf)
    if (!suit) continue
    const group = groups.get(suit) ?? []
    group.push(id)
    groups.set(suit, group)
  }
  const triples: CardId[][] = []
  for (const group of groups.values()) for (let a = 0; a < group.length - 2; a++)
    for (let b = a + 1; b < group.length - 1; b++) for (let c = b + 1; c < group.length; c++) triples.push([group[a], group[b], group[c]])
  return triples
}

type YoulongUse = { cardName: string; targetIds: PlayerId[]; label: string }

function youlongState(state: SanguoshaState, ownerId: PlayerId) {
  const data = state as Batch60State
  data.b60Youlong ??= {}
  let entry = data.b60Youlong[ownerId]
  if (!entry) {
    entry = { roundNumber: state.roundNumber, side: 'yang', usedSides: [], usedCardNames: [] }
    data.b60Youlong[ownerId] = entry
  }
  if (entry.roundNumber !== state.roundNumber) {
    entry.roundNumber = state.roundNumber
    entry.usedSides = []
    entry.usedCardNames = []
  }
  return entry
}

function youlongUses(state: SanguoshaState, ownerId: PlayerId): YoulongUse[] {
  const owner = ownerOf(state, ownerId)
  if (!owner?.alive) return []
  const entry = youlongState(state, ownerId)
  if (entry.usedSides.includes(entry.side)) return []
  const uses: YoulongUse[] = []
  const allowed = (name: string) => !entry.usedCardNames.includes(name)
    && !isCardUseProhibited(state, ownerId, name, { dyingPlayerId: state.dying?.playerId ?? null })
  if (entry.side === 'yin') {
    if (allowed('杀')) {
      for (const target of state.players) {
        if (!target.alive || target.id === ownerId || !canTarget(state, ownerId, target.id)
          || isTargetProhibited(state, ownerId, target.id, '杀', skillIdsOf, undefined, WOLONG_YOULONG)
          || !canUseSlashAtTargets(state, ownerId, false, [target.id])) continue
        uses.push({ cardName: '杀', targetIds: [target.id], label: `【杀】→${target.nickname}` })
      }
    }
    if (allowed('桃') && owner.hp < owner.maxHp) uses.push({ cardName: '桃', targetIds: [ownerId], label: '【桃】→自己' })
    if (allowed('酒') && wineUseAllowed(state, ownerId)) uses.push({ cardName: '酒', targetIds: [ownerId], label: '【酒】→自己' })
    return uses
  }

  for (const name of INSTANT_TRICKS) {
    if (!allowed(name)) continue
    const probeId = `virtual:${WOLONG_YOULONG}:probe:${ownerId}:${name}`
    state.cards[probeId] = {
      id: probeId, ruleset: state.rulesetVersion, expansion: 'standard', name,
      suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true, sourceSkillId: WOLONG_YOULONG,
    }
    const actions = instantTrickActions(state, ownerId, probeId, name)
    delete state.cards[probeId]
    for (const action of actions) {
      if (action.kind !== 'use-card' || action.id.startsWith('play:recast:')) continue
      uses.push({ cardName: name, targetIds: action.targetIds, label: action.label })
    }
  }
  return uses
}

registerSkillRuntime({ id: WOLONG_YOULONG,
  activeActions(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    if (!owner?.alive || state.phase !== 'play' || state.currentPlayerId !== ownerId
      || !equipmentSlotsOf(state, ownerId).length || !youlongUses(state, ownerId).length) return []
    return [{ id: WOLONG_YOULONG, label: `游龙（${youlongState(state, ownerId).side === 'yang' ? '阳·普通锦囊' : '阴·基本牌'}）：废除一个装备栏并使用牌` }]
  },
  invokeActive(host, ownerId) {
    const slots = equipmentSlotsOf(host.state, ownerId)
    if (!slots.length || !youlongUses(host.state, ownerId).length) return
    host.askSkill({ skillId: WOLONG_YOULONG, ownerId, step: 'slot', data: {}, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【游龙】：选择废除一个装备栏', timeoutMs: 25_000, optional: false,
      options: slots.map((slot) => ({ id: slot, label: ({ weapon: '武器栏', weapon2: '第二武器栏', armor: '防具栏', offensiveHorse: '-1坐骑栏', defensiveHorse: '+1坐骑栏', treasure: '宝物栏' } as Record<EquipmentSlot, string>)[slot] })),
    }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = ownerOf(host.state, ownerId)
    if (!owner?.alive) return
    const entry = youlongState(host.state, ownerId)
    if (resolution.step === 'slot') {
      const slot = (response.payload as { optionId?: string }).optionId as EquipmentSlot | undefined
      if (!slot || !equipmentSlotsOf(host.state, ownerId).includes(slot)) return
      const uses = youlongUses(host.state, ownerId)
      if (!uses.length) return
      host.askSkill({ skillId: WOLONG_YOULONG, ownerId, step: 'use', data: { slot, uses }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【游龙·${entry.side === 'yang' ? '阳' : '阴'}】：选择一张未以此法使用过的牌`,
        timeoutMs: 25_000, optional: false, options: uses.map((use, index) => ({ id: `use:${index}`, label: use.label })),
      }) })
      return
    }
    if (resolution.step !== 'use') return
    const data = resolution.data as { slot: EquipmentSlot; uses: YoulongUse[] }
    const index = Number((response.payload as { optionId?: string }).optionId?.slice('use:'.length))
    const selected = data.uses[index]
    const current = youlongUses(host.state, ownerId).find((use) => use.cardName === selected?.cardName
      && use.targetIds.length === selected.targetIds.length && use.targetIds.every((id, i) => id === selected.targetIds[i]))
    if (!selected || !current || !equipmentSlotsOf(host.state, ownerId).includes(data.slot)) return
    const side = entry.side
    const removedEquipment = owner.zones.equipment[data.slot]
    if (!abolishSlot(host.state, ownerId, data.slot)) return
    if (removedEquipment) {
      moveCard(host.state, removedEquipment, { kind: 'equipment', playerId: ownerId, slot: data.slot }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, ownerId, removedEquipment)
    }
    const began = current.cardName === '杀' || current.cardName === '桃' || current.cardName === '酒'
      ? host.beginVirtualBasic({ sourceId: ownerId, targetIds: current.targetIds, cardName: current.cardName, sourceSkillId: WOLONG_YOULONG })
      : host.beginVirtualTrick({ sourceId: ownerId, targetIds: current.targetIds, cardName: current.cardName, sourceSkillId: WOLONG_YOULONG })
    if (!began) return
    entry.usedSides.push(side)
    entry.usedCardNames.push(current.cardName)
    entry.side = side === 'yang' ? 'yin' : 'yang'
  },
})

registerSkillRuntime({ id: WOLONG_LUANFENG, limited: true,
  triggers: [{ event: 'EnterDying', handle(host, ownerId, context) {
    const targetId = context.event.targetId
    const owner = ownerOf(host.state, ownerId)
    const target = optionalOwnerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || target.maxHp < owner.maxHp
      || owner.usedLimitedSkills.includes(WOLONG_LUANFENG)) return
    host.queueSkill({ skillId: WOLONG_LUANFENG, ownerId, step: 'offer', data: { targetId } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const targetId = (prompt.data as { targetId?: PlayerId }).targetId
    const owner = ownerOf(host.state, ownerId)
    const target = optionalOwnerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || host.state.dying?.playerId !== target.id
      || target.maxHp < owner.maxHp || owner.usedLimitedSkills.includes(WOLONG_LUANFENG)) return
    host.askSkill({ skillId: WOLONG_LUANFENG, ownerId, step: 'rescue', data: { targetId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: `【鸾凤】：是否令${target.nickname}回复至3点体力、复原其装备栏并摸牌？`,
      timeoutMs: 25_000, optional: true, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'rescue' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = (resolution.data as { targetId?: PlayerId }).targetId
    const owner = ownerOf(host.state, ownerId)
    const target = optionalOwnerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || host.state.dying?.playerId !== target.id
      || target.maxHp < owner.maxHp || owner.usedLimitedSkills.includes(WOLONG_LUANFENG)) return
    owner.usedLimitedSkills.push(WOLONG_LUANFENG)
    recoverTo(host as never, target.id, 3, ownerId, WOLONG_LUANFENG)
    const abolished = abolishedSlotsOf(host.state, target.id)
    let restored = 0
    for (const slot of abolished) if (restoreSlot(host.state, target.id, slot)) restored += 1
    if (target.id === ownerId) {
      const state = youlongState(host.state, ownerId)
      state.usedCardNames = []
    }
    const desiredHand = Math.max(0, 6 - restored)
    drawCards(host.state, host.rng, target.id, Math.max(0, desiredHand - target.zones.hand.length), (name, payload) => host.dispatch(name, payload))
    if (host.state.dying?.playerId === target.id && target.hp > 0) host.resumeAfterDying()
  },
})

registerSkillRuntime({ id: HUANGCHENGYAN_GUANXU,
  activeActions(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    return owner?.alive && state.phase === 'play' && state.currentPlayerId === ownerId && !usedThisPhase(state, ownerId, HUANGCHENGYAN_GUANXU)
      && state.players.some((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0) && state.zones.drawPile.length > 0
      ? [{ id: HUANGCHENGYAN_GUANXU, label: '观虚：交换目标手牌与牌堆顶牌' }] : []
  },
  invokeActive(host, ownerId) {
    if (usedThisPhase(host.state, ownerId, HUANGCHENGYAN_GUANXU)) return
    markUsedThisPhase(host.state, ownerId, HUANGCHENGYAN_GUANXU)
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: HUANGCHENGYAN_GUANXU, ownerId, step: 'target', data: { fromYashi: false }, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【观虚】：选择一名其他角色观看其手牌', timeoutMs: 25_000,
      optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId) askGuanxuExchange(host, ownerId, targetId, Boolean((resolution.data as { fromYashi?: boolean }).fromYashi))
      return
    }
    if (resolution.step === 'hand-card') {
      const targetId = (resolution.data as { targetId: PlayerId; top: CardId[]; fromYashi?: boolean }).targetId
      const target = ownerOf(host.state, targetId)
      const handCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const topCards = (resolution.data as { top: CardId[] }).top.filter((id) => host.state.zones.drawPile.includes(id))
      if (!target?.alive || !handCardId || !target.zones.hand.includes(handCardId) || !topCards.length) return
      host.askSkill({ skillId: resolution.skillId, ownerId, step: 'top-card', data: { targetId, handCardId, topCards }, build: (id): ChooseCardsRequest => ({
        id, kind: 'choose-cards', playerId: ownerId, prompt: '【观虚】：选择一张牌堆顶五张牌与目标手牌交换', timeoutMs: 25_000,
        optional: false, purpose: 'skill', cardIds: topCards, hiddenCardSlots: [], min: 1, max: 1,
      }) })
      return
    }
    if (resolution.step === 'top-card') {
      const data = resolution.data as { targetId: PlayerId; handCardId: CardId; topCards: CardId[] }
      const target = ownerOf(host.state, data.targetId)
      const topCardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const topIndex = topCardId ? host.state.zones.drawPile.indexOf(topCardId) : -1
      if (!target?.alive || !target.zones.hand.includes(data.handCardId) || !topCardId || !data.topCards.includes(topCardId) || topIndex < 0) return
      moveCard(host.state, topCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
      moveCard(host.state, data.handCardId, { kind: 'hand', playerId: target.id }, { kind: 'drawPile' }, { toIndex: topIndex })
      host.dispatch('LoseCard', { playerId: target.id, cardIds: [data.handCardId], reason: HUANGCHENGYAN_GUANXU }, { sourceId: ownerId, targetId: target.id, cardIds: [data.handCardId] })
      host.dispatch('GainCard', { playerId: target.id, cardIds: [topCardId], reason: HUANGCHENGYAN_GUANXU }, { sourceId: ownerId, targetId: target.id, cardIds: [topCardId] })
      const triples = sameSuitTriples(host.state, ownerId, target.id)
      if (!triples.length) return
      host.askSkill({ skillId: resolution.skillId, ownerId, step: 'discard-same-suit', data: { targetId: target.id, triples }, build: (id): ChooseOptionRequest => ({
        id, kind: 'choose-option', playerId: ownerId, prompt: `【观虚】：选择弃置${target.nickname}手牌中三张花色相同的牌`, timeoutMs: 25_000,
        optional: false, options: triples.map((cards, index) => ({ id: `triple:${index}`, label: cards.map((cardId) => host.state.cards[cardId]?.name).join('、') })),
      }) })
      return
    }
    if (resolution.step === 'discard-same-suit') {
      const { targetId, triples } = resolution.data as { targetId: PlayerId; triples: CardId[][] }
      const target = ownerOf(host.state, targetId)
      const index = Number((response.payload as { optionId?: string }).optionId?.split(':')[1])
      const selected = triples[index] ?? []
      if (!target?.alive || selected.length !== 3 || selected.some((id) => !target.zones.hand.includes(id) || isCardProtectedFromDiscard(host.state, ownerId, id))) return
      for (const cardId of selected) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: HUANGCHENGYAN_GUANXU }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
    }
  },
})

registerSkillRuntime({ id: HUANGCHENGYAN_YASHI,
  triggers: [{ event: 'DamageSettled', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const payload = context.event.payload as { finalAmount?: number }
    if ((payload.finalAmount ?? 0) <= 0) return
    host.queueSkill({ skillId: HUANGCHENGYAN_YASHI, ownerId, step: 'choice', data: { sourceId: context.event.sourceId ?? null } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choice') return
    const sourceId = (prompt.data as { sourceId?: PlayerId | null }).sourceId
    const source = optionalOwnerOf(host.state, sourceId)
    const options = [
      ...(source?.alive ? [{ id: 'suppress', label: '令伤害来源的非锁定技失效至其下回合开始' }] : []),
      ...(host.state.players.some((player) => player.alive && player.id !== ownerId) ? [{ id: 'guanxu', label: '对一名其他角色执行【观虚】效果' }] : []),
      { id: 'decline', label: '不发动' },
    ]
    host.askSkill({ skillId: HUANGCHENGYAN_YASHI, ownerId, step: 'choice', data: { sourceId }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId, prompt: '【雅士】：选择一项', timeoutMs: 25_000, optional: true, options,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId) askGuanxuExchange(host, ownerId, targetId, true)
      return
    }
    const sourceId = (resolution.data as { sourceId?: PlayerId | null }).sourceId
    const choice = (response.payload as { optionId?: string }).optionId
    if (resolution.step !== 'choice' || choice === 'decline') return
    if (choice === 'suppress' && sourceId && ownerOf(host.state, sourceId)?.alive) {
      suppressSkill(host.state, { targetId: sourceId, scope: 'non-locked', sourceId: ownerId, sourceSkillId: HUANGCHENGYAN_YASHI, armedAtTurn: host.state.turnNumber, expiresAt: 'turn-start' })
      return
    }
    if (choice === 'guanxu') {
      const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0).map((player) => player.id)
      if (!candidates.length) return
      host.askSkill({ skillId: HUANGCHENGYAN_YASHI, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
        id, kind: 'choose-targets', playerId: ownerId, prompt: '【雅士】：选择一名其他角色执行【观虚】效果', timeoutMs: 25_000,
        optional: false, candidateIds: candidates, min: 1, max: 1,
      }) })
    }
  },
})

registerSkillRuntime({ id: FANJIANG_YUANCHOU,
  ignoresArmorFor(state, ownerId, targetId) {
    const resolution = state.cardResolution
    return resolution?.kind === 'slash' && resolution.sourceId === ownerId && resolution.targetId === targetId
      && effectiveCardColor(state, ownerId, resolution.cardId) === 'black'
  },
  armorIneffectiveWhenTargeted(state, ownerId, sourceId, cardName, color) {
    const resolution = state.cardResolution
    return cardName === '杀' && color === 'black' && resolution?.kind === 'slash'
      && resolution.targetId === ownerId && resolution.sourceId === sourceId
  },
})

registerSkillRuntime({ id: FANJIANG_JUESHENG, limited: true,
  activeActions(state, ownerId) {
    const owner = ownerOf(state, ownerId)
    return owner?.alive && !owner.usedLimitedSkills.includes(FANJIANG_JUESHENG)
      && state.players.some((player) => player.alive && player.id !== ownerId)
      ? [{ id: FANJIANG_JUESHENG, label: '决生：对一名角色使用伤害递增的【决斗】' }] : []
  },
  invokeActive(host, ownerId) {
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
    if (!candidates.length) return
    host.askSkill({ skillId: FANJIANG_JUESHENG, ownerId, step: 'target', data: {}, build: (id): ChooseTargetsRequest => ({
      id, kind: 'choose-targets', playerId: ownerId, prompt: '【决生】：选择一名角色进行伤害值递增的【决斗】',
      timeoutMs: 25_000, optional: false, candidateIds: candidates, min: 1, max: 1,
    }) })
  },
  triggers: [{ event: 'CardResolved', handle(host, ownerId, context) {
    const payload = context.event.payload as { sourceSkillId?: string }
    if (context.event.sourceId !== ownerId || payload.sourceSkillId !== FANJIANG_JUESHENG) return
    const targetId = (host.state as Batch60State).b60FanjiangPending?.[ownerId]
    if (!targetId || !ownerOf(host.state, targetId)?.alive) return
    delete (host.state as Batch60State).b60FanjiangPending![ownerId]
    const data = host.state as Batch60State
    const grants = data.b60FanjiangGrantedAt ??= {}
    const entries = grants[targetId] ??= []
    entries.push({ sourceId: ownerId, turnNumber: host.state.turnNumber })
    replaceTemporarySkill(host.state, targetId, `${FANJIANG_JUESHENG}:${ownerId}`, FANJIANG_JUESHENG)
  } }, { event: 'TurnEnd', allowDeadOwner: true, handle(host, ownerId, context) {
    const playerId = context.event.sourceId ?? (context.event.payload as { playerId?: PlayerId }).playerId
    if (playerId !== ownerId) return
    const data = host.state as Batch60State
    const entries = data.b60FanjiangGrantedAt?.[ownerId] ?? []
    const expired = entries.filter((entry) => host.state.turnNumber > entry.turnNumber)
    for (const entry of expired) replaceTemporarySkill(host.state, ownerId, `${FANJIANG_JUESHENG}:${entry.sourceId}`, null)
    const remaining = entries.filter((entry) => !expired.includes(entry))
    if (remaining.length) data.b60FanjiangGrantedAt![ownerId] = remaining
    else delete data.b60FanjiangGrantedAt?.[ownerId]
  } }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const owner = ownerOf(host.state, ownerId)
    const target = optionalOwnerOf(host.state, targetId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FANJIANG_JUESHENG) || !target?.alive || target.id === ownerId) return
    const slashes = host.state.cardUseHistory?.filter((entry) => entry.sourceId === target.id && entry.cardName === '杀').length ?? 0
    const damageAmount = Math.max(1, slashes)
    if (!host.beginVirtualTrick({ sourceId: ownerId, targetId: target.id, cardName: '决斗', sourceSkillId: FANJIANG_JUESHENG, damageAmount })) return
    owner.usedLimitedSkills.push(FANJIANG_JUESHENG)
    ;((host.state as Batch60State).b60FanjiangPending ??= {})[ownerId] = target.id
  },
})

const HISTORICAL_BATCH60_UNORDERED: readonly CharacterDefinition[] = [
  { id: 'jie-wangji-b60', name: '界·王基', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: WANGJI_QIZHI, name: '奇制', description: '蓄力技（1/2），出牌阶段每名角色限一次，你可消耗1点蓄力点，令一名角色摸两张牌，然后本阶段你使用基本牌或普通锦囊牌指定目标后，你依次观看本阶段因此摸牌的角色的手牌并弃置其一张牌。' },
    { id: WANGJI_JINQU, name: '进趋', description: '锁定技，你每于回合内使用两张基本牌或普通锦囊牌后，令一名角色获得1点蓄力点；结束阶段，你摸X张牌（X为本回合你蓄力点数存在过的最高值）。' },
  ] },
  { id: 'jiang-huaxiong-b60', name: '将华雄', kingdom: 'qun', gender: 'male', maxHp: 6, pack: 'sp', skills: [
    { id: HUAYONG_SHIYONG, name: '恃勇', description: '锁定技，当你受到红色【杀】或【酒】【杀】造成的伤害后，你减少1点体力上限。' },
  ] },
  { id: 'sp-zhanghe-b60', name: 'SP·张郃', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGHE_ZHOUXUAN, name: '周旋', description: '弃牌阶段开始时，你可以将任意张手牌暗置于你的武将牌上，称为“旋”（至多五张），直到你下个出牌阶段结束。当你使用牌时，你移去一张“旋”并摸一张牌，若你的手牌不是唯一最多则额外摸X张牌（X为“旋”的数量）。' },
  ] },
  { id: 'zuofen-b60', name: '左棻', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp', skills: [
    { id: ZUOFEN_ZHAOSONG, name: '诏颂', description: '其他角色摸牌阶段结束时，若其没有本技能的标记，你可以令其正面朝上交给你一张手牌，其根据此牌类型获得对应标记：锦囊牌“诔”；装备牌“赋”；基本牌“颂”。其他角色可以在其以下时机移除其相应标记并触发效果：“诔”进入濒死时，回复至1点体力并摸一张牌；“赋”出牌阶段开始时，弃置一名角色区域里至多两张牌；“颂”使用【杀】指定唯一目标时，多指定至多两个目标。' },
    { id: ZUOFEN_LISI, name: '离思', description: '当你于回合外使用牌置入弃牌堆时，你可以令一名手牌数不大于你的其他角色获得之。' },
  ] },
  { id: 'lvkuang-lvxiang-b60', name: '吕旷吕翔', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: LVKUANG_QIGONG, name: '齐攻', description: '当你使用的仅指定单一目标的【杀】被【闪】抵消后，你可以令一名角色对此目标再使用一张无距离限制的【杀】，此【杀】不可被响应。' },
    { id: LVKUANG_LIEHOU, name: '列侯', description: '出牌阶段限一次，你可以令你攻击范围内一名有手牌的角色交给你一张手牌，若如此做，你将一张手牌交给你攻击范围内的另一名其他角色。' },
  ] },
  { id: 'sp-zhangliao-b60', name: 'SP·张辽', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: ZHANGLIAO_MUBING, name: '募兵', description: '出牌阶段开始时，你可以亮出牌堆顶三张牌，然后你可以弃置任意张手牌，获得任意张亮出的牌（你弃置牌的点数之和不得小于你获得牌的点数之和）。' },
    { id: ZHANGLIAO_ZIQU, name: '资取', description: '每名角色限一次，当你对其他角色造成伤害时，你可以防止此伤害，令其交给你一张点数最大的牌。' },
    { id: ZHANGLIAO_TIAOLING, name: '调令', description: '觉醒技，准备阶段，若你以“募兵”累计获得了至少六张【杀】、伤害锦囊牌和武器牌，你回复1点体力或摸两张牌，并修改“募兵”：亮出牌堆顶四张牌，其余规则不变，然后你可以将以此法获得的牌以任意方式交给其他角色。' },
  ] },
  { id: 'wolong-fengchu-b60', name: '卧龙凤雏', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: WOLONG_YOULONG, name: '游龙', description: '转换技，每轮各限一次，你可以废除你装备区里的一个装备栏，视为使用一张未以此法使用过的：阳：普通锦囊牌；阴：基本牌。' },
    { id: WOLONG_LUANFENG, name: '鸾凤', description: '限定技，当一名角色进入濒死状态时，若其体力上限不小于你，你可以令其回复至3点体力，复原其装备栏，令其将手牌摸至6-X张（X为以此法复原的装备栏数）。若其是你，你复原“游龙”使用过的牌名。' },
  ] },
  { id: 'huang-chengyan-b60', name: '黄承彦', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: HUANGCHENGYAN_GUANXU, name: '观虚', description: '出牌阶段限一次，你可以观看一名其他角色的手牌，并可以将其中一张手牌与牌堆顶五张牌中的一张交换，若如此做，你弃置其手牌中三张花色相同的牌。' },
    { id: HUANGCHENGYAN_YASHI, name: '雅士', description: '当你受到伤害后，你可以选择一项：1.令伤害来源的非锁定技失效直到其下个回合开始；2.对一名其他角色执行“观虚”的效果。' },
  ] },
  { id: 'gao-gan-b60', name: '高干', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: GAOGAN_JUGUAN, name: '拒关', description: '出牌阶段限一次，你可将一张手牌当【杀】或【决斗】使用。若受到此牌伤害的角色未在你的下回合开始前对你造成过伤害，你的下个摸牌阶段摸牌数+2。' },
  ] },
  { id: 'fanjiang-zhangda-b60', name: '范疆张达', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: FANJIANG_YUANCHOU, name: '怨仇', description: '锁定技，你使用的黑色【杀】无视目标角色防具，其他角色对你使用的黑色【杀】无视你的防具。' },
    { id: FANJIANG_JUESHENG, name: '决生', description: '限定技，你可以视为使用一张伤害为X的【决斗】（X为目标角色本局使用【杀】的数量且至少为1），然后其获得本技能直到其下回合结束。' },
  ] },
]

const HISTORICAL_BATCH60_ORDER = ['jie-wangji-b60', 'jiang-huaxiong-b60', 'zuofen-b60', 'sp-zhanghe-b60', 'lvkuang-lvxiang-b60', 'sp-zhangliao-b60', 'wolong-fengchu-b60', 'huang-chengyan-b60', 'gao-gan-b60', 'fanjiang-zhangda-b60']
const HISTORICAL_BATCH60_ORDER_INDEX = new Map(HISTORICAL_BATCH60_ORDER.map((id, index) => [id, index]))
export const HISTORICAL_BATCH60_CHARACTERS: readonly CharacterDefinition[] = [...HISTORICAL_BATCH60_UNORDERED]
  .sort((left, right) => HISTORICAL_BATCH60_ORDER_INDEX.get(left.id)! - HISTORICAL_BATCH60_ORDER_INDEX.get(right.id)!)
