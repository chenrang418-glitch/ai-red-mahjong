import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateResponse } from '@/sanguosha/engine/requests'
import { timeoutDefaultResponse } from '@/sanguosha/engine/timeout-default'
import type { ArrangeOptionsRequest } from '@/sanguosha/engine/requests'

/**
 * 「一次给出完整顺序」的请求。
 *
 * 神华佗【五灵】要定五种灵的排列，神鲁肃【榻谟】要定座次。
 * 做成「连问 N 次单选」是可以的，但体验差一截：玩家点第三个时已经看不到
 * 前两个是什么，改主意只能等超时；联机时每一步还各要一个网络往返。
 * 所以是一次请求、边点边看、可撤销。
 *
 * 这里测的是**契约**：什么样的回应算合法。界面按钮的逐个点击不在这里测——
 * 那需要把一整局真的打到某个特定阶段，那种 e2e 天然不稳定。
 */

function request(overrides: Partial<ArrangeOptionsRequest> = {}): ArrangeOptionsRequest {
  return {
    id: 'r1', kind: 'arrange-options', playerId: 'p0',
    prompt: '排个顺序', timeoutMs: 30_000, optional: false,
    options: [
      { id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'c', label: '丙' },
    ],
    ...overrides,
  }
}

const respond = (optionIds: unknown) => ({ requestId: 'r1', playerId: 'p0', payload: { optionIds } })

describe('排列请求的契约', () => {
  it('必须是全排列：每一项恰好出现一次', () => {
    expect(validateResponse(request(), respond(['a', 'b', 'c']))).toBeNull()
    expect(validateResponse(request(), respond(['c', 'a', 'b'])), '顺序随意，但必须齐全').toBeNull()
  })

  it('重复、遗漏、混入陌生项一律拒绝', () => {
    /*
     * 少一项就意味着后面读这条顺序的代码要处理一个残缺的排列，
     * 那种残缺会一路带进游戏状态里——五灵会少一种灵，座次会少一个人。
     */
    expect(validateResponse(request(), respond(['a', 'a', 'b']))).toBe('排列结果非法')
    expect(validateResponse(request(), respond(['a', 'b']))).toBe('排列结果非法')
    expect(validateResponse(request(), respond(['a', 'b', 'x']))).toBe('排列结果非法')
    expect(validateResponse(request(), respond('abc'))).toBe('排列格式错误')
    expect(validateResponse(request(), respond([1, 2, 3]))).toBe('排列格式错误')
  })

  it('必答的排列不接受交白卷', () => {
    expect(validateResponse(request(), respond([]))).toBe('排列结果非法')
  })

  it('「可以」发动的排列允许交白卷表示放弃', () => {
    // 榻谟是「你可以重新安排座次」，不想重排就得能放弃
    expect(validateResponse(request({ optional: true }), respond([]))).toBeNull()
    // 但给了就得给全，不能给一半
    expect(validateResponse(request({ optional: true }), respond(['a']))).toBe('排列结果非法')
  })

  it('超时：可选的按放弃处理，必答的交给 AI', () => {
    expect(timeoutDefaultResponse(request({ optional: true }))?.payload).toEqual({ optionIds: [] })
    expect(timeoutDefaultResponse(request()), '必答的没有默认答案').toBeNull()
  })
})

describe('排列界面', () => {
  const source = readFileSync(new URL('../src/sanguosha/components/SgsRequestDock.vue', import.meta.url), 'utf8')

  it('排满之前不允许确定，否则会提交一个残缺的排列', () => {
    expect(source).toContain("orderPicked.length !== request.options.length")
  })

  it('提供撤销：点错一步不该只能等超时', () => {
    expect(source).toContain('undoOrder')
  })

  it('换一条请求时清空已选，不能把上一次的顺序带过来', () => {
    expect(source).toMatch(/watch\(\(\) => props\.request\.id[\s\S]{0,80}orderPicked\.value = \[\]/)
  })

  it('可选的排列才显示跳过', () => {
    expect(source).toMatch(/v-if="request\.optional"[\s\S]{0,120}跳过/)
  })
})
