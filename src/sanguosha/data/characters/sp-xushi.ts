import { moveCard } from '../../engine/zones'
import { beginSlashFromDrawPile } from '../../engine/cards/basic'
import { effectiveGenderOf } from '../../engine/huashen'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { GameEventName } from '../../engine/events'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 徐氏（三国杀 OL 经典身份 SP）。
 *
 * 【问卦】：每名角色的出牌阶段限一次，可以将自己一张牌交给徐氏；徐氏可以
 *          将这张刚获得的牌置于牌堆顶或牌堆底，若如此做，双方各从
 *          【另一端】摸1张牌。
 * 【伏诛】：每名男性角色结束阶段开始时，若牌堆剩余牌数不大于徐氏当前
 *          体力值×10，徐氏可以依次使用牌堆中的【杀】（真实 Card ID，最多
 *          当前游戏人数张）对其造成伤害；全部结束后重新洗牌牌堆。
 */

const WENGUA = 'wengua'
const FUZHU = 'fuzhu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: WENGUA,
  grantsPlayActions(state, ownerId, actorId) {
    if (actorId === ownerId) return []
    const owner = playerOf(state, ownerId)
    const actor = playerOf(state, actorId)
    if (!owner?.alive || !actor?.alive || actor.zones.hand.length === 0 || actor.turnUsedSkills.includes(WENGUA)) return []
    return [{ id: WENGUA, label: '问卦：交给徐氏一张牌' }]
  },

  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== WENGUA) return
    const actor = playerOf(host.state, actorId)
    if (!actor?.alive || actor.turnUsedSkills.includes(WENGUA)) return
    actor.turnUsedSkills.push(WENGUA)
    host.askSkill({
      skillId: WENGUA, ownerId, step: 'give', data: { actorId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: actorId,
        prompt: '【问卦】：交给徐氏一张牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...actor.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'give') {
      const { actorId } = resolution.data as { actorId: PlayerId }
      const actor = playerOf(host.state, actorId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!actor?.alive || !cardId || !actor.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: actorId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: actorId, cardIds: [cardId], reason: WENGUA }, { sourceId: actorId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WENGUA }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: WENGUA, skillName: '问卦', playerId: ownerId, targetId: actorId, logText: `${owner.nickname}发动【问卦】` }, { sourceId: ownerId, targetId: actorId })
      host.askSkill({
        skillId: WENGUA, ownerId, step: 'place', data: { actorId, cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【问卦】：可以将这张牌置于牌堆顶或牌堆底', timeoutMs: 20_000, optional: true,
          options: [{ id: 'top', label: '置于牌堆顶（双方各从牌堆底摸1张）' }, { id: 'bottom', label: '置于牌堆底（双方各从牌堆顶摸1张）' }, { id: 'none', label: '不发动' }],
        }),
      })
      return
    }

    if (resolution.step === 'place') {
      const { actorId, cardId } = resolution.data as { actorId: PlayerId; cardId: CardId }
      const optionId = (response.payload as { optionId?: string }).optionId
      const actor = playerOf(host.state, actorId)
      if (!optionId || optionId === 'none' || !owner.zones.hand.includes(cardId) || !actor?.alive) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: optionId === 'top' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: WENGUA }, { sourceId: ownerId, cardIds: [cardId] })
      const drawFromBottom = optionId === 'top'
      for (const playerId of [ownerId, actorId]) {
        if (!playerOf(host.state, playerId)?.alive) continue
        drawOneEnd(host.state, playerId, drawFromBottom, (name, payload) => { host.dispatch(name, payload) })
      }
    }
  },
})

function drawOneEnd(state: SanguoshaState, playerId: PlayerId, fromBottom: boolean, emit: (name: GameEventName, payload: Record<string, unknown>) => void): void {
  const pile = state.zones.drawPile
  if (pile.length === 0) return
  const cardId = fromBottom ? pile[pile.length - 1] : pile[0]
  moveCard(state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId })
  emit('GainCard', { playerId, cardIds: [cardId], reason: 'draw' })
}

registerSkillRuntime({
  id: FUZHU,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        const targetId = payload.playerId
        if (payload.phase !== 'finish' || !targetId || targetId === ownerId) return
        const owner = playerOf(host.state, ownerId)
        const target = playerOf(host.state, targetId)
        if (!owner?.alive || !target?.alive || effectiveGenderOf(host.state, targetId) !== 'male') return
        if (host.state.zones.drawPile.length > owner.hp * 10) return
        host.queueSkill({ skillId: FUZHU, ownerId, step: 'ask', data: { targetId } })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const pending = host.state.fuzhuPending
        if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardName?: string }
        if (payload.cardName !== '杀') return
        continueFuzhu(host, ownerId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const { targetId } = prompt.data as { targetId: PlayerId }
    if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
    host.askSkill({
      skillId: FUZHU, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【伏诛】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const { targetId } = resolution.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', { skillId: FUZHU, skillName: '伏诛', playerId: ownerId, targetId, logText: `${owner.nickname}发动【伏诛】` }, { sourceId: ownerId, targetId })
    host.state.fuzhuPending = { ownerId, targetId, remaining: host.state.players.length }
    continueFuzhu(host, ownerId)
  },
})

function continueFuzhu(host: SkillHost, ownerId: PlayerId): void {
  const pending = host.state.fuzhuPending
  if (!pending || pending.ownerId !== ownerId) return
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, pending.targetId)
  if (!owner?.alive || !target?.alive || pending.remaining <= 0) {
    delete host.state.fuzhuPending
    host.rng.shuffle(host.state.zones.drawPile).forEach((cardId, index) => { host.state.zones.drawPile[index] = cardId })
    return
  }
  const cardId = host.state.zones.drawPile.find((candidate) => host.state.cards[candidate]?.name === '杀')
  if (!cardId) {
    delete host.state.fuzhuPending
    host.rng.shuffle(host.state.zones.drawPile).forEach((candidateId, index) => { host.state.zones.drawPile[index] = candidateId })
    return
  }
  host.state.fuzhuPending = { ...pending, remaining: pending.remaining - 1 }
  const began = beginSlashFromDrawPile(host as never, ownerId, pending.targetId, cardId)
  if (!began) {
    delete host.state.fuzhuPending
    host.rng.shuffle(host.state.zones.drawPile).forEach((candidateId, index) => { host.state.zones.drawPile[index] = candidateId })
  }
}

export const XUSHI: CharacterDefinition = {
  id: 'xushi',
  name: '徐氏',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: WENGUA, name: '问卦', description: '每名角色的出牌阶段限一次，可以将自己一张牌交给徐氏；徐氏可以将这张牌置于牌堆顶或牌堆底，双方各从另一端摸1张牌。' },
    { id: FUZHU, name: '伏诛', description: '每名男性角色结束阶段开始时，若牌堆剩余牌数不大于徐氏当前体力值×10，徐氏可以依次使用牌堆中的【杀】对其造成伤害，最多使用当前游戏人数张，结束后重新洗牌。' },
  ],
}
