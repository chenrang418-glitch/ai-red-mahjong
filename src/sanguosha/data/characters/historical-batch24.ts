import { drawCards, revealTopCards } from '../../engine/draw'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { getAttackRange, getDistance } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { maxCardsOf } from '../../engine/phase'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { registerPindianContinuation, startPindian } from '../../engine/pindian'
import { skipPhase } from '../../engine/turn'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 历史人物第二十四批。只登记本批十名独立人物；不混入界、谋、族、星、势、闪、魔版本。
 * 这里优先复用现有运行时的 viewAs、阶段触发、伤害与移动接口。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function aliveOthers(state: SanguoshaState, ownerId: PlayerId) {
  return state.players.filter((player) => player.alive && player.id !== ownerId)
}

type Batch24State = SanguoshaState & {
  yechouTargets?: Record<PlayerId, PlayerId>
  yechouExpiry?: Record<PlayerId, number>
  fumanTags?: Record<PlayerId, { ownerId: PlayerId; cardId: CardId }>
  xizhengLastTargets?: Record<PlayerId, PlayerId[]>
  xizhengWencanTargets?: Record<PlayerId, Record<PlayerId, number>>
  qiaozhouShiming?: { ownerId: PlayerId; turnOwnerId: PlayerId; cards: CardId[] }
  yanghongPending?: { ownerId: PlayerId; targetIds: PlayerId[]; index: number; discarded: CardId[] }
  sunliangPlayCardUses?: Record<PlayerId, number>
}

const NILUAN = 'niluan'
const WEIWEI = 'weiwei'
registerSkillRuntime({
  id: NILUAN,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || payload.cancelled || !payload.cardId) return
      const card = host.state.cards[payload.cardId]
      if (!card || card.virtual || card.name === '杀' || card.color !== 'black') return
      if (cardDamageDealt(host.state, payload.cardId) > 0) return
      host.state.turnUsage.slashUses = Math.max(0, host.state.turnUsage.slashUses - 1)
      host.state.turnUsage.slashUsesThisTurn = Math.max(0, (host.state.turnUsage.slashUsesThisTurn ?? 1) - 1)
    },
  }],
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner || state.phase !== 'play') return []
    return owner.zones.hand
      .filter((id) => state.cards[id]?.color === 'black')
      .map((cardId) => ({ asCardName: '杀', cardId, label: '逆乱：当【杀】使用' }))
  },
})
registerSkillRuntime({
  id: WEIWEI,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner || state.phase !== 'play' || usedThisTurn(state, ownerId, WEIWEI)) return []
    return owner.zones.hand
      .filter((id) => state.cards[id]?.color === 'red')
      .map((cardId) => ({ asCardName: '顺手牵羊', cardId, label: '违忤：当【顺手牵羊】使用' }))
  },
  ignoresDistanceTo(state, ownerId, targetId, cardId) {
    return targetId !== ownerId && Boolean(cardId && state.cards[cardId]?.color === 'red' && !usedThisTurn(state, ownerId, WEIWEI))
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
      if (context.event.sourceId !== ownerId || payload.cardName !== '顺手牵羊' || payload.cancelled || !payload.cardId) return
      if (host.state.cards[payload.cardId]?.color === 'red') markUsedThisTurn(host.state, ownerId, WEIWEI)
    },
  },
  ],
})

const KUIZHU = 'kuizhu'
registerSkillRuntime({
  id: KUIZHU,
  triggers: [{
    event: 'CardMove',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { sourcePlayerId?: PlayerId; reason?: string; cardIds?: CardId[]; originalZone?: string }
      if (host.state.phase !== 'discard' || payload.reason !== 'discard' || payload.sourcePlayerId !== ownerId || payload.originalZone !== 'hand') return
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.kuizhuDiscardCount = (owner.marks.kuizhuDiscardCount ?? 0) + (payload.cardIds?.length ?? 0)
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const owner = playerOf(host.state, ownerId)
      if (payload.phase === 'discard' && payload.playerId === ownerId) {
        if (owner) owner.marks.kuizhuDiscardCount = 0
        return
      }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (!owner?.alive || owner.marks.kuizhuDiscardCount === 0) return
      host.queueSkill({ skillId: KUIZHU, ownerId, step: 'mode', data: { x: owner.marks.kuizhuDiscardCount } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mode') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { x } = prompt.data as { x: number }
    host.askSkill({
      skillId: KUIZHU, ownerId, step: 'mode', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `【溃诛】：选择一项（X=${(prompt.data as { x: number }).x}）`, timeoutMs: 20_000, optional: true,
        options: [...(x > 0 ? [{ id: 'draw', label: '令至多X名角色各摸一张牌' }] : []), ...(x > 0 ? [{ id: 'damage', label: '对体力合计为X的角色各造成1点伤害' }] : []), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw' || resolution.step === 'damage') {
      const { x } = resolution.data as { x: number }
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const targets = targetIds.map((id) => playerOf(host.state, id)).filter((player): player is NonNullable<typeof player> => Boolean(player?.alive))
      if (resolution.step === 'draw') {
        for (const target of targets) drawCards(host.state, host.rng, target.id, 1, (name, data) => host.dispatch(name, data))
        return
      }
      if (targets.length < 2 || targets.reduce((sum, target) => sum + target.hp, 0) !== x) return
      for (const target of targets) resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal', cardName: null })
      if (targets.length >= 2) loseHp(host as never, ownerId, 1, KUIZHU)
      return
    }
    if (resolution.step !== 'mode') return
    const { x } = resolution.data as { x: number }
    const mode = (response.payload as { optionId?: string }).optionId
    if (mode !== 'draw' && mode !== 'damage') return
    const candidates = aliveOthers(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: KUIZHU, ownerId, step: mode, data: { x },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: mode === 'draw' ? `【溃诛】：选择至多${x}名角色` : `【溃诛】：选择角色（体力合计必须为${x}）`, timeoutMs: 20_000,
        optional: false, candidateIds: candidates.map((player) => player.id), min: mode === 'draw' ? 0 : 2, max: mode === 'draw' ? Math.min(x, candidates.length) : candidates.length,
      }),
    })
  },
})

const CHEZHENG = 'chezheng'
registerSkillRuntime({
  id: CHEZHENG,
  prohibitsTarget(state, ownerId, sourceId) {
    if (state.phase !== 'play' || state.currentPlayerId !== sourceId) return false
    const owner = playerOf(state, ownerId)
    const source = playerOf(state, sourceId)
    if (!owner?.alive || !source?.alive || ownerId === sourceId) return false
    return getDistance(state, sourceId, ownerId) > getAttackRange(state, sourceId)
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const state = host.state as Batch24State
      state.sunliangPlayCardUses ??= {}
      if (payload.phase === 'play' && payload.playerId === ownerId) state.sunliangPlayCardUses[ownerId] = 0
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const candidates = aliveOthers(host.state, ownerId).filter((player) => getDistance(host.state, player.id, ownerId) > getAttackRange(host.state, player.id) && player.zones.hand.length + Object.values(player.zones.equipment).filter(Boolean).length > 0)
      const x = candidates.length
      const y = state.sunliangPlayCardUses[ownerId] ?? 0
      if (x === 0 || y >= x) return
      host.queueSkill({ skillId: CHEZHENG, ownerId, step: 'punish-target', data: { candidates: candidates.map((player) => player.id) } })
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      if (host.state.phase !== 'play' || context.event.sourceId !== ownerId) return
      const state = host.state as Batch24State
      state.sunliangPlayCardUses ??= {}
      state.sunliangPlayCardUses[ownerId] = (state.sunliangPlayCardUses[ownerId] ?? 0) + 1
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'punish-target') return
    const ids = (prompt.data as { candidates: PlayerId[] }).candidates.filter((id) => playerOf(host.state, id)?.alive)
    if (ids.length === 0) return
    host.askSkill({ skillId: CHEZHENG, ownerId, step: 'punish-target', data: {}, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【掣政】：选择一名攻击范围不包含你的角色弃置一张牌', timeoutMs: 20_000, optional: false, options: ids.map((id) => ({ id, label: playerOf(host.state, id)?.nickname ?? id })) }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'punish-card') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
      if (!target?.alive || !cardId || !from) return
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CHEZHENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }
    if (resolution.step !== 'punish-target') return
    const targetId = (response.payload as { optionId?: string }).optionId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    const ids = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))]
    if (ids.length === 0) return
    host.askSkill({ skillId: CHEZHENG, ownerId, step: 'punish-card', data: { targetId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: target.id, prompt: '【掣政】：选择一张牌弃置', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: ids, hiddenCardSlots: [], min: 1, max: 1 }) })
  },
})

const LIJUN = 'lijun'
registerSkillRuntime({
  id: LIJUN,
  lord: true,
  resolvedCardRecipient(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    const source = playerOf(state, context.sourceId)
    if (!owner?.alive || owner.identity !== 'lord' || context.cancelled || context.cardName !== '杀' || source?.id === ownerId || !source || effectiveKingdomOf(state, source.id) !== 'wu') return false
    if (usedThisPhase(state, source.id, LIJUN)) return false
    if (state.phase !== 'play') return false
    markUsedThisPhase(state, source.id, LIJUN)
    return true
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
      if (payload.cardName !== '杀' || payload.cancelled || context.event.sourceId === ownerId) return
      const source = context.event.sourceId
      const owner = playerOf(host.state, ownerId)
      const actor = source ? playerOf(host.state, source) : undefined
      if (!owner?.alive || !actor?.alive || !payload.cardId || effectiveKingdomOf(host.state, actor.id) !== 'wu') return
      if (host.state.phase !== 'play' || !owner.zones.hand.includes(payload.cardId)) return
      drawCards(host.state, host.rng, actor.id, 1, (name, data) => host.dispatch(name, data))
    },
  }],
})

const ZHANWEN = 'songshu'
const SIBIAN = 'sibian'
const ZHANWEN_TAG = 'batch24-songshu'
registerSkillRuntime({
  id: ZHANWEN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId || usedThisPhase(host.state, ownerId, ZHANWEN)) return
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && aliveOthers(host.state, ownerId).some((player) => player.zones.hand.length > 0)) host.queueSkill({ skillId: ZHANWEN, ownerId, step: 'target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = aliveOthers(host.state, ownerId).filter((player) => player.zones.hand.length > 0)
    if (candidates.length === 0) return
    host.askSkill({ skillId: ZHANWEN, ownerId, step: 'target', data: {}, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【颂蜀】：选择一名有手牌的角色拼点', timeoutMs: 20_000, optional: true, options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }] }) })
  },
  resume(host, ownerId, _resolution, response) {
    const targetId = (response.payload as { optionId?: string }).optionId
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!targetId || targetId === 'none' || !owner?.alive || !target?.alive || owner.zones.hand.length === 0 || target.zones.hand.length === 0) return
    markUsedThisPhase(host.state, ownerId, ZHANWEN)
    startPindian(host as never, { id: `songshu-${host.state.seq}`, initiatorId: ownerId, opponentId: target.id, reason: ZHANWEN, continuationTag: ZHANWEN_TAG, data: {} })
  },
})
registerPindianContinuation(ZHANWEN_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const owner = playerOf(host.state, result.initiatorId)
  const target = playerOf(host.state, result.opponentId)
  if (!owner?.alive) return
  if (result.outcome === 'initiator-win') {
    owner.turnUsedSkills = (owner.turnUsedSkills ?? []).filter((id) => !id.startsWith(`${ZHANWEN}@`))
  } else if (target?.alive) {
    drawCards(host.state, skillHost.rng, owner.id, 2, (name, data) => host.dispatch(name, data))
    drawCards(host.state, skillHost.rng, target.id, 2, (name, data) => host.dispatch(name, data))
  }
})
registerSkillRuntime({
  id: SIBIAN,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      context.cancel()
      host.askSkill({
        skillId: SIBIAN, ownerId, step: 'invoke', data: {},
        build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【思辩】：是否改为亮出牌堆顶四张牌？', timeoutMs: 20_000, optional: false, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动（正常摸两张）' }] }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      const turnOwnerId = (resolution.data as { turnOwnerId: PlayerId }).turnOwnerId
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        drawCards(host.state, host.rng, turnOwnerId, 2, (name, data) => host.dispatch(name, data))
        return
      }
      const top = revealTopCards(host.state, host.rng, 4, SIBIAN, (name, data) => host.dispatch(name, data))
      if (top.length === 0) return
      const ranks = top.map((id) => host.state.cards[id]?.rank ?? 0)
      const max = Math.max(...ranks)
      const min = Math.min(...ranks)
      const extreme = top.filter((id) => {
        const rank = host.state.cards[id]?.rank
        return rank === max || rank === min
      })
      const least = Math.min(...host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.zones.hand.length))
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length === least)
      host.askSkill({ skillId: SIBIAN, ownerId, step: 'target', data: { top, extreme }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【思辩】：选择手牌数最少的角色获得其余牌', timeoutMs: 20_000, optional: false, options: [...targets.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '其余牌置入弃牌堆' }] }) })
      return
    }
    if (resolution.step !== 'target') return
    const { top, extreme } = resolution.data as { top: CardId[]; extreme: CardId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const optionId = (response.payload as { optionId?: string }).optionId
    const target = optionId && optionId !== 'none' ? playerOf(host.state, optionId) : undefined
    for (const cardId of extreme) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    }
    const rest = top.filter((id) => !extreme.includes(id))
    if (target?.alive) {
      for (const cardId of rest) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: target.id })
    } else {
      for (const cardId of rest) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    }
  },
})

const BIAOZHAO = 'biaozhao'
const YECHOU = 'yechou'
registerSkillRuntime({
  id: BIAOZHAO,
  triggers: [{
    event: 'CardMove',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { destinationZone?: string; sourcePlayerId?: PlayerId; reason?: string; cardIds?: CardId[] }
      if (payload.destinationZone !== 'discardPile' || !payload.cardIds?.length) return
      const owner = playerOf(host.state, ownerId)
      const biaoId = owner?.characterPiles.biao?.[0]
      const biao = biaoId ? host.state.cards[biaoId] : undefined
      if (!owner?.alive || !biao) return
      const matched = payload.cardIds.some((id) => host.state.cards[id]?.suit === biao.suit && host.state.cards[id]?.rank === biao.rank)
      if (!matched || !biaoId) return
      const fromOtherDiscard = payload.reason === 'discard' && payload.sourcePlayerId && payload.sourcePlayerId !== ownerId
      if (fromOtherDiscard) {
        moveCard(host.state, biaoId, { kind: 'characterPile', playerId: ownerId, pile: 'biao' }, { kind: 'hand', playerId: payload.sourcePlayerId! })
      } else {
        moveCard(host.state, biaoId, { kind: 'characterPile', playerId: ownerId, pile: 'biao' }, { kind: 'discardPile' })
        loseHp(host as never, ownerId, 1, BIAOZHAO)
      }
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (payload.phase === 'finish' && owner.characterPiles.biao.length === 0 && owner.zones.hand.length > 0) host.queueSkill({ skillId: BIAOZHAO, ownerId, step: 'place', data: {} })
      if (payload.phase === 'prepare' && owner.characterPiles.biao.length > 0) host.queueSkill({ skillId: BIAOZHAO, ownerId, step: 'prepare-target', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'place') {
      host.askSkill({
        skillId: BIAOZHAO, ownerId, step: 'place', data: {},
        build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【表召】：将一张牌置于武将牌上作为“表”', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1 }),
      })
    } else if (prompt.step === 'prepare-target') {
      const candidates = aliveOthers(host.state, ownerId)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: BIAOZHAO, ownerId, step: 'prepare-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【表召】：选择一名角色回复并补牌', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'place') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: 'biao' })
      return
    }
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const cardId = owner.characterPiles.biao[0]
    if (!target?.alive || !cardId) return
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: 'biao' }, { kind: 'discardPile' })
    recover(host as never, target.id, 1, ownerId)
    const maxHand = Math.max(...host.state.players.filter((player) => player.alive).map((player) => player.zones.hand.length))
    drawCards(host.state, host.rng, target.id, Math.max(0, Math.min(5, maxHand) - target.zones.hand.length), (name, data) => host.dispatch(name, data))
  },
})
registerSkillRuntime({
  id: YECHOU,
  triggers: [{
    event: 'Death', allowDeadOwner: true,
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const candidates = aliveOthers(host.state, ownerId).filter((player) => player.maxHp - player.hp > 1)
      if (candidates.length > 0) host.queueSkill({ skillId: YECHOU, ownerId, step: 'target', data: {} })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, _context) {
      const state = host.state as Batch24State
      const targetId = state.yechouTargets?.[ownerId]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (target?.alive) loseHp(host as never, target.id, 1, YECHOU)
    },
  }, {
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const state = host.state as Batch24State
      const targetId = state.yechouTargets?.[ownerId]
      if (targetId && context.event.targetId === targetId) {
        delete state.yechouTargets?.[ownerId]
        delete state.yechouExpiry?.[ownerId]
      }
    },
  }],
  allowsDeadResponder: true,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidates = aliveOthers(host.state, ownerId).filter((player) => player.maxHp - player.hp > 1)
    if (candidates.length === 0) return
    host.askSkill({ skillId: YECHOU, ownerId, step: 'target', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【业仇】：选择一名已损失体力大于1的角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  resume(host, ownerId, _resolution, response) {
    const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
    if (!targetId) return
    const state = host.state as Batch24State
    state.yechouTargets ??= {}
    state.yechouExpiry ??= {}
    state.yechouTargets[ownerId] = targetId
    state.yechouExpiry[ownerId] = host.state.turnNumber
  },
})

const QUANJIAN = 'quanjian'
const TUJUE = 'tujue'
registerSkillRuntime({
  id: QUANJIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, QUANJIAN)) return []
    return aliveOthers(state, ownerId).length > 0 ? [{ id: 'quanjian-damage', label: '劝谏：令角色选择伤害目标' }, { id: 'quanjian-hand', label: '劝谏：令角色调整手牌' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'quanjian-damage' && actionId !== 'quanjian-hand') return
    markUsedThisPhase(host.state, ownerId, QUANJIAN)
    const candidates = aliveOthers(host.state, ownerId)
    host.askSkill({ skillId: QUANJIAN, ownerId, step: 'target-a', data: { actionId }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【劝谏】：选择一名角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, _ownerId, context) {
      const targetId = context.event.targetId
      const state = host.state as SanguoshaState & { handUseBlockedUntilTurnEnd?: Record<PlayerId, number> }
      if (targetId) delete state.handUseBlockedUntilTurnEnd?.[targetId]
    },
  }],
  incomingDamage(state, ownerId, context) {
    const player = playerOf(state, ownerId)
    if (player?.marks.quanjianNextDamage) {
      player.marks.quanjianNextDamage = 0
      return { amount: context.amount + 1 }
    }
    return null
  },
  resume(host, ownerId, resolution, response) {
    const actionId = (resolution.data as { actionId?: string }).actionId
    if (resolution.step === 'target-a') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      if (actionId === 'quanjian-hand') {
        const selectedTargetId = target.id
        host.askSkill({ skillId: QUANJIAN, ownerId, step: 'decide-hand', data: { targetId: selectedTargetId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: selectedTargetId, prompt: '【劝谏】：是否将手牌调整至手牌上限？', timeoutMs: 20_000, optional: false, options: [{ id: 'yes', label: '执行' }, { id: 'no', label: '拒绝' }] }) })
        return
      }
      const candidates = aliveOthers(host.state, target.id).filter((player) => getDistance(host.state, target.id, player.id) <= getAttackRange(host.state, target.id))
      if (candidates.length === 0) return
      host.askSkill({ skillId: QUANJIAN, ownerId, step: 'target-b', data: { targetId }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【劝谏】：为该角色指定攻击范围内的角色', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: 1 }) })
      return
    }
    if (resolution.step === 'target-b') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const victimId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!victimId) return
      host.askSkill({ skillId: QUANJIAN, ownerId, step: 'decide-damage', data: { targetId, victimId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: targetId, prompt: '【劝谏】：是否对指定角色造成1点伤害？', timeoutMs: 20_000, optional: false, options: [{ id: 'yes', label: '执行' }, { id: 'no', label: '拒绝' }] }) })
      return
    }
    if (resolution.step === 'decide-damage') {
      const { targetId, victimId } = resolution.data as { targetId: PlayerId; victimId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId === 'yes') resolveDamage(host as never, { sourceId: targetId, targetId: victimId, amount: 1, nature: 'normal', cardName: null })
      else {
        const target = playerOf(host.state, targetId)
        if (target) target.marks.quanjianNextDamage = 1
      }
      return
    }
    if (resolution.step === 'decide-hand') {
      const targetId = (resolution.data as { targetId: PlayerId }).targetId
      const target = playerOf(host.state, targetId)
      if (!target) return
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        target.marks.quanjianNextDamage = 1
        return
      }
      const limit = maxCardsOf(host.state, targetId)
      if (target.zones.hand.length > limit) {
        host.askSkill({ skillId: QUANJIAN, ownerId, step: 'discard-hand', data: { targetId, count: target.zones.hand.length - limit }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: targetId, prompt: '【劝谏】：弃置超出手牌上限的手牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: target.zones.hand.length - limit, max: target.zones.hand.length - limit }) })
      } else {
        drawCards(host.state, host.rng, targetId, Math.max(0, Math.min(5, limit) - target.zones.hand.length), (name, data) => host.dispatch(name, data))
        const state = host.state as SanguoshaState & { handUseBlockedUntilTurnEnd?: Record<PlayerId, number> }
        state.handUseBlockedUntilTurnEnd ??= {}
        state.handUseBlockedUntilTurnEnd[targetId] = host.state.turnNumber
      }
      return
    }
    if (resolution.step === 'discard-hand') {
      const { targetId, count } = resolution.data as { targetId: PlayerId; count: number }
      const target = playerOf(host.state, targetId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target || ids.length !== count || ids.some((id) => !target.zones.hand.includes(id))) return
      for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: ids, reason: QUANJIAN }, { sourceId: ownerId, targetId, cardIds: ids })
      const state = host.state as SanguoshaState & { handUseBlockedUntilTurnEnd?: Record<PlayerId, number> }
      state.handUseBlockedUntilTurnEnd ??= {}
      state.handUseBlockedUntilTurnEnd[targetId] = host.state.turnNumber
    }
  },
})
registerSkillRuntime({
  id: TUJUE,
  limited: true,
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    const target = playerOf(state, dyingPlayerId)
    if (!owner?.alive || !target?.alive || ownerId === dyingPlayerId || owner.usedLimitedSkills.includes(TUJUE)) return []
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea]
    return cards.map((_, index) => ({ id: `${TUJUE}:${index + 1}`, label: `途绝：交给${target.nickname}${index + 1}张牌` }))
  },
  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (!actionId.startsWith(`${TUJUE}:`)) return false
    const count = Number(actionId.slice(TUJUE.length + 1))
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, dyingPlayerId)
    if (!owner?.alive || !target?.alive || !Number.isInteger(count) || count < 1 || owner.usedLimitedSkills.includes(TUJUE)) return false
    const cards = [...owner.zones.hand, ...Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id)), ...owner.zones.judgingArea]
    const selected = cards.slice(0, count).filter((id) => Boolean(locateOwnedCard(host.state, ownerId, id)))
    if (selected.length !== count) return false
    owner.usedLimitedSkills.push(TUJUE)
    for (const cardId of selected) {
      const from = locateOwnedCard(host.state, ownerId, cardId)
      if (!from) continue
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: dyingPlayerId })
    }
    host.dispatch('GainCard', { playerId: dyingPlayerId, cardIds: selected, reason: TUJUE }, { sourceId: ownerId, targetId: dyingPlayerId, cardIds: selected })
    recover(host as never, dyingPlayerId, selected.length, ownerId)
    drawCards(host.state, host.rng, dyingPlayerId, selected.length, (name, data) => host.dispatch(name, data))
    return true
  },
})

const FUMAN = 'fuman'
registerSkillRuntime({
  id: FUMAN,
  grantsPlayActions(state, ownerId, actorId) {
    if (state.phase !== 'play' || state.currentPlayerId !== actorId || actorId === ownerId || usedThisPhase(state, actorId, FUMAN)) return []
    const actor = playerOf(state, actorId)
    const tagged = (state as Batch24State).fumanTags?.[actorId]
    if (!actor?.alive || tagged || !playerOf(state, ownerId)?.alive || !playerOf(state, ownerId)?.zones.hand.some((id) => state.cards[id]?.name === '杀')) return []
    return [{ id: `fuman:${actorId}`, label: '抚蛮：请马忠交给你一张【杀】' }]
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== `fuman:${actorId}`) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({ skillId: FUMAN, ownerId, step: 'give', data: { actorId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【抚蛮】：选择一张【杀】交给目标角色', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: owner.zones.hand.filter((id) => host.state.cards[id]?.name === '杀'), hiddenCardSlots: [], min: 0, max: 1 }) })
  },
  triggers: [{
    event: 'CardResolved',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      const sourceId = context.event.sourceId
      if (!payload.cardId || payload.cardName !== '杀' || !sourceId) return
      const state = host.state as Batch24State
      const tag = state.fumanTags?.[sourceId]
      if (!tag || tag.cardId !== payload.cardId) return
      const owner = playerOf(host.state, tag.ownerId)
      if (owner?.alive) drawCards(host.state, host.rng, tag.ownerId, 1, (name, data) => host.dispatch(name, data))
      delete state.fumanTags?.[sourceId]
    },
  }, {
    event: 'TurnEnd',
    handle(host, _ownerId, context) {
      const state = host.state as Batch24State
      if (context.event.targetId && state.fumanTags?.[context.event.targetId]) delete state.fumanTags[context.event.targetId]
    },
  }],
  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'give') return
    const { actorId } = resolution.data as { actorId: PlayerId }
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, _ownerId)
    const actor = playerOf(host.state, actorId)
    if (!owner?.alive || !actor?.alive || !cardId || host.state.cards[cardId]?.name !== '杀' || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'hand', playerId: actor.id })
    markUsedThisPhase(host.state, actor.id, FUMAN)
    const state = host.state as Batch24State
    state.fumanTags ??= {}
    state.fumanTags[actor.id] = { ownerId: owner.id, cardId }
  },
})

const DANYI = 'danyi'
const WENCAN = 'wencan'
registerSkillRuntime({
  id: DANYI,
  triggers: [{
    event: 'CardResolved',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      const state = host.state as Batch24State
      const previous = state.xizhengLastTargets?.[ownerId] ?? []
      const current = payload.targetIds ?? []
      const intersection = current.filter((id) => previous.includes(id)).length
      if (intersection > 0) drawCards(host.state, host.rng, ownerId, intersection, (name, data) => host.dispatch(name, data))
      state.xizhengLastTargets ??= {}
      state.xizhengLastTargets[ownerId] = [...current]
    },
  }],
})
registerSkillRuntime({
  id: WENCAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, WENCAN)) return []
    const others = aliveOthers(state, ownerId)
    return others.length > 0 ? [{ id: 'wencan-discard', label: '文灿：弃置两张不同花色的牌' }, { id: 'wencan-limit', label: '文灿：对一名角色无距离和次数限制' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'wencan-discard' && actionId !== 'wencan-limit') return
    const candidates = aliveOthers(host.state, ownerId)
    markUsedThisPhase(host.state, ownerId, WENCAN)
    host.askSkill({ skillId: WENCAN, ownerId, step: 'target', data: { actionId }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【文灿】：选择目标', timeoutMs: 20_000, optional: false, candidateIds: candidates.map((player) => player.id), min: 1, max: actionId === 'wencan-discard' ? 2 : 1 }) })
  },
  ignoresDistanceTo(state, ownerId, targetId) {
    return (state as Batch24State).xizhengWencanTargets?.[ownerId]?.[targetId] === state.turnNumber
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return (state as Batch24State).xizhengWencanTargets?.[ownerId]?.[targetId] === state.turnNumber
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const state = host.state as Batch24State
      if (context.event.targetId !== ownerId) return
      delete state.xizhengWencanTargets?.[ownerId]
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const owner = playerOf(host.state, ownerId)
      const ids = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const suits = ids.map((id) => host.state.cards[id]?.suit).filter(Boolean)
      if (!owner || ids.length !== 2 || new Set(suits).size !== 2 || ids.some((id) => !owner.zones.hand.includes(id))) return
      for (const id of ids) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: ids, reason: WENCAN }, { sourceId: ownerId, cardIds: ids })
      return
    }
    if (resolution.step !== 'target') return
    const { actionId } = resolution.data as { actionId: string }
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (targetIds.length === 0) return
    if (actionId === 'wencan-limit') {
      const state = host.state as Batch24State
      state.xizhengWencanTargets ??= {}
      state.xizhengWencanTargets[ownerId] ??= {}
      state.xizhengWencanTargets[ownerId][targetIds[0]] = host.state.turnNumber
      return
    }
    if (targetIds.length === 2) {
      const first = playerOf(host.state, targetIds[0])
      const second = playerOf(host.state, targetIds[1])
      if (first?.hp === second?.hp) return
    }
    const owner = playerOf(host.state, ownerId)
    if (!owner || owner.zones.hand.length < 2) return
    host.askSkill({ skillId: WENCAN, ownerId, step: 'cards', data: { targetIds }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【文灿】：弃置两张花色不同的牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2 }) })
  },
})

const XINGZHAO = 'xingzhao'
function syncXingzhaoGrant(host: SkillHost, ownerId: PlayerId): number {
  const wounded = host.state.players.filter((player) => player.alive && player.hp < player.maxHp).length
  replaceTemporarySkill(host.state, ownerId, `xingzhao:${ownerId}`, wounded === 1 ? 'xunxun' : null)
  return wounded
}
registerSkillRuntime({
  id: XINGZHAO,
  onGameStart(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  outgoingDamage(state, _ownerId, context) {
    const wounded = state.players.filter((player) => player.alive && player.hp < player.maxHp).length
    return wounded === 0 || wounded >= 4 ? { amount: context.amount + 1 } : null
  },
  offerPhaseSkip(host, ownerId, phase) {
    const wounded = host.state.players.filter((player) => player.alive && player.hp < player.maxHp).length
    if (host.state.currentPlayerId !== ownerId || wounded < 3 || (phase !== 'judge' && phase !== 'discard')) return false
    skipPhase(host.state, phase)
    return false
  },
  triggers: [{
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.xingzhaoWoundedCount = syncXingzhaoGrant(host, ownerId)
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  }, {
    event: 'Recover',
    handle(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  }, {
    event: 'LoseHp',
    handle(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  }, {
    event: 'MaxHpChange',
    handle(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  }, {
    event: 'Death',
    handle(host, ownerId) { syncXingzhaoGrant(host, ownerId) },
  }, {
    event: 'EquipmentZoneLoss',
    handle(host, ownerId, context) {
      const wounded = host.state.players.filter((player) => player.alive && player.hp < player.maxHp).length
      const payload = context.event.payload as { playerId?: PlayerId }
      if (wounded === 2 && payload.playerId === ownerId) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const wounded = host.state.players.filter((player) => player.alive && player.hp < player.maxHp).length
      const payload = context.event.payload as { cardId?: CardId }
      if (wounded !== 2 || context.event.sourceId !== ownerId || !payload.cardId || host.state.cards[payload.cardId]?.category !== 'equipment') return
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
    },
  }],
})

const SHIMING = 'shiming'
const JIANGXI = 'jiangxi'
function drawFromBottom(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  const ids: CardId[] = []
  for (let index = 0; index < count && host.state.zones.drawPile.length > 0; index += 1) {
    const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
    ids.push(cardId)
  }
  if (ids.length > 0) host.dispatch('GainCard', { playerId, cardIds: ids, reason }, { targetId: playerId, cardIds: ids })
}
registerSkillRuntime({
  id: SHIMING,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      const turnOwnerId = context.event.payload.playerId as PlayerId | undefined
      if (!turnOwnerId || !playerOf(host.state, ownerId)?.alive || playerOf(host.state, ownerId)?.marks.shimingRoundUsed) return
      context.cancel()
      host.askSkill({ skillId: SHIMING, ownerId, step: 'invoke', data: { turnOwnerId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【识命】：观看牌堆顶三张牌并置一张于牌堆底？', timeoutMs: 20_000, optional: false, options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动（正常摸两张）' }] }) })
    },
  }],
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch24State
    if (resolution.step === 'replacement') {
      const turnOwnerId = (resolution.data as { turnOwnerId: PlayerId }).turnOwnerId
      if ((response.payload as { optionId?: string }).optionId === 'hurt') {
        loseHp(host as never, turnOwnerId, 1, SHIMING)
        drawFromBottom(host, turnOwnerId, 3, SHIMING)
      } else {
        drawCards(host.state, host.rng, turnOwnerId, 2, (name, data) => host.dispatch(name, data))
      }
      delete state.qiaozhouShiming
      return
    }
    if (resolution.step === 'invoke') {
      const turnOwnerId = (resolution.data as { turnOwnerId: PlayerId }).turnOwnerId
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        drawCards(host.state, host.rng, turnOwnerId, 2, (name, data) => host.dispatch(name, data))
        return
      }
      const cards = revealTopCards(host.state, host.rng, 3, SHIMING, (name, data) => host.dispatch(name, data))
      if (cards.length === 0) return
      host.askSkill({ skillId: SHIMING, ownerId, step: 'bottom', data: { cards, turnOwnerId }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: ownerId, prompt: '【识命】：选择一张置于牌堆底（可不选）', timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1 }) })
      return
    }
    if (resolution.step !== 'bottom') return
    const { cards, turnOwnerId } = resolution.data as { cards: CardId[]; turnOwnerId: PlayerId }
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const bottom = selected[0]
    if (bottom && !cards.includes(bottom)) return
    const rest = cards.filter((id) => id !== bottom)
    for (const id of rest.slice().reverse()) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    if (!bottom) {
      for (const id of rest) if (host.state.zones.processingArea.includes(id)) moveCard(host.state, id, { kind: 'processingArea' }, { kind: 'drawPile' })
      drawCards(host.state, host.rng, turnOwnerId, 2, (name, data) => host.dispatch(name, data))
      return
    }
    moveCard(host.state, bottom, { kind: 'processingArea' }, { kind: 'drawPile' })
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks.shimingRoundUsed = 1
    state.qiaozhouShiming = { ownerId, turnOwnerId, cards: [] }
    host.askSkill({ skillId: SHIMING, ownerId, step: 'replacement', data: { turnOwnerId }, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: turnOwnerId, prompt: '【识命】：选择摸两张，或受到1点伤害后从牌堆底摸三张', timeoutMs: 20_000, optional: false, options: [{ id: 'draw', label: '摸两张' }, { id: 'hurt', label: '受到1点伤害并从牌堆底摸三张' }] }) })
  },
})
registerSkillRuntime({
  id: JIANGXI,
  triggers: [{
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.shimingRoundUsed = 0
    },
  }, {
    event: 'Damaged',
    handle(host) { (host.state as Batch24State & { jiangxiDamagedTurn?: number }).jiangxiDamagedTurn = host.state.turnNumber },
  }, {
    event: 'EnterDying',
    handle(host, ownerId, context) {
      const target = context.event.targetId ? playerOf(host.state, context.event.targetId) : undefined
      if (target?.seat !== 1) return
      drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.shimingRoundUsed = 0
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      const state = host.state as Batch24State & { jiangxiDamagedTurn?: number }
      if (owner && state.jiangxiDamagedTurn !== host.state.turnNumber) drawCards(host.state, host.rng, ownerId, 1, (name, data) => host.dispatch(name, data))
      if (state.jiangxiDamagedTurn === host.state.turnNumber) delete state.jiangxiDamagedTurn
    },
  }],
})

const JIANGJI = 'jiangji'
const YUANMO = 'yuanmo'
function adjacentLivingTargets(state: SanguoshaState, ownerId: PlayerId, max: number): PlayerId[] {
  const living = state.players.filter((player) => player.alive).sort((a, b) => a.seat - b.seat)
  const ownerIndex = living.findIndex((player) => player.id === ownerId)
  if (ownerIndex < 0) return []
  const result: PlayerId[] = []
  for (let offset = 1; offset < living.length && result.length < max; offset += 1) {
    const next = living[(ownerIndex + offset) % living.length]
    if (next.id === ownerId) break
    result.push(next.id)
  }
  return result
}
function queueJiangjiVictim(host: SkillHost, ownerId: PlayerId, pending: NonNullable<Batch24State['yanghongPending']>): void {
  while (pending.index < pending.targetIds.length && !(playerOf(host.state, pending.targetIds[pending.index])?.zones.hand.length)) pending.index += 1
  if (pending.index < pending.targetIds.length) {
    const next = playerOf(host.state, pending.targetIds[pending.index])
    if (next) host.askSkill({ skillId: JIANGJI, ownerId, step: 'discard-one', data: { targetIds: pending.targetIds, index: pending.index }, build: (requestId): ChooseCardsRequest => ({ id: requestId, kind: 'choose-cards', playerId: next.id, prompt: '【间计】：弃置一张牌', timeoutMs: 20_000, optional: false, purpose: 'skill', cardIds: [...next.zones.hand], hiddenCardSlots: [], min: 1, max: 1 }) })
    return
  }
  const players = pending.targetIds.map((id) => playerOf(host.state, id)).filter((player): player is NonNullable<typeof player> => Boolean(player?.alive))
  if (players.length < 2) return
  const maxHand = Math.max(...players.map((player) => player.zones.hand.length))
  const wielder = players.find((player) => player.zones.hand.length === maxHand)
  const victims = players.filter((player) => player.id !== wielder?.id)
  if (!wielder || victims.length === 0) return
  host.askSkill({ skillId: JIANGJI, ownerId, step: 'victim', data: { wielderId: wielder.id }, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: wielder.id, prompt: '【间计】：选择另一名被选角色视为使用【杀】', timeoutMs: 20_000, optional: false, candidateIds: victims.map((player) => player.id), min: 1, max: 1 }) })
}
registerSkillRuntime({
  id: JIANGJI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || usedThisPhase(state, ownerId, JIANGJI)) return []
    const count = Math.max(0, getAttackRange(state, ownerId))
    return count > 0 ? [{ id: JIANGJI, label: `间计：选择至多${count}名连续相邻角色` }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIANGJI) return
    const candidates = adjacentLivingTargets(host.state, ownerId, getAttackRange(host.state, ownerId))
    markUsedThisPhase(host.state, ownerId, JIANGJI)
    host.askSkill({ skillId: JIANGJI, ownerId, step: 'targets', data: {}, build: (requestId): ChooseTargetsRequest => ({ id: requestId, kind: 'choose-targets', playerId: ownerId, prompt: '【间计】：选择连续相邻角色', timeoutMs: 20_000, optional: true, candidateIds: candidates, min: 0, max: candidates.length }) })
  },
  resume(host, ownerId, resolution, response) {
    const state = host.state as Batch24State
    if (resolution.step === 'targets') {
      const ids = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (ids.length === 0) return
      const candidates = adjacentLivingTargets(host.state, ownerId, getAttackRange(host.state, ownerId))
      if (ids.some((id, index) => candidates[index] !== id)) return
      state.yanghongPending = { ownerId, targetIds: ids, index: 0, discarded: [] }
      queueJiangjiVictim(host, ownerId, state.yanghongPending)
      return
    }
    if (resolution.step === 'discard-one') {
      const pending = state.yanghongPending
      if (!pending) return
      const targetId = pending.targetIds[pending.index]
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!target || !cardId || !target.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIANGJI }, { sourceId: ownerId, targetId: targetId, cardIds: [cardId] })
      pending.discarded.push(cardId)
      pending.index += 1
      queueJiangjiVictim(host, ownerId, pending)
      return
    }
    if (resolution.step === 'victim') {
      const victimId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const wielderId = (resolution.data as { wielderId: PlayerId }).wielderId
      if (victimId) host.beginVirtualSlash({ sourceId: wielderId, targetId: victimId, sourceSkillId: JIANGJI, countUsage: false })
      delete state.yanghongPending
    }
  },
})
registerSkillRuntime({
  id: YUANMO,
  distanceModifier: {
    toOthers: (state, ownerId) => playerOf(state, ownerId)?.marks.yuanmoRangeDelta ?? 0,
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase === 'prepare' && payload.playerId === ownerId) host.queueSkill({ skillId: YUANMO, ownerId, step: 'choose', data: {} })
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId === ownerId) host.queueSkill({ skillId: YUANMO, ownerId, step: 'choose', data: {} })
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const targets = host.state.players.filter((player) => player.alive && player.id !== ownerId && getDistance(host.state, ownerId, player.id) <= getAttackRange(host.state, ownerId))
      if (targets.length === 0) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks.yuanmoRangeDelta = (owner.marks.yuanmoRangeDelta ?? 0) + 1
      }
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({ skillId: YUANMO, ownerId, step: 'choose', data: {}, build: (requestId): ChooseOptionRequest => ({ id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '【远谟】：调整攻击范围', timeoutMs: 20_000, optional: true, options: [{ id: 'up', label: '攻击范围+1，并获得新进入范围角色的一张牌' }, { id: 'down', label: '攻击范围-1，摸两张牌' }, { id: 'none', label: '不发动' }] }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const option = (response.payload as { optionId?: string }).optionId
    const owner = playerOf(host.state, ownerId)
    if (!owner || (option !== 'up' && option !== 'down')) return
    const before = host.state.players.filter((player) => player.alive && player.id !== ownerId && getDistance(host.state, ownerId, player.id) <= getAttackRange(host.state, ownerId)).map((player) => player.id)
    owner.marks.yuanmoRangeDelta = (owner.marks.yuanmoRangeDelta ?? 0) + (option === 'up' ? 1 : -1)
    if (option === 'down') {
      drawCards(host.state, host.rng, ownerId, 2, (name, data) => host.dispatch(name, data))
      return
    }
    const newly = host.state.players.filter((player) => player.alive && player.id !== ownerId && !before.includes(player.id) && getDistance(host.state, ownerId, player.id) <= getAttackRange(host.state, ownerId))
    for (const target of newly) {
      const cardId = target.zones.hand[0]
      if (cardId) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: YUANMO }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
      }
    }
  },
})

export const HISTORICAL_BATCH24_CHARACTERS: readonly CharacterDefinition[] = [
  { id: 'hansui', name: '韩遂', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: NILUAN, name: '逆乱', description: '出牌阶段，你可以将一张黑色牌当【杀】使用。通过此法使用的【杀】未造成伤害时不计入本阶段的使用次数。' },
    { id: WEIWEI, name: '违忤', description: '出牌阶段限一次，你可以将一张红色牌当【顺手牵羊】使用，且无距离限制。' },
  ] },
  { id: 'sunliang', name: '孙亮', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: KUIZHU, name: '溃诛', description: '弃牌阶段结束后，你可以根据本阶段弃置的牌数令角色摸牌，或对体力合计相等的角色各造成1点伤害。' },
    { id: CHEZHENG, name: '掣政', locked: true, description: '锁定技，你出牌阶段使用牌指定的角色，其攻击范围必须包含你。' },
      { id: LIJUN, name: '立军', description: '主公技，其他吴势力角色出牌阶段使用实体【杀】结算后，可以将之交给你，然后其摸一张牌。' },
  ] },
  { id: 'zhangwen', name: '张温', kingdom: 'wu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: ZHANWEN, name: '颂蜀', description: '出牌阶段限一次，你可以与一名有手牌的角色拼点；若你没赢，你与其各摸两张牌；若你赢，本阶段此技能视为未发动。' },
    { id: SIBIAN, name: '思辩', description: '摸牌阶段，你可以放弃摸牌，改为亮出牌堆顶四张牌，获得其中点数最大或最小的牌，其余交给手牌数最少的一名角色。' },
  ] },
  { id: 'xugong', name: '许贡', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: BIAOZHAO, name: '表召', description: '结束阶段，你可以将一张牌置于武将牌上，称为“表”；准备阶段，若有“表”，移去之并令一名角色回复1点体力且将手牌补至全场最大数（至多5张）。' },
    { id: YECHOU, name: '业仇', description: '你死亡时，可以选择一名已损失体力大于1的角色；其每回合结束时失去1点体力，直到其下个回合开始。' },
  ] },
  { id: 'huangquan', name: '黄权', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: QUANJIAN, name: '劝谏', description: '出牌阶段各限一次，你可以令一名角色选择：令其攻击范围内一名角色受到1点伤害，或将手牌调整至手牌上限（摸牌至多5张）；其拒绝后本回合下一次受到的伤害+1。' },
    { id: TUJUE, name: '途绝', description: '限定技，一名角色进入濒死时，你可以交给其任意张牌，令其回复等量体力并摸等量牌。' },
  ] },
  { id: 'mazhong_shu', name: '马忠', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: FUMAN, name: '抚蛮', description: '每名其他角色的出牌阶段限一次，你可以将一张【杀】交给该角色；其于下个回合结束前使用此牌时，你摸一张牌。' },
  ] },
  { id: 'xizheng', name: '郤正', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: DANYI, name: '耽意', description: '你连续两次使用牌指定的目标均相同时，你摸等量牌。' },
    { id: WENCAN, name: '文灿', description: '出牌阶段限一次，你可以选择一名角色并选择一项：弃置两张不同花色的牌，或令你对其使用牌无距离和次数限制直到回合结束。' },
  ] },
  { id: 'tangzi', name: '唐咨', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp', skills: [
    { id: XINGZHAO, name: '兴棹', locked: true, description: '锁定技，按全场受伤角色数动态获得对应能力：伤害加一、获得【恂恂】、装备进出摸牌、跳过判定和弃牌阶段。' },
  ] },
  { id: 'qiaozhou', name: '谯周', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: SHIMING, name: '识命', description: '每轮限一次，观看牌堆顶三张牌并将其中一张置于牌堆底；若实际置底，你与当前回合角色选择摸牌或受到伤害并摸牌堆底三张。' },
    { id: JIANGXI, name: '将息', description: '一号位进入濒死或本回合无人受到伤害时，你摸一张牌；前者重置【识命】的使用次数。' },
  ] },
  { id: 'yanghong', name: '杨弘', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp', skills: [
    { id: JIANGJI, name: '间计', description: '出牌阶段限一次，选择至多等同于你攻击范围的连续相邻角色，各弃置一张牌；手牌最多者可以对另一名被选角色视为使用【杀】。' },
    { id: YUANMO, name: '远谟', description: '准备阶段或受到伤害后，你可以令攻击范围永久+1并获得新进入范围角色的牌，或令攻击范围永久-1并摸两张牌；结束阶段若范围内没有其他角色，攻击范围+1。' },
  ] },
]
