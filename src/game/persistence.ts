import type { GameState } from './types'

const ACTIVE_GAME_KEY = 'red-mahjong-active-v1'
const DB_NAME = 'red-mahjong'
const DB_VERSION = 2
const REPLAY_STORE = 'replays'
const ACTIVE_REPLAY_STORE = 'active-replays'
const DB_MIGRATION_KEY = 'red-mahjong-storage-migrated-v1'
// 牌谱按局分片保存。整场重写一次要写好几 MB，越打越卡；按局写每次只碰当前这一局。
const CHUNK_SEPARATOR = '::r'

// 旧版本名称只用于一次性迁移，避免改名后丢失已有存档与牌谱。
const LEGACY_ACTIVE_GAME_KEY = atob('Z3VhbmdzaGFuLW1haGpvbmctYWN0aXZlLXYx')
const LEGACY_DB_NAME = atob('Z3VhbmdzaGFuLW1haGpvbmc=')

export interface ReplayFrame {
  index: number
  eventCount: number
  state: GameState
  // 牌墙和码区的具体牌面回放时用不到，只存数量，单帧体积能省三成以上。
  wallCount?: number
  maReserveCount?: number
}

export interface ActiveReplayRecord {
  id: string
  startedAt: number
  frames: ReplayFrame[]
}

export interface ActiveReplayChunk {
  id: string
  matchId: string
  round: number
  startedAt: number
  frames: ReplayFrame[]
}

export interface ReplayRecord {
  id: string
  createdAt: number
  completedAt: number
  title: string
  frames: ReplayFrame[]
}

export interface ReplaySummary {
  id: string
  createdAt: number
  completedAt: number
  title: string
  frameCount: number
}

// 存档随局数增长，写满配额时不能直接把异常抛进牌局流程里，只回报失败。
export function saveActiveGame(state: GameState): boolean {
  try {
    localStorage.setItem(ACTIVE_GAME_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function loadActiveGame(): GameState | null {
  const current = localStorage.getItem(ACTIVE_GAME_KEY)
  const legacy = current ? null : localStorage.getItem(LEGACY_ACTIVE_GAME_KEY)
  const raw = current ?? legacy
  if (!raw) return null
  try {
    const state = JSON.parse(raw) as GameState
    if (state.schemaVersion !== 1) return null
    if (legacy) {
      localStorage.setItem(ACTIVE_GAME_KEY, legacy)
      localStorage.removeItem(LEGACY_ACTIVE_GAME_KEY)
    }
    return state
  } catch {
    return null
  }
}

export function clearActiveGame() {
  localStorage.removeItem(ACTIVE_GAME_KEY)
  localStorage.removeItem(LEGACY_ACTIVE_GAME_KEY)
}

function openNamedDatabase(name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name)
    request.onupgradeneeded = () => {
      if (name !== DB_NAME) return
      const database = request.result
      if (!database.objectStoreNames.contains(REPLAY_STORE)) database.createObjectStore(REPLAY_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(ACTIVE_REPLAY_STORE)) database.createObjectStore(ACTIVE_REPLAY_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function storeRecords(database: IDBDatabase, storeName: string): Promise<unknown[]> {
  if (!database.objectStoreNames.contains(storeName)) return []
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function migrateLegacyDatabase(database: IDBDatabase): Promise<void> {
  if (localStorage.getItem(DB_MIGRATION_KEY)) return
  const listDatabases = indexedDB.databases?.bind(indexedDB)
  if (!listDatabases) return
  const databases = await listDatabases()
  if (!databases.some((entry) => entry.name === LEGACY_DB_NAME)) {
    localStorage.setItem(DB_MIGRATION_KEY, '1')
    return
  }
  const legacy = await openNamedDatabase(LEGACY_DB_NAME)
  try {
    const replayRecords = await storeRecords(legacy, REPLAY_STORE)
    const activeReplayRecords = await storeRecords(legacy, ACTIVE_REPLAY_STORE)
    const records = [
      ...replayRecords.map((record) => ({ storeName: REPLAY_STORE, record })),
      ...activeReplayRecords.map((record) => ({ storeName: ACTIVE_REPLAY_STORE, record })),
    ]
    if (records.length) {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([REPLAY_STORE, ACTIVE_REPLAY_STORE], 'readwrite')
        for (const item of records) transaction.objectStore(item.storeName).put(item.record)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
    }
    localStorage.setItem(DB_MIGRATION_KEY, '1')
  } finally {
    legacy.close()
  }
}

async function openDatabase(): Promise<IDBDatabase> {
  const database = await openNamedDatabase(DB_NAME, DB_VERSION)
  await migrateLegacyDatabase(database)
  return database
}

export function activeReplayChunkId(matchId: string, round: number): string {
  return `${matchId}${CHUNK_SEPARATOR}${String(round).padStart(4, '0')}`
}

function chunkRange(matchId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${matchId}${CHUNK_SEPARATOR}`, `${matchId}${CHUNK_SEPARATOR}￿`)
}

export async function saveActiveReplayChunk(chunk: ActiveReplayChunk): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ACTIVE_REPLAY_STORE, 'readwrite')
    transaction.objectStore(ACTIVE_REPLAY_STORE).put(chunk)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function loadActiveReplay(matchId: string): Promise<ActiveReplayRecord | null> {
  const database = await openDatabase()
  const store = database.transaction(ACTIVE_REPLAY_STORE, 'readonly').objectStore(ACTIVE_REPLAY_STORE)
  const chunks = await new Promise<ActiveReplayChunk[]>((resolve, reject) => {
    const request = store.getAll(chunkRange(matchId))
    request.onsuccess = () => resolve(request.result as ActiveReplayChunk[])
    request.onerror = () => reject(request.error)
  })
  // 旧版本把整场牌谱存成一条记录，升级后仍要能接着回放。
  const legacy = chunks.length ? null : await new Promise<ActiveReplayRecord | undefined>((resolve, reject) => {
    const request = store.get(matchId)
    request.onsuccess = () => resolve(request.result as ActiveReplayRecord | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  if (legacy) return legacy
  if (!chunks.length) return null
  const ordered = [...chunks].sort((left, right) => left.round - right.round)
  return {
    id: matchId,
    startedAt: ordered[0].startedAt,
    frames: ordered.flatMap((chunk) => chunk.frames),
  }
}

export async function deleteActiveReplay(matchId: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ACTIVE_REPLAY_STORE, 'readwrite')
    const store = transaction.objectStore(ACTIVE_REPLAY_STORE)
    store.delete(chunkRange(matchId))
    store.delete(matchId)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function saveReplay(record: ReplayRecord): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(REPLAY_STORE, 'readwrite')
    transaction.objectStore(REPLAY_STORE).put(record)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function listReplays(): Promise<ReplaySummary[]> {
  const database = await openDatabase()
  const records = await new Promise<ReplayRecord[]>((resolve, reject) => {
    const request = database.transaction(REPLAY_STORE, 'readonly').objectStore(REPLAY_STORE).getAll()
    request.onsuccess = () => resolve(request.result as ReplayRecord[])
    request.onerror = () => reject(request.error)
  })
  database.close()
  return records
    .map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      title: record.title,
      frameCount: record.frames.length,
    }))
    .sort((a, b) => b.completedAt - a.completedAt)
}

export async function getReplay(id: string): Promise<ReplayRecord | null> {
  const database = await openDatabase()
  const record = await new Promise<ReplayRecord | undefined>((resolve, reject) => {
    const request = database.transaction(REPLAY_STORE, 'readonly').objectStore(REPLAY_STORE).get(id)
    request.onsuccess = () => resolve(request.result as ReplayRecord | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return record ?? null
}

export async function deleteReplay(id: string): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(REPLAY_STORE, 'readwrite')
    transaction.objectStore(REPLAY_STORE).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // 立即回收有的浏览器会来不及取数据，留一秒缓冲。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
