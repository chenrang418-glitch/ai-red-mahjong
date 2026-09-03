import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 林包·贾诩【完杀】【乱武】【帷幕】。经典首版。
 *
 * 三条最容易做错的地方：
 *
 * 1. **完杀限制的是【桃】，不是【酒】**，而且要挡住实体桃、转化桃和蛊惑桃三条路；
 *    只在贾诩自己的回合内生效，濒死者本人和贾诩自己不受限。
 * 2. **帷幕是「不能成为目标」**，和祸首/巨象的「成为目标但无效」是两回事：
 *    黑色锦囊在生成动作时就把贾诩排除掉，全体锦囊也一样。
 *    颜色看**实体牌**的有效颜色，所以火计（红牌当火攻）挡不住。
 * 3. **乱武的伤害来源是出杀的人，不是贾诩**；每轮到一个人都要重算距离。
 */

function gameWith(characterIds: string[], seed = 'jiaxu'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
    // 直接塞 characterId 会绕过选将，体力上限得自己按引擎那条规则补
    const character = getCharacter(characterIds[index])!
    player.maxHp = character.maxHp + (player.identity === 'lord' ? 1 : 0)
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

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function findCard(game: SanguoshaGame, match: (card: { id: string; name: string; suit: Suit }) => boolean, used = new Set<string>()): string {
  const card = Object.values(game.state.cards).find((candidate) => !used.has(candidate.id) && match(candidate))
  if (!card) throw new Error('这副牌里找不到符合条件的牌')
  used.add(card.id)
  return card.id
}

function give(game: SanguoshaGame, playerId: PlayerId, cardId: string): string {
  detach(game, cardId)
  playerOf(game, playerId).zones.hand.push(cardId)
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

const FIVE = ['jiaxu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('帷幕：不能成为黑色锦囊牌的目标', () => {
  /** p1 拿一张指定牌，返回它能指定的目标。 */
  function trickTargets(game: SanguoshaGame, cardName: string, suit: Suit): PlayerId[] {
    const cardId = give(game, 'p1', findCard(game, (card) => card.name === cardName && card.suit === suit))
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    return game.legalActions('p1')
      .filter((action) => action.kind === 'use-card' && action.asCardName === cardName)
      .flatMap((action) => action.kind === 'use-card' ? action.targetIds : [])
  }

  it('黑色普通锦囊不能指定贾诩', () => {
    const game = gameWith(FIVE)
    // 只清使用者的手牌：过河拆桥要求目标有牌可拆，全场清空就没有合法目标了
    clearHand(game, 'p1')
    const targets = trickTargets(game, '过河拆桥', 'spade')
    expect(targets.length, '别人照样能被指定').toBeGreaterThan(0)
    expect(targets, '贾诩不在目标里').not.toContain('p0')
  })

  it('红色锦囊照常可以指定贾诩', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    expect(trickTargets(game, '过河拆桥', 'heart')).toContain('p0')
  })

  it('黑色延时锦囊也挡——延时锦囊同样是锦囊', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const targets = trickTargets(game, '兵粮寸断', 'club')
    expect(targets).not.toContain('p0')
  })

  it('黑色的【杀】照常能指定贾诩——帷幕只挡锦囊', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const slash = give(game, 'p1', findCard(game, (card) => card.name === '杀' && card.suit === 'spade'))
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    expect(game.legalActions('p1').some((action) => action.id === `play:${slash}:p0`)).toBe(true)
  })

  it('全体锦囊会把贾诩从目标列表里剔掉，而不是不能使用', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const nanman = give(game, 'p1', findCard(game, (card) => card.name === '南蛮入侵'))
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const action = game.legalActions('p1').find((candidate) => candidate.id.startsWith(`play:${nanman}:`))
    expect(action, '南蛮仍然能用').toBeTruthy()
    const black = game.state.cards[nanman].color === 'black'
    if (black) {
      expect(action!.kind === 'use-card' && action!.targetIds, '黑色南蛮的目标里没有贾诩').not.toContain('p0')
    }
  })

  it('转化技看的是实体牌颜色：黑牌换来的锦囊挡得住', () => {
    // 甘宁【奇袭】把一张黑牌当过河拆桥用，实体牌是黑的
    const game = gameWith(['jiaxu', 'ganning', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p1')
    const black = give(game, 'p1', findCard(game, (card) => card.suit === 'spade' && card.name !== '过河拆桥'))
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const targets = game.legalActions('p1')
      .filter((action) => action.kind === 'use-card' && action.asCardName === '过河拆桥' && action.cardIds.includes(black))
      .flatMap((action) => action.kind === 'use-card' ? action.targetIds : [])
    expect(targets.length).toBeGreaterThan(0)
    expect(targets, '实体牌是黑的，帷幕挡得住').not.toContain('p0')
  })

  it('红牌换来的锦囊挡不住——火计的实体牌是红的', () => {
    const game = gameWith(['jiaxu', 'wolongzhuge', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p1')
    const red = give(game, 'p1', findCard(game, (card) => card.suit === 'heart' && card.name !== '火攻'))
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const targets = game.legalActions('p1')
      .filter((action) => action.kind === 'use-card' && action.asCardName === '火攻' && action.cardIds.includes(red))
      .flatMap((action) => action.kind === 'use-card' ? action.targetIds : [])
    expect(targets, '实体牌是红的，帷幕不挡').toContain('p0')
  })
})

describe('完杀：贾诩回合内限制他人使用桃', () => {
  /** 把 victim 打到濒死，返回当前求桃请求。 */
  function pushToDying(game: SanguoshaGame, victimId: PlayerId) {
    playerOf(game, victimId).hp = 1
    game.damage({ sourceId: 'p1', targetId: victimId, amount: 1, cardName: null })
    return pending(game)
  }

  it('贾诩回合内，其他人不能用桃救人', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    give(game, 'p3', findCard(game, (card) => card.name === '桃'))
    game.state.currentPlayerId = 'p0'

    const request = pushToDying(game, 'p2')
    // p3 手上有桃但被完杀挡住，所以根本不会被问到
    const asked = request?.playerId
    expect(asked, 'p3 拿着桃也不该被问').not.toBe('p3')
  })

  it('濒死者自己可以用桃救自己', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const peach = give(game, 'p2', findCard(game, (card) => card.name === '桃'))
    game.state.currentPlayerId = 'p0'

    const request = pushToDying(game, 'p2')
    expect(request?.kind).toBe('rescue')
    expect(request.playerId).toBe('p2')
    expect((request as { actionIds: string[] }).actionIds).toContain(`rescue-card:${peach}`)
  })

  it('贾诩自己可以用桃救人', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const peach = give(game, 'p0', findCard(game, (card) => card.name === '桃'))
    game.state.currentPlayerId = 'p0'

    pushToDying(game, 'p2')
    // 濒死者自己没桃会被跳过，直接问到贾诩
    for (let guard = 0; guard < 10; guard += 1) {
      const request = pending(game)
      if (!request) break
      if (request.playerId === 'p0') {
        expect((request as { actionIds: string[] }).actionIds).toContain(`rescue-card:${peach}`)
        return
      }
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    throw new Error('贾诩没有被问到')
  })

  it('不是贾诩的回合就完全不生效', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const peach = give(game, 'p3', findCard(game, (card) => card.name === '桃'))
    game.state.currentPlayerId = 'p1'

    pushToDying(game, 'p2')
    for (let guard = 0; guard < 10; guard += 1) {
      const request = pending(game)
      if (!request) break
      if (request.playerId === 'p3') {
        expect((request as { actionIds: string[] }).actionIds).toContain(`rescue-card:${peach}`)
        return
      }
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    throw new Error('回合外应该照常能救')
  })

  it('贾诩死后完杀失效', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const peach = give(game, 'p3', findCard(game, (card) => card.name === '桃'))
    const jiaxu = playerOf(game, 'p0')
    jiaxu.alive = false
    jiaxu.hp = 0
    jiaxu.identityRevealed = true
    game.state.currentPlayerId = 'p0'

    pushToDying(game, 'p2')
    for (let guard = 0; guard < 10; guard += 1) {
      const request = pending(game)
      if (!request) break
      if (request.playerId === 'p3') {
        expect((request as { actionIds: string[] }).actionIds).toContain(`rescue-card:${peach}`)
        return
      }
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    throw new Error('贾诩已阵亡，完杀不该继续生效')
  })

  it('限制的只有桃：濒死者用酒自救不受影响', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const wine = give(game, 'p2', findCard(game, (card) => card.name === '酒'))
    game.state.currentPlayerId = 'p0'

    const request = pushToDying(game, 'p2')
    expect(request?.playerId).toBe('p2')
    expect((request as { actionIds: string[] }).actionIds, '酒不是桃，完杀管不着').toContain(`rescue-card:${wine}`)
  })

  it('转化出来的桃也被挡住——不能只挡实体牌', () => {
    // 华佗【急救】：回合外可以把红色手牌当桃用
    const game = gameWith(['jiaxu', 'zhangfei', 'zhangfei', 'huatuo', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    give(game, 'p3', findCard(game, (card) => card.suit === 'heart' && card.name !== '桃'))
    game.state.currentPlayerId = 'p0'

    const request = pushToDying(game, 'p2')
    expect(request?.playerId, '华佗的转化桃同样被完杀挡住').not.toBe('p3')
  })
})

describe('乱武：所有其他角色依次出杀或失去体力', () => {
  function luanwuAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.id === 'skill:luanwu')
  }

  /** 走完整场乱武：一律选「失去 1 点体力」，求桃一律放弃。 */
  function settleAll(game: SanguoshaGame): void {
    for (let guard = 0; guard < 200; guard += 1) {
      const request = pending(game)
      if (!request) return
      if (request.kind === 'choose-option') {
        const lose = (request as { options: Array<{ id: string }> }).options.find((option) => option.id === 'luanwu-lose-hp')
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: lose?.id ?? (request as { options: Array<{ id: string }> }).options[0].id } })
      } else if (request.kind === 'rescue') {
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
      } else if (request.kind === 'choose-targets') {
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { targetIds: (request as { candidateIds: PlayerId[] }).candidateIds.slice(0, 1) } })
      } else if (request.kind === 'choose-cards') {
        const pool = (request as { cardIds: string[]; hiddenCardSlots: string[]; min: number })
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [...pool.cardIds, ...pool.hiddenCardSlots].slice(0, pool.min) } })
      } else {
        game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
      }
    }
    throw new Error('乱武没有收敛')
  }

  it('限定技，一局只能发动一次', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    expect(luanwuAction(game)).toBeTruthy()
    game.act('p0', luanwuAction(game)!.id)
    settleAll(game)
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    expect(luanwuAction(game), '限定技用过就没了').toBeFalsy()
  })

  it('贾诩自己不参与，其他人各掉一血', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    const before = game.state.players.map((player) => player.hp)

    game.act('p0', luanwuAction(game)!.id)
    settleAll(game)

    expect(playerOf(game, 'p0').hp, '贾诩自己不参与').toBe(before[0])
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const index = Number(id.slice(1))
      expect(playerOf(game, id).hp, `${id} 应该掉一血`).toBe(before[index] - 1)
    }
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('没有手牌的人直接失去体力，不弹只有一个选项的窗口', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    game.act('p0', luanwuAction(game)!.id)
    // 所有人都空手，所以一个 choose-option 都不该出现
    for (let guard = 0; guard < 50; guard += 1) {
      const request = pending(game)
      if (!request) break
      expect(request.kind, '空手的人不该被问出杀还是掉血').not.toBe('choose-option')
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(playerOf(game, id).hp).toBe(4 - 1)
  })

  it('手上有杀且够得着时才会被问', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    give(game, 'p1', findCard(game, (card) => card.name === '杀'))

    game.act('p0', luanwuAction(game)!.id)
    const request = pending(game)
    expect(request?.kind).toBe('choose-option')
    expect(request.playerId, '从贾诩下家开始').toBe('p1')
    expect(request.prompt).toContain('乱武')
    expect(request.optional, '强制选择').toBe(false)
  })

  it('选择出杀时走完整的杀管线，伤害来源是出杀的人而不是贾诩', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    give(game, 'p1', findCard(game, (card) => card.name === '杀'))
    const damage: Array<{ sourceId?: string; targetId?: string }> = []
    game.events.on('Damaged', (context) => {
      damage.push({ sourceId: context.event.sourceId, targetId: context.event.targetId })
    })

    game.act('p0', luanwuAction(game)!.id)
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { optionId: 'luanwu-slash' } })
    settleAll(game)

    const slashHit = damage.find((entry) => entry.sourceId === 'p1')
    expect(slashHit, 'p1 的杀应该打中了人').toBeTruthy()
    expect(damage.every((entry) => entry.sourceId !== 'p0'), '贾诩不是任何一次伤害的来源').toBe(true)
    assertCardConservation(game.state)
  })

  it('最近的人超出攻击范围时只能失去体力', () => {
    // 七人局里 p1 的最近目标是 p0 和 p2（距离 1），装备防御马会把距离拉开
    const game = gameWith(['jiaxu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)
    give(game, 'p1', findCard(game, (card) => card.name === '杀'))
    // 给所有其他人都装上防御马，把 p1 到每个人的距离都推到 2
    for (const id of ['p0', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      const horse = findCard(game, (card) => card.name === '绝影' || card.name === '的卢' || card.name === '爪黄飞电' || card.name === '骅骝')
      detach(game, horse)
      playerOf(game, id).zones.equipment.defensiveHorse = horse
    }
    const before = playerOf(game, 'p1').hp

    game.act('p0', luanwuAction(game)!.id)
    const request = pending(game)
    // p1 攻击范围 1，最近距离已经是 2，够不着，所以直接掉血、不问
    expect(request?.playerId, 'p1 够不着任何人，不该被问').not.toBe('p1')
    expect(playerOf(game, 'p1').hp).toBe(before - 1)
  })

  it('失去体力打到濒死时，完杀同时生效', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    playerOf(game, 'p2').hp = 1
    give(game, 'p3', findCard(game, (card) => card.name === '桃'))

    game.act('p0', luanwuAction(game)!.id)
    // p1 空手直接掉血；轮到 p2 时掉血进濒死
    for (let guard = 0; guard < 60; guard += 1) {
      const request = pending(game)
      if (!request) break
      if (request.kind === 'rescue') {
        expect(request.playerId, '乱武发生在贾诩回合内，完杀挡住了 p3 的桃').not.toBe('p3')
      }
      game.respond({
        requestId: request.id, playerId: request.playerId,
        payload: request.kind === 'rescue' ? { actionId: 'rescue-pass' } : { optionId: 'luanwu-lose-hp' },
      })
    }
    expect(playerOf(game, 'p2').alive, '没人救得了他').toBe(false)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('结算完不留残留状态', () => {
    const game = gameWith(FIVE)
    for (const player of game.state.players) clearHand(game, player.id)
    game.act('p0', luanwuAction(game)!.id)
    settleAll(game)
    expect(game.state.skillQueue, '队列必须排空').toEqual([])
    expect(game.state.skillResolution).toBeNull()
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})
