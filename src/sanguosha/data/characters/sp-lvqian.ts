import { moveCard } from '../../engine/zones'
import { handleEquipmentLost } from '../../engine/equipment'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { grantSkill, registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吕虔（三国杀 OL 经典身份 SP）。
 *
 * 【威虏】：锁定技，一名角色对吕虔造成伤害后，吕虔下一次真正出牌阶段
 *          开始时，令其失去体力直到体力值为 1；这个回合结束时，吕虔
 *          回复其因此失去的体力值。
 * 【赠刀】：限定技，出牌阶段，吕虔可以将装备区任意数量的装备牌置于一名
 *          其他角色武将牌旁，称为「赠刀」；该角色每次造成伤害时可以移去
 *          一张赠刀牌，令这次伤害+1。
 */

const WEILU = 'weilu'
const ZENGDAO = 'zengdao'
const ZENGDAO_EFFECT = 'zengdao-effect'
const ZENGDAO_PILE = 'zengdao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WEILU,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const sourceId = context.event.sourceId
        const source = sourceId ? playerOf(host.state, sourceId) : undefined
        if (!source?.alive) return
        host.state.weiluPending ??= {}
        host.state.weiluPending[ownerId] ??= []
        host.state.weiluPending[ownerId].push(sourceId!)
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const pending = host.state.weiluPending?.[ownerId]
        if (!pending || pending.length === 0) return
        host.state.weiluPending![ownerId] = []
        host.state.weiluRecoverable ??= {}
        host.state.weiluRecoverable[ownerId] ??= []
        for (const sourceId of pending) {
          const source = playerOf(host.state, sourceId)
          if (!source?.alive || source.hp <= 1) continue
          const amount = source.hp - 1
          loseHp(host as never, sourceId, amount, WEILU)
          host.state.weiluRecoverable[ownerId].push({ sourceId, amount })
        }
        host.dispatch('SkillActivated', { skillId: WEILU, skillName: '威虏', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【威虏】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        const recoverable = host.state.weiluRecoverable?.[ownerId]
        if (!recoverable || recoverable.length === 0) return
        host.state.weiluRecoverable![ownerId] = []
        for (const entry of recoverable) {
          const source = playerOf(host.state, entry.sourceId)
          if (source?.alive) recover(host as never, entry.sourceId, entry.amount, ownerId)
        }
      },
    },
  ],
})

registerSkillRuntime({
  id: ZENGDAO,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ZENGDAO)) return []
    if (!Object.values(owner.zones.equipment).some((cardId) => cardId)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: ZENGDAO, label: '赠刀：将任意数量装备牌交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZENGDAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(ZENGDAO)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZENGDAO, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【赠刀】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const equipmentIds = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => !!cardId)
      if (equipmentIds.length === 0) return
      host.askSkill({
        skillId: ZENGDAO, ownerId, step: 'pick', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【赠刀】：选择要交给${target.nickname}的装备牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: equipmentIds, hiddenCardSlots: [], min: 1, max: equipmentIds.length,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((cardId) => Object.values(owner.zones.equipment).includes(cardId))
      if (valid.length === 0 || !target?.alive) return
      if (!owner.usedLimitedSkills.includes(ZENGDAO)) owner.usedLimitedSkills.push(ZENGDAO)
      for (const cardId of valid) {
        const slot = (Object.keys(owner.zones.equipment) as Array<keyof typeof owner.zones.equipment>)
          .find((key) => owner.zones.equipment[key] === cardId)
        if (!slot) continue
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'characterPile', playerId: targetId, pile: ZENGDAO_PILE })
        handleEquipmentLost(host as never, ownerId, cardId)
      }
      grantSkill(host.state, targetId, ZENGDAO_EFFECT)
      host.dispatch('SkillActivated', { skillId: ZENGDAO, skillName: '赠刀', playerId: ownerId, targetId, logText: `${owner.nickname}发动【赠刀】，交给${target.nickname}${valid.length}张装备牌` }, { sourceId: ownerId, targetId })
    }
  },
})

/** 拥有赠刀牌的角色（不一定是吕虔）造成伤害时消耗一张、伤害+1。 */
registerSkillRuntime({
  id: ZENGDAO_EFFECT,
  outgoingDamage(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    const pile = owner?.characterPiles[ZENGDAO_PILE]
    if (!owner?.alive || !pile || pile.length === 0) return null
    const [cardId] = pile
    moveCard(state, cardId, { kind: 'characterPile', playerId: ownerId, pile: ZENGDAO_PILE }, { kind: 'discardPile' })
    return { amount: context.amount + 1 }
  },
})

export const LVQIAN: CharacterDefinition = {
  id: 'lvqian',
  name: '吕虔',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: WEILU, name: '威虏', description: '锁定技，一名角色对吕虔造成伤害后，吕虔下一次真正出牌阶段开始时，令其失去体力直到体力值为1；这个回合结束时，吕虔回复其因此失去的体力值。' },
    { id: ZENGDAO, name: '赠刀', description: '限定技，出牌阶段，吕虔可以将装备区任意数量的装备牌置于一名其他角色武将牌旁；该角色每次造成伤害时可以移去一张赠刀牌，令这次伤害+1。' },
  ],
}
