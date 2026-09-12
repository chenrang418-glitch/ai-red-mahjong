import { revealTopCards } from '../../engine/draw'
import { moveCard } from '../../engine/zones'
import { registerSkillRuntime, replaceTemporarySkill } from '../../engine/skills/runtime'
import { HUOJI } from './fire-wolongzhuge'
import { LIANHUAN } from './fire-pangtong'
import { YEYAN } from './god-shenzhouyu'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 司马徽（三国杀经典身份 SP）。
 *
 * 【荐杰】：游戏第一个回合开始时，依次选择两名其他角色，第一名获得
 *          【龙印】（视为拥有火计），第二名获得【凤印】（视为拥有连环）；
 *          同时拥有两印的角色可以移除两印发动【业炎】（直接复用神周瑜的
 *          实现：临时授予业炎，本次发动后收回两印）。司马徽出牌阶段限一次
 *          （不能在第一回合发动）可以转移龙印/凤印；持有印的角色死亡时，
 *          司马徽可以转移其即将失去的印。
 * 【称好】：一名角色受到属性伤害后，若其正处于连环状态、且这次伤害是本次
 *          连环传导的起点，X=当前会向下传导的连环角色数，司马徽观看牌堆
 *          顶 X+1 张牌，任意分配给任意角色。
 * 【隐士】：锁定技，司马徽没有龙印、没有凤印、且没有装备防具时，防止自己
 *          受到的属性伤害和锦囊牌造成的伤害。
 */

const JIANJIE = 'jianjie'
const CHENGHAO = 'chenghao'
const YINSHI = 'yinshi'
const LONG_SOURCE = 'simahui-long'
const FENG_SOURCE = 'simahui-feng'
const BOTH_SOURCE = 'simahui-both'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function seals(state: SanguoshaState): { long: PlayerId | null; feng: PlayerId | null } {
  return state.simahuiSeals ?? { long: null, feng: null }
}

function syncSealGrants(state: SanguoshaState): void {
  const { long, feng } = seals(state)
  for (const player of state.players) {
    replaceTemporarySkill(state, player.id, LONG_SOURCE, player.id === long ? HUOJI : null)
    replaceTemporarySkill(state, player.id, FENG_SOURCE, player.id === feng ? LIANHUAN : null)
    replaceTemporarySkill(state, player.id, BOTH_SOURCE, long && feng && player.id === long && player.id === feng ? YEYAN : null)
  }
}

registerSkillRuntime({
  id: JIANJIE,
  triggers: [
    {
      event: 'TurnStart',
      handle(host, ownerId) {
        if (host.state.turnNumber !== 1) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: JIANJIE, ownerId, step: 'long', data: { candidateIds } })
      },
    },
    {
      event: 'SkillActivated',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { skillId?: string; playerId?: PlayerId }
        if (payload.skillId !== YEYAN) return
        const current = seals(host.state)
        if (!current.long || current.long !== current.feng || current.long !== payload.playerId) return
        host.state.simahuiSeals = { long: null, feng: null }
        syncSealGrants(host.state)
      },
    },
    {
      event: 'Death',
      handle(host, ownerId, context) {
        const deadId = context.event.targetId
        const current = seals(host.state)
        if (!deadId || (current.long !== deadId && current.feng !== deadId)) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) {
          host.state.simahuiSeals = { long: current.long === deadId ? null : current.long, feng: current.feng === deadId ? null : current.feng }
          syncSealGrants(host.state)
          return
        }
        const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
        host.queueSkill({ skillId: JIANJIE, ownerId, step: 'inherit', data: { deadSlot: current.long === deadId ? 'long' : 'feng', candidateIds } })
      },
    },
  ],

  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'long' || prompt.step === 'feng') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: JIANJIE, ownerId, step: prompt.step,
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: prompt.step === 'long' ? '【荐杰】：选择一名角色获得龙印' : '【荐杰】：选择一名角色获得凤印',
          timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'inherit') {
      const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
      host.askSkill({
        skillId: JIANJIE, ownerId, step: 'inherit',
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【荐杰】：可以转移这枚印', timeoutMs: 20_000, optional: true, candidateIds, min: 0, max: 1,
        }),
      })
    }
  },

  resume(host, ownerId, resolution, response) {
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []

    if (resolution.step === 'long') {
      if (!targetId) return
      host.state.simahuiSeals = { ...seals(host.state), long: targetId }
      syncSealGrants(host.state)
      host.dispatch('SkillActivated', { skillId: JIANJIE, skillName: '荐杰', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname}发动【荐杰】，${playerOf(host.state, targetId)?.nickname}获得龙印` }, { sourceId: ownerId, targetId })
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.queueSkill({ skillId: JIANJIE, ownerId, step: 'feng', data: { candidateIds } })
      return
    }
    if (resolution.step === 'feng') {
      if (!targetId) return
      host.state.simahuiSeals = { ...seals(host.state), feng: targetId }
      syncSealGrants(host.state)
      host.dispatch('SkillActivated', { skillId: JIANJIE, skillName: '荐杰', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname}发动【荐杰】，${playerOf(host.state, targetId)?.nickname}获得凤印` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'inherit') {
      const { deadSlot } = resolution.data as { deadSlot: 'long' | 'feng' }
      const current = seals(host.state)
      host.state.simahuiSeals = deadSlot === 'long' ? { long: targetId ?? null, feng: current.feng } : { long: current.long, feng: targetId ?? null }
      syncSealGrants(host.state)
      return
    }
    if (resolution.step === 'move-which') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'long' && optionId !== 'feng') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
      host.askSkill({
        skillId: JIANJIE, ownerId, step: 'move-target', data: { slot: optionId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【荐杰】：转移给谁', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'move-target') {
      const { slot } = resolution.data as { slot: 'long' | 'feng' }
      if (!targetId) return
      const current = seals(host.state)
      host.state.simahuiSeals = slot === 'long' ? { ...current, long: targetId } : { ...current, feng: targetId }
      syncSealGrants(host.state)
      host.dispatch('SkillActivated', { skillId: JIANJIE, skillName: '荐杰', playerId: ownerId, targetId, logText: `${playerOf(host.state, ownerId)?.nickname}发动【荐杰】，转移${slot === 'long' ? '龙印' : '凤印'}` }, { sourceId: ownerId, targetId })
    }
  },

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || state.turnNumber <= 1) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JIANJIE)) return []
    const current = seals(state)
    if (!current.long && !current.feng) return []
    return [{ id: JIANJIE, label: '荐杰：转移龙印/凤印' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIANJIE) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(JIANJIE)) return
    const current = seals(host.state)
    const options = [
      ...(current.long ? [{ id: 'long', label: '转移龙印' }] : []),
      ...(current.feng ? [{ id: 'feng', label: '转移凤印' }] : []),
    ]
    if (options.length === 0) return
    owner.turnUsedSkills.push(JIANJIE)
    host.askSkill({
      skillId: JIANJIE, ownerId, step: 'move-which',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【荐杰】：转移哪一枚印', timeoutMs: 20_000, optional: false, options,
      }),
    })
  },
})

registerSkillRuntime({
  id: CHENGHAO,
  triggers: [{
    event: 'Damaged',
    handle(host, ownerId, context) {
      const targetId = context.event.targetId
      if (!targetId || context.event.damageNature === 'normal') return
      const chain = host.state.damageChain
      if (!chain) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const x = chain.remainingTargetIds.length
      const revealed = revealTopCards(host.state, host.rng, x + 1, CHENGHAO, (name, payload) => { host.dispatch(name, payload) })
      if (revealed.length === 0) return
      host.dispatch('SkillActivated', { skillId: CHENGHAO, skillName: '称好', playerId: ownerId, logText: `${owner.nickname}发动【称好】，看牌堆顶${revealed.length}张牌` }, { sourceId: ownerId })
      host.queueSkill({ skillId: CHENGHAO, ownerId, step: 'distribute', data: { pool: revealed } })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'distribute') return
    const { pool } = prompt.data as { pool: CardId[] }
    const remaining = pool.filter((cardId) => host.state.zones.processingArea.includes(cardId))
    if (remaining.length === 0) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: CHENGHAO, ownerId, step: 'assign', data: { pool: remaining },
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: `【称好】：将一张牌分配给一名角色（还剩${remaining.length}张）`, timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'assign') return
    const { pool } = resolution.data as { pool: CardId[] }
    const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
    const [cardId, ...rest] = pool
    const target = targetId ? playerOf(host.state, targetId) : undefined
    if (target?.alive && host.state.zones.processingArea.includes(cardId)) {
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: targetId! })
      host.dispatch('GainCard', { playerId: targetId, cardIds: [cardId], reason: CHENGHAO, revealed: true }, { targetId, cardIds: [cardId] })
    }
    if (rest.length === 0) return
    host.queueSkill({ skillId: CHENGHAO, ownerId, step: 'distribute', data: { pool: rest } })
  },
})

registerSkillRuntime({
  id: YINSHI,
  preventsDamage(state, ownerId, side, context) {
    if (side !== 'target') return false
    const current = seals(state)
    if (current.long === ownerId || current.feng === ownerId) return false
    const owner = playerOf(state, ownerId)
    if (owner?.zones.equipment.armor) return false
    if (context.nature !== 'normal') return true
    return context.cardId ? state.cards[context.cardId]?.category === 'trick' : false
  },
})

export const SIMAHUI: CharacterDefinition = {
  id: 'simahui',
  name: '司马徽',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: JIANJIE, name: '荐杰', description: '游戏第一回合开始时，依次选择两名其他角色获得龙印（视为拥有火计）与凤印（视为拥有连环）；同时持有两印可以移除两印发动业炎；出牌阶段限一次（不能在第一回合发动）可以转移印，持印角色死亡时司马徽可以转移其印。' },
    { id: CHENGHAO, name: '称好', description: '一名角色受到属性伤害后，若这是本次连环传导的起点，X=当前会向下传导的连环角色数，司马徽观看牌堆顶X+1张牌，任意分配给任意角色。' },
    { id: YINSHI, name: '隐士', description: '锁定技，司马徽没有龙印、没有凤印、且没有装备防具时，防止自己受到的属性伤害和锦囊牌造成的伤害。' },
  ],
}
