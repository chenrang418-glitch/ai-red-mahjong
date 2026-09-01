import { findLegalAction, type LegalAction } from '../actions'
import { resolveDamage } from '../damage'
import { canTarget, getDistance } from '../distance'
import type { ChooseCardsRequest, GameResponse, RespondCardRequest } from '../requests'
import { validateResponse } from '../requests'
import { dodgeViewAsOptions, ignoresTrickDistance, skillIdsOf } from '../../data/characters/standard'
import { skillsOf } from '../skills/runtime'
import { performJudgment } from '../judgment'
import { advanceGamePhase } from '../phase'
import { recover } from '../recover'
import type { PlayerId, SanguoshaState, SlashResolutionState } from '../types'
import { moveCard } from '../zones'
import { BAGUA_ACTION_ID, canInvokeBagua, handleEquipmentLost, hasUnlimitedSlash, isCardIneffective } from '../equipment'
import type { CardEngineHost } from './host'
import { beginPhysicalCard, finishPhysicalCard, playerOf, playerOf as player, useAction } from './host'
import {
  INSTANT_TRICKS,
  askNullification,
  beginInstantTrick,
  instantTrickActions,
  resolveTrickEffectResponse,
  resolveTrickPickResponse,
  resumeTrickResolution,
} from './tricks'

export type { CardEngineHost }

const DELAYED_TRICKS = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

/** 出牌阶段这名玩家能做的所有牌面转化。 */
function viewAsPlayOptions(state: SanguoshaState, playerId: PlayerId) {
  return skillsOf(state, playerId, skillIdsOf).flatMap((runtime) => runtime.viewAs?.(state, playerId) ?? [])
}

function hasDelayedTrick(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return player(state, playerId).zones.judgingArea.some((cardId) => state.cards[cardId]?.name === name)
}

/** 只从当前公开规则状态生成操作；客户端不自行推断距离或卡牌用途。 */
export function legalPlayActions(state: SanguoshaState, playerId: PlayerId): LegalAction[] {
  if (state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== playerId || state.pendingRequests.length > 0 || state.cardResolution) return []
  const source = player(state, playerId)
  if (!source.alive) return []
  const actions: LegalAction[] = [{ id: 'play:pass', kind: 'pass', playerId, label: '结束出牌', requestId: `play-${state.turnNumber}` }]

  // 主动技（苦肉等）：技能自己报告现在能不能发动，前端不猜
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    for (const option of runtime.activeActions?.(state, playerId) ?? []) {
      actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: runtime.id, cardIds: [], targetIds: [] })
    }
  }

  // 转化技（武圣、龙胆）：把「这张红牌当杀打某人」作为独立动作发出去。
  // 不能让前端自己猜牌的用途——同一张红牌既可以原样用，也可以当杀，
  // 必须两条动作都在，玩家才选得到用途。
  for (const option of viewAsPlayOptions(state, playerId)) {
    if (option.asCardName !== '杀') continue
    if (state.turnUsage.slashUses >= 1 && !hasUnlimitedSlash(state, playerId)) continue
    for (const target of state.players) {
      if (!canTarget(state, playerId, target.id)) continue
      actions.push({
        ...useAction(option.cardId, playerId, '杀', [target.id], `${option.label}，目标${target.nickname}`),
        id: `play:viewas:${option.cardId}:${target.id}`,
      })
    }
  }

  for (const cardId of source.zones.hand) {
    const card = state.cards[cardId]
    if (!card) continue
    if (card.name === '杀' && (state.turnUsage.slashUses < 1 || hasUnlimitedSlash(state, playerId))) {
      for (const target of state.players) {
        if (canTarget(state, playerId, target.id)) actions.push(useAction(cardId, playerId, '杀', [target.id], `对${target.nickname}使用【杀】`))
      }
    } else if (card.name === '桃' && source.hp < source.maxHp) {
      actions.push(useAction(cardId, playerId, '桃', [playerId], '使用【桃】回复体力'))
    } else if (card.name === '酒' && state.turnUsage.wineUses < 1) {
      actions.push(useAction(cardId, playerId, '酒', [playerId], '使用【酒】强化下一张杀'))
    } else if (card.category === 'equipment' && card.equipmentSlot) {
      actions.push(useAction(cardId, playerId, card.name, [playerId], `装备【${card.name}】`))
    } else if (INSTANT_TRICKS.has(card.name)) {
      actions.push(...instantTrickActions(state, playerId, cardId))
    } else if (card.name === '乐不思蜀') {
      for (const target of state.players.filter((candidate) => candidate.alive && candidate.id !== playerId && !hasDelayedTrick(state, candidate.id, card.name))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【乐不思蜀】`))
      }
    } else if (card.name === '兵粮寸断') {
      const ignoreDistance = ignoresTrickDistance(state, playerId)
      for (const target of state.players.filter((candidate) => candidate.alive && candidate.id !== playerId && (ignoreDistance || getDistance(state, playerId, candidate.id) <= 1) && !hasDelayedTrick(state, candidate.id, card.name))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【兵粮寸断】`))
      }
    } else if (card.name === '闪电' && !hasDelayedTrick(state, playerId, card.name)) {
      actions.push(useAction(cardId, playerId, card.name, [playerId], '将【闪电】置入自己的判定区'))
    }
  }
  return actions
}

function recordPlayDecision(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: `play-${host.state.turnNumber}`,
    playerId,
    kind: 'play-action',
    payload: { actionId },
  })
}

function beginSlash(host: CardEngineHost, action: Extract<LegalAction, { kind: 'use-card' }>): void {
  const [cardId] = action.cardIds
  const [targetId] = action.targetIds
  const card = host.state.cards[cardId]
  if (!beginPhysicalCard(host, action.playerId, cardId, [targetId])) return
  const damageAmount = 1 + host.state.turnUsage.wineDamageBonus
  host.state.turnUsage.slashUses += 1
  host.state.turnUsage.wineDamageBonus = 0
  // 仁王盾挡黑杀、藤甲挡普通杀：这张牌对目标完全无效，连闪都不用问
  if (isCardIneffective(host.state, targetId, '杀', card.color, card.damageNature ?? 'normal')) {
    finishPhysicalCard(host, action.playerId, cardId, [targetId], true)
    return
  }
  host.state.cardResolution = {
    kind: 'slash', cardId, sourceId: action.playerId, targetId,
    damageNature: card.damageNature ?? 'normal', damageAmount,
    stage: 'awaiting-dodge', requestId: null, surrogate: null,
  }
  askDodge(host, targetId, `${player(host.state, action.playerId).nickname}对你使用【杀】，请响应【闪】`, true)
}

/**
 * 请某人打出【闪】。
 *
 * 目标自己和主公技代打者共用这条路径，区别只有两点：
 * 代打者没有八卦阵可用（那是目标装备区里的牌），提示词也不一样。
 */
function askDodge(host: CardEngineHost, responderId: PlayerId, prompt: string, allowBagua: boolean): void {
  const responder = player(host.state, responderId)
  const actionIds = responder.zones.hand
    .filter((candidateId) => host.state.cards[candidateId]?.name === '闪')
    .map((candidateId) => `respond-dodge:${candidateId}`)
  // 龙胆把【杀】当【闪】打出，同样要作为独立动作发出去
  for (const option of dodgeViewAsOptions(host.state, responderId)) {
    actionIds.push(`respond-dodge:${option.cardId}`)
  }
  // 八卦阵不是手牌，但同样是「打出闪」的一种途径，必须出现在合法动作里，
  // 否则前端永远点不到它——服务端支持不等于前端能用。
  if (allowBagua && canInvokeBagua(host.state, responderId)) actionIds.push(BAGUA_ACTION_ID)
  actionIds.push('respond-pass')
  const request: RespondCardRequest = {
    // id 必须唯一：主公技代打会在同一个 seq 里连着问好几个人，
    // 复用 id 会让「响应后没有推进」的死锁守卫误报，也会让回放对不上
    id: `request-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName: '闪',
  }
  host.state.pendingRequests.push(request)
  if (host.state.cardResolution) host.state.cardResolution.requestId = request.id
}

/**
 * 主公技代打（护驾）：目标放弃之后，转问同势力角色有没有人替他打。
 *
 * 返回 true 表示已经问出去了，调用方必须直接返回，不要继续结算伤害。
 */
function askLordSurrogate(host: CardEngineHost, resolution: SlashResolutionState): boolean {
  if (resolution.surrogate === null) {
    const runtime = skillsOf(host.state, resolution.targetId, skillIdsOf)
      .find((candidate) => candidate.surrogateResponders)
    if (!runtime) return false
    const order = runtime.surrogateResponders!(host.state, resolution.targetId, '闪')
    if (order.length === 0) return false
    resolution.surrogate = { skillId: runtime.id, order, index: 0 }
  } else {
    resolution.surrogate.index += 1
  }

  const { order, skillId } = resolution.surrogate
  // 问的过程中有人可能已经死了，跳过
  while (resolution.surrogate.index < order.length) {
    const responderId = order[resolution.surrogate.index]
    const responder = host.state.players.find((candidate) => candidate.id === responderId)
    if (responder?.alive) {
      askDodge(host, responderId, `主公需要【闪】，你可以发动【${skillId === 'hujia' ? '护驾' : '代打'}】替他打出`, false)
      return true
    }
    resolution.surrogate.index += 1
  }
  return false
}

function placeDelayedTrick(host: CardEngineHost, action: Extract<LegalAction, { kind: 'use-card' }>): void {
  const [cardId] = action.cardIds
  const [targetId] = action.targetIds
  if (!beginPhysicalCard(host, action.playerId, cardId, [targetId])) return
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: targetId })
  finishPhysicalCard(host, action.playerId, cardId, [targetId])
}

export function performPlayAction(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  const action = findLegalAction(legalPlayActions(host.state, playerId), playerId, actionId)
  recordPlayDecision(host, playerId, actionId)
  if (action.kind === 'pass') {
    advanceGamePhase(host)
    return
  }
  if (action.kind === 'invoke-skill') {
    const runtime = skillsOf(host.state, playerId, skillIdsOf).find((candidate) => candidate.id === action.skillId)
    if (!runtime?.invokeActive) throw new Error('技能不可发动')
    runtime.invokeActive(host, playerId, action.id)
    return
  }
  if (action.kind !== 'use-card') throw new Error('当前不是可执行的出牌动作')
  const [cardId] = action.cardIds
  const card = host.state.cards[cardId]
  if (!card || !player(host.state, playerId).zones.hand.includes(cardId)) throw new Error('卡牌不属于出牌玩家')

  // 转化出的动作以 asCardName 为准：武圣打出的红桃仍然按【杀】结算
  if (action.asCardName === '杀') {
    beginSlash(host, action)
    return
  }
  if (card.name === '杀') {
    beginSlash(host, action)
    return
  }
  if (DELAYED_TRICKS.has(card.name)) {
    placeDelayedTrick(host, action)
    return
  }
  if (INSTANT_TRICKS.has(card.name)) {
    if (!beginPhysicalCard(host, playerId, cardId, action.targetIds)) return
    beginInstantTrick(host, playerId, cardId, action.targetIds)
    return
  }
  if (!beginPhysicalCard(host, playerId, cardId, action.targetIds)) return
  if (card.name === '桃') {
    recover(host, playerId, 1, playerId)
  } else if (card.name === '酒') {
    host.state.turnUsage.wineUses += 1
    host.state.turnUsage.wineDamageBonus = 1
  } else if (card.category === 'equipment' && card.equipmentSlot) {
    const replaced = playerOf(host.state, playerId).zones.equipment[card.equipmentSlot]
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot: card.equipmentSlot })
    if (replaced) handleEquipmentLost(host, playerId, replaced)
  } else {
    throw new Error(`尚未实现卡牌：${card.name}`)
  }
  finishPhysicalCard(host, playerId, cardId, action.targetIds)
}

function removeResponseRequest(state: SanguoshaState, requestId: string): void {
  state.pendingRequests = state.pendingRequests.filter((request) => request.id !== requestId)
}

function recordResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}

export function resolveCardResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.requestId !== request.id) throw new Error('卡牌响应 Request 已经过期')
  // 锦囊效果阶段问的是「打出杀/闪」，和无懈询问不是一回事，交给 tricks 处理
  if (resolution.kind === 'trick' && resolution.stage === 'awaiting-effect') {
    resolveTrickEffectResponse(host, request, response)
    return
  }
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId

  // 八卦阵：判定红色就当作打出了一张【闪】，黑色则视为没有响应
  if (actionId === BAGUA_ACTION_ID) {
    if (resolution.kind !== 'slash' || !canInvokeBagua(host.state, response.playerId)) throw new Error('当前不能发动【八卦阵】')
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    const judged = performJudgment(host, response.playerId, '八卦阵')
    if (judged.color === 'red') {
      finishPhysicalCard(host, resolution.sourceId, resolution.cardId, [resolution.targetId])
      host.state.cardResolution = null
      return
    }
    resolution.stage = 'awaiting-dying'
    resolveDamage(host, {
      sourceId: resolution.sourceId,
      targetId: resolution.targetId,
      amount: resolution.damageAmount,
      nature: resolution.damageNature,
      cardName: '杀',
      cardId: resolution.cardId,
    })
    if (!host.state.dying && !host.state.damageChain) resumeCardResolution(host)
    return
  }

  let responseCardId: string | null = null
  if (actionId !== 'respond-pass') {
    const prefix = resolution.kind === 'slash' ? 'respond-dodge:' : 'respond-nullification:'
    const requiredName = resolution.kind === 'slash' ? '闪' : '无懈可击'
    if (!actionId.startsWith(prefix)) throw new Error('响应 action 类型不匹配')
    responseCardId = actionId.slice(prefix.length)
    const responder = player(host.state, response.playerId)
    const heldName = host.state.cards[responseCardId]?.name
    const convertible = resolution.kind === 'slash'
      && dodgeViewAsOptions(host.state, response.playerId).some((option) => option.cardId === responseCardId)
    if (!responder.zones.hand.includes(responseCardId) || (heldName !== requiredName && !convertible)) {
      throw new Error(`响应牌不是该玩家持有的${requiredName}`)
    }
  }
  removeResponseRequest(host.state, request.id)
  resolution.requestId = null
  recordResponse(host, request, response)

  if (resolution.kind === 'trick') {
    if (actionId !== 'respond-pass') {
      const cardId = responseCardId!
      const responder = player(host.state, response.playerId)
      const targetId = resolution.targetIds[resolution.targetIndex]
      moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
      host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId, cardName: '无懈可击' }, { sourceId: responder.id, targetId, cardIds: [cardId] })
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      resolution.nullificationCount += 1
      // 被无懈之后要从头再问一圈：任何人都可以对这张无懈再无懈
      resolution.responderIndex = 0
    } else resolution.responderIndex += 1
    askNullification(host)
    return
  }

  if (actionId !== 'respond-pass') {
    const cardId = responseCardId!
    const responder = player(host.state, response.playerId)
    moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
    host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId, cardName: '闪' }, { sourceId: responder.id, targetId: resolution.sourceId, cardIds: [cardId] })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    finishPhysicalCard(host, resolution.sourceId, resolution.cardId, [resolution.targetId])
    host.state.cardResolution = null
    return
  }

  // 主公技：目标自己不出闪时，同势力角色还有机会代打
  if (askLordSurrogate(host, resolution)) return

  resolution.stage = 'awaiting-dying'
  resolveDamage(host, {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardName: '杀',
    cardId: resolution.cardId,
  })
  if (!host.state.dying && !host.state.damageChain) resumeCardResolution(host)
}

/** 锦囊效果里的「挑一张牌」响应入口。 */
export function resolveCardPickResponse(host: CardEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  resolveTrickPickResponse(host, request, response)
}

export function resumeCardResolution(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution) return
  // 锦囊多目标：某个目标濒死救完之后要接着结算剩下的目标
  if (resolution.kind === 'trick') {
    resumeTrickResolution(host)
    return
  }
  if (resolution.stage !== 'awaiting-dying' || host.state.dying) return
  finishPhysicalCard(host, resolution.sourceId, resolution.cardId, [resolution.targetId])
  host.state.cardResolution = null
}
