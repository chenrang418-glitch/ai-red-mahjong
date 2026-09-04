import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { setChained } from '../../engine/character-state'
import { resolveDamage } from '../../engine/damage'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 神陆逊。**三国杀移动版当前官方技能页现行版本**（规则源锁定 2026-09-04）。
 *
 * 【军略】：锁定技，当你受到或造成 1 点伤害后，你获得一个「军略」标记。
 * 【摧克】：出牌阶段开始时，若「军略」数量为奇数，你可以对一名角色造成 1 点伤害；
 *   若为偶数，你可以令一名角色进入连环状态并弃置其区域里的一张牌。
 *   若「军略」数量超过 7 个，你可以移去全部「军略」并对所有其他角色造成 1 点伤害。
 * 【绽火】：限定技，出牌阶段，你可以移去全部「军略」，
 *   令至多等量的处于连环状态的角色弃置所有装备区里的牌，然后对其中 1 名角色造成 1 点火焰伤害。
 *
 * 四个容易写错的地方：
 *
 * 1. **0 是偶数**。军略为 0 时可以发动偶数分支，不是「没有军略就不能发动」。
 * 2. 奇数分支的目标是「一名角色」，**包含自己**，不要擅自排除。
 * 3. **「若大于 7」要在奇偶效果结算完之后重新检查**：军略 7 → 奇数分支造成 1 点伤害
 *    → 军略因为军略技能变成 8 → 这时才可以继续发动大摧克。
 *    启动技能时快照一次 7 然后永远不再检查是错的。
 * 4. 大摧克**先移去全部军略再造成伤害**，之后的伤害产生的是新军略，不能继续保持 0。
 */

const JUNLUE = 'junlue'
const CUIKE = 'cuike'
const ZHANHUO = 'zhanhuo'

/** 「军略」标记。和梦魇、暴怒、忍共用公共的 `player.marks`。 */
export const JUNLUE_MARK = 'junlue'

/** 摧克偶数分支弃牌的候选区域：手牌、装备区、判定区。 */
const CUIKE_ZONES = { includeJudgingArea: true } as const

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

export function junlueOf(state: SanguoshaState, playerId: PlayerId): number {
  return playerOf(state, playerId)?.marks[JUNLUE_MARK] ?? 0
}

function addJunlue(state: SanguoshaState, playerId: PlayerId, amount: number): void {
  const owner = playerOf(state, playerId)
  if (!owner || amount <= 0) return
  owner.marks[JUNLUE_MARK] = junlueOf(state, playerId) + amount
}

function clearJunlue(state: SanguoshaState, playerId: PlayerId): number {
  const had = junlueOf(state, playerId)
  const owner = playerOf(state, playerId)
  if (owner) delete owner.marks[JUNLUE_MARK]
  return had
}

/** 从神陆逊座位起顺时针的其他存活角色，顺序稳定。 */
function othersFrom(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const total = state.players.length
  return state.players
    .filter((player) => player.alive && player.id !== ownerId)
    .sort((left, right) => (
      ((left.seat - owner.seat + total) % total) - ((right.seat - owner.seat + total) % total)
    ))
    .map((player) => player.id)
}

/** 场上处于连环状态的存活角色，按稳定座次。 */
function chainedTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const total = state.players.length
  return state.players
    .filter((player) => player.alive && player.chained)
    .sort((left, right) => (
      ((left.seat - owner.seat + total) % total) - ((right.seat - owner.seat + total) % total)
    ))
    .map((player) => player.id)
}

// ─────────────────────────────── 军略 ───────────────────────────────

registerSkillRuntime({
  id: JUNLUE,
  triggers: [{
    /**
     * 受到**或**造成伤害后按点数得军略。
     *
     * 铁索传导的每一次伤害都是独立事件，逐次走到这里，不需要为连环写特例。
     */
    event: 'Damaged',
    handle(host, ownerId, context) {
      const amount = Math.max(0, Math.trunc(Number((context.event.payload as { amount?: unknown }).amount ?? 0)))
      if (amount <= 0) return
      const isTarget = context.event.targetId === ownerId
      const isSource = context.event.sourceId === ownerId && !isTarget
      if (!isTarget && !isSource) return
      if (!playerOf(host.state, ownerId)?.alive) return
      addJunlue(host.state, ownerId, amount)
      host.dispatch('SkillActivated', {
        skillId: JUNLUE, skillName: '军略', playerId: ownerId,
        logText: `【军略】${playerOf(host.state, ownerId)?.nickname}获得 ${amount} 枚「军略」`
          + `（共 ${junlueOf(host.state, ownerId)} 枚）`,
      }, { sourceId: ownerId })
    },
  }],
})

// ─────────────────────────────── 摧克 ───────────────────────────────

registerSkillRuntime({
  id: CUIKE,
  announcesSelf: true,

  triggers: [{
    /**
     * 出牌阶段开始时。阶段被真正跳过时 `PhaseStart` 不会派发，自然不触发。
     *
     * 排队而不是就地发问：这个时机上还可能挂着别的技能，
     * 而且阶段内容要等这一串问完才开始（引擎的 `await-content` 断点负责）。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      if (!playerOf(host.state, ownerId)?.alive) return
      host.queueSkill({ skillId: CUIKE, ownerId, step: 'parity', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (prompt.step === 'parity') {
      const count = junlueOf(host.state, ownerId)
      // **0 是偶数**：军略为 0 时走偶数分支，不是不能发动
      const odd = count % 2 === 1
      if (odd) {
        // 「一名角色」**包含自己**
        const candidateIds = host.state.players.filter((player) => player.alive).map((player) => player.id)
        if (candidateIds.length === 0) {
          host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
          return
        }
        host.askSkill({
          skillId: CUIKE, ownerId, step: 'odd',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: `【摧克】：军略 ${count} 枚（奇数），可以对一名角色造成 1 点伤害`,
            timeoutMs: 30_000, optional: true, candidateIds, min: 0, max: 1,
          }),
        })
        return
      }
      const candidateIds = othersFrom(host.state, ownerId)
      // 偶数分支要「令其进入连环状态并弃置其区域里的一张牌」，目标是别人
      if (candidateIds.length === 0) {
        host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
        return
      }
      host.askSkill({
        skillId: CUIKE, ownerId, step: 'even',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【摧克】：军略 ${count} 枚（偶数），可以令一名角色进入连环状态并弃置其区域里的一张牌`,
          timeoutMs: 30_000, optional: true, candidateIds, min: 0, max: 1,
        }),
      })
      return
    }

    if (prompt.step === 'big') {
      /*
       * **重新读取当前军略**，不是启动技能时的快照。
       * 军略 7 走完奇数分支造成 1 点伤害之后会变成 8，这时才够得上大摧克。
       */
      if (junlueOf(host.state, ownerId) <= 7) return
      if (othersFrom(host.state, ownerId).length === 0) return
      host.askSkill({
        skillId: CUIKE, ownerId, step: 'big',
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: `【摧克】：军略 ${junlueOf(host.state, ownerId)} 枚（大于 7），`
            + '可以移去全部「军略」并对所有其他角色各造成 1 点伤害',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动大摧克' }, { id: 'no', label: '放弃' }],
        }),
      })
      return
    }

    if (prompt.step === 'aoe') {
      // 逐个处理：中途有人濒死要完整跑完，一口气循环会撞「当前濒死流程尚未结束」
      const remaining = [...((prompt.data.remaining as PlayerId[]) ?? [])]
      while (remaining.length > 0) {
        const targetId = remaining.shift()!
        if (!playerOf(host.state, targetId)?.alive) continue
        resolveDamage(host as never, {
          sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null,
        })
        host.queueSkill({ skillId: CUIKE, ownerId, step: 'aoe', data: { remaining } })
        return
      }
    }
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'odd') {
      const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
      if (targetId && playerOf(host.state, targetId)?.alive) {
        /*
         * 普通伤害，来源是神陆逊。**这一点伤害本身会让军略 +1**
         * （军略是「受到或造成」都算），所以奇偶可能立刻改变——
         * 这正是下面重新检查「大于 7」的意义所在。
         */
        resolveDamage(host as never, {
          sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null,
        })
      }
      // 无论发没发动，都要再给一次大摧克的机会
      host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
      return
    }

    if (resolution.step === 'even') {
      const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive) {
        host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
        return
      }
      // **令其进入**连环状态，不是切换：不能用摧克解除别人的连环
      setChained(host as never, targetId, CUIKE, true)
      host.dispatch('SkillActivated', {
        skillId: CUIKE, skillName: '摧克', playerId: ownerId, targetIds: [targetId],
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【摧克】，`
          + `令${playerOf(host.state, targetId)?.nickname}进入连环状态`,
      }, { sourceId: ownerId, targetId })

      // 目标没有牌时，「进入连环状态」照样完成，弃置部分跳过
      if (!hasPickableCards(host.state, targetId, CUIKE_ZONES)) {
        host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
        return
      }
      const pickable = pickableCardsOf(host.state, targetId, CUIKE_ZONES)
      host.askSkill({
        skillId: CUIKE, ownerId, step: 'discard', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【摧克】：弃置${playerOf(host.state, targetId)?.nickname}区域里的一张牌`,
          timeoutMs: 30_000, optional: false, purpose: 'skill',
          // 手牌只给占位槽，不泄露牌面；装备和判定区是公开的
          cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
          min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const picked = ((response.payload as { cardIds?: string[] }).cardIds ?? [])[0]
      if (picked) {
        const cardId = resolvePickedCard(host.state, targetId, picked)
        // 装备离场走 handleEquipmentLost，枭姬、白银狮子才不会被跳过
        if (cardId) movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })
      }
      host.queueSkill({ skillId: CUIKE, ownerId, step: 'big', data: {} })
      return
    }

    if (resolution.step === 'big') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      if (junlueOf(host.state, ownerId) <= 7) return
      // **先移去全部军略**，之后的伤害产生的是新军略
      const removed = clearJunlue(host.state, ownerId)
      host.dispatch('SkillActivated', {
        skillId: CUIKE, skillName: '摧克', playerId: ownerId,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【摧克】，`
          + `移去 ${removed} 枚「军略」，对所有其他角色各造成 1 点伤害`,
      }, { sourceId: ownerId })
      host.queueSkill({ skillId: CUIKE, ownerId, step: 'aoe', data: { remaining: othersFrom(host.state, ownerId) } })
    }
  },
})

// ─────────────────────────────── 绽火 ───────────────────────────────

registerSkillRuntime({
  id: ZHANHUO,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // 军略为 0、或场上没有连环角色，都不产生无意义的发动
    if (junlueOf(state, ownerId) < 1) return []
    if (chainedTargets(state, ownerId).length === 0) return []
    return [{ id: ZHANHUO, label: `绽火（移去全部 ${junlueOf(state, ownerId)} 枚「军略」）` }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== ZHANHUO) return
    const count = junlueOf(host.state, ownerId)
    const candidateIds = chainedTargets(host.state, ownerId)
    if (count < 1 || candidateIds.length === 0) return
    host.askSkill({
      skillId: ZHANHUO, ownerId, step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【绽火】：选择至多 ${count} 名处于连环状态的角色弃置装备区所有牌，`
          + '然后对其中一名造成 1 点火焰伤害',
        timeoutMs: 30_000,
        // 取消不消耗限定技；最少 1 名——后面还要对其中一名造成火伤
        optional: true, candidateIds, min: 0, max: Math.min(count, candidateIds.length),
      }),
    })
  },

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'equipment') return
    const remaining = [...((prompt.data.remaining as PlayerId[]) ?? [])]
    const chosen = (prompt.data.chosen as PlayerId[]) ?? []
    while (remaining.length > 0) {
      const targetId = remaining.shift()!
      const target = playerOf(host.state, targetId)
      if (!target?.alive) continue
      const equipped = Object.entries(target.zones.equipment)
        .filter((entry): entry is [string, CardId] => Boolean(entry[1]))
      if (equipped.length === 0) continue
      for (const [slot, cardId] of equipped) {
        // 走正常弃置：枭姬、白银狮子这些「失去装备」的时机不能被跳过
        moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot: slot as never }, { kind: 'discardPile' })
        host.dispatch('LoseEquipment', { playerId: targetId, cardId, reason: ZHANHUO }, { targetId, cardIds: [cardId] })
      }
      host.dispatch('LoseCard', {
        playerId: targetId, cardIds: equipped.map(([, cardId]) => cardId), reason: ZHANHUO,
      }, { targetId, cardIds: equipped.map(([, cardId]) => cardId) })
      host.queueSkill({ skillId: ZHANHUO, ownerId, step: 'equipment', data: { remaining, chosen } })
      return
    }

    /*
     * **弃装备全部结算完之后**才选火伤目标。
     * 顺序很要紧：目标原本有藤甲的，藤甲此刻已经被弃掉，
     * 后面这点火伤不再受它修正。
     */
    const alive = chosen.filter((playerId) => playerOf(host.state, playerId)?.alive)
    if (alive.length === 0) return
    if (alive.length === 1) {
      fireAt(host, ownerId, alive[0])
      return
    }
    host.askSkill({
      skillId: ZHANHUO, ownerId, step: 'fire',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【绽火】：对其中一名角色造成 1 点火焰伤害',
        timeoutMs: 30_000, optional: false, candidateIds: alive, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targetIds = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
      // 交空当作取消，不消耗限定技
      if (targetIds.length === 0) return
      const count = junlueOf(host.state, ownerId)
      if (count < 1 || targetIds.length > count) return
      // 落地前把军略全部移去
      const removed = clearJunlue(host.state, ownerId)
      host.dispatch('SkillActivated', {
        skillId: ZHANHUO, skillName: '绽火', playerId: ownerId, targetIds,
        logText: `${playerOf(host.state, ownerId)?.nickname}发动【绽火】，移去 ${removed} 枚「军略」`,
      }, { sourceId: ownerId })
      host.queueSkill({
        skillId: ZHANHUO, ownerId, step: 'equipment',
        data: { remaining: targetIds, chosen: targetIds },
      })
      return
    }

    if (resolution.step === 'fire') {
      const targetId = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])[0]
      if (targetId) fireAt(host, ownerId, targetId)
    }
  },
})

function fireAt(
  host: Parameters<NonNullable<Parameters<typeof registerSkillRuntime>[0]['startQueued']>>[0],
  ownerId: PlayerId,
  targetId: PlayerId,
): void {
  if (!playerOf(host.state, targetId)?.alive) return
  /*
   * 火焰伤害走统一伤害管线，所以连环传导、藤甲、狂风、大雾全部自然生效。
   * 绽火进行中**不禁掉军略**：这点火伤照常给神陆逊产生新的军略。
   */
  resolveDamage(host as never, {
    sourceId: ownerId, targetId, amount: 1, nature: 'fire', cardName: null,
  })
}

export const SHENLUXUN: CharacterDefinition = {
  id: 'shenluxun',
  name: '神·陆逊',
  kingdom: 'shen',
  gender: 'male',
  maxHp: 4,
  pack: 'god',
  skills: [
    {
      id: JUNLUE,
      name: '军略',
      description: '锁定技，当你受到或造成1点伤害后，你获得一个「军略」标记。',
    },
    {
      id: CUIKE,
      name: '摧克',
      description: '出牌阶段开始时，若「军略」数量为奇数，你可以对一名角色造成1点伤害；若为偶数，你可以令一名角色进入连环状态并弃置其区域里的一张牌。若「军略」数量超过7个，你可以移去全部「军略」并对所有其他角色造成1点伤害。',
    },
    {
      id: ZHANHUO,
      name: '绽火',
      description: '限定技，出牌阶段，你可以移去全部「军略」，令至多等量的处于连环状态的角色弃置所有装备区里的牌，然后对其中1名角色造成1点火焰伤害。',
    },
  ],
}
