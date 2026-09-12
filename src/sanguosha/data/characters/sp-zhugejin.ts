import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 诸葛瑾（三国杀 OL 经典身份 SP）。
 *
 * 【缓释】：一名角色的判定牌生效前，诸葛瑾可以打出（贡献）一张手牌代替
 *          判定牌——具体用哪张由**被判定的角色**从诸葛瑾手牌里选。
 *          直接复用改判核心（`judgment.ts` 的 `retrial`），新增
 *          `retrialDecidedBy` 钩子把「问谁」和「牌是谁的」拆开，
 *          其余存在的改判技能（响应者=出牌人）行为完全不变。
 * 【弘援】：每个阶段实例限一次，诸葛瑾一次性获得至少2张牌后，可以给至多
 *          2名其他角色各1张手牌。
 * 【明哲】：锁定技，诸葛瑾在自己的出牌阶段之外失去红色手牌后，展示，摸1张。
 */

const HUANSHI = 'huanshi'
const HONGYUAN = 'hongyuan'
const MINGZHE = 'mingzhe'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUANSHI,
  retrial(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive ? [...owner.zones.hand] : []
  },
  retrialDecidedBy(_state, _ownerId, judgingPlayerId) {
    return judgingPlayerId
  },
  triggers: [{
    // 改判真正换牌时引擎派发 CardResponded（reason 改判，playerId 是出牌人诸葛瑾）
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
      if (payload.reason !== '改判' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      host.dispatch('SkillActivated', { skillId: HUANSHI, skillName: '缓释', playerId: ownerId, logText: `${owner.nickname}发动【缓释】` }, { sourceId: ownerId })
    },
  }],
})

function giveEach(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  if (index >= targetIds.length) return
  const owner = playerOf(host.state, ownerId)
  const targetId = targetIds[index]
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || owner.zones.hand.length === 0 || !target?.alive) { giveEach(host, ownerId, targetIds, index + 1); return }
  host.askSkill({
    skillId: HONGYUAN, ownerId, step: 'give', data: { targetIds, index },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【弘援】：交给${target.nickname}一张手牌`, timeoutMs: 20_000, optional: false,
      purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: HONGYUAN,
  triggers: [{
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId || (payload.cardIds?.length ?? 0) < 2) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0 || usedThisPhase(host.state, ownerId, HONGYUAN)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: HONGYUAN, ownerId, step: 'targets', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'targets') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0 || usedThisPhase(host.state, ownerId, HONGYUAN)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: HONGYUAN, ownerId, step: 'targets', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【弘援】：选择至多2名其他角色，各交给一张手牌', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: Math.min(2, candidateIds.length),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'targets') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
      if (targetIds.length === 0 || usedThisPhase(host.state, ownerId, HONGYUAN)) return
      markUsedThisPhase(host.state, ownerId, HONGYUAN)
      host.dispatch('SkillActivated', { skillId: HONGYUAN, skillName: '弘援', playerId: ownerId, logText: `${owner.nickname}发动【弘援】` }, { sourceId: ownerId })
      giveEach(host, ownerId, targetIds, 0)
      return
    }

    if (resolution.step === 'give') {
      const { targetIds, index } = resolution.data as { targetIds: PlayerId[]; index: number }
      const targetId = targetIds[index]
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: HONGYUAN }, { sourceId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: HONGYUAN }, { targetId, cardIds: [cardId] })
      }
      giveEach(host, ownerId, targetIds, index + 1)
    }
  },
})

registerSkillRuntime({
  id: MINGZHE,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      if (host.state.phase === 'play' && host.state.currentPlayerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const redCardIds = (payload.cardIds ?? []).filter((cardId) => host.state.cards[cardId]?.color === 'red')
      for (const cardId of redCardIds) {
        host.dispatch('SkillActivated', {
          skillId: MINGZHE, skillName: '明哲', playerId: ownerId,
          logText: `${owner.nickname}发动【明哲】，展示【${host.state.cards[cardId]?.name ?? ''}】，摸牌`,
        }, { sourceId: ownerId, cardIds: [cardId] })
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      }
    },
  }],
})

export const ZHUGEJIN: CharacterDefinition = {
  id: 'zhugejin',
  name: '诸葛瑾',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: HUANSHI, name: '缓释', description: '一名角色的判定牌生效前，诸葛瑾可以打出一张手牌代替判定牌，具体用哪张由被判定的角色从诸葛瑾手牌里选择。' },
    { id: HONGYUAN, name: '弘援', description: '每个阶段限一次，诸葛瑾一次性获得至少2张牌后，可以给至多2名其他角色各1张手牌。' },
    { id: MINGZHE, name: '明哲', description: '锁定技，诸葛瑾在自己的出牌阶段之外失去红色手牌后，展示这张牌，然后摸1张牌。' },
  ],
}
