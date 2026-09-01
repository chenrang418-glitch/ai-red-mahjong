import type { EventContext, GameEvent, GameEventName } from './events'
import { skillsOf } from './skills/runtime'
import { skillIdsOf } from '../data/characters/standard'
import type { DamageNature, PlayerId, SanguoshaState } from './types'

/** 装备特效需要的最小宿主：读状态 + 派发事件。 */
export interface EquipmentHost {
  state: SanguoshaState
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}

/**
 * 装备特效。
 *
 * 这一批实现的是「纯规则修正」类：不需要额外向玩家发 Request，
 * 只改判定结果、伤害数值或合法动作。需要询问玩家的（八卦阵判定、麒麟弓弃马、
 * 青龙偃月刀追杀、贯石斧硬吃闪、寒冰剑改判、方天画戟多目标、丈八蛇矛转化、
 * 雌雄双股剑）留到 Request 层和武将技能一起做，见 docs/sanguosha-progress.md。
 *
 * 装备只按**装备牌名**判断，不依赖武将数据，所以现在就能做完整测试。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

/** 某人是否穿着指定防具。 */
export function hasArmor(state: SanguoshaState, playerId: PlayerId, armorName: string): boolean {
  const armorId = playerOf(state, playerId).zones.equipment.armor
  return !!armorId && state.cards[armorId]?.name === armorName
}

/** 某人是否装备着指定武器。 */
export function hasWeapon(state: SanguoshaState, playerId: PlayerId, weaponName: string): boolean {
  const weaponId = playerOf(state, playerId).zones.equipment.weapon
  return !!weaponId && state.cards[weaponId]?.name === weaponName
}

/**
 * 这张牌对目标是不是完全无效。无效意味着连响应都不用问，直接跳过。
 *
 * - 仁王盾：黑色的【杀】对你无效。
 * - 藤甲：【南蛮入侵】【万箭齐发】和普通【杀】对你无效；但火焰伤害会 +1，见 fireDamageBonus。
 */
export function isCardIneffective(
  state: SanguoshaState,
  targetId: PlayerId,
  cardName: string,
  cardColor: 'red' | 'black' | null,
  damageNature: DamageNature,
): boolean {
  if (cardName === '杀') {
    if (hasArmor(state, targetId, '仁王盾') && cardColor === 'black') return true
    // 藤甲只挡普通杀，火杀雷杀照样打得进来
    if (hasArmor(state, targetId, '藤甲') && damageNature === 'normal') return true
    return false
  }
  if (cardName === '南蛮入侵' || cardName === '万箭齐发') {
    return hasArmor(state, targetId, '藤甲')
  }
  return false
}

/**
 * 伤害数值修正。返回修正后的点数。
 *
 * - 古锭刀：目标没有手牌时，你的【杀】伤害 +1。
 * - 藤甲：受到火焰伤害 +1。
 * - 白银狮子：受到的伤害超过 1 点时，改为只受 1 点。
 *
 * 顺序有讲究：白银狮子是「受到的伤害」封顶，必须放在所有加成之后。
 */
export function adjustDamageAmount(
  state: SanguoshaState,
  sourceId: PlayerId | null,
  targetId: PlayerId,
  amount: number,
  nature: DamageNature,
  cardName: string | null,
): number {
  let adjusted = amount
  if (cardName === '杀' && sourceId && hasWeapon(state, sourceId, '古锭刀')) {
    if (playerOf(state, targetId).zones.hand.length === 0) adjusted += 1
  }
  if (nature === 'fire' && hasArmor(state, targetId, '藤甲')) adjusted += 1
  if (hasArmor(state, targetId, '白银狮子') && adjusted > 1) adjusted = 1
  return adjusted
}

/**
 * 出牌阶段【杀】是否不限次。
 * 诸葛连弩和张飞【咆哮】走同一个入口——技能不另写一套出杀次数逻辑。
 */
export function hasUnlimitedSlash(state: SanguoshaState, playerId: PlayerId): boolean {
  if (hasWeapon(state, playerId, '诸葛连弩')) return true
  return skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.unlimitedSlash)
}

/**
 * 装备离开装备区时的收尾。目前只有白银狮子有效果：失去时回复一点体力。
 *
 * 必须在牌真正移出装备槽之后调用——被替换、被拆、被顺走都算「失去」。
 */
export function handleEquipmentLost(host: EquipmentHost, playerId: PlayerId, cardId: string): void {
  // 先广播「失去了一张装备」，孙尚香【枭姬】这类技能挂在这个时机上
  host.dispatch('LoseEquipment', { playerId, cardId }, { targetId: playerId, cardIds: [cardId] })
  if (host.state.cards[cardId]?.name !== '白银狮子') return
  const owner = playerOf(host.state, playerId)
  if (!owner.alive || owner.hp >= owner.maxHp) return
  owner.hp += 1
  host.dispatch('Recover', { playerId, amount: 1, reason: '白银狮子' }, { targetId: playerId })
}

/** 八卦阵：需要打出【闪】时，可以改为判定，红色即视为出了一张【闪】。 */
export const BAGUA_ACTION_ID = 'invoke-bagua'

export function canInvokeBagua(state: SanguoshaState, playerId: PlayerId): boolean {
  return hasArmor(state, playerId, '八卦阵')
}
