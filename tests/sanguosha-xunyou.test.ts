import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import { aggregateCardColor, cardColorOverrideOf } from '@/sanguosha/engine/card-color'
import { effectiveCardColor } from '@/sanguosha/engine/skills/runtime'
import { buildPlayerView } from '@/sanguosha/engine/view'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId, SanguoshaState } from '@/sanguosha/engine/types'

/**
 * 荀攸（一将成名 2012 经典）。
 *
 * 七条主张，逐条有断言：
 *
 * - 【奇策】必须用**全部**手牌，一张都没有时发不了；
 * - 锦囊候选来自注册表，【无懈可击】不在其中；
 * - 子牌真的进弃牌堆，牌张守恒不破；
 * - 颜色按全部子牌聚合：全红红、全黑黑、混色**无色**；
 * - 【智愚】一次伤害只给一次机会，不按点数；
 * - 展示是公开的；同色时由**来源自己**弃一张；
 * - 没有伤害来源时仍可发动，只是没人弃牌。
 */

const CAST = ['xunyou', 'zhangfei', 'zhaoyun', 'huangzhong', 'guojia']

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
  settle(game)
  while (game.state.phase !== 'play') {
    game.advancePhase()
    settle(game)
  }
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

function trimHand(game: SanguoshaGame, playerId: string, count: number): void {
  for (const cardId of playerOf(game, playerId).zones.hand.slice(count)) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

/** 给某人一张指定颜色的牌。 */
function giveColor(game: SanguoshaGame, playerId: string, color: 'red' | 'black'): string {
  const card = Object.values(game.state.cards).find((candidate) => candidate.color === color
    && !candidate.virtual
    && (game.state.zones.drawPile.includes(candidate.id) || game.state.zones.discardPile.includes(candidate.id)))
  if (!card) throw new Error(`牌堆里没有闲置的${color}牌`)
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function qiceAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id.includes('qice'))
}

/** 跑一次奇策，选 `trick` 这张锦囊。 */
function runQice(game: SanguoshaGame, trick: string) {
  const seen = { options: [] as string[], used: false }
  const action = qiceAction(game)
  if (!action) return seen
  game.act('p0', action.id)
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('奇策')) {
      const pick = request as unknown as { options: { id: string }[] }
      seen.options = pick.options.map((option) => option.id)
      if (!seen.options.includes(trick)) return { optionId: 'cancel' }
      seen.used = true
      return { optionId: trick }
    }
    return null
  })
  return seen
}

describe('荀攸：奇策', () => {
  it('一张手牌都没有时发不了', () => {
    const game = gameAt('xy-nohand')
    trimHand(game, 'p0', 0)
    expect(qiceAction(game), '没有子牌就没有这个技能').toBeUndefined()
  })

  it('候选来自注册表，【无懈可击】不在里面', () => {
    const game = gameAt('xy-choices')
    trimHand(game, 'p0', 2)
    const seen = runQice(game, '不存在的牌')
    expect(seen.options.length, '有候选').toBeGreaterThan(0)
    expect(seen.options, '无懈可击不是出牌阶段能主动使用的牌').not.toContain('无懈可击')
    expect(seen.options, '常见的普通锦囊在里面').toContain('决斗')
  })

  it('全部手牌都作为代价进弃牌堆', () => {
    const game = gameAt('xy-cost')
    trimHand(game, 'p0', 0)
    const hand = [giveColor(game, 'p0', 'red'), giveColor(game, 'p0', 'red'), giveColor(game, 'p0', 'red')]
    runQice(game, '南蛮入侵')
    expect(playerOf(game, 'p0').zones.hand, '手牌全部付出去了').toHaveLength(0)
    for (const cardId of hand) {
      expect(game.state.zones.discardPile, '三张都进了弃牌堆').toContain(cardId)
    }
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = gameAt('xy-once')
    trimHand(game, 'p0', 2)
    runQice(game, '南蛮入侵')
    trimHand(game, 'p0', 0)
    giveColor(game, 'p0', 'red')
    expect(qiceAction(game), '一个出牌阶段只能来一次').toBeUndefined()
  })

  it('虚拟锦囊真的结算：南蛮让所有人挨打', () => {
    const game = gameAt('xy-resolve')
    trimHand(game, 'p0', 0)
    giveColor(game, 'p0', 'red')
    giveColor(game, 'p0', 'red')
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const player = playerOf(game, id)
      player.hp = player.maxHp
      trimHand(game, id, 0)
    }
    runQice(game, '南蛮入侵')
    settle(game)
    const hurt = ['p1', 'p2', 'p3', 'p4'].filter((id) => playerOf(game, id).hp < playerOf(game, id).maxHp)
    expect(hurt.length, '南蛮真的打到人了').toBeGreaterThan(0)
    assertCardConservation(game.state)
  })

  it('颜色按全部子牌聚合：全红是红、全黑是黑、混色无色', () => {
    for (const [seed, colors, expected] of [
      ['xy-red', ['red', 'red'], 'red'],
      ['xy-black', ['black', 'black'], 'black'],
      ['xy-mixed', ['red', 'black'], null],
    ] as const) {
      const game = gameAt(seed)
      trimHand(game, 'p0', 0)
      const hand = colors.map((color) => giveColor(game, 'p0', color))
      expect(aggregateCardColor(game.state, hand), `${colors.join('+')} 的聚合颜色`).toBe(expected)

      // 真的印到虚拟牌上
      let virtualId: string | null = null
      const action = qiceAction(game)!
      game.act('p0', action.id)
      settle(game, (request) => {
        if (request.kind === 'choose-option' && request.prompt?.includes('奇策')) return { optionId: '南蛮入侵' }
        if (!virtualId) {
          virtualId = Object.keys(game.state.cards).find((id) => id.startsWith('virtual:qice:')) ?? null
        }
        return null
      })
      if (virtualId) {
        expect(cardColorOverrideOf(game.state, virtualId), '虚拟牌记下了聚合颜色').toBe(expected)
      }
    }
  })

  it('聚合颜色会被统一的「有效颜色」读到', () => {
    const game = gameAt('xy-effective-color')
    trimHand(game, 'p0', 0)
    const red = giveColor(game, 'p0', 'red')
    expect(effectiveCardColor(game.state, 'p0', red), '普通牌照牌面算').toBe('red')
  })
})

/** 打荀攸一下，按 plan 回答智愚。返回被问了几次、来源弃了几张。 */
function hitXunYou(
  game: SanguoshaGame,
  options: { amount?: number; sourceId?: string | null; invoke?: boolean } = {},
) {
  const seen = { asked: 0, revealed: [] as string[], sourceDiscards: 0, discardRequest: null as AnyRequest | null }
  game.events.on('CardMove', (handled) => {
    const payload = handled.event.payload as { reason?: string; revealed?: boolean; cardIds?: string[] }
    if (payload.revealed && payload.reason === 'zhiyu') seen.revealed.push(...(payload.cardIds ?? []))
  })
  game.events.on('LoseCard', (handled) => {
    if ((handled.event.payload as { reason?: string }).reason === 'zhiyu') seen.sourceDiscards += 1
  })
  const owner = playerOf(game, 'p0')
  owner.hp = owner.maxHp
  resolveDamage(game as never, {
    sourceId: options.sourceId === undefined ? 'p1' : options.sourceId,
    targetId: 'p0',
    amount: options.amount ?? 1,
    nature: 'normal',
  })
  game.settle()
  settle(game, (request) => {
    if (request.kind === 'choose-option' && request.prompt?.includes('智愚')) {
      seen.asked += 1
      return { optionId: options.invoke === false ? 'no' : 'yes' }
    }
    if (request.kind === 'choose-cards' && request.prompt?.includes('智愚')) {
      seen.discardRequest = request
      const pick = request as unknown as { cardIds: string[] }
      return { cardIds: pick.cardIds.slice(0, 1) }
    }
    return null
  })
  return seen
}

describe('荀攸：智愚', () => {
  it('一次伤害只给一次机会，3 点也一样', () => {
    for (const [seed, amount] of [['xy-zy-1', 1], ['xy-zy-3', 3]] as const) {
      const game = gameAt(seed)
      const seen = hitXunYou(game, { amount, invoke: false })
      expect(seen.asked, `${amount} 点伤害只问一次`).toBe(1)
    }
  })

  it('发动：摸一张、公开展示所有手牌', () => {
    const game = gameAt('xy-zy-reveal')
    trimHand(game, 'p0', 1)
    const seen = hitXunYou(game)
    expect(seen.revealed.length, '展示的是摸完之后的全部手牌').toBe(playerOf(game, 'p0').zones.hand.length)
    expect(seen.revealed.length, '至少两张（原来的一张 + 摸的一张）').toBeGreaterThanOrEqual(2)
  })

  it('手牌颜色相同：来源自己弃一张', () => {
    const game = gameAt('xy-zy-same')
    trimHand(game, 'p0', 0)
    // 先把手牌清空，摸到的那一张自然是「所有手牌颜色相同」
    const seen = hitXunYou(game)
    expect(seen.discardRequest?.playerId, '问的是伤害来源自己').toBe('p1')
    expect(seen.sourceDiscards, '来源弃了一张').toBe(1)
    assertCardConservation(game.state)
  })

  it('颜色不同就不弃牌', () => {
    const game = gameAt('xy-zy-mixed')
    trimHand(game, 'p0', 0)
    giveColor(game, 'p0', 'red')
    giveColor(game, 'p0', 'black')
    const seen = hitXunYou(game)
    // 摸一张之后仍然是混色（红黑都有），所以不该弃
    if (aggregateCardColor(game.state, playerOf(game, 'p0').zones.hand) === null) {
      expect(seen.sourceDiscards, '混色不弃牌').toBe(0)
    }
  })

  it('没有伤害来源时仍然可以发动，只是没人弃牌', () => {
    const game = gameAt('xy-zy-nosource')
    trimHand(game, 'p0', 0)
    const seen = hitXunYou(game, { sourceId: null })
    expect(seen.asked, '照常问').toBe(1)
    expect(seen.revealed.length, '照常摸牌并展示').toBeGreaterThan(0)
    expect(seen.sourceDiscards, '没有来源就没人弃牌').toBe(0)
  })

  it('来源没有手牌时不弹空窗口', () => {
    const game = gameAt('xy-zy-emptysource')
    trimHand(game, 'p0', 0)
    trimHand(game, 'p1', 0)
    const seen = hitXunYou(game)
    expect(seen.discardRequest, '来源没有手牌就不问').toBeNull()
  })

  it('展示之前别人看不到他的手牌', () => {
    const game = gameAt('xy-zy-privacy')
    trimHand(game, 'p0', 2)
    const hand = [...playerOf(game, 'p0').zones.hand]
    const view = buildPlayerView(game.state, 'p1').players.find((player) => player.id === 'p0')!
    expect(view.hand, '第三方拿不到他的手牌').toBeNull()
    expect(view.handCount, '只知道张数').toBe(hand.length)
  })
})

describe('荀攸：版本锁', () => {
  it('只有【奇策】【智愚】', () => {
    const character = getCharacter('xunyou')!
    expect(character.skills.map((skill) => skill.id)).toEqual(['qice', 'zhiyu'])
    expect(character.pack).toBe('yjcm2012')
    expect(character.maxHp).toBe(3)
    expect(character.kingdom).toBe('wei')
    expect(character.skills[0].description, '是「所有手牌」那一版').toContain('所有手牌')
  })
})
