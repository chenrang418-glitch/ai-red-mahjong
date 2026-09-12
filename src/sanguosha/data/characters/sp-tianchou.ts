import { pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { createVirtualTrick } from '../../engine/virtual-trick'
import { executeUseCardAction } from '../../engine/cards/basic'
import { handleEquipmentLost } from '../../engine/equipment'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { ChooseTargetsRequest } from '../../engine/requests'
import type { PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 田畴（三国杀 OL 经典身份 SP）。
 *
 * 【善刀】：出牌阶段限一次，田畴选择任意数量角色，各选择其区域里一张牌置于
 *          牌堆顶，然后视为对这些角色使用一张【五谷丰登】，结算完毕后再
 *          视为对其余角色使用一张【万箭齐发】。
 *
 * 最容易做错的：**顺序固定为「置顶 → 虚拟五谷 → 虚拟万箭」**，两张虚拟锦囊
 * 都直接构造好目标集合传给 `executeUseCardAction`（田畴自己选定的分组，
 * 不走玩家在锦囊结算时再挑目标那一步），不新写目标合法性判断。
 */

const SHANDAO = 'shandao'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

registerSkillRuntime({
  id: SHANDAO,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.turnUsedSkills.includes(SHANDAO)) return []
    return [{ id: SHANDAO, label: '善刀：选择任意数量角色，各置顶一张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== SHANDAO) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive).map((candidate) => candidate.id)
    host.askSkill({
      skillId: SHANDAO, ownerId, step: 'targets',
      build: (requestId): ChooseTargetsRequest => ({
        id: requestId, kind: 'choose-targets', playerId: ownerId,
        prompt: '【善刀】：选择任意数量角色（可以不选）', timeoutMs: 20_000, optional: true,
        candidateIds, min: 0, max: candidateIds.length,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'targets') {
      const targetIds = [...new Set((response.payload as { targetIds?: PlayerId[] }).targetIds ?? [])]
        .filter((id) => playerOf(host.state, id)?.alive)
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      if (!owner.turnUsedSkills.includes(SHANDAO)) owner.turnUsedSkills.push(SHANDAO)
      host.dispatch('SkillActivated', {
        skillId: SHANDAO, skillName: '善刀', playerId: ownerId,
        logText: `${owner.nickname}发动【善刀】`,
      }, { sourceId: ownerId })
      pickTopCards(host, ownerId, targetIds, 0)
      return
    }

    if (resolution.step === 'pick') {
      const { targetIds, index } = resolution.data as { targetIds: PlayerId[]; index: number }
      const targetId = targetIds[index]
      const [choice] = (response.payload as { cardIds?: string[] }).cardIds ?? []
      if (choice) {
        const cardId = resolvePickedCard(host.state, targetId, choice)
        const from = cardId ? locateOwnedCard(host.state, targetId, cardId) : null
        if (cardId && from) {
          moveCard(host.state, cardId, from, { kind: 'drawPile' }, { toTop: true })
          if (from.kind === 'equipment') handleEquipmentLost(host as never, targetId, cardId)
        }
      }
      pickTopCards(host, ownerId, targetIds, index + 1)
    }
  },
})

function pickTopCards(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[], index: number): void {
  if (index >= targetIds.length) {
    finishShandao(host, ownerId, targetIds)
    return
  }
  const targetId = targetIds[index]
  const target = playerOf(host.state, targetId)
  if (!target?.alive) { pickTopCards(host, ownerId, targetIds, index + 1); return }
  const pickable = pickableCardsOf(host.state, targetId)
  if (pickable.cardIds.length + pickable.hiddenCardSlots.length === 0) { pickTopCards(host, ownerId, targetIds, index + 1); return }
  host.askSkill({
    skillId: SHANDAO, ownerId, step: 'pick', data: { targetIds, index },
    build: (requestId) => ({
      id: requestId, kind: 'choose-cards' as const, playerId: ownerId,
      prompt: `【善刀】：选择${target.nickname}区域里的一张牌置于牌堆顶`,
      timeoutMs: 20_000, optional: true, purpose: 'skill' as const,
      cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 0, max: 1,
    }),
  })
}

function finishShandao(host: SkillHost, ownerId: PlayerId, wuguTargets: PlayerId[]): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  if (wuguTargets.length > 0) {
    const cardId = createVirtualTrick(host.state, ownerId, '五谷丰登', SHANDAO)
    executeUseCardAction(host as never, ownerId, {
      kind: 'use-card', id: `shandao-wugu:${cardId}`, playerId: ownerId,
      cardIds: [cardId], targetIds: wuguTargets, targetMin: wuguTargets.length, targetMax: wuguTargets.length,
      asCardName: '五谷丰登', label: '视为使用【五谷丰登】',
    })
  }
  /*
   * 五谷这张虚拟锦囊可能还没有真正结算完（无懈可击询问还挂着）——这时候
   * 不能紧接着就开始万箭齐发的使用流程，那会在 `cardResolution` 还占着的
   * 时候又起一个新的，后面无懈的回应会找不到匹配的结算而报「Request 已经
   * 过期」（压测复现：seed=bisect-tianchou-0）。用 `queueSkill` 等五谷真正
   * 结算干净（`cardResolution` 清空）之后再开始万箭。
   */
  if (host.state.cardResolution) {
    host.queueSkill({ skillId: `${SHANDAO}-wanjian`, ownerId, step: 'wanjian', data: { wuguTargets } })
    return
  }
  startWanjian(host, ownerId, wuguTargets)
}

function startWanjian(host: SkillHost, ownerId: PlayerId, wuguTargets: PlayerId[]): void {
  const others = host.state.players.filter((candidate) => candidate.alive && !wuguTargets.includes(candidate.id)).map((candidate) => candidate.id)
  if (others.length === 0) return
  const cardId = createVirtualTrick(host.state, ownerId, '万箭齐发', SHANDAO)
  executeUseCardAction(host as never, ownerId, {
    kind: 'use-card', id: `shandao-wanjian:${cardId}`, playerId: ownerId,
    cardIds: [cardId], targetIds: others, targetMin: others.length, targetMax: others.length,
    asCardName: '万箭齐发', label: '视为使用【万箭齐发】',
  })
}

registerSkillRuntime({
  id: `${SHANDAO}-wanjian`,
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'wanjian') return
    const { wuguTargets } = prompt.data as { wuguTargets: PlayerId[] }
    if (!playerOf(host.state, ownerId)?.alive) return
    startWanjian(host, ownerId, wuguTargets)
  },
})

export const TIANCHOU: CharacterDefinition = {
  id: 'tianchou',
  name: '田畴',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'sp',
  skills: [
    {
      id: SHANDAO,
      name: '善刀',
      description: '出牌阶段限一次，田畴选择任意数量角色，各选择其区域里一张牌置于牌堆顶，然后视为对这些角色使用一张【五谷丰登】，结算完毕后再视为对其余角色使用一张【万箭齐发】。',
    },
  ],
}
