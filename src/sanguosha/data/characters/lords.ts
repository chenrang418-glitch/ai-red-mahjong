import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition, Kingdom } from './types'

/**
 * 三位主公，以及主公技。
 *
 * 主公技只在坐主公位时生效，所以每个钩子第一件事都是确认 `identity === 'lord'`——
 * 这是规则，不是引擎该替技能猜的事。
 *
 * 护驾和激将走同一套「代打」机制：目标自己打不出时，引擎按势力顺序问同势力角色。
 * 询问进度记在结算状态里（`SlashResolutionState.surrogate` / 锦囊 effect 的 surrogate），
 * 完全可序列化，Durable Object 中途休眠也接得上。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

/** 从主公开始按座次绕一圈，找出同势力的其他存活角色。 */
function sameKingdomAllies(state: SanguoshaState, lordId: PlayerId, kingdom: Kingdom): PlayerId[] {
  const lord = state.players.find((player) => player.id === lordId)
  if (!lord || lord.identity !== 'lord') return []
  const allies: PlayerId[] = []
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(lord.seat + offset) % state.players.length]
    if (!candidate.alive || !candidate.characterId) continue
    if (kingdomOf(candidate.characterId) === kingdom) allies.push(candidate.id)
  }
  return allies
}

/** 延迟到运行时再查，避免和 STANDARD_CHARACTERS 的定义顺序绑死。 */
let kingdomLookup: ((characterId: string) => Kingdom | undefined) | null = null
export function provideKingdomLookup(lookup: (characterId: string) => Kingdom | undefined): void {
  kingdomLookup = lookup
}
export function kingdomOf(characterId: string): Kingdom | undefined {
  return kingdomLookup?.(characterId)
}

// —— 曹操 主公技【护驾】——
registerSkillRuntime({
  id: 'hujia',
  surrogateResponders(state, ownerId, requiredCardName) {
    if (requiredCardName !== '闪') return []
    return sameKingdomAllies(state, ownerId, 'wei')
  },
})

// —— 刘备【仁德】——
registerSkillRuntime({
  id: 'rende',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive || owner.zones.hand.length === 0) return []
    if (!state.players.some((player) => player.alive && player.id !== ownerId)) return []
    return [{ id: 'skill:rende', label: '发动【仁德】：把手牌交给其他角色，给出两张后回复一点体力' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:rende') throw new Error('仁德动作不匹配')
    const owner = playerOf(host.state, ownerId)
    host.askSkill({
      skillId: 'rende',
      ownerId,
      step: 'cards',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '选择要交出去的手牌',
        timeoutMs: 25_000,
        optional: false,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 1,
        max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'cards') {
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
      const candidateIds = host.state.players.filter((player) => player.alive && player.id !== ownerId).map((player) => player.id)
      host.askSkill({
        skillId: 'rende',
        ownerId,
        step: 'target',
        data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: '把这些牌交给谁',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    const cardIds = resolution.data.cardIds as CardId[]
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    const owner = playerOf(host.state, ownerId)
    const target = host.state.players.find((player) => player.id === targetId)
    if (!target?.alive) return
    const given: CardId[] = []
    for (const cardId of cardIds) {
      if (!owner.zones.hand.includes(cardId)) continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
      given.push(cardId)
    }
    if (given.length === 0) return
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: given, reason: '仁德' }, { sourceId: ownerId, cardIds: given })
    host.dispatch('GainCard', { playerId: targetId, cardIds: given, reason: '仁德' }, { targetId, cardIds: given })

    // 一个回合内累计给出两张才回血，而且只回一次
    const marks = owner.marks
    marks.rendeGiven = (marks.rendeGiven ?? 0) + given.length
    if (marks.rendeGiven >= 2 && !usedThisTurn(host.state, ownerId, 'rende-recover')) {
      markUsedThisTurn(host.state, ownerId, 'rende-recover')
      recover(host, ownerId, 1, ownerId)
    }
  },
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId) {
      // 计数只在本回合有效
      const owner = host.state.players.find((candidate) => candidate.id === ownerId)
      if (!owner) return
      delete owner.marks.rendeGiven
    },
  }],
})

// —— 刘备 主公技【激将】——
registerSkillRuntime({
  id: 'jijiang',
  surrogateResponders(state, ownerId, requiredCardName) {
    if (requiredCardName !== '杀') return []
    return sameKingdomAllies(state, ownerId, 'shu')
  },
})

// —— 孙权【制衡】——
registerSkillRuntime({
  id: 'zhiheng',
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive || owner.zones.hand.length === 0) return []
    if (usedThisTurn(state, ownerId, 'zhiheng')) return []
    return [{ id: 'skill:zhiheng', label: '发动【制衡】：弃置任意张牌，摸等量的牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== 'skill:zhiheng') throw new Error('制衡动作不匹配')
    const owner = playerOf(host.state, ownerId)
    host.askSkill({
      skillId: 'zhiheng',
      ownerId,
      step: 'discard',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '弃置任意张手牌，然后摸等量的牌',
        timeoutMs: 25_000,
        optional: false,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 1,
        max: owner.zones.hand.length,
      }),
    })
  },
  resume(host, ownerId, _resolution, response) {
    const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
    const owner = playerOf(host.state, ownerId)
    const discarded: CardId[] = []
    for (const cardId of cardIds) {
      if (!owner.zones.hand.includes(cardId)) continue
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      discarded.push(cardId)
    }
    if (discarded.length === 0) return
    markUsedThisTurn(host.state, ownerId, 'zhiheng')
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: '制衡' }, { sourceId: ownerId, cardIds: discarded })
    drawInto(host, ownerId, discarded.length, '制衡')
  },
})

// —— 孙权 主公技【救援】——
registerSkillRuntime({
  id: 'jiuyuan',
  rescueRecoverBonus(state, ownerId, responderId) {
    const owner = state.players.find((player) => player.id === ownerId)
    if (owner?.identity !== 'lord') return 0
    const responder = state.players.find((player) => player.id === responderId)
    if (!responder?.characterId || kingdomOf(responder.characterId) !== 'wu') return 0
    return 1
  },
})

function drawInto(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  const owner = playerOf(host.state, playerId)
  const drawn: CardId[] = []
  for (let index = 0; index < count; index += 1) {
    const cardId = host.state.zones.drawPile.shift()
    if (!cardId) break
    owner.zones.hand.push(cardId)
    drawn.push(cardId)
  }
  if (drawn.length > 0) host.dispatch('GainCard', { playerId, cardIds: drawn, reason }, { targetId: playerId, cardIds: drawn })
}

/**
 * 把某个角色本回合的限次记录清掉。测试用。
 *
 * 正常牌局里由 `turn.ts` 在回合结束统一清，技能不需要各自注册重置。
 */
export function resetTurnLimitedSkills(state: SanguoshaState, playerId: PlayerId): void {
  const owner = state.players.find((player) => player.id === playerId)
  if (!owner) return
  owner.turnUsedSkills = []
}

export const LORD_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'liubei',
    name: '刘备',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [
      { id: 'rende', name: '仁德', description: '出牌阶段，你可以将任意张手牌交给其他角色；你在一个回合内以此法给出两张或更多牌后，回复一点体力。' },
      { id: 'jijiang', name: '激将', description: '主公技。你需要打出【杀】时，其他蜀势力角色可以代你打出。' },
    ],
  },
  {
    id: 'sunquan',
    name: '孙权',
    kingdom: 'wu',
    gender: 'male',
    maxHp: 4,
    pack: 'standard',
    skills: [
      { id: 'zhiheng', name: '制衡', description: '出牌阶段限一次，你可以弃置任意张手牌，然后摸等量的牌。' },
      { id: 'jiuyuan', name: '救援', description: '主公技。其他吴势力角色对你使用【桃】时，你额外回复一点体力。' },
    ],
  },
] as const
