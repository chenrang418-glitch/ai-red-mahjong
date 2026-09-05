import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { reactive, toRaw } from 'vue'

describe('麻将真人出牌回归', () => {
  it('乐观牌面先解除 Vue Proxy 再克隆', () => {
    const game = reactive({ players: [{ hand: [{ id: 'tile-1' }], discards: [] }] })
    expect(() => structuredClone(game)).toThrow()
    expect(structuredClone(toRaw(game))).toEqual({ players: [{ hand: [{ id: 'tile-1' }], discards: [] }] })

    const source = readFileSync('src/components/online/OnlineRoom.vue', 'utf8')
    expect(source).toContain('structuredClone(toRaw(game))')
    expect(source).toContain('structuredClone(toRaw(tile))')
  })

  it('麻将房间广播隔离已经断开的连接', () => {
    const source = readFileSync('server/worker.ts', 'utf8')
    expect(source).toContain("console.error('[mahjong][socket-send-error]'")
    expect(source).toContain("socket.close(1011, 'send failed')")
  })
})
