import { describe, expect, it } from 'vitest'
import { reconnectDelay } from '@/sanguosha/online/reconnect'

describe('纸上三国联机重连退避', () => {
  it('逐次延长并封顶约十秒', () => {
    expect([0, 1, 2, 3, 8].map((attempt) => reconnectDelay(attempt, () => 0.5)))
      .toEqual([1200, 2500, 5000, 10_000, 10_000])
  })

  it('带有限抖动且不会超过十秒', () => {
    expect(reconnectDelay(0, () => 0)).toBe(1020)
    expect(reconnectDelay(0, () => 1)).toBe(1380)
    expect(reconnectDelay(99, () => 1)).toBe(10_000)
  })
})
