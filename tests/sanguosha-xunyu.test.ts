import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { JIEMING, QUHU, jiemingCandidates, quhuDamageTargets, quhuTargets } from '@/sanguosha/data/characters/fire-xunyu'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 火包·荀彧（经典版本，不是界限突破）。
 *
 * 三处最容易做错的地方单独钉住：
 * 1. 驱虎的**伤害来源是拼点目标**，不是荀彧——奸雄、刚烈都该认到他头上；
 * 2. 「若你没赢」包含平局，平局走的是失败分支而不是什么都不发生；
 * 3. 节命是「每受到 1 点伤害」，受到 2 点要问两次。
 */

function gameWith(seed = 'xunyu', characters?: string[]): SanguoshaGame {
  const list = characters ?? ['xunyu', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: list.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  // 荀彧不当主公：主公有额外 1 点上限，会让「体力值多于你」的判断变味
  const identities: Identity[] = ['rebel', 'lord', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = list[index]
    // 手工摆武将时要补上选将流程里的体力上限计算
    const base = getCharacter(list[index])?.maxHp ?? 4
    player.maxHp = base + (player.identity === 'lord' ? 1 : 0)
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

function giveRank(game: SanguoshaGame, playerId: PlayerId, rank: number): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].rank === rank)
  if (!cardId) throw new Error(`牌堆里没有点数 ${rank} 的牌`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

/**
 * 让 p1 对荀彧用一张【杀】并让他不闪。
 *
 * **不能直接调 game.damage()**：排队的技能发问只在 settle() 之后才放出来，
 * 而 settle 只在 act / respond / advancePhase 里跑，直接调伤害函数的话
 * 【节命】永远问不出来。
 */
function slashXunyu(game: SanguoshaGame, amount = 1): void {
  game.state.currentPlayerId = 'p1'
  game.state.phase = 'play'
  game.state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: amount - 1 }
  const slashId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.name === '杀' && !card.damageNature
  })!
  moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p1' })
  const action = game.legalActions('p1').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p0'))!
  game.act('p1', action.id)
  const dodge = pending(game)
  if (dodge?.kind === 'respond-card') answer(game, { actionId: 'respond-pass' })
}

function quhuAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === `skill:${QUHU}`)
}

/** 摆好双方的拼点牌，发动驱虎并把两边的牌都交上去。 */
function runQuhu(game: SanguoshaGame, ownRank: number, opponentRank: number, opponentId: PlayerId = 'p1') {
  clearHand(game, 'p0')
  clearHand(game, opponentId)
  const ownCard = giveRank(game, 'p0', ownRank)
  const opponentCard = giveRank(game, opponentId, opponentRank)
  game.act('p0', quhuAction(game)!.id)
  answer(game, { targetIds: [opponentId] })
  const own = game.state.pendingRequests.find((request) => request.playerId === 'p0')!
  game.respond({ requestId: own.id, playerId: 'p0', payload: { cardIds: [ownCard] } })
  const theirs = game.state.pendingRequests.find((request) => request.playerId === opponentId)!
  game.respond({ requestId: theirs.id, playerId: opponentId, payload: { cardIds: [opponentCard] } })
  return { ownCard, opponentCard }
}

describe('荀彧的基础信息', () => {
  it('魏势力、3 体力、火包、两个技能', () => {
    const character = getCharacter('xunyu')!
    expect(character.kingdom).toBe('wei')
    expect(character.maxHp).toBe(3)
    expect(character.pack).toBe('fire')
    expect(character.skills.map((skill) => skill.id)).toEqual([QUHU, JIEMING])
  })
})

describe('驱虎的发动条件', () => {
  it('只能选体力值多于自己的角色（测试 1 / 2）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    game.state.players[2].hp = 3
    game.state.players[3].hp = 2
    expect(quhuTargets(game.state, 'p0')).toContain('p1')
    expect(quhuTargets(game.state, 'p0'), '体力相等不行').not.toContain('p2')
    expect(quhuTargets(game.state, 'p0'), '体力更少不行').not.toContain('p3')
  })

  it('对方没有手牌不能选（测试 3）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    clearHand(game, 'p1')
    expect(quhuTargets(game.state, 'p0')).not.toContain('p1')
  })

  it('自己没有手牌就不能发动（测试 4）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    clearHand(game, 'p0')
    expect(quhuAction(game), '合法性阶段就该挡掉，不是发动完再弹空框').toBeUndefined()
  })

  it('全场都没有体力更高的角色时不给这个动作', () => {
    const game = gameWith()
    game.state.players.forEach((player, index) => { if (index > 0) player.hp = 2 })
    expect(quhuAction(game)).toBeUndefined()
  })

  it('出牌阶段限一次（测试 11），取消不消耗次数（测试 12）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    // 先取消一次
    game.act('p0', quhuAction(game)!.id)
    answer(game, { targetIds: [] })
    expect(quhuAction(game), '取消不该消耗次数').toBeTruthy()

    runQuhu(game, 13, 7)
    while (pending(game)) answer(game, { targetIds: [pending(game)!.kind === 'choose-targets' ? (pending(game) as { candidateIds: PlayerId[] }).candidateIds[0] : ''] })
    expect(quhuAction(game), '真的拼过之后就不能再来').toBeUndefined()
  })
})

describe('驱虎的结算', () => {
  it('拼点赢：由拼点目标对指定角色造成伤害，来源不是荀彧（测试 5 / 8）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    const damages: Array<{ sourceId?: string; targetId?: string }> = []
    game.events.on('Damaged', (context) => {
      damages.push({ sourceId: context.event.sourceId, targetId: context.event.targetId })
    })

    runQuhu(game, 13, 7)
    const request = pending(game)
    expect(request?.playerId, '由荀彧选谁挨打').toBe('p0')
    expect(request?.prompt).toContain('攻击范围')
    const candidates = (request as { candidateIds: PlayerId[] }).candidateIds
    expect(candidates, '不能打自己').not.toContain('p1')
    answer(game, { targetIds: [candidates[0]] })

    expect(damages).toHaveLength(1)
    expect(damages[0].sourceId, '伤害来源是拼点目标').toBe('p1')
    expect(damages[0].targetId).toBe(candidates[0])
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('拼点输：拼点目标对荀彧造成伤害（测试 6）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    const damages: Array<{ sourceId?: string; targetId?: string }> = []
    game.events.on('Damaged', (context) => {
      damages.push({ sourceId: context.event.sourceId, targetId: context.event.targetId })
    })
    const hpBefore = game.state.players[0].hp

    runQuhu(game, 3, 12)

    expect(damages).toHaveLength(1)
    expect(damages[0].sourceId, '来源仍然是拼点目标').toBe('p1')
    expect(damages[0].targetId).toBe('p0')
    expect(game.state.players[0].hp).toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('平局按「没赢」处理，走失败分支（测试 7）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    const hpBefore = game.state.players[0].hp
    runQuhu(game, 8, 8)
    expect(game.state.players[0].hp, '平局不是什么都不发生').toBe(hpBefore - 1)
  })

  it('伤害是 Damage 不是失去体力：奸雄能拿到那张牌', () => {
    const game = gameWith('xunyu-jianxiong', ['xunyu', 'caocao', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[1].hp = 4
    const damaged: string[] = []
    game.events.on('Damaged', (context) => { damaged.push(String(context.event.targetId)) })
    runQuhu(game, 3, 12)
    expect(damaged, '走的是伤害管线').toEqual(['p0'])
  })

  it('赢了但对方攻击范围内没有别人：什么都不发生（测试 10）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    // 把 p1 到所有人的距离拉远，攻击范围够不着任何人
    game.state.players[1].distanceToOthers = 10
    expect(quhuDamageTargets(game.state, 'p1')).toEqual([])

    const damages: unknown[] = []
    game.events.on('Damaged', () => { damages.push(1) })
    runQuhu(game, 13, 7)

    expect(pending(game), '不该再弹选目标的窗口').toBeUndefined()
    expect(damages, '没人可打就是白忙一场').toEqual([])
    assertGameInvariants(game.state)
  })

  it('攻击范围用现有系统算，武器会扩大候选（测试 9）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    const narrow = quhuDamageTargets(game.state, 'p1').length
    const bow = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '诸葛连弩'
      || game.state.cards[id].equipmentSlot === 'weapon')!
    moveCard(game.state, bow, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p1', slot: 'weapon' })
    expect(quhuDamageTargets(game.state, 'p1').length, '装备之后范围不该变小')
      .toBeGreaterThanOrEqual(narrow)
  })

  it('拼点过程可序列化，一方交牌后刷新能接着走（测试 13）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const ownCard = giveRank(game, 'p0', 13)
    const opponentCard = giveRank(game, 'p1', 7)
    game.act('p0', quhuAction(game)!.id)
    answer(game, { targetIds: ['p1'] })
    const own = game.state.pendingRequests.find((request) => request.playerId === 'p0')!
    game.respond({ requestId: own.id, playerId: 'p0', payload: { cardIds: [ownCard] } })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(JSON.stringify(restored.viewFor('p1')), '刷新也不泄露').not.toContain(ownCard)
    const theirs = restored.state.pendingRequests.find((request) => request.playerId === 'p1')!
    restored.respond({ requestId: theirs.id, playerId: 'p1', payload: { cardIds: [opponentCard] } })

    expect(restored.state.pendingRequests[0]?.prompt, '接着走到选挨打的人').toContain('攻击范围')
    assertCardConservation(restored.state)
    assertGameInvariants(restored.state)
  })
})

describe('节命', () => {
  it('受到 1 点伤害后问一次（测试 1）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    slashXunyu(game)
    const request = pending(game)
    expect(request?.playerId).toBe('p0')
    expect(request?.prompt).toContain('节命')
  })

  it('受到 2 点伤害后问两次（测试 2）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    let asked = 0
    let guard = 0
    // 酒加伤，一次打 2 点
    slashXunyu(game, 2)
    while (pending(game)?.prompt.includes('节命')) {
      if (guard++ > 6) throw new Error('节命没有收敛')
      asked += 1
      answer(game, { targetIds: [] })
    }
    expect(asked, '每受到 1 点伤害触发一次').toBe(2)
  })

  it('可以补自己，补到体力上限（测试 3）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    slashXunyu(game)
    answer(game, { targetIds: ['p0'] })
    expect(game.state.players[0].zones.hand, '荀彧上限 3').toHaveLength(3)
    assertCardConservation(game.state)
  })

  it('也可以补别人（测试 4）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    clearHand(game, 'p2')
    slashXunyu(game)
    answer(game, { targetIds: ['p2'] })
    expect(game.state.players[2].zones.hand.length, '张飞 4 血，补到 4 张').toBe(4)
  })

  it('至多补到 5 张，不会因为上限更高就补更多', () => {
    const game = gameWith()
    const tall = game.state.players[2]
    tall.maxHp = 8
    clearHand(game, 'p0')
    clearHand(game, tall.id)
    slashXunyu(game)
    answer(game, { targetIds: [tall.id] })
    expect(tall.zones.hand).toHaveLength(5)
  })

  it('全场手牌都够了就不弹窗（测试 5）', () => {
    const game = gameWith()
    for (const player of game.state.players) {
      while (player.zones.hand.length < Math.min(player.maxHp, 5)) {
        const cardId = game.state.zones.drawPile[0]
        moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: player.id })
      }
    }
    expect(jiemingCandidates(game.state)).toEqual([])
    slashXunyu(game)
    expect(pending(game), '发动也只会摸 0 张，不该弹窗').toBeUndefined()
  })

  it('荀彧被打死时不会再补牌（测试 6）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    game.state.players[0].hp = 1
    slashXunyu(game)
    // 濒死求桃优先；一路放弃直到死亡
    let guard = 0
    while (game.state.dying) {
      if (guard++ > 20) throw new Error('濒死没有收敛')
      const request = pending(game)!
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } })
    }
    expect(game.state.players[0].alive).toBe(false)
    expect(pending(game)?.prompt ?? '', '死了就不再问节命').not.toContain('节命')
    assertGameInvariants(game.state)
  })
})

describe('驱虎与节命的联动', () => {
  it('拼点失败挨的那一下会正常触发节命（关键回归）', () => {
    const game = gameWith()
    game.state.players[1].hp = 4
    runQuhu(game, 3, 12)

    const request = pending(game)
    expect(request?.prompt, '驱虎的伤害是真伤害，节命该被触发').toContain('节命')
    answer(game, { targetIds: ['p0'] })
    expect(game.state.players[0].zones.hand.length, '补到上限 3').toBe(3)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })
})
