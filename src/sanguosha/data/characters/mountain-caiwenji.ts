import { flipCharacter } from '../../engine/character-state'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest } from '../../engine/requests'
import { recheckZeroHpAfterSkillLoss, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

export const BEIGE = 'beige'
export const DUANCHANG = 'duanchang'
const BEIGE_TAG = 'beige'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function discardable(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  if (!player?.alive) return []
  return [...player.zones.hand, ...Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))]
}

function discard(host: SkillHost, playerId: PlayerId, cardIds: CardId[], reason: string): CardId[] {
  const moved: CardId[] = []
  for (const cardId of cardIds) {
    const from = locateOwnedCard(host.state, playerId, cardId)
    if (!from || from.kind === 'judgingArea') continue
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host, playerId, cardId)
    host.dispatch('CardMove', {
      cardIds: [cardId], sourcePlayerId: playerId, originalZone: from.kind,
      destinationZone: 'discardPile', reason: 'discard', skillReason: reason,
      phaseInstanceId: host.state.discardPhaseLedger?.phaseInstanceId,
    }, { sourceId: playerId, cardIds: [cardId], phase: host.state.phase })
    moved.push(cardId)
  }
  if (moved.length) host.dispatch('LoseCard', { playerId, cardIds: moved, reason }, { sourceId: playerId, cardIds: moved })
  return moved
}

registerSkillRuntime({
  id: BEIGE,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    const payload = context.event.payload as { cardName?: string; amount?: number }
    const targetId = context.event.targetId
    if (payload.cardName !== '杀' || !targetId || !playerOf(host.state, targetId)?.alive) return
    if (!discardable(host.state, ownerId).length) return
    host.queueSkill({ skillId: BEIGE, ownerId, step: 'cost', data: { targetId, sourceId: context.event.sourceId ?? null } })
  } }],
  startQueued(host, ownerId, prompt) {
    const targetId = prompt.data.targetId as PlayerId
    const cards = discardable(host.state, ownerId)
    if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, targetId)?.alive || !cards.length) return
    host.askSkill({ skillId: BEIGE, ownerId, step: 'cost', data: prompt.data, build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `发动【悲歌】？弃置一张牌，令${playerOf(host.state, targetId)?.nickname ?? '受伤角色'}进行判定`,
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 0, max: 1,
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const targetId = resolution.data.targetId as PlayerId
      if (!cardId || !playerOf(host.state, targetId)?.alive || !discard(host, ownerId, [cardId], BEIGE).length) return
      performJudgment(host, targetId, '悲歌', { tag: BEIGE_TAG, data: { ownerId, targetId, sourceId: resolution.data.sourceId ?? null } })
      return
    }
    if (resolution.step !== 'source-discard') return
    const sourceId = resolution.data.sourceId as PlayerId
    const want = Number(resolution.data.count ?? 0)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    discard(host, sourceId, selected.slice(0, want), BEIGE)
  },
})

registerJudgmentContinuation(BEIGE_TAG, (host, judged, data) => {
  const skillHost = host as SkillHost
  const ownerId = data.ownerId as PlayerId
  const targetId = data.targetId as PlayerId
  const sourceId = (data.sourceId as PlayerId | null) ?? null
  if (judged.suit === 'heart') {
    if (playerOf(host.state, targetId)?.alive) recover(host, targetId, 1, ownerId)
    return
  }
  if (judged.suit === 'diamond') {
    if (playerOf(host.state, targetId)?.alive) drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
    return
  }
  const source = sourceId ? playerOf(host.state, sourceId) : undefined
  if (!source?.alive) return
  if (judged.suit === 'spade') {
    flipCharacter(host, sourceId!, BEIGE)
    return
  }
  if (judged.suit !== 'club') return
  const cards = discardable(host.state, source.id)
  const count = Math.min(2, cards.length)
  if (!count) return
  skillHost.askSkill({ skillId: BEIGE, ownerId, step: 'source-discard', data: { sourceId: source.id, count }, build: (requestId): ChooseCardsRequest => ({
    id: requestId, kind: 'choose-cards', playerId: source.id, prompt: `【悲歌】：弃置 ${count} 张牌`, timeoutMs: 20_000,
    optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: count, max: count,
  }) })
})

registerSkillRuntime({
  id: DUANCHANG,
  triggers: [{ event: 'Death', allowDeadOwner: true, handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const sourceId = context.event.sourceId
    const killer = sourceId ? playerOf(host.state, sourceId) : undefined
    if (!killer?.alive) return
    killer.characterSkillsDisabled = true
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: DUANCHANG, skillName: '断肠', targetIds: [killer.id],
      logText: `${killer.nickname}因【断肠】失去所有武将技能`,
    }, { sourceId: ownerId, targetId: killer.id })
    recheckZeroHpAfterSkillLoss(host, killer.id)
  } }],
})

export const CAIWENJI: CharacterDefinition = {
  id: 'caiwenji', name: '蔡文姬', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'mountain',
  skills: [
    { id: BEIGE, name: '悲歌', description: '当一名角色受到【杀】造成的伤害后，你可以弃置一张牌令其判定：红桃其回复1点体力；方块其摸两张牌；梅花伤害来源弃置两张牌；黑桃伤害来源翻面。' },
    { id: DUANCHANG, name: '断肠', description: '锁定技。当你死亡时，杀死你的角色失去所有武将技能。' },
  ],
}
