import { lockCardColor } from '../../engine/card-play-lock'
import { getDistance } from '../../engine/distance'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { effectiveCardColor, registerSkillRuntime } from '../../engine/skills/runtime'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 马岱（一将成名 2012）。
 *
 * 【潜袭】：准备阶段，你可以摸一张牌然后弃置一张牌，若如此做，你选择一名
 *          距离为 1 的其他角色，直到回合结束，其不能使用或打出与你以此法
 *          弃置的牌颜色相同的手牌。
 * 【马术】：锁定技，你计算与其他角色的距离时 -1。（复用既有运行时）
 *
 * 五处最容易做错的：
 *
 * 1. **顺序固定**：先摸、再弃、最后选目标。弃出去那张牌的颜色决定禁什么，
 *    所以目标必须在弃牌之后才选。
 * 2. **目标是「距离恰好为 1」**，不是「不大于 1」。距离走引擎的统一口径
 *    （`getDistance`），马术和马匹都算在内——自己重算一遍迟早和引擎对不上。
 * 3. **弃牌之后重新算距离**：弃掉自己的进攻马会当场改变距离，
 *    候选必须在那之后才列。
 * 4. **禁的是手牌的「使用或打出」**，不禁弃置、交给别人、被顺被拆；
 *    装备区和判定区不受影响。转化技的子牌同样被禁——公共的
 *    `card-play-lock` 拿到的是实体牌。
 * 5. **无色的牌不产生禁令**（武将牌变的装备那一类）。技能仍然算发动过，
 *    只是没有可比的颜色。
 */

export const QIANXI = 'qianxi'
const QIANXI_INVOKE = 'qianxi-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 区域内可以弃置的牌：手牌 + 装备区，判定区不算。 */
function discardableOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const equipment = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
  return [...owner.zones.hand, ...equipment]
}

/** 距离**恰好为 1** 的其他角色。 */
function distanceOneTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => getDistance(state, ownerId, candidate.id) === 1)
    .map((candidate) => candidate.id)
}

const COLOR_LABEL: Record<'red' | 'black', string> = { red: '红色', black: '黑色' }

registerSkillRuntime({
  id: QIANXI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'prepare') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.askSkill({
        skillId: QIANXI, ownerId, step: 'invoke',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '发动【潜袭】？摸一张牌然后弃置一张牌',
          timeoutMs: 20_000, optional: true,
          options: [
            { id: QIANXI_INVOKE, label: '发动【潜袭】' },
            { id: 'cancel', label: '不发动' },
          ],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== QIANXI_INVOKE) return
      if (!owner?.alive) return
      host.dispatch('SkillActivated', {
        skillId: QIANXI, skillName: '潜袭', playerId: ownerId,
        logText: `${owner.nickname}发动【潜袭】`,
      }, { sourceId: ownerId })
      drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
      /*
       * 摸完之后一定有牌可弃（刚摸的那一张就在手上），所以这一问是**强制**的。
       *
       * 做成可取消的话会出现「摸了一张但什么都没弃」——那既不是发动也不是
       * 不发动，规则上没有这种中间状态。
       */
      const discardable = discardableOf(host.state, ownerId)
      if (discardable.length === 0) return
      host.askSkill({
        skillId: QIANXI, ownerId, step: 'discard',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【潜袭】：弃置一张牌，其颜色决定禁令',
          timeoutMs: 25_000, optional: false, purpose: 'skill',
          cardIds: discardable, hiddenCardSlots: [],
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (!owner?.alive || !cardId) return
      const from = locateOwnedCard(host.state, ownerId, cardId)
      if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) return

      // 颜色要在牌**离场之前**读：进弃牌堆时颜色改写会被一并清掉
      const color = effectiveCardColor(host.state, ownerId, cardId)
      moveCard(host.state, cardId, from, { kind: 'discardPile' })
      if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: QIANXI }, { sourceId: ownerId, cardIds: [cardId] })

      /*
       * **弃牌之后才算距离、才列候选。**
       *
       * 弃掉的可能正是自己的进攻马，那会当场把「距离为 1」的人换一批。
       * 先列候选再弃牌就会拿一份过期的名单去问。
       */
      if (color === null) {
        // 无色的牌产生不了颜色限制；技能仍然算发动过，不再问目标
        host.dispatch('SkillActivated', {
          skillId: QIANXI, skillName: '潜袭', playerId: ownerId,
          logText: `${owner.nickname}以【潜袭】弃置的牌没有颜色，不产生限制`,
        }, { sourceId: ownerId })
        return
      }
      const candidateIds = distanceOneTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: QIANXI, ownerId, step: 'target', data: { color },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【潜袭】：选择一名距离为 1 的角色，其本回合不能使用或打出${COLOR_LABEL[color]}手牌`,
          timeoutMs: 25_000,
          /*
           * 这一问同样是**强制**的：可取消的话，取消之后技能已经付过代价
           * （摸了、弃了）却什么都没发生，而且既有的教训是——
           * 可取消又不消耗次数的问会在压测里变成活锁。
           */
          optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const color = resolution.data.color as 'red' | 'black'
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!owner?.alive || !targetId) return
      const target = playerOf(host.state, targetId)
      // 落地前重新验一次：发问期间有人可能阵亡、距离可能变了
      if (!target?.alive || !distanceOneTargets(host.state, ownerId).includes(targetId)) return
      if (!lockCardColor(host.state, { targetId, color, sourceId: ownerId, skillId: QIANXI })) return
      host.dispatch('SkillActivated', {
        skillId: QIANXI, skillName: '潜袭', playerId: ownerId,
        logText: `${owner.nickname}的【潜袭】令${target.nickname}本回合不能使用或打出${COLOR_LABEL[color]}手牌`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

export const MADAI: CharacterDefinition = {
  id: 'madai',
  name: '马岱',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: QIANXI,
      name: '潜袭',
      description: '准备阶段，你可以摸一张牌然后弃置一张牌，若如此做，你选择一名距离为1的其他角色，直到回合结束，其不能使用或打出与你以此法弃置的牌颜色相同的手牌。',
    },
    // 马术复用标准包里既有的那一份运行时，不另写
    { id: 'mashu', name: '马术', description: '锁定技，你计算与其他角色的距离时，始终减一。' },
  ],
}
