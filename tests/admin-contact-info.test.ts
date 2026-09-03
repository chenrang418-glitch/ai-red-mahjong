import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * 「联系开发者」弹窗的号码不写死在前端，走 ServerSettings 的 contactMethod/contactValue
 * 两个字段。这里验证的是端到端的那条链路：管理员 PUT /api/admin/settings 改了之后，
 * 玩家侧 /api/service 能立刻拿到新值——这条链路走不通的话，前端弹窗改的兜底值再对也没用。
 *
 * 两个字段要分开存、分开传，不能拼成一条自由文本：「复制」按钮只该复制号码本身，
 * 拼成一条字符串会让「方式」标签也被一起复制进用户粘贴板。
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
    name: 'admin-contact-info-test', compatibilityDate: '2026-08-15', modules: true, script,
    durableObjects: { ROOMS: { className: 'MahjongRoom', useSQLite: true }, LOBBY: { className: 'MahjongLobby', useSQLite: true } },
    d1Databases: { DB: 'admin-contact-info-test-db' }, bindings: { ADMIN_TOKEN },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 60_000)

afterEach(async () => { await putSettings({ contactMethod: 'QQ', contactValue: '1507394636' }) })
afterAll(async () => { await mf?.dispose() })

describe('默认状态', () => {
  it('/api/service 下发默认联系方式：QQ / 1507394636', async () => {
    const service = await readService()
    expect(service.contactMethod).toBe('QQ')
    expect(service.contactValue).toBe('1507394636')
  })
})

describe('管理员改了之后', () => {
  it('两个字段各自更新，立刻反映到 /api/service', async () => {
    expect((await putSettings({ contactMethod: '微信', contactValue: 'crplay_dev' })).status).toBe(200)
    const service = await readService()
    expect(service.contactMethod).toBe('微信')
    expect(service.contactValue).toBe('crplay_dev')
  })

  it('方式可以是邮箱，不限定必须是 QQ/微信这类即时通讯账号', async () => {
    await putSettings({ contactMethod: '邮箱', contactValue: 'dev@crplay.cn' })
    const service = await readService()
    expect(service.contactMethod).toBe('邮箱')
    expect(service.contactValue).toBe('dev@crplay.cn')
  })

  it('PUT 是整份设置覆盖，不是按字段合并——这与其余设置字段的既有行为一致', async () => {
    // AdminPanel 的 saveSettings() 每次都是把完整的 settings.value PUT 上去，
    // 不存在「只改一个字段」的用法。这里钉住实际语义：请求体里没带的字段
    // 会被裁成空串再回退到默认值，而不是保留服务端已有值——避免以后有人
    // 误以为这是按字段合并的 PATCH，写出「只传 contactValue 就能保留
    // contactMethod」这种错误假设的代码。
    await putSettings({ contactMethod: '微信', contactValue: 'crplay_dev' })
    await putSettings({ contactValue: 'crplay_dev_2' })
    const service = await readService()
    expect(service.contactMethod).toBe('QQ')
    expect(service.contactValue).toBe('crplay_dev_2')
  })
})

describe('输入清洗', () => {
  it('两端空白会被裁掉', async () => {
    await putSettings({ contactMethod: '  QQ  ', contactValue: '  123456  ' })
    const service = await readService()
    expect(service.contactMethod).toBe('QQ')
    expect(service.contactValue).toBe('123456')
  })

  it('留空或全空白会回退到默认值，不会让弹窗显示成一片空白', async () => {
    await putSettings({ contactMethod: '   ', contactValue: '' })
    const service = await readService()
    expect(service.contactMethod).toBe('QQ')
    expect(service.contactValue).toBe('1507394636')
  })

  it('超长输入会被裁到上限，不会撑坏弹窗布局', async () => {
    await putSettings({ contactMethod: 'x'.repeat(100), contactValue: 'y'.repeat(200) })
    const service = await readService()
    expect(String(service.contactMethod).length).toBeLessThanOrEqual(20)
    expect(String(service.contactValue).length).toBeLessThanOrEqual(60)
  })
})

describe('管理接口读取', () => {
  it('GET /api/admin/settings 也能读到当前的两个字段，供后台表单回填', async () => {
    await putSettings({ contactMethod: '微信', contactValue: 'crplay_dev' })
    const settings = await api('/api/admin/settings', { headers: adminHeaders() })
    expect(settings.status).toBe(200)
    const body = await settings.json() as { contactMethod: string; contactValue: string }
    expect(body.contactMethod).toBe('微信')
    expect(body.contactValue).toBe('crplay_dev')
  })
})
