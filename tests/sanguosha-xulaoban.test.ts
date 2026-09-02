import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { GANGGAN, KONGCHENGJI, debtOf } from '@/sanguosha/data/characters/entertainment-xulaoban'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { privateZoneCards } from '@/sanguosha/engine/private-zone'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 娱乐武将·许老板。
 *
 * 三处最容易做错的地方单独钉住：
 * 1. 「楼」是**扣置**的，别人的视图里连 cardId 都不该出现；
 * 2. 随机展示牌由**服务端**的 GameRng 决定，同一个 seed 必须复现同一张；
 * 3. 「债」在摸牌阶段**被跳过**时要留着，不能凭空掉血。
 */

function gameWith(characterIds: string[], seed = 'xulaoban'): SanguoshaGame {
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

/** 给某人一张指定牌名的牌，返回 cardId。 */
function give(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function skillAction(game: SanguoshaGame, skillId: string) {
  return game.legalActions('p0').find((action) => action.id === `skill:${skillId}`)
}

const FILLER = ['xulaoban', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

/** 走到「让谁猜」之后那一步：发动、选目标。 */
function towerAndTarget(game: SanguoshaGame, targetId: PlayerId = 'p1'): void {
  game.act('p0', skillAction(game, KONGCHENGJI)!.id)
  answer(game, { targetIds: [targetId] })
}

describe('许老板的基础信息', () => {
  it('群势力、4 体力、两个技能、娱乐包', () => {
    const character = getCharacter('xulaoban')!
    expect(character.kingdom).toBe('qun')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('entertainment')
    expect(character.skills.map((skill) => skill.id)).toEqual([KONGCHENGJI, GANGGAN])
  })
})

describe('空城计', () => {
  it('没有手牌时改为摸一张（测试 1）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.act('p0', skillAction(game, KONGCHENGJI)!.id)

    expect(game.state.players[0].zones.hand, '真空城：摸一张').toHaveLength(1)
    expect(game.state.pendingRequests, '不该再问谁来猜').toEqual([])
    expect(game.state.privateZones, '没有留下空的楼').toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('猜错：全部收回并摸两张（测试 2）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    // 全是基本牌，所以猜「不是基本牌」一定错
    const towered = ['杀', '闪', '桃'].map((name) => give(game, 'p0', name))
    towerAndTarget(game)

    const guess = pending(game)
    expect(guess?.playerId, '问的是猜的人').toBe('p1')
    answer(game, { optionId: 'kongchengji-other' })

    const owner = game.state.players[0]
    for (const cardId of towered) expect(owner.zones.hand, `${cardId} 应当被收回`).toContain(cardId)
    expect(owner.zones.hand, '收回三张 + 摸两张').toHaveLength(5)
    expect(game.state.players[1].zones.hand.some((id) => towered.includes(id)), '对方一张都拿不到').toBe(false)
    expect(game.state.privateZones).toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('猜对：对方获得展示牌，其余收回（测试 3）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const towered = ['杀', '闪', '桃'].map((name) => give(game, 'p0', name))
    const guestBefore = game.state.players[1].zones.hand.length
    towerAndTarget(game)
    answer(game, { optionId: 'kongchengji-basic' })

    const guest = game.state.players[1]
    const taken = towered.filter((cardId) => guest.zones.hand.includes(cardId))
    expect(taken, '正好拿走一张展示牌').toHaveLength(1)
    expect(guest.zones.hand).toHaveLength(guestBefore + 1)
    expect(game.state.players[0].zones.hand, '其余两张收回，没有额外摸牌').toHaveLength(2)
    expect(game.state.privateZones).toEqual([])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('猜的是随机那张，不是猜牌名——非基本牌在楼里时猜「有」会错', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    give(game, 'p0', '无中生有')
    towerAndTarget(game)
    answer(game, { optionId: 'kongchengji-basic' })

    // 楼里只有一张非基本牌，猜「是基本牌」必错 → 收回并摸两张
    expect(game.state.players[0].zones.hand, '收回一张 + 摸两张').toHaveLength(3)
    assertCardConservation(game.state)
  })

  it('扣置期间其他人看不到「楼」里的任何一张牌（测试 4）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const towered = ['杀', '闪', '桃'].map((name) => give(game, 'p0', name))
    towerAndTarget(game)

    expect(privateZoneCards(game.state, `${KONGCHENGJI}:p0`).sort()).toEqual([...towered].sort())
    for (const viewerId of ['p1', 'p2']) {
      const view = JSON.stringify(game.viewFor(viewerId))
      for (const cardId of towered) {
        expect(view, `${viewerId} 不该看到 ${cardId}`).not.toContain(cardId)
      }
    }
    // 许老板自己看得到——断线重连要靠它
    expect(JSON.stringify(game.viewFor('p0'))).toContain(towered[0])
    assertGameInvariants(game.state)
  })

  it('随机展示由服务端决定，同一个 seed 结果可复现（测试 5）', () => {
    const revealedFor = (seed: string): string => {
      const game = gameWith(FILLER, seed)
      clearHand(game, 'p0')
      const towered = ['杀', '闪', '桃'].map((name) => give(game, 'p0', name))
      towerAndTarget(game)
      answer(game, { optionId: 'kongchengji-basic' })
      return towered.find((cardId) => game.state.players[1].zones.hand.includes(cardId))!
    }
    expect(revealedFor('same-seed')).toBe(revealedFor('same-seed'))
  })

  it('过一遍 JSON 之后仍能接着猜，且不会重复发牌（测试 11）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const towered = ['杀', '闪', '桃'].map((name) => give(game, 'p0', name))
    towerAndTarget(game)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(privateZoneCards(restored.state, `${KONGCHENGJI}:p0`).sort()).toEqual([...towered].sort())
    const request = restored.state.pendingRequests[0]
    restored.respond({ requestId: request.id, playerId: 'p1', payload: { optionId: 'kongchengji-other' } })

    expect(restored.state.players[0].zones.hand, '收回三张 + 摸两张，没有多发').toHaveLength(5)
    expect(restored.state.privateZones).toEqual([])
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.act('p0', skillAction(game, KONGCHENGJI)!.id)
    expect(skillAction(game, KONGCHENGJI), '同一个出牌阶段不能再来').toBeUndefined()
  })
})

describe('杠杆：借牌', () => {
  for (const amount of [1, 2, 3]) {
    it(`借 ${amount} 张：摸 ${amount} 张并背上 ${amount} 枚债（测试 6）`, () => {
      const game = gameWith(FILLER)
      clearHand(game, 'p0')
      game.act('p0', skillAction(game, GANGGAN)!.id)
      answer(game, { optionId: `ganggan-borrow:${amount}` })

      expect(game.state.players[0].zones.hand).toHaveLength(amount)
      expect(debtOf(game.state, 'p0')).toBe(amount)
      assertCardConservation(game.state)
      assertGameInvariants(game.state)
    })
  }

  it('取消就不借也不欠', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.act('p0', skillAction(game, GANGGAN)!.id)
    answer(game, { optionId: 'cancel' })
    expect(game.state.players[0].zones.hand).toHaveLength(0)
    expect(debtOf(game.state, 'p0')).toBe(0)
  })

  it('债可以累计，出牌阶段限一次', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 1
    game.act('p0', skillAction(game, GANGGAN)!.id)
    answer(game, { optionId: 'ganggan-borrow:2' })
    expect(debtOf(game.state, 'p0')).toBe(3)
    expect(skillAction(game, GANGGAN)).toBeUndefined()
  })
})

describe('杠杆：还债', () => {
  /**
   * 让 p0 走一次完整的摸牌阶段。
   *
   * 摸牌阶段结束后如果还欠债，会停在「弃牌抵债」的询问上——那一步由各用例
   * 自己回答，这里不替它决定。
   */
  function runDrawPhase(game: SanguoshaGame): void {
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'judge'
    game.advancePhase()
    expect(game.state.phase).toBe('draw')
    game.advancePhase()
  }

  /** 回答「弃牌抵债」：交出指定的牌（空数组＝一张都不还）。 */
  function repay(game: SanguoshaGame, cardIds: string[]): void {
    const request = pending(game)
    expect(request?.kind, '应当在问要不要弃牌抵债').toBe('choose-cards')
    expect(request?.prompt).toContain('还欠')
    answer(game, { cardIds })
  }

  it('2 债遇上正常摸 2：摸 0 张，债清空且不掉血（测试 7）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 2
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)

    expect(game.state.players[0].zones.hand, '一张都摸不到').toHaveLength(0)
    expect(debtOf(game.state, 'p0'), '两枚债正好还清').toBe(0)
    expect(game.state.players[0].hp, '还清了就不掉血').toBe(hpBefore)
    expect(pending(game), '债已经还完，不该再问弃牌').toBeUndefined()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('3 债遇上正常摸 2：摸 0 张，剩 1 债，不还就失去 1 点体力（测试 8）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    give(game, 'p0', '桃')
    game.state.players[0].marks.debt = 3
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    // 摸牌阶段一张都摸不到，手上只剩本来那张桃
    expect(game.state.players[0].zones.hand).toHaveLength(1)
    repay(game, [])

    expect(game.state.players[0].hp, '不还就失去一点体力').toBe(hpBefore - 1)
    expect(debtOf(game.state, 'p0'), '剩下的债一笔勾销').toBe(0)
    assertGameInvariants(game.state)
  })

  it('剩 1 债时弃一张牌就能还清，不掉血', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const kept = give(game, 'p0', '桃')
    game.state.players[0].marks.debt = 3
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    repay(game, [kept])

    expect(game.state.players[0].hp, '还清了就不掉血').toBe(hpBefore)
    expect(game.state.players[0].zones.hand, '那张牌真的弃掉了').toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(kept)
    expect(debtOf(game.state, 'p0')).toBe(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('剩 2 债只还 1 张：另一枚照样扣 1 点体力', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const first = give(game, 'p0', '桃')
    give(game, 'p0', '闪')
    game.state.players[0].marks.debt = 4
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    const request = pending(game)
    expect(request?.kind === 'choose-cards' && request.max, '最多按剩下的债数弃牌').toBe(2)
    repay(game, [first])

    expect(game.state.players[0].hp, '少还一枚就掉一点').toBe(hpBefore - 1)
    expect(debtOf(game.state, 'p0')).toBe(0)
    assertGameInvariants(game.state)
  })

  it('还不上的债有几枚就掉几点体力', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 5
    const hpBefore = game.state.players[0].hp

    // 手上一张牌都没有，连问都不该问，直接按还不上处理
    runDrawPhase(game)
    expect(pending(game), '没牌可弃就不弹窗').toBeUndefined()
    expect(game.state.players[0].hp, '剩 3 枚还不上，掉 3 点').toBe(hpBefore - 3)
    expect(debtOf(game.state, 'p0')).toBe(0)
    assertGameInvariants(game.state)
  })

  it('装备区的牌也能拿来抵债', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const weapon = game.state.zones.drawPile.find((id) => game.state.cards[id].equipmentSlot === 'weapon')!
    moveCard(game.state, weapon, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'weapon' })
    game.state.players[0].marks.debt = 3
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    const request = pending(game)
    expect(request?.kind === 'choose-cards' && request.cardIds, '装备在可弃列表里').toContain(weapon)
    repay(game, [weapon])

    expect(game.state.players[0].hp, '用装备还清了就不掉血').toBe(hpBefore)
    expect(game.state.players[0].zones.equipment.weapon).toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('1 债遇上正常摸 2：还是摸到 1 张', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 1
    runDrawPhase(game)
    expect(game.state.players[0].zones.hand, '少摸一张，不是一张都不摸').toHaveLength(1)
    expect(debtOf(game.state, 'p0')).toBe(0)
    expect(game.state.players[0].hp).toBe(4)
  })

  it('摸牌阶段被跳过：债保留，也不掉血（测试 9）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 3
    const hpBefore = game.state.players[0].hp

    game.state.currentPlayerId = 'p0'
    game.state.phase = 'judge'
    game.state.skippedPhases = ['draw']
    game.advancePhase()

    expect(game.state.phase, '直接跳到出牌阶段').toBe('play')
    expect(debtOf(game.state, 'p0'), '债留到下一次真正摸牌').toBe(3)
    expect(game.state.players[0].hp, '跳过摸牌不该扣血').toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('没有债时摸牌阶段照常摸两张', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    runDrawPhase(game)
    expect(game.state.players[0].zones.hand).toHaveLength(2)
  })

  it('还债掉血是「失去体力」，不触发受伤技能（测试 10）', () => {
    const game = gameWith(['xulaoban', 'caocao', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 3
    const damaged: unknown[] = []
    game.events.on('Damaged', (context) => { damaged.push(context.event.targetId) })

    game.state.currentPlayerId = 'p0'
    game.state.phase = 'judge'
    game.advancePhase()
    game.advancePhase()
    // 手上一张牌都没有，不会问弃牌，直接按还不上处理

    expect(game.state.players[0].hp).toBe(3)
    expect(damaged, '失去体力不是伤害——奸雄、遗计、刚烈都不该被触发').toEqual([])
    assertGameInvariants(game.state)
  })

  it('债一路带到下一次摸牌阶段，不会在中途重复结算（测试 11）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 3

    // 先过一遍序列化，模拟中途重连
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(debtOf(restored.state, 'p0')).toBe(3)

    restored.state.currentPlayerId = 'p0'
    restored.state.phase = 'judge'
    restored.advancePhase()
    restored.advancePhase()
    // 没牌可弃，直接按还不上处理
    expect(restored.state.pendingRequests).toEqual([])

    expect(restored.state.players[0].zones.hand).toHaveLength(0)
    expect(restored.state.players[0].hp, '只结算一次').toBe(3)
    expect(debtOf(restored.state, 'p0')).toBe(0)
    assertGameInvariants(restored.state)
  })
})
