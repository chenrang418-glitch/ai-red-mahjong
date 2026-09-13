import { drawCards } from '../../engine/draw'
import { getAttackRange } from '../../engine/distance'
import { cardCategoryOfName } from '../../engine/damage-provenance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹羲（三国杀 OL 经典身份 SP）。
 *
 * 【刚述】：使用一张非基本牌后，可以选择攻击范围/下个摸牌阶段摸牌数/出牌
 *          阶段【杀】使用次数上限之一 +1（各自最终数值最多到5）；这些加成
 *          持续到曹羲的牌被抵消为止（复用"这张牌被无懈可击抵消"的既有
 *          结算标记，即 AfterCardUse 的 cancelled）。
 * 【谏旋】：受到伤害后，选择一名角色摸1张牌，若其手牌数等于曹羲当前刚述
 *          三项数值中的任意一个，可以再摸1张，如此反复直到不满足为止。
 */

const GANGSHU = 'gangshu'
const JIANXUAN = 'jianxuan'
const RANGE_MARK = 'gangshu-range'
const DRAW_MARK = 'gangshu-draw'
const SLASH_MARK = 'gangshu-slash'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function clearGangshu(state: SanguoshaState, ownerId: PlayerId): void {
  const owner = playerOf(state, ownerId)
  if (!owner) return
  owner.attackRangeBonus = Math.max(0, owner.attackRangeBonus - (owner.marks[RANGE_MARK] ?? 0))
  owner.marks[RANGE_MARK] = 0
  owner.marks[DRAW_MARK] = 0
  owner.marks[SLASH_MARK] = 0
}

registerSkillRuntime({
  id: GANGSHU,
  globalSlashUses(state, ownerId, targetId) {
    if (targetId !== ownerId) return 0
    return state.players.find((p) => p.id === ownerId)?.marks[SLASH_MARK] ?? 0
  },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cancelled?: boolean; cardName?: string }
        if (payload.cancelled) { clearGangshu(host.state, ownerId); return }
        if (cardCategoryOfName(payload.cardName) === 'basic' || !payload.cardName) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const options: Array<{ id: string; label: string }> = []
        if (getAttackRange(host.state, ownerId) < 5) options.push({ id: 'range', label: '攻击范围+1' })
        if (2 + (owner.marks[DRAW_MARK] ?? 0) < 5) options.push({ id: 'draw', label: '下个摸牌阶段摸牌数+1' })
        if (1 + (owner.marks[SLASH_MARK] ?? 0) < 5) options.push({ id: 'slash', label: '出牌阶段【杀】使用次数上限+1' })
        if (options.length === 0) return
        host.queueSkill({ skillId: GANGSHU, ownerId, step: 'ask', data: { options } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { options } = prompt.data as { options: Array<{ id: string; label: string }> }
    host.askSkill({
      skillId: GANGSHU, ownerId, step: 'ask', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【刚述】：选择一项数值+1', timeoutMs: 20_000, optional: true,
        options: [...options, { id: 'none', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'range') {
      owner.attackRangeBonus += 1
      owner.marks[RANGE_MARK] = (owner.marks[RANGE_MARK] ?? 0) + 1
    } else if (optionId === 'draw') {
      owner.marks[DRAW_MARK] = (owner.marks[DRAW_MARK] ?? 0) + 1
    } else if (optionId === 'slash') {
      owner.marks[SLASH_MARK] = (owner.marks[SLASH_MARK] ?? 0) + 1
    } else {
      return
    }
    host.dispatch('SkillActivated', { skillId: GANGSHU, skillName: '刚述', playerId: ownerId, logText: `${owner.nickname}发动【刚述】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: JIANXUAN,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.queueSkill({ skillId: JIANXUAN, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'pick-target') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: JIANXUAN, ownerId, step: 'pick-target', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【谏旋】：选择一名角色摸1张牌', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (!target?.alive) return
    host.dispatch('SkillActivated', { skillId: JIANXUAN, skillName: '谏旋', playerId: ownerId, logText: `${owner.nickname}发动【谏旋】` }, { sourceId: ownerId, targetId })
    drawLoop(host, ownerId, targetId)
  },
})

function gangshuValues(state: SanguoshaState, ownerId: PlayerId): number[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  return [getAttackRange(state, ownerId), 2 + (owner.marks[DRAW_MARK] ?? 0), 1 + (owner.marks[SLASH_MARK] ?? 0)]
}

function drawLoop(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const target = playerOf(host.state, targetId)
  if (!target?.alive) return
  drawCards(host.state, host.rng, targetId, 1, (name, payload) => { host.dispatch(name, payload) })
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (gangshuValues(host.state, ownerId).includes(target.zones.hand.length)) drawLoop(host, ownerId, targetId)
}

export const CAOXI: CharacterDefinition = {
  id: 'caoxi',
  name: '曹羲',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: GANGSHU, name: '刚述', description: '使用一张非基本牌后，可以选择攻击范围/下个摸牌阶段摸牌数/出牌阶段【杀】使用次数上限之一+1（各自最终最多到5），持续到这张牌被抵消。' },
    { id: JIANXUAN, name: '谏旋', description: '受到伤害后，选择一名角色摸1张牌；若其手牌数等于你当前【刚述】三项数值中的任意一个，可以再摸1张，如此反复。' },
  ],
}
