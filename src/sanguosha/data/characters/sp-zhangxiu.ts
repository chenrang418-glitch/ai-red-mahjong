import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { ABOLISHABLE_SLOTS, abolishSlot } from '../../engine/equipment-slots'
import { lockCardCategory } from '../../engine/card-play-lock'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张绣（三国杀 OL 经典身份 SP）。
 *
 * 【雄乱】：限定技，出牌阶段，废除自己整个判定区（复用既有装备栏废除的
 *          同款思路：判定区里的牌进入弃牌堆，之后靠 `prohibitsTarget`
 *          拒绝一切延时锦囊把张绣设为目标，等价于「判定区已废」）和全部
 *          装备栏（`abolishSlot` 原样复用）；然后指定一名其他角色 A，直到
 *          本回合结束张绣对 A 使用牌无距离/次数限制，且 A 本回合不能
 *          使用或打出手牌（对三个牌类别各挂一条 `lockCardCategory`）。
 * 【从谏】：张绣成为一张多目标锦囊牌的目标后，可以交给其中一名目标一张
 *          牌，然后摸1张（若给出的是装备牌则改为摸2张，不是额外多摸）。
 */

const XIONGLUAN = 'xiongluan'
const CONGJIAN = 'congjian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function turnBound(state: SanguoshaState, entry: { targetId: PlayerId; turnNumber: number } | undefined, targetId: PlayerId): boolean {
  return !!entry && entry.turnNumber === state.turnNumber && entry.targetId === targetId
}

registerSkillRuntime({
  id: XIONGLUAN,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIONGLUAN)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: XIONGLUAN, label: '雄乱：废除判定区与全部装备栏，指定一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIONGLUAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(XIONGLUAN)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XIONGLUAN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【雄乱】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  prohibitsTarget(state, ownerId, _sourceId, cardName) {
    if (!DELAYED_TRICKS.has(cardName)) return false
    return (state.zhangxiuJudgmentAbolished ?? []).includes(ownerId)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive || owner.usedLimitedSkills.includes(XIONGLUAN)) return
    owner.usedLimitedSkills.push(XIONGLUAN)

    for (const cardId of [...owner.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: ownerId }, { kind: 'discardPile' })
    }
    host.state.zhangxiuJudgmentAbolished ??= []
    if (!host.state.zhangxiuJudgmentAbolished.includes(ownerId)) host.state.zhangxiuJudgmentAbolished.push(ownerId)

    for (const slot of ABOLISHABLE_SLOTS) {
      const equipped = owner.zones.equipment[slot]
      if (equipped) {
        moveCard(host.state, equipped, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        handleEquipmentLost(host as never, ownerId, equipped)
      }
      abolishSlot(host.state, ownerId, slot)
    }

    host.state.zhangxiuXiongluan ??= {}
    host.state.zhangxiuXiongluan[ownerId] = { targetId, turnNumber: host.state.turnNumber }
    for (const category of ['basic', 'trick', 'equipment'] as const) {
      lockCardCategory(host.state, { targetId, category, sourceId: ownerId, skillId: `${XIONGLUAN}-${category}` })
    }
    host.dispatch('SkillActivated', { skillId: XIONGLUAN, skillName: '雄乱', playerId: ownerId, targetId, logText: `${owner.nickname}发动【雄乱】` }, { sourceId: ownerId, targetId })
  },

  ignoresDistanceTo(state, ownerId, targetId) {
    return turnBound(state, state.zhangxiuXiongluan?.[ownerId], targetId)
  },
  ignoresSlashUsesTo(state, ownerId, targetId) {
    return turnBound(state, state.zhangxiuXiongluan?.[ownerId], targetId)
  },
})

registerSkillRuntime({
  id: CONGJIAN,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (context.event.targetId !== ownerId || !payload.cardId) return
      if (host.state.cards[payload.cardId]?.category !== 'trick') return
      const targets = cardUseTargetsOf(host.state, payload.cardId)?.targetIds ?? []
      if (targets.length <= 1) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const others = targets.filter((id) => id !== ownerId && playerOf(host.state, id)?.alive)
      if (others.length === 0) return
      host.queueSkill({ skillId: CONGJIAN, ownerId, step: 'ask', data: { others } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { others } = prompt.data as { others: PlayerId[] }
    host.askSkill({
      skillId: CONGJIAN, ownerId, step: 'target', data: { others },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【从谏】：可以选择一名目标交给其一张牌', timeoutMs: 20_000, optional: true, candidateIds: others, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!recipientId || !playerOf(host.state, recipientId)?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: CONGJIAN, ownerId, step: 'give', data: { recipientId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【从谏】：交给一张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { recipientId } = resolution.data as { recipientId: PlayerId }
      const recipient = playerOf(host.state, recipientId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!recipient?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      const isEquipment = host.state.cards[cardId]?.category === 'equipment'
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: recipientId })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: CONGJIAN }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: recipientId, cardIds: [cardId], reason: CONGJIAN }, { targetId: recipientId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: CONGJIAN, skillName: '从谏', playerId: ownerId, targetId: recipientId, logText: `${owner.nickname}发动【从谏】` }, { sourceId: ownerId, targetId: recipientId })
      drawCards(host.state, host.rng, ownerId, isEquipment ? 2 : 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

export const ZHANGXIU: CharacterDefinition = {
  id: 'zhangxiu',
  name: '张绣',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: XIONGLUAN, name: '雄乱', description: '限定技，出牌阶段，废除自己整个判定区和全部装备栏，然后指定一名其他角色：直到本回合结束，张绣对其使用牌无距离和次数限制，其本回合不能使用或打出手牌。' },
    { id: CONGJIAN, name: '从谏', description: '张绣成为一张多目标锦囊牌的目标后，可以交给其中一名目标一张牌，然后摸1张牌（若给出的是装备牌则改为摸2张）。' },
  ],
}
