import { computed, ref, shallowRef } from 'vue'
import { gameAudio } from './useGameAudio'
import { decideClaim, decideTurn, estimateThinkMs } from '@/game/ai'
import { GameEngine } from '@/game/engine'
import { claimMaskDelay } from '@/game/timing'
import type { AIProfile, ClaimAction, GameState, MatchConfig } from '@/game/types'

function wait(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration))
}



function actionPacingDelay() {
  return 130 + Math.round(Math.random() * 110)
}

export function useMahjongGame() {
  const engine = shallowRef<GameEngine | null>(null)
  const state = shallowRef<GameState | null>(null)
  const busy = ref(false)
  const notice = ref('')
  const error = ref('')
  const claimDeadline = ref<number | null>(null)
  const humanPassed = ref(false)
  let runToken = 0
  let claimTimerIds: number[] = []
  let pendingClaimPlayers = new Set<number>()
  let claimEarliestResolveAt = 0
  let noClaimTimerId: number | null = null

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

  function sync() {
    if (!engine.value) return
    state.value = engine.value.snapshot()
    gameAudio.processEvents(state.value)
  }

  function startMatch(config: MatchConfig) {
    runToken += 1
    cancelClaimTimers()
    error.value = ''
    notice.value = ''
    engine.value = new GameEngine(config)
    gameAudio.prepareMatch(engine.value.state.matchId, [], true)
    sync()
    void advance(runToken)
  }

  function abandonMatch() {
    runToken += 1
    cancelClaimTimers()
    engine.value = null
    state.value = null
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
        ? '你摸到牌了，可以胡、杠或出牌'
        : '轮到你出牌'
      return
    }

    busy.value = true
    notice.value = ''
    const profile = structuredClone(player.ai!)
    // 想多久取决于这手牌好不好打：孤张一眼就扔，听牌和能杠的地方才慢下来
    await wait(estimateThinkMs(engine.value.createObservation(player.id), profile, current.events.length))
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
    notice.value = ''
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
    notice.value = ''
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
    humanPlayer,
    isHumanTurn,
    humanClaimOption,
    startMatch,
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
