import { drawCards } from '../../engine/draw'
import { effectiveKingdomOf } from '../../engine/huashen'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘辩（三国杀 OL 经典身份 SP）。
 *
 * 【诗怨】：刘辩成为其他角色使用牌的目标后，比较来源与自己的体力值：
 *          来源更高摸3、相同摸2、更低摸1；三个分支各限一次（受【余威】
 *          影响时改为各限2次）。
 * 【毒逝】：锁定技，刘辩处于濒死时，其他角色不能对其使用【桃】；刘辩
 *          真正死亡时，选择一名其他存活角色永久获得【毒逝】。
 * 【余威】：主公技，锁定技，刘辩担任主公时，自己回合内其他群势力角色的
 *          诗怨三个分支限制各改为2次。
 */

const SHIYUAN = 'shiyuan'
const DUSHI = 'dushi'
const YUWEI = 'yuwei'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function shiyuanLimit(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 1
  const currentOwner = playerOf(state, state.currentPlayerId)
  if (!currentOwner || currentOwner.id === ownerId || effectiveKingdomOf(state, currentOwner.id) !== 'qun') return 1
  const liubian = state.players.find((candidate) => candidate.characterId === 'liubian' && candidate.alive)
  return liubian && liubian.identity === 'lord' ? 2 : 1
}

registerSkillRuntime({
  id: SHIYUAN,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId || !context.event.sourceId || context.event.sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      const source = playerOf(host.state, context.event.sourceId)
      if (!owner?.alive || !source?.alive) return
      const branch = source.hp > owner.hp ? 'greater' : source.hp === owner.hp ? 'equal' : 'less'
      // 三个分支的限次是"每个 TurnInstance"，必须按回合归零，不能用永久 marks 记账
      host.state.liubianShiyuanUsed ??= {}
      const record = host.state.liubianShiyuanUsed[ownerId]
      const counts = record?.turnNumber === host.state.turnNumber ? record.counts : { greater: 0, equal: 0, less: 0 }
      const used = counts[branch]
      const limit = shiyuanLimit(host.state, ownerId)
      if (used >= limit) return
      host.state.liubianShiyuanUsed[ownerId] = { turnNumber: host.state.turnNumber, counts: { ...counts, [branch]: used + 1 } }
      const drawCount = branch === 'greater' ? 3 : branch === 'equal' ? 2 : 1
      host.dispatch('SkillActivated', { skillId: SHIYUAN, skillName: '诗怨', playerId: ownerId, logText: `${owner.nickname}发动【诗怨】，摸${drawCount}张牌` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, drawCount, (name, payload) => { host.dispatch(name, payload) })
    },
  }],
})

registerSkillRuntime({
  id: DUSHI,
  prohibitsCardUse(_state, ownerId, context) {
    return context.cardName === '桃' && context.dyingPlayerId === ownerId && context.userId !== ownerId
  },
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !candidate.grantedSkills?.includes(DUSHI)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      const picked = candidateIds[host.rng.nextInt(candidateIds.length)]
      grantSkill(host.state, picked, DUSHI)
      host.dispatch('SkillActivated', { skillId: DUSHI, skillName: '毒逝', playerId: ownerId, targetId: picked, logText: `${playerOf(host.state, picked)?.nickname}获得【毒逝】` }, { sourceId: ownerId, targetId: picked })
    },
  }],
})

registerSkillRuntime({
  id: YUWEI,
  lord: true,
})

export const LIUBIAN: CharacterDefinition = {
  id: 'liubian',
  name: '刘辩',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: SHIYUAN, name: '诗怨', description: '刘辩成为其他角色使用牌的目标后，来源体力值比自己高则摸3、相同摸2、更低摸1，三项各限一次。' },
    { id: DUSHI, name: '毒逝', description: '锁定技，刘辩处于濒死时，其他角色不能对其使用【桃】；刘辩死亡时，选择一名其他存活角色永久获得此技能。' },
    { id: YUWEI, name: '余威', description: '主公技，锁定技，刘辩担任主公时，自己回合内其他群势力角色的诗怨三项限制各改为2次。' },
  ],
}
