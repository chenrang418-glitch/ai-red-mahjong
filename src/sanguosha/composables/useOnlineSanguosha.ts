import { onBeforeUnmount, ref } from 'vue'
import { resolveApiBase } from '@/composables/useOnlineGame'
import { ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE, type OnlineSession } from '@/online/types'
import { reconnectDelay } from '../online/reconnect'
import type { GameResponse } from '../engine/requests'
import type {
  SgsChatMessage,
  SgsCommandDraft,
  SgsRoomDirectoryEntry,
  SgsRoomServerMessage,
  SgsRoomSettings,
  SgsRoomView,
} from '../online/protocol'

/**
 * 连接健康判定。
 *
 * 主心跳现在由**服务端**主动发（约 4.5 秒一次）。为什么不能只靠客户端
 * `setInterval`：手机浏览器把页面切到后台之后 JS 定时器会被节流甚至冻结，
 * 客户端自己发不出心跳，也就永远发现不了「socket 还是 OPEN、数据其实不通」
 * 这种半死连接——用户看到的就是「按键失灵，只能大退」。
 *
 * 客户端这边保留一条辅助探针，作用有两个：探测上行方向（服务端心跳只能证明
 * 下行还通），以及页面回到前台时立刻验一次。
 *
 * 12 秒没收到服务端任何消息就当连接有问题：服务端 4.5 秒一次，
 * 连丢两次多一点才判定，正常抖动不会误伤。
 */
const SERVER_SILENCE_LIMIT_MS = 12_000
const CLIENT_PROBE_INTERVAL_MS = 5_000
/** 建连迟迟不 open 时的上限。超过就换一条新的，不让坏 socket 一直占着。 */
const CONNECT_TIMEOUT_MS = 7_000
/** 待确认操作的上限与过期时间。防 bug 情况下无限堆积。 */
const PENDING_MAX = 32
const PENDING_TTL_MS = 20_000

/**
 * 一次点击对应的操作。
 *
 * 关键是 `actionId` **只生成一次**：重发时沿用同一个 id，服务端靠它做幂等，
 * 于是「已经执行成功但回执丢了」和「真的没送到」这两种情况都能安全处理——
 * 前者服务端回一个 duplicate 回执，不会执行第二遍。
 */
interface PendingAction {
  actionId: string
  command: SgsCommandDraft
  baseSeq: number
  createdAt: number
  attempts: number
}

export type SgsConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'resyncing' | 'closed'


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
  let probeTimer: number | null = null
  let connectTimeoutTimer: number | null = null
  /**
   * 当前连接的「代」。
   *
   * 每建一条新 socket 就加一。旧 socket 的 open/message/close/定时器都要先对一下代号，
   * 否则一条延迟到达的旧事件会把新连接的状态覆盖掉——错误、close、心跳超时
   * 几乎同时发生时最容易撞上。
   */
  let generation = 0
  /**
   * 最后一次收到**服务端任何消息**的时刻。
   *
   * 半断开的连接（NAT 映射失效、Wi-Fi 切换、代理变化、中间设备丢状态）里，
   * 浏览器仍然认为 `readyState === OPEN`，`send` 也不抛异常，`close` 事件
   * 永远不会来——于是重连逻辑一次都不会触发，玩家的画面就永久停在旧状态。
   * 唯一能发现它的办法就是记账「多久没听到服务端说话了」。
   */
  let lastServerMessageAt = 0
  /** 已发出、还没收到回执的操作。断线时**不清空**，重连后按原 actionId 重发。 */
  const pending = new Map<string, PendingAction>()
  const connectionState = ref<SgsConnectionState>('disconnected')
  const pendingCount = ref(0)
  /** 最近一次心跳往返耗时，调试浮层用。 */
  const heartbeatRtt = ref(0)
  const reconnectCount = ref(0)
  let lastProbeSentAt = 0

  function syncPendingCount(): void { pendingCount.value = pending.size }

  /** 这条连接现在健康吗：socket 开着，而且服务端最近还说过话。 */
  function connectionHealthy(): boolean {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    return Date.now() - lastServerMessageAt <= SERVER_SILENCE_LIMIT_MS
  }

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
      /*
       * 带上 `createRequestId`。
       *
       * 建房是 POST，天生不幂等：网络慢的时候用户多点一次、或者前端自己重试，
       * 就会凭空多出一个房间，而房主只会进其中一个，另一个变成永远没人的僵尸房。
       * 同一个 id 重发时服务端直接把上次的房间号还回来。
       */
      const createRequestId = crypto.randomUUID()
      const result = await request<{ code: string }>('/api/sanguosha/rooms', {
        method: 'POST', body: JSON.stringify({ settings, createRequestId }),
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
    closeCurrentSocket()
    if (!reconnecting) {
      reconnectAttempt = 0
      pending.clear()
      syncPendingCount()
    }
    roomCode = code
    storageSet(ROOM_KEY, code)
    syncRoomUrl(code)
    manualClose = false
    connecting.value = true
    connectionState.value = reconnecting ? 'reconnecting' : 'connecting'

    const url = new URL(`${apiBase}/api/sanguosha/rooms/${code}/socket`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const mine = ++generation
    const current = new WebSocket(url)
    socket = current

    /*
     * 建连超时。
     *
     * 没有它的话，一条永远 open 不了的 socket 会把界面钉在「连接中」，
     * close 事件也不会来，重连自然也不会发生。到点就换一条新的。
     */
    connectTimeoutTimer = window.setTimeout(() => {
      if (generation !== mine || current.readyState === WebSocket.OPEN) return
      console.warn('[sanguosha][connect-timeout]', JSON.stringify({ roomCode, reconnectAttempt }))
      try { current.close() } catch { /* 已经断了 */ }
      scheduleReconnect()
    }, CONNECT_TIMEOUT_MS)

    current.addEventListener('open', () => {
      if (generation !== mine) return
      clearConnectTimeout()
      connected.value = true
      connecting.value = false
      reconnectAttempt = 0
      lastServerMessageAt = Date.now()
      /*
       * 刚连上先当作「同步中」：TCP 通了不代表已经拿到权威状态。
       * 收到第一帧 room-state 之后才允许把待确认的操作重发出去。
       */
      connectionState.value = 'resyncing'
      // 不等第一个心跳周期，立刻探一次，顺便把 RTT 标定出来
      probe()
      probeTimer = window.setInterval(() => {
        if (generation !== mine) return
        if (!connectionHealthy()) {
          console.warn('[sanguosha][link-silent]', JSON.stringify({
            roomCode, silentMs: Date.now() - lastServerMessageAt, reconnectAttempt,
          }))
          try { current.close() } catch { /* 已经断了 */ }
          return
        }
        probe()
      }, CLIENT_PROBE_INTERVAL_MS)
    })

    current.addEventListener('error', () => {
      if (generation !== mine) return
      /*
       * 只把连接关掉，**不在这里重连**：`error` 之后浏览器一定还会发 `close`，
       * 两个地方各起一次重连会留下两条连接和两套定时器。
       */
      try { current.close() } catch { /* 已经断了 */ }
    })

    current.addEventListener('message', (event) => {
      if (generation !== mine) return
      lastServerMessageAt = Date.now()
      if (event.data === 'pong') {
        heartbeatRtt.value = Date.now() - lastProbeSentAt
        return
      }
      try {
        handleServerMessage(JSON.parse(String(event.data)) as SgsRoomServerMessage, current)
      } catch { error.value = '服务器返回了无法识别的数据' }
    })

    current.addEventListener('close', (event) => {
      if (generation !== mine) return
      closeCurrentSocket()
      if (event.code === ROOM_REJECT_CLOSE_CODE || event.code === SESSION_SUPERSEDED_CODE) {
        room.value = null
        roomCode = ''
        pending.clear()
        syncPendingCount()
        connectionState.value = 'closed'
        storageSet(ROOM_KEY, '')
        syncRoomUrl('')
        error.value = event.reason || '无法进入房间'
        if (event.code === SESSION_SUPERSEDED_CODE) session.value = null
        return
      }
      scheduleReconnect()
    })
  }

  /** 服务端消息统一入口。 */
  function handleServerMessage(message: SgsRoomServerMessage, current: WebSocket): void {
    if (message.type === 'room-state') {
      calibrateClock(message.room.serverNow)
      room.value = message.room
      /*
       * 拿到权威状态才算真正连上。重连之后待确认的操作在这一刻重发——
       * 早于此就发的话，用的还是断线前的旧版本，服务端多半直接拒掉。
       */
      if (connectionState.value !== 'connected') connectionState.value = 'connected'
      flushPending(current)
      return
    }
    if (message.type === 'server-heartbeat') {
      /*
       * 回执里带上自己知道的版本。服务端一比对就能发现「某一帧状态在网络里丢了」，
       * 立刻补一份完整快照——不必等玩家下一次操作才暴露出状态分叉。
       */
      sendRaw(current, {
        type: 'client-heartbeat-ack',
        heartbeatId: message.heartbeatId,
        lastKnownVersion: room.value?.version ?? -1,
      })
      calibrateClock(message.serverNow)
      // 反向也查一次：服务端版本比我新，说明我漏了帧，主动要一份
      if (room.value && message.roomVersion > room.value.version) {
        sendRaw(current, { type: 'request-sync', lastKnownVersion: room.value.version })
      }
      return
    }
    if (message.type === 'action-ack') {
      const entry = pending.get(message.actionId)
      pending.delete(message.actionId)
      syncPendingCount()
      if (entry && !message.accepted) {
        /*
         * 明确被拒：清掉就好，**不要重发**。
         * 抢答窗口早就过去了这种情况正是靠它收场的——绝不能偷偷补执行一次。
         */
        error.value = message.reason || '操作没有生效'
      }
      return
    }
    if (message.type === 'error') { error.value = message.message; return }
    if (message.type === 'chat') { appendChat(message.message); showChatBubble(message.message) }
  }

  function sendRaw(target: WebSocket, payload: unknown): void {
    if (target.readyState !== WebSocket.OPEN) return
    try { target.send(JSON.stringify(payload)) } catch { /* 下一轮健康检查会发现 */ }
  }

  function probe(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    lastProbeSentAt = Date.now()
    try { socket.send('ping') } catch { /* 下一轮健康检查会发现 */ }
  }

  /** 把还没拿到回执的操作按原 actionId 重发一遍。 */
  function flushPending(target: WebSocket): void {
    if (target.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    for (const [actionId, entry] of [...pending]) {
      if (now - entry.createdAt > PENDING_TTL_MS || entry.attempts >= 4) {
        // 太久没结果的就放弃，免得永远挂着。真正生效与否以服务端状态为准。
        pending.delete(actionId)
        continue
      }
      entry.attempts += 1
      sendRaw(target, { ...entry.command, actionId: entry.actionId, baseSeq: entry.baseSeq })
    }
    syncPendingCount()
  }

  function clearConnectTimeout(): void {
    if (connectTimeoutTimer !== null) window.clearTimeout(connectTimeoutTimer)
    connectTimeoutTimer = null
  }

  /**
   * 重连统一入口。
   *
   * error、close、心跳超时、页面回前台四条路径都走这里，
   * 否则它们会各起一次重连，留下好几条连接和好几套定时器。
   */
  function scheduleReconnect(): void {
    if (manualClose || !session.value || !roomCode) {
      connectionState.value = 'disconnected'
      return
    }
    if (reconnectTimer !== null) return
    connectionState.value = 'reconnecting'
    reconnectCount.value += 1
    const delay = reconnectDelay(reconnectAttempt)
    reconnectAttempt += 1
    const code = roomCode
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      connectRoom(code, true)
    }, delay)
  }

  /**
   * 发操作之前先确认连接是好的。
   *
   * 原来这里发现 socket 不 OPEN 就只置 `error = '尚未连接到房间'` 然后 return——
   * 玩家看到的就是「按下去什么也没发生」。现在改成：操作先进待确认队列，
   * 立刻启动恢复，连上并同步完再按原 actionId 发出去。
   */
  function ensureHealthyConnection(): void {
    if (connectionHealthy()) return
    if (socket && socket.readyState === WebSocket.OPEN) {
      // socket 表面还开着，但服务端已经很久没说话：这是半死连接，就地换一条
      try { socket.close() } catch { /* 已经断了 */ }
      return
    }
    if (socket && socket.readyState === WebSocket.CONNECTING) return
    scheduleReconnect()
  }

  /**
   * 页面回到前台、网络恢复时立刻验一次连接。
   *
   * 不这么做的话，手机切回来之后要等下一个心跳周期才发现连接已经死了，
   * 那几秒里所有点击都像是失灵。
   */
  function verifyConnectionNow(): void {
    if (manualClose || !roomCode || !session.value) return
    if (!socket) { scheduleReconnect(); return }
    if (socket.readyState === WebSocket.OPEN) {
      if (connectionHealthy()) { probe(); return }
      try { socket.close() } catch { /* 已经断了 */ }
      return
    }
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) scheduleReconnect()
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

  /**
   * 发一条会改变房间状态的指令。
   *
   * 三件事必须一起做，缺一样就会出现用户报的那些症状：
   *
   * 1. **先进待确认队列。** 原来连接不 OPEN 就直接 return，玩家看到的是
   *    「按下去什么都没发生」。现在无论如何都先记下来。
   * 2. **actionId 只生成一次。** 重发沿用同一个，服务端靠它幂等，
   *    「已经执行成功但回执丢了」不会被执行第二遍。
   * 3. **立刻拉起恢复。** 连接不健康就地重连，连上并同步完自动重发。
   */
  function send(command: SgsCommandDraft): void {
    if (!room.value) {
      error.value = '尚未连接到房间'
      return
    }
    if (pending.size >= PENDING_MAX) {
      error.value = '待处理的操作太多，请稍候'
      return
    }
    const entry: PendingAction = {
      actionId: crypto.randomUUID(),
      command,
      baseSeq: room.value.version,
      createdAt: Date.now(),
      attempts: 0,
    }
    pending.set(entry.actionId, entry)
    syncPendingCount()
    if (connectionHealthy() && socket) {
      entry.attempts = 1
      sendRaw(socket, { ...command, actionId: entry.actionId, baseSeq: entry.baseSeq })
      return
    }
    // 连接不健康：不报「尚未连接」了事，而是就地开始恢复，连上后自动重发
    ensureHealthyConnection()
  }

  function respond(response: GameResponse): void {
    send({ type: 'respond', requestId: response.requestId, payload: response.payload })
  }

  function act(legalActionId: string): void { send({ type: 'act', legalActionId }) }

  function leaveRoom(): void {
    if (socket?.readyState === WebSocket.OPEN && room.value) {
      sendRaw(socket, { type: 'leave-room', actionId: crypto.randomUUID(), baseSeq: room.value.version })
    }
    manualClose = true
    reconnectAttempt = 0
    pending.clear()
    syncPendingCount()
    connectionState.value = 'closed'
    room.value = null
    roomCode = ''
    storageSet(ROOM_KEY, '')
    syncRoomUrl('')
    closeCurrentSocket()
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

  /**
   * 关掉当前这条连接和它的定时器。
   *
   * **不动待确认队列**：那些操作可能已经送到服务端了，重连之后要按原 actionId
   * 重发一次，由服务端的幂等决定是执行还是回一个 duplicate。断线就清空
   * 等于把用户已经点下去的操作悄悄丢掉。
   */
  function closeCurrentSocket(): void {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    if (probeTimer !== null) window.clearInterval(probeTimer)
    clearConnectTimeout()
    reconnectTimer = null
    probeTimer = null
    lastServerMessageAt = 0
    // 断线后重新标定：睡眠唤醒、切换网络之后旧的偏移不一定还成立
    clockCalibrated = false
    const previous = socket
    socket = null
    connected.value = false
    connecting.value = false
    try { previous?.close() } catch { /* 已经断了 */ }
  }

  /*
   * 页面回到前台、网络恢复时立刻验一次。
   *
   * 手机把标签页挂到后台时定时器会被冻结，回来那一刻连接很可能已经死了。
   * 不主动验的话，用户在接下来的几秒里点什么都像失灵。
   */
  const onVisible = (): void => { if (document.visibilityState === 'visible') verifyConnectionNow() }
  const onOnline = (): void => verifyConnectionNow()
  const onPageShow = (): void => verifyConnectionNow()
  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('focus', onOnline)
  }

  onBeforeUnmount(() => {
    manualClose = true
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('focus', onOnline)
    }
    closeCurrentSocket()
  })

  return {
    session, lastNickname, room, rooms, connected, connecting, busy, error, chatBubbles, clockOffset,
    connectionState, pendingCount, heartbeatRtt, reconnectCount,
    login, restoreSession, refreshRooms, createRoom, joinRoom, send, respond, act, leaveRoom, logout,
  }
}
