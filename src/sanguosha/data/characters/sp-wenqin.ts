import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { canTarget } from '../../engine/distance'
import { executeUseCardAction } from '../../engine/cards/basic'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 文钦（三国杀 OL 经典身份 SP）。
 *
 * 【犷骜】：文钦使用【杀】可以额外指定1个合法目标；其他角色使用【杀】
 *          在文钦是合法目标时，可以额外将文钦指定为目标；一张【杀】进入
 *          目标阶段后，若文钦当前手牌数为偶数，可以摸1张牌，然后令这张
 *          杀的一名目标本次无效。
 * 【彗企】（觉醒）：每个 TurnInstance 结束后，若本回合曾成为过牌目标的
 *          不同角色恰好3人且含文钦本人，未觉醒则回复1点体力并获得【偕举】。
 *          （引擎觉醒钩子只在拥有者自己的阶段检查，这里检查的是"最近一个
 *          已结束的回合"的快照，等到文钦下一次准备阶段才真正判定。）
 * 【偕举】：出牌阶段限一次，可选择任意"本回合曾成为过牌目标"的角色，按
 *          座次依次可将1张黑色牌当【杀】使用。
 */

const KUANGAO = 'kuangao'
const HUIQI = 'huiqi'
const XIEJU = 'xieju'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: KUANGAO,
  extraSlashTargets(state, ownerId) {
    return state.currentPlayerId === ownerId ? 1 : 0
  },
  interceptBystanderTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.sourceId === ownerId || context.targetId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !canTarget(host.state, context.sourceId, ownerId)) return false
    const resolution = host.state.cardResolution
    if (resolution?.kind !== 'slash' || resolution.remainingTargetIds.includes(ownerId)) return false
    host.askSkill({
      skillId: KUANGAO, ownerId, step: 'join-ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【犷骜】：是否额外成为这张杀的目标？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '加入' }, { id: 'no', label: '不加入' }],
      }),
    })
    return true
  },
  triggers: [{
    event: 'TargetSpecified',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
      if (payload.cardName !== '杀' || !payload.targetIds?.length) return
      const roundNumber = host.state.turnNumber
      host.state.wenqinTurnTargets ??= { turnNumber: roundNumber, ids: [] }
      if (host.state.wenqinTurnTargets.turnNumber !== roundNumber) host.state.wenqinTurnTargets = { turnNumber: roundNumber, ids: [] }
      for (const id of payload.targetIds) if (!host.state.wenqinTurnTargets.ids.includes(id)) host.state.wenqinTurnTargets.ids.push(id)

      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.zones.hand.length % 2 !== 0) return
      if (owner.marks['kuangao-seen'] === context.event.seq) return
      owner.marks['kuangao-seen'] = context.event.seq
      host.queueSkill({ skillId: KUANGAO, ownerId, step: 'invalidate-ask', data: { targetIds: payload.targetIds } })
    },
  }, {
    event: 'TurnEnd',
    handle(host) {
      const current = host.state.wenqinTurnTargets
      if (current) host.state.wenqinLastTurnTargets = current
      host.state.wenqinTurnTargets = undefined
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'invalidate-ask') return
    const { targetIds } = prompt.data as { targetIds: PlayerId[] }
    host.askSkill({
      skillId: KUANGAO, ownerId, step: 'invalidate', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【犷骜】：是否摸1张牌，然后令一名目标本次无效？', timeoutMs: 20_000, optional: true,
        options: [...targetIds.map((id) => ({ id, label: `令${playerOf(host.state, id)?.nickname ?? id}无效` })), { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'join-ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const current = host.state.cardResolution
      if (optionId === 'yes' && current?.kind === 'slash') current.remainingTargetIds.push(ownerId)
      host.resumeCardTarget()
      return
    }
    if (resolution.step === 'invalidate') {
      const victimId = (response.payload as { optionId?: string }).optionId
      if (!victimId || victimId === 'none') return
      const victim = playerOf(host.state, victimId)
      if (!victim?.alive) return
      drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
      host.dispatch('SkillActivated', { skillId: KUANGAO, skillName: '犷骜', playerId: ownerId, logText: `${owner.nickname}发动【犷骜】，令${victim.nickname}本次无效` }, { sourceId: ownerId, targetId: victimId })
      const current = host.state.cardResolution
      if (current?.kind === 'slash' && current.targetId === victimId) current.targetCancelled = true
      else if (current?.kind === 'slash') {
        const index = current.remainingTargetIds.indexOf(victimId)
        if (index >= 0) current.remainingTargetIds.splice(index, 1)
      }
    }
  },
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const snapshot = state.wenqinLastTurnTargets
      return !!snapshot && snapshot.ids.length === 3 && snapshot.ids.includes(ownerId)
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      recover(host as never, ownerId, 1, ownerId)
      grantSkill(host.state, ownerId, XIEJU)
      host.dispatch('SkillActivated', { skillId: HUIQI, skillName: '彗企', playerId: ownerId, logText: `${owner.nickname}觉醒，获得【偕举】` }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: XIEJU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIEJU)) return []
    const targets = state.wenqinLastTurnTargets
    if (!targets || targets.ids.length === 0) return []
    return [{ id: XIEJU, label: '偕举：本回合曾成为目标的角色可将黑色牌当杀使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== XIEJU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(XIEJU)) return
    const targets = host.state.wenqinLastTurnTargets
    const candidateIds = (targets?.ids ?? []).filter((id) => playerOf(host.state, id)?.alive)
    if (candidateIds.length === 0) return
    owner.turnUsedSkills.push(XIEJU)
    host.dispatch('SkillActivated', { skillId: XIEJU, skillName: '偕举', playerId: ownerId, logText: `${owner.nickname}发动【偕举】` }, { sourceId: ownerId })
    host.askSkill({
      skillId: XIEJU, ownerId, step: 'pick-players', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【偕举】：选择可以将黑色牌当杀使用的角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: candidateIds.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick-players') {
      const queue = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
        .slice().sort((a, b) => (playerOf(host.state, a)?.seat ?? 0) - (playerOf(host.state, b)?.seat ?? 0))
      advanceXieju(host, ownerId, queue, 0)
      return
    }
    if (resolution.step === 'use-pick') {
      const { queue, index, playerId } = resolution.data as { queue: PlayerId[]; index: number; playerId: PlayerId }
      const player = playerOf(host.state, playerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!player?.alive || !cardId || !player.zones.hand.includes(cardId)) { advanceXieju(host, ownerId, queue, index + 1); return }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== playerId && canTarget(host.state, playerId, candidate.id)).map((candidate) => candidate.id)
      if (candidateIds.length === 0) { advanceXieju(host, ownerId, queue, index + 1); return }
      host.askSkill({
        skillId: XIEJU, ownerId, step: 'use-target', data: { queue, index, playerId, cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId, prompt: '【偕举】：选择【杀】的目标',
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'use-target') {
      const { queue, index, playerId, cardId } = resolution.data as { queue: PlayerId[]; index: number; playerId: PlayerId; cardId: CardId }
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const player = playerOf(host.state, playerId)
      if (victimId && player?.alive && player.zones.hand.includes(cardId)) {
        executeUseCardAction(host as never, playerId, {
          kind: 'use-card', id: `xieju:${cardId}`, playerId, cardIds: [cardId], targetIds: [victimId],
          targetMin: 1, targetMax: 1, asCardName: '杀', label: '【偕举】：当【杀】使用',
        })
      }
      advanceXieju(host, ownerId, queue, index + 1)
    }
  },
})

function advanceXieju(host: SkillHost, ownerId: PlayerId, queue: PlayerId[], index: number): void {
  if (index >= queue.length) return
  const playerId = queue[index]
  const player = playerOf(host.state, playerId)
  const blacks = player?.alive ? player.zones.hand.filter((id) => host.state.cards[id]?.color === 'black') : []
  if (blacks.length === 0) { advanceXieju(host, ownerId, queue, index + 1); return }
  host.askSkill({
    skillId: XIEJU, ownerId, step: 'use-pick', data: { queue, index, playerId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId, prompt: '【偕举】：可以将1张黑色牌当【杀】使用',
      timeoutMs: 20_000, optional: true, purpose: 'skill', cardIds: blacks, hiddenCardSlots: [], min: 0, max: 1,
    }),
  })
}

export const WENQIN: CharacterDefinition = {
  id: 'wenqin',
  name: '文钦',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: KUANGAO, name: '犷骜', description: '你使用【杀】可以额外指定1个合法目标；其他角色使用【杀】时你若是合法目标，可以额外成为目标；一张【杀】进入目标阶段后，若你当前手牌数为偶数，可以摸1张牌，然后令这张杀的一名目标本次无效。' },
    { id: HUIQI, name: '彗企', description: '觉醒技，每个 TurnInstance 结束后，若本回合曾成为过牌目标的不同角色恰好3人且含你本人，你回复1点体力并获得【偕举】。' },
  ],
}
