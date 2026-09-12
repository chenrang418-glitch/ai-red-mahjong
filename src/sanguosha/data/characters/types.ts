import type { CharacterId } from '../../engine/types'
import type { Faction } from '../../shared/factions'

/** 沿用既有字段名；七势力的唯一枚举定义在 shared/factions。 */
export type Kingdom = Faction
export type Gender = 'male' | 'female'

/**
 * 武将包。**只注册技能全部实现完的武将，不放空壳。**
 *
 * `wind` / `fire` / `forest` / `mountain` / `god` 是本项目的五个角色分包。加包时要同时更新
 * `ALL_CHARACTERS` 的汇入，否则新武将进不了候选池。
 */
export type CharacterPack = 'standard' | 'wind' | 'fire' | 'forest' | 'mountain' | 'god' | 'yjcm2011' | 'yjcm2012' | 'yjcm2013' | 'entertainment'

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
  /**
   * 这是不是一个**锁定技**。
   *
   * 不写就按技能说明里有没有「锁定技」三个字来判定——本项目所有锁定技的说明
   * 都以它开头，这是唯一真相，不必再手抄一份名单。只有说明里写法特殊的技能
   * 才需要在这里显式声明，覆盖那次推断。
   *
   * 神马超【霆威】要令目标的非锁定技失效，判定就走这里。
   */
  locked?: boolean
  /**
   * 这个技能可以作为**装备技能**被借用（神典韦【挈挟】把武将牌当武器装备时）。
   *
   * 这是**声明出来的结构化元数据，不是运行时去解析中文描述**：
   * 靠 `description.includes('杀')` 判断规则是脆的——描述改一个字、
   * 多一个「杀」字的比喻，行为就变了，而且没有任何测试会发现。
   *
   * 标了这个的技能还要再过一遍自动排除：觉醒技、限定技、转换技、主公技
   * 都不能被借用，那几项由运行时的结构化标志判断，不必在这里重复声明。
   * 全量清单见 `docs/qiexie-compatibility.md`。
   */
  qiexie?: boolean
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
