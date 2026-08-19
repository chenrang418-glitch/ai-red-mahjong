// 牌谱。网页版用 IndexedDB 按局分块存，小程序没有 IndexedDB，
// 改成一场一个 key：`replay.<id>`，另有一个索引 key 存摘要列表。
// 只留最近十场——storage 总共就 10MB，存太多迟早写不进去。
import type { GameState } from '../core/types'

const INDEX_KEY = 'ai-red-mahjong.replay-index'
const RECORD_PREFIX = 'ai-red-mahjong.replay.'
const ACTIVE_KEY = 'ai-red-mahjong.replay-active'
const MAX_REPLAYS = 10
// 一场牌局的帧数上限。超了丢最早的，回放看的是后半段更有用。
const MAX_FRAMES = 1200

export interface ReplayFrame {
  index: number
  eventCount: number
  state: GameState
  // 牌墙和码区回放时只看剩几张，牌面本身丢掉，单帧能省三成体积
  wallCount: number
  maReserveCount: number
}

export interface ReplaySummary {
  id: string
  title: string
  createdAt: number
  completedAt: number
  frameCount: number
  rounds: number
}

export interface ReplayRecord extends ReplaySummary {
  frames: ReplayFrame[]
}

function readIndex(): ReplaySummary[] {
  try {
    const raw = wx.getStorageSync(INDEX_KEY)
    return raw ? JSON.parse(raw) as ReplaySummary[] : []
  } catch {
    return []
  }
}

function writeIndex(list: ReplaySummary[]): void {
  try {
    wx.setStorageSync(INDEX_KEY, JSON.stringify(list))
  } catch {
    // 索引写不进去就当没有牌谱，不影响打牌
  }
}

export function listReplays(): ReplaySummary[] {
  return readIndex().sort((left, right) => right.completedAt - left.completedAt)
}

export function getReplay(id: string): ReplayRecord | null {
  try {
    const raw = wx.getStorageSync(RECORD_PREFIX + id)
    return raw ? JSON.parse(raw) as ReplayRecord : null
  } catch {
    return null
  }
}

export function deleteReplay(id: string): void {
  try {
    wx.removeStorageSync(RECORD_PREFIX + id)
  } catch {
    // 忽略
  }
  writeIndex(readIndex().filter((item) => item.id !== id))
}

export function saveReplay(record: ReplayRecord): boolean {
  try {
    wx.setStorageSync(RECORD_PREFIX + record.id, JSON.stringify(record))
  } catch {
    // 存不下就别往索引里加，免得点进去是空的
    return false
  }
  const next = [
    { ...toSummary(record) },
    ...readIndex().filter((item) => item.id !== record.id),
  ].sort((left, right) => right.completedAt - left.completedAt)

  // 超出十场就把最早的连记录一起删掉
  for (const stale of next.slice(MAX_REPLAYS)) {
    try {
      wx.removeStorageSync(RECORD_PREFIX + stale.id)
    } catch {
      // 忽略
    }
  }
  writeIndex(next.slice(0, MAX_REPLAYS))
  return true
}

function toSummary(record: ReplayRecord): ReplaySummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    frameCount: record.frames.length,
    rounds: record.rounds,
  }
}

// —— 进行中的牌谱 ——
// 每一步都往里塞一帧，整场结束时转成正式牌谱。
export function appendActiveFrame(matchId: string, state: GameState): void {
  const active = readActive()
  const record = active && active.matchId === matchId
    ? active
    : { matchId, startedAt: Date.now(), frames: [] as ReplayFrame[] }

  const previous = record.frames[record.frames.length - 1]
  const eventCount = state.events.length
  // 事件数和阶段都没变说明这一步没实质变化，不重复记
  if (previous && previous.eventCount === eventCount && previous.state.phase === state.phase) return

  const frameState = JSON.parse(JSON.stringify(state)) as GameState
  const wallCount = frameState.wall.length
  const maReserveCount = frameState.maReserve.length
  // 回放只需要最后一条事件和近几笔流水，其余是历史包袱
  frameState.events = frameState.events.slice(-1)
  frameState.transfers = frameState.transfers.slice(-8)
  frameState.wall = []
  frameState.maReserve = []

  record.frames.push({ index: record.frames.length, eventCount, state: frameState, wallCount, maReserveCount })
  if (record.frames.length > MAX_FRAMES) record.frames.splice(0, record.frames.length - MAX_FRAMES)
  writeActive(record)
}

interface ActiveReplay {
  matchId: string
  startedAt: number
  frames: ReplayFrame[]
}

function readActive(): ActiveReplay | null {
  try {
    const raw = wx.getStorageSync(ACTIVE_KEY)
    return raw ? JSON.parse(raw) as ActiveReplay : null
  } catch {
    return null
  }
}

function writeActive(record: ActiveReplay): void {
  try {
    wx.setStorageSync(ACTIVE_KEY, JSON.stringify(record))
  } catch {
    // 写不下就放弃这一场的牌谱，牌局本身不受影响
  }
}

export function clearActiveReplay(): void {
  try {
    wx.removeStorageSync(ACTIVE_KEY)
  } catch {
    // 忽略
  }
}

// 整场打完，把进行中的牌谱转成正式记录
export function finishActiveReplay(matchId: string, state: GameState): void {
  const active = readActive()
  if (!active || active.matchId !== matchId || !active.frames.length) return
  const ranking = [...state.players].sort((left, right) => (
    (right.points ?? right.stats.netPoints) - (left.points ?? left.stats.netPoints)
  ))
  saveReplay({
    id: matchId,
    title: `${ranking[0] ? ranking[0].name : '无人'}领先 · 共${state.round}局`,
    createdAt: active.startedAt,
    completedAt: Date.now(),
    frameCount: active.frames.length,
    rounds: state.round,
    frames: active.frames,
  })
  clearActiveReplay()
}

// —— 导出 / 导入 ——
// 小程序没法直接存文件到本地，走剪贴板最省事，也方便贴到聊天里发人。
export function exportReplay(id: string): string | null {
  const record = getReplay(id)
  if (!record) return null
  return JSON.stringify({ format: 'ai-red-mahjong-replay', version: 1, record })
}

export function importReplay(text: string): { ok: boolean; message: string } {
  let parsed: { format?: string; version?: number; record?: ReplayRecord }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    return { ok: false, message: '这段内容不是牌谱' }
  }
  if (parsed.format !== 'ai-red-mahjong-replay' || !parsed.record) {
    return { ok: false, message: '这段内容不是牌谱' }
  }
  const record = parsed.record
  if (!Array.isArray(record.frames) || !record.frames.length) {
    return { ok: false, message: '牌谱是空的' }
  }
  // 导入别人的牌谱时换个 id，免得和自己同名的那场互相覆盖
  const imported: ReplayRecord = {
    ...record,
    id: `${record.id}-in${Date.now().toString(36)}`,
    completedAt: record.completedAt || Date.now(),
  }
  return saveReplay(imported)
    ? { ok: true, message: `已导入：${imported.title}` }
    : { ok: false, message: '存不下了，先删几场旧的' }
}
