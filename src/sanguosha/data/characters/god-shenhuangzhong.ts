import { clearDyingCause, dyingCausedBy, markDyingCause } from '../../engine/death-cause'
import { drawCards } from '../../engine/draw'
import { gainMaxHp, loseHp } from '../../engine/hp'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import {
  DIJI_STATE, QIHAI_STATE, ZHONGSHU_STATE,
  applyTargetState, hasTargetState,
} from '../../engine/target-state'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { moveCard } from '../../engine/zones'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神黄忠。
 *
 * 【裂穹】：你对其他角色造成伤害后，你可以选择一个尚可击伤的部位，令其获得对应状态：
 *   力烽（随机弃置一半手牌，向上取整）、地机（下一次受到的伤害 +1）、
 *   中枢（使用的下一张牌无效）、气海（不能使用或打出红桃牌）。
 *   若你本回合已经击伤过该角色，则额外可以选择天冲：令其失去所有体力值；
 *   若其因此死亡，你增加 1 点体力上限。
 * 【斩决】：出牌阶段开始时，你可以选择一项：
 *   一、摸等同于当前体力值的牌，然后本阶段使用的下一张【杀】无距离限制且不能被响应；
 *   二、摸等同于已损失体力值的牌，然后本阶段下一次造成伤害后，回复等量体力。
 *
 * 四处最容易做错的：
 *
 * 1. **一次伤害只给一次裂穹机会**，不是按伤害点数循环——3 点伤害仍然只击伤一个部位。
 * 2. **天冲是「失去所有体力」，不是伤害**：不触发受伤类技能、不传导连环，
 *    但照常进入濒死。
 * 3. **「因此死亡」是因果，不是先后**：被桃救回来之后再死不算。
 * 4. **斩决的两种待生效状态在出牌阶段结束时一律清掉**，不能漏到下一个回合。
 */

const LIEQIONG = 'lieqiong'
const ZHANJUE = 'zhanjue'

/** 力烽是即时效果，没有持续状态。 */
const SITE_LIFENG = 'lifeng'
const SITE_DIJI = 'diji'
const SITE_ZHONGSHU = 'zhongshu'
const SITE_QIHAI = 'qihai'
const SITE_TIANCHONG = 'tianchong'

const SITE_LABELS: Record<string, string> = {
  [SITE_LIFENG]: '力烽：随机弃置其一半手牌（向上取整）',
  [SITE_DIJI]: '地机：其下一次受到的伤害 +1',
  [SITE_ZHONGSHU]: '中枢：其使用的下一张牌无效',
  [SITE_QIHAI]: '气海：其不能使用或打出红桃牌',
  [SITE_TIANCHONG]: '天冲：令其失去所有体力值',
}

/** 本回合已经击伤过谁。回合作用域，回合结束清空。 */
const HIT_MARK = 'lieqiong-hit'
/** 斩决一：本阶段的下一张【杀】已经武装。 */
const ZHANJUE_A_MARK = 'zhanjue-slash'
/** 斩决二：本阶段的下一次造成伤害后回复等量体力。 */
const ZHANJUE_B_MARK = 'zhanjue-recover'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function hitMark(targetId: PlayerId): string {
  return `${HIT_MARK}:${targetId}`
}

// ─────────────────────────────── 裂穹 ───────────────────────────────

/**
 * 现在还能击伤这名角色的哪些部位。
 *
 * 三个带持续状态的部位**在状态还挂着时不能重复选**——已经处于该状态了，
 * 再来一次什么都不会发生。状态到期之后可以再次击伤。
 * 力烽是即时效果，没有「正处于」这一说，所以每次都能选。
 */
function availableSites(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): string[] {
  const sites = [SITE_LIFENG]
  if (!hasTargetState(state, targetId, DIJI_STATE)) sites.push(SITE_DIJI)
  if (!hasTargetState(state, targetId, ZHONGSHU_STATE)) sites.push(SITE_ZHONGSHU)
  if (!hasTargetState(state, targetId, QIHAI_STATE)) sites.push(SITE_QIHAI)
  // 天冲只在「本回合已经击伤过这名角色」之后才出现
  if (playerOf(state, ownerId)?.marks[hitMark(targetId)]) sites.push(SITE_TIANCHONG)
  return sites
}

registerSkillRuntime({
  id: LIEQIONG,
  triggers: [
    {
      /*
       * **一次伤害一次机会**，不按点数循环：3 点伤害仍然只击伤一个部位。
       * 一张牌造成多笔独立伤害时，每笔各有一次机会——那是多次「造成伤害后」。
       */
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        if ((context.event.sourceId ?? '') !== ownerId) return
        const targetId = context.event.targetId
        const target = targetId ? playerOf(host.state, targetId) : undefined
        if (!targetId || targetId === ownerId || !target?.alive) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        // 伤害结算里桌面是脏的，交给技能队列
        host.queueSkill({ skillId: LIEQIONG, ownerId, step: 'site', data: { targetId } })
      },
    },
    {
      event: 'TurnEnd',
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        // 「本回合击伤过谁」是回合作用域的记账
        for (const key of Object.keys(owner.marks)) {
          if (key.startsWith(`${HIT_MARK}:`)) delete owner.marks[key]
        }
      },
    },
    {
      /** 被救回来了就不算「因天冲而死」。 */
      event: 'QuitDying',
      handle(host, ownerId, context) {
        const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
        if (playerId) clearDyingCause(host.state, playerId, SITE_TIANCHONG, ownerId)
      },
    },
    {
      event: 'Death',
      allowDeadOwner: true,
      handle(host, ownerId, context) {
        const deadId = (context.event.payload as { playerId?: PlayerId }).playerId
        if (!deadId) return
        if (!dyingCausedBy(host.state, deadId, SITE_TIANCHONG, ownerId)) return
        clearDyingCause(host.state, deadId, SITE_TIANCHONG, ownerId)
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        gainMaxHp(host as never, ownerId, 1, LIEQIONG)
        host.dispatch('SkillActivated', {
          skillId: LIEQIONG, skillName: '裂穹', playerId: ownerId,
          logText: `${owner.nickname}因【天冲】击杀，增加 1 点体力上限`,
        }, { sourceId: ownerId })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'site') return
    const targetId = String((prompt.data as { targetId?: unknown }).targetId ?? '')
    const target = playerOf(host.state, targetId)
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !target?.alive) return
    const sites = availableSites(host.state, ownerId, targetId)
    if (sites.length === 0) return
    host.askSkill({
      skillId: LIEQIONG, ownerId, step: 'site', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【裂穹】：击伤${target.nickname}的一个部位`,
        timeoutMs: 25_000, optional: true,
        /*
         * 「不发动」必须是一个**真的选项**。
         *
         * `optional: true` 不等于可以交白卷：单选请求的校验要求答案是候选里的一项，
         * 没有这一条的话玩家点不了「放弃」，超时的默认回答也会被判非法。
         */
        options: [
          ...sites.map((site) => ({ id: site, label: SITE_LABELS[site] })),
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'site') return
    const targetId = String(resolution.data.targetId ?? '')
    const site = (response.payload as { optionId?: string }).optionId ?? ''
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive) return
    if (!availableSites(host.state, ownerId, targetId).includes(site)) return

    host.dispatch('SkillActivated', {
      skillId: LIEQIONG, skillName: '裂穹', playerId: ownerId, targetId,
      logText: `${owner.nickname}击伤${target.nickname}的${SITE_LABELS[site].split('：')[0]}`,
    }, { sourceId: ownerId, targetId })
    // 记下「本回合击伤过他」——天冲要靠它解锁
    owner.marks[hitMark(targetId)] = 1

    if (site === SITE_LIFENG) {
      /*
       * 一半手牌**向上取整**：3 张弃 2、5 张弃 3。
       * 随机用牌局自己的种子，同一个种子必然弃同样几张。
       */
      const hand = [...target.zones.hand]
      const count = Math.ceil(hand.length / 2)
      const picked: CardId[] = []
      const pool = [...hand]
      for (let index = 0; index < count && pool.length > 0; index += 1) {
        picked.push(...pool.splice(host.rng.nextInt(pool.length), 1))
      }
      for (const cardId of picked) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      }
      if (picked.length > 0) {
        host.dispatch('LoseCard', { playerId: targetId, cardIds: picked, reason: LIEQIONG }, { targetId, cardIds: picked })
      }
      return
    }
    if (site === SITE_DIJI) {
      applyTargetState(host.state, targetId, DIJI_STATE, ownerId, LIEQIONG, 'owner-turn-end')
      return
    }
    if (site === SITE_ZHONGSHU) {
      applyTargetState(host.state, targetId, ZHONGSHU_STATE, ownerId, LIEQIONG, 'owner-turn-end')
      return
    }
    if (site === SITE_QIHAI) {
      applyTargetState(host.state, targetId, QIHAI_STATE, ownerId, LIEQIONG, 'owner-turn-end')
      return
    }
    if (site !== SITE_TIANCHONG) return
    /*
     * 天冲：令其**失去所有体力值**。
     *
     * 是失去体力，不是伤害——不触发「受到伤害后」那批时机、不传导连环、
     * 没有伤害来源可言；但体力归零照常进入濒死。
     * 「因此死亡」靠因果标记判断：被救回来之后再死就不算了。
     */
    if (target.hp <= 0) return
    markDyingCause(host.state, targetId, SITE_TIANCHONG, ownerId)
    loseHp(host as never, targetId, target.hp, LIEQIONG)
  },
})

// ─────────────────────────────── 斩决 ───────────────────────────────

registerSkillRuntime({
  id: ZHANJUE,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.askSkill({
          skillId: ZHANJUE, ownerId, step: 'choose',
          build: (requestId): ChooseOptionRequest => ({
            id: requestId, kind: 'choose-option', playerId: ownerId,
            prompt: '【斩决】：选择一项',
            timeoutMs: 25_000, optional: true,
            options: [
              { id: 'a', label: `一、摸 ${Math.max(0, owner.hp)} 张牌，下一张【杀】无距离限制且不能被响应` },
              { id: 'b', label: `二、摸 ${Math.max(0, owner.maxHp - owner.hp)} 张牌，下一次造成伤害后回复等量体力` },
              // 同上：不发动也得是一个真的选项
              { id: 'cancel', label: '不发动' },
            ],
          }),
        })
      },
    },
    {
      event: 'PhaseEnd',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        /*
         * 两种待生效状态都是「本阶段」的，出牌阶段一结束就清掉——
         * 不管用没用掉。漏清的话它会跟到下一个回合。
         */
        delete owner.marks[ZHANJUE_A_MARK]
        delete owner.marks[ZHANJUE_B_MARK]
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if ((context.event.sourceId ?? '') !== ownerId) return
        const payload = context.event.payload as { cardName?: string }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.marks[ZHANJUE_A_MARK]) return
        /*
         * 只有**【杀】**才消耗这一次。中间用了锦囊、装备、桃都不算——
         * 技能说的是「使用的下一张【杀】」。
         */
        if (payload.cardName !== '杀') return
        delete owner.marks[ZHANJUE_A_MARK]
      },
    },
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        if ((context.event.sourceId ?? '') !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || !owner.marks[ZHANJUE_B_MARK]) return
        const amount = Number((context.event.payload as { amount?: unknown }).amount ?? 0)
        /*
         * 「下一次造成伤害后回复等量体力」——等量指的是**这次伤害的点数**，
         * 不是刚才摸牌的张数。一张多目标牌先打到 A 就已经算这一次了，
         * 之后打 B 不再回血。
         */
        if (amount <= 0) return
        delete owner.marks[ZHANJUE_B_MARK]
        const missing = owner.maxHp - owner.hp
        if (missing <= 0) return
        recover(host as never, ownerId, Math.min(amount, missing), ownerId)
      },
    },
  ],
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const option = (response.payload as { optionId?: string }).optionId
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (option !== 'a' && option !== 'b')) return
    if (option === 'a') {
      // 体力值可能因为别的效果掉到 0 以下，摸牌数不能是负的
      const count = Math.max(0, owner.hp)
      host.dispatch('SkillActivated', {
        skillId: ZHANJUE, skillName: '斩决', playerId: ownerId,
        logText: `${owner.nickname}发动【斩决】一，摸 ${count} 张牌`,
      }, { sourceId: ownerId })
      if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
      owner.marks[ZHANJUE_A_MARK] = 1
      // 无距离限制走公共的本回合出杀规则
      grantTurnSlashBonus(host.state, ownerId, { ignoreDistance: true })
      return
    }
    const count = Math.max(0, owner.maxHp - owner.hp)
    host.dispatch('SkillActivated', {
      skillId: ZHANJUE, skillName: '斩决', playerId: ownerId,
      logText: `${owner.nickname}发动【斩决】二，摸 ${count} 张牌`,
    }, { sourceId: ownerId })
    if (count > 0) drawCards(host.state, host.rng, ownerId, count, (name, payload) => { host.dispatch(name, payload) })
    owner.marks[ZHANJUE_B_MARK] = 1
  },
  /**
   * 斩决一武装期间，他使用的【杀】不能被响应。
   *
   * 绑在**这一整次使用**上：多目标【杀】的每个目标都不能响应。
   */
  slashUndodgeable(state, ownerId) {
    return !!playerOf(state, ownerId)?.marks[ZHANJUE_A_MARK]
  },
  slashIgnoresDistance(state, ownerId) {
    return !!playerOf(state, ownerId)?.marks[ZHANJUE_A_MARK]
  },
})

export const SHENHUANGZHONG: CharacterDefinition = {
  id: 'shenhuangzhong',
  name: '神·黄忠',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: LIEQIONG,
      name: '裂穹',
      description: '当你对其他角色造成伤害后，你可以选择其一个尚可击伤的部位：力烽，其随机弃置一半手牌（向上取整）；地机，其下一次受到的伤害+1；中枢，其使用的下一张牌无效；气海，其不能使用或打出红桃牌。若你本回合已击伤过该角色，你还可以选择天冲：令其失去所有体力值，若其因此死亡，你增加1点体力上限。除力烽外的部位状态持续至该角色的回合结束。',
    },
    {
      id: ZHANJUE,
      name: '斩决',
      description: '出牌阶段开始时，你可以选择一项：一、摸等同于你体力值的牌，然后此阶段你使用的下一张【杀】无距离限制且不能被响应；二、摸等同于你已损失体力值的牌，然后此阶段你下一次造成伤害后，回复等量的体力。',
    },
  ],
}
