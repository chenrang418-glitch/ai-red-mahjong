import {
  activateHuashen, gainRandomHuashen, huashenCharacter, huashenEligibleSkills, initializeHuashenOwner,
} from '../../engine/huashen'
import type { ChooseOptionRequest } from '../../engine/requests'
import { recheckZeroHpAfterSkillLoss, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

export const HUASHEN = 'huashen'
export const XINSHENG = 'xinsheng'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function askCharacter(host: SkillHost, ownerId: PlayerId, initial: boolean): void {
  const owner = host.state.huashen?.owners[ownerId]
  if (!owner?.characterIds.length) return
  host.askSkill({ skillId: HUASHEN, ownerId, step: 'character', data: { initial }, build: (requestId): ChooseOptionRequest => ({
    id: requestId, kind: 'choose-option', playerId: ownerId, prompt: initial ? '【化身】：选择开局亮出的化身' : '【化身】：选择要亮出的化身',
    timeoutMs: 30_000, optional: false,
    options: owner.characterIds.map((id) => ({ id, label: huashenCharacter(id)?.name ?? id })),
  }) })
}

registerSkillRuntime({
  id: HUASHEN,
  onGameStart(host, ownerId) {
    initializeHuashenOwner(host, ownerId)
    host.queueSkill({ skillId: HUASHEN, ownerId, step: 'initial', data: {} })
  },
  triggers: [
    { event: 'TurnStart', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId !== ownerId || !host.state.huashen?.owners[ownerId]?.activeCharacterId) return
      host.queueSkill({ skillId: HUASHEN, ownerId, step: 'switch', data: { timing: 'turn-start' } })
    } },
    { event: 'TurnEnd', handle(host, ownerId, context) {
      const playerId = (context.event.payload as { playerId?: PlayerId }).playerId
      if (playerId !== ownerId || !host.state.huashen?.owners[ownerId]?.activeCharacterId) return
      host.queueSkill({ skillId: HUASHEN, ownerId, step: 'switch', data: { timing: 'turn-end' } })
    } },
  ],
  startQueued(host, ownerId, prompt) {
    if (!playerOf(host.state, ownerId)?.alive || playerOf(host.state, ownerId)?.characterSkillsDisabled) return
    if (prompt.step === 'initial') {
      askCharacter(host, ownerId, true)
      return
    }
    const timing = prompt.data.timing === 'turn-start' ? '回合开始时' : '回合结束后'
    host.askSkill({ skillId: HUASHEN, ownerId, step: 'switch', build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: `${timing}是否更换【化身】或重新选择当前化身技能？`,
      timeoutMs: 20_000, optional: true, options: [{ id: 'yes', label: '更换化身' }, { id: 'no', label: '保持当前化身' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'switch') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') askCharacter(host, ownerId, false)
      return
    }
    if (resolution.step === 'character') {
      const characterId = (response.payload as { optionId?: string }).optionId
      const owner = host.state.huashen?.owners[ownerId]
      if (!characterId || !owner?.characterIds.includes(characterId)) return
      const skills = huashenEligibleSkills(characterId)
      if (!skills.length) return
      host.askSkill({ skillId: HUASHEN, ownerId, step: 'skill', data: { characterId }, build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: `【化身】：选择从${huashenCharacter(characterId)?.name ?? characterId}获得的技能`, timeoutMs: 30_000,
        optional: false, options: skills.map((skill) => ({ id: skill.id, label: skill.name })),
      }) })
      return
    }
    if (resolution.step !== 'skill') return
    const characterId = resolution.data.characterId as string
    const skillId = (response.payload as { optionId?: string }).optionId
    if (!skillId || !activateHuashen(host.state, ownerId, characterId, skillId)) return
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: HUASHEN, skillName: '化身', activeCharacterId: characterId, activeSkillId: skillId,
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}亮出化身【${huashenCharacter(characterId)?.name ?? characterId}】，获得【${huashenEligibleSkills(characterId).find((skill) => skill.id === skillId)?.name ?? skillId}】`,
    }, { sourceId: ownerId })
    recheckZeroHpAfterSkillLoss(host, ownerId)
  },
})

registerSkillRuntime({
  id: XINSHENG,
  triggers: [{ event: 'Damaged', handle(host, ownerId, context) {
    if (context.event.targetId !== ownerId) return
    const amount = Math.max(0, Math.trunc(Number(context.event.payload.amount ?? 0)))
    for (let point = 0; point < amount; point += 1) host.queueSkill({ skillId: XINSHENG, ownerId, step: 'ask', data: {} })
  } }],
  startQueued(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive || !host.state.huashen?.remainingCharacterIds.length) return
    host.askSkill({ skillId: XINSHENG, ownerId, step: 'ask', build: (requestId): ChooseOptionRequest => ({
      id: requestId, kind: 'choose-option', playerId: ownerId, prompt: '发动【新生】获得一张新的化身牌？', timeoutMs: 20_000,
      optional: true, options: [{ id: 'yes', label: '发动新生' }, { id: 'no', label: '放弃' }],
    }) })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    const characterId = gainRandomHuashen(host, ownerId)
    if (!characterId) return
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: XINSHENG, skillName: '新生', result: 'gain-huashen',
      // 新化身牌是隐藏信息，公开事件和日志不携带 characterId / name / skills。
      logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【新生】，获得一张新的化身牌`,
    }, { sourceId: ownerId })
  },
})

export const ZUOCI: CharacterDefinition = {
  id: 'zuoci', name: '左慈', kingdom: 'qun', gender: 'male', maxHp: 3, pack: 'mountain',
  skills: [
    { id: HUASHEN, name: '化身', description: '游戏开始时，你随机获得两张未加入游戏且拥有可声明普通技能的经典武将牌，亮出其中一张并获得其一项非限定技、非觉醒技、非主公技；你的性别和势力视为该化身。你的回合开始时及结束后可以更换。' },
    { id: XINSHENG, name: '新生', description: '每当你受到1点伤害后，你可以获得一张新的化身牌。' },
  ],
}
