import type { WebSocket } from 'ws'
import type { D1Database } from './db'
import { Lobby } from './lobby'
import { RoomRegistry } from './rooms'
import { RoomCoordinator } from '../../server/room-core'
import type { RoomUser, StoredRoomState } from '../../server/room-core'
import { ROOM_CLOSED_BY_ADMIN_CODE, ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE } from '../../src/online/types'
import type {
  OnlineRoomDirectoryEntry,
  OnlineRoomDirectoryPlayer,
  OnlineRoomSettings,
  RoomCommand,
  RoomServerMessage,
} from '../../src/online/types'

// 原来是 Cloudflare 的 Env（DO 命名空间 + D1）。这里换成本地实现，
// 但字段名保持不变，下面几百行路由代码就不用动。
export type { SessionPayload }

export interface Env {
  ROOMS: RoomRegistry
  LOBBY: Lobby
  DB: D1Database
  // 通过环境变量配置。没配置时管理接口整体不存在。
  ADMIN_TOKEN?: string
}

interface SocketAttachment extends RoomUser {
  leaving?: boolean
}

// 同一昵称拿到的是同一个 userId，所以光有 userId 分不出「谁是当前这次登录」。
// sessionId 就是干这个的：每次输昵称换一个，全局只认最新的那个。
interface SessionPayload extends RoomUser {
  sessionId: string
}

interface SessionRecord {
  sessionId: string
  nickname: string
  at: number
}

// 全局设置：托管 AI 档位、维护模式开关和提示文案。
// 放在 LOBBY 这个单例 Durable Object 里——建房时要读它，D1 每次都走网络太慢。
export interface ServerSettings {
  trusteeDifficulty: 'beginner' | 'standard' | 'expert'
  maintenance: boolean
  maintenanceMessage: string
}

const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  trusteeDifficulty: 'beginner',
  maintenance: false,
  maintenanceMessage: '服务器正在维护更新，暂时无法创建新房间，请稍后再来。',
}

function sanitizeServerSettings(input: Partial<ServerSettings>): ServerSettings {
  const difficulties = ['beginner', 'standard', 'expert']
  const message = typeof input.maintenanceMessage === 'string' ? input.maintenanceMessage.trim().slice(0, 120) : ''
  return {
    trusteeDifficulty: difficulties.includes(String(input.trusteeDifficulty))
      ? input.trusteeDifficulty as ServerSettings['trusteeDifficulty']
      : DEFAULT_SERVER_SETTINGS.trusteeDifficulty,
    maintenance: input.maintenance === true,
    maintenanceMessage: message || DEFAULT_SERVER_SETTINGS.maintenanceMessage,
  }
}

async function readServerSettings(env: Env): Promise<ServerSettings> {
  try {
    return sanitizeServerSettings(env.LOBBY.readSettings() as Partial<ServerSettings>)
  } catch {
    // 读不到就按默认放行：维护开关坏掉不该把正常游玩也堵死
    return { ...DEFAULT_SERVER_SETTINGS }
  }
}

async function writeServerSettings(env: Env, settings: ServerSettings): Promise<void> {
  await env.LOBBY.writeSettings(settings as unknown as Record<string, unknown>)
}

// 记下这次登录，并顺手关掉这个人还挂在大厅里的旧连接。
async function claimSession(env: Env, user: RoomUser, sessionId: string): Promise<void> {
  await env.LOBBY.claimSession(user.userId, user.nickname, sessionId)
}

// 校验一次会话是不是最新的。读不到注册表时一律放行：
// 注册表挂了不该把所有人挡在门外，顶号本来也只是防误操作，不是安全边界。
export async function sessionIsCurrent(env: Env, session: SessionPayload): Promise<boolean> {
  if (!session.sessionId) return true
  try {
    return env.LOBBY.verifySession(session.userId, session.sessionId)
  } catch {
    return true
  }
}

// 把这个人挂在各个房间里的旧连接踢掉。房间目录只存昵称，不过顶号本来就是按昵称算的。
// 私人局房间数是个位数，全表扫一遍的成本可以忽略。
async function evictRoomSessions(env: Env, user: RoomUser): Promise<void> {
  try {
    const rows = await env.DB.prepare('SELECT code, players_json FROM room_directory').all<{ code: string; players_json: string }>()
    for (const row of rows.results ?? []) {
      let players: Array<{ nickname?: unknown }> = []
      try {
        players = JSON.parse(row.players_json) as Array<{ nickname?: unknown }>
      } catch {
        continue
      }
      if (!players.some((player) => typeof player.nickname === 'string' && player.nickname === user.nickname)) continue
      const room = env.ROOMS.peek(row.code)
      if (room) room.evictUser(user.userId)
    }
  } catch (cause) {
    // 踢不掉旧连接不该让新登录失败：新连接照样能进，旧的最多多活一会儿
    console.error('顶号时清理旧连接失败', cause)
  }
}

const SESSION_SUPERSEDED_MESSAGE = '这个昵称已经在别的设备上登录了'

async function recordAudit(env: Env, action: string, target: string | null, detail: string): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO admin_audit (action, target, detail, created_at) VALUES (?, ?, ?, ?)')
      .bind(action, target, detail, Date.now())
      .run()
  } catch (cause) {
    // 审计写失败不该挡住管理操作本身
    console.error('写管理日志失败', cause)
  }
}

const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'


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

export function errorResponse(cause: unknown, fallbackStatus = 400): Response {
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

export function readSessionToken(request: Request): SessionPayload {
  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : new URL(request.url).searchParams.get('session') ?? ''
  if (!token) throw new Error('请先输入昵称')
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token))) as Partial<SessionPayload>
    if (typeof payload.userId !== 'string' || typeof payload.nickname !== 'string') throw new Error('invalid session')
    return {
      userId: payload.userId,
      nickname: normalizeNickname(payload.nickname),
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : '',
    }
  } catch {
    throw new Error('登录状态无效，请重新输入昵称')
  }
}

function roomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join('')
}

function sanitizeSettings(input: Partial<OnlineRoomSettings>, trusteeDifficulty?: OnlineRoomSettings['trusteeDifficulty']): OnlineRoomSettings {
  const claimWindowMs = [2000, 3000, 4000, 5000, 6000, 7000].includes(Number(input.claimWindowMs))
    ? Number(input.claimWindowMs)
    : 4000
  const difficulties = ['beginner', 'standard', 'expert']
  return {
    mode: input.mode === 'unlimited' ? 'unlimited' : 'finite',
    initialPoints: Math.max(1, Math.min(9999, Math.floor(Number(input.initialPoints) || 30))),
    claimWindowMs,
    turnWindowMs: 30_000,
    // 房主能选空位 AI 的档位；托管档位不接受客户端传入，只由服务端设置决定
    aiDifficulty: difficulties.includes(String(input.aiDifficulty)) ? input.aiDifficulty as OnlineRoomSettings['aiDifficulty'] : 'standard',
    trusteeDifficulty: trusteeDifficulty ?? 'beginner',
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { nickname?: unknown }
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
  // 同名只留一个在线：先把旧连接踢下去，再把新会话号发出去
  const sessionId = crypto.randomUUID()
  const identity: RoomUser = { userId: user.id, nickname: user.nickname }
  await claimSession(env, identity, sessionId)
  await evictRoomSessions(env, identity)
  const session: SessionPayload = { ...identity, sessionId }
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
  await recordAudit(env, 'delete-user', userId, `删除用户 ${user.nickname}`)
  return json({ ok: true, nickname: user.nickname })
}

async function adminResetUser(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(userId).first<{ nickname: string }>()
  if (!user) return json({ error: '用户不存在' }, 404)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_player_results WHERE user_id = ?').bind(userId),
    env.DB.prepare('UPDATE user_stats SET total_games = 0, wins = 0, seven_pairs = 0, gang_count = 0, ma_count = 0 WHERE user_id = ?').bind(userId),
  ])
  await recordAudit(env, 'reset-user', userId, `清空 ${user.nickname} 的战绩`)
  return json({ ok: true, nickname: user.nickname })
}

async function adminResetLeaderboard(env: Env): Promise<Response> {
  // 只清战绩，账号保留：下次用同一个昵称登录还是原来那个人，只是从零开始。
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_player_results'),
    env.DB.prepare('UPDATE user_stats SET total_games = 0, wins = 0, seven_pairs = 0, gang_count = 0, ma_count = 0'),
  ])
  await recordAudit(env, 'reset-leaderboard', null, '清空全部排行榜数据')
  return json({ ok: true })
}

// 房间目录表里已经存了每个房间的阶段、玩家和座位数，玩家接口只是做了截断和排序；
// 管理端要的是全量，外加创建时间。
async function adminRooms(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT code, phase, host_nickname, players_json, occupied_seats, mode, initial_points, claim_window_ms, updated_at
    FROM room_directory
    ORDER BY updated_at DESC
  `).all<{
    code: string
    phase: 'lobby' | 'playing'
    host_nickname: string
    players_json: string
    occupied_seats: number
    mode: string
    initial_points: number
    claim_window_ms: number
    updated_at: number
  }>()
  return json({
    rooms: result.results.map((row) => {
      let players: unknown[] = []
      try {
        const parsed = JSON.parse(row.players_json)
        if (Array.isArray(parsed)) players = parsed
      } catch { players = [] }
      return {
        code: row.code,
        phase: row.phase,
        hostNickname: row.host_nickname,
        players,
        occupiedSeats: row.occupied_seats,
        mode: row.mode,
        initialPoints: row.initial_points,
        claimWindowMs: row.claim_window_ms,
        updatedAt: row.updated_at,
      }
    }),
  })
}

async function adminDestroyRoom(env: Env, code: string): Promise<Response> {
  const room = env.ROOMS.peek(code)
  const destroyed = room ? await room.destroy() : null
  if (!destroyed) {
    // 房间实例可能已经没了，目录表里的残留记录还是要清掉
    await env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(code).run()
    return json({ ok: true, code, note: '房间已不存在，已清理目录记录' })
  }
  await recordAudit(env, 'destroy-room', code, '强制解散房间')
  return json({ ok: true, code })
}

async function adminAudit(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT action, target, detail, created_at FROM admin_audit ORDER BY created_at DESC LIMIT 100',
  ).all<{ action: string; target: string | null; detail: string; created_at: number }>()
  return json({
    entries: result.results.map((row) => ({
      action: row.action, target: row.target, detail: row.detail, createdAt: row.created_at,
    })),
  })
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
  if (request.method === 'GET' && url.pathname === '/api/admin/rooms') return adminRooms(env)
  if (request.method === 'GET' && url.pathname === '/api/admin/audit') return adminAudit(env)
  if (request.method === 'GET' && url.pathname === '/api/admin/settings') return json(await readServerSettings(env))
  if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
    const incoming = sanitizeServerSettings(await request.json() as Partial<ServerSettings>)
    await writeServerSettings(env, incoming)
    await recordAudit(env, 'update-settings', null,
      `托管档位=${incoming.trusteeDifficulty} 维护=${incoming.maintenance ? '开' : '关'}`)
    return json(incoming)
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/leaderboard/reset') return adminResetLeaderboard(env)
  const roomMatch = url.pathname.match(/^\/api\/admin\/rooms\/([A-Z0-9]{6})$/)
  if (request.method === 'DELETE' && roomMatch) return adminDestroyRoom(env, roomMatch[1])
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
  const user = readSessionToken(request)
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
    const mine = players.some((player) => player.kind === 'human' && player.nickname === user.nickname)
    return {
      code: row.code,
      phase: row.phase,
      // 自己本来就坐在里面的房间要能回去：刷新一下页面就被挡在门外，
      // 座位只能挂着托管，太亏了。服务端本来就允许原座位重连。
      rejoinable: mine,
      joinable: mine || (row.phase === 'lobby' && row.occupied_seats < 4),
      hostNickname: row.host_nickname,
      players,
      occupiedSeats: row.occupied_seats,
      availableSeats: Math.max(0, 4 - row.occupied_seats),
      settings: {
        mode: row.mode,
        initialPoints: row.initial_points,
        claimWindowMs: row.claim_window_ms,
        turnWindowMs: 30_000,
        // 目录表只存房间的公开摘要，档位不在里面；列表用不到，给默认值即可
        aiDifficulty: 'standard',
        trusteeDifficulty: 'beginner',
      },
      updatedAt: row.updated_at,
    }
  })
  return json({ rooms })
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const user = readSessionToken(request)
  if (!await sessionIsCurrent(env, user)) return json({ error: SESSION_SUPERSEDED_MESSAGE }, 409)
  const body = await request.json() as { settings?: Partial<OnlineRoomSettings> }
  const server = await readServerSettings(env)
  // 维护期间只拦「开新房」：正在打的牌局和重连都不受影响，中途被掐断太难受了
  if (server.maintenance) return json({ error: server.maintenanceMessage, maintenance: true }, 503)
  const settings = sanitizeSettings(body.settings ?? {}, server.trusteeDifficulty)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode()
    const room = env.ROOMS.get(code)
    // create 返回 false 说明这个号已经有牌局了，换一个再来
    if (room.create({ userId: user.userId, nickname: user.nickname }, settings)) {
      return json({ code }, 201)
    }
  }
  throw new Error('房间号生成失败，请重试')
}

export const SUPERSEDED_MESSAGE = SESSION_SUPERSEDED_MESSAGE

export async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204)
  const url = new URL(request.url)
  // 管理接口必须在所有玩家接口之前拦下，避免前缀写错时被后面的路由捡走。
  if (url.pathname.startsWith('/api/admin/')) return adminRoute(request, env, url)
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true })
  if (request.method === 'GET' && url.pathname === '/api/service') {
    const server = await readServerSettings(env)
    return json({ maintenance: server.maintenance, maintenanceMessage: server.maintenanceMessage })
  }
  if (request.method === 'POST' && url.pathname === '/api/session') return login(request, env)
  if (request.method === 'GET' && url.pathname === '/api/leaderboard') return leaderboard(env)
  if (request.method === 'GET' && url.pathname === '/api/rooms') return listRooms(request, env)
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env)
  return json({ error: '接口不存在' }, 404)
}
