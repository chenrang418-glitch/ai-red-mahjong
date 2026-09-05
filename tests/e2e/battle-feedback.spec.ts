import { expect, test } from '@playwright/test'

test('受击与回血粒子跟随目标、不拦截操作，结束后不残留光效', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto('/tests/fixtures/battle-feedback.html')
  await page.getByRole('button', { name: '受击', exact: true }).click()
  const burst = page.locator('.action-burst')
  await expect(burst).toHaveCount(1)
  await expect(burst).toHaveClass(/strike/)
  await expect(page.locator('[data-effect-target="p1"]')).toHaveText('-1')
  const location = await burst.evaluate((node) => ({ x: parseFloat(node.style.left), events: getComputedStyle(node).pointerEvents }))
  expect(location.x).toBeGreaterThan(250)
  expect(location.events).toBe('none')
  await expect.poll(() => burst.evaluate((node) => node.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'))).toBe(true)
  await expect.poll(() => burst.locator('i').first().evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
  await page.getByRole('button', { name: '目标', exact: true }).click()
  await expect(burst).toHaveClass(/heal/)
  await expect(page.locator('[data-effect-target="p1"]')).toHaveText('+1')
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 200 }
  })
  await page.screenshot({ path: testInfo.outputPath('recover-feedback.png') })
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect(burst).toHaveCount(0)
})

test('减少动态效果时隐藏粒子并保留事件信息', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/tests/fixtures/battle-feedback.html')
  await page.getByRole('button', { name: '受击', exact: true }).click()
  await expect(page.locator('.action-burst')).toBeHidden()
  await expect(page.locator('[data-effect-target="p1"]')).toHaveText('-1')
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})

test('麻将杠后补牌不吞光效，后续快照和历史动作不重播', async ({ page }) => {
  await page.goto('/tests/fixtures/battle-feedback.html?mahjong')
  await expect(page.locator('.table-shell')).toBeVisible()
  await expect(page.locator('.action-burst')).toHaveCount(0)
  await page.getByRole('button', { name: '杠后补牌', exact: true }).click()
  const burst = page.locator('.action-burst')
  await expect(burst).toHaveCount(1)
  await expect(burst).toHaveClass(/blue/)
  expect(await burst.evaluate((node) => node.style.left)).toBe('84%')
  await burst.evaluate((node) => node.setAttribute('data-original', 'yes'))
  await page.getByRole('button', { name: '继续摸牌', exact: true }).click()
  await expect(burst).toHaveAttribute('data-original', 'yes')
})
