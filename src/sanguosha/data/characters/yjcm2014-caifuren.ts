import { movePickedCard } from '../../engine/card-pick'
import { canTarget, getAttackRange } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蔡夫人（一将成名 2014）。
 *
 * 【窃听】：一名其他角色的回合结束时，若该角色本回合没有使用过指定除他自己
 *          以外角色为目标的牌，蔡夫人可以将其装备区一张牌移动到自己装备区
 *          对应空位，或者摸一张牌。
 * 【献州】：限定技，出牌阶段，蔡夫人将装备区所有牌交给一名其他角色，目标
 *          选择：令蔡夫人回复 X 点体力，或选择其攻击范围内至多 X 名其他
 *          角色，依次对其各造成 1 点伤害（X 为实际交出的装备牌数量）。
 *
 * 三处最容易做错的：
 *
 * 1. **窃听的条件是「本回合有没有用过指定别人为目标的牌」**，只指定自己、
 *    无目标、装备牌都不算破坏条件；走 `AfterCardUse` 记账，按回合号存。
 * 2. **窃听 A 是装备区之间的直接移动**，不路过蔡夫人手牌，且不能顶掉
 *    蔡夫人对应槽位已有的装备——候选先按「对应槽位为空」过滤。
 * 3. **献州伤害的来源是目标本人**，不是蔡夫人；目标选项 B 的候选范围
 *    按目标自己的攻击范围算，不能选自己。
 */

const QIETING = 'qieting'
const XIANZHOU = 'xianzhou'
const TURN_TARGET_MARK = 'qieting-used-other-target'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function usedOtherTargetThisTurn(state: SanguoshaState, playerId: PlayerId): boolean {
  return (playerOf(state, playerId)?.marks[TURN_TARGET_MARK] ?? -1) === state.turnNumber
}

/** 目标装备区里，蔡夫人对应槽位为空、可以被窃听移过来的牌。 */
function stealableEquipment(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner || !target) return []
  const result: CardId[] = []
  for (const [slot, cardId] of Object.entries(target.zones.equipment) as Array<[EquipmentSlot, CardId | null]>) {
    if (cardId && !owner.zones.equipment[slot]) result.push(cardId)
  }
  return result
}

registerSkillRuntime({
  id: QIETING,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { targetIds?: PlayerId[] }
        const userId = context.event.sourceId as PlayerId | undefined
        if (!userId || !payload.targetIds?.some((id) => id !== userId)) return
        const user = playerOf(host.state, userId)
        if (user) user.marks[TURN_TARGET_MARK] = host.state.turnNumber
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const targetId = payload.playerId
        if (!targetId || targetId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const target = playerOf(host.state, targetId)
        if (!owner?.alive || !target?.alive) return
        if (usedOtherTargetThisTurn(host.state, targetId)) return
        host.queueSkill({ skillId: QIETING, ownerId, step: 'ask', data: { targetId } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    const candidates = stealableEquipment(host.state, ownerId, targetId)
    host.askSkill({
      skillId: QIETING, ownerId, step: 'choice', data: { targetId, candidates },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【窃听】：选择一项`,
        timeoutMs: 20_000, optional: true,
        options: [
          ...(candidates.length > 0 ? [{ id: 'move', label: '移动其一张装备到自己装备区' }] : []),
          { id: 'draw', label: '摸一张牌' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const candidates = resolution.data.candidates as CardId[]
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!owner?.alive) return
      if (optionId === 'move' && candidates.length > 0) {
        host.askSkill({
          skillId: QIETING, ownerId, step: 'move-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【窃听】：选择要移动到自己装备区的牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: candidates, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      host.dispatch('SkillActivated', {
        skillId: QIETING, skillName: '窃听', playerId: ownerId,
        logText: `${owner.nickname}发动【窃听】，摸一张牌`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      return
    }

    if (resolution.step === 'move-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !target?.alive || !cardId) return
      const card = host.state.cards[cardId]
      const slot = card?.equipmentSlot
      if (!slot || target.zones.equipment[slot] !== cardId || owner.zones.equipment[slot]) return
      if (movePickedCard(host as never, targetId, cardId, { kind: 'equipment', playerId: ownerId, slot })) {
        host.dispatch('SkillActivated', {
          skillId: QIETING, skillName: '窃听', playerId: ownerId, targetId, cardIds: [cardId],
          logText: `${owner.nickname}发动【窃听】，将${target.nickname}的一张装备移到自己装备区`,
        }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      }
    }
  },
})

registerSkillRuntime({
  id: XIANZHOU,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIANZHOU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: XIANZHOU, label: '献州：将装备区所有牌交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIANZHOU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIANZHOU)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XIANZHOU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【献州】：选择一名其他角色',
        timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      owner.usedLimitedSkills.push(XIANZHOU)
      const cardIds = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
      for (const cardId of cardIds) {
        const slot = host.state.cards[cardId]?.equipmentSlot!
        moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'hand', playerId: targetId! })
      }
      if (cardIds.length > 0) host.dispatch('GainCard', { playerId: targetId, cardIds, reason: XIANZHOU }, { sourceId: ownerId, targetId, cardIds })
      host.dispatch('SkillActivated', {
        skillId: XIANZHOU, skillName: '献州', playerId: ownerId, targetId, cardIds,
        logText: `${owner.nickname}发动【献州】，交给${target.nickname} ${cardIds.length} 张装备牌`,
      }, { sourceId: ownerId, targetId, cardIds })
      if (cardIds.length === 0) return
      const range = getAttackRange(host.state, targetId!)
      const damageCandidates = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== targetId && canTarget(host.state, targetId!, candidate.id, range))
        .map((candidate) => candidate.id)
      host.askSkill({
        skillId: XIANZHOU, ownerId, step: 'choice', data: { targetId, x: cardIds.length },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId!,
          prompt: `${owner.nickname}发动【献州】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            { id: 'recover', label: `令${owner.nickname}回复 ${cardIds.length} 点体力` },
            ...(damageCandidates.length > 0 ? [{ id: 'damage', label: `选择至多 ${cardIds.length} 名攻击范围内的角色，各造成 1 点伤害` }] : []),
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const x = resolution.data.x as number
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) return
      if (optionId === 'damage') {
        const range = getAttackRange(host.state, targetId)
        const candidateIds = host.state.players
          .filter((candidate) => candidate.alive && candidate.id !== targetId && canTarget(host.state, targetId, candidate.id, range))
          .map((candidate) => candidate.id)
        if (candidateIds.length === 0) { recover(host as never, ownerId, x, XIANZHOU); return }
        host.askSkill({
          skillId: XIANZHOU, ownerId, step: 'damage-target', data: { targetId },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: targetId,
            prompt: `【献州】：选择至多 ${x} 名角色，各造成 1 点伤害`,
            timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: Math.min(x, candidateIds.length),
          }),
        })
        return
      }
      recover(host as never, ownerId, x, XIANZHOU)
      return
    }

    if (resolution.step === 'damage-target') {
      const sourceId = resolution.data.targetId as PlayerId
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      dealXianzhouDamage(host, sourceId, targetIds, 0)
    }
  },

  startQueued(host, _ownerId, prompt) {
    if (prompt.step !== 'damage-continue') return
    const { sourceId, targetIds, index } = prompt.data as { sourceId: PlayerId; targetIds: PlayerId[]; index: number }
    dealXianzhouDamage(host, sourceId, targetIds, index)
  },
})

function dealXianzhouDamage(host: SkillHost, sourceId: PlayerId, targetIds: PlayerId[], index: number): void {
  for (let i = index; i < targetIds.length; i += 1) {
    const targetId = targetIds[i]
    if (playerOf(host.state, targetId)?.alive) {
      resolveDamage(host as never, { sourceId, targetId, amount: 1, nature: 'normal', cardName: null })
    }
    if (host.state.dying || host.state.damageChain) {
      host.queueSkill({ skillId: XIANZHOU, ownerId: sourceId, step: 'damage-continue', data: { sourceId, targetIds, index: i + 1 } })
      return
    }
  }
}

export const CAIFUREN: CharacterDefinition = {
  id: 'caifuren',
  name: '蔡夫人',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: QIETING,
      name: '窃听',
      description: '一名其他角色的回合结束时，若该角色本回合没有使用过指定除他自己以外角色为目标的牌，蔡夫人可以将其装备区一张牌移动到自己装备区对应空位，或者摸一张牌。',
    },
    {
      id: XIANZHOU,
      name: '献州',
      description: '限定技，出牌阶段，蔡夫人将装备区所有牌交给一名其他角色，目标选择：令蔡夫人回复 X 点体力，或选择其攻击范围内至多 X 名其他角色，依次对其各造成 1 点伤害（X 为实际交出的装备牌数量）。',
    },
  ],
}
