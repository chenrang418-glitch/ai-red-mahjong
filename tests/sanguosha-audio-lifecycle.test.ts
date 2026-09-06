import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 音频上下文的生命周期。
 *
 * 用户报了两件事：
 *
 * 1. 戴耳机时音效有电流杂音，反复重连几次之后又没有了；
 * 2. 反复大退重连有概率让音频彻底中断，只能再大退一次才可能恢复。
 *
 * 两件事的根都在同一处：`AudioContext` 一旦坏掉或者输出设备换了，
 * 老实现没有任何自愈路径——`ensureContext()` 只在引用为 null 时才新建，
 * 于是死掉的上下文会被一直返回；而已经解码好的采样是跟着**旧设备采样率**的，
 * 换了耳机之后继续拿它播就是持续的杂音。
 *
 * 这个项目的 vitest 跑在 `node` 环境，没有真的 Web Audio，所以这里塞一套
 * 假的 `AudioContext` 进去，真正驱动模块跑一遍——比源码字符串断言更能说明问题。
 */

interface FakeNode { connect: () => void; disconnect: () => void }

class FakeAudioContext {
  static created: FakeAudioContext[] = []
  /** 下一次构造要不要直接抛异常，模拟「同时存在的上下文到上限」。 */
  static failNext = false
  /** 新建出来的上下文报告的默认采样率，用来模拟换输出设备。 */
  static defaultSampleRate = 48_000

  state: 'running' | 'suspended' | 'closed' = 'suspended'
  currentTime = 0
  readonly sampleRate: number
  readonly destination: FakeNode = { connect: () => undefined, disconnect: () => undefined }
  readonly startedSources: unknown[] = []
  readonly gains: Array<{ values: number[] }> = []
  resumeCalls = 0
  /** resume 要不要失败，模拟 iOS 上卡在 interrupted 的上下文。 */
  resumeShouldFail = false
  private listeners: Array<() => void> = []

  constructor() {
    if (FakeAudioContext.failNext) {
      FakeAudioContext.failNext = false
      throw new Error('too many audio contexts')
    }
    this.sampleRate = FakeAudioContext.defaultSampleRate
    FakeAudioContext.created.push(this)
  }

  createGain(): FakeNode & { gain: { setTargetAtTime: () => void } } {
    const tracked = { values: [] as number[] }
    this.gains.push(tracked)
    return {
      connect: () => undefined,
      disconnect: () => undefined,
      gain: { setTargetAtTime: (value?: number) => { tracked.values.push(value ?? 0) } },
    }
  }

  createBufferSource(): FakeNode & { buffer: unknown; loop: boolean; onended: (() => void) | null; start: () => void; stop: () => void } {
    const source = {
      buffer: null as unknown,
      loop: false,
      onended: null as (() => void) | null,
      connect: () => undefined,
      disconnect: () => undefined,
      start: () => { this.startedSources.push(source) },
      stop: () => undefined,
    }
    return source
  }

  decodeAudioData(): Promise<unknown> { return Promise.resolve({ sampleRate: this.sampleRate }) }

  resume(): Promise<void> {
    this.resumeCalls += 1
    if (this.resumeShouldFail) return Promise.reject(new Error('interrupted'))
    this.state = 'running'
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }

  addEventListener(_type: string, listener: () => void): void { this.listeners.push(listener) }

  /** 模拟浏览器单方面把上下文关掉（设备被拔、系统回收音频会话）。 */
  killExternally(): void {
    this.state = 'closed'
    for (const listener of this.listeners) listener()
  }
}

const deviceChangeListeners: Array<() => void> = []

function installFakeEnvironment(): void {
  FakeAudioContext.created = []
  FakeAudioContext.failNext = false
  FakeAudioContext.defaultSampleRate = 48_000
  deviceChangeListeners.length = 0

  const listeners = new Map<string, Array<() => void>>()
  const fakeWindow = {
    AudioContext: FakeAudioContext,
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener: () => undefined,
    localStorage: { getItem: () => null, setItem: () => undefined },
    // 「采样还在解码，先等一下再放」那条路用的是 window.setTimeout
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    setInterval: (handler: () => void, ms?: number) => setInterval(handler, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
  }
  vi.stubGlobal('window', fakeWindow)
  /*
   * Vue 的 runtime-dom 在模块初始化时会 `document.createElement('template')`，
   * 所以这份假 document 必须给得出这个方法，否则连 import 都过不去。
   */
  vi.stubGlobal('document', {
    hidden: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: () => ({ content: {}, innerHTML: '', firstChild: null, setAttribute: () => undefined }),
    createTextNode: () => ({}),
    querySelector: () => null,
  })
  vi.stubGlobal('localStorage', fakeWindow.localStorage)
  vi.stubGlobal('navigator', {
    mediaDevices: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'devicechange') deviceChangeListeners.push(listener)
      },
    },
  })
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  }))
}

/** 当前用例正在驱动的那份模块，用于收尾时把它的异步工作停掉。 */
let currentAudio: Awaited<ReturnType<typeof freshAudio>> | null = null

/** 每个用例都要拿一份全新的模块：上下文是模块级单例。 */
async function freshAudio() {
  vi.resetModules()
  installFakeEnvironment()
  const audio = (await import('@/sanguosha/composables/useSgsAudio')).sgsAudio
  currentAudio = audio
  return audio
}

function liveContexts(): FakeAudioContext[] {
  return FakeAudioContext.created.filter((candidate) => candidate.state !== 'closed')
}

beforeEach(() => { installFakeEnvironment() })
afterEach(async () => {
  /*
   * **先把模块停下来，再撤掉假环境。**
   *
   * 音乐加载是异步的：撤掉 globals 之后那条 `.then` 才跑到 `startMusic()`，
   * 里面要读 `document.hidden`，此时 `document` 已经没了，就变成一条
   * 「测试之外抛出的未捕获错误」。`stop()` 会把 active 置假，
   * 那个短路条件排在最前面，后面的回调就什么都不做了。
   */
  currentAudio?.stop()
  currentAudio = null
  await new Promise((settle) => { setTimeout(settle, 0) })
  vi.unstubAllGlobals()
})

describe('上下文坏掉之后能自愈', () => {
  it('上下文被浏览器关掉后，下一次播放会重建一个新的', async () => {
    const audio = await freshAudio()
    audio.resume()
    expect(FakeAudioContext.created).toHaveLength(1)
    const first = FakeAudioContext.created[0]

    // 系统回收音频会话 / 设备被拔掉：浏览器单方面把上下文关掉
    first.killExternally()

    audio.play('slash')
    /*
     * 老实现里 `ensureContext()` 只判引用是否为 null，于是这个死掉的上下文
     * 会被永远返回，声音再也回不来——用户报的「只能再大退一次」就是这个。
     */
    expect(FakeAudioContext.created.length, '必须重建一个新的上下文').toBe(2)
    expect(FakeAudioContext.created[1].state).not.toBe('closed')
  })

  it('反复关掉再播放，不会堆出一堆活着的上下文', async () => {
    const audio = await freshAudio()
    for (let round = 0; round < 5; round += 1) {
      audio.resume()
      const current = liveContexts().at(-1)
      expect(current, `第 ${round} 轮应该有一个活着的上下文`).toBeTruthy()
      current!.killExternally()
      audio.play('slash')
    }
    // 每一轮都是「关掉一个、建一个」，同时活着的永远只有一个
    expect(liveContexts()).toHaveLength(1)
  })

  it('创建失败时静音降级，不把异常抛进牌局表现', async () => {
    const audio = await freshAudio()
    FakeAudioContext.failNext = true
    // 浏览器对同时存在的上下文有上限，创建会直接抛
    expect(() => audio.play('slash')).not.toThrow()
    // 下一次还能再试，不会被永久卡住
    expect(() => audio.play('slash')).not.toThrow()
    expect(liveContexts().length).toBeGreaterThan(0)
  })

  it('resume 连续失败会拆掉这个上下文，而不是一直卡着', async () => {
    const audio = await freshAudio()
    audio.resume()
    const first = FakeAudioContext.created[0]
    first.resumeShouldFail = true
    first.state = 'suspended'

    // iOS 上卡在 interrupted 的上下文就是这样：resume 一直不成功
    for (let attempt = 0; attempt < 3; attempt += 1) {
      audio.resume()
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(first.state, '攒够失败次数就该被拆掉').toBe('closed')
  })
})

describe('换输出设备不再有杂音', () => {
  it('插耳机后采样率变了：重建上下文，旧采样一并丢掉', async () => {
    const audio = await freshAudio()
    audio.resume()
    await Promise.resolve()
    const first = FakeAudioContext.created[0]
    expect(first.sampleRate).toBe(48_000)
    expect(deviceChangeListeners.length, '要监听输出设备变化').toBeGreaterThan(0)

    // 插上耳机：新设备默认 44.1kHz
    FakeAudioContext.defaultSampleRate = 44_100
    deviceChangeListeners[0]()

    /*
     * 旧上下文必须被拆掉。留着它继续播用 48kHz 解出来的采样，
     * 听感就是持续的电流杂音——这正是用户报的那个症状。
     */
    expect(first.state).toBe('closed')
    const live = liveContexts()
    expect(live).toHaveLength(1)
    expect(live[0].sampleRate).toBe(44_100)
  })

  it('采样率没变而且上下文正常，就不折腾（重建会让音乐断一下）', async () => {
    const audio = await freshAudio()
    audio.resume()
    await Promise.resolve()
    const first = FakeAudioContext.created[0]
    first.state = 'running'
    const createdBefore = FakeAudioContext.created.length

    deviceChangeListeners[0]()

    expect(first.state, '没必要重建').toBe('running')
    // 只多出一个用完即关的探测上下文，没有真正重建
    expect(liveContexts()).toHaveLength(1)
    expect(FakeAudioContext.created.length).toBeGreaterThanOrEqual(createdBefore)
  })
})

describe('进牌桌时一定会尝试唤醒', () => {
  it('prepare 会 resume，不然挂起状态下音乐永远起不来', async () => {
    const audio = await freshAudio()
    audio.prepare([])
    expect(FakeAudioContext.created).toHaveLength(1)
    expect(FakeAudioContext.created[0].resumeCalls, 'prepare 必须尝试唤醒').toBeGreaterThan(0)
  })

  it('反复进出牌桌都会重新尝试唤醒', async () => {
    const audio = await freshAudio()
    for (let round = 0; round < 3; round += 1) {
      audio.prepare([])
      audio.stop()
    }
    // 唤醒不是一次性的：每次进牌桌都要再试，否则中间被挂起过就再也回不来
    expect(FakeAudioContext.created[0].resumeCalls).toBeGreaterThanOrEqual(3)
  })
})

describe('人物台词声道', () => {
  it('关闭动作音效不会关闭人物台词，台词开关只控制自己的声道', async () => {
    const audio = await freshAudio()
    audio.resume()
    const context = FakeAudioContext.created[0]
    expect(context.gains, '音乐、动作音效、人物台词应是三条独立声道').toHaveLength(3)

    audio.setSetting('effectsEnabled', false)
    expect(context.gains[1].values.at(-1), '动作音效已静音').toBe(0)
    expect(context.gains[2].values.at(-1), '人物台词仍开启').toBe(1)

    audio.setSetting('voiceEnabled', false)
    expect(context.gains[2].values.at(-1), '人物台词由自己的开关静音').toBe(0)
  })

  it('同一技能的两条台词都会进入随机选择', async () => {
    const audio = await freshAudio()
    const random = vi.spyOn(Math, 'random')
    const event = (id: string) => ({
      id, seq: 1, kind: 'skill' as const, sourceId: 'p0', sourceCharacterId: 'machao',
      skillId: 'tieji', skillName: '铁骑', text: '马超发动【铁骑】',
    })

    random.mockReturnValue(0)
    audio.processEvents([event('voice-first')], 'p0')
    await new Promise((settle) => { setTimeout(settle, 0) })
    const context = FakeAudioContext.created[0]
    const first = (context.startedSources.at(-1) as { buffer: unknown }).buffer

    random.mockReturnValue(.999)
    audio.processEvents([event('voice-second')], 'p0')
    const second = (context.startedSources.at(-1) as { buffer: unknown }).buffer
    expect(second, '随机数落在另一端时应选中另一条台词').not.toBe(first)
    random.mockRestore()
  })
})
