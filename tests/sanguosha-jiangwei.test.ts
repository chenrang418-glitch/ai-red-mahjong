import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { attackRangeCovers } from '@/sanguosha/engine/ask-use-slash'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 山包·姜维。本项目自研表述。。
 *
 * 最要紧的一条：**挑衅选的是「攻击范围里包含姜维」的角色，
 * 不是「姜维攻击范围里」的角色**。方向反了就是另一个技能，
 * 这一组第一个 describe 专门钉这件事。
 *
 * 其次是「使用」而不是「打出」：被挑衅的人打出的那张【杀】要真的
 * 走完整结算，能被闪掉、能造成伤害。
 */

function gameWith(characterIds: string[], seed = 'jiangwei'): SanguoshaGame {
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

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
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
    for (const slot of Object.keys(player.zones.equipment) as Array<keyof typeof player.zones.equipment>) {
      if (player.zones.equipment[slot] === cardId) player.zones.equipment[slot] = null
    }
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

/** 把回合交给姜维的出牌阶段。 */
function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'play'
  game.state.skippedPhases = []
  for (const player of game.state.players) player.turnUsedSkills = []
}

function tiaoxinAction(game: SanguoshaGame, ownerId: PlayerId) {
  return game.legalActions(ownerId).find((action) => action.kind === 'invoke-skill' && action.skillId === 'tiaoxin')
}

const FIVE = ['jiangwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('挑衅的目标条件：反向攻击范围', () => {
  it('候选是「攻击范围里包含姜维」的人，不是姜维攻击范围里的人', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    const action = tiaoxinAction(game, 'p0')
    expect(action, '相邻角色的攻击范围本来就够得到姜维').toBeTruthy()
    game.act('p0', action!.id)

    const request = pending(game)
    expect(request?.kind).toBe('choose-targets')
    for (const candidateId of request.candidateIds) {
      expect(
        attackRangeCovers(game.state, candidateId, 'p0'),
        `${candidateId} 的攻击范围必须包含姜维`,
      ).toBe(true)
    }
  })

  it('给别人装上武器会把他加进候选，装给姜维自己不会', () => {
    const game = gameWith(FIVE)
    // 五人局里 p2 和姜维的距离是 2，基础攻击范围 1 够不着
    expect(attackRangeCovers(game.state, 'p2', 'p0')).toBe(false)

    const bow = findCard(game, (card) => card.name === '诸葛连弩')
    detach(game, bow)
    playerOf(game, 'p0').zones.equipment.weapon = bow
    expect(attackRangeCovers(game.state, 'p2', 'p0'), '武器装在姜维身上不改变别人够不够得到他').toBe(false)

    const halberd = findCard(game, (card) => card.name === '方天画戟')
    detach(game, halberd)
    playerOf(game, 'p0').zones.equipment.weapon = null
    playerOf(game, 'p2').zones.equipment.weapon = halberd
    expect(attackRangeCovers(game.state, 'p2', 'p0'), '给 p2 装远程武器才够得到姜维').toBe(true)
  })

  it('-1 马让别人更难够到姜维，相邻的人会掉出候选', () => {
    const game = gameWith(FIVE)
    // 相邻的 p1 本来够得到姜维
    expect(attackRangeCovers(game.state, 'p1', 'p0')).toBe(true)

    const horse = findCard(game, (card) => card.name === '的卢')
    detach(game, horse)
    playerOf(game, 'p0').zones.equipment.defensiveHorse = horse
    // 装在姜维身上的 -1 马把别人到他的距离拉远，相邻的人也够不到了
    expect(attackRangeCovers(game.state, 'p1', 'p0'), '-1 马应当让姜维更难被够到').toBe(false)
  })
})

describe('挑衅的次数与取消', () => {
  it('出牌阶段限一次', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    const action = tiaoxinAction(game, 'p0')!
    game.act('p0', action.id)
    const request = pending(game)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    // 把后续请求跑完
    let guard = 0
    while (pending(game) && guard < 10) {
      const next = pending(game)
      const payload = next.kind === 'choose-cards'
        ? { cardIds: [...next.cardIds, ...next.hiddenCardSlots].slice(0, next.min) }
        : next.kind === 'choose-targets'
          ? { targetIds: next.candidateIds.slice(0, Math.max(next.min, 1)) }
          : next.kind === 'respond-card' || next.kind === 'rescue'
            ? { actionId: next.actionIds[next.actionIds.length - 1] }
            : { optionId: 'no' }
      game.respond({ requestId: next.id, playerId: next.playerId, payload })
      guard += 1
    }
    expect(tiaoxinAction(game, 'p0'), '一个出牌阶段只能挑衅一次').toBeUndefined()
  })

  it('取消选目标不消耗次数', () => {
    const game = gameWith(FIVE)
    enterPlay(game, 'p0')
    game.act('p0', tiaoxinAction(game, 'p0')!.id)
    const request = pending(game)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: [] } })
    expect(tiaoxinAction(game, 'p0'), '取消不该把这一次用掉').toBeTruthy()
  })
})

describe('挑衅：目标使用【杀】', () => {
  function tiaoxinAt(game: SanguoshaGame, targetId: PlayerId) {
    enterPlay(game, 'p0')
    game.act('p0', tiaoxinAction(game, 'p0')!.id)
    const request = pending(game)
    game.respond({ requestId: request.id, playerId: 'p0', payload: { targetIds: [targetId] } })
  }

  it('求杀的请求发给目标本人，出不出由他决定', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    tiaoxinAt(game, 'p1')

    const ask = pending(game)
    expect(ask?.kind).toBe('choose-cards')
    expect(ask.playerId, '出不出杀是目标的决定，不是姜维的').toBe('p1')
    expect(ask.min, '有杀也可以选择不出').toBe(0)
  })

  it('目标出杀：走完整结算，姜维要被求闪', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const slash = findCard(game, (card) => card.name === '杀')
    giveHand(game, 'p1', [slash])
    clearHand(game, 'p0')
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '闪')])

    tiaoxinAt(game, 'p1')
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p1', payload: { cardIds: [slash] } })

    const dodge = pending(game)
    expect(dodge?.kind, '这是真的「使用」杀，姜维要有机会闪').toBe('respond-card')
    expect(dodge.playerId).toBe('p0')
    expect(dodge.requiredCardName).toBe('闪')
    assertCardConservation(game.state)
  })

  it('目标出杀且姜维闪不掉：真的掉血', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const slash = findCard(game, (card) => card.name === '杀')
    giveHand(game, 'p1', [slash])
    clearHand(game, 'p0')
    const hpBefore = playerOf(game, 'p0').hp

    tiaoxinAt(game, 'p1')
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { cardIds: [slash] } })
    const dodge = pending(game)
    game.respond({ requestId: dodge.id, playerId: 'p0', payload: { actionId: 'respond-pass' } })

    expect(playerOf(game, 'p0').hp, '没闪就要挨这一刀').toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('目标不出杀：姜维弃置其一张牌，暗手牌只给占位槽', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '杀')])
    tiaoxinAt(game, 'p1')

    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { cardIds: [] } })
    const discard = pending(game)
    expect(discard?.kind).toBe('choose-cards')
    expect(discard.playerId, '弃谁的牌由姜维挑').toBe('p0')
    expect(discard.cardIds, '手牌不能被看见').toEqual([])
    expect(discard.hiddenCardSlots.length).toBe(1)

    game.respond({ requestId: discard.id, playerId: 'p0', payload: { cardIds: [discard.hiddenCardSlots[0]] } })
    expect(playerOf(game, 'p1').zones.hand.length).toBe(0)
    assertCardConservation(game.state)
  })

  it('目标拿不出杀：直接进入弃牌，不弹一个只能拒绝的窗口', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    giveHand(game, 'p1', [findCard(game, (card) => card.name === '闪')])
    tiaoxinAt(game, 'p1')

    const request = pending(game)
    expect(request?.kind).toBe('choose-cards')
    expect(request.playerId, '没杀可出就直接轮到姜维弃他的牌').toBe('p0')
    expect(String(request.prompt)).toContain('没有使用【杀】')
  })

  it('目标一张牌都没有：挑衅仍可发动，只是后半段落空', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    enterPlay(game, 'p0')
    const action = tiaoxinAction(game, 'p0')
    expect(action, '目标条件只有攻击范围，没牌不影响能不能挑衅').toBeTruthy()
    game.act('p0', action!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(pending(game), '没牌可弃就安静结束').toBeUndefined()
  })

  it('弃置范围含装备区', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const armor = findCard(game, (card) => card.name === '八卦阵')
    detach(game, armor)
    playerOf(game, 'p1').zones.equipment.armor = armor

    tiaoxinAt(game, 'p1')
    const discard = pending(game)
    expect(discard.cardIds, '装备是公开的，直接列出来').toContain(armor)
  })
})

describe('志继：觉醒技', () => {
  function enterPrepare(game: SanguoshaGame, playerId: PlayerId): void {
    game.state.currentPlayerId = playerId
    game.state.phase = 'prepare'
    game.emit('PhaseStart', { playerId, phase: 'prepare' })
    game.settle()
  }

  it('有手牌就不觉醒——是「没有手牌」，不是「手牌最少」', () => {
    const game = gameWith(FIVE)
    // 全场只有姜维有一张牌，他仍然是手牌最少的之一，但不是 0
    for (const id of ['p1', 'p2', 'p3', 'p4']) clearHand(game, id)
    clearHand(game, 'p0')
    giveHand(game, 'p0', [findCard(game, (card) => card.name === '杀')])
    enterPrepare(game, 'p0')
    expect(playerOf(game, 'p0').awakenedSkills).not.toContain('zhiji')
  })

  it('没有手牌：强制觉醒并要求二选一', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    const ask = pending(game)
    expect(ask?.kind).toBe('choose-option')
    expect(ask.playerId, '选哪一项是姜维自己决定的').toBe('p0')
    expect(ask.optional, '觉醒技本身是强制的，只有效果内部可选').toBe(false)
    expect(ask.options.map((option: { id: string }) => option.id)).toEqual(['zhiji-recover', 'zhiji-draw'])
  })

  it('选回复：回 1 点血、减 1 上限、获得观星', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    owner.hp = 2
    const maxBefore = owner.maxHp
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'zhiji-recover' } })

    expect(owner.hp).toBe(3)
    expect(owner.maxHp).toBe(maxBefore - 1)
    expect(ownedSkillIds(game.state, 'p0', skillIdsOf)).toContain('guanxing')
    assertGameInvariants(game.state)
  })

  it('选摸牌：摸两张、减 1 上限、获得观星', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    const maxBefore = owner.maxHp
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'zhiji-draw' } })

    expect(owner.zones.hand.length).toBe(2)
    expect(owner.maxHp).toBe(maxBefore - 1)
    expect(owner.grantedSkills).toContain('guanxing')
    assertCardConservation(game.state)
  })

  it('只觉醒一次：第二个准备阶段不再触发', () => {
    const game = gameWith(FIVE)
    const owner = playerOf(game, 'p0')
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'zhiji-draw' } })
    const maxAfter = owner.maxHp

    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    /*
     * 第二个准备阶段会弹出**观星**（觉醒后新拿到的技能），那是对的；
     * 不该再弹志继的二选一，体力上限也不该再降一次。
     * 这里不去把观星跑完（它要的是排列 payload，和本条断言无关），
     * 只查这两件事。
     */
    expect(pending(game)?.prompt ?? '', '不该再问一次志继').not.toContain('志继')
    expect(owner.maxHp, '觉醒一局只有一次').toBe(maxAfter)
    expect(owner.awakenedSkills.filter((id) => id === 'zhiji').length).toBe(1)
  })

  it('获得的观星是标准诸葛亮那一个，真的能用', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'zhiji-draw' } })

    // 下一个准备阶段观星应当自己弹出来
    enterPrepare(game, 'p0')
    const guanxing = pending(game)
    expect(guanxing, '觉醒后的观星要真的会触发').toBeTruthy()
    expect(String(guanxing.prompt)).toContain('观星')
  })

  it('觉醒与授技可以序列化恢复', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p0')
    enterPrepare(game, 'p0')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'zhiji-draw' } })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const owner = restored.state.players.find((player) => player.id === 'p0')!
    expect(owner.awakenedSkills).toContain('zhiji')
    expect(ownedSkillIds(restored.state, 'p0', skillIdsOf)).toContain('guanxing')
  })
})

describe('挑衅的重连', () => {
  it('等对方决定出不出杀时刷新，恢复后仍停在同一步', () => {
    const game = gameWith(FIVE)
    clearHand(game, 'p1')
    const slash = findCard(game, (card) => card.name === '杀')
    giveHand(game, 'p1', [slash])
    enterPlay(game, 'p0')
    game.act('p0', tiaoxinAction(game, 'p0')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    const ask = restored.state.pendingRequests[0]
    expect(ask.kind).toBe('choose-cards')
    expect(ask.playerId).toBe('p1')
    restored.respond({ requestId: ask.id, playerId: 'p1', payload: { cardIds: [slash] } })
    expect(restored.state.pendingRequests[0]?.playerId, '恢复后照样进入求闪').toBe('p0')
    assertCardConservation(restored.state)
  })
})
