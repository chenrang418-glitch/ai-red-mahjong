import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ONLINE_HEARTBEAT_INTERVAL_MS,
  ONLINE_PONG_TIMEOUT_MS,
  useOnlineGame,
} from '../src/composables/useOnlineGame'

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  message(payload: unknown) {
    const event = new Event('message')
    Object.defineProperty(event, 'data', { value: JSON.stringify(payload) })
    this.dispatchEvent(event)
  }

  rawMessage(payload: string) {
    const event = new Event('message')
    Object.defineProperty(event, 'data', { value: payload })
    this.dispatchEvent(event)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

function installBrowserGlobals() {
  const browserWindow = new EventTarget() as EventTarget & typeof window
  Object.assign(browserWindow, {
    location: { hostname: 'ai-red-mahjong.pages.dev', origin: 'https://ai-red-mahjong.pages.dev' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  })
  const browserDocument = new EventTarget() as EventTarget & typeof document
  Object.assign(browserDocument, { hidden: false })
  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('document', browserDocument)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/api/session')) return Response.json({ token: 'session-token', userId: 'u1', nickname: '测试玩家' })
    if (url.endsWith('/api/leaderboard')) return Response.json({ entries: [] })
    if (url.endsWith('/api/rooms')) return Response.json({ rooms: [] })
    return Response.json({ error: 'not found' }, { status: 404 })
  }))
  return { browserWindow, browserDocument }
}

async function connectedClient() {
  const online = useOnlineGame()
  await online.login('测试玩家')
  online.joinRoom('ABC234')
  const socket = FakeWebSocket.instances.at(-1)!
  socket.open()
  return { online, socket }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-15T09:00:00Z'))
  FakeWebSocket.instances = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  installBrowserGlobals()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('联机客户端连接恢复', () => {
  it('意外断线后自动重连，明确退出后不再重连', async () => {
    const { online, socket } = await connectedClient()
    socket.rawMessage('pong')
    socket.close()

    await vi.advanceTimersByTimeAsync(799)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    const reconnected = FakeWebSocket.instances[1]
    reconnected.open()
    online.leaveRoom()
    expect(reconnected.sent).toContain(JSON.stringify({ type: 'leave-room' }))

    await vi.advanceTimersByTimeAsync(ONLINE_HEARTBEAT_INTERVAL_MS * 2)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('心跳超过10秒没有应答时关闭旧连接并重连', async () => {
    const { online, socket } = await connectedClient()
    expect(socket.sent[0]).toBe('ping')

    await vi.advanceTimersByTimeAsync(ONLINE_PONG_TIMEOUT_MS)
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(online.error.value).toContain('连接响应超时')

    await vi.advanceTimersByTimeAsync(800)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('Safari从后台恢复时会立即替换已经失活的连接', async () => {
    const { socket } = await connectedClient()
    socket.rawMessage('pong')
    vi.setSystemTime(new Date(Date.now() + ONLINE_HEARTBEAT_INTERVAL_MS + ONLINE_PONG_TIMEOUT_MS + 1))

    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
