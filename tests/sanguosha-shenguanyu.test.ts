import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import { getDistance } from '@/sanguosha/engine/distance'
import { NIGHTMARE_MARK } from '@/sanguosha/data/characters/god-shenguanyu'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神关羽。经典「神话再临·神」版本。
 *
 * 两条最容易做错的地方，各钉了一组：
 *
 * 1. **武神是「可以当杀使用」，不是永久改名**——一张红桃【桃】在需要桃的时候
 *    仍然首先是桃；而且无距离**只对红桃载体**生效，手上真的黑桃【杀】照常讲距离。
 * 2. **武魂按点数累计**，一次受到 2 点伤害给 2 枚梦魇；死亡结算在**真正死亡之后**，
 *    候选是**其他角色**，判定认【桃】和【桃园结义】两种。
 */

function gameWith(characterIds: string[], seed = 'shenguanyu'): SanguoshaGame {
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
  return game
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit; category: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  return card.id
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: string[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  for (const player of game.state.players) player.turnUsedSkills = []
}

const FIVE = ['shenguanyu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('武神：红桃手牌当【杀】', () => {
  it('红桃手牌产出「当杀使用」的动作', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const heart = findCard(game, (card) => card.suit === 'heart' && card.name !== '杀')
    giveHand(game, 'p0', [heart])
    enterPlay(game, 'p0')

    const actions = game.legalActions('p0')
    const wushen = actions.filter((action) => action.kind === 'use-card' && action.asCardName === '杀' && action.cardIds.includes(heart))
    expect(wushen.length, '红桃牌应该能当杀用').toBeGreaterThan(0)
  })

  it('非红桃手牌不产出武神的杀', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const spade = findCard(game, (card) => card.suit === 'spade' && card.name !== '杀')
    giveHand(game, 'p0', [spade])
    enterPlay(game, 'p0')

    const actions = game.legalActions('p0')
    expect(
      actions.some((action) => action.kind === 'use-card' && action.asCardName === '杀' && action.cardIds.includes(spade)),
      '黑桃牌不该能当杀',
    ).toBe(false)
  })

  it('只认手牌：装备区和判定区的红桃都不算', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const owner = playerOf(game, 'p0')
    const heartArmor = findCard(game, (card) => card.suit === 'heart' && card.category === 'equipment')
    detach(game, heartArmor)
    owner.zones.equipment.armor = heartArmor
    const heartTrick = findCard(game, (card) => card.suit === 'heart' && card.name === '乐不思蜀')
    if (heartTrick) { detach(game, heartTrick); owner.zones.judgingArea.push(heartTrick) }
    enterPlay(game, 'p0')

    const actions = game.legalActions('p0')
    for (const action of actions) {
      if (action.kind !== 'use-card' || action.asCardName !== '杀') continue
      expect(action.cardIds, '装备区的红桃不能当杀').not.toContain(heartArmor)
      if (heartTrick) expect(action.cardIds, '判定区的红桃不能当杀').not.toContain(heartTrick)
    }
  })

  it('红桃【桃】仍然首先是一张桃：两条动作并存，不是永久改名', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const peach = findCard(game, (card) => card.name === '桃' && card.suit === 'heart')
    giveHand(game, 'p0', [peach])
    playerOf(game, 'p0').hp = 3
    enterPlay(game, 'p0')

    const actions = game.legalActions('p0')
    expect(
      actions.some((action) => action.kind === 'use-card' && action.asCardName === '桃' && action.cardIds.includes(peach)),
      '受伤时这张红桃桃仍然能当桃用',
    ).toBe(true)
    expect(
      actions.some((action) => action.kind === 'use-card' && action.asCardName === '杀' && action.cardIds.includes(peach)),
      '同时也能当杀用',
    ).toBe(true)
    expect(game.state.cards[peach].name, '牌面没有被改掉').toBe('桃')
  })
})

describe('武神：无距离限制只对红桃生效', () => {
  it('红桃当的杀可以打到距离外的人', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const heart = findCard(game, (card) => card.suit === 'heart' && card.name !== '杀')
    giveHand(game, 'p0', [heart])
    enterPlay(game, 'p0')
    // 五人局里 p2 距离 2，基础攻击范围 1 够不着
    expect(getDistance(game.state, 'p0', 'p2')).toBeGreaterThan(1)

    const actions = game.legalActions('p0')
    const far = actions.find((action) => (
      action.kind === 'use-card' && action.asCardName === '杀'
      && action.cardIds.includes(heart) && action.targetIds.includes('p2')
    ))
    expect(far, '武神的红桃杀无距离限制').toBeTruthy()
  })

  it('手上真的黑桃【杀】仍然讲距离', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const blackSlash = findCard(game, (card) => card.name === '杀' && (card.suit === 'spade' || card.suit === 'club'))
    giveHand(game, 'p0', [blackSlash])
    enterPlay(game, 'p0')

    const actions = game.legalActions('p0')
    const far = actions.find((action) => (
      action.kind === 'use-card' && action.asCardName === '杀'
      && action.cardIds.includes(blackSlash) && action.targetIds.includes('p2')
    ))
    expect(far, '无距离**只对红桃载体**生效，真杀照常讲距离').toBeUndefined()
  })

  it('其余合法性仍然检查：不能打自己', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    giveHand(game, 'p0', [findCard(game, (card) => card.suit === 'heart' && card.name !== '杀')])
    enterPlay(game, 'p0')
    const actions = game.legalActions('p0')
    for (const action of actions) {
      if (action.kind === 'use-card' && action.asCardName === '杀') {
        expect(action.targetIds, '不能把自己当目标').not.toContain('p0')
      }
    }
  })

  it('红桃杀走完整结算：目标要被求闪', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    const heart = findCard(game, (card) => card.suit === 'heart' && card.name !== '杀' && card.category !== 'equipment')
    giveHand(game, 'p0', [heart])
    clearHand(game, 'p1')
    // 排除刚给 p0 的那张：findCard 会返回同一张红桃【闪】，
    // 再 giveHand 给 p1 就把它从神关羽手上搬走了，武神动作自然就没了
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '闪' && card.id !== heart)])
    enterPlay(game, 'p0')

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.asCardName === '杀'
      && candidate.cardIds.includes(heart) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)

    const request = game.state.pendingRequests[0]
    expect(request?.kind, '转化出来的杀走的是同一条求闪管线').toBe('respond-card')
    expect(request.playerId).toBe('p1')
    expect(request.requiredCardName).toBe('闪')
    assertCardConservation(game.state)
  })
})

describe('武魂：梦魇标记', () => {
  function damage(game: SanguoshaGame, targetId: PlayerId, sourceId: PlayerId | null, amount: number): void {
    game.damage({ sourceId, targetId, amount, cardName: null })
  }

  it('受到 1 点伤害，来源得 1 枚梦魇', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 1)
    expect(playerOf(game, 'p1').marks[NIGHTMARE_MARK]).toBe(1)
  })

  it('一次受到 2 点伤害，来源得 2 枚——按点数累计，不是一次一枚', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 2)
    expect(playerOf(game, 'p1').marks[NIGHTMARE_MARK], '2 点伤害要给 2 枚').toBe(2)
  })

  it('多次伤害持续累加', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 1)
    damage(game, 'p0', 'p1', 1)
    expect(playerOf(game, 'p1').marks[NIGHTMARE_MARK]).toBe(2)
  })

  it('多个来源各自累计', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 1)
    damage(game, 'p0', 'p2', 2)
    expect(playerOf(game, 'p1').marks[NIGHTMARE_MARK]).toBe(1)
    expect(playerOf(game, 'p2').marks[NIGHTMARE_MARK]).toBe(2)
  })

  it('无来源的伤害（闪电、崩坏）不给梦魇', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', null, 2)
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(playerOf(game, id).marks[NIGHTMARE_MARK] ?? 0, '没有来源就不该有人拿到梦魇').toBe(0)
    }
  })

  it('别人受到伤害不产生梦魇', () => {
    const game = gameWith(FIVE)
    damage(game, 'p1', 'p2', 2)
    expect(playerOf(game, 'p2').marks[NIGHTMARE_MARK] ?? 0).toBe(0)
  })

  it('梦魇在 PlayerView 里是公开信息', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 2)
    const view = game.viewFor('p3')
    expect(view.players.find((player) => player.id === 'p1')!.marks[NIGHTMARE_MARK]).toBe(2)
  })

  it('梦魇可以序列化恢复', () => {
    const game = gameWith(FIVE)
    damage(game, 'p0', 'p1', 2)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(restored.state.players.find((player) => player.id === 'p1')!.marks[NIGHTMARE_MARK]).toBe(2)
  })
})

describe('武魂：死亡后的惩罚', () => {
  /** 把某张牌顶到牌堆顶，让下一次判定必定翻到它。 */
  function stackJudgment(game: SanguoshaGame, cardId: string): void {
    detach(game, cardId)
    game.state.zones.drawPile.unshift(cardId)
  }

  function killShenguanyu(game: SanguoshaGame): void {
    const owner = playerOf(game, 'p0')
    owner.hp = 1
    // 用一个没有来源的伤害杀死他，避免再给别人加梦魇干扰断言
    game.damage({ sourceId: null, targetId: 'p0', amount: 5, cardName: null })
  }

  it('判定不为【桃】：梦魇最多的角色死亡，走统一死亡管线', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').marks[NIGHTMARE_MARK] = 3
    playerOf(game, 'p2').marks[NIGHTMARE_MARK] = 1
    stackJudgment(game, findCard(game, (card) => card.name === '杀'))

    killShenguanyu(game)
    expect(playerOf(game, 'p0').alive, '神关羽自己已经死了').toBe(false)
    expect(playerOf(game, 'p1').alive, '梦魇最多的人被夺去性命').toBe(false)
    expect(playerOf(game, 'p2').alive, '梦魇少的人不受影响').toBe(true)
    assertGameInvariants(game.state)
    assertCardConservation(game.state)
  })

  it('判定为【桃】：该角色不死', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').marks[NIGHTMARE_MARK] = 2
    stackJudgment(game, findCard(game, (card) => card.name === '桃'))
    killShenguanyu(game)
    expect(playerOf(game, 'p1').alive, '判定是桃就活下来').toBe(true)
  })

  it('判定为【桃园结义】同样算过关', () => {
    const game = gameWith(FIVE)
    playerOf(game, 'p1').marks[NIGHTMARE_MARK] = 2
    stackJudgment(game, findCard(game, (card) => card.name === '桃园结义'))
    killShenguanyu(game)
    expect(playerOf(game, 'p1').alive, '桃园结义也算').toBe(true)
  })

  it('没有人有梦魇时什么都不发生', () => {
    const game = gameWith(FIVE)
    killShenguanyu(game)
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(playerOf(game, id).alive, `${id} 不该受影响`).toBe(true)
    }
  })

  it('并列最多时由神关羽指定，候选里没有他自己', () => {
    const game = gameWith(FIVE)
    /*
     * 神关羽默认坐主公位，主公一死牌局立刻结束、待处理请求会被清掉，
     * 就看不到「并列时问他选谁」这一步了。把身份挪开，让他的死亡不终结牌局。
     */
    playerOf(game, 'p0').identity = 'rebel'
    playerOf(game, 'p1').identity = 'lord'
    playerOf(game, 'p1').marks[NIGHTMARE_MARK] = 2
    playerOf(game, 'p2').marks[NIGHTMARE_MARK] = 2
    // 神关羽自己也挂上梦魇，验证他不会成为候选
    playerOf(game, 'p0').marks[NIGHTMARE_MARK] = 9

    killShenguanyu(game)
    const request = game.state.pendingRequests[0]
    expect(request?.kind, '并列时要问神关羽选谁').toBe('choose-targets')
    expect(request.playerId).toBe('p0')
    expect(request.candidateIds.sort()).toEqual(['p1', 'p2'])
    expect(request.candidateIds, '候选里不该有神关羽自己').not.toContain('p0')
  })
})
