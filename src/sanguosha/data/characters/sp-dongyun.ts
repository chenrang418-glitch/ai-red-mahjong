import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 董允（三国杀 OL 经典身份 SP）。
 *
 * 【秉正】：出牌阶段结束时，董允可以选择一名手牌数不等于体力值的角色：
 *          手牌数大于体力值则弃置一张手牌，小于则摸一张牌；调整后若该角色
 *          手牌数等于体力值，董允摸一张牌，然后可以交给该角色一张牌。
 * 【舍宴】：当董允成为一张普通锦囊牌的目标时，可以选择一项：令这张牌增加
 *          一个合法目标；或令这张牌对其中一个当前目标无效（结算后必须
 *          仍至少有一个有效目标）。
 *
 * 最容易做错的：**舍宴只改这张牌的目标集合，不取消整张 CardUse**——加目标
 * 直接 push 进 `resolution.targetIds`（结算循环按下标动态读取，天然会
 * 处理到新加的这个）；减目标复用 `cancelledTargetIds`（南蛮/万箭同款），
 * 减之前必须保证减完还剩至少一个未被取消的目标。
 */

const BINGZHENG = 'bingzheng'
const SHEYAN = 'sheyan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function bingzhengTargets(state: SanguoshaState): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length !== candidate.hp).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: BINGZHENG,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = bingzhengTargets(host.state)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: BINGZHENG, ownerId, step: 'ask', data: { candidateIds } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: BINGZHENG, ownerId, step: 'target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【秉正】：选择一名手牌数不等于体力值的角色', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.dispatch('SkillActivated', {
        skillId: BINGZHENG, skillName: '秉正', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【秉正】，目标${target.nickname}`,
      }, { sourceId: ownerId, targetId })
      if (target.zones.hand.length > target.hp) {
        host.askSkill({
          skillId: BINGZHENG, ownerId, step: 'target-discard', data: { targetId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId!,
            prompt: '【秉正】：弃置一张手牌', timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      drawCards(host.state, host.rng, targetId!, 1, (name, payload) => { host.dispatch(name, payload) })
      afterBingzhengAdjust(host, ownerId, targetId!)
      return
    }

    if (resolution.step === 'target-discard') {
      const targetId = resolution.data.targetId as PlayerId
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (target?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: BINGZHENG }, { targetId, cardIds: [cardId] })
      }
      afterBingzhengAdjust(host, ownerId, targetId)
      return
    }

    if (resolution.step === 'give') {
      const targetId = resolution.data.targetId as PlayerId
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !target?.alive || !cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: BINGZHENG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    }
  },
})

function afterBingzhengAdjust(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive || target.zones.hand.length !== target.hp) return
  drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  if (owner.zones.hand.length === 0) return
  host.askSkill({
    skillId: BINGZHENG, ownerId, step: 'give', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【秉正】：可以交给${target.nickname}一张牌`, timeoutMs: 20_000, optional: true, purpose: 'skill',
      cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 0, max: 1,
    }),
  })
}

registerSkillRuntime({
  id: SHEYAN,
  interceptTarget(host, ownerId, context) {
    /*
     * 只认「普通/非延时锦囊」：延时锦囊（乐不思蜀/兵粮寸断/闪电）排除；
     * 【借刀杀人】虽然也是 category 'trick'，但它的目标语义是「借刀者→
     * 被借者→再选一个攻击目标」的特殊结构，不是「一组目标各自结算」，
     * 硬加/减目标会破坏它自己的流程（压测复现：seed=bisect-dongyun-0），
     * 一并排除。
     */
    if (context.category !== 'trick' || DELAYED_TRICKS.has(context.cardName) || context.cardName === '借刀杀人') return false
    const resolution = host.state.cardResolution
    if (!resolution || resolution.kind !== 'trick') return false
    host.askSkill({
      skillId: SHEYAN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `你成为【${context.cardName}】的目标，是否发动【舍宴】？`,
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'add', label: '令这张牌增加一个合法目标' },
          { id: 'cancel', label: '令这张牌对其中一个当前目标无效' },
          { id: 'none', label: '不发动' },
        ],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    const current = host.state.cardResolution
    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'add' && optionId !== 'cancel') { host.resumeCardTarget(); return }
      if (!current || current.kind !== 'trick') { host.resumeCardTarget(); return }
      if (optionId === 'add') {
        const candidateIds = host.state.players
          .filter((candidate) => candidate.alive && !current.targetIds.includes(candidate.id))
          .map((candidate) => candidate.id)
        if (candidateIds.length === 0) { host.resumeCardTarget(); return }
        host.askSkill({
          skillId: SHEYAN, ownerId, step: 'add-target',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【舍宴】：选择一个新目标', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
          }),
        })
        return
      }
      // cancel：只能取消「取消完之后仍至少剩一个」的目标
      const remaining = current.targetIds.filter((id) => !current.cancelledTargetIds.includes(id))
      const candidateIds = remaining.length > 1 ? remaining : []
      if (candidateIds.length === 0) { host.resumeCardTarget(); return }
      host.askSkill({
        skillId: SHEYAN, ownerId, step: 'cancel-target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【舍宴】：选择一个当前目标令其无效', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'add-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && current?.kind === 'trick' && !current.targetIds.includes(targetId)) {
        current.targetIds.push(targetId)
        host.dispatch('SkillActivated', {
          skillId: SHEYAN, skillName: '舍宴', playerId: ownerId, targetId,
          logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【舍宴】，增加目标`,
        }, { sourceId: ownerId, targetId })
      }
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'cancel-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && current?.kind === 'trick' && !current.cancelledTargetIds.includes(targetId)) {
        current.cancelledTargetIds.push(targetId)
        host.dispatch('SkillActivated', {
          skillId: SHEYAN, skillName: '舍宴', playerId: ownerId, targetId,
          logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【舍宴】，取消目标`,
        }, { sourceId: ownerId, targetId })
      }
      host.resumeCardTarget()
    }
  },
})

export const DONGYUN: CharacterDefinition = {
  id: 'dongyun',
  name: '董允',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: BINGZHENG,
      name: '秉正',
      description: '出牌阶段结束时，董允可以选择一名手牌数不等于体力值的角色：手牌数大于体力值则弃置一张手牌，小于则摸一张牌；调整后若该角色手牌数等于体力值，董允摸一张牌，然后可以交给该角色一张牌。',
    },
    {
      id: SHEYAN,
      name: '舍宴',
      description: '当董允成为一张普通锦囊牌的目标时，可以选择一项：令这张牌增加一个合法目标；或令这张牌对其中一个当前目标无效（结算后必须仍至少有一个有效目标）。',
    },
  ],
}
