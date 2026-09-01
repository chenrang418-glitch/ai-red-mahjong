import { drawCards } from './draw'
import type { EventContext, GameEvent, GameEventName } from './events'
import type { ChooseCardsRequest, GameResponse } from './requests'
import { validateResponse } from './requests'
import type { GameRng } from './rng'
import { advancePhase } from './turn'
import type { PlayerId, SanguoshaState } from './types'
import { moveCard } from './zones'
import { beginJudgmentPhase } from './judgment'

export interface PhaseEngineHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

function maxCards(state: SanguoshaState, playerId: PlayerId): number {
  const target = state.players.find((player) => player.id === playerId)
  if (!target) throw new Error(`玩家不存在：${playerId}`)
  return Math.max(0, target.hp)
}

function enterCurrentPhase(host: PhaseEngineHost): void {
  const playerId = host.state.currentPlayerId
  const current = host.state.players.find((player) => player.id === playerId)
  if (!current?.alive) throw new Error('当前回合角色不存在或已经死亡')
  switch (host.state.phase) {
    case 'prepare': return
    case 'judge':
      host.dispatch('JudgePhase', { playerId }, { sourceId: playerId, phase: 'judge' })
      beginJudgmentPhase(host)
      return
    case 'draw': {
      // 技能可以取消这次事件来接管摸牌（裸衣少摸一张、突袭改为拿别人的牌）。
      // 取消之后由技能自己负责把牌补上，引擎不再默认摸两张。
      const context = host.dispatch('DrawPhase', { playerId, count: 2 }, { sourceId: playerId, phase: 'draw' })
      if (context.cancelled) return
      drawCards(host.state, host.rng, playerId, 2, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    case 'play':
      host.dispatch('PlayPhase', { playerId }, { sourceId: playerId, phase: 'play' })
      return
    case 'discard': {
      host.dispatch('DiscardPhase', { playerId }, { sourceId: playerId, phase: 'discard' })
      const count = current.zones.hand.length - maxCards(host.state, playerId)
      if (count <= 0) return
      const request: ChooseCardsRequest = {
        id: `request-${host.state.seq}`,
        kind: 'choose-cards',
        playerId,
        prompt: `弃置 ${count} 张手牌`,
        timeoutMs: 30_000,
        optional: false,
        purpose: 'discard-phase',
        cardIds: [...current.zones.hand],
        hiddenCardSlots: [],
        min: count,
        max: count,
      }
      host.state.pendingRequests.push(request)
      return
    }
    case 'finish': return
  }
}

export function advanceGamePhase(host: PhaseEngineHost): void {
  advancePhase(host.state, (name, payload) => { host.dispatch(name, payload) })
  enterCurrentPhase(host)
}

export function resolveDiscardPhaseResponse(host: PhaseEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  if (host.state.phase !== 'discard' || host.state.currentPlayerId !== request.playerId) throw new Error('弃牌阶段 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const selected = (response.payload as { cardIds: string[] }).cardIds
  const owner = host.state.players.find((player) => player.id === request.playerId)!
  if (selected.some((cardId) => !owner.zones.hand.includes(cardId))) throw new Error('弃置牌不属于当前玩家')
  host.state.pendingRequests = host.state.pendingRequests.filter((candidate) => candidate.id !== request.id)
  for (const cardId of selected) moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId: owner.id, cardIds: selected, reason: 'discard-phase' }, { sourceId: owner.id, cardIds: selected, phase: 'discard' })
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}
