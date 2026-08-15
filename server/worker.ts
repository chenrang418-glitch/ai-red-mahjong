/// <reference types="@cloudflare/workers-types" />

import { RoomCoordinator } from './room-core'
import type { RoomUser, StoredRoomState } from './room-core'
import type {
  OnlineRoomDirectoryEntry,
  OnlineRoomDirectoryPlayer,
  OnlineRoomSettings,
  RoomCommand,
  RoomServerMessage,
} from '../src/online/types'

interface Env {
  ROOMS: DurableObjectNamespace
  DB: D1Database
}

interface SocketAttachment extends RoomUser {
  leaving?: boolean
}

interface SessionPayload extends RoomUser {}

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function json(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  })
}

function errorResponse(cause: unknown, fallbackStatus = 400): Response {
  const message = cause instanceof Error ? cause.message : String(cause)
  return json({ error: message }, fallbackStatus)
}

function normalizeNickname(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入昵称')
  const nickname = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 12)
  if (!nickname) throw new Error('请输入昵称')
  return nickname
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function createSessionToken(payload: SessionPayload): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
}

function readSessionToken(request: Request): SessionPayload {
  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : new URL(request.url).searchParams.get('session') ?? ''
  if (!token) throw new Error('请先输入昵称')
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token))) as Partial<SessionPayload>
    if (typeof payload.userId !== 'string' || typeof payload.nickname !== 'string') throw new Error('invalid session')
    return { userId: payload.userId, nickname: normalizeNickname(payload.nickname) }
  } catch {
    throw new Error('登录状态无效，请重新输入昵称')
  }
}

function roomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('')
}

function sanitizeSettings(input: Partial<OnlineRoomSettings>): OnlineRoomSettings {
  const claimWindowMs = [2000, 3000, 4000, 5000, 6000, 7000].includes(Number(input.claimWindowMs))
    ? Number(input.claimWindowMs)
    : 4000
  return {
    mode: input.mode === 'unlimited' ? 'unlimited' : 'finite',
    initialPoints: Math.max(1, Math.min(9999, Math.floor(Number(input.initialPoints) || 30))),
    claimWindowMs,
    turnWindowMs: 30_000,
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ nickname?: unknown }>()
  const nickname = normalizeNickname(body.nickname)
  let user = await env.DB.prepare('SELECT id, nickname FROM users WHERE nickname = ? COLLATE NOCASE').bind(nickname).first<{ id: string; nickname: string }>()
  if (!user) {
    const userId = crypto.randomUUID()
    await env.DB.prepare('INSERT OR IGNORE INTO users (id, nickname, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .bind(userId, nickname, Date.now(), Date.now())
      .run()
    user = await env.DB.prepare('SELECT id, nickname FROM users WHERE nickname = ? COLLATE NOCASE').bind(nickname).first<{ id: string; nickname: string }>()
  }
  if (!user) throw new Error('昵称创建失败，请重试')
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), user.id),
    env.DB.prepare('INSERT OR IGNORE INTO user_stats (user_id) VALUES (?)').bind(user.id),
  ])
  const session: SessionPayload = { userId: user.id, nickname: user.nickname }
  return json({ token: createSessionToken(session), ...session })
}

async function leaderboard(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT
      u.id AS user_id,
      u.nickname AS nickname,
      s.total_games AS total_games,
      s.wins AS wins,
      CASE WHEN s.total_games = 0 THEN 0 ELSE CAST(s.wins AS REAL) / s.total_games END AS win_rate,
      s.seven_pairs AS seven_pairs,
      s.gang_count AS gang_count,
      s.ma_count AS ma_count
    FROM users u
    JOIN user_stats s ON s.user_id = u.id
    ORDER BY s.wins DESC, win_rate DESC, s.total_games DESC, s.seven_pairs DESC, s.gang_count DESC, s.ma_count DESC, u.created_at ASC
    LIMIT 100
  `).all<{
    user_id: string
    nickname: string
    total_games: number
    wins: number
    win_rate: number
    seven_pairs: number
    gang_count: number
    ma_count: number
  }>()
  return json({
    entries: result.results.map((row) => ({
      userId: row.user_id,
      nickname: row.nickname,
      totalGames: row.total_games,
      wins: row.wins,
      winRate: row.win_rate,
      sevenPairs: row.seven_pairs,
      gangCount: row.gang_count,
      maCount: row.ma_count,
    })),
  })
}

async function listRooms(request: Request, env: Env): Promise<Response> {
  readSessionToken(request)
  const cutoff = Date.now() - 12 * 60 * 60 * 1000
  const result = await env.DB.prepare(`
    SELECT
      code,
      host_nickname,
      players_json,
      occupied_seats,
      mode,
      initial_points,
      claim_window_ms,
      updated_at
    FROM room_directory
    WHERE updated_at >= ?
    ORDER BY updated_at DESC
    LIMIT 40
  `).bind(cutoff).all<{
    code: string
    host_nickname: string
    players_json: string
    occupied_seats: number
    mode: 'finite' | 'unlimited'
    initial_points: number
    claim_window_ms: number
    updated_at: number
  }>()
  const rooms: OnlineRoomDirectoryEntry[] = result.results.map((row) => {
    let players: OnlineRoomDirectoryPlayer[] = []
    try {
      const parsed = JSON.parse(row.players_json) as OnlineRoomDirectoryPlayer[]
      if (Array.isArray(parsed)) players = parsed
    } catch {
      players = []
    }
    return {
      code: row.code,
      hostNickname: row.host_nickname,
      players,
      occupiedSeats: row.occupied_seats,
      availableSeats: Math.max(0, 4 - row.occupied_seats),
      settings: {
        mode: row.mode,
        initialPoints: row.initial_points,
        claimWindowMs: row.claim_window_ms,
        turnWindowMs: 30_000,
      },
      updatedAt: row.updated_at,
    }
  })
  return json({ rooms })
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const user = readSessionToken(request)
  const body = await request.json<{ settings?: Partial<OnlineRoomSettings> }>()
  const settings = sanitizeSettings(body.settings ?? {})
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode()
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
    const response = await stub.fetch('https://room.internal/create', {
      method: 'POST',
      body: JSON.stringify({ code, user, settings }),
    })
    if (response.status === 201) return json({ code }, 201)
    if (response.status !== 409) return response
  }
  throw new Error('房间号生成失败，请重试')
}

async function roomSocket(request: Request, env: Env, code: string): Promise<Response> {
  const user = readSessionToken(request)
  const headers = new Headers(request.headers)
  headers.set('x-user-id', user.userId)
  headers.set('x-user-nickname', encodeURIComponent(user.nickname))
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
  return stub.fetch('https://room.internal/socket', { headers })
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204)
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true })
  if (request.method === 'POST' && url.pathname === '/api/session') return login(request, env)
  if (request.method === 'GET' && url.pathname === '/api/leaderboard') return leaderboard(env)
  if (request.method === 'GET' && url.pathname === '/api/rooms') return listRooms(request, env)
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env)
  const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/socket$/)
  if (request.method === 'GET' && socketMatch) return roomSocket(request, env, socketMatch[1])
  return json({ error: '接口不存在' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env)
    } catch (cause) {
      return errorResponse(cause)
    }
  },
}

export class MahjongRoom {
  private coordinator: RoomCoordinator | null = null
  private readonly ready: Promise<void>
  private readonly chatRate = new Map<string, number[]>()

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<StoredRoomState>('room')
      if (stored) this.coordinator = new RoomCoordinator(stored)
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready
    const url = new URL(request.url)
    if (url.pathname === '/create' && request.method === 'POST') {
      if (this.coordinator) return json({ error: '房间号已存在' }, 409)
      const body = await request.json<{ code: string; user: RoomUser; settings: OnlineRoomSettings }>()
      this.coordinator = RoomCoordinator.create(body.code, body.user, body.settings)
      await this.persist()
      this.state.waitUntil(this.syncRoomDirectory())
      return json({ code: body.code }, 201)
    }
    if (url.pathname === '/socket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!this.coordinator) return json({ error: '房间不存在或已经关闭' }, 404)
      const userId = request.headers.get('x-user-id') ?? ''
      const encodedNickname = request.headers.get('x-user-nickname') ?? ''
      const user: RoomUser = { userId, nickname: normalizeNickname(decodeURIComponent(encodedNickname)) }
      this.coordinator.connect(user)
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const attachment: SocketAttachment = user
      server.serializeAttachment(attachment)
      this.state.acceptWebSocket(server, [`user:${user.userId}`])
      await this.persist()
      if (!this.coordinator.state.game) this.state.waitUntil(this.syncRoomDirectory())
      this.broadcastState()
      return new Response(null, { status: 101, webSocket: client })
    }
    return json({ error: '房间接口不存在' }, 404)
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready
    if (!this.coordinator) return
    const user = socket.deserializeAttachment() as SocketAttachment | null
    if (!user) return this.send(socket, { type: 'error', message: '连接身份无效' })
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      if (text === 'ping') {
        socket.send('pong')
        return
      }
      const parsed = JSON.parse(text) as RoomCommand | { type: 'ping' }
      if (parsed.type === 'ping') {
        this.send(socket, { type: 'pong', at: Date.now() })
        return
      }
      if (parsed.type === 'leave-room') {
        socket.serializeAttachment({ ...user, leaving: true })
        if (this.coordinator.state.game) this.coordinator.disconnect(user.userId)
        else this.coordinator.removeLobbyUser(user.userId)
        if (await this.deleteEmptyLobby()) {
          socket.close(1000, 'left room')
          return
        }
        await this.persist()
        if (!this.coordinator.state.game) await this.syncRoomDirectory()
        this.broadcastState()
        socket.close(1000, 'left room')
        return
      }
      if (parsed.type === 'chat') this.assertChatRate(user.userId)
      const chatMessage = this.coordinator.handle(user.userId, parsed)
      await this.persist()
      if (parsed.type === 'start-game' || parsed.type === 'return-to-lobby') await this.syncRoomDirectory()
      await this.syncLeaderboard()
      if (chatMessage) this.broadcast({ type: 'chat', message: chatMessage })
      else this.broadcastState()
    } catch (cause) {
      this.send(socket, { type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      await this.sendState(socket, user.userId)
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready
    if (!this.coordinator) return
    const user = socket.deserializeAttachment() as SocketAttachment | null
    if (!user || user.leaving) return
    const remaining = this.state.getWebSockets(`user:${user.userId}`).filter((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN)
    const seat = this.coordinator.state.seats.find((candidate) => candidate.userId === user.userId)
    if (!seat) return
    if (remaining.length === 0 && seat.connected) this.coordinator.disconnect(user.userId)
    await this.persist()
    if (!this.coordinator.state.game) await this.syncRoomDirectory()
    this.broadcastState()
  }

  async alarm(): Promise<void> {
    await this.ready
    if (!this.coordinator) return
    const changed = this.coordinator.runDueJobs()
    if (await this.deleteEmptyLobby()) return
    await this.persist()
    if (changed) {
      await this.syncLeaderboard()
      if (!this.coordinator.state.game) await this.syncRoomDirectory()
      this.broadcastState()
    }
  }

  private async persist(): Promise<void> {
    if (!this.coordinator) return
    await this.state.storage.put('room', this.coordinator.snapshot())
    const alarmAt = this.coordinator.nextAlarmAt()
    if (alarmAt === null) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(alarmAt)
  }

  private async syncLeaderboard(): Promise<void> {
    if (!this.coordinator) return
    const results = this.coordinator.unrecordedLeaderboardResults()
    if (!results.length) return
    await this.env.DB.batch(results.map((result) => this.env.DB.prepare(`
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
    await this.persist()
  }

  private async syncRoomDirectory(): Promise<void> {
    if (!this.coordinator) return
    const room = this.coordinator.state
    try {
      if (room.game) {
        await this.env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(room.code).run()
        return
      }
      const humanSeats = room.seats.filter((seat) => seat.kind === 'human' && seat.userId)
      const host = humanSeats.find((seat) => seat.userId === room.hostUserId)
      if (!host) {
        await this.env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(room.code).run()
        return
      }
      const players: OnlineRoomDirectoryPlayer[] = humanSeats.map((seat) => ({
        nickname: seat.name,
        connected: seat.connected,
        isHost: seat.userId === room.hostUserId,
      }))
      await this.env.DB.prepare(`
        INSERT INTO room_directory
          (code, host_nickname, players_json, occupied_seats, mode, initial_points, claim_window_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          host_nickname = excluded.host_nickname,
          players_json = excluded.players_json,
          occupied_seats = excluded.occupied_seats,
          mode = excluded.mode,
          initial_points = excluded.initial_points,
          claim_window_ms = excluded.claim_window_ms,
          updated_at = excluded.updated_at
      `).bind(
        room.code,
        host.name,
        JSON.stringify(players),
        humanSeats.length,
        room.settings.mode,
        room.settings.initialPoints,
        room.settings.claimWindowMs,
        Date.now(),
      ).run()
    } catch (cause) {
      console.error('同步房间列表失败', cause)
    }
  }

  private async deleteEmptyLobby(): Promise<boolean> {
    if (!this.coordinator || this.coordinator.state.game) return false
    const hasHumanPlayers = this.coordinator.state.seats.some((seat) => seat.kind === 'human' && seat.userId)
    if (hasHumanPlayers) return false
    const code = this.coordinator.state.code
    this.coordinator = null
    await this.state.storage.deleteAll()
    await this.state.storage.deleteAlarm()
    try {
      await this.env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(code).run()
    } catch (cause) {
      console.error('移除空房间失败', cause)
    }
    return true
  }

  private assertChatRate(userId: string): void {
    const now = Date.now()
    const recent = (this.chatRate.get(userId) ?? []).filter((timestamp) => now - timestamp < 10_000)
    if (recent.length >= 5) throw new Error('发送太快了，请稍后再试')
    recent.push(now)
    this.chatRate.set(userId, recent)
  }

  private broadcastState(): void {
    if (!this.coordinator) return
    for (const socket of this.state.getWebSockets()) {
      const user = socket.deserializeAttachment() as SocketAttachment | null
      if (user && !user.leaving) this.sendState(socket, user.userId)
    }
  }

  private sendState(socket: WebSocket, userId: string): void {
    if (!this.coordinator || socket.readyState !== WebSocket.OPEN) return
    this.send(socket, { type: 'room-state', room: this.coordinator.view(userId) })
  }

  private broadcast(message: RoomServerMessage): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, message)
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
}
