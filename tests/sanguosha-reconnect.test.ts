import { describe, expect, it } from 'vitest'
import { reconnectDelay } from '@/sanguosha/online/reconnect'

/**
 * 重连退避。
 *
 * 这里的取舍从「怕重连风暴」改成了「怕用户多等」：项目同时最多一个房间、
 * 玩家个位数，压根形成不了风暴，而一次正常的网络瞬断先空等 1.2 秒，
 * 用户看到的就是多盯一秒黑屏。所以第一次立刻重连，上限也从 10 秒收到 5 秒。
 */
describe('纸上三国联机重连退避', () => {
  it('第一次立刻重连，之后逐次延长并封顶五秒', () => {
    expect([0, 1, 2, 3, 8].map((attempt) => reconnectDelay(attempt, () => 0.5)))
      .toEqual([0, 250, 500, 1_000, 5_000])
  })

  it('立刻那一次不加抖动，其余带有限抖动且不超过五秒', () => {
    expect(reconnectDelay(0, () => 0), '「立刻」就该是 0').toBe(0)
    expect(reconnectDelay(0, () => 1)).toBe(0)
    expect(reconnectDelay(1, () => 0)).toBe(213)
    expect(reconnectDelay(1, () => 1)).toBe(288)
    expect(reconnectDelay(99, () => 1)).toBe(5_000)
  })

  it('负数和超界都落在合法区间里', () => {
    expect(reconnectDelay(-5, () => 0.5)).toBe(0)
    expect(reconnectDelay(1_000, () => 0.5)).toBeLessThanOrEqual(5_000)
  })
})
