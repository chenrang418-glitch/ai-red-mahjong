import { expect, test, type Page } from '@playwright/test'

const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 393, height: 852 },
  { width: 430, height: 932 },
  { width: 852, height: 393 },
  { width: 932, height: 430 },
]

async function expectNoPageScroll(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyHeight: document.body.scrollHeight,
    bodyClient: document.body.clientHeight,
    rootHeight: document.documentElement.scrollHeight,
    rootClient: document.documentElement.clientHeight,
    bodyWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  }))
  expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.bodyClient + 1)
  expect(dimensions.rootHeight).toBeLessThanOrEqual(dimensions.rootClient + 1)
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.bodyClientWidth + 1)
}

async function installMockWebSocket(page: Page) {
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
        if (payload.includes('"type":"ping"')) {
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'pong' }) }))
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

async function mockOnlineApi(page: Page, hasSession = true) {
  await page.route('http://127.0.0.1:8787/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session' && route.request().method() === 'POST') return route.fulfill({ json: { userId: 'user-1', nickname: '测试玩家' } })
    if (path === '/api/session') return route.fulfill({ json: {
      session: hasSession ? { userId: 'user-1', nickname: '测试玩家' } : null,
    } })
    if (path === '/api/service') return route.fulfill({ json: { maintenance: false, maintenanceMessage: '' } })
    if (path === '/api/rooms') return route.fulfill({ json: { rooms: [
      { code: 'ABC234', phase: 'lobby', joinable: true, rejoinable: false, hostNickname: '朋友A', players: [], occupiedSeats: 2, availableSeats: 2, settings: { mode: 'finite', initialPoints: 30, claimWindowMs: 4000, turnWindowMs: 30000, aiDifficulty: 'standard', trusteeDifficulty: 'beginner' }, updatedAt: Date.now() },
      { code: 'XYZ789', phase: 'playing', joinable: false, rejoinable: false, hostNickname: '朋友B', players: [], occupiedSeats: 4, availableSeats: 0, settings: { mode: 'unlimited', initialPoints: 30, claimWindowMs: 4000, turnWindowMs: 30000, aiDifficulty: 'standard', trusteeDifficulty: 'beginner' }, updatedAt: Date.now() - 1 },
    ] } })
    return route.fulfill({ status: 404, json: { error: 'not mocked' } })
  })
}

for (const viewport of viewports) {
  test(`${viewport.width}x${viewport.height} 核心页面保持一屏`, async ({ page }) => {
    const browserErrors: string[] = []
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
    page.on('pageerror', (error) => browserErrors.push(error.message))
    await page.setViewportSize(viewport)
    await installMockWebSocket(page)
    await mockOnlineApi(page)
    await page.goto('/?game=mahjong')

    await expect(page.getByRole('heading', { name: '红中麻将' })).toBeVisible()
    await expect(page.getByRole('button', { name: /单机游戏/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /联机游戏/ })).toBeVisible()
    await expectNoPageScroll(page)

    await page.getByRole('button', { name: /单机游戏/ }).click()
    await expect(page.getByRole('heading', { name: '单机设置' })).toBeVisible()
    await expect(page.getByRole('button', { name: '开始', exact: true })).toBeVisible()
    await expectNoPageScroll(page)

    await page.getByLabel('AI 难度').selectOption('beginner')
    await page.getByRole('button', { name: '开始', exact: true }).click()
    await expect(page.locator('.top-seat')).toBeVisible()
    await expect(page.locator('.left-seat')).toBeVisible()
    await expect(page.locator('.right-seat')).toBeVisible()
    await expect(page.locator('.human-hand')).toBeVisible()
    // 操作 Dock 只在真人需要响应时出现；否则必须清晰标出正在行动的 AI 座位。
    await expect(page.locator('.action-dock button, .top-seat.active, .left-seat.active, .right-seat.active').first()).toBeVisible()
    await expectNoPageScroll(page)

    await page.goto('/?game=mahjong')
    await page.getByRole('button', { name: /联机游戏/ }).click()
    await expect(page.getByRole('heading', { name: '公开房间' })).toBeVisible()
    await expect(page.getByText('ABC234')).toBeVisible()
    await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible()
    await expect(page.locator('.room-list')).toHaveCSS('overflow-y', 'auto')
    await expectNoPageScroll(page)
    expect(browserErrors).toEqual([])
  })
}

test('分享链接在无会话时直接收集昵称并自动消费房间号', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.setViewportSize({ width: 393, height: 852 })
  await installMockWebSocket(page)
  await mockOnlineApi(page, false)
  await page.goto('/?room=ABC234')

  await expect(page.getByText('加入房间 ABC234')).toBeVisible()
  await page.getByLabel('昵称').fill('分享玩家')
  await page.getByRole('button', { name: '加入房间', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.has('room')).toBe(false)
  expect(browserErrors).toEqual([])
})

test('两款游戏的独立首页均保持完整入口与一屏布局', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
    await page.setViewportSize(viewport)
    for (const game of ['mahjong', 'sanguosha']) {
      await page.goto(`/?game=${game}`)
      const root = page.locator(game === 'mahjong' ? '.home' : '.sgs-home')
      await expect(root).toBeVisible()
      await expect(root.locator('nav button')).toHaveCount(3)
      for (const name of ['单机游戏', '联机游戏', '规则']) {
        const button = root.getByRole('button', { name: new RegExp(name) })
        await expect(button).toBeInViewport({ ratio: 1 })
        await expect(button).toBeEnabled()
      }
      await expectNoPageScroll(page)
      await root.getByRole('button', { name: /单机游戏/ }).click()
      await expect(page.getByRole('heading', { name: '单机设置' })).toBeVisible()
      await expect(page.getByRole('button', { name: '开始', exact: true })).toBeInViewport({ ratio: 1 })
    }
  }
})

test('麻将首页三个入口在窄屏一屏可点', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto('/?game=mahjong')
  const nav = page.locator('.mode-home nav button')
  await expect(nav).toHaveCount(3)
  for (const name of ['单机游戏', '联机游戏', '规则']) {
    await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible()
  }
  // 规则弹层以前只在牌局分支里，首页根本打不开
  await page.getByRole('button', { name: /规则/ }).first().click()
  await expect(page.locator('.rules-card')).toBeVisible()

  const scroll = await page.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    client: document.documentElement.clientHeight,
    width: document.body.scrollWidth,
    clientWidth: document.body.clientWidth,
  }))
  expect(scroll.height).toBeLessThanOrEqual(scroll.client + 1)
  expect(scroll.width).toBeLessThanOrEqual(scroll.clientWidth + 1)
})
