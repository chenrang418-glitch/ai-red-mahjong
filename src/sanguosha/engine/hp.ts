import type { EventContext, GameEvent, GameEventName } from './events'
import type { PlayerId, SanguoshaState } from './types'

/**
 * 失去体力的统一入口。
 *
 * **失去体力不是受到伤害**：不触发「受到伤害后」的技能（奸雄、遗计、反馈、刚烈…），
 * 但同样会让体力降到 0 并进入濒死。这两条性质必须一起成立，
 * 少哪一条都会出问题——所以只留这一个入口，技能不要自己减血。
 *
 * 抽出来之前这段逻辑被复制了两份（黄盖【苦肉】里内联一份、夏侯惇【刚烈】旁边一份），
 * 而**苦肉那一份漏了濒死判断**：1 点体力发动苦肉之后 hp 变成 0、
 * `dying` 是 null、`alive` 仍是 true，玩家卡在「0 血活着」的非法状态。
 */
export interface HpEngineHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
  enterDying(playerId: PlayerId): void
}

export function loseHp(host: HpEngineHost, playerId: PlayerId, amount: number, reason: string): void {
  const target = host.state.players.find((player) => player.id === playerId)
  if (!target?.alive) return
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('失去体力值必须是正整数')
  target.hp -= amount
  host.dispatch('LoseHp', { playerId, amount, reason, hp: target.hp }, { targetId: playerId })
  // 体力归零交给统一的濒死入口，技能不自己判死
  if (target.hp <= 0) host.enterDying(playerId)
}
