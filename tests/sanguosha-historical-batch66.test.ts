import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { exchangeHp } from '@/sanguosha/engine/hp'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'
import type { PlayerId } from '@/sanguosha/engine/types'

const names = ['谋·邓艾', '谋·鲁肃', '谋·许攸', '谋·戏志才', '谋·张让', '谋·董昭', '谋·程昱', '族·荀淑', '族·荀谌', '族·荀采']
const QIANFU = 'qianfu-mou-xuyou-b66'

function gameFor(seed: string): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `${seed}-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
  game.state.status = 'playing'
  game.state.pendingRequests = []
  game.state.players.forEach((player) => { player.characterId = null })
  return game
}

describe('武将册第66批', () => {
  it('十名武将全部注册，且每个技能都挂有运行时', () => {
    const characters = names.map((name) => ALL_CHARACTERS.find((character) => character.name === name))
    expect(characters.every(Boolean)).toBe(true)
    expect(new Set(characters.map((character) => character!.id)).size).toBe(10)
    for (const character of characters) {
      for (const skill of character!.skills) expect(getSkillRuntime(skill.id), `${character!.name}【${skill.name}】`).toBeDefined()
    }
  })

  it('许攸【迁附】按阴阳提供颜色对应的转化，并仅在成功使用后切换状态', () => {
    const game = gameFor('b66-qianfu-state')
    const owner = game.state.players[0]!
    owner.characterId = 'mou-xuyou-b66'
    game.state.currentPlayerId = owner.id
    game.state.phase = 'play'
    const black = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.color === 'black')!
    const red = game.state.zones.drawPile.find((cardId) => game.state.cards[cardId]?.color === 'red')!
    moveCard(game.state, black, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    moveCard(game.state, red, { kind: 'drawPile' }, { kind: 'hand', playerId: owner.id })
    const runtime = getSkillRuntime(QIANFU)!
    expect(runtime.viewAs?.(game.state, owner.id).map((entry) => [entry.cardId, entry.asCardName]))
      .toContainEqual([black, '过河拆桥'])
    expect(runtime.viewAs?.(game.state, owner.id).map((entry) => [entry.cardId, entry.asCardName]))
      .not.toContainEqual([red, '火攻'])
    game.dispatch('CardUsed', { cardId: black }, { sourceId: owner.id as PlayerId, sourceSkillId: QIANFU })
    expect(game.state.conversionStates?.[`${owner.id}:${QIANFU}`]).toBe('yin')
    expect(runtime.viewAs?.(game.state, owner.id).map((entry) => [entry.cardId, entry.asCardName]))
      .toContainEqual([red, '火攻'])
  })

  it('盟势交换体力时遵守双方体力上限并派发公共事件', () => {
    const game = gameFor('b66-hp-exchange')
    const [left, right] = game.state.players
    left!.maxHp = 2
    left!.hp = 2
    right!.maxHp = 5
    right!.hp = 4
    const events: string[] = []
    game.events.on('HpExchanged', (context) => events.push(context.event.name))
    exchangeHp(game as never, left!.id as PlayerId, right!.id as PlayerId, 'test')
    expect([left!.hp, right!.hp]).toEqual([2, 2])
    expect(events).toEqual(['HpExchanged'])
  })

  it('鲁肃【盟势】只在结束阶段发起，先失去差值体力，再交换所选角色体力', () => {
    const game = gameFor('b66-mengshi-finish')
    const [owner, left, right] = game.state.players
    owner!.characterId = 'mou-lusu-b66'
    owner!.hp = 3
    left!.hp = 2
    right!.hp = 4
    game.state.currentPlayerId = owner!.id
    game.emit('PhaseStart', { playerId: owner!.id, phase: 'finish' })
    ;(game as unknown as { settle(): void }).settle()
    let request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-option', skillId: 'mengshi-mou-lusu-b66', playerId: owner!.id })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { optionId: 'yes' } })
    request = game.state.pendingRequests.at(-1)!
    expect(request).toMatchObject({ kind: 'choose-targets', min: 2, max: 2 })
    game.respond({ requestId: request.id, playerId: owner!.id, payload: { targetIds: [left!.id, right!.id] } })
    expect(owner!.hp).toBe(1)
    expect([left!.hp, right!.hp]).toEqual([4, 2])
    expect(owner!.usedLimitedSkills).toContain('mengshi-mou-lusu-b66')
  })
})
