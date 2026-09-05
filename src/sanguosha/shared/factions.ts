/**
 * 纸上三国唯一的势力配置源。
 *
 * 武将数据继续使用项目原有的 `kingdom` 字段；新增武将只需填写六选一的
 * `kingdom`，对局、规则页和艺术集便会自动取得同一套名称与颜色。
 */
export const FACTION_ORDER = ['wei', 'shu', 'wu', 'qun', 'jin', 'shen'] as const

export type Faction = typeof FACTION_ORDER[number]

export interface FactionDefinition {
  id: Faction
  name: string
  /** 对局角标和无立绘座位底色。 */
  color: string
  /** 对局角标文字色。 */
  textColor: string
  /** 对局角标描边色。 */
  borderColor: string
  /** 深色规则页、艺术集分类标题使用的高对比颜色。 */
  headingColor: string
}

export const FACTION_CONFIG: Record<Faction, FactionDefinition> = {
  wei: { id: 'wei', name: '魏', color: '#315A8C', textColor: '#F4F8FF', borderColor: '#83A8D1', headingColor: '#78A9DF' },
  shu: { id: 'shu', name: '蜀', color: '#3F7D4A', textColor: '#F4FFF5', borderColor: '#8FC296', headingColor: '#7FBE87' },
  wu: { id: 'wu', name: '吴', color: '#A94442', textColor: '#FFF5F1', borderColor: '#DC8E87', headingColor: '#DA7770' },
  qun: { id: 'qun', name: '群', color: '#666A70', textColor: '#FAFAF8', borderColor: '#A7A9AE', headingColor: '#AFB2B7' },
  jin: { id: 'jin', name: '晋', color: '#75558A', textColor: '#FBF5FF', borderColor: '#B696C8', headingColor: '#B692CA' },
  shen: { id: 'shen', name: '神', color: '#C9972F', textColor: '#FFF8E3', borderColor: '#E7C976', headingColor: '#E2BA58' },
}

export function factionDefinition(faction: Faction | null | undefined): FactionDefinition | undefined {
  return faction ? FACTION_CONFIG[faction] : undefined
}
