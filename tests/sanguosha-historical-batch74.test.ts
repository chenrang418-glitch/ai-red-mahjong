import { describe, expect, it } from 'vitest'
import { conversionStateOf, setConversionState } from '@/sanguosha/engine/conversion'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { moveCard } from '@/sanguosha/engine/zones'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { hasUnlimitedSlash } from '@/sanguosha/engine/equipment'
import { wineUseAllowed } from '@/sanguosha/engine/cards/basic'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH74_CHARACTERS } from '@/sanguosha/data/characters/historical-batch74'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第74批技能接入', () => {
  it('按武将册次序登记十名，每项技能均有运行时', () => {
    expect(HISTORICAL_BATCH74_CHARACTERS.map(({ name }) => name)).toEqual([
      '李异谢旌', '孙桓', '张媱', '全惠解', '谢灵毓', '甘夫人糜夫人', '吴班', '傅肜傅佥', '高翔', '秦宜禄',
    ])
    expect(HISTORICAL_BATCH74_CHARACTERS.every(({ id }) => ALL_CHARACTERS.some((character) => character.id === id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH74_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH74_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('秦宜禄【漂萍】在阳状态结算摸牌并逐次切换转换状态', () => {
    const game = gameFor('b74-piaoping-state')
    const owner = game.state.players[0]!
    owner.characterId = 'qinyilu-b74'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 1
    const runtime = getSkillRuntime('piaoping-qinyilu-b74')!
    const before = owner.zones.hand.length
    const trigger = runtime.triggers!.find((item) => item.event === 'CardUsed')!
    trigger.handle(game as never, owner.id, { event: { id: 'b74-used', seq: game.state.seq++, name: 'CardUsed',
      sourceId: owner.id, payload: { cardName: '杀' } }, cancelled: false, cancel() { this.cancelled = true } } as never)
    expect(owner.zones.hand.length).toBe(before + 1)
    expect(conversionStateOf(game.state, owner.id, runtime.id)).toBe('yin')
  })

  it('李异谢旌【斗阵】只给阴状态的红色基本牌提供无次数限制的杀', () => {
    const game = gameFor('b74-douzhen-slash-limit')
    const owner = game.state.players[0]!
    owner.characterId = 'liyixiejing-b74'
    game.state.currentPlayerId = owner.id
    setConversionState(game.state, owner.id, 'douzhen-liyixiejing-b74', 'yin')
    const runtime = getSkillRuntime('douzhen-liyixiejing-b74')!
    const redBasic = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic' && game.state.cards[id]?.color === 'red')!
    const blackBasic = game.state.zones.drawPile.find((id) => game.state.cards[id]?.category === 'basic' && game.state.cards[id]?.color === 'black')!
    expect(runtime.forcedCardIdentity?.(game.state, owner.id, redBasic)?.asCardName).toBe('杀')
    expect(runtime.unlimitedSlashFor?.(game.state, owner.id, redBasic)).toBe(true)
    expect(runtime.unlimitedSlashFor?.(game.state, owner.id, blackBasic)).toBe(false)
  })

  it('甘夫人糜夫人【殉别】改将并回复至1，且添加仅本回合有效的防伤害技能', () => {
    const game = gameFor('b74-xunbie-transform')
    const owner = game.state.players[0]!
    owner.characterId = 'ganmifuren-b74'
    owner.hp = 0
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 4
    const runtime = getSkillRuntime('xunbie-ganmifuren-b74')!
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'transform', data: {
      choices: [{ id: 'ganfuren', label: '甘夫人' }],
    } } as never, { requestId: 'xunbie', playerId: owner.id, payload: { optionId: 'ganfuren' } } as never)
    expect(owner.characterId).toBe('ganfuren')
    expect(owner.hp).toBe(1)
    expect(owner.temporaryGrantedSkills?.some((entry) => entry.source === runtime.id)).toBe(true)
  })

  it('张媱【怨语】按本次实际结算的伤害点数逐次要求放置“怨”', () => {
    const game = gameFor('b74-yuyu-damage-points')
    const owner = game.state.players[0]!
    const marked = game.state.players[1]!
    owner.characterId = 'zhangyao-b74'
    marked.zones.hand = [...game.state.zones.drawPile.slice(0, 2)]
    game.state.zones.drawPile = game.state.zones.drawPile.slice(2)
    ;(game.state as typeof game.state & { b74: Record<string, any> }).b74 = { yuyuTargets: { [owner.id]: marked.id } }
    const runtime = getSkillRuntime('yuyu-zhangyao-b74')!
    const trigger = runtime.triggers!.find((item) => item.event === 'DamageSettled')!
    trigger.handle(game as never, owner.id, { event: { id: 'b74-damage', seq: game.state.seq++, name: 'DamageSettled',
      sourceId: marked.id, payload: { finalAmount: 2 } }, cancelled: false, cancel() { this.cancelled = true } } as never)
    expect(game.state.skillQueue.some((prompt) => prompt.step === 'damage-resentment' && prompt.skillId === runtime.id)).toBe(true)
    runtime.startQueued!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'damage-resentment', data: { sourceId: marked.id } } as never)
    expect(game.state.pendingRequests.some((request) => request.kind === 'choose-cards' && request.playerId === marked.id)).toBe(true)
  })

  it('张媱【夕颜】本回合对所有有次数额度的牌生效，回合切换后失效', () => {
    const game = gameFor('b74-xiyan-unlimited-card-use')
    const owner = game.state.players[0]!
    owner.characterId = 'zhangyao-b74'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 5
    ;(game.state as typeof game.state & { b74: Record<string, any> }).b74 = {
      yuyuUnbounded: { [owner.id]: 5 },
    }
    game.state.turnUsage.wineUses = 1
    expect(hasUnlimitedSlash(game.state, owner.id)).toBe(true)
    expect(wineUseAllowed(game.state, owner.id)).toBe(true)
    game.state.turnNumber = 6
    expect(hasUnlimitedSlash(game.state, owner.id)).toBe(false)
    expect(wineUseAllowed(game.state, owner.id)).toBe(false)
  })

  it('全惠解【慧淑】第三张本回合弃牌触发等量随机非基本牌获得', () => {
    const game = gameFor('b74-huishu-discard-threshold')
    const owner = game.state.players[0]!
    owner.characterId = 'quanhui-b74'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 1
    const discardIds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.category === 'basic').slice(0, 3)
    const nonBasicIds = game.state.zones.drawPile.filter((id) => game.state.cards[id]?.category !== 'basic').slice(0, 4)
    game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => !discardIds.includes(id) && !nonBasicIds.includes(id))
    game.state.zones.discardPile.push(...discardIds, ...nonBasicIds)
    ;(game.state as typeof game.state & { b74: Record<string, any> }).b74 = { huishuDiscardBonus: { [owner.id]: true } }
    const runtime = getSkillRuntime('huishu-quanhuijie-b74')!
    const trigger = runtime.triggers!.find((item) => item.event === 'CardEnteredDiscardByMove')!
    for (let index = 0; index < 3; index++) trigger.handle(game as never, owner.id, { event: { id: `b74-discard-${index}`,
      seq: game.state.seq++, name: 'CardEnteredDiscardByMove', sourceId: owner.id,
      payload: { fromPlayerId: owner.id, reason: 'discard', cardId: discardIds[index] } }, cancelled: false, cancel() { this.cancelled = true } } as never)
    expect(owner.zones.hand.filter((id) => nonBasicIds.includes(id))).toHaveLength(3)
  })

  it('秦宜禄【托献】将本次弃牌交给对方并严格执行其等量弃牌选项', () => {
    const game = gameFor('b74-tuoxian-equal-discard')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    owner.characterId = 'qinyilu-b74'
    game.state.currentPlayerId = owner.id
    game.state.turnNumber = 3
    const given = game.state.zones.drawPile[0]!
    const targetCard = game.state.zones.drawPile[1]!
    moveCard(game.state, given, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, targetCard, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const runtime = getSkillRuntime('tuoxian-qinyilu-b74')!
    runtime.onGameStart?.(game as never, owner.id)
    ;(game.state as typeof game.state & { b74: Record<string, any> }).b74.piaopingPending = { [owner.id]: [given] }
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'offer-tuoxian', data: {} } as never,
      { requestId: 'tuoxian-target', playerId: owner.id, payload: { targetIds: [target.id] } } as never)
    expect(target.zones.hand).toContain(given)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'target-choice', data: { targetId: target.id, amount: 1 } } as never,
      { requestId: 'tuoxian-choice', playerId: target.id, payload: { optionId: 'discard' } } as never)
    expect(game.state.pendingRequests.some((request) => request.kind === 'choose-cards' && request.playerId === target.id)).toBe(true)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'discard-target', data: { targetId: target.id, count: 1 } } as never,
      { requestId: 'tuoxian-discard', playerId: target.id, payload: { cardIds: [targetCard] } } as never)
    expect(game.state.zones.discardPile).toContain(targetCard)
    expect(target.zones.hand).toContain(given)
  })

  it('甘夫人糜夫人【婵娟】提供普通合法目标，目标与原牌相同才摸牌', () => {
    const game = gameFor('b74-chanjuan-target-selection')
    const owner = game.state.players[0]!
    owner.characterId = 'ganmifuren-b74'
    owner.hp = owner.maxHp - 1
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    game.state.turnNumber = 2
    const original = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    moveCard(game.state, original, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime('chanjuan-ganmifuren-b74')!
    const event = (name: 'CardUsed' | 'AfterCardUse') => ({ event: { id: `b74-chanjuan-${name}`, seq: game.state.seq++, name,
      sourceId: owner.id, payload: { cardId: original, cardName: '桃', targetIds: [owner.id] } }, cancelled: false, cancel() { this.cancelled = true } })
    runtime.triggers!.find((item) => item.event === 'CardUsed')!.handle(game as never, owner.id, event('CardUsed') as never)
    runtime.triggers!.find((item) => item.event === 'AfterCardUse')!.handle(game as never, owner.id, event('AfterCardUse') as never)
    runtime.startQueued!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'repeat-offer', data: { name: '桃', targetId: owner.id } } as never)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'repeat-choice', data: { name: '桃', targetId: owner.id } } as never,
      { requestId: 'chanjuan-yes', playerId: owner.id, payload: { optionId: 'yes' } } as never)
    const option = game.state.pendingRequests[0] as { options?: Array<{ id: string; label: string }> } | undefined
    expect(option?.options?.some(({ label }) => label.includes('回复体力'))).toBe(true)
    game.state.skillResolution = null
    game.state.pendingRequests = []
    const cardId = Object.keys((game.state as typeof game.state & { b74: Record<string, any> }).b74.chanjuanRepeats)[0]!
    const before = owner.zones.hand.length
    runtime.resume!(game as never, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'repeat-use', data: { cardId, name: '桃' } } as never,
      { requestId: 'chanjuan-use', playerId: owner.id, payload: { optionId: option!.options![0]!.id } } as never)
    expect(owner.hp).toBe(owner.maxHp)
    expect(owner.zones.hand.length).toBe(before)
    expect(game.state.cards[cardId]).toBeUndefined()
  })
})
