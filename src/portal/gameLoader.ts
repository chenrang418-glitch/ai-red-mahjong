export type GameLoadResult<T> =
  | { status: 'success'; value: T }
  | { status: 'error'; error: unknown }
  | { status: 'stale' }

/**
 * 只接纳最后一次动态游戏加载。
 *
 * 每次调用持有自己的 timer；旧加载在 finally 中只会清理自己的 timer，
 * 不可能误清掉新加载的超时保护。dispose 会使所有在途结果失效并清理定时器。
 */
export class LatestGameLoader<T> {
  private revision = 0
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly cancellations = new Set<() => void>()

  constructor(private readonly timeoutMs = 15_000) {}

  async load(load: () => Promise<T>): Promise<GameLoadResult<T>> {
    // “只接纳最后一次”也意味着旧调用者应立即获知失效，而不是继续等一个
    // 永不 settle 的 dynamic import。原始 import 无法中止，但外层 await 可以结束。
    this.cancelInFlight()
    const revision = ++this.revision
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancel!: () => void
    const cancelled = new Promise<GameLoadResult<T>>((resolve) => {
      cancel = () => resolve({ status: 'stale' })
      this.cancellations.add(cancel)
    })
    const timeout = new Promise<GameLoadResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'error', error: new Error('游戏资源加载超时') }), this.timeoutMs)
      this.timers.add(timer)
    })
    try {
      const loaded: Promise<GameLoadResult<T>> = load().then(
        (value): GameLoadResult<T> => ({ status: 'success', value }),
        (error: unknown): GameLoadResult<T> => ({ status: 'error', error }),
      )
      const result = await Promise.race([loaded, timeout, cancelled])
      return revision === this.revision ? result : { status: 'stale' }
    } finally {
      this.cancellations.delete(cancel)
      if (timer !== null) {
        clearTimeout(timer)
        this.timers.delete(timer)
      }
    }
  }

  dispose(): void {
    this.revision += 1
    this.cancelInFlight()
  }

  private cancelInFlight(): void {
    for (const cancel of [...this.cancellations]) cancel()
    this.cancellations.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
