import { describe, expect, it } from 'vitest'
import { GameRng } from '@/sanguosha/engine/rng'

describe('纸上三国确定性随机源', () => {
  it('相同 seed 产生相同序列和洗牌', () => {
    const left = new GameRng('ruleset-v1:test-seed')
    const right = new GameRng('ruleset-v1:test-seed')
    expect(Array.from({ length: 20 }, () => left.nextInt(1000))).toEqual(Array.from({ length: 20 }, () => right.nextInt(1000)))
    expect(left.shuffle([1, 2, 3, 4, 5, 6])).toEqual(right.shuffle([1, 2, 3, 4, 5, 6]))
  })

  it('可从 snapshot 恢复后续序列', () => {
    const original = new GameRng('snapshot-test')
    original.nextUint32()
    const restored = new GameRng('snapshot-test', original.snapshot())
    expect(restored.nextUint32()).toBe(original.nextUint32())
  })

  it('拒绝非法随机范围', () => {
    expect(() => new GameRng('x').nextInt(0)).toThrow('正整数')
  })
})
