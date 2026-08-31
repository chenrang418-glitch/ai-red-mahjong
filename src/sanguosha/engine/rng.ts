function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0 || 0x6d2b79f5
}

/** 规则、AI 与回放共用的确定性随机源。引擎内禁止使用非确定性随机 API。 */
export class GameRng {
  private state: number

  constructor(readonly seed: string, snapshot?: number) {
    this.state = snapshot === undefined ? hashSeed(seed) : snapshot >>> 0
    if (this.state === 0) this.state = 0x6d2b79f5
  }

  nextUint32(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0 || 0x6d2b79f5
    return this.state
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error('随机上限必须是正整数')
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
    let value = this.nextUint32()
    while (value >= limit) value = this.nextUint32()
    return value % maxExclusive
  }

  shuffle<T>(items: readonly T[]): T[] {
    const shuffled = [...items]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = this.nextInt(index + 1)
      ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
    }
    return shuffled
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('不能从空列表随机选择')
    return items[this.nextInt(items.length)]
  }

  snapshot(): number {
    return this.state
  }
}
