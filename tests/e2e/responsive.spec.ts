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

test('两个游戏的首页结构 1:1 对齐', async ({ page }) => {
  // 用户要求麻将首页复刻三国杀：顶栏、印章、小标注、标题、说明、三个入口，
  // 位置和配色都要一致。这里比对两边的实际渲染，而不是只看有没有按钮。
  const measure = async (url: string, root: string, seal: string) => {
    await page.goto(url)
    // 游戏是动态 import 进来的，要等它真的挂上再量
    await page.waitForSelector(root)
    return page.evaluate(([rootSelector, sealSelector]) => {
      const node = document.querySelector(rootSelector)!
      const box = (query: string) => {
        const element = node.querySelector(query)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { y: Math.round(rect.y), h: Math.round(rect.height), fs: getComputedStyle(element).fontSize }
      }
      return {
        header: box('header'),
        headerButton: box('header button'),
        seal: box(sealSelector),
        tagline: box('p'),
        title: box('h1'),
        description: box('small'),
        nav: box('nav'),
        buttonHeights: [...node.querySelectorAll('nav button')].map((b) => Math.round(b.getBoundingClientRect().height)),
        buttonLefts: [...node.querySelectorAll('nav button')].map((b) => Math.round(b.getBoundingClientRect().x)),
        buttonColors: [...node.querySelectorAll('nav button')].map((b) => getComputedStyle(b).backgroundImage),
      }
    }, [root, seal] as const)
  }

  for (const viewport of [{ width: 1280, height: 800 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
    await page.setViewportSize(viewport)
    const sanguosha = await measure('/?game=sanguosha', '.sgs-home', '.sgs-home__seal')
    const mahjong = await measure('/?game=mahjong', '.home', '.home__seal')
    const label = `${viewport.width}x${viewport.height}`
    // 三个入口的渐变必须完全相同
    expect(mahjong.buttonColors, `${label} 三个入口的配色`).toEqual(sanguosha.buttonColors)
    // 顶栏和导航贴边，绝对位置也该一致
    for (const key of ['header', 'headerButton', 'nav'] as const) {
      expect(mahjong[key], `${label} ${key}`).toEqual(sanguosha[key])
    }
    // hero 是垂直居中的，绝对位置取决于说明文字折几行（三国杀那句更长），
    // 所以只比尺寸和字号——那才是「结构一致」的含义。
    for (const key of ['seal', 'tagline', 'title'] as const) {
      expect({ h: mahjong[key]?.h, fs: mahjong[key]?.fs }, `${label} ${key}`)
        .toEqual({ h: sanguosha[key]?.h, fs: sanguosha[key]?.fs })
    }
    expect(mahjong.buttonHeights, `${label} 按钮高度`).toEqual(sanguosha.buttonHeights)
    expect(mahjong.buttonLefts, `${label} 按钮位置`).toEqual(sanguosha.buttonLefts)
    // 说明文字的高度取决于文案长度（三国杀那句更长，窄屏会折成两行），
    // 所以只比字号，不比高度——那不是布局差异。
    expect(mahjong.description?.fs, `${label} 说明字号`).toBe(sanguosha.description?.fs)
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
