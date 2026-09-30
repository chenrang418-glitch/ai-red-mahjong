import type { EquipmentSlot, PlayerId, SanguoshaState } from './types'

/**
 * 装备栏的「废除 / 恢复」。
 *
 * 神张辽【夺锐】要的：废除自己的一个装备栏换取对手的一个技能，
 * 【止啼】再把废除的栏恢复回来。
 *
 * 这不是「把装备拆掉」——**栏本身没了**：
 *
 * - 栏里原来有牌的，牌按正常规则离开装备区（走 `handleEquipmentLost`，
 *   枭姬、白银狮子照常触发）。
 * - 之后**不能再往这个栏装备牌**。
 * - 武器栏被废除时武器不存在，攻击范围随之变化。
 * - 界面上要灰掉 / 标注「废除」，不能直接把栏藏起来——
 *   玩家必须知道这个栏没了，而不是以为它是空的。
 *
 * **当前【夺锐】只能废除四个栏**：武器、防具、+1 坐骑、-1 坐骑。
 * 将来若有宝物栏，本版夺锐不允许选它，所以可废除的集合由调用方给，
 * 这个模块只管记账。
 */

/** 夺锐能废除的四个栏。宝物栏不在内。 */
export const ABOLISHABLE_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const

export const SLOT_LABELS: Record<EquipmentSlot, string> = {
  weapon: '武器栏',
  weapon2: '第二武器栏',
  armor: '防具栏',
  offensiveHorse: '-1 坐骑栏',
  defensiveHorse: '+1 坐骑栏',
  treasure: '宝物栏',
}

/** 基础装备栏：每个角色开局都有这四个。 */
const BASE_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse'] as const

/**
 * 给某名角色开一个额外武器栏（神典韦【捐甲】）。
 *
 * **是真的多一栏**，不是「攻击范围按两把算」这种界面说法：
 * 这一栏能独立装备一张武器牌，也能被独立替换。
 */
export function grantExtraWeaponSlot(state: SanguoshaState, playerId: PlayerId): boolean {
  state.extraWeaponSlots ??= []
  if (state.extraWeaponSlots.includes(playerId)) return false
  state.extraWeaponSlots.push(playerId)
  return true
}

export function hasExtraWeaponSlot(state: SanguoshaState, playerId: PlayerId): boolean {
  return (state.extraWeaponSlots ?? []).includes(playerId)
}

/**
 * 这名角色**现在实际拥有**哪些装备栏：基础四栏去掉废除的，再加上额外武器栏。
 *
 * 凡是要遍历「他的装备」的地方都走这里，不要各自写一份四元组——
 * 写死四元组的地方，第二武器栏里的牌就成了隐形的。
 */
export function equipmentSlotsOf(state: SanguoshaState, playerId: PlayerId): EquipmentSlot[] {
  const slots = hasExtraWeaponSlot(state, playerId) ? [...BASE_SLOTS, 'weapon2' as EquipmentSlot] : [...BASE_SLOTS]
  return slots.filter((slot) => !isSlotAbolished(state, playerId, slot))
}

/** 这名角色装备区里现有的牌，按栏的顺序。 */
export function equippedCardsOf(state: SanguoshaState, playerId: PlayerId): string[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  return equipmentSlotsOf(state, playerId)
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is string => !!cardId)
}

/** 这名角色现在装备着的武器牌（可能有两把）。 */
export function weaponCardsOf(state: SanguoshaState, playerId: PlayerId): string[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) return []
  return equipmentSlotsOf(state, playerId)
    .filter((slot) => slot === 'weapon' || slot === 'weapon2')
    .map((slot) => player.zones.equipment[slot])
    .filter((cardId): cardId is string => !!cardId)
}

function slotsOf(state: SanguoshaState, playerId: PlayerId): EquipmentSlot[] {
  return (state.abolishedSlots?.[playerId] ?? []) as EquipmentSlot[]
}

/** 这个栏是不是已经被废除了。 */
export function isSlotAbolished(state: SanguoshaState, playerId: PlayerId, slot: EquipmentSlot): boolean {
  return slotsOf(state, playerId).includes(slot)
}

/** 这名角色所有已废除的栏。 */
export function abolishedSlotsOf(state: SanguoshaState, playerId: PlayerId): EquipmentSlot[] {
  return [...slotsOf(state, playerId)]
}

/** 还能废除哪些栏（夺锐用）。已经废除的不能再废除一次。 */
export function abolishableSlotsOf(state: SanguoshaState, playerId: PlayerId): EquipmentSlot[] {
  return ABOLISHABLE_SLOTS.filter((slot) => !isSlotAbolished(state, playerId, slot))
}

/**
 * 废除一个栏。**只记账**，栏里的牌怎么离场由调用方按正常规则处理——
 * 那需要 `EquipmentHost`，放进来会形成 import 环。
 */
export function abolishSlot(state: SanguoshaState, playerId: PlayerId, slot: EquipmentSlot): boolean {
  if (isSlotAbolished(state, playerId, slot)) return false
  state.abolishedSlots ??= {}
  state.abolishedSlots[playerId] = [...slotsOf(state, playerId), slot]
  return true
}

/**
 * 恢复一个栏。恢复之后栏是**空的**——不会把之前弃掉的那张装备变回来。
 */
export function restoreSlot(state: SanguoshaState, playerId: PlayerId, slot: EquipmentSlot): boolean {
  if (!isSlotAbolished(state, playerId, slot)) return false
  state.abolishedSlots ??= {}
  const next = slotsOf(state, playerId).filter((candidate) => candidate !== slot)
  if (next.length === 0) delete state.abolishedSlots[playerId]
  else state.abolishedSlots[playerId] = next
  return true
}

/** 角色死亡时清账。 */
export function clearAbolishedSlotsOf(state: SanguoshaState, playerId: PlayerId): void {
  if (state.abolishedSlots) delete state.abolishedSlots[playerId]
}
