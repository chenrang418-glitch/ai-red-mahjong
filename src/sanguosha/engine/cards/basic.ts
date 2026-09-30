import { drawCards } from '../draw'
import { MULTI_VIEWAS_ACTION, baseCardsOf, canMultiCardViewAs, multiCardGrantedAs, validateMultiCardViewAsSelection } from '../multi-card-viewas'
import { canUseCardAs, forcedIdentityFor } from '../forced-identity'
import { cardPlayable, isCardUseLocked } from '../card-play-lock'
import { ZHONGSHU_STATE, clearTargetState, hasTargetState } from '../target-state'
import { SLOT_LABELS, equipmentSlotsOf } from '../equipment-slots'
import { findLegalAction, type LegalAction } from '../actions'
import { resolveDamage } from '../damage'
import { canTarget, getDistance, ignoresDistanceTo } from '../distance'
import type { ChooseCardsRequest, GameResponse, RespondCardRequest } from '../requests'
import { validateResponse } from '../requests'
import { dodgeViewAsOptions, ignoresTrickDistance, responseViewAsOptions, skillIdsOf } from '../../data/characters/standard'
import { additionalTargetsOnUseOf, basicCardUseValueBonusOf, effectiveCardColor, effectiveCardSuit, extraSlashTargetIdsOf, extraSlashTargetsOf, getSkillRuntime, isCardResponseProhibited, isCardlessResponseProhibited, isCardUseUnresponsiveToTarget, isResponseCardProhibited, isCardUseProhibited, isTargetProhibited, sharedHandCardOwnerOf, sharedHandCardSourcesOf, slashNatureFor, skillsOf, trickDistanceBonusOf, type VirtualSlashUseContext } from '../skills/runtime'
import { performJudgment, registerJudgmentContinuation } from '../judgment'
import { isJudgmentAreaAbolished } from '../judgment-area'
import { advanceGamePhase } from '../phase'
import { recover } from '../recover'
import type { CardId, CardResolutionState, DamageNature, EquipmentSlot, EquipmentZone, PlayerId, SanguoshaState, SlashResolutionState, Suit } from '../types'
import { effectiveCardName, effectiveDamageNature, effectiveEquipmentName, locateOwnedCard, moveCard, recordCardHandEntry, setCardAlias, setCardNature, type ZoneRef } from '../zones'
import { announceSkillInvalidation, BAGUA_ACTION_ID, canInvokeBagua, handleEquipmentLost, hasUnlimitedSlash, hasWeapon, isCardIneffective, perfectBagua } from '../equipment'
import { canUseSlash, canUseSlashAtTargets, hasSlashUsesBypass, slashRules, slashTargetLimit, ZUOFEN_SONG_MARK } from '../slash-rules'
import { PASS_ROUND_ACTION } from '../nullification'
import { clearTemporaryCardSkillTag } from '../temporary-card-skill-tags'
import { GUHUO_RESPOND_ACTION, canGuhuoRespond, guhuoGrantedAs } from '../guhuo-response'
import { WEIJIE_ACTION, canWeijieRespond } from '../weijie-response'
import { RENNAI_ACTION, RENNAI_SKILL, canRennai } from '../rennai'
import { usedThisTurn } from '../turn-usage'
import { suppressArmorForCard } from '../armor-suppression'
import { cardUseTargetsOf } from '../card-use-targets'
import { equipmentPlayActions, provideSlashLookup, provideSkillLookup, askCixiongSword, askSlashTransfer, askTieji, askDodgedSlashWeapon, askMengjin, askPreDamageWeapon, provideEquipmentCallbacks, queueQilingong, type DodgedSlashFacts } from '../equipment-requests'
import { skillDisplayName } from '../presentation'
import type { CardEngineHost } from './host'
import { beginPhysicalCard, finishPhysicalCard, finishReplacedCardEffect, playerOf, playerOf as player, useAction } from './host'
import {
  DELAYED_TRICKS,
  INSTANT_TRICKS,
  advanceToNextTarget,
  askNullification,
  beginInstantTrick,
  instantTrickActions,
  resolveTrickEffectResponse,
  resolveTrickPickResponse,
  resumeTrickResolution,
  resumeTrickTarget,
} from './tricks'

export type { CardEngineHost }

export function wineUseAllowed(state: SanguoshaState, playerId: PlayerId, cardId?: CardId): boolean {
  return state.turnUsage.wineUses < 1 || skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.unlimitedWine
    || (typeof runtime.unlimitedCardUses === 'function'
      ? runtime.unlimitedCardUses(state, playerId, cardId)
      : runtime.unlimitedCardUses === true)
    || runtime.unlimitedWineFor?.(state, playerId, cardId) === true)
    || Boolean(cardId && state.players.some((owner) => owner.alive && owner.id !== playerId
      && skillsOf(state, owner.id, skillIdsOf).some((runtime) => runtime.globalUnlimitedCardUses?.(state, owner.id, playerId, cardId))))
}


/** 出牌阶段这名玩家能做的所有牌面转化。 */
function viewAsPlayOptions(state: SanguoshaState, playerId: PlayerId) {
  const own = skillsOf(state, playerId, skillIdsOf).flatMap((runtime) =>
    (runtime.viewAs?.(state, playerId) ?? []).map((option) => ({ ...option, sourceSkillId: runtime.id })))
  const global = state.players.filter((owner) => owner.alive && owner.id !== playerId).flatMap((owner) =>
    skillsOf(state, owner.id, skillIdsOf).flatMap((runtime) =>
      (runtime.globalViewAs?.(state, owner.id, playerId) ?? []).map((option) => ({ ...option, sourceSkillId: runtime.id }))))
  return [...own, ...global]
}

function canAddTargetWithoutDistance(state: SanguoshaState, playerId: PlayerId, action: Extract<LegalAction, { kind: 'use-card' }>, targetId: PlayerId): boolean {
  const target = state.players.find((candidate) => candidate.id === targetId)
  const cardName = action.asCardName
  if (!target?.alive || action.targetIds.includes(targetId)
    || isTargetProhibited(state, playerId, targetId, cardName, skillIdsOf, action.cardIds[0])) return false
  if (cardName === '杀') return targetId !== playerId
  if (DELAYED_TRICKS.has(cardName))
    return cardName !== '闪电' && canPlaceDelayedTrick(state, playerId, targetId, cardName, action.cardIds[0])
  if (!INSTANT_TRICKS.has(cardName)) return false
  if (cardName === '无中生有') return false
  if (cardName === '决斗' || cardName === '奇正相生' || cardName === '南蛮入侵' || cardName === '万箭齐发') return targetId !== playerId
  if (cardName === '五谷丰登' || cardName === '桃园结义') return true
  const playerState = state.players.find((candidate) => candidate.id === targetId)
  if (!playerState) return false
  if (cardName === '过河拆桥' || cardName === '顺手牵羊') {
    return playerState.zones.hand.length + playerState.zones.judgingArea.length
      + Object.values(playerState.zones.equipment).filter(Boolean).length > 0
  }
  if (cardName === '火攻') return playerState.zones.hand.length > 0
  if (cardName === '借刀杀人') {
    const weaponId = playerState.zones.equipment.weapon
    return Boolean(weaponId && state.players.some((victim) => victim.alive && victim.id !== targetId
      && canTarget(state, targetId, victim.id, undefined, weaponId)
      && !isTargetProhibited(state, targetId, victim.id, '杀', skillIdsOf, weaponId)))
  }
  if (cardName === '铁索连环') return true
  return false
}

/** 让技能在生成合法动作时提供真实的加/减目标选择，而非结算后伪造目标变化。 */
export function withNextCardTargetChoices(
  state: SanguoshaState,
  playerId: PlayerId,
  actions: LegalAction[],
  skillIdsFor: (characterId: string) => string[] = skillIdsOf,
): LegalAction[] {
  const result = [...actions]
  for (const action of actions) {
    if (action.kind !== 'use-card' || action.targetIds.length === 0) continue
    const modifiers = skillsOf(state, playerId, skillIdsFor)
      .filter((runtime) => runtime.modifiesNextCardTargets?.(state, playerId, action.cardIds[0], action.asCardName)
        || runtime.slashTargetExpansionForAction?.(state, playerId, action.cardIds[0], action.targetIds))
    if (!modifiers.length) continue
    const cardName = action.asCardName
    const category = cardName === '杀' || cardName === '闪' || cardName === '桃' || cardName === '酒'
      ? 'basic' : INSTANT_TRICKS.has(cardName) || DELAYED_TRICKS.has(cardName) ? 'trick' : null
    if (!category) continue
    const expansionEntries = modifiers.flatMap((runtime) => {
      const expansions = [
        runtime.nextCardTargetExpansion?.(state, playerId, action.cardIds[0], cardName),
        cardName === '杀' ? runtime.slashTargetExpansionForAction?.(state, playerId, action.cardIds[0], action.targetIds) : null,
      ]
      return expansions.filter((expansion): expansion is NonNullable<typeof expansion> => Boolean(expansion && expansion.maxAdditionalTargets > 0))
        .map((expansion) => ({ runtime, expansion }))
    })
    const expansions = expansionEntries.map(({ expansion }) => expansion)
    if (expansions.length) {
      const candidateIds = [...new Set(expansions.flatMap((expansion) => expansion.candidateIds))]
        .filter((targetId) => canAddTargetWithoutDistance(state, playerId, action, targetId))
      const maxAdditional = Math.min(candidateIds.length,
        expansions.reduce((total, expansion) => total + Math.max(0, Math.trunc(expansion.maxAdditionalTargets)), 0))
      const addCombinations = (start: number, chosen: PlayerId[]) => {
        if (chosen.length) {
          const targetIds = [...action.targetIds, ...chosen]
          const names = chosen.map((targetId) => state.players.find((target) => target.id === targetId)?.nickname ?? '角色')
          const chosenExpansion = expansionEntries.find(({ expansion }) => chosen.some((targetId) => expansion.candidateIds.includes(targetId)))
          result.push({ ...action, id: `${action.id}:target-plus:${chosen.join(',')}`, targetIds,
            targetMin: targetIds.length, targetMax: targetIds.length,
            ...(chosenExpansion ? { targetExpansionSkillId: chosenExpansion.runtime.id,
              targetExpansionTargetId: chosen.find((targetId) => chosenExpansion.expansion.candidateIds.includes(targetId)) } : {}),
            label: `${action.label}（额外指定${names.join('、')}）` })
        }
        if (chosen.length >= maxAdditional) return
        for (let index = start; index < candidateIds.length; index += 1)
          addCombinations(index + 1, [...chosen, candidateIds[index]])
      }
      addCombinations(0, [])
      continue
    }
    if (action.targetIds.length > 1) {
      for (const removedId of action.targetIds) {
        const targetIds = action.targetIds.filter((id) => id !== removedId)
        if (targetIds.length === 0) continue
        result.push({ ...action, id: `${action.id}:target-minus:${removedId}`, targetIds,
          targetMin: targetIds.length, targetMax: targetIds.length,
          label: `${action.label}（巧说：少指定${state.players.find((target) => target.id === removedId)?.nickname ?? '一名角色'}）` })
      }
    }
    for (const target of state.players) {
      if (!canAddTargetWithoutDistance(state, playerId, action, target.id)) continue
      const targetIds = [...action.targetIds, target.id]
      result.push({ ...action, id: `${action.id}:target-plus:${target.id}`, targetIds,
        targetMin: targetIds.length, targetMax: targetIds.length,
        label: `${action.label}（巧说：额外指定${target.nickname}，无距离限制）` })
    }
  }
  return result
}

function hasDelayedTrick(state: SanguoshaState, playerId: PlayerId, name: string): boolean {
  return player(state, playerId).zones.judgingArea.some((cardId) => effectiveCardName(state, cardId) === name)
}

function canPlaceDelayedTrick(state: SanguoshaState, sourceId: PlayerId, targetId: PlayerId, name: string, cardId: CardId, ignoreDistance = false): boolean {
  const target = player(state, targetId)
  if (!target.alive) return false
  if (isJudgmentAreaAbolished(state, targetId)) return false
  if (name === '闪电') return targetId === sourceId && !hasDelayedTrick(state, targetId, name)
  if (targetId === sourceId || hasDelayedTrick(state, targetId, name)) return false
  if (isTargetProhibited(state, sourceId, targetId, name, skillIdsOf, cardId)) return false
  if (name !== '兵粮寸断') return true
  if (ignoreDistance || ignoresTrickDistance(state, sourceId, cardId)) return true
  // 英霸：对有自己平定标记的角色使用牌不受距离限制，延时锦囊也算「使用牌」
  if (ignoresDistanceTo(state, sourceId, targetId, cardId)) return true
  return getDistance(state, sourceId, targetId) <= 1 + trickDistanceBonusOf(state, sourceId, targetId, name, skillIdsOf)
}

function suitLabel(suit: Suit): string {
  return { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }[suit]
}

/** 只从当前公开规则状态生成操作；客户端不自行推断距离或卡牌用途。 */
export function legalPlayActions(state: SanguoshaState, playerId: PlayerId): LegalAction[] {
  if (state.status !== 'playing' || state.phase !== 'play' || state.currentPlayerId !== playerId || state.pendingRequests.length > 0 || state.cardResolution) return []
  const source = player(state, playerId)
  if (!source.alive) return []
  const actions: LegalAction[] = [{ id: 'play:pass', kind: 'pass', playerId, label: '结束出牌', requestId: `play-${state.turnNumber}` }]
  const allCardUseBlocked = isCardUseProhibited(state, playerId, '', { dyingPlayerId: null }, skillIdsOf)

  // 主动技（苦肉等）：技能自己报告现在能不能发动，前端不猜
  for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
    if (allCardUseBlocked && runtime.activeActionUsesCard) continue
    for (const option of runtime.activeActions?.(state, playerId) ?? []) {
      actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: runtime.id, cardIds: [], targetIds: [] })
    }
  }

  // 主公技授权（黄天）：动作出现在**别人**的出牌阶段，所以要扫全场的技能，
  // 而不只是当前玩家自己的。技能 id 记在动作上，执行时才知道回调谁。
  for (const other of state.players) {
    if (!other.alive || other.id === playerId) continue
    for (const runtime of skillsOf(state, other.id, skillIdsOf)) {
      for (const option of runtime.grantsPlayActions?.(state, other.id, playerId) ?? []) {
        actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: runtime.id, cardIds: [], targetIds: [] })
      }
    }
  }

  // 转化技（武圣、龙胆）：把「这张红牌当杀打某人」作为独立动作发出去。
  // 不能让前端自己猜牌的用途——同一张红牌既可以原样用，也可以当杀，
  // 必须两条动作都在，玩家才选得到用途。
  const viewAsOptions = viewAsPlayOptions(state, playerId)
  for (const option of viewAsOptions) {
    // 转化用的**子牌**也受花色禁令约束：动的仍然是那张实体牌
    if (!cardPlayable(state, playerId, option.cardId)) continue
    const duplicate = viewAsOptions.some((candidate) => candidate !== option
      && candidate.cardId === option.cardId && candidate.asCardName === option.asCardName)
    actions.push(...declaredCardActions(state, playerId, option.cardId, option.asCardName, option.label,
      { nature: option.nature, sourceSkillId: option.sourceSkillId, disambiguateId: duplicate, retainMaterial: option.retainCard }))
  }

  // 多牌技能只有明确声明 activePlaySuits 时才生成主动用牌动作。
  // 龙魂据此为玩家列出一张或两张同花色牌的所有合法桃/火杀目标组合。
  if (!allCardUseBlocked) {
    for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
      const spec = runtime.multiCardViewAs?.(state, playerId)
      if (!spec?.activePlaySuits?.length) continue
      const maxCount = Math.max(spec.requiredCount, spec.maxCount ?? spec.requiredCount)
      for (const suit of spec.activePlaySuits) {
        const asCardName = spec.suitToCardName[suit]
        if (!asCardName) continue
        const candidates = baseCardsOf(state, playerId, suit, spec.handOnly)
          .filter((id) => cardPlayable(state, playerId, id) && !isCardUseLocked(state, playerId, id))
        for (let count = spec.requiredCount; count <= Math.min(maxCount, candidates.length); count += 1) {
          const combinations: CardId[][] = []
          const collect = (start: number, chosen: CardId[]) => {
            if (chosen.length === count) { combinations.push(chosen); return }
            for (let index = start; index <= candidates.length - (count - chosen.length); index += 1)
              collect(index + 1, [...chosen, candidates[index]])
          }
          collect(0, [])
          for (const cardIds of combinations) {
            const [carrierId] = cardIds
            const generated = declaredCardActions(state, playerId, carrierId, asCardName,
              `【${spec.skillName ?? '龙魂'}】选择${count}张${suitLabel(suit)}牌`,
              { sourceSkillId: runtime.id, nature: spec.natureOf?.[suit], disambiguateId: true })
            for (const action of generated) {
              if (action.kind !== 'use-card') continue
              actions.push({ ...action, cardIds,
                id: `play:multi-viewas:${runtime.id}:${cardIds.join(',')}:${asCardName}:${action.targetIds.join(',') || 'self'}`,
                label: `【${spec.skillName ?? '龙魂'}】${count}张${suitLabel(suit)}牌当【${asCardName}】使用${action.targetIds.length && action.targetIds[0] !== playerId ? `，目标${action.targetIds.map((id) => player(state, id).nickname).join('、')}` : ''}`,
              })
            }
          }
        }
      }
    }
  }

  // 丈八蛇矛和方天画戟都会产生大量组合（6 张手牌 × 4 个目标就是 60 条动作，
  // 界面上选中一张牌会冒出 20 个按钮，手机上根本没法用）。
  // 改成和主动技一样的两步交互：一个按钮，然后选牌、选目标。
  if (!allCardUseBlocked) {
    for (const option of equipmentPlayActions(state, playerId)) {
      actions.push({ id: option.id, kind: 'invoke-skill', playerId, label: option.label, skillId: option.skillId, cardIds: [], targetIds: [] })
    }
  }

  for (const cardId of source.zones.hand) {
    const card = state.cards[cardId]
    if (!card) continue
    // 被花色禁令锁住的牌不能使用（气海禁红桃）；弃置、交给不受影响
    if (!cardPlayable(state, playerId, cardId)) continue
    /*
     * 身份被强制改写的手牌（神刘备【龙怒】）**只出转化后的动作**，
     * 原用途一条都不出——「均视为火【杀】」是强制的，不是多给一个入口。
     * 转出来的【杀】是否无次数、是否无距离，由这条改写自己说了算，
     * 和玩家本来的出杀次数按统一规则聚合。
     */
    const forced = forcedIdentityFor(state, playerId, cardId)
    if (forced) {
      if (forced.asCardName === '杀') {
        const forcedUnlimited = hasUnlimitedSlash(state, playerId, cardId) || forced.unlimitedUses
        // 次数用光了也可能还有定向豁免的目标（高顺【陷阵】），所以这里不能直接跳过
        if (!canUseSlash(state, playerId, forcedUnlimited) && !hasSlashUsesBypass(state, playerId)) continue
        for (const combo of slashTargetCombos(state, playerId, cardId, slashNatureFor(state, playerId, forced.nature))) {
          if (!canUseSlashAtTargets(state, playerId, forcedUnlimited, combo)) continue
          const names = combo.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
          actions.push({
            ...useAction(cardId, playerId, '杀', combo, `将【${card.name}】当作${natureLabel(forced.nature)}【杀】对${names}使用`),
            id: combo.length > 1 ? `play:${cardId}:${combo.join(',')}` : `play:${cardId}:${combo[0]}`,
          })
        }
        continue
      }
      /*
       * 单张具体 Card ID 的声明身份（华歆【草诏】）还可能是【桃】/【酒】或
       * 一张普通锦囊——那几类原本各自的合法性判断照抄一遍即可，不新增机制。
       */
      if (forced.scope === 'card') {
        if (forced.asCardName === '桃' && source.hp < source.maxHp) {
          actions.push(useAction(cardId, playerId, '桃', [playerId], `将【${card.name}】当作【桃】使用`))
        } else if (forced.asCardName === '酒' && wineUseAllowed(state, playerId, cardId)) {
          actions.push(useAction(cardId, playerId, '酒', [playerId], `将【${card.name}】当作【酒】使用`))
        } else if (INSTANT_TRICKS.has(forced.asCardName)) {
          actions.push(...instantTrickActions(state, playerId, cardId, forced.asCardName))
        }
      }
      continue
    }
    if (card.name === '杀'
      && (canUseSlash(state, playerId, hasUnlimitedSlash(state, playerId, cardId)) || hasSlashUsesBypass(state, playerId))) {
      // 属性按**最终**属性算：火【杀】的额外目标（程普【疠火】）对实体火杀同样生效
      for (const combo of slashTargetCombos(state, playerId, cardId, slashNatureFor(state, playerId, effectiveDamageNature(state, cardId)))) {
        // 定向豁免只在**每个目标**都被豁免时才成立，不能捎带普通目标
        if (!canUseSlashAtTargets(state, playerId, hasUnlimitedSlash(state, playerId, cardId), combo)) continue
        const names = combo.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
        actions.push({
          ...useAction(cardId, playerId, '杀', combo, `对${names}使用【杀】`),
          // 多目标那条要有自己的 id，否则和单目标那条撞在一起
          id: combo.length > 1 ? `play:${cardId}:${combo.join(',')}` : `play:${cardId}:${combo[0]}`,
        })
      }
    } else if (card.name === '桃' && source.hp < source.maxHp) {
      actions.push(useAction(cardId, playerId, '桃', [playerId], '使用【桃】回复体力'))
    } else if (card.name === '酒' && wineUseAllowed(state, playerId, cardId)) {
      actions.push(useAction(cardId, playerId, '酒', [playerId], '使用【酒】强化下一张杀'))
    } else if (card.category === 'equipment' && card.equipmentSlot) {
      const equipmentName = effectiveEquipmentName(state, cardId)
      const slots = equipTargetSlots(state, playerId, card.equipmentSlot)
      // 一个能装的栏都没有（栏被废除了）就不给这条动作
      if (slots.length === 0) continue
      if (slots.length === 1) {
        actions.push(useAction(cardId, playerId, equipmentName, [playerId], `装备【${equipmentName}】`, undefined, slots[0]))
      } else {
        /*
         * 两个武器栏都占着（神典韦【捐甲】）：顶掉哪一把由玩家决定。
         * 自动顶掉第一栏是错的——他可能正想留着那把。
         */
        for (const slot of slots) {
          const occupied = playerOf(state, playerId).zones.equipment[slot as keyof EquipmentZone]
          const occupiedName = occupied ? state.cards[occupied]?.name ?? '' : ''
          actions.push(useAction(
            cardId, playerId, card.name, [playerId],
            `装备【${equipmentName}】到${SLOT_LABELS[slot]}${occupiedName ? `（替换【${occupiedName}】）` : ''}`,
            undefined, slot,
          ))
        }
      }
    } else if (INSTANT_TRICKS.has(card.name)) {
      actions.push(...instantTrickActions(state, playerId, cardId))
    } else if (card.name === '乐不思蜀') {
      for (const target of state.players.filter((candidate) => canPlaceDelayedTrick(state, playerId, candidate.id, card.name, cardId))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【乐不思蜀】`))
      }
    } else if (card.name === '兵粮寸断') {
      for (const target of state.players.filter((candidate) => canPlaceDelayedTrick(state, playerId, candidate.id, card.name, cardId))) {
        actions.push(useAction(cardId, playerId, card.name, [target.id], `对${target.nickname}使用【兵粮寸断】`))
      }
    } else if (card.name === '闪电' && canPlaceDelayedTrick(state, playerId, playerId, card.name, cardId)) {
      actions.push(useAction(cardId, playerId, card.name, [playerId], '将【闪电】置入自己的判定区'))
    }
  }
  if (!allCardUseBlocked) {
    for (const runtime of skillsOf(state, playerId, skillIdsOf)) {
      for (const pile of runtime.playableCharacterPiles?.(state, playerId) ?? []) {
        for (const cardId of source.characterPiles[pile] ?? []) {
          actions.push(...characterPileCardUseActions(state, playerId, playerId, cardId, runtime.id))
        }
      }
    }
  }
  for (const { ownerId: cardOwnerId, cardIds } of sharedHandCardSourcesOf(state, playerId)) {
    const cardOwner = player(state, cardOwnerId)
    for (const cardId of cardIds) {
      const card = state.cards[cardId]
      if (!card || !cardPlayable(state, playerId, cardId) || isCardUseLocked(state, playerId, cardId)) continue
      let sharedActions: LegalAction[] = []
      if (card.category === 'equipment' && card.equipmentSlot) {
        const slots = equipTargetSlots(state, playerId, card.equipmentSlot)
        sharedActions = slots.map((slot) => ({
          ...useAction(cardId, playerId, effectiveEquipmentName(state, cardId), [playerId],
            `使用${cardOwner.nickname}共享的【${card.name}】`, undefined, slot), cardOwnerId,
        }))
      } else {
        sharedActions = declaredCardActions(state, playerId, cardId, card.name, `使用${cardOwner.nickname}共享的【${card.name}】`)
          .map((action) => action.kind === 'use-card' ? { ...action, cardOwnerId } : action)
      }
      actions.push(...sharedActions)
    }
  }
  return withNextCardTargetChoices(state, playerId, actions.filter((action) => action.kind !== 'use-card'
    || (!action.cardIds.some((cardId) => isCardUseLocked(state, playerId, cardId))
      && !isCardUseProhibited(state, playerId, action.asCardName, { dyingPlayerId: null, cardIds: action.cardIds }, skillIdsOf))))
}

/**
 * Legal physical hand-card uses granted by a skill outside the normal play phase.
 * Generate against a play-phase view without mutating the live game state.
 */
export function skillHandCardUseActions(state: SanguoshaState, playerId: PlayerId, cardId: CardId): Extract<LegalAction, { kind: 'use-card' }>[] {
  const owner = state.players.find((candidate) => candidate.id === playerId)
  const card = state.cards[cardId]
  if (!owner?.alive || !owner.zones.hand.includes(cardId) || !card
    || state.pendingRequests.length || state.cardResolution) return []
  const skillPhaseView = { ...state, phase: 'play' as const, currentPlayerId: playerId }
  return legalPlayActions(skillPhaseView, playerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
    action.kind === 'use-card' && action.cardIds.length === 1 && action.cardIds[0] === cardId
      && !action.id.startsWith('play:recast:'))
}

/** 生成技能授权直接使用处理区实体牌的合法动作，不移动实体牌或伪造摸牌记录。 */
export function skillProcessingCardUseActions(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
): Extract<LegalAction, { kind: 'use-card' }>[] {
  const actor = state.players.find((candidate) => candidate.id === playerId)
  if (!actor?.alive || !state.zones.processingArea.includes(cardId) || !state.cards[cardId]
    || state.pendingRequests.length || state.cardResolution) return []
  const originalHand = actor.zones.hand
  actor.zones.hand = [...originalHand, cardId]
  try {
    const view = { ...state, phase: 'play' as const, currentPlayerId: playerId }
    return legalPlayActions(view, playerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.cardIds.length === 1 && action.cardIds[0] === cardId
        && !action.id.startsWith('play:recast:'))
  } finally {
    actor.zones.hand = originalHand
  }
}

/** 合法动作预览：本次技能可授权使用另一角色手牌，但牌的实际持有者保持不变。 */
export function skillOtherHandCardUseActions(
  state: SanguoshaState,
  playerId: PlayerId,
  physicalOwnerId: PlayerId,
  cardId: CardId | CardId[],
  asCardName?: string,
  sourceSkillId?: string,
  nature?: DamageNature,
  options: { allowSelf?: boolean; ignoreDistance?: boolean; ignoreUsageLimits?: boolean } = {},
): Extract<LegalAction, { kind: 'use-card' }>[] {
  const player = state.players.find((candidate) => candidate.id === playerId)
  const physicalOwner = state.players.find((candidate) => candidate.id === physicalOwnerId)
  const cardIds = Array.isArray(cardId) ? [...new Set(cardId)] : [cardId]
  if (!player?.alive || !physicalOwner?.alive || (playerId === physicalOwnerId && !options.allowSelf) || !cardIds.length
    || !cardIds.every((id) => physicalOwner.zones.hand.includes(id)) || state.pendingRequests.length || state.cardResolution) return []
  const originalHand = player.zones.hand
  player.zones.hand = [...originalHand, ...cardIds]
  try {
    const view = { ...state, phase: 'play' as const, currentPlayerId: playerId }
    if (options.allowSelf) {
      const card = state.cards[cardIds[0]!]
      if (!card) return []
      return declaredCardActions(view, playerId, cardIds[0]!, asCardName ?? card.name,
        `【${sourceSkillId ?? '技能'}】使用【${asCardName ?? card.name}】`, {
          ...(sourceSkillId ? { sourceSkillId } : {}), ...(nature ? { nature } : {}),
          ignoreDistance: options.ignoreDistance, ignoreUsageLimits: options.ignoreUsageLimits,
        }).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
        .map((action) => ({ ...action, cardIds, cardOwnerId: physicalOwnerId }))
    }
    if (asCardName) return declaredCardActions(view, playerId, cardIds[0]!, asCardName,
      `视为${player.nickname}使用【${asCardName}】`, { ...(sourceSkillId ? { sourceSkillId } : {}), ...(nature ? { nature } : {}) })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
      .map((action) => ({ ...action, cardIds, cardOwnerId: physicalOwnerId }))
    return legalPlayActions(view, playerId)
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
        action.kind === 'use-card' && action.cardIds.length === cardIds.length && cardIds.every((id) => action.cardIds.includes(id))
          && !action.id.startsWith('play:recast:'))
      .map((action) => ({ ...action, cardOwnerId: physicalOwnerId }))
  } finally {
    player.zones.hand = originalHand
  }
}

/** 技能授权将他人手牌转化为即时锦囊；材料仍由原持有人支付。 */
export function skillOtherHandDeclaredCardUseActions(
  state: SanguoshaState,
  playerId: PlayerId,
  physicalOwnerId: PlayerId,
  cardId: CardId,
  asCardName: string,
  sourceSkillId: string,
): Extract<LegalAction, { kind: 'use-card' }>[] {
  const player = playerOf(state, playerId)
  const physicalOwner = playerOf(state, physicalOwnerId)
  if (!player?.alive || !physicalOwner?.alive || playerId === physicalOwnerId
    || !physicalOwner.zones.hand.includes(cardId) || state.pendingRequests.length || state.cardResolution) return []
  const originalHand = player.zones.hand
  player.zones.hand = [...originalHand, cardId]
  try {
    const view = { ...state, phase: 'play' as const, currentPlayerId: playerId }
    return declaredCardActions(view, playerId, cardId, asCardName,
      `【${sourceSkillId}】将展示牌当【${asCardName}】使用`, { sourceSkillId })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
      .map((action) => ({ ...action, cardOwnerId: physicalOwnerId }))
  } finally {
    player.zones.hand = originalHand
  }
}

/** 执行他人手牌转化出的实体锦囊，沿用通用卡牌使用与效果结算链。 */
export function beginSkillDeclaredCardUseFromOtherHand(
  host: CardEngineHost,
  options: { playerId: PlayerId; physicalOwnerId: PlayerId; cardId: CardId; asCardName: string; targetIds: PlayerId[]; sourceSkillId: string },
): boolean {
  if (host.state.skillCardOwnerOverride || host.state.cardResolution || host.state.pendingRequests.length) return false
  const action = skillOtherHandDeclaredCardUseActions(host.state, options.playerId, options.physicalOwnerId,
    options.cardId, options.asCardName, options.sourceSkillId)
    .find((candidate) => candidate.targetIds.length === options.targetIds.length
      && candidate.targetIds.every((targetId, index) => targetId === options.targetIds[index]))
  if (!action) return false
  host.state.skillCardOwnerOverride = { playerId: options.playerId, physicalOwnerId: options.physicalOwnerId,
    cardId: options.cardId, sourceSkillId: options.sourceSkillId }
  try {
    recordPlayDecision(host, options.playerId, action.id)
    executeUseCardAction(host, options.playerId, action, { skipPlayInterceptors: true })
    return true
  } catch (error) {
    delete host.state.skillCardOwnerOverride
    throw error
  }
}

/** 执行技能授权的他人手牌使用；所有牌规则仍由普通使用管线结算。 */
export function beginSkillCardUseFromOtherHand(
  host: CardEngineHost,
  playerId: PlayerId,
  physicalOwnerId: PlayerId,
  cardId: CardId | CardId[],
  sourceSkillId: string,
  actionId: string,
  asCardName?: string,
  nature?: DamageNature,
  options: { allowSelf?: boolean; ignoreDistance?: boolean; ignoreUsageLimits?: boolean } = {},
): boolean {
  if (host.state.skillCardOwnerOverride || host.state.cardResolution || host.state.pendingRequests.length) return false
  const action = skillOtherHandCardUseActions(host.state, playerId, physicalOwnerId, cardId, asCardName, sourceSkillId, nature, options)
    .find((candidate) => candidate.id === actionId)
  if (!action) return false
  const cardIds = Array.isArray(cardId) ? cardId : [cardId]
  host.state.skillCardOwnerOverride = { playerId, physicalOwnerId, cardId: cardIds[0]!, cardIds, sourceSkillId }
  try {
    recordPlayDecision(host, playerId, actionId)
    executeUseCardAction(host, playerId, { ...action, sourceSkillId }, { skipPlayInterceptors: true,
      countSlashUsage: options.ignoreUsageLimits ? false : undefined, ignoreUsageLimits: options.ignoreUsageLimits })
    return true
  } catch (error) {
    delete host.state.skillCardOwnerOverride
    throw error
  }
}

/** 技能允许使用留在处理区的实体牌时，先按普通出牌规则生成候选，再走标准使用结算。 */
export function beginSkillCardUseFromProcessing(
  host: CardEngineHost,
  playerId: PlayerId,
  cardId: CardId,
  sourceSkillId: string,
  actionId: string,
): boolean {
  const player = host.state.players.find((candidate) => candidate.id === playerId)
  if (!player?.alive || host.state.cardResolution || host.state.pendingRequests.length
    || !host.state.zones.processingArea.includes(cardId)) return false
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'hand', playerId })
  const action = skillHandCardUseActions(host.state, playerId, cardId).find((candidate) => candidate.id === actionId)
  if (!action) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'processingArea' })
    return false
  }
  recordPlayDecision(host, playerId, actionId)
  executeUseCardAction(host, playerId, { ...action, sourceSkillId }, { skipPlayInterceptors: true })
  return true
}

/**
 * 在技能明确授权的情况下，从弃牌堆使用一张实体牌；可选地声明为另一张牌。
 * 仍由普通动作生成器校验距离、次数、目标与禁止使用规则，随后进入原有结算链。
 */
export function beginSkillCardUseFromDiscard(
  host: CardEngineHost,
  playerId: PlayerId,
  cardId: CardId,
  sourceSkillId: string,
  actionId: string,
  asCardName?: string,
  options: { ignoreDistance?: boolean; ignoreUsageLimits?: boolean } = {},
): boolean {
  const actor = player(host.state, playerId)
  if (!actor?.alive || host.state.cardResolution || host.state.pendingRequests.length
    || !host.state.zones.discardPile.includes(cardId)) return false
  const action = skillDiscardCardUseActions(host.state, playerId, cardId, sourceSkillId, asCardName, options)
    .find((candidate) => candidate.id === actionId)
  if (!action) return false
  moveCard(host.state, cardId, { kind: 'discardPile' }, { kind: 'hand', playerId })
  recordPlayDecision(host, playerId, actionId)
  executeUseCardAction(host, playerId, { ...action, sourceSkillId }, { skipPlayInterceptors: true,
    ignoreUsageLimits: options.ignoreUsageLimits })
  return true
}

/** 生成技能授权从弃牌堆使用实体牌的合法动作，供目标交互 UI 显示。 */
export function skillDiscardCardUseActions(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  sourceSkillId: string,
  asCardName?: string,
  options: { ignoreDistance?: boolean; ignoreUsageLimits?: boolean } = {},
): Extract<LegalAction, { kind: 'use-card' }>[] {
  const actor = state.players.find((candidate) => candidate.id === playerId)
  if (!actor?.alive || !state.zones.discardPile.includes(cardId) || state.cardResolution || state.pendingRequests.length) return []
  const discardIndex = state.zones.discardPile.indexOf(cardId)
  state.zones.discardPile.splice(discardIndex, 1)
  actor.zones.hand.push(cardId)
  try {
    const view = { ...state, phase: 'play' as const, currentPlayerId: playerId }
    if (asCardName) return declaredCardActions(view, playerId, cardId, asCardName,
      `【${sourceSkillId}】使用【${asCardName}】`, { sourceSkillId, ignoreDistance: options.ignoreDistance,
        ignoreUsageLimits: options.ignoreUsageLimits })
      .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card')
    return legalPlayActions(view, playerId).filter((action): action is Extract<LegalAction, { kind: 'use-card' }> =>
      action.kind === 'use-card' && action.cardIds.length === 1 && action.cardIds[0] === cardId
      && !action.id.startsWith('play:recast:'))
  } finally {
    actor.zones.hand = actor.zones.hand.filter((id) => id !== cardId)
    state.zones.discardPile.splice(discardIndex, 0, cardId)
  }
}

/** Use a revealed processing-area card for a different acting player under explicit skill permissions. */
export function beginSkillCardUseFromProcessingAs(
  host: CardEngineHost,
  options: { playerId: PlayerId; cardId: CardId; targetIds: PlayerId[]; sourceSkillId: string; ignoreDistance?: boolean; ignoreUsageLimits?: boolean },
): boolean {
  const actor = player(host.state, options.playerId)
  const card = host.state.cards[options.cardId]
  if (!actor?.alive || !card || !host.state.zones.processingArea.includes(options.cardId)
    || host.state.cardResolution || host.state.pendingRequests.length) return false
  moveCard(host.state, options.cardId, { kind: 'processingArea' }, { kind: 'hand', playerId: options.playerId })
  const action = declaredCardActions(host.state, options.playerId, options.cardId, card.name,
    `因【${options.sourceSkillId}】使用【${card.name}】`, {
      sourceSkillId: options.sourceSkillId, ignoreDistance: options.ignoreDistance, ignoreUsageLimits: options.ignoreUsageLimits,
    }).find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card'
      && candidate.targetIds.length === options.targetIds.length
      && candidate.targetIds.every((targetId, index) => targetId === options.targetIds[index]))
  if (!action) {
    moveCard(host.state, options.cardId, { kind: 'hand', playerId: options.playerId }, { kind: 'processingArea' })
    return false
  }
  executeUseCardAction(host, options.playerId, action, { skipPlayInterceptors: true, countSlashUsage: false,
    ignoreUsageLimits: options.ignoreUsageLimits })
  return true
}

/**
 * 「把某张牌当作另一张牌用」能产生哪些合法动作。
 *
 * 转化技（武圣、龙胆、奇袭、国色）和于吉【蛊惑】的声明牌**共用这一份合法性**：
 * 出杀次数、攻击范围、距离、禁止目标、同名延时锦囊不能叠……全在这里算一次。
 * 蛊惑解决的是「实体牌和声明牌不一致」，不是绕开牌规则，所以它必须走这里。
 *
 * 返回空数组就表示「现在不能这样用」——调用方据此把这个声明从候选里去掉。
 */
export function declaredCardActions(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId: CardId,
  asCardName: string,
  label: string,
  /** 转化后这张【杀】的属性；决定「火【杀】多一个目标」这类按属性给的加成。 */
  options: { nature?: DamageNature; sourceSkillId?: string; disambiguateId?: boolean; retainMaterial?: boolean; ignoreSlashQuota?: boolean; ignoreDistance?: boolean; ignoreUsageLimits?: boolean; fixedTargetIds?: PlayerId[]; maxTargetsOverride?: number } = {},
): LegalAction[] {
  const actions: LegalAction[] = []
  if (isCardUseLocked(state, playerId, cardId)) return actions
  if (asCardName === '杀') {
    // 转化出来的杀同样受本回合的临时规则约束：天义失败时武圣、龙胆、蛊惑
    // 一律用不出杀，不能只把手牌那条藏起来
    const quotaBypass = skillsOf(state, playerId, skillIdsOf).some((runtime) => runtime.slashUseQuotaBypass?.(state, playerId, cardId) === true)
    const unlimited = options.ignoreSlashQuota || hasUnlimitedSlash(state, playerId, cardId) || quotaBypass
    if (!canUseSlash(state, playerId, unlimited) && !hasSlashUsesBypass(state, playerId)) return actions
    if (options.fixedTargetIds) {
      const targetIds = [...options.fixedTargetIds]
      if (!targetIds.length || new Set(targetIds).size !== targetIds.length
        || targetIds.length > (options.maxTargetsOverride ?? slashTargetLimit(state, playerId, slashNatureFor(state, playerId, options.nature ?? effectiveDamageNature(state, cardId))))
        || targetIds.some((targetId) => targetId === playerId || !state.players.some((target) => target.id === targetId && target.alive)
          || (!options.ignoreDistance && !canTarget(state, playerId, targetId, undefined, cardId))
          || isTargetProhibited(state, playerId, targetId, '杀', skillIdsOf, cardId, options.sourceSkillId))) return actions
      if (!options.maxTargetsOverride && !canUseSlashAtTargets(state, playerId, unlimited, targetIds)) return actions
      const names = targetIds.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
      actions.push({
        ...useAction(cardId, playerId, '杀', targetIds, `${label}，目标${names}`),
        ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
        ...(options.nature ? { nature: options.nature } : {}),
        id: `play:viewas:${cardId}:${targetIds.join(',')}${options.disambiguateId ? `:${options.sourceSkillId}` : ''}`,
      })
      return actions
    }
    for (const combo of slashTargetCombos(state, playerId, cardId, slashNatureFor(state, playerId, options.nature ?? effectiveDamageNature(state, cardId)))) {
      if (!canUseSlashAtTargets(state, playerId, unlimited, combo)) continue
      const names = combo.map((id) => state.players.find((candidate) => candidate.id === id)!.nickname).join('、')
      actions.push({
        ...useAction(cardId, playerId, '杀', combo, `${label}，目标${names}`),
        ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
        ...(options.nature ? { nature: options.nature } : {}),
        ...(options.retainMaterial ? { retainMaterial: true } : {}),
        id: `play:viewas:${cardId}:${combo.join(',')}${options.disambiguateId ? `:${options.sourceSkillId}` : ''}`,
      })
    }
    return actions
  }
  // 转化成延时锦囊（大乔【国色】）：放进目标判定区，判定时按转化后的牌名结算
  if (DELAYED_TRICKS.has(asCardName)) {
    for (const target of state.players) {
      if (!canPlaceDelayedTrick(state, playerId, target.id, asCardName, cardId, options.ignoreDistance)) continue
      actions.push({
        ...useAction(cardId, playerId, asCardName, [target.id], `${label}，目标${target.nickname}`),
        ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
        ...(options.retainMaterial ? { retainMaterial: true } : {}),
        ...(options.disambiguateId ? { id: `play:viewas:${cardId}:${target.id}:${options.sourceSkillId}` } : {}),
        id: `play:viewas:${cardId}:${target.id}${options.disambiguateId ? `:${options.sourceSkillId}` : ''}`,
      })
    }
    return actions
  }
  // 转化成普通锦囊（甘宁【奇袭】）：目标合法性按转化后的牌名算。
  // 之前这里只处理【杀】，于是奇袭虽然注册了却永远产生不出动作——
  // 「服务端支持不等于前端点得到」，这种情况下连服务端都没支持。
  if (INSTANT_TRICKS.has(asCardName)) {
    for (const trick of instantTrickActions(state, playerId, cardId, asCardName, { ignoreDistance: options.ignoreDistance })) {
      if (trick.kind !== 'use-card') continue
      if (trick.targetIds.some((targetId) => isTargetProhibited(state, playerId, targetId, asCardName, skillIdsOf, cardId, options.sourceSkillId))) continue
      actions.push({
        ...trick,
        ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
        // 【连环】转化出的铁索仍要保留“重铸”动作前缀；执行层和 AI 都用
        // 这个前缀区分“使用锦囊”和“弃牌摸一张”，不能统一改成 viewas。
        id: trick.id.startsWith('play:recast:')
          ? `play:recast:viewas:${cardId}`
          : `play:viewas:${cardId}:${trick.targetIds.join(',') || 'self'}${options.disambiguateId ? `:${options.sourceSkillId}` : ''}`,
        label: `${label}，${trick.label}`,
      })
    }
    return actions
  }
  // 基本牌里只有【桃】【酒】能对自己用；【闪】在出牌阶段用不了
  const owner = player(state, playerId)
  if (asCardName === '桃' && owner.hp < owner.maxHp) {
    actions.push({ ...useAction(cardId, playerId, '桃', [playerId], `${label}，回复体力`),
      ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
        ...(options.retainMaterial ? { retainMaterial: true } : {}),
      ...(options.disambiguateId ? { id: `play:viewas:${cardId}:${playerId}:${options.sourceSkillId}` } : {}) })
  } else if (asCardName === '酒' && (options.ignoreUsageLimits || wineUseAllowed(state, playerId, cardId))) {
    actions.push({ ...useAction(cardId, playerId, '酒', [playerId], `${label}，强化下一张杀`),
      ...(options.sourceSkillId ? { sourceSkillId: options.sourceSkillId } : {}),
      ...(options.retainMaterial ? { retainMaterial: true } : {}),
      ...(options.disambiguateId ? { id: `play:viewas:${cardId}:${playerId}:${options.sourceSkillId}` } : {}) })
  }
  return actions
}

/** A skill-timed physical basic card use outside the ordinary play phase. */
export function beginSkillBasicUse(
  host: CardEngineHost,
  options: { sourceId: PlayerId; cardId: CardId; cardName: string; targetIds: PlayerId[]; sourceSkillId: string },
): boolean {
  const source = playerOf(host.state, options.sourceId)
  if (!source?.alive || !source.zones.hand.includes(options.cardId) || host.state.cardResolution
    || !cardPlayable(host.state, options.sourceId, options.cardId)) return false
  const action = declaredCardActions(host.state, options.sourceId, options.cardId, options.cardName,
    `【${options.sourceSkillId}】视为使用【${options.cardName}】`, { sourceSkillId: options.sourceSkillId, ignoreSlashQuota: true })
    .find((candidate): candidate is Extract<LegalAction, { kind: 'use-card' }> => candidate.kind === 'use-card'
      && candidate.targetIds.length === options.targetIds.length
      && candidate.targetIds.every((targetId, index) => targetId === options.targetIds[index]))
  if (!action) return false
  executeUseCardAction(host, options.sourceId, action, { countSlashUsage: false, skipPlayInterceptors: true })
  return true
}

/** A skill-authorized physical Slash is discarded as its cost, then used from the discard pile. */
export function beginSkillSlashFromDiscard(
  host: CardEngineHost,
  options: { sourceId: PlayerId; cardId: CardId; targetId: PlayerId; sourceSkillId: string },
): boolean {
  const source = playerOf(host.state, options.sourceId)
  const target = playerOf(host.state, options.targetId)
  const card = host.state.cards[options.cardId]
  if (!source?.alive || !target?.alive || source.id === target.id || host.state.cardResolution
    || !host.state.zones.discardPile.includes(options.cardId) || card?.name !== '杀' || card.category !== 'basic'
    || isCardUseLocked(host.state, source.id, options.cardId)
    || isCardUseProhibited(host.state, source.id, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null }, skillIdsOf)
    || !canTarget(host.state, source.id, target.id, undefined, options.cardId)
    || isTargetProhibited(host.state, source.id, target.id, '杀', skillIdsOf, options.cardId, options.sourceSkillId)) return false

  if (!beginPhysicalCard(host, source.id, options.cardId, [target.id], '杀', { kind: 'discardPile' }, [options.cardId], options.sourceSkillId)) return false
  host.state.cardResolution = {
    kind: 'slash', cardId: options.cardId, sourceId: source.id, targetId: target.id,
    usageCounted: false,
    damageNature: slashNatureFor(host.state, source.id, effectiveDamageNature(host.state, options.cardId)),
    damageAmount: 1, stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [],
    extraCardIds: [], remainingTargetIds: [], dodgeRemaining: slashDodgeRequirement(host, source.id, target.id),
  }
  enterSlashTarget(host)
  return true
}

/** 标准合法性计算在技能授权的情形下，为武将牌上存放的实体牌生成使用动作。 */
export function characterPileCardUseActions(
  state: SanguoshaState,
  playerId: PlayerId,
  cardOwnerId: PlayerId,
  cardId: CardId,
  sourceSkillId: string,
): Extract<LegalAction, { kind: 'use-card' }>[] {
  if (state.status !== 'playing' || state.pendingRequests.length > 0 || state.cardResolution) return []
  const card = state.cards[cardId]
  const location = locateOwnedCard(state, cardOwnerId, cardId, { includeCharacterPiles: true })
  if (!card || location?.kind !== 'characterPile' || !cardPlayable(state, playerId, cardId)
    || isCardUseProhibited(state, playerId, card.name, { dyingPlayerId: null }, skillIdsOf)) return []
  if (card.category === 'equipment' && card.equipmentSlot) {
    const equipmentName = effectiveEquipmentName(state, cardId)
    const slots = equipTargetSlots(state, playerId, card.equipmentSlot)
    return slots.flatMap((slot) => {
      const action = useAction(cardId, playerId, equipmentName, [playerId], `使用武将牌上的【${equipmentName}】`, undefined, slot)
      return action.kind === 'use-card' ? [{ ...action, sourceSkillId, cardOwnerId }] : []
    })
  }
  return declaredCardActions(state, playerId, cardId, card.name, `使用武将牌上的【${card.name}】`, { sourceSkillId })
    .filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card' && !action.id.startsWith('play:recast:'))
    .map((action) => ({ ...action, cardOwnerId }))
}

/** 在明确授权的技能结算中，直接使用仍留在他人武将牌上的实体牌。 */
export function performCharacterPileCardUse(
  host: CardEngineHost,
  playerId: PlayerId,
  cardOwnerId: PlayerId,
  cardId: CardId,
  sourceSkillId: string,
  actionId: string,
): void {
  const action = findLegalAction(characterPileCardUseActions(host.state, playerId, cardOwnerId, cardId, sourceSkillId), playerId, actionId)
  if (action.kind !== 'use-card') throw new Error('武将牌上的牌不能以此动作使用')
  recordPlayDecision(host, playerId, actionId)
  executeUseCardAction(host, playerId, action)
}

/**
 * 这张【杀】可以指定哪些目标组合。
 *
 * 正常是每个合法目标一条单目标动作；本回合有「多指定 N 个目标」时
 * （太史慈【天义】）再补上多目标的组合。逐目标的规则（藤甲、流离、无双、
 * 铁骑、烈弓）仍然由 SlashResolution 一个个走，这里只负责列出组合。
 *
 * 只生成到 `slashTargetLimit` 为止，且**不做全排列**：多目标是少数情况，
 * 组合数按人数是 C(n,2)，5~8 人局最多二十来条，够用又不会把动作表撑爆。
 */
function slashTargetCombos(
  state: SanguoshaState,
  playerId: PlayerId,
  cardId?: CardId,
  nature: DamageNature = 'normal',
): PlayerId[][] {
  const rules = slashRules(state, playerId)
  // 载体牌要传下去：武神只对红桃当的【杀】免距离，真【杀】仍然讲距离
  const skillIgnoreDistance = skillsOf(state, playerId, skillIdsOf)
    .some((runtime) => runtime.slashIgnoresDistance?.(state, playerId, cardId) ?? false)
  const legal = state.players
    .filter((target) => {
      if (isTargetProhibited(state, playerId, target.id, '杀', skillIdsOf)) return false
      // 无距离限制时只剩「不是自己、还活着」两条
      if (rules.ignoreDistance || skillIgnoreDistance) return target.alive && target.id !== playerId
      return canTarget(state, playerId, target.id, undefined, cardId)
    })
    .map((target) => target.id)

  const grantedIds = extraSlashTargetIdsOf(state, playerId, skillIdsOf)
    .filter((targetId) => !isTargetProhibited(state, playerId, targetId, '杀', skillIdsOf, cardId))
  const candidates = [...new Set([...legal, ...grantedIds])]

  const combos: PlayerId[][] = candidates.map((id) => [id])
  const limit = slashTargetLimit(state, playerId, nature)
  const grantedCount = Math.min(grantedIds.length, extraSlashTargetsOf(state, playerId, nature, skillIdsOf))
  const ordinaryLimit = Math.max(0, limit - grantedCount)
  const allowed = (ids: PlayerId[]) => ids.length <= limit
    && ids.filter((id) => !grantedIds.includes(id)).length <= ordinaryLimit
  if (limit < 2) return combos
  const appendCombinations = (start: number, selected: PlayerId[], size: number) => {
    if (selected.length === size) { combos.push([...selected]); return }
    for (let index = start; index <= candidates.length - (size - selected.length); index += 1) {
      selected.push(candidates[index])
      if (selected.length !== size || allowed(selected)) appendCombinations(index + 1, selected, size)
      selected.pop()
    }
  }
  for (let size = 2; size <= Math.min(limit, candidates.length); size += 1) appendCombinations(0, [], size)
  return combos
}

function recordPlayDecision(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: `play-${host.state.turnNumber}`,
    playerId,
    kind: 'play-action',
    payload: { actionId },
  })
}

function beginSlash(
  host: CardEngineHost,
  action: Extract<LegalAction, { kind: 'use-card' }>,
  options: { countUsage?: boolean; consumeWine?: boolean; damageBonus?: number; noDodgeTargetIds?: PlayerId[]; responseDiscardCostTargetIds?: PlayerId[]; damageSourceId?: PlayerId | null } = {},
): void {
  const [cardId, ...extraCardIds] = action.cardIds
  /*
   * 强制改写身份的牌（神刘备【龙怒】）在这里把属性落到本次结算上。
   * 必须在 `beginActionPhysicalCard` 把牌搬进处理区**之前**读改写，
   * 因为改写只认手牌——搬走之后就查不到了。
   */
  const forcedSlash = forcedIdentityFor(host.state, action.playerId, cardId)
  if (forcedSlash?.asCardName === '杀') setCardNature(host.state, cardId, forcedSlash.nature)
  const songMarks = host.state.players.find((player) => player.id === action.playerId)?.marks[ZUOFEN_SONG_MARK] ?? 0
  const effectiveNature = slashNatureFor(host.state, action.playerId, effectiveDamageNature(host.state, cardId))
  const normalTargetLimit = slashTargetLimit(host.state, action.playerId, effectiveNature) - (songMarks > 0 ? 2 : 0)
  const consumeZuofenSong = songMarks > 0 && action.targetIds.length > normalTargetLimit
  let targetIds = [...action.targetIds]
  const candidateIds = host.state.players
    .filter((target) => target.alive && target.id !== action.playerId && !targetIds.includes(target.id)
      && !isTargetProhibited(host.state, action.playerId, target.id, '杀', skillIdsOf, cardId))
    .map((target) => target.id)
  for (const runtime of skillsOf(host.state, action.playerId, skillIdsOf)) {
    targetIds = runtime.modifySlashTargets?.(host, action.playerId, targetIds, candidateIds) ?? targetIds
  }
  targetIds = additionalTargetsOnUseOf(host.state, action.playerId, cardId, '杀', targetIds, skillIdsOf)
  const [targetId, ...remainingTargetIds] = targetIds
  if (!beginActionPhysicalCard(host, action.playerId, cardId, targetIds, '杀', action.cardIds, action.sourceSkillId, action.cardOwnerId)) return
  if (consumeZuofenSong) {
    const source = host.state.players.find((player) => player.id === action.playerId)
    if (source) {
      source.marks[ZUOFEN_SONG_MARK] -= 1
      if (source.marks[ZUOFEN_SONG_MARK] <= 0) delete source.marks[ZUOFEN_SONG_MARK]
    }
  }
  // 丈八蛇矛：第二张牌和主牌一起进处理区，结算结束时一起弃掉
  for (const extra of extraCardIds) {
    moveCard(host.state, extra, { kind: 'hand', playerId: action.cardOwnerId ?? action.playerId }, { kind: 'processingArea' })
  }
  const countUsage = options.countUsage ?? true
  const consumeWine = options.consumeWine ?? true
  const damageAmount = 1 + (consumeWine ? host.state.turnUsage.wineDamageBonus : 0) + (options.damageBonus ?? 0)
  if (consumeWine && host.state.turnUsage.wineDamageBonus > 0) {
    host.state.wineBoostedSlashCardIds ??= []
    if (!host.state.wineBoostedSlashCardIds.includes(cardId)) host.state.wineBoostedSlashCardIds.push(cardId)
  }
  if (countUsage) {
    host.state.turnUsage.slashUses += 1
    // 回合级的那本账不随出牌阶段归零，「本回合使用过杀吗」读的是它
    host.state.turnUsage.slashUsesThisTurn = (host.state.turnUsage.slashUsesThisTurn ?? 0) + 1
  }
  if (consumeWine) host.state.turnUsage.wineDamageBonus = 0
  host.state.cardResolution = {
    kind: 'slash', cardId, sourceId: action.playerId, targetId,
    ...(skillsOf(host.state, action.playerId, skillIdsOf).some((runtime) => runtime.concealsSlashTargets?.(host.state, action.playerId, cardId))
      ? { privateTargets: true } : {}),
    ...(options.damageSourceId !== undefined ? { damageSourceId: options.damageSourceId } : {}),
    usageCounted: countUsage,
    // 属性走公共入口：转化技可以把普通牌当火杀用（龙魂的方块），属性不在牌面上
    damageNature: slashNatureFor(host.state, action.playerId, effectiveDamageNature(host.state, cardId)), damageAmount,
    stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [], extraCardIds,
    remainingTargetIds: [...remainingTargetIds],
    noDodgeTargetIds: options.noDodgeTargetIds ? [...options.noDodgeTargetIds] : [],
    responseDiscardCostTargetIds: options.responseDiscardCostTargetIds ? [...options.responseDiscardCostTargetIds] : [],
    responsePaymentAuthorized: null,
    dodgeRemaining: slashDodgeRequirement(host, action.playerId, targetId),
  }
  enterSlashTarget(host)
}

/** Substitute a pending card's complete effect with a Slash against the same target set. */
export function beginReplacementSlashEffect(
  host: CardEngineHost,
  original: CardResolutionState,
  nature: DamageNature = 'normal',
): boolean {
  if (host.state.cardResolution !== original || host.state.suspendedCardEffectResolution) return false
  const targetIds = cardUseTargetsOf(host.state, original.cardId)?.targetIds
    ?? (original.kind === 'slash' ? [original.targetId, ...original.remainingTargetIds] : original.targetIds)
  const livingTargets = targetIds.filter((targetId) => player(host.state, targetId)?.alive)
  if (!livingTargets.length) return false
  host.state.suspendedCardEffectResolution = original
  const [targetId, ...remainingTargetIds] = livingTargets
  host.state.cardResolution = {
    kind: 'slash', effectReplacement: true, cardId: original.cardId, sourceId: original.sourceId,
    targetId, damageNature: nature,
    damageAmount: original.kind === 'slash' ? original.damageAmount : 1,
    usageCounted: false,
    stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [], extraCardIds: [],
    remainingTargetIds, responsePaymentAuthorized: null,
    dodgeRemaining: slashDodgeRequirement(host, original.sourceId, targetId),
  }
  enterSlashTarget(host)
  return true
}

/**
 * 直接用牌堆里的一张真实【杀】发起一次完整的正常杀结算（徐氏【伏诛】）。
 *
 * 和 `beginVirtualSlash` 不一样：那个是凭空印一张虚拟杀，这个是**牌堆里
 * 现成的实体牌**，用完之后跟着正常结算走向（放【无懈】/被弃/被技能拿走
 * 都按引擎统一规则处理），不会被 `finishPhysicalCard` 当成虚拟牌销毁。
 *
 * 不检查距离——技能发起的杀本来就不受距离限制，调用方也不需要再查一遍。
 * 次数：固定不计入 `turnUsage.slashUses`（伏诛这类技能杀历来不占次数），
 * 需要占用次数的技能自己在这之外调整。
 */
export function beginSlashFromDrawPile(
  host: CardEngineHost,
  sourceId: PlayerId,
  targetId: PlayerId,
  cardId: CardId,
): boolean {
  if (host.state.cardResolution) return false
  const source = player(host.state, sourceId)
  const target = player(host.state, targetId)
  if (!source.alive || !target.alive || sourceId === targetId) return false
  if (!host.state.zones.drawPile.includes(cardId)) return false
  if (!beginPhysicalCard(host, sourceId, cardId, [targetId], '杀', { kind: 'drawPile' })) return false
  host.state.cardResolution = {
    kind: 'slash', cardId, sourceId, targetId,
    usageCounted: false,
    damageNature: slashNatureFor(host.state, sourceId, effectiveDamageNature(host.state, cardId)), damageAmount: 1,
    stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [], extraCardIds: [],
    remainingTargetIds: [],
    dodgeRemaining: slashDodgeRequirement(host, sourceId, targetId),
  }
  enterSlashTarget(host)
  return true
}

/**
 * 支持转化技从装备区和武将专属牌堆使用牌，并保证装备离场时机只走一次。
 *
 * 专属牌堆是邓艾【急袭】要的：把一张「田」当【顺手牵羊】用，底牌就是那张
 * 真实的田。**不能先把田挪回手牌再使用**——那会多出一次 GainCard、
 * 让手牌数在界面上闪一下，还会被「获得牌后」的技能误触发。
 */
function beginActionPhysicalCard(host: CardEngineHost, playerId: PlayerId, cardId: CardId, targetIds: PlayerId[], cardName: string, usedCardIds: readonly CardId[] = [cardId], sourceSkillId?: string, physicalOwnerId = playerId, explicitSource?: ZoneRef): boolean {
  const from = explicitSource ?? (host.state.cards[cardId]?.virtual && host.state.zones.processingArea.includes(cardId)
    ? { kind: 'processingArea' as const }
    : locateOwnedCard(host.state, physicalOwnerId, cardId, { includeCharacterPiles: true }))
  if (!from || from.kind === 'judgingArea') throw new Error('卡牌不属于出牌玩家的手牌区、装备区或专属牌堆')
  const started = beginPhysicalCard(host, playerId, cardId, targetIds, cardName, from, usedCardIds, sourceSkillId)
  if (from.kind === 'hand' && from.playerId !== playerId) host.dispatch('LoseCard', { playerId: from.playerId, cardIds: [cardId], reason: 'shared-hand-use' }, { sourceId: playerId, targetId: from.playerId, cardIds: [cardId] })
  if (from.kind === 'equipment') handleEquipmentLost(host, physicalOwnerId, cardId)
  return started
}

/**
 * 技能生成的【杀】共用正常【杀】管线，但不消耗距离、次数或酒增伤。
 *
 * 不给 `cardId` 时造一张临时牌，结算结束由 finishPhysicalCard 销毁；
 * 给了 `cardId` 就用这张**实体手牌**——牛来【麻麻】的「跟上」要求真的花掉
 * 一张【杀】，实体牌上的花色和属性（火杀、雷杀）也要照常生效，
 * 所以不能改成「弃掉实体牌再放一张虚拟杀」。
 *
 * **「视为使用」同样受封牌规则约束。** 返回 false 表示这次用不出去，
 * 调用方**必须**据此收尾（该失去体力的失去体力、该跳过的跳过）。
 * 查的是 `sourceId`——「令某角色使用一张【杀】」里用牌的是**那个角色**，
 * 不是技能拥有者。
 */
/**
 * 合成一张虚拟【杀】并放进使用者手牌，返回它的 id。
 *
 * 只负责印牌，**不发起使用**：调用方拿到 id 之后自己决定走哪条路——
 * `beginVirtualSlash` 那种「技能生成的杀」不吃距离和次数，
 * 而关兴张苞【父魂】把两张手牌当【杀】**正常使用**，
 * 距离、次数、酒的增伤、武器效果全部照常，所以它要走
 * `declaredCardActions` + `executeUseCardAction` 那条正常管线。
 *
 * 牌的销毁由 `finishPhysicalCard` 统一负责，调用方不要自己删。
 */
export function createVirtualSlashCard(
  state: SanguoshaState,
  sourceId: PlayerId,
  sourceSkillId: string,
  nature: 'normal' | 'fire' | 'thunder' = 'normal',
): CardId {
  const source = player(state, sourceId)
  const cardId = `virtual:${sourceSkillId}:${state.seq + 1}:${state.decisions.length}`
  state.cards[cardId] = {
    id: cardId,
    ruleset: state.rulesetVersion,
    expansion: 'standard',
    name: '杀',
    // 虚拟牌没有真实花色；字段仅满足统一牌对象结构，规则判断必须查看 virtual。
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'basic',
    damageNature: nature,
    virtual: true,
    sourceSkillId,
  }
  source.zones.hand.push(cardId)
  recordCardHandEntry(state, cardId)
  return cardId
}

export function beginVirtualSlash(
  host: CardEngineHost,
  options: {
    sourceId: PlayerId
    targetId?: PlayerId
    targetIds?: PlayerId[]
    sourceSkillId: string
    nature?: 'normal' | 'fire' | 'thunder'
    /** 用作载体的实体手牌；不传则生成临时牌 */
    cardId?: CardId
    /**
     * 这张虚拟【杀】算不算一次出杀次数。
     *
     * 默认 `false`（老行为：技能发起的杀不吃次数限制）。刘封【陷嗣】用两张
     * 「逆」换来的杀是**真的按次数算**的一次出杀，调用方传 `true`；
     * 距离限制则由调用方在决定要不要发出这条动作之前自己查（这里不做）。
     */
    countUsage?: boolean
    ignoreDistance?: boolean
    ignoreArmor?: boolean
    /** 技能牌自带的额外合法目标数；默认仍是一名目标。 */
    maxTargets?: number
    /** 仅转换规则明确允许时，实体载体才能作为多目标【杀】。 */
    allowMultipleTargetsWithPhysicalCard?: boolean
    /** 此次虚拟杀的基础伤害加成。 */
    damageBonus?: number
    /** 指定目标不能响应【闪】。 */
    noDodgeTargetIds?: PlayerId[]
    /** 指定目标响应此【杀】前须额外弃置一张牌。 */
    responseDiscardCostTargetIds?: PlayerId[]
    /** Damage attribution only; the card user remains sourceId for card resolution. */
    damageSourceId?: PlayerId | null
  },
): boolean {
  if (host.state.cardResolution) throw new Error('已有卡牌正在结算')
  const source = player(host.state, options.sourceId)
  const targetIds = options.targetIds ?? (options.targetId ? [options.targetId] : [])
  const intercept = (): boolean => {
    const context: VirtualSlashUseContext = { ...options, targetIds }
    for (const owner of host.state.players) {
      if (!owner.alive) continue
      for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
        if (runtime.interceptVirtualSlash?.(host as never, owner.id, context)) return true
      }
    }
    return false
  }
  if (!source.alive || targetIds.length < 1 || targetIds.length > (options.maxTargets ?? 1) || new Set(targetIds).size !== targetIds.length) throw new Error('虚拟杀目标非法')
  for (const targetId of targetIds) {
    const target = player(host.state, targetId)
    const ignoresDistance = Boolean(options.cardId && skillsOf(host.state, source.id, skillIdsOf)
      .some((runtime) => runtime.slashIgnoresDistance?.(host.state, source.id, options.cardId)))
    if (!target.alive || source.id === target.id || (!(options.ignoreDistance || ignoresDistance) && !canTarget(host.state, source.id, target.id))
      || isTargetProhibited(host.state, source.id, target.id, '杀', skillIdsOf, options.cardId, options.sourceSkillId)) throw new Error('虚拟杀目标非法')
  }
  // 曹彰【将驰】的「本回合不能使用【杀】」、一行【离迹】的封牌都在这里生效
  if (isCardUseProhibited(host.state, options.sourceId, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null }, skillIdsOf)) return false
  if (options.cardId) {
    if (isCardUseLocked(host.state, source.id, options.cardId)) return false
    const carrierZone = locateOwnedCard(host.state, source.id, options.cardId, { includeCharacterPiles: true })
    if (!carrierZone || carrierZone.kind === 'judgingArea') throw new Error('作为载体的【杀】不在可使用区域里')
    /*
     * 看**有效牌名**而不是印刷名。
     *
     * 关羽【武圣】把一张红牌当【杀】用时，实体牌印的仍然是别的名字；
     * 只认印刷名的话，这类转化杀就永远走不进技能发起的【杀】管线
     * （贾诩【乱武】逼人出杀时就会漏掉他们）。调用方把别名设好，
     * 这里按统一口径确认它现在确实是一张【杀】。
     */
    if (effectiveCardName(host.state, options.cardId) !== '杀') throw new Error('作为载体的牌不是【杀】')
    if (!host.state.cards[options.cardId]!.virtual && targetIds.length !== 1 && !options.allowMultipleTargetsWithPhysicalCard)
      throw new Error('实体载体虚拟杀不支持多目标')
    if (intercept()) return true
    const realAction = useAction(options.cardId, source.id, '杀', targetIds, `对${targetIds.length}名角色使用【杀】`)
    if (realAction.kind !== 'use-card') throw new Error('技能杀动作构造失败')
    if (options.ignoreArmor) for (const targetId of targetIds) suppressArmorForCard(host.state, source.id, targetId, options.cardId, options.sourceSkillId)
    beginSlash(host, realAction, { countUsage: options.countUsage ?? false, consumeWine: false, damageBonus: options.damageBonus, noDodgeTargetIds: options.noDodgeTargetIds, responseDiscardCostTargetIds: options.responseDiscardCostTargetIds, damageSourceId: options.damageSourceId })
    return true
  }
  if (intercept()) return true
  const cardId = createVirtualSlashCard(host.state, source.id, options.sourceSkillId, options.nature)
  const action = useAction(cardId, source.id, '杀', targetIds, `对${targetIds.length}名角色使用虚拟【杀】`)
  if (action.kind !== 'use-card') throw new Error('虚拟杀动作构造失败')
  if (options.ignoreArmor) for (const targetId of targetIds) suppressArmorForCard(host.state, source.id, targetId, cardId, options.sourceSkillId)
  beginSlash(host, action, { countUsage: options.countUsage ?? false, consumeWine: false, damageBonus: options.damageBonus, noDodgeTargetIds: options.noDodgeTargetIds, responseDiscardCostTargetIds: options.responseDiscardCostTargetIds, damageSourceId: options.damageSourceId })
  return true
}

/** 将另一名角色手牌中的实体牌直接作为本次技能【杀】的材料，不先获得到使用者手牌。 */
export function beginSkillSlashFromOtherHand(
  host: CardEngineHost,
  options: { sourceId: PlayerId; physicalOwnerId: PlayerId; cardId: CardId; targetId: PlayerId; sourceSkillId: string },
): boolean {
  if (host.state.cardResolution) return false
  const source = player(host.state, options.sourceId)
  const physicalOwner = player(host.state, options.physicalOwnerId)
  const target = player(host.state, options.targetId)
  if (!source.alive || !physicalOwner.alive || !target.alive || source.id === target.id
    || !physicalOwner.zones.hand.includes(options.cardId) || isCardUseLocked(host.state, source.id, options.cardId)
    || isCardUseProhibited(host.state, source.id, '杀', { dyingPlayerId: host.state.dying?.playerId ?? null }, skillIdsOf)
    || !canTarget(host.state, source.id, target.id, undefined, options.cardId)
    || isTargetProhibited(host.state, source.id, target.id, '杀', skillIdsOf, options.cardId, options.sourceSkillId)) return false

  setCardAlias(host.state, options.cardId, '杀')
  const action = useAction(options.cardId, source.id, '杀', [target.id], `对${target.nickname}使用技能【杀】`)
  if (action.kind !== 'use-card') return false
  action.sourceSkillId = options.sourceSkillId
  action.cardOwnerId = physicalOwner.id
  beginSlash(host, action, { countUsage: false, consumeWine: false })
  return true
}

/** 技能使用一张真实虚拟即时锦囊，完整进入无懈与效果结算。 */
export function beginVirtualTrick(
  host: CardEngineHost,
  options: { sourceId: PlayerId; targetId?: PlayerId; targetIds?: PlayerId[]; cardName: string; sourceSkillId: string; cardId?: CardId; extraCardIds?: CardId[]; damageAmount?: number },
): boolean {
  if (host.state.cardResolution) return false
  if (!INSTANT_TRICKS.has(options.cardName) || isCardUseProhibited(host.state, options.sourceId, options.cardName, { dyingPlayerId: null }, skillIdsOf)) return false
  if (options.cardId && isCardUseLocked(host.state, options.sourceId, options.cardId)) return false
  const source = player(host.state, options.sourceId)
  const targetIds = [...new Set(options.targetIds ?? (options.targetId ? [options.targetId] : []))]
  if (!source.alive || !targetIds.length || targetIds.some((targetId) => {
    const target = player(host.state, targetId)
    return !target.alive || isTargetProhibited(host.state, source.id, target.id, options.cardName, skillIdsOf, options.cardId)
  })) return false
  const extraCardIds = [...new Set(options.extraCardIds ?? [])]
  if (extraCardIds.some((extraId) => !host.state.zones.discardPile.includes(extraId))) return false
  let cardId = options.cardId
  if (cardId) {
    const from = locateOwnedCard(host.state, source.id, cardId, { includeCharacterPiles: true })
    if (!from || from.kind === 'judgingArea') return false
    setCardAlias(host.state, cardId, options.cardName)
  } else {
    cardId = `virtual:${options.sourceSkillId}:${host.state.seq + 1}:${host.state.decisions.length}`
    host.state.cards[cardId] = {
      id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: options.cardName,
      suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true, sourceSkillId: options.sourceSkillId,
    }
    source.zones.hand.push(cardId)
    recordCardHandEntry(host.state, cardId)
  }
  if (!beginActionPhysicalCard(host, source.id, cardId, targetIds, options.cardName)) return false
  for (const extraId of extraCardIds) moveCard(host.state, extraId, { kind: 'discardPile' }, { kind: 'processingArea' })
  beginInstantTrick(host, source.id, cardId, targetIds, options.cardName, extraCardIds, options.sourceSkillId, false, options.damageAmount)
  return true
}

/** 使用无实体材料的延时锦囊，直到离开判定区前保留虚拟牌对象。 */
export function beginVirtualDelayedTrick(
  host: CardEngineHost,
  options: { sourceId: PlayerId; targetId: PlayerId; cardName: string; sourceSkillId: string },
): boolean {
  if (host.state.cardResolution || !DELAYED_TRICKS.has(options.cardName)
    || isCardUseProhibited(host.state, options.sourceId, options.cardName, { dyingPlayerId: null }, skillIdsOf)) return false
  const source = player(host.state, options.sourceId)
  if (!source.alive) return false
  const cardId = `virtual:${options.sourceSkillId}:${host.state.seq + 1}:${host.state.decisions.length}` as CardId
  host.state.cards[cardId] = {
    id: cardId, ruleset: host.state.rulesetVersion, expansion: 'standard', name: options.cardName,
    suit: 'spade', rank: 1, color: 'black', category: 'trick', virtual: true, sourceSkillId: options.sourceSkillId,
  }
  if (!canPlaceDelayedTrick(host.state, options.sourceId, options.targetId, options.cardName, cardId)) {
    delete host.state.cards[cardId]
    return false
  }
  source.zones.hand.push(cardId)
  recordCardHandEntry(host.state, cardId)
  const action = useAction(cardId, options.sourceId, options.cardName, [options.targetId], `视为使用【${options.cardName}】`)
  if (action.kind !== 'use-card') {
    source.zones.hand = source.zones.hand.filter((id) => id !== cardId)
    delete host.state.cards[cardId]
    return false
  }
  action.sourceSkillId = options.sourceSkillId
  placeDelayedTrick(host, action)
  return true
}

/** Use a real discard-pile card as Lightning and place it through the normal card lifecycle. */
export function beginSkillLightningFromDiscard(host: CardEngineHost, sourceId: PlayerId, cardId: CardId, sourceSkillId: string): boolean {
  const source = player(host.state, sourceId)
  if (!source?.alive || host.state.cardResolution || !host.state.zones.discardPile.includes(cardId)
    || !canPlaceDelayedTrick(host.state, sourceId, sourceId, '闪电', cardId)
    || isCardUseProhibited(host.state, sourceId, '闪电', { dyingPlayerId: null, cardIds: [cardId] }, skillIdsOf)) return false
  if (!beginPhysicalCard(host, sourceId, cardId, [sourceId], '闪电', { kind: 'discardPile' }, [cardId], sourceSkillId)) return false
  setCardAlias(host.state, cardId, '闪电')
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: sourceId })
  finishPhysicalCard(host, sourceId, cardId, [sourceId], false, '闪电')
  return true
}

/**
 * 这一次【杀】需要连续打出几张【闪】。
 *
 * 两类来源，**都要看**：
 *
 * - 出杀方的固定加成（吕布【无双】）：`slashDodgeResponses`；
 * - 攻守任意一方的条件加成（董卓【肉林】要看对方性别）：`dodgeResponsesFor`。
 *   肉林在「董卓砍女性」和「女性砍董卓」两个方向都生效，后者技能在**目标**身上，
 *   所以只查出杀方的技能是不够的。
 *
 * 多个来源取 **max 而不是相加**：无双和肉林撞在一起仍然是两张闪，不是四张。
 * 规则上这类效果是「需要 N 张才能抵消」，不是各自独立叠加。
 */
function slashDodgeRequirement(host: CardEngineHost, sourceId: PlayerId, targetId: PlayerId): number {
  const counts = [1]
  for (const runtime of skillsOf(host.state, sourceId, skillIdsOf)) {
    counts.push(runtime.slashDodgeResponses ?? 1)
    counts.push(runtime.dodgeResponsesFor?.(host.state, sourceId, sourceId, targetId) ?? 1)
  }
  for (const runtime of skillsOf(host.state, targetId, skillIdsOf)) {
    counts.push(runtime.dodgeResponsesFor?.(host.state, targetId, sourceId, targetId) ?? 1)
  }
  return Math.max(...counts)
}

/**
 * 开始结算当前这个目标。
 *
 * 仁王盾 / 藤甲让这张牌对某个目标完全无效，那个目标直接跳过——
 * 多目标时其余目标仍然照常结算。
 */
function enterSlashTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (resolution.preparedTargets && !resolution.preparingTargets) {
    const prepared = resolution.preparedTargets[resolution.preparedTargetIndex ?? 0]
    if (!prepared) return
    resolution.noDodge = prepared.noDodge
    if (prepared.cancelled || !host.state.players.find((candidate) => candidate.id === resolution.targetId)?.alive) {
      resolution.targetCancelled = prepared.cancelled
      continueSlash(host)
      return
    }
    const card = host.state.cards[resolution.cardId]
    const slashColor = card.virtual ? null : effectiveCardColor(host.state, resolution.sourceId, card.id, skillIdsOf)
    if (isCardIneffective(host.state, resolution.targetId, '杀', slashColor, resolution.damageNature, resolution.sourceId,
      effectiveCardSuit(host.state, resolution.sourceId, resolution.cardId), resolution.cardId)) {
      announceSkillInvalidation(host, resolution.targetId, '杀', slashColor, resolution.sourceId)
      continueSlash(host)
      return
    }
    applyUndodgeableSkills(host, resolution.sourceId, resolution.targetId)
    askSlashDodge(host)
    return
  }
  if (resolution.preparingTargets === undefined && resolution.remainingTargetIds.length > 0) {
    resolution.preparingTargets = true
    resolution.targetPreparationStage = 'becoming-target'
    resolution.preparedTargets = []
  }
  if (resolution.preparingTargets) {
    if (!host.state.players.find((candidate) => candidate.id === resolution.targetId)?.alive) {
      resolution.targetCancelled = true
      advanceSlashTargetPreparation(host, true)
      return
    }
    if (askSlashInterceptors(host)) return
    advanceSlashTargetPreparation(host, resolution.targetCancelled === true)
    return
  }
  if (askSlashInterceptors(host)) return
  /*
   * 插入点可以**同步**取消这个目标：刘禅【享乐】在攻击者一张基本牌都没有时
   * 不发问，当场判这张【杀】对他无效。那种情况下 `interceptTarget` 返回的是
   * false（没有挂起任何 Request），但目标已经作废，不能再往下问闪——
   * 问了就是对一个已经无效的目标求闪，而且会留下一个没人回答的请求。
   */
  if (resolution.targetCancelled) {
    continueSlash(host)
    return
  }
  const card = host.state.cards[resolution.cardId]
  const slashColor = card.virtual ? null : effectiveCardColor(host.state, resolution.sourceId, card.id, skillIdsOf)
  if (isCardIneffective(host.state, resolution.targetId, '杀', slashColor, resolution.damageNature, resolution.sourceId,
    effectiveCardSuit(host.state, resolution.sourceId, resolution.cardId), resolution.cardId)) {
    // 目标确认与指定目标后的插入窗口均先完成，再检测此【杀】对当前目标是否有效。
    announceSkillInvalidation(host, resolution.targetId, '杀', slashColor, resolution.sourceId)
    continueSlash(host)
    return
  }
  applyUndodgeableSkills(host, resolution.sourceId, resolution.targetId)
  askSlashDodge(host)
}

/**
 * 锁定技造成的「不可闪避」。
 *
 * 铁骑是判定成功后写 noDodge，烈弓是看目标手牌数——都落到同一个字段上，
 * 后面求闪那一步只认这个字段，不需要知道是哪个技能写的。
 * 只加不减：铁骑已经判成功了，烈弓不满足条件也不能把它抹掉。
 */
function applyUndodgeableSkills(host: CardEngineHost, sourceId: PlayerId, targetId: PlayerId): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (resolution.noDodgeTargetIds?.includes(targetId)) resolution.noDodge = true
  for (const runtime of skillsOf(host.state, sourceId, skillIdsOf)) {
    if (runtime.slashUndodgeable?.(host.state, sourceId, targetId, resolution.cardId)) resolution.noDodge = true
  }
}

/**
 * 当前目标结算完了：还有目标就换下一个，没有就把这张牌收掉。
 *
 * 每个目标都是一次全新的响应，所以插入点记账、代打进度、无双次数全部重置。
 */
function continueSlash(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (host.state.pendingSourceDamage || host.state.pendingTargetDamage || host.state.pendingDamageModifier) return
  if (resolution.preparingTargets) {
    advanceSlashTargetPreparation(host, true)
    return
  }
  resolution.resolvedTargetIds ??= []
  if (!resolution.resolvedTargetIds.includes(resolution.targetId)) resolution.resolvedTargetIds.push(resolution.targetId)
  const repeatSkills = skillsOf(host.state, resolution.sourceId, skillIdsOf)
  const currentTargetAlive = !resolution.targetCancelled
    && host.state.players.find((candidate) => candidate.id === resolution.targetId)?.alive === true
  let repeats = currentTargetAlive ? resolution.repeatEffectsRemainingByTarget?.[resolution.targetId] ?? 0 : 0
  if (currentTargetAlive && repeats === 0 && resolution.repeatEffectsRemainingByTarget?.[resolution.targetId] === undefined) {
    repeats = repeatSkills.reduce((count, runtime) => count
      + Math.max(0, Math.trunc(runtime.repeatTargetEffectCount?.(host.state, resolution.sourceId, resolution.targetId, resolution.cardId) ?? 0))
      + (runtime.repeatSlashTarget?.(host.state, resolution.sourceId, resolution.targetId, resolution.cardId) ? 1 : 0), 0)
  }
  if (repeats > 0) {
    resolution.repeatEffectsRemainingByTarget ??= {}
    resolution.repeatEffectsRemainingByTarget[resolution.targetId] = repeats - 1
    resolution.remainingTargetIds.unshift(resolution.targetId)
  } else {
    resolution.repeatedTargetIds ??= []
    if (!resolution.repeatedTargetIds.includes(resolution.targetId)) resolution.repeatedTargetIds.push(resolution.targetId)
  }
  /*
   * 跳过已经不在场的目标。
   *
   * 多目标【杀】（太史慈【天义】）里，前一个目标的结算完全可能顺带带走后一个
   * ——他死于反馈、刚烈，或者死在濒死流程里。不跳过的话下一轮会对着死人
   * 走结算，最后在 resolveDamage 抛「不能对死亡角色造成伤害」。
   */
  if (resolution.preparedTargets && resolution.preparedTargetIndex !== undefined && repeats <= 0) {
    resolution.preparedTargetIndex += 1
  }
  let next = resolution.remainingTargetIds.shift()
  while (next !== undefined && !host.state.players.find((candidate) => candidate.id === next)?.alive) {
    if (resolution.preparedTargets && resolution.preparedTargetIndex !== undefined) {
      resolution.preparedTargetIndex += 1
    }
    next = resolution.remainingTargetIds.shift()
  }
  if (next === undefined) {
    if (finishReplacedCardEffect(host, resolution)) return
    // Release the old resolution before CardResolved handlers run: a skill may
    // synchronously start another card effect from that event.
    host.state.cardResolution = null
    finishSlash(host, resolution)
    /*
     * 借刀杀人在多目标场景下把自己的锦囊结算暂存在了这里（见
     * `resolveTrickEffectResponse` 的 'borrowed-knife' 分支），等这张
     * （借来的）杀真正结算完毕——就是这一刻——才恢复它，继续走剩下的目标。
     * 不恢复的话，锦囊那边还挂着一个「借刀杀人：选择受害者」的旧请求，
     * 但 `cardResolution` 已经不认得它了。
     */
    const suspendedTrick = host.state.suspendedTrickResolution
    if (suspendedTrick) {
      host.state.suspendedTrickResolution = null
      host.state.cardResolution = suspendedTrick
      advanceToNextTarget(host)
    }
    return
  }
  resolution.targetId = next
  resolution.interceptsDone = []
  resolution.surrogate = null
  resolution.requestId = null
  resolution.stage = 'awaiting-dodge'
  resolution.dodgeRemaining = slashDodgeRequirement(host, resolution.sourceId, resolution.targetId)
  resolution.noDodge = false
  resolution.targetCancelled = false
  enterSlashTarget(host)
}

/** Finish every target-after-designation window before beginning multi-target Slash responses. */
function advanceSlashTargetPreparation(host: CardEngineHost, cancelled: boolean): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash' || !resolution.preparingTargets) return
  resolution.preparedTargets ??= []
  const clearTargetInterceptors = () => {
    resolution.interceptsDone = []
    resolution.surrogate = null
    resolution.requestId = null
    resolution.stage = 'awaiting-dodge'
    resolution.noDodge = false
    resolution.targetCancelled = false
  }
  const enterPreparationTarget = (targetId: PlayerId) => {
    resolution.targetId = targetId
    resolution.dodgeRemaining = slashDodgeRequirement(host, resolution.sourceId, targetId)
    clearTargetInterceptors()
    enterSlashTarget(host)
  }

  if (resolution.targetPreparationStage === 'becoming-target') {
    resolution.preparedTargets.push({
      targetId: resolution.targetId,
      noDodge: false,
      cancelled: cancelled || !host.state.players.find((candidate) => candidate.id === resolution.targetId)?.alive,
    })
    let next = resolution.remainingTargetIds.shift()
    while (next !== undefined && !host.state.players.find((candidate) => candidate.id === next)?.alive) {
      resolution.preparedTargets.push({ targetId: next, noDodge: false, cancelled: true })
      next = resolution.remainingTargetIds.shift()
    }
    if (next !== undefined) {
      enterPreparationTarget(next)
      return
    }

    // Complete every “becomes a target” window (for example, 流离) before any
    // “after targets are specified” window (for example, 铁骑).
    resolution.targetPreparationStage = 'after-target-specified'
    resolution.targetPreparationIndex = 0
  } else {
    const prepared = resolution.preparedTargets[resolution.targetPreparationIndex ?? 0]
    if (prepared) {
      prepared.noDodge = resolution.noDodge === true
      prepared.cancelled ||= cancelled || !host.state.players.find((candidate) => candidate.id === prepared.targetId)?.alive
    }
    resolution.targetPreparationIndex = (resolution.targetPreparationIndex ?? 0) + 1
  }

  while ((resolution.targetPreparationIndex ?? 0) < resolution.preparedTargets.length) {
    const index: number = resolution.targetPreparationIndex ?? 0
    const prepared = resolution.preparedTargets[index]
    if (prepared.cancelled || !host.state.players.find((candidate) => candidate.id === prepared.targetId)?.alive) {
      prepared.cancelled = true
      resolution.targetPreparationIndex = index + 1
      continue
    }
    enterPreparationTarget(prepared.targetId)
    return
  }

  resolution.preparingTargets = false
  resolution.targetPreparationStage = undefined
  resolution.targetPreparationIndex = undefined
  const targetsToResolve = resolution.preparedTargets.filter((item) => !item.cancelled)
  if (targetsToResolve.length === 0) {
    if (finishReplacedCardEffect(host, resolution)) return
    host.state.cardResolution = null
    finishSlash(host, resolution)
    return
  }
  resolution.preparedTargets = targetsToResolve
  resolution.preparedTargetIndex = 0
  resolution.targetId = targetsToResolve[0].targetId
  resolution.remainingTargetIds = targetsToResolve.slice(1).map((item) => item.targetId)
  resolution.dodgeRemaining = slashDodgeRequirement(host, resolution.sourceId, resolution.targetId)
  clearTargetInterceptors()
  enterSlashTarget(host)
}

/** 结束一次【杀】的结算：主牌和一起打出的额外牌都进弃牌堆。 */
function finishSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  const targetIds = cardUseTargetsOf(host.state, resolution.cardId)?.targetIds ?? [resolution.targetId]
  finishPhysicalCard(host, resolution.sourceId, resolution.cardId, targetIds, false, '杀', {
    slashUsageCounted: resolution.usageCounted === true,
  })
  discardExtras(host, resolution.extraCardIds)
}

function discardExtras(host: CardEngineHost, cardIds: readonly CardId[]): void {
  for (const cardId of cardIds) {
    if (!host.state.zones.processingArea.includes(cardId)) continue
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
}

/**
 * 「成为目标时」的插入点。
 *
 * 雌雄双股剑问目标选一项，大乔【流离】把这张【杀】转给别人。
 * 返回 true 表示已经问出去了，调用方不要再求闪——结算会停在 `awaiting-intercept`，
 * 由 `resumeSlashAfterEquipment` 接回来。
 */
function askSlashInterceptors(host: CardEngineHost): boolean {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return false
  const becomingTarget: Array<[string, () => boolean]> = [
    ['liuli', () => askSlashTransfer(host, resolution.sourceId, resolution.targetId)],
  ]
  const afterTargetSpecified: Array<[string, () => boolean]> = [
    ['tieji', () => askTieji(host, resolution.sourceId, resolution.targetId)],
  ]
  // “指定目标后”先处理使用者的武将技能，再处理装备和旁观者插入点。
  for (const runtime of skillsOf(host.state, resolution.sourceId, skillIdsOf)) {
    if (!runtime.interceptSourceTarget) continue
    afterTargetSpecified.push([
      `source-skill:${runtime.id}`,
      () => runtime.interceptSourceTarget!(host, resolution.sourceId, {
        sourceId: resolution.sourceId,
        targetId: resolution.targetId,
        cardId: resolution.cardId,
        cardName: '杀',
        category: 'basic',
      }),
    ])
  }
  for (const runtime of skillsOf(host.state, resolution.sourceId, skillIdsOf)) {
    if (!runtime.interceptSourceTargetEach) continue
    const interceptId = `source-each:${runtime.id}:${resolution.targetId}`
    afterTargetSpecified.push([
      interceptId,
      () => runtime.interceptSourceTargetEach!(host, resolution.sourceId, {
        sourceId: resolution.sourceId, targetId: resolution.targetId, cardId: resolution.cardId,
        cardName: '杀', category: 'basic',
      }),
    ])
  }
  afterTargetSpecified.push(['qinggang', () => {
    if (effectiveCardName(host.state, resolution.cardId) === '杀' && hasWeapon(host.state, resolution.sourceId, '青釭剑')) {
      suppressArmorForCard(host.state, resolution.sourceId, resolution.targetId, resolution.cardId, 'equip:qinggangjian')
    }
    return false
  }])
  afterTargetSpecified.push(['cixiong', () => askCixiongSword(host, resolution.sourceId, resolution.targetId)])
  for (const runtime of skillsOf(host.state, resolution.targetId, skillIdsOf)) {
    if (!runtime.interceptTarget) continue
    becomingTarget.push([
      `skill:${runtime.id}`,
      () => runtime.interceptTarget!(host, resolution.targetId, {
        sourceId: resolution.sourceId,
        targetId: resolution.targetId,
        cardId: resolution.cardId,
        cardName: '杀',
        category: 'basic',
      }),
    ])
  }
  /*
   * 旁观者插入点（秦宓【谏征】：既不是使用者也不是目标，只要求「在使用者
   * 攻击范围内」）。和上面两组的区别是遍历对象——不看 sourceId/targetId
   * 自己的技能，看**其他所有存活角色**的技能。
   */
  for (const bystander of host.state.players) {
    if (!bystander.alive || bystander.id === resolution.sourceId || bystander.id === resolution.targetId) continue
    for (const runtime of skillsOf(host.state, bystander.id, skillIdsOf)) {
      if (!runtime.interceptBystanderTarget) continue
      afterTargetSpecified.push([
        `bystander-skill:${runtime.id}:${bystander.id}`,
        () => runtime.interceptBystanderTarget!(host, bystander.id, {
          sourceId: resolution.sourceId,
          targetId: resolution.targetId,
          cardId: resolution.cardId,
          cardName: '杀',
          category: 'basic',
        }),
      ])
    }
  }
  const interceptors = resolution.preparingTargets
    ? resolution.targetPreparationStage === 'becoming-target' ? becomingTarget : afterTargetSpecified
    : [...becomingTarget, ...afterTargetSpecified]
  for (const [id, ask] of interceptors) {
    // 同一个目标只问一次：插入点结算完会回到这里，不记账就会把自己再问一遍
    if (resolution.interceptsDone.includes(id)) continue
    resolution.interceptsDone.push(id)
    if (!ask()) continue
    resolution.stage = 'awaiting-intercept'
    return true
  }
  return false
}

const BAGUA_TAG = 'bagua'

/**
 * 八卦阵判定完成后的分支。
 *
 * 判定牌是红色就等同于打出了一张【闪】，黑色则视为没有响应、伤害照常结算。
 * 结算状态从 `state.cardResolution` 现取——判定期间牌局没有换过这次结算，
 * 但中间可能插过改判询问，所以不能沿用调用前抓下来的引用。
 */
registerJudgmentContinuation(BAGUA_TAG, (host, judged, data) => {
  const engineHost = host as unknown as CardEngineHost
  const resolution = engineHost.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (data.perfect ? judged.suit !== 'spade' : judged.color === 'red') {
    finishDodgedSlash(engineHost, resolution)
    return
  }
  resolution.stage = 'awaiting-dying'
  resolveDamage(engineHost, {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardName: '杀',
    cardId: resolution.cardId,
  })
  if (!engineHost.state.dying && !engineHost.state.damageChain) resumeCardResolution(engineHost)
})

/** 向【杀】的当前目标发出求闪。插入点结束之后也回到这里。 */
function askSlashDodge(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  if (resolution.preparingTargets) {
    advanceSlashTargetPreparation(host, resolution.targetCancelled === true)
    return
  }
  if (isCardUseUnresponsiveToTarget(host.state, resolution.sourceId, resolution.cardId, resolution.targetId, '杀', skillIdsOf)) {
    resolution.noDodge = true
  }
  // 神张飞【神裁】的“杖”只禁止响应【杀】，不影响其他场合使用或打出【闪】。
  if ((player(host.state, resolution.targetId).marks['杖'] ?? 0) > 0) resolution.noDodge = true
  // 铁骑判定成功：这一刀根本不问闪，直接走「没闪掉」那条路。
  // 用 landSlash 而不是直接结算伤害——寒冰剑这类「伤害前」的效果照样要有机会。
  if (resolution.noDodge) {
    landSlash(host, resolution)
    return
  }
  resolution.stage = 'awaiting-dodge'
  askDodge(host, resolution.targetId, `${player(host.state, resolution.sourceId).nickname}对你使用【杀】，请响应【闪】`, true)
}

function canPaySlashResponseCost(state: SanguoshaState, responderId: PlayerId, actionId: string, paymentCardId: CardId): boolean {
  const responder = player(state, responderId)
  if (!responder) return false
  const responseCardId = actionId.startsWith('respond-dodge:') ? actionId.slice('respond-dodge:'.length) : null
  if (paymentCardId === responseCardId) return false
  const after: SanguoshaState = {
    ...state,
    players: state.players.map(candidate => candidate.id !== responderId ? candidate : {
      ...candidate,
      zones: {
        ...candidate.zones,
        hand: candidate.zones.hand.filter(cardId => cardId !== paymentCardId),
        equipment: Object.fromEntries(Object.entries(candidate.zones.equipment).map(([slot, cardId]) => [slot, cardId === paymentCardId ? null : cardId])) as EquipmentZone,
      },
    }),
  }
  if (actionId === GUHUO_RESPOND_ACTION) return after.players.find(candidate => candidate.id === responderId)!.zones.hand.length > 0
  if (actionId === BAGUA_ACTION_ID && responder.zones.equipment.armor === paymentCardId) return false
  if (actionId === MULTI_VIEWAS_ACTION) return canMultiCardViewAs(after, responderId, '闪')
  return true
}

type SlashResponseCostRequirement = { targetId: PlayerId; suit?: import('../types').Suit }
function slashResponseRequirements(resolution: SlashResolutionState, responderId: PlayerId): SlashResponseCostRequirement[] {
  if (resolution.targetId !== responderId) return []
  const explicit: SlashResponseCostRequirement[] = (resolution.responseDiscardCostRequirements ?? []).filter(item => item.targetId === responderId)
  const legacy: SlashResponseCostRequirement[] = resolution.responseDiscardCostTargetIds?.includes(responderId) ? [{ targetId: responderId }] : []
  return [...legacy, ...explicit].sort((a, b) => Number(Boolean(b.suit)) - Number(Boolean(a.suit)))
}
function meetsCostRequirement(state: SanguoshaState, responderId: PlayerId, cardId: CardId, requirement: SlashResponseCostRequirement): boolean {
  return !requirement.suit || effectiveCardSuit(state, responderId, cardId, skillIdsOf) === requirement.suit
}
function canMatchSlashCosts(state: SanguoshaState, responderId: PlayerId, requirements: SlashResponseCostRequirement[], cards: CardId[]): boolean {
  if (!requirements.length) return true
  const [first, ...rest] = requirements
  return cards.some(cardId => meetsCostRequirement(state, responderId, cardId, first)
    && canMatchSlashCosts(state, responderId, rest, cards.filter(candidate => candidate !== cardId)))
}
function eligibleSlashCostCards(state: SanguoshaState, responderId: PlayerId, actionId: string, requirements: SlashResponseCostRequirement[]): CardId[] {
  const responder = player(state, responderId)
  if (!responder || !requirements.length) return []
  const available = [...responder.zones.hand, ...Object.values(responder.zones.equipment).filter((id): id is CardId => Boolean(id))]
    .filter(cardId => canPaySlashResponseCost(state, responderId, actionId, cardId))
  return available.filter(cardId => requirements.some((requirement, index) => meetsCostRequirement(state, responderId, cardId, requirement)
    && canMatchSlashCosts(state, responderId, requirements.filter((_, i) => i !== index), available.filter(candidate => candidate !== cardId))))
}

/**
 * 请某人打出【闪】。
 *
 * 目标自己和主公技代打者共用这条路径，区别只有两点：
 * 代打者没有八卦阵可用（那是目标装备区里的牌），提示词也不一样。
 */
function askDodge(host: CardEngineHost, responderId: PlayerId, prompt: string, allowBagua: boolean): void {
  const responder = player(host.state, responderId)
  /*
   * 「本回合不能打出【闪】」这类禁令在这里一次拦掉：候选一条都不给，
   * 只剩「不响应」。散到各个候选生成里去过滤会漏掉八卦阵、蛊惑、龙魂那几条路。
   */
  if (isCardResponseProhibited(host.state, responderId, '闪', skillIdsOf)) {
    askRespondPassOnly(host, responderId, prompt)
    return
  }
  const sharedHandIds = sharedHandCardSourcesOf(host.state, responderId).flatMap((source) => source.cardIds)
  const actionIds = [...responder.zones.hand, ...sharedHandIds]
    .filter((candidateId) => host.state.cards[candidateId]?.name === '闪')
    .filter((candidateId) => !isResponseCardProhibited(host.state, responderId, candidateId, '闪', skillIdsOf))
    // 身份被强制改写的牌不能再按原用途打出（神刘备【龙怒】阳状态下的红色【闪】）
    .filter((candidateId) => canUseCardAs(host.state, responderId, candidateId, '闪'))
    .map((candidateId) => `respond-dodge:${candidateId}`)
  // 龙胆把【杀】当【闪】打出，同样要作为独立动作发出去
  for (const option of dodgeViewAsOptions(host.state, responderId)) {
    if (!isResponseCardProhibited(host.state, responderId, option.cardId, '闪', skillIdsOf))
      actionIds.push(`respond-dodge:${option.cardId}`)
  }
  // 八卦阵不是手牌，但同样是「打出闪」的一种途径，必须出现在合法动作里，
  // 否则前端永远点不到它——服务端支持不等于前端能用。
  /*
   * 八卦阵是防具技能，会被【无前】按来源压制。求闪时的「来源」就是这张【杀】的使用者，
   * 从当前【杀】结算状态里取——askDodge 本身拿不到，也不该另存一份。
   */
  const slashSourceId = host.state.cardResolution?.kind === 'slash' ? host.state.cardResolution.sourceId : null
  const currentSlash = host.state.cardResolution?.kind === 'slash' ? host.state.cardResolution : null
  const currentSlashColor = currentSlash && !host.state.cards[currentSlash.cardId]?.virtual
    ? effectiveCardColor(host.state, currentSlash.sourceId, currentSlash.cardId, skillIdsOf) : null
  const cardlessResponseBlocked = isCardlessResponseProhibited(host.state, responderId, '闪', skillIdsOf)
  if (!cardlessResponseBlocked && allowBagua && canInvokeBagua(host.state, responderId, slashSourceId, currentSlashColor, currentSlash?.cardId)) actionIds.push(BAGUA_ACTION_ID)
  // 于吉【蛊惑】：声明打出一张【闪】。入口只是多一条动作 id，
  // 挂起和恢复由 game.respondInner 统一处理
  if (canGuhuoRespond(host.state, responderId, '闪', skillIdsOf)) actionIds.push(GUHUO_RESPOND_ACTION)
  // 郭图【诿解】：弃邻居一张牌顶替闪，走和蛊惑一样的集中认领入口
  if (!isCardlessResponseProhibited(host.state, responderId, '闪', skillIdsOf)
    && canWeijieRespond(host.state, responderId, '闪', skillIdsOf)) actionIds.push(WEIJIE_ACTION)
  if (canMultiCardViewAs(host.state, responderId, '闪')) actionIds.push(MULTI_VIEWAS_ACTION)
  // 鲁芝【卫境】：无实体牌视为打出一张闪，每人每轮只可能有一个技能提供
  for (const runtime of skillsOf(host.state, responderId, skillIdsOf)) {
    if (cardlessResponseBlocked) break
    if (runtime.virtualDodge?.(host.state, responderId, slashSourceId)) { actionIds.push(`virtual-dodge:${runtime.id}`); break }
    if (runtime.virtualBasicResponse?.(host.state, responderId, '闪')) actionIds.push(`virtual-basic:${runtime.id}:闪`)
  }
  /*
   * 无亮【忍耐】：本来能响应才给这个入口。
   *
   * `actionIds.length > 0` 就是规则说的「若你可以响应」——手上没【闪】、
   * 被技能禁止响应时这里凑不出任何真响应，自然不能靠「不响应」白拿收益。
   *
   * 只给**目标本人**：主公技代打者走的也是这条路，他不是这张【杀】的目标。
   */
  const slash = host.state.cardResolution
  if (slash?.kind === 'slash' && slash.targetId === responderId
    && canRennai(host.state, responderId, slash.sourceId, actionIds.length > 0,
      usedThisTurn(host.state, responderId, RENNAI_SKILL), skillIdsOf)) {
    actionIds.push(RENNAI_ACTION)
  }
  const requirements = slash?.kind === 'slash' ? slashResponseRequirements(slash, responderId) : []
  const requiresDiscard = slash?.kind === 'slash' && requirements.length > 0
    && !(slash.responsePaymentAuthorized?.playerId === responderId)
  if (requiresDiscard) {
    for (let index = actionIds.length - 1; index >= 0; index -= 1) {
      const actionId = actionIds[index]
      if (actionId === 'respond-pass' || actionId === RENNAI_ACTION) continue
      if (!canMatchSlashCosts(host.state, responderId, requirements, eligibleSlashCostCards(host.state, responderId, actionId, requirements))) actionIds.splice(index, 1)
    }
  }
  actionIds.push('respond-pass')
  const request: RespondCardRequest = {
    // id 必须唯一：主公技代打会在同一个 seq 里连着问好几个人，
    // 复用 id 会让「响应后没有推进」的死锁守卫误报，也会让回放对不上
    id: `request-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt,
    timeoutMs: 30_000,
    optional: true,
    actionIds,
    requiredCardName: '闪',
  }
  host.state.pendingRequests.push(request)
  if (host.state.cardResolution) host.state.cardResolution.requestId = request.id
}

/**
 * 只发一个「不响应」的求牌请求。
 *
 * 「本回合不能打出【闪】」这类禁令下必须仍然**问一次**：求闪这一步是牌结算的
 * 一部分，跳过它会让后续结算没有回应可续接。给的候选只有放弃。
 */
function askRespondPassOnly(host: CardEngineHost, responderId: PlayerId, prompt: string): void {
  const request: RespondCardRequest = {
    id: `request-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'respond-card',
    playerId: responderId,
    prompt,
    timeoutMs: 30_000,
    optional: true,
    actionIds: ['respond-pass'],
    requiredCardName: '闪',
  }
  host.state.pendingRequests.push(request)
  if (host.state.cardResolution) host.state.cardResolution.requestId = request.id
}

/** 选择响应牌后，执行该【杀】附加的额外弃牌成本，再回到同一响应入口。 */
export function beginSlashResponseDiscardPayment(
  host: CardEngineHost,
  request: RespondCardRequest,
  response: GameResponse,
): boolean {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return false
  const requirements = slashResponseRequirements(resolution, response.playerId)
  if (!requirements.length) return false
  const actionId = (response.payload as { actionId?: string }).actionId
  if (!actionId || actionId === 'respond-pass' || actionId === RENNAI_ACTION) return false
  if (resolution.responsePaymentAuthorized?.playerId === response.playerId
    && resolution.responsePaymentAuthorized.actionId === actionId) {
    resolution.responsePaymentAuthorized = null
    return false
  }
  const invalid = validateResponse(request, response)
  if (invalid) throw new Error(invalid)
  const discardable = eligibleSlashCostCards(host.state, response.playerId, actionId, requirements)
  if (!canMatchSlashCosts(host.state, response.playerId, requirements, discardable)) throw new Error('响应【杀】前没有满足花色要求的额外弃置组合')
  const paymentRequest: ChooseCardsRequest = {
    id: `request-slash-response-cost-${host.state.seq}-${host.state.decisions.length}`,
    kind: 'choose-cards', playerId: response.playerId,
    prompt: requirements.length === 1 && requirements[0].suit
      ? `此【杀】要求额外弃置一张${{ spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' }[requirements[0].suit]}牌方可响应；请选择弃置牌`
      : `此【杀】要求额外弃置${requirements.length}张符合条件的牌方可响应；请选择弃置牌`,
    timeoutMs: 20_000, optional: false, purpose: 'skill',
    cardIds: discardable, hiddenCardSlots: [], min: requirements.length, max: requirements.length,
    responsePayment: { responseRequest: structuredClone(request), responseActionId: actionId },
  }
  host.state.pendingRequests = host.state.pendingRequests.filter(candidate => candidate.id !== request.id)
  host.state.pendingRequests.push(paymentRequest)
  resolution.requestId = paymentRequest.id
  return true
}

/** 支付额外成本后把原响应重新送回统一处理器（蛊惑、多牌转化等入口仍可正常工作）。 */
export function resolveSlashResponseDiscardPayment(
  host: CardEngineHost,
  request: ChooseCardsRequest,
  response: GameResponse,
): GameResponse {
  const payment = request.responsePayment
  const resolution = host.state.cardResolution
  if (!payment || resolution?.kind !== 'slash' || resolution.requestId !== request.id) throw new Error('【杀】响应成本请求已过期')
  const invalid = validateResponse(request, response)
  if (invalid) throw new Error(invalid)
  const cardIds = (response.payload as { cardIds: CardId[] }).cardIds
  const requirements = slashResponseRequirements(resolution, response.playerId)
  const uniqueCardIds = [...new Set(cardIds)]
  if (uniqueCardIds.length !== requirements.length || !canMatchSlashCosts(host.state, response.playerId, requirements, uniqueCardIds)) throw new Error('额外弃置牌不满足【杀】的响应代价')
  for (const cardId of uniqueCardIds) {
    const from = locateOwnedCard(host.state, response.playerId, cardId)
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) throw new Error('额外弃置牌已不在手牌或装备区')
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host, response.playerId, cardId)
  }
  host.state.pendingRequests = host.state.pendingRequests.filter(candidate => candidate.id !== request.id)
  host.state.decisions.push({
    index: host.state.decisions.length, requestId: request.id, playerId: response.playerId,
    kind: request.kind, payload: structuredClone(response.payload),
  })
  host.dispatch('LoseCard', { playerId: response.playerId, cardIds: uniqueCardIds, reason: 'slash-response-cost' }, { sourceId: response.playerId, cardIds: uniqueCardIds })
  const originalRequest = payment.responseRequest
  host.state.pendingRequests.push(originalRequest)
  resolution.requestId = originalRequest.id
  resolution.responsePaymentAuthorized = { playerId: response.playerId, actionId: payment.responseActionId }
  return { requestId: originalRequest.id, playerId: response.playerId, payload: { actionId: payment.responseActionId } }
}

/**
 * 主公技代打（护驾）：目标放弃之后，转问同势力角色有没有人替他打。
 *
 * 返回 true 表示已经问出去了，调用方必须直接返回，不要继续结算伤害。
 */
function askLordSurrogate(host: CardEngineHost, resolution: SlashResolutionState): boolean {
  if (resolution.surrogate === null) {
    const runtime = skillsOf(host.state, resolution.targetId, skillIdsOf)
      .find((candidate) => candidate.surrogateResponders)
    if (!runtime) return false
    const order = runtime.surrogateResponders!(host.state, resolution.targetId, '闪')
    if (order.length === 0) return false
    resolution.surrogate = { skillId: runtime.id, order, index: 0 }
  } else {
    resolution.surrogate.index += 1
  }

  const { order, skillId } = resolution.surrogate
  // 问的过程中有人可能已经死了，跳过
  while (resolution.surrogate.index < order.length) {
    const responderId = order[resolution.surrogate.index]
    const responder = host.state.players.find((candidate) => candidate.id === responderId)
    if (responder?.alive) {
      askDodge(host, responderId, `主公需要【闪】，你可以发动【${skillId === 'hujia' ? '护驾' : '代打'}】替他打出`, false)
      return true
    }
    resolution.surrogate.index += 1
  }
  return false
}

/** 火杀 / 雷杀在按钮上要看得出来，普通杀不加前缀。 */
function natureLabel(nature: DamageNature): string {
  return nature === 'fire' ? '火' : nature === 'thunder' ? '雷' : ''
}

function placeDelayedTrick(host: CardEngineHost, action: Extract<LegalAction, { kind: 'use-card' }>): void {
  const [cardId] = action.cardIds
  const [targetId] = action.targetIds
  if (!beginActionPhysicalCard(host, action.playerId, cardId, [targetId], action.asCardName, action.cardIds, action.sourceSkillId, action.cardOwnerId)) return
  const cardName = action.asCardName || host.state.cards[cardId].name
  if (isJudgmentAreaAbolished(host.state, targetId)) {
    finishPhysicalCard(host, action.playerId, cardId, [targetId], true, action.asCardName)
    return
  }
  /*
   * 延时锦囊也能被「取消目标」挡下来（神荀彧【定汉】）。
   *
   * 这条路径没有任何挂起点，所以只认不发问的锁定技式取消；
   * 取消掉就当这张牌用出去但没贴上，直接进弃牌堆。
   */
  const cancelled = skillsOf(host.state, targetId, skillIdsOf).some((runtime) => runtime.cancelsBecomingTarget?.(
    host, targetId,
    { sourceId: action.playerId, targetId, cardId, cardName, category: host.state.cards[cardId].category },
  ))
  if (cancelled) {
    finishPhysicalCard(host, action.playerId, cardId, [targetId], true, action.asCardName)
    return
  }
  // 转化过来的延时锦囊要把「当作什么用」记下来，判定时才按它结算
  if (action.asCardName) setCardAlias(host.state, cardId, action.asCardName)
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'judgingArea', playerId: targetId })
  finishPhysicalCard(host, action.playerId, cardId, [targetId], false, action.asCardName)
}

export function performPlayAction(host: CardEngineHost, playerId: PlayerId, actionId: string): void {
  const action = findLegalAction(legalPlayActions(host.state, playerId), playerId, actionId)
  recordPlayDecision(host, playerId, actionId)
  if (action.kind === 'pass') {
    advanceGamePhase(host)
    return
  }
  if (action.kind === 'invoke-skill') {
    // 装备的主动效果（丈八蛇矛、方天画戟）不在武将技能表里，按 id 全局查
    const own = skillsOf(host.state, playerId, skillIdsOf).find((candidate) => candidate.id === action.skillId)
      ?? (action.skillId.startsWith('equip:') ? getSkillRuntime(action.skillId) : undefined)
    /*
     * 自己也有同名技能，**不代表这条动作是自己的主动技**。
     *
     * 一桌上出现两个同名武将时（娱乐包允许重复，压测的固定阵容也会造出来），
     * 被授权方自己那份「黄天」会先按 id 命中，然后卡在下面的
     * 「技能不可发动」——因为授权类技能只有 `invokeGrantedAction`，没有 `invokeActive`。
     * 所以命中的这份没有 `invokeActive` 时要当作没找到，继续去找真正的授权者。
     */
    const runtime = own?.invokeActive ? own : undefined

    // 主公技授权（黄天）：这条动作属于当前玩家，但技能长在别人身上，
    // 所以在自己的技能表里找不到时再去全场找一遍授权者
    if (!runtime) {
      const grantor = host.state.players.find((candidate) => candidate.alive && candidate.id !== playerId
        && skillsOf(host.state, candidate.id, skillIdsOf)
          .some((skill) => skill.id === action.skillId
            && (skill.grantsPlayActions?.(host.state, candidate.id, playerId) ?? []).some((option) => option.id === action.id)))
      const granted = grantor
        ? skillsOf(host.state, grantor.id, skillIdsOf).find((skill) => skill.id === action.skillId)
        : undefined
      if (!grantor || !granted?.invokeGrantedAction) throw new Error('技能不可发动')
      host.dispatch('SkillActivated', {
        skillId: action.skillId, skillName: skillDisplayName(action.skillId), targetIds: action.targetIds,
      }, { sourceId: playerId })
      granted.invokeGrantedAction(host, grantor.id, playerId, action.id)
      return
    }

    if (!runtime.invokeActive) throw new Error('技能不可发动')
    // 确认技能真的能发动之后再广播，界面才不会为一次失败的点击闪一下技能名。
    // 自己会报横幅的技能不补这条，否则中央会连播两遍同一个技能名
    if (!runtime.announcesSelf) {
      host.dispatch('SkillActivated', {
        skillId: action.skillId, skillName: skillDisplayName(action.skillId), targetIds: action.targetIds,
      }, { sourceId: playerId })
    }
    const activeMetrics = host.state.skillEffectMetrics
    if (!activeMetrics || activeMetrics.skillId !== action.skillId || activeMetrics.ownerId !== playerId)
      host.state.skillEffectMetrics = { skillId: action.skillId, ownerId: playerId, drawnCardNames: [], usedCardNames: [] }
    runtime.invokeActive(host, playerId, action.id)
    const activeResolution = host.state.skillResolution
    const hasContinuation = (activeResolution?.skillId === action.skillId && activeResolution.ownerId === playerId)
      || host.state.skillQueue.some((queued) => queued.skillId === action.skillId && queued.ownerId === playerId)
    if (!hasContinuation) {
      const metrics = host.state.skillEffectMetrics
      if (metrics?.skillId === action.skillId && metrics.ownerId === playerId) {
        host.state.skillEffectMetrics = undefined
        host.dispatch('SkillEffectResolved', {
          skillId: action.skillId, drawnCardNames: [...metrics.drawnCardNames], usedCardNames: [...metrics.usedCardNames],
        }, { sourceId: playerId })
      }
    }
    return
  }
  if (action.kind !== 'use-card') throw new Error('当前不是可执行的出牌动作')
  executeUseCardAction(host, playerId, action)
}

/**
 * 执行一条「使用牌」动作。
 *
 * 从 `performPlayAction` 里拆出来，让于吉【蛊惑】在质疑结束之后能够
 * **重放同一条动作**——那时候 `legalPlayActions` 已经查不到它了
 * （牌进过私有区、出牌次数也可能变了），但规则上这次使用是成立的。
 */
export function executeUseCardAction(
  host: CardEngineHost,
  playerId: PlayerId,
  action: Extract<LegalAction, { kind: 'use-card' }>,
  options: { skipPlayInterceptors?: boolean; countSlashUsage?: boolean; preserveTargets?: boolean; ignoreUsageLimits?: boolean } = {},
): void {
  let [cardId] = action.cardIds
  let card = host.state.cards[cardId]
  /*
   * 丈八蛇矛会带两张牌，每一张都要确认在自己手上。
   *
   * 专属牌堆算「属于自己」：邓艾【急袭】的底牌是武将牌上的「田」，
   * 从那里直接使用，不路过手牌。判定区仍然排除——那不是你能拿去用的牌。
   */
  if (!card || action.cardIds.some((id) => {
    const ownerId = action.cardOwnerId ?? playerId
    if (action.cardOwnerId && sharedHandCardOwnerOf(host.state, playerId, id) !== action.cardOwnerId) return true
    const zone = locateOwnedCard(host.state, ownerId, id, { includeCharacterPiles: true })
    return !zone || zone.kind === 'judgingArea'
  })) throw new Error('卡牌不属于出牌玩家')
  const repeatedEffect = Boolean(card.repeatedEffect)
  if (!repeatedEffect && (action.cardIds.some((id) => isCardUseLocked(host.state, playerId, id))
    || isCardUseProhibited(host.state, playerId, action.asCardName, { dyingPlayerId: null, cardIds: action.cardIds }, skillIdsOf))) {
    /*
     * 多步技能可能在动作合法时开始、跨过若干 Request 后才真正续接到这里。
     * 期间若【限行】已经封住用牌，这条旧动作应安全失效，不能绕过限制，
     * 更不能抛错把整个联机房间打断。普通出牌仍由 legalPlayActions 提前隐藏。
     */
    return
  }
  if (!options.skipPlayInterceptors) {
    for (const owner of host.state.players) {
      if (!owner.alive) continue
      for (const runtime of skillsOf(host.state, owner.id, skillIdsOf)) {
        if (!runtime.interceptPlayAction) continue
        const key = `${owner.id}:${runtime.id}`
        if (action.interceptedSkillKeys?.includes(key)) continue
        const interceptedAction = {
          ...action,
          interceptedSkillKeys: [...(action.interceptedSkillKeys ?? []), key],
        }
        if (runtime.interceptPlayAction(host, owner.id, interceptedAction)) return
      }
    }
  }

  const multiViewAsRuntime = action.sourceSkillId ? getSkillRuntime(action.sourceSkillId) : undefined
  const multiViewAsSpec = multiViewAsRuntime?.multiCardViewAs?.(host.state, playerId)
  if (multiViewAsSpec?.activePlaySuits?.length) {
    const selected = validateMultiCardViewAsSelection(host.state, playerId, action.cardIds, multiViewAsSpec)
    const suit = selected ? host.state.cards[selected[0]]?.suit : undefined
    if (!selected || !suit || !multiViewAsSpec.activePlaySuits.includes(suit)
      || multiViewAsSpec.suitToCardName[suit] !== action.asCardName) return
    const [carrierId, ...costIds] = selected
    multiViewAsSpec.onConvert?.(host.state, playerId, carrierId, selected, action.asCardName)
    const lostCards: CardId[] = []
    for (const materialId of costIds) {
      const from = locateOwnedCard(host.state, playerId, materialId)
      if (!from) return
      moveCard(host.state, materialId, from, { kind: 'discardPile' })
      lostCards.push(materialId)
      if (from.kind === 'equipment') {
        host.dispatch('LoseEquipment', { playerId, cardId: materialId, reason: multiViewAsSpec.skillId }, { targetId: playerId, cardIds: [materialId] })
        handleEquipmentLost(host, playerId, materialId)
      }
    }
    if (lostCards.length) host.dispatch('LoseCard', { playerId, cardIds: lostCards, reason: multiViewAsSpec.skillId }, { sourceId: playerId, cardIds: lostCards })
    // 额外材料已经按转化费用弃置，后续普通使用管线只需处理载体牌。
    action = { ...action, cardIds: [carrierId] }
    setCardAlias(host.state, carrierId, action.asCardName)
    const nature = multiViewAsSpec.natureOf?.[suit]
    if (nature) setCardNature(host.state, carrierId, nature)
    host.dispatch('SkillActivated', {
      skillId: multiViewAsSpec.skillId, skillName: multiViewAsSpec.skillName ?? '龙魂', playerId,
      logText: `【${multiViewAsSpec.skillName ?? '龙魂'}】将${selected.length}张${suitLabel(suit)}牌当作【${action.asCardName}】使用`,
    }, { sourceId: playerId, cardIds: selected })
  }

  if (action.asCardName === '杀' && action.targetIds.length === 1) {
    const physicalOwnerId = action.cardOwnerId ?? playerId
    const color = effectiveCardColor(host.state, physicalOwnerId, cardId)
    if (color === 'black') {
      for (const owner of host.state.players) {
        if (!owner.alive) continue
        const override = skillsOf(host.state, owner.id, skillIdsOf).map((runtime) =>
          runtime.useCardNameOverride?.(host.state, owner.id, playerId, cardId, action.asCardName, action.targetIds) ?? null)
          .find((name): name is string => Boolean(name))
        if (!override) continue
        action = { ...action, asCardName: override }
        break
      }
    }
  }
  if (!repeatedEffect && isCardUseProhibited(host.state, playerId, action.asCardName,
    { dyingPlayerId: null, cardIds: action.cardIds }, skillIdsOf)) return

  // 重铸：弃掉这张牌摸一张，不算「使用」，所以不进处理区、没有无懈窗口
  if (action.id.startsWith('play:recast:')) {
    moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'discardPile' })
    host.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: 'recast' }, { sourceId: playerId, cardIds: [cardId] })
    drawCards(host.state, host.rng, playerId, 1, (name, payload) => host.dispatch(name,
      name === 'GainCard' ? { ...payload, reason: 'recast' } : payload,
      name === 'GainCard' ? { targetId: playerId, cardIds: payload.cardIds as CardId[] } : undefined))
    return
  }

  if (action.retainMaterial) {
    const material = card!
    const virtualId = `virtual:retained-viewas:${host.state.seq + 1}:${host.state.decisions.length}`
    host.state.cards[virtualId] = {
      ...material, id: virtualId, name: action.asCardName, category: 'basic', equipmentSlot: undefined,
      virtual: true, sourceSkillId: action.sourceSkillId,
    }
    host.state.zones.processingArea.push(virtualId)
    cardId = virtualId
    card = host.state.cards[virtualId]
    action = { ...action, cardIds: [virtualId], retainedMaterialId: material.id }
  }

  // 转化出的动作一律以 asCardName 为准：武圣打出的红桃按【杀】结算，
  // 甘宁打出的黑牌按【过河拆桥】结算，后续判定不再看牌面上印的名字。
  const effectiveName = action.asCardName || card.name
  if (action.targetExpansionSkillId && action.targetExpansionTargetId) {
    host.dispatch('TargetExpansionSelected', {
      cardId, cardName: effectiveName, addedTargetId: action.targetExpansionTargetId,
      targetIds: [...action.targetIds], skillId: action.targetExpansionSkillId,
    }, { sourceId: playerId, targetId: action.targetExpansionTargetId, sourceSkillId: action.targetExpansionSkillId, cardIds: [cardId] })
  }
  if (action.nature) setCardNature(host.state, cardId, action.nature)
  const sourceSkillId = action.sourceSkillId ?? skillsOf(host.state, playerId, skillIdsOf).find(runtime =>
    runtime.viewAs?.(host.state, playerId).some(option => option.cardId === cardId && option.asCardName === effectiveName))?.id
  /*
   * 「使用的下一张牌无效」（神黄忠【裂穹·中枢】）。
   *
   * **不是禁止使用**：牌照常打出去、照常离开手牌、使用时机照常触发，
   * 只是效果不产生。提前拦在合法动作里是另一回事——那样玩家连点都点不了，
   * 而规则说的是他可以用，只是用了没用。
   * 无效是**整张牌**无效，多目标牌对所有目标都无效。
   */
  if (hasTargetState(host.state, playerId, ZHONGSHU_STATE)) {
    clearTargetState(host.state, playerId, ZHONGSHU_STATE)
    if (beginActionPhysicalCard(host, playerId, cardId, action.targetIds, effectiveName, action.cardIds, sourceSkillId, action.cardOwnerId)) {
      finishPhysicalCard(host, playerId, cardId, action.targetIds, true, effectiveName)
    }
    return
  }
  if (effectiveName === '杀') {
    const skipSlashCount = skillsOf(host.state, playerId, skillIdsOf).some((runtime) =>
      runtime.slashUseQuotaBypass?.(host.state, playerId, cardId) === true
        || (action.retainMaterial && runtime.id === action.sourceSkillId
          && runtime.slashUseQuotaBypass?.(host.state, playerId, action.retainedMaterialId) === true))
    beginSlash(host, action, { countUsage: options.countSlashUsage ?? !skipSlashCount })
    return
  }
  if (DELAYED_TRICKS.has(effectiveName)) {
    placeDelayedTrick(host, action)
    return
  }
  if (INSTANT_TRICKS.has(effectiveName)) {
    if (!beginActionPhysicalCard(host, playerId, cardId, action.targetIds, effectiveName, action.cardIds, sourceSkillId, action.cardOwnerId)) return
    // 多张实体牌换一张锦囊（袁绍【乱击】）：第一张当主牌，其余跟着一起走
    beginInstantTrick(host, playerId, cardId, action.targetIds, effectiveName, action.cardIds.slice(1), sourceSkillId, options.preserveTargets)
    return
  }
  if (!beginActionPhysicalCard(host, playerId, cardId, action.targetIds, effectiveName, action.cardIds, sourceSkillId, action.cardOwnerId)) return
  const extraBasicMaterials = action.cardIds.slice(1)
  for (const extraId of extraBasicMaterials) {
    const materialOwnerId = action.cardOwnerId ?? playerId
    if (host.state.players.find((candidate) => candidate.id === materialOwnerId)?.zones.hand.includes(extraId))
      moveCard(host.state, extraId, { kind: 'hand', playerId: materialOwnerId }, { kind: 'processingArea' })
  }
  // 这里也要看 effectiveName：转化成【桃】【酒】的牌（于吉【蛊惑】）
  // 按印刷名字判断会掉进最后那个 throw，等于「转化成桃」根本用不出来。
  // 装备只可能是它本身，所以那一支仍然按实体牌算。
  if (effectiveName === '桃') {
    // 通常目标仍是使用者自己；【救援】等技能在使用前可合法改写目标，
    // 这里以已进入 CardUsed 管线的目标列表为准，避免效果目标与事件记录分离。
    recover(host, action.targetIds[0] ?? playerId, 1 + basicCardUseValueBonusOf(host.state, playerId, cardId, effectiveName, skillIdsOf), playerId, cardId)
  } else if (effectiveName === '酒') {
    if (!options.ignoreUsageLimits) host.state.turnUsage.wineUses += 1
    host.state.turnUsage.wineDamageBonus = 1 + basicCardUseValueBonusOf(host.state, playerId, cardId, effectiveName, skillIdsOf)
  } else if (card.category === 'equipment' && card.equipmentSlot) {
    // 动作上带了栏就按它装，否则按这张牌本来的栏；两者都要再验一次没被废除
    const slot = action.equipmentSlot ?? card.equipmentSlot
    if (!equipTargetSlots(host.state, playerId, card.equipmentSlot).includes(slot)) throw new Error('该装备栏不可用')
    const replaced = playerOf(host.state, playerId).zones.equipment[slot as keyof EquipmentZone]
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'equipment', playerId, slot })
    if (replaced) handleEquipmentLost(host, playerId, replaced)
  } else {
    throw new Error(`尚未实现卡牌：${effectiveName}`)
  }
  finishPhysicalCard(host, playerId, cardId, action.targetIds, false, effectiveName)
  for (const extraId of extraBasicMaterials) {
    if (host.state.zones.processingArea.includes(extraId))
      moveCard(host.state, extraId, { kind: 'processingArea' }, { kind: 'discardPile' })
  }
}

/**
 * 技能在使用时机内视为使用一张基本牌。用真实的临时牌身份生成普通合法动作，
 * 再交给 executeUseCardAction 处理限制、使用时机、次数与后续效果，避免技能各自
 * 手写【桃】/【酒】/【杀】的半套结算。
 */
export function beginVirtualBasic(
  host: CardEngineHost,
  options: { sourceId: PlayerId; targetIds: PlayerId[]; cardName: string; sourceSkillId: string },
): boolean {
  if (host.state.cardResolution || !['杀', '桃', '酒'].includes(options.cardName)) return false
  const source = host.state.players.find((candidate) => candidate.id === options.sourceId)
  if (!source?.alive) return false
  const cardId = `virtual:${options.sourceSkillId}:${host.state.seq + 1}:${host.state.decisions.length}`
  host.state.cards[cardId] = {
    id: cardId,
    ruleset: host.state.rulesetVersion,
    expansion: 'standard',
    name: options.cardName,
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'basic',
    virtual: true,
    sourceSkillId: options.sourceSkillId,
  }
  source.zones.hand.push(cardId)
  recordCardHandEntry(host.state, cardId)
  const action = legalPlayActions(host.state, source.id).find((candidate) => candidate.kind === 'use-card'
    && candidate.cardIds.length === 1 && candidate.cardIds[0] === cardId
    && candidate.asCardName === options.cardName
    && candidate.targetIds.length === options.targetIds.length
    && candidate.targetIds.every((targetId, index) => targetId === options.targetIds[index]))
  if (!action || action.kind !== 'use-card') {
    source.zones.hand = source.zones.hand.filter((id) => id !== cardId)
    delete host.state.cards[cardId]
    return false
  }
  executeUseCardAction(host, source.id, { ...action, sourceSkillId: options.sourceSkillId })
  return !source.zones.hand.includes(cardId)
}

/**
 * 这张装备牌现在能装进哪些栏。
 *
 * 武器牌在有第二武器栏的角色身上有两个候选；其余装备各只有一个。
 * 已被废除的栏不出现在候选里。**优先给空栏**：两个武器栏只有一个是空的时候，
 * 玩家不需要被问「你要顶掉哪一把」——空的那个显然是答案。
 */
function equipTargetSlots(state: SanguoshaState, playerId: PlayerId, cardSlot: EquipmentSlot): EquipmentSlot[] {
  const all = equipmentSlotsOf(state, playerId)
  const candidates = cardSlot === 'weapon'
    ? all.filter((slot) => slot === 'weapon' || slot === 'weapon2')
    : all.filter((slot) => slot === cardSlot)
  const empty = candidates.filter((slot) => !playerOf(state, playerId).zones.equipment[slot as keyof EquipmentZone])
  return empty.length > 0 ? [empty[0]] : candidates
}

function removeResponseRequest(state: SanguoshaState, requestId: string): void {
  state.pendingRequests = state.pendingRequests.filter((request) => request.id !== requestId)
}

function recordResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })
}

export function resolveCardResponse(host: CardEngineHost, request: RespondCardRequest, response: GameResponse): void {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.requestId !== request.id) throw new Error('卡牌响应 Request 已经过期')
  // 锦囊效果阶段问的是「打出杀/闪」，和无懈询问不是一回事，交给 tricks 处理
  if (resolution.kind === 'trick' && resolution.stage === 'awaiting-effect') {
    resolveTrickEffectResponse(host, request, response)
    return
  }
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId

  // 鲁芝【卫境】：无实体牌，直接等价于打出了一张闪
  if (actionId.startsWith('virtual-dodge:')) {
    const skillId = actionId.slice('virtual-dodge:'.length)
    const runtime = getSkillRuntime(skillId)
    if (resolution.kind !== 'slash' || isCardlessResponseProhibited(host.state, response.playerId, '闪', skillIdsOf)
      || !runtime?.virtualDodge?.(host.state, response.playerId, resolution.sourceId)) {
      throw new Error('当前不能视为打出【闪】')
    }
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    host.dispatch('CardResponded', { asking: false, playerId: response.playerId, cardId: null, cardName: '闪', virtual: true }, { sourceId: response.playerId, targetId: resolution.sourceId })
    runtime.consumeVirtualDodge?.(host, response.playerId)
    finishDodgedSlash(host, resolution)
    return
  }

  if (actionId.startsWith('virtual-basic:')) {
    const separator = actionId.lastIndexOf(':')
    const skillId = actionId.slice('virtual-basic:'.length, separator)
    const cardName = actionId.slice(separator + 1)
    const runtime = getSkillRuntime(skillId)
    if (!request.actionIds.includes(actionId) || cardName !== request.requiredCardName
      || isCardResponseProhibited(host.state, response.playerId, cardName, skillIdsOf)
      || isCardlessResponseProhibited(host.state, response.playerId, cardName, skillIdsOf)
      || !runtime?.virtualBasicResponse?.(host.state, response.playerId, cardName)
      || resolution.kind !== 'slash' || cardName !== '闪') throw new Error('当前不能虚拟响应此基本牌')
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    if (runtime.beginVirtualBasicResponse?.(host, response.playerId, cardName, request)) return
    host.dispatch('CardResponded', { asking: false, playerId: response.playerId, cardId: null, cardName, virtual: true },
      { sourceId: response.playerId, targetId: resolution.sourceId })
    runtime.consumeVirtualBasicResponse?.(host, response.playerId, cardName)
    finishDodgedSlash(host, resolution)
    return
  }

  // 八卦阵：判定红色就当作打出了一张【闪】，黑色则视为没有响应
  if (actionId === BAGUA_ACTION_ID) {
    // 校验也要带来源，否则前端不显示但服务端照样放行，等于【无前】没压制住
    const slashCard = resolution.kind === 'slash' ? host.state.cards[resolution.cardId] : null
    const slashColor = resolution.kind === 'slash' && slashCard && !slashCard.virtual
      ? effectiveCardColor(host.state, resolution.sourceId, resolution.cardId, skillIdsOf) : null
    if (resolution.kind !== 'slash' || !canInvokeBagua(host.state, response.playerId, resolution.sourceId, slashColor, resolution.cardId)) {
      throw new Error('当前不能发动【八卦阵】')
    }
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    // 判定可能因为改判（鬼才）挂起，红黑分支写在续接里
    const perfect = perfectBagua(host.state, response.playerId)
    performJudgment(host, response.playerId, perfect ? '先天八卦阵' : '八卦阵', { tag: BAGUA_TAG, data: { perfect } })
    return
  }

  // 「本轮均不使用」：这张牌剩下的目标都不再问他。五谷丰登这类多目标锦囊
  // 一路点「不使用」要点五六次，声明一次就够了。
  if (actionId === PASS_ROUND_ACTION) {
    if (resolution.kind !== 'trick') throw new Error('只有多目标锦囊才有本轮均不使用')
    removeResponseRequest(host.state, request.id)
    resolution.requestId = null
    recordResponse(host, request, response)
    if (!resolution.declinedAllIds.includes(response.playerId)) resolution.declinedAllIds.push(response.playerId)
    resolution.responderIndex += 1
    askNullification(host)
    return
  }

  let responseCardId: string | null = null
  let responseCardOwnerId = response.playerId
  let responseViewAsSkillId: string | undefined
  let retainResponseMaterial = false
  if (actionId !== 'respond-pass') {
    const prefix = resolution.kind === 'slash' ? 'respond-dodge:' : 'respond-nullification:'
    const requiredName = resolution.kind === 'slash' ? '闪' : '无懈可击'
    if (!actionId.startsWith(prefix)) throw new Error('响应 action 类型不匹配')
    responseCardId = actionId.slice(prefix.length)
    const responder = player(host.state, response.playerId)
    const heldName = host.state.cards[responseCardId]?.name
    // 蛊惑成立的那一瞬间，那张牌被临时报成声明的牌，沿用这里原有的校验
    const granted = guhuoGrantedAs(host.state, response.playerId, responseCardId) === requiredName
      || multiCardGrantedAs(host.state, response.playerId, responseCardId) === requiredName
    const viewAsOptions = resolution.kind === 'slash'
      ? dodgeViewAsOptions(host.state, response.playerId)
      : responseViewAsOptions(host.state, response.playerId, requiredName)
    const viewAsOption = viewAsOptions.find((option) => option.cardId === responseCardId)
    const convertible = granted || Boolean(viewAsOption)
    if (viewAsOption) {
      retainResponseMaterial = viewAsOption.retainCard === true
      responseViewAsSkillId = skillsOf(host.state, response.playerId, skillIdsOf).find((runtime) =>
        runtime.viewAs?.(host.state, response.playerId).some((option) => option.cardId === responseCardId && option.asCardName === requiredName))?.id
        ?? host.state.players.filter((owner) => owner.alive && owner.id !== response.playerId).find((owner) =>
          skillsOf(host.state, owner.id, skillIdsOf).some((runtime) =>
            runtime.globalResponseViewAs?.(host.state, owner.id, response.playerId, requiredName)
              .some((option) => option.cardId === responseCardId && option.asCardName === requiredName)))
          ?.id
    }
    const responseZone = locateOwnedCard(host.state, responder.id, responseCardId, { includeCharacterPiles: true })
    const sharedOwnerId = sharedHandCardOwnerOf(host.state, responder.id, responseCardId)
    if (sharedOwnerId) responseCardOwnerId = sharedOwnerId
    const actualZone = sharedOwnerId
      ? locateOwnedCard(host.state, sharedOwnerId, responseCardId, { includeCharacterPiles: true })
      : responseZone
    const inHand = actualZone?.kind === 'hand'
    const fromViewAsZone = (responseZone?.kind === 'characterPile' || responseZone?.kind === 'equipment') && convertible
    if ((!inHand && !fromViewAsZone) || (heldName !== requiredName && !convertible)) {
      throw new Error(`响应牌不是该玩家持有的${requiredName}`)
    }
    if (isResponseCardProhibited(host.state, response.playerId, responseCardId, requiredName, skillIdsOf)) {
      throw new Error('当前规则禁止用此牌响应')
    }
  }
  removeResponseRequest(host.state, request.id)
  resolution.requestId = null
  recordResponse(host, request, response)

  if (resolution.kind === 'trick') {
    if (actionId !== 'respond-pass') {
      const cardId = responseCardId!
      const responder = player(host.state, response.playerId)
      const targetId = resolution.targetIds[resolution.targetIndex]
      const unanswerable = skillsOf(host.state, responder.id, skillIdsOf).some(runtime =>
        runtime.unanswerableResponses?.includes('无懈可击'))
        || Boolean(responseViewAsSkillId && host.state.players.some((owner) => owner.alive
          && skillsOf(host.state, owner.id, skillIdsOf).some((runtime) => runtime.id === responseViewAsSkillId
            && runtime.globalResponseViewAs && runtime.globalUnanswerableResponses?.includes('无懈可击'))))
      const from = locateOwnedCard(host.state, responseCardOwnerId, cardId, { includeCharacterPiles: true })
      if (!from) throw new Error('响应牌已不在玩家区域内')
      moveCard(host.state, cardId, from, { kind: 'processingArea' })
      if (from.kind === 'equipment') handleEquipmentLost(host, responseCardOwnerId, cardId)
      if (from.kind === 'hand' && responseCardOwnerId !== responder.id)
        host.dispatch('LoseCard', { playerId: responseCardOwnerId, cardIds: [cardId], reason: 'shared-hand-response' }, { sourceId: responder.id, targetId: responseCardOwnerId, cardIds: [cardId] })
      host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId, cardName: '无懈可击', fromKind: from.kind, cardOwnerId: responseCardOwnerId },
        { sourceId: responder.id, targetId, cardIds: [cardId], ...(responseViewAsSkillId ? { sourceSkillId: responseViewAsSkillId } : {}) })
      clearTemporaryCardSkillTag(host.state, cardId)
      moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      if (from.kind === 'hand') host.dispatch('CardEnteredDiscard', { playerId: responseCardOwnerId, cardId, fromKind: 'hand', reason: 'response' }, { sourceId: responder.id, cardIds: [cardId] })
      resolution.nullificationCount += 1
      // 被无懈之后要从头再问一圈：任何人都可以对这张无懈再无懈。
      // 但记下是谁打的，下一圈跳过他自己——对自己的无懈再叠一张，
      // 效果等于两张都没打，只是白白多问一次（用户报的「连续问两遍」）。
      resolution.lastNullifierId = responder.id
      resolution.responderIndex = unanswerable ? resolution.responderOrder.length : 0
    } else resolution.responderIndex += 1
    askNullification(host)
    return
  }

  if (actionId !== 'respond-pass') {
    const sourceCardId = responseCardId!
    const responder = player(host.state, response.playerId)
    const from = locateOwnedCard(host.state, responseCardOwnerId, sourceCardId, { includeCharacterPiles: true })
    if (!from) throw new Error('响应牌已不在玩家区域内')
    let usedCardId = sourceCardId
    let usedFromKind = from.kind
    if (retainResponseMaterial) {
      const material = host.state.cards[sourceCardId]!
      usedCardId = `virtual:retained-response:${host.state.seq + 1}:${host.state.decisions.length}`
      host.state.cards[usedCardId] = { ...material, id: usedCardId, name: '闪', category: 'basic', equipmentSlot: undefined,
        virtual: true, sourceSkillId: responseViewAsSkillId }
      host.state.zones.processingArea.push(usedCardId)
      usedFromKind = 'equipment'
    } else {
      moveCard(host.state, sourceCardId, from, { kind: 'processingArea' })
      if (from.kind === 'equipment') handleEquipmentLost(host, responseCardOwnerId, sourceCardId)
    }
    if (from.kind === 'hand' && responseCardOwnerId !== responder.id)
      host.dispatch('LoseCard', { playerId: responseCardOwnerId, cardIds: [sourceCardId], reason: 'shared-hand-response' }, { sourceId: responder.id, targetId: responseCardOwnerId, cardIds: [sourceCardId] })
    host.dispatch('CardResponded', { asking: false, playerId: responder.id, cardId: usedCardId, cardName: '闪', slashCardId: resolution.cardId, fromKind: usedFromKind, cardOwnerId: responseCardOwnerId },
      { sourceId: responder.id, targetId: resolution.sourceId, cardIds: [usedCardId], ...(responseViewAsSkillId ? { sourceSkillId: responseViewAsSkillId } : {}) })
    clearTemporaryCardSkillTag(host.state, usedCardId)
    if (retainResponseMaterial) {
      host.state.zones.processingArea = host.state.zones.processingArea.filter((id) => id !== usedCardId)
      delete host.state.cards[usedCardId]
    } else {
      moveCard(host.state, sourceCardId, { kind: 'processingArea' }, { kind: 'discardPile' })
      if (from.kind === 'hand') host.dispatch('CardEnteredDiscard', { playerId: responseCardOwnerId, cardId: sourceCardId, fromKind: 'hand', reason: 'response' }, { sourceId: responder.id, cardIds: [sourceCardId] })
    }
    finishDodgedSlash(host, resolution)
    return
  }

  // 主公技：目标自己不出闪时，同势力角色还有机会代打
  if (askLordSurrogate(host, resolution)) return

  landSlash(host, resolution)
}

/**
 * 【杀】命中之后的结算。
 *
 * 寒冰剑是**替代**伤害，只能问在伤害之前。发问期间结算停在 `awaiting-intercept`——
 * 那个阶段的 invariants 允许挂技能 Request。伤害和收尾都交给它的 resume。
 */
function landSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  const facts: DodgedSlashFacts = {
    sourceId: resolution.sourceId,
    ...(resolution.damageSourceId !== undefined ? { damageSourceId: resolution.damageSourceId } : {}),
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardId: resolution.cardId,
  }
  if (askPreDamageWeapon(host, facts)) {
    resolution.stage = 'awaiting-intercept'
    return
  }

  resolution.stage = 'awaiting-dying'
  resolveDamage(host, { ...facts, cardName: '杀' })
  // 麒麟弓在伤害之后生效，走延后发问队列，不打断还没走完的濒死流程
  queueQilingong(host, facts)
  if (!host.state.dying && !host.state.damageChain) resumeCardResolution(host)
}

/**
 * 一张【闪】打出来之后的收尾。
 *
 * 无双要两张闪，所以先看还差不差；不差了这个目标才算结算完。
 * 武器特效（贯石斧、青龙偃月刀）发问期间结算停在 `awaiting-intercept`，
 * 由它们的 resume 回调 `continueSlash` 接着走。
 */
function finishDodgedSlash(host: CardEngineHost, resolution: SlashResolutionState): void {
  resolution.dodgeRemaining -= 1
  if (resolution.dodgeRemaining > 0) {
    resolution.surrogate = null
    askDodge(host, resolution.targetId, '【无双】仍需再打出一张【闪】', true)
    return
  }
  const facts: DodgedSlashFacts = {
    sourceId: resolution.sourceId,
    targetId: resolution.targetId,
    amount: resolution.damageAmount,
    nature: resolution.damageNature,
    cardId: resolution.cardId,
  }
  // 「杀被【闪】抵消后」的时机链。装备（贯石斧、青龙偃月刀）和武将技能
  // （庞德【猛进】）走同一条链，谁先抢到就先问谁，回答完由各自的 resume
  // 调 continueSlash 交还控制。往这个时机加新技能只需要往这里加一环。
  const afterDodged: Array<() => boolean> = [
    () => askDodgedSlashWeapon(host, facts),
    () => askMengjin(host, facts),
  ]
  for (const ask of afterDodged) {
    if (!ask()) continue
    resolution.stage = 'awaiting-intercept'
    return
  }
  continueSlash(host)
}

/** 技能经过付费请求后完成一张虚拟闪，继续同一张杀的响应结算。 */
export function completeVirtualBasicResponse(
  host: CardEngineHost,
  playerId: PlayerId,
  cardName: string,
  sourceSkillId: string,
  physicalCardIds: CardId[] = [],
): boolean {
  const resolution = host.state.cardResolution
  if (cardName !== '闪' || resolution?.kind !== 'slash' || resolution.targetId !== playerId
    || resolution.stage !== 'awaiting-dodge' || resolution.requestId !== null) return false
  const uniquePhysicalIds = [...new Set(physicalCardIds)]
  if (uniquePhysicalIds.some((cardId) => !host.state.players.find((candidate) => candidate.id === playerId)?.zones.hand.includes(cardId))) return false
  for (const cardId of uniquePhysicalIds) moveCard(host.state, cardId, { kind: 'hand', playerId }, { kind: 'processingArea' })
  host.dispatch('CardResponded', {
    asking: false, playerId, cardId: uniquePhysicalIds[0] ?? null, cardIds: uniquePhysicalIds,
    cardName, virtual: true, physicalCardIds: uniquePhysicalIds,
  }, { sourceId: playerId, targetId: resolution.sourceId, sourceSkillId, cardIds: uniquePhysicalIds })
  for (const cardId of uniquePhysicalIds) {
    moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
    host.dispatch('CardEnteredDiscard', { playerId, cardId, fromKind: 'hand', reason: 'response' }, { sourceId: playerId, cardIds: [cardId] })
  }
  finishDodgedSlash(host, resolution)
  return true
}

/** Restore a suspended response request and resolve it as a pass after a skill conversion fails. */
export function resumeCardResponseAsPass(host: CardEngineHost, request: RespondCardRequest): boolean {
  const resolution = host.state.cardResolution
  if (!resolution || resolution.requestId !== null || host.state.pendingRequests.some((item) => item.id === request.id)) return false
  resolution.requestId = request.id
  host.state.pendingRequests.push(request)
  resolveCardResponse(host, request, { requestId: request.id, playerId: request.playerId, payload: { actionId: 'respond-pass' } })
  return true
}

/** 锦囊效果里的「挑一张牌」响应入口。 */
export function resolveCardPickResponse(host: CardEngineHost, request: ChooseCardsRequest, response: GameResponse): void {
  resolveTrickPickResponse(host, request, response)
}

export function resumeCardResolution(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution) return
  // 锦囊多目标：某个目标濒死救完之后要接着结算剩下的目标
  if (resolution.kind === 'trick') {
    resumeTrickResolution(host)
    return
  }
  if (resolution.stage !== 'awaiting-dying' || host.state.dying) return
  continueSlash(host)
}

/** 技能完成“成为目标后”的发问后，恢复当前目标的正常结算。 */
export function resumeCardTarget(host: CardEngineHost): void {
  const resolution = host.state.cardResolution
  if (!resolution) return
  /*
   * 「成为目标后」的技能可能付出了**会致死的代价**（王异【贞烈】失去 1 点体力）。
   *
   * 这时候两件事都不能做：不能接着结算这张牌（濒死流程还开着，
   * 再造成一次伤害会被引擎直接拒绝），也不能停在 `awaiting-intercept`
   * ——那个阶段的含义是「还在等技能回答」，而回答已经收到了，
   * 不变量会当场报「成为目标阶段缺少技能等待状态」。
   *
   * 正确的做法是把结算**停到等待续接的那个阶段**上：
   * 濒死结清之后，`resumeAfterDying` 会沿着既有的路径把它接着走完。
   */
  if (host.state.dying) {
    if (resolution.kind === 'trick') {
      resolution.stage = 'awaiting-effect'
      resolution.requestId = null
    } else {
      resolution.stage = 'awaiting-dying'
    }
    return
  }
  if (resolution.kind === 'trick') {
    resumeTrickTarget(host)
    return
  }
  if (resolution.targetCancelled) {
    continueSlash(host)
    return
  }
  if (askSlashInterceptors(host)) return
  // 目标/使用者的插入技能可能在指定目标后令整张牌无效；初始目标入口已经
  // 检查过一次，这里须在异步插入窗口恢复后再检查，避免仍向目标索要【闪】。
  if (host.state.invalidatedCardUses?.[resolution.cardId]) {
    continueSlash(host)
    return
  }
  // Re-enter the common target gate after suspension so armor and skill invalidity
  // are checked before asking for a dodge or applying undodgeable damage.
  enterSlashTarget(host)
}

/** Transfer the currently resolving Slash to a new legal target and restart target insertion. */
export function transferSlashTarget(host: CardEngineHost, newTargetId: PlayerId, reason = '技能转移'): void {
  const resolution = host.state.cardResolution
  if (resolution?.kind !== 'slash') return
  const target = playerOf(host.state, newTargetId)
  if (!target?.alive || newTargetId === resolution.sourceId) return
  resolution.targetId = newTargetId
  resolution.surrogate = null
  resolution.interceptsDone = []
  resolution.dodgeRemaining = slashDodgeRequirement(host, resolution.sourceId, newTargetId)
  resolution.noDodge = false
  resolution.targetCancelled = false
  host.dispatch('TargetSpecified', { cardId: resolution.cardId, targetId: newTargetId, reason }, {
    sourceId: resolution.sourceId, targetId: newTargetId, cardIds: [resolution.cardId],
  })
  host.dispatch('TargetConfirmed', { cardId: resolution.cardId, cardName: '杀', targetId: newTargetId, reason }, {
    sourceId: resolution.sourceId, targetId: newTargetId, cardIds: [resolution.cardId],
  })
  enterSlashTarget(host)
}


// 装备特效要回头调用杀的结算，而 equipment-requests 又被这里 import，
// 直接互相 import 会成环，所以把能力交进去。
provideEquipmentCallbacks({
  dealSlashDamage(host, facts: DodgedSlashFacts) {
    const engineHost = host as CardEngineHost
    // 装备特效问完了，阶段要从 awaiting-intercept 拨回来再结算伤害——
    // 那个阶段的 invariants 要求必须挂着技能 Request
    const resolution = engineHost.state.cardResolution
    if (resolution?.kind === 'slash') resolution.stage = 'awaiting-dying'
    const { damageSourceId, ...damageFacts } = facts
    resolveDamage(engineHost, { ...damageFacts, sourceId: damageSourceId !== undefined ? damageSourceId : facts.sourceId, cardName: '杀' })
    // 不管伤害是正常命中还是贯石斧硬吃出来的，麒麟弓都该有机会
    queueQilingong(host, facts)
    // 伤害之后立刻收尾，调用方不用再各自记得调一次——
    // 忘掉的话结算会停在 awaiting-dying，整局卡死。
    // 濒死或属性传导还没走完时先不动，那两条路结束后会回到 resumeCardResolution。
    if (!engineHost.state.dying && !engineHost.state.damageChain) continueSlash(engineHost)
  },
  resumeSlashAfterEquipment(host) {
    const engineHost = host as CardEngineHost
    // Equipment decisions resume the same target gate, including multi-target preparation.
    enterSlashTarget(engineHost)
  },
  startVirtualTrick(host, sourceId, targetId, cardId, asName, cardOwnerId, sourceSkillId) {
    const engineHost = host as CardEngineHost
    // 载体牌在发动技能的人手里，而「使用者」是被指定的那个人——
    // 所以不能直接用 beginPhysicalCard（它会从使用者手上取牌）。
    //
    // 来源不能写死成手牌：离间的代价是「弃置一张牌」，装备也算，
    // 写死 hand 会在貂蝉用装备当代价时抛「卡牌不在来源区域」。
    const from = locateOwnedCard(engineHost.state, cardOwnerId, cardId)
    if (!from) return
    moveCard(engineHost.state, cardId, from, { kind: 'processingArea' })
    if (from.kind === 'equipment') {
      engineHost.dispatch('LoseEquipment', { playerId: cardOwnerId, cardId, slot: from.slot }, { targetId: cardOwnerId, cardIds: [cardId] })
    }
    const metadata = { sourceId, targetId, cardIds: [cardId] }
    engineHost.dispatch('CardUsed', { cardId, cardName: asName, targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetSpecified', { cardId, cardName: asName, targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetConfirmed', { cardId, cardName: asName, targetId }, metadata)
    beginInstantTrick(engineHost, sourceId, cardId, [targetId], asName, [], sourceSkillId)
  },
  continueSlash(host) {
    continueSlash(host as CardEngineHost)
  },
  beginSlashFromAction(host, sourceId, cardIds, targetIds) {
    const engineHost = host as CardEngineHost
    const [first] = targetIds
    const target = engineHost.state.players.find((candidate) => candidate.id === first)
    if (!target) return
    const base = useAction(cardIds[0], sourceId, '杀', targetIds, `对${target.nickname}使用【杀】`)
    if (base.kind !== 'use-card') return
    beginSlash(engineHost, { ...base, cardIds, targetIds })
  },
  beginBorrowedSlash(host, sourceId, targetId, cardId) {
    const engineHost = host as CardEngineHost
    // 借刀本身的结算可能已经把人打死、把牌局打完了，前提不成立就别再起一次【杀】
    if (engineHost.state.status !== 'playing') return
    const attacker = engineHost.state.players.find((candidate) => candidate.id === sourceId)
    const victim = engineHost.state.players.find((candidate) => candidate.id === targetId)
    if (!attacker?.alive || !victim?.alive) return
    if (!cardId) {
      cardId = `virtual:borrowed-knife:${engineHost.state.seq + 1}:${engineHost.state.decisions.length}`
      engineHost.state.cards[cardId] = {
        id: cardId, ruleset: engineHost.state.rulesetVersion, expansion: 'standard', name: '杀',
        suit: 'spade', rank: 1, color: 'black', category: 'basic', virtual: true,
        sourceSkillId: '借刀杀人',
      }
      engineHost.state.zones.processingArea.push(cardId)
    }
    // 打出时这张【杀】已经进了弃牌堆，挪回处理区当作这次结算的实体牌
    if (engineHost.state.zones.discardPile.includes(cardId)) {
      moveCard(engineHost.state, cardId, { kind: 'discardPile' }, { kind: 'processingArea' })
    }
    const metadata = { sourceId, targetId, cardIds: [cardId] }
    engineHost.dispatch('CardUsed', { cardId, cardName: '杀', targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetSpecified', { cardId, cardName: '杀', targetIds: [targetId] }, metadata)
    engineHost.dispatch('TargetConfirmed', { cardId, cardName: '杀', targetId }, metadata)
    engineHost.state.cardResolution = {
      kind: 'slash', cardId, sourceId, targetId,
      damageNature: slashNatureFor(engineHost.state, sourceId, effectiveDamageNature(engineHost.state, cardId)),
      // 借刀的【杀】不吃使用者的酒，也不占他的出杀次数——那不是他的出牌阶段
      damageAmount: 1,
      stage: 'awaiting-dodge', requestId: null, surrogate: null, interceptsDone: [],
      extraCardIds: [], remainingTargetIds: [],
      dodgeRemaining: slashDodgeRequirement(engineHost, sourceId, targetId),
    }
    enterSlashTarget(engineHost)
  },
  transferSlashTarget(host, newTargetId, reason = '流离') {
    transferSlashTarget(host as CardEngineHost, newTargetId, reason)
  },
  useExtraSlash(host, sourceId, targetId, cardId) {
    const engineHost = host as CardEngineHost
    /*
     * **调用方必须先把外层那张【杀】彻底收完再进来。**
     *
     * 这里原来自己调 `continueSlash`，但多目标【杀】（太史慈【天义】、方天画戟）
     * 的 `continueSlash` 会推进到下一个目标并**当场发出求闪请求**，
     * 紧接着下面的 `beginSlash` 就把 `cardResolution` 覆盖掉了——
     * 那个刚发出去的请求从此没有对应的结算状态，谁回答都会撞上
     * 「卡牌响应 Request 已经过期」。约一千局出一次，压测抓到过。
     */
    const target = playerOf(engineHost.state, targetId)
    // 青龙偃月刀的追杀不受距离和次数限制，所以不走 legalPlayActions，
    // 直接构造动作。用完把次数补回去，免得吃掉本回合正常的出杀机会。
    const usesBefore = engineHost.state.turnUsage.slashUses
    const turnUsesBefore = engineHost.state.turnUsage.slashUsesThisTurn ?? 0
    const extraSlash = useAction(cardId, sourceId, '杀', [targetId], `【青龙偃月刀】追加【杀】，目标${target.nickname}`)
    if (extraSlash.kind !== 'use-card') throw new Error('青龙偃月刀追杀动作构造失败')
    beginSlash(engineHost, { ...extraSlash, id: `equip:qinglong:${cardId}:${targetId}` })
    engineHost.state.turnUsage.slashUses = usesBefore
    engineHost.state.turnUsage.slashUsesThisTurn = turnUsesBefore
  },
})


// 性别表在武将数据那边，运行时回注，引擎不反向依赖 data 层


// 流离要按攻击范围找可转移的目标，技能表和距离计算都在别处，运行时回注
provideSkillLookup(skillIdsOf, canTarget)


// 装备的主动效果要按出杀次数和距离筛目标，这些计算在这里，运行时回注
provideSlashLookup(
  (state: SanguoshaState, playerId: PlayerId) => canUseSlash(state, playerId, hasUnlimitedSlash(state, playerId)),
  (state: SanguoshaState, playerId: PlayerId) => state.players
    .filter((target) => canTarget(state, playerId, target.id) && !isTargetProhibited(state, playerId, target.id, '杀', skillIdsOf))
    .map((target) => target.id),
)
