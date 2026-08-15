import { decideClaim, decideTurn, AI_SPEED_DELAY_RANGES } from '../src/game/ai'
import { GameEngine } from '../src/game/engine'
import { claimMaskDelay } from '../src/game/timing'
import type { AIProfile, ClaimAction, GameState, Tile } from '../src/game/types'
import type {
  ChatMessage,
  OnlineLegalActions,
  OnlineRoomSettings,
  OnlineRoomView,
  OnlineSeatView,
  RoomCommand,
} from '../src/online/types'

export interface RoomUser {
  userId: string
  nickname: string
}

interface StoredSeat {
  seatId: number
  kind: 'empty' | 'human' | 'ai'
  userId: string | null
  name: string
  connected: boolean
  ready: boolean
  trustee: boolean
  ai: AIProfile | null
}

type ScheduledJobKind =
  | 'ai-turn'
  | 'turn-timeout'
  | 'ai-claim'
  | 'claim-deadline'
  | 'resolve-no-claim'
  | 'disconnect-trustee'
  | 'lobby-disconnect-remove'

interface ScheduledJob {
  id: string
  kind: ScheduledJobKind
  dueAt: number
  stageKey: string
  seatId?: number
  claimAction?: ClaimAction | 'pass'
}

export interface StoredRoomState {
  schemaVersion: 1
  code: string
  createdAt: number
  updatedAt: number
  hostUserId: string
  settings: OnlineRoomSettings
  seats: StoredSeat[]
  game: GameState | null
  version: number
  chat: ChatMessage[]
  jobs: ScheduledJob[]
  stageKey: string
  stageStartedAt: number
  claimResponses: Record<string, ClaimAction | 'pass'>
  recentActionIds: string[]
  recordedRounds: string[]
}

export interface RoundLeaderboardResult {
  matchId: string
  round: number
  userId: string
  won: number
  sevenPairs: number
  gangCount: number
  maCount: number
}

const TRUSTEE_AI: AIProfile = { personality: 'humanlike', difficulty: 'standard', speed: 'normal' }
const TABLE_AI: AIProfile = { personality: 'balanced', difficulty: 'standard', speed: 'normal' }
const DISCONNECT_GRACE_MS = 30_000
const LOBBY_DISCONNECT_GRACE_MS = 60_000

function emptySeat(seatId: number): StoredSeat {
  return {
    seatId,
    kind: 'empty',
    userId: null,
    name: `座位 ${seatId + 1}`,
    connected: false,
    ready: false,
    trustee: false,
    ai: null,
  }
}

function humanSeat(seatId: number, user: RoomUser, ready = false): StoredSeat {
  return {
    seatId,
    kind: 'human',
    userId: user.userId,
    name: user.nickname,
    connected: true,
    ready,
    trustee: false,
    ai: null,
  }
}

function deterministicDelay(range: readonly [number, number], salt: number): number {
  const ratio = Math.abs(Math.sin(salt * 12.9898))
  return Math.round(range[0] + (range[1] - range[0]) * ratio)
}

function stageKey(game: GameState): string {
  return `${game.matchId}:${game.round}:${game.phase}:${game.turnStage}:${game.currentPlayer}:${game.events.length}`
}

function hiddenTiles(count: number, prefix: string): Tile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hidden-${prefix}-${index}`,
    suit: 'zhong' as const,
    rank: null,
  }))
}

export class RoomCoordinator {
  state: StoredRoomState

  constructor(state: StoredRoomState) {
    this.state = structuredClone(state)
  }

  static create(code: string, host: RoomUser, settings: OnlineRoomSettings, now = Date.now()): RoomCoordinator {
    return new RoomCoordinator({
      schemaVersion: 1,
      code,
      createdAt: now,
      updatedAt: now,
      hostUserId: host.userId,
      settings: structuredClone(settings),
      seats: [humanSeat(0, host, true), emptySeat(1), emptySeat(2), emptySeat(3)],
      game: null,
      version: 1,
      chat: [],
      jobs: [],
      stageKey: '',
      stageStartedAt: now,
      claimResponses: {},
      recentActionIds: [],
      recordedRounds: [],
    })
  }

  snapshot(): StoredRoomState {
    return structuredClone(this.state)
  }

  connect(user: RoomUser, now = Date.now()): number {
    let seat = this.state.seats.find((candidate) => candidate.userId === user.userId)
    if (!seat) {
      if (this.state.game) throw new Error('牌局已经开始，不能中途加入')
      seat = this.state.seats.find((candidate) => candidate.kind === 'empty')
      if (!seat) throw new Error('房间已经满员')
      this.state.seats[seat.seatId] = humanSeat(seat.seatId, user)
      seat = this.state.seats[seat.seatId]
    }
    seat.name = user.nickname
    seat.connected = true
    this.state.jobs = this.state.jobs.filter((job) => !(
      ['disconnect-trustee', 'lobby-disconnect-remove'].includes(job.kind)
      && job.seatId === seat!.seatId
    ))
    this.touch(now)
    return seat.seatId
  }

  disconnect(userId: string, now = Date.now()): void {
    const seat = this.humanSeatByUser(userId)
    seat.connected = false
    this.state.jobs = this.state.jobs.filter((job) => !(
      ['disconnect-trustee', 'lobby-disconnect-remove'].includes(job.kind)
      && job.seatId === seat.seatId
    ))
    const lobby = !this.state.game
    this.state.jobs.push({
      id: `disconnect-${seat.seatId}-${now}`,
      kind: lobby ? 'lobby-disconnect-remove' : 'disconnect-trustee',
      dueAt: now + (lobby ? LOBBY_DISCONNECT_GRACE_MS : DISCONNECT_GRACE_MS),
      stageKey: 'presence',
      seatId: seat.seatId,
    })
    this.touch(now)
  }

  removeLobbyUser(userId: string, now = Date.now()): void {
    if (this.state.game) throw new Error('牌局已经开始')
    const seat = this.humanSeatByUser(userId)
    this.state.seats[seat.seatId] = emptySeat(seat.seatId)
    this.state.jobs = this.state.jobs.filter((job) => job.seatId !== seat.seatId)
    if (this.state.hostUserId === userId) {
      const nextHost = this.state.seats.find((candidate) => candidate.kind === 'human' && candidate.userId)
      if (nextHost?.userId) {
        this.state.hostUserId = nextHost.userId
        nextHost.ready = true
      }
    }
    this.touch(now)
  }

  handle(userId: string, command: RoomCommand, now = Date.now()): ChatMessage | null {
    const seat = this.humanSeatByUser(userId)
    if (command.type === 'chat') return this.addChat(seat, command.text, command.quick, now)
    if (command.type === 'leave-room') {
      if (this.state.game) this.disconnect(userId, now)
      else this.removeLobbyUser(userId, now)
      return null
    }
    if (command.type === 'ready') {
      if (this.state.game) throw new Error('牌局已经开始')
      seat.ready = command.ready
      this.touch(now)
      return null
    }
    if (command.type === 'start-game') {
      this.assertHost(userId)
      this.startGame(now)
      return null
    }
    if (command.type === 'trustee') {
      if (!this.state.game) throw new Error('牌局尚未开始')
      seat.trustee = command.enabled
      this.reschedule(now)
      this.touch(now)
      return null
    }
    if (command.type === 'next-round') {
      this.assertHost(userId)
      const engine = this.engine()
      engine.continueAfterSettlement()
      this.state.game = engine.snapshot()
      this.reschedule(now)
      this.touch(now)
      return null
    }
    if (command.type === 'return-to-lobby') {
      this.assertHost(userId)
      if (!this.state.game || this.state.game.phase !== 'match-over') throw new Error('整场牌局尚未结束')
      this.returnToLobby(now)
      return null
    }

    if (this.state.recentActionIds.includes(command.actionId)) return null
    this.assertFreshAction(command.version)
    const engine = this.engine()
    if (seat.trustee) throw new Error('请先取消托管')
    if (command.type === 'discard') engine.discard(seat.seatId, command.tileId)
    else if (command.type === 'win') engine.declareWin(seat.seatId)
    else if (command.type === 'gang') engine.declareGang(seat.seatId, command.gangType, command.face)
    else if (command.type === 'claim') engine.claim(seat.seatId, command.action)
    else if (command.type === 'pass-claim') {
      if (engine.state.phase !== 'claiming') throw new Error('当前没有抢牌响应')
      const option = engine.state.claimOptions.find((candidate) => candidate.playerId === seat.seatId)
      if (!option) throw new Error('当前没有可响应操作')
      this.state.claimResponses[String(seat.seatId)] = 'pass'
    }
    this.state.game = engine.snapshot()
    this.rememberAction(command.actionId)
    if (command.type === 'pass-claim') this.resolveIfAllPassed(now)
    this.reconcile(now)
    this.touch(now)
    return null
  }

  runDueJobs(now = Date.now()): boolean {
    let changed = false
    for (let count = 0; count < 16; count += 1) {
      const job = [...this.state.jobs].sort((left, right) => left.dueAt - right.dueAt).find((candidate) => candidate.dueAt <= now)
      if (!job) break
      this.state.jobs = this.state.jobs.filter((candidate) => candidate.id !== job.id)
      if (job.kind === 'disconnect-trustee') {
        const seat = this.state.seats[job.seatId ?? -1]
        if (this.state.game && seat?.kind === 'human' && !seat.connected) {
          seat.trustee = true
          this.reschedule(now)
          changed = true
        }
        continue
      }
      if (job.kind === 'lobby-disconnect-remove') {
        const seat = this.state.seats[job.seatId ?? -1]
        if (!this.state.game && seat?.kind === 'human' && !seat.connected && seat.userId) {
          this.removeLobbyUser(seat.userId, now)
          changed = true
        }
        continue
      }
      if (!this.state.game || job.stageKey !== this.state.stageKey) continue
      const engine = this.engine()
      if (job.kind === 'ai-turn' || job.kind === 'turn-timeout') {
        const seat = this.state.seats[job.seatId ?? -1]
        if (!seat || engine.state.phase !== 'playing' || engine.state.currentPlayer !== seat.seatId) continue
        if (job.kind === 'turn-timeout' && seat.kind === 'human') seat.trustee = true
        this.performAITurn(engine, seat)
        this.state.game = engine.snapshot()
        this.reconcile(now)
        changed = true
      } else if (job.kind === 'ai-claim') {
        const seatId = job.seatId ?? -1
        if (engine.state.phase !== 'claiming' || this.state.claimResponses[String(seatId)]) continue
        if (job.claimAction && job.claimAction !== 'pass') engine.claim(seatId, job.claimAction)
        else this.state.claimResponses[String(seatId)] = 'pass'
        this.state.game = engine.snapshot()
        if (job.claimAction === 'pass') this.resolveIfAllPassed(now)
        this.reconcile(now)
        changed = true
      } else if (job.kind === 'claim-deadline' || job.kind === 'resolve-no-claim') {
        if (engine.state.phase !== 'claiming') continue
        engine.resolveNoClaim()
        this.state.game = engine.snapshot()
        this.reconcile(now)
        changed = true
      }
    }
    if (changed) this.touch(now)
    return changed
  }

  nextAlarmAt(): number | null {
    return this.state.jobs.length ? Math.min(...this.state.jobs.map((job) => job.dueAt)) : null
  }

  view(userId: string): OnlineRoomView {
    const seat = this.humanSeatByUser(userId)
    const game = this.state.game ? this.redactedGame(seat.seatId) : null
    return {
      code: this.state.code,
      phase: this.state.game ? 'playing' : 'lobby',
      version: this.state.version,
      hostUserId: this.state.hostUserId,
      selfUserId: userId,
      selfSeatId: seat.seatId,
      settings: structuredClone(this.state.settings),
      seats: this.state.seats.map((candidate): OnlineSeatView => ({
        seatId: candidate.seatId,
        kind: candidate.kind,
        userId: candidate.userId,
        name: candidate.name,
        connected: candidate.connected,
        ready: candidate.ready,
        trustee: candidate.trustee,
        isHost: candidate.userId === this.state.hostUserId,
      })),
      game,
      legal: this.legalActions(seat),
      deadlineAt: this.deadlineFor(seat),
      notice: this.noticeFor(seat),
      chat: structuredClone(this.state.chat),
    }
  }

  unrecordedLeaderboardResults(): RoundLeaderboardResult[] {
    const game = this.state.game
    if (!game || (game.phase !== 'settlement' && game.phase !== 'match-over')) return []
    const roundKey = `${game.matchId}:${game.round}`
    if (this.state.recordedRounds.includes(roundKey)) return []
    const winnerId = game.result?.winnerId
    return this.state.seats
      .filter((seat): seat is StoredSeat & { userId: string } => seat.kind === 'human' && !!seat.userId)
      .map((seat) => ({
        matchId: game.matchId,
        round: game.round,
        userId: seat.userId,
        won: winnerId === seat.seatId ? 1 : 0,
        sevenPairs: winnerId === seat.seatId && game.result?.winKind === 'seven-pairs' ? 1 : 0,
        gangCount: game.events.filter((event) => event.round === game.round && event.playerId === seat.seatId && ['an-gang', 'bu-gang', 'ming-gang'].includes(event.type)).length,
        maCount: winnerId === seat.seatId ? game.result?.maCount ?? 0 : 0,
      }))
  }

  markRoundRecorded(matchId: string, round: number): void {
    const key = `${matchId}:${round}`
    if (!this.state.recordedRounds.includes(key)) this.state.recordedRounds.push(key)
    if (this.state.recordedRounds.length > 200) this.state.recordedRounds.splice(0, this.state.recordedRounds.length - 200)
  }

  private startGame(now: number): void {
    if (this.state.game) throw new Error('牌局已经开始')
    const waiting = this.state.seats.filter((seat) => seat.kind === 'human' && seat.userId !== this.state.hostUserId && !seat.ready)
    if (waiting.length) throw new Error(`还有玩家未准备：${waiting.map((seat) => seat.name).join('、')}`)
    for (const seat of this.state.seats) {
      if (seat.kind !== 'empty') continue
      seat.kind = 'ai'
      seat.name = `AI ${seat.seatId}`
      seat.ai = structuredClone(TABLE_AI)
      seat.ready = true
    }
    const engine = new GameEngine({
      mode: this.state.settings.mode,
      claimWindowMs: this.state.settings.claimWindowMs,
      players: this.state.seats.map((seat) => ({
        name: seat.name,
        isHuman: seat.kind === 'human',
        initialPoints: this.state.settings.initialPoints,
        ai: seat.kind === 'ai' ? structuredClone(seat.ai ?? TABLE_AI) : null,
      })),
    })
    this.state.game = engine.snapshot()
    this.reschedule(now)
    this.touch(now)
  }

  private returnToLobby(now: number): void {
    this.state.jobs = []
    for (const seat of this.state.seats) {
      if (seat.kind === 'ai') this.state.seats[seat.seatId] = emptySeat(seat.seatId)
      else {
        seat.ready = seat.userId === this.state.hostUserId
        seat.trustee = false
        if (!seat.connected) {
          this.state.jobs.push({
            id: `lobby-disconnect-${seat.seatId}-${now}`,
            kind: 'lobby-disconnect-remove',
            dueAt: now + LOBBY_DISCONNECT_GRACE_MS,
            stageKey: 'presence',
            seatId: seat.seatId,
          })
        }
      }
    }
    this.state.game = null
    this.state.stageKey = ''
    this.state.claimResponses = {}
    this.touch(now)
  }

  private performAITurn(engine: GameEngine, seat: StoredSeat): void {
    const profile = seat.kind === 'ai' ? seat.ai ?? TABLE_AI : TRUSTEE_AI
    const observation = engine.createObservation(seat.seatId)
    const decision = decideTurn(observation, profile)
    if (decision.action === 'win') engine.declareWin(seat.seatId)
    else if (decision.action === 'an-gang' || decision.action === 'bu-gang') engine.declareGang(seat.seatId, decision.action, decision.face)
    else if (decision.action === 'discard') engine.discard(seat.seatId, decision.tileId)
  }

  private reconcile(now: number): void {
    const game = this.state.game
    if (!game) return
    const currentKey = stageKey(game)
    if (currentKey !== this.state.stageKey) {
      this.state.stageKey = currentKey
      this.state.stageStartedAt = now
      this.state.claimResponses = {}
      this.state.jobs = this.state.jobs.filter((job) => job.stageKey === 'presence')
    }
    if (game.phase === 'playing') {
      const seat = this.state.seats[game.currentPlayer]
      const existing = this.state.jobs.some((job) => job.stageKey === currentKey && (job.kind === 'ai-turn' || job.kind === 'turn-timeout'))
      if (!existing) {
        const auto = seat.kind === 'ai' || seat.trustee
        const profile = seat.kind === 'ai' ? seat.ai ?? TABLE_AI : TRUSTEE_AI
        const delay = auto ? deterministicDelay(AI_SPEED_DELAY_RANGES[profile.speed], this.state.version + seat.seatId * 17) : this.state.settings.turnWindowMs
        this.state.jobs.push({
          id: `${auto ? 'ai-turn' : 'turn-timeout'}-${currentKey}`,
          kind: auto ? 'ai-turn' : 'turn-timeout',
          dueAt: now + delay,
          stageKey: currentKey,
          seatId: seat.seatId,
        })
      }
      return
    }
    if (game.phase !== 'claiming') return
    const deadlineAt = this.state.stageStartedAt + game.config.claimWindowMs
    if (!this.state.jobs.some((job) => job.stageKey === currentKey && job.kind === 'claim-deadline')) {
      this.state.jobs.push({ id: `claim-deadline-${currentKey}`, kind: 'claim-deadline', dueAt: deadlineAt, stageKey: currentKey })
    }
    if (game.claimOptions.length === 0) {
      if (!this.state.jobs.some((job) => job.stageKey === currentKey && job.kind === 'resolve-no-claim')) {
        this.state.jobs.push({
          id: `no-claim-${currentKey}`,
          kind: 'resolve-no-claim',
          dueAt: now + claimMaskDelay(Math.abs(Math.sin(this.state.version))),
          stageKey: currentKey,
        })
      }
      return
    }
    const claimEngine = this.engine()
    for (const option of game.claimOptions) {
      const optionSeat = this.state.seats[option.playerId]
      if (optionSeat.kind === 'human' && !optionSeat.trustee) continue
      if (this.state.claimResponses[String(option.playerId)]) continue
      if (this.state.jobs.some((job) => job.stageKey === currentKey && job.kind === 'ai-claim' && job.seatId === option.playerId)) continue
      const profile = optionSeat.kind === 'ai' ? optionSeat.ai ?? TABLE_AI : TRUSTEE_AI
      const plan = decideClaim(claimEngine.createObservation(option.playerId, option.actions), profile, this.state.version + option.playerId * 31, game.config.claimWindowMs)
      this.state.jobs.push({
        id: `ai-claim-${currentKey}-${option.playerId}`,
        kind: 'ai-claim',
        dueAt: now + plan.delayMs,
        stageKey: currentKey,
        seatId: option.playerId,
        claimAction: plan.action,
      })
    }
  }

  private reschedule(now: number): void {
    this.state.stageKey = ''
    this.reconcile(now)
  }

  private resolveIfAllPassed(now: number): void {
    const game = this.state.game
    if (!game || game.phase !== 'claiming' || game.claimOptions.length === 0) return
    const allPassed = game.claimOptions.every((option) => this.state.claimResponses[String(option.playerId)] === 'pass')
    if (!allPassed) return
    const minimumResolveAt = this.state.stageStartedAt + claimMaskDelay(Math.abs(Math.sin(this.state.version)))
    this.state.jobs = this.state.jobs.filter((job) => !(job.stageKey === this.state.stageKey && job.kind === 'resolve-no-claim'))
    this.state.jobs.push({
      id: `all-passed-${this.state.stageKey}`,
      kind: 'resolve-no-claim',
      dueAt: Math.max(now, minimumResolveAt),
      stageKey: this.state.stageKey,
    })
  }

  private redactedGame(selfSeatId: number): GameState {
    const game = structuredClone(this.state.game!)
    const reveal = game.phase === 'settlement' || game.phase === 'match-over'
    game.wall = hiddenTiles(game.wall.length, 'wall')
    game.maReserve = hiddenTiles(game.maReserve.length, 'ma')
    game.seed = 0
    game.rngState = 0
    game.claimOptions = game.claimOptions.filter((option) => option.playerId === selfSeatId)
    for (const player of game.players) {
      if (!reveal && player.id !== selfSeatId) player.hand = hiddenTiles(player.hand.length, `seat-${player.id}`)
    }
    game.events = game.events.map((event) => {
      if (event.type !== 'draw' || event.playerId === selfSeatId) return event
      return { ...event, tile: undefined, detail: `${game.players[event.playerId ?? 0].name}摸牌` }
    })
    return game
  }

  private legalActions(seat: StoredSeat): OnlineLegalActions {
    const empty: OnlineLegalActions = {
      canDiscard: false,
      canWin: false,
      canNextRound: false,
      canReturnToLobby: false,
      anGangFaces: [],
      buGangFaces: [],
      claimActions: [],
    }
    const game = this.state.game
    if (!game) return empty
    empty.canNextRound = game.phase === 'settlement' && seat.userId === this.state.hostUserId
    empty.canReturnToLobby = game.phase === 'match-over' && seat.userId === this.state.hostUserId
    if (seat.trustee) return empty
    if (game.phase === 'claiming') {
      if (!this.state.claimResponses[String(seat.seatId)]) {
        empty.claimActions = structuredClone(game.claimOptions.find((option) => option.playerId === seat.seatId)?.actions ?? [])
      }
      return empty
    }
    if (game.phase !== 'playing' || game.currentPlayer !== seat.seatId) return empty
    empty.canDiscard = true
    if (game.turnStage === 'after-draw') {
      const engine = this.engine()
      empty.canWin = engine.winResult(seat.seatId).won
      empty.anGangFaces = engine.anGangFaces(seat.seatId)
      empty.buGangFaces = engine.buGangFaces(seat.seatId)
    }
    return empty
  }

  private deadlineFor(seat: StoredSeat): number | null {
    const game = this.state.game
    if (!game) return null
    if (game.phase === 'claiming') {
      return this.state.jobs.find((job) => job.stageKey === this.state.stageKey && job.kind === 'claim-deadline')?.dueAt ?? null
    }
    if (game.phase === 'playing' && game.currentPlayer === seat.seatId && !seat.trustee) {
      return this.state.jobs.find((job) => job.stageKey === this.state.stageKey && job.kind === 'turn-timeout')?.dueAt ?? null
    }
    return null
  }

  private noticeFor(seat: StoredSeat): string {
    const game = this.state.game
    if (!game) return '等待玩家准备'
    if (seat.trustee) return 'AI 正在托管你的座位'
    if (game.phase === 'claiming') {
      const actions = game.claimOptions.find((option) => option.playerId === seat.seatId)?.actions ?? []
      return actions.length ? '请选择碰、杠或过' : '等待其他玩家响应…'
    }
    if (game.phase === 'settlement') return seat.userId === this.state.hostUserId ? '本局结束，请开始下一局' : '本局结束，等待房主开始下一局'
    if (game.phase === 'match-over') return '整场牌局结束'
    if (game.currentPlayer === seat.seatId) return game.turnStage === 'after-draw' ? '轮到你操作' : '轮到你出牌'
    const currentSeat = this.state.seats[game.currentPlayer]
    return `${currentSeat.name}${currentSeat.trustee || currentSeat.kind === 'ai' ? '正在思考…' : '正在操作…'}`
  }

  private addChat(seat: StoredSeat, rawText: string, quick: boolean, now: number): ChatMessage {
    const text = rawText.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 100)
    if (!text) throw new Error('消息不能为空')
    const message: ChatMessage = {
      id: `chat-${now}-${this.state.version}`,
      userId: seat.userId!,
      nickname: seat.name,
      text,
      sentAt: now,
      quick,
    }
    this.state.chat.push(message)
    if (this.state.chat.length > 30) this.state.chat.splice(0, this.state.chat.length - 30)
    this.state.updatedAt = now
    return structuredClone(message)
  }

  private engine(): GameEngine {
    if (!this.state.game) throw new Error('牌局尚未开始')
    return GameEngine.restore(this.state.game)
  }

  private humanSeatByUser(userId: string): StoredSeat {
    const seat = this.state.seats.find((candidate) => candidate.kind === 'human' && candidate.userId === userId)
    if (!seat) throw new Error('你不在这个房间中')
    return seat
  }

  private assertHost(userId: string): void {
    if (this.state.hostUserId !== userId) throw new Error('只有房主可以执行此操作')
  }

  private assertFreshAction(version: number): void {
    if (version !== this.state.version) throw new Error('牌局状态已经更新，请按最新状态操作')
  }

  private rememberAction(actionId: string): void {
    if (this.state.recentActionIds.includes(actionId)) return
    this.state.recentActionIds.push(actionId)
    if (this.state.recentActionIds.length > 80) this.state.recentActionIds.splice(0, this.state.recentActionIds.length - 80)
  }

  private touch(now: number): void {
    this.state.updatedAt = now
    this.state.version += 1
  }
}
