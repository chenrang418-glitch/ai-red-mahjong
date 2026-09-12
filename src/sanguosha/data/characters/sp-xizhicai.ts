import { moveCard } from '../../engine/zones'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { drawCards } from '../../engine/draw'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 戏志才（三国杀 OL 经典身份 SP）。
 *
 * 【天妒】：戏志才的判定牌生效后，可以获得这张牌。
 * 【先辅】：锁定技，游戏开始时选择一名其他角色为先辅目标（本局固定）：该
 *          目标每受到伤害后，戏志才受到等量伤害；该目标每回复体力后，
 *          戏志才回复等量体力。
 * 【筹策】：戏志才每受到 1 点伤害后可以进行一次判定：红色，令一名角色摸 1
 *          张牌（先辅目标则摸 2 张）；黑色，弃置一名角色区域里的一张牌。
 *
 * 三处最容易做错的：
 *
 * 1. **先辅是「等量」不是「1 点」**：一次 2 点伤害/回复要让戏志才同样受到
 *    / 回复 2 点，走同一次 `loseHp`/`recover`，不拆成两次各 1 点。
 * 2. **先辅的镜像走「失去体力」，不是再造一次伤害**——那只是数值结果的镜像，
 *    不该重新触发一遍「受到伤害后」的整条时机链（避免和筹策的触发次数
 *    对不上、也避免递归）。
 * 3. **筹策按「点」触发**：一次 2 点伤害产生 2 次判定机会，用剩余次数排队
 *    依次问，不是一次机会。
 * 4. **先辅目标绑定必须可序列化**：存在 `state.xianfuTarget`（新增字段），
 *    不能用模块级 Map——那样断线重连、Durable Object 唤醒后就丢了。
 */

// 'tiandu' 已被郭嘉占用，技能 id 全局唯一，这里改名 'xizhicai-tiandu'
const TIANDU = 'xizhicai-tiandu'
const XIANFU = 'xianfu'
const XIANFU_MIRROR = 'xianfu-mirror'
const CHOUCE = 'chouce'
const CHOUCE_DRAW = 'chouce-draw'
const CHOUCE_DISCARD_PICK = 'chouce-discard-pick'
const CHOUCE_TAG = 'chouce'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: TIANDU,
  triggers: [{
    event: 'JudgeEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; judgeCardId?: string }
      if (payload.playerId !== ownerId || !payload.judgeCardId) return
      host.queueSkill({ skillId: TIANDU, ownerId, step: 'ask', data: { cardId: payload.judgeCardId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const cardId = prompt.data.cardId as string
    if (!host.state.zones.discardPile.includes(cardId) && !host.state.zones.processingArea.includes(cardId)) return
    host.askSkill({
      skillId: TIANDU, ownerId, step: 'ask', data: { cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【天妒】：获得这张判定牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '获得' }, { id: 'no', label: '不获得' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const cardId = resolution.data.cardId as string
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const from = host.state.zones.discardPile.includes(cardId)
      ? ({ kind: 'discardPile' } as const)
      : host.state.zones.processingArea.includes(cardId)
        ? ({ kind: 'processingArea' } as const)
        : null
    if (!from) return
    moveCard(host.state, cardId, from, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: TIANDU }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: TIANDU, skillName: '天妒', playerId: ownerId,
      logText: `${owner.nickname}发动【天妒】，获得判定牌`,
    }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: XIANFU,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: XIANFU, ownerId, step: 'pick',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【先辅】：选择一名其他角色为先辅目标（本局固定）',
        timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!owner?.alive || !target?.alive) return
    host.state.xianfuTarget ??= {}
    host.state.xianfuTarget[ownerId] = targetId!
    host.dispatch('SkillActivated', {
      skillId: XIANFU, skillName: '先辅', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【先辅】，选择${target.nickname}为先辅目标`,
    }, { sourceId: ownerId, targetId })
  },

  triggers: [
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        const boundTarget = host.state.xianfuTarget?.[ownerId]
        if (!boundTarget || context.event.targetId !== boundTarget) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const amount = (context.event.payload as { amount?: number }).amount ?? 0
        if (amount <= 0) return
        host.queueSkill({ skillId: XIANFU_MIRROR, ownerId, step: 'damage', data: { amount } })
      },
    },
    {
      event: 'Recover',
      handle(host, ownerId, context) {
        const boundTarget = host.state.xianfuTarget?.[ownerId]
        const payload = context.event.payload as { playerId?: PlayerId; amount?: number }
        if (!boundTarget || payload.playerId !== boundTarget) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !payload.amount || payload.amount <= 0) return
        host.dispatch('SkillActivated', {
          skillId: XIANFU, skillName: '先辅', playerId: ownerId,
          logText: `${owner.nickname}发动【先辅】，回复 ${payload.amount} 点体力`,
        }, { sourceId: ownerId })
        recover(host as never, ownerId, payload.amount, XIANFU)
      },
    },
  ],
})

registerSkillRuntime({
  id: XIANFU_MIRROR,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'damage') return
    const amount = prompt.data.amount as number
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || amount <= 0) return
    host.dispatch('SkillActivated', {
      skillId: XIANFU, skillName: '先辅', playerId: ownerId,
      logText: `${owner.nickname}发动【先辅】，受到 ${amount} 点伤害`,
    }, { sourceId: ownerId })
    // 走失去体力：这是数值结果的镜像，不是又一次真正的伤害来源结算
    loseHp(host as never, ownerId, amount, XIANFU)
  },
})

registerSkillRuntime({
  id: CHOUCE,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const amount = (context.event.payload as { amount?: number }).amount ?? 0
      if (amount <= 0) return
      host.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining: amount } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'judge') return
    const { remaining } = prompt.data as { remaining: number }
    if (remaining <= 0 || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: CHOUCE, ownerId, step: 'ask', data: { remaining },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【筹策】：进行一次判定？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '判定' }, { id: 'no', label: '不判定' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { remaining } = resolution.data as { remaining: number }
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      performJudgment(host, ownerId, CHOUCE, { tag: CHOUCE_TAG, data: { ownerId, remaining: remaining - 1 } })
      return
    }
    if (remaining - 1 > 0) host.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining: remaining - 1 } })
  },
})

registerJudgmentContinuation(CHOUCE_TAG, (host, judged, data) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = data.ownerId as PlayerId
  const remaining = data.remaining as number
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) { if (remaining > 0) skillHost.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining } }); return }
  const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
  if (candidateIds.length === 0) { if (remaining > 0) skillHost.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining } }); return }
  if (judged.color === 'red') {
    skillHost.askSkill({
      skillId: CHOUCE_DRAW, ownerId, step: 'draw-target', data: { remaining },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【筹策】：选择一名角色摸牌', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
      }),
    })
    return
  }
  skillHost.askSkill({
    skillId: CHOUCE_DRAW, ownerId, step: 'discard-target', data: { remaining },
    build: (requestId): ChooseTargetsRequest => ({
      id: requestId, kind: 'choose-targets', playerId: ownerId,
      prompt: '【筹策】：选择一名角色，弃置其区域里的一张牌', timeoutMs: 20_000, optional: true,
      candidateIds, min: 0, max: 1,
    }),
  })
})

registerSkillRuntime({
  id: CHOUCE_DRAW,
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'draw-target') {
      const remaining = (resolution.data as { remaining: number }).remaining
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && playerOf(host.state, targetId)?.alive) {
        const xianfuTarget = host.state.xianfuTarget?.[ownerId]
        const count = targetId === xianfuTarget ? 2 : 1
        host.dispatch('SkillActivated', {
          skillId: CHOUCE, skillName: '筹策', playerId: ownerId, targetId,
          logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【筹策】，${playerOf(host.state, targetId)?.nickname ?? ''}摸 ${count} 张牌`,
        }, { sourceId: ownerId, targetId })
        drawCards(host.state, host.rng, targetId, count, (name, payload) => { host.dispatch(name, payload) })
      }
      if (remaining > 0) host.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining } })
      return
    }
    if (resolution.step === 'discard-target') {
      const remaining = (resolution.data as { remaining: number }).remaining
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (targetId && playerOf(host.state, targetId)?.alive) {
        host.queueSkill({ skillId: CHOUCE_DISCARD_PICK, ownerId, step: 'pick', data: { remaining, targetId } })
        return
      }
      if (remaining > 0) host.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining } })
    }
  },
})

registerSkillRuntime({
  id: CHOUCE_DISCARD_PICK,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick') return
    const { targetId } = prompt.data as { remaining: number; targetId: PlayerId }
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const pickable = pickableCardsOf(host.state, targetId)
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
    host.askSkill({
      skillId: CHOUCE_DISCARD_PICK, ownerId, step: 'pick', data: prompt.data,
      build: (requestId) => ({
        id: requestId, kind: 'choose-cards' as const, playerId: ownerId,
        prompt: `【筹策】：弃置${target.nickname}区域里的一张牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill' as const,
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const { remaining, targetId } = resolution.data as { remaining: number; targetId: PlayerId }
    const [choice] = (response.payload as { cardIds?: string[] }).cardIds ?? []
    if (choice) {
      const cardId = resolvePickedCard(host.state, targetId, choice)
      if (cardId) {
        movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: CHOUCE }, { targetId, cardIds: [cardId] })
      }
    }
    if (remaining > 0) host.queueSkill({ skillId: CHOUCE, ownerId, step: 'judge', data: { remaining } })
  },
})

export const XIZHICAI: CharacterDefinition = {
  id: 'xizhicai',
  name: '戏志才',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: TIANDU, name: '天妒', description: '戏志才的判定牌生效后，可以获得这张牌。' },
    { id: XIANFU, name: '先辅', description: '锁定技，游戏开始时选择一名其他角色为先辅目标（本局固定）：该目标每受到伤害后，戏志才受到等量伤害；该目标每回复体力后，戏志才回复等量体力。' },
    { id: CHOUCE, name: '筹策', description: '戏志才每受到 1 点伤害后可以进行一次判定：红色，令一名角色摸 1 张牌（先辅目标则摸 2 张）；黑色，弃置一名角色区域里的一张牌。' },
  ],
}
