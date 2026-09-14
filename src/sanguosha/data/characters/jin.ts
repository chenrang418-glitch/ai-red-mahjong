import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { applyWineEffect } from '../../engine/virtual-wine'
import { attackRangeCovers } from '../../engine/ask-use-slash'
import { getAttackRange } from '../../engine/distance'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { suppressSkill } from '../../engine/skill-suppression'
import {
  grantSkill, registerSkillRuntime, replaceTemporarySkills, type SkillHost,
} from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { CharacterDefinition } from './types'

/**
 * 晋势力专项第一批：司马师、司马昭、王元姬、杜预、羊徽瑜、司马伷、贾充、
 * 张华、周处、王祥。均采用三国杀 OL 当前身份模式版本（非国战版）。
 *
 * 本项目身份模式没有真正的隐匿/登场系统，本批含隐匿技的4名角色
 * （韬隐/推弑/识人/慧容）一律按"身份模式最低成本兼容规则"实现：
 * 游戏开始后第一次相关时机触发一次等效效果，不新建暗将系统。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isLord(state: SanguoshaState, playerId: PlayerId): boolean {
  return playerOf(state, playerId)?.identity === 'lord'
}

/*
 * 项目未提供"是否有伤害效果"的通用锦囊标记，睿略只能精确核这几个官方
 * 有伤害效果的非延时锦囊名单（决斗/南蛮入侵/万箭齐发/借刀杀人/火攻），
 * 不做全锦囊扫描。
 */
const DAMAGE_TRICK_NAMES = new Set(['决斗', '南蛮入侵', '万箭齐发', '借刀杀人', '火攻'])
/** category 不区分延时/普通锦囊，只能按牌名精确核这份延时锦囊名单。 */
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

// ============================== 司马师 ==============================

const TAOYIN = 'taoyin'
const YIMIE = 'yimie'
const RUILUE = 'ruilue'
const TAIRAN = 'tairan'

registerSkillRuntime({
  id: TAOYIN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if (usedThisTurn(host.state, ownerId, TAOYIN) || (host.state.taoyinUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const turnOwner = payload.playerId ? playerOf(host.state, payload.playerId) : undefined
      if (!owner?.alive || !turnOwner?.alive) return
      host.state.taoyinUsed = [...(host.state.taoyinUsed ?? []), ownerId]
      turnOwner.marks['taoyin-maxcards-turn'] = host.state.turnNumber
      turnOwner.marks['taoyin-maxcards-delta'] = -2
      host.dispatch('SkillActivated', { skillId: TAOYIN, skillName: '韬隐', playerId: ownerId, targetId: turnOwner.id, logText: `${owner.nickname}发动【韬隐】` }, { sourceId: ownerId, targetId: turnOwner.id })
    },
  }],
  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.marks['taoyin-maxcards-turn'] === state.turnNumber ? (owner.marks['taoyin-maxcards-delta'] ?? 0) : 0
  },
})

registerSkillRuntime({
  id: YIMIE,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, YIMIE)) return
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const payload = context.event.payload as { amount?: number }
      const amount = typeof payload.amount === 'number' ? payload.amount : 1
      const x = target.hp - amount
      if (x <= 0) return
      markUsedThisTurn(host.state, ownerId, YIMIE)
      loseHp(host as never, ownerId, 1, YIMIE)
      if (!playerOf(host.state, ownerId)?.alive) return
      payload.amount = amount + x
      host.state.yimiePending = { ownerId, targetId, x }
      host.dispatch('SkillActivated', { skillId: YIMIE, skillName: '夷灭', playerId: ownerId, targetId, logText: `${owner.nickname}发动【夷灭】` }, { sourceId: ownerId, targetId })
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      const pending = host.state.yimiePending
      if (!pending || pending.ownerId !== ownerId || context.event.targetId !== pending.targetId) return
      host.state.yimiePending = undefined
      const target = playerOf(host.state, pending.targetId)
      if (target?.alive && pending.x > 0) recover(host as never, pending.targetId, pending.x, ownerId)
    },
  }],
})

registerSkillRuntime({
  id: RUILUE,
  lord: true,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
      if (!isLord(host.state, ownerId)) return
      const actorId = payload.playerId
      if (effectiveKingdomOf(host.state, actorId) !== 'jin') return
      if (usedThisTurn(host.state, actorId, RUILUE)) return
      const actor = playerOf(host.state, actorId)
      const owner = playerOf(host.state, ownerId)
      if (!actor?.alive || !owner?.alive) return
      const candidates = actor.zones.hand.filter((cardId) => {
        const card = host.state.cards[cardId]
        return card?.name === '杀' || DAMAGE_TRICK_NAMES.has(card?.name ?? '')
      })
      if (candidates.length === 0) return
      host.queueSkill({ skillId: RUILUE, ownerId, step: 'ask', data: { actorId, candidates } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { actorId, candidates } = prompt.data as { actorId: PlayerId; candidates: CardId[] }
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive || usedThisTurn(host.state, actorId, RUILUE)) return
    host.askSkill({
      skillId: RUILUE, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: actorId,
        prompt: '【睿略】：可以交给司马师1张杀或有伤害效果的锦囊', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { actorId } = resolution.data as { actorId: PlayerId }
    const actor = playerOf(host.state, actorId)
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!actor?.alive || !owner?.alive || !cardId || !actor.zones.hand.includes(cardId)) return
    markUsedThisTurn(host.state, actorId, RUILUE)
    moveCard(host.state, cardId, { kind: 'hand', playerId: actorId }, { kind: 'hand', playerId: ownerId })
    host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: RUILUE }, { sourceId: actorId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: RUILUE }, { sourceId: actorId, targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: RUILUE, skillName: '睿略', playerId: actorId, targetId: ownerId, logText: `${actor.nickname}发动【睿略】` }, { sourceId: actorId, targetId: ownerId })
  },
})

registerSkillRuntime({
  id: TAIRAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const recovered = owner.hp < owner.maxHp ? recover(host as never, ownerId, owner.maxHp - owner.hp, ownerId) : 0
        const target = Math.max(owner.zones.hand.length, owner.maxHp)
        const n = target - owner.zones.hand.length
        const before = new Set(owner.zones.hand)
        if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, p) => { host.dispatch(name, p) })
        const drawnIds = owner.zones.hand.filter((cardId) => !before.has(cardId))
        if (recovered <= 0 && drawnIds.length === 0) return
        host.state.tairanPending = [
          ...(host.state.tairanPending ?? []),
          { ownerId, recovered, cardIds: drawnIds },
        ]
        host.dispatch('SkillActivated', { skillId: TAIRAN, skillName: '泰然', playerId: ownerId, logText: `${owner.nickname}发动【泰然】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const records = (host.state.tairanPending ?? []).filter((entry) => entry.ownerId === ownerId)
        if (records.length === 0) return
        host.state.tairanPending = (host.state.tairanPending ?? []).filter((entry) => entry.ownerId !== ownerId)
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const totalRecovered = records.reduce((sum, entry) => sum + entry.recovered, 0)
        const cardIds = [...new Set(records.flatMap((entry) => entry.cardIds))].filter((cardId) => owner.zones.hand.includes(cardId))
        if (totalRecovered > 0) loseHp(host as never, ownerId, Math.min(totalRecovered, owner.hp), TAIRAN)
        if (cardIds.length > 0 && playerOf(host.state, ownerId)?.alive) {
          for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
          host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: TAIRAN }, { sourceId: ownerId, cardIds })
        }
      },
    },
  ],
})

// ============================== 司马昭 ==============================

const TUISHI = 'tuishi'
const CHOUFA = 'choufa'
const CHOUFA_GRANT = 'choufa-grant'
const ZHAORAN = 'zhaoran'
const CHENGWU = 'chengwu'
const SUITS = ['spade', 'heart', 'club', 'diamond'] as const

registerSkillRuntime({
  id: TUISHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if ((host.state.tuishiUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const turnOwner = payload.playerId ? playerOf(host.state, payload.playerId) : undefined
      if (!owner?.alive || !turnOwner?.alive) return
      host.state.tuishiUsed = [...(host.state.tuishiUsed ?? []), ownerId]
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== turnOwner.id).map((candidate) => candidate.id)
      host.queueSkill({ skillId: TUISHI, ownerId, step: 'ask', data: { turnOwnerId: turnOwner.id, candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { turnOwnerId } = prompt.data as { turnOwnerId: PlayerId }
    const turnOwner = playerOf(host.state, turnOwnerId)
    if (!turnOwner?.alive) return
    host.askSkill({
      skillId: TUISHI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: turnOwnerId,
        prompt: '【推弑】：请选择', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'slash', label: '对攻击范围内一名由司马昭指定的角色使用杀' },
          { id: 'self-damage', label: '受到司马昭造成的1点伤害' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { turnOwnerId } = resolution.data as { turnOwnerId: PlayerId }
      const turnOwner = playerOf(host.state, turnOwnerId)
      if (!turnOwner?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'slash') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== turnOwnerId && attackRangeCovers(host.state, turnOwnerId, candidate.id)).map((candidate) => candidate.id)
        if (candidateIds.length === 0) {
          host.dispatch('SkillActivated', { skillId: TUISHI, skillName: '推弑', playerId: ownerId, targetId: turnOwnerId, logText: `${owner.nickname}发动【推弑】` }, { sourceId: ownerId, targetId: turnOwnerId })
          resolveDamage(host as never, { sourceId: ownerId, targetId: turnOwnerId, amount: 1, nature: 'normal', cardName: null })
          return
        }
        host.askSkill({
          skillId: TUISHI, ownerId, step: 'pick-target', data: { turnOwnerId },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【推弑】：指定攻击范围内一名角色作为杀的目标', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      host.dispatch('SkillActivated', { skillId: TUISHI, skillName: '推弑', playerId: ownerId, targetId: turnOwnerId, logText: `${owner.nickname}发动【推弑】` }, { sourceId: ownerId, targetId: turnOwnerId })
      resolveDamage(host as never, { sourceId: ownerId, targetId: turnOwnerId, amount: 1, nature: 'normal', cardName: null })
      return
    }
    if (resolution.step === 'pick-target') {
      const { turnOwnerId } = resolution.data as { turnOwnerId: PlayerId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const turnOwner = playerOf(host.state, turnOwnerId)
      if (!turnOwner?.alive || !targetId) return
      host.dispatch('SkillActivated', { skillId: TUISHI, skillName: '推弑', playerId: ownerId, targetId: turnOwnerId, logText: `${owner.nickname}发动【推弑】` }, { sourceId: ownerId, targetId: turnOwnerId })
      host.beginVirtualSlash({ sourceId: turnOwnerId, targetId, sourceSkillId: TUISHI })
    }
  },
})

function clearChoufa(host: SkillHost, playerId: PlayerId): void {
  if (host.state.choufaCardIds?.[playerId]) delete host.state.choufaCardIds[playerId]
  replaceTemporarySkills(host.state, playerId, CHOUFA, [])
}

registerSkillRuntime({
  id: CHOUFA,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, CHOUFA)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: CHOUFA, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }, {
    event: 'PhaseEnd',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play') return
      const targetId = payload.playerId
      if (targetId && host.state.choufaCardIds?.[targetId]) clearChoufa(host, targetId)
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, CHOUFA)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: CHOUFA, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【筹伐】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, CHOUFA)
      const revealedId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      host.dispatch('CardMove', { cardIds: [revealedId], reason: CHOUFA, revealed: true }, { sourceId: targetId, cardIds: [revealedId] })
      const revealedType = host.state.cards[revealedId]?.category
      const convertedIds = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== revealedType)
      host.state.choufaCardIds ??= {}
      host.state.choufaCardIds[targetId] = convertedIds
      replaceTemporarySkills(host.state, targetId, CHOUFA, [CHOUFA_GRANT])
      host.dispatch('SkillActivated', { skillId: CHOUFA, skillName: '筹伐', playerId: ownerId, targetId, logText: `${owner.nickname}发动【筹伐】` }, { sourceId: ownerId, targetId })
      return
    }
  },
})

registerSkillRuntime({ id: CHOUFA_GRANT, viewAs(state, ownerId) {
  const owner = playerOf(state, ownerId)
  const ids = (state.choufaCardIds?.[ownerId] ?? []).filter((cardId) => owner?.zones.hand.includes(cardId))
  return ids.map((cardId) => ({ asCardName: '杀', cardId, label: '筹伐：视为杀' }))
} })

registerSkillRuntime({
  id: ZHAORAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.state.revealedHands = [...new Set([...(host.state.revealedHands ?? []), ownerId])]
        host.state.zhaoranEmptySuits = { turnNumber: host.state.turnNumber, suits: [] }
        host.dispatch('SkillActivated', { skillId: ZHAORAN, skillName: '昭然', playerId: ownerId, logText: `${owner.nickname}发动【昭然】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        host.state.revealedHands = (host.state.revealedHands ?? []).filter((id) => id !== ownerId)
        host.state.zhaoranEmptySuits = undefined
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const record = host.state.zhaoranEmptySuits
        if (!record || record.turnNumber !== host.state.turnNumber) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const remainingSuits = new Set(owner.zones.hand.map((cardId) => host.state.cards[cardId]?.suit).filter(Boolean))
        for (const suit of SUITS) {
          if (remainingSuits.has(suit) || record.suits.includes(suit)) continue
          record.suits.push(suit)
          host.queueSkill({ skillId: ZHAORAN, ownerId, step: 'ask', data: { suit } })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZHAORAN, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【昭然】：失去了该花色的最后一张手牌，请选择', timeoutMs: 20_000, optional: false,
        options: [{ id: 'draw', label: '摸1张牌' }, { id: 'discard', label: '弃置一名其他角色1张牌' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'draw') {
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      return
    }
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHAORAN, ownerId, step: 'discard-pick', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【昭然】：选择一名其他角色弃置其1张牌', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
})

registerSkillRuntime({
  id: CHENGWU,
  lord: true,
  ignoresDistanceTo(state, ownerId, targetId) {
    if (!isLord(state, ownerId)) return false
    for (const ally of state.players) {
      if (!ally.alive || ally.id === ownerId || effectiveKingdomOf(state, ally.id) !== 'jin') continue
      if (attackRangeCovers(state, ally.id, targetId)) return true
    }
    return false
  },
})

// ============================== 王元姬 ==============================

const SHIREN = 'shiren'
const YANXI = 'yanxi'

registerSkillRuntime({
  id: SHIREN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if ((host.state.shirenUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const turnOwner = playerOf(host.state, payload.playerId)
      if (!owner?.alive || !turnOwner?.alive || turnOwner.zones.hand.length === 0) return
      host.state.shirenUsed = [...(host.state.shirenUsed ?? []), ownerId]
      host.dispatch('SkillActivated', { skillId: SHIREN, skillName: '识人', playerId: ownerId, targetId: turnOwner.id, logText: `${owner.nickname}发动【识人】` }, { sourceId: ownerId, targetId: turnOwner.id })
      host.queueSkill({ skillId: YANXI, ownerId, step: 'ask', data: { targetId: turnOwner.id } })
    },
  }],
})

registerSkillRuntime({
  id: YANXI,
  handLimitExempt(state, ownerId, cardId) {
    return Boolean(state.yanxiExempt?.[ownerId]?.includes(cardId))
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || usedThisTurn(host.state, ownerId, YANXI)) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: YANXI, ownerId, step: 'pick-target', data: { candidateIds } })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        if (host.state.yanxiExempt) delete host.state.yanxiExempt[ownerId]
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
      runYanxi(host, ownerId, targetId)
      return
    }
    if (prompt.step === 'pick-target') {
      if (usedThisTurn(host.state, ownerId, YANXI)) return
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.askSkill({
        skillId: YANXI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【宴戏】：选择一名有手牌的其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      markUsedThisTurn(host.state, ownerId, YANXI)
      runYanxi(host, ownerId, targetId!)
      return
    }
    if (resolution.step !== 'guess') return
    const { targetId, handCardId, deckA, deckB } = resolution.data as { targetId: PlayerId; handCardId: CardId; deckA: CardId; deckB: CardId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const [selected] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (selected === handCardId) {
      moveCard(host.state, handCardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      moveCard(host.state, deckA, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      moveCard(host.state, deckB, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      const gained = [handCardId, deckA, deckB]
      host.state.yanxiExempt ??= {}
      host.state.yanxiExempt[ownerId] = [...(host.state.yanxiExempt[ownerId] ?? []), ...gained]
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [handCardId], reason: YANXI }, { sourceId: targetId, cardIds: [handCardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: YANXI }, { sourceId: targetId, targetId: ownerId, cardIds: gained })
    } else if (selected === deckA || selected === deckB) {
      moveCard(host.state, selected, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.state.yanxiExempt ??= {}
      host.state.yanxiExempt[ownerId] = [...(host.state.yanxiExempt[ownerId] ?? []), selected]
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [selected], reason: YANXI }, { targetId: ownerId, cardIds: [selected] })
    }
  },
})

function runYanxi(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
  const handCardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
  if (host.state.zones.drawPile.length < 2) return
  const [deckA, deckB] = host.state.zones.drawPile.slice(0, 2)
  const pool = [handCardId, deckA, deckB]
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = host.rng.nextInt(i + 1)
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  host.dispatch('SkillActivated', { skillId: YANXI, skillName: '宴戏', playerId: ownerId, targetId, logText: `${owner.nickname}发动【宴戏】` }, { sourceId: ownerId, targetId })
  host.askSkill({
    skillId: YANXI, ownerId, step: 'guess', data: { targetId, handCardId, deckA, deckB, shuffled },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: '【宴戏】：从这3张牌中选择1张，猜测它来自目标手牌', timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: shuffled, hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

// ============================== 杜预 ==============================

const SANCHEN = 'sanchen'
const ZHAOTAO = 'zhaotao'
const POZHU = 'pozhu'

registerSkillRuntime({
  id: SANCHEN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, SANCHEN)) return
      const excluded = host.state.sanchenExcluded ?? []
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && !excluded.includes(candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: SANCHEN, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      host.state.sanchenExcluded = []
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, SANCHEN)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: SANCHEN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【三陈】：选择一名角色，其摸3张牌然后弃置3张牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') { handleSanchenDiscard(host, ownerId, resolution, response); return }
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    markUsedThisTurn(host.state, ownerId, SANCHEN)
    owner.marks['sanchen-total'] = (owner.marks['sanchen-total'] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: SANCHEN, skillName: '三陈', playerId: ownerId, targetId, logText: `${owner.nickname}发动【三陈】` }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 3, (n, p) => { host.dispatch(n, p) })
    host.askSkill({
      skillId: SANCHEN, ownerId, step: 'discard', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId,
        prompt: '【三陈】：弃置3张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: Math.min(3, target.zones.hand.length), max: Math.min(3, target.zones.hand.length),
      }),
    })
    return
  },
})

function handleSanchenDiscard(host: SkillHost, ownerId: PlayerId, resolution: { step: string; data: unknown }, response: { payload: unknown }): void {
  if (resolution.step !== 'discard') return
  const { targetId } = resolution.data as { targetId: PlayerId }
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => target.zones.hand.includes(id))
  if (picked.length === 0) return
  for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId: targetId, cardIds: picked, reason: SANCHEN }, { sourceId: targetId, cardIds: picked })
  const categories = new Set(picked.map((id) => host.state.cards[id]?.category))
  const hasAllThree = categories.has('basic') && categories.has('trick') && categories.has('equipment')
  if (!hasAllThree) return
  drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
  const owner = playerOf(host.state, ownerId)
  if (owner) owner.turnUsedSkills = (owner.turnUsedSkills ?? []).filter((id) => id !== SANCHEN)
  host.state.sanchenExcluded = [...(host.state.sanchenExcluded ?? []), targetId]
}

registerSkillRuntime({
  id: ZHAOTAO,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      return (owner?.marks['sanchen-total'] ?? 0) >= 3
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, ZHAOTAO)
      if (!playerOf(host.state, ownerId)?.alive) return
      grantSkill(host.state, ownerId, POZHU)
      host.dispatch('SkillActivated', { skillId: ZHAOTAO, skillName: '昭讨', playerId: ownerId, logText: `${owner.nickname}发动【昭讨】，觉醒获得【破竹】` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: POZHU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      host.state.pozhuDisabledTurn = undefined
    },
  }],
})

// ============================== 羊徽瑜 ==============================

const HUIRONG = 'huirong'
const CIWEI = 'ciwei'
const CAIYUAN = 'caiyuan'

registerSkillRuntime({
  id: HUIRONG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      if ((host.state.huirongUsed ?? []).includes(ownerId)) return
      const payload = context.event.payload as { phase?: string }
      if (payload.phase !== 'prepare' || host.state.turnNumber !== 1) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.state.huirongUsed = [...(host.state.huirongUsed ?? []), ownerId]
      host.queueSkill({ skillId: HUIRONG, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: HUIRONG, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【慧容】：选择一名角色，将其手牌调整至体力值（至多摸至5张）', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    host.dispatch('SkillActivated', { skillId: HUIRONG, skillName: '慧容', playerId: ownerId, targetId, logText: `${owner.nickname}发动【慧容】` }, { sourceId: ownerId, targetId })
    const cap = Math.min(target.hp, 5)
    if (target.zones.hand.length < cap) {
      drawCards(host.state, host.rng, targetId, cap - target.zones.hand.length, (n, p) => { host.dispatch(n, p) })
    } else if (target.zones.hand.length > target.hp) {
      const discard = target.zones.hand.slice(0, target.zones.hand.length - target.hp)
      for (const cardId of discard) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: discard, reason: HUIRONG }, { sourceId: targetId, cardIds: discard })
    }
  },
})

registerSkillRuntime({
  id: CIWEI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || !payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) player.marks['ciwei-use-count'] = 0
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId || host.state.currentPlayerId !== sourceId) return
        const source = playerOf(host.state, sourceId)
        const owner = playerOf(host.state, ownerId)
        if (!source?.alive || !owner?.alive) return
        source.marks['ciwei-use-count'] = (source.marks['ciwei-use-count'] ?? 0) + 1
        if (source.marks['ciwei-use-count'] !== 2) return
        const payload = context.event.payload as { cardId?: CardId; virtual?: boolean }
        const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
        if (!card || card.category === 'equipment' || DELAYED_TRICK_NAMES.has(card.name)) return
        if (owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: CIWEI, ownerId, step: 'ask', data: { sourceId, cardId: payload.cardId } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    if (!playerOf(host.state, sourceId)?.alive) return
    host.askSkill({
      skillId: CIWEI, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【慈威】：是否弃置1张牌，令这张基本牌/普通锦囊完全无效？', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { sourceId } = resolution.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CIWEI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: CIWEI, skillName: '慈威', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【慈威】` }, { sourceId: ownerId, targetId: sourceId })
    /*
     * "整张CardUse无效"目前只对杀这一种精确支持（targetCancelled 是唯一
     * 现成的、单目标级别的取消入口）；普通锦囊的全体取消需要另一套按牌种
     * 分支的机制，超出本次最小实现范围，弃牌仍然生效，只是那种情况下
     * 不再额外取消结算——已知简化。
     */
    const current = host.state.cardResolution
    if (current?.kind === 'slash') current.targetCancelled = true
  },
})

registerSkillRuntime({
  id: CAIYUAN,
  triggers: [
    {
      event: 'LoseHp',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId && (context.event.payload as { playerId?: PlayerId }).playerId !== ownerId) return
        host.state.caiyuanDecreased = [...new Set([...(host.state.caiyuanDecreased ?? []), ownerId])]
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        host.state.caiyuanDecreased = [...new Set([...(host.state.caiyuanDecreased ?? []), ownerId])]
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (!(host.state.caiyuanDecreased ?? []).includes(ownerId)) {
          drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
          host.dispatch('SkillActivated', { skillId: CAIYUAN, skillName: '才媛', playerId: ownerId, logText: `${owner.nickname}发动【才媛】` }, { sourceId: ownerId })
        }
        host.state.caiyuanDecreased = (host.state.caiyuanDecreased ?? []).filter((id) => id !== ownerId)
      },
    },
  ],
})

// ============================== 司马伷 ==============================

const CAIWANG = 'caiwang'
const NAXIANG = 'naxiang'

registerSkillRuntime({
  id: CAIWANG,
  triggers: [{
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId | null; cardName?: string }
      const responderId = payload.playerId
      const responseCardId = payload.cardId
      if (!responderId || !responseCardId) return
      const original = host.state.cardResolution
      if (!original || original.kind !== 'slash') return
      const originalUserId = original.sourceId
      let partnerId: PlayerId | null = null
      if (responderId === ownerId && originalUserId !== ownerId) partnerId = originalUserId
      else if (originalUserId === ownerId && responderId !== ownerId) partnerId = responderId
      if (!partnerId) return
      const responseColor = host.state.cards[responseCardId]?.color
      const originalColor = host.state.cards[original.cardId]?.color
      if (!responseColor || !originalColor || responseColor !== originalColor) return
      const owner = playerOf(host.state, ownerId)
      const partner = playerOf(host.state, partnerId)
      if (!owner?.alive || !partner?.alive) return
      host.queueSkill({ skillId: CAIWANG, ownerId, step: 'react', data: { partnerId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'react') return
    const { partnerId } = prompt.data as { partnerId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const partner = playerOf(host.state, partnerId)
    if (!owner?.alive || !partner?.alive) return
    const empowered = (host.state.naxiangEmpowered ?? []).includes(partnerId)
    if (empowered) {
      if (partner.zones.hand.length === 0) return
      const cardId = partner.zones.hand[0]
      moveCard(host.state, cardId, { kind: 'hand', playerId: partnerId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: partnerId, cardIds: [cardId], reason: CAIWANG }, { sourceId: partnerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CAIWANG }, { sourceId: partnerId, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: CAIWANG, skillName: '才望', playerId: ownerId, targetId: partnerId, logText: `${owner.nickname}发动【才望】获得${partner.nickname}一张牌` }, { sourceId: ownerId, targetId: partnerId })
      return
    }
    if (partner.zones.hand.length === 0) return
    const cardId = partner.zones.hand[0]
    moveCard(host.state, cardId, { kind: 'hand', playerId: partnerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: partnerId, cardIds: [cardId], reason: CAIWANG }, { sourceId: partnerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: CAIWANG, skillName: '才望', playerId: ownerId, targetId: partnerId, logText: `${owner.nickname}发动【才望】弃置${partner.nickname}一张牌` }, { sourceId: ownerId, targetId: partnerId })
  },
})

registerSkillRuntime({
  id: NAXIANG,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
        host.state.naxiangEmpowered = []
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        let partnerId: PlayerId | null = null
        if (targetId === ownerId && sourceId && sourceId !== ownerId) partnerId = sourceId
        else if (sourceId === ownerId && targetId && targetId !== ownerId) partnerId = targetId
        if (!partnerId) return
        host.state.naxiangEmpowered = [...new Set([...(host.state.naxiangEmpowered ?? []), partnerId])]
      },
    },
  ],
})

// ============================== 贾充 ==============================

const XIONGSHU = 'xiongshu'
const JIANHUI = 'jianhui'

registerSkillRuntime({
  id: XIONGSHU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
      const target = playerOf(host.state, payload.playerId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
      host.queueSkill({ skillId: XIONGSHU, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }, {
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play') return
      const pending = host.state.xiongshuGuess
      if (!pending || pending.ownerId !== ownerId || pending.targetId !== payload.playerId) return
      host.state.xiongshuGuess = undefined
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, pending.targetId)
      if (!owner?.alive) return
      const used = pending.usedName
      if (used === pending.guess) {
        if (target?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId: pending.targetId, amount: 1, nature: 'normal', cardName: null })
        return
      }
      if (target?.alive && target.zones.hand.includes(pending.cardId)) {
        moveCard(host.state, pending.cardId, { kind: 'hand', playerId: pending.targetId }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: pending.targetId, cardIds: [pending.cardId], reason: XIONGSHU }, { sourceId: pending.targetId, cardIds: [pending.cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [pending.cardId], reason: XIONGSHU }, { sourceId: pending.targetId, targetId: ownerId, cardIds: [pending.cardId] })
      }
    },
  }, {
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const pending = host.state.xiongshuGuess
      if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== pending.targetId) return
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName === pending.cardName) pending.usedName = true
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || target.zones.hand.length === 0) return
    const round = host.state.roundNumber
    const state = host.state.xiongshuRound?.round === round ? host.state.xiongshuRound : { round, count: 0 }
    const x = state.count
    if (x > 0 && owner.zones.hand.length < x) return
    host.askSkill({
      skillId: XIONGSHU, ownerId, step: 'ask', data: { targetId, x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【凶竖】：是否发动？（本回合弃置${x}张牌）`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { targetId, x } = resolution.data as { targetId: PlayerId; x: number }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) return
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      if (x > 0) {
        if (owner.zones.hand.length < x) return
        const discard = owner.zones.hand.slice(0, x)
        for (const cardId of discard) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: discard, reason: XIONGSHU }, { sourceId: ownerId, cardIds: discard })
      }
      const round = host.state.roundNumber
      const prev = host.state.xiongshuRound?.round === round ? host.state.xiongshuRound.count : 0
      host.state.xiongshuRound = { round, count: prev + 1 }
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      const cardName = host.state.cards[cardId]?.name ?? ''
      host.dispatch('CardMove', { cardIds: [cardId], reason: XIONGSHU, revealed: true }, { sourceId: targetId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: XIONGSHU, skillName: '凶竖', playerId: ownerId, targetId, logText: `${owner.nickname}发动【凶竖】` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: XIONGSHU, ownerId, step: 'guess', data: { targetId, cardId, cardName },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【凶竖】：秘密猜测${target.nickname}本阶段是否会使用【${cardName}】`, timeoutMs: 20_000, optional: false,
          options: [{ id: 'yes', label: '会使用' }, { id: 'no', label: '不会使用' }],
        }),
      })
      return
    }
    if (resolution.step === 'guess') {
      const { targetId, cardId, cardName } = resolution.data as { targetId: PlayerId; cardId: CardId; cardName: string }
      const guess = (response.payload as { optionId?: string }).optionId === 'yes'
      host.state.xiongshuGuess = { ownerId, targetId, cardId, cardName, guess, usedName: false }
    }
  },
})

registerSkillRuntime({
  id: JIANHUI,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        host.state.jiachongLastDamager = sourceId
        if (host.state.jiachongLastDamager === sourceId) {
          host.queueSkill({ skillId: JIANHUI, ownerId, step: 'discard-source', data: { sourceId } })
        }
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        if (sourceId !== ownerId || !targetId) return
        if (host.state.jiachongLastDamager !== targetId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: JIANHUI, skillName: '奸回', playerId: ownerId, logText: `${owner.nickname}发动【奸回】` }, { sourceId: ownerId })
      },
    },
  ],
  startQueued(host, _ownerId, prompt) {
    if (prompt.step !== 'discard-source') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const source = playerOf(host.state, sourceId)
    if (!source?.alive || source.zones.hand.length === 0) return
    if (host.state.jiachongLastDamager !== sourceId) return
    const cardId = source.zones.hand[0]
    moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: JIANHUI }, { sourceId, cardIds: [cardId] })
  },
})

// ============================== 张华 ==============================

const BIHUN = 'bihun'
const CHUANWU = 'chuanwu'
const JIANHE = 'jianhe'

registerSkillRuntime({
  id: BIHUN,
  /*
   * 用 interceptPlayAction 而不是 CardUsed：后者在牌真正进入结算管线之后
   * 才触发，这时候延时锦囊等牌型的后续放置逻辑已经在同一次调用里排队要
   * 动这张牌了，弼昏抢先把它挪进目标手牌会导致"卡牌不在来源区域"。
   * interceptPlayAction 发生在原始出牌动作真正生效之前，取消即代表
   * 这次使用整个不发生，和"取消此次使用"的文本完全对应。
   */
  interceptPlayAction(host, ownerId, action) {
    if (action.playerId !== ownerId || action.targetIds.length !== 1 || action.targetIds[0] === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length <= maxCardsOfSafe(host.state, ownerId)) return false
    const [cardId] = action.cardIds
    const [targetId] = action.targetIds
    const target = playerOf(host.state, targetId)
    if (!cardId || !target?.alive || !owner.zones.hand.includes(cardId)) return false
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: BIHUN }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: BIHUN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: BIHUN, skillName: '弼昏', playerId: ownerId, targetId, logText: `${owner.nickname}发动【弼昏】` }, { sourceId: ownerId, targetId })
    return true
  },
})

function maxCardsOfSafe(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.hp ?? 0
}

registerSkillRuntime({
  id: CHUANWU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId && context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = getAttackRange(host.state, ownerId)
      const character = ownerCharacterOf(host, ownerId)
      if (!character) return
      const alreadySuppressed = new Set(
        (host.state.skillSuppressions ?? []).filter((entry) => entry.targetId === ownerId && entry.sourceId === ownerId && entry.sourceSkillId === CHUANWU).map((entry) => entry.skillId),
      )
      const remaining = character.skills.map((skill) => skill.id).filter((id) => !alreadySuppressed.has(id))
      const toSuppress = remaining.slice(0, x)
      if (toSuppress.length === 0) return
      for (const skillId of toSuppress) {
        suppressSkill(host.state, { targetId: ownerId, skillId, sourceId: ownerId, sourceSkillId: CHUANWU, armedAtTurn: host.state.turnNumber })
      }
      drawCards(host.state, host.rng, ownerId, toSuppress.length, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: CHUANWU, skillName: '穿屋', playerId: ownerId, logText: `${owner.nickname}发动【穿屋】` }, { sourceId: ownerId })
    },
  }],
})

function ownerCharacterOf(host: SkillHost, playerId: PlayerId): CharacterDefinition | undefined {
  const characterId = playerOf(host.state, playerId)?.characterId
  return JIN_CHARACTERS.find((character) => character.id === characterId)
}

registerSkillRuntime({
  id: JIANHE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      host.state.jianheUsedTargets = []
    },
  }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, JIANHE)) return []
    return [{ id: 'skill:jianhe', label: '发动【剑合】：重铸至少2张同名牌或装备牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:jianhe') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: JIANHE, ownerId, step: 'pick-cards', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【剑合】：选择至少2张牌名相同的牌，或至少2张装备牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-cards') {
      const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => owner.zones.hand.includes(id))
      /*
       * 选择不合法（少于2张、既非同名也非全装备）一律按"放弃发动"处理并
       * 消耗本回合的使用次数——这是一个 optional 的主动技，AI 或玩家选出
       * 不满足条件的组合时，若不消耗次数，引擎会在同一个出牌阶段里把这个
       * 主动技一直重新报给它，压测里观察到过真实的死循环。
       */
      markUsedThisTurn(host.state, ownerId, JIANHE)
      if (picked.length < 2) return
      const names = new Set(picked.map((id) => host.state.cards[id]?.name))
      const allEquip = picked.every((id) => host.state.cards[id]?.category === 'equipment')
      if (names.size !== 1 && !allEquip) return
      const cardType = allEquip && names.size !== 1 ? 'equipment' : host.state.cards[picked[0]]?.category
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: JIANHE }, { sourceId: ownerId, cardIds: picked })
      drawCards(host.state, host.rng, ownerId, picked.length, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: JIANHE, skillName: '剑合', playerId: ownerId, logText: `${owner.nickname}发动【剑合】` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && !(host.state.jianheUsedTargets ?? []).includes(candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: JIANHE, ownerId, step: 'pick-target', data: { n: picked.length, cardType },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【剑合】：选择一名角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const { n, cardType } = resolution.data as { n: number; cardType: string }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.state.jianheUsedTargets = [...(host.state.jianheUsedTargets ?? []), targetId!]
      const eligibleCount = target.zones.hand.filter((id) => host.state.cards[id]?.category === cardType).length
      host.askSkill({
        skillId: JIANHE, ownerId, step: 'target-choose', data: { targetId, n, cardType, eligible: eligibleCount >= n },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【剑合】：请选择', timeoutMs: 20_000, optional: false,
          options: eligibleCount >= n
            ? [{ id: 'recast', label: `重铸${n}张同类型牌` }, { id: 'damage', label: '受到1点雷电伤害' }]
            : [{ id: 'damage', label: '受到1点雷电伤害' }],
        }),
      })
      return
    }
    if (resolution.step === 'target-choose') {
      const { targetId, n, cardType } = resolution.data as { targetId: PlayerId; n: number; cardType: string }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'recast') {
        const picked = target.zones.hand.filter((id) => host.state.cards[id]?.category === cardType).slice(0, n)
        for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: picked, reason: JIANHE }, { sourceId: targetId, cardIds: picked })
        drawCards(host.state, host.rng, targetId, picked.length, (n2, p) => { host.dispatch(n2, p) })
      } else {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'thunder', cardName: null })
      }
    }
  },
})

// ============================== 周处 ==============================

const SHANDUAN = 'shanduan'
const YILIE = 'yilie'

registerSkillRuntime({
  id: SHANDUAN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (!payload.playerId || payload.playerId !== ownerId) return
        if (payload.phase !== 'draw' && payload.phase !== 'play' && payload.phase !== 'discard') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: SHANDUAN, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'DrawPhase',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; count?: number }
        if (payload.playerId !== ownerId) return
        const alloc = host.state.shanduanAlloc
        if (alloc?.turnNumber !== host.state.turnNumber) return
        payload.count = alloc.draw
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: SHANDUAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【善断】：将1/2/3/4分配给摸牌数/攻击范围/杀次数上限/手牌上限', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'draw-slash-range-max', label: '摸牌4 杀3 范围2 上限1' },
          { id: 'draw4-max2-slash3-range1', label: '摸牌4 上限3 杀2 范围1' },
          { id: 'range-slash-draw-max', label: '范围4 杀3 摸牌2 上限1' },
          { id: 'max-slash-draw-range', label: '上限4 杀3 摸牌2 范围1' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const preset: Record<string, { draw: number; range: number; slash: number; maxCards: number }> = {
      'draw-slash-range-max': { draw: 4, slash: 3, range: 2, maxCards: 1 },
      'draw4-max2-slash3-range1': { draw: 4, maxCards: 3, slash: 2, range: 1 },
      'range-slash-draw-max': { range: 4, slash: 3, draw: 2, maxCards: 1 },
      'max-slash-draw-range': { maxCards: 4, slash: 3, draw: 2, range: 1 },
    }
    const optionId = (response.payload as { optionId?: string }).optionId ?? ''
    const chosen = preset[optionId]
    if (!chosen) return
    const bonus = owner.marks['shanduan-min-bonus'] ?? 0
    const values = { ...chosen }
    let min: keyof typeof values = 'maxCards'
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      if (values[key] < values[min]) min = key
    }
    values[min] += bonus
    owner.marks['shanduan-min-bonus'] = 0
    host.state.shanduanAlloc = { turnNumber: host.state.turnNumber, ...values }
    owner.attackRangeBonus = values.range - 1
    host.dispatch('SkillActivated', { skillId: SHANDUAN, skillName: '善断', playerId: ownerId, logText: `${owner.nickname}发动【善断】` }, { sourceId: ownerId })
  },
  globalSlashUses(state, ownerId, targetId) {
    if (targetId !== ownerId) return 0
    const alloc = state.shanduanAlloc
    return alloc?.turnNumber === state.turnNumber ? alloc.slash - 1 : 0
  },
  maxCardsBonus(state, ownerId) {
    const alloc = state.shanduanAlloc
    return alloc?.turnNumber === state.turnNumber ? alloc.maxCards - (playerOf(state, ownerId)?.hp ?? 0) : 0
  },
})

registerSkillRuntime({
  id: `${SHANDUAN}-damaged`,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || host.state.currentPlayerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      owner.marks['shanduan-min-bonus'] = (owner.marks['shanduan-min-bonus'] ?? 0) + 1
    },
  }],
})

/*
 * 义烈/冰心的"当基本牌使用"目前只精确实现桃/酒两种自向效果——这两种
 * 不需要额外目标选择，能直接复用现成的 recover/applyWineEffect。
 * 杀需要虚拟杀 + 目标选择，且这里是两张牌一起当一张虚拟牌的子牌，
 * 与 beginVirtualSlash 单一 cardId 的假设不完全对应，扩展成本明显更高；
 * 闪没有主动使用场景。均已知简化，未来若需要可以再补。
 */
function basicViewAsOptions(usedNames: string[]): Array<{ id: '桃' | '酒'; label: string }> {
  return (['桃', '酒'] as const).filter((name) => !usedNames.includes(name)).map((name) => ({ id: name, label: `当【${name}】使用` }))
}

function performSelfBasic(host: SkillHost, ownerId: PlayerId, skillId: string, subcardIds: CardId[], name: '桃' | '酒'): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  for (const cardId of subcardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId: ownerId, cardIds: subcardIds, reason: skillId }, { sourceId: ownerId, cardIds: subcardIds })
  host.dispatch('SkillActivated', { skillId, skillName: skillId === YILIE ? '义烈' : '冰心', playerId: ownerId, logText: `${owner.nickname}将牌当【${name}】使用` }, { sourceId: ownerId })
  if (name === '桃') { if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId) } else applyWineEffect(host)
}

registerSkillRuntime({
  id: YILIE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string }
      if (payload.phase !== 'prepare') return
      if (host.state.yilieUsedNames?.round !== host.state.roundNumber) host.state.yilieUsedNames = { round: host.state.roundNumber, names: [] }
    },
  }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    /*
     * 义烈没有"每回合限X次"的官方限制，但一次不合法的选择（选少了/颜色
     * 不同）不会消耗任何资源，若不加保护，AI 在同一回合里可能被反复
     * 提供这个主动技却一直选不出合法组合，造成死循环（压测已经在剑合
     * 上撞到过一次同类问题）。每回合最多重新发问 4 次，足够覆盖两种
     * 基本牌名的正常发动尝试。
     */
    const turnKey = owner.marks['yilie-turn'] === state.turnNumber
    if (turnKey && (owner.marks['yilie-attempts'] ?? 0) >= 4) return []
    const byColor = new Map<string, CardId[]>()
    for (const cardId of owner.zones.hand) {
      const color = state.cards[cardId]?.color
      if (!color) continue
      byColor.set(color, [...(byColor.get(color) ?? []), cardId])
    }
    if (![...byColor.values()].some((ids) => ids.length >= 2)) return []
    const usedNames = state.yilieUsedNames?.round === state.roundNumber ? state.yilieUsedNames.names : []
    if (basicViewAsOptions(usedNames).length === 0) return []
    return [{ id: 'skill:yilie', label: '发动【义烈】：将2张颜色相同的手牌当基本牌使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:yilie') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: YILIE, ownerId, step: 'pick-cards', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【义烈】：选择2张颜色相同的手牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-cards') {
      if (owner.marks['yilie-turn'] !== host.state.turnNumber) { owner.marks['yilie-turn'] = host.state.turnNumber; owner.marks['yilie-attempts'] = 0 }
      owner.marks['yilie-attempts'] = (owner.marks['yilie-attempts'] ?? 0) + 1
      const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])].filter((id) => owner.zones.hand.includes(id))
      if (picked.length !== 2) return
      const colors = new Set(picked.map((id) => host.state.cards[id]?.color))
      if (colors.size !== 1 || colors.has(undefined as never)) return
      const usedNames = host.state.yilieUsedNames?.round === host.state.roundNumber ? host.state.yilieUsedNames.names : []
      const options = basicViewAsOptions(usedNames)
      if (options.length === 0) return
      host.askSkill({
        skillId: YILIE, ownerId, step: 'pick-name', data: { picked },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【义烈】：当作哪种基本牌使用？', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'pick-name') {
      const { picked } = resolution.data as { picked: CardId[] }
      const name = (response.payload as { optionId?: string }).optionId as '桃' | '酒' | undefined
      if (!name || !picked.every((id) => owner.zones.hand.includes(id))) return
      host.state.yilieUsedNames ??= { round: host.state.roundNumber, names: [] }
      if (host.state.yilieUsedNames.round !== host.state.roundNumber) host.state.yilieUsedNames = { round: host.state.roundNumber, names: [] }
      host.state.yilieUsedNames.names.push(name)
      performSelfBasic(host, ownerId, YILIE, picked, name)
    }
  },
})

// ============================== 王祥 ==============================

const BINGXIN = 'bingxin'

registerSkillRuntime({
  id: BINGXIN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      host.state.bingxinUsedNames = { turnNumber: host.state.turnNumber, names: [] }
    },
  }],
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length !== owner.hp || owner.zones.hand.length === 0) return []
    const colors = new Set(owner.zones.hand.map((id) => state.cards[id]?.color).filter(Boolean))
    if (colors.size !== 1) return []
    const usedNames = state.bingxinUsedNames?.turnNumber === state.turnNumber ? state.bingxinUsedNames.names : []
    if (basicViewAsOptions(usedNames).length === 0) return []
    return [{ id: 'skill:bingxin', label: '发动【冰心】：摸1张牌，然后将1张手牌当基本牌使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:bingxin') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length !== owner.hp) return
    const colors = new Set(owner.zones.hand.map((id) => host.state.cards[id]?.color).filter(Boolean))
    if (colors.size !== 1) return
    drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: BINGXIN, skillName: '冰心', playerId: ownerId, logText: `${owner.nickname}发动【冰心】` }, { sourceId: ownerId })
    const usedNames = host.state.bingxinUsedNames?.turnNumber === host.state.turnNumber ? host.state.bingxinUsedNames.names : []
    const options = basicViewAsOptions(usedNames)
    if (options.length === 0) return
    host.askSkill({
      skillId: BINGXIN, ownerId, step: 'pick-name', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【冰心】：当作哪种基本牌使用？', timeoutMs: 20_000, optional: false, options,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-name') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const name = (response.payload as { optionId?: string }).optionId as '桃' | '酒' | undefined
    if (!name) return
    host.state.bingxinUsedNames ??= { turnNumber: host.state.turnNumber, names: [] }
    if (host.state.bingxinUsedNames.turnNumber !== host.state.turnNumber) host.state.bingxinUsedNames = { turnNumber: host.state.turnNumber, names: [] }
    host.state.bingxinUsedNames.names.push(name)
    performSelfBasic(host, ownerId, BINGXIN, [owner.zones.hand[0]], name)
  },
})

export const JIN_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'simashi', name: '司马师', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: TAOYIN, name: '韬隐', description: '游戏开始后第一次进入其他角色回合时，可以令其本回合手牌上限-2（身份局兼容版）。' },
      { id: YIMIE, name: '夷灭', description: '每回合限一次，你即将对一名其他角色造成伤害时，可以失去1点体力，令这次伤害变为其当前体力值；若这次伤害成功结算，其回复等量体力。' },
      { id: RUILUE, name: '睿略', description: '主公技，其他晋势力角色的出牌阶段限一次，可以交给你1张杀或有伤害效果的普通锦囊。' },
      { id: TAIRAN, name: '泰然', description: '锁定技，结束阶段回复所有已损失的体力并将手牌摸至体力上限；你下一个出牌阶段开始时，失去等量体力并弃置因此摸到的、仍在手牌中的牌。' },
    ],
  },
  {
    id: 'simazhao', name: '司马昭', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: TUISHI, name: '推弑', description: '游戏开始后第一次其他角色结束阶段，其选择对你指定的攻击范围内一名角色使用杀，或受到你造成的1点伤害（身份局兼容版）。' },
      { id: CHOUFA, name: '筹伐', description: '出牌阶段限一次，展示一名有手牌的其他角色的1张手牌，其手牌中所有与其类型不同的牌直到该角色回合结束均视为杀。' },
      { id: ZHAORAN, name: '昭然', description: '出牌阶段开始时可以展示所有手牌直到此阶段结束；本阶段因此失去某花色最后一张手牌时（每种花色限一次），摸1张或弃置一名其他角色1张牌。' },
      { id: CHENGWU, name: '成务', description: '主公技，锁定技，其他晋势力角色攻击范围内的角色均视为在你的攻击范围内。' },
    ],
  },
  {
    id: 'wangyuanji', name: '王元姬', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: SHIREN, name: '识人', description: '游戏开始后第一次其他角色回合开始时，若其有手牌，可以立即对其发动一次宴戏（身份局兼容版）。' },
      { id: YANXI, name: '宴戏', description: '出牌阶段限一次，选择一名有手牌的其他角色，随机取其1张手牌与牌堆顶2张牌混合，你从中选1张猜测其来自对方手牌；猜对获得全部3张，猜错只获得选中的那张，其余归位；因此获得的牌本回合不计入手牌上限。' },
    ],
  },
  {
    id: 'duyu', name: '杜预', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: SANCHEN, name: '三陈', description: '出牌阶段限一次，选择一名角色，其摸3张牌然后弃置3张牌；若弃置的牌基本/普通锦囊/装备三种类型各1张，其摸1张，本回合三陈视为未发动过（不能再选择该角色）。' },
      { id: ZHAOTAO, name: '昭讨', description: '觉醒技，准备阶段，若你本局已发动三陈至少3次，失去1点体力上限，获得【破竹】。' },
      { id: POZHU, name: '破竹', description: '出牌阶段，你可以将1张手牌当【出其不意】使用；若此前使用的破竹都成功造成过伤害，可以继续使用。' },
    ],
  },
  {
    id: 'yanghuiyu', name: '羊徽瑜', kingdom: 'jin', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: HUIRONG, name: '慧容', description: '游戏开始后，可以选择一名角色将其手牌调整至体力值（至多摸至5张）（身份局兼容版）。' },
      { id: CIWEI, name: '慈威', description: '其他角色于其回合内使用本回合第2张基本牌/普通锦囊时，你可以弃置1张牌，令这张牌完全无效。' },
      { id: CAIYUAN, name: '才媛', description: '锁定技，若你自上次回合结束以来未曾减少过体力，结束阶段摸2张牌。' },
    ],
  },
  {
    id: 'simazhou', name: '司马伷', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: CAIWANG, name: '才望', description: '你使用/打出的杀被响应，或你响应了针对你的杀时，若响应牌与原牌颜色相同，你可以弃置（强化后改为获得）对方1张牌。' },
      { id: NAXIANG, name: '纳降', description: '锁定技，其他角色对你造成或受到你造成的伤害后，其进入强化名单直到你下一回合开始，期间对其发动才望时改为获得。' },
    ],
  },
  {
    id: 'jiachong', name: '贾充', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: XIONGSHU, name: '凶竖', description: '其他角色出牌阶段开始时可以发动，X为本轮已发动次数并弃置X张牌，展示其1张手牌并秘密猜测其本阶段是否会使用同名牌，阶段结束时猜对则造成1点伤害，猜错则获得该牌。' },
      { id: JIANHUI, name: '奸回', description: '锁定技，记录上一个对你造成伤害的角色；其对你造成伤害后弃置1张牌，你对其造成伤害后摸1张牌。' },
    ],
  },
  {
    id: 'zhanghua', name: '张华', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: BIHUN, name: '弼昏', description: '锁定技，你使用牌指定唯一其他角色为目标时，若你的手牌数大于手牌上限，取消此次使用，该角色获得这张牌。' },
      { id: CHUANWU, name: '穿屋', description: '你造成或受到伤害后，X为你的攻击范围，你按顺序临时失去前X个技能直到回合结束，然后摸等量的牌。' },
      { id: JIANHE, name: '剑合', description: '出牌阶段限一次，重铸至少2张同名牌或装备牌，然后选择一名本阶段未被选择过的角色，其重铸等量同类型牌，或受到你造成的1点雷电伤害。' },
    ],
  },
  {
    id: 'zhouchu', name: '周处', kingdom: 'jin', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: SHANDUAN, name: '善断', description: '锁定技，摸牌/出牌/弃牌阶段开始时，将1234分配给本回合摸牌数/攻击范围/杀使用次数/手牌上限；你于回合外受到伤害后，下回合分配时最小值+1。' },
      { id: YILIE, name: '义烈', description: '你可以将2张颜色相同的手牌当任意基本牌使用；本轮内以义烈使用过的牌名不能再次使用。' },
    ],
  },
  {
    id: 'wangxiang', name: '王祥', kingdom: 'jin', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: BINGXIN, name: '冰心', description: '若你的手牌数等于体力值且所有手牌颜色相同，你可以摸1张牌，然后将1张手牌当基本牌使用（本回合已用过的基本牌名不能重复使用）。' },
    ],
  },
]
