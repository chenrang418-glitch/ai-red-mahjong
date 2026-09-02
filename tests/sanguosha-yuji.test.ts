import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { GUHUO, declarableCardNames } from '@/sanguosha/data/characters/wind-yuji'
import { privateZoneCards } from '@/sanguosha/engine/private-zone'
import { moveCard } from '@/sanguosha/engine/zones'
import type { ChooseOptionRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 于吉【蛊惑】。
 *
 * 三件事最容易做错，各自单独钉住：
 * 1. 揭示之前，**其他人的视图里不能有那张牌的任何信息**；
 * 2. 质疑是多人同时决定，收齐之后**只揭示一次**，再统一处理所有质疑者；
 * 3. 声明仍然受正常用牌规则约束——蛊惑解决的是「实体牌和声明牌不一致」，
 *    不是绕开牌规则。
 */

function gameWith(characterIds: string[], seed = 'yuji'): SanguoshaGame {
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

/** 给某人一张指定牌名的牌，可以顺带指定花色。 */
function give(game: SanguoshaGame, playerId: PlayerId, cardName: string, suit?: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName
    && (!suit || game.state.cards[id].suit === suit))
  if (!cardId) throw new Error(`牌堆里没有${suit ?? ''}【${cardName}】`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

function guhuoAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${GUHUO}`)
}

/** 走到「质疑」那一步：扣置 cardId、声明 name，必要时选第一个目标。 */
function declare(game: SanguoshaGame, cardId: string, name: string): void {
  game.act('p0', guhuoAction(game)!.id)
  answer(game, { cardIds: [cardId] })
  answer(game, { optionId: `guhuo-name:${name}` })
  const next = pending(game)
  if (next?.kind === 'choose-targets') {
    answer(game, { targetIds: [(next as { candidateIds: PlayerId[] }).candidateIds[0]] })
  }
}

/** 让所有质疑者作答。 */
function respondChallenges(game: SanguoshaGame, challengers: PlayerId[]): void {
  const decision = game.state.groupDecision
  if (!decision) throw new Error('没有进行中的质疑')
  for (const playerId of [...decision.playerIds]) {
    const requestId = game.state.groupDecision?.requestIds[playerId]
    if (!requestId) continue
    game.respond({
      requestId,
      playerId,
      payload: { optionId: challengers.includes(playerId) ? 'guhuo-challenge-yes' : 'guhuo-challenge-no' },
    })
  }
}

const FILLER = ['yuji', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('可以声明哪些牌', () => {
  it('基本牌和非延时锦囊在列，装备和延时锦囊不在', () => {
    const game = gameWith(FILLER)
    const names = declarableCardNames(game.state)
    for (const name of ['杀', '闪', '桃', '酒', '决斗', '无中生有', '过河拆桥', '无懈可击']) {
      expect(names, `${name} 应当可以声明`).toContain(name)
    }
    for (const name of ['乐不思蜀', '兵粮寸断', '闪电', '青龙偃月刀', '八卦阵', '赤兔']) {
      expect(names, `${name} 不该出现在候选里`).not.toContain(name)
    }
  })

  it('候选从当前牌库生成，不会冒出牌库里没有的牌', () => {
    const game = gameWith(FILLER)
    const deckNames = new Set(Object.values(game.state.cards).map((card) => card.name))
    for (const name of declarableCardNames(game.state)) {
      expect(deckNames, `${name} 不在这副牌里`).toContain(name)
    }
  })
})

describe('声明仍然受正常用牌规则约束', () => {
  it('本回合已经用过杀，就不能再声明杀', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cardId = give(game, 'p0', '桃')
    game.state.turnUsage.slashUses = 1

    game.act('p0', guhuoAction(game)!.id)
    answer(game, { cardIds: [cardId] })
    const request = pending(game) as ChooseOptionRequest
    expect(request.options.map((option) => option.id), '杀的次数用完了')
      .not.toContain('guhuo-name:杀')
  })

  it('满体力时不能声明桃', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cardId = give(game, 'p0', '杀')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp

    game.act('p0', guhuoAction(game)!.id)
    answer(game, { cardIds: [cardId] })
    const request = pending(game) as ChooseOptionRequest
    expect(request.options.map((option) => option.id)).not.toContain('guhuo-name:桃')
  })

  it('候选里永远没有装备和延时锦囊', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cardId = give(game, 'p0', '杀')
    game.act('p0', guhuoAction(game)!.id)
    answer(game, { cardIds: [cardId] })
    const request = pending(game) as ChooseOptionRequest
    const ids = request.options.map((option) => option.id)
    for (const name of ['乐不思蜀', '闪电', '赤兔', '八卦阵']) {
      expect(ids).not.toContain(`guhuo-name:${name}`)
    }
  })
})

describe('揭示之前的隐藏信息', () => {
  it('其他人的视图里没有那张牌的任何痕迹', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const spadeSlash = give(game, 'p0', '杀', 'spade')
    declare(game, spadeSlash, '桃')

    expect(privateZoneCards(game.state, 'guhuo'), '牌应当在私有区里').toEqual([spadeSlash])
    for (const viewerId of ['p1', 'p2', 'p3', 'p4']) {
      const view = game.viewFor(viewerId)
      const owner = view.players.find((player) => player.id === 'p0')!
      expect(owner.privateCards, `${viewerId} 不该拿到私有区`).toBeNull()
      expect(JSON.stringify(view), `${viewerId} 不该看到 cardId`).not.toContain(spadeSlash)
      expect(view.processingArea.map((card) => card.id), '牌不能在公开的处理区里')
        .not.toContain(spadeSlash)
    }
  })

  it('于吉自己看得到扣了哪张牌——断线重连要靠它', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')

    const view = game.viewFor('p0')
    const self = view.players.find((player) => player.id === 'p0')!
    const recovered = self.privateCards?.guhuo?.[0]
    expect(recovered?.id).toBe(cardId)
    expect(recovered?.name).toBe('杀')
    expect(recovered?.suit).toBe('spade')
  })

  it('过一遍 JSON 之后质疑还能接着走', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(privateZoneCards(restored.state, 'guhuo')).toEqual([cardId])
    expect(restored.state.groupDecision?.tag).toBe('guhuo-challenge')
    respondChallenges(restored, [])
    expect(restored.state.groupDecision, '恢复之后照样能收齐').toBeNull()
  })
})

describe('无人质疑', () => {
  it('假牌也照样按声明结算', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    const cardId = give(game, 'p0', '杀', 'spade')

    declare(game, cardId, '桃')
    respondChallenges(game, [])

    expect(owner.hp, '假的桃也回了血').toBe(owner.maxHp)
    expect(game.state.zones.discardPile, '实体牌进弃牌堆').toContain(cardId)
    expect(privateZoneCards(game.state, 'guhuo'), '私有区要清干净').toEqual([])
    assertGameInvariants(game.state)
  })

  it('声明杀会真的走杀的结算', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cardId = give(game, 'p0', '桃')
    declare(game, cardId, '杀')
    respondChallenges(game, [])

    const request = pending(game)
    expect(request?.kind, '应当在向目标求闪').toBe('respond-card')
    expect(request?.prompt).toContain('闪')
    assertGameInvariants(game.state)
  })
})

describe('有人质疑', () => {
  it('真牌：质疑者失去体力，而不是受到伤害', () => {
    const game = gameWith(['yuji', 'caocao', 'zhangfei', 'zhangfei', 'zhangfei'])
    clearHand(game, 'p0')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    const cardId = give(game, 'p0', '桃', 'diamond')
    const damaged: unknown[] = []
    game.events.on('Damaged', (context) => { damaged.push(context.event.targetId) })

    declare(game, cardId, '桃')
    const before = game.state.players[1].hp
    respondChallenges(game, ['p1'])

    expect(game.state.players[1].hp, '质疑者失去一点体力').toBe(before - 1)
    expect(damaged, '是失去体力，不是伤害——曹操的奸雄不该被触发').toEqual([])
    assertGameInvariants(game.state)
  })

  it('假牌：质疑者各摸一张牌，声明不生效', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    const cardId = give(game, 'p0', '杀', 'spade')

    declare(game, cardId, '桃')
    const before = game.state.players[1].zones.hand.length
    respondChallenges(game, ['p1'])

    expect(game.state.players[1].zones.hand.length, '猜对了摸一张').toBe(before + 1)
    expect(owner.hp, '假牌不生效，没有回血').toBe(owner.maxHp - 1)
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('非红桃真牌被质疑：惩罚照给，但牌被弃置、效果不结算', () => {
    // 这副牌里的【桃】只有红桃和方块，所以拿黑桃【杀】声明【杀】来测
    // 「真牌但不是红桃」这一支
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const cardId = give(game, 'p0', '杀', 'spade')

    declare(game, cardId, '杀')
    const before = game.state.players[1].hp
    respondChallenges(game, ['p1'])

    expect(game.state.players[1].hp, '真牌，质疑者失去体力').toBe(before - 1)
    expect(pending(game)?.prompt ?? '', '非红桃真牌被质疑就不再结算，不该有人被求闪')
      .not.toContain('闪')
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('红桃真牌被质疑：惩罚照给，而且牌仍然结算', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    const cardId = give(game, 'p0', '桃', 'heart')

    declare(game, cardId, '桃')
    const before = game.state.players[1].hp
    respondChallenges(game, ['p1'])

    expect(game.state.players[1].hp, '真牌，质疑者失去体力').toBe(before - 1)
    expect(owner.hp, '红桃真牌是唯一例外，仍然结算').toBe(owner.maxHp)
    assertGameInvariants(game.state)
  })

  it('多人质疑：只揭示一次，所有质疑者一起结算', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    const cardId = give(game, 'p0', '桃', 'diamond')
    const reveals: unknown[] = []
    game.events.on('CardMove', (context) => {
      if ((context.event.payload as { reason?: string }).reason === GUHUO) reveals.push(context.event.payload)
    })

    declare(game, cardId, '桃')
    const before = [game.state.players[1].hp, game.state.players[2].hp]
    respondChallenges(game, ['p1', 'p2'])

    expect(reveals, '统一揭示一次，不是每个质疑者揭一次').toHaveLength(1)
    expect(game.state.players[1].hp).toBe(before[0] - 1)
    expect(game.state.players[2].hp).toBe(before[1] - 1)
    assertGameInvariants(game.state)
  })

  it('质疑失败被打到濒死时，走完整的濒死流程', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    for (const player of game.state.players.slice(1)) clearHand(game, player.id)
    const owner = game.state.players[0]
    owner.hp = owner.maxHp - 1
    game.state.players[1].hp = 1
    const cardId = give(game, 'p0', '桃', 'diamond')

    declare(game, cardId, '桃')
    respondChallenges(game, ['p1'])

    const dying = game.state.dying !== null
      || game.state.pendingRequests.some((request) => request.kind === 'rescue')
      || !game.state.players[1].alive
    expect(dying, '1 血质疑失败应当进入濒死或死亡').toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('质疑的隐私与边界', () => {
  it('每个人只看得到发给自己的质疑请求', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')

    for (const viewerId of ['p1', 'p2', 'p3', 'p4']) {
      const view = game.viewFor(viewerId)
      expect(view.pendingRequest?.playerId).toBe(viewerId)
      expect(view.pendingRequest?.prompt).toContain('蛊惑')
    }
    expect(game.viewFor('p0').pendingRequest, '于吉自己不参与质疑').toBeNull()
  })

  it('已经提交的人看不到别人的选择', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')

    const decision = game.state.groupDecision!
    game.respond({
      requestId: decision.requestIds.p1, playerId: 'p1',
      payload: { optionId: 'guhuo-challenge-yes' },
    })

    for (const viewerId of ['p2', 'p3']) {
      const view = game.viewFor(viewerId) as unknown as Record<string, unknown>
      expect(view.groupDecision, `${viewerId} 不该看到谁质疑了`).toBeUndefined()
    }
  })

  it('于吉不会被要求质疑自己', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')
    expect(game.state.groupDecision!.playerIds, '自己不在质疑者里').not.toContain('p0')
  })

  it('死人不参与质疑', () => {
    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[2].alive = false
    game.state.players[2].identityRevealed = true
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')
    expect(game.state.groupDecision!.playerIds).not.toContain('p2')
  })
})

describe('蛊惑的界面', () => {
  it('声明列表按牌名列出，每一项都是一条可点的选项', async () => {
    const { createSSRApp } = await import('vue')
    const { renderToString } = await import('vue/server-renderer')
    const SgsRequestDock = (await import('@/sanguosha/components/SgsRequestDock.vue')).default

    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    game.act('p0', guhuoAction(game)!.id)
    answer(game, { cardIds: [cardId] })

    const view = game.viewFor('p0')
    const request = view.pendingRequest!
    expect(request.kind).toBe('choose-option')
    const html = await renderToString(createSSRApp(SgsRequestDock, { request, view }))

    // 声明的是牌名，不是内部 id
    expect(html).toContain('声明【杀】')
    expect(html).toContain('声明【桃】')
    expect(html, '装备不能声明').not.toContain('声明【赤兔】')
    expect(html, '延时锦囊不能声明').not.toContain('声明【乐不思蜀】')
    // 选项数量就是候选数量，UI 不自己增删
    const rendered = (html.match(/声明【/g) ?? []).length
    expect(rendered).toBe((request as { options: unknown[] }).options.length)
  })

  it('质疑面板只有两个按钮，看不到别人的选择', async () => {
    const { createSSRApp } = await import('vue')
    const { renderToString } = await import('vue/server-renderer')
    const SgsRequestDock = (await import('@/sanguosha/components/SgsRequestDock.vue')).default

    const game = gameWith(FILLER)
    clearHand(game, 'p0')
    game.state.players[0].hp -= 1
    const cardId = give(game, 'p0', '杀', 'spade')
    declare(game, cardId, '桃')

    const view = game.viewFor('p1')
    const request = view.pendingRequest!
    const html = await renderToString(createSSRApp(SgsRequestDock, { request, view }))

    expect(html).toContain('质疑')
    expect(html).toContain('不质疑')
    expect(html, '不能提前透露真实牌').not.toContain(cardId)
    // 声明的是桃，界面上要说清楚
    expect(request.prompt).toContain('声明【桃】')
  })
})
