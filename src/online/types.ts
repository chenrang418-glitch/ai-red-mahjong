import type { ClaimAction, Difficulty, GameState, MatchMode } from '@/game/types'

export type RoomPhase = 'lobby' | 'playing'

export interface OnlineSession {
  token: string
  userId: string
  nickname: string
}

export interface LeaderboardEntry {
  userId: string
  nickname: string
  totalGames: number
  wins: number
  winRate: number
  sevenPairs: number
  gangCount: number
  maCount: number
}

export interface OnlineRoomSettings {
  mode: MatchMode
  initialPoints: number
  claimWindowMs: number
  turnWindowMs: number
  // 空位补的 AI 用什么档位，房主开房时选，默认凡人
  aiDifficulty: Difficulty
  // 掉线托管用什么档位。玩家改不了，只有管理模式能调，默认菜鸡：
  // 托管是帮你顶着别把牌打崩，不该替你打出比你还好的牌。
  trusteeDifficulty: Difficulty
}

export interface OnlineRoomDirectoryPlayer {
  nickname: string
  connected: boolean
  isHost: boolean
  kind: 'human' | 'ai'
  trustee: boolean
}

export interface OnlineRoomDirectoryEntry {
  code: string
  phase: RoomPhase
  joinable: boolean
  hostNickname: string
  players: OnlineRoomDirectoryPlayer[]
  occupiedSeats: number
  availableSeats: number
  settings: OnlineRoomSettings
  updatedAt: number
}

export interface OnlineTurnTimer {
  seatId: number
  startedAt: number
  deadlineAt: number
  kind: 'turn' | 'ai'
}

export type OnlinePendingAction =
  | { type: 'discard'; tileId: string; version: number }
  | { type: 'trustee'; enabled: boolean; version: number }

export interface OnlineSeatView {
  seatId: number
  kind: 'empty' | 'human' | 'ai'
  userId: string | null
  name: string
  connected: boolean
  ready: boolean
  trustee: boolean
  isHost: boolean
}

export interface OnlineLegalActions {
  canDiscard: boolean
  canWin: boolean
  canNextRound: boolean
  canReturnToLobby: boolean
  anGangFaces: string[]
  buGangFaces: string[]
  claimActions: ClaimAction[]
}

export interface ChatMessage {
  id: string
  userId: string
  nickname: string
  text: string
  sentAt: number
  quick: boolean
}

export interface OnlineRoomView {
  code: string
  phase: RoomPhase
  version: number
  hostUserId: string
  selfUserId: string
  selfSeatId: number
  settings: OnlineRoomSettings
  seats: OnlineSeatView[]
  game: GameState | null
  legal: OnlineLegalActions
  deadlineAt: number | null
  turnTimer: OnlineTurnTimer | null
  notice: string
  chat: ChatMessage[]
  // 下发时的服务器时间。deadlineAt 和 turnTimer 都是服务器时间戳，
  // 客户端必须先用它校正本地时钟，否则设备时间不准就会算错剩余秒数。
  serverNow: number
}

export type RoomCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'start-game' }
  | { type: 'leave-room' }
  | { type: 'discard'; tileId: string; actionId: string; version: number }
  | { type: 'win'; actionId: string; version: number }
  | { type: 'gang'; gangType: 'an-gang' | 'bu-gang'; face: string; actionId: string; version: number }
  | { type: 'claim'; action: ClaimAction; actionId: string; version: number }
  | { type: 'pass-claim'; actionId: string; version: number }
  | { type: 'trustee'; enabled: boolean }
  | { type: 'next-round' }
  | { type: 'return-to-lobby' }
  | { type: 'chat'; text: string; quick: boolean }

type WithoutActionMetadata<T> = T extends { actionId: string; version: number }
  ? Omit<T, 'actionId' | 'version'>
  : never

export type RoomActionDraft = WithoutActionMetadata<RoomCommand>

export type RoomServerMessage =
  | { type: 'room-state'; room: OnlineRoomView }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number }

export type LobbyServerMessage =
  | { type: 'rooms-updated'; at: number }

// 房间明确拒绝加入（满员、牌局已开始、房间不存在）时用的 WebSocket 关闭码。
// 客户端据此停止重连并把原因显示出来。放在共享类型里，Worker 入口不能导出普通常量。
export const ROOM_REJECT_CLOSE_CODE = 4001
// 被管理员强制解散，前端据此提示，而不是当成掉线去重连
export const ROOM_CLOSED_BY_ADMIN_CODE = 4002

export const QUICK_CHAT_MESSAGES = ['快点快点', '这也碰？', '你太菜了', '你会不会玩？', '666', '乐乐'] as const
export const QUICK_CHAT_EMOJIS = ['😂', '👍', '😅', '😎', '😡', '😭', '🀄', '🎉'] as const

export const DEFAULT_ONLINE_SETTINGS: OnlineRoomSettings = {
  mode: 'finite',
  initialPoints: 30,
  claimWindowMs: 4000,
  turnWindowMs: 30000,
  aiDifficulty: 'standard',
  trusteeDifficulty: 'beginner',
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  beginner: '菜鸡',
  standard: '凡人',
  expert: '猿神',
}
