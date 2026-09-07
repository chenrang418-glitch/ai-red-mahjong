import { drawCards } from '../../engine/draw'
import { takeOverDrawPhase } from '../../engine/draw-phase-takeover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹彰（一将成名 2012 经典）。
 *
 * 【将驰】：摸牌阶段，你可以选择一项：额外摸一张牌，然后本回合你不能使用或打出【杀】；
 *          或少摸一张牌，然后本回合你使用【杀】无距离限制且可以多使用一张【杀】。
 *
 * 五处最容易做错的：
 *
 * 1. **「基础摸牌数」是别的修正都算完之后的那个数。** 将驰在它上面 +1 / -1，
 *    不是把摸牌数写死成 3 或 1——那样别的摸牌修正就被它吞掉了。
 * 2. **禁的是「使用**或**打出」两件事。** 只堵使用的话，他照样能打出【杀】
 *    响应南蛮和决斗。判断读的是**有效牌名**，转化出来的【杀】一样堵住。
 * 3. **弃置、被拆、交给别人、当技能代价都不受影响**：那些不是使用或打出。
 * 4. **次数 +1 是加成不是覆盖**：走公共的本回合杀规则，
 *    和诸葛连弩、咆哮、陷阵的定向豁免按统一规则聚合。
 * 5. **摸牌阶段被跳过时不触发**：阶段都不存在，谈不上多摸少摸。
 */

const JIANGCHI = 'jiangchi'

/** 将驰的「多摸」分支在哪一个回合生效。存回合序号，回合一换自然过期。 */
const JIANGCHI_NO_SLASH = 'jiangchi-no-slash'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 这一回合他是不是选了「多摸一张」，因此不能使用或打出【杀】。 */
function slashLocked(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return false
  return owner.marks[JIANGCHI_NO_SLASH] === state.turnNumber
}

registerSkillRuntime({
  id: JIANGCHI,
  announcesSelf: true,

  triggers: [{
    event: 'DrawPhase',
    handle(host, ownerId, context) {
      /*
       * **先把当前的基础摸牌数读下来再接管。**
       *
       * 这条事件上别的技能可能已经改过 `count`（许老板【杠杆】还债那类），
       * 将驰要在**那个结果**上 +1 / -1。直接写 3 / 1 等于把别人的修正吞掉。
       */
      const payload = context.event.payload as { count?: unknown }
      const base = Math.max(0, Math.trunc(Number(payload.count ?? 2)))
      if (!takeOverDrawPhase(host, ownerId, context)) return
      const owner = playerOf(host.state, ownerId)
      const options = [
        { id: 'more', label: `额外摸一张（摸 ${base + 1} 张），本回合不能使用或打出【杀】` },
        // 摸牌数不能是负数：基础已经是 0 时「少摸一张」没有意义，不提供
        ...(base >= 1
          ? [{ id: 'less', label: `少摸一张（摸 ${base - 1} 张），本回合【杀】无距离限制且可多使用一张` }]
          : []),
        { id: 'none', label: `不发动（摸 ${base} 张）` },
      ]
      host.askSkill({
        skillId: JIANGCHI, ownerId, step: 'choose', data: { base },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【将驰】：${owner?.nickname ?? ''}的摸牌阶段，选择一项`,
          timeoutMs: 25_000,
          // 「不发动」本来就是一项，所以这里不是可选请求——必须给个答复
          optional: false,
          options,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const base = Math.max(0, Math.trunc(Number(resolution.data.base ?? 2)))
    const optionId = (response.payload as { optionId?: string }).optionId
    const owner = playerOf(host.state, ownerId)

    let count = base
    if (optionId === 'more') {
      count = base + 1
      if (owner) owner.marks[JIANGCHI_NO_SLASH] = host.state.turnNumber
      host.dispatch('SkillActivated', {
        skillId: JIANGCHI, skillName: '将驰', playerId: ownerId,
        logText: `${owner?.nickname ?? ''}发动【将驰】，额外摸一张牌，本回合不能使用或打出【杀】`,
      }, { sourceId: ownerId })
    } else if (optionId === 'less' && base >= 1) {
      count = base - 1
      /*
       * 走公共的本回合杀规则：**加成而不是覆盖**。
       * 诸葛连弩的「无限」不会被这一次 +1 压回成两次。
       */
      grantTurnSlashBonus(host.state, ownerId, { extraUses: 1, ignoreDistance: true })
      host.dispatch('SkillActivated', {
        skillId: JIANGCHI, skillName: '将驰', playerId: ownerId,
        logText: `${owner?.nickname ?? ''}发动【将驰】，少摸一张牌，本回合【杀】无距离限制且可多使用一张`,
      }, { sourceId: ownerId })
    }
    /*
     * 接管了摸牌阶段就得把牌补上——**不发动也要摸**。
     * 只取消不补的话，他这一阶段一张都摸不到。
     */
    if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
  },

  /*
   * 「不能使用【杀】」。这条钩子问的是「谁想用什么牌」，
   * 所以要自己确认想用牌的就是拥有者本人——它同样会被别人的使用问到。
   */
  prohibitsCardUse(state, ownerId, context) {
    return context.userId === ownerId && context.cardName === '杀' && slashLocked(state, ownerId)
  },

  /** 「不能打出【杀】」。只堵使用那一半的话，他照样能响应南蛮和决斗。 */
  prohibitsOwnResponse(state, ownerId, cardName) {
    return cardName === '杀' && slashLocked(state, ownerId)
  },
})

export const CAOZHANG: CharacterDefinition = {
  id: 'caozhang',
  name: '曹彰',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: JIANGCHI,
      name: '将驰',
      description: '摸牌阶段，你可以选择一项：额外摸一张牌，然后本回合你不能使用或打出【杀】；'
        + '或少摸一张牌，然后本回合你使用【杀】无距离限制且可以多使用一张【杀】。',
    },
  ],
}
