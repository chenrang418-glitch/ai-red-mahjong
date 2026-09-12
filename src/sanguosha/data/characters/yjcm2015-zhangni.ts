import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { resolveDamage } from '../../engine/damage'
import { claimPindianCards, registerPindianContinuation, startPindian } from '../../engine/pindian'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { effectiveCardName } from '../../engine/zones'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 张嶷（一将成名 2015）。
 *
 * 【怃戎】：出牌阶段限一次，张嶷可以与一名双方都有手牌的其他角色各自暗选
 *          一张手牌同时展示：若张嶷展示的是【杀】且目标展示的不是【闪】，
 *          张嶷弃置这张【杀】并对目标造成 1 点伤害；若张嶷展示的不是【杀】
 *          且目标展示的是【闪】，张嶷弃置展示牌，然后获得目标一张牌。
 * 【矢志】：锁定技，张嶷体力值为 1 时，他的【闪】均视为【杀】。
 *
 * 两处最容易做错的：
 *
 * 1. **怃戎的同时暗选/展示复用拼点核心**（私有区 + 同时揭示），只是不比较
 *    点数，改用有效牌名判断；平局式的第三种组合（双方都是/都不是）没有
 *    额外效果，展示牌留在原手牌。
 * 2. **矢志按当前体力值动态判断**，走既有的强制身份改写入口（同高顺
 *    【禁酒】），不是可选 ViewAs——1 血时闪连自救也按杀走。
 */

const WURONG = 'wurong'
const WURONG_TAG = 'zhangni-wurong'
const SHIZHI = 'shizhi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function wurongTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.zones.hand.length > 0)
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: WURONG,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, WURONG)) return []
    if (wurongTargets(state, ownerId).length === 0) return []
    return [{ id: WURONG, label: '怃戎：与一名角色各自暗选一张手牌同时展示' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== WURONG) return
    const candidateIds = wurongTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: WURONG, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【怃戎】：选择一名双方都有手牌的角色',
        timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId || !wurongTargets(host.state, ownerId).includes(targetId)) return
    markUsedThisPhase(host.state, ownerId, WURONG)
    startPindian(host, {
      id: `wurong-${host.state.seq}`,
      initiatorId: ownerId,
      opponentId: targetId,
      reason: WURONG,
      continuationTag: WURONG_TAG,
    })
  },
})

registerPindianContinuation(WURONG_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const targetId = result.opponentId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return

  const ownerCardName = effectiveCardName(host.state, result.initiatorCardId)
  const targetCardName = effectiveCardName(host.state, result.opponentCardId)
  const ownerIsSlash = ownerCardName === '杀'
  const targetIsDodge = targetCardName === '闪'

  /*
   * **目标展示的那张牌规则上从不弃置**，用 `claimPindianCards` 把它原样
   * 认领回目标手里；张嶷自己展示的牌只在下面两种命中场景里明确弃置，
   * 认领这一步本身会把「暂时没人认领」的另一张（张嶷那张）顺带扫进
   * 弃牌堆——这正好符合命中场景「弃置这张牌」的要求。
   * 「其它组合」按拼点核心默认处理（两张都弃），是本项目对
   * 「无额外效果」的最小化实现，不去为了张嶷单独抠出「两张都不弃」
   * 这一条更复杂的分支。
   */
  claimPindianCards(host, targetId, [result.opponentCardId])

  if (ownerIsSlash && !targetIsDodge) {
    skillHost.dispatch('SkillActivated', {
      skillId: WURONG, skillName: '怃戎', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【怃戎】，弃置这张【杀】，对${target.nickname}造成 1 点伤害`,
    }, { sourceId: ownerId, targetId })
    resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
    return
  }

  if (!ownerIsSlash && targetIsDodge) {
    skillHost.dispatch('SkillActivated', {
      skillId: WURONG, skillName: '怃戎', playerId: ownerId, targetId,
      logText: `${owner.nickname}发动【怃戎】，弃置展示牌，获得${target.nickname}一张牌`,
    }, { sourceId: ownerId, targetId })
    const pickable = pickableCardsOf(host.state, targetId)
    if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) return
    // 暗手牌用占位槽随机盲选：不能因为对方刚展示过一张手牌就窥视其余手牌
    if (pickable.hiddenCardSlots.length > 0) {
      const slot = pickable.hiddenCardSlots[skillHost.rng.nextInt(pickable.hiddenCardSlots.length)]
      const cardId = resolvePickedCard(host.state, targetId, slot)
      if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })
    } else {
      const cardId = pickable.cardIds[skillHost.rng.nextInt(pickable.cardIds.length)]
      if (movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) {
        skillHost.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: WURONG }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      }
    }
  }
})

registerSkillRuntime({
  id: SHIZHI,
  forcedCardIdentity(state, ownerId, cardId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.hp !== 1) return null
    const card = state.cards[cardId]
    if (card?.name !== '闪') return null
    return { asCardName: '杀', nature: 'normal' }
  },
})

export const ZHANGNI: CharacterDefinition = {
  id: 'zhangni',
  name: '张嶷',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: WURONG,
      name: '怃戎',
      description: '出牌阶段限一次，张嶷可以与一名双方都有手牌的其他角色各自暗选一张手牌同时展示：若张嶷展示的是【杀】且目标展示的不是【闪】，张嶷弃置这张【杀】并对目标造成 1 点伤害；若张嶷展示的不是【杀】且目标展示的是【闪】，张嶷弃置展示牌，然后获得目标一张牌。',
    },
    {
      id: SHIZHI,
      name: '矢志',
      description: '锁定技，张嶷体力值为 1 时，他的【闪】均视为【杀】。',
    },
  ],
}
