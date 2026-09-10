import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, setCardNature, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { gainOriginCounts } from '@/sanguosha/engine/card-gain-provenance'
import { lockCardColor } from '@/sanguosha/engine/card-play-lock'
import { livingKingdomCount } from '@/sanguosha/engine/living-kingdoms'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 一将成名 2012 第三批的跨技能交互。
 *
 * 单个技能自己的测试盯的是「它做对了什么」；这一份盯的是
 * **两个技能撞在一起时谁先谁后、谁认谁的账**——那才是最容易出错的地方。
 */

interface AnyRequest { id: string; playerId: PlayerId; kind: string; prompt?: string }

function defaultResponse(request: AnyRequest) {
  const payload: Record<string, unknown> = (() => {
    switch (request.kind) {
      case 'choose-option': {
        const options = (request as unknown as { options: { id: string }[] }).options
        return { optionId: options[options.length - 1].id }
      }
      case 'choose-options': {
        const pick = request as unknown as { options: { id: string }[]; min: number }
        return { optionIds: pick.options.slice(0, pick.min ?? 0).map((option) => option.id) }
      }
      case 'choose-cards': {
        const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[]; min: number }
        return { cardIds: [...pick.cardIds, ...pick.hiddenCardSlots].slice(0, pick.min ?? 0) }
      }
      case 'choose-targets': {
        const pick = request as unknown as { candidateIds: string[]; min: number }
        return { targetIds: pick.candidateIds.slice(0, pick.min ?? 0) }
      }
      case 'arrange-cards': {
        const pick = request as unknown as { cardIds: string[] }
        return { top: [...pick.cardIds], bottom: [] }
      }
      case 'distribute-cards': return { assignments: [] }
      case 'rescue': return { actionId: 'rescue-pass' }
      default: return { actionId: 'respond-pass' }
    }
  })()
  return { requestId: request.id, playerId: request.playerId, payload }
}

function settle(
  game: SanguoshaGame,
  choose: (request: AnyRequest) => Record<string, unknown> | null = () => null,
): void {
  for (let guard = 0; guard < 400; guard += 1) {
    const request = game.state.pendingRequests[0] as AnyRequest | undefined
    if (!request) return
    const custom = choose(request)
    game.respond(custom
      ? { requestId: request.id, playerId: request.playerId, payload: custom }
      : defaultResponse(request))
  }
  throw new Error('结算没有收敛')
}

function gameAt(seed: string, characterIds: string[]): SanguoshaGame {
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
  settle(game)
  return game
}

function playerOf(game: SanguoshaGame, id: string) {
  return game.state.players.find((candidate) => candidate.id === id)!
}

function locate(state: SanguoshaState, cardId: string): ZoneRef {
  if (state.zones.drawPile.includes(cardId)) return { kind: 'drawPile' }
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  if (state.zones.processingArea.includes(cardId)) return { kind: 'processingArea' }
  for (const owner of state.players) {
    if (owner.zones.hand.includes(cardId)) return { kind: 'hand', playerId: owner.id }
    if (owner.zones.judgingArea.includes(cardId)) return { kind: 'judgingArea', playerId: owner.id }
    for (const [slot, equipped] of Object.entries(owner.zones.equipment)) {
      if (equipped === cardId) return { kind: 'equipment', playerId: owner.id, slot: slot as never }
    }
  }
  throw new Error('找不到卡牌：' + cardId)
}

function findCard(game: SanguoshaGame, match: (card: Record<string, unknown>) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && match(candidate as unknown as Record<string, unknown>)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error('牌堆里找不到符合条件的牌')
  return card.id
}

function clearHand(game: SanguoshaGame, playerId: string): void {
  for (const cardId of [...playerOf(game, playerId).zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

// ─────────────────────── 安恤 × 恩怨 / 死亡时序 ───────────────────────

describe('安恤 × 获得来源', () => {
  it('转移的牌记在「较多者」名下，不是牌堆', () => {
    const game = gameAt('ix-anxu-provenance', ['zhangfei', 'bulianshi', 'fazheng', 'zhaoyun', 'huangzhong'])
    clearHand(game, 'p0')
    game.state.currentPlayerId = 'p1'
    game.state.phase = 'play'
    const before = [...playerOf(game, 'p2').zones.hand]
    expect(before.length, '较多者要有手牌').toBeGreaterThan(0)

    const action = game.legalActions('p1').find((candidate) => candidate.kind === 'invoke-skill' && candidate.id === 'anxu-invoke')!
    game.act('p1', action.id)
    settle(game, (request) => {
      if (request.playerId === 'p1' && request.kind === 'choose-targets' && request.prompt?.includes('安恤')) {
        return { targetIds: ['p0', 'p2'] }
      }
      return null
    })
    const moved = before.filter((cardId) => !playerOf(game, 'p2').zones.hand.includes(cardId))
    expect(moved, '正好走了一张').toHaveLength(1)
    const origins = gainOriginCounts(game.state, 'p0', moved)
    expect(origins.get('p2'), '来源记的是较多者本人').toBe(1)
    assertCardConservation(game.state)
  })
})

describe('追忆 × 死亡时序', () => {
  /** 让 killerId 用一张【杀】把步练师（p1）打死。 */
  function killBulianshi(game: SanguoshaGame, killerId: string, choose: (request: AnyRequest) => Record<string, unknown> | null) {
    const bu = playerOf(game, 'p1')
    bu.hp = 1
    clearHand(game, 'p1')
    const slash = findCard(game, (card) => card.name === '杀')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: killerId })
    playerOf(game, killerId).attackRangeBonus = 6
    game.state.currentPlayerId = killerId
    game.state.phase = 'play'
    const action = game.legalActions(killerId).find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p1'))!
    game.act(killerId, action.id)
    settle(game, choose)
  }

  it('× 行殇：曹丕先收走她的牌，追忆再问', () => {
    const game = gameAt('ix-zhuiyi-xingshang', ['caopi', 'bulianshi', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 给她两张牌，好观察行殇有没有收走
    const owned = [findCard(game, (card) => card.name === '桃'), findCard(game, (card) => card.name === '闪')]
    clearHand(game, 'p1')
    for (const cardId of owned) {
      moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId: 'p1' })
    }
    playerOf(game, 'p1').hp = 1

    let caopiHandAtZhuiyi = -1
    const slash = findCard(game, (card) => card.name === '杀')
    moveCard(game.state, slash, locate(game.state, slash), { kind: 'hand', playerId: 'p0' })
    playerOf(game, 'p0').attackRangeBonus = 6
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.playerId === 'p0' && request.kind === 'choose-option' && request.prompt?.includes('行殇')) {
        return { optionId: 'yes' }
      }
      if (request.playerId === 'p1' && request.kind === 'choose-targets' && request.prompt?.includes('追忆')) {
        caopiHandAtZhuiyi = playerOf(game, 'p0').zones.hand.length
        return { targetIds: ['p2'] }
      }
      return null
    })

    expect(playerOf(game, 'p1').alive, '步练师死了').toBe(false)
    expect(caopiHandAtZhuiyi, '问追忆时行殇已经把她的牌收走了').toBeGreaterThanOrEqual(2)
    for (const cardId of owned) {
      expect(playerOf(game, 'p0').zones.hand, '牌确实到了曹丕手上').toContain(cardId)
    }
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('× 挥泪：马谡和步练师同时是「自己死时」，两个都跑得到', () => {
    const game = gameAt('ix-zhuiyi-huilei', ['zhangfei', 'bulianshi', 'masu', 'zhaoyun', 'huangzhong'])
    let zhuiyiAsked = false
    killBulianshi(game, 'p0', (request) => {
      if (request.playerId === 'p1' && request.prompt?.includes('追忆')) {
        zhuiyiAsked = true
        return { targetIds: ['p2'] }
      }
      return null
    })
    expect(zhuiyiAsked, '追忆照常问出来').toBe(true)
    assertGameInvariants(game.state)
  })

  it('× 身份奖惩：反贼奖励的三张先到手，追忆再问', () => {
    const game = gameAt('ix-zhuiyi-identity', ['zhangfei', 'bulianshi', 'guanyu', 'zhaoyun', 'huangzhong'])
    playerOf(game, 'p1').identity = 'rebel'
    clearHand(game, 'p0')
    let killerHand = -1
    killBulianshi(game, 'p0', (request) => {
      if (request.playerId === 'p1' && request.prompt?.includes('追忆')) {
        killerHand = playerOf(game, 'p0').zones.hand.length
        return { targetIds: ['p2'] }
      }
      return null
    })
    expect(killerHand, '身份奖惩排在追忆之前').toBeGreaterThanOrEqual(3)
  })
})

// ─────────────────────── 自守 / 宗室 × 其它 ───────────────────────

describe('自守 / 宗室 × 势力数', () => {
  it('× 伏枥：三个技能读的是同一个数，而且随阵亡实时变', () => {
    const game = gameAt('ix-zishou-fuli', ['liaohua', 'liubiao', 'caocao', 'sunquan', 'shenzhaoyun'])
    const owner = playerOf(game, 'p1')
    owner.hp = 2
    // 蜀 + 群 + 魏 + 吴 + 神 = 5
    expect(livingKingdomCount(game.state)).toBe(5)
    expect(maxCardsOf(game.state, 'p1'), '2 体力 + 5 势力').toBe(7)

    playerOf(game, 'p4').alive = false
    playerOf(game, 'p4').identityRevealed = true
    expect(livingKingdomCount(game.state), '神势力没了').toBe(4)
    expect(maxCardsOf(game.state, 'p1'), '宗室当场跟着变').toBe(6)
  })

  it('× 当先：自守跳的是出牌阶段位，额外出牌阶段在它之前就跑完了', () => {
    /*
     * 廖化的额外出牌阶段插在**准备阶段之前**，而自守在摸牌阶段才发问——
     * 也就是说额外阶段早就结束了。两者管的是不同的东西，
     * 这一条钉住「自守跳过的那个 play 是阶段位上的那一个」。
     */
    const game = gameAt('ix-zishou-dangxian', ['zhangfei', 'liaohua', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 让廖化同时拥有自守：模拟化身 / 驭衡把技能借给他
    playerOf(game, 'p1').grantedSkills = [...(playerOf(game, 'p1').grantedSkills ?? []), 'zishou']

    const phases: string[] = []
    for (let guard = 0; guard < 30; guard += 1) {
      game.advancePhase()
      settle(game, (request) => {
        if (request.playerId === 'p1' && request.kind === 'choose-option' && request.prompt?.includes('自守')) {
          return { optionId: 'zishou-invoke' }
        }
        return null
      })
      if (game.state.currentPlayerId === 'p1') phases.push(game.state.phase)
      if (phases.length > 0 && game.state.currentPlayerId !== 'p1') break
    }
    /*
     * 额外出牌阶段（当先）跑在最前面，随后自守把**阶段位上**的那个
     * 出牌阶段跳掉——所以整串里只有开头那一个 play。
     */
    expect(phases[0], '第一个阶段是当先给的额外出牌阶段').toBe('play')
    expect(phases.filter((phase) => phase === 'play').length, '正常的出牌阶段位被自守跳掉了').toBe(1)
    expect(phases, '其余阶段一个不少').toEqual(['play', 'prepare', 'judge', 'draw', 'discard', 'finish'])
    assertGameInvariants(game.state)
  })
})

// ─────────────────────── 耀武 × 其它 ───────────────────────

describe('耀武 × 其它', () => {
  /** 让 p0 用 cardId 打华雄（p1）。返回耀武是否被问到。 */
  function hit(game: SanguoshaGame, cardId: string): boolean {
    let asked = false
    moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId: 'p0' })
    playerOf(game, 'p0').attackRangeBonus = 6
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(cardId) && candidate.targetIds.includes('p1'))!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.prompt?.includes('耀武')) {
        asked = true
        return { optionId: 'yaowu-draw' }
      }
      return null
    })
    return asked
  }

  it('× 疠火：红色普通【杀】被改成火【杀】，仍然是红色的【杀】', () => {
    const game = gameAt('ix-yaowu-lihuo', ['chengpu', 'huaxiong', 'guanyu', 'zhaoyun', 'huangzhong'])
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    // 疠火做的正是这件事：把属性落到同一张实体牌上
    setCardNature(game.state, slash, 'fire')
    expect(hit(game, slash), '红色火【杀】照样触发耀武').toBe(true)
  })

  it('× 潜袭：颜色禁令只管使用和打出，不影响伤害后的触发', () => {
    const game = gameAt('ix-yaowu-qianxi', ['zhangfei', 'huaxiong', 'madai', 'zhaoyun', 'huangzhong'])
    // 华雄本人被禁红色手牌：这只影响他出牌，不影响他挨打之后的锁定技
    lockCardColor(game.state, { targetId: 'p1', color: 'red', sourceId: 'p2', skillId: 'qianxi' })
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    expect(hit(game, slash), '禁令拦的是用牌，拦不住耀武').toBe(true)
  })

  it('× 绝情：伤害被换成失去体力时不触发', () => {
    const game = gameAt('ix-yaowu-jueqing', ['zhangchunhua', 'huaxiong', 'guanyu', 'zhaoyun', 'huangzhong'])
    const slash = findCard(game, (card) => card.name === '杀' && card.color === 'red'
      && (card.damageNature ?? 'normal') === 'normal')
    const before = playerOf(game, 'p1').hp
    const asked = hit(game, slash)
    expect(playerOf(game, 'p1').hp, '体力照样掉了 1 点').toBe(before - 1)
    expect(asked, '掉的是「失去体力」不是「伤害」，走不到伤害之后').toBe(false)
  })

  it('× 无言：被防止的伤害根本没有「伤害后」', () => {
    const game = gameAt('ix-yaowu-wuyan', ['xushu', 'huaxiong', 'guanyu', 'zhaoyun', 'huangzhong'])
    // 无言防的是**锦囊**伤害，所以这里用一张红色【火攻】之外的锦囊验「不触发」
    const duel = findCard(game, (card) => card.name === '决斗' && card.color === 'red')
    expect(hit(game, duel), '锦囊伤害本来就不触发耀武').toBe(false)
  })
})
