import { expect, test, type Page } from '@playwright/test'

const MOBILE_VIEWPORTS = [
  { name: '393x852 竖屏手机', width: 393, height: 852 },
  { name: '932x430 横屏手机', width: 932, height: 430 },
] as const

async function enterTable(page: Page): Promise<void> {
  await page.goto('/?game=sanguosha&lineup=caozhang,zhonghui,xunyou,wangyi,gaoshun')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '较快', exact: true }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.locator('.sgs-table')).toBeVisible({ timeout: 15_000 })
}

type AuditResult = {
  smallTargets: string[]
  smallText: string[]
  unnamedButtons: string[]
  horizontalScroll: boolean
}

async function auditMobileTable(page: Page): Promise<AuditResult> {
  return page.evaluate(() => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const describe = (element: Element) => {
      const html = element as HTMLElement
      const text = html.getAttribute('aria-label') || html.innerText.trim() || html.className || html.tagName
      return `${html.tagName.toLowerCase()}[${text.slice(0, 36)}]`
    }
    const effectiveTargetSize = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const before = getComputedStyle(element, '::before')
      const beforeWidth = Number.parseFloat(before.width)
      const beforeHeight = Number.parseFloat(before.height)
      return {
        width: Math.max(rect.width, Number.isFinite(beforeWidth) ? beforeWidth : 0),
        height: Math.max(rect.height, Number.isFinite(beforeHeight) ? beforeHeight : 0),
      }
    }

    const clickables = [...document.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="button"], [tabindex]:not([tabindex="-1"])')]
      .filter(visible)
    const smallTargets = clickables.filter((element) => {
      const size = effectiveTargetSize(element)
      return size.width < 44 || size.height < 44
    }).map(describe)
    const smallText = [...document.querySelectorAll('body *')].filter(visible).filter((element) => {
      const style = getComputedStyle(element)
      return element.children.length === 0 && element.textContent?.trim() && Number.parseFloat(style.fontSize) < 10
    }).map((element) => `${describe(element)}:${getComputedStyle(element).fontSize}`)
    const unnamedButtons = [...document.querySelectorAll('button')].filter(visible).filter((button) => {
      const aria = button.getAttribute('aria-label')?.trim()
      const text = (button as HTMLElement).innerText.trim()
      const title = button.getAttribute('title')?.trim()
      const imageAlt = button.querySelector('img[alt]:not([alt=""])')
      return !aria && !text && !title && !imageAlt
    }).map(describe)
    const root = document.documentElement
    return {
      smallTargets,
      smallText,
      unnamedButtons,
      horizontalScroll: root.scrollWidth > root.clientWidth + 1,
    }
  })
}

for (const viewport of MOBILE_VIEWPORTS) {
  test(`${viewport.name}：牌桌满足移动端字号、触控和无障碍下限`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await enterTable(page)
    const audit = await auditMobileTable(page)

    expect.soft(audit.smallTargets, '可点击控件的有效命中区不得小于 44×44').toEqual([])
    expect.soft(audit.smallText, '可见文字不得小于 10px').toEqual([])
    expect.soft(audit.unnamedButtons, '按钮必须有可读名字').toEqual([])
    expect.soft(audit.horizontalScroll, '页面不应横向滚动').toBe(false)

    if (viewport.width > viewport.height) {
      const layout = await page.evaluate(() => {
        const seat = document.querySelector('.sgs-seat-layout__slot--self')!.getBoundingClientRect()
        const hand = document.querySelector('.sgs-table__hand')!.getBoundingClientRect()
        const cards = [...document.querySelectorAll('.sgs-table__hand .sgs-card-shell')].map((card) => card.getBoundingClientRect())
        const contentRight = cards.length ? Math.max(...cards.map((card) => card.right)) : hand.left
        const contentBottom = cards.length ? Math.max(...cards.map((card) => card.bottom)) : hand.bottom
        const dock = document.querySelector('.sgs-table > .sgs-table__dock, .sgs-table > .sgs-dock')!.getBoundingClientRect()
        return { seatLeft: seat.left, seatRight: seat.right, handLeft: hand.left, contentRight, contentBottom, dockTop: dock.top, viewportWidth: innerWidth }
      })
      expect(layout.handLeft, '横屏时手牌应从角色右侧开始').toBeGreaterThanOrEqual(layout.seatRight)
      expect(Math.abs((layout.seatLeft + layout.contentRight) / 2 - layout.viewportWidth / 2), '角色与手牌应作为一个整体居中').toBeLessThan(56)
      expect(layout.contentRight, '手牌不应伸出屏幕右侧').toBeLessThanOrEqual(layout.viewportWidth)
      expect(layout.contentBottom, '手牌下缘应完整露在底部面板上方').toBeLessThanOrEqual(layout.dockTop - 5)

      const opponents = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
        const leftTop = rect('.sgs-seat-layout__slot--left-top')
        const leftBottom = rect('.sgs-seat-layout__slot--left-bottom')
        const rightTop = rect('.sgs-seat-layout__slot--right-top')
        const rightBottom = rect('.sgs-seat-layout__slot--right-bottom')
        return {
          topDelta: Math.abs(leftTop.top - rightTop.top),
          bottomDelta: Math.abs(leftBottom.bottom - rightBottom.bottom),
          leftInset: leftTop.left,
          rightInset: innerWidth - rightTop.right,
        }
      })
      expect(opponents.topDelta, '五人局左右上方角色应水平对称').toBeLessThan(2)
      expect(opponents.bottomDelta, '五人局左右下方角色应水平对称').toBeLessThan(2)
      expect(Math.abs(opponents.leftInset - opponents.rightInset), '五人局左右角色应等距贴近两侧').toBeLessThan(2)

      // 模拟轮到自己出牌时底部状态栏升高。ResizeObserver 应同步抬高手牌，
      // 不能只在初始的“其他角色思考中”矮状态下碰巧不重叠。
      await page.locator('.sgs-table > .sgs-table__dock').evaluate((dock) => { (dock as HTMLElement).style.minHeight = '96px' })
      await expect.poll(() => page.evaluate(() => {
        const cards = [...document.querySelectorAll('.sgs-table__hand .sgs-card-shell')].map((card) => card.getBoundingClientRect())
        const cardBottom = Math.max(...cards.map((card) => card.bottom))
        const dockTop = document.querySelector('.sgs-table > .sgs-table__dock')!.getBoundingClientRect().top
        return dockTop - cardBottom
      }), { message: '自己的出牌状态栏升起后，手牌下缘仍应完整露出' }).toBeGreaterThanOrEqual(5)
    }
  })
}
