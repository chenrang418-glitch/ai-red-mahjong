import { moveCard } from '../../engine/zones'
import { flipCharacter } from '../../engine/character-state'
import { skipPhase } from '../../engine/turn'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState, Suit } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 杜袭（三国杀 OL 经典身份 SP）。
 *
 * 【驱徙】：限定技，出牌阶段结束时可以发动：跳过本回合弃牌阶段并翻至
 *          背面（沿用"背面角色轮到回合翻正面后跳过整个回合"的既有规则，
 *          等价于跳过下一回合），选择两名手牌数不同的其他角色，手牌较少
 *          者获得手牌较多者一张牌，然后手少者获得【丰】、手多者获得
 *          【歉】（各自唯一持有，转移时先清除原持有者）。
 * 【避凶】：锁定技，杜袭在弃牌阶段中实际弃置过手牌后，记录这些牌的花色
 *          集合，直到杜袭下一回合开始，其他角色不能使用这些花色的牌
 *          指定杜袭为目标。
 */

const QUXI = 'quxi'
const BIXIONG = 'bixiong'
const FENG_MARK = 'feng'
const QIAN_MARK = 'qian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function clearMark(state: SanguoshaState, mark: string): void {
  for (const player of state.players) delete player.marks[mark]
}

registerSkillRuntime({
  id: QUXI,
  offerPhaseSkip(host, ownerId, phase) {
    if (phase !== 'discard' || host.state.currentPlayerId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(QUXI)) return false
    const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId)
    const handCounts = new Set(others.map((candidate) => candidate.zones.hand.length))
    if (others.length < 2 || handCounts.size < 2) return false
    host.askSkill({
      skillId: QUXI, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【驱徙】：是否发动？（跳过本回合弃牌阶段并翻至背面）', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'transfer-ask') return
    if (!playerOf(host.state, ownerId)?.alive) return
    offerTransferAsk(host, ownerId)
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes' || !owner?.alive) { host.resumePhaseEntry(); return }
      const others = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.askSkill({
        skillId: QUXI, ownerId, step: 'pick',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【驱徙】：选择两名手牌数不同的其他角色', timeoutMs: 20_000, optional: false, candidateIds: others, min: 2, max: 2,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const [aId, bId] = targetIds
      const a = aId ? playerOf(host.state, aId) : undefined
      const b = bId ? playerOf(host.state, bId) : undefined
      if (!owner?.alive || !a?.alive || !b?.alive || a.zones.hand.length === b.zones.hand.length) { host.resumePhaseEntry(); return }
      owner.usedLimitedSkills.push(QUXI)
      skipPhase(host.state, 'discard')
      flipCharacter(host as never, ownerId, QUXI, true)
      const [less, more] = a.zones.hand.length < b.zones.hand.length ? [a, b] : [b, a]
      host.dispatch('SkillActivated', { skillId: QUXI, skillName: '驱徙', playerId: ownerId, logText: `${owner.nickname}发动【驱徙】` }, { sourceId: ownerId })
      if (more.zones.hand.length > 0) {
        const cardId = more.zones.hand[host.rng.nextInt(more.zones.hand.length)]
        moveCard(host.state, cardId, { kind: 'hand', playerId: more.id }, { kind: 'hand', playerId: less.id })
        host.dispatch('LoseCard', { playerId: more.id, cardIds: [cardId], reason: QUXI }, { sourceId: more.id, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: less.id, cardIds: [cardId], reason: QUXI }, { targetId: less.id, cardIds: [cardId] })
      }
      clearMark(host.state, FENG_MARK)
      clearMark(host.state, QIAN_MARK)
      less.marks[FENG_MARK] = 1
      more.marks[QIAN_MARK] = 1
      host.resumePhaseEntry()
      return
    }

    if (resolution.step === 'transfer-which') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId || optionId === 'none') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QUXI, ownerId, step: 'transfer-target', data: { mark: optionId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【驱徙】：转移${optionId === FENG_MARK ? '丰' : '歉'}给谁`, timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'transfer-target') {
      const { mark } = resolution.data as { mark: string }
      const [recipientId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const recipient = recipientId ? playerOf(host.state, recipientId) : undefined
      if (!recipient?.alive) return
      clearMark(host.state, mark)
      recipient.marks[mark] = 1
    }
  },

  triggers: [
    {
      event: 'Death',
      handle(host, ownerId, context) {
        const deadId = context.event.targetId
        const owner = playerOf(host.state, ownerId)
        if (!deadId || !owner?.alive) return
        // 死亡/濒死结算链路可能正在处理别的事，askSkill 不安全，排队到安全点再问
        host.queueSkill({ skillId: QUXI, ownerId, step: 'transfer-ask', data: {} })
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.queueSkill({ skillId: QUXI, ownerId, step: 'transfer-ask', data: {} })
      },
    },
  ],
})

function offerTransferAsk(host: SkillHost, ownerId: PlayerId): void {
  const hasFeng = host.state.players.some((candidate) => candidate.alive && (candidate.marks[FENG_MARK] ?? 0) > 0)
  const hasQian = host.state.players.some((candidate) => candidate.alive && (candidate.marks[QIAN_MARK] ?? 0) > 0)
  if (!hasFeng && !hasQian) return
  host.askSkill({
    skillId: QUXI, ownerId, step: 'transfer-which',
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【驱徙】：是否转移丰/歉？', timeoutMs: 20_000, optional: true,
      options: [
        { id: 'none', label: '不转移' },
        ...(hasFeng ? [{ id: FENG_MARK, label: '转移丰' }] : []),
        ...(hasQian ? [{ id: QIAN_MARK, label: '转移歉' }] : []),
      ],
    }),
  })
}

registerSkillRuntime({
  id: BIXIONG,
  maxCardsBonus(state, ownerId) {
    return (playerOf(state, ownerId)?.marks[FENG_MARK] ?? 0) > 0 ? 1 : (playerOf(state, ownerId)?.marks[QIAN_MARK] ?? 0) > 0 ? -1 : 0
  },
  triggers: [
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardIds?: string[]; reason?: string }
        if (payload.reason !== 'discard-phase' || payload.playerId !== ownerId || !payload.cardIds) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const suits = new Set<Suit>()
        for (const cardId of payload.cardIds) {
          const suit = effectiveCardSuit(host.state, ownerId, cardId)
          if (suit) suits.add(suit)
        }
        if (suits.size === 0) return
        host.state.duxiForbiddenSuits = { suits: [...suits], sinceTurn: host.state.turnNumber }
        host.dispatch('SkillActivated', { skillId: BIXIONG, skillName: '避凶', playerId: ownerId, logText: `${owner.nickname}发动【避凶】` }, { sourceId: ownerId })
      },
    },
    {
      event: 'TurnStart',
      handle(host, ownerId) {
        if (host.state.currentPlayerId === ownerId) host.state.duxiForbiddenSuits = undefined
      },
    },
  ],
  prohibitsTarget(state, _ownerId, _sourceId, _cardName, cardId) {
    const forbidden = state.duxiForbiddenSuits
    if (!forbidden || !cardId) return false
    const suit = effectiveCardSuit(state, _sourceId, cardId)
    return !!suit && forbidden.suits.includes(suit)
  },
})

export const DUXI: CharacterDefinition = {
  id: 'duxi',
  name: '杜袭',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QUXI, name: '驱徙', description: '限定技，出牌阶段结束时可以发动：跳过本回合弃牌阶段并翻至背面，选择两名手牌数不同的其他角色，手牌较少者获得手牌较多者一张牌，然后手少者获得【丰】（手牌上限+1），手多者获得【歉】（手牌上限-1）；持有者死亡或每轮开始时可以转移。' },
    { id: BIXIONG, name: '避凶', description: '锁定技，杜袭在弃牌阶段中实际弃置过手牌后，记录这些牌的花色，直到杜袭下一回合开始，其他角色不能使用这些花色的牌指定杜袭为目标。' },
  ],
}
