import { loseMaxHp } from '../../engine/hp'
import { performJudgment, registerJudgmentContinuation } from '../../engine/judgment'
import type { ChooseOptionRequest } from '../../engine/requests'
import { grantSkill, registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { moveCard } from '../../engine/zones'
import type { CharacterDefinition } from './types'

/**
 * 山包·邓艾。本项目自研表述。。
 *
 * 原文：
 * - **屯田**：当你于回合外失去牌后，你可以进行一次判定，若结果不为红桃，
 *   将此牌置于你的武将牌上，称为「田」。你与其他角色的距离减少 X（X 为「田」的数量）。
 * - **凿险**：觉醒技，准备阶段，若你的「田」不少于三张，你须减 1 点体力上限，并获得【急袭】。
 * - **急袭**：你可以将一张「田」当【顺手牵羊】使用。
 *
 * **不是界邓艾、势邓艾。** 界邓艾的屯田是「摸一张牌」不是判定；
 * 势邓艾有「势」标记。这里一样都没有。
 *
 * 四个公共机制，全部复用，没有一处武将特判：
 * - 「田」用既有的 `characterPiles`（周泰「创」是第一个用户）
 * - 距离减少走 `distanceModifier.toOthers` 的**函数形态**（张数是动态的）
 * - 觉醒走公共 `awakening`，一局一次由引擎记账
 * - 【急袭】用 `viewAs` + `locateOwnedCard` 的专属牌堆开关，田直接当底牌使用
 */

export const TUNTIAN = 'tuntian'
export const ZAOXIAN = 'zaoxian'
export const JIXI = 'jixi'

/** 「田」这一堆的 key。和技能 id 同名，跟周泰「创」用 `buqu` 是同一套约定。 */
const FIELD_PILE = TUNTIAN

const TUNTIAN_TAG = 'tuntian'

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/** 邓艾武将牌上的「田」。 */
export function fieldCardsOf(state: SanguoshaState, ownerId: PlayerId): CardId[] {
  return playerOf(state, ownerId)?.characterPiles[FIELD_PILE] ?? []
}

/**
 * 现在是不是**回合外**。
 *
 * 判据只能是「当前回合角色不是我」，**不能用 `phase === 'none'` 之类**：
 * 别人的回合里有大量嵌套结算（濒死、判定、锦囊连锁），阶段字段五花八门，
 * 但只要回合持有者不是邓艾，那就都是他的回合外。
 */
function isOutsideOwnTurn(state: SanguoshaState, ownerId: PlayerId): boolean {
  return state.currentPlayerId !== ownerId
}

registerJudgmentContinuation(TUNTIAN_TAG, (host, judged, data) => {
  const ownerId = data.ownerId as PlayerId
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  /*
   * **读的是最终生效的判定牌**，不是牌堆顶那张。
   * 司马懿【鬼才】、张角【鬼道】改判之后，`judged` 已经是改判后的结果，
   * 花色也是走统一有效花色口径算出来的。
   */
  if (judged.suit === 'heart') return
  // 判定牌这时在弃牌堆里（判定引擎收尾时放进去的），从那里搬到武将牌上
  if (!host.state.zones.discardPile.includes(judged.id)) return
  moveCard(host.state, judged.id, { kind: 'discardPile' }, { kind: 'characterPile', playerId: ownerId, pile: FIELD_PILE })
  host.dispatch('GainCard', {
    playerId: ownerId, cardIds: [judged.id], reason: TUNTIAN, revealed: true, pile: FIELD_PILE,
  }, { targetId: ownerId, cardIds: [judged.id] })
})

registerSkillRuntime({
  id: TUNTIAN,

  /**
   * 距离修正。
   *
   * **方向是 `toOthers`**：邓艾更容易够到远处的人（出杀、顺手牵羊），
   * 但别人打邓艾的距离不变。写成 `fromOthers` 就变成了「更难被打」，
   * 是完全不同的技能。
   *
   * 负数表示减少；最终距离由 `getDistance` 统一 clamp 到至少 1，
   * 这里不自己夹。
   */
  distanceModifier: {
    toOthers: (state, ownerId) => -fieldCardsOf(state, ownerId).length,
  },

  triggers: [{
    event: 'LoseCard',
    handle(host, ownerId, context) {
      const payload = context.event.payload as { playerId?: PlayerId; cardIds?: CardId[] }
      if (payload.playerId !== ownerId) return
      if (!payload.cardIds?.length) return
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive) return
      // 只在回合外
      if (!isOutsideOwnTurn(host.state, ownerId)) return
      /*
       * **必须走延后队列，不能当场 askSkill。**
       *
       * 失去牌几乎总是发生在别人的牌正在结算的途中（被顺手牵羊、被过河拆桥、
       * 被缔盟换手牌）。那时候引擎可能已经挂着别的技能发问，当场再问就会撞上
       * 「已有技能正在等待回应」直接抛错——压测里立刻就炸了。
       * 队列会等牌局回到干净状态再回调 `startQueued`。
       *
       * **一次失去牌事件 = 一次屯田机会**，不是每张牌各来一次：
       * 「失去牌后」的时机按一次移动事件算，一次被拆走两张牌只判定一次。
       * 这里靠「一条 LoseCard 事件排一项」天然满足。
       */
      host.queueSkill({ skillId: TUNTIAN, ownerId, step: 'ask', data: {} })
    },
  }],

  startQueued(host, ownerId, prompt) {
    if (prompt.step !== 'ask') return
    // 队列里的前提可能已经失效：人死了、回合已经轮到自己了，都安静放弃
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    if (!isOutsideOwnTurn(host.state, ownerId)) return
    host.askSkill({
      skillId: TUNTIAN, ownerId, step: 'ask',
      build: (requestId): ChooseOptionRequest => ({
        id: requestId, kind: 'choose-option', playerId: ownerId,
        prompt: '发动【屯田】？进行一次判定，若结果不为红桃则将判定牌置为「田」',
        timeoutMs: 20_000, optional: true,
        options: [{ id: 'yes', label: '发动屯田' }, { id: 'no', label: '放弃' }],
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    if (resolution.step !== 'ask') return
    if ((response.payload as { optionId: string }).optionId !== 'yes') return
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive) return
    // 判定走统一入口，改判窗口、无懈、战报都由判定引擎负责
    performJudgment(host as never, ownerId, '屯田', { tag: TUNTIAN_TAG, data: { ownerId } })
  },
})

registerSkillRuntime({
  id: ZAOXIAN,
  awakening: {
    phase: 'prepare',
    ready: (state, ownerId) => fieldCardsOf(state, ownerId).length >= 3,
    invoke(host, ownerId) {
      // 觉醒技是强制的：条件成立就发动，不问玩家要不要
      loseMaxHp(host as never, ownerId, 1, '凿险')
      grantSkill(host.state, ownerId, JIXI)
      host.dispatch('SkillActivated', { playerId: ownerId, skillId: ZAOXIAN, granted: JIXI }, { sourceId: ownerId })
    },
  },
})

registerSkillRuntime({
  id: JIXI,
  /**
   * 把一张「田」当【顺手牵羊】使用。
   *
   * 底牌就是那张真实的田——`beginActionPhysicalCard` 打开了专属牌堆开关，
   * 会直接把它从武将牌上搬进处理区，结算完照常进弃牌堆。
   * **不要先把田挪回手牌再用**：那会多一次 GainCard、手牌数闪一下，
   * 还会触发「获得牌后」的技能。
   *
   * 距离、目标有没有牌、帷幕、无懈这些全部由【顺手牵羊】本身的结算负责，
   * 这里只报告「这张牌可以当顺手牵羊用」。
   */
  viewAs(state, ownerId): ViewAsOption[] {
    return fieldCardsOf(state, ownerId).map((cardId) => ({
      asCardName: '顺手牵羊',
      cardId,
      label: `急袭：将「田」${state.cards[cardId]?.name ?? ''}当顺手牵羊使用`,
    }))
  },
})

export const DENGAI: CharacterDefinition = {
  id: 'dengai',
  name: '邓艾',
  kingdom: 'wei',
  gender: 'male',
  maxHp: 4,
  pack: 'mountain',
  skills: [
    {
      id: TUNTIAN,
      name: '屯田',
      description: '当你于回合外失去牌后，你可以进行一次判定，若结果不为红桃，将此牌置于你的武将牌上，称为「田」。你与其他角色的距离减少X（X为「田」的数量）。',
    },
    {
      id: ZAOXIAN,
      name: '凿险',
      description: '觉醒技。准备阶段，若你的「田」不少于三张，你须减1点体力上限，并获得【急袭】。',
    },
    {
      id: JIXI,
      name: '急袭',
      description: '你可以将一张「田」当【顺手牵羊】使用。',
      // 凿险觉醒之后才获得，开局没有
      granted: true,
    },
  ],
}

/** 供 SkillHost 之外的调用方（AI、测试）读取邓艾是否已经觉醒。 */
export function hasAwakenedZaoxian(state: SanguoshaState, ownerId: PlayerId): boolean {
  return playerOf(state, ownerId)?.awakenedSkills.includes(ZAOXIAN) ?? false
}
