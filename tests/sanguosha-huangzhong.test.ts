import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 黄忠【烈弓】。
 *
 * 经典风包版：锁定技，使用【杀】指定目标后，若目标手牌数
 * ≤ 自己体力值 或 ≥ 自己体力上限，该【杀】不可被【闪】响应。
 *
 * 这里钉住三件事：条件判对、不可闪时**不发求闪请求**（而不是发了再忽略回答）、
 * 以及不可闪走的仍是 landSlash（寒冰剑这类「伤害前」效果不能被跳过）。
 */

function gameWith(characterIds: string[], seed = 'huangzhong'): SanguoshaGame {
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

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

/**
 * 把 p1 的手牌调成恰好 count 张（全是【闪】，保证「有闪却闪不了」而不是「没闪」），
 * 然后 p0 出杀打 p1。
 */
function slashWithVictimHand(game: SanguoshaGame, count: number) {
  const slash = giveNamed(game, 'p0', '杀')
  // 清手牌要把牌送进弃牌堆，直接清空数组会破坏牌张守恒
  const victim = game.state.players[1]
  game.state.zones.discardPile.push(...victim.zones.hand)
  victim.zones.hand = []
  for (let index = 0; index < count; index += 1) giveNamed(game, 'p1', '闪')
  const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
  if (!action) throw new Error('构造不出对 p1 的杀')
  game.act('p0', action.id)
  return game.state.pendingRequests[0]
}

const FILLER = ['huangzhong', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('烈弓的触发条件', () => {
  it('目标手牌数小于等于自己体力值：不可闪', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 3
    const victimHp = game.state.players[1].hp

    const request = slashWithVictimHand(game, 3)

    expect(request?.kind ?? '', '不可闪时根本不该发求闪请求').not.toBe('respond-card')
    expect(game.state.players[1].hp, '直接吃伤害').toBe(victimHp - 1)
    expect(game.state.players[1].zones.hand.length, '闪没被打出去').toBe(3)
    assertGameInvariants(game.state)
  })

  it('目标手牌数大于等于自己体力上限：不可闪', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 1
    const owner = game.state.players[0]
    const victimHp = game.state.players[1].hp

    const request = slashWithVictimHand(game, owner.maxHp)

    expect(request?.kind ?? '').not.toBe('respond-card')
    expect(game.state.players[1].hp).toBe(victimHp - 1)
    assertGameInvariants(game.state)
  })

  it('两个条件都不满足时照常求闪', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 1
    // 手牌数落在 (体力值, 体力上限) 开区间里才躲得掉；4 血上限时只有 2、3 张可用
    expect(owner.maxHp).toBe(4)

    const request = slashWithVictimHand(game, 2)

    expect(request?.kind, '不满足条件就该正常求闪').toBe('respond-card')
    expect(request.playerId).toBe('p1')
    assertGameInvariants(game.state)
  })

  it('体力值变化会改变判定结果', () => {
    // 同样 3 张手牌：黄忠 3 血时命中「≤体力值」，2 血时两个条件都不满足
    const undodgeable = gameWith(FILLER)
    undodgeable.state.players[0].hp = 3
    expect(slashWithVictimHand(undodgeable, 3)?.kind ?? '').not.toBe('respond-card')

    const dodgeable = gameWith(FILLER)
    dodgeable.state.players[0].hp = 2
    expect(slashWithVictimHand(dodgeable, 3)?.kind).toBe('respond-card')
  })

  it('目标空手时命中「≤体力值」', () => {
    const game = gameWith(FILLER)
    const victimHp = game.state.players[1].hp
    const request = slashWithVictimHand(game, 0)
    expect(request?.kind ?? '').not.toBe('respond-card')
    expect(game.state.players[1].hp).toBe(victimHp - 1)
  })
})

describe('烈弓不影响别人', () => {
  it('没有烈弓的人出杀照常求闪', () => {
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[0].hp = 3
    const request = slashWithVictimHand(game, 3)
    expect(request?.kind, '张飞没有烈弓').toBe('respond-card')
  })

  it('黄忠自己挨杀时照常能闪', () => {
    const game = gameWith(['zhangfei', 'huangzhong', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[0].hp = 3
    const request = slashWithVictimHand(game, 3)
    expect(request?.kind, '烈弓只在自己出杀时生效').toBe('respond-card')
  })
})

describe('烈弓走的是公共结算', () => {
  it('不可闪的杀仍然经过「伤害前」时机：藤甲照样免疫', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 3
    const armor = Object.values(game.state.cards).find((card) => card.name === '藤甲')!.id
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== armor)
    game.state.players[1].zones.equipment.armor = armor
    const victimHp = game.state.players[1].hp

    slashWithVictimHand(game, 3)

    expect(game.state.players[1].hp, '藤甲让普通杀无效，不可闪也绕不过去').toBe(victimHp)
    assertGameInvariants(game.state)
  })

  it('不可闪的杀能把目标推进濒死', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 3
    game.state.players[1].hp = 1

    slashWithVictimHand(game, 3)

    const rescuing = game.state.dying !== null || game.state.pendingRequests.some((request) => request.kind === 'rescue')
    expect(rescuing || !game.state.players[1].alive).toBe(true)
    assertGameInvariants(game.state)
  })

  it('结算干净收尾，不留下悬空的 cardResolution', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 3
    slashWithVictimHand(game, 3)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})
