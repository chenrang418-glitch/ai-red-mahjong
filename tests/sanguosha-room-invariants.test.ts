import { describe, expect, it, vi } from 'vitest'
import {
  SanguoshaRoomCoordinator,
  normalizeSettings,
  type SgsRoomUser,
} from '../server/sanguosha-room-core'
import type { SanguoshaState } from '@/sanguosha/engine/types'

vi.setConfig({ testTimeout: 60_000 })

/**
 * 联机房间在**每一个引擎步之后**都要验一次牌局合法性。
 *
 * 房间本来就有一套很完整的回滚（含 RNG、战报、表现事件），
 * 但它**只对抛出的异常生效**。「牌被复制」「牌凭空消失」这类
 * 不抛错的坏状态原来会带着往下跑，直到某一步撞上别的错误才暴露，
 * 那时已经离现场很远了。
 *
 * 断言的是**校验真的触发了**（从房间自己打的那条错误日志里读），
 * 而不是「房间没崩」——后者对任何实现都成立，等于没测。
 */

const HOST: SgsRoomUser = { userId: 'u-host', nickname: '房主' }
const GUEST: SgsRoomUser = { userId: 'u-guest', nickname: '客人' }

function started(code: string, now = 1_000): SanguoshaRoomCoordinator {
  const room = SanguoshaRoomCoordinator.create(code, HOST, normalizeSettings({ playerCount: 5 }), now)
  room.connect(GUEST, now)
  room.handle(HOST.userId, { type: 'toggle-ready' }, now)
  room.handle(GUEST.userId, { type: 'toggle-ready' }, now)
  for (let index = 0; index < 3; index += 1) room.handle(HOST.userId, { type: 'add-ai' }, now)
  room.handle(HOST.userId, { type: 'start-game' }, now)
  return room
}

/**
 * 推进到「起始手牌已经发下去」。
 *
 * 必须先把选将答完——手牌是所有人选完将之后才发的，
 * 停在选将请求上的话场上一张手牌都没有，测试根本构造不出坏状态。
 */
function settleUntilHandsDealt(room: SanguoshaRoomCoordinator, now: number): void {
  for (let guard = 0; guard < 80; guard += 1) {
    for (const user of [HOST, GUEST]) {
      const pending = room.view(user.userId).playerView?.pendingRequest
      if (pending?.kind === 'choose-general') {
        room.handle(user.userId, {
          type: 'respond',
          requestId: pending.id,
          payload: { characterId: pending.candidates[0] },
        }, now + guard)
      }
    }
    if ((room.state.game?.players ?? []).some((player) => player.zones.hand.length > 0)) return
    const next = room.nextAlarmAt()
    if (next === null) return
    room.runDueJobs(Math.max(now + guard, next))
  }
}

/**
 * 收集房间自己打的错误日志。
 *
 * 房间在回滚时会 `console.error('[sanguosha][job-error]', ...)`，
 * 里面带着 `errorMessage`。这是从外部确认「校验触发了」最直接的证据——
 * 错误被房间接住之后不会冒到调用方，只能从这里读。
 */
function captureRoomErrors(run: () => void): string[] {
  const messages: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('[sanguosha][job-error]')) messages.push(String(args[1] ?? ''))
  })
  try {
    run()
  } finally {
    spy.mockRestore()
  }
  return messages
}

/**
 * 拿到房间**内存里那个引擎实例**。
 *
 * 房间对外暴露的 `state.game` 是序列化快照，每走一步都会被
 * `game.serialize()` 覆盖写回——改它等于没改。真实的状态损坏发生在
 * 引擎实例上，所以测试也必须污染那一个，才算忠实地模拟了这件事。
 */
function liveState(room: SanguoshaRoomCoordinator): SanguoshaState {
  const engine = (room as unknown as { engine: { state: SanguoshaState } | null }).engine
  if (!engine) throw new Error('引擎还没有实例化：先把牌局推进到发过手牌')
  return engine.state
}

/** 一直推到房间自己报错，或者推不动为止。 */
function pushUntilError(room: SanguoshaRoomCoordinator, from: number): string[] {
  return captureRoomErrors(() => {
    for (let guard = 0; guard < 40; guard += 1) {
      const next = room.nextAlarmAt()
      if (next === null) return
      try {
        room.runDueJobs(Math.max(from + guard * 1_000, next))
      } catch {
        // 冒到外面来的也算：两条路径都可接受，重点是它被发现了
        return
      }
    }
  })
}

describe('联机房间：每步之后的牌局健康检查', () => {
  it('同一张牌塞给两个人：下一步就被抓出来', () => {
    const room = started('INV234')
    settleUntilHandsDealt(room, 5_000)
    const game = liveState(room)
    const donor = game.players.find((player) => player.zones.hand.length > 0)
    expect(donor, '前提：已经发过起始手牌').toBeTruthy()
    const receiver = game.players.find((player) => player.id !== donor!.id)!

    // **复制**一张牌（不是移动）：两个人手上同时有它
    receiver.zones.hand.push(donor!.zones.hand[0])

    const errors = pushUntilError(room, 20_000)
    expect(errors.length, '房间报出了错误').toBeGreaterThan(0)
    expect(
      errors.some((message) => message.includes('同一张牌同时出现在多个区域')),
      `报的应该正是牌张守恒那条，实际是：${errors.join(' | ').slice(0, 300)}`,
    ).toBe(true)
    expect(room.state.game, '房间没有把牌局弄丢').toBeTruthy()
    expect(room.view(HOST.userId), '视图还生成得出来').toBeTruthy()
  })

  it('牌凭空消失：同样被抓出来', () => {
    const room = started('INV235')
    settleUntilHandsDealt(room, 5_000)
    liveState(room).zones.drawPile.pop()

    const errors = pushUntilError(room, 30_000)
    expect(errors.length, '房间报出了错误').toBeGreaterThan(0)
    expect(
      errors.some((message) => message.includes('牌张不守恒')),
      `报的应该正是牌张守恒那条，实际是：${errors.join(' | ').slice(0, 300)}`,
    ).toBe(true)
  })

  it('把请求发给一个已经出局的人：不变量当场拦下', () => {
    const room = started('INV236')
    settleUntilHandsDealt(room, 5_000)
    const game = liveState(room)
    const victim = game.players.find((player) => player.id !== game.currentPlayerId)!
    // 只标死不公开身份，正是「请求发给死人」之外的另一条不变量
    victim.alive = false
    victim.identityRevealed = false

    const errors = pushUntilError(room, 40_000)
    expect(errors.length, '房间报出了错误').toBeGreaterThan(0)
    expect(
      errors.some((message) => message.includes('死亡角色身份未公开') || message.includes('Request 响应玩家非法')),
      `应该报不变量那两条之一，实际是：${errors.join(' | ').slice(0, 300)}`,
    ).toBe(true)
  })

  it('反证：健康的牌局一路推进，一次都不报错', () => {
    /*
     * 没有这一条的话，上面三条「坏状态被拦住」可能是因为校验对
     * **任何**状态都抛——那等于把联机整个打死了。
     */
    const room = started('INV237')
    settleUntilHandsDealt(room, 5_000)
    let steps = 0
    const errors = captureRoomErrors(() => {
      for (let guard = 0; guard < 120; guard += 1) {
        const next = room.nextAlarmAt()
        if (next === null) break
        room.runDueJobs(Math.max(50_000 + guard * 1_000, next))
        steps += 1
        if (room.state.game?.status !== 'playing') break
      }
    })
    expect(steps, '确实推进了很多步').toBeGreaterThan(5)
    expect(errors, `健康的牌局不该报任何错：${errors.join(' | ').slice(0, 300)}`).toEqual([])
    expect(room.state.game, '牌局还在').toBeTruthy()
  })
})
