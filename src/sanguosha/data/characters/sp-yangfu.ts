import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { isSlotAbolished } from '../../engine/equipment-slots'
import { handleEquipmentLost } from '../../engine/equipment'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 杨阜（三国杀 OL 经典身份 SP）。
 *
 * 【屏忠】：锁定技，X=当前没有手牌的存活角色数+1；杨阜每个 TurnInstance
 *          使用的前X张牌各可以额外指定至多X个目标（额外目标只对天然支持
 *          扩展目标的牌生效，目前只接入【杀】，普通锦囊没有通用扩展目标
 *          入口，这部分是已知简化）；受到伤害后摸X张牌（X为此刻的动态值）。
 * 【肃衣】：出牌阶段限一次，杨阜选择一名其他角色A，令A使用（直接放置）
 *          牌堆中随机一张合法装备牌，然后杨阜视为对A使用一张杀。
 */

const PINGZHONG = 'pingzhong'
const SUYI = 'suyi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function pingzhongX(state: SanguoshaState): number {
  return state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length === 0).length + 1
}

registerSkillRuntime({
  id: PINGZHONG,
  extraSlashTargets(state, ownerId) {
    if (state.currentPlayerId !== ownerId) return 0
    const entry = state.yangfuCardUseCount?.[ownerId]
    const usedThisTurn = entry?.turnNumber === state.turnNumber ? entry.count : 0
    const x = pingzhongX(state)
    // 当前这次使用会是第 usedThisTurn+1 张；只在序号落在前 X 张时给加成
    return usedThisTurn < x ? x : 0
  },

  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId !== ownerId) return
        const entry = host.state.yangfuCardUseCount?.[ownerId]
        const count = entry?.turnNumber === host.state.turnNumber ? entry.count + 1 : 1
        host.state.yangfuCardUseCount ??= {}
        host.state.yangfuCardUseCount[ownerId] = { turnNumber: host.state.turnNumber, count }
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const x = pingzhongX(host.state)
        host.dispatch('SkillActivated', { skillId: PINGZHONG, skillName: '屏忠', playerId: ownerId, logText: `${owner.nickname}发动【屏忠】，摸${x}张牌` }, { sourceId: ownerId })
        drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
      },
    },
  ],
})

registerSkillRuntime({
  id: SUYI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SUYI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: SUYI, label: '肃衣：选择一名其他角色随机装备一张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SUYI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SUYI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: SUYI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【肃衣】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SUYI)) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    owner.turnUsedSkills.push(SUYI)
    host.dispatch('SkillActivated', { skillId: SUYI, skillName: '肃衣', playerId: ownerId, targetId, logText: `${owner.nickname}发动【肃衣】` }, { sourceId: ownerId, targetId })

    const candidates = host.state.zones.drawPile.filter((cardId) => {
      const card = host.state.cards[cardId]
      return card?.category === 'equipment' && card.equipmentSlot && !isSlotAbolished(host.state, target.id, card.equipmentSlot)
    })
    if (candidates.length > 0) {
      const picked = candidates[host.rng.nextInt(candidates.length)]
      const card = host.state.cards[picked]!
      const slot = card.equipmentSlot!
      const replaced = target.zones.equipment[slot]
      moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'equipment', playerId: target.id, slot })
      if (replaced) handleEquipmentLost(host as never, target.id, replaced)
      host.dispatch('SkillActivated', { skillId: SUYI, skillName: '肃衣', playerId: ownerId, targetId, logText: `${target.nickname}使用了【${card.name}】` }, { sourceId: target.id, targetId: target.id })
    }
    if (!playerOf(host.state, target.id)?.alive) return
    host.beginVirtualSlash({ sourceId: ownerId, targetId: target.id, sourceSkillId: SUYI })
  },
})

export const YANGFU: CharacterDefinition = {
  id: 'yangfu',
  name: '杨阜',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: PINGZHONG, name: '屏忠', description: '锁定技，X=当前没有手牌的存活角色数+1；杨阜每个 TurnInstance 使用的前X张【杀】各可以额外指定至多X个目标；受到伤害后摸X张牌。' },
    { id: SUYI, name: '肃衣', description: '出牌阶段限一次，杨阜选择一名其他角色，令其使用牌堆中随机一张合法装备牌，然后杨阜视为对其使用一张杀。' },
  ],
}
