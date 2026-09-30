import { expect, test, type Page } from '@playwright/test'
import { SanguoshaRoomCoordinator, TEST_SGS_ROOM_TIMING, normalizeSettings } from '../../server/sanguosha-room-core'

function spectatorRoomView() {
  const host = { userId: 'host', nickname: '房主' }
  const watcher = { userId: 'watcher', nickname: '观众' }
  const room = SanguoshaRoomCoordinator.create('WATCH1', host, normalizeSettings({ playerCount: 5 }), 1_000, TEST_SGS_ROOM_TIMING)
  room.handle(host.userId, { type: 'toggle-ready' }, 1_001)
  room.handle(host.userId, { type: 'start-game' }, 1_002)

  for (let guard = 0; guard < 100 && room.snapshot().game?.status === 'choosing-general'; guard += 1) {
    const request = room.view(host.userId).playerView?.pendingRequest
    if (request?.kind === 'choose-general') {
      room.handle(host.userId, { type: 'respond', requestId: request.id, payload: { characterId: request.candidates[0] } }, 2_000 + guard)
    }
    const dueAt = room.nextAlarmAt()
    if (dueAt !== null) room.runDueJobs(dueAt)
  }
  if (room.snapshot().game?.status !== 'playing') throw new Error('测试房间未能进入牌局')
  room.connect(watcher, 3_000, true)
  return room.view(watcher.userId)
}

async function mockSpectatorRoom(page: Page): Promise<void> {
  const room = spectatorRoomView()
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
          if (this.url.includes('/api/sanguosha/rooms/WATCH1/socket') && this.url.includes('spectator=1')) {
            this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'room-state', room: serializedRoom }) }))
          }
        }, 0)
      }
      send(payload: string) {
        if (payload.includes('"type":"ping"')) this.dispatchEvent(new MessageEvent('message', { data: 'pong' }))
      }
      close(code = 1000, reason = '') {
        this.readyState = MockWebSocket.CLOSED
        this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean: true }))
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket })
  }, room)

  await page.route('http://127.0.0.1:8787/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/session') return route.fulfill({ json: { session: { userId: 'watcher', nickname: '观众' } } })
    if (path === '/api/service') return route.fulfill({ json: { maintenance: false, maintenanceMessage: '' } })
    if (path === '/api/sanguosha/rooms') return route.fulfill({ json: { rooms: [{
      code: 'WATCH1', phase: 'playing', hostNickname: '房主', players: [], occupiedSeats: 5, availableSeats: 0,
      settings: { playerCount: 5, difficulty: 'normal', turnSeconds: 30 }, rejoinable: false, joinable: false,
      spectatable: true, updatedAt: Date.now(),
    }] } })
    return route.fulfill({ status: 404, json: { error: 'not mocked' } })
  })
}

test('满员进行中的房间可以旁观，牌桌没有玩家操作入口', async ({ page }) => {
  await page.setViewportSize({ width: 932, height: 430 })
  await mockSpectatorRoom(page)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /联机游戏/ }).click()
  const roomEntry = page.locator('.sgs-online__room-entry').filter({ hasText: 'WATCH1' })
  await expect(roomEntry.getByRole('button', { name: '旁观', exact: true })).toBeVisible()
  await roomEntry.getByRole('button', { name: '旁观', exact: true }).click()

  await expect(page.locator('.sgs-table')).toBeVisible()
  await expect(page.getByText('旁观中 · 仅显示公开牌局信息')).toBeVisible()
  await expect(page.locator('.sgs-table__hand')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '托管', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/spectator=1/)
})
