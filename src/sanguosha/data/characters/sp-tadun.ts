import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 蹋顿（三国杀 OL 经典身份 SP）。
 *
 * 【乱战】：蹋顿造成或受到伤害后获得1枚「乱战」标记；使用【杀】时可以
 *          额外指定至多 X 个目标（X=当前乱战标记数，直接复用既有的
 *          `extraSlashTargets` 聚合——和天义、诸葛连弩走同一条汇总规则）；
 *          若这次【杀】最终指定的目标数 < X，移除 ceil(X/2) 枚标记。
 *
 * 「黑色普通锦囊牌同样可以额外指定目标」这一半本批暂不实现：现有的目标
 * 数量生成机制（`tricks.ts` 里过河拆桥/顺手牵羊等按候选逐个生成单目标
 * 动作）没有现成的「按技能动态扩展目标数」入口，做这一半需要改造锦囊
 * 目标生成的公共结构，超出本批「最小改动」的范围，作为已知限制记录，
 * 只实现【杀】这一半。
 */

const LUANZHAN = 'luanzhan'
const LUANZHAN_MARK = 'luanzhan'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: LUANZHAN,
  triggers: [
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId && context.event.targetId !== ownerId) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        owner.marks[LUANZHAN_MARK] = (owner.marks[LUANZHAN_MARK] ?? 0) + 1
        host.dispatch('SkillActivated', { skillId: LUANZHAN, skillName: '乱战', playerId: ownerId, logText: `${owner.nickname}获得1枚【乱战】标记` }, { sourceId: ownerId })
      },
    },
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardName?: string; targetIds?: PlayerId[] }
        if (payload.cardName !== '杀') return
        const owner = playerOf(host.state, ownerId)
        const x = owner?.marks[LUANZHAN_MARK] ?? 0
        if (!owner || x === 0) return
        const count = payload.targetIds?.length ?? 0
        if (count >= x) return
        const remove = Math.ceil(x / 2)
        owner.marks[LUANZHAN_MARK] = Math.max(0, x - remove)
      },
    },
  ],

  extraSlashTargets(state, ownerId) {
    return playerOf(state, ownerId)?.marks[LUANZHAN_MARK] ?? 0
  },
})

export const TADUN: CharacterDefinition = {
  id: 'tadun',
  name: '蹋顿',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: LUANZHAN, name: '乱战', description: '蹋顿造成或受到伤害后获得1枚“乱战”标记；使用【杀】时可以额外指定至多X个目标（X为当前乱战标记数）；若最终指定的目标数小于X，移除ceil(X/2)枚标记。' },
  ],
}
