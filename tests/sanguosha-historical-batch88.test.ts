import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { getCharacter } from '@/sanguosha/data/characters/standard'
import { HISTORICAL_BATCH88_CHARACTERS, MOU_MASU_CHENGCE, MOU_MASU_XINZHAN } from '@/sanguosha/data/characters/historical-batch88'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { moveCard } from '@/sanguosha/engine/zones'

describe('第88批：谋·马谡', () => {
  it('按武将册注册为蜀国4体力双技能武将', () => {
    expect(HISTORICAL_BATCH88_CHARACTERS).toHaveLength(1)
    expect(getCharacter('mou-masu-b88')).toMatchObject({
      name: '谋·马谡', kingdom: 'shu', maxHp: 4,
      skills: [expect.objectContaining({ id: MOU_MASU_CHENGCE }), expect.objectContaining({ id: MOU_MASU_XINZHAN })],
    })
  })

  it('呈策具备轮开始触发和可续接的选牌流程，心战具备事件追踪及猜错决斗入口', () => {
    const chengce = getSkillRuntime(MOU_MASU_CHENGCE)!
    const xinZhan = getSkillRuntime(MOU_MASU_XINZHAN)!
    expect(chengce.triggers?.some((trigger) => trigger.event === 'RoundStart')).toBe(true)
    expect(chengce.startQueued).toBeTypeOf('function')
    expect(chengce.resume).toBeTypeOf('function')
    expect(xinZhan.triggers?.some((trigger) => trigger.event === 'CardUsed')).toBe(true)
    expect(xinZhan.triggers?.some((trigger) => trigger.event === 'CardResponded')).toBe(true)
    expect(xinZhan.triggers?.some((trigger) => trigger.event === 'CardResolved')).toBe(true)
    expect(xinZhan.startQueued).toBeTypeOf('function')
    expect(xinZhan.resume).toBeTypeOf('function')
    expect(xinZhan.globalViewAs).toBeTypeOf('function')
  })

  it('伤害牌分支只把目标随机选中的非伤害手牌限时视为杀', () => {
    const game = new SanguoshaGame({ seed: 'b88-slash-conversion', setup: { mode: 'identity', generalChoices: 1,
      players: Array.from({ length: 5 }, (_, index) => ({ id: `b88-${index}`, nickname: `玩家${index}`, isHuman: true })) } })
    const target = game.state.players[1]!
    const chosen = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '桃')!
    const unmarked = game.state.zones.drawPile.find((id) => game.state.cards[id]?.name === '杀')!
    moveCard(game.state, chosen, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    moveCard(game.state, unmarked, { kind: 'drawPile' }, { kind: 'hand', playerId: target.id })
    const state = game.state as typeof game.state & { paperMouMaSu: { slashCards: Record<string, string> } }
    state.paperMouMaSu = { slashCards: { [chosen]: target.id } }
    expect(getSkillRuntime(MOU_MASU_XINZHAN)!.globalViewAs!(game.state, game.state.players[0]!.id, target.id)).toEqual([
      { cardId: chosen, asCardName: '杀', label: '【呈策】：将此牌当【杀】使用' },
    ])
  })
})
