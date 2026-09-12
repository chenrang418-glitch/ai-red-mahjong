import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郝昭（三国杀 OL 经典身份 SP）。
 *
 * 【镇骨】：结束阶段，郝昭可以选择一名其他角色：当前回合真正结束时，该角色
 *          将手牌数调整至与郝昭当前手牌数相同（多弃少摸，摸牌最多摸至 5
 *          张）；该角色下一次回合真正结束时，再执行一次同样的调整。
 *
 * 最容易做错的：**两次调整都动态读取「执行那一刻」郝昭的手牌数**，不是
 * 记一个固定值 N 用两次；跨两个回合的等待状态存进 `state.pendingZhengu`
 * （新增字段），按目标 `playerId` 记，郝昭死亡也不主动清空——技能已经
 * 结算出去的持续效果按项目「产生的效果不因来源消失而中止」的既有口径处理。
 */

const ZHENGU = 'zhengu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function adjustHand(host: SkillHost, haozhaoId: PlayerId, targetId: PlayerId): void {
  const haozhao = playerOf(host.state, haozhaoId)
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  const n = haozhao?.alive ? haozhao.zones.hand.length : 0
  if (target.zones.hand.length > n) {
    const diff = target.zones.hand.length - n
    const cardIds = target.zones.hand.slice(0, diff)
    for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: ZHENGU }, { targetId, cardIds })
    host.dispatch('SkillActivated', {
      skillId: ZHENGU, skillName: '镇骨', playerId: haozhaoId, targetId,
      logText: `【镇骨】结算：${target.nickname}弃置 ${diff} 张手牌`,
    }, { sourceId: haozhaoId, targetId })
  } else if (target.zones.hand.length < n) {
    const drawTo = Math.min(5, n)
    const need = drawTo - target.zones.hand.length
    if (need > 0) {
      host.dispatch('SkillActivated', {
        skillId: ZHENGU, skillName: '镇骨', playerId: haozhaoId, targetId,
        logText: `【镇骨】结算：${target.nickname}摸 ${need} 张牌`,
      }, { sourceId: haozhaoId, targetId })
      drawCards(host.state, host.rng, targetId, need, (name, payload) => { host.dispatch(name, payload) })
    }
  }
}

registerSkillRuntime({
  id: ZHENGU,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: ZHENGU, ownerId, step: 'ask', data: { candidateIds } })
    },
  }, {
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      const endedPlayerId = payload.playerId
      const pendings = host.state.pendingZhengu
      if (!pendings || !endedPlayerId) return
      /*
       * 触发跑的是郝昭这一份技能实例，`ownerId` 恒等于郝昭；真正「回合结束
       * 的是谁」要看事件本身的 `playerId`，不能拿 `ownerId` 去比对——
       * 第二段调整结束的是目标的回合，不是郝昭的回合。
       */
      for (const [targetId, entry] of Object.entries(pendings)) {
        if (entry.haozhaoId !== ownerId) continue
        if (entry.stage === 'first' && endedPlayerId === entry.haozhaoId) {
          adjustHand(host, entry.haozhaoId, targetId)
          pendings[targetId] = { haozhaoId: entry.haozhaoId, stage: 'second' }
        } else if (entry.stage === 'second' && endedPlayerId === targetId) {
          adjustHand(host, entry.haozhaoId, targetId)
          delete pendings[targetId]
        }
      }
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: ZHENGU, ownerId, step: 'ask', data: { candidateIds },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【镇骨】：选择一名其他角色？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【镇骨】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const { candidateIds } = resolution.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: ZHENGU, ownerId, step: 'pick',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【镇骨】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      host.state.pendingZhengu ??= {}
      host.state.pendingZhengu[targetId!] = { haozhaoId: ownerId, stage: 'first' }
      host.dispatch('SkillActivated', {
        skillId: ZHENGU, skillName: '镇骨', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【镇骨】，选择${target.nickname}`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

export const HAOZHAO: CharacterDefinition = {
  id: 'haozhao',
  name: '郝昭',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: ZHENGU,
      name: '镇骨',
      description: '结束阶段，郝昭可以选择一名其他角色：当前回合真正结束时，该角色将手牌数调整至与郝昭当前手牌数相同（多弃少摸，摸牌最多摸至 5 张）；该角色下一次回合真正结束时，再执行一次同样的调整。',
    },
  ],
}
