import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 张角【雷击】【鬼道】【黄天】。
 *
 * 三个技能都复用已有机制，所以这里除了各自的规则，还专门钉「确实是复用」：
 * 鬼道和鬼才走同一个改判入口、雷击的伤害是真的雷电属性、
 * 黄天走主公技授权而不是给张角自己加动作。
 */

function gameWith(characterIds: string[], seed = 'zhangjiao'): SanguoshaGame {
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
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

/**
 * 放弃所有改判询问。
 *
 * 张角自己就有鬼道，所以他发起的每一次判定都会先停在改判窗口上——
 * 不先把这一步走完，判定结果根本还没生效。
 */
function declineRetrials(game: SanguoshaGame): void {
  for (let guard = 0; guard < 10; guard += 1) {
    const request = pending(game)
    if (!request || request.kind !== 'choose-cards' || (request as ChooseCardsRequest).purpose !== 'retrial') return
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [] } })
  }
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function putSuitOnTop(game: SanguoshaGame, suit: Suit): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = game.state.players.find((player) => player.id === playerId)!
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

/** p1 对张角（p0）出杀，张角打出【闪】，返回随后的第一个请求。 */
function slashZhangjiaoAndDodge(game: SanguoshaGame) {
  const slash = giveNamed(game, 'p1', '杀')
  const dodge = giveNamed(game, 'p0', '闪')
  const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p0'))
  if (!action) throw new Error('构造不出对张角的杀')
  game.act('p1', action.id)
  const ask = pending(game)
  game.respond({ requestId: ask.id, playerId: 'p0', payload: { actionId: `respond-dodge:${dodge}` } })
  return pending(game)
}

const FILLER = ['zhangjiao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('雷击', () => {
  it('打出【闪】之后发问', () => {
    const game = gameWith(FILLER)
    const ask = slashZhangjiaoAndDodge(game)
    expect(ask?.prompt, '打出闪之后应当问雷击').toContain('雷击')
    expect(ask.playerId).toBe('p0')
    assertGameInvariants(game.state)
  })

  it('判定为黑桃则造成 2 点雷电伤害', () => {
    const game = gameWith(FILLER)
    // 伤害属性挂在事件的 damageNature 上，不在 payload 里
    const natures: string[] = []
    game.events.on('Damaged', (context) => {
      if (context.event.targetId === 'p2') natures.push(context.event.damageNature ?? 'normal')
    })

    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    const targetAsk = pending(game) as ChooseTargetsRequest
    expect(targetAsk.kind).toBe('choose-targets')
    putSuitOnTop(game, 'spade')
    const victimHp = game.state.players[2].hp
    game.respond({ requestId: targetAsk.id, playerId: 'p0', payload: { targetIds: ['p2'] } })
    declineRetrials(game)

    expect(game.state.players[2].hp, '黑桃判定：掉 2 点').toBe(victimHp - 2)
    expect(natures, '必须是真的雷电属性伤害，不能只是 UI 显示成雷电').toEqual(['thunder'])
    assertGameInvariants(game.state)
  })

  it('判定不是黑桃则什么都不发生', () => {
    const game = gameWith(FILLER)
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    const targetAsk = pending(game)!
    putSuitOnTop(game, 'heart')
    const victimHp = game.state.players[2].hp
    game.respond({ requestId: targetAsk.id, playerId: 'p0', payload: { targetIds: ['p2'] } })
    declineRetrials(game)

    expect(game.state.players[2].hp).toBe(victimHp)
    assertGameInvariants(game.state)
  })

  it('可以放弃发动', () => {
    const game = gameWith(FILLER)
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })
    expect(pending(game)?.prompt ?? '').not.toContain('雷击')
    assertGameInvariants(game.state)
  })

  it('别人打出【闪】不会触发张角的雷击', () => {
    const game = gameWith(FILLER)
    const slash = giveNamed(game, 'p1', '杀')
    const dodge = giveNamed(game, 'p2', '闪')
    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p2'))!
    game.act('p1', action.id)
    game.respond({ requestId: pending(game).id, playerId: 'p2', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(pending(game)?.prompt ?? '').not.toContain('雷击')
  })

  it('雷电伤害能把目标推进濒死', () => {
    const game = gameWith(FILLER)
    game.state.players[2].hp = 1
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    putSuitOnTop(game, 'spade')
    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { targetIds: ['p2'] } })
    declineRetrials(game)

    const rescuing = game.state.dying !== null
      || game.state.pendingRequests.some((request) => request.kind === 'rescue')
      || !game.state.players[2].alive
    expect(rescuing).toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('鬼道复用鬼才那套改判', () => {
  it('张角有鬼道时会收到改判请求，候选只有黑色手牌', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const black = giveSuit(game, 'p0', 'club')
    const red = giveSuit(game, 'p0', 'heart')
    // 用雷击造一次判定
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    putSuitOnTop(game, 'heart')
    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    const retrial = pending(game) as ChooseCardsRequest
    expect(retrial?.purpose, '判定牌生效前应当问鬼道').toBe('retrial')
    expect(retrial.cardIds, '黑色手牌可用').toContain(black)
    expect(retrial.cardIds, '红色手牌不能用于鬼道').not.toContain(red)
    assertGameInvariants(game.state)
  })

  it('改判成功后按新的判定牌结算', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const spade = giveSuit(game, 'p0', 'spade')
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    putSuitOnTop(game, 'heart')
    const victimHp = game.state.players[2].hp
    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    // 把红桃改成黑桃，雷击命中
    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { cardIds: [spade] } })
    // 改完之后还会再问一次，这次放弃
    while (pending(game)?.kind === 'choose-cards' && (pending(game) as ChooseCardsRequest).purpose === 'retrial') {
      game.respond({ requestId: pending(game)!.id, playerId: pending(game)!.playerId, payload: { cardIds: [] } })
    }

    expect(game.state.players[2].hp, '改成黑桃，雷击命中').toBe(victimHp - 2)
    assertGameInvariants(game.state)
  })

  it('鬼道和鬼才用的是同一个入口', () => {
    // 两个技能都只实现 SkillRuntime.retrial，判定引擎按座次统一发问
    expect(skillIdsOf('zhangjiao')).toContain('guidao')
    expect(skillIdsOf('simayi')).toContain('guicai')
  })

  it('同局有司马懿和张角时，两人都会被问到', () => {
    const game = gameWith(['zhangjiao', 'simayi', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    giveSuit(game, 'p0', 'club')
    const asked: PlayerId[] = []
    const ask = slashZhangjiaoAndDodge(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })
    putSuitOnTop(game, 'heart')
    game.respond({ requestId: pending(game)!.id, playerId: 'p0', payload: { targetIds: ['p2'] } })

    for (let guard = 0; guard < 8; guard += 1) {
      const request = pending(game)
      if (!request || request.kind !== 'choose-cards' || (request as ChooseCardsRequest).purpose !== 'retrial') break
      asked.push(request.playerId)
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { cardIds: [] } })
    }

    expect(asked, '张角要被问').toContain('p0')
    expect(asked, '司马懿也要被问').toContain('p1')
    assertGameInvariants(game.state)
  })
})

describe('黄天是主公技，动作长在别人身上', () => {
  /** 让 p1 变成群势力并轮到他的出牌阶段。 */
  function huangtianGame(actorCharacter = 'lvbu'): SanguoshaGame {
    const game = gameWith(['zhangjiao', actorCharacter, 'zhangfei', 'zhangfei', 'zhangfei'], 'huangtian')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    return game
  }

  function huangtianAction(game: SanguoshaGame, playerId: PlayerId) {
    return game.legalActions(playerId).find((action) => action.id === 'huangtian-give')
  }

  it('群雄角色在自己的出牌阶段能看到黄天', () => {
    const game = huangtianGame()
    giveNamed(game, 'p1', '闪')
    expect(huangtianAction(game, 'p1'), '吕布是群，应当能发动').toBeTruthy()
  })

  it('非群势力角色看不到黄天', () => {
    const game = huangtianGame('zhangfei')
    giveNamed(game, 'p1', '闪')
    expect(huangtianAction(game, 'p1'), '张飞是蜀，不该有这条动作').toBeFalsy()
  })

  it('张角不是主公时黄天无效', () => {
    const game = huangtianGame()
    game.state.players[0].identity = 'rebel'
    giveNamed(game, 'p1', '闪')
    expect(huangtianAction(game, 'p1')).toBeFalsy()
  })

  it('手里没有【闪】或【闪电】就没有这条动作', () => {
    const game = huangtianGame()
    clearHand(game, 'p1')
    giveNamed(game, 'p1', '杀')
    expect(huangtianAction(game, 'p1')).toBeFalsy()
  })

  it('交牌之后牌真的到了主公手上', () => {
    const game = huangtianGame()
    clearHand(game, 'p1')
    const dodge = giveNamed(game, 'p1', '闪')
    game.act('p1', huangtianAction(game, 'p1')!.id)

    const pick = pending(game) as ChooseCardsRequest
    expect(pick.playerId, '选牌的是交牌的人').toBe('p1')
    expect(pick.cardIds).toEqual([dodge])
    game.respond({ requestId: pick.id, playerId: 'p1', payload: { cardIds: [dodge] } })

    expect(game.state.players[0].zones.hand, '主公拿到了').toContain(dodge)
    expect(game.state.players[1].zones.hand, '交牌的人失去了').not.toContain(dodge)
    assertGameInvariants(game.state)
  })

  it('每阶段限一次', () => {
    const game = huangtianGame()
    clearHand(game, 'p1')
    const first = giveNamed(game, 'p1', '闪')
    giveNamed(game, 'p1', '闪电')
    game.act('p1', huangtianAction(game, 'p1')!.id)
    game.respond({ requestId: pending(game)!.id, playerId: 'p1', payload: { cardIds: [first] } })

    expect(huangtianAction(game, 'p1'), '同一阶段不能再交').toBeFalsy()
    assertGameInvariants(game.state)
  })

  it('黄天不会给张角自己加动作', () => {
    const game = huangtianGame()
    game.state.currentPlayerId = 'p0'
    giveNamed(game, 'p0', '闪')
    expect(huangtianAction(game, 'p0')).toBeFalsy()
  })
})
