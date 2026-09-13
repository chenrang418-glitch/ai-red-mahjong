import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { resolveDamage } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 卢氏（三国杀 OL 经典身份 SP）。
 *
 * 【驻颜】：结束阶段，选择一名角色，将其体力值或手牌数调整为其上个准备
 *          阶段（无历史则游戏开始）时的状态；每名角色的HP/手牌各限一次。
 * 【雷劫】：准备阶段，选择一名角色进行判定，黑桃2~9则对其造成2点雷电
 *          伤害，否则其摸2张牌。
 */

const ZHUYAN = 'zhuyan'
const LEIJIE = 'leijie'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function snapshotOf(state: SanguoshaState, playerId: PlayerId): { hp: number; hand: number } | undefined {
  return state.lushiSnapshots?.[playerId] ?? state.lushiGameStartSnapshots?.[playerId]
}

registerSkillRuntime({
  id: ZHUYAN,
  onGameStart(host) {
    host.state.lushiGameStartSnapshots = {}
    for (const player of host.state.players) {
      host.state.lushiGameStartSnapshots[player.id] = { hp: player.hp, hand: player.zones.hand.length }
    }
  },
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'prepare' || !payload.playerId) return
        const player = playerOf(host.state, payload.playerId)
        if (!player?.alive) return
        host.state.lushiSnapshots ??= {}
        host.state.lushiSnapshots[payload.playerId] = { hp: player.hp, hand: player.zones.hand.length }
        void ownerId
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => {
          if (!candidate.alive) return false
          const used = host.state.lushiUsed?.[candidate.id]
          return !used?.hp || !used?.hand
        }).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: ZHUYAN, ownerId, step: 'pick-target', data: { candidateIds } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: ZHUYAN, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【驻颜】：选择一名角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const used = host.state.lushiUsed?.[targetId]
      const options: Array<{ id: string; label: string }> = []
      if (!used?.hp) options.push({ id: 'hp', label: '调整体力值' })
      if (!used?.hand) options.push({ id: 'hand', label: '调整手牌数' })
      if (options.length === 0) return
      host.askSkill({
        skillId: ZHUYAN, ownerId, step: 'pick-type', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【驻颜】：选择调整的项目', timeoutMs: 20_000, optional: false, options,
        }),
      })
      return
    }

    if (resolution.step === 'pick-type') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const type = (response.payload as { optionId?: string }).optionId
      const snapshot = snapshotOf(host.state, targetId)
      if (!target?.alive || (type !== 'hp' && type !== 'hand') || !snapshot) return
      host.state.lushiUsed ??= {}
      host.state.lushiUsed[targetId] ??= {}
      host.dispatch('SkillActivated', { skillId: ZHUYAN, skillName: '驻颜', playerId: ownerId, logText: `${owner.nickname}发动【驻颜】` }, { sourceId: ownerId, targetId })
      if (type === 'hp') {
        host.state.lushiUsed[targetId].hp = true
        if (target.hp < snapshot.hp) recover(host as never, targetId, snapshot.hp - target.hp, ownerId)
        else if (target.hp > snapshot.hp) loseHp(host as never, targetId, target.hp - snapshot.hp, ZHUYAN)
        return
      }
      host.state.lushiUsed[targetId].hand = true
      if (target.zones.hand.length < snapshot.hand) {
        const n = Math.min(snapshot.hand, 5) - target.zones.hand.length
        if (n > 0) drawCards(host.state, host.rng, targetId, n, (name, payload) => { host.dispatch(name, payload) })
      } else if (target.zones.hand.length > snapshot.hand) {
        const discardIds: CardId[] = []
        const pool = [...target.zones.hand]
        while (pool.length > snapshot.hand) {
          const [cardId] = pool.splice(host.rng.nextInt(pool.length), 1)
          discardIds.push(cardId)
        }
        for (const cardId of discardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
        if (discardIds.length > 0) host.dispatch('LoseCard', { playerId: targetId, cardIds: discardIds, reason: ZHUYAN }, { sourceId: ownerId, targetId, cardIds: discardIds })
      }
    }
  },
})

registerSkillRuntime({
  id: LEIJIE,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: LEIJIE, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: LEIJIE, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【雷劫】：选择一名角色进行判定', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !targetId || !playerOf(host.state, targetId)?.alive) return
    host.dispatch('SkillActivated', { skillId: LEIJIE, skillName: '雷劫', playerId: ownerId, logText: `${owner.nickname}发动【雷劫】` }, { sourceId: ownerId, targetId })
    performJudgment(host, targetId, LEIJIE, { tag: LEIJIE, data: { ownerId, targetId } })
  },
})

registerJudgmentContinuation(LEIJIE, (host, judged, data) => {
  const { ownerId, targetId } = data as { ownerId: PlayerId; targetId: PlayerId }
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const isSpade29 = judged.suit === 'spade' && judged.rank >= 2 && judged.rank <= 9
  if (isSpade29) {
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 2, nature: 'thunder', cardName: null })
    return
  }
  drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
})

export const LUSHI: CharacterDefinition = {
  id: 'lushi',
  name: '卢氏',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZHUYAN, name: '驻颜', description: '结束阶段，选择一名角色，将其体力值或手牌数调整为其上个准备阶段（无历史则游戏开始）时的状态；每名角色的体力值/手牌数各限一次。' },
    { id: LEIJIE, name: '雷劫', description: '准备阶段，选择一名角色进行判定，黑桃2~9则对其造成2点雷电伤害，否则其摸2张牌。' },
  ],
}
