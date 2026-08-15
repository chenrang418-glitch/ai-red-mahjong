import { onBeforeUnmount, ref } from 'vue'
import type {
  LeaderboardEntry,
  OnlineRoomDirectoryEntry,
  OnlineRoomSettings,
  OnlineRoomView,
  OnlineSession,
  RoomActionDraft,
  RoomCommand,
  RoomServerMessage,
} from '@/online/types'

export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_ONLINE_API_BASE?.trim().replace(/\/$/, '')
  if (configured) return configured
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) return 'http://127.0.0.1:8787'
  return window.location.origin
}

export function useOnlineGame() {
  const apiBase = resolveApiBase()
  const session = ref<OnlineSession | null>(null)
  const room = ref<OnlineRoomView | null>(null)
  const rooms = ref<OnlineRoomDirectoryEntry[]>([])
  const leaderboard = ref<LeaderboardEntry[]>([])
  const connected = ref(false)
  const connecting = ref(false)
  const busy = ref(false)
  const error = ref('')
  let socket: WebSocket | null = null
  let roomCode = ''
  let reconnectTimer: number | null = null
  let heartbeatTimer: number | null = null
  let reconnectAttempt = 0
  let manualClose = false

  function assertConfigured() {
    if (!apiBase) throw new Error('联机服务器地址尚未配置')
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertConfigured()
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    if (session.value) headers.set('authorization', `Bearer ${session.value.token}`)
    const response = await fetch(`${apiBase}${path}`, { ...init, headers })
    const payload = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(payload.error || `服务器返回 ${response.status}`)
    return payload
  }

  async function login(nickname: string) {
    busy.value = true
    error.value = ''
    try {
      const result = await request<OnlineSession>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ nickname }),
      })
      session.value = result
      await Promise.all([refreshLeaderboard(), refreshRooms()])
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }

  async function refreshLeaderboard() {
    try {
      const result = await request<{ entries: LeaderboardEntry[] }>('/api/leaderboard')
      leaderboard.value = result.entries
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function refreshRooms() {
    if (!session.value) return
    try {
      const result = await request<{ rooms: OnlineRoomDirectoryEntry[] }>('/api/rooms')
      rooms.value = result.rooms
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function createRoom(settings: OnlineRoomSettings) {
    busy.value = true
    error.value = ''
    try {
      const result = await request<{ code: string }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ settings }),
      })
      connectRoom(result.code)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }

  function joinRoom(code: string) {
    const normalized = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      error.value = '请输入 6 位房间号'
      return
    }
    connectRoom(normalized)
  }

  function connectRoom(code: string) {
    if (!session.value) return
    assertConfigured()
    cleanupSocket(false)
    roomCode = code
    manualClose = false
    connecting.value = true
    const url = new URL(`${apiBase}/api/rooms/${code}/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('session', session.value.token)
    socket = new WebSocket(url)
    socket.addEventListener('open', () => {
      connected.value = true
      connecting.value = false
      reconnectAttempt = 0
      startHeartbeat()
    })
    socket.addEventListener('message', (event) => handleMessage(event.data))
    socket.addEventListener('close', () => {
      connected.value = false
      connecting.value = false
      stopHeartbeat()
      if (!manualClose && session.value && roomCode) scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      error.value = '联机连接中断，正在尝试重连'
    })
  }

  function handleMessage(raw: string) {
    const message = JSON.parse(raw) as RoomServerMessage
    if (message.type === 'room-state') {
      room.value = message.room
      error.value = ''
    } else if (message.type === 'chat' && room.value) {
      if (!room.value.chat.some((item) => item.id === message.message.id)) room.value.chat.push(message.message)
      if (room.value.chat.length > 30) room.value.chat.splice(0, room.value.chat.length - 30)
    } else if (message.type === 'error') error.value = message.message
  }

  function send(command: RoomCommand) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      error.value = '尚未连接到房间'
      return
    }
    socket.send(JSON.stringify(command))
  }

  function sendGameAction(command: RoomActionDraft) {
    if (!room.value) return
    send({ ...command, actionId: crypto.randomUUID(), version: room.value.version } as RoomCommand)
  }

  function leaveRoom() {
    manualClose = true
    roomCode = ''
    room.value = null
    cleanupSocket(true)
  }

  function logout() {
    leaveRoom()
    session.value = null
    rooms.value = []
    leaderboard.value = []
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    const delay = Math.min(10_000, 800 * (2 ** reconnectAttempt))
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(() => connectRoom(roomCode), delay)
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
    }, 45_000)
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }

  function cleanupSocket(close: boolean) {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = null
    stopHeartbeat()
    if (close) manualClose = true
    socket?.close()
    socket = null
    connected.value = false
  }

  onBeforeUnmount(() => cleanupSocket(true))

  return {
    apiConfigured: !!apiBase,
    session,
    room,
    rooms,
    leaderboard,
    connected,
    connecting,
    busy,
    error,
    login,
    logout,
    refreshLeaderboard,
    refreshRooms,
    createRoom,
    joinRoom,
    leaveRoom,
    send,
    sendGameAction,
  }
}
