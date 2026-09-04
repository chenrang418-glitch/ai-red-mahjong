import { resolveDamage } from '../../engine/damage'
import { loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { effectiveCardSuit, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState, Suit } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import { skillIdsOf } from './standard'
import type { CharacterDefinition } from './types'

/**
 * 神周瑜。经典「神话再临·神」版本。
 *
 * - **琴音**：弃牌阶段结束时，若你于此阶段内弃置过你的至少两张手牌，
 *   你可以选择一项：令所有角色各回复 1 点体力；或令所有角色各失去 1 点体力。
 * - **业炎**：限定技，出牌阶段，你可以对至多三名角色造成共计 3 点火焰伤害
 *   （由你分配）。若你对任意一名角色分配了至少 2 点伤害，
 *   你须先弃置四张花色各不相同的手牌并失去 3 点体力。
 */

export const QINYIN = 'qinyin'
export const YEYAN = 'yeyan'

const YEYAN_ACTION = 'yeyan-invoke'
const QINYIN_RECOVER = 'qinyin-recover'
const QINYIN_LOSE = 'qinyin-lose'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function suitOf(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): Suit {
  return effectiveCardSuit(state, ownerId, cardId, skillIdsOf)
}

/** 座次稳定顺序：全体结算必须按固定次序逐名进行。 */
function aliveInSeatOrder(state: SanguoshaState): PlayerId[] {
  return [...state.players].filter((player) => player.alive).sort((left, right) => left.seat - right.seat).map((player) => player.id)
}

// ─────────────────────────────── 琴音 ───────────────────────────────

registerSkillRuntime({
  id: QINYIN,
  // 自己会播完整横幅（含选了哪一项），引擎不要再补一条通用的
  announcesSelf: true,

  triggers: [{
    /**
     * 弃牌阶段**结束时**判定，不是结束阶段。
     *
     * 统计口径是**本弃牌阶段内从手牌区被弃置的牌**：使用牌、打出牌都不算。
     * 直接复用引擎已有的弃牌溯源账本（`state.discardPhaseLedger`，
     * 张昭张纮【固政】的同一份），不为琴音另建一套计数器。
     */
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const ledger = host.state.discardPhaseLedger
      if (!ledger) return
      const discarded = ledger.records.filter((record) => (
        record.sourcePlayerId === ownerId && record.originalZone === 'hand'
      )).length
      if (discarded < 2) return
      /*
       * 走延后队列而不是当场发问：弃牌阶段的收尾里还挂着别的技能时机
       * （固政也在这个事件上排队），当场问会撞「已有技能正在等待回应」。
       */
      host.queueSkill({ skillId: QINYIN, ownerId, step: 'ask', data: { discarded } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'apply') {
      applyQinyinStep(host, ownerId, prompt.data.optionId as string, (prompt.data.remaining as PlayerId[]) ?? [])
      return
    }
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.askSkill({
      skillId: QINYIN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【琴音】？本弃牌阶段弃置了 ${prompt.data.discarded} 张手牌`,
        timeoutMs: 20_000, optional: true,
        options: [
          { id: QINYIN_RECOVER, label: '令所有角色各回复 1 点体力' },
          { id: QINYIN_LOSE, label: '令所有角色各失去 1 点体力' },
          { id: 'no', label: '放弃' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const optionId = (response.payload as { optionId: string }).optionId
    if (optionId !== QINYIN_RECOVER && optionId !== QINYIN_LOSE) return

    host.dispatch('SkillActivated', {
      skillId: QINYIN, skillName: '琴音', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【琴音】，所有角色各${optionId === QINYIN_RECOVER ? '回复' : '失去'} 1 点体力`,
    }, { sourceId: ownerId })

    /*
     * **按座次稳定顺序逐名结算，而且一次只处理一个人。**
     *
     * 失去体力走 `loseHp`（不是伤害），所以藤甲、大雾这些防伤效果都不介入。
     * 但 `loseHp` 会在体力归零时进濒死，那时牌局要停下来求桃——
     * 在一个 for 循环里连着扣完所有人，会撞「当前濒死流程尚未结束」直接崩。
     * 所以把剩下的人排进延后队列：牌局回到干净状态才处理下一个。
     */
    host.queueSkill({ skillId: QINYIN, ownerId, step: 'apply', data: { optionId, remaining: aliveInSeatOrder(host.state) } })
  },
})

/** 琴音逐名结算的一步：处理队首那一个，剩下的重新排队。 */
function applyQinyinStep(host: SkillHost, ownerId: PlayerId, optionId: string, remaining: PlayerId[]): void {
  const queue = [...remaining]
  while (queue.length > 0) {
    const playerId = queue.shift()!
    const target = playerOf(host.state, playerId)
    if (!target?.alive) continue
    if (optionId === QINYIN_RECOVER) {
      if (target.hp < target.maxHp) recover(host as never, playerId, 1, ownerId)
      // 回复不会引发濒死，可以直接接着处理下一个
      continue
    }
    loseHp(host as never, playerId, 1, '琴音')
    // 失去体力可能引发濒死：把剩下的人交给队列，等牌局干净了再继续
    if (queue.length > 0) {
      host.queueSkill({ skillId: QINYIN, ownerId, step: 'apply', data: { optionId, remaining: queue } })
    }
    return
  }
}

// ─────────────────────────────── 业炎 ───────────────────────────────

/** 手上有没有四张花色各不相同的牌——大业炎的门槛。 */
function differentSuitCards(state: SanguoshaState, ownerId: PlayerId): Map<Suit, CardId[]> {
  const owner = playerOf(state, ownerId)
  const bySuit = new Map<Suit, CardId[]>()
  for (const cardId of owner?.zones.hand ?? []) {
    const suit = suitOf(state, ownerId, cardId)
    bySuit.set(suit, [...(bySuit.get(suit) ?? []), cardId])
  }
  return bySuit
}

function canPayBigYeyan(state: SanguoshaState, ownerId: PlayerId): boolean {
  return differentSuitCards(state, ownerId).size >= 4
}

/**
 * 从手牌里凑一组花色各不相同的四张牌。凑不出返回 null。
 *
 * 既给 AI 用，也给结算兜底用：走到「付代价」这一步时代价是**强制**的，
 * 客户端交上来一组不合法的牌不能变成「技能白白没了」或「反复重发」——
 * 这里给出一个确定性的合法解，结算继续往下走。
 */
function pickFourDifferentSuits(state: SanguoshaState, ownerId: PlayerId): CardId[] | null {
  const bySuit = differentSuitCards(state, ownerId)
  if (bySuit.size < 4) return null
  return [...bySuit.values()].slice(0, 4).map((cardIds) => cardIds[0])
}

/**
 * 业炎能选几个目标。
 *
 * 3 点伤害要分完，而「对任意一人分到 ≥2 点」就必须付代价，
 * 所以**付不起代价时唯一的合法分配是三人各 1 点**——
 * 选 1 个人（只能 3 点）或 2 个人（必有一人 2 点）都要付代价。
 * 付不起又凑不满三名敌人时，这个技能这一刻根本发不出来，返回 null。
 */
function yeyanTargetRange(state: SanguoshaState, ownerId: PlayerId): { candidateIds: PlayerId[]; min: number; max: number } | null {
  const candidateIds = state.players
    .filter((player) => player.alive && player.id !== ownerId)
    .map((player) => player.id)
  if (candidateIds.length === 0) return null
  if (canPayBigYeyan(state, ownerId)) return { candidateIds, min: 1, max: Math.min(3, candidateIds.length) }
  if (candidateIds.length < 3) return null
  return { candidateIds, min: 3, max: 3 }
}

registerSkillRuntime({
  id: YEYAN,
  limited: true,
  // 自己会播完整横幅（含目标和分配），引擎不要再补一条通用的
  announcesSelf: true,

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'burn') return
    burnYeyanStep(host, ownerId, (prompt.data.remaining as Array<{ targetId: PlayerId; amount: number }>) ?? [])
  },

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(YEYAN)) return []
    // 一个合法分配都凑不出来时就别把按钮放出来
    if (yeyanTargetRange(state, ownerId) === null) return []
    return [{ id: YEYAN_ACTION, label: '业炎：对至多三名角色造成共计 3 点火焰伤害' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== YEYAN_ACTION) return
    const range = yeyanTargetRange(host.state, ownerId)
    if (!range) return
    host.askSkill({
      skillId: YEYAN, ownerId, step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: range.min === 3
          ? '【业炎】：选择三名角色（各 1 点火焰伤害；你付不起大业炎的代价）'
          : '【业炎】：选择至多三名角色',
        timeoutMs: 30_000,
        // 取消不消耗限定技
        optional: true,
        // min 保持 0 以允许取消；「至少要几个」由 resume 落地前校验
        candidateIds: range.candidateIds, min: 0, max: range.max,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targetIds = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
      // 取消（交空）不消耗限定技，这是规则允许的
      if (targetIds.length === 0) return
      const range = yeyanTargetRange(host.state, ownerId)
      // 选了一组凑不出合法分配的目标：当作没发动，限定技留着
      if (!range || targetIds.length < range.min) return
      askYeyanSplit(host, ownerId, targetIds)
      return
    }

    if (resolution.step === 'split') {
      const targetIds = resolution.data.targetIds as PlayerId[]
      const optionId = (response.payload as { optionId: string }).optionId
      const split = parseSplit(optionId, targetIds)
      if (!split) return

      // 大业炎门槛：**对任意一名角色分配了至少 2 点**就要先付代价
      const needsCost = split.some((entry) => entry.amount >= 2)
      if (!needsCost) {
        fireYeyan(host, ownerId, split)
        return
      }
      if (!canPayBigYeyan(host.state, ownerId)) return
      host.askSkill({
        skillId: YEYAN, ownerId, step: 'cost', data: { split },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【业炎】：弃置四张花色各不相同的手牌（随后失去 3 点体力）',
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          cardIds: [...(playerOf(host.state, ownerId)?.zones.hand ?? [])], hiddenCardSlots: [],
          min: 4, max: 4,
        }),
      })
      return
    }

    if (resolution.step === 'cost') {
      const split = resolution.data.split as Array<{ targetId: PlayerId; amount: number }>
      const cardIds = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // **花色必须各不相同**，而且都得真的在手上
      const suits = new Set(cardIds.map((cardId) => suitOf(host.state, ownerId, cardId)))
      const allInHand = cardIds.every((cardId) => owner.zones.hand.includes(cardId))
      /*
       * 交上来的牌不合法时**不能直接 return**。
       *
       * 这一步的代价是强制的（请求 optional: false），中途放弃没有规则依据；
       * 而静默返回会让限定技没被消耗，出牌阶段可以原样再发一次——
       * 压测里就是这么转成死循环的（seed=soak-5-178）。
       * 走到这里代价一定付得起（split 那步已经验过），所以兜一组合法的继续。
       */
      const paid = (cardIds.length === 4 && suits.size === 4 && allInHand)
        ? cardIds
        : pickFourDifferentSuits(host.state, ownerId)
      if (!paid) return

      for (const cardId of paid) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: paid, reason: YEYAN }, { sourceId: ownerId, cardIds: paid })
      // 失去 3 点体力是 **LoseHp 不是伤害**：不触发受伤时机，也不会被防伤挡掉
      loseHp(host as never, ownerId, 3, '业炎')
      // 付完代价自己可能已经进濒死甚至死了，那就不再放火
      if (!playerOf(host.state, ownerId)?.alive) return
      fireYeyan(host, ownerId, split)
    }
  },
})

/**
 * 伤害分配的选项。
 *
 * 3 点分给至多 3 个人的组合很少，直接把合法组合列成选项，
 * 比让玩家逐个填数字好点也好测。
 */
function splitOptions(targetIds: PlayerId[]): Array<{ id: string; label: string; split: Array<{ targetId: PlayerId; amount: number }> }> {
  const results: Array<{ id: string; label: string; split: Array<{ targetId: PlayerId; amount: number }> }> = []
  const walk = (index: number, remaining: number, current: Array<{ targetId: PlayerId; amount: number }>): void => {
    if (index === targetIds.length) {
      // 每个选中的目标都必须分到伤害，且总量正好 3 点
      if (remaining === 0 && current.every((entry) => entry.amount > 0)) {
        const id = current.map((entry) => `${entry.targetId}:${entry.amount}`).join('|')
        results.push({ id, label: current.map((entry) => `${entry.targetId} ${entry.amount} 点`).join('，'), split: [...current] })
      }
      return
    }
    for (let amount = 1; amount <= remaining; amount += 1) {
      walk(index + 1, remaining - amount, [...current, { targetId: targetIds[index], amount }])
    }
  }
  walk(0, 3, [])
  return results
}

function parseSplit(optionId: string, targetIds: PlayerId[]): Array<{ targetId: PlayerId; amount: number }> | null {
  return splitOptions(targetIds).find((option) => option.id === optionId)?.split ?? null
}

function askYeyanSplit(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[]): void {
  const options = splitOptions(targetIds)
  if (options.length === 0) return
  const canPayBig = canPayBigYeyan(host.state, ownerId)
  // 付不起代价的话，「对某人 ≥2 点」那些分配根本选不了
  const legal = options.filter((option) => canPayBig || option.split.every((entry) => entry.amount < 2))
  if (legal.length === 0) return
  host.askSkill({
    skillId: YEYAN, ownerId, step: 'split', data: { targetIds },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【业炎】：分配这 3 点火焰伤害（对任意一人分到 2 点及以上时，需先弃四张不同花色手牌并失去 3 点体力）',
      timeoutMs: 30_000, optional: false,
      options: legal.map((option) => ({
        id: option.id,
        label: option.split.some((entry) => entry.amount >= 2) ? `${option.label}（需付代价）` : option.label,
      })),
    }),
  })
}

/**
 * 真正放火。
 *
 * 走统一伤害管线，所以铁索连环传导、藤甲、天香、涅槃、不屈、暴虐、
 * 神诸葛亮【狂风】/【大雾】全都自然生效——不能自己扣血。
 */
function fireYeyan(host: SkillHost, ownerId: PlayerId, split: Array<{ targetId: PlayerId; amount: number }>): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  owner.usedLimitedSkills.push(YEYAN)
  host.dispatch('SkillActivated', {
    skillId: YEYAN, skillName: '业炎', playerId: ownerId, targetIds: split.map((entry) => entry.targetId),
    logText: `${owner.nickname}发动【业炎】：${split.map((entry) => `${playerOf(host.state, entry.targetId)?.nickname ?? ''} ${entry.amount} 点`).join('，')}`,
  }, { sourceId: ownerId })

  // 逐名结算，一次只烧一个：中途有人濒死要先把求桃走完，
  // 连着 resolveDamage 会撞「当前濒死流程尚未结束」
  host.queueSkill({ skillId: YEYAN, ownerId, step: 'burn', data: { remaining: split } })
}

/** 业炎逐名结算的一步。 */
function burnYeyanStep(host: SkillHost, ownerId: PlayerId, remaining: Array<{ targetId: PlayerId; amount: number }>): void {
  const queue = [...remaining]
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (!playerOf(host.state, ownerId)?.alive) return
    if (!playerOf(host.state, entry.targetId)?.alive) continue
    resolveDamage(host as never, { sourceId: ownerId, targetId: entry.targetId, amount: entry.amount, nature: 'fire' })
    if (queue.length > 0) {
      host.queueSkill({ skillId: YEYAN, ownerId, step: 'burn', data: { remaining: queue } })
    }
    return
  }
}

export const SHENZHOUYU: CharacterDefinition = {
  id: 'shenzhouyu',
  name: '神·周瑜',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: QINYIN,
      name: '琴音',
      description: '弃牌阶段结束时，若你于此阶段内弃置过你的至少两张手牌，你可以选择一项：令所有角色各回复1点体力；或令所有角色各失去1点体力。',
    },
    {
      id: YEYAN,
      name: '业炎',
      description: '限定技。出牌阶段，你可以对至多三名角色造成共计3点火焰伤害（由你分配）。若你对任意一名角色分配了至少2点伤害，你须先弃置四张花色各不相同的手牌并失去3点体力。',
    },
  ],
}
