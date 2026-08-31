import { decideClaim, decideTurn, estimateThinkMs } from '../src/game/ai'
import { GameEngine } from '../src/game/engine'
import { claimMaskDelay } from '../src/game/timing'
import { placeholderTiles } from '../src/game/tiles'
import type { AIProfile, ClaimAction, GameState } from '../src/game/types'
import type {
  ChatMessage,
  OnlineLegalActions,
  OnlineRoomSettings,
  OnlineRoomView,
  OnlineSeatView,
  OnlineTurnTimer,
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
  leftRoom: boolean
  ai: AIProfile | null
  // 结算界面点过「开始下一局」。等所有还在打的真人都点了才真开下一局，
  // 免得房主手快，别人还没看清这局怎么输的就翻篇了。
  nextRoundReady?: boolean
}

type ScheduledJobKind =
  | 'ai-turn'
  | 'turn-timeout'
  | 'ai-claim'
  | 'claim-deadline'
  | 'resolve-no-claim'
  | 'disconnect-trustee'
  | 'disconnect-replace-ai'
  | 'next-round-timeout'
  | 'lobby-disconnect-remove'
  | 'all-offline-expire'

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
  deleteRequested: boolean
  chatSeq: number
  lastChatAt: Record<string, number>
}

// 托管默认用最弱档：帮你顶着别把牌打崩就行，真要赢还得自己回来。
// 具体档位可以在管理模式里调，房间创建时会把当时的设置固化进房间。
const DEFAULT_TRUSTEE_DIFFICULTY: AIProfile['difficulty'] = 'beginner'
const TABLE_AI: AIProfile = { difficulty: 'standard' }
const DISCONNECT_GRACE_MS = 30_000
// 掉线后座位还留着的时间。过了这个点就换成 AI，避免牌桌被长期锁住。
const DISCONNECT_REPLACE_MS = 3 * 60_000
// 结算界面等所有人点「开始下一局」的上限。有人挂机也不能把整桌锁死。
const NEXT_ROUND_TIMEOUT_MS = 30_000
const LOBBY_DISCONNECT_GRACE_MS = 60_000
export const ROOM_RECONNECT_GRACE_MS = 5 * 60_000
const CHAT_RATE_LIMIT_MS = 600

function emptySeat(seatId: number): StoredSeat {
  return {
    seatId,
    kind: 'empty',
    userId: null,
    name: `座位 ${seatId + 1}`,
    connected: false,
    ready: false,
    trustee: false,
    leftRoom: false,
    ai: null,
    nextRoundReady: false,
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
    leftRoom: false,
    ai: null,
    nextRoundReady: false,
  }
}

function stageKey(game: GameState): string {
  return `${game.matchId}:${game.round}:${game.phase}:${game.turnStage}:${game.currentPlayer}:${game.events.at(-1)?.id ?? 'none'}`
}

// 阶段内重建定时任务时必须拿到同一个随机值，否则托管切换会让 AI 的等待时间跳变。
function stageSalt(key: string): number {
  let hash = 2166136261
  for (const char of key) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const hiddenTiles = placeholderTiles

export class RoomCoordinator {
  state: StoredRoomState

  constructor(state: StoredRoomState) {
    this.state = structuredClone(state)
    for (const seat of this.state.seats) seat.leftRoom ??= false
    this.state.deleteRequested ??= false
    this.state.chatSeq ??= this.state.chat.length
    this.state.lastChatAt ??= {}
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
      deleteRequested: false,
      chatSeq: 0,
      lastChatAt: {},
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
    seat.leftRoom = false
    this.state.deleteRequested = false
    this.ensureActiveHost()
    this.state.jobs = this.state.jobs.filter((job) => !(
      ['disconnect-trustee', 'disconnect-replace-ai', 'lobby-disconnect-remove'].includes(job.kind)
      && job.seatId === seat!.seatId
    ) && job.kind !== 'all-offline-expire')
    this.touch(now)
    return seat.seatId
  }

  disconnect(userId: string, now = Date.now()): void {
    const seat = this.humanSeatByUser(userId)
    seat.connected = false
    // 掉线的人不算数，不然结算界面会一直等一个回不来的人
    this.startNextRoundIfReady(now)
    seat.leftRoom = false
    this.state.jobs = this.state.jobs.filter((job) => !(
      ['disconnect-trustee', 'disconnect-replace-ai', 'lobby-disconnect-remove'].includes(job.kind)
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
    // 牌局中先转托管顶着，三分钟还没回来就换成 AI
    if (!lobby) {
      this.state.jobs.push({
        id: `disconnect-ai-${seat.seatId}-${now}`,
        kind: 'disconnect-replace-ai',
        dueAt: now + DISCONNECT_REPLACE_MS,
        stageKey: 'presence',
        seatId: seat.seatId,
      })
    }
    this.scheduleAllOfflineExpiry(now)
    this.touch(now)
  }

  leave(userId: string, now = Date.now()): void {
    if (!this.state.game) {
      this.removeLobbyUser(userId, now)
      return
    }
    // 主动退出就是彻底走人：座位当场换成 AI，本局战绩也不留。
    // 和掉线区分开——掉线还有三分钟重连窗口。
    const seat = this.humanSeatByUser(userId)
    this.replaceWithAI(seat, now)
    this.touch(now)
  }

  // 对局中房主退出或掉线托管后，房主身份要交给还在线的真人，
  // 否则结算界面上谁都点不了「开始下一局」，整个房间就永久停在那里。
  private ensureActiveHost(): boolean {
    if (!this.state.game) return false
    const host = this.state.seats.find((seat) => seat.kind === 'human' && seat.userId === this.state.hostUserId)
    if (host?.connected && !host.leftRoom) return false
    const candidate = this.state.seats.find((seat) => (
      seat.kind === 'human' && !!seat.userId && seat.connected && !seat.leftRoom
    ))
    if (!candidate?.userId || candidate.userId === this.state.hostUserId) return false
    this.state.hostUserId = candidate.userId
    return true
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
    this.scheduleAllOfflineExpiry(now)
    this.touch(now)
  }

  handle(userId: string, command: RoomCommand, now = Date.now()): ChatMessage | null {
    const seat = this.humanSeatByUser(userId)
    if (command.type === 'chat') return this.addChat(seat, command.text, command.quick, now)
    if (command.type === 'leave-room') {
      this.leave(userId, now)
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
      this.rescheduleSeat(seat.seatId, now)
      this.touch(now)
      return null
    }
    if (command.type === 'next-round') {
      if (!this.state.game || this.state.game.phase !== 'settlement') throw new Error('本局还没结束')
      seat.nextRoundReady = true
      this.startNextRoundIfReady(now)
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
      try {
        if (this.runJob(job, now)) changed = true
      } catch (cause) {
        // 单个定时任务失败不能让整个房间停摆：丢掉这个任务，重新给当前阶段排一个。
        console.error('房间定时任务执行失败', job.kind, cause)
        if (this.state.game) this.reconcile(now)
        changed = true
      }
    }
    if (changed) this.touch(now)
    return changed
  }

  private runJob(job: ScheduledJob, now: number): boolean {
    if (job.kind === 'disconnect-trustee') {
      const seat = this.state.seats[job.seatId ?? -1]
      if (!this.state.game || seat?.kind !== 'human' || seat.connected) return false
      seat.trustee = true
      this.ensureActiveHost()
      this.rescheduleSeat(seat.seatId, now)
      return true
    }
    if (job.kind === 'disconnect-replace-ai') {
      const seat = this.state.seats[job.seatId ?? -1]
      if (!this.state.game || seat?.kind !== 'human' || seat.connected) return false
      this.replaceWithAI(seat, now, false)
      // 少了一个要点下一局的人，可能正好凑齐
      this.startNextRoundIfReady(now)
      return true
    }
    if (job.kind === 'next-round-timeout') {
      // 有人一直不点也不能把整桌锁死，到点强制开
      return this.startNextRoundIfReady(now, true)
    }
    if (job.kind === 'all-offline-expire') {
      const humans = this.allHumanSeats()
      if (humans.length === 0 || humans.some((seat) => seat.connected)) return false
      this.state.deleteRequested = true
      return true
    }
    if (job.kind === 'lobby-disconnect-remove') {
      const seat = this.state.seats[job.seatId ?? -1]
      const humans = this.allHumanSeats()
      if (humans.length > 0 && humans.every((candidate) => !candidate.connected)) {
        const expiry = this.state.jobs.find((candidate) => candidate.kind === 'all-offline-expire')
        if (expiry && expiry.dueAt > now) this.state.jobs.push({ ...job, dueAt: expiry.dueAt })
        return false
      }
      if (this.state.game || seat?.kind !== 'human' || seat.connected || !seat.userId) return false
      this.removeLobbyUser(seat.userId, now)
      return true
    }
    if (!this.state.game || job.stageKey !== this.state.stageKey) return false
    const engine = this.engine()
    if (job.kind === 'ai-turn' || job.kind === 'turn-timeout') {
      const seat = this.state.seats[job.seatId ?? -1]
      if (!seat || engine.state.phase !== 'playing' || engine.state.currentPlayer !== seat.seatId) return false
      if (job.kind === 'turn-timeout' && seat.kind === 'human') seat.trustee = true
      this.performAITurn(engine, seat)
      this.state.game = engine.snapshot()
      this.reconcile(now)
      return true
    }
    if (job.kind === 'ai-claim') {
      const seatId = job.seatId ?? -1
      if (engine.state.phase !== 'claiming' || this.state.claimResponses[String(seatId)]) return false
      if (job.claimAction && job.claimAction !== 'pass') engine.claim(seatId, job.claimAction)
      else this.state.claimResponses[String(seatId)] = 'pass'
      this.state.game = engine.snapshot()
      if (job.claimAction !== 'peng' && job.claimAction !== 'ming-gang') this.resolveIfAllPassed(now)
      this.reconcile(now)
      return true
    }
    if (job.kind === 'claim-deadline' || job.kind === 'resolve-no-claim') {
      if (engine.state.phase !== 'claiming') return false
      engine.resolveNoClaim()
      this.state.game = engine.snapshot()
      this.reconcile(now)
      return true
    }
    return false
  }

  nextAlarmAt(): number | null {
    return this.state.jobs.length ? Math.min(...this.state.jobs.map((job) => job.dueAt)) : null
  }

  view(userId: string, now = Date.now()): OnlineRoomView {
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
      turnTimer: this.turnTimer(),
      notice: this.noticeFor(seat),
      chat: structuredClone(this.state.chat),
      serverNow: now,
    }
  }

  // 结算界面上还没点「开始下一局」的人。托管的也算——他照样看得见按钮，
  // 只是可能人不在，所以另有 NEXT_ROUND_TIMEOUT_MS 兜底。掉线的不算，
  // 他们会走三分钟那条路换成 AI。
  private awaitingNextRound(): StoredSeat[] {
    return this.state.seats.filter((seat) => (
      seat.kind === 'human' && seat.connected && !seat.leftRoom && !seat.nextRoundReady
    ))
  }

  private startNextRoundIfReady(now: number, force = false): boolean {
    const game = this.state.game
    if (!game || game.phase !== 'settlement') return false
    if (!force && this.awaitingNextRound().length) return false
    // 上一局结束时还没回来的人，直接换成 AI：座位空着会让下一局开不起来，
    // 三分钟的重连窗口也没必要跨局继续等。
    for (const seat of this.state.seats) {
      if (seat.kind === 'human' && !seat.connected && !seat.leftRoom) this.replaceWithAI(seat, now, false, false)
    }
    const engine = this.engine()
    engine.continueAfterSettlement()
    this.state.game = engine.snapshot()
    for (const seat of this.state.seats) seat.nextRoundReady = false
    this.reschedule(now)
    return true
  }

  // 结算界面点「退出房间」：座位不留托管，直接换成一个 AI 顶上，
  // 房间少个人也能继续打下去。档位跟房主开局时选的那个走。
  // cascade=false 用在「开下一局之前顺手清掉掉线的人」那一步：
  // 那时候本来就在开局流程里，再回头触发一次开局检查会把牌局往前推两次。
  private replaceWithAI(seat: StoredSeat, now: number, announce = true, cascade = true): void {
    const name = seat.name
    const wasHost = seat.userId === this.state.hostUserId
    const game = this.state.game
    this.state.seats[seat.seatId] = {
      ...emptySeat(seat.seatId),
      kind: 'ai',
      name: `AI ${seat.seatId}`,
      ready: true,
      ai: { difficulty: this.state.settings.aiDifficulty ?? TABLE_AI.difficulty },
    }
    if (game) {
      const player = game.players[seat.seatId]
      if (player) {
        player.isHuman = false
        player.name = `AI ${seat.seatId}`
        player.ai = { difficulty: this.state.settings.aiDifficulty ?? TABLE_AI.difficulty }
      }
      game.events.push({
        id: `leave-${seat.seatId}-${now}`,
        round: game.round,
        type: 'ai-change',
        at: now,
        detail: announce ? `${name} 离开房间，座位由 AI 接手` : `${name} 掉线未回，座位由 AI 接手`,
      })
    }
    this.state.jobs = this.state.jobs.filter((job) => job.seatId !== seat.seatId)
    if (wasHost) this.ensureActiveHost()
    // 人走光了就别留着一桌 AI 自己打下去。原来靠 leftRoom 标记判断，
    // 现在座位直接变成 AI，真人座位为空就是「没人了」。
    if (!this.state.seats.some((candidate) => candidate.kind === 'human' && candidate.userId)) {
      this.state.deleteRequested = true
      return
    }
    if (!cascade) {
      this.rescheduleSeat(seat.seatId, now)
      return
    }
    // 少了一个要点下一局的人，可能正好凑齐了
    if (!this.startNextRoundIfReady(now)) this.rescheduleSeat(seat.seatId, now)
    this.scheduleAllOfflineExpiry(now)
  }

  private startGame(now: number): void {
    if (this.state.game) throw new Error('牌局已经开始')
    const waiting = this.state.seats.filter((seat) => seat.kind === 'human' && seat.userId !== this.state.hostUserId && !seat.ready)
    if (waiting.length) throw new Error(`还有玩家未准备：${waiting.map((seat) => seat.name).join('、')}`)
    for (const seat of this.state.seats) {
      if (seat.kind !== 'empty') continue
      seat.kind = 'ai'
      seat.name = `AI ${seat.seatId}`
      seat.ai = { difficulty: this.state.settings.aiDifficulty ?? TABLE_AI.difficulty }
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

  // 托管档位在建房时就固化进房间设置，管理模式改了也不影响已经在打的房间。
  private trusteeProfile(): AIProfile {
    return { difficulty: this.state.settings.trusteeDifficulty ?? DEFAULT_TRUSTEE_DIFFICULTY }
  }

  private performAITurn(engine: GameEngine, seat: StoredSeat): void {
    const profile = seat.kind === 'ai' ? seat.ai ?? TABLE_AI : this.trusteeProfile()
    try {
      const observation = engine.createObservation(seat.seatId)
      const decision = decideTurn(observation, profile)
      if (decision.action === 'win') engine.declareWin(seat.seatId)
      else if (decision.action === 'an-gang' || decision.action === 'bu-gang') engine.declareGang(seat.seatId, decision.action, decision.face)
      else if (decision.action === 'discard') engine.discard(seat.seatId, decision.tileId)
      return
    } catch (cause) {
      console.error('AI 决策失败，改为打出手中第一张牌', seat.seatId, cause)
    }
    // 兜底：宁可打一张不够好的牌，也不能让这个座位卡住整局。
    const fallback = engine.state.players[seat.seatId]?.hand[0]
    if (fallback) engine.discard(seat.seatId, fallback.id)
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
      this.bumpVersion()
    }
    const salt = stageSalt(currentKey)
    if (game.phase === 'settlement') {
      // 全员托管时谁都不会去点「开始下一局」，没有这个兜底就永远停在结算界面
      const pending = this.state.jobs.some((job) => job.kind === 'next-round-timeout')
      if (!pending) {
        this.state.jobs.push({
          id: `next-round-${game.matchId}-${game.round}`,
          kind: 'next-round-timeout',
          dueAt: now + NEXT_ROUND_TIMEOUT_MS,
          stageKey: currentKey,
        })
      }
    }
    if (game.phase === 'playing') {
      const seat = this.state.seats[game.currentPlayer]
      const existing = this.state.jobs.some((job) => job.stageKey === currentKey && (job.kind === 'ai-turn' || job.kind === 'turn-timeout'))
      if (!existing) {
        const auto = seat.kind === 'ai' || seat.trustee
        const profile = seat.kind === 'ai' ? seat.ai ?? TABLE_AI : this.trusteeProfile()
        // AI 想多久按这手牌好不好打来定，不再有固定的速度档位
        const delay = auto
          ? estimateThinkMs(this.engine().createObservation(seat.seatId), profile, salt + seat.seatId * 17)
          : this.state.settings.turnWindowMs
        // 以阶段开始时间为基准，取消托管、重连都不会让自己的倒计时回到满格。
        const dueAt = this.state.stageStartedAt + delay
        this.state.jobs.push({
          id: `${auto ? 'ai-turn' : 'turn-timeout'}-${currentKey}`,
          kind: auto ? 'ai-turn' : 'turn-timeout',
          dueAt: auto ? Math.max(now, dueAt) : dueAt,
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
          dueAt: this.state.stageStartedAt + claimMaskDelay(Math.abs(Math.sin(salt))),
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
      const profile = optionSeat.kind === 'ai' ? optionSeat.ai ?? TABLE_AI : this.trusteeProfile()
      const plan = decideClaim(claimEngine.createObservation(option.playerId, option.actions), profile, salt + option.playerId * 31, game.config.claimWindowMs)
      this.state.jobs.push({
        id: `ai-claim-${currentKey}-${option.playerId}`,
        kind: 'ai-claim',
        dueAt: Math.max(now, this.state.stageStartedAt + plan.delayMs),
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

  // 座位自身状态（托管开关、离开）变化时，只重排该座位的定时任务。
  // 不能走 reschedule：那会让 reconcile 误判为进入新阶段，从而重置 stageStartedAt、
  // 清空所有人的抢牌响应，并把当前回合和抢牌窗口的倒计时一起推回满格。
  private rescheduleSeat(seatId: number, now: number): void {
    this.state.jobs = this.state.jobs.filter((job) => !(
      job.seatId === seatId
      && (job.kind === 'ai-turn' || job.kind === 'turn-timeout' || job.kind === 'ai-claim')
    ))
    this.reconcile(now)
  }

  private resolveIfAllPassed(now: number): void {
    const game = this.state.game
    if (!game || game.phase !== 'claiming' || game.claimOptions.length === 0) return
    const allPassed = game.claimOptions.every((option) => this.state.claimResponses[String(option.playerId)] === 'pass')
    if (!allPassed) return
    const minimumResolveAt = this.state.stageStartedAt + claimMaskDelay(Math.abs(Math.sin(stageSalt(this.state.stageKey))))
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
      if (reveal || player.id === selfSeatId) continue
      player.hand = hiddenTiles(player.hand.length, `seat-${player.id}`)
      // 暗杠是暗牌：别人只该知道「他暗杠了」，不该知道杠的是什么。
      for (const meld of player.melds) {
        if (meld.type !== 'an-gang') continue
        meld.tiles = hiddenTiles(meld.tiles.length, `an-gang-${player.id}-${meld.id}`)
      }
    }
    game.events = game.events.map((event) => {
      if (event.playerId === selfSeatId) return event
      if (event.type === 'draw') return { ...event, tile: undefined, detail: `${game.players[event.playerId ?? 0].name}摸牌` }
      if (event.type === 'an-gang' && !reveal) {
        return { ...event, tile: undefined, detail: `${game.players[event.playerId ?? 0].name}暗杠` }
      }
      return event
    })
    return game
  }

  private legalActions(seat: StoredSeat): OnlineLegalActions {
    const empty: OnlineLegalActions = {
      canDiscard: false,
      canWin: false,
      canNextRound: false,
      canQuitRoom: false,
      nextRoundReady: false,
      nextRoundWaiting: [],
      canReturnToLobby: false,
      anGangFaces: [],
      buGangFaces: [],
      claimActions: [],
    }
    const game = this.state.game
    if (!game) return empty
    // 结算界面所有人都能点，托管的也能。点过的人客户端自己收起弹窗回牌桌，
    // 服务端这边等人齐（或等超时）再开下一局。
    empty.canNextRound = game.phase === 'settlement'
    empty.canQuitRoom = game.phase === 'settlement'
    empty.nextRoundReady = !!seat.nextRoundReady
    empty.nextRoundWaiting = game.phase === 'settlement'
      ? this.awaitingNextRound().map((waiting) => waiting.name)
      : []
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
    const engine = this.engine()
    // 补杠在刚碰完（还没出牌）时也允许，所以不再限定摸牌后。
    empty.buGangFaces = engine.buGangFaces(seat.seatId)
    if (game.turnStage === 'after-draw') {
      empty.canWin = engine.winResult(seat.seatId).won
      empty.anGangFaces = engine.anGangFaces(seat.seatId)
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

  private turnTimer(): OnlineTurnTimer | null {
    const game = this.state.game
    if (!game || game.phase !== 'playing') return null
    const job = this.state.jobs.find((candidate) => (
      candidate.stageKey === this.state.stageKey
      && candidate.seatId === game.currentPlayer
      && (candidate.kind === 'ai-turn' || candidate.kind === 'turn-timeout')
    ))
    if (!job) return null
    return {
      seatId: game.currentPlayer,
      startedAt: this.state.stageStartedAt,
      deadlineAt: job.dueAt,
      kind: job.kind === 'ai-turn' ? 'ai' : 'turn',
    }
  }

  private noticeFor(seat: StoredSeat): string {
    const game = this.state.game
    if (!game) return '等待玩家准备'
    if (seat.trustee) return 'AI 正在托管你的座位'
    if (game.phase === 'claiming') {
      const actions = game.claimOptions.find((option) => option.playerId === seat.seatId)?.actions ?? []
      return actions.length ? '请选择碰、杠或过' : ''
    }
    if (game.phase === 'settlement') return seat.userId === this.state.hostUserId ? '本局结束，请开始下一局' : '本局结束，等待房主开始下一局'
    if (game.phase === 'match-over') return '整场牌局结束'
    if (game.currentPlayer === seat.seatId) return game.turnStage === 'after-draw' ? '轮到你操作' : '轮到你出牌'
    return ''
  }

  private addChat(seat: StoredSeat, rawText: string, quick: boolean, now: number): ChatMessage {
    const userId = seat.userId!
    const lastSentAt = this.state.lastChatAt[userId]
    if (lastSentAt !== undefined && now - lastSentAt < CHAT_RATE_LIMIT_MS) throw new Error('发送太快，请稍后再试')
    const text = rawText.trim().replace(/[\r\n\t]+/g, ' ').slice(0, 100)
    if (!text) throw new Error('消息不能为空')
    this.state.lastChatAt[userId] = now
    this.state.chatSeq += 1
    const message: ChatMessage = {
      id: `chat-${now}-${this.state.chatSeq}`,
      userId,
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

  // version 只跟随牌局阶段推进，不跟随聊天、进出房间、托管这类与出牌无关的变化。
  // 否则别人一掉线或一发言，你手上正要提交的操作就会被判成过期。
  private assertFreshAction(version: number): void {
    if (version !== this.state.version) throw new Error('牌局已经进入下一步，请按最新牌面重新操作')
  }

  shouldDeleteRoom(): boolean {
    if (this.state.deleteRequested) return true
    const humans = this.allHumanSeats()
    return humans.length > 0 && humans.every((seat) => seat.leftRoom)
  }

  ensureOfflineExpiry(now = Date.now()): boolean {
    const humans = this.allHumanSeats()
    if (!humans.length || humans.some((seat) => seat.connected)) return false
    if (this.state.jobs.some((job) => job.kind === 'all-offline-expire')) return false
    const dueAt = this.state.updatedAt + ROOM_RECONNECT_GRACE_MS
    if (dueAt <= now) this.state.deleteRequested = true
    else {
      this.state.jobs.push({
        id: `all-offline-expire-restored-${dueAt}`,
        kind: 'all-offline-expire',
        dueAt,
        stageKey: 'presence',
      })
    }
    return true
  }

  private allHumanSeats(): StoredSeat[] {
    return this.state.seats.filter((seat) => seat.kind === 'human' && !!seat.userId)
  }

  private scheduleAllOfflineExpiry(now: number): void {
    this.state.jobs = this.state.jobs.filter((job) => job.kind !== 'all-offline-expire')
    const humans = this.allHumanSeats()
    if (!humans.length || humans.some((seat) => seat.connected)) return
    this.state.jobs.push({
      id: `all-offline-expire-${now}`,
      kind: 'all-offline-expire',
      dueAt: now + ROOM_RECONNECT_GRACE_MS,
      stageKey: 'presence',
    })
  }

  private rememberAction(actionId: string): void {
    if (this.state.recentActionIds.includes(actionId)) return
    this.state.recentActionIds.push(actionId)
    if (this.state.recentActionIds.length > 80) this.state.recentActionIds.splice(0, this.state.recentActionIds.length - 80)
  }

  private touch(now: number): void {
    this.state.updatedAt = now
  }

  private bumpVersion(): void {
    this.state.version += 1
  }
}
