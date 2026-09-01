import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CharacterDefinition } from './types'

registerSkillRuntime({
  id: 'wushuang',
  slashDodgeResponses: 2,
  duelSlashResponses: 2,
})

export const QUN_CHARACTERS: readonly CharacterDefinition[] = [{
  id: 'lvbu',
  name: '吕布',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'standard',
  skills: [{
    id: 'wushuang',
    name: '无双',
    description: '锁定技，你使用【杀】指定目标后，目标需连续使用两张【闪】；与你进行【决斗】的角色每轮需连续打出两张【杀】。',
  }],
}] as const
