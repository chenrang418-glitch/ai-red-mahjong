import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasAcceptedProjectNotice,
  markProjectNoticeAccepted,
  PROJECT_NOTICE_STORAGE_KEY,
} from '@/notice/noticeStorage'
import { copyText } from '@/notice/clipboard'

/**
 * 「项目说明」已读状态的存储逻辑。
 *
 * 环境是 `environment: 'node'`（见 vitest.config.ts），没有真实的 `window`，
 * 所以这里跟 `tests/online-client.test.ts` 一样，自己拼一个 `window` 全局，
 * 用真实的 Map 当 localStorage 后端；异常场景直接用会抛错的假实现验证
 * 「读写失败也不能让整个网站白屏」。
 */

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
    clear: () => data.clear(),
    key: () => null,
    get length() { return data.size },
  }
}

function throwingStorage(): Storage {
  return {
    getItem: () => { throw new Error('隐私模式下不可用') },
    setItem: () => { throw new Error('隐私模式下不可用') },
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('版本化的存储 key', () => {
  it('用带版本号的 key，不是笼统的 notice_seen', () => {
    expect(PROJECT_NOTICE_STORAGE_KEY).toBe('crplay_project_notice_v1')
  })
})

describe('hasAcceptedProjectNotice / markProjectNoticeAccepted', () => {
  it('从没写过时视为「没读过」', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() })
    expect(hasAcceptedProjectNotice()).toBe(false)
  })

  it('确认之后能读到已确认', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() })
    markProjectNoticeAccepted()
    expect(hasAcceptedProjectNotice()).toBe(true)
  })

  it('写入的值就是 accepted，不是别的占位符', () => {
    const storage = fakeStorage()
    vi.stubGlobal('window', { localStorage: storage })
    markProjectNoticeAccepted()
    expect(storage.getItem(PROJECT_NOTICE_STORAGE_KEY)).toBe('accepted')
  })

  it('storage 里是别的值（不是 accepted）时仍视为没确认过', () => {
    const storage = fakeStorage()
    storage.setItem(PROJECT_NOTICE_STORAGE_KEY, 'true')
    vi.stubGlobal('window', { localStorage: storage })
    expect(hasAcceptedProjectNotice()).toBe(false)
  })

  it('localStorage.getItem 抛错时安全返回「没确认过」，不向外抛', () => {
    vi.stubGlobal('window', { localStorage: throwingStorage() })
    expect(() => hasAcceptedProjectNotice()).not.toThrow()
    expect(hasAcceptedProjectNotice()).toBe(false)
  })

  it('localStorage.setItem 抛错时不向外抛，本次访问仍可继续', () => {
    vi.stubGlobal('window', { localStorage: throwingStorage() })
    expect(() => markProjectNoticeAccepted()).not.toThrow()
  })

  it('window 全局完全不存在时（极端环境）也不抛错', () => {
    // 不 stub window：node 环境下访问裸标识符 window 本身就是 ReferenceError，
    // 必须被 try/catch 接住，而不是让调用方直接崩掉
    expect(() => hasAcceptedProjectNotice()).not.toThrow()
    expect(hasAcceptedProjectNotice()).toBe(false)
    expect(() => markProjectNoticeAccepted()).not.toThrow()
  })
})

describe('copyText 剪贴板兼容', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { isSecureContext: true })
  })

  it('Clipboard API 可用时优先使用它', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const ok = await copyText('1507394636')
    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('1507394636')
  })

  it('Clipboard API 抛错时退回 execCommand，仍然成功', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    const appended: string[] = []
    const fakeTextarea = {
      setAttribute: vi.fn(),
      style: {},
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      value: '',
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => fakeTextarea),
      body: {
        appendChild: vi.fn((node: unknown) => { appended.push(String(node)) }),
        removeChild: vi.fn(),
      },
      execCommand: vi.fn(() => true),
    })
    const ok = await copyText('1507394636')
    expect(ok).toBe(true)
    expect(fakeTextarea.value).toBe('1507394636')
  })

  it('两条路径都失败时返回 false，而不是抛出异常', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined })
    vi.stubGlobal('document', {
      createElement: vi.fn(() => { throw new Error('不支持') }),
    })
    await expect(copyText('1507394636')).resolves.toBe(false)
  })

  it('非安全上下文（没有 HTTPS）时跳过 Clipboard API，直接走 execCommand', async () => {
    vi.stubGlobal('window', { isSecureContext: false })
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const fakeTextarea = { setAttribute: vi.fn(), style: {}, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), value: '' }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => fakeTextarea),
      body: { appendChild: vi.fn(), removeChild: vi.fn() },
      execCommand: vi.fn(() => true),
    })
    await copyText('1507394636')
    expect(writeText).not.toHaveBeenCalled()
  })
})
