import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { GameRng } from '@/sanguosha/engine/rng'
import { decideResponse } from '@/sanguosha/ai/index'
import { emptySuspicion } from '@/sanguosha/ai/belief'
import { runSoakGame } from '@/sanguosha/ai/soak'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 一将成名 2012 的 AI **选得对不对**。
 *
 * 「技能发动次数 > 0」在写这些分支之前就已经成立了，所以那个数字
 * 证明不了任何事。这里断言的是**立场**：
 *
 * - 安恤把牌从敌人搬给自己人，而不是反过来；
 * - 追忆把最后那份好处留给自己人；
 * - 耀武的来源残血选回血、满血选摸牌；
 * - 潜袭禁的是敌人。
 */

function contextFor(game: SanguoshaGame, playerId: string) {
  return {
    view: game.viewFor(playerId),
    difficulty: 'hard' as const,
    rng: new GameRng(`ai-test:${playerId}`),
    suspicion: emptySuspicion(game.viewFor(playerId)),
  }
}

/**
 * 造一个身份**全部公开**的局面。
 *
 * 敌我判断靠 `hostility`，而它读的是已公开的身份；不公开的话
 * AI 只能靠推断，测试就变成了在测推断而不是在测这几条分支。
 */
function openGame(seed: string, characterIds: string[]): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  // p0 主公、p1 忠臣（自己人）、p2/p3 反贼（敌人）、p4 内奸
  const identities: Identity[] = ['lord', 'loyalist', 'rebel', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = true
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) break
    game.respond(decideResponse(contextFor(game, request.playerId), request))
  }
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function setHandCount(game: SanguoshaGame, playerId: string, count: number): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (let index = 0; index < count; index += 1) {
    moveCard(game.state, game.state.zones.drawPile[0], { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

/** 直接把一条请求交给 AI，拿回它的 payload。 */
function ask(game: SanguoshaGame, viewerId: string, request: GameRequest): Record<string, unknown> {
  return decideResponse(contextFor(game, viewerId), request) .payload as Record<string, unknown>
}

describe('AI × 步练师【安恤】', () => {
  it('把牌从敌人搬给自己人，而不是反过来', () => {
    // 忠臣 p1 手牌少、反贼 p2 手牌多 —— 正确答案显然是 [p1, p2]
    const game = openGame('ai-anxu', ['bulianshi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    setHandCount(game, 'p1', 1)
    setHandCount(game, 'p2', 5)
    setHandCount(game, 'p3', 3)
    setHandCount(game, 'p4', 3)

    const payload = ask(game, 'p0', {
      id: 'r-anxu', kind: 'choose-targets', playerId: 'p0',
      prompt: '【安恤】：选择两名手牌数不同的其他角色',
      timeoutMs: 25_000, optional: false,
      skillId: 'anxu', skillStep: 'targets',
      candidateIds: ['p1', 'p2', 'p3', 'p4'], min: 2, max: 2,
    } as GameRequest)

    const [low, high] = payload.targetIds as PlayerId[]
    expect(low, '拿牌的是手牌少的自己人').toBe('p1')
    expect(high, '出牌的是手牌多的敌人').toBe('p2')
  })

  it('自己人手牌反而多时，不会把自己人的牌送给敌人', () => {
    const game = openGame('ai-anxu-reverse', ['bulianshi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    setHandCount(game, 'p1', 5)  // 忠臣，手牌多
    setHandCount(game, 'p2', 1)  // 反贼，手牌少
    setHandCount(game, 'p3', 5)  // 反贼，手牌多
    setHandCount(game, 'p4', 1)  // 内奸，手牌少

    const payload = ask(game, 'p0', {
      id: 'r-anxu2', kind: 'choose-targets', playerId: 'p0',
      prompt: '【安恤】：选择两名手牌数不同的其他角色',
      timeoutMs: 25_000, optional: false,
      skillId: 'anxu', skillStep: 'targets',
      candidateIds: ['p1', 'p2', 'p3', 'p4'], min: 2, max: 2,
    } as GameRequest)

    const [low, high] = payload.targetIds as PlayerId[]
    /*
     * 这一局里没有「自己人少、敌人多」的组合，所以不存在赚的选法。
     * 要守住的底线只有一条：**绝不能把自己人的牌送给敌人**。
     *
     * （内奸 p4 对主公不算自己人，所以「从 p3 搬给 p4」和
     * 「从 p3 搬给 p2」在 AI 眼里同样中性，选哪个都可以。）
     */
    const friendlyGiver = low === 'p1'
    const enemyReceiver = high === 'p2' || high === 'p3'
    expect(
      !(enemyReceiver && !friendlyGiver) || high !== 'p1',
      `不该出现「从自己人 p1 手里搬给敌人」，实际选了 ${low} ← ${high}`,
    ).toBe(true)
    expect(high, '出牌的（被拿走一张的）不该是自己人 p1').not.toBe('p1')
  })
})

describe('AI × 步练师【追忆】', () => {
  it('最后那份好处留给自己人，而且优先最需要的', () => {
    const game = openGame('ai-zhuiyi', ['bulianshi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    // 忠臣 p1 残血，反贼 p2 也残血 —— 应该选 p1
    playerOf(game, 'p1').hp = 1
    playerOf(game, 'p2').hp = 1

    const payload = ask(game, 'p0', {
      id: 'r-zhuiyi', kind: 'choose-targets', playerId: 'p0',
      prompt: '【追忆】：令一名其他角色回复 1 点体力，然后摸两张牌',
      timeoutMs: 20_000, optional: true,
      skillId: 'zhuiyi', skillStep: 'target',
      candidateIds: ['p1', 'p2', 'p3', 'p4'], min: 0, max: 1,
    } as GameRequest)

    expect(payload.targetIds, '给了自己人').toEqual(['p1'])
  })

  it('两个自己人都在时，选更需要的那个', () => {
    const game = openGame('ai-zhuiyi-need', ['bulianshi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    // 让 p3 也当忠臣，这样主公有两个货真价实的自己人可选
    playerOf(game, 'p3').identity = 'loyalist'
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    setHandCount(game, 'p1', 4)
    playerOf(game, 'p3').hp = 1
    setHandCount(game, 'p3', 0)

    const payload = ask(game, 'p0', {
      id: 'r-zhuiyi2', kind: 'choose-targets', playerId: 'p0',
      prompt: '【追忆】：令一名其他角色回复 1 点体力，然后摸两张牌',
      timeoutMs: 20_000, optional: true,
      skillId: 'zhuiyi', skillStep: 'target',
      candidateIds: ['p1', 'p3'], min: 0, max: 1,
    } as GameRequest)

    expect(payload.targetIds, '选了残血又没牌的那个自己人').toEqual(['p3'])
  })

  it('候选里一个自己人都没有：宁可不发动，也不给敌人回血摸牌', () => {
    const game = openGame('ai-zhuiyi-enemies', ['bulianshi', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    const payload = ask(game, 'p0', {
      id: 'r-zhuiyi3', kind: 'choose-targets', playerId: 'p0',
      prompt: '【追忆】：令一名其他角色回复 1 点体力，然后摸两张牌',
      timeoutMs: 20_000, optional: true,
      skillId: 'zhuiyi', skillStep: 'target',
      candidateIds: ['p2', 'p3'], min: 0, max: 1,
    } as GameRequest)
    expect(payload.targetIds, '全是反贼，交空数组＝放弃').toEqual([])
  })
})

describe('AI × 华雄【耀武】', () => {
  function yaowuChoiceOf(game: SanguoshaGame, sourceId: string): string {
    const payload = ask(game, sourceId, {
      id: 'r-yaowu', kind: 'choose-option', playerId: sourceId,
      prompt: '玩家1的锁定技【耀武】：选择一项',
      timeoutMs: 20_000, optional: false,
      skillId: 'yaowu', skillStep: 'choose',
      options: [{ id: 'yaowu-recover', label: '回复 1 点体力' }, { id: 'yaowu-draw', label: '摸一张牌' }],
    } as GameRequest)
    return payload.optionId as string
  }

  it('来源残血：选回复', () => {
    const game = openGame('ai-yaowu-hurt', ['zhangfei', 'huaxiong', 'zhaoyun', 'huangzhong', 'guojia'])
    playerOf(game, 'p0').hp = 1
    expect(yaowuChoiceOf(game, 'p0')).toBe('yaowu-recover')
  })

  it('来源满血：回复没有收益，改摸牌', () => {
    const game = openGame('ai-yaowu-full', ['zhangfei', 'huaxiong', 'zhaoyun', 'huangzhong', 'guojia'])
    const source = playerOf(game, 'p0')
    source.hp = source.maxHp
    expect(yaowuChoiceOf(game, 'p0')).toBe('yaowu-draw')
  })
})

describe('AI × 马岱【潜袭】', () => {
  it('禁的是敌人，而且挑手牌最多的那个', () => {
    const game = openGame('ai-qianxi', ['madai', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    setHandCount(game, 'p1', 6)  // 忠臣，手牌最多——但不该选他
    setHandCount(game, 'p2', 5)  // 反贼
    setHandCount(game, 'p3', 2)  // 反贼

    const payload = ask(game, 'p0', {
      id: 'r-qianxi', kind: 'choose-targets', playerId: 'p0',
      prompt: '【潜袭】：选择一名距离为 1 的角色，其本回合不能使用或打出红色手牌',
      timeoutMs: 25_000, optional: false,
      skillId: 'qianxi', skillStep: 'target',
      candidateIds: ['p1', 'p2', 'p3'], min: 1, max: 1,
    } as GameRequest)

    expect(payload.targetIds, '选的是手牌最多的敌人，不是手牌最多的自己人').toEqual(['p2'])
  })
})

describe('AI × 刘表【自守】', () => {
  function zishouChoiceOf(game: SanguoshaGame, playerId: string): string {
    const payload = ask(game, playerId, {
      id: 'r-zishou', kind: 'choose-option', playerId,
      prompt: '发动【自守】？额外摸 3 张牌（共 5 张），然后跳过你的出牌阶段',
      timeoutMs: 20_000, optional: false,
      skillId: 'zishou', skillStep: 'ask',
      options: [
        { id: 'zishou-invoke', label: '发动【自守】' },
        { id: 'cancel', label: '不发动，正常摸 2 张' },
      ],
    } as GameRequest)
    return payload.optionId as string
  }

  it('手上没有进攻牌：发动，把出牌阶段换成一把牌', () => {
    const game = openGame('ai-zishou-poor', ['liubiao', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    setHandCount(game, 'p0', 0)
    expect(zishouChoiceOf(game, 'p0')).toBe('zishou-invoke')
  })

  it('手上有两张以上能打的牌：不发动，别把出牌阶段让出去', () => {
    const game = openGame('ai-zishou-armed', ['liubiao', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia'])
    const owner = playerOf(game, 'p0')
    for (const cardId of [...owner.zones.hand]) {
      moveCard(game.state, cardId, { kind: 'hand', playerId: 'p0' }, { kind: 'discardPile' })
    }
    let given = 0
    for (const card of Object.values(game.state.cards)) {
      if (given >= 3) break
      if (card.name !== '杀' || card.virtual) continue
      if (!game.state.zones.drawPile.includes(card.id)) continue
      moveCard(game.state, card.id, { kind: 'drawPile' }, { kind: 'hand', playerId: 'p0' })
      given += 1
    }
    expect(given, '前提：真的发到了三张【杀】').toBe(3)
    expect(zishouChoiceOf(game, 'p0')).toBe('cancel')
  })
})

describe('AI 改动之后牌局仍然跑得完', () => {
  it('一将成名 2012 全 12 人轮转 80 局全部正常结束', () => {
    const cast = [
      'caozhang', 'zhonghui', 'xunyou', 'wangyi',
      'liaohua', 'guanxingzhangbao', 'madai', 'chengpu',
      'handang', 'bulianshi', 'liubiao', 'huaxiong',
    ]
    for (let index = 0; index < 80; index += 1) {
      const rotated = Array.from({ length: 8 }, (_, offset) => cast[(index + offset) % cast.length])
      const result = runSoakGame({ seed: `ai-yjcm12-${index}`, playerCount: 8, characterIds: rotated })
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)
})
