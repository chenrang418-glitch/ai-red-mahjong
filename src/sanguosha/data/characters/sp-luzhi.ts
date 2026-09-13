import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { canTarget } from '../../engine/distance'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 卢植（三国杀 OL 经典身份 SP）。
 *
 * 【明任】：游戏开始时摸2张牌，然后将1张手牌置于武将牌上，称为"任"（至多
 *          1张）；结束阶段可以用1张手牌原子替换当前的"任"。
 * 【贞良】：转换技。阳：出牌阶段限一次，弃置1张与"任"颜色相同的牌，对
 *          攻击范围内一名角色造成1点伤害；阴：在自己回合外使用/打出一张
 *          牌后，若这张实体牌最终进入弃牌堆且颜色与"任"相同，可以令一名
 *          角色摸1张牌。每次成功发动对应一侧后阴阳切换。
 */

const MINGREN = 'mingren'
const ZHENLIANG = 'zhenliang'
const REN_PILE = 'ren'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function renOf(state: SanguoshaState, playerId: PlayerId): CardId | undefined {
  return playerOf(state, playerId)?.characterPiles[REN_PILE]?.[0]
}

function checkZhenliangYin(host: SkillHost, ownerId: PlayerId, cardId: CardId | undefined, cancelled: boolean | undefined): void {
  if (!cardId || cancelled) return
  if (conversionStateOf(host.state, ownerId, ZHENLIANG) !== 'yin') return
  if (!host.state.zones.discardPile.includes(cardId)) return
  const renId = renOf(host.state, ownerId)
  const renColor = renId ? host.state.cards[renId]?.color : undefined
  const cardColor = host.state.cards[cardId]?.color
  if (!renColor || !cardColor || renColor !== cardColor) return
  host.queueSkill({ skillId: ZHENLIANG, ownerId, step: 'yin-ask', data: {} })
}

registerSkillRuntime({
  id: MINGREN,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', { skillId: MINGREN, skillName: '明任', playerId: ownerId, logText: `${owner.nickname}发动【明任】，摸2张牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
    if (owner.zones.hand.length === 0) return
    host.queueSkill({ skillId: MINGREN, ownerId, step: 'pick-ren', data: {} })
  },
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'end') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      host.queueSkill({ skillId: MINGREN, ownerId, step: 'swap-ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    if (prompt.step === 'pick-ren') {
      host.askSkill({
        skillId: MINGREN, ownerId, step: 'set-ren', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【明任】：选择1张手牌置于武将牌上，称为"任"', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'swap-ask') {
      host.askSkill({
        skillId: MINGREN, ownerId, step: 'swap-pick', data: {},
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【明任】：可以用1张手牌替换"任"', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'set-ren') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE })
      return
    }
    if (resolution.step === 'swap-pick') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      const oldRen = renOf(host.state, ownerId)
      if (oldRen) moveCard(host.state, oldRen, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE }, { kind: 'hand', playerId: ownerId })
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: REN_PILE })
      host.dispatch('SkillActivated', { skillId: MINGREN, skillName: '明任', playerId: ownerId, logText: `${owner.nickname}发动【明任】，替换了"任"` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: ZHENLIANG,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHENLIANG) || conversionStateOf(state, ownerId, ZHENLIANG) !== 'yang') return []
    const renId = renOf(state, ownerId)
    const renColor = renId ? state.cards[renId]?.color : undefined
    if (!renColor || !owner.zones.hand.some((id) => state.cards[id]?.color === renColor)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(state, ownerId, candidate.id))) return []
    return [{ id: 'zhenliang-yang', label: '贞良：弃1张与"任"颜色相同的牌，对攻击范围内一名角色造成1点伤害' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'zhenliang-yang') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHENLIANG)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHENLIANG, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【贞良】：选择攻击范围内一名角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId === ownerId) return
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean }
        checkZhenliangYin(host, ownerId, payload.cardId, payload.cancelled)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || host.state.currentPlayerId === ownerId) return
        const payload = context.event.payload as { cardId?: CardId }
        checkZhenliangYin(host, ownerId, payload.cardId, false)
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'yin-ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: ZHENLIANG, ownerId, step: 'yin-confirm', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【贞良】：是否发动，令一名角色摸1张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId) return
      const renId = renOf(host.state, ownerId)
      const renColor = renId ? host.state.cards[renId]?.color : undefined
      const discardCandidates = owner.zones.hand.filter((id) => host.state.cards[id]?.color === renColor)
      if (discardCandidates.length === 0) return
      host.askSkill({
        skillId: ZHENLIANG, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【贞良】：弃置1张与"任"颜色相同的牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: discardCandidates, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      owner.turnUsedSkills.push(ZHENLIANG)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: ZHENLIANG }, { sourceId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: ZHENLIANG, skillName: '贞良', playerId: ownerId, targetId, logText: `${owner.nickname}发动【贞良】（阳）` }, { sourceId: ownerId, targetId })
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
      toggleConversionState(host.state, ownerId, ZHENLIANG)
      return
    }

    if (resolution.step === 'yin-confirm') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZHENLIANG, ownerId, step: 'yin-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【贞良】：选择一名角色摸牌', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'yin-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId) return
      host.dispatch('SkillActivated', { skillId: ZHENLIANG, skillName: '贞良', playerId: ownerId, targetId, logText: `${owner.nickname}发动【贞良】（阴）` }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
      toggleConversionState(host.state, ownerId, ZHENLIANG)
    }
  },
})

export const LUZHI: CharacterDefinition = {
  id: 'luzhi',
  name: '卢植',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: MINGREN, name: '明任', description: '游戏开始时摸2张牌，然后将1张手牌置于武将牌上，称为"任"；结束阶段可以用1张手牌替换当前的"任"。' },
    { id: ZHENLIANG, name: '贞良', description: '转换技。阳：出牌阶段限一次，弃置1张与"任"颜色相同的牌，对攻击范围内一名角色造成1点伤害；阴：自己回合外使用/打出一张牌后，若这张牌最终进入弃牌堆且颜色与"任"相同，可以令一名角色摸1张牌。' },
  ],
}
