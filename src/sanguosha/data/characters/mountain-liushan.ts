import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { queueExtraTurn, skipPhase } from '../../engine/turn'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 山包·刘禅。本项目自研表述。3 体力。
 *
 * 原文：
 * - **享乐**：锁定技，当你成为【杀】的目标时，除非该【杀】的使用者弃置一张基本牌，
 *   否则此【杀】对你无效。
 * - **放权**：你可以跳过你的出牌阶段，若如此做，你于此回合的结束阶段可以弃置
 *   一张手牌并令一名其他角色进行一个额外的回合。
 * - **若愚**：主公技，觉醒技，准备阶段，若你的体力值为全场最少，
 *   你须增加 1 点体力上限，回复 1 点体力，并获得【激将】。
 *
 * **绝对。** 界刘禅的放权是「本回合手牌上限等于体力上限」之类的强化，
 * 这里一样都没有；放权就是「跳过出牌阶段，换一个给别人的额外回合」。
 */

export const XIANGLE = 'xiangle'
export const FANGQUAN = 'fangquan'
export const RUOYU = 'ruoyu'
/** 若愚觉醒后获得的技能，直接复用标准刘备那一个主公技。 */
const JIJIANG = 'jijiang'

/**
 * 本回合发动过放权、还等着在结束阶段兑现第二段。
 *
 * 记在 `marks` 里而不是模块变量：它必须可序列化，
 * 回合结束前 Durable Object 可能休眠好几次。回合结束时清掉。
 */
const FANGQUAN_MARK = 'fangquan-pending'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 享乐 ───────────────────────────────

registerSkillRuntime({
  id: XIANGLE,

  /**
   * 「成为【杀】的目标时」的插入点。
   *
   * 三条容易做错的地方：
   *
   * 1. **请求发给使用者，不是刘禅。** 付代价的是攻击者。
   * 2. **时机在求闪之前。** 攻击者不付代价的话，这张【杀】对刘禅直接无效，
   *    刘禅连闪都不用出。写到 AskForDodge 那一步就晚了。
   * 3. **多目标【杀】只取消刘禅这一个目标**，其他目标照常结算——
   *    所以走的是「这个目标无效」而不是「整张牌无效」。
   */
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀') return false
    if (context.targetId !== ownerId) return false
    const attacker = playerOf(host.state, context.sourceId)
    if (!attacker?.alive) return false

    const basics = basicCardsInHand(host.state, context.sourceId)
    if (basics.length === 0) {
      /*
       * 拿不出基本牌：不弹一个只能拒绝的窗口，当场判这张【杀】对刘禅无效。
       *
       * **这里必须返回 false。** `interceptTarget` 返回 true 的含义是
       * 「我已经挂起并发出了 Request」，引擎收到 true 之后会把结算阶段改成
       * `awaiting-intercept`；而这条路径是同步走完的，没有任何 Request，
       * 于是留下一个「等待中却没人可等」的坏状态，压测里报
       * 「成为目标阶段缺少技能等待状态」。
       * 标记 `targetCancelled` 之后由 `enterSlashTarget` 收束这个目标。
       */
      cancelSlashTarget(host, ownerId)
      return false
    }

    host.askSkill({
      skillId: XIANGLE, ownerId, step: 'pay', data: { attackerId: context.sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards',
        // 付代价的是攻击者
        playerId: context.sourceId,
        prompt: `【享乐】：弃置一张基本牌，否则此【杀】对${playerOf(host.state, ownerId)?.nickname ?? ''}无效`,
        timeoutMs: 30_000, optional: true, purpose: 'skill',
        cardIds: basics, hiddenCardSlots: [],
        min: 0, max: 1,
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pay') return
    const attackerId = resolution.data.attackerId as PlayerId
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    const attacker = playerOf(host.state, attackerId)

    /*
     * **只认实体基本牌**。享乐要的是「弃置一张基本牌」，不是「使用」，
     * 所以武圣把红牌当杀、龙胆把闪当杀这类转化在这里都不算——
     * 看的是牌本身的类别。
     */
    const paid = cardId
      && attacker?.alive
      && attacker.zones.hand.includes(cardId)
      && host.state.cards[cardId]?.category === 'basic'

    if (!paid) {
      invalidateSlashForOwner(host, ownerId)
      return
    }

    moveCard(host.state, cardId, { kind: 'hand', playerId: attackerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: attackerId, cardIds: [cardId], reason: XIANGLE }, { sourceId: attackerId, cardIds: [cardId] })
    // 付了代价：这张【杀】照常往下走，该求闪求闪、该无双两张就两张
    host.resumeCardTarget()
  },
})

/** 刘禅手上没牌 / 攻击者不付代价：这张【杀】对刘禅无效。 */
function basicCardsInHand(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => state.cards[cardId]?.category === 'basic')
}

/**
 * 让这张【杀】对刘禅无效，然后把控制权交回结算管线。
 *
 * 用引擎既有的 `targetCancelled` 出口——它就是为「成为目标后的技能只取消
 * 当前这一个目标」准备的，`resumeCardTarget` 看到它会直接收束这个目标、
 * 继续结算剩下的目标。
 *
 * **不要改成把 `damageAmount` 清零**：那样这张【杀】仍然算命中了刘禅，
 * 求闪、铁骑、麒麟弓这些「命中之后」的时机照样会跑一遍，只是不掉血；
 * 而且多目标【杀】里其他目标的结算也会被搅乱。
 */
function cancelSlashTarget(host: SkillHost, ownerId: PlayerId): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash' || resolution.targetId !== ownerId) return
  resolution.targetCancelled = true
  host.dispatch('SkillActivated', { playerId: ownerId, skillId: XIANGLE, invalidated: true }, { targetId: ownerId })
}

/**
 * 攻击者放弃支付之后：作废这个目标，并把控制权交回结算管线。
 *
 * 这条路径是从 `resume` 回来的（确实挂起过），所以要自己调
 * `resumeCardTarget`——它看到 `targetCancelled` 会直接收束这个目标。
 */
function invalidateSlashForOwner(host: SkillHost, ownerId: PlayerId): void {
  cancelSlashTarget(host, ownerId)
  host.resumeCardTarget()
}

// ─────────────────────────────── 放权 ───────────────────────────────

registerSkillRuntime({
  id: FANGQUAN,

  /**
   * 第一段：出牌阶段开始前问要不要跳过。
   *
   * 走的是和张郃【巧变】同一个公共 `offerPhaseSkip` 窗口，
   * **不是**「进了出牌阶段之后自动 pass」——那样兵粮寸断、好施这些
   * 读 `skippedPhases` 的地方全都拿不到正确信息。
   */
  offerPhaseSkip(host, ownerId, phase) {
    if (phase !== 'play') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return false
    host.askSkill({
      skillId: FANGQUAN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '发动【放权】？跳过出牌阶段，本回合结束时可弃一张手牌令一名其他角色进行一个额外回合',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '跳过出牌阶段' }, { id: 'no', label: '正常出牌' }],
      }),
    })
    return true
  },

  triggers: [{
    /*
     * 第二段：**本回合的结束阶段**，不是出牌阶段跳过的当场。
     * 中间的弃牌阶段照常经过（董卓【崩坏】之类挂在那里的技能仍然要触发）。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!owner.marks[FANGQUAN_MARK]) return
      // 兑现机会只有一次，先把标记清掉
      delete owner.marks[FANGQUAN_MARK]
      if (host.state.skillResolution) return

      // 支付必须是**手牌**，装备不行；没有手牌就兑现不了，放权到此为止
      if (owner.zones.hand.length === 0) return
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return

      host.askSkill({
        skillId: FANGQUAN, ownerId, step: 'pay',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【放权】：弃置一张手牌，令一名其他角色进行一个额外的回合',
          timeoutMs: 20_000,
          // 第二段是「可以」，不是必须
          optional: true, purpose: 'skill',
          cardIds: [...owner.zones.hand], hiddenCardSlots: [],
          min: 0, max: 1,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const owner = playerOf(host.state, ownerId)
      if ((response.payload as { optionId: string }).optionId === 'yes' && owner) {
        skipPhase(host.state, 'play')
        // 记到回合结束才兑现；必须可序列化，中间可能休眠好几次
        owner.marks[FANGQUAN_MARK] = 1
        host.dispatch('SkillActivated', {
          playerId: ownerId, skillId: FANGQUAN,
          logText: `${owner.nickname}发动【放权】，跳过出牌阶段`,
        }, { sourceId: ownerId })
      }
      host.resumePhaseEntry()
      return
    }

    if (resolution.step === 'pay') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      // 放弃支付：放权的第二段就此作罢
      if (!cardId || !owner?.alive || !owner.zones.hand.includes(cardId)) return
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return

      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FANGQUAN }, { sourceId: ownerId, cardIds: [cardId] })

      host.askSkill({
        skillId: FANGQUAN, ownerId, step: 'target',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【放权】：令哪名角色进行一个额外的回合',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 发问期间目标可能死了，入队前再验一次
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      /*
       * **走公共额外回合队列**，不是把 `currentPlayerId` 直接改掉。
       * 暴力切换会把正常座次吃掉，而且额外回合里的准备/判定/摸牌/弃牌/结束
       * 一个都跑不到。
       */
      queueExtraTurn(host.state, targetId, { skillId: FANGQUAN, playerId: ownerId })
      /*
       * 这条必须和第一段那条文案不同。
       * 放权一个回合报两次横幅（跳过、兑现），两条都用默认的
       * 「刘禅发动【放权】」的话，牌桌中央就是同一句连播两遍。
       */
      host.dispatch('SkillActivated', {
        playerId: ownerId, skillId: FANGQUAN, targetId,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【放权】，令${playerOf(host.state, targetId)?.nickname}进行一个额外的回合`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

// ─────────────────────────────── 若愚 ───────────────────────────────

registerSkillRuntime({
  id: RUOYU,
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      const owner = playerOf(state, ownerId)
      // 主公技：不是主公一律不觉醒，哪怕血最少
      if (!owner?.alive || owner.identity !== 'lord') return false
      const alive = state.players.filter((player) => player.alive)
      const minHp = Math.min(...alive.map((player) => player.hp))
      // 「全场最少」允许并列最少，不要求唯一最低
      return owner.hp === minHp
    },
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      /*
       * 顺序按原文：先加体力上限，再回复 1 点，最后获得激将。
       * 加上限**不会**自动回满，所以后面那次 recover 不能省。
       */
      owner.maxHp += 1
      host.dispatch('MaxHpChange', {
        playerId: ownerId, maxHp: owner.maxHp, hp: owner.hp, amount: 1, trimmed: 0, reason: '若愚',
      }, { targetId: ownerId })
      recover(host as never, ownerId, 1)
      grantSkill(host.state, ownerId, JIJIANG)
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: RUOYU, granted: JIJIANG }, { sourceId: ownerId })
    },
  },
})

export const LIUSHAN: CharacterDefinition = {
  id: 'liushan',
  name: '刘禅',
  kingdom: 'shu',
  gender: 'male',
  // 身份局主公的额外体力上限由模式层统一加，不写死在这里
  maxHp: 3,
  pack: 'mountain',
  skills: [
    {
      id: XIANGLE,
      name: '享乐',
      description: '锁定技。当你成为【杀】的目标时，除非该【杀】的使用者弃置一张基本牌，否则此【杀】对你无效。',
    },
    {
      id: FANGQUAN,
      name: '放权',
      description: '你可以跳过你的出牌阶段，若如此做，你于此回合的结束阶段可以弃置一张手牌并令一名其他角色进行一个额外的回合。',
    },
    {
      id: RUOYU,
      name: '若愚',
      description: '主公技，觉醒技。准备阶段，若你的体力值为全场最少，你须增加1点体力上限，回复1点体力，并获得【激将】。',
    },
    {
      id: JIJIANG,
      name: '激将',
      description: '主公技。你需要打出【杀】时，其他蜀势力角色可以代你打出。',
      // 若愚觉醒之后才获得，开局没有
      granted: true,
    },
  ],
}
