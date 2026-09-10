import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { gainOriginCounts } from '@/sanguosha/engine/card-gain-provenance'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 步练师（一将成名 2012）。
 *
 * 逐条有断言的主张：
 *
 * - 【安恤】只选**其他**角色，而且两人手牌数必须不同；
 * - 手牌数全场相同时按钮根本不出现；
 * - 一个人 0 张、另一个有牌是合法的；
 * - 牌是**实体移动**：多者手上少一张、少者手上多同一张，没有复制；
 * - 挑牌的是**获得者**，而且只给暗手牌占位槽——步练师看不到多者的手牌；
 * - 黑桃不摸，其余三种花色都摸一张；
 * - 【追忆】在**真正阵亡**之后才有，被救回不触发；
 * - 先回复 1 点体力，再摸两张；目标只能是其他存活角色；
 * - 追忆结算在**身份奖惩之后**（它排队，等牌局干净了再问）。
 */

const CAST = ['zhangfei', 'bulianshi', 'zhaoyun', 'huangzhong', 'guojia']
const BU_ID = 'p1'

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

function gameAtBuPlay(seed: string, characterIds: string[] = CAST): SanguoshaGame {
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
  for (let guard = 0; guard < 20; guard += 1) {
    game.advancePhase()
    settle(game)
    if (game.state.currentPlayerId === BU_ID && game.state.phase === 'play') return game
  }
  throw new Error('没有走到步练师的出牌阶段')
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

function findFreeSuit(game: SanguoshaGame, suit: string, used: Set<string>): string {
  const card = Object.values(game.state.cards).find((candidate) => !candidate.virtual
    && candidate.suit === suit && !used.has(candidate.id)
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${suit}`)
  used.add(card.id)
  return card.id
}

/** 精确设定某人的手牌张数（内容任意）。 */
function setHandCount(game: SanguoshaGame, playerId: string, count: number): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (let index = 0; index < count; index += 1) {
    const cardId = game.state.zones.drawPile[0]
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  }
}

function setHandCards(game: SanguoshaGame, playerId: string, cardIds: string[]): void {
  const owner = playerOf(game, playerId)
  for (const cardId of [...owner.zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
  for (const cardId of cardIds) {
    moveCard(game.state, cardId, locate(game.state, cardId), { kind: 'hand', playerId })
  }
}

function anxuAction(game: SanguoshaGame) {
  return game.legalActions(BU_ID).find((action) => action.kind === 'invoke-skill' && action.id === 'anxu-invoke')
}

/** 发动安恤指定两个目标；返回获得者被给到的候选（应当只有暗槽）。 */
function useAnxu(game: SanguoshaGame, targetIds: string[]): { openCandidates: string[]; hiddenSlots: string[]; picker: string | null } {
  const seen = { openCandidates: [] as string[], hiddenSlots: [] as string[], picker: null as string | null }
  game.act(BU_ID, anxuAction(game)!.id)
  settle(game, (request) => {
    if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('安恤')) {
      return { targetIds }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('安恤')) {
      const pick = request as unknown as { cardIds: string[]; hiddenCardSlots: string[] }
      seen.picker = request.playerId
      seen.openCandidates = [...pick.cardIds]
      seen.hiddenSlots = [...pick.hiddenCardSlots]
      return null
    }
    return null
  })
  return seen
}

describe('步练师【安恤】：目标合法性', () => {
  it('全场手牌数相同时按钮不出现', () => {
    const game = gameAtBuPlay('anxu-equal')
    for (const id of ['p0', 'p2', 'p3', 'p4']) setHandCount(game, id, 2)
    expect(anxuAction(game), '凑不出手牌数不同的一对').toBeUndefined()
    setHandCount(game, 'p0', 3)
    expect(anxuAction(game), '出现差异之后就能发动').toBeDefined()
  })

  it('候选里没有步练师自己', () => {
    const game = gameAtBuPlay('anxu-others-only')
    setHandCount(game, 'p0', 1)
    setHandCount(game, 'p2', 3)
    let candidates: string[] = []
    game.act(BU_ID, anxuAction(game)!.id)
    settle(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('安恤')) {
        candidates = [...(request as unknown as { candidateIds: string[] }).candidateIds]
        return { targetIds: ['p0', 'p2'] }
      }
      return null
    })
    expect(candidates, '不能选自己').not.toContain(BU_ID)
    expect(candidates, '其他四个人都在').toEqual(expect.arrayContaining(['p0', 'p2', 'p3', 'p4']))
  })

  it('一个人 0 张、另一个有牌：合法', () => {
    const game = gameAtBuPlay('anxu-zero-hand')
    setHandCount(game, 'p0', 0)
    setHandCount(game, 'p2', 2)
    expect(anxuAction(game), '0 张和 2 张是不同的手牌数').toBeDefined()
    useAnxu(game, ['p0', 'p2'])
    expect(playerOf(game, 'p0').zones.hand, '0 张的那位拿到一张').toHaveLength(1)
    expect(playerOf(game, 'p2').zones.hand, '2 张的那位少一张').toHaveLength(1)
    assertCardConservation(game.state)
  })
})

describe('步练师【安恤】：转移与隐私', () => {
  it('实体移动：多者少一张，少者多同一张，没有复制', () => {
    const game = gameAtBuPlay('anxu-move')
    setHandCount(game, 'p0', 1)
    setHandCount(game, 'p2', 3)
    const higherBefore = [...playerOf(game, 'p2').zones.hand]
    const lowerBefore = [...playerOf(game, 'p0').zones.hand]

    useAnxu(game, ['p0', 'p2'])
    const higherAfter = playerOf(game, 'p2').zones.hand
    const lowerAfter = playerOf(game, 'p0').zones.hand
    expect(higherAfter).toHaveLength(2)
    expect(lowerAfter).toHaveLength(2)
    const moved = higherBefore.filter((cardId) => !higherAfter.includes(cardId))
    expect(moved, '正好走了一张').toHaveLength(1)
    expect(lowerAfter, '走的那张到了少者手上').toContain(moved[0])
    expect(lowerAfter, '少者原有的牌还在').toEqual(expect.arrayContaining(lowerBefore))
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('挑牌的是获得者，而且只给暗牌占位槽', () => {
    const game = gameAtBuPlay('anxu-privacy')
    setHandCount(game, 'p0', 1)
    setHandCount(game, 'p2', 3)
    const seen = useAnxu(game, ['p0', 'p2'])
    expect(seen.picker, '挑牌的是手牌较少的那一位，不是步练师').toBe('p0')
    expect(seen.openCandidates, '没有任何一张明牌候选').toHaveLength(0)
    expect(seen.hiddenSlots, '给的是三个暗槽').toHaveLength(3)
    for (const slot of seen.hiddenSlots) {
      expect(Object.keys(game.state.cards), '槽不是真实牌 id').not.toContain(slot)
    }
  })

  it('步练师的视图里看不到多者的手牌', () => {
    const game = gameAtBuPlay('anxu-view')
    setHandCount(game, 'p0', 1)
    setHandCount(game, 'p2', 3)
    const higherHand = [...playerOf(game, 'p2').zones.hand]
    game.act(BU_ID, anxuAction(game)!.id)
    settle(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('安恤')) {
        return { targetIds: ['p0', 'p2'] }
      }
      if (request.kind === 'choose-cards' && request.prompt?.includes('安恤')) {
        // 就在挑牌这一刻检查步练师的视图
        const view = buildPlayerView(game.state, BU_ID)
        const seat = view.players.find((player) => player.id === 'p2')!
        const visible = JSON.stringify(seat)
        for (const cardId of higherHand) {
          expect(visible, `步练师不该看到 ${cardId}`).not.toContain(cardId)
        }
        expect(view.pendingRequest?.playerId, '挑牌的请求不属于步练师').not.toBe(BU_ID)
        return null
      }
      return null
    })
  })

  it('获得来源记的是「较多者」，不是牌堆', () => {
    const game = gameAtBuPlay('anxu-provenance')
    setHandCount(game, 'p0', 1)
    setHandCount(game, 'p2', 3)
    const before = [...playerOf(game, 'p2').zones.hand]
    useAnxu(game, ['p0', 'p2'])
    const moved = before.filter((cardId) => !playerOf(game, 'p2').zones.hand.includes(cardId))
    // gainOriginCounts 返回的是 Map<来源玩家, 张数>
    const origins = gainOriginCounts(game.state, 'p0', moved)
    expect(origins.get('p2'), '这张牌记成「从 p2 那里得到的」').toBe(1)
    expect([...origins.keys()], '没有别的来源').toEqual(['p2'])
  })
})

describe('步练师【安恤】：花色检查', () => {
  for (const [suit, label, draws] of [
    ['spade', '黑桃', 0],
    ['heart', '红桃', 1],
    ['diamond', '方块', 1],
    ['club', '梅花', 1],
  ] as Array<[string, string, number]>) {
    it(`获得的是${label}：步练师摸 ${draws} 张`, () => {
      const game = gameAtBuPlay(`anxu-suit-${suit}`)
      const used = new Set<string>()
      // 较多者手上**只有这一张**，所以挑到的必然是它
      setHandCards(game, 'p2', [findFreeSuit(game, suit, used)])
      setHandCount(game, 'p0', 0)
      const buBefore = playerOf(game, BU_ID).zones.hand.length

      useAnxu(game, ['p0', 'p2'])
      expect(playerOf(game, BU_ID).zones.hand.length - buBefore, `${label}应该摸 ${draws} 张`).toBe(draws)
      assertCardConservation(game.state)
    })
  }
})

describe('步练师【追忆】', () => {
  /** 让 p0 用一张【杀】把步练师打死；返回追忆被问到的候选。 */
  function killBulianshi(game: SanguoshaGame, choose: (request: AnyRequest) => Record<string, unknown> | null) {
    const bu = playerOf(game, BU_ID)
    bu.hp = 1
    setHandCount(game, BU_ID, 0)
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀' && !card.virtual
      && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
    moveCard(game.state, slash.id, locate(game.state, slash.id), { kind: 'hand', playerId: 'p0' })
    playerOf(game, 'p0').attackRangeBonus = 6
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes(BU_ID))!
    game.act('p0', action.id)
    settle(game, choose)
  }

  it('真正阵亡后才触发：回复 1 点、然后摸两张', () => {
    const game = gameAtBuPlay('zhuiyi-basic')
    const victim = playerOf(game, 'p2')
    victim.hp = victim.maxHp - 2
    const handBefore = victim.zones.hand.length

    let asked = false
    killBulianshi(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('追忆')) {
        asked = true
        return { targetIds: ['p2'] }
      }
      return null
    })

    expect(playerOf(game, BU_ID).alive, '步练师确实死了').toBe(false)
    expect(asked, '死亡之后问了追忆').toBe(true)
    expect(victim.hp, '回复 1 点体力').toBe(victim.maxHp - 1)
    expect(victim.zones.hand.length, '然后摸两张').toBe(handBefore + 2)
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('候选里只有其他存活角色', () => {
    const game = gameAtBuPlay('zhuiyi-others')
    let candidates: string[] = []
    killBulianshi(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('追忆')) {
        candidates = [...(request as unknown as { candidateIds: string[] }).candidateIds]
        return { targetIds: [] }
      }
      return null
    })
    expect(candidates, '不含她自己').not.toContain(BU_ID)
    expect(candidates.length, '其余四人都在').toBe(4)
    for (const id of candidates) expect(playerOf(game, id).alive, `${id} 必须活着`).toBe(true)
  })

  it('被救回不触发', () => {
    const game = gameAtBuPlay('zhuiyi-rescued')
    const bu = playerOf(game, BU_ID)
    bu.hp = 1
    // 给她一张【桃】，濒死时自救
    const peach = Object.values(game.state.cards).find((card) => card.name === '桃' && !card.virtual
      && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
    setHandCards(game, BU_ID, [peach.id])

    let asked = false
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀' && !card.virtual
      && (game.state.zones.drawPile.includes(card.id) || game.state.zones.discardPile.includes(card.id)))!
    moveCard(game.state, slash.id, locate(game.state, slash.id), { kind: 'hand', playerId: 'p0' })
    playerOf(game, 'p0').attackRangeBonus = 6
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.asCardName === '杀' && candidate.targetIds.includes(BU_ID))!
    game.act('p0', action.id)
    settle(game, (request) => {
      if (request.prompt?.includes('追忆')) asked = true
      if (request.kind === 'rescue' && request.playerId === BU_ID) return { actionId: `rescue-card:${peach.id}` }
      return null
    })

    expect(bu.alive, '被桃救回来了').toBe(true)
    expect(asked, '没死就不触发追忆').toBe(false)
  })

  it('结算在身份奖惩之后：反贼奖励的三张先到手', () => {
    /*
     * 步练师坐反贼位、被主公 p0 杀死。
     *
     * 身份奖惩（反贼被杀 → 击杀者摸三张）排在 `Death` 之后、
     * 而追忆是排队等牌局干净才问的，所以问到追忆时 p0 手上
     * 已经拿到了那三张。这一条钉住这个顺序。
     */
    const game = gameAtBuPlay('zhuiyi-after-identity')
    playerOf(game, BU_ID).identity = 'rebel'
    setHandCount(game, 'p0', 0)
    let killerHandAtAsk = -1
    killBulianshi(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('追忆')) {
        killerHandAtAsk = playerOf(game, 'p0').zones.hand.length
        return { targetIds: ['p2'] }
      }
      return null
    })
    expect(killerHandAtAsk, '问追忆时，反贼奖励的三张已经到手').toBeGreaterThanOrEqual(3)
  })

  it('不发动就什么都不做', () => {
    const game = gameAtBuPlay('zhuiyi-decline')
    const victim = playerOf(game, 'p2')
    victim.hp = victim.maxHp - 1
    const handBefore = victim.zones.hand.length
    killBulianshi(game, (request) => {
      if (request.playerId === BU_ID && request.kind === 'choose-targets' && request.prompt?.includes('追忆')) {
        return { targetIds: [] }
      }
      return null
    })
    expect(victim.hp, '没回血').toBe(victim.maxHp - 1)
    expect(victim.zones.hand.length, '没摸牌').toBe(handBefore)
    assertCardConservation(game.state)
  })
})
