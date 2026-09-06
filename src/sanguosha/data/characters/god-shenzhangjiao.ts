import { deckReshuffledThisTurn, drawPileCardsWithRank, findCardsSummingTo, ruleCardNumber } from '../../engine/deck'
import { resolveDamage } from '../../engine/damage'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神张角。
 *
 * 【异兆】：锁定技，你使用或打出一张牌后，你获得等同于该牌点数的「黄」；
 *   若「黄」的十位数因此变化，你获得牌堆中一张点数为变化后十位数的牌。
 * 【肆军】：准备阶段，若你的「黄」数大于牌堆牌数，你可以移除所有「黄」，
 *   然后获得牌堆中点数之和恰好为 36 的若干张牌。
 * 【天劫】：牌堆于本回合洗过牌的回合结束时，你可以选择至多三名其他角色，
 *   对其各造成 X 点雷电伤害（X 为其手牌中【闪】的数量，且至少为 1）。
 *
 * 四处最容易做错的：
 *
 * 1. **点数要按统一口径取**，不能读牌名猜数字：虚拟牌没有点数，
 *    多张实体牌合成的转化牌也没有单一点数，随手取第一张子牌是错的。
 * 2. **十位数的定义要钉死**，而且一次标记变化只检查一次。
 * 3. **和为 36 是「恰好」**，不是「凑够」；而且不能暴力枚举——牌堆常有一百多张。
 * 4. **「洗过牌」是一条真事实**，不是「牌堆只剩几张了」猜出来的。
 */

const YIZHAO = 'yizhao'
const SIJUN = 'sijun'
const TIANJIE = 'tianjie'

/** 公共具名标记：黄。座位卡上要显示，所以键名固定在这里。 */
const HUANG = 'huang'
/** 肆军要凑的点数之和。 */
const SIJUN_SUM = 36
/** 天劫最多选几名角色。 */
const TIANJIE_MAX_TARGETS = 3

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function huangOf(state: SanguoshaState, ownerId: PlayerId): number {
  return playerOf(state, ownerId)?.marks[HUANG] ?? 0
}

/**
 * 「黄」的十位数。
 *
 * 本项目锁定为 `floor(黄 / 10)`：黄 9→16 时十位数从 0 变成 1，黄 18→30 时变成 3。
 * 黄超过 139 之后这个值会大于 13，牌堆里没有那样点数的牌，于是自然是空操作——
 * 不需要另写一条上限判断。
 */
function tensOf(huang: number): number {
  return Math.floor(huang / 10)
}

// ─────────────────────────────── 异兆 ───────────────────────────────

/**
 * 加「黄」，并在十位数变化时从牌堆取一张对应点数的牌。
 *
 * **一次标记变化只检查一次**：黄从 8 涨到 21 时，十位数是从 0 直接变成 2，
 * 只按变化后的 2 取一次牌，不会因为「路过了 1」再多取一张。
 */
function gainHuang(host: SkillHost, ownerId: PlayerId, amount: number, cardId: CardId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive || amount <= 0) return
  const before = owner.marks[HUANG] ?? 0
  const after = before + amount
  owner.marks[HUANG] = after
  host.dispatch('SkillActivated', {
    skillId: YIZHAO, skillName: '异兆', playerId: ownerId, cardIds: [cardId],
    logText: `${owner.nickname}获得 ${amount} 枚「黄」（共 ${after} 枚）`,
  }, { sourceId: ownerId, cardIds: [cardId] })

  const tens = tensOf(after)
  if (tens === tensOf(before)) return
  const candidates = drawPileCardsWithRank(host.state, tens)
  /*
   * 牌堆里没有这个点数就到此为止。
   *
   * **不去弃牌堆找，也不洗牌，更不凭空造一张**：这三种「补救」都会
   * 悄悄改变牌堆构成，而技能只说了「获得牌堆中一张」。
   */
  if (candidates.length === 0) return
  // 有多张时用牌局自己的随机源挑，同一个种子必然挑到同一张
  const picked = candidates[host.rng.nextInt(candidates.length)]
  moveCard(host.state, picked, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
  host.dispatch('SkillActivated', {
    skillId: YIZHAO, skillName: '异兆', playerId: ownerId,
    logText: `「黄」的十位数变为 ${tens}，${owner.nickname}获得牌堆中一张点数为 ${tens} 的牌`,
  }, { sourceId: ownerId })
  host.dispatch('GainCard', { playerId: ownerId, cardIds: [picked], reason: YIZHAO }, { targetId: ownerId, cardIds: [picked] })
}

registerSkillRuntime({
  id: YIZHAO,
  announcesSelf: true,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId }
        if ((context.event.sourceId ?? '') !== ownerId || !payload.cardId) return
        /*
         * 点数走公共口径：虚拟牌没有点数，多子牌转化也没有单一点数，
         * 两种情况都拿不到黄。转化牌按桌上真正在动的那张实体牌算。
         */
        const number = ruleCardNumber(host.state, payload.cardId)
        if (number === null) return
        gainHuang(host, ownerId, number, payload.cardId)
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; cardId?: CardId }
        if (payload.playerId !== ownerId || !payload.cardId) return
        const number = ruleCardNumber(host.state, payload.cardId)
        if (number === null) return
        gainHuang(host, ownerId, number, payload.cardId)
      },
    },
  ],
})

// ─────────────────────────────── 肆军 ───────────────────────────────

registerSkillRuntime({
  id: SIJUN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // **严格大于**，相等不算
      if (huangOf(host.state, ownerId) <= host.state.zones.drawPile.length) return
      /*
       * 凑不出和为 36 的组合就不提供发动机会。
       *
       * 代价是「移除所有黄」，先付后发现凑不出的话，一整局攒的黄就白没了——
       * 不给玩家一个付得起却拿不到东西的选择。
       */
      if (!findCardsSummingTo(host.state, host.rng, SIJUN_SUM)) return
      host.askSkill({
        skillId: SIJUN, ownerId, step: 'invoke',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【肆军】：移除全部 ${huangOf(host.state, ownerId)} 枚「黄」，获得牌堆中点数之和为 ${SIJUN_SUM} 的若干张牌？`,
          timeoutMs: 25_000, optional: true,
          options: [{ id: 'invoke', label: '发动【肆军】' }, { id: 'cancel', label: '不发动' }],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    if ((response.payload as { optionId?: string }).optionId !== 'invoke') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (huangOf(host.state, ownerId) <= host.state.zones.drawPile.length) return
    // 发问期间牌堆变了就重新找一次；找不到就不发动，黄也不扣
    const picked = findCardsSummingTo(host.state, host.rng, SIJUN_SUM)
    if (!picked || picked.length === 0) return

    delete owner.marks[HUANG]
    for (const cardId of picked) {
      moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    }
    host.dispatch('SkillActivated', {
      skillId: SIJUN, skillName: '肆军', playerId: ownerId, cardIds: picked,
      logText: `${owner.nickname}发动【肆军】，移除所有「黄」并获得 ${picked.length} 张点数之和为 ${SIJUN_SUM} 的牌`,
    }, { sourceId: ownerId, cardIds: picked })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: picked, reason: SIJUN }, { targetId: ownerId, cardIds: picked })
  },
})

// ─────────────────────────────── 天劫 ───────────────────────────────

/** 天劫对某人的伤害值：其手牌里【闪】的张数，至少 1。 */
function tianjieAmount(state: SanguoshaState, targetId: PlayerId): number {
  const target = playerOf(state, targetId)
  if (!target) return 1
  /*
   * 数的是**实体牌名**就是【闪】的手牌。
   *
   * 「这张黑牌可以靠技能当闪打出」不算——那是潜力，不是手里有闪。
   */
  const dodges = target.zones.hand.filter((cardId) => state.cards[cardId]?.name === '闪').length
  return Math.max(1, dodges)
}

registerSkillRuntime({
  id: TIANJIE,
  announcesSelf: true,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!deckReshuffledThisTurn(host.state)) return
      if (host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).length === 0) return
      host.queueSkill({ skillId: TIANJIE, ownerId, step: 'targets', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'targets') {
      const candidateIds = host.state.players
        .filter((candidate) => candidate.alive && candidate.id !== ownerId)
        .map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: TIANJIE, ownerId, step: 'targets', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【天劫】：选择至多三名其他角色，各造成雷电伤害（伤害值为其手牌中【闪】的数量，至少 1）',
          timeoutMs: 25_000, optional: true,
          candidateIds, min: 0, max: Math.min(TIANJIE_MAX_TARGETS, candidateIds.length),
        }),
      })
      return
    }
    if (prompt.step !== 'damage') return
    const targetId = String((prompt.data as { targetId?: unknown }).targetId ?? '')
    const target = playerOf(host.state, targetId)
    // 排队期间目标可能已经死了；前一发伤害之后手牌数也可能变了，所以现读
    if (!target?.alive) return
    resolveDamage(host as never, {
      sourceId: ownerId,
      targetId,
      amount: tianjieAmount(host.state, targetId),
      nature: 'thunder',
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'targets') return
    const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    if (targetIds.length === 0) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const ordered = host.state.players
      .filter((candidate) => candidate.alive && targetIds.includes(candidate.id))
      .sort((left, right) => left.seat - right.seat)
    host.dispatch('SkillActivated', {
      skillId: TIANJIE, skillName: '天劫', playerId: ownerId, targetIds: ordered.map((target) => target.id),
      logText: `${owner.nickname}发动【天劫】，目标：${ordered.map((target) => target.nickname).join('、')}`,
    }, { sourceId: ownerId })
    for (const target of ordered) {
      host.queueSkill({ skillId: TIANJIE, ownerId, step: 'damage', data: { targetId: target.id } })
    }
  },
})

export const SHENZHANGJIAO: CharacterDefinition = {
  id: 'shenzhangjiao',
  name: '神·张角',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 3,
  pack: 'god',
  skills: [
    {
      id: YIZHAO,
      name: '异兆',
      description: '锁定技，你使用或打出一张牌后，你获得等同于此牌点数的「黄」；若「黄」的十位数因此发生变化，你获得牌堆中一张点数为变化后十位数的牌。',
    },
    {
      id: SIJUN,
      name: '肆军',
      description: '准备阶段，若你的「黄」数大于牌堆的牌数，你可以移除所有「黄」，然后获得牌堆中点数之和为36的若干张牌。',
    },
    {
      id: TIANJIE,
      name: '天劫',
      description: '牌堆于本回合洗过牌的回合结束时，你可以选择至多三名其他角色，你对这些角色各造成X点雷电伤害（X为其手牌中【闪】的数量，且至少为1）。',
    },
  ],
}
