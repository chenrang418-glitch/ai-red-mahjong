import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(fileURLToPath(import.meta.url))
const distRoot = resolve(projectRoot, 'dist')
const host = '127.0.0.1'
const port = Number.parseInt(process.env.PORT ?? '4173', 10)

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

if (!existsSync(resolve(distRoot, 'index.html'))) {
  console.error('未找到 dist/index.html，请先运行 npm run build。')
  process.exit(1)
}

const server = createServer((request, response) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname)
  } catch {
    response.writeHead(400).end('Bad Request')
    return
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
  let target = resolve(distRoot, relativePath)
  if (target !== distRoot && !target.startsWith(`${distRoot}${sep}`)) {
    response.writeHead(403).end('Forbidden')
    return
  }
  if (!existsSync(target) || statSync(target).isDirectory()) target = resolve(distRoot, 'index.html')

  response.setHeader('Content-Type', mimeTypes[extname(target)] ?? 'application/octet-stream')
  response.setHeader('Cache-Control', target.endsWith('index.html') ? 'no-cache' : 'public, max-age=604800')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  createReadStream(target).on('error', () => response.writeHead(500).end('Server Error')).pipe(response)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`本地服务已在 http://${host}:${port} 运行。`)
    process.exit(0)
  }
  throw error
})

server.listen(port, host, () => {
  console.log(`AI 红中麻将已启动：http://${host}:${port}`)
})
