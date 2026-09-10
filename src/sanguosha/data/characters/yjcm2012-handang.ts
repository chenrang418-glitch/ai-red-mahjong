import { registerGroupDecision, startGroupDecision } from '../../engine/group-decision'
import { drawCards } from '../../engine/draw'
import { handleEquipmentLost } from '../../engine/equipment'
import { weaponCardsOf } from '../../engine/equipment-slots'
import { declinedThisPhase, markDeclinedThisPhase, markUsedThisPhase, usedThisPhase } from '../../engine/phase-usage'
import { grantTurnSlashBonus } from '../../engine/slash-rules'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import { locateOwnedCard, moveCard } from '../../engine/zones'
import type { ChooseCardsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 韩当（一将成名 2012）。
 *
 * 【弓骑】：出牌阶段限一次，你可以弃置一张牌：本回合你使用【杀】无距离限制；
 *          若你以此法弃置的是装备牌，则本回合你可以额外使用一张【杀】。
 * 【解烦】：限定技，出牌阶段，你可以令所有其他角色各选择一项：
 *          弃置装备区里的武器牌，或令你摸一张牌。
 *
 * 六处最容易做错的：
 *
 * 1. **代价是「一张牌」**：手牌和装备区都行，判定区不行——
 *    和项目里「弃置一张牌」的统一口径一致。
 * 2. **先弃牌，再拿修正**。取消不消耗「出牌阶段限一次」，
 *    但一旦弃了牌，这一次就算用掉了。
 * 3. **「弃的是装备牌」看的是牌的类别**，不看它从哪个区弃的：
 *    手里的一张装备牌同样让他多一张【杀】。
 * 4. **修正走公共的回合级【杀】规则**（`grantTurnSlashBonus`），
 *    由 `turn.ts` 在回合结束统一清；和诸葛连弩、咆哮、将驰、陷阵
 *    按既有聚合规则合并，这里不自己算「还能出几张杀」。
 * 5. **解烦是限定技**：一局一次，走 `usedLimitedSkills` 记账。
 * 6. **没有武器的人只给「令韩当摸一张牌」这一个选项**——
 *    弃不出来的选项不该出现在他的面板上。
 */

export const GONGQI = 'gongqi'
export const JIEFAN = 'jiefan'
const GONGQI_ACTION = 'gongqi-invoke'
const JIEFAN_ACTION = 'jiefan-invoke'
const JIEFAN_TAG = 'jiefan-choice'
const DISCARD_WEAPON = 'discard-weapon'
const LET_DRAW = 'let-draw'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 弓骑的代价候选：手牌 + 装备区。判定区不算。 */
function costCandidates(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  const equipment = Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId))
  return [...owner.zones.hand, ...equipment]
}

// ─────────────────────────────── 弓骑 ───────────────────────────────

registerSkillRuntime({
  id: GONGQI,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    if (usedThisPhase(state, ownerId, GONGQI)) return []
    // 这个阶段里已经点开又放弃过：不再报出来，否则会跑成无限循环
    if (declinedThisPhase(state, ownerId, GONGQI)) return []
    if (costCandidates(state, ownerId).length === 0) return []
    return [{ id: GONGQI_ACTION, label: '弓骑：弃置一张牌，本回合使用【杀】无距离限制' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== GONGQI_ACTION) return
    if (usedThisPhase(host.state, ownerId, GONGQI)) return
    const candidates = costCandidates(host.state, ownerId)
    if (candidates.length === 0) return
    host.askSkill({
      skillId: GONGQI, ownerId, step: 'cost',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【弓骑】：弃置一张牌（弃装备牌可额外使用一张【杀】）',
        timeoutMs: 25_000,
        // 取消不消耗「出牌阶段限一次」：还没付代价，这一次就还在
        optional: true,
        purpose: 'skill',
        cardIds: candidates, hiddenCardSlots: [],
        /*
         * **可取消的「恰好选 N 张」必须写成 `min: 0`。**
         *
         * `optional: true` 只是给界面看的；校验读的是 `min`，超时兜底
         * （`timeout-default.ts`）读的也是 `min === 0`。写成 `min: N` 的话，
         * 交空数组会被判「卡牌选择非法」——技能标着「可以取消」却取消不掉，
         * 联机超时还会退回没有默认答案的分支。
         * 落地那一步再确认张数是不是恰好 N，不足就当作放弃。
         */
        min: 0, max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'cost') return
    const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
    const owner = playerOf(host.state, ownerId)
    // 交空数组 = 放弃：不消耗「出牌阶段限一次」，但要留下放弃记号
    if (!cardId) {
      markDeclinedThisPhase(host.state, ownerId, GONGQI)
      return
    }
    if (!owner?.alive) return
    // 落地前重新验一次：发问期间手牌可能被顺被拆
    const from = locateOwnedCard(host.state, ownerId, cardId)
    if (!from || (from.kind !== 'hand' && from.kind !== 'equipment')) return
    if (usedThisPhase(host.state, ownerId, GONGQI)) return

    /*
     * **「是不是装备牌」在牌离场之前读**。
     *
     * 看的是这张牌的**类别**，不是它从哪个区弃的：手里的一张装备牌
     * 同样算数。按 `from.kind === 'equipment'` 判断是错的——
     * 那样从手里弃装备就白弃了。
     */
    const isEquipment = host.state.cards[cardId]?.category === 'equipment'

    markUsedThisPhase(host.state, ownerId, GONGQI)
    moveCard(host.state, cardId, from, { kind: 'discardPile' })
    if (from.kind === 'equipment') handleEquipmentLost(host, ownerId, cardId)
    host.dispatch('LoseCard', { playerId: ownerId, cardIds: [cardId], reason: GONGQI }, { sourceId: ownerId, cardIds: [cardId] })

    /*
     * 修正走**公共**的回合级【杀】规则：回合结束由 `turn.ts` 统一清。
     * 自己往 state 上挂一个私有布尔量的话，聚合（诸葛连弩、咆哮、天义）
     * 就得在别处再写一遍，而且漏清就变成永久效果。
     */
    grantTurnSlashBonus(host.state, ownerId, {
      ignoreDistance: true,
      ...(isEquipment ? { extraUses: 1 } : {}),
    })
    host.dispatch('SkillActivated', {
      skillId: GONGQI, skillName: '弓骑', playerId: ownerId, cardIds: [cardId],
      logText: isEquipment
        ? `${owner.nickname}发动【弓骑】弃置一张装备牌，本回合使用【杀】无距离限制，且可以额外使用一张【杀】`
        : `${owner.nickname}发动【弓骑】，本回合使用【杀】无距离限制`,
    }, { sourceId: ownerId, cardIds: [cardId] })
  },
})

// ─────────────────────────────── 解烦 ───────────────────────────────

/** 这名角色现在能不能弃出一张武器牌。 */
function hasWeapon(state: SanguoshaState, playerId: PlayerId): boolean {
  return weaponCardsOf(state, playerId).length > 0
}

/** 除韩当之外的存活角色，从当前回合角色起按座次——多人结算的先后要可复现。 */
function decisionOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const current = playerOf(state, state.currentPlayerId)
  const start = current?.seat ?? 0
  const order: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(start + offset) % state.players.length]
    if (candidate.alive && candidate.id !== ownerId) order.push(candidate.id)
  }
  return order
}

registerSkillRuntime({
  id: JIEFAN,
  limited: true,
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(JIEFAN)) return []
    if (decisionOrder(state, ownerId).length === 0) return []
    return [{ id: JIEFAN_ACTION, label: '解烦（限定技）：令所有其他角色弃武器或令你摸一张牌' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== JIEFAN_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.usedLimitedSkills.includes(JIEFAN)) return
    const order = decisionOrder(host.state, ownerId)
    if (order.length === 0) return

    owner.usedLimitedSkills.push(JIEFAN)
    host.dispatch('SkillActivated', {
      skillId: JIEFAN, skillName: '解烦', playerId: ownerId,
      logText: `${owner.nickname}发动限定技【解烦】`,
    }, { sourceId: ownerId })

    startGroupDecision(host, {
      id: `jiefan-${host.state.seq}`,
      tag: JIEFAN_TAG,
      playerIds: order,
      prompt: `${owner.nickname}发动【解烦】：弃置装备区里的武器牌，或令其摸一张牌`,
      options: [
        { id: DISCARD_WEAPON, label: '弃置装备区里的武器牌' },
        { id: LET_DRAW, label: '令其摸一张牌' },
      ],
      /*
       * 没有武器的人只给「令韩当摸一张牌」这一个选项。
       *
       * 给他一个弃不出来的按钮既误导，又会让 AI 选出一个落地时
       * 只能退回兜底的答案——服务端支持不等于这个选择有意义。
       */
      optionsFor: (playerId) => (hasWeapon(host.state, playerId)
        ? [
          { id: DISCARD_WEAPON, label: '弃置装备区里的武器牌' },
          { id: LET_DRAW, label: '令其摸一张牌' },
        ]
        : [{ id: LET_DRAW, label: '令其摸一张牌' }]),
      /*
       * 超时默认「令韩当摸一张牌」。
       *
       * 默认值不能是弃武器：那会替玩家花掉一张实体牌，
       * 和项目里「超时放弃不替玩家出牌」的统一纪律冲突。
       */
      defaultOptionId: LET_DRAW,
      timeoutMs: 20_000,
      data: { ownerId },
    })
  },
})

registerGroupDecision(JIEFAN_TAG, (host, decision) => {
  // 续接拿到的是最小宿主，摸牌要用完整的 SkillHost（它带 rng 和 dispatch）
  const skillHost = host as unknown as SkillHost
  const ownerId = String(decision.data.ownerId ?? '')
  const owner = playerOf(host.state, ownerId)

  /*
   * 按发问顺序逐个结算，**不按选项分组**：弃武器会触发枭姬、白银狮子这类
   * 「失去装备」的效果，那些效果可能反过来改变后面某个人的处境，
   * 所以顺序必须和问的顺序一致、而且可复现。
   */
  let draws = 0
  for (const playerId of decision.playerIds) {
    const target = playerOf(host.state, playerId)
    if (!target?.alive) continue
    const choice = decision.responses[playerId] ?? decision.defaultOptionId
    /*
     * 落地时重新看有没有武器：发问期间他的武器可能已经被别人拆走了。
     * 弃不出来就退回「令韩当摸一张牌」——这是这个二选一的兜底项。
     */
    const weapons = weaponCardsOf(host.state, playerId)
    if (choice === DISCARD_WEAPON && weapons.length > 0) {
      for (const cardId of weapons) {
        const from = locateOwnedCard(host.state, playerId, cardId)
        if (!from) continue
        moveCard(host.state, cardId, from, { kind: 'discardPile' })
        if (from.kind === 'equipment') handleEquipmentLost(host as never, playerId, cardId)
        skillHost.dispatch('LoseCard', { playerId, cardIds: [cardId], reason: JIEFAN }, { sourceId: playerId, cardIds: [cardId] })
      }
      continue
    }
    draws += 1
  }

  if (draws > 0 && owner?.alive) {
    drawCards(host.state, skillHost.rng, ownerId, draws, (name, payload) => { skillHost.dispatch(name, payload) })
  }
})

export const HANDANG: CharacterDefinition = {
  id: 'handang',
  name: '韩当',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: GONGQI,
      name: '弓骑',
      description: '出牌阶段限一次，你可以弃置一张牌：本回合你使用【杀】无距离限制；若你以此法弃置的是装备牌，则本回合你可以额外使用一张【杀】。',
    },
    {
      id: JIEFAN,
      name: '解烦',
      description: '限定技，出牌阶段，你可以令所有其他角色各选择一项：弃置装备区里的武器牌，或令你摸一张牌。',
    },
  ],
}
