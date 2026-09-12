import { aliveOrderFromCurrent } from '../../engine/cards/tricks'
import { resolveDamage } from '../../engine/damage'
import { effectiveCardColor, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 李儒（一将成名 2013，采用 2014 调整后的成熟版）。
 *
 * 【绝策】：结束阶段，李儒可以选择一名没有手牌的其他角色，对其造成 1 点伤害。
 * 【灭计】：出牌阶段限一次，李儒将一张黑色锦囊牌置于牌堆顶，然后选择一名
 *          有手牌的其他角色，其选择：弃置一张锦囊牌，或依次弃置两张非锦囊牌。
 * 【焚城】：限定技，出牌阶段，李儒可以发动：按存活座次，令所有其他角色依次
 *          选择：弃置至少 X 张牌，或受到李儒造成的 2 点火焰伤害
 *          （X 为其上家在本次焚城中因此弃置的牌数 + 1，第一名目标 X = 1）。
 *
 * 三处最容易做错的：
 *
 * 1. **灭计付的代价是黑色锦囊牌，真实置入牌堆顶**（不是弃牌堆），且必须
 *    是李儒自己的手牌；两个选项里对目标不可行的那个不出现。
 * 2. **焚城的 X 只看上一个人「实际弃了几张」**：上一个人选了受伤，
 *    下一个人的 X 重新回到 1；这要按存活座次严格依次结算，不能同时问。
 * 3. **焚城中途有人死亡要继续处理剩余存活角色**，不能拿开局快照的名单
 *    直接一个个发问。
 */

const JUECE = 'juece'
const MIEJI = 'mieji'
const FENCHENG = 'fencheng'
const FENCHENG_ACTION = 'fencheng-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function jueceTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length === 0).map((candidate) => candidate.id)
}

// ─────────────────────────────── 绝策 ───────────────────────────────

registerSkillRuntime({
  id: JUECE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const candidateIds = jueceTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: JUECE, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【绝策】：选择一名没有手牌的其他角色，对其造成 1 点伤害',
          timeoutMs: 20_000, optional: true,
          candidateIds, min: 1, max: 1,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!owner?.alive || !targetId || !jueceTargets(host.state, ownerId).includes(targetId)) return
    host.dispatch('SkillActivated', {
      skillId: JUECE, skillName: '绝策', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【绝策】`,
    }, { sourceId: ownerId, targetId })
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
  },
})

// ─────────────────────────────── 灭计 ───────────────────────────────

function blackTricksInHand(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => {
    const card = state.cards[cardId]
    return card?.category === 'trick' && effectiveCardColor(state, ownerId, cardId) === 'black'
  })
}

/**
 * 灭计合法目标：有手牌，而且至少能完成 A/B 其中一项——
 * 手牌里恰好一张非锦囊牌的角色两项都凑不出来，不能被选为目标
 * （不然会问出一个零选项的请求）。
 */
function miejiTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((candidate) => {
    if (!candidate.alive || candidate.id === ownerId || candidate.zones.hand.length === 0) return false
    const hasTrick = candidate.zones.hand.some((cardId) => state.cards[cardId]?.category === 'trick')
    const hasTwoNonTrick = candidate.zones.hand.filter((cardId) => state.cards[cardId]?.category !== 'trick').length >= 2
    return hasTrick || hasTwoNonTrick
  }).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: MIEJI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, MIEJI)) return []
    if (blackTricksInHand(state, ownerId).length === 0) return []
    if (miejiTargets(state, ownerId).length === 0) return []
    return [{ id: MIEJI, label: '灭计：将一张黑色锦囊牌置于牌堆顶，令一名有手牌的其他角色弃牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== MIEJI) return
    const candidates = blackTricksInHand(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: MIEJI, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【灭计】：将一张黑色锦囊牌置于牌堆顶',
        timeoutMs: 20_000, optional: true, purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'cost') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner?.alive || !blackTricksInHand(host.state, ownerId).includes(cardId)) return
      const candidateIds = miejiTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      markUsedThisPhase(host.state, ownerId, MIEJI)
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'drawPile' }, { toTop: true })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MIEJI }, { targetId: ownerId, cardIds: [cardId] })
      host.dispatch('SkillActivated', {
        skillId: MIEJI, skillName: '灭计', playerId: ownerId,
        logText: `${owner.nickname}发动【灭计】，将一张黑色锦囊牌置于牌堆顶`,
      }, { sourceId: ownerId })
      host.askSkill({
        skillId: MIEJI, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【灭计】：选择一名有手牌的其他角色',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const hasTrick = target.zones.hand.some((cardId) => host.state.cards[cardId]?.category === 'trick')
      const hasTwoNonTrick = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== 'trick').length >= 2
      // 发问期间牌可能已经变化：两项都凑不出来就不弹一个零选项的请求
      if (!hasTrick && !hasTwoNonTrick) return
      host.askSkill({
        skillId: MIEJI, ownerId, step: 'choice', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId!,
          prompt: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【灭计】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            ...(hasTrick ? [{ id: 'trick', label: '弃置一张锦囊牌' }] : []),
            ...(hasTwoNonTrick ? [{ id: 'nontrick', label: '依次弃置两张非锦囊牌' }] : []),
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'trick') {
        host.askSkill({
          skillId: MIEJI, ownerId, step: 'discard', data: { targetId, filter: 'trick' },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【灭计】：弃置一张锦囊牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'trick'),
            hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
      } else if (optionId === 'nontrick') {
        host.askSkill({
          skillId: MIEJI, ownerId, step: 'discard', data: { targetId, filter: 'nontrick' },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: '【灭计】：依次弃置两张非锦囊牌',
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== 'trick'),
            hiddenCardSlots: [], min: 2, max: 2,
          }),
        })
      }
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const filter = resolution.data.filter as 'trick' | 'nontrick'
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => target.zones.hand.includes(cardId)
          && (filter === 'trick' ? host.state.cards[cardId]?.category === 'trick' : host.state.cards[cardId]?.category !== 'trick'))
      const expected = filter === 'trick' ? 1 : 2
      if (cardIds.length !== expected) return
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: MIEJI }, { targetId, cardIds })
    }
  },
})

// ─────────────────────────────── 焚城 ───────────────────────────────

function discardableCountOf(state: SanguoshaState, playerId: PlayerId): number {
  const player = playerOf(state, playerId)
  if (!player?.alive) return 0
  return player.zones.hand.length + Object.values(player.zones.equipment).filter((cardId) => cardId).length
}

registerSkillRuntime({
  id: FENCHENG,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FENCHENG)) return []
    const queue = aliveOrderFromCurrent(state).filter((id: PlayerId) => id !== ownerId)
    if (queue.length === 0) return []
    return [{ id: FENCHENG_ACTION, label: '焚城：令所有其他角色依次弃牌或受到火焰伤害' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== FENCHENG_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(FENCHENG)) return
    const queue = aliveOrderFromCurrent(host.state).filter((id: PlayerId) => id !== ownerId)
    if (queue.length === 0) return
    owner.usedLimitedSkills.push(FENCHENG)
    host.dispatch('SkillActivated', {
      skillId: FENCHENG, skillName: '焚城', playerId: ownerId,
      logText: `${owner.nickname}发动【焚城】`,
    }, { sourceId: ownerId })
    askFenchengStep(host, ownerId, queue, 0, 0)
  },

  resume(host, ownerId, resolution, response) {
    const queue = resolution.data.queue as PlayerId[]
    const index = resolution.data.index as number
    const lastDiscardCount = resolution.data.lastDiscardCount as number

    if (resolution.step === 'choice') {
      const targetId = queue[index]
      const target = playerOf(host.state, targetId)
      const x = lastDiscardCount + 1
      const optionId = (response.payload as { optionId?: string }).optionId
      if (target?.alive && optionId === 'discard') {
        const pool = [...target.zones.hand, ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))]
        host.askSkill({
          skillId: FENCHENG, ownerId, step: 'discard-pick', data: { queue, index, lastDiscardCount },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: `【焚城】：弃置至少 ${x} 张牌`,
            timeoutMs: 25_000, optional: false, purpose: 'skill',
            cardIds: pool, hiddenCardSlots: [], min: x, max: pool.length,
          }),
        })
        return
      }
      // 选择受到伤害（或选项非法/目标已不在）
      if (target?.alive) {
        resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'fire', cardName: null })
      }
      continueFencheng(host, ownerId, queue, index + 1, 0)
      return
    }

    if (resolution.step === 'discard-pick') {
      const targetId = queue[index]
      const target = playerOf(host.state, targetId)
      const x = lastDiscardCount + 1
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => target?.zones.hand.includes(cardId)
          || Object.values(target?.zones.equipment ?? {}).includes(cardId))
      if (!target?.alive || cardIds.length < x) {
        if (target?.alive) resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'fire', cardName: null })
        continueFencheng(host, ownerId, queue, index + 1, 0)
        return
      }
      for (const cardId of cardIds) {
        const fromHand = target.zones.hand.includes(cardId)
        moveCard(host.state, cardId, fromHand ? { kind: 'hand', playerId: targetId } : { kind: 'equipment', playerId: targetId, slot: equipmentSlotOf(target, cardId) }, { kind: 'discardPile' })
      }
      host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: FENCHENG }, { targetId, cardIds })
      continueFencheng(host, ownerId, queue, index + 1, cardIds.length)
    }
  },

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'continue') return
    const { queue, index, lastDiscardCount } = prompt.data as { queue: PlayerId[]; index: number; lastDiscardCount: number }
    askFenchengStep(host, ownerId, queue, index, lastDiscardCount)
  },
})

/**
 * 焚城下一步的统一入口。
 *
 * 受到火焰伤害可能把目标打进濒死，濒死求桃是另一套独立的请求/响应流程，
 * 不能在同一次 `resume` 里接着往下问——那时候 `state.dying` 还没清干净，
 * `resolveDamage` 会直接拒绝。**没有触发濒死才当场继续**；触发了就
 * `queueSkill` 排队，等牌局回到干净状态（濒死结束）后由 `startQueued` 接力。
 */
function continueFencheng(host: SkillHost, ownerId: PlayerId, queue: PlayerId[], index: number, lastDiscardCount: number): void {
  if (host.state.dying || host.state.damageChain) {
    host.queueSkill({ skillId: FENCHENG, ownerId, step: 'continue', data: { queue, index, lastDiscardCount } })
    return
  }
  askFenchengStep(host, ownerId, queue, index, lastDiscardCount)
}

function equipmentSlotOf(player: { zones: { equipment: Record<EquipmentSlot, CardId | null> } }, cardId: CardId): EquipmentSlot {
  const entry = (Object.entries(player.zones.equipment) as Array<[EquipmentSlot, CardId | null]>).find(([, id]) => id === cardId)
  return entry![0]
}

function askFenchengStep(host: SkillHost, ownerId: PlayerId, queue: PlayerId[], index: number, lastDiscardCount: number): void {
  if (index >= queue.length) return
  const targetId = queue[index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive) {
    continueFencheng(host, ownerId, queue, index + 1, lastDiscardCount)
    return
  }
  const x = lastDiscardCount + 1
  const canDiscard = discardableCountOf(host.state, targetId) >= x
  if (!canDiscard) {
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'fire', cardName: null })
    continueFencheng(host, ownerId, queue, index + 1, 0)
    return
  }
  host.askSkill({
    skillId: FENCHENG, ownerId, step: 'choice', data: { queue, index, lastDiscardCount },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: targetId,
      prompt: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【焚城】：选择一项`,
      timeoutMs: 25_000, optional: false,
      options: [
        { id: 'discard', label: `弃置至少 ${x} 张牌` },
        { id: 'damage', label: '受到 2 点火焰伤害' },
      ],
    }),
  })
}

export const LIRU: CharacterDefinition = {
  id: 'liru',
  name: '李儒',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2013',
  skills: [
    {
      id: JUECE,
      name: '绝策',
      description: '结束阶段，李儒可以选择一名没有手牌的其他角色，对其造成 1 点伤害。',
    },
    {
      id: MIEJI,
      name: '灭计',
      description: '出牌阶段限一次，李儒将一张黑色锦囊牌置于牌堆顶，然后选择一名有手牌的其他角色，其选择：弃置一张锦囊牌，或依次弃置两张非锦囊牌。',
    },
    {
      id: FENCHENG,
      name: '焚城',
      description: '限定技，出牌阶段，李儒可以发动：按存活座次，令所有其他角色依次选择：弃置至少 X 张牌，或受到李儒造成的 2 点火焰伤害（X 为其上家在本次焚城中因此弃置的牌数 + 1，第一名目标 X = 1）。',
    },
  ],
}
