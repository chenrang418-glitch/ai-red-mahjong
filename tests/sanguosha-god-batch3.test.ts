import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertCardConservation, moveCard } from '@/sanguosha/engine/zones'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { getAttackRange } from '@/sanguosha/engine/distance'
import { abolishSlot, abolishedSlotsOf, isSlotAbolished, restoreSlot } from '@/sanguosha/engine/equipment-slots'
import { isSkillSuppressed, suppressSkill } from '@/sanguosha/engine/skill-suppression'
import { evaluateSkillTheft, stealableSkillsOf } from '@/sanguosha/engine/skill-theft'
import { carriesToken, createToken, moveToken, tokenExists } from '@/sanguosha/engine/global-token'
import { ownedSkillIds } from '@/sanguosha/engine/skills/runtime'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { CAMP_TOKEN, POXI_MAXCARDS_MARK, SHENGANNING } from '@/sanguosha/data/characters/god-shenganning'
import type { CardId, GameSetup, Identity, PlayerId, Suit } from '@/sanguosha/engine/types'

/**
 * 神张辽 + 神甘宁。本项目的自研玩法表述。
 *
 * 神张辽最要紧的：装备栏是**真的没了**（不能再装备、武器栏没了攻击范围跟着变）；
 * 夺锐期间不能再夺锐；技能失效和临时获得**成对结束**。
 * 神甘宁最要紧的：初始体力 3 ≠ 上限 6；魄袭**弃两张什么都不发生**；
 * 「营」是带归属的全局唯一 Token，其他角色回合结束后是**移去**不是回到神甘宁身上。
 */

function gameWith(characterIds: string[], seed = 'batch3'): SanguoshaGame {
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
  drain(game)
  return game
}

function drain(game: SanguoshaGame, limit = 40): void {
  let guard = 0
  while (game.state.pendingRequests.length > 0 && guard < limit) {
    const request = game.state.pendingRequests[0]
    const ids = (request as unknown as { actionIds?: string[] }).actionIds ?? []
    const options = (request as unknown as { options?: Array<{ id: string }> }).options ?? []
    game.respond({
      requestId: request.id, playerId: request.playerId,
      payload: request.kind === 'choose-cards' ? { cardIds: [] }
        : request.kind === 'choose-targets'
          ? { targetIds: (request as unknown as { candidateIds: string[]; min: number }).candidateIds.slice(0, (request as unknown as { min: number }).min) }
          : ids.length ? { actionId: ids.includes('rescue-pass') ? 'rescue-pass' : 'respond-pass' }
            : { optionId: options.slice(-1)[0]?.id ?? 'no' },
    })
    guard += 1
  }
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function detach(game: SanguoshaGame, cardId: CardId): void {
  const state = game.state
  state.zones.drawPile = state.zones.drawPile.filter((id) => id !== cardId)
  state.zones.discardPile = state.zones.discardPile.filter((id) => id !== cardId)
  state.zones.processingArea = state.zones.processingArea.filter((id) => id !== cardId)
  for (const player of state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
    for (const [slot, equipped] of Object.entries(player.zones.equipment)) {
      if (equipped === cardId) player.zones.equipment[slot as keyof typeof player.zones.equipment] = null
    }
  }
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  for (const cardId of [...playerOf(game, playerId).zones.hand]) {
    moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

function giveHand(game: SanguoshaGame, playerId: PlayerId, cardIds: CardId[]): void {
  for (const cardId of cardIds) {
    detach(game, cardId)
    playerOf(game, playerId).zones.hand.push(cardId)
  }
}

function cardOfSuit(game: SanguoshaGame, suit: Suit, exclude: CardId[] = []): CardId {
  const card = Object.values(game.state.cards)
    .find((candidate) => candidate.suit === suit && !candidate.virtual && !exclude.includes(candidate.id))
  if (!card) throw new Error(`没有 ${suit} 花色的牌`)
  return card.id
}

function enterPlay(game: SanguoshaGame, playerId: PlayerId): void {
  game.state.currentPlayerId = playerId
  game.state.normalTurnPlayerId = playerId
  game.state.currentTurnKind = 'normal'
  game.state.phase = 'play'
  game.state.skippedPhases = []
  game.state.judgedDelayedCards = []
  game.state.pendingRequests = []
}

function settle(game: SanguoshaGame): void {
  ;(game as unknown as { settle(): void }).settle()
}

// ─────────────────────────── 神张辽 ───────────────────────────

const ZL = ['shenzhangliao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('装备栏废除 / 恢复', () => {
  it('废除后不能再装备到那个栏', () => {
    const game = gameWith(ZL)
    enterPlay(game, 'p0')
    const weapon = Object.values(game.state.cards).find((card) => card.equipmentSlot === 'weapon')!.id
    clearHand(game, 'p0')
    giveHand(game, 'p0', [weapon])
    expect(game.legalActions('p0').some((action) => (action as { cardIds?: string[] }).cardIds?.includes(weapon)),
      '废除前可以装备').toBe(true)

    abolishSlot(game.state, 'p0', 'weapon')
    expect(game.legalActions('p0').some((action) => (action as { cardIds?: string[] }).cardIds?.includes(weapon)),
      '废除后不能装备').toBe(false)
  })

  it('武器栏被废除后攻击范围回到 1', () => {
    const game = gameWith(ZL)
    const weapon = Object.values(game.state.cards).find((card) => (card.attackRange ?? 0) > 1)!
    detach(game, weapon.id)
    playerOf(game, 'p0').zones.equipment.weapon = weapon.id
    const withWeapon = getAttackRange(game.state, 'p0')
    expect(withWeapon, '装着武器时范围变大').toBeGreaterThan(1)

    abolishSlot(game.state, 'p0', 'weapon')
    expect(getAttackRange(game.state, 'p0'), '武器栏没了，武器也不算数').toBe(1)
  })

  it('同一个栏不能废除两次；恢复之后栏是空的', () => {
    const game = gameWith(ZL)
    expect(abolishSlot(game.state, 'p0', 'armor')).toBe(true)
    expect(abolishSlot(game.state, 'p0', 'armor'), '不能重复废除').toBe(false)
    expect(abolishedSlotsOf(game.state, 'p0')).toEqual(['armor'])
    expect(restoreSlot(game.state, 'p0', 'armor')).toBe(true)
    expect(isSlotAbolished(game.state, 'p0', 'armor')).toBe(false)
    expect(playerOf(game, 'p0').zones.equipment.armor, '恢复的栏是空的').toBeNull()
  })

  it('废除状态可序列化，并下发到视图供界面灰化', () => {
    const game = gameWith(ZL)
    abolishSlot(game.state, 'p0', 'weapon')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(isSlotAbolished(restored.state, 'p0', 'weapon')).toBe(true)
    const view = restored.viewFor('p1').players.find((player) => player.id === 'p0')!
    expect(view.abolishedSlots, '别人也看得到他哪个栏废了').toContain('weapon')
  })
})

describe('夺锐：可夺技能的资格', () => {
  it('限定技、觉醒技、主公技都不可夺，普通技能可夺', () => {
    const cases: Array<[string, boolean]> = [
      ['paoxiao', true],    // 张飞【咆哮】：普通锁定技
      ['zhiheng', true],    // 孙权【制衡】：普通主动技
      ['yeyan', false],     // 神周瑜【业炎】：限定技
      ['baiyin', false],    // 神司马懿【拜印】：觉醒技
      ['jijiang', false],   // 刘备【激将】：主公技
    ]
    for (const [skillId, eligible] of cases) {
      const result = evaluateSkillTheft({ id: skillId, name: skillId })
      expect(result.eligible, `${skillId} 应当${eligible ? '可夺' : '不可夺'}（${result.reason ?? ''}）`).toBe(eligible)
    }
  })

  it('被断肠清空技能的目标没有可夺技能，不会让神张辽白废一个栏', () => {
    const game = gameWith(['shenzhangliao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const skillsOfCharacter = (characterId: string) => (getCharacter(characterId)?.skills ?? []) as never
    expect(stealableSkillsOf(game.state, 'p1', skillsOfCharacter).length, '正常时有可夺技能').toBeGreaterThan(0)
    playerOf(game, 'p1').characterSkillsDisabled = true
    expect(stealableSkillsOf(game.state, 'p1', skillsOfCharacter), '断肠之后一个都没有').toHaveLength(0)
  })
})

describe('技能失效', () => {
  it('被压制的技能从「拥有的技能」里摘掉，和断肠各管各的', () => {
    const game = gameWith(ZL)
    expect(ownedSkillIds(game.state, 'p1'), '本来有咆哮').toContain('paoxiao')
    suppressSkill(game.state, {
      targetId: 'p1', skillId: 'paoxiao', sourceId: 'p0', sourceSkillId: 'duorui', armedAtTurn: 1,
    })
    expect(isSkillSuppressed(game.state, 'p1', 'paoxiao')).toBe(true)
    expect(ownedSkillIds(game.state, 'p1'), '压制之后就没有了').not.toContain('paoxiao')
  })

  it('到期判据是目标的下一个实际回合结束，不是 round+1', () => {
    const game = gameWith(ZL)
    game.state.turnNumber = 5
    suppressSkill(game.state, {
      targetId: 'p1', skillId: 'paoxiao', sourceId: 'p0', sourceSkillId: 'duorui', armedAtTurn: 5,
    })
    // 别人的回合结束不到期
    game.state.currentPlayerId = 'p2'
    game.state.turnNumber = 6
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    expect(isSkillSuppressed(game.state, 'p1', 'paoxiao'), '别人的回合不算').toBe(true)

    // 目标自己的回合结束才到期
    let guard = 0
    while (game.state.currentPlayerId !== 'p1' && guard < 10) {
      game.state.phase = 'finish'
      game.state.pendingRequests = []
      game.advancePhase()
      guard += 1
    }
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    expect(isSkillSuppressed(game.state, 'p1', 'paoxiao'), '目标的回合结束后解除').toBe(false)
  })

  it('目标死亡时立即解除，神张辽同时失去夺来的技能', () => {
    const game = gameWith(ZL)
    suppressSkill(game.state, {
      targetId: 'p1', skillId: 'paoxiao', sourceId: 'p0', sourceSkillId: 'duorui', armedAtTurn: 1,
    })
    ;(game as unknown as { state: { players: Array<{ id: string; temporaryGrantedSkills: Array<{ source: string; skillId: string }> }> } })
      .state.players.find((player) => player.id === 'p0')!.temporaryGrantedSkills = [{ source: 'duorui', skillId: 'paoxiao' }]

    playerOf(game, 'p1').hp = 1
    game.damage({ sourceId: null, targetId: 'p1', amount: 5, cardName: null })
    drain(game)

    expect(playerOf(game, 'p1').alive).toBe(false)
    expect(isSkillSuppressed(game.state, 'p1', 'paoxiao'), '目标死了就解除').toBe(false)
    expect(playerOf(game, 'p0').temporaryGrantedSkills.map((entry) => entry.skillId),
      '神张辽同时失去夺来的技能').not.toContain('paoxiao')
  })
})

describe('止啼', () => {
  it('攻击范围内已受伤的角色手牌上限 -1，满血的和范围外的不减，自己不减', () => {
    const game = gameWith(ZL)
    const base = maxCardsOf(game.state, 'p1')
    expect(base, '满血邻座不受影响').toBe(playerOf(game, 'p1').hp)

    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp - 1
    expect(maxCardsOf(game.state, 'p1'), '受伤且在范围内 -1').toBe(playerOf(game, 'p1').hp - 1)

    // 神张辽自己受伤不影响自己
    playerOf(game, 'p0').hp = playerOf(game, 'p0').maxHp - 1
    expect(maxCardsOf(game.state, 'p0'), '自己不在自己的攻击范围内').toBe(playerOf(game, 'p0').hp)
  })

  it('没有已废除的装备栏时不发恢复请求', () => {
    const game = gameWith(ZL)
    playerOf(game, 'p1').hp = 1
    playerOf(game, 'p0').hp = 4
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    settle(game)
    const request = pending(game)
    expect(request && String(request.prompt).includes('止啼'), '没有废除的栏就不该问').toBeFalsy()
  })

  it('受到已受伤且在范围内的来源的伤害后，恢复一个装备栏', () => {
    const game = gameWith(ZL)
    abolishSlot(game.state, 'p0', 'armor')
    playerOf(game, 'p1').hp = 1   // 来源已受伤
    playerOf(game, 'p0').hp = 4
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    settle(game)
    drain(game)
    expect(isSlotAbolished(game.state, 'p0', 'armor'), '只有一个废除栏就自动恢复').toBe(false)
  })

  it('来源满血时不恢复', () => {
    const game = gameWith(ZL)
    abolishSlot(game.state, 'p0', 'armor')
    playerOf(game, 'p1').hp = playerOf(game, 'p1').maxHp
    playerOf(game, 'p0').hp = 4
    game.damage({ sourceId: 'p1', targetId: 'p0', amount: 1, cardName: null })
    settle(game)
    expect(isSlotAbolished(game.state, 'p0', 'armor'), '来源没受伤就不恢复').toBe(true)
  })
})

// ─────────────────────────── 神甘宁 ───────────────────────────

const GN = ['shenganning', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei']

describe('神甘宁：初始体力 ≠ 体力上限', () => {
  it('武将定义是 6 上限 / 3 初始', () => {
    expect(SHENGANNING.maxHp).toBe(6)
    expect(SHENGANNING.initialHp).toBe(3)
  })

  it('非主公开局是 3 / 6', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `n${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'gn-init', setup })
    game.dealGenerals()
    // 走真实选将路径，才会跑到体力初始化那段
    game.state.players.forEach((player, index) => { player.identity = index === 0 ? 'lord' : 'rebel' })
    const nonLord = game.state.pendingRequests.find((candidate) => candidate.playerId !== 'p0')
    if (!nonLord) return
    // 候选是随机发的，这里直接把神甘宁塞进候选，走真实的选将 → 初始化路径
    ;(nonLord as unknown as { candidates: string[] }).candidates = ['shenganning']
    game.respond({ requestId: nonLord.id, playerId: nonLord.playerId, payload: { characterId: 'shenganning' } })
    const player = playerOf(game, nonLord.playerId)
    expect(player.maxHp, '非主公上限 6').toBe(6)
    expect(player.hp, '非主公开局 3').toBe(3)
  })

  it('当主公时公共加成让他变成 7 上限 / 4 体力，不是满血 7', () => {
    const setup: GameSetup = {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `n${index}`, isHuman: false })),
    }
    const game = new SanguoshaGame({ seed: 'gn-lord', setup })
    game.dealGenerals()
    game.state.players.forEach((player, index) => { player.identity = index === 0 ? 'lord' : 'rebel' })
    const lordRequest = game.state.pendingRequests.find((candidate) => candidate.playerId === 'p0')
    if (!lordRequest) return
    ;(lordRequest as unknown as { candidates: string[] }).candidates = ['shenganning']
    game.respond({ requestId: lordRequest.id, playerId: 'p0', payload: { characterId: 'shenganning' } })
    expect(playerOf(game, 'p0').maxHp, '主公 +1 上限').toBe(7)
    expect(playerOf(game, 'p0').hp, '主公 +1 体力，不是满血').toBe(4)
  })
})

describe('魄袭', () => {
  function poxiAction(game: SanguoshaGame) {
    return game.legalActions('p0').find((action) => action.kind === 'invoke-skill' && action.skillId === 'poxi')
  }

  /** 摆好双方手牌并发动到选牌那一步。返回四张不同花色的候选。 */
  function reachDiscard(game: SanguoshaGame, ownSuits: Suit[], targetSuits: Suit[]): CardId[] {
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const used: CardId[] = []
    const own = ownSuits.map((suit) => { const id = cardOfSuit(game, suit, used); used.push(id); return id })
    const theirs = targetSuits.map((suit) => { const id = cardOfSuit(game, suit, used); used.push(id); return id })
    giveHand(game, 'p0', own)
    giveHand(game, 'p1', theirs)
    // 魄袭要「观看一名其他角色的手牌」，目标必须有手牌才是合法目标。
    // 「自己 4 / 对方 0」这一档指的是**弃的四张全是自己的**，不是对方没有手牌。
    if (theirs.length === 0) {
      const filler = cardOfSuit(game, 'spade', used)
      used.push(filler)
      giveHand(game, 'p1', [filler])
    }
    enterPlay(game, 'p0')
    game.act('p0', poxiAction(game)!.id)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { targetIds: ['p1'] } })
    return [...own, ...theirs]
  }

  it('出牌阶段限一次；看完手牌就消耗次数，不能换人再看', () => {
    const game = gameWith(GN)
    reachDiscard(game, ['spade'], ['heart'])
    // 选牌那一步交空 = 只观看不弃置
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: [] } })
    expect(poxiAction(game), '看完就消耗次数，不能再换一个目标').toBeUndefined()
  })

  it('必须恰好四张且四种不同花色；同色不同花色也算不同花色', () => {
    const game = gameWith(GN)
    const cards = reachDiscard(game, ['spade', 'heart'], ['club', 'diamond'])
    const request = pending(game)
    expect(String(request.prompt)).toContain('四张')
    game.respond({ requestId: request.id, playerId: 'p0', payload: { cardIds: cards } })
    expect(playerOf(game, 'p0').zones.hand, '自己的两张被弃').toHaveLength(0)
    expect(playerOf(game, 'p1').zones.hand, '对方的两张被弃').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('弃两张自己的牌：什么都不发生', () => {
    const game = gameWith(GN)
    const owner = playerOf(game, 'p0')
    owner.hp = 3
    owner.maxHp = 6
    const cards = reachDiscard(game, ['spade', 'heart'], ['club', 'diamond'])
    const handBefore = owner.zones.hand.length
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: cards } })
    expect(owner.hp, '不回血').toBe(3)
    expect(owner.maxHp, '不掉上限').toBe(6)
    expect(owner.zones.hand.length, '不摸牌').toBe(handBefore - 2)
    expect(game.state.phase, '不结束出牌阶段').toBe('play')
  })

  it('弃 0 张自己的牌：体力上限 -1', () => {
    const game = gameWith(GN)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    const cards = reachDiscard(game, [], ['spade', 'heart', 'club', 'diamond'])
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: cards } })
    expect(owner.maxHp, '上限 -1').toBe(5)
  })

  it('弃 1 张自己的牌：真正结束出牌阶段，且本回合手牌上限 -1', () => {
    const game = gameWith(GN)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 4
    const cards = reachDiscard(game, ['spade'], ['heart', 'club', 'diamond'])
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: cards } })
    expect(owner.marks[POXI_MAXCARDS_MARK], '留下本回合手牌上限 -1 的标记').toBe(1)
    expect(game.state.phase, '真正走出了出牌阶段').not.toBe('play')
  })

  it('弃 3 张自己的牌：回复 1 点体力', () => {
    const game = gameWith(GN)
    const owner = playerOf(game, 'p0')
    owner.maxHp = 6
    owner.hp = 3
    const cards = reachDiscard(game, ['spade', 'heart', 'club'], ['diamond'])
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: cards } })
    expect(owner.hp, '回 1 点').toBe(4)
  })

  it('弃 4 张自己的牌：摸四张', () => {
    const game = gameWith(GN)
    const owner = playerOf(game, 'p0')
    const cards = reachDiscard(game, ['spade', 'heart', 'club', 'diamond'], [])
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { cardIds: cards } })
    expect(owner.zones.hand, '弃光四张之后摸四张').toHaveLength(4)
    assertCardConservation(game.state)
  })

  it('目标手牌只有神甘宁看得到，第三方拿不到牌面', () => {
    const game = gameWith(GN)
    reachDiscard(game, ['spade'], ['heart', 'club', 'diamond'])
    const request = pending(game)
    expect(request.playerId, '这条请求只发给神甘宁').toBe('p0')

    const own = game.viewFor('p0') as unknown as { pendingRequest: unknown }
    expect(own.pendingRequest, '本人拿得到这条请求').toBeTruthy()
    for (const viewerId of ['p1', 'p2', 'p3', 'p4'] as const) {
      const view = game.viewFor(viewerId)
      const serialized = JSON.stringify(view)
      for (const cardId of playerOf(game, 'p1').zones.hand) {
        if (viewerId === 'p1') continue
        expect(serialized, `${viewerId} 不该看到目标的手牌 ${cardId}`).not.toContain(cardId)
      }
    }
  })
})

describe('劫营：带归属的全局唯一 Token', () => {
  it('回合开始时全场没有营就获得一个', () => {
    const game = gameWith(GN)
    expect(tokenExists(game.state, CAMP_TOKEN), '开局还没有').toBe(false)
    game.state.currentPlayerId = 'p4'
    game.state.normalTurnPlayerId = 'p4'
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    drain(game)
    // 轮到 p0 时会拿到营
    let guard = 0
    while (!tokenExists(game.state, CAMP_TOKEN) && guard < 10) {
      game.state.phase = 'finish'
      game.state.pendingRequests = []
      game.advancePhase()
      drain(game)
      guard += 1
    }
    expect(carriesToken(game.state, 'p0', CAMP_TOKEN), '神甘宁拿到营').toBe(true)
  })

  it('有营的角色手牌上限 +1、出杀次数 +1', () => {
    const game = gameWith(GN)
    const before = maxCardsOf(game.state, 'p1')
    createToken(game.state, CAMP_TOKEN, 'p0')
    moveToken(game.state, CAMP_TOKEN, 'p0', 'p1')
    expect(maxCardsOf(game.state, 'p1'), '手牌上限 +1').toBe(before + 1)

    enterPlay(game, 'p1')
    game.state.turnUsage.slashUses = 1
    const slash = Object.values(game.state.cards).find((card) => card.name === '杀')!.id
    clearHand(game, 'p1')
    giveHand(game, 'p1', [slash])
    expect(game.legalActions('p1').some((action) => (action as { asCardName?: string }).asCardName === '杀'),
      '已经出过一张，靠营还能再出一张').toBe(true)
  })

  it('有营的其他角色回合结束后：移去营，神甘宁获得其所有手牌', () => {
    const game = gameWith(GN)
    createToken(game.state, CAMP_TOKEN, 'p0')
    moveToken(game.state, CAMP_TOKEN, 'p0', 'p1')
    clearHand(game, 'p0')
    clearHand(game, 'p1')
    const cards = Object.values(game.state.cards).slice(0, 3).map((card) => card.id)
    giveHand(game, 'p1', cards)

    game.state.currentPlayerId = 'p1'
    game.state.normalTurnPlayerId = 'p1'
    game.state.currentTurnKind = 'normal'
    game.state.phase = 'finish'
    game.state.pendingRequests = []
    game.advancePhase()
    drain(game)

    expect(tokenExists(game.state, CAMP_TOKEN), '营被移去，不是回到神甘宁身上').toBe(false)
    expect(playerOf(game, 'p0').zones.hand, '神甘宁获得其全部手牌').toHaveLength(3)
    expect(playerOf(game, 'p1').zones.hand, '对方手牌清空').toHaveLength(0)
    assertCardConservation(game.state)
  })

  it('owner 死亡时营随之清理，不会把牌发给死人', () => {
    const game = gameWith(GN)
    createToken(game.state, CAMP_TOKEN, 'p0')
    moveToken(game.state, CAMP_TOKEN, 'p0', 'p1')
    playerOf(game, 'p0').hp = 1
    game.damage({ sourceId: null, targetId: 'p0', amount: 5, cardName: null })
    drain(game)
    expect(tokenExists(game.state, CAMP_TOKEN), 'owner 死了营就没了').toBe(false)
  })

  it('营的状态可序列化，重连不丢归属', () => {
    const game = gameWith(GN)
    createToken(game.state, CAMP_TOKEN, 'p0')
    moveToken(game.state, CAMP_TOKEN, 'p0', 'p2')
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    expect(carriesToken(restored.state, 'p2', CAMP_TOKEN)).toBe(true)
    const view = restored.viewFor('p1').players.find((player) => player.id === 'p2')!
    expect(view.tokens.map((token) => token.name), '界面画得出来').toContain(CAMP_TOKEN)
  })
})
