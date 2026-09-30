import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { finishPhysicalCard } from '@/sanguosha/engine/cards/host'
import type { PhysicalCard } from '@/sanguosha/engine/types'

describe('虚拟牌结算生命周期', () => {
  it('AfterCardUse 处理期间仍可读取虚拟牌，事件结束后才销毁', () => {
    const game = new SanguoshaGame({
      seed: 'virtual-card-lifecycle',
      setup: {
        mode: 'identity',
        generalChoices: 1,
        players: [
          { id: 'p0', nickname: '玩家0', isHuman: true },
          { id: 'p1', nickname: '玩家1', isHuman: false },
          { id: 'p2', nickname: '玩家2', isHuman: false },
          { id: 'p3', nickname: '玩家3', isHuman: false },
          { id: 'p4', nickname: '玩家4', isHuman: false },
        ],
      },
    })
    const cardId = 'virtual:test:card'
    const card: PhysicalCard = {
      id: cardId,
      ruleset: 'ruleset-v1',
      expansion: 'standard',
      name: '杀',
      suit: 'heart',
      rank: 7,
      color: 'red',
      category: 'basic',
      virtual: true,
      sourceSkillId: 'test',
    }
    game.state.cards[cardId] = card
    game.state.zones.processingArea.push(cardId)

    let visibleDuringAfterUse = false
    let virtualFlagDuringAfterUse = false
    game.events.on('AfterCardUse', (context) => {
      visibleDuringAfterUse = game.state.cards[cardId] === card
      virtualFlagDuringAfterUse = (context.event.payload as { virtual?: boolean }).virtual === true
    })

    finishPhysicalCard(game, 'p0', cardId, ['p1'], false, '杀')

    expect(visibleDuringAfterUse).toBe(true)
    expect(virtualFlagDuringAfterUse).toBe(true)
    expect(game.state.cards[cardId]).toBeUndefined()
    expect(game.state.zones.processingArea).not.toContain(cardId)
  })
})
