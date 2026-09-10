import { drawCards } from '../../engine/draw'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { livingKingdomCount } from '../../engine/living-kingdoms'
import { skipPhase } from '../../engine/turn'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 刘表（一将成名 2012）。
 *
 * 【自守】：摸牌阶段，你可以额外摸 X 张牌（X 为存活势力数），然后跳过你的出牌阶段。
 * 【宗室】：锁定技，你的手牌上限 +X（X 为存活势力数）。
 *
 * 六处最容易做错的：
 *
 * 1. **两个技能共用同一个 X**：走公共的 `livingKingdomCount`
 *    （廖化【伏枥】读的也是它）。各写一套的话，同一个人身上的两个技能
 *    会算出不同的 X，这是荒谬的。
 * 2. **X 实时算，不缓存**。有人阵亡就当场变——宗室的手牌上限会跟着变，
 *    自守下一次也按新的数。
 * 3. **是「额外摸 X 张」不是「改为摸 X 张」**：正常摸 2、X 为 4 时摸 6 张。
 * 4. **只跳过出牌阶段**，判定、弃牌、结束阶段照跑。
 * 5. **跳的是阶段位**：走公共的 `skipPhase`，兵粮寸断、好施读的是同一份
 *    `skippedPhases`。写成「出牌阶段直接 pass」是假跳过。
 * 6. **摸牌阶段被跳过时自守不触发**：那时 `DrawPhase` 根本不会派发，
 *    所以这一条不需要额外判断，也**不能**挂到别的时机上。
 */

export const ZISHOU = 'zishou'
export const ZONGSHI = 'zongshi'
const ZISHOU_INVOKE = 'zishou-invoke'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 自守 ───────────────────────────────

registerSkillRuntime({
  id: ZISHOU,
  announcesSelf: true,

  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      /*
       * 走公共的摸牌阶段接管入口：它负责比对 `playerId`、让位给已经在
       * 等回应的技能、并取消默认摸牌。**接管之后这条分支必须把牌补上**，
       * 无论玩家发不发动——只取消不补，他这一阶段白白少摸两张。
       */
      if (!takeOverDrawPhase(host, ownerId, context)) return
      const payload = context.event.payload as { count?: number }
      // 「最终应摸数量」以事件上的值为准：别的技能可能已经改过它
      const base = Math.max(0, Math.trunc(Number(payload.count ?? 2)))
      const extra = livingKingdomCount(host.state)
      host.askSkill({
        skillId: ZISHOU, ownerId, step: 'ask', data: { base },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `发动【自守】？额外摸 ${extra} 张牌（共 ${base + extra} 张），然后跳过你的出牌阶段`,
          timeoutMs: 20_000,
          /*
           * **必答**：接管已经发生，默认摸牌被取消了。
           * 做成可取消会让「没人回答」变成「一张都没摸」。
           */
          optional: false,
          options: [
            { id: ZISHOU_INVOKE, label: `发动【自守】：额外摸 ${extra} 张，跳过出牌阶段` },
            { id: 'cancel', label: `不发动，正常摸 ${base} 张` },
          ],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const base = Math.max(0, Math.trunc(Number(resolution.data.base ?? 2)))
    const invoked = (response.payload as { optionId?: string }).optionId === ZISHOU_INVOKE

    if (!invoked) {
      // 不发动：把接管时取消掉的那几张原样补回来
      if (base > 0) drawCards(host.state, host.rng, ownerId, base, (name, payload) => { host.dispatch(name, payload) })
      return
    }

    /*
     * X 在**发动的这一刻**重新数一遍，不用发问时算的那个值：
     * 窗口挂起期间可能有人阵亡（连锁伤害），那时现存势力已经变了。
     */
    const extra = livingKingdomCount(host.state)
    host.dispatch('SkillActivated', {
      skillId: ZISHOU, skillName: '自守', playerId: ownerId,
      logText: `${owner.nickname}发动【自守】，额外摸 ${extra} 张牌并跳过出牌阶段`,
    }, { sourceId: ownerId })
    const total = base + extra
    if (total > 0) drawCards(host.state, host.rng, ownerId, total, (name, payload) => { host.dispatch(name, payload) })
    /*
     * **真正的跳过**：走公共的 `skippedPhases`，不是「出牌阶段直接 pass」。
     * 跳的是**出牌阶段位**——廖化【当先】给的额外出牌阶段在准备阶段之前
     * 就跑完了，那时自守还没发生，所以不受影响。
     */
    skipPhase(host.state, 'play')
  },
})

// ─────────────────────────────── 宗室 ───────────────────────────────

registerSkillRuntime({
  id: ZONGSHI,
  /**
   * 锁定技：手牌上限 +X。
   *
   * 走公共的 `maxCardsBonus`（袁绍【血裔】走的也是这一条），
   * 所以弃牌阶段和 AI 读的是同一个数，而且**每次都现算**——
   * 有人阵亡导致势力数变化时，上限当场跟着变。
   */
  maxCardsBonus(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return 0
    return livingKingdomCount(state)
  },
})

export const LIUBIAO: CharacterDefinition = {
  id: 'liubiao',
  name: '刘表',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'yjcm2012',
  skills: [
    {
      id: ZISHOU,
      name: '自守',
      description: '摸牌阶段，你可以额外摸X张牌（X为存活势力数），然后跳过你的出牌阶段。',
    },
    {
      id: ZONGSHI,
      name: '宗室',
      description: '锁定技，你的手牌上限+X（X为存活势力数）。',
    },
  ],
}
