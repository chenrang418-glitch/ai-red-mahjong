import { executeUseCardAction } from '../../engine/cards/basic'
import { useAction } from '../../engine/cards/host'
import { newDiscardEntries } from '../../engine/discard-provenance'
import { reshuffleDrawPile } from '../../engine/deck'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 虞翻（一将成名 2013）。
 *
 * 【纵玄】：每当虞翻的一张牌因弃置而进入弃牌堆后，虞翻可以将其中至少一张
 *          （可以是这次弃置的全部），以任意顺序置于牌堆顶。
 * 【直言】：结束阶段，虞翻可以选择一名角色，其摸一张牌并展示，若这张牌是
 *          装备牌，则其使用（装备）此牌，然后回复 1 点体力。
 *
 * 三处最容易做错的：
 *
 * 1. **纵玄只认「因弃置」进弃牌堆、而且是虞翻自己的牌**——挂在 `LoseCard`
 *    上、用弃牌堆的来源记录（discard-provenance）筛，不扫整个弃牌堆。
 * 2. **纵玄拿走的是这几张牌本身**，不是「等量摸牌」；牌堆构成不变。
 * 3. **直言先摸牌展示，是不是装备决定要不要往下走**：不是装备就到手牌
 *    为止，没有回复体力这一步。
 */

const ZONGXUAN = 'zongxuan'
const ZHIYAN = 'zhiyan'
const CURSOR_MARK = 'zongxuan-cursor'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function zongxuanCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  const cursor = owner?.marks[CURSOR_MARK] ?? 0
  return newDiscardEntries(state, cursor, (entry) => entry.reason === 'discard' && entry.ownerId === ownerId)
}

function advanceCursor(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.marks[CURSOR_MARK] = state.seq
}

// ─────────────────────────────── 纵玄 ───────────────────────────────

registerSkillRuntime({
  id: ZONGXUAN,
  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId) {
      host.queueSkill({ skillId: ZONGXUAN, ownerId, step: 'redirect', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'redirect') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidates = zongxuanCandidates(host.state, ownerId)
    if (candidates.length === 0) {
      advanceCursor(host.state, ownerId)
      return
    }
    host.askSkill({
      skillId: ZONGXUAN, ownerId, step: 'redirect',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【纵玄】：将其中至少一张（按选择顺序）置于牌堆顶',
        timeoutMs: 25_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [],
        min: 0, max: candidates.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'redirect') return
    const owner = playerOf(host.state, ownerId)
    advanceCursor(host.state, ownerId)
    if (!owner?.alive) return
    const picked = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      .filter((cardId) => host.state.zones.discardPile.includes(cardId))
    if (picked.length === 0) return
    // 按玩家选择的顺序作为「从上到下」的顺序：逆序逐个塞进牌堆顶
    for (const cardId of [...picked].reverse()) {
      moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'drawPile' }, { toTop: true })
    }
    host.dispatch('SkillActivated', {
      skillId: ZONGXUAN, skillName: '纵玄', playerId: ownerId, cardIds: picked,
      logText: `${owner.nickname}发动【纵玄】，将 ${picked.length} 张牌置于牌堆顶`,
    }, { sourceId: ownerId, cardIds: picked })
  },
})

// ─────────────────────────────── 直言 ───────────────────────────────

registerSkillRuntime({
  id: ZHIYAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      host.queueSkill({ skillId: ZHIYAN, ownerId, step: 'target', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHIYAN, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【直言】：选择一名角色，其摸一张牌并展示',
        timeoutMs: 20_000, optional: true,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return

    if (host.state.zones.drawPile.length === 0) {
      reshuffleDrawPile(host.state, host.rng, (name, payload) => { host.dispatch(name, payload) })
    }
    const cardId = host.state.zones.drawPile[0]
    if (!cardId) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
    host.dispatch('CardMove', { playerId: targetId, cardIds: [cardId], reason: ZHIYAN, revealed: true }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: ZHIYAN, skillName: '直言', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【直言】，${target.nickname}摸一张牌并展示`,
    }, { sourceId: ownerId, targetId })
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId! })
    host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: ZHIYAN }, { targetId, cardIds: [cardId] })

    const card = host.state.cards[cardId]
    if (card?.category !== 'equipment') return
    const action = useAction(cardId, targetId!, card.name, [], '')
    if (action.kind !== 'use-card') return
    executeUseCardAction(host as never, targetId!, action)
    recover(host as never, targetId!, 1, ZHIYAN)
  },
})

export const YUFAN: CharacterDefinition = {
  id: 'yufan',
  name: '虞翻',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: ZONGXUAN,
      name: '纵玄',
      description: '每当虞翻的一张牌因弃置而进入弃牌堆后，虞翻可以将其中至少一张（可以是这次弃置的全部），以任意顺序置于牌堆顶。',
    },
    {
      id: ZHIYAN,
      name: '直言',
      description: '结束阶段，虞翻可以选择一名角色，其摸一张牌并展示，若这张牌是装备牌，则其使用（装备）此牌，然后回复 1 点体力。',
    },
  ],
}
