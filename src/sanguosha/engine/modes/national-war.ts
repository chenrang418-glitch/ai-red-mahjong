import type { Faction } from '../../shared/factions'
import { isGeneralRevealProhibited, revealedGeneralFactionOf, setGeneralRevealed } from '../general-slots'
import type { PlayerId, SanguoshaState } from '../types'

export type NationalWarCamp =
  | { kind: 'faction'; faction: Faction }
  | { kind: 'ambitious'; playerId: PlayerId }

export interface NationalWarVictory {
  camp: NationalWarCamp
  winnerIds: PlayerId[]
}

/** 当前已确定的国战阵营；野心家彼此也属于不同阵营。 */
export function nationalWarCampOf(player: SanguoshaState['players'][number]): NationalWarCamp | null {
  if (!player.nationalWarFaction) return null
  return player.nationalWarAmbitious
    ? { kind: 'ambitious', playerId: player.id }
    : { kind: 'faction', faction: player.nationalWarFaction }
}

/**
 * 明置一张武将牌并确定其势力。首次明置时若该势力当前已占全场过半，
 * 该角色成为独立野心家；触发后续同势力明置者也成为各自独立的野心家。
 */
export function revealNationalWarGeneral(
  state: SanguoshaState,
  playerId: PlayerId,
  slot: 'primary' | 'deputy',
): boolean {
  if (isGeneralRevealProhibited(state, playerId, slot)) return false
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player?.alive || !setGeneralRevealed(player, slot, true)) return false
  const faction = revealedGeneralFactionOf(player)
  if (!faction) {
    setGeneralRevealed(player, slot, false)
    return false
  }

  if (player.nationalWarFaction) {
    if (player.nationalWarFaction === faction) return true
    setGeneralRevealed(player, slot, false)
    return false
  }
  const ambitiousFactions = state.nationalWarAmbitiousFactions ?? []
  const alreadyAmbitious = ambitiousFactions.includes(faction)
  const priorFactionCount = state.players.filter((candidate) => candidate.id !== playerId
    && candidate.nationalWarFaction === faction && !candidate.nationalWarAmbitious).length
  const crossesMajority = priorFactionCount + 1 > state.players.length / 2
  player.nationalWarFaction = faction
  player.nationalWarAmbitious = alreadyAmbitious || crossesMajority
  if (crossesMajority && !alreadyAmbitious) {
    state.nationalWarAmbitiousFactions = [...ambitiousFactions, faction]
  }
  return true
}

/**
 * 国战胜负只在全场角色均已确定势力后判断；势力仍未知的存活角色阻止提前结束。
 * 普通势力整体胜利，野心家必须成为唯一存活角色。
 */
export function checkNationalWarVictory(state: SanguoshaState): NationalWarVictory | null {
  if (state.players.some((player) => !player.nationalWarFaction)) return null
  const alive = state.players.filter((player) => player.alive)
  if (!alive.length) return null
  const camps = new Map<string, { camp: NationalWarCamp; winnerIds: PlayerId[] }>()
  for (const player of alive) {
    const camp = nationalWarCampOf(player)
    if (!camp) return null
    const key = camp.kind === 'faction' ? `faction:${camp.faction}` : `ambitious:${camp.playerId}`
    const group = camps.get(key) ?? { camp, winnerIds: [] }
    group.winnerIds.push(player.id)
    camps.set(key, group)
  }
  if (camps.size !== 1) return null
  const [winner] = camps.values()
  return { camp: winner.camp, winnerIds: winner.winnerIds }
}
