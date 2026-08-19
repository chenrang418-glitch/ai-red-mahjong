// 单机存档。网页版用 localStorage，这里换成 wx 的同步存储，
// 存的东西完全一样：一整份 GameState，恢复时交给 GameEngine.restore。
import type { GameState } from '../core/types'

const ACTIVE_GAME_KEY = 'ai-red-mahjong.active-game'

export interface ActiveGameSummary {
  round: number
  matchId: string
  players: Array<{ name: string; isHuman: boolean; score: string }>
  savedAt: number
}

export function saveActiveGame(state: GameState): boolean {
  try {
    wx.setStorageSync(ACTIVE_GAME_KEY, JSON.stringify({ state, savedAt: Date.now() }))
    return true
  } catch {
    // 存储满了或者被禁用，这局照样能打完，只是退出后接不上
    return false
  }
}

export function loadActiveGame(): { state: GameState; savedAt: number } | null {
  try {
    const raw = wx.getStorageSync(ACTIVE_GAME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state: GameState; savedAt: number }
    // 版本对不上就当没有，免得用旧结构去恢复引擎
    if (!parsed.state || parsed.state.schemaVersion !== 1) return null
    return parsed
  } catch {
    return null
  }
}

export function clearActiveGame(): void {
  try {
    wx.removeStorageSync(ACTIVE_GAME_KEY)
  } catch {
    // 删不掉也无所谓，下次开新局会直接覆盖
  }
}

// 首页要显示「上次打到第几局、当时几分」，不用为此把整份存档解析出来给页面
export function readActiveSummary(): ActiveGameSummary | null {
  const saved = loadActiveGame()
  if (!saved) return null
  const { state, savedAt } = saved
  // 整场已经结束的就别再提示继续了
  if (state.phase === 'match-over') return null
  return {
    round: state.round,
    matchId: state.matchId,
    savedAt,
    players: state.players.map((player) => ({
      name: player.name,
      isHuman: player.isHuman,
      score: player.points === null
        ? `${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}`
        : `${player.points}`,
    })),
  }
}
