import { delegateActiveSkill, delegateTriggeredSkill, delegatedActiveActions } from '../../engine/delegated-skill'
import { loseMaxHp } from '../../engine/hp'
import type { ChooseOptionRequest } from '../../engine/requests'
import { getSkillRuntime, grantSkill, registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { queueExtraTurn } from '../../engine/turn'
import { killedInTurn } from '../../engine/turn-kills'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神司马懿。本项目自研表述。
 *
 * 【忍戒】：锁定技，你受到伤害后获得 X 枚「忍」（X 为伤害值）；
 *   你于弃牌阶段内弃置手牌后，获得 X 枚「忍」（X 为弃置的手牌数）。
 * 【拜印】：觉醒技，准备阶段，若你的「忍」不小于 4，你减 1 点体力上限，并获得【极略】。
 * 【极略】：你可以在对应时机移去 1 枚「忍」，发动【鬼才】【放逐】【集智】【制衡】【完杀】之一。
 * 【连破】：一名角色的回合结束后，若你于该回合内杀死过至少一名角色，你可以获得一个额外回合。
 *
 * **极略不是永久获得那五个技能。** 这是架构上最要紧的一条：
 * 它每次借用一次已有技能的运行时，代价是 1 枚「忍」。
 * 五套逻辑不复制，也不永久授予——见 engine/delegated-skill.ts。
 *
 * 借用的是**经典版**鬼才 / 放逐 / 集智 / 制衡 / 完杀，
 * 不是后来的界版强化。项目里注册的就是经典版，直接按 id 借。
 */

const RENJIE = 'renjie'
const BAIYIN = 'baiyin'
const JILUE = 'jilue'
const LIANPO = 'lianpo'

/** 「忍」标记。和梦魇、暴怒共用公共的 `player.marks`。 */
export const REN_MARK = 'ren'

const BAIYIN_THRESHOLD = 4

/** 极略借用的五个经典技能。id 就是项目里已注册的那几个运行时。 */
const GUICAI = 'guicai'
const FANGZHU = 'fangzhu'
const JIZHI = 'jizhi'
const ZHIHENG = 'zhiheng'
const WANSHA = 'wansha'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function renOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[REN_MARK] ?? 0
}

function addRen(state: SanguoshaState, playerId: PlayerId, amount: number): void {
  const owner = playerOf(state, playerId)
  if (!owner || amount <= 0) return
  owner.marks[REN_MARK] = renOf(state, playerId) + amount
}

/** 花掉忍。不够就不花。 */
function spendRen(state: SanguoshaState, playerId: PlayerId, amount = 1): boolean {
  if (renOf(state, playerId) < amount) return false
  playerOf(state, playerId)!.marks[REN_MARK] = renOf(state, playerId) - amount
  return true
}

function hasJilue(state: SanguoshaState, playerId: PlayerId): boolean {
  const owner = playerOf(state, playerId)
  return Boolean(owner?.alive) && (owner?.grantedSkills ?? []).includes(JILUE)
}

/** 极略此刻能不能发动：觉醒了、还活着、至少 1 枚忍。 */
function canJilue(state: SanguoshaState, playerId: PlayerId): boolean {
  return hasJilue(state, playerId) && renOf(state, playerId) >= 1
}

// ─────────────────────────────── 忍戒 ───────────────────────────────

registerSkillRuntime({
  id: RENJIE,
  triggers: [
    {
      /** 受到伤害后按**伤害点数**获得忍：受到 3 点就是 3 枚。 */
      event: 'Damaged',
      // 优先级高于极略的放逐窗口：同一次伤害必须先拿到忍，才能立刻花掉它
      priority: 100,
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: unknown }).amount ?? 0)))
        if (amount <= 0 || !playerOf(host.state, ownerId)?.alive) return
        addRen(host.state, ownerId, amount)
        announceRen(host, ownerId, amount, '受到伤害')
      },
    },
    {
      /**
       * 弃牌阶段结束时，按本阶段**从手牌区弃置**的张数获得忍。
       *
       * 复用引擎已有的弃牌溯源账本，和神周瑜【琴音】同一个来源。
       * 使用牌、打出牌、弃装备、判定牌、拼点进弃牌堆都不算。
       */
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
        if (!playerOf(host.state, ownerId)?.alive) return
        const ledger = host.state.discardPhaseLedger
        if (!ledger) return
        const discarded = ledger.records.filter((record) => (
          record.sourcePlayerId === ownerId && record.originalZone === 'hand'
        )).length
        if (discarded <= 0) return
        addRen(host.state, ownerId, discarded)
        announceRen(host, ownerId, discarded, `弃置 ${discarded} 张手牌`)
      },
    },
  ],
})

function announceRen(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
  amount: number,
  reason: string,
): void {
  host.dispatch('SkillActivated', {
    skillId: RENJIE, skillName: '忍戒', playerId: ownerId,
    logText: `【忍戒】${playerOf(host.state, ownerId)?.nickname}因${reason}获得 ${amount} 枚「忍」`
      + `（共 ${renOf(host.state, ownerId)} 枚）`,
  }, { sourceId: ownerId })
}

// ─────────────────────────────── 拜印 ───────────────────────────────

registerSkillRuntime({
  id: BAIYIN,
  /**
   * 觉醒技，走公共的觉醒框架：准备阶段检查、只会觉醒一次、可序列化。
   * 不自己维护一个「已经觉醒过」的私有开关。
   */
  awakening: {
    phase: 'prepare',
    ready(state, ownerId) {
      return renOf(state, ownerId) >= BAIYIN_THRESHOLD
    },
    invoke(host, ownerId) {
      // 减 1 点体力上限走公共入口
      loseMaxHp(host as never, ownerId, 1, BAIYIN)
      grantSkill(host.state, ownerId, JILUE)
      host.dispatch('SkillActivated', {
        skillId: BAIYIN, skillName: '拜印', playerId: ownerId,
        logText: `${playerOf(host.state, ownerId)?.nickname}觉醒【拜印】，减 1 点体力上限，获得【极略】`,
      }, { sourceId: ownerId })
    },
  },
})

// ─────────────────────────────── 极略 ───────────────────────────────

registerSkillRuntime({
  id: JILUE,

  /**
   * 极略·鬼才：借用经典【鬼才】的改判候选。
   *
   * 只在还有忍时才报候选；**代价在改判真正落地时才收**——
   * 玩家点开之后又放弃（交空数组）不该白扣一枚忍。
   * 落地的信号是引擎派发的 `CardResponded`（reason 改判），见下面的触发器。
   */
  retrial(state, ownerId, judgingPlayerId) {
    if (!canJilue(state, ownerId)) return []
    // 真正复用经典【鬼才】的运行时，不复制一份改判候选逻辑
    return getSkillRuntime(GUICAI)?.retrial?.(state, ownerId, judgingPlayerId) ?? []
  },

  activeActions(state, ownerId) {
    if (!canJilue(state, ownerId)) return []
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // 极略·制衡：出牌阶段限一次，沿用被借技能自己的「本回合用过没有」判断
    const available = getSkillRuntime(ZHIHENG)?.activeActions?.(state, ownerId) ?? []
    if (available.length === 0) return []
    return [{ id: `${JILUE}:${ZHIHENG}`, label: `极略·制衡（移去 1 枚「忍」，共 ${renOf(state, ownerId)} 枚）` }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `${JILUE}:${ZHIHENG}`) return
    if (!canJilue(host.state, ownerId)) return
    const actions = delegatedActiveActions(host, ownerId, ZHIHENG)
    if (actions.length === 0) return
    /*
     * **不在这里预扣忍**。制衡自己会发一个选牌请求，玩家可以在那里交空放弃；
     * 预扣的话取消就白花一枚。改为在制衡真正发动（它自己派发 SkillActivated）
     * 时才收代价，见下面的触发器。
     */
    delegateActiveSkill(host, ownerId, ZHIHENG, actions[0].id)
  },

  triggers: [
    {
      /**
       * 极略·鬼才的**代价结算点**。
       *
       * 改判真正换牌时引擎会派发 `CardResponded`（reason 改判）。
       * 放弃改判（交空数组）不会走到这里，所以取消天然不扣忍。
       */
      event: 'SkillActivated',
      handle(host, ownerId, context) {
        /*
         * 放逐、制衡的**代价结算点**：它们自己有确认问句，
         * 真正发动时才派发 SkillActivated，所以取消天然不扣忍。
         * 集智不走这里——它没有问句、也不发这个事件，由极略自己问、自己扣。
         */
        const payload = context.event.payload as { skillId?: string; playerId?: PlayerId }
        if (payload.playerId !== ownerId || payload.skillId !== FANGZHU) return
        if (!hasJilue(host.state, ownerId)) return
        if (!spendRen(host.state, ownerId)) return
        announceJilue(host, ownerId, '放逐')
      },
    },
    {
      /**
       * 极略·制衡的**代价结算点**。
       *
       * 制衡不派发 `SkillActivated`，它落地的信号是弃牌那一步的
       * `LoseCard`（reason 制衡）——而且只有真的弃了牌才会发。
       * 所以在制衡的选牌里交空放弃，同样不扣忍。
       */
      event: 'LoseCard',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
        if (payload.playerId !== ownerId || payload.reason !== '制衡') return
        if (!hasJilue(host.state, ownerId)) return
        if (!spendRen(host.state, ownerId)) return
        announceJilue(host, ownerId, '制衡')
      },
    },
    {
      event: 'CardResponded',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; reason?: string }
        if (payload.reason !== '改判' || payload.playerId !== ownerId) return
        if (!hasJilue(host.state, ownerId)) return
        if (!spendRen(host.state, ownerId)) return
        announceJilue(host, ownerId, '鬼才')
      },
    },
    {
      /**
       * 极略·放逐：受到伤害后。
       *
       * **忍戒先结算**（它的优先级更高，而且这里是排队发问），
       * 所以 0 枚忍的神司马懿受到 1 点伤害后可以立刻用刚拿到的那枚忍发动放逐。
       * 这是经典 FAQ 明确的关键交互。
       */
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        if (!canJilue(host.state, ownerId)) return
        /*
         * **不自己再问一遍**。放逐有它自己的「发动放逐？」问句，
         * 极略这边再加一层就是问两次，而且玩家在第二问放弃时忍已经白扣了。
         * 直接把时机转交给放逐的运行时，代价在它真正发动时才收。
         */
        delegateTriggeredSkill(host, ownerId, FANGZHU, 'Damaged', context)
      },
    },
    {
      /** 极略·集智：使用一张非延时锦囊后。每张牌各一次机会。 */
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        if (!canJilue(host.state, ownerId)) return
        const payload = context.event.payload as { cardName?: string }
        // 能不能发动由被借的集智自己判断，这里只做便宜的前置过滤
        if (!payload.cardName) return
        host.queueSkill({
          skillId: JILUE, ownerId, step: JIZHI,
          data: { cardId: (context.event.payload as { cardId?: string }).cardId, cardName: payload.cardName },
        })
      },
    },
    {
      /**
       * 极略·完杀：**出牌阶段开始时**花 1 枚忍，本回合持续拥有完杀。
       *
       * 不是每次濒死都花一枚：花一次之后本回合内所有濒死都由这一次的效果处理。
       * 出牌阶段被真正跳过时这个时机不会到来，也就不会自动花忍。
       */
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        if (!canJilue(host.state, ownerId)) return
        host.queueSkill({ skillId: JILUE, ownerId, step: WANSHA, data: {} })
      },
    },
    {
      /** 本回合结束，收回临时的完杀。 */
      event: 'TurnEnd',
      handle(host, ownerId) {
        replaceTemporarySkill(host.state, ownerId, `${JILUE}:${WANSHA}`, null)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (!canJilue(host.state, ownerId)) return
    // 放逐、制衡由它们自己发问，这里只剩集智和完杀需要极略问一次
    const labels: Record<string, string> = { [JIZHI]: '集智', [WANSHA]: '完杀' }
    const label = labels[prompt.step]
    if (!label) return
    host.askSkill({
      skillId: JILUE, ownerId, step: prompt.step, data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【极略·${label}】？移去 1 枚「忍」（现有 ${renOf(host.state, ownerId)} 枚）`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: `极略·${label}` }, { id: 'no', label: '放弃' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!canJilue(host.state, ownerId)) return

    if (resolution.step === WANSHA) {
      if (!spendRen(host.state, ownerId)) return
      // 借用贾诩【完杀】的运行时，作为本回合的临时技能
      replaceTemporarySkill(host.state, ownerId, `${JILUE}:${WANSHA}`, WANSHA)
      announceJilue(host, ownerId, '完杀')
      return
    }

    if (resolution.step === JIZHI) {
      if (!spendRen(host.state, ownerId)) return
      announceJilue(host, ownerId, '集智')
      /*
       * 集智没有自己的问句（这个项目里它是「使用锦囊后直接摸一张」），
       * 所以由极略问、极略扣，然后把当时的时机重新交给集智的运行时。
       * 事件对象在排队期间已经过去了，按记录下来的 cardId / cardName 重建一个，
       * 字段和原时机一致——被借的运行时读的就是这两个。
       */
      delegateTriggeredSkill(host, ownerId, JIZHI, 'CardUsed', {
        event: {
          id: 'jilue-delegated', seq: host.state.seq, name: 'CardUsed',
          payload: resolution.data, sourceId: ownerId,
        },
        cancel: () => {},
        cancelled: false,
      } as never)
    }
  },
})

function announceJilue(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
  label: string,
): void {
  host.dispatch('SkillActivated', {
    skillId: JILUE, skillName: '极略', playerId: ownerId,
    logText: `${playerOf(host.state, ownerId)?.nickname}发动【极略·${label}】，移去 1 枚「忍」`
      + `（剩 ${renOf(host.state, ownerId)} 枚）`,
  }, { sourceId: ownerId })
}

// ─────────────────────────────── 连破 ───────────────────────────────

registerSkillRuntime({
  id: LIANPO,
  triggers: [{
    /**
     * 一名角色的回合结束后，若神司马懿在**该回合内**杀死过至少一名角色，
     * 可以获得一个额外回合。
     *
     * - **不必是他自己的回合**：在别人回合里用决斗杀了人同样算。
     * - **同一回合杀多人只有一次机会**，不是杀几个给几个额外回合。
     * - 额外回合走公共调度器排队，**不自己切 currentPlayer**，
     *   所以正常座次游标不会被推乱；额外回合里再杀人可以再次连破。
     */
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const turnNumber = Math.trunc(Number((context.event.payload as { turnNumber?: unknown }).turnNumber ?? host.state.turnNumber))
      if (!killedInTurn(host.state, ownerId, turnNumber)) return
      // 一个回合只给一次机会，即使这个技能被重复触发
      if (usedThisTurn(host.state, ownerId, LIANPO)) return
      markUsedThisTurn(host.state, ownerId, LIANPO)
      host.queueSkill({ skillId: LIANPO, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask' || !playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: LIANPO, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '发动【连破】？你于此回合内杀死过角色，可以获得一个额外回合',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动连破' }, { id: 'no', label: '放弃' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!playerOf(host.state, ownerId)?.alive) return
    queueExtraTurn(host.state, ownerId, { skillId: LIANPO, playerId: ownerId })
    host.dispatch('SkillActivated', {
      skillId: LIANPO, skillName: '连破', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【连破】，获得一个额外回合`,
    }, { sourceId: ownerId })
  },
})

export const SHENSIMAYI: CharacterDefinition = {
  id: 'shensimayi',
  name: '神·司马懿',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: RENJIE,
      name: '忍戒',
      description: '锁定技，你受到伤害后获得X枚「忍」（X为伤害值）；你于弃牌阶段内弃置手牌后，获得X枚「忍」（X为弃置的手牌数）。',
    },
    {
      id: BAIYIN,
      name: '拜印',
      description: '觉醒技，准备阶段，若你的「忍」不小于4，你减1点体力上限，并获得【极略】。',
    },
    {
      id: LIANPO,
      name: '连破',
      description: '一名角色的回合结束后，若你于此回合内杀死过至少一名角色，你可以获得一个额外回合。',
    },
  ],
}

/** 极略是觉醒后才获得的技能，不在初始技能列表里，但要能被查到名字和说明。 */
export const JILUE_SKILL = {
  id: JILUE,
  name: '极略',
  description: '你可以在对应时机移去1枚「忍」，发动【鬼才】【放逐】【集智】【制衡】或【完杀】之一。',
}
