import { drawCards } from '../../engine/draw'
import { effectiveGenderOf } from '../../engine/huashen'
import { movePickedCard } from '../../engine/card-pick'
import { resumeSourceDamagePrevention } from '../../engine/damage'
import { grantSkill, ownedSkillIds, registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 关索（三国杀 OL 经典身份 SP）。
 *
 * 【征南】：其他角色真正死亡后，关索可以摸3张牌，然后从【武圣】【当先】
 *          【制蛮】中尚未拥有的技能里选择永久获得1个（三个都已拥有则只摸牌）。
 * 【撷芳】：锁定技，关索计算与其他角色的距离-X，X为当前存活女性角色数量。
 */

const ZHENGNAN = 'zhengnan'
const XIEFANG = 'xiefang'
/**
 * 【制蛮】：马谡 OL 版技能，本项目此前未收录（已有的一将成名2011版马谡是
 * 心战/挥泪，是另一个版本），官方文本已核实：
 * "当你对其他角色造成伤害时，你可以防止此伤害，若如此做，你获得其装备区
 * 或判定区里的一张牌。"这是一次交互式的"是否防止"发问，走新增的
 * `offersSourceDamagePreventionAsk` + `resumeSourceDamagePrevention` 挂起
 * /续接机制（`engine/damage.ts` / `engine/skills/runtime.ts`）。
 */
const ZHIMAN = 'zhiman'

const GRANT_MENU: Array<{ id: string; name: string }> = [
  { id: 'wusheng', name: '武圣' },
  { id: 'dangxian', name: '当先' },
  { id: ZHIMAN, name: '制蛮' },
]

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function livingFemaleCount(state: SanguoshaState): number {
  return state.players.filter((candidate) => candidate.alive && effectiveGenderOf(state, candidate.id) === 'female').length
}

registerSkillRuntime({
  id: ZHENGNAN,
  triggers: [{
    event: 'Death',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (!payload.playerId || payload.playerId === ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // Death 触发时可能正处在死亡结算链中间，askSkill 直接问会撞上
      // 「已有技能正在等待回应」，走 queueSkill 延后到安全点。
      host.queueSkill({ skillId: ZHENGNAN, ownerId, step: 'draw', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'draw') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    host.dispatch('SkillActivated', { skillId: ZHENGNAN, skillName: '征南', playerId: ownerId, logText: `${owner.nickname}发动【征南】，摸3张牌` }, { sourceId: ownerId })
    drawCards(host.state, host.rng, ownerId, 3, (name, drawPayload) => { host.dispatch(name, drawPayload) })

    const owned = new Set(ownedSkillIds(host.state, ownerId))
    const candidates = GRANT_MENU.filter((entry) => !owned.has(entry.id))
    if (candidates.length === 0) return
    host.askSkill({
      skillId: ZHENGNAN, ownerId, step: 'choose', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【征南】：选择获得一个尚未拥有的技能', timeoutMs: 20_000, optional: false,
        options: candidates.map((entry) => ({ id: entry.id, label: `获得【${entry.name}】` })),
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'choose') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const optionId = (response.payload as { optionId?: string }).optionId
    const picked = GRANT_MENU.find((entry) => entry.id === optionId)
    if (!picked || ownedSkillIds(host.state, ownerId).includes(picked.id)) return
    grantSkill(host.state, ownerId, picked.id)
    host.dispatch('SkillActivated', { skillId: ZHENGNAN, skillName: '征南', playerId: ownerId, logText: `${owner.nickname}通过【征南】永久获得【${picked.name}】` }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: XIEFANG,
  distanceModifier: {
    toOthers: (state) => -livingFemaleCount(state),
  },
})

registerSkillRuntime({
  id: ZHIMAN,
  offersSourceDamagePreventionAsk(host, ownerId, context) {
    if (!context.targetId || context.targetId === ownerId) return false
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, context.targetId)
    if (!owner?.alive || !target?.alive) return false
    /*
     * 这次防止询问发生在 `resolveDamage` 内部——它可能正处在别的结算链
     * 中间（比如万箭齐发逐个目标的求闪回应刚落地），直接 askSkill 会撞上
     * 「已有技能正在等待回应」。走 queueSkill 延后到引擎自己的安全点，
     * `resolveDamage` 这边已经把整个伤害现场存进 `pendingSourceDamage`了。
     */
    host.queueSkill({ skillId: ZHIMAN, ownerId, step: 'ask', data: { targetId: context.targetId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { targetId } = prompt.data as { targetId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target?.alive || !host.state.pendingSourceDamage) {
      resumeSourceDamagePrevention(host as never, false)
      return
    }
    host.askSkill({
      skillId: ZHIMAN, ownerId, step: 'ask', data: { targetId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【制蛮】：是否防止这次对${target.nickname}造成的伤害？`, timeoutMs: 20_000, optional: false,
        options: [
          { id: 'prevent', label: '防止，然后获得其装备区或判定区的一张牌' },
          { id: 'no', label: '不防止' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'ask') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'prevent') {
        resumeSourceDamagePrevention(host as never, false)
        return
      }
      resumeSourceDamagePrevention(host as never, true, ZHIMAN)
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const candidateIds = [
        ...Object.values(target.zones.equipment).filter((cardId): cardId is CardId => !!cardId),
        ...target.zones.judgingArea,
      ]
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: ZHIMAN, ownerId, step: 'gain', data: { targetId },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【制蛮】：获得${target.nickname}装备区或判定区的一张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: candidateIds, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'gain') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const candidateIds = [
        ...Object.values(target.zones.equipment).filter((id): id is CardId => !!id),
        ...target.zones.judgingArea,
      ]
      if (!cardId || !candidateIds.includes(cardId)) return
      if (!movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: ZHIMAN }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('SkillActivated', { skillId: ZHIMAN, skillName: '制蛮', playerId: ownerId, targetId, logText: `${owner.nickname}发动【制蛮】，防止伤害并获得${target.nickname}的一张牌` }, { sourceId: ownerId, targetId })
    }
  },
})

export const GUANSUO: CharacterDefinition = {
  id: 'guansuo',
  name: '关索',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: ZHENGNAN, name: '征南', description: '其他角色真正死亡后，你可以摸3张牌，然后从【武圣】【当先】【制蛮】中选择一个尚未拥有的技能永久获得。' },
    { id: XIEFANG, name: '撷芳', description: '锁定技，你计算与其他角色的距离-X，X为当前存活的女性角色数量。' },
  ],
}
