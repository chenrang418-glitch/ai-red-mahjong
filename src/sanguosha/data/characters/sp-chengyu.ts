import { moveCard } from '../../engine/zones'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 程昱（三国杀 OL 经典身份 SP）。
 *
 * 【设伏】：出牌阶段结束时，程昱可以声明一个非装备牌的牌名，将一张手牌
 *          暗置于武将牌上，称为「伏兵」；其他角色在程昱回合外使用与某张
 *          伏兵所声明牌名相同的牌时，程昱可以移去这张伏兵，令这张牌的
 *          使用整体无效。
 * 【贲育】：一名角色对程昱造成伤害后，程昱可以选择一项：摸牌至与该角色
 *          手牌数相同（最多摸至 5 张）；或弃置至少比其手牌数多一张的手牌，
 *          然后对其造成 1 点伤害。
 *
 * 设伏命中判定发生在 `BeforeCardUse` 这个事件时点——现有引擎的普通事件
 * 触发器是同步派发、不支持在这里挂起发问（不像 `interceptTarget` 那类
 * 可挂起拦截点），因此命中即视为发动并整体作废这次使用，不再额外多问
 * 程昱一次，作为已知简化记录在角色说明里。
 */

const SHEFU = 'shefu'
const BENYU = 'benyu'
const FUBING_PILE = 'fubing'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHEFU,
  triggers: [
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.zones.hand.length === 0) return
        host.queueSkill({ skillId: SHEFU, ownerId, step: 'declare', data: {} })
      },
    },
    {
      event: 'BeforeCardUse',
      handle(host, ownerId, context) {
        if (host.state.currentPlayerId === ownerId) return
        const payload = context.event.payload as { cardName?: string }
        const sourceId = context.event.sourceId
        const cardName = payload.cardName
        if (!sourceId || sourceId === ownerId || !cardName) return
        const records = host.state.fubingRecords?.[ownerId] ?? []
        const index = records.findIndex((entry) => entry.cardName === cardName)
        if (index < 0) return
        const [record] = records.splice(index, 1)
        moveCard(host.state, record.cardId, { kind: 'characterPile', playerId: ownerId, pile: FUBING_PILE }, { kind: 'discardPile' })
        context.cancel()
        host.dispatch('SkillActivated', {
          skillId: SHEFU, skillName: '设伏', playerId: ownerId, targetId: sourceId,
          logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【设伏】，${cardName}被整体无效`,
        }, { sourceId: ownerId, targetId: sourceId })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'declare') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    const names = [...new Set(
      Object.values(host.state.cards)
        .filter((card) => card.category !== 'equipment')
        .map((card) => card.name),
    )]
    if (names.length === 0) return
    host.askSkill({
      skillId: SHEFU, ownerId, step: 'declare', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【设伏】：声明一个非装备牌的牌名（可以放弃）', timeoutMs: 20_000, optional: true,
        options: [...names.map((name) => ({ id: name, label: name })), { id: 'none', label: '不发动' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (resolution.step === 'declare') {
      const cardName = (response.payload as { optionId?: string }).optionId
      if (!cardName || cardName === 'none' || owner.zones.hand.length === 0) return
      host.askSkill({
        skillId: SHEFU, ownerId, step: 'pick', data: { cardName },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【设伏】：暗置一张手牌作为伏兵（绑定牌名：${cardName}）`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'pick') {
      const { cardName } = resolution.data as { cardName: string }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!cardId || !owner.zones.hand.includes(cardId)) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: FUBING_PILE })
      host.state.fubingRecords ??= {}
      host.state.fubingRecords[ownerId] ??= []
      host.state.fubingRecords[ownerId].push({ cardId, cardName })
      host.dispatch('SkillActivated', { skillId: SHEFU, skillName: '设伏', playerId: ownerId, logText: `${owner.nickname}发动【设伏】，绑定牌名：${cardName}` }, { sourceId: ownerId })
    }
  },
})

registerSkillRuntime({
  id: BENYU,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const sourceId = context.event.sourceId ?? null
      const source = sourceId ? playerOf(host.state, sourceId) : undefined
      if (!source?.alive) return
      host.queueSkill({ skillId: BENYU, ownerId, step: 'ask', data: { sourceId, x: source.zones.hand.length } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const { sourceId, x } = prompt.data as { sourceId: PlayerId; x: number }
    const source = playerOf(host.state, sourceId)
    if (!source?.alive) return
    const options: Array<{ id: string; label: string }> = []
    if (Math.min(x, 5) > owner.zones.hand.length) options.push({ id: 'draw', label: `摸牌至${Math.min(x, 5)}张` })
    if (owner.zones.hand.length >= x + 1) options.push({ id: 'discard', label: `弃置至少${x + 1}张手牌，对其造成1点伤害` })
    if (options.length === 0) return
    options.push({ id: 'none', label: '不发动' })
    host.askSkill({
      skillId: BENYU, ownerId, step: 'ask', data: { sourceId, x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【贲育】：选择一项', timeoutMs: 20_000, optional: true, options,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      const { sourceId, x } = resolution.data as { sourceId: PlayerId; x: number }
      if (optionId === 'draw') {
        const need = Math.max(0, Math.min(x, 5) - owner.zones.hand.length)
        if (need > 0) drawCards(host.state, host.rng, ownerId, need, (name, payload) => { host.dispatch(name, payload) })
        host.dispatch('SkillActivated', { skillId: BENYU, skillName: '贲育', playerId: ownerId, logText: `${owner.nickname}发动【贲育】，摸牌` }, { sourceId: ownerId })
        return
      }
      if (optionId === 'discard') {
        host.askSkill({
          skillId: BENYU, ownerId, step: 'discard', data: { sourceId, min: x + 1 },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【贲育】：弃置至少${x + 1}张手牌`, timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: x + 1, max: owner.zones.hand.length,
          }),
        })
      }
      return
    }

    if (resolution.step === 'discard') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      if (valid.length === 0) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: BENYU }, { sourceId: ownerId, cardIds: valid })
      const target = playerOf(host.state, sourceId)
      if (target?.alive) {
        host.dispatch('SkillActivated', { skillId: BENYU, skillName: '贲育', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【贲育】，对${target.nickname}造成1点伤害` }, { sourceId: ownerId, targetId: sourceId })
        resolveDamage(host as never, { sourceId: ownerId, targetId: sourceId, amount: 1, nature: 'normal', cardName: null })
      }
    }
  },
})

export const CHENGYU: CharacterDefinition = {
  id: 'chengyu',
  name: '程昱',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: SHEFU, name: '设伏', description: '出牌阶段结束时，程昱可以声明一个非装备牌的牌名，将一张手牌暗置于武将牌上，称为“伏兵”；其他角色在程昱回合外使用与某张伏兵所声明牌名相同的牌时，移去这张伏兵，令这张牌的使用整体无效。' },
    { id: BENYU, name: '贲育', description: '一名角色对程昱造成伤害后，程昱可以选择一项：摸牌至与其手牌数相同（最多摸至5张）；或弃置至少比其手牌数多一张的手牌，然后对其造成1点伤害。' },
  ],
}
