import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsRequestDock from '@/sanguosha/components/SgsRequestDock.vue'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import type { GameRequest } from '@/sanguosha/engine/requests'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'
import type { PlayerView } from '@/sanguosha/engine/view'

/**
 * 请求界面的渲染。
 *
 * 「服务端支持一种 ask/action，并不代表前端已经支持」——这条只有真的把组件
 * 渲染出来才验得到。之前只能靠在浏览器里凑局面，像遗计的 `distribute-cards`
 * 要「自己是郭嘉且被打」，纯靠运气，结果就是一直没验过。
 *
 * 这里用 Vue 自带的 server-renderer 把每一种请求都渲染一遍，不引入新依赖，
 * 也不需要 jsdom。断言的是「有没有产出可操作的控件」和「别人的牌面有没有漏出去」。
 */

function baseView(): PlayerView {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed: 'dock-render', setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = 'machao'
  })
  game.start()
  return game.viewFor('p0')
}

async function render(request: GameRequest, view: PlayerView): Promise<string> {
  const app = createSSRApp(SgsRequestDock, { request, view })
  return renderToString(app)
}

const view = baseView()
const me = view.players.find((player) => player.id === view.viewerId)!
const myCards = me.hand!.map((card) => card.id)

function common<K extends GameRequest['kind']>(kind: K, prompt: string) {
  return { id: `req-${kind}`, kind, playerId: view.viewerId, prompt, timeoutMs: 20_000, optional: false } as const
}

const REQUESTS: GameRequest[] = [
  { ...common('choose-general', '选择武将'), candidates: ['guanyu', 'zhangfei'], min: 1, max: 1 },
  { ...common('choose-cards', '弃置两张手牌'), cardIds: myCards, hiddenCardSlots: [], min: 2, max: 2, purpose: 'skill' },
  { ...common('choose-targets', '选择目标'), candidateIds: ['p1', 'p2'], min: 1, max: 1 },
  { ...common('choose-option', '发动技能？'), options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }] },
  { ...common('choose-suit', '选择花色'), suits: ['heart', 'spade'] },
  { ...common('choose-number', '选择数字'), min: 1, max: 3 },
  { ...common('use-card', '使用一张牌'), actionIds: ['play:1', 'respond-pass'] },
  { ...common('respond-card', '请打出【闪】'), actionIds: [`respond-dodge:${myCards[0]}`, 'respond-pass'], requiredCardName: '闪' },
  { ...common('invoke-skill', '发动技能'), skillId: 'wusheng', actionIds: ['skill:wusheng'] },
  { ...common('arrange-cards', '观星'), cardIds: myCards.slice(0, 3), minTop: 0, maxTop: 3, allowBottom: true },
  { ...common('distribute-cards', '把这些牌分给谁'), cardIds: myCards.slice(0, 2), recipientIds: ['p1', 'p2'], min: 0, max: 2 },
  { ...common('rescue', '濒死救援'), dyingPlayerId: 'p1', actionIds: ['rescue-pass'], requiredRecover: 1 },
]

describe('请求界面能渲染出可操作的控件', () => {
  for (const request of REQUESTS) {
    it(`${request.kind} 有提示文字和至少一个可点控件`, async () => {
      const html = await render(request, view)
      expect(html, `${request.kind} 应当显示提示`).toContain(request.prompt)
      // 没有任何 button 就说明这一类请求在界面上是死的
      expect(html.match(/<button/g)?.length ?? 0, `${request.kind} 没有可点的控件`).toBeGreaterThan(0)
      // 不能落到「未支持」的兜底分支
      expect(html).not.toContain('暂不支持')
    })
  }

  it('遗计的分配界面：每张牌都给出全部收牌人', async () => {
    const request = REQUESTS.find((candidate) => candidate.kind === 'distribute-cards')!
    const html = await render(request, view)
    expect(html).toContain('马超')
    expect(html).not.toContain('玩家1')
    // 两张牌 × 两个收牌人 + 一个确定
    expect((html.match(/<button/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('选将先选中，必须再点开始游戏才提交', async () => {
    const request = REQUESTS.find((candidate) => candidate.kind === 'choose-general')!
    const html = await render(request, view)
    expect(html).toContain('sgs-dock__generals')
    expect(html).toContain('开始游戏')
    expect(html).toMatch(/开始游戏<\/button>/)
    expect(html).toContain('disabled')
  })

  it('马钧水转百戏图显示六个独立水阀、进度和倒计时', async () => {
    const request: GameRequest = {
      ...common('choose-option', '操作水转百戏图'), skillId: 'qiaosi-b35', skillStep: 'waterwheel',
      options: Array.from({ length: 6 }, (_, index) => ({ id: `valve:${index}`, label: `水阀${index + 1}` })),
      interaction: { kind: 'waterwheel', progress: [0, 1, 0, 1, 0, 0], active: [3] },
    }
    const html = await render(request, view)
    expect(html).toContain('水转百戏图水阀')
    expect(html).toContain('剩余')
    expect(html).toContain('已点亮 1 / 3')
    expect((html.match(/class="ma-jun-waterwheel__name/g) ?? []).length).toBe(6)
    expect(html).toContain('active')
    expect(html).toContain('水阀1')
    expect(html).toContain('0 / 3')
    expect(html).toContain('disabled')
  })

  it('庞德公评才擦拭界面显示可逐格操作的宝物面板', async () => {
    const request: GameRequest = {
      ...common('choose-option', '擦拭宝物'), skillId: 'pingcai-b35', skillStep: 'scratch',
      options: [{ id: 'scratch-complete', label: '擦拭完成' }, { id: 'scratch-stop', label: '停止（未成功）' }],
      interaction: { kind: 'pingcai-scratch', treasure: 'fengchu', cellCount: 16, success: true },
    }
    const html = await render(request, view)
    expect(html).toContain('评才宝物擦拭区')
    expect(html).toContain('擦拭「凤雏」')
    expect((html.match(/class="pang-degong-scratch__cell/g) ?? []).length).toBe(16)
    expect(html).toContain('确认结果</button>')
    expect(html).not.toContain('擦拭成功！')
    expect(html).toContain('停止擦拭</button>')
    expect(html).toContain('disabled')
  })

  it('孙寒华冲虚显示独立集灵场地、分数与方向操作', async () => {
    const request: GameRequest = {
      ...common('choose-option', '接取莲花或躲避天雷'), skillId: 'chongxu-b36', skillStep: 'collect',
      options: [{ id: 'left', label: '左移' }, { id: 'stay', label: '保持位置' }, { id: 'right', label: '右移' }],
      interaction: { kind: 'spirit-gathering', index: 2, score: 1, cellCount: 15, lane: 1, fallingLane: 2, falling: 'lotus-white' },
    }
    const html = await render(request, view)
    expect(html).toContain('集灵挑战控制面板')
    expect(html).toContain('当前 1 / 5 分')
    expect(html).toContain('键盘 ← / → 移动')
    expect(html).toContain('🪷')
    expect(html).toContain('左移')
    expect(html).toContain('保持位置')
    expect(html).toContain('右移')
  })

  it('郑玄整经显示可连续划取多张牌的专属整理面板', async () => {
    const cards = myCards.slice(0, 5)
    const request: GameRequest = {
      ...common('choose-cards', '从展示牌中选择任意张作为“经”'), skillId: 'zhengxuan-b46', skillStep: 'select',
      cardIds: cards, hiddenCardSlots: [], min: 0, max: cards.length, purpose: 'skill', interaction: { kind: 'zhengxuan-slice' },
    }
    const html = await render(request, view)
    expect(html).toContain('整经划牌区')
    expect(html).toContain('可连续划过多张牌')
    expect((html.match(/class="zhengxuan-slice__card/g) ?? []).length).toBe(cards.length)
    expect(html).toContain('完成整理</button>')
    expect(html).not.toContain('sgs-dock__missing')
  })

  it('别人的手牌牌名不会出现在请求界面里', async () => {
    // 反馈那类请求用暗槽表示别人的手牌，牌面绝不能渲染出来
    const opponent = view.players.find((player) => player.id !== view.viewerId)!
    const request: GameRequest = {
      ...common('choose-cards', '获得对手的一张牌'),
      cardIds: [],
      hiddenCardSlots: Array.from({ length: opponent.handCount }, (_, index) => `hidden:${opponent.id}:${index}`),
      min: 1,
      max: 1,
      purpose: 'skill',
    }
    const html = await render(request, view)
    expect(html).toContain('未知牌')
    expect(html).not.toContain('hidden:')
  })
})
