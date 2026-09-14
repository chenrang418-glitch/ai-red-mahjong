import { drawCards } from '../../engine/draw'
import { flipCharacter } from '../../engine/character-state'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 罗宪（三国杀 OL 经典身份 SP）。
 *
 * 【带砺】：每回合结束时，若你当前仍在手牌中且处于展示状态的具体牌数为
 *          偶数（0也算），可以翻面，摸3张牌，并展示这3张牌。
 */

const DAILI = 'daili'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function revealedInHandCount(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  const revealed = new Set(state.luoxianRevealed ?? [])
  return owner.zones.hand.filter((cardId) => revealed.has(cardId)).length
}

registerSkillRuntime({
  id: DAILI,
  triggers: [{
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (revealedInHandCount(host.state, ownerId) % 2 !== 0) return
      host.queueSkill({ skillId: DAILI, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: DAILI, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【带砺】：是否翻面并摸3张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    host.dispatch('SkillActivated', { skillId: DAILI, skillName: '带砺', playerId: ownerId, logText: `${owner.nickname}发动【带砺】` }, { sourceId: ownerId })
    flipCharacter(host as never, ownerId, DAILI)
    if (!playerOf(host.state, ownerId)?.alive) return
    const drawn = drawCards(host.state, host.rng, ownerId, 3, (name, payload) => { host.dispatch(name, payload) })
    const stillInHand = drawn.filter((cardId: CardId) => playerOf(host.state, ownerId)?.zones.hand.includes(cardId))
    if (stillInHand.length === 0) return
    host.state.luoxianRevealed = [...(host.state.luoxianRevealed ?? []), ...stillInHand]
    host.dispatch('CardMove', { cardIds: stillInHand, reason: DAILI, revealed: true }, { sourceId: ownerId })
  },
})

export const LUOXIAN: CharacterDefinition = {
  id: 'luoxian',
  name: '罗宪',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: DAILI, name: '带砺', description: '每回合结束时，若你当前仍在手牌中且处于展示状态的具体牌数为偶数（0也算），可以翻面，摸3张牌，并展示这3张牌。' },
  ],
}
