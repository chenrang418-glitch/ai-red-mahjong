import { drawCards } from '../../engine/draw'
import { loseHp } from '../../engine/hp'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张宝（三国杀 OL 经典身份 SP）。
 *
 * 【咒缚】：出牌阶段限一次，将1张手牌置于一名没有"咒"的其他角色的武将牌
 *          上，称为"咒"（每名角色至多1枚）；该角色进行判定时直接以"咒"
 *          作为判定牌（复用判定引擎新增的 `forcedJudgmentCard` 强制判定牌
 *          接口）；每个 TurnInstance 结束时，本回合内失去过"咒"的角色各
 *          失去1点体力（不是伤害，每人每回合最多因此扣1点）。
 * 【影兵】：锁定技，拥有"咒"的角色使用一张与其"咒"颜色相同的牌后，张宝
 *          摸1张牌；针对同一枚"咒"第二次因此摸牌后，张宝获得这枚"咒"。
 */

const ZHOUFU = 'zhoufu'
const ZHOUFU_INVOKE = 'zhoufu-invoke'
const YINGBING = 'yingbing'
const CURSE_PILE = 'zhou'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function curseOf(state: SanguoshaState, playerId: PlayerId): CardId | undefined {
  return playerOf(state, playerId)?.characterPiles[CURSE_PILE]?.[0]
}

function markLostCurse(state: SanguoshaState, playerId: PlayerId): void {
  const entry = state.zhangbaoLostCurseTurn
  const ids = new Set(entry?.turnNumber === state.turnNumber ? entry.playerIds : [])
  ids.add(playerId)
  state.zhangbaoLostCurseTurn = { turnNumber: state.turnNumber, playerIds: [...ids] }
}

registerSkillRuntime({
  id: ZHOUFU,
  forcedJudgmentCard(host, _ownerId, judgingPlayerId) {
    const cardId = curseOf(host.state, judgingPlayerId)
    if (!cardId) return null
    moveCard(host.state, cardId, { kind: 'characterPile', playerId: judgingPlayerId, pile: CURSE_PILE }, { kind: 'processingArea' })
    markLostCurse(host.state, judgingPlayerId)
    return cardId
  },
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHOUFU) || owner.zones.hand.length === 0) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId && !curseOf(state, candidate.id))) return []
    return [{ id: ZHOUFU_INVOKE, label: '咒缚：将1张手牌置于一名其他角色的武将牌上，称为"咒"' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHOUFU_INVOKE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(ZHOUFU) || owner.zones.hand.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !curseOf(host.state, candidate.id)).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHOUFU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【咒缚】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || curseOf(host.state, targetId)) return
      host.askSkill({
        skillId: ZHOUFU, ownerId, step: 'pick-card', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【咒缚】：选择1张手牌置于对方武将牌上', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick-card') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive || curseOf(host.state, targetId)) return
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      owner.turnUsedSkills.push(ZHOUFU)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: targetId, pile: CURSE_PILE })
      host.dispatch('SkillActivated', { skillId: ZHOUFU, skillName: '咒缚', playerId: ownerId, targetId, logText: `${owner.nickname}发动【咒缚】，${target.nickname}获得一枚"咒"` }, { sourceId: ownerId, targetId })
    }
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host) {
      const entry = host.state.zhangbaoLostCurseTurn
      if (!entry || entry.turnNumber !== host.state.turnNumber) return
      for (const playerId of entry.playerIds) {
        if (playerOf(host.state, playerId)?.alive) loseHp(host as never, playerId, 1, ZHOUFU)
      }
      host.state.zhangbaoLostCurseTurn = undefined
    },
  }],
})

registerSkillRuntime({
  id: YINGBING,
  triggers: [{
    event: 'CardUsed',
    handle(host, ownerId, context) {
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const curseId = curseOf(host.state, sourceId)
      if (!curseId) return
      const payload = context.event.payload as { cardId?: CardId }
      const usedCardId = payload.cardId
      const usedColor = usedCardId ? host.state.cards[usedCardId]?.color : undefined
      const curseColor = host.state.cards[curseId]?.color
      if (!usedColor || !curseColor || usedColor !== curseColor) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      host.dispatch('SkillActivated', { skillId: YINGBING, skillName: '影兵', playerId: ownerId, logText: `${owner.nickname}发动【影兵】，摸1张牌` }, { sourceId: ownerId })
      const count = (host.state.zhangbaoYingbingCount?.[curseId] ?? 0) + 1
      host.state.zhangbaoYingbingCount = { ...host.state.zhangbaoYingbingCount, [curseId]: count }
      if (count < 2) return
      const target = playerOf(host.state, sourceId)
      if (!target?.characterPiles[CURSE_PILE]?.includes(curseId)) return
      moveCard(host.state, curseId, { kind: 'characterPile', playerId: sourceId, pile: CURSE_PILE }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [curseId], reason: YINGBING }, { sourceId: ownerId, targetId: sourceId, cardIds: [curseId] })
      markLostCurse(host.state, sourceId)
      host.dispatch('SkillActivated', { skillId: YINGBING, skillName: '影兵', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}获得了这枚"咒"` }, { sourceId: ownerId, targetId: sourceId })
    },
  }],
})

export const ZHANGBAO: CharacterDefinition = {
  id: 'zhangbao',
  name: '张宝',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZHOUFU, name: '咒缚', description: '出牌阶段限一次，将1张手牌置于一名没有"咒"的其他角色的武将牌上，称为"咒"；该角色进行判定时直接以"咒"作为判定牌；每个 TurnInstance 结束时，本回合内失去过"咒"的角色各失去1点体力。' },
    { id: YINGBING, name: '影兵', description: '锁定技，拥有"咒"的角色使用一张与其"咒"颜色相同的牌后，你摸1张牌；针对同一枚"咒"第二次因此摸牌后，你获得这枚"咒"。' },
  ],
}
