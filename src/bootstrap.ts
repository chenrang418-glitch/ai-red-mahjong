import type { App } from 'vue'

type ManagedApp = Pick<App, 'config' | 'mount' | 'unmount'>

/**
 * 挂载 Vue，并保证全局运行时错误不会在“Vue 仍 mounted”的情况下直接改根 DOM。
 *
 * 子组件错误优先由 RootApp 的受控错误界面接住；只有穿透到全局 handler 的致命
 * 错误才走这里。此时必须先 unmount，再交给静态 fallback 清理根节点。
 */
export function mountWithFallback(app: ManagedApp, root: string, renderFallback: (cause?: unknown) => void): void {
  let mounted = false
  let mounting = true
  let handlingFatalError = false
  let bootHandlerFailed = false
  let bootHandlerCause: unknown

  const renderSafely = (cause: unknown): void => {
    try { renderFallback(cause) } catch { /* 错误页失败时不再制造第二个异常 */ }
  }

  const fail = (cause: unknown): void => {
    // unmount 或 fallback 自身再抛错时不能递归进入 errorHandler。
    if (handlingFatalError) return
    handlingFatalError = true
    if (mounted) {
      mounted = false
      try { app.unmount() } catch { /* fallback 仍然必须尽力显示 */ }
    }
    renderSafely(cause)
  }

  app.config.errorHandler = (cause) => {
    // 初次 mount 内部也可能先调用 errorHandler、再从 mount 返回。先记下来，
    // 等 mount 收尾后 unmount 半成品，避免随后把静态 fallback 又覆盖掉。
    if (mounting) {
      bootHandlerFailed = true
      bootHandlerCause = cause
      return
    }
    fail(cause)
  }
  try {
    app.mount(root)
    mounting = false
    if (bootHandlerFailed) {
      try { app.unmount() } catch { /* 继续显示启动 fallback */ }
      renderSafely(bootHandlerCause)
    } else {
      mounted = true
    }
  } catch (cause) {
    mounting = false
    renderSafely(cause)
  }
}
