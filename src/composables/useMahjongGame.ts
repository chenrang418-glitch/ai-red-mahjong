import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { gameAudio } from './useGameAudio'
import { AI_SPEED_DELAY_RANGES, decideClaim, decideTurn } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import { claimMaskDelay } from '@/game/timing'
import {
  activeReplayChunkId,
  clearActiveGame,
  deleteActiveReplay,
  loadActiveReplay,
  loadActiveGame,
  saveActiveGame,
  saveActiveReplayChunk,
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

const SAVE_THROTTLE_MS = 600
const MAX_REPLAY_FRAMES = 3000

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
  let claimEarliestResolveAt = 0
  let noClaimTimerId: number | null = null
  let replaySaved = false
  let replaySaving = false
  let activeReplayQueue = Promise.resolve()
  let saveTimer: number | null = null

  // 离开页面前把攒着的存档写下去，否则刷新会丢掉最后几步。
  const flushBeforeUnload = () => flushSave()
  window.addEventListener('pagehide', flushBeforeUnload)
  document.addEventListener('visibilitychange', flushBeforeUnload)
  onBeforeUnmount(() => {
    window.removeEventListener('pagehide', flushBeforeUnload)
    document.removeEventListener('visibilitychange', flushBeforeUnload)
    cancelScheduledSave()
  })

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
    claimEarliestResolveAt = 0
    noClaimTimerId = null
  }

  function recordFrame() {
    if (!state.value) return
    const previous = frames.value.at(-1)
    const eventCount = state.value.events.length
    if (previous?.eventCount === eventCount && previous.state.phase === state.value.phase) return
    const frameState = structuredClone(state.value)
    const wallCount = frameState.wall.length
    const maReserveCount = frameState.maReserve.length
    frameState.events = frameState.events.slice(-1)
    frameState.transfers = frameState.transfers.slice(-8)
    // 回放只需要牌墙和码区还剩几张，牌面本身丢掉，单帧体积能省三成以上。
    frameState.wall = []
    frameState.maReserve = []
    frames.value.push({ index: frames.value.length, eventCount, state: frameState, wallCount, maReserveCount })
    if (frames.value.length > MAX_REPLAY_FRAMES) frames.value.splice(0, frames.value.length - MAX_REPLAY_FRAMES)
  }

  // 只写当前这一局的分片。以前每走一步都要把整场牌谱重写一遍，
  // 打到二十局时单次写入已经是七兆多，手机上会明显卡顿。
  function persistActiveReplay() {
    if (!state.value || state.value.phase === 'match-over') return
    const round = state.value.round
    const roundFrames = frames.value.filter((frame) => frame.state.round === round)
    if (!roundFrames.length) return
    const chunk = {
      id: activeReplayChunkId(state.value.matchId, round),
      matchId: state.value.matchId,
      round,
      startedAt: startedAt.value,
      frames: structuredClone(roundFrames),
    }
    activeReplayQueue = activeReplayQueue
      .catch(() => undefined)
      .then(() => saveActiveReplayChunk(chunk))
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
    recordFrame()
    if (state.value.phase === 'match-over') {
      cancelScheduledSave()
      void persistReplay()
      return
    }
    // 出牌节奏里每一步都写存档没有必要，合并成定时落盘；关键节点再强制写一次。
    if (state.value.phase === 'settlement') flushSave()
    else scheduleSave()
  }

  function scheduleSave() {
    if (saveTimer !== null) return
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      flushSave()
    }, SAVE_THROTTLE_MS)
  }

  function cancelScheduledSave() {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = null
  }

  function flushSave() {
    cancelScheduledSave()
    if (!state.value || state.value.phase === 'match-over') return
    if (saveActiveGame(state.value)) savedGameAvailable.value = true
    else error.value = '本地存档空间不足，当前牌局可能无法续玩'
    persistActiveReplay()
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
    cancelScheduledSave()
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
    cancelScheduledSave()
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
    const latestEvent = current.events.at(-1)
    const discardedAt = latestEvent?.type === 'discard' ? latestEvent.at : Date.now()
    claimEarliestResolveAt = discardedAt + claimMaskDelay()
    pendingClaimPlayers = new Set(current.claimOptions.map((option) => option.playerId))
    claimDeadline.value = current.claimOptions.length > 0 ? Date.now() + current.config.claimWindowMs : null
    notice.value = '等待其他玩家响应…'
    sync()

    if (current.claimOptions.length === 0) {
      requestNoClaimResolution(token)
      return
    }

    for (const option of current.claimOptions) {
      const player = current.players[option.playerId]
      if (player.isHuman) continue
      const observation = engine.value.createObservation(player.id, option.actions)
      const plan = decideClaim(observation, player.ai!, current.events.length + player.id * 17, current.config.claimWindowMs)
      const timerId = window.setTimeout(() => {
        if (!engine.value || token !== runToken || engine.value.state.phase !== 'claiming') return
        if (plan.action === 'pass') {
          pendingClaimPlayers.delete(player.id)
          if (pendingClaimPlayers.size === 0) requestNoClaimResolution(token)
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

    const timeoutId = window.setTimeout(() => requestNoClaimResolution(token), current.config.claimWindowMs)
    claimTimerIds.push(timeoutId)
  }

  function requestNoClaimResolution(token: number) {
    if (!engine.value || token !== runToken || engine.value.state.phase !== 'claiming' || noClaimTimerId !== null) return
    const remaining = Math.max(0, claimEarliestResolveAt - Date.now())
    if (remaining > 0) {
      noClaimTimerId = window.setTimeout(() => {
        noClaimTimerId = null
        finalizeNoClaim(token)
      }, remaining)
      claimTimerIds.push(noClaimTimerId)
      return
    }
    finalizeNoClaim(token)
  }

  function finalizeNoClaim(token: number) {
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
    if (pendingClaimPlayers.size === 0) requestNoClaimResolution(runToken)
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
