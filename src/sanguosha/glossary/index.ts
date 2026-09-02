import { ALL_CARD_INFO } from '../data/ruleset-v1/card-info'
import { getCharacter, ALL_CHARACTERS } from '../data/characters/standard'

export type GlossaryKind = 'card' | 'character' | 'skill' | 'identity' | 'rule' | 'unknown-identity'

export interface GlossaryEntry {
  id: string
  kind: GlossaryKind
  title: string
  subtitle: string
  description: string
  skills?: Array<{ id: string; name: string; description: string }>
  characterId?: string
}

const IDENTITIES: Record<string, GlossaryEntry> = {
  lord: { id: 'lord', kind: 'identity', title: '主公', subtitle: '公开身份', description: '消灭所有反贼和内奸后，与仍存活的忠臣共同获胜。' },
  loyalist: { id: 'loyalist', kind: 'identity', title: '忠臣', subtitle: '隐藏身份', description: '保护主公；主公阵营获胜时共同获胜。' },
  rebel: { id: 'rebel', kind: 'identity', title: '反贼', subtitle: '隐藏身份', description: '目标是杀死主公；主公死亡时反贼阵营获胜。' },
  renegade: { id: 'renegade', kind: 'identity', title: '内奸', subtitle: '隐藏身份', description: '先消灭其他势力，最后在只剩自己与主公时击败主公。' },
  unknown: { id: 'unknown', kind: 'unknown-identity', title: '身份未公开', subtitle: '隐藏信息', description: '该角色身份尚未公开。身份会在角色阵亡或牌局结束时按规则公开。' },
}

const RULES: Record<string, GlossaryEntry> = {
  distance: { id: 'distance', kind: 'rule', title: '距离', subtitle: '目标规则', description: '按存活角色的座次计算最短距离，并叠加进攻马、防御马和武将技能修正。界面显示值直接来自规则引擎。' },
  range: { id: 'range', kind: 'rule', title: '攻击范围', subtitle: '目标规则', description: '默认攻击范围为 1；装备武器或受到技能修正后会变化。【杀】只能指定距离不超过攻击范围的合法目标。' },
  chained: { id: 'chained', kind: 'rule', title: '横置', subtitle: '状态', description: '横置角色受到属性伤害时，伤害会按规则向其他横置角色传导。' },
  dying: { id: 'dying', kind: 'rule', title: '濒死', subtitle: '状态', description: '体力降到 0 或以下时进入濒死，按顺序请求可用的【桃】或自救牌；未恢复到 1 点体力则阵亡。' },
  judge: { id: 'judge', kind: 'rule', title: '判定', subtitle: '规则', description: '从牌堆顶亮出一张判定牌，以其花色和点数决定延时锦囊或技能的结果。' },
}

export function cardGlossary(name: string): GlossaryEntry | null {
  const card = ALL_CARD_INFO.find((entry) => entry.name === name)
  return card ? { id: `card:${name}`, kind: 'card', title: card.name, subtitle: '卡牌', description: card.description } : null
}

export function characterGlossary(characterId: string): GlossaryEntry | null {
  const character = getCharacter(characterId)
  if (!character) return null
  const kingdom = { wei: '魏', shu: '蜀', wu: '吴', qun: '群' }[character.kingdom]
  return { id: `character:${character.id}`, kind: 'character', title: character.name, subtitle: `${kingdom} · ${character.maxHp} 体力`, description: '', skills: [...character.skills], characterId: character.id }
}

export function skillGlossary(skillId: string): GlossaryEntry | null {
  for (const character of ALL_CHARACTERS) {
    const skill = character.skills.find((candidate) => candidate.id === skillId || candidate.name === skillId)
    if (skill) return { id: `skill:${skill.id}`, kind: 'skill', title: skill.name, subtitle: `${character.name}的技能`, description: skill.description, characterId: character.id }
  }
  return null
}

export function identityGlossary(identity: string | null): GlossaryEntry {
  return IDENTITIES[identity ?? 'unknown'] ?? IDENTITIES.unknown
}

export function ruleGlossary(rule: string): GlossaryEntry | null {
  return RULES[rule] ?? null
}
