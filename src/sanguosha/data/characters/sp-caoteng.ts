import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { restoreCharacter } from '../../engine/character-state'
import { effectiveKingdomOf } from '../../engine/huashen'
import { grantSkill, registerSkillRuntime, replaceTemporarySkill, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { Kingdom, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹腾（三国杀 OL 经典身份 SP）。
 *
 * 【拥族】：自己准备阶段，选择一名其他角色A，曹腾和A依次选择不同的一项：
 *          1.摸2张牌 2.回复1点体力 3.复原武将牌；若A势力与曹腾当前势力
 *          相同，还可选择：4.永久手牌上限+1 5.获得对应技能直到自己下个
 *          回合开始（魏→奸雄，群→天命）。
 * 【清流】：锁定技，游戏开始时选择群或魏作为势力；第一次进入濒死并被救回
 *          后，将势力切换为另一个（只触发一次）。
 */

const YONGZU = 'yongzu'
const QINGLIU = 'qingliu'
const MAXCARDS_MARK = 'yongzu-maxcards'
const GRANT_SOURCE = 'yongzu-grant'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: QINGLIU,
  onGameStart(host, ownerId) {
    host.askSkill({
      skillId: QINGLIU, ownerId, step: 'kingdom', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【清流】：选择你的势力', timeoutMs: 20_000, optional: false,
        options: [{ id: 'qun', label: '群' }, { id: 'wei', label: '魏' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'kingdom') return
    const owner = playerOf(host.state, ownerId)
    const optionId = (response.payload as { optionId?: string }).optionId as Kingdom | undefined
    if (!owner?.alive || !optionId) return
    owner.kingdomOverride = optionId
    host.dispatch('SkillActivated', { skillId: QINGLIU, skillName: '清流', playerId: ownerId, logText: `${owner.nickname}选择势力为${optionId === 'wei' ? '魏' : '群'}` }, { sourceId: ownerId })
  },
  triggers: [{
    event: 'QuitDying',
    handle(host, ownerId, context) {
      if (context.event.targetId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || (owner.dyingEntryCount ?? 0) !== 1) return
      const current = effectiveKingdomOf(host.state, ownerId)
      owner.kingdomOverride = current === 'wei' ? 'qun' : 'wei'
      host.dispatch('SkillActivated', { skillId: QINGLIU, skillName: '清流', playerId: ownerId, logText: `${owner.nickname}发动【清流】，势力切换为${owner.kingdomOverride === 'wei' ? '魏' : '群'}` }, { sourceId: ownerId })
    },
  }],
})

registerSkillRuntime({
  id: YONGZU,
  maxCardsBonus(state, ownerId) {
    return state.players.find((p) => p.id === ownerId)?.marks[MAXCARDS_MARK] ?? 0
  },
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: YONGZU, ownerId, step: 'pick-target', data: { candidateIds } })
    },
  }, {
    event: 'TurnStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (payload.playerId) replaceTemporarySkill(host.state, payload.playerId, `${GRANT_SOURCE}:${ownerId}`, null)
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const { candidateIds } = prompt.data as { candidateIds: PlayerId[] }
    host.askSkill({
      skillId: YONGZU, ownerId, step: 'pick-target', data: {},
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【拥族】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const sameKingdom = effectiveKingdomOf(host.state, targetId) === effectiveKingdomOf(host.state, ownerId)
      host.askSkill({
        skillId: YONGZU, ownerId, step: 'self-pick', data: { targetId, sameKingdom },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【拥族】：选择一项', timeoutMs: 20_000, optional: false,
          options: yongzuOptions(sameKingdom),
        }),
      })
      return
    }

    if (resolution.step === 'self-pick') {
      const { targetId, sameKingdom } = resolution.data as { targetId: PlayerId; sameKingdom: boolean }
      const picked = (response.payload as { optionId?: string }).optionId
      if (!picked) return
      applyYongzuOption(host, ownerId, picked)
      const target = playerOf(host.state, targetId)
      if (!target?.alive) return
      const remaining = yongzuOptions(sameKingdom).filter((option) => option.id !== picked)
      if (remaining.length === 0) return
      host.askSkill({
        skillId: YONGZU, ownerId, step: 'target-pick', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: targetId,
          prompt: '【拥族】：选择一项（不能与曹腾相同）', timeoutMs: 20_000, optional: false,
          options: remaining,
        }),
      })
      return
    }

    if (resolution.step === 'target-pick') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const picked = (response.payload as { optionId?: string }).optionId
      if (!picked) return
      applyYongzuOption(host, targetId, picked)
    }
  },
})

function yongzuOptions(sameKingdom: boolean): Array<{ id: string; label: string }> {
  const options = [
    { id: 'draw2', label: '摸2张牌' },
    { id: 'recover1', label: '回复1点体力' },
    { id: 'restore', label: '复原武将牌' },
  ]
  if (sameKingdom) options.push({ id: 'maxcards', label: '永久手牌上限+1' }, { id: 'grant', label: '获得对应技能直到自己下个回合开始' })
  return options
}

function applyYongzuOption(host: SkillHost, playerId: PlayerId, optionId: string): void {
  const player = playerOf(host.state, playerId)
  if (!player?.alive) return
  if (optionId === 'draw2') {
    drawCards(host.state, host.rng, playerId, 2, (name, payload) => { host.dispatch(name, payload) })
  } else if (optionId === 'recover1') {
    recover(host as never, playerId, 1, playerId)
  } else if (optionId === 'restore') {
    restoreCharacter(host, playerId, YONGZU)
  } else if (optionId === 'maxcards') {
    player.marks[MAXCARDS_MARK] = (player.marks[MAXCARDS_MARK] ?? 0) + 1
  } else if (optionId === 'grant') {
    const kingdom = effectiveKingdomOf(host.state, playerId)
    const skillId = kingdom === 'wei' ? 'jianxiong' : 'tianming'
    grantSkill(host.state, playerId, skillId)
    replaceTemporarySkill(host.state, playerId, `${GRANT_SOURCE}:${playerId}`, skillId)
  }
  host.dispatch('SkillActivated', { skillId: YONGZU, skillName: '拥族', playerId, logText: `${player.nickname}执行【拥族】选项` }, { sourceId: playerId })
}

export const CAOTENG: CharacterDefinition = {
  id: 'caoteng',
  name: '曹腾',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: YONGZU, name: '拥族', description: '自己准备阶段，选择一名其他角色，双方依次选择不同的一项：摸2张牌/回复1点体力/复原武将牌；同势力还可选择：永久手牌上限+1/获得奸雄或天命直到自己下个回合开始。' },
    { id: QINGLIU, name: '清流', description: '锁定技，游戏开始时选择群或魏作为势力；第一次进入濒死并被救回后，将势力切换为另一个。' },
  ],
}
