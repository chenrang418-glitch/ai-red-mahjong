import { afterEach, describe, expect, it, vi } from 'vitest'
import { onRequest } from '../functions/api/[[path]]'
import { resolveApiBase } from '../src/composables/useOnlineGame'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('联机同源代理', () => {
  it('生产环境默认使用当前网页域名', () => {
    vi.stubGlobal('window', {
      location: {
        hostname: 'ai-red-mahjong.pages.dev',
        origin: 'https://ai-red-mahjong.pages.dev',
      },
    })

    expect(resolveApiBase()).toBe('https://ai-red-mahjong.pages.dev')
  })

  it('本地开发仍连接本地联机服务', () => {
    vi.stubGlobal('window', {
      location: {
        hostname: '127.0.0.1',
        origin: 'http://127.0.0.1:5173',
      },
    })

    expect(resolveApiBase()).toBe('http://127.0.0.1:8787')
  })

  it('将 API 请求原样转交给内部 Worker', async () => {
    const request = new Request('https://ai-red-mahjong.pages.dev/api/health')
    let forwardedRequest: Request | null = null
    const response = await onRequest({
      request,
      env: {
        ONLINE_SERVICE: {
          async fetch(candidate) {
            forwardedRequest = candidate
            return Response.json({ ok: true })
          },
        },
      },
    })

    expect(forwardedRequest).toBe(request)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
