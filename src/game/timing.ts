import type { ThinkingSpeed } from './types'

export const CLAIM_MASK_DELAY_RANGE = [1200, 1800] as const
export const CLAIM_DEADLINE_BUFFER_MS = 300

export const AI_CLAIM_WINDOW_RATIOS: Record<ThinkingSpeed, readonly [number, number]> = {
  fast: [0.2, 0.35],
  normal: [0.35, 0.55],
  slow: [0.55, 0.75],
  dreamy: [0.7, 0.9],
}

export function claimMaskDelay(randomValue = Math.random()): number {
  const normalized = Math.max(0, Math.min(1, randomValue))
  const [minimum, maximum] = CLAIM_MASK_DELAY_RANGE
  return Math.round(minimum + normalized * (maximum - minimum))
}

export function claimReactionDelay(speed: ThinkingSpeed, salt: number, claimWindowMs: number): number {
  const [minimumRatio, maximumRatio] = AI_CLAIM_WINDOW_RATIOS[speed]
  const ratio = Math.abs(Math.sin(salt * 12.9898))
  const reactionRatio = minimumRatio + (maximumRatio - minimumRatio) * ratio
  const deadlineCap = Math.max(0, claimWindowMs - CLAIM_DEADLINE_BUFFER_MS)
  return Math.min(Math.round(claimWindowMs * reactionRatio), deadlineCap)
}
