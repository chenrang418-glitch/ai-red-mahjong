import { describe, expect, it } from 'vitest'
import { requestLabel, validateResponse, type GameRequest } from '@/sanguosha/engine/requests'

const base = { id: 'r1', playerId: 'p0', prompt: '请选择', timeoutMs: 30_000, optional: false }

describe('统一 Request 系统', () => {
  it('所有第一版 Request kind 都有穷尽标签处理', () => {
    const requests: GameRequest[] = [
      { ...base, kind: 'choose-general', candidates: ['liubei'], min: 1, max: 1 },
      { ...base, kind: 'choose-cards', cardIds: ['c1'], hiddenCardSlots: [], min: 1, max: 1 },
      { ...base, kind: 'choose-targets', candidateIds: ['p1'], min: 1, max: 1 },
      { ...base, kind: 'choose-option', options: [{ id: 'yes', label: '是' }] },
      { ...base, kind: 'choose-suit', suits: ['heart'] },
      { ...base, kind: 'choose-number', min: 1, max: 13 },
      { ...base, kind: 'use-card', actionIds: ['a1'] },
      { ...base, kind: 'respond-card', actionIds: ['a1'], requiredCardName: '闪' },
      { ...base, kind: 'invoke-skill', skillId: 'rende', actionIds: ['a1'] },
      { ...base, kind: 'arrange-cards', cardIds: ['c1'], minTop: 0, maxTop: 1, allowBottom: true },
      { ...base, kind: 'distribute-cards', cardIds: ['c1'], recipientIds: ['p1'], min: 1, max: 1 },
      { ...base, kind: 'rescue', dyingPlayerId: 'p1', actionIds: ['a1'], requiredRecover: 1 },
    ]
    expect(requests.map(requestLabel)).toHaveLength(12)
    expect(new Set(requests.map(requestLabel)).size).toBe(12)
  })

  it('验证合法 actionId 并拒绝伪造响应', () => {
    const request: GameRequest = { ...base, kind: 'respond-card', actionIds: ['respond-shan'], requiredCardName: '闪' }
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { actionId: 'respond-shan' } })).toBeNull()
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { actionId: 'forged' } })).toContain('actionId')
    expect(validateResponse(request, { requestId: 'stale', playerId: 'p0', payload: { actionId: 'respond-shan' } })).toContain('requestId')
  })

  it('未知手牌槽可选但不需要暴露真实 cardId', () => {
    const request: GameRequest = { ...base, kind: 'choose-cards', cardIds: [], hiddenCardSlots: ['hidden-0', 'hidden-1'], min: 1, max: 1 }
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { cardIds: ['hidden-1'] } })).toBeNull()
  })

  it('拒绝用重复 cardId 冒充选择多张牌', () => {
    const request: GameRequest = { ...base, kind: 'choose-cards', cardIds: ['c1', 'c2'], hiddenCardSlots: [], min: 2, max: 2 }
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { cardIds: ['c1', 'c1'] } })).toContain('非法')
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { cardIds: ['c1', 'c2'] } })).toBeNull()
  })

  it('拒绝用重复 targetId 冒充选择多名角色', () => {
    const request: GameRequest = { ...base, kind: 'choose-targets', candidateIds: ['p1', 'p2'], min: 2, max: 2 }
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { targetIds: ['p1', 'p1'] } })).toContain('非法')
    expect(validateResponse(request, { requestId: 'r1', playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })).toBeNull()
  })
})
