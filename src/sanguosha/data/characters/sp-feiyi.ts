import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { cardUseTargetsOf } from '../../engine/card-use-targets'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 费祎（三国杀 OL 经典身份 SP）。
 *
 * 【晏如】：出牌阶段，奇数分支（手牌数为奇数时：摸3，然后弃置至少当前
 *          手牌数一半）和偶数分支（手牌数为正偶数时：弃置至少当前手牌数
 *          一半，然后摸3）各限一次，互不影响。
 * 【和衷】：费祎手牌数变为1之后，可以展示这张牌、摸1张牌，然后选择本回合
 *          尚未使用过的“大于”或“小于”方向之一，记下展示牌点数 N；本回合
 *          下一张符合条件的非延时普通锦囊牌额外结算1次（用同名虚拟锦囊
 *          对同一批目标再走一次效果，不是复制卡牌、也不重新计一次“使用”）。
 */

const YANRU_ODD = 'yanru-odd'
const YANRU_EVEN = 'yanru-even'
const HEZHONG = 'hezhong'
const HEZHONG_ARMED_MARK = 'hezhong-armed'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: YANRU_ODD,
  announcesSelf: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length % 2 === 0 || usedThisPhase(state, ownerId, YANRU_ODD)) return []
    return [{ id: YANRU_ODD, label: '晏如（奇）：摸3张牌，然后弃置至少一半' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YANRU_ODD) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length % 2 === 0 || usedThisPhase(host.state, ownerId, YANRU_ODD)) return
    markUsedThisPhase(host.state, ownerId, YANRU_ODD)
    drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: YANRU_ODD, skillName: '晏如', playerId: ownerId, logText: `${owner.nickname}发动【晏如】（奇），摸牌` }, { sourceId: ownerId })
    const min = Math.ceil(owner.zones.hand.length / 2)
    host.askSkill({
      skillId: YANRU_ODD, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【晏如】：弃置至少${min}张手牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || valid.length === 0) return
    for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YANRU_ODD }, { sourceId: ownerId, cardIds: valid })
  },
})

registerSkillRuntime({
  id: YANRU_EVEN,
  announcesSelf: true,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.zones.hand.length % 2 !== 0 || usedThisPhase(state, ownerId, YANRU_EVEN)) return []
    return [{ id: YANRU_EVEN, label: '晏如（偶）：弃置至少一半手牌，然后摸3张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YANRU_EVEN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.zones.hand.length % 2 !== 0 || usedThisPhase(host.state, ownerId, YANRU_EVEN)) return
    markUsedThisPhase(host.state, ownerId, YANRU_EVEN)
    host.dispatch('SkillActivated', { skillId: YANRU_EVEN, skillName: '晏如', playerId: ownerId, logText: `${owner.nickname}发动【晏如】（偶）` }, { sourceId: ownerId })
    const min = owner.zones.hand.length / 2
    host.askSkill({
      skillId: YANRU_EVEN, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【晏如】：弃置至少${min}张手牌`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min, max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const valid = cardIds.filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || valid.length === 0) return
    for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: YANRU_EVEN }, { sourceId: ownerId, cardIds: valid })
    drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: HEZHONG,
  triggers: [
    {
      event: 'GainCard',
      handle(host, ownerId, context) { checkHezhongArm(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) { checkHezhongArm(host, ownerId, (context.event.payload as { playerId?: PlayerId }).playerId) },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        checkHezhongArm(host, ownerId, context.event.sourceId ?? undefined)
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
        if (context.event.sourceId !== ownerId || payload.cancelled || !payload.cardId) return
        const cardId = payload.cardId
        const card = host.state.cards[cardId]
        if (!card || card.category !== 'trick' || DELAYED_TRICKS.has(card.name)) return
        const markers = host.state.hezhongMarkers?.[ownerId] ?? []
        if (markers.length === 0 || host.state.cardResolution) return
        const rank = card.rank
        // 每次只消费一个匹配的标记：这张牌用同名虚拟锦囊再结算一次之后会自己
        // 派发一次新的 AfterCardUse，剩下的标记（大于/小于都命中时）到那时
        // 再检查一遍——绝不能在同一个事件里连续 `executeUseCardAction` 两次，
        // 上一次的 cardResolution（比如过河拆桥还在等选牌）会被硬生生打断。
        const matchedIndex = markers.findIndex((marker) => (marker.kind === 'gt' ? rank > marker.value : rank < marker.value))
        if (matchedIndex < 0) return
        host.state.hezhongMarkers![ownerId] = markers.filter((_, index) => index !== matchedIndex)
        const targets = cardUseTargetsOf(host.state, cardId)?.targetIds ?? []
        const virtualId = createVirtualTrick(host.state, ownerId, card.name, HEZHONG)
        host.dispatch('SkillActivated', { skillId: HEZHONG, skillName: '和衷', playerId: ownerId, logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【和衷】，额外结算【${card.name}】` }, { sourceId: ownerId })
        executeUseCardAction(host as never, ownerId, {
          kind: 'use-card', id: `hezhong-extra:${virtualId}`, playerId: ownerId,
          cardIds: [virtualId], targetIds: [...targets], targetMin: targets.length, targetMax: targets.length,
          asCardName: card.name, label: `【和衷】额外结算【${card.name}】`,
        })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length !== 1) return
    const options: Array<{ id: string; label: string }> = []
    if (!owner.turnUsedSkills.includes(`${HEZHONG}-gt`)) options.push({ id: 'gt', label: '大于' })
    if (!owner.turnUsedSkills.includes(`${HEZHONG}-lt`)) options.push({ id: 'lt', label: '小于' })
    if (options.length === 0) return
    host.askSkill({
      skillId: HEZHONG, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【和衷】：是否发动？选择方向', timeoutMs: 20_000, optional: true,
        options: [...options, { id: 'none', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId !== 'gt' && optionId !== 'lt') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length !== 1) return
    const [cardId] = owner.zones.hand
    const rank = host.state.cards[cardId]?.rank ?? 0
    owner.turnUsedSkills.push(`${HEZHONG}-${optionId}`)
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.state.hezhongMarkers ??= {}
    host.state.hezhongMarkers[ownerId] ??= []
    host.state.hezhongMarkers[ownerId].push({ kind: optionId, value: rank })
    host.dispatch('SkillActivated', { skillId: HEZHONG, skillName: '和衷', playerId: ownerId, logText: `${owner.nickname}发动【和衷】，展示【${host.state.cards[cardId]?.name ?? ''}】` }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

function checkHezhongArm(host: SkillHost, ownerId: PlayerId, _touchedId: PlayerId | undefined): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (owner.zones.hand.length !== 1) { delete owner.marks[HEZHONG_ARMED_MARK]; return }
  if (owner.marks[HEZHONG_ARMED_MARK]) return
  owner.marks[HEZHONG_ARMED_MARK] = 1
  host.queueSkill({ skillId: HEZHONG, ownerId, step: 'ask', data: {} })
}

export const FEIYI: CharacterDefinition = {
  id: 'feiyi',
  name: '费祎',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YANRU_ODD, name: '晏如', description: '出牌阶段，若手牌数为奇数，可以摸3张牌，然后弃置至少当前手牌数一半（每阶段限一次）。' },
    { id: YANRU_EVEN, name: '晏如', description: '出牌阶段，若手牌数为正偶数，可以弃置至少当前手牌数一半，然后摸3张牌（每阶段限一次）。' },
    { id: HEZHONG, name: '和衷', description: '手牌数变为1之后，可以展示这张牌、摸1张牌，然后选择本回合尚未用过的“大于/小于”方向，本回合下一张符合条件的非延时普通锦囊牌额外结算1次。' },
  ],
}
