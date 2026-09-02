import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/**
 * 对局、选将和联机等人时保持屏幕常亮。
 *
 * 浏览器切到后台会由系统自动释放锁；回到前台以及下一次用户触摸时重新申请。
 * 不支持 Screen Wake Lock 的旧浏览器安静降级，不使用循环视频或静音音频绕过系统。
 */
export function useScreenWakeLock(active: Readonly<Ref<boolean>>): void {
  let sentinel: WakeLockSentinel | null = null
  let requesting = false

  async function acquire(): Promise<void> {
    if (!active.value || document.visibilityState !== 'visible' || sentinel || requesting) return
    if (!('wakeLock' in navigator)) return
    requesting = true
    try {
      const next = await navigator.wakeLock.request('screen')
      if (!active.value || document.visibilityState !== 'visible') {
        await next.release()
        return
      }
      sentinel = next
      next.addEventListener('release', () => {
        if (sentinel === next) sentinel = null
      }, { once: true })
    } catch {
      // 权限被拒绝或系统暂时不允许时，等待下一次用户触摸/回到前台再试。
    } finally {
      requesting = false
    }
  }

  async function release(): Promise<void> {
    const current = sentinel
    sentinel = null
    if (current && !current.released) {
      try { await current.release() } catch { /* 页面退出时释放失败不影响游戏 */ }
    }
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') void acquire()
    else void release()
  }

  function onPointerDown(): void { void acquire() }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    void acquire()
  })
  watch(active, (enabled) => { if (enabled) void acquire(); else void release() })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('pointerdown', onPointerDown)
    void release()
  })
}
