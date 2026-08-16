import { onBeforeUnmount, ref } from 'vue'

// 竖屏手机的可用宽度就那么点，左右两家的十三张牌背既占地方又没有信息量。
// 布局要在竖屏换一套排布，光靠 CSS 换不掉「渲染多少个元素」，所以这里把断点读成响应式状态。
const PORTRAIT_QUERY = '(orientation: portrait) and (max-width: 820px), (pointer: coarse) and (orientation: portrait)'
const SHORT_QUERY = '(orientation: landscape) and (max-height: 620px)'

function watchQuery(query: string) {
  const matches = ref(false)
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return { matches, dispose: () => {} }
  const media = window.matchMedia(query)
  matches.value = media.matches
  const update = (event: MediaQueryListEvent | MediaQueryList) => { matches.value = event.matches }
  media.addEventListener('change', update)
  return { matches, dispose: () => media.removeEventListener('change', update) }
}

export function useViewport() {
  const portrait = watchQuery(PORTRAIT_QUERY)
  const shortLandscape = watchQuery(SHORT_QUERY)
  onBeforeUnmount(() => {
    portrait.dispose()
    shortLandscape.dispose()
  })
  return { isPortrait: portrait.matches, isShortLandscape: shortLandscape.matches }
}
