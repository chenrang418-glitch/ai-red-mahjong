import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import {
  HUANG_WUDIE_FUXIE,
  HUANG_WUDIE_SHOUXING,
  HUANG_WUDIE_SHUANGRUI,
  MOU_HUCHEER_KONGWU,
} from '@/sanguosha/data/characters/historical-batch89'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

describe('第89批目标回复的缺失目标防护', () => {
  it('缺失目标时不创建后续请求或队列项', () => {
    const game = new SanguoshaGame({
      seed: 'b89-invalid-target-input',
      setup: {
        mode: 'identity',
        generalChoices: 1,
        players: Array.from({ length: 5 }, (_, index) => ({
          id: `b89-invalid-${index}`,
          nickname: `玩家${index}`,
          isHuman: true,
        })),
      },
    })
    const ownerId = game.state.players[0]!.id
    const originalRequests = game.state.pendingRequests.length
    const originalQueue = [...game.state.skillQueue]
    const cases = [
      { skillId: MOU_HUCHEER_KONGWU, step: 'target' },
      { skillId: HUANG_WUDIE_SHUANGRUI, step: 'target' },
      { skillId: HUANG_WUDIE_SHOUXING, step: 'target' },
      { skillId: HUANG_WUDIE_FUXIE, step: 'target' },
    ] as const

    for (const { skillId, step } of cases) {
      const runtime = getSkillRuntime(skillId)
      expect(runtime?.resume, `${skillId} 应有 resume`).toBeTypeOf('function')
      runtime!.resume!(game as never, ownerId, { step, data: {} } as never, { payload: { targetIds: [] } } as never)
    }

    expect(game.state.pendingRequests).toHaveLength(originalRequests)
    expect(game.state.skillQueue).toEqual(originalQueue)
  })
})
