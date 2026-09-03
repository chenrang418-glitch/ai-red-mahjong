import { skillIdsOf } from '../data/characters/standard'
import type { EventContext, GameEvent, GameEventName } from './events'
import { skillsOf } from './skills/runtime'
import type { CardId, EquipmentSlot, PlayerId, PlayerState, SanguoshaState } from './types'
import { moveCard } from './zones'

/**
 * 死亡角色的牌归谁。
 *
 * 曹丕【行殇】要「获得死亡角色的所有牌」，而**牌不能先进弃牌堆再捡回来**：
 * 那样牌的来源语义全丢了，途中还会触发一批本不该触发的时机。
 *
 * 但死亡结算是同步的一整段（`resolveDeath`），中间没法停下来问人。所以拆成两步：
 *
 * 1. 死亡清牌**之前**先问一句「有人要吗」。有人要就把牌暂存到处理区，
 *    并在 `state.deathClaim` 里记下来；没人要就照常全部进弃牌堆。
 * 2. `Death` 事件派发之后，认领者的技能自己 `queueSkill` 去问玩家要不要拿。
 *    拿 → 牌从处理区进他手牌；不拿 / 前提没了 → 走 `releaseDeathCards` 全进弃牌堆。
 *
 * **处理区里绝不能留下没人管的牌**，所以每一条退出路径都要落到
 * `releaseDeathCards`：技能放弃、认领者自己也死了、牌局直接结束。
 */

const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

export interface DeathClaimHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

/**
 * 谁来认领这名死亡角色的牌。
 *
 * 按**座次**遍历，第一个声明认领的人拿走，结果稳定。多个同类技能同时在场时
 * 不会出现「两个人都拿到同一张牌」——认领者只有一个，牌也只搬一次。
 * 死人不认领，死者自己更不认领自己。
 */
export function deathCardClaimantOf(
  state: SanguoshaState,
  deadId: PlayerId,
): { playerId: PlayerId; skillId: string } | null {
  for (const owner of state.players) {
    if (!owner.alive || !owner.characterId || owner.id === deadId) continue
    for (const runtime of skillsOf(state, owner.id, skillIdsOf)) {
      if (runtime.claimsDeathCards?.(state, owner.id, deadId)) return { playerId: owner.id, skillId: runtime.id }
    }
  }
  return null
}

/** 死亡角色区域里的全部牌：手牌 + 装备区 + 判定区。 */
export function ownedCardsOf(owner: PlayerState): CardId[] {
  return [
    ...owner.zones.hand,
    ...EQUIPMENT_SLOTS.map((slot) => owner.zones.equipment[slot]).filter((cardId): cardId is CardId => Boolean(cardId)),
    ...owner.zones.judgingArea,
  ]
}

/**
 * 把死亡角色的牌暂存到处理区，等认领者做决定。
 *
 * 牌**没有**进弃牌堆，所以之后交给认领者时不算「从弃牌堆捡回来」。
 */
export function holdDeathCards(host: DeathClaimHost, owner: PlayerState, claimant: { playerId: PlayerId; skillId: string }): void {
  const held: CardId[] = []
  for (const cardId of owner.zones.hand.slice()) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'processingArea' })
    held.push(cardId)
  }
  for (const slot of EQUIPMENT_SLOTS) {
    const cardId = owner.zones.equipment[slot]
    if (!cardId) continue
    moveCard(host.state, cardId, { kind: 'equipment', playerId: owner.id, slot }, { kind: 'processingArea' })
    held.push(cardId)
  }
  for (const cardId of owner.zones.judgingArea.slice()) {
    moveCard(host.state, cardId, { kind: 'judgingArea', playerId: owner.id }, { kind: 'processingArea' })
    held.push(cardId)
  }
  host.state.deathClaim = held.length > 0
    ? { deadId: owner.id, claimantId: claimant.playerId, skillId: claimant.skillId, cardIds: held }
    : null
}

/** 暂存的牌现在还有哪些真的在处理区里。中途被别的效果挪走的不算。 */
export function heldDeathCards(state: SanguoshaState): CardId[] {
  const claim = state.deathClaim
  if (!claim) return []
  return claim.cardIds.filter((cardId) => state.zones.processingArea.includes(cardId))
}

/**
 * 认领者拿走暂存的牌。
 *
 * 返回真正拿到的牌。拿完一定要清 `deathClaim`，否则处理区会留下一个
 * 永远等不到答复的挂账。
 */
export function claimDeathCards(host: DeathClaimHost, claimantId: PlayerId, reason: string): CardId[] {
  const taken = heldDeathCards(host.state)
  const claimant = host.state.players.find((candidate) => candidate.id === claimantId)
  if (!claimant?.alive || taken.length === 0) {
    releaseDeathCards(host)
    return []
  }
  for (const cardId of taken) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: claimantId })
  }
  host.state.deathClaim = null
  host.dispatch('GainCard', { playerId: claimantId, cardIds: taken, reason }, { targetId: claimantId, cardIds: taken })
  return taken
}

/**
 * 没人拿：暂存的牌全部进弃牌堆，回到「正常死亡清牌」的结果。
 *
 * 每一条放弃路径都必须走这里，包括牌局直接结束的那条——
 * 处理区里留着无主的牌会让牌张守恒之外的一切判断都变得不可信。
 */
export function releaseDeathCards(host: DeathClaimHost): void {
  const remaining = heldDeathCards(host.state)
  for (const cardId of remaining) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
  host.state.deathClaim = null
}
