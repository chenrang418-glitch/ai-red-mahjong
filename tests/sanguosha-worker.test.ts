import { readFileSync } from 'node:fs'
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
  const migrations = [
    '0001_online.sql', '0002_room_directory.sql', '0003_room_phase.sql',
    '0004_admin_audit.sql', '0005_remove_player_stats.sql', '0006_sanguosha_room_directory.sql',
  ].map((name) => readFileSync(resolve(root, 'server/migrations', name), 'utf8'))
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

    socket.send(JSON.stringify({ type: 'toggle-ready', actionId: 'stale-action', baseSeq: 1 }))
    const stale = await nextMessage(socket, 'error') as Extract<SgsRoomServerMessage, { type: 'error' }>
    expect(stale.message).toContain('局面已经变化')
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
})
