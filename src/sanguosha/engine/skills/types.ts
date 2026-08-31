import type { GameEventName } from '../events'
import type { CardId, PlayerId } from '../types'

export type SkillCapability =
  | 'trigger' | 'active' | 'view-as' | 'filter' | 'prohibit'
  | 'target-mod' | 'distance' | 'max-cards' | 'locked' | 'limited' | 'lord'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  capabilities: SkillCapability[]
  subSkills?: SkillDefinition[]
}

export interface TriggerSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'trigger'>; events: GameEventName[] }
export interface ActiveSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'active'>; canUse(playerId: PlayerId): boolean }
export interface ViewAsSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'view-as'>; canConvert(cardIds: CardId[]): boolean }
export interface FilterSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'filter'> }
export interface ProhibitSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'prohibit'> }
export interface TargetModSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'target-mod'> }
export interface DistanceSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'distance'> }
export interface MaxCardsSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'max-cards'> }
export interface LockedSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'locked'> }
export interface LimitedSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'limited'> }
export interface LordSkill extends SkillDefinition { capabilities: Array<SkillCapability | 'lord'> }
