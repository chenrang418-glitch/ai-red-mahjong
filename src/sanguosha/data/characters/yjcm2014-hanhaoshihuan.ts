import { executeUseCardAction } from '../../engine/cards/basic'
import { useAction } from '../../engine/cards/host'
import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { canTarget, getAttackRange } from '../../engine/distance'
import { newDiscardEntries } from '../../engine/discard-provenance'
import { drawCards } from '../../engine/draw'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 韩浩史涣（一将成名 2014）。
 *
 * 【慎断】：每当韩浩史涣的一张黑色基本牌因弃置而进入弃牌堆后，他可以将此牌
 *          当【兵粮寸断】使用，无距离限制。
 * 【勇略】：其他角色的判定阶段开始时，若该角色判定区有牌且在韩浩史涣的攻击
 *          范围内，他可以弃置其判定区的一张牌，然后视为对其使用一张【杀】。
 *          此【杀】结算后若没有造成过伤害，韩浩史涣摸一张牌。
 *
 * 三处最容易做错的：
 *
 * 1. **慎断只认「因弃置」进弃牌堆、且是自己的黑色基本牌**，用弃牌堆来源
 *    记录增量筛选，用过的牌结算完同样躺在弃牌堆里但那不算。
 * 2. **慎断这张牌无距离限制**：不走 `legalPlayActions` 生成的候选，
 *    自己直接列出全部存活其他角色，不依赖 `canPlaceDelayedTrick` 的距离判断。
 * 3. **勇略「没有造成过伤害」按这次虚拟杀的实体牌在伤害账本里的记录判断**，
 *    不能只看是不是被【闪】——被完全防止同样算「没有造成过伤害」。
 */

const SHENDUAN = 'shenduan'
const YONGLUE = 'yonglue'
const CURSOR_MARK = 'shenduan-cursor'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function shenduanCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  const cursor = owner?.marks[CURSOR_MARK] ?? 0
  return newDiscardEntries(state, cursor, (entry, cardId) => (
    entry.reason === 'discard' && entry.ownerId === ownerId
    && state.cards[cardId]?.category === 'basic'
    && effectiveCardColor(state, ownerId, cardId) === 'black'
  ))
}

function advanceCursor(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.marks[CURSOR_MARK] = state.seq
}

registerSkillRuntime({
  id: SHENDUAN,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId) {
      host.queueSkill({ skillId: SHENDUAN, ownerId, step: 'pick', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = shenduanCandidates(host.state, ownerId)
    if (candidates.length === 0) { advanceCursor(host.state, ownerId); return }
    host.askSkill({
      skillId: SHENDUAN, ownerId, step: 'pick',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【慎断】：将这张黑色基本牌当【兵粮寸断】使用？',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'pick') {
      advanceCursor(host.state, ownerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive || !host.state.zones.discardPile.includes(cardId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: SHENDUAN, ownerId, step: 'target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【慎断】：选择一名角色（无距离限制）',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const cardId = resolution.data.cardId as CardId
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !targetId || !host.state.zones.discardPile.includes(cardId)) return
      // 从弃牌堆回到手上，作为使用这张【兵粮寸断】的载体
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
      const action = useAction(cardId, ownerId, '兵粮寸断', [targetId], '')
      if (action.kind !== 'use-card') return
      executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
    }
  },
})

registerSkillRuntime({
  id: YONGLUE,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'judge' || !payload.playerId || payload.playerId === ownerId) return
        host.queueSkill({ skillId: YONGLUE, ownerId, step: 'discard', data: { targetId: payload.playerId } })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; sourceSkillId?: string }
        if (context.event.sourceId !== ownerId || payload.cardName !== '杀' || payload.sourceSkillId !== YONGLUE) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !payload.cardId) return
        if (cardDamageDealt(host.state, payload.cardId) > 0) return
        drawCards(host.state, host.rng, ownerId, 1, (name, drawPayload) => { host.dispatch(name, drawPayload) })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || target.zones.judgingArea.length === 0) return
    if (!canTarget(host.state, ownerId, targetId, getAttackRange(host.state, ownerId))) return
    host.askSkill({
      skillId: YONGLUE, ownerId, step: 'discard', data: { targetId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【勇略】：弃置${target.nickname}判定区的一张牌，视为对其使用一张【杀】？`,
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: [...target.zones.judgingArea], hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!cardId || !owner?.alive || !target?.alive || !target.zones.judgingArea.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'judgingArea', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: YONGLUE }, { targetId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: YONGLUE, skillName: '勇略', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【勇略】，视为对${target.nickname}使用一张【杀】`,
    }, { sourceId: ownerId, targetId })
    host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: YONGLUE })
  },
})

export const HANHAO_SHIHUAN: CharacterDefinition = {
  id: 'hanhaoshihuan',
  name: '韩浩史涣',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2014',
  skills: [
    {
      id: SHENDUAN,
      name: '慎断',
      description: '每当韩浩史涣的一张黑色基本牌因弃置而进入弃牌堆后，他可以将此牌当【兵粮寸断】使用，无距离限制。',
    },
    {
      id: YONGLUE,
      name: '勇略',
      description: '其他角色的判定阶段开始时，若该角色判定区有牌且在韩浩史涣的攻击范围内，他可以弃置其判定区的一张牌，然后视为对其使用一张【杀】。此【杀】结算后若没有造成过伤害，韩浩史涣摸一张牌。',
    },
  ],
}
