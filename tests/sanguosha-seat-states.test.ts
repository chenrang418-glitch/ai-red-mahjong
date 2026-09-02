import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsSeat from '@/sanguosha/components/SgsSeat.vue'
import SgsResultDialog from '@/sanguosha/components/SgsResultDialog.vue'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { flipCharacter } from '@/sanguosha/engine/character-state'
import { BUQU } from '@/sanguosha/data/characters/wind-zhoutai'
import { readFileSync } from 'node:fs'
import { moveCard } from '@/sanguosha/engine/zones'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 座位上的两种新状态：翻面和武将专属牌堆。
 *
 * 用 SSR 渲染而不是实时对局来验：实时对局里要等十几个回合才碰得到这些状态，
 * 而这里要守的是「状态一旦出现，座位上必须看得出来」——手机上尤其。
 * 「不屈 ×3」而不是把三张牌横排，是因为横排会直接把座位撑爆。
 */

function gameWith(characterId: string, seed = 'seat-states'): SanguoshaGame {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed, setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = index === 1 ? characterId : 'machao'
  })
  game.start()
  return game
}

async function renderSeat(game: SanguoshaGame): Promise<string> {
  const view = game.viewFor('p0')
  const player = view.players.find((candidate) => candidate.id === 'p1')!
  return renderToString(createSSRApp(SgsSeat, { player, viewerId: view.viewerId }))
}

describe('翻面在座位上看得出来', () => {
  it('正面朝上时没有翻面标记', async () => {
    const html = await renderSeat(gameWith('caoren'))
    expect(html).not.toContain('翻面')
  })

  it('背面朝上时座位显示「翻面」', async () => {
    const game = gameWith('caoren')
    flipCharacter(game, 'p1', '据守', true)
    const html = await renderSeat(game)
    expect(html).toContain('翻面')
  })

  it('翻面不影响武将名、体力和手牌数的显示', async () => {
    const game = gameWith('caoren')
    flipCharacter(game, 'p1', '据守', true)
    const html = await renderSeat(game)
    expect(html, '武将名还要看得见').toContain('曹仁')
    expect(html, '体力槽还在').toContain('sgs-seat__hp')
    expect(html, '手牌数还在').toContain('手牌')
  })
})

describe('专属牌堆在座位上只显示张数', () => {
  it('没有「创」时不占位置', async () => {
    const html = await renderSeat(gameWith('zhoutai'))
    expect(html).not.toContain('sgs-seat__piles')
  })

  it('有「创」时显示技能名和张数', async () => {
    const game = gameWith('zhoutai')
    const owner = game.state.players[1]
    const wounds = game.state.zones.drawPile.splice(0, 3)
    owner.characterPiles[BUQU] = wounds

    const html = await renderSeat(game)
    expect(html).toContain('不屈')
    expect(html, '只报张数，不把三张牌横排').toContain('×3')
    for (const cardId of wounds) {
      expect(html, '牌面细节留给词条面板，座位上不铺开').not.toContain(cardId)
    }
  })

  it('张数跟着牌堆变', async () => {
    const game = gameWith('zhoutai')
    game.state.players[1].characterPiles[BUQU] = game.state.zones.drawPile.splice(0, 1)
    expect(await renderSeat(game)).toContain('×1')
  })
})


describe('判定区在座位上一眼看得见', () => {
  /** 给某人的判定区塞一张指定的延时锦囊。 */
  function putDelayed(game: SanguoshaGame, playerId: string, cardName: string): void {
    const cardId = game.state.zones.drawPile.find((id) => game.state.cards[id].name === cardName)
    if (!cardId) throw new Error(`牌堆里没有【${cardName}】`)
    moveCard(game.state, cardId, { kind: 'drawPile' }, { kind: 'judgingArea', playerId })
  }

  it('延时锦囊显示成一个字，全名留在 aria-label 和 title 里', async () => {
    const game = gameWith('caoren')
    putDelayed(game, 'p1', '乐不思蜀')
    const html = await renderSeat(game)

    expect(html, '只显示一个字：两张判定牌横排会被压到看不见').toContain('>乐<')
    expect(html, '全名不能丢，读屏和悬停都要能拿到').toContain('判定区：乐不思蜀')
    expect(html).toContain('title="乐不思蜀"')
  })

  it('闪电和兵粮寸断各有自己的字', async () => {
    const lightning = gameWith('caoren', 'seat-lightning')
    putDelayed(lightning, 'p1', '闪电')
    expect(await renderSeat(lightning)).toContain('>电<')

    const shortage = gameWith('caoren', 'seat-shortage')
    putDelayed(shortage, 'p1', '兵粮寸断')
    expect(await renderSeat(shortage)).toContain('>兵<')
  })

  it('判定标记不许被 flex 压缩——原来的 bug 就是被压到 16px 宽', () => {
    const source = readFileSync('src/sanguosha/components/SgsSeat.vue', 'utf8')
    const rule = /\.sgs-seat__states span,\.sgs-seat__states button\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(rule, '状态行里的 chip 必须 flex:none').toContain('flex:none')
  })

  it('立绘上的判定标记保持红底，不被通用的黑底盖掉', () => {
    const source = readFileSync('src/sanguosha/components/SgsSeat.vue', 'utf8')
    const generic = source.indexOf('.sgs-seat--has-art .sgs-seat__states button')
    const chip = source.indexOf('.sgs-seat--has-art .sgs-seat__states .sgs-seat__judge-chip')
    expect(chip, '专用规则要在通用规则之后').toBeGreaterThan(generic)
    // 选择器要比 (0,2,1) 更具体，否则红底会被盖掉——实测踩过
    expect(source).toContain('.sgs-seat--has-art .sgs-seat__states .sgs-seat__judge-chip')
  })
})

describe('结算弹层', () => {
  it('公开每个人的身份、武将和存活情况，并标出自己', async () => {
    const game = gameWith('caoren', 'result-dialog')
    game.state.status = 'game-over'
    game.state.players.forEach((player) => { player.identityRevealed = true })
    game.state.players[2].alive = false
    game.state.result = { winningCamp: 'rebel', winnerIds: ['p1', 'p3'], reason: '主公阵亡' }

    const view = game.viewFor('p0')
    const html = await renderToString(createSSRApp(SgsResultDialog, { view, result: view.result! }))

    expect(html, '要报获胜阵营').toContain('反贼获胜')
    expect(html).toContain('主公阵亡')
    for (const label of ['主公', '忠臣', '反贼', '内奸']) {
      expect(html, `身份 ${label} 要公开`).toContain(label)
    }
    expect(html, '阵亡的人要标出来').toContain('阵亡')
    expect(html, '要标出哪个是自己').toContain('sgs-result__self')
    expect(html, '武将名也要有').toContain('曹仁')
  })

  it('两个按钮文案可以由调用方决定——联机要的是「退出对局」', async () => {
    const game = gameWith('caoren', 'result-dialog-online')
    game.state.status = 'game-over'
    game.state.players.forEach((player) => { player.identityRevealed = true })
    game.state.result = { winningCamp: 'lord', winnerIds: ['p0'], reason: '反贼全灭' }
    const view = game.viewFor('p0')

    const html = await renderToString(createSSRApp(SgsResultDialog, {
      view, result: view.result!, exitLabel: '退出对局', againLabel: '等待其他玩家', againDisabled: true,
    }))
    expect(html).toContain('退出对局')
    expect(html).toContain('等待其他玩家')
    expect(html, '等其他人时主按钮要禁用').toContain('disabled')
  })
})
