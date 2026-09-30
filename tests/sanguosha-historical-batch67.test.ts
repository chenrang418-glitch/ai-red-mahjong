import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { skillsOf } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { legalPlayActions } from '@/sanguosha/engine/cards/basic'
import { maxCardsOf } from '@/sanguosha/engine/phase'
import { setConversionState } from '@/sanguosha/engine/conversion'
import { hiddenHandSlot } from '@/sanguosha/engine/cards/host'

const names = ['族·荀粲', '族·吴苋', '族·吴班', '族·韩韶', '族·韩融', '族·钟琰', '族·吴匡', '族·王允', '族·王凌', '族·王昶']

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第67批', () => {
  it('十名角色注册完整，所有技能均有运行时', () => {
    const characters = names.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    for (const character of characters) {
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), `${character!.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('斩钉提供至少一张、可多张组合的任意花色杀转化', () => {
    const game = gameFor('b67-zhangding-viewas')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-wuban-b67'
    while (owner.zones.hand.length < 2) {
      const cardId = game.state.zones.drawPile[0]!
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    }
    const runtime = getSkillRuntime('zhangding-clan-wuban-b67')!
    const spec = runtime.multiCardViewAs?.(game.state, owner.id)
    expect(spec).toMatchObject({ requiredCount: 1, sameSuit: false, anySuitCardNames: ['杀'] })
    expect(spec?.maxCount).toBeGreaterThan(1)
  })

  it('铭戒只把记录的目标加入额外目标候选', () => {
    const game = gameFor('b67-mingjie-target')
    const [owner, target, other] = game.state.players
    owner!.characterId = 'clan-wangyun-b67'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    ;(game.state as typeof game.state & { b67: { mingjie: Record<string, unknown> } }).b67 = {
      mingjie: { [owner!.id]: { targetId: target!.id, expiresTurn: 0, turnNumber: game.state.turnNumber, records: [] } },
    }
    const runtime = getSkillRuntime('mingjie-clan-wangyun-b67')!
    expect(runtime.modifiesNextCardTargets?.(game.state, owner!.id, 'card', '杀')).toBe(true)
    expect(runtime.nextCardTargetExpansion?.(game.state, owner!.id, 'card', '杀')?.candidateIds).toEqual([target!.id])
    expect(runtime.nextCardTargetExpansion?.(game.state, owner!.id, 'card', '杀')?.candidateIds).not.toContain(other!.id)
  })

  it('铭戒的额外目标同时进入延时锦囊的实际合法动作', () => {
    const game = gameFor('b67-mingjie-delayed')
    const [owner, marked, other] = game.state.players
    owner!.characterId = 'clan-wangyun-b67'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '乐不思蜀')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    ;(game.state as typeof game.state & { b67: { mingjie: Record<string, unknown> } }).b67 = {
      mingjie: { [owner!.id]: { targetId: marked!.id, expiresTurn: 0, turnNumber: game.state.turnNumber, records: [] } },
    }
    const actions = legalPlayActions(game.state, owner!.id).filter((action) => action.kind === 'use-card' && action.cardIds.includes(cardId))
    expect(actions.some((action) => action.kind === 'use-card' && action.targetIds.includes(marked!.id))).toBe(true)
    expect(actions.some((action) => action.kind === 'use-card' && action.targetIds.includes(other!.id) && action.targetIds.includes(marked!.id))).toBe(true)
  })

  it('中流在非同族手牌使用期间统一屏蔽持有者的其他被动与触发技能', () => {
    const game = gameFor('b67-zhongliu-mute')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-wangyun-b67'
    const cardId = game.state.zones.drawPile[0]!
    game.state.clanUseSkillMute = { playerId: owner.id, cardId }
    expect(skillsOf(game.state, owner.id, (characterId) => ALL_CHARACTERS.find((entry) => entry.id === characterId)?.skills.map((skill) => skill.id) ?? []).map((runtime) => runtime.id))
      .toEqual(['zhongliu-clan-wang'])
    delete game.state.clanUseSkillMute
    expect(skillsOf(game.state, owner.id, (characterId) => ALL_CHARACTERS.find((entry) => entry.id === characterId)?.skills.map((skill) => skill.id) ?? []))
      .toHaveLength(3)
  })

  it('联诛和开济只开放在其规则时机，铭戒资源不改变其他角色状态', () => {
    const game = gameFor('b67-active-windows')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-wukuang-b67'
    target!.characterId = 'clan-wangchang-b67'
    game.state.currentPlayerId = target!.id
    game.state.phase = 'play'
    const lianzhu = getSkillRuntime('lianzhu-clan-wukuang-b67')!
    expect(lianzhu.grantsPlayActions?.(game.state, owner!.id, target!.id)).toHaveLength(1)
    game.state.currentPlayerId = owner!.id
    const kaiji = getSkillRuntime('kaiji-clan-wangchang-b67')!
    expect(kaiji.activeActions?.(game.state, owner!.id)).toEqual([])
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    game.state.currentPlayerId = target!.id
    expect(kaiji.activeActions?.(game.state, target!.id)).toHaveLength(1)
  })

  it('联诛阳按当前角色与吴匡各自选择的重铸牌结算，并在同色时增加上限', () => {
    const game = gameFor('b67-lianzhu-yang')
    const [owner, actor] = game.state.players
    owner!.characterId = 'clan-wukuang-b67'
    actor!.characterId = 'clan-wangchang-b67'
    game.state.currentPlayerId = actor!.id
    game.state.phase = 'play'
    const sameColorCards = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.color === 'red').slice(0, 2)
    expect(sameColorCards).toHaveLength(2)
    moveCard(game.state, sameColorCards[0]!, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, sameColorCards[1]!, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
    const action = game.legalActions(actor!.id).find((candidate) => candidate.id === 'skill:lianzhu-clan-wukuang-b67')
    expect(action).toBeDefined()
    game.act(actor!.id, action!.id)
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: actor!.id, min: 0, max: 1 })
    game.respond({ requestId: request.id, playerId: actor!.id, payload: { cardIds: [sameColorCards[1]!] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: owner!.id, min: 0, max: 1 })
    expect(game.state.skillResolution).toMatchObject({ skillId: 'lianzhu-clan-wukuang-b67', step: 'yang-owner-card', data: { targetId: actor!.id, targetCardId: sameColorCards[1] } })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [sameColorCards[0]!] } })
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining(sameColorCards))
    expect(maxCardsOf(game.state, owner!.id)).toBe(owner!.hp + 1)
  })

  it('联诛阴按吴匡先、当前角色后串行使用实体杀，异色时减少手牌上限', () => {
    const game = gameFor('b67-lianzhu-yin')
    const [owner, actor, victim] = game.state.players
    owner!.characterId = 'clan-wukuang-b67'
    actor!.characterId = 'clan-wangchang-b67'
    game.state.currentPlayerId = actor!.id
    game.state.phase = 'play'
    setConversionState(game.state, owner!.id, 'lianzhu-clan-wukuang-b67', 'yin')
    const ownerSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.color === 'red')!
    const actorSlash = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀' && game.state.cards[id]?.color === 'black')!
    moveCard(game.state, ownerSlash, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    moveCard(game.state, actorSlash, { kind: 'drawPile' }, { kind: 'hand', playerId: actor!.id })
    const action = game.legalActions(actor!.id).find((candidate) => candidate.id === 'skill:lianzhu-clan-wukuang-b67')!
    game.act(actor!.id, action.id)
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', playerId: owner!.id })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [victim!.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner!.id })
    const firstAction = (request as { options: Array<{ id: string }> }).options.find((option) => option.id !== 'pass')!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: firstAction.id } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'respond-card', playerId: victim!.id })
    game.respond({ requestId: request.id, playerId: victim!.id, payload: { actionId: 'respond-pass' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: actor!.id })
    const secondAction = (request as { options: Array<{ id: string }> }).options.find((option) => option.id !== 'pass')!
    game.respond({ requestId: request.id, playerId: actor!.id, payload: { optionId: secondAction.id } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'respond-card', playerId: victim!.id })
    game.respond({ requestId: request.id, playerId: victim!.id, payload: { actionId: 'respond-pass' } })
    expect(maxCardsOf(game.state, owner!.id)).toBe(owner!.hp - 1)
    expect(game.state.conversionStates?.[`${owner!.id}:lianzhu-clan-wukuang-b67`]).toBe('yang')
  })

  it('开济让目标暗选手牌，使用所弃装备牌后才摸牌', () => {
    const game = gameFor('b67-kaiji-flow')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-wangchang-b67'
    target!.characterId = 'clan-wukuang-b67'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    const action = game.legalActions(owner!.id).find((candidate) => candidate.id === 'skill:kaiji-clan-wangchang-b67')!
    game.act(owner!.id, action.id)
    let request = game.state.pendingRequests.at(-1)!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', playerId: target!.id, cardIds: [], hiddenCardSlots: [hiddenHandSlot(owner!.id, 0)] })
    game.respond({ requestId: request.id, playerId: target!.id, payload: { cardIds: [hiddenHandSlot(owner!.id, 0)] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner!.id })
    const useAction = (request as { options: Array<{ id: string }> }).options.find((option) => option.id !== 'pass')!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: useAction.id } })
    expect(Object.values(game.state.players.find((player) => player.id === owner!.id)!.zones.equipment)).toContain(cardId)
    expect(game.state.players.find((player) => player.id === owner!.id)?.zones.hand.length).toBe(1)
    expect(game.state.skillResolution).toBeNull()
  })

  it('铭戒在目标回合结束时逐张从弃牌堆使用符合条件的牌', () => {
    const game = gameFor('b67-mingjie-reuse')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-wangyun-b67'
    game.state.currentPlayerId = target!.id
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'equipment')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'discardPile' })
    ;(game.state as typeof game.state & { b67: { mingjie: Record<string, unknown> } }).b67 = {
      mingjie: { [owner!.id]: { targetId: target!.id, expiresTurn: 0, turnNumber: game.state.turnNumber, records: [{ cardId, cardName: game.state.cards[cardId]!.name, used: true }] } },
    }
    game.emit('TurnEnd', { playerId: target!.id, turnNumber: game.state.turnNumber })
    ;(game as unknown as { settle(): void }).settle()
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner!.id })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: cardId } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner!.id })
    const useAction = (request as { options: Array<{ id: string }> }).options.find((option) => option.id !== 'pass')!
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: useAction.id } })
    expect(Object.values(game.state.players.find((player) => player.id === owner!.id)!.zones.equipment)).toContain(cardId)
    expect(game.state.zones.discardPile).not.toContain(cardId)
  })
})
