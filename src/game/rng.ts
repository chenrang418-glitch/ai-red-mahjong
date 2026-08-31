/**
 * 牌局随机源。
 *
 * 这里有两套随机数，用途完全不同，不要混：
 *
 * 1. 密码学安全随机（本文件的 secure* 系列）
 *    正式牌局用。洗牌顺序、投骰点数都必须不可预测——客户端能看到 matchId、
 *    事件 id、骰子点数这些公开数据，其中任何一个都不能反推出牌墙顺序。
 *
 * 2. 可复现的 xorshift32（tiles.ts 里的 nextRandom / shuffleWithState）
 *    只给测试用。传了 config.seed 就走这条路，同一个 seed 必须每次都得到同一副牌，
 *    否则一大批依赖固定种子的用例没法写。
 *
 * 判定标准只有一个：config.seed 是否显式存在。
 * 生产环境创建 GameEngine 时绝对不能传 seed。
 */

/**
 * 只声明这里真正用到的两个方法。
 * 浏览器的 lib.dom 和 Worker 的 @cloudflare/workers-types 对全局 crypto 的声明不一样，
 * 直接写 globalThis.crypto 在其中一边会报类型不存在，所以自己收一个最小接口。
 */
interface RandomSource {
  getRandomValues<T extends Uint8Array | Uint32Array>(array: T): T
  randomUUID?: () => string
}

/** 取当前环境的 crypto。Worker、浏览器、Node 18+ 都有全局 crypto。 */
function webCrypto(): RandomSource {
  const candidate = (globalThis as { crypto?: RandomSource }).crypto
  if (!candidate || typeof candidate.getRandomValues !== 'function') {
    throw new Error('当前环境缺少 crypto.getRandomValues，无法生成安全随机数')
  }
  return candidate
}

/**
 * 返回 [0, maxExclusive) 的均匀随机整数。
 *
 * 用拒绝采样消除取模偏差：直接 `value % n` 在 2^32 不能被 n 整除时，
 * 靠前的那些数会比靠后的多一次命中机会，牌墙分布就是偏的。
 * 这里把 2^32 截成 n 的整数倍，落在余数区间的样本直接丢弃重抽。
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`随机上界必须是正整数，收到 ${maxExclusive}`)
  }
  if (maxExclusive === 1) return 0
  const crypto = webCrypto()
  const buffer = new Uint32Array(1)
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
  // 期望迭代次数小于 2，循环上限只是防御性兜底，正常永远走不满
  for (let attempt = 0; attempt < 128; attempt += 1) {
    crypto.getRandomValues(buffer)
    const value = buffer[0]
    if (value < limit) return value % maxExclusive
  }
  throw new Error('安全随机数生成失败')
}

/** Fisher-Yates 洗牌，每一步的下标都来自 secureRandomInt，没有取模偏差。 */
export function secureShuffle<T>(items: readonly T[]): T[] {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = secureRandomInt(index + 1)
    ;[shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]]
  }
  return shuffled
}

/**
 * 整场牌局的公开标识。
 *
 * 以前是 `match-${Date.now()}-${seed}`，seed 同时又是 xorshift32 的初始状态，
 * 等于把洗牌种子直接广播给了所有客户端——拿到 matchId 就能重放整个随机序列，
 * 还原四家起手牌、牌墙顺序和码区。现在换成与随机源完全无关的高熵不透明 id。
 */
export function createMatchId(): string {
  const crypto = webCrypto()
  if (typeof crypto.randomUUID === 'function') return `match-${crypto.randomUUID()}`
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `match-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** 旧版本 `match-${时间戳}-${seed}` 格式，这种 id 会泄露洗牌种子。 */
const LEGACY_MATCH_ID = /^match-\d+-\d+$/

export function isSeedBearingMatchId(matchId: string): boolean {
  return LEGACY_MATCH_ID.test(matchId)
}

/** 给历史牌局用的替代 id：同样不透明，且与随机源无关。 */
export function createOpaqueMatchToken(): string {
  return createMatchId()
}
