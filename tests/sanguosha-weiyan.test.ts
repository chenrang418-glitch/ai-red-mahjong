import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { resolveDamage } from '@/sanguosha/engine/damage'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 魏延【狂骨】。
 *
 * 经典风包版：锁定技，对距离 1 以内的角色造成伤害后回复等量体力。
 *
 * 重点不是「杀能不能触发」，而是**任何来源的伤害都要触发**——
 * 只对【杀】写特判是这类技能最常见的错法。
 */

function gameWith(characterIds: string[], seed = 'weiyan'): SanguoshaGame {
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

/** 直接走统一伤害入口，绕开具体是哪张牌造成的。 */
function hit(game: SanguoshaGame, sourceId: PlayerId, targetId: PlayerId, amount: number, cardName = '杀'): void {
  resolveDamage(game as never, { sourceId, targetId, amount, cardName })
}

const FILLER = ['weiyan', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('狂骨的触发条件', () => {
  it('对距离 1 以内的角色造成伤害后回血', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 2

    hit(game, 'p0', 'p1', 1)

    expect(owner.hp, '距离 1 的邻座，应当回一点').toBe(3)
    assertGameInvariants(game.state)
  })

  it('距离超过 1 不回血', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 2

    // 五人局里 p2 距离 2
    hit(game, 'p0', 'p2', 1)

    expect(owner.hp, '距离 2 不该触发').toBe(2)
    assertGameInvariants(game.state)
  })

  it('回复量等于实际伤害点数', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 1
    game.state.players[1].hp = 4

    hit(game, 'p0', 'p1', 2)

    expect(owner.hp, '造成 2 点就回 2 点').toBe(3)
    assertGameInvariants(game.state)
  })

  it('满血时照常触发但没有实际回复', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    expect(owner.hp).toBe(owner.maxHp)

    hit(game, 'p0', 'p1', 1)

    expect(owner.hp, '不能超过体力上限').toBe(owner.maxHp)
    assertGameInvariants(game.state)
  })
})

describe('狂骨不只认【杀】', () => {
  it('决斗造成的伤害同样触发', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    hit(game, 'p0', 'p1', 1, '决斗')
    expect(game.state.players[0].hp).toBe(3)
  })

  it('南蛮入侵造成的伤害同样触发', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    hit(game, 'p0', 'p1', 1, '南蛮入侵')
    expect(game.state.players[0].hp).toBe(3)
  })

  it('技能造成的伤害同样触发', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    hit(game, 'p0', 'p1', 1, '强袭')
    expect(game.state.players[0].hp).toBe(3)
  })
})

describe('狂骨的边界', () => {
  it('别人造成的伤害不给魏延回血', () => {
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    hit(game, 'p1', 'p2', 1)
    expect(game.state.players[0].hp).toBe(2)
  })

  it('把目标打到濒死也照样回血', () => {
    // AfterDamage 在进入濒死之前，这一条钉住那个顺序
    const game = gameWith(FILLER)
    game.state.players[0].hp = 2
    game.state.players[1].hp = 1

    hit(game, 'p0', 'p1', 1)

    expect(game.state.players[0].hp, '目标濒死不影响魏延回血').toBe(3)
    const rescuing = game.state.dying !== null || game.state.pendingRequests.some((request) => request.kind === 'rescue')
    expect(rescuing || !game.state.players[1].alive, '目标应当进入濒死或死亡').toBe(true)
    assertGameInvariants(game.state)
  })

  it('魏延自己已经死了就不回血', () => {
    const game = gameWith(FILLER)
    const owner = game.state.players[0]
    owner.hp = 0
    owner.alive = false

    hit(game, 'p0', 'p1', 1)

    expect(owner.hp, '死人不回血').toBe(0)
  })
})
