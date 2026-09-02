import { describe, expect, it } from 'vitest'
import { fixedTargetAction, initialTargetIds } from '@/sanguosha/presentation/targetSelection'
import type { LegalAction } from '@/sanguosha/engine/actions'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { instantTrickActions } from '@/sanguosha/engine/cards/tricks'

function action(name: string, targets: string[], fixed = false): LegalAction {
  return {
    id: `play:c1:${name}:${targets.join(',')}`, kind: 'use-card', playerId: 'p0', label: name,
    cardIds: ['c1'], targetIds: targets, targetMin: targets.length, targetMax: targets.length,
    asCardName: name, ...(fixed ? { targetMode: 'fixed' as const } : {}),
  }
}

describe('固定全体目标牌的牌桌交互', () => {
  it.each(['南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登'])('%s 可直接采用引擎给出的全部目标', (name) => {
    const all = action(name, ['p0', 'p1', 'p2'], true)
    expect(fixedTargetAction([all], 'c1')).toBe(all)
  })

  it('杀、铁索等玩家可选目标的牌不会自动发出', () => {
    expect(fixedTargetAction([action('杀', ['p1'])], 'c1')).toBeNull()
    expect(fixedTargetAction([action('铁索连环', ['p1']), action('铁索连环', ['p2'])], 'c1')).toBeNull()
  })

  it('同一实体牌有原用途和转化用途时，先让玩家选用途', () => {
    expect(fixedTargetAction([action('南蛮入侵', ['p1', 'p2'], true), action('杀', ['p1'])], 'c1')).toBeNull()
    expect(fixedTargetAction([action('南蛮入侵', ['p1', 'p2'], true), action('杀', ['p1'])], 'c1', '南蛮入侵')?.targetIds)
      .toEqual(['p1', 'p2'])
  })

  it('规则引擎只给真正的全体锦囊添加固定目标标记', () => {
    const game = new SanguoshaGame({
      seed: 'fixed-target-actions',
      setup: { mode: 'identity', generalChoices: 1, players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })) },
    })
    for (const name of ['南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登']) {
      const card = Object.values(game.state.cards).find((candidate) => candidate.name === name)!
      expect(instantTrickActions(game.state, 'p0', card.id)).toHaveLength(1)
      expect(instantTrickActions(game.state, 'p0', card.id)[0].targetMode).toBe('fixed')
    }
    const chain = Object.values(game.state.cards).find((candidate) => candidate.name === '铁索连环')!
    expect(instantTrickActions(game.state, 'p0', chain.id).some((candidate) => candidate.targetMode === 'fixed')).toBe(false)
  })
})

/**
 * 点击即发改成「预选目标 + 确定」。
 *
 * 用户反馈：南蛮入侵、桃园结义这类牌点一下就飞出去，手一抖就是一张牌。
 * 现在选中只把目标全部标红，仍然要按确定才真的用出去。
 */
describe('全体锦囊选中时预选全部目标', () => {
  it.each(['南蛮入侵', '万箭齐发', '桃园结义', '五谷丰登'])('%s 选中就整套标红', (name) => {
    const game = new SanguoshaGame({
      seed: 'fixed-preselect',
      setup: { mode: 'identity', generalChoices: 1, players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })) },
    })
    const card = Object.values(game.state.cards).find((candidate) => candidate.name === name)!
    const actions = instantTrickActions(game.state, 'p0', card.id)
    expect(initialTargetIds(actions, card.id), '预选的就是引擎给的那一整套')
      .toEqual(actions[0].targetIds)
    expect(initialTargetIds(actions, card.id).length).toBeGreaterThan(0)
  })

  it('玩家自己选目标的牌不预选任何人', () => {
    expect(initialTargetIds([action('杀', ['p1'])], 'c1')).toEqual([])
    expect(initialTargetIds([action('铁索连环', ['p1']), action('铁索连环', ['p2'])], 'c1')).toEqual([])
  })

  it('同一张牌有多种用途时，按选中的用途预选', () => {
    const actions = [action('南蛮入侵', ['p1', 'p2'], true), action('杀', ['p1'])]
    expect(initialTargetIds(actions, 'c1'), '还没选用途时不预选').toEqual([])
    expect(initialTargetIds(actions, 'c1', '南蛮入侵')).toEqual(['p1', 'p2'])
    expect(initialTargetIds(actions, 'c1', '杀')).toEqual([])
  })
})
