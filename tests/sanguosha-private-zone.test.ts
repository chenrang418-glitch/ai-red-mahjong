import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import {
  closePrivateZone, findPrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards,
} from '@/sanguosha/engine/private-zone'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 私有暂存牌区。
 *
 * 它存在的唯一理由是：处理区**完全公开**，把牌塞进去再让前端别显示，
 * 网络包里照样是明文。所以这里最重要的两条是
 * 「牌张守恒把它算在内」和「别人的视图里连键都不出现」。
 */

function gameWith(seed = 'private-zone'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'zhangfei'
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  return game
}

/** 把 p0 的第一张手牌扣进一个私有区，返回牌 id。 */
function stash(game: SanguoshaGame, zoneId = 'test-zone'): string {
  openPrivateZone(game.state, zoneId, 'p0', 'test')
  const cardId = game.state.players[0].zones.hand[0]
  moveIntoPrivateZone(game.state, cardId, { kind: 'hand', playerId: 'p0' }, zoneId)
  return cardId
}

describe('私有区是正式牌区', () => {
  it('牌真的离开手牌，进了私有区', () => {
    const game = gameWith()
    const cardId = stash(game)
    expect(game.state.players[0].zones.hand, '不能在手牌里留一份').not.toContain(cardId)
    expect(privateZoneCards(game.state, 'test-zone')).toEqual([cardId])
    assertGameInvariants(game.state)
  })

  it('计入牌张守恒——不是复制出来的牌面', () => {
    const game = gameWith()
    stash(game)
    expect(() => assertCardConservation(game.state)).not.toThrow()
  })

  it('过一遍 JSON 之后还在——Durable Object 休眠要靠它', () => {
    const game = gameWith()
    const cardId = stash(game)
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.state)))
    expect(privateZoneCards(restored.state, 'test-zone')).toEqual([cardId])
    assertGameInvariants(restored.state)
  })

  it('取牌出来之后区还在，牌到了新位置', () => {
    const game = gameWith()
    const cardId = stash(game)
    moveOutOfPrivateZone(game.state, cardId, 'test-zone', { kind: 'discardPile' })
    expect(privateZoneCards(game.state, 'test-zone')).toEqual([])
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('关区时剩下的牌进弃牌堆，不会凭空销毁', () => {
    const game = gameWith()
    const cardId = stash(game)
    const leftover = closePrivateZone(game.state, 'test-zone')

    expect(leftover).toEqual([cardId])
    expect(findPrivateZone(game.state, 'test-zone'), '区要真的关掉').toBeUndefined()
    expect(game.state.zones.discardPile).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('可以指定关区时把牌退回原处', () => {
    const game = gameWith()
    const cardId = stash(game)
    closePrivateZone(game.state, 'test-zone', { kind: 'hand', playerId: 'p0' })
    expect(game.state.players[0].zones.hand).toContain(cardId)
    assertGameInvariants(game.state)
  })

  it('重复建同一个 id 是调用方的 bug，直接报错', () => {
    const game = gameWith()
    openPrivateZone(game.state, 'dup', 'p0', 'test')
    expect(() => openPrivateZone(game.state, 'dup', 'p0', 'test')).toThrow(/重复创建/)
  })

  it('关一个不存在的区是安全的空操作', () => {
    const game = gameWith()
    expect(closePrivateZone(game.state, '不存在')).toEqual([])
  })

  it('主人必须真实存在', () => {
    const game = gameWith()
    expect(() => openPrivateZone(game.state, 'bad', 'p99', 'test')).toThrow(/主人不存在/)
  })
})

describe('私有区的可见性', () => {
  it('主人自己能看到真实牌', () => {
    const game = gameWith()
    const cardId = stash(game)
    const view = game.viewFor('p0')
    const self = view.players.find((player) => player.id === 'p0')!
    expect(self.privateCards?.['test-zone']?.map((card) => card.id)).toEqual([cardId])
  })

  it('别人的视图里 privateCards 是 null，连键都没有', () => {
    const game = gameWith()
    stash(game)
    for (const viewerId of ['p1', 'p2', 'p3', 'p4']) {
      const view = game.viewFor(viewerId)
      const owner = view.players.find((player) => player.id === 'p0')!
      expect(owner.privateCards, `${viewerId} 不该拿到别人的私有区`).toBeNull()
    }
  })

  it('别人的视图里搜不到那张牌的任何信息', () => {
    const game = gameWith()
    const cardId = stash(game)
    const card = game.state.cards[cardId]
    for (const viewerId of ['p1', 'p2', 'p3', 'p4']) {
      const serialized = JSON.stringify(game.viewFor(viewerId))
      expect(serialized, `${viewerId} 不该看到 cardId`).not.toContain(cardId)
    }
    // 牌名花色这类信息牌堆里本来就有别的同名牌，所以只对 id 做强断言；
    // 「结构上拿不到」由上一条的 privateCards === null 保证
    expect(card.name.length).toBeGreaterThan(0)
  })

  it('自己的视图能恢复出扣了哪张牌——断线重连要靠它', () => {
    const game = gameWith()
    const cardId = stash(game)
    const view = game.viewFor('p0')
    const self = view.players.find((player) => player.id === 'p0')!
    const recovered = self.privateCards?.['test-zone']?.[0]
    expect(recovered?.id).toBe(cardId)
    expect(recovered?.name).toBe(game.state.cards[cardId].name)
    expect(recovered?.suit).toBe(game.state.cards[cardId].suit)
  })
})
