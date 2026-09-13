import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { maxCardsOf } from '../../engine/phase'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 秦朗（三国杀 OL 经典身份 SP）。
 *
 * 【昊宠】：使用一张牌后，可以将手牌数调整为当前手牌上限（单次最多摸5）；
 *          因此获得牌则手牌上限-1，因此失去牌则手牌上限+1（持续性
 *          source-bound 修正）。
 * 【矜谨】：每个 TurnInstance 最多2次，造成或受到伤害后，可以发动：将自己
 *          手牌上限重置为当前体力值（只清自己昊宠/矜谨造成的偏移），
 *          X=本次变化绝对值（至少1），伤害来源可以弃置至多X张牌，秦朗摸
 *          X-N张（N=来源实际弃置数量）。
 */

const HAOCHONG = 'haochong'
const JINJIN = 'jinjin'
const MOD_MARK = 'haochong-mod'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HAOCHONG,
  maxCardsBonus(state, ownerId) {
    return state.players.find((p) => p.id === ownerId)?.marks[MOD_MARK] ?? 0
  },
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cancelled?: boolean }
      if (payload.cancelled) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: HAOCHONG, ownerId, step: 'ask', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const max = maxCardsOf(host.state, ownerId)
    if (owner.zones.hand.length === max) return
    host.askSkill({
      skillId: HAOCHONG, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【昊宠】：是否将手牌数调整为手牌上限？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    const optionId = (response.payload as { optionId?: string }).optionId
    if (!owner?.alive || optionId !== 'yes') return
    const max = maxCardsOf(host.state, ownerId)
    host.dispatch('SkillActivated', { skillId: HAOCHONG, skillName: '昊宠', playerId: ownerId, logText: `${owner.nickname}发动【昊宠】` }, { sourceId: ownerId })
    if (owner.zones.hand.length < max) {
      const n = Math.min(max - owner.zones.hand.length, 5)
      if (n > 0) drawCards(host.state, host.rng, ownerId, n, (name, payload) => { host.dispatch(name, payload) })
      owner.marks[MOD_MARK] = (owner.marks[MOD_MARK] ?? 0) - 1
    } else if (owner.zones.hand.length > max) {
      const n = owner.zones.hand.length - max
      const pool = [...owner.zones.hand]
      const discardIds: CardId[] = []
      for (let index = 0; index < n && pool.length > 0; index += 1) {
        const [cardId] = pool.splice(host.rng.nextInt(pool.length), 1)
        discardIds.push(cardId)
      }
      for (const cardId of discardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      if (discardIds.length > 0) host.dispatch('LoseCard', { playerId: ownerId, cardIds: discardIds, reason: HAOCHONG }, { sourceId: ownerId, cardIds: discardIds })
      owner.marks[MOD_MARK] = (owner.marks[MOD_MARK] ?? 0) + 1
    }
  },
})

registerSkillRuntime({
  id: JINJIN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const isSource = context.event.sourceId === ownerId
      const isTarget = context.event.targetId === ownerId
      if (!isSource && !isTarget) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const usedTurn = owner.marks['jinjin-turn'] === host.state.turnNumber ? (owner.marks['jinjin-count'] ?? 0) : 0
      if (usedTurn >= 2) return
      owner.marks['jinjin-turn'] = host.state.turnNumber
      owner.marks['jinjin-count'] = usedTurn + 1
      const sourceId = isTarget ? context.event.sourceId ?? null : ownerId
      host.queueSkill({ skillId: JINJIN, ownerId, step: 'reset', data: { sourceId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'reset') return
    const { sourceId } = prompt.data as { sourceId: PlayerId | null }
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 手牌上限重置为当前体力值：只清自己身上由昊宠/矜谨造成的偏移，
    // 不动其它技能来源的加成——X 就是这份自身偏移被清零的绝对值。
    const before = owner.marks[MOD_MARK] ?? 0
    const x = Math.max(1, Math.abs(before))
    owner.marks[MOD_MARK] = 0
    host.dispatch('SkillActivated', { skillId: JINJIN, skillName: '矜谨', playerId: ownerId, logText: `${owner.nickname}发动【矜谨】，手牌上限重置为体力值` }, { sourceId: ownerId })
    const source = sourceId ? playerOf(host.state, sourceId) : undefined
    if (!source?.alive || source.zones.hand.length === 0) {
      drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
      return
    }
    host.askSkill({
      skillId: JINJIN, ownerId, step: 'source-discard', data: { sourceId, x },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: source.id,
        prompt: `【矜谨】：弃置至多${Math.min(x, source.zones.hand.length)}张牌`, timeoutMs: 20_000, optional: true,
        options: [
          ...Array.from({ length: Math.min(x, source.zones.hand.length) }, (_, index) => ({ id: String(index + 1), label: `弃${index + 1}张` })),
          { id: '0', label: '不弃置' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'source-discard') return
    const { sourceId, x } = resolution.data as { sourceId: PlayerId; x: number }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive) return
    const n = Number((response.payload as { optionId?: string }).optionId ?? '0')
    if (n > 0 && source?.alive) {
      const pool = [...source.zones.hand]
      const discardIds: CardId[] = []
      for (let index = 0; index < n && pool.length > 0; index += 1) {
        const [cardId] = pool.splice(host.rng.nextInt(pool.length), 1)
        discardIds.push(cardId)
      }
      for (const cardId of discardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
      if (discardIds.length > 0) host.dispatch('LoseCard', { playerId: sourceId, cardIds: discardIds, reason: JINJIN }, { sourceId: ownerId, targetId: sourceId, cardIds: discardIds })
    }
    const remaining = x - n
    if (remaining > 0) drawCards(host.state, host.rng, ownerId, remaining, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const QINLANG: CharacterDefinition = {
  id: 'qinlang',
  name: '秦朗',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: HAOCHONG, name: '昊宠', description: '使用一张牌后，可以将手牌数调整为当前手牌上限（单次最多摸5）；因此获得牌则手牌上限-1，因此失去牌则手牌上限+1。' },
    { id: JINJIN, name: '矜谨', description: '每个 TurnInstance 最多2次，造成或受到伤害后，可以将自己手牌上限重置为当前体力值，X=变化绝对值（至少1），伤害来源可弃置至多X张牌，你摸X-N张（N=其实际弃置数）。' },
  ],
}
