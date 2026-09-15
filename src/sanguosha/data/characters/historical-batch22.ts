import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { effectiveKingdomOf } from '../../engine/huashen'
import { getDistance } from '../../engine/distance'
import { registerPindianContinuation, startPindian, claimPindianCards } from '../../engine/pindian'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { queueDamagePoint, remainingDamagePoints, damagePointsOf } from '../../engine/per-damage-point'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 魏吴群独立历史人物补完批：乐进、李典、曹洪、曹芳、孙鲁育、荀谌、宗预、
 * 张奋、孙资刘放、乐綝。均此前项目未收录，全部作为独立 CharacterDefinition，
 * 不覆盖任何界/谋/族/国战/SP/神版本（曹洪明确不用"谋曹洪"版本）。
 *
 * 版本口径：乐进/李典/曹洪按官方当前经典/身份文本；曹芳/孙鲁育/荀谌/宗预/
 * 张奋/孙资刘放/乐綝按用户提供的《一将成名》当前版文本，望橹/陷筑/拆械/
 * 大攻车、止息、破锐/共护经 WebFetch 核对 sgs/sgsol wiki 当前文本。
 *
 * 已知简化（引擎能力边界，非版本/规则错误，详见 commit 说明）：
 * - 张奋【大攻车】：官方定义为"宝物"，本引擎没有宝物栏，改放武器栏（与
 *   蒲元【神工】批次的既有简化一致），因此装备大攻车期间张奋不能再装备
 *   普通武器。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function alivePlayers(state: SanguoshaState) {
  return state.players.filter((player) => player.alive)
}

/* ============================== 乐进 ============================== */

const XIAOGUO = 'xiaoguo'

registerSkillRuntime({
  id: XIAOGUO,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, payload.playerId)
      if (!owner?.alive || !target?.alive) return
      const basicId = owner.zones.hand.find((id) => host.state.cards[id]?.category === 'basic')
      if (!basicId) return
      host.queueSkill({ skillId: XIAOGUO, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const basicId = owner.zones.hand.find((id) => host.state.cards[id]?.category === 'basic')
      if (!basicId) return
      host.askSkill({
        skillId: XIAOGUO, ownerId, step: 'ask', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【骁果】：是否弃置一张基本牌？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'target-choice') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const hasEquipment = Object.values(target.zones.equipment).some(Boolean)
      const options: Array<{ id: string; label: string }> = []
      if (hasEquipment) options.push({ id: 'discard', label: '弃置一张装备牌' })
      options.push({ id: 'damage', label: '受到乐进1点伤害' })
      host.askSkill({
        skillId: XIAOGUO, ownerId, step: 'target-choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【骁果】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const basicId = owner.zones.hand.find((id) => host.state.cards[id]?.category === 'basic')
      if (!basicId) return
      moveCard(host.state, basicId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [basicId], reason: XIAOGUO }, { sourceId: ownerId, cardIds: [basicId] })
      host.queueSkill({ skillId: XIAOGUO, ownerId, step: 'target-choice', data: { targetId } })
      return
    }
    if (resolution.step === 'target-choice') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard') {
        const equipmentIds = Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
        if (equipmentIds.length === 0) return
        const cardId = equipmentIds[host.rng.nextInt(equipmentIds.length)]
        const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
        moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XIAOGUO }, { sourceId: ownerId, targetId, cardIds: [cardId] })
        drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: XIAOGUO, skillName: '骁果', playerId: ownerId, targetId, logText: `${owner.nickname}发动【骁果】` }, { sourceId: ownerId, targetId })
      } else {
        host.dispatch('SkillActivated', { skillId: XIAOGUO, skillName: '骁果', playerId: ownerId, targetId, logText: `${owner.nickname}发动【骁果】` }, { sourceId: ownerId, targetId })
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      }
    }
  },
})

/* ============================== 李典 ============================== */

const XUNXUN = 'xunxun'
const WANGXI = 'wangxi'

registerSkillRuntime({
  id: XUNXUN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || host.state.zones.drawPile.length === 0) return
      const n = Math.min(4, host.state.zones.drawPile.length)
      const top = host.state.zones.drawPile.slice(-n).reverse()
      host.queueSkill({ skillId: XUNXUN, ownerId, step: 'ask', data: { top } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { top } = prompt.data as { top: CardId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: XUNXUN, ownerId, step: 'ask', data: { top },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【恂恂】：观看牌堆顶${top.length}张牌，选择置于牌堆顶的牌（可放弃，最多${Math.min(2, top.length)}张）`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...top], hiddenCardSlots: [], min: 0, max: Math.min(2, top.length),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { top } = resolution.data as { top: CardId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const chosenTop = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => top.includes(id))
    const bottom = top.filter((id) => !chosenTop.includes(id))
    // 所有牌都已经在牌堆顶：先把当前批次整体移走，再按恂恂决定的相对顺序放回
    for (const cardId of top) moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    for (const cardId of [...bottom].reverse()) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' })
    for (const cardId of [...chosenTop].reverse()) moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
    host.dispatch('SkillActivated', { skillId: XUNXUN, skillName: '恂恂', playerId: ownerId, logText: `${owner.nickname}发动【恂恂】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: WANGXI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      const amount = context.event.payload.amount as number
      let otherId: PlayerId | undefined
      if (sourceId === ownerId && targetId && targetId !== ownerId) otherId = targetId
      else if (targetId === ownerId && sourceId && sourceId !== ownerId) otherId = sourceId
      if (!otherId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const points = damagePointsOf(amount)
      if (points <= 0) return
      queueDamagePoint(host, { skillId: WANGXI, ownerId, step: 'proc', remaining: points, data: { otherId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'proc') return
    const { otherId } = prompt.data as { otherId: PlayerId }
    const remaining = remainingDamagePoints(prompt.data)
    if (remaining <= 0) return
    const owner = playerOf(host.state, ownerId)
    const other = playerOf(host.state, otherId)
    if (!owner?.alive || !other?.alive) return
    drawCards(host.state, host.rng, ownerId, 2, (n, p) => { host.dispatch(n, p) })
    const owner2 = playerOf(host.state, ownerId)
    if (!owner2?.alive || owner2.zones.hand.length === 0) {
      queueDamagePoint(host, { skillId: WANGXI, ownerId, step: 'proc', remaining: remaining - 1, data: { otherId } })
      return
    }
    host.askSkill({
      skillId: WANGXI, ownerId, step: 'give', data: { otherId, remaining },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【忘隙】：交给${other.nickname}一张牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner2.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'give') return
    const { otherId, remaining } = resolution.data as { otherId: PlayerId; remaining: number }
    const owner = playerOf(host.state, ownerId)
    const other = playerOf(host.state, otherId)
    if (owner?.alive && other?.alive) {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: otherId })
        host.dispatch('GainCard', { playerId: otherId, cardIds: [cardId], reason: WANGXI }, { sourceId: ownerId, targetId: otherId, cardIds: [cardId] })
        host.dispatch('SkillActivated', { skillId: WANGXI, skillName: '忘隙', playerId: ownerId, targetId: otherId, logText: `${owner.nickname}发动【忘隙】` }, { sourceId: ownerId, targetId: otherId })
      }
    }
    queueDamagePoint(host, { skillId: WANGXI, ownerId, step: 'proc', remaining: remaining - 1, data: { otherId } })
  },
})

/* ============================== 曹洪 ============================== */

const HUYUAN = 'huyuan'

registerSkillRuntime({
  id: HUYUAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const equipmentId = owner.zones.hand.find((id) => host.state.cards[id]?.category === 'equipment')
      if (!equipmentId) return
      host.queueSkill({ skillId: HUYUAN, ownerId, step: 'pick-equipment', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'pick-equipment') {
      const equipmentIds = owner.zones.hand.filter((id) => host.state.cards[id]?.category === 'equipment')
      if (equipmentIds.length === 0) return
      host.askSkill({
        skillId: HUYUAN, ownerId, step: 'pick-equipment', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【护援】：可以选择一张装备牌（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: equipmentIds, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'pick-target') {
      const { cardId } = prompt.data as { cardId: CardId }
      const candidates = alivePlayers(host.state)
      host.askSkill({
        skillId: HUYUAN, ownerId, step: 'pick-target', data: { cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【护援】：选择一名角色装备此牌', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (prompt.step === 'pick-nearby') {
      const { targetId } = prompt.data as { targetId: PlayerId }
      const nearby = alivePlayers(host.state).filter((player) => getDistance(host.state, targetId, player.id) === 1 && player.zones.hand.length > 0)
      if (nearby.length === 0) return
      host.askSkill({
        skillId: HUYUAN, ownerId, step: 'pick-nearby', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【护援】：可以弃置一名距离目标为1的角色一张牌', timeoutMs: 20_000, optional: true,
          options: [...nearby.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-equipment') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      host.queueSkill({ skillId: HUYUAN, ownerId, step: 'pick-target', data: { cardId } })
      return
    }
    if (resolution.step === 'pick-target') {
      const { cardId } = resolution.data as { cardId: CardId }
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const card = host.state.cards[cardId]
      if (!target?.alive || !card?.equipmentSlot || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'equipment', playerId: targetId!, slot: card.equipmentSlot })
      host.dispatch('SkillActivated', { skillId: HUYUAN, skillName: '护援', playerId: ownerId, targetId, logText: `${owner.nickname}发动【护援】` }, { sourceId: ownerId, targetId })
      host.queueSkill({ skillId: HUYUAN, ownerId, step: 'pick-nearby', data: { targetId } })
      return
    }
    if (resolution.step === 'pick-nearby') {
      const nearbyId = (response.payload as { optionId?: string }).optionId
      if (!nearbyId || nearbyId === 'none') return
      const nearby = playerOf(host.state, nearbyId)
      if (!nearby?.alive || nearby.zones.hand.length === 0) return
      const cardId = nearby.zones.hand[host.rng.nextInt(nearby.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: nearbyId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: nearbyId, cardIds: [cardId], reason: HUYUAN }, { sourceId: ownerId, targetId: nearbyId, cardIds: [cardId] })
    }
  },
})

/* ============================== 曹芳 ============================== */

const ZHIMIN = 'zhimin'
const JUJIAN = 'caofang-jujian'

registerSkillRuntime({
  id: ZHIMIN,
  triggers: [
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = owner.hp
        const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
        if (x <= 0 || candidates.length === 0) return
        host.queueSkill({ skillId: ZHIMIN, ownerId, step: 'pick-targets', data: { x } })
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        const cardIds = host.state.caofangMinCardIds?.[ownerId] ?? []
        if (payload.playerId !== ownerId || cardIds.length === 0) return
        const lost = (payload.cardIds ?? []).filter((id) => cardIds.includes(id))
        if (lost.length === 0) return
        host.state.caofangMinCardIds![ownerId] = cardIds.filter((id) => !lost.includes(id))
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const diff = owner.maxHp - owner.zones.hand.length
        if (diff > 0) drawCards(host.state, host.rng, ownerId, diff, (n, p) => { host.dispatch(n, p) })
      },
    },
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId || host.state.currentPlayerId === ownerId) return
        // 仅由置民自身获得的牌打标记，其它来源不打（下面 pick-targets 的 resume 里已经直接打标）
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-targets') return
    const { x } = prompt.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: ZHIMIN, ownerId, step: 'pick-targets', data: { x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【置民】：选择至多${Math.min(x, candidates.length)}名角色（可用逗号分隔多选，选项内已合并）`, timeoutMs: 20_000, optional: true,
        options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-targets') return
    const { x } = resolution.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const picked = (response.payload as { optionId?: string }).optionId
    const targets = picked ? [picked] : []
    const selected = targets.filter((id) => playerOf(host.state, id)?.alive).slice(0, x)
    const gained: CardId[] = []
    for (const targetId of selected) {
      const target = playerOf(host.state, targetId)
      if (!target?.alive || target.zones.hand.length === 0) continue
      const minRank = Math.min(...target.zones.hand.map((id) => host.state.cards[id]?.rank ?? 99))
      const pool = target.zones.hand.filter((id) => host.state.cards[id]?.rank === minRank)
      const cardId = pool[host.rng.nextInt(pool.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHIMIN }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      gained.push(cardId)
    }
    if (gained.length > 0) {
      host.state.caofangMinCardIds ??= {}
      host.state.caofangMinCardIds[ownerId] = [...(host.state.caofangMinCardIds[ownerId] ?? []), ...gained]
      host.dispatch('SkillActivated', { skillId: ZHIMIN, skillName: '置民', playerId: ownerId, logText: `${owner.nickname}发动【置民】，获得了${gained.length}张牌` }, { sourceId: ownerId, cardIds: gained })
    }
  },
})

registerSkillRuntime({
  id: JUJIAN,
  lord: true,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.identity !== 'lord' || usedThisTurn(host.state, ownerId, JUJIAN)) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && effectiveKingdomOf(host.state, player.id) === 'wei')
      if (candidates.length === 0) return
      host.queueSkill({ skillId: JUJIAN, ownerId, step: 'ask', data: {} })
    },
  }],
  prohibitsTarget(state, ownerId, sourceId, cardName) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return false
    const protection = state.caofangJujianProtect?.[ownerId]
    if (!protection || protection.roundNumber !== state.roundNumber || protection.sourceId !== sourceId) return false
    const card = Object.values(state.cards).find((c) => c.name === cardName)
    return Boolean(card && card.category === 'trick' && !DELAYED_TRICKS.has(card.name))
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && effectiveKingdomOf(host.state, player.id) === 'wei')
    if (candidates.length === 0) return
    host.askSkill({
      skillId: JUJIAN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【拒谏】：选择一名其他魏势力角色摸一张牌（可放弃）', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, _resolution, response) {
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive || !owner?.alive) return
    markUsedThisTurn(host.state, ownerId, JUJIAN)
    drawCards(host.state, host.rng, targetId, 1, (n, p) => { host.dispatch(n, p) })
    host.state.caofangJujianProtect ??= {}
    host.state.caofangJujianProtect[ownerId] = { sourceId: targetId, roundNumber: host.state.roundNumber }
    host.dispatch('SkillActivated', { skillId: JUJIAN, skillName: '拒谏', playerId: ownerId, targetId, logText: `${owner.nickname}发动【拒谏】` }, { sourceId: ownerId, targetId })
  },
})

/* ============================== 孙鲁育 ============================== */

const MEIBU = 'meibu'
const ZHIXI = 'zhixi'
const MUMU = 'mumu'

registerSkillRuntime({
  id: MEIBU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, payload.playerId)
      if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
      if (getDistance(host.state, target.id, ownerId) > (host.state.players.length >= 0 ? Infinity : 0)) return
      // 攻击范围判定：孙鲁育是否在 target 的攻击范围内，即 target 视角距离 <= target 攻击范围
      host.queueSkill({ skillId: MEIBU, ownerId, step: 'ask', data: { targetId: target.id } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: MEIBU, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【魅步】：可以弃置一张牌，令${target.nickname}获得"止息"`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    const card = host.state.cards[cardId]
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MEIBU }, { sourceId: ownerId, cardIds: [cardId] })
    replaceTemporarySkill(host.state, targetId, `sunluyu-meibu:${targetId}`, ZHIXI)
    host.state.meibuWatch ??= {}
    host.state.meibuWatch[targetId] = { ownerId, suit: card?.suit ?? 'spade', turnNumber: host.state.turnNumber }
    host.dispatch('SkillActivated', { skillId: MEIBU, skillName: '魅步', playerId: ownerId, targetId, logText: `${owner.nickname}发动【魅步】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: ZHIXI,
  triggers: [
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        replaceTemporarySkill(host.state, ownerId, `sunluyu-meibu:${ownerId}`, null)
        if (host.state.meibuWatch) delete host.state.meibuWatch[ownerId]
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
        const name = payload.asCardName ?? payload.cardName
        const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
        const isSlashOrTrick = name === '杀' || (card?.category === 'trick')
        if (!isSlashOrTrick) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: ZHIXI, ownerId, step: 'discard', data: {} })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: ZHIXI, ownerId, step: 'discard', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【止息】：弃置一张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHIXI }, { sourceId: ownerId, cardIds: [cardId] })
    const watch = host.state.meibuWatch?.[ownerId]
    if (!watch || watch.turnNumber !== host.state.turnNumber) return
    const card = host.state.cards[cardId]
    if (card?.suit !== watch.suit) return
    if (!host.state.zones.discardPile.includes(cardId)) return
    const meibuOwner = playerOf(host.state, watch.ownerId)
    if (!meibuOwner?.alive) return
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: watch.ownerId })
    host.dispatch('GainCard', { playerId: watch.ownerId, cardIds: [cardId], reason: MEIBU }, { sourceId: ownerId, targetId: watch.ownerId, cardIds: [cardId] })
  },
})

registerSkillRuntime({
  id: MUMU,
  globalSlashUses(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner) return 0
    return (owner.marks.mumuBonus ?? 0) - (owner.marks.mumuPenalty ?? 0)
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
      if (others.length === 0) return
      host.queueSkill({ skillId: MUMU, ownerId, step: 'ask', data: {} })
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) { owner.marks.mumuBonus = 0; owner.marks.mumuPenalty = 0 }
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
      if (others.length === 0) return
      host.askSkill({
        skillId: MUMU, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【穆穆】：选择一项（可放弃）', timeoutMs: 20_000, optional: true,
          options: [
            { id: 'discard', label: '弃置一名其他角色装备区一张牌，本回合杀次数+1' },
            { id: 'obtain', label: '获得一名其他角色装备区一张牌，本回合杀次数-1' },
            { id: 'none', label: '不发动' },
          ],
        }),
      })
      return
    }
    if (prompt.step === 'pick-discard' || prompt.step === 'pick-obtain') {
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId && Object.values(player.zones.equipment).some(Boolean))
      if (others.length === 0) return
      host.askSkill({
        skillId: MUMU, ownerId, step: prompt.step, data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【穆穆】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          options: others.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard' || optionId === 'obtain') {
        host.queueSkill({ skillId: MUMU, ownerId, step: `pick-${optionId}`, data: {} })
      }
      return
    }
    const targetId = (response.payload as { optionId?: string }).optionId
    const target = targetId ? playerOf(host.state, targetId) : undefined
    const equipmentIds = target ? Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
    if (!target?.alive || equipmentIds.length === 0) return
    const cardId = equipmentIds[host.rng.nextInt(equipmentIds.length)]
    const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
    if (resolution.step === 'pick-discard') {
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId!, slot }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId!, cardIds: [cardId], reason: MUMU }, { sourceId: ownerId, targetId: targetId!, cardIds: [cardId] })
      owner.marks.mumuBonus = (owner.marks.mumuBonus ?? 0) + 1
    } else {
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId!, slot }, { kind: 'equipment', playerId: ownerId, slot })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MUMU }, { sourceId: targetId!, targetId: ownerId, cardIds: [cardId] })
      owner.marks.mumuPenalty = (owner.marks.mumuPenalty ?? 0) + 1
    }
    host.dispatch('SkillActivated', { skillId: MUMU, skillName: '穆穆', playerId: ownerId, targetId, logText: `${owner.nickname}发动【穆穆】` }, { sourceId: ownerId, targetId })
  },
})

/* ============================== 荀谌 ============================== */

const FENGLUE = 'fenglue'
const ANYONG = 'anyong'
const FENGLUE_TAG = 'fenglue-pindian'

registerSkillRuntime({
  id: FENGLUE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || usedThisTurn(host.state, ownerId, FENGLUE)) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
      if (candidates.length === 0) return
      host.queueSkill({ skillId: FENGLUE, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.zones.hand.length > 0)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: FENGLUE, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【锋略】：选择一名角色拼点（可放弃）', timeoutMs: 20_000, optional: true,
        options: [...candidates.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, _resolution, response) {
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    markUsedThisTurn(host.state, ownerId, FENGLUE)
    startPindian(host as never, {
      id: `fenglue-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: FENGLUE, continuationTag: FENGLUE_TAG, data: {},
    })
  },
})

registerPindianContinuation(FENGLUE_TAG, (host, result) => {
  const owner = playerOf(host.state, result.initiatorId)
  const target = playerOf(host.state, result.opponentId)
  if (!owner?.alive) return
  if (result.outcome === 'initiator-win') {
    if (!target?.alive) return
    // 项目没有拼点场景下"随机抽 2 张"的既有随机源（PindianHost 不带 rng），
    // 按装备区→判定区→手牌固定顺序取前两张，规则文本本身也没有随机要求。
    const visible = [...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.judgingArea]
    const pool = [...visible, ...target.zones.hand]
    const picked = pool.slice(0, Math.min(2, pool.length))
    for (const cardId of picked) {
      const zone: 'equipment' | 'judgingArea' | 'hand' = Object.values(target.zones.equipment).includes(cardId) ? 'equipment' : target.zones.judgingArea.includes(cardId) ? 'judgingArea' : 'hand'
      if (zone === 'equipment') {
        const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
        moveCard(host.state, cardId, { kind: 'equipment', playerId: target.id, slot }, { kind: 'hand', playerId: owner.id })
      } else if (zone === 'judgingArea') {
        moveCard(host.state, cardId, { kind: 'judgingArea', playerId: target.id }, { kind: 'hand', playerId: owner.id })
      } else {
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: owner.id })
      }
    }
    if (picked.length > 0) host.dispatch('GainCard', { playerId: owner.id, cardIds: picked, reason: FENGLUE }, { sourceId: target.id, targetId: owner.id, cardIds: picked })
    host.dispatch('SkillActivated', { skillId: FENGLUE, skillName: '锋略', playerId: owner.id, targetId: target.id, logText: `${owner.nickname}发动【锋略】获胜` }, { sourceId: owner.id, targetId: target.id })
    return
  }
  if (result.outcome === 'tie') {
    claimPindianCards(host, result.initiatorId, [result.initiatorCardId])
    owner.turnUsedSkills = (owner.turnUsedSkills ?? []).filter((id) => id !== FENGLUE)
    host.dispatch('SkillActivated', { skillId: FENGLUE, skillName: '锋略', playerId: owner.id, logText: `${owner.nickname}发动【锋略】平局，视为未发动` }, { sourceId: owner.id })
    return
  }
  claimPindianCards(host, result.opponentId, [result.initiatorCardId])
  host.dispatch('SkillActivated', { skillId: FENGLUE, skillName: '锋略', playerId: owner.id, logText: `${owner.nickname}发动【锋略】失败` }, { sourceId: owner.id })
})

registerSkillRuntime({
  id: ANYONG,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId || host.state.currentPlayerId !== sourceId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.id === sourceId) return
      const source = playerOf(host.state, sourceId)
      if (!source) return
      if ((source.marks.anyongFirstDamageDone ?? 0)) return
      source.marks.anyongFirstDamageDone = 1
      const amount = context.event.payload.amount as number
      if (amount !== 1) return
      const targetId = context.event.targetId
      if (!targetId) return
      if (owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: ANYONG, ownerId, step: 'ask', data: { targetId } })
    },
  }, {
    event: 'PhaseStart',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || !payload.playerId) return
      const player = playerOf(host.state, payload.playerId)
      if (player) player.marks.anyongFirstDamageDone = 0
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: ANYONG, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【暗涌】：可以弃置一张牌，对${target.nickname}造成1点伤害`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ANYONG }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: ANYONG, skillName: '暗涌', playerId: ownerId, targetId, logText: `${owner.nickname}发动【暗涌】` }, { sourceId: ownerId, targetId })
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
  },
})

/* ============================== 宗预 ============================== */

const QIAO = 'qiao'
const CHENGSHANG = 'chengshang'

registerSkillRuntime({
  id: QIAO,
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetIds?: PlayerId[] }
      if (!(payload.targetIds ?? []).includes(ownerId)) return
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, sourceId)
      if (!owner?.alive || !source?.alive || effectiveKingdomOf(host.state, sourceId) === effectiveKingdomOf(host.state, ownerId)) return
      if ((owner.marks.qiaoUsedThisTurn ?? 0) >= 2) return
      if (source.zones.hand.length === 0) return
      owner.marks.qiaoUsedThisTurn = (owner.marks.qiaoUsedThisTurn ?? 0) + 1
      host.queueSkill({ skillId: QIAO, ownerId, step: 'ask', data: { sourceId } })
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.qiaoUsedThisTurn = 0
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive || source.zones.hand.length === 0) return
    host.askSkill({
      skillId: QIAO, ownerId, step: 'ask', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【气傲】：是否弃置${source.nickname}一张手牌，然后自己弃置一张牌？`, timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { sourceId } = resolution.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    if (source.zones.hand.length === 0) return
    const cardId = source.zones.hand[host.rng.nextInt(source.zones.hand.length)]
    moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: QIAO }, { sourceId: ownerId, targetId: sourceId, cardIds: [cardId] })
    if (owner.zones.hand.length > 0) {
      const ownCardId = owner.zones.hand[host.rng.nextInt(owner.zones.hand.length)]
      moveCard(host.state, ownCardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [ownCardId], reason: QIAO }, { sourceId: ownerId, cardIds: [ownCardId] })
    }
    host.dispatch('SkillActivated', { skillId: QIAO, skillName: '气傲', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【气傲】` }, { sourceId: ownerId, targetId: sourceId })
  },
})

registerSkillRuntime({
  id: CHENGSHANG,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (sourceId !== ownerId || usedThisTurn(host.state, ownerId, CHENGSHANG)) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !payload.cardId) return
      const targetIds = payload.targetIds ?? []
      const ownerKingdom = effectiveKingdomOf(host.state, ownerId)
      const hasOtherKingdom = targetIds.some((id) => id !== ownerId && effectiveKingdomOf(host.state, id) !== ownerKingdom)
      if (!hasOtherKingdom) return
      if (cardDamageDealt(host.state, payload.cardId)) return
      const card = host.state.cards[payload.cardId]
      if (!card) return
      markUsedThisTurn(host.state, ownerId, CHENGSHANG)
      const pool = host.state.zones.drawPile.filter((id) => {
        const c = host.state.cards[id]
        return c?.suit === card.suit && c.rank === card.rank
      })
      if (pool.length === 0) return
      const cardId = pool[host.rng.nextInt(pool.length)]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: CHENGSHANG }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: CHENGSHANG, skillName: '承赏', playerId: ownerId, logText: `${owner.nickname}发动【承赏】` }, { sourceId: ownerId, cardIds: [cardId] })
    },
  }],
})

/* ============================== 张奋 ============================== */

const WANGLU = 'wanglu'
const XIANZHU = 'xianzhu'
const CHAIXIE = 'chaixie'
const DAGONGCHE_PILE = 'dagongche-destroyed'
let dagongcheSeq = 0

/**
 * 生成一张真实存在、但不属于牌堆构成的【大攻车】卡牌并直接放入装备区。
 *
 * 大攻车是"宝物"，本引擎没有宝物栏（详见文件头简化说明），映射到武器栏；
 * 官方大攻车没有额外攻击范围加成，attackRange 按普通近战武器给 1（不改变距离）。
 * `extraPhaseAtTurnStart` 只拿得到 `state`（同步、不可发问、不能 dispatch），
 * 所以这里不走 moveCard（它需要牌先在某个真实区域里）、也不广播装备变化事件，
 * 直接在 state.cards 登记后写进装备区——新卡从未出现在任何区域，因此不会
 * 破坏 `assertCardConservation` 的"每张已知牌唯一定位"不变量。
 */
function equipDagongche(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  const oldWeapon = owner.zones.equipment.weapon
  if (oldWeapon) state.zones.discardPile.push(oldWeapon)
  dagongcheSeq += 1
  const cardId: CardId = `dagongche:${state.seq}:${dagongcheSeq}`
  state.cards[cardId] = {
    id: cardId, ruleset: state.rulesetVersion, expansion: 'maneuvering',
    name: '大攻车', suit: 'spade', rank: 9, color: 'black', category: 'equipment', equipmentSlot: 'weapon', attackRange: 1,
  }
  owner.zones.equipment.weapon = cardId
}

registerSkillRuntime({
  id: WANGLU,
  extraPhaseAtTurnStart(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return null
    const hasDagongche = Object.values(owner.zones.equipment).some((id) => id && state.cards[id]?.name === '大攻车')
    if (hasDagongche) return 'play'
    equipDagongche(state, ownerId)
    return null
  },
})

registerSkillRuntime({
  id: XIANZHU,
  /**
   * 陷筑"无距离限制"分支：本引擎没有"无视防具"这个通用效果钩子（现有
   * 防具类武将也都没有实现类似效果），这里只落实无距离限制部分，无视防具
   * 作为已知简化在报告中说明。
   */
  slashIgnoresDistance(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return false
    const dagongcheId = Object.values(owner.zones.equipment).find((id) => id && state.cards[id]?.name === '大攻车')
    if (!dagongcheId) return false
    return (owner.marks[`dagongcheRange:${dagongcheId}`] ?? 0) > 0
  },
  extraSlashTargets(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return 0
    const dagongcheId = Object.values(owner.zones.equipment).find((id) => id && state.cards[id]?.name === '大攻车')
    if (!dagongcheId) return 0
    return owner.marks[`dagongcheTarget:${dagongcheId}`] ?? 0
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (sourceId !== ownerId) return
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName !== '杀') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const dagongcheId = Object.values(owner.zones.equipment).find((id) => id && host.state.cards[id]?.name === '大攻车')
      if (!dagongcheId) return
      const level = owner.marks[`dagongcheLevel:${dagongcheId}`] ?? 0
      if (level >= 5) return
      host.queueSkill({ skillId: XIANZHU, ownerId, step: 'ask', data: { dagongcheId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { dagongcheId } = prompt.data as { dagongcheId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const stillEquipped = Object.values(owner.zones.equipment).includes(dagongcheId)
    if (!stillEquipped) return
    host.askSkill({
      skillId: XIANZHU, ownerId, step: 'ask', data: { dagongcheId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【陷筑】：是否升级【大攻车】？', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'range', label: '升级：无距离限制且无视防具' },
          { id: 'target', label: '升级：额外指定一个目标' },
          { id: 'discard', label: '升级：造成伤害后弃置目标牌数+1' },
          { id: 'none', label: '不升级' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { dagongcheId } = resolution.data as { dagongcheId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!optionId || optionId === 'none') return
    const level = owner.marks[`dagongcheLevel:${dagongcheId}`] ?? 0
    if (level >= 5) return
    owner.marks[`dagongcheLevel:${dagongcheId}`] = level + 1
    owner.marks[`dagongche${optionId === 'range' ? 'Range' : optionId === 'target' ? 'Target' : 'Discard'}:${dagongcheId}`] =
      (owner.marks[`dagongche${optionId === 'range' ? 'Range' : optionId === 'target' ? 'Target' : 'Discard'}:${dagongcheId}`] ?? 0) + 1
    host.dispatch('SkillActivated', { skillId: XIANZHU, skillName: '陷筑', playerId: ownerId, logText: `${owner.nickname}发动【陷筑】，升级了大攻车` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: CHAIXIE,
  protectsCardFromDiscard(state, protectedOwnerId, cardId) {
    const card = state.cards[cardId]
    if (card?.name !== '大攻车') return false
    const level = playerOf(state, protectedOwnerId)?.marks[`dagongcheLevel:${cardId}`] ?? 0
    return level <= 0
  },
  triggers: [{
    event: 'CardMove',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardIds?: CardId[] }
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      for (const cardId of payload.cardIds ?? []) {
        const card = host.state.cards[cardId]
        if (card?.name !== '大攻车') continue
        const inDiscard = host.state.zones.discardPile.includes(cardId)
        const handOwner = host.state.players.find((player) => player.zones.hand.includes(cardId))
        if (!inDiscard && !handOwner) continue
        const level = owner.marks[`dagongcheLevel:${cardId}`] ?? 0
        if (inDiscard) moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: DAGONGCHE_PILE })
        else moveCard(host.state, cardId, { kind: 'hand', playerId: handOwner!.id }, { kind: 'characterPile', playerId: ownerId, pile: DAGONGCHE_PILE })
        if (level > 0) drawCards(host.state, host.rng, ownerId, level, (n, p) => { host.dispatch(n, p) })
        host.dispatch('SkillActivated', { skillId: CHAIXIE, skillName: '拆械', playerId: ownerId, logText: `${owner.nickname}发动【拆械】` }, { sourceId: ownerId })
      }
    },
  }, {
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const dagongcheId = Object.values(owner.zones.equipment).find((id) => id && host.state.cards[id]?.name === '大攻车')
      if (!dagongcheId) return
      const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
      if (others.length === 0) return
      host.queueSkill({ skillId: CHAIXIE, ownerId, step: 'use-ask', data: { dagongcheId } })
    },
  }, {
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const targetId = context.event.targetId
      if (!targetId) return
      const pending = host.state.dagongcheDiscardPending?.[targetId]
      if (!pending) return
      delete host.state.dagongcheDiscardPending![targetId]
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      const pool = [...Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id)), ...target.zones.hand]
      const n = Math.min(pending, pool.length)
      const discarded: CardId[] = []
      const remaining = [...pool]
      for (let i = 0; i < n; i += 1) {
        const index = host.rng.nextInt(remaining.length)
        const [cardId] = remaining.splice(index, 1)
        const zone: 'equipment' | 'hand' = Object.values(target.zones.equipment).includes(cardId) ? 'equipment' : 'hand'
        if (zone === 'equipment') {
          const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0] as EquipmentSlot
          moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'discardPile' })
        } else {
          moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        }
        discarded.push(cardId)
      }
      if (discarded.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: discarded, reason: CHAIXIE }, { sourceId: ownerId, targetId, cardIds: discarded })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'use-ask') return
    const { dagongcheId } = prompt.data as { dagongcheId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !Object.values(owner.zones.equipment).includes(dagongcheId)) return
    const others = alivePlayers(host.state).filter((player) => player.id !== ownerId)
    if (others.length === 0) return
    host.askSkill({
      skillId: CHAIXIE, ownerId, step: 'use-ask', data: { dagongcheId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【大攻车】：是否视为使用一张不计入次数的杀？', timeoutMs: 20_000, optional: true,
        options: [...others.map((player) => ({ id: player.id, label: player.nickname })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { dagongcheId } = resolution.data as { dagongcheId: CardId }
    const targetId = (response.payload as { optionId?: string }).optionId
    if (!targetId || targetId === 'none') return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const used = host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: `${CHAIXIE}:dagongche`, countUsage: false })
    if (used) {
      const discardExtra = owner.marks[`dagongcheDiscard:${dagongcheId}`] ?? 0
      host.state.dagongcheDiscardPending ??= {}
      host.state.dagongcheDiscardPending[targetId] = 1 + discardExtra
    }
  },
})

/* ============================== 孙资刘放 ============================== */

const QINSHEN = 'qinshen'
const WEIDANG = 'weidang'

function nameCharLength(name: string): number {
  return [...name].length
}

function missingSuitsThisTurn(state: SanguoshaState): number {
  const seen = new Set(state.turnDiscardSuits ?? [])
  return 4 - seen.size
}

registerSkillRuntime({
  id: QINSHEN,
  triggers: [
    {
      event: 'CardMove',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { cardIds?: CardId[] }
        for (const cardId of payload.cardIds ?? []) {
          if (!host.state.zones.discardPile.includes(cardId)) continue
          const card = host.state.cards[cardId]
          if (!card) continue
          host.state.turnDiscardSuits ??= []
          if (!host.state.turnDiscardSuits.includes(card.suit)) host.state.turnDiscardSuits.push(card.suit)
        }
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase === 'prepare' && payload.playerId) host.state.turnDiscardSuits = []
        if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = missingSuitsThisTurn(host.state)
        if (x > 0) {
          drawCards(host.state, host.rng, ownerId, x, (n, p) => { host.dispatch(n, p) })
          host.dispatch('SkillActivated', { skillId: QINSHEN, skillName: '勤慎', playerId: ownerId, logText: `${owner.nickname}发动【勤慎】，摸了${x}张牌` }, { sourceId: ownerId })
        }
      },
    },
  ],
})

registerSkillRuntime({
  id: WEIDANG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const x = missingSuitsThisTurn(host.state)
      if (x <= 0) return
      const costCandidates = owner.zones.hand.filter((id) => nameCharLength(host.state.cards[id]?.name ?? '') === x)
      if (costCandidates.length === 0) return
      host.queueSkill({ skillId: WEIDANG, ownerId, step: 'ask', data: { x } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { x } = prompt.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const costCandidates = owner.zones.hand.filter((id) => nameCharLength(host.state.cards[id]?.name ?? '') === x)
    if (costCandidates.length === 0) return
    host.askSkill({
      skillId: WEIDANG, ownerId, step: 'ask', data: { x },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【伪谠】：可以将一张牌名字数为${x}的牌置于牌堆底`, timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: costCandidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const { x } = resolution.data as { x: number }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WEIDANG }, { sourceId: ownerId, cardIds: [cardId] })
    const pool = host.state.zones.drawPile.filter((id) => nameCharLength(host.state.cards[id]?.name ?? '') === x)
    if (pool.length === 0) return
    const gainedId = pool[host.rng.nextInt(pool.length)]
    moveCard(host.state, gainedId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [gainedId], reason: WEIDANG }, { targetId: ownerId, cardIds: [gainedId] })
    host.dispatch('SkillActivated', { skillId: WEIDANG, skillName: '伪谠', playerId: ownerId, logText: `${owner.nickname}发动【伪谠】` }, { sourceId: ownerId, cardIds: [gainedId] })
  },
})

/* ============================== 乐綝 ============================== */

const POERUI = 'poerui'
const GONGHU = 'gonghu'

registerSkillRuntime({
  id: POERUI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || !payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const limit = (owner.marks.gonghuUpgradeA ?? 0) ? 2 : 1
      if ((owner.marks.poeruiRoundUsed ?? 0) >= limit) return
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && player.id !== payload.playerId && (player.marks.turnLossCount ?? 0) > 0)
      if (candidates.length === 0) return
      host.queueSkill({ skillId: POERUI, ownerId, step: 'discard-ask', data: {} })
    },
  }, {
    event: 'LoseCard',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId) return
      const player = playerOf(host.state, payload.playerId)
      if (player) player.marks.turnLossCount = (player.marks.turnLossCount ?? 0) + 1
    },
  }, {
    event: 'PhaseStart',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || !payload.playerId) return
      const player = playerOf(host.state, payload.playerId)
      if (player) player.marks.turnLossCount = 0
    },
  }, {
    event: 'RoundStart',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (owner) owner.marks.poeruiRoundUsed = 0
    },
  }, {
    // beginVirtualSlash 一次只能挂起一张牌的结算（有牌在结算中会直接抛错），
    // X+1 张连续虚拟杀必须等上一张真正结算完（AfterCardUse）才能发起下一张。
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const pending = host.state.poeruiPending
      if (!pending || pending.ownerId !== ownerId) return
      const payload = context.event.payload as { sourceSkillId?: string }
      if (payload.sourceSkillId !== POERUI) return
      host.state.poeruiPending = { ...pending, remaining: pending.remaining - 1 }
      host.queueSkill({ skillId: POERUI, ownerId, step: 'slash-loop', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'discard-ask') {
      if (owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: POERUI, ownerId, step: 'discard-ask', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【破锐】：弃置一张牌（可放弃）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'pick-target') {
      const candidates = alivePlayers(host.state).filter((player) => player.id !== ownerId && (player.marks.turnLossCount ?? 0) > 0)
      if (candidates.length === 0) return
      host.askSkill({
        skillId: POERUI, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【破锐】：选择一名本回合失去过牌的角色', timeoutMs: 20_000, optional: false,
          options: candidates.map((player) => ({ id: player.id, label: player.nickname })),
        }),
      })
      return
    }
    if (prompt.step === 'slash-loop') {
      const pending = host.state.poeruiPending
      if (!pending || pending.ownerId !== ownerId) return
      const target = playerOf(host.state, pending.targetId)
      if (pending.remaining <= 0 || !target?.alive) {
        host.state.poeruiPending = undefined
        if (pending.giveX > 0 && target?.alive && owner.zones.hand.length > 0) {
          host.askSkill({
            skillId: POERUI, ownerId, step: 'give-cards', data: { targetId: pending.targetId, giveX: pending.giveX },
            build: (requestId): ChooseCardsRequest => ({
              id: requestId, kind: 'choose-cards', playerId: ownerId,
              prompt: `【破锐】：交给${target.nickname} ${Math.min(pending.giveX, owner.zones.hand.length)} 张手牌`, timeoutMs: 20_000, optional: false,
              purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [],
              min: Math.min(pending.giveX, owner.zones.hand.length), max: Math.min(pending.giveX, owner.zones.hand.length),
            }),
          })
        }
        return
      }
      host.beginVirtualSlash({ sourceId: ownerId, targetId: pending.targetId, sourceSkillId: POERUI, countUsage: false })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'discard-ask') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: POERUI }, { sourceId: ownerId, cardIds: [cardId] })
      host.queueSkill({ skillId: POERUI, ownerId, step: 'pick-target', data: {} })
      return
    }
    if (resolution.step === 'pick-target') {
      const targetId = (response.payload as { optionId?: string }).optionId
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      owner.marks.poeruiRoundUsed = (owner.marks.poeruiRoundUsed ?? 0) + 1
      const x = Math.min(target.marks.turnLossCount ?? 0, 5)
      host.dispatch('SkillActivated', { skillId: POERUI, skillName: '破锐', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【破锐】，视为使用${x + 1}张杀` }, { sourceId: ownerId, targetId: target.id })
      host.state.poeruiPending = { ownerId, targetId: target.id, remaining: x + 1, giveX: (owner.marks.gonghuUpgradeB ?? 0) ? 0 : x }
      host.queueSkill({ skillId: POERUI, ownerId, step: 'slash-loop', data: {} })
      return
    }
    if (resolution.step === 'give-cards') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const cardIds = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => owner.zones.hand.includes(id))
      if (cardIds.length === 0) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds, reason: POERUI }, { sourceId: ownerId, targetId, cardIds })
    }
  },
})

registerSkillRuntime({
  id: GONGHU,
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
        if (payload.playerId !== ownerId || host.state.currentPlayerId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks.gonghuUpgradeA) return
        const basicCount = (payload.cardIds ?? []).filter((id) => host.state.cards[id]?.category === 'basic').length
        owner.marks.gonghuTurnBasicLoss = (owner.marks.gonghuTurnBasicLoss ?? 0) + basicCount
        if ((owner.marks.gonghuTurnBasicLoss ?? 0) > 1) {
          owner.marks.gonghuUpgradeA = 1
          host.dispatch('SkillActivated', { skillId: GONGHU, skillName: '共护', playerId: ownerId, logText: `${owner.nickname}永久强化【破锐】为每轮两次` }, { sourceId: ownerId })
        }
      },
    },
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) player.marks.gonghuTurnBasicLoss = 0
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        const targetId = context.event.targetId
        const amount = context.event.payload.amount as number
        if (host.state.currentPlayerId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.marks.gonghuUpgradeB) return
        if (sourceId === ownerId) owner.marks.gonghuOutgoingTotal = (owner.marks.gonghuOutgoingTotal ?? 0) + amount
        if (targetId === ownerId) owner.marks.gonghuIncomingTotal = (owner.marks.gonghuIncomingTotal ?? 0) + amount
        if ((owner.marks.gonghuOutgoingTotal ?? 0) > 1 || (owner.marks.gonghuIncomingTotal ?? 0) > 1) {
          owner.marks.gonghuUpgradeB = 1
          host.dispatch('SkillActivated', { skillId: GONGHU, skillName: '共护', playerId: ownerId, logText: `${owner.nickname}永久强化【破锐】：不再交出手牌` }, { sourceId: ownerId })
        }
      },
    },
    {
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (player) { player.marks.gonghuOutgoingTotal = 0; player.marks.gonghuIncomingTotal = 0 }
      },
    },
  ],
  /*
   * 共护"双强化达成后"的终极效果（红色基本牌无法被响应 / 红色普通锦囊额外
   * 指定目标）需要"这次使用完全不能被响应"和"锦囊牌通用额外目标"两个
   * 引擎钩子，翻遍 skills/runtime.ts 和 cards/{basic,tricks}.ts 都没有
   * 任何一张现有武将用过的同类实现（无双、无懈可击都不是这个语义）。
   * 现有 marks（gonghuUpgradeA/B）已经完整、正确地记录了两段永久强化
   * 是否达成——这是【破锐】次数上限 1→2、"交出手牌"条款是否保留的唯一
   * 依据，已经生效。双强化之后的终极效果目前没有可复用钩子可挂，
   * 已作为已知简化在报告中说明，不在此臆造一套跨 basic/tricks 的新拦截。
   */
})

/* ============================== 角色定义 ============================== */

export const HISTORICAL_BATCH22_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'yuejin', name: '乐进', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: XIAOGUO, name: '骁果', description: '其他角色的结束阶段，你可以弃置一张基本牌，令其选择一项：弃置一张装备牌，然后你摸一张牌；或受到你造成的1点伤害。' },
    ],
  },
  {
    id: 'lidian', name: '李典', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: XUNXUN, name: '恂恂', description: '摸牌阶段开始时，你可以观看牌堆顶四张牌，将其中两张置于牌堆顶，其余置于牌堆底。' },
      { id: WANGXI, name: '忘隙', description: '当你对其他角色造成伤害后，或受到其他角色造成的伤害后，你按此伤害的点数，依次各摸两张牌，然后交给对方一张牌。' },
    ],
  },
  {
    id: 'caohong', name: '曹洪', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: HUYUAN, name: '护援', description: '结束阶段，你可以将一张装备牌置入一名角色的装备区，然后你可以弃置与该角色距离为1的一名角色的一张牌。' },
    ],
  },
  {
    id: 'caofang', name: '曹芳', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: ZHIMIN, name: '置民', description: '锁定技，每轮开始时，你选择至多X名其他角色（X为你的体力值），获得其手牌中点数最小的一张牌；你在回合外获得的手牌标记为"民"，每当你失去一张"民"后，你将手牌摸至体力上限。' },
      { id: JUJIAN, name: '拒谏', description: '主公技，出牌阶段限一次，你可以令一名其他魏势力角色摸一张牌，若如此做，本轮内其使用的普通锦囊牌对你无效。' },
    ],
  },
  {
    id: 'sunluyu', name: '孙鲁育', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'sp',
    skills: [
      { id: MEIBU, name: '魅步', description: '其他角色的出牌阶段开始时，你可以弃置一张牌，令其本回合获得技能"止息"；若其因"止息"弃置的牌与你此次弃置的牌花色相同，你获得之。' },
      { id: ZHIXI, name: '止息', granted: true, locked: true, description: '锁定技，你于出牌阶段使用【杀】或普通锦囊牌时，弃置一张手牌。' },
      { id: MUMU, name: '穆穆', description: '出牌阶段开始时，你可以选择一项：弃置一名其他角色装备区里的一张牌，然后本回合你使用【杀】的次数上限+1；或获得一名其他角色装备区里的一张牌，然后本回合你使用【杀】的次数上限-1。' },
    ],
  },
  {
    id: 'xunchen', name: '荀谌', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: FENGLUE, name: '锋略', description: '出牌阶段限一次，你可以与一名角色拼点：若你赢，你获得其区域内两张牌；若点数相同，你获得你拼点的牌，且锋略视为本阶段未发动；若你输，其获得你拼点的牌。' },
      { id: ANYONG, name: '暗涌', description: '一名角色的回合内第一次造成伤害后，若此伤害为1点，你可以弃置一张牌，然后对受到伤害的角色造成1点伤害。' },
    ],
  },
  {
    id: 'zongyu', name: '宗预', kingdom: 'shu', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: QIAO, name: '气傲', description: '每回合限两次，你成为其他势力角色使用牌的目标后，你可以弃置其一张手牌，然后你弃置一张牌。' },
      { id: CHENGSHANG, name: '承赏', description: '出牌阶段限一次，你使用一张目标至少包含一名其他势力角色的牌，结算完毕后，若这张牌没有造成伤害，你可以获得牌堆中与之花色、点数均相同的一张牌（若没有因此获得牌，承赏视为本阶段未发动）。' },
    ],
  },
  {
    id: 'zhangfen', name: '张奋', kingdom: 'wu', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: WANGLU, name: '望橹', description: '锁定技，回合开始时，若你的装备区里没有【大攻车】，将之置入你的装备区，否则你执行一个额外的出牌阶段。' },
      { id: XIANZHU, name: '陷筑', description: '当你使用【杀】造成伤害后，你可以按以下一项升级【大攻车】（每个至多升级五次）：无距离限制且无视防具；可额外选择一个目标；造成伤害后弃置目标角色的牌数+1。' },
      { id: CHAIXIE, name: '拆械', description: '锁定技，当【大攻车】销毁后，你摸X张牌（X为此【大攻车】的升级次数）。' },
    ],
  },
  {
    id: 'sunzi_liufang', name: '孙资刘放', kingdom: 'wei', gender: 'male', maxHp: 3, pack: 'sp',
    skills: [
      { id: QINSHEN, name: '勤慎', description: '你的弃牌阶段结束时，你可以摸X张牌（X为本回合没有进入过弃牌堆的花色数）。' },
      { id: WEIDANG, name: '伪谠', description: '其他角色的结束阶段，X为本回合没有进入过弃牌堆的花色数，你可以将一张中文牌名字数为X的牌置于牌堆底，然后获得牌堆中一张中文牌名字数为X的牌（若能合法使用，你使用之）。' },
    ],
  },
  {
    id: 'yuechen', name: '乐綝', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
    skills: [
      { id: POERUI, name: '破锐', description: '每轮限一次，其他角色的结束阶段，你可以弃置一张牌并选择本回合失去过牌的另一名其他角色，视为对其使用X+1张【杀】（X为其本回合失去的牌数，至多为5），然后你交给其X张手牌（不足则全部交给）。' },
      { id: GONGHU, name: '共护', description: '锁定技，你于回合外在一个回合内失去超过一张基本牌后，【破锐】永久改为每轮限两次；你于回合外在一个回合内造成或受到超过1点伤害后，永久删除【破锐】"然后你交给其X张手牌"的部分；两者都达成后，你使用红色基本牌无法被响应，使用红色普通锦囊牌可以额外指定一个目标。' },
    ],
  },
]
