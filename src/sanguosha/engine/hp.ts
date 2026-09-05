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

/**
 * 减体力上限的统一入口。
 *
 * **不能只写 `player.maxHp -= 1`**，那样会漏掉三件事：
 *
 * 1. **当前体力要跟着裁**。上限降到 4 而体力还是 6 是非法状态，
 *    不变量会直接报「玩家体力非法」。
 * 2. **裁到 0 要进濒死**。上限降到 0 意味着体力也是 0，这时候和失去体力一样
 *    要走统一的濒死入口，技能不自己判死。
 * 3. **手牌上限跟着变**。上限影响不了手牌上限（那看的是当前体力），
 *    但体力被裁下来之后手牌上限就变了，弃牌阶段读的是同一个 `maxCardsOf`，
 *    所以只要体力裁对了这一条自然成立。
 *
 * 减上限**不是失去体力**，不触发 LoseHp 挂着的时机；但体力因为裁剪而下降时
 * 仍然是实打实的变化，所以单独发一条 `MaxHpChange` 让界面和战报跟上。
 */
export function loseMaxHp(host: HpEngineHost, playerId: PlayerId, amount: number, reason: string): void {
  const target = host.state.players.find((player) => player.id === playerId)
  if (!target?.alive) return
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('减体力上限必须是正整数')
  const nextMax = Math.max(0, target.maxHp - amount)
  if (nextMax === target.maxHp) return
  target.maxHp = nextMax
  // 体力不能高于上限：超出的部分直接被裁掉，这不是「失去体力」
  const clamped = Math.min(target.hp, nextMax)
  const trimmed = target.hp - clamped
  target.hp = clamped
  host.dispatch('MaxHpChange', { playerId, maxHp: nextMax, hp: target.hp, amount: -amount, trimmed, reason }, { targetId: playerId })
  // 上限被削到 0（或体力被裁到 0）时和失去体力一样进濒死，不在这里自己判死
  if (target.hp <= 0) host.enterDying(playerId)
}

/**
 * 加体力上限的统一入口。
 *
 * 以前各武将都在直接写 `player.maxHp += 1`（无量、刘禅），
 * 于是界面和战报收不到任何变化通知——`MaxHpChange` 只有减的那一半会发。
 * 加上限本身不回复体力（神孙策 1/3 加 3 点上限是 1/6，不是 4/6），
 * 所以这里只动上限，不碰当前体力。
 *
 * `cap` 给技能自己的封顶用（神郭嘉【慧识】不能把上限顶过 10）。
 * 到顶就当作没加，不发事件。
 */
export function gainMaxHp(host: HpEngineHost, playerId: PlayerId, amount: number, reason: string, cap?: number): void {
  const target = host.state.players.find((player) => player.id === playerId)
  if (!target?.alive) return
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('加体力上限必须是正整数')
  const ceiling = cap ?? Number.POSITIVE_INFINITY
  const nextMax = Math.min(ceiling, target.maxHp + amount)
  if (nextMax <= target.maxHp) return
  const gained = nextMax - target.maxHp
  target.maxHp = nextMax
  host.dispatch('MaxHpChange', { playerId, maxHp: nextMax, hp: target.hp, amount: gained, trimmed: 0, reason }, { targetId: playerId })
}
