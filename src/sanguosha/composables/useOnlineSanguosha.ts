import { onBeforeUnmount, ref } from 'vue'
import { resolveApiBase } from '@/composables/useOnlineGame'
import { ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE, type OnlineSession } from '@/online/types'
import type { GameResponse } from '../engine/requests'
import type {
  SgsCommandDraft,
  SgsRoomDirectoryEntry,
  SgsRoomServerMessage,
  SgsRoomSettings,
  SgsRoomView,
} from '../online/protocol'

const ROOM_KEY = 'crplay.sanguosha.online-room'
const NICKNAME_KEY = 'red-mahjong.nickname'

function storageGet(key: string): string {
  try {
    const raw = window.localStorage.getItem(key) ?? ''
    if (!raw) return ''
    // 麻将和三国杀共用昵称。麻将按 JSON 保存字符串，旧实现直接读取会把双引号也显示出来。
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
  const rooms = ref<SgsRoomDirectoryEntry[]>([])
  const connected = ref(false)
  const connecting = ref(false)
  const busy = ref(false)
  const error = ref('')
  let socket: WebSocket | null = null
  let roomCode = ''
  let manualClose = false
  let reconnectTimer: number | null = null
  let heartbeatTimer: number | null = null

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

  function connectRoom(code: string): void {
    cleanupSocket()
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
      heartbeatTimer = window.setInterval(() => {
        if (current.readyState === WebSocket.OPEN) current.send('ping')
      }, 20_000)
    })
    current.addEventListener('message', (event) => {
      if (socket !== current || event.data === 'pong') return
      try {
        const message = JSON.parse(String(event.data)) as SgsRoomServerMessage
        if (message.type === 'room-state') room.value = message.room
        else if (message.type === 'error') error.value = message.message
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
      if (!manualClose && session.value && roomCode) reconnectTimer = window.setTimeout(() => connectRoom(roomCode), 1200)
    })
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
    room.value = null
    roomCode = ''
    storageSet(ROOM_KEY, '')
    syncRoomUrl('')
    cleanupSocket()
    void refreshRooms()
  }

  function cleanupSocket(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
    reconnectTimer = null
    heartbeatTimer = null
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

  return { session, lastNickname, room, rooms, connected, connecting, busy, error, login, restoreSession, refreshRooms, createRoom, joinRoom, send, respond, act, leaveRoom }
}
