import { expect, test } from '@playwright/test'

const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 852, height: 393 },
  { width: 932, height: 430 },
]

for (const viewport of viewports) {
  test(`${viewport.width}x${viewport.height} 游戏中心完整且无横向溢出`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toBeVisible()
    await expect(page.getByRole('button', { name: /红中麻将/ })).toContainText('可游玩')
    // 单机可玩之后状态从「开发中」改成「可游玩」；联机仍未开放，见三国杀首页内的标注
    await expect(page.getByRole('button', { name: /三国杀/ })).toContainText('可游玩')
    await expect(page.getByRole('button', { name: /更多游戏/ })).toBeDisabled()

    const dimensions = await page.evaluate(() => ({
      rootWidth: document.documentElement.scrollWidth,
      rootClientWidth: document.documentElement.clientWidth,
      bodyHeight: document.body.scrollHeight,
      bodyClientHeight: document.body.clientHeight,
    }))
    expect(dimensions.rootWidth).toBeLessThanOrEqual(dimensions.rootClientWidth + 1)
    expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.bodyClientHeight + 1)
  })
}

test('门户、麻将、三国杀支持前进后退和刷新恢复', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /红中麻将/ }).click()
  await expect(page).toHaveURL(/game=mahjong/)
  await expect(page.getByRole('heading', { name: '红中麻将' })).toBeVisible()

  await page.goBack()
  await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: '红中麻将' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '红中麻将' })).toBeVisible()

  await page.getByRole('button', { name: '返回游戏中心' }).click()
  await page.getByRole('button', { name: /三国杀/ }).click()
  await expect(page).toHaveURL(/game=sanguosha/)
  await expect(page.getByRole('heading', { name: '三国杀' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '三国杀' })).toBeVisible()
})

test('旧麻将分享链接和管理员入口保持兼容', async ({ page }) => {
  await page.goto('/?room=ABC234')
  await expect(page.getByText('加入房间 ABC234')).toBeVisible()

  await page.goto('/#admin')
  await expect(page.getByRole('heading', { name: '管理入口' })).toBeVisible()
})
