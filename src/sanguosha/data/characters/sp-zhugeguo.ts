import { moveCard } from '../../engine/zones'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 诸葛果（三国杀 OL 经典身份 SP）。
 *
 * 【祈禳】：使用装备牌后，可以从牌堆中获得1张锦囊牌；若是普通锦囊，绑定这张
 *          具体 Card ID，之后以唯一目标使用它时可以额外指定1个合法目标
 *          （用同名虚拟锦囊对新目标再结算一次，复用费祎【和衷】同款机制）；
 *          若是延时锦囊，下一次【羽化】观看数+1（累计，最多5张）。
 * 【羽化】：锁定技，手牌中的锦囊/装备牌不计入手牌上限；准备阶段和结束阶段
 *          各观看牌堆顶X张（X=1+祈禳延时锦囊累计加成，最多5），选择其中
 *          1张置于牌堆顶或牌堆底，其余保持原顺序在牌堆顶。
 */

const QIRANG = 'qirang'
const YUHUA = 'yuhua'
const YUHUA_BONUS_MARK = 'yuhua-bonus'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function yuhuaPeekCount(state: SanguoshaState, ownerId: PlayerId): number {
  const bonus = playerOf(state, ownerId)?.marks[YUHUA_BONUS_MARK] ?? 0
  return Math.min(5, 1 + bonus)
}

registerSkillRuntime({
  id: QIRANG,
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cancelled?: boolean; targetIds?: PlayerId[]; cardName?: string }
        if (context.event.sourceId !== ownerId || payload.cancelled) return
        // 追加目标：这张牌恰好是祈禳绑定的那张，且这次只有1个目标
        if (payload.cardId && payload.cardId === host.state.zhugeguoExtraTargetCardId) {
          host.state.zhugeguoExtraTargetCardId = undefined
          const targetIds = payload.targetIds ?? []
          const cardName = payload.cardName
          if (targetIds.length === 1 && cardName) {
            const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && !targetIds.includes(candidate.id)).map((candidate) => candidate.id)
            if (candidateIds.length > 0) host.queueSkill({ skillId: QIRANG, ownerId, step: 'extra-target-ask', data: { cardName } })
          }
          return
        }
        if (!payload.cardId) return
        const card = host.state.cards[payload.cardId]
        if (!card || card.category !== 'equipment') return
        const index = host.state.zones.drawPile.findIndex((cardId) => host.state.cards[cardId]?.category === 'trick')
        if (index < 0) return
        host.queueSkill({ skillId: QIRANG, ownerId, step: 'ask', data: { cardId: host.state.zones.drawPile[index] } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask') {
      const { cardId } = prompt.data as { cardId: CardId }
      if (!host.state.zones.drawPile.includes(cardId)) return
      host.askSkill({
        skillId: QIRANG, ownerId, step: 'confirm', data: { cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【祈禳】：是否获得牌堆中的【${host.state.cards[cardId]?.name}】？`, timeoutMs: 20_000, optional: true,
          options: [{ id: 'gain', label: '获得' }, { id: 'cancel', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'extra-target-ask') {
      const { cardName } = prompt.data as { cardName: string }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QIRANG, ownerId, step: 'extra-target', data: { cardName },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【祈禳】：可以额外指定1个【${cardName}】的目标`, timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'confirm') {
      const { cardId } = resolution.data as { cardId: CardId }
      if ((response.payload as { optionId?: string }).optionId !== 'gain' || !host.state.zones.drawPile.includes(cardId)) return
      const card = host.state.cards[cardId]
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: QIRANG }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: QIRANG, skillName: '祈禳', playerId: ownerId, logText: `${owner.nickname}发动【祈禳】，获得【${card?.name}】` }, { sourceId: ownerId })
      if (card && DELAYED_TRICKS.has(card.name)) {
        owner.marks[YUHUA_BONUS_MARK] = Math.min(4, (owner.marks[YUHUA_BONUS_MARK] ?? 0) + 1)
      } else if (card) {
        host.state.zhugeguoExtraTargetCardId = cardId
      }
      return
    }

    if (resolution.step === 'extra-target') {
      const { cardName } = resolution.data as { cardName: string }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const virtualId = createVirtualTrick(host.state, ownerId, cardName, QIRANG)
      host.dispatch('SkillActivated', { skillId: QIRANG, skillName: '祈禳', playerId: ownerId, targetId, logText: `${owner.nickname}发动【祈禳】，对${target.nickname}额外结算【${cardName}】` }, { sourceId: ownerId, targetId })
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `qirang-extra:${virtualId}`, playerId: ownerId,
        cardIds: [virtualId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: cardName, label: `【祈禳】额外结算【${cardName}】`,
      })
    }
  },
})

registerSkillRuntime({
  id: YUHUA,
  handLimitExempt(state, _ownerId, cardId) {
    const card = state.cards[cardId]
    return !!card && card.category !== 'basic'
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || (payload.phase !== 'prepare' && payload.phase !== 'end')) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const count = yuhuaPeekCount(host.state, ownerId)
      const top = host.state.zones.drawPile.slice(0, count)
      if (top.length === 0) return
      host.queueSkill({ skillId: YUHUA, ownerId, step: 'peek', data: { top } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'peek') return
    const { top } = prompt.data as { top: CardId[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const valid = top.filter((cardId) => host.state.zones.drawPile.includes(cardId))
    if (valid.length === 0) return
    host.askSkill({
      skillId: YUHUA, ownerId, step: 'pick', data: { top: valid },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【羽化】：观看牌堆顶${valid.length}张牌，选择其中1张置于牌堆顶或牌堆底`, timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: valid, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick') {
      const { top } = resolution.data as { top: CardId[] }
      const [picked] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!picked || !top.includes(picked) || !host.state.zones.drawPile.includes(picked)) return
      host.askSkill({
        skillId: YUHUA, ownerId, step: 'place', data: { picked },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【羽化】：将这张牌置于牌堆顶还是牌堆底？', timeoutMs: 20_000, optional: false,
          options: [{ id: 'top', label: '置于牌堆顶' }, { id: 'bottom', label: '置于牌堆底' }],
        }),
      })
      return
    }
    if (resolution.step === 'place') {
      const { picked } = resolution.data as { picked: CardId }
      if (!host.state.zones.drawPile.includes(picked)) return
      const optionId = (response.payload as { optionId?: string }).optionId
      host.state.zones.drawPile = host.state.zones.drawPile.filter((cardId) => cardId !== picked)
      if (optionId === 'bottom') host.state.zones.drawPile.push(picked)
      else host.state.zones.drawPile.unshift(picked)
    }
  },
})

export const ZHUGEGUO: CharacterDefinition = {
  id: 'zhugeguo',
  name: '诸葛果',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QIRANG, name: '祈禳', description: '你使用装备牌后，可以从牌堆中获得1张锦囊牌；若获得的是普通锦囊，之后以唯一目标使用这张牌时可以额外指定1个目标；若获得的是延时锦囊，你下一次【羽化】的观看张数+1（最多5张）。' },
    { id: YUHUA, name: '羽化', description: '锁定技，你手牌中的锦囊牌、装备牌不计入手牌上限；准备阶段和结束阶段，你各观看牌堆顶X张牌（X默认为1，受祈禳影响），然后将其中1张置于牌堆顶或牌堆底。' },
  ],
}
