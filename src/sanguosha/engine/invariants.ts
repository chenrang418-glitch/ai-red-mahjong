import type { EquipmentSlot, SanguoshaState } from './types'
import { assertCardConservation } from './zones'

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

/** 用于单测、无头压测和服务端提交后的完整状态校验。 */
export function assertGameInvariants(state: SanguoshaState): void {
  if (state.players.length < 5 || state.players.length > 8) throw new Error('身份局玩家数量必须为 5～8')
  if (new Set(state.players.map((player) => player.id)).size !== state.players.length) throw new Error('玩家 id 不唯一')
  const seats = state.players.map((player) => player.seat).sort((left, right) => left - right)
  if (seats.some((seat, index) => seat !== index)) throw new Error('玩家座次必须连续且唯一')
  if (!state.players.some((player) => player.id === state.currentPlayerId)) throw new Error('当前玩家不存在')

  for (const candidate of state.players) {
    if (!Number.isInteger(candidate.hp) || !Number.isInteger(candidate.maxHp) || candidate.maxHp <= 0 || candidate.hp > candidate.maxHp) {
      throw new Error(`玩家体力非法：${candidate.id}`)
    }
    if (!candidate.alive && !candidate.identityRevealed) throw new Error(`死亡角色身份未公开：${candidate.id}`)
    if (candidate.alive && candidate.hp <= 0 && state.dying?.playerId !== candidate.id) throw new Error(`存活角色处于非濒死的非正体力：${candidate.id}`)
    for (const slot of EQUIPMENT_SLOTS) {
      const cardId = candidate.zones.equipment[slot]
      if (cardId && state.cards[cardId]?.equipmentSlot !== slot) throw new Error(`装备槽类型不匹配：${candidate.id}/${slot}`)
    }
  }

  const requestIds = state.pendingRequests.map((request) => request.id)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('Request id 不唯一')
  for (const request of state.pendingRequests) {
    if (!state.players.some((candidate) => candidate.id === request.playerId && candidate.alive)) throw new Error(`Request 响应玩家非法：${request.id}`)
  }
  if (state.dying) {
    const target = state.players.find((candidate) => candidate.id === state.dying!.playerId)
    if (!target?.alive || target.hp > 0) throw new Error('DyingState 与目标状态不一致')
    if (state.dying.requestId && !state.pendingRequests.some((request) => request.id === state.dying!.requestId && request.kind === 'rescue')) {
      throw new Error('DyingState 指向不存在的救援 Request')
    }
  } else if (state.pendingRequests.some((request) => request.kind === 'rescue')) {
    throw new Error('存在救援 Request 但没有 DyingState')
  }
  if (state.damageChain) {
    if (state.damageChain.amount <= 0) throw new Error('属性伤害传导参数非法')
    if (new Set(state.damageChain.remainingTargetIds).size !== state.damageChain.remainingTargetIds.length) throw new Error('属性伤害传导目标重复')
    if (state.damageChain.remainingTargetIds.some((id) => !state.players.some((candidate) => candidate.id === id))) throw new Error('属性伤害传导目标不存在')
  }
  if (state.judgment) {
    if (!state.zones.processingArea.includes(state.judgment.delayedCardId)) throw new Error('结算中的延时锦囊不在处理区')
    if (state.judgment.stage === 'awaiting-nullification') {
      const requestId = state.judgment.requestId
      if (!state.pendingRequests.some((request) => request.id === requestId && request.kind === 'respond-card')) throw new Error('延时锦囊缺少无懈响应 Request')
    }
  }
  if (state.turnUsage.slashUses < 0 || state.turnUsage.wineUses < 0 || state.turnUsage.wineDamageBonus < 0) throw new Error('回合用牌计数非法')
  if (state.cardResolution) {
    if (!state.zones.processingArea.includes(state.cardResolution.cardId)) throw new Error('结算中的实体牌不在处理区')
    const stage = state.cardResolution.stage
    if (stage === 'awaiting-dodge' || stage === 'awaiting-nullification') {
      if (!state.cardResolution.requestId || !state.pendingRequests.some((request) => request.id === state.cardResolution!.requestId && request.kind === 'respond-card')) {
        throw new Error('卡牌结算缺少响应 Request')
      }
    } else if (stage === 'awaiting-dying' && state.cardResolution.requestId) {
      throw new Error('等待濒死结算时不应保留卡牌响应 Request')
    }
    // awaiting-effect 期间可以挂着请求（南蛮要杀、决斗轮流出杀、拆桥选牌），
    // 也可以没有请求（伤害刚结算完、正等着推进下一个目标），两种都合法。
  } else {
    // 判定阶段的无懈请求挂在 state.judgment 上，不属于 cardResolution，要排除掉。
    // JudgmentState 是联合类型，只有等待无懈那一支才有 requestId。
    const judgmentRequestId = state.judgment?.stage === 'awaiting-nullification' ? state.judgment.requestId : null
    const skillRequestId = state.skillResolution?.requestId ?? null
    if (state.pendingRequests.some((request) => request.kind === 'respond-card' && request.id !== judgmentRequestId && request.id !== skillRequestId)) {
      throw new Error('存在卡牌响应 Request 但没有结算状态')
    }
  }

  if (state.skillResolution) {
    const { requestId, ownerId } = state.skillResolution
    if (!state.pendingRequests.some((request) => request.id === requestId)) throw new Error('技能等待状态指向不存在的 Request')
    if (!state.players.some((player) => player.id === ownerId)) throw new Error('技能等待状态的拥有者不存在')
  }

  if (state.status === 'game-over' && (!state.result || state.pendingRequests.length > 0)) throw new Error('结束状态缺少结果或仍有 Request')
  if (state.status !== 'game-over' && state.result) throw new Error('未结束牌局不应存在胜负结果')
  assertCardConservation(state)
}
