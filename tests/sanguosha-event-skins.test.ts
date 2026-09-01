import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsActionStage from '@/sanguosha/components/SgsActionStage.vue'
import SgsEffectLayer from '@/sanguosha/components/SgsEffectLayer.vue'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { StagedEvent } from '@/sanguosha/composables/useSgsEventStage'
import type { PresentationEvent, PresentationEventKind } from '@/sanguosha/engine/presentation'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'
import type { PlayerView } from '@/sanguosha/engine/view'

/**
 * 皮肤是否真的渲染出来。
 *
 * 靠在浏览器里等特定局面来验太看运气——判定、无懈连锁、致死一击都不是想有就有的，
 * 而宿主页面隐藏时定时器还会被浏览器钳制。所以这里沿用请求界面那套 SSR 渲染，
 * 把每种皮肤直接渲一遍，断言类名确实挂上了。动画时序由
 * `sanguosha-event-stage.test.ts` 用假定时器覆盖。
 */

function baseView(): PlayerView {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed: 'skin-render', setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'machao'
  })
  game.start()
  return game.viewFor('p0')
}

const view = baseView()

function staged(kind: PresentationEventKind, skin: StagedEvent['skin'], extra: Partial<PresentationEvent> = {}, chainDepth = 0): StagedEvent {
  const event: PresentationEvent = { id: `e-${kind}-${skin}`, seq: 1, kind, text: `${kind} 文案`, ...extra }
  return { event, skin, chainDepth }
}

async function stage(item: StagedEvent): Promise<string> {
  return renderToString(createSSRApp(SgsActionStage, { view, staged: item, request: null, busy: false }))
}

async function effects(item: StagedEvent): Promise<string> {
  return renderToString(createSSRApp(SgsEffectLayer, { staged: item }))
}

const CASES: Array<{ name: string; item: StagedEvent }> = [
  { name: '伤害', item: staged('damage', 'strike', { amount: 2, sourceId: 'p1', targetIds: ['p0'] }) },
  { name: '濒死', item: staged('dying', 'strike', { targetIds: ['p0'] }) },
  { name: '阵亡', item: staged('death', 'strike', { targetIds: ['p1'] }) },
  { name: '回血', item: staged('recover', 'heal', { amount: 1, targetIds: ['p0'] }) },
  { name: '闪避', item: staged('card-response', 'dodge', { cardName: '闪', sourceId: 'p0' }) },
  { name: '判定', item: staged('judge', 'judge', { cardName: '桃', targetIds: ['p0'] }) },
  { name: '无懈', item: staged('card-use', 'nullify', { cardName: '无懈可击', sourceId: 'p2' }, 2) },
  { name: '摸牌', item: staged('draw', 'plain', { amount: 2, targetIds: ['p1'] }) },
]

describe('舞台按皮肤和轻重渲染', () => {
  for (const { name, item } of CASES) {
    it(`${name}挂上了对应的皮肤类`, async () => {
      const html = await stage(item)
      expect(html).toContain(`sgs-action-stage__event--skin-${item.skin}`)
      expect(html).toContain(item.event.text)
    })
  }

  it('伤害类是重量级，摸牌是轻量级', async () => {
    // 余光要能分辨轻重，这是分级的全部意义
    for (const kind of ['damage', 'dying', 'death', 'lose-hp'] as const) {
      expect(await stage(staged(kind, 'strike', { amount: 1 })), `${kind} 应当加重`).toContain('sgs-action-stage__event--heavy')
    }
    expect(await stage(staged('draw', 'plain', { amount: 1 })), '摸牌应当压轻').toContain('sgs-action-stage__event--light')
    expect(await stage(staged('card-use', 'plain', { cardName: '杀' })), '出牌是常规权重').toContain('sgs-action-stage__event--normal')
  })

  it('无懈连锁显示打到第几张', async () => {
    const html = await stage(staged('card-use', 'nullify', { cardName: '无懈可击' }, 3))
    expect(html).toContain('连环第 3 张')
    // 第一张不是连锁，不该显示计数
    expect(await stage(staged('card-use', 'nullify', { cardName: '无懈可击' }, 1))).not.toContain('连环第')
  })

  it('舞台没有事件时不残留旧横幅', async () => {
    const html = await renderToString(createSSRApp(SgsActionStage, { view, staged: null, request: null, busy: false }))
    expect(html).toContain('等待行动')
    expect(html).not.toContain('sgs-action-stage__event--')
  })
})

describe('特效层', () => {
  it('伤害和回血给出带符号的数字', async () => {
    expect(await effects(staged('damage', 'strike', { amount: 3, targetIds: ['p0'] }))).toContain('-3')
    expect(await effects(staged('recover', 'heal', { amount: 2, targetIds: ['p0'] }))).toContain('+2')
  })

  it('判定和无懈也有浮字，不再只有战报一行字', async () => {
    expect(await effects(staged('judge', 'judge', { cardName: '闪电' }))).toContain('闪电')
    expect(await effects(staged('card-use', 'nullify', { cardName: '无懈可击' }))).toContain('无懈可击')
  })

  it('浮字带皮肤类', async () => {
    expect(await effects(staged('card-response', 'dodge', { cardName: '闪' }))).toContain('sgs-effects__float--skin-dodge')
    expect(await effects(staged('damage', 'strike', { amount: 1 }))).toContain('sgs-effects__float--skin-strike')
  })
})
