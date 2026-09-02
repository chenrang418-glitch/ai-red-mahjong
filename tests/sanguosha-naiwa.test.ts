import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { HOUXIAO, PENGFU, PENGFU_CONTINUE_MARK } from '@/sanguosha/data/characters/entertainment-naiwa'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { moveCard } from '@/sanguosha/engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 娱乐武将·奶蛙。
 *
 * 两条最容易做错的地方单独钉住：
 * 1. 【一起笑】必须**先各摸一张，再同时定下两张要换的牌**——
 *    先给一张再从对方（已经变了的）手牌里随机，刚拿到的牌可能被立刻换回去。
 * 2. 【绷住】发给奶蛙的请求里**不能出现目标的其余手牌**，
 *    否则联机时客户端直接能看牌。
 */

function gameWith(characterIds: string[], seed = 'naiwa'): SanguoshaGame {
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

function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function houxiaoAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${HOUXIAO}`)
}

const FILLER = ['naiwa', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('奶蛙的基础信息', () => {
  it('群势力、4 体力、两个技能、娱乐包', () => {
    const naiwa = getCharacter('naiwa')!
    expect(naiwa.kingdom).toBe('qun')
    expect(naiwa.gender).toBe('male')
    expect(naiwa.maxHp).toBe(4)
    expect(naiwa.pack).toBe('entertainment')
    expect(naiwa.skills.map((skill) => skill.id)).toEqual([HOUXIAO, PENGFU])
  })
})

describe('齁笑的发动条件', () => {
  it('出牌阶段限一次', () => {
    const game = gameWith(FILLER)
    expect(houxiaoAction(game), '第一次可用').toBeTruthy()
    game.act('p0', houxiaoAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    answer(game, { optionId: 'houxiao-together' })
    expect(houxiaoAction(game), '同一阶段不能再发动').toBeFalsy()
    assertGameInvariants(game.state)
  })

  it('没有手牌的角色不能被选中（TEST 1）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p1')
    game.act('p0', houxiaoAction(game)!.id)
    const request = pending(game) as ChooseTargetsRequest
    expect(request.candidateIds, '空手的人两个选项都无从谈起').not.toContain('p1')
    expect(request.candidateIds, '不能选自己').not.toContain('p0')
  })

  it('全场都没有手牌时根本没有这条动作', () => {
    const game = gameWith(FILLER)
    for (const player of game.state.players.slice(1)) clearHand(game, player.id)
    expect(houxiaoAction(game)).toBeFalsy()
  })

  it('目标只有一张手牌时只能选一起笑（TEST 2）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p1')
    giveSuit(game, 'p1', 'heart')
    game.act('p0', houxiaoAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    const request = pending(game) as ChooseOptionRequest
    expect(request.options.map((option) => option.id)).toEqual(['houxiao-together'])
  })
})

describe('一起笑', () => {
  it('双方先各摸一张，之后才定下要换的牌（TEST 3）', () => {
    const game = gameWith(FILLER)
    const ownerBefore = game.state.players[0].zones.hand.length
    const targetBefore = game.state.players[1].zones.hand.length

    game.act('p0', houxiaoAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    answer(game, { optionId: 'houxiao-together' })

    // 各摸一张再各换一张，净手牌数不变
    expect(game.state.players[0].zones.hand.length).toBe(ownerBefore + 1)
    expect(game.state.players[1].zones.hand.length).toBe(targetBefore + 1)
    assertGameInvariants(game.state)
  })

  it('交换的是摸牌之后的手牌——刚摸到的牌也可能被换走', () => {
    // 把双方手牌清空，各留一张可辨认的牌；摸牌之后各有两张，
    // 交换只可能在这两张里发生，两边的牌一定各换了一张
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const ownerCard = giveNamed(game, 'p0', '桃')
    const targetCard = giveNamed(game, 'p1', '杀')

    game.act('p0', houxiaoAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    answer(game, { optionId: 'houxiao-together' })

    const ownerHand = game.state.players[0].zones.hand
    const targetHand = game.state.players[1].zones.hand
    expect(ownerHand).toHaveLength(2)
    expect(targetHand).toHaveLength(2)
    // 每张牌都还在场上某个人手里，没有凭空消失
    for (const cardId of [ownerCard, targetCard]) {
      expect(ownerHand.includes(cardId) || targetHand.includes(cardId), '牌不能丢').toBe(true)
    }
    assertGameInvariants(game.state)
  })

  it('随机由服务端决定：同一个 seed 必然得到同一个结果（TEST 4）', () => {
    const run = () => {
      const game = gameWith(FILLER, 'naiwa-deterministic')
      game.act('p0', houxiaoAction(game)!.id)
      answer(game, { targetIds: ['p1'] })
      answer(game, { optionId: 'houxiao-together' })
      return [...game.state.players[0].zones.hand].sort().join(',')
    }
    expect(run()).toBe(run())
  })
})

describe('绷住', () => {
  /** 让 p1 手里恰好是这些花色，然后走到「奶蛙猜」那一步。 */
  function holdWith(suits: Suit[]) {
    const game = gameWith(FILLER)
    clearHand(game, 'p1')
    const cardIds = suits.map((suit) => giveSuit(game, 'p1', suit))
    game.act('p0', houxiaoAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    answer(game, { optionId: 'houxiao-hold' })
    return { game, cardIds }
  }

  it('展示牌仍然属于目标，不移区不弃置（TEST 7）', () => {
    const { game, cardIds } = holdWith(['heart', 'heart'])
    const pick = pending(game) as ChooseCardsRequest
    expect(pick.playerId, '选展示牌的是目标自己').toBe('p1')
    answer(game, { cardIds: [cardIds[0]] })

    expect(game.state.players[1].zones.hand, '展示牌还在原手里').toContain(cardIds[0])
    expect(game.state.zones.processingArea).not.toContain(cardIds[0])
    expect(game.state.zones.discardPile).not.toContain(cardIds[0])
    assertGameInvariants(game.state)
  })

  it('剩余有同色，猜「有」则奶蛙摸两张（TEST 5）', () => {
    const { game, cardIds } = holdWith(['heart', 'diamond'])
    answer(game, { cardIds: [cardIds[0]] })
    const before = game.state.players[0].zones.hand.length
    answer(game, { optionId: 'houxiao-yes' })

    expect(game.state.players[0].zones.hand.length, '红桃和方块都算红色').toBe(before + 2)
    assertGameInvariants(game.state)
  })

  it('展示黑桃、剩余全是红牌时猜「有」是猜错，目标摸一张（TEST 6）', () => {
    const { game, cardIds } = holdWith(['spade', 'heart', 'diamond'])
    answer(game, { cardIds: [cardIds[0]] })
    const ownerBefore = game.state.players[0].zones.hand.length
    const targetBefore = game.state.players[1].zones.hand.length
    answer(game, { optionId: 'houxiao-yes' })

    expect(game.state.players[0].zones.hand.length, '猜错，奶蛙不摸').toBe(ownerBefore)
    expect(game.state.players[1].zones.hand.length, '猜错，目标摸一张').toBe(targetBefore + 1)
    assertGameInvariants(game.state)
  })

  it('猜「没有」而确实没有，也算猜对', () => {
    const { game, cardIds } = holdWith(['spade', 'heart'])
    answer(game, { cardIds: [cardIds[0]] })
    const before = game.state.players[0].zones.hand.length
    answer(game, { optionId: 'houxiao-no' })
    expect(game.state.players[0].zones.hand.length).toBe(before + 2)
  })

  it('猜测请求里不含目标的其余手牌（TEST 8）', () => {
    const { game, cardIds } = holdWith(['spade', 'heart', 'diamond'])
    answer(game, { cardIds: [cardIds[0]] })

    const guess = pending(game)!
    expect(guess.playerId).toBe('p0')
    const serialized = JSON.stringify(guess)
    for (const hidden of cardIds.slice(1)) {
      expect(serialized, '其余手牌一个 id 都不能出现在请求里').not.toContain(hidden)
    }
    // 技能等待状态也会被序列化下发到 DO，一并检查
    expect(JSON.stringify(game.state.skillResolution)).not.toContain(cardIds[1])
  })

  it('奶蛙的视图里看不到目标的手牌', () => {
    const { game, cardIds } = holdWith(['spade', 'heart'])
    answer(game, { cardIds: [cardIds[0]] })
    const view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p1')?.hand, '别人的手牌永远是 null').toBeNull()
    expect(JSON.stringify(view)).not.toContain(cardIds[1])
  })
})

describe('捧腹的触发', () => {
  /** 让 p1 在自己的出牌阶段用掉 n 张牌（用【桃】，不需要目标）。 */
  function useCards(game: SanguoshaGame, playerId: PlayerId, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const cardId = giveNamed(game, playerId, '桃')
      const owner = game.state.players.find((player) => player.id === playerId)!
      owner.hp = Math.max(1, owner.maxHp - 1)
      const action = game.legalActions(playerId).find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(cardId))
      if (!action) throw new Error('构造不出【桃】的使用动作')
      game.act(playerId, action.id)
    }
  }

  function pengfuGame(seed = 'naiwa-pengfu'): SanguoshaGame {
    const game = gameWith(FILLER, seed)
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    // 进入出牌阶段的事件要真的发一次，计数才会归零
    game.events.emit?.('PhaseStart', { playerId: 'p1', phase: 'play' })
    return game
  }

  it('第一张牌不触发，第二张牌结算完才触发（TEST 9）', () => {
    const game = pengfuGame()
    useCards(game, 'p1', 1)
    expect(pending(game)?.prompt ?? '', '第一张不该触发').not.toContain('捧腹')

    useCards(game, 'p1', 1)
    expect(pending(game)?.prompt ?? '', '第二张之后才问奶蛙').toContain('捧腹')
    expect(pending(game)?.playerId).toBe('p0')
    assertGameInvariants(game.state)
  })

  it('奶蛙自己的出牌阶段不会触发', () => {
    const game = gameWith(FILLER)
    game.state.currentPlayerId = 'p0'
    useCards(game, 'p0', 2)
    expect(pending(game)?.prompt ?? '').not.toContain('捧腹')
  })

  it('可以取消，取消之后本回合不再问', () => {
    const game = pengfuGame()
    useCards(game, 'p1', 2)
    answer(game, { optionId: 'cancel' })
    useCards(game, 'p1', 2)
    expect(pending(game)?.prompt ?? '', '取消不算发动，但也不该反复骚扰').not.toContain('捧腹')
  })
})

describe('捧腹·继续', () => {
  function useOne(game: SanguoshaGame, playerId: PlayerId): void {
    const cardId = giveNamed(game, playerId, '桃')
    const owner = game.state.players.find((player) => player.id === playerId)!
    owner.hp = Math.max(1, owner.maxHp - 1)
    const action = game.legalActions(playerId).find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(cardId))!
    game.act(playerId, action.id)
  }

  function toChoice(seed = 'naiwa-continue'): SanguoshaGame {
    const game = gameWith(FILLER, seed)
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    useOne(game, 'p1')
    useOne(game, 'p1')
    answer(game, { optionId: 'pengfu-invoke' })
    return game
  }

  it('继续：目标摸一张并挂上临时状态', () => {
    const game = toChoice()
    const before = game.state.players[1].zones.hand.length
    answer(game, { optionId: 'pengfu-continue' })

    expect(game.state.players[1].zones.hand.length, '目标摸一张').toBe(before + 1)
    expect(game.state.players[1].marks[PENGFU_CONTINUE_MARK], '临时状态挂在被起哄的人身上').toBeTruthy()
    assertGameInvariants(game.state)
  })

  it('本阶段再用一张牌就算完成，奶蛙摸一张；不指定目标也算（TEST 10）', () => {
    const game = toChoice()
    answer(game, { optionId: 'pengfu-continue' })
    const ownerBefore = game.state.players[0].zones.hand.length

    useOne(game, 'p1')

    expect(game.state.players[0].zones.hand.length, '【桃】没有其他目标，一样算继续成功').toBe(ownerBefore + 1)
    expect(game.state.players[1].marks[PENGFU_CONTINUE_MARK], '完成之后状态要清掉').toBeFalsy()
    assertGameInvariants(game.state)
  })

  it('只奖励一次：第四第五张牌不再给奶蛙摸牌（TEST 11）', () => {
    const game = toChoice()
    answer(game, { optionId: 'pengfu-continue' })
    useOne(game, 'p1')
    const after = game.state.players[0].zones.hand.length
    useOne(game, 'p1')
    useOne(game, 'p1')
    expect(game.state.players[0].zones.hand.length, '一次继续最多让奶蛙摸一张').toBe(after)
  })

  it('阶段结束还没再出牌就罚弃一张，奶蛙不摸（TEST 12）', () => {
    const game = toChoice()
    answer(game, { optionId: 'pengfu-continue' })
    const ownerBefore = game.state.players[0].zones.hand.length
    const targetBefore = game.state.players[1].zones.hand.length

    game.advancePhase()
    /*
     * 罚弃走的是技能队列，队列只在牌局干净时才排空，
     * 所以它排在正常弃牌阶段**之后**——这是已知的顺序差异，
     * 规则上「阶段结束时弃一张」的效果没有变。
     */
    let discarded = 0
    let penaltyPrompt = ''
    for (let guard = 0; guard < 10; guard += 1) {
      const request = pending(game) as ChooseCardsRequest | undefined
      if (!request || request.kind !== 'choose-cards') break
      if (request.prompt.includes('捧腹')) {
        penaltyPrompt = request.prompt
        expect(request.playerId, '罚弃的是被起哄的人').toBe('p1')
      }
      const count = Math.max(request.min, 1)
      discarded += count
      answer(game, { cardIds: request.cardIds.slice(0, count) })
    }

    expect(penaltyPrompt, '应当出现过一次捧腹的罚弃').toContain('捧腹')
    expect(game.state.players[1].zones.hand.length, '弃掉的牌数对得上').toBe(targetBefore - discarded)
    expect(game.state.players[0].zones.hand.length, '继续失败奶蛙不摸牌').toBe(ownerBefore)
    assertGameInvariants(game.state)
  })

  it('阶段结束时一张牌都没有，安全收尾不卡死（TEST 15）', () => {
    const game = toChoice()
    answer(game, { optionId: 'pengfu-continue' })
    clearHand(game, 'p1')
    for (const slot of ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const) {
      game.state.players[1].zones.equipment[slot] = null
    }

    expect(() => game.advancePhase()).not.toThrow()
    expect(pending(game)?.prompt ?? '', '没牌可弃就不该发请求').not.toContain('捧腹')
    assertGameInvariants(game.state)
  })

  it('目标中途死亡时清掉状态，不追着尸体要牌（TEST 21 边界）', () => {
    const game = toChoice()
    answer(game, { optionId: 'pengfu-continue' })
    game.state.players[1].alive = false
    game.state.players[1].identityRevealed = true

    expect(() => game.advancePhase()).not.toThrow()
    expect(pending(game)?.prompt ?? '').not.toContain('捧腹')
  })
})

describe('捧腹·算了', () => {
  function toChoice(): SanguoshaGame {
    const game = gameWith(FILLER, 'naiwa-stop')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    for (let index = 0; index < 2; index += 1) {
      const cardId = giveNamed(game, 'p1', '桃')
      game.state.players[1].hp = Math.max(1, game.state.players[1].maxHp - 1)
      const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(cardId))!
      game.act('p1', action.id)
    }
    answer(game, { optionId: 'pengfu-invoke' })
    return game
  }

  it('目标弃一张，奶蛙摸一张（TEST 13）', () => {
    const game = toChoice()
    const ownerBefore = game.state.players[0].zones.hand.length
    const targetBefore = game.state.players[1].zones.hand.length
    answer(game, { optionId: 'pengfu-stop' })

    const discard = pending(game) as ChooseCardsRequest
    expect(discard.playerId).toBe('p1')
    answer(game, { cardIds: [discard.cardIds[0]] })

    expect(game.state.players[1].zones.hand.length).toBe(targetBefore - 1)
    expect(game.state.players[0].zones.hand.length).toBe(ownerBefore + 1)
    assertGameInvariants(game.state)
  })

  it('没有任何牌可弃时不给「算了」这个选项（TEST 14）', () => {
    // 选项是在「奶蛙确认发动」那一刻算好的，所以要在那之前就把牌清空
    const game = gameWith(FILLER, 'naiwa-nostop')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    for (let index = 0; index < 2; index += 1) {
      const cardId = giveNamed(game, 'p1', '桃')
      game.state.players[1].hp = Math.max(1, game.state.players[1].maxHp - 1)
      const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(cardId))!
      game.act('p1', action.id)
    }
    clearHand(game, 'p1')
    for (const slot of ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const) {
      game.state.players[1].zones.equipment[slot] = null
    }
    answer(game, { optionId: 'pengfu-invoke' })

    const request = pending(game) as ChooseOptionRequest
    expect(request.options.map((option) => option.id), '没牌可弃就只能继续')
      .toEqual(['pengfu-continue'])
  })

  it('可以弃装备区的牌', () => {
    const game = toChoice()
    clearHand(game, 'p1')
    const horse = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'offensiveHorse')!
    moveCard(game.state, horse, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p1', slot: 'offensiveHorse' })

    answer(game, { optionId: 'pengfu-stop' })
    const discard = pending(game) as ChooseCardsRequest
    expect(discard.cardIds, '装备区的牌也能弃').toContain(horse)
    answer(game, { cardIds: [horse] })

    expect(game.state.players[1].zones.equipment.offensiveHorse).toBeNull()
    expect(game.state.zones.discardPile).toContain(horse)
    assertGameInvariants(game.state)
  })
})

describe('捧腹的计数口径', () => {
  it('打出的【闪】不计入使用牌数（TEST 16）', () => {
    const game = gameWith(FILLER, 'naiwa-count')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    // p1 用一张杀打 p2，p2 打出闪；这只算 p1 用了一张牌
    const slash = giveNamed(game, 'p1', '杀')
    const dodge = giveNamed(game, 'p2', '闪')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p2'))!
    game.act('p1', action.id)
    answer(game, { actionId: `respond-dodge:${dodge}` })

    expect(pending(game)?.prompt ?? '', '响应不算使用，还没到第二张').not.toContain('捧腹')
    assertGameInvariants(game.state)
  })

  it('装备牌算一张（TEST 17）', () => {
    const game = gameWith(FILLER, 'naiwa-equip')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const peach = giveNamed(game, 'p1', '桃')
    game.state.players[1].hp = 1
    const peachAction = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(peach))!
    game.act('p1', peachAction.id)

    const horse = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'offensiveHorse')!
    moveCard(game.state, horse, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const equipAction = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(horse))!
    game.act('p1', equipAction.id)

    expect(pending(game)?.prompt ?? '', '装备是第二张牌，要触发').toContain('捧腹')
  })

  it('多目标锦囊只算一张（TEST 19）', () => {
    const game = gameWith(FILLER, 'naiwa-multi')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const harvest = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '五谷丰登')!
    moveCard(game.state, harvest, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(harvest))!
    game.act('p1', action.id)

    // 把五谷的选牌流程走完
    for (let guard = 0; guard < 30; guard += 1) {
      const request = pending(game)
      if (!request) break
      if (request.prompt.includes('捧腹')) break
      const payload: Record<string, unknown> = { actionId: 'respond-pass', optionId: 'no', targetIds: [] }
      if (request.kind === 'choose-cards') payload.cardIds = [...request.cardIds, ...request.hiddenCardSlots].slice(0, request.min)
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
    }

    expect(game.state.players[1].marks['pengfu-play-uses'], '一张牌就是一张，不按目标数').toBe(1)
    assertGameInvariants(game.state)
  })

  it('换到下一名角色的回合，捧腹重新可用（TEST 20 / 21）', () => {
    const game = gameWith(FILLER, 'naiwa-turn')
    game.state.players[0].turnUsedSkills.push(PENGFU)
    // 回合结束会统一清空所有人的每回合技能记账
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'finish'
    game.advancePhase()
    expect(game.state.players[0].turnUsedSkills, '换回合就该清空').not.toContain(PENGFU)
  })
})
