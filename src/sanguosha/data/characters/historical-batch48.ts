import { drawCards } from '../../engine/draw'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { effectiveCardSuit, getSkillRuntime, isCardProtectedFromDiscard, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { pickableCardsOf, resolvePickedCard, movePickedCard } from '../../engine/card-pick'
import { lockCardUseUntilTurnEnd } from '../../engine/card-play-lock'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { getAttackRange, getDistance } from '../../engine/distance'
import { getEngineCallbacks } from '../../engine/equipment-requests'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { applySeatPermutation } from '../../engine/seat-permutation'
import { gainMaxHp } from '../../engine/hp'
import { moveCard, locateOwnedCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { equipmentSlotsOf } from '../../engine/equipment-slots'
import { startPindian, registerPindianContinuation, canPindian } from '../../engine/pindian'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { recover } from '../../engine/recover'
import { resolveDamage } from '../../engine/damage'
import { loseHp } from '../../engine/hp'
import { gainArmor } from '../../engine/armor'
import { loseArmor } from '../../engine/armor'
import { suppressArmorForCard, clearArmorSuppressionForCard } from '../../engine/armor-suppression'
import { grantSkill } from '../../engine/skills/runtime'
import type { DamagePreventionContext, TargetedCardContext } from '../../engine/skills/runtime'
import { isInFactionEncirclement } from '../../engine/formation'
import { revealedGeneralFactionOf } from '../../engine/general-slots'
import { closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards } from '../../engine/private-zone'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { LegalAction } from '../../engine/actions'
import type { CharacterDefinition } from './types'

const B = '-b48'
const SHEYI = `sheyi${B}`
const TIANYIN = `tianyin${B}`
const JISHI = `jishi${B}`
const LIAOYI = `liaoyi${B}`
const BINGLUN = `binglun${B}`
const YAJUN = `yajun${B}`
const ZUNDI = `zundi${B}`
const MAOJIE_BINGQING = `bingqing-maojie${B}`
const MAOJIE_MARK = `${MAOJIE_BINGQING}:suits`
const REN_PILE = 'ren-zhangzhongjing-b48'
const BINGLUN_DELAY = `${BINGLUN}:delayed-recover`
const YAJUN_GAINED = `${YAJUN}:gained`
const YAJUN_CONTINUATION = `${YAJUN}:pindian`
const B48_XIAYUAN = `xiayuan${B}`
const B48_JIEYUE = `jieyue${B}`
const B48_YANGWEI = `yangwei${B}`
const B48_WEI_MARK = `${B48_YANGWEI}:mark`
const B48_YANGWEI_DISABLED = `${B48_YANGWEI}:disabled-at-turn`
const B48_YAOWU = 'yaowu-jie-huaxiong-b37'
const B48_KEXI = `kexi-moulvmeng${B}`
const B48_DUJIANG = `dujiang${B}`
const B48_DUOJING = `duojing${B}`
const B48_DUOJING_USES = `${B48_DUOJING}:extra-slashes`
const B48_SHENXING = `shenxing-jie-guyong${B}`
const B48_SHENXING_COUNT = `${B48_SHENXING}:uses`
const B48_BINGYI = `bingyi-jie-guyong${B}`
const B48_ZHENTING = `zhenting-jiangwan-revised${B}`
const B48_JINCUI = `jincui-jiangwan-revised${B}`
const B48_ZHENTING_TURN = `${B48_ZHENTING}:turn`
const B48_ZHENTING_COUNT = `${B48_ZHENTING}:count`
const B48_ZHENTING_NO_BACKWATER = `${B48_ZHENTING}:no-backwater`
const B48_ZHANGREN_FENGSHI = `fengshi-zhangren${B}`
const B48_ZHANGREN_CHUANXIN = `chuanxin-zhangren${B}`
const B48_JIE_ZHOUCANG_ZHONGYONG = `zhongyong-jie-zhoucang${B}`

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function dispatchGain(host: SkillHost, targetId: PlayerId, cardId: CardId, sourceId?: PlayerId, reason = SHEYI) {
  host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason }, {
    sourceId, targetId, cardIds: [cardId],
  })
}

registerSkillRuntime({
  id: SHEYI,
  offersGlobalDamagePreventionAsk(host, ownerId, context) {
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive || target.id === ownerId || target.hp >= owner.hp
      || owner.marks[`${SHEYI}:round`] === host.state.roundNumber
      || pickableCardsOf(host.state, ownerId).cardIds.length + pickableCardsOf(host.state, ownerId).hiddenCardSlots.length < owner.hp) return false
    host.queueSkill({ skillId: SHEYI, ownerId, step: 'cost', data: { targetId: target.id, minimum: owner.hp, round: host.state.roundNumber } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'cost') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const minimum = prompt.data.minimum as number
    const pickable = pickableCardsOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive || target.hp >= owner.hp || pickable.cardIds.length + pickable.hiddenCardSlots.length < minimum) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    host.askSkill({ skillId: SHEYI, ownerId, step: 'cost', data: prompt.data,
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: `【舍裔】：交给${target.nickname}至少${minimum}张牌以防止此次伤害`, timeoutMs: 30_000,
        optional: true, purpose: 'skill', ...pickable, min: 0, max: pickable.cardIds.length + pickable.hiddenCardSlots.length }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cost') return
    const owner = playerOf(host.state, ownerId)
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const chosen = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
    const minimum = resolution.data.minimum as number
    const cardIds = chosen.map((id) => resolvePickedCard(host.state, ownerId, id))
    if (!owner?.alive || !target?.alive || target.hp >= owner.hp || chosen.length !== cardIds.length
      || cardIds.some((id) => !id) || cardIds.length < minimum
      || owner.marks[`${SHEYI}:round`] === resolution.data.round
      || resolution.data.round !== host.state.roundNumber) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    for (const cardId of cardIds as CardId[]) {
      if (!movePickedCard(host as never, ownerId, cardId, { kind: 'hand', playerId: targetId })) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
    }
    owner.marks[`${SHEYI}:round`] = host.state.roundNumber
    for (const cardId of cardIds as CardId[]) dispatchGain(host, targetId, cardId, ownerId)
    resumeTargetDamagePrevention(host as never, true, SHEYI)
  },
})

const BASIC_TRICK_EQUIPMENT: readonly CardCategory[] = ['basic', 'trick', 'equipment']
registerSkillRuntime({
  id: TIANYIN,
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive) return
    const history = host.state.turnCardCategories?.[ownerId]
    const usedCategories = new Set(history?.turnNumber === host.state.turnNumber
      ? history.entries.filter((entry) => entry.kind === 'used').map((entry) => entry.category) : [])
    for (const category of BASIC_TRICK_EQUIPMENT) {
      if (usedCategories.has(category)) continue
      const cardId = host.state.zones.drawPile.find((id) => host.state.cards[id]?.category === category)
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      dispatchGain(host, ownerId, cardId)
    }
  } }],
})

export const B48_CAI_ZHENJI: CharacterDefinition = {
  id: 'caizhenji-b48', name: '蔡贞姬', kingdom: 'wei', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: SHEYI, name: '舍裔', description: '每轮限一次，当一名其他角色受到伤害时，若其体力值小于你，你可以将至少X张牌交给该角色（X为你的体力值）。若如此做，你防止此伤害。' },
    { id: TIANYIN, name: '天音', description: '锁定技，结束阶段，你从牌堆中获得本回合未使用过的牌类型的各一张牌。' },
  ],
}

function renCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[REN_PILE] ?? []
}

function putRen(host: SkillHost, ownerId: PlayerId, cardId: CardId, from: { kind: 'discardPile' } | { kind: 'hand'; playerId: PlayerId }) {
  const pile = renCards(host.state, ownerId)
  moveCard(host.state, cardId, from, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE })
  if (pile.length <= 6) return
  const overflow = pile.shift()!
  moveCard(host.state, overflow, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE }, { kind: 'discardPile' },
    { discardReason: 'other', characterPileMoveReason: 'overflow' })
}

function removeRen(host: SkillHost, ownerId: PlayerId, cardId: CardId, destination: Parameters<typeof moveCard>[3]): boolean {
  const pile = renCards(host.state, ownerId)
  if (!pile.includes(cardId)) return false
  moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE }, destination)
  return true
}

registerSkillRuntime({
  id: JISHI,
  triggers: [{ event: 'CharacterPileMoved', handle(host, ownerId, context) {
    const movement = context.event.payload as { ownerId?: PlayerId; pile?: string; direction?: string; overflow?: boolean }
    if (movement.ownerId !== ownerId || movement.pile !== REN_PILE || movement.direction !== 'leave'
      || movement.overflow || !playerOf(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
  } }, { event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || !playerOf(host.state, ownerId)?.alive) return
    const payload = context.event.payload as { cardId?: CardId; cardIds?: CardId[]; virtual?: boolean }
    if (!payload.cardId || cardDamageDealt(host.state, payload.cardId) > 0) return
    const physicalIds = [...new Set(payload.cardIds?.length ? payload.cardIds : [payload.cardId])]
    for (const cardId of physicalIds) {
      if (!host.state.zones.discardPile.includes(cardId)) continue
      putRen(host, ownerId, cardId, { kind: 'discardPile' })
    }
  } }, {
    event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || target.id === ownerId) return
      const gap = Math.min(4, Math.abs(target.zones.hand.length - target.hp))
      if (gap === 0) return
      if (target.zones.hand.length < target.hp) {
        const pile = renCards(host.state, ownerId)
        if (pile.length < gap) return
        host.askSkill({ skillId: LIAOYI, ownerId, step: 'gain-choice', data: { targetId, amount: gap },
          build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
            prompt: `【疗疫】：是否令${target.nickname}获得${gap}张“仁”？`, timeoutMs: 20_000, optional: true,
            options: [{ id: 'yes', label: '令其获得“仁”' }, { id: 'no', label: '不发动' }] }) })
      } else {
        const targetPlayerId = target.id
        const pickable = pickableCardsOf(host.state, targetPlayerId)
        const count = Math.min(gap, pickable.cardIds.length + pickable.hiddenCardSlots.length)
        if (!count) return
        host.askSkill({ skillId: LIAOYI, ownerId, step: 'store', data: { targetId: targetPlayerId, amount: count },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetPlayerId,
            prompt: `【疗疫】：將${count}张手牌置入张仲景的“仁”区`, timeoutMs: 20_000, optional: false,
            purpose: 'skill', ...pickable, min: count, max: count }) })
      }
    },
  }, {
    event: 'PhaseEnd', allowDeadOwner: true, handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.phase !== 'finish' || !phase.playerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.marks[`${BINGLUN_DELAY}:${phase.playerId}`]) return
      delete owner.marks[`${BINGLUN_DELAY}:${phase.playerId}`]
      if (playerOf(host.state, phase.playerId)?.alive) recover(host as never, phase.playerId, 1, ownerId)
    },
  }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !usedThisPhase(state, ownerId, BINGLUN) && renCards(state, ownerId).length > 0
      ? [{ id: BINGLUN, label: '病论：弃置一张“仁”并令一名角色选择' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== BINGLUN || usedThisPhase(host.state, ownerId, BINGLUN)) return
    const pile = renCards(host.state, ownerId)
    if (!playerOf(host.state, ownerId)?.alive || !pile.length) return
    markUsedThisPhase(host.state, ownerId, BINGLUN)
    host.askSkill({ skillId: BINGLUN, ownerId, step: 'cost', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【病论】：选择一张“仁”牌置入弃牌堆', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...pile], hiddenCardSlots: [], min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'gain-choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive || !target?.alive) return
      const currentAmount = Math.min(4, target.hp - target.zones.hand.length)
      const ren = renCards(host.state, ownerId)
      if (currentAmount < 1 || ren.length < currentAmount) return
      host.askSkill({ skillId: LIAOYI, ownerId, step: 'gain-cards', data: { targetId, amount: currentAmount },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【疗疫】：选择交给${target.nickname}的${currentAmount}张“仁”`, timeoutMs: 20_000,
          optional: false, purpose: 'skill', cardIds: [...ren], hiddenCardSlots: [], min: currentAmount, max: currentAmount }) })
      return
    }
    if (resolution.step === 'gain-cards') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const amount = Math.min(4, (target?.hp ?? 0) - (target?.zones.hand.length ?? 0))
      const selected = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      const ren = renCards(host.state, ownerId)
      if (!owner?.alive || !target?.alive || amount < 1 || selected.length !== amount
        || selected.some((cardId) => !ren.includes(cardId))) return
      for (const cardId of selected) {
        if (removeRen(host, ownerId, cardId, { kind: 'hand', playerId: targetId }))
          dispatchGain(host, targetId, cardId, ownerId, LIAOYI)
      }
      return
    }
    if (resolution.step === 'store') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const count = resolution.data.amount as number
      const ids = [...new Set((response.payload as { cardIds?: string[] }).cardIds ?? [])]
      const cardIds = ids.map((id) => resolvePickedCard(host.state, targetId, id))
      if (!owner?.alive || !target?.alive || ids.length !== count || cardIds.some((id) => !id)) return
      for (const cardId of cardIds as CardId[]) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (from?.kind !== 'hand') return
      }
      for (const cardId of host.rng.shuffle(cardIds as CardId[])) putRen(host, ownerId, cardId, { kind: 'hand', playerId: targetId })
      return
    }
    if (resolution.step === 'cost') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || !removeRen(host, ownerId, cardId, { kind: 'discardPile' })) return
      host.askSkill({ skillId: BINGLUN, ownerId, step: 'target', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【病论】：选择一名角色', timeoutMs: 20_000, optional: false,
          candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({ skillId: BINGLUN, ownerId, step: 'choice', data: { targetId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: target.id,
          prompt: '【病论】：选择一项', timeoutMs: 20_000, optional: false,
          options: [{ id: 'draw', label: '摸一张牌' }, { id: 'recover', label: '于你的回合结束后回复1点体力' }] }) })
      return
    }
    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      if ((response.payload as { optionId?: string }).optionId === 'draw') drawCards(host.state, host.rng, targetId, 1, (name, payload) => host.dispatch(name, payload))
      else if ((response.payload as { optionId?: string }).optionId === 'recover') owner!.marks[`${BINGLUN_DELAY}:${targetId}`] = 1
    }
  },
})

for (const skillId of [LIAOYI, BINGLUN]) {
  registerSkillRuntime({
    id: skillId,
    startQueued(host, ownerId, prompt) {
      getSkillRuntime(JISHI)?.startQueued?.(host, ownerId, prompt)
    },
    resume(host, ownerId, resolution, response) {
      getSkillRuntime(JISHI)?.resume?.(host, ownerId, resolution, response)
    },
  })
}

export const B48_ZHANG_ZHONGJING: CharacterDefinition = {
  id: 'zhangzhongjing-b48', name: '张仲景', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: JISHI, name: '济世', description: '锁定技，你使用牌结算结束后，若此牌没有造成伤害，且此牌仍在弃牌堆中，则将其置于“仁”区中；当“仁”牌非因“仁”区溢出而离开“仁”区时，你摸一张牌。' },
    { id: LIAOYI, name: '疗疫', description: '其他角色回合开始时，若其手牌数小于体力值且场上“仁”数量不小于X，则你可以令其获得场上X张“仁”；若其手牌数大于体力值，则令其将X张牌置于“仁”中。（X为其手牌数与体力值差值，且至多为4）' },
    { id: BINGLUN, name: '病论', description: '出牌阶段限一次，你可以选择一名角色并弃置一张“仁”牌，令其选择：摸一张牌，或于其回合结束后回复1点体力。' },
  ],
}

registerPindianContinuation(YAJUN_CONTINUATION, (host, result) => {
  const owner = playerOf(host.state, result.initiatorId)
  if (!owner?.alive) return
  if (result.outcome !== 'initiator-win') {
    owner.marks[`${YAJUN}:failed-turn`] = host.state.turnNumber
    return
  }
  const held = [result.initiatorCardId, result.opponentCardId].filter((cardId) => host.state.zones.processingArea.includes(cardId))
  if (!held.length) return
  const zoneId = `${YAJUN}:pindian:${owner.id}:${host.state.seq}`
  openPrivateZone(host.state, zoneId, owner.id, 'pindian')
  for (const cardId of held) moveIntoPrivateZone(host.state, cardId, { kind: 'processingArea' }, zoneId)
  ;(host as unknown as SkillHost).askSkill({ skillId: YAJUN, ownerId: owner.id, step: 'top-card', data: { cardIds: held, zoneId }, build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: owner.id,
    prompt: '【雅俊】：将一张拼点牌置于牌堆顶', timeoutMs: 20_000, optional: true,
    purpose: 'skill', cardIds: held,
    hiddenCardSlots: [], min: 0, max: 1 }) })
})

registerSkillRuntime({
  id: YAJUN,
  maxCardsBonus(state, ownerId) {
    return playerOf(state, ownerId)?.marks[`${YAJUN}:failed-turn`] === state.turnNumber ? -1 : 0
  },
  triggers: [{ event: 'GainCard', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
    if (payload.playerId !== ownerId || host.state.currentPlayerId !== ownerId) return
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const gained = owner.marks[YAJUN_GAINED] as unknown as { turn: number; ids: CardId[] } | undefined
    const history = gained?.turn === host.state.turnNumber ? gained.ids : []
    owner.marks[YAJUN_GAINED] = { turn: host.state.turnNumber, ids: [...new Set([...history, ...(payload.cardIds ?? [])])] } as never
  } }, {
    event: 'PhaseStart', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId) return
      if (phase.phase === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        if (playerOf(host.state, ownerId)) host.state.players.find((player) => player.id === ownerId)!.marks[YAJUN_GAINED] ??= { turn: host.state.turnNumber, ids: [] } as never
      }
      if (phase.phase === 'play') host.queueSkill({ skillId: YAJUN, ownerId, step: 'play-start', data: {} })
    },
  }, {
    event: 'TurnStart', handle(host, ownerId, context) {
      const targetId = context.event.targetId ?? (context.event.payload as { playerId?: PlayerId }).playerId
      if (targetId === ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (owner) delete owner.marks[`${YAJUN}:failed-turn`]
      }
    },
  }, {
    event: 'Death', allowDeadOwner: true, handle(host, ownerId) {
      for (const zone of [...(host.state.privateZones ?? [])]) {
        if (zone.ownerId === ownerId && zone.id.startsWith(`${YAJUN}:pindian:${ownerId}:`)) closePrivateZone(host.state, zone.id)
      }
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'play-start') return
    const owner = playerOf(host.state, ownerId)
    const gained = owner?.marks[YAJUN_GAINED] as unknown as { turn: number; ids: CardId[] } | undefined
    const cardIds = gained?.turn === host.state.turnNumber ? gained.ids.filter((id) => owner?.zones.hand.includes(id)) : []
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id))
    if (!owner?.alive || !cardIds.length || !candidates.length) return
    host.askSkill({ skillId: YAJUN, ownerId, step: 'offer', data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【雅俊】：是否用本回合获得的一张牌与一名其他角色拼点？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动雅俊' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'offer') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      const gained = owner?.marks[YAJUN_GAINED] as unknown as { turn: number; ids: CardId[] } | undefined
      const cardIds = gained?.turn === host.state.turnNumber ? gained.ids.filter((id) => owner?.zones.hand.includes(id)) : []
      if (!owner?.alive || !cardIds.length || !canPindian(host.state, ownerId)) return
      host.askSkill({ skillId: YAJUN, ownerId, step: 'pindian-card', data: {},
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【雅俊】：选择本回合获得的一张手牌用于拼点', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'pindian-card') {
      const owner = playerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const gained = owner?.marks[YAJUN_GAINED] as unknown as { turn: number; ids: CardId[] } | undefined
      if (!owner?.alive || !cardId || gained?.turn !== host.state.turnNumber || !gained.ids.includes(cardId) || !owner.zones.hand.includes(cardId)) return
      host.askSkill({ skillId: YAJUN, ownerId, step: 'pindian-target', data: { cardId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【雅俊】：选择一名其他角色拼点', timeoutMs: 20_000, optional: false,
          candidateIds: host.state.players.filter((player) => player.alive && player.id !== ownerId && canPindian(host.state, player.id)).map((player) => player.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'pindian-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const cardId = resolution.data.cardId as CardId
      if (!targetId || !playerOf(host.state, ownerId)?.zones.hand.includes(cardId) || !canPindian(host.state, targetId)) return
      startPindian(host as never, { id: `${YAJUN}:${host.state.seq}`, initiatorId: ownerId,
        opponentId: targetId, reason: YAJUN, continuationTag: YAJUN_CONTINUATION, initiatorForcedCardId: cardId })
      return
    }
    if (resolution.step === 'top-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const zoneId = resolution.data.zoneId as string
      const choices = resolution.data.cardIds as CardId[]
      if (playerOf(host.state, ownerId)?.alive && cardId && choices.includes(cardId) && privateZoneCards(host.state, zoneId).includes(cardId)) {
        moveOutOfPrivateZone(host.state, cardId, zoneId, { kind: 'drawPile' })
        const index = host.state.zones.drawPile.lastIndexOf(cardId)
        if (index >= 0) host.state.zones.drawPile.splice(index, 1)
        host.state.zones.drawPile.unshift(cardId)
      }
      closePrivateZone(host.state, zoneId)
    }
  },
})

export const B48_CUI_YAN: CharacterDefinition = {
  id: 'cuiyan-b48', name: '崔琰', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: YAJUN, name: '雅俊', description: '摸牌阶段，你多摸一张牌。出牌阶段开始时，你可以用本回合获得的一张牌与一名其他角色进行拼点。若你赢，你可以将其中一张拼点牌置于牌堆顶；若你没赢，你本回合手牌上限-1。' },
    { id: ZUNDI, name: '尊嫡', description: '出牌阶段限一次，你可以弃置一张手牌并选择一名角色，然后你进行判定：黑色，其摸三张牌；红色，其可以移动场上一张牌。' },
  ],
}

const ZUNDI_JUDGE = `${ZUNDI}:judge`

registerJudgmentContinuation(ZUNDI_JUDGE, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  if (!playerOf(host.state, ownerId)?.alive) return
  if (judged.color === 'black') {
    const targetId = data.targetId as PlayerId
    if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 3, (name, payload) => host.dispatch(name, payload))
    return
  }
  const targetId = data.targetId as PlayerId
  if (!playerOf(host.state, targetId)?.alive) return
  const cards: CardId[] = []
  for (const player of host.state.players) if (player.alive) {
    cards.push(...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)))
    cards.push(...player.zones.judgingArea)
  }
  host.askSkill({ skillId: ZUNDI, ownerId, step: 'move-card', data: { moverId: targetId },
    build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
      prompt: '【尊嫡】：选择场上一张装备牌或判定牌移动', timeoutMs: 20_000, optional: true,
      purpose: 'skill', cardIds: [...new Set(cards)], hiddenCardSlots: [], min: 0, max: 1 }) })
})

registerSkillRuntime({
  id: ZUNDI,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !usedThisPhase(state, ownerId, ZUNDI) && owner.zones.hand.length > 0
      ? [{ id: ZUNDI, label: '尊嫡：弃置一张手牌并判定' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZUNDI || usedThisPhase(host.state, ownerId, ZUNDI)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !owner.zones.hand.length) return
    host.askSkill({ skillId: ZUNDI, ownerId, step: 'cost', data: {},
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【尊嫡】：弃置一张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const owner = playerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      markUsedThisPhase(host.state, ownerId, ZUNDI)
      host.askSkill({ skillId: ZUNDI, ownerId, step: 'target', data: {},
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【尊嫡】：选择一名角色', timeoutMs: 20_000, optional: false,
          candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive) performJudgment(host as never, targetId, ZUNDI, { tag: ZUNDI_JUDGE, data: { ownerId, targetId } })
      return
    }
    if (resolution.step === 'move-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const moverId = resolution.data.moverId as PlayerId
      if (!cardId || !playerOf(host.state, moverId)?.alive) return
      let from: ReturnType<typeof locateOwnedCard> = null
      for (const player of host.state.players) {
        const location = locateOwnedCard(host.state, player.id, cardId)
        if (location?.kind === 'equipment' || location?.kind === 'judgingArea') { from = location; break }
      }
      if (!from || (from.kind !== 'equipment' && from.kind !== 'judgingArea')) return
      const candidates = host.state.players.filter((target) => target.alive && target.id !== from!.playerId && (from!.kind === 'equipment'
        ? equipmentSlotsOf(host.state, target.id).includes(from!.slot)
        : !target.zones.judgingArea.some((id) => host.state.cards[id]?.name === host.state.cards[cardId]?.name)))
      if (!candidates.length) return
      host.askSkill({ skillId: ZUNDI, ownerId, step: 'move-target', data: { cardId, from, moverId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: moverId,
          prompt: '【尊嫡】：选择此牌移动至的角色', timeoutMs: 20_000, optional: false,
          candidateIds: candidates.map((target) => target.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'move-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const { cardId, from, moverId } = resolution.data as { cardId: CardId; from: NonNullable<ReturnType<typeof locateOwnedCard>>; moverId: PlayerId }
      if (from.kind !== 'equipment' && from.kind !== 'judgingArea') return
      const source = playerOf(host.state, from.playerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!playerOf(host.state, moverId)?.alive || !source?.alive || !target?.alive || target.id === source.id) return
      if (from.kind === 'equipment') {
        if (!equipmentSlotsOf(host.state, target.id).includes(from.slot)) return
        const replaced = target.zones.equipment[from.slot]
        moveCard(host.state, cardId, from, { kind: 'equipment', playerId: target.id, slot: from.slot })
        handleEquipmentLost(host as never, source.id, cardId)
        if (replaced) handleEquipmentLost(host as never, target.id, replaced)
      } else {
        if (target.zones.judgingArea.some((id) => host.state.cards[id]?.name === host.state.cards[cardId]?.name)) return
        moveCard(host.state, cardId, from, { kind: 'judgingArea', playerId: target.id })
      }
    }
  },
})

function maojieSuitMask(state: SanguoshaState, ownerId: PlayerId) {
  return playerOf(state, ownerId)?.marks[MAOJIE_MARK] ?? 0
}

function maojieSuitBit(suit: string | undefined) {
  return ({ spade: 1, heart: 2, club: 4, diamond: 8 } as Record<string, number>)[suit ?? ''] ?? 0
}

function maojieDiscardChoices(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId) {
  const pickable = pickableCardsOf(state, targetId, { includeJudgingArea: true, discarderId: ownerId })
  const target = playerOf(state, targetId)
  const hiddenCardSlots = pickable.hiddenCardSlots.filter((_, index) => {
    const cardId = target?.zones.hand[index]
    return Boolean(cardId && !isCardProtectedFromDiscard(state, targetId, cardId, ownerId))
  })
  return { ...pickable, hiddenCardSlots }
}

function askMaojieEffect(host: SkillHost, ownerId: PlayerId, count: number) {
  const candidates = host.state.players.filter((player) => player.alive && (count !== 4 || player.id !== ownerId)
    && (count !== 3 || maojieDiscardChoices(host.state, ownerId, player.id).cardIds.length
      + maojieDiscardChoices(host.state, ownerId, player.id).hiddenCardSlots.length > 0))
  if (!candidates.length) return
  host.askSkill({ skillId: MAOJIE_BINGQING, ownerId, step: 'effect', data: { count },
    build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
      prompt: `【秉清】：已记录${count}种花色，选择效果目标`, timeoutMs: 20_000, optional: true,
      candidateIds: candidates.map((player) => player.id), min: 0, max: 1 }) })
}

registerSkillRuntime({
  id: MAOJIE_BINGQING,
  triggers: [{ event: 'AfterCardUse', handle(host, ownerId, context) {
    if (context.event.sourceId !== ownerId || host.state.phase !== 'play') return
    const payload = context.event.payload as { cardId?: CardId }
    const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
    const bit = maojieSuitBit(payload.cardId ? effectiveCardSuit(host.state, ownerId, payload.cardId) : card?.suit)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !bit || (maojieSuitMask(host.state, ownerId) & bit)) return
    const mask = maojieSuitMask(host.state, ownerId) | bit
    owner.marks[MAOJIE_MARK] = mask
    const count = [1, 2, 4, 8].filter((value) => (mask & value) !== 0).length
    const done = owner.marks[`${MAOJIE_MARK}:effects`] ?? 0
    if (count < 2 || count > 4 || (done & (1 << count))) return
    owner.marks[`${MAOJIE_MARK}:effects`] = done | (1 << count)
    askMaojieEffect(host, ownerId, count)
  } }, {
    event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId || phase.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (owner) { owner.marks[MAOJIE_MARK] = 0; owner.marks[`${MAOJIE_MARK}:effects`] = 0 }
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'effect') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const count = resolution.data.count as number
      if (count === 2) {
        drawCards(host.state, host.rng, target.id, 2, (name, payload) => host.dispatch(name, payload))
      } else if (count === 4) {
        resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal', cardName: null })
      } else if (count === 3) {
        const targetPlayerId = target.id
        const pickable = maojieDiscardChoices(host.state, ownerId, targetPlayerId)
        if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
        host.askSkill({ skillId: MAOJIE_BINGQING, ownerId, step: 'discard', data: { targetId: targetPlayerId },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: `【秉清】：弃置${target.nickname}区域里的一张牌`, timeoutMs: 20_000, optional: true,
            purpose: 'skill', ...pickable, min: 0, max: 1 }) })
      }
      return
    }
    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      const pickable = maojieDiscardChoices(host.state, ownerId, targetId)
      const eligible = new Set([...pickable.cardIds, ...pickable.hiddenCardSlots]
        .map((id) => resolvePickedCard(host.state, targetId, id)).filter((id): id is CardId => id !== null))
      if (playerOf(host.state, ownerId)?.alive && cardId && eligible.has(cardId))
        movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
    }
  },
})

export const B48_MAO_JIE: CharacterDefinition = {
  id: 'maojie-b48', name: '毛玠', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [{ id: MAOJIE_BINGQING, name: '秉清', description: '你于出牌阶段内使用牌结算后，若此牌与你此阶段已使用并结算的牌花色均不同，则记录此花色；你记录的花色达到两种、三种、四种时，你可以分别令一名角色摸两张牌、弃置一名角色区域内的一张牌、对一名其他角色造成1点伤害。' }],
}

registerSkillRuntime({
  id: B48_SHENXING,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const count = owner?.marks[B48_SHENXING_COUNT] ?? 0
    const pickable = pickableCardsOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && count < owner.hp && pickable.cardIds.length + pickable.hiddenCardSlots.length >= 2
      ? [{ id: B48_SHENXING, label: `慎行：弃置两张牌（${count}/${owner.hp}）` }]
      : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    const count = owner?.marks[B48_SHENXING_COUNT] ?? 0
    const pickable = pickableCardsOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || count >= owner.hp || pickable.cardIds.length + pickable.hiddenCardSlots.length < 2) return
    host.askSkill({ skillId: B48_SHENXING, ownerId, step: 'discard', data: { count },
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【慎行】：弃置两张牌；若颜色不同，摸两张牌，否则摸一张牌',
        timeoutMs: 30_000, optional: false, purpose: 'skill', ...pickable, min: 2, max: 2 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const previousCount = resolution.data.count as number
    const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const ids = picked.map((id) => resolvePickedCard(host.state, ownerId, id)).filter((id): id is CardId => Boolean(id))
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || (owner.marks[B48_SHENXING_COUNT] ?? 0) !== previousCount || previousCount >= owner.hp || ids.length !== 2
      || ids.some((id) => !locateOwnedCard(host.state, ownerId, id))) return
    const differentColors = host.state.cards[ids[0]]?.color !== host.state.cards[ids[1]]?.color
    for (const cardId of ids) movePickedCard(host as never, ownerId, cardId, { kind: 'discardPile' })
    owner.marks[B48_SHENXING_COUNT] = previousCount + 1
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: ids, reason: B48_SHENXING },
      { sourceId: ownerId, cardIds: ids })
    drawCards(host.state, host.rng, ownerId, differentColors ? 2 : 1,
      (name, payload) => host.dispatch(name, payload))
  },
  triggers: [{ event: 'PhaseEnd', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId === ownerId && phase.phase === 'play') {
      const owner = playerOf(host.state, ownerId)
      if (owner) delete owner.marks[B48_SHENXING_COUNT]
    }
  } }],
})

registerSkillRuntime({
  id: B48_BINGYI,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    const owner = playerOf(host.state, ownerId)
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !owner?.alive || !owner.zones.hand.length) return
    const hand = owner.zones.hand.map((id) => host.state.cards[id]).filter(Boolean)
    const oneColor = new Set(hand.map((card) => card.color)).size === 1
    const oneType = new Set(hand.map((card) => card.category)).size === 1
    if (!oneColor && !oneType) return
    host.queueSkill({ skillId: B48_BINGYI, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.length) return
      host.askSkill({ skillId: B48_BINGYI, ownerId, step: 'invoke', data: {},
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【秉壹】：是否展示所有手牌并令至多等同于手牌数的角色各摸一张牌？',
          timeoutMs: 30_000, optional: false,
          options: [{ id: 'yes', label: '展示并发动' }, { id: 'no', label: '不发动' }] }) })
      return
    }
    if (prompt.step !== 'targets') return
    const owner = playerOf(host.state, ownerId)
    const maxTargets = Math.min(prompt.data.maxTargets as number, host.state.players.filter((player) => player.alive).length)
    if (!owner?.alive || maxTargets < 1) return
    host.askSkill({ skillId: B48_BINGYI, ownerId, step: 'targets', data: { maxTargets },
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【秉壹】：选择至多等同于你手牌数的角色，各摸一张牌', timeoutMs: 30_000,
        optional: true, candidateIds: host.state.players.filter((player) => player.alive).map((player) => player.id),
        min: 0, max: maxTargets }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.length) return
      const cards = owner.zones.hand.map((id) => host.state.cards[id]).filter(Boolean)
      if (new Set(cards.map((card) => card.color)).size !== 1
        && new Set(cards.map((card) => card.category)).size !== 1) return
      const maxTargets = owner.zones.hand.length
      host.dispatch('SkillActivated', { skillId: B48_BINGYI, skillName: '秉壹', shownCardIds: [...owner.zones.hand] },
        { sourceId: ownerId, cardIds: [...owner.zones.hand] })
      host.queueSkill({ skillId: B48_BINGYI, ownerId, step: 'targets', data: { maxTargets } })
      return
    }
    if (resolution.step !== 'targets') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      .filter((id) => playerOf(host.state, id)?.alive)
      .slice(0, Math.min(resolution.data.maxTargets as number, owner.zones.hand.length))
    for (const targetId of targetIds) drawCards(host.state, host.rng, targetId, 1,
      (name, payload) => host.dispatch(name, payload))
  },
})

export const B48_JIE_GUYONG: CharacterDefinition = {
  id: 'jie-guyong-b48', name: '界·顾雍', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: B48_SHENXING, name: '慎行', description: '出牌阶段限X次（X为你的体力值），你可以弃置两张牌，若弃置牌颜色不同，则你摸两张牌；否则你摸一张牌。' },
    { id: B48_BINGYI, name: '秉壹', description: '结束阶段，你可以展示所有手牌，若颜色均相同或类型均相同，你选择至多Y名角色（Y为你的手牌数），这些角色各摸一张牌。' },
  ],
}

type ZhenTingResolutionData = {
  sourceId: PlayerId
  targetId: PlayerId
  cardId: CardId
  cardName: string
  category: CardCategory
  route: 'slash' | 'trick' | 'delayed-action'
  action?: Extract<LegalAction, { kind: 'use-card' }>
  unavailableCostIds?: CardId[]
}

function zhenTingContextIsValid(state: SanguoshaState, ownerId: PlayerId, data: ZhenTingResolutionData): boolean {
  const owner = playerOf(state, ownerId)
  const source = playerOf(state, data.sourceId)
  const target = playerOf(state, data.targetId)
  return Boolean(owner?.alive && source?.alive && target?.alive && data.sourceId !== ownerId
    && (data.targetId === ownerId || getDistance(state, ownerId, data.targetId) <= getAttackRange(state, ownerId)))
}

function zhenTingCostCards(host: SkillHost, ownerId: PlayerId, data: ZhenTingResolutionData) {
  const pickable = pickableCardsOf(host.state, data.sourceId, { discarderId: ownerId })
  const excluded = new Set(data.route === 'delayed-action' ? data.unavailableCostIds ?? [] : [])
  const source = playerOf(host.state, data.sourceId)
  const hiddenCardSlots = pickable.hiddenCardSlots.filter((_, index) => {
    const cardId = source?.zones.hand[index]
    return Boolean(cardId && !excluded.has(cardId)
      && !isCardProtectedFromDiscard(host.state, data.sourceId, cardId, ownerId))
  })
  return { ...pickable, hiddenCardSlots }
}

function askZhenTingMode(host: SkillHost, ownerId: PlayerId, data: ZhenTingResolutionData): void {
  const pickable = zhenTingCostCards(host, ownerId, data)
  const options = [
    ...(pickable.hiddenCardSlots.length ? [{ id: 'discard', label: '弃置此牌使用者的一张手牌' }] : []),
    { id: 'draw', label: '摸一张牌' },
    { id: 'no', label: '不发动' },
  ]
  host.askSkill({ skillId: B48_ZHENTING, ownerId, step: 'mode', data: data as unknown as Record<string, unknown>,
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
      prompt: '【镇庭】：选择一项；可背水代替原目标成为此牌目标', timeoutMs: 30_000,
      optional: false, options }) })
}

function finishZhenTing(host: SkillHost, ownerId: PlayerId, data: ZhenTingResolutionData, replaceTarget: boolean): void {
  if (data.route === 'delayed-action') {
    const action = data.action
    if (!action || !playerOf(host.state, data.sourceId)?.alive) return
    if (replaceTarget) action.targetIds = [ownerId]
    else {
      host.state.zhenTingPassThrough ??= {}
      host.state.zhenTingPassThrough[ownerId] = data.cardId
    }
    executeUseCardAction(host as never, data.sourceId, action)
    if (host.state.zhenTingPassThrough?.[ownerId] === data.cardId && !host.state.skillResolution)
      delete host.state.zhenTingPassThrough[ownerId]
    return
  }
  const current = host.state.cardResolution
  if (!replaceTarget) { host.resumeCardTarget(); return }
  if (data.route === 'slash') {
    getEngineCallbacks()?.transferSlashTarget(host, ownerId, '镇庭')
    return
  }
  if (current?.kind !== 'trick' || current.targetIds[current.targetIndex] !== data.targetId) {
    host.resumeCardTarget()
    return
  }
  current.targetIds[current.targetIndex] = ownerId
  current.interceptsDone = []
  current.cancelledTargetIds = current.cancelledTargetIds.filter((id) => id !== data.targetId && id !== ownerId)
  current.nullifiedTargetIds = current.nullifiedTargetIds.filter((id) => id !== data.targetId && id !== ownerId)
  current.unresponsiveTargetIds = current.unresponsiveTargetIds.filter((id) => id !== data.targetId && id !== ownerId)
  current.responderIndex = 0
  current.nullificationCount = 0
  current.declinedAllIds = []
  current.lastNullifierId = null
  current.stage = 'awaiting-intercept'
  host.dispatch('TargetSpecified', { cardId: data.cardId, cardName: data.cardName,
    targetId: ownerId, reason: '镇庭' }, { sourceId: data.sourceId, targetId: ownerId, cardIds: [data.cardId] })
  host.dispatch('TargetConfirmed', { cardId: data.cardId, cardName: data.cardName,
    targetId: ownerId, reason: '镇庭' }, { sourceId: data.sourceId, targetId: ownerId, cardIds: [data.cardId] })
  host.resumeCardTarget()
}

function askZhenTingBackwater(host: SkillHost, ownerId: PlayerId, data: ZhenTingResolutionData): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || ownerId === data.targetId || owner.marks[B48_ZHENTING_NO_BACKWATER]
    || (host.state.cardResolution?.kind === 'slash'
      && host.state.cardResolution.remainingTargetIds.includes(ownerId))
    || (host.state.cardResolution?.kind === 'trick'
      && host.state.cardResolution.targetIds.some((id) => id === ownerId && id !== data.targetId))) {
    finishZhenTing(host, ownerId, data, false)
    return
  }
  host.askSkill({ skillId: B48_ZHENTING, ownerId, step: 'backwater', data: data as unknown as Record<string, unknown>,
    build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
      prompt: '【镇庭】背水：你代替原目标成为此牌的目标？', timeoutMs: 30_000, optional: true,
      options: [{ id: 'yes', label: '背水，代替其成为目标' }, { id: 'no', label: '不背水' }] }) })
}

registerSkillRuntime({
  id: B48_ZHENTING,
  interceptTarget(host, ownerId, context) {
    if ((context.cardName !== '杀' && !(context.category === 'trick' && DELAYED_TRICKS.has(context.cardName)))
      || context.sourceId === ownerId) return false
    const data: ZhenTingResolutionData = { ...context, route: context.cardName === '杀' ? 'slash' : 'trick' }
    if (!zhenTingContextIsValid(host.state, ownerId, data)
      || playerOf(host.state, ownerId)?.marks[B48_ZHENTING_TURN] === host.state.turnNumber) return false
    askZhenTingMode(host, ownerId, data)
    return true
  },
  interceptBystanderTarget(host, ownerId, context) {
    if ((context.cardName !== '杀' && !(context.category === 'trick' && DELAYED_TRICKS.has(context.cardName)))
      || context.sourceId === ownerId) return false
    const data: ZhenTingResolutionData = { ...context, route: context.cardName === '杀' ? 'slash' : 'trick' }
    if (!zhenTingContextIsValid(host.state, ownerId, data)
      || playerOf(host.state, ownerId)?.marks[B48_ZHENTING_TURN] === host.state.turnNumber) return false
    askZhenTingMode(host, ownerId, data)
    return true
  },
  interceptPlayAction(host, ownerId, action) {
    const cardId = action.cardIds[0]
    const card = host.state.cards[cardId]
    const targetId = action.targetIds[0]
    if (host.state.zhenTingPassThrough?.[ownerId] === cardId) return false
    if (!card || card.category !== 'trick' || !DELAYED_TRICKS.has(action.asCardName ?? card.name) || !targetId || action.playerId === ownerId
      || playerOf(host.state, ownerId)?.marks[B48_ZHENTING_TURN] === host.state.turnNumber) return false
    const data: ZhenTingResolutionData = { sourceId: action.playerId, targetId, cardId,
      cardName: action.asCardName ?? card.name, category: card.category, route: 'delayed-action',
      action: structuredClone(action), unavailableCostIds: [...action.cardIds] }
    if (!zhenTingContextIsValid(host.state, ownerId, data)) return false
    askZhenTingMode(host, ownerId, data)
    return true
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as unknown as ZhenTingResolutionData
    if (!zhenTingContextIsValid(host.state, ownerId, data)) {
      finishZhenTing(host, ownerId, data, false)
      return
    }
    if (resolution.step === 'mode') {
      const mode = (response.payload as { optionId?: string }).optionId
      if (mode === 'no') { finishZhenTing(host, ownerId, data, false); return }
      if (mode === 'draw') {
        const owner = playerOf(host.state, ownerId)!
        owner.marks[B48_ZHENTING_TURN] = host.state.turnNumber
        owner.marks[B48_ZHENTING_COUNT] = (owner.marks[B48_ZHENTING_COUNT] ?? 0) + 1
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
        askZhenTingBackwater(host, ownerId, data)
        return
      }
      if (mode !== 'discard') { finishZhenTing(host, ownerId, data, false); return }
      const pickable = zhenTingCostCards(host, ownerId, data)
      if (!pickable.hiddenCardSlots.length) { finishZhenTing(host, ownerId, data, false); return }
      host.askSkill({ skillId: B48_ZHENTING, ownerId, step: 'discard', data: data as unknown as Record<string, unknown>,
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【镇庭】：选择${playerOf(host.state, data.sourceId)?.nickname ?? '此牌使用者'}的一张手牌弃置`,
          timeoutMs: 30_000, optional: false, purpose: 'skill', cardIds: [],
          hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'discard') {
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked ? resolvePickedCard(host.state, data.sourceId, picked) : null
      const pickable = zhenTingCostCards(host, ownerId, data)
      const currentPickable = new Set(pickable.hiddenCardSlots
        .map((id) => resolvePickedCard(host.state, data.sourceId, id))
        .filter((id): id is CardId => id !== null
          && !isCardProtectedFromDiscard(host.state, data.sourceId, id, ownerId)))
      if (!cardId || !playerOf(host.state, data.sourceId)?.zones.hand.includes(cardId) || !currentPickable.has(cardId)
        || !movePickedCard(host as never, data.sourceId, cardId, { kind: 'discardPile' })) {
        finishZhenTing(host, ownerId, data, false)
        return
      }
      host.dispatch('LoseCard', { playerId: data.sourceId, cardIds: [cardId], reason: B48_ZHENTING },
        { sourceId: ownerId, targetId: data.sourceId, cardIds: [cardId] })
      const currentOwner = playerOf(host.state, ownerId)!
      currentOwner.marks[B48_ZHENTING_TURN] = host.state.turnNumber
      currentOwner.marks[B48_ZHENTING_COUNT] = (currentOwner.marks[B48_ZHENTING_COUNT] ?? 0) + 1
      askZhenTingBackwater(host, ownerId, data)
      return
    }
    if (resolution.step === 'backwater') {
      finishZhenTing(host, ownerId, data, (response.payload as { optionId?: string }).optionId === 'yes')
    }
  },
  triggers: [{ event: 'BeforeCardUse', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardId?: CardId }
    if (payload.cardId && host.state.zhenTingPassThrough?.[ownerId] === payload.cardId)
      delete host.state.zhenTingPassThrough[ownerId]
  } }],
})

registerSkillRuntime({
  id: B48_JINCUI,
  limited: true,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && state.players.some((player) => player.alive && player.id !== ownerId)
      && !owner.usedLimitedSkills.includes(B48_JINCUI)
      ? [{ id: B48_JINCUI, label: '尽瘁：与一名角色交换座位并失去体力' }]
      : []
  },
  invokeActive(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || owner.usedLimitedSkills.includes(B48_JINCUI)) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    if (!candidates.length) return
    host.askSkill({ skillId: B48_JINCUI, ownerId, step: 'target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【尽瘁】：选择一名其他角色，与其交换座位', timeoutMs: 30_000,
        optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || target.id === ownerId) return
    if (!owner.usedLimitedSkills.includes(B48_JINCUI)) owner.usedLimitedSkills.push(B48_JINCUI)
    const ordered = host.state.players.map((player) => player.id)
    const ownerSeat = ordered.indexOf(ownerId)
    const targetSeat = ordered.indexOf(target.id)
    if (ownerSeat < 0 || targetSeat < 0) return
    ;[ordered[ownerSeat], ordered[targetSeat]] = [ordered[targetSeat], ordered[ownerSeat]]
    applySeatPermutation(host.state, ordered)
    host.dispatch('SeatOrderChanged', { reason: B48_JINCUI, playerIds: ordered }, { sourceId: ownerId, targetId: target.id })
    const loss = owner.hp - (owner.marks[B48_ZHENTING_COUNT] ?? 0)
    if (loss > 0) {
      loseHp(host as never, ownerId, loss, B48_JINCUI)
      return
    }
    gainMaxHp(host as never, ownerId, 1, B48_JINCUI)
    owner.marks[B48_ZHENTING_NO_BACKWATER] = 1
  },
})

export const B48_JIANGWAN_GAI: CharacterDefinition = {
  id: 'jiangwan-gai-b48', name: '蒋琬·改', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: B48_ZHENTING, name: '镇庭', description: '每名角色的回合限一次，当你或你攻击范围内的一名角色成为【杀】或延时锦囊牌的目标时，若你不是此牌的使用者，你可以选择一项：1.弃置此牌使用者的一张手牌；2.摸一张牌。背水：你代替其成为此牌的目标。' },
    { id: B48_JINCUI, name: '尽瘁', description: '限定技，出牌阶段，你可以与一名其他角色交换位置，然后你失去X点体力（X为你当前体力值-本局游戏发动技能“镇庭”的次数），若你未因此失去体力，你加1点体力上限，然后失去技能“镇庭”中的背水选项。' },
  ],
}

const B48_XIAYUAN_USED = `${B48_XIAYUAN}:round`

registerSkillRuntime({
  id: B48_XIAYUAN,
  triggers: [{ event: 'AfterDamage', handle(host, ownerId, context) {
    const damage = context.event.payload as { armorLost?: number; armorAfter?: number }
    const targetId = context.event.targetId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || targetId === ownerId || (damage.armorLost ?? 0) <= 0
      || damage.armorAfter !== 0 || owner.marks[B48_XIAYUAN_USED] === host.state.roundNumber
      || owner.zones.hand.length < 2 || !playerOf(host.state, targetId)?.alive) return
    host.queueSkill({ skillId: B48_XIAYUAN, ownerId, step: 'cost', data: {
      targetId, armorLost: damage.armorLost, round: host.state.roundNumber,
    } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'cost') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    const targetId = prompt.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (!target?.alive || (target.armorPoints ?? 0) !== 0) return
    host.askSkill({ skillId: B48_XIAYUAN, ownerId, step: 'cost', data: prompt.data,
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: `【狭援】：弃置两张手牌，令${target.nickname}获得本次失去的${prompt.data.armorLost as number}点护甲`,
        timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 2 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cost') return
    const owner = playerOf(host.state, ownerId)
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const ids = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
    const amount = resolution.data.armorLost as number
    if (!owner?.alive || !target?.alive || ids.length !== 2 || ids.some((id) => !owner.zones.hand.includes(id))
      || (target.armorPoints ?? 0) !== 0 || resolution.data.round !== host.state.roundNumber
      || owner.marks[B48_XIAYUAN_USED] === host.state.roundNumber) return
    for (const cardId of ids) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    owner.marks[B48_XIAYUAN_USED] = host.state.roundNumber
    gainArmor(host as never, targetId, amount, B48_XIAYUAN)
  },
})

registerSkillRuntime({
  id: B48_JIEYUE,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (phase.playerId !== ownerId || phase.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive) return
    host.queueSkill({ skillId: B48_JIEYUE, ownerId, step: 'target', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target' || !playerOf(host.state, ownerId)?.alive) return
    const candidates = host.state.players.filter((player) => player.alive && player.id !== ownerId)
    if (!candidates.length) return
    host.askSkill({ skillId: B48_JIEYUE, ownerId, step: 'target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【节钺】：选择一名其他角色，其获得1点护甲后可以交给你一张牌', timeoutMs: 20_000,
        optional: true, candidateIds: candidates.map((player) => player.id), min: 0, max: 1 }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.id === ownerId) return
      gainArmor(host as never, target.id, 1, B48_JIEYUE)
      const pickable = pickableCardsOf(host.state, target.id)
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: B48_JIEYUE, ownerId, step: 'give', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: target.id,
          prompt: `【节钺】：是否交给${playerOf(host.state, ownerId)?.nickname ?? '于禁'}一张牌？`, timeoutMs: 20_000,
          optional: true, purpose: 'skill', ...pickable, min: 0, max: 1 }) })
      return
    }
    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const card = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = card ? resolvePickedCard(host.state, targetId, card) : null
      if (target?.alive && playerOf(host.state, ownerId)?.alive && cardId
        && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: B48_JIEYUE },
          { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: B48_JIEYUE },
          { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('CardGiven', { fromPlayerId: targetId, toPlayerId: ownerId, cardIds: [cardId], reason: B48_JIEYUE },
          { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
})

registerSkillRuntime({
  id: B48_YANGWEI,
  globalSlashUses(state, ownerId, targetId) {
    const owner = playerOf(state, ownerId)
    return ownerId === targetId && state.phase === 'play' && state.currentPlayerId === ownerId
      && owner?.marks[B48_WEI_MARK] === 1 ? 1 : 0
  },
  slashIgnoresDistance(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId
      && playerOf(state, ownerId)?.marks[B48_WEI_MARK] === 1
  },
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId; targetIds?: PlayerId[] }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId
        || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
        || playerOf(host.state, ownerId)?.marks[B48_WEI_MARK] !== 1) return
      for (const targetId of payload.targetIds ?? []) {
        suppressArmorForCard(host.state, ownerId, targetId, payload.cardId, B48_YANGWEI)
      }
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.sourceId === ownerId && payload.cardId)
        clearArmorSuppressionForCard(host.state, ownerId, payload.cardId)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (phase.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      if (phase.phase === 'play') delete owner.marks[B48_WEI_MARK]
      if (phase.phase === 'finish' && typeof owner.marks[B48_YANGWEI_DISABLED] === 'number'
        && host.state.turnNumber > owner.marks[B48_YANGWEI_DISABLED]) delete owner.marks[B48_YANGWEI_DISABLED]
    } },
  ],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return state.phase === 'play' && state.currentPlayerId === ownerId && owner?.alive
      && !usedThisPhase(state, ownerId, B48_YANGWEI) && (owner.marks[B48_WEI_MARK] ?? 0) === 0
      && owner.marks[B48_YANGWEI_DISABLED] === undefined
      ? [{ id: B48_YANGWEI, label: '扬威：摸两张牌并获得“威”' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== B48_YANGWEI || usedThisPhase(host.state, ownerId, B48_YANGWEI)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (owner.marks[B48_WEI_MARK] ?? 0) > 0) return
    markUsedThisPhase(host.state, ownerId, B48_YANGWEI)
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => host.dispatch(name, payload))
    owner.marks[B48_WEI_MARK] = 1
    owner.marks[B48_YANGWEI_DISABLED] = host.state.turnNumber
  },
})

export const B48_MOU_YUJIN: CharacterDefinition = {
  id: 'mou-yujin-b48', name: '谋·于禁', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: B48_XIAYUAN, name: '狭援', description: '每轮限一次，其他角色受到伤害后，若此伤害令其失去全部“护甲”，则你可以弃置两张手牌，令其获得本次伤害失去的护甲。' },
    { id: B48_JIEYUE, name: '节钺', description: '结束阶段，你可以选择一名其他角色并令其获得1点“护甲”，然后其可以交给你一张牌。' },
  ],
}

export const B48_MOU_HUAXIONG: CharacterDefinition = {
  id: 'mou-huaxiong-b48', name: '谋·华雄', kingdom: 'qun', gender: 'male', maxHp: 6, pack: 'standard',
  skills: [
    { id: B48_YAOWU, name: '耀武', description: '锁定技，当你受到【杀】造成的伤害时，若此【杀】为红色，伤害来源回复1点体力或摸一张牌；若此【杀】不为红色，则你摸一张牌。' },
    { id: B48_YANGWEI, name: '扬威', description: '出牌阶段限一次，你可以摸两张牌并获得“威”标记直到此阶段结束，然后此技能失效直到下个回合的结束阶段。拥有“威”标记的角色出牌阶段可以额外使用一张【杀】、使用【杀】无距离限制且无视防具。' },
  ],
}

export const B48_MOU_LVMENG: CharacterDefinition = {
  id: 'mou-lvmeng-b48', name: '谋·吕蒙', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: B48_KEXI, name: '克己', description: '出牌阶段各限一次（若你已发动过“渡江”，则修改为出牌阶段限一次），你可以选择一项执行对应效果：1.弃置一张手牌，获得1点“护甲”；2.流失1点体力，获得2点护甲。你的手牌上限+X（X为你的护甲值）。若你不处于濒死状态，你无法使用【桃】。' },
    { id: B48_DUJIANG, name: '渡江', description: '觉醒技，准备阶段，若你的“护甲”值不少于3，则获得技能“夺荆”。' },
    { id: B48_DUOJING, name: '夺荆', granted: true, description: '你使用【杀】指定一名其他角色为目标后，你可以失去1点护甲，令此【杀】无视防具，然后你获得其一张手牌，并且本阶段可以额外使用一次【杀】。' },
  ],
}

registerSkillRuntime({
  id: B48_KEXI,
  maxCardsBonus(state, ownerId) { return playerOf(state, ownerId)?.armorPoints ?? 0 },
  prohibitsCardUse(_state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '桃' && context.dyingPlayerId !== ownerId
  },
  prohibitsOwnResponse(state, ownerId, cardName) {
    return cardName === '桃' && state.dying?.playerId !== ownerId
  },
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !owner?.alive) return []
    const awakened = owner.awakenedSkills?.includes(B48_DUJIANG) ?? false
    const alreadyUsed = awakened
      ? usedThisPhase(state, ownerId, B48_KEXI)
      : usedThisPhase(state, ownerId, `${B48_KEXI}:discard`) && usedThisPhase(state, ownerId, `${B48_KEXI}:health`)
    return alreadyUsed ? [] : [{ id: B48_KEXI, label: '克己：弃置手牌或失去体力获得护甲' }]
  },
  invokeActive(host, ownerId, actionId) {
    const owner = playerOf(host.state, ownerId)
    if (actionId !== B48_KEXI || !owner?.alive) return
    const awakened = owner.awakenedSkills?.includes(B48_DUJIANG) ?? false
    const options = [
      ...(owner.zones.hand.length && (awakened || !usedThisPhase(host.state, ownerId, `${B48_KEXI}:discard`))
        ? [{ id: 'discard', label: '弃置一张手牌，获得1点护甲' }] : []),
      ...(owner.hp > 0 && (awakened || !usedThisPhase(host.state, ownerId, `${B48_KEXI}:health`))
        ? [{ id: 'health', label: '失去1点体力，获得2点护甲' }] : []),
    ]
    if (!options.length) return
    host.askSkill({ skillId: B48_KEXI, ownerId, step: 'mode', data: { awakened },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【克己】：选择获得护甲的方式', timeoutMs: 20_000, optional: false, options }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const current = playerOf(host.state, ownerId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!current?.alive || !cardId || !current.zones.hand.includes(cardId)) return
      const hasAwakened = current.awakenedSkills?.includes(B48_DUJIANG) ?? false
      if (hasAwakened) markUsedThisPhase(host.state, ownerId, B48_KEXI)
      else markUsedThisPhase(host.state, ownerId, `${B48_KEXI}:discard`)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      gainArmor(host as never, ownerId, 1, B48_KEXI)
      return
    }
    if (resolution.step !== 'mode') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const mode = (response.payload as { optionId?: string }).optionId
    const awakened = owner.awakenedSkills?.includes(B48_DUJIANG) ?? false
    if (mode === 'discard') {
      if (!owner.zones.hand.length || (!awakened && usedThisPhase(host.state, ownerId, `${B48_KEXI}:discard`))) return
      host.askSkill({ skillId: B48_KEXI, ownerId, step: 'discard', data: {},
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【克己】：弃置一张手牌', timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (mode === 'health' && owner.hp > 0 && (awakened || !usedThisPhase(host.state, ownerId, `${B48_KEXI}:health`))) {
      if (awakened) markUsedThisPhase(host.state, ownerId, B48_KEXI)
      else markUsedThisPhase(host.state, ownerId, `${B48_KEXI}:health`)
      loseHp(host as never, ownerId, 1, B48_KEXI)
      if (playerOf(host.state, ownerId)?.alive) gainArmor(host as never, ownerId, 2, B48_KEXI)
      return
    }
  },
})

registerSkillRuntime({
  id: B48_DUJIANG,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) { return (playerOf(state, ownerId)?.armorPoints ?? 0) >= 3 },
    invoke(host, ownerId) { grantSkill(host.state, ownerId, B48_DUOJING) },
  },
})

registerSkillRuntime({
  id: B48_DUOJING,
  globalSlashUses(state, ownerId, targetId) {
    return ownerId === targetId && state.phase === 'play' ? playerOf(state, ownerId)?.marks[B48_DUOJING_USES] ?? 0 : 0
  },
  triggers: [
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      if (cardId) clearArmorSuppressionForCard(host.state, ownerId, cardId)
    } },
    { event: 'PhaseEnd', handle(host, ownerId, context) {
      const phase = context.event.payload as { playerId?: PlayerId; phase?: string }
      const owner = playerOf(host.state, ownerId)
      if (phase.playerId === ownerId && phase.phase === 'play' && owner) delete owner.marks[B48_DUOJING_USES]
    } },
  ],
  interceptSourceTargetEach(host, ownerId, context: TargetedCardContext) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || context.cardName !== '杀' || (owner.armorPoints ?? 0) <= 0) return false
    host.askSkill({ skillId: B48_DUOJING, ownerId, step: 'activate', data: { cardId: context.cardId, targetId: context.targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【夺荆】：是否失去1点护甲令此【杀】无视防具，并获得目标一张手牌？',
        timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '发动夺荆' }, { id: 'no', label: '不发动' }] }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'activate') {
      const owner = playerOf(host.state, ownerId)
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cardId = resolution.data.cardId as CardId
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive || !target?.alive
        || (owner.armorPoints ?? 0) <= 0 || !host.state.zones.processingArea.includes(cardId)) {
        host.resumeCardTarget()
        return
      }
      loseArmor(host as never, ownerId, 1, B48_DUOJING)
      suppressArmorForCard(host.state, ownerId, targetId, cardId, B48_DUOJING)
      owner.marks[B48_DUOJING_USES] = (owner.marks[B48_DUOJING_USES] ?? 0) + 1
      if (!target.zones.hand.length) { host.resumeCardTarget(); return }
      const hidden = pickableCardsOf(host.state, targetId).hiddenCardSlots
      host.askSkill({ skillId: B48_DUOJING, ownerId, step: 'take-card', data: { targetId, cardId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【夺荆】：获得${target.nickname}的一张手牌`, timeoutMs: 20_000,
          optional: false, purpose: 'skill', cardIds: [], hiddenCardSlots: hidden, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'take-card') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
      if (playerOf(host.state, ownerId)?.alive && target?.alive && cardId && target.zones.hand.includes(cardId)
        && movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: B48_DUOJING },
          { sourceId: ownerId, targetId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: B48_DUOJING },
          { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: B48_ZHANGREN_FENGSHI,
  interceptBystanderTarget(host, ownerId, context: TargetedCardContext) {
    const target = playerOf(host.state, context.targetId)
    if (context.cardName !== '杀' || !target?.alive
      || !isInFactionEncirclement(host.state, ownerId, context.sourceId, context.targetId)
      || !pickableCardsOf(host.state, context.targetId, { discarderId: ownerId }).cardIds.length) return false
    host.askSkill({ skillId: B48_ZHANGREN_FENGSHI, ownerId, step: 'invoke', data: { targetId: context.targetId, sourceId: context.sourceId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【锋矢】：是否令${target.nickname}弃置装备区里的一张牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动锋矢' }, { id: 'no', label: '不发动' }] }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      const targetId = resolution.data.targetId as PlayerId
      const sourceId = resolution.data.sourceId as PlayerId
      const target = playerOf(host.state, targetId)
      const pickable = pickableCardsOf(host.state, targetId, { discarderId: ownerId })
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !target?.alive
        || !isInFactionEncirclement(host.state, ownerId, sourceId, targetId) || !pickable.cardIds.length) {
        host.resumeCardTarget()
        return
      }
      host.askSkill({ skillId: B48_ZHANGREN_FENGSHI, ownerId, step: 'discard', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: targetId,
          prompt: '【锋矢】：弃置装备区里的一张牌', timeoutMs: 20_000, optional: false, purpose: 'skill',
          cardIds: pickable.cardIds, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = picked ? resolvePickedCard(host.state, targetId, picked) : null
    const legalIds = pickableCardsOf(host.state, targetId, { discarderId: ownerId }).cardIds
    if (target?.alive && cardId && legalIds.includes(cardId)
      && movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) {
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: B48_ZHANGREN_FENGSHI },
        { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
    host.resumeCardTarget()
  },
})

registerSkillRuntime({
  id: B48_ZHANGREN_CHUANXIN,
  offersGlobalDamagePreventionAsk(host, ownerId, context: DamagePreventionContext) {
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive || context.sourceId !== ownerId
      || host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || !['杀', '决斗'].includes(context.cardName ?? '')
      || !target.deputyCharacterId
      || !revealedGeneralFactionOf(owner) || !revealedGeneralFactionOf(target)
      || revealedGeneralFactionOf(owner) === revealedGeneralFactionOf(target)) return false
    host.queueSkill({ skillId: B48_ZHANGREN_CHUANXIN, ownerId, step: 'invoke', data: {
      targetId: target.id, cardName: context.cardName,
    } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'choice') {
      const target = playerOf(host.state, ownerId)
      if (!target?.alive || !target.deputyCharacterId) return
      const equipment = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
      host.askSkill({ skillId: B48_ZHANGREN_CHUANXIN, ownerId, step: 'choice', data: prompt.data,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【穿心】：选择一项', timeoutMs: 20_000, optional: false, options: [
            ...(equipment.length ? [{ id: 'discard-equipment', label: '弃置装备区里的所有牌并失去1点体力' }] : []),
            { id: 'remove-deputy', label: '移除副将' },
          ] }) })
      return
    }
    if (prompt.step !== 'invoke') return
    const target = playerOf(host.state, prompt.data.targetId as PlayerId)
    if (!target?.alive || !target.deputyCharacterId) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    host.askSkill({ skillId: B48_ZHANGREN_CHUANXIN, ownerId, step: 'invoke', data: prompt.data,
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【穿心】：是否防止对${target.nickname}造成的${String(prompt.data.cardName)}伤害？`, timeoutMs: 20_000,
        optional: true, options: [{ id: 'yes', label: '防止伤害并令其选择' }, { id: 'no', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const target = playerOf(host.state, targetId)
    if (resolution.step === 'invoke') {
      const yes = (response.payload as { optionId?: string }).optionId === 'yes'
      if (!yes || !playerOf(host.state, ownerId)?.alive || !target?.alive || !target.deputyCharacterId
        || !revealedGeneralFactionOf(playerOf(host.state, ownerId)!)
        || revealedGeneralFactionOf(playerOf(host.state, ownerId)!) === revealedGeneralFactionOf(target)) {
        resumeTargetDamagePrevention(host as never, false)
        return
      }
      host.queueSkill({ skillId: B48_ZHANGREN_CHUANXIN, ownerId: targetId, step: 'choice', data: { targetId, attackerId: ownerId } })
      resumeTargetDamagePrevention(host as never, true, B48_ZHANGREN_CHUANXIN)
      return
    }
    if (resolution.step !== 'choice' || !target?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'discard-equipment') {
      const equipment = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
      if (!equipment.length) return
      for (const cardId of equipment) {
        const from = locateOwnedCard(host.state, targetId, cardId)
        if (from?.kind !== 'equipment') continue
        moveCard(host.state, cardId, from, { kind: 'discardPile' }, { discardReason: 'other' })
        handleEquipmentLost(host as never, targetId, cardId)
      }
      if (equipment.every((cardId) => host.state.zones.discardPile.includes(cardId)))
        loseHp(host as never, targetId, 1, B48_ZHANGREN_CHUANXIN)
      return
    }
    if (optionId === 'remove-deputy' && target.deputyCharacterId) {
      target.deputyCharacterId = null
      target.deputyGeneralRevealed = false
      host.dispatch('GeneralSlotChanged', { playerId: targetId, slot: 'deputy', characterId: null, revealed: false,
        reason: B48_ZHANGREN_CHUANXIN }, { sourceId: resolution.data.attackerId as PlayerId, targetId })
    }
  },
})

export const B48_ZHANGREN: CharacterDefinition = {
  id: 'zhangren-b48', name: '张任', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'standard',
  skills: [
    { id: B48_ZHANGREN_CHUANXIN, name: '穿心', description: '当你于出牌阶段内使用【杀】或【决斗】对与你势力不同且有副将的角色造成伤害时，你可以防止此伤害并令其选择一项：弃置装备区里的所有牌（至少一张）并失去1点体力，或移除副将。' },
    { id: B48_ZHANGREN_FENGSHI, name: '锋矢', description: '阵法技，在同一个围攻关系中，若你是围攻角色，则你或另一名围攻角色使用【杀】指定被围攻角色为目标后，可令其弃置装备区里的一张牌。' },
  ],
}

const B48_JIE_ZHOUCANG_EXTRA_SLASH = `${B48_JIE_ZHOUCANG_ZHONGYONG}:extra-slash`
const B48_JIE_ZHOUCANG_NEXT_DAMAGE = `${B48_JIE_ZHOUCANG_ZHONGYONG}:next-slash-damage`

registerSkillRuntime({
  id: B48_JIE_ZHOUCANG_ZHONGYONG,
  triggers: [
    { event: 'CardResponded', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId; slashCardId?: CardId }
      if (context.event.targetId !== ownerId || payload.cardName !== '闪' || !payload.slashCardId) return
      host.state.zhongyongDodgeCards ??= {}
      const entry = host.state.zhongyongDodgeCards[payload.slashCardId] ?? { cardIds: [], responded: false }
      entry.responded = true
      if (payload.cardId && !entry.cardIds.includes(payload.cardId)) entry.cardIds.push(payload.cardId)
      host.state.zhongyongDodgeCards[payload.slashCardId] = entry
    } },
    { event: 'CardUsed', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId }
      const owner = playerOf(host.state, ownerId)
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId
        || !owner || (owner.marks[B48_JIE_ZHOUCANG_NEXT_DAMAGE] ?? 0) < 1) return
      host.state.slashDamageBonusCards ??= {}
      host.state.slashDamageBonusCards[payload.cardId] = { sourceId: ownerId, amount: 1, turnNumber: host.state.turnNumber }
      owner.marks[B48_JIE_ZHOUCANG_NEXT_DAMAGE] = 0
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; cardId?: CardId }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.cardId) return
      if (host.state.slashDamageBonusCards?.[payload.cardId]?.sourceId === ownerId) {
        delete host.state.slashDamageBonusCards[payload.cardId]
      }
      const dodgeEntry = host.state.zhongyongDodgeCards?.[payload.cardId]
      if (host.state.zhongyongDodgeCards) delete host.state.zhongyongDodgeCards[payload.cardId]
      if (host.state.phase !== 'play') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const dodgeIds = [...new Set(dodgeEntry?.cardIds ?? [])]
        .filter((cardId) => host.state.zones.discardPile.includes(cardId))
      const slashAvailable = host.state.zones.discardPile.includes(payload.cardId)
      if (!dodgeEntry?.responded) {
        if (slashAvailable) host.queueSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'no-dodge', data: { slashCardId: payload.cardId } })
      } else if (dodgeIds.length) {
        host.queueSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'branch',
          data: { slashCardId: slashAvailable ? payload.cardId : null, dodgeIds } })
      }
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const turn = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const owner = playerOf(host.state, ownerId)
      if (turn.playerId !== ownerId || !owner) return
      delete owner.marks[B48_JIE_ZHOUCANG_EXTRA_SLASH]
      delete owner.marks[B48_JIE_ZHOUCANG_NEXT_DAMAGE]
    } },
  ],
  globalSlashUses(state, ownerId, targetId) {
    return ownerId === targetId && state.currentPlayerId === ownerId
      && playerOf(state, ownerId)?.marks[B48_JIE_ZHOUCANG_EXTRA_SLASH] === state.turnNumber ? 1 : 0
  },
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'no-dodge') {
      const slashCardId = prompt.data.slashCardId as CardId
      if (!host.state.zones.discardPile.includes(slashCardId)) return
      host.askSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'gain-slash', data: { slashCardId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【忠勇】：可获得此【杀】；通过此技能获得的牌本回合不能使用', timeoutMs: 20_000,
          optional: true, purpose: 'skill', cardIds: [slashCardId], hiddenCardSlots: [], min: 0, max: 1 }) })
      return
    }
    if (prompt.step === 'branch') {
      const dodgeIds = (prompt.data.dodgeIds as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
      if (!dodgeIds.length) return
      const slashCardId = prompt.data.slashCardId as CardId | null
      const recipients = host.state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)
      const options = [
        { id: 'take-dodge', label: slashCardId ? '获得一张【闪】，然后可将此【杀】交给其他角色' : '获得一张【闪】' },
        ...(recipients ? [{ id: 'give-dodge', label: '将一张【闪】交给其他角色，本回合出杀次数+1且下一张杀伤害+1' }] : []),
        { id: 'no', label: '不发动' },
      ]
      host.askSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'branch', data: prompt.data,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【忠勇】：选择一项', timeoutMs: 20_000, optional: true, options }) })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const slashCardId = resolution.data.slashCardId as CardId | null
    if (resolution.step === 'gain-slash') {
      const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (selected !== slashCardId || !slashCardId || !host.state.zones.discardPile.includes(slashCardId)) return
      moveCard(host.state, slashCardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      lockCardUseUntilTurnEnd(host.state, { targetId: ownerId, cardId: slashCardId, sourceId: ownerId, skillId: B48_JIE_ZHOUCANG_ZHONGYONG })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [slashCardId], reason: B48_JIE_ZHOUCANG_ZHONGYONG }, { sourceId: ownerId, targetId: ownerId, cardIds: [slashCardId] })
      return
    }
    if (resolution.step === 'branch') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const dodgeIds = (resolution.data.dodgeIds as CardId[]).filter((cardId) => host.state.zones.discardPile.includes(cardId))
      if (optionId === 'no' || !dodgeIds.length) return
      const step = optionId === 'take-dodge' ? 'take-dodge' : optionId === 'give-dodge' ? 'pick-give-dodge' : null
      if (!step) return
      host.askSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step, data: resolution.data,
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: optionId === 'take-dodge' ? '【忠勇】：选择一张本次响应的【闪】获得' : '【忠勇】：选择一张本次响应的【闪】交给其他角色',
          timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: dodgeIds, hiddenCardSlots: [], min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'take-dodge' || resolution.step === 'pick-give-dodge') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const candidates = (resolution.data.dodgeIds as CardId[]).filter((id) => host.state.zones.discardPile.includes(id))
      if (!cardId || !candidates.includes(cardId)) return
      if (resolution.step === 'take-dodge') {
        moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
        lockCardUseUntilTurnEnd(host.state, { targetId: ownerId, cardId, sourceId: ownerId, skillId: B48_JIE_ZHOUCANG_ZHONGYONG })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: B48_JIE_ZHOUCANG_ZHONGYONG }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
        const slashId = resolution.data.slashCardId as CardId | null
        if (!slashId || !host.state.zones.discardPile.includes(slashId)) return
        const recipients = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (!recipients.length) return
        host.askSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'give-slash', data: { slashCardId: slashId },
          build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
            prompt: '【忠勇】：可将此【杀】交给一名其他角色（本回合不能使用）', timeoutMs: 20_000,
            optional: true, candidateIds: recipients, min: 0, max: 1 }) })
        return
      }
      const recipients = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.askSkill({ skillId: B48_JIE_ZHOUCANG_ZHONGYONG, ownerId, step: 'give-dodge', data: { cardId },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【忠勇】：将此【闪】交给一名其他角色（本回合不能使用）', timeoutMs: 20_000,
          optional: false, candidateIds: recipients, min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'give-slash' || resolution.step === 'give-dodge') {
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      const cardId = resolution.step === 'give-slash' ? resolution.data.slashCardId as CardId : resolution.data.cardId as CardId
      if (resolution.step === 'give-slash' && !recipientId) return
      if (!recipient?.alive || recipient.id === ownerId || !host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: recipient.id })
      lockCardUseUntilTurnEnd(host.state, { targetId: recipient.id, cardId, sourceId: ownerId, skillId: B48_JIE_ZHOUCANG_ZHONGYONG })
      host.dispatch('GainCard', { playerId: recipient.id, cardIds: [cardId], reason: B48_JIE_ZHOUCANG_ZHONGYONG }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
      host.dispatch('CardGiven', { fromPlayerId: ownerId, toPlayerId: recipient.id, cardIds: [cardId], reason: B48_JIE_ZHOUCANG_ZHONGYONG }, { sourceId: ownerId, targetId: recipient.id, cardIds: [cardId] })
      if (resolution.step === 'give-dodge') {
        owner.marks[B48_JIE_ZHOUCANG_EXTRA_SLASH] = host.state.turnNumber
        owner.marks[B48_JIE_ZHOUCANG_NEXT_DAMAGE] = 1
      }
    }
  },
})

export const B48_JIE_ZHOUCANG: CharacterDefinition = {
  id: 'jie-zhoucang-b48', name: '界·周仓', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [{ id: B48_JIE_ZHOUCANG_ZHONGYONG, name: '忠勇', description: '当你于出牌阶段使用【杀】结算结束后，若目标没有使用【闪】响应过此【杀】，你可以获得此【杀】；若其使用过【闪】响应，你可以选择一项：1.你获得一张响应的【闪】，然后你可以将此【杀】交给一名其他角色；2.将一张响应的【闪】交给一名其他角色，然后你本回合使用【杀】的次数上限+1，且下一张使用的【杀】造成的伤害+1。你通过此技能获得的牌本回合不能使用。' }],
}

export const HISTORICAL_BATCH48_CHARACTERS: readonly CharacterDefinition[] = [
  B48_CAI_ZHENJI,
  B48_ZHANG_ZHONGJING,
  B48_CUI_YAN,
  B48_MAO_JIE,
  B48_MOU_YUJIN,
  B48_MOU_HUAXIONG,
  B48_MOU_LVMENG,
  B48_JIE_ZHOUCANG,
  B48_JIANGWAN_GAI,
  B48_JIE_GUYONG,
]
