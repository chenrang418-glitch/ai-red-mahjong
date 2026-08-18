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

async function loginAs(nickname: string): Promise<{ token: string; userId: string }> {
  const response = await api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  })
  return await response.json() as { token: string; userId: string }
}

function createRoomWith(token: string): Promise<Response> {
  return api('/api/rooms', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {} }),
  })
}

// 连上房间，返回这条连接的关闭码（超时算没关）
async function roomSocketCloseCode(code: string, token: string): Promise<number | 'open'> {
  const response = await mf.dispatchFetch(
    `https://example.com/api/rooms/${code}/socket?session=${encodeURIComponent(token)}`,
    { headers: { Upgrade: 'websocket' } } as never,
  ) as unknown as Response & { webSocket: WebSocket | null }
  const socket = response.webSocket
  if (!socket) throw new Error('服务器没有升级成 WebSocket')
  socket.accept()
  return await new Promise<number | 'open'>((resolveResult) => {
    const timer = setTimeout(() => resolveResult('open'), 1500)
    socket.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer)
      resolveResult(event.code)
    })
  })
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = [
    '0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql',
  ].map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'session-takeover-test',
      compatibilityDate: '2026-08-15',
      modules: true,
      script,
      durableObjects: {
        ROOMS: { className: 'MahjongRoom', useSQLite: true },
        LOBBY: { className: 'MahjongLobby', useSQLite: true },
      },
      d1Databases: { DB: 'session-takeover-db' },
    }],
  }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => {
  await mf?.dispose()
})

describe('同名登录顶号', () => {
  it('同一昵称两次登录，只有后一次能建房', async () => {
    const first = await loginAs('顶号甲')
    const second = await loginAs('顶号甲')
    // 同名本来就是同一个用户，区别只在这一次登录
    expect(second.userId).toBe(first.userId)
    expect(second.token).not.toBe(first.token)

    const stale = await createRoomWith(first.token)
    expect(stale.status).toBe(409)
    expect((await stale.json() as { error: string }).error).toContain('别的设备')

    const fresh = await createRoomWith(second.token)
    expect(fresh.status).toBe(201)
  })

  it('旧连接被顶下线，用的是专门的关闭码而不是普通断线', async () => {
    const first = await loginAs('顶号乙')
    const created = await createRoomWith(first.token)
    const { code } = await created.json() as { code: string }
    // 先确认这张旧票原本是能进房间的
    expect(await roomSocketCloseCode(code, first.token)).toBe('open')

    await loginAs('顶号乙')
    expect(await roomSocketCloseCode(code, first.token)).toBe(SESSION_SUPERSEDED_CODE)
  })

  it('顶号只认这一个人，同房间的别人不受影响', async () => {
    const host = await loginAs('顶号丙')
    const created = await createRoomWith(host.token)
    const { code } = await created.json() as { code: string }
    const guest = await loginAs('顶号丁')
    expect(await roomSocketCloseCode(code, guest.token)).toBe('open')

    await loginAs('顶号丙')
    expect(await roomSocketCloseCode(code, guest.token)).toBe('open')
    expect(await roomSocketCloseCode(code, host.token)).toBe(SESSION_SUPERSEDED_CODE)
  })

  it('自己坐在里面的房间标成可以回去，别人的房间不受影响', async () => {
    const owner = await loginAs('回房甲')
    const created = await createRoomWith(owner.token)
    const { code } = await created.json() as { code: string }

    const listForOwner = await (await api('/api/rooms', { headers: { authorization: `Bearer ${owner.token}` } })).json() as {
      rooms: Array<{ code: string; rejoinable: boolean }>
    }
    expect(listForOwner.rooms.find((entry) => entry.code === code)?.rejoinable).toBe(true)

    // 别人看同一个房间，就是普通的可加入，不是「返回牌局」
    const other = await loginAs('回房乙')
    const listForOther = await (await api('/api/rooms', { headers: { authorization: `Bearer ${other.token}` } })).json() as {
      rooms: Array<{ code: string; rejoinable: boolean }>
    }
    expect(listForOther.rooms.find((entry) => entry.code === code)?.rejoinable).toBe(false)
  })

  it('上线前签发的旧票仍然可用，不会把在场的人一刀切断', async () => {
    const user = await loginAs('顶号戊')
    // 旧版 token 里没有 sessionId，只有 userId 和昵称
    const legacy = Buffer.from(JSON.stringify({ userId: user.userId, nickname: '顶号戊' }), 'utf8').toString('base64url')
    expect((await createRoomWith(legacy)).status).toBe(201)
  })
})
