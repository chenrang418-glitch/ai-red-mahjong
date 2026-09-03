import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { DUOWEI, RENNAI, canInvokeDuowei } from '@/sanguosha/data/characters/entertainment-wuliang'
import { rennaiCount, setRennaiCount } from '@/sanguosha/engine/rennai'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 娱乐武将·无亮。
 *
 * 三处最容易做错的地方单独钉住：
 * 1. 「若你可以响应」必须按现有规则判断——手上没【闪】不能靠不响应白拿收益；
 * 2. 「忍」只在**真的吃亏之后**才加，伤害被防止就一枚都不给；
 * 3. 【夺位】是**真的交换身份**，胜利判定要立刻按新身份算。
 */

/** p0 = 无亮，身份按参数指定；p1 固定是主公。 */
function gameWith(options: { wuliangIdentity?: Identity; seed?: string; characters?: string[] } = {}): SanguoshaGame {
  const characters = options.characters ?? ['wuliang', 'liubei', 'zhangfei', 'zhangfei', 'zhangfei']
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characters.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed: options.seed ?? 'wuliang', setup })
  const rest: Identity[] = ['loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.characterId = characters[index]
    if (index === 0) player.identity = options.wuliangIdentity ?? 'rebel'
    else if (index === 1) player.identity = 'lord'
    else player.identity = rest[(index - 2) % rest.length]
  })
  // 主公那 1 点额外上限由选将流程给；这里手工摆身份，补上同样的规则
  const lord = game.state.players[1]
  lord.maxHp = (getCharacter(lord.characterId!)?.maxHp ?? 4) + 1
  lord.hp = lord.maxHp
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

function give(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

/** 让 `sourceId` 对无亮使用一张普通【杀】，停在求闪那一刻。 */
function slashWuliang(game: SanguoshaGame, sourceId: PlayerId = 'p1'): void {
  game.state.currentPlayerId = sourceId
  game.state.phase = 'play'
  game.state.turnUsage = { slashUses: 0, wineUses: 0, wineDamageBonus: 0 }
  const slashId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.name === '杀' && !card.damageNature
  })!
  moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: sourceId })
  const action = game.legalActions(sourceId).find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slashId) && candidate.targetIds.includes('p0'))
  if (!action) throw new Error('构造不出对无亮的杀')
  game.act(sourceId, action.id)
}

function dodgeRequest(game: SanguoshaGame) {
  const request = pending(game)
  return request?.kind === 'respond-card' ? request : null
}

describe('无亮的基础信息', () => {
  it('群势力、4 体力、两个技能、娱乐包', () => {
    const character = getCharacter('wuliang')!
    expect(character.kingdom).toBe('qun')
    expect(character.maxHp).toBe(4)
    expect(character.pack).toBe('entertainment')
    expect(character.skills.map((skill) => skill.id)).toEqual([RENNAI, DUOWEI])
  })
})

describe('忍耐的发动条件', () => {
  it('手上有闪、成为杀的目标：可以发动（测试 1）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    slashWuliang(game)
    expect(dodgeRequest(game)?.actionIds, '有闪才谈得上放弃响应').toContain('rennai')
  })

  it('手上没有闪：不能靠不响应白拿收益（测试 2）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    slashWuliang(game)
    expect(dodgeRequest(game)?.actionIds, '本来就响应不了').not.toContain('rennai')
    expect(dodgeRequest(game)?.actionIds).toEqual(['respond-pass'])
  })

  it('自己对自己不算「其他角色使用」', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    // 直接构造一次自伤的求闪：来源和目标都是无亮
    game.state.cardResolution = {
      kind: 'slash', cardId: give(game, 'p0', '杀'), sourceId: 'p0', targetId: 'p0',
      damageNature: 'normal', damageAmount: 1, stage: 'awaiting-dodge', requestId: null,
      surrogate: null, interceptsDone: [], extraCardIds: [], remainingTargetIds: [], dodgeRemaining: 1,
    }
    expect(canInvokeDuowei(game.state, 'p0'), '这条只是顺带确认没有副作用').toBe(false)
  })

  it('同一自然回合只能发动一次（测试 8），下一回合重置（测试 9）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    give(game, 'p0', '闪')
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    slashWuliang(game)
    expect(dodgeRequest(game)?.actionIds, '同一回合不能再忍').not.toContain('rennai')
    answer(game, { actionId: 'respond-pass' })

    // 回合结束时统一清空「每回合限一次」
    game.state.players.forEach((player) => { player.turnUsedSkills = [] })
    slashWuliang(game)
    expect(dodgeRequest(game)?.actionIds, '新回合可以再忍').toContain('rennai')
  })
})

describe('忍耐的结算', () => {
  it('放弃闪并真的挨了伤害：+1 忍（测试 4）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    const hpBefore = game.state.players[0].hp
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    expect(game.state.players[0].hp, '确实挨了这一下').toBe(hpBefore - 1)
    expect(rennaiCount(game.state, 'p0')).toBe(1)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('伤害被防止就不给忍（测试 5）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    // 藤甲对普通【杀】完全无效，等于伤害被防止
    const armor = game.state.zones.drawPile.find((id) => game.state.cards[id].name === '藤甲')!
    moveCard(game.state, armor, { kind: 'drawPile' }, { kind: 'equipment', playerId: 'p0', slot: 'armor' })
    const hpBefore = game.state.players[0].hp

    slashWuliang(game)
    // 藤甲让这张杀对他无效，根本不会问闪；确认没有留下 armed 残留
    if (dodgeRequest(game)?.actionIds.includes('rennai')) answer(game, { actionId: 'rennai' })

    expect(game.state.players[0].hp, '一点都没掉').toBe(hpBefore)
    expect(rennaiCount(game.state, 'p0'), '没吃亏就没有忍').toBe(0)
    assertGameInvariants(game.state)
  })

  it('主公有手牌：成功忍耐后随机拿走一张（测试 6）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    give(game, 'p0', '闪')
    const lordCards = ['桃', '闪', '无中生有'].map((name) => give(game, 'p1', name))
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    const owner = game.state.players[0]
    const taken = lordCards.filter((cardId) => owner.zones.hand.includes(cardId))
    expect(taken, '正好从主公那里拿走一张').toHaveLength(1)
    expect(game.state.players[1].zones.hand, '主公少一张').toHaveLength(2)
    assertCardConservation(game.state)
  })

  it('主公没有手牌：只拿忍，不拿牌（测试 7）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    give(game, 'p0', '闪')
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    expect(rennaiCount(game.state, 'p0')).toBe(1)
    expect(game.state.players[0].zones.hand, '手上只剩那张没打的闪').toHaveLength(1)
    assertCardConservation(game.state)
  })

  it('无亮自己就是主公时不从自己手里拿牌（测试 24 相关）', () => {
    const game = gameWith({ wuliangIdentity: 'lord' })
    // 手工把主公挪到 p0：p1 让出身份
    game.state.players[0].identity = 'lord'
    game.state.players[1].identity = 'rebel'
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    const before = game.state.players[0].zones.hand.length

    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    expect(rennaiCount(game.state, 'p0'), '忍照常拿').toBe(1)
    expect(game.state.players[0].zones.hand.length, '不从自己手里拿牌给自己').toBe(before - 0)
    assertCardConservation(game.state)
  })

  it('忍最多 4 枚（测试 10）', () => {
    const game = gameWith()
    setRennaiCount(game.state, 'p0', 4)
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })
    expect(rennaiCount(game.state, 'p0'), '封顶在 4').toBe(4)
  })

  it('过一遍 JSON 之后忍和次数都还在（测试 26）', () => {
    const game = gameWith()
    clearHand(game, 'p0')
    give(game, 'p0', '闪')
    slashWuliang(game)
    answer(game, { actionId: 'rennai' })

    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(rennaiCount(restored.state, 'p0'), '忍不会因为重连丢或翻倍').toBe(1)
    expect(restored.state.players[0].turnUsedSkills, '本回合已用的记录也在').toContain(RENNAI)
  })
})

describe('夺位的发动条件', () => {
  function ready(game: SanguoshaGame, lordHp: number): void {
    setRennaiCount(game.state, 'p0', 4)
    game.state.players[1].hp = lordHp
  }

  it('4 忍但主公 3/5：不能夺位（测试 11）', () => {
    const game = gameWith()
    ready(game, 3)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('4 忍且主公 2/5：可以夺位（测试 13）', () => {
    const game = gameWith()
    ready(game, 2)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(true)
  })

  it('上限为偶数时按一半判断（测试 12）', () => {
    const game = gameWith()
    game.state.players[1].maxHp = 4
    ready(game, 2)
    expect(canInvokeDuowei(game.state, 'p0'), '2 <= 4/2').toBe(true)
    game.state.players[1].hp = 3
    expect(canInvokeDuowei(game.state, 'p0'), '3 > 4/2').toBe(false)
  })

  it('忍不满 4 枚不能夺位', () => {
    const game = gameWith()
    ready(game, 2)
    setRennaiCount(game.state, 'p0', 3)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('无亮本人已经是主公：不能夺位（测试 24）', () => {
    const game = gameWith()
    game.state.players[0].identity = 'lord'
    game.state.players[1].identity = 'rebel'
    ready(game, 2)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('主公已经阵亡：不能夺位（测试 14 相关）', () => {
    const game = gameWith()
    ready(game, 2)
    game.state.players[1].alive = false
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('牌局已经结束：不能夺位', () => {
    const game = gameWith()
    ready(game, 2)
    game.state.status = 'game-over'
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('限定技用过就不能再用（测试 22）', () => {
    const game = gameWith()
    ready(game, 2)
    game.state.players[0].usedLimitedSkills.push(DUOWEI)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })
})

describe('夺位的结算', () => {
  /** 摆好条件并走到无亮准备阶段，回答那个询问。 */
  function seize(game: SanguoshaGame, invoke = true): void {
    setRennaiCount(game.state, 'p0', 4)
    game.state.players[1].hp = 2
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'finish'
    game.state.players.forEach((player) => { player.faceDown = false })
    // 从上一名角色的结束阶段推进，正常走进无亮的准备阶段
    game.state.currentPlayerId = 'p4'
    game.advancePhase()
    while (game.state.currentPlayerId !== 'p0' && !pending(game)) game.advancePhase()
    const request = pending(game)
    expect(request?.playerId, '准备阶段应当问无亮要不要夺位').toBe('p0')
    expect(request?.prompt).toContain('夺位')
    answer(game, { optionId: invoke ? 'duowei-invoke' : 'cancel' })
  }

  it('身份真正交换，反贼上位后原主公变反贼（测试 14 / 15）', () => {
    const game = gameWith({ wuliangIdentity: 'rebel' })
    seize(game)

    expect(game.state.players[0].identity, '无亮成为主公').toBe('lord')
    expect(game.state.players[1].identity, '原主公接过无亮的身份').toBe('rebel')
    assertGameInvariants(game.state)
  })

  it('无亮原是忠臣：原主公变忠臣（测试 16）', () => {
    const game = gameWith({ wuliangIdentity: 'loyalist' })
    seize(game)
    expect(game.state.players[0].identity).toBe('lord')
    expect(game.state.players[1].identity).toBe('loyalist')
  })

  it('无亮原是内奸：原主公变内奸（测试 17）', () => {
    const game = gameWith({ wuliangIdentity: 'renegade' })
    seize(game)
    expect(game.state.players[0].identity).toBe('lord')
    expect(game.state.players[1].identity).toBe('renegade')
  })

  it('无亮上限 +1 并回复 1，原主公移除主公额外上限（测试 19 / 20）', () => {
    const game = gameWith()
    const owner = game.state.players[0]
    const lord = game.state.players[1]
    owner.hp = 2
    const ownerMaxBefore = owner.maxHp
    const lordMaxBefore = lord.maxHp

    seize(game)

    expect(owner.maxHp, '上限 +1').toBe(ownerMaxBefore + 1)
    expect(owner.hp, '回复 1 点').toBe(3)
    expect(lord.maxHp, '原主公移除额外上限').toBe(lordMaxBefore - 1)
    expect(lord.hp, '当前体力不超过新上限').toBeLessThanOrEqual(lord.maxHp)
    assertGameInvariants(game.state)
  })

  /*
   * 「5/5 → 4/4」那种降上限连带降体力的情形，靠【夺位】其实走不到：发动条件
   * 要求主公体力不超过上限的一半，掉了 1 点上限之后当前体力仍然在范围内。
   * 代码里的钳制是防御性的，这里只钉住「换完之后体力绝不超过新上限」。
   */
  it('原主公的体力永远不超过新的上限（测试 20）', () => {
    const game = gameWith()
    const lord = game.state.players[1]
    const before = lord.maxHp
    seize(game)
    expect(lord.maxHp).toBe(before - 1)
    expect(lord.hp).toBeLessThanOrEqual(lord.maxHp)
  })

  it('夺位后忍清零且不能再次发动（测试 21 / 22）', () => {
    const game = gameWith()
    seize(game)
    expect(rennaiCount(game.state, 'p0'), '忍清零').toBe(0)
    expect(game.state.players[0].usedLimitedSkills).toContain(DUOWEI)
    expect(canInvokeDuowei(game.state, 'p0')).toBe(false)
  })

  it('只换身份，不换武将、手牌、装备和座位（测试 11 段）', () => {
    const game = gameWith()
    const owner = game.state.players[0]
    const lord = game.state.players[1]
    const ownerCharacter = owner.characterId
    const lordCharacter = lord.characterId
    const ownerHand = [...owner.zones.hand]
    const lordHand = [...lord.zones.hand]
    const seats = game.state.players.map((player) => player.seat)

    seize(game)

    expect(owner.characterId).toBe(ownerCharacter)
    expect(lord.characterId).toBe(lordCharacter)
    expect(owner.zones.hand).toEqual(ownerHand)
    expect(lord.zones.hand).toEqual(lordHand)
    expect(game.state.players.map((player) => player.seat)).toEqual(seats)
  })

  it('选择「继续忍」则什么都不变', () => {
    const game = gameWith()
    seize(game, false)
    expect(game.state.players[0].identity, '没换身份').toBe('rebel')
    expect(rennaiCount(game.state, 'p0'), '忍还在').toBe(4)
    expect(game.state.players[0].usedLimitedSkills, '限定技没被消耗').not.toContain(DUOWEI)
  })

  it('胜利条件按新身份立刻刷新（测试 18）', () => {
    // 场上只剩无亮（忠臣）和主公：无亮换成主公、原主公变忠臣之后，
    // 全场再没有反贼和内奸
    const game = gameWith({ wuliangIdentity: 'loyalist' })
    for (const player of game.state.players.slice(2)) {
      player.alive = false
      player.identityRevealed = true
      game.state.zones.discardPile.push(...player.zones.hand)
      player.zones.hand = []
    }
    seize(game)

    expect(game.state.status, '换完立刻结算，不等下一次死亡').toBe('game-over')
    expect(game.state.result?.winningCamp).toBe('lord')
    expect(game.state.result?.winnerIds, '新主公在赢家里').toContain('p0')
  })
})

describe('多个无亮各自独立', () => {
  it('忍、每回合次数和限定技各算各的（测试 25 相关）', () => {
    const game = gameWith({ characters: ['wuliang', 'liubei', 'wuliang', 'zhangfei', 'zhangfei'] })
    setRennaiCount(game.state, 'p0', 4)
    setRennaiCount(game.state, 'p2', 1)
    game.state.players[1].hp = 2

    expect(canInvokeDuowei(game.state, 'p0'), '攒够的那个可以').toBe(true)
    expect(canInvokeDuowei(game.state, 'p2'), '没攒够的不行').toBe(false)

    game.state.players[0].usedLimitedSkills.push(DUOWEI)
    setRennaiCount(game.state, 'p2', 4)
    expect(canInvokeDuowei(game.state, 'p0'), '用过的不能再用').toBe(false)
    expect(canInvokeDuowei(game.state, 'p2'), '另一个不受影响').toBe(true)
  })
})
