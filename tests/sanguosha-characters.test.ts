import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { STANDARD_CHARACTERS, allCharacterIds, getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { getDistance } from '@/sanguosha/engine/distance'
import type { GameSetup, Identity, SanguoshaState } from '@/sanguosha/engine/types'
import { assertCardConservation, moveCard, type ZoneRef } from '@/sanguosha/engine/zones'

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
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
  throw new Error(`找不到卡牌：${cardId}`)
}

/** 开一局，并把指定武将直接装到对应座位上。 */
function gameWith(seed: string, assign: Record<string, string>): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.identityRevealed = player.identity === 'lord'
    const characterId = assign[player.id]
    if (characterId) {
      player.characterId = characterId
      player.maxHp = getCharacter(characterId)!.maxHp
      player.hp = player.maxHp
    }
  })
  game.state.currentPlayerId = 'p0'
  game.start()
  game.advancePhase()
  game.advancePhase()
  game.advancePhase()
  expect(game.state.phase).toBe('play')
  return game
}

function giveNamed(game: SanguoshaGame, playerId: string, predicate: (card: { name: string; color: string; damageNature?: string }) => boolean): string {
  const card = Object.values(game.state.cards).find((candidate) => predicate(candidate))!
  moveCard(game.state, card.id, locate(game.state, card.id), { kind: 'hand', playerId })
  return card.id
}

function stripCard(game: SanguoshaGame, cardName: string): void {
  for (const player of game.state.players) {
    for (const cardId of [...player.zones.hand]) {
      if (game.state.cards[cardId]?.name !== cardName) continue
      moveCard(game.state, cardId, { kind: 'hand', playerId: player.id }, { kind: 'discardPile' })
    }
  }
}

function passAll(game: SanguoshaGame): void {
  for (let guard = 0; guard < 200; guard += 1) {
    const request = game.state.pendingRequests[0]
    if (!request) return
    const actionId = request.kind === 'rescue' ? 'rescue-pass' : 'respond-pass'
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId } })
  }
  throw new Error('结算没有收敛')
}

describe('武将包完整性', () => {
  it('注册的武将必须每个技能都有真正的运行时实现', () => {
    // 任务书禁止「选将页看得到、技能其实没写」，这条就是防线
    for (const character of STANDARD_CHARACTERS) {
      expect(character.skills.length).toBeGreaterThan(0)
      for (const skill of character.skills) {
        expect(getSkillRuntime(skill.id), `${character.name}的【${skill.name}】没有运行时实现`).toBeDefined()
        expect(skill.description.length).toBeGreaterThan(0)
      }
    }
  })

  it('技能说明只有一份，规则页直接读武将数据', () => {
    const guanyu = getCharacter('guanyu')!
    expect(guanyu.skills[0].description).toContain('红色牌')
    expect(skillIdsOf('guanyu')).toEqual(['wusheng'])
  })

  it('武将 id 不重复', () => {
    const ids = allCharacterIds()
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('选将流程', () => {
  it('相同 seed 得到相同候选，且候选之间不重复', () => {
    const first = new SanguoshaGame({ seed: 'pick-generals', setup: setup() })
    const second = new SanguoshaGame({ seed: 'pick-generals', setup: setup() })
    first.dealGenerals()
    second.dealGenerals()
    const candidatesOf = (game: SanguoshaGame) => game.state.pendingRequests.map((request) => (
      request.kind === 'choose-general' ? request.candidates.join(',') : ''
    ))
    expect(candidatesOf(first)).toEqual(candidatesOf(second))

    const all = first.state.pendingRequests.flatMap((request) => request.kind === 'choose-general' ? request.candidates : [])
    expect(new Set(all).size).toBe(all.length)
  })

  it('选将没结束不能开局；选完后武将和体力都装上', () => {
    const game = new SanguoshaGame({ seed: 'pick-then-start', setup: setup() })
    game.state.players.forEach((player, index) => {
      player.identity = (['lord', 'rebel', 'loyalist', 'rebel', 'renegade'] as Identity[])[index]
    })
    game.dealGenerals()
    expect(() => game.start()).toThrow('还有玩家没有选将')

    for (const request of [...game.state.pendingRequests]) {
      if (request.kind !== 'choose-general') continue
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: request.candidates[0] } })
    }
    expect(game.state.pendingRequests).toEqual([])
    for (const player of game.state.players) {
      expect(player.characterId).not.toBeNull()
      expect(player.hp).toBe(player.maxHp)
    }
    // 五人局主公体力上限 +1
    const lord = game.state.players.find((player) => player.identity === 'lord')!
    expect(lord.maxHp).toBe(getCharacter(lord.characterId!)!.maxHp + 1)

    game.start()
    expect(game.state.status).toBe('playing')
  })

  it('拒绝不在候选里的武将和伪造的响应', () => {
    const game = new SanguoshaGame({ seed: 'pick-invalid', setup: setup() })
    game.dealGenerals()
    const request = game.state.pendingRequests[0]
    expect(() => game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: '不存在的武将' } })).toThrow()
    expect(() => game.respond({ requestId: request.id, playerId: 'p9', payload: { characterId: 'guanyu' } })).toThrow()
  })
})

describe('张飞【咆哮】', () => {
  it('出杀不限次，和诸葛连弩走同一个入口', () => {
    const game = gameWith('skill-paoxiao', { p0: 'zhangfei' })
    stripCard(game, '闪')
    const first = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const slashActions = () => game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.asCardName === '杀')

    expect(slashActions().length).toBeGreaterThan(0)
    const action = slashActions().find((candidate) => candidate.cardIds.includes(first))!
    game.act('p0', action.id)
    passAll(game)

    // 打完一张之后仍然能继续出杀
    const second = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    expect(slashActions().some((candidate) => candidate.cardIds.includes(second))).toBe(true)
    assertCardConservation(game.state)
  })

  it('没有咆哮的人打完一张就不能再出', () => {
    const game = gameWith('skill-no-paoxiao', { p0: 'guanyu' })
    stripCard(game, '闪')
    const first = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(first))!
    game.act('p0', action.id)
    passAll(game)
    const second = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    expect(game.legalActions('p0').some((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(second))).toBe(false)
  })
})

describe('马超【马术】', () => {
  it('与其他角色的距离减一，走统一距离入口', () => {
    const plain = gameWith('skill-no-mashu', { p0: 'guanyu' })
    const withSkill = gameWith('skill-mashu', { p0: 'machao' })
    // 座次相同，只有技能不同
    expect(getDistance(withSkill.state, 'p0', 'p2')).toBe(Math.max(1, getDistance(plain.state, 'p0', 'p2') - 1))
  })

  it('只影响自己出去的距离，别人到自己的距离不变', () => {
    const game = gameWith('skill-mashu-oneway', { p0: 'machao' })
    const plain = gameWith('skill-mashu-oneway-plain', { p0: 'guanyu' })
    expect(getDistance(game.state, 'p2', 'p0')).toBe(getDistance(plain.state, 'p2', 'p0'))
  })
})

describe('关羽【武圣】', () => {
  it('红色牌可以当杀用，并且原用途同时保留', () => {
    const game = gameWith('skill-wusheng', { p0: 'guanyu' })
    stripCard(game, '闪')
    // 给一张红色的桃：它既可以当桃用，也可以当杀用
    const peach = giveNamed(game, 'p0', (card) => card.name === '桃' && card.color === 'red')
    game.state.players[0].hp = 3 // 让桃有原用途

    const actions = game.legalActions('p0').filter((action) => action.kind === 'use-card' && action.cardIds.includes(peach))
    const asPeach = actions.filter((action) => action.asCardName === '桃')
    const asSlash = actions.filter((action) => action.asCardName === '杀')
    // 关键：两种用途都要在，玩家自己选，引擎不替他决定
    expect(asPeach.length).toBeGreaterThan(0)
    expect(asSlash.length).toBeGreaterThan(0)
    expect(asSlash[0].label).toContain('当【杀】')
  })

  it('当杀打出去之后按杀结算，目标要出闪', () => {
    const game = gameWith('skill-wusheng-use', { p0: 'guanyu' })
    stripCard(game, '闪')
    stripCard(game, '杀')
    const red = giveNamed(game, 'p0', (card) => card.color === 'red' && card.name === '桃')
    const hpBefore = game.state.players[1].hp

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(red) && candidate.asCardName === '杀' && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'respond-card', requiredCardName: '闪', playerId: 'p1' })
    passAll(game)

    expect(game.state.players[1].hp).toBe(hpBefore - 1)
    assertCardConservation(game.state)
  })

  it('黑色牌不能当杀用', () => {
    const game = gameWith('skill-wusheng-black', { p0: 'guanyu' })
    stripCard(game, '杀')
    // 注意：ruleset-v1 里所有【闪】都是红色，黑色牌得另找——这里用黑色的过河拆桥
    const black = giveNamed(game, 'p0', (card) => card.color === 'black' && card.name === '过河拆桥')
    const asSlash = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && action.cardIds.includes(black) && action.asCardName === '杀'
    ))
    expect(asSlash).toEqual([])
  })
})

describe('赵云【龙胆】', () => {
  it('闪可以当杀用', () => {
    const game = gameWith('skill-longdan-slash', { p0: 'zhaoyun' })
    stripCard(game, '杀')
    const dodge = giveNamed(game, 'p0', (card) => card.name === '闪')
    const asSlash = game.legalActions('p0').filter((action) => (
      action.kind === 'use-card' && action.cardIds.includes(dodge) && action.asCardName === '杀'
    ))
    expect(asSlash.length).toBeGreaterThan(0)
  })

  it('杀可以当闪打出来免伤', () => {
    const game = gameWith('skill-longdan-dodge', { p0: 'guanyu', p1: 'zhaoyun' })
    stripCard(game, '闪')
    const attackerSlash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const defenderSlash = Object.values(game.state.cards).find((card) => (
      card.name === '杀' && card.id !== attackerSlash && !card.damageNature
    ))!
    moveCard(game.state, defenderSlash.id, locate(game.state, defenderSlash.id), { kind: 'hand', playerId: 'p1' })
    const hpBefore = game.state.players[1].hp

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(attackerSlash) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)

    const request = game.state.pendingRequests[0] as Extract<typeof game.state.pendingRequests[0], { kind: 'respond-card' }>
    // 关键：手里明明没有【闪】，但龙胆让这张【杀】成为一条合法响应动作
    expect(request.actionIds).toContain(`respond-dodge:${defenderSlash.id}`)
    game.respond({ requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${defenderSlash.id}` } })

    expect(game.state.players[1].hp).toBe(hpBefore)
    expect(game.state.zones.discardPile).toContain(defenderSlash.id)
    assertCardConservation(game.state)
  })

  it('没有龙胆的人不能拿杀当闪', () => {
    const game = gameWith('skill-longdan-none', { p0: 'guanyu', p1: 'zhangfei' })
    stripCard(game, '闪')
    const attackerSlash = giveNamed(game, 'p0', (card) => card.name === '杀' && !card.damageNature)
    const defenderSlash = Object.values(game.state.cards).find((card) => (
      card.name === '杀' && card.id !== attackerSlash && !card.damageNature
    ))!
    moveCard(game.state, defenderSlash.id, locate(game.state, defenderSlash.id), { kind: 'hand', playerId: 'p1' })

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(attackerSlash) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    const request = game.state.pendingRequests[0] as Extract<typeof game.state.pendingRequests[0], { kind: 'respond-card' }>
    expect(request.actionIds).not.toContain(`respond-dodge:${defenderSlash.id}`)
    expect(() => game.respond({
      requestId: request.id, playerId: 'p1', payload: { actionId: `respond-dodge:${defenderSlash.id}` },
    })).toThrow()
  })
})

describe('黄月英【集智】【奇才】', () => {
  it('使用非延时锦囊后摸一张牌', () => {
    const game = gameWith('skill-jizhi', { p0: 'huangyueying' })
    stripCard(game, '无懈可击')
    const trick = giveNamed(game, 'p0', (card) => card.name === '无中生有')
    const handBefore = game.state.players[0].zones.hand.length

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(trick))!
    game.act('p0', action.id)
    passAll(game)

    // 打出锦囊 -1、无中生有摸 2、集智再摸 1
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1 + 2 + 1)
    assertCardConservation(game.state)
  })

  it('延时锦囊不触发集智', () => {
    const game = gameWith('skill-jizhi-delayed', { p0: 'huangyueying' })
    const trick = giveNamed(game, 'p0', (card) => card.name === '乐不思蜀')
    const handBefore = game.state.players[0].zones.hand.length

    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(trick) && candidate.targetIds.includes('p1')
    ))!
    game.act('p0', action.id)
    passAll(game)

    // 只少了打出去的那张，没有额外摸牌
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1)
  })

  it('没有集智的人使用锦囊不会摸牌', () => {
    const game = gameWith('skill-jizhi-none', { p0: 'guanyu' })
    stripCard(game, '无懈可击')
    const trick = giveNamed(game, 'p0', (card) => card.name === '无中生有')
    const handBefore = game.state.players[0].zones.hand.length
    // 无中生有是红牌，关羽的【武圣】会额外给出「当杀用」的动作，
    // 所以这里必须显式挑「按锦囊用」那条——两种用途都在，本来就该由玩家选。
    const action = game.legalActions('p0').find((candidate) => (
      candidate.kind === 'use-card' && candidate.cardIds.includes(trick) && candidate.asCardName === '无中生有'
    ))!
    game.act('p0', action.id)
    passAll(game)
    expect(game.state.players[0].zones.hand.length).toBe(handBefore - 1 + 2)
  })

  it('奇才让顺手牵羊无视距离限制', () => {
    const plain = gameWith('skill-qicai-plain', { p0: 'guanyu' })
    const skilled = gameWith('skill-qicai', { p0: 'huangyueying' })
    const snatchTargets = (game: SanguoshaGame) => {
      const cardId = giveNamed(game, 'p0', (card) => card.name === '顺手牵羊')
      return game.legalActions('p0')
        .filter((action) => action.kind === 'use-card' && action.cardIds.includes(cardId))
        .flatMap((action) => action.targetIds)
    }
    // 奇才能顺到距离更远的人
    expect(snatchTargets(skilled).length).toBeGreaterThan(snatchTargets(plain).length)
  })
})
