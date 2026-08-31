import type { GameResult, Identity, PlayerState } from '../types'

export const identityDistribution: Readonly<Record<5 | 6 | 7 | 8, readonly Identity[]>> = {
  5: ['lord', 'loyalist', 'rebel', 'rebel', 'renegade'],
  6: ['lord', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'],
  7: ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'],
  8: ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'renegade'],
}

export function identitiesFor(playerCount: number): readonly Identity[] {
  if (playerCount < 5 || playerCount > 8 || !Number.isInteger(playerCount)) throw new Error('经典身份局仅支持 5～8 人')
  return identityDistribution[playerCount as 5 | 6 | 7 | 8]
}

export function checkIdentityVictory(players: readonly PlayerState[]): GameResult | null {
  const lord = players.find((player) => player.identity === 'lord')
  if (!lord) throw new Error('身份局缺少主公')
  const alive = players.filter((player) => player.alive)
  const aliveRebels = alive.filter((player) => player.identity === 'rebel')
  const aliveRenegades = alive.filter((player) => player.identity === 'renegade')

  if (!lord.alive) {
    if (alive.length === 1 && alive[0].identity === 'renegade') {
      return { winningCamp: 'renegade', winnerIds: [alive[0].id], reason: '内奸清除其他角色后击败主公' }
    }
    return {
      winningCamp: 'rebel',
      winnerIds: players.filter((player) => player.identity === 'rebel').map((player) => player.id),
      reason: '主公死亡，反贼获胜',
    }
  }

  if (aliveRebels.length === 0 && aliveRenegades.length === 0) {
    return {
      winningCamp: 'lord',
      winnerIds: players.filter((player) => player.identity === 'lord' || player.identity === 'loyalist').map((player) => player.id),
      reason: '反贼和内奸全部死亡，主忠阵营获胜',
    }
  }
  return null
}

export const identityMode = {
  id: 'identity' as const,
  name: '经典身份局',
  minPlayers: 5,
  maxPlayers: 8,
  identitiesFor,
  checkVictory: checkIdentityVictory,
}
