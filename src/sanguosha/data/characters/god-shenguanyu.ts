import { killPlayer } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import type { CharacterDefinition } from './types'
import { skillIdsOf } from './standard'

/**
 * 神关羽。本项目自研表述。
 *
 * - **武神**：锁定技，你的红桃手牌均视为【杀】；你使用红桃【杀】无距离限制。
 * - **武魂**：锁定技，当你受到 1 点伤害后，伤害来源获得 1 枚「梦魇」标记；
 *   你死亡时，从拥有「梦魇」标记最多的**其他角色**中选择一名进行判定，
 *   若判定结果不为【桃】或【桃园结义】，该角色死亡。
 *
 * 本项目的表述里没有「无次数限制」，也没有「不可被抵消」。
 */

export const WUSHEN = 'wushen'
export const WUHUN = 'wuhun'

/** 「梦魇」标记。放在公共的 `player.marks` 里，UI、重连、联机同步全部自然生效。 */
export const NIGHTMARE_MARK = 'nightmare'

const WUHUN_TAG = 'wuhun'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 神关羽手上的红桃牌。按**有效花色**算，红颜之类的花色修正一并生效。 */
function heartHandCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  // 只认手牌：装备区、判定区、武将专属牌堆里的红桃都不适用
  return owner.zones.hand.filter((cardId) => effectiveCardSuit(state, ownerId, cardId, skillIdsOf) === 'heart')
}

registerSkillRuntime({
  id: WUSHEN,

  /**
   * 红桃手牌视为【杀】。
   *
   * 走公共 `viewAs`，于是目标合法性、出杀次数、求闪、无双、肉林、铁索传导、
   * AI、联机全都复用同一条管线，这里只报告「这张牌可以当杀用」。
   *
   * **这是「可以当杀使用」，不是永久改名**：一张红桃【桃】在需要桃的时候
   * 仍然首先是一张桃，引擎给的是两条并列的动作，玩家自己选用途。
   */
  viewAs(state, ownerId): ViewAsOption[] {
    return heartHandCards(state, ownerId).map((cardId) => ({
      asCardName: '杀',
      cardId,
      label: `武神：将${state.cards[cardId]?.name ?? ''}当【杀】使用`,
    }))
  },

  /**
   * 红桃【杀】无距离限制。
   *
   * **只对红桃载体生效**：手上一张真的黑桃【杀】仍然要讲距离，
   * 所以必须看具体是哪张牌，不能按「这个人有武神」一刀切。
   * 其余合法性（存活、非自己、目标禁止、享乐、八阵）照常在结算里跑。
   */
  slashIgnoresDistance(state, ownerId, cardId) {
    if (!cardId) return false
    return heartHandCards(state, ownerId).includes(cardId)
  },
})

/**
 * 武魂的判定续接。
 *
 * 判定结果不为【桃】**或【桃园结义】**时该角色死亡——
 * 死亡走统一的死亡管线，**不是**伪造一次伤害。
 */
registerJudgmentContinuation(WUHUN_TAG, (host, judged, data) => {
  const targetId = data.targetId as PlayerId
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  if (judged.name === '桃' || judged.name === '桃园结义') return
  host.dispatch('SkillActivated', {
    skillId: WUHUN, skillName: '武魂', playerId: data.ownerId as PlayerId, targetIds: [targetId],
    logText: `【武魂】${target.nickname}的判定不为【桃】或【桃园结义】，被梦魇夺去性命`,
  }, { targetId })
  // 直接死亡：不伪造伤害、不走濒死求桃，但仍然经过统一死亡管线
  killPlayer(host as never, targetId, (data.ownerId as PlayerId) ?? null, '武魂')
})

registerSkillRuntime({
  id: WUHUN,

  triggers: [
    {
      /**
       * 每受到 1 点伤害，来源得 1 枚梦魇。
       *
       * **按点数累计**：一次受到 2 点伤害就给 2 枚，不是一次伤害给 1 枚。
       * 来源为空（闪电、崩坏、自己失去体力）时不给。
       */
      event: 'Damaged',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { amount?: number }
        // 伤害事件的**目标在 event.targetId**，payload 里只有数值和牌信息
        if (context.event.targetId !== ownerId) return
        // 来源取的是**当前伤害来源**（已经过祸首这类来源改写的最终结果）
        const sourceId = context.event.sourceId
        if (!sourceId || sourceId === ownerId) return
        const source = playerOf(host.state, sourceId)
        if (!source?.alive) return
        const amount = Math.max(1, Math.trunc(Number(payload.amount ?? 1)))
        source.marks[NIGHTMARE_MARK] = (source.marks[NIGHTMARE_MARK] ?? 0) + amount
        host.dispatch('SkillActivated', {
          skillId: WUHUN, skillName: '武魂', playerId: ownerId, targetIds: [sourceId],
          logText: `【武魂】${source.nickname}获得 ${amount} 枚「梦魇」`,
        }, { sourceId: ownerId, targetId: sourceId })
      },
    },
    {
      /**
       * 死亡时的惩罚结算。
       *
       * 挂在 `Death` 上而**不是**濒死：武魂不是濒死技，必须等神关羽
       * 真正死亡确认之后才结算。`allowDeadOwner` 让已经阵亡的拥有者
       * 仍然能跑完这条遗言。
       */
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        /*
         * **默认就地结算，只有外层还有结算在跑时才排队。**
         *
         * 就地结算是正确的顺序：`Death` 之后紧接着就是胜负判定，
         * 武魂夺走的那条命必须算进这次判定里，排队会排到胜负判定之后。
         *
         * 但神关羽可能死在一次仍在进行中的结算里——压测 seed=soak-8-423 是闪电：
         * 闪电把 `state.judgment` 占成「等待造成伤害」当作书签，伤害打死了神关羽，
         * 武魂当场又开一个判定把这个书签冲掉，闪电再也收不了尾，判定阶段原地打转。
         * `state.judgment` 只有一个槽位，判定不能嵌套。
         *
         * 所以只在「外层确实有东西在跑」时让路。这种情况下胜负判定可能先一步结束牌局、
         * 武魂来不及结算，这是本实现相对规则文本的一处取舍——比整局卡死好。
         */
        // 只有判定槽位被占着才需要让路：`state.judgment` / `state.retrial` 都只有一份，
        // 判定不能嵌套。伤害链、濒死不占这个槽位，不影响武魂开判定。
        if (host.state.judgment || host.state.retrial) {
          host.queueSkill({ skillId: WUHUN, ownerId, step: 'settle', data: {} })
          return
        }
        settleWuhun(host, ownerId)
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'settle') return
    settleWuhun(host, ownerId)
  },
})

/** 武魂的死亡结算。排队之后才跑，见上面 Death 触发器里的说明。 */
function settleWuhun(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
): void {
  // 候选是**其他角色**里梦魇最多的那些，神关羽自己不在内
  const candidates = host.state.players.filter((player) => (
    player.alive && player.id !== ownerId && (player.marks[NIGHTMARE_MARK] ?? 0) > 0
  ))
  if (candidates.length === 0) return
  const most = Math.max(...candidates.map((player) => player.marks[NIGHTMARE_MARK] ?? 0))
  const tied = candidates.filter((player) => (player.marks[NIGHTMARE_MARK] ?? 0) === most)
  if (tied.length === 1) {
    beginWuhunJudgment(host, ownerId, tied[0].id)
    return
  }
  /*
   * 并列最多。
   *
   * 规则上由神关羽指定，但**他这时已经死了**，而引擎的不变量禁止把
   * Request 发给已阵亡的玩家（`invariants.ts` 的「Request 响应玩家非法」，
   * 压测 seed=soak-8-71 抓到）。所以这里按**从神关羽座位起顺时针**
   * 取第一个作为确定性结果——可序列化、可复现，不会因为死人无法作答
   * 而把整局卡住。这是本实现相对规则文本的一处明确取舍，已记在 ruleset。
   */
  const owner = playerOf(host.state, ownerId)
  const ordered = [...tied].sort((left, right) => {
    const base = owner?.seat ?? 0
    const total = host.state.players.length
    return ((left.seat - base + total) % total) - ((right.seat - base + total) % total)
  })
  beginWuhunJudgment(host, ownerId, ordered[0].id)
}

function beginWuhunJudgment(host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['resume']>>[0], ownerId: PlayerId, targetId: PlayerId): void {
  performJudgment(host as never, targetId, '武魂', { tag: WUHUN_TAG, data: { ownerId, targetId } })
}

export const SHENGUANYU: CharacterDefinition = {
  id: 'shenguanyu',
  name: '神·关羽',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 5,
  pack: 'god',
  skills: [
    {
      id: WUSHEN,
      name: '武神',
      description: '锁定技。你的红桃手牌均视为【杀】；你使用红桃【杀】无距离限制。',
    },
    {
      id: WUHUN,
      name: '武魂',
      description: '锁定技。当你受到1点伤害后，伤害来源获得1枚「梦魇」标记；你死亡时，令拥有「梦魇」标记最多的一名其他角色进行判定，若结果不为【桃】或【桃园结义】，该角色死亡。',
    },
  ],
}
