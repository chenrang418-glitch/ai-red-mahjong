/**
 * 挈挟兼容性审计。
 *
 * 遍历当前全部武将技能，输出每一个技能的借用资格和理由，写进
 * `docs/qiexie-compatibility.md`。
 *
 * **资格只看结构化元数据**：技能自己声明的 `qiexie`，加上运行时的
 * 觉醒 / 限定 / 主公标志。描述里有没有「杀」字只作为**报告里的一列**，
 * 提示哪些技能值得人工再看一眼——运行时一个字都不解析。
 *
 * 用法：npx vite-node scripts/qiexie-audit.mts
 */
import { writeFileSync } from 'node:fs'
import { ALL_CHARACTERS, borrowableSkillIdsOf } from '../src/sanguosha/data/characters/standard'
import { getSkillRuntime } from '../src/sanguosha/engine/skills/runtime'

interface Row {
  skillId: string
  skillName: string
  character: string
  characterId: string
  pack: string
  mentionsSlash: boolean
  declared: boolean
  excludedBy: string
  eligible: boolean
  runtimeOk: boolean
}

const rows: Row[] = []
for (const character of ALL_CHARACTERS) {
  const borrowable = new Set(borrowableSkillIdsOf(character.id))
  for (const skill of character.skills) {
    const runtime = getSkillRuntime(skill.id)
    const excluded: string[] = []
    if (runtime?.limited) excluded.push('限定技')
    if (runtime?.awakening) excluded.push('觉醒技')
    if (runtime?.lord) excluded.push('主公技')
    if (skill.granted) excluded.push('衍生技')
    rows.push({
      skillId: skill.id,
      skillName: skill.name,
      character: character.name,
      characterId: character.id,
      pack: character.pack,
      mentionsSlash: skill.description.includes('杀'),
      declared: skill.qiexie === true,
      excludedBy: excluded.join('、'),
      eligible: borrowable.has(skill.id),
      // 有资格却没有运行时实现＝规则上该能用、实际用不了，必须是 0 个
      runtimeOk: !borrowable.has(skill.id) || !!runtime,
    })
  }
}

const eligible = rows.filter((row) => row.eligible)
const declaredButExcluded = rows.filter((row) => row.declared && !row.eligible)
const mentionsButNotDeclared = rows.filter((row) => row.mentionsSlash && !row.declared)
const incompatible = eligible.filter((row) => !row.runtimeOk)

const lines: string[] = []
lines.push('# 挈挟兼容性审计')
lines.push('')
lines.push('本文件由 `npx vite-node scripts/qiexie-audit.mts` 生成，请勿手改。')
lines.push('')
lines.push('神典韦【挈挟】把武将牌当武器装备时，会借用那张武将牌上的部分技能。')
lines.push('**资格只认结构化元数据**：技能定义里的 `qiexie` 字段，加上运行时的')
lines.push('觉醒 / 限定 / 主公 / 衍生标志。下面「描述提到杀」那一列只是给人看的线索，')
lines.push('运行时不解析任何中文描述——描述改一个字就改变行为的实现是脆的。')
lines.push('')
lines.push('## 汇总')
lines.push('')
lines.push(`| 项 | 数量 |`)
lines.push(`|---|---|`)
lines.push(`| 武将总数 | ${ALL_CHARACTERS.length} |`)
lines.push(`| 技能总数 | ${rows.length} |`)
lines.push(`| 可借用 | ${eligible.length} |`)
lines.push(`| 声明了但被规则排除 | ${declaredButExcluded.length} |`)
lines.push(`| 描述提到【杀】但未声明 | ${mentionsButNotDeclared.length} |`)
lines.push(`| **有资格却跑不起来** | **${incompatible.length}** |`)
lines.push('')
lines.push('「有资格却跑不起来」必须是 0：那意味着规则上该能借的技能，实际借了没用。')
lines.push('')
lines.push('## 可借用的技能')
lines.push('')
lines.push('| 技能 | 武将 | 包 | 运行时可用 |')
lines.push('|---|---|---|---|')
for (const row of eligible) {
  lines.push(`| ${row.skillName}（${row.skillId}） | ${row.character} | ${row.pack} | ${row.runtimeOk ? '是' : '**否**'} |`)
}
lines.push('')
lines.push('## 声明了 `qiexie` 但被规则排除')
lines.push('')
if (declaredButExcluded.length === 0) lines.push('（无）')
else {
  lines.push('| 技能 | 武将 | 排除原因 |')
  lines.push('|---|---|---|')
  for (const row of declaredButExcluded) {
    lines.push(`| ${row.skillName}（${row.skillId}） | ${row.character} | ${row.excludedBy} |`)
  }
}
lines.push('')
lines.push('## 描述里提到【杀】、但没有声明可借用')
lines.push('')
lines.push('这一节是**待人工判断的清单**，不是缺陷列表：描述里出现「杀」字')
lines.push('不等于这个技能就该被当成武器技能借走。')
lines.push('')
lines.push('| 技能 | 武将 | 包 | 备注 |')
lines.push('|---|---|---|---|')
for (const row of mentionsButNotDeclared) {
  lines.push(`| ${row.skillName}（${row.skillId}） | ${row.character} | ${row.pack} | ${row.excludedBy || '未声明'} |`)
}
lines.push('')

writeFileSync('docs/qiexie-compatibility.md', lines.join('\n'), 'utf8')
// eslint-disable-next-line no-console
console.log(`技能 ${rows.length}，可借用 ${eligible.length}，不兼容 ${incompatible.length}`)
if (incompatible.length > 0) process.exitCode = 1
