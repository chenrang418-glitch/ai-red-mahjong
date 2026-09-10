import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { declinedThisPhase, markDeclinedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { recover } from '../../engine/recover'
import { effectiveCardSuit, registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 步练师（一将成名 2012）。
 *
 * 【安恤】：出牌阶段限一次，你可以选择两名手牌数不同的其他角色，
 *          令其中手牌较少者获得手牌较多者的一张手牌，
 *          若此牌不是黑桃，你摸一张牌。
 * 【追忆】：当你死亡时，你可以令一名其他角色回复 1 点体力，然后摸两张牌。
 *
 * 六处最容易做错的：
 *
 * 1. **两名其他角色，而且手牌数必须不同**。相同就分不出谁多谁少，
 *    这个技能没有可执行的语义；一个人 0 张、另一个有牌是合法的。
 * 2. **步练师不许先看较多者的手牌**。挑牌走公共的暗手牌占位槽
 *    （`card-pick.ts`），而且**由获得者自己挑槽**——她全程只知道结果那一张。
 * 3. **花色在牌真正到手之后才查**，读的是有效花色（花色改写算数）。
 *    不是黑桃就摸一张：红桃、方块、梅花都摸。
 * 4. **追忆在真正阵亡之后**（`Death`）才有，被救回不触发；
 *    拥有者那时已经不在场上，所以触发器要声明 `allowDeadOwner`。
 * 5. **先回复 1 点体力，再摸两张**，顺序固定。
 * 6. **目标只能是其他存活角色**：不能选自己（她已经死了），也不能选死人。
 */

export const ANXU = 'anxu'
export const ZHUIYI = 'zhuiyi'
const ANXU_ACTION = 'anxu-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 除拥有者之外的存活角色。 */
function othersOf(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
}

/**
 * 现在存不存在一对「手牌数不同」的其他角色。
 *
 * 判据是**手牌数的集合大于一个值**，不是「有人有牌」：
 * 全场都是 3 张时一对都凑不出来，全场都是 0 张同理。
 */
function hasUnequalPair(state: SanguoshaState, ownerId: PlayerId): boolean {
  const counts = othersOf(state, ownerId).map((id) => playerOf(state, id)?.zones.hand.length ?? 0)
  return new Set(counts).size > 1
}

// ─────────────────────────────── 安恤 ───────────────────────────────

registerSkillRuntime({
  id: ANXU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, ANXU)) return []
    // 这个阶段里已经问过、结果没能落地：不再报出来，否则会跑成无限循环
    if (declinedThisPhase(state, ownerId, ANXU)) return []
    if (!hasUnequalPair(state, ownerId)) return []
    return [{ id: ANXU_ACTION, label: '安恤：令手牌少的角色获得手牌多的角色一张手牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ANXU_ACTION) return
    if (usedThisPhase(host.state, ownerId, ANXU)) return
    if (!hasUnequalPair(host.state, ownerId)) return
    host.askSkill({
      skillId: ANXU, ownerId, step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【安恤】：选择两名手牌数不同的其他角色',
        timeoutMs: 25_000,
        /*
         * **强制**：走到这一步说明确实存在合法的一对。
         *
         * 做成可取消的话，取消之后场面一点没变，同一条动作会被反复点开
         * ——压测里那就是个无限循环。要么不给这条动作，要么问到底。
         */
        optional: false,
        /*
         * 候选**按手牌数排序**再交出去。
         *
         * 「两人手牌数不同」是一条**成对**的约束，`choose-targets` 表达不了它，
         * 所以只能在候选顺序上帮一把：排序之后取头两个天然就是两端，
         * 一定合法。人类玩家仍然可以任选两个，落地那一步再校验。
         */
        candidateIds: [...othersOf(host.state, ownerId)].sort((left, right) => (
          (playerOf(host.state, left)?.zones.hand.length ?? 0) - (playerOf(host.state, right)?.zones.hand.length ?? 0)
        )),
        min: 2, max: 2,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const [first, second] = targetIds
      /*
       * 选出来的一对不合法（重复、有人已经死了、或者手牌数相同）：
       * 什么都不做，但**留下放弃记号**。
       *
       * 不留记号的话这条动作会原样重新出现，选出同样一对，
       * 再原样什么都不做——压测里这就是个无限循环（seed=god6-5-8）。
       */
      const decline = (): void => { markDeclinedThisPhase(host.state, ownerId, ANXU) }
      if (!owner?.alive || targetIds.length !== 2 || first === second) return decline()
      const low = playerOf(host.state, first)
      const high = playerOf(host.state, second)
      if (!low?.alive || !high?.alive) return decline()
      const counts = [low.zones.hand.length, high.zones.hand.length]
      // 手牌数相同就分不出多少：这不是一次合法的发动
      if (counts[0] === counts[1]) return decline()

      const lowerId = counts[0] < counts[1] ? low.id : high.id
      const higherId = counts[0] < counts[1] ? high.id : low.id
      markUsedThisPhase(host.state, ownerId, ANXU)
      host.dispatch('SkillActivated', {
        skillId: ANXU, skillName: '安恤', playerId: ownerId,
        logText: `${owner.nickname}发动【安恤】，${playerOf(host.state, lowerId)!.nickname}`
          + `获得${playerOf(host.state, higherId)!.nickname}的一张手牌`,
      }, { sourceId: ownerId, targetId: lowerId })

      /*
       * **由获得者挑槽，不是步练师。**
       *
       * 走公共的暗手牌占位槽：候选里只有「第几张」，没有牌名花色点数。
       * 让步练师来挑等于让她看一眼对方的手牌再决定，这个技能就不是它了。
       */
      const pickable = pickableCardsOf(host.state, higherId)
      if (pickable.hiddenCardSlots.length === 0) return
      host.askSkill({
        skillId: ANXU, ownerId: lowerId, step: 'pick', data: { anxuOwnerId: ownerId, higherId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: lowerId,
          prompt: `【安恤】：获得${playerOf(host.state, higherId)!.nickname}的一张手牌`,
          timeoutMs: 25_000, optional: false, purpose: 'skill',
          // 只给占位槽：装备区不在安恤的范围里
          cardIds: [], hiddenCardSlots: pickable.hiddenCardSlots,
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'pick') {
      // 这一步的 ownerId 是**获得者**，安恤的拥有者记在 data 里
      const lowerId = ownerId
      const anxuOwnerId = resolution.data.anxuOwnerId as PlayerId
      const higherId = resolution.data.higherId as PlayerId
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (!picked) return
      const cardId = resolvePickedCard(host.state, higherId, picked)
      if (!cardId) return
      if (!playerOf(host.state, lowerId)?.alive) return

      if (!movePickedCard(host, higherId, cardId, { kind: 'hand', playerId: lowerId })) return
      host.dispatch('LoseCard', { playerId: higherId, cardIds: [cardId], reason: ANXU }, { sourceId: higherId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: lowerId, cardIds: [cardId], reason: ANXU, sourcePlayerId: higherId }, { targetId: lowerId, cardIds: [cardId] })

      /*
       * **花色在牌到手之后才查**，而且读的是**有效花色**（花色改写算数）。
       *
       * 这张牌在战报里报出牌名：「是不是黑桃」这条判定所有人都要能验证。
       * 除这一张之外不泄漏任何东西——较多者剩下的手牌仍然是暗的。
       */
      const suit = effectiveCardSuit(host.state, lowerId, cardId)
      const card = host.state.cards[cardId]
      const anxuOwner = playerOf(host.state, anxuOwnerId)
      host.dispatch('SkillActivated', {
        skillId: ANXU, skillName: '安恤', playerId: anxuOwnerId, cardIds: [cardId],
        logText: `【安恤】转移的是【${card?.name ?? '未知'}】（${SUIT_LABEL[suit] ?? '无花色'}）`,
      }, { sourceId: anxuOwnerId, cardIds: [cardId] })

      if (suit !== 'spade' && anxuOwner?.alive) {
        drawCards(host.state, host.rng, anxuOwnerId, 1, (name, payload) => { host.dispatch(name, payload) })
      }
    }
  },
})

const SUIT_LABEL: Record<string, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }

// ─────────────────────────────── 追忆 ───────────────────────────────

registerSkillRuntime({
  id: ZHUIYI,
  /*
   * 追忆问的是**已经阵亡的步练师**：这一次决定合法地属于她。
   * 不声明这一条，「请求接收者必须存活」的不变量会把它当成漏网请求拦下来。
   */
  allowsDeadResponder: true,

  triggers: [{
    event: 'Death',
    /*
     * 追忆是**自己死的时候**发动的，触发时拥有者已经不在场上了。
     * 不声明这一条的话，触发器会把死人跳过去，技能一次也不会响。
     */
    allowDeadOwner: true,
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId !== ownerId) return
      /*
       * **排队，不当场发问。**
       *
       * 死亡结算还没走完：身份奖惩（反贼奖励三张、主公杀忠臣弃光）
       * 和胜负判定都排在 `Death` 之后。当场发问会把一个请求塞进
       * 一段还没收尾的流程中间；排队则等牌局回到干净状态再问，
       * 所以追忆结算在身份奖惩之后——这一条记在 ruleset 里。
       */
      host.queueSkill({
        skillId: ZHUIYI, ownerId, step: 'ask', data: {},
        // 排队的时候她已经死了：不声明这一条，队列会把这次发问直接丢掉
        allowDeadOwner: true,
      })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    // 只能选**其他存活角色**；她自己已经死了，所以这里天然不含她
    const candidateIds = othersOf(host.state, ownerId)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHUIYI, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【追忆】：令一名其他角色回复 1 点体力，然后摸两张牌',
        timeoutMs: 20_000,
        // 可以不发动：一个都不选就是放弃。这里没有活锁风险——死亡只发生一次
        optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (!targetId) return
    const target = playerOf(host.state, targetId)
    // 落地前重新验一次：排队期间他可能也死了
    if (!target?.alive || targetId === ownerId) return
    const owner = playerOf(host.state, ownerId)

    host.dispatch('SkillActivated', {
      skillId: ZHUIYI, skillName: '追忆', playerId: ownerId,
      logText: `${owner?.nickname ?? '步练师'}发动【追忆】，令${target.nickname}回复 1 点体力并摸两张牌`,
    }, { sourceId: ownerId, targetId })

    // **顺序固定：先回复，再摸牌。**
    recover(host as never, targetId, 1, ownerId)
    if (!playerOf(host.state, targetId)?.alive) return
    drawCards(host.state, host.rng, targetId, 2, (name, payload) => { host.dispatch(name, payload) })
  },
})

export const BULIANSHI: CharacterDefinition = {
  id: 'bulianshi',
  name: '步练师',
  kingdom: 'wu',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2012',
  skills: [
    {
      id: ANXU,
      name: '安恤',
      description: '出牌阶段限一次，你可以选择两名手牌数不同的其他角色，令其中手牌较少者获得手牌较多者的一张手牌，若此牌不是黑桃，你摸一张牌。',
    },
    {
      id: ZHUIYI,
      name: '追忆',
      description: '当你死亡时，你可以令一名其他角色回复1点体力，然后摸两张牌。',
    },
  ],
}
