import { handleEquipmentLost } from '../../engine/equipment'
import { beginVirtualTrick, declaredCardActions, executeUseCardAction, wineUseAllowed } from '../../engine/cards/basic'
import { isCardUseLocked } from '../../engine/card-play-lock'
import { movePickedCard, pickableCardsOf, resolvePickedCard } from '../../engine/card-pick'
import { drawCards } from '../../engine/draw'
import { resolveDamage, resumeDamageModifier, resumeTargetDamagePrevention } from '../../engine/damage'
import { DELAYED_TRICKS } from '../../engine/cards/tricks'
import { effectiveCardName, locateOwnedCard, moveCard } from '../../engine/zones'
import { registerGroupDecision, startGroupDecision, type GroupDecisionHost } from '../../engine/group-decision'
import type { LegalAction } from '../../engine/actions'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { effectiveCardColor, isCardUseProhibited, registerSkillRuntime, type SkillHost, type ViewAsOption } from '../../engine/skills/runtime'
import { markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { effectiveGenderOf } from '../../engine/huashen'
import type { CardId, EquipmentSlot, GroupDecisionState, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

const JIE_CAI_QIETING = 'qieting-jie-caifuren-b49'
const JIE_CAI_XIANZHOU = 'xianzhou'

function playerOf(state: SanguoshaState, id: PlayerId) {
  return state.players.find((player) => player.id === id)
}

function handDamageThisTurn(state: SanguoshaState, playerId: PlayerId, turnNumber: number): boolean {
  return (state.damageHistory ?? []).some((entry) => entry.turnNumber === turnNumber
    && entry.sourceId === playerId && entry.targetId !== playerId)
}

function availableEquipment(state: SanguoshaState, ownerId: PlayerId, targetId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  const target = playerOf(state, targetId)
  if (!owner || !target) return []
  return Object.values(target.zones.equipment).filter((id): id is CardId => Boolean(id))
}

registerSkillRuntime({
  id: JIE_CAI_QIETING,
  triggers: [{
    event: 'TurnEnd',
    handle(host, ownerId, context) {
      const { playerId: actorId, turnNumber } = context.event.payload as { playerId?: PlayerId; turnNumber?: number }
      const owner = playerOf(host.state, ownerId)
      const actor = actorId ? playerOf(host.state, actorId) : undefined
      if (!actorId || actorId === ownerId || !owner?.alive || !actor || turnNumber == null
        || handDamageThisTurn(host.state, actorId, turnNumber)) return
      host.queueSkill({ skillId: JIE_CAI_QIETING, ownerId, step: 'choose', data: { targetId: actorId } })
    },
  }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'choose') return
    const targetId = prompt.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (!owner?.alive || !target) return
    const equipment = availableEquipment(host.state, ownerId, targetId)
    host.askSkill({ skillId: JIE_CAI_QIETING, ownerId, step: 'choose', data: { targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: `【窃听】：选择一项`, timeoutMs: 20_000, optional: true,
        options: [
          ...(target.zones.hand.length >= 2 ? [{ id: 'hand', label: `观看${target.nickname}两张手牌并获得其中一张` }] : []),
          ...(equipment.length ? [{ id: 'equipment', label: `将${target.nickname}装备区的一张牌置入你的装备区` }] : []),
          { id: 'draw', label: '摸一张牌' },
        ],
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (resolution.step === 'choose') {
      if (!owner?.alive || !target) return
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'hand' && target.zones.hand.length >= 2) {
        // 先随机观看两张，再由蔡夫人从这两张中选择；不暴露其余手牌。
        const pool = [...target.zones.hand]
        for (let index = pool.length - 1; index > 0; index -= 1) {
          const other = host.rng.nextInt(index + 1)
          ;[pool[index], pool[other]] = [pool[other], pool[index]]
        }
        const revealed = pool.slice(0, 2)
        host.askSkill({ skillId: JIE_CAI_QIETING, ownerId, step: 'take-hand', data: { targetId, revealed },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: `【窃听】：选择获得${target.nickname}的一张手牌`, timeoutMs: 20_000,
            optional: false, purpose: 'skill', cardIds: revealed, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      if (optionId === 'equipment' && availableEquipment(host.state, ownerId, targetId).length) {
        const cards = availableEquipment(host.state, ownerId, targetId)
        host.askSkill({ skillId: JIE_CAI_QIETING, ownerId, step: 'take-equipment', data: { targetId },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: `【窃听】：选择置入装备区的牌`, timeoutMs: 20_000,
            optional: false, purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
        return
      }
      if (optionId === 'draw') {
        host.dispatch('SkillActivated', { skillId: JIE_CAI_QIETING, skillName: '窃听', playerId: ownerId,
          logText: `${owner.nickname}发动【窃听】，摸一张牌` }, { sourceId: ownerId })
        drawCards(host.state, host.rng, ownerId, 1, (name, payload) => host.dispatch(name, payload))
      }
      return
    }
    if (resolution.step === 'take-hand') {
      const revealed = resolution.data.revealed as CardId[]
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !target?.alive || !cardId || !revealed.includes(cardId) || !target.zones.hand.includes(cardId)) return
      if (!movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIE_CAI_QIETING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_CAI_QIETING }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
      return
    }
    if (resolution.step === 'take-equipment') {
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      if (!owner?.alive || !target?.alive || !cardId || !availableEquipment(host.state, ownerId, targetId).includes(cardId)) return
      const slot = host.state.cards[cardId]?.equipmentSlot as EquipmentSlot | undefined
      if (!slot) return
      const replaced = owner.zones.equipment[slot]
      if (replaced) {
        moveCard(host.state, replaced, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: [replaced], reason: JIE_CAI_QIETING }, { targetId: ownerId, cardIds: [replaced] })
        handleEquipmentLost(host as never, ownerId, replaced)
      }
      moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'equipment', playerId: ownerId, slot })
      host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: JIE_CAI_QIETING }, { sourceId: ownerId, targetId, cardIds: [cardId] })
      host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: JIE_CAI_QIETING }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    }
  },
})

/** The base edition's Xianzhou runtime is deliberately shared: its resolution semantics are identical. */
export const B49_JIE_CAIFUREN: CharacterDefinition = {
  id: 'jie-caifuren-b49', name: '界·蔡夫人', kingdom: 'qun', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: JIE_CAI_QIETING, name: '窃听', description: '其他角色的回合结束后，若其没有于此回合内对另一名角色造成过伤害，则你可以选择一项：1.观看其两张手牌并获得其中一张；2.将其装备区里的一张牌置入你的装备区；3.摸一张牌。' },
    { id: JIE_CAI_XIANZHOU, name: '献州', description: '限定技，出牌阶段，你可以将装备区里的所有牌交给一名其他角色，然后该角色选择一项：1.令你回复X点体力；2.对其攻击范围内的至多X名角色各造成1点伤害（X为你以此法交给该角色的牌的数量）。' },
  ],
}

// 星·黄忠：初始处于“阳”，准备阶段固定转阳、结束阶段固定转阴。
const B49_XING_HUANGZHONG_SHIDI = 'shidi-xing-huangzhong-b49'
const B49_XING_HUANGZHONG_YISHI = 'yishi-xing-huangzhong-b49'
const B49_XING_HUANGZHONG_QISHE = 'qishe-xing-huangzhong-b49'
const B49_XING_HUANGZHONG_YANG = 'b49-xing-huangzhong-yang'

function equipmentIdsOf(state: SanguoshaState, playerId: PlayerId): CardId[] {
  const player = playerOf(state, playerId)
  return player ? Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id)) : []
}

registerSkillRuntime({
  id: B49_XING_HUANGZHONG_SHIDI,
  triggers: [{
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId) return
      const owner = playerOf(host.state, ownerId)
      if (!owner) return
      if (payload.phase === 'prepare') owner.marks[B49_XING_HUANGZHONG_YANG] = 1
      if (payload.phase === 'finish') owner.marks[B49_XING_HUANGZHONG_YANG] = 0
    },
  }],
  distanceModifier: {
    toOthers: (state, ownerId) => playerOf(state, ownerId)?.marks[B49_XING_HUANGZHONG_YANG] === 0 ? 0 : -1,
    fromOthers: (state, ownerId) => playerOf(state, ownerId)?.marks[B49_XING_HUANGZHONG_YANG] === 0 ? 1 : 0,
  },
  prohibitsCardResponse(state, ownerId, responderId, cardName) {
    const resolution = state.cardResolution
    if (cardName !== '闪' || resolution?.kind !== 'slash' || resolution.targetId !== responderId) return false
    const owner = playerOf(state, ownerId)
    if (!owner) return false
    const color = effectiveCardColor(state, resolution.sourceId, resolution.cardId)
    if (resolution.sourceId === ownerId) return owner.marks[B49_XING_HUANGZHONG_YANG] !== 0 && color === 'black'
    return responderId === ownerId && owner.marks[B49_XING_HUANGZHONG_YANG] === 0 && color === 'red'
  },
})

registerSkillRuntime({
  id: B49_XING_HUANGZHONG_YISHI,
  offersDamageModifierAsk(host, ownerId, side, context) {
    if (side !== 'source' || context.sourceId !== ownerId || context.targetId === ownerId
      || context.amount <= 0 || equipmentIdsOf(host.state, context.targetId).length === 0) return false
    host.askSkill({ skillId: B49_XING_HUANGZHONG_YISHI, ownerId, step: 'invoke',
      data: { targetId: context.targetId },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【义释】：令此伤害-1并获得其装备区里的一张牌？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【义释】' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const targetId = resolution.data.targetId as PlayerId
    const owner = playerOf(host.state, ownerId)
    const target = playerOf(host.state, targetId)
    if (resolution.step === 'invoke') {
      const accepted = (response.payload as { optionId?: string }).optionId === 'yes'
      const equipment = equipmentIdsOf(host.state, targetId)
      if (!accepted || !owner?.alive || !target?.alive || equipment.length === 0) {
        resumeDamageModifier(host as never, B49_XING_HUANGZHONG_YISHI, 0)
        return
      }
      host.askSkill({ skillId: B49_XING_HUANGZHONG_YISHI, ownerId, step: 'take-equipment', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【义释】：获得其装备区里的一张牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: equipment, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'take-equipment') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const slot = cardId ? host.state.cards[cardId]?.equipmentSlot as EquipmentSlot | undefined : undefined
    if (!owner?.alive || !target?.alive || !cardId || !slot || !equipmentIdsOf(host.state, targetId).includes(cardId)) {
      resumeDamageModifier(host as never, B49_XING_HUANGZHONG_YISHI, 0)
      return
    }
    const replaced = owner.zones.equipment[slot]
    if (replaced) {
      moveCard(host.state, replaced, { kind: 'equipment', playerId: ownerId, slot }, { kind: 'discardPile' })
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: [replaced], reason: B49_XING_HUANGZHONG_YISHI }, { targetId: ownerId, cardIds: [replaced] })
      handleEquipmentLost(host as never, ownerId, replaced)
    }
    moveCard(host.state, cardId, { kind: 'equipment', playerId: targetId, slot }, { kind: 'hand', playerId: ownerId })
    handleEquipmentLost(host as never, targetId, cardId)
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: B49_XING_HUANGZHONG_YISHI }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: B49_XING_HUANGZHONG_YISHI }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
    resumeDamageModifier(host as never, B49_XING_HUANGZHONG_YISHI, -1)
  },
})

registerSkillRuntime({
  id: B49_XING_HUANGZHONG_QISHE,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive) return []
    const cardIds = [...owner.zones.hand, ...equipmentIdsOf(state, ownerId)]
    return cardIds.filter((cardId) => state.cards[cardId]?.category === 'equipment')
      .map((cardId) => ({ asCardName: '酒', cardId, label: `【骑射】：将【${state.cards[cardId]?.name ?? '装备牌'}】当【酒】使用` }))
  },
  activeActions(state, ownerId) {
    const available = equipmentIdsOf(state, ownerId).some((cardId) => !isCardUseLocked(state, ownerId, cardId))
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId || !wineUseAllowed(state, ownerId)
      || isCardUseProhibited(state, ownerId, '酒', { dyingPlayerId: null }) || !available) return []
    return [{ id: `skill:${B49_XING_HUANGZHONG_QISHE}:equipment-as-wine`, label: '【骑射】将装备区的一张牌当【酒】使用' }]
  },
  invokeActive(host, ownerId) {
    const cardIds = equipmentIdsOf(host.state, ownerId).filter((cardId) => !isCardUseLocked(host.state, ownerId, cardId))
    if (!playerOf(host.state, ownerId)?.alive || !wineUseAllowed(host.state, ownerId)
      || isCardUseProhibited(host.state, ownerId, '酒', { dyingPlayerId: null }) || cardIds.length === 0) return
    host.askSkill({ skillId: B49_XING_HUANGZHONG_QISHE, ownerId, step: 'use-equipment',
      build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
        prompt: '【骑射】：选择一张装备区里的牌当【酒】使用', timeoutMs: 20_000, optional: true,
        purpose: 'skill', cardIds, hiddenCardSlots: [], min: 0, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'use-equipment') return
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    if (!cardId || !equipmentIdsOf(host.state, ownerId).includes(cardId)
      || host.state.cards[cardId]?.category !== 'equipment' || isCardUseLocked(host.state, ownerId, cardId)
      || !wineUseAllowed(host.state, ownerId) || isCardUseProhibited(host.state, ownerId, '酒', { dyingPlayerId: null })) return
    const action: Extract<LegalAction, { kind: 'use-card' }> = {
      id: `skill:${B49_XING_HUANGZHONG_QISHE}:equipment-wine:${cardId}`, kind: 'use-card', playerId: ownerId,
      cardIds: [cardId], targetIds: [ownerId], targetMin: 1, targetMax: 1,
      asCardName: '酒', label: '【骑射】：使用装备区牌当【酒】',
    }
    executeUseCardAction(host as never, ownerId, action)
  },
  maxCardsBonus: (state, ownerId) => equipmentIdsOf(state, ownerId).length,
})

export const B49_XING_HUANGZHONG: CharacterDefinition = {
  id: 'star-huangzhong-b49', name: '星·黄忠', kingdom: 'qun', gender: 'male', maxHp: 4, pack: 'standard',
  skills: [
    { id: B49_XING_HUANGZHONG_SHIDI, name: '势敌', description: '转换技，锁定技，准备阶段转换为阳，结束阶段转换为阴。阳：你计算与其他角色的距离-1，你使用的黑色【杀】不可被响应。阴：其他角色计算与你的距离+1，你不可响应其他角色对你使用的红色【杀】。' },
    { id: B49_XING_HUANGZHONG_YISHI, name: '义释', description: '当你对其他角色造成伤害时，你可以令此伤害-1，并获得其装备区中的一张牌。' },
    { id: B49_XING_HUANGZHONG_QISHE, name: '骑射', description: '你可以将一张装备牌当【酒】使用。你的手牌上限+X（X为你装备区的牌数）。' },
  ],
}

const B49_JIE_SUNLUBAN_ZANHUI = 'zanhui-jie-sunluban-b49'
const B49_JIE_SUNLUBAN_JIAOJIN = 'jiaojin-jie-sunluban-b49'

function zanhuiCandidates(state: SanguoshaState, ownerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>): PlayerId[] {
  const cardId = action.cardIds[0]
  if (!cardId) return []
  return state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId
    && !action.targetIds.includes(candidate.id)
    && declaredCardActions(state, ownerId, cardId, action.asCardName, action.label)
      .some((legal) => legal.kind === 'use-card' && legal.targetIds.length === 1 && legal.targetIds[0] === candidate.id))
    .map((candidate) => candidate.id)
}

function isJieZanhuiCard(state: SanguoshaState, ownerId: PlayerId, action: LegalAction): action is Extract<LegalAction, { kind: 'use-card' }> {
  if (action.kind !== 'use-card' || action.playerId !== ownerId || action.targetIds.length !== 1 || action.cardIds.length !== 1) return false
  const card = state.cards[action.cardIds[0]]
  if (!card) return false
  if (action.asCardName === '杀') return true
  return card.category === 'trick' && !DELAYED_TRICKS.has(action.asCardName)
    && effectiveCardColor(state, ownerId, action.cardIds[0]) === 'black'
}

registerSkillRuntime({
  id: B49_JIE_SUNLUBAN_ZANHUI,
  interceptPlayAction(host, ownerId, action) {
    if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId
      || usedThisPhase(host.state, ownerId, B49_JIE_SUNLUBAN_ZANHUI)
      || !isJieZanhuiCard(host.state, ownerId, action) || zanhuiCandidates(host.state, ownerId, action).length === 0) return false
    host.askSkill({ skillId: B49_JIE_SUNLUBAN_ZANHUI, ownerId, step: 'invoke', data: { action },
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '是否发动【谮毁】？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动【谮毁】' }, { id: 'no', label: '正常使用此牌' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    const action = resolution.data.action as Extract<LegalAction, { kind: 'use-card' }>
    const useOriginal = () => executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { useOriginal(); return }
      const candidates = zanhuiCandidates(host.state, ownerId, action)
      if (candidates.length === 0) { useOriginal(); return }
      markUsedThisPhase(host.state, ownerId, B49_JIE_SUNLUBAN_ZANHUI)
      host.askSkill({ skillId: B49_JIE_SUNLUBAN_ZANHUI, ownerId, step: 'choose-c', data: { action },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【谮毁】：选择另一名可以成为此牌目标的角色', timeoutMs: 20_000, optional: false,
          candidateIds: candidates, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'choose-c') {
      const cId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!cId || !zanhuiCandidates(host.state, ownerId, action).includes(cId)) { useOriginal(); return }
      const selectable = pickableCardsOf(host.state, cId)
      host.askSkill({ skillId: B49_JIE_SUNLUBAN_ZANHUI, ownerId, step: 'c-choice', data: { action, cId },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: cId,
          prompt: '【谮毁】：选择一项', timeoutMs: 20_000, optional: false,
          options: [
            ...(selectable.cardIds.length + selectable.hiddenCardSlots.length > 0
              ? [{ id: 'replace', label: '孙鲁班获得你的一张牌，然后你代替她成为此牌使用者' }] : []),
            { id: 'target', label: '你也成为此牌目标' },
          ],
        }),
      })
      return
    }
    if (resolution.step === 'c-choice') {
      const cId = resolution.data.cId as PlayerId
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId !== 'replace' || pickableCardsOf(host.state, cId).cardIds.length + pickableCardsOf(host.state, cId).hiddenCardSlots.length === 0) {
        executeUseCardAction(host as never, ownerId, { ...action, targetIds: [...action.targetIds, cId] }, { skipPlayInterceptors: true })
        return
      }
      const pickable = pickableCardsOf(host.state, cId)
      host.askSkill({ skillId: B49_JIE_SUNLUBAN_ZANHUI, ownerId, step: 'take-c-card', data: { action, cId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【谮毁】：获得${playerOf(host.state, cId)?.nickname ?? '目标'}的一张牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'take-c-card') return
    const cId = resolution.data.cId as PlayerId
    const c = playerOf(host.state, cId)
    const owner = playerOf(host.state, ownerId)
    const selected = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const gained = selected ? resolvePickedCard(host.state, cId, selected) : null
    if (!c?.alive || !owner?.alive || !gained || !movePickedCard(host as never, cId, gained, { kind: 'hand', playerId: ownerId })) {
      useOriginal()
      return
    }
    host.dispatch('LoseCard', { playerId: cId, cardIds: [gained], reason: B49_JIE_SUNLUBAN_ZANHUI }, { sourceId: cId, targetId: ownerId, cardIds: [gained] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [gained], reason: B49_JIE_SUNLUBAN_ZANHUI }, { sourceId: cId, targetId: ownerId, cardIds: [gained] })
    for (const cardId of action.cardIds) {
      const from = locateOwnedCard(host.state, ownerId, cardId, { includeCharacterPiles: true })
      if (!from || from.kind === 'judgingArea') { useOriginal(); return }
      if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
      moveCard(host.state, cardId, from, { kind: 'hand', playerId: cId })
    }
    executeUseCardAction(host as never, cId, { ...action, playerId: cId }, { skipPlayInterceptors: true })
  },
})

function jieSunlubanEquipmentCards(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return [...owner.zones.hand.filter((id) => state.cards[id]?.category === 'equipment'), ...equipmentIdsOf(state, ownerId)]
}

registerSkillRuntime({
  id: B49_JIE_SUNLUBAN_JIAOJIN,
  offersTargetDamagePreventionAsk(host, ownerId, context) {
    if (context.targetId !== ownerId || !context.sourceId
      || effectiveGenderOf(host.state, context.sourceId) !== 'male'
      || jieSunlubanEquipmentCards(host.state, ownerId).length === 0) return false
    host.askSkill({ skillId: B49_JIE_SUNLUBAN_JIAOJIN, ownerId, step: 'invoke', data: {},
      build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
        prompt: '【骄矜】：弃置一张装备牌，防止此伤害？', timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '弃置一张装备牌并防止此伤害' }, { id: 'no', label: '不发动' }],
      }),
    })
    return true
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId !== 'yes') { resumeTargetDamagePrevention(host as never, false); return }
      const cards = jieSunlubanEquipmentCards(host.state, ownerId)
      if (cards.length === 0) { resumeTargetDamagePrevention(host as never, false); return }
      host.askSkill({ skillId: B49_JIE_SUNLUBAN_JIAOJIN, ownerId, step: 'discard', data: {},
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: '【骄矜】：弃置一张装备牌', timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: cards, hiddenCardSlots: [], min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step !== 'discard') return
    const owner = playerOf(host.state, ownerId)
    const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
    const from = cardId ? locateOwnedCard(host.state, ownerId, cardId) : null
    if (!owner?.alive || !cardId || !from || (from.kind !== 'hand' && from.kind !== 'equipment')
      || host.state.cards[cardId]?.category !== 'equipment') { resumeTargetDamagePrevention(host as never, false); return }
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host as never, ownerId, cardId)
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: B49_JIE_SUNLUBAN_JIAOJIN }, { targetId: ownerId, cardIds: [cardId] })
    host.dispatch('SkillActivated', { skillId: B49_JIE_SUNLUBAN_JIAOJIN, skillName: '骄矜', playerId: ownerId,
      logText: `${owner.nickname}发动【骄矜】，防止此伤害` }, { sourceId: ownerId })
    resumeTargetDamagePrevention(host as never, true, B49_JIE_SUNLUBAN_JIAOJIN)
  },
})

export const B49_JIE_SUNLUBAN: CharacterDefinition = {
  id: 'jie-sunluban-b49', name: '界·孙鲁班', kingdom: 'wu', gender: 'female', maxHp: 3, pack: 'standard',
  skills: [
    { id: B49_JIE_SUNLUBAN_ZANHUI, name: '谮毁', description: '出牌阶段限一次，当你使用【杀】或黑色普通锦囊牌仅指定唯一目标时，你可以选择一名可以成为此牌目标的另一名角色并选择一项：1.获得其一张牌，然后令其代替你成为此牌使用者；2.令其也成为此牌目标。' },
    { id: B49_JIE_SUNLUBAN_JIAOJIN, name: '骄矜', description: '当你受到男性角色造成的伤害时，你可以弃置一张装备牌，防止此伤害。' },
  ],
}

const MOU_XUHUANG_DUANLIANG = 'duanliang-mou-xuhuang-b49'
const MOU_XUHUANG_SHIPO = 'shipo-mou-xuhuang-b49'
const MOU_XUHUANG_MOUYI = `${MOU_XUHUANG_DUANLIANG}:mouyi`

function hasSupplyShortage(state: SanguoshaState, playerId: PlayerId): boolean {
  return Boolean(playerOf(state, playerId)?.zones.judgingArea.some((cardId) => effectiveCardName(state, cardId) === '兵粮寸断'))
}

function startMouXuhuangDuanliang(host: SkillHost, ownerId: PlayerId, targetId: PlayerId, ownerChoice: string): void {
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  if (ownerChoice === 'siege') {
    if (hasSupplyShortage(host.state, targetId)) {
      const pickable = pickableCardsOf(host.state, targetId)
      if (!pickable.cardIds.length && !pickable.hiddenCardSlots.length) return
      host.askSkill({ skillId: MOU_XUHUANG_DUANLIANG, ownerId, step: 'take-card', data: { targetId },
        build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
          prompt: `【断粮】：获得${target.nickname}的一张手牌或装备牌`, timeoutMs: 20_000, optional: false,
          purpose: 'skill', cardIds: pickable.cardIds, hiddenCardSlots: pickable.hiddenCardSlots, min: 1, max: 1,
        }),
      })
      return
    }
    const cardId = host.state.zones.drawPile[0]
    if (!cardId || isCardUseProhibited(host.state, ownerId, '兵粮寸断', { dyingPlayerId: null }, undefined)) return
    moveCard(host.state, cardId, { kind: 'drawPile' }, { kind: 'hand', playerId: ownerId })
    const action = { id: `play:duanliang:${host.state.seq}`, kind: 'use-card' as const, playerId: ownerId,
      cardIds: [cardId], targetIds: [targetId], targetMin: 1, targetMax: 1,
      asCardName: '兵粮寸断', label: '【断粮】：牌堆顶牌当【兵粮寸断】使用', }
    executeUseCardAction(host as never, ownerId, action, { skipPlayInterceptors: true })
    return
  }
  if (ownerChoice === 'advance') beginVirtualTrick(host as never, {
    sourceId: ownerId, targetId, cardName: '决斗', sourceSkillId: MOU_XUHUANG_DUANLIANG,
  })
}

registerGroupDecision(MOU_XUHUANG_MOUYI, (groupHost: GroupDecisionHost, decision: GroupDecisionState) => {
  const host = groupHost as unknown as SkillHost
  const [ownerId, targetId] = decision.playerIds
  if (!ownerId || !targetId || !decision.responses[ownerId] || !decision.responses[targetId]
    || decision.responses[ownerId] === decision.responses[targetId]) return
  const ownerChoice = decision.responses[ownerId]
  const owner = playerOf(host.state, ownerId)
  const target = playerOf(host.state, targetId)
  if (!owner?.alive || !target?.alive) return
  host.dispatch('SkillActivated', { skillId: MOU_XUHUANG_DUANLIANG, skillName: '断粮', playerId: ownerId,
    targetId, logText: `${owner.nickname}与${target.nickname}谋弈成功，发动【断粮】` }, { sourceId: ownerId, targetId })
  startMouXuhuangDuanliang(host, ownerId, targetId, ownerChoice)
})

registerSkillRuntime({
  id: MOU_XUHUANG_DUANLIANG,
  activeActions(state, ownerId) {
    return state.phase === 'play' && state.currentPlayerId === ownerId && playerOf(state, ownerId)?.alive
      && !usedThisPhase(state, ownerId, MOU_XUHUANG_DUANLIANG)
      ? [{ id: `skill:${MOU_XUHUANG_DUANLIANG}`, label: '断粮：与一名角色同时谋弈' }] : []
  },
  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${MOU_XUHUANG_DUANLIANG}` || usedThisPhase(host.state, ownerId, MOU_XUHUANG_DUANLIANG)) return
    const candidateIds = host.state.players.filter((candidate) => candidate.alive && candidate.id !== ownerId).map((candidate) => candidate.id)
    if (!candidateIds.length) return
    host.askSkill({ skillId: MOU_XUHUANG_DUANLIANG, ownerId, step: 'mouyi-target', data: {},
      build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
        prompt: '【断粮】：选择一名角色与你同时秘密谋弈', timeoutMs: 20_000, optional: false,
        candidateIds, min: 1, max: 1,
      }),
    })
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'mouyi-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (!targetId || !playerOf(host.state, targetId)?.alive || targetId === ownerId) return
      markUsedThisPhase(host.state, ownerId, MOU_XUHUANG_DUANLIANG)
      startGroupDecision(host, { id: `${MOU_XUHUANG_MOUYI}:${host.state.seq}`, tag: MOU_XUHUANG_MOUYI,
        skillId: MOU_XUHUANG_DUANLIANG, playerIds: [ownerId, targetId],
        prompt: '【断粮·谋弈】：双方同时秘密选择一项',
        options: [{ id: 'siege', label: '围城断粮' }, { id: 'advance', label: '擂鼓进军' }],
        defaultOptionId: 'siege', timeoutMs: 20_000, data: { ownerId, targetId },
      })
      return
    }
    if (resolution.step !== 'take-card') return
    const targetId = resolution.data.targetId as PlayerId
    const selected = (response.payload as { cardIds?: string[] }).cardIds?.[0]
    const cardId = selected ? resolvePickedCard(host.state, targetId, selected) : null
    if (!cardId || !playerOf(host.state, targetId)?.alive || !playerOf(host.state, ownerId)?.alive
      || !movePickedCard(host as never, targetId, cardId, { kind: 'hand', playerId: ownerId })) return
    host.dispatch('LoseCard', { playerId: targetId, cardIds: [cardId], reason: MOU_XUHUANG_DUANLIANG }, { sourceId: ownerId, targetId, cardIds: [cardId] })
    host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_XUHUANG_DUANLIANG }, { sourceId: targetId, targetId: ownerId, cardIds: [cardId] })
  },
})

function seatOrderFromOwner(state: SanguoshaState, ownerId: PlayerId, playerIds: PlayerId[]): PlayerId[] {
  const owner = playerOf(state, ownerId)
  if (!owner) return []
  const count = state.players.length
  return [...new Set(playerIds)].filter((id) => playerOf(state, id)?.alive).sort((leftId, rightId) => {
    const left = playerOf(state, leftId)!
    const right = playerOf(state, rightId)!
    return ((left.seat - owner.seat + count) % count) - ((right.seat - owner.seat + count) % count)
  })
}

function startShiPoSequence(host: SkillHost, ownerId: PlayerId, targetIds: PlayerId[]): void {
  const ordered = seatOrderFromOwner(host.state, ownerId, targetIds)
  if (!playerOf(host.state, ownerId)?.alive || !ordered.length) return
  host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'resolve-pressure',
    data: { ownerId, targetIds: ordered, index: 0, received: [] as CardId[] },
  })
}

registerSkillRuntime({
  id: MOU_XUHUANG_SHIPO,
  triggers: [{ event: 'PhaseStart', handle(host, ownerId, context) {
    const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
    if (payload.playerId !== ownerId || payload.phase !== 'finish' || !playerOf(host.state, ownerId)?.alive) return
    const owner = playerOf(host.state, ownerId)!
    const weak = host.state.players.some((target) => target.alive && target.id !== ownerId && target.hp < owner.hp)
    const supplied = host.state.players.some((target) => target.alive && target.id !== ownerId && hasSupplyShortage(host.state, target.id))
    if (weak || supplied) host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'invoke', data: {} })
  } }],
  startQueued(host, ownerId, prompt) {
    if (prompt.step === 'invoke') {
      host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'invoke', data: {},
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '是否发动【势迫】？', timeoutMs: 20_000, optional: true,
          options: [{ id: 'yes', label: '发动【势迫】' }, { id: 'no', label: '不发动' }],
        }),
      })
      return
    }
    if (prompt.step === 'scope') {
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const hasWeak = host.state.players.some((target) => target.alive && target.id !== ownerId && target.hp < owner.hp)
      const grainIds = host.state.players.filter((target) => target.alive && target.id !== ownerId && hasSupplyShortage(host.state, target.id)).map((target) => target.id)
      host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'scope', data: { grainIds },
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: ownerId,
          prompt: '【势迫】：选择目标范围', timeoutMs: 20_000, optional: false,
          options: [...(hasWeak ? [{ id: 'weak', label: '选择一名体力值小于你的角色' }] : []),
            ...(grainIds.length ? [{ id: 'all-grain', label: '令所有判定区有【兵粮寸断】的其他角色' }] : [])],
        }),
      })
      return
    }
    if (prompt.step === 'resolve-pressure') {
      const data = prompt.data as { ownerId: PlayerId; targetIds: PlayerId[]; index: number; received: CardId[] }
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      const targetId = data.targetIds[data.index]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      if (!targetId) {
        if (!data.received.length) return
        host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'redistribute-cards', data: { cardIds: data.received },
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: ownerId,
            prompt: '【势迫】：可将本技能获得的任意张牌交给一名其他角色', timeoutMs: 20_000,
            optional: true, purpose: 'skill', cardIds: data.received.filter((cardId) => owner.zones.hand.includes(cardId)),
            hiddenCardSlots: [], min: 0, max: data.received.filter((cardId) => owner.zones.hand.includes(cardId)).length,
          }),
        })
        return
      }
      if (!target?.alive) {
        host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'resolve-pressure', data: { ...data, index: data.index + 1 } })
        return
      }
      const options = target.zones.hand.length
        ? [{ id: 'give', label: '交给徐晃一张手牌' }, { id: 'damage', label: '受到1点伤害' }]
        : [{ id: 'damage', label: '受到1点伤害' }]
      host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'pressure-choice', data,
        build: (id): ChooseOptionRequest => ({ id, kind: 'choose-option', playerId: target.id,
          prompt: '【势迫】：选择一项', timeoutMs: 20_000, optional: false, options,
        }),
      })
    }
  },
  resume(host, ownerId, resolution, response) {
    if (resolution.step === 'invoke') {
      if ((response.payload as { optionId?: string }).optionId === 'yes') {
        host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'scope', data: {} })
      }
      return
    }
    if (resolution.step === 'scope') {
      const optionId = (response.payload as { optionId?: string }).optionId
      if (optionId === 'all-grain') {
        const targetIds = (resolution.data.grainIds as PlayerId[]).filter((id) => playerOf(host.state, id)?.alive && hasSupplyShortage(host.state, id))
        startShiPoSequence(host as never, ownerId, targetIds)
      } else if (optionId === 'weak') {
        const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId
          && target.hp < (playerOf(host.state, ownerId)?.hp ?? 0)).map((target) => target.id)
        if (candidateIds.length) host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'single-target', data: {},
          build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
            prompt: '【势迫】：选择一名体力值小于你的角色', timeoutMs: 20_000, optional: false,
            candidateIds, min: 1, max: 1,
          }),
        })
      }
      return
    }
    if (resolution.step === 'single-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      if (targetId && playerOf(host.state, targetId)?.alive) startShiPoSequence(host as never, ownerId, [targetId])
      return
    }
    if (resolution.step === 'pressure-choice') {
      const data = resolution.data as { ownerId: PlayerId; targetIds: PlayerId[]; index: number; received: CardId[] }
      const targetId = data.targetIds[data.index]
      const target = playerOf(host.state, targetId)
      const optionId = (response.payload as { optionId?: string }).optionId
      if (!target?.alive) {
        host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'resolve-pressure', data: { ...data, index: data.index + 1 } })
      } else if (optionId === 'give' && target.zones.hand.length) {
        host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'pressure-give-card', data,
          build: (id): ChooseCardsRequest => ({ id, kind: 'choose-cards', playerId: target.id,
            prompt: '【势迫】：选择交给徐晃的一张手牌', timeoutMs: 20_000,
            optional: false, purpose: 'skill', cardIds: [...target.zones.hand], hiddenCardSlots: [], min: 1, max: 1,
          }),
        })
      } else {
        resolveDamage(host as never, { sourceId: ownerId, targetId: target.id, amount: 1, nature: 'normal', cardName: null, cardId: null })
        host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'resolve-pressure', data: { ...data, index: data.index + 1 } })
      }
      return
    }
    if (resolution.step === 'pressure-give-card') {
      const data = resolution.data as { ownerId: PlayerId; targetIds: PlayerId[]; index: number; received: CardId[] }
      const targetId = data.targetIds[data.index]
      const target = playerOf(host.state, targetId)
      const cardId = (response.payload as { cardIds?: CardId[] }).cardIds?.[0]
      const owner = playerOf(host.state, ownerId)
      if (target?.alive && owner?.alive && cardId && target.zones.hand.includes(cardId)) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: target.id }, { kind: 'hand', playerId: ownerId })
        host.dispatch('LoseCard', { playerId: target.id, cardIds: [cardId], reason: MOU_XUHUANG_SHIPO }, { sourceId: ownerId, targetId: target.id, cardIds: [cardId] })
        host.dispatch('CardGiven', { fromId: target.id, toId: ownerId, cardIds: [cardId], reason: MOU_XUHUANG_SHIPO }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
        host.dispatch('GainCard', { playerId: ownerId, cardIds: [cardId], reason: MOU_XUHUANG_SHIPO }, { sourceId: target.id, targetId: ownerId, cardIds: [cardId] })
        data.received.push(cardId)
      }
      host.queueSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'resolve-pressure', data: { ...data, index: data.index + 1 } })
      return
    }
    if (resolution.step === 'redistribute-cards') {
      const selected = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const owner = playerOf(host.state, ownerId)
      const cardIds = selected.filter((cardId) => owner?.zones.hand.includes(cardId)
        && (resolution.data.cardIds as CardId[]).includes(cardId))
      if (!cardIds.length) return
      const candidateIds = host.state.players.filter((target) => target.alive && target.id !== ownerId).map((target) => target.id)
      if (!candidateIds.length) return
      host.askSkill({ skillId: MOU_XUHUANG_SHIPO, ownerId, step: 'redistribute-target', data: { cardIds },
        build: (id): ChooseTargetsRequest => ({ id, kind: 'choose-targets', playerId: ownerId,
          prompt: '【势迫】：选择获得这些牌的一名其他角色', timeoutMs: 20_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }
    if (resolution.step === 'redistribute-target') {
      const targetId = (response.payload as { targetIds?: PlayerId[] }).targetIds?.[0]
      const target = targetId ? playerOf(host.state, targetId) : undefined
      const owner = playerOf(host.state, ownerId)
      const cardIds = resolution.data.cardIds as CardId[]
      if (!owner?.alive || !target?.alive || target.id === ownerId) return
      const moved = cardIds.filter((cardId) => owner.zones.hand.includes(cardId))
      for (const cardId of moved) moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'hand', playerId: target.id })
      if (moved.length) {
        host.dispatch('LoseCard', { playerId: ownerId, cardIds: moved, reason: MOU_XUHUANG_SHIPO }, { sourceId: ownerId, targetId: target.id, cardIds: moved })
        host.dispatch('CardGiven', { fromId: ownerId, toId: target.id, cardIds: moved, reason: MOU_XUHUANG_SHIPO }, { sourceId: ownerId, targetId: target.id, cardIds: moved })
        host.dispatch('GainCard', { playerId: target.id, cardIds: moved, reason: MOU_XUHUANG_SHIPO }, { sourceId: ownerId, targetId: target.id, cardIds: moved })
      }
    }
  },
})

export const B49_MOU_XUHUANG: CharacterDefinition = {
  id: 'mou-xuhuang-b49', name: '谋·徐晃', kingdom: 'wei', gender: 'male', maxHp: 4, pack: 'sp',
  skills: [
    { id: MOU_XUHUANG_DUANLIANG, name: '断粮', description: '出牌阶段限一次，你可以与一名其他角色进行“谋弈”：围城断粮：你将一张牌堆顶的牌当做【兵粮寸断】对其使用且无距离限制。若其判定区已有【兵粮寸断】，则改为获得其一张牌。擂鼓进军：你视为对其使用一张【决斗】。' },
    { id: MOU_XUHUANG_SHIPO, name: '势迫', description: '结束阶段，你可以令一名体力值少于你的角色或所有判定区有【兵粮寸断】的其他角色选择一项：1.交给你一张手牌；2.受到1点伤害。若你以此法获得了牌，则你可以将其中任意张牌交给一名其他角色。' },
  ],
}

export const HISTORICAL_BATCH49_CHARACTERS: readonly CharacterDefinition[] = [B49_JIE_CAIFUREN, B49_XING_HUANGZHONG, B49_JIE_SUNLUBAN, B49_MOU_XUHUANG]
