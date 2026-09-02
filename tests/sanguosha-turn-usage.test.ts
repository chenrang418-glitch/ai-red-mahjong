import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { usedThisTurn } from '@/sanguosha/engine/turn-usage'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 「每回合限一次」的统一记账。
 *
 * 原来每个技能各自记在 `usedLimitedSkills` 里、各自注册 TurnEnd 重置，
 * 散在 5 个文件里。**华佗【青囊】漏了重置**，用过一次之后那条记录永远留着，
 * 「出牌阶段限一次」实际变成了「一局一次」。
 *
 * 现在改成 `turnUsedSkills` + `turn.ts` 统一清空，技能不再各自重置。
 */

function gameWith(characterIds: string[], seed = 'turn-usage'): SanguoshaGame {
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

/** 把回合推到下一个人再绕回来，触发一次真正的 TurnEnd。 */
function passTurn(game: SanguoshaGame): void {
  let guard = 0
  const started = game.state.turnNumber
  while (game.state.turnNumber === started) {
    if (guard++ > 40) throw new Error('回合没有推进')
    if (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
      continue
    }
    game.advancePhase()
  }
}

describe('每回合限一次会在回合结束被清掉', () => {
  it('华佗【青囊】下个回合还能再用', () => {
    // 这条钉住的就是那个 bug：青囊原来用过一次就永久失效
    const game = gameWith(['huatuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[1].hp = 1

    const first = game.legalActions('p0').filter((action) => action.id.startsWith('skill:qingnang'))
    expect(first.length, '第一次应当能发动青囊').toBeGreaterThan(0)

    // 直接标记为已用，然后走完一个回合
    game.state.players[0].turnUsedSkills.push('qingnang')
    expect(usedThisTurn(game.state, 'p0', 'qingnang')).toBe(true)
    expect(game.legalActions('p0').filter((action) => action.id.startsWith('skill:qingnang')).length, '同回合内不能再用').toBe(0)

    passTurn(game)

    expect(usedThisTurn(game.state, 'p0', 'qingnang'), '回合结束后记录应当被清掉').toBe(false)
  })

  it('限定技和每回合限次是两个不同的列表，不会互相清掉', () => {
    const game = gameWith(['huatuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    const owner = game.state.players[0]
    // 一局一次的记录放 usedLimitedSkills，回合结束不该动它
    owner.usedLimitedSkills.push('some-limited-skill')
    owner.turnUsedSkills.push('qingnang')

    passTurn(game)

    expect(owner.usedLimitedSkills, '限定技记录必须留着').toContain('some-limited-skill')
    expect(owner.turnUsedSkills, '每回合限次必须清空').toEqual([])
  })

  it('回合结束清的是全场，不只是当前回合角色', () => {
    // 回合外也能发动的技能（急救这类）同样按回合计数，只清当前角色会漏
    const game = gameWith(['huatuo', 'zhangfei', 'zhangfei', 'zhangfei', 'zhangfei'])
    game.state.players[2].turnUsedSkills.push('whatever')
    passTurn(game)
    expect(game.state.players[2].turnUsedSkills).toEqual([])
  })
})
