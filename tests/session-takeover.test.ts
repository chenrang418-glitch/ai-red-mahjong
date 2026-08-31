import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { SESSION_SUPERSEDED_CODE } from '@/online/types'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

async function loginAs(nickname: string): Promise<{ cookie: string; userId: string }> {
  const response = await api('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const result = await response.json() as { userId: string }
  return { cookie, userId: result.userId }
}

function createRoomWith(cookie: string): Promise<Response> {
  return api('/api/rooms', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ settings: {} }),
  })
}

async function openRoomSocket(code: string, cookie: string): Promise<WebSocket> {
  const response = await mf.dispatchFetch(
    `https://example.com/api/rooms/${code}/socket`,
    { headers: { Upgrade: 'websocket', Cookie: cookie } } as never,
  ) as unknown as Response & { webSocket: WebSocket | null }
  if (!response.webSocket) throw new Error('服务器没有升级成 WebSocket')
  response.webSocket.accept()
  return response.webSocket
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = ['0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql', '0005_remove_player_stats.sql']
    .map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'session-takeover-test', compatibilityDate: '2026-08-15', modules: true, script,
    durableObjects: { ROOMS: { className: 'MahjongRoom', useSQLite: true }, LOBBY: { className: 'MahjongLobby', useSQLite: true } },
    d1Databases: { DB: 'session-takeover-db' },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => { await mf?.dispose() })

describe('HttpOnly opaque 会话', () => {
  it('查询会话在未登录时返回空值，登录后只返回公开身份', async () => {
    expect(await (await api('/api/session')).json()).toEqual({ session: null })
    const loggedIn = await loginAs('会话查询')
    const response = await api('/api/session', { headers: { cookie: loggedIn.cookie } })
    expect(await response.json()).toEqual({ session: { userId: loggedIn.userId, nickname: '会话查询' } })
  })

  it('只接受随机 Cookie，旧 Base64/Authorization/URL token 全部失效', async () => {
    const session = await loginAs('会话甲')
    expect(session.cookie).toMatch(/^mahjong_session=[A-Za-z0-9_-]{40,}$/)

    const legacy = Buffer.from(JSON.stringify({ userId: session.userId, nickname: '会话甲' })).toString('base64url')
    const forged = await api(`/api/rooms?session=${legacy}`, {
      method: 'POST', headers: { authorization: `Bearer ${legacy}`, 'content-type': 'application/json' }, body: JSON.stringify({ settings: {} }),
    })
    expect(forged.status).toBe(400)
  })

  it('同一昵称再次登录后，旧 Cookie 失效而新 Cookie 可用', async () => {
    const first = await loginAs('会话乙')
    const second = await loginAs('会话乙')
    expect(second.userId).toBe(first.userId)
    expect(second.cookie).not.toBe(first.cookie)
    expect((await createRoomWith(first.cookie)).status).toBe(400)
    expect((await createRoomWith(second.cookie)).status).toBe(201)
  })

  it('同名顶号后旧 Cookie 的重连会收到专门关闭码', async () => {
    const first = await loginAs('会话丙')
    const created = await createRoomWith(first.cookie)
    const { code } = await created.json() as { code: string }
    await loginAs('会话丙')
    const socket = await openRoomSocket(code, first.cookie)
    const closed = new Promise<number>((resolveClose) => socket.addEventListener('close', (event) => resolveClose(event.code), { once: true }))
    await expect(closed).resolves.toBe(SESSION_SUPERSEDED_CODE)
  })

  it('房间列表只把当前用户自己的座位标记为可重新进入', async () => {
    const owner = await loginAs('回房甲')
    const created = await createRoomWith(owner.cookie)
    const { code } = await created.json() as { code: string }
    const ownerRooms = await (await api('/api/rooms', { headers: { cookie: owner.cookie } })).json() as { rooms: Array<{ code: string; rejoinable: boolean }> }
    expect(ownerRooms.rooms.find((entry) => entry.code === code)?.rejoinable).toBe(true)

    const other = await loginAs('回房乙')
    const otherRooms = await (await api('/api/rooms', { headers: { cookie: other.cookie } })).json() as { rooms: Array<{ code: string; rejoinable: boolean }> }
    expect(otherRooms.rooms.find((entry) => entry.code === code)?.rejoinable).toBe(false)
  })
})
