import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { createVirtualTrick } from '@/sanguosha/engine/virtual-trick'
import { isInjectedCard } from '@/sanguosha/engine/card-injection'
import { recordedNames } from '@/sanguosha/engine/card-name-history'
import { QIZHENG } from '@/sanguosha/data/characters/god-shenxunyu'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 神·荀彧。
 *
 * 三个技能里最容易写错的是**秘密性**：【奇正相生】的奇兵/正兵只有使用者知道，
 * 目标要在不知情的前提下决定打【杀】还是【闪】。所以这里除了规则，
 * 还专门按「玩家视图 / 决策记录 / 待处理请求 / 重连快照」四条通道各查一遍——
 * 任何一条漏出去，这张牌就没有存在的意义了。
 */

const CAST = ['shenxunyu', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-cards': {
        // 拆牌、顺牌这类请求 min 是 1，回空数组会被判非法
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        const pool = [...pick.cardIds, ...pick.hiddenCardSlots]
        return { cardIds: pool.slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

/** 开局技能（天佐之类）可能立刻问点什么，全部按最保守的方式回掉。 */
function drainSetupRequests(game: SanguoshaGame): void {
  for (let guard = 0; guard < 100; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    game.respond(defaultResponse(request as AnyRequest))
  }
  throw new Error('开局请求没有收敛')
}

function gameAt(seed: string, characterIds: string[] = CAST): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    player.characterId = characterIds[index]
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  drainSetupRequests(game)
  while (game.state.phase !== 'play') game.advancePhase()
  return game
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as keyof typeof owner.zones.equipment }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function giveCard(game: SanguoshaGame, playerId: string, cardName: string): string {
  const own = game.state.players.find((player) => player.id === playerId)!
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.name === cardName && !own.zones.hand.includes(candidate.id))
  if (!card) throw new Error('牌堆里没有【' + cardName + '】')
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string, except: string[] = []): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName || except.includes(cardId)) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function useOn(game: SanguoshaGame, actorId: string, cardId: string, targetIds: string[]): void {
  const action = game.legalActions(actorId).find((candidate) => (
    candidate.kind === 'use-card'
    && candidate.cardIds.includes(cardId)
    && candidate.targetIds.length === targetIds.length
    && targetIds.every((id) => candidate.targetIds.includes(id))
  ))
  if (!action) throw new Error('找不到出牌动作：' + cardId + ' -> ' + targetIds.join(','))
  game.act(actorId, action.id)
}

/** 一路放弃直到结算完；`choose` 可以拦下某几个请求给出真正的选择。 */
function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

/** 手牌 + 装备 + 判定区，也就是【过河拆桥】能拆到的全部区域。 */
function ownedCardCount(game: SanguoshaGame, playerId: string): number {
  const player = game.state.players.find((candidate) => candidate.id === playerId)!
  return player.zones.hand.length
    + player.zones.judgingArea.length
    + Object.values(player.zones.equipment).filter(Boolean).length
}

/** 找到手里那张能当作 `name` 打出去的响应动作。 */
function respondActionFor(game: SanguoshaGame, playerId: string, name: string): string {
  const player = game.state.players.find((candidate) => candidate.id === playerId)!
  const cardId = player.zones.hand.find((candidate) => game.state.cards[candidate]?.name === name)
  if (!cardId) throw new Error(playerId + ' 手上没有【' + name + '】')
  // 奇正相生是「杀或闪」二选一，action 里必须写明这一下算哪一种
  return (name === '杀' ? 'respond-trick-as-slash:' : 'respond-trick-as-dodge:') + cardId
}

describe('神·荀彧：天佐', () => {
  it('开局把 8 张【奇正相生】洗进牌堆，是能摸能用的真牌', () => {
    const game = gameAt('xunyu-tianzuo')
    const injected = Object.values(game.state.cards).filter((card) => card.name === QIZHENG)
    expect(injected).toHaveLength(8)
    for (const card of injected) {
      expect(isInjectedCard(card.id)).toBe(true)
      expect(card.virtual, '天佐加的是实体牌，不是虚拟牌').toBeFalsy()
      expect(card.category).toBe('trick')
    }
    // 洗进去而不是堆在末尾：8 张不该全挤在牌堆最后
    const positions = injected
      .map((card) => game.state.zones.drawPile.indexOf(card.id))
      .filter((index) => index >= 0)
    expect(Math.min(...positions)).toBeLessThan(game.state.zones.drawPile.length - 8)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('场上没有神荀彧就一张都不加', () => {
    const game = gameAt('xunyu-absent', ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong'])
    expect(Object.values(game.state.cards).filter((card) => card.name === QIZHENG)).toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('【奇正相生】对他无效：既不掉血也不被拿牌', () => {
    const game = gameAt('xunyu-immune')
    stripCard(game, '无懈可击')
    // p0 是神荀彧，让 p1 对他用
    game.state.currentPlayerId = 'p1'
    const cardId = giveCard(game, 'p1', QIZHENG)
    const hpBefore = game.state.players[0].hp
    const handBefore = game.state.players[0].zones.hand.length

    useOn(game, 'p1', cardId, ['p0'])
    settle(game)

    expect(game.state.players[0].hp, '无效就是无效，不该掉血').toBe(hpBefore)
    expect(game.state.players[0].zones.hand.length).toBeGreaterThanOrEqual(handBefore)
    expect(game.state.zones.discardPile).toContain(cardId)
    assertCardConservation(game.state)
  })
})

describe('神·荀彧：【奇正相生】的秘密选择', () => {
  /** 让 p1 对 p2 用一张奇正相生，停在「已经选完模式、正等目标响应」那一刻。 */
  function pausedAtResponse(seed: string, mode: 'qi' | 'zheng'): SanguoshaGame {
    const game = gameAt(seed)
    stripCard(game, '无懈可击')
    game.state.currentPlayerId = 'p1'
    const cardId = giveCard(game, 'p1', QIZHENG)
    useOn(game, 'p1', cardId, ['p2'])
    for (let guard = 0; guard < 50; guard += 1) {
      const request = game.state.pendingRequests[0] as AnyRequest | undefined
      if (!request) throw new Error('没有走到模式选择')
      if (request.kind === 'choose-option' && request.playerId === 'p1') {
        game.respond({ requestId: request.id, playerId: 'p1', payload: { optionId: mode } })
        return game
      }
      game.respond(defaultResponse(request))
    }
    throw new Error('没有走到模式选择')
  }

  it('目标和旁观者的视图里都读不到奇兵还是正兵', () => {
    const game = pausedAtResponse('xunyu-secret-view', 'qi')
    for (const viewerId of ['p0', 'p2', 'p3', 'p4']) {
      const serialized = JSON.stringify(game.viewFor(viewerId))
      expect(serialized, viewerId + ' 的视图漏出了模式').not.toContain('"qi"')
      expect(serialized, viewerId + ' 的视图漏出了模式').not.toContain('"zheng"')
      expect(serialized).not.toContain('qizheng-mode')
    }
  })

  it('决策记录里存的是 hidden，快照传出去也不会泄密', () => {
    const game = pausedAtResponse('xunyu-secret-decision', 'zheng')
    const decision = [...game.state.decisions].reverse()
      .find((candidate) => candidate.requestId.startsWith('request-qizheng-'))
    expect(decision, '模式选择必须留下一条决策记录').toBeTruthy()
    expect(decision!.payload).toEqual({ optionId: 'hidden' })
  })

  it('待处理请求里只剩目标那条求牌，提示词不说是奇还是正', () => {
    const game = pausedAtResponse('xunyu-secret-request', 'qi')
    const request = game.state.pendingRequests[0] as AnyRequest
    expect(request.playerId).toBe('p2')
    expect(request.prompt).not.toContain('奇兵')
    expect(request.prompt).not.toContain('正兵')
  })

  it('序列化重连之后仍然只有使用者知道', () => {
    const game = pausedAtResponse('xunyu-secret-restore', 'zheng')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(JSON.stringify(restored.viewFor('p2'))).not.toContain('zheng')
    // 但服务端自己必须记得，否则重连之后这张牌就结算不下去了
    const effect = restored.state.cardResolution?.effect as { kind?: string; mode?: string } | null
    expect(effect?.kind).toBe('qizheng')
    expect(effect?.mode).toBe('zheng')
  })
})

describe('神·荀彧：【奇正相生】的结算', () => {
  /** p1 对 p2 用一张奇正相生，模式和目标的响应都由参数决定。 */
  function play(seed: string, mode: 'qi' | 'zheng', respondAs: '杀' | '闪' | null): SanguoshaGame {
    const game = gameAt(seed)
    stripCard(game, '无懈可击')
    stripCard(game, '杀')
    stripCard(game, '闪')
    game.state.currentPlayerId = 'p1'
    const cardId = giveCard(game, 'p1', QIZHENG)
    if (respondAs) giveCard(game, 'p2', respondAs)
    useOn(game, 'p1', cardId, ['p2'])
    settle(game, (request) => {
      if (request.kind === 'choose-option' && request.playerId === 'p1') return { optionId: mode }
      if (request.kind === 'respond-card' && request.playerId === 'p2') {
        return respondAs ? { actionId: respondActionFor(game, 'p2', respondAs) } : { actionId: 'respond-pass' }
      }
      return null
    })
    return game
  }

  it('奇兵：目标打不出【杀】就受到 1 点伤害', () => {
    const game = play('xunyu-qi-fail', 'qi', null)
    expect(game.state.players[2].hp).toBe(game.state.players[2].maxHp - 1)
    assertCardConservation(game.state)
  })

  it('奇兵：打出【杀】就平安无事', () => {
    const game = play('xunyu-qi-ok', 'qi', '杀')
    expect(game.state.players[2].hp).toBe(game.state.players[2].maxHp)
  })

  it('奇兵：打错成【闪】照样掉血，而且那张【闪】已经没了', () => {
    const game = play('xunyu-qi-wrong', 'qi', '闪')
    expect(game.state.players[2].hp).toBe(game.state.players[2].maxHp - 1)
    expect(game.state.players[2].zones.hand.some((id) => game.state.cards[id]?.name === '闪')).toBe(false)
    assertCardConservation(game.state)
  })

  it('正兵：目标打不出【闪】就要被拿走一张牌，但不掉血', () => {
    const game = play('xunyu-zheng-fail', 'zheng', null)
    expect(game.state.players[2].hp, '正兵不造成伤害').toBe(game.state.players[2].maxHp)
    assertCardConservation(game.state)
  })

  it('正兵：打出【闪】就什么都不发生', () => {
    const game = play('xunyu-zheng-ok', 'zheng', '闪')
    expect(game.state.players[2].hp).toBe(game.state.players[2].maxHp)
  })
})

describe('神·荀彧：灵策', () => {
  function drawCountAfter(seed: string, use: (game: SanguoshaGame) => void): number {
    const game = gameAt(seed)
    stripCard(game, '无懈可击')
    const before = game.state.players[0].zones.hand.length
    use(game)
    settle(game)
    return game.state.players[0].zones.hand.length - before
  }

  it('别人使用实体【无中生有】，他摸一张', () => {
    const gained = drawCountAfter('xunyu-lingce-wuzhong', (game) => {
      game.state.currentPlayerId = 'p1'
      const cardId = giveCard(game, 'p1', '无中生有')
      useOn(game, 'p1', cardId, ['p1'])
    })
    expect(gained).toBe(1)
  })

  it('不在名单上的锦囊不摸', () => {
    const gained = drawCountAfter('xunyu-lingce-other', (game) => {
      game.state.currentPlayerId = 'p1'
      const cardId = giveCard(game, 'p1', '决斗')
      useOn(game, 'p1', cardId, ['p3'])
    })
    expect(gained).toBe(0)
  })

  it('虚拟锦囊不算：印出来的【过河拆桥】不触发', () => {
    const game = gameAt('xunyu-lingce-virtual')
    stripCard(game, '无懈可击')
    game.state.currentPlayerId = 'p1'
    const cardId = createVirtualTrick(game.state, 'p1', '过河拆桥', 'zuoxing')
    const before = game.state.players[0].zones.hand.length
    useOn(game, 'p1', cardId, ['p3'])
    settle(game)
    expect(game.state.players[0].zones.hand.length - before, '虚拟牌不是实体锦囊').toBe(0)
  })

  it('【奇正相生】本身也在名单里', () => {
    const gained = drawCountAfter('xunyu-lingce-qizheng', (game) => {
      game.state.currentPlayerId = 'p1'
      const cardId = giveCard(game, 'p1', QIZHENG)
      useOn(game, 'p1', cardId, ['p2'])
    })
    expect(gained).toBeGreaterThanOrEqual(1)
  })
})

describe('神·荀彧：定汉', () => {
  it('第一次被锦囊指定：记录牌名并取消自己这个目标', () => {
    const game = gameAt('xunyu-dinghan-first')
    stripCard(game, '无懈可击')
    game.state.currentPlayerId = 'p1'
    const cardId = giveCard(game, 'p1', '过河拆桥')
    const before = game.state.players[0].zones.hand.length

    useOn(game, 'p1', cardId, ['p0'])
    settle(game)

    expect(recordedNames(game.state, 'p0', 'dinghan')).toContain('过河拆桥')
    expect(game.state.players[0].zones.hand.length, '目标被取消就不该被拆牌')
      .toBeGreaterThanOrEqual(before)
    assertCardConservation(game.state)
  })

  it('同一种牌名只能取消一次，第二张照常结算', () => {
    const game = gameAt('xunyu-dinghan-twice')
    stripCard(game, '无懈可击')
    game.state.currentPlayerId = 'p1'
    // 拆的可能是装备或判定区的牌，只数手牌会看不出来
    const before = ownedCardCount(game, 'p0')
    useOn(game, 'p1', giveCard(game, 'p1', '过河拆桥'), ['p0'])
    settle(game)
    const afterFirst = ownedCardCount(game, 'p0')
    /*
     * 第一张：定汉取消了目标，一张牌都没被拆走；
     * 但【过河拆桥】在智囊牌名里，灵策照样摸一张——所以净 +1。
     * 灵策看的是「使用」，取消的是「成为目标」，两件事互不影响。
     */
    expect(afterFirst - before, '目标被取消，但灵策仍然摸一张').toBe(1)

    useOn(game, 'p1', giveCard(game, 'p1', '过河拆桥'), ['p0'])
    settle(game)
    // 第二张：同名牌的取消资格已经用掉，真的被拆一张，灵策再摸一张，净 0
    expect(ownedCardCount(game, 'p0'), '第二张【过河拆桥】必须真的拆到牌')
      .toBe(afterFirst)
    assertCardConservation(game.state)
  })

  it('多目标锦囊只取消他自己，其他人照常结算', () => {
    const game = gameAt('xunyu-dinghan-multi')
    stripCard(game, '无懈可击')
    stripCard(game, '闪')
    game.state.currentPlayerId = 'p1'
    const cardId = giveCard(game, 'p1', '万箭齐发')
    const hpBefore = game.state.players.map((player) => player.hp)

    useOn(game, 'p1', cardId, ['p0', 'p2', 'p3', 'p4'])
    settle(game)

    expect(game.state.players[0].hp, '定汉取消了神荀彧这个目标').toBe(hpBefore[0])
    expect(game.state.players[2].hp, '其他人照常挨箭').toBe(hpBefore[2] - 1)
    assertCardConservation(game.state)
  })
})
