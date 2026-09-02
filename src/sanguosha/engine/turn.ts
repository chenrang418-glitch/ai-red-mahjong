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

/**
 * 开始下一名存活角色的回合。
 *
 * 背面朝上的角色轮到自己时：先把武将牌翻回正面，然后**跳过整个回合**。
 * 这里的做法是把六个阶段全部标记为跳过并停在 `finish`，
 * 下一次 `advancePhase` 就会直接收束这一回合、交给再下一名角色。
 *
 * 之所以仍然发 `TurnStart`、仍然让 `turnNumber` 加一：按规则这个回合确实
 * 发生了，只是每个阶段都被跳过。**不发 `PhaseStart`**，所以挂在阶段上的
 * 技能（曹仁自己的据守也在内）不会在被跳过的回合里触发。
 */
function beginTurn(state: SanguoshaState, emit: EmitTurnEvent): void {
  state.currentPlayerId = nextAlivePlayerId(state)
  state.turnNumber += 1
  state.skippedPhases = []
  state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  emit('TurnStart', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })

  const current = state.players.find((player) => player.id === state.currentPlayerId)
  if (current?.faceDown) {
    current.faceDown = false
    emit('CharacterFlip', { playerId: current.id, faceDown: false, reason: '回合开始' })
    state.skippedPhases = [...TURN_PHASES]
    state.phase = 'finish'
    return
  }

  state.phase = 'prepare'
  emit('PhaseStart', { playerId: state.currentPlayerId, phase: state.phase })
}

export function advancePhase(state: SanguoshaState, emit: EmitTurnEvent): void {
  if (state.status !== 'playing') throw new Error('牌局尚未进入进行状态')
  if (state.pendingRequests.length > 0) throw new Error('仍有待处理 Request，不能推进阶段')
  emit('PhaseEnd', { playerId: state.currentPlayerId, phase: state.phase })

  // 回合角色在自己回合里死掉（自己的闪电劈到自己、决斗输了、被反伤……）时，
  // 剩下的阶段不能继续跑——那会让摸牌、出牌、弃牌发生在一个死人身上。
  // 直接收束这一回合，交给下一名存活角色。
  const current = state.players.find((player) => player.id === state.currentPlayerId)
  const currentIndex = TURN_PHASES.indexOf(state.phase)
  if (current?.alive && currentIndex < TURN_PHASES.length - 1) {
    let nextIndex = currentIndex + 1
    while (nextIndex < TURN_PHASES.length && state.skippedPhases.includes(TURN_PHASES[nextIndex])) nextIndex += 1
    if (nextIndex < TURN_PHASES.length) {
      state.phase = TURN_PHASES[nextIndex]
      emit('PhaseStart', { playerId: state.currentPlayerId, phase: state.phase })
      return
    }
  }

  emit('TurnEnd', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })
  // 「每回合限一次」统一在这里清，技能不需要各自注册 TurnEnd 重置——
  // 那样散着写漏过一个（青囊），「限一次」直接变成了「一局一次」。
  // 清全场而不只是当前回合角色：回合外也能发动的技能同样按回合计数。
  for (const player of state.players) player.turnUsedSkills = []
  beginTurn(state, emit)
}
