import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import SgsSeat from '@/sanguosha/components/SgsSeat.vue'
import type { PlayerPublicView } from '@/sanguosha/engine/view'

const player: PlayerPublicView = {
  id: 'p1', seat: 1, nickname: '曹操', alive: true, identity: null, identityHidden: true,
  characterId: 'caocao', hp: 4, maxHp: 4, chained: false, faceDown: false,
  characterPiles: {}, handCount: 4, hand: null, equipment: [], judgingArea: [], marks: {},
  privateCards: null, distanceFromViewer: 1, attackRange: 1,
}

async function seat(selectable: boolean): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(SgsSeat, { player, viewerId: 'p0', targeting: true, selectable }) }))
}

describe('目标选择座位点击面', () => {
  it('合法目标整张座位启用命中层', async () => {
    const html = await seat(true)
    expect(html).toContain('sgs-seat--targeting')
    expect(html).toContain('sgs-seat--selectable')
    expect(html).toContain('class="sgs-seat__target-hitbox"')
    expect(html).not.toMatch(/sgs-seat__target-hitbox[^>]*disabled/)
  })

  it('非法目标仍拦截局部词条，但命中层不可选择', async () => {
    const html = await seat(false)
    expect(html).toContain('sgs-seat--targeting')
    expect(html).toMatch(/sgs-seat__target-hitbox[^>]*disabled/)
  })
})
