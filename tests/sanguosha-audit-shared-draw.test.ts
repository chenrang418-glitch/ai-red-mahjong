import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { moveCard } from '@/sanguosha/engine/zones'

function fixture(kind: string) {
  const game = new SanguoshaGame({ seed: `audit-draw-${kind}`, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, nickname: `玩家${i}`, isHuman: true })),
  } })
  const identities = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as const
  game.state.players.forEach((p, i) => { p.characterId = 'zhangfei'; p.identity = identities[i] })
  game.start()
  game.state.phase = 'play'
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  const respond = (payload: Record<string, unknown>) => {
    const request = game.state.pendingRequests[0]!
    expect(request).toBeDefined()
    game.respond({ requestId: request.id, playerId: request.playerId, payload })
  }
  let run: () => void
  let count = 1
  let recipient = 'p0'
  let reason = kind === 'recast' ? 'recast' : '雌雄双股剑'
  if (kind === 'huishifade') {
    game.state.players[0]!.characterId = 'shenguojia'
    game.state.players[0]!.maxHp = 8
    const action = game.legalActions('p0').find(action => action.kind === 'invoke-skill' && action.skillId === 'huishifade')
    expect(action).toBeDefined()
    game.act('p0', action!.id)
    run = () => respond({ targetIds: ['p1'] })
    count = 4; recipient = 'p1'; reason = 'huishifade'
  } else {
    const name = kind === 'recast' ? '铁索连环' : '雌雄双股剑'
    const cardId = game.state.zones.drawPile.find(id => game.state.cards[id]!.name === name)!
    expect(cardId).toBeDefined()
    moveCard(game.state, cardId, { kind: 'drawPile' }, kind === 'recast'
      ? { kind: 'hand', playerId: 'p0' } : { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    if (kind === 'recast') run = () => game.act('p0', `play:recast:${cardId}`)
    else {
      game.state.players[1]!.characterId = 'huangyueying'
      const slash = game.state.zones.drawPile.find(id => game.state.cards[id]!.name === '杀')!
      moveCard(game.state, slash, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
      const action = game.legalActions('p0').find(action => action.kind === 'use-card' && action.cardIds.includes(slash) && action.targetIds[0] === 'p1')
      expect(action).toBeDefined()
      game.act('p0', action!.id)
      expect(game.state.skillResolution?.skillId).toBe('equip:cixiongjian')
      run = () => respond({ optionId: 'draw' })
    }
  }
  return { game, run, count, recipient, reason }
}

describe('审计：共享摸牌路径不绕过事件和重洗', () => {
  for (const kind of ['recast', 'huishifade', 'cixiong']) {
    it(`${kind}：真实摸牌窗口、逐牌移动和摸牌获得标识`, () => {
      const { game, run, count, recipient, reason } = fixture(kind)
      const top = game.state.zones.drawPile.slice(0, count)
      const order: string[] = []
      game.events.on('DrawAttempt', ctx => {
        expect(ctx.event.payload).toMatchObject({ playerId: recipient, count, isDraw: true })
        order.push('attempt')
      })
      game.events.on('CardZoneMoved', ctx => {
        if (top.includes(ctx.event.payload.cardId as string)) order.push('move')
      })
      game.events.on('GainCard', ctx => {
        expect(ctx.event.payload).toMatchObject({ playerId: recipient, cardIds: top, isDraw: true, reason })
        expect(ctx.event.targetId).toBe(recipient)
        expect(ctx.event.cardIds).toEqual(top)
        order.push('gain')
      })
      run()
      expect(order).toEqual(['attempt', ...Array(count).fill('move'), 'gain'])
      for (const id of top) expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toContain(id)
      assertGameInvariants(game.state)
    })
    it(`${kind}：摸牌替代挂起可保存恢复，拒绝后只结算一次`, () => {
      const fixtureResult = fixture(kind)
      let game = fixtureResult.game
      const { recipient, count, run } = fixtureResult
      game.state.players.find(p => p.id === recipient)!.grantedSkills.push('zanrun-sunhong:b61')
      const before = game.state.players.find(p => p.id === recipient)!.zones.hand.length
      run()
      expect(game.state.skillResolution?.skillId).toBe('zanrun-sunhong:b61')
      expect(game.state.drawOperationReplay).toBeDefined()
      expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toHaveLength(before - (kind === 'recast' ? 1 : 0))
      if (kind === 'huishifade') expect(game.state.players[0]!.maxHp).toBe(8)
      game = SanguoshaGame.restore(game.serialize())
      const request = game.state.pendingRequests[0]!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
      expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toHaveLength(before + count - (kind === 'recast' ? 1 : 0))
      if (kind === 'huishifade') expect(game.state.players[0]!.maxHp).toBe(6)
      expect(game.state.drawOperationReplay).toBeUndefined()
      expect(game.state.skillResolution).toBeNull()
      if (kind === 'cixiong') {
        expect(game.state.pendingRequests).toHaveLength(1)
        const dodge = game.state.pendingRequests[0]!
        expect(dodge.kind).toBe('respond-card')
        expect(dodge.playerId).toBe('p1')
        game.respond({ requestId: dodge.id, playerId: dodge.playerId, payload: { actionId: 'respond-pass' } })
      }
      expect(game.state.pendingRequests).toHaveLength(0)
      assertGameInvariants(game.state)
    })
    it(`${kind}：谮润实际取牌替代保存恢复后不重复摸牌`, () => {
      const initialized = fixture(kind)
      let game = initialized.game
      const { recipient, count, run } = initialized
      game.state.players.find(p => p.id === recipient)!.grantedSkills.push('zanrun-sunhong:b61')
      const before = game.state.players.find(p => p.id === recipient)!.zones.hand.length
      const donorBefore = game.state.players[2]!.zones.hand.length
      const pileBefore = [...game.state.zones.drawPile]
      const answer = (payload: unknown) => {
        const request = game.state.pendingRequests.at(-1)!
        game.respond({ requestId: request.id, playerId: request.playerId, payload })
      }
      run()
      answer({ optionId: 'yes' })
      answer({ targetIds: ['p2'] })
      const take = game.state.pendingRequests.at(-1)!
      expect(take.kind).toBe('choose-cards')
      if (take.kind !== 'choose-cards') throw new Error('预期取牌请求')
      expect(take.hiddenCardSlots.length).toBeGreaterThanOrEqual(count)
      answer({ cardIds: take.hiddenCardSlots.slice(0, count) })
      game = SanguoshaGame.restore(game.serialize())
      let gains = 0
      game.events.on('GainCard', ctx => {
        expect(ctx.event.payload).toMatchObject({ playerId: recipient, reason: 'zanrun-sunhong:b61' })
        expect(ctx.event.payload.isDraw).not.toBe(true)
        gains++
      })
      answer({ optionId: 'forbid' })
      expect(gains).toBe(1)
      expect(game.state.zones.drawPile).toEqual(pileBefore)
      expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toHaveLength(before + count - (kind === 'recast' ? 1 : 0))
      expect(game.state.players[2]!.zones.hand).toHaveLength(donorBefore - count)
      if (kind === 'huishifade') expect(game.state.players[0]!.maxHp).toBe(6)
      if (kind === 'cixiong') expect(game.state.pendingRequests[0]!.kind).toBe('respond-card')
      else expect(game.state.pendingRequests).toHaveLength(0)
      expect(game.state.drawOperationReplay).toBeUndefined()
      assertGameInvariants(game.state)
    })
    it(`${kind}：牌堆与弃牌堆均空不伪造摸牌事件`, () => {
      const { game, run, recipient } = fixture(kind)
      const holder = game.state.players[3]!
      for (const id of [...game.state.zones.drawPile]) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: holder.id })
      if (kind === 'recast') game.events.on('LoseCard', ctx => {
        for (const id of ctx.event.payload.cardIds as string[]) moveCard(game.state, id, { kind: 'discardPile' }, { kind: 'hand', playerId: holder.id })
      })
      const before = game.state.players.find(p => p.id === recipient)!.zones.hand.length
      let gains = 0
      game.events.on('GainCard', () => { gains++ })
      run()
      expect(gains).toBe(0)
      expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toHaveLength(before - (kind === 'recast' ? 1 : 0))
      if (kind === 'huishifade') expect(game.state.players[0]!.maxHp).toBe(6)
      assertGameInvariants(game.state)
    })
    it(`${kind}：牌堆空时从弃牌堆重洗`, () => {
      const { game, run, count, recipient } = fixture(kind)
      for (const id of [...game.state.zones.drawPile]) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'discardPile' })
      const before = game.state.players.find(p => p.id === recipient)!.zones.hand.length
      let shuffles = 0
      game.events.on('DeckReshuffled', () => { shuffles++ })
      run()
      expect(shuffles).toBe(1)
      expect(game.state.players.find(p => p.id === recipient)!.zones.hand).toHaveLength(before + count - (kind === 'recast' ? 1 : 0))
      assertGameInvariants(game.state)
    })
  }
})
