import { drawCards } from '../../engine/draw'
import { gainMaxHp, loseMaxHp } from '../../engine/hp'
import { registerSkillRuntime, skillsOf } from '../../engine/skills/runtime'
import {
  addSourceMark,
  clearSourceMarks,
  sourceMarkCount,
} from '../../engine/source-marks'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import { moveCard } from '../../engine/zones'
import { skillIdsOf } from './standard'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神孙策。
 *
 * 【英霸】：出牌阶段限一次，令一名体力上限大于 1 的其他角色减 1 点体力上限并获得
 *   1 枚「平定」，然后自己减 1 点体力上限。你对有你「平定」的角色使用牌无距离限制。
 * 【覆海】：锁定技，有你「平定」的角色不能响应你对其使用的牌；你指定这样的角色为
 *   目标后摸一张牌，每回合最多以此法摸 2 张；这样的角色死亡时，你增加 X 点体力上限
 *   并摸 X 张牌（X 为其拥有的、来源于你的「平定」数）。
 * 【冯河】：锁定技，你的手牌上限基础值等于已损失体力值；你即将受到其他角色造成的
 *   伤害时，若你有手牌且体力上限大于 1，则防止此伤害，减 1 点体力上限，
 *   将一张手牌交给一名其他角色，然后若你仍拥有【英霸】，伤害来源获得 1 枚「平定」。
 *
 * 整套技能只有一个真正的难点：**「平定」必须绑定来源**。
 * 娱乐模式允许同名武将重复出场，一桌上可能坐着两个神孙策；
 * 只记「这个人有几枚平定」会让 A 贴的标记给 B 送去死亡回收，
 * 覆海也会把 B 使用的牌一起封掉。所以标记走公共的 source-marks，
 * 每一枚都记着是谁贴的。
 */

const YINGBA = 'yingba'
const FUHAI = 'fuhai'
const FENGHE = 'fenghe'

/** 「平定」在 source-marks 里的 key。 */
export const PINGDING_MARK = 'pingding'

/** 覆海每回合最多靠「指定目标」摸这么多张。 */
const FUHAI_DRAW_CAP = 2
/** 本回合已经靠覆海摸了几张。挂在神孙策自己身上，回合开始时清零。 */
const FUHAI_DRAWN_MARK = 'fuhai-drawn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 这名角色身上有没有 `sourceId` 贴的「平定」。 */
function hasPingdingFrom(state: SanguoshaState, targetId: PlayerId, sourceId: PlayerId): boolean {
  return sourceMarkCount(state, targetId, PINGDING_MARK, sourceId) > 0
}

/**
 * 这个人**此刻**还有没有生效的【英霸】。
 *
 * 冯河的最后一段写的是「若你仍拥有【英霸】」，所以不能在注册时算死：
 * 断肠会永久移除，神张辽【夺锐】会临时压制。`skillsOf` 返回的就是
 * 当前真正生效的那一份，压制和移除都已经算进去了。
 */
function hasEffectiveYingba(state: SanguoshaState, ownerId: PlayerId): boolean {
  return skillsOf(state, ownerId, skillIdsOf).some((runtime) => runtime.id === YINGBA)
}

// ─────────────────────────────── 英霸 ───────────────────────────────

registerSkillRuntime({
  id: YINGBA,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || usedThisTurn(state, ownerId, YINGBA)) return []
    if (yingbaCandidates(state, ownerId).length === 0) return []
    return [{ id: YINGBA, label: '发动【英霸】' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== YINGBA) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || usedThisTurn(host.state, ownerId, YINGBA)) return
    const candidateIds = yingbaCandidates(host.state, ownerId)
    if (candidateIds.length === 0) return
    markUsedThisTurn(host.state, ownerId, YINGBA)
    host.askSkill({
      skillId: YINGBA, ownerId, step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【英霸】：令一名体力上限大于 1 的其他角色减 1 点体力上限并获得「平定」，然后你减 1 点体力上限',
        timeoutMs: 25_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'target') return
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
    /*
     * 目标条件在**提交时重验**。
     *
     * 发问期间目标可能已经被别的效果减到 1 点上限，甚至已经死了。
     * 照着当初的候选表结算会把人减到 0 上限——文本要求的是「大于 1」，
     * 也就是至少留 1 点给他。
     */
    if (!targetId || !yingbaCandidates(host.state, ownerId).includes(targetId)) return
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return

    host.dispatch('SkillActivated', {
      skillId: YINGBA, skillName: '英霸', playerId: ownerId, targetId,
      logText: `${owner.nickname}对${target.nickname}发动【英霸】`,
    }, { sourceId: ownerId, targetId })

    loseMaxHp(host as never, targetId, 1, YINGBA)
    addSourceMark(host.state, targetId, PINGDING_MARK, ownerId)
    /*
     * 自己也要减，而且**不加「自己上限必须大于 1」这个条件**。
     *
     * 文本只对目标有那个限制。神孙策自己减到 0 上限就是会死——
     * 这是这个技能真实的代价，替他加一条保护等于改牌。
     * `loseMaxHp` 里已经含了 0 血检查，不需要在这里另外处理死亡。
     */
    loseMaxHp(host as never, ownerId, 1, YINGBA)
  },
  /**
   * 对有自己「平定」的角色使用牌不受距离限制。
   *
   * 文本说的是「使用牌」而不是「使用杀」，所以走的是公共的
   * `ignoresDistanceTo`，【顺手牵羊】【兵粮寸断】的距离 1 也一并覆盖。
   */
  ignoresDistanceTo(state, ownerId, targetId) {
    return hasPingdingFrom(state, targetId, ownerId)
  },
})

/** 英霸的合法目标：体力上限大于 1 的其他存活角色。 */
function yingbaCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId && candidate.maxHp > 1)
    .map((candidate) => candidate.id)
}

// ─────────────────────────────── 覆海 ───────────────────────────────

registerSkillRuntime({
  id: FUHAI,
  /**
   * 有「平定」的角色不能响应神孙策对其使用的【杀】。
   *
   * 这不是「少打一张闪」：无双、肉林那种要求两张闪的环境里，
   * 他同样是**一张都不能打**，因为他压根没有响应权。
   * `noDodge` 正是「这张杀不可被闪响应」的公共字段。
   */
  slashUndodgeable(state, ownerId, targetId) {
    return hasPingdingFrom(state, targetId, ownerId)
  },
  /**
   * 锦囊同理：【决斗】不能打杀、【奇正相生】杀闪都打不出，
   * 于是秘密模式对应的惩罚自然发生，不需要为哪张牌写特例。
   *
   * 封的只有目标本人。别人替他使用【无懈可击】是另一条链路，
   * 不从这里走，也不该被一起封掉。
   */
  trickUnresponsive(state, ownerId, targetId) {
    return hasPingdingFrom(state, targetId, ownerId)
  },
  triggers: [
    {
      /** 回合开始清空本回合的覆海摸牌计数。 */
      event: 'TurnStart',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (owner) delete owner.marks[FUHAI_DRAWN_MARK]
      },
    },
    {
      /*
       * 指定有「平定」的角色为目标后摸一张，每回合最多 2 张。
       *
       * 挂在 `TargetConfirmed` 而不是 `CardUsed`：一张多目标锦囊指定了
       * 三个有平定的角色，是三次「指定这样的角色为目标」，只是被每回合 2 张
       * 的上限截到 2 —— 按 CardUse 去重会错成 1 张。
       * 这和孙策【激昂】那种 CardUse 级触发不是同一个语义。
       */
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { targetId?: PlayerId }
        const targetId = payload.targetId
        const owner = playerOf(host.state, ownerId)
        if (!targetId || !owner?.alive) return
        if (!hasPingdingFrom(host.state, targetId, ownerId)) return
        const drawn = owner.marks[FUHAI_DRAWN_MARK] ?? 0
        if (drawn >= FUHAI_DRAW_CAP) return
        owner.marks[FUHAI_DRAWN_MARK] = drawn + 1
        host.dispatch('SkillActivated', {
          skillId: FUHAI, skillName: '覆海', playerId: ownerId, targetId,
          logText: `${owner.nickname}发动【覆海】，摸一张牌`,
        }, { sourceId: ownerId, targetId })
        drawCards(host.state, host.rng, ownerId, 1, (name, eventPayload) => host.dispatch(name, eventPayload))
      },
    },
    {
      /*
       * 有「平定」的角色**真正死亡**时回收。
       *
       * 只挂 `Death`：濒死被桃救回来、周泰【不屈】撑住、庞统【涅槃】翻回来
       * 都没有真正死亡，一律不触发。
       */
      event: 'Death',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        const deadId = payload.playerId
        const owner = playerOf(host.state, ownerId)
        if (!deadId || !owner?.alive || deadId === ownerId) return
        const count = sourceMarkCount(host.state, deadId, PINGDING_MARK, ownerId)
        if (count <= 0) return
        // 先清账再结算：这个人已经离场，标记留着只会变成幽灵数据
        clearSourceMarks(host.state, deadId, PINGDING_MARK)
        host.dispatch('SkillActivated', {
          skillId: FUHAI, skillName: '覆海', playerId: ownerId, targetId: deadId,
          logText: `${owner.nickname}发动【覆海】，增加 ${count} 点体力上限并摸 ${count} 张牌`,
        }, { sourceId: ownerId, targetId: deadId })
        // 加上限**不回复体力**：1/3 加 3 点是 1/6，不是 4/6
        gainMaxHp(host as never, ownerId, count, FUHAI)
        drawCards(host.state, host.rng, ownerId, count, (name, eventPayload) => host.dispatch(name, eventPayload))
      },
    },
  ],
})

// ─────────────────────────────── 冯河 ───────────────────────────────

registerSkillRuntime({
  id: FENGHE,
  /**
   * 手牌上限的**基础值**等于已损失体力值。
   *
   * 是基数覆盖，不是加成：`maxCardsOf` 先取这个基数，再叠加结营 +2、
   * 止啼 -1 之类的修正。写成 `maxCardsBonus` 会变成「体力值 + 已损失」，
   * 完全不是一回事。
   */
  fixedMaxCards(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner) return null
    return Math.max(0, owner.maxHp - owner.hp)
  },
  triggers: [{
    /*
     * 即将受到**其他角色**造成的伤害时防止之。
     *
     * 挂在 `BeforeDamage` 并 `cancel()`：这是真正的伤害防止，不是
     * 「先掉血再回」。所以卖血技能不触发、连环传导的后续不发生、
     * 也不会进入濒死——这些全都发生在扣 HP 之后，而我们根本走不到那里。
     */
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const sourceId = context.event.sourceId
      // 「其他角色造成的」：无来源伤害（闪电、酒后自伤那种无源情形）照常受到
      if (!sourceId || sourceId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (owner.zones.hand.length === 0 || owner.maxHp <= 1) return

      context.cancel()
      host.dispatch('SkillActivated', {
        skillId: FENGHE, skillName: '冯河', playerId: ownerId,
        logText: `${owner.nickname}发动【冯河】，防止这次伤害并减 1 点体力上限`,
      }, { sourceId: ownerId })
      loseMaxHp(host as never, ownerId, 1, FENGHE)
      /*
       * 「若你仍拥有【英霸】」要**实时**判断：断肠移除、夺锐压制之后
       * 冯河仍然有效，但这一段不再给来源贴平定。
       */
      if (hasEffectiveYingba(host.state, ownerId)) {
        addSourceMark(host.state, sourceId, PINGDING_MARK, ownerId)
        host.dispatch('SkillActivated', {
          skillId: FENGHE, skillName: '冯河', playerId: ownerId, targetId: sourceId,
          logText: `${playerOf(host.state, sourceId)?.nickname}获得一枚「平定」`,
        }, { sourceId: ownerId, targetId: sourceId })
      }
      /*
       * 交牌排队问，不当场挂请求。
       *
       * 这里还在伤害结算里面：当场挂一个 Request 会和外层的牌结算
       * （决斗还在轮询下一个目标、锦囊还没收牌）抢同一个玩家的注意力。
       * `queueSkill` 会等牌局回到干净状态再放出来。
       */
      host.queueSkill({ skillId: FENGHE, ownerId, step: 'give', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'give') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    if (giveCandidates(host.state, ownerId).length === 0) return
    host.askSkill({
      skillId: FENGHE, ownerId, step: 'give-card',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【冯河】：将一张手牌交给一名其他角色',
        timeoutMs: 25_000,
        // 强制的，不是「可以」；只能是手牌，装备不行
        optional: false, purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'give-card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      if (!cardId || !owner?.zones.hand.includes(cardId)) return
      const candidateIds = giveCandidates(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: FENGHE, ownerId, step: 'give-target', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【冯河】：把这张牌交给谁',
          timeoutMs: 25_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'give-target') return
    const cardId = String(resolution.data.cardId ?? '')
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    // 发问期间目标可能死了、牌也可能已经不在手上
    if (!cardId || !owner?.zones.hand.includes(cardId) || !target?.alive) return
    /*
     * **是「交给」，不是弃置。**
     * 直接从手牌移到手牌，不经过弃牌堆——过一趟弃牌堆会让
     * 「弃牌时」「牌进入弃牌堆时」那一批时机全部误触发。
     */
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: targetId })
    host.dispatch('SkillActivated', {
      skillId: FENGHE, skillName: '冯河', playerId: ownerId, targetId,
      logText: `${owner.nickname}将一张手牌交给${target.nickname}`,
    }, { sourceId: ownerId, targetId })
    host.dispatch('CardMove', { cardId, cardIds: [cardId], reason: FENGHE }, { sourceId: ownerId, targetId, cardIds: [cardId] })
  },
})

/** 冯河交牌的候选：其他存活角色。 */
function giveCandidates(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    .map((candidate) => candidate.id)
}

export const SHENSUNCE: CharacterDefinition = {
  id: 'shensunce',
  name: '神·孙策',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 6,
  /*
   * 初始体力 1、体力上限 6。
   *
   * 走项目已有的独立 initialHp 机制，**不是** 6/6 也不是把上限写成 1。
   * 身份局主公的 +1 由公共初始化叠加，自然得到 2/7；
   * 不能因为是主公就变成 7/7。
   */
  initialHp: 1,
  pack: 'god',
  skills: [
    {
      id: YINGBA,
      name: '英霸',
      description: '出牌阶段限一次，你可以令一名体力上限大于1的其他角色减1点体力上限并获得1枚「平定」，然后你减1点体力上限。你对拥有你「平定」的角色使用牌无距离限制。',
    },
    {
      id: FUHAI,
      name: '覆海',
      description: '锁定技，拥有你「平定」的角色不能响应你对其使用的牌。你指定拥有你「平定」的角色为目标后，你摸一张牌，每回合至多以此法摸2张。拥有你「平定」的角色死亡时，你增加X点体力上限并摸X张牌（X为其拥有的、来源于你的「平定」数量）。',
    },
    {
      id: FENGHE,
      name: '冯河',
      description: '锁定技，你的手牌上限基础值等于你已损失的体力值。你即将受到其他角色造成的伤害时，若你有手牌且体力上限大于1，则防止此伤害，你减1点体力上限并将一张手牌交给一名其他角色，然后若你仍拥有【英霸】，则伤害来源获得1枚「平定」。',
    },
  ],
}
