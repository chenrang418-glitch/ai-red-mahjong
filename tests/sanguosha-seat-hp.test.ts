import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsSeat from '@/sanguosha/components/SgsSeat.vue'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'
import type { PlayerView } from '@/sanguosha/engine/view'

/**
 * 座位的体力槽。
 *
 * 用户报告「扣血时小心心没有变化，仍然是满格红色」。DOM 和计算样式其实都是对的，
 * 问题在于**已失去的体力只靠颜色区分**：手机断点上这里只有 10px，
 * 灰实心和红实心在那个尺寸下读起来一样；而同一处断点又把唯一的数字备份
 * `2/3` 用 `display:none` 藏掉了，于是完全没有第二条线索。
 *
 * 所以这里守两条：失去的体力必须是**空心**（形状差异，不依赖颜色和尺寸），
 * 以及数字必须渲染出来。
 */

function viewWith(hp: number, maxHp: number): PlayerView {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed: 'seat-hp', setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'machao'
  })
  game.start()
  const target = game.state.players[1]
  target.maxHp = maxHp
  target.hp = hp
  return game.viewFor('p0')
}

async function render(hp: number, maxHp: number): Promise<string> {
  const view = viewWith(hp, maxHp)
  const player = view.players.find((candidate) => candidate.id === 'p1')!
  return renderToString(createSSRApp(SgsSeat, { player, viewerId: view.viewerId }))
}

/** 只数体力槽里的心，避免把别处可能出现的字符也算进来。 */
function hearts(html: string): { full: number; empty: number } {
  const slot = /<div class="sgs-seat__hp"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
  return {
    full: (slot.match(/♥/g) ?? []).length,
    empty: (slot.match(/♡/g) ?? []).length,
  }
}

describe('体力槽', () => {
  it('掉血后失去的那格变成空心，不是换个颜色的实心', async () => {
    const html = await render(2, 4)
    expect(hearts(html)).toEqual({ full: 2, empty: 2 })
  })

  it('满血时全是实心', async () => {
    expect(hearts(await render(4, 4))).toEqual({ full: 4, empty: 0 })
  })

  it('濒死到 0 时一颗实心都不剩', async () => {
    expect(hearts(await render(0, 3))).toEqual({ full: 0, empty: 3 })
  })

  it('体力上限变化时槽位跟着变（主公 +1）', async () => {
    expect(hearts(await render(5, 5))).toEqual({ full: 5, empty: 0 })
  })

  it('心之外还有数字，光看形状不够时有第二条线索', async () => {
    const html = await render(2, 4)
    expect(html).toContain('2/4')
    // 无障碍标签同样要说清楚
    expect(html).toContain('体力 2 / 4')
  })
})
