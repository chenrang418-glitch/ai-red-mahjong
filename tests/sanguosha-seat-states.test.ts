import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsSeat from '@/sanguosha/components/SgsSeat.vue'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { flipCharacter } from '@/sanguosha/engine/character-state'
import { BUQU } from '@/sanguosha/data/characters/wind-zhoutai'
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
