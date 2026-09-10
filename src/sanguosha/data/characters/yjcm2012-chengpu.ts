import { cardDamageDealt } from '../../engine/card-damage-ledger'
import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { clearDeclinedThisPhase, declinedThisPhase, markDeclinedThisPhase } from '../../engine/phase-usage'
import { recover } from '../../engine/recover'
import { loseHp } from '../../engine/hp'
import { registerSkillRuntime } from '../../engine/skills/runtime'
import { useVirtualWine } from '../../engine/virtual-wine'
import { effectiveCardName, moveCard, setCardNature } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 程普（一将成名 2012）。
 *
 * 【疠火】：你可以将你使用的普通【杀】改为火【杀】，若如此做，该【杀】结算结束后，
 *          若其造成过伤害，你失去 1 点体力。你使用火【杀】时可以多选择一个目标。
 * 【醇醪】：结束阶段，若你没有「醇」，你可以将任意张【杀】置于你的武将牌上，
 *          称为「醇」；当一名角色处于濒死状态时，你可以移去一张「醇」，
 *          视为该角色使用一张【酒】。
 *
 * 六处最容易做错的：
 *
 * 1. **转换发生在指定目标之前**。先问改不改，改完才选目标——
 *    倒过来的话「火【杀】多选一个目标」就永远用不上。
 * 2. **转换的是同一次使用**，不新造牌：实体牌仍是原来那张【杀】，
 *    只是这次使用的属性变成火。雷【杀】不能转换（它不是普通【杀】）。
 * 3. **额外目标按最终属性给**，所以本来就是火【杀】的也能多选一个，
 *    而且**不因此失去体力**——代价只属于「疠火把普通杀改成火杀」这一种。
 * 4. **「造成过伤害」以这张牌的这次使用为根**：两个目标伤了两次也只失去
 *    **1 点**体力，而且在**整张牌结算完之后**才失去。
 * 5. **醇只收手牌里的实体【杀】**，转化出来的「视为【杀】」放不进去；
 *    醇不为空时不能再存。
 * 6. **「视为该角色使用一张【酒】」的使用者是那名濒死角色本人**，不是程普。
 */

export const LIHUO = 'lihuo'
export const CHUNLAO = 'chunlao'
/** 武将牌上的「醇」。**公开**：不登记进 `hiddenCharacterPiles`。 */
export const CHUN_PILE = 'chun'
const LIHUO_ACTION = 'lihuo-invoke'
const CHUNLAO_RESCUE_ACTION = 'chunlao-rescue'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 手上可以被疠火改属性的牌：有效牌名是【杀】、而且现在是**普通**属性。 */
function convertibleSlashes(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive) return []
  return owner.zones.hand.filter((cardId) => {
    if (effectiveCardName(state, cardId) !== '杀') return false
    // 雷【杀】、以及已经是火【杀】的都不是「普通【杀】」
    return (state.cards[cardId]?.damageNature ?? 'normal') === 'normal'
  })
}

/** 武将牌上的「醇」。 */
export function chunOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles?.[CHUN_PILE] ?? []
}

// ─────────────────────────────── 疠火 ───────────────────────────────

registerSkillRuntime({
  id: LIHUO,
  announcesSelf: true,
  /*
   * 这条主动入口最终会**使用一张牌**，所以被「不能使用牌」的效果封住时
   * 不该再展示。
   *
   * `legalPlayActions` 末尾那道禁用过滤只筛 `use-card` 动作，筛不到
   * 主动技按钮；不声明这一条的话，按钮照出、点下去却静默失败，
   * 场面一点没变——压测里这就是个无限循环（seed=banner-18）。
   */
  activeActionUsesCard: true,

  /**
   * 「你使用火【杀】时可以多选择一个目标」。
   *
   * 按**属性**给而不是按「是不是疠火改的」给：本来就摸到一张火【杀】时
   * 同样多一个目标，而且那种情况下不付体力代价。
   */
  extraSlashTargets(_state, _ownerId, nature) {
    return nature === 'fire' ? 1 : 0
  },

  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // 这个阶段里已经点开又放弃过：不再报出来，否则会跑成无限循环
    if (declinedThisPhase(state, ownerId, LIHUO)) return []
    const candidates = convertibleSlashes(state, ownerId)
    if (candidates.length === 0) return []
    /*
     * 至少有一张改成火【杀】之后打得出去才给按钮。
     *
     * 逐张试算，用的是引擎的 `declaredCardActions`——自己判断距离和次数
     * 等于把那套规则再抄一遍，迟早和引擎对不上。
     */
    const usable = candidates.some((cardId) => (
      declaredCardActions(state, ownerId, cardId, '杀', '【疠火】', { nature: 'fire' }).length > 0
    ))
    if (!usable) return []
    return [{ id: LIHUO_ACTION, label: '疠火：将一张普通【杀】改为火【杀】使用' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== LIHUO_ACTION) return
    const candidates = convertibleSlashes(host.state, ownerId).filter((cardId) => (
      declaredCardActions(host.state, ownerId, cardId, '杀', '【疠火】', { nature: 'fire' }).length > 0
    ))
    if (candidates.length === 0) return
    host.askSkill({
      skillId: LIHUO, ownerId, step: 'card',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【疠火】：选择一张普通【杀】改为火【杀】使用',
        timeoutMs: 25_000,
        // 取消不付任何代价：疠火没有次数限制
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
    const owner = playerOf(host.state, ownerId)

    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      // 交空数组 = 放弃：留下放弃记号，免得同一个阶段里被反复点开
      if (!cardId) {
        markDeclinedThisPhase(host.state, ownerId, LIHUO)
        return
      }
      if (!owner?.alive || !convertibleSlashes(host.state, ownerId).includes(cardId)) return
      /*
       * **提交的一刻先上锁。**
       *
       * 到这里为止疠火一分代价都没付（属性还没落到牌上），所以后面任何一条
       * 失败分支都会让场面**一点没变**——同一条动作原样重现，压测里就是个
       * 无限循环（seed=banner-18）。先上锁，等这次使用真的落地了再解开：
       * 失败路径必然停住，成功路径一次合法发动都不损失。
       */
      markDeclinedThisPhase(host.state, ownerId, LIHUO)
      /*
       * **先算目标再落属性。**
       *
       * 目标按「已经是火【杀】」算，所以这里把 nature 作为参数传下去，
       * 而不是先 `setCardNature` 再算——玩家可能在选目标那一步取消，
       * 属性已经落在牌上就撤不回来了。
       */
      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【疠火】', { nature: 'fire' })
      const useActions = actions.filter((action) => action.kind === 'use-card')
      // 落地不了就留放弃记号：这一步没有付任何代价，不留记号会被反复点开
      if (useActions.length === 0) {
        markDeclinedThisPhase(host.state, ownerId, LIHUO)
        return
      }
      const candidateIds = [...new Set(useActions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))]
      const maxTargets = Math.max(...useActions.map((action) => action.kind === 'use-card' ? action.targetIds.length : 1))
      host.askSkill({
        skillId: LIHUO, ownerId, step: 'targets', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: maxTargets > 1
            ? '【疠火】：为这张火【杀】选择目标（火【杀】可以多选择一个）'
            : '【疠火】：为这张火【杀】选择目标',
          timeoutMs: 25_000, optional: false,
          candidateIds, min: 1, max: maxTargets,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const cardId = resolution.data.cardId as CardId
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      /*
       * **选目标这一步落空时必须留放弃记号。**
       *
       * 到这里为止疠火一分代价都没付（属性还没落到牌上），所以什么都不做
       * 意味着场面**一点没变**——同一条动作会原样重新出现，选出同样的空目标，
       * 再原样什么都不做。压测里这就是个无限循环（seed=banner-18）。
       */
      const decline = (): void => { markDeclinedThisPhase(host.state, ownerId, LIHUO) }
      if (!owner?.alive) return
      if (targetIds.length === 0) return decline()
      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【疠火】', { nature: 'fire' })
      const action = actions.find((candidate) => candidate.kind === 'use-card'
        && candidate.targetIds.length === targetIds.length
        && candidate.targetIds.every((id) => targetIds.includes(id)))
      if (!action || action.kind !== 'use-card') return decline()

      // 属性落到这张实体牌上：不新造牌，仍然是原来那一张
      setCardNature(host.state, cardId, 'fire')
      host.dispatch('SkillActivated', {
        skillId: LIHUO, skillName: '疠火', playerId: ownerId,
        logText: `${owner.nickname}发动【疠火】，将一张【杀】改为火【杀】使用`,
      }, { sourceId: ownerId })
      /*
       * 记下「**这张牌**是疠火改的」。
       *
       * 代价只属于被疠火改过的那一张，本来就是火【杀】的不付；
       * 所以标记落在牌上，不落在「程普这回合出过火杀」这种回合级判据上。
       */
      host.state.natureConvertedCardIds = [...new Set([...(host.state.natureConvertedCardIds ?? []), cardId])]
      // 真的用出去了：解开提交时上的那把锁，本阶段还能再发动（若还打得出杀）
      clearDeclinedThisPhase(host.state, ownerId, LIHUO)
      executeUseCardAction(host as never, ownerId, action)
    }
  },

  triggers: [{
    /*
     * 「该【杀】**结算结束后**，若其造成过伤害，你失去 1 点体力」。
     *
     * 挂在 `AfterCardUse` 上，读的是按牌记的伤害账
     * （`card-damage-ledger.ts`，账在这条时机之后才销毁）。
     * 两个目标各伤一次也只失去 **1 点**：账是一本，读一次。
     */
    event: 'AfterCardUse',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { cardId?: CardId }
      const cardId = payload.cardId
      if (!cardId || !(host.state.natureConvertedCardIds ?? []).includes(cardId)) return
      host.state.natureConvertedCardIds = (host.state.natureConvertedCardIds ?? []).filter((candidate) => candidate !== cardId)
      if (host.state.natureConvertedCardIds.length === 0) delete host.state.natureConvertedCardIds
      const owner = playerOf(host.state, ownerId)
      // 一点伤害都没造成就不失去体力——被闪掉、被防止、被换成失去体力都算没造成
      if (cardDamageDealt(host.state, cardId) <= 0) return
      if (!owner?.alive) return
      host.dispatch('SkillActivated', {
        skillId: LIHUO, skillName: '疠火', playerId: ownerId,
        logText: `${owner.nickname}的【疠火】造成过伤害，失去 1 点体力`,
      }, { sourceId: ownerId })
      loseHp(host as never, ownerId, 1, LIHUO)
    },
  }],
})

// ─────────────────────────────── 醇醪 ───────────────────────────────

registerSkillRuntime({
  id: CHUNLAO,

  triggers: [{
    /*
     * 「结束阶段，若你没有『醇』，你可以将任意张【杀】置于你的武将牌上」。
     *
     * 「若你没有醇」是**发动条件**，不是「存之前先清空」：
     * 醇没用完就不能再存，这是这个技能自我限速的地方。
     */
    event: 'PhaseStart',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; phase?: string }
      if (payload.playerId !== ownerId || payload.phase !== 'finish') return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || chunOf(host.state, ownerId).length > 0) return
      // 只收**实体**【杀】：转化出来的「视为【杀】」不是一张【杀】牌，放不进去
      const slashes = owner.zones.hand.filter((cardId) => host.state.cards[cardId]?.name === '杀')
      if (slashes.length === 0) return
      host.askSkill({
        skillId: CHUNLAO, ownerId, step: 'store',
        build: (requestId): ChooseCardsRequest => ({
          id: requestId, kind: 'choose-cards', playerId: ownerId,
          prompt: '【醇醪】：将任意张【杀】置于武将牌上作为「醇」',
          timeoutMs: 25_000,
          // 一张都不放就是不发动
          optional: true, purpose: 'skill',
          cardIds: slashes, hiddenCardSlots: [],
          min: 0, max: slashes.length,
        }),
      })
    },
  }],

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'store') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || chunOf(host.state, ownerId).length > 0) return
    const cardIds = [...new Set((response.payload as { cardIds?: CardId[] }).cardIds ?? [])]
      // 落地前重新验一次：发问期间手牌可能被顺被拆
      .filter((cardId) => owner.zones.hand.includes(cardId) && host.state.cards[cardId]?.name === '杀')
    if (cardIds.length === 0) return
    for (const cardId of cardIds) {
      moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'characterPile', playerId: ownerId, pile: CHUN_PILE })
    }
    host.dispatch('SkillActivated', {
      skillId: CHUNLAO, skillName: '醇醪', playerId: ownerId, cardIds,
      logText: `${owner.nickname}发动【醇醪】，将 ${cardIds.length} 张【杀】置于武将牌上作为「醇」`,
    }, { sourceId: ownerId, cardIds })
  },

  /**
   * 「当一名角色处于濒死状态时，你可以移去一张『醇』，视为该角色使用一张【酒】」。
   *
   * 救谁都行，包括程普自己。同一次濒死里可以连续移去多张——
   * 每一轮救援询问各问一次，直到他脱离濒死或程普不再发动。
   */
  rescueActions(state, ownerId, dyingPlayerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || chunOf(state, ownerId).length === 0) return []
    if (!playerOf(state, dyingPlayerId)?.alive) return []
    return [{ id: CHUNLAO_RESCUE_ACTION, label: '发动【醇醪】：移去一张「醇」，视为其使用一张【酒】' }]
  },

  invokeRescueAction(host, ownerId, actionId, dyingPlayerId) {
    if (actionId !== CHUNLAO_RESCUE_ACTION) return false
    const owner = playerOf(host.state, ownerId)
    const [chunId] = chunOf(host.state, ownerId)
    if (!owner?.alive || !chunId) return false
    const dying = playerOf(host.state, dyingPlayerId)
    if (!dying?.alive) return false

    // 醇那张【杀】进弃牌堆；酒是凭空的虚拟牌，两者分开
    moveCard(host.state, chunId, { kind: 'characterPile', playerId: ownerId, pile: CHUN_PILE }, { kind: 'discardPile' })
    host.dispatch('SkillActivated', {
      skillId: CHUNLAO, skillName: '醇醪', playerId: ownerId, cardIds: [chunId],
      logText: `${owner.nickname}移去一张「醇」，视为${dying.nickname}使用一张【酒】`,
    }, { sourceId: ownerId, targetId: dyingPlayerId, cardIds: [chunId] })
    /*
     * **使用者是那名濒死角色本人**，不是程普。
     *
     * 而且濒死时的【酒】不受「一回合一次」约束——实体酒救人走的也是同一条
     * 规则（见 `damage.ts` 的救援候选：那里没有查回合次数）。
     */
    useVirtualWine(host, dyingPlayerId, CHUNLAO)
    recover(host as never, dyingPlayerId, 1, dyingPlayerId)
    return true
  },
})

export const CHENGPU: CharacterDefinition = {
  id: 'chengpu',
  name: '程普',
  kingdom: 'wu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: LIHUO,
      name: '疠火',
      description: '你可以将你使用的普通【杀】改为火【杀】，若如此做，该【杀】结算结束后，若其造成过伤害，你失去1点体力。你使用火【杀】时可以多选择一个目标。',
    },
    {
      id: CHUNLAO,
      name: '醇醪',
      description: '结束阶段，若你没有“醇”，你可以将任意张【杀】置于你的武将牌上，称为“醇”；当一名角色处于濒死状态时，你可以移去一张“醇”，视为该角色使用一张【酒】。',
    },
  ],
}
