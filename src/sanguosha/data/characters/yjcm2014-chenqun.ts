import { setChained } from '../../engine/character-state'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardCategory, CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈群（一将成名 2014）。
 *
 * 【品第】：出牌阶段，陈群可以弃置一张牌，选择一名其他角色（本回合不能重复
 *          弃置相同类别的牌，也不能重复指定相同角色）。X 为本回合内已发动
 *          （含本次）的次数，目标选择：摸 X 张牌，或弃置 X 张牌。结算后若
 *          目标已受伤，陈群将其横置。
 * 【法恩】：任意角色的武将牌翻至正面后，或进入横置状态后，陈群可以令其摸
 *          一张牌。
 *
 * 三处最容易做错的：
 *
 * 1. **品第的「不能重复」按类别和目标各自计数**，同一类别 / 同一目标本回合
 *    只能用一次，靠回合号做键天然随新回合失效，不需要显式清理。
 * 2. **X 是含本次的发动序数**（第一次 1、第二次 2、第三次 3），不是别的计数。
 * 3. **法恩只在「假→真」的转折时触发**：`flipCharacter` / `setChained` 已经做了
 *    「已经是目标状态就不发事件」的去重，这里收到事件即代表真的发生了转折。
 */

const PINDI = 'pindi'
const FAEN = 'faen'
const TURN_MARK = 'pindi-turn'
const COUNT_MARK = 'pindi-count'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function categoryUsedThisTurn(state: SanguoshaState, ownerId: PlayerId, category: CardCategory): boolean {
  return (playerOf(state, ownerId)?.marks[`pindi-cat-${category}`] ?? -1) === state.turnNumber
}

function targetUsedThisTurn(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  return (playerOf(state, ownerId)?.marks[`pindi-target:${targetId}`] ?? -1) === state.turnNumber
}

function discardCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => {
    const category = state.cards[cardId]?.category
    return category != null && !categoryUsedThisTurn(state, ownerId, category)
  })
}

function targetCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && !targetUsedThisTurn(state, ownerId, candidate.id))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: PINDI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (discardCandidates(state, ownerId).length === 0 || targetCandidates(state, ownerId).length === 0) return []
    return [{ id: PINDI, label: '品第：弃置一张牌，选择一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== PINDI) return
    const candidates = discardCandidates(host.state, ownerId)
    if (candidates.length === 0 || targetCandidates(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: PINDI, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【品第】：弃置一张牌（本回合不能重复弃置相同类别）',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive || !discardCandidates(host.state, ownerId).includes(cardId)) return
      const category = host.state.cards[cardId]!.category
      const candidateIds = targetCandidates(host.state, ownerId)
      if (candidateIds.length === 0) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: PINDI }, { targetId: ownerId, cardIds: [cardId] })
      owner.marks[`pindi-cat-${category}`] = host.state.turnNumber
      if (owner.marks[TURN_MARK] !== host.state.turnNumber) {
        owner.marks[TURN_MARK] = host.state.turnNumber
        owner.marks[COUNT_MARK] = 0
      }
      owner.marks[COUNT_MARK] = (owner.marks[COUNT_MARK] ?? 0) + 1
      const x = owner.marks[COUNT_MARK]
      host.askSkill({
        skillId: PINDI, ownerId, step: 'target', data: { x },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【品第】：选择一名其他角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const x = resolution.data.x as number
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || targetUsedThisTurn(host.state, ownerId, targetId!)) return
      owner.marks[`pindi-target:${targetId}`] = host.state.turnNumber
      host.dispatch('SkillActivated', {
        skillId: PINDI, skillName: '品第', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【品第】（第 ${x} 次）`,
      }, { sourceId: ownerId, targetId })
      const canDiscardX = target.zones.hand.length >= x
      host.askSkill({
        skillId: PINDI, ownerId, step: 'choice', data: { targetId, x },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId!,
          prompt: `${owner.nickname}发动【品第】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            { id: 'draw', label: `摸 ${x} 张牌` },
            ...(canDiscardX ? [{ id: 'discard', label: `弃置 ${x} 张牌` }] : []),
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const x = resolution.data.x as number
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard' && target.zones.hand.length >= x) {
        host.askSkill({
          skillId: PINDI, ownerId, step: 'discard-pick', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: `【品第】：弃置 ${x} 张牌`,
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: [...target.zones.hand], hiddenCardSlots: [], min: x, max: x,
          }),
        })
        return
      }
      drawCards(host.state, host.rng, targetId, x, (name, payload) => { host.dispatch(name, payload) })
      finishPindi(host, targetId)
      return
    }

    if (resolution.step === 'discard-pick') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => target?.zones.hand.includes(cardId))
      if (!target?.alive) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      if (cardIds.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: PINDI }, { targetId, cardIds })
      finishPindi(host, targetId)
    }
  },
})

function finishPindi(host: SkillHost, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (target?.alive && target.hp < target.maxHp) setChained(host as never, targetId, PINDI, true)
}

// ─────────────────────────────── 法恩 ───────────────────────────────

registerSkillRuntime({
  id: FAEN,
  triggers: [
    {
      event: 'CharacterFlip',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; faceDown?: boolean }
        if (payload.faceDown !== false || !payload.playerId) return
        // 排队而不是当场问：同一次牌结算里可能连续翻正/横置两名角色
        // （铁索连环一次最多影响两人），当场 askSkill 会撞上还没收到回应的上一次发问。
        host.queueSkill({ skillId: FAEN, ownerId, step: 'ask', data: { targetId: payload.playerId } })
      },
    },
    {
      event: 'CharacterChained',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; chained?: boolean }
        if (payload.chained !== true || !payload.playerId) return
        host.queueSkill({ skillId: FAEN, ownerId, step: 'ask', data: { targetId: payload.playerId } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    askFaen(host, ownerId, prompt.data.targetId as PlayerId)
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', {
      skillId: FAEN, skillName: '法恩', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【法恩】`,
    }, { sourceId: ownerId, targetId })
    drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

function askFaen(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || !playerOf(host.state, targetId)?.alive) return
  host.askSkill({
    skillId: FAEN, ownerId, step: 'ask', data: { targetId },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【法恩】：令其摸一张牌？',
      timeoutMs: 20_000, optional: true,
      options: [{ id: 'yes', label: '发动【法恩】' }, { id: 'no', label: '不发动' }],
    }),
  })
}

export const CHENQUN: CharacterDefinition = {
  id: 'chenqun',
  name: '陈群',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2014',
  skills: [
    {
      id: PINDI,
      name: '品第',
      description: '出牌阶段，陈群可以弃置一张牌，选择一名其他角色（本回合不能重复弃置相同类别的牌，也不能重复指定相同角色）。X 为本回合内已发动（含本次）的次数，目标选择：摸 X 张牌，或弃置 X 张牌。结算后若目标已受伤，陈群将其横置。',
    },
    {
      id: FAEN,
      name: '法恩',
      description: '任意角色的武将牌翻至正面后，或进入横置状态后，陈群可以令其摸一张牌。',
    },
  ],
}
