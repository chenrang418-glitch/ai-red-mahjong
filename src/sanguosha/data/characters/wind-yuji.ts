import { declaredCardActions, executeUseCardAction } from '../../engine/cards/basic'
import type { CardEngineHost } from '../../engine/cards/host'
import { registerGroupDecision, playersWhoChose, startGroupDecision } from '../../engine/group-decision'
import { loseHp } from '../../engine/hp'
import { drawCards } from '../../engine/draw'
import {
  closePrivateZone, moveIntoPrivateZone, moveOutOfPrivateZone, openPrivateZone, privateZoneCards,
} from '../../engine/private-zone'
import type { ChooseCardsRequest, ChooseOptionRequest, ChooseTargetsRequest } from '../../engine/requests'
import { registerSkillRuntime, type SkillHost } from '../../engine/skills/runtime'
import type { LegalAction } from '../../engine/actions'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import { continueGuhuoRespond } from '../../engine/guhuo-response'
import type { CharacterDefinition } from './types'

/**
 * 于吉【蛊惑】。
 *
 * 经典风包版，锁定的规则文本和逐条口径见 docs/sanguosha-ruleset-v1.md。
 *
 * 蛊惑**不是普通的转化技**。武圣是「红牌确定地视为杀」，蛊惑是
 * 「秘密实体牌 + 公开声明 + 多人独立质疑 + 揭示 + 真假判断 + 决定是否继续结算」。
 * 所以它建在两套本轮新加的公共机制上：
 *
 * - `engine/private-zone.ts`：扣置的那张牌进**私有暂存区**。处理区是完全公开的，
 *   把牌塞进去再让前端别显示，网络包里照样是明文。
 * - `engine/group-decision.ts`：质疑是**多人同时决定**，每人各挂一个请求，
 *   收齐之前谁也看不到别人选了什么。
 *
 * 声明牌的合法性走 `declaredCardActions`——和武圣、奇袭、国色**共用同一份**
 * 出牌次数/距离/禁止目标判断。蛊惑解决的是「实体牌和声明牌不一致」，
 * 不是绕开牌规则。
 */

export const GUHUO = 'guhuo'

/** 质疑的多人决定 tag。 */
const CHALLENGE_TAG = 'guhuo-challenge'
const CHALLENGE = 'guhuo-challenge-yes'
const PASS = 'guhuo-challenge-no'
/** 质疑窗口。和无懈那一档对齐：这是个「信不信」的判断，不需要想很久。 */
const CHALLENGE_TIMEOUT_MS = 8_000

/** 私有区的 id。同一时刻只可能有一次蛊惑，用固定 id 便于恢复和清理。 */
const ZONE_ID = 'guhuo'

/** 延时锦囊不能声明。 */
const DELAYED_TRICKS = new Set(['乐不思蜀', '兵粮寸断', '闪电'])

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  return state.players.find((candidate) => candidate.id === playerId)
}

/**
 * 能声明哪些牌名。
 *
 * 从**当前牌库**里生成：基本牌 + 非延时锦囊。牌库里没有的牌不会出现，
 * 装备和延时锦囊被排除。不写死牌名列表——牌库改了这里自动跟着变。
 */
export function declarableCardNames(state: SanguoshaState): string[] {
  const names = new Set<string>()
  for (const card of Object.values(state.cards)) {
    if (card.category === 'equipment') continue
    if (DELAYED_TRICKS.has(card.name)) continue
    names.add(card.name)
  }
  return [...names].sort()
}

/**
 * 某张牌声明成某个名字之后，现在能产生哪些合法动作。
 *
 * 空数组＝这个声明现在用不了，候选里就不该出现它。
 */
function actionsFor(state: SanguoshaState, ownerId: PlayerId, cardId: CardId, name: string): LegalAction[] {
  return declaredCardActions(state, ownerId, cardId, name, `【蛊惑】声明【${name}】`)
}

/** 出牌阶段现在有没有任何一种可用的声明。 */
function hasAnyDeclaration(state: SanguoshaState, ownerId: PlayerId): boolean {
  const owner = playerOf(state, ownerId)
  if (!owner?.alive || owner.zones.hand.length === 0) return false
  const cardId = owner.zones.hand[0]
  return declarableCardNames(state).some((name) => actionsFor(state, ownerId, cardId, name).length > 0)
}

registerSkillRuntime({
  id: GUHUO,
  activeActionUsesCard: true,
  // 扣牌、声明、质疑各有自己的横幅文案，引擎那条通用的会和它撞在一起
  announcesSelf: true,

  activeActions(state, ownerId) {
    if (!hasAnyDeclaration(state, ownerId)) return []
    return [{ id: `skill:${GUHUO}`, label: '发动【蛊惑】：扣置一张手牌并声明牌名' }]
  },

  invokeActive(host, ownerId, actionId) {
    if (actionId !== `skill:${GUHUO}`) throw new Error('蛊惑动作不匹配')
    const owner = playerOf(host.state, ownerId)
    if (!owner?.alive || owner.zones.hand.length === 0) return
    host.askSkill({
      skillId: GUHUO,
      ownerId,
      step: 'card',
      build: (requestId): ChooseCardsRequest => ({
        id: requestId,
        kind: 'choose-cards',
        playerId: ownerId,
        prompt: '【蛊惑】：选择一张要扣置的手牌',
        timeoutMs: 20_000,
        optional: false,
        purpose: 'skill',
        cardIds: [...owner.zones.hand],
        hiddenCardSlots: [],
        min: 1,
        max: 1,
      }),
    })
  },

  resume(host, ownerId, resolution, response) {
    // 打出模式的选牌步骤：交给 wind-yuji-respond 那边接着走
    if (resolution.step === 'respond-card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      continueGuhuoRespond(host, ownerId, cardId)
      return
    }

    if (resolution.step === 'card') {
      const [cardId] = (response.payload as { cardIds: CardId[] }).cardIds
      const owner = playerOf(host.state, ownerId)
      if (!owner?.alive || !owner.zones.hand.includes(cardId)) return
      // 只把「现在真的用得出来」的声明列进候选，UI 不需要自己判断
      const names = declarableCardNames(host.state)
        .filter((name) => actionsFor(host.state, ownerId, cardId, name).length > 0)
      if (names.length === 0) return
      host.askSkill({
        skillId: GUHUO,
        ownerId,
        step: 'name',
        data: { cardId },
        build: (requestId): ChooseOptionRequest => ({
          id: requestId,
          kind: 'choose-option',
          playerId: ownerId,
          prompt: '【蛊惑】：声明你要使用的牌',
          timeoutMs: 20_000,
          optional: true,
          options: [
            ...names.map((name) => ({ id: `guhuo-name:${name}`, label: `声明【${name}】` })),
            { id: 'cancel', label: '取消蛊惑' },
          ],
        }),
      })
      return
    }

    if (resolution.step === 'name') {
      const cardId = String(resolution.data.cardId ?? '')
      const optionId = (response.payload as { optionId: string }).optionId
      // 牌还留在手里，声明也尚未公开；这是最后一个可以无代价退出的时点。
      if (optionId === 'cancel') return
      if (!optionId.startsWith('guhuo-name:')) throw new Error('蛊惑声明非法')
      const declaredName = optionId.slice('guhuo-name:'.length)
      const actions = actionsFor(host.state, ownerId, cardId, declaredName)
      if (actions.length === 0) throw new Error('这个声明现在用不出来')

      // 目标唯一时不必再问；多个目标才让玩家选
      if (actions.length === 1) {
        beginChallenge(host, ownerId, cardId, declaredName, actions[0].id)
        return
      }
      const candidateIds = [...new Set(actions.flatMap((action) => (action.kind === 'use-card' ? action.targetIds : [])))]
      host.askSkill({
        skillId: GUHUO,
        ownerId,
        step: 'target',
        data: { cardId, declaredName },
        build: (requestId): ChooseTargetsRequest => ({
          id: requestId,
          kind: 'choose-targets',
          playerId: ownerId,
          prompt: `【蛊惑】声明【${declaredName}】：选择目标`,
          timeoutMs: 20_000,
          optional: false,
          candidateIds,
          min: 1,
          max: 1,
        }),
      })
      return
    }

    if (resolution.step !== 'target') return
    const cardId = String(resolution.data.cardId ?? '')
    const declaredName = String(resolution.data.declaredName ?? '')
    const [targetId] = (response.payload as { targetIds: PlayerId[] }).targetIds
    const action = actionsFor(host.state, ownerId, cardId, declaredName)
      .find((candidate) => candidate.kind === 'use-card' && candidate.targetIds.includes(targetId))
    if (!action) throw new Error('目标非法')
    beginChallenge(host, ownerId, cardId, declaredName, action.id)
  },
})

/**
 * 扣牌、公布声明、向其他人发起质疑。
 *
 * 实体牌进私有区**之前**先把动作 id 记下来：质疑结束之后要重放同一条动作，
 * 那时候 `legalPlayActions` 已经查不到它了（牌不在手上、次数也可能变了）。
 */
function beginChallenge(
  host: SkillHost,
  ownerId: PlayerId,
  cardId: CardId,
  declaredName: string,
  actionId: string,
): void {
  const owner = playerOf(host.state, ownerId)
  if (!owner?.alive) return
  const action = actionsFor(host.state, ownerId, cardId, declaredName)
    .find((candidate) => candidate.id === actionId)
  if (!action || action.kind !== 'use-card') throw new Error('蛊惑动作已经失效')

  openPrivateZone(host.state, ZONE_ID, ownerId, GUHUO)
  moveIntoPrivateZone(host.state, cardId, { kind: 'hand', playerId: ownerId }, ZONE_ID)
  host.dispatch('SkillActivated', {
    skillId: GUHUO, skillName: '蛊惑', playerId: ownerId, declaredName, faceDown: true,
  }, { sourceId: ownerId })

  // 质疑者按座次排（当前回合角色起），多人受罚的先后才可复现
  const order = challengeOrder(host.state, ownerId)
  startGroupDecision(host, {
    id: `guhuo-${host.state.seq}`,
    tag: CHALLENGE_TAG,
    playerIds: order,
    prompt: `${owner.nickname}发动【蛊惑】，声明【${declaredName}】，是否质疑？`,
    options: [{ id: CHALLENGE, label: '质疑' }, { id: PASS, label: '不质疑' }],
    defaultOptionId: PASS,
    timeoutMs: CHALLENGE_TIMEOUT_MS,
    data: { ownerId, declaredName, targetIds: action.targetIds, actionId },
  })
}

/** 除于吉之外的存活角色，从当前回合角色起按座次。 */
function challengeOrder(state: SanguoshaState, ownerId: PlayerId): PlayerId[] {
  const current = playerOf(state, state.currentPlayerId)
  const start = current?.seat ?? 0
  const order: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(start + offset) % state.players.length]
    if (candidate.alive && candidate.id !== ownerId) order.push(candidate.id)
  }
  return order
}

registerGroupDecision(CHALLENGE_TAG, (host, decision) => {
  const state = host.state
  const ownerId = String(decision.data.ownerId ?? '')
  const declaredName = String(decision.data.declaredName ?? '')
  const actionId = String(decision.data.actionId ?? '')
  const targetIds = (decision.data.targetIds as PlayerId[] | undefined) ?? []
  const skillHost = host as unknown as SkillHost & CardEngineHost

  const [cardId] = privateZoneCards(state, ZONE_ID)
  const owner = playerOf(state, ownerId)
  // 于吉在质疑期间死了（连锁效果）：牌不能留在私有区里，清掉即可
  if (!cardId || !owner?.alive) {
    closePrivateZone(state, ZONE_ID)
    return
  }

  const realCard = state.cards[cardId]
  // 真假只看实体牌的牌名，不看任何技能修正后的名字
  const truthful = realCard.name === declaredName
  const challengers = playersWhoChose(decision, CHALLENGE)

  if (challengers.length === 0) {
    // 无人质疑：牌按所述之牌结算，不揭示。
    // 这条要有自己的文案：和上面那条声明横幅只隔一次群体决定，
    // 两条都写「于吉发动【蛊惑】」的话中央就是同一句连播两遍
    skillHost.dispatch('SkillActivated', {
      skillId: GUHUO, skillName: '蛊惑', playerId: ownerId, declaredName, challenged: false,
      logText: `无人质疑，${owner.nickname}的【${declaredName}】按所述结算`,
    }, { sourceId: ownerId })
    resolveDeclared(skillHost, ownerId, cardId, actionId, declaredName, targetIds)
    return
  }

  // 有人质疑：统一揭示一次，再统一处理所有质疑者
  skillHost.dispatch('CardMove', {
    playerId: ownerId, cardIds: [cardId], reason: GUHUO, revealed: true,
    declaredName, truthful, challengerIds: [...challengers],
  }, { sourceId: ownerId, cardIds: [cardId] })

  for (const challengerId of challengers) {
    const challenger = playerOf(state, challengerId)
    if (!challenger?.alive) continue
    if (truthful) {
      // 失去体力，不是伤害——奸雄、遗计、刚烈、狂骨都不该被触发
      loseHp(skillHost, challengerId, 1, GUHUO)
    } else {
      drawCards(state, skillHost.rng, challengerId, 1, (name, payload) => {
        skillHost.dispatch(name, { ...payload, reason: GUHUO })
      })
    }
  }

  // 被质疑的牌一律弃置，效果不再结算。唯一例外：红桃且为真时仍然可以使用
  if (truthful && realCard.suit === 'heart') {
    resolveDeclared(skillHost, ownerId, cardId, actionId, declaredName, targetIds)
    return
  }
  moveOutOfPrivateZone(state, cardId, ZONE_ID, { kind: 'discardPile' })
  closePrivateZone(state, ZONE_ID)
})

/**
 * 声明成立：把实体牌放回手上，然后**重放那条使用动作**，走完整的普通结算。
 *
 * 放回手上是因为使用牌的执行器要求牌在手牌区；牌接下来会由正常管线
 * 送进处理区、弃牌堆或装备区，所以不会停在手上。
 */
function resolveDeclared(
  host: SkillHost & CardEngineHost,
  ownerId: PlayerId,
  cardId: CardId,
  actionId: string,
  declaredName: string,
  targetIds: PlayerId[],
): void {
  moveOutOfPrivateZone(host.state, cardId, ZONE_ID, { kind: 'hand', playerId: ownerId })
  closePrivateZone(host.state, ZONE_ID)
  const action = {
    id: actionId,
    kind: 'use-card' as const,
    playerId: ownerId,
    label: `【蛊惑】【${declaredName}】`,
    cardIds: [cardId],
    targetIds: [...targetIds],
    targetMin: targetIds.length,
    targetMax: targetIds.length,
    asCardName: declaredName,
  }
  executeUseCardAction(host, ownerId, action)
}

export const YUJI: CharacterDefinition = {
  id: 'yuji',
  name: '于吉',
  kingdom: 'qun',
  gender: 'male',
  maxHp: 3,
  pack: 'wind',
  skills: [{
    id: GUHUO,
    name: '蛊惑',
    description: '你可以说出任何一种基本牌或非延时类锦囊牌，并正面朝下使用或打出一张手牌。若无人质疑，则该牌按你所述之牌结算；若有人质疑则亮出验明：若为真，质疑者各失去一点体力；若为假，质疑者各摸一张牌。无论真假均弃置该牌，仅当被质疑的牌为红桃且为真时，该牌仍然可以被使用或打出。',
  }],
}
