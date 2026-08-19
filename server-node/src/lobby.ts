// 大厅。对应 Cloudflare 的 MahjongLobby 这个单例 DO：
// 推送房间列表变化，兼职存全局设置（托管档位、维护开关）和会话注册表（顶号用）。
// DO 的 storage 换成 SQLite 里的键值表，getWebSockets 换成一个连接集合。
import type { WebSocket } from 'ws'
import { SESSION_SUPERSEDED_CODE } from '../../src/online/types'
import type { D1Database } from './db'

interface SessionRecord {
  sessionId: string
  nickname: string
  at: number
}

export class Lobby {
  private readonly sockets = new Set<WebSocket>()
  private readonly owners = new WeakMap<WebSocket, string>()
  // 会话表读得很频繁（每次建房、每次连接都要验），放一份在内存里，落库只为重启后还认得
  private readonly sessions = new Map<string, SessionRecord>()
  private settings: Record<string, unknown> = {}
  private loaded = false

  constructor(private readonly db: D1Database) {}

  async load(): Promise<void> {
    if (this.loaded) return
    const rows = await this.db.prepare('SELECT key, value_json FROM lobby_state').all<{ key: string; value_json: string }>()
    for (const row of rows.results ?? []) {
      try {
        if (row.key === 'settings') this.settings = JSON.parse(row.value_json) as Record<string, unknown>
        else if (row.key.startsWith('session:')) {
          this.sessions.set(row.key.slice('session:'.length), JSON.parse(row.value_json) as SessionRecord)
        }
      } catch {
        // 单条坏了不影响其它，跳过
      }
    }
    this.loaded = true
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.db
      .prepare('INSERT INTO lobby_state (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
      .bind(key, JSON.stringify(value), Date.now())
      .run()
  }

  attach(socket: WebSocket, userId: string): void {
    this.sockets.add(socket)
    if (userId) this.owners.set(socket, userId)
  }

  detach(socket: WebSocket): void {
    this.sockets.delete(socket)
    this.owners.delete(socket)
  }

  handleMessage(socket: WebSocket, raw: string): void {
    // DO 那边是 setWebSocketAutoResponse 自动回 pong，这里手动回一下
    if (raw === 'ping' && socket.readyState === socket.OPEN) socket.send('pong')
  }

  // 房间列表变了就通知所有人重新拉一次
  notifyRoomsUpdated(): void {
    const message = JSON.stringify({ type: 'rooms-updated', at: Date.now() })
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message)
    }
  }

  async claimSession(userId: string, nickname: string, sessionId: string): Promise<void> {
    const record: SessionRecord = { sessionId, nickname, at: Date.now() }
    this.sessions.set(userId, record)
    await this.put(`session:${userId}`, record)
    // 同一个人挂在大厅的旧连接直接请出去，不然它还会继续收房间列表推送
    for (const socket of this.sockets) {
      if (this.owners.get(socket) !== userId || socket.readyState !== socket.OPEN) continue
      socket.send(JSON.stringify({ type: 'session-superseded' }))
      socket.close(SESSION_SUPERSEDED_CODE, '昵称已在别处登录')
    }
  }

  // 没记录说明这人还没在新版本上登录过，放行，免得上线那一刻把在场的人全踢了
  verifySession(userId: string, sessionId: string): boolean {
    const record = this.sessions.get(userId)
    return !record || record.sessionId === sessionId
  }

  readSettings(): Record<string, unknown> {
    return { ...this.settings }
  }

  async writeSettings(next: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.settings = next
    await this.put('settings', next)
    return { ...next }
  }
}
