import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from '../server/room-core'
import type { OnlineRoomSettings } from '@/online/types'

const settings: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30_000,
}

const START_AT = 1_000_000

function startedRoom(): RoomCoordinator {
  const room = RoomCoordinator.create('ABC234', { userId: 'u0', nickname: '玩家零' }, settings, START_AT)
  for (const id of [1, 2, 3]) {
    room.connect({ userId: `u${id}`, nickname: `玩家${id}` }, START_AT + id)
    room.handle(`u${id}`, { type: 'ready', ready: true }, START_AT + 10 + id)
  }
  room.handle('u0', { type: 'start-game' }, START_AT + 100)
  return room
}

function discard(room: RoomCoordinator, seatId: number, at: number, actionId = `act-${at}`): void {
  const tile = room.state.game!.players[seatId].hand[0]
  room.handle(`u${seatId}`, { type: 'discard', tileId: tile.id, actionId, version: room.view(`u${seatId}`).version }, at)
}

/** 打一张出去进入抢牌阶段，返回当时的阶段快照。 */
function enterClaimStage(room: RoomCoordinator, at: number) {
  discard(room, room.state.game!.dealer, at)
  expect(room.state.game!.phase).toBe('claiming')
  return { stageKey: room.state.stageKey, stageStartedAt: room.state.stageStartedAt }
}

describe('外围事件不得重置牌局阶段', () => {
  it('抢牌窗口内有人退出，窗口不重新计时，别人已经点过的「过」也还在', () => {
    const room = startedRoom()
    const dealer = room.state.game!.dealer
    const before = enterClaimStage(room, START_AT + 200)
    // 观察视角要选一个不会退出的人，否则 view() 会因为「你不在这个房间中」直接抛错
    const observer = `u${dealer}`
    const deadlineBefore = room.view(observer).deadlineAt

    // 找一个有抢牌选项的座位先点「过」
    const responder = room.state.game!.claimOptions[0]?.playerId
    if (responder !== undefined) {
      room.handle(`u${responder}`, {
        type: 'pass-claim',
        actionId: 'pass-1',
        version: room.view(`u${responder}`).version,
      }, START_AT + 250)
      expect(room.state.claimResponses[String(responder)]).toBe('pass')
    }
    const responsesBefore = { ...room.state.claimResponses }

    // 一个和这次抢牌无关的人退出房间，座位换成 AI（会插入一条 ai-change 事件）
    const quitter = [0, 1, 2, 3].find((seat) => seat !== responder && seat !== dealer)!
    room.handle(`u${quitter}`, { type: 'leave-room' }, START_AT + 300)
    expect(room.state.game!.events.some((event) => event.type === 'ai-change')).toBe(true)

    expect(room.state.stageKey).toBe(before.stageKey)
    expect(room.state.stageStartedAt).toBe(before.stageStartedAt)
    expect(room.state.claimResponses).toEqual(responsesBefore)
    expect(room.view(observer).deadlineAt).toBe(deadlineBefore)
  })

  it('当前玩家的出牌倒计时不会因为别人离开而回到满格', () => {
    const room = startedRoom()
    expect(room.state.game!.phase).toBe('playing')
    const current = room.state.game!.currentPlayer
    const timerBefore = room.view(`u${current}`).turnTimer
    const deadlineBefore = room.view(`u${current}`).deadlineAt
    const stageBefore = { key: room.state.stageKey, startedAt: room.state.stageStartedAt }

    const quitter = [0, 1, 2, 3].find((seat) => seat !== current)!
    // 已经过了 20 秒才有人退出，剩下的 10 秒不该被重置
    room.handle(`u${quitter}`, { type: 'leave-room' }, START_AT + 20_000)

    expect(room.state.stageKey).toBe(stageBefore.key)
    expect(room.state.stageStartedAt).toBe(stageBefore.startedAt)
    expect(room.view(`u${current}`).deadlineAt).toBe(deadlineBefore)
    expect(room.view(`u${current}`).turnTimer?.deadlineAt).toBe(timerBefore?.deadlineAt)
    expect(room.view(`u${current}`).turnTimer?.startedAt).toBe(timerBefore?.startedAt)
  })

  it('别人切换托管同样不影响当前回合的倒计时', () => {
    const room = startedRoom()
    const current = room.state.game!.currentPlayer
    const deadlineBefore = room.view(`u${current}`).deadlineAt
    const stageBefore = { key: room.state.stageKey, startedAt: room.state.stageStartedAt }

    const other = [0, 1, 2, 3].find((seat) => seat !== current && room.state.seats[seat].kind === 'human')!
    room.handle(`u${other}`, { type: 'trustee', enabled: true }, START_AT + 15_000)

    expect(room.state.stageKey).toBe(stageBefore.key)
    expect(room.state.stageStartedAt).toBe(stageBefore.startedAt)
    expect(room.view(`u${current}`).deadlineAt).toBe(deadlineBefore)
  })

  it('真正的牌局推进仍然会开新阶段', () => {
    const room = startedRoom()
    const before = room.state.stageKey
    discard(room, room.state.game!.dealer, START_AT + 500)
    expect(room.state.stageKey).not.toBe(before)
    expect(room.state.stageStartedAt).toBe(START_AT + 500)
  })
})

describe('服务器按 deadline 判定超时，不等 Alarm', () => {
  it('deadline 前 1 毫秒的出牌仍然有效', () => {
    const room = startedRoom()
    const current = room.state.game!.currentPlayer
    const deadline = room.view(`u${current}`).deadlineAt!
    expect(deadline).toBeGreaterThan(0)
    const versionBefore = room.view(`u${current}`).version
    discard(room, current, deadline - 1, 'in-time')
    expect(room.view(`u${current}`).version).not.toBe(versionBefore)
    expect(room.state.game!.players[current].discards.length).toBe(1)
  })

  it('刚好到 deadline 时操作被判超时，且服务端已经推进到下一阶段', () => {
    const room = startedRoom()
    const current = room.state.game!.currentPlayer
    const deadline = room.view(`u${current}`).deadlineAt!
    const stageBefore = room.state.stageKey

    // Alarm 还没跑，玩家的包先到了
    expect(() => discard(room, current, deadline, 'too-late')).toThrow()
    // 关键：服务端不能停在过期阶段上，必须已经按超时处理过
    expect(room.state.stageKey).not.toBe(stageBefore)
  })

  it('超过 deadline 之后同样不能钻空子', () => {
    const room = startedRoom()
    const current = room.state.game!.currentPlayer
    const deadline = room.view(`u${current}`).deadlineAt!
    expect(() => discard(room, current, deadline + 1, 'way-late')).toThrow()
  })

  it('抢牌窗口过期后旧的响应不再被接受', () => {
    const room = startedRoom()
    enterClaimStage(room, START_AT + 200)
    const responder = room.state.game!.claimOptions[0]?.playerId
    if (responder === undefined) return
    const deadline = room.view(`u${responder}`).deadlineAt!
    const stageBefore = room.state.stageKey

    expect(() => room.handle(`u${responder}`, {
      type: 'pass-claim',
      actionId: 'late-pass',
      version: room.view(`u${responder}`).version,
    }, deadline)).toThrow()
    expect(room.state.stageKey).not.toBe(stageBefore)
  })
})
