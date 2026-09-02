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

  constructor(private readonly timeoutMs = 15_000) {}

  async load(load: () => Promise<T>): Promise<GameLoadResult<T>> {
    const revision = ++this.revision
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('游戏资源加载超时')), this.timeoutMs)
      this.timers.add(timer)
    })
    try {
      const value = await Promise.race([load(), timeout])
      return revision === this.revision ? { status: 'success', value } : { status: 'stale' }
    } catch (error) {
      return revision === this.revision ? { status: 'error', error } : { status: 'stale' }
    } finally {
      if (timer !== null) {
        clearTimeout(timer)
        this.timers.delete(timer)
      }
    }
  }

  dispose(): void {
    this.revision += 1
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
