import { drawCards } from '../../engine/draw'
import type { ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost, type TargetedCardContext } from '../../engine/skills/runtime'
import { markUsedThisTurn, usedThisTurn } from '../../engine/turn-usage'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'
// 奶蛙的两个技能要动出牌阶段计数和临时挑战状态，单独一个文件，别和平头方块混在一起
import { NAIWA } from './entertainment-naiwa'
// 牛来的两个技能要动伤害转移和技能内的多步循环，同样单独一个文件
import { NIULAI_CHARACTER } from './entertainment-niulai'
// 许老板的三个技能要用私有牌区、阶段后结算和回合外发动窗口，同样单独一个文件
import { XULAOBAN } from './entertainment-xulaoban'
// 无亮要动身份与主公体力上限，同样单独一个文件
import { WULIANG } from './entertainment-wuliang'
import { YIXING } from './entertainment-yixing'
import { SHANSHUI } from './entertainment-shanshui'

/** 好友娱乐包：只放原创且技能完整可玩的武将。 */

const SHUAJIAN = 'shuajian'
const FADAI = 'fadai'
const SHUAJIAN_BLOCK = 'shuajian:block:'
const SHUAJIAN_DAMAGE = 'shuajian:damage:'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const player = state.players.find((candidate) => candidate.id === playerId)
  if (!player) throw new Error(`玩家不存在：${playerId}`)
  return player
}

function drawForSkill(host: SkillHost, playerId: PlayerId, count: number, reason: string): void {
  drawCards(host.state, host.rng, playerId, count, (name, payload) => {
    host.dispatch(name, { ...payload, reason })
  })
}

function canDirectlyTarget(cardName: string): boolean {
  // 全体效果牌不属于“主动指定该角色”，不能被【耍剑】的临时限制排除。
  return !['桃园结义', '南蛮入侵', '万箭齐发', '五谷丰登', '无中生有'].includes(cardName)
}

registerSkillRuntime({
  id: SHUAJIAN,
  activeActions(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner.alive || usedThisTurn(state, ownerId, SHUAJIAN)) return []
    if (!state.players.some((player) => player.alive && player.id !== ownerId)) return []
    return [{ id: `skill:${SHUAJIAN}`, label: '发动【耍剑】：邀请一名角色立即出招，或摸一张牌' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${SHUAJIAN}`) throw new Error('耍剑动作不匹配')
    markUsedThisTurn(host.state, ownerId, SHUAJIAN)
    const candidateIds = host.state.players
      .filter((player) => player.alive && player.id !== ownerId)
      .map((player) => player.id)
    host.askSkill({
      skillId: SHUAJIAN,
      ownerId,
      step: 'target',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId,
        kind: 'choose-targets',
        playerId: ownerId,
        prompt: '【耍剑】：选择一名其他角色',
        timeoutMs: 20_000,
        optional: false,
        candidateIds,
        min: 1,
        max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'target') {
      const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
      const target = host.state.players.find((player) => player.id === targetId)
      if (!target?.alive || targetId === ownerId) return
      host.askSkill({
        skillId: SHUAJIAN,
        ownerId,
        step: 'choice',
        data: { targetId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: targetId,
          prompt: '平头方块对你发动【耍剑】',
          timeoutMs: 20_000,
          optional: false,
          options: [
            { id: 'shuajian-attack', label: '出招：视为对平头方块使用【杀】' },
            { id: 'shuajian-ignore', label: '不理会：平头方块摸一张牌，本回合不能再对你使用牌' },
          ],
        }),
      })
      return
    }
    if (resolution.step !== 'choice') return
    const targetId = String(resolution.data.targetId ?? '')
    const optionId = (response.payload as { optionId: string }).optionId
    const target = host.state.players.find((player) => player.id === targetId)
    const owner = host.state.players.find((player) => player.id === ownerId)
    if (!target?.alive || !owner?.alive) return
    if (optionId === 'shuajian-ignore') {
      drawForSkill(host, ownerId, 1, SHUAJIAN)
      owner.marks[`${SHUAJIAN_BLOCK}${targetId}`] = host.state.turnNumber
      return
    }
    if (optionId !== 'shuajian-attack') throw new Error('耍剑选项非法')
    host.beginVirtualSlash({ sourceId: targetId, targetId: ownerId, sourceSkillId: SHUAJIAN })
  },
  prohibitsSourceTarget(state, ownerId, targetId, cardName) {
    if (!canDirectlyTarget(cardName) || state.currentPlayerId !== ownerId) return false
    return playerOf(state, ownerId).marks[`${SHUAJIAN_BLOCK}${targetId}`] === state.turnNumber
  },
  triggers: [
    {
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        const event = context.event
        if (event.targetId !== ownerId) return
        const cardId = String((event.payload as { cardId?: unknown }).cardId ?? '')
        const card = host.state.cards[cardId]
        if (!card?.virtual || card.sourceSkillId !== SHUAJIAN) return
        playerOf(host.state, ownerId).marks[`${SHUAJIAN_DAMAGE}${cardId}`] = 1
      },
    },
    {
      event: 'AfterCardUse',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: unknown; sourceSkillId?: unknown; targetIds?: unknown }
        if (payload.sourceSkillId !== SHUAJIAN || !Array.isArray(payload.targetIds) || !payload.targetIds.includes(ownerId)) return
        const cardId = String(payload.cardId ?? '')
        const owner = playerOf(host.state, ownerId)
        const damaged = owner.marks[`${SHUAJIAN_DAMAGE}${cardId}`] === 1
        delete owner.marks[`${SHUAJIAN_DAMAGE}${cardId}`]
        if (owner.alive) drawForSkill(host, ownerId, damaged ? 1 : 2, SHUAJIAN)
      },
    },
  ],
})

function isFadaiCard(context: TargetedCardContext): boolean {
  return context.cardName === '杀' || context.category === 'trick'
}

function revealTopCard(host: SkillHost): CardId | null {
  if (host.state.zones.drawPile.length === 0 && host.state.zones.discardPile.length > 0) {
    host.state.zones.drawPile.push(...host.rng.shuffle(host.state.zones.discardPile))
    host.state.zones.discardPile.length = 0
  }
  const cardId = host.state.zones.drawPile[0]
  if (!cardId) return null
  moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'processingArea' })
  host.dispatch('CardMove', { cardIds: [cardId], reason: 'fadai-reveal', revealed: true }, { cardIds: [cardId] })
  return cardId
}

registerSkillRuntime({
  id: FADAI,
  interceptTarget(host, ownerId, context) {
    if (context.sourceId === ownerId || !isFadaiCard(context) || usedThisTurn(host.state, ownerId, FADAI)) return false
    host.askSkill({
      skillId: FADAI,
      ownerId,
      step: 'invoke',
      data: { cardId: context.cardId },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId,
        kind: 'choose-option',
        playerId: ownerId,
        prompt: `你成为【${context.cardName}】的目标，是否发动【发呆】？`,
        timeoutMs: 20_000,
        optional: false,
        options: [
          { id: 'fadai-invoke', label: '发呆：展示牌堆顶一张牌' },
          { id: 'cancel', label: '取消' },
        ],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'invoke') return
    const optionId = (response.payload as { optionId: string }).optionId
    if (optionId !== 'fadai-invoke') {
      host.resumeCardTarget()
      return
    }
    const current = host.state.cardResolution
    if (!current || current.cardId !== resolution.data.cardId) return
    markUsedThisTurn(host.state, ownerId, FADAI)
    const revealedId = revealTopCard(host)
    if (!revealedId) {
      host.resumeCardTarget()
      return
    }
    const revealed = host.state.cards[revealedId]
    if (revealed.suit === 'diamond') {
      moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'discardPile' })
      if (current.kind === 'slash') current.targetCancelled = true
      else if (!current.cancelledTargetIds.includes(ownerId)) current.cancelledTargetIds.push(ownerId)
      host.dispatch('CardResolved', { cardId: revealedId, cardName: revealed.name, skillId: FADAI, result: 'cancel-target' }, { targetId: ownerId, cardIds: [revealedId] })
    } else {
      moveCard(host.state, revealedId, { kind: 'processingArea' }, { kind: 'hand', playerId: ownerId })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [revealedId], reason: FADAI, revealed: true }, { targetId: ownerId, cardIds: [revealedId] })
      if (current.kind === 'slash') current.noDodge = true
      else if (!current.unresponsiveTargetIds.includes(ownerId)) current.unresponsiveTargetIds.push(ownerId)
    }
    host.resumeCardTarget()
  },
})

export const ENTERTAINMENT_CHARACTERS: readonly CharacterDefinition[] = [{
  id: 'pingtoufangkuai',
  name: '平头方块',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 4,
  pack: 'entertainment',
  skills: [
    {
      id: SHUAJIAN,
      name: '耍剑',
      description: '出牌阶段限一次，你可以令一名其他角色选择一项：视为对你使用一张无距离和次数限制的【杀】，此【杀】对你造成伤害后你摸一张牌，否则你摸两张牌；或你摸一张牌，且你本回合不能对其使用牌。',
    },
    {
      id: FADAI,
      name: '发呆',
      description: '每回合限一次，当你成为其他角色使用的【杀】或普通锦囊牌的目标后，你可以展示牌堆顶一张牌：若为方块，取消你作为此牌的目标并弃置之；否则你获得之，且不能响应此牌。',
    },
  ],
}, NAIWA, NIULAI_CHARACTER, XULAOBAN, WULIANG, YIXING, SHANSHUI] as const
