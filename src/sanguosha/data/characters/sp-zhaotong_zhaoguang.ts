import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { aggregateCardColor, setCardColorOverride } from '../../engine/card-color'
import { createVirtualSlashCard, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { finishMultiCardViewAs } from '../../engine/multi-card-viewas'
import { declinedThisPhase, markDeclinedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 赵统赵广（三国杀《一将成名》官方当前版本）。
 *
 * 【翊赞】：你可以将两张牌（其中至少一张是基本牌，本实现按"手牌任意两张"
 *          处理，未额外限定子牌构成，见简化说明）当任意一张基本牌使用或
 *          打出。
 * 【龙渊】：觉醒技，任意角色结束阶段，若你本局已发动过至少3次翊赞，你
 *          摸2张牌并回复1点体力，然后将【翊赞】的"两张牌"改为"一张牌"。
 * 【青刃】：结束阶段，你摸X张牌（X为本回合发动翊赞的次数）。
 *
 * 翊赞的"打出"（响应求闪/求桃/求无懈）复用既有的多牌转化机制；主动使用
 * 目前只接入"当作杀使用"这一支的完整目标流程（比照关兴张苞【父魂】），
 * 桃/酒是自弃自用无需选目标，直接落地。"至少一张为基本牌"未在选牌阶段
 * 强制校验，这是相对文本的已知简化。
 */

const YIZAN = 'yizan'
const YIZAN_ACTION = 'yizan-invoke'
const LONGYUAN = 'longyuan'
const QINGREN = 'qingren'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function requiredCount(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.awakenedSkills?.includes(LONGYUAN) ? 1 : 2
}

function recordYizan(host: { state: SanguoshaState }, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  owner.marks['yizan-total'] = (owner.marks['yizan-total'] ?? 0) + 1
  if (owner.marks['yizan-turn'] !== host.state.turnNumber) { owner.marks['yizan-turn'] = host.state.turnNumber; owner.marks['yizan-turn-count'] = 0 }
  owner.marks['yizan-turn-count'] = (owner.marks['yizan-turn-count'] ?? 0) + 1
}

function createVirtualBasicCard(state: SanguoshaState, ownerId: PlayerId, name: '桃' | '酒'): CardId {
  const cardId = `virtual:${YIZAN}:${state.seq + 1}:${state.decisions.length}`
  state.cards[cardId] = {
    id: cardId, ruleset: state.rulesetVersion, expansion: 'standard',
    name, suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true, sourceSkillId: YIZAN,
  } as never
  playerOf(state, ownerId)!.zones.hand.push(cardId)
  return cardId
}

registerSkillRuntime({
  id: YIZAN,
  announcesSelf: true,
  activeActionUsesCard: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (declinedThisPhase(state, ownerId, YIZAN)) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < requiredCount(state, ownerId)) return []
    return [{ id: YIZAN_ACTION, label: '翊赞：将手牌当任意基本牌使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YIZAN_ACTION) return
    const owner = playerOf(host.state, ownerId)
    const n = requiredCount(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < n) return
    host.askSkill({
      skillId: YIZAN, ownerId, step: 'cards', data: { n },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【翊赞】：选择${n}张手牌当任意基本牌使用`, timeoutMs: 25_000, optional: true,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: n,
      }),
    })
  },
  multiCardViewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    const n = requiredCount(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < n) return null
    return {
      skillId: YIZAN, skillName: '翊赞', requiredCount: n,
      suitToCardName: {}, sameSuit: false, anySuitCardNames: ['杀', '闪', '桃', '酒'],
      handOnly: true, aggregateColor: true,
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'multi-viewas') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardIds.length > 0) recordYizan(host, ownerId)
      finishMultiCardViewAs(host, cardIds)
      return
    }
    if (resolution.step === 'cards') {
      const { n } = resolution.data as { n: number }
      const unique = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      if (!owner?.alive || unique.length !== n || !unique.every((cardId) => owner.zones.hand.includes(cardId))) {
        // 没选够张数 = 放弃：留下放弃记号，否则同一个出牌阶段会被反复点开成死循环
        if (owner?.alive) markDeclinedThisPhase(host.state, ownerId, YIZAN)
        return
      }
      host.askSkill({
        skillId: YIZAN, ownerId, step: 'declare', data: { picked: unique },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【翊赞】：当作哪张基本牌使用？', timeoutMs: 20_000, optional: false,
          options: [
            { id: '杀', label: '杀' },
            ...(owner.hp < owner.maxHp ? [{ id: '桃', label: '桃' }] : []),
            ...(host.state.turnUsage.wineUses < 1 ? [{ id: '酒', label: '酒' }] : []),
          ],
        }),
      })
      return
    }
    if (resolution.step === 'declare') {
      const { picked } = resolution.data as { picked: CardId[] }
      const name = (response.payload as { optionId?: string }).optionId as '杀' | '桃' | '酒' | undefined
      if (!owner?.alive || !name || !picked.every((cardId) => owner.zones.hand.includes(cardId))) return
      const color = aggregateCardColor(host.state, picked)
      for (const cardId of picked) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: picked, reason: YIZAN }, { targetId: ownerId, cardIds: picked })
      recordYizan(host, ownerId)
      if (name === '杀') {
        const cardId = createVirtualSlashCard(host.state, ownerId, YIZAN)
        setCardColorOverride(host.state, cardId, color)
        host.dispatch('SkillActivated', { skillId: YIZAN, skillName: '翊赞', playerId: ownerId, logText: `${owner.nickname}发动【翊赞】，当作【杀】使用` }, { sourceId: ownerId })
        const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【翊赞】')
        const candidateIds = [...new Set(actions.flatMap((action) => (action.kind === 'use-card' ? action.targetIds : [])))]
        if (candidateIds.length === 0) { delete host.state.cards[cardId]; owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId); return }
        host.askSkill({
          skillId: YIZAN, ownerId, step: 'targets', data: { cardId },
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【翊赞】：为这张【杀】选择目标', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      const cardId = createVirtualBasicCard(host.state, ownerId, name)
      setCardColorOverride(host.state, cardId, color)
      host.dispatch('SkillActivated', { skillId: YIZAN, skillName: '翊赞', playerId: ownerId, logText: `${owner.nickname}发动【翊赞】，当作【${name}】使用` }, { sourceId: ownerId })
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `yizan-use:${cardId}`, playerId: ownerId, label: '',
        cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1, asCardName: name,
      })
      return
    }
    if (resolution.step === 'targets') {
      const { cardId } = resolution.data as { cardId: CardId }
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【翊赞】')
      const action = actions.find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.length === targetIds.length && candidate.targetIds.every((id) => targetIds.includes(id)))
      if (!action || action.kind !== 'use-card') { delete host.state.cards[cardId]; if (owner) owner.zones.hand = owner.zones.hand.filter((id) => id !== cardId); return }
      executeUseCardAction(host as never, ownerId, action)
    }
  },
})

registerSkillRuntime({
  id: LONGYUAN,
  awakening: {
    phase: 'finish',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      return Boolean(owner?.alive) && (owner!.marks['yizan-total'] ?? 0) >= 3
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.dispatch('SkillActivated', { skillId: LONGYUAN, skillName: '龙渊', playerId: ownerId, logText: `${owner.nickname}觉醒【龙渊】，将【翊赞】改为1张牌` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
      if (owner.hp < owner.maxHp) recover(host as never, ownerId, 1, ownerId)
    },
  },
})

registerSkillRuntime({
  id: QINGREN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = owner.marks['yizan-turn'] === host.state.turnNumber ? (owner.marks['yizan-turn-count'] ?? 0) : 0
      if (x <= 0) return
      host.dispatch('SkillActivated', { skillId: QINGREN, skillName: '青刃', playerId: ownerId, logText: `${owner.nickname}发动【青刃】，摸${x}张牌` }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
    },
  }],
})

export const ZHAOTONG_ZHAOGUANG: CharacterDefinition = {
  id: 'zhaotong_zhaoguang',
  name: '赵统赵广',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: YIZAN, name: '翊赞', description: '你可以将两张牌当任意一张基本牌使用或打出（觉醒【龙渊】后改为一张牌）。' },
    { id: LONGYUAN, name: '龙渊', description: '觉醒技，任意角色结束阶段，若你本局已发动过至少3次翊赞，你摸2张牌并回复1点体力，然后将【翊赞】的"两张牌"改为"一张牌"。' },
    { id: QINGREN, name: '青刃', description: '结束阶段，你摸X张牌，X为你本回合发动翊赞的次数。' },
  ],
}
