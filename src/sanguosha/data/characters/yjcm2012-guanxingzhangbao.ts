import { aggregateCardColor, setCardColorOverride } from '../../engine/card-color'
import { createVirtualSlashCard, declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import { finishMultiCardViewAs } from '../../engine/multi-card-viewas'
import { declinedThisPhase, markDeclinedThisPhase } from '../../engine/phase-usage'
import { registerSkillRuntime, replaceTemporarySkills } from '../../engine/skills/runtime'
import { moveCard } from '../../engine/zones'
import type { ChooseCardsRequest, ChooseTargetsRequest } from '../../engine/requests'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 关兴张苞（一将成名 2012）。
 *
 * 【父魂】：你可以将两张手牌当【杀】使用或打出。你于出牌阶段内以此法使用的【杀】
 *          造成伤害后，直到回合结束，你视为拥有【武圣】和【咆哮】。
 *
 * 六处最容易做错的：
 *
 * 1. **恰好两张，而且只能是手牌**。装备区、判定区、专属牌堆都不行；
 *    两张牌的花色、颜色、点数没有任何要求。
 * 2. **「使用」走的是正常的【杀】管线**：距离、出杀次数、酒的增伤、
 *    武器效果、无懈、闪全部照常。写成「技能生成的杀」是错的——
 *    那一类不吃距离和次数，父魂没有这条豁免。
 * 3. **合成出来的【杀】没有花色没有点数**，颜色按两张子牌聚合：
 *    全红算红、全黑算黑、混色**无色**。取第一张子牌的颜色是错的。
 * 4. **授技只认「自己出牌阶段内以父魂使用」**：打出（响应决斗、南蛮）不算，
 *    回合外被别的技能指使着使用也不算。
 * 5. **必须真的造成伤害**：被闪掉、被防止、被换成失去体力都不算。
 * 6. **临时获得的是既有的那两个技能运行时**，不另写一份；到回合结束收回，
 *    而且只收回这一次授予的——别处给的同名技能不会被一起收走。
 */

export const FUHUN = 'fuhun'
const FUHUN_ACTION = 'fuhun-invoke'
/** 临时技能的来源键：收回时按它精确定位，不会误伤别处给的同名技能。 */
const FUHUN_GRANT_SOURCE = 'fuhun:grant'
const GRANTED_SKILL_IDS = ['wusheng', 'paoxiao'] as const
/** 记下授技发生在哪个回合，回合结束时按它收回。 */
const GRANT_TURN_MARK = 'fuhun-granted-turn'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 现在能不能以父魂**使用**一张【杀】。
 *
 * 用一张临时探针牌问引擎「这张【杀】现在有合法动作吗」，问完立刻撤掉——
 * 和神郭嘉【佐幸】列锦囊候选同一个做法。自己判断距离和次数等于把
 * `declaredCardActions` 里那套规则在武将文件里再抄一遍，迟早和引擎对不上。
 */
function canUseFuhunSlash(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.zones.hand.length < 2) return false
  const probeId = `fuhun-probe:${ownerId}`
  state.cards[probeId] = {
    id: probeId,
    ruleset: state.rulesetVersion,
    expansion: 'standard',
    name: '杀',
    suit: 'spade',
    rank: 1,
    color: 'black',
    category: 'basic',
    damageNature: 'normal',
    virtual: true,
  }
  owner.zones.hand.push(probeId)
  try {
    return declaredCardActions(state, ownerId, probeId, '杀', '【父魂】').length > 0
  } finally {
    owner.zones.hand = owner.zones.hand.filter((cardId) => cardId !== probeId)
    delete state.cards[probeId]
  }
}

function discardVirtual(state: SanguoshaState, ownerId: PlayerId, cardId: CardId): void {
  const owner = playerOf(state, ownerId)
  if (owner) owner.zones.hand = owner.zones.hand.filter((candidate) => candidate !== cardId)
  delete state.cards[cardId]
}

registerSkillRuntime({
  id: FUHUN,
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

  // ── 使用：出牌阶段主动把两张手牌当【杀】用 ──
  activeActions(state, ownerId) {
    if (state.phase !== 'play' || state.currentPlayerId !== ownerId) return []
    // 这个阶段里已经点开又放弃过：不再报出来，否则会跑成无限循环
    if (declinedThisPhase(state, ownerId, FUHUN)) return []
    if (!canUseFuhunSlash(state, ownerId)) return []
    return [{ id: FUHUN_ACTION, label: '父魂：将两张手牌当【杀】使用' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== FUHUN_ACTION) return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || !canUseFuhunSlash(host.state, ownerId)) return
    host.askSkill({
      skillId: FUHUN, ownerId, step: 'cards',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId, kind: 'choose-cards', playerId: ownerId,
        prompt: '【父魂】：选择两张手牌当作【杀】使用',
        timeoutMs: 25_000,
        // 取消不付任何代价：父魂没有次数限制，放弃就是放弃
        optional: true,
        purpose: 'skill',
        cardIds: [...owner.zones.hand], hiddenCardSlots: [],
        /*
         * **可取消的「恰好选 N 张」必须写成 `min: 0`。**
         *
         * `optional: true` 只是给界面看的；校验读的是 `min`，超时兜底
         * （`timeout-default.ts`）读的也是 `min === 0`。写成 `min: N` 的话，
         * 交空数组会被判「卡牌选择非法」——技能标着「可以取消」却取消不掉，
         * 联机超时还会退回没有默认答案的分支。
         * 落地那一步再确认张数是不是恰好 N，不足就当作放弃。
         */
        min: 0, max: 2,
      }),
    })
  },

  // ── 打出 / 被要求使用：走公共的多牌转化机制 ──
  multiCardViewAs(state, ownerId) {
    const owner = playerOf(state, ownerId)
    if (!owner?.alive || owner.zones.hand.length < 2) return null
    return {
      skillId: FUHUN,
      skillName: '父魂',
      requiredCount: 2,
      // 不看花色，所以这张表用不上；能凑成什么写在 anySuitCardNames 里
      suitToCardName: {},
      sameSuit: false,
      anySuitCardNames: ['杀'],
      handOnly: true,
      aggregateColor: true,
    }
  },

  resume(host, ownerId, resolution, response) {
    const owner = playerOf(host.state, ownerId)

    /*
     * **打出**这条路走的是公共的多牌转化机制：选牌的问是它发的，
     * 落地也交回它——和神赵云【龙魂】同一个收尾。
     * 这一步不授技：授技只认「出牌阶段内以此法使用」。
     */
    if (resolution.step === 'multi-viewas') {
      finishMultiCardViewAs(host, (response.payload as { cardIds?: CardId[] }).cardIds ?? [])
      return
    }

    if (resolution.step === 'cards') {
      const cardIds = (response.payload as { cardIds?: CardId[] }).cardIds ?? []
      const unique = [...new Set(cardIds)]
      // 张数不足 2（含交空数组）= 放弃：留下放弃记号，免得被反复点开
      if (unique.length !== 2) {
        markDeclinedThisPhase(host.state, ownerId, FUHUN)
        return
      }
      if (!owner?.alive) return
      // 落地前重新验一次：发问期间手牌可能被顺被拆
      if (!unique.every((cardId) => owner.zones.hand.includes(cardId))) return

      /*
       * **代价先付：两张子牌进弃牌堆。**
       *
       * 付完之后再印【杀】，所以随后算出来的合法目标是这张【杀】自己的，
       * 不会把已经被消耗掉的子牌算成还在手上。
       */
      const color = aggregateCardColor(host.state, unique)
      for (const cardId of unique) {
        moveCard(host.state, cardId, { kind: 'hand', playerId: ownerId }, { kind: 'discardPile' }, { discardReason: 'other' })
      }
      host.dispatch('LoseCard', { playerId: ownerId, cardIds: unique, reason: FUHUN }, { targetId: ownerId, cardIds: unique })

      const cardId = createVirtualSlashCard(host.state, ownerId, FUHUN)
      /*
       * 颜色单独记：虚拟牌没有真实花色，不记的话它会被当成牌面上那个
       * 占位花色（黑桃），于禁【毅重】、按红黑分的判据全都会读错。
       */
      setCardColorOverride(host.state, cardId, color)
      host.dispatch('SkillActivated', {
        skillId: FUHUN, skillName: '父魂', playerId: ownerId,
        logText: `${owner.nickname}发动【父魂】，将两张手牌当作【杀】使用`,
      }, { sourceId: ownerId })

      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【父魂】')
      if (actions.length === 0) {
        // 落地时已经没有合法目标：把印出来的牌撤掉，不留残牌
        discardVirtual(host.state, ownerId, cardId)
        markDeclinedThisPhase(host.state, ownerId, FUHUN)
        return
      }
      const candidateIds = [...new Set(actions.flatMap((action) => action.kind === 'use-card' ? action.targetIds : []))]
      host.askSkill({
        skillId: FUHUN, ownerId, step: 'targets', data: { cardId },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId, kind: 'choose-targets', playerId: ownerId,
          prompt: '【父魂】：为这张【杀】选择目标',
          timeoutMs: 25_000, optional: false,
          candidateIds, min: 1, max: 1,
        }),
      })
      return
    }

    if (resolution.step === 'targets') {
      const cardId = resolution.data.cardId as CardId
      const targetIds = (response.payload as { targetIds?: PlayerId[] }).targetIds ?? []
      const actions = declaredCardActions(host.state, ownerId, cardId, '杀', '【父魂】')
      const action = actions.find((candidate) => candidate.kind === 'use-card'
        && candidate.targetIds.length === targetIds.length
        && candidate.targetIds.every((id) => targetIds.includes(id)))
      if (!action || action.kind !== 'use-card') {
        // 选目标落空：撤掉虚拟牌，并留放弃记号免得同一个阶段里被反复点开
        discardVirtual(host.state, ownerId, cardId)
        markDeclinedThisPhase(host.state, ownerId, FUHUN)
        return
      }
      executeUseCardAction(host as never, ownerId, action)
    }
  },

  triggers: [
    {
      /*
       * 「你于出牌阶段内以此法**使用**的【杀】**造成伤害后**」。
       *
       * 三条判据缺一不可：
       * - 这张【杀】是父魂印出来的（`sourceSkillId`），所以打出、
       *   以及别的技能指使着用的杀都不在内；
       * - 现在是**他自己的出牌阶段**（当先给的额外出牌阶段同样算）；
       * - 伤害真的发生了——挂在 `AfterDamage` 上，被闪掉、被防止、
       *   被换成失去体力的那几种根本走不到这里。
       */
      event: 'AfterDamage',
      handle(host, ownerId, context) {
        const payload = context.event.payload as { cardId?: CardId | null }
        const owner = playerOf(host.state, ownerId)
        if (!owner?.alive || context.event.sourceId !== ownerId) return
        if (host.state.phase !== 'play' || host.state.currentPlayerId !== ownerId) return
        const cardId = payload.cardId
        if (!cardId || host.state.cards[cardId]?.sourceSkillId !== FUHUN) return
        // 同一个回合里已经授过就不重复发一遍战报；技能本身也已经在身上了
        if (owner.marks[GRANT_TURN_MARK] === host.state.turnNumber) return

        owner.marks[GRANT_TURN_MARK] = host.state.turnNumber
        replaceTemporarySkills(host.state, ownerId, FUHUN_GRANT_SOURCE, GRANTED_SKILL_IDS)
        host.dispatch('SkillActivated', {
          skillId: FUHUN, skillName: '父魂', playerId: ownerId,
          logText: `${owner.nickname}的【父魂】造成伤害，直到回合结束视为拥有【武圣】【咆哮】`,
        }, { sourceId: ownerId })
      },
    },
    {
      /*
       * 「直到回合结束」——授予的那个回合结束时收回。
       *
       * 判据是回合序号相等，不是「轮到我自己的回合结束」：父魂只在他自己的
       * 出牌阶段里授技，所以这两者本来就是同一个回合；写成回合序号是为了
       * 让额外回合、被跳过的回合都自然对上。
       */
      event: 'TurnEnd',
      allowDeadOwner: true,
      handle(host, ownerId) {
        const owner = playerOf(host.state, ownerId)
        if (!owner || owner.marks[GRANT_TURN_MARK] !== host.state.turnNumber) return
        delete owner.marks[GRANT_TURN_MARK]
        replaceTemporarySkills(host.state, ownerId, FUHUN_GRANT_SOURCE, [])
      },
    },
  ],
})

export const GUANXING_ZHANGBAO: CharacterDefinition = {
  id: 'guanxingzhangbao',
  name: '关兴张苞',
  kingdom: 'shu',
  gender: 'male',
  maxHp: 4,
  pack: 'yjcm2012',
  skills: [
    {
      id: FUHUN,
      name: '父魂',
      description: '你可以将两张手牌当【杀】使用或打出。你于出牌阶段内以此法使用的【杀】造成伤害后，直到回合结束，你视为拥有【武圣】和【咆哮】。',
    },
  ],
}
