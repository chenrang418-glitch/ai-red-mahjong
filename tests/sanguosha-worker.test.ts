import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import type { SgsRoomServerMessage, SgsRoomView } from '@/sanguosha/online/protocol'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let mf: Miniflare

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return mf.dispatchFetch(`https://example.com${path}`, init as never) as unknown as Promise<Response>
}

async function login(nickname: string): Promise<string> {
  const response = await api('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }),
  })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

async function openSocket(code: string, cookie: string): Promise<WebSocket> {
  const response = await mf.dispatchFetch(`https://example.com/api/sanguosha/rooms/${code}/socket`, {
    headers: { Upgrade: 'websocket', Cookie: cookie },
  } as never) as unknown as Response & { webSocket: WebSocket | null }
  if (!response.webSocket) throw new Error('服务器没有升级成 WebSocket')
  response.webSocket.accept()
  return response.webSocket
}

function nextMessage(socket: WebSocket, type?: SgsRoomServerMessage['type']): Promise<SgsRoomServerMessage> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type ?? '消息'} 超时`)), 5_000)
    const listener = (event: MessageEvent) => {
      if (event.data === 'pong') return
      const parsed = JSON.parse(String(event.data)) as SgsRoomServerMessage
      if (type && parsed.type !== type) return
      clearTimeout(timer)
      socket.removeEventListener('message', listener)
      resolveMessage(parsed)
    }
    socket.addEventListener('message', listener)
  })
}

function send(socket: WebSocket, room: SgsRoomView, command: Record<string, unknown>, actionId = crypto.randomUUID()): void {
  socket.send(JSON.stringify({ ...command, actionId, baseSeq: room.version }))
}

beforeAll(async () => {
  const script = readFileSync(resolve(root, 'server/dist/worker.js'), 'utf8')
  // 迁移列表从目录读，不写死：写死的话新增迁移会被静默漏掉，测试通过也说明不了什么
  const migrations = readdirSync(resolve(root, 'server/migrations'))
    .filter((name) => name.endsWith('.sql')).sort()
    .map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'sanguosha-worker-test', compatibilityDate: '2026-08-15', modules: true, script,
    durableObjects: {
      ROOMS: { className: 'MahjongRoom', useSQLite: true },
      LOBBY: { className: 'MahjongLobby', useSQLite: true },
      SGS_ROOMS: { className: 'SanguoshaRoom', useSQLite: true },
    },
    bindings: { SGS_AI_PACING: 'instant' },
    d1Databases: { DB: 'sanguosha-worker-db' },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => { await mf?.dispose() })

describe('纸上三国 Worker 与 Durable Object', () => {
  it('创建、列出、进房并拒绝重复和陈旧动作', async () => {
    const cookie = await login('三国房主')
    const created = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { playerCount: 5, difficulty: 'normal', turnSeconds: 30 } }),
    })
    expect(created.status).toBe(201)
    const { code } = await created.json() as { code: string }

    const listed = await (await api('/api/sanguosha/rooms', { headers: { cookie } })).json() as { rooms: Array<{ code: string; rejoinable: boolean }> }
    expect(listed.rooms.find((entry) => entry.code === code)).toMatchObject({ rejoinable: true })

    const socket = await openSocket(code, cookie)
    let message = await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>
    expect(message.room.seats[0]).toMatchObject({ isSelf: true, ready: false })

    const actionId = 'ready-exactly-once'
    send(socket, message.room, { type: 'toggle-ready' }, actionId)
    const firstAck = await nextMessage(socket, 'action-ack') as Extract<SgsRoomServerMessage, { type: 'action-ack' }>
    expect(firstAck, '每条指令都要有明确回执').toMatchObject({ actionId, accepted: true })
    expect(firstAck.duplicate ?? false).toBe(false)
    message = await nextMessage(socket, 'room-state') as typeof message
    expect(message.room.seats[0].ready).toBe(true)

    /*
     * 同一个 actionId 再来一次。
     *
     * 这**不是**错误，而是「服务端已经执行成功、回执在网络里丢了、
     * 客户端原样重发」的正常路径。所以要回一个「接受，但这次没有再执行一遍」，
     * 而不是报错——报错会让玩家看到一个莫名其妙的失败提示，
     * 客户端也分不清「真的被拒了」和「其实早就成功了」。
     */
    send(socket, message.room, { type: 'toggle-ready' }, actionId)
    const duplicate = await nextMessage(socket, 'action-ack') as Extract<SgsRoomServerMessage, { type: 'action-ack' }>
    expect(duplicate).toMatchObject({ actionId, accepted: true, duplicate: true })
    // 回执之后还有一份权威状态。不读掉的话，它会在下一次等待里被当成新消息返回。
    message = await nextMessage(socket, 'room-state') as typeof message
    expect(message.room.seats[0].ready, '重发绝不能把准备状态又切回去').toBe(true)

    // 稍旧的 baseSeq 必须仍然被接受：version 在 AI 走子、聊天、断连时都会变，
    // 一律拒绝的话玩家点一下就会被无故驳回。真正的陈旧由引擎按 requestId /
    // legalActionId 挡住，挡得更准。
    socket.send(JSON.stringify({ type: 'toggle-ready', actionId: 'older-base', baseSeq: 1 }))
    const olderAck = await nextMessage(socket, 'action-ack') as Extract<SgsRoomServerMessage, { type: 'action-ack' }>
    expect(olderAck, '稍旧的 baseSeq 要被接受').toMatchObject({ actionId: 'older-base', accepted: true })
    const olderBase = await nextMessage(socket, 'room-state') as typeof message
    expect(olderBase.room.seats[0].ready).toBe(false)
    message = olderBase

    // 比服务端还新的版本号说明连的不是同一个房间状态，这个要拒绝
    socket.send(JSON.stringify({ type: 'toggle-ready', actionId: 'from-future', baseSeq: 9_999 }))
    const rejected = await nextMessage(socket, 'action-ack') as Extract<SgsRoomServerMessage, { type: 'action-ack' }>
    expect(rejected, '真正的拒绝要说明白').toMatchObject({ actionId: 'from-future', accepted: false })
    expect(rejected.reason).toContain('不一致')
    const impossible = await nextMessage(socket, 'error') as Extract<SgsRoomServerMessage, { type: 'error' }>
    expect(impossible.message).toContain('不一致')
    await nextMessage(socket, 'room-state')
    socket.close()
  })

  it('牌局开始后断开再连仍恢复同一个私有视图', async () => {
    const cookie = await login('重连房主')
    const created = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ settings: { playerCount: 5 } }),
    })
    const { code } = await created.json() as { code: string }
    let socket = await openSocket(code, cookie)
    let state = (await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>).room

    for (const command of [{ type: 'toggle-ready' }, { type: 'add-ai' }, { type: 'add-ai' }, { type: 'add-ai' }, { type: 'add-ai' }, { type: 'start-game' }]) {
      send(socket, state, command)
      state = (await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>).room
    }
    expect(state.playerView?.status).toBe('choosing-general')
    const requestId = state.playerView?.pendingRequest?.id
    const viewerId = state.playerView?.viewerId

    socket.close()
    socket = await openSocket(code, cookie)
    const restored = (await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>).room
    expect(restored.playerView?.viewerId).toBe(viewerId)
    expect(restored.playerView?.pendingRequest?.id).toBe(requestId)
    socket.close()
  })

  it('两个真人同房：各自只看到自己的手牌，都能操作，托管后能打完', async () => {
    // 联机之前只验过「1 真人 + 4 AI」。两个真人同时在场是另一条路径：
    // 每个连接要拿到各自的 PlayerView，双方的指令都要被接受。
    //
    // 房间状态是广播的，所以不能按「发一条等一条」的顺序读——
    // 别人的操作也会推消息过来。这里改成持续跟踪最新状态 + 条件等待。
    const hostCookie = await login('双人房主')
    const guestCookie = await login('双人客人')
    const created = await api('/api/sanguosha/rooms', {
      method: 'POST',
      headers: { cookie: hostCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { playerCount: 5, turnSeconds: 10 } }),
    })
    const { code } = await created.json() as { code: string }

    const host = await track(await openSocket(code, hostCookie))
    const guest = await track(await openSocket(code, guestCookie))

    await guest.waitFor((room) => room.seats.filter((seat) => seat.kind === 'human').length === 2)

    // 客人也能发指令，不只是房主
    guest.send({ type: 'toggle-ready' })
    await guest.waitFor((room) => room.seats.find((seat) => seat.isSelf)?.ready === true)

    // 服务端会拒绝陈旧的 baseSeq，所以房主要先等自己也收到客人准备的广播
    await host.waitFor((room) => room.seats.filter((seat) => seat.ready).length === 1)
    host.send({ type: 'toggle-ready' })
    await host.waitFor((room) => room.seats.find((seat) => seat.isSelf)?.ready === true)
    expect(host.lastError, '房主的指令不该被拒绝').toBe('')
    for (let index = 0; index < 3; index += 1) {
      host.send({ type: 'add-ai' })
      await host.waitFor((room) => room.seats.filter((seat) => seat.kind === 'ai').length === index + 1)
    }
    host.send({ type: 'start-game' })
    await host.waitFor((room) => room.playerView?.status === 'choosing-general')
    await guest.waitFor((room) => room.playerView?.status === 'choosing-general')

    // 两个人拿到的是**不同的**视图
    expect(guest.room().playerView?.viewerId).not.toBe(host.room().playerView?.viewerId)

    // 各自选将
    for (const side of [host, guest]) {
      const request = side.room().playerView?.pendingRequest
      if (request?.kind !== 'choose-general') continue
      side.send({ type: 'respond', requestId: request.id, payload: { characterId: request.candidates[0] } })
    }

    await host.waitFor((room) => room.playerView?.status === 'playing')
    await guest.waitFor((room) => room.playerView?.status === 'playing')

    // 选将本身就是双方各自提交的一次真人 Request；随后开启托管来验证 Worker
    // 的 AI 自动推进。测试环境显式注入 0ms pacing，不改变生产默认节奏。
    guest.send({ type: 'trustee', enabled: true })
    await guest.waitFor((room) => room.seats.find((seat) => seat.isSelf)?.trustee === true)
    await host.waitFor((room) => room.seats.some((seat) => seat.trustee))
    host.send({ type: 'trustee', enabled: true })
    await host.waitFor((room) => room.seats.find((seat) => seat.isSelf)?.trustee === true)

    const finished = await host.waitFor((room) => room.phase === 'finished', 25_000)
    expect(finished.playerView?.status).toBe('game-over')
    expect(guest.room().playerView?.turnNumber).toBeGreaterThanOrEqual(1)
    expect(host.leaked, '别人的手牌一次都不该出现').toBe(0)
    expect(guest.leaked, '别人的手牌一次都不该出现').toBe(0)
    expect(host.lastError).toBe('')
    expect(guest.lastError).toBe('')

    host.close()
    guest.close()
  }, 200_000)
})

/** 持续跟踪一个连接的最新房间状态，顺带盯着有没有泄露别人的手牌。 */
async function track(socket: WebSocket) {
  let latest: SgsRoomView | null = null
  let leaked = 0
  let lastError = ''
  const waiters: Array<(room: SgsRoomView) => void> = []

  socket.addEventListener('message', (event) => {
    if (event.data === 'pong') return
    const parsed = JSON.parse(String(event.data)) as SgsRoomServerMessage
    // 被拒绝的指令必须看得见，否则只会表现成一次莫名其妙的等待超时
    if (parsed.type === 'error') { lastError = parsed.message; return }
    if (parsed.type !== 'room-state') return
    latest = parsed.room
    const view = parsed.room.playerView
    if (view) {
      for (const player of view.players) {
        if (player.id !== view.viewerId && player.hand !== null) leaked += 1
      }
    }
    for (const notify of waiters.splice(0)) notify(parsed.room)
  })

  const handle = {
    room: () => {
      if (!latest) throw new Error('还没收到任何房间状态')
      return latest
    },
    get leaked() { return leaked },
    get lastError() { return lastError },
    send(command: Record<string, unknown>) {
      socket.send(JSON.stringify({ ...command, actionId: crypto.randomUUID(), baseSeq: handle.room().version }))
    },
    waitFor(predicate: (room: SgsRoomView) => boolean, timeoutMs = 10_000): Promise<SgsRoomView> {
      if (latest && predicate(latest)) return Promise.resolve(latest)
      return new Promise((resolveRoom, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待房间状态超时（最后一次：${JSON.stringify({
          phase: latest?.phase,
          seats: latest?.seats.map((seat) => `${seat.kind}${seat.ready ? '/ready' : ''}${seat.trustee ? '/trustee' : ''}`),
          status: latest?.playerView?.status,
          request: latest?.playerView?.pendingRequest?.kind,
        })}）`)), timeoutMs)
        const check = (room: SgsRoomView) => {
          if (!predicate(room)) { waiters.push(check); return }
          clearTimeout(timer)
          resolveRoom(room)
        }
        waiters.push(check)
      })
    },
    close: () => socket.close(),
  }

  await handle.waitFor(() => true)
  return handle
}

describe('纸上三国联机连接层', () => {
  it('服务端主动发心跳，并按客户端报上来的版本补发丢失的帧', async () => {
    const cookie = await login('心跳房主')
    const created = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { playerCount: 5, difficulty: 'normal', turnSeconds: 30 } }),
    })
    const { code } = await created.json() as { code: string }
    const socket = await openSocket(code, cookie)
    await nextMessage(socket, 'room-state')

    /*
     * 心跳必须由**服务端**主动发。
     *
     * 只靠客户端 setInterval 的话，手机把页面切到后台之后定时器会被节流甚至冻结，
     * 「socket 还是 OPEN、数据其实不通」这种半死连接就永远发现不了——
     * 用户的体感正是「按键失灵，只能大退」。
     */
    const heartbeat = await nextMessage(socket, 'server-heartbeat') as Extract<SgsRoomServerMessage, { type: 'server-heartbeat' }>
    expect(heartbeat.heartbeatId).toBeGreaterThan(0)
    expect(heartbeat.serverNow).toBeGreaterThan(0)
    expect(typeof heartbeat.roomVersion).toBe('number')

    /*
     * 版本漂移自愈：客户端报一个明显落后的版本，服务端应当立刻补一份完整快照，
     * 而不是等玩家下一次操作才暴露出状态分叉。
     */
    socket.send(JSON.stringify({ type: 'client-heartbeat-ack', heartbeatId: heartbeat.heartbeatId, lastKnownVersion: -1 }))
    const resynced = await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>
    expect(resynced.room.code).toBe(code)
    socket.close()
  }, 30_000)

  it('request-sync 立刻拿到一份权威快照', async () => {
    const cookie = await login('补包房主')
    const created = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { playerCount: 5, difficulty: 'normal', turnSeconds: 30 } }),
    })
    const { code } = await created.json() as { code: string }
    const socket = await openSocket(code, cookie)
    await nextMessage(socket, 'room-state')

    socket.send(JSON.stringify({ type: 'request-sync', lastKnownVersion: 0 }))
    const snapshot = await nextMessage(socket, 'room-state') as Extract<SgsRoomServerMessage, { type: 'room-state' }>
    expect(snapshot.room.code).toBe(code)
    // 连接层消息不该占用 actionId 额度，也就不该产生回执
    socket.close()
  }, 30_000)

  it('同一个 createRequestId 重试只建出一个房间', async () => {
    const cookie = await login('重试房主')
    const body = JSON.stringify({
      settings: { playerCount: 5, difficulty: 'normal', turnSeconds: 30 },
      createRequestId: 'create-once-please',
    })
    const first = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body,
    })
    const second = await api('/api/sanguosha/rooms', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body,
    })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    /*
     * 建房是 POST，天生不幂等：用户因为慢而多点一次、或者前端自己重试，
     * 就会凭空多出一个房间——房主只进其中一个，另一个成了永远没人的僵尸房。
     */
    expect((await second.json() as { code: string }).code)
      .toBe((await first.json() as { code: string }).code)
  }, 30_000)
})
