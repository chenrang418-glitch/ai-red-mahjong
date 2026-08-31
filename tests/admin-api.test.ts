import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'
let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}
const adminHeaders = (token = ADMIN_TOKEN) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = ['0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql', '0005_remove_player_stats.sql']
    .map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'admin-test', compatibilityDate: '2026-08-15', modules: true, script,
    durableObjects: { ROOMS: { className: 'MahjongRoom', useSQLite: true }, LOBBY: { className: 'MahjongLobby', useSQLite: true } },
    d1Databases: { DB: 'admin-test-db' }, bindings: { ADMIN_TOKEN },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 60_000)

afterAll(async () => { await mf?.dispose() })

async function seedUser(nickname: string): Promise<string> {
  const response = await api('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) })
  return (await response.json() as { userId: string }).userId
}

describe('管理接口', () => {
  it('没有密钥、密钥错误或查询参数传密钥时都返回 404', async () => {
    expect((await api('/api/admin/users')).status).toBe(404)
    expect((await api('/api/admin/users', { headers: adminHeaders('wrong') })).status).toBe(404)
    expect((await api(`/api/admin/users?token=${ADMIN_TOKEN}`)).status).toBe(404)
  })

  it('只返回最低限度的用户信息，不再包含长期战绩', async () => {
    await seedUser('管理测试甲')
    const response = await api('/api/admin/users', { headers: adminHeaders() })
    const payload = await response.json() as { users: Array<Record<string, unknown>> }
    const user = payload.users.find((entry) => entry.nickname === '管理测试甲')
    expect(user).toMatchObject({ nickname: '管理测试甲' })
    expect(user).not.toHaveProperty('wins')
    expect(user).not.toHaveProperty('totalGames')
  })

  it('删除用户后记录消失并写入审计', async () => {
    const userId = await seedUser('管理测试乙')
    expect((await api(`/api/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders() })).status).toBe(200)
    const users = await (await api('/api/admin/users', { headers: adminHeaders() })).json() as { users: Array<{ userId: string }> }
    expect(users.users.some((user) => user.userId === userId)).toBe(false)
    const audit = await (await api('/api/admin/audit', { headers: adminHeaders() })).json() as { entries: Array<{ action: string; target: string }> }
    expect(audit.entries.some((entry) => entry.action === 'delete-user' && entry.target === userId)).toBe(true)
  })

  it('排行榜与战绩重置接口已删除', async () => {
    expect((await api('/api/leaderboard')).status).toBe(404)
    expect((await api('/api/admin/leaderboard/reset', { method: 'POST', headers: adminHeaders() })).status).toBe(404)
  })
})
