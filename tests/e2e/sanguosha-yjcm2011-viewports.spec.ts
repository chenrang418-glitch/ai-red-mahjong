import { expect, test, type Page } from '@playwright/test'

/**
 * 一将成名 2011（全 11 人）：三档视口下的可用性。
 *
 * 三档分别对应竖屏手机、横屏手机和桌面。每一档都守两件事：
 *
 * 1. **整页不滚动**。牌桌是一屏应用，页面级滚动会把顶部信息推出视野；
 *    面板、弹窗内部该滚的照滚。
 * 2. 新武将的卡片**读得出名字、势力角标不压字**。这 11 个人暂时都没有立绘，
 *    走的是「没有立绘」那条布局分支，正是容易和角标打架的那一条。
 */

const VIEWPORTS = [
  { name: '393x852 竖屏手机', width: 393, height: 852 },
  { name: '932x430 横屏手机', width: 932, height: 430 },
  { name: '1280x800 桌面', width: 1280, height: 800 },
] as const

/** 一将成名 2011 的 11 个人。用名字找卡片，不依赖内部 id。 */
const YJCM2011_NAMES = [
  '曹植', '于禁', '张春华', '法正',
  '马谡', '徐庶', '凌统', '吴国太',
  '徐盛', '陈宫', '高顺',
]

async function openGeneralPicker(page: Page): Promise<void> {
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择武将' })).toBeVisible()
  await page.getByRole('button', { name: '自选', exact: true }).click()
  await expect(page.getByRole('heading', { name: '自选武将' })).toBeVisible()
}

/** 整页有没有出现滚动。允许 1px 的取整误差。 */
async function wholePageScrolls(page: Page): Promise<{ vertical: boolean; horizontal: boolean }> {
  return page.evaluate(() => {
    const root = document.documentElement
    return {
      vertical: root.scrollHeight > root.clientHeight + 1,
      horizontal: root.scrollWidth > root.clientWidth + 1,
    }
  })
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：自选武将页整页不滚动，一将成名 2011 的卡片都可读`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openGeneralPicker(page)

    const scroll = await wholePageScrolls(page)
    expect(scroll.horizontal, '页面不该横向滚动').toBe(false)
    expect(scroll.vertical, '页面不该整页纵向滚动（面板内部滚动是允许的）').toBe(false)

    for (const name of YJCM2011_NAMES) {
      const card = page.locator('.sgs-dock__general').filter({ has: page.locator(':scope > strong', { hasText: name }) })
      await expect(card, `${name} 应该在自选池里`).toHaveCount(1)
    }

    // 势力角标不能压在名字上（这四个人没有立绘，走的是最容易打架的那条分支）
    const overlaps = await page.locator('.sgs-dock__general').evaluateAll((cards) => cards.filter((card) => {
      const badge = card.querySelector('.sgs-faction-badge')?.getBoundingClientRect()
      const label = card.querySelector(':scope > strong')?.getBoundingClientRect()
      if (!badge || !label) return false
      return badge.left < label.right && badge.right > label.left
        && badge.top < label.bottom && badge.bottom > label.top
    }).map((card) => card.querySelector(':scope > strong')?.textContent ?? '?'))
    expect(overlaps, '势力角标不该压住任何一张卡的名字').toEqual([])
  })
}

test('第三批同桌时，三档视口下牌桌都不整页滚动', async ({ page }) => {
  /*
   * `lineup` 是开发用参数（不进生产构建），这里用它把这一批四个人
   * 直接摆上桌——随机阵容抽不到他们，也就验不到他们的技能面板。
   */
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto('/?game=sanguosha&lineup=xusheng,chengong,gaoshun,masu,wuguotai')
    await page.getByRole('button', { name: /单机游戏/ }).click()
    await page.getByRole('button', { name: '较快', exact: true }).click()
    await page.getByRole('button', { name: '开始', exact: true }).click()
    // 给了 lineup 就不再走选将，直接进桌
    await expect(page.locator('.sgs-table')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.sgs-seat'), '五个人都在桌上').toHaveCount(5)

    const scroll = await wholePageScrolls(page)
    expect(scroll.horizontal, `${viewport.name}：牌桌不该横向滚动`).toBe(false)
    expect(scroll.vertical, `${viewport.name}：牌桌不该整页纵向滚动`).toBe(false)
  }
})
