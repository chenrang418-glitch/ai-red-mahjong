import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const ADMIN_TOKEN = 'rooms-admin-token-0123456789'

let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }

async function loginAs(nickname: string): Promise<string> {
  const response = await api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  })
  return (await response.json() as { token: string }).token
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = [
    '0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql',
  ].map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'admin-rooms-test',
      compatibilityDate: '2026-08-15',
      modules: true,
      script,
      durableObjects: {
        ROOMS: { className: 'MahjongRoom', useSQLite: true },
        LOBBY: { className: 'MahjongLobby', useSQLite: true },
      },
      d1Databases: { DB: 'admin-rooms-db' },
      bindings: { ADMIN_TOKEN },
    }],
  }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => {
  await mf?.dispose()
})

describe('管理端房间与联机设置', () => {
  it('能看到服务器上的全部房间', async () => {
    const token = await loginAs('房主甲')
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { mode: 'finite', initialPoints: 30, claimWindowMs: 4000 } }),
    })
    expect(created.status).toBe(201)
    const { code } = await created.json() as { code: string }

    const listed = await api('/api/admin/rooms', { headers: adminHeaders })
    expect(listed.status).toBe(200)
    const payload = await listed.json() as { rooms: Array<{ code: string; phase: string }> }
    expect(payload.rooms.some((room) => room.code === code)).toBe(true)
  })

  it('强制解散后房间从列表里消失，且留下操作记录', async () => {
    const token = await loginAs('房主乙')
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    })
    const { code } = await created.json() as { code: string }

    const destroyed = await api(`/api/admin/rooms/${code}`, { method: 'DELETE', headers: adminHeaders })
    expect(destroyed.status).toBe(200)

    const listed = await api('/api/admin/rooms', { headers: adminHeaders })
    const payload = await listed.json() as { rooms: Array<{ code: string }> }
    expect(payload.rooms.some((room) => room.code === code)).toBe(false)

    const audit = await api('/api/admin/audit', { headers: adminHeaders })
    const entries = (await audit.json() as { entries: Array<{ action: string; target: string | null }> }).entries
    expect(entries.some((entry) => entry.action === 'destroy-room' && entry.target === code)).toBe(true)
  })

  it('房主能选空位 AI 档位，托管档位只认服务端设置', async () => {
    await api('/api/admin/settings', {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ trusteeDifficulty: 'expert', maintenance: false }),
    })
    const token = await loginAs('房主丙')
    const created = await api('/api/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // 客户端就算硬塞 trusteeDifficulty 也不该被采纳
      body: JSON.stringify({ settings: { aiDifficulty: 'beginner', trusteeDifficulty: 'beginner' } }),
    })
    expect(created.status).toBe(201)

    const settings = await (await api('/api/admin/settings', { headers: adminHeaders })).json() as { trusteeDifficulty: string }
    expect(settings.trusteeDifficulty).toBe('expert')
  })

  it('维护模式只拦创建房间，不影响查询和已有房间', async () => {
    await api('/api/admin/settings', {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ trusteeDifficulty: 'beginner', maintenance: true, maintenanceMessage: '正在升级，稍后再来' }),
    })

    const service = await (await api('/api/service')).json() as { maintenance: boolean; maintenanceMessage: string }
    expect(service.maintenance).toBe(true)
    expect(service.maintenanceMessage).toContain('升级')

    const token = await loginAs('房主丁')
    const blocked = await api('/api/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    })
    expect(blocked.status).toBe(503)
    expect((await blocked.json() as { error: string }).error).toContain('升级')

    // 房间列表这类只读接口照常
    const rooms = await api('/api/rooms', { headers: { authorization: `Bearer ${token}` } })
    expect(rooms.status).toBe(200)

    // 关掉维护后又能开房
    await api('/api/admin/settings', {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ trusteeDifficulty: 'beginner', maintenance: false }),
    })
    const allowed = await api('/api/rooms', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: {} }),
    })
    expect(allowed.status).toBe(201)
  })

  it('管理端房间接口同样受密钥保护', async () => {
    expect((await api('/api/admin/rooms')).status).toBe(404)
    expect((await api('/api/admin/settings')).status).toBe(404)
    expect((await api('/api/admin/audit')).status).toBe(404)
    expect((await api('/api/admin/rooms/ABC234', { method: 'DELETE' })).status).toBe(404)
  })
})
