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
    d1Databases: { DB: 'sanguosha-worker-db' },
  }] }))
  const db = await mf.getD1Database('DB')
  for (const migration of migrations) await db.exec(migration.replace(/\s+/g, ' ').trim())
}, 90_000)

afterAll(async () => { await mf?.dispose() })

describe('三国杀 Worker 与 Durable Object', () => {
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
    message = await nextMessage(socket, 'room-state') as typeof message
    expect(message.room.seats[0].ready).toBe(true)

    send(socket, message.room, { type: 'toggle-ready' }, actionId)
    const duplicate = await nextMessage(socket, 'error') as Extract<SgsRoomServerMessage, { type: 'error' }>
    expect(duplicate.message).toContain('已经处理')
    // 业务拒绝会连发两帧：error 之后还有一份权威状态。不读掉的话，
    // 它会在下一次等待里被当成新消息返回——这个坑让上一版测试读到了旧状态。
    message = await nextMessage(socket, 'room-state') as typeof message

    // 稍旧的 baseSeq 必须仍然被接受：version 在 AI 走子、聊天、断连时都会变，
    // 一律拒绝的话玩家点一下就会被无故驳回。真正的陈旧由引擎按 requestId /
    // legalActionId 挡住，挡得更准。
    socket.send(JSON.stringify({ type: 'toggle-ready', actionId: 'older-base', baseSeq: 1 }))
    const olderBase = await nextMessage(socket) as SgsRoomServerMessage
    expect(olderBase.type, olderBase.type === 'error' ? olderBase.message : '').toBe('room-state')
    expect((olderBase as typeof message).room.seats[0].ready).toBe(false)
    message = olderBase as typeof message

    // 比服务端还新的版本号说明连的不是同一个房间状态，这个要拒绝
    socket.send(JSON.stringify({ type: 'toggle-ready', actionId: 'from-future', baseSeq: 9_999 }))
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

    /*
     * 只让客人托管，房主留着。
     *
     * **两个真人全托管现在会让房间自动解散**（没人在打了就不留房），
     * 所以不能再靠「都托管、等牌局自己跑」来验推进——那正是新规则要拆掉的局面。
     * 解散那条行为由 room-core 的用例覆盖，那里可以直接快进时间。
     */
    guest.send({ type: 'trustee', enabled: true })
    await guest.waitFor((room) => room.seats.find((seat) => seat.isSelf)?.trustee === true)

    // 牌局能不能打完由 room-core 的用例覆盖（那里可以直接快进时间）。
    // 这里要验的是 Worker 这一层：两个真人都在场时，牌局确实在自己往前走，
    // 而且谁都没看到过别人的手牌。
    //
    // 时限跟着 AI 节奏走：主动出牌放慢之后，推进三个回合需要的真实时间跟着涨。
    // **这里放宽的是等待时间，不是断言**——真卡住仍然会失败。
    const advanced = await host.waitFor((room) => (room.playerView?.turnNumber ?? 0) >= 3, 150_000)
    expect(host.room().seats.find((seat) => seat.isSelf)?.trustee, '房主没托管，房间不该被解散').toBe(false)
    expect(advanced.phase).toBe('playing')
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
