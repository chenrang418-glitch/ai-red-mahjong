import { onBeforeUnmount, ref } from 'vue'

// 全屏牌桌：把顶栏和两侧面板收起来，只留牌桌和操作区。
// 同时尝试请求浏览器全屏——iOS Safari 不支持，失败就只做布局上的沉浸，不影响使用。
export function useImmersiveTable() {
  const immersive = ref(false)

  function syncFromBrowser() {
    if (!document.fullscreenElement && immersive.value) immersive.value = false
  }

  async function toggleImmersive() {
    immersive.value = !immersive.value
    try {
      if (immersive.value) await document.documentElement.requestFullscreen?.()
      else if (document.fullscreenElement) await document.exitFullscreen?.()
    } catch {
      // 浏览器不给全屏就算了，布局照样切
    }
  }

  document.addEventListener('fullscreenchange', syncFromBrowser)
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', syncFromBrowser))

  return { immersive, toggleImmersive }
}
