import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { fieldCards } from '../../engine/field-move'
import { lockCardId } from '../../engine/card-play-lock'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 薛综（三国杀 OL 经典身份 SP）。
 *
 * 【复难】：其他角色使用/打出牌以响应薛综使用的牌后，薛综可以令其获得
 *          薛综刚使用的实体牌（本回合不能用/打出这具体一张），然后薛综
 *          获得其响应的实体牌（诫训强化后：直接获得对方响应牌，不再需要
 *          先给出使用牌）。
 * 【诫训】：结束阶段，选择一名角色，D为场上（装备区+判定区）方块牌数量，
 *          其摸D张，然后弃置X张（X为诫训此前已发动次数）；若因此弃光了
 *          自己所有的牌，薛综永久失去诫训，并强化复难。
 */

const FUNAN = 'funan'
const JIEXUN = 'jiexun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function locateCardNow(state: SanguoshaState, cardId: CardId): { kind: 'discardPile' } | { kind: 'hand'; playerId: PlayerId } | null {
  if (state.zones.discardPile.includes(cardId)) return { kind: 'discardPile' }
  for (const player of state.players) {
    if (player.zones.hand.includes(cardId)) return { kind: 'hand', playerId: player.id }
  }
  return null
}

registerSkillRuntime({
  id: FUNAN,
  triggers: [
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        if (host.state.cardResolution?.sourceId !== ownerId) return
        const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
        if (!payload.playerId || !payload.cardId || payload.playerId === ownerId) return
        if (host.state.xuezongPending?.ownerId === ownerId) return
        host.state.xuezongPending = { ownerId, mainCardId: host.state.cardResolution.cardId, responderId: payload.playerId, responseCardId: payload.cardId }
      },
    },
    {
      // 复难锁住的具体 CardId 只到本回合结束——按技能+来源过滤着清，
      // 不用 clearCardIdLocksOf（那个会把同一个人身上别的锁也一起清掉）。
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        if (!host.state.cardIdLocks) return
        host.state.cardIdLocks = host.state.cardIdLocks.filter((entry) => !(entry.skillId === FUNAN && entry.sourceId === ownerId))
        if (host.state.cardIdLocks.length === 0) delete host.state.cardIdLocks
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const pending = host.state.xuezongPending
        if (!pending || pending.ownerId !== ownerId) return
        host.state.xuezongPending = undefined
        host.queueSkill({ skillId: FUNAN, ownerId, step: 'ask', data: pending })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: FUNAN, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【复难】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const { mainCardId, responderId, responseCardId } = resolution.data as { mainCardId: CardId; responderId: PlayerId; responseCardId: CardId }
    const responder = playerOf(host.state, responderId)
    if (!responder?.alive) return
    host.dispatch('SkillActivated', { skillId: FUNAN, skillName: '复难', playerId: ownerId, targetId: responderId, logText: `${owner.nickname}发动【复难】` }, { sourceId: ownerId, targetId: responderId })
    const upgraded = Boolean(owner.marks['funan-upgraded'])
    if (!upgraded) {
      const mainFrom = locateCardNow(host.state, mainCardId)
      if (mainFrom) {
        moveCard(host.state, mainCardId, mainFrom, { kind: 'hand', playerId: responderId })
        host.dispatch('GainCard', { playerId: responderId, cardIds: [mainCardId], reason: FUNAN }, { sourceId: ownerId, targetId: responderId, cardIds: [mainCardId] })
        lockCardId(host.state, { targetId: responderId, cardId: mainCardId, sourceId: ownerId, skillId: FUNAN })
      }
    }
    const responseFrom = locateCardNow(host.state, responseCardId)
    if (responseFrom) {
      moveCard(host.state, responseCardId, responseFrom, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [responseCardId], reason: FUNAN }, { sourceId: responderId, targetId: ownerId, cardIds: [responseCardId] })
    }
  },
})

registerSkillRuntime({
  id: JIEXUN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.marks['jiexun-lost']) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JIEXUN, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks['jiexun-lost']) return
    host.askSkill({
      skillId: JIEXUN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【诫训】：是否发动？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner0 = playerOf(host.state, ownerId)
    if (resolution.step === 'ask') {
      if (!owner0?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: JIEXUN, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【诫训】：选择一名角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    const d = fieldCards(host.state).filter((card) => host.state.cards[card.cardId]?.suit === 'diamond').length
    const x = owner.marks['jiexun-count'] ?? 0
    host.dispatch('SkillActivated', { skillId: JIEXUN, skillName: '诫训', playerId: ownerId, targetId, logText: `${owner.nickname}发动【诫训】，${target.nickname}摸${d}张` }, { sourceId: ownerId, targetId })
    owner.marks['jiexun-count'] = x + 1
    if (d > 0) drawCards(host.state, host.rng, targetId, d, (name, payload) => { host.dispatch(name, payload) })
    if (x <= 0) return
    const handBefore = target.zones.hand.length
    const n = Math.min(x, handBefore)
    if (n <= 0) return
    const discardIds = target.zones.hand.slice(0, n)
    for (const cardId of discardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds: discardIds, reason: JIEXUN }, { sourceId: ownerId, targetId, cardIds: discardIds })
    if (n === handBefore && target.zones.hand.length === 0) {
      owner.marks['jiexun-lost'] = 1
      owner.marks['funan-upgraded'] = 1
      host.dispatch('SkillActivated', { skillId: JIEXUN, skillName: '诫训', playerId: ownerId, logText: `${target.nickname}弃光了手牌，${owner.nickname}永久失去【诫训】，【复难】被强化` }, { sourceId: ownerId })
    }
  },
})

export const XUEZONG: CharacterDefinition = {
  id: 'xuezong',
  name: '薛综',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: FUNAN, name: '复难', description: '其他角色使用/打出牌以响应薛综使用的牌后，薛综可以令其获得薛综刚使用的实体牌（本回合不能用/打出这具体一张），然后薛综获得其响应的实体牌（诫训强化后直接获得响应牌）。' },
    { id: JIEXUN, name: '诫训', description: '结束阶段，选择一名角色，D为场上方块牌数量，其摸D张，然后弃置X张（X为诫训此前已发动次数）；若因此弃光了自己所有的牌，薛综永久失去诫训，并强化复难。' },
  ],
}
