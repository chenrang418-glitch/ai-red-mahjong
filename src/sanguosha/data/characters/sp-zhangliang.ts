import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { beginJudgmentRetention, endJudgmentRetention } from '../../engine/judgment-retention'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张梁（三国杀 OL 经典身份 SP）。
 *
 * 【集军】：当武器牌或不为装备牌的牌于你的出牌阶段内指定第一个目标后，
 *          若此牌的使用者为你且你是此牌的目标之一，你可判定；当此次
 *          判定的判定牌移至弃牌堆前，你可将其改置于武将牌上（称为"方"）。
 * 【方统】：结束阶段开始时，若你有"方"，可以弃置一张牌，然后将至少1张
 *          "方"置入弃牌堆；若弃置的这张牌与放入弃牌堆的所有"方"的点数
 *          之和恰好为36，你对一名其他角色造成3点雷电伤害。
 */

const JIJUN = 'jijun'
const FANGTONG = 'fangtong'
const PILE = 'fang'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function fangOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[PILE] ?? []
}

registerSkillRuntime({
  id: JIJUN,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
      if (context.event.sourceId !== ownerId || context.event.targetId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      const card = payload.cardId ? host.state.cards[payload.cardId] : undefined
      if (!card) return
      if (card.category === 'equipment' && card.equipmentSlot !== 'weapon') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: JIJUN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: JIJUN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【集军】：是否进行判定？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '判定' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask') {
      if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      host.dispatch('SkillActivated', { skillId: JIJUN, skillName: '集军', playerId: ownerId, logText: `${owner.nickname}发动【集军】` }, { sourceId: ownerId })
      beginJudgmentRetention(host.state, ownerId, JIJUN)
      performJudgment(host, ownerId, JIJUN, { tag: JIJUN, data: { ownerId } })
      return
    }
    if (resolution.step === 'keep') {
      const { cardId } = resolution.data as { cardId: CardId }
      if (!host.state.zones.processingArea.includes(cardId)) { host.state.judgmentRetention = null; return }
      const keep = owner?.alive && (response.payload as { optionId?: string }).optionId === 'yes'
      if (keep) {
        // 直接进"方"堆，不走 endJudgmentRetention（那个只支持送进 recipient
        // 手牌或弃牌堆两种去处，这里改成武将专属牌堆得自己接管收尾）。
        host.state.judgmentRetention = null
        moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'characterPile', playerId: ownerId, pile: PILE })
        host.dispatch('SkillActivated', { skillId: JIJUN, skillName: '集军', playerId: ownerId, logText: `${owner.nickname}获得1张"方"` }, { sourceId: ownerId })
      } else {
        endJudgmentRetention(host.state, null)
      }
    }
  },
})

registerJudgmentContinuation(JIJUN, (host, judged, data) => {
  const { ownerId } = data as { ownerId: PlayerId }
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { endJudgmentRetention(host.state, null); return }
  ;(host as unknown as SkillHost).askSkill({
    skillId: JIJUN, ownerId, step: 'keep', data: { cardId: judged.id },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【集军】：是否将判定牌置于武将牌上，称为"方"？', timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '置为"方"' }, { id: 'no', label: '正常进入弃牌堆' }],
    }),
  })
})

registerSkillRuntime({
  id: FANGTONG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || fangOf(host.state, ownerId).length === 0) return
      host.queueSkill({ skillId: FANGTONG, ownerId, step: 'ask-cost', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask-cost') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: FANGTONG, ownerId, step: 'ask-cost', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【方统】：可以弃置一张牌', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask-cost') {
      const [costId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !costId || !owner.zones.hand.includes(costId)) return
      const fang = fangOf(host.state, ownerId)
      if (fang.length === 0) return
      host.askSkill({
        skillId: FANGTONG, ownerId, step: 'pick-fang', data: { costId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【方统】：选择至少1张"方"置入弃牌堆', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: fang, hiddenCardSlots: [], min: 1, max: fang.length,
        }),
      })
      return
    }
    if (resolution.step === 'pick-fang') {
      const { costId } = resolution.data as { costId: CardId }
      const fangPicked = ((response.payload as { cardIds?: CardId[] }).cardIds ?? []).filter((id) => fangOf(host.state, ownerId).includes(id))
      if (!owner?.alive || fangPicked.length === 0 || !owner.zones.hand.includes(costId)) return
      moveCard(host.state, costId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [costId], reason: FANGTONG }, { sourceId: ownerId, cardIds: [costId] })
      for (const cardId of fangPicked) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: PILE }, { kind: 'discardPile' })
      host.dispatch('SkillActivated', { skillId: FANGTONG, skillName: '方统', playerId: ownerId, logText: `${owner.nickname}发动【方统】，置入${fangPicked.length}张"方"` }, { sourceId: ownerId })
      const sum = (host.state.cards[costId]?.rank ?? 0) + fangPicked.reduce((total, id) => total + (host.state.cards[id]?.rank ?? 0), 0)
      if (sum !== 36) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FANGTONG, ownerId, step: 'pick-victim', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【方统】：点数之和恰为36，选择一名角色造成3点雷电伤害', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-victim') {
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !victimId || !playerOf(host.state, victimId)?.alive) return
      resolveDamage(host as never, { sourceId: ownerId, targetId: victimId, amount: 3, nature: 'thunder', cardName: null })
    }
  },
})

export const ZHANGLIANG: CharacterDefinition = {
  id: 'zhangliang',
  name: '张梁',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: JIJUN, name: '集军', description: '当武器牌或不为装备牌的牌于你的出牌阶段内指定第一个目标后，若此牌的使用者为你且你是此牌的目标之一，你可判定；当此次判定的判定牌移至弃牌堆前，你可将其改置于武将牌上，称为"方"。' },
    { id: FANGTONG, name: '方统', description: '结束阶段开始时，若你有"方"，可以弃置一张牌，然后将至少1张"方"置入弃牌堆；若弃置的这张牌与放入弃牌堆的所有"方"的点数之和恰好为36，你对一名其他角色造成3点雷电伤害。' },
  ],
}
