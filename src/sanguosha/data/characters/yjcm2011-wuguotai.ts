import { isBasicCard } from '../../engine/damage-provenance'
import { equipmentCountOf, exchangeEquipmentZones } from '../../engine/equipment-exchange'
import { recover } from '../../engine/recover'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 吴国太（一将成名 2011 经典）。
 *
 * 【甘露】：出牌阶段限一次，你可以令两名角色交换装备区里的牌
 *          （这两名角色装备区里的牌数之差不大于 X，X 为你已损失的体力值）。
 * 【补益】：一名角色进入濒死状态时，你可以展示其一张手牌，
 *          若此牌不是基本牌，则该角色弃置此牌并回复 1 点体力。
 *
 * 六处最容易做错的：
 *
 * 1. **X 是已损失体力值，现算**（`maxHp - hp`）：满血时 X = 0，
 *    只能选装备数相同的两人。不能写死成「3 - hp」。
 * 2. **可以选自己**：文本是「两名角色」，没有「其他」。
 * 3. **整体互换，必须原子完成**，而且放不下的牌按规则弃置——
 *    这些都在公共的装备交换入口里，技能本身不碰装备区。
 * 4. **补益展示的手牌由服务端随机确定**：吴国太不能先看完对方的手牌再挑。
 * 5. **只回 1 点**：目标体力为负时回到 -1 或 0 仍然处于濒死，流程继续。
 * 6. **补益不是使用锦囊**，不能被【无懈可击】响应；它走的是濒死救援的
 *    统一时机，和【桃】排在同一条队伍里。
 */

const GANLU = 'ganlu'
const BUYI = 'buyi'
const GANLU_ACTION = 'ganlu-invoke'
const BUYI_RESCUE_ACTION = 'buyi-rescue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** X：吴国太已损失的体力值。**现算**，上限变了立刻跟着变。 */
function lostHpOf(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  return Math.max(0, owner.maxHp - owner.hp)
}

// ─────────────────────────────── 甘露 ───────────────────────────────

/** `left` 和 `right` 现在是不是一对合法目标。 */
function ganluPairLegal(host: SkillHost, ownerId: PlayerId, leftId: PlayerId, rightId: PlayerId): boolean {
  if (leftId === rightId) return false
  const left = playerOf(host.state, leftId)
  const right = playerOf(host.state, rightId)
  if (!left?.alive || !right?.alive) return false
  const difference = Math.abs(equipmentCountOf(host, leftId) - equipmentCountOf(host, rightId))
  return difference <= lostHpOf(host.state, ownerId)
}

/** 和 `playerId` 组得成合法一对的人。 */
function ganluPartnersOf(host: SkillHost, ownerId: PlayerId, playerId: PlayerId): PlayerId[] {
  return host.state.players
    .filter((candidate) => candidate.alive && ganluPairLegal(host, ownerId, playerId, candidate.id))
    .map((candidate) => candidate.id)
}

/**
 * 现在有哪些人能当**第一名**目标：至少能和一个人组成合法配对。
 *
 * 「先给全场候选、选完两个再判合法」是不行的：选出一对非法组合时技能
 * 什么都不做、也不计次，动作又回到合法动作列表里——压测里当场变成
 * 「invoke → 选目标 → 什么都没发生 → invoke」的死循环（seed=ci-5-11）。
 * 所以候选必须**只包含真的走得通的人**。
 */
function ganluFirstCandidates(host: SkillHost, ownerId: PlayerId): PlayerId[] {
  return host.state.players
    .filter((candidate) => candidate.alive && ganluPartnersOf(host, ownerId, candidate.id).length > 0)
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: GANLU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisTurn(state, ownerId, GANLU)) return []
    // 没有任何合法配对时不给入口：给了也只能空转
    if (ganluFirstCandidates({ state } as SkillHost, ownerId).length === 0) return []
    return [{ id: GANLU_ACTION, label: '甘露：令两名角色交换装备区里的牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== GANLU_ACTION) return
    const candidateIds = ganluFirstCandidates(host, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: GANLU, ownerId, step: 'first',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【甘露】：选择第一名角色（两人装备数之差不大于 ${lostHpOf(host.state, ownerId)}）`,
        timeoutMs: 25_000,
        /*
         * **必答**：点技能这一下就是发动，选人不再是一个可以反悔的窗口。
         *
         * 留成可取消的话，「发动 → 取消 → 技能没计次 → 动作又回到列表里」
         * 是一个纯粹的空转，压测里当场变成死循环（seed=yjcm11b2-5-25）。
         * 入口本身已经保证了「一定存在合法配对」，所以这里永远选得出人。
         */
        optional: false,
        // 自己也在候选里：文本是「两名角色」，没有「其他」
        candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'first') {
      const [leftId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!leftId) return
      const partnerIds = ganluPartnersOf(host, ownerId, leftId)
      if (partnerIds.length === 0) return
      /*
       * **选定第一名就计次。**
       *
       * 到这一步技能已经确定要发动了；不在这里计次的话，第二步再取消就等于
       * 白发动一次，动作又回到列表里，压测立刻转成死循环。
       */
      markUsedThisTurn(host.state, ownerId, GANLU)
      host.askSkill({
        skillId: GANLU, ownerId, step: 'second', data: { leftId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【甘露】：选择与${playerOf(host.state, leftId)?.nickname ?? ''}交换装备区的角色`,
          timeoutMs: 25_000, optional: false,
          // 候选里只有**和他组得成合法配对**的人
          candidateIds: partnerIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'second') {
      const leftId = resolution.data.leftId as PlayerId
      const [rightId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!rightId) return
      /*
       * 落地前重新验一次：发问期间装备可能已经被拆、被顺，
       * 吴国太自己也可能掉血让 X 变大。服务端不信发问时的那份快照。
       */
      if (!ganluPairLegal(host, ownerId, leftId, rightId)) return
      const owner = playerOf(host.state, ownerId)
      const left = playerOf(host.state, leftId)
      const right = playerOf(host.state, rightId)
      host.dispatch('SkillActivated', {
        skillId: GANLU, skillName: '甘露', playerId: ownerId, targetIds: [leftId, rightId],
        logText: `${owner?.nickname ?? ''}发动【甘露】，${left?.nickname ?? ''}与${right?.nickname ?? ''}交换装备区`,
      }, { sourceId: ownerId })
      exchangeEquipmentZones(host as never, leftId, rightId)
    }
  },
})

// ─────────────────────────────── 补益 ───────────────────────────────

/**
 * 「这是他本局第几次濒死」。
 *
 * 引擎在濒死真正开始的那一刻记一次，中途问了多少人要桃都不影响它，
 * 所以拿它当「同一次濒死」的标识是稳的。**不要用布尔标记**：
 * 那样同一个人第二次濒死时补益就永远发动不了了。
 */
function dyingInstanceOf(dying: { dyingEntryCount?: number }): number {
  return dying.dyingEntryCount ?? 1
}

/** 记号名带上拥有者：多个吴国太同桌时各记各的。 */
function usedMark(ownerId: PlayerId): string {
  return `buyi-used:${ownerId}`
}

registerSkillRuntime({
  id: BUYI,
  /*
   * 补益挂在**濒死救援**的统一时机上，和【桃】排在同一条队伍里。
   *
   * 不另起一套「进入濒死时先问补益」：那样会和不屈、神霈、破围这些
   * 濒死期技能抢顺序，而且回复 1 点体力本来就该计入「还差几点才脱离濒死」。
   */
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = state.players.find((candidate) => candidate.id === ownerId)
    const dying = state.players.find((candidate) => candidate.id === dyingPlayerId)
    if (!owner?.alive || !dying?.alive) return []
    // 目标没有手牌就展示不了，不给一个必然落空的选项
    if (dying.zones.hand.length === 0) return []
    // **这次濒死已经发动过就不再给**（见下面的 usedMark 说明）
    if (dying.marks[usedMark(ownerId)] === dyingInstanceOf(dying)) return []
    return [{ id: BUYI_RESCUE_ACTION, label: '发动【补益】：展示其一张手牌' }]
  },

  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== BUYI_RESCUE_ACTION) return false
    const owner = playerOf(host.state, ownerId)
    const dying = playerOf(host.state, dyingPlayerId)
    if (!owner?.alive || !dying?.alive || dying.zones.hand.length === 0) return false

    /*
     * **由服务端随机取一张**：吴国太看不到对方的手牌，
     * 也就不能挑。用局内 RNG，回放和重连走出同一张牌。
     */
    if (dying.marks[usedMark(ownerId)] === dyingInstanceOf(dying)) return false
    /*
     * **一次濒死只发动一次。**
     *
     * 展示到基本牌时补益什么都不改变；不记这一笔的话，救援轮询会把同一个人
     * 一直问下去，牌局当场死循环（专项测试 wgt-buyi-basic 抓到过）。
     * 记的是「第几次濒死」而不是布尔值：同一个人这一局再次濒死时还能再发动。
     */
    dying.marks[usedMark(ownerId)] = dyingInstanceOf(dying)

    const cardId: CardId = dying.zones.hand[host.rng.nextInt(dying.zones.hand.length)]
    host.dispatch('SkillActivated', {
      skillId: BUYI, skillName: '补益', playerId: ownerId, targetId: dyingPlayerId,
      logText: `${owner.nickname}发动【补益】，展示${dying.nickname}的一张手牌`,
    }, { sourceId: ownerId, targetId: dyingPlayerId })
    /*
     * 展示：牌先进处理区公开亮出。
     * 是基本牌就原样回到手上——**已经展示过**这件事本身是公开信息，
     * 但牌仍然是他的。
     */
    moveCard(host.state, cardId, { kind: 'hand', playerId: dyingPlayerId }, { kind: 'processingArea' })
    host.dispatch('CardMove', { cardIds: [cardId], reason: BUYI, revealed: true }, { cardIds: [cardId] })

    if (isBasicCard(host.state, cardId)) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: dyingPlayerId })
      return true
    }
    // 非基本牌：弃置，然后回复 1 点
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' }, { discardReason: 'discard' })
    host.dispatch('LoseCard', { playerId: dyingPlayerId, cardIds: [cardId], reason: BUYI }, { targetId: dyingPlayerId, cardIds: [cardId] })
    recover(host as never, dyingPlayerId, 1, BUYI)
    return true
  },
})

export const WUGUOTAI: CharacterDefinition = {
  id: 'wuguotai',
  name: '吴国太',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: GANLU,
      name: '甘露',
      description: '出牌阶段限一次，你可以令两名角色交换装备区里的牌'
        + '（这两名角色装备区里的牌数之差不大于 X，X 为你已损失的体力值）。',
    },
    {
      id: BUYI,
      name: '补益',
      description: '一名角色进入濒死状态时，你可以展示其一张手牌，'
        + '若此牌不是基本牌，则该角色弃置此牌并回复 1 点体力。',
    },
  ],
}
