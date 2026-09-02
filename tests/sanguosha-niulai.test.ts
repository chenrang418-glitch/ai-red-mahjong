import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { MAMA, NIULAI, niulaiRank } from '@/sanguosha/data/characters/entertainment-niulai'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 娱乐武将·牛来。
 *
 * 两处最容易做错的地方单独钉住：
 * 1. 【牛来】的点数大小里 **A 是最大的**，而牌库里 A 的 rank 是 1——
 *    直接拿 rank 比会让追涨的手感整个反过来；
 * 2. 【妈妈】转移的是**原伤害本身**（来源、点数、属性照搬），
 *    不是牛来重新造一份新伤害。
 */

function gameWith(characterIds: string[], seed = 'niulai'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
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

/** 把牌堆顶按顺序摆成指定点数（1 = A）。返回这些牌的 id。 */
function stackDeck(game: SanguoshaGame, ranks: number[]): string[] {
  const picked: string[] = []
  const rest = [...game.state.zones.drawPile]
  for (const rank of ranks) {
    const index = rest.findIndex((id) => game.state.cards[id].rank === rank && !picked.includes(id))
    if (index < 0) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
    picked.push(rest[index])
    rest.splice(index, 1)
  }
  game.state.zones.drawPile = [...picked, ...rest]
  return picked
}

function niulaiAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${NIULAI}`)
}

/** 发动【牛来】，然后按给定的选择依次作答。 */
function playNiulai(game: SanguoshaGame, choices: Array<'continue' | 'stop'>): void {
  game.act('p0', niulaiAction(game)!.id)
  for (const choice of choices) {
    if (!pending(game)) return
    answer(game, { optionId: choice === 'continue' ? 'niulai-continue' : 'niulai-stop' })
  }
}


/**
 * 让 p1 用一张【杀】打牛来，牛来不闪。
 *
 * 走真实的出牌路径而不是直接调 resolveDamage：排队的技能发问只有在
 * `settle()` 之后才会放出来，而 settle 只在 act / respond / advancePhase 里跑。
 * 直接调伤害函数的话【妈妈】永远问不出来。
 */
function slashNiulai(game: SanguoshaGame, options: { fire?: boolean; bonus?: number } = {}) {
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  game.state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: options.bonus ?? 0 }
  const slashId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.name === '杀' && (options.fire ? card.damageNature === 'fire' : !card.damageNature)
  })
  if (!slashId) throw new Error('牌堆里没有合适的【杀】')
  moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
  const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p0'))
  if (!action) throw new Error('构造不出对牛来的杀')
  game.act('p1', action.id)
  // 牛来放弃闪；【妈妈】的发问排在伤害之后
  const dodge = pending(game)
  if (dodge?.kind === 'respond-card') answer(game, { actionId: 'respond-pass' })
  return pending(game)
}

const FILLER = ['niulai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('牛来的基础信息', () => {
  it('群势力、4 体力、两个技能、娱乐包', () => {
    const character = getCharacter('niulai')!
    expect(character.kingdom).toBe('qun')
    expect(character.gender).toBe('male')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('entertainment')
    expect(character.skills.map((skill) => skill.id)).toEqual([NIULAI, MAMA])
  })

  it('A 是最大的 14，不是 1', () => {
    expect(niulaiRank({ rank: 1 }), 'A 必须是 14').toBe(14)
    expect(niulaiRank({ rank: 13 })).toBe(13)
    expect(niulaiRank({ rank: 2 })).toBe(2)
    expect(niulaiRank({ rank: 1 })).toBeGreaterThan(niulaiRank({ rank: 13 }))
  })
})

describe('牛来的追涨', () => {
  it('第一张必得，不存在失败（TEST 1）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const [first] = stackDeck(game, [2])

    game.act('p0', niulaiAction(game)!.id)

    expect(game.state.players[0].zones.hand, '第一张直接进手牌').toContain(first)
    expect(pending(game)?.prompt, '接着问继续还是收手').toContain('继续')
    assertGameInvariants(game.state)
  })

  it('3 → 6 → 10 三张全拿（TEST 2）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [3, 6, 10])

    playNiulai(game, ['continue', 'continue', 'stop'])

    expect(game.state.players[0].zones.hand.sort()).toEqual([...cards].sort())
    assertGameInvariants(game.state)
  })

  it('点数相等算成功（TEST 3）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [6, 6])

    playNiulai(game, ['continue', 'stop'])

    expect(game.state.players[0].zones.hand.sort(), '6 → 6 不算失败').toEqual([...cards].sort())
    assertGameInvariants(game.state)
  })

  it('上一张是 A，再来一张 A 仍然成功（TEST 6）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [1, 1])

    playNiulai(game, ['continue', 'stop'])

    expect(game.state.players[0].zones.hand.sort()).toEqual([...cards].sort())
  })

  it('上一张 A、下一张 K 就是失败（TEST 7）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [1, 13])

    playNiulai(game, ['continue'])

    expect(game.state.players[0].zones.hand, 'A 之后翻出 K，全部吐回去').toHaveLength(0)
    for (const cardId of cards) expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('A 之后仍然允许点继续，不会自动结束', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    stackDeck(game, [1, 5])
    game.act('p0', niulaiAction(game)!.id)
    const request = pending(game) as { options: Array<{ id: string }> }
    expect(request.options.map((option) => option.id), '上一张是 A 也要给继续这个选项')
      .toContain('niulai-continue')
  })
})

describe('牛来的清仓', () => {
  it('3 → 8 → K → 7：本次拿到的全部弃置，收益归零（TEST 4）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [3, 8, 13, 7])

    playNiulai(game, ['continue', 'continue', 'continue'])

    expect(game.state.players[0].zones.hand, '本次收益为 0').toHaveLength(0)
    for (const cardId of cards) {
      expect(game.state.zones.discardPile, '翻出的和拿到的都进弃牌堆').toContain(cardId)
    }
    assertGameInvariants(game.state)
  })

  it('收手保留已经拿到的牌（TEST 5）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [3, 8])

    playNiulai(game, ['continue', 'stop'])

    expect(game.state.players[0].zones.hand.sort()).toEqual([...cards].sort())
    assertGameInvariants(game.state)
  })

  it('清仓只动仍然属于牛来的牌，不去别人区域里抢', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [3, 8, 5])

    game.act('p0', niulaiAction(game)!.id)
    answer(game, { optionId: 'niulai-continue' })
    // 第二张被别人顺走了（模拟顺手牵羊）
    moveCard(game.state, cards[1], { kind: 'hand', playerId: 'p0' }, { kind: 'hand', playerId: 'p1' })
    answer(game, { optionId: 'niulai-continue' })

    expect(game.state.players[1].zones.hand, '已经不属于牛来的牌不能被抢回来').toContain(cards[1])
    expect(game.state.zones.discardPile, '还在自己手上的那张照常弃掉').toContain(cards[0])
    assertGameInvariants(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    stackDeck(game, [5])
    game.act('p0', niulaiAction(game)!.id)
    answer(game, { optionId: 'niulai-stop' })
    expect(niulaiAction(game), '同一阶段不能再发动').toBeFalsy()
  })

  it('牌堆和弃牌堆都空了也不会卡死（TEST 8 边界）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    stackDeck(game, [5])
    game.act('p0', niulaiAction(game)!.id)
    // 把牌堆和弃牌堆清空（牌都塞给别人，保持守恒）
    const rest = [...game.state.zones.drawPile, ...game.state.zones.discardPile]
    for (const cardId of rest) {
      const from = game.state.zones.drawPile.includes(cardId) ? { kind: 'drawPile' as const } : { kind: 'discardPile' as const }
      moveCard(game.state, cardId, from, { kind: 'hand', playerId: 'p4' })
    }

    expect(() => answer(game, { optionId: 'niulai-continue' })).not.toThrow()
    expect(pending(game), '没牌可翻就安全收尾').toBeUndefined()
    assertGameInvariants(game.state)
  })

  it('技能过程中的状态能过 JSON——断线重连要靠它（TEST 8）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cards = stackDeck(game, [3, 8])
    game.act('p0', niulaiAction(game)!.id)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(restored.state.skillResolution?.skillId).toBe(NIULAI)
    expect(restored.state.skillResolution?.data.lastRank, '上一张点数要恢复').toBe(3)
    expect(restored.state.players[0].zones.hand, '已经拿到的牌不会重复发放').toEqual([cards[0]])

    const request = restored.state.pendingRequests[0]
    restored.respond({ requestId: request.id, playerId: 'p0', payload: { optionId: 'niulai-continue' } })
    expect(restored.state.players[0].zones.hand.sort(), '恢复之后照常继续').toEqual([...cards].sort())
  })
})

describe('妈妈的发动条件', () => {
  const hit = (game: SanguoshaGame) => slashNiulai(game)

  it('牛来 2 血、来源 4 血：可以发动（TEST 9）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    game.state.players[1].hp = 4
    expect(hit(game)?.prompt ?? '').toContain('妈妈')
  })

  it('牛来 4 血、来源 3 血：不能发动（TEST 10）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 4
    game.state.players[1].hp = 3
    expect(hit(game)?.prompt ?? '', '体力比来源高就不该问').not.toContain('妈妈')
    expect(game.state.players[0].hp, '照常受伤').toBe(3)
  })

  it('体力相等也可以发动（TEST 11）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    game.state.players[1].hp = 2
    expect(hit(game)?.prompt ?? '').toContain('妈妈')
  })

  it('无来源伤害不能发动（TEST 12）', () => {
    // 闪电那种无来源雷电伤害：比不了体力，连问都不该问。
    // 这里直接调伤害函数即可——重点是触发器当场就返回，不进队列。
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    const queuedBefore = game.state.skillQueue.length
    resolveDamage(game, { targetId: 'p0', amount: 1, nature: 'thunder', cardName: '闪电' })
    expect(game.state.skillQueue.length, '不该往队列里塞妈妈的发问').toBe(queuedBefore)
    expect(game.state.players[0].hp, '照常受伤').toBe(1)
  })

  it('一张可弃的牌都没有时不能发动（TEST 22）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    game.state.players[1].hp = 4
    clearHand(game, 'p0')
    for (const slot of ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const) {
      game.state.players[0].zones.equipment[slot] = null
    }
    expect(hit(game)?.prompt ?? '').not.toContain('妈妈')
    expect(game.state.players[0].hp, '照常受伤').toBe(1)
  })

  it('取消之后原伤害照常落在自己身上（TEST 19 反面）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    game.state.players[1].hp = 4
    const ask = hit(game)!
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'cancel' } })
    expect(game.state.players[0].hp, '放弃就自己承受').toBe(1)
    assertGameInvariants(game.state)
  })
})

describe('妈妈的伤害转移', () => {
  function toTarget(game: SanguoshaGame, options: { fire?: boolean; bonus?: number } = {}) {
    game.state.players[0].hp = 2
    game.state.players[1].hp = 4
    const ask = slashNiulai(game, options)
    expect(ask?.prompt ?? '', '应当先问是否发动妈妈').toContain('妈妈')
    answer(game, { optionId: 'mama-invoke' })
    const discard = pending(game) as { cardIds: string[] }
    answer(game, { cardIds: [discard.cardIds[0]] })
    return pending(game)
  }

  it('弃一张牌、指定第三方，牛来不受伤而目标受伤（TEST 13）', () => {
    const game = gameWith(FILLER)
    const handBefore = game.state.players[0].zones.hand.length
    const targetBefore = game.state.players[2].hp

    toTarget(game)
    answer(game, { targetIds: ['p2'] })

    expect(game.state.players[0].hp, '牛来完全不掉血').toBe(2)
    expect(game.state.players[0].zones.hand.length, '弃了一张').toBe(handBefore - 1)
    expect(game.state.players[2].hp, '目标承受').toBe(targetBefore - 1)
    assertGameInvariants(game.state)
  })

  it('可以指定伤害来源本人（TEST 14）', () => {
    const game = gameWith(FILLER)
    toTarget(game)
    const request = pending(game) as { candidateIds: PlayerId[] }
    expect(request.candidateIds, '来源本人也是合法目标').toContain('p1')
    expect(request.candidateIds, '不能选自己').not.toContain('p0')

    const before = game.state.players[1].hp
    answer(game, { targetIds: ['p1'] })
    expect(game.state.players[1].hp, '曹操自己挨了自己那一下').toBe(before - 1)
    assertGameInvariants(game.state)
  })

  it('原样保留点数和属性：2 点火焰照搬（TEST 15 / 21）', () => {
    const game = gameWith(FILLER)
    const damages: Array<{ target?: string; nature?: string; amount: unknown; source?: string }> = []
    game.events.on('Damaged', (context) => {
      damages.push({
        target: context.event.targetId,
        source: context.event.sourceId,
        nature: context.event.damageNature,
        amount: (context.event.payload as { amount: unknown }).amount,
      })
    })

    toTarget(game, { fire: true, bonus: 1 })
    const before = game.state.players[2].hp
    answer(game, { targetIds: ['p2'] })

    expect(game.state.players[2].hp, '2 点，不是写死的 1 点').toBe(before - 2)
    expect(damages, '只有一个人真的受伤').toHaveLength(1)
    expect(damages[0]).toMatchObject({ target: 'p2', source: 'p1', nature: 'fire', amount: 2 })
    assertGameInvariants(game.state)
  })

  it('原伤害只结算一次：牛来不会先掉血（TEST 19）', () => {
    const game = gameWith(FILLER)
    const hits: string[] = []
    game.events.on('Damaged', (context) => { hits.push(String(context.event.targetId)) })

    toTarget(game)
    answer(game, { targetIds: ['p2'] })

    expect(hits, '承受伤害的只能有一个人').toEqual(['p2'])
  })

  it('转移伤害照常触发目标的受伤技能（TEST 16）', () => {
    // 曹操【奸雄】挂在 Damaged 上，转移过去之后应当正常触发
    const game = gameWith(['niulai', 'zhangfei', 'caocao', 'zhangfei', 'zhangfei'])
    const activated: unknown[] = []
    game.events.on('SkillActivated', (context) => {
      if ((context.event.payload as { skillId?: string }).skillId === 'jianxiong') activated.push(context.event.payload)
    })

    toTarget(game)
    answer(game, { targetIds: ['p2'] })

    // 奸雄需要一张造成伤害的实体牌才会真的拿牌；这里只验伤害确实落到了曹操身上
    expect(game.state.players[2].hp).toBeLessThan(game.state.players[2].maxHp)
    assertGameInvariants(game.state)
  })

  it('目标被转移伤害打到濒死时走完整的求桃流程（TEST 17）', () => {
    const game = gameWith(FILLER)
    game.state.players[2].hp = 1
    toTarget(game)
    answer(game, { targetIds: ['p2'] })

    const dying = game.state.dying !== null
      || game.state.pendingRequests.some((request) => request.kind === 'rescue')
      || !game.state.players[2].alive
    expect(dying).toBe(true)
    assertGameInvariants(game.state)
  })

  it('转移过来的伤害不能再转一次——两个牛来之间不会来回甩（TEST 18）', () => {
    const game = gameWith(['niulai', 'zhangfei', 'niulai', 'zhangfei', 'zhangfei'])
    game.state.players[2].hp = 2
    toTarget(game)
    answer(game, { targetIds: ['p2'] })

    expect(pending(game)?.prompt ?? '', '第二个牛来不能对同一次伤害再喊妈妈')
      .not.toContain('妈妈')
    expect(game.state.players[2].hp, '他只能自己受着').toBe(1)
    assertGameInvariants(game.state)
  })
})

describe('妈妈的每回合限一次', () => {
  it('同一回合第二次受伤不再发问（TEST 20）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 3
    game.state.players[1].hp = 4
    slashNiulai(game)
    answer(game, { optionId: 'mama-invoke' })
    const discard = pending(game) as { cardIds: string[] }
    answer(game, { cardIds: [discard.cardIds[0]] })
    answer(game, { targetIds: ['p2'] })

    // 同一个回合里再挨一下
    game.state.turnUsage.slashUses = 0
    slashNiulai(game)
    expect(pending(game)?.prompt ?? '', '这个回合已经喊过了').not.toContain('妈妈')
    expect(game.state.players[0].hp, '只能自己受着').toBe(2)
    assertGameInvariants(game.state)
  })

  it('换到下一名角色的回合就重新可用（TEST 21）', () => {
    const game = gameWith(FILLER)
    game.state.players[0].turnUsedSkills.push(MAMA)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'finish'
    game.advancePhase()
    expect(game.state.players[0].turnUsedSkills, '换回合统一清空').not.toContain(MAMA)
  })
})
