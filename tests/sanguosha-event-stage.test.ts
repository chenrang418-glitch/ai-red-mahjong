import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useSgsEventStage } from '@/sanguosha/composables/useSgsEventStage'
import type { PresentationEvent, PresentationEventKind } from '@/sanguosha/engine/presentation'

/**
 * 表现事件播放队列。
 *
 * 这些用例对应实测出来的两个缺陷：近半数推进不产生事件（旧实现让箭头一直挂着），
 * 以及成批到达时首条被吞（`damage → dying` 时伤害数字看不到）。
 */

let seq = 0
function event(kind: PresentationEventKind, extra: Partial<PresentationEvent> = {}): PresentationEvent {
  seq += 1
  return { id: `e${seq}`, seq, kind, text: `${kind} ${seq}`, ...extra }
}

beforeEach(() => { seq = 0; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('事件有寿命', () => {
  it('播完自动清空，不会一直挂在舞台上', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)

    events.value = [...events.value, event('card-use', { cardName: '杀' })]
    expect(staged.value?.event.cardName).toBe('杀')

    // 后面近半数推进不产生事件，旧实现里箭头就是在这段时间赖着不走
    vi.advanceTimersByTime(2000)
    expect(staged.value, '事件播完必须清空').toBeNull()
  })

  it('重要事件停留得比流水账久', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)

    events.value = [event('draw')]
    vi.advanceTimersByTime(400)
    expect(staged.value, '摸牌是流水账，很快就该让位').toBeNull()

    events.value = [...events.value, event('death')]
    vi.advanceTimersByTime(400)
    expect(staged.value?.event.kind, '阵亡要留得住').toBe('death')
  })
})

describe('成批到达时逐条播放', () => {
  it('damage → dying：伤害数字不再被吞掉', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)
    events.value = [event('turn-start')]
    vi.advanceTimersByTime(500)

    // 一次推进同时产生两条，这是实测抓到的真实序列
    events.value = [...events.value, event('damage', { amount: 2 }), event('dying')]
    expect(staged.value?.event.kind, '先播伤害').toBe('damage')
    vi.advanceTimersByTime(950)
    expect(staged.value?.event.kind, '再播濒死').toBe('dying')
  })

  it('积压太多时丢流水账，但绝不丢伤害和死亡', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)
    events.value = [event('turn-start')]
    vi.advanceTimersByTime(500)

    const flood = [
      event('draw'), event('equipment'), event('draw'), event('discard'),
      event('damage', { amount: 1 }), event('death'),
    ]
    events.value = [...events.value, ...flood]

    // 按 id 去重：采样间隔比单条时长短，同一条会被采到好几次
    const played = new Map<string, PresentationEventKind>()
    for (let tick = 0; tick < 30; tick += 1) {
      if (staged.value) played.set(staged.value.event.id, staged.value.event.kind)
      vi.advanceTimersByTime(200)
    }
    const kinds = [...played.values()]
    expect(kinds, '伤害必须播出').toContain('damage')
    expect(kinds, '阵亡必须播出').toContain('death')
    expect(kinds.filter((kind) => kind === 'draw').length, '两条摸牌至少压掉一条').toBeLessThan(2)
    expect(played.size, '积压总量要收在上限内').toBeLessThanOrEqual(4)
  })
})

describe('不回放历史', () => {
  it('首次拿到整段历史只显示最后一条', () => {
    // 联机重连时服务端会一次性给回最近 30 条，全部重放等于把过去几分钟重演一遍
    const history = Array.from({ length: 12 }, () => event('card-use', { cardName: '杀' }))
    const events = ref<PresentationEvent[]>(history)
    const { staged } = useSgsEventStage(() => events.value)

    expect(staged.value?.event.id).toBe(history[history.length - 1].id)
    vi.advanceTimersByTime(700)
    expect(staged.value, '只播这一条，不接着回放前面的').toBeNull()
  })

  it('旧事件被上限截掉后不会整段重放', () => {
    const events = ref<PresentationEvent[]>([event('turn-start')])
    const { staged } = useSgsEventStage(() => events.value)
    vi.advanceTimersByTime(500)

    // 服务端截断：先前记住的那条已经不在数组里了
    events.value = Array.from({ length: 20 }, () => event('draw'))
    const played: string[] = []
    for (let tick = 0; tick < 40; tick += 1) {
      if (staged.value) played.push(staged.value.event.id)
      vi.advanceTimersByTime(200)
    }
    expect(new Set(played).size, '最多补播末尾一小段').toBeLessThanOrEqual(4)
  })
})

describe('跳过', () => {
  it('轮到自己操作时立刻跳到最后一条，动画不挡操作', () => {
    const events = ref<PresentationEvent[]>([event('turn-start')])
    const { staged, skip } = useSgsEventStage(() => events.value)
    vi.advanceTimersByTime(500)

    const slash = event('card-use', { cardName: '杀', targetIds: ['p0'] })
    events.value = [...events.value, event('draw'), event('equipment'), slash]
    skip()
    // 留下的正是玩家要响应的那张【杀】，而不是清成空白
    expect(staged.value?.event.id).toBe(slash.id)
  })
})

describe('皮肤', () => {
  it('按事件挑皮肤', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)
    const push = (next: PresentationEvent) => { events.value = [...events.value, next] }

    push(event('card-response', { cardName: '闪' }))
    expect(staged.value?.skin).toBe('dodge')
    vi.advanceTimersByTime(700)

    push(event('judge', { cardName: '桃' }))
    expect(staged.value?.skin).toBe('judge')
    vi.advanceTimersByTime(900)

    push(event('damage', { amount: 1 }))
    expect(staged.value?.skin).toBe('strike')
    vi.advanceTimersByTime(950)

    push(event('recover', { amount: 1 }))
    expect(staged.value?.skin).toBe('heal')
  })

  it('无懈连锁能数出打到第几环', () => {
    const events = ref<PresentationEvent[]>([])
    const { staged } = useSgsEventStage(() => events.value)
    const nullify = () => event('card-use', { cardName: '无懈可击' })

    events.value = [nullify()]
    expect(staged.value).toMatchObject({ skin: 'nullify', chainDepth: 1 })
    events.value = [...events.value, nullify()]
    vi.advanceTimersByTime(700)
    expect(staged.value).toMatchObject({ skin: 'nullify', chainDepth: 2 })
    events.value = [...events.value, nullify()]
    vi.advanceTimersByTime(700)
    expect(staged.value?.chainDepth).toBe(3)

    // 连锁断了要归零，否则下一次无懈会接着上一串的计数
    events.value = [...events.value, event('damage', { amount: 1 })]
    vi.advanceTimersByTime(700)
    expect(staged.value?.chainDepth).toBe(0)
  })
})
