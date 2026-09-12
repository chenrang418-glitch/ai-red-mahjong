import { movePickedCard } from '../../engine/card-pick'
import { setChained } from '../../engine/character-state'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 关银屏（三国杀 OL 经典身份 SP）。
 *
 * 【雪恨】：出牌阶段限一次，弃置一张红色手牌，选择至多 X 名角色（X 为
 *          max(1, 已损失体力值)）并全部横置，然后对其中一名造成 1 点火焰
 *          伤害。
 * 【虎啸】：锁定技，关银屏造成火焰伤害后，受伤角色摸一张牌，直到本回合结束
 *          关银屏对其使用牌无次数限制。
 * 【武继】：觉醒技，结束阶段若本回合累计造成伤害 ≥3，体力上限 +1、回复 1 点、
 *          失去【虎啸】、获得真实【青龙偃月刀】。
 *
 * 两处最容易做错的：
 *
 * 1. **虎啸的「无次数限制」在本引擎里只对【杀】有意义**（其余牌种没有
 *    per-turn 使用次数上限），走已有的定向豁免钩子 `ignoresSlashUsesTo`
 *    （高顺【陷阵】同款），按目标记一个本回合有效的标记，不新造机制。
 * 2. **武继失去虎啸走 `skillSuppressions`**（神孙权【帝力】同款压制机制），
 *    不是删技能定义——那是模块级共享常量，改了全进程同名武将都受影响。
 */

const XUEHEN = 'xuehen'
const HUXIAO = 'huxiao'
const WUJI = 'wuji'
const HUXIAO_TARGET_PREFIX = 'huxiao-target:'
const WUJI_DAMAGE_TURN_MARK = 'wuji-damage-turn'
const WUJI_DAMAGE_MARK = 'wuji-damage'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: XUEHEN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const hasRed = owner.zones.hand.some((cardId) => state.cards[cardId]?.color === 'red')
    if (!hasRed) return []
    return [{ id: XUEHEN, label: '雪恨：弃置一张红色手牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== XUEHEN) return
    const owner = playerOf(host.state, ownerId)
    const redCards = owner?.zones.hand.filter((cardId) => host.state.cards[cardId]?.color === 'red') ?? []
    if (!owner?.alive || redCards.length === 0) return
    host.askSkill({
      skillId: XUEHEN, ownerId, step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【雪恨】：弃置一张红色手牌',
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        cardIds: redCards, hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'discard') {
      const owner = playerOf(host.state, ownerId)
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId || !owner.zones.hand.includes(cardId) || host.state.cards[cardId]?.color !== 'red') return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: XUEHEN }, { targetId: ownerId, cardIds: [cardId] })
      const x = Math.max(1, owner.maxHp - owner.hp)
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.dispatch('SkillActivated', {
        skillId: XUEHEN, skillName: '雪恨', playerId: ownerId,
        logText: `${owner.nickname}发动【雪恨】，选择至多 ${x} 名角色`,
      }, { sourceId: ownerId })
      host.askSkill({
        skillId: XUEHEN, ownerId, step: 'targets', data: { x },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【雪恨】：选择至多 ${x} 名角色，全部横置`,
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: Math.min(x, candidateIds.length),
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((id) => playerOf(host.state, id)?.alive)
      if (targetIds.length === 0) return
      for (const targetId of targetIds) setChained(host as never, targetId, XUEHEN, true)
      host.askSkill({
        skillId: XUEHEN, ownerId, step: 'damage', data: { targetIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【雪恨】：选择一名角色，对其造成 1 点火焰伤害',
          timeoutMs: 20_000, optional: false, candidateIds: targetIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'damage') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardName: null })
    }
  },
})

registerSkillRuntime({
  id: HUXIAO,
  ignoresSlashUsesTo(state, ownerId, targetId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return false
    return owner.marks[`${HUXIAO_TARGET_PREFIX}${targetId}`] === state.turnNumber
  },

  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { targetId?: PlayerId }
      if (context.event.sourceId !== ownerId || context.event.damageNature !== 'fire') return
      const targetId = context.event.targetId ?? payload.targetId
      if (!targetId) return
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      if (!owner?.alive || !target?.alive) return
      owner.marks[`${HUXIAO_TARGET_PREFIX}${targetId}`] = host.state.turnNumber
      host.dispatch('SkillActivated', {
        skillId: HUXIAO, skillName: '虎啸', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【虎啸】，${target.nickname}摸一张牌`,
      }, { sourceId: ownerId, targetId })
      drawCards(host.state, host.rng, targetId, 1, (name, payload2) => { host.dispatch(name, payload2) })
    },
  }],
})

function findQinglongDao(state: SanguoshaState): { cardId: CardId; from: 'drawPile' | 'discardPile' | { playerId: PlayerId; slot: 'weapon' | 'weapon2' } } | null {
  for (const cardId of state.zones.drawPile) {
    if (state.cards[cardId]?.name === '青龙偃月刀') return { cardId, from: 'drawPile' }
  }
  for (const cardId of state.zones.discardPile) {
    if (state.cards[cardId]?.name === '青龙偃月刀') return { cardId, from: 'discardPile' }
  }
  for (const player of state.players) {
    for (const slot of ['weapon', 'weapon2'] as const) {
      const cardId = player.zones.equipment[slot]
      if (cardId && state.cards[cardId]?.name === '青龙偃月刀') return { cardId, from: { playerId: player.id, slot } }
    }
  }
  return null
}

registerSkillRuntime({
  id: WUJI,
  triggers: [
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const amount = (context.event.payload as { amount?: number }).amount ?? 0
        if (owner.marks[WUJI_DAMAGE_TURN_MARK] !== host.state.turnNumber) {
          owner.marks[WUJI_DAMAGE_TURN_MARK] = host.state.turnNumber
          owner.marks[WUJI_DAMAGE_MARK] = 0
        }
        owner.marks[WUJI_DAMAGE_MARK] = (owner.marks[WUJI_DAMAGE_MARK] ?? 0) + amount
      },
    },
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.usedLimitedSkills.includes(WUJI)) return
        const total = owner.marks[WUJI_DAMAGE_TURN_MARK] === host.state.turnNumber ? (owner.marks[WUJI_DAMAGE_MARK] ?? 0) : 0
        if (total < 3) return
        owner.usedLimitedSkills.push(WUJI)
        owner.maxHp += 1
        owner.hp = Math.min(owner.maxHp, owner.hp + 1)
        host.dispatch('MaxHpChange', { playerId: ownerId, maxHp: owner.maxHp, hp: owner.hp, amount: 1, trimmed: 0, reason: WUJI }, { targetId: ownerId })
        host.state.skillSuppressions ??= []
        host.state.skillSuppressions.push({
          targetId: ownerId, skillId: HUXIAO, sourceId: ownerId, sourceSkillId: WUJI,
          armedAtTurn: Number.MAX_SAFE_INTEGER,
        })
        const found = findQinglongDao(host.state)
        let logText = `${owner.nickname}觉醒【武继】，体力上限 +1 并回复 1 点，失去【虎啸】`
        if (found) {
          if (found.from === 'drawPile') {
            moveCard(host.state, found.cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
          } else if (found.from === 'discardPile') {
            moveCard(host.state, found.cardId, { kind: 'discardPile' }, { kind: 'hand', playerId: ownerId })
          } else {
            movePickedCard(host as never, found.from.playerId, found.cardId, { kind: 'hand', playerId: ownerId })
          }
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [found.cardId], reason: WUJI }, { targetId: ownerId, cardIds: [found.cardId] })
          logText += '，获得【青龙偃月刀】'
        }
        host.dispatch('SkillActivated', { skillId: WUJI, skillName: '武继', playerId: ownerId, logText }, { sourceId: ownerId })
      },
    },
  ],
})

export const GUANYINPING: CharacterDefinition = {
  id: 'guanyinping',
  name: '关银屏',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: XUEHEN,
      name: '雪恨',
      description: '出牌阶段限一次，弃置一张红色手牌，选择至多 X 名角色（X 为 max(1, 已损失体力值)）并全部横置，然后对其中一名造成 1 点火焰伤害。',
    },
    {
      id: HUXIAO,
      name: '虎啸',
      description: '锁定技，关银屏造成火焰伤害后，受伤角色摸一张牌，直到本回合结束关银屏对其使用牌无次数限制。',
      locked: true,
    },
    {
      id: WUJI,
      name: '武继',
      description: '觉醒技，结束阶段若本回合累计造成伤害达到 3 点，体力上限 +1、回复 1 点体力、失去【虎啸】、获得真实【青龙偃月刀】。',
    },
  ],
}
