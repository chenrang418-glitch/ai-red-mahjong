import type { AIDifficulty } from '../ai'
import type { PlayerView } from '../engine/view'
import type { PresentationEvent } from '../engine/presentation'

export interface SgsRoomSettings {
  playerCount: number
  difficulty: AIDifficulty
  turnSeconds: number
}

export interface SgsChatMessage {
  id: number
  userId: string
  /**
   * 说话人的座位号。
   *
   * 房间视图里的座位是按观看者脱敏过的，不带 userId，客户端没法自己反查是谁说的。
   * 靠昵称匹配不严谨，所以由服务端直接带上——牌桌上的气泡要挂到具体座位。
   * 旧的持久化消息没有这个字段，但气泡只在实时帧上冒，取不到就不冒。
   */
  seatId?: number
  nickname: string
  text: string
  at: number
}

/**
 * 快捷短语。和麻将同一套思路：牌局中打字来不及，常用的几句直接一点就发。
 * 表情单独一行，按钮做得方一点，手机上才点得准。
 */
export const SGS_QUICK_CHAT_MESSAGES = [
  '快点快点', '你会不会玩？', '666', '乐乐', '我是良民', '相信我',
] as const

export const SGS_QUICK_CHAT_EMOJIS = ['😂', '👍', '😅', '😎', '😡', '😭', '⚔️', '🎉'] as const

export interface SgsActionMetadata {
  actionId?: string
  baseSeq?: number
}

export type SgsRoomCommand =
  | ({ type: 'toggle-ready' } & SgsActionMetadata)
  | ({ type: 'add-ai' } & SgsActionMetadata)
  | ({ type: 'remove-ai'; seatId: number } & SgsActionMetadata)
  | ({ type: 'start-game' } & SgsActionMetadata)
  | ({ type: 'respond'; requestId: string; payload: unknown } & SgsActionMetadata)
  | ({ type: 'act'; legalActionId: string } & SgsActionMetadata)
  | ({ type: 'advance' } & SgsActionMetadata)
  | ({ type: 'chat'; text: string } & SgsActionMetadata)
  | ({ type: 'trustee'; enabled: boolean } & SgsActionMetadata)
  | ({ type: 'next-round' } & SgsActionMetadata)
  | ({ type: 'leave-room' } & SgsActionMetadata)

type WithoutActionMetadata<T> = T extends SgsActionMetadata ? Omit<T, 'actionId' | 'baseSeq'> : never
export type SgsCommandDraft = WithoutActionMetadata<SgsRoomCommand>

/**
 * 一个座位正在被等待的计时。
 *
 * `kind` 决定表现强度，不决定规则：
 * - `action`   自己的出牌阶段，最长的那个窗口
 * - `response` 被要求响应（闪、桃、弃牌、技能询问……）
 * - `claim`    抢答窗口（无懈可击、濒死求桃），只有几秒
 * - `pick-general` 选将
 *
 * `ai` 为真表示这个座位由电脑或托管驱动。**窗口长度按真人同样的口径给**，
 * 好让牌桌上每一家的计时看起来是同一套；但 AI 实际什么时候落子由它自己的
 * 节奏决定，通常远早于 `deadlineAt`，到时候这一项就直接消失了。
 */
export type SgsTimerKind = 'action' | 'response' | 'claim' | 'pick-general'

export interface SgsSeatTimer {
  seatId: number
  startedAt: number
  deadlineAt: number
  kind: SgsTimerKind
  ai: boolean
}

export interface SgsRoomView {
  code: string
  version: number
  phase: 'lobby' | 'playing' | 'finished'
  hostUserId: string
  settings: SgsRoomSettings
  seats: Array<{
    seatId: number
    kind: 'empty' | 'human' | 'ai'
    name: string
    connected: boolean
    ready: boolean
    trustee: boolean
    leftRoom: boolean
    nextRoundReady: boolean
    isSelf: boolean
  }>
  playerView: PlayerView | null
  chat: SgsChatMessage[]
  log: string[]
  presentationEvents: PresentationEvent[]
  /**
   * 当前**被强制执行**的真人截止时刻。保留给旧路径和测试用；
   * 牌桌上要显示的是下面的 `timers`，那里每一家都有自己的一项。
   */
  deadlineAt: number | null
  /** 此刻所有正在被等待的座位，含 AI。牌桌按座位各画各的。 */
  timers: SgsSeatTimer[]
  /**
   * 下发这一帧时的服务器时间。
   *
   * `deadlineAt` 是服务器时间戳，客户端拿本地 `Date.now()` 直接相减的话，
   * 设备时钟差多少，倒计时就多显示（或少显示）多少秒——这正是
   * 「设置 30 秒、实际能操作 33~34 秒」的成因。客户端必须先用它校正。
   */
  serverNow: number
  aiThinking: boolean
}

export interface SgsRoomDirectoryEntry {
  code: string
  phase: SgsRoomView['phase']
  hostNickname: string
  players: Array<{ nickname: string; connected: boolean; isHost: boolean; kind: 'human' | 'ai'; trustee: boolean }>
  occupiedSeats: number
  availableSeats: number
  settings: SgsRoomSettings
  rejoinable: boolean
  joinable: boolean
  updatedAt: number
}

/**
 * 服务端主动心跳。
 *
 * 为什么不能只靠客户端 `setInterval` 发 ping：手机浏览器把页面切到后台之后
 * JS 定时器会被节流甚至冻结，客户端自己发不出心跳，也就永远发现不了
 * 「socket 还是 OPEN、数据其实已经不通」这种半死连接。服务端主动发才是主机制。
 *
 * 它同时兼三件事：把 Durable Object 维持在热状态、探活两个方向的链路、
 * 顺路把当前房间版本捎给客户端做漂移检测。
 */
export interface SgsServerHeartbeat {
  type: 'server-heartbeat'
  heartbeatId: number
  serverNow: number
  roomVersion: number
}

/**
 * 一条指令的处理回执。
 *
 * 没有它的话，客户端只能靠「下一帧房间状态好像变了」来猜按钮有没有生效——
 * 而房间状态因为 AI 走子、聊天、别人进出也会变，猜不准。
 *
 * `duplicate` 为真表示这个 `actionId` 之前已经执行过，这次**没有再执行一遍**。
 * 客户端因为没收到回执而原样重发时走的就是这条路。
 */
export interface SgsActionAck {
  type: 'action-ack'
  actionId: string
  accepted: boolean
  duplicate?: boolean
  reason?: string
  serverVersion: number
  serverReceivedAt: number
  serverProcessedAt: number
}

export type SgsRoomServerMessage =
  | { type: 'room-state'; room: SgsRoomView }
  | { type: 'chat'; message: SgsChatMessage }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number }
  | SgsServerHeartbeat
  | SgsActionAck

/**
 * 不改变房间状态的连接层消息，走在 `SgsRoomCommand` 之外。
 *
 * 它们不能混进 `SgsRoomCommand`：那套指令一律要过 `actionId`/`baseSeq` 校验
 * 和幂等记账，而心跳回执和补包请求既不该占用 actionId 额度，也不该被去重挡掉。
 */
export type SgsConnectionMessage =
  | { type: 'client-heartbeat-ack'; heartbeatId: number; lastKnownVersion: number }
  | { type: 'request-sync'; lastKnownVersion?: number }

export const DEFAULT_SGS_ROOM_SETTINGS: SgsRoomSettings = {
  playerCount: 5,
  difficulty: 'normal',
  turnSeconds: 30,
}
