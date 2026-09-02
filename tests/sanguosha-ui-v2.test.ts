import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { seatSlotsForPlayerCount } from '@/sanguosha/composables/useSgsSeatLayout'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { buildPresentationEvent, skillDisplayName } from '@/sanguosha/engine/presentation'
import { getAttackRange, getDistance } from '@/sanguosha/engine/distance'
import type { GameEvent } from '@/sanguosha/engine/events'
import type { GameSetup } from '@/sanguosha/engine/types'

function setup(count: number): GameSetup {
  return { mode: 'identity', generalChoices: 1, players: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, nickname: index ? `电脑${index}` : '你', isHuman: index === 0 })) }
}

describe('三国杀牌桌 V2 座位', () => {
  it.each([
    [5, ['self', 'right-bottom', 'right-top', 'top-left', 'left-bottom']],
    [6, ['self', 'right-bottom', 'right-top', 'top-center', 'left-top', 'left-bottom']],
    [7, ['self', 'right-bottom', 'right-top', 'top-right', 'top-left', 'left-top', 'left-bottom']],
    [8, ['self', 'right-bottom', 'right-top', 'top-right', 'top-center', 'top-left', 'left-top', 'left-bottom']],
  ])('%i 人局从下家到上家保持顺时针空间顺序', (count, expected) => {
    expect(seatSlotsForPlayerCount(count as number)).toEqual(expected)
  })

  it('PlayerView 距离和攻击范围完全采用 Engine 结果', () => {
    const game = new SanguoshaGame({ seed: 'ui-distance', setup: setup(5) })
    game.state.players.forEach((player) => { player.characterId = 'machao' })
    game.start()
    let view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p2')!.distanceFromViewer).toBe(getDistance(game.state, 'p0', 'p2'))
    expect(view.players.find((player) => player.id === 'p0')!.attackRange).toBe(getAttackRange(game.state, 'p0'))
    game.state.players[1].alive = false
    game.state.players[1].hp = 0
    view = game.viewFor('p0')
    expect(view.players.find((player) => player.id === 'p1')!.distanceFromViewer).toBeNull()
    expect(view.players.find((player) => player.id === 'p2')!.distanceFromViewer).toBe(getDistance(game.state, 'p0', 'p2'))
  })

  it('移动端不再隐藏装备或裁切技能区', () => {
    // 原来靠「最后一个 @media (max-width: 820px) 块」来定位，后面一加新的移动端规则
    // 就会定位到别的块上。改成直接找这几条规则本身，位置怎么变都不影响。
    const source = readFileSync('src/sanguosha/components/SgsSeat.vue', 'utf8')
    const rule = (selector: string) => {
      const at = source.indexOf(selector)
      return at < 0 ? '' : source.slice(at, source.indexOf('}', at))
    }
    expect(rule('.sgs-seat__equipment {'), '装备槽要展开成双列，不能整块隐藏').toContain('display: grid')
    expect(rule('.sgs-seat__skills {'), '技能区不能再被裁高').toContain('max-height: none')
    expect(rule('.sgs-seat__skills {')).toContain('overflow: visible')
    // 旧的隐藏规则并没有被删掉，是靠后写的规则覆盖的，所以顺序本身就是不变量：
    // 一旦展开规则被挪到隐藏规则前面，手机上装备又会整块消失。
    expect(source.indexOf('.sgs-seat__equipment{display:none}'), '旧隐藏规则应当仍在（靠覆盖生效）').toBeGreaterThan(-1)
    expect(source.indexOf('.sgs-seat__equipment {'), '展开规则必须写在隐藏规则之后才盖得住')
      .toBeGreaterThan(source.indexOf('.sgs-seat__equipment{display:none}'))
  })

  it('立绘座位不使用会让 iPhone 中文笔画重叠的文字描边', () => {
    const source = readFileSync('src/sanguosha/components/SgsSeat.vue', 'utf8')
    expect(source).not.toContain('-webkit-text-stroke')
    expect(source).toContain('.sgs-seat .sgs-seat__identity--lord')
    expect(source).toContain('.sgs-seat .sgs-seat__identity--renegade')
    expect(source).toContain('.sgs-seat .sgs-seat__identity--rebel')
    expect(source).toContain('.sgs-seat .sgs-seat__identity--loyalist')
    expect(source).toContain('.sgs-seat .sgs-seat__identity--hidden')
  })

  it('结算界面先显示红色退出键，再显示再来一局，并强制玩家名为浅色', () => {
    // 结算弹层已经抽成单机和联机共用的组件，这里跟着读组件而不是 App
    const source = readFileSync('src/sanguosha/components/SgsResultDialog.vue', 'utf8')
    const actions = source.slice(source.indexOf('<div class="sgs-result__actions">'), source.indexOf('</div>', source.indexOf('<div class="sgs-result__actions">')))
    expect(actions.indexOf('exit')).toBeLessThan(actions.indexOf('again'))
    expect(actions).toContain('class="danger"')
    expect(source).toContain('.sgs-result__roster strong { min-width: 0; display: flex;')
  })

  it('退出键和再来一局是同一套形状，只有配色不同', () => {
    // 用户明确要求两个按钮长得一样。圆角/高度写在通用规则里，
    // .danger 只能覆盖颜色——写进用例，免得以后有人只改一个。
    const source = readFileSync('src/sanguosha/components/SgsResultDialog.vue', 'utf8')
    const shared = /\.sgs-result__actions button \{([\s\S]*?)\}/.exec(source)?.[1] ?? ''
    expect(shared, '圆角写在共用规则里').toContain('border-radius')
    expect(shared, '高度也写在共用规则里').toContain('min-height')
    const danger = /\.sgs-result__actions \.danger \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(danger, '危险色只改颜色，不改形状').not.toContain('border-radius')
    expect(danger).not.toContain('min-height')
  })

  it('单机和联机用的是同一个结算组件', () => {
    for (const file of ['src/sanguosha/SanguoshaApp.vue', 'src/sanguosha/components/SgsOnlineHub.vue']) {
      expect(readFileSync(file, 'utf8'), `${file} 应当复用结算组件`).toContain('SgsResultDialog')
    }
  })
})

describe('三国杀公开表现事件', () => {
  it('杀、闪、伤害与回复保留来源目标和结果', () => {
    const game = new SanguoshaGame({ seed: 'ui-events', setup: setup(5) })
    const characters = ['caocao', 'guanyu', 'zhangfei', 'zhaoyun', 'machao'] as const
    game.state.players.forEach((player, index) => { player.characterId = characters[index] })
    const events: GameEvent[] = [
      { id: 'e1', seq: 1, name: 'CardUsed', sourceId: 'p1', payload: { cardName: '杀', targetIds: ['p0'] } },
      { id: 'e2', seq: 2, name: 'CardResponded', payload: { playerId: 'p0', cardName: '闪' } },
      { id: 'e3', seq: 3, name: 'Damaged', sourceId: 'p1', targetId: 'p0', damageNature: 'fire', payload: { amount: 2 } },
      { id: 'e4', seq: 4, name: 'Recover', sourceId: 'p2', targetId: 'p0', payload: { playerId: 'p0', amount: 1 } },
    ]
    const output = events.map((event) => buildPresentationEvent(game.state, event))
    expect(output[0]).toMatchObject({ kind: 'card-use', sourceId: 'p1', targetIds: ['p0'], cardName: '杀' })
    expect(output[1]).toMatchObject({ kind: 'card-response', sourceId: 'p0', cardName: '闪' })
    expect(output[2]).toMatchObject({ kind: 'damage', targetIds: ['p0'], amount: 2, nature: 'fire' })
    expect(output[3]).toMatchObject({ kind: 'recover', sourceId: 'p2', targetIds: ['p0'], amount: 1 })
    expect(output[0]?.text).toBe('关羽对曹操使用【杀】')
    expect(output[0]?.text).not.toContain('电脑')
  })

  it('他人摸牌事件只含张数，不含牌名或 cardId', () => {
    const game = new SanguoshaGame({ seed: 'ui-secret-event', setup: setup(5) })
    const hiddenId = game.state.zones.drawPile[0]
    const event: GameEvent = { id: 'secret', seq: 1, name: 'GainCard', targetId: 'p1', cardIds: [hiddenId], payload: { playerId: 'p1', cardIds: [hiddenId] } }
    const output = buildPresentationEvent(game.state, event)!
    expect(output).toMatchObject({ kind: 'draw', targetIds: ['p1'], amount: 1 })
    expect(JSON.stringify(output)).not.toContain(hiddenId)
    expect(JSON.stringify(output)).not.toContain(game.state.cards[hiddenId].name)
  })
})

/**
 * 主动技的广播点。
 *
 * 这个事件原本在 `game.act()` 里发，为此又把合法动作全枚举了一遍——
 * `performPlayAction` 内部本来就要查一次。现在挪进 performPlayAction，
 * 这几条守住挪动之后行为没变：能发动才广播，用的是中文名。
 */
describe('主动技的发动广播', () => {
  function gameAt(characterIds: string[]): SanguoshaGame {
    const game = new SanguoshaGame({ seed: 'skill-broadcast', setup: setup(5) })
    game.state.players.forEach((player, index) => { player.characterId = characterIds[index] ?? 'machao' })
    game.start()
    while (game.state.pendingRequests.length > 0) {
      const request = game.state.pendingRequests[0]
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { optionId: 'no' } })
    }
    game.state.currentPlayerId = 'p0'
    game.state.phase = 'play'
    return game
  }

  it('发动主动技会广播中文技能名', () => {
    // 貂蝉的离间是标准包里最典型的出牌阶段主动技
    const game = gameAt(['diaochan', 'caocao', 'zhangfei', 'zhaoyun', 'machao'])
    const seen: string[] = []
    game.events.on('SkillActivated', (context) => { seen.push(String(context.event.payload.skillName)) })

    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'invoke-skill' && candidate.skillId === 'lijian')
    expect(action, '构造不出离间的发动动作').toBeTruthy()
    game.act('p0', action!.id)

    expect(seen).toContain('离间')
    // 广播出去的是给人看的名字，内部 id 不该出现在界面事件里
    expect(seen).not.toContain('lijian')
  })

  it('发动不了的技能不会广播', () => {
    const game = gameAt(['machao', 'caocao', 'zhangfei', 'zhaoyun', 'machao'])
    let broadcast = 0
    game.events.on('SkillActivated', () => { broadcast += 1 })
    // 马超没有主动技，硬点一个不存在的技能动作只会抛错，界面不该闪出技能名
    expect(() => game.act('p0', 'skill:lijian')).toThrow()
    expect(broadcast).toBe(0)
  })

  it('装备的主动效果也有中文名，不会把内部 id 甩到界面上', () => {
    expect(skillDisplayName('equip:zhangba')).toBe('丈八蛇矛')
    expect(skillDisplayName('equip:fangtian')).toBe('方天画戟')
    expect(skillDisplayName('lijian')).toBe('离间')
  })
})
