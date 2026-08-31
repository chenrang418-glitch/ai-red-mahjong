export const CLAIM_MASK_DELAY_RANGE = [700, 1100] as const
export const CLAIM_DEADLINE_BUFFER_MS = 300

// 无人可碰杠时也要停一下再让下家摸牌，否则「瞬间摸牌」本身就暴露了没人能碰。
export function claimMaskDelay(randomValue = Math.random()): number {
  const normalized = Math.max(0, Math.min(1, randomValue))
  const [minimum, maximum] = CLAIM_MASK_DELAY_RANGE
  return Math.round(minimum + normalized * (maximum - minimum))
}
