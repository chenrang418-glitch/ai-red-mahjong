import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH62_CHARACTERS } from '@/sanguosha/data/characters/historical-batch62'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { isCardUseProhibited, getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { MULTI_VIEWAS_WINE_ACTION } from '@/sanguosha/engine/multi-card-viewas'
import { moveCard } from '@/sanguosha/engine/zones'

function gameFor(seed: string) {
  const game = new SanguoshaGame({ seed, setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })),
  } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  return game
}

function answer(game: SanguoshaGame, payload: unknown): void {
  const request = game.state.pendingRequests.at(-1)
  if (!request) throw new Error('预期有待回答请求')
  game.respond({ requestId: request.id, playerId: request.playerId, payload })
}

function discardInitialHands(game: SanguoshaGame, playerIds: string[]): void {
  for (const playerId of playerIds) {
    const player = game.state.players.find((candidate) => candidate.id === playerId)!
    for (const cardId of [...player.zones.hand])
      moveCard(game.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
  }
}

describe('武将册续开发第62批', () => {
  it('吕伯奢留册不注册；本批十名已注册武将的技能均有运行时', () => {
    expect(HISTORICAL_BATCH62_CHARACTERS.map(({ name }) => name)).toEqual([
      '张世平', '段颎', '马玩', '丁尚涴', '李婉', '雅丹', '李异', '刘磐', 'SP·孙策', 'SP·刘备',
    ])
    for (const character of HISTORICAL_BATCH62_CHARACTERS) {
      expect(getCharacter(character.id)?.id).toBe(character.id)
      expect(character.skills.length).toBeGreaterThan(0)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), skill.name).toBeDefined()
    }
    expect(getCharacter('lu-bo-she-b62') ?? null).toBeNull()
    expect(getCharacter('sp-liu-bei-b62')?.name).toBe('SP·刘备')
  })

  it('SP·刘备虚待：响应牌后可一次性令他人永久获得煮酒', () => {
    const game = gameFor('b62-sp-liubei-xudai')
    const [owner, target] = game.state.players
    owner!.characterId = 'sp-liu-bei-b62'
    game.dispatch('CardResponded', { playerId: owner!.id, cardName: '闪' }, { sourceId: owner!.id })
    ;(game as unknown as { settle(): void }).settle()
    expect(game.state.pendingRequests.at(-1)?.kind).toBe('choose-option')
    answer(game, { optionId: 'yes' })
    answer(game, { targetIds: [target!.id] })
    expect(target!.grantedSkills).toContain('zhujiu-sp-liubei-b62')
    expect(owner!.usedLimitedSkills).toContain('xudai-sp-liubei-b62')
  })

  it('SP·刘备煮酒：选至少X+1张手牌或装备使用酒，非梅花牌使技能本回合失效', () => {
    const game = gameFor('b62-sp-liubei-zhujiu')
    const owner = game.state.players[0]!
    owner.characterId = 'sp-liu-bei-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const equipmentId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment' && game.state.cards[id]?.suit !== 'club')!
    const handId = game.state.zones.drawPile.find((id) => id !== equipmentId && game.state.cards[id]?.suit !== 'club')!
    const equipment = game.state.cards[equipmentId]!
    moveCard(game.state, equipmentId, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot: equipment.equipmentSlot! })
    moveCard(game.state, handId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const materials = [equipmentId, handId]
    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'zhujiu-sp-liubei-b62')
    expect(action).toBeDefined()
    game.act(owner.id, action!.id)
    answer(game, { cardIds: materials })
    expect(game.state.turnUsage.wineUses).toBe(1)
    expect(owner.marks['b62-sp-liubei-zhujiu-disabled-turn']).toBe(game.state.turnNumber)
    expect(materials.every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
    expect(owner.zones.equipment[equipment.equipmentSlot!]).toBeNull()
  })

  it('SP·刘备煮酒：濒死求酒可选择多于最低数量的牌，并计入本回合酒次数', () => {
    const game = gameFor('b62-sp-liubei-zhujiu-rescue')
    const owner = game.state.players[0]!
    owner.characterId = 'sp-liu-bei-b62'
    owner.hp = 0
    const nonClub = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.suit !== 'club').slice(0, 2)
    const club = game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === 'club')!
    const materials = [nonClub[0]!, club, nonClub[1]!]
    for (const cardId of materials) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.state.turnUsage.wineUses = 1
    game.enterDying(owner.id)
    const rescue = game.state.pendingRequests.at(-1)!
    expect(rescue.kind).toBe('rescue')
    if (rescue.kind !== 'rescue') throw new Error('未進入濒死救援')
    expect(rescue.actionIds).toContain(MULTI_VIEWAS_WINE_ACTION)
    game.respond({ requestId: rescue.id, playerId: owner.id, payload: { actionId: MULTI_VIEWAS_WINE_ACTION } })
    const selection = game.state.pendingRequests.at(-1)!
    expect(selection.kind).toBe('choose-cards')
    if (selection.kind !== 'choose-cards') throw new Error('未请求选择煮酒底牌')
    expect(selection.min).toBe(2)
    expect(selection.max).toBe(3)
    answer(game, { cardIds: materials })
    expect(owner.hp).toBe(1)
    expect(game.state.turnUsage.wineUses).toBe(2)
    expect(owner.marks['b62-sp-liubei-zhujiu-disabled-turn']).toBe(game.state.turnNumber)
  })

  it('SP·刘备惊雷：酒结算后可受无来源雷伤，并令煮酒角色补至体力或五张', () => {
    const game = gameFor('b62-sp-liubei-jinglei')
    const [owner, holder, actor] = game.state.players
    owner!.characterId = 'sp-liu-bei-b62'
    holder!.hp = 1
    holder!.grantedSkills.push('zhujiu-sp-liubei-b62')
    game.dispatch('AfterCardUse', { cardName: '酒' }, { sourceId: actor!.id })
    ;(game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    answer(game, { targetIds: [holder!.id] })
    expect(owner!.hp).toBe(owner!.maxHp - 1)
    expect(holder!.zones.hand).toHaveLength(Math.min(holder!.maxHp, 5))
    expect(owner!.turnUsedSkills).toContain('jinglei-sp-liubei-b62')
  })

  it('SP·刘备惊雷：手牌超过体力上限时由目标选择弃牌并交给刘备', () => {
    const game = gameFor('b62-sp-liubei-jinglei-give')
    const [owner, holder, actor] = game.state.players
    owner!.characterId = 'sp-liu-bei-b62'
    holder!.grantedSkills.push('zhujiu-sp-liubei-b62')
    const cards = game.state.zones.drawPile.slice(0, holder!.maxHp + 2)
    for (const cardId of cards) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: holder!.id })
    const ownerHandBefore = owner!.zones.hand.length
    game.dispatch('AfterCardUse', { cardName: '酒' }, { sourceId: actor!.id })
    ;(game as unknown as { settle(): void }).settle()
    answer(game, { optionId: 'yes' })
    answer(game, { targetIds: [holder!.id] })
    const discard = game.state.pendingRequests.at(-1)!
    expect(discard.kind).toBe('choose-cards')
    expect(discard.playerId).toBe(holder!.id)
    answer(game, { cardIds: cards.slice(0, 2) })
    expect(holder!.zones.hand).toHaveLength(holder!.maxHp)
    expect(owner!.zones.hand).toHaveLength(ownerHandBefore + 2)
    expect(cards.slice(0, 2).every((id) => owner!.zones.hand.includes(id))).toBe(true)
  })

  it('丁尚涴讽言是锁定触发，受伤后的效果选择不可放弃', () => {
    const game = gameFor('b62-dingshangwan-fengyan-locked')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.characterId = 'ding-shangwan-b62'
    game.dispatch('Damaged', { amount: 1, cardName: '杀' }, { sourceId: actor.id, targetId: owner.id })
    ;(game as unknown as { settle(): void }).settle()

    const request = game.state.pendingRequests.at(-1)
    expect(request?.kind).toBe('choose-option')
    expect(request?.playerId).toBe(owner.id)
    expect(request?.optional).toBe(false)
  })

  it('张世平驵贸：弃置方块装备也能兑换随机坐骑', () => {
    const game = gameFor('b62-zhangshiping-zaomao-equipment')
    const owner = game.state.players[0]!
    owner.characterId = 'zhang-shiping-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    discardInitialHands(game, game.state.players.map(({ id }) => id))
    const costId = game.state.zones.drawPile.find((id) => {
      const card = game.state.cards[id]
      return card?.category === 'equipment' && card.suit === 'diamond' && card.equipmentSlot
        && owner.zones.equipment[card.equipmentSlot] === null
    })!
    const slot = game.state.cards[costId]!.equipmentSlot!
    moveCard(game.state, costId, { kind: 'drawPile' }, { kind: 'equipment', playerId: owner.id, slot })
    expect(game.state.zones.drawPile.some((id) => {
      const card = game.state.cards[id]
      return card?.category === 'equipment' && (card.equipmentSlot === 'offensiveHorse' || card.equipmentSlot === 'defensiveHorse')
    })).toBe(true)

    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'zaomao-zhangshiping:b62')
    expect(action).toBeDefined()
    game.act(owner.id, action!.id)
    answer(game, { optionId: 'pool' })
    const request = game.state.pendingRequests.at(-1)!
    if (request.kind !== 'choose-cards') throw new Error('【驵贸】应进入方块牌选择')
    expect(request.cardIds).toContain(costId)
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [costId] } })

    expect(owner.zones.equipment[slot]).toBeNull()
    expect(owner.zones.hand.some((id) => ['offensiveHorse', 'defensiveHorse'].includes(game.state.cards[id]?.equipmentSlot ?? ''))).toBe(true)
  })

  it('马玩浑疆：所选角色同时秘密提交；全选摸牌时仍摸牌并获得额外杀目标', () => {
    const game = gameFor('b62-mawan-hunjiang')
    const owner = game.state.players[0]!
    const first = game.state.players[1]!
    const second = game.state.players[2]!
    owner.characterId = 'ma-wan-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const handBefore = owner.zones.hand.length
    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'invoke-skill'
      && candidate.skillId === 'hunjiang-mawan:b62')
    expect(action).toBeDefined()
    game.act(owner.id, action!.id)
    answer(game, { targetIds: [first.id, second.id] })

    expect(game.state.groupDecision?.playerIds).toEqual([first.id, second.id])
    expect(game.state.pendingRequests.map(({ playerId }) => playerId)).toEqual([first.id, second.id])
    answer(game, { optionId: 'draw' })
    answer(game, { optionId: 'draw' })

    const runtime = getSkillRuntime('hunjiang-mawan:b62')!
    expect(owner.zones.hand).toHaveLength(handBefore + 2)
    expect(runtime.extraSlashTargetIds?.(game.state, owner.id)).toEqual([first.id, second.id])
    expect(game.state.groupDecision).toBeNull()
  })

  it('SP孙策连讨：没有对应颜色手牌时结束连讨，并真正封锁本回合使用/打出杀', () => {
    const game = gameFor('b62-sunce-no-color')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'sp-sun-ce-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    discardInitialHands(game, [owner.id])
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const slash = game.state.cards[slashId]!
    const color = slash.color === 'red' ? 'black' : 'red'
    const handBefore = owner.zones.hand.length

    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' })
    answer(game, { targetIds: [target.id] })
    answer(game, { optionId: color })

    const runtime = getSkillRuntime(HISTORICAL_BATCH62_CHARACTERS.find(({ name }) => name === 'SP·孙策')!.skills[0]!.id)!
    expect(owner.zones.hand.length).toBe(handBefore + 1)
    expect(runtime.prohibitsOwnResponse?.(game.state, owner.id, '杀')).toBe(true)
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null })).toBe(true)
    expect(runtime.maxCardsBonus?.(game.state, owner.id)).toBe(1)
    expect(game.state.skillResolution).toBeNull()
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('SP孙策连讨：按颜色顺序逐张真实使用决斗，并按目标实受伤害数摸牌', () => {
    const game = gameFor('b62-sunce-duel-sequence')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'sp-sun-ce-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    discardInitialHands(game, [owner.id, target.id])
    const matchingIds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red'
      && game.state.cards[id]?.name !== '杀').slice(0, 2)
    expect(matchingIds).toHaveLength(2)
    for (const cardId of matchingIds)
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const targetHp = target.hp

    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' })
    answer(game, { targetIds: [target.id] })
    answer(game, { optionId: 'red' })
    let responseCount = 0
    while (game.state.cardResolution && responseCount++ < 40) {
      const request = game.state.pendingRequests.at(-1)
      if (!request) throw new Error('连讨中的【决斗】应持续提供响应请求')
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
    }
    expect(game.state.cardResolution).toBeNull()
    expect(responseCount).toBeLessThan(40)

    expect(target.hp).toBe(targetHp - 2)
    expect(owner.zones.hand).toHaveLength(2)
    expect(matchingIds.every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
    expect(isCardUseProhibited(game.state, owner.id, '杀', { dyingPlayerId: null })).toBe(false)
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('段颎扫谷：阴项被结束阶段的其他角色执行后摸牌并转换回阳', () => {
    const game = gameFor('b62-duanjiong-finish-yin')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    owner.characterId = 'duan-jiong-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'finish'
    const state = game.state as typeof game.state & { b62DuanjiongYin?: Record<string, boolean> }
    state.b62DuanjiongYin = { [owner.id]: true }
    const ownerCardId = game.state.zones.drawPile[0]!
    moveCard(game.state, ownerCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const actorHandBefore = actor.zones.hand.length
    const ownerCard = ownerCardId

    game.dispatch('PhaseEnd', { playerId: owner.id, phase: 'finish' })
    answer(game, { optionId: 'yes' })
    answer(game, { cardIds: [ownerCard] })
    answer(game, { targetIds: [actor.id] })

    expect(actor.zones.hand).toHaveLength(actorHandBefore + 1)
    expect(state.b62DuanjiongYin?.[owner.id]).toBe(false)
    expect(owner.zones.hand).not.toContain(ownerCard)
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('段颎扫谷：阳项可令所选角色弃牌并从弃牌堆使用实体杀', () => {
    const game = gameFor('b62-duanjiong-finish-yang')
    const owner = game.state.players[0]!
    const actor = game.state.players[1]!
    const victim = game.state.players[2]!
    owner.characterId = 'duan-jiong-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'finish'
    const state = game.state as typeof game.state & { b62DuanjiongYin?: Record<string, boolean> }
    state.b62DuanjiongYin = { [owner.id]: false }
    discardInitialHands(game, [actor.id])
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const costId = game.state.zones.drawPile.find((id) => id !== slashId && game.state.cards[id]?.name !== '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    moveCard(game.state, costId, { kind: 'drawPile' }, { kind: 'hand', playerId: actor.id })
    const ownerCost = game.state.zones.drawPile[0]!
    moveCard(game.state, ownerCost, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const victimHp = victim.hp

    game.dispatch('PhaseEnd', { playerId: owner.id, phase: 'finish' })
    answer(game, { optionId: 'yes' })
    answer(game, { cardIds: [ownerCost] })
    answer(game, { targetIds: [actor.id] })
    answer(game, { cardIds: [slashId, costId] })
    answer(game, { targetIds: [victim.id] })
    const dodge = game.state.pendingRequests.at(-1)!
    expect(dodge.playerId).toBe(victim.id)
    game.respond({ requestId: dodge.id, playerId: victim.id, payload: { actionId: 'respond-pass' } })

    expect(victim.hp).toBe(victimHp - 1)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(state.b62DuanjiongYin?.[owner.id]).toBe(true)
    expect(game.state.pendingRequests).toHaveLength(0)
  })

  it('李异缠双：两人先同时秘密提交，再按座次依次重铸实际手牌', () => {
    const game = gameFor('b62-liyi-chanshuang')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'li-yi-b62'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    const targetCardId = game.state.zones.drawPile.find((id) => id !== slashId && game.state.cards[id]?.name !== '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, targetCardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const skillId = HISTORICAL_BATCH62_CHARACTERS.find(({ id }) => id === 'li-yi-b62')!.skills[0]!.id
    const action = game.legalActions(owner.id).find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === skillId)
    expect(action).toBeDefined()
    game.act(owner.id, action!.id)
    answer(game, { targetIds: [target.id] })

    const decision = game.state.groupDecision!
    const ownerRequestId = decision.requestIds[owner.id]!
    const targetRequestId = decision.requestIds[target.id]!
    expect(game.viewFor(owner.id).pendingRequest?.id).toBe(ownerRequestId)
    expect(game.viewFor(target.id).pendingRequest?.id).toBe(targetRequestId)
    game.respond({ requestId: ownerRequestId, playerId: owner.id, payload: { optionId: 'recast' } })
    expect(game.state.groupDecision?.responses).toEqual({ [owner.id]: 'recast' })
    game.respond({ requestId: targetRequestId, playerId: target.id, payload: { optionId: 'recast' } })
    expect(game.state.groupDecision).toBeNull()

    const ownerHandBefore = owner.zones.hand.length
    const targetHandBefore = target.zones.hand.length
    answer(game, { cardIds: [slashId] })
    answer(game, { cardIds: [targetCardId] })

    expect(owner.zones.hand).toHaveLength(ownerHandBefore)
    expect(target.zones.hand).toHaveLength(targetHandBefore)
    expect(game.state.zones.discardPile).toContain(slashId)
    expect(game.state.zones.discardPile).toContain(targetCardId)
    expect(game.state.pendingRequests).toHaveLength(0)
  })

})
