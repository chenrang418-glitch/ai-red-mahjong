import { setChained } from '../../engine/character-state'
import { conversionStateOf, toggleConversionState } from '../../engine/conversion'
import { applyForcedIdentity } from '../../engine/forced-identity'
import { drawCards } from '../../engine/draw'
import { loseHp, loseMaxHp } from '../../engine/hp'
import type { ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神刘备。本项目的自研玩法表述。
 *
 * 【龙怒】：转换技，锁定技，出牌阶段开始时，
 *   阳：你失去 1 点体力并摸一张牌，然后本回合你的红色手牌均视为火【杀】且无距离限制；
 *   阴：你减 1 点体力上限并摸一张牌，然后本回合你的锦囊牌均视为雷【杀】且无次数限制。
 * 【结营】：锁定技，游戏开始时你处于连环状态，【铁索连环】解除连环的效果对你无效，
 *   其他武将技能或卡牌令你解除连环状态的效果失效，当你受到属性伤害结算后立即进入连环状态；
 *   已处于连环状态的角色手牌上限 +2；结束阶段，你令一名其他角色进入连环状态。
 *
 * 三个最容易写错的地方：
 *
 * 1. **「均视为」是强制的**，不是多给一个转化入口。阳状态下手里那张【桃】不能再吃、
 *    【八卦阵】不能再装——它们此刻只能是火【杀】。所以走公共的「强制牌身份」通道，
 *    不是 `viewAs`。
 * 2. **无距离只给阳、无次数只给阴，而且只对转出来的那些杀**。
 *    手上一张真的实体【杀】在阳状态下仍然讲距离，在阴状态下仍然受次数限制。
 * 3. **结营是连环锁**，不是每次状态变化就粗暴设 true：解除连环的效果对他无效，
 *    受到属性伤害结算后重新进入——但不能再次参与同一条传导链。
 */

const LONGNU = 'longnu'
const JIEYING = 'jieying'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LONGNU,
  announcesSelf: true,

  triggers: [{
    /**
     * 出牌阶段**开始时**触发。
     *
     * 出牌阶段被真正跳过（乐不思蜀、巧变、放权）时 `PhaseStart` 根本不会派发，
     * 于是既不结算也不切换阴阳——这正是要的行为，不需要额外判断。
     * 不能写成回合开始自动触发。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return

      const mode = conversionStateOf(host.state, ownerId, LONGNU)
      if (mode === 'yang') {
        // 阳：失去 1 点体力 → 摸一张 → 红色手牌均视为火杀且无距离
        loseHp(host as never, ownerId, 1, LONGNU)
        if (!playerOf(host.state, ownerId)?.alive) return
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => { host.dispatch(name, data) })
        applyForcedIdentity(host.state, {
          ownerId, scope: 'red', asCardName: '杀', nature: 'fire',
          ignoreDistance: true, unlimitedUses: false, skillId: LONGNU, expiry: 'turn-end',
        })
      } else {
        // 阴：减 1 点体力上限 → 摸一张 → 锦囊牌均视为雷杀且无次数
        loseMaxHp(host as never, ownerId, 1, LONGNU)
        if (!playerOf(host.state, ownerId)?.alive) return
        drawCards(host.state, host.rng, ownerId, 1, (name, data) => { host.dispatch(name, data) })
        applyForcedIdentity(host.state, {
          ownerId, scope: 'trick', asCardName: '杀', nature: 'thunder',
          ignoreDistance: false, unlimitedUses: true, skillId: LONGNU, expiry: 'turn-end',
        })
      }

      // **切换发生在成功结算之后**，不是发问之前
      const next = toggleConversionState(host.state, ownerId, LONGNU)
      host.dispatch('SkillActivated', {
        skillId: LONGNU, skillName: '龙怒', playerId: ownerId,
        logText: `${owner.nickname}发动【龙怒】（${mode === 'yang' ? '阳' : '阴'}）：`
          + `${mode === 'yang' ? '失去 1 点体力' : '减 1 点体力上限'}并摸一张牌，`
          + `本回合${mode === 'yang' ? '红色手牌均视为火【杀】且无距离限制' : '锦囊牌均视为雷【杀】且无次数限制'}`
          + `（下次为${next === 'yang' ? '阳' : '阴'}）`,
      }, { sourceId: ownerId })
    },
  }],

  /**
   * 阳状态转出来的火杀无距离限制。
   *
   * **按载体牌判断**：手上一张真的实体【杀】不吃这个豁免。
   */
  slashIgnoresDistance(state, ownerId, cardId) {
    if (!cardId) return false
    const owner = playerOf(state, ownerId)
    if (!owner?.zones.hand.includes(cardId)) return false
    for (const entry of state.forcedIdentities ?? []) {
      if (entry.ownerId !== ownerId || entry.skillId !== LONGNU) continue
      if (!entry.ignoreDistance) continue
      if (state.cards[cardId]?.color === 'red') return true
    }
    return false
  },
})

registerSkillRuntime({
  id: JIEYING,

  /** 游戏开始时就处于连环状态。 */
  onGameStart(host, ownerId) {
    setChained(host as never, ownerId, JIEYING, true)
  },

  /** 锁定技：解除他连环状态的效果无效。属性伤害传导的统一解除不受此限。 */
  preventsUnchain: true,

  /**
   * **已处于连环状态的角色**手牌上限 +2——不只是神刘备自己，是全场。
   *
   * 所以用 `globalMaxCardsBonus`（因为场上有他，别人也受影响），
   * 不是只影响自己的 `maxCardsBonus`。
   */
  globalMaxCardsBonus(state, _ownerId, targetId) {
    return playerOf(state, targetId)?.chained ? 2 : 0
  },

  triggers: [
    {
      /**
       * 受到属性伤害结算后立即重新进入连环。
       *
       * 属性伤害的传导会先把全场连环角色解除，神刘备在这一步重新横置。
       * **挂在 `AfterDamage` 而不是 `Damaged`**：`Damaged` 时这一次伤害的
       * 传导链还在铺，此刻重新横置会让他被同一条链再打一次。
       * 引擎的 `damageChain.remainingTargetIds` 是在解除之前算好的快照，
       * 所以在 `AfterDamage` 重新横置不会把自己加回那条链里。
       */
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        if (context.event.targetId !== ownerId) return
        // 属性在事件的 **metadata**（`event.damageNature`）里，payload 里只有数值和牌信息
        const nature = context.event.damageNature
        if (nature !== 'fire' && nature !== 'thunder') return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || owner.chained) return
        setChained(host as never, ownerId, JIEYING, true)
      },
    },
    {
      /**
       * 结束阶段令一名其他角色进入连环状态。
       *
       * 锁定技，所以不问「发不发动」，只问选谁。
       * 是**令其进入**，不是切换：目标已经连环时不解除。
       */
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'finish' || payload.playerId !== ownerId) return
        if (!playerOf(host.state, ownerId)?.alive) return
        if (host.state.skillResolution) return
        const candidateIds = host.state.players
          .filter((player) => player.alive && player.id !== ownerId)
          .map((player) => player.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: JIEYING, ownerId, step: 'chain',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【结营】：令一名其他角色进入连环状态',
            timeoutMs: 30_000,
            // 锁定技，必须选一个
            optional: false, candidateIds, min: 1, max: 1,
          }),
        })
      },
    },
  ],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'chain') return
    const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
    if (!targetId || !playerOf(host.state, targetId)?.alive) return
    // **进入**连环状态，不是切换：已经连环的不会被解除
    setChained(host as never, targetId, JIEYING, true)
    host.dispatch('SkillActivated', {
      skillId: JIEYING, skillName: '结营', playerId: ownerId, targetIds: [targetId],
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【结营】，`
        + `令${playerOf(host.state, targetId)?.nickname}进入连环状态`,
    }, { sourceId: ownerId, targetId })
  },
})

export const SHENLIUBEI: CharacterDefinition = {
  id: 'shenliubei',
  name: '神·刘备',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 6,
  pack: 'god',
  skills: [
    {
      id: LONGNU,
      name: '龙怒',
      description: '转换技，锁定技，出牌阶段开始时，阳：你失去1点体力并摸一张牌，然后本回合你的红色手牌均视为火【杀】且无距离限制；阴：你减1点体力上限并摸一张牌，然后本回合你的锦囊牌均视为雷【杀】且无次数限制。',
    },
    {
      id: JIEYING,
      name: '结营',
      description: '锁定技，游戏开始时，你处于连环状态，【铁索连环】解除连环的效果对你无效，其他武将技能或卡牌令你解除连环状态的效果失效，当你受到属性伤害结算后立即进入连环状态；已处于连环状态的角色手牌上限+2；结束阶段，你令一名其他角色进入连环状态。',
    },
  ],
}
