import { drawCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { canTarget } from '../../engine/distance'
import { effectiveKingdomOf } from '../../engine/huashen'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, Kingdom, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孟达（三国杀 OL 经典身份 SP）。
 *
 * 【苟得】：每个 TurnInstance 结束时，若与孟达当前势力相同的角色（含孟达
 *          自己）本 TurnInstance 内执行过以下四项中的至少一项：①摸一张牌
 *          ②弃置一名角色1张手牌 ③视为使用一张【杀】 ④变更势力——孟达可以
 *          执行其中尚未被执行过的一项。
 *
 * 四项的判定口径（假设，未经权威文本核实，见批次报告"未解决"）：①单次
 * 摸1张（GainCard reason=draw 且张数=1）②弃置自己1张手牌（LoseCard
 * reason=discard 且张数=1）③以"视为"方式使用杀（虚拟牌或转化牌，不含直接
 * 打出的实体杀）④通过 kingdomOverride 变更势力。
 */

type GoudeItem = 1 | 2 | 3 | 4
const GOUDE = 'goude'
const GOUDE_LABELS: Record<GoudeItem, string> = {
  1: '摸1张牌', 2: '弃置一名角色1张手牌', 3: '视为使用1张【杀】', 4: '变更你的势力',
}

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function sameKingdom(state: SanguoshaState, actorId: PlayerId, ownerId: PlayerId): boolean {
  return !!effectiveKingdomOf(state, actorId) && effectiveKingdomOf(state, actorId) === effectiveKingdomOf(state, ownerId)
}

function markGoudeItem(host: { state: SanguoshaState }, item: GoudeItem): void {
  const seen = host.state.mengdaGoudeSeen
  const items = new Set(seen?.turnNumber === host.state.turnNumber ? seen.items : [])
  items.add(item)
  host.state.mengdaGoudeSeen = { turnNumber: host.state.turnNumber, items: [...items] }
}

registerSkillRuntime({
  id: GOUDE,
  triggers: [
    {
      event: 'GainCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string; cardIds?: CardId[] }
        if (payload.reason !== 'draw' || (payload.cardIds?.length ?? 0) !== 1 || !payload.playerId) return
        if (!sameKingdom(host.state, payload.playerId, ownerId)) return
        markGoudeItem(host, 1)
      },
    },
    {
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string; cardIds?: CardId[] }
        if (payload.reason !== 'discard' || (payload.cardIds?.length ?? 0) !== 1 || !payload.playerId) return
        if (!sameKingdom(host.state, payload.playerId, ownerId)) return
        markGoudeItem(host, 2)
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!sourceId || !sameKingdom(host.state, sourceId, ownerId)) return
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; asCardName?: string }
        const effective = payload.asCardName ?? payload.cardName
        if (effective !== '杀') return
        const real = payload.cardId ? host.state.cards[payload.cardId] : undefined
        const isVirtual = !!real?.virtual || (!!payload.asCardName && payload.asCardName !== payload.cardName)
        if (!isVirtual) return
        markGoudeItem(host, 3)
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId) {
        const seen = host.state.mengdaGoudeSeen
        if (!seen || seen.turnNumber !== host.state.turnNumber || seen.items.length === 0) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const available = ([1, 2, 3, 4] as GoudeItem[]).filter((item) => !seen.items.includes(item))
        if (available.length === 0) return
        host.queueSkill({ skillId: GOUDE, ownerId, step: 'choose', data: { available } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const { available } = prompt.data as { available: GoudeItem[] }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: GOUDE, ownerId, step: 'pick', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【苟得】：请选择执行其中一项', timeoutMs: 20_000, optional: true,
        options: [...available.map((item) => ({ id: String(item), label: GOUDE_LABELS[item] })), { id: 'cancel', label: '不执行' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId || optionId === 'cancel') return
      const item = Number(optionId) as GoudeItem
      host.dispatch('SkillActivated', { skillId: GOUDE, skillName: '苟得', playerId: ownerId, logText: `${owner.nickname}发动【苟得】` }, { sourceId: ownerId })
      if (item === 1) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        return
      }
      if (item === 2) {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.zones.hand.length > 0).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: GOUDE, ownerId, step: 'discard-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【苟得】：选择弃置1张手牌的角色', timeoutMs: 20_000, optional: true,
            candidateIds, min: 0, max: 1,
          }),
        })
        return
      }
      if (item === 3) {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId && canTarget(host.state, ownerId, candidate.id)).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: GOUDE, ownerId, step: 'slash-target', data: {},
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【苟得】：选择视为使用【杀】的目标', timeoutMs: 20_000, optional: true,
            candidateIds, min: 0, max: 1,
          }),
        })
        return
      }
      host.askSkill({
        skillId: GOUDE, ownerId, step: 'kingdom', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【苟得】：变更你的势力为', timeoutMs: 20_000, optional: true,
          options: [{ id: 'wei', label: '魏' }, { id: 'shu', label: '蜀' }, { id: 'wu', label: '吴' }, { id: 'qun', label: '群' }],
        }),
      })
      return
    }

    if (resolution.step === 'discard-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive || target.zones.hand.length === 0) return
      const cardId = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]
      moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: GOUDE }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      return
    }

    if (resolution.step === 'slash-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || targetId === ownerId || !playerOf(host.state, targetId)?.alive) return
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: GOUDE })
      return
    }

    if (resolution.step === 'kingdom') {
      const optionId = (response.payload as { optionId?: string }).optionId as Kingdom | undefined
      if (!optionId) return
      owner.kingdomOverride = optionId
      host.dispatch('SkillActivated', { skillId: GOUDE, skillName: '苟得', playerId: ownerId, logText: `${owner.nickname}将势力变更为${optionId}` }, { sourceId: ownerId })
    }
  },
})

export const MENGDA: CharacterDefinition = {
  id: 'mengda',
  name: '孟达',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: GOUDE, name: '苟得', description: '每个 TurnInstance 结束时，若与你势力相同的角色本回合内执行过"摸一张牌/弃置一名角色1张手牌/视为使用一张杀/变更势力"中的至少一项，你可以执行其中尚未被执行过的一项。' },
  ],
}
