import { drawCards } from '../../engine/draw'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 顾雍（一将成名 2014）。
 *
 * 【慎行】：出牌阶段，顾雍可以弃置两张牌，摸一张牌。没有次数限制，只要还能
 *          支付就能反复发动。
 * 【秉壹】：结束阶段，顾雍可以展示所有手牌，若颜色全部相同，令 1～X 名角色
 *          各摸一张牌（X 为顾雍当前手牌数量，可以选择自己）。
 *
 * 两处最容易做错的：
 *
 * 1. **秉壹的颜色判断按有效颜色**，无色牌（武将牌变的装备）存在时判定不成立
 *    （既不算「全红」也不算「全黑」）。
 * 2. **秉壹可以选自己**：文本是「角色」，不是「其他角色」。
 */

const SHENXING = 'shenxing'
const BINGYI = 'bingyi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHENXING,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return []
    return [{ id: SHENXING, label: '慎行：弃置两张牌，摸一张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHENXING) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return
    host.askSkill({
      skillId: SHENXING, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【慎行】：弃置两张牌，摸一张牌',
        /*
         * 点开这一下就是发动，必须选够两张——可取消又什么都不改变的问答
         * 会被 AI 反复点开、反复交空，压测里直接跑成死循环。
         * 不想发动就不要点这个动作，不在这一步留退路。
         */
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 2, max: 2,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => owner?.zones.hand.includes(cardId))
    if (!owner?.alive || cardIds.length !== 2) return
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds, reason: SHENXING }, { targetId: ownerId, cardIds })
    host.dispatch('SkillActivated', {
      skillId: SHENXING, skillName: '慎行', playerId: ownerId,
      logText: `${owner.nickname}发动【慎行】，摸一张牌`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

registerSkillRuntime({
  id: BINGYI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      host.queueSkill({ skillId: BINGYI, ownerId, step: 'target', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const colors = owner.zones.hand.map((cardId) => effectiveCardColor(host.state, ownerId, cardId))
    const uniform = colors[0] != null && colors.every((color) => color === colors[0])
    if (!uniform) return
    const x = owner.zones.hand.length
    host.dispatch('SkillActivated', {
      skillId: BINGYI, skillName: '秉壹', playerId: ownerId, cardIds: [...owner.zones.hand],
      logText: `${owner.nickname}发动【秉壹】，展示手牌，颜色全部相同`,
    }, { sourceId: ownerId, cardIds: [...owner.zones.hand] })
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: BINGYI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【秉壹】：选择 1～${x} 名角色，各摸一张牌`,
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(x, candidateIds.length),
      }),
    })
  },

  resume(host, _ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
    for (const targetId of targetIds) {
      if (!playerOf(host.state, targetId)?.alive) continue
      drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
    }
  },
})

export const GUYONG: CharacterDefinition = {
  id: 'guyong',
  name: '顾雍',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: SHENXING,
      name: '慎行',
      description: '出牌阶段，顾雍可以弃置两张牌，摸一张牌。',
    },
    {
      id: BINGYI,
      name: '秉壹',
      description: '结束阶段，顾雍可以展示所有手牌，若颜色全部相同，令 1～X 名角色各摸一张牌（X 为顾雍当前手牌数量，可以选择自己）。',
    },
  ],
}
