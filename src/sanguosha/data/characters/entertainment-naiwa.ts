import { drawCards } from '../../engine/draw'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, PlayerState, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 好友娱乐包·奶蛙。
 *
 * 玩法主题：自己回合拉别人一起发癫，别人回合坐在旁边起哄。
 * 和平头方块的区别是「制造互动」而不是「引诱攻击」。
 *
 * 两条硬约束贯穿全文：
 *
 * 1. **随机和隐藏信息全部在服务端。** 一起笑抽哪张牌用 `host.rng`；
 *    绷住的对错由服务端算完只回一个结果，**发给奶蛙的请求里不含目标的其余手牌**。
 * 2. **不为奶蛙改引擎。** 摸牌走 `drawCards`，弃牌走 `locateOwnedCard` + `moveCard`，
 *    发问走 `askSkill` / `queueSkill`，临时状态放 `player.marks`（本来就在 PlayerView 里）。
 */

export const HOUXIAO = 'houxiao'
export const PENGFU = 'pengfu'

/**
 * 「继续表演」的临时标记，放在**被起哄的那个人**身上。
 *
 * 值是发起者的座位号 + 1（0 表示没有）——marks 只能存数字，
 * 而一桌可能坐着两个奶蛙（娱乐武将允许重复选），必须能分清是谁发起的。
 */
export const PENGFU_CONTINUE_MARK = 'pengfu-continue'
/** 已经因为「继续成功」奖励过了，只给一次。 */
const PENGFU_REWARDED_MARK = 'pengfu-rewarded'
/** 本出牌阶段这个角色已经使用了几张牌。每次进入出牌阶段清零。 */
const PLAY_USES_MARK = 'pengfu-play-uses'

function playerOf(state: SanguoshaState, playerId: PlayerId): PlayerState | undefined {
  return state.players.find((candidate) => candidate.id === playerId)
}

function draw(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  const target = playerOf(host.state, playerId)
  // 死人不摸牌：奶蛙可能在挑战完成之前就死了
  if (!target?.alive || count <= 0) return
  drawCards(host.state, host.rng, playerId, count, (name, payload) => {
    host.dispatch(name, { ...payload, reason })
  })
}

/** 一名角色现在能弃置的牌：手牌加装备区。判定区的牌不属于他自己，不能弃。 */
function discardableCardIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return []
  const equipment = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
  return [...owner.zones.hand, ...equipment]
}

/** 把某人的一张牌弃掉。牌在手牌还是装备区由 `locateOwnedCard` 判断，调用方不猜。 */
function discardOwnedCard(host: SkillHost, playerId: PlayerId, cardId: CardId, reason: string): void {
  const zone = locateOwnedCard(host.state, playerId, cardId)
  if (!zone) return
  moveCard(host.state, cardId, zone, { kind: 'discardPile' })
  host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason }, { targetId: playerId, cardIds: [cardId] })
}

// ─────────────────────────────── 齁笑 ───────────────────────────────
//
// 出牌阶段限一次，选一名其他角色，令其选择：
//   ①【一起笑】双方各摸一张，然后随机交换一张手牌；
//   ②【绷住】展示一张手牌，奶蛙猜其余手牌里有没有同色牌，猜对摸二、猜错对方摸一。
//
// 目标手牌为空时不能被选中（两个选项都无从谈起）。

/** 齁笑打得到谁：有手牌的其他存活角色。 */
function houxiaoTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((player) => player.alive && player.id !== ownerId && player.zones.hand.length > 0)
    .map((player) => player.id)
}

registerSkillRuntime({
  id: HOUXIAO,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, HOUXIAO)) return []
    if (houxiaoTargets(state, ownerId).length === 0) return []
    return [{ id: `skill:${HOUXIAO}`, label: '发动【齁笑】：拉一名角色一起笑，或让他绷住' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${HOUXIAO}`) throw new Error('齁笑动作不匹配')
    const candidateIds = houxiaoTargets(host.state, ownerId)
    if (candidateIds.length === 0) return
    // 先记账再发问：中途取消不能刷次数
    markUsedThisTurn(host.state, ownerId, HOUXIAO)
    host.askSkill({
      skillId: HOUXIAO,
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【齁笑】：选择一名其他角色',
        timeoutMs: 20_000,
        optional: false,
        candidateIds,
        min: 1,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = playerOf(host.state, targetId)
      if (!target?.alive || targetId === ownerId || target.zones.hand.length === 0) return
      // 只有一张手牌时「绷住」无从谈起（没有「其余手牌」），直接不给这个选项
      const options = [{ id: 'houxiao-together', label: '一起笑：双方各摸一张牌，然后随机交换一张手牌' }]
      if (target.zones.hand.length >= 2) {
        options.push({ id: 'houxiao-hold', label: '绷住：展示一张手牌，让奶蛙猜其余手牌里有没有同色牌' })
      }
      host.askSkill({
        skillId: HOUXIAO,
        ownerId,
        step: 'choice',
        data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: targetId,
          prompt: `${playerOf(host.state, ownerId)?.nickname ?? '奶蛙'}对你发动了【齁笑】`,
          timeoutMs: 20_000,
          optional: false,
          options,
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const targetId = String(resolution.data.targetId ?? '')
      const optionId = (response.payload as { optionId: string }).optionId
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      if (optionId === 'houxiao-together') {
        laughTogether(host, ownerId, targetId)
        return
      }
      if (optionId !== 'houxiao-hold') throw new Error('齁笑选项非法')
      if (target.zones.hand.length < 2) throw new Error('只有一张手牌时不能绷住')
      host.askSkill({
        skillId: HOUXIAO,
        ownerId,
        step: 'reveal',
        data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: targetId,
          prompt: '【绷住】：选择一张手牌展示',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: [...target.zones.hand],
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'reveal') {
      const targetId = String(resolution.data.targetId ?? '')
      const [revealedId] = (response.payload as { cardIds: CardId[] }).cardIds
      const target = playerOf(host.state, targetId)
      if (!target?.alive || !target.zones.hand.includes(revealedId)) return
      const revealed = host.state.cards[revealedId]
      // 展示牌**仍然属于目标**：不移区、不弃置、不改归属，只是所有人都看见了
      host.dispatch('CardMove', {
        playerId: targetId, cardIds: [revealedId], reason: HOUXIAO, revealed: true, keepOwner: true,
      }, { targetId, cardIds: [revealedId] })
      host.askSkill({
        skillId: HOUXIAO,
        ownerId,
        step: 'guess',
        // 只传展示牌，**不传目标的其余手牌**——那是隐藏信息，
        // 传过去就等于让奶蛙的客户端能直接看牌
        data: { targetId, revealedId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: ownerId,
          prompt: `${target.nickname}展示了【${revealed.name}】${revealed.color === 'red' ? '（红）' : '（黑）'}，其余手牌里还有同色牌吗？`,
          timeoutMs: 20_000,
          optional: false,
          options: [
            { id: 'houxiao-yes', label: '有同色牌' },
            { id: 'houxiao-no', label: '没有同色牌' },
          ],
        }),
      })
      return
    }

    if (resolution.step !== 'guess') return
    const targetId = String(resolution.data.targetId ?? '')
    const revealedId = String(resolution.data.revealedId ?? '')
    const target = playerOf(host.state, targetId)
    if (!target?.alive) return
    const guessedYes = (response.payload as { optionId: string }).optionId === 'houxiao-yes'
    const revealedColor = host.state.cards[revealedId]?.color
    // 判定在服务端做完，只把结论发出去
    const actuallyHas = target.zones.hand
      .filter((cardId) => cardId !== revealedId)
      .some((cardId) => host.state.cards[cardId]?.color === revealedColor)
    const correct = guessedYes === actuallyHas
    host.dispatch('SkillActivated', {
      skillId: HOUXIAO, skillName: '齁笑', playerId: ownerId, targetId,
      guess: guessedYes ? 'yes' : 'no', correct,
    }, { sourceId: ownerId, targetId })
    if (correct) draw(host, ownerId, 2, HOUXIAO)
    else draw(host, targetId, 1, HOUXIAO)
  },
})

/**
 * 【一起笑】：双方各摸一张，然后随机交换一张手牌。
 *
 * 顺序很要紧：**先各自摸完，再同时定下两张要换的牌**。
 * 如果先把目标的牌给奶蛙、再从奶蛙（已经变了的）手牌里随机，
 * 刚拿到的那张就可能被立刻换回去，随机分布也被交换顺序污染了。
 */
function laughTogether(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  draw(host, ownerId, 1, HOUXIAO)
  draw(host, targetId, 1, HOUXIAO)

  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  // 摸牌途中可能有人死了（牌堆摸空的极端情况下不会，但状态要重新确认）
  if (!owner?.alive || !target?.alive) return
  if (owner.zones.hand.length === 0 || target.zones.hand.length === 0) return

  // 随机由服务端的 GameRng 决定，客户端不参与
  const fromOwner = owner.zones.hand[host.rng.nextInt(owner.zones.hand.length)]
  const fromTarget = target.zones.hand[host.rng.nextInt(target.zones.hand.length)]

  moveCard(host.state, fromOwner, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
  moveCard(host.state, fromTarget, { kind: 'hand', playerId: targetId }, { kind: 'hand', playerId: ownerId })
  // 日志只说「交换了各一张」，不报是哪两张——那是双方的隐藏手牌
  host.dispatch('SkillActivated', {
    skillId: HOUXIAO, skillName: '齁笑', playerId: ownerId, targetId, exchanged: true,
  }, { sourceId: ownerId, targetId })
}

// ─────────────────────────────── 捧腹 ───────────────────────────────
//
// 每回合限一次：其他角色在其出牌阶段使用第二张牌结算结束后，奶蛙可以起哄，
// 令其选择：
//   ①【继续】摸一张牌；本阶段再使用一张牌则奶蛙摸一张，否则阶段结束时弃一张；
//   ②【算了】弃一张牌，奶蛙摸一张。

/** 这次「使用牌」算不算进出牌阶段的计数。 */
function countsAsPlay(state: SanguoshaState, sourceId: PlayerId | undefined): boolean {
  if (!sourceId) return false
  // 只数当前回合角色在自己出牌阶段里的使用；打出的【闪】【无懈】走的是
  // CardResponded，判定牌和技能展示牌根本不发 AfterCardUse，天然不会被数进来
  return state.phase === 'play' && sourceId === state.currentPlayerId
}

registerSkillRuntime({
  id: PENGFU,

  triggers: [
    {
      // 进入出牌阶段：把这个角色的用牌计数和上一轮残留的挑战状态清干净
      event: 'PhaseStart',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: string }
        if (payload.phase !== 'play') return
        const actor = playerOf(host.state, String(payload.playerId ?? ''))
        if (!actor) return
        actor.marks[PLAY_USES_MARK] = 0
        delete actor.marks[PENGFU_CONTINUE_MARK]
        delete actor.marks[PENGFU_REWARDED_MARK]
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const sourceId = context.event.sourceId
        if (!countsAsPlay(host.state, sourceId)) return
        const actor = playerOf(host.state, sourceId!)
        const owner = playerOf(host.state, ownerId)
        if (!actor || !owner) return
        // 一张多目标锦囊也只是一张牌：AfterCardUse 每次使用只发一次
        const uses = (actor.marks[PLAY_USES_MARK] ?? 0) + 1
        actor.marks[PLAY_USES_MARK] = uses

        // 「继续」挑战：本阶段再使用一张牌就算完成，只奖励一次
        if (owner.alive
          && actor.marks[PENGFU_CONTINUE_MARK] === owner.seat + 1
          && !actor.marks[PENGFU_REWARDED_MARK]) {
          actor.marks[PENGFU_REWARDED_MARK] = 1
          delete actor.marks[PENGFU_CONTINUE_MARK]
          draw(host, ownerId, 1, PENGFU)
          host.dispatch('SkillActivated', {
            skillId: PENGFU, skillName: '捧腹', playerId: ownerId, targetId: actor.id, result: 'continued',
          }, { sourceId: ownerId, targetId: actor.id })
          return
        }

        if (uses !== 2) return
        if (actor.id === ownerId || !owner.alive) return
        if (usedThisTurn(host.state, ownerId, PENGFU)) return
        // 排队发问：这里牌刚结算完，当场插一个请求会和后续时机抢玩家的注意力
        host.queueSkill({ skillId: PENGFU, ownerId, step: 'invoke', data: { targetId: actor.id } })
      },
    },
    {
      // 出牌阶段结束：还挂着挑战的说明「继续」失败了，罚弃一张
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: string }
        if (payload.phase !== 'play') return
        const actor = playerOf(host.state, String(payload.playerId ?? ''))
        const owner = playerOf(host.state, ownerId)
        if (!actor || !owner) return
        if (actor.marks[PENGFU_CONTINUE_MARK] !== owner.seat + 1) return
        delete actor.marks[PENGFU_CONTINUE_MARK]
        // 人已经死了就不追究；没牌可弃也直接过，不能让牌局卡住
        if (!actor.alive || discardableCardIds(host.state, actor.id).length === 0) return
        host.queueSkill({ skillId: PENGFU, ownerId, step: 'penalty', data: { targetId: actor.id } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const targetId = String((prompt.data as { targetId?: unknown }).targetId ?? '')
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!target?.alive) return

    if (prompt.step === 'penalty') {
      const cardIds = discardableCardIds(host.state, targetId)
      if (cardIds.length === 0) return
      host.askSkill({
        skillId: PENGFU,
        ownerId,
        step: 'penalty',
        data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: targetId,
          prompt: '【捧腹·继续】没有完成，请弃置一张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds,
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    // 排队期间局势可能已经变了：奶蛙死了、本回合已经发动过、目标死了都要安静放弃
    if (!owner?.alive || usedThisTurn(host.state, ownerId, PENGFU)) return
    host.askSkill({
      skillId: PENGFU,
      ownerId,
      step: 'invoke',
      data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `${target.nickname}这个出牌阶段已经用了两张牌，是否发动【捧腹】？`,
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: 'pengfu-invoke', label: '捧腹：起哄让他继续演' },
          { id: 'cancel', label: '取消' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const targetId = String(resolution.data.targetId ?? '')
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'pengfu-invoke') return
      if (!target?.alive || !owner?.alive) return
      if (usedThisTurn(host.state, ownerId, PENGFU)) return
      markUsedThisTurn(host.state, ownerId, PENGFU)
      // 没有任何牌可弃的人不能白拿「算了」——那等于免费少弃一张
      const canDiscard = discardableCardIds(host.state, targetId).length > 0
      const options = [{ id: 'pengfu-continue', label: '继续：摸一张牌；本阶段再用一张牌则奶蛙摸一张，否则阶段结束时弃一张' }]
      if (canDiscard) options.push({ id: 'pengfu-stop', label: '算了：弃一张牌，奶蛙摸一张' })
      host.askSkill({
        skillId: PENGFU,
        ownerId,
        step: 'choice',
        data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: targetId,
          prompt: `${owner.nickname}已经看乐了，要不要继续？`,
          timeoutMs: 20_000,
          optional: false,
          options,
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      if (!target?.alive || !owner) return
      const optionId = (response.payload as { optionId: string }).optionId
      if (optionId === 'pengfu-continue') {
        draw(host, targetId, 1, PENGFU)
        // 标记挂在**被起哄的人**身上，值是发起者座位号 +1：
        // 一桌可能坐着两个奶蛙，要分得清是谁的挑战
        target.marks[PENGFU_CONTINUE_MARK] = owner.seat + 1
        delete target.marks[PENGFU_REWARDED_MARK]
        return
      }
      if (optionId !== 'pengfu-stop') throw new Error('捧腹选项非法')
      const cardIds = discardableCardIds(host.state, targetId)
      if (cardIds.length === 0) return
      host.askSkill({
        skillId: PENGFU,
        ownerId,
        step: 'stop-discard',
        data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: targetId,
          prompt: '【捧腹·算了】：弃置一张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds,
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'stop-discard' || resolution.step === 'penalty') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      if (!target || !cardId) return
      discardOwnedCard(host, targetId, cardId, PENGFU)
      // 「算了」才给奶蛙摸牌；「继续」失败的罚弃只是罚，奶蛙不摸
      if (resolution.step === 'stop-discard') draw(host, ownerId, 1, PENGFU)
    }
  },
})

export const NAIWA: CharacterDefinition = {
  id: 'naiwa',
  name: '奶蛙',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: HOUXIAO,
      name: '齁笑',
      description: '出牌阶段限一次，你可以选择一名有手牌的其他角色，令其选择一项：与你各摸一张牌，然后你与其随机交换一张手牌；或展示一张手牌，然后你猜测其余手牌中是否存在与此牌颜色相同的牌，猜对则你摸两张牌，猜错则其摸一张牌（其只有一张手牌时不能选择后者）。',
    },
    {
      id: PENGFU,
      name: '捧腹',
      description: '每回合限一次，当一名其他角色于其出牌阶段使用第二张牌结算结束后，你可以令其选择一项：摸一张牌，若其于本出牌阶段再次使用牌则你摸一张牌，否则其于此阶段结束时弃置一张牌；或其弃置一张牌，然后你摸一张牌。',
    },
  ],
}
