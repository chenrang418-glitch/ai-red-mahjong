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
 * 最容易做错的几处单独钉住：
 * 1. 【牛来】的点数大小里 **A 是最大的**，而牌库里 A 的 rank 是 1——
 *    直接拿 rank 比会让追涨的手感整个反过来；
 * 2. 【麻麻】的跟杀是**真正的【杀】使用事件**，不是直接造成一点伤害：
 *    目标要能出【闪】，杀相关技能要照常触发；
 * 3. 遗产**只能被一名牛来继承**，同一张实体牌不能复制成两份。
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
  // 开局第一件事就是每个牛来认麻麻，默认认 p1
  answerPendingPicks(game, 'p1')
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

/** 把当前所有「认麻麻」请求都答成 `mamaId`（自己不能认自己时顺延）。 */
function answerPendingPicks(game: SanguoshaGame, mamaId: PlayerId): void {
  let guard = 0
  while (game.state.pendingRequests.length > 0) {
    if (guard++ > 20) throw new Error('认麻麻没有收敛')
    const request = game.state.pendingRequests[0]
    if (request.kind !== 'choose-targets') throw new Error(`开局出现了意外请求：${request.kind}`)
    const candidates = (request as { candidateIds: PlayerId[] }).candidateIds
    const picked = candidates.includes(mamaId) ? mamaId : candidates[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { targetIds: [picked] } })
  }
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


// ─────────────────────────── 麻麻 ───────────────────────────

/** 让 `sourceId` 对 `targetIds` 使用一张普通【杀】，走真实出牌路径。 */
function useSlash(game: SanguoshaGame, sourceId: PlayerId, targetIds: PlayerId[]): void {
  game.state.currentPlayerId = sourceId
  game.state.phase = 'play'
  game.state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  const slashId = giveSlash(game, sourceId)
  const action = game.legalActions(sourceId).find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId)
    && targetIds.every((targetId) => candidate.targetIds.includes(targetId))
    && candidate.targetIds.length === targetIds.length)
  if (!action) throw new Error(`构造不出 ${sourceId} 对 ${targetIds.join('、')} 的杀`)
  game.act(sourceId, action.id)
}

/** 从牌堆给某人一张普通【杀】，返回 cardId。 */
function giveSlash(game: SanguoshaGame, playerId: PlayerId): string {
  const slashId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.name === '杀' && !card.damageNature
  })
  if (!slashId) throw new Error('牌堆里没有普通【杀】')
  moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return slashId
}

/** 从牌堆给某人一张指定牌名的牌。 */
function give(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

/**
 * 把别人的求闪、求桃一路放弃掉，停在牛来自己的技能窗口前。
 *
 * 跟杀可能把目标打到濒死，那时冒出来的是 rescue 而不是 respond-card，
 * 只认一种 actionId 会被「actionId 非法」打回来。
 */
function passOthers(game: SanguoshaGame): void {
  for (let guard = 0; guard < 40; guard += 1) {
    const request = pending(game)
    if (!request || request.playerId === 'p0') return
    if (request.kind === 'respond-card') answer(game, { actionId: 'respond-pass' })
    else if (request.kind === 'rescue') answer(game, { actionId: 'rescue-pass' })
    else return
  }
}

/** 当前是不是在问牛来要不要跟杀。 */
function followPrompt(game: SanguoshaGame): string | null {
  const request = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')
  if (!request || request.kind !== 'choose-option') return null
  return request.prompt.includes('麻麻') ? request.prompt : null
}

function optionIds(game: SanguoshaGame): string[] {
  const request = pending(game)
  if (request?.kind !== 'choose-option') throw new Error('当前不是选项请求')
  return request.options.map((option) => option.id)
}

/** 走完一整套跟杀：选方式 → 选目标 → 选牌。 */
function followSlash(game: SanguoshaGame, mode: 'mama-follow' | 'mama-help', targetId: PlayerId, cardIds: string[]): void {
  answer(game, { optionId: mode })
  answer(game, { targetIds: [targetId] })
  answer(game, { cardIds })
}

const MAMA_FILLER = ['niulai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('认麻麻', () => {
  it('游戏开始时必须选一名其他角色（TEST 1）', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'mama-pick', setup })
    const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
    game.state.players.forEach((player, index) => {
      player.identity = identities[index]
      player.characterId = MAMA_FILLER[index]
    })
    game.start()

    const request = pending(game)
    expect(request, '开局就该问牛来认谁').toBeTruthy()
    expect(request.playerId).toBe('p0')
    expect(request.kind).toBe('choose-targets')
    expect(request.optional, '必须认，不是可选').toBe(false)
    const candidates = (request as { candidateIds: PlayerId[] }).candidateIds
    expect(candidates, '不能认自己').not.toContain('p0')
    expect(candidates).toEqual(['p1', 'p2', 'p3', 'p4'])

    answer(game, { targetIds: ['p2'] })
    expect(game.state.mamaBonds.p0).toBe('p2')
    assertGameInvariants(game.state)
  })

  it('认亲关系是公开的，所有人都看得到', () => {
    const game = gameWith(MAMA_FILLER)
    for (const viewerId of ['p0', 'p1', 'p3']) {
      expect(game.viewFor(viewerId).mamaBonds, `${viewerId} 应当看得到`).toEqual({ p0: 'p1' })
    }
  })
})

describe('麻麻的跟杀', () => {
  it('麻麻杀别人、牛来有杀：可以跟上（TEST 2）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p2'])
    // p2 先放弃闪，麻麻的杀结算完才轮到跟杀
    passOthers(game)

    expect(followPrompt(game), '应当问牛来跟不跟').toBeTruthy()
    expect(optionIds(game)).toContain('mama-follow')

    const hpBefore = game.state.players[2].hp
    followSlash(game, 'mama-follow', 'p2', [mySlash])
    passOthers(game)

    expect(game.state.players[2].hp, '跟杀真的造成了伤害').toBe(hpBefore - 1)
    expect(game.state.zones.discardPile, '实体杀被真的用掉了').toContain(mySlash)
    assertGameInvariants(game.state)
  })

  it('跟杀无视距离，且目标可以正常出闪（TEST 3）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    // p0 到 p2 的距离拉到打不到
    game.state.players[0].distanceToOthers = 5
    expect(game.legalActions('p0').some((action) => action.kind === 'use-card'
      && action.cardIds.includes(mySlash) && action.targetIds.includes('p2')), '正常出牌够不着 p2').toBe(false)

    const dodgeId = give(game, 'p2', '闪')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    const hpBefore = game.state.players[2].hp
    followSlash(game, 'mama-follow', 'p2', [mySlash])
    const dodge = pending(game)
    expect(dodge?.playerId, '跟杀照样要问闪').toBe('p2')
    expect(dodge?.kind === 'respond-card' && dodge.actionIds).toContain(`respond-dodge:${dodgeId}`)
    answer(game, { actionId: `respond-dodge:${dodgeId}` })

    expect(game.state.players[2].hp, '闪掉了就不掉血').toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('跟杀不计入牛来自己的出杀次数（TEST 4）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    const usesBefore = game.state.turnUsage.slashUses
    followSlash(game, 'mama-follow', 'p2', [mySlash])
    passOthers(game)

    expect(game.state.turnUsage.slashUses, '出杀次数不该被跟杀吃掉').toBe(usesBefore)
    assertGameInvariants(game.state)
  })

  it('没有杀但有两张可弃牌：可以帮忙（TEST 5 / TEST 6）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const first = give(game, 'p0', '桃')
    const second = give(game, 'p0', '闪')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    expect(optionIds(game), '没有实体杀就不给跟上').not.toContain('mama-follow')
    expect(optionIds(game)).toContain('mama-help')

    const hpBefore = game.state.players[2].hp
    answer(game, { optionId: 'mama-help' })
    answer(game, { targetIds: ['p2'] })
    answer(game, { cardIds: [first, second] })

    const dodge = pending(game)
    expect(dodge?.playerId, '虚拟杀同样要问闪').toBe('p2')
    expect(dodge?.kind === 'respond-card' && dodge.requiredCardName).toBe('闪')
    answer(game, { actionId: 'respond-pass' })

    expect(game.state.players[2].hp, '虚拟杀造成伤害').toBe(hpBefore - 1)
    expect(game.state.zones.discardPile, '两张代价牌真的弃掉了').toEqual(expect.arrayContaining([first, second]))
    expect(game.state.players[0].zones.hand, '手牌已经付光').toHaveLength(0)
    assertGameInvariants(game.state)
  })

  it('装备区的牌也能当作帮忙的代价', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const handCard = give(game, 'p0', '桃')
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'weapon')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    answer(game, { optionId: 'mama-help' })
    answer(game, { targetIds: ['p2'] })
    const request = pending(game)
    expect(request?.kind === 'choose-cards' && request.cardIds, '装备也在可弃列表里').toContain(weapon)
    answer(game, { cardIds: [handCard, weapon] })
    passOthers(game)

    expect(game.state.players[0].zones.equipment.weapon, '武器已经弃掉').toBeNull()
    assertGameInvariants(game.state)
  })

  it('没有杀也凑不出两张牌时根本不发问（TEST 7）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    give(game, 'p0', '桃')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    expect(followPrompt(game), '条件不满足就不该弹一个只能取消的窗口').toBeNull()
    assertGameInvariants(game.state)
  })

  it('麻麻打的是牛来自己：完全不能跟（TEST 8）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p0'])
    answer(game, { actionId: 'respond-pass' })

    expect(followPrompt(game), '麻麻揍自己的时候不能跟').toBeNull()
    expect(game.state.players[0].hp, '照常挨这一刀').toBe(3)
    assertGameInvariants(game.state)
  })

  it('多目标杀里只要牛来也是目标就完全不能跟（TEST 9）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    giveSlash(game, 'p0')
    // 丈八蛇矛之类的多目标杀在这套牌里不好凑，直接构造一次多目标 CardUsed
    const slashId = giveSlash(game, 'p1')
    game.dispatch('CardUsed', { cardId: slashId, cardName: '杀', targetIds: ['p0', 'p2'] }, { sourceId: 'p1' })

    expect(game.state.skillQueue.some((prompt) => prompt.skillId === MAMA && prompt.step === 'follow'),
      '牛来在目标里，一刀都不能跟').toBe(false)
  })

  it('多目标杀里牛来不是目标：只能选其中一名跟（TEST 10）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    const slashId = giveSlash(game, 'p1')
    game.dispatch('CardUsed', { cardId: slashId, cardName: '杀', targetIds: ['p2', 'p3'] }, { sourceId: 'p1' })
    game.advancePhase()

    expect(followPrompt(game)).toBeTruthy()
    answer(game, { optionId: 'mama-follow' })
    const targetRequest = pending(game)
    expect(targetRequest?.kind).toBe('choose-targets')
    const candidates = (targetRequest as { candidateIds: PlayerId[]; max: number }).candidateIds
    expect(candidates, '只能在麻麻的目标里挑').toEqual(['p2', 'p3'])
    expect((targetRequest as { max: number }).max, '只能挑一个').toBe(1)

    answer(game, { targetIds: ['p3'] })
    answer(game, { cardIds: [mySlash] })
    passOthers(game)
    expect(game.state.players[2].hp, '没被选中的目标不该受影响').toBe(4)
    assertGameInvariants(game.state)
  })
})

describe('麻麻的每回合限一次', () => {
  it('同一自然回合麻麻连出两张杀，只能跟一次（TEST 11）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)
    followSlash(game, 'mama-follow', 'p2', [mySlash])
    passOthers(game)

    // 同一个回合里麻麻再来一张
    useSlash(game, 'p1', ['p2'])
    passOthers(game)
    expect(followPrompt(game), '同一回合只能跟一次').toBeNull()
    assertGameInvariants(game.state)
  })

  it('进入新回合后次数重置（TEST 12）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    const laterSlash = giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)
    followSlash(game, 'mama-follow', 'p2', [mySlash])
    passOthers(game)

    // 走完这一回合，turnUsedSkills 在回合结束时统一清空
    game.state.players.forEach((player) => { player.turnUsedSkills = [] })
    useSlash(game, 'p1', ['p2'])
    passOthers(game)

    expect(followPrompt(game), '新回合可以再跟一次').toBeTruthy()
    followSlash(game, 'mama-follow', 'p2', [laterSlash])
    passOthers(game)
    assertGameInvariants(game.state)
  })
})

describe('麻麻的遗产', () => {
  /** 让麻麻带上指定数量的手牌、装备和判定牌，然后打死他。 */
  function killMama(game: SanguoshaGame, options: { hand?: number; equipment?: number; judging?: boolean } = {}) {
    const mama = game.state.players[1]
    game.state.zones.discardPile.push(...mama.zones.hand)
    mama.zones.hand = []
    const handIds: string[] = []
    for (let index = 0; index < (options.hand ?? 0); index += 1) {
      handIds.push(give(game, 'p1', '桃'))
    }
    const equipmentIds: string[] = []
    const slots = ['weapon', 'armor'] as const
    for (let index = 0; index < (options.equipment ?? 0); index += 1) {
      const slot = slots[index]
      const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === slot)!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p1', slot })
      equipmentIds.push(cardId)
    }
    let judgingId: string | null = null
    if (options.judging) {
      judgingId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '乐不思蜀')!
      moveCard(game.state, judgingId, { kind: 'drawPile' }, { kind: 'judgingArea', playerId: 'p1' })
    }
    mama.hp = 1
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
    // 没人救，走到死亡
    let guard = 0
    while (game.state.dying) {
      if (guard++ > 20) throw new Error('濒死没有收敛')
      const request = pending(game)!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    return { handIds, equipmentIds, judgingId }
  }

  it('手牌和装备一并继承，判定区不算（TEST 13 / 14 / 15）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const { handIds, equipmentIds, judgingId } = killMama(game, { hand: 3, equipment: 2, judging: true })

    const heir = game.state.players[0]
    expect(heir.zones.hand, '3 手牌 + 2 装备 = 5 张').toHaveLength(5)
    for (const cardId of [...handIds, ...equipmentIds]) {
      expect(heir.zones.hand, `${cardId} 应该在牛来手上`).toContain(cardId)
    }
    expect(Object.values(heir.zones.equipment).filter(Boolean), '装备不自动穿上').toHaveLength(0)
    expect(heir.zones.hand, '判定区的牌不在遗产里').not.toContain(judgingId)
    expect(game.state.zones.discardPile, '判定牌按原死亡流程进弃牌堆').toContain(judgingId)
    assertGameInvariants(game.state)
  })

  it('麻麻死后牛来失去麻麻，下个准备阶段必须重新认（TEST 16）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    killMama(game)
    expect(game.state.mamaBonds.p0, '认亲关系已经解除').toBeUndefined()

    game.state.currentPlayerId = 'p4'
    game.state.phase = 'finish'
    game.advancePhase()
    while (game.state.currentPlayerId !== 'p0') {
      if (game.state.pendingRequests.length > 0) break
      game.advancePhase()
    }
    const request = pending(game)
    expect(request?.playerId, '轮到牛来的准备阶段就要重新认').toBe('p0')
    expect(request?.kind).toBe('choose-targets')
    expect(request?.optional).toBe(false)
    answer(game, { targetIds: ['p2'] })
    expect(game.state.mamaBonds.p0).toBe('p2')
    assertGameInvariants(game.state)
  })

  it('两个牛来认同一个麻麻：遗产只归一人，不会复制（TEST 17）', () => {
    const game = gameWith(['niulai', 'zhangfei', 'niulai', 'zhangfei', 'zhangfei'])
    // 两个牛来都认 p1
    game.state.mamaBonds.p0 = 'p1'
    game.state.mamaBonds.p2 = 'p1'
    clearHand(game, 'p0')
    clearHand(game, 'p2')
    const { handIds, equipmentIds } = killMama(game, { hand: 3, equipment: 1 })
    const estate = [...handIds, ...equipmentIds]

    const holders = ['p0', 'p2'].filter((id) => {
      const player = game.state.players.find((candidate) => candidate.id === id)!
      return estate.some((cardId) => player.zones.hand.includes(cardId))
    })
    expect(holders, '只能有一个人拿到遗产').toHaveLength(1)
    // 死者的下家是 p2，所以按座次是 p2 先
    expect(holders[0]).toBe('p2')
    const heir = game.state.players.find((player) => player.id === holders[0])!
    for (const cardId of estate) {
      expect(heir.zones.hand, `${cardId} 应当整套归继承人`).toContain(cardId)
      // 同一张实体牌不能同时出现在另一个牛来手上
      expect(game.state.players[0].zones.hand, '不能复制给第二个牛来').not.toContain(cardId)
    }
    expect(game.state.mamaBonds.p0, '两个牛来都失去麻麻').toBeUndefined()
    expect(game.state.mamaBonds.p2).toBeUndefined()
    assertGameInvariants(game.state)
  })

  it('牛来自己死亡时清除自己的认亲，不影响别的牛来（TEST 18）', () => {
    const game = gameWith(['niulai', 'zhangfei', 'niulai', 'zhangfei', 'zhangfei'])
    game.state.mamaBonds.p0 = 'p1'
    game.state.mamaBonds.p2 = 'p1'
    const dead = game.state.players[0]
    dead.hp = 1
    resolveDamage(game as never, { sourceId: 'p3', targetId: 'p0', amount: 1, nature: 'normal' })
    let guard = 0
    while (game.state.dying) {
      if (guard++ > 20) throw new Error('濒死没有收敛')
      const request = pending(game)!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }

    expect(game.state.players[0].alive).toBe(false)
    expect(game.state.mamaBonds.p0, '自己的关系清掉').toBeUndefined()
    expect(game.state.mamaBonds.p2, '另一个牛来不受影响').toBe('p1')
    assertGameInvariants(game.state)
  })

  it('被救回来就不算死亡，遗产一张都不动', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mama = game.state.players[1]
    game.state.zones.discardPile.push(...mama.zones.hand)
    mama.zones.hand = []
    const kept = give(game, 'p1', '桃')
    mama.hp = 1
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
    // 麻麻自己用桃救自己
    const rescue = pending(game)!
    expect(rescue.playerId).toBe('p1')
    game.respond({ requestId: rescue.id, playerId: 'p1', payload: { actionId: `rescue-card:${kept}` } })

    expect(game.state.players[1].alive).toBe(true)
    expect(game.state.mamaBonds.p0, '没死就还是麻麻').toBe('p1')
    expect(game.state.players[0].zones.hand, '牛来一张牌都不该拿到').toHaveLength(0)
    assertGameInvariants(game.state)
  })
})

describe('麻麻的联机与重连', () => {
  it('认亲关系和跟杀进度都能过 JSON（TEST 19）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mySlash = giveSlash(game, 'p0')
    useSlash(game, 'p1', ['p2'])
    passOthers(game)
    answer(game, { optionId: 'mama-follow' })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.mamaBonds).toEqual({ p0: 'p1' })
    expect(restored.state.skillResolution?.step, '停在选目标那一步').toBe('target')

    const request = restored.state.pendingRequests[0]
    restored.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p2'] } })
    restored.respond({
      requestId: restored.state.pendingRequests[0].id, playerId: 'p0', payload: { cardIds: [mySlash] },
    })
    while (restored.state.pendingRequests[0]?.playerId === 'p2') {
      restored.respond({ requestId: restored.state.pendingRequests[0].id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    }
    // 麻麻那一刀 4→3，重连之后的跟杀再打一下 3→2
    expect(restored.state.players[2].hp, '重连之后跟杀正常打完').toBe(2)
    assertGameInvariants(restored.state)
  })

  it('遗产结算之后重连，不会再发一次（TEST 19 续）', () => {
    const game = gameWith(MAMA_FILLER)
    clearHand(game, 'p0')
    const mama = game.state.players[1]
    game.state.zones.discardPile.push(...mama.zones.hand)
    mama.zones.hand = []
    give(game, 'p1', '桃')
    give(game, 'p1', '闪')
    mama.hp = 1
    resolveDamage(game as never, { sourceId: 'p2', targetId: 'p1', amount: 1, nature: 'normal' })
    while (game.state.dying) {
      const request = pending(game)!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    const handAfter = game.state.players[0].zones.hand.length
    expect(handAfter).toBe(2)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.players[0].zones.hand.length, '重连不会再分一次遗产').toBe(handAfter)
    expect(restored.state.mamaBonds.p0).toBeUndefined()
    assertGameInvariants(restored.state)
  })

  it('每名玩家看到的麻麻标记完全一致（TEST 20）', () => {
    const game = gameWith(['niulai', 'zhangfei', 'niulai', 'zhangfei', 'zhangfei'])
    game.state.mamaBonds.p0 = 'p1'
    game.state.mamaBonds.p2 = 'p1'
    const views = game.state.players.map((player) => game.viewFor(player.id).mamaBonds)
    for (const bonds of views) expect(bonds).toEqual({ p0: 'p1', p2: 'p1' })
  })
})
