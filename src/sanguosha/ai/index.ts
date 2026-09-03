import type { LegalAction } from '../engine/actions'
import type { ChooseCardsRequest, GameRequest, GameResponse } from '../engine/requests'
import { assertNever } from '../engine/requests'
import type { GameRng } from '../engine/rng'
import type { PlayerId, Suit } from '../engine/types'
import type { PlayerView } from '../engine/view'
import { hostility, PROTECTED, type SuspicionMap } from './belief'

/**
 * 单机 AI。
 *
 * 铁律：**只读 PlayerView 和 LegalAction，不碰 SanguoshaState。**
 * 未公开身份和别人的手牌在 PlayerView 里本来就是 null / 占位牌，
 * 所以「困难 AI 偷看身份」这种作弊在类型层面就做不到。
 *
 * 另一条硬要求：`respond` 必须对每一种 Request 都给出合法响应。
 * 漏掉任何一种，无头压测就会死锁在那个请求上——
 * 这正是压测要抓的问题，所以这里用 assertNever 强制穷尽。
 */

export type AIDifficulty = 'easy' | 'normal' | 'hard'

export interface AIContext {
  view: PlayerView
  difficulty: AIDifficulty
  rng: GameRng
  suspicion: SuspicionMap
}

/** 牌的粗略价值：越高越舍不得弃。 */
export function cardValue(name: string): number {
  switch (name) {
    case '桃': return 10
    case '无懈可击': return 8
    case '闪': return 7
    case '酒': return 5
    case '杀': return 4
    default: return 3
  }
}

/**
 * 延时锦囊（【乐不思蜀】【兵粮寸断】）的价值。
 *
 * 这是**公共评分**，不是给某个武将写的：实体牌和转化出来的（徐晃【断粮】）
 * 走同一条。以前两者都掉进 default 拿 8 分，等于「见到就随便扔给谁」。
 *
 * 三件事决定分数：
 *
 * 1. **目标值不值得限**。用 targetScore，自己人和主公会被判 -Infinity 直接否掉。
 * 2. **对方靠不靠摸牌**。兵粮断的是摸牌阶段，对方手牌越少越难受；
 *    乐断的是出牌阶段，对方手牌越多、能打的越多才越值得乐。
 * 3. **付出的牌值不值**。转化（`play:viewas:`）要拿一张真牌去换，
 *    拿【桃】【闪】换一张兵粮是纯亏——这一条正是「不要见黑牌就断粮」。
 *    装备区的牌还要额外算上脱装备的代价。
 */
function delayedTrickScore(
  context: AIContext,
  action: Extract<LegalAction, { kind: 'use-card' }>,
): number {
  const [targetId] = action.targetIds
  const value = targetScore(context, targetId)
  if (!Number.isFinite(value)) return -100
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target) return -100

  // 兵粮：手牌越少越依赖摸牌，断了最疼；乐：手牌越多越可惜他这个出牌阶段
  const pressure = action.asCardName === '兵粮寸断'
    ? 8 - Math.min(target.handCount, 6)
    : Math.min(target.handCount, 6)
  let score = 12 + value + pressure

  if (action.id.startsWith('play:viewas:')) {
    const me = myself(context.view)
    const [cardId] = action.cardIds
    const paid = (me.hand ?? []).find((card) => card.id === cardId)
    // 找不到就说明这张牌在装备区：拆自己的装备去断粮，代价明显更高
    score -= paid ? cardValue(paid.name) : 12
  }
  return score
}

/**
 * 【再起】发不发动。
 *
 * 拿「亮 X 张、红桃换血其余进手牌」去换掉确定的两张牌，所以要算期望：
 * 红桃约占四分之一，X 张里大约 0.75X 张进手牌、0.25X 点回血。
 *
 * - X=1：期望不到一张牌，明显亏于稳摸两张——只有快死了、那 25% 的回血
 *   比牌更值钱时才赌。
 * - X=2：牌上打平，回血是净赚，但血量还宽裕时不值得为半点期望回血放弃确定收益。
 * - X≥3：牌和血都占优，没有不发动的理由。
 */
function shouldZaiqi(me: { hp: number; maxHp: number }): boolean {
  const lost = Math.max(0, me.maxHp - me.hp)
  if (lost >= 3) return true
  if (lost === 2) return me.hp <= 2
  return me.hp <= 1
}

/** 装备值不值得抢：防具和武器远比马重要，抢错了等于白赢一次拼点。 */
const EQUIPMENT_PRIORITY: Readonly<Record<string, number>> = {
  诸葛连弩: 9, 贯石斧: 7, 青龙偃月刀: 7, 丈八蛇矛: 7, 方天画戟: 7, 雌雄双股剑: 6,
  麒麟弓: 6, 寒冰剑: 6, 古锭刀: 5, 八卦阵: 8, 仁王盾: 8, 藤甲: 8, 白银狮子: 7,
}

/**
 * 【烈刃】赢了之后拿哪张。
 *
 * 装备区是公开的，拿得到确定价值；手牌是盲的，期望值只有「一张平均牌」。
 * 所以只要对方有**值得抢的**装备就抢装备，否则再去盲抽手牌。
 * 马的价值低于一张未知手牌，不为了「看得见」就去抢一匹马。
 */
function chooseStolenCard(context: AIContext, publicIds: readonly string[], hiddenSlots: readonly string[]): string {
  const best = [...publicIds]
    .map((cardId) => ({ cardId, score: EQUIPMENT_PRIORITY[cardName(context, cardId)] ?? 0 }))
    .sort((left, right) => right.score - left.score)[0]
  // 4 是「一张未知手牌」的粗略估值：比马高，比防具和主流武器低
  if (best && best.score >= 4) return best.cardId
  if (hiddenSlots.length > 0) return context.rng.pick([...hiddenSlots])
  return publicIds[0] ?? hiddenSlots[0]
}

/**
 * 要不要发动【烈刃】。
 *
 * 代价是一张手牌（拼点牌赢输都会弃掉），收益是对方一张牌，所以本质是
 * 「用一张牌赌换一张牌 + 一次点数比拼」。**点数够大才划算**——
 * 手上最大只有 5 点还去拼，等于白送一张。
 *
 * 引擎已经保证「双方都有手牌」，这里不用再判一次。
 */
function shouldInvokeLieren(context: AIContext): boolean {
  const me = myself(context.view)
  const best = Math.max(0, ...(me.hand ?? []).map((card) => card.rank ?? 0))
  if (best >= 10) return true
  // 牌多的时候可以拿一张中等点数去赌；手牌紧张就别折腾
  return best >= 8 && me.handCount >= 3
}

/**
 * 【英魂】对某个候选目标能榨出多少收益。
 *
 * 这个技能**两头都能用**，所以先分敌我再算净牌差，绝不能只看「谁好打」：
 *
 * - 自己人走「摸 X 弃 1」，净赚 X-1 张；
 * - 敌人走「摸 1 弃 X」，净亏 X-1 张，但**最多只能拆到他没牌**，
 *   所以要按他实际有多少牌封顶，否则会高估拆一个空手敌人的价值。
 *
 * X=1 时两种模式都是净 0 张，只剩「换一张牌」的过牌价值，所以分数很低。
 */
function yinghunScore(context: AIContext, targetId: PlayerId): number {
  const me = myself(context.view)
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const x = Math.max(0, me.maxHp - me.hp)
  const attitude = hostility(context.view, context.suspicion, targetId)
  if (attitude > 0) {
    // 拆敌人：摸 1 弃 X，实际能拆掉的张数受他手上有多少牌限制
    const stripped = Math.min(x, target.handCount + 1) - 1
    return stripped * 3 + attitude
  }
  // 帮自己人：摸 X 弃 1，缺牌的队友优先
  return (x - 1) * 3 + Math.max(0, 4 - target.handCount)
}

/**
 * 选哪一项。
 *
 * **这是最容易资敌的一步**：X=3 的时候对只剩一张牌的敌人用「摸 3 弃 1」，
 * 等于白送他两张。所以规则很硬——敌人一律拆牌，自己人一律补牌，
 * 目标是谁由选项 id 尾巴上带的那一段决定，不去猜提示语里的昵称。
 */
function chooseYinghunMode(context: AIContext, options: readonly { id: string }[]): string {
  const drawMany = options.find((option) => option.id.startsWith('yinghun-draw-many'))
  const discardMany = options.find((option) => option.id.startsWith('yinghun-discard-many'))
  const targetId = (drawMany ?? discardMany)?.id.split(':')[1] ?? ''
  const attitude = hostility(context.view, context.suspicion, targetId)
  const picked = attitude > 0 ? discardMany : drawMany
  return (picked ?? options[0]).id
}

/**
 * 要不要发动【英魂】。
 *
 * 没有代价，唯一的理由是「发动了也没意义」：X=1 时两种模式都是净 0 张，
 * 只有帮自己人过一张牌还算有点用，对敌人则完全是白忙。
 */
function shouldInvokeYinghun(context: AIContext): boolean {
  const me = myself(context.view)
  const x = Math.max(0, me.maxHp - me.hp)
  if (x <= 0) return false
  if (x >= 2) return true
  return context.view.players.some((player) => (
    player.alive && player.id !== me.id && hostility(context.view, context.suspicion, player.id) <= 0
  ))
}

/** 目标价值：先看阵营敌意，再看血少、手牌少好不好打。 */
function targetScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const attitude = hostility(context.view, context.suspicion, targetId)
  // 自己人和主公绝不能被选中，哪怕血最少最好打
  if (attitude <= PROTECTED) return -Infinity
  let score = 10 - target.hp * 2 - Math.min(target.handCount, 6) + attitude
  // 简单档带一点随机，别每局都一模一样
  if (context.difficulty === 'easy') score += context.rng.nextInt(7)
  else if (context.difficulty === 'normal') score += context.rng.nextInt(4)
  return score
}

function myself(view: PlayerView) {
  return view.players.find((player) => player.id === view.viewerId)!
}

/**
 * 出牌阶段选一个动作。返回 null 表示结束出牌。
 */
/**
 * 主动技的价值。
 *
 * 在此之前 `decidePlayAction` 只看 `use-card`，`invoke-skill` 从来不会被选中——
 * 也就是说苦肉、制衡、结姻、青囊、反间、离间、强袭全部对 AI 不存在。
 * 这里给每个主动技一个分数，和出牌放在同一个池子里比较。
 *
 * 分数只求「不做蠢事」，不求最优：能一眼看出是自杀或纯亏的一律给负分，
 * 剩下的给一个中等偏低的分，让 AI 在没有好牌可出时才发动。
 */
function skillActionScore(context: AIContext, action: Extract<LegalAction, { kind: 'invoke-skill' }>): number {
  const me = myself(context.view)
  const enemies = context.view.players
    .filter((player) => player.alive && player.id !== me.id)
    .map((player) => targetScore(context, player.id))
  const bestTarget = enemies.length > 0 ? Math.max(...enemies) : -Infinity

  switch (action.skillId) {
    case 'qiangxi': {
      // 打不到值得打的人就别付代价
      if (bestTarget <= 0) return -100
      const hasWeapon = me.equipment.some((card) => card.equipmentSlot === 'weapon')
      // 没有武器就只能拿血换，1 血换等于自杀
      if (!hasWeapon && me.hp <= 1) return -100
      // 血少还硬换很亏；有武器可弃时代价低得多
      const cost = hasWeapon ? 2 : (me.hp <= 2 ? 14 : 6)
      return 12 + bestTarget - cost
    }
    case 'huangtian': {
      // 黄天是把防御牌送给主公。反贼/内奸没有理由做这件事；
      // 主公和忠臣也要看自己够不够用——只剩一张闪还送出去等于自杀。
      const lord = context.view.players.find((player) => player.identity === 'lord' && player.alive)
      if (!lord || hostility(context.view, context.suspicion, lord.id) > 0) return -100
      const dodges = me.hand?.filter((card) => card.name === '闪').length ?? 0
      if (me.hp <= 2 && dodges <= 1) return -100
      // 主公越危险越该送
      return lord.hp <= 2 ? 12 : 4
    }
    case 'niulai':
      // 第一张必定拿到，等于白摸一张牌，没有不发动的理由
      return 15
    case 'guhuo': {
      // 蛊惑不花代价：真声明基本稳赚，假声明要赌没人质疑。
      // 手牌越多越敢用（被拆穿只亏一张），手上只剩一张时收着点。
      return me.handCount <= 1 ? 2 : 13
    }
    case 'houxiao': {
      // 齁笑不花代价，两条分支都不亏；但手里全是好牌时随机交换有风险
      const precious = (me.hand ?? []).filter((card) => cardValue(card.name) >= 8).length
      return precious >= 2 ? 6 : 14
    }
    case 'kurou':
      // 苦肉在 1 血时直接进濒死，除非已经没别的路，否则不发
      return me.hp <= 1 ? -100 : 6
    case 'zhiheng':
      // 手牌越少换得越值；满手牌时收益有限
      return me.handCount <= 2 ? 18 : 10
    case 'qingnang':
      // 有人受伤才有意义
      return context.view.players.some((player) => player.alive && player.hp < player.maxHp) ? 16 : -100
    case 'jieyin':
      return me.hp < me.maxHp ? 14 : -20
    case 'fanjian':
      return bestTarget > 0 ? 12 : -20
    case 'lijian':
      return bestTarget > 0 ? 14 : -20
    case 'luanji': {
      /*
       * 乱击是群体伤害：**敌我一起打**，所以必须先算净收益，不能「有两张同花色就用」。
       *
       * 收益 = 打到的敌人数，代价 = 打到的自己人数 + 两张底牌的价值。
       * 手上有闪的角色多半躲得掉，这里按公开信息估不到别人的手牌，只能按
       * 「手牌越多越可能有闪」折算。
       */
      const me4 = myself(context.view)
      const others = context.view.players.filter((player) => player.alive && player.id !== me4.id)
      if (others.length === 0) return -100
      let gain = 0
      for (const target of others) {
        const attitude = hostility(context.view, context.suspicion, target.id)
        // 手牌越多越可能闪掉；残血的敌人收益更高
        const likely = target.handCount >= 3 ? 0.5 : 1
        const worth = target.hp <= 1 ? 2.5 : 1
        gain += attitude > 0 ? likely * worth * 2 : -likely * 3
      }
      // 两张底牌的代价：桃、无懈、闪这些丢了很亏
      const cheapest = [...(me4.hand ?? [])].sort((left, right) => cardValue(left.name) - cardValue(right.name))
      const cost = (cardValue(cheapest[0]?.name ?? '') + cardValue(cheapest[1]?.name ?? '')) / 2
      const score = gain * 3 - cost
      return score > 4 ? Math.min(16, Math.round(score)) : -100
    }
    case 'tianyi': {
      /*
       * 赢了才有收益，输了本回合彻底不能出杀——所以**手上完全没有杀就别赌**：
       * 赢了也用不出来，输了还白挨一个禁令。
       */
      const me3 = myself(context.view)
      const slashes = (me3.hand ?? []).filter((card) => card.name === '杀').length
      if (slashes === 0) return -100
      const enemies3 = context.view.players.filter((player) => player.alive && player.id !== me3.id
        && hostility(context.view, context.suspicion, player.id) > 0)
      if (enemies3.length === 0) return -100
      // 手上杀越多、值得打的敌人越多，多目标和多一次出杀就越值钱
      return 10 + Math.min(slashes, 2) * 3 + Math.min(enemies3.length, 2) * 2
    }
    case 'quhu': {
      /*
       * 借敌人之手打敌人：赢了对方替我出刀，输了自己挨一刀但能触发节命。
       *
       * **没有值得拼的敌人时直接给负分**，不能给一个「低但为正」的分数——
       * 后面选目标那一步不会交空，硬发动只会拿友军来拼点。
       */
      const me2 = myself(context.view)
      if (me2.hp <= 1) return -100
      const worthy = context.view.players.some((player) => player.alive && player.id !== me2.id
        && player.hp > me2.hp && player.handCount > 0
        && hostility(context.view, context.suspicion, player.id) > 0)
      if (!worthy) return -100
      return me2.handCount >= 2 ? 13 : 6
    }
    case 'kongchengji': {
      // 没手牌时是白摸一张，随时可以发；有手牌时是赌，牌越多亏得越狠，
      // 但赌赢能摸两张——手牌不多的时候最划算
      if (me.handCount === 0) return 12
      if (bestTarget <= 0) return 2
      return me.handCount <= 3 ? 13 : 5
    }
    case 'ganggan':
      // 血少的时候还不上就要掉血，压低意愿；手牌紧张时才值得加杠杆
      if (me.hp <= 1) return -100
      return me.handCount <= 2 ? 14 : 4
    case 'shuajian':
      // 一血时主动邀战风险过高；手牌紧张时才积极发动，避免每回合稳定补牌拖长整局。
      if (me.hp <= 1 || bestTarget <= 0) return -100
      return me.handCount <= 2 ? 10 : 2
    default:
      // 装备的主动效果（丈八蛇矛、方天画戟）等：给个低分，有更好的牌就先出牌
      return 3
  }
}

export function decidePlayAction(context: AIContext, actions: readonly LegalAction[]): LegalAction | null {
  const useActions = actions.filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
  const skillActions = actions.filter((action): action is Extract<LegalAction, { kind: 'invoke-skill' }> => action.kind === 'invoke-skill')
  if (useActions.length === 0 && skillActions.length === 0) return null

  const me = myself(context.view)
  let best: { action: LegalAction; score: number } | null = null

  for (const action of skillActions) {
    let score = skillActionScore(context, action)
    if (context.difficulty !== 'hard') score += context.rng.nextInt(3)
    if (!best || score > best.score) best = { action, score }
  }

  for (const action of useActions) {
    let score = 0
    switch (action.asCardName) {
      case '杀': {
        // 没有目标价值就别硬打。方天画戟能打多人，多打一个就多算一份——
        // 只按最好的那个目标算的话，多目标永远不会被选中。
        const perTarget = action.targetIds.map((targetId) => targetScore(context, targetId))
        const best = Math.max(...perTarget, -Infinity)
        const extras = perTarget.filter((value) => value > 0 && value !== best)
        score = 6 + best + extras.reduce((sum, value) => sum + value * 0.6, 0)
        // 丈八蛇矛拿两张牌换一张【杀】，只有手上没有真【杀】时才划算
        if (action.cardIds.length > 1) score -= 8
        break
      }
      case '桃':
        score = me.hp < me.maxHp ? 30 : -100
        break
      case '无中生有':
        score = 25
        break
      case '桃园结义':
        score = me.hp < me.maxHp ? 22 : 8
        break
      case '顺手牵羊':
      case '过河拆桥':
        score = 18 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), 0)
        break
      case '南蛮入侵':
      case '万箭齐发': {
        // 群体伤害：自己血少时别乱放，敌人多才划算
        // 打到自己人是要扣分的，所以直接把每个目标的敌意加起来，
        // 被保护的目标（主公、确认的自己人）给一个明确的重罚
        score = action.targetIds.reduce((sum, targetId) => {
          const attitude = hostility(context.view, context.suspicion, targetId)
          return sum + (attitude <= PROTECTED ? -15 : attitude)
        }, 0)
        break
      }
      case '乐不思蜀':
      case '兵粮寸断':
        score = delayedTrickScore(context, action)
        break
      case '决斗':
        score = 10 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), 0)
        break
      case '火攻':
        score = 11 + Math.max(...action.targetIds.map((targetId) => targetScore(context, targetId)), 0)
        break
      case '铁索连环':
        if (action.id.startsWith('play:recast:')) {
          score = 5
        } else {
          score = action.targetIds.reduce((sum, targetId) => {
            const target = context.view.players.find((candidate) => candidate.id === targetId)
            if (!target) return sum
            const enemy = hostility(context.view, context.suspicion, targetId) > 0
            // 敌人未横置、友军已横置才值得切换；反向操作应明确扣分。
            return sum + (enemy === !target.chained ? 9 : -9)
          }, 0)
        }
        break
      case '酒':
        // 手上没杀就别喝
        score = -50
        break
      default:
        // 装备一律先穿上；重铸是把废牌换成新牌，稳赚但优先级低于真正的进攻；
        // 其余锦囊给个中性分
        if (action.label.startsWith('装备')) score = 20
        else if (action.id.startsWith('play:recast:')) score = 5
        else score = 8
    }
    if (context.difficulty !== 'hard') score += context.rng.nextInt(5)
    if (!best || score > best.score) best = { action, score }
  }

  if (!best || best.score <= 0) return null
  return best.action
}

/** 从若干 actionId 里挑一个「打出牌」的，没有就放弃。 */
function preferPlay(actionIds: readonly string[], prefix: string): string | null {
  const playable = actionIds.filter((id) => id.startsWith(prefix))
  return playable.length > 0 ? playable[0] : null
}

/**
 * 对任意 Request 给出合法响应。
 *
 * 每一个分支都必须真的返回一个合法 payload——
 * 返回 null 或漏掉分支会让牌局停在这里，压测就是用来抓这个的。
 */
export function decideResponse(context: AIContext, request: GameRequest): GameResponse {
  const base = { requestId: request.id, playerId: request.playerId }

  switch (request.kind) {
    case 'choose-general':
      return { ...base, payload: { characterId: context.rng.pick(request.candidates) } }

    case 'choose-cards': {
      const pool = [...request.cardIds, ...request.hiddenCardSlots]
      if (request.min === 0 && pool.length === 0) return { ...base, payload: { cardIds: [] } }
      if (request.purpose === 'retrial' && request.retrial) {
        return { ...base, payload: { cardIds: decideRetrial(context, request) } }
      }
      // 【乱击】选两张同花色的底牌：挑价值最低的那一组，别拿桃和无懈去换
      if (request.prompt.startsWith('【乱击】')) {
        return { ...base, payload: { cardIds: chooseLuanjiCards(context, request.cardIds) } }
      }
      // 拼点：统一走公共选牌，技能通过 intent 表达想赢还是想输
      if (request.purpose === 'pindian') {
        return { ...base, payload: { cardIds: [choosePindianCard(context, request.cardIds, 'win')] } }
      }
      // 【杠杆】还债：能用低价值牌抵掉就别硬扛体力
      if (request.prompt.startsWith('【杠杆】：还欠')) {
        return { ...base, payload: { cardIds: repayGanggan(context, request.cardIds, request.max) } }
      }
      // 【麻麻】弃两张牌换一刀：挑手上最不值钱的两张
      if (request.prompt.startsWith('【麻麻】：弃置')) {
        const cheapest = [...request.cardIds]
          .sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
        return { ...base, payload: { cardIds: cheapest.slice(0, Math.max(request.min, 2)) } }
      }
      // 蛊惑扣掉的牌不管真假都花出去了，所以挑手上最不值钱的那张
      if (request.prompt.startsWith('【蛊惑】')) {
        const declaredName = /当作【(.+?)】打出/.exec(request.prompt)?.[1]
        const truthfulCards = declaredName
          ? request.cardIds.filter((cardId) => cardName(context, cardId) === declaredName)
          : []
        // AI 已决定“真蛊惑”时，必须真的扣同名牌；否则才拿低价值牌诈。
        const candidates = truthfulCards.length > 0 ? truthfulCards : request.cardIds
        const cheapest = [...candidates]
          .sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
        return { ...base, payload: { cardIds: cheapest.slice(0, 1) } }
      }
      // 被【英魂】指到时弃自己的牌：一律从最不值钱的开始丢
      if (request.prompt.startsWith('【英魂】：弃置')) {
        const cheapest = [...request.cardIds]
          .sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
        return { ...base, payload: { cardIds: cheapest.slice(0, request.min) } }
      }
      // 【烈刃】赢了拿对方一张牌：公开的装备优先，看不见的手牌只能盲抽
      if (request.prompt.startsWith('【烈刃】')) {
        return { ...base, payload: { cardIds: [chooseStolenCard(context, request.cardIds, request.hiddenCardSlots)] } }
      }
      // 弃牌阶段挑价值最低的丢；其余场合挑第一张够用
      const sorted = request.purpose === 'discard-phase'
        ? [...request.cardIds].sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
        : pool
      const count = Math.min(Math.max(request.min, 1), request.max, sorted.length)
      return { ...base, payload: { cardIds: sorted.slice(0, count) } }
    }

    case 'choose-targets': {
      /*
       * 【驱虎】有两个选目标的窗口，提示词里都带「驱虎」，所以**必须按更具体的
       * 字样分辨**：先认「攻击范围内」那一个（赢了之后选谁挨打，min 为 1），
       * 再认拼点对手那一个。认反了会给 min 为 1 的请求交空数组。
       */
      if (request.prompt.includes('攻击范围内的一名角色')) {
        const ranked = [...request.candidateIds].sort((left, right) => targetScore(context, right) - targetScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, Math.max(request.min, 1)) } }
      }
      // 【天义】选拼点对手：手牌越少越可能拼赢，绝不挑自己人
      if (request.prompt.includes('【天义】')) {
        const ranked = [...request.candidateIds].sort((left, right) => tianyiTargetScore(context, right) - tianyiTargetScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, 1) } }
      }
      // 选拼点对手：优先敌人，而且优先手牌少的（拼点更可能赢）。
      // **不交空**：要不要发动已经在 skillActionScore 里判过了，这里再放弃会让
      // 「技能还能点」的状态原地打转
      if (request.prompt.includes('体力值多于你的角色拼点')) {
        const ranked = [...request.candidateIds].sort((left, right) => quhuTargetScore(context, right) - quhuTargetScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, 1) } }
      }
      // 【英魂】选目标：友军按「摸 X 弃 1」补牌，敌人按「摸 1 弃 X」拆牌，
      // 谁能拿到更大的净收益就选谁
      if (request.prompt.includes('【英魂】')) {
        const ranked = [...request.candidateIds].sort((left, right) => yinghunScore(context, right) - yinghunScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, 1) } }
      }
      // 【节命】补牌：先补自己，再补缺牌的自己人，绝不给敌人补一大把
      if (request.prompt.includes('节命')) {
        const ranked = [...request.candidateIds].sort((left, right) => jiemingScore(context, right) - jiemingScore(context, left))
        const best = ranked[0]
        return { ...base, payload: { targetIds: best && jiemingScore(context, best) > 0 ? [best] : [] } }
      }
      // 【空城计】：让敌人来猜——猜对了牌归他，所以宁可让最不该拿牌的人去赌
      if (request.prompt.includes('来猜')) {
        const ranked = [...request.candidateIds].sort((left, right) => targetScore(context, right) - targetScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, Math.max(request.min, 1)) } }
      }
      // 【麻麻】认亲：牌多、血厚、关系好的优先
      if (request.prompt.includes('成为你的')) {
        const ranked = [...request.candidateIds].sort((left, right) => pickMamaScore(context, right) - pickMamaScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, Math.max(request.min, 1)) } }
      }
      // 【麻麻】跟杀：优先残血敌人，绝不打自己人
      if (request.prompt.includes('跟杀')) {
        const ranked = [...request.candidateIds].sort((left, right) => mamaTargetScore(context, right) - mamaTargetScore(context, left))
        return { ...base, payload: { targetIds: ranked.slice(0, Math.max(request.min, 1)) } }
      }
      const isBeneficial = /回复|结姻|青囊/.test(request.prompt)
      const ranked = [...request.candidateIds].sort((left, right) => {
        if (!isBeneficial) return targetScore(context, right) - targetScore(context, left)
        const leftPlayer = context.view.players.find((player) => player.id === left)
        const rightPlayer = context.view.players.find((player) => player.id === right)
        const supportScore = (targetId: PlayerId, missingHp: number) => -hostility(context.view, context.suspicion, targetId) * 10 + missingHp * 3
        return supportScore(right, (rightPlayer?.maxHp ?? 0) - (rightPlayer?.hp ?? 0))
          - supportScore(left, (leftPlayer?.maxHp ?? 0) - (leftPlayer?.hp ?? 0))
      })
      // 能不打自己人就不打；但请求要求最少选几个的时候只能硬选
      const safe = isBeneficial
        ? ranked.filter((targetId) => hostility(context.view, context.suspicion, targetId) <= 0)
        : ranked.filter((targetId) => targetScore(context, targetId) > -Infinity)
      const pool = safe.length >= request.min ? safe : ranked
      const count = Math.min(Math.max(request.min, 1), request.max, pool.length)
      return { ...base, payload: { targetIds: pool.slice(0, count) } }
    }

    case 'choose-option': {
      // 代价类选择不能瞎选：血少的时候「失去体力」可能直接把自己送进濒死，
      // 有别的选项就不要碰它。其余选项仍然随机，避免 AI 行为过于死板。
      const me = myself(context.view)
      const options = request.options
      if (options.some((option) => option.id === 'fadai-invoke')) {
        const hasDodge = me.hand?.some((card) => card.name === '闪') ?? false
        // 没闪时发动只有收益；一血且有闪时保留确定的防御，避免赌失败后无法响应。
        const invoke = !hasDodge || me.hp > 1
        return { ...base, payload: { optionId: invoke ? 'fadai-invoke' : 'cancel' } }
      }
      if (options.some((option) => option.id === 'shuajian-attack')) {
        const challenger = context.view.players.find((player) => player.characterId === 'pingtoufangkuai' && player.alive)
        const isEnemy = challenger ? hostility(context.view, context.suspicion, challenger.id) > 0 : false
        const attack = isEnemy && (challenger!.hp <= 2 || context.difficulty !== 'easy')
        return { ...base, payload: { optionId: attack ? 'shuajian-attack' : 'shuajian-ignore' } }
      }
      // 天香的询问只会在确实有红桃手牌和合法转移目标时出现。
      // 转移伤害通常优于自己硬吃，目标选择分支会再按阵营倾向挑敌方。
      if (options.some((option) => option.id === 'tianxiang-invoke')) {
        return { ...base, payload: { optionId: 'tianxiang-invoke' } }
      }
      // ── 牛来【牛来】：继续追涨还是收手 ──
      if (options.some((option) => option.id === 'niulai-continue')) {
        return { ...base, payload: { optionId: decideNiulai(context, request.prompt) } }
      }
      // ── 牛来【麻麻】：要不要跟这一刀 ──
      if (options.some((option) => option.id === 'mama-follow' || option.id === 'mama-help')) {
        // 目标列表这时还没发给客户端，先按「所有活着的其他人」估个方向；
        // 真正挑目标在后面那个 choose-targets 里，那时候候选是准的
        const candidates = context.view.players
          .filter((player) => player.alive && player.id !== request.playerId)
          .map((player) => player.id)
        const optionIds = options.map((option) => option.id)
        return { ...base, payload: { optionId: decideMamaFollow(context, optionIds, candidates) ?? 'cancel' } }
      }
      // ── 无亮【夺位】：条件已经由引擎把关，这里只判断值不值 ──
      if (options.some((option) => option.id === 'duowei-invoke')) {
        return { ...base, payload: { optionId: shouldSeizeThrone(context) ? 'duowei-invoke' : 'cancel' } }
      }
      // ── 许老板【空城计】：猜随机那张是不是基本牌 ──
      if (options.some((option) => option.id === 'kongchengji-basic')) {
        return { ...base, payload: { optionId: guessKongchengji(context) } }
      }
      // ── 许老板【杠杆】：借几张 ──
      if (options.some((option) => option.id.startsWith('ganggan-borrow:'))) {
        return { ...base, payload: { optionId: decideGanggan(context) } }
      }
      // ── 许老板【空手套白狼】：只按公开手牌数和自身险情判断 ──
      if (options.some((option) => option.id === 'kongshou-invoke')) {
        return { ...base, payload: { optionId: decideKongshou(context) ? 'kongshou-invoke' : 'cancel' } }
      }
      // ── 于吉【蛊惑】：声明要用哪张牌 ──
      if (options.some((option) => option.id.startsWith('guhuo-name:'))) {
        return { ...base, payload: { optionId: declareGuhuo(context, options) } }
      }
      // ── 于吉【蛊惑】：要不要质疑 ──
      if (options.some((option) => option.id === 'guhuo-challenge-yes')) {
        return { ...base, payload: { optionId: decideChallenge(context, request.prompt) } }
      }
      // ── 奶蛙【齁笑】：被找上的人选一起笑还是绷住 ──
      if (options.some((option) => option.id === 'houxiao-together')) {
        return { ...base, payload: { optionId: decideHouxiaoAnswer(context, options) } }
      }
      // ── 奶蛙【齁笑】：猜对方剩下的牌里有没有同色 ──
      if (options.some((option) => option.id === 'houxiao-yes')) {
        return { ...base, payload: { optionId: guessSameColour(context) } }
      }
      // ── 奶蛙【捧腹】：要不要起哄 ──
      if (options.some((option) => option.id === 'pengfu-invoke')) {
        return { ...base, payload: { optionId: decidePengfu(context, request.prompt) ? 'pengfu-invoke' : 'cancel' } }
      }
      // ── 奶蛙【捧腹】：被起哄的人选继续还是算了 ──
      if (options.some((option) => option.id === 'pengfu-continue')) {
        return { ...base, payload: { optionId: decideContinue(context, options) } }
      }
      if (request.prompt.includes('雷击')) {
        // 雷击不花任何代价，判定成功就是 2 点雷电伤害——没有不发动的理由。
        // 打谁由后面的 choose-targets 分支按敌我倾向挑。
        return { ...base, payload: { optionId: 'yes' } }
      }
      if (request.prompt.includes('据守')) {
        return { ...base, payload: { optionId: decideJushou(context) ? 'yes' : 'no' } }
      }
      // 顺序要紧：选模式那一问的提示语里同样带「英魂」两个字，
      // 先按提示语匹配会把 yes/no 交给一个只收 yinghun-* 的请求。**先认 option id**。
      if (options.some((option) => option.id.startsWith('yinghun-'))) {
        return { ...base, payload: { optionId: chooseYinghunMode(context, options) } }
      }
      if (request.prompt.startsWith('发动【英魂】')) {
        return { ...base, payload: { optionId: shouldInvokeYinghun(context) ? 'yes' : 'no' } }
      }
      if (request.prompt.includes('烈刃')) {
        return { ...base, payload: { optionId: shouldInvokeLieren(context) ? 'yes' : 'no' } }
      }
      if (request.prompt.includes('再起')) {
        return { ...base, payload: { optionId: shouldZaiqi(me) ? 'yes' : 'no' } }
      }
      if (options.some((option) => option.id === 'shensu-judge')) {
        return { ...base, payload: { optionId: 'shensu-judge' } }
      }
      if (options.some((option) => option.id === 'shensu-play')) {
        // 装备代价已经由请求前置条件保证存在；标准/困难会积极换成一次无距离杀，
        // 简单难度保留少量放弃空间，避免所有难度行为完全一致。
        return { ...base, payload: { optionId: context.difficulty === 'easy' && context.rng.nextInt(3) === 0 ? 'no' : 'shensu-play' } }
      }
      const safe = me.hp <= 2 ? options.filter((option) => option.id !== 'hp' && option.id !== 'lose-hp') : options
      const pool = safe.length > 0 ? safe : options
      return { ...base, payload: { optionId: context.rng.pick(pool).id } }
    }

    case 'choose-suit':
      return { ...base, payload: { suit: context.rng.pick(request.suits) } }

    case 'choose-number':
      return { ...base, payload: { number: request.min } }

    case 'respond-card': {
      /*
       * 无亮【忍耐】要在「决定怎么响应」**之前**判断。
       *
       * 这个技能的字面意思就是「明明响应得了，偏不响应」；引擎也只在真的
       * 拿得出响应时才给这条入口。放到 preferPlay 后面等于永远轮不到——
       * 有闪就先出闪了。
       */
      if (request.actionIds.includes('rennai') && shouldEndure(context, request.requiredCardName)) {
        return { ...base, payload: { actionId: 'rennai' } }
      }
      // 该出闪就出闪、该出无懈看价值。出不起就放弃。
      const played = preferPlay(request.actionIds, 'respond-dodge:')
        ?? preferPlay(request.actionIds, 'respond-trick:')
        ?? (request.requiredCardName === '无懈可击' ? nullificationChoice(context, request.actionIds) : null)
        ?? (request.actionIds.includes('invoke-bagua') ? 'invoke-bagua' : null)
      // 有真牌时也偶尔选择真蛊惑，而不是永远走普通响应。随后选牌分支会确保
      // 扣下的确实是同名牌；简单难度仍保持更直接的打法。
      if (played && request.actionIds.includes('guhuo-respond')
        && context.difficulty !== 'easy' && context.rng.nextInt(5) === 0) {
        return { ...base, payload: { actionId: 'guhuo-respond' } }
      }
      if (played) return { ...base, payload: { actionId: played } }
      /*
       * 于吉【蛊惑】打出模式：手上真的没有这张牌时才诈一次。
       * 有真牌就走上面的 preferPlay，不必冒被质疑的风险。
       */
      if (request.actionIds.includes('guhuo-respond') && shouldGuhuoRespond(context, request.requiredCardName)) {
        return { ...base, payload: { actionId: 'guhuo-respond' } }
      }
      // 「本轮均不使用」只在**每个目标都不值得拦**时才用：
      // 一刀切会把后面该拦的目标一起放弃掉
      const passAll = request.actionIds.includes('respond-pass-round') && canDeclineWholeRound(context)
      return { ...base, payload: { actionId: passAll ? 'respond-pass-round' : 'respond-pass' } }
    }

    case 'use-card':
    case 'invoke-skill': {
      const playable = request.actionIds.filter((id) => id !== 'respond-pass')
      return { ...base, payload: { actionId: playable[0] ?? 'respond-pass' } }
    }

    case 'rescue': {
      // 濒死救援：自己一定救自己，别人看阵营
      const playable = request.actionIds.filter((id) => id !== 'rescue-pass' && id !== 'guhuo-respond')
      const savingSelf = request.dyingPlayerId === request.playerId
      // 敌意为负说明是自己人（尤其是主公），一定要救
      const worthSaving = savingSelf || hostility(context.view, context.suspicion, request.dyingPlayerId) <= 0
      if (!worthSaving) return { ...base, payload: { actionId: 'rescue-pass' } }
      if (playable.length > 0 && request.actionIds.includes('guhuo-respond')
        && context.difficulty !== 'easy' && context.rng.nextInt(6) === 0) {
        return { ...base, payload: { actionId: 'guhuo-respond' } }
      }
      if (playable.length > 0) return { ...base, payload: { actionId: playable[0] } }
      // 没有真桃，才轮到于吉【蛊惑】赌一把
      if (request.actionIds.includes('guhuo-respond') && shouldGuhuoRespond(context, '桃')) {
        return { ...base, payload: { actionId: 'guhuo-respond' } }
      }
      return { ...base, payload: { actionId: 'rescue-pass' } }
    }

    case 'arrange-cards': {
      // 观星类：价值高的留牌堆顶给自己，其余压底
      const ranked = [...request.cardIds].sort((left, right) => cardValue(cardName(context, right)) - cardValue(cardName(context, left)))
      const topCount = Math.min(Math.max(request.minTop, 0), request.maxTop, ranked.length)
      return { ...base, payload: { top: ranked.slice(0, topCount), bottom: request.allowBottom ? ranked.slice(topCount) : [] } }
    }

    case 'distribute-cards': {
      const count = Math.min(Math.max(request.min, 0), request.max, request.cardIds.length)
      const assignments = request.cardIds.slice(0, count).map((cardId, index) => ({
        cardId,
        recipientId: request.recipientIds[index % request.recipientIds.length],
      }))
      return { ...base, payload: { assignments } }
    }

    default:
      return assertNever(request)
  }
}

/**
 * AI 没有策略空间、只是在确认唯一结果的请求。
 * 这类步骤仍走同一套合法响应与校验，但表现层不必假装思考 1～2 秒。
 */
export function isTrivialAIRequest(request: GameRequest): boolean {
  switch (request.kind) {
    case 'respond-card':
      return request.actionIds.every((actionId) => actionId === 'respond-pass' || actionId === 'respond-pass-round')
    case 'rescue':
      return request.actionIds.every((actionId) => actionId === 'rescue-pass')
    case 'choose-option':
      return request.options.length <= 1
    case 'choose-targets':
      return request.candidateIds.length === request.min && request.min === request.max
    case 'choose-cards':
      return request.cardIds.length + request.hiddenCardSlots.length === 0 || request.max === 0
    case 'use-card':
    case 'invoke-skill':
      return request.actionIds.every((actionId) => actionId === 'respond-pass')
    default:
      return false
  }
}

/**
 * 无懈可击值不值得出。
 *
 * 判断标准是「这张锦囊会不会害到我这边」，而不是「谁放的」——
 * 保护主公比拦截敌人重要得多，所以目标是被保护对象时一定出。
 */
function nullificationChoice(context: AIContext, actionIds: readonly string[]): string | null {
  const playable = actionIds.filter((id) => id.startsWith('respond-nullification:'))
  if (playable.length === 0) return null
  const resolution = context.view.cardResolution
  if (!resolution) return null
  // 简单档不做这层判断，随手用
  if (context.difficulty === 'easy') return context.rng.nextInt(2) === 0 ? playable[0] : null

  // 看**当前**这个目标，不是 targetIds[0]：多目标锦囊逐个结算，
  // 万箭齐发打到第三个人时按第一个人的敌我关系判断是错的
  const targetId = resolution.currentTargetId ?? resolution.targetIds[0]
  if (!worthNullifying(context, targetId, resolution.sourceId)) return null
  // 看破可能把任意黑牌变成无懈；优先消耗低价值底牌，保留桃和防御牌。
  return [...playable].sort((left, right) => {
    const leftId = left.slice('respond-nullification:'.length)
    const rightId = right.slice('respond-nullification:'.length)
    return cardValue(cardName(context, leftId)) - cardValue(cardName(context, rightId))
  })[0]
}

/** 这张锦囊落在某个目标身上时，值不值得我拦。 */
function worthNullifying(context: AIContext, targetId: PlayerId, sourceId: PlayerId): boolean {
  const attitude = hostility(context.view, context.suspicion, targetId)
  // 目标是自己或需要保护的人 → 一定拦
  if (targetId === context.view.viewerId || attitude <= PROTECTED) return true
  // 目标是敌人 → 不拦，让它生效
  if (attitude > 0) return false
  // 说不准的情况下，看放牌的人是不是敌人
  return hostility(context.view, context.suspicion, sourceId) > 0
}

/**
 * 能不能直接答「本轮均不使用」。
 *
 * 只有**这张牌的每一个目标**都不值得拦时才行。否则会把后面某个
 * 「该拦的目标」一起放弃掉——那比多点几次糟糕得多。
 */
function canDeclineWholeRound(context: AIContext): boolean {
  const resolution = context.view.cardResolution
  if (!resolution) return false
  return resolution.targetIds.every((targetId) => !worthNullifying(context, targetId, resolution.sourceId))
}

/**
 * 判定「对被判定的角色是不是好结果」。
 *
 * 所有判定都满足同一条：**判定的发起者就是希望结果为 good 的那个人**。
 * 乐不思蜀判红桃＝跳过被免掉，闪电判非黑桃 2~9＝没劈到，八卦阵判红＝闪掉了，
 * 铁骑判红＝马超自己的杀更强，刚烈判非红桃＝夏侯惇反伤成立，洛神判黑＝甄姬继续摸。
 * 所以下面只写「对判定发起者是不是好事」，敌我关系在调用处一次性反转。
 */
const JUDGE_FAVOURABLE: Record<string, (suit: Suit, rank: number) => boolean> = {
  乐不思蜀: (suit) => suit === 'heart',
  兵粮寸断: (suit) => suit === 'club',
  闪电: (suit, rank) => !(suit === 'spade' && rank >= 2 && rank <= 9),
  八卦阵: (suit) => suit === 'heart' || suit === 'diamond',
  铁骑: (suit) => suit === 'heart' || suit === 'diamond',
  刚烈: (suit) => suit !== 'heart',
  洛神: (suit) => suit === 'spade' || suit === 'club',
  // 雷击的判定是张角发起的，黑桃对他是好结果
  雷击: (suit) => suit === 'spade',
}

/**
 * 改判（鬼才）的取舍。
 *
 * 默认是**不改**：改判要付一张手牌，乱改比不改更亏。
 * 只有「现在的结果和我希望的相反、而且我手里有能翻转它的牌」才出手。
 * 判不出好坏的理由（双雄这类无所谓红黑的）一律放弃。
 */
function decideRetrial(context: AIContext, request: ChooseCardsRequest): string[] {
  const info = request.retrial
  if (!info) return []
  const favourable = JUDGE_FAVOURABLE[info.reason]
  if (!favourable) return []

  const me = myself(context.view)
  // 判定发起者是自己人就希望 good，是对手就希望 bad
  const wantFavourable = info.judgingPlayerId === me.id
    || hostility(context.view, context.suspicion, info.judgingPlayerId) <= 0
  if (favourable(info.suit, info.rank) === wantFavourable) return []

  const candidates = new Set(request.cardIds)
  const replacement = (me.hand ?? [])
    .filter((card) => candidates.has(card.id) && favourable(card.suit, card.rank) === wantFavourable)
    // 换牌时优先丢价值低的：一样能翻盘就别拿桃去改判
    .sort((left, right) => cardValue(left.name) - cardValue(right.name))[0]
  return replacement ? [replacement.id] : []
}

/**
 * 【麻麻】跟杀该选麻麻的哪个目标。
 *
 * 敌人优先，残血敌人最优先（跟这一刀可能直接收掉）；自己人一律压到最低，
 * 实在只有自己人可选时也宁可不跟。
 */
function mamaTargetScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const attitude = hostility(context.view, context.suspicion, targetId)
  // 自己人：越关键越不能打
  if (attitude <= 0) return -100 + attitude
  // 敌人：血越少价值越高
  return 50 + attitude * 5 + (target.maxHp - target.hp) * 4 - target.hp * 3
}

/**
 * 认谁当【麻麻】。
 *
 * 只看**公开信息**：手牌数、体力、以及现有的敌我判断。不去读身份牌，
 * 也读不到——`hostility` 走的是和别处一样的那套怀疑度推断。
 *
 * 「使用【杀】频率高」在开局无从得知，用手牌数和体力代替：牌多血厚的人
 * 更可能一直在出杀，也更不容易早早退场，跟着他能跟到更多刀。
 * 关系好的加权最重——认了敌人当麻麻，跟杀时只能挑他打的自己人。
 */
function pickMamaScore(context: AIContext, candidateId: PlayerId): number {
  const candidate = context.view.players.find((player) => player.id === candidateId)
  if (!candidate?.alive) return -Infinity
  const attitude = hostility(context.view, context.suspicion, candidateId)
  return -attitude * 12 + candidate.handCount * 3 + candidate.hp * 4
}

/**
 * 要不要跟这一刀，跟的话用哪种方式。
 *
 * 返回 null 表示不跟。
 *
 * 有闲置的【杀】就直接跟上——那张牌本来这回合也未必用得掉。
 * 没有【杀】就得掂量「弃两张」的代价：能把人打残或打死才值，
 * 手牌本来就紧张时不做这种买卖。
 */
function decideMamaFollow(context: AIContext, actionIds: readonly string[], targetIds: readonly PlayerId[]): string | null {
  const best = [...targetIds].sort((left, right) => mamaTargetScore(context, right) - mamaTargetScore(context, left))[0]
  // 只剩自己人可打就不跟
  if (!best || mamaTargetScore(context, best) < 0) return null
  const target = context.view.players.find((player) => player.id === best)
  const me = myself(context.view)

  if (actionIds.includes('mama-follow')) return 'mama-follow'
  if (!actionIds.includes('mama-help')) return null

  // 弃两张牌是硬成本：对方残血、或者自己手牌宽裕时才做
  const lethal = (target?.hp ?? 9) <= 1
  if (lethal) return 'mama-help'
  return me.handCount >= 4 ? 'mama-help' : null
}

/**
 * 要不要用【蛊惑】硬打出一张牌。
 *
 * 只在**真的拿不出**那张牌时才考虑：有真牌就正常打，没必要冒被质疑的风险。
 * 越是救命的场合越值得赌（求桃、求闪），无懈那种锦标性质的就保守些。
 */
function shouldGuhuoRespond(context: AIContext, requiredCardName: string): boolean {
  const me = myself(context.view)
  if ((me.hand?.length ?? 0) === 0) return false
  // 命悬一线：桃和闪都得赌
  if (requiredCardName === '桃') return true
  if (requiredCardName === '闪') return me.hp <= 2 || context.rng.nextInt(2) === 0
  // 无懈这类不救命的，手牌宽裕时才诈
  return (me.hand?.length ?? 0) >= 3 && context.rng.nextInt(3) === 0
}

/**
 * 【驱虎】该找谁拼点。
 *
 * 借刀杀人的关键是**别让友军替我打友军**：自己人一律负分。敌人里优先手牌少的
 * ——拼点比的是点数，手牌越少能翻出大牌的机会越小；再优先攻击范围大的，
 * 赢了之后他能打到的人才多。
 */
function quhuTargetScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const attitude = hostility(context.view, context.suspicion, targetId)
  if (attitude <= 0) return -100 + attitude
  return 20 + attitude * 4 - target.handCount * 3 + target.attackRange * 2
}

/**
 * 【乱击】拿哪两张牌去换万箭。
 *
 * 先按花色分组，只看凑得齐两张的那些花色，再在每组里挑**价值最低的两张**，
 * 最后在各组之间比谁更便宜。绝不为了发动就把桃、无懈、闪丢出去。
 * 凑不出同花色时返回空数组，等于放弃。
 */
function chooseLuanjiCards(context: AIContext, cardIds: readonly string[]): string[] {
  const me = myself(context.view)
  const hand = new Map((me.hand ?? []).map((card) => [card.id, card]))
  const bySuit = new Map<string, string[]>()
  for (const cardId of cardIds) {
    const card = hand.get(cardId)
    if (!card) continue
    const group = bySuit.get(card.suit) ?? []
    group.push(cardId)
    bySuit.set(card.suit, group)
  }
  let best: { cards: string[]; cost: number } | null = null
  for (const group of bySuit.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((left, right) =>
      cardValue(hand.get(left)?.name ?? '') - cardValue(hand.get(right)?.name ?? ''))
    const pick = sorted.slice(0, 2)
    const cost = pick.reduce((sum, cardId) => sum + cardValue(hand.get(cardId)?.name ?? ''), 0)
    if (!best || cost < best.cost) best = { cards: pick, cost }
  }
  return best?.cards ?? []
}

/**
 * 【天义】该找谁拼点。
 *
 * 拼点比的是点数，手牌越少能翻出大牌的机会越小，所以优先手牌少的；
 * 自己人一律负分——拿友军拼点没有任何收益，输了还禁自己一回合的杀。
 */
function tianyiTargetScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const attitude = hostility(context.view, context.suspicion, targetId)
  if (attitude <= 0) return -100 + attitude
  return 20 + attitude * 3 - target.handCount * 4
}

/**
 * 【节命】补给谁。
 *
 * 自己缺牌优先，其次是缺牌的自己人（主公权重最高）。给敌人补一大把牌是纯资敌，
 * 一律负分。
 */
function jiemingScore(context: AIContext, targetId: PlayerId): number {
  const target = context.view.players.find((player) => player.id === targetId)
  if (!target?.alive) return -Infinity
  const gap = Math.max(0, Math.min(target.maxHp, 5) - target.handCount)
  if (gap <= 0) return -Infinity
  const attitude = hostility(context.view, context.suspicion, targetId)
  if (targetId === context.view.viewerId) return 40 + gap * 5
  // 敌人：补得越多越亏
  if (attitude > 0) return -50 - gap * 5
  const lordBonus = target.identity === 'lord' ? 15 : 0
  return 20 + gap * 4 + lordBonus - attitude * 5
}

/**
 * 拼点该出哪张牌。
 *
 * **公共的**：拼点的技能都调这一个，不要每个武将各写一套。`intent` 表达
 * 这次是想赢还是想故意输——目前所有消费者都想赢，但接口先留出来，
 * 免得将来有「输了才有收益」的技能时又去复制一份。
 */
export function choosePindianCard(
  context: AIContext,
  cardIds: readonly string[],
  intent: 'win' | 'lose' = 'win',
): string {
  const ranked = [...cardIds].sort((left, right) => {
    const leftCard = context.view.players.find((player) => player.id === context.view.viewerId)?.hand
      ?.find((card) => card.id === left)
    const rightCard = context.view.players.find((player) => player.id === context.view.viewerId)?.hand
      ?.find((card) => card.id === right)
    const leftRank = leftCard?.rank ?? 0
    const rightRank = rightCard?.rank ?? 0
    // 想赢就出大的，想输就出小的；同点数时先出不值钱的
    if (leftRank !== rightRank) return intent === 'win' ? rightRank - leftRank : leftRank - rightRank
    return cardValue(leftCard?.name ?? '') - cardValue(rightCard?.name ?? '')
  })
  return ranked[0] ?? cardIds[0]
}

/**
 * 要不要发动【忍耐】放弃这次响应。
 *
 * 忍的收益是一枚「忍」加主公一张牌，代价是实打实挨一下。所以先看**会不会死**：
 * 这一下可能要命时除非手上还有桃，否则一律正常响应——攒忍攒到把自己攒死是最蠢的。
 * 剩下的按血量和进度决定：越接近 4 枚越值得赌，血越薄越保守。
 */
function shouldEndure(context: AIContext, requiredCardName: string): boolean {
  const me = myself(context.view)
  const endured = me.marks?.rennai ?? 0
  // 已经满了就没有再挨打的理由
  if (endured >= 4) return false
  const peaches = (me.hand ?? []).filter((card) => card.name === '桃').length
  // 决斗要打出【杀】，不打可能连挨好几下；这里按最保守的一下算
  const lethal = me.hp - 1 <= 0
  if (lethal && peaches === 0) return false
  if (me.hp <= 2 && requiredCardName !== '无懈可击') {
    // 残血时只有临门一脚才值得
    return endured >= 3 && peaches > 0
  }
  // 无懈那种不挨伤害的场合代价最小，放开一点
  if (requiredCardName === '无懈可击') return true
  return endured >= 3 || me.hp >= 3
}

/**
 * 要不要夺位。
 *
 * 发动条件（4 枚忍、主公残血、限定技没用过）由引擎把关，这里只判断值不值。
 * 成为主公意味着变成全场靶子，所以血太薄时先忍一忍——但机会窗口很窄
 * （主公随时可能被治好或被打死），所以默认相当积极。
 */
function shouldSeizeThrone(context: AIContext): boolean {
  const me = myself(context.view)
  // 上去就被秒的局面不划算：等一个回合往往还在
  if (me.hp <= 1 && me.handCount <= 1) return false
  return true
}

/**
 * 猜「楼」里随机那张是不是基本牌。
 *
 * **看不到扣置的牌，也不去看。** 私有区根本不会下发到猜的人的视图里，
 * 这里只用公开信息数牌：一副牌里基本牌本来就过半，但已经打出去的基本牌越多，
 * 剩下的那些就越不可能是基本牌。数的是自己的手牌、弃牌堆、所有人的装备和判定区
 * ——都是台面上人人可见的东西，属于正常的记牌。
 */
function guessKongchengji(context: AIContext): string {
  const me = myself(context.view)
  const seen = [
    ...(me.hand ?? []),
    ...context.view.discardPile,
    ...context.view.players.flatMap((player) => [...player.equipment, ...player.judgingArea]),
  ]
  const basicSeen = seen.filter((card) => card.category === 'basic').length
  // 样本太小就用先验：标准牌堆里基本牌略多于一半
  const basicRatio = seen.length >= 12 ? 1 - basicSeen / seen.length : 0.55
  // 概率高就猜「有」，但保留一点随机，别变成永远同一个答案让人摸清规律
  const threshold = basicRatio > 0.5 ? 70 : 30
  return context.rng.nextInt(100) < threshold ? 'kongchengji-basic' : 'kongchengji-other'
}

/**
 * 【杠杆】还债时弃几张、弃哪几张。
 *
 * 一枚还不上的债就是一点体力，所以**血越少越要用牌抵**：残血时能抵多少抵多少，
 * 血厚时才愿意留牌硬扛。抵债一律先出手上最不值钱的牌。
 */
function repayGanggan(context: AIContext, cardIds: readonly string[], max: number): string[] {
  const cheapest = [...cardIds].sort((left, right) => cardValue(cardName(context, left)) - cardValue(cardName(context, right)))
  // 新版债务在牌足够时必须还清，没有“留牌硬扛”的合法选项。
  return cheapest.slice(0, max)
}

/**
 * 【杠杆】借几张。
 *
 * 借的是下一摸牌阶段结束后的偿还能力，所以看当前资源、体力和已有债。
 * **不偷看牌堆**——借多少只由自己的公开视图决定。
 */
function decideGanggan(context: AIContext): string {
  const me = myself(context.view)
  const existing = me.marks?.debt ?? 0
  if (me.hp <= 1) return 'ganggan-borrow:1'
  if (existing >= 3) return 'ganggan-borrow:1'
  if (me.handCount <= 1) return `ganggan-borrow:${me.hp >= 3 ? 3 : 2}`
  if (me.handCount <= 3) return 'ganggan-borrow:2'
  return 'ganggan-borrow:1'
}

/**
 * 【空手套白狼】只看每名角色公开的手牌数量，绝不读取其具体手牌。
 * 可取牌的人越多越愿意发动；残血时空手的危险更高，稍微提高意愿。
 */
function decideKongshou(context: AIContext): boolean {
  const me = myself(context.view)
  const targets = context.view.players.filter((player) => player.alive && player.id !== me.id && player.handCount > 0).length
  if (targets <= 0 || me.handCount > 0) return false
  const base = targets >= 3 ? 85 : targets === 2 ? 55 : 20
  const danger = me.hp <= 1 ? 15 : me.hp === 2 ? 8 : 0
  return context.rng.nextInt(100) < Math.min(95, base + danger)
}

/**
 * 牛来要不要继续追涨。
 *
 * 只用**公开信息**：当前点数和已经拿到几张。**不偷看牌堆顶**——
 * 服务端知道下一张是什么，AI 不能因此做出必然正确的选择。
 *
 * 下一张不下降的概率大致是 `(15 - rank) / 13`：当前点数越低越敢继续。
 * 拿得越多越怕亏，所以每多一张就往收手偏一点——这正是这个技能想要的手感。
 */
function decideNiulai(context: AIContext, prompt: string): string {
  const rank = Number(/当前点数 (\d+)/.exec(prompt)?.[1] ?? 14)
  const gained = Number(/已拿 (\d+) 张/.exec(prompt)?.[1] ?? 1)
  // 点数越低，不下降的空间越大。A(14) 时只有再来一张 A 才能续上
  const safety = Math.max(0, Math.min(100, Math.round(((15 - rank) / 13) * 100)))
  // 已经赚了就见好就收：每多一张扣 18 点意愿
  const greed = safety - (gained - 1) * 18
  return context.rng.nextInt(100) < greed ? 'niulai-continue' : 'niulai-stop'
}

/**
 * 于吉声明哪张牌。
 *
 * 优先**真声明**：手上确实有这张牌时声明它，被质疑反而白赚一次惩罚。
 * 真声明用不出来才考虑诈——而且只挑「用出来确实有价值」的牌，
 * 不会把每张垃圾牌都随口说成桃。
 */
function declareGuhuo(context: AIContext, options: readonly { id: string }[]): string {
  const names = options
    .filter((option) => option.id.startsWith('guhuo-name:'))
    .map((option) => option.id.slice('guhuo-name:'.length))
  const me = myself(context.view)
  const hand = me.hand ?? []

  /*
   * 扣置的那张牌是刚才自己选的，但请求里没告诉 AI 是哪张。
   * 用「手上还有没有同名牌」近似判断真声明：手里有两张杀时声明杀，
   * 扣的那张有很大概率就是杀。近似猜错的代价只是被质疑，可以接受。
   */
  const truthful = names.filter((name) => hand.some((card) => card.name === name))
  if (truthful.length > 0) {
    return `guhuo-name:${truthful.sort((left, right) => cardValue(right) - cardValue(left))[0]}`
  }

  // 诈：只挑价值高、能立刻产生作用的牌，而且不是每次都诈
  const bluffable = names.filter((name) => ['杀', '桃', '无中生有', '过河拆桥', '决斗'].includes(name))
  const pick = bluffable.length > 0 && context.rng.nextInt(3) > 0
    ? bluffable.sort((left, right) => cardValue(right) - cardValue(left))[0]
    : names[context.rng.nextInt(names.length)]
  return `guhuo-name:${pick}`
}

/**
 * 要不要质疑于吉。
 *
 * 不能 50% 随机。综合几件公开的事：敌我关系、声明牌的价值、于吉的手牌数、
 * 以及**质疑失败要失去一点体力**——一血的时候基本不该赌。
 */
function decideChallenge(context: AIContext, prompt: string): string {
  const yes = 'guhuo-challenge-yes'
  const no = 'guhuo-challenge-no'
  const me = myself(context.view)
  // 质疑失败会失去一点体力，一血时直接进濒死，除非局势已经很糟否则不赌
  if (me.hp <= 1) return no

  const yuji = context.view.players.find((player) => player.alive && prompt.includes(player.nickname))
  // 自己人放的蛊惑没有质疑的道理
  if (yuji && hostility(context.view, context.suspicion, yuji.id) <= 0) return no

  const declared = /声明【(.+?)】/.exec(prompt)?.[1] ?? ''
  // 声明越关键越值得拆穿：桃和无懈直接改变局势
  let chance = 25
  if (declared === '桃' || declared === '无懈可击') chance += 30
  else if (declared === '杀' || declared === '决斗') chance += 10
  // 手牌越多越可能真有那张牌，诈的概率反而低
  const handCount = yuji?.handCount ?? 0
  if (handCount >= 4) chance -= 15
  else if (handCount <= 1) chance += 15
  // 血厚的时候赌得起
  if (me.hp >= 4) chance += 10

  return context.rng.nextInt(100) < Math.max(5, Math.min(80, chance)) ? yes : no
}

/**
 * 面对【齁笑】选一起笑还是绷住。
 *
 * 一起笑是「双方各摸一张再随机换一张」：手牌少的时候净赚，
 * 手里全是桃和无懈时不想赌。绷住是「展示一张让奶蛙猜」：
 * 手牌越多，奶蛙越容易猜中「有同色」，所以牌多时反而该一起笑。
 */
function decideHouxiaoAnswer(context: AIContext, options: readonly { id: string }[]): string {
  const canHold = options.some((option) => option.id === 'houxiao-hold')
  // 只有一张手牌时引擎根本不给绷住这个选项
  if (!canHold) return 'houxiao-together'
  const me = myself(context.view)
  const hand = me.hand ?? []
  const precious = hand.filter((card) => cardValue(card.name) >= 8).length
  // 手里有两张以上关键牌：不赌随机交换
  if (precious >= 2) return 'houxiao-hold'
  // 手牌多的时候「有同色」几乎必中，绷住等于白送奶蛙两张
  if (hand.length >= 4) return 'houxiao-together'
  return context.rng.nextInt(2) === 0 ? 'houxiao-together' : 'houxiao-hold'
}

/**
 * 奶蛙猜对方其余手牌里有没有同色牌。
 *
 * **只能用公开信息**：请求里根本没有对方的其余手牌，这里也不去翻 view
 * 里别人的 hand（那本来就是 null）。用手牌数做概率估计——
 * 剩的牌越多，「至少有一张同色」的概率越高，剩一张时接近一半。
 */
function guessSameColour(context: AIContext): string {
  const resolution = context.view.cardResolution
  void resolution
  // 展示牌之外还剩几张，只能从公开的手牌数推
  const others = context.view.players.filter((player) => player.alive && player.id !== context.view.viewerId)
  // 请求里没带目标是谁，取场上手牌最多的那个做估计已经够用；
  // 猜错的代价只是对方摸一张，不值得为此引入更多耦合
  const remaining = Math.max(0, Math.max(...others.map((player) => player.handCount), 1) - 1)
  // p(至少一张同色) ≈ 1 - (1/2)^remaining，用整数概率近似即可
  const chance = remaining <= 0 ? 50 : Math.min(90, 100 - Math.round(100 / (2 ** remaining)))
  return context.rng.nextInt(100) < chance ? 'houxiao-yes' : 'houxiao-no'
}

/** 要不要发动【捧腹】。自己手牌够多、或者对象是自己人时收着点。 */
function decidePengfu(context: AIContext, prompt: string): boolean {
  const me = myself(context.view)
  // 提示里带着目标昵称，用它找出是谁在被起哄
  const target = context.view.players.find((player) => player.alive && prompt.includes(player.nickname))
  const friendly = target ? hostility(context.view, context.suspicion, target.id) <= 0 : false
  // 帮自己人白摸一张也不算亏，但没有敌意时不必每次都起哄
  if (friendly) return context.rng.nextInt(3) === 0
  // 手牌已经很多时收益边际递减
  return me.handCount <= 6
}

/** 面对【捧腹】选继续还是算了。 */
function decideContinue(context: AIContext, options: readonly { id: string }[]): string {
  // 没牌可弃时引擎不给「算了」，只能继续
  if (!options.some((option) => option.id === 'pengfu-stop')) return 'pengfu-continue'
  const me = myself(context.view)
  const hand = me.hand ?? []
  // 继续要求本阶段还能再打出一张牌。手上还有杀、桃、酒、锦囊、装备就有底气；
  // 只剩闪和无懈这种纯响应牌时，继续多半会失败，反而要多弃一张
  const playable = hand.filter((card) => card.name !== '闪' && card.name !== '无懈可击').length
  // 摸的那一张也可能是能用的牌，所以门槛放在 1
  return playable >= 1 ? 'pengfu-continue' : 'pengfu-stop'
}

/**
 * 曹仁【据守】的取舍。
 *
 * 据守是「拿下一个回合换三张牌」，所以不能每回合无脑发动——那样曹仁永远在翻面，
 * 一个回合都不出。判断的是「这三张牌现在值不值一个回合」：
 * 手牌越少越值，快死了越值（多三张牌意味着多三次响应机会），
 * 手上已经很宽裕、或者血线安全时就把回合留着打人。
 */
function decideJushou(context: AIContext): boolean {
  const me = myself(context.view)
  const handCount = me.hand?.length ?? 0
  // 手里已经没什么牌：一个回合本来也打不出什么，换三张牌是纯赚
  if (handCount <= 2) return true
  // 血线危险：牌越多越活得下去，回合反而是次要的
  if (me.hp <= 2 && handCount <= 4) return true
  // 手牌宽裕又不缺血，就别把回合让出去
  return false
}

function cardName(context: AIContext, cardId: string): string {
  const me = myself(context.view)
  const found = me.hand?.find((card) => card.id === cardId)
    ?? context.view.requestCards.find((card) => card.id === cardId)
  return found?.name ?? ''
}
