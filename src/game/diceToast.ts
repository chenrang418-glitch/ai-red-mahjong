import type { GameState } from './types'

const STORAGE_KEY = 'mahjong.shown-dice-events'
// 只需要记住最近几场；再多就是白占 sessionStorage。
const MAX_REMEMBERED = 8

/**
 * 找出这一场的投骰事件。整场只在开局前投一次骰用来定首庄，
 * 所以事件流里最后一条 dice 就是它。
 *
 * 注意不要用 state.diceRolls 判断：那个字段整场都留着，
 * 第二局往后它里面装的仍然是第一局的旧点数。
 */
export function diceEventId(state: GameState | null | undefined): string | null {
  const events = state?.events
  if (!events?.length) return null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'dice') return event.id
  }
  return null
}

/** sessionStorage 的最小子集，测试里可以传个假的进来。 */
export interface DiceToastMemory {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// 隐私模式、非浏览器环境下退回内存，功能照常，只是关掉标签页就忘了。
const inMemory = new Map<string, string>()
const memoryStore: DiceToastMemory = {
  getItem: (key) => inMemory.get(key) ?? null,
  setItem: (key, value) => { inMemory.set(key, value) },
}

export function defaultDiceToastMemory(): DiceToastMemory {
  try {
    if (typeof sessionStorage === 'undefined') return memoryStore
    // Safari 隐私模式下 sessionStorage 存在但写入会抛，先探一次再用
    const probe = `${STORAGE_KEY}.probe`
    sessionStorage.setItem(probe, '1')
    sessionStorage.removeItem(probe)
    return sessionStorage
  } catch {
    return memoryStore
  }
}

function readShown(store: DiceToastMemory): string[] {
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    // 存的内容坏了就当没弹过，最多多弹一次，不该让界面崩在这
    return []
  }
}

/**
 * 这次投骰该不该弹。第一次问返回 true 并记下来，之后同一个事件一律返回 false。
 *
 * 记在 sessionStorage 而不是组件里，是因为组件会跟着房间视图反复挂载：
 * 回大厅再进来、刷新页面、断线重连拿到整份 GameState，都会重建组件实例，
 * 组件内部的变量拦不住这些情况下的重复弹窗。
 */
export function claimDiceEvent(
  eventId: string | null,
  store: DiceToastMemory = defaultDiceToastMemory(),
): boolean {
  if (!eventId) return false
  const shown = readShown(store)
  if (shown.includes(eventId)) return false
  try {
    store.setItem(STORAGE_KEY, JSON.stringify([...shown, eventId].slice(-MAX_REMEMBERED)))
  } catch {
    // 写不进去也照样弹这一次，不然反而变成每次都不弹
  }
  return true
}

/** 仅供测试使用：清掉「已经弹过」的记录。 */
export function resetDiceToastMemory(store: DiceToastMemory = defaultDiceToastMemory()): void {
  try {
    store.setItem(STORAGE_KEY, '[]')
  } catch {
    // 清不掉就算了
  }
}
