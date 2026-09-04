import type { GameEventName } from './events'
import type { SanguoshaState, TurnPhase } from './types'
import { expireArmorSuppressions } from './armor-suppression'
import { clearTurnSlashRules } from './slash-rules'
import { expireTargetStates } from './target-state'

export const TURN_PHASES: readonly TurnPhase[] = ['prepare', 'judge', 'draw', 'play', 'discard', 'finish']

export type EmitTurnEvent = (name: GameEventName, payload: Record<string, unknown>) => void

/**
 * 从某个座位往后找下一名存活角色。
 *
 * 起点按 **id** 查而不是按当前回合角色查：正常座次游标可能停在一个已经死掉的
 * 人身上（他在自己回合里死了），那时仍然要从他的座位继续往后数。
 */
function nextAliveAfter(state: SanguoshaState, fromPlayerId: string): string {
  const from = state.players.find((player) => player.id === fromPlayerId)
  if (!from) throw new Error('座次游标指向的玩家不存在')
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(from.seat + offset) % state.players.length]
    if (candidate.alive) return candidate.id
  }
  throw new Error('没有存活玩家可以开始下一回合')
}

/**
 * 给某名角色排一个额外回合（刘禅【放权】）。
 *
 * **队列而不是单个字段**：以后可能有多个技能同时排队，甚至额外回合里再排
 * 一个额外回合。用一个 `extraTurnPlayerId` 只存得下一个，第二个会被静默吃掉。
 */
export function queueExtraTurn(
  state: SanguoshaState,
  playerId: string,
  source: { skillId?: string; playerId?: string } = {},
): void {
  state.extraTurns ??= []
  state.extraTurns.push({
    playerId,
    ...(source.skillId ? { sourceSkillId: source.skillId } : {}),
    ...(source.playerId ? { sourcePlayerId: source.playerId } : {}),
  })
}

/**
 * 决定下一个回合归谁，以及它是正常回合还是额外回合。
 *
 * **额外回合不推进正常座次游标**——这是整套调度里最要紧的一条不变量。
 * 推进了的话，被插队的那名角色的正常回合会被直接吃掉（或者反过来多跑一次）。
 * 所以 `normalTurnPlayerId` 和 `currentPlayerId` 是两个字段，
 * 只有正常回合才会去动前者。
 *
 * 排队时还活着、轮到时已经死了的额外回合直接丢弃，继续往下取。
 */
function nextTurnEntry(state: SanguoshaState): { playerId: string; kind: 'normal' | 'extra'; sourceSkillId?: string; sourcePlayerId?: string } {
  state.extraTurns ??= []
  while (state.extraTurns.length > 0) {
    const queued = state.extraTurns.shift()!
    const player = state.players.find((candidate) => candidate.id === queued.playerId)
    if (!player?.alive) continue
    // 插队之前先把正常座次钉住：它是「上一个正常回合是谁」，
    // 额外回合结束后要从这里继续往下数
    if (state.currentTurnKind !== 'extra') state.normalTurnPlayerId = state.currentPlayerId
    return { ...queued, kind: 'extra' }
  }
  /*
   * 正常回合的起点：
   * - 上一个回合是**正常回合**时，就用 `currentPlayerId`。
   *   这样和重构前的行为完全一致，也让直接改 `currentPlayerId` 的调用方
   *   （不少测试脚手架就是这么摆局面的）照常工作。
   * - 上一个回合是**额外回合**时，`currentPlayerId` 指向插队的人，
   *   必须回到钉住的正常座次继续数，否则被插队者的回合会被吃掉。
   */
  const from = state.currentTurnKind === 'extra'
    ? (state.normalTurnPlayerId ?? state.currentPlayerId)
    : state.currentPlayerId
  const nextId = nextAliveAfter(state, from)
  state.normalTurnPlayerId = nextId
  return { playerId: nextId, kind: 'normal' }
}

export function startPlaying(state: SanguoshaState, emit: EmitTurnEvent): void {
  if (state.status !== 'choosing-general' && state.status !== 'setup') throw new Error('牌局已经开始')
  state.status = 'playing'
  state.turnNumber = 1
  state.phase = 'prepare'
  state.skippedPhases = []
  state.judgedDelayedCards = []
  state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  state.extraTurns = []
  // 正常座次游标从主公开始；只有额外回合插队时才需要靠它记住位置
  state.normalTurnPlayerId = state.currentPlayerId
  state.currentTurnKind = 'normal'
  emit('TurnStart', { playerId: state.currentPlayerId, turnNumber: state.turnNumber, kind: 'normal' })
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
function beginTurn(state: SanguoshaState, emit: EmitTurnEvent): boolean {
  const next = nextTurnEntry(state)
  state.currentPlayerId = next.playerId
  state.currentTurnKind = next.kind
  state.turnNumber += 1
  state.skippedPhases = []
  state.judgedDelayedCards = []
  state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  emit('TurnStart', {
    playerId: state.currentPlayerId,
    turnNumber: state.turnNumber,
    // 额外回合在战报和界面上要能和正常回合分辨开，否则玩家会以为座次乱跳
    kind: next.kind,
    ...(next.sourceSkillId ? { sourceSkillId: next.sourceSkillId } : {}),
    ...(next.sourcePlayerId ? { sourcePlayerId: next.sourcePlayerId } : {}),
  })

  const current = state.players.find((player) => player.id === state.currentPlayerId)
  if (current?.faceDown) {
    current.faceDown = false
    emit('CharacterFlip', { playerId: current.id, faceDown: false, reason: '回合开始' })
    state.skippedPhases = [...TURN_PHASES]
    state.phase = 'finish'
    return false
  }

  state.phase = 'prepare'
  /*
   * 临时状态（狂风、大雾）在**施加者的下一个回合开始前**失效。
   * 统一在这里清，技能不各自注册清理——散着写迟早漏一个，
   * 然后某个玩家身上挂着一个永远不消失的大雾。
   */
  expireTargetStates(state, state.currentPlayerId)
  return true
}

/**
 * 推进到下一个阶段。
 *
 * **这里不再发 `PhaseStart`。** 阶段真正开始之前还有一个公共窗口：
 * 「付代价跳过这个阶段」（张郃【巧变】、刘禅【放权】）。那个窗口会挂起
 * 等玩家回答，挂起期间这个阶段还没有开始，此时发 `PhaseStart` 会让挂在
 * 阶段上的技能（英魂、崩坏……）在一个最终被跳过的阶段里错误触发。
 * 所以 `PhaseStart` 改由 `phase.ts` 的 `beginPhaseEntry` 在窗口走完后发。
 *
 * 返回是否进入了一个待开始的新阶段；翻面跳过整个回合时返回 false。
 */
export function advancePhase(state: SanguoshaState, emit: EmitTurnEvent): boolean {
  if (state.status !== 'playing') throw new Error('牌局尚未进入进行状态')
  if (state.pendingRequests.length > 0) throw new Error('仍有待处理 Request，不能推进阶段')
  const endingPhase = state.phase
  emit('PhaseEnd', { playerId: state.currentPlayerId, phase: state.phase })
  if (endingPhase === 'discard') state.discardPhaseLedger = null

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
      return true
    }
  }

  emit('TurnEnd', { playerId: state.currentPlayerId, turnNumber: state.turnNumber })
  // 「每回合限一次」统一在这里清，技能不需要各自注册 TurnEnd 重置——
  // 那样散着写漏过一个（青囊），「限一次」直接变成了「一局一次」。
  // 清全场而不只是当前回合角色：回合外也能发动的技能同样按回合计数。
  for (const player of state.players) player.turnUsedSkills = []
  // 本回合的临时杀规则（太史慈【天义】）同样在这里统一抹掉，技能不各自注册清理
  clearTurnSlashRules(state)
  // 来源绑定的防具失效（神吕布【无前】）也是「直到本回合结束」，同样统一清
  expireArmorSuppressions(state)
  // TurnEnd 触发的技能必须先完整结算，不能先发下一名角色的 TurnStart。
  // 断点进入 State，回应结束或重连恢复后由 Game.settle 续接。
  if (
    state.skillQueue.length > 0
    || state.pendingRequests.length > 0
    || state.skillResolution !== null
    || state.dying !== null
    || state.damageChain !== null
    || state.cardResolution !== null
    || state.judgment !== null
  ) {
    state.turnTransitionPending = true
    return false
  }
  return beginTurn(state, emit)
}

/** TurnEnd 技能全部结清后，从可序列化断点开始下一回合。 */
export function resumeTurnTransition(state: SanguoshaState, emit: EmitTurnEvent): boolean {
  if (!state.turnTransitionPending) return false
  state.turnTransitionPending = false
  return beginTurn(state, emit)
}
