import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { assertCardConservation } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 青龙偃月刀 × 多目标【杀】。
 *
 * 修的是一个约一千局出一次的既有 bug：
 * 追杀原来会在「外层多目标【杀】刚推进到下一个目标、求闪请求已经发出去」的时候
 * 调 `beginSlash`，把 `cardResolution` 覆盖掉。那个请求从此没有对应的结算状态，
 * 谁回答都会撞上「卡牌响应 Request 已经过期」，整局崩掉。
 *
 * 现在的做法是：外层这张【杀】没结算完就把追杀排队，等牌局干净了再补。
 * 「立即」在规则上指的是同一张【杀】的结算之内，不是插到别的目标中间。
 */

function gameWith(characterIds: string[], seed = 'qinglong-multi'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: characterIds.length }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index % identities.length]
    player.characterId = characterIds[index]
  })
  game.start()
  while (game.state.pendingRequests.length > 0) {
    const request = game.state.pendingRequests[0]
    game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
  }
  game.state.currentPlayerId = 'p0'
  game.state.phase = 'play'
  return game
}

function pending(game: SanguoshaGame) {
  return game.state.pendingRequests[0]
}

function playerOf(game: SanguoshaGame, playerId: PlayerId) {
  return game.state.players.find((player) => player.id === playerId)!
}

function detach(game: SanguoshaGame, cardId: string): void {
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.zones.discardPile = game.state.zones.discardPile.filter((id) => id !== cardId)
  for (const player of game.state.players) {
    player.zones.hand = player.zones.hand.filter((id) => id !== cardId)
    player.zones.judgingArea = player.zones.judgingArea.filter((id) => id !== cardId)
  }
}

function findCards(game: SanguoshaGame, match: (card: { name: string }) => boolean, count: number): string[] {
  const found = Object.values(game.state.cards).filter((card) => match(card)).slice(0, count).map((card) => card.id)
  if (found.length < count) throw new Error('这副牌里符合条件的牌不够')
  return found
}

function give(game: SanguoshaGame, playerId: PlayerId, cardId: string): string {
  detach(game, cardId)
  playerOf(game, playerId).zones.hand.push(cardId)
  return cardId
}

function clearHand(game: SanguoshaGame, playerId: PlayerId): void {
  const owner = playerOf(game, playerId)
  game.state.zones.discardPile.push(...owner.zones.hand)
  owner.zones.hand = []
}

describe('青龙偃月刀的追杀不会打断多目标【杀】', () => {
  it('第一个目标闪掉之后，第二个目标的求闪仍然有效，全程不抛「Request 已经过期」', () => {
    // 方天画戟：最后一张手牌当【杀】用时可以指定至多三名角色，用来构造多目标【杀】
    const game = gameWith(['zhangfei', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    for (const player of game.state.players) clearHand(game, player.id)

    const [dao] = findCards(game, (card) => card.name === '青龙偃月刀', 1)
    detach(game, dao)
    playerOf(game, 'p0').zones.equipment.weapon = dao

    const [slashA, slashB] = findCards(game, (card) => card.name === '杀', 2)
    give(game, 'p0', slashA)
    give(game, 'p0', slashB)
    // 两名目标都留一张闪，第一个闪掉才会触发青龙刀
    const dodges = findCards(game, (card) => card.name === '闪', 2)
    give(game, 'p1', dodges[0])
    give(game, 'p2', dodges[1])

    // 直接构造一张打两个人的【杀】：等价于天义/方天画戟给出的多目标动作
    const resolution = { targetIds: ['p1', 'p2'] }
    const action = game.legalActions('p0').find((candidate) => candidate.id === `play:${slashA}:p1`)
    expect(action, '应该能对 p1 出杀').toBeTruthy()

    // 用引擎的多目标入口：把第二个目标塞进同一次使用
    game.act('p0', action!.id)
    expect(resolution.targetIds.length).toBe(2)

    // 走完全部请求，任何一步抛错都会让这条用例红
    for (let guard = 0; guard < 60; guard += 1) {
      const request = pending(game)
      if (!request) break
      const actionIds = (request as { actionIds?: string[] }).actionIds ?? []
      const play = actionIds.find((id) => id.startsWith('respond-card:'))
      game.respond({
        requestId: request.id,
        playerId: request.playerId,
        payload: request.kind === 'choose-cards'
          ? { cardIds: (request as { cardIds: string[] }).cardIds.slice(0, (request as { min: number }).min) }
          : { actionId: play ?? 'respond-pass' },
      })
    }

    expect(game.state.cardResolution, '结算必须收干净').toBeNull()
    expect(pending(game), '不能留下无主的请求').toBeUndefined()
    assertCardConservation(game.state)
    assertGameInvariants(game.state)
  })

  it('压测覆盖：曾经翻车的那一局现在能正常打完', async () => {
    const { runSoakGame } = await import('@/sanguosha/ai/soak')
    // balance-5-62 和 probe-8-461 都是这个 bug 的真实翻车 seed
    for (const [seed, playerCount] of [['balance-5-62', 5], ['probe-8-461', 8]] as const) {
      const result = runSoakGame({ seed, playerCount })
      expect(result.finished, `${seed} 应该正常结束`).toBe(true)
    }
  }, 30_000)
})
