import { describe, expect, it } from 'vitest'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'

describe('审计防护：方遒未知响应数据', () => {
  it.each([null, undefined, {}, { optionId: 'invalid' }])('无效回答 %j 不展示预测或消耗限定标记', (payload) => {
    const game = new SanguoshaGame({ seed: 'audit-fangqiu-input', setup: {
      mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: true })),
    } })
    const general = ALL_CHARACTERS.find((entry) => entry.id === 'you-zhuge-liang-b55')
    if (!general) throw new Error('友诸葛亮注册定义不存在')
    const skillId = general.skills.find((skill) => skill.name === '方遒')!.id
    const runtime = getSkillRuntime(skillId)!
    const owner = game.state.players[0]!
    owner.characterId = general.id
    game.state.status = 'playing'
    const forecast = { round: 1, count: 4, mode: 'category', value: 'basic', verified: 0, correct: 0, draws: 0, revealed: false }
    Object.assign(game.state, { b55YanceForecast: { [owner.id]: forecast } })
    runtime.startQueued!(game, owner.id, { skillId, ownerId: owner.id, step: 'show-forecast', data: {} })
    const resolution = game.state.skillResolution!
    expect(resolution.skillId).toBe(skillId)
    const before = [...owner.usedLimitedSkills]
    // 隔离检查 runtime 的 unknown 边界；正式 respond 的请求校验另有现有测试。
    expect(() => runtime.resume!(game, owner.id, resolution,
      { requestId: resolution.requestId, playerId: owner.id, payload })).not.toThrow()
    expect(forecast.revealed).toBe(false)
    expect(owner.usedLimitedSkills).toEqual(before)
  })
})
