import { forceInAttackRange } from '../../engine/attack-range-override'
import { resolveDamage } from '../../engine/damage'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import { finishMission, missionInProgress, missionStatus } from '../../engine/mission-skill'
import {
  clearMovableTokens,
  grantMovableTokens,
  hasMovableToken,
  moveMovableTokens,
  removeMovableTokens,
  tokensOf,
} from '../../engine/movable-tokens'
import { isPhysicalCardUse } from '../../engine/physical-card-use'
import { grantTurnSlashBonus, prohibitSlashThisTurn } from '../../engine/slash-rules'
import { grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, EquipmentSlot, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神太史慈。
 *
 * 【笃烈】：锁定技，你成为体力值大于你的角色使用的【杀】的目标后进行一次判定，
 *   若结果为红桃，取消你这个目标。
 * 【破围】：使命技。游戏开始时，其他角色各获得 1 枚「围」；每个回合开始时，
 *   你的「围」各移动到其拥有者的下家；有你「围」的角色受到伤害后移去其「围」。
 *   回合开始移动后，若当前回合角色有你的「围」，你可以弃一张手牌对其造成 1 点伤害，
 *   或在其体力值不大于你时获得其一张手牌；发动后本回合他视为在能攻击到你的范围内。
 *   你的回合开始时场上没有你的「围」则使命成功，获得【神著】；
 *   使命成功前你进入濒死状态则使命失败：体力回复至 1，移去所有你的「围」，
 *   弃置装备区所有牌。
 * 【神著】：锁定技，你使用非转化非虚拟的【杀】结算结束后，选择一项：
 *   摸一张牌且本回合可以多使用一张【杀】；或摸三张牌且本回合不能再使用【杀】。
 *
 * 这套技能里最容易写错的两处，都在【破围】：
 *
 * - **「围」的移动必须先快照。** 边扫边移会让刚挪过来的那一枚在同一次
 *   回合开始里被再挪一次，一晚上能绕着桌子跑好几圈。
 * - **攻击范围豁免的方向。** 是「有围的那个人视为能打到神太史慈」，
 *   不是反过来。写反了这个技能就从「把自己送到刀口上」变成了远程打击。
 */

/** 弃装备时要走一遍的四个装备栏。 */
const EQUIPMENT_SLOTS: readonly EquipmentSlot[] = ['weapon', 'armor', 'offensiveHorse', 'defensiveHorse']

const DULIE = 'dulie'
const POWEI = 'powei'
const SHENZHU = 'shenzhu'

/** 「围」在公共可移动标记里的 key。 */
export const WEI_TOKEN = 'wei'
/** 笃烈的判定续接 tag。字符串能活过休眠，闭包不能。 */
const DULIE_TAG = 'dulie-judge'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 从 `fromId` 出发的下一个存活角色，跳过死人。 */
function nextAliveAfter(state: SanguoshaState, fromId: PlayerId): PlayerId | null {
  const from = playerOf(state, fromId)
  if (!from) return null
  const size = state.players.length
  for (let offset = 1; offset <= size; offset += 1) {
    const candidate = state.players[(from.seat + offset) % size]
    if (candidate.alive && candidate.id !== fromId) return candidate.id
  }
  return null
}

// ─────────────────────────────── 笃烈 ───────────────────────────────

registerSkillRuntime({
  id: DULIE,
  /**
   * 成为【杀】的目标后判定。
   *
   * 比的是**当前体力值**，不是体力上限、已损失体力或手牌数。
   * 多目标【杀】逐个目标进入这个插入点，所以只处理神太史慈自己这一个。
   */
  interceptTarget(host, ownerId, context) {
    if (context.cardName !== '杀' || context.category !== 'basic') return false
    const source = playerOf(host.state, context.sourceId)
    const owner = playerOf(host.state, ownerId)
    if (!source || !owner?.alive || source.hp <= owner.hp) return false
    host.dispatch('SkillActivated', {
      skillId: DULIE, skillName: '笃烈', playerId: ownerId,
      logText: `${owner.nickname}发动【笃烈】，进行一次判定`,
    }, { sourceId: ownerId })
    performJudgment(host as never, ownerId, '笃烈', { tag: DULIE_TAG, data: { ownerId } })
    /*
     * 返回值是「结算有没有真的挂起」，不能无脑写 true。
     *
     * 笃烈是锁定技，不像铁骑那样先问一句「发不发动」，所以场上没人能改判时
     * 这次判定会**同步跑完**——续接已经执行、控制权也已经交回去了。
     * 这时候再报「已挂起」，引擎会把阶段置成「等待技能」，可是根本没有
     * 待回应的请求，「成为目标阶段必须挂着技能等待状态」这条不变量当场就破
     * （压测 seed=ci-7-38 抓到）。
     *
     * 同步跑完时返回 false 是安全的：引擎在插入点全部问完之后会检查
     * `targetCancelled`，取消掉的目标不会再被要求打【闪】。
     */
    return !!host.state.retrial
  },
})

registerJudgmentContinuation(DULIE_TAG, (host, judged, data) => {
  const ownerId = String(data.ownerId ?? '')
  const resolution = host.state.cardResolution
  /*
   * 取消的是**神太史慈这一个目标**，多目标【杀】的其他人照常结算。
   * 目标一旦取消，这张【杀】对他就不再往下走——不会再要求他打【闪】。
   */
  if (judged.suit === 'heart' && resolution?.kind === 'slash' && resolution.targetId === ownerId) {
    resolution.targetCancelled = true
  }
  /*
   * 只有**真的挂起过**才需要把控制权交回去。
   *
   * 判定同步跑完时这段代码还在 `interceptTarget` 里面，阶段根本没被置成
   * 'awaiting-intercept'，调用 `resumeCardTarget` 会让这个目标被结算两遍。
   * 挂起过的那条路径走到这里时阶段一定是 'awaiting-intercept'，拿它当判据。
   */
  if (resolution?.kind === 'slash' && resolution.stage === 'awaiting-intercept') {
    ;(host as unknown as SkillHost).resumeCardTarget()
  }
})

// ─────────────────────────────── 破围 ───────────────────────────────

/** 破围还在运作中：使命进行中，而且人还活着。 */
function poweiRunning(state: SanguoshaState, ownerId: PlayerId): boolean {
  return !!playerOf(state, ownerId)?.alive && missionInProgress(state, ownerId, POWEI)
}

registerSkillRuntime({
  id: POWEI,
  onGameStart(host, ownerId) {
    const carriers = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId)
      .map((candidate) => candidate.id)
    if (carriers.length === 0) return
    grantMovableTokens(host.state, WEI_TOKEN, ownerId, carriers)
    host.dispatch('SkillActivated', {
      skillId: POWEI, skillName: '破围', playerId: ownerId,
      logText: `${playerOf(host.state, ownerId)?.nickname}发动【破围】，其他角色各获得一枚「围」`,
    }, { sourceId: ownerId })
  },
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId, context) {
        if (!poweiRunning(host.state, ownerId)) return
        const payload = context.event.payload as { playerId?: PlayerId }
        const currentId = payload.playerId
        if (!currentId) return

        /*
         * 先整体移动，再判使命，最后才问分支——顺序不能换。
         *
         * 移动走公共的快照移动：先把所有去处算完再一次写回，
         * 否则刚挪到某人身上的那一枚会在同一次回合开始里被再挪一次。
         */
        moveMovableTokens(host.state, WEI_TOKEN, ownerId, (carrierId) => {
          const next = nextAliveAfter(host.state, carrierId)
          if (next === null) return null
          /*
           * 「围」不能停在它自己的主人身上：落到神太史慈头上就直接再往下传一位。
           * 场上只剩他一个人时没有合法落点，这一枚就地清掉（返回 null）。
           */
          return next === ownerId ? nextAliveAfter(host.state, ownerId) : next
        })

        // 自己的回合开始、场上一枚「围」都不剩：使命成功
        if (currentId === ownerId) {
          if (tokensOf(host.state, WEI_TOKEN, ownerId).length === 0) {
            if (!finishMission(host.state, ownerId, POWEI, 'success')) return
            grantSkill(host.state, ownerId, SHENZHU)
            host.dispatch('SkillActivated', {
              skillId: POWEI, skillName: '破围', playerId: ownerId,
              logText: `${playerOf(host.state, ownerId)?.nickname}的【破围】使命成功，获得【神著】`,
            }, { sourceId: ownerId })
          }
          return
        }

        // 当前回合角色身上有自己的「围」才有分支可选
        if (!hasMovableToken(host.state, WEI_TOKEN, ownerId, currentId)) return
        /*
         * **排队发问，不当场挂请求。**
         * 同一个 `TurnStart` 上别的技能也可能要发问（神荀彧【定汉】就挂在这里），
         * 两个技能同时 `askSkill` 会撞上「已有技能正在等待回应」。
         */
        host.queueSkill({ skillId: POWEI, ownerId, step: 'branch', data: { carrierId: currentId } })
      },
    },
    {
      /*
       * 有「围」的角色**真正受到伤害后**移去其「围」。
       *
       * 挂 `Damaged` 而不是 `LoseHp`：失去体力不是伤害，不移。
       * 伤害被防止（大雾、冯河）根本走不到这个事件，「围」自然保留。
       * 来源是谁、什么属性都不管，只要真的受到了伤害。
       */
      event: 'Damaged',
      handle(host, ownerId, context) {
        const carrierId = context.event.targetId
        if (!carrierId || !poweiRunning(host.state, ownerId)) return
        if (removeMovableTokens(host.state, WEI_TOKEN, ownerId, carrierId) === 0) return
        host.dispatch('SkillActivated', {
          skillId: POWEI, skillName: '破围', playerId: ownerId, targetId: carrierId,
          logText: `${playerOf(host.state, carrierId)?.nickname}受到伤害，移去其「围」`,
        }, { sourceId: ownerId, targetId: carrierId })
      },
    },
  ],
  /**
   * 使命失败：在**濒死当中**介入，不是死了再复活。
   *
   * 回复至 1 点是「回复到这个数值」，不是固定回复 1 点——
   * 体力已经是 -2 时要补 3 点才到 1。失败之后濒死流程就该结束，
   * 不能还继续问「是否使用桃」。
   */
  dyingIntercept(host, ownerId) {
    if (!missionInProgress(host.state, ownerId, POWEI)) return false
    const owner = playerOf(host.state, ownerId)
    if (!owner) return false
    finishMission(host.state, ownerId, POWEI, 'failure')
    host.dispatch('SkillActivated', {
      skillId: POWEI, skillName: '破围', playerId: ownerId,
      logText: `${owner.nickname}的【破围】使命失败`,
    }, { sourceId: ownerId })

    const recovered = Math.max(0, Math.min(owner.maxHp, 1) - owner.hp)
    owner.hp = Math.min(owner.maxHp, 1)
    if (recovered > 0) {
      host.dispatch('Recover', { playerId: ownerId, amount: recovered, reason: POWEI }, { targetId: ownerId })
    }
    clearMovableTokens(host.state, WEI_TOKEN, ownerId)
    /*
     * 弃装备走正常的装备离场路径，枭姬、白银狮子那些「失去装备时」
     * 的效果该触发就触发——直接把牌搬走会把它们全部跳过。
     */
    for (const slot of EQUIPMENT_SLOTS) {
      const cardId = owner.zones.equipment[slot]
      if (!cardId) continue
      moveCard(host.state, cardId, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
      handleEquipmentLost(host as never, ownerId, cardId)
    }
    host.dispatch('QuitDying', { playerId: ownerId, hp: owner.hp, reason: POWEI }, { targetId: ownerId })
    host.state.dying = null
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'branch') return
    const carrierId = String((prompt.data as { carrierId?: unknown }).carrierId ?? '')
    const owner = playerOf(host.state, ownerId)
    const carrier = playerOf(host.state, carrierId)
    // 排队期间局势会变：围可能已经因为伤害被移掉，人也可能死了
    if (!owner?.alive || !carrier?.alive) return
    if (!poweiRunning(host.state, ownerId)) return
    if (!hasMovableToken(host.state, WEI_TOKEN, ownerId, carrierId)) return
    const options = poweiOptions(host.state, ownerId, carrierId)
    if (options.length === 0) return
    host.askSkill({
      skillId: POWEI, ownerId, step: 'branch', data: { carrierId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `${carrier.nickname}拥有你的「围」，是否发动【破围】？`,
        timeoutMs: 25_000, optional: true,
        options: [...options, { id: 'cancel', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const carrierId = String(resolution.data.carrierId ?? '')
    const owner = playerOf(host.state, ownerId)
    const carrier = playerOf(host.state, carrierId)
    if (!owner?.alive || !carrier?.alive) return

    if (resolution.step === 'branch') {
      const optionId = (response.payload as { optionId?: string }).optionId ?? 'cancel'
      if (optionId === 'powei-damage') {
        // 弃的必须是**手牌**，装备和专属牌堆都不行
        host.askSkill({
          skillId: POWEI, ownerId, step: 'pay', data: { carrierId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: `【破围】：弃置一张手牌，对${carrier.nickname}造成 1 点伤害`,
            timeoutMs: 25_000, optional: false, purpose: 'skill',
            cardIds: [...owner.zones.hand], hiddenCardSlots: [],
            min: 1, max: 1,
          }),
        })
        return
      }
      if (optionId !== 'powei-steal') return
      // 提交时重验：发问期间对方可能已经把手牌打光、体力也可能变了
      if (!poweiOptions(host.state, ownerId, carrierId).some((option) => option.id === 'powei-steal')) return
      const [cardId] = host.rng.shuffle([...carrier.zones.hand])
      if (!cardId) return
      moveCard(host.state, cardId, { kind: 'hand', playerId: carrierId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('SkillActivated', {
        skillId: POWEI, skillName: '破围', playerId: ownerId, targetId: carrierId,
        logText: `${owner.nickname}发动【破围】，获得${carrier.nickname}一张手牌`,
      }, { sourceId: ownerId, targetId: carrierId })
      /*
       * 拿的是**暗手牌**：走 `GainCard` 而不带 `revealed`，
       * 别人只知道少了一张，不知道是哪一张。
       */
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: POWEI }, { sourceId: ownerId, targetId: carrierId })
      grantReverseRange(host, ownerId, carrierId)
      return
    }

    if (resolution.step !== 'pay') return
    const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds ?? []
    if (!cardId || !owner.zones.hand.includes(cardId)) return
    moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: POWEI }, { sourceId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', {
      skillId: POWEI, skillName: '破围', playerId: ownerId, targetId: carrierId,
      logText: `${owner.nickname}发动【破围】，对${carrier.nickname}造成 1 点伤害`,
    }, { sourceId: ownerId, targetId: carrierId })
    /*
     * 攻击范围豁免在伤害**之前**给：伤害可能让对方进入濒死，
     * 濒死流程一挂起，后面这行就不一定还跑得到。
     * 「围」的移除交给上面那个 Damaged 时机，这里不要再删一次——
     * 伤害被防止时「受到伤害后」并没有发生，围本来就该留着。
     */
    grantReverseRange(host, ownerId, carrierId)
    resolveDamage(host as never, { sourceId: ownerId, targetId: carrierId, amount: 1, nature: 'normal' })
  },
})

/** 当前局面下破围有哪些分支可选。 */
function poweiOptions(state: SanguoshaState, ownerId: PlayerId, carrierId: PlayerId): Array<{ id: string; label: string }> {
  const owner = playerOf(state, ownerId)
  const carrier = playerOf(state, carrierId)
  const options: Array<{ id: string; label: string }> = []
  if (!owner || !carrier) return options
  // 没有手牌就付不起代价，不能弹一个必然点不动的选项
  if (owner.zones.hand.length > 0) {
    options.push({ id: 'powei-damage', label: '弃置一张手牌，对其造成 1 点伤害' })
  }
  // 体力条件成立、而且对方真的有手牌可拿
  if (carrier.hp <= owner.hp && carrier.zones.hand.length > 0) {
    options.push({ id: 'powei-steal', label: '获得其一张手牌' })
  }
  return options
}

/**
 * 发动破围之后的攻击范围豁免。
 *
 * 方向是 **有围的那个人 → 神太史慈**：本回合他视为能攻击到神太史慈。
 * 反过来写就成了神太史慈获得远程打击，和这个技能的意思正相反。
 */
function grantReverseRange(host: SkillHost, ownerId: PlayerId, carrierId: PlayerId): void {
  forceInAttackRange(host.state, { attackerId: carrierId, targetId: ownerId, sourceSkillId: POWEI })
}

// ─────────────────────────────── 神著 ───────────────────────────────

registerSkillRuntime({
  id: SHENZHU,
  triggers: [{
    /*
     * 时机是**整张【杀】结算结束**，不是每个目标一次。
     * `AfterCardUse` 一次使用只发一次，多目标【杀】也只触发一次神著。
     */
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      if (context.event.sourceId !== ownerId) return
      const payload = context.event.payload as { cardId?: CardId; cardName?: string }
      if (payload.cardName !== '杀') return
      /*
       * 只认**实体原生的【杀】**：武圣、龙胆、龙魂、蛊惑、丈八蛇矛
       * 变出来的杀都不算。火杀雷杀印的就是杀，算。
       */
      if (!isPhysicalCardUse(host.state, payload.cardId, '杀')) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.askSkill({
        skillId: SHENZHU, ownerId, step: 'choose',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【神著】：选择一项',
          // 锁定技，必须选一项
          timeoutMs: 25_000, optional: false,
          options: [
            { id: 'shenzhu-more', label: '摸一张牌，本回合可以多使用一张【杀】' },
            { id: 'shenzhu-stop', label: '摸三张牌，本回合不能再使用【杀】' },
          ],
        }),
      })
    },
  }],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    const stop = optionId === 'shenzhu-stop'
    host.dispatch('SkillActivated', {
      skillId: SHENZHU, skillName: '神著', playerId: ownerId,
      logText: stop
        ? `${owner.nickname}发动【神著】，摸三张牌，本回合不能再使用【杀】`
        : `${owner.nickname}发动【神著】，摸一张牌，本回合可以多使用一张【杀】`,
    }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, stop ? 3 : 1, (name, payload) => host.dispatch(name, payload))
    /*
     * 两个分支都走公共的出杀规则，不自己造一套计数：
     * 「+1 次」要能和诸葛连弩、咆哮、天义的加成一起聚合，
     * 「禁止使用」要压过所有无限杀——这两条都是聚合规则里已经定好的。
     * 而且禁止的只有**使用**，南蛮决斗里打出【杀】不受影响。
     */
    if (stop) prohibitSlashThisTurn(host.state, ownerId)
    else grantTurnSlashBonus(host.state, ownerId, { extraUses: 1 })
  },
})

export { missionStatus as poweiMissionStatus }

export const SHENTAISHICI: CharacterDefinition = {
  id: 'shentaishici',
  name: '神·太史慈',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: DULIE,
      name: '笃烈',
      description: '锁定技，你成为体力值大于你的角色使用的【杀】的目标后，你进行一次判定，若结果为红桃，取消你此目标。',
    },
    {
      id: POWEI,
      name: '破围',
      description: '使命技。游戏开始时，其他角色各获得1枚「围」。每个回合开始时，你的所有「围」各移动到其拥有者的下家；然后若当前回合角色拥有你的「围」，你可以弃置一张手牌对其造成1点伤害，或于其体力值不大于你时获得其一张手牌，然后本回合其视为在可攻击到你的范围内。拥有你「围」的角色受到伤害后，移去其「围」。你的回合开始时若场上没有你的「围」，使命成功，你获得【神著】。使命成功前你进入濒死状态时，使命失败：你将体力回复至1点，移去所有你的「围」，然后弃置装备区里的所有牌。',
    },
    {
      id: SHENZHU,
      name: '神著',
      description: '锁定技，你使用非转化非虚拟的【杀】结算结束后，你选择一项：摸一张牌，本回合你可以多使用一张【杀】；或摸三张牌，本回合你不能再使用【杀】。',
      granted: true,
    },
  ],
}
