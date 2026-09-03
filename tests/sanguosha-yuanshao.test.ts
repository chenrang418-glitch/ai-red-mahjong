import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import {
  LUANJI, XUEYI, canLuanji, validateLuanjiCards, xueyiBonus,
} from '@/sanguosha/data/characters/fire-yuanshao'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 火包·袁绍（经典版本，不是界限突破）。
 *
 * 三处最容易做错的地方单独钉住：
 * 1. 【乱击】**不复制万箭**——目标、无懈、求闪、伤害全部走现有管线；
 * 2. 两张底牌都要真的花出去，虚拟牌不能变成弃牌堆里的第三张牌；
 * 3. 【血裔】是主公技且**动态计算**，群雄阵亡后上限立刻跟着降。
 */

function gameWith(options: { yuanshaoIdentity?: Identity; characters?: string[]; seed?: string } = {}): SanguoshaGame {
  const list = options.characters ?? ['yuanshao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: list.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed: options.seed ?? 'yuanshao', setup })
  const rest: Identity[] = ['loyalist', 'rebel', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.characterId = list[index]
    if (index === 0) player.identity = options.yuanshaoIdentity ?? 'lord'
    else player.identity = index === 1 && (options.yuanshaoIdentity ?? 'lord') !== 'lord' ? 'lord' : rest[(index - 1) % rest.length]
    const base = getCharacter(list[index])?.maxHp ?? 4
    player.maxHp = base + (player.identity === 'lord' ? 1 : 0)
    player.hp = player.maxHp
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function answer(game: SanguoshaGame, payload: Record<string, unknown>): void {
  const request = pending(game)
  if (!request) throw new Error('没有待处理请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** 给某人一张指定花色的牌。 */
function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: Suit, exclude: string[] = []): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit && !exclude.includes(id))
  if (!cardId) throw new Error(`牌堆里没有 ${suit} 的牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)!
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function luanjiAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${LUANJI}`)
}

/** 发动乱击并交出两张牌，停在万箭的第一个询问上。 */
function fireLuanji(game: SanguoshaGame, cardIds: string[]): void {
  game.act('p0', luanjiAction(game)!.id)
  answer(game, { cardIds })
}

/** 把所有还挂着的响应请求一路放弃掉。 */
function passAll(game: SanguoshaGame, limit = 40): void {
  for (let guard = 0; guard < limit; guard += 1) {
    const request = pending(game)
    if (!request) return
    if (request.kind === 'respond-card') answer(game, { actionId: 'respond-pass' })
    else if (request.kind === 'rescue') answer(game, { actionId: 'rescue-pass' })
    else return
  }
}

describe('袁绍的基础信息', () => {
  it('群势力、4 体力、火包、两个技能', () => {
    const character = getCharacter('yuanshao')!
    expect(character.kingdom).toBe('qun')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('fire')
    expect(character.skills.map((skill) => skill.id)).toEqual([LUANJI, XUEYI])
  })
})

describe('乱击的合法性', () => {
  it('两张同花色合法（测试 1）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    expect(validateLuanjiCards(game.state, 'p0', [first, second])).toBeNull()
    expect(canLuanji(game.state, 'p0')).toBe(true)
    expect(luanjiAction(game)).toBeTruthy()
  })

  it('不同花色非法（测试 2）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const spade = giveSuit(game, 'p0', 'spade')
    const heart = giveSuit(game, 'p0', 'heart')
    expect(validateLuanjiCards(game.state, 'p0', [spade, heart])).toContain('花色')
    expect(canLuanji(game.state, 'p0'), '手上凑不出同花色就不给动作').toBe(false)
    expect(luanjiAction(game)).toBeUndefined()
  })

  it('同一张牌提交两次非法（测试 3）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const card = giveSuit(game, 'p0', 'spade')
    giveSuit(game, 'p0', 'spade', [card])
    expect(validateLuanjiCards(game.state, 'p0', [card, card])).toContain('不同的牌')
  })

  it('装备区的牌非法（测试 4）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const hand = giveSuit(game, 'p0', 'spade')
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'weapon'
      && game.state.cards[id].suit === 'spade')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    expect(validateLuanjiCards(game.state, 'p0', [hand, weapon])).toContain('手牌')
  })

  it('别人的手牌非法', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const mine = giveSuit(game, 'p0', 'spade')
    const theirs = game.state.players[1].zones.hand[0]
    expect(validateLuanjiCards(game.state, 'p0', [mine, theirs])).toContain('手牌')
  })

  it('只有一张牌不能发动（测试 5）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    giveSuit(game, 'p0', 'spade')
    expect(canLuanji(game.state, 'p0')).toBe(false)
    expect(luanjiAction(game)).toBeUndefined()
  })

  it('张数不对一律拒绝', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    expect(validateLuanjiCards(game.state, 'p0', [first])).toContain('两张')
    expect(validateLuanjiCards(game.state, 'p0', [first, second, first])).toContain('两张')
  })

  it('经典乱击没有次数限制，同一个出牌阶段可以再来（测试 25 相关）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const cards = [0, 1, 2, 3].map((index) => giveSuit(game, 'p0', 'spade', []))
      .filter((id, index, all) => all.indexOf(id) === index)
    fireLuanji(game, cards.slice(0, 2))
    passAll(game)
    expect(luanjiAction(game), '没有每阶段限一次这一条').toBeTruthy()
  })
})

describe('乱击结算', () => {
  it('走的是真正的万箭齐发：全体其他角色各要一张闪（测试 7 / 8 / 10）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    fireLuanji(game, [first, second])

    // 先走完无懈轮询
    let guard = 0
    while (pending(game)?.kind === 'respond-card'
      && (pending(game) as { requiredCardName: string }).requiredCardName === '无懈可击') {
      if (guard++ > 20) throw new Error('无懈轮询没有收敛')
      answer(game, { actionId: 'respond-pass' })
    }
    const request = pending(game)
    expect(request?.kind).toBe('respond-card')
    expect(request?.kind === 'respond-card' && request.requiredCardName, '万箭要闪').toBe('闪')
    expect(request?.playerId, '目标是其他角色，不含袁绍自己').not.toBe('p0')
    expect(game.state.cardResolution?.kind).toBe('trick')
    expect(game.state.cardResolution?.kind === 'trick' && game.state.cardResolution.cardName).toBe('万箭齐发')
  })

  it('两张底牌都真的花出去，弃牌堆里没有第三张虚拟牌（测试 6 / 41）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    const discardBefore = game.state.zones.discardPile.length

    fireLuanji(game, [first, second])
    passAll(game)

    expect(game.state.players[0].zones.hand, '两张都不在手上了').toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(first)
    expect(game.state.zones.discardPile).toContain(second)
    expect(game.state.zones.discardPile.length, '只多了这两张真牌')
      .toBe(discardBefore + 2)
    expect(game.state.zones.processingArea, '处理区清干净了').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('目标出闪就不受伤，不出就掉血且来源是袁绍（测试 11 / 12）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    clearHand(game, 'p1')
    const dodge = giveNamed(game, 'p1', '闪')
    const damages: Array<{ sourceId?: string; targetId?: string }> = []
    game.events.on('Damaged', (context) => {
      damages.push({ sourceId: context.event.sourceId, targetId: context.event.targetId })
    })

    fireLuanji(game, [first, second])
    let guard = 0
    while (pending(game)) {
      if (guard++ > 40) throw new Error('万箭没有收敛')
      const request = pending(game)!
      // 万箭的求闪走锦囊效果那条路，动作 id 是 respond-trick 而不是 respond-dodge
      if (request.kind === 'respond-card' && request.playerId === 'p1'
        && request.actionIds.includes(`respond-trick:${dodge}`)) {
        answer(game, { actionId: `respond-trick:${dodge}` })
        continue
      }
      if (request.kind === 'respond-card') { answer(game, { actionId: 'respond-pass' }); continue }
      if (request.kind === 'rescue') { answer(game, { actionId: 'rescue-pass' }); continue }
      break
    }

    expect(damages.some((entry) => entry.targetId === 'p1'), '出了闪就不该受伤').toBe(false)
    expect(damages.length, '其余三人都挨了一下').toBeGreaterThan(0)
    for (const entry of damages) expect(entry.sourceId, '伤害来源是袁绍').toBe('p0')
    assertCardConservation(game.state)
  })

  it('被无懈掉时底牌照样进弃牌堆，不退回手上（测试 13 / 22）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    clearHand(game, 'p1')
    const wuxie = giveNamed(game, 'p1', '无懈可击')

    fireLuanji(game, [first, second])
    let used = false
    let guard = 0
    while (pending(game)) {
      if (guard++ > 40) throw new Error('万箭没有收敛')
      const request = pending(game)!
      if (!used && request.kind === 'respond-card' && request.actionIds.includes(`respond-nullification:${wuxie}`)) {
        used = true
        answer(game, { actionId: `respond-nullification:${wuxie}` })
        continue
      }
      if (request.kind === 'respond-card') { answer(game, { actionId: 'respond-pass' }); continue }
      if (request.kind === 'rescue') { answer(game, { actionId: 'rescue-pass' }); continue }
      break
    }

    expect(used, '无懈确实用出去了').toBe(true)
    expect(game.state.players[0].zones.hand, '底牌不退回手上').toHaveLength(0)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([first, second, wuxie]))
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('过一遍 JSON 之后万箭能接着结算（测试 24）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    fireLuanji(game, [first, second])

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.cardResolution?.kind === 'trick'
      && restored.state.cardResolution.extraCardIds, '陪跑的底牌记住了').toContain(second)
    passAll(restored)
    expect(restored.state.zones.discardPile).toEqual(expect.arrayContaining([first, second]))
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })

  it('选牌那一步放弃则什么都不发生（测试 9 相关）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const first = giveSuit(game, 'p0', 'spade')
    const second = giveSuit(game, 'p0', 'spade', [first])
    game.act('p0', luanjiAction(game)!.id)
    answer(game, { cardIds: [] })

    expect(game.state.players[0].zones.hand, '牌还在手上').toEqual([first, second])
    expect(game.state.cardResolution, '没有开始任何结算').toBeNull()
    expect(luanjiAction(game), '放弃不消耗任何东西').toBeTruthy()
  })

  it('服务端拒绝伪造的不同花色提交（安全）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const spade = giveSuit(game, 'p0', 'spade')
    const heart = giveSuit(game, 'p0', 'heart')
    // 手上还有另一张黑桃，所以动作是给的；但提交的两张花色不同
    giveSuit(game, 'p0', 'spade', [spade])
    game.act('p0', luanjiAction(game)!.id)
    answer(game, { cardIds: [spade, heart] })

    expect(game.state.cardResolution, '校验不过就当没发动').toBeNull()
    expect(game.state.players[0].zones.hand, '一张牌都没花出去').toHaveLength(3)
    assertCardConservation(game.state)
  })

  it('普通实体万箭不受影响（回归）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    const archery = giveNamed(game, 'p0', '万箭齐发')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(archery))!
    game.act('p0', action.id)
    passAll(game)
    expect(game.state.zones.discardPile).toContain(archery)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})

describe('血裔', () => {
  it('袁绍是主公时，上限按其他存活群雄数增加（测试 1 / 4 / 5）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei'] })
    expect(xueyiBonus(game.state, 'p0'), '张角是群，其余是蜀').toBe(1)
    const owner = game.state.players[0]
    expect(maxCardsOf(game.state, 'p0'), '基数是当前体力，再加 1').toBe(owner.hp + 1)
  })

  it('没有其他群雄时不加（测试 3）', () => {
    const game = gameWith()
    expect(xueyiBonus(game.state, 'p0')).toBe(0)
    expect(maxCardsOf(game.state, 'p0')).toBe(game.state.players[0].hp)
  })

  it('多个群雄按数量累加（测试 5）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'yuji', 'huatuo', 'zhangfei'] })
    // 张角、于吉、华佗都是群
    expect(xueyiBonus(game.state, 'p0')).toBe(3)
  })

  it('非群势力角色不计入（测试 6）', () => {
    const game = gameWith({ characters: ['yuanshao', 'caocao', 'liubei', 'sunquan', 'zhangfei'] })
    expect(xueyiBonus(game.state, 'p0'), '魏蜀吴都不算').toBe(0)
  })

  it('袁绍不是主公时完全不生效（测试 2）', () => {
    const game = gameWith({
      yuanshaoIdentity: 'rebel',
      characters: ['yuanshao', 'zhangjiao', 'zhangjiao', 'zhangfei', 'zhangfei'],
    })
    expect(game.state.players[0].identity).not.toBe('lord')
    expect(xueyiBonus(game.state, 'p0'), '普通身份的袁绍不加上限').toBe(0)
    expect(maxCardsOf(game.state, 'p0')).toBe(game.state.players[0].hp)
  })

  it('群雄阵亡后立刻跟着降，不是开局算一次（测试 7 / 8）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'yuji', 'zhangfei', 'zhangfei'] })
    expect(xueyiBonus(game.state, 'p0')).toBe(2)
    game.state.players[1].alive = false
    expect(xueyiBonus(game.state, 'p0'), '死人不算').toBe(1)
    game.state.players[2].alive = false
    expect(xueyiBonus(game.state, 'p0')).toBe(0)
  })

  it('和其他手牌上限修正正确叠加，不互相覆盖（测试 9）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei'] })
    const owner = game.state.players[0]
    const before = maxCardsOf(game.state, 'p0')
    owner.hp -= 1
    expect(maxCardsOf(game.state, 'p0'), '基数变了，加成还在').toBe(before - 1)
  })

  it('弃牌阶段读到的就是加成后的上限（测试 10）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei'] })
    const owner = game.state.players[0]
    clearHand(game, 'p0')
    const limit = maxCardsOf(game.state, 'p0')
    for (let index = 0; index < limit + 2; index += 1) {
      const cardId = game.state.zones.drawPile[0]
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    }
    game.state.phase = 'play'
    game.advancePhase()

    const request = pending(game)
    expect(request?.kind).toBe('choose-cards')
    expect(request?.kind === 'choose-cards' && request.min, '只弃超出的两张').toBe(2)
    expect(owner.zones.hand.length - limit).toBe(2)
  })

  it('上限变化不会在非弃牌时机强制弃牌（测试 33）', () => {
    const game = gameWith({ characters: ['yuanshao', 'zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei'] })
    clearHand(game, 'p0')
    for (let index = 0; index < 8; index += 1) {
      const cardId = game.state.zones.drawPile[0]
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
    }
    game.state.players[1].alive = false
    expect(pending(game), '上限降了也不该当场逼他弃牌').toBeUndefined()
    expect(game.state.players[0].zones.hand).toHaveLength(8)
  })
})
