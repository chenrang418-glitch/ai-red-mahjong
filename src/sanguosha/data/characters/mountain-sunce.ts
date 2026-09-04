import { drawCards } from '../../engine/draw'
import { loseMaxHp } from '../../engine/hp'
import {
  canPindian, claimPindianCards, finishPindianSettlement, registerPindianContinuation, startPindian,
} from '../../engine/pindian'
import type { ChooseOptionRequest } from '../../engine/requests'
import { effectiveCardColor, grantSkill, registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { YINGHUN } from './forest-sunjian'
import { effectiveKingdomOf } from '../../engine/huashen'
import type { CharacterDefinition } from './types'

/** 山包·孙策，经典首版【激昂】【魂姿】【制霸】。 */
export const JIANG = 'jiang'
export const HUNZI = 'hunzi'
export const ZHIBA = 'zhiba'

const YINGZI = 'yingzi'
const ZHIBA_TAG = 'zhiba'
const ZHIBA_ACTION = 'zhiba-challenge'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function isRedSlash(state: SanguoshaState, sourceId: PlayerId | undefined, cardId: CardId | undefined, cardName: string | undefined): boolean {
  if (!sourceId || !cardId || cardName !== '杀') return false
  const card = state.cards[cardId]
  // 纯虚拟杀没有实体花色，不触发激昂；转化技的实体载体按有效花色判断。
  return Boolean(card && !card.virtual && effectiveCardColor(state, sourceId, cardId) === 'red')
}

function queueJiang(host: SkillHost, ownerId: PlayerId): void {
  host.queueSkill({ skillId: JIANG, ownerId, step: 'ask', data: {} })
}

registerSkillRuntime({
  id: JIANG,
  triggers: [
    {
      event: 'TargetSpecified',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string }
        if (context.event.sourceId !== ownerId) return
        if (payload.cardName !== '决斗' && !isRedSlash(host.state, ownerId, payload.cardId, payload.cardName)) return
        queueJiang(host, ownerId)
      },
    },
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; targetId?: PlayerId }
        if (payload.targetId !== ownerId) return
        if (payload.cardName !== '决斗'
          && !isRedSlash(host.state, context.event.sourceId, payload.cardId, payload.cardName)) return
        queueJiang(host, ownerId)
      },
    },
  ],
  startQueued(host, ownerId) {
    if (!playerOf(host.state, ownerId)?.alive) return
    host.askSkill({
      skillId: JIANG,
      ownerId,
      step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: '发动【激昂】摸一张牌？',
        timeoutMs: 20_000,
        optional: true,
        options: [{ id: 'yes', label: '发动激昂' }, { id: 'no', label: '放弃' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask' || (response.payload as { optionId?: string }).optionId !== 'yes') return
    if (!playerOf(host.state, ownerId)?.alive) return
    drawCards(host.state, host.rng, ownerId, 1, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', {
      playerId: ownerId, skillId: JIANG, skillName: '激昂', logText: `${playerOf(host.state, ownerId)?.nickname ?? ''}发动【激昂】，摸一张牌`,
    }, { sourceId: ownerId })
  },
})

registerSkillRuntime({
  id: HUNZI,
  awakening: {
    phase: 'prepare',
    ready: (state, ownerId) => playerOf(state, ownerId)?.hp === 1,
    invoke(host, ownerId) {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      loseMaxHp(host as never, ownerId, 1, '魂姿')
      grantSkill(host.state, ownerId, YINGZI)
      grantSkill(host.state, ownerId, YINGHUN)
      host.dispatch('SkillActivated', {
        playerId: ownerId,
        skillId: HUNZI,
        skillName: '魂姿',
        grantedSkills: [YINGZI, YINGHUN],
        logText: `${owner.nickname}觉醒【魂姿】，减1点体力上限并获得【英姿】和【英魂】`,
      }, { sourceId: ownerId })
    },
  },
})

function zhibaUsageKey(lordId: PlayerId): string {
  return `${ZHIBA}:${lordId}`
}

function isWu(state: SanguoshaState, playerId: PlayerId): boolean {
  return effectiveKingdomOf(state, playerId) === 'wu'
}

function canChallenge(state: SanguoshaState, lordId: PlayerId, actorId: PlayerId): boolean {
  const lord = playerOf(state, lordId)
  const actor = playerOf(state, actorId)
  return Boolean(
    lord?.alive && lord.identity === 'lord'
    && actor?.alive && actorId !== lordId && isWu(state, actorId)
    && canPindian(state, lordId) && canPindian(state, actorId)
    && !usedThisTurn(state, actorId, zhibaUsageKey(lordId)),
  )
}

function beginZhiba(host: SkillHost, lordId: PlayerId, actorId: PlayerId): void {
  if (!canPindian(host.state, lordId) || !canPindian(host.state, actorId)) return
  startPindian(host, {
    id: `zhiba-${host.state.seq}`,
    initiatorId: actorId,
    opponentId: lordId,
    reason: ZHIBA,
    continuationTag: ZHIBA_TAG,
    data: { lordId },
  })
}

registerSkillRuntime({
  id: ZHIBA,
  lord: true,
  grantsPlayActions(state, ownerId, actorId) {
    if (!canChallenge(state, ownerId, actorId)) return []
    return [{ id: `${ZHIBA_ACTION}:${ownerId}`, label: `发动【制霸】：与${playerOf(state, ownerId)?.nickname ?? '主公'}拼点` }]
  },
  invokeGrantedAction(host, ownerId, actorId, actionId) {
    if (actionId !== `${ZHIBA_ACTION}:${ownerId}` || !canChallenge(host.state, ownerId, actorId)) return
    // 点击授权动作即视为本出牌阶段已经发起过；主公拒绝也不能反复挑战。
    markUsedThisTurn(host.state, actorId, zhibaUsageKey(ownerId))
    const lord = playerOf(host.state, ownerId)
    if (!lord?.awakenedSkills?.includes(HUNZI)) {
      beginZhiba(host, ownerId, actorId)
      return
    }
    host.askSkill({
      skillId: ZHIBA,
      ownerId,
      step: 'accept',
      data: { actorId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `【制霸】：是否接受${playerOf(host.state, actorId)?.nickname ?? '吴势力角色'}的拼点？`,
        timeoutMs: 20_000,
        optional: false,
        options: [{ id: 'yes', label: '接受拼点' }, { id: 'no', label: '拒绝' }],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'accept') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') return
      const actorId = resolution.data.actorId as PlayerId
      if (!playerOf(host.state, ownerId)?.alive || !playerOf(host.state, actorId)?.alive) return
      beginZhiba(host, ownerId, actorId)
      return
    }
    if (resolution.step !== 'claim') return
    const settlementId = resolution.data.settlementId as string
    if (host.state.pindianSettlement?.id !== settlementId) return
    if ((response.payload as { optionId?: string }).optionId === 'yes') {
      claimPindianCards(host as never, ownerId, [...host.state.pindianSettlement.cardIds])
    } else {
      finishPindianSettlement(host as never)
    }
  },
})

registerPindianContinuation(ZHIBA_TAG, (host, result) => {
  // 挑战者赢时两张牌照常弃置；主公赢或平局时，主公可以获得两张拼点牌。
  if (result.outcome === 'initiator-win') return
  const lordId = result.opponentId
  const lord = playerOf(host.state, lordId)
  const settlement = host.state.pindianSettlement
  if (!lord?.alive || !settlement) return
  const skillHost = host as unknown as SkillHost
  skillHost.askSkill({
    skillId: ZHIBA,
    ownerId: lordId,
    step: 'claim',
    data: { settlementId: settlement.id },
    build: (requestId): ChooseOptionRequest => ({
      id: requestId,
      kind: 'choose-option',
      playerId: lordId,
      prompt: '【制霸】：是否获得双方的拼点牌？',
      timeoutMs: 20_000,
      optional: true,
      options: [{ id: 'yes', label: '获得拼点牌' }, { id: 'no', label: '放弃' }],
    }),
  })
  return 'defer-settlement'
})

export const SUNCE: CharacterDefinition = {
  id: 'sunce',
  name: '孙策',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'mountain',
  skills: [
    {
      id: JIANG,
      name: '激昂',
      description: '每当你使用（指定目标后）或成为一张红色【杀】或【决斗】的目标后，你可以摸一张牌。',
    },
    {
      id: HUNZI,
      name: '魂姿',
      description: '觉醒技。准备阶段，若你的体力值为1，你须减1点体力上限，然后获得【英姿】和【英魂】。',
    },
    {
      id: ZHIBA,
      name: '制霸',
      description: '主公技。其他吴势力角色的出牌阶段限一次，其可以与你拼点。若其没赢，你可以获得双方的拼点牌；你发动【魂姿】后，可以拒绝此拼点。',
    },
    { id: YINGZI, name: '英姿', description: '摸牌阶段，你可以多摸一张牌。', granted: true },
    { id: YINGHUN, name: '英魂', description: '准备阶段，若你已受伤，你可以令一名其他角色摸X弃1，或摸1弃X（X为你已损失的体力值）。', granted: true },
  ],
}
