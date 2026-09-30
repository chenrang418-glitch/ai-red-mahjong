import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { buildPlayerView, buildSpectatorView } from '@/sanguosha/engine/view'
import { moveCard } from '@/sanguosha/engine/zones'

const names = ['族·钟毓', '族·钟会', '族·荀攸', '族·王浑', '族·王沦', '族·吴乔', '族·钟繇', '族·王沈', '族·杨赐', '族·杨修']

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第68批', () => {
  it('十名角色均已注册，角色表中的每项技能均有运行时', () => {
    const characters = names.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    for (const character of characters) {
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), `${character!.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('钟毓【惶汗】只在实际发动后计次，第二次结算复原限定宗族技【保族】', () => {
    const game = gameFor('b68-huanghan-reset-limited')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-zhongyu-b68'
    owner.usedLimitedSkills.push('baizu-clan-zhong-b67')
    const cardId = game.state.zones.drawPile[0]!
    const invoke = (optionId: 'yes' | 'no') => {
      game.dispatch('Damaged', { amount: 1, cardName: '杀' }, { targetId: owner.id, cardIds: [cardId] })
      const request = game.state.pendingRequests.at(-1)!
      expect(request.kind).toBe('choose-option')
      game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId } })
    }

    invoke('no')
    expect((game.state as typeof game.state & { b68?: { huanghanUse?: Record<string, { uses: number }> } }).b68?.huanghanUse?.[owner.id]).toBeUndefined()
    invoke('yes')
    expect(owner.usedLimitedSkills).toContain('baizu-clan-zhong-b67')
    invoke('yes')
    expect(owner.usedLimitedSkills).not.toContain('baizu-clan-zhong-b67')
  })

  it('杨修【捷悟】的阶段性手牌可见性只开放给杨修本人，不泄露给其他玩家或旁观者', () => {
    const game = gameFor('b68-jiewu-private-view')
    const [owner, target, other] = game.state.players
    const cardId = game.state.zones.drawPile[0]!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    game.state.privateRevealedHands = { [owner!.id]: [target!.id] }

    expect(buildPlayerView(game.state, owner!.id).players.find((player) => player.id === target!.id)?.hand).toHaveLength(1)
    expect(buildPlayerView(game.state, other!.id).players.find((player) => player.id === target!.id)?.hand).toBeNull()
    expect(buildSpectatorView(game.state).players.find((player) => player.id === target!.id)?.hand).toBeNull()
  })

  it('钟繇【承启】仅在出牌阶段且有至少两张手牌时开放，转化来源限定于本回合未使用牌名', () => {
    const game = gameFor('b68-chengqi-active')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-zhongyao-b68'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    for (const cardId of game.state.zones.drawPile.slice(0, 2))
      moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('chengqi-zhongyao-b68')!
    expect(runtime.activeActions?.(game.state, owner.id)).toHaveLength(1)
    game.state.phase = 'finish'
    expect(runtime.activeActions?.(game.state, owner.id)).toEqual([])
  })

  it('钟繇【承启】从选牌名、选材料到真实使用转化牌形成完整流程', () => {
    const game = gameFor('b68-chengqi-use')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-zhongyao-b68'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const materialIds = game.state.zones.drawPile.slice(0, 4)
    for (const cardId of materialIds) moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    const skillAction = game.legalActions(owner!.id).find((action) => action.id === 'skill:chengqi-zhongyao-b68')
    expect(skillAction).toBeDefined()
    game.act(owner!.id, skillAction!.id)

    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const name = request.kind === 'choose-option' ? request.options.find((option) => option.id === '杀')?.id : undefined
    expect(name).toBe('杀')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: name } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', min: 2 })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: materialIds.slice(0, 2) } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-cards', min: 1, max: 1 })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [materialIds[0]!] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const useId = request.kind === 'choose-option' ? request.options.find((option) => option.id !== 'pass')?.id : undefined
    expect(useId).toBeTruthy()
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: useId } })

    expect(game.state.cardUseHistory?.some((entry) => entry.sourceId === owner!.id && entry.cardName === '杀')).toBe(true)
    expect(game.state.zones.discardPile).toEqual(expect.arrayContaining([materialIds[1]!]))
    expect(game.state.pendingRequests.some((entry) => entry.playerId === target!.id)).toBe(true)
  })

  it('杨修【捷悟】阶段开始私下观看、发动展示、同花色摸牌，并在阶段结束关闭可见性', () => {
    const game = gameFor('b68-jiewu-flow')
    const [owner, target, other] = game.state.players
    owner!.characterId = 'clan-yangxiu-b68'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const targetCard = game.state.zones.drawPile[0]!
    const targetSuit = game.state.cards[targetCard]!.suit
    const usedCard = game.state.zones.drawPile.find((id) => id !== targetCard && game.state.cards[id]?.suit === targetSuit)!
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target!.id })
    moveCard(game.state, usedCard, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })

    game.emit('PhaseStart', { playerId: owner!.id, phase: 'play' })
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    expect(buildPlayerView(game.state, owner!.id).players.find((player) => player.id === target!.id)?.hand).toHaveLength(1)
    expect(buildPlayerView(game.state, other!.id).players.find((player) => player.id === target!.id)?.hand).toBeNull()

    game.dispatch('AfterCardUse', { targetIds: [other!.id], cardId: usedCard, cardName: '杀' }, { sourceId: owner!.id, targetId: other!.id, cardIds: [usedCard] })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'yes' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    const beforeDraw = owner!.zones.hand.length
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { cardIds: [targetCard] } })
    expect(owner!.zones.hand.length).toBe(beforeDraw + 1)

    game.emit('PhaseEnd', { playerId: owner!.id, phase: 'play' })
    expect(buildPlayerView(game.state, owner!.id).players.find((player) => player.id === target!.id)?.hand).toBeNull()
  })

  it('荀攸【百出】在牌结算后才要求记录新普通锦囊，不打断正在使用的牌', () => {
    const game = gameFor('b68-baichu-after-use')
    const owner = game.state.players[0]!
    owner.characterId = 'clan-xunyou-b68'
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '无中生有')!
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    game.dispatch('CardUsed', { cardId, cardName: '无中生有', targetIds: [] }, { sourceId: owner.id, cardIds: [cardId] })
    expect(game.state.pendingRequests).toHaveLength(0)

    game.dispatch('AfterCardUse', { cardId, cardName: '无中生有', targetIds: [] }, { sourceId: owner.id, cardIds: [cardId] })
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', skillId: 'baichu-xunyou-b68', optional: false })
    game.respond({ requestId: request.id, playerId: owner.id, payload: { optionId: '无中生有' } })
    const state = game.state as typeof game.state & { b68?: { baichu?: Record<string, { names: string[] }> } }
    expect(state.b68?.baichu?.[owner.id]?.names).toContain('无中生有')
  })

  it('杨修【高视】允许任意顺序使用亮牌，并在全部使用后摸两张牌', () => {
    const game = gameFor('b68-gaoshi-use')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-yangxiu-b68'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'finish'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'drawPile' }, { toTop: true })
    ;(game.state as typeof game.state & { b68: { jiewuUses: Record<string, { turn: number; count: number }> } }).b68 = {
      jiewuUses: { [owner!.id]: { turn: game.state.turnNumber, count: 1 } },
    }
    game.emit('PhaseStart', { playerId: owner!.id, phase: 'finish' })
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'yes' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-option')
    const useId = request.kind === 'choose-option' ? request.options.find((option) => option.id !== 'stop')?.id : undefined
    expect(useId).toBeTruthy()
    const handBefore = owner!.zones.hand.length
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: useId } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'respond-card', playerId: target!.id })
    if (request.kind !== 'respond-card') throw new Error('高视亮出的杀未进入正常响应流程')
    game.respond({ requestId: request.id, playerId: target!.id, payload: { actionId: 'respond-pass' } })
    expect(game.state.cardUseHistory?.some((entry) => entry.sourceId === owner!.id && entry.cardName === '杀')).toBe(true)
    expect(owner!.zones.hand.length).toBe(handBefore + 2)
    const state = game.state as typeof game.state & { b68?: { gaoshiPending?: Record<string, unknown> } }
    expect(state.b68?.gaoshiPending?.[owner!.id]).toBeUndefined()
  })

  it('王沦【求心】完成目标声明与实体杀使用，并在牌结算后切换下一项', () => {
    const game = gameFor('b68-qiuxin-alternate')
    const [owner, target] = game.state.players
    owner!.characterId = 'clan-wanglun-b68'
    game.state.currentPlayerId = owner!.id
    game.state.phase = 'play'
    const slashId = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, slashId, { kind: 'drawPile' }, { kind: 'hand', playerId: owner!.id })
    game.act(owner!.id, 'skill:qiuxin-wanglun-b68')
    let request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-targets')
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [target!.id] } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: target!.id })
    game.respond({ requestId: request.id, playerId: target!.id, payload: { optionId: 'accept' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', playerId: owner!.id })
    const useId = request.kind === 'choose-option' ? request.options[0]?.id : undefined
    expect(useId).toBeTruthy()
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: useId } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'respond-card', playerId: target!.id })
    if (request.kind !== 'respond-card') throw new Error('求心指定的杀未进入正常响应流程')
    game.respond({ requestId: request.id, playerId: target!.id, payload: { actionId: 'respond-pass' } })
    const state = game.state as typeof game.state & { b68?: { qiuxinMode?: Record<string, string> } }
    expect(state.b68?.qiuxinMode?.[owner!.id]).toBe('trick')
  })
})
