import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { recordSkillGrantSource, skillGrantSourceOf } from '@/sanguosha/engine/skill-grant-source'
import { grantSkill } from '@/sanguosha/engine/skills/runtime'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神·郭嘉：把四个技能真的在引擎里跑一遍。
 *
 * 另一份 `sanguosha-shenguojia.test.ts` 测的是技能依赖的公共机制的性质；
 * 这里测的是**完整流程**——多步挂起、连续判定、虚拟锦囊真的用出去。
 */

function gameWith(characterIds: string[], seed = 'shenguojia-flow'): SanguoshaGame {
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
  return game
}

const CAST = ['shenguojia', 'zhangfei', 'guanyu', 'zhaoyun', 'machao']

function playerOf(game: SanguoshaGame, id: PlayerId) {
  return game.state.players.find((candidate) => candidate.id === id)!
}
function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.phase = 'play'
  game.state.skippedPhases = []
  for (const player of game.state.players) player.turnUsedSkills = []
}
function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0] as never
}
function skillAction(game: SanguoshaGame, ownerId: PlayerId, skillId: string) {
  return game.legalActions(ownerId).find((action) => action.kind === 'invoke-skill' && action.skillId === skillId)
}

/** 把牌堆顶铺成指定花色，好让连续判定的结果可控。 */
function stackDrawPile(game: SanguoshaGame, suits: Suit[]): void {
  const pile = game.state.zones.drawPile
  const picked: string[] = []
  for (const suit of suits) {
    const index = pile.findIndex((cardId) => game.state.cards[cardId].suit === suit && !picked.includes(cardId))
    if (index < 0) throw new Error(`牌堆里找不到 ${suit}`)
    picked.push(pile.splice(index, 1)[0])
  }
  pile.unshift(...picked)
}

describe('慧识：完整流程', () => {
  it('连续判定，花色都不同就能继续，每继续一次加 1 点体力上限', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    stackDrawPile(game, ['heart', 'spade', 'club'])

    game.act('p0', skillAction(game, 'p0', 'huishi')!.id)

    expect(pending(game).kind, '第一次判定后问是否继续').toBe('choose-option')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(owner.maxHp, '继续一次加 1 点上限').toBe(5)

    expect(pending(game).kind).toBe('choose-option')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(owner.maxHp).toBe(6)

    expect(pending(game).kind).toBe('choose-option')
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })

    const give = pending(game)
    expect(give.kind, '停止后问把判定牌交给谁').toBe('choose-targets')
    expect(give.min, '可以不交').toBe(0)
    expect(give.candidateIds, '包含自己').toContain('p0')

    const before = playerOf(game, 'p1').zones.hand.length
    game.respond({ requestId: give.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(playerOf(game, 'p1').zones.hand.length, '三张判定牌全给同一个人').toBe(before + 3)
    expect(game.state.judgmentRetention).toBeNull()
    expect(game.state.zones.processingArea).toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('花色和之前重复就直接进交牌，不再问继续', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').maxHp = 4
    stackDrawPile(game, ['heart', 'heart'])

    game.act('p0', skillAction(game, 'p0', 'huishi')!.id)
    // 第一次判定（红桃）之后条件成立，问是否继续；答「继续」再判一次
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    // 第二次又是红桃，和第一次重复，直接进交牌
    expect(pending(game).kind, '花色重复后直接问交牌').toBe('choose-targets')
  })

  it('体力上限到 10 就没有入口', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').maxHp = 10
    expect(skillAction(game, 'p0', 'huishi')).toBeFalsy()
  })

  it('出牌阶段限一次', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').maxHp = 4
    stackDrawPile(game, ['heart', 'heart'])
    game.act('p0', skillAction(game, 'p0', 'huishi')!.id)
    // 第一次判定之后一定会先问「是否继续」——此前没有花色可比，条件天然成立
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: [] } })
    expect(skillAction(game, 'p0', 'huishi')).toBeFalsy()
  })

  it('可以放弃交牌：判定牌进弃牌堆，处理区不留残牌', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').maxHp = 4
    stackDrawPile(game, ['heart', 'heart'])
    game.act('p0', skillAction(game, 'p0', 'huishi')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    const give = pending(game)
    game.respond({ requestId: give.id, playerId: 'p0', payload: { targetIds: [] } })
    expect(game.state.zones.processingArea).toHaveLength(0)
    expect(game.state.judgmentRetention).toBeNull()
    assertCardConservation(game.state)
  })

  it('收牌人手牌为全场最多时，神郭嘉减 1 点体力上限', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    stackDrawPile(game, ['heart', 'heart'])
    for (const player of game.state.players) player.zones.hand = []
    playerOf(game, 'p1').zones.hand = game.state.zones.drawPile.splice(-5)

    game.act('p0', skillAction(game, 'p0', 'huishi')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(owner.maxHp, '收牌人手牌最多，自己减 1 点上限').toBe(5)
  })
})

describe('辉逝：完整流程', () => {
  it('对方没有未触发的觉醒技就摸四张，并减 2 点上限', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 8
    const before = playerOf(game, 'p1').zones.hand.length

    game.act('p0', skillAction(game, 'p0', 'huishifade')!.id)
    const target = pending(game)
    expect(target.kind).toBe('choose-targets')
    game.respond({ requestId: target.id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    expect(playerOf(game, 'p1').zones.hand.length, '张飞没有觉醒技，走摸四张').toBe(before + 4)
    expect(owner.maxHp, '无论走哪一支都减 2 点上限').toBe(6)
    assertCardConservation(game.state)
  })

  it('限定技：用过一次就不再有入口', () => {
    const game = gameWith(CAST)
    enterPlay(game, 'p0')
    playerOf(game, 'p0').maxHp = 8
    game.act('p0', skillAction(game, 'p0', 'huishifade')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    enterPlay(game, 'p0')
    expect(skillAction(game, 'p0', 'huishifade')).toBeFalsy()
  })

  it('体力上限不足场上人数时，也走摸四张', () => {
    const game = gameWith(['shenguojia', 'jiangwei', 'guanyu', 'zhaoyun', 'machao'])
    enterPlay(game, 'p0')
    const owner = playerOf(game, 'p0')
    // 姜维有觉醒技【志继】，但这里上限撑不住 5 个人
    owner.maxHp = 3
    const before = playerOf(game, 'p1').zones.hand.length
    game.act('p0', skillAction(game, 'p0', 'huishifade')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(playerOf(game, 'p1').zones.hand.length, '条件不足，走摸四张').toBe(before + 4)
    expect(owner.maxHp).toBe(1)
  })

  it('对方有未触发的觉醒技且上限够，就放行觉醒条件', () => {
    const game = gameWith(['shenguojia', 'jiangwei', 'guanyu', 'zhaoyun', 'machao'])
    enterPlay(game, 'p0')
    const owner = playerOf(game, 'p0')
    owner.maxHp = 8
    const before = playerOf(game, 'p1').zones.hand.length

    game.act('p0', skillAction(game, 'p0', 'huishifade')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })

    const pick = pending(game)
    expect(pick.kind, '应当让神郭嘉选一个觉醒技').toBe('choose-option')
    expect(pick.options.length).toBeGreaterThan(0)
    game.respond({ requestId: pick.id, playerId: 'p0', payload: { optionId: pick.options[0].id } })

    expect(playerOf(game, 'p1').zones.hand.length, '走的是觉醒那一支，不摸牌').toBe(before)
    expect(owner.maxHp).toBe(6)
    expect(game.state.forcedAwakenings?.some((entry) => entry.playerId === 'p1')).toBe(true)
    // 放行不等于已经觉醒
    expect(playerOf(game, 'p1').awakenedSkills ?? []).not.toContain(pick.options[0].id)
  })
})

describe('天翊：完整流程', () => {
  function prepare(game: SanguoshaGame): void {
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'prepare'
    game.dispatch('PhaseStart', { playerId: 'p0', phase: 'prepare' })
  }

  it('还有存活角色没受过伤就不觉醒', () => {
    const game = gameWith(CAST)
    const owner = playerOf(game, 'p0')
    const maxHp = owner.maxHp
    prepare(game)
    expect(owner.maxHp).toBe(maxHp)
    expect(owner.awakenedSkills ?? []).not.toContain('tianyiwing')
  })

  it('所有存活角色都受过伤：加 2 上限、回复 1 点、授出佐幸', () => {
    const game = gameWith(CAST)
    for (const player of game.state.players) player.hasTakenDamage = true
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    owner.hp = 2

    prepare(game)
    expect(owner.maxHp, '加 2 点上限').toBe(6)
    expect(owner.hp, '回复 1 点体力').toBe(3)
    expect(owner.awakenedSkills).toContain('tianyiwing')

    const grant = pending(game)
    expect(grant.kind).toBe('choose-targets')
    game.respond({ requestId: grant.id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    expect(playerOf(game, 'p1').grantedSkills ?? []).toContain('zuoxing')
    expect(skillGrantSourceOf(game.state, 'p1', 'zuoxing'), '记住授予者').toBe('p0')
  })

  it('死掉但没受过伤的人不挡觉醒', () => {
    const game = gameWith(CAST)
    for (const player of game.state.players) player.hasTakenDamage = true
    playerOf(game, 'p3').hasTakenDamage = false
    playerOf(game, 'p3').alive = false
    playerOf(game, 'p0').maxHp = 4

    prepare(game)
    expect(playerOf(game, 'p0').awakenedSkills, '只看存活角色').toContain('tianyiwing')
  })

  it('失去体力不算受到伤害，不足以触发觉醒', () => {
    const game = gameWith(CAST)
    for (const player of game.state.players) player.hasTakenDamage = true
    // p2 只是掉了血，没有真正受到过伤害
    playerOf(game, 'p2').hasTakenDamage = false
    playerOf(game, 'p2').hp -= 1
    const owner = playerOf(game, 'p0')
    const maxHp = owner.maxHp

    prepare(game)
    expect(owner.maxHp, '还有人没真正受过伤，不觉醒').toBe(maxHp)
  })

  it('只觉醒一次', () => {
    const game = gameWith(CAST)
    for (const player of game.state.players) player.hasTakenDamage = true
    const owner = playerOf(game, 'p0')
    owner.maxHp = 4
    prepare(game)
    while (game.state.pendingRequests.length > 0) {
      const request = pending(game)
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { targetIds: ['p1'] } })
    }
    const afterFirst = owner.maxHp
    prepare(game)
    expect(owner.maxHp, '第二个准备阶段不该再觉醒一遍').toBe(afterFirst)
  })
})

describe('佐幸：完整流程', () => {
  function withZuoxing(): SanguoshaGame {
    const game = gameWith(CAST)
    grantSkill(game.state, 'p1', 'zuoxing')
    recordSkillGrantSource(game.state, { playerId: 'p1', skillId: 'zuoxing', sourceId: 'p0' })
    enterPlay(game, 'p1')
    return game
  }

  it('来源活着且体力上限大于 1 才有入口', () => {
    const game = withZuoxing()
    expect(skillAction(game, 'p1', 'zuoxing')).toBeTruthy()

    playerOf(game, 'p0').maxHp = 1
    expect(skillAction(game, 'p1', 'zuoxing'), '来源上限只剩 1 就不能发动').toBeFalsy()

    playerOf(game, 'p0').maxHp = 4
    playerOf(game, 'p0').alive = false
    expect(skillAction(game, 'p1', 'zuoxing'), '来源死了就不能发动').toBeFalsy()
  })

  it('扣的是来源的体力上限，锦囊真的用出去，虚拟牌结算后销毁', () => {
    const game = withZuoxing()
    const source = playerOf(game, 'p0')
    source.maxHp = 5
    const knownBefore = Object.keys(game.state.cards).length

    game.act('p1', skillAction(game, 'p1', 'zuoxing')!.id)
    const pick = pending(game)
    expect(pick.kind).toBe('choose-option')
    expect(pick.options.map((option: { id: string }) => option.id), '候选里应当有决斗').toContain('决斗')
    game.respond({ requestId: pick.id, playerId: 'p1', payload: { optionId: '决斗' } })
    expect(source.maxHp, '扣的是来源神郭嘉的上限').toBe(4)

    const targets = pending(game)
    expect(targets.kind).toBe('choose-targets')
    game.respond({ requestId: targets.id, playerId: 'p1', payload: { targetIds: [targets.candidateIds[0]] } })

    for (let guard = 0; guard < 60 && game.state.pendingRequests.length > 0; guard += 1) {
      const request = pending(game)
      const payload = request.kind === 'respond-card' || request.kind === 'use-card' || request.kind === 'invoke-skill'
        ? { actionId: request.actionIds.includes('respond-pass') ? 'respond-pass' : request.actionIds[0] }
        : request.kind === 'rescue' ? { actionId: 'rescue-pass' }
          : request.kind === 'choose-cards' ? { cardIds: [] }
            : request.kind === 'choose-targets' ? { targetIds: [] }
              : { optionId: request.options?.[0]?.id }
      game.respond({ requestId: request.id, playerId: request.playerId, payload })
    }
    expect(Object.keys(game.state.cards).length, '虚拟牌结算后必须销毁，不进弃牌堆').toBe(knownBefore)
    assertCardConservation(game.state)
  })

  it('出牌阶段限一次', () => {
    const game = withZuoxing()
    playerOf(game, 'p0').maxHp = 6
    game.act('p1', skillAction(game, 'p1', 'zuoxing')!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p1', payload: { optionId: '决斗' } })
    expect(skillAction(game, 'p1', 'zuoxing')).toBeFalsy()
  })
})
