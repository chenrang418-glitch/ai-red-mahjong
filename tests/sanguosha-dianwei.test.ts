import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 典韦【强袭】。
 *
 * 采用经典火包版：出牌阶段限一次，失去 1 点体力或弃置一张武器牌，
 * 然后对**攻击范围内**的一名其他角色造成 1 点伤害。
 *
 * 这几条钉住的重点是「代价和伤害都走公共入口」：
 * 失去体力不能触发受伤时机、伤害必须能推到濒死、武器必须真的是武器栏里的牌。
 */

function gameWith(characterIds: string[], seed = 'dianwei'): SanguoshaGame {
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

function qiangxiAction(game: SanguoshaGame) {
  return game.legalActions('p0').find((action) => action.id === 'skill:qiangxi')
}

/** 把某张牌直接装进指定装备栏。 */
function equip(game: SanguoshaGame, playerId: PlayerId, cardName: string, slot: 'weapon' | 'armor'): string {
  const cardId = Object.values(game.state.cards).find((card) => card.name === cardName)?.id
  if (!cardId) throw new Error(`这副牌里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.equipment[slot] = cardId
  return cardId
}

/** 走完「发动 → 选代价 → 选目标」，返回目标最终体力。 */
function useQiangxi(game: SanguoshaGame, cost: 'hp' | 'weapon' | null, targetId: PlayerId): void {
  game.act('p0', qiangxiAction(game)!.id)
  if (cost) {
    const ask = pending(game)
    expect(ask?.kind, '两种代价都付得起时应当先问选哪个').toBe('choose-option')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: cost } })
  }
  const targetAsk = pending(game)
  expect(targetAsk?.kind, '应当接着问打谁').toBe('choose-targets')
  game.respond({ requestId: targetAsk.id, playerId: 'p0', payload: { targetIds: [targetId] } })
}

describe('强袭的两种代价', () => {
  it('失去体力：自己掉一点血，目标掉一点血', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    const victim = game.state.players[1]
    const ownerHp = owner.hp
    const victimHp = victim.hp

    useQiangxi(game, null, 'p1')

    expect(owner.hp, '没有武器时只能失去体力').toBe(ownerHp - 1)
    expect(victim.hp).toBe(victimHp - 1)
    assertGameInvariants(game.state)
  })

  it('弃武器：武器进弃牌堆，自己不掉血', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    const weapon = equip(game, 'p0', '青釭剑', 'weapon')
    const ownerHp = owner.hp
    const victimHp = game.state.players[1].hp

    useQiangxi(game, 'weapon', 'p1')

    expect(owner.zones.equipment.weapon, '武器应当被弃掉').toBeNull()
    expect(game.state.zones.discardPile).toContain(weapon)
    expect(owner.hp, '弃武器就不该掉血').toBe(ownerHp)
    expect(game.state.players[1].hp).toBe(victimHp - 1)
    assertGameInvariants(game.state)
  })

  it('防具不能当武器用：只有防具时仍然只能失去体力', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    const armor = equip(game, 'p0', '八卦阵', 'armor')
    const ownerHp = owner.hp

    game.act('p0', qiangxiAction(game)!.id)
    // 只有一种代价付得起，不该问选哪个，直接问目标
    const ask = pending(game)
    expect(ask?.kind, '没有武器时不该出现代价选择').toBe('choose-targets')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(owner.hp, '付的是体力').toBe(ownerHp - 1)
    expect(owner.zones.equipment.armor, '防具不该被弃').toBe(armor)
    assertGameInvariants(game.state)
  })
})

describe('强袭的限制', () => {
  it('出牌阶段限一次', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    expect(qiangxiAction(game), '第一次应当可用').toBeTruthy()
    useQiangxi(game, null, 'p1')
    expect(qiangxiAction(game), '同一回合不能再发动').toBeFalsy()
    assertGameInvariants(game.state)
  })

  it('攻击范围外的角色不在候选里', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.act('p0', qiangxiAction(game)!.id)
    const ask = pending(game)
    expect(ask.kind).toBe('choose-targets')
    const candidateIds = (ask as { candidateIds: PlayerId[] }).candidateIds
    expect(candidateIds, '不能打自己').not.toContain('p0')
    // 默认攻击范围 1，只有左右两家在范围内
    expect(candidateIds).toContain('p1')
    expect(candidateIds).toContain('p4')
    expect(candidateIds, '距离 2 的角色不该在候选里').not.toContain('p2')
  })

  it('攻击范围内一个人都没有时根本不出现这条动作', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players.slice(1)) player.alive = false
    expect(qiangxiAction(game)).toBeFalsy()
  })
})

describe('强袭走的是公共入口', () => {
  it('伤害能把目标推进濒死', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[1].hp = 1

    useQiangxi(game, null, 'p1')

    const rescuing = game.state.dying !== null || game.state.pendingRequests.some((request) => request.kind === 'rescue')
    expect(rescuing || !game.state.players[1].alive, '1 血目标应当进入濒死或死亡').toBe(true)
    assertGameInvariants(game.state)
  })

  it('失去体力不触发「受到伤害后」的技能', () => {
    // 目标位放曹操（奸雄挂在 Damaged 上），但代价是典韦自己失去体力，
    // 那一步绝不能产生 Damaged 事件
    const game = gameWith(['dianwei', 'caocao', 'zhangfei', 'zhangfei', 'zhangfei'])
    const damagedTargets: unknown[] = []
    game.events.on('Damaged', (context) => { damagedTargets.push(context.event.targetId) })

    game.act('p0', qiangxiAction(game)!.id)
    // 到这一步只付了代价，还没造成伤害
    expect(damagedTargets, '付代价阶段不该有任何伤害').toEqual([])

    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(damagedTargets, '只有强袭那一下是伤害').toEqual(['p1'])
    assertGameInvariants(game.state)
  })

  it('自己 1 血时发动会进入濒死，且不再问打谁', () => {
    const game = gameWith(['dianwei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[0].hp = 1

    game.act('p0', qiangxiAction(game)!.id)

    // 付代价就把自己打濒死了，这时候不该继续发问选目标
    const request = pending(game)
    expect(request?.kind, '应当停在求桃而不是选目标').not.toBe('choose-targets')
    assertGameInvariants(game.state)
  })
})
