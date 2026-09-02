import { getDistance } from '../../engine/distance'
import { recover } from '../../engine/recover'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 神话再临·风包。
 *
 * 只放技能全部实现完的武将。**没实现的宁可不登记**——
 * 能选到却发动不了比根本选不到更糟。
 */

// —— 魏延【狂骨】——
//
// 采用**经典风包版**：锁定技，你对距离 1 以内的角色造成伤害后，
// 回复等同于伤害点数的体力。
// 界限突破版是「可以回复 1 点体力或摸一张牌」，这里不混进来。
//
// 挂在 `AfterDamage` 而不是 `Damaged`：两者都在扣血之后、进入濒死之前，
// 但 AfterDamage 是这一轮伤害时机的最后一站，回血放在这里不会打断
// 别的「受到伤害后」技能的排队顺序。此时目标即使已经掉到 0 点也还没
// 进濒死结算，仍在存活列表里，距离算得出来。

registerSkillRuntime({
  id: 'kuanggu',
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      const event = context.event
      // 狂骨看的是「你造成伤害」，是来源侧的时机，不是自己挨打
      if (event.sourceId !== ownerId) return
      const targetId = event.targetId as PlayerId | undefined
      if (!targetId || targetId === ownerId) return
      const amount = Number((event.payload as { amount?: unknown }).amount ?? 0)
      if (!Number.isInteger(amount) || amount <= 0) return

      const owner = host.state.players.find((player) => player.id === ownerId)
      // 自己也可能在这一下之后死了（决斗输了、反伤），死人不回血
      if (!owner?.alive) return
      if (getDistance(host.state, ownerId, targetId) > 1) return
      // 锁定技，不发问。满血时 recover 自己会返回 0，不需要额外判断——
      // 「触发了但没有实际回复」和规则一致。
      recover(host, ownerId, amount, ownerId)
    },
  }],
})

// —— 黄忠【烈弓】——
//
// 采用**经典风包版**：锁定技，当你使用【杀】指定一个目标后，
// 若该角色的手牌数小于等于你的体力值，或大于等于你的体力上限，
// 则该【杀】不可被【闪】响应。
// 界限突破版换成了「距离条件 + 可选发动」，这里不混进来。
//
// 走 `slashUndodgeable` 这个公共入口，和铁骑落到同一个 noDodge 字段上——
// 不为烈弓单开一条结算分支。

registerSkillRuntime({
  id: 'liegong',
  slashUndodgeable(state, ownerId, targetId) {
    const owner = state.players.find((player) => player.id === ownerId)
    const target = state.players.find((player) => player.id === targetId)
    if (!owner || !target) return false
    // 比的是当前手牌数。此刻【杀】已经离手进了处理区，所以两边数的都是「出牌之后」的手牌
    const handCount = target.zones.hand.length
    return handCount <= owner.hp || handCount >= owner.maxHp
  },
})

export const WIND_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'weiyan',
    name: '魏延',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'wind',
    skills: [{
      id: 'kuanggu',
      name: '狂骨',
      description: '锁定技，当你对距离一以内的角色造成伤害后，你回复等同于伤害点数的体力。',
    }],
  },
  {
    id: 'huangzhong',
    name: '黄忠',
    kingdom: 'shu',
    gender: 'male',
    maxHp: 4,
    pack: 'wind',
    skills: [{
      id: 'liegong',
      name: '烈弓',
      description: '锁定技，当你使用【杀】指定一个目标后，若该角色的手牌数小于等于你的体力值，或大于等于你的体力上限，则该【杀】不可被【闪】响应。',
    }],
  },
] as const
