import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 辛宪英（三国杀 OL 经典身份 SP）。
 *
 * 【忠鉴】：出牌阶段限一次（若本次触发颜色和点数同时相同，本回合解锁为
 *          最多2次），辛宪英展示1张手牌，选择一名其他角色A，A展示与其
 *          当前体力值等量的手牌（不足则展示全部）；若A展示牌中有颜色
 *          相同的，辛宪英选择摸1张或弃置一名其他角色1张牌；若有点数相同
 *          的，本回合忠鉴次数上限+1；都没有，辛宪英手牌上限-1（可叠加）。
 * 【才识】：摸牌阶段开始时，辛宪英可以选择本回合手牌上限+1，或回复1点
 *          体力；选择回复的话，本回合不能对自己使用牌。
 */

const ZHONGJIAN = 'zhongjian'
const CAISHI = 'caishi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 忠鉴的"限一次/解锁2次"和"手牌上限-1"都是本回合状态，不能用永久 marks 记账，
 * 否则一旦某次点数相同解锁了额外次数，会在后续所有回合里一直算数。 */
function zhongjianState(state: SanguoshaState, ownerId: PlayerId) {
  const entry = state.xinxianyingZhongjian?.[ownerId]
  return entry?.turnNumber === state.turnNumber ? entry : { turnNumber: state.turnNumber, used: 0, extra: 0, maxCardsPenalty: 0 }
}

registerSkillRuntime({
  id: ZHONGJIAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return []
    const entry = zhongjianState(state, ownerId)
    if (entry.used >= Math.min(2, 1 + entry.extra)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: ZHONGJIAN, label: '忠鉴：展示1张手牌，选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHONGJIAN) return
    const owner = playerOf(host.state, ownerId)
    const entry = zhongjianState(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || entry.used >= Math.min(2, 1 + entry.extra)) return
    host.askSkill({
      skillId: ZHONGJIAN, ownerId, step: 'reveal',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【忠鉴】：展示1张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'reveal') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.dispatch('CardMove', { cardIds: [cardId], reason: ZHONGJIAN, revealed: true }, { sourceId: ownerId, cardIds: [cardId] })
      const entry = zhongjianState(host.state, ownerId)
      host.state.xinxianyingZhongjian ??= {}
      host.state.xinxianyingZhongjian[ownerId] = { ...entry, used: entry.used + 1 }
      host.dispatch('SkillActivated', { skillId: ZHONGJIAN, skillName: '忠鉴', playerId: ownerId, logText: `${owner.nickname}发动【忠鉴】` }, { sourceId: ownerId })
      host.askSkill({
        skillId: ZHONGJIAN, ownerId, step: 'target', data: { revealCardId: cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【忠鉴】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const { revealCardId } = resolution.data as { revealCardId: CardId }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const need = Math.min(target.hp, target.zones.hand.length)
      if (need <= 0) { finishZhongjian(host, ownerId, revealCardId, [], targetId); return }
      host.askSkill({
        skillId: ZHONGJIAN, ownerId, step: 'target-reveal', data: { revealCardId, targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: `【忠鉴】：展示${need}张手牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: need, max: need,
        }),
      })
      return
    }

    if (resolution.step === 'target-reveal') {
      const { revealCardId, targetId } = resolution.data as { revealCardId: CardId; targetId: PlayerId }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const target = playerOf(host.state, targetId)
      const valid = cardIds.filter((id) => target?.zones.hand.includes(id))
      if (!target?.alive) return
      host.dispatch('CardMove', { cardIds: valid, reason: ZHONGJIAN, revealed: true }, { sourceId: targetId, cardIds: valid })
      finishZhongjian(host, ownerId, revealCardId, valid, targetId)
      return
    }

    if (resolution.step === 'color-choose') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'draw') {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      if (optionId === 'discard-target') {
        const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (others.length === 0) return
        host.askSkill({
          skillId: ZHONGJIAN, ownerId, step: 'discard-pick-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【忠鉴】：选择一名其他角色，弃置其1张牌', timeoutMs: 20_000, optional: false, candidateIds: others, min: 1, max: 1,
          }),
        })
      }
      return
    }

    if (resolution.step === 'discard-pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: ZHONGJIAN }, { sourceId: targetId, cardIds: [cardId] })
    }
  },
})

function finishZhongjian(
  host: SkillHost,
  ownerId: PlayerId,
  revealCardId: CardId,
  targetRevealed: CardId[],
  targetId: PlayerId,
): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const myColor = host.state.cards[revealCardId]?.color
  const myRank = host.state.cards[revealCardId]?.rank
  const sameColor = targetRevealed.some((id) => host.state.cards[id]?.color === myColor)
  const sameRank = targetRevealed.some((id) => host.state.cards[id]?.rank === myRank)

  const entry = zhongjianState(host.state, ownerId)
  if (sameRank) {
    host.state.xinxianyingZhongjian ??= {}
    host.state.xinxianyingZhongjian[ownerId] = { ...entry, extra: 1 }
  }
  if (!sameColor && !sameRank) {
    const current = zhongjianState(host.state, ownerId)
    host.state.xinxianyingZhongjian ??= {}
    host.state.xinxianyingZhongjian[ownerId] = { ...current, maxCardsPenalty: current.maxCardsPenalty + 1 }
    return
  }
  if (sameColor) {
    host.askSkill({
      skillId: ZHONGJIAN, ownerId, step: 'color-choose', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【忠鉴】：颜色相同，请选择', timeoutMs: 20_000, optional: false,
        options: [{ id: 'draw', label: '摸1张牌' }, { id: 'discard-target', label: '弃置一名其他角色1张牌' }],
      }),
    })
  }
}

registerSkillRuntime({
  id: CAISHI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'draw' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: CAISHI, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: CAISHI, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【才识】：请选择', timeoutMs: 20_000, optional: true,
        options: [{ id: 'none', label: '不发动' }, { id: 'maxcards', label: '本回合手牌上限+1' }, { id: 'recover', label: '回复1点体力（本回合不能对自己使用牌）' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'maxcards') {
      host.state.xinxianyingCaishiMaxCardsTurn = host.state.turnNumber
      host.dispatch('SkillActivated', { skillId: CAISHI, skillName: '才识', playerId: ownerId, logText: `${owner.nickname}发动【才识】，本回合手牌上限+1` }, { sourceId: ownerId })
    } else if (optionId === 'recover') {
      host.state.xinxianyingCaishiNoSelfTurn = host.state.turnNumber
      host.dispatch('SkillActivated', { skillId: CAISHI, skillName: '才识', playerId: ownerId, logText: `${owner.nickname}发动【才识】，回复1点体力` }, { sourceId: ownerId })
      recover(host as never, ownerId, 1, ownerId)
    }
  },

  maxCardsBonus(state, ownerId) {
    const bonus = state.xinxianyingCaishiMaxCardsTurn === state.turnNumber ? 1 : 0
    return bonus - zhongjianState(state, ownerId).maxCardsPenalty
  },
  prohibitsSourceTarget(state, ownerId, targetId) {
    return targetId === ownerId && state.xinxianyingCaishiNoSelfTurn === state.turnNumber
  },
})

export const XINXIANYING: CharacterDefinition = {
  id: 'xinxianying',
  name: '辛宪英',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZHONGJIAN, name: '忠鉴', description: '出牌阶段限一次（若本次颜色和点数同时相同则本回合上限+1），展示1张手牌，选择一名其他角色，其展示与体力值等量的手牌；颜色相同则摸1张或弃置一名其他角色1张牌，点数相同则本回合次数上限+1，都不相同则手牌上限-1。' },
    { id: CAISHI, name: '才识', description: '摸牌阶段开始时，可以选择本回合手牌上限+1，或回复1点体力（本回合不能对自己使用牌）。' },
  ],
}
