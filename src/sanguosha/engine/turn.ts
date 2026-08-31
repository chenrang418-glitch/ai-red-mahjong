import type { GameEventName } from './events'
import type { SanguoshaState, TurnPhase } from './types'

export const TURN_PHASES: readonly TurnPhase[] = ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']

export type EmitTurnEvent = (name: GameEventName, payload: Record<string, unknown>) => void

function nextAlivePlayerId(state: SanguoshaState): string {
  const current = state.players.find((player) => player.id === state.currentPlayerId)
  if (!current) throw new Error('当前玩家不存在')
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(current.seat + offset) % state.players.length]
    if (candidate.alive) return candidate.id
  }
  throw new Error('没有存活玩家可以开始下一回合')
}

export function startPlaying(state: SanguoshaState, emit: EmitTurnEvent): void {
  if (state.status !== 'choosing-general' && state.status !== 'setup') throw new Error('牌局已经开始')
  state.status = 'playing'
  state.turnNumber = 1
  state.phase = 'prepare'
  state.skippedPhases = []
  state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  emit('TurnStart', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })
  emit('PhaseStart', { playerId: state.currentPlayerId, phase: state.phase })
}

export function skipPhase(state: SanguoshaState, phase: TurnPhase): void {
  if (!state.skippedPhases.includes(phase)) state.skippedPhases.push(phase)
}

export function advancePhase(state: SanguoshaState, emit: EmitTurnEvent): void {
  if (state.status !== 'playing') throw new Error('牌局尚未进入进行状态')
  if (state.pendingRequests.length > 0) throw new Error('仍有待处理 Request，不能推进阶段')
  emit('PhaseEnd', { playerId: state.currentPlayerId, phase: state.phase })
  const currentIndex = TURN_PHASES.indexOf(state.phase)
  if (currentIndex < TURN_PHASES.length - 1) {
    let nextIndex = currentIndex + 1
    while (nextIndex < TURN_PHASES.length && state.skippedPhases.includes(TURN_PHASES[nextIndex])) nextIndex += 1
    if (nextIndex < TURN_PHASES.length) {
      state.phase = TURN_PHASES[nextIndex]
      emit('PhaseStart', { playerId: state.currentPlayerId, phase: state.phase })
      return
    }
  }

  emit('TurnEnd', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })
  state.currentPlayerId = nextAlivePlayerId(state)
  state.turnNumber += 1
  state.phase = 'prepare'
  state.skippedPhases = []
  state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  emit('TurnStart', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })
  emit('PhaseStart', { playerId: state.currentPlayerId, phase: state.phase })
}
