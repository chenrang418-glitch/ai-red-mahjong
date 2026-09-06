/**
 * 驭衡兼容性审计。
 *
 * 神孙权【驭衡】随机获得吴势力角色的技能。这个脚本扫描当前全部吴势力武将，
 * 输出技能池的组成、被规则排除的部分，以及**规则上该能获得、实际却跑不起来**
 * 的技能——最后一项必须是 0。
 *
 * 用法：npx vite-node scripts/yuheng-audit.mts
 */
import { writeFileSync } from 'node:fs'
import { ALL_CHARACTERS } from '../src/sanguosha/data/characters/standard'
import { randomSkillPoolOf, skillIsRandomlyGrantable } from '../src/sanguosha/engine/random-skill-pool'
import { getSkillRuntime } from '../src/sanguosha/engine/skills/runtime'

const wuCharacters = ALL_CHARACTERS.filter((character) => character.kingdom === 'wu')
const allWuSkills = wuCharacters.flatMap((character) => character.skills.map((skill) => ({ ...skill, character })))

interface Row {
  skillId: string
  skillName: string
  character: string
  eligible: boolean
  reason: string
}

const rows: Row[] = allWuSkills.map((skill) => {
  const runtime = getSkillRuntime(skill.id)
  const reasons: string[] = []
  if (skill.granted) reasons.push('衍生技')
  if (runtime?.limited) reasons.push('限定技')
  if (runtime?.awakening) reasons.push('觉醒技')
  if (runtime?.lord) reasons.push('主公技')
  if (!runtime) reasons.push('**没有运行时实现**')
  return {
    skillId: skill.id,
    skillName: skill.name,
    character: skill.character.name,
    eligible: skillIsRandomlyGrantable(skill.id, skill.granted),
    reason: reasons.join('、'),
  }
})

const pool = randomSkillPoolOf('wu').filter((skill) => skillIsRandomlyGrantable(skill.id))
const eligible = rows.filter((row) => row.eligible)
const excluded = rows.filter((row) => !row.eligible)
// 规则上不该被排除、却因为没有实现而进不了池的：必须是 0
const incompatible = rows.filter((row) => !row.eligible && row.reason === '**没有运行时实现**')

const lines: string[] = []
lines.push('# 驭衡兼容性审计')
lines.push('')
lines.push('本文件由 `npx vite-node scripts/yuheng-audit.mts` 生成，请勿手改。')
lines.push('')
lines.push('神孙权【驭衡】随机获得吴势力角色的技能。**池子从当前武将表现算**，')
lines.push('不是一份手写的技能名数组——那份数组第二天就会和武将表脱节：')
lines.push('加了新吴将不会自动进池，改了技能 id 也不会有任何测试发现。')
lines.push('')
lines.push('资格只看结构化标志：衍生技、限定技、觉醒技、主公技一律排除，')
lines.push('并且要求技能**有运行时实现**——规则上能拿、拿到手却什么都不做，比不给还糟。')
lines.push('')
lines.push('## 汇总')
lines.push('')
lines.push('| 项 | 数量 |')
lines.push('|---|---|')
lines.push(`| 吴势力武将 | ${wuCharacters.length} |`)
lines.push(`| 吴势力技能 | ${rows.length} |`)
lines.push(`| 可随机获得 | ${eligible.length} |`)
lines.push(`| 按规则排除 | ${excluded.length - incompatible.length} |`)
lines.push(`| **规则允许却没有实现** | **${incompatible.length}** |`)
lines.push(`| 实际池大小（去重后） | ${new Set(pool.map((skill) => skill.id)).size} |`)
lines.push('')
lines.push('## 可随机获得的技能')
lines.push('')
lines.push('| 技能 | 武将 |')
lines.push('|---|---|')
for (const row of eligible) lines.push(`| ${row.skillName}（${row.skillId}） | ${row.character} |`)
lines.push('')
lines.push('## 被排除的技能')
lines.push('')
lines.push('| 技能 | 武将 | 原因 |')
lines.push('|---|---|---|')
for (const row of excluded) lines.push(`| ${row.skillName}（${row.skillId}） | ${row.character} | ${row.reason} |`)
lines.push('')

writeFileSync('docs/yuheng-compatibility.md', lines.join('\n'), 'utf8')
// eslint-disable-next-line no-console
console.log(`吴将 ${wuCharacters.length}，技能 ${rows.length}，可获得 ${eligible.length}，不兼容 ${incompatible.length}`)
if (incompatible.length > 0) process.exitCode = 1
