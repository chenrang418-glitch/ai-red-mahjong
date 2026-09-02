import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 失去体力的统一入口。
 *
 * 这段逻辑原来被复制了两份（黄盖【苦肉】内联一份、夏侯惇【刚烈】旁边一份），
 * 而**苦肉那一份漏了濒死判断**：1 点体力发动苦肉之后 hp 变成 0、`dying` 是 null、
 * `alive` 仍是 true、也没有任何待处理请求——玩家卡在「0 血活着」的非法状态，
 * 既不会被救也不会死。
 *
 * 现在两处都走 `engine/hp.ts` 的 `loseHp`。这几条钉住的就是那个洞。
 */

function gameWith(characterIds: string[], seed = 'lose-hp'): SanguoshaGame {
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

describe('黄盖【苦肉】', () => {
  it('体力充足时只是掉一点血并摸两张', () => {
    const game = gameWith(['huanggai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    const hpBefore = owner.hp
    const handBefore = owner.zones.hand.length

    const action = game.legalActions('p0').find((candidate) => candidate.id === 'skill:kurou')
    expect(action, '苦肉应当是一条可点的动作').toBeTruthy()
    game.act('p0', action!.id)

    expect(owner.hp).toBe(hpBefore - 1)
    expect(owner.zones.hand.length).toBe(handBefore + 2)
    expect(game.state.dying, '还有体力就不该濒死').toBeNull()
    assertGameInvariants(game.state)
  })

  it('体力只剩一点时必须进入濒死，不能卡在 0 血活着', () => {
    const game = gameWith(['huanggai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    owner.hp = 1

    const action = game.legalActions('p0').find((candidate) => candidate.id === 'skill:kurou')
    game.act('p0', action!.id)

    expect(owner.hp).toBeLessThanOrEqual(0)
    // 要么正在被救（有濒死状态或求桃请求），要么已经死了——绝不能是「0 血还活着且无事发生」
    const rescuing = game.state.dying !== null || game.state.pendingRequests.some((request) => request.kind === 'rescue')
    expect(rescuing || !owner.alive, '0 血必须进入濒死或死亡').toBe(true)
    assertGameInvariants(game.state)
  })
})

describe('失去体力不是受到伤害', () => {
  it('苦肉不会触发曹操【奸雄】这类「受到伤害后」的技能', () => {
    // 奸雄挂在 Damaged 上；失去体力只发 LoseHp，不该把它叫起来
    const game = gameWith(['huanggai', 'caocao', 'zhangfei', 'zhangfei', 'zhangfei'])
    const damaged: string[] = []
    game.events.on('Damaged', (context) => { damaged.push(String(context.event.targetId)) })

    const action = game.legalActions('p0').find((candidate) => candidate.id === 'skill:kurou')
    game.act('p0', action!.id)

    expect(damaged, '苦肉不该产生任何伤害事件').toEqual([])
    assertGameInvariants(game.state)
  })

  it('失去体力会发 LoseHp 事件，战报和表现层据此显示', () => {
    const game = gameWith(['huanggai', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const lost: Array<{ playerId: unknown; amount: unknown }> = []
    game.events.on('LoseHp', (context) => {
      const payload = context.event.payload as { playerId: unknown; amount: unknown }
      lost.push({ playerId: payload.playerId, amount: payload.amount })
    })

    const action = game.legalActions('p0').find((candidate) => candidate.id === 'skill:kurou')
    game.act('p0', action!.id)

    expect(lost).toEqual([{ playerId: 'p0', amount: 1 }])
  })
})
