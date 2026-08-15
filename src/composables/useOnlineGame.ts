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

export const ONLINE_HEARTBEAT_INTERVAL_MS = 20_000
export const ONLINE_PONG_TIMEOUT_MS = 10_000
export const ONLINE_CONNECT_TIMEOUT_MS = 15_000
const ONLINE_REQUEST_TIMEOUT_MS = 20_000

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
  let heartbeatDeadlineTimer: number | null = null
  let connectTimeoutTimer: number | null = null
  let reconnectAttempt = 0
  let manualClose = false
  let socketGeneration = 0
  let lastPongAt = 0

  function assertConfigured() {
    if (!apiBase) throw new Error('联机服务器地址尚未配置')
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertConfigured()
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    if (session.value) headers.set('authorization', `Bearer ${session.value.token}`)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), ONLINE_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${apiBase}${path}`, { ...init, headers, signal: controller.signal })
      const payload = await response.json() as T & { error?: string }
      if (!response.ok) throw new Error(payload.error || `服务器返回 ${response.status}`)
      return payload
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw new Error('连接服务器超时，请检查网络后重试')
      throw cause
    } finally {
      window.clearTimeout(timeout)
    }
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
    const currentGeneration = ++socketGeneration
    const currentSocket = new WebSocket(url)
    socket = currentSocket
    connectTimeoutTimer = window.setTimeout(() => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration || currentSocket.readyState !== WebSocket.CONNECTING) return
      error.value = '连接房间超时，正在重新连接'
      currentSocket.close()
    }, ONLINE_CONNECT_TIMEOUT_MS)
    currentSocket.addEventListener('open', () => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration) return
      clearConnectTimeout()
      connected.value = true
      connecting.value = false
      reconnectAttempt = 0
      lastPongAt = Date.now()
      startHeartbeat(currentSocket, currentGeneration)
    })
    currentSocket.addEventListener('message', (event) => {
      if (socket === currentSocket && socketGeneration === currentGeneration) handleMessage(event.data)
    })
    currentSocket.addEventListener('close', () => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration) return
      socket = null
      clearConnectTimeout()
      connected.value = false
      connecting.value = false
      stopHeartbeat()
      if (!manualClose && session.value && roomCode) scheduleReconnect()
    })
    currentSocket.addEventListener('error', () => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration) return
      error.value = '联机连接中断，正在尝试重连'
    })
  }

  function handleMessage(raw: string) {
    if (raw === 'pong') {
      lastPongAt = Date.now()
      clearHeartbeatDeadline()
      return
    }
    const message = JSON.parse(raw) as RoomServerMessage
    if (message.type === 'room-state') {
      room.value = message.room
      error.value = ''
      reconnectAttempt = 0
    } else if (message.type === 'chat' && room.value) {
      if (!room.value.chat.some((item) => item.id === message.message.id)) room.value.chat.push(message.message)
      if (room.value.chat.length > 30) room.value.chat.splice(0, room.value.chat.length - 30)
    } else if (message.type === 'error') error.value = message.message
    else if (message.type === 'pong') {
      lastPongAt = Date.now()
      clearHeartbeatDeadline()
    }
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
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave-room' }))
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

  function scheduleReconnect(immediate = false) {
    cancelReconnect()
    const delay = immediate ? 0 : Math.min(10_000, 800 * (2 ** reconnectAttempt))
    reconnectAttempt += 1
    const expectedRoomCode = roomCode
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (!manualClose && session.value && roomCode === expectedRoomCode) connectRoom(expectedRoomCode)
    }, delay)
  }

  function startHeartbeat(currentSocket: WebSocket, generation: number) {
    stopHeartbeat()
    const ping = () => sendHeartbeat(currentSocket, generation)
    ping()
    heartbeatTimer = window.setInterval(ping, ONLINE_HEARTBEAT_INTERVAL_MS)
  }

  function sendHeartbeat(currentSocket: WebSocket, generation: number) {
    if (socket !== currentSocket || socketGeneration !== generation || currentSocket.readyState !== WebSocket.OPEN) return
    currentSocket.send('ping')
    clearHeartbeatDeadline()
    heartbeatDeadlineTimer = window.setTimeout(() => {
      if (socket !== currentSocket || socketGeneration !== generation || currentSocket.readyState !== WebSocket.OPEN) return
      if (Date.now() - lastPongAt >= ONLINE_PONG_TIMEOUT_MS) {
        error.value = '连接响应超时，正在重新连接'
        currentSocket.close()
      }
    }, ONLINE_PONG_TIMEOUT_MS)
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
    heartbeatTimer = null
    clearHeartbeatDeadline()
  }

  function cleanupSocket(close: boolean) {
    cancelReconnect()
    stopHeartbeat()
    clearConnectTimeout()
    if (close) manualClose = true
    disposeSocket()
    connected.value = false
    connecting.value = false
  }

  function disposeSocket() {
    const previous = socket
    socket = null
    socketGeneration += 1
    previous?.close()
  }

  function cancelReconnect() {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function clearHeartbeatDeadline() {
    if (heartbeatDeadlineTimer !== null) window.clearTimeout(heartbeatDeadlineTimer)
    heartbeatDeadlineTimer = null
  }

  function clearConnectTimeout() {
    if (connectTimeoutTimer !== null) window.clearTimeout(connectTimeoutTimer)
    connectTimeoutTimer = null
  }

  function resumeConnection() {
    if (manualClose || !session.value || !roomCode || !navigator.onLine) return
    if (socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - lastPongAt <= ONLINE_HEARTBEAT_INTERVAL_MS + ONLINE_PONG_TIMEOUT_MS) {
        sendHeartbeat(socket, socketGeneration)
        return
      }
      disposeSocket()
      connected.value = false
      connecting.value = false
    }
    if (!socket || socket.readyState !== WebSocket.CONNECTING) scheduleReconnect(true)
  }

  const handleVisible = () => { if (!document.hidden) resumeConnection() }
  const handleOffline = () => {
    connected.value = false
    error.value = '网络已断开，恢复后将自动重连'
  }
  window.addEventListener('online', resumeConnection)
  window.addEventListener('offline', handleOffline)
  window.addEventListener('pageshow', resumeConnection)
  document.addEventListener('visibilitychange', handleVisible)

  onBeforeUnmount(() => {
    window.removeEventListener('online', resumeConnection)
    window.removeEventListener('offline', handleOffline)
    window.removeEventListener('pageshow', resumeConnection)
    document.removeEventListener('visibilitychange', handleVisible)
    cleanupSocket(true)
  })

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
