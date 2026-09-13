import { moveCard } from '../../engine/zones'
import { drawCards } from '../../engine/draw'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { DELAYED_TRICKS, INSTANT_TRICKS } from '../../engine/cards/tricks'
import { BASIC_CARD_INFO } from '../ruleset-v1/card-info'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 孔淑（三国杀 OL 经典身份 SP）。
 *
 * 【累卵】：每个 TurnInstance 限一次。X=孔淑连续发动本技能的轮数（至少1），
 *          可以将X张牌当一张本轮尚未使用过的基本牌使用。本轮结束时，若她
 *          本轮成功发动过，可以摸X张牌，并视为使用一张本轮进入弃牌堆的
 *          普通/非延时锦囊牌（简化为单目标，目标由孔淑指定一名其他角色）。
 * 【覆巢】：锁定技，其他角色使用的牌以孔淑为目标后，她必须选择：弃置她和
 *          使用者各1张牌，然后（简化）不再额外拦截别人的响应；或令该牌对
 *          其他目标无效，然后对孔淑额外结算一次。
 */

const LEILUAN = 'leiluan'
const FUCHAO = 'fuchao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

function usedBasicsThisRound(state: SanguoshaState, ownerId: PlayerId): string[] {
  const entry = state.kongshuUsedBasics?.[ownerId]
  return entry && entry.roundNumber === state.roundNumber ? entry.names : []
}

/** 闪只能"打出/响应"，引擎的使用牌管线不支持"使用一张闪"，声明范围里排除。 */
function usableBasicNames(): string[] {
  return BASIC_CARD_INFO.map((info) => info.name).filter((name) => name !== '闪')
}

registerSkillRuntime({
  id: LEILUAN,
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(LEILUAN)) return []
    const candidates = usableBasicNames().filter((name) => !usedBasicsThisRound(state, ownerId).includes(name))
    if (candidates.length === 0 || owner.zones.hand.length < currentStreakX(state, ownerId)) return []
    return [{ id: LEILUAN, label: '累卵：将X张牌当一张本轮未用过的基本牌使用' }]
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== LEILUAN) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(LEILUAN)) return
    const candidates = usableBasicNames().filter((name) => !usedBasicsThisRound(host.state, ownerId).includes(name))
    if (candidates.length === 0 || owner.zones.hand.length < currentStreakX(host.state, ownerId)) return
    host.askSkill({
      skillId: LEILUAN, ownerId, step: 'declare', data: {},
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【累卵】：声明一张本轮尚未使用过的基本牌', timeoutMs: 20_000, optional: false,
        options: candidates.map((name) => ({ id: name, label: name })),
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'declare') {
      const declared = (response.payload as { optionId?: string }).optionId
      if (!declared) return
      const x = currentStreakX(host.state, ownerId)
      host.askSkill({
        skillId: LEILUAN, ownerId, step: 'pick-cards', data: { declared, x },
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: `【累卵】：选择${x}张牌当【${declared}】使用`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: x, max: x,
        }),
      })
      return
    }

    if (resolution.step === 'round-end-trick') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!optionId || optionId === 'none') return
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      if (candidateIds.length === 0) return
      host.askSkill({
        skillId: LEILUAN, ownerId, step: 'round-end-target', data: { declared: optionId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: `【累卵】：选择【${optionId}】的目标`, timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'round-end-target') {
      const { declared } = resolution.data as { declared: string }
      const [targetId] = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      if (!targetId || !playerOf(host.state, targetId)?.alive) return
      host.dispatch('SkillActivated', { skillId: LEILUAN, skillName: '累卵', playerId: ownerId, logText: `${owner.nickname}发动【累卵】，视为使用【${declared}】` }, { sourceId: ownerId })
      const virtualId = createVirtualTrick(host.state, ownerId, declared, LEILUAN)
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `leiluan-end:${virtualId}`, playerId: ownerId,
        cardIds: [virtualId], targetIds: [targetId], targetMin: 1, targetMax: 1,
        asCardName: declared, label: `【累卵】：视为使用【${declared}】`,
      })
      return
    }

    if (resolution.step === 'pick-cards') {
      const { declared, x } = resolution.data as { declared: string; x: number }
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const valid = cardIds.filter((id) => owner.zones.hand.includes(id))
      if (valid.length !== x) return
      owner.turnUsedSkills.push(LEILUAN)
      host.state.kongshuUsedBasics ??= {}
      const entry = host.state.kongshuUsedBasics[ownerId]
      const names = entry && entry.roundNumber === host.state.roundNumber ? [...entry.names, declared] : [declared]
      host.state.kongshuUsedBasics[ownerId] = { roundNumber: host.state.roundNumber, names }
      const roundNumber = host.state.roundNumber
      host.state.kongshuStreakRound ??= {}
      const last = host.state.kongshuStreakRound[ownerId]
      const streak = last?.roundNumber === roundNumber - 1 ? last.streak + 1 : 1
      host.state.kongshuStreakRound[ownerId] = { roundNumber, streak }
      const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
      host.dispatch('SkillActivated', { skillId: LEILUAN, skillName: '累卵', playerId: ownerId, logText: `${owner.nickname}发动【累卵】，将${x}张牌当【${declared}】使用` }, { sourceId: ownerId, cardIds: valid })
      // 用真实的 X 张手牌当子卡合成使用（复用多子卡当【杀】/基本牌的既有能力），不生成虚拟牌
      const isTargetless = declared !== '杀'
      executeUseCardAction(host as never, ownerId, {
        kind: 'use-card', id: `leiluan:${valid.join('-')}`, playerId: ownerId,
        cardIds: valid, targetIds: isTargetless ? [] : candidateIds.slice(0, 1),
        targetMin: isTargetless ? 0 : 1, targetMax: isTargetless ? 0 : 1,
        asCardName: declared, label: `【累卵】：使用【${declared}】`,
      })
    }
  },
  triggers: [
    {
      event: 'AfterCardUse',
      handle(host, _ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId; cardName?: string; cancelled?: boolean }
        if (payload.cancelled || !payload.cardName) return
        // 按最终有效牌名判断是否为普通锦囊，不能看实体牌本身的印刷类别——
        // 转化技（例如本技能【累卵】自己）可能用一张锦囊牌当基本牌的子牌
        if (!INSTANT_TRICKS.has(payload.cardName)) return
        const roundNumber = host.state.roundNumber
        host.state.kongshuRoundTricks ??= { roundNumber, names: [] }
        if (host.state.kongshuRoundTricks.roundNumber !== roundNumber) host.state.kongshuRoundTricks = { roundNumber, names: [] }
        if (!host.state.kongshuRoundTricks.names.includes(payload.cardName)) host.state.kongshuRoundTricks.names.push(payload.cardName)
      },
    },
    {
      event: 'RoundStart',
      handle(host, ownerId, context) {
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive) return
        const newRound = (context.event.payload as { roundNumber?: number }).roundNumber ?? host.state.roundNumber
        const previousRound = newRound - 1
        const streakEntry = host.state.kongshuStreakRound?.[ownerId]
        if (!streakEntry || streakEntry.roundNumber !== previousRound) return
        const x = streakEntry.streak
        const trickNames = host.state.kongshuRoundTricks?.roundNumber === previousRound ? host.state.kongshuRoundTricks.names : []
        host.queueSkill({ skillId: LEILUAN, ownerId, step: 'round-end', data: { x, trickNames } })
      },
    },
  ],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'round-end') return
    const owner = playerOf(host.state, ownerId)
    const { x, trickNames } = prompt.data as { x: number; trickNames: string[] }
    if (!owner?.alive) return
    drawCards(host.state, host.rng, ownerId, x, (name, payload) => { host.dispatch(name, payload) })
    host.dispatch('SkillActivated', { skillId: LEILUAN, skillName: '累卵', playerId: ownerId, logText: `${owner.nickname}回合结束，发动【累卵】摸${x}张牌` }, { sourceId: ownerId })
    if (trickNames.length === 0) return
    host.askSkill({
      skillId: LEILUAN, ownerId, step: 'round-end-trick', data: { trickNames },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【累卵】：是否视为使用一张本轮进入弃牌堆的普通锦囊？', timeoutMs: 20_000, optional: true,
        options: [...trickNames.map((name) => ({ id: name, label: name })), { id: 'none', label: '不发动' }],
      }),
    })
  },
})

function currentStreakX(state: SanguoshaState, ownerId: PlayerId): number {
  const entry = state.kongshuStreakRound?.[ownerId]
  return entry && entry.roundNumber === state.roundNumber - 1 ? entry.streak + 1 : 1
}

registerSkillRuntime({
  id: FUCHAO,
  triggers: [{
    event: 'AfterCardUse',
    handle(host, ownerId, _context) {
      const pending = host.state.kongshuFuchaoPending
      if (!pending || pending.ownerId !== ownerId) return
      host.state.kongshuFuchaoPending = undefined
      /*
       * 这个时机点 `cardResolution` 还没被调用方清空（`finishSlash`/
       * `finishPhysicalCard` 在把它置空之前就已经派发了 AfterCardUse），
       * 这里直接另起一次虚拟使用会撞上「已有卡牌正在结算」。所以推迟到
       * 技能队列（当前这轮同步结算完全收尾之后）再真正执行。
       */
      host.queueSkill({ skillId: FUCHAO, ownerId, step: 'do-extra', data: { ...pending } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'do-extra') return
    const { sourceId, cardName, category } = prompt.data as { sourceId: PlayerId; cardName: string; category: string }
    const source = playerOf(host.state, sourceId)
    const owner = playerOf(host.state, ownerId)
    if (!source?.alive || !owner?.alive) return
    if (host.state.cardResolution) return
    if (category === 'trick' && !DELAYED_TRICKS.has(cardName)) {
      const virtualId = createVirtualTrick(host.state, sourceId, cardName, FUCHAO)
      executeUseCardAction(host as never, sourceId, {
        kind: 'use-card', id: `fuchao:${virtualId}`, playerId: sourceId,
        cardIds: [virtualId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
        asCardName: cardName, label: `【覆巢】额外结算【${cardName}】`,
      })
    } else if (cardName === '杀') {
      host.beginVirtualSlash({ sourceId, targetId: ownerId, sourceSkillId: FUCHAO })
    }
  },
  interceptTarget(host, ownerId, context) {
    if (context.sourceId === ownerId) return false
    host.askSkill({
      skillId: FUCHAO, ownerId, step: 'choice', data: { sourceId: context.sourceId, cardName: context.cardName, category: context.category },
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '【覆巢】：弃置双方各1张牌，或令此牌对其他人无效并对你额外结算一次', timeoutMs: 20_000, optional: false,
        options: [{ id: 'discard', label: '弃置双方各1张牌' }, { id: 'extra', label: '对其他人无效，对我额外结算' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return

    if (resolution.step === 'choice') {
      const { sourceId, cardName, category } = resolution.data as { sourceId: PlayerId; cardName: string; category: string }
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'discard') {
        if (owner.zones.hand.length === 0) { host.resumeCardTarget(); return }
        host.askSkill({
          skillId: FUCHAO, ownerId, step: 'discard-pick', data: { sourceId },
          build: (requestId): ChooseCardsRequest => ({
            id: requestId, kind: 'choose-cards', playerId: ownerId,
            prompt: '【覆巢】：弃置你的1张牌', timeoutMs: 20_000, optional: false,
            purpose: 'skill', cardIds: [...owner.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      /*
       * 令原牌对其他目标（包括孔淑自己）无效——额外结算另起一次虚拟使用，
       * 不能和原结算叠在一起处理，否则两个 cardResolution 会互相覆盖
       * （青龙偃月刀追杀同款陷阱：见 basic.ts 的 useExtraSlash 注释）。
       * 所以这里只取消目标，真正的"额外结算"推迟到 AfterCardUse 时机，
       * 那时原牌的结算已经彻底收尾，可以安全地另起一次虚拟使用。
       */
      const current = host.state.cardResolution
      if (current?.kind === 'trick') {
        for (const targetId of current.targetIds) {
          if (!current.cancelledTargetIds.includes(targetId)) current.cancelledTargetIds.push(targetId)
        }
      } else if (current?.kind === 'slash' && current.targetId === ownerId) {
        current.targetCancelled = true
      }
      host.state.kongshuFuchaoPending = { ownerId, sourceId, cardName, category }
      host.dispatch('SkillActivated', { skillId: FUCHAO, skillName: '覆巢', playerId: ownerId, logText: `${owner.nickname}发动【覆巢】，对其他人无效并额外结算` }, { sourceId: ownerId })
      host.resumeCardTarget()
      return
    }

    if (resolution.step === 'discard-pick') {
      const { sourceId } = resolution.data as { sourceId: PlayerId }
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      if (cardId && owner.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: FUCHAO }, { sourceId: ownerId, cardIds: [cardId] })
      }
      const source = playerOf(host.state, sourceId)
      if (source?.alive && source.zones.hand.length > 0) {
        const pickId = source.zones.hand[host.rng.nextInt(source.zones.hand.length)]
        moveCard(host.state, pickId, { kind: 'hand', playerId: sourceId }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: sourceId, cardIds: [pickId], reason: FUCHAO }, { sourceId: sourceId, cardIds: [pickId] })
      }
      host.dispatch('SkillActivated', { skillId: FUCHAO, skillName: '覆巢', playerId: ownerId, logText: `${owner.nickname}发动【覆巢】，弃置双方各1张牌` }, { sourceId: ownerId })
      host.resumeCardTarget()
    }
  },
})

export const KONGSHU: CharacterDefinition = {
  id: 'kongshu',
  name: '孔淑',
  kingdom: 'qun',
  gender: 'female',
  maxHp: 3,
  pack: 'sp',
  skills: [
    { id: LEILUAN, name: '累卵', description: '每个 TurnInstance 限一次，X=你连续发动本技能的轮数（至少为1），将X张牌当一张本轮尚未使用过的基本牌使用；本轮结束时，若成功发动过，摸X张牌，并可以视为使用一张本轮进入弃牌堆的普通锦囊。' },
    { id: FUCHAO, name: '覆巢', description: '锁定技，其他角色使用的牌以你为目标后，你必须选择：弃置你与使用者各1张牌；或令这张牌对其他目标无效，然后对你额外结算一次。' },
  ],
}
