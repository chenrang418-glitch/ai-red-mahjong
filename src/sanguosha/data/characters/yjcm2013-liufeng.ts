import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { canUseSlashAtTargets } from '../../engine/slash-rules'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘封（一将成名 2013）。
 *
 * 【陷嗣】：准备阶段开始时，你可以选择一至两名有牌的角色（可以是你自己），
 *          从其中每人处各取一张牌，置于你的武将牌上，称为「逆」。
 *          每当一名角色需要或可以对你使用【杀】时，若你有至少两张「逆」，
 *          该角色可以将两张「逆」置入弃牌堆，视为对你使用一张【杀】
 *          （有距离限制，计入其出牌阶段使用次数）。
 *
 * 三处最容易做错的：
 *
 * 1. **「逆」是真实的 `characterPile`**，从目标区域真移过来，
 *    暗置的手牌通过占位槽挑选，不能让刘封先看见牌面再决定拿哪张。
 * 2. **两张逆换来的这张【杀】要计入使用次数、也要讲距离**——不能直接用
 *    `beginVirtualSlash` 的默认行为（那个不吃距离和次数），距离在「要不要
 *    报出这条动作」的那一步先查，次数则显式传 `countUsage: true`。
 * 3. **两张逆真实弃入弃牌堆**，不是被刘封拿走，也不是被销毁。
 */

const XIANSI = 'xiansi'
const NI_PILE = 'ni'
const XIANSI_SLASH_ACTION = 'xiansi-slash'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function niOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[NI_PILE] ?? []
}

function hasNiCandidates(state: SanguoshaState): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive && hasPickableCards(state, candidate.id)).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: XIANSI,
  announcesSelf: true,

  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const candidateIds = hasNiCandidates(host.state)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: XIANSI, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【陷嗣】：选择一至两名有牌的角色（可以是你自己），各取其一张牌作为「逆」',
          timeoutMs: 25_000, optional: true,
          candidateIds, min: 1, max: 2,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'target') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((targetId) => hasPickableCards(host.state, targetId))
      if (targetIds.length === 0 || !owner?.alive) return
      askPickFrom(host, ownerId, targetIds, 0)
      return
    }

    if (resolution.step === 'pick') {
      const targetIds = resolution.data.targetIds as PlayerId[]
      const index = resolution.data.index as number
      const targetId = targetIds[index]
      const picked = (response.payload as { cardIds?: string[] }).cardIds?.[0]
      if (owner?.alive && picked) {
        const cardId = resolvePickedCard(host.state, targetId, picked)
        if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'characterPile', playerId: ownerId, pile: NI_PILE })) {
          host.dispatch('SkillActivated', {
            skillId: XIANSI, skillName: '陷嗣', playerId: ownerId, targetId,
            logText: `${owner.nickname}发动【陷嗣】，获得一张「逆」（共 ${niOf(host.state, ownerId).length} 张）`,
          }, { sourceId: ownerId, targetId })
        }
      }
      askPickFrom(host, ownerId, targetIds, index + 1)
    }
  },

  /** 主公技授权同款入口：把「用两张逆换一杀」这条动作借给正想对刘封出杀的人。 */
  grantsPlayActions(state, ownerId, actorId) {
    if (actorId === ownerId) return []
    if (niOf(state, ownerId).length < 2) return []
    if (!canTarget(state, actorId, ownerId)) return []
    if (!canUseSlashAtTargets(state, actorId, false, [ownerId])) return []
    return [{ id: XIANSI_SLASH_ACTION, label: '发动【陷嗣】：弃置两张「逆」，视为对刘封使用一张【杀】' }]
  },

  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== XIANSI_SLASH_ACTION) return
    const ni = niOf(host.state, ownerId)
    if (ni.length < 2) return
    if (!canTarget(host.state, actorId, ownerId) || !canUseSlashAtTargets(host.state, actorId, false, [ownerId])) return
    const [first, second] = ni
    for (const cardId of [first, second]) {
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: NI_PILE }, { kind: 'discardPile' })
    }
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [first, second], reason: XIANSI }, { targetId: ownerId, cardIds: [first, second] })
    host.dispatch('SkillActivated', {
      skillId: XIANSI, skillName: '陷嗣', playerId: actorId, targetId: ownerId,
      logText: `${playerOf(host.state, actorId)?.nickname ?? ''}弃置两张「逆」，视为对刘封使用一张【杀】`,
    }, { sourceId: actorId, targetId: ownerId })
    host.beginVirtualSlash({ sourceId: actorId, targetId: ownerId, sourceSkillId: XIANSI, countUsage: true })
  },
})

function askPickFrom(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  if (index >= targetIds.length) return
  const targetId = targetIds[index]
  const pickable = pickableCardsOf(host.state, targetId)
  if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) {
    askPickFrom(host, ownerId, targetIds, index + 1)
    return
  }
  host.askSkill({
    skillId: XIANSI, ownerId, step: 'pick', data: { targetIds, index },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【陷嗣】：从 ${playerOf(host.state, targetId)?.nickname ?? ''} 处取一张牌作为「逆」`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
      min: 1, max: 1,
    }),
  })
}

export const LIUFENG: CharacterDefinition = {
  id: 'liufeng',
  name: '刘封',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2013',
  skills: [
    {
      id: XIANSI,
      name: '陷嗣',
      description: '准备阶段开始时，你可以选择一至两名有牌的角色（可以是你自己），从其中每人处各取一张牌，置于你的武将牌上，称为「逆」。每当一名角色需要或可以对你使用【杀】时，若你有至少两张「逆」，该角色可以将两张「逆」置入弃牌堆，视为对你使用一张【杀】。',
    },
  ],
}
