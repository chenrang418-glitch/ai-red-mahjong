import { giveCards } from '../../engine/hand-transfer'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孙乾（三国杀 OL 经典身份 SP）。
 *
 * 【谦雅】：孙乾成为一张锦囊牌的目标后，可以将至少1张手牌交给一名其他
 *          角色（多目标锦囊只对孙乾这个 target 触发一次）。
 * 【说盟】：出牌阶段结束时，可以与一名角色拼点：赢了视为孙乾使用一张
 *          【无中生有】；没赢（含平局）则被拼点角色视为对孙乾使用一张
 *          【过河拆桥】。两张都走虚拟锦囊，不生成实体 Card ID。
 */

const QIANYA = 'qianya'
const SHUOMENG = 'shuomeng'
const SHUOMENG_TAG = 'shuomeng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QIANYA,
  triggers: [{
    event: 'TargetConfirmed',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      if (context.event.targetId !== ownerId || !payload.cardId) return
      if (host.state.cards[payload.cardId]?.category !== 'trick') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: QIANYA, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: QIANYA, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【谦雅】：可以选择一名其他角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: QIANYA, ownerId, step: 'give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【谦雅】：交给至少1张手牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: owner.zones.hand.length,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      if (valid.length === 0 || !playerOf(host.state, targetId)?.alive) return
      giveCards(host as never, ownerId, targetId, valid, QIANYA)
      host.dispatch('SkillActivated', { skillId: QIANYA, skillName: '谦雅', playerId: ownerId, targetId, logText: `${owner.nickname}发动【谦雅】` }, { sourceId: ownerId, targetId })
    }
  },
})

registerPindianContinuation(SHUOMENG_TAG, (host, result) => {
  const { initiatorId, opponentId, outcome } = result
  if (outcome === 'initiator-win') {
    if (!playerOf(host.state, initiatorId)?.alive) return
    const cardId = createVirtualTrick(host.state, initiatorId, '无中生有', SHUOMENG)
    executeUseCardAction(host as never, initiatorId, {
      kind: 'use-card', id: `shuomeng-wzsy:${cardId}`, playerId: initiatorId,
      cardIds: [cardId], targetIds: [], targetMin: 0, targetMax: 0,
      asCardName: '无中生有', label: '视为使用【无中生有】',
    })
    return
  }
  if (!playerOf(host.state, opponentId)?.alive || !playerOf(host.state, initiatorId)?.alive) return
  const cardId = createVirtualTrick(host.state, opponentId, '过河拆桥', SHUOMENG)
  executeUseCardAction(host as never, opponentId, {
    kind: 'use-card', id: `shuomeng-ghcq:${cardId}`, playerId: opponentId,
    cardIds: [cardId], targetIds: [initiatorId], targetMin: 1, targetMax: 1,
    asCardName: '过河拆桥', label: '视为使用【过河拆桥】',
  })
})

registerSkillRuntime({
  id: SHUOMENG,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      if (!canPindian(host.state, ownerId)) return
      const candidateIds = host.state.players.filter((candidate) => candidate.id !== ownerId && canPindian(host.state, candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: SHUOMENG, ownerId, step: 'target', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'target') return
    if (!canPindian(host.state, ownerId)) return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    const alive = candidateIds.filter((id) => canPindian(host.state, id))
    if (alive.length === 0) return
    host.askSkill({
      skillId: SHUOMENG, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【说盟】：可以选择一名角色拼点', timeoutMs: 20_000, optional: true, candidateIds: alive, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !canPindian(host.state, ownerId) || !canPindian(host.state, targetId)) return
    startPindian(host as never, {
      id: `shuomeng-${host.state.seq}`, initiatorId: ownerId, opponentId: targetId,
      reason: '说盟', continuationTag: SHUOMENG_TAG,
    })
  },
})

export const SUNQIAN: CharacterDefinition = {
  id: 'sunqian',
  name: '孙乾',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: QIANYA, name: '谦雅', description: '孙乾成为一张锦囊牌的目标后，可以将至少1张手牌交给一名其他角色。' },
    { id: SHUOMENG, name: '说盟', description: '出牌阶段结束时，可以与一名角色拼点：赢了视为使用一张【无中生有】；没赢（含平局）则被拼点角色视为对孙乾使用一张【过河拆桥】。' },
  ],
}
