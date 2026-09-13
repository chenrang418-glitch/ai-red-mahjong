import { drawCards } from '../../engine/draw'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 阮籍（三国杀 OL 经典身份 SP）。
 *
 * 【昭文】：出牌阶段开始时，你可以展示所有手牌，直到回合结束：黑色牌可以
 *          当任意普通锦囊使用（每种牌名每回合限一次），红色牌被你使用时
 *          你摸1张。
 */

const ZHAOWEN = 'zhaowen'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function shownIds(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const shown = state.ruanjiShown
  if (!shown || shown.turnNumber !== state.turnNumber || shown.ownerId !== ownerId) return []
  return shown.cardIds
}

registerSkillRuntime({
  id: ZHAOWEN,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: ZHAOWEN, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; asCardName?: string; cancelled?: boolean }
        if (payload.cancelled) return
        const shown = shownIds(host.state, ownerId)
        if (payload.asCardName && shown.includes(payload.cardId ?? '') && host.state.cards[payload.cardId ?? '']?.color === 'black') {
          host.state.ruanjiUsedNames ??= { turnNumber: host.state.turnNumber, names: [] }
          if (host.state.ruanjiUsedNames.turnNumber !== host.state.turnNumber) host.state.ruanjiUsedNames = { turnNumber: host.state.turnNumber, names: [] }
          host.state.ruanjiUsedNames.names.push(payload.asCardName)
        }
        if (payload.cardId && shown.includes(payload.cardId) && host.state.cards[payload.cardId]?.color === 'red') {
          const owner = playerOf(host.state, ownerId)
          if (owner?.alive) {
            drawCards(host.state, host.rng, ownerId, 1, (name, p) => { host.dispatch(name, p) })
            host.dispatch('SkillActivated', { skillId: ZHAOWEN, skillName: '昭文', playerId: ownerId, logText: `${owner.nickname}发动【昭文】，摸1张牌` }, { sourceId: ownerId })
          }
        }
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    host.askSkill({
      skillId: ZHAOWEN, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【昭文】：是否展示所有手牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【昭文】' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const cardIds = [...owner.zones.hand]
    if (cardIds.length === 0) return
    host.state.ruanjiShown = { turnNumber: host.state.turnNumber, ownerId, cardIds }
    host.dispatch('CardMove', { cardIds, reason: ZHAOWEN, revealed: true }, { sourceId: ownerId })
    host.dispatch('SkillActivated', { skillId: ZHAOWEN, skillName: '昭文', playerId: ownerId, logText: `${owner.nickname}发动【昭文】，展示所有手牌` }, { sourceId: ownerId })
  },
  viewAs(state, ownerId) {
    const shown = shownIds(state, ownerId)
    if (shown.length === 0) return []
    const owner = playerOf(state, ownerId)
    if (!owner) return []
    const usedNames = state.ruanjiUsedNames?.turnNumber === state.turnNumber ? state.ruanjiUsedNames.names : []
    const candidates = shown.filter((cardId) => owner.zones.hand.includes(cardId) && state.cards[cardId]?.color === 'black')
    const options = []
    for (const cardId of candidates) {
      for (const name of INSTANT_TRICKS) {
        if (usedNames.includes(name)) continue
        options.push({ asCardName: name, cardId, label: `昭文：当作【${name}】使用` })
      }
    }
    return options
  },
})

export const RUANJI: CharacterDefinition = {
  id: 'ruanji',
  name: '阮籍',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: ZHAOWEN, name: '昭文', description: '出牌阶段开始时，你可以展示所有手牌，直到回合结束：黑色牌可以当任意普通锦囊使用（每种牌名每回合限一次），红色牌被你使用时你摸1张。' },
  ],
}
