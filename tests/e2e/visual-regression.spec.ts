import { expect, test, type Page } from '@playwright/test'
import { RoomCoordinator } from '../../server/room-core'

/**
 * 针对这一轮修掉的具体视觉 bug 的回归测试。
 *
 * 和 responsive.spec.ts 分工不同：那份只检查「整页不滚动、关键元素可见」，
 * 挡不住「高亮牌被裁掉半截」「横屏按钮退回浏览器默认白底」这种局部回归。
 */

const PORTRAIT = { width: 393, height: 852 }
const LANDSCAPE = { width: 852, height: 393 }

/** 用真实的 RoomCoordinator 生成一份联机房间快照，避免手写一大坨可能与实现脱节的假数据。 */
function buildRoomView() {
  const room = RoomCoordinator.create('ABC234', { userId: 'user-1', nickname: '测试玩家' }, {
    mode: 'finite',
    initialPoints: 30,
    claimWindowMs: 4000,
    turnWindowMs: 30_000,
  }, Date.now())
  room.handle('user-1', { type: 'start-game' }, Date.now())
  return room.view('user-1')
}

const ROOM_VIEW = buildRoomView()

async function installMockSockets(page: Page, roomView: unknown) {
  await page.addInitScript((serializedRoom) => {
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
          // 房间连接一建立就推一份完整牌局状态，客户端据此进入牌桌
          if (this.url.includes('/api/rooms/')) {
            this.dispatchEvent(new MessageEvent('message', {
              data: JSON.stringify({ type: 'room-state', room: serializedRoom }),
            }))
          }
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
  }, roomView)

  await page.route('http://127.0.0.1:8787/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') return route.fulfill({ json: { session: { userId: 'user-1', nickname: '测试玩家' } } })
    if (path === '/api/service') return route.fulfill({ json: { maintenance: false, maintenanceMessage: '' } })
    if (path === '/api/rooms') return route.fulfill({ json: { rooms: [] } })
    return route.fulfill({ status: 404, json: { error: 'not mocked' } })
  })
}

/** 冻结所有动画：动画进行中量出来的位置不是最终位置。 */
async function settleAnimations(page: Page) {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => {
      try { animation.finish() } catch { /* 无限循环的呼吸灯 finish 会抛，忽略 */ }
    })
  })
}

async function startLocalMatch(page: Page) {
  await page.goto('/?game=mahjong')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.locator('.human-hand')).toBeVisible()
}

/** 打到牌河里出现最新弃牌为止。 */
async function playUntilDiscard(page: Page) {
  await expect(async () => {
    const dock = page.locator('.action-dock')
    if (await dock.count()) {
      const discard = dock.locator('.discard-button')
      if (await discard.count()) {
        if (await discard.isDisabled()) {
          const tile = page.locator('.human-hand .mahjong-tile:not([disabled])').first()
          if (await tile.count()) await tile.click({ timeout: 1000 })
        } else {
          await discard.click({ timeout: 1000 })
        }
      }
    }
    await expect(page.locator('.river .just-discarded')).toHaveCount(1)
  }).toPass({ timeout: 45_000 })
}

for (const viewport of [PORTRAIT, LANDSCAPE]) {
  const label = `${viewport.width}x${viewport.height}`

  test(`${label} 最新弃牌高亮不被牌河裁掉`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await startLocalMatch(page)
    await playUntilDiscard(page)
    await settleAnimations(page)

    const highlight = page.locator('.river .just-discarded').first()
    await expect(highlight).toBeVisible()

    const geometry = await highlight.evaluate((tile) => {
      const river = tile.closest('.river')!
      const riverStyle = getComputedStyle(river)
      const riverBox = river.getBoundingClientRect()
      const tileBox = tile.getBoundingClientRect()
      const border = parseFloat(riverStyle.borderTopWidth) || 0
      return {
        // 牌河是 overflow: hidden 的裁切盒，裁切边界是它的 padding box
        roomAboveTile: tileBox.top - (riverBox.top + border),
        riverOverflow: riverStyle.overflow,
        tileHeight: tileBox.height,
      }
    })

    // 抬起 2px + 外描边 2px 必须完整落在裁切盒内；留 4px 才算真的没被切
    expect(geometry.roomAboveTile).toBeGreaterThanOrEqual(4)
    expect(geometry.tileHeight).toBeGreaterThan(0)
  })

  test(`${label} 退出确认框居中且是暗色模态`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await startLocalMatch(page)
    await page.locator('.round-back').click()
    await expect(page.locator('.confirm-card')).toBeVisible()
    await settleAnimations(page)

    const card = page.locator('.confirm-card')
    const box = (await card.boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(30)
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(30)

    // 不能退回白底 action sheet
    const backdrop = page.locator('.confirm-backdrop')
    await expect(backdrop).toBeVisible()
    const colors = await card.evaluate((node) => ({
      background: getComputedStyle(node).backgroundImage,
      border: getComputedStyle(node).borderTopColor,
    }))
    expect(colors.background).toContain('gradient')
    expect(colors.border).not.toBe('rgb(255, 255, 255)')

    // 危险动作和取消都在，且文案不动
    await expect(card.locator('.confirm-actions .danger')).toBeVisible()
    await expect(card.locator('.confirm-actions .cancel')).toHaveText('取消')

    const scroll = await page.evaluate(() => ({
      body: [document.body.scrollHeight, document.body.clientHeight],
      root: [document.documentElement.scrollHeight, document.documentElement.clientHeight],
    }))
    expect(scroll.body[0]).toBeLessThanOrEqual(scroll.body[1] + 1)
    expect(scroll.root[0]).toBeLessThanOrEqual(scroll.root[1] + 1)
  })
}

test('横屏牌桌左上角返回键保持深色，不是浏览器默认白按钮', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await startLocalMatch(page)

  const back = page.locator('.round-back')
  await expect(back).toBeVisible()
  const style = await back.evaluate((node) => {
    const computed = getComputedStyle(node)
    return {
      backgroundColor: computed.backgroundColor,
      borderStyle: computed.borderTopStyle,
      borderWidth: computed.borderTopWidth,
      color: computed.color,
    }
  })

  expect(style.backgroundColor).not.toBe('rgb(255, 255, 255)')
  expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  // 深色底：三个通道都得暗下来
  const channels = style.backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number)
  expect(Math.max(...channels)).toBeLessThan(80)
  expect(style.borderStyle).toBe('solid')
  expect(parseFloat(style.borderWidth)).toBeGreaterThan(0)
  // 图标是米白色，不是默认黑字
  const text = style.color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
  expect(Math.min(...text)).toBeGreaterThan(150)
})

test('手机竖屏联机大厅显示当前昵称，并按创建→加入→公开房间自上而下排列', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await installMockSockets(page, ROOM_VIEW)
  await page.goto('/?game=mahjong')
  await page.getByRole('button', { name: /联机游戏/ }).click()

  const identity = page.locator('.identity-bar')
  await expect(identity).toBeVisible()
  await expect(identity).toContainText('测试玩家')

  const boxes = await Promise.all(
    ['.identity-bar', '.create-card', '.join-card', '.directory'].map(async (selector) => {
      const box = await page.locator(selector).boundingBox()
      if (!box) throw new Error(`${selector} 没有渲染`)
      return { selector, ...box }
    }),
  )
  // 用实际坐标验证，DOM 顺序挡不住 grid 重排
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index].y, `${boxes[index].selector} 应该排在 ${boxes[index - 1].selector} 下面`)
      .toBeGreaterThan(boxes[index - 1].y)
  }
  // 公开房间拿到最大一块，而且加入房间不再被拉高
  expect(boxes[3].height).toBeGreaterThan(boxes[2].height)
  await expect(page.locator('.room-list')).toHaveCSS('overflow-y', 'auto')
})

test('手机横屏联机大厅三列并排，公开房间最宽', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await installMockSockets(page, ROOM_VIEW)
  await page.goto('/?game=mahjong')
  await page.getByRole('button', { name: /联机游戏/ }).click()

  await expect(page.locator('.identity-bar')).toContainText('测试玩家')
  const create = (await page.locator('.create-card').boundingBox())!
  const join = (await page.locator('.join-card').boundingBox())!
  const directory = (await page.locator('.directory').boundingBox())!

  // 三列在同一行：纵坐标接近，横坐标依次递增
  expect(Math.abs(create.y - join.y)).toBeLessThan(4)
  expect(Math.abs(create.y - directory.y)).toBeLessThan(4)
  expect(join.x).toBeGreaterThan(create.x)
  expect(directory.x).toBeGreaterThan(join.x)

  expect(directory.width).toBeGreaterThan(join.width)
  expect(directory.width).toBeGreaterThan(create.width)
})

for (const viewport of [PORTRAIT, LANDSCAPE]) {
  test(`${viewport.width}x${viewport.height} 联机牌桌一屏可操作`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await installMockSockets(page, ROOM_VIEW)
    await page.goto('/?room=ABC234')

    await expect(page.locator('.human-hand')).toBeVisible()
    await expect(page.locator('.top-seat')).toBeVisible()
    await expect(page.locator('.left-seat')).toBeVisible()
    await expect(page.locator('.right-seat')).toBeVisible()
    await expect(page.locator('.round-back')).toBeVisible()
    await settleAnimations(page)

    const scroll = await page.evaluate(() => ({
      body: [document.body.scrollHeight, document.body.clientHeight],
      root: [document.documentElement.scrollHeight, document.documentElement.clientHeight],
      width: [document.body.scrollWidth, document.body.clientWidth],
    }))
    expect(scroll.body[0]).toBeLessThanOrEqual(scroll.body[1] + 1)
    expect(scroll.root[0]).toBeLessThanOrEqual(scroll.root[1] + 1)
    expect(scroll.width[0]).toBeLessThanOrEqual(scroll.width[1] + 1)

    // 聊天入口不能压住手牌（只有它真的显示出来才需要检查）
    const chat = page.locator('.chat-fab, .mobile-chat-trigger').first()
    const chatBox = await chat.count() && await chat.isVisible() ? await chat.boundingBox() : null
    if (chatBox) {
      const handBox = (await page.locator('.human-hand').boundingBox())!
      const overlaps = chatBox.x < handBox.x + handBox.width
        && chatBox.x + chatBox.width > handBox.x
        && chatBox.y < handBox.y + handBox.height
        && chatBox.y + chatBox.height > handBox.y
      expect(overlaps, '聊天按钮不应压在手牌上').toBe(false)
    }

    expect(errors).toEqual([])
  })
}
