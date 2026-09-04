import { getSkillRuntime, replaceTemporarySkill, type SkillHost } from './skills/runtime'
import type { CharacterId, PlayerId, SanguoshaState } from './types'

export interface HuashenCharacter {
  id: CharacterId
  name: string
  pack: string
  kingdom: 'wei' | 'shu' | 'wu' | 'qun'
  gender: 'male' | 'female'
  skills: Array<{ id: string; name: string; granted?: boolean }>
}

let catalog: readonly HuashenCharacter[] = []
let byId = new Map<CharacterId, HuashenCharacter>()

export function provideHuashenCharacterCatalog(characters: readonly HuashenCharacter[]): void {
  catalog = characters
  byId = new Map(characters.map((character) => [character.id, character]))
}

/** 资格只读运行时元数据：限定、觉醒、主公技排除，复杂普通技不得因实现麻烦被排除。 */
export function huashenEligibleSkills(characterId: CharacterId): Array<{ id: string; name: string }> {
  const character = byId.get(characterId)
  if (!character) return []
  return character.skills.filter((skill) => {
    if (skill.granted) return false
    const runtime = getSkillRuntime(skill.id)
    return Boolean(runtime && !runtime.limited && !runtime.lord && !runtime.awakening && skill.id !== 'huashen' && skill.id !== 'xinsheng')
  }).map(({ id, name }) => ({ id, name }))
}

export function initializeHuashenOwner(host: SkillHost, ownerId: PlayerId): void {
  if (!host.state.huashen) {
    const seated = new Set(host.state.players.map((player) => player.characterId).filter(Boolean))
    host.state.huashen = {
      remainingCharacterIds: catalog
        .filter((character) => character.pack !== 'entertainment' && character.id !== 'zuoci' && !seated.has(character.id))
        .filter((character) => huashenEligibleSkills(character.id).length > 0)
        .map((character) => character.id),
      owners: {},
    }
  }
  if (host.state.huashen.owners[ownerId]) return
  const characterIds: CharacterId[] = []
  for (let count = 0; count < 2 && host.state.huashen.remainingCharacterIds.length > 0; count += 1) {
    const index = host.rng.nextInt(host.state.huashen.remainingCharacterIds.length)
    characterIds.push(host.state.huashen.remainingCharacterIds.splice(index, 1)[0])
  }
  host.state.huashen.owners[ownerId] = { characterIds, activeCharacterId: null, activeSkillId: null }
}

export function gainRandomHuashen(host: SkillHost, ownerId: PlayerId): CharacterId | null {
  const state = host.state.huashen
  const owner = state?.owners[ownerId]
  if (!state || !owner || state.remainingCharacterIds.length === 0) return null
  const index = host.rng.nextInt(state.remainingCharacterIds.length)
  const [characterId] = state.remainingCharacterIds.splice(index, 1)
  owner.characterIds.push(characterId)
  return characterId
}

export function activateHuashen(state: SanguoshaState, ownerId: PlayerId, characterId: CharacterId, skillId: string): boolean {
  const owner = state.huashen?.owners[ownerId]
  if (!owner?.characterIds.includes(characterId) || !huashenEligibleSkills(characterId).some((skill) => skill.id === skillId)) return false
  // 先替换来源绑定技能，再公开新化身；同一个同步调用中不会出现双技能状态。
  replaceTemporarySkill(state, ownerId, `huashen:${ownerId}`, skillId)
  owner.activeCharacterId = characterId
  owner.activeSkillId = skillId
  return true
}

function activeCharacter(state: SanguoshaState, playerId: PlayerId): HuashenCharacter | undefined {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player || player.characterSkillsDisabled) return undefined
  const activeId = state.huashen?.owners[playerId]?.activeCharacterId
  return activeId ? byId.get(activeId) : undefined
}

export function effectiveKingdomOf(state: SanguoshaState, playerId: PlayerId): 'wei' | 'shu' | 'wu' | 'qun' | undefined {
  const active = activeCharacter(state, playerId)
  if (active) return active.kingdom
  const characterId = state.players.find((candidate) => candidate.id === playerId)?.characterId
  return characterId ? byId.get(characterId)?.kingdom : undefined
}

export function effectiveGenderOf(state: SanguoshaState, playerId: PlayerId): 'male' | 'female' | undefined {
  const active = activeCharacter(state, playerId)
  if (active) return active.gender
  const characterId = state.players.find((candidate) => candidate.id === playerId)?.characterId
  return characterId ? byId.get(characterId)?.gender : undefined
}

export function huashenCharacter(characterId: CharacterId): HuashenCharacter | undefined {
  return byId.get(characterId)
}

export function huashenEligibilityReport(): {
  eligible: string[]
  excludedByRule: string[]
  excludedLimited: string[]
  excludedAwakening: string[]
  excludedLord: string[]
  excludedSelf: string[]
  incompatibleBug: string[]
} {
  const eligible: string[] = []
  const excludedByRule: string[] = []
  const excludedLimited: string[] = []
  const excludedAwakening: string[] = []
  const excludedLord: string[] = []
  const excludedSelf: string[] = []
  const incompatibleBug: string[] = []
  for (const character of catalog.filter((item) => item.pack !== 'entertainment')) {
    for (const skill of character.skills.filter((item) => !item.granted)) {
      const runtime = getSkillRuntime(skill.id)
      if (!runtime) incompatibleBug.push(skill.id)
      else if (runtime.limited || runtime.lord || runtime.awakening || skill.id === 'huashen' || skill.id === 'xinsheng') {
        excludedByRule.push(skill.id)
        if (runtime.limited) excludedLimited.push(skill.id)
        if (runtime.awakening) excludedAwakening.push(skill.id)
        if (runtime.lord) excludedLord.push(skill.id)
        if (skill.id === 'huashen' || skill.id === 'xinsheng') excludedSelf.push(skill.id)
      }
      else eligible.push(skill.id)
    }
  }
  const unique = (values: string[]) => [...new Set(values)]
  return {
    eligible: unique(eligible), excludedByRule: unique(excludedByRule),
    excludedLimited: unique(excludedLimited), excludedAwakening: unique(excludedAwakening),
    excludedLord: unique(excludedLord), excludedSelf: unique(excludedSelf), incompatibleBug: unique(incompatibleBug),
  }
}
