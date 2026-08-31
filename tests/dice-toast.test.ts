import { beforeEach, describe, expect, it } from 'vitest'
import { claimDiceEvent, diceEventId, type DiceToastMemory } from '@/game/diceToast'
import { GameEngine } from '@/game/engine'
import type { GameState, MatchConfig } from '@/game/types'

function config(seed: number): MatchConfig {
  return {
    mode: 'unlimited',
    seed,
    claimWindowMs: 4000,
    players: [
      { name: '玩家', isHuman: true, initialPoints: 30, ai: null },
      { name: 'AI1', isHuman: false, initialPoints: 30, ai: { difficulty: 'beginner' } },
      { name: 'AI2', isHuman: false, initialPoints: 30, ai: { difficulty: 'standard' } },
      { name: 'AI3', isHuman: false, initialPoints: 30, ai: { difficulty: 'expert' } },
    ],
  }
}

/** 每个用例一份干净的假 sessionStorage，互不干扰。 */
function memory(): DiceToastMemory {
  const store = new Map<string, string>()
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value) },
  }
}

/** 模拟服务端广播：客户端每次拿到的都是一份全新的深拷贝，不是同一个对象。 */
function broadcast(state: GameState): GameState {
  return structuredClone(state)
}

describe('投骰提示只弹一次', () => {
  let engine: GameEngine
  let store: DiceToastMemory

  beforeEach(() => {
    engine = new GameEngine(config(20260831))
    store = memory()
  })

  it('开局的状态里能认出投骰事件', () => {
    const eventId = diceEventId(engine.state)
    expect(eventId).toBeTruthy()
    expect(engine.state.events.find((event) => event.id === eventId)?.type).toBe('dice')
  })

  // A. 开局第一次收到 state → 弹一次
  it('A：第一次收到开局状态会弹', () => {
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(true)
  })

  // B. 同一场后续任意状态推送（含自己出牌）都不得再弹
  it('B：同一场里出牌和反复推送都不再弹', () => {
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(true)

    // 连续推送同一份状态
    for (let i = 0; i < 5; i += 1) {
      expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(false)
    }

    // 自己出一张牌之后再推
    const dealer = engine.state.dealer
    const tile = engine.state.players[dealer].hand[0]
    engine.discard(dealer, tile.id)
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(false)
  })

  // C. 断线重连：重新拿到同一场的完整 GameState 也不得再弹
  it('C：重连拿到同一场完整状态不再弹', () => {
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(true)
    // 重连相当于组件重新挂载后拿到一份全新的完整状态；去重必须靠 store 而不是组件内变量
    const restored = GameEngine.restore(structuredClone(engine.state))
    expect(claimDiceEvent(diceEventId(broadcast(restored.state)), store)).toBe(false)
  })

  // D. 真正开新的一场 → 可以再弹一次
  it('D：换一场新牌局可以再弹', () => {
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(true)
    const next = new GameEngine(config(20260901))
    expect(next.state.matchId).not.toBe(engine.state.matchId)
    expect(claimDiceEvent(diceEventId(broadcast(next.state)), store)).toBe(true)
  })

  it('事件被挤出上限后不会误弹，也不会误判成新一场', () => {
    // events 有条数上限，打上一阵子投骰那条就被挤掉了；这时应当安静，而不是当成新事件
    expect(claimDiceEvent(diceEventId(broadcast(engine.state)), store)).toBe(true)
    const drained = structuredClone(engine.state)
    drained.events = drained.events.filter((event) => event.type !== 'dice')
    expect(diceEventId(drained)).toBeNull()
    expect(claimDiceEvent(diceEventId(drained), store)).toBe(false)
  })

  it('sessionStorage 写入失败时仍然弹得出来', () => {
    const broken: DiceToastMemory = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    expect(claimDiceEvent(diceEventId(engine.state), broken)).toBe(true)
  })
})
