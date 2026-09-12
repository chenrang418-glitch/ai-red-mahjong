import { loseHp } from '../../engine/hp'
import { skipPhase } from '../../engine/turn'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 陆绩（三国杀 OL 经典身份 SP）。
 *
 * 【怀橘】：锁定技，游戏开始时获得 3 枚橘标记；拥有至少 1 枚橘的角色将受到
 *          伤害时防止此次伤害并移除 1 枚橘；拥有至少 1 枚橘的角色摸牌阶段
 *          额外摸 1 张（不叠加）。
 * 【遗礼】：出牌阶段开始时，陆绩可以选择：失去 1 点体力；或移除自己 1 枚橘，
 *          令一名其他角色获得 1 枚橘（无橘时只能选前者）。
 * 【整论】：若陆绩当前没有橘，他可以跳过摸牌阶段并获得 1 枚橘。
 *
 * 两处最容易做错的：
 *
 * 1. **橘标记是 `player.marks` 上的数字**，不是实体牌，可以分布在不同角色
 *    身上；防止伤害走已有的 `preventsDamage` 钩子（目标侧，同大雾/仁心），
 *    摸牌加成用「改事件里的 count」这一既有软修正手法（不取消默认摸牌），
 *    两者都不认「谁拥有陆绩这张武将牌」，只认「谁身上有橘」。
 * 2. **摸牌加成不叠加**：只要 `orange > 0` 就 +1，不是「每枚橘 +1」。
 */

const HUAIJU = 'huaiju'
const YILI = 'yili'
const ZHENGLUN = 'zhenglun'
const ORANGE_MARK = 'orange'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: HUAIJU,
  onGameStart(host, ownerId) {
    const owner = playerOf(host.state, ownerId)
    if (owner) owner.marks[ORANGE_MARK] = 3
  },

  /*
   * `preventsDamage` 是纯预测函数，拿到的是 `state` 而不是 `host`——没有
   * `dispatch`，发不出战报。**直接在这里扣掉那 1 枚橘**（`state` 本来就是
   * 可变对象，判定成立即生效）；防止之后的通用战报由伤害管线自己统一发
   * （`announceDamagePrevented`，大雾/仁心同一条路），不需要技能自己再播
   * 一条。
   */
  preventsDamage(state, ownerId, side) {
    if (side !== 'target') return false
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || (owner.marks[ORANGE_MARK] ?? 0) <= 0) return false
    owner.marks[ORANGE_MARK] -= 1
    return true
  },

  triggers: [{
    event: 'DrawPhase',
    handle(host, _ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; count?: number }
      if (!payload.playerId) return
      const drawer = playerOf(host.state, payload.playerId)
      if (!drawer?.alive || (drawer.marks[ORANGE_MARK] ?? 0) <= 0) return
      context.event.payload.count = Math.max(0, Math.trunc(Number(payload.count ?? 2))) + 1
    },
  }],
})

registerSkillRuntime({
  id: YILI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      host.queueSkill({ skillId: YILI, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const hasOrange = (owner.marks[ORANGE_MARK] ?? 0) > 0
    host.askSkill({
      skillId: YILI, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【遗礼】：选择一项', timeoutMs: 20_000, optional: true,
        options: [
          { id: 'losehp', label: '失去 1 点体力' },
          ...(hasOrange ? [{ id: 'give', label: '移除自己 1 枚橘，令一名其他角色获得 1 枚橘' }] : []),
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'losehp') {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        host.dispatch('SkillActivated', {
          skillId: YILI, skillName: '遗礼', playerId: ownerId,
          logText: `${owner.nickname}发动【遗礼】，失去 1 点体力`,
        }, { sourceId: ownerId })
        loseHp(host as never, ownerId, 1, YILI)
        return
      }
      if (optionId === 'give') {
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.askSkill({
          skillId: YILI, ownerId, step: 'target',
          build: (requestId): ChooseTargetsRequest => ({
            id: requestId, kind: 'choose-targets', playerId: ownerId,
            prompt: '【遗礼】：选择一名其他角色获得 1 枚橘', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
          }),
        })
      }
      return
    }

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive || (owner.marks[ORANGE_MARK] ?? 0) <= 0) return
      owner.marks[ORANGE_MARK] -= 1
      target.marks[ORANGE_MARK] = (target.marks[ORANGE_MARK] ?? 0) + 1
      host.dispatch('SkillActivated', {
        skillId: YILI, skillName: '遗礼', playerId: ownerId, targetId,
        logText: `${owner.nickname}发动【遗礼】，移除自己 1 枚橘，令${target.nickname}获得 1 枚橘`,
      }, { sourceId: ownerId, targetId })
    }
  },
})

registerSkillRuntime({
  id: ZHENGLUN,
  offerPhaseSkip(host, ownerId, phase) {
    if (phase !== 'draw') return false
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || (owner.marks[ORANGE_MARK] ?? 0) > 0) return false
    host.askSkill({
      skillId: ZHENGLUN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【整论】：跳过摸牌阶段，获得 1 枚橘？',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【整论】' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive) {
        skipPhase(host.state, 'draw')
        owner.marks[ORANGE_MARK] = (owner.marks[ORANGE_MARK] ?? 0) + 1
        host.dispatch('SkillActivated', {
          skillId: ZHENGLUN, skillName: '整论', playerId: ownerId,
          logText: `${owner.nickname}发动【整论】，跳过摸牌阶段，获得 1 枚橘`,
        }, { sourceId: ownerId })
      }
    }
    host.resumePhaseEntry()
  },
})

export const LUJI: CharacterDefinition = {
  id: 'luji',
  name: '陆绩',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: HUAIJU,
      name: '怀橘',
      description: '锁定技，游戏开始时获得 3 枚橘标记；拥有至少 1 枚橘的角色将受到伤害时防止此次伤害并移除 1 枚橘；拥有至少 1 枚橘的角色摸牌阶段额外摸 1 张。',
      locked: true,
    },
    {
      id: YILI,
      name: '遗礼',
      description: '出牌阶段开始时，陆绩可以选择：失去 1 点体力；或移除自己 1 枚橘，令一名其他角色获得 1 枚橘（无橘时只能选前者）。',
    },
    {
      id: ZHENGLUN,
      name: '整论',
      description: '若陆绩当前没有橘，他可以跳过摸牌阶段并获得 1 枚橘。',
    },
  ],
}
