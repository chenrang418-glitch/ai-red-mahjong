import { describe, expect, it } from 'vitest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { assertGameInvariants } from '@/sanguosha/engine/invariants'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { getSkillRuntime } from '@/sanguosha/engine/skills/runtime'
import { INSTANT_TRICKS as INSTANT_TRICK_NAMES } from '@/sanguosha/engine/cards/tricks'
import type { GameSetup, Identity, PlayerId } from '@/sanguosha/engine/types'

/**
 * 转化技。
 *
 * 「服务端支持不等于前端点得到」——但更糟的一种情况是**连服务端都没支持**：
 * 技能注册了、`viewAs` 也返回了选项，而生成合法动作的地方把它过滤掉了，
 * 于是这个武将永远用不出自己的技能。甘宁【奇袭】就出过这个问题。
 */

function setup(): GameSetup {
  return {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
  }
}

function gameWith(characterIds: (string | null)[], seed = 'viewas'): SanguoshaGame {
  const game = new SanguoshaGame({ seed, setup: setup() })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterIds[index] ?? 'machao'
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

/** 把一张指定花色的牌塞进手里。 */
function giveCardOfColor(game: SanguoshaGame, playerId: PlayerId, color: 'red' | 'black', excludeName?: string): string {
  const cardId = game.state.zones.drawPile.find((id) => {
    const card = game.state.cards[id]
    return card.color === color && card.name !== excludeName
  })
  if (!cardId) throw new Error(`牌堆里没有${color}牌`)
  game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
  game.state.players.find((player) => player.id === playerId)!.zones.hand.push(cardId)
  return cardId
}

describe('甘宁【奇袭】', () => {
  it('黑牌真的能当【过河拆桥】打出去', () => {
    const game = gameWith(['ganning'])
    const black = giveCardOfColor(game, 'p0', 'black', '过河拆桥')
    // 保证有个能拆的目标
    const victim = game.state.players[1]
    expect(victim.zones.hand.length).toBeGreaterThan(0)

    const actions = game.legalActions('p0')
    const qixi = actions.find((action) => action.kind === 'use-card'
      && action.cardIds.includes(black) && action.asCardName === '过河拆桥')
    expect(qixi, '奇袭必须真的产生一条合法动作，否则这个武将等于没实现').toBeTruthy()

    game.act('p0', qixi!.id)
    // 结算按转化后的牌名走，不是按牌面印的名字
    expect(game.state.cardResolution?.kind).toBe('trick')
    expect((game.state.cardResolution as { cardName: string }).cardName).toBe('过河拆桥')
    assertGameInvariants(game.state)
  })

  it('红牌不能当【过河拆桥】', () => {
    const game = gameWith(['ganning'])
    const red = giveCardOfColor(game, 'p0', 'red')
    const actions = game.legalActions('p0')
    expect(actions.some((action) => action.kind === 'use-card'
      && action.cardIds.includes(red) && action.asCardName === '过河拆桥')).toBe(false)
  })
})

describe('关羽【武圣】', () => {
  it('红牌当【杀】仍然按杀结算', () => {
    const game = gameWith(['guanyu'])
    const red = giveCardOfColor(game, 'p0', 'red', '杀')
    const actions = game.legalActions('p0')
    const wusheng = actions.find((action) => action.kind === 'use-card'
      && action.cardIds.includes(red) && action.asCardName === '杀')
    expect(wusheng).toBeTruthy()
    game.act('p0', wusheng!.id)
    expect(game.state.cardResolution?.kind).toBe('slash')
    assertGameInvariants(game.state)
  })
})

describe('转化技不能产出无人消费的牌名', () => {
  it('每个 viewAs 产出的 asCardName 都有对应的消费路径', () => {
    // 真正的 bug 形态是「技能产出了选项，而生成动作的地方把它丢掉了」——
    // 甘宁【奇袭】就是这样，注册了却永远用不出来。
    // 所以这里守的是「每一种能产出的牌名都有人接」，
    // 而不是「每个武将在出牌阶段都得有动作」（急救只在回合外、倾国只在响应时）。
    const CONSUMERS: Record<string, string> = {
      杀: '出牌阶段动作',
      闪: 'dodgeViewAsOptions',
      桃: '濒死救援 rescueActionIds',
    }
    const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

    const produced = new Set<string>()
    for (const character of ALL_CHARACTERS) {
      const runtimes = character.skills.map((skill) => getSkillRuntime(skill.id)).filter(Boolean)
      if (!runtimes.some((runtime) => runtime!.viewAs)) continue

      const game = gameWith([character.id], `viewas-${character.id}`)
      const owner = game.state.players[0]
      // 手上凑齐红黑普通牌，以及闪和杀，覆盖已有的几种转化
      giveCardOfColor(game, 'p0', 'red', '杀')
      giveCardOfColor(game, 'p0', 'black', '过河拆桥')
      for (const name of ['闪', '杀']) {
        const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === name)
        if (cardId) {
          game.state.zones.drawPile = game.state.zones.drawPile.filter((id) => id !== cardId)
          owner.zones.hand.push(cardId)
        }
      }
      // 双雄只有在本回合已经完成判定后才开放转化；这里测试的是消费路径，
      // 因而显式构造一个“判定结果为红色”的合法前置状态。
      if (character.id === 'yanliangwenchou') owner.marks.shuangxiong = 1

      // 有的转化技限定在自己回合内（武圣、奇袭），有的限定在回合外（急救），
      // 两种情形都探一次，只要有一处产出就说明技能是活的
      const probe = () => runtimes.flatMap((runtime) => runtime!.viewAs?.(game.state, 'p0') ?? [])
      const inTurn = probe()
      game.state.currentPlayerId = 'p1'
      const outOfTurn = probe()
      game.state.currentPlayerId = 'p0'

      const options = [...inTurn, ...outOfTurn]
      expect(options.length, `${character.name} 的 viewAs 在合适手牌下什么都没产出`).toBeGreaterThan(0)
      for (const option of options) produced.add(option.asCardName)
    }

    for (const name of produced) {
      const handled = name in CONSUMERS || INSTANT_TRICK_NAMES.has(name) || DELAYED_TRICK_NAMES.has(name)
      expect(handled, `【${name}】被转化技产出了，但没有任何地方消费它`).toBe(true)
    }
  })

  it('普通锦囊的转化会走进锦囊结算，而不是被当成牌面上的名字', () => {
    const game = gameWith(['ganning'])
    const black = giveCardOfColor(game, 'p0', 'black', '过河拆桥')
    const action = game.legalActions('p0').find((candidate) => candidate.kind === 'use-card'
      && candidate.cardIds.includes(black) && candidate.asCardName === '过河拆桥')!
    game.act('p0', action.id)
    const resolution = game.state.cardResolution as { cardName: string; cardId: string }
    expect(resolution.cardName).toBe('过河拆桥')
    // 实体牌还是原来那张，只是按锦囊结算
    expect(resolution.cardId).toBe(black)
    expect(game.state.cards[black].name).not.toBe('过河拆桥')
  })
})
