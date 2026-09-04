import type { CharacterId } from '../../engine/types'

export type Kingdom = 'shu' | 'wei' | 'wu' | 'qun'
export type Gender = 'male' | 'female'

/**
 * 武将包。**只注册技能全部实现完的武将，不放空壳。**
 *
 * `wind` / `fire` / `forest` / `mountain` 是神话再临的风、火、林、山四包。加包时要同时更新
 * `ALL_CHARACTERS` 的汇入，否则新武将进不了候选池。
 */
export type CharacterPack = 'standard' | 'wind' | 'fire' | 'forest' | 'mountain' | 'entertainment'

export interface CharacterSkillInfo {
  id: string
  name: string
  /** 展示给玩家的技能说明。规则说明页直接从这里生成，不另外维护一份。 */
  description: string
}

export interface CharacterDefinition {
  id: CharacterId
  name: string
  kingdom: Kingdom
  gender: Gender
  /** 体力上限。主公在部分人数下会 +1，由模式层处理，不写死在这里。 */
  maxHp: number
  pack: CharacterPack
  skills: CharacterSkillInfo[]
}
