import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { getCharacter, skillIdsOf } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'
import { killPlayer } from '@/sanguosha/engine/damage'

/**
 * 标准包里补齐的三个技能：天妒、铁骑、鬼才。
 *
 * 这三个不是新武将，是**已上架武将缺掉的第二个技能**——司马懿只有反馈、
 * 郭嘉只有遗计、马超只有马术，而且不在「已知简化」清单里，属于漏掉的。
 */

function setup(count = 5): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(characterIds: (string | null)[], seed = 'gap-skills'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup(characterIds.length) })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index] ?? 'machao'
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

/** 把牌堆顶换成指定花色的牌，让判定结果可控。 */
function stackJudgment(game: SanguoshaGame, suit: 'heart' | 'spade' | 'club' | 'diamond'): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}`)
  game.state.zones.drawPile = [cardId, ...game.state.zones.drawPile.filter((id) => id !== cardId)]
  return cardId
}

function stackJudgments(game: SanguoshaGame, suits: Array<'heart' | 'spade' | 'club' | 'diamond'>): string[] {
  const selected: string[] = []
  for (const suit of suits) {
    const cardId = game.state.zones.drawPile.find((id) => !selected.includes(id) && game.state.cards[id].suit === suit)
    if (!cardId) throw new Error(`牌堆里没有足够的${suit}判定牌`)
    selected.push(cardId)
  }
  game.state.zones.drawPile = [...selected, ...game.state.zones.drawPile.filter((id) => !selected.includes(id))]
  return selected
}

function giveNamed(game: SanguoshaGame, playerId: PlayerId, cardName: string): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
  if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

function giveSuit(game: SanguoshaGame, playerId: PlayerId, suit: 'heart' | 'spade' | 'club' | 'diamond'): string {
  const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].suit === suit)
  if (!cardId) throw new Error(`牌堆里没有${suit}手牌`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

describe('技能确实登记在武将身上', () => {
  it('郭嘉【天妒】和马超【铁骑】都已登记', () => {
    // 守住「不要再漏」——这两个曾经各自只登记了一个技能
    expect(getCharacter('guojia')?.skills.map((skill) => skill.id)).toContain('tiandu')
    expect(getCharacter('machao')?.skills.map((skill) => skill.id)).toContain('tieji')
  })

  it('已登记的技能都有真实描述，不是占位', () => {
    for (const [characterId, skillId] of [['guojia', 'tiandu'], ['machao', 'tieji']] as const) {
      const skill = getCharacter(characterId)?.skills.find((candidate) => candidate.id === skillId)
      expect(skill?.description.length, `${skillId} 描述太短，像占位`).toBeGreaterThan(10)
    }
  })

  /*
   * 司马懿【鬼才】曾经长期缺席，原因是判定当时是全同步的：
   * 抽牌、发 JudgeResult、用掉结果、弃牌一气呵成，中间没有能插入请求的点。
   *
   * 2026-09-02 把判定改成了「翻牌 → 逐人询问改判 → 结算 + 续接」，
   * 刚烈、洛神、八卦阵、铁骑、双雄和四种延时锦囊都改成了「前半段 + 续接」。
   * 详细用例在 tests/sanguosha-guicai.test.ts，这里只留一条「他确实有这个技能」。
   */
  it('司马懿【鬼才】已经实现，不再是缺口', () => {
    expect(skillIdsOf('simayi')).toContain('guicai')
  })
})

describe('郭嘉【天妒】', () => {
  it('判定牌生效后可以拿到手上', () => {
    const game = gameWith(['guojia', 'machao', 'machao', 'machao', 'machao'])
    const owner = game.state.players[0]
    // 给自己挂一张乐不思蜀，判定阶段就会产生一次判定
    const delayed = giveNamed(game, 'p1', '乐不思蜀')
    game.state.players[1].zones.hand = game.state.players[1].zones.hand.filter((id) => id !== delayed)
    owner.zones.judgingArea.push(delayed)
    const judgeCard = stackJudgment(game, 'heart')

    // advancePhase 是「离开当前阶段」，所以要从 prepare 推进才会真的进判定阶段
    game.state.phase = 'prepare'
    game.advancePhase()
    // 无懈询问一路放弃
    let guard = 0
    while (pending(game)?.kind === 'respond-card') {
      if (guard++ > 12) throw new Error('无懈询问没有收敛')
      game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'respond-pass' } })
    }

    const ask = pending(game)
    expect(ask, '判定之后应当问天妒').toBeTruthy()
    expect(ask.prompt).toContain('天妒')
    expect(ask.playerId).toBe('p0')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    expect(owner.zones.hand, '判定牌应当进了郭嘉手上').toContain(judgeCard)
    expect(game.state.zones.discardPile).not.toContain(judgeCard)
    assertGameInvariants(game.state)
  })

  it('放弃就不拿，判定牌留在弃牌堆', () => {
    const game = gameWith(['guojia', 'machao', 'machao', 'machao', 'machao'])
    const owner = game.state.players[0]
    const delayed = giveNamed(game, 'p1', '乐不思蜀')
    game.state.players[1].zones.hand = game.state.players[1].zones.hand.filter((id) => id !== delayed)
    owner.zones.judgingArea.push(delayed)
    const judgeCard = stackJudgment(game, 'heart')

    // advancePhase 是「离开当前阶段」，所以要从 prepare 推进才会真的进判定阶段
    game.state.phase = 'prepare'
    game.advancePhase()
    let guard = 0
    while (pending(game)?.kind === 'respond-card') {
      if (guard++ > 12) throw new Error('无懈询问没有收敛')
      game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'respond-pass' } })
    }
    const ask = pending(game)
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'no' } })

    expect(owner.zones.hand).not.toContain(judgeCard)
    expect(game.state.zones.discardPile).toContain(judgeCard)
    assertGameInvariants(game.state)
  })

  it('别人的判定不会问郭嘉', () => {
    const game = gameWith(['guojia', 'machao', 'machao', 'machao', 'machao'])
    const victim = game.state.players[1]
    const delayed = giveNamed(game, 'p2', '乐不思蜀')
    game.state.players[2].zones.hand = game.state.players[2].zones.hand.filter((id) => id !== delayed)
    victim.zones.judgingArea.push(delayed)
    stackJudgment(game, 'heart')

    game.state.currentPlayerId = 'p1'
    // advancePhase 是「离开当前阶段」，所以要从 prepare 推进才会真的进判定阶段
    game.state.phase = 'prepare'
    game.advancePhase()
    let guard = 0
    while (pending(game)?.kind === 'respond-card') {
      if (guard++ > 12) throw new Error('无懈询问没有收敛')
      game.respond({ requestId: pending(game).id, playerId: pending(game).playerId, payload: { actionId: 'respond-pass' } })
    }
    // 判定的是 p1，天妒不该被触发
    expect(pending(game)?.prompt ?? '').not.toContain('天妒')
    assertGameInvariants(game.state)
  })
})

describe('马超【铁骑】', () => {
  /** 让 p0 用一张【杀】打 p1，返回那张杀。 */
  function playSlash(game: SanguoshaGame): string {
    const slash = giveNamed(game, 'p0', '杀')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
    if (!action) throw new Error('构造不出对 p1 的杀')
    game.act('p0', action.id)
    return slash
  }

  it('判定为红：目标不能用闪，直接吃伤害', () => {
    const game = gameWith(['machao', 'machao', 'machao', 'machao', 'machao'])
    // 给目标一张闪，证明「有闪也用不了」而不是「恰好没闪」
    giveNamed(game, 'p1', '闪')
    stackJudgment(game, 'heart')
    const hpBefore = game.state.players[1].hp

    playSlash(game)
    const ask = pending(game)
    expect(ask?.prompt, '指定目标后应当问铁骑').toContain('铁骑')
    expect(ask.playerId).toBe('p0')
    game.respond({ requestId: ask.id, playerId: 'p0', payload: { optionId: 'yes' } })

    // 判定为红桃，闪的询问根本不该出现
    const after = pending(game)
    expect(after?.prompt ?? '', '判定为红时不该再问闪').not.toContain('闪')
    expect(game.state.players[1].hp, '目标应当直接掉血').toBe(hpBefore - 1)
    assertGameInvariants(game.state)
  })

  it('判定为黑：照常问闪，闪掉就不掉血', () => {
    const game = gameWith(['machao', 'machao', 'machao', 'machao', 'machao'])
    const dodge = giveNamed(game, 'p1', '闪')
    stackJudgment(game, 'spade')
    const hpBefore = game.state.players[1].hp

    playSlash(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })

    const dodgeAsk = pending(game)
    expect(dodgeAsk?.kind, '判定为黑时仍要问闪').toBe('respond-card')
    expect(dodgeAsk.playerId).toBe('p1')
    game.respond({ requestId: dodgeAsk.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.players[1].hp).toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('判定结果按鬼才改判后的最终颜色决定', () => {
    for (const [initialSuit, retrialSuit, canDodge] of [
      ['spade', 'heart', false],
      ['heart', 'club', true],
    ] as const) {
      const game = gameWith(['machao', 'simayi', 'zhangfei', 'zhangfei', 'zhangfei'], `tieji-retrial-${initialSuit}`)
      const slash = giveNamed(game, 'p0', '杀')
      const dodge = giveNamed(game, 'p2', '闪')
      game.state.zones.discardPile.push(...game.state.players[1].zones.hand)
      game.state.players[1].zones.hand = []
      const retrialCard = giveSuit(game, 'p1', retrialSuit)
      const initialJudgment = stackJudgment(game, initialSuit)
      const hpBefore = game.state.players[2].hp
      const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
        && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p2'))
      expect(action).toBeTruthy()

      game.act('p0', action!.id)
      const tiejiAsk = pending(game)
      expect(tiejiAsk?.skillId).toBe('tieji')
      game.respond({ requestId: tiejiAsk.id, playerId: 'p0', payload: { optionId: 'yes' } })
      const retrialAsk = pending(game)
      expect(retrialAsk?.kind).toBe('choose-cards')
      expect((retrialAsk as { purpose?: string }).purpose).toBe('retrial')
      expect(retrialAsk.playerId).toBe('p1')
      game.respond({ requestId: retrialAsk.id, playerId: 'p1', payload: { cardIds: [retrialCard] } })

      const response = pending(game)
      if (canDodge) {
        expect(response?.kind).toBe('respond-card')
        expect(response.playerId).toBe('p2')
        game.respond({ requestId: response.id, playerId: 'p2', payload: { actionId: `respond-dodge:${dodge}` } })
        expect(game.state.players[2].hp).toBe(hpBefore)
        expect(game.state.zones.discardPile).toContain(dodge)
      } else {
        expect(response?.prompt ?? '').not.toContain('闪')
        expect(game.state.players[2].hp, `${initialSuit}→${retrialSuit} should use final red result; next=${JSON.stringify(response)}`).toBe(hpBefore - 1)
        expect(game.state.players[2].zones.hand).toContain(dodge)
      }
      expect(game.state.zones.discardPile).toContain(initialJudgment)
      expect(game.state.zones.discardPile).toContain(retrialCard)
      expect(game.state.cardResolution).toBeNull()
      assertGameInvariants(game.state)
    }
  })

  it('大乔先流离改定最终目标，再询问铁骑', () => {
    const game = gameWith(['machao', 'daqiao', 'zhangfei', 'zhangfei', 'zhangfei'], 'tieji-liuli-order')
    const slash = giveNamed(game, 'p0', '杀')
    const liuliCost = giveSuit(game, 'p1', 'heart')
    const p1Hp = game.state.players[1].hp
    const p2Hp = game.state.players[2].hp
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(slash) && candidate.targetIds.includes('p1'))
    expect(action).toBeTruthy()

    game.act('p0', action!.id)
    const liuliAsk = pending(game)
    expect(liuliAsk?.skillId, '成为目标时的流离先处理，之后目标才固定').toBe('liuli')
    game.respond({ requestId: liuliAsk.id, playerId: 'p1', payload: { optionId: 'yes' } })
    const discardAsk = pending(game)
    expect(discardAsk?.kind).toBe('choose-cards')
    game.respond({ requestId: discardAsk.id, playerId: 'p1', payload: { cardIds: [liuliCost] } })
    const targetAsk = pending(game)
    expect(targetAsk?.kind).toBe('choose-targets')
    game.respond({ requestId: targetAsk.id, playerId: 'p1', payload: { targetIds: ['p2'] } })

    const tiejiAsk = pending(game)
    expect(tiejiAsk?.skillId, '铁骑应对流离后的最终目标发动').toBe('tieji')
    expect(tiejiAsk?.prompt).toContain(game.state.players[2].nickname)
    game.respond({ requestId: tiejiAsk.id, playerId: 'p0', payload: { optionId: 'no' } })
    if (pending(game)?.kind === 'respond-card') {
      const dodgeAsk = pending(game)!
      expect(dodgeAsk.prompt).toContain('闪')
      game.respond({ requestId: dodgeAsk.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    }

    expect(game.state.players[1].hp).toBe(p1Hp)
    expect(game.state.players[2].hp).toBe(p2Hp - 1)
    expect(game.state.zones.discardPile).toContain(liuliCost)
    assertGameInvariants(game.state)
  })

  it('多目标时先完成所有成为目标时的流离，再按目标顺序询问铁骑', () => {
    const game = gameWith(['machao', 'daqiao', 'daqiao', 'zhangfei', 'zhangfei'], 'tieji-multi-target-window-order')
    const halberd = giveNamed(game, 'p0', '方天画戟')
    const slash = giveNamed(game, 'p0', '杀')
    game.state.zones.discardPile.push(...game.state.players[0].zones.hand.filter((id) => id !== slash && id !== halberd))
    game.state.players[0].zones.hand = [slash]
    game.state.players[0].zones.equipment.weapon = halberd

    game.act('p0', 'skill:fangtian')
    const targets = pending(game)
    expect(targets?.kind).toBe('choose-targets')
    game.respond({ requestId: targets.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    const firstLiuli = pending(game)
    expect(firstLiuli?.skillId).toBe('liuli')
    game.respond({ requestId: firstLiuli.id, playerId: 'p1', payload: { optionId: 'no' } })

    const secondLiuli = pending(game)
    expect(secondLiuli?.skillId, '第二目标的成为目标时窗口应先于任何铁骑窗口').toBe('liuli')
    expect(secondLiuli?.playerId).toBe('p2')
    game.respond({ requestId: secondLiuli.id, playerId: 'p2', payload: { optionId: 'no' } })

    const firstTieji = pending(game)
    expect(firstTieji?.skillId).toBe('tieji')
    expect(firstTieji?.prompt).toContain(game.state.players[1].nickname)
    assertGameInvariants(game.state)
  })

  it('流离把方天目标转给已指定角色时，铁骑按两次指定分别记录并在响应前结算', () => {
    const game = gameWith(['machao', 'daqiao', 'zhangfei', 'zhangfei', 'zhangfei'], 'tieji-liuli-duplicate-target')
    const halberd = giveNamed(game, 'p0', '方天画戟')
    const slash = giveNamed(game, 'p0', '杀')
    game.state.zones.discardPile.push(...game.state.players[0].zones.hand.filter((id) => id !== slash && id !== halberd))
    game.state.players[0].zones.hand = [slash]
    game.state.players[0].zones.equipment.weapon = halberd
    const liuliCost = giveSuit(game, 'p1', 'heart')
    const dodge = giveNamed(game, 'p2', '闪')
    const [redJudgment, blackJudgment] = stackJudgments(game, ['heart', 'spade'])

    game.act('p0', 'skill:fangtian')
    const targetRequest = pending(game)
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    const liuliAsk = pending(game)
    expect(liuliAsk?.skillId).toBe('liuli')
    game.respond({ requestId: liuliAsk.id, playerId: 'p1', payload: { optionId: 'yes' } })
    const discardAsk = pending(game)
    game.respond({ requestId: discardAsk.id, playerId: 'p1', payload: { cardIds: [liuliCost] } })
    const redirectAsk = pending(game)
    game.respond({ requestId: redirectAsk.id, playerId: 'p1', payload: { targetIds: ['p2'] } })

    const firstTieji = pending(game)
    expect(firstTieji?.skillId).toBe('tieji')
    game.respond({ requestId: firstTieji.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.players[2].hp).toBe(4)
    const secondTieji = pending(game)
    expect(secondTieji?.skillId).toBe('tieji')
    game.respond({ requestId: secondTieji.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.zones.discardPile).toContain(redJudgment)
    expect(game.state.zones.discardPile).toContain(blackJudgment)

    expect(game.state.players[2].hp).toBe(3)
    const dodgeAsk = pending(game)
    expect(dodgeAsk?.kind).toBe('respond-card')
    expect(dodgeAsk.playerId).toBe('p2')
    game.respond({ requestId: dodgeAsk.id, playerId: 'p2', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.players[2].hp).toBe(3)
    expect(game.state.players[1].hp).toBe(4)
    assertGameInvariants(game.state)
  })

  it('多目标准备期间后续目标死亡时跳过该目标并继续当前牌结算', () => {
    const game = gameWith(['machao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'], 'tieji-target-dies-during-preparation')
    const halberd = giveNamed(game, 'p0', '方天画戟')
    const slash = giveNamed(game, 'p0', '杀')
    game.state.zones.discardPile.push(...game.state.players[0].zones.hand.filter((id) => id !== slash && id !== halberd))
    game.state.players[0].zones.hand = [slash]
    game.state.players[0].zones.equipment.weapon = halberd
    const dodge = giveNamed(game, 'p1', '闪')

    game.act('p0', 'skill:fangtian')
    const targetRequest = pending(game)
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })
    const firstTieji = pending(game)
    expect(firstTieji?.skillId).toBe('tieji')
    game.respond({ requestId: firstTieji.id, playerId: 'p0', payload: { optionId: 'no' } })
    const secondTieji = pending(game)
    expect(secondTieji?.skillId).toBe('tieji')
    killPlayer(game, 'p2', 'p0', '测试：在目标指定后、杀结算前死亡')
    game.respond({ requestId: secondTieji.id, playerId: 'p0', payload: { optionId: 'no' } })

    const dodgeAsk = pending(game)
    expect(dodgeAsk?.kind).toBe('respond-card')
    expect(dodgeAsk.playerId).toBe('p1')
    game.respond({ requestId: dodgeAsk.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.players[1].hp).toBe(4)
    expect(game.state.players[2].alive).toBe(false)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })

  it('放弃发动：结算和没有铁骑时一样', () => {
    const game = gameWith(['machao', 'machao', 'machao', 'machao', 'machao'])
    const dodge = giveNamed(game, 'p1', '闪')
    const hpBefore = game.state.players[1].hp

    playSlash(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'no' } })

    const dodgeAsk = pending(game)
    expect(dodgeAsk?.kind).toBe('respond-card')
    game.respond({ requestId: dodgeAsk.id, playerId: 'p1', payload: { actionId: `respond-dodge:${dodge}` } })
    expect(game.state.players[1].hp).toBe(hpBefore)
    assertGameInvariants(game.state)
  })

  it('禁闪只作用于本次目标，不会漏给下一个', () => {
    // 这条守的是 continueSlash 里的重置：不重置的话一次红判定会让后续目标全都不能闪
    const game = gameWith(['machao', 'machao', 'machao', 'machao', 'machao'])
    stackJudgment(game, 'heart')
    playSlash(game)
    game.respond({ requestId: pending(game).id, playerId: 'p0', payload: { optionId: 'yes' } })
    // 这次结算已经结束，标记不该留在状态里
    expect(game.state.cardResolution?.kind === 'slash' ? game.state.cardResolution.noDodge : false).toBeFalsy()
    assertGameInvariants(game.state)
  })

  it('方天多目标杀按目标逐次判定，红判禁闪不会泄漏给后续黑判目标', () => {
    const game = gameWith(['machao', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const halberd = giveNamed(game, 'p0', '方天画戟')
    const slash = giveNamed(game, 'p0', '杀')
    game.state.zones.discardPile.push(...game.state.players[0].zones.hand.filter((id) => id !== slash && id !== halberd))
    game.state.players[0].zones.hand = [slash]
    game.state.players[0].zones.equipment.weapon = halberd
    const p1Dodge = giveNamed(game, 'p1', '闪')
    const p2Dodge = giveNamed(game, 'p2', '闪')
    const [redJudgment, blackJudgment] = stackJudgments(game, ['heart', 'spade'])

    game.act('p0', 'skill:fangtian')
    const targetRequest = pending(game)
    expect(targetRequest?.kind).toBe('choose-targets')
    game.respond({ requestId: targetRequest.id, playerId: 'p0', payload: { targetIds: ['p1', 'p2'] } })

    const firstTieji = pending(game)
    expect(firstTieji?.skillId).toBe('tieji')
    game.respond({ requestId: firstTieji.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.zones.discardPile).toContain(redJudgment)
    expect(game.state.players[1].zones.hand).toContain(p1Dodge)
    expect(game.state.players[1].hp, '所有目标的铁骑判定完成前不能开始第一个目标的响应/伤害').toBe(4)

    const secondTieji = pending(game)
    expect(secondTieji?.skillId).toBe('tieji')
    game.respond({ requestId: secondTieji.id, playerId: 'p0', payload: { optionId: 'yes' } })
    expect(game.state.zones.discardPile).toContain(blackJudgment)
    const dodgeRequest = pending(game)
    expect(dodgeRequest?.kind).toBe('respond-card')
    expect(dodgeRequest.playerId).toBe('p2')
    game.respond({ requestId: dodgeRequest.id, playerId: 'p2', payload: { actionId: `respond-dodge:${p2Dodge}` } })

    expect(game.state.players[1].hp).toBe(3)
    expect(game.state.players[2].hp).toBe(4)
    expect(game.state.cardResolution).toBeNull()
    assertGameInvariants(game.state)
  })
})
