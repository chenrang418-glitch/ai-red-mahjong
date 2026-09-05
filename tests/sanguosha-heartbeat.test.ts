import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 客户端连接看门狗与待确认队列。
 *
 * 半断开的连接（NAT 映射失效、Wi-Fi 切换、代理变化）里，浏览器仍然认为
 * `readyState === OPEN`，`send` 也不抛异常，`close` 永远不来——重连逻辑
 * 一次都不会触发，这名玩家的画面就永久停在旧状态，用户的体感是
 * 「按键失灵，只能大退」。
 *
 * 主心跳现在由**服务端**主动发：手机把页面切到后台之后 JS 定时器会被节流，
 * 客户端自己发不出心跳，也就发现不了半死连接。客户端这边保留一条辅助探针，
 * 负责探上行方向和「回到前台立刻验一次」。
 *
 * 这个项目的 vitest 跑在 `node` 环境、也没有 @vue/test-utils，所以和
 * `tests/admin-notice.test.ts` 一样用源码结构断言来钉住这些约束——
 * 它们全都是「写法上必须成立」的性质，源码级检查足以防止被改回去。
 */

const source = readFileSync(new URL('../src/sanguosha/composables/useOnlineSanguosha.ts', import.meta.url), 'utf8')

function block(pattern: RegExp): string {
  return source.match(pattern)?.[0] ?? ''
}

describe('连接健康记账', () => {
  it('服务端的**任何**消息都要记时间，不能只记 pong', () => {
    // 只认 pong 的话，服务端主动心跳到达时不算「听到过服务端说话」，
    // 于是明明连接很健康，辅助探针却会把它判成失联
    const messageBlock = block(/addEventListener\('message'[\s\S]*?\n {4}\}\)/)
    expect(messageBlock, '收到任何一帧都要刷新存活时间').toContain('lastServerMessageAt = Date.now()')
    expect(messageBlock.indexOf('lastServerMessageAt = Date.now()'))
      .toBeLessThan(messageBlock.indexOf("event.data === 'pong'"))
  })

  it('open 时初始化，否则第一轮就会误判失联', () => {
    expect(block(/addEventListener\('open'[\s\S]*?\n {4}\}\)/)).toContain('lastServerMessageAt = Date.now()')
  })

  it('关连接时清零，避免旧连接的时间戳影响新连接', () => {
    expect(block(/function closeCurrentSocket\(\)[\s\S]*?\n {2}\}/)).toContain('lastServerMessageAt = 0')
  })

  it('健康判定同时看 socket 状态和服务端静默时长', () => {
    const healthy = block(/function connectionHealthy\(\)[\s\S]*?\n {2}\}/)
    expect(healthy, '光看 readyState 抓不到半死连接').toContain('SERVER_SILENCE_LIMIT_MS')
    expect(healthy).toContain('WebSocket.OPEN')
  })
})

describe('失联判定', () => {
  it('探针里先判静默再发 ping', () => {
    const timer = block(/probeTimer = window\.setInterval\([\s\S]*?\}, CLIENT_PROBE_INTERVAL_MS\)/)
    expect(timer, '静默判定必须在发 ping 之前').toMatch(/!connectionHealthy\(\)[\s\S]*probe\(\)/)
  })

  it('静默后主动关闭连接，交给统一的重连入口', () => {
    const timer = block(/probeTimer = window\.setInterval\([\s\S]*?\}, CLIENT_PROBE_INTERVAL_MS\)/)
    expect(timer).toContain('current.close()')
    // 不能在探针里另起一套重连，否则会和 close 里的重连各来一次
    expect(timer).not.toContain('connectRoom')
  })

  it('静默阈值要留得下两次服务端心跳，又不能久到像卡死', () => {
    const silence = Number(source.match(/SERVER_SILENCE_LIMIT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0)
    const probe = Number(source.match(/CLIENT_PROBE_INTERVAL_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0)
    // 服务端约 4.5 秒一次，连丢两次多一点才判定
    expect(silence).toBeGreaterThanOrEqual(9_000)
    expect(silence, '超过 20 秒的话，用户早就以为按键失灵了').toBeLessThanOrEqual(20_000)
    expect(probe).toBeGreaterThan(0)
    expect(silence).toBeGreaterThan(probe)
  })

  it('建连有超时上限，坏 socket 不会一直占着「连接中」', () => {
    const timeout = Number(source.match(/CONNECT_TIMEOUT_MS = ([\d_]+)/)?.[1]?.replace(/_/g, '') ?? 0)
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThanOrEqual(10_000)
    expect(source).toContain('connectTimeoutTimer')
  })
})

describe('连接竞态', () => {
  it('探针每次都要确认自己还属于当前这一代连接', () => {
    const timer = block(/probeTimer = window\.setInterval\([\s\S]*?\}, CLIENT_PROBE_INTERVAL_MS\)/)
    expect(timer, '定时器可能比它的 socket 活得久').toContain('if (generation !== mine) return')
  })

  it('open / message / close / error 四个回调都有代号守卫', () => {
    for (const event of ['open', 'message', 'close', 'error']) {
      const handler = block(new RegExp(`addEventListener\\('${event}'[\\s\\S]*?\\n {4}\\}\\)`))
      expect(handler, `${event} 回调缺少当前连接守卫`).toContain('generation !== mine')
    }
  })

  it('error 回调只关连接，不在里面重连', () => {
    const handler = block(/addEventListener\('error'[\s\S]*?\n {4}\}\)/)
    expect(handler).toBeTruthy()
    expect(handler).toContain('current.close()')
    // error 之后浏览器一定还会发 close，两处各重连一次会留下两套定时器
    expect(handler).not.toContain('connectRoom')
  })

  it('关连接时清掉重连、探针和建连超时三个定时器', () => {
    const cleanup = block(/function closeCurrentSocket\(\)[\s\S]*?\n {2}\}/)
    expect(cleanup).toContain('clearTimeout(reconnectTimer)')
    expect(cleanup).toContain('clearInterval(probeTimer)')
    expect(cleanup).toContain('clearConnectTimeout()')
    expect(cleanup).toContain('reconnectTimer = null')
    expect(cleanup).toContain('probeTimer = null')
  })

  it('重连只有一个入口，而且同时最多排一个定时器', () => {
    const schedule = block(/function scheduleReconnect\(\)[\s\S]*?\n {2}\}/)
    expect(schedule, '已经排着就不再排第二个').toContain('if (reconnectTimer !== null) return')
    // error / close / 探针超时 / 回到前台四条路径都走这一个入口
    expect(source.match(/scheduleReconnect\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('每次 connectRoom 都先关掉上一条连接', () => {
    expect(block(/function connectRoom\([\s\S]*?\n {4}const url =/)).toContain('closeCurrentSocket()')
  })
})

describe('操作不能悄悄丢掉', () => {
  it('send 不再因为「没连上」直接返回', () => {
    const send = block(/function send\(command: SgsCommandDraft\)[\s\S]*?\n {2}\}/)
    // 老写法：socket 不 OPEN 就设一句错误然后 return——用户看到的就是按键失灵
    expect(send).not.toMatch(/readyState !== WebSocket\.OPEN[\s\S]{0,120}return/)
    expect(send, '先入待确认队列').toContain('pending.set(')
    expect(send, '连接不健康就地开始恢复').toContain('ensureHealthyConnection()')
  })

  it('actionId 只生成一次，重发沿用同一个', () => {
    const send = block(/function send\(command: SgsCommandDraft\)[\s\S]*?\n {2}\}/)
    expect(send).toContain('actionId: crypto.randomUUID()')
    const flush = block(/function flushPending\([\s\S]*?\n {2}\}/)
    expect(flush, '重发必须用原来的 actionId，否则服务端的幂等就形同虚设').toContain('actionId: entry.actionId')
    expect(flush).not.toContain('crypto.randomUUID()')
  })

  it('断线时**不清空**待确认队列', () => {
    const cleanup = block(/function closeCurrentSocket\(\)[\s\S]*?\n {2}\}/)
    expect(cleanup, '清掉就等于把用户已经点下去的操作悄悄丢了').not.toContain('pending.clear()')
  })

  it('待确认队列有上限和过期，不会无限堆积', () => {
    expect(source).toContain('PENDING_MAX')
    expect(source).toContain('PENDING_TTL_MS')
    expect(block(/function flushPending\([\s\S]*?\n {2}\}/)).toContain('PENDING_TTL_MS')
  })

  it('被明确拒绝的操作直接丢弃，不会偷偷补执行', () => {
    const ack = block(/if \(message\.type === 'action-ack'\) \{[\s\S]*?\n {4}\}/)
    expect(ack).toContain('pending.delete(message.actionId)')
    expect(ack).not.toContain('flushPending')
  })
})

describe('重连后以服务端为准', () => {
  it('room-state 是整体覆盖，不是在本地旧状态上打补丁', () => {
    expect(source).toContain('room.value = message.room')
    expect(source).not.toContain('room.value = { ...room.value')
  })

  it('拿到权威状态之后才重发待确认操作', () => {
    const stateBranch = block(/if \(message\.type === 'room-state'\) \{[\s\S]*?\n {4}\}/)
    expect(stateBranch, '连上就发的话用的还是断线前的旧版本').toContain('flushPending(current)')
  })

  it('心跳回执带上本地版本，服务端据此补发丢失的帧', () => {
    const heartbeat = block(/if \(message\.type === 'server-heartbeat'\) \{[\s\S]*?\n {4}\}/)
    expect(heartbeat).toContain('client-heartbeat-ack')
    expect(heartbeat).toContain('lastKnownVersion')
    expect(heartbeat, '反向也要能发现自己落后').toContain('request-sync')
  })
})

describe('页面恢复', () => {
  it('回到前台、网络恢复时立刻验一次连接', () => {
    for (const event of ['visibilitychange', 'online', 'pageshow']) {
      expect(source, `缺少 ${event} 监听`).toContain(event)
    }
    expect(source).toContain('verifyConnectionNow')
  })

  it('监听在卸载时摘掉，不会泄漏', () => {
    const unmount = block(/onBeforeUnmount\(\(\) => \{[\s\S]*?\n {2}\}\)/)
    expect(unmount).toContain('removeEventListener')
  })
})
