import { moveCard } from '../../engine/zones'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 徐荣（三国杀 OL 经典身份 SP）。
 *
 * 【凶镬】：游戏开始时获得3枚【暴戾】（自己最多3枚）；出牌阶段可以给一名
 *          没有暴戾的其他角色1枚（不限次数）；对带有暴戾的角色造成的
 *          任意伤害+1；带有暴戾的角色回合开始时移除暴戾，然后随机（确定性
 *          随机源）结算一项：受到1点火焰伤害且本回合不能用杀指定徐荣；
 *          或失去1点体力且本回合手牌上限-1；或徐荣随机获得其1张手牌和1张
 *          装备牌。
 * 【杀绝】：锁定技，其他角色进入濒死时徐荣获得1枚暴戾（不超过3枚上限）；
 *          若其需要回复至少2点体力才能脱离濒死，徐荣获得令其进入本次
 *          濒死的那张实体牌（仅当那张牌当时仍可合法取得）。
 */

const XIONGHUO = 'xionghuo'
const SHAJUE = 'shajue'
const BAOLI_MARK = 'baoli'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function baoliOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[BAOLI_MARK] ?? 0
}

registerSkillRuntime({
  id: XIONGHUO,
  triggers: [
    {
      event: 'GameStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (owner) owner.marks[BAOLI_MARK] = 3
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || !payload.playerId) return
        const target = playerOf(host.state, payload.playerId)
        if (!target?.alive || baoliOf(host.state, target.id) <= 0) return
        target.marks[BAOLI_MARK] = 0
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        // 阶段开始这个时机不安全，可能级联出濒死求救之类的挂起流程——排到队列里再结算
        host.queueSkill({ skillId: XIONGHUO, ownerId, step: 'resolve', data: { targetId: target.id } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'resolve') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const branch = host.rng.nextInt(3)
    host.dispatch('SkillActivated', { skillId: XIONGHUO, skillName: '凶镬', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【凶镬】` }, { sourceId: ownerId, targetId: target.id })
    if (branch === 0) {
      host.state.xurongSlashBan ??= {}
      host.state.xurongSlashBan[target.id] = { turnNumber: host.state.turnNumber }
      if (owner.id !== target.id) resolveDamage(host as never, { sourceId: owner.id, targetId: target.id, amount: 1, nature: 'fire', cardName: null })
    } else if (branch === 1) {
      host.state.xurongMaxCardsDebuff ??= {}
      host.state.xurongMaxCardsDebuff[target.id] = { turnNumber: host.state.turnNumber }
      loseHp(host as never, target.id, 1, XIONGHUO)
    } else {
      if (target.zones.hand.length > 0) {
        const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: owner.id })
        host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: XIONGHUO }, { sourceId: target.id, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: owner.id, cardIds: [cardId], reason: XIONGHUO }, { targetId: owner.id, cardIds: [cardId] })
      }
      const equipped = Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
      if (equipped.length > 0) {
        const cardId = equipped[host.rng.nextInt(equipped.length)]
        const slot = (Object.entries(target.zones.equipment).find(([, id]) => id === cardId) ?? [])[0]
        if (slot) {
          moveCard(host.state, cardId, { kind: 'equipment', playerId: target.id, slot: slot as never }, { kind: 'hand', playerId: owner.id })
          host.dispatch('LoseEquipment', { playerId: target.id, cardId }, { sourceId: target.id, cardIds: [cardId] })
          host.dispatch('GainCard', { playerId: owner.id, cardIds: [cardId], reason: XIONGHUO }, { targetId: owner.id, cardIds: [cardId] })
        }
      }
    }
  },

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (baoliOf(state, ownerId) <= 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && baoliOf(state, candidate.id) <= 0)) return []
    return [{ id: XIONGHUO, label: '凶镬：分配1枚暴戾给没有暴戾的角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIONGHUO) return
    if (baoliOf(host.state, ownerId) <= 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && baoliOf(host.state, candidate.id) <= 0).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XIONGHUO, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【凶镬】：分配1枚暴戾', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || baoliOf(host.state, ownerId) <= 0 || baoliOf(host.state, target.id) > 0) return
    owner.marks[BAOLI_MARK] = baoliOf(host.state, ownerId) - 1
    target.marks[BAOLI_MARK] = 1
    host.dispatch('SkillActivated', { skillId: XIONGHUO, skillName: '凶镬', playerId: ownerId, targetId: target.id, logText: `${owner.nickname}发动【凶镬】，给予暴戾` }, { sourceId: ownerId, targetId: target.id })
  },

  outgoingDamage(state, _ownerId, context) {
    if (baoliOf(state, context.targetId) <= 0) return null
    return { amount: context.amount + 1 }
  },

  globalMaxCardsBonus(state, _ownerId, targetId) {
    return state.xurongMaxCardsDebuff?.[targetId]?.turnNumber === state.turnNumber ? -1 : 0
  },

  prohibitsTarget(state, _ownerId, sourceId, cardName) {
    if (cardName !== '杀') return false
    return state.xurongSlashBan?.[sourceId]?.turnNumber === state.turnNumber
  },
})

registerSkillRuntime({
  id: SHAJUE,
  triggers: [
    {
      event: 'Damaged',
      handle(host, _ownerId, context) {
        const targetId = context.event.targetId
        if (!targetId) return
        const payload = context.event.payload as { cardId?: CardId }
        host.state.shajueLastDamageCard ??= {}
        if (payload.cardId) host.state.shajueLastDamageCard[targetId] = payload.cardId
        else delete host.state.shajueLastDamageCard[targetId]
      },
    },
    {
      event: 'EnterDying',
      handle(host, ownerId, context) {
        const dyingId = context.event.targetId
        if (!dyingId || dyingId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const dying = playerOf(host.state, dyingId)
        if (!owner?.alive || !dying) return
        if (baoliOf(host.state, ownerId) < 3) owner.marks[BAOLI_MARK] = baoliOf(host.state, ownerId) + 1
        host.dispatch('SkillActivated', { skillId: SHAJUE, skillName: '杀绝', playerId: ownerId, targetId: dyingId, logText: `${owner.nickname}发动【杀绝】` }, { sourceId: ownerId, targetId: dyingId })

        if (dying.hp <= -1) {
          const cardId = host.state.shajueLastDamageCard?.[dyingId]
          if (cardId && host.state.zones.processingArea.includes(cardId)) {
            moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
            host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHAJUE }, { targetId: ownerId, cardIds: [cardId] })
          } else if (cardId && host.state.zones.discardPile.includes(cardId)) {
            moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
            host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: SHAJUE }, { targetId: ownerId, cardIds: [cardId] })
          }
        }
        if (host.state.shajueLastDamageCard) delete host.state.shajueLastDamageCard[dyingId]
      },
    },
  ],
})

export const XURONG: CharacterDefinition = {
  id: 'xurong',
  name: '徐荣',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: XIONGHUO, name: '凶镬',
      description: '游戏开始时获得3枚【暴戾】（自己最多3枚）；出牌阶段可以给一名没有暴戾的其他角色1枚；徐荣对带有暴戾的角色造成的伤害+1；带有暴戾的角色回合开始时移除暴戾，随机受到1点火焰伤害且本回合不能用杀指定徐荣、或失去1点体力且本回合手牌上限-1、或徐荣随机获得其1张手牌和1张装备牌。',
    },
    {
      id: SHAJUE, name: '杀绝',
      description: '锁定技，其他角色进入濒死时，徐荣获得1枚暴戾（不超过3枚）；若其需要回复至少2点体力才能脱离濒死，徐荣获得令其进入本次濒死的那张实体牌。',
    },
  ],
}
