import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 糜竺（三国杀 OL 经典身份 SP）。
 *
 * 【资援】：出牌阶段限一次，选择至少一张手牌，点数总和恰好为 13，全部交给
 *          一名其他角色，该角色回复 1 点体力。
 * 【巨贾】：锁定技，游戏开始时额外摸 X 张牌，手牌上限 +X（X 为当前体力上限，
 *          两处都动态读取，不写死开局那个数）。
 *
 * 最容易做错的：**「能不能发动」只做一次可行性判断（子集和 DP，牌数很少，
 * 开销可以忽略），具体选哪些牌完全交给玩家**，不在服务端枚举/推荐组合。
 */

const ZIYUAN = 'ziyuan'
const JUGU = 'jugu'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 手牌里找一个点数总和恰好为 13 的非空子集（子集和 DP + 回溯，牌数很少，
 * 开销可以忽略），没有就返回 null。
 *
 * **只找一个，不枚举全部方案**：真人/AI 都不需要在多个等价方案里选，
 * 找到能凑出 13 的这一种就够了——枚举全部反而是无意义的额外复杂度，
 * 而且只给一个可行解还避免了「选出的牌凑不出 13」时无限重问的死循环
 * （AI 不知道该选哪几张，压测 seed=bisect-mizhu-1 抓到过）。
 */
function findSubsetSummingTo13(state: SanguoshaState, hand: readonly CardId[]): CardId[] | null {
  // reachable[s] = 用到第几张牌时首次凑出和 s；用于回溯还原选中的牌
  const reachedAt = new Map<number, number>([[0, -1]])
  const chosenCard: number[] = []
  for (let index = 0; index < hand.length; index += 1) {
    const rank = state.cards[hand[index]]?.rank ?? 0
    if (rank <= 0) continue
    for (const sum of [...reachedAt.keys()]) {
      const next = sum + rank
      if (next > 13 || reachedAt.has(next)) continue
      reachedAt.set(next, index)
      chosenCard[next] = index
    }
    if (reachedAt.has(13)) break
  }
  if (!reachedAt.has(13)) return null
  const result: CardId[] = []
  let sum = 13
  while (sum > 0) {
    const index = chosenCard[sum]
    result.push(hand[index])
    sum -= state.cards[hand[index]]?.rank ?? 0
  }
  return result
}

registerSkillRuntime({
  id: ZIYUAN,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, ZIYUAN)) return []
    if (!state.players.some((candidate) => candidate.alive && candidate.id !== ownerId)) return []
    if (!findSubsetSummingTo13(state, owner.zones.hand)) return []
    return [{ id: ZIYUAN, label: '资援：选择点数总和为 13 的手牌，交给一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZIYUAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const combo = findSubsetSummingTo13(host.state, owner.zones.hand)
    if (!combo) return
    /*
     * 只把找到的这一组牌摆出来确认，不开放「随便选，最后再校验总和」——
     * 那样通用 AI 选不中恰好凑出 13 的组合时会一直重问，永远卡在这一步
     * （压测复现：seed=bisect-mizhu-1）。玩家/AI 只需要确认发不发动。
     */
    host.askSkill({
      skillId: ZIYUAN, ownerId, step: 'pick', data: { cardIds: combo },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【资援】：交出这 ${combo.length} 张牌（点数总和 13）`,
        timeoutMs: 25_000, optional: false, purpose: 'skill',
        cardIds: combo, hiddenCardSlots: [], min: combo.length, max: combo.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'pick') {
      const owner = playerOf(host.state, ownerId)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((cardId) => owner?.zones.hand.includes(cardId))
      const expected = resolution.data.cardIds as CardId[]
      if (!owner?.alive || cardIds.length !== expected.length) return
      const sum = cardIds.reduce((total, cardId) => total + (host.state.cards[cardId]?.rank ?? 0), 0)
      if (sum !== 13) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZIYUAN, ownerId, step: 'target', data: { cardIds },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【资援】：选择一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const cardIds = resolution.data.cardIds as CardId[]
      const owner = playerOf(host.state, ownerId)
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const validCardIds = cardIds.filter((cardId) => owner?.zones.hand.includes(cardId))
      if (!owner?.alive || !target?.alive || validCardIds.length !== cardIds.length) return
      markUsedThisTurn(host.state, ownerId, ZIYUAN)
      for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId! })
      host.dispatch('GainCard', { playerId: targetId!, cardIds, reason: ZIYUAN }, { sourceId: ownerId, targetId, cardIds })
      host.dispatch('SkillActivated', {
        skillId: ZIYUAN, skillName: '资援', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【资援】，${target.nickname}回复 1 点体力`,
      }, { sourceId: ownerId, targetId })
      recover(host as never, targetId!, 1, ownerId)
    }
  },
})

registerSkillRuntime({
  id: JUGU,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const x = owner.maxHp
    if (x > 0) drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
  },

  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    return owner?.alive ? owner.maxHp : 0
  },
})

export const MIZHU: CharacterDefinition = {
  id: 'mizhu',
  name: '糜竺',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: ZIYUAN,
      name: '资援',
      description: '出牌阶段限一次，选择至少一张手牌，点数总和恰好为 13，全部交给一名其他角色，该角色回复 1 点体力。',
    },
    {
      id: JUGU,
      name: '巨贾',
      description: '锁定技，游戏开始时额外摸 X 张牌，手牌上限 +X（X 为当前体力上限）。',
      locked: true,
    },
  ],
}
