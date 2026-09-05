import { onBeforeUnmount, ref } from 'vue'
import { resolveApiBase } from '@/composables/useOnlineGame'
import { ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE, type OnlineSession } from '@/online/types'
import type { GameResponse } from '../engine/requests'
import type {
  SgsChatMessage,
  SgsCommandDraft,
  SgsRoomDirectoryEntry,
  SgsRoomServerMessage,
  SgsRoomSettings,
  SgsRoomView,
} from '../online/protocol'
import { reconnectDelay } from '../online/reconnect'

/**
 * 心跳间隔与失联判定。
 *
 * 服务端用的是 Cloudflare 的 `WebSocketRequestResponsePair('ping','pong')`
 * 自动应答，所以心跳**不会**唤醒 Durable Object、不会跑游戏逻辑，
 * 把间隔从 20 秒收到 15 秒几乎没有额外成本。
 * 超时取 35 秒（约两个间隔多一点）：低于 25 秒会在正常的网络抖动里误判重连。
 */
const HEARTBEAT_INTERVAL_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 35_000

const ROOM_KEY = 'crplay.sanguosha.online-room'
const NICKNAME_KEY = 'red-mahjong.nickname'
/** 和服务端 CHAT_MAX 对齐，本地补进来的那条也不该让列表无限长 */
const CHAT_KEEP = 40
/** 气泡停留时长，和麻将一致 */
const CHAT_BUBBLE_MS = 4000

function storageGet(key: string): string {
  try {
    const raw = window.localStorage.getItem(key) ?? ''
    if (!raw) return ''
    // 麻将和纸上三国共用昵称。麻将按 JSON 保存字符串，旧实现直接读取会把双引号也显示出来。
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'string' ? parsed : ''
    } catch {
      return raw
    }
  } catch { return '' }
}

function storageSet(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value))
    else window.localStorage.removeItem(key)
  } catch { /* 当前会话仍可继续 */ }
}

/**
 * 把当前房间号同步进地址栏。
 *
 * 不这么做的话刷新页面就掉回首页：`SanguoshaApp` 是看 `?room=` 决定显示哪个界面的，
 * 而房间号只存在 localStorage 里——于是后台其实还连着房间，用户却看到首页。
 * 顺带让地址栏本身就是一条可分享的邀请链接。
 */
function syncRoomUrl(code: string): void {
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get('room') === code) return
    url.searchParams.set('game', 'sanguosha')
    if (code) url.searchParams.set('room', code)
    else url.searchParams.delete('room')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch { /* 地址栏同步失败不该影响牌局 */ }
}

export function useOnlineSanguosha() {
  const apiBase = resolveApiBase()
  const session = ref<OnlineSession | null>(null)
  const lastNickname = ref(storageGet(NICKNAME_KEY))
  const room = ref<SgsRoomView | null>(null)
  /**
   * 服务器时钟相对本地时钟的偏移。
   *
   * `deadlineAt` 是服务器时间戳；设备时钟慢 3 秒，倒计时就会多走 3 秒。
   * 每个样本恒等于「真实偏移 - 单程延迟」，所以取历次最大值，
   * 等价于采用网络延迟最小的那次采样。断线后重新标定：换了服务器实例
   * 或睡眠唤醒之后，旧偏移不一定还成立。
   */
  const clockOffset = ref(0)
  let clockCalibrated = false
  function calibrateClock(serverNow: number | undefined): void {
    if (!serverNow) return
    const sample = serverNow - Date.now()
    if (!clockCalibrated || sample > clockOffset.value) {
      clockOffset.value = sample
      clockCalibrated = true
    }
  }
  const rooms = ref<SgsRoomDirectoryEntry[]>([])
  const connected = ref(false)
  const connecting = ref(false)
  const busy = ref(false)
  const error = ref('')
  /** 按 playerId（seat-N）存的临时气泡，牌桌上不点开聊天也知道谁说了话 */
  const chatBubbles = ref<Record<string, { id: number; text: string }>>({})
  let socket: WebSocket | null = null
  let roomCode = ''
  let manualClose = false
  let reconnectTimer: number | null = null
  let reconnectAttempt = 0
  let heartbeatTimer: number | null = null
  /**
   * 最后一次收到 `pong` 的时刻。
   *
   * 半断开的连接（NAT 映射失效、Wi-Fi 切换、代理变化、中间设备丢状态）里，
   * 浏览器仍然认为 `readyState === OPEN`，`send` 也不抛异常，`close` 事件
   * 永远不会来——于是重连逻辑一次都不会触发，这一名玩家的画面就永久停在旧状态。
   * 唯一能发现它的办法就是记账「多久没收到 pong 了」。
   */
  let lastPongAt = 0

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    const response = await fetch(`${apiBase}${path}`, { ...init, headers, credentials: 'include' })
    const payload = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(payload.error || `服务器返回 ${response.status}`)
    return payload
  }

  async function refreshRooms(): Promise<void> {
    if (!session.value) return
    try { rooms.value = (await request<{ rooms: SgsRoomDirectoryEntry[] }>('/api/sanguosha/rooms')).rooms }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  }

  async function login(nickname: string): Promise<void> {
    busy.value = true
    error.value = ''
    try {
      session.value = await request<OnlineSession>('/api/session', { method: 'POST', body: JSON.stringify({ nickname }) })
      lastNickname.value = session.value.nickname
      storageSet(NICKNAME_KEY, session.value.nickname)
      await refreshRooms()
      const invited = new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? ''
      if (/^[A-Z0-9]{6}$/.test(invited)) connectRoom(invited)
    } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { busy.value = false }
  }

  async function restoreSession(): Promise<void> {
    try {
      session.value = (await request<{ session: OnlineSession | null }>('/api/session')).session
      if (!session.value) return
      lastNickname.value = session.value.nickname
      await refreshRooms()
      const invited = new URLSearchParams(window.location.search).get('room')?.toUpperCase()
      const stored = storageGet(ROOM_KEY)
      if (invited && /^[A-Z0-9]{6}$/.test(invited)) connectRoom(invited)
      else if (stored) connectRoom(stored)
    } catch { session.value = null }
  }

  async function createRoom(settings: SgsRoomSettings): Promise<void> {
    busy.value = true
    error.value = ''
    try {
      const result = await request<{ code: string }>('/api/sanguosha/rooms', {
        method: 'POST', body: JSON.stringify({ settings }),
      })
      connectRoom(result.code)
    } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { busy.value = false }
  }

  function joinRoom(code: string): void {
    const normalized = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      error.value = '请输入 6 位房间号'
      return
    }
    connectRoom(normalized)
  }

  function connectRoom(code: string, reconnecting = false): void {
    cleanupSocket()
    if (!reconnecting) reconnectAttempt = 0
    roomCode = code
    storageSet(ROOM_KEY, code)
    syncRoomUrl(code)
    manualClose = false
    connecting.value = true
    const url = new URL(`${apiBase}/api/sanguosha/rooms/${code}/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const current = new WebSocket(url)
    socket = current
    current.addEventListener('open', () => {
      if (socket !== current) return
      connected.value = true
      connecting.value = false
      reconnectAttempt = 0
      lastPongAt = Date.now()
      heartbeatTimer = window.setInterval(() => {
        // 这个定时器可能比它的 socket 活得久（cleanup 之间的竞态），每次都要认一下
        if (socket !== current) return
        /*
         * 先判失联再发 ping：连接半断开时 `send` 不会抛异常，
         * 只有「很久没收到 pong」这一个信号能发现它。
         * 主动 close 之后走的是既有的 close → reconnect 那条路，
         * 不在这里另起一套重连，避免两条路径同时重连。
         */
        const silence = Date.now() - lastPongAt
        if (silence > HEARTBEAT_TIMEOUT_MS) {
          console.warn('[sanguosha][websocket-timeout]', JSON.stringify({
            roomCode, lastPongAge: silence, reconnectAttempt, readyState: current.readyState,
          }))
          current.close()
          return
        }
        if (current.readyState === WebSocket.OPEN) current.send('ping')
      }, HEARTBEAT_INTERVAL_MS)
    })
    current.addEventListener('error', () => {
      if (socket !== current) return
      /*
       * 只把连接关掉，**不在这里重连**：`error` 之后浏览器一定还会发 `close`，
       * 两个地方各起一次重连会留下两条连接和两套定时器。
       */
      current.close()
    })
    current.addEventListener('message', (event) => {
      if (socket !== current) return
      if (event.data === 'pong') {
        // 心跳记账：丢掉它就等于没有心跳
        lastPongAt = Date.now()
        return
      }
      try {
        const message = JSON.parse(String(event.data)) as SgsRoomServerMessage
        if (message.type === 'room-state') { calibrateClock(message.room.serverNow); room.value = message.room }
        else if (message.type === 'error') error.value = message.message
        else if (message.type === 'chat') { appendChat(message.message); showChatBubble(message.message) }
      } catch { error.value = '服务器返回了无法识别的数据' }
    })
    current.addEventListener('close', (event) => {
      if (socket !== current) return
      cleanupSocket()
      if (event.code === ROOM_REJECT_CLOSE_CODE || event.code === SESSION_SUPERSEDED_CODE) {
        room.value = null
        roomCode = ''
        storageSet(ROOM_KEY, '')
        syncRoomUrl('')
        error.value = event.reason || '无法进入房间'
        if (event.code === SESSION_SUPERSEDED_CODE) session.value = null
        return
      }
      if (!manualClose && session.value && roomCode) {
        const delay = reconnectDelay(reconnectAttempt)
        reconnectAttempt += 1
        reconnectTimer = window.setTimeout(() => connectRoom(roomCode, true), delay)
      }
    })
  }

  /**
   * 聊天是单独一帧，不跟着房间状态走。
   *
   * 服务端为一行字发全量快照太贵，所以 `broadcast({type:'chat'})` 是**代替**
   * 状态广播的——客户端不自己接上，消息就永远到不了界面。
   * 下一次房间状态到达时会用服务端那份权威列表整体覆盖，所以这里不会积累重复。
   */
  function appendChat(entry: SgsChatMessage): void {
    const current = room.value
    if (!current || current.chat.some((existing) => existing.id === entry.id)) return
    const chat = [...current.chat, entry]
    room.value = { ...current, chat: chat.length > CHAT_KEEP ? chat.slice(-CHAT_KEEP) : chat }
  }

  /**
   * 在说话那家的座位上冒一个气泡，几秒后自己消失。
   * 只在收到聊天帧时触发——房间状态里的历史消息不该在重连时集体炸出来。
   */
  function showChatBubble(entry: SgsChatMessage): void {
    if (entry.seatId === undefined) return
    const playerId = `seat-${entry.seatId}`
    chatBubbles.value = { ...chatBubbles.value, [playerId]: { id: entry.id, text: entry.text } }
    window.setTimeout(() => {
      // 这几秒里又说了新的一句就别把新的擦掉
      if (chatBubbles.value[playerId]?.id !== entry.id) return
      const next = { ...chatBubbles.value }
      delete next[playerId]
      chatBubbles.value = next
    }, CHAT_BUBBLE_MS)
  }

  function send(command: SgsCommandDraft): void {
    if (!socket || socket.readyState !== WebSocket.OPEN || !room.value) {
      error.value = '尚未连接到房间'
      return
    }
    socket.send(JSON.stringify({ ...command, actionId: crypto.randomUUID(), baseSeq: room.value.version }))
  }

  function respond(response: GameResponse): void {
    send({ type: 'respond', requestId: response.requestId, payload: response.payload })
  }

  function act(legalActionId: string): void { send({ type: 'act', legalActionId }) }

  function leaveRoom(): void {
    if (socket?.readyState === WebSocket.OPEN && room.value) {
      socket.send(JSON.stringify({ type: 'leave-room', actionId: crypto.randomUUID(), baseSeq: room.value.version }))
    }
    manualClose = true
    reconnectAttempt = 0
    room.value = null
    roomCode = ''
    storageSet(ROOM_KEY, '')
    syncRoomUrl('')
    cleanupSocket()
    void refreshRooms()
  }

  /**
   * 退出登录。和麻将同一套动作：先请服务端作废会话，再断开房间、清掉本地痕迹。
   * 会话删除失败也照样退到输昵称那一步——留在界面上只会一路失败。
   */
  function logout(): void {
    void request('/api/session', { method: 'DELETE' }).catch(() => undefined)
    // 先清会话再离开房间：leaveRoom 末尾会去刷房间列表，会话还在的话
    // 那个请求会在退出之后才返回，把列表又填回来
    session.value = null
    leaveRoom()
    rooms.value = []
    error.value = ''
  }

  function cleanupSocket(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
    reconnectTimer = null
    heartbeatTimer = null
    lastPongAt = 0
    // 断线后重新标定：睡眠唤醒、切换网络之后旧的偏移不一定还成立
    clockCalibrated = false
    const previous = socket
    socket = null
    connected.value = false
    connecting.value = false
    previous?.close()
  }

  onBeforeUnmount(() => {
    manualClose = true
    cleanupSocket()
  })

  return { session, lastNickname, room, rooms, connected, connecting, busy, error, chatBubbles, clockOffset, login, restoreSession, refreshRooms, createRoom, joinRoom, send, respond, act, leaveRoom, logout }
}
