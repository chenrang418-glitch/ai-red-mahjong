import { moveCard } from '../../engine/zones'
import { revealTopCards } from '../../engine/draw'
import { resolveDamage } from '../../engine/damage'
import { loseHp } from '../../engine/hp'
import { canTarget } from '../../engine/distance'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 诸葛恪（三国杀 OL 经典身份 SP）。
 *
 * 【傲才】：诸葛恪回合外需要使用/打出一张基本牌时，观看牌堆顶 X 张牌
 *          （有手牌 X=2，无手牌 X=4），若其中有当前请求下合法的基本牌，
 *          放入手牌以便照常使用/打出，其余按原始相对顺序放回牌堆顶。
 *          范围限定在【闪】（成为杀的目标时）和【桃】（进入濒死时）这两个
 *          最常见的场景，不覆盖决斗/南蛮等要求连续打出【杀】的场景——这里
 *          按公开亮出实现（`revealTopCards`），比“只有诸葛恪自己看到”的
 *          隐藏信息要求宽松一些，作为已知简化记录。
 * 【黩武】：诸葛恪选择攻击范围内一名其他角色 A，X=A当前HP，弃置恰好X张
 *          合法牌，对A造成1点伤害；若A因此进入濒死且濒死结算后仍然存活，
 *          诸葛恪失去1点体力，且本回合【黩武】失效。
 */

const AOCAI = 'aocai'
const DUWU = 'duwu'
const DUWU_DISABLED_MARK = 'duwu-disabled-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function tryAocai(host: SkillHost, ownerId: PlayerId, requiredName: string): void {
  if (host.state.currentPlayerId === ownerId) return
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const x = owner.zones.hand.length > 0 ? 2 : 4
  const revealed = revealTopCards(host.state, host.rng, x, AOCAI, (name, payload) => { host.dispatch(name, payload) })
  if (revealed.length === 0) return
  const matchIndex = revealed.findIndex((cardId) => host.state.cards[cardId]?.name === requiredName)
  if (matchIndex >= 0) {
    const [matched] = revealed.splice(matchIndex, 1)
    moveCard(host.state, matched, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [matched], reason: AOCAI }, { targetId: ownerId, cardIds: [matched] })
    host.dispatch('SkillActivated', { skillId: AOCAI, skillName: '傲才', playerId: ownerId, logText: `${owner.nickname}发动【傲才】，获得【${requiredName}】` }, { sourceId: ownerId })
  }
  for (let index = revealed.length - 1; index >= 0; index -= 1) {
    moveCard(host.state, revealed[index], { kind: 'processingArea' }, { kind: 'drawPile' }, { toTop: true })
  }
}

registerSkillRuntime({
  id: AOCAI,
  triggers: [
    {
      event: 'TargetConfirmed',
      handle(host, ownerId, context) {
        const resolution = host.state.cardResolution
        if (resolution?.kind !== 'slash' || context.event.targetId !== ownerId || resolution.targetId !== ownerId) return
        tryAocai(host, ownerId, '闪')
      },
    },
    {
      event: 'EnterDying',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { playerId?: PlayerId }
        if (payload.playerId !== ownerId) return
        tryAocai(host, ownerId, '桃')
      },
    },
  ],
})

registerSkillRuntime({
  id: DUWU,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.marks[DUWU_DISABLED_MARK] === state.turnNumber) return []
    const affordable = state.players.some((candidate) => candidate.alive && candidate.id !== ownerId
      && canTarget(state, ownerId, candidate.id) && owner.zones.hand.length >= candidate.hp)
    if (!affordable) return []
    return [{ id: DUWU, label: '黩武：选择攻击范围内一名其他角色' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== DUWU) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.marks[DUWU_DISABLED_MARK] === host.state.turnNumber) return
    const candidateIds = host.state.players
      .filter((candidate) => candidate.alive && candidate.id !== ownerId
        && canTarget(host.state, ownerId, candidate.id) && owner.zones.hand.length >= candidate.hp)
      .map((candidate) => candidate.id)
    if (candidateIds.length === 0) return
    host.askSkill({
      skillId: DUWU, ownerId, step: 'target',
      build: (requestId) => ({
        id: requestId, kind: 'choose-targets' as const, playerId: ownerId,
        prompt: '【黩武】：选择攻击范围内一名其他角色', timeoutMs: 20_000, optional: false, candidateIds, min: 1, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!target?.alive) return
      const x = target.hp
      if (owner.zones.hand.length < x) return
      if (x === 0) {
        finishDuwu(host, ownerId, targetId)
        return
      }
      host.askSkill({
        skillId: DUWU, ownerId, step: 'discard', data: { targetId, x },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【黩武】：弃置恰好${x}张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: x, max: x,
        }),
      })
      return
    }

    if (resolution.step === 'discard') {
      const { targetId, x } = resolution.data as { targetId: PlayerId; x: number }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      if (valid.length !== x || !playerOf(host.state, targetId)?.alive) return
      for (const cardId of valid) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: valid, reason: DUWU }, { sourceId: ownerId, cardIds: valid })
      finishDuwu(host, ownerId, targetId)
    }
  },
})

function finishDuwu(host: SkillHost, ownerId: PlayerId, targetId: PlayerId): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  host.dispatch('SkillActivated', { skillId: DUWU, skillName: '黩武', playerId: ownerId, targetId, logText: `${owner.nickname}发动【黩武】` }, { sourceId: ownerId, targetId })
  resolveDamage(host as never, { sourceId: ownerId, targetId, amount: 1, nature: 'normal', cardName: null })
  host.state.pendingDuwu ??= {}
  if (host.state.dying?.playerId === targetId) host.state.pendingDuwu[ownerId] = targetId
  else delete host.state.pendingDuwu[ownerId]
}

registerSkillRuntime({
  id: `${DUWU}-tracker`,
  triggers: [{
    event: 'QuitDying',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId }
      if (host.state.pendingDuwu?.[ownerId] !== payload.playerId || !payload.playerId) return
      delete host.state.pendingDuwu![ownerId]
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      owner.marks[DUWU_DISABLED_MARK] = host.state.turnNumber
      loseHp(host as never, ownerId, 1, DUWU)
      host.dispatch('SkillActivated', { skillId: DUWU, skillName: '黩武', playerId: ownerId, logText: `${owner.nickname}的目标濒死后存活，【黩武】反噬` }, { sourceId: ownerId })
    },
  }],
})

export const ZHUGEKE: CharacterDefinition = {
  id: 'zhugeke',
  name: '诸葛恪',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: AOCAI, name: '傲才', description: '诸葛恪回合外需要使用/打出一张基本牌时，观看牌堆顶X张牌（有手牌X=2，无手牌X=4），可以使用其中一张合法的基本牌。' },
    { id: DUWU, name: '黩武', description: '出牌阶段，诸葛恪选择攻击范围内一名其他角色A，X为A当前体力值，弃置恰好X张牌，然后对A造成1点伤害；若A因此进入濒死且结算后仍然存活，诸葛恪失去1点体力，且本回合【黩武】失效。' },
  ],
}
