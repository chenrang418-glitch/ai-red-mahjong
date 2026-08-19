// Durable Object 的替代品。
// Cloudflare 那边一个房间就是一个 DO 实例：自带隔离状态、WebSocket 集合和 alarm。
// 单机 Node 上不需要这套分布式机制，一个进程里用 Map 装房间实例就够，
// 但要把 DO 提供的三件事补上：状态持久化、连接集合、定时唤醒。
//
// 房间逻辑本身（RoomCoordinator，975 行）一行没改，直接从 server/room-core.ts 引进来。
import type { WebSocket } from 'ws'
import { RoomCoordinator } from '../../server/room-core'
import type { RoomUser, StoredRoomState } from '../../server/room-core'
import { ROOM_CLOSED_BY_ADMIN_CODE, SESSION_SUPERSEDED_CODE } from '../../src/online/types'
import type {
  OnlineRoomDirectoryPlayer,
  OnlineRoomSettings,
  RoomCommand,
  RoomServerMessage,
} from '../../src/online/types'
import type { D1Database } from './db'

const CHAT_RATE_LIMIT = 6
const CHAT_RATE_WINDOW_MS = 10_000

interface SocketAttachment extends RoomUser {
  leaving?: boolean
}

export interface RoomDeps {
  db: D1Database
  // 房间目录变了要通知大厅广播，等价于原来的 LOBBY DO fetch
  notifyLobby: () => void
}

export class RoomHost {
  private coordinator: RoomCoordinator | null = null
  private readonly sockets = new Set<WebSocket>()
  // DO 用 serializeAttachment 把身份挂在连接上，这里用一张表代替
  private readonly attachments = new WeakMap<WebSocket, SocketAttachment>()
  private readonly chatRate = new Map<string, number[]>()
  private alarmTimer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
    private readonly onDispose: (code: string) => void,
    stored?: StoredRoomState,
  ) {
    if (stored) {
      this.coordinator = new RoomCoordinator(stored)
      if (this.coordinator.ensureOfflineExpiry()) this.persist()
      this.scheduleAlarm()
    }
  }

  get isEmpty(): boolean {
    return !this.coordinator
  }

  get state(): StoredRoomState | null {
    return this.coordinator ? this.coordinator.state : null
  }

  create(user: RoomUser, settings: OnlineRoomSettings): boolean {
    if (this.coordinator) return false
    this.coordinator = RoomCoordinator.create(this.code, user, settings)
    this.persist()
    void this.syncRoomDirectory()
    this.scheduleAlarm()
    return true
  }

  // 握手前的准入判断。返回拒绝原因，null 表示可以进。
  tryConnect(user: RoomUser): string | null {
    if (!this.coordinator) return '房间不存在或已经关闭'
    try {
      this.coordinator.connect(user)
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }

  attach(socket: WebSocket, user: RoomUser): void {
    this.attachments.set(socket, { ...user })
    this.sockets.add(socket)
    this.persist()
    void this.syncRoomDirectory()
    this.broadcastState()
    this.scheduleAlarm()
  }

  async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    if (!this.coordinator) return
    const user = this.attachments.get(socket)
    if (!user) return this.send(socket, { type: 'error', message: '连接身份无效' })
    try {
      if (raw === 'ping') {
        socket.send('pong')
        return
      }
      const parsed = JSON.parse(raw) as RoomCommand | { type: 'ping' }
      if (parsed.type === 'ping') {
        this.send(socket, { type: 'pong', at: Date.now() })
        return
      }
      if (parsed.type === 'leave-room') {
        this.attachments.set(socket, { ...user, leaving: true })
        this.coordinator.leave(user.userId)
        await this.syncLeaderboard()
        if (await this.deleteRequestedRoom() || await this.deleteEmptyLobby()) {
          socket.close(1000, 'left room')
          return
        }
        this.persist()
        void this.syncRoomDirectory()
        this.broadcastState()
        socket.close(1000, 'left room')
        return
      }
      if (parsed.type === 'chat') this.assertChatRate(user.userId)
      const chatMessage = this.coordinator.handle(user.userId, parsed)
      this.persist()
      if (parsed.type === 'start-game' || parsed.type === 'return-to-lobby' || parsed.type === 'trustee') {
        void this.syncRoomDirectory()
      }
      await this.syncLeaderboard()
      if (chatMessage) this.broadcast({ type: 'chat', message: chatMessage })
      else this.broadcastState()
      this.scheduleAlarm()
    } catch (cause) {
      this.send(socket, { type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      this.sendState(socket, user.userId)
    }
  }

  handleClose(socket: WebSocket): void {
    const user = this.attachments.get(socket)
    this.sockets.delete(socket)
    this.attachments.delete(socket)
    if (!this.coordinator || !user || user.leaving) return
    // 同一个人可能开了多个连接，全断了才算掉线
    const remaining = [...this.sockets].filter((candidate) => {
      const other = this.attachments.get(candidate)
      return other && other.userId === user.userId && candidate.readyState === candidate.OPEN
    })
    const seat = this.coordinator.state.seats.find((candidate) => candidate.userId === user.userId)
    if (!seat) return
    if (remaining.length === 0 && seat.connected) this.coordinator.disconnect(user.userId)
    this.persist()
    void this.syncRoomDirectory()
    this.broadcastState()
    this.scheduleAlarm()
  }

  // 顶号：把这个人挂在本房间的连接全部请出去
  evictUser(userId: string): void {
    for (const socket of this.socketsOf(userId)) {
      this.send(socket, { type: 'error', message: '这个昵称已经在别的设备上登录了' })
      socket.close(SESSION_SUPERSEDED_CODE, '昵称已在别处登录')
    }
  }

  // 管理员强制解散
  async destroy(): Promise<string | null> {
    if (!this.coordinator) return null
    const code = this.coordinator.state.code
    for (const socket of this.sockets) {
      if (socket.readyState !== socket.OPEN) continue
      this.send(socket, { type: 'error', message: '房间已被管理员关闭' })
      socket.close(ROOM_CLOSED_BY_ADMIN_CODE, '房间已被管理员关闭')
    }
    await this.deleteRoom()
    return code
  }

  private socketsOf(userId: string): WebSocket[] {
    return [...this.sockets].filter((socket) => {
      const attachment = this.attachments.get(socket)
      return attachment && attachment.userId === userId && socket.readyState === socket.OPEN
    })
  }

  // —— 定时唤醒。DO 的 storage.setAlarm 换成 setTimeout ——
  private scheduleAlarm(): void {
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer)
      this.alarmTimer = null
    }
    if (this.disposed || !this.coordinator) return
    const alarmAt = this.coordinator.nextAlarmAt()
    if (alarmAt === null) return
    const delay = Math.max(0, alarmAt - Date.now())
    this.alarmTimer = setTimeout(() => {
      this.alarmTimer = null
      void this.runAlarm()
    }, delay)
    // 定时器不应该拖住进程退出
    if (typeof this.alarmTimer.unref === 'function') this.alarmTimer.unref()
  }

  private async runAlarm(): Promise<void> {
    if (!this.coordinator) return
    const directoryBefore = this.directorySignature()
    let changed = false
    try {
      changed = this.coordinator.runDueJobs()
    } catch (cause) {
      // 一次定时任务失败不能让房间再也不被唤醒，记录后继续排下一次
      console.error('房间定时唤醒失败', this.code, cause)
      changed = true
    }
    if (await this.deleteRequestedRoom() || await this.deleteEmptyLobby()) return
    this.persist()
    if (changed) {
      await this.syncLeaderboard()
      if (directoryBefore !== this.directorySignature()) void this.syncRoomDirectory()
      this.broadcastState()
    }
    this.scheduleAlarm()
  }

  // —— 持久化。DO 的 storage 换成一张表 ——
  private persist(): void {
    if (!this.coordinator) return
    void this.deps.db
      .prepare('INSERT INTO room_state (code, snapshot_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at')
      .bind(this.code, JSON.stringify(this.coordinator.snapshot()), Date.now())
      .run()
      .catch((cause: unknown) => console.error('房间状态保存失败', this.code, cause))
  }

  private async deleteRequestedRoom(): Promise<boolean> {
    if (!this.coordinator || !this.coordinator.shouldDeleteRoom()) return false
    await this.deleteRoom()
    return true
  }

  private async deleteEmptyLobby(): Promise<boolean> {
    if (!this.coordinator) return false
    const room = this.coordinator.state
    if (room.game) return false
    const humans = room.seats.filter((seat) => seat.kind === 'human' && seat.userId)
    if (humans.length > 0) return false
    await this.deleteRoom()
    return true
  }

  private async deleteRoom(): Promise<void> {
    this.disposed = true
    if (this.alarmTimer) {
      clearTimeout(this.alarmTimer)
      this.alarmTimer = null
    }
    this.coordinator = null
    try {
      await this.deps.db.prepare('DELETE FROM room_state WHERE code = ?').bind(this.code).run()
      await this.deps.db.prepare('DELETE FROM room_directory WHERE code = ?').bind(this.code).run()
    } catch (cause) {
      console.error('房间清理失败', this.code, cause)
    }
    this.deps.notifyLobby()
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.close(1000, 'room closed')
    }
    this.sockets.clear()
    this.onDispose(this.code)
  }

  private async syncLeaderboard(): Promise<void> {
    if (!this.coordinator) return
    // 中途换成 AI 的人，本局那条战绩要撤掉。放在写入之前跑：
    // 万一他是本局刚记完之后走的，这里正好把已经落库的那条删掉。
    const cleanups = this.coordinator.takeStatCleanups()
    if (cleanups.length) {
      await this.deps.db.batch(cleanups.map((cleanup) => this.deps.db.prepare(
        'DELETE FROM round_player_results WHERE match_id = ? AND round_number = ? AND user_id = ?',
      ).bind(cleanup.matchId, cleanup.round, cleanup.userId)))
      this.persist()
    }
    const results = this.coordinator.unrecordedLeaderboardResults()
    if (!results.length) return
    await this.deps.db.batch(results.map((result) => this.deps.db.prepare(`
      INSERT OR IGNORE INTO round_player_results
        (match_id, round_number, user_id, won, seven_pairs, gang_count, ma_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      result.matchId,
      result.round,
      result.userId,
      result.won,
      result.sevenPairs,
      result.gangCount,
      result.maCount,
      Date.now(),
    )))
    this.coordinator.markRoundRecorded(results[0].matchId, results[0].round)
    this.persist()
  }

  private directorySignature(): string {
    if (!this.coordinator) return ''
    const room = this.coordinator.state
    return [
      room.game ? 'playing' : 'lobby',
      room.seats.map((seat) => `${seat.kind}:${seat.name}:${seat.connected ? 1 : 0}:${seat.trustee ? 1 : 0}`).join('|'),
    ].join('#')
  }

  private async syncRoomDirectory(): Promise<void> {
    if (!this.coordinator) return
    const room = this.coordinator.state
    try {
      const humanSeats = room.seats.filter((seat) => seat.kind === 'human' && seat.userId)
      const host = humanSeats.find((seat) => seat.userId === room.hostUserId)
      if (!host) {
        await this.deps.db.prepare('DELETE FROM room_directory WHERE code = ?').bind(room.code).run()
        this.deps.notifyLobby()
        return
      }
      const directorySeats = room.game
        ? room.seats.filter((seat) => seat.kind !== 'empty')
        : humanSeats
      const players: OnlineRoomDirectoryPlayer[] = directorySeats.map((seat) => ({
        nickname: seat.name,
        connected: seat.connected,
        isHost: seat.userId === room.hostUserId,
        kind: seat.kind === 'ai' ? 'ai' : 'human',
        trustee: seat.trustee,
      }))
      await this.deps.db.prepare(`
        INSERT INTO room_directory
          (code, phase, host_nickname, players_json, occupied_seats, mode, initial_points, claim_window_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          phase = excluded.phase,
          host_nickname = excluded.host_nickname,
          players_json = excluded.players_json,
          occupied_seats = excluded.occupied_seats,
          mode = excluded.mode,
          initial_points = excluded.initial_points,
          claim_window_ms = excluded.claim_window_ms,
          updated_at = excluded.updated_at
      `).bind(
        room.code,
        room.game ? 'playing' : 'lobby',
        host.name,
        JSON.stringify(players),
        directorySeats.length,
        room.settings.mode,
        room.settings.initialPoints,
        room.settings.claimWindowMs,
        Date.now(),
      ).run()
      this.deps.notifyLobby()
    } catch (cause) {
      console.error('房间目录同步失败', this.code, cause)
    }
  }

  private assertChatRate(userId: string): void {
    const now = Date.now()
    const history = (this.chatRate.get(userId) ?? []).filter((at) => now - at < CHAT_RATE_WINDOW_MS)
    if (history.length >= CHAT_RATE_LIMIT) throw new Error('说得太快了，歇一会儿')
    history.push(now)
    this.chatRate.set(userId, history)
  }

  private broadcastState(): void {
    if (!this.coordinator) return
    for (const socket of this.sockets) {
      const user = this.attachments.get(socket)
      if (user && !user.leaving) this.sendState(socket, user.userId)
    }
  }

  private sendState(socket: WebSocket, userId: string): void {
    if (!this.coordinator || socket.readyState !== socket.OPEN) return
    // 已经宣布离开的连接不再接收房间状态，否则出错回执那条路径会把人又「送回」房间
    const attachment = this.attachments.get(socket)
    if (attachment && attachment.leaving) return
    this.send(socket, { type: 'room-state', room: this.coordinator.view(userId) })
  }

  private broadcast(message: RoomServerMessage): void {
    for (const socket of this.sockets) this.send(socket, message)
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }
}

// 房间登记处。等价于 DurableObjectNamespace：按房间号找到（或恢复出）那个房间实例。
export class RoomRegistry {
  private readonly rooms = new Map<string, RoomHost>()

  constructor(private readonly deps: RoomDeps) {}

  // 进程重启后房间要能从库里活过来，否则一次部署就把所有牌局清了
  async restoreAll(): Promise<number> {
    const rows = await this.deps.db
      .prepare('SELECT code, snapshot_json FROM room_state')
      .all<{ code: string; snapshot_json: string }>()
    let restored = 0
    for (const row of rows.results ?? []) {
      try {
        const stored = JSON.parse(row.snapshot_json) as StoredRoomState
        this.rooms.set(row.code, new RoomHost(row.code, this.deps, (code) => this.rooms.delete(code), stored))
        restored += 1
      } catch (cause) {
        console.error('房间恢复失败，丢弃', row.code, cause)
        await this.deps.db.prepare('DELETE FROM room_state WHERE code = ?').bind(row.code).run()
      }
    }
    return restored
  }

  get(code: string): RoomHost {
    const existing = this.rooms.get(code)
    if (existing) return existing
    const created = new RoomHost(code, this.deps, (target) => this.rooms.delete(target))
    this.rooms.set(code, created)
    return created
  }

  peek(code: string): RoomHost | null {
    return this.rooms.get(code) ?? null
  }

  all(): RoomHost[] {
    return [...this.rooms.values()]
  }

  // 顶号时要扫所有房间，把这个人的旧连接踢掉
  evictUser(userId: string): void {
    for (const room of this.rooms.values()) room.evictUser(userId)
  }
}
