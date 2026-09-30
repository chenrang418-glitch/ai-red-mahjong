import { describe, expect, it } from 'vitest'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getDistance } from '@/sanguosha/engine/distance'
import { moveCard } from '@/sanguosha/engine/zones'

function fixture() {
  const game = new SanguoshaGame({ seed: 'quyi-response-lock', setup: {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  } })
  game.state.status = 'playing'
  game.state.phase = 'play'
  game.state.currentPlayerId = 'p0'
  game.state.normalTurnPlayerId = 'p0'
  game.state.turnNumber = 1
  game.state.players.forEach((player, index) => {
    player.characterId = index === 0 ? 'quyi' : 'caocao'
    player.hp = 3
    player.maxHp = 4
  })
  return game
}

function placeNamedCard(game: SanguoshaGame, playerId: string, name: string): string {
  const cardId = game.state.zones.drawPile[0]!
  Object.assign(game.state.cards[cardId]!, { name, category: name === '无懈可击' ? 'trick' : 'basic' })
  moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  return cardId
}

describe('麴义【伏骑】完整响应封锁', () => {
  it('正式注册技能描述与运行时，且只封锁距离1的其他角色', () => {
    const character = getCharacter('quyi')!
    expect(character.skills.find((skill) => skill.id === 'fuqi')?.description)
      .toContain('与麹义距离为1的其他角色不能使用或打出牌响应麹义使用的牌')
    const game = fixture()
    expect(getDistance(game.state, 'p0', 'p1')).toBe(1)
    expect(getDistance(game.state, 'p0', 'p2')).toBe(2)
  })

  it('相邻旁观者不能对麴义使用的锦囊打无懈，非相邻目标仍可响应', () => {
    const game = fixture()
    placeNamedCard(game, 'p1', '无懈可击')
    const targetNullification = placeNamedCard(game, 'p2', '无懈可击')
    placeNamedCard(game, 'p4', '无懈可击')
    const targetCard = placeNamedCard(game, 'p2', '闪')

    expect(game.beginVirtualTrick({ sourceId: 'p0', targetId: 'p2', cardName: '过河拆桥', sourceSkillId: '伏骑验证' })).toBe(true)
    const request = game.state.pendingRequests[0]
    expect(request).toMatchObject({ kind: 'respond-card', playerId: 'p2' })
    expect((request as { actionIds: string[] }).actionIds).toContain(`respond-nullification:${targetNullification}`)

    game.respond({ requestId: request!.id, playerId: 'p2', payload: { actionId: 'respond-pass' } })
    expect(game.state.pendingRequests[0]).toMatchObject({ kind: 'choose-cards', playerId: 'p0' })
    expect(game.state.pendingRequests.some((pending) => pending.playerId === 'p1' || pending.playerId === 'p4')).toBe(false)
    expect(game.state.players[2]!.zones.hand).toContain(targetCard)
  })
})
