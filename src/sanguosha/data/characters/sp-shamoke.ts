import { drawCards } from '../../engine/draw'
import { getAttackRange } from '../../engine/distance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 沙摩柯（三国杀 OL 经典身份 SP）。
 *
 * 【蒺藜】：每个回合，沙摩柯统计自己使用/打出牌的顺序；当他本回合使用或
 *          打出的第 X 张牌完成时（X 为当前攻击范围，每次都现算），摸 X
 *          张牌。攻击范围中途变化会让节奏跟着变，同一回合理论上可以多次
 *          满足条件（不限一次）。
 */

const JILI = 'jili'
const COUNT_MARK = 'jili-count'
const TURN_MARK = 'jili-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bumpAndCheck(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (owner.marks[TURN_MARK] !== host.state.turnNumber) {
    owner.marks[TURN_MARK] = host.state.turnNumber
    owner.marks[COUNT_MARK] = 0
  }
  owner.marks[COUNT_MARK] = (owner.marks[COUNT_MARK] ?? 0) + 1
  const x = getAttackRange(host.state, ownerId)
  if (owner.marks[COUNT_MARK] !== x) return
  drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
  host.dispatch('SkillActivated', { skillId: JILI, skillName: '蒺藜', playerId: ownerId, logText: `${owner.nickname}发动【蒺藜】，摸${x}张牌` }, { sourceId: ownerId })
}

registerSkillRuntime({
  id: JILI,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        bumpAndCheck(host, ownerId)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        bumpAndCheck(host, ownerId)
      },
    },
  ],
})

export const SHAMOKE: CharacterDefinition = {
  id: 'shamoke',
  name: '沙摩柯',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JILI, name: '蒺藜', description: '每个回合，沙摩柯统计自己使用/打出牌的顺序，当第X张（X为当前攻击范围）完成使用/打出时，摸X张牌。' },
  ],
}
