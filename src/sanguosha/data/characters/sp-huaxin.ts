import { moveCard } from '../../engine/zones'
import { loseHp } from '../../engine/hp'
import { drawCards } from '../../engine/draw'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { BASIC_CARD_INFO, TRICK_CARD_INFO } from '../ruleset-v1/card-info'
import { applyForcedIdentity } from '../../engine/forced-identity'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 华歆（三国杀 OL 经典身份 SP，身份场版；不是国战【望归】版）。
 *
 * 【草诏】：出牌阶段限一次，展示1张手牌，声明一种本局未声明过的基本牌/
 *          普通锦囊牌名，然后选择一名体力值≤自己的角色A二选一：令这张
 *          实体牌视为声明牌（card-scoped 身份改写，不改 CardDefinition），
 *          然后可以将其交给一名其他角色；或A失去1点体力（声明失败）。
 * 【息兵】：每回合限一次，其他角色对华歆造成伤害后，可以选择华歆或来源
 *          弃置2张牌，然后手牌较少的一方摸2张牌；因此摸牌的角色直到本
 *          回合结束不能使用牌指定华歆为目标（双方手牌相等时不触发，沿用
 *          "较少的一方"这类比较式效果平局无事的通行口径）。
 */

const CAOZHAO = 'caozhao'
const CAOZHAO_INVOKE = 'caozhao-invoke'
const XIBING = 'xibing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function legalDeclareNames(state: SanguoshaState, ownerId: PlayerId): string[] {
  const declared = new Set(state.huaxinDeclaredNames?.[ownerId] ?? [])
  const names = new Set<string>()
  for (const info of [...BASIC_CARD_INFO, ...TRICK_CARD_INFO]) {
    if (DELAYED_TRICKS.has(info.name)) continue
    if (declared.has(info.name)) continue
    names.add(info.name)
  }
  return [...names]
}

registerSkillRuntime({
  id: CAOZHAO,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(CAOZHAO) || owner.zones.hand.length === 0) return []
    if (legalDeclareNames(state, ownerId).length === 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.hp <= owner.hp)) return []
    return [{ id: CAOZHAO_INVOKE, label: '草诏：展示1张手牌并声明一个牌名' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== CAOZHAO_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(CAOZHAO) || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: CAOZHAO, ownerId, step: 'pick-card', data: {},
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【草诏】：展示1张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      host.dispatch('CardMove', { cardIds: [cardId], reason: CAOZHAO, revealed: true }, { cardIds: [cardId] })
      const names = legalDeclareNames(host.state, ownerId)
      if (names.length === 0) return
      host.askSkill({
        skillId: CAOZHAO, ownerId, step: 'declare', data: { cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【草诏】：声明一个牌名', timeoutMs: 20_000, optional: false,
          options: names.map((name) => ({ id: name, label: name })),
        }),
      })
      return
    }

    if (resolution.step === 'declare') {
      const { cardId } = resolution.data as { cardId: CardId }
      const declaredName = (response.payload as { optionId?: string }).optionId
      if (!declaredName || !owner.zones.hand.includes(cardId)) return
      host.state.huaxinDeclaredNames ??= {}
      host.state.huaxinDeclaredNames[ownerId] = [...(host.state.huaxinDeclaredNames[ownerId] ?? []), declaredName]
      owner.turnUsedSkills.push(CAOZHAO)
      host.dispatch('SkillActivated', { skillId: CAOZHAO, skillName: '草诏', playerId: ownerId, logText: `${owner.nickname}发动【草诏】，声明【${declaredName}】` }, { sourceId: ownerId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.hp <= owner.hp).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: CAOZHAO, ownerId, step: 'pick-a', data: { cardId, declaredName },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【草诏】：选择一名体力值≤你的角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-a') {
      const { cardId, declaredName } = resolution.data as { cardId: CardId; declaredName: string }
      const [aId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const a = aId ? playerOf(host.state, aId) : undefined
      if (!a?.alive) return
      host.askSkill({
        skillId: CAOZHAO, ownerId, step: 'a-choose', data: { cardId, declaredName, aId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: aId,
          prompt: '【草诏】：请选择', timeoutMs: 20_000, optional: false,
          options: [
            { id: 'accept', label: `令这张牌视为声明的【${declaredName}】` },
            { id: 'refuse', label: '失去1点体力' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'a-choose') {
      const { cardId, declaredName, aId } = resolution.data as { cardId: CardId; declaredName: string; aId: PlayerId }
      const a = playerOf(host.state, aId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!a?.alive) return
      if (optionId !== 'accept') {
        loseHp(host as never, aId, 1, CAOZHAO)
        return
      }
      if (!owner.zones.hand.includes(cardId)) return
      applyForcedIdentity(host.state, {
        ownerId, scope: 'card', cardId, asCardName: declaredName, nature: 'normal',
        ignoreDistance: false, unlimitedUses: false, skillId: CAOZHAO, expiry: 'manual',
      })
      host.dispatch('SkillActivated', { skillId: CAOZHAO, skillName: '草诏', playerId: ownerId, targetId: aId, logText: `这张牌视为声明的【${declaredName}】` }, { sourceId: ownerId, targetId: aId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: CAOZHAO, ownerId, step: 'give', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【草诏】：可以将这张牌交给一名其他角色', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { cardId } = resolution.data as { cardId: CardId }
      const [bId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!bId || !owner.zones.hand.includes(cardId)) return
      const b = playerOf(host.state, bId)
      if (!b?.alive) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: bId })
      host.dispatch('GainCard', { playerId: bId, cardIds: [cardId], reason: CAOZHAO }, { sourceId: ownerId, targetId: bId, cardIds: [cardId] })
    }
  },
})

registerSkillRuntime({
  id: XIBING,
  prohibitsTarget(state, ownerId, sourceId) {
    const entry = state.huaxinXibingBlocked?.[sourceId]
    return !!entry && entry.turnNumber === state.turnNumber && entry.protectedId === ownerId
  },
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId || sourceId === ownerId || context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.turnUsedSkills.includes(XIBING)) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      host.queueSkill({ skillId: XIBING, ownerId, step: 'ask', data: { sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIBING) || !source?.alive) return
    host.askSkill({
      skillId: XIBING, ownerId, step: 'choose', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【息兵】：弃置谁的2张牌？', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'self', label: '弃置自己的2张牌' },
          { id: 'source', label: `弃置${source.nickname}的2张牌` },
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'choose') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'self' && optionId !== 'source') return
      const discarderId = optionId === 'self' ? ownerId : sourceId
      const discarder = playerOf(host.state, discarderId)
      if (!discarder?.alive) return
      owner.turnUsedSkills.push(XIBING)
      if (discarderId === ownerId) {
        host.askSkill({
          skillId: XIBING, ownerId, step: 'discard-self', data: { sourceId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【息兵】：弃置2张手牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: Math.min(2, owner.zones.hand.length), max: Math.min(2, owner.zones.hand.length),
          }),
        })
      } else {
        host.askSkill({
          skillId: XIBING, ownerId, step: 'discard-source', data: { sourceId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: sourceId,
            prompt: '【息兵】：弃置2张手牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...discarder.zones.hand], hiddenCardSlots: [], min: Math.min(2, discarder.zones.hand.length), max: Math.min(2, discarder.zones.hand.length),
          }),
        })
      }
      return
    }

    if (resolution.step === 'discard-self' || resolution.step === 'discard-source') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const responderId = response.playerId
      const responder = playerOf(host.state, responderId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => responder?.zones.hand.includes(id))
      if (valid.length > 0) {
        for (const id of valid) moveCard(host.state, id, { kind: 'hand', playerId: responderId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: responderId, cardIds: valid, reason: XIBING }, { sourceId: responderId, cardIds: valid })
      }
      host.dispatch('SkillActivated', { skillId: XIBING, skillName: '息兵', playerId: ownerId, logText: `${owner.nickname}发动【息兵】` }, { sourceId: ownerId })
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      if (owner.zones.hand.length === source.zones.hand.length) return
      const drawerId = owner.zones.hand.length < source.zones.hand.length ? ownerId : sourceId
      drawCards(host.state, host.rng, drawerId, 2, (name, payload) => { host.dispatch(name, payload) })
      host.state.huaxinXibingBlocked ??= {}
      host.state.huaxinXibingBlocked[drawerId] = { turnNumber: host.state.turnNumber, protectedId: ownerId }
    }
  },
})

export const HUAXIN: CharacterDefinition = {
  id: 'huaxin',
  name: '华歆',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: CAOZHAO, name: '草诏', description: '出牌阶段限一次，展示1张手牌，声明一种本局未声明过的基本牌/普通锦囊牌名，然后选择一名体力值不大于你的角色二选一：令这张牌视为声明牌（然后你可以将其交给一名其他角色）；或其失去1点体力。' },
    { id: XIBING, name: '息兵', description: '每回合限一次，其他角色对你造成伤害后，可以弃置你或其2张牌，然后手牌较少的一方摸2张牌，该角色直到本回合结束不能使用牌指定你为目标。' },
  ],
}
