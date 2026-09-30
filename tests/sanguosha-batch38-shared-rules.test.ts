import { describe, expect, it } from 'vitest'
import { beginSlashResponseDiscardPayment } from '@/sanguosha/engine/cards/basic'

describe('界马超铁骑的花色响应代价公共规则', () => {
  it('只提供与判定花色相同的额外弃牌，响应牌自身不能充当代价', () => {
    const request: any = {
      id: 'slash-response', kind: 'respond-card', playerId: 'target', prompt: '请响应【杀】',
      timeoutMs: 1000, optional: true, actionIds: ['respond-dodge:dodge', 'respond-pass'], requiredCardName: '闪',
    }
    const state: any = {
      seq: 9, decisions: [], pendingRequests: [request], cardAliases: {}, cardNatures: {},
      zones: { drawPile: [], discardPile: [], processingArea: [] },
      cards: {
        dodge: { id: 'dodge', name: '闪', suit: 'spade', color: 'black', category: 'basic' },
        same: { id: 'same', name: '杀', suit: 'spade', color: 'black', category: 'basic' },
        other: { id: 'other', name: '杀', suit: 'club', color: 'black', category: 'basic' },
      },
      players: [{ id: 'target', characterId: 'zhangfei', alive: true,
        zones: { hand: ['dodge', 'same', 'other'], equipment: {}, judgingArea: [] }, marks: {}, characterPiles: {} }],
      cardResolution: {
        kind: 'slash', targetId: 'target', sourceId: 'source', requestId: request.id,
        responseDiscardCostTargetIds: [], responseDiscardCostRequirements: [{ targetId: 'target', suit: 'spade' }], responsePaymentAuthorized: null,
      },
    }
    const host: any = { state, dispatch: () => ({ cancelled: false }) }
    expect(beginSlashResponseDiscardPayment(host, request, {
      requestId: request.id, playerId: 'target', payload: { actionId: 'respond-dodge:dodge' },
    } as any)).toBe(true)
    expect(state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', cardIds: ['same'] })
  })
})
