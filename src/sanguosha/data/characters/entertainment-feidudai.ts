import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import { discardCardsByIds } from '../../engine/discard-all'
import { getDistance } from '../../engine/distance'
import { giveCards } from '../../engine/hand-transfer'
import { loseHp } from '../../engine/hp'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const FEIDAN = 'feidan-feidudai'
const QIANGDAN = 'qiangdan-feidudai'
const FENGYU = 'fengyu-wuzhu-feidudai'

type FeidudaiState = SanguoshaState & {
  feidudai?: {
    targetUses?: Record<string, number>
    qiangdanRound?: Record<PlayerId, number>
    qiangdanPending?: Record<PlayerId, boolean>
    distantUses?: Record<PlayerId, CardId[]>
  }
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((player) => player.id === playerId)
}

function handOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  return playerOf(state, playerId)?.zones.hand ?? []
}

function discardableOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  return player ? [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))] : []
}

function askOption(host: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId,
  step: string, prompt: string, options: Array<{ id: string; label: string }>, data: Record<string, unknown>, optional: boolean) {
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseOptionRequest => ({
    id, kind: 'choose-option', playerId, prompt, timeoutMs: 25_000, optional, options,
  }) })
}

function askOneCard(host: SkillHost, skillId: string, ownerId: PlayerId, playerId: PlayerId,
  step: string, prompt: string, cardIds: CardId[], data: Record<string, unknown>) {
  if (!cardIds.length) return false
  host.askSkill({ skillId, ownerId, step, data, build: (id): ChooseCardsRequest => ({
    id, kind: 'choose-cards', playerId, prompt, timeoutMs: 25_000,
    optional: false, purpose: 'skill', cardIds, hiddenCardSlots: [], min: 1, max: 1,
  }) })
  return true
}

registerSkillRuntime({
  id: FEIDAN,
  interceptTarget(host, ownerId, context) {
    if (context.sourceId === ownerId || host.state.currentPlayerId !== context.sourceId
      || usedThisTurn(host.state, ownerId, FEIDAN) || !playerOf(host.state, ownerId)?.alive) return false
    const state = host.state as FeidudaiState
    state.feidudai ??= {}
    state.feidudai.targetUses ??= {}
    const currentTurnPrefix = `${host.state.turnNumber}:`
    state.feidudai.targetUses = Object.fromEntries(Object.entries(state.feidudai.targetUses)
      .filter(([key]) => key.startsWith(currentTurnPrefix)))
    const key = `${host.state.turnNumber}:${context.sourceId}`
    const count = (state.feidudai.targetUses[key] ?? 0) + 1
    state.feidudai.targetUses[key] = count
    if (count !== 2) return false
    host.askSkill({ skillId: FEIDAN, ownerId, step: 'invoke', data: {
      targetId: context.sourceId, cardId: context.cardId,
    }, build: (id): ChooseOptionRequest => ({
      id, kind: 'choose-option', playerId: ownerId,
      prompt: '【肥胆】：是否令其选择交给你一张手牌，或令此牌对你无效？',
      timeoutMs: 25_000, optional: true,
      options: [{ id: 'yes', label: '发动【肥胆】' }, { id: 'no', label: '不发动' }],
    }) })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const optionId = (response.payload as { optionId?: string }).optionId
    if (resolution.step === 'invoke') {
      if (optionId !== 'yes' || !playerOf(host.state, targetId)?.alive) {
        host.resumeCardTarget()
        return
      }
      markUsedThisTurn(host.state, ownerId, FEIDAN)
      const options = [
        ...(handOf(host.state, targetId).length ? [{ id: 'give', label: '交给肥嘟袋鼠一张手牌' }] : []),
        { id: 'cancel', label: '令此牌对肥嘟袋鼠无效' },
      ]
      askOption(host, FEIDAN, ownerId, targetId, 'choice', '【肥胆】：选择一项', options,
        { targetId, cardId: resolution.data.cardId }, false)
      return
    }
    if (resolution.step === 'choice') {
      if (optionId === 'give') {
        if (askOneCard(host, FEIDAN, ownerId, targetId, 'give-card', '【肥胆】：交给肥嘟袋鼠一张手牌',
          handOf(host.state, targetId), { targetId })) return
        askOption(host, FEIDAN, ownerId, targetId, 'choice', '【肥胆】：你已无手牌，请令此牌对肥嘟袋鼠无效',
          [{ id: 'cancel', label: '令此牌对肥嘟袋鼠无效' }], { targetId }, false)
        return
      }
      if (optionId === 'cancel') cancelCardTargetForOwner(host, ownerId)
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'give-card') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (cardId && handOf(host.state, targetId).includes(cardId))
        giveCards(host, targetId, ownerId, [cardId], FEIDAN)
      host.resumeCardTarget()
    }
  },
})

registerSkillRuntime({
  id: QIANGDAN,
  triggers: [{ event: 'CardZoneMoved', handle(host, ownerId, context) {
    if (!playerOf(host.state, ownerId)?.alive) return
    const move = context.event.payload as { fromPlayerId?: PlayerId | null; toPlayerId?: PlayerId | null }
    const fromId = move.fromPlayerId
    const toId = move.toPlayerId
    const state = host.state as FeidudaiState
    if (!fromId || !toId || fromId === toId || fromId === ownerId || toId === ownerId
      || state.feidudai?.qiangdanRound?.[ownerId] === host.state.roundNumber
      || state.feidudai?.qiangdanPending?.[ownerId]) return
    if (!handOf(host.state, toId).length && !discardableOf(host.state, toId).length) return
    state.feidudai ??= {}
    state.feidudai.qiangdanPending ??= {}
    state.feidudai.qiangdanPending[ownerId] = true
    host.queueSkill({ skillId: QIANGDAN, ownerId, step: 'invoke', data: { fromId, toId, round: host.state.roundNumber } })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invoke') return
    const toId = prompt.data.toId as PlayerId
    const target = playerOf(host.state, toId)
    if (!target?.alive || !handOf(host.state, toId).length && !discardableOf(host.state, toId).length) {
      delete (host.state as FeidudaiState).feidudai?.qiangdanPending?.[ownerId]
      return
    }
    askOption(host, QIANGDAN, ownerId, ownerId, 'invoke', '【抢单】：是否令其交给你一张手牌或弃置一张牌？',
      [{ id: 'yes', label: '发动【抢单】' }, { id: 'no', label: '不发动' }], prompt.data, true)
  },
  resume(host, ownerId, resolution, response) {
    const data = resolution.data as { fromId: PlayerId; toId: PlayerId; round: number }
    const target = playerOf(host.state, data.toId)
    if (resolution.step === 'invoke') {
      const state = host.state as FeidudaiState
      delete state.feidudai?.qiangdanPending?.[ownerId]
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !target?.alive) return
      state.feidudai ??= {}
      state.feidudai.qiangdanRound ??= {}
      if (state.feidudai.qiangdanRound[ownerId] === host.state.roundNumber) return
      state.feidudai.qiangdanRound[ownerId] = host.state.roundNumber
      const options = [
        ...(handOf(host.state, data.toId).length ? [{ id: 'give', label: '交给肥嘟袋鼠一张手牌' }] : []),
        ...(discardableOf(host.state, data.toId).length ? [{ id: 'discard', label: '弃置一张牌' }] : []),
      ]
      if (options.length) askOption(host, QIANGDAN, ownerId, data.toId, 'choice', '【抢单】：选择一项', options, data, false)
      return
    }
    if (resolution.step === 'choice') {
      if (!target?.alive) return
      const choice = (response.payload as { optionId?: string }).optionId
      const available = choice === 'give' ? handOf(host.state, data.toId)
        : choice === 'discard' ? discardableOf(host.state, data.toId) : []
      if (available.length) askOneCard(host, QIANGDAN, ownerId, data.toId, choice === 'give' ? 'give-card' : 'discard-card',
        choice === 'give' ? '【抢单】：交给肥嘟袋鼠一张手牌' : '【抢单】：弃置一张牌', available, data)
      return
    }
    if (resolution.step === 'give-card' || resolution.step === 'discard-card') {
      if (!target?.alive) return
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId) return
      if (resolution.step === 'give-card' && handOf(host.state, data.toId).includes(cardId))
        giveCards(host, data.toId, ownerId, [cardId], QIANGDAN)
      else if (resolution.step === 'discard-card' && discardableOf(host.state, data.toId).includes(cardId))
        discardCardsByIds(host as never, data.toId, [cardId], QIANGDAN)
    }
  },
})

registerSkillRuntime({
  id: FENGYU,
  ignoresDistanceTo(state, ownerId) { return Boolean(playerOf(state, ownerId)?.alive) },
  ignoresTrickDistance: true,
  triggers: [
    { event: 'CardUsed', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; targetIds?: PlayerId[] }
      if (!payload.cardId || !(payload.targetIds ?? []).some((targetId) => targetId !== ownerId
        && playerOf(host.state, targetId)?.alive && getDistance(host.state, ownerId, targetId) > 1)) return
      const state = host.state as FeidudaiState
      state.feidudai ??= {}
      state.feidudai.distantUses ??= {}
      const uses = state.feidudai.distantUses[ownerId] ??= []
      if (!uses.includes(payload.cardId)) uses.push(payload.cardId)
    } },
    { event: 'AfterCardUse', handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const cardId = (context.event.payload as { cardId?: CardId }).cardId
      const state = host.state as FeidudaiState
      const uses = state.feidudai?.distantUses?.[ownerId]
      if (!cardId || !uses?.includes(cardId)) return
      state.feidudai!.distantUses![ownerId] = uses.filter((usedId) => usedId !== cardId)
      host.queueSkill({ skillId: FENGYU, ownerId, step: 'pay-cost', data: { cardId } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pay-cost') return
    const cards = discardableOf(host.state, ownerId)
    if (!cards.length) {
      loseHp(host as never, ownerId, 1, FENGYU)
      return
    }
    askOption(host, FENGYU, ownerId, ownerId, 'pay-cost', '【风雨无阻】：弃置一张牌或失去1点体力',
      [{ id: 'discard', label: '弃置一张牌' }, { id: 'lose-hp', label: '失去1点体力' }], prompt.data, false)
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pay-cost') {
      if ((response.payload as { optionId?: string }).optionId === 'lose-hp') {
        loseHp(host as never, ownerId, 1, FENGYU)
        return
      }
      if ((response.payload as { optionId?: string }).optionId !== 'discard') return
      const cards = discardableOf(host.state, ownerId)
      if (!askOneCard(host, FENGYU, ownerId, ownerId, 'pay-discard', '【风雨无阻】：选择弃置一张牌', cards, {}))
        loseHp(host as never, ownerId, 1, FENGYU)
      return
    }
    if (resolution.step === 'pay-discard') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!cardId || !discardableOf(host.state, ownerId).includes(cardId)
        || !discardCardsByIds(host as never, ownerId, [cardId], FENGYU).length)
        loseHp(host as never, ownerId, 1, FENGYU)
    }
  },
})

export const FEIDUDAI: CharacterDefinition = {
  id: 'feidudai-kangaroo', name: '肥嘟袋鼠', kingdom: 'le', gender: 'male', maxHp: 4, pack: 'entertainment',
  skills: [
    { id: FEIDAN, name: '肥胆', description: '每回合限一次，当一名其他角色于其回合内第二次使用牌指定你为目标时，你可以令其选择一项：交给你一张手牌；或令此牌对你无效。' },
    { id: QIANGDAN, name: '抢单', description: '每轮限一次，当一名其他角色从另一名角色处获得牌后，你可以令其选择一项：交给你一张手牌；或弃置一张牌。' },
    { id: FENGYU, name: '风雨无阻', description: '锁定技，你使用牌无距离限制。当你使用牌指定距离大于1的其他角色为目标时，此牌结算结束后，你须弃置一张牌或失去1点体力。', locked: true },
  ],
}
