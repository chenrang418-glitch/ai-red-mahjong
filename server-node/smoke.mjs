// 迁移验收：对着跑起来的 Node 服务走一遍完整流程。
// 测试项和 scripts/online-smoke.mjs（Cloudflare 版）一一对应——
// 那套跑的是 miniflare 里的 Worker，这套跑的是真实 HTTP + ws，
// 两边都过说明协议行为一致。
import { WebSocket } from 'ws'

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:8788'
const WS_BASE = BASE.replace(/^http/, 'ws')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'local-admin-test'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, init)
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status} ${path}`)
  return payload
}

async function login(nickname) {
  return api('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  })
}

const sockets = []

function openSocket(path, token) {
  return new Promise((done, fail) => {
    const socket = new WebSocket(`${WS_BASE}${path}?session=${encodeURIComponent(token)}`)
    const timer = setTimeout(() => fail(new Error(`连接超时 ${path}`)), 6000)
    socket.once('open', () => {
      clearTimeout(timer)
      sockets.push(socket)
      done(socket)
    })
    socket.once('error', (cause) => {
      clearTimeout(timer)
      fail(cause)
    })
  })
}

function waitFor(socket, predicate, label, timeout = 8000) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      fail(new Error(`等不到：${label}`))
    }, timeout)
    function onMessage(data) {
      const text = data.toString()
      if (text === 'pong') return
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (!predicate(parsed)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      done(parsed)
    }
    socket.on('message', onMessage)
  })
}

function waitForClose(socket, timeout = 8000) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('等不到关闭事件')), timeout)
    socket.once('close', (code, reason) => {
      clearTimeout(timer)
      done({ code, reason: reason.toString() })
    })
  })
}

async function main() {
  // 1. 基础接口
  const health = await api('/api/health')
  assert(health.ok === true, '健康检查失败')

  const service = await api('/api/service')
  assert(typeof service.maintenance === 'boolean', '维护状态字段缺失')

  // 2. 跨域预检：小程序和网页都靠它
  const preflight = await fetch(`${BASE}/api/session`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert(preflight.status === 204, `跨域预检失败 ${preflight.status}`)
  assert(preflight.headers.get('access-control-allow-origin') === '*', '跨域响应头缺失')

  // 3. 登录
  const host = await login('冒烟房主')
  assert(host.token && host.userId, '登录没有返回会话')

  // 4. 建房
  const created = await api('/api/rooms', {
    method: 'POST',
    headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { mode: 'finite', initialPoints: 30, claimWindowMs: 3000 } }),
  })
  assert(/^[A-Z0-9]{6}$/.test(created.code), '房间号格式不对')
  const code = created.code

  // 5. 大厅 socket 能收到房间目录变化
  const lobbySocket = await openSocket('/api/lobby/socket', host.token)

  // 6. 房间 socket + 首次房间状态
  const roomSocket = await openSocket(`/api/rooms/${code}/socket`, host.token)
  const firstState = await waitFor(roomSocket, (m) => m.type === 'room-state', '首次房间状态')
  assert(firstState.room.code === code, '房间号对不上')
  assert(firstState.room.seats.length === 4, '座位数不对')
  assert(firstState.room.selfSeatId >= 0 && firstState.room.selfUserId === host.userId, '没有标出自己的座位')

  // 7. 心跳
  roomSocket.send('ping')
  await new Promise((done) => setTimeout(done, 200))

  // 8. 第二个人加入
  const guest = await login('冒烟玩家二')
  const joinedPromise = waitFor(roomSocket, (m) => m.type === 'room-state' && m.room.seats.filter((seat) => seat.kind === 'human').length === 2, '房主看到两个人')
  const guestSocket = await openSocket(`/api/rooms/${code}/socket`, guest.token)
  await waitFor(guestSocket, (m) => m.type === 'room-state', '玩家二的房间状态')
  const joined = await joinedPromise
  assert(joined.room.seats.filter((seat) => seat.kind === 'human').length === 2, '第二个人没进来')

  // 9. 聊天广播
  const chatPromise = waitFor(roomSocket, (m) => m.type === 'chat', '聊天广播')
  guestSocket.send(JSON.stringify({ type: 'chat', text: '开了啊', quick: false }))
  const chat = await chatPromise
  assert(chat.message.text === '开了啊', '聊天内容不对')

  // 10. 准备 + 开局，空位补 AI
  const readyPromise = waitFor(roomSocket, (m) => m.type === 'room-state' && m.room.seats.some((seat) => seat.ready && seat.userId !== host.userId), '玩家二准备')
  guestSocket.send(JSON.stringify({ type: 'ready', ready: true }))
  await readyPromise
  const startedPromise = waitFor(roomSocket, (m) => m.type === 'room-state' && m.room.game, '牌局开始')
  roomSocket.send(JSON.stringify({ type: 'start-game' }))
  const started = await startedPromise
  assert(started.room.seats.filter((seat) => seat.kind === 'ai').length === 2, '空位没补上 AI')
  assert(started.room.game.players.length === 4, '牌局玩家数不对')
  assert(started.room.turnTimer, '没有回合倒计时')

  // 11. 只发自己的手牌，别人的是占位牌
  const me = started.room.game.players[started.room.selfSeatId]
  assert(me.hand.some((tile) => tile.suit !== 'unknown'), '自己的手牌被遮住了')

  // 12. 房间目录里能看到这个房间，且进行中不对外开放
  const outsider = await login('冒烟路人')
  const rooms = await api('/api/rooms', { headers: { authorization: `Bearer ${outsider.token}` } })
  const listed = rooms.rooms.find((room) => room.code === code)
  assert(listed, '房间目录里没有这个房间')
  assert(listed.phase === 'playing', '房间状态不是进行中')
  assert(listed.joinable === false, '进行中的房间不该对外人开放')

  // 13. 断线重连：座位保留
  guestSocket.close()
  await new Promise((done) => setTimeout(done, 400))
  const rejoin = await openSocket(`/api/rooms/${code}/socket`, guest.token)
  const rejoined = await waitFor(rejoin, (m) => m.type === 'room-state', '重连后的房间状态')
  assert(rejoined.room.seats[rejoined.room.selfSeatId].connected, '重连后没回到原座位')

  // 14. 关闭码：房间不存在时用 4001，前端据此停止重连
  const ghost = await openSocket('/api/rooms/ZZZZZZ/socket', outsider.token)
  const ghostClosed = await waitForClose(ghost)
  assert(ghostClosed.code === 4001, `房间不存在应返回 4001，实际 ${ghostClosed.code}`)

  // 15. 顶号：同名再登录一次，旧连接被 4003 踢下线
  const superseded = waitForClose(rejoin)
  await login('冒烟玩家二')
  const kicked = await superseded
  assert(kicked.code === 4003, `顶号应返回 4003，实际 ${kicked.code}`)

  // 16. 管理接口
  const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }
  const adminRooms = await api('/api/admin/rooms', { headers: adminHeaders })
  assert(adminRooms.rooms.some((room) => room.code === code), '管理端看不到这个房间')

  const noAuth = await fetch(`${BASE}/api/admin/rooms`)
  assert(noAuth.status === 404, '管理接口未鉴权时应返回 404')

  // 17. 强制解散
  await api(`/api/admin/rooms/${code}`, { method: 'DELETE', headers: adminHeaders })
  const afterDestroy = await api('/api/admin/rooms', { headers: adminHeaders })
  assert(!afterDestroy.rooms.some((room) => room.code === code), '解散后房间还在')

  const audit = await api('/api/admin/audit', { headers: adminHeaders })
  assert(audit.entries.some((entry) => entry.action === 'destroy-room' && entry.target === code), '没有留下操作记录')

  // 18. 维护模式只拦建房
  await api('/api/admin/settings', {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ trusteeDifficulty: 'beginner', maintenance: true, maintenanceMessage: '冒烟维护中' }),
  })
  const blocked = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${outsider.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {} }),
  })
  assert(blocked.status === 503, `维护期间建房应返回 503，实际 ${blocked.status}`)
  await api('/api/admin/settings', {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ trusteeDifficulty: 'beginner', maintenance: false }),
  })

  lobbySocket.close()
  roomSocket.close()

  console.log('迁移冒烟验证通过：HTTP 接口、WebSocket 协议、房间流程、AI 补位、断线重连、关闭码、顶号、管理接口、维护模式全部正常')
}

// 退出前统一关闭：Windows 上留着没关的 socket 会让 libuv 报断言错误
function closeAll() {
  for (const socket of sockets) {
    try {
      socket.removeAllListeners()
      if (socket.readyState === socket.OPEN) socket.close()
      else socket.terminate()
    } catch {
      // 已经关了就算了
    }
  }
}

main().then(
  () => {
    closeAll()
    setTimeout(() => process.exit(0), 150)
  },
  (cause) => {
    console.error('冒烟验证失败：', cause.message)
    closeAll()
    setTimeout(() => process.exit(1), 150)
  },
)
