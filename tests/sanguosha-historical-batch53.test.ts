import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { resolveDamage, resolveDamageSequence } from '@/sanguosha/engine/damage'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime, grantSkill } from '@/sanguosha/engine/skills/runtime'
import type { DamagePreventionContext } from '@/sanguosha/engine/skills/runtime'
import { missionStatus } from '@/sanguosha/engine/mission-skill'
import { resumeTurnTransition } from '@/sanguosha/engine/turn'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameResponse } from '@/sanguosha/engine/requests'

const batch = ALL_CHARACTERS.filter(({ id }) => id.endsWith('-b53'))
const character = (name: string) => batch.find((entry) => entry.name === name)!
const skill = (name: string, skillName: string) => character(name).skills.find((entry) => entry.name === skillName)!

function fixture() {
  const game = new SanguoshaGame({ seed: 'historical-batch53-targeted', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `b53p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  return { game, owner: game.state.players[0]!, target: game.state.players[1]! }
}

describe('第53批武将：定向规则验证', () => {
  it('批次名单为武将册 641—650 的十名角色', () => {
    expect(batch.map(({ name }) => name)).toEqual([
      '谋·法正', '谋·陈宫', '谋·甘宁', '谋·黄盖', '谋·孙权',
      '界·张嶷', '十常侍', '谋·卢植', '谋·诸葛亮', '谋·关羽',
    ])
  })

  it('谋·关羽武圣将任意非杀手牌转为杀，并以被选目标豁免杀距离和次数', () => {
    const { game, owner, target } = fixture()
    owner.characterId = character('谋·关羽').id
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    const wusheng = getSkillRuntime(skill('谋·关羽', '武圣').id)!
    const card = game.state.zones.drawPile[0]!
    moveCard(game.state, card, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const handCard = owner.zones.hand.find((id) => game.state.cards[id]?.name !== '杀')!
    expect(wusheng.viewAs?.(game.state, owner.id)).toContainEqual(expect.objectContaining({ cardId: handCard, asCardName: '杀' }))

    ;(game.state as typeof game.state & { b53GuanyuTarget?: Record<string, { turn: number; targetId: string; slashes: number }> }).b53GuanyuTarget = {
      [owner.id]: { turn: game.state.turnNumber, targetId: target.id, slashes: 0 },
    }
    expect(wusheng.ignoresSlashUsesTo?.(game.state, owner.id, target.id)).toBe(true)
    expect(wusheng.ignoresDistanceTo?.(game.state, owner.id, target.id)).toBe(true)
    ;(game.state as typeof game.state & { b53GuanyuTarget: Record<string, { turn: number; targetId: string; slashes: number }> }).b53GuanyuTarget[owner.id]!.slashes = 3
    expect(wusheng.ignoresSlashUsesTo?.(game.state, owner.id, target.id)).toBe(false)
    expect(wusheng.ignoresDistanceTo?.(game.state, owner.id, target.id)).toBe(false)
    expect(wusheng.prohibitsSourceTarget?.(game.state, owner.id, target.id, '杀')).toBe(true)
  })

  it('谋·关羽义绝按最终修正后的致濒死伤害防止，且同一角色整局仅一次', () => {
    const { game, owner, target } = fixture()
    owner.characterId = character('谋·关羽').id
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.status = 'playing'
    target.hp = 2
    const id = skill('谋·关羽', '义绝').id
    const runtime = getSkillRuntime(id)!
    const context: DamagePreventionContext = {
      sourceId: owner.id, targetId: target.id, amount: 2, nature: 'normal', cardId: null,
      cardName: null, chainTransfer: false,
    }
    expect(runtime.preventsFinalDamage?.(game.state, owner.id, context)).toBe(true)
    resolveDamage(game, { sourceId: owner.id, targetId: target.id, amount: 2, nature: 'normal', cardName: null })
    expect(target.hp).toBe(2)
    expect((game.state as typeof game.state & { b53YiJueUsed?: Record<string, string[]> }).b53YiJueUsed?.[owner.id]).toContain(target.id)
    expect(runtime.prohibitsSourceTarget?.(game.state, owner.id, target.id, '无中生有')).toBe(true)
    expect(runtime.preventsFinalDamage?.(game.state, owner.id, context)).toBe(false)
  })

  it('谋·卢植明任开局摸两张并真实扣置一张任，界·张嶷矢志仅在1体力改写闪', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·卢植').id
    const mingrenId = skill('谋·卢植', '明任').id
    const mingren = getSkillRuntime(mingrenId)!
    const handBefore = owner.zones.hand.length
    mingren.onGameStart?.(game, owner.id)
    expect(owner.zones.hand.length).toBe(handBefore + 2)
    const chooseRen = game.state.pendingRequests.find((request) => request.skillId === mingrenId)!
    if (chooseRen.kind !== 'choose-cards') throw new Error('明任开局应选择一张手牌')
    const reserved = chooseRen.cardIds[0]!
    game.respond({ requestId: chooseRen.id, playerId: owner.id, payload: { cardIds: [reserved] } } as GameResponse)
    expect(owner.characterPiles.ren).toEqual([reserved])
    expect(owner.zones.hand).not.toContain(reserved)

    owner.characterId = character('界·张嶷').id
    owner.hp = 1
    const shizhi = getSkillRuntime(skill('界·张嶷', '矢志').id)!
    const flash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '闪')!
    expect(shizhi.forcedCardIdentity?.(game.state, owner.id, flash)).toEqual(expect.objectContaining({ asCardName: '杀' }))
    owner.hp = 2
    expect(shizhi.forcedCardIdentity?.(game.state, owner.id, flash)).toBeNull()
  })

  it('谋·诸葛亮火计按同势力逐目标造成火伤，使命成功永久失去前两技并获得后两技', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = character('谋·诸葛亮').id
    const shuId = ALL_CHARACTERS.find((entry) => entry.kingdom === 'shu')!.id
    const weiId = ALL_CHARACTERS.find((entry) => entry.kingdom === 'wei')!.id
    target.characterId = shuId
    const sameFaction = game.state.players[2]!
    sameFaction.characterId = shuId
    const otherFaction = game.state.players[3]!
    otherFaction.characterId = weiId
    const fire = getSkillRuntime(skill('谋·诸葛亮', '火计').id)!
    const action = fire.activeActions?.(game.state, owner.id).find(({ id }) => id === `skill:${skill('谋·诸葛亮', '火计').id}`)!
    fire.invokeActive?.(game, owner.id, action.id)
    const request = game.state.pendingRequests.find((pending) => pending.kind === 'choose-targets')!
    const hpBefore = [target.hp, sameFaction.hp, otherFaction.hp]
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
    expect(target.hp).toBe(hpBefore[0]! - 1)
    expect(sameFaction.hp).toBe(hpBefore[1]! - 1)
    expect(otherFaction.hp).toBe(hpBefore[2])
    expect((game.state as typeof game.state & { b53MouZhugeFireDamage?: Record<string, number> }).b53MouZhugeFireDamage?.[owner.id]).toBe(2)

    ;(game.state as typeof game.state & { b53MouZhugeFireDamage?: Record<string, number> }).b53MouZhugeFireDamage![owner.id] = game.state.players.length
    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'prepare' }, { phase: 'prepare' })
    expect(missionStatus(game.state, owner.id, skill('谋·诸葛亮', '火计').id)).toBe('success')
    expect(owner.permanentlyLostSkills).toEqual(expect.arrayContaining([
      skill('谋·诸葛亮', '火计').id, skill('谋·诸葛亮', '看破').id,
    ]))
    expect(owner.grantedSkills).toEqual(expect.arrayContaining([
      skill('谋·诸葛亮', '观星※').id, skill('谋·诸葛亮', '空城※').id,
    ]))
  })

  it('谋·诸葛亮未完成使命前进入濒死后使命终局失败，火计不能再发动', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = character('谋·诸葛亮').id
    const id = skill('谋·诸葛亮', '火计').id
    game.dispatch('EnterDying', { playerId: owner.id })
    expect(missionStatus(game.state, owner.id, id)).toBe('failure')
    expect(getSkillRuntime(id)?.activeActions?.(game.state, owner.id)).toEqual([])
  })

  it('谋·诸葛亮观星※按递减张数生成真实星牌，可置顶且星牌可作为手牌使用/响应', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·诸葛亮').id
    const starSkill = skill('谋·诸葛亮', '观星※').id
    grantSkill(game.state, owner.id, starSkill)
    game.state.turnNumber += 1
    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'prepare' }, { targetId: owner.id })

    const request = game.state.pendingRequests.find((entry) => entry.skillId === starSkill && entry.kind === 'choose-cards')!
    if (request.kind !== 'choose-cards') throw new Error('观星※准备阶段应允许选择置顶星牌')
    expect(owner.characterPiles.star).toHaveLength(7)
    const topCard = request.cardIds[0]!
    game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: [topCard] } } as GameResponse)
    expect(game.state.zones.drawPile[0]).toBe(topCard)
    expect(owner.characterPiles.star).toHaveLength(6)
    expect(getSkillRuntime(starSkill)?.viewAs?.(game.state, owner.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ cardId: owner.characterPiles.star[0], asCardName: game.state.cards[owner.characterPiles.star[0]!]?.name }),
    ]))
  })

  it('谋·诸葛亮空城※无星时伤害+1，有星时执行真实判定并按点数减伤', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·诸葛亮').id
    target.characterId = character('谋·诸葛亮').id
    const starId = skill('谋·诸葛亮', '观星※').id
    const emptyId = skill('谋·诸葛亮', '空城※').id
    grantSkill(game.state, target.id, starId)
    grantSkill(game.state, target.id, emptyId)

    const beforeEmptyDamage = target.hp
    resolveDamage(game, { sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal' })
    expect(target.hp).toBe(beforeEmptyDamage - 2)

    target.characterPiles.star = []
    const starIds = game.state.zones.drawPile.slice(0, 3)
    for (const cardId of starIds.slice(0, 2))
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'characterPile', playerId: target.id, pile: 'star' })
    const lowRank = game.state.zones.drawPile.find((cardId) => (game.state.cards[cardId]?.rank ?? 99) <= 2)!
    moveCard(game.state, lowRank, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    const beforeJudgedDamage = target.hp
    resolveDamage(game, { sourceId: owner.id, targetId: target.id, amount: 1, nature: 'normal' })
    expect(target.hp).toBe(beforeJudgedDamage)
    expect(game.state.retrial).toBeNull()
    expect(game.state.pendingDamageModifier).toBeUndefined()
  })

  it('观星※星堆中的实体桃可用于濒死救援并正确离开星堆', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·诸葛亮').id
    grantSkill(game.state, owner.id, skill('谋·诸葛亮', '观星※').id)
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'characterPile', playerId: owner.id, pile: 'star' })
    owner.hp = 0
    game.enterDying(owner.id)
    const rescue = game.state.pendingRequests.find((entry) => entry.kind === 'rescue' && entry.playerId === owner.id)!
    if (rescue.kind !== 'rescue') throw new Error('濒死应产生救援请求')
    expect(rescue.actionIds).toContain(`rescue-card:${peach}`)
    game.respond({ requestId: rescue.id, playerId: owner.id, payload: { actionId: `rescue-card:${peach}` } } as GameResponse)
    expect(owner.hp).toBe(1)
    expect(owner.characterPiles.star).not.toContain(peach)
    expect(game.state.zones.discardPile).toContain(peach)
  })

  it('谋·诸葛亮看破按轮记录牌名，并可使多目标锦囊的整张牌无效', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·诸葛亮').id
    const attacker = game.state.players[1]!
    game.dispatch('RoundStart', { roundNumber: game.state.roundNumber })
    const recordRequest = game.state.pendingRequests.find((entry) => entry.skillId === skill('谋·诸葛亮', '看破').id && entry.kind === 'choose-options')!
    if (recordRequest.kind !== 'choose-options') throw new Error('看破应在轮开始请求记录牌名')
    expect(recordRequest.options.map((option) => option.id)).toContain('万箭齐发')
    game.respond({ requestId: recordRequest.id, playerId: owner.id, payload: { optionIds: ['万箭齐发'] } } as GameResponse)

    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '万箭齐发')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: attacker.id })
    game.state.phase = 'play'
    game.state.currentPlayerId = attacker.id
    const beforeOwnerHand = owner.zones.hand.length
    const beforeAttackerHand = attacker.zones.hand.length
    const use = game.legalActions(attacker.id).find((action) => action.kind === 'use-card' && action.cardIds.includes(cardId))!
    game.act(attacker.id, use.id)
    const intercept = game.state.pendingRequests.find((entry) => entry.skillId === skill('谋·诸葛亮', '看破').id && entry.kind === 'choose-option')!
    if (intercept.kind !== 'choose-option') throw new Error('使用已记录牌名时应询问看破')
    game.respond({ requestId: intercept.id, playerId: owner.id, payload: { optionId: 'yes' } } as GameResponse)
    expect(owner.zones.hand.length).toBe(beforeOwnerHand + 1)
    expect(attacker.zones.hand.length).toBe(beforeAttackerHand - 1)
    expect(game.state.cardResolution).toBeNull()
    expect((game.state as typeof game.state & { b53MouZhugeKanpo?: Record<string, { active: string[] }> }).b53MouZhugeKanpo?.[owner.id]?.active).not.toContain('万箭齐发')
  })

  it('谋·诸葛亮看破可在无目标牌结算前使装备牌无效', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('谋·诸葛亮').id
    const attacker = game.state.players[1]!
    game.dispatch('RoundStart', { roundNumber: game.state.roundNumber })
    const record = game.state.pendingRequests.find((entry) => entry.skillId === skill('谋·诸葛亮', '看破').id && entry.kind === 'choose-options')!
    if (record.kind !== 'choose-options') throw new Error('看破应请求记录牌名')
    const equipmentNames = [...new Set(Object.values(game.state.cards)
      .filter((card) => card.category === 'equipment')
      .map((card) => card.name))]
      .filter((name) => record.options.some((option) => option.id === name))
      .slice(0, 4)
    if (!equipmentNames.length) throw new Error('看破可选牌名中应包含装备牌')
    game.respond({ requestId: record.id, playerId: owner.id, payload: { optionIds: equipmentNames } } as GameResponse)
    const entry = (game.state as typeof game.state & { b53MouZhugeKanpo?: Record<string, { active: string[] }> }).b53MouZhugeKanpo?.[owner.id]
    const cardName = equipmentNames.find((name) => entry?.active.includes(name))
    if (!cardName) throw new Error('看破应保留选定的装备牌名')
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === cardName && game.state.cards[id]?.category === 'equipment')
    if (!cardId) throw new Error('本测试需要记录到一张实体装备牌')
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: attacker.id })
    game.state.phase = 'play'
    game.state.currentPlayerId = attacker.id
    const handBefore = owner.zones.hand.length
    const action = game.legalActions(attacker.id).find((candidate) => candidate.kind === 'use-card' && candidate.cardIds.includes(cardId))!
    game.act(attacker.id, action.id)
    const intercept = game.state.pendingRequests.find((request) => request.skillId === skill('谋·诸葛亮', '看破').id && request.kind === 'choose-option')!
    if (intercept.kind !== 'choose-option') throw new Error('使用已记录装备牌时应询问看破')
    game.respond({ requestId: intercept.id, playerId: owner.id, payload: { optionId: 'yes' } } as GameResponse)
    expect(owner.zones.hand.length).toBe(handBefore + 1)
    expect(game.state.zones.discardPile).toContain(cardId)
    expect(Object.values(attacker.zones.equipment)).not.toContain(cardId)
    expect(game.state.cardResolution).toBeNull()
  })

  it('多目标伤害序列在濒死窗口暂停，不越序结算后续目标', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    target.isHuman = true
    target.hp = 1
    const peach = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, peach, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const next = game.state.players[2]!
    const nextHp = next.hp
    resolveDamageSequence(game, {
      sourceId: owner.id, targetIds: [target.id, next.id],
      amount: 1, nature: 'fire', cardId: null, cardName: '测试火计',
    })
    expect(game.state.dying?.playerId).toBe(target.id)
    expect(next.hp).toBe(nextHp)
    expect(game.state.damageSequence?.nextIndex).toBe(1)
    const rescue = game.state.pendingRequests.find((request) => request.kind === 'rescue' && request.playerId === owner.id)!
    game.respond({ requestId: rescue.id, playerId: owner.id, payload: { actionId: `rescue-card:${peach}` } } as GameResponse)
    expect(target.hp).toBe(1)
    expect(next.hp).toBe(nextHp - 1)
    expect(game.state.damageSequence).toBeNull()
  })

  it('界·张嶷怃戎双方同时秘密提交，四种组合分别结算且盲取不泄露目标手牌', () => {
    const start = (ownerChoice: 'A' | 'B', targetChoice: 'A' | 'B', prepare?: (game: SanguoshaGame, target: typeof game.state.players[number]) => void) => {
      const { game, owner, target } = fixture()
      game.state.status = 'playing'
      game.state.phase = 'play'
      game.state.currentPlayerId = owner.id
      owner.characterId = character('界·张嶷').id
      const id = skill('界·张嶷', '怃戎').id
      const runtime = getSkillRuntime(id)!
      const action = runtime.activeActions?.(game.state, owner.id).find(({ id: actionId }) => actionId === `skill:${id}`)!
      runtime.invokeActive?.(game, owner.id, action.id)
      const targetRequest = game.state.pendingRequests.find((request) => request.kind === 'choose-targets')!
      game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
      const decision = game.state.groupDecision!
      const ownerRequest = game.state.pendingRequests.find((request) => request.id === decision.requestIds[owner.id])!
      const targetDecisionRequest = game.state.pendingRequests.find((request) => request.id === decision.requestIds[target.id])!
      for (const id of game.state.zones.drawPile.slice(0, 4))
        moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
      for (const id of game.state.zones.drawPile.slice(0, 4))
        moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
      prepare?.(game, target)
      game.respond({ requestId: ownerRequest.id, playerId: owner.id, payload: { optionId: ownerChoice } } as GameResponse)
      game.respond({ requestId: targetDecisionRequest.id, playerId: target.id, payload: { optionId: targetChoice } } as GameResponse)
      return { game, owner, target }
    }

    const pressResist = start('A', 'A')
    expect(pressResist.target.hp).toBe(pressResist.target.maxHp - 1)
    expect(pressResist.owner.zones.hand.length).toBe(5)

    const sootheResist = start('B', 'A')
    expect(sootheResist.owner.hp).toBe(sootheResist.owner.maxHp - 1)
    expect(sootheResist.owner.zones.hand.length).toBe(5)

    const pressSubmit = start('A', 'B')
    const ownerHandBefore = pressSubmit.owner.zones.hand.length
    const targetHandBefore = pressSubmit.target.zones.hand.length
    const stealRequest = pressSubmit.game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    expect(stealRequest.playerId).toBe(pressSubmit.owner.id)
    expect(stealRequest.kind === 'choose-cards' ? stealRequest.hiddenCardSlots.length : 0).toBeGreaterThan(0)
    expect(stealRequest.kind === 'choose-cards' ? stealRequest.cardIds.length : -1).toBe(0)
    const hiddenSlot = (stealRequest as Extract<typeof stealRequest, { kind: 'choose-cards' }>).hiddenCardSlots[0]!
    pressSubmit.game.respond({ requestId: stealRequest.id, playerId: pressSubmit.owner.id, payload: { cardIds: [hiddenSlot] } } as GameResponse)
    const giveRequest = pressSubmit.game.state.pendingRequests.find((request) => request.kind === 'choose-cards')!
    const giveIds = pressSubmit.owner.zones.hand.slice(0, 2)
    pressSubmit.game.respond({ requestId: giveRequest.id, playerId: pressSubmit.owner.id, payload: { cardIds: giveIds } } as GameResponse)
    expect(pressSubmit.owner.zones.hand.length).toBe(ownerHandBefore - 1)
    expect(pressSubmit.target.zones.hand.length).toBe(targetHandBefore + 1)

    const sootheSubmitWithCards = start('B', 'B')
    const submitRequest = sootheSubmitWithCards.game.state.pendingRequests.find((request) => request.playerId === sootheSubmitWithCards.target.id && request.kind === 'choose-cards')!
    expect(submitRequest.kind).toBe('choose-cards')
    if (submitRequest.kind !== 'choose-cards') throw new Error('怃戎应要求目标同时选择两张牌')
    expect(submitRequest.hiddenCardSlots).toHaveLength(4)
    const initialOwnerHand = sootheSubmitWithCards.owner.zones.hand.length
    const initialTargetHand = sootheSubmitWithCards.target.zones.hand.length
    sootheSubmitWithCards.game.respond({
      requestId: submitRequest.id, playerId: sootheSubmitWithCards.target.id,
      payload: { cardIds: submitRequest.hiddenCardSlots.slice(0, 2) },
    } as GameResponse)
    expect(sootheSubmitWithCards.owner.zones.hand).toHaveLength(initialOwnerHand + 2)
    expect(sootheSubmitWithCards.target.zones.hand).toHaveLength(initialTargetHand - 2)

    let kept = ''
    const sootheSubmit = start('B', 'B', (game, target) => {
      kept = target.zones.hand[0]!
      for (const cardId of [...target.zones.hand].slice(1))
        moveCard(game.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'discardPile' })
    })
    expect(sootheSubmit.game.state.pendingRequests.some((request) => request.playerId === sootheSubmit.target.id && request.kind === 'choose-cards')).toBe(false)
    expect(sootheSubmit.game.state.scheduledSkippedPhasesByPlayer[sootheSubmit.target.id]).toContain('draw')
    expect(sootheSubmit.target.zones.hand).toEqual([kept])
  })

  it('十常侍亮出逆取后可在出牌阶段指定任意存活角色造成火焰伤害并限一次', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = character('十常侍').id
    const niqu = skill('十常侍', '逆取').id
    grantSkill(game.state, owner.id, niqu)
    const runtime = getSkillRuntime(niqu)!
    const action = runtime.activeActions?.(game.state, owner.id).find(({ id }) => id === `skill:${niqu}`)!
    runtime.invokeActive?.(game, owner.id, action.id)
    const request = game.state.pendingRequests.find((entry) => entry.skillId === niqu && entry.kind === 'choose-targets')!
    expect(request.kind === 'choose-targets' ? request.candidateIds : []).toContain(target.id)
    const hpBefore = target.hp
    game.respond({ requestId: request.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
    expect(target.hp).toBe(hpBefore - 1)
    expect(runtime.activeActions?.(game.state, owner.id)).toEqual([])
  })

  it('十常侍党锢开局生成十张不同常侍关系，随机主党后只允许从四张候选中选合法同党', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('十常侍').id
    expect(character('十常侍').maxHp).toBe(1)
    const danggu = getSkillRuntime(skill('十常侍', '党锢').id)!
    danggu.onGameStart?.(game, owner.id)
    const attendants = (game.state as typeof game.state & {
      b53Attendants?: Record<string, { revealed: string[]; records: Record<string, string> }>
    }).b53Attendants?.[owner.id]
    expect(Object.keys(attendants?.records ?? {})).toHaveLength(10)
    expect(new Set(Object.values(attendants?.records ?? {})).size).toBe(10)
    expect(attendants?.revealed).toHaveLength(1)
    const request = game.state.pendingRequests.find((entry) => entry.skillId === danggu.id && entry.kind === 'choose-option')!
    if (request.kind !== 'choose-option') throw new Error('党锢应请求选择同党')
    expect(request.options.length).toBeGreaterThan(0)
    expect(request.options.length).toBeLessThanOrEqual(4)
    const selected = request.options[0]!.id
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: selected } } as GameResponse)
    expect(attendants?.revealed).toHaveLength(2)
    expect(owner.grantedSkills.some((id) => character('十常侍').skills.some((entry) => entry.id === id && entry.granted))).toBe(true)
  })

  it('十常侍殁亡在有未亮常侍时进入休整，不公开身份、不执行击杀奖励并清理离场牌', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('十常侍').id
    owner.maxHp = 1
    owner.hp = 1
    owner.identityRevealed = false
    for (const player of game.state.players) if (player.id !== owner.id) player.characterId = null
    ;(game.state as typeof game.state & { b53Attendants?: Record<string, { revealed: string[]; records: Record<string, string> }> }).b53Attendants = {
      [owner.id]: { revealed: ['zhangrang', 'zhaozhong'], records: {} },
    }
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    target.characterId = null
    const killerHandBefore = target.zones.hand.length
    resolveDamage(game, { sourceId: target.id, targetId: owner.id, amount: 1, nature: 'normal' })
    let passes = 0
    while (game.state.dying && passes < 8) {
      const request = game.state.pendingRequests.find((entry) => entry.kind === 'rescue')
      if (!request || request.kind !== 'rescue') break
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { actionId: 'rescue-pass' } } as GameResponse)
      passes += 1
    }
    expect(owner.alive).toBe(false)
    expect(owner.restingUntilRound).toBe(game.state.roundNumber + 1)
    expect(owner.identityRevealed).toBe(false)
    expect(owner.zones.hand).toHaveLength(0)
    expect(game.state.zones.discardPile).toContain(cardId)
    expect(target.zones.hand).toHaveLength(killerHandBefore)
    expect(game.state.pendingIdentityVictoryCheck).toBeFalsy()
  })

  it('十常侍仅在休整复归后的回合结束时再次死亡，不会在普通首回合结束时误触发', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    owner.characterId = character('十常侍').id
    const state = game.state as typeof game.state & {
      b53Attendants?: Record<string, { revealed: string[]; records: Record<string, string> }>
    }
    state.b53Attendants = { [owner.id]: { revealed: ['zhangrang', 'zhaozhong', 'sunzhang', 'bilan', 'xiayun', 'hankui', 'lisong', 'duangui', 'guosheng', 'gaowang'], records: {} } }
    game.dispatch('TurnEnd', { playerId: owner.id, turnNumber: game.state.turnNumber }, { targetId: owner.id })
    expect(owner.alive).toBe(true)

    game.dispatch('RestEnd', { playerId: owner.id, roundNumber: game.state.roundNumber }, { targetId: owner.id })
    game.dispatch('TurnEnd', { playerId: owner.id, turnNumber: game.state.turnNumber }, { targetId: owner.id })
    expect(owner.alive).toBe(false)
    expect(owner.restingUntilRound).toBeUndefined()
  })

  it('十常侍在下一轮自己的回合开始前复归并以满体力进入党锢回归流程', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    for (const player of game.state.players) player.characterId = null
    owner.characterId = character('十常侍').id
    owner.maxHp = 1
    owner.hp = 0
    owner.alive = false
    owner.restingUntilRound = 2
    const lastSeat = game.state.players.reduce((last, current) => current.seat > last.seat ? current : last)
    game.state.roundNumber = 1
    game.state.currentPlayerId = lastSeat.id
    game.state.normalTurnPlayerId = lastSeat.id
    game.state.currentTurnKind = 'normal'
    game.state.turnTransitionPending = true
    expect(resumeTurnTransition(game.state, (name, payload) => { game.dispatch(name, payload) })).toBe(true)
    expect(game.state.roundNumber).toBe(2)
    expect(game.state.currentPlayerId).toBe(owner.id)
    expect(owner.alive).toBe(true)
    expect(owner.hp).toBe(owner.maxHp)
    expect(owner.restingUntilRound).toBeUndefined()
    expect(game.state.skillQueue).toContainEqual(expect.objectContaining({ skillId: skill('十常侍', '党锢').id, step: 'rejoin-party', ownerId: owner.id }))
  })

  it('十常侍宵赂摸两张后分别正确支持弃置两张或交给其他角色两张', () => {
    const resolve = (mode: 'discard' | 'give') => {
      const { game, owner, target } = fixture()
      game.state.status = 'playing'
      game.state.phase = 'play'
      game.state.currentPlayerId = owner.id
      owner.characterId = character('十常侍').id
      const xiaolu = skill('十常侍', '宵赂').id
      grantSkill(game.state, owner.id, xiaolu)
      const runtime = getSkillRuntime(xiaolu)!
      const handBefore = owner.zones.hand.length
      runtime.invokeActive?.(game, owner.id, `skill:${xiaolu}`)
      expect(owner.zones.hand).toHaveLength(handBefore + 2)
      const option = game.state.pendingRequests.find((entry) => entry.skillId === xiaolu && entry.kind === 'choose-option')!
      game.respond({ requestId: option.id, playerId: owner.id, payload: { optionId: mode } } as GameResponse)
      if (mode === 'discard') {
        const request = game.state.pendingRequests.find((entry) => entry.skillId === xiaolu && entry.kind === 'choose-cards')!
        if (request.kind !== 'choose-cards') throw new Error('宵赂应要求选择两张弃牌')
        const selected = request.cardIds.slice(0, 2)
        game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: selected } } as GameResponse)
        expect(selected.every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
      } else {
        const targetRequest = game.state.pendingRequests.find((entry) => entry.skillId === xiaolu && entry.kind === 'choose-targets')!
        game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
        const request = game.state.pendingRequests.find((entry) => entry.skillId === xiaolu && entry.kind === 'choose-cards')!
        if (request.kind !== 'choose-cards') throw new Error('宵赂应要求选择交付手牌')
        const selected = request.cardIds.slice(0, 2)
        game.respond({ requestId: request.id, playerId: owner.id, payload: { cardIds: selected } } as GameResponse)
        expect(selected.every((id) => target.zones.hand.includes(id))).toBe(true)
      }
      expect(runtime.activeActions?.(game.state, owner.id)).toEqual([])
    }
    resolve('discard')
    resolve('give')
  })

  it('十常侍自谋仅在出牌阶段第2、4、6次用牌时依次获得酒、杀、决斗', () => {
    const { game, owner } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = character('十常侍').id
    grantSkill(game.state, owner.id, skill('十常侍', '自谋').id)
    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' }, { phase: 'play', targetId: owner.id })
    const rewards = ['酒', '杀', '决斗'].map((name) => game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === name)!)
    for (let index = 0; index < 6; index += 1)
      game.dispatch('CardUsed', { cardName: '闪' }, { sourceId: owner.id })
    expect(rewards.every((id) => owner.zones.hand.includes(id))).toBe(true)
    const countBeforeNext = owner.zones.hand.length
    game.dispatch('PhaseStart', { playerId: owner.id, phase: 'play' }, { phase: 'play', targetId: owner.id })
    game.dispatch('CardUsed', { cardName: '闪' }, { sourceId: owner.id })
    expect(owner.zones.hand).toHaveLength(countBeforeNext)
  })

  it('十常侍窥机只弃置双方合计四张花色各异的手牌，并逐一按持有者记失牌', () => {
    const { game, owner, target } = fixture()
    game.state.status = 'playing'
    game.state.phase = 'play'
    game.state.currentPlayerId = owner.id
    owner.characterId = character('十常侍').id
    const kuiji = skill('十常侍', '窥机').id
    grantSkill(game.state, owner.id, kuiji)
    const selected = (['spade', 'heart', 'club', 'diamond'] as const).map((suit) => game.state.zones.drawPile.find((id) => game.state.cards[id]?.suit === suit)!)
    for (const [index, cardId] of selected.entries())
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: index < 2 ? owner.id : target.id })
    const runtime = getSkillRuntime(kuiji)!
    const action = runtime.activeActions?.(game.state, owner.id).find(({ id }) => id === `skill:${kuiji}`)!
    runtime.invokeActive?.(game, owner.id, action.id)
    const targetRequest = game.state.pendingRequests.find((entry) => entry.skillId === kuiji && entry.kind === 'choose-targets')!
    game.respond({ requestId: targetRequest.id, playerId: owner.id, payload: { targetIds: [target.id] } } as GameResponse)
    const discardRequest = game.state.pendingRequests.find((entry) => entry.skillId === kuiji && entry.kind === 'choose-cards')!
    if (discardRequest.kind !== 'choose-cards') throw new Error('窥机应让技能拥有者选择双方手牌')
    expect(discardRequest.cardIds).toEqual(expect.arrayContaining(selected))
    game.respond({ requestId: discardRequest.id, playerId: owner.id, payload: { cardIds: selected } } as GameResponse)
    expect(selected.every((id) => game.state.zones.discardPile.includes(id))).toBe(true)
    expect(owner.zones.hand).not.toEqual(expect.arrayContaining(selected.slice(0, 2)))
    expect(target.zones.hand).not.toEqual(expect.arrayContaining(selected.slice(2)))
  })
})
