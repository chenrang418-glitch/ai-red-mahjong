/// <reference types="@cloudflare/workers-types" />
import { InvalidRoomCommandError, parseRoomCommand } from './command-parser'
import { InvalidSgsWireCommandError, parseSgsRoomCommand } from './sanguosha-command-parser'
import { SESSION_MAX_AGE_SECONDS, resolveStoredSession } from './session-policy'

import { RoomCoordinator } from './room-core'
import type { RoomUser, StoredRoomState } from './room-core'
import {
  SanguoshaRoomCoordinator,
  PRODUCTION_SGS_ROOM_TIMING,
  TEST_SGS_ROOM_TIMING,
  normalizeSettings as normalizeSgsSettings,
  type SgsRoomSettings,
  type StoredSgsRoomState,
  DuplicateSgsActionError,
} from './sanguosha-room-core'
import { ROOM_CLOSED_BY_ADMIN_CODE, ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE } from '../src/online/types'
import type {
  OnlineRoomDirectoryEntry,
  OnlineRoomDirectoryPlayer,
  OnlineRoomSettings,
  RoomServerMessage,
} from '../src/online/types'

interface Env {
  ROOMS: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
  SGS_ROOMS: DurableObjectNamespace
  DB: D1Database
  // 通过 wrangler secret 单独配置。没配置时管理接口整体不存在。
  ADMIN_TOKEN?: string
  /** 仅测试环境显式绑定；生产 wrangler 配置不设置。 */
  SGS_AI_PACING?: string
}

interface SocketAttachment extends RoomUser {
  leaving?: boolean
}

interface SessionRecord extends RoomUser {
  sessionId: string
  at: number
}

const SESSION_COOKIE = 'mahjong_session'


/**
 * 全局设置：托管 AI 档位、两级维护开关和公告文案。
 * 放在 LOBBY 这个单例 Durable Object 里——建房时要读它，D1 每次都走网络太慢。
 *
 * **两级维护是两件事，不要合并：**
 *
 * - `maintenance`（轻）：只拦「开新房」。正在打的牌局和重连不受影响，
 *   中途被掐断太难受了。两款游戏共用这一个开关。
 * - `siteClosed`（重）：整站停服。玩家打开网址只看到一段红色提示，
 *   所有玩家接口一律 503。**管理接口和 /api/service 必须继续放行**，
 *   否则开关一开就再也关不掉了。
 *
 * `notice` 是常驻公告，和上面两个开关**互不依赖**：非空就一直显示在
 * 游戏中心和两款游戏的顶部，用来提前预告维护时间之类。
 */
export interface ServerSettings {
  trusteeDifficulty: 'beginner' | 'standard' | 'expert'
  maintenance: boolean
  maintenanceMessage: string
  siteClosed: boolean
  siteClosedMessage: string
  notice: string
  /**
   * 「联系开发者」弹窗展示的联系方式，管理员在后台填，不写死在前端代码里。
   * 拆成「方式」（QQ / 微信 / 邮箱……这类标签）和「号码」两个字段，
   * 而不是一整条自由文本——「复制」按钮只该复制号码本身，
   * 不能把「QQ：」这个标签也一起复制进用户的粘贴板。
   */
  contactMethod: string
  contactValue: string
}

const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  trusteeDifficulty: 'beginner',
  maintenance: false,
  maintenanceMessage: '服务器正在维护更新，暂时无法创建新房间，请稍后再来。',
  siteClosed: false,
  siteClosedMessage: '全站正在维护升级，暂时无法访问，请稍后再来。',
  notice: '',
  contactMethod: 'QQ',
  contactValue: '1507394636',
}

/** 公告和提示语都是纯文本，长度设上限，避免管理端塞一整篇进来把界面撑坏。 */
function sanitizeText(input: unknown, limit: number): string {
  return typeof input === 'string' ? input.trim().slice(0, limit) : ''
}

function sanitizeServerSettings(input: Partial<ServerSettings>): ServerSettings {
  const difficulties = ['beginner', 'standard', 'expert']
  const message = sanitizeText(input.maintenanceMessage, 120)
  const closedMessage = sanitizeText(input.siteClosedMessage, 200)
  const contactMethod = sanitizeText(input.contactMethod, 20)
  const contactValue = sanitizeText(input.contactValue, 60)
  return {
    trusteeDifficulty: difficulties.includes(String(input.trusteeDifficulty))
      ? input.trusteeDifficulty as ServerSettings['trusteeDifficulty']
      : DEFAULT_SERVER_SETTINGS.trusteeDifficulty,
    maintenance: input.maintenance === true,
    maintenanceMessage: message || DEFAULT_SERVER_SETTINGS.maintenanceMessage,
    siteClosed: input.siteClosed === true,
    siteClosedMessage: closedMessage || DEFAULT_SERVER_SETTINGS.siteClosedMessage,
    // 公告允许为空：空就是「不显示横幅」，不能像提示语那样回退到默认值
    notice: sanitizeText(input.notice, 200),
    // 两个都不允许清空：清空会让「联系开发者」弹窗显示不完整
    contactMethod: contactMethod || DEFAULT_SERVER_SETTINGS.contactMethod,
    contactValue: contactValue || DEFAULT_SERVER_SETTINGS.contactValue,
  }
}

async function readServerSettings(env: Env): Promise<ServerSettings> {
  try {
    const stub = env.LOBBY.get(env.LOBBY.idFromName('global-directory'))
    const response = await stub.fetch('https://lobby.internal/settings')
    if (!response.ok) return { ...DEFAULT_SERVER_SETTINGS }
    return sanitizeServerSettings(await response.json<Partial<ServerSettings>>())
  } catch {
    // 读不到就按默认放行：维护开关坏掉不该把正常游玩也堵死
    return { ...DEFAULT_SERVER_SETTINGS }
  }
}

async function writeServerSettings(env: Env, settings: ServerSettings): Promise<void> {
  const stub = env.LOBBY.get(env.LOBBY.idFromName('global-directory'))
  await stub.fetch('https://lobby.internal/settings', {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

function lobbyStub(env: Env) {
  return env.LOBBY.get(env.LOBBY.idFromName('global-directory'))
}

// 记下这次登录，并顺手关掉这个人还挂在大厅里的旧连接。
async function claimSession(env: Env, user: RoomUser, sessionId: string): Promise<void> {
  await lobbyStub(env).fetch('https://lobby.internal/session/claim', {
    method: 'POST',
    body: JSON.stringify({ userId: user.userId, nickname: user.nickname, sessionId }),
  })
}

async function resolveSession(env: Env, sessionId: string): Promise<RoomUser> {
  const response = await lobbyStub(env).fetch('https://lobby.internal/session/resolve', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) throw new Error('登录状态已失效，请重新输入昵称')
  const result = await response.json<{ user: RoomUser }>()
  return { userId: result.user.userId, nickname: normalizeNickname(result.user.nickname) }
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
      const stub = env.ROOMS.get(env.ROOMS.idFromName(row.code))
      await stub.fetch('https://room.internal/session/evict', {
        method: 'POST',
        body: JSON.stringify({ userId: user.userId }),
      })
    }
  } catch (cause) {
    // 踢不掉旧连接不该让新登录失败：新连接照样能进，旧的最多多活一会儿
    console.error('顶号时清理旧连接失败', cause)
  }
}

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

function rejectSocket(reason: string, code = ROOM_REJECT_CLOSE_CODE): Response {
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  server.send(JSON.stringify({ type: 'error', message: reason }))
  // close reason 上限 123 字节，中文按 3 字节算最多 40 字。
  server.close(code, reason.slice(0, 40))
  return new Response(null, { status: 101, webSocket: client })
}

/** 只用来在解析前区分 ping：真正的指令形状交给 parseRoomCommand 校验。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers,
  })
}

function allowedCorsOrigin(request: Request): string {
  const origin = request.headers.get('origin')
  if (!origin) return ''
  try {
    const caller = new URL(origin)
    const target = new URL(request.url)
    if (caller.origin === target.origin) return origin
    const localHosts = new Set(['127.0.0.1', 'localhost'])
    if (localHosts.has(caller.hostname) && localHosts.has(target.hostname)) return origin
  } catch { /* 非法 Origin 直接不给跨域权限 */ }
  return ''
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

function sessionCookie(request: Request, sessionId: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function readCookie(request: Request, name: string): string {
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return ''
}

async function readSession(request: Request, env: Env): Promise<RoomUser> {
  const sessionId = readCookie(request, SESSION_COOKIE)
  if (!sessionId || !/^[A-Za-z0-9_-]{40,}$/.test(sessionId)) throw new Error('请先输入昵称')
  return resolveSession(env, sessionId)
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
  await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), user.id).run()
  // 同名只留一个在线：先把旧连接踢下去，再把新会话号发出去
  const sessionId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const identity: RoomUser = { userId: user.id, nickname: user.nickname }
  await claimSession(env, identity, sessionId)
  await evictRoomSessions(env, identity)
  return json(identity, 200, { 'set-cookie': sessionCookie(request, sessionId) })
}

async function currentSession(request: Request, env: Env): Promise<Response> {
  try {
    return json({ session: await readSession(request, env) })
  } catch {
    return json({ session: null })
  }
}

async function logout(request: Request, env: Env): Promise<Response> {
  const sessionId = readCookie(request, SESSION_COOKIE)
  if (sessionId) {
    await lobbyStub(env).fetch('https://lobby.internal/session/revoke', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    })
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) })
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
    SELECT id AS user_id, nickname, created_at, last_seen_at
    FROM users
    ORDER BY last_seen_at DESC
    LIMIT 500
  `).all<{
    user_id: string
    nickname: string
    created_at: number
    last_seen_at: number
  }>()
  return json({
    users: result.results.map((row) => ({
      userId: row.user_id,
      nickname: row.nickname,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    })),
  })
}

async function adminDeleteUser(env: Env, userId: string): Promise<Response> {
  const user = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(userId).first<{ nickname: string }>()
  if (!user) return json({ error: '用户不存在' }, 404)
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run()
  await recordAudit(env, 'delete-user', userId, `删除用户 ${user.nickname}`)
  return json({ ok: true, nickname: user.nickname })
}

// 房间目录表里已经存了每个房间的阶段、玩家和座位数，玩家接口只是做了截断和排序；
// 管理端要的是全量，外加创建时间。
async function adminRooms(env: Env): Promise<Response> {
  const mahjongResult = await env.DB.prepare(`
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
  const mahjongRooms = mahjongResult.results.map((row) => {
      let players: unknown[] = []
      try {
        const parsed = JSON.parse(row.players_json)
        if (Array.isArray(parsed)) players = parsed
      } catch { players = [] }
      return {
        game: 'mahjong' as const,
        code: row.code,
        phase: row.phase,
        hostNickname: row.host_nickname,
        players,
        occupiedSeats: row.occupied_seats,
        capacity: 4,
        mode: row.mode,
        initialPoints: row.initial_points,
        claimWindowMs: row.claim_window_ms,
        updatedAt: row.updated_at,
      }
    })

  const sanguoshaResult = await env.DB.prepare(`
    SELECT code, phase, host_nickname, players_json, occupied_seats, player_count, settings_json, updated_at
    FROM sanguosha_room_directory
    ORDER BY updated_at DESC
  `).all<{
    code: string
    phase: 'lobby' | 'playing' | 'finished'
    host_nickname: string
    players_json: string
    occupied_seats: number
    player_count: number
    settings_json: string
    updated_at: number
  }>()
  const sanguoshaRooms = sanguoshaResult.results.map((row) => {
    let players: unknown[] = []
    let settings = normalizeSgsSettings({ playerCount: row.player_count })
    try {
      const parsed = JSON.parse(row.players_json)
      if (Array.isArray(parsed)) players = parsed
    } catch { players = [] }
    try { settings = normalizeSgsSettings(JSON.parse(row.settings_json) as Partial<SgsRoomSettings>) } catch { /* 旧目录记录按人数兜底 */ }
    return {
      game: 'sanguosha' as const,
      code: row.code,
      phase: row.phase,
      hostNickname: row.host_nickname,
      players,
      occupiedSeats: row.occupied_seats,
      capacity: row.player_count,
      difficulty: settings.difficulty,
      turnSeconds: settings.turnSeconds,
      updatedAt: row.updated_at,
    }
  })

  return json({ rooms: [...mahjongRooms, ...sanguoshaRooms].sort((left, right) => right.updatedAt - left.updatedAt) })
}

async function adminDestroyRoom(env: Env, code: string): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
  const response = await stub.fetch('https://room.internal/admin/destroy', { method: 'POST' })
  if (!response.ok) {
    // 房间对象可能已经没了，目录表里的残留记录还是要清掉
    await env.DB.prepare('DELETE FROM room_directory WHERE code = ?').bind(code).run()
    return json({ ok: true, code, note: '房间已不存在，已清理目录记录' })
  }
  await recordAudit(env, 'destroy-room', code, '强制解散房间')
  return json({ ok: true, code })
}

async function adminDestroySgsRoom(env: Env, code: string): Promise<Response> {
  const stub = env.SGS_ROOMS.get(env.SGS_ROOMS.idFromName(code))
  const response = await stub.fetch('https://sgs-room.internal/admin/destroy', { method: 'POST' })
  if (!response.ok) {
    await env.DB.prepare('DELETE FROM sanguosha_room_directory WHERE code = ?').bind(code).run()
    return json({ ok: true, code, note: '房间已不存在，已清理目录记录' })
  }
  await recordAudit(env, 'destroy-sanguosha-room', code, '强制解散纸上三国房间')
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
  // 管理接口对外一律 404，不回任何可以用来判断「密钥对不对」的线索。
  // 这里原来打过一段排查日志（含密钥长度），问题定位完就没有继续保留的理由了。
  if (!isAdmin(request, env)) return NOT_FOUND()
  if (request.method === 'POST' && url.pathname === '/api/admin/session') return json({ ok: true })
  if (request.method === 'GET' && url.pathname === '/api/admin/users') return adminUsers(env)
  if (request.method === 'GET' && url.pathname === '/api/admin/rooms') return adminRooms(env)
  if (request.method === 'GET' && url.pathname === '/api/admin/audit') return adminAudit(env)
  if (request.method === 'GET' && url.pathname === '/api/admin/settings') return json(await readServerSettings(env))
  if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
    const incoming = sanitizeServerSettings(await request.json<Partial<ServerSettings>>())
    await writeServerSettings(env, incoming)
    await recordAudit(env, 'update-settings', null,
      `托管档位=${incoming.trusteeDifficulty} 维护=${incoming.maintenance ? '开' : '关'}`
      + ` 全站停服=${incoming.siteClosed ? '开' : '关'} 公告=${incoming.notice ? '有' : '无'}`)
    return json(incoming)
  }
  const roomMatch = url.pathname.match(/^\/api\/admin\/rooms\/([A-Z0-9]{6})$/)
  if (request.method === 'DELETE' && roomMatch) return adminDestroyRoom(env, roomMatch[1])
  const sgsRoomMatch = url.pathname.match(/^\/api\/admin\/sanguosha\/rooms\/([A-Z0-9]{6})$/)
  if (request.method === 'DELETE' && sgsRoomMatch) return adminDestroySgsRoom(env, sgsRoomMatch[1])
  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([0-9a-fA-F-]{36})$/)
  if (request.method === 'DELETE' && userMatch) return adminDeleteUser(env, userMatch[1])
  return NOT_FOUND()
}

async function listRooms(request: Request, env: Env): Promise<Response> {
  const user = await readSession(request, env)
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

async function lobbySocket(request: Request, env: Env): Promise<Response> {
  let user: RoomUser
  try { user = await readSession(request, env) } catch { return rejectSocket('登录状态已失效，请重新输入昵称', SESSION_SUPERSEDED_CODE) }
  const headers = new Headers(request.headers)
  headers.set('x-user-id', user.userId)
  return lobbyStub(env).fetch('https://lobby.internal/socket', { headers })
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  const user = await readSession(request, env)
  const body = await request.json<{ settings?: Partial<OnlineRoomSettings> }>()
  const server = await readServerSettings(env)
  // 维护期间只拦「开新房」：正在打的牌局和重连都不受影响，中途被掐断太难受了
  if (server.maintenance) return json({ error: server.maintenanceMessage, maintenance: true }, 503)
  const settings = sanitizeSettings(body.settings ?? {}, server.trusteeDifficulty)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode()
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
    const response = await stub.fetch('https://room.internal/create', {
      method: 'POST',
      body: JSON.stringify({ code, user: { userId: user.userId, nickname: user.nickname }, settings }),
    })
    if (response.status === 201) return json({ code }, 201)
    if (response.status !== 409) return response
  }
  throw new Error('房间号生成失败，请重试')
}

async function roomSocket(request: Request, env: Env, code: string): Promise<Response> {
  let user: RoomUser
  try { user = await readSession(request, env) } catch { return rejectSocket('登录状态已失效，请重新输入昵称', SESSION_SUPERSEDED_CODE) }
  const headers = new Headers(request.headers)
  headers.set('x-user-id', user.userId)
  headers.set('x-user-nickname', encodeURIComponent(user.nickname))
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code))
  return stub.fetch('https://room.internal/socket', { headers })
}

interface SgsDirectoryPlayer {
  nickname: string
  connected: boolean
  isHost: boolean
  kind: 'human' | 'ai'
  trustee: boolean
}

async function listSgsRooms(request: Request, env: Env): Promise<Response> {
  const user = await readSession(request, env)
  const result = await env.DB.prepare(`
    SELECT code, phase, host_nickname, players_json, occupied_seats, player_count, settings_json, updated_at
    FROM sanguosha_room_directory
    ORDER BY CASE phase WHEN 'lobby' THEN 0 WHEN 'playing' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 40
  `).all<{
    code: string
    phase: 'lobby' | 'playing' | 'finished'
    host_nickname: string
    players_json: string
    occupied_seats: number
    player_count: number
    settings_json: string
    updated_at: number
  }>()
  const rooms = (result.results ?? []).map((row) => {
    let players: SgsDirectoryPlayer[] = []
    let settings = normalizeSgsSettings({ playerCount: row.player_count })
    try {
      const parsed = JSON.parse(row.players_json)
      if (Array.isArray(parsed)) players = parsed as SgsDirectoryPlayer[]
    } catch { players = [] }
    try { settings = normalizeSgsSettings(JSON.parse(row.settings_json) as Partial<SgsRoomSettings>) } catch { /* 使用表中的人数兜底 */ }
    const rejoinable = players.some((player) => player.kind === 'human' && player.nickname === user.nickname)
    return {
      code: row.code,
      phase: row.phase,
      hostNickname: row.host_nickname,
      players,
      occupiedSeats: row.occupied_seats,
      availableSeats: Math.max(0, row.player_count - row.occupied_seats),
      settings,
      rejoinable,
      joinable: rejoinable || (row.phase === 'lobby' && row.occupied_seats < row.player_count),
      updatedAt: row.updated_at,
    }
  })
  return json({ rooms })
}

/**
 * 最近一次建房的结果，按 `createRequestId` 记账。
 *
 * 建房是 POST，天然不幂等：客户端因为超时重试一次，就会凭空多出一个房间，
 * 而房主只会进其中一个，另一个变成永远没人的僵尸房。带上同一个
 * `createRequestId` 重试时直接把上次的房间号还回去。
 *
 * 放在模块作用域（Worker isolate 内存）而不是 D1：它只需要覆盖
 * 「同一次点击的重试」这个几秒钟的窗口，为它加一次数据库往返反而拖慢建房。
 * isolate 被回收导致记录丢失的最坏结果，就是退回到今天的行为。
 */
const recentRoomCreations = new Map<string, { code: string; at: number }>()
const CREATE_DEDUPE_TTL_MS = 60_000

function rememberCreation(requestId: string, code: string): void {
  const now = Date.now()
  for (const [key, entry] of recentRoomCreations) {
    if (now - entry.at > CREATE_DEDUPE_TTL_MS) recentRoomCreations.delete(key)
  }
  recentRoomCreations.set(requestId, { code, at: now })
}

async function createSgsRoom(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now()
  const body = await request.json<{ settings?: Partial<SgsRoomSettings>; createRequestId?: string }>()
  const requestId = typeof body.createRequestId === 'string' ? body.createRequestId.slice(0, 64) : ''
  if (requestId) {
    const previous = recentRoomCreations.get(requestId)
    if (previous && Date.now() - previous.at <= CREATE_DEDUPE_TTL_MS) return json({ code: previous.code }, 201)
  }
  /*
   * 会话和服务端设置**并行取**。
   *
   * 两者都要往 Lobby Durable Object 走一趟，而且互相没有数据依赖；
   * 原来是一前一后串着 await，白白多付一整个往返——冷启动时这一下就是好几百毫秒。
   */
  const sessionStartedAt = Date.now()
  const [user, server] = await Promise.all([readSession(request, env), readServerSettings(env)])
  const sessionMs = Date.now() - sessionStartedAt
  if (server.maintenance) return json({ error: server.maintenanceMessage, maintenance: true }, 503)
  const settings = normalizeSgsSettings(body.settings)
  const roomInitStartedAt = Date.now()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = roomCode()
    const stub = env.SGS_ROOMS.get(env.SGS_ROOMS.idFromName(code))
    const response = await stub.fetch('https://sgs-room.internal/create', {
      method: 'POST',
      body: JSON.stringify({ code, user: { userId: user.userId, nickname: user.nickname }, settings }),
    })
    if (response.status === 201) {
      if (requestId) rememberCreation(requestId, code)
      const total = Date.now() - startedAt
      // 建房慢是用户报的主要问题之一，这里把各段耗时留在日志里，不用再猜
      if (total > 1_500) {
        console.log('[net-metric]', JSON.stringify({
          scope: 'sgs', event: 'slow-create-room', code,
          totalMs: total, sessionMs, roomInitMs: Date.now() - roomInitStartedAt,
        }))
      }
      return json({ code }, 201)
    }
    if (response.status !== 409) return response
  }
  throw new Error('房间号生成失败，请重试')
}

async function sgsRoomSocket(request: Request, env: Env, code: string): Promise<Response> {
  let user: RoomUser
  try { user = await readSession(request, env) } catch { return rejectSocket('登录状态已失效，请重新输入昵称', SESSION_SUPERSEDED_CODE) }
  if (request.headers.has('origin') && !allowedCorsOrigin(request)) return rejectSocket('请求来源不受信任')
  const headers = new Headers(request.headers)
  headers.set('x-user-id', user.userId)
  headers.set('x-user-nickname', encodeURIComponent(user.nickname))
  const stub = env.SGS_ROOMS.get(env.SGS_ROOMS.idFromName(code))
  return stub.fetch('https://sgs-room.internal/socket', { headers })
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return json(null, 204)
  const url = new URL(request.url)
  // 管理接口必须在所有玩家接口之前拦下，避免前缀写错时被后面的路由捡走。
  if (url.pathname.startsWith('/api/admin/')) return adminRoute(request, env, url)
  if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true })
  if (request.method === 'GET' && url.pathname === '/api/service') {
    const server = await readServerSettings(env)
    return json({
      maintenance: server.maintenance,
      maintenanceMessage: server.maintenanceMessage,
      siteClosed: server.siteClosed,
      siteClosedMessage: server.siteClosedMessage,
      notice: server.notice,
      contactMethod: server.contactMethod,
      contactValue: server.contactValue,
    })
  }

  /*
   * 全站停服。放在这里——**在所有玩家接口之前，在管理接口之后**。
   *
   * `/api/admin/*` 已经在上面 return 掉了，`/api/service` 和 `/api/health` 也在上面，
   * 所以停服期间管理员仍然进得去、仍然关得掉，健康检查也不会误报整站挂掉。
   */
  const server = await readServerSettings(env)
  if (server.siteClosed) return json({ error: server.siteClosedMessage, siteClosed: true }, 503)
  if (request.method === 'POST' && url.pathname === '/api/session') return login(request, env)
  if (request.method === 'GET' && url.pathname === '/api/session') return currentSession(request, env)
  if (request.method === 'DELETE' && url.pathname === '/api/session') return logout(request, env)
  if (request.method === 'GET' && url.pathname === '/api/rooms') return listRooms(request, env)
  if (request.method === 'POST' && url.pathname === '/api/rooms') return createRoom(request, env)
  if (request.method === 'GET' && url.pathname === '/api/lobby/socket') return lobbySocket(request, env)
  if (request.method === 'GET' && url.pathname === '/api/sanguosha/rooms') return listSgsRooms(request, env)
  if (request.method === 'POST' && url.pathname === '/api/sanguosha/rooms') return createSgsRoom(request, env)
  const sgsSocketMatch = url.pathname.match(/^\/api\/sanguosha\/rooms\/([A-Z0-9]{6})\/socket$/)
  if (request.method === 'GET' && sgsSocketMatch) return sgsRoomSocket(request, env, sgsSocketMatch[1])
  const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/socket$/)
  if (request.method === 'GET' && socketMatch) return roomSocket(request, env, socketMatch[1])
  return json({ error: '接口不存在' }, 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response
    try {
      response = await route(request, env)
    } catch (cause) {
      response = errorResponse(cause)
    }
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return response
    const origin = allowedCorsOrigin(request)
    if (!origin) return response
    const headers = new Headers(response.headers)
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-allow-credentials', 'true')
    headers.set('access-control-allow-headers', 'content-type, authorization')
    headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    headers.append('vary', 'Origin')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}

/**
 * 麻将房间的服务端心跳节奏。和纸上三国同一套口径：
 * 房间里有人就保持热状态，最后一个人走了再热身一分钟等他回来。
 */
const MJ_HEARTBEAT_INTERVAL_MS = 4_500
const MJ_HEARTBEAT_DEAD_AFTER_MS = 31_000
const MJ_WARM_GRACE_MS = 60_000

export class MahjongRoom {
  private coordinator: RoomCoordinator | null = null
  private readonly ready: Promise<void>
  private readonly chatRate = new Map<string, number[]>()
  /** 下一次该发服务端心跳的时刻。0 表示当前不需要心跳。 */
  private heartbeatDueAt = 0
  private heartbeatSeq = 0
  /** 每条连接的存活记账。只用于保活/探活，不承载任何正确性。 */
  private readonly liveness = new WeakMap<WebSocket, { lastSeenAt: number }>()
  private warmUntil = 0

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    /*
     * **不再用 `setWebSocketAutoResponse` 自动应答 ping。**
     *
     * 那个机制让 Cloudflare 在边缘直接回 pong、不唤醒 Durable Object，省的是
     * Duration。代价是客户端的探活只到边缘为止（DO 本身卡住了照样探不出来），
     * 而且房间里明明有人 DO 仍会一路休眠，下一次操作要付冷启动。
     */
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<StoredRoomState>('room')
      if (stored) {
        this.coordinator = new RoomCoordinator(stored)
        if (this.coordinator.ensureOfflineExpiry()) await this.persist()
      }
    })
    // 部署、节点迁移、runtime 重启之后如果还挂着连接，心跳要重新拉起来
    if (state.getWebSockets().length > 0) this.armHeartbeat(Date.now())
  }

  private armHeartbeat(now: number): void {
    if (this.heartbeatDueAt === 0 || this.heartbeatDueAt > now + MJ_HEARTBEAT_INTERVAL_MS) {
      this.heartbeatDueAt = now + MJ_HEARTBEAT_INTERVAL_MS
    }
  }

  /** 发一轮心跳并清掉真正死掉的连接；返回是否还要继续。 */
  private runHeartbeat(now: number): boolean {
    const sockets = this.state.getWebSockets()
    if (sockets.length === 0) {
      if (this.warmUntil === 0) this.warmUntil = now + MJ_WARM_GRACE_MS
      return now < this.warmUntil
    }
    this.warmUntil = 0
    this.heartbeatSeq += 1
    const roomVersion = this.coordinator?.state.version ?? 0
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const seen = this.liveness.get(socket)
      if (!seen) {
        this.liveness.set(socket, { lastSeenAt: now })
      } else if (now - seen.lastSeenAt > MJ_HEARTBEAT_DEAD_AFTER_MS) {
        // 浏览器那边可能还是 OPEN，但这条连接已经不通了。主动关掉让它重连。
        try { socket.close(1001, 'heartbeat timeout') } catch { /* 已经断了 */ }
        continue
      }
      this.send(socket, { type: 'server-heartbeat', heartbeatId: this.heartbeatSeq, serverNow: now, roomVersion })
    }
    return true
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
      // 创建响应前先落下轻量目录，确保紧随其后的顶号/分享加入不会撞上目录竞态。
      await this.syncRoomDirectory()
      return json({ code: body.code }, 201)
    }
    if (url.pathname === '/admin/destroy' && request.method === 'POST') {
      if (!this.coordinator) return json({ error: '房间不存在' }, 404)
      const code = this.coordinator.state.code
      // 先告诉屋里的人是被管理员关的，再销毁；否则他们只会看到一次莫名其妙的断线
      for (const socket of this.state.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue
        socket.send(JSON.stringify({ type: 'error', message: '房间已被管理员关闭' }))
        socket.close(ROOM_CLOSED_BY_ADMIN_CODE, '房间已被管理员关闭')
      }
      await this.deleteRoom()
      return json({ ok: true, code })
    }
    if (url.pathname === '/session/evict' && request.method === 'POST') {
      const { userId } = await request.json<{ userId: string }>()
      // 关掉连接就够了：牌局中会走托管，没开局的会腾出座位，都是既有逻辑
      for (const socket of this.state.getWebSockets(`user:${userId}`)) {
        if (socket.readyState !== WebSocket.OPEN) continue
        socket.send(JSON.stringify({ type: 'error', message: '这个昵称已经在别的设备上登录了' }))
        socket.close(SESSION_SUPERSEDED_CODE, '昵称已在别处登录')
      }
      return json({ ok: true })
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
      this.liveness.set(server, { lastSeenAt: Date.now() })
      this.warmUntil = 0
      this.armHeartbeat(Date.now())
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
      // 客户端发了任何东西，就说明这条链路还活着
      const seenAt = Date.now()
      this.liveness.set(socket, { lastSeenAt: seenAt })
      this.armHeartbeat(seenAt)
      if (text === 'ping') {
        socket.send('pong')
        return
      }
      // ping 不是房间指令，先单独放行，剩下的一律过运行时校验：
      // 客户端是任何人都能自己写的，编译期的 RoomCommand 类型在这里没有约束力。
      const payload = JSON.parse(text) as unknown
      if (isRecord(payload) && payload.type === 'ping') {
        this.send(socket, { type: 'pong', at: Date.now() })
        return
      }
      /*
       * 连接层消息走在房间指令之外：它们不改变房间状态，
       * 也不该被指令校验挡下来。
       */
      if (isRecord(payload) && payload.type === 'client-heartbeat-ack') {
        // 版本漂移自愈：某一帧房间状态在网络里丢了，客户端自己发现不了，
        // 心跳把版本捎过来一比就补一份完整快照
        if (Number(payload.lastKnownVersion ?? -1) !== (this.coordinator?.state.version ?? 0)) {
          this.sendState(socket, user.userId)
        }
        return
      }
      if (isRecord(payload) && payload.type === 'request-sync') {
        this.sendState(socket, user.userId)
        return
      }
      const parsed = parseRoomCommand(payload)
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
      if (chatMessage) this.broadcast({ type: 'chat', message: chatMessage })
      else this.broadcastState()
    } catch (cause) {
      this.send(socket, { type: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      // 格式就不对的包不回全量快照：那是最贵的一条响应，
      // 否则谁都可以用一串垃圾 JSON 把房间推成持续广播。合法但被业务拒绝的操作才需要纠正客户端状态。
      if (!(cause instanceof InvalidRoomCommandError)) await this.sendState(socket, user.userId)
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
    /*
     * 心跳和牌局推进共用同一个 alarm：Durable Object 只有一个槽位，
     * `persist()` 取两者的较早者，这里到点先跑心跳再跑牌局任务。
     */
    const heartbeatNow = Date.now()
    if (this.heartbeatDueAt !== 0 && this.heartbeatDueAt <= heartbeatNow) {
      const keepGoing = this.runHeartbeat(heartbeatNow)
      this.heartbeatDueAt = keepGoing ? heartbeatNow + MJ_HEARTBEAT_INTERVAL_MS : 0
    }
    if (!this.coordinator) {
      if (this.heartbeatDueAt !== 0) await this.state.storage.setAlarm(this.heartbeatDueAt)
      return
    }
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
      if (directoryBefore !== this.directorySignature()) this.state.waitUntil(this.syncRoomDirectory())
      this.broadcastState()
    }
  }

  private async persist(): Promise<void> {
    if (!this.coordinator) return
    await this.state.storage.put('room', this.coordinator.snapshot())
    const alarmAt = this.coordinator.nextAlarmAt()
    /*
     * 心跳到期时刻也要参与。只按牌局任务排 alarm 的话，大厅里静静等人的房间
     * 会一路休眠，保活和探活全都不会发生。
     */
    const candidates = [alarmAt, this.heartbeatDueAt === 0 ? null : this.heartbeatDueAt]
      .filter((value): value is number => value !== null)
    if (candidates.length === 0) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(Math.min(...candidates))
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
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch (cause) {
      // 一条已经半断开的连接不能中断整个房间的状态广播。
      console.error('[mahjong][socket-send-error]', JSON.stringify({
        roomCode: this.coordinator?.state.code,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      }))
      try { socket.close(1011, 'send failed') } catch { /* 已经断开就无需再处理 */ }
    }
  }
}

/**
 * 服务端主动心跳的节奏。
 *
 * 这个项目同时最多一个房间、一天几局，Cloudflare 免费额度剩得非常多，
 * 所以这里的取舍是**稳定优先**，不是省 Duration：
 *
 * - 4.5 秒一次意味着半死连接最多 30 秒就会被发现并重连，而不是原来的
 *   「15 秒心跳 + 35 秒超时」最坏 50 秒；
 * - 房间里只要还有连接，alarm 就一直在跑，Durable Object 因此保持热状态，
 *   玩家点「准备」不再撞上一次冷启动。
 *
 * 连续 7 次（约 31 秒）收不到任何回应才判定连接死亡：偶发一两次丢包
 * 不能把人踢下线。
 */
const SGS_HEARTBEAT_INTERVAL_MS = 4_500
const SGS_HEARTBEAT_DEAD_AFTER_MS = 31_000
/**
 * 最后一条连接断开后，继续保持热状态的时长。
 *
 * Wi-Fi 瞬断、切换网络、手机回前台重连时不必再经历一次冷恢复。
 * 超过这个时间仍然没人回来，就停掉心跳让 Durable Object 正常休眠——
 * 没有玩家还常驻是纯浪费。
 */
const SGS_WARM_GRACE_MS = 60_000

export class SanguoshaRoom {
  private coordinator: SanguoshaRoomCoordinator | null = null
  private readonly ready: Promise<void>
  private readonly chatRate = new Map<string, number[]>()
  private readonly timing
  /** 下一次该发服务端心跳的时刻。0 表示当前不需要心跳。 */
  private heartbeatDueAt = 0
  private heartbeatSeq = 0
  /**
   * 每条连接的存活记账。
   *
   * 只是保活/探活用的辅助信息，**不承载任何正确性**，所以放在内存里就够了：
   * Durable Object 重建之后从 `getWebSockets()` 重新起账即可。
   */
  private readonly liveness = new WeakMap<WebSocket, { lastSeenAt: number }>()
  /** 最后一条连接断开之后，热状态保留到什么时候。 */
  private warmUntil = 0

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.timing = env.SGS_AI_PACING === 'instant' ? TEST_SGS_ROOM_TIMING : PRODUCTION_SGS_ROOM_TIMING
    /*
     * **不再用 `setWebSocketAutoResponse` 自动应答 ping。**
     *
     * 那个机制的用途是让 Cloudflare 在边缘直接回 pong、不唤醒 Durable Object，
     * 目的是省 Duration。代价是两件我们现在更在意的事：
     * 1. 客户端的探活只到边缘为止，DO 本身卡住了照样探不出来；
     * 2. 房间里明明有人，DO 仍会一路休眠，下一次操作要付冷启动。
     * 现在改成心跳走真正的 handler，房间有人时 DO 保持热状态。
     */
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<StoredSgsRoomState>('room')
      if (stored) this.coordinator = new SanguoshaRoomCoordinator(stored, this.timing)
    })
    /*
     * 重建之后如果还挂着连接（部署、节点迁移、runtime 重启都会这样），
     * 要把心跳重新拉起来，否则这个房间从此再也没有保活和探活。
     */
    if (state.getWebSockets().length > 0) this.armHeartbeat(Date.now())
  }

  /** 房间里还有人（或还在热身宽限期内）时，保证心跳在跑。 */
  private armHeartbeat(now: number): void {
    if (this.heartbeatDueAt === 0 || this.heartbeatDueAt > now + SGS_HEARTBEAT_INTERVAL_MS) {
      this.heartbeatDueAt = now + SGS_HEARTBEAT_INTERVAL_MS
    }
  }

  /**
   * 发一轮服务端心跳，顺手清掉真正死掉的连接。
   *
   * 返回是否还需要继续心跳：房间里还有连接就继续；一个都没有了，
   * 再热身 `SGS_WARM_GRACE_MS` 等人回来，之后停掉让 DO 正常休眠。
   */
  private runHeartbeat(now: number): boolean {
    const sockets = this.state.getWebSockets()
    if (sockets.length === 0) {
      if (this.warmUntil === 0) this.warmUntil = now + SGS_WARM_GRACE_MS
      return now < this.warmUntil
    }
    this.warmUntil = 0
    this.heartbeatSeq += 1
    const roomVersion = this.coordinator?.state.version ?? 0
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const seen = this.liveness.get(socket)
      if (!seen) {
        // 第一次见到（新连接，或 DO 重建之后重新起账）：先给它一个宽限起点
        this.liveness.set(socket, { lastSeenAt: now })
      } else if (now - seen.lastSeenAt > SGS_HEARTBEAT_DEAD_AFTER_MS) {
        /*
         * 连续多轮心跳一点回应都没有：这条连接多半已经死了，
         * 但浏览器那边 `readyState` 仍然是 OPEN。主动关掉，
         * 让客户端走正常重连，而不是让半死连接一直占着座位。
         */
        console.log('[net-metric]', JSON.stringify({
          scope: 'sgs', event: 'reap-dead-socket',
          roomCode: this.coordinator?.state.code, silentMs: now - seen.lastSeenAt,
        }))
        try { socket.close(1001, 'heartbeat timeout') } catch { /* 已经断了 */ }
        continue
      }
      this.send(socket, { type: 'server-heartbeat', heartbeatId: this.heartbeatSeq, serverNow: now, roomVersion })
    }
    return true
  }

  /** 收到客户端的心跳回执：记活，并在版本落后时补一帧权威状态。 */
  private onClientHeartbeatAck(socket: WebSocket, userId: string, lastKnownVersion: number, now: number): void {
    this.liveness.set(socket, { lastSeenAt: now })
    const version = this.coordinator?.state.version ?? 0
    /*
     * 版本漂移自愈：某一帧 room-state 在网络里丢了，客户端会一直停在旧状态，
     * 而且它自己不知道。心跳把版本捎过去一比就发现了，这里直接补一帧完整快照，
     * 不必等玩家下一次操作才暴露。
     */
    if (lastKnownVersion !== version) this.sendState(socket, userId)
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready
    if (this.coordinator?.isStale() || this.coordinator?.shouldDeleteRoom()) await this.deleteRoom()
    const url = new URL(request.url)
    if (url.pathname === '/create' && request.method === 'POST') {
      if (this.coordinator) return json({ error: '房间号已存在' }, 409)
      const body = await request.json<{ code: string; user: RoomUser; settings: SgsRoomSettings }>()
      this.coordinator = SanguoshaRoomCoordinator.create(body.code, body.user, normalizeSgsSettings(body.settings), Date.now(), this.timing)
      // 房间必须先真正落盘才能对外宣布存在，否则房主可能连进一个还不存在的房间
      await this.persist()
      /*
       * 房间目录（D1 写 + 通知大厅）**不挡建房返回**。
       *
       * 它只影响别人在大厅列表里多久能看到这个房间，和「房主能不能安全进入
       * 刚建好的房间」无关。原来串在关键路径上，等于让每次建房都多付一次
       * D1 写入加一次 Durable Object 往返。
       */
      this.state.waitUntil(this.syncRoomDirectory())
      // 建好就开始保活：房主马上就会连进来，别让他撞上一次冷启动
      this.armHeartbeat(Date.now())
      await this.state.storage.setAlarm(this.heartbeatDueAt)
      return json({ code: body.code }, 201)
    }
    if (url.pathname === '/admin/destroy' && request.method === 'POST') {
      if (!this.coordinator) return json({ error: '房间不存在' }, 404)
      const code = this.coordinator.state.code
      for (const socket of this.state.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue
        this.send(socket, { type: 'error', message: '房间已被管理员关闭' })
        socket.close(ROOM_CLOSED_BY_ADMIN_CODE, '房间已被管理员关闭')
      }
      await this.deleteRoom()
      return json({ ok: true, code })
    }
    if (url.pathname === '/socket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const userId = request.headers.get('x-user-id') ?? ''
      const encodedNickname = request.headers.get('x-user-nickname') ?? ''
      const user: RoomUser = { userId, nickname: normalizeNickname(decodeURIComponent(encodedNickname)) }
      const rejection = !this.coordinator ? '房间不存在或已经关闭' : this.tryConnect(user)
      if (rejection) return rejectSocket(rejection)
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      server.serializeAttachment({ ...user } satisfies SocketAttachment)
      this.state.acceptWebSocket(server, [`user:${user.userId}`])
      // 新连接已经生效，再关旧的：反过来会让 webSocketClose 把玩家误判成掉线
      this.closeSupersededSockets(user.userId, server)
      const now = Date.now()
      this.liveness.set(server, { lastSeenAt: now })
      this.warmUntil = 0
      this.armHeartbeat(now)
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
    let commandActionId = ''
    try {
      const byteLength = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
      if (byteLength > 64 * 1024) throw new InvalidSgsWireCommandError()
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
      // 客户端只要发了任何东西，就说明这条链路还活着
      const receivedAt = Date.now()
      this.liveness.set(socket, { lastSeenAt: receivedAt })
      this.armHeartbeat(receivedAt)
      if (text === 'ping') {
        socket.send('pong')
        return
      }
      const payload = JSON.parse(text) as unknown
      // 先留一份 actionId：下面任何一步抛出来，catch 里都要靠它回执
      if (isRecord(payload) && typeof payload.actionId === 'string') commandActionId = payload.actionId
      if (isRecord(payload) && payload.type === 'ping') {
        this.send(socket, { type: 'pong', at: Date.now() })
        return
      }
      /*
       * 连接层消息走在房间指令之外：它们既不改变房间状态，
       * 也不该占用 actionId 额度或被幂等去重挡下来。
       */
      if (isRecord(payload) && payload.type === 'client-heartbeat-ack') {
        this.onClientHeartbeatAck(socket, user.userId, Number(payload.lastKnownVersion ?? -1), receivedAt)
        return
      }
      if (isRecord(payload) && payload.type === 'request-sync') {
        this.sendState(socket, user.userId)
        return
      }
      const parsed = parseSgsRoomCommand(payload)
      if (parsed.type === 'chat') this.assertChatRate(user.userId)
      if (parsed.type === 'leave-room') socket.serializeAttachment({ ...user, leaving: true })
      const chat = this.coordinator.handle(user.userId, parsed)
      if (this.coordinator.shouldDeleteRoom()) {
        this.ack(socket, parsed.actionId, { accepted: true, receivedAt })
        await this.deleteRoom()
        return
      }
      await this.persist()
      this.state.waitUntil(this.syncRoomDirectory())
      /*
       * **先回执，再广播。**
       *
       * 回执是这一次点击的直接反馈，广播是给全桌的。先发回执能让点按钮的人
       * 最快拿到「收到了」，也让客户端可以按 actionId 把 pending 清掉。
       */
      this.ack(socket, parsed.actionId, { accepted: true, receivedAt })
      if (chat) this.broadcast({ type: 'chat', message: chat })
      else this.broadcastState()
      if (parsed.type === 'leave-room') socket.close(1000, 'left room')
    } catch (cause) {
      const actionId = commandActionId
      const message = cause instanceof Error ? cause.message : String(cause)
      /*
       * 重复的 actionId 不是错误，是**客户端没收到回执之后原样重发**。
       *
       * 之前这里会回一条 error，玩家会看到一个莫名其妙的失败提示，
       * 而客户端也无法区分「真的被拒了」和「其实早就成功了」。
       * 现在明确告诉它：接受，但这次没有再执行一遍。
       */
      if (cause instanceof DuplicateSgsActionError && actionId) {
        this.ack(socket, actionId, { accepted: true, duplicate: true, receivedAt: Date.now() })
        this.sendState(socket, user.userId)
        return
      }
      if (actionId) this.ack(socket, actionId, { accepted: false, reason: message, receivedAt: Date.now() })
      this.send(socket, { type: 'error', message })
      // 格式错误不附送昂贵快照；业务拒绝则回当前权威状态，供客户端同步 baseSeq。
      if (!(cause instanceof InvalidSgsWireCommandError)) this.sendState(socket, user.userId)
    }
  }

  /** 一条指令的处理回执。没有 actionId 的旧客户端不发。 */
  private ack(
    socket: WebSocket,
    actionId: string | undefined,
    result: { accepted: boolean; duplicate?: boolean; reason?: string; receivedAt: number },
  ): void {
    if (!actionId) return
    const processedAt = Date.now()
    const elapsed = processedAt - result.receivedAt
    // 只记异常的那些，正常操作不刷日志
    if (elapsed > 800) {
      console.log('[net-metric]', JSON.stringify({
        scope: 'sgs', event: 'slow-action', roomCode: this.coordinator?.state.code, actionId, elapsed,
      }))
    }
    this.send(socket, {
      type: 'action-ack',
      actionId,
      accepted: result.accepted,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      serverVersion: this.coordinator?.state.version ?? 0,
      serverReceivedAt: result.receivedAt,
      serverProcessedAt: processedAt,
    })
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready
    if (!this.coordinator) return
    const user = socket.deserializeAttachment() as SocketAttachment | null
    if (!user || user.leaving) return
    const remaining = this.state.getWebSockets(`user:${user.userId}`)
      .filter((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN)
    if (remaining.length === 0) this.coordinator.disconnect(user.userId)
    /*
     * 最后一个人断开之后**不立刻停心跳**：再热身一段时间等他回来。
     * Wi-Fi 瞬断、切网络、手机回前台都在这个窗口里，能省掉一次冷恢复。
     */
    this.armHeartbeat(Date.now())
    if (this.coordinator.shouldDeleteRoom()) {
      await this.deleteRoom()
      return
    }
    await this.persist()
    this.state.waitUntil(this.syncRoomDirectory())
    this.broadcastState()
  }

  async alarm(): Promise<void> {
    await this.ready
    /*
     * 心跳和牌局推进共用同一个 alarm。
     *
     * Durable Object 只有一个 alarm 槽位，所以 `persist()` 里取两者的较早者；
     * 这里到点之后先跑心跳、再跑牌局任务。心跳这条路让房间有人时 alarm
     * 一直在转，DO 因此保持热状态——玩家点按钮不再撞冷启动。
     */
    const now = Date.now()
    if (this.heartbeatDueAt !== 0 && this.heartbeatDueAt <= now) {
      const keepGoing = this.runHeartbeat(now)
      this.heartbeatDueAt = keepGoing ? now + SGS_HEARTBEAT_INTERVAL_MS : 0
    }
    if (!this.coordinator) {
      if (this.heartbeatDueAt !== 0) await this.state.storage.setAlarm(this.heartbeatDueAt)
      return
    }
    try {
      const changed = this.coordinator.runDueJobs()
      if (this.coordinator.shouldDeleteRoom() || this.coordinator.isStale()) {
        await this.deleteRoom()
        return
      }
      await this.persist()
      if (changed) {
        this.state.waitUntil(this.syncRoomDirectory())
        this.broadcastState()
      }
    } catch (cause) {
      /*
       * 走到这里说明 runDueJobs 之外还有未知异常。
       *
       * 只 persist 是不够的：如果此时房间已经没有推进任务，`nextAlarmAt()`
       * 会退化成「6 小时后的回收 alarm」，牌局就等于永久卡死。
       * 所以要显式让协调器补一个近期的自检任务再落盘。
       */
      console.error('[sanguosha][alarm-recovery]', JSON.stringify({
        roomCode: this.coordinator?.state.code,
        status: this.coordinator?.state.game?.status,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
        errorStack: cause instanceof Error ? cause.stack : undefined,
      }))
      try { this.coordinator?.ensureRecoveryJob() } catch (nested) {
        console.error('[sanguosha][alarm-recovery-failed]', nested)
      }
      await this.persist()
    }
  }

  private tryConnect(user: RoomUser): string | null {
    try {
      this.coordinator!.connect(user)
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  }

  private async persist(): Promise<void> {
    if (!this.coordinator) return
    await this.state.storage.put('room', this.coordinator.snapshot())
    // 没有玩家操作等待时也保留一次回收 alarm；否则 finished/空闲 lobby 永远不会再醒，
    // `isStale()` 只能在下一次外部请求时才有机会运行。
    const alarmAt = this.coordinator.nextAlarmAt() ?? (this.coordinator.state.updatedAt + 6 * 60 * 60_000)
    /*
     * 下限**只对已经过期的时刻生效**。
     *
     * 它的用途是给「已经到点却还没跑成」的任务留一次退避，避免 alarm 立刻
     * 重入烧 CPU。原来无条件套在所有时刻上，于是每次 persist（每条客户端消息
     * 都会 persist）都会把 1 秒内到期的 alarm 往后推到整整 1 秒后——
     * 玩家在最后一秒里随便点一下，操作窗口就白白多出最多 1 秒。
     */
    const now = Date.now()
    const jobAlarmAt = alarmAt <= now ? now + this.timing.alarmFloorMs : alarmAt
    /*
     * 心跳到期时刻也要参与：只按牌局任务排 alarm 的话，大厅里静静等人的房间
     * 会一路睡到 6 小时后的回收任务，保活和探活全都不会发生。
     */
    const next = this.heartbeatDueAt === 0 ? jobAlarmAt : Math.min(jobAlarmAt, Math.max(this.heartbeatDueAt, now + 1))
    await this.state.storage.setAlarm(next)
  }

  private async syncRoomDirectory(): Promise<void> {
    if (!this.coordinator) return
    try {
      const room = this.coordinator.state
      const humanSeats = room.seats.filter((seat) => seat.kind === 'human' && seat.userId)
      const host = humanSeats.find((seat) => seat.userId === room.hostUserId)
      if (!host) {
        await this.env.DB.prepare('DELETE FROM sanguosha_room_directory WHERE code = ?').bind(room.code).run()
        await this.notifyLobbyDirectory()
        return
      }
      const players: SgsDirectoryPlayer[] = room.seats
        .filter((seat) => seat.kind !== 'empty')
        .map((seat) => ({
          nickname: seat.name,
          connected: seat.connected,
          isHost: seat.userId === room.hostUserId,
          kind: seat.kind === 'ai' ? 'ai' : 'human',
          trustee: seat.trustee,
        }))
      const phase = !room.game ? 'lobby' : room.game.status === 'game-over' ? 'finished' : 'playing'
      await this.env.DB.prepare(`
        INSERT INTO sanguosha_room_directory
          (code, phase, host_nickname, players_json, occupied_seats, player_count, settings_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          phase = excluded.phase,
          host_nickname = excluded.host_nickname,
          players_json = excluded.players_json,
          occupied_seats = excluded.occupied_seats,
          player_count = excluded.player_count,
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `).bind(
        room.code,
        phase,
        host.name,
        JSON.stringify(players),
        players.length,
        room.settings.playerCount,
        JSON.stringify(room.settings),
        Date.now(),
      ).run()
      await this.notifyLobbyDirectory()
    } catch (cause) {
      // 目录只是可发现性索引，写失败不能终止权威房间本身。
      console.error('同步纸上三国房间列表失败', cause)
    }
  }

  private async deleteRoom(): Promise<void> {
    if (!this.coordinator) return
    const code = this.coordinator.state.code
    this.coordinator = null
    await this.state.storage.deleteAll()
    await this.state.storage.deleteAlarm()
    try {
      await this.env.DB.prepare('DELETE FROM sanguosha_room_directory WHERE code = ?').bind(code).run()
      await this.notifyLobbyDirectory()
    } catch (cause) {
      console.error('移除纸上三国房间失败', cause)
    }
    for (const socket of this.state.getWebSockets()) socket.close(1000, 'room deleted')
  }

  private async notifyLobbyDirectory(): Promise<void> {
    await lobbyStub(this.env).fetch('https://lobby.internal/notify', { method: 'POST' })
  }

  private assertChatRate(userId: string): void {
    const now = Date.now()
    const recent = (this.chatRate.get(userId) ?? []).filter((timestamp) => now - timestamp < 10_000)
    if (recent.length >= 5) throw new Error('发送太快了，请稍后再试')
    recent.push(now)
    this.chatRate.set(userId, recent)
  }

  /**
   * 广播必须**按连接隔离**。
   *
   * 一个坏掉的 socket（半断开、缓冲区满、已被对端重置）在 `send` 时抛异常，
   * 原来会让整个 for 循环当场中断，排在它后面的玩家一个都收不到状态——
   * 表现就是「有人卡住了，另一些人还能玩」。现在每条连接各自 try/catch，
   * 坏连接就地关掉，不影响其他人。
   */
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

  private broadcast(message: unknown): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, message)
  }

  /**
   * 往一条连接发消息。**绝不向外抛异常。**
   *
   * 权威状态已经推进成功这件事，不该因为某个玩家的 socket 发送失败而被判定为失败。
   * 发不出去就把这条连接关掉，让客户端走正常重连拿全量状态。
   */
  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch (cause) {
      const user = (() => {
        try { return socket.deserializeAttachment() as SocketAttachment | null } catch { return null }
      })()
      console.error('[sanguosha][socket-send-error]', JSON.stringify({
        roomCode: this.coordinator?.state.code,
        userId: user?.userId,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      }))
      try { socket.close(1011, 'send failed') } catch { /* 已经断了就算了 */ }
    }
  }

  /**
   * 同一个用户重连时，关掉他之前那条连接。
   *
   * **顺序很重要**：必须等新连接 accept 完成之后再关旧的。反过来的话，
   * 旧连接的 `webSocketClose` 会在新连接建立之前跑，那时
   * `getWebSockets(user:X)` 里一条有效连接都没有，于是把玩家误判为掉线并进托管。
   */
  private closeSupersededSockets(userId: string, keep: WebSocket): void {
    for (const socket of this.state.getWebSockets(`user:${userId}`)) {
      if (socket === keep) continue
      try {
        socket.close(1000, 'superseded by newer connection')
      } catch { /* 已经关掉的连接忽略 */ }
    }
  }
}

export class MahjongLobby {
  // 除了推送房间列表变化，它还兼职存全局设置（托管档位、维护开关）
  constructor(private readonly state: DurableObjectState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/socket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const userId = request.headers.get('x-user-id') ?? ''
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      // 打上 tag，顶号时才能只关掉这个人的大厅连接
      this.state.acceptWebSocket(server, userId ? [`user:${userId}`] : [])
      return new Response(null, { status: 101, webSocket: client })
    }
    if (url.pathname === '/session/claim' && request.method === 'POST') {
      const body = await request.json<{ userId: string; nickname: string; sessionId: string }>()
      const previousId = await this.state.storage.get<string>(`current:${body.userId}`)
      if (previousId) await this.state.storage.delete(`session:${previousId}`)
      await this.state.storage.put(`session:${body.sessionId}`, {
        sessionId: body.sessionId,
        userId: body.userId,
        nickname: body.nickname,
        at: Date.now(),
      } satisfies SessionRecord)
      await this.state.storage.put(`current:${body.userId}`, body.sessionId)
      // 同一个人挂在大厅的旧连接直接请出去，不然它还会继续收房间列表推送
      for (const socket of this.state.getWebSockets(`user:${body.userId}`)) {
        if (socket.readyState !== WebSocket.OPEN) continue
        socket.send(JSON.stringify({ type: 'session-superseded' }))
        socket.close(SESSION_SUPERSEDED_CODE, '昵称已在别处登录')
      }
      return json({ ok: true })
    }
    if (url.pathname === '/session/resolve' && request.method === 'POST') {
      const body = await request.json<{ sessionId: string }>()
      const record = await this.state.storage.get<SessionRecord>(`session:${body.sessionId}`)
      const currentId = record ? await this.state.storage.get<string>(`current:${record.userId}`) : undefined
      // 有效期固定 30 天、不滑动续期，判定逻辑见 session-policy.ts
      const resolution = resolveStoredSession(body.sessionId, record, currentId, Date.now())
      if (!resolution.ok) {
        if (resolution.dropSession) await this.state.storage.delete(`session:${body.sessionId}`)
        if (resolution.dropCurrentPointer && record) await this.state.storage.delete(`current:${record.userId}`)
        return json({ error: resolution.error }, 401)
      }
      return json({ user: { userId: resolution.userId, nickname: resolution.nickname } })
    }
    if (url.pathname === '/session/revoke' && request.method === 'POST') {
      const body = await request.json<{ sessionId: string }>()
      const record = await this.state.storage.get<SessionRecord>(`session:${body.sessionId}`)
      await this.state.storage.delete(`session:${body.sessionId}`)
      if (record) {
        const currentId = await this.state.storage.get<string>(`current:${record.userId}`)
        if (currentId === body.sessionId) await this.state.storage.delete(`current:${record.userId}`)
      }
      return json({ ok: true })
    }
    if (url.pathname === '/settings') {
      if (request.method === 'PUT') {
        const incoming = await request.json<Record<string, unknown>>()
        await this.state.storage.put('settings', incoming)
        return json(incoming)
      }
      const stored = await this.state.storage.get<Record<string, unknown>>('settings')
      return json(stored ?? {})
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
