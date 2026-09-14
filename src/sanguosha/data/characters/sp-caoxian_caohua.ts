import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { recover } from '../../engine/recover'
import { applyWineEffect } from '../../engine/virtual-wine'
import { registerSkillRuntime, replaceTemporarySkills, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 曹宪曹华（三国杀 OL 经典身份 SP，姊妹合体武将）。
 *
 * 【化木】：使用一张手牌后，若其颜色与本回合上一张使用牌的颜色不同，
 *          且这张牌结算后仍在弃牌堆，可以将其置于自己武将牌上（黑色称
 *          【灵杉】，红色称【玉树】）。
 * 【前盟】：锁定技，你的灵杉数量或玉树数量发生变化后，若两者相等或其中
 *          一项为0，你摸1张。
 * 【良缘】：每轮限一次，将所有灵杉当【酒】使用；每轮限一次，将所有玉树
 *          当【桃】对自己使用（两个分支各限一次，只在你的出牌阶段发动）。
 * 【羁肆】：限定技，准备阶段，选择一名其他角色，将你本局曾实际发动过的
 *          【化木】/【良缘】中的一个技能授予其永久拥有；然后你弃置所有
 *          手牌，视为对其使用一张【杀】。
 *
 * 已知简化：良缘只在曹宪曹华自己的出牌阶段发动（酒按出牌阶段效果结算，
 * 桃对自己回复1点体力），暂不接入濒死求桃/无懈响应等其它合法窗口。
 */

const HUAMU = 'huamu'
const QIANMENG = 'qianmeng'
const LIANGYUAN = 'liangyuan'
const JISI = 'jisi'
const LINGSHAN_PILE = 'lingshan'
const YUSHU_PILE = 'yushu'
const GRANTABLE = [HUAMU, LIANGYUAN]

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function checkQianmeng(host: SkillHost, ownerId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const lingshan = (owner.characterPiles?.[LINGSHAN_PILE] ?? []).length
  const yushu = (owner.characterPiles?.[YUSHU_PILE] ?? []).length
  if (lingshan !== yushu && lingshan !== 0 && yushu !== 0) return
  drawCards(host.state, host.rng, ownerId, 1, (n, p) => { host.dispatch(n, p) })
  host.dispatch('SkillActivated', { skillId: QIANMENG, skillName: '前盟', playerId: ownerId, logText: `${owner.nickname}发动【前盟】` }, { sourceId: ownerId })
}

function recordActivated(host: SkillHost, ownerId: PlayerId, skillId: string): void {
  host.state.caoxianActivated ??= {}
  const list = host.state.caoxianActivated[ownerId] ?? []
  if (!list.includes(skillId)) host.state.caoxianActivated[ownerId] = [...list, skillId]
}

registerSkillRuntime({
  id: HUAMU,
  triggers: [
    {
      event: 'CardUsed',
      handle(host, ownerId, context) {
        if (context.event.sourceId !== ownerId) return
        const payload = context.event.payload as { cardId?: CardId; virtual?: boolean }
        if (payload.virtual || !payload.cardId) return
        const card = host.state.cards[payload.cardId]
        if (!card?.color) return
        const owner = playerOf(host.state, ownerId)
        if (!owner) return
        const hasPrev = owner.marks['huamu-turn'] === host.state.turnNumber
        const prevColorCode = hasPrev ? owner.marks['huamu-prev-color'] : undefined
        owner.marks['huamu-turn'] = host.state.turnNumber
        owner.marks['huamu-prev-color'] = card.color === 'red' ? 1 : 2
        if (prevColorCode === undefined) return
        const prevColor = prevColorCode === 1 ? 'red' : 'black'
        if (prevColor === card.color) return
        host.state.huamuPending = { ownerId, cardId: payload.cardId, color: card.color }
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const pending = host.state.huamuPending
        if (!pending || pending.ownerId !== ownerId || context.event.sourceId !== ownerId) return
        host.state.huamuPending = undefined
        if (!host.state.zones.discardPile.includes(pending.cardId)) return
        host.queueSkill({ skillId: HUAMU, ownerId, step: 'ask', data: pending })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    const { cardId } = prompt.data as { cardId: CardId; color: 'red' | 'black' }
    if (!host.state.zones.discardPile.includes(cardId)) return
    host.askSkill({
      skillId: HUAMU, ownerId, step: 'ask', data: prompt.data,
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【化木】：是否将这张牌置于你的武将牌上？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    const { cardId, color } = resolution.data as { cardId: CardId; color: 'red' | 'black' }
    if ((response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!host.state.zones.discardPile.includes(cardId)) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const pile = color === 'black' ? LINGSHAN_PILE : YUSHU_PILE
    moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile })
    host.dispatch('SkillActivated', { skillId: HUAMU, skillName: '化木', playerId: ownerId, logText: `${owner.nickname}发动【化木】` }, { sourceId: ownerId })
    recordActivated(host, ownerId, HUAMU)
    checkQianmeng(host, ownerId)
  },
})

registerSkillRuntime({ id: QIANMENG })

function liangyuanState(host: SkillHost, ownerId: PlayerId): { round: number; wineUsed: boolean; peachUsed: boolean } {
  const current = host.state.liangyuanRound?.[ownerId]
  if (current && current.round === host.state.roundNumber) return current
  const fresh = { round: host.state.roundNumber, wineUsed: false, peachUsed: false }
  host.state.liangyuanRound ??= {}
  host.state.liangyuanRound[ownerId] = fresh
  return fresh
}

registerSkillRuntime({
  id: LIANGYUAN,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'play' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const state = liangyuanState(host, ownerId)
      const lingshan = owner.characterPiles?.[LINGSHAN_PILE] ?? []
      const yushu = owner.characterPiles?.[YUSHU_PILE] ?? []
      if (!state.wineUsed && lingshan.length > 0) host.queueSkill({ skillId: LIANGYUAN, ownerId, step: 'ask-wine', data: {} })
      else if (!state.peachUsed && yushu.length > 0) host.queueSkill({ skillId: LIANGYUAN, ownerId, step: 'ask-peach', data: {} })
    },
  }],
  startQueued(host, ownerId, prompt) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (prompt.step === 'ask-wine') {
      host.askSkill({
        skillId: LIANGYUAN, ownerId, step: 'ask-wine', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【良缘】：是否将所有灵杉当【酒】使用？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    } else if (prompt.step === 'ask-peach') {
      host.askSkill({
        skillId: LIANGYUAN, ownerId, step: 'ask-peach', data: {},
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【良缘】：是否将所有玉树当【桃】对自己使用？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '不发动' }],
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
    if (resolution.step === 'ask-wine') {
      const state = liangyuanState(host, ownerId)
      state.wineUsed = true
      if (accepted) {
        const cardIds = [...(owner.characterPiles?.[LINGSHAN_PILE] ?? [])]
        if (cardIds.length > 0) {
          for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: LINGSHAN_PILE }, { kind: 'discardPile' })
          applyWineEffect(host)
          host.dispatch('SkillActivated', { skillId: LIANGYUAN, skillName: '良缘', playerId: ownerId, logText: `${owner.nickname}将灵杉当【酒】发动【良缘】` }, { sourceId: ownerId })
          checkQianmeng(host, ownerId)
          recordActivated(host, ownerId, LIANGYUAN)
        }
      }
      const yushu = owner.characterPiles?.[YUSHU_PILE] ?? []
      if (!state.peachUsed && yushu.length > 0) host.queueSkill({ skillId: LIANGYUAN, ownerId, step: 'ask-peach', data: {} })
      return
    }
    if (resolution.step === 'ask-peach') {
      const state = liangyuanState(host, ownerId)
      state.peachUsed = true
      if (accepted) {
        const cardIds = [...(owner.characterPiles?.[YUSHU_PILE] ?? [])]
        if (cardIds.length > 0 && owner.hp < owner.maxHp) {
          for (const cardId of cardIds) moveCard(host.state, cardId, { kind: 'characterPile', playerId: ownerId, pile: YUSHU_PILE }, { kind: 'discardPile' })
          recover(host as never, ownerId, 1, ownerId)
          host.dispatch('SkillActivated', { skillId: LIANGYUAN, skillName: '良缘', playerId: ownerId, logText: `${owner.nickname}将玉树当【桃】发动【良缘】` }, { sourceId: ownerId })
          checkQianmeng(host, ownerId)
          recordActivated(host, ownerId, LIANGYUAN)
        }
      }
    }
  },
})

registerSkillRuntime({
  id: JISI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { phase?: string; playerId?: PlayerId }
      if (payload.phase !== 'prepare' || payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || owner.usedLimitedSkills.includes(JISI)) return
      const eligible = (host.state.caoxianActivated?.[ownerId] ?? []).filter((skillId) => GRANTABLE.includes(skillId))
      if (eligible.length === 0) return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.queueSkill({ skillId: JISI, ownerId, step: 'pick-target', data: { eligible } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'pick-target') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(JISI)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: JISI, ownerId, step: 'pick-target', data: prompt.data,
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【羁肆】：选择一名其他角色', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(JISI)) return
    if (resolution.step === 'pick-target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      const { eligible } = resolution.data as { eligible: string[] }
      if (eligible.length === 0) return
      host.askSkill({
        skillId: JISI, ownerId, step: 'pick-skill', data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId, kind: 'choose-option', playerId: ownerId,
          prompt: '【羁肆】：选择授予其一个曾发动过的技能', timeoutMs: 20_000, optional: false,
          options: eligible.map((skillId) => ({ id: skillId, label: skillId === HUAMU ? '化木' : '良缘' })),
        }),
      })
      return
    }
    if (resolution.step === 'pick-skill') {
      const { targetId } = resolution.data as { targetId: PlayerId }
      const target = playerOf(host.state, targetId)
      const skillId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive || !skillId) return
      owner.usedLimitedSkills.push(JISI)
      replaceTemporarySkills(host.state, targetId, `${JISI}:${targetId}:${skillId}`, [skillId])
      host.dispatch('SkillActivated', { skillId: JISI, skillName: '羁肆', playerId: ownerId, targetId, logText: `${owner.nickname}发动【羁肆】` }, { sourceId: ownerId, targetId })
      if (owner.zones.hand.length > 0) {
        const discarded = [...owner.zones.hand]
        for (const cardId of discarded) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: discarded, reason: JISI }, { sourceId: ownerId, cardIds: discarded })
      }
      host.beginVirtualSlash({ sourceId: ownerId, targetId, sourceSkillId: JISI })
    }
  },
})

export const CAOXIAN_CAOHUA: CharacterDefinition = {
  id: 'caoxian_caohua',
  name: '曹宪曹华',
  kingdom: 'wei',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: HUAMU, name: '化木', description: '使用一张手牌后，若其颜色与本回合上一张使用牌的颜色不同，且这张牌结算后仍在弃牌堆，可以将其置于你的武将牌上（黑色为"灵杉"，红色为"玉树"）。' },
    { id: QIANMENG, name: '前盟', description: '锁定技，你的灵杉数量或玉树数量发生变化后，若两者相等或其中一项为0，你摸1张。' },
    { id: LIANGYUAN, name: '良缘', description: '你的出牌阶段限一次，将所有灵杉当【酒】使用；你的出牌阶段限一次，将所有玉树当【桃】对自己使用。' },
    { id: JISI, name: '羁肆', description: '限定技，准备阶段，选择一名其他角色，将你本局曾实际发动过的【化木】/【良缘】中的一个技能授予其永久拥有，然后弃置所有手牌，视为对其使用一张【杀】。' },
  ],
}
