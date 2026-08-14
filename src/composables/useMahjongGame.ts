import { computed, ref, shallowRef } from 'vue'
import { gameAudio } from './useGameAudio'
import { AI_SPEED_DELAY_RANGES, decideClaim, decideTurn } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import {
  clearActiveGame,
  deleteActiveReplay,
  loadActiveReplay,
  loadActiveGame,
  saveActiveGame,
  saveActiveReplay,
  saveReplay,
  type ReplayFrame,
  type ReplayRecord,
} from '@/game/persistence'
import type { AIProfile, ClaimAction, GameState, MatchConfig } from '@/game/types'
import { tileLabel } from '@/game/tiles'

function wait(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration))
}

function turnDelay(profile: AIProfile): number {
  const [minimum, maximum] = AI_SPEED_DELAY_RANGES[profile.speed]
  return Math.round(minimum + Math.random() * (maximum - minimum))
}

function actionPacingDelay() {
  return 180 + Math.round(Math.random() * 140)
}

export function useMahjongGame() {
  const engine = shallowRef<GameEngine | null>(null)
  const state = shallowRef<GameState | null>(null)
  const busy = ref(false)
  const notice = ref('')
  const error = ref('')
  const claimDeadline = ref<number | null>(null)
  const humanPassed = ref(false)
  const savedGameAvailable = ref(loadActiveGame() !== null)
  // 牌谱帧已经是完整快照，必须保持为原始对象；深层响应式代理无法被 structuredClone/IndexedDB 克隆。
  const frames = shallowRef<ReplayFrame[]>([])
  const startedAt = ref(Date.now())
  let runToken = 0
  let claimTimerIds: number[] = []
  let pendingClaimPlayers = new Set<number>()
  let replaySaved = false
  let replaySaving = false
  let activeReplayQueue = Promise.resolve()

  const humanPlayer = computed(() => state.value?.players.find((player) => player.isHuman) ?? null)
  const isHumanTurn = computed(() => {
    if (!state.value || !humanPlayer.value) return false
    return state.value.phase === 'playing' && state.value.currentPlayer === humanPlayer.value.id
  })
  const humanClaimOption = computed(() => {
    if (!state.value || !humanPlayer.value || humanPassed.value) return null
    return state.value.claimOptions.find((option) => option.playerId === humanPlayer.value!.id) ?? null
  })

  function cancelClaimTimers() {
    for (const timerId of claimTimerIds) window.clearTimeout(timerId)
    claimTimerIds = []
    claimDeadline.value = null
    pendingClaimPlayers.clear()
  }

  function recordFrame() {
    if (!state.value) return
    const previous = frames.value.at(-1)
    const eventCount = state.value.events.length
    if (previous?.eventCount === eventCount && previous.state.phase === state.value.phase) return
    const frameState = structuredClone(state.value)
    frameState.events = frameState.events.slice(-1)
    frameState.transfers = frameState.transfers.slice(-8)
    frames.value.push({ index: frames.value.length, eventCount, state: frameState })
  }

  function persistActiveReplay() {
    if (!state.value || state.value.phase === 'match-over') return
    const record = {
      id: state.value.matchId,
      startedAt: startedAt.value,
      frames: structuredClone(frames.value),
    }
    activeReplayQueue = activeReplayQueue
      .catch(() => undefined)
      .then(() => saveActiveReplay(record))
      .catch((cause) => { error.value = `进行中牌谱保存失败：${cause instanceof Error ? cause.message : String(cause)}` })
  }

  function queueActiveReplayDelete(id: string) {
    activeReplayQueue = activeReplayQueue
      .catch(() => undefined)
      .then(() => deleteActiveReplay(id))
      .catch(() => undefined)
  }

  function sync() {
    if (!engine.value) return
    state.value = engine.value.snapshot()
    gameAudio.processEvents(state.value)
    saveActiveGame(state.value)
    savedGameAvailable.value = true
    recordFrame()
    if (state.value.phase === 'match-over') void persistReplay()
    else persistActiveReplay()
  }

  async function persistReplay() {
    if (!state.value || replaySaved || replaySaving) return
    replaySaving = true
    const winner = [...state.value.players].sort((a, b) => (b.points ?? b.stats.netPoints) - (a.points ?? a.stats.netPoints))[0]
    const record: ReplayRecord = {
      id: state.value.matchId,
      createdAt: startedAt.value,
      completedAt: Date.now(),
      title: `第${state.value.round}局 · ${winner.name}领先`,
      frames: structuredClone(frames.value),
    }
    try {
      await saveReplay(record)
      replaySaved = true
      clearActiveGame()
      await activeReplayQueue.catch(() => undefined)
      await deleteActiveReplay(record.id)
      savedGameAvailable.value = false
    } catch (cause) {
      error.value = `牌谱保存失败：${cause instanceof Error ? cause.message : String(cause)}`
    } finally {
      replaySaving = false
    }
  }

  function startMatch(config: MatchConfig) {
    runToken += 1
    cancelClaimTimers()
    const previous = loadActiveGame()
    if (previous) queueActiveReplayDelete(previous.matchId)
    clearActiveGame()
    frames.value = []
    replaySaved = false
    startedAt.value = Date.now()
    error.value = ''
    notice.value = ''
    engine.value = new GameEngine(config)
    gameAudio.prepareMatch(engine.value.state.matchId, [], true)
    sync()
    void advance(runToken)
  }

  async function resumeMatch() {
    const saved = loadActiveGame()
    if (!saved) return
    const token = runToken + 1
    runToken = token
    cancelClaimTimers()
    gameAudio.prepareMatch(saved.matchId, saved.events, false)
    let activeReplay: Awaited<ReturnType<typeof loadActiveReplay>> = null
    try { activeReplay = await loadActiveReplay(saved.matchId) } catch { /* 当前局仍可从状态存档恢复 */ }
    if (token !== runToken) return
    engine.value = GameEngine.restore(saved)
    frames.value = activeReplay?.frames ?? []
    startedAt.value = activeReplay?.startedAt ?? Date.now()
    replaySaved = false
    error.value = ''
    sync()
    void advance(runToken)
  }

  function abandonMatch() {
    runToken += 1
    cancelClaimTimers()
    if (state.value) queueActiveReplayDelete(state.value.matchId)
    engine.value = null
    state.value = null
    frames.value = []
    clearActiveGame()
    savedGameAvailable.value = false
    gameAudio.stopMatch()
  }

  async function advance(token: number) {
    if (!engine.value || token !== runToken) return
    const current = engine.value.state
    if (current.phase === 'claiming') {
      beginClaimWindow(token)
      return
    }
    if (current.phase !== 'playing') {
      busy.value = false
      return
    }
    const player = current.players[current.currentPlayer]
    if (player.isHuman) {
      busy.value = false
      const latestEvent = current.events.at(-1)
      notice.value = current.turnStage === 'after-draw' && latestEvent?.type === 'draw' && latestEvent.tile
        ? `你刚摸到 ${tileLabel(latestEvent.tile)}：可自摸、杠或出牌`
        : '轮到你出牌'
      return
    }

    busy.value = true
    notice.value = `${player.name}正在思考…`
    const profile = structuredClone(player.ai!)
    await wait(turnDelay(profile))
    if (!engine.value || token !== runToken || engine.value.state.phase !== 'playing') return
    try {
      const observation = engine.value.createObservation(player.id)
      const decision = decideTurn(observation, profile)
      if (decision.action === 'win') engine.value.declareWin(player.id)
      else if (decision.action === 'an-gang' || decision.action === 'bu-gang') {
        engine.value.declareGang(player.id, decision.action, decision.face)
      } else if ('tileId' in decision) engine.value.discard(player.id, decision.tileId)
      sync()
      await wait(actionPacingDelay())
      await advance(token)
    } catch (cause) {
      busy.value = false
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function beginClaimWindow(token: number) {
    if (!engine.value || token !== runToken || engine.value.state.phase !== 'claiming') return
    cancelClaimTimers()
    humanPassed.value = false
    const current = engine.value.state
    pendingClaimPlayers = new Set(current.claimOptions.map((option) => option.playerId))
    claimDeadline.value = Date.now() + current.config.claimWindowMs
    notice.value = '抢碰/抢杠阶段：先喊先得'
    sync()

    for (const option of current.claimOptions) {
      const player = current.players[option.playerId]
      if (player.isHuman) continue
      const observation = engine.value.createObservation(player.id, option.actions)
      const plan = decideClaim(observation, player.ai!, current.events.length + player.id * 17)
      const timerId = window.setTimeout(() => {
        if (!engine.value || token !== runToken || engine.value.state.phase !== 'claiming') return
        if (plan.action === 'pass') {
          pendingClaimPlayers.delete(player.id)
          if (pendingClaimPlayers.size === 0) resolveNoClaim(token)
          return
        }
        try {
          engine.value.claim(player.id, plan.action)
          cancelClaimTimers()
          sync()
          void advance(token)
        } catch (cause) {
          error.value = cause instanceof Error ? cause.message : String(cause)
        }
      }, plan.delayMs)
      claimTimerIds.push(timerId)
    }

    const timeoutId = window.setTimeout(() => resolveNoClaim(token), current.config.claimWindowMs)
    claimTimerIds.push(timeoutId)
  }

  function resolveNoClaim(token: number) {
    if (!engine.value || token !== runToken || engine.value.state.phase !== 'claiming') return
    try {
      cancelClaimTimers()
      engine.value.resolveNoClaim()
      sync()
      void advance(token)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function humanDiscard(tileId: string) {
    if (!engine.value || !humanPlayer.value) return
    try {
      engine.value.discard(humanPlayer.value.id, tileId)
      sync()
      void advance(runToken)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function humanWin() {
    if (!engine.value || !humanPlayer.value) return
    try {
      engine.value.declareWin(humanPlayer.value.id)
      sync()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function humanGang(type: 'an-gang' | 'bu-gang', face: string) {
    if (!engine.value || !humanPlayer.value) return
    try {
      engine.value.declareGang(humanPlayer.value.id, type, face)
      sync()
      void advance(runToken)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function humanClaim(action: ClaimAction) {
    if (!engine.value || !humanPlayer.value || engine.value.state.phase !== 'claiming') return
    try {
      engine.value.claim(humanPlayer.value.id, action)
      cancelClaimTimers()
      sync()
      void advance(runToken)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function humanPassClaim() {
    if (!humanPlayer.value || !engine.value || engine.value.state.phase !== 'claiming') return
    humanPassed.value = true
    pendingClaimPlayers.delete(humanPlayer.value.id)
    notice.value = '你已选择过，等待其他玩家'
    if (pendingClaimPlayers.size === 0) resolveNoClaim(runToken)
  }

  function nextRound() {
    if (!engine.value) return
    try {
      engine.value.continueAfterSettlement()
      sync()
      void advance(runToken)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function endMatch() {
    if (!engine.value) return
    runToken += 1
    cancelClaimTimers()
    engine.value.endMatchManually()
    sync()
  }

  function updateAI(playerId: number, profile: AIProfile) {
    if (!engine.value) return
    try {
      engine.value.updateAI(playerId, profile)
      sync()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  return {
    state,
    busy,
    notice,
    error,
    claimDeadline,
    humanPassed,
    savedGameAvailable,
    humanPlayer,
    isHumanTurn,
    humanClaimOption,
    startMatch,
    resumeMatch,
    abandonMatch,
    humanDiscard,
    humanWin,
    humanGang,
    humanClaim,
    humanPassClaim,
    nextRound,
    endMatch,
    updateAI,
  }
}
