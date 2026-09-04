/**
 * 夺锐兼容性审计。
 *
 * 遍历所有武将牌上的技能，判定能不能被【夺锐】夺走；
 * 对每个「可夺」的技能做一次真实的临时授予 → 查询运行时 → 序列化往返 → 解除，
 * 确认没有残留、也不会因为实现里写死了武将 id 而查不到。
 *
 *   node scripts/sanguosha-duorui-audit.mjs
 */
import { ALL_CHARACTERS, getCharacter } from '../src/sanguosha/data/characters/standard.ts'
import { evaluateSkillTheft } from '../src/sanguosha/engine/skill-theft.ts'
import { SanguoshaGame } from '../src/sanguosha/engine/game.ts'
import { ownedSkillIds, getSkillRuntime, replaceTemporarySkill } from '../src/sanguosha/engine/skills/runtime.ts'
import { suppressSkill, isSkillSuppressed, clearSkillSuppressionsOf } from '../src/sanguosha/engine/skill-suppression.ts'

function newGame() {
  const setup = { mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, nickname: `n${i}`, isHuman: false })) }
  const game = new SanguoshaGame({ seed: 'duorui-audit', setup })
  // 小偷固定用神张辽本人：换成别的武将会和被夺技能撞车
  // （审计初版让 p0 也是张飞，夺【咆哮】之后「解除仍残留」——那是他自带的，不是残留）
  game.state.players.forEach((p, i) => { p.identity = i === 0 ? 'lord' : 'rebel'; p.characterId = i === 0 ? 'shenzhangliao' : 'zhangfei' })
  game.start()
  while (game.state.pendingRequests.length) { const r = game.state.pendingRequests[0]
    game.respond({ requestId: r.id, playerId: r.playerId, payload: { optionId: 'no' } }) }
  return game
}

const eligible = []
const excluded = []
for (const character of ALL_CHARACTERS) {
  for (const skill of getCharacter(character.id).skills) {
    const verdict = evaluateSkillTheft(skill)
    const row = { characterId: character.id, characterName: character.name, skillId: skill.id, name: skill.name, reason: verdict.reason }
    if (verdict.eligible) eligible.push(row); else excluded.push(row)
  }
}

const incompatible = []
for (const row of eligible) {
  const game = newGame()
  const thief = 'p0', victim = 'p1'
  try {
    /*
     * 跳过神张辽自带的技能：夺锐的目标必须是**其他角色**，
     * 而普通武将一桌只会出现一个，所以「夺到自己也有的技能」在规则上不可达。
     * 不跳过的话「解除后仍残留」会误报——那残留的是他自带的那一份。
     */
    if (getCharacter('shenzhangliao').skills.some((skill) => skill.id === row.skillId)) continue
    game.state.players.find((p) => p.id === victim).characterId = row.characterId
    suppressSkill(game.state, { targetId: victim, skillId: row.skillId, sourceId: thief, sourceSkillId: 'duorui', armedAtTurn: 1 })
    replaceTemporarySkill(game.state, thief, 'duorui', row.skillId)

    if (isSkillSuppressed(game.state, victim, row.skillId) !== true) throw new Error('压制没生效')
    if (ownedSkillIds(game.state, victim).includes(row.skillId)) throw new Error('目标仍然拥有该技能')
    if (!ownedSkillIds(game.state, thief).includes(row.skillId)) throw new Error('神张辽没有拿到该技能')
    if (!getSkillRuntime(row.skillId)) throw new Error('运行时查不到')

    // 序列化往返之后仍然成立
    const restored = SanguoshaGame.restore(JSON.parse(JSON.stringify(game.serialize())))
    if (!ownedSkillIds(restored.state, thief).includes(row.skillId)) throw new Error('重连后神张辽丢了该技能')
    if (ownedSkillIds(restored.state, victim).includes(row.skillId)) throw new Error('重连后压制丢了')

    // 各类入口都能查到，不因为写死武将 id 而报错
    const runtime = getSkillRuntime(row.skillId)
    runtime.activeActions?.(restored.state, thief)
    runtime.viewAs?.(restored.state, thief)
    runtime.maxCardsBonus?.(restored.state, thief)
    runtime.retrial?.(restored.state, thief, victim)
    runtime.multiCardViewAs?.(restored.state, thief)

    // 解除之后两边都不残留
    clearSkillSuppressionsOf(restored.state, victim)
    replaceTemporarySkill(restored.state, thief, 'duorui', null)
    if (ownedSkillIds(restored.state, thief).includes(row.skillId)) throw new Error('解除后神张辽仍残留')
    if (!ownedSkillIds(restored.state, victim).includes(row.skillId)) throw new Error('解除后目标没拿回来')
  } catch (error) {
    incompatible.push({ ...row, error: String(error.message ?? error) })
  }
}

console.log(`可夺的普通技能：${eligible.length}`)
console.log(`排除的技能：${excluded.length}`)
const byReason = {}
for (const row of excluded) byReason[row.reason ?? '?'] = (byReason[row.reason ?? '?'] ?? 0) + 1
for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`  - ${reason}：${count}`)
console.log(`\n不兼容的可夺技能：${incompatible.length}`)
for (const row of incompatible) console.log(`  ✗ ${row.characterName}【${row.name}】(${row.skillId}) — ${row.error}`)
if (incompatible.length > 0) process.exitCode = 1
