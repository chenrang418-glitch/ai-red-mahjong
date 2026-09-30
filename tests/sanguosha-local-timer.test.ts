import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { timerKindOf } from '@/sanguosha/composables/useLocalSanguosha'
import { timeoutDefaultResponse } from '@/sanguosha/engine/timeout-default'
import type { GameRequest } from '@/sanguosha/engine/requests'

/**
 * 单机模式接入联机同款倒计时：不再无限时，超时按联机口径处理
 * （能放弃就放弃，必答的请求临时借 AI 答一次，连续超时自动托管）。
 *
 * `useLocalSanguosha.ts` 用到 `window.setTimeout`，这个项目的 vitest 跑在
 * `node` 环境、也没有 @vue/test-utils（另见 `sanguosha-heartbeat.test.ts`），
 * 所以纯函数（`timerKindOf`）直接跑真实断言，依赖真实定时器/响应式的那部分
 * 用源码结构断言钉住关键约束，和这个项目里同类文件的既有测试手法一致。
 */

function baseRequest(overrides: Partial<GameRequest> & Pick<GameRequest, 'kind'>): GameRequest {
  return { id: 'r1', playerId: 'p0', prompt: '', timeoutMs: 15_000, optional: true, ...overrides } as GameRequest
}

describe('timerKindOf：单机计时条的分类和联机一致', () => {
  it('选将阶段永远是 pick-general', () => {
    expect(timerKindOf('choosing-general', null)).toBe('pick-general')
    expect(timerKindOf('playing', baseRequest({ kind: 'choose-general', candidates: [], min: 1, max: 1 }))).toBe('pick-general')
  })

  it('没有请求（轮到出牌）是 action', () => {
    expect(timerKindOf('playing', null)).toBe('action')
  })

  it('求无懈可击是抢答 claim，其余响应是 response', () => {
    const guixin = baseRequest({ kind: 'respond-card', requiredCardName: '无懈可击', actionIds: [] })
    expect(timerKindOf('playing', guixin)).toBe('claim')
    const dodge = baseRequest({ kind: 'respond-card', requiredCardName: '闪', actionIds: [] })
    expect(timerKindOf('playing', dodge)).toBe('response')
    const cards = baseRequest({ kind: 'choose-cards', cardIds: [], hiddenCardSlots: [], min: 0, max: 1 })
    expect(timerKindOf('playing', cards)).toBe('response')
  })
})

describe('timeoutDefaultResponse：单机超时复用的默认答案（引擎侧，联机同一份）', () => {
  it('可以放弃的响应超时就放弃', () => {
    const request = baseRequest({ kind: 'respond-card', requiredCardName: '闪', actionIds: ['respond-pass'] })
    expect(timeoutDefaultResponse(request)).toEqual({ requestId: 'r1', playerId: 'p0', payload: { actionId: 'respond-pass' } })
  })

  it('选将超时没有默认答案，必须交给 AI 兜底', () => {
    const request = baseRequest({ kind: 'choose-general', candidates: [], min: 1, max: 1 })
    expect(timeoutDefaultResponse(request)).toBeNull()
  })
})

const source = readFileSync(new URL('../src/sanguosha/composables/useLocalSanguosha.ts', import.meta.url), 'utf8')

function block(pattern: RegExp): string {
  return source.match(pattern)?.[0] ?? ''
}

describe('useLocalSanguosha 源码结构：单机倒计时的关键约束', () => {
  it('单机托管的说明已经改成会自动开启，不再是旧的“不设空闲计时器”', () => {
    expect(source).not.toContain('不设空闲计时器')
    expect(source).toContain('连续多次操作超时也会自动开启')
  })

  it('同一次等待不会被拨回起点：换请求/换回合才重新起表', () => {
    const fn = block(/function updateTimer\(\): void \{[\s\S]*?\n {2}\}/)
    expect(fn, 'waitingKey 没变就不能重置 waitingStartedAt').toContain('if (key !== waitingKey)')
    expect(fn.indexOf('if (key !== waitingKey)')).toBeLessThan(fn.indexOf('waitingStartedAt = now'))
  })

  it('AI 座位和已托管的真人只画名义窗口，不真正强制超时', () => {
    const fn = block(/function updateTimer\(\): void \{[\s\S]*?\n {2}\}/)
    expect(fn).toMatch(/if \(ai\) return/)
  })

  it('超时默认放弃，拿不出默认答案才借 AI 答一次；不是任何时候都替他打牌', () => {
    const fn = block(/function handleHumanTimeout[\s\S]*?\n {2}\}/)
    expect(fn).toContain('timeoutDefaultResponse(slot.request)')
    expect(fn).toContain('aiModule!.decideResponse(contextFor(HUMAN_ID), slot.request)')
    expect(fn.indexOf('timeoutDefaultResponse')).toBeLessThan(fn.indexOf('aiModule!.decideResponse'))
  })

  it('连续超时到阈值自动转托管，真人自己操作会清零', () => {
    const fn = block(/function handleHumanTimeout[\s\S]*?\n {2}\}/)
    expect(fn).toContain('humanTimeoutStreak += 1')
    expect(fn).toContain('AUTO_TRUSTEE_TIMEOUTS')
    expect(source).toMatch(/function respond\(response: GameResponse\): void \{[\s\S]*?humanTimeoutStreak = 0/)
    expect(source).toMatch(/function act\(actionId: string\): void \{[\s\S]*?humanTimeoutStreak = 0/)
  })

  it('没有请求 + 自己的出牌阶段超时 = 直接结束出牌阶段，不是替他出牌', () => {
    const fn = block(/function handleHumanTimeout[\s\S]*?\n {2}\}/)
    expect(fn).toContain('current.advancePhase()')
  })
})
