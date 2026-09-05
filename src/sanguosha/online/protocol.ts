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

export type SgsRoomServerMessage =
  | { type: 'room-state'; room: SgsRoomView }
  | { type: 'chat'; message: SgsChatMessage }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number }

export const DEFAULT_SGS_ROOM_SETTINGS: SgsRoomSettings = {
  playerCount: 5,
  difficulty: 'normal',
  turnSeconds: 30,
}
