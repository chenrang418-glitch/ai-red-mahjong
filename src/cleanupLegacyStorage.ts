const LEGACY_LOCAL_STORAGE_KEYS = [
  'red-mahjong-active-v1',
  'guangshan-mahjong-active-v1',
  'red-mahjong-storage-migrated-v1',
  'ai-red-mahjong.online-session',
  'ai-red-mahjong.online-room',
]

const LEGACY_DATABASES = ['red-mahjong', 'guangshan-mahjong']

/** 清掉已下线的本地牌局、牌谱和旧版明文会话，不影响仍在使用的偏好。 */
export function cleanupLegacyStorage(): void {
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    try { window.localStorage.removeItem(key) } catch { /* 存储不可用时无需阻断启动 */ }
  }

  if (!('indexedDB' in window)) return
  for (const name of LEGACY_DATABASES) {
    try { window.indexedDB.deleteDatabase(name) } catch { /* 删除失败不影响纯内存牌局 */ }
  }
}
