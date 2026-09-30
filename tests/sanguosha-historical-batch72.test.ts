import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH72_CHARACTERS } from '@/sanguosha/data/characters/historical-batch72'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第72批技能接入', () => {
  it('武将册顺序接入十人，且登记技能均有运行时', () => {
    expect(HISTORICAL_BATCH72_CHARACTERS.map(({ name }) => name)).toEqual([
      '忙牙长', '管辂', '许劭', '杜夔', '邢道荣', '蔡阳', '周善', '万年公主', '蔡瑁张允', '王桃',
    ])
    expect(HISTORICAL_BATCH72_CHARACTERS.every((character) => ALL_CHARACTERS.some((entry) => entry.id === character.id))).toBe(true)
    expect(new Set(HISTORICAL_BATCH72_CHARACTERS.map(({ id }) => id)).size).toBe(10)
    for (const character of HISTORICAL_BATCH72_CHARACTERS)
      for (const skill of character.skills) expect(getSkillRuntime(skill.id), `${character.name}【${skill.name}】`).toBeDefined()
  })

  it('万年公主【兴汉】不把其他万年公主的【枕戈】记录算作自己的', () => {
    const game = gameFor('b72-xinghan-owner-scope')
    const owner = game.state.players[0]!
    const attacker = game.state.players[1]!
    owner.characterId = 'wanniangongzhu-b72'
    const state = game.state as typeof game.state & { b72: Record<string, any> }
    state.b72 = {
      zhengzhu: { [`${game.state.players[2]!.id}:${attacker.id}`]: { targetId: attacker.id, bonus: 1 } },
      xinghanFirstSlash: { [String(game.state.turnNumber)]: { cardId: 'slash-test', sourceId: attacker.id, settled: false } },
    }
    const before = owner.zones.hand.length
    const trigger = getSkillRuntime('xinghan-wanniangongzhu-b72')!.triggers!.find((item) => item.event === 'DamageSettled')!
    trigger.handle(game, owner.id, { event: { id: 'b72-xinghan', seq: game.state.seq++, name: 'DamageSettled', sourceId: attacker.id,
      targetId: game.state.players[3]!.id, payload: { finalAmount: 1, cardId: 'slash-test', cardName: '杀' } }, cancelled: false,
      cancel() { this.cancelled = true } })
    expect(owner.zones.hand.length).toBe(before)
  })

  it('蔡瑁张允【惊澜】在濒死救回后才摸五张，并消费待结算标记', () => {
    const game = gameFor('b72-jinglan-quit-dying')
    const owner = game.state.players[0]!
    owner.characterId = 'caimaozhangyun-b72'
    ;(game.state as typeof game.state & { b72: Record<string, any> }).b72 = { jinglanPending: { [owner.id]: true } }
    const runtime = getSkillRuntime('jinglan-caimaozhangyun-b72')!
    const trigger = runtime.triggers!.find((item) => item.event === 'QuitDying')!
    const before = owner.zones.hand.length
    trigger.handle(game, owner.id, { event: { id: 'b72-jinglan-quit-dying', seq: game.state.seq++, name: 'QuitDying',
      targetId: owner.id, payload: { playerId: owner.id, hp: 1 } }, cancelled: false, cancel() { this.cancelled = true } })
    expect(owner.zones.hand.length - before).toBe(5)
    expect((game.state as typeof game.state & { b72: { jinglanPending: Record<string, boolean> } }).b72.jinglanPending[owner.id]).toBeUndefined()
  })

  it('蔡阳【寻嫉】虚拟【决斗】结算后清理未造成伤害时的记录', () => {
    const game = gameFor('b72-xunji-cleanup')
    const owner = game.state.players[0]!
    owner.characterId = 'caiyang-b72'
    const target = game.state.players[1]!
    const state = game.state as typeof game.state & { b72: { xunji: Record<string, unknown> } }
    state.b72 = { xunji: { [owner.id]: { targetId: target.id, active: false, usedBlack: true } } }
    const runtime = getSkillRuntime('xunji-caiyang-b72')!
    const trigger = runtime.triggers!.find((item) => item.event === 'AfterCardUse')!
    trigger.handle(game, owner.id, { event: { id: 'b72-xunji-after-use', seq: game.state.seq++, name: 'AfterCardUse',
      sourceId: owner.id, sourceSkillId: runtime.id, payload: { targetIds: [target.id], cardName: '决斗' } }, cancelled: false,
      cancel() { this.cancelled = true } })
    expect(state.b72.xunji[owner.id]).toBeUndefined()
  })

  it('王桃【摇佩】的暗手牌候选只暴露符合未弃花色的槽位', () => {
    const game = gameFor('b72-yaopei-hidden-suits')
    const owner = game.state.players[0]!
    const target = game.state.players[1]!
    const ids = ['spade', 'heart', 'club'].map((suit) =>
      game.state.zones.drawPile.find((id) => game.state.cards[id]!.suit === suit)!).filter(Boolean)
    for (const id of ids) moveCard(game.state, id, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const state = game.state as typeof game.state & { b72: Record<string, any> }
    state.b72 = { yaopeiTargets: {}, huguan: {} }
    const runtime = getSkillRuntime('yaopei-wangtao-b72')!
    runtime.startQueued!(game, owner.id, { skillId: runtime.id, ownerId: owner.id, step: 'choose-card',
      data: { targetId: target.id, suits: ['heart'] } })
    const request = game.state.pendingRequests.at(-1)!
    expect(request.kind).toBe('choose-cards')
    if (request.kind !== 'choose-cards') return
    expect(request.hiddenCardSlots).toHaveLength(1)
    expect(request.hiddenCardSlots[0]).toBe(`hidden:${target.id}:${target.zones.hand.indexOf(ids.find((id) => game.state.cards[id]!.suit === 'heart')!)}`)
  })

  it('场上多名王桃时【护关】的首牌时机分别记录，不互相消耗', () => {
    const game = gameFor('b72-huguan-independent')
    const owners = game.state.players.slice(0, 2)
    const actor = game.state.players[2]!
    const runtime = getSkillRuntime('huguan-wangtao-b72')!
    const phaseStart = runtime.triggers!.find((item) => item.event === 'PhaseStart')!
    for (const owner of owners) phaseStart.handle(game, owner.id, { event: { id: `phase-${owner.id}`, seq: game.state.seq++, name: 'PhaseStart',
      payload: { playerId: actor.id, phase: 'play' } }, cancelled: false, cancel() { this.cancelled = true } })
    const firstCard = Object.entries((game.state as typeof game.state & { b72: any }).b72.huguanFirstCard)
    expect(firstCard.map(([key]) => key)).toEqual(owners.map((owner) => `${owner.id}:${actor.id}:${game.state.turnNumber}`))
  })
})
