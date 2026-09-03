import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * 全站停服开关。
 *
 * 这一组里**最重要的一条是「不能把管理员锁在外面」**：停服开关本身是在管理页关掉的，
 * 如果拦截写得太靠前，把 `/api/admin/*` 或 `/api/service` 一起挡了，
 * 开关一旦打开就再也关不掉，只能去改数据库。
 *
 * 另一条是要和「全站维护模式」分清楚：维护只拦「开新房」，停服是所有人都进不来。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'
let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

const adminHeaders = () => ({ authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' })

async function putSettings(patch: Record<string, unknown>): Promise<Response> {
  return api('/api/admin/settings', { method: 'PUT', headers: adminHeaders(), body: JSON.stringify(patch) })
}

async function readService(): Promise<Record<string, unknown>> {
  return (await api('/api/service')).json() as Promise<Record<string, unknown>>
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  const migrations = ['0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql', '0004_admin_audit.sql', '0005_remove_player_stats.sql']
    .map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'site-closed-test', compatibilityDate: '2026-08-15', modules: true, script,
    durableObjects: { ROOMS: { className: 'MahjongRoom', useSQLite: true }, LOBBY: { className: 'MahjongLobby', useSQLite: true } },
    d1Databases: { DB: 'site-closed-test-db' }, bindings: { ADMIN_TOKEN },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 60_000)

// 每条用例跑完都恢复默认，别让一条打开的停服开关污染后面的用例
afterEach(async () => { await putSettings({}) })
afterAll(async () => { await mf?.dispose() })

describe('默认状态', () => {
  it('/api/service 报告未停服、无公告', async () => {
    const service = await readService()
    expect(service.siteClosed).toBe(false)
    expect(service.notice).toBe('')
    expect(typeof service.siteClosedMessage).toBe('string')
  })
})

describe('打开全站停服之后', () => {
  it('玩家接口一律 503，并带上管理员写的提示语', async () => {
    await putSettings({ siteClosed: true, siteClosedMessage: '今晚维护到十点' })

    for (const path of ['/api/rooms', '/api/sanguosha/rooms', '/api/session']) {
      const response = await api(path)
      expect(response.status, `${path} 应该被停服拦下`).toBe(503)
      const body = await response.json() as { error: string; siteClosed?: boolean }
      expect(body.error).toBe('今晚维护到十点')
      expect(body.siteClosed).toBe(true)
    }
  })

  it('创建房间也进不去，两款游戏一起停', async () => {
    await putSettings({ siteClosed: true })
    for (const path of ['/api/rooms', '/api/sanguosha/rooms']) {
      const response = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(response.status, `${path} 建房应该被拦`).toBe(503)
    }
  })

  it('管理接口必须继续放行，否则开关就再也关不掉了', async () => {
    await putSettings({ siteClosed: true })
    const settings = await api('/api/admin/settings', { headers: adminHeaders() })
    expect(settings.status).toBe(200)
    expect((await settings.json() as { siteClosed: boolean }).siteClosed).toBe(true)

    // 真的能关掉
    expect((await putSettings({ siteClosed: false })).status).toBe(200)
    expect((await readService()).siteClosed).toBe(false)
    expect((await api('/api/rooms')).status).not.toBe(503)
  })

  it('/api/service 和 /api/health 继续可用——前端要靠它才知道自己该显示停服页', async () => {
    await putSettings({ siteClosed: true, siteClosedMessage: '停服中' })
    const service = await api('/api/service')
    expect(service.status).toBe(200)
    expect(await service.json()).toMatchObject({ siteClosed: true, siteClosedMessage: '停服中' })
    expect((await api('/api/health')).status).toBe(200)
  })
})

describe('停服和维护是两级，不能混为一谈', () => {
  it('只开维护模式时，玩家接口照常可访问', async () => {
    await putSettings({ maintenance: true, maintenanceMessage: '暂停开新房' })
    expect((await api('/api/rooms')).status).not.toBe(503)
    const service = await readService()
    expect(service.maintenance).toBe(true)
    expect(service.siteClosed).toBe(false)
  })

  it('只开维护模式时，建新房仍然被拦，提示语用维护那一条', async () => {
    // 维护的拦截在会话校验之后，所以要先真的登录一个，否则拿到的是 400 而不是 503
    const login = await api('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: '维护测试' }) })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie, '登录应该下发会话 Cookie').toBeTruthy()

    await putSettings({ maintenance: true, maintenanceMessage: '暂停开新房' })
    const response = await api('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    expect(response.status).toBe(503)
    expect((await response.json() as { error: string }).error).toBe('暂停开新房')
  })
})

describe('公告文案的处理', () => {
  it('公告留空就是「不显示」，不能像提示语那样回退到默认值', async () => {
    await putSettings({ notice: '   ' })
    expect((await readService()).notice).toBe('')
  })

  it('公告会被裁到上限，管理端塞一整篇进来也撑不坏界面', async () => {
    await putSettings({ notice: 'x'.repeat(500) })
    expect(String((await readService()).notice).length).toBe(200)
  })

  it('停服提示语留空时回退到默认文案，不会显示成一片空白', async () => {
    await putSettings({ siteClosed: true, siteClosedMessage: '' })
    const service = await readService()
    expect(String(service.siteClosedMessage).length).toBeGreaterThan(0)
  })

  it('改动写进审计记录', async () => {
    await putSettings({ siteClosed: true, notice: '晚上见' })
    const audit = await (await api('/api/admin/audit', { headers: adminHeaders() })).json() as { entries: Array<{ action: string; detail: string }> }
    const entry = audit.entries.find((candidate) => candidate.action === 'update-settings')
    expect(entry?.detail).toContain('全站停服=开')
    expect(entry?.detail).toContain('公告=有')
  })
})
