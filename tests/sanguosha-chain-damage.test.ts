import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

function game(seed: string): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const result = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  result.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'zhangfei'
  })
  result.start()
  return result
}

describe('铁索连环属性伤害公用链路', () => {
  it.each(['fire', 'thunder'] as const)('%s 伤害按座次传导且只传一次', (nature) => {
    const current = game(`chain-${nature}`)
    for (const id of ['p1', 'p3', 'p4']) current.state.players.find((player) => player.id === id)!.chained = true
    const order: string[] = []
    current.events.on('Damaged', (context) => order.push(context.event.targetId!))

    current.damage({ sourceId: 'p0', targetId: 'p3', amount: 1, nature, cardName: nature === 'fire' ? '火攻' : '雷击' })

    expect(order).toEqual(['p3', 'p4', 'p1'])
    expect(['p1', 'p3', 'p4'].map((id) => current.state.players.find((player) => player.id === id)!.hp)).toEqual([3, 3, 3])
    expect(current.state.players.filter((player) => ['p1', 'p3', 'p4'].includes(player.id)).every((player) => !player.chained)).toBe(true)
    expect(current.state.damageChain).toBeNull()
  })

  it('普通伤害不传导，死亡会解除横置状态', () => {
    const current = game('chain-normal-death')
    current.state.players[1].chained = true
    current.state.players[3].chained = true
    current.damage({ sourceId: 'p0', targetId: 'p1', amount: 1, nature: 'normal' })
    expect(current.state.players[3].hp).toBe(4)
    expect(current.state.players[1].chained).toBe(true)

    current.state.players[1].hp = 1
    for (const owner of current.state.players) owner.zones.hand = owner.zones.hand.filter((id) => !['桃', '酒'].includes(current.state.cards[id].name))
    current.damage({ sourceId: 'p0', targetId: 'p1', nature: 'normal' })
    expect(current.state.players[1].alive).toBe(false)
    expect(current.state.players[1].chained).toBe(false)
  })
})
