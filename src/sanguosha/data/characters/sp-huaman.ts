import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { moveCard } from '../../engine/zones'
import { executeUseCardAction } from '../../engine/cards/basic'
import { grantSkill, ownedSkillIds, registerSkillRuntime } from '../../engine/skills/runtime'
import { suppressSkill } from '../../engine/skill-suppression'
import { effectiveGenderOf } from '../../engine/huashen'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 花鬘（三国杀 OL 经典身份 SP）。
 *
 * 【蛮裔】：锁定技，【南蛮入侵】对花鬘无效。
 * 【蛮嗣】：出牌阶段限一次，可以将所有手牌当【南蛮入侵】使用；任意角色
 *          受到【南蛮入侵】伤害后，花鬘摸1张牌（此摸牌计入觉醒条件累计）。
 * 【薮影】：每回合限一次，双向：她使用牌指定其他角色为唯一目标后，或
 *          成为其他角色使用牌的唯一目标后，若这张牌不是本回合使用者对
 *          目标角色使用的第一张牌，可弃1张手牌，收回此牌/令此牌对自己
 *          无效。方向A用"结算后回收实体牌"实现；方向B复用引擎已有的
 *          `interceptTarget`（"成为杀/普通锦囊目标后可插入发问"）通用
 *          插入点，真实交互式发问，答案是取消/不取消这一次成为目标。
 * 【战缘】：觉醒技，蛮嗣累计摸牌数>7时，体力上限+1、回复1点，可选一名
 *          男性角色与花鬘永久获得【系力】，永久失去【蛮嗣】。
 * 【系力】：觉醒后可能获得的共享技能，见下方独立注册。
 */

const MANYI = 'manyi'
const MANSI = 'mansi'
const MANSI_INVOKE = 'mansi-invoke'
const SOUYING = 'souying'
const ZHANYUAN = 'zhanyuan'
export const XILI = 'xili'
const MANSI_DRAW_TOTAL = 'mansi-draw-total'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 记一次 (source -> target) 本 TurnInstance 内的使用次数，返回这是不是本回合第一次。 */
function bumpUseCount(state: SanguoshaState, key: string): boolean {
  state.huamanSouyingUseCount ??= {}
  const entry = state.huamanSouyingUseCount[key]
  const wasFirst = !entry || entry.turnNumber !== state.turnNumber
  state.huamanSouyingUseCount[key] = { turnNumber: state.turnNumber, count: wasFirst ? 1 : entry.count + 1 }
  return wasFirst
}

registerSkillRuntime({
  id: MANYI,
  cardEffectInvalid(_state, _ownerId, _sourceId, cardName) {
    return cardName === '南蛮入侵'
  },
})

registerSkillRuntime({
  id: MANSI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MANSI) || owner.zones.hand.length === 0) return []
    return [{ id: MANSI_INVOKE, label: '蛮嗣：将所有手牌当【南蛮入侵】使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== MANSI_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(MANSI) || owner.zones.hand.length === 0) return
    const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (others.length === 0) return
    owner.turnUsedSkills.push(MANSI)
    host.dispatch('SkillActivated', { skillId: MANSI, skillName: '蛮嗣', playerId: ownerId, logText: `${owner.nickname}发动【蛮嗣】，将所有手牌当【南蛮入侵】使用` }, { sourceId: ownerId })
    const cardIds = [...owner.zones.hand]
    executeUseCardAction(host as never, ownerId, {
      kind: 'use-card', id: `mansi:${cardIds[0]}`, playerId: ownerId,
      cardIds, targetIds: others, targetMin: others.length, targetMax: others.length,
      asCardName: '南蛮入侵', label: '蛮嗣：视为使用【南蛮入侵】',
    })
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string }
      if (payload.cardName !== '南蛮入侵') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      owner.marks[MANSI_DRAW_TOTAL] = (owner.marks[MANSI_DRAW_TOTAL] ?? 0) + 1
      host.dispatch('SkillActivated', { skillId: MANSI, skillName: '蛮嗣', playerId: ownerId, logText: `${owner.nickname}发动【蛮嗣】，摸1张牌` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: SOUYING,
  triggers: [
    {
      // 方向A：花鬘对唯一目标A使用牌后，可以弃1张手牌收回那张已结算完毕的牌
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[]; cancelled?: boolean }
        if (payload.cancelled || context.event.sourceId !== ownerId) return
        const targetIds = payload.targetIds ?? []
        if (targetIds.length !== 1 || targetIds[0] === ownerId) return
        const isFirst = bumpUseCount(host.state, `${ownerId}->${targetIds[0]}`)
        if (isFirst) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.turnUsedSkills.includes(SOUYING) || owner.zones.hand.length === 0) return
        const cardId = payload.cardId
        if (!cardId || !host.state.zones.discardPile.includes(cardId)) return
        host.queueSkill({ skillId: SOUYING, ownerId, step: 'ask-gain', data: { cardId } })
      },
    },
  ],
  // 方向B：A对唯一目标花鬘使用牌，非A本回合首次——复用引擎通用的
  // "成为杀/普通锦囊目标后可插入发问"插入点，真实交互式发问。
  interceptTarget(host, ownerId, context) {
    const sourceId = context.sourceId
    if (sourceId === ownerId) return false
    const resolution = host.state.cardResolution
    if (resolution?.kind === 'trick' && resolution.targetIds.length !== 1) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SOUYING) || owner.zones.hand.length === 0) return false
    const isFirst = bumpUseCount(host.state, `${sourceId}->${ownerId}`)
    if (isFirst) return false
    host.askSkill({
      skillId: SOUYING, ownerId, step: 'invalidate-ask', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【薮影】：可以弃置1张手牌，令这次使用对你无效', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-gain') return
    const { cardId } = prompt.data as { cardId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SOUYING) || owner.zones.hand.length === 0) return
    if (!host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: SOUYING, ownerId, step: 'gain-ask', data: { cardId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【薮影】：可以弃置1张手牌，收回那张刚结算完毕的牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'gain-ask') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [discardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!discardId || !owner?.alive || !owner.zones.hand.includes(discardId) || owner.turnUsedSkills.includes(SOUYING)) return
      if (!host.state.zones.discardPile.includes(cardId)) return
      moveCard(host.state, discardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [discardId], reason: SOUYING }, { sourceId: ownerId, cardIds: [discardId] })
      owner.turnUsedSkills.push(SOUYING)
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SOUYING }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: SOUYING, skillName: '薮影', playerId: ownerId, logText: `${owner.nickname}发动【薮影】，收回一张牌` }, { sourceId: ownerId })
      return
    }

    if (resolution.step === 'invalidate-ask') {
      const [discardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!discardId || !owner?.alive || !owner.zones.hand.includes(discardId) || owner.turnUsedSkills.includes(SOUYING)) {
        host.resumeCardTarget()
        return
      }
      moveCard(host.state, discardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [discardId], reason: SOUYING }, { sourceId: ownerId, cardIds: [discardId] })
      owner.turnUsedSkills.push(SOUYING)
      const current = host.state.cardResolution
      if (current?.kind === 'trick' && !current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
      else if (current?.kind === 'slash' && current.targetId === ownerId) current.targetCancelled = true
      host.dispatch('SkillActivated', { skillId: SOUYING, skillName: '薮影', playerId: ownerId, logText: `${owner.nickname}发动【薮影】，令这次使用对自己无效` }, { sourceId: ownerId })
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: ZHANYUAN,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      return !!owner?.alive && (owner.marks[MANSI_DRAW_TOTAL] ?? 0) > 7
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      owner.maxHp += 1
      owner.hp = Math.min(owner.maxHp, owner.hp + 1)
      host.dispatch('SkillActivated', { skillId: ZHANYUAN, skillName: '战缘', playerId: ownerId, logText: `${owner.nickname}发动觉醒技【战缘】，体力上限+1，回复1点体力` }, { sourceId: ownerId })
      host.dispatch('Recover', { playerId: ownerId, amount: 1, reason: ZHANYUAN }, { targetId: ownerId })
      grantSkill(host.state, ownerId, XILI)
      // 永久失去蛮嗣：复用夺锐同款单技能压制，armedAtTurn 设为不可达的值即永不到期
      suppressSkill(host.state, { targetId: ownerId, skillId: MANSI, sourceId: ownerId, sourceSkillId: ZHANYUAN, armedAtTurn: Number.POSITIVE_INFINITY })

      const maleIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && effectiveGenderOf(host.state, candidate.id) === 'male').map((candidate) => candidate.id)
      if (maleIds.length === 0) return
      host.queueSkill({ skillId: ZHANYUAN, ownerId, step: 'pick', data: {} })
    },
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    // 只保留"活着、当前性别为男"的候选；性别需要现算（可能被神化身等效果覆盖）
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId && effectiveGenderOf(host.state, candidate.id) === 'male')
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHANYUAN, ownerId, step: 'gender-check', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【战缘】：选择一名男性角色，与你永久获得【系力】', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'gender-check') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    grantSkill(host.state, targetId, XILI)
    host.dispatch('SkillActivated', { skillId: ZHANYUAN, skillName: '战缘', playerId: ownerId, targetId, logText: `${target.nickname}与${playerOf(host.state, ownerId)?.nickname ?? ''}永久获得【系力】` }, { sourceId: ownerId, targetId })
  },
})

registerSkillRuntime({
  id: XILI,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      const targetId = context.event.targetId
      const payload = context.event.payload as { amount?: number }
      if (!sourceId || !targetId || (payload.amount ?? 0) <= 0) return
      if (ownerId === sourceId || host.state.currentPlayerId !== sourceId || host.state.currentPlayerId === ownerId) return
      if (!ownedSkillIds(host.state, sourceId).includes(XILI) || ownedSkillIds(host.state, targetId).includes(XILI)) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      if (host.state.xiliUsedTurn?.turnNumber === host.state.turnNumber) return
      host.queueSkill({ skillId: XILI, ownerId, step: 'ask', data: { sourceId, targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (host.state.xiliUsedTurn?.turnNumber === host.state.turnNumber) return
    const { sourceId, targetId } = prompt.data as { sourceId: PlayerId; targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: XILI, ownerId, step: 'discard', data: { sourceId, targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【系力】：是否弃置1张牌，令这次伤害+1，然后与伤害来源各摸2张牌？', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    if (host.state.xiliUsedTurn?.turnNumber === host.state.turnNumber) return
    const { sourceId, targetId } = resolution.data as { sourceId: PlayerId; targetId: PlayerId }
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    const target = playerOf(host.state, targetId)
    if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId) || !source?.alive || !target?.alive) return
    host.state.xiliUsedTurn = { turnNumber: host.state.turnNumber }
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XILI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: XILI, skillName: '系力', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【系力】，追加1点伤害` }, { sourceId: ownerId, targetId: sourceId })
    // "此次伤害+1"：Damaged 是伤害落地后才触发，无法回溯改写已结算的那次伤害数值，
    // 改为对同一 source/target 立即补一次 1 点伤害，效果等价（总伤害+1）。
    resolveDamage(host as never, { sourceId, targetId, amount: 1, nature: 'normal', cardName: null })
    drawCards(host.state, host.rng, sourceId, 2, (name, payload) => { host.dispatch(name, payload) })
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const HUAMAN: CharacterDefinition = {
  id: 'huaman',
  name: '花鬘',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: MANYI, name: '蛮裔', description: '锁定技，【南蛮入侵】对你无效。' },
    { id: MANSI, name: '蛮嗣', description: '出牌阶段限一次，你可以将所有手牌当【南蛮入侵】使用；任意角色受到【南蛮入侵】造成的伤害后，你摸1张牌。' },
    { id: SOUYING, name: '薮影', description: '每个 TurnInstance 限一次：你对唯一目标使用牌后（非本回合首次对其用牌），可弃1张牌获得那张结算完毕的牌；一名角色对唯一目标你使用牌（非其本回合首次对你用牌）时，你弃1张牌令这次使用对你无效。' },
    { id: ZHANYUAN, name: '战缘', description: '觉醒技，准备阶段，若你因【蛮嗣】摸牌数超过7，体力上限+1并回复1点体力，可选一名男性角色与你永久获得【系力】，然后你永久失去【蛮嗣】。' },
    { id: XILI, name: '系力', granted: true, description: '拥有此技能的角色在自己回合内对没有此技能的角色造成伤害时，另一名拥有此技能且不在自己回合的角色可以弃1张牌，令这次伤害+1，然后两者各摸2张牌。' },
  ],
}
