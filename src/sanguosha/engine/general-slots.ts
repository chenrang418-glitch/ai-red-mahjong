import type { PlayerId, PlayerState, SanguoshaState } from './types'
import type { Faction } from '../shared/factions'

let factionOfGeneral: (characterId: string) => Faction | undefined = () => undefined
type RevealProhibition = (state: SanguoshaState, playerId: PlayerId, slot: 'primary' | 'deputy') => boolean
const revealProhibitions = new Set<RevealProhibition>()

/** 可扩展的国战明置禁止规则；武将技能在数据模块加载时注册。 */
export function registerGeneralRevealProhibition(rule: RevealProhibition): void {
  revealProhibitions.add(rule)
}

export function isGeneralRevealProhibited(state: SanguoshaState, playerId: PlayerId, slot: 'primary' | 'deputy'): boolean {
  return [...revealProhibitions].some((rule) => rule(state, playerId, slot))
}

/** 武将总表完成初始化后注入势力查询，避免引擎反向依赖角色模块。 */
export function provideGeneralFactionLookup(lookup: (characterId: string) => Faction | undefined): void {
  factionOfGeneral = lookup
}

/**
 * 当前明置且能提供武将技能的武将牌。
 * 主将状态缺省视为明置以兼容现有身份局存档；副将必须显式明置才生效。
 */
export function revealedGeneralCharacterIdsOf(player: PlayerState): string[] {
  const ids: string[] = []
  if (player.characterId && player.primaryGeneralRevealed !== false) ids.push(player.characterId)
  if (player.deputyCharacterId && player.deputyGeneralRevealed === true) ids.push(player.deputyCharacterId)
  return [...new Set(ids)]
}

/** 只根据明置武将确定势力；未知或互相冲突的明置势力不做猜测。 */
export function revealedGeneralFactionOf(player: PlayerState): Faction | undefined {
  const factions = [...new Set(revealedGeneralCharacterIdsOf(player)
    .map(factionOfGeneral)
    .filter((faction): faction is Faction => faction !== undefined))]
  return factions.length === 1 ? factions[0] : undefined
}

/** 明置/暗置某一将位；没有对应武将牌时返回 false，不改状态。 */
export function setGeneralRevealed(player: PlayerState, slot: 'primary' | 'deputy', revealed: boolean): boolean {
  if (slot === 'primary') {
    if (!player.characterId) return false
    player.primaryGeneralRevealed = revealed
    return true
  }
  if (!player.deputyCharacterId) return false
  player.deputyGeneralRevealed = revealed
  return true
}
