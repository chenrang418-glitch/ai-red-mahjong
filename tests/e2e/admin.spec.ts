import { expect, test } from '@playwright/test'

const rooms = [
  {
    game: 'mahjong', code: 'MJ2345', phase: 'lobby', hostNickname: '麻将房主',
    occupiedSeats: 2, capacity: 4, mode: 'finite', initialPoints: 30, claimWindowMs: 4_000,
    players: [{ nickname: '麻将房主', kind: 'human', connected: true, trustee: false }], updatedAt: Date.now(),
  },
  {
    game: 'sanguosha', code: 'SG6789', phase: 'playing', hostNickname: '三国房主',
    occupiedSeats: 6, capacity: 6, difficulty: 'hard', turnSeconds: 45,
    players: [{ nickname: '三国房主', kind: 'human', connected: true, trustee: false }], updatedAt: Date.now(),
  },
]

async function openAdmin(page: import('@playwright/test').Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport)
  await page.route('**/api/admin/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/session')) return route.fulfill({ json: { ok: true } })
    if (path.endsWith('/users')) return route.fulfill({ json: { users: [{ userId: 'u1', nickname: '测试用户', createdAt: Date.now(), lastSeenAt: Date.now() }] } })
    if (path.endsWith('/rooms')) return route.fulfill({ json: { rooms } })
    if (path.endsWith('/settings')) return route.fulfill({ json: { trusteeDifficulty: 'beginner', maintenance: false, maintenanceMessage: '维护中' } })
    if (path.endsWith('/audit')) return route.fulfill({ json: { entries: [] } })
    return route.fulfill({ status: 404, json: { error: '接口不存在' } })
  })
  await page.goto('/#admin')
  await page.evaluate(() => sessionStorage.setItem('red-mahjong-admin-token', 'e2e-admin-token'))
  await page.reload()
  await expect(page.getByRole('heading', { name: '双游戏服务器管理' })).toBeVisible()
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 393, height: 852 }]) {
  test(`管理员页 ${viewport.width}x${viewport.height} 同时管理两款游戏`, async ({ page }) => {
    await openAdmin(page, viewport)
    await expect(page.getByText('红中麻将', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('三国杀', { exact: true }).first()).toBeVisible()

    await page.getByRole('button', { name: '双游戏房间' }).click()
    await expect(page.getByText('MJ2345')).toBeVisible()
    await expect(page.getByText('SG6789')).toBeVisible()
    await expect(page.getByText('6 人 · 困难 AI · 45 秒回合')).toBeVisible()

    await page.getByRole('button', { name: /麻将 1/ }).click()
    await expect(page.getByText('MJ2345')).toBeVisible()
    await expect(page.getByText('SG6789')).toBeHidden()
    await page.getByRole('button', { name: /三国杀 1/ }).click()
    await expect(page.getByText('SG6789')).toBeVisible()
    await expect(page.getByText('MJ2345')).toBeHidden()

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.clientWidth + 1)
  })
}
