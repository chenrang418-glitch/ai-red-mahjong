import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 凌统（一将成名 2011 经典成熟版）。
 *
 * 【旋风】：弃牌阶段结束时，若你于此阶段内因弃置而失去过至少两张手牌，
 *          或每当你失去装备区里的牌后，你可以选择一项：
 *          令一名其他角色依次弃置至多两张牌；或令至多两名其他角色依次各弃置一张牌。
 *
 * 六处最容易做错的：
 *
 * 1. **只数「弃牌阶段内因弃置失去的手牌」**：使用、打出、交给别人、被别人拿走、
 *    弃装备一律不算。分几次弃的可以累计。
 * 2. **一次原子的装备离场只给一次机会**：甘露一次换掉三件装备只触发一次，
 *    不是三次。这就是 `EquipmentZoneLoss` 和每张一条的 `LoseEquipment`
 *    要分成两条事件的原因。
 * 3. **「依次」是真的依次**：第一张弃完、连带触发的一切结算完，
 *    再判断还有没有牌、要不要弃第二张。一次性预选两张会让中途发生的
 *    枭姬、伤逝、白银狮子全部错位。
 * 4. **两个「至多」都是真的**：单目标可以只弃一张，双目标可以只选一人。
 * 5. **可弃区域是手牌 + 装备区，判定区不可**；只有判定牌的人不算合法目标。
 * 6. **暗手牌不能先看**：手牌只给占位槽，由服务端还原成真实牌。
 */

const XUANFENG = 'xuanfeng'

/** 触发一次旋风所需的、本弃牌阶段内因弃置失去的手牌张数。 */
const DISCARD_PHASE_THRESHOLD = 2

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 本次弃牌阶段里，这个人**因弃置失去的手牌**张数。
 *
 * 读的是公共的弃牌阶段账本：那本账只记「明确标记为弃置、而且来自哪个区」的移动，
 * 所以使用牌、判定牌、阵亡收牌都不会混进来。装备区来的记录在这里被过滤掉——
 * 旋风数的是手牌。
 */
function handDiscardsThisPhase(state: SanguoshaState, playerId: PlayerId): number {
  const ledger = state.discardPhaseLedger
  if (!ledger || ledger.ownerPlayerId !== playerId) return 0
  return ledger.records
    .filter((record) => record.sourcePlayerId === playerId && record.originalZone === 'hand')
    .length
}

/** 现在有哪些人可以被旋风弃牌：**手牌或装备区里有牌**的其他存活角色。 */
function xuanfengTargets(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  return state.players
    .filter((candidate) => candidate.alive && candidate.id !== ownerId)
    // 只有判定牌的人不算「有牌」——判定区不在旋风的可弃范围里
    .filter((candidate) => hasPickableCards(state, candidate.id))
    .map((candidate) => candidate.id)
}

registerSkillRuntime({
  id: XUANFENG,
  announcesSelf: true,
  triggers: [{
    /*
     * 触发一：弃牌阶段结束时，本阶段因弃置失去过至少两张手牌。
     *
     * 挂在 `PhaseEnd` 上直接发问（和神华佗【游医】同一条路）：
     * 弃牌阶段的账本活到本回合结束，所以发问和落地读到的是同一本账；
     * 这也让「旋风弃掉的牌仍算在凌统的弃牌阶段里」这类联动成立。
     */
    event: 'PhaseEnd',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'discard' || payload.playerId !== ownerId) return
      if (handDiscardsThisPhase(host.state, ownerId) < DISCARD_PHASE_THRESHOLD) return
      askMode(host, ownerId, 'discard-phase')
    },
  }, {
    /*
     * 触发二：失去装备区里的牌之后。
     *
     * 用的是**按原子操作计数**的那条事件：一次换掉三件装备只给一次机会。
     * 排队而不是当场问——装备离场往往发生在别的结算中途
     * （被拆、被顺、甘露互换），那时候挂起会和正在跑的结算抢同一个槽。
     */
    event: 'EquipmentZoneLoss',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      if ((payload.cardIds ?? []).length === 0) return
      host.queueSkill({ skillId: XUANFENG, ownerId, step: 'mode', data: { reason: 'equipment-loss' } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'mode') return
    askMode(host, ownerId, String(prompt.data.reason ?? 'equipment-loss'))
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'mode') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'one' && optionId !== 'two') return
      const candidateIds = xuanfengTargets(host.state, ownerId)
      if (candidateIds.length === 0) return
      host.dispatch('SkillActivated', {
        skillId: XUANFENG, skillName: '旋风', playerId: ownerId,
        logText: optionId === 'one'
          ? `${owner.nickname}发动【旋风】，弃置一名角色至多两张牌`
          : `${owner.nickname}发动【旋风】，弃置至多两名角色各一张牌`,
      }, { sourceId: ownerId })
      host.askSkill({
        skillId: XUANFENG, ownerId, step: 'targets', data: { mode: optionId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: optionId === 'one'
            ? '【旋风】：选择一名角色，依次弃置其至多两张牌'
            : '【旋风】：选择至多两名角色，依次各弃置一张牌',
          timeoutMs: 20_000, optional: false,
          candidateIds,
          min: 1,
          // 「至多两名」：选一名也合法
          max: optionId === 'one' ? 1 : Math.min(2, candidateIds.length),
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const mode = resolution.data.mode as 'one' | 'two'
      const targetIds = ((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])
        .filter((targetId, index, all) => all.indexOf(targetId) === index)
      if (targetIds.length === 0) return
      /*
       * 把「还要弃谁、各弃几张」整个排进一条可序列化的计划里。
       *
       * 每弃一张就从计划里划掉一项，然后重新开始下一项——
       * 中间发生的一切（枭姬摸牌、白银狮子回血、另一个凌统的旋风）
       * 都在两次弃牌之间完整结算，这正是「依次」的含义。
       */
      const plan = mode === 'one'
        ? [{ targetId: targetIds[0] }, { targetId: targetIds[0] }]
        : targetIds.slice(0, 2).map((targetId) => ({ targetId }))
      continuePlan(host, ownerId, plan)
      return
    }

    if (resolution.step === 'discard') {
      const targetId = resolution.data.targetId as PlayerId
      const plan = (resolution.data.plan as Array<{ targetId: PlayerId }>) ?? []
      const picked = (response.payload as { cardIds?: string[] }).cardIds ?? []
      const [choice] = picked
      if (choice) {
        const cardId = resolvePickedCard(host.state, targetId, choice)
        if (cardId && movePickedCard(host as never, targetId, cardId, { kind: 'discardPile' })) {
          host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: XUANFENG }, { targetId, cardIds: [cardId] })
        }
      }
      /*
       * **弃了才继续，主动放弃就停手。**「至多」两个字就在这里兑现：
       * 单目标模式弃完第一张可以不弃第二张，双目标模式同理。
       */
      if (!choice) return
      continuePlan(host, ownerId, plan)
    }
  },
})

/**
 * 按计划弃下一张牌。
 *
 * 每次只发一个请求，回答之后再回到这里——**不是一口气把两张都选完**。
 * 目标在上一张牌结算过程中没牌了、死了，就跳过他继续下一项。
 */
function continuePlan(host: SkillHost, ownerId: PlayerId, plan: Array<{ targetId: PlayerId }>): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const remaining = [...plan]
  while (remaining.length > 0) {
    const next = remaining.shift()!
    const target = playerOf(host.state, next.targetId)
    if (!target?.alive || !hasPickableCards(host.state, next.targetId)) continue
    const pickable = pickableCardsOf(host.state, next.targetId)
    host.askSkill({
      skillId: XUANFENG, ownerId, step: 'discard', data: { targetId: next.targetId, plan: remaining },
      build: (requestId) => ({
        id: requestId, kind: 'choose-cards' as const, playerId: ownerId,
        prompt: `【旋风】：弃置${target.nickname}的一张牌`,
        timeoutMs: 20_000,
        // 「至多」：这一张可以不弃
        optional: true, purpose: 'skill' as const,
        // 手牌只给占位槽，凌统看不到牌面；装备是明置的
        cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots,
        min: 0, max: 1,
      }),
    })
    return
  }
}

/** 问凌统用哪一种模式。两种模式都不选就是不发动。 */
function askMode(host: SkillHost, ownerId: PlayerId, reason: string): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (host.state.skillResolution) return
  // 场上没有可弃牌的人时不弹一个只能拒绝的窗口
  if (xuanfengTargets(host.state, ownerId).length === 0) return
  host.askSkill({
    skillId: XUANFENG, ownerId, step: 'mode', data: { reason },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId,
      prompt: '【旋风】：选择一项',
      timeoutMs: 20_000, optional: true,
      options: [
        { id: 'one', label: '令一名角色依次弃置至多两张牌' },
        { id: 'two', label: '令至多两名角色依次各弃置一张牌' },
        { id: 'cancel', label: '不发动' },
      ],
    }),
  })
}

export const LINGTONG: CharacterDefinition = {
  id: 'lingtong',
  name: '凌统',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2011',
  skills: [
    {
      id: XUANFENG,
      name: '旋风',
      description: '弃牌阶段结束时，若你于此阶段内因弃置而失去过至少两张手牌，'
        + '或每当你失去装备区里的牌后，你可以选择一项：'
        + '令一名其他角色依次弃置至多两张牌；或令至多两名其他角色依次各弃置一张牌。',
    },
  ],
}
