// 入口：把 Node 的 http 请求桥接到原来那套基于 Request/Response 的路由上。
// Node 18 起全局就有 Request/Response，所以从 Worker 搬过来的路由代码不用改写。
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { dataRoot, migrationsPaths, openDatabase, runMigrations } from './db'
import { Lobby } from './lobby'
import { RoomRegistry } from './rooms'
import { errorResponse, route } from './routes'
import type { Env } from './routes'
import { attachWebSockets } from './ws'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const DB_FILE = process.env.DB_FILE ?? resolve(dataRoot(), 'mahjong.db')

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => done(Buffer.concat(chunks)))
    request.on('error', fail)
  })
}

function toRequest(incoming: IncomingMessage, body: Buffer): Request {
  // 反代后拿到的 host 是 Nginx 转过来的，只用来拼 URL，不参与鉴权
  const host = incoming.headers.host ?? 'localhost'
  const url = new URL(incoming.url ?? '/', `http://${host}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  const method = incoming.method ?? 'GET'
  return new Request(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  outgoing.writeHead(response.status, headers)
  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    outgoing.end(buffer)
  } else {
    outgoing.end()
  }
}

async function main(): Promise<void> {
  const { db, d1 } = openDatabase(DB_FILE)
  const applied = runMigrations(db, migrationsPaths())
  if (applied.length) console.log(`已执行迁移：${applied.join(', ')}`)

  const lobby = new Lobby(d1)
  await lobby.load()

  const rooms = new RoomRegistry({ db: d1, notifyLobby: () => lobby.notifyRoomsUpdated() })
  // 进程重启后房间要从库里活过来，否则一次部署就把所有牌局清了
  const restored = await rooms.restoreAll()
  if (restored) console.log(`已恢复 ${restored} 个房间`)

  const env: Env = {
    ROOMS: rooms,
    LOBBY: lobby,
    DB: d1,
    ADMIN_TOKEN: process.env.ADMIN_TOKEN,
  }

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const body = await readBody(incoming)
        const response = await route(toRequest(incoming, body), env)
        await writeResponse(response, outgoing)
      } catch (cause) {
        console.error('请求处理失败', incoming.url, cause)
        try {
          await writeResponse(errorResponse(cause, 500), outgoing)
        } catch {
          outgoing.destroy()
        }
      }
    })()
  })

  attachWebSockets(server, env)

  server.listen(PORT, HOST, () => {
    console.log(`红中麻将服务已启动 http://${HOST}:${PORT}`)
    console.log(`数据库：${DB_FILE}`)
    console.log(`管理接口：${env.ADMIN_TOKEN ? '已启用' : '未配置 ADMIN_TOKEN，整体不可见'}`)
  })

  // PM2 重启和 Ctrl+C 都走这里，把 SQLite 正常关掉，避免 WAL 残留
  const shutdown = (signal: string) => {
    console.log(`收到 ${signal}，正在关闭…`)
    server.close(() => {
      db.close()
      process.exit(0)
    })
    // 连接一直不断开也别无限等
    setTimeout(() => {
      db.close()
      process.exit(0)
    }, 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((cause: unknown) => {
  console.error('服务启动失败', cause)
  process.exit(1)
})
