import { describe, expect, it } from 'vitest'
import {
  AI_CLAIM_WINDOW_RATIOS,
  CLAIM_DEADLINE_BUFFER_MS,
  CLAIM_MASK_DELAY_RANGE,
  claimMaskDelay,
  claimReactionDelay,
} from '@/game/timing'
import type { ThinkingSpeed } from '@/game/types'

describe('抢碰抢杠计时', () => {
  it('无人可抢时使用1.2至1.8秒的随机伪装停顿', () => {
    expect(claimMaskDelay(0)).toBe(CLAIM_MASK_DELAY_RANGE[0])
    expect(claimMaskDelay(0.5)).toBe(1500)
    expect(claimMaskDelay(1)).toBe(CLAIM_MASK_DELAY_RANGE[1])
  })

  it('四档AI抢牌反应按窗口缩放且始终早于截止时间', () => {
    const claimWindowMs = 4000
    for (const speed of Object.keys(AI_CLAIM_WINDOW_RATIOS) as ThinkingSpeed[]) {
      const [minimumRatio, maximumRatio] = AI_CLAIM_WINDOW_RATIOS[speed]
      for (let salt = 1; salt <= 50; salt += 1) {
        const delay = claimReactionDelay(speed, salt, claimWindowMs)
        expect(delay).toBeGreaterThanOrEqual(Math.round(claimWindowMs * minimumRatio))
        expect(delay).toBeLessThanOrEqual(Math.round(claimWindowMs * maximumRatio))
        expect(delay).toBeLessThanOrEqual(claimWindowMs - CLAIM_DEADLINE_BUFFER_MS)
      }
    }
  })

  it('最短2秒窗口下入梦AI也能在截止前完成响应', () => {
    for (let salt = 1; salt <= 50; salt += 1) {
      expect(claimReactionDelay('dreamy', salt, 2000)).toBeLessThanOrEqual(1700)
    }
  })
})
