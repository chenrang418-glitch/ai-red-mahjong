export const vibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

let enabled = true

function pattern(value: number | number[]): void {
  if (!enabled || !vibrationSupported || (typeof document !== 'undefined' && document.hidden)) return
  try { navigator.vibrate(value) } catch { /* 不支持或未获得交互权限时静默降级 */ }
}

export const haptics = {
  setEnabled(value: boolean) { enabled = value },
  pattern,
  light() { pattern(10) },
  medium() { pattern(28) },
  heavy() { pattern([38, 38, 58]) },
  success() { pattern([22, 38, 42, 38, 72]) },
  warning() { pattern([42, 45, 24]) },
}
