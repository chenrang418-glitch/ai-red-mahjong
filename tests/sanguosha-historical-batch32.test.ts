import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import type { SkillHost } from '@/sanguosha/engine/skills/runtime'
import { beginSlashResponseDiscardPayment, resolveSlashResponseDiscardPayment } from '@/sanguosha/engine/cards/basic'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

const batch32 = [
  ['wuke', ['anda-b34', 'zhuguo-b34']],
  ['liuzhang-yinghu', ['jutu-b34', 'yaohu-b34', 'huaibi-b34']],
  ['liucheng-mou', ['lueying-mou-b34', 'yingwu-mou-b34']],
  ['simazhao-sp', ['daigong-sp-b34', 'zhaoxin-sp-b34']],
  ['yuanshao-mou', ['luanji-mou-b34', 'xueyi-mou-b34']],
  ['taishici-shi', ['hanzhan-shi-b34', 'zhanlie-shi-b34', 'zhenfeng-shi-b34']],
  ['sunchen-shi', ['nigu-shi-b34', 'lulian-shi-b34', 'chengshi-shi-b34']],
  ['gongsunzan-mou', ['yicong-mou-b34', 'qiaomeng-mou-b34']],
  ['pangxi', ['xuye-pangxi-b34', 'kuangxiang-pangxi-b34']],
  ['huangzu-shi', ['chizhang-shi-b34', 'duanyang-shi-b34']],
] as const

describe('武将册第34批注册与关键规则', () => {
  it('10名武将及各自技能运行时均已注册，且没有重复人物ID', () => {
    expect(batch32).toHaveLength(10)
    for (const [id, skills] of batch32) {
      expect(getCharacter(id), id).toBeDefined()
      expect(skillIdsOf(id)).toEqual(skills)
      for (const skillId of skills) expect(getSkillRuntime(skillId), `${id}:${skillId}`).toBeDefined()
    }
    expect(ALL_CHARACTERS.filter(character => batch32.some(([id]) => id === character.id))).toHaveLength(10)
    expect(new Set(ALL_CHARACTERS.map(character => character.id)).size).toBe(ALL_CHARACTERS.length)
  })

  it('势·黄祖弃置的颜色会禁止所有同色响应牌，而非只禁止闪或无懈', () => {
    const runtime = getSkillRuntime('chizhang-shi-b34')!
    const state = {
      cardResolution: { cardId: 'trick', sourceId: 'huangzu' },
      b34: { 'shi-huangzu-color-lock:trick': { colors: ['red'], ownerId: 'huangzu' } },
      cards: {
        redResponse: { id: 'redResponse', suit: 'heart', color: 'red' },
        blackResponse: { id: 'blackResponse', suit: 'spade', color: 'black' },
      },
      cardAliases: {}, cardSuitOverrides: {},
      players: [{ id: 'responder', alive: true, zones: { hand: [], equipment: {} } }],
    } as any
    expect(runtime.prohibitsResponseCard?.(state, 'huangzu', 'responder', 'redResponse', '桃')).toBe(true)
    expect(runtime.prohibitsResponseCard?.(state, 'huangzu', 'responder', 'blackResponse', '闪')).toBe(false)
    expect(runtime.triggers?.some(trigger => trigger.event === 'AfterCardUse')).toBe(true)
  })

  it('庞羲【匡襄】仅在出牌阶段且存在手牌数不高于自己的角色时可发动', () => {
    const runtime = getSkillRuntime('kuangxiang-pangxi-b34')!
    const state = {
      phase: 'play', currentPlayerId: 'pangxi', turnNumber: 1,
      players: [
        { id: 'pangxi', alive: true, zones: { hand: ['a', 'b'], equipment: {} }, turnUsedSkills: [] },
        { id: 'lower', alive: true, zones: { hand: ['c'], equipment: {} }, turnUsedSkills: [] },
      ],
    } as any
    expect(runtime.activeActions?.(state, 'pangxi')).toEqual([{ id: 'kuangxiang-pangxi-b34', label: '匡襄：交换手牌' }])
    state.phase = 'draw'
    expect(runtime.activeActions?.(state, 'pangxi')).toEqual([])
  })

  it('庞羲交换后，失去全部交换所得手牌会排入一次独立的“蓄业”选择', () => {
    const state = {
      phase: 'play', currentPlayerId: 'pangxi', turnNumber: 3,
      cardAliases: {}, players: [
        { id: 'pangxi', alive: true, zones: { hand: ['a', 'b'], equipment: {}, judgingArea: [] }, turnUsedSkills: [], marks: {}, characterPiles: {} },
        { id: 'target', alive: true, zones: { hand: ['c'], equipment: {}, judgingArea: [] }, turnUsedSkills: [], marks: {}, characterPiles: {} },
      ],
    } as any
    const queued: any[] = []
    const requests: any[] = []
    const host = {
      state,
      rng: { pick: (items: any[]) => items[0] },
      dispatch: () => ({ cancelled: false }),
      queueSkill: (prompt: any) => queued.push(prompt),
      askSkill: (request: any) => requests.push(request),
    } as any as SkillHost
    const runtime = getSkillRuntime('kuangxiang-pangxi-b34')!
    runtime.resume?.(host, 'pangxi', { step: 'target', data: {} } as any, { payload: { targetIds: ['target'] } } as any)
    expect(state.players[0].zones.hand).toEqual(['c'])
    expect(state.players[1].zones.hand).toEqual(['a', 'b'])
    state.players[0].zones.hand = []
    const loseCard = runtime.triggers?.find(trigger => trigger.event === 'LoseCard')!
    loseCard.handle(host, 'pangxi', { event: { payload: { playerId: 'pangxi', cardIds: ['c'] } } } as any)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ skillId: 'xuye-pangxi-b34', step: 'grant-invoke' })
    const xuye = getSkillRuntime('xuye-pangxi-b34')!
    xuye.startQueued?.(host, 'pangxi', queued[0])
    expect(requests[0].skillId).toBe('xuye-pangxi-b34')
    expect(requests[0].build('req')).toMatchObject({ kind: 'choose-option', playerId: 'pangxi' })
  })

  it('黄祖响应打出的手牌【杀】落入弃牌堆后才可被【断鞅】取走', () => {
    const state = {
      phase: 'play', turnNumber: 5, zones: { discardPile: ['kill'], drawPile: [], processingArea: [] },
      cards: { kill: { id: 'kill', name: '杀', suit: 'spade', color: 'black', category: 'basic' } }, cardAliases: {}, cardNatures: {},
      players: [{ id: 'huangzu', alive: true, zones: { hand: [], equipment: {}, judgingArea: [] }, turnUsedSkills: [], characterPiles: {} }],
    } as any
    const queued: any[] = []
    const requests: any[] = []
    const host = {
      state, rng: { pick: (items: any[]) => items[0] }, dispatch: () => ({ cancelled: false }),
      queueSkill: (prompt: any) => queued.push(prompt), askSkill: (request: any) => requests.push(request),
    } as any as SkillHost
    const runtime = getSkillRuntime('duanyang-shi-b34')!
    runtime.triggers?.find(trigger => trigger.event === 'CardEnteredDiscard')!.handle(host, 'huangzu', {
      event: { payload: { playerId: 'huangzu', cardId: 'kill', fromKind: 'hand' } },
    } as any)
    expect(queued).toHaveLength(1)
    runtime.startQueued?.(host, 'huangzu', queued[0])
    expect(requests[0].build('req')).toMatchObject({ kind: 'choose-option', playerId: 'huangzu' })
    runtime.resume?.(host, 'huangzu', { step: 'take-kill', data: queued[0].data } as any, { payload: { optionId: 'yes' } } as any)
    expect(state.zones.discardPile).toEqual([])
    expect(state.players[0].characterPiles.duanyang).toEqual(['kill'])
    expect(state.players[0].turnUsedSkills).toContain('duanyang-shi-b34')
  })

  it('战烈的响应税在选择响应后强制选择并弃置另一张牌，之后才恢复原响应', () => {
    const originalRequest: any = {
      id: 'slash-response', kind: 'respond-card', playerId: 'target', prompt: '请响应', timeoutMs: 1000,
      optional: true, actionIds: ['respond-dodge:dodge', 'respond-pass'], requiredCardName: '闪',
    }
    const state = {
      seq: 9, decisions: [], pendingRequests: [originalRequest], cardAliases: {}, cardNatures: {},
      zones: { drawPile: [], discardPile: [], processingArea: [] },
      cards: {
        dodge: { id: 'dodge', name: '闪', suit: 'heart', color: 'red', category: 'basic' },
        cost: { id: 'cost', name: '杀', suit: 'spade', color: 'black', category: 'basic' },
      },
      players: [{ id: 'target', alive: true, zones: { hand: ['dodge', 'cost'], equipment: {}, judgingArea: [] }, marks: {}, characterPiles: {} }],
      cardResolution: {
        kind: 'slash', targetId: 'target', sourceId: 'source', requestId: originalRequest.id,
        responseDiscardCostTargetIds: ['target'], responsePaymentAuthorized: null,
      },
    } as any
    const host = { state, dispatch: () => ({ cancelled: false }) } as any
    const initialResponse = { requestId: originalRequest.id, playerId: 'target', payload: { actionId: 'respond-dodge:dodge' } }
    expect(beginSlashResponseDiscardPayment(host, originalRequest, initialResponse)).toBe(true)
    const paymentRequest: any = state.pendingRequests[0]
    expect(paymentRequest).toMatchObject({ kind: 'choose-cards', min: 1, max: 1, cardIds: ['cost'] })
    const resumed = resolveSlashResponseDiscardPayment(host, paymentRequest, {
      requestId: paymentRequest.id, playerId: 'target', payload: { cardIds: ['cost'] },
    })
    expect(state.zones.discardPile).toEqual(['cost'])
    expect(state.players[0].zones.hand).toEqual(['dodge'])
    expect(resumed).toEqual(initialResponse)
    expect(beginSlashResponseDiscardPayment(host, originalRequest, resumed)).toBe(false)
    expect(state.cardResolution.responsePaymentAuthorized).toBeNull()
  })

  it('响应成本可经真实对局请求挂起、序列化状态恢复并完整结算', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'batch32-response-tax', setup })
    const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
    game.state.players.forEach((player, index) => {
      player.identity = identities[index]
      player.characterId = 'zhangfei'
    })
    game.start()
    while (game.state.pendingRequests.length) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no', actionId: 'respond-pass' } })
    }
    while (game.state.phase !== 'play') game.advancePhase()
    game.state.currentPlayerId = 'p0'
    const target = game.state.players.find(candidate => candidate.id === 'p1')!
    for (const cardId of [...target.zones.hand]) moveCard(game.state, cardId, { kind: 'hand', playerId: 'p1' }, { kind: 'discardPile' })
    const dodge = game.state.zones.drawPile.find(cardId => game.state.cards[cardId].name === '闪')!
    const payment = game.state.zones.drawPile.find(cardId => cardId !== dodge && game.state.cards[cardId].name === '杀')!
    moveCard(game.state, dodge, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    moveCard(game.state, payment, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    expect(game.beginVirtualSlash({ sourceId: 'p0', targetId: 'p1', sourceSkillId: 'test-response-cost', responseDiscardCostTargetIds: ['p1'] })).toBe(true)
    const slashRequest = game.state.pendingRequests.find(request => request.kind === 'respond-card')!
    game.respond({ requestId: slashRequest.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    const costRequest = game.state.pendingRequests.find(request => request.kind === 'choose-cards')
    expect(costRequest?.kind === 'choose-cards' && costRequest.responsePayment).toBeTruthy()
    const serialized = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const restoredRequest = serialized.state.pendingRequests.find(request => request.kind === 'choose-cards')!
    serialized.respond({ requestId: restoredRequest.id, playerId: 'p1', payload: { cardIds: [payment] } })
    expect(serialized.state.cardResolution).toBeNull()
    expect(serialized.state.zones.discardPile).toEqual(expect.arrayContaining([dodge, payment]))
    expect(serialized.state.players.find(player => player.id === 'p1')!.zones.hand).not.toContain(payment)
    expect(assertGameInvariants(serialized.state)).toBeUndefined()
  })
})
