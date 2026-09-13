import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陈到（三国杀 OL 经典身份 SP）。
 *
 * 【往烈】：出牌阶段，你使用的第一张牌无距离限制；使用基本牌或普通锦囊
 *          时，可以令这次使用不可被响应，若如此做，本出牌阶段之后不能
 *          再使用牌。
 */

const WANGLIE = 'wanglie'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function firstCardAvailable(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  return Boolean(owner?.alive) && owner!.marks['wanglie-first-used-turn'] !== state.turnNumber
}

registerSkillRuntime({
  id: WANGLIE,
  ignoresDistanceTo(state, sourceId) {
    if (state.phase !== 'play' || state.currentPlayerId !== sourceId) return false
    return firstCardAvailable(state, sourceId)
  },
  slashUndodgeable(state, _ownerId, targetId, cardId) {
    void targetId
    return Boolean(cardId) && state.chendaoArmedCardId === cardId
  },
  trickUnresponsive(state, _ownerId, targetId, cardName, cardId) {
    void targetId
    void cardName
    return Boolean(cardId) && state.chendaoArmedCardId === cardId
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (owner && owner.marks['wanglie-first-used-turn'] !== host.state.turnNumber) owner.marks['wanglie-first-used-turn'] = host.state.turnNumber
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        if (host.state.chendaoArmedCardId) host.state.chendaoArmedCardId = undefined
      },
    },
  ],
  prohibitsCardUse(state, ownerId, context) {
    const owner = playerOf(state, ownerId)
    return Boolean(owner?.alive) && context.userId === ownerId && owner!.marks['wanglie-locked-turn'] === state.turnNumber
  },
  interceptSourceTarget(host, ownerId, context) {
    if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks['wanglie-locked-turn'] === host.state.turnNumber) return false
    const isBasic = context.category === 'basic'
    const isPlainTrick = context.category === 'trick' && !DELAYED_TRICKS.has(context.cardName)
    if (!isBasic && !isPlainTrick) return false
    host.askSkill({
      skillId: WANGLIE, ownerId, step: 'ask-qiangming', data: { cardId: context.cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【往烈】：令这次使用不可被响应？（本出牌阶段之后不能再使用牌）', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask-qiangming') return
    const { cardId } = resolution.data as { cardId: CardId }
    const owner = playerOf(host.state, ownerId)
    if (owner?.alive && (response.payload as { optionId?: string }).optionId === 'yes') {
      owner.marks['wanglie-locked-turn'] = host.state.turnNumber
      host.state.chendaoArmedCardId = cardId
      host.dispatch('SkillActivated', { skillId: WANGLIE, skillName: '往烈', playerId: ownerId, logText: `${owner.nickname}发动【往烈】，这次使用不可被响应` }, { sourceId: ownerId })
    }
    host.resumeCardTarget()
  },
})

export const CHENDAO: CharacterDefinition = {
  id: 'chendao',
  name: '陈到',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: WANGLIE, name: '往烈', description: '出牌阶段，你使用的第一张牌无距离限制；使用基本牌或普通锦囊时，可以令这次使用不可被响应，若如此做，本出牌阶段之后不能再使用牌。' },
  ],
}
