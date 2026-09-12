import { drawCards } from '../../engine/draw'
import { lockCardCategory } from '../../engine/card-play-lock'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseOptionRequest } from '../../engine/requests'
import type { CardCategory, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 杨修（三国杀 OL 经典身份 SP）。
 *
 * 【啖酪】：成为普通锦囊目标后，若杨修不是唯一目标，可以摸一张牌，然后这张
 *          牌对杨修无效。
 * 【鸡肋】：受到伤害后，可以声明一种牌类别（基本/锦囊/装备），直到本回合
 *          结束，伤害来源不能使用或打出其手牌中该类别的牌。
 *
 * 两处最容易做错的：
 *
 * 1. **啖酪走 `interceptTarget` + `cancelledTargetIds`**（发呆同款），
 *    只取消杨修这一个目标，不影响锦囊对其余目标的结算；「唯一目标」按
 *    `resolution.targetIds.length` 现算，不能只看最初生成的目标数。
 * 2. **鸡肋只锁「使用或打出」，不锁弃置**：复用 `card-play-lock.ts` 里和
 *    颜色禁令并列的类别禁令（只影响 `cardPlayable` 这一个统一出口），
 *    不额外拦截弃牌阶段或技能代价弃牌——那类「弃置」不在鸡肋管辖范围内，
 *    技能文本本身也只提「不能使用/打出」。
 */

const DANLAO = 'danlao'
const JILEI = 'jilei'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: DANLAO,
  interceptTarget(host, ownerId, context) {
    if (context.category !== 'trick') return false
    const resolution = host.state.cardResolution
    if (!resolution || resolution.kind !== 'trick') return false
    if (resolution.targetIds.length <= 1) return false
    host.askSkill({
      skillId: DANLAO, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `你成为【${context.cardName}】的目标（非唯一目标），是否发动【啖酪】？`,
        timeoutMs: 20_000, optional: false,
        options: [
          { id: 'invoke', label: '啖酪：摸一张牌，这张牌对我无效' },
          { id: 'cancel', label: '不发动' },
        ],
      }),
    })
    return true
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const optionId = (response.payload as { optionId?: string }).optionId
    const current = host.state.cardResolution
    if (optionId === 'invoke' && current?.kind === 'trick') {
      const owner = playerOf(host.state, ownerId)
      if (owner?.alive) {
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
        if (!current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
      }
    }
    host.resumeCardTarget()
  },
})

registerSkillRuntime({
  id: JILEI,
  triggers: [{
    event: 'AfterDamage',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const sourceId = context.event.sourceId
      if (!sourceId) return
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      host.queueSkill({ skillId: JILEI, ownerId, step: 'ask', data: { sourceId } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const sourceId = prompt.data.sourceId as PlayerId
    if (!playerOf(host.state, sourceId)?.alive) return
    host.askSkill({
      skillId: JILEI, ownerId, step: 'ask', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【鸡肋】：声明一种牌类别，伤害来源本回合不能使用或打出该类别的手牌',
        timeoutMs: 20_000, optional: true,
        options: [
          { id: 'basic', label: '基本牌' },
          { id: 'trick', label: '锦囊牌' },
          { id: 'equipment', label: '装备牌' },
        ],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const category = (response.payload as { optionId?: string }).optionId as CardCategory | undefined
    const sourceId = resolution.data.sourceId as PlayerId
    if (!category || !['basic', 'trick', 'equipment'].includes(category)) return
    const source = playerOf(host.state, sourceId)
    const owner = playerOf(host.state, ownerId)
    if (!source?.alive || !owner?.alive) return
    const label = category === 'basic' ? '基本牌' : category === 'trick' ? '锦囊牌' : '装备牌'
    lockCardCategory(host.state, { targetId: sourceId, category, sourceId: ownerId, skillId: JILEI })
    host.dispatch('SkillActivated', {
      skillId: JILEI, skillName: '鸡肋', playerId: ownerId, targetId: sourceId,
      logText: `${owner.nickname}发动【鸡肋】，${source.nickname}本回合不能使用或打出手牌中的${label}`,
    }, { sourceId: ownerId, targetId: sourceId })
  },
})

export const YANGXIU: CharacterDefinition = {
  id: 'yangxiu',
  name: '杨修',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    {
      id: DANLAO,
      name: '啖酪',
      description: '当杨修成为普通锦囊目标后，若他不是唯一目标，可以摸一张牌，然后这张牌对他无效。',
    },
    {
      id: JILEI,
      name: '鸡肋',
      description: '杨修受到伤害后，可以声明一种牌类别（基本/锦囊/装备），直到本回合结束，伤害来源不能使用或打出其手牌中该类别的牌。',
    },
  ],
}
