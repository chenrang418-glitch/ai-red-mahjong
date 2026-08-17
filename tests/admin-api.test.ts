import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'

let mf: Miniflare

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

function adminHeaders(token = ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

beforeAll(async () => {
  // 这些用例跑的是真正打包出来的 Worker，所以每次都先构建一遍，
  // 避免拿到过期产物得出「假通过」，也让 CI 不必依赖步骤顺序。
  execSync('npx vite build --config server/vite.config.ts --configLoader runner', { cwd: root, stdio: 'pipe' })
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = [
    readFileSync(resolve(root, 'server/migrations/0001_online.sql'), 'utf8'),
    readFileSync(resolve(root, 'server/migrations/0002_room_directory.sql'), 'utf8'),
    readFileSync(resolve(root, 'server/migrations/0003_room_phase.sql'), 'utf8'),
  ]
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'admin-test',
      compatibilityDate: '2026-08-15',
      modules: true,
      script,
      durableObjects: {
        ROOMS: { className: 'MahjongRoom', useSQLite: true },
        LOBBY: { className: 'MahjongLobby', useSQLite: true },
      },
      d1Databases: { DB: 'admin-test-db' },
      bindings: { ADMIN_TOKEN },
    }],
  }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 60_000)

afterAll(async () => {
  await mf?.dispose()
})

async function seedUser(nickname: string): Promise<string> {
  const response = await api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  })
  const payload = await response.json() as { userId: string }
  return payload.userId
}

describe('管理接口', () => {
  it('没有密钥、密钥错误时一律返回 404，不暴露接口存在', async () => {
    const anonymous = await api('/api/admin/users')
    expect(anonymous.status).toBe(404)

    const wrong = await api('/api/admin/users', { headers: adminHeaders('wrong-token') })
    expect(wrong.status).toBe(404)

    // 长度不同也不能泄露信息
    const short = await api('/api/admin/users', { headers: adminHeaders('x') })
    expect(short.status).toBe(404)
  })

  it('密钥不接受从查询参数传入', async () => {
    const viaQuery = await api(`/api/admin/users?token=${ADMIN_TOKEN}`)
    expect(viaQuery.status).toBe(404)
  })

  it('带正确密钥可以列出用户和战绩', async () => {
    await seedUser('管理测试甲')
    const response = await api('/api/admin/users', { headers: adminHeaders() })
    expect(response.status).toBe(200)
    const payload = await response.json() as { users: Array<{ nickname: string; totalGames: number }> }
    expect(payload.users.some((user) => user.nickname === '管理测试甲')).toBe(true)
  })

  it('删除用户会连同战绩一起清掉，排行榜上不再出现', async () => {
    const userId = await seedUser('管理测试乙')
    const db = await mf.getD1Database('DB')
    await db.prepare(`
      INSERT INTO round_player_results (match_id, round_number, user_id, won, seven_pairs, gang_count, ma_count, created_at)
      VALUES ('m1', 1, ?, 1, 0, 2, 3, ?)
    `).bind(userId, Date.now()).run()

    const before = await (await api('/api/leaderboard')).json() as { entries: Array<{ nickname: string }> }
    expect(before.entries.some((entry) => entry.nickname === '管理测试乙')).toBe(true)

    const deleted = await api(`/api/admin/users/${userId}`, { method: 'DELETE', headers: adminHeaders() })
    expect(deleted.status).toBe(200)

    const after = await (await api('/api/leaderboard')).json() as { entries: Array<{ nickname: string }> }
    expect(after.entries.some((entry) => entry.nickname === '管理测试乙')).toBe(false)
    const rows = await db.prepare('SELECT COUNT(*) AS count FROM round_player_results WHERE user_id = ?').bind(userId).first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })

  it('清空单个用户的战绩会保留账号', async () => {
    const userId = await seedUser('管理测试丙')
    const db = await mf.getD1Database('DB')
    await db.prepare(`
      INSERT INTO round_player_results (match_id, round_number, user_id, won, seven_pairs, gang_count, ma_count, created_at)
      VALUES ('m2', 1, ?, 1, 1, 1, 1, ?)
    `).bind(userId, Date.now()).run()

    const reset = await api(`/api/admin/users/${userId}/reset`, { method: 'POST', headers: adminHeaders() })
    expect(reset.status).toBe(200)

    const stats = await db.prepare('SELECT total_games, wins FROM user_stats WHERE user_id = ?').bind(userId).first<{ total_games: number; wins: number }>()
    expect(stats).toMatchObject({ total_games: 0, wins: 0 })
    const user = await db.prepare('SELECT nickname FROM users WHERE id = ?').bind(userId).first<{ nickname: string }>()
    expect(user?.nickname).toBe('管理测试丙')
  })

  it('清空排行榜会把所有人的战绩归零但保留账号', async () => {
    const userId = await seedUser('管理测试丁')
    const db = await mf.getD1Database('DB')
    await db.prepare(`
      INSERT INTO round_player_results (match_id, round_number, user_id, won, seven_pairs, gang_count, ma_count, created_at)
      VALUES ('m3', 1, ?, 1, 0, 0, 0, ?)
    `).bind(userId, Date.now()).run()

    const cleared = await api('/api/admin/leaderboard/reset', { method: 'POST', headers: adminHeaders() })
    expect(cleared.status).toBe(200)

    const remaining = await db.prepare('SELECT COUNT(*) AS count FROM round_player_results').first<{ count: number }>()
    expect(remaining?.count).toBe(0)
    const totals = await db.prepare('SELECT SUM(total_games) AS total FROM user_stats').first<{ total: number }>()
    expect(totals?.total ?? 0).toBe(0)
    const stillThere = await db.prepare('SELECT COUNT(*) AS count FROM users').first<{ count: number }>()
    expect(stillThere!.count).toBeGreaterThan(0)
  })

  it('玩家接口不受管理密钥影响，仍然正常工作', async () => {
    const health = await api('/api/health')
    expect(health.status).toBe(200)
    const session = await api('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: '普通玩家' }),
    })
    expect(session.status).toBe(200)
  })
})
