import { killPlayer } from '../../engine/damage'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import type { ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { effectiveCardSuit } from '../../engine/skills/runtime'
import type { CharacterDefinition } from './types'
import { skillIdsOf } from './standard'

/**
 * 神关羽。经典「神话再临·神」版本。
 *
 * - **武神**：锁定技，你的红桃手牌均视为【杀】；你使用红桃【杀】无距离限制。
 * - **武魂**：锁定技，当你受到 1 点伤害后，伤害来源获得 1 枚「梦魇」标记；
 *   你死亡时，从拥有「梦魇」标记最多的**其他角色**中选择一名进行判定，
 *   若判定结果不为【桃】或【桃园结义】，该角色死亡。
 *
 * **不是 OL 重做版**：经典武神没有「无次数限制」，也没有「不可被抵消」。
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
        // 并列最多时由神关羽指定；他已经死了，但这是他的技能，仍然由他的座位决定
        host.askSkill({
          skillId: WUHUN, ownerId, step: 'pick',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【武魂】：选择一名「梦魇」最多的角色进行判定',
            timeoutMs: 20_000, optional: false,
            candidateIds: tied.map((player) => player.id), min: 1, max: 1,
          }),
        })
      },
    },
  ],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick') return
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds ?? []
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    beginWuhunJudgment(host, ownerId, targetId)
  },
})

function beginWuhunJudgment(host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['resume']>>[0], ownerId: PlayerId, targetId: PlayerId): void {
  performJudgment(host as never, targetId, '武魂', { tag: WUHUN_TAG, data: { ownerId, targetId } })
}

export const SHENGUANYU: CharacterDefinition = {
  id: 'shenguanyu',
  name: '神关羽',
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
