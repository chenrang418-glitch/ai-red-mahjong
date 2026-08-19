// WebSocket 接入。这是整个迁移里唯一没法靠适配层糊过去的部分：
// Cloudflare 用 WebSocketPair + 在 fetch 里返回 101，Node 走 http 的 upgrade 事件。
//
// 但对前端而言协议完全一致——路径、消息体、关闭码都没变。
// 尤其是 4001/4002/4003 这三个自定义关闭码，ws 库支持 1000 和 3000-4999，
// 前端那套「按关闭码决定要不要重连」的逻辑不用改。
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { ROOM_REJECT_CLOSE_CODE, SESSION_SUPERSEDED_CODE } from '../../src/online/types'
import { readSessionToken, sessionIsCurrent, SUPERSEDED_MESSAGE } from './routes'
import type { Env, SessionPayload } from './routes'

const ROOM_PATH = /^\/api\/rooms\/([A-Z0-9]{6})\/socket$/

// 前端把 token 放在查询串里（WebSocket 没法自定义请求头），
// 这里拼一个假的 Request 交给原来的解析函数，免得再写一遍。
function sessionFrom(request: IncomingMessage): SessionPayload {
  const url = new URL(request.url ?? '/', 'http://internal')
  const token = url.searchParams.get('session') ?? ''
  return readSessionToken(new Request('http://internal/', {
    headers: { authorization: `Bearer ${token}` },
  }))
}

// 拒绝的连接也要先握手成功再关，否则前端只看到「连接失败」，
// 分不清是房间满了还是网断了。Cloudflare 那边也是这么做的。
function rejectAfterAccept(socket: WebSocket, reason: string, code = ROOM_REJECT_CLOSE_CODE): void {
  socket.send(JSON.stringify({ type: 'error', message: reason }))
  // 关闭原因上限 123 字节，中文按 3 字节算最多 40 字
  socket.close(code, reason.slice(0, 40))
}

export function attachWebSockets(server: Server, env: Env): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://internal')
    const isLobby = url.pathname === '/api/lobby/socket'
    const roomMatch = url.pathname.match(ROOM_PATH)
    if (!isLobby && !roomMatch) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void handleConnection(ws, request, env, isLobby, roomMatch ? roomMatch[1] : '')
    })
  })
}

async function handleConnection(
  ws: WebSocket,
  request: IncomingMessage,
  env: Env,
  isLobby: boolean,
  code: string,
): Promise<void> {
  let session: SessionPayload
  try {
    session = sessionFrom(request)
  } catch {
    rejectAfterAccept(ws, '登录状态已失效，请重新进入')
    return
  }

  // 被顶下线的旧连接会一直重连，这里必须挡住，否则它一进来又把座位抢回去
  if (!await sessionIsCurrent(env, session)) {
    rejectAfterAccept(ws, SUPERSEDED_MESSAGE, SESSION_SUPERSEDED_CODE)
    return
  }

  if (isLobby) {
    env.LOBBY.attach(ws, session.userId)
    ws.on('message', (data) => env.LOBBY.handleMessage(ws, data.toString()))
    ws.on('close', () => env.LOBBY.detach(ws))
    ws.on('error', () => env.LOBBY.detach(ws))
    return
  }

  const room = env.ROOMS.get(code)
  // 房间不存在、满员、牌局已开始这些情况，握手前失败客户端只会看到「连接中断」
  // 并无限重连，所以先接受连接，再用专用关闭码把真实原因送到前端
  const rejection = room.tryConnect({ userId: session.userId, nickname: session.nickname })
  if (rejection) {
    rejectAfterAccept(ws, rejection)
    return
  }

  room.attach(ws, { userId: session.userId, nickname: session.nickname })
  ws.on('message', (data) => {
    void room.handleMessage(ws, data.toString()).catch((cause: unknown) => {
      console.error('房间消息处理失败', code, cause)
    })
  })
  ws.on('close', () => room.handleClose(ws))
  ws.on('error', () => room.handleClose(ws))
}
