import { getDistance } from '../../engine/distance'
import { suppressArmor } from '../../engine/armor-suppression'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吴懿（一将成名 2014）。
 *
 * 【奔袭】：锁定技，吴懿于自己的回合内使用的一张牌结算结束后，直到本回合
 *          结束，吴懿与其他角色的距离 -1（可累计）；若他与所有其他存活角色
 *          的距离均为 1，则他无视其他角色的防具，且使用【杀】可以额外指定
 *          一个目标。
 *
 * 两处最容易做错的：
 *
 * 1. **距离 -1 只影响吴懿→其他角色这一侧**，不影响其他角色看吴懿的距离；
 *    按本回合已结算的用牌数累计，回合结束（`turnNumber` 变化）天然重置。
 * 2. **「全场距离 1」是现算的动态条件**，不建立常驻状态；防具无视和额外
 *    目标都在使用【杀】的那一刻各自判断一次。
 */

const BENXI = 'benxi'
const TURN_MARK = 'benxi-turn'
const COUNT_MARK = 'benxi-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function usedCardCountThisTurn(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner || owner.marks[TURN_MARK] !== state.turnNumber) return 0
  return owner.marks[COUNT_MARK] ?? 0
}

function allOthersDistanceOne(state: SanguoshaState, ownerId: PlayerId): boolean {
  const others = state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
  if (others.length === 0) return false
  return others.every((candidate) => getDistance(state, ownerId, candidate.id) === 1)
}

registerSkillRuntime({
  id: BENXI,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        if (owner.marks[TURN_MARK] !== host.state.turnNumber) {
          owner.marks[TURN_MARK] = host.state.turnNumber
          owner.marks[COUNT_MARK] = 0
        }
        owner.marks[COUNT_MARK] = (owner.marks[COUNT_MARK] ?? 0) + 1
      },
    },
    {
      // 无视防具在使用【杀】指定目标的那一刻各自判断
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string; targetId?: PlayerId }
        if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || !payload.targetId) return
        if (!allOthersDistanceOne(host.state, ownerId)) return
        suppressArmor(host.state, ownerId, payload.targetId, BENXI)
      },
    },
  ],

  distanceModifier: {
    toOthers: (state, ownerId) => -usedCardCountThisTurn(state, ownerId),
  },

  extraSlashTargets(state, ownerId) {
    return allOthersDistanceOne(state, ownerId) ? 1 : 0
  },
})

export const WUYI: CharacterDefinition = {
  id: 'wuyi',
  name: '吴懿',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2014',
  skills: [
    {
      id: BENXI,
      name: '奔袭',
      description: '锁定技，吴懿于自己的回合内使用的一张牌结算结束后，直到本回合结束，吴懿与其他角色的距离 -1（可累计）；若他与所有其他存活角色的距离均为 1，则他无视其他角色的防具，且使用【杀】可以额外指定一个目标。',
    },
  ],
}
