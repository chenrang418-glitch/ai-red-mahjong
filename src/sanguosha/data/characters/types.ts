import type { CharacterId } from '../../engine/types'
import type { Faction } from '../../shared/factions'

/** 沿用既有字段名；六势力的唯一枚举定义在 shared/factions。 */
export type Kingdom = Faction
export type Gender = 'male' | 'female'

/**
 * 武将包。**只注册技能全部实现完的武将，不放空壳。**
 *
 * `wind` / `fire` / `forest` / `mountain` / `god` 是神话再临的风、火、林、山、神五包。加包时要同时更新
 * `ALL_CHARACTERS` 的汇入，否则新武将进不了候选池。
 */
export type CharacterPack = 'standard' | 'wind' | 'fire' | 'forest' | 'mountain' | 'god' | 'entertainment'

export interface CharacterSkillInfo {
  id: string
  name: string
  /** 展示给玩家的技能说明。规则说明页直接从这里生成，不另外维护一份。 */
  description: string
  /**
   * 这个技能**开局并不拥有**，要在牌局中被授予才生效（觉醒技给的【急袭】
   * 【观星】【激将】）。
   *
   * 列在这里只是为了规则页和词条能查得到——`skillIdsOf` 会把它们过滤掉，
   * 真正的归属由 `player.grantedSkills` 决定。**不加这个标记就等于开局就有**，
   * 邓艾一上来就能用急袭，觉醒技也就没意义了。
   */
  granted?: boolean
}

export interface CharacterDefinition {
  id: CharacterId
  name: string
  kingdom: Kingdom
  gender: Gender
  /** 体力上限。主公在部分人数下会 +1，由模式层处理，不写死在这里。 */
  maxHp: number
  /**
   * 开局体力，**默认等于体力上限**。
   *
   * 神甘宁是 6 上限 / 3 开局——初始体力和上限不相等的武将要在这里声明，
   * 不能在初始化里按 characterId 特判扣血。
   * 身份局主公的 +1 加成对上限和体力同时生效，所以神甘宁当主公是 7 / 4。
   */
  initialHp?: number
  pack: CharacterPack
  skills: CharacterSkillInfo[]
}
