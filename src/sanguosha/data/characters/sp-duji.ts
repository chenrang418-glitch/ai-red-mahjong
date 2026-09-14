import { moveCard } from '../../engine/zones'
import { resumeTargetDamagePrevention } from '../../engine/damage'
import { registerSkillRuntime, replaceTemporarySkills } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 杜畿（官方《三国杀：一将成名》当前页面版本，非界限突破/国战版）。
 *
 * 【安东】：杜畿即将受到其他角色A造成的伤害时，A选择一项：防止此伤害，
 *          然后A本回合弃牌阶段红桃手牌不计入手牌上限；或者杜畿观看A的
 *          全部手牌，若有红桃，杜畿获得其中所有红桃（伤害正常结算）。
 * 【应势】：出牌阶段开始时，若全场没有任何角色拥有"酬"，杜畿可以将所有
 *          红桃置于一名其他角色武将牌旁，称为"酬"；任意角色使用【杀】
 *          对拥有"酬"的角色造成伤害后，可以获得1张"酬"。
 */

const ANDONG = 'andong'
const ANDONG_EXEMPT = 'andong-exempt'
const YINGSHI = 'yingshi'
const CHOU_PILE = 'chou'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: ANDONG,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (!context.sourceId || context.sourceId === ownerId) return false
    /*
     * 场上已经有人处于濒死结算时不再发起这次询问：安东的发问要挂起到
     * `queueSkill` 的下一个"干净"时刻才会真正问出去，如果那一刻恰好落在
     * 一场不相干的濒死求桃流程中间，来源侧因这次发问而失去的手牌可能
     * 正是濒死流程早先就替某个人算好、即将拿来读的救援牌，导致后续响应
     * 校验失败。安东不是锁定技，压测撞到过这个真实的交叉时序问题，
     * 这里直接让位——伤害照常结算，不强行插这次选择。
     */
    if (host.state.dying) return false
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, context.sourceId)
    if (!owner?.alive || !source?.alive) return false
    host.queueSkill({ skillId: ANDONG, ownerId, step: 'ask', data: { sourceId: context.sourceId } })
    return true
  },
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { sourceId } = prompt.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive || !host.state.pendingTargetDamage) {
      resumeTargetDamagePrevention(host as never, false)
      return
    }
    host.askSkill({
      skillId: ANDONG, ownerId, step: 'ask', data: { sourceId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: sourceId,
        prompt: '【安东】：请选择', timeoutMs: 20_000, optional: false,
        options: [
          { id: 'prevent', label: '防止此伤害，本回合弃牌阶段你的红桃手牌不计入手牌上限' },
          { id: 'watch', label: `令${owner.nickname}观看你的全部手牌并获得其中所有红桃` },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { sourceId } = resolution.data as { sourceId: PlayerId }
    const owner = playerOf(host.state, ownerId)
    const source = playerOf(host.state, sourceId)
    if (!owner?.alive || !source?.alive) { resumeTargetDamagePrevention(host as never, false); return }
    const optionId = (response.payload as { optionId?: string }).optionId
    if (optionId === 'prevent') {
      resumeTargetDamagePrevention(host as never, true, ANDONG)
      host.state.andongExempt = { playerId: sourceId, turnNumber: host.state.turnNumber }
      replaceTemporarySkills(host.state, sourceId, ANDONG, [ANDONG_EXEMPT])
      host.dispatch('SkillActivated', { skillId: ANDONG, skillName: '安东', playerId: ownerId, targetId: sourceId, logText: `${source.nickname}选择防止这次伤害` }, { sourceId: ownerId, targetId: sourceId })
      return
    }
    resumeTargetDamagePrevention(host as never, false)
    const hearts = source.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === 'heart')
    if (hearts.length > 0) {
      for (const cardId of hearts) moveCard(host.state, cardId, { kind: 'hand', playerId: sourceId }, { kind: 'hand', playerId: ownerId })
      host.dispatch('LoseCard', { playerId: sourceId, cardIds: hearts, reason: ANDONG }, { sourceId, cardIds: hearts })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: hearts, reason: ANDONG }, { sourceId, targetId: ownerId, cardIds: hearts })
    }
    host.dispatch('SkillActivated', { skillId: ANDONG, skillName: '安东', playerId: ownerId, targetId: sourceId, logText: `${owner.nickname}发动【安东】` }, { sourceId: ownerId, targetId: sourceId })
  },
})

registerSkillRuntime({
  id: ANDONG_EXEMPT,
  handLimitExempt(state, playerId, cardId) {
    const exempt = state.andongExempt
    if (!exempt || exempt.playerId !== playerId || exempt.turnNumber !== state.turnNumber) return false
    return state.cards[cardId]?.suit === 'heart'
  },
})

registerSkillRuntime({
  id: YINGSHI,
  triggers: [
    {
      event: 'PhaseStart',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
        if (payload.phase !== 'play' || payload.playerId !== ownerId) return
        const anyChou = host.state.players.some((candidate) => (candidate.characterPiles?.[CHOU_PILE] ?? []).length > 0)
        if (anyChou) return
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const hearts = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === 'heart')
        if (hearts.length === 0) return
        const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
        if (candidateIds.length === 0) return
        host.queueSkill({ skillId: YINGSHI, ownerId, step: 'ask', data: {} })
      },
    },
    {
      event: 'Damaged',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardName?: string }
        if (payload.cardName !== '杀') return
        const targetId = context.event.targetId
        const sourceId = context.event.sourceId
        if (!targetId || !sourceId) return
        const target = playerOf(host.state, targetId)
        const pile = target?.characterPiles?.[CHOU_PILE] ?? []
        if (pile.length === 0) return
        host.queueSkill({ skillId: YINGSHI, ownerId, step: 'gain-chou', data: { sourceId, holderId: targetId } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'ask') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: YINGSHI, ownerId, step: 'ask', data: {},
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【应势】：是否将所有红桃置于一名其他角色武将牌旁，称为"酬"？', timeoutMs: 20_000, optional: true,
          candidateIds, min: 0, max: 1,
        }),
      })
      return
    }
    if (prompt.step === 'gain-chou') {
      const { sourceId } = prompt.data as { sourceId: PlayerId }
      const source = playerOf(host.state, sourceId)
      if (!source?.alive) return
      host.askSkill({
        skillId: YINGSHI, ownerId, step: 'gain-chou', data: prompt.data,
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: sourceId,
          prompt: '【应势】：是否获得1张"酬"？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '获得' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'ask') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const owner = playerOf(host.state, ownerId)
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!owner?.alive || !target?.alive) return
      const hearts = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.suit === 'heart')
      if (hearts.length === 0) return
      for (const cardId of hearts) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: targetId, pile: CHOU_PILE })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: hearts, reason: YINGSHI }, { sourceId: ownerId, cardIds: hearts })
      host.dispatch('SkillActivated', { skillId: YINGSHI, skillName: '应势', playerId: ownerId, targetId, logText: `${owner.nickname}发动【应势】` }, { sourceId: ownerId, targetId })
      return
    }
    if (resolution.step === 'gain-chou') {
      const { sourceId, holderId } = resolution.data as { sourceId: PlayerId; holderId: PlayerId }
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const holder = playerOf(host.state, holderId)
      const pile = holder?.characterPiles?.[CHOU_PILE] ?? []
      if (pile.length === 0) return
      const cardId = pile[0]
      moveCard(host.state, cardId, { kind: 'characterPile', playerId: holderId, pile: CHOU_PILE }, { kind: 'hand', playerId: sourceId })
      host.dispatch('GainCard', { playerId: sourceId, cardIds: [cardId], reason: YINGSHI }, { targetId: sourceId, cardIds: [cardId] })
    }
  },
})

export const DUJI: CharacterDefinition = {
  id: 'duji',
  name: '杜畿',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    { id: ANDONG, name: '安东', description: '你即将受到其他角色造成的伤害时，来源可以选择：防止此伤害，然后其本回合弃牌阶段红桃手牌不计入手牌上限；或者你观看其全部手牌，获得其中所有红桃。' },
    { id: YINGSHI, name: '应势', description: '出牌阶段开始时，若全场没有任何角色拥有"酬"，你可以将所有红桃置于一名其他角色武将牌旁，称为"酬"；任意角色使用【杀】对拥有"酬"的角色造成伤害后，可以获得1张"酬"。' },
  ],
}
