import { SanguoshaGame } from '../src/sanguosha/engine/game'
import { GameRng } from '../src/sanguosha/engine/rng'
import { decideResponse, decidePlayAction, type AIContext, type AIDifficulty } from '../src/sanguosha/ai'
import { emptySuspicion, observeEvent, type SuspicionMap } from '../src/sanguosha/ai/belief'
import { describeEvent } from '../src/sanguosha/engine/log'
import { buildPresentationEvent, type PresentationEvent } from '../src/sanguosha/engine/presentation'
import type { GameResponse } from '../src/sanguosha/engine/requests'
import type { PlayerId, SanguoshaState } from '../src/sanguosha/engine/types'
import type { PlayerView } from '../src/sanguosha/engine/view'
import type { SgsChatMessage, SgsRoomCommand, SgsRoomSettings, SgsRoomView } from '../src/sanguosha/online/protocol'
export type { SgsChatMessage, SgsRoomCommand, SgsRoomSettings, SgsRoomView } from '../src/sanguosha/online/protocol'

/**
 * 三国杀联机房间的纯逻辑核心。
 *
 * 三条硬约束，都写在任务书里：
 *
 * 1. **服务端权威。** 客户端只发意图（要响应哪个 requestId、要执行哪个 actionId），
 *    合法性一律由引擎判定。这里不信任任何客户端传来的牌面或目标。
 * 2. **每个连接只看得到自己的视图。** 下发的是 `buildPlayerView(state, viewerId)`，
 *    完整 GameState 永远不出这个文件。
 * 3. **Durable Object 随时会休眠。** 所有等待都表达成可序列化的状态和定时任务，
 *    没有任何 `await 用户点击`。
 *
 * 单机和联机共用同一套引擎，这里不存在第二套规则。
 */

export interface SgsRoomUser {
  userId: string
  nickname: string
}

interface SgsSeat {
  seatId: number
  kind: 'empty' | 'human' | 'ai'
  userId: string | null
  name: string
  connected: boolean
  ready: boolean
  /** 托管中：由 AI 代打，但座位仍然属于这个人 */
  trustee: boolean
  leftRoom: boolean
  nextRoundReady: boolean
}

type SgsJobKind = 'ai-step' | 'turn-timeout' | 'disconnect-trustee' | 'next-round-timeout'

interface SgsJob {
  id: string
  kind: SgsJobKind
  dueAt: number
  /** 局面指纹。局面已经变了的任务直接作废，避免超时把新局面误伤 */
  stageKey: string
  seatId?: number
}

export interface StoredSgsRoomState {
  schemaVersion: 1
  code: string
  createdAt: number
  updatedAt: number
  hostUserId: string
  settings: SgsRoomSettings
  seats: SgsSeat[]
  game: SanguoshaState | null
  version: number
  chat: SgsChatMessage[]
  chatSeq: number
  jobs: SgsJob[]
  stageKey: string
  /** AI 的随机源和牌局的分开，AI 的选择不会反过来影响洗牌序列 */
  aiSeed: string
  aiRngState: number
  suspicion: SuspicionMap
  /** 按玩家过滤后的战报。存的是已经翻译好的文本，重连时能直接补上 */
  log: Record<string, string[]>
  /**
   * 结构化表现事件，供重连后恢复当前行动舞台。
   *
   * 只存一份：`buildPresentationEvent` 只读公开字段，结果对所有座位相同，
   * 按座位各存一份等于把同样的内容复制 8 遍进 DO 存储。
   */
  presentationEvents?: PresentationEvent[]
  deleteRequested: boolean
  /** 最近成功处理的客户端动作。用于在 DO 休眠恢复后继续拒绝重复 actionId。 */
  processedActionIds?: string[]
}

export class InvalidSgsCommandError extends Error {}

const MIN_PLAYERS = 5
const MAX_PLAYERS = 8
const DEFAULT_TURN_SECONDS = 30
/**
 * AI 之间的间隔。和单机的「标准」档对齐（见 SanguoshaApp.vue 的 AI_PACE_MS）。
 *
 * 间隔必须明显长于单条表现事件（伤害 900ms、阵亡 1200ms），
 * 否则一步里连出几条事件时动画永远在被追着跑，观感就是「太快，看不清」。
 * 改这个值时把单机那份一起改，两边对不上会让联机显得比单机快。
 */
const AI_STEP_MS = 1900
/**
 * 选将阶段的 AI 间隔。
 *
 * 选将没有任何动画可看，按对局节奏走 8 人局要等十几秒才开得了局。
 * 和单机那边（useLocalSanguosha 的 selecting 分支）保持同一个量级。
 */
const AI_PICK_GENERAL_MS = 150
/** 掉线后多久自动转托管。留一点时间给刷新页面 */
const DISCONNECT_TRUSTEE_MS = 20_000
const NEXT_ROUND_TIMEOUT_MS = 40_000
const CHAT_MAX = 40
const LOG_MAX = 200
/** 舞台只回放最近这些条，重连时够还原「刚才发生了什么」，又不至于把 DO 存储撑大 */
const PRESENTATION_MAX = 30

function emptySeat(seatId: number): SgsSeat {
  return { seatId, kind: 'empty', userId: null, name: '', connected: false, ready: false, trustee: false, leftRoom: false, nextRoundReady: false }
}

/** 座位 id 和引擎里的 playerId 是一一对应的，转换只在这里发生。 */
function playerIdOf(seatId: number): PlayerId {
  return `seat-${seatId}`
}

function seatIdOf(playerId: PlayerId): number {
  return Number(playerId.slice('seat-'.length))
}

export function normalizeSettings(input: Partial<SgsRoomSettings> | undefined): SgsRoomSettings {
  const playerCount = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.floor(Number(input?.playerCount ?? MIN_PLAYERS)) || MIN_PLAYERS))
  const difficulty: AIDifficulty = input?.difficulty === 'easy' || input?.difficulty === 'hard' ? input.difficulty : 'normal'
  const turnSeconds = Math.min(120, Math.max(10, Math.floor(Number(input?.turnSeconds ?? DEFAULT_TURN_SECONDS)) || DEFAULT_TURN_SECONDS))
  return { playerCount, difficulty, turnSeconds }
}

export class SanguoshaRoomCoordinator {
  state: StoredSgsRoomState
  /** 引擎实例只在内存里；持久化的永远是 state.game */
  private engine: SanguoshaGame | null = null

  constructor(stored: StoredSgsRoomState) {
    this.state = stored
    // 上一版按座位分组存这份数据，休眠中的房间恢复回来仍是旧形状，取任意一份即可
    const legacy = this.state.presentationEvents as unknown
    if (legacy && !Array.isArray(legacy)) {
      this.state.presentationEvents = Object.values(legacy as Record<string, PresentationEvent[]>)[0] ?? []
    }
    this.state.processedActionIds ??= []
  }

  static create(code: string, host: SgsRoomUser, settings: SgsRoomSettings, now = Date.now()): SanguoshaRoomCoordinator {
    const seats = Array.from({ length: settings.playerCount }, (_, index) => emptySeat(index))
    const coordinator = new SanguoshaRoomCoordinator({
      schemaVersion: 1,
      code,
      createdAt: now,
      updatedAt: now,
      hostUserId: host.userId,
      settings,
      seats,
      game: null,
      version: 1,
      chat: [],
      chatSeq: 0,
      jobs: [],
      stageKey: 'lobby',
      aiSeed: `${code}-${now}`,
      aiRngState: 0,
      suspicion: {},
      log: {},
      presentationEvents: [],
      deleteRequested: false,
      processedActionIds: [],
    })
    coordinator.seatUser(host, now)
    return coordinator
  }

  snapshot(): StoredSgsRoomState {
    // 引擎在内存里可能已经往前走了，落盘前必须同步回来
    if (this.engine) this.state.game = this.engine.serialize()
    return this.state
  }

  private game(): SanguoshaGame {
    if (!this.state.game) throw new InvalidSgsCommandError('牌局还没有开始')
    if (!this.engine) {
      this.engine = SanguoshaGame.restore(this.state.game)
      this.attachObservers(this.engine)
    }
    return this.engine
  }

  private touch(now: number): void {
    this.state.updatedAt = now
    this.state.version += 1
  }

  // —— 座位 ——

  private seatUser(user: SgsRoomUser, now: number): number {
    const existing = this.state.seats.find((seat) => seat.userId === user.userId)
    if (existing) {
      existing.connected = true
      existing.leftRoom = false
      existing.trustee = false
      existing.name = user.nickname
      return existing.seatId
    }
    const free = this.state.seats.find((seat) => seat.kind === 'empty')
    if (!free) throw new InvalidSgsCommandError('房间已满')
    free.kind = 'human'
    free.userId = user.userId
    free.name = user.nickname
    free.connected = true
    free.ready = false
    this.touch(now)
    return free.seatId
  }

  connect(user: SgsRoomUser, now = Date.now()): number {
    if (this.state.game && !this.state.seats.some((seat) => seat.userId === user.userId)) {
      throw new InvalidSgsCommandError('牌局已经开始，无法加入')
    }
    const seatId = this.seatUser(user, now)
    // 重连回来就取消托管和掉线定时
    this.state.jobs = this.state.jobs.filter((job) => !(job.kind === 'disconnect-trustee' && job.seatId === seatId))
    this.touch(now)
    this.scheduleNext(now)
    return seatId
  }

  disconnect(userId: string, now = Date.now()): void {
    const seat = this.state.seats.find((candidate) => candidate.userId === userId)
    if (!seat || !seat.connected) return
    seat.connected = false
    if (this.state.game) {
      // 牌局中先留一段时间给刷新，过了才转托管
      this.pushJob({ kind: 'disconnect-trustee', dueAt: now + DISCONNECT_TRUSTEE_MS, seatId: seat.seatId })
    } else {
      seat.kind = 'empty'
      seat.userId = null
      seat.name = ''
      seat.ready = false
    }
    this.touch(now)
    this.scheduleNext(now)
  }

  leave(userId: string, now = Date.now()): void {
    const seat = this.state.seats.find((candidate) => candidate.userId === userId)
    if (!seat) return
    seat.leftRoom = true
    seat.connected = false
    if (this.state.game) {
      // 牌局中不能凭空抽走一个座位，交给 AI 接管
      seat.trustee = true
    } else {
      seat.kind = 'empty'
      seat.userId = null
      seat.name = ''
      seat.ready = false
    }
    if (this.state.seats.every((candidate) => candidate.kind !== 'human' || candidate.leftRoom)) {
      this.state.deleteRequested = true
    }
    this.touch(now)
    this.scheduleNext(now)
  }

  // —— 指令 ——

  handle(userId: string, command: SgsRoomCommand, now = Date.now()): SgsChatMessage | null {
    const hasActionId = command.actionId !== undefined
    const hasBaseSeq = command.baseSeq !== undefined
    if (hasActionId !== hasBaseSeq) throw new InvalidSgsCommandError('操作元数据不完整')
    if (command.actionId) {
      // 重放保护：同一个 actionId 只执行一次。这条是必须的。
      if (this.state.processedActionIds!.includes(command.actionId)) throw new InvalidSgsCommandError('这个操作已经处理过了')
      // 陈旧检查**不能**用 `baseSeq !== version`：version 在 AI 每走一步、
      // 每条聊天、每次断连时都会变，玩家点一下几乎必然「陈旧」，指令会被无故拒绝。
      // 真正的陈旧由引擎自己挡住，而且挡得更准：
      //   respond 带 requestId，请求处理过就不存在了；
      //   act 带 legalActionId，不在当前合法动作里就会被拒；
      //   出牌还要过「还没轮到你」。
      // 所以这里只在**局面明显倒退**时拒绝——客户端报出来的版本比服务端还新，
      // 那说明连的不是同一个房间状态。
      if (command.baseSeq !== undefined && command.baseSeq > this.state.version) {
        throw new InvalidSgsCommandError('客户端状态与房间不一致，请重新连接')
      }
    }

    const result = this.handleCommand(userId, command, now)
    if (command.actionId) {
      this.state.processedActionIds!.push(command.actionId)
      if (this.state.processedActionIds!.length > 256) this.state.processedActionIds!.splice(0, this.state.processedActionIds!.length - 256)
    }
    return result
  }

  private handleCommand(userId: string, command: SgsRoomCommand, now: number): SgsChatMessage | null {
    const seat = this.state.seats.find((candidate) => candidate.userId === userId)
    if (!seat) throw new InvalidSgsCommandError('你不在这个房间里')

    switch (command.type) {
      case 'chat': {
        const text = command.text.trim().slice(0, 200)
        if (!text) throw new InvalidSgsCommandError('消息不能为空')
        const message: SgsChatMessage = { id: ++this.state.chatSeq, userId, seatId: seat.seatId, nickname: seat.name, text, at: now }
        this.state.chat.push(message)
        if (this.state.chat.length > CHAT_MAX) this.state.chat.splice(0, this.state.chat.length - CHAT_MAX)
        this.touch(now)
        return message
      }

      case 'toggle-ready': {
        if (this.state.game) throw new InvalidSgsCommandError('牌局已经开始')
        seat.ready = !seat.ready
        this.touch(now)
        return null
      }

      case 'add-ai': {
        this.assertHost(userId)
        if (this.state.game) throw new InvalidSgsCommandError('牌局已经开始')
        const free = this.state.seats.find((candidate) => candidate.kind === 'empty')
        if (!free) throw new InvalidSgsCommandError('没有空位了')
        free.kind = 'ai'
        free.name = `电脑${free.seatId + 1}`
        free.ready = true
        free.connected = true
        this.touch(now)
        return null
      }

      case 'remove-ai': {
        this.assertHost(userId)
        if (this.state.game) throw new InvalidSgsCommandError('牌局已经开始')
        const target = this.state.seats.find((candidate) => candidate.seatId === command.seatId && candidate.kind === 'ai')
        if (!target) throw new InvalidSgsCommandError('这个位置上不是电脑')
        Object.assign(target, emptySeat(target.seatId))
        this.touch(now)
        return null
      }

      case 'start-game': {
        this.assertHost(userId)
        this.startGame(now)
        return null
      }

      case 'respond': {
        const game = this.game()
        const request = game.state.pendingRequests.find((candidate) => candidate.id === command.requestId)
        if (!request) throw new InvalidSgsCommandError('这个请求已经处理过了')
        if (request.playerId !== playerIdOf(seat.seatId)) throw new InvalidSgsCommandError('这不是你要回应的请求')
        // 合法性交给引擎判定，服务端不做第二套规则
        game.respond({ requestId: request.id, playerId: request.playerId, payload: command.payload } as GameResponse)
        this.afterEngineStep(now)
        return null
      }

      case 'act': {
        const game = this.game()
        const playerId = playerIdOf(seat.seatId)
        if (game.state.currentPlayerId !== playerId) throw new InvalidSgsCommandError('还没轮到你')
        if (game.state.pendingRequests.length > 0) throw new InvalidSgsCommandError('还有待处理的请求')
        game.act(playerId, command.legalActionId)
        this.afterEngineStep(now)
        return null
      }

      case 'advance': {
        const game = this.game()
        if (game.state.currentPlayerId !== playerIdOf(seat.seatId)) throw new InvalidSgsCommandError('还没轮到你')
        game.advancePhase()
        this.afterEngineStep(now)
        return null
      }

      case 'trustee': {
        if (!this.state.game) throw new InvalidSgsCommandError('牌局还没有开始')
        seat.trustee = command.enabled
        this.touch(now)
        this.scheduleNext(now)
        return null
      }

      case 'next-round': {
        if (!this.state.game || this.state.game.status !== 'game-over') throw new InvalidSgsCommandError('这局还没结束')
        seat.nextRoundReady = true
        const waiting = this.state.seats.filter((candidate) => candidate.kind === 'human' && !candidate.leftRoom && !candidate.nextRoundReady)
        if (waiting.length === 0) this.startGame(now)
        else {
          this.pushJob({ kind: 'next-round-timeout', dueAt: now + NEXT_ROUND_TIMEOUT_MS })
          this.touch(now)
        }
        return null
      }

      case 'leave-room': {
        this.leave(userId, now)
        return null
      }

      default: {
        const exhaustive: never = command
        throw new InvalidSgsCommandError(`未知指令：${JSON.stringify(exhaustive)}`)
      }
    }
  }

  private assertHost(userId: string): void {
    if (userId !== this.state.hostUserId) throw new InvalidSgsCommandError('只有房主可以这么做')
  }

  private startGame(now: number): void {
    const occupied = this.state.seats.filter((seat) => seat.kind !== 'empty')
    if (occupied.length !== this.state.settings.playerCount) throw new InvalidSgsCommandError('还有空位没有坐满')
    const humans = occupied.filter((seat) => seat.kind === 'human' && !seat.leftRoom)
    if (humans.some((seat) => !seat.ready && !this.state.game)) throw new InvalidSgsCommandError('还有人没有准备')

    const seed = `${this.state.code}-${now}-${this.state.version}`
    const game = new SanguoshaGame({
      seed,
      setup: {
        mode: 'identity',
        /**
         * 候选武将数：**按人数平分整个武将池，上限 10**。
         *
         * 引擎的公式本来就是 `min(generalChoices, floor(池子 / 人数))`，
         * 所以这里给上限、平分由那个 min 自动完成。25 名武将下的实际结果：
         * 5 人各 5 个、6 人各 4 个、7 人各 3 个、8 人各 3 个。
         * 上限 10 现在碰不到（floor(25/5)=5 已是最大），是给扩包之后留的。
         */
        generalChoices: 10,
        players: occupied.map((seat) => ({
          id: playerIdOf(seat.seatId),
          nickname: seat.name,
          isHuman: seat.kind === 'human',
        })),
      },
    })
    game.dealGenerals()

    this.engine = game
    this.state.game = game.serialize()
    this.state.aiSeed = `ai:${seed}`
    this.state.aiRngState = 0
    this.state.suspicion = emptySuspicion(game.viewFor(playerIdOf(occupied[0].seatId)))
    this.state.log = {}
    this.state.presentationEvents = []
    this.state.jobs = []
    for (const seat of this.state.seats) {
      seat.ready = false
      seat.nextRoundReady = false
      // 上一局离场的人不带进新的一局
      if (seat.leftRoom) Object.assign(seat, emptySeat(seat.seatId))
    }
    this.attachObservers(game)
    this.afterEngineStep(now)
  }

  // —— 引擎推进 ——

  /**
   * 把战报和身份推断挂到引擎事件上。
   *
   * 每次 `SanguoshaGame.restore` 之后都要重新挂——事件处理器是运行时代码，序列化不了。
   */
  private attachObservers(game: SanguoshaGame): void {
    const logged = ['TurnStart', 'CardUsed', 'CardResponded', 'Damaged', 'Recover',
      'LoseHp', 'EnterDying', 'Death', 'JudgeResult', 'GainCard', 'LoseEquipment', 'CharacterFlip'] as const
    const presentationOnly = ['SkillActivated'] as const
    const observed = [...logged, ...presentationOnly] as const
    for (const name of observed) {
      game.events.on(name, (context) => {
        // 战报按人过滤（同一件事对不同人措辞不同），表现事件全公开，算一次就够
        for (const seat of this.state.seats) {
          if (seat.kind === 'empty') continue
          const viewerId = playerIdOf(seat.seatId)
          const text = describeEvent(game.state, context.event, viewerId)
          if (!text) continue
          const bucket = this.state.log[viewerId] ?? (this.state.log[viewerId] = [])
          bucket.push(text)
          if (bucket.length > LOG_MAX) bucket.splice(0, bucket.length - LOG_MAX)
        }
        const presentation = buildPresentationEvent(game.state, context.event)
        if (!presentation) return
        const events = this.state.presentationEvents ?? (this.state.presentationEvents = [])
        events.push(presentation)
        if (events.length > PRESENTATION_MAX) events.splice(0, events.length - PRESENTATION_MAX)
      })
    }
    for (const name of ['Damaged', 'Recover'] as const) {
      game.events.on(name, (context) => {
        const anySeat = this.state.seats.find((seat) => seat.kind !== 'empty')
        if (!anySeat) return
        observeEvent(this.state.suspicion, game.viewFor(playerIdOf(anySeat.seatId)), context.event)
      })
    }
  }

  /** 引擎往前走一步之后统一收尾：落盘、更新局面指纹、安排下一个定时任务。 */
  private afterEngineStep(now: number): void {
    const game = this.game()
    // 所有人都选完将就自动开局：起始手牌要等到这一刻才发，
    // 免得选将阶段就有人捏着私密手牌
    if (game.state.status === 'choosing-general' && game.state.pendingRequests.length === 0) {
      game.start()
    }
    // 准备、判定、摸牌、弃牌、结束阶段若没有请求，不需要真人额外点一次“继续”。
    // 服务端直接走到真正需要决定的出牌阶段或 Request，避免联机每个阶段白等一个超时。
    for (let guard = 0; guard < 24; guard += 1) {
      if (game.state.status !== 'playing' || game.state.pendingRequests.length > 0 || game.state.phase === 'play') break
      game.advancePhase()
    }
    this.state.game = game.serialize()
    this.state.stageKey = `${game.state.seq}:${game.state.pendingRequests[0]?.id ?? ''}:${game.state.currentPlayerId}:${game.state.phase}`
    this.touch(now)
    this.scheduleNext(now)
  }

  private pushJob(job: Omit<SgsJob, 'id' | 'stageKey'>): void {
    this.state.jobs.push({ ...job, id: `job-${this.state.version}-${this.state.jobs.length}`, stageKey: this.state.stageKey })
  }

  /**
   * 决定下一步该等谁。
   *
   * 只安排一个任务：要么等 AI 走，要么等真人超时。局面指纹变了之后旧任务自然作废。
   */
  private scheduleNext(now: number): void {
    if (!this.state.game) return
    this.state.jobs = this.state.jobs.filter((job) => job.kind === 'disconnect-trustee' || job.kind === 'next-round-timeout')
    // 选将阶段同样要安排任务，否则 AI 永远不选，房间停在选将界面
    if (this.state.game.status !== 'playing' && this.state.game.status !== 'choosing-general') return

    const actorSeatId = this.currentActorSeatId()
    if (actorSeatId === null) return
    const seat = this.state.seats.find((candidate) => candidate.seatId === actorSeatId)
    if (!seat) return

    const drivenByAI = seat.kind === 'ai' || seat.trustee || !seat.connected
    const choosing = this.state.game.status === 'choosing-general'
    const aiDelay = choosing ? AI_PICK_GENERAL_MS : AI_STEP_MS
    this.pushJob({
      kind: drivenByAI ? 'ai-step' : 'turn-timeout',
      dueAt: now + (drivenByAI ? aiDelay : this.humanWindowMs()),
      seatId: actorSeatId,
    })
  }

  /**
   * 真人这一步有多长时间。
   *
   * 默认是房间设置的操作时间；**无懈可击是例外**：它是一个「有没有无懈」的
   * 判断，没那么难决定，而一张多目标锦囊要问好几轮，30~60 秒一轮会把
   * 整桌人晾在那里。所以无懈按请求自带的窗口来（3 秒），
   * 但不会超过房间设置——房主把操作时间调到 15 秒时不该反而变长。
   */
  private humanWindowMs(): number {
    const setting = this.state.settings.turnSeconds * 1000
    const request = this.state.game?.pendingRequests[0]
    if (request?.kind === 'respond-card' && request.requiredCardName === '无懈可击') {
      return Math.min(setting, request.timeoutMs)
    }
    return setting
  }

  /** 现在轮到哪个座位做决定。没人要做决定时返回 null。 */
  private currentActorSeatId(): number | null {
    const state = this.state.game
    if (!state) return null
    const request = state.pendingRequests[0]
    if (request) return seatIdOf(request.playerId)
    if (state.status !== 'playing') return null
    return seatIdOf(state.currentPlayerId)
  }

  nextAlarmAt(): number | null {
    if (this.state.jobs.length === 0) return null
    return Math.min(...this.state.jobs.map((job) => job.dueAt))
  }

  /** 跑完所有到期任务。返回是否有状态变化。 */
  runDueJobs(now = Date.now()): boolean {
    let changed = false
    for (let guard = 0; guard < 200; guard += 1) {
      const due = this.state.jobs
        .filter((job) => job.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (!due) break
      this.state.jobs = this.state.jobs.filter((job) => job.id !== due.id)

      // 局面已经变了的超时任务直接作废，否则会误伤新局面
      if (due.kind !== 'disconnect-trustee' && due.stageKey !== this.state.stageKey) continue
      changed = this.runJob(due, now) || changed
    }
    return changed
  }

  private runJob(job: SgsJob, now: number): boolean {
    switch (job.kind) {
      case 'disconnect-trustee': {
        const seat = this.state.seats.find((candidate) => candidate.seatId === job.seatId)
        if (!seat || seat.connected) return false
        seat.trustee = true
        this.touch(now)
        this.scheduleNext(now)
        return true
      }

      case 'next-round-timeout': {
        if (this.state.game?.status !== 'game-over') return false
        this.startGame(now)
        return true
      }

      case 'ai-step':
      case 'turn-timeout': {
        // 超时和 AI 走子是同一件事：都由 AI 代做一步决定。
        // 区别只在于谁的时间到了。
        this.stepAI(now)
        return true
      }

      default: {
        const exhaustive: never = job.kind
        throw new Error(`未知任务：${exhaustive}`)
      }
    }
  }

  /** 让 AI 替当前该行动的人做一步。 */
  private stepAI(now: number): void {
    const game = this.game()
    if (game.state.status !== 'playing' && game.state.status !== 'choosing-general') return
    const aiRng = new GameRng(this.state.aiSeed, this.state.aiRngState || undefined)
    const contextFor = (playerId: PlayerId): AIContext => ({
      view: game.viewFor(playerId),
      difficulty: this.state.settings.difficulty,
      rng: aiRng,
      suspicion: this.state.suspicion,
    })

    try {
      const request = game.state.pendingRequests[0]
      if (request) {
        game.respond(decideResponse(contextFor(request.playerId), request))
      } else if (game.state.status !== 'playing') {
        // 选将期间没有请求就说明都选完了，交给 afterEngineStep 开局
        return
      } else if (game.state.phase === 'play') {
        const playerId = game.state.currentPlayerId
        const chosen = decidePlayAction(contextFor(playerId), game.legalActions(playerId))
        if (chosen) game.act(playerId, chosen.id)
        else game.advancePhase()
      } else {
        game.advancePhase()
      }
    } finally {
      this.state.aiRngState = aiRng.snapshot()
    }
    this.afterEngineStep(now)
  }

  // —— 视图 ——

  view(userId: string): SgsRoomView {
    const seat = this.state.seats.find((candidate) => candidate.userId === userId)
    const state = this.state.game
    const phase: SgsRoomView['phase'] = !state ? 'lobby' : state.status === 'game-over' ? 'finished' : 'playing'
    const actorSeatId = this.currentActorSeatId()
    const actorSeat = actorSeatId === null ? null : this.state.seats.find((candidate) => candidate.seatId === actorSeatId)
    const waitingJob = this.state.jobs.find((job) => job.kind === 'turn-timeout')

    let playerView: PlayerView | null = null
    if (state && seat && seat.kind === 'human') {
      // 每个连接只拿自己的视图，完整 GameState 不出这个文件
      playerView = this.game().viewFor(playerIdOf(seat.seatId))
    }

    return {
      code: this.state.code,
      version: this.state.version,
      phase,
      hostUserId: this.state.hostUserId,
      settings: this.state.settings,
      seats: this.state.seats.map(({ userId: seatUserId, ...rest }) => ({ ...rest, isSelf: seatUserId === userId })),
      playerView,
      chat: this.state.chat,
      log: seat ? (this.state.log[playerIdOf(seat.seatId)] ?? []) : [],
      presentationEvents: seat ? (this.state.presentationEvents ?? []) : [],
      deadlineAt: waitingJob ? waitingJob.dueAt : null,
      aiThinking: phase === 'playing' && !!actorSeat && (actorSeat.kind === 'ai' || actorSeat.trustee),
    }
  }

  shouldDeleteRoom(): boolean {
    return this.state.deleteRequested
  }

  /** 房间空置太久就该回收，避免 Durable Object 一直占着。 */
  isStale(now = Date.now(), maxIdleMs = 6 * 60 * 60_000): boolean {
    return now - this.state.updatedAt > maxIdleMs
  }
}
