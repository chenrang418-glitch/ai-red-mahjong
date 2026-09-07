import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { drawCards } from '../../engine/draw'
import { giveCards } from '../../engine/hand-transfer'
import { loseHp } from '../../engine/hp'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { cancelCardTargetForOwner } from '../../engine/target-cancellation'
import type {
  ChooseCardsRequest, ChooseOptionRequest, DistributeCardsRequest,
} from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 王异（一将成名 2012 · 2015 合并后的经典版）。
 *
 * 【贞烈】：当你成为其他角色使用的【杀】或非延时锦囊牌的目标后，你可以失去 1 点体力，
 *          然后弃置该角色一张牌，此牌对你无效。
 * 【秘计】：结束阶段，若你已受伤，你可以摸至多 X 张牌（X 为你已损失的体力值），
 *          然后你可以将等量的手牌交给其他角色。
 *
 * 六处最容易做错的：
 *
 * 1. **只在「其他角色使用的牌」上触发**：自己用的牌不算，延时锦囊不算。
 * 2. **失去体力是代价不是伤害**：不触发「受到伤害后」那批时机，
 *    但照常可能进入濒死。**代价先结清**——如果王异因此死了，
 *    后面的「弃牌 + 此牌无效」就不再执行，受益者已经不在场了。
 * 3. **只取消王异这一个目标**，不是整张牌作废：南蛮万箭对别人照常结算，
 *    而且取消之后不再问王异要【闪】。
 * 4. **弃的是「使用者的一张牌」**：手牌 + 装备区，判定区不可；
 *    暗手牌只给占位槽，王异看不到牌面。
 * 5. **秘计的 X 现算**（`maxHp - hp`），摸几张由王异定。
 * 6. **给牌是「交给」，按接收者分批**：同一个人一次拿到两张要算作
 *    一次原子的获得，法正【恩怨】才数得对。
 */

const ZHENLIE = 'zhenlie'
const MIJI = 'miji'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 贞烈 ───────────────────────────────

/** 这张牌属于贞烈管得着的范围吗：【杀】或**非延时**锦囊。 */
function zhenlieApplies(cardName: string): boolean {
  if (cardName === '杀') return true
  if (DELAYED_TRICK_NAMES.has(cardName)) return false
  return cardCategoryOfName(cardName) === 'trick'
}

/** 延时锦囊：贞烈管不到它们。 */
const DELAYED_TRICK_NAMES = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

registerSkillRuntime({
  id: ZHENLIE,
  announcesSelf: true,

  interceptTarget(host, ownerId, context) {
    if (context.targetId !== ownerId) return false
    // **其他角色使用的**：自己用的牌不触发
    if (context.sourceId === ownerId) return false
    if (!zhenlieApplies(context.cardName)) return false
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, context.sourceId)
    if (!owner?.alive || !source?.alive) return false

    host.askSkill({
      skillId: ZHENLIE, ownerId, step: 'invoke', data: { sourceId: context.sourceId, cardName: context.cardName },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【贞烈】：失去 1 点体力，弃置${source.nickname}一张牌，且此【${context.cardName}】对你无效？`,
        timeoutMs: 25_000, optional: true,
        options: [
          { id: 'yes', label: '发动【贞烈】（失去 1 点体力）' },
          { id: 'no', label: '不发动' },
        ],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        host.resumeCardTarget()
        return
      }
      const sourceId = resolution.data.sourceId as PlayerId
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) {
        host.resumeCardTarget()
        return
      }
      host.dispatch('SkillActivated', {
        skillId: ZHENLIE, skillName: '贞烈', playerId: ownerId, targetId: sourceId,
        logText: `${owner.nickname}发动【贞烈】，失去 1 点体力`,
      }, { sourceId: ownerId, targetId: sourceId })
      /*
       * **代价先结清。** 失去体力可能把她打进濒死；濒死流程要在这里
       * 完整走完，之后才谈得上「弃牌 + 此牌无效」。
       */
      loseHp(host as never, ownerId, 1, ZHENLIE)

      /*
       * **目标作废是同步的**：它只是一个标记，不需要发问，
       * 所以哪怕代价把她打进了濒死也可以当场落地。
       */
      cancelCardTargetForOwner(host, ownerId)
      /*
       * **弃牌排队，不当场问。**
       *
       * 代价可能把她打进濒死，而濒死会挂起一个救援请求；这时候再发一个
       * 弃牌请求，就成了「技能等待状态指向不存在的 Request」（专项用例
       * wy-dying 抓到过）。排队的东西要等牌桌干净才放出来。
       *
       * 队列只为**还活着的**拥有者放行，所以「她若因代价死亡就不弃牌」
       * 这一条不需要另外判断——那正是规则要的结果。
       */
      host.queueSkill({ skillId: ZHENLIE, ownerId, step: 'discard', data: { sourceId } })
      /*
       * **无论如何都要把控制权交回结算管线。**
       *
       * 目标已经作废，`resumeCardTarget` 只会收束这个目标、接着往下走；
       * 留在原地不交回去的话，这张牌会停在「成为目标」那一步，
       * 不变量当场报「成为目标阶段缺少技能等待状态」。
       * 濒死流程本身由引擎自己的续接路径负责，不需要这里配合。
       */
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'discard') {
      const sourceId = resolution.data.sourceId as PlayerId
      const [picked] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const cardId = picked ? resolvePickedCard(host.state, sourceId, picked) : null
      if (cardId && movePickedCard(host as never, sourceId, cardId, { kind: 'discardPile' })) {
        host.dispatch('LoseCard', { playerId: sourceId, cardIds: [cardId], reason: ZHENLIE }, { targetId: sourceId, cardIds: [cardId] })
      }
      /*
       * 这一步是从队列里放出来的，牌的结算早就自己往下走了——
       * **不要**再调 `resumeCardTarget`，那会把已经结算完的牌再推一次。
       */
    }
  },

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const sourceId = prompt.data.sourceId as PlayerId
    const source = playerOf(host.state, sourceId)
    // 她没活下来、或者对方已经没牌可弃：安静结束，不弹空窗口
    if (!owner?.alive || !source?.alive || !hasPickableCards(host.state, sourceId)) return
    const pickable = pickableCardsOf(host.state, sourceId)
    host.askSkill({
      skillId: ZHENLIE, ownerId, step: 'discard', data: { sourceId },
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: `【贞烈】：弃置${source.nickname}的一张牌`,
        timeoutMs: 20_000, optional: false, purpose: 'skill',
        // 手牌只给占位槽，王异看不到牌面；装备是明置的
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 1, max: 1,
      }),
    })
  },
})

// ─────────────────────────────── 秘计 ───────────────────────────────

/** X：已损失的体力值。**现算**，上限变了立刻跟着变。 */
function lostHpOf(state: SanguoshaState, ownerId: PlayerId): number {
  const owner = playerOf(state, ownerId)
  if (!owner) return 0
  return Math.max(0, owner.maxHp - owner.hp)
}

registerSkillRuntime({
  id: MIJI,
  announcesSelf: true,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
      if (host.state.skillResolution) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const limit = lostHpOf(host.state, ownerId)
      // 没受伤就没有这个技能可发动
      if (limit <= 0) return
      host.askSkill({
        skillId: MIJI, ownerId, step: 'draw',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【秘计】：摸至多 ${limit} 张牌`,
          timeoutMs: 25_000, optional: true,
          options: [
            ...Array.from({ length: limit }, (_, index) => ({
              id: String(index + 1), label: `摸 ${index + 1} 张牌`,
            })),
            { id: '0', label: '不发动' },
          ],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'draw') {
      const chosen = Math.trunc(Number((response.payload as { optionId?: string }).optionId ?? 0))
      const limit = lostHpOf(host.state, ownerId)
      const count = Math.max(0, Math.min(Number.isFinite(chosen) ? chosen : 0, limit))
      if (count <= 0 || !owner?.alive) return
      const drawn = drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
      host.dispatch('SkillActivated', {
        skillId: MIJI, skillName: '秘计', playerId: ownerId,
        logText: `${owner.nickname}发动【秘计】，摸 ${drawn.length} 张牌`,
      }, { sourceId: ownerId })
      if (drawn.length === 0) return

      const recipientIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (recipientIds.length === 0 || owner.zones.hand.length < drawn.length) return
      /*
       * **「等量」= 恰好等于这次实际摸到的张数。**
       *
       * 给不给是可选的（`optional`），但一旦要给就得给满这个数；
       * 而且可以分给多名其他角色——所以走「分配」这种请求，
       * 一次把「哪几张、分别给谁」问完。
       */
      host.askSkill({
        skillId: MIJI, ownerId, step: 'give', data: { count: drawn.length },
        build: (requestId): DistributeCardsRequest => ({
          id: requestId, kind: 'distribute-cards', playerId: ownerId,
          prompt: `【秘计】：可以将 ${drawn.length} 张手牌交给其他角色（可以分给多人）`,
          timeoutMs: 30_000, optional: true,
          cardIds: [...owner.zones.hand], recipientIds,
          min: 0, max: drawn.length,
        }),
      })
      return
    }

    if (resolution.step === 'give') {
      const count = Math.max(0, Math.trunc(Number(resolution.data.count ?? 0)))
      const assignments = (response.payload as { assignments?: Array<{ cardId: CardId; recipientId: PlayerId }> }).assignments ?? []
      if (!owner?.alive || assignments.length === 0) return
      /*
       * 要么不给，要么**给满**：只给一部分是不合法的答案，按「不给」处理。
       * 服务端不信客户端的分配，逐条验一遍牌还在不在手上。
       */
      if (assignments.length !== count) return

      const byRecipient = new Map<PlayerId, CardId[]>()
      for (const entry of assignments) {
        if (!entry?.cardId || !entry.recipientId) continue
        if (entry.recipientId === ownerId) continue
        if (!owner.zones.hand.includes(entry.cardId)) continue
        byRecipient.set(entry.recipientId, [...(byRecipient.get(entry.recipientId) ?? []), entry.cardId])
      }
      /*
       * **按接收者分批给**：同一个人一次拿到两张要算作一次原子的获得，
       * 法正【恩怨】的「获得同一名角色的两张牌」才数得对。
       */
      for (const [recipientId, cardIds] of byRecipient) {
        giveCards(host as never, ownerId, recipientId, cardIds, MIJI)
      }
    }
  },
})

export const WANGYI: CharacterDefinition = {
  id: 'wangyi',
  name: '王异',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'yjcm2012',
  skills: [
    {
      id: ZHENLIE,
      name: '贞烈',
      description: '当你成为其他角色使用的【杀】或非延时锦囊牌的目标后，你可以失去 1 点体力，'
        + '然后弃置该角色一张牌，此牌对你无效。',
    },
    {
      id: MIJI,
      name: '秘计',
      description: '结束阶段，若你已受伤，你可以摸至多 X 张牌（X 为你已损失的体力值），'
        + '然后你可以将等量的手牌交给其他角色。',
    },
  ],
}
