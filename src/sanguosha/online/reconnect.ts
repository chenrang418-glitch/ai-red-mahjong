/**
 * 重连退避。
 *
 * **第一次立刻重连。** 这个项目同时最多一个房间、玩家个位数，不存在
 * 「所有客户端同时重连打垮服务器」这种风险；而正常的一次网络瞬断先空等
 * 1.2 秒，用户看到的就是多盯一秒黑屏。抖动仍然保留，避免多端同时恢复时撞在一起。
 *
 * 上限 5 秒：再长的间隔在实际体验里已经等同于「卡死了」。
 */
const BACKOFF_MS = [0, 250, 500, 1_000, 2_000, 4_000, 5_000] as const

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)]
  // 立即重连那一次不加抖动：加了就不叫「立即」了
  if (base === 0) return 0
  const jitter = 0.85 + Math.min(1, Math.max(0, random())) * 0.3
  return Math.min(5_000, Math.round(base * jitter))
}
