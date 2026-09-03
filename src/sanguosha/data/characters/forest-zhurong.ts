import { hasPickableCards, movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { canPindian, registerPindianContinuation, startPindian } from '../../engine/pindian'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 林包·祝融。经典「神话再临·林」首版，不是界祝融。
 *
 * - 【巨象】的「南蛮入侵对你无效」和孟获【祸首】**共用同一个** `cardEffectInvalid`，
 *   没有第二份实现；「结算完毕进入弃牌堆时改由你获得」走 `resolvedCardRecipient`，
 *   由 `cards/host.ts` 的 `finishPhysicalCard` 在牌真正要进弃牌堆的那一刻询问。
 * - 【烈刃】不含一行拼点代码，全部走 `engine/pindian.ts`；
 *   「获得对方一张牌」走 `engine/card-pick.ts`，和庞德【猛进】同一份隐私规则。
 */

export const JUXIANG = 'juxiang'
export const LIEREN = 'lieren'

const LIEREN_TAG = 'lieren'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

// ─────────────────────────────── 巨象 ───────────────────────────────

/**
 * 【巨象】首版原文：
 * 「锁定技，【南蛮入侵】对你无效；若其他角色使用的【南蛮入侵】在结算完毕时
 *   进入弃牌堆，你获得之。」
 *
 * 关键是**「结算完毕时」**：不能南蛮一进处理区就抢走，那样后面的目标就没牌可结算了。
 * `resolvedCardRecipient` 的调用点恰好是「整张牌结算结束、实体牌正要从处理区
 * 进弃牌堆」的那一刻，所以时序天然正确，这里不需要自己盯任何状态。
 *
 * 三条边界由公共入口负责，这里不用重复判断：
 * - **虚拟牌拿不到**：虚拟牌在 `finishPhysicalCard` 里走的是「销毁」那条分支，
 *   根本不会问到这里，所以不可能凭空造出一张牌破坏牌张守恒；
 * - **死了就拿不到**：`resolvedCardRecipientOf` 只遍历存活角色；
 * - **多个祝融**：按座次遍历，第一个满足的拿走，结果稳定，牌不会被复制。
 *
 * 「被无懈掉」不影响获得：规则看的是「使用结算完毕」，不是「造成了伤害」。
 */
registerSkillRuntime({
  id: JUXIANG,
  cardEffectInvalid(_state, _ownerId, _sourceId, cardName) {
    return cardName === '南蛮入侵'
  },
  resolvedCardRecipient(_state, ownerId, context) {
    if (context.cardName !== '南蛮入侵') return false
    // 「其他角色使用的」——自己用的南蛮结算完照常进弃牌堆
    return context.sourceId !== ownerId
  },
})

// ─────────────────────────────── 烈刃 ───────────────────────────────

/**
 * 【烈刃】首版原文：
 * 「你每使用【杀】对目标角色造成一次伤害后，你可以与该角色拼点；
 *   若你赢，你获得其一张牌。」
 *
 * 三条容易做错的地方：
 *
 * 1. **必须真的造成了伤害**。杀被闪掉、伤害被天香转走、伤害被防止，都不触发——
 *    挂在 `AfterDamage` 而不是「使用杀之后」，这一条就自然成立。
 * 2. **看有效牌名**。武圣、龙胆、蛊惑转化出来的杀同样算，
 *    伤害管线一路带下来的 `cardName` 本来就是有效名，不去读实体牌的 name。
 * 3. **不向死人发拼点请求**。那一下打死了对方就不发动；
 *    排队之后还要再确认一次，因为队列排空前牌局又走了一段。
 */
function lierenTargetId(prompt: { data: Record<string, unknown> }): PlayerId | null {
  const targetId = prompt.data.targetId
  return typeof targetId === 'string' ? targetId : null
}

/** 现在还能不能对这个人发动烈刃：双方都活着、都有手牌。 */
function canInvokeLieren(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner?.alive || !target?.alive || ownerId === targetId) return false
  return canPindian(state, ownerId) && canPindian(state, targetId)
}

registerSkillRuntime({
  id: LIEREN,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const event = context.event
      if (event.sourceId !== ownerId) return
      if ((event.payload as { cardName?: unknown }).cardName !== '杀') return
      const targetId = event.targetId
      if (!targetId || targetId === ownerId) return
      // 「造成伤害后」是危险时机：濒死可能正插在中间，牌也还在结算。
      // 只抓事实排队，等牌局干净了再问——和奸雄、刚烈、节命同一条纪律。
      host.queueSkill({ skillId: LIEREN, ownerId, step: 'ask', data: { targetId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const targetId = lierenTargetId(prompt)
    // 排队期间那个人可能已经死了、手牌可能已经空了，前提要重新确认
    if (!targetId || !canInvokeLieren(host.state, ownerId, targetId)) return
    const target = playerOf(host.state, targetId)!
    host.askSkill({
      skillId: LIEREN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `发动【烈刃】？与${target.nickname}拼点，若你赢则获得其一张牌`,
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动烈刃' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId

    if (resolution.step === 'ask') {
      if ((response.payload as { optionId: string }).optionId !== 'yes') return
      // 发问期间牌还可能再变一次
      if (!canInvokeLieren(host.state, ownerId, targetId)) return
      startPindian(host as never, {
        id: `lieren-${host.state.seq}`,
        initiatorId: ownerId,
        opponentId: targetId,
        reason: LIEREN,
        continuationTag: LIEREN_TAG,
      })
      return
    }

    if (resolution.step === 'gain') {
      const [picked] = (response.payload as { cardIds: string[] }).cardIds
      const realId = resolvePickedCard(host.state, targetId, picked)
      if (!realId) return
      movePickedCard(host as never, targetId, realId, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [realId], reason: LIEREN }, { targetId: ownerId, cardIds: [realId] })
    }
  },
})

registerPindianContinuation(LIEREN_TAG, (host, result) => {
  const skillHost = host as unknown as SkillHost
  const ownerId = result.initiatorId
  const targetId = result.opponentId
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return

  // **只有赢才拿牌**：平局按规则不算赢，不能塞进成功分支
  if (result.outcome !== 'initiator-win') {
    skillHost.dispatch('SkillActivated', {
      skillId: LIEREN, skillName: '烈刃', playerId: ownerId, targetIds: [targetId], result: 'lost',
      logText: `${owner.nickname}【烈刃】拼点没有赢，不获得牌`,
    }, { sourceId: ownerId, targetId })
    return
  }

  /*
   * 候选必须**现算**。双方的拼点牌刚刚进了弃牌堆，
   * 拿发起拼点那一刻的手牌列表来选，会把已经不在对方手上的牌算进去。
   */
  if (!hasPickableCards(host.state, targetId)) {
    skillHost.dispatch('SkillActivated', {
      skillId: LIEREN, skillName: '烈刃', playerId: ownerId, targetIds: [targetId], result: 'no-card',
      logText: `${owner.nickname}【烈刃】拼点获胜，但${target.nickname}已经没有牌可拿`,
    }, { sourceId: ownerId, targetId })
    return
  }
  const pickable = pickableCardsOf(host.state, targetId)
  skillHost.askSkill({
    skillId: LIEREN, ownerId, step: 'gain', data: { targetId },
    build: (requestId): ChooseCardsRequest => ({
      id: requestId, kind: 'choose-cards', playerId: ownerId,
      prompt: `【烈刃】拼点获胜：获得${target.nickname}的一张牌`,
      timeoutMs: 20_000, optional: false, purpose: 'skill',
      cardIds: pickable.cardIds,
      hiddenCardSlots: pickable.hiddenCardSlots,
      min: 1, max: 1,
    }),
  })
})

export const ZHURONG: CharacterDefinition = {
  id: 'zhurong',
  name: '祝融',
  kingdom: 'shu',
  gender: 'female',
  maxHp: 4,
  pack: 'forest',
  skills: [
    {
      id: JUXIANG,
      name: '巨象',
      description: '锁定技，【南蛮入侵】对你无效；其他角色使用的【南蛮入侵】结算完毕后，你获得之。',
    },
    {
      id: LIEREN,
      name: '烈刃',
      description: '你每使用【杀】对目标角色造成一次伤害后，你可以与该角色拼点；若你赢，你获得其一张牌。',
    },
  ],
}
