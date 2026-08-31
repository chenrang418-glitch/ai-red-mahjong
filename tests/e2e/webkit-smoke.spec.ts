import { expect, test, type Page } from '@playwright/test'

/**
 * WebKit 上的关键路径冒烟。
 *
 * 只挑 iOS Safari 最容易和 Chromium 表现不一致的地方：100dvh、env(safe-area-*)、
 * backdrop-filter、以及 grid 在窄屏下的换行。全套用例在 WebKit 上再跑一遍
 * 只会让 CI 时间翻倍，挡到的回归却和 Chromium 那份高度重合。
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

async function startLocalMatch(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: '单机模式' }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.locator('.human-hand')).toBeVisible()
}

async function mockLobby(page: Page) {
  await page.route('http://127.0.0.1:8787/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') return route.fulfill({ json: { session: { userId: 'user-1', nickname: 'WebKit 玩家' } } })
    if (path === '/api/service') return route.fulfill({ json: { maintenance: false, maintenanceMessage: '' } })
    if (path === '/api/rooms') return route.fulfill({ json: { rooms: [] } })
    return route.fulfill({ status: 404, json: { error: 'not mocked' } })
  })
  await page.addInitScript(() => {
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly url: string
      readyState = MockWebSocket.CONNECTING
      constructor(url: string | URL) {
        super()
        this.url = String(url)
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN
          this.dispatchEvent(new Event('open'))
        }, 0)
      }
      send(payload: string) {
        if (payload === 'ping' || payload.includes('"type":"ping"')) {
          this.dispatchEvent(new MessageEvent('message', { data: 'pong' }))
        }
      }
      close(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED
        this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }))
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket })
  })
}

test('WebKit 手机竖屏牌桌一屏可操作', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await startLocalMatch(page)
  await expect(page.locator('.top-seat')).toBeVisible()
  await expect(page.locator('.left-seat')).toBeVisible()
  await expect(page.locator('.right-seat')).toBeVisible()
  await expect(page.locator('.round-back')).toBeVisible()
  await expectNoPageScroll(page)
})

test('WebKit 手机横屏牌桌一屏可操作', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await startLocalMatch(page)
  await expect(page.locator('.human-hand')).toBeVisible()
  await expect(page.locator('.table-center')).toBeVisible()
  // 横屏返回键在 WebKit 上同样不能退回默认白按钮
  const background = await page.locator('.round-back').evaluate((node) => getComputedStyle(node).backgroundColor)
  const channels = background.match(/[\d.]+/g)!.slice(0, 3).map(Number)
  expect(Math.max(...channels)).toBeLessThan(80)
  await expectNoPageScroll(page)
})

test('WebKit 退出确认框居中显示', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await startLocalMatch(page)
  await page.locator('.round-back').click()

  const card = page.locator('.confirm-card')
  await expect(card).toBeVisible()
  await page.evaluate(() => document.getAnimations().forEach((animation) => {
    try { animation.finish() } catch { /* 循环动画忽略 */ }
  }))

  const box = (await card.boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - PORTRAIT.width / 2)).toBeLessThanOrEqual(30)
  expect(Math.abs(box.y + box.height / 2 - PORTRAIT.height / 2)).toBeLessThanOrEqual(30)
  await expect(card.locator('.confirm-actions .cancel')).toHaveText('取消')
  await expectNoPageScroll(page)
})

test('WebKit 联机大厅显示昵称且不整页滚动', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await mockLobby(page)
  await page.goto('/')
  await page.getByRole('button', { name: '联机模式' }).click()

  await expect(page.locator('.identity-bar')).toContainText('WebKit 玩家')
  await expect(page.getByRole('heading', { name: '公开房间' })).toBeVisible()
  await expectNoPageScroll(page)
})
