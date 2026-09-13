import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭图（三国杀 OL 经典身份 SP，不是郭图逢纪）。
 *
 * 【趋势】：出牌阶段限一次，摸1张牌，然后将1张手牌暗置于一名其他角色A的
 *          武将牌上，称为"趋"；A结束阶段开始时，移去"趋"（进入弃牌堆），
 *          若A本回合使用过与"趋"类别相同的牌，郭图摸X张牌（X=A本回合所有
 *          使用牌的目标数量总和，cap 5）。
 * 【诿解】：见 engine/weijie-response.ts（本批新增的公共"弃邻居牌顶替响应"
 *          机制），其他角色的回合，每回合限一次。
 */

const QUSHI = 'qushi'
const QU_PILE = 'qu'
const WEIJIE = 'weijie'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QUSHI,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QUSHI)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: QUSHI, label: '趋势：摸1张牌，将1张手牌暗置于一名角色武将牌上' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== QUSHI) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || owner.turnUsedSkills.includes(QUSHI)) return
    owner.turnUsedSkills.push(QUSHI)
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: QUSHI, skillName: '趋势', playerId: ownerId, logText: `${owner.nickname}发动【趋势】，摸1张牌` }, { sourceId: ownerId })
    if (owner.zones.hand.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: QUSHI, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【趋势】：选择一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: QUSHI, ownerId, step: 'pick-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【趋势】：选择1张手牌暗置', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: targetId, pile: QU_PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QUSHI }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: QUSHI, skillName: '趋势', playerId: ownerId, logText: `${owner.nickname}发动【趋势】，暗置一枚"趋"于${target.nickname}` }, { sourceId: ownerId, targetId })
    }
  },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, _ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId) return
        const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[]; cancelled?: boolean }
        if (payload.cancelled || !payload.cardName) return
        const category = cardCategoryOfName(payload.cardName) ?? 'equipment'
        const turnNumber = host.state.turnNumber
        host.state.guotuTargetLedger ??= {}
        const entry = host.state.guotuTargetLedger[sourceId]
        const base = entry && entry.turnNumber === turnNumber ? entry : { turnNumber, categories: [], totalTargets: 0 }
        if (!base.categories.includes(category)) base.categories = [...base.categories, category]
        base.totalTargets += payload.targetIds?.length ?? 0
        host.state.guotuTargetLedger[sourceId] = base
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'end' || !payload.playerId) return
        const targetId = payload.playerId
        const target = playerOf(host.state, targetId)
        const owner = playerOf(host.state, ownerId)
        if (!target?.alive || !owner?.alive) return
        const pile = target.characterPiles[QU_PILE]
        if (!pile || pile.length === 0) return
        const cardId = pile[0]
        const card = host.state.cards[cardId]
        moveCard(host.state, cardId, { kind: 'characterPile', playerId: targetId, pile: QU_PILE }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: QUSHI }, { sourceId: targetId, cardIds: [cardId] })
        const category = card?.category ?? null
        const ledger = host.state.guotuTargetLedger?.[targetId]
        const used = ledger && ledger.turnNumber === host.state.turnNumber && category && ledger.categories.includes(category)
        if (!used) return
        const x = Math.min(5, ledger?.totalTargets ?? 0)
        if (x <= 0) return
        drawCards(host.state, host.rng, ownerId, x, (name, drawPayload) => { host.dispatch(name, drawPayload) })
        host.dispatch('SkillActivated', { skillId: QUSHI, skillName: '趋势', playerId: ownerId, logText: `${owner.nickname}发动【趋势】，摸${x}张牌` }, { sourceId: ownerId })
      },
    },
  ],
})

export const GUOTU: CharacterDefinition = {
  id: 'guotu',
  name: '郭图',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QUSHI, name: '趋势', description: '出牌阶段限一次，摸1张牌，将1张手牌暗置于一名其他角色的武将牌上，称为"趋"；其结束阶段开始时移去"趋"，若其本回合使用过与"趋"类别相同的牌，你摸X张牌（X为其本回合所有用牌的目标数总和，cap 5）。' },
    { id: WEIJIE, name: '诿解', description: '其他角色的回合，每回合限一次，当你需要使用/打出一张基本牌时，可以弃置一名距离1的角色1张手牌，若牌名相同，视为用它响应/使用。' },
  ],
}
