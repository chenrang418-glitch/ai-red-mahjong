// 网页版用 localStorage，小程序这边换成 wx 的同步存储。
// 只包一层，调用方写法保持一致，核心逻辑不用跟着改。
export function readJSON<T>(key: string): T | null {
  try {
    const raw = wx.getStorageSync(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    if (value === null) wx.removeStorageSync(key)
    else wx.setStorageSync(key, JSON.stringify(value))
  } catch {
    // 存不下不影响这一局，最多是下次进来没有存档
  }
}
