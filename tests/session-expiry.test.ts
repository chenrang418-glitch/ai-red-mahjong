import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import {
  SESSION_MAX_AGE_MS,
  SESSION_MAX_AGE_SECONDS,
  isSessionExpired,
  resolveStoredSession,
  type StoredSession,
} from '../server/session-policy'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

async function loginAs(nickname: string): Promise<{ cookie: string; sessionId: string; userId: string }> {
  const response = await api('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }),
  })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  const result = await response.json() as { userId: string }
  return { cookie, sessionId: cookie.split('=')[1], userId: result.userId }
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = ['0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql', '0005_remove_player_stats.sql']
    .map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'session-expiry-test', compatibilityDate: '2026-08-15', modules: true, script,
      durableObjects: { ROOMS: { className: 'MahjongRoom', useSQLite: true }, LOBBY: { className: 'MahjongLobby', useSQLite: true } },
      d1Databases: { DB: 'session-expiry-db' },
    }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => { await mf?.dispose() })

describe('会话有效期判定', () => {
  const day = 24 * 60 * 60 * 1000

  it('Cookie 秒数和服务端毫秒数是同一个值', () => {
    expect(SESSION_MAX_AGE_MS).toBe(SESSION_MAX_AGE_SECONDS * 1000)
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it('29 天 23 小时仍然有效', () => {
    const issuedAt = 1_700_000_000_000
    expect(isSessionExpired(issuedAt, issuedAt + 29 * day + 23 * 60 * 60 * 1000)).toBe(false)
  })

  it('差 1 毫秒到 30 天仍然有效', () => {
    const issuedAt = 1_700_000_000_000
    expect(isSessionExpired(issuedAt, issuedAt + SESSION_MAX_AGE_MS - 1)).toBe(false)
  })

  it('正好 30 天算过期', () => {
    const issuedAt = 1_700_000_000_000
    expect(isSessionExpired(issuedAt, issuedAt + SESSION_MAX_AGE_MS)).toBe(true)
  })

  it('超过 30 天算过期', () => {
    const issuedAt = 1_700_000_000_000
    expect(isSessionExpired(issuedAt, issuedAt + SESSION_MAX_AGE_MS + 1)).toBe(true)
    expect(isSessionExpired(issuedAt, issuedAt + 60 * day)).toBe(true)
  })
})

describe('会话解析的四个分支', () => {
  const now = 1_800_000_000_000
  function record(at: number): StoredSession {
    return { sessionId: 's1', userId: 'u1', nickname: '小陈', at }
  }

  it('记录不存在：拒绝，但没有东西要清', () => {
    expect(resolveStoredSession('s1', undefined, undefined, now)).toEqual({
      ok: false, error: '会话不存在', dropSession: false, dropCurrentPointer: false,
    })
  })

  it('未过期且是当前会话：放行', () => {
    expect(resolveStoredSession('s1', record(now - 1000), 's1', now)).toEqual({
      ok: true, userId: 'u1', nickname: '小陈',
    })
  })

  it('刚好满 30 天：拒绝，并清掉记录和 current 指针', () => {
    expect(resolveStoredSession('s1', record(now - SESSION_MAX_AGE_MS), 's1', now)).toEqual({
      ok: false, error: '会话已过期', dropSession: true, dropCurrentPointer: true,
    })
  })

  it('差 1 毫秒到 30 天：仍然放行', () => {
    expect(resolveStoredSession('s1', record(now - SESSION_MAX_AGE_MS + 1), 's1', now).ok).toBe(true)
  })

  it('过期但 current 已经指向别的会话：只删自己那条，不动指针', () => {
    // 这个人已经在别处重新登录过了，清指针会把新会话一起打掉
    expect(resolveStoredSession('s1', record(now - SESSION_MAX_AGE_MS), 's2', now)).toEqual({
      ok: false, error: '会话已过期', dropSession: true, dropCurrentPointer: false,
    })
  })

  it('未过期但被同名顶号：拒绝，且不清理存储', () => {
    expect(resolveStoredSession('s1', record(now - 1000), 's2', now)).toEqual({
      ok: false, error: '会话已失效', dropSession: false, dropCurrentPointer: false,
    })
  })
})

describe('真实链路冒烟', () => {
  it('刚登录的会话可用，登出后立刻失效', async () => {
    const session = await loginAs('新鲜会话')
    const ok = await api('/api/session', { headers: { cookie: session.cookie } })
    expect(await ok.json()).toMatchObject({ session: { nickname: '新鲜会话' } })

    await api('/api/session', { method: 'DELETE', headers: { cookie: session.cookie } })
    expect(await (await api('/api/session', { headers: { cookie: session.cookie } })).json()).toEqual({ session: null })
  })
})
