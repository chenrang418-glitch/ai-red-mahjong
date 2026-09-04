import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 客户端 WebSocket 心跳看门狗。
 *
 * 半断开的连接（NAT 映射失效、Wi-Fi 切换、代理变化）里，浏览器仍然认为
 * `readyState === OPEN`，`send` 也不抛异常，`close` 永远不来——重连逻辑
 * 一次都不会触发，这名玩家的画面就永久停在旧状态。
 *
 * 这个项目的 vitest 跑在 `node` 环境、也没有 @vue/test-utils，所以和
 * `tests/admin-notice.test.ts`、`tests/project-notice-components.test.ts`
 * 一样用源码结构断言来钉住这些约束——它们全都是「写法上必须成立」的性质，
 * 源码级检查足以防止被改回去。
 */

const source = readFileSync(new URL('../src/sanguosha/composables/useOnlineSanguosha.ts', import.meta.url), 'utf8')

describe('心跳记账', () => {
  it('收到 pong 必须记时间，不能直接丢掉', () => {
    // 老写法是 `if (socket !== current || event.data === 'pong') return`，
    // pong 被和「不是当前 socket」合并成一条 return，等于没有心跳
    expect(source).not.toMatch(/event\.data === 'pong'\)\s*return\s*$/m)
    const pongBranch = source.match(/if \(event\.data === 'pong'\) \{[\s\S]*?\}/)?.[0] ?? ''
    expect(pongBranch, '收到 pong 要更新 lastPongAt').toContain('lastPongAt = Date.now()')
  })

  it('open 时初始化 lastPongAt，否则第一轮就会误判失联', () => {
    const openBlock = source.match(/addEventListener\('open'[\s\S]*?\n {4}\}\)/)?.[0] ?? ''
    expect(openBlock).toContain('lastPongAt = Date.now()')
  })

  it('cleanup 时清零，避免旧连接的时间戳影响新连接', () => {
    const cleanup = source.match(/function cleanupSocket\(\)[\s\S]*?\n {2}\}/)?.[0] ?? ''
    expect(cleanup).toContain('lastPongAt = 0')
  })
})

describe('失联判定', () => {
  it('心跳定时器里先判超时再发 ping', () => {
    expect(source).toContain('HEARTBEAT_TIMEOUT_MS')
    expect(source).toMatch(/Date\.now\(\) - lastPongAt/)
    const timer = source.match(/heartbeatTimer = window\.setInterval\([\s\S]*?\}, HEARTBEAT_INTERVAL_MS\)/)?.[0] ?? ''
    expect(timer, '超时判定必须在发 ping 之前').toMatch(/silence > HEARTBEAT_TIMEOUT_MS[\s\S]*current\.send\('ping'\)/)
  })

  it('超时后主动关闭连接，交给既有的 close → reconnect 那一条路', () => {
    const timer = source.match(/heartbeatTimer = window\.setInterval\([\s\S]*?\}, HEARTBEAT_INTERVAL_MS\)/)?.[0] ?? ''
    expect(timer).toContain('current.close()')
    // 不能在心跳里另起一套重连，否则会和 close 里的重连各来一次
    expect(timer).not.toContain('connectRoom')
  })

  it('超时阈值不低于 25 秒，否则正常网络抖动会被误判', () => {
    const interval = Number(source.match(/HEARTBEAT_INTERVAL_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0)
    const timeout = Number(source.match(/HEARTBEAT_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0)
    expect(interval).toBeGreaterThanOrEqual(10_000)
    expect(timeout).toBeGreaterThanOrEqual(25_000)
    expect(timeout, '超时至少要留两个心跳间隔的余量').toBeGreaterThan(interval * 2)
  })
})

describe('连接竞态', () => {
  it('心跳定时器每次都要确认自己还属于当前 socket', () => {
    const timer = source.match(/heartbeatTimer = window\.setInterval\([\s\S]*?\}, HEARTBEAT_INTERVAL_MS\)/)?.[0] ?? ''
    expect(timer, '定时器可能比它的 socket 活得久').toContain('if (socket !== current) return')
  })

  it('open / message / close / error 四个回调都有 socket !== current 守卫', () => {
    for (const event of ['open', 'message', 'close', 'error']) {
      const block = source.match(new RegExp(`addEventListener\\('${event}'[\\s\\S]*?\\n {4}\\}\\)`))?.[0] ?? ''
      expect(block, `${event} 回调缺少当前连接守卫`).toContain('socket !== current')
    }
  })

  it('补上了 error 回调，而且不在里面重连', () => {
    const block = source.match(/addEventListener\('error'[\s\S]*?\n {4}\}\)/)?.[0] ?? ''
    expect(block).toBeTruthy()
    expect(block).toContain('current.close()')
    // error 之后浏览器一定还会发 close，两处各重连一次会留下两套定时器
    expect(block).not.toContain('connectRoom')
  })

  it('cleanupSocket 同时清掉重连和心跳定时器，反复重连不会堆积', () => {
    const cleanup = source.match(/function cleanupSocket\(\)[\s\S]*?\n {2}\}/)?.[0] ?? ''
    expect(cleanup).toContain('clearTimeout(reconnectTimer)')
    expect(cleanup).toContain('clearInterval(heartbeatTimer)')
    expect(cleanup).toContain('reconnectTimer = null')
    expect(cleanup).toContain('heartbeatTimer = null')
  })

  it('每次 connectRoom 都先 cleanup，不会留下上一条连接', () => {
    const connect = source.match(/function connectRoom\([\s\S]*?\n {4}const url =/)?.[0] ?? ''
    expect(connect).toContain('cleanupSocket()')
  })
})

describe('重连后以服务端为准', () => {
  it('room-state 是整体覆盖，不是在本地旧状态上打补丁', () => {
    expect(source).toContain("if (message.type === 'room-state') room.value = message.room")
  })
})
