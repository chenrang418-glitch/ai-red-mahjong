import { MULTI_VIEWAS_ACTION, canMultiCardViewAs, multiCardGrantedAs } from './multi-card-viewas'
import { clearArmorSuppressionsOf } from './armor-suppression'
import { canUseCardAs, clearForcedIdentitiesOf } from './forced-identity'
import { clearAbolishedSlotsOf } from './equipment-slots'
import { clearTokensOf } from './global-token'
import { releaseStolenSkillsOf } from './skill-theft-expiry'
import { recordTurnKill } from './turn-kills'
import { discardAllCards } from './discard-all'
import { cleanupDetainedCardsOf } from './turn-bound-pile'
import { clearCardCategoryLocksOf, clearCardColorLocksOf } from './card-play-lock'
import { recordCardDamage } from './card-damage-ledger'
import { drawCards } from './draw'
import type { EventContext, GameEvent, GameEventName } from './events'
import { checkIdentityVictory } from './modes/identity'
import type { GameResponse, RescueRequest } from './requests'
import { validateResponse } from './requests'
import { recover } from './recover'
import { damagePreventedBy, isCardUseProhibited, modifiedDamageSource, offerSourceDamagePreventionAsk, offerTargetDamagePreventionAsk, skillsOf, type SkillHost } from './skills/runtime'
import { GUHUO_RESPOND_ACTION, canGuhuoRespond, guhuoGrantedAs } from './guhuo-response'
import { WEIJIE_ACTION, canWeijieRespond } from './weijie-response'
import { skillDisplayName, skillIdsOf } from '../data/characters/standard'
import { adjustDamageAmount } from './equipment'
import { loseHp } from './hp'
import { adjustIncomingDamage, adjustOutgoingDamage, damageReplacedWithHpLoss, interceptIncomingDamage } from './damage-modifiers'
import { DAWU_STATE, KUANGFENG_STATE, applyTargetStateDamage, clearTargetStatesOf } from './target-state'
import type { GameRng } from './rng'
import type { CardId, DamageNature, EquipmentSlot, PlayerId, PlayerState, SanguoshaState } from './types'

/** 战报里怎么称呼一种伤害属性。 */
const DAMAGE_NATURE_NAMES: Record<DamageNature, string> = { normal: '', fire: '火焰', thunder: '雷电', ice: '冰' }
import { moveCard } from './zones'
import { setChained } from './character-state'
import { deathCardClaimantOf, holdDeathCards, releaseDeathCards } from './death-claim'

export interface DamageOptions {
  sourceId?: PlayerId | null
  targetId: PlayerId
  amount?: number
  nature?: DamageNature
  /** 造成这次伤害的牌名。装备特效要靠它区分「【杀】造成的伤害」和别的伤害。 */
  cardName?: string | null
  /** 造成这次伤害的实体牌。奸雄这类「获得造成伤害的牌」的技能要靠它定位。 */
  cardId?: CardId | null
  /**
   * 这次伤害是被哪个技能转移过来的（技能 id）。
   *
   * 转移类技能靠它防止链式转移：牛来【妈妈】把伤害甩给另一个牛来时，
   * 对方不能对同一次伤害再甩一次。**标记跟着伤害走**，
   * 不是记在某个角色身上——记在角色上就挡不住第二个牛来。
   */
  redirectedBy?: string | null
  /**
   * 内部续接标记：来源侧伤害防止已经问过一轮（马谡【制蛮】那类"可以防止"），
   * 不要再挂起重问。只由 `resumeSourceDamagePrevention` 续接时设置，
   * 技能自己不要传这个字段。
   */
  skipSourcePreventionAsk?: boolean
  /** 同上，目标侧版本（杜畿【安东】），只由 `resumeTargetDamagePrevention` 续接时设置。 */
  skipTargetPreventionAsk?: boolean
}

interface InternalDamageOptions extends DamageOptions {
  chainTransfer?: boolean
}

export interface DamageEngineHost {
  state: SanguoshaState
  rng: GameRng
  dispatch(
    name: GameEventName,
    payload?: Record<string, unknown>,
    metadata?: Omit<GameEvent, 'id' | 'seq' | 'name' | 'payload'>,
  ): EventContext
}


function player(state: SanguoshaState, playerId: PlayerId): PlayerState {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

function amountAfter(context: EventContext): number {
  const amount = context.event.payload.amount
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) throw new Error('伤害事件产生了非法伤害值')
  return amount
}

function dispatchDamageTiming(
  host: DamageEngineHost,
  name: GameEventName,
  sourceId: PlayerId | null,
  targetId: PlayerId,
  amount: number,
  nature: DamageNature,
  cardId: CardId | null = null,
  cardName: string | null = null,
  redirectedBy: string | null = null,
): EventContext {
  return host.dispatch(
    name,
    { amount, cardId, cardName, redirectedBy },
    { sourceId: sourceId ?? undefined, targetId, damageNature: nature, cardIds: cardId ? [cardId] : undefined },
  )
}

/**
 * 求桃的询问顺序：**从濒死角色自己开始**，再按座次绕一圈。
 *
 * 起点是濒死角色而不是当前回合角色。别人回合里被打到濒死时，从回合
 * 角色问起会先把队友的【桃】要走，而濒死角色自己的【桃】和【酒】反倒
 * 最后才问到——【酒】只有他本人能用，顺序错了就可能白白花掉队友一张桃。
 */
function rescueOrder(state: SanguoshaState, dyingPlayerId: PlayerId): PlayerId[] {
  const dyingPlayer = player(state, dyingPlayerId)
  const order: PlayerId[] = []
  for (let offset = 0; offset < state.players.length; offset += 1) {
    const candidate = state.players[(dyingPlayer.seat + offset) % state.players.length]
    if (candidate.alive) order.push(candidate.id)
  }
  return order
}

function chainedTargetsAfter(state: SanguoshaState, targetId: PlayerId): PlayerId[] {
  const target = player(state, targetId)
  const result: PlayerId[] = []
  for (let offset = 1; offset < state.players.length; offset += 1) {
    const candidate = state.players[(target.seat + offset) % state.players.length]
    if (candidate.alive && candidate.chained) result.push(candidate.id)
  }
  return result
}

function rescueActionIds(state: SanguoshaState, responderId: PlayerId, dyingPlayerId: PlayerId): string[] {
  const responder = player(state, responderId)
  const viewAsPeach = new Set(skillsOf(state, responderId, skillIdsOf)
    .flatMap((runtime) => runtime.viewAs?.(state, responderId) ?? [])
    .filter((option) => option.asCardName === '桃')
    .map((option) => option.cardId))
  /*
   * 贾诩【完杀】这类「不能使用【桃】」的限制统一在这里问一次。
   *
   * 限制的是**桃**，不是酒：濒死角色用酒自救是另一条规则，
   * 不能被顺手一起禁掉。实体桃、转化桃（急救、龙胆之类）和蛊惑声明的桃
   * 三条路都要挡住，只挡实体牌等于没挡。
   */
  const peachProhibited = isCardUseProhibited(state, responderId, '桃', { dyingPlayerId })
  const usable = responder.zones.hand.filter((cardId) => {
    const name = state.cards[cardId]?.name
    /*
     * 身份被强制改写的牌**不能再按原来的用途用**（高顺【禁酒】：他的【酒】
     * 是【杀】，濒死时救不了自己）。这条统一走 `canUseCardAs`，
     * 不在这里另写一遍判断。
     */
    if (name === '酒') return responderId === dyingPlayerId && canUseCardAs(state, responderId, cardId, '酒')
    if (name === '桃' || viewAsPeach.has(cardId)) return !peachProhibited && canUseCardAs(state, responderId, cardId, '桃')
    return false
  // 身份被强制改写的牌不能再按原用途使用（神刘备【龙怒】阳状态下手里的【桃】）
  }).filter((cardId) => canUseCardAs(state, responderId, cardId, state.cards[cardId]?.name ?? ''))
  const actionIds = [...usable.map((cardId) => `rescue-card:${cardId}`), 'rescue-pass']
  // 于吉【蛊惑】：声明打出一张【桃】救人（含救自己）
  if (!peachProhibited && canGuhuoRespond(state, responderId, '桃', skillIdsOf)) actionIds.push(GUHUO_RESPOND_ACTION)
  if (!peachProhibited && canWeijieRespond(state, responderId, '桃', skillIdsOf)) actionIds.push(WEIJIE_ACTION)
  // 龙魂这类多牌同花色转化：同样只多挂一条声明动作，引擎集中认领
  if (!peachProhibited && canMultiCardViewAs(state, responderId, '桃')) actionIds.push(MULTI_VIEWAS_ACTION)
  /*
   * 技能自己提供的救援途径（曹植【酒诗】：翻面视为使用一张【酒】）。
   * 走同一条 `actionIds`，玩家才点得到。
   */
  for (const runtime of skillsOf(state, responderId, skillIdsOf)) {
    for (const option of runtime.rescueActions?.(state, responderId, dyingPlayerId) ?? []) {
      actionIds.push(option.id)
    }
  }
  return actionIds
}

function removePendingRescue(state: SanguoshaState): void {
  if (!state.dying?.requestId) return
  state.pendingRequests = state.pendingRequests.filter((request) => request.id !== state.dying!.requestId)
  state.dying.requestId = null
}

function requestCurrentRescuer(host: DamageEngineHost): void {
  const dying = host.state.dying
  if (!dying) return
  const target = player(host.state, dying.playerId)
  if (target.hp > 0) {
    host.dispatch('QuitDying', { playerId: target.id, hp: target.hp }, { targetId: target.id })
    host.state.dying = null
    return
  }
  // 没有桃、酒、转化桃或蛊惑入口的人没有任何真实选择，直接越过。
  // 以前仍给每个人发一个只有「放弃」的 Request，8 人局一次阵亡最多空等十几秒。
  let responderId: PlayerId | null = null
  let actionIds: string[] = []
  while (dying.responderIndex < dying.responderOrder.length) {
    const candidateId = dying.responderOrder[dying.responderIndex]
    const candidateActions = rescueActionIds(host.state, candidateId, target.id)
    if (candidateActions.some((actionId) => actionId !== 'rescue-pass')) {
      responderId = candidateId
      actionIds = candidateActions
      break
    }
    dying.responderIndex += 1
  }
  if (!responderId) {
    resolveDeath(host, dying.playerId, dying.sourceId)
    return
  }

  const ask = host.dispatch(
    'AskForPeach',
    { responderId, dyingPlayerId: target.id, requiredRecover: 1 - target.hp },
    { sourceId: responderId, targetId: target.id },
  )
  const request: RescueRequest = {
    id: `request-${ask.event.seq}`,
    kind: 'rescue',
    playerId: responderId,
    prompt: `${target.nickname}濒死，需要回复至至少 1 点体力`,
    timeoutMs: 30_000,
    optional: true,
    dyingPlayerId: target.id,
    actionIds,
    requiredRecover: 1 - target.hp,
  }
  host.state.pendingRequests.push(request)
  dying.requestId = request.id
}

function discardOwnedCards(host: DamageEngineHost, owner: PlayerState, includeJudgingArea: boolean): void {
  for (const cardId of [...owner.zones.hand]) {
    moveCard(host.state, cardId, { kind: 'hand', playerId: owner.id }, { kind: 'discardPile' })
  }
  // 遍历装备区里实际存在的牌：额外武器栏里的那张不能被漏在死者身上
  for (const [slot, cardId] of Object.entries(owner.zones.equipment)) {
    if (cardId) moveCard(host.state, cardId, { kind: 'equipment', playerId: owner.id, slot: slot as EquipmentSlot }, { kind: 'discardPile' })
  }
  if (includeJudgingArea) {
    for (const cardId of [...owner.zones.judgingArea]) {
      moveCard(host.state, cardId, { kind: 'judgingArea', playerId: owner.id }, { kind: 'discardPile' })
    }
  }
}

function resolveDeath(host: DamageEngineHost, playerId: PlayerId, sourceId: PlayerId | null): void {
  removePendingRescue(host.state)
  const dead = player(host.state, playerId)
  host.dispatch('BeforeDeath', { playerId, sourceId }, { sourceId: sourceId ?? undefined, targetId: playerId })
  if (dead.hp > 0) {
    host.state.dying = null
    host.dispatch('QuitDying', { playerId, hp: dead.hp }, { targetId: playerId })
    return
  }
  // BeforeDeath 技能必须把角色实际回复到存活体力；仅取消事件不能形成 0 体力悬空状态。

  if (dead.chained) setChained(host, dead.id, 'death', false)
  dead.alive = false
  dead.identityRevealed = true
  /*
   * 清牌之前先问一句「有人要吗」（曹丕【行殇】）。
   *
   * 有人认领就把牌暂存到处理区，**不进弃牌堆**——「获得死亡角色的牌」和
   * 「从弃牌堆捡回来」不是一回事。真正拿不拿由认领者的技能在 Death 之后发问，
   * 那时候牌局才回到能安全提问的状态。
   */
  /*
   * 暂时扣置着的牌（徐盛【破军】）在这里清理：直接进弃牌堆。
   *
   * **必须排在「有人要吗」之前**：这些牌此刻既不是他的手牌也不是他的装备，
   * 行殇拿到的应该只有真正属于他的那些。清理用的原因是「专属牌堆清理」，
   * 所以落英也不会把它们当成「因弃置进入弃牌堆」。
   */
  cleanupDetainedCardsOf(host as never, playerId)
  const claimant = deathCardClaimantOf(host.state, playerId)
  if (claimant) holdDeathCards(host, dead, claimant)
  else discardOwnedCards(host, dead, true)
  /*
   * 死亡时收掉临时状态：既收挂在他身上的，也收**由他施加**的——
   * 施加者死了就再也不会有「他的下一个回合」，留着等于永久生效。
   */
  clearTargetStatesOf(host.state, playerId)
  clearArmorSuppressionsOf(host.state, playerId)
  clearForcedIdentitiesOf(host.state, playerId)
  clearCardColorLocksOf(host.state, playerId)
  clearCardCategoryLocksOf(host.state, playerId)
  clearAbolishedSlotsOf(host.state, playerId)
  releaseStolenSkillsOf(host.state, playerId)
  clearTokensOf(host.state, playerId)
  // 先记回合内击杀账，再派发 Death：连破挂在回合结束，读的就是这本账
  recordTurnKill(host.state, sourceId, playerId)
  /*
   * **在派发 `Death` 之前就把濒死流程结清。**
   *
   * 走到这里这条濒死流程已经彻底结束了：救援问完了、人确实死了。
   * 原来是 dispatch 完 `Death` 才清，于是 `Death` 上的技能、以及这次死亡之后
   * 继续往下跑的牌结算（决斗还在轮询下一个目标）都看到一个过期的 `state.dying`，
   * 再有人被打到 0 体力时 `enterDying` 直接抛「已有濒死流程正在进行」
   * （压测 seed=soak-5-237）。
   */
  host.state.dying = null
  host.dispatch('Death', { playerId, sourceId, identity: dead.identity }, { sourceId: sourceId ?? undefined, targetId: playerId })

  const killer = sourceId ? host.state.players.find((candidate) => candidate.id === sourceId && candidate.alive) : undefined
  if (dead.identity === 'rebel' && killer) {
    drawCards(host.state, host.rng, killer.id, 3, (name, payload) => { host.dispatch(name, payload) })
  } else if (dead.identity === 'loyalist' && killer?.identity === 'lord') {
    /*
     * 主公杀死忠臣：弃光他自己的牌。
     *
     * 走公共的「弃置所有牌」入口，和马谡【挥泪】同一个实现——
     * 原来这里是直接把两个区搬空，枭姬、旋风、落英、白银狮子这一批
     * 「因弃置而触发」的效果全被静默跳过了。
     */
    discardAllCards(host as never, killer.id, 'identity-punishment')
  }

  const result = checkIdentityVictory(host.state.players)
  if (result) {
    // 牌局就此结束，认领的问句永远不会问出去了：暂存的牌立刻归位，
    // 不能留在处理区变成无主的牌
    releaseDeathCards(host)
    host.state.result = result
    host.state.status = 'game-over'
    for (const candidate of host.state.players) candidate.identityRevealed = true
    host.state.pendingRequests = []
    host.state.damageChain = null
  }
}

/** 「防止了这次伤害」统一报一行战报：牌打过去什么都没发生必须有个说法。 */
function announceDamagePrevented(
  host: DamageEngineHost,
  skillId: string,
  ownerId: PlayerId | null,
  targetId: PlayerId,
  nature: DamageNature,
): void {
  const target = host.state.players.find((candidate) => candidate.id === targetId)
  const skillName = ownerId ? skillDisplayName(host.state, ownerId, skillId) : skillId
  host.dispatch('SkillActivated', {
    skillId, skillName, playerId: ownerId, result: 'damage-prevented',
    logText: `【${skillName}】防止了${target?.nickname ?? ''}受到的这次伤害`,
  }, { targetId, damageNature: nature })
}

function resolveSingleDamage(host: DamageEngineHost, options: InternalDamageOptions): void {
  if (host.state.status !== 'playing') throw new Error('只有进行中的牌局可以造成伤害')
  if (host.state.dying) throw new Error('当前濒死流程尚未结束')
  if (host.state.damageChain && !options.chainTransfer) throw new Error('属性伤害传导尚未结束')
  const target = player(host.state, options.targetId)
  if (!target.alive) throw new Error('不能对死亡角色造成伤害')
  let sourceId = options.sourceId ?? null
  if (sourceId) player(host.state, sourceId)

  /*
   * 伤害来源改写（孟获【祸首】）。
   *
   * 必须在**所有**伤害时机之前完成，否则奸雄、刚烈、狂骨、天香、节命
   * 看到的来源就是原使用者，规则上全错。
   *
   * 只改伤害来源，**不改这张牌的使用者**：牌仍然是曹操用的那张【南蛮入侵】，
   * 无懈、使用日志、CardMove、奸雄「获得造成伤害的牌」依赖的都是使用者，
   * 整体改掉会连锁出一批错误。
   */
  const override = modifiedDamageSource(host.state, {
    sourceId,
    targetId: target.id,
    cardId: options.cardId ?? null,
    cardName: options.cardName ?? null,
    chainTransfer: Boolean(options.chainTransfer),
  })
  if (override) {
    const attributed = override.sourceId ? player(host.state, override.sourceId) : null
    const skillName = skillDisplayName(host.state, override.ownerId, override.skillId)
    host.dispatch('SkillActivated', {
      skillId: override.skillId, skillName, playerId: override.ownerId, targetIds: [target.id], result: 'damage-source',
      logText: `【${skillName}】${target.nickname}受到的这次伤害，来源视为${attributed?.nickname ?? '无'}`,
    }, { sourceId: override.sourceId ?? undefined, targetId: target.id })
    sourceId = override.sourceId
  }

  let nature = options.nature ?? 'normal'
  let amount = options.amount ?? 1
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('伤害值必须是正整数')

  /*
   * 伤害防止 · 来源侧（徐庶【无言】防止自己使用的锦囊造成的伤害）。
   *
   * 排在**数值修正之前**：防止就是「这次伤害没有发生」，
   * 既然不会发生，就没有必要先让裸衣、驭雳去改它的数值和属性，
   * 那些修正的战报也不该出现。来源改写要排在它前面——
   * 得先知道这次伤害算谁造成的，才能问「他有没有防止它」。
   */
  const preventionContext = {
    sourceId,
    targetId: target.id,
    amount,
    nature,
    cardId: options.cardId ?? null,
    cardName: options.cardName ?? null,
    chainTransfer: Boolean(options.chainTransfer),
  }
  const preventedBySource = damagePreventedBy(host.state, sourceId, 'source', preventionContext)
  if (preventedBySource) {
    announceDamagePrevented(host, preventedBySource, sourceId, target.id, nature)
    return
  }
  /*
   * 交互式的来源侧伤害防止询问（马谡【制蛮】"你可以防止"）。
   *
   * 走到这里还没有任何状态被改动（数值修正、连环传导都在后面），
   * 挂起是安全的：`resolveSingleDamage` 直接返回，技能自己调
   * `host.askSkill` 发问，答完后用 `resumeSourceDamagePrevention` 续接，
   * 要么就此终止（防止），要么原样重新调用一次 `resolveDamage`。
   */
  if (!options.skipSourcePreventionAsk
    && offerSourceDamagePreventionAsk(host as unknown as SkillHost, sourceId, preventionContext)) {
    host.state.pendingSourceDamage = {
      options: { ...options, sourceId, amount, nature, cardId: options.cardId ?? null, cardName: options.cardName ?? null },
    }
    return
  }

  /*
   * 技能对属性和数值的修正排在**最前面**（神马超【驭雳】把伤害改成雷电）。
   *
   * 晚一步就全错：藤甲会按已经不存在的火属性 +1，狂风同理，大雾会按「非雷伤」
   * 把一发雷伤防掉，铁索也会按旧属性判断传不传导。
   */
  const outgoing = adjustOutgoingDamage(host.state, sourceId, {
    targetId: target.id,
    amount,
    nature,
    cardId: options.cardId ?? null,
    cardName: options.cardName ?? null,
    chainTransfer: Boolean(options.chainTransfer),
  })
  if (outgoing.appliedSkillIds.length > 0 && (outgoing.nature !== nature || outgoing.amount !== amount)) {
    for (const skillId of outgoing.appliedSkillIds) {
      const skillName = skillDisplayName(host.state, sourceId!, skillId)
      host.dispatch('SkillActivated', {
        skillId, skillName, playerId: sourceId, targetIds: [target.id], result: 'damage-modified',
        logText: `【${skillName}】${target.nickname}受到的这次伤害变为${DAMAGE_NATURE_NAMES[outgoing.nature]}${outgoing.amount} 点`,
      }, { sourceId: sourceId ?? undefined, targetId: target.id, damageNature: outgoing.nature })
    }
  }
  nature = outgoing.nature
  amount = outgoing.amount

  /*
   * 受伤方的数值/属性修正（潘濬【公清】），紧跟在源头修正之后——
   * 藤甲/狂风/大雾这些后续规则仍按这里定下来的最终属性判断。
   */
  const incoming = adjustIncomingDamage(host.state, target.id, {
    targetId: target.id, sourceId, amount, nature,
    cardId: options.cardId ?? null, cardName: options.cardName ?? null, chainTransfer: Boolean(options.chainTransfer),
  })
  if (incoming.appliedSkillIds.length > 0 && (incoming.nature !== nature || incoming.amount !== amount)) {
    for (const skillId of incoming.appliedSkillIds) {
      const skillName = skillDisplayName(host.state, target.id, skillId)
      host.dispatch('SkillActivated', {
        skillId, skillName, playerId: target.id, result: 'damage-modified',
        logText: `【${skillName}】${target.nickname}受到的这次伤害变为${DAMAGE_NATURE_NAMES[incoming.nature]}${incoming.amount} 点`,
      }, { sourceId: sourceId ?? undefined, targetId: target.id, damageNature: incoming.nature })
    }
  }
  nature = incoming.nature
  amount = incoming.amount

  /*
   * 「造成的伤害改为等量失去体力」（张春华【绝情】）。
   *
   * 位置定在这里：**源头方的加成已经算完**（裸衣、驭雳、霆威那些），
   * 而受伤方的防御与加成（藤甲、狂风、大雾、白银狮子）一概不参与——
   * 最终不是伤害，那些修正没有作用对象。这样也不会出现
   * 「先被大雾防止、又再扣一次体力」的双重结算。
   *
   * 换掉之后**立刻返回**：后面的伤害时机、连环传导、濒死都由 `loseHp` 那条路
   * 自己负责，绝不能再走一遍伤害管线。
   */
  const replacedBy = damageReplacedWithHpLoss(host.state, sourceId, {
    targetId: target.id, amount, nature, cardName: options.cardName ?? null,
  })
  if (replacedBy) {
    const skillName = skillDisplayName(host.state, sourceId!, replacedBy)
    host.dispatch('SkillActivated', {
      skillId: replacedBy, skillName, playerId: sourceId, targetIds: [target.id], result: 'damage-to-hp-loss',
      logText: `【${skillName}】${target.nickname}改为失去 ${amount} 点体力`,
    }, { sourceId: sourceId ?? undefined, targetId: target.id })
    /*
     * 走公共的失去体力入口：体力归零照常进濒死。
     * **没有击杀者**——失去体力不是伤害，也就没有伤害来源可言，
     * 因此不触发击杀奖惩。这一条写进了规则文档。
     */
    loseHp(host as never, target.id, amount, replacedBy)
    return
  }
  if (amount <= 0) return

  /*
   * 伤害防止 · 目标侧（徐庶【无言】防止自己受到的锦囊伤害）。
   *
   * 排在【绝情】那条替换**之后**：绝情把伤害整个换成了失去体力，
   * 换完之后已经不存在「一次伤害」，无言也就没有可防的东西——
   * 两个技能各自成立，最终只产生一条结果，不会「防止了却又扣一次血」。
   */
  const preventedByTarget = damagePreventedBy(host.state, target.id, 'target', { ...preventionContext, amount, nature })
  if (preventedByTarget) {
    announceDamagePrevented(host, preventedByTarget, target.id, target.id, nature)
    return
  }

  /*
   * 交互式的目标侧伤害防止询问（杜畿【安东】"来源可以选择防止此伤害"）。
   *
   * 走到这里还没有任何状态被改动，挂起是安全的：技能自己调 `host.askSkill`
   * 发问（问的是来源，不是目标本人），答完后用 `resumeTargetDamagePrevention`
   * 续接，要么就此终止（防止），要么原样重新调用一次 `resolveDamage`。
   */
  if (!options.skipTargetPreventionAsk
    && offerTargetDamagePreventionAsk(host as unknown as SkillHost, target.id, { ...preventionContext, amount, nature })) {
    host.state.pendingTargetDamage = {
      options: { ...options, sourceId, amount, nature, cardId: options.cardId ?? null, cardName: options.cardName ?? null },
    }
    return
  }

  /*
   * 受伤者把这次伤害整个挡下来（【驭雳】防雷伤并摸牌）。
   *
   * 放在扣血和全部伤害时机之前：伤害被防止就是**没有发生**，
   * 狂暴、忍戒、濒死一个都不该被触发。
   */
  const intercepted = interceptIncomingDamage(host as unknown as SkillHost, target.id, {
    sourceId,
    amount,
    nature,
    cardId: options.cardId ?? null,
    cardName: options.cardName ?? null,
    chainTransfer: Boolean(options.chainTransfer),
  })
  if (intercepted) {
    const skillName = skillDisplayName(host.state, target.id, intercepted)
    host.dispatch('SkillActivated', {
      skillId: intercepted, skillName, playerId: target.id, result: 'damage-prevented',
      logText: `【${skillName}】防止了${target.nickname}受到的这次伤害`,
    }, { targetId: target.id, damageNature: nature })
    return
  }

  // 装备的数值修正放在技能时机之前：古锭刀 / 藤甲加成、白银狮子封顶都是牌本身的规则，
  // 技能仍然可以在随后的时机里继续改或者直接取消。
  // 裸衣：本回合【杀】和【决斗】伤害 +1。
  // 必须加在 adjustDamageAmount 之前，白银狮子的封顶才仍然是最后一步。
  if (sourceId && (options.cardName === '杀' || options.cardName === '决斗')) {
    const source = host.state.players.find((player) => player.id === sourceId)
    if (source?.marks.luoyi) amount += 1
  }
  /*
   * 赵忠【隐天】：下一次造成伤害 +1，不看牌名/伤害类型，消耗后清零。
   * 没有通用的"造成伤害时加成"钩子，最小新增一条判定，紧跟裸衣那条同类判定之后。
   */
  if (sourceId) {
    const source = host.state.players.find((player) => player.id === sourceId)
    if (source?.marks.zhaozhongYintianPending) { amount += 1; source.marks.zhaozhongYintianPending = 0 }
  }
  amount = adjustDamageAmount(host.state, sourceId, target.id, amount, nature, options.cardName ?? null)
  /*
   * 临时角色状态的伤害修正（神诸葛亮【狂风】加火伤、【大雾】防非雷伤）。
   *
   * 放在这里而不是各张牌里：杀、决斗、南蛮、万箭、火攻、业炎、连环传导的
   * 二次伤害走的都是这一条管线，挂在这里就自然全都覆盖到，
   * 也不需要给每个状态在牌效果里写一遍特判。
   */
  const stateEffect = applyTargetStateDamage(host.state, target.id, amount, nature)
  if (stateEffect.preventedBy) {
    host.dispatch('SkillActivated', {
      skillId: stateEffect.preventedBy, playerId: target.id, result: 'damage-prevented',
      logText: `【${stateEffect.preventedBy === DAWU_STATE ? '大雾' : stateEffect.preventedBy}】防止了${target.nickname}受到的伤害`,
    }, { targetId: target.id })
    return
  }
  if (stateEffect.amplifiedBy) {
    host.dispatch('SkillActivated', {
      skillId: stateEffect.amplifiedBy, playerId: target.id, result: 'damage-amplified',
      logText: `【${stateEffect.amplifiedBy === KUANGFENG_STATE ? '狂风' : stateEffect.amplifiedBy}】令${target.nickname}受到的火焰伤害 +1`,
    }, { targetId: target.id })
  }
  amount = stateEffect.amount
  if (amount <= 0) return

  const cardId = options.cardId ?? null
  const beforeContext = dispatchDamageTiming(host, 'BeforeDamage', sourceId, target.id, amount, nature, cardId, options.cardName ?? null, options.redirectedBy ?? null)
  if (beforeContext.cancelled) return
  amount = amountAfter(beforeContext)
  if (amount === 0) return

  finalizeDamage(host, target, sourceId, amount, nature, cardId, options.cardName ?? null, options.redirectedBy ?? null, Boolean(options.chainTransfer))
}

/**
 * `BeforeDamage` 之后的收尾：`DamageCaused` / `DamageInflicted` 时机、属性链传导、
 * 真正扣血、`Damaged` / `AfterDamage` 时机、进入濒死。
 *
 * 从 `resolveSingleDamage` 里拆出来，专供**第三方**在 `BeforeDamage` 里先
 * `context.cancel()` 挂起发问、事后又需要**照原样把这次伤害放行**的场景复用
 * （曹冲【仁心】：目标是别人的伤害，防止与否要问曹冲，问不出结果之前不能真的扣血；
 * 玩家选择不防止时，用这个函数原样续上，不重新走一遍 `BeforeDamage` 和前面已经
 * 算好的属性/数值修正，避免那些修正的战报和一次性效果被重复触发）。
 */
export function finalizeDamage(
  host: DamageEngineHost,
  target: PlayerState,
  sourceId: PlayerId | null,
  amount: number,
  nature: DamageNature,
  cardId: CardId | null,
  cardName: string | null,
  redirectedBy: string | null,
  chainTransfer: boolean,
): void {
  for (const timing of ['DamageCaused', 'DamageInflicted'] as const) {
    const context = dispatchDamageTiming(host, timing, sourceId, target.id, amount, nature, cardId, cardName, redirectedBy)
    if (context.cancelled) return
    amount = amountAfter(context)
    if (amount === 0) return
  }

  if (!chainTransfer && nature !== 'normal' && target.chained) {
    const remainingTargetIds = chainedTargetsAfter(host.state, target.id)
    for (const chained of host.state.players.filter((candidate) => candidate.alive && candidate.chained)) {
      setChained(host, chained.id, 'elemental-damage', false)
    }
    if (remainingTargetIds.length > 0) {
      host.state.damageChain = {
        sourceId,
        nature,
        amount,
        cardId,
        cardName,
        redirectedBy,
        remainingTargetIds,
      }
    }
  }

  target.hp -= amount
  /*
   * 「本局是否受到过伤害」记在这里，一次成立终局有效。
   *
   * 只有**真正受到伤害**才算：失去体力（崩坏、无谋）不是伤害，
   * 伤害被防止（大雾、神孙策【冯河】）也走不到这一行。
   * 神郭嘉【天翊】要判断「所有存活角色均受到过伤害」，靠扫战报字符串
   * 既不可靠也扛不住重连，所以落成可序列化的状态位。
   */
  target.hasTakenDamage = true
  /*
   * 按牌记一笔「这次使用造成过伤害」。
   *
   * 记在这里而不是各技能自己挂 `AfterDamage`：多目标的一张牌会派发多次
   * 伤害时机，各自记账很容易变成「伤了两个人就失去两点体力」。
   */
  recordCardDamage(host.state, cardId, amount)
  dispatchDamageTiming(host, 'Damaged', sourceId, target.id, amount, nature, cardId, cardName)
  dispatchDamageTiming(host, 'AfterDamage', sourceId, target.id, amount, nature, cardId, cardName)
  if (target.hp > 0) return

  enterDying(host, target.id, sourceId, nature)
}

/**
 * 进入濒死并开始求桃。
 *
 * 伤害之外也会用到——技能造成的「失去体力」同样可能把人打到 0 体力，
 * 那时候必须走同一条路，不能让技能自己判死。
 */
export function enterDying(host: DamageEngineHost, playerId: PlayerId, sourceId: PlayerId | null = null, nature: DamageNature = 'normal'): void {
  const target = player(host.state, playerId)
  if (!target.alive || target.hp > 0) return
  if (host.state.dying) throw new Error('已有濒死流程正在进行')
  host.state.dying = {
    playerId,
    sourceId,
    damageNature: nature,
    responderOrder: rescueOrder(host.state, playerId),
    responderIndex: 0,
    requestId: null,
  }
  /*
   * 「本局进入过几次濒死」记在这里。
   *
   * 一次完整的濒死流程只算一次，**不管中间问了多少人要桃**——所以记在
   * 濒死真正开始的这一刻，而不是每问一个人记一次。有技能拿它当倍率，
   * 记多了会直接把数值翻倍。
   */
  target.dyingEntryCount = (target.dyingEntryCount ?? 0) + 1
  host.dispatch('EnterDying', { playerId, hp: target.hp }, { sourceId: sourceId ?? undefined, targetId: playerId, damageNature: nature })

  // 濒死介入（周泰【不屈】）：技能有机会在求桃之前直接把这次濒死解决掉。
  // 处理成功就**不进入求桃**——不屈撑住的时候没人需要出桃。
  for (const runtime of skillsOf(host.state, playerId, skillIdsOf)) {
    const result = runtime.dyingIntercept?.(host as unknown as SkillHost, playerId)
    if (result === 'pending') return
    if (!result) continue
    host.dispatch('QuitDying', { playerId, hp: target.hp, reason: runtime.id }, { targetId: playerId })
    host.state.dying = null
    return
  }

  requestCurrentRescuer(host)
}

/**
 * 让某名角色**直接死亡**，不经过濒死求桃。
 *
 * 神关羽【武魂】的判定失败就是这一种：规则说的是「该角色死亡」，
 * 不是「受到足以致死的伤害」——所以既不能伪造一次伤害（那会触发
 * 奸雄、刚烈、天香这些「受到伤害后」的技能，还会被藤甲、大雾挡掉），
 * 也不能走濒死（那会给别人求桃的机会）。
 *
 * 体力先归零再走统一死亡管线，于是行殇、遗计、身份胜负判定这些
 * 「死亡后」的时机全都照常。
 */
export function killPlayer(host: DamageEngineHost, playerId: PlayerId, sourceId: PlayerId | null, reason: string): void {
  const target = host.state.players.find((candidate) => candidate.id === playerId)
  if (!target?.alive) return
  target.hp = Math.min(target.hp, 0)
  host.dispatch('LoseHp', { playerId, amount: 0, reason }, { targetId: playerId })
  resolveDeath(host, playerId, sourceId)
}

export function resolveDamage(host: DamageEngineHost, options: DamageOptions): void {
  resolveSingleDamage(host, options)
  /*
   * 来源侧/目标侧的交互式伤害防止询问都会在这次调用里提前 `return`（现场
   * 存进 `pendingSourceDamage`/`pendingTargetDamage`，答完之后才会真的判定
   * 这次伤害有没有发生）。这时候链式传导还没有真正走完，不能提前续接——
   * 提前续到下一个目标会让还在等回答的这一个目标之后再收到一次错位的
   * 结算，续接改由各自的 `resumeSourceDamagePrevention` / `resumeTargetDamagePrevention` 负责。
   */
  if (!host.state.dying && !host.state.pendingSourceDamage && !host.state.pendingTargetDamage) resumeDamageChain(host)
}

/**
 * 续接一次挂起中的"来源侧是否防止"发问（马谡【制蛮】）。
 *
 * `prevented=true`：就此终止，只播报防止（若给了 `preventedBySkillId`）；
 * `prevented=false`：原样重新调用一次 `resolveDamage`，带上
 * `skipSourcePreventionAsk` 避免同一次伤害被再问一遍。
 */
export function resumeSourceDamagePrevention(
  host: DamageEngineHost,
  prevented: boolean,
  preventedBySkillId?: string,
): void {
  const pending = host.state.pendingSourceDamage
  if (!pending) return
  host.state.pendingSourceDamage = undefined
  const options = pending.options as unknown as DamageOptions
  if (prevented) {
    if (preventedBySkillId) {
      announceDamagePrevented(host, preventedBySkillId, options.sourceId ?? null, options.targetId, options.nature ?? 'normal')
    }
    if (!host.state.dying && !host.state.pendingSourceDamage && !host.state.pendingTargetDamage) resumeDamageChain(host)
    return
  }
  resolveDamage(host, { ...options, skipSourcePreventionAsk: true })
}

/**
 * 续接一次挂起中的"目标侧是否防止"发问（杜畿【安东】）。
 *
 * `prevented=true`：就此终止，只播报防止（若给了 `preventedBySkillId`）；
 * `prevented=false`：原样重新调用一次 `resolveDamage`，带上
 * `skipTargetPreventionAsk` 避免同一次伤害被再问一遍。
 */
export function resumeTargetDamagePrevention(
  host: DamageEngineHost,
  prevented: boolean,
  preventedBySkillId?: string,
): void {
  const pending = host.state.pendingTargetDamage
  if (!pending) return
  host.state.pendingTargetDamage = undefined
  const options = pending.options as unknown as DamageOptions
  if (prevented) {
    if (preventedBySkillId) {
      announceDamagePrevented(host, preventedBySkillId, options.sourceId ?? null, options.targetId, options.nature ?? 'normal')
    }
    if (!host.state.dying && !host.state.pendingSourceDamage && !host.state.pendingTargetDamage) resumeDamageChain(host)
    return
  }
  resolveDamage(host, { ...options, skipTargetPreventionAsk: true })
}

/** 濒死流程结束后继续同一批属性传导；每名目标仍独立经过伤害时机。 */
export function resumeDamageChain(host: DamageEngineHost): void {
  while (host.state.damageChain && !host.state.dying && host.state.status === 'playing') {
    const chain = host.state.damageChain
    const targetId = chain.remainingTargetIds.shift()
    if (!targetId) {
      host.state.damageChain = null
      return
    }
    if (!player(host.state, targetId).alive) continue
    resolveSingleDamage(host, {
      sourceId: chain.sourceId,
      targetId,
      amount: chain.amount,
      nature: chain.nature,
      cardId: chain.cardId,
      cardName: chain.cardName,
      redirectedBy: chain.redirectedBy,
      chainTransfer: true,
    })
  }
}

/** 技能在濒死窗口放弃介入后，继续原有求桃顺序。 */
export function continueDyingRescue(host: DamageEngineHost): void {
  if (!host.state.dying) return
  requestCurrentRescuer(host)
}

export function resolveRescueResponse(host: DamageEngineHost, request: RescueRequest, response: GameResponse): void {
  const dying = host.state.dying
  if (!dying || dying.requestId !== request.id) throw new Error('濒死 Request 已经过期')
  const validationError = validateResponse(request, response)
  if (validationError) throw new Error(validationError)
  const actionId = (response.payload as { actionId: string }).actionId
  removePendingRescue(host.state)
  host.state.decisions.push({
    index: host.state.decisions.length,
    requestId: request.id,
    playerId: response.playerId,
    kind: request.kind,
    payload: structuredClone(response.payload),
  })

  if (actionId === 'rescue-pass') {
    dying.responderIndex += 1
    requestCurrentRescuer(host)
    return
  }

  /*
   * 技能提供的救援动作优先认领（【酒诗】）。
   *
   * 必须放在解析 `rescue-card:` 之前：那段会把 actionId 当成牌 id 去查手牌，
   * 技能动作根本不是牌 id，落到那里必然抛「救援牌不属于响应玩家」。
   */
  for (const runtime of skillsOf(host.state, response.playerId, skillIdsOf)) {
    if (!runtime.invokeRescueAction) continue
    if (!runtime.invokeRescueAction(host as unknown as SkillHost, response.playerId, actionId, dying.playerId)) continue
    requestCurrentRescuer(host)
    return
  }

  const cardId = actionId.slice('rescue-card:'.length)
  const responder = player(host.state, response.playerId)
  if (!request.actionIds.includes(actionId)) throw new Error('救援牌不属于响应玩家')
  /*
   * 这张牌不在响应者手上了：不是响应非法，是这次 Request 的候选列表在
   * 构建之后、真正被回答之前，被另一个排队发问（`queueSkill`，例如杜畿
   * 【安东】问来源"是否防止伤害"）抢先落地并拿走了这张牌——两条独立
   * 流程各自校验时都是合法的，只是撞上了时间差。按弃权处理，而不是让
   * 整局崩掉；这条判断只影响"选中的这张牌恰好没了"这一种情况，
   * 不放宽其它任何校验。
   */
  if (!responder.zones.hand.includes(cardId)) {
    dying.responderIndex += 1
    requestCurrentRescuer(host)
    return
  }
  const card = host.state.cards[cardId]
  const asPeach = guhuoGrantedAs(host.state, responder.id, cardId) === '桃'
    || multiCardGrantedAs(host.state, responder.id, cardId) === '桃'
    || skillsOf(host.state, responder.id, skillIdsOf)
      .flatMap((runtime) => runtime.viewAs?.(host.state, responder.id) ?? [])
      .some((option) => option.asCardName === '桃' && option.cardId === cardId)
  if (!card || (card.name !== '桃' && !asPeach && !(card.name === '酒' && responder.id === dying.playerId))) throw new Error('该牌不能用于当前救援')
  const responseName = asPeach ? '桃' : card.name
  moveCard(host.state, cardId, { kind: 'hand', playerId: responder.id }, { kind: 'processingArea' })
  host.dispatch('CardResponded', { playerId: responder.id, cardId, cardName: responseName }, { sourceId: responder.id, targetId: dying.playerId, cardIds: [cardId] })
  moveCard(host.state, cardId, { kind: 'processingArea' }, { kind: 'discardPile' })
  const target = player(host.state, dying.playerId)
  // 主公技救援：同势力角色的【桃】对主公多回复一点
  const bonus = responseName === '桃' && responder.id !== target.id
    ? skillsOf(host.state, target.id, skillIdsOf)
      .reduce((sum, runtime) => sum + (runtime.rescueRecoverBonus?.(host.state, target.id, responder.id) ?? 0), 0)
    : 0
  recover(host, target.id, 1 + bonus, responder.id)
  requestCurrentRescuer(host)
}
