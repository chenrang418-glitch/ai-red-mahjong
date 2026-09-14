import { TIAOXIN } from './mountain-jiangwei'
import { registerSkillRuntime, replaceTemporarySkills, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 夏侯霸（三国杀 OL 经典身份 SP）。
 *
 * 【豹变】：锁定技，根据你当前体力值获得以下技能：体力值不大于3-挑衅
 *          （姜维）；不大于2-再获得咆哮（张飞）；等于1-再获得神速
 *          （夏侯渊）。
 */

const BAOBIAN = 'baobian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function grantedBaobianSkillsOf(state: SanguoshaState, ownerId: PlayerId): string[] {
  return (state.players.find((candidate) => candidate.id === ownerId)?.temporaryGrantedSkills ?? [])
    .filter((entry) => entry.source === BAOBIAN)
    .map((entry) => entry.skillId)
}

function recomputeBaobian(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const before = grantedBaobianSkillsOf(host.state, ownerId)
  if (!owner?.alive) { replaceTemporarySkills(host.state, ownerId, BAOBIAN, []); return }
  const grants: string[] = []
  if (owner.hp <= 3) grants.push(TIAOXIN)
  if (owner.hp <= 2) grants.push('paoxiao')
  if (owner.hp <= 1) grants.push('shensu')
  replaceTemporarySkills(host.state, ownerId, BAOBIAN, grants)
  if (grants.length !== before.length || grants.some((id, index) => id !== before[index])) {
    host.dispatch('SkillActivated', { skillId: BAOBIAN, skillName: '豹变', playerId: ownerId, logText: `${owner.nickname}的【豹变】重新结算：${grants.length > 0 ? grants.join('、') : '（无）'}` }, { sourceId: ownerId })
  }
}

registerSkillRuntime({
  id: BAOBIAN,
  onGameStart(host, ownerId) { recomputeBaobian(host, ownerId) },
  triggers: [
    { event: 'Damaged', handle(host, ownerId, context) { if (context.event.targetId === ownerId) recomputeBaobian(host, ownerId) } },
    { event: 'Recover', handle(host, ownerId, context) { if (context.event.targetId === ownerId) recomputeBaobian(host, ownerId) } },
    { event: 'LoseHp', handle(host, ownerId, context) { if (context.event.targetId === ownerId) recomputeBaobian(host, ownerId) } },
    { event: 'MaxHpChange', handle(host, ownerId, context) { if (context.event.targetId === ownerId) recomputeBaobian(host, ownerId) } },
  ],
})

export const XIAHOUBA: CharacterDefinition = {
  id: 'xiahouba',
  name: '夏侯霸',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: BAOBIAN, name: '豹变', description: '锁定技，根据你当前体力值获得以下技能：体力值不大于3-挑衅；不大于2-再获得咆哮；等于1-再获得神速。' },
  ],
}
