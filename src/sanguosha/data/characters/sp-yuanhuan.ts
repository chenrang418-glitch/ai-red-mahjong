import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 袁涣（三国杀 OL 经典身份 SP）。
 *
 * 【德辱】：出牌阶段限一次，袁涣选择一名其他角色A，声明一个或多个基本牌
 *          牌名；只要有猜对的，袁涣回复1点体力；只要有猜错的，袁涣随机
 *          获得A手牌中的一张基本牌；若全部猜中，袁涣摸牌至体力上限。
 *          三者可以同时结算。
 * 【临节】：锁定技，袁涣受到伤害后，伤害来源须弃置1张手牌；若弃置的是
 *          【杀】，袁涣摸1张牌。
 */

const DERU = 'deru'
const LINJIE = 'linjie'
const BASIC_NAMES = ['杀', '闪', '桃', '酒']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DERU,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DERU)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    return [{ id: DERU, label: '德辱：选择一名其他角色，猜测其手牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== DERU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DERU)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: DERU, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【德辱】：选择一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(DERU)) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      host.askSkill({
        skillId: DERU, ownerId, step: 'guess', data: { targetId },
        build: (requestId): ChooseOptionsRequest => ({
          id: requestId, kind: 'choose-options', playerId: ownerId,
          prompt: '【德辱】：声明一个或多个基本牌牌名', timeoutMs: 20_000, optional: false,
          options: BASIC_NAMES.map((name) => ({ id: name, label: name })), min: 1, max: BASIC_NAMES.length,
        }),
      })
      return
    }

    if (resolution.step === 'guess') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const guessed = (response.payload as { optionIds?: string[] }).optionIds ?? []
      if (guessed.length === 0) return
      owner.turnUsedSkills.push(DERU)
      const targetHandNames = target.zones.hand.map((cardId) => host.state.cards[cardId]?.name)
      const correctNames = guessed.filter((name) => targetHandNames.includes(name))
      const wrongNames = guessed.filter((name) => !targetHandNames.includes(name))
      host.dispatch('SkillActivated', { skillId: DERU, skillName: '德辱', playerId: ownerId, targetId, logText: `${owner.nickname}发动【德辱】，声明：${guessed.join('、')}` }, { sourceId: ownerId, targetId })

      if (correctNames.length > 0) recover(host as never, ownerId, 1, ownerId)
      if (wrongNames.length > 0) {
        const basicInHand = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category === 'basic')
        if (basicInHand.length > 0) {
          const picked = basicInHand[host.rng.nextInt(basicInHand.length)]
          moveCard(host.state, picked, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
          host.dispatch('LoseCard', { playerId: target.id, cardIds: [picked], reason: DERU }, { sourceId: target.id, cardIds: [picked] })
          host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: DERU }, { targetId: ownerId, cardIds: [picked] })
        }
      }
      if (correctNames.length === guessed.length && wrongNames.length === 0) {
        const current = playerOf(host.state, ownerId)
        if (current?.alive) {
          const need = Math.max(0, current.maxHp - current.zones.hand.length)
          if (need > 0) drawCards(host.state, host.rng, ownerId, need, (name, payload) => { host.dispatch(name, payload) })
        }
      }
    }
  },
})

registerSkillRuntime({
  id: LINJIE,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const source = playerOf(host.state, sourceId)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !source?.alive || source.zones.hand.length === 0) return
      host.queueSkill({ skillId: LINJIE, ownerId, step: 'discard', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const source = playerOf(host.state, sourceId)
    if (!source?.alive || source.zones.hand.length === 0) return
    host.askSkill({
      skillId: LINJIE, ownerId, step: 'discard', data: { sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: sourceId,
        prompt: '【临节】：弃置1张手牌', timeoutMs: 20_000, optional: false,
        purpose: 'skill', cardIds: [...source.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'discard') return
    const { sourceId } = resolution.data as { sourceId: PlayerId }
    const source = playerOf(host.state, sourceId)
    const owner = playerOf(host.state, ownerId)
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    if (!source?.alive || !owner?.alive || !cardId || !source.zones.hand.includes(cardId)) return
    const isSlash = host.state.cards[cardId]?.name === '杀'
    moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: LINJIE }, { sourceId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: LINJIE, skillName: '临节', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【临节】` }, { sourceId: ownerId, targetId: sourceId })
    if (isSlash) drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const YUANHUAN: CharacterDefinition = {
  id: 'yuanhuan',
  name: '袁涣',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: DERU, name: '德辱', description: '出牌阶段限一次，选择一名其他角色，声明一个或多个基本牌牌名；有猜对的，回复1点体力；有猜错的，随机获得对方一张基本牌；若全部猜对，摸牌至体力上限。' },
    { id: LINJIE, name: '临节', description: '锁定技，袁涣受到伤害后，伤害来源须弃置1张手牌；若弃置的是【杀】，袁涣摸1张牌。' },
  ],
}
