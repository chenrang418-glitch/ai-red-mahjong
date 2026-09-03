import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import {
  GANGGAN, KONGCHENGJI, KONGSHOUTAOBAILANG, KONGSHOU_LIMIT_TURN_MARK, KONGSHOU_USED_MARK, debtOf,
} from '@/sanguosha/data/characters/entertainment-xulaoban'
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

function declineKongshouIfAsked(game: SanguoshaGame): void {
  if (pending(game)?.prompt.includes('空手套白狼')) answer(game, { optionId: 'cancel' })
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
  it('群势力、4 体力、三个技能、娱乐包', () => {
    const character = getCharacter('xulaoban')!
    expect(character.kingdom).toBe('qun')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('entertainment')
    expect(character.skills.map((skill) => skill.id)).toEqual([KONGCHENGJI, GANGGAN, KONGSHOUTAOBAILANG])
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
   * 摸牌阶段先照常摸牌，结束后会停在「弃牌抵债」的询问上——那一步由各用例
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

  it('借 2 张：下个摸牌阶段正常摸 2，再自选弃 2（测试 7）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 2
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    expect(game.state.players[0].zones.hand, '正常摸两张').toHaveLength(2)
    expect(debtOf(game.state, 'p0'), '选择弃牌前债仍在').toBe(2)
    repay(game, [...game.state.players[0].zones.hand])

    expect(game.state.players[0].zones.hand).toHaveLength(0)
    expect(debtOf(game.state, 'p0')).toBe(0)
    expect(game.state.players[0].hp, '还清了就不掉血').toBe(hpBefore)
    declineKongshouIfAsked(game)
    expect(pending(game), '债已经还完，不该再问弃牌').toBeUndefined()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('4 债但摸牌后只有 3 张可弃牌：全部弃置且只失去 1 点体力（测试 8）', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    give(game, 'p0', '桃')
    game.state.players[0].marks.debt = 4
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    expect(game.state.players[0].zones.hand, '不足时三张全部自动弃掉').toHaveLength(0)
    expect(game.state.players[0].hp, '无论差几张都只失去一点体力').toBe(hpBefore - 1)
    expect(debtOf(game.state, 'p0')).toBe(0)
    declineKongshouIfAsked(game)
    expect(pending(game), '没有选择空间时不弹空请求').toBeUndefined()
    assertGameInvariants(game.state)
  })

  it('3 债且有 3 张可弃牌：必须自选弃 3，不掉血', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const kept = give(game, 'p0', '桃')
    game.state.players[0].marks.debt = 3
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    expect(game.state.players[0].zones.hand).toHaveLength(3)
    repay(game, [...game.state.players[0].zones.hand])

    expect(game.state.players[0].hp, '还清了就不掉血').toBe(hpBefore)
    expect(game.state.players[0].zones.hand, '三张牌都弃掉了').toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(kept)
    expect(debtOf(game.state, 'p0')).toBe(0)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('牌足够时请求必须精确选择债数，不能主动少还', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    give(game, 'p0', '桃')
    give(game, 'p0', '闪')
    game.state.players[0].marks.debt = 4
    const hpBefore = game.state.players[0].hp

    runDrawPhase(game)
    const request = pending(game)
    expect(request?.kind === 'choose-cards' && request.min).toBe(4)
    expect(request?.kind === 'choose-cards' && request.max).toBe(4)
    expect(() => repay(game, game.state.players[0].zones.hand.slice(0, 1))).toThrow('卡牌选择非法')
    repay(game, [...game.state.players[0].zones.hand])

    expect(game.state.players[0].hp).toBe(hpBefore)
    expect(debtOf(game.state, 'p0')).toBe(0)
    assertGameInvariants(game.state)
  })

  it('不足债数量时无论差几张都只失去 1 点体力', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 5
    const hpBefore = game.state.players[0].hp

    // 手上一张牌都没有，连问都不该问，直接按还不上处理
    runDrawPhase(game)
    declineKongshouIfAsked(game)
    expect(pending(game), '没牌可弃就不弹窗').toBeUndefined()
    expect(game.state.players[0].zones.hand, '正常摸到的两张也要全部弃置').toHaveLength(0)
    expect(game.state.players[0].hp, '差三张仍只掉一点').toBe(hpBefore - 1)
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
    repay(game, [weapon, ...game.state.players[0].zones.hand])

    expect(game.state.players[0].hp, '用装备还清了就不掉血').toBe(hpBefore)
    expect(game.state.players[0].zones.equipment.weapon).toBeNull()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('1 债遇上正常摸 2：先摸足 2 张，再弃 1 张', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].marks.debt = 1
    runDrawPhase(game)
    expect(game.state.players[0].zones.hand, '正常摸足两张').toHaveLength(2)
    expect(debtOf(game.state, 'p0')).toBe(1)
    repay(game, [game.state.players[0].zones.hand[0]])
    expect(game.state.players[0].zones.hand).toHaveLength(1)
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
    // 正常摸两张，但不足三债，自动全弃并失去一点体力

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
    // 正常摸两张但不足三债，自动按还不上处理
    declineKongshouIfAsked(restored)
    expect(restored.state.pendingRequests).toEqual([])

    expect(restored.state.players[0].zones.hand).toHaveLength(0)
    expect(restored.state.players[0].hp, '只结算一次').toBe(3)
    expect(debtOf(restored.state, 'p0')).toBe(0)
    assertGameInvariants(restored.state)
  })
})

describe('空手套白狼', () => {
  function openWindow(game: SanguoshaGame, currentPlayerId: PlayerId = 'p1'): void {
    const target = game.state.players.find((player) => player.id === currentPlayerId)!
    const previous = game.state.players[(target.seat - 1 + game.state.players.length) % game.state.players.length]
    game.state.currentPlayerId = previous.id
    game.state.phase = 'finish'
    game.advancePhase()
    expect(game.state.currentPlayerId).toBe(currentPlayerId)
  }

  function invoke(game: SanguoshaGame): void {
    const request = pending(game)
    expect(request?.kind).toBe('choose-option')
    expect(request?.playerId).toBe('p0')
    expect(request?.prompt).toContain('空手套白狼')
    answer(game, { optionId: 'kongshou-invoke' })
  }

  it('有手牌时不能发动', () => {
    const game = gameWith(FILLER)
    expect(game.state.players[0].zones.hand.length).toBeGreaterThan(0)
    openWindow(game)
    expect(pending(game)).toBeUndefined()
  })

  it('0 手牌且其他角色有牌时，可在其他角色回合的安全窗口发动', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    openWindow(game, 'p1')
    invoke(game)

    expect(game.state.players[0].zones.hand).toHaveLength(4)
    expect(game.state.players[0].marks[KONGSHOU_USED_MARK]).toBe(1)
    expect(game.state.players[0].marks[KONGSHOU_LIMIT_TURN_MARK]).toBe(game.state.turnNumber)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('从每名有手牌的其他存活角色处各随机获得一张', () => {
    const game = gameWith(FILLER, 'kongshou-four-targets')
    clearHand(game, 'p0')
    const before = game.state.players.slice(1).map((player) => player.zones.hand.length)
    openWindow(game)
    invoke(game)

    expect(game.state.players[0].zones.hand).toHaveLength(4)
    game.state.players.slice(1).forEach((player, index) => {
      expect(player.zones.hand).toHaveLength(before[index] - 1)
    })
    assertCardConservation(game.state)
  })

  it('没有手牌的角色会被跳过，随机结果由 seed 确定', () => {
    const run = () => {
      const game = gameWith(FILLER, 'kongshou-deterministic')
      clearHand(game, 'p0')
      clearHand(game, 'p2')
      openWindow(game)
      invoke(game)
      return game.state.players[0].zones.hand.map((id) => game.state.cards[id].name)
    }
    expect(run()).toEqual(run())
    expect(run()).toHaveLength(3)
  })

  it('不会向无关观察者泄露其他角色剩余手牌或取得牌的 cardId', () => {
    const game = gameWith(FILLER, 'kongshou-hidden')
    clearHand(game, 'p0')
    const p2Before = [...game.state.players[2].zones.hand]
    openWindow(game)
    invoke(game)

    const stolenFromP2 = p2Before.find((id) => !game.state.players[2].zones.hand.includes(id))!
    const observerView = JSON.stringify(game.viewFor('p1'))
    expect(observerView).not.toContain(stolenFromP2)
    for (const cardId of game.state.players[2].zones.hand) expect(observerView).not.toContain(cardId)
  })

  it('发动后当前回合手牌上限固定为 2，回合结束恢复正常', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    openWindow(game, 'p0')
    invoke(game)
    expect(game.state.players[0].zones.hand).toHaveLength(4)

    game.state.phase = 'play'
    game.advancePhase()
    const discard = pending(game)
    expect(discard?.kind).toBe('choose-cards')
    expect(discard?.kind === 'choose-cards' && discard.purpose).toBe('discard-phase')
    expect(discard?.kind === 'choose-cards' && discard.min, '固定上限 2，应弃两张').toBe(2)
    answer(game, { cardIds: game.state.players[0].zones.hand.slice(0, 2) })

    game.state.phase = 'finish'
    game.advancePhase()
    expect(game.state.players[0].marks[KONGSHOU_LIMIT_TURN_MARK]).toBeUndefined()
  })

  it('卡牌结算中不会插入发问，结算结束后才出现合法窗口', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const slash = give(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)

    expect(game.state.cardResolution).not.toBeNull()
    expect(game.state.pendingRequests.some((request) => request.playerId === 'p0' && request.prompt.includes('空手套白狼'))).toBe(false)
    answer(game, { actionId: 'respond-pass' })

    expect(game.state.cardResolution).toBeNull()
    expect(pending(game)?.prompt).toContain('空手套白狼')
  })

  it('限定技整局只能发动一次，序列化重连后也不能重复', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    openWindow(game)
    invoke(game)

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.players[0].marks[KONGSHOU_USED_MARK]).toBe(1)
    clearHand(restored, 'p0')
    restored.state.currentPlayerId = 'p2'
    restored.state.phase = 'prepare'
    restored.advancePhase()
    expect(restored.state.pendingRequests).toEqual([])
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })
})
