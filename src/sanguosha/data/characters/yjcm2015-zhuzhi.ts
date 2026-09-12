import { drawCards } from '../../engine/draw'
import { equipmentCountOf } from '../../engine/equipment-exchange'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 朱治（一将成名 2015）。
 *
 * 【安国】：出牌阶段限一次，你可以选择一名其他角色：若其手牌数为全场最少，
 *          其摸一张牌；若其体力值为全场最低，其回复 1 点体力；若其装备区
 *          内的牌数为全场最少，其随机使用一张装备牌。若该角色有满足条件但
 *          未执行的分支，你执行之。
 *
 * 最容易做错的：**「全场最少/最低」是严格唯一最小**——目标的数值要严格
 * 小于其余每一名存活角色，出现并列就不算数；三个分支互不排斥，同一名目标
 * 可能同时触发多条。
 */

const ANGUO = 'anguo'
const USED_TURN_MARK = 'anguo-used-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isStrictMin(state: SanguoshaState, playerId: PlayerId, valueOf: (id: PlayerId) => number): boolean {
  const alive = state.players.filter((candidate) => candidate.alive)
  const value = valueOf(playerId)
  return alive.every((candidate) => candidate.id === playerId || valueOf(candidate.id) > value)
}

function handCountOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.zones.hand.length ?? 0
}

function hpOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.hp ?? 0
}

function angouBranches(state: SanguoshaState, targetId: PlayerId) {
  return {
    hand: isStrictMin(state, targetId, (id) => handCountOf(state, id)),
    hp: isStrictMin(state, targetId, (id) => hpOf(state, id)),
    equipment: isStrictMin(state, targetId, (id) => equipmentCountOf({ state } as never, id)),
  }
}

function angouTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => {
      const branches = angouBranches(state, candidate.id)
      return branches.hand || branches.hp || branches.equipment
    })
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: ANGUO,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.marks[USED_TURN_MARK] === state.turnNumber) return []
    if (angouTargets(state, ownerId).length === 0) return []
    return [{ id: ANGUO, label: '安国：选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ANGUO) return
    const candidateIds = angouTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ANGUO, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【安国】：选择一名其他角色',
        timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    owner.marks[USED_TURN_MARK] = host.state.turnNumber
    const branches = angouBranches(host.state, targetId!)
    if (!branches.hand && !branches.hp && !branches.equipment) return

    host.dispatch('SkillActivated', {
      skillId: ANGUO, skillName: '安国', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【安国】，目标${target.nickname}`,
    }, { sourceId: ownerId, targetId })

    if (branches.hand) drawCards(host.state, host.rng, targetId!, 1, (name, payload) => { host.dispatch(name, payload) })

    if (branches.hp) recover(host as never, targetId!, 1, ownerId)

    if (branches.equipment) {
      const equipped = Object.entries(target.zones.equipment).filter(([, cardId]) => cardId) as Array<[string, CardId]>
      if (equipped.length > 0) {
        const [slot, cardId] = equipped[host.rng.nextInt(equipped.length)]
        // 「随机使用一张装备牌」：已在装备区的牌重新走一遍装备流程，触发它上场时的被动效果
        moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId!, slot: slot as never }, { kind: 'processingArea' })
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId: targetId!, slot: slot as never })
        host.dispatch('CardMove', { cardIds: [cardId], reason: ANGUO, revealed: true }, { sourceId: targetId, cardIds: [cardId] })
      }
    }
  },
})

export const ZHUZHI: CharacterDefinition = {
  id: 'zhuzhi',
  name: '朱治',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: ANGUO,
      name: '安国',
      description: '出牌阶段限一次，你可以选择一名其他角色：若其手牌数为全场最少，其摸一张牌；若其体力值为全场最低，其回复 1 点体力；若其装备区内的牌数为全场最少，其随机使用一张装备牌。若该角色有满足条件但未执行的分支，你执行之。',
    },
  ],
}
