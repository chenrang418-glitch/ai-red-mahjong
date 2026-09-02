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
    // 单机和联机都已开放
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

test('全站用同一套墨绿配色，文字对比度达标', async ({ page }) => {
  // 配色以前散在七八个组件里各写各的，改一处就漏别处。现在统一定义在 root.css，
  // 这条守住「变量真的生效」和「暗底上文字仍然读得清」。
  const relativeLuminance = (color: string) => {
    const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number)
    const channel = (value: number) => {
      const ratio = value / 255
      return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  for (const [url, root] of [['/', '.game-portal'], ['/?game=mahjong', '.mode-home'], ['/?game=sanguosha', '.sgs-app']] as const) {
    await page.goto(url)
    await page.waitForSelector(root)
    const probe = await page.evaluate((selector) => {
      const node = document.querySelector(selector)!
      const style = getComputedStyle(node)
      return {
        color: style.color,
        // 墨绿而不是近黑：底色的绿色通道要明显高于红色通道
        background: style.backgroundImage + ' ' + style.backgroundColor,
        ink: getComputedStyle(document.documentElement).getPropertyValue('--ink-bg-top').trim(),
      }
    }, root)

    // 不钉死具体色值——配色会调，但这三条不能变：
    // 读得到统一变量、色相是墨绿（绿通道最高）、而且确实够暗
    expect(probe.ink, `${url} 应当读到统一的墨绿变量`).toMatch(/^#[0-9a-f]{6}$/i)
    const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(probe.ink.slice(offset, offset + 2), 16))
    expect(green, `${url} 墨绿：绿通道要高于红`).toBeGreaterThan(red)
    expect(green, `${url} 墨绿：绿通道要高于蓝`).toBeGreaterThan(blue)
    expect(Math.max(red, green, blue), `${url} 底色要足够深`).toBeLessThan(70)
    // 文字对亮度：暗底上主文字必须足够亮
    expect(relativeLuminance(probe.color), `${url} 主文字亮度`).toBeGreaterThan(0.75)
  }
})
