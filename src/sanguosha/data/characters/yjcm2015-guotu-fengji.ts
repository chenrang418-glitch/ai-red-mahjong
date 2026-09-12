import { drawCards } from '../../engine/draw'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 郭图逢纪（一将成名 2015）。
 *
 * 【急攻】：出牌阶段开始时，你可以摸两张牌，然后本回合你的手牌上限等于 X
 *          （X 为你于此阶段内造成过的伤害值）。
 * 【饰非】：当你需要使用或打出【闪】时，你可以令当前回合角色摸一张牌，然后
 *          若其不是手牌唯一最多的角色，则你弃置一名手牌最多的角色的一张牌，
 *          视为你使用或打出一张【闪】。
 *
 * 已知简化（记录在案，不是遗漏）：
 *
 * **饰非退化为「使用/打出一张真实【闪】时附加触发」，不是「没有【闪】也能
 * 顶替」。** 原文的「视为使用或打出」要求在求闪/无懈等响应流程里插入一个
 * 不需要真牌的候选动作，这条路径（八卦阵、蛊惑走的都是这条）硬编码在
 * `engine/cards/basic.ts` 的 `askDodge`/`resolveCardResponse` 里，本轮任务
 * 明确不允许改动 CardUse/伤害核心结算，所以退而求其次：挂在 `CardResponded`
 * 上，郭图逢纪真的打出一张【闪】之后触发同一套「摸牌+弃牌」效果。
 */

const JIGONG = 'jigong'
const SHIFEI = 'shifei'
const JIGONG_TURN_MARK = 'jigong-active-turn'
const JIGONG_DAMAGE_MARK = 'jigong-damage'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: JIGONG,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      host.queueSkill({ skillId: JIGONG, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: JIGONG, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【急攻】：摸两张牌，然后本回合手牌上限等于本阶段造成的伤害值？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【急攻】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    owner.marks[JIGONG_TURN_MARK] = host.state.turnNumber
    owner.marks[JIGONG_DAMAGE_MARK] = 0
    host.dispatch('SkillActivated', {
      skillId: JIGONG, skillName: '急攻', playerId: ownerId,
      logText: `${owner.nickname}发动【急攻】，摸两张牌`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 2, (name, payload) => { host.dispatch(name, payload) })
  },

  fixedMaxCards(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.marks[JIGONG_TURN_MARK] !== state.turnNumber) return null
    return owner.marks[JIGONG_DAMAGE_MARK] ?? 0
  },
})

registerSkillRuntime({
  id: `${JIGONG}-track`,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { amount?: number }
      const owner = playerOf(host.state, ownerId)
      // sourceId 是事件的元数据字段，不在 payload 里
      if (!owner?.alive || context.event.sourceId !== ownerId) return
      if (host.state.phase !== 'play' || owner.marks[JIGONG_TURN_MARK] !== host.state.turnNumber) return
      owner.marks[JIGONG_DAMAGE_MARK] = (owner.marks[JIGONG_DAMAGE_MARK] ?? 0) + (payload.amount ?? 0)
    },
  }],
})

function maxHandPlayerIds(state: SanguoshaState): PlayerId[] {
  const alive = state.players.filter((candidate) => candidate.alive)
  const max = Math.max(...alive.map((candidate) => candidate.zones.hand.length))
  return alive.filter((candidate) => candidate.zones.hand.length === max).map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: SHIFEI,
  triggers: [{
    event: 'CardResponded',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardName?: string }
      if (payload.cardName !== '闪' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: SHIFEI, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: SHIFEI, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【饰非】：令当前回合角色摸一张牌？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【饰非】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const currentPlayerId = host.state.currentPlayerId
      const current = playerOf(host.state, currentPlayerId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !current?.alive) return
      host.dispatch('SkillActivated', {
        skillId: SHIFEI, skillName: '饰非', playerId: ownerId, targetId: currentPlayerId,
        logText: `${owner.nickname}发动【饰非】，${current.nickname}摸一张牌`,
      }, { sourceId: ownerId, targetId: currentPlayerId })
      drawCards(host.state, host.rng, currentPlayerId, 1, (name, payload) => { host.dispatch(name, payload) })

      const maxIds = maxHandPlayerIds(host.state)
      if (maxIds.length === 1 && maxIds[0] === currentPlayerId) return
      if (maxIds.length === 0) return
      host.askSkill({
        skillId: SHIFEI, ownerId, step: 'target', data: { maxIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【饰非】：选择一名手牌最多的角色，弃置其一张牌',
          timeoutMs: 20_000, optional: false,
          candidateIds: maxIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const maxIds = resolution.data.maxIds as PlayerId[]
      if (!targetId || !maxIds.includes(targetId)) return
      const pickable = pickableCardsOf(host.state, targetId)
      const pool = [...pickable.cardIds, ...pickable.hiddenCardSlots]
      if (pool.length === 0) return
      const choice = pool[host.rng.nextInt(pool.length)]
      const cardId = resolvePickedCard(host.state, targetId, choice)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
    }
  },
})

export const GUOTU_FENGJI: CharacterDefinition = {
  id: 'guotu_fengji',
  name: '郭图逢纪',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2015',
  skills: [
    {
      id: JIGONG,
      name: '急攻',
      description: '出牌阶段开始时，你可以摸两张牌，然后本回合你的手牌上限等于 X（X 为你于此阶段内造成过的伤害值）。',
    },
    {
      id: SHIFEI,
      name: '饰非',
      description: '当你需要使用或打出【闪】时，你可以令当前回合角色摸一张牌，然后若其不是手牌唯一最多的角色，则你弃置一名手牌最多的角色的一张牌，视为你使用或打出一张【闪】。',
    },
  ],
}
