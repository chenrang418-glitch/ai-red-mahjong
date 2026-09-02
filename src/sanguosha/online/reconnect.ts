const BACKOFF_MS = [1200, 2500, 5000, 10_000] as const

/** 指数退避加轻微抖动；上限 10 秒，避免服务恢复时所有客户端同时冲击。 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)]
  const jitter = 0.85 + Math.min(1, Math.max(0, random())) * 0.3
  return Math.min(10_000, Math.round(base * jitter))
}
