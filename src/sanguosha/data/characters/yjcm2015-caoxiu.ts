import { finalizeDamage, resumeDamageChain } from '../../engine/damage'
import { movePickedCard } from '../../engine/card-pick'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, DamageNature, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹休（一将成名 2015）。
 *
 * 【千驹】：锁定技，若曹休已受伤，他计算与其他角色的距离 -X（X 为已损失的
 *          体力值）。
 * 【倾袭】：曹休使用【杀】即将对一个目标造成伤害时，若曹休装备区有武器，
 *          可以发动：目标选择弃置 X 张手牌（X 为武器攻击范围）并弃置曹休
 *          这张武器，或者此伤害 +1。
 *
 * 两处最容易做错的：
 *
 * 1. **千驹只影响曹休看别人的这一侧**，用 `distanceModifier.toOthers`
 *    动态取「已损失体力」，不建立常驻状态。
 * 2. **倾袭同一次伤害只能挂起一次询问**：走 `BeforeDamage` cancel + 后续
 *    `finalizeDamage` 原样续上（A 分支金额不变，B 分支 +1），并且要避开
 *    属性伤害传导 / 群体锦囊结算 / 已有技能挂起这三种同步冲突场景。
 */

const QIANJU = 'qianju'
const QINGXI = 'qingxi'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QIANJU,
  distanceModifier: {
    toOthers: (state, ownerId) => {
      const owner = playerOf(state, ownerId)
      if (!owner) return 0
      return -(owner.maxHp - owner.hp)
    },
  },
})

registerSkillRuntime({
  id: QINGXI,
  triggers: [{
    event: 'BeforeDamage',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardName?: string; amount?: number; cardId?: CardId; redirectedBy?: string }
      if (context.event.sourceId !== ownerId || payload.cardName !== '杀') return
      const targetId = context.event.targetId
      if (!targetId) return
      const owner = playerOf(host.state, ownerId)
      const weaponId = owner?.zones.equipment.weapon
      if (!owner?.alive || !weaponId) return
      if (host.state.damageChain || host.state.cardResolution?.kind === 'trick' || host.state.skillResolution) return
      const amount = typeof payload.amount === 'number' ? payload.amount : 0
      if (amount <= 0) return
      context.cancel()
      host.askSkill({
        skillId: QINGXI, ownerId, step: 'ask',
        data: {
          targetId, weaponId, amount, nature: (context.event.damageNature ?? 'normal') as DamageNature,
          cardId: payload.cardId ?? null, cardName: payload.cardName ?? null, redirectedBy: payload.redirectedBy ?? null,
        },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【倾袭】：是否发动？',
          timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动【倾袭】' }, { id: 'no', label: '不发动' }],
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const weaponId = resolution.data.weaponId as CardId
    const amount = resolution.data.amount as number
    const nature = resolution.data.nature as DamageNature
    const cardId = resolution.data.cardId as CardId | null
    const cardName = resolution.data.cardName as string | null
    const redirectedBy = resolution.data.redirectedBy as string | null

    const reapply = (finalAmount: number): void => {
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      finalizeDamage(host as never, target, ownerId, finalAmount, nature, cardId, cardName, redirectedBy, false)
      /*
       * `finalizeDamage` 是绕开 `resolveDamage` 直接调用的——属性伤害传导
       * （火/雷伤害命中连环角色）会在这里面重新建立 `damageChain`，但正常情况下
       * 只有 `resolveDamage` 的包装会在调用后接一句 `resumeDamageChain` 去把它
       * 排空。这里不接的话，链会挂在 `state.damageChain` 上永远没人处理，
       * 回合结束时的收尾检查会认为「场面不干净」，卡死在 finish 阶段推不动
       * （压测复现：seed=bisect-caoxiu-33）。
       */
      if (!host.state.dying) resumeDamageChain(host as never)
    }

    if (resolution.step === 'ask') {
      const owner = playerOf(host.state, ownerId)
      const target = playerOf(host.state, targetId)
      const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
      if (!accepted || !owner?.alive || owner.zones.equipment.weapon !== weaponId) { reapply(amount); return }
      const range = host.state.cards[weaponId]?.attackRange ?? 1
      const canDiscardX = (target?.zones.hand.length ?? 0) >= range
      if (!target?.alive) { reapply(amount); return }
      host.askSkill({
        skillId: QINGXI, ownerId, step: 'choice', data: { ...resolution.data, range },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: `${owner.nickname}发动【倾袭】：选择一项`,
          timeoutMs: 20_000, optional: false,
          options: [
            ...(canDiscardX ? [{ id: 'discard', label: `弃置 ${range} 张手牌，并弃置${owner.nickname}的这件武器` }] : []),
            { id: 'more', label: '此伤害 +1' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'choice') {
      const range = resolution.data.range as number
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard' && target?.alive && target.zones.hand.length >= range) {
        host.askSkill({
          skillId: QINGXI, ownerId, step: 'discard-pick', data: resolution.data,
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: targetId,
            prompt: `【倾袭】：弃置 ${range} 张手牌`,
            timeoutMs: 20_000, optional: false, purpose: 'skill',
            cardIds: [...target.zones.hand], hiddenCardSlots: [], min: range, max: range,
          }),
        })
        return
      }
      reapply(amount + 1)
      return
    }

    if (resolution.step === 'discard-pick') {
      const target = playerOf(host.state, targetId)
      const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
        .filter((id) => target?.zones.hand.includes(id))
      const range = resolution.data.range as number
      if (!target?.alive || cardIds.length !== range) { reapply(amount); return }
      for (const id of cardIds) moveCard(host.state, id, { kind: 'hand', playerId: targetId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: targetId, cardIds, reason: QINGXI }, { targetId, cardIds })
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive && owner.zones.equipment.weapon === weaponId) {
        movePickedCard(host as never, ownerId, weaponId, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [weaponId], reason: QINGXI }, { targetId: ownerId, cardIds: [weaponId] })
      }
      reapply(amount)
    }
  },
})

export const CAOXIU: CharacterDefinition = {
  id: 'caoxiu',
  name: '曹休',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2015',
  skills: [
    {
      id: QIANJU,
      name: '千驹',
      description: '锁定技，若曹休已受伤，他计算与其他角色的距离 -X（X 为已损失的体力值）。',
    },
    {
      id: QINGXI,
      name: '倾袭',
      description: '曹休使用【杀】即将对一个目标造成伤害时，若曹休装备区有武器，可以发动：目标选择弃置 X 张手牌（X 为武器攻击范围）并弃置曹休这张武器，或者此伤害 +1。',
    },
  ],
}
