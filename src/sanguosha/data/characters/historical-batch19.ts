import { moveCard, setCardAlias } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp, loseMaxHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { canUseSlash } from '../../engine/slash-rules'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { instantTrickActions } from '../../engine/cards/tricks'
import { executeUseCardAction, legalPlayActions } from '../../engine/cards/basic'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { getDistance } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { handleEquipmentLost } from '../../engine/equipment'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 独立历史人物第十九批：王昶、曹髦、庞会、胡班、诸葛尚、刘永、雷铜、吴兰、
 * 张陵、兀突骨。均此前项目未收录，全部作为独立 CharacterDefinition，
 * 不覆盖任何界/谋/族/国战/神版本。王昶/曹髦/庞会/诸葛尚/刘永/雷铜/吴兰
 * 锁《一将成名》当前页；胡班/张陵/兀突骨锁当前 OL（兀突骨明确不用一将成名
 * 强化版"燃超过2减2上限摸2"/"黑桃杀也触发悍勇"）。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ============================== 王昶 ==============================

const KAIJI = 'kaiji'
const PINGXI = 'pingxi'

registerSkillRuntime({
  id: KAIJI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, KAIJI)) return
      const yang = owner.marks['kaiji-yin'] !== 1
      host.queueSkill({ skillId: KAIJI, ownerId, step: 'ask', data: { yang } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, KAIJI)) return
    const { yang } = prompt.data as { yang: boolean }
    host.askSkill({
      skillId: KAIJI, ownerId, step: 'ask', data: { yang },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: yang ? `【开济】（阳）：是否摸${owner.maxHp}张牌？` : '【开济】（阴）：是否弃置1～体力上限张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const { yang } = resolution.data as { yang: boolean }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      if (yang) {
        markUsedThisTurn(host.state, ownerId, KAIJI)
        drawCards(host.state, host.rng, ownerId, owner.maxHp, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: KAIJI, skillName: '开济', playerId: ownerId, logText: `${owner.nickname}发动【开济】（阳），摸${owner.maxHp}张牌` }, { sourceId: ownerId })
        owner.marks['kaiji-yin'] = 1
        return
      }
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: KAIJI, ownerId, step: 'discard', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【开济】（阴）：弃置1～体力上限张牌', timeoutMs: 20_000, optional: false,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: Math.min(owner.maxHp, owner.zones.hand.length), purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const owner = playerOf(host.state, ownerId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const actual = cardIds.filter((id) => owner?.zones.hand.includes(id))
      if (!owner?.alive || actual.length === 0) return
      markUsedThisTurn(host.state, ownerId, KAIJI)
      for (const cardId of actual) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: actual, reason: KAIJI }, { sourceId: ownerId, cardIds: actual })
      host.dispatch('SkillActivated', { skillId: KAIJI, skillName: '开济', playerId: ownerId, logText: `${owner.nickname}发动【开济】（阴），弃置${actual.length}张牌` }, { sourceId: ownerId })
      owner.marks['kaiji-yin'] = 0
    }
  },
})

const PINGXI_DISCARD_REASONS = new Set(['discard', KAIJI])

registerSkillRuntime({
  id: PINGXI,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[]; reason?: string }
        if (payload.playerId !== ownerId || !payload.reason || !PINGXI_DISCARD_REASONS.has(payload.reason)) return
        const count = (payload.cardIds ?? []).filter((id) => host.state.zones.discardPile.includes(id)).length
        if (count === 0) return
        const current = host.state.turnDiscardCount?.turnNumber === host.state.turnNumber ? host.state.turnDiscardCount.count : 0
        host.state.turnDiscardCount = { turnNumber: host.state.turnNumber, count: current + count }
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const count = host.state.turnDiscardCount?.turnNumber === host.state.turnNumber ? host.state.turnDiscardCount.count : 0
        if (count <= 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: PINGXI, ownerId, step: 'pick', data: { candidateIds, count } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick') {
      const { candidateIds, count } = prompt.data as { candidateIds: PlayerId[]; count: number }
      const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
      if (alive.length === 0) return
      host.askSkill({
        skillId: PINGXI, ownerId, step: 'pick', data: { count },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【平袭】：选择至多${Math.min(count, alive.length)}名角色`, timeoutMs: 20_000, optional: true,
          candidateIds: alive, min: 0, max: Math.min(count, alive.length),
        }),
      })
      return
    }
    if (prompt.step === 'settle') {
      const { targets, index } = prompt.data as { targets: PlayerId[]; index: number }
      if (index >= targets.length) return
      const targetId = targets[index]
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) {
        host.queueSkill({ skillId: PINGXI, ownerId, step: 'settle', data: { targets, index: index + 1 } })
        return
      }
      host.askSkill({
        skillId: PINGXI, ownerId, step: 'settle-discard', data: { targets, index, targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【平袭】：弃置${target.nickname}的一张牌`, timeoutMs: 20_000, optional: false,
          cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick') {
      const owner = playerOf(host.state, ownerId)
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const alive = targetIds.filter((id) => playerOf(host.state, id)?.alive)
      if (!owner?.alive || alive.length === 0) return
      host.dispatch('SkillActivated', { skillId: PINGXI, skillName: '平袭', playerId: ownerId, logText: `${owner.nickname}发动【平袭】` }, { sourceId: ownerId })
      host.queueSkill({ skillId: PINGXI, ownerId, step: 'settle', data: { targets: alive, index: 0 } })
      return
    }
    if (resolution.step === 'settle-discard') {
      const { targets, index, targetId } = resolution.data as { targets: PlayerId[]; index: number; targetId: PlayerId }
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (owner?.alive && target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: PINGXI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        if (playerOf(host.state, targetId)?.alive) host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: PINGXI, countUsage: false })
      }
      host.queueSkill({ skillId: PINGXI, ownerId, step: 'settle', data: { targets, index: index + 1 } })
    }
  },
})

// ============================== 曹髦 ==============================

const QIANLONG = 'qianlong'
const FENSI = 'fensi'
const JUETAO = 'juetao'
const ZHUSHI = 'zhushi'

registerSkillRuntime({
  id: QIANLONG,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: QIANLONG, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || host.state.zones.drawPile.length === 0) return
    const top = host.state.zones.drawPile.slice(0, 3)
    host.state.zones.drawPile = host.state.zones.drawPile.slice(top.length)
    host.state.zones.processingArea.push(...top)
    host.dispatch('CardMove', { cardIds: top, reason: 'qianlong-reveal' }, { sourceId: ownerId, cardIds: top })
    const lostHp = owner.maxHp - owner.hp
    if (lostHp <= 0 || top.length === 0) {
      for (const cardId of top) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    const max = Math.min(lostHp, top.length)
    host.askSkill({
      skillId: QIANLONG, ownerId, step: 'pick', data: { top },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【潜龙】：获得至多${max}张`, timeoutMs: 20_000, optional: true,
        cardIds: top, hiddenCardSlots: [], min: 0, max, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    const { top } = resolution.data as { top: CardId[] }
    const remaining = top.filter((id) => host.state.zones.processingArea.includes(id))
    if (!owner?.alive) {
      for (const cardId of remaining) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
      return
    }
    const picked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => remaining.includes(id))
    if (picked.length > 0) {
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: picked, reason: QIANLONG }, { targetId: ownerId, cardIds: picked })
      host.dispatch('SkillActivated', { skillId: QIANLONG, skillName: '潜龙', playerId: ownerId, logText: `${owner.nickname}发动【潜龙】，获得${picked.length}张牌` }, { sourceId: ownerId })
    }
    const leftover = remaining.filter((id) => !picked.includes(id))
    for (const cardId of leftover) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  },
})

registerSkillRuntime({
  id: FENSI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.hp >= owner.hp).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FENSI, ownerId, step: 'pick', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【忿肆】：选择一名体力值不小于你的角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'slash-back') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!playerOf(host.state, targetId)?.alive || !playerOf(host.state, ownerId)?.alive) return
    host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: FENSI })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    host.dispatch('SkillActivated', { skillId: FENSI, skillName: '忿肆', playerId: ownerId, targetId, logText: `${owner.nickname}发动【忿肆】` }, { sourceId: ownerId, targetId })
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: '忿肆' })
    if (targetId === ownerId) return
    // 这1点伤害可能让A（targetId）进入濒死，其求桃流程还没走完时不能立刻再发起一次
    // 虚拟杀的伤害结算——交给 queueSkill 挪到下一个安全点（濒死流程真正结束之后）
    host.queueSkill({ skillId: FENSI, ownerId, step: 'slash-back', data: { targetId } })
  },
})

registerSkillRuntime({
  id: JUETAO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.hp !== 1 || usedThisTurn(host.state, ownerId, `${JUETAO}-limit`)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: JUETAO, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【决讨】：选择一名角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
    markUsedThisTurn(host.state, ownerId, `${JUETAO}-limit`)
    host.dispatch('SkillActivated', { skillId: JUETAO, skillName: '决讨', playerId: ownerId, targetId, logText: `${owner.nickname}发动【决讨】` }, { sourceId: ownerId, targetId })
    host.state.juetaoRestrict = { ownerId, targetId }
    host.queueSkill({ skillId: JUETAO, ownerId, step: 'loop', data: { targetId, guard: 0 } })
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'loop') return
    const { targetId, guard } = prompt.data as { targetId: PlayerId; guard: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || guard >= 30) { host.state.juetaoRestrict = undefined; return }
    if (host.state.zones.drawPile.length === 0) { host.state.juetaoRestrict = undefined; return }
    const cardId = host.state.zones.drawPile[host.state.zones.drawPile.length - 1]
    const card = host.state.cards[cardId]
    if (!card) { host.state.juetaoRestrict = undefined; return }
    // 决讨的目标限制已通过 juetaoRestrict + isTargetProhibited 接入合法性；这里只做基础牌类过滤，
    // 不逐条枚举官方全部使用方式——复杂多目标锦囊在这条限制下大多没有合法用法，会自然中止循环
    if (card.category !== 'basic' && card.category !== 'equipment' && !(card.category === 'trick')) { host.state.juetaoRestrict = undefined; return }
    host.state.zones.drawPile.pop()
    // 放进手牌而不是处理区：beginVirtualSlash 的 cardId 载体要求牌在使用者手牌里
    owner.zones.hand.push(cardId)
    host.dispatch('CardMove', { cardIds: [cardId], reason: 'juetao-bottom' }, { sourceId: ownerId, cardIds: [cardId] })
    const outcome = tryUseJuetaoCard(host, ownerId, targetId, cardId)
    if (outcome === 'stop') {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      host.state.juetaoRestrict = undefined
      return
    }
    // 杀的结算是异步的（可能求闪、进入濒死），不能在它完全结算之前就继续下一张——
    // 那会在濒死流程仍未结束时又发起一次伤害结算，触发引擎自己的不变量拦截。
    // 只有【桃】这类纯同步效果才安全继续循环；出杀之后老实停下来。
    if (outcome === 'slash') { host.state.juetaoRestrict = undefined; return }
    host.queueSkill({ skillId: JUETAO, ownerId, step: 'loop', data: { targetId, guard: guard + 1 } })
  },
})

function tryUseJuetaoCard(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, cardId: CardId): 'peach' | 'slash' | 'stop' {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  const card = host.state.cards[cardId]
  if (!owner?.alive || !card) return 'stop'
  if (card.name === '桃') {
    recover(host as never, ownerId, 1, ownerId)
  } else if (card.name === '杀' && target?.alive && canUseSlash(host.state, ownerId, false)) {
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JUETAO, cardId, countUsage: false })
    return 'slash'
  } else {
    return 'stop'
  }
  moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
  return 'peach'
}

registerSkillRuntime({
  id: ZHUSHI,
  triggers: [{
    event: 'Recover',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const recoveredId = payload.playerId
      if (!recoveredId || recoveredId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.identity !== 'lord') return
      const recovered = playerOf(host.state, recoveredId)
      if (!recovered?.alive || effectiveKingdomOf(host.state, recoveredId) !== 'wei') return
      if (host.state.currentPlayerId !== recoveredId) return
      if (host.state.zhushiTurnUsed === host.state.turnNumber) return
      host.queueSkill({ skillId: ZHUSHI, ownerId, step: 'ask', data: { recoveredId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { recoveredId } = prompt.data as { recoveredId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const recovered = playerOf(host.state, recoveredId)
    if (!owner?.alive || !recovered?.alive || host.state.zhushiTurnUsed === host.state.turnNumber) return
    host.askSkill({
      skillId: ZHUSHI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: recoveredId,
        prompt: `【助势】：是否令${owner.nickname}摸1张牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes' || host.state.zhushiTurnUsed === host.state.turnNumber) return
    host.state.zhushiTurnUsed = host.state.turnNumber
    drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: ZHUSHI, skillName: '助势', playerId: ownerId, logText: `${owner.nickname}发动【助势】，摸1张牌` }, { sourceId: ownerId })
  },
})

// ============================== 庞会 ==============================

const YIYONG = 'yiyong'
const SUCHOU = 'suchou'

registerSkillRuntime({
  id: YIYONG,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targetId = context.event.targetId
      if (!targetId || targetId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      host.state.yiyongPending = { ownerId, targetId, amount: (context.event.payload as { amount?: number }).amount ?? 1 }
      host.queueSkill({ skillId: YIYONG, ownerId, step: 'submit', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'submit') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || !host.state.yiyongPending) return
    // 引擎当前的 skillResolution 是单槽位的，同一时刻只能挂起一个技能询问，做不到
    // 真正的"双方同时秘密提交"；退而求其次改为顺序发问（先问目标），并未做到
    // 完全杜绝先手信息优势，属于已知简化
    host.askSkill({
      skillId: YIYONG, ownerId, step: 'submit-target', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: targetId,
        prompt: '【异勇】：秘密选择任意张牌弃置（可选0张）', timeoutMs: 20_000, optional: true,
        cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 0, max: target.zones.hand.length, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const pending = host.state.yiyongPending
    if (!pending) return
    if (resolution.step === 'submit-target') {
      pending.targetCards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) { host.state.yiyongPending = undefined; return }
      host.askSkill({
        skillId: YIYONG, ownerId, step: 'submit-owner', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【异勇】：选择任意张牌弃置（可选0张）', timeoutMs: 20_000, optional: true,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: owner.zones.hand.length, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'submit-owner') pending.ownerCards = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (pending.ownerCards === undefined || pending.targetCards === undefined) return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, pending.targetId)
    if (!owner?.alive || !target?.alive) { host.state.yiyongPending = undefined; return }
    const ownerCards = pending.ownerCards.filter((id) => owner.zones.hand.includes(id))
    const targetCards = pending.targetCards.filter((id) => target.zones.hand.includes(id))
    const rank = (cardId: CardId) => host.state.cards[cardId]?.rank ?? 0
    const p = ownerCards.reduce((sum, id) => sum + rank(id), 0)
    const t = targetCards.reduce((sum, id) => sum + rank(id), 0)
    if (ownerCards.length > 0) {
      moveCard(host.state, ownerCards[0], { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      for (const id of ownerCards.slice(1)) moveCard(host.state, id, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: ownerCards, reason: YIYONG }, { sourceId: ownerId, cardIds: ownerCards })
    }
    if (targetCards.length > 0) {
      for (const id of targetCards) moveCard(host.state, id, { kind: 'hand', playerId: pending.targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: pending.targetId, cardIds: targetCards, reason: YIYONG }, { sourceId: pending.targetId, cardIds: targetCards })
    }
    host.dispatch('SkillActivated', { skillId: YIYONG, skillName: '异勇', playerId: ownerId, targetId: pending.targetId, logText: `${owner.nickname}发动【异勇】` }, { sourceId: ownerId, targetId: pending.targetId })
    if (p <= t) drawCards(host.state, host.rng, ownerId, targetCards.length + 1, (n, pl) => { host.dispatch(n, pl) })
    if (p >= t) host.state.yiyongDamageBonus = { ownerId, targetId: pending.targetId }
    host.state.yiyongPending = undefined
  },
})

registerSkillRuntime({
  id: SUCHOU,
  outgoingDamage(state, ownerId, context) {
    const bonus = state.yiyongDamageBonus
    if (!bonus || bonus.ownerId !== ownerId || bonus.targetId !== context.targetId) return null
    return { amount: context.amount + 1 }
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !ownedHasSuchou(host.state, ownerId)) return
      host.askSkill({
        skillId: SUCHOU, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【夙仇】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'losehp', label: '失去1点体力，本阶段你使用的牌均不能被响应' },
            { id: 'losemaxhp', label: '失去1点体力上限，本阶段你使用的牌均不能被响应' },
            { id: 'remove', label: '永久失去【夙仇】' },
          ],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'remove') {
      owner.marks['suchou-lost'] = 1
      host.dispatch('SkillActivated', { skillId: SUCHOU, skillName: '夙仇', playerId: ownerId, logText: `${owner.nickname}永久失去【夙仇】` }, { sourceId: ownerId })
      return
    }
    if (optionId === 'losehp') loseHp(host as never, ownerId, 1, SUCHOU)
    else if (optionId === 'losemaxhp' && owner.maxHp > 1) loseMaxHp(host as never, ownerId, 1, SUCHOU)
    else return
    host.state.suchouNoResponse = { ownerId, turnNumber: host.state.turnNumber }
    host.dispatch('SkillActivated', { skillId: SUCHOU, skillName: '夙仇', playerId: ownerId, logText: `${owner.nickname}发动【夙仇】，本阶段所用的牌均不能被响应` }, { sourceId: ownerId })
  },
  trickUnresponsive(state, ownerId, targetId, cardName) {
    void targetId
    void cardName
    return suchouActive(state, ownerId)
  },
  slashUndodgeable(state, ownerId, targetId) {
    void targetId
    return suchouActive(state, ownerId)
  },
})

function suchouActive(state: SanguoshaState, ownerId: PlayerId): boolean {
  const flag = state.suchouNoResponse
  return Boolean(flag && flag.ownerId === ownerId && flag.turnNumber === state.turnNumber && state.phase === 'play')
}

function ownedHasSuchou(state: SanguoshaState, ownerId: PlayerId): boolean {
  return playerOf(state, ownerId)?.marks['suchou-lost'] !== 1
}

// ============================== 胡班 ==============================

const HUIYUN = 'huiyun'

registerSkillRuntime({
  id: HUIYUN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // 必须确认至少有一张手牌真能当火攻用出去，否则问了选牌也没有下文——
    // AI 会在同一个没有出路的动作上反复重试，压测在这上面死锁过
    const hasUsable = owner.zones.hand.some((cardId) => instantTrickActions(state, ownerId, cardId, '火攻').some((action) => action.kind === 'use-card'))
    if (!hasUsable) return []
    return [{ id: 'skill:huiyun', label: '发动【晖云】：将1张牌当【火攻】使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:huiyun') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: HUIYUN, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【晖云】：选择1张牌当【火攻】使用', timeoutMs: 20_000, optional: false,
        cardIds: owner.zones.hand.filter((cardId) => instantTrickActions(host.state, ownerId, cardId, '火攻').some((action) => action.kind === 'use-card')),
        hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const legalActions = instantTrickActions(host.state, ownerId, cardId, '火攻').filter((action) => action.kind === 'use-card')
      if (legalActions.length === 0) return
      const action = legalActions.find((candidate) => candidate.targetIds.length === 1) ?? legalActions[0]
      host.state.huiyunPendingSubcard = { ownerId, cardId, targetId: action.targetIds[0] }
      executeUseCardAction(host as never, ownerId, action)
    }
  },
})

registerSkillRuntime({
  id: `${HUIYUN}-followup`,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.huiyunPendingSubcard
      if (!pending || pending.ownerId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean; targetIds?: PlayerId[] }
      if (payload.cardId !== pending.cardId) return
      host.state.huiyunPendingSubcard = undefined
      if (payload.cancelled) return
      const round = host.state.roundNumber
      const used = host.state.huiyunRoundOptions?.round === round ? host.state.huiyunRoundOptions.used : []
      const available = [1, 2, 3].filter((option) => !used.includes(option))
      if (available.length === 0) return
      const targetId = pending.targetId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      host.queueSkill({ skillId: HUIYUN, ownerId, step: 'offer', data: { targetId, shownCardId: pending.cardId, available } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'offer') return
    const { targetId, available } = prompt.data as { targetId: PlayerId; shownCardId: CardId; available: number[] }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const labels: Record<number, string> = {
      1: '使用刚才展示的那张牌，然后重铸所有手牌',
      2: '使用1张手牌，然后重铸刚才展示的那张牌',
      3: '摸1张牌',
    }
    host.askSkill({
      skillId: HUIYUN, ownerId, step: 'offer', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: targetId,
        prompt: '【晖云】：请选择', timeoutMs: 20_000, optional: false,
        options: available.map((option) => ({ id: String(option), label: labels[option] })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'offer') return
    const { targetId, shownCardId } = resolution.data as { targetId: PlayerId; shownCardId: CardId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const optionId = Number((response.payload as { optionId?: string }).optionId)
    const round = host.state.roundNumber
    const used = host.state.huiyunRoundOptions?.round === round ? host.state.huiyunRoundOptions.used : []
    host.state.huiyunRoundOptions = { round, used: [...used, optionId] }
    host.dispatch('SkillActivated', { skillId: HUIYUN, skillName: '晖云', playerId: ownerId, targetId, logText: `${target.nickname}选择晖云的第${optionId}项` }, { sourceId: ownerId, targetId })
    if (optionId === 3) {
      drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
      return
    }
    if (optionId === 1) {
      if (target.zones.hand.includes(shownCardId)) {
        const legal = legalUseCardActionsFor(host.state, targetId, shownCardId)
        if (legal.length > 0) executeUseCardAction(host as never, targetId, legal[0])
      }
      const rest = [...target.zones.hand]
      for (const cardId of rest) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        const drawn = host.state.zones.drawPile.shift()
        if (drawn) moveCard(host.state, drawn, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      }
      if (rest.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: rest, reason: HUIYUN }, { sourceId: targetId, cardIds: rest })
      return
    }
    if (optionId === 2) {
      if (target.zones.hand.length > 0) {
        const legal = legalUseCardActionsFor(host.state, targetId, target.zones.hand[0])
        if (legal.length > 0) executeUseCardAction(host as never, targetId, legal[0])
      }
      if (target.zones.hand.includes(shownCardId)) {
        moveCard(host.state, shownCardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [shownCardId], reason: HUIYUN }, { sourceId: targetId, cardIds: [shownCardId] })
        const drawn = host.state.zones.drawPile.shift()
        if (drawn) moveCard(host.state, drawn, { kind: 'drawPile' }, { kind: 'hand', playerId: targetId })
      }
    }
  },
})

function legalUseCardActionsFor(state: SanguoshaState, playerId: PlayerId, cardId: CardId) {
  return legalPlayActions(state, playerId).filter((action): action is Extract<typeof action, { kind: 'use-card' }> => (
    action.kind === 'use-card' && action.cardIds.includes(cardId)
  ))
}

// ============================== 诸葛尚 ==============================

const SANGU = 'sangu'
const YIZU = 'yizu'
const SANGU_EXCLUDED_NAMES = new Set(['借刀杀人', '无懈可击'])
const SANGU_NAME_POOL = ['杀', '决斗', '过河拆桥', '顺手牵羊', '南蛮入侵', '万箭齐发', '五谷丰登', '火攻', '无中生有', '桃园结义']

registerSkillRuntime({
  id: SANGU,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardName?: string }
        if (!payload.cardName) return
        const used = host.state.sanguSelfUsedNames?.turnNumber === host.state.turnNumber ? host.state.sanguSelfUsedNames.names : []
        if (used.includes(payload.cardName)) return
        host.state.sanguSelfUsedNames = { turnNumber: host.state.turnNumber, names: [...used, payload.cardName] }
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: SANGU, ownerId, step: 'names', data: { candidateIds, names: [] } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'names') {
      const { candidateIds, names } = prompt.data as { candidateIds: PlayerId[]; names: string[] }
      if (names.length >= 3) {
        host.queueSkill({ skillId: SANGU, ownerId, step: 'target', data: { candidateIds, names } })
        return
      }
      const options = SANGU_NAME_POOL.filter((name) => !SANGU_EXCLUDED_NAMES.has(name))
      host.askSkill({
        skillId: SANGU, ownerId, step: 'names', data: { candidateIds, names },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【三顾】：依次选择至多3张牌名（已选${names.length}个，可停止）`, timeoutMs: 20_000, optional: true,
          options: [...options.map((name) => ({ id: name, label: name })), { id: '__stop__', label: '不再选择' }],
        }),
      })
      return
    }
    if (prompt.step === 'target') {
      const { candidateIds, names } = prompt.data as { candidateIds: PlayerId[]; names: string[] }
      if (names.length === 0) return
      host.askSkill({
        skillId: SANGU, ownerId, step: 'target', data: { names },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【三顾】：选择一名其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'names') {
      const { candidateIds, names } = resolution.data as { candidateIds: PlayerId[]; names: string[] }
      const optionId = (response.payload as { optionId?: string }).optionId
      const nextNames = optionId && optionId !== '__stop__' ? [...names, optionId] : names
      if (!optionId || optionId === '__stop__' || nextNames.length >= 3) {
        host.queueSkill({ skillId: SANGU, ownerId, step: 'target', data: { candidateIds, names: nextNames } })
        return
      }
      host.queueSkill({ skillId: SANGU, ownerId, step: 'names', data: { candidateIds, names: nextNames } })
      return
    }
    if (resolution.step === 'target') {
      const { names } = resolution.data as { names: string[] }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || names.length === 0) return
      host.state.sanguPending = { ownerId, targetId, names }
      host.dispatch('SkillActivated', { skillId: SANGU, skillName: '三顾', playerId: ownerId, targetId, logText: `${owner.nickname}发动【三顾】，绑定${names.join('/')}` }, { sourceId: ownerId, targetId })
      const usedThisTurnNames = host.state.sanguSelfUsedNames?.turnNumber === host.state.turnNumber ? host.state.sanguSelfUsedNames.names : []
      if (names.every((name) => usedThisTurnNames.includes(name))) {
        host.state.sanguProtect = { ownerId, cardNames: names }
      }
    }
  },
})

registerSkillRuntime({
  id: `${SANGU}-arm`,
  triggers: [{
    event: 'PhaseStart',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      const pending = host.state.sanguPending
      if (payload.phase !== 'play' || !pending || pending.targetId !== payload.playerId) return
      host.state.sanguArmed = { ownerId: pending.ownerId, targetId: pending.targetId, names: pending.names, index: 0, usedNames: [] }
      host.state.sanguPending = undefined
      // 转换钩子必须挂在真正出牌的那个人（目标A）身上，interceptPlayAction 按技能拥有者扫描，
      // 挂在诸葛尚自己身上时 ownerId 永远是诸葛尚，判断不出"这次是不是A在出牌"
      replaceTemporarySkill(host.state, pending.targetId, SANGU, `${SANGU}-transform`)
    },
  }],
})

registerSkillRuntime({
  id: `${SANGU}-transform`,
  interceptPlayAction(host, ownerId, action) {
    const armed = host.state.sanguArmed
    if (!armed || armed.targetId !== ownerId || action.playerId !== ownerId) return false
    if (armed.index >= armed.names.length) { replaceTemporarySkill(host.state, ownerId, SANGU, null); return false }
    if (action.cardIds.length !== 1 || action.equipmentSlot) return false
    const card = host.state.cards[action.cardIds[0]]
    if (!card || card.virtual || (card.category !== 'basic' && card.category !== 'trick')) return false
    const name = armed.names[armed.index]
    if (action.targetIds.length <= 1 && action.asCardName !== name) action.asCardName = name
    armed.usedNames.push(name)
    armed.index += 1
    if (armed.index >= armed.names.length) replaceTemporarySkill(host.state, ownerId, SANGU, null)
    return false
  },
})

registerSkillRuntime({
  id: `${SANGU}-protect`,
  preventsDamage(state, ownerId, side, context) {
    if (side !== 'target') return false
    const protect = state.sanguProtect
    if (!protect || protect.ownerId !== ownerId || !context.cardName) return false
    return protect.cardNames.includes(context.cardName)
  },
})

registerSkillRuntime({
  id: YIZU,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetId?: PlayerId }
      if (payload.targetId !== ownerId || (payload.cardName !== '杀' && payload.cardName !== '决斗')) return
      if (usedThisTurn(host.state, ownerId, YIZU)) return
      const sourceId = context.event.sourceId
      const owner = playerOf(host.state, ownerId)
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!owner?.alive || !source?.alive || owner.hp > source.hp) return
      markUsedThisTurn(host.state, ownerId, YIZU)
      recover(host as never, ownerId, 1, ownerId)
      host.dispatch('SkillActivated', { skillId: YIZU, skillName: '轶祖', playerId: ownerId, logText: `${owner.nickname}发动【轶祖】` }, { sourceId: ownerId })
    },
  }],
})

// ============================== 刘永 ==============================

const ZHUNING = 'zhuning'
const FENGXIANG = 'fengxiang'
const DAMAGE_TRICKS = ['决斗', '南蛮入侵', '万箭齐发', '火攻']

function xiCountOf(state: SanguoshaState, playerId: PlayerId): number {
  const xi = state.xiCardIds ?? []
  const player = playerOf(state, playerId)
  if (!player) return 0
  return player.zones.hand.filter((id) => xi.includes(id)).length
}

function uniqueMaxXiHolder(state: SanguoshaState): PlayerId | null {
  const alive = state.players.filter((p) => p.alive)
  if (alive.length === 0) return null
  const counts = alive.map((p) => ({ id: p.id, count: xiCountOf(state, p.id) }))
  const max = Math.max(...counts.map((c) => c.count))
  if (max <= 0) return null
  const top = counts.filter((c) => c.count === max)
  return top.length === 1 ? top[0].id : null
}

registerSkillRuntime({
  id: ZHUNING,
  triggers: [
    {
      event: 'GainCard',
      handle(host, ownerId) { checkFengxiangChange(host, ownerId) },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId) { checkFengxiangChange(host, ownerId) },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const holder = uniqueMaxXiHolder(host.state)
        if (holder && xiCountOf(host.state, holder) > 0) {
          recover(host as never, holder, 1, ownerId)
          host.dispatch('SkillActivated', { skillId: FENGXIANG, skillName: '封乡', playerId: ownerId, targetId: holder, logText: `${playerOf(host.state, holder)!.nickname}回复1点体力` }, { sourceId: ownerId, targetId: holder })
        } else {
          drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
          host.dispatch('SkillActivated', { skillId: FENGXIANG, skillName: '封乡', playerId: ownerId, logText: `${owner.nickname}发动【封乡】，摸1张牌` }, { sourceId: ownerId })
        }
        host.state.fengxiangUniqueHolder = uniqueMaxXiHolder(host.state)
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.state.zhuningLimit = { ownerId, turnNumber: host.state.turnNumber, limit: 1 }
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length > 0) host.queueSkill({ skillId: ZHUNING, ownerId, step: 'ask', data: { candidateIds } })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; sourceSkillId?: string }
        if (payload.sourceSkillId !== ZHUNING || !payload.cardId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (cardDamageDealt(host.state, payload.cardId) > 0) return
        const limit = host.state.zhuningLimit
        if (limit && limit.ownerId === ownerId && limit.turnNumber === host.state.turnNumber && limit.limit < 2) {
          host.state.zhuningLimit = { ...limit, limit: 2 }
          host.dispatch('SkillActivated', { skillId: ZHUNING, skillName: '诛佞', playerId: ownerId, logText: `${owner.nickname}的【诛佞】未造成伤害，本阶段限制变为2次` }, { sourceId: ownerId })
          const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
          if (candidateIds.length > 0) host.queueSkill({ skillId: ZHUNING, ownerId, step: 'ask', data: { candidateIds } })
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const limit = host.state.zhuningLimit
    if (!owner?.alive || owner.zones.hand.length === 0 || !limit || limit.turnNumber !== host.state.turnNumber) return
    const used = (owner.turnUsedSkills.filter((id) => id === ZHUNING)).length
    if (used >= limit.limit) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: ZHUNING, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【诛佞】：选择一名其他角色，交给其至少1张牌', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: ZHUNING, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【诛佞】：交给对方至少1张牌', timeoutMs: 20_000, optional: false,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const actual = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (!target?.alive || actual.length === 0) return
      owner.turnUsedSkills.push(ZHUNING)
      for (const cardId of actual) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: actual, reason: ZHUNING }, { sourceId: ownerId, cardIds: actual })
      host.dispatch('GainCard', { playerId: targetId, cardIds: actual, reason: ZHUNING }, { sourceId: ownerId, targetId, cardIds: actual })
      host.state.xiCardIds = [...new Set([...(host.state.xiCardIds ?? []), ...actual])]
      host.dispatch('SkillActivated', { skillId: ZHUNING, skillName: '诛佞', playerId: ownerId, targetId, logText: `${owner.nickname}发动【诛佞】，标记${actual.length}张"隙"` }, { sourceId: ownerId, targetId })
      host.askSkill({
        skillId: ZHUNING, ownerId, step: 'choose-damage', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【诛佞】：视为造成伤害的方式', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'slash', label: '视为使用一张无次数限制的【杀】' },
            ...(availableDamageTrick(host.state, ownerId) ? [{ id: 'trick', label: `视为使用【${availableDamageTrick(host.state, ownerId)}】` }] : []),
          ],
        }),
      })
      return
    }
    if (resolution.step === 'choose-damage') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (optionId === 'slash') {
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: ZHUNING, ownerId, step: 'slash-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【诛佞】：选择杀的目标', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
      } else if (optionId === 'trick') {
        const name = availableDamageTrick(host.state, ownerId)
        if (!name) return
        const virtualId = createVirtualTrick(host.state, ownerId, name, ZHUNING)
        const legal = instantTrickActions(host.state, ownerId, virtualId, name).filter((action) => action.kind === 'use-card')
        if (legal.length === 0) { delete host.state.cards[virtualId]; return }
        executeUseCardAction(host as never, ownerId, legal[host.rng.nextInt(legal.length)])
      }
      return
    }
    if (resolution.step === 'slash-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: ZHUNING, countUsage: false })
    }
  },
})

function availableDamageTrick(state: SanguoshaState, ownerId: PlayerId): string | null {
  const probeId = `virtual-probe:${ownerId}`
  for (const name of DAMAGE_TRICKS) {
    state.cards[probeId] = { id: probeId, ruleset: state.rulesetVersion, expansion: 'standard', name, suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true }
    let usable = false
    try { usable = instantTrickActions(state, ownerId, probeId, name).some((action) => action.kind === 'use-card') } finally { delete state.cards[probeId] }
    if (usable) return name
  }
  return null
}


function checkFengxiangChange(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const newHolder = uniqueMaxXiHolder(host.state)
  const oldHolder = host.state.fengxiangUniqueHolder
  if (oldHolder === undefined) { host.state.fengxiangUniqueHolder = newHolder; return }
  if (newHolder && newHolder !== oldHolder) {
    host.state.fengxiangUniqueHolder = newHolder
    drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
    host.dispatch('SkillActivated', { skillId: FENGXIANG, skillName: '封乡', playerId: ownerId, logText: `${owner.nickname}发动【封乡】，摸1张牌` }, { sourceId: ownerId })
  } else if (!newHolder) {
    host.state.fengxiangUniqueHolder = null
  }
}

registerSkillRuntime({
  id: FENGXIANG,
})

// ============================== 雷铜 ==============================

const KUIJI = 'kuiji'

registerSkillRuntime({
  id: KUIJI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, KUIJI)) return
      const blacks = owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'basic' && host.state.cards[id]?.color === 'black')
      if (blacks.length === 0) return
      if (owner.zones.judgingArea.some((id) => host.state.cards[id]?.name === '兵粮寸断')) return
      host.askSkill({
        skillId: KUIJI, ownerId, step: 'pick-card', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【溃击】：选择1张黑色基本牌当【兵粮寸断】置入你的判定区', timeoutMs: 20_000, optional: true,
          cardIds: blacks, hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      if (owner.zones.judgingArea.some((id) => host.state.cards[id]?.name === '兵粮寸断')) return
      markUsedThisTurn(host.state, ownerId, KUIJI)
      setCardAlias(host.state, cardId, '兵粮寸断')
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'judgingArea', playerId: ownerId })
      host.dispatch('CardMove', { cardIds: [cardId], reason: 'kuiji-place' }, { sourceId: ownerId, targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: KUIJI, skillName: '溃击', playerId: ownerId, logText: `${owner.nickname}发动【溃击】` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      const maxHp = Math.max(...host.state.players.filter((p) => p.alive).map((p) => p.hp))
      const candidateIds = host.state.players.filter((p) => p.alive && p.id !== ownerId && p.hp === maxHp).map((p) => p.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: KUIJI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【溃击】：选择一名体力值最高的其他角色，造成2点伤害', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.state.kuijiPending = { ownerId, targetId }
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'normal', cardName: '溃击' })
    }
  },
})

registerSkillRuntime({
  id: `${KUIJI}-followup`,
  triggers: [{
    event: 'EnterDying',
    handle(host, ownerId, context) {
      const pending = host.state.kuijiPending
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!pending || pending.ownerId !== ownerId || pending.targetId !== payload.playerId) return
      host.state.kuijiPending = undefined
      const minHp = Math.min(...host.state.players.filter((p) => p.alive).map((p) => p.hp))
      const candidateIds = host.state.players.filter((p) => p.alive && p.id !== pending.targetId && p.hp === minHp).map((p) => p.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: KUIJI, ownerId, step: 'rescue', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'rescue') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner) return
    const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive)
    if (alive.length === 0) return
    host.askSkill({
      skillId: KUIJI, ownerId, step: 'rescue', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【溃击】：选择另一名体力值最低的角色回复1点体力', timeoutMs: 20_000, optional: true,
        candidateIds: alive, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'rescue') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    recover(host as never, targetId, 1, ownerId)
  },
})

// ============================== 吴兰 ==============================

const CUIRUI = 'cuirui'

registerSkillRuntime({
  id: CUIRUI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, CUIRUI)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && getDistance(host.state, ownerId, candidate.id) <= 1
        && (candidate.zones.hand.length + Object.values(candidate.zones.equipment).filter(Boolean).length + candidate.zones.judgingArea.length) > 0).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: CUIRUI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【挫锐】：选择距离1以内的一名角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const pool = target ? [...target.zones.hand, ...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea] : []
      if (!target?.alive || pool.length === 0) return
      host.askSkill({
        skillId: CUIRUI, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【挫锐】：弃置${target.nickname}区域中1张牌`, timeoutMs: 20_000, optional: false,
          cardIds: pool, hiddenCardSlots: [], min: 1, max: 1, purpose: 'skill',
        }),
      })
      return
    }
    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId) return
      const color = host.state.cards[cardId]?.color
      const from = target.zones.hand.includes(cardId)
        ? { kind: 'hand' as const, playerId: targetId }
        : target.zones.judgingArea.includes(cardId)
          ? { kind: 'judgingArea' as const, playerId: targetId }
          : { kind: 'equipment' as const, playerId: targetId, slot: (Object.entries(target.zones.equipment).find(([, id]) => id === cardId)?.[0] as never) }
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CUIRUI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      markUsedThisTurn(host.state, ownerId, CUIRUI)
      host.dispatch('SkillActivated', { skillId: CUIRUI, skillName: '挫锐', playerId: ownerId, targetId, logText: `${owner.nickname}发动【挫锐】` }, { sourceId: ownerId, targetId })
      if (!color) return
      const bCandidates = host.state.players.filter((p) => p.alive && p.id !== ownerId && p.id !== targetId).map((p) => p.id)
      if (bCandidates.length === 0) return
      host.askSkill({
        skillId: CUIRUI, ownerId, step: 'pick-b', data: { color },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【挫锐】：选择另一名其他角色', timeoutMs: 20_000, optional: true,
          candidateIds: bCandidates, min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-b') {
      const { color } = resolution.data as { color: 'red' | 'black' }
      const [bId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const b = bId ? playerOf(host.state, bId) : undefined
      if (!b?.alive) return
      const sameColorEquip = Object.entries(b.zones.equipment).filter(([, id]) => id && host.state.cards[id as CardId]?.color === color)
      const options: Array<{ id: string; label: string }> = []
      if (sameColorEquip.length > 0) options.push({ id: 'equip', label: `弃置${b.nickname}至多2张${color === 'red' ? '红色' : '黑色'}装备牌` })
      if (b.zones.hand.length > 0) options.push({ id: 'hand', label: `展示${b.nickname}共计2张手牌` })
      if (options.length === 0) return
      host.askSkill({
        skillId: CUIRUI, ownerId, step: 'branch', data: { color, bId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【挫锐】：请选择', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }
    if (resolution.step === 'branch') {
      const { color, bId } = resolution.data as { color: 'red' | 'black'; bId: PlayerId }
      const b = playerOf(host.state, bId)
      if (!b?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'equip') {
        const slots = Object.entries(b.zones.equipment).filter(([, id]) => id && host.state.cards[id as CardId]?.color === color).slice(0, 2)
        const cardIds: CardId[] = []
        for (const [slot, id] of slots) {
          moveCard(host.state, id as CardId, { kind: 'equipment', playerId: bId, slot: slot as never }, { kind: 'discardPile' })
          handleEquipmentLost(host as never, bId, id as CardId)
          cardIds.push(id as CardId)
        }
        if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: bId, cardIds, reason: CUIRUI }, { sourceId: ownerId, targetId: bId, cardIds })
      } else if (optionId === 'hand') {
        const count = Math.min(2, b.zones.hand.length)
        const shown = [...b.zones.hand].slice(0, count)
        host.dispatch('CardMove', { cardIds: shown, reason: 'cuirui-reveal' }, { sourceId: ownerId, targetId: bId, cardIds: shown })
        const gained = shown.filter((id) => host.state.cards[id]?.color === color)
        if (gained.length > 0) {
          for (const id of gained) moveCard(host.state, id, { kind: 'hand', playerId: bId }, { kind: 'hand', playerId: ownerId })
          host.dispatch('LoseCard', { playerId: bId, cardIds: gained, reason: CUIRUI }, { sourceId: ownerId, targetId: bId, cardIds: gained })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: gained, reason: CUIRUI }, { sourceId: bId, targetId: ownerId, cardIds: gained })
        }
      }
    }
  },
})

// ============================== 张陵 ==============================

const HUQI = 'huqi'
const SHOUFU = 'shoufu'
const HUQI_JUDGE_TAG = 'huqi-red-slash'

registerJudgmentContinuation(HUQI_JUDGE_TAG, (host, judged, data) => {
  const { ownerId, sourceId } = data as { ownerId: PlayerId; sourceId: PlayerId }
  if (judged.color !== 'red') return
  const owner = playerOf(host.state, ownerId)
  const source = playerOf(host.state, sourceId)
  if (!owner?.alive || !source?.alive) return
  host.dispatch('SkillActivated', { skillId: HUQI, skillName: '虎骑', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【虎骑】` }, { sourceId: ownerId, targetId: sourceId })
  host.beginVirtualSlash({ sourceId: ownerId, targetId: sourceId, sourceSkillId: HUQI })
})

registerSkillRuntime({
  id: HUQI,
  distanceModifier: { toOthers: () => -1 },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || host.state.currentPlayerId === ownerId) return
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: HUQI, ownerId, step: 'judge', data: { sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'judge') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    performJudgment(host as never, ownerId, '虎骑', { tag: HUQI_JUDGE_TAG, data: { ownerId, sourceId } })
  },
})

registerSkillRuntime({
  id: SHOUFU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, SHOUFU)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !(host.state.luPile?.[candidate.id])).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: SHOUFU, ownerId, step: 'draw', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'draw') {
      if (usedThisTurn(host.state, ownerId, SHOUFU)) return
      markUsedThisTurn(host.state, ownerId, SHOUFU)
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.queueSkill({ skillId: SHOUFU, ownerId, step: 'pick', data: prompt.data })
      return
    }
    if (prompt.step === 'pick') {
      if (owner.zones.hand.length === 0) return
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      const alive = candidateIds.filter((id) => playerOf(host.state, id)?.alive && !host.state.luPile?.[id])
      if (alive.length === 0) return
      host.askSkill({
        skillId: SHOUFU, ownerId, step: 'give-card', data: { candidateIds: alive },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【授符】：选择1张手牌置于一名角色武将牌上，称为"箓"', timeoutMs: 20_000, optional: true,
          cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1, purpose: 'skill',
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'give-card') {
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      host.state.pendingLuCard = cardId
      host.askSkill({
        skillId: SHOUFU, ownerId, step: 'pick-target', data: { candidateIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【授符】：选择一名没有"箓"的其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const cardId = host.state.pendingLuCard
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.luPile?.[targetId!]) { host.state.pendingLuCard = undefined; return }
      const cardType = host.state.cards[cardId]?.category ?? 'basic'
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: targetId!, pile: 'lu' })
      host.state.luPile = { ...(host.state.luPile ?? {}), [targetId!]: { cardId, cardType } }
      host.state.pendingLuCard = undefined
      replaceTemporarySkill(host.state, targetId!, SHOUFU, LU_RESTRICT)
      host.dispatch('SkillActivated', { skillId: SHOUFU, skillName: '授符', playerId: ownerId, targetId, logText: `${owner.nickname}发动【授符】，${target.nickname}获得"箓"` }, { sourceId: ownerId, targetId })
    }
  },
})

const LU_RESTRICT = 'lu-restrict'

registerSkillRuntime({
  id: LU_RESTRICT,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        clearLu(host, ownerId)
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
        const entry = host.state.luPile?.[ownerId]
        const ledger = host.state.discardPhaseLedger
        if (!entry || !ledger || ledger.ownerPlayerId !== ownerId) return
        const sameType = ledger.records.filter((record) => host.state.cards[record.cardId]?.category === entry.cardType).length
        if (sameType >= 2) clearLu(host, ownerId)
      },
    },
  ],
  locksOwnCategories(state, ownerId) {
    const entry = state.luPile?.[ownerId]
    return entry ? [entry.cardType] : []
  },
})

function clearLu(host: SkillHost, playerId: PlayerId): void {
  const entry = host.state.luPile?.[playerId]
  if (!entry) return
  const player = playerOf(host.state, playerId)
  if (player && (player.characterPiles?.lu ?? []).includes(entry.cardId)) {
    moveCard(host.state, entry.cardId, { kind: 'characterPile', playerId, pile: 'lu' }, { kind: 'discardPile' })
  }
  const rest = { ...(host.state.luPile ?? {}) }
  delete rest[playerId]
  host.state.luPile = rest
  replaceTemporarySkill(host.state, playerId, SHOUFU, null)
}

// ============================== 兀突骨 ==============================

const RANSHANG = 'ranshang'
const HANYONG = 'hanyong'

registerSkillRuntime({
  id: RANSHANG,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId || context.event.damageNature !== 'fire') return
        const payload = context.event.payload as { amount?: number }
        const amount = payload.amount ?? 1
        host.state.ranMarks = { ...(host.state.ranMarks ?? {}), [ownerId]: (host.state.ranMarks?.[ownerId] ?? 0) + amount }
        const owner = playerOf(host.state, ownerId)
        if (owner) host.dispatch('SkillActivated', { skillId: RANSHANG, skillName: '燃殇', playerId: ownerId, logText: `${owner.nickname}获得${amount}枚"燃"` }, { sourceId: ownerId })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const marks = host.state.ranMarks?.[ownerId] ?? 0
        if (marks <= 0) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        loseHp(host as never, ownerId, marks, RANSHANG)
      },
    },
  ],
})

registerSkillRuntime({
  id: HANYONG,
  outgoingDamage(state, ownerId, context) {
    if (context.cardName !== '南蛮入侵' && context.cardName !== '万箭齐发') return null
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.hp >= state.roundNumber) return null
    return { amount: context.amount + 1 }
  },
})

// ============================== 角色定义 ==============================

export const HISTORICAL_BATCH19_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'wangchang', name: '王昶', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: KAIJI, name: '开济', description: '转换技，出牌阶段限一次。阳：摸体力上限张牌；阴：弃置1～体力上限张牌。每次发动后阴阳转换。' },
      { id: PINGXI, name: '平袭', description: '结束阶段，你本回合因弃置进入弃牌堆的牌有X张，则你可以选择至多X名角色，依次弃置其一张牌，然后视为对其使用一张【杀】。' },
    ],
  },
  {
    id: 'caomao', name: '曹髦', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: QIANLONG, name: '潜龙', description: '你受到伤害后，可以亮出牌堆顶3张牌，获得其中至多X张（X为你已损失的体力值），其余置于牌堆底。' },
      { id: FENSI, name: '忿肆', description: '锁定技，准备阶段，你选择一名体力值不小于你的角色，对其造成1点伤害；若其不是你，其视为对你使用一张【杀】。' },
      { id: JUETAO, name: '决讨', description: '限定技，出牌阶段开始时，若你体力值为1，你可以选择一名角色，然后从牌堆底开始依次使用牌，目标只能是你与该角色，直到无法继续。' },
      { id: ZHUSHI, name: '助势', description: '主公技，每回合限一次，其他魏势力角色于自己回合内回复体力后，可以令你摸1张牌。' },
    ],
  },
  {
    id: 'panghui', name: '庞会', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: YIYONG, name: '异勇', description: '你即将对一名角色造成伤害时，你与其同时秘密弃置任意张牌，然后比较点数：你的点数和不大于其点数和，你摸其弃置牌数+1张牌；不小于，此伤害+1。' },
      { id: SUCHOU, name: '夙仇', description: '锁定技，每个出牌阶段开始时，你必须选择：失去1点体力或体力上限，本阶段你使用的牌均不能被响应；或永久失去此技能。' },
    ],
  },
  {
    id: 'huban', name: '胡班', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: HUIYUN, name: '晖云', description: '出牌阶段，你可以将1张牌当【火攻】使用；结算后，你选择一个本轮未选过的选项：目标可使用展示牌然后重铸所有手牌；或使用1张手牌然后重铸展示牌；或摸1张牌（每项每轮限一次）。' },
      { id: `${HUIYUN}-followup`, name: '晖云', description: '（晖云的结算续接）', locked: true },
    ],
  },
  {
    id: 'zhugeshang', name: '诸葛尚', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: SANGU, name: '三顾', description: '结束阶段，你可以依次选择至多3张【杀】或普通锦囊（不包括借刀杀人、无懈可击）的牌名，然后选择一名其他角色，其下个出牌阶段使用的前若干张牌依次视为对应牌名。若所选牌名均为你本回合已使用过的牌名，由此转化的牌对你造成的伤害被防止。' },
      { id: `${SANGU}-arm`, name: '三顾', description: '（三顾的结算续接）', locked: true },
      { id: `${SANGU}-protect`, name: '三顾', description: '（三顾的防护续接）', locked: true },
      { id: YIZU, name: '轶祖', description: '锁定技，每回合限一次，你成为【杀】或【决斗】的目标后，若你体力值不大于其使用者，你回复1点体力。' },
    ],
  },
  {
    id: 'liuyong', name: '刘永', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: ZHUNING, name: '诛佞', description: '出牌阶段限一次，你可以交给一名其他角色至少1张牌，称为"隙"，然后视为对一名角色使用一张无次数限制的【杀】或一张伤害类普通锦囊。若未造成伤害，本阶段【诛佞】次数上限变为2。' },
      { id: FENGXIANG, name: '封乡', description: '锁定技，你受到伤害后，或场上"隙"分布唯一最多的角色改变时：若存在数量唯一最多且大于0的持有者，其回复1点体力；否则你摸1张牌。' },
    ],
  },
  {
    id: 'leitong', name: '雷铜', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: KUIJI, name: '溃击', description: '出牌阶段限一次，你可以将1张黑色基本牌当【兵粮寸断】置于你的判定区，然后摸1张牌，可以对一名体力值最高的其他角色造成2点伤害；若其因此进入濒死，你可以令另一名体力值最低的角色回复1点体力。' },
      { id: `${KUIJI}-followup`, name: '溃击', description: '（溃击的结算续接）', locked: true },
    ],
  },
  {
    id: 'wulan', name: '吴兰', kingdom: 'shu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: CUIRUI, name: '挫锐', description: '出牌阶段限一次，你可以弃置距离1以内一名角色区域内1张牌，然后选择另一名其他角色B，弃置其至多2张同色装备牌，或展示其共计2张手牌，获得其中与之前弃置牌同色的牌。' },
    ],
  },
  {
    id: 'zhangling', name: '张陵', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: HUQI, name: '虎骑', description: '锁定技，你计算与其他角色的距离-1；你于回合外受到伤害后进行判定，若为红色，你视为对伤害来源使用一张【杀】。' },
      { id: SHOUFU, name: '授符', description: '出牌阶段限一次，你摸1张牌，然后将1张手牌置于一名没有"箓"的其他角色武将牌上；其不能使用/打出与箓同类别的牌，直到其受到伤害，或弃牌阶段弃置至少2张同类别的牌。' },
    ],
  },
  {
    id: 'wutugu', name: '兀突骨', kingdom: 'qun', gender: 'male', maxHp: 8, pack: 'sp',
    skills: [
      { id: RANSHANG, name: '燃殇', description: '锁定技，你受到1点火焰伤害后，获得1枚"燃"；结束阶段，你失去X点体力，X为"燃"的数量。' },
      { id: HANYONG, name: '悍勇', description: '当你使用【南蛮入侵】或【万箭齐发】时，若你的体力值小于当前轮数，此牌伤害+1。' },
    ],
  },
]
