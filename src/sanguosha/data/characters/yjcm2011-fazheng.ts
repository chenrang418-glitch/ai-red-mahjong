import { attackRangeCovers, canUseSlashAt, slashUseOptions } from '../../engine/ask-use-slash'
import { gainOriginCounts } from '../../engine/card-gain-provenance'
import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { setCardAlias } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { giveCards } from '../../engine/hand-transfer'
import { loseHp } from '../../engine/hp'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 法正（一将成名 2011 经典）。
 *
 * 【恩怨】：锁定技。当你获得其他角色两张或更多的牌时，该角色摸一张牌；
 *          当你每受到 1 点伤害后，伤害来源须交给你一张手牌，否则失去 1 点体力。
 * 【眩惑】：摸牌阶段，你可以放弃摸牌，令一名其他角色摸两张牌，
 *          然后其需对你指定的、在其攻击范围内的另一名角色使用一张【杀】，
 *          否则你获得其两张牌。
 *
 * 五处最容易做错的：
 *
 * 1. **「获得其他角色的牌」不是「获得牌」。** 摸两张牌、从弃牌堆捡回两张
 *    都不该让谁摸牌。而且必须是**同一个人**的两张：从甲乙各拿一张不算。
 *    这要求在牌移动的那一刻就记住来源，见 `engine/card-gain-provenance.ts`。
 * 2. **「每受到 1 点伤害」是按点数逐点结算**，不是一次伤害问一次。
 *    挨了 2 点就要问两次，来源可能第一次给牌、第二次选择掉血。
 * 3. **交牌不能路过弃牌堆**：那是「交给」，走 `giveCards`，
 *    否则枭姬、连营这些弃牌时机会被凭空触发。
 * 4. **眩惑接管的是摸牌阶段本身**：放弃摸牌之后引擎不再补那两张牌，
 *    不发动就得由技能自己把牌摸回来。
 * 5. **【杀】必须是真正的「使用」**，走公共虚拟杀，完整经过求闪、藤甲、
 *    铁骑、无双；而且目标由法正固定，被指使的人不能拿这刀去砍别人。
 */

const ENYUAN = 'enyuan'
const XUANHUO = 'xuanhuo'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function drawFor(host: SkillHost, playerId: PlayerId, count: number): void {
  drawCards(host.state, host.rng, playerId, count, (name, payload) => { host.dispatch(name, payload) })
}

// ─────────────────────────────── 恩怨 ───────────────────────────────

registerSkillRuntime({
  id: ENYUAN,
  triggers: [{
    /*
     * 恩：获得其他角色两张或更多的牌 → 该角色摸一张。
     *
     * 锁定技，没有「你可以」，所以这里直接摸，不发问，也就不需要挂起。
     */
    event: 'GainCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const counts = gainOriginCounts(host.state, ownerId, payload.cardIds ?? [])
      for (const [fromId, count] of counts) {
        if (count < 2) continue
        const from = playerOf(host.state, fromId)
        // 已经阵亡的人不摸牌；牌是从他那里来的这件事不因此改变，只是没人受益了
        if (!from?.alive) continue
        host.dispatch('SkillActivated', {
          skillId: ENYUAN, skillName: '恩怨', playerId: ownerId, targetId: fromId,
          logText: `${owner.nickname}发动【恩怨】，${from.nickname}摸一张牌`,
        }, { sourceId: ownerId, targetId: fromId })
        drawFor(host, fromId, 1)
      }
    },
  }, {
    /*
     * 怨：每受到 1 点伤害后，来源交给你一张手牌，否则失去 1 点体力。
     *
     * **排队问，不当场问**：伤害结算里还有一串「受到伤害后」的时机没跑完，
     * 而且来源自己可能在同一批里被打死。等牌桌干净了再逐点结算。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { amount?: number }
      const sourceId = context.event.sourceId as PlayerId | undefined
      if (context.event.targetId !== ownerId) return
      // 无来源的伤害（闪电这类环境伤害）没人可问；自伤也不问自己
      if (!sourceId || sourceId === ownerId) return
      const points = Math.max(0, Math.trunc(payload.amount ?? 0))
      if (points === 0) return
      host.queueSkill({ skillId: ENYUAN, ownerId, step: 'yuan', data: { sourceId, remaining: points } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'yuan') return
    askYuan(host, ownerId, prompt.data.sourceId as PlayerId, Number(prompt.data.remaining ?? 0))
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'yuan') return
    const sourceId = resolution.data.sourceId as PlayerId
    const remaining = Number(resolution.data.remaining ?? 0)
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (owner?.alive && source?.alive) {
      const [picked] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      /*
       * 发问和落地之间手牌可能已经被别的效果拿走了，所以这里重新验一次；
       * 验不过就按「没有交牌」处理——**不能**默默算他交过了。
       */
      const given = picked && source.zones.hand.includes(picked)
        ? giveCards(host as never, sourceId, ownerId, [picked], ENYUAN)
        : []
      if (given.length === 0) {
        host.dispatch('SkillActivated', {
          skillId: ENYUAN, skillName: '恩怨', playerId: ownerId, targetId: sourceId,
          logText: `${source.nickname}没有交出手牌，因【恩怨】失去 1 点体力`,
        }, { sourceId: ownerId, targetId: sourceId })
        loseHp(host as never, sourceId, 1, ENYUAN)
      }
    }
    // 逐点结算：这一点问完了，还欠几点就接着问几次
    if (remaining > 1) askYuan(host, ownerId, sourceId, remaining - 1)
  },
})

/**
 * 问伤害来源一次：交一张手牌，还是失去 1 点体力。
 *
 * 没有手牌可交时不弹一个只能拒绝的窗口，直接扣血——规则上他确实
 * 「不能交出手牌」，结果一样，但少一次无意义的等待。
 */
function askYuan(host: SkillHost, ownerId: PlayerId, sourceId: PlayerId, remaining: number): void {
  const owner = playerOf(host.state, ownerId)
  const source = playerOf(host.state, sourceId)
  if (!owner?.alive || !source?.alive || remaining <= 0) return
  if (source.zones.hand.length === 0) {
    host.dispatch('SkillActivated', {
      skillId: ENYUAN, skillName: '恩怨', playerId: ownerId, targetId: sourceId,
      logText: `${source.nickname}没有手牌可交，因【恩怨】失去 1 点体力`,
    }, { sourceId: ownerId, targetId: sourceId })
    loseHp(host as never, sourceId, 1, ENYUAN)
    if (remaining > 1) askYuan(host, ownerId, sourceId, remaining - 1)
    return
  }
  host.askSkill({
    skillId: ENYUAN, ownerId, step: 'yuan', data: { sourceId, remaining },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards',
      // 交不交牌是**伤害来源**的决定，不是法正的
      playerId: sourceId,
      prompt: `【恩怨】：交给${owner.nickname}一张手牌，否则失去 1 点体力`
        + (remaining > 1 ? `（还剩 ${remaining} 点）` : ''),
      timeoutMs: 25_000,
      optional: true, purpose: 'skill',
      cardIds: [...source.zones.hand], hiddenCardSlots: [],
      min: 0, max: 1,
    }),
  })
}

// ─────────────────────────────── 眩惑 ───────────────────────────────

/** `userId` 的攻击范围里有哪些**别的**角色。法正自己也算在内。 */
function slashTargetsFor(state: SanguoshaState, userId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== userId)
    .filter((candidate) => attackRangeCovers(state, userId, candidate.id))
    .map((candidate) => candidate.id)
}

/**
 * 眩惑的候选：**攻击范围里还有别人**的其他存活角色。
 *
 * 攻击范围里一个人都没有的角色不能当候选：他无论如何都使不出这张【杀】，
 * 选他就等于白拿两张牌，那不是这个技能的意思。
 */
function xuanhuoCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .filter((candidate) => slashTargetsFor(state, candidate.id).length > 0)
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: XUANHUO,
  announcesSelf: true,
  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      if (!takeOverDrawPhase(host, ownerId, context)) return
      /*
       * 接管之后牌就由这个技能负责：不发动也要把那两张摸回来。
       * 没有候选时同样如此——直接照常摸牌，别把这一阶段丢掉。
       */
      if (xuanhuoCandidates(host.state, ownerId).length === 0) {
        drawFor(host, ownerId, 2)
        return
      }
      host.askSkill({
        skillId: XUANHUO, ownerId, step: 'ask',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '发动【眩惑】？放弃摸牌，令一名其他角色摸两张牌并对你指定的角色使用【杀】',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃（照常摸牌）' }],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') {
        drawFor(host, ownerId, 2)
        return
      }
      const candidateIds = xuanhuoCandidates(host.state, ownerId)
      if (candidateIds.length === 0) {
        // 发问期间候选全没了：牌还是要摸的
        drawFor(host, ownerId, 2)
        return
      }
      host.askSkill({
        skillId: XUANHUO, ownerId, step: 'user',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【眩惑】：选择一名角色，令其摸两张牌',
          timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'user') {
      const [userId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const user = userId ? playerOf(host.state, userId) : undefined
      if (!owner?.alive || !user?.alive) {
        drawFor(host, ownerId, 2)
        return
      }
      host.dispatch('SkillActivated', {
        skillId: XUANHUO, skillName: '眩惑', playerId: ownerId, targetId: userId,
        logText: `${owner.nickname}发动【眩惑】，${user.nickname}摸两张牌`,
      }, { sourceId: ownerId, targetId: userId })
      drawFor(host, userId as PlayerId, 2)

      /*
       * 摸完牌才选被砍的那个人：摸牌本身不改变攻击范围，
       * 但中间可能发生别的事，所以现算一次，不用发问时的快照。
       */
      const slashTargets = slashTargetsFor(host.state, userId as PlayerId)
      if (slashTargets.length === 0) {
        // 攻击范围空了：他确实使不出这张杀，走惩罚分支
        askSeize(host, ownerId, userId as PlayerId)
        return
      }
      host.askSkill({
        skillId: XUANHUO, ownerId, step: 'victim', data: { userId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【眩惑】：指定一名${user.nickname}攻击范围内的角色，他需对其使用【杀】`,
          timeoutMs: 20_000, optional: false,
          candidateIds: slashTargets, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'victim') {
      const userId = resolution.data.userId as PlayerId
      const [victimId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const user = playerOf(host.state, userId)
      const victim = victimId ? playerOf(host.state, victimId) : undefined
      if (!user?.alive || !victim?.alive) return
      /*
       * 拿不出【杀】就不弹一个只能拒绝的窗口，直接走惩罚分支。
       * 判断包含转化技（武圣、龙胆、蛊惑），不是只看手上有没有实体杀。
       */
      if (!canUseSlashAt(host.state, userId, victimId as PlayerId)) {
        askSeize(host, ownerId, userId)
        return
      }
      host.askSkill({
        skillId: XUANHUO, ownerId, step: 'slash', data: { userId, victimId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards',
          // 出不出杀是**被指使者**的决定
          playerId: userId,
          prompt: `【眩惑】：对${victim.nickname}使用一张【杀】，否则${owner?.nickname ?? ''}获得你两张牌`,
          timeoutMs: 30_000, optional: true, purpose: 'skill',
          cardIds: slashUseOptions(host.state, userId, victimId as PlayerId), hiddenCardSlots: [],
          min: 0, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'slash') {
      const userId = resolution.data.userId as PlayerId
      const victimId = resolution.data.victimId as PlayerId
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const user = playerOf(host.state, userId)
      const victim = playerOf(host.state, victimId)
      const stillLegal = user?.alive && victim?.alive && cardId
        && slashUseOptions(host.state, userId, victimId).includes(cardId)
      if (!stillLegal) {
        askSeize(host, ownerId, userId)
        return
      }
      /*
       * 转化技拿出来的底牌印的不是【杀】，`beginVirtualSlash` 按有效牌名
       * 校验载体，所以别名要先设好（和【挑衅】同一条既有约定）。
       */
      if (host.state.cards[cardId]?.name !== '杀') setCardAlias(host.state, cardId, '杀')
      host.beginVirtualSlash({ sourceId: userId, targetId: victimId, sourceSkillId: XUANHUO, cardId })
      return
    }

    if (resolution.step === 'seize') {
      const userId = resolution.data.userId as PlayerId
      const picks = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const taken: CardId[] = []
      for (const picked of picks) {
        const cardId = resolvePickedCard(host.state, userId, picked)
        if (!cardId || taken.includes(cardId)) continue
        if (movePickedCard(host as never, userId, cardId, { kind: 'hand', playerId: ownerId })) {
          taken.push(cardId)
        }
      }
      if (taken.length === 0) return
      host.dispatch('LoseCard', { playerId: userId, cardIds: taken, reason: XUANHUO }, { targetId: userId, cardIds: taken })
      /*
       * 这条 `GainCard` 会被【恩怨】的「恩」接住：一次拿走同一个人两张牌，
       * 他要摸一张。两个技能各自成立，合起来就是这个结果，
       * **不在这里特判**——那是把两个技能焊死在一起。
       */
      host.dispatch('GainCard', { playerId: ownerId, cardIds: taken, reason: XUANHUO }, { targetId: ownerId, cardIds: taken })
    }
  },
})

/**
 * 惩罚分支：法正获得被指使者的两张牌。
 *
 * 走公共的 `pickableCardsOf`——**手牌只给占位槽**，法正不能先看清
 * 对方手牌再挑。牌不够两张就有几张挑几张，一张都没有时安静结束。
 */
function askSeize(host: SkillHost, ownerId: PlayerId, userId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  const user = playerOf(host.state, userId)
  if (!owner?.alive || !user?.alive || !hasPickableCards(host.state, userId)) return
  const pickable = pickableCardsOf(host.state, userId)
  const count = Math.min(2, pickable.cardIds.length + pickable.hiddenCardSlots.length)
  host.askSkill({
    skillId: XUANHUO, ownerId, step: 'seize', data: { userId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【眩惑】：${user.nickname}没有使用【杀】，获得其 ${count} 张牌`,
      timeoutMs: 25_000, optional: false, purpose: 'skill',
      cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
      min: count, max: count,
    }),
  })
}

export const FAZHENG: CharacterDefinition = {
  id: 'fazheng',
  name: '法正',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2011',
  skills: [
    {
      id: ENYUAN,
      name: '恩怨',
      description: '锁定技，当你获得其他角色两张或更多的牌时，该角色摸一张牌；'
        + '当你每受到 1 点伤害后，伤害来源须交给你一张手牌，否则失去 1 点体力。',
    },
    {
      id: XUANHUO,
      name: '眩惑',
      description: '摸牌阶段，你可以放弃摸牌，令一名其他角色摸两张牌，'
        + '然后其需对你指定的、在其攻击范围内的另一名角色使用一张【杀】，否则你获得其两张牌。',
    },
  ],
}
