import { onBeforeUnmount, ref } from 'vue'
import { ROOM_CLOSED_BY_ADMIN_CODE, ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE } from '@/online/types'
import type {
  ChatMessage,
  LobbyServerMessage,
  OnlinePendingAction,
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
export const ONLINE_ERROR_VISIBLE_MS = 5_000
export const CHAT_BUBBLE_VISIBLE_MS = 4_000
const ONLINE_REQUEST_TIMEOUT_MS = 20_000

export function resolveApiBase(): string {
  const configured = import.meta.env.VITE_ONLINE_API_BASE?.trim().replace(/\/$/, '')
  if (configured) return configured
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) return 'http://127.0.0.1:8787'
  return window.location.origin
}

const NICKNAME_STORAGE_KEY = 'red-mahjong.nickname'
const ROOM_STORAGE_KEY = 'ai-red-mahjong.online-room'

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    // 隐私模式或存储被禁用时读不到，退回「没有记录」就行
    return null
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存不下不影响本次游玩，只是刷新后要重新输昵称
  }
}

function readRoomCode(): string {
  try { return window.sessionStorage.getItem(ROOM_STORAGE_KEY) ?? '' } catch { return '' }
}

function writeRoomCode(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(ROOM_STORAGE_KEY, value)
    else window.sessionStorage.removeItem(ROOM_STORAGE_KEY)
  } catch { /* 刷新后不能自动回房不影响当前连接 */ }
}

export function useOnlineGame() {
  const apiBase = resolveApiBase()
  const session = ref<OnlineSession | null>(null)
  const lastNickname = ref(readStored<string>(NICKNAME_STORAGE_KEY) ?? '')
  const room = ref<OnlineRoomView | null>(null)
  const rooms = ref<OnlineRoomDirectoryEntry[]>([])
  const connected = ref(false)
  const connecting = ref(false)
  const busy = ref(false)
  const error = ref('')
  const pendingAction = ref<OnlinePendingAction | null>(null)
  const chatBubbles = ref<Record<number, { id: string; text: string }>>({})
  const maintenance = ref<{ active: boolean; message: string }>({ active: false, message: '' })
  let socket: WebSocket | null = null
  let directorySocket: WebSocket | null = null
  let roomCode = ''
  let reconnectTimer: number | null = null
  let heartbeatTimer: number | null = null
  let heartbeatDeadlineTimer: number | null = null
  let connectTimeoutTimer: number | null = null
  let reconnectAttempt = 0
  let manualClose = false
  let socketGeneration = 0
  let lastPongAt = 0
  let directoryReconnectTimer: number | null = null
  let directoryHeartbeatTimer: number | null = null
  let directoryDeadlineTimer: number | null = null
  let directoryLastPongAt = 0
  let directoryRefreshTimer: number | null = null
  let pendingActionTimer: number | null = null
  let errorTimer: number | null = null

  function assertConfigured() {
    if (!apiBase) throw new Error('联机服务器地址尚未配置')
  }

  // 服务器每次报错后都会紧跟一次房间状态推送。以前状态一到就把 error 清空，
  // 结果「还有玩家未准备」「请先取消托管」这些提示还没来得及看到就没了。
  function setError(message: string) {
    error.value = message
    if (errorTimer !== null) window.clearTimeout(errorTimer)
    errorTimer = window.setTimeout(() => {
      errorTimer = null
      error.value = ''
    }, ONLINE_ERROR_VISIBLE_MS)
  }

  function clearError() {
    if (errorTimer !== null) window.clearTimeout(errorTimer)
    errorTimer = null
    error.value = ''
  }

  // 聊天气泡：消息除了进聊天面板，还要在发言人座位上短暂冒出来，
  // 这样牌桌上不用切到聊天页也知道谁说了话。
  function showChatBubble(message: ChatMessage) {
    const seatId = room.value?.seats.find((seat) => seat.userId === message.userId)?.seatId
    if (seatId === undefined) return
    chatBubbles.value = { ...chatBubbles.value, [seatId]: { id: message.id, text: message.text } }
    window.setTimeout(() => {
      if (chatBubbles.value[seatId]?.id !== message.id) return
      const next = { ...chatBubbles.value }
      delete next[seatId]
      chatBubbles.value = next
    }, CHAT_BUBBLE_VISIBLE_MS)
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    assertConfigured()
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), ONLINE_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${apiBase}${path}`, { ...init, headers, credentials: 'include', signal: controller.signal })
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
    clearError()
    try {
      const result = await request<OnlineSession>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ nickname }),
      })
      session.value = result
      lastNickname.value = result.nickname
      writeStored(NICKNAME_STORAGE_KEY, result.nickname)
      await Promise.all([refreshRooms(), refreshService()])
      connectDirectorySocket()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.value = false
    }
  }

  async function restoreSession(): Promise<boolean> {
    if (!apiBase) return false
    try {
      const restored = await request<{ session: OnlineSession | null }>('/api/session')
      session.value = restored.session
      if (!session.value) return false
      lastNickname.value = session.value.nickname
      writeStored(NICKNAME_STORAGE_KEY, session.value.nickname)
      await Promise.all([refreshRooms(), refreshService()])
      connectDirectorySocket()
      const storedRoom = readRoomCode()
      if (storedRoom && !room.value) connectRoom(storedRoom)
      return true
    } catch {
      session.value = null
      return false
    }
  }

  // 大厅要知道服务器是不是在维护，好把「创建房间」按钮灰掉并说明原因
  async function refreshService() {
    try {
      const result = await request<{ maintenance: boolean; maintenanceMessage: string }>('/api/service')
      maintenance.value = { active: result.maintenance, message: result.maintenanceMessage }
    } catch {
      maintenance.value = { active: false, message: '' }
    }
  }

  async function refreshRooms() {
    if (!session.value) return
    try {
      const result = await request<{ rooms: OnlineRoomDirectoryEntry[] }>('/api/rooms')
      rooms.value = result.rooms
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function createRoom(settings: OnlineRoomSettings) {
    busy.value = true
    clearError()
    try {
      const result = await request<{ code: string }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ settings }),
      })
      connectRoom(result.code)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.value = false
    }
  }

  function joinRoom(code: string) {
    const normalized = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{6}$/.test(normalized)) {
      setError('请输入 6 位房间号')
      return
    }
    connectRoom(normalized)
  }

  function connectRoom(code: string) {
    if (!session.value) return
    assertConfigured()
    cleanupSocket(false)
    roomCode = code
    writeRoomCode(code)
    manualClose = false
    connecting.value = true
    const url = new URL(`${apiBase}/api/rooms/${code}/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const currentGeneration = ++socketGeneration
    const currentSocket = new WebSocket(url)
    socket = currentSocket
    connectTimeoutTimer = window.setTimeout(() => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration || currentSocket.readyState !== WebSocket.CONNECTING) return
      setError('连接房间超时，正在重新连接')
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
    currentSocket.addEventListener('close', (event) => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration) return
      socket = null
      clearConnectTimeout()
      connected.value = false
      connecting.value = false
      stopHeartbeat()
      clearPendingAction()
      // 被管理员解散：和「加不进去」一样不该重连，但原因要说清楚
      // 昵称在别处登录：这台设备的会话已经作废，重连也进不来，直接退回输昵称
      if (event.code === SESSION_SUPERSEDED_CODE) {
        manualClose = true
        roomCode = ''
        writeRoomCode('')
        room.value = null
        handleSuperseded(event.reason)
        return
      }
      if (event.code === ROOM_CLOSED_BY_ADMIN_CODE) {
        manualClose = true
        roomCode = ''
        writeRoomCode('')
        room.value = null
        setError(event.reason || '房间已被管理员关闭')
        return
      }
      // 房间满员、牌局已开始、房间不存在这类拒绝，重连多少次都没用，直接退回大厅并说明原因。
      if (event.code === ROOM_REJECT_CLOSE_CODE) {
        manualClose = true
        roomCode = ''
        writeRoomCode('')
        room.value = null
        setError(event.reason || '无法加入这个房间')
        return
      }
      if (!manualClose && session.value && roomCode) scheduleReconnect()
    })
    currentSocket.addEventListener('error', () => {
      if (socket !== currentSocket || socketGeneration !== currentGeneration) return
      if (manualClose) return
      setError('联机连接中断，正在尝试重连')
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
      reconcilePendingAction(message.room)
      reconnectAttempt = 0
    } else if (message.type === 'chat' && room.value) {
      if (!room.value.chat.some((item) => item.id === message.message.id)) room.value.chat.push(message.message)
      if (room.value.chat.length > 30) room.value.chat.splice(0, room.value.chat.length - 30)
      showChatBubble(message.message)
    } else if (message.type === 'error') {
      clearPendingAction()
      setError(message.message)
    }
    else if (message.type === 'pong') {
      lastPongAt = Date.now()
      clearHeartbeatDeadline()
    }
  }

  function send(command: RoomCommand) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('尚未连接到房间')
      return
    }
    if ((command.type === 'discard' || command.type === 'trustee') && pendingAction.value) return
    if (command.type === 'discard') setPendingAction({ type: 'discard', tileId: command.tileId, version: room.value?.version ?? 0 })
    else if (command.type === 'trustee') setPendingAction({ type: 'trustee', enabled: command.enabled, version: room.value?.version ?? 0 })
    try {
      socket.send(JSON.stringify(command))
    } catch {
      clearPendingAction()
      setError('操作发送失败，正在重新连接')
      socket.close()
    }
  }

  function sendGameAction(command: RoomActionDraft) {
    if (!room.value) return
    send({ ...command, actionId: crypto.randomUUID(), version: room.value.version } as RoomCommand)
  }

  function leaveRoom() {
    const leavingSocket = socket
    if (leavingSocket?.readyState === WebSocket.OPEN) leavingSocket.send(JSON.stringify({ type: 'leave-room' }))
    manualClose = true
    // 连接要再留一会儿把「离开房间」发出去，但从这一刻起它推来的任何消息都不能再采信：
    // 退出请求还在路上时服务器可能刚好广播了一条房间状态，那会把已经回到大厅的界面
    // 重新拉回牌桌，而且因为不再重连，会一直卡在「连接中断，正在重连…」。
    socketGeneration += 1
    roomCode = ''
    writeRoomCode('')
    room.value = null
    chatBubbles.value = {}
    clearPendingAction()
    cancelReconnect()
    stopHeartbeat()
    clearConnectTimeout()
    connected.value = false
    connecting.value = false
    if (!leavingSocket || leavingSocket.readyState !== WebSocket.OPEN) disposeSocket()
    else window.setTimeout(() => {
      if (socket === leavingSocket) disposeSocket()
    }, 1500)
  }

  // 被同名的新登录顶下线。会话已经作废，留在界面上只会不停地失败，
  // 所以直接退回输昵称那一步，并把原因说清楚，不然看起来就像莫名其妙掉线。
  function handleSuperseded(reason?: string) {
    const message = reason || '这个昵称已经在别的设备上登录了'
    logout()
    setError(`${message}，如果不是你本人操作，换一个昵称再登录`)
  }

  function logout() {
    void request('/api/session', { method: 'DELETE' }).catch(() => undefined)
    leaveRoom()
    session.value = null
    writeRoomCode('')
    rooms.value = []
    closeDirectorySocket()
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
        setError('连接响应超时，正在重新连接')
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
    clearPendingAction()
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

  function setPendingAction(action: OnlinePendingAction) {
    clearPendingAction()
    pendingAction.value = action
    pendingActionTimer = window.setTimeout(() => {
      if (!pendingAction.value) return
      pendingAction.value = null
      setError('操作确认超时，请按服务器最新状态重试')
    }, 8000)
  }

  function clearPendingAction() {
    pendingAction.value = null
    if (pendingActionTimer !== null) window.clearTimeout(pendingActionTimer)
    pendingActionTimer = null
  }

  function reconcilePendingAction(nextRoom: OnlineRoomView) {
    const pending = pendingAction.value
    if (!pending) return
    if (pending.type === 'discard') {
      const hand = nextRoom.game?.players[nextRoom.selfSeatId]?.hand ?? []
      if (!hand.some((tile) => tile.id === pending.tileId)) clearPendingAction()
      return
    }
    if (nextRoom.seats[nextRoom.selfSeatId]?.trustee === pending.enabled) clearPendingAction()
  }

  function clearDirectoryDeadline() {
    if (directoryDeadlineTimer !== null) window.clearTimeout(directoryDeadlineTimer)
    directoryDeadlineTimer = null
  }

  function stopDirectoryHeartbeat() {
    if (directoryHeartbeatTimer !== null) window.clearInterval(directoryHeartbeatTimer)
    directoryHeartbeatTimer = null
    clearDirectoryDeadline()
  }

  /**
   * 大厅目录连接的心跳。和房间连接用同一套参数和判定：
   * 发完 ping 起一个 deadline，到点还没收到 pong 就认定这条连接是半死的。
   *
   * 只发 ping 不看 pong 是不够的：TCP 连接可能一直是 OPEN，但对端早就不推送了，
   * 表现出来就是房间列表停止更新，而界面看上去一切正常。
   */
  function sendDirectoryHeartbeat(currentSocket: WebSocket) {
    if (directorySocket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) return
    currentSocket.send('ping')
    clearDirectoryDeadline()
    directoryDeadlineTimer = window.setTimeout(() => {
      if (directorySocket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) return
      if (Date.now() - directoryLastPongAt >= ONLINE_PONG_TIMEOUT_MS) {
        // 关掉就会走 close 分支，按既有的 1500ms 策略重连
        currentSocket.close()
      }
    }, ONLINE_PONG_TIMEOUT_MS)
  }

  function connectDirectorySocket() {
    if (!session.value || directorySocket?.readyState === WebSocket.OPEN || directorySocket?.readyState === WebSocket.CONNECTING) return
    if (directoryReconnectTimer !== null) window.clearTimeout(directoryReconnectTimer)
    directoryReconnectTimer = null
    const url = new URL(`${apiBase}/api/lobby/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const currentSocket = new WebSocket(url)
    directorySocket = currentSocket
    currentSocket.addEventListener('open', () => {
      if (directorySocket !== currentSocket) return
      // 刚连上先当作收到过一次 pong，否则第一个 deadline 会拿 0 去比而立刻误判
      directoryLastPongAt = Date.now()
      stopDirectoryHeartbeat()
      sendDirectoryHeartbeat(currentSocket)
      directoryHeartbeatTimer = window.setInterval(() => sendDirectoryHeartbeat(currentSocket), ONLINE_HEARTBEAT_INTERVAL_MS)
    })
    currentSocket.addEventListener('message', (event) => {
      if (directorySocket !== currentSocket) return
      if (event.data === 'pong') {
        directoryLastPongAt = Date.now()
        clearDirectoryDeadline()
        return
      }
      try {
        const message = JSON.parse(String(event.data)) as LobbyServerMessage
        if (message.type === 'rooms-updated') scheduleDirectoryRefresh()
      } catch {
        // Ignore malformed lobby notifications; the room connection remains authoritative.
      }
    })
    currentSocket.addEventListener('close', (event) => {
      if (directorySocket !== currentSocket) return
      directorySocket = null
      stopDirectoryHeartbeat()
      if (event.code === SESSION_SUPERSEDED_CODE) {
        handleSuperseded(event.reason)
        return
      }
      if (session.value) directoryReconnectTimer = window.setTimeout(connectDirectorySocket, 1500)
    })
  }

  function scheduleDirectoryRefresh() {
    if (directoryRefreshTimer !== null) return
    directoryRefreshTimer = window.setTimeout(() => {
      directoryRefreshTimer = null
      void refreshRooms()
    }, 120)
  }

  function closeDirectorySocket() {
    if (directoryReconnectTimer !== null) window.clearTimeout(directoryReconnectTimer)
    if (directoryRefreshTimer !== null) window.clearTimeout(directoryRefreshTimer)
    stopDirectoryHeartbeat()
    directoryReconnectTimer = null
    directoryRefreshTimer = null
    const previous = directorySocket
    directorySocket = null
    previous?.close()
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
    setError('网络已断开，恢复后将自动重连')
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
    closeDirectorySocket()
  })

  return {
    apiConfigured: !!apiBase,
    session,
    lastNickname,
    room,
    rooms,
    connected,
    connecting,
    busy,
    error,
    pendingAction,
    chatBubbles,
    maintenance,
    refreshService,
    restoreSession,
    login,
    logout,
    refreshRooms,
    createRoom,
    joinRoom,
    leaveRoom,
    send,
    sendGameAction,
  }
}
