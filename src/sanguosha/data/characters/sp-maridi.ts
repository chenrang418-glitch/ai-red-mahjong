import { moveCard } from '../../engine/zones'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马日磾（三国杀 OL 经典身份 SP）。
 *
 * 【秉节】：出牌阶段开始时，可以失去1点体力上限；若如此做，直到本回合
 *          结束，马日磾使用【杀】或普通/非延时锦囊指定目标后，除他自己
 *          外的每名目标各弃置1张牌（目标自选，无牌则不弃，不取消原使用）。
 * 【正订】：锁定技，马日磾在自己回合外使用/打出一张牌以响应其他角色
 *          使用的牌时，若两张牌颜色相同，体力上限+1。
 */

const BINGJIE = 'bingjie'
const ZHENGDING = 'zhengding'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bingjieActive(state: SanguoshaState, ownerId: PlayerId): boolean {
  const entry = state.maridiBingjieActive
  return !!entry && entry.turnNumber === state.turnNumber && entry.ownerId === ownerId
}

function askBingjieDiscard(host: SkillHost, ownerId: PlayerId, targets: PlayerId[]): void {
  let remaining = targets
  while (remaining.length > 0) {
    const [next, ...rest] = remaining
    const target = playerOf(host.state, next)
    if (target?.alive && target.zones.hand.length > 0) {
      host.askSkill({
        skillId: BINGJIE, ownerId, step: 'discard-one', data: { rest },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: next,
          prompt: '【秉节】：弃置1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    remaining = rest
  }
}

registerSkillRuntime({
  id: BINGJIE,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.playerId !== ownerId || payload.phase !== 'play') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.maxHp <= 1) return
        host.queueSkill({ skillId: BINGJIE, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId || !bingjieActive(host.state, ownerId)) return
        const payload = context.event.payload as { cardName?: string; asCardName?: string; targetIds?: PlayerId[]; cancelled?: boolean }
        if (payload.cancelled) return
        const name = payload.asCardName ?? payload.cardName ?? ''
        if (name !== '杀' && !INSTANT_TRICKS.has(name)) return
        const targets = (payload.targetIds ?? []).filter((id) => id !== ownerId)
        if (targets.length === 0) return
        host.queueSkill({ skillId: BINGJIE, ownerId, step: 'discard-chain', data: { targets } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      host.askSkill({
        skillId: BINGJIE, ownerId, step: 'confirm', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【秉节】：是否失去1点体力上限？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'discard-chain') {
      const { targets } = prompt.data as { targets: PlayerId[] }
      askBingjieDiscard(host, ownerId, targets)
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'confirm') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      loseMaxHp(host as never, ownerId, 1, BINGJIE)
      host.state.maridiBingjieActive = { turnNumber: host.state.turnNumber, ownerId }
      host.dispatch('SkillActivated', { skillId: BINGJIE, skillName: '秉节', playerId: ownerId, logText: `${owner.nickname}发动【秉节】，失去1点体力上限` }, { sourceId: ownerId })
      return
    }
    if (resolution.step === 'discard-one') {
      const { rest } = resolution.data as { rest: PlayerId[] }
      const responderId = response.playerId
      const responder = playerOf(host.state, responderId)
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => responder?.zones.hand.includes(id))
      if (valid.length > 0) {
        moveCard(host.state, valid[0], { kind: 'hand', playerId: responderId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: responderId, cardIds: [valid[0]], reason: BINGJIE }, { sourceId: responderId, cardIds: [valid[0]] })
      }
      askBingjieDiscard(host, ownerId, rest)
    }
  },
})

registerSkillRuntime({
  id: ZHENGDING,
  triggers: [{
    event: 'CardResponded',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId || host.state.currentPlayerId === ownerId) return
      const payload = context.event.payload as { cardId?: CardId }
      const respondedColor = payload.cardId ? host.state.cards[payload.cardId]?.color : undefined
      const resolution = host.state.cardResolution
      const originalCardId = resolution && (resolution.kind === 'slash' || resolution.kind === 'trick') ? resolution.cardId : undefined
      const originalColor = originalCardId ? host.state.cards[originalCardId]?.color : undefined
      if (!respondedColor || !originalColor || respondedColor !== originalColor) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      gainMaxHp(host as never, ownerId, 1, ZHENGDING)
      host.dispatch('SkillActivated', { skillId: ZHENGDING, skillName: '正订', playerId: ownerId, logText: `${owner.nickname}发动【正订】，体力上限+1` }, { sourceId: ownerId })
    },
  }],
})

export const MARIDI: CharacterDefinition = {
  id: 'maridi',
  name: '马日磾',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: BINGJIE, name: '秉节', description: '出牌阶段开始时，可以失去1点体力上限；若如此做，直到本回合结束，你使用【杀】或普通/非延时锦囊指定目标后，除你以外的每名目标各弃置1张牌。' },
    { id: ZHENGDING, name: '正订', description: '锁定技，你在自己回合外使用/打出一张牌以响应其他角色使用的牌时，若两张牌颜色相同，体力上限+1。' },
  ],
}
