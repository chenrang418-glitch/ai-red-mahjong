import { readFile } from 'node:fs/promises'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const script = await readFile(new URL('../server/dist/worker.js', import.meta.url), 'utf8')
const migrations = await Promise.all([
  readFile(new URL('../server/migrations/0001_online.sql', import.meta.url), 'utf8'),
  readFile(new URL('../server/migrations/0002_room_directory.sql', import.meta.url), 'utf8'),
  readFile(new URL('../server/migrations/0003_room_phase.sql', import.meta.url), 'utf8'),
])

const miniflare = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: 'online-smoke',
    compatibilityDate: '2026-08-15',
    modules: true,
    script,
    durableObjects: {
      ROOMS: { className: 'MahjongRoom', useSQLite: true },
      LOBBY: { className: 'MahjongLobby', useSQLite: true },
    },
    d1Databases: {
      DB: 'online-smoke-db',
    },
  }],
}))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`)
  return payload
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket连接超时')), 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket连接失败')) }, { once: true })
  })
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待服务器消息超时')), 5000)
    const listener = (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (!predicate(message)) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      resolve(message)
    }
    socket.addEventListener('message', listener)
  })
}

function waitForRawMessage(socket, expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待心跳应答超时')), 5000)
    const listener = (event) => {
      if (String(event.data) !== expected) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      resolve(event.data)
    }
    socket.addEventListener('message', listener)
  })
}

function waitForClose(socket) {
  return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
}

try {
  const database = await miniflare.getD1Database('DB')
  for (const migration of migrations) await database.exec(migration.replace(/\s+/g, ' ').trim())
  const baseUrl = (await miniflare.ready).origin

  const health = await jsonRequest(`${baseUrl}/api/health`)
  assert(health.ok === true, '健康检查失败')

  const preflight = await fetch(`${baseUrl}/api/session`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert(preflight.status === 204, '跨域预检失败')
  assert(preflight.headers.get('access-control-allow-origin') === '*', '跨域响应头缺失')

  const session = await jsonRequest(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: '联调玩家' }),
  })
  assert(session.token && session.userId, '昵称登录没有返回会话')

  const directorySocketUrl = new URL(`${baseUrl}/api/lobby/socket`)
  directorySocketUrl.protocol = directorySocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  directorySocketUrl.searchParams.set('session', session.token)
  const directorySocket = new WebSocket(directorySocketUrl)
  await waitForOpen(directorySocket)

  const createdNotification = waitForMessage(directorySocket, (message) => message.type === 'rooms-updated')
  const created = await jsonRequest(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ settings: { mode: 'finite', initialPoints: 30, claimWindowMs: 4000 } }),
  })
  await createdNotification
  assert(/^[A-Z0-9]{6}$/.test(created.code), '房间号格式不正确')

  const listed = await jsonRequest(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const listedRoom = listed.rooms.find((room) => room.code === created.code)
  assert(listedRoom?.occupiedSeats === 1 && listedRoom?.availableSeats === 3, '房间列表人数不正确')
  assert(listedRoom?.players[0]?.nickname === '联调玩家', '房间列表玩家信息不正确')

  const socketUrl = new URL(`${baseUrl}/api/rooms/${created.code}/socket`)
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  socketUrl.searchParams.set('session', session.token)
  const socket = new WebSocket(socketUrl)
  const initialStatePromise = waitForMessage(socket, (message) => message.type === 'room-state')
  await waitForOpen(socket)
  const initialState = await initialStatePromise
  assert(initialState.room.phase === 'lobby', '连接后没有进入房间等待页')
  const pongPromise = waitForRawMessage(socket, 'pong')
  socket.send('ping')
  await pongPromise

  const startedPromise = waitForMessage(socket, (message) => message.type === 'room-state' && message.room.game)
  const startedNotification = waitForMessage(directorySocket, (message) => message.type === 'rooms-updated')
  socket.send(JSON.stringify({ type: 'start-game' }))
  const started = await startedPromise
  await startedNotification
  assert(started.room.seats.filter((seat) => seat.kind === 'ai').length === 3, '空位没有自动补充AI')
  assert(started.room.turnTimer?.seatId === started.room.game.currentPlayer, '当前行动座位没有倒计时')

  const roomsAfterStart = await jsonRequest(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const activeRoom = roomsAfterStart.rooms.find((room) => room.code === created.code)
  assert(activeRoom?.phase === 'playing' && activeRoom?.joinable === false, '进行中房间没有按不可加入状态显示')

  const chatPromise = waitForMessage(socket, (message) => message.type === 'chat' && message.message.text === '乐乐')
  socket.send(JSON.stringify({ type: 'chat', text: '乐乐', quick: true }))
  await chatPromise

  const activeRoomDeleted = waitForMessage(directorySocket, (message) => message.type === 'rooms-updated')
  const activeSocketClosed = waitForClose(socket)
  socket.send(JSON.stringify({ type: 'leave-room' }))
  await activeSocketClosed
  await activeRoomDeleted
  const roomsAfterActiveLeave = await jsonRequest(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  assert(!roomsAfterActiveLeave.rooms.some((room) => room.code === created.code), '最后一名真人明确退出后没有删除牌局')

  const lobbyRoom = await jsonRequest(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ settings: { mode: 'finite', initialPoints: 30, claimWindowMs: 4000 } }),
  })
  const lobbyHostSocketUrl = new URL(`${baseUrl}/api/rooms/${lobbyRoom.code}/socket`)
  lobbyHostSocketUrl.protocol = lobbyHostSocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  lobbyHostSocketUrl.searchParams.set('session', session.token)
  const lobbyHostSocket = new WebSocket(lobbyHostSocketUrl)
  const lobbyHostState = waitForMessage(lobbyHostSocket, (message) => message.type === 'room-state')
  await waitForOpen(lobbyHostSocket)
  await lobbyHostState

  const guestSession = await jsonRequest(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: '联调访客' }),
  })
  const guestSocketUrl = new URL(`${baseUrl}/api/rooms/${lobbyRoom.code}/socket`)
  guestSocketUrl.protocol = guestSocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  guestSocketUrl.searchParams.set('session', guestSession.token)
  const guestSocket = new WebSocket(guestSocketUrl)
  const guestJoined = waitForMessage(guestSocket, (message) => message.type === 'room-state' && message.room.seats.filter((seat) => seat.kind === 'human').length === 2)
  await waitForOpen(guestSocket)
  await guestJoined

  const guestClosed = waitForClose(guestSocket)
  guestSocket.close()
  await guestClosed
  await new Promise((resolve) => setTimeout(resolve, 30))
  const roomsAfterGuestDropped = await jsonRequest(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const lobbyAfterGuestDropped = roomsAfterGuestDropped.rooms.find((room) => room.code === lobbyRoom.code)
  assert(lobbyAfterGuestDropped?.occupiedSeats === 2 && lobbyAfterGuestDropped?.players.some((player) => player.nickname === '联调访客' && !player.connected), '等待页意外断线后没有保留座位')

  const guestReconnectSocket = new WebSocket(guestSocketUrl)
  const guestReconnected = waitForMessage(guestReconnectSocket, (message) => message.type === 'room-state' && message.room.seats[1]?.connected)
  await waitForOpen(guestReconnectSocket)
  await guestReconnected
  const guestLeft = waitForClose(guestReconnectSocket)
  guestReconnectSocket.send(JSON.stringify({ type: 'leave-room' }))
  await guestLeft
  await new Promise((resolve) => setTimeout(resolve, 30))
  const roomsAfterGuestLeft = await jsonRequest(`${baseUrl}/api/rooms`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const lobbyAfterGuestLeft = roomsAfterGuestLeft.rooms.find((room) => room.code === lobbyRoom.code)
  assert(lobbyAfterGuestLeft?.occupiedSeats === 1 && lobbyAfterGuestLeft?.availableSeats === 3, '明确离开等待页后没有释放座位')
  const lobbyHostLeft = waitForClose(lobbyHostSocket)
  lobbyHostSocket.send(JSON.stringify({ type: 'leave-room' }))
  await lobbyHostLeft
  directorySocket.close()

  console.log(`联机冒烟验证通过：房间 ${created.code}，实时目录、进行中状态、座位倒计时、明确退出删除、断线重连、AI补位和快捷聊天正常。`)
} finally {
  await miniflare.dispose()
}
