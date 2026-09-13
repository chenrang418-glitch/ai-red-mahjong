import { loseHp } from '../../engine/hp'
import { giveCards } from '../../engine/hand-transfer'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { INSTANT_TRICKS } from '../../engine/cards/tricks'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张让（三国杀 OL 经典身份 SP）。
 *
 * 【滔乱】：可以将1张牌当任意基本牌或普通锦囊使用（每种牌名本局限一次，
 *          场上有人处于濒死时不能发动）。使用后，选择一名其他角色A，
 *          A交给你1张与声明牌类别不同的牌，否则你失去1点体力且本回合
 *          【滔乱】失效。
 */

const TAOLUAN = 'taoluan'
const BASIC_NAMES = ['杀', '桃', '酒']

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: TAOLUAN,
  viewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || state.dying) return []
    if (owner.marks['taoluan-disabled-turn'] === state.turnNumber) return []
    const used = new Set((state.zhangrangUsedNames ?? []).filter((entry) => entry.ownerId === ownerId).map((entry) => entry.name))
    const names = [...BASIC_NAMES, ...INSTANT_TRICKS].filter((name) => !used.has(name))
    const options = []
    for (const cardId of owner.zones.hand) {
      for (const name of names) options.push({ asCardName: name, cardId, label: `滔乱：当作【${name}】使用` })
    }
    return options
  },
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (!payload.cardName || !payload.cardId) return
        const realName = host.state.cards[payload.cardId]?.name
        if (!realName || realName === payload.cardName) return
        if (![...BASIC_NAMES, ...INSTANT_TRICKS].includes(payload.cardName)) return
        host.state.zhangrangUsedNames = [...(host.state.zhangrangUsedNames ?? []), { ownerId, name: payload.cardName }]
        host.state.zhangrangPendingType = { ownerId, category: cardCategoryOfName(payload.cardName) }
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const pending = host.state.zhangrangPendingType
        if (!pending || pending.ownerId !== ownerId) return
        host.state.zhangrangPendingType = undefined
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: TAOLUAN, ownerId, step: 'pick-target', data: { category: pending.category } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: TAOLUAN, ownerId, step: 'pick-target', data: prompt.data,
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【滔乱】：选择一名其他角色', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (resolution.step === 'pick-target') {
      const { category } = resolution.data as { category: string | null }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      const eligible = target.zones.hand.filter((cardId) => host.state.cards[cardId]?.category !== category)
      if (eligible.length === 0) { punishTaoluan(host as never, ownerId); return }
      host.askSkill({
        skillId: TAOLUAN, ownerId, step: 'target-give', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: targetId,
          prompt: '【滔乱】：交给张让1张与声明牌类别不同的牌（可以不交）', timeoutMs: 20_000, optional: true,
          purpose: 'skill', cardIds: eligible, hiddenCardSlots: [], min: 0, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'target-give') {
      const { targetId } = resolution.data as { targetId: PlayerId; category: string | null }
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (owner?.alive && target?.alive && cardId && target.zones.hand.includes(cardId)) {
        giveCards(host as never, targetId, ownerId, [cardId], TAOLUAN)
        return
      }
      punishTaoluan(host, ownerId)
    }
  },
})

function punishTaoluan(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  owner.marks['taoluan-disabled-turn'] = host.state.turnNumber
  loseHp(host as never, ownerId, 1, TAOLUAN)
}

export const ZHANGRANG: CharacterDefinition = {
  id: 'zhangrang',
  name: '张让',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: TAOLUAN, name: '滔乱', description: '可以将1张牌当任意基本牌或普通锦囊使用（每种牌名本局限一次，场上有人处于濒死时不能发动）。使用后，选择一名其他角色，其交给你1张与声明牌类别不同的牌，否则你失去1点体力且本回合【滔乱】失效。' },
  ],
}
