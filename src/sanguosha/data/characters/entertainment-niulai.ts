import { resolveDamage } from '../../engine/damage'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest, GameResponse } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, DamageNature, PhysicalCard, PlayerId, SanguoshaState } from '../../engine/types'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 好友娱乐包·牛来。
 *
 * 【牛来】是赌博式的追涨：翻牌、拿牌、决定继续还是收手，一旦翻出更小的点数，
 * 本次拿到的全部吐回去。【妈妈】是伤害转移：打不过就把这一下甩给别人。
 *
 * 两条实现上的硬约束：
 *
 * 1. **失败清仓按 cardId 追踪**，不是「弃最后 N 张手牌」。技能过程中拿到的牌
 *    可能被别的效果拿走（顺手牵羊、过河拆桥），清仓时只处理**仍然属于牛来**
 *    的那几张，不去别人区域里抢。
 * 2. **【妈妈】转移的是原伤害本身**，不是牛来重新造一份新伤害：来源、点数、
 *    属性、牌全部原样带过去。复用小乔【天香】走通的那条路
 *    （DamageInflicted 里取消 + 排队 + 用同一份 facts 重新 resolveDamage）。
 */

export const NIULAI = 'niulai'
export const MAMA = 'mama'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 【牛来】用的点数大小。
 *
 * **A 是最大的（14），不是 1。** 牌库里 A 的 rank 就是 1，
 * 直接拿 `card.rank` 比会让 A 变成最小，追涨的手感整个反过来。
 */
export function niulaiRank(card: Pick<PhysicalCard, 'rank'>): number {
  return card.rank === 1 ? 14 : card.rank
}

/** 连续成功几次时说什么。纯表现，不影响任何数值。 */
function streakText(streak: number): string {
  if (streak >= 4) return '牛来！！！'
  if (streak === 3) return '牛真来了！'
  if (streak === 2) return '好像真来了'
  return '牛来了！'
}

/**
 * 翻开牌堆顶一张牌，放进处理区并公开。
 *
 * 牌堆空了就用现有的「弃牌堆洗回牌堆」——不另写一套洗牌。
 * 一张牌都没有时返回 null，调用方安全收尾。
 */
function revealTop(host: SkillHost, playerId: PlayerId, reason: string): CardId | null {
  if (host.state.zones.drawPile.length === 0) {
    if (host.state.zones.discardPile.length === 0) return null
    host.state.zones.drawPile.push(...host.rng.shuffle(host.state.zones.discardPile))
    host.state.zones.discardPile.length = 0
  }
  const cardId = host.state.zones.drawPile[0]
  if (!cardId) return null
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  host.dispatch('CardMove', {
    playerId, cardIds: [cardId], reason, revealed: true,
  }, { targetId: playerId, cardIds: [cardId] })
  return cardId
}

// ─────────────────────────────── 牛来 ───────────────────────────────

const CONTINUE = 'niulai-continue'
const STOP = 'niulai-stop'

registerSkillRuntime({
  id: NIULAI,

  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, NIULAI)) return []
    return [{ id: `skill:${NIULAI}`, label: '发动【牛来】：展示牌堆顶一张牌并获得，然后决定继续还是收手' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${NIULAI}`) throw new Error('牛来动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 先记账：中途取消不能刷次数
    markUsedThisTurn(host.state, ownerId, NIULAI)
    // 第一张不存在失败可能，直接翻开就拿
    const cardId = revealTop(host, ownerId, NIULAI)
    if (!cardId) return
    gainRevealed(host, ownerId, cardId)
    askContinue(host, ownerId, {
      lastRank: niulaiRank(host.state.cards[cardId]),
      gained: [cardId],
      streak: 1,
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    if (resolution.step !== 'ask') return
    const progress = progressOf(resolution.data)
    const owner = playerOf(host.state, ownerId)
    // 中途死了就当收手：已经拿到的牌照常留着
    if (!owner?.alive) return
    if ((response.payload as { optionId?: string }).optionId !== CONTINUE) {
      host.dispatch('SkillActivated', {
        skillId: NIULAI, skillName: '牛来', playerId: ownerId, result: 'stop', gained: progress.gained.length,
      }, { sourceId: ownerId })
      return
    }

    const cardId = revealTop(host, ownerId, NIULAI)
    // 牌堆和弃牌堆都空了：安全结束，之前拿到的牌保留
    if (!cardId) return
    const revealed = host.state.cards[cardId]
    const rank = niulaiRank(revealed)

    // **相等算成功**，只有严格变小才算失败
    if (rank >= progress.lastRank) {
      gainRevealed(host, ownerId, cardId)
      askContinue(host, ownerId, {
        lastRank: rank,
        gained: [...progress.gained, cardId],
        streak: progress.streak + 1,
      })
      return
    }

    // 牛走了：翻出来的这张进弃牌堆，本次拿到的全部吐回去
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    discardGained(host, ownerId, progress.gained)
    host.dispatch('SkillActivated', {
      skillId: NIULAI, skillName: '牛来', playerId: ownerId, result: 'bust', lost: progress.gained.length,
    }, { sourceId: ownerId })
  },
})

interface NiulaiProgress {
  lastRank: number
  gained: CardId[]
  streak: number
}

function progressOf(data: Record<string, unknown>): NiulaiProgress {
  return {
    lastRank: Number(data.lastRank ?? 0),
    gained: (data.gained as CardId[] | undefined) ?? [],
    streak: Number(data.streak ?? 0),
  }
}

/** 把刚翻开的牌收进手里。牌是公开翻出来的，所以 GainCard 带 revealed。 */
function gainRevealed(host: SkillHost, ownerId: PlayerId, cardId: CardId): void {
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('GainCard', {
    playerId: ownerId, cardIds: [cardId], reason: NIULAI, revealed: true,
  }, { targetId: ownerId, cardIds: [cardId] })
}

/**
 * 清仓：把本次【牛来】拿到的牌弃掉。
 *
 * **逐张按 cardId 检查当前位置**——过程中某张牌可能已经被顺手牵羊拿走了，
 * 那就不管它，不去别人区域里抢回来。
 */
function discardGained(host: SkillHost, ownerId: PlayerId, gained: readonly CardId[]): void {
  const discarded: CardId[] = []
  for (const cardId of gained) {
    const zone = locateOwnedCard(host.state, ownerId, cardId)
    if (!zone) continue
    moveCard(host.state, cardId, zone, { kind: 'discardPile' })
    discarded.push(cardId)
  }
  if (discarded.length === 0) return
  host.dispatch('LoseCard', {
    playerId: ownerId, cardIds: discarded, reason: NIULAI,
  }, { targetId: ownerId, cardIds: discarded })
}

function askContinue(host: SkillHost, ownerId: PlayerId, progress: NiulaiProgress): void {
  host.askSkill({
    skillId: NIULAI,
    ownerId,
    step: 'ask',
    data: { ...progress },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: ownerId,
      prompt: `${streakText(progress.streak)}当前点数 ${progress.lastRank}，已拿 ${progress.gained.length} 张。继续还是收手？`,
      timeoutMs: 20_000,
      optional: false,
      options: [
        { id: CONTINUE, label: '继续：再翻一张，点数不下降就拿走，否则本次全部弃置' },
        { id: STOP, label: '收手：结束技能，保留已经拿到的牌' },
      ],
    }),
  })
}

// ─────────────────────────────── 妈妈 ───────────────────────────────
//
// 每回合限一次：即将受到其他角色的伤害且自己体力不大于来源体力时，
// 可以弃一张牌并选另一名存活角色，把这次伤害整个转移过去。
//
// 走的是小乔【天香】验证过的那条路：在 DamageInflicted 取消原伤害、排队发问、
// 最后用**同一份 facts** 重新 resolveDamage，来源/点数/属性/牌一律不变。

interface MamaFacts {
  sourceId: PlayerId | null
  amount: number
  nature: DamageNature
  cardId: CardId | null
  cardName: string | null
}

function factsOf(data: Record<string, unknown>): MamaFacts {
  return {
    sourceId: (data.sourceId as PlayerId | null) ?? null,
    amount: Number(data.amount),
    nature: (data.nature as DamageNature) ?? 'normal',
    cardId: (data.cardId as CardId | null) ?? null,
    cardName: (data.cardName as string | null) ?? null,
  }
}

/** 放弃【妈妈】之后把原伤害原样重放。一次性标记避免又被自己拦下来。 */
function replayOriginal(host: SkillHost, ownerId: PlayerId, facts: MamaFacts): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner) return
  owner.marks.mamaSkip = (owner.marks.mamaSkip ?? 0) + 1
  resolveDamage(host as never, { ...facts, targetId: ownerId })
  // 伤害可能在到达 DamageInflicted 之前就被防具减没了，那时标记不会被消费
  if (owner.marks.mamaSkip) delete owner.marks.mamaSkip
}

/** 牛来现在能弃的牌：手牌加装备区。 */
function discardableCardIds(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const owner = playerOf(state, playerId)
  if (!owner?.alive) return []
  const equipment = Object.values(owner.zones.equipment).filter((id): id is CardId => Boolean(id))
  return [...owner.zones.hand, ...equipment]
}

/** 现在能不能发动【妈妈】。条件不满足就**根本不发问**。 */
function canInvokeMama(state: SanguoshaState, ownerId: PlayerId, sourceId: PlayerId | null): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  if (usedThisTurn(state, ownerId, MAMA)) return false
  // 无来源伤害没法比体力，直接不给发动
  if (!sourceId || sourceId === ownerId) return false
  const source = playerOf(state, sourceId)
  // 来源已经死了就读不到当前体力，按不能发动处理，不去猜
  if (!source?.alive) return false
  if (owner.hp > source.hp) return false
  if (discardableCardIds(state, ownerId).length === 0) return false
  return state.players.some((player) => player.alive && player.id !== ownerId)
}

registerSkillRuntime({
  id: MAMA,
  triggers: [{
    event: 'DamageInflicted',
    priority: 90,
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      // 刚刚放弃过一次，这一发是重放的原伤害，不要再问
      if (owner.marks.mamaSkip) {
        owner.marks.mamaSkip -= 1
        if (owner.marks.mamaSkip <= 0) delete owner.marks.mamaSkip
        return
      }
      // **由【妈妈】转移过来的伤害不能再转一次**，否则会在两个牛来之间无限来回
      if ((context.event.payload as { redirectedBy?: string }).redirectedBy === MAMA) return

      const sourceId = context.event.sourceId ?? null
      if (!canInvokeMama(host.state, ownerId, sourceId)) return
      const amount = Number(context.event.payload.amount)
      if (!Number.isInteger(amount) || amount <= 0) return

      context.cancel()
      // 伤害的调用方还要收尾当前的牌，这里只取消并排队，等牌局干净了再发问
      host.queueSkill({
        skillId: MAMA,
        ownerId,
        step: 'ask',
        data: {
          sourceId,
          amount,
          nature: context.event.damageNature ?? 'normal',
          cardId: (context.event.payload.cardId as CardId | null) ?? null,
          cardName: (context.event.payload.cardName as string | null) ?? null,
        },
      })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const facts = factsOf(prompt.data)
    // 排队期间局势可能变了（牌被拆光、来源死了），前提不成立就把原伤害还回去
    if (!canInvokeMama(host.state, ownerId, facts.sourceId)) {
      replayOriginal(host, ownerId, facts)
      return
    }
    host.askSkill({
      skillId: MAMA,
      ownerId,
      step: 'ask',
      data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `即将受到 ${facts.amount} 点伤害，是否发动【妈妈】把它转给别人？`,
        timeoutMs: 20_000,
        optional: true,
        options: [
          { id: 'mama-invoke', label: '妈妈！弃一张牌，让另一名角色替你承受' },
          { id: 'cancel', label: '取消：自己承受' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response: GameResponse) {
    const facts = factsOf(resolution.data)

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId?: string }).optionId !== 'mama-invoke') {
        replayOriginal(host, ownerId, facts)
        return
      }
      if (!canInvokeMama(host.state, ownerId, facts.sourceId)) {
        replayOriginal(host, ownerId, facts)
        return
      }
      // 先记账：反复取消不能刷次数
      markUsedThisTurn(host.state, ownerId, MAMA)
      host.askSkill({
        skillId: MAMA,
        ownerId,
        step: 'card',
        data: resolution.data,
        build: (requestId): ChooseCardsRequest => ({
          id: requestId,
          kind: 'choose-cards',
          playerId: ownerId,
          prompt: '【妈妈】：弃置一张牌',
          timeoutMs: 20_000,
          optional: false,
          purpose: 'skill',
          cardIds: discardableCardIds(host.state, ownerId),
          hiddenCardSlots: [],
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const zone = locateOwnedCard(host.state, ownerId, cardId)
      if (!zone) {
        replayOriginal(host, ownerId, facts)
        return
      }
      moveCard(host.state, cardId, zone, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: MAMA }, { targetId: ownerId, cardIds: [cardId] })

      const candidateIds = host.state.players
        .filter((player) => player.alive && player.id !== ownerId)
        .map((player) => player.id)
      if (candidateIds.length === 0) {
        replayOriginal(host, ownerId, facts)
        return
      }
      host.askSkill({
        skillId: MAMA,
        ownerId,
        step: 'target',
        data: resolution.data,
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          // 可以选伤害来源本人，这是设计允许的娱乐效果
          prompt: '选择一名角色替你承受此次伤害',
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    const target = playerOf(host.state, targetId)
    if (!target?.alive || targetId === ownerId) {
      replayOriginal(host, ownerId, facts)
      return
    }
    host.dispatch('SkillActivated', {
      skillId: MAMA, skillName: '妈妈', playerId: ownerId, targetIds: [targetId],
    }, { sourceId: ownerId, targetId })
    /*
     * 转移的是**原伤害本身**：来源、点数、属性、牌全部照搬，
     * 只换了承受的人。`redirectedBy` 跟着伤害走，接手的人（哪怕也是牛来）
     * 不能对同一次伤害再甩一次。
     */
    resolveDamage(host as never, { ...facts, targetId, redirectedBy: MAMA })
  },
})

export const NIULAI_CHARACTER: CharacterDefinition = {
  id: 'niulai',
  name: '牛来',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: NIULAI,
      name: '牛来',
      description: '出牌阶段限一次，你可以展示牌堆顶一张牌并获得之，然后可以选择继续或收手。若选择继续，再展示牌堆顶一张牌：若此牌点数不小于上一张，你获得此牌并可继续；若小于，则将此牌置入弃牌堆，并弃置本次以此法获得的所有牌，技能结束。点数大小为 A > K > Q > J > 10 > … > 2。',
    },
    {
      id: MAMA,
      name: '妈妈',
      description: '每回合限一次，当你即将受到其他角色造成的伤害时，若你的体力值不大于伤害来源的体力值，你可以弃置一张牌并选择另一名存活角色，防止此伤害，改为令该角色受到等量、同属性且来源相同的伤害。由此法转移的伤害不能再次发动【妈妈】。',
    },
  ],
}
