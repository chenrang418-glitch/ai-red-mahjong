/// <reference types="@cloudflare/workers-types" />

import { RoomCoordinator } from './room-core'
import type { RoomUser, StoredRoomState } from './room-core'
import { ROOM_REJECT_CLOSE_CODE } from '../src/online/types'
import type {
  OnlineRoomDirectoryEntry,
  OnlineRoomDirectoryPlayer,
  OnlineRoomSettings,
  RoomCommand,
  RoomServerMessage,
} from '../src/online/types'

interface Env {
  ROOMS: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
  DB: D1Database
  // 通过 wrangler secret 单独配置。没配置时管理接口整体不存在。
  ADMIN_TOKEN?: string
}

interface SocketAttachment extends RoomUser {
  leaving?: boolean
}

interface SessionPayload extends RoomUser {}

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

function rejectSocket(reason: string): Response {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  server.send(JSON.stringify({ type: 'error', message: reason }))
  // close reason 上限 123 字节，中文按 3 字节算最多 40 字。
  server.close(ROOM_REJECT_CLOSE_CODE, reason.slice(0, 40))
  return new Response(null, { status: 101, webSocket: client })
}

function json(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
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

// —— 管理接口 ——
// 三条硬规则：
// 1. 没配置 ADMIN_TOKEN 时，这些接口一律当作不存在；
// 2. token 不对也返回 404 而不是 401，避免让人从状态码判断「这里有管理入口」；
// 3. token 只从请求头读，不接受 URL 查询参数，免得跟着链接、日志、浏览器历史泄露出去。
const NOT_FOUND = () => json({ error: '接口不存在' }, 404)

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return diff === 0
}

function isAdmin(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN?.trim()
  if (!expected) return false
  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return false
  return timingSafeEqual(authorization.slice(7).trim(), expected)
}

async function adminUsers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT
      u.id AS user_id,
      u.nickname AS nickname,
      u.created_at AS created_at,
      u.last_seen_at AS last_seen_at,
      COALESCE(s.total_games, 0) AS total_games,
      COALESCE(s.wins, 0) AS wins,
      COALESCE(s.seven_pairs, 0) AS seven_pairs,
      COALESCE(s.gang_count, 0) AS gang_count,
      COALESCE(s.ma_count, 0) AS ma_count
    FROM users u
    LEFT JOIN user_stats s ON s.user_id = u.id
    ORDER BY u.last_seen_at DESC
    LIMIT 500
  `).all<{
    user_id: string
    nickname: string
    created_at: number
    last_seen_at: number
    total_games: number
    wins: number
    seven_pairs: number
    gang_count: number
    ma_count: number
  }>()
  return json({
    users: result.results.map((row) => ({
      userId: row.user_id,
      nickname: row.nickname,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      totalGames: row.total_games,
      wins: row.wins,
      sevenPairs: row.seven_pairs,
      gangCount: row.gang_count,
      maCount: row.ma_count,
    })),
  })
}

async function adminDeleteUser(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(userId).first<{ nickname: string }>()
  if (!user) return json({ error: '用户不存在' }, 404)
  // round_player_results 和 user_stats 都有 ON DELETE CASCADE，删用户会一并清掉。
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
  return json({ ok: true, nickname: user.nickname })
}

async function adminResetUser(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(userId).first<{ nickname: string }>()
  if (!user) return json({ error: '用户不存在' }, 404)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_player_results WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE user_stats SET total_games = 0, wins = 0, seven_pairs = 0, gang_count = 0, ma_count = 0 WHERE user_id = ?').bind(userId),
  ])
  return json({ ok: true, nickname: user.nickname })
}

async function adminResetLeaderboard(env: Env): Promise<Response> {
  // 只清战绩，账号保留：下次用同一个昵称登录还是原来那个人，只是从零开始。
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_player_results'),
    env.DB.prepare('UPDATE user_stats SET total_games = 0, wins = 0, seven_pairs = 0, gang_count = 0, ma_count = 0'),
  ])
  return json({ ok: true })
}

async function adminRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAdmin(request, env)) {
    // 对外一律 404，但在 Worker 日志里留下够定位的线索（`wrangler tail` 可见）。
    // 只记形状不记内容：有没有配密钥、请求有没有带密钥、两边长度差多少，
    // 足以区分「服务器没配」「请求没带」「值不一样」，又不会把密钥写进日志。
    const configured = (env.ADMIN_TOKEN ?? '').trim()
    const authorization = request.headers.get('authorization') ?? ''
    const presented = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    console.log('admin rejected', JSON.stringify({
      path: url.pathname,
      serverHasToken: configured.length > 0,
      serverTokenLength: configured.length,
      requestHasAuthHeader: authorization.length > 0,
      requestUsesBearer: authorization.startsWith('Bearer '),
      presentedLength: presented.length,
      lengthMatches: presented.length === configured.length,
    }))
    return NOT_FOUND()
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/session') return json({ ok: true })
  if (request.method === 'GET' && url.pathname === '/api/admin/users') return adminUsers(env)
  if (request.method === 'POST' && url.pathname === '/api/admin/leaderboard/reset') return adminResetLeaderboard(env)
  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-fA-F-]{36})$/)
  if (request.method === 'DELETE' && userMatch) return adminDeleteUser(env, userMatch[1])
  const resetMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-fA-F-]{36})\/reset$/)
  if (request.method === 'POST' && resetMatch) return adminResetUser(env, resetMatch[1])
  return NOT_FOUND()
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
  const result = await env.DB.prepare(`
    SELECT
      code,
      phase,
      host_nickname,
      players_json,
      occupied_seats,
      mode,
      initial_points,
      claim_window_ms,
      updated_at
    FROM room_directory
    ORDER BY CASE phase WHEN 'lobby' THEN 0 ELSE 1 END, updated_at DESC
    LIMIT 40
  `).all<{
    code: string
    phase: 'lobby' | 'playing'
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
      if (Array.isArray(parsed)) {
        players = parsed.map((player) => ({
          ...player,
          kind: player.kind === 'ai' ? 'ai' : 'human',
          trustee: Boolean(player.trustee),
        }))
      }
    } catch {
      players = []
    }
    return {
      code: row.code,
      phase: row.phase,
      joinable: row.phase === 'lobby' && row.occupied_seats < 4,
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

async function lobbySocket(request: Request, env: Env): Promise<Response> {
  readSessionToken(request)
  const stub = env.LOBBY.get(env.LOBBY.idFromName('global-directory'))
  return stub.fetch('https://lobby.internal/socket', { headers: request.headers })
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
  // 管理接口必须在所有玩家接口之前拦下，避免前缀写错时被后面的路由捡走。
  if (url.pathname.startsWith('/api/admin/')) return adminRoute(request, env, url)
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true })
  if (request.method === 'POST' && url.pathname === '/api/session') return login(request, env)
  if (request.method === 'GET' && url.pathname === '/api/leaderboard') return leaderboard(env)
  if (request.method === 'GET' && url.pathname === '/api/rooms') return listRooms(request, env)
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env)
  if (request.method === 'GET' && url.pathname === '/api/lobby/socket') return lobbySocket(request, env)
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
      if (stored) {
        this.coordinator = new RoomCoordinator(stored)
        if (this.coordinator.ensureOfflineExpiry()) await this.persist()
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready
    if (this.coordinator?.shouldDeleteRoom()) await this.deleteRoom()
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
      const userId = request.headers.get('x-user-id') ?? ''
      const encodedNickname = request.headers.get('x-user-nickname') ?? ''
      const user: RoomUser = { userId, nickname: normalizeNickname(decodeURIComponent(encodedNickname)) }
      // 房间不存在、满员、牌局已开始这些情况，握手前直接失败客户端只会看到「连接中断」并无限重连，
      // 所以先接受连接，再用专用关闭码把真实原因送到前端。
      const rejection = !this.coordinator ? '房间不存在或已经关闭' : this.tryConnect(user)
      if (rejection) return rejectSocket(rejection)
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      const attachment: SocketAttachment = user
      server.serializeAttachment(attachment)
      this.state.acceptWebSocket(server, [`user:${user.userId}`])
      await this.persist()
      this.state.waitUntil(this.syncRoomDirectory())
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
        this.coordinator.leave(user.userId)
        if (await this.deleteRequestedRoom() || await this.deleteEmptyLobby()) {
          socket.close(1000, 'left room')
          return
        }
        await this.persist()
        this.state.waitUntil(this.syncRoomDirectory())
        this.broadcastState()
        socket.close(1000, 'left room')
        return
      }
      if (parsed.type === 'chat') this.assertChatRate(user.userId)
      const chatMessage = this.coordinator.handle(user.userId, parsed)
      await this.persist()
      if (parsed.type === 'start-game' || parsed.type === 'return-to-lobby' || parsed.type === 'trustee') {
        this.state.waitUntil(this.syncRoomDirectory())
      }
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
    this.state.waitUntil(this.syncRoomDirectory())
    this.broadcastState()
  }

  private tryConnect(user: RoomUser): string | null {
    try {
      this.coordinator!.connect(user)
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }

  async alarm(): Promise<void> {
    await this.ready
    if (!this.coordinator) return
    const directoryBefore = this.directorySignature()
    let changed = false
    try {
      changed = this.coordinator.runDueJobs()
    } catch (cause) {
      // alarm 抛异常会让整个房间不再被唤醒，宁可记录后继续保存状态并重排下一次唤醒。
      console.error('房间定时唤醒失败', cause)
      changed = true
    }
    if (await this.deleteRequestedRoom() || await this.deleteEmptyLobby()) return
    await this.persist()
    if (changed) {
      await this.syncLeaderboard()
      if (directoryBefore !== this.directorySignature()) this.state.waitUntil(this.syncRoomDirectory())
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
      const humanSeats = room.seats.filter((seat) => seat.kind === 'human' && seat.userId)
      const host = humanSeats.find((seat) => seat.userId === room.hostUserId)
      if (!host) {
        await this.env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(room.code).run()
        await this.notifyLobbyDirectory()
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
      await this.env.DB.prepare(`
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
      await this.notifyLobbyDirectory()
    } catch (cause) {
      console.error('同步房间列表失败', cause)
    }
  }

  private async deleteEmptyLobby(): Promise<boolean> {
    if (!this.coordinator || this.coordinator.state.game) return false
    const hasHumanPlayers = this.coordinator.state.seats.some((seat) => seat.kind === 'human' && seat.userId)
    if (hasHumanPlayers) return false
    await this.deleteRoom()
    return true
  }

  private async deleteRequestedRoom(): Promise<boolean> {
    if (!this.coordinator?.shouldDeleteRoom()) return false
    await this.deleteRoom()
    return true
  }

  private async deleteRoom(): Promise<void> {
    if (!this.coordinator) return
    const code = this.coordinator.state.code
    this.coordinator = null
    await this.state.storage.deleteAll()
    await this.state.storage.deleteAlarm()
    try {
      await this.env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(code).run()
      await this.notifyLobbyDirectory()
    } catch (cause) {
      console.error('移除房间失败', cause)
    }
    for (const socket of this.state.getWebSockets()) socket.close(1000, 'room deleted')
  }

  private async notifyLobbyDirectory(): Promise<void> {
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName('global-directory'))
    await stub.fetch('https://lobby.internal/notify', { method: 'POST' })
  }

  private directorySignature(): string {
    if (!this.coordinator) return ''
    const room = this.coordinator.state
    return JSON.stringify({
      phase: room.game ? 'playing' : 'lobby',
      hostUserId: room.hostUserId,
      seats: room.seats.map((seat) => [seat.kind, seat.userId, seat.connected, seat.trustee]),
    })
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
    // 已经宣布离开的连接不再接收房间状态，否则出错回执那条路径会把人又「送回」房间。
    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (attachment?.leaving) return
    this.send(socket, { type: 'room-state', room: this.coordinator.view(userId) })
  }

  private broadcast(message: RoomServerMessage): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, message)
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
}

export class MahjongLobby {
  constructor(private readonly state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/socket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.state.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (url.pathname === '/notify' && request.method === 'POST') {
      const message = JSON.stringify({ type: 'rooms-updated', at: Date.now() })
      for (const socket of this.state.getWebSockets()) {
        if (socket.readyState === WebSocket.OPEN) socket.send(message)
      }
      return json(null, 204)
    }
    return json({ error: '大厅接口不存在' }, 404)
  }
}
