import { expect, test, type Page } from '@playwright/test'

/**
 * 三国杀单机流程的浏览器验收。
 *
 * 重点不是好看，而是两件任务书反复强调的事：
 * 1. 每一步都真的点得到——服务端支持不等于前端有入口。
 * 2. 别人的手牌和未公开身份不能出现在 DOM 里。
 */

const PORTRAIT = { width: 393, height: 852 }
const LANDSCAPE = { width: 852, height: 393 }

async function expectNoPageScroll(page: Page) {
  const scroll = await page.evaluate(() => ({
    bodyHeight: document.body.scrollHeight,
    bodyClient: document.body.clientHeight,
    rootHeight: document.documentElement.scrollHeight,
    rootClient: document.documentElement.clientHeight,
    bodyWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  }))
  expect(scroll.bodyHeight).toBeLessThanOrEqual(scroll.bodyClient + 1)
  expect(scroll.rootHeight).toBeLessThanOrEqual(scroll.rootClient + 1)
  expect(scroll.bodyWidth).toBeLessThanOrEqual(scroll.bodyClientWidth + 1)
}

/** 从门户一路进到牌桌。 */
async function enterTable(page: Page, playerCount?: number) {
  await page.goto('/?game=sanguosha')
  await expect(page.getByRole('heading', { name: '三国杀' })).toBeVisible()
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await expect(page.getByRole('heading', { name: '单机设置' })).toBeVisible()
  if (playerCount) await page.getByRole('button', { name: `${playerCount} 人`, exact: true }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()

  // 选将：候选一定要真的能点
  const general = page.locator('.sgs-dock__general').first()
  await expect(general).toBeVisible()
  await expect(general).toContainText('【')
  await general.click()

  await expect(page.locator('.sgs-table')).toBeVisible({ timeout: 15_000 })
}

for (const viewport of [PORTRAIT, LANDSCAPE]) {
  const label = `${viewport.width}x${viewport.height}`

  test(`${label} 单机牌桌一屏可玩`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await enterTable(page)

    await expect(page.locator('.sgs-table__back')).toBeVisible()
    await expect(page.locator('.sgs-table__hand')).toBeVisible()
    // 五人局：自己 + 四个其他角色
    await expect(page.locator('.sgs-seat')).toHaveCount(5)
    await expectNoPageScroll(page)
    expect(errors).toEqual([])
  })
}

test('八人局座位全部可见且不溢出', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await enterTable(page, 8)
  await expect(page.locator('.sgs-seat')).toHaveCount(8)
  await expectNoPageScroll(page)
})

test('别人的手牌和未公开身份不出现在 DOM 里', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterTable(page)

  const leak = await page.evaluate(() => {
    const others = [...document.querySelectorAll('.sgs-table__others .sgs-seat')]
    return others.map((seat) => ({
      // 别人座位里只允许出现装备区和判定区的牌，这两处本来就是公开的
      zoneCards: seat.querySelectorAll('.sgs-seat__zone .sgs-card').length,
      totalCards: seat.querySelectorAll('.sgs-card').length,
      // 手牌只以数量呈现
      showsHandCount: /手牌\s*\d+/.test(seat.textContent ?? ''),
      identityText: seat.querySelector('.sgs-seat__identity')?.textContent?.trim() ?? '',
    }))
  })

  for (const seat of leak) {
    // 座位里出现的牌一张不多不少都来自公开区域
    expect(seat.totalCards).toBe(seat.zoneCards)
    expect(seat.showsHandCount).toBe(true)
  }
  // 至少有一个人的身份还没公开，显示为问号
  expect(leak.some((seat) => seat.identityText === '？')).toBe(true)
})

test('真人最终一定拿得到可点的操作', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterTable(page)

  // 不去赌「AI 恰好打我」——真正的不变量是：牌局推进下去，
  // 真人迟早会拿到可以点的东西，要么是自己的回合，要么是需要响应的请求。
  // 只能干等超时才是任务书明令禁止的情况。
  const actionable = page.locator('.sgs-dock button:not([disabled]), .sgs-table__dock .sgs-table__actions button:not([disabled])')
  await expect(actionable.first()).toBeVisible({ timeout: 60_000 })
  await expectNoPageScroll(page)
})

test('规则页的技能说明来自武将数据', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /规则/ }).click()
  await expect(page.getByRole('heading', { name: '规则' })).toBeVisible()
  // 武将技能条目直接由 STANDARD_CHARACTERS 渲染
  await expect(page.locator('.sgs-rules')).toContainText('武圣')
  await expect(page.locator('.sgs-rules')).toContainText('咆哮')
  await expectNoPageScroll(page)
})
