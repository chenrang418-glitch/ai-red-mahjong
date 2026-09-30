import type { CardId, GameResult, Identity, Kingdom, PhysicalCard, PlayerId, SanguoshaState, TurnPhase } from './types'
import type { GameRequest } from './requests'
import type { LegalAction } from './actions'
import { legalPlayActions } from './cards/basic'
import { getAttackRange, getDistance } from './distance'
import { effectiveGenderOf, effectiveKingdomOf } from './huashen'
import { drawPileTopVisibleCountOf, getSkillRuntime, ownedSkillIds, sharedHandCardSourcesOf } from './skills/runtime'
import { getCharacter, skillDisplayName, skillIdsOf } from '../data/characters/standard'
import { effectiveEquipmentName } from './zones'

export interface PlayerPublicView {
  id: PlayerId
  seat: number
  nickname: string
  alive: boolean
  identity: Identity | null
  identityHidden: boolean
  characterId: string | null
  /** 双将规则视图；暗置武将只向本人公开身份，对其他观察者仅显示暗置槽位。 */
  generalSlots?: Array<{ slot: 'primary' | 'deputy'; characterId: string | null; revealed: boolean }>
  kingdom: Kingdom | null
  gender: 'male' | 'female' | null
  characterSkillsDisabled: boolean
  skills: Array<{ id: string; name: string; description?: string }>
  huashen: {
    activeCharacterId: string | null
    activeSkillId: string | null
    /** 只在化身拥有者自己的视图中出现。 */
    ownedCharacterIds?: string[]
  } | null
  hp: number
  maxHp: number
  armorPoints: number
  chained: boolean
  faceDown: boolean
  /** 已被废除的装备栏（神张辽【夺锐】）。界面要灰掉并标注，不是藏起来。 */
  abolishedSlots: string[]
  /** 判定区是否被胡昭【弥笃】废除。 */
  judgmentAreaAbolished: boolean
  /** 身上带着的全局 Token（神甘宁的「营」）。 */
  tokens: Array<{ name: string; ownerId: string }>
  /**
   * 武将专属牌堆。「创」这类牌是**亮出来**的，所以对所有人公开，
   * 直接下发牌面；将来若出现暗置的专属牌堆，要在这里按观看者裁剪。
   */
  /**
   * 武将专属牌堆。
   *
   * 亮出的堆（周泰「创」、邓艾「田」）对所有人下发牌面；
   * **扣置的堆（神诸葛亮「星」）只给主人下发牌面**，别人这里拿到空数组，
   * 张数看 `characterPileCounts`。
   */
  characterPiles: Record<string, PhysicalCard[]>
  /** 每个专属牌堆的张数。扣置的堆别人也看得到数量，只是看不到是哪些牌。 */
  characterPileCounts: Record<string, number>
  handCount: number
  hand: PhysicalCard[] | null
  /** 明置手牌（对其他旁观者公开；拥有者已能看到自己的完整手牌）。 */
  faceUpHand: PhysicalCard[]
  /** 仅借牌角色可见、可交互的【好施】共享手牌。 */
  sharedHands: Array<{ ownerId: PlayerId; nickname: string; cards: PhysicalCard[] }>
  equipment: Array<PhysicalCard>
  judgingArea: Array<PhysicalCard>
  marks: Record<string, number>
  /**
   * 只属于观察者自己的私有暂存牌（于吉扣置的蛊惑牌）。
   *
   * **别人的私有区连键都不会出现在这个视图里**——不是「标个 hidden 再照发」，
   * 是根本不下发。
   */
  privateCards: Record<string, PhysicalCard[]> | null
  /** 从当前观察者到该角色的实际距离；自己或阵亡角色为 null。 */
  distanceFromViewer: number | null
  /** 公开的攻击范围，供座位卡展示；数值仍由 Engine 统一计算。 */
  attackRange: number
}

export interface PlayerView {
  rulesetVersion: string
  seq: number
  viewerId: PlayerId
  /** 旁观视角不属于任何座位，永远不含私有牌或可执行操作。 */
  spectator?: boolean
  status: string
  players: PlayerPublicView[]
  drawPileCount: number
  discardPile: PhysicalCard[]
  processingArea: PhysicalCard[]
  currentPlayerId: PlayerId
  turnNumber: number
  phase: TurnPhase
  pendingRequest: GameRequest | null
  /** 仅当前请求玩家可见的牌面，例如观星看到的牌堆顶；不会发送给其他玩家。 */
  requestCards: PhysicalCard[]
  dying: { playerId: PlayerId; requiredRecover: number } | null
  damageChain: { nature: 'fire' | 'thunder' | 'ice'; remainingTargetIds: PlayerId[] } | null
  judgment: { playerId: PlayerId; delayedCard: PhysicalCard; stage: 'awaiting-nullification' | 'awaiting-damage' } | null
  cardResolution: {
    kind: 'slash' | 'trick'
    card: PhysicalCard
    sourceId: PlayerId
    /** 多目标锦囊会有多个；杀这类单目标牌也包成一个元素，客户端只处理一种形状 */
    targetIds: PlayerId[]
    /** 正在结算的那个目标。多目标锦囊逐个走，判断敌我关系要看这个而不是 targetIds[0]。 */
    currentTargetId: PlayerId | null
    stage: 'awaiting-dodge' | 'awaiting-intercept' | 'awaiting-dying' | 'awaiting-nullification' | 'awaiting-effect'
  } | null
  legalActions: LegalAction[]
  /**
   * 牛来【麻麻】的认亲关系（牛来 id → 麻麻 id）。
   *
   * 公开信息：规则要求所有人都知道谁是谁的麻麻，所以整份原样下发，
   * 不按观察者裁剪。没有牛来时是空对象。
   */
  mamaBonds: Record<PlayerId, PlayerId>
  result: GameResult | null
  /** 只属于观察者自己的牌堆顶持续可见窗口（晋司马懿【鹰视】），别人这里永远是空数组。 */
  drawPileTop: PhysicalCard[]
}

function cards(state: SanguoshaState, ids: readonly CardId[]): PhysicalCard[] {
  return ids.map((id) => {
    const card = state.cards[id]
    if (!card) return null
    const transformed = state.equipmentTransformations?.[id]
    return transformed ? { ...card, name: effectiveEquipmentName(state, id) } : card
  }).filter((card): card is PhysicalCard => Boolean(card))
}

function buildView(state: SanguoshaState, viewerId: PlayerId, spectator: boolean): PlayerView {
  const pendingRequest = spectator ? null : state.pendingRequests.find((request) => request.playerId === viewerId) ?? null
  /*
   * 请求里引用到的牌面。
   *
   * 除了可选的 `cardIds`，还要带上「只看不可选」的那部分——
   * 神吕蒙【攻心】要看整副手牌，但只有红桃能被选中。漏掉它，
   * 客户端就拿不到那些牌的牌面，只能画一堆牌背。
   */
  const requestCardIds = pendingRequest
    ? [
      ...('cardIds' in pendingRequest ? pendingRequest.cardIds : []),
      ...('viewOnlyCardIds' in pendingRequest ? pendingRequest.viewOnlyCardIds ?? [] : []),
    ]
    : []
  const hiddenHandOwners = new Set(pendingRequest?.kind === 'choose-cards'
    ? pendingRequest.hiddenCardSlots.map((slot) => slot.split(':')[1]).filter((id): id is string => Boolean(id))
    : [])
  return {
    rulesetVersion: state.rulesetVersion,
    seq: state.seq,
    viewerId,
    ...(spectator ? { spectator: true } : {}),
    status: state.status,
    players: state.players.map((player) => {
      const maySeeIdentity = (!spectator && player.id === viewerId) || player.identity === 'lord' || player.identityRevealed || state.status === 'game-over'
      const privatelyRevealed = !spectator && (state.privateRevealedHands?.[viewerId] ?? []).includes(player.id)
      const ownHand = (!spectator && player.id === viewerId) || (state.revealedHands ?? []).includes(player.id) || privatelyRevealed
        ? cards(state, player.zones.hand)
        : null
      const huashen = state.huashen?.owners[player.id]
      const ownsPlayer = !spectator && player.id === viewerId
      const primaryRevealed = player.primaryGeneralRevealed !== false
      const deputyRevealed = player.deputyGeneralRevealed === true
      const maySeePrimary = ownsPlayer || primaryRevealed || state.status === 'game-over'
      const maySeeDeputy = ownsPlayer || deputyRevealed || state.status === 'game-over'
      const visibleDeputy = player.deputyCharacterId && (deputyRevealed || state.status === 'game-over')
        ? getCharacter(player.deputyCharacterId) : undefined
      return {
        id: player.id,
        seat: player.seat,
        nickname: player.nickname,
        alive: player.alive,
        identity: maySeeIdentity ? player.identity : null,
        identityHidden: !maySeeIdentity,
        characterId: maySeePrimary ? player.characterId : null,
        generalSlots: [
          ...(player.characterId ? [{ slot: 'primary' as const, characterId: maySeePrimary ? player.characterId : null, revealed: primaryRevealed }] : []),
          ...(player.deputyCharacterId ? [{ slot: 'deputy' as const, characterId: maySeeDeputy ? player.deputyCharacterId : null, revealed: deputyRevealed }] : []),
        ],
        kingdom: primaryRevealed || ownsPlayer || state.status === 'game-over'
          ? effectiveKingdomOf(state, player.id) ?? null
          : visibleDeputy?.kingdom ?? null,
        gender: primaryRevealed || ownsPlayer || state.status === 'game-over'
          ? effectiveGenderOf(state, player.id) ?? null
          : visibleDeputy?.gender ?? null,
        characterSkillsDisabled: Boolean(player.characterSkillsDisabled),
        skills: ownedSkillIds(state, player.id, skillIdsOf).map((id) => {
          const description = getSkillRuntime(id)?.descriptionForView?.(state, player.id)
          return {
            id,
            name: skillDisplayName(state, player.id, id),
            ...(description ? { description } : {}),
          }
        }),
        huashen: huashen ? {
          activeCharacterId: player.characterSkillsDisabled ? null : huashen.activeCharacterId,
          activeSkillId: player.characterSkillsDisabled ? null : huashen.activeSkillId,
          ...(!spectator && player.id === viewerId ? { ownedCharacterIds: [...huashen.characterIds] } : {}),
        } : null,
        hp: player.hp,
        maxHp: player.maxHp,
        armorPoints: player.armorPoints ?? 0,
        chained: player.chained,
        faceDown: player.faceDown,
        abolishedSlots: [...(state.abolishedSlots?.[player.id] ?? [])],
        judgmentAreaAbolished: state.abolishedJudgmentAreas?.includes(player.id) ?? false,
        tokens: (state.globalTokens ?? []).filter((token) => token.carrierId === player.id)
          .map((token) => ({ name: token.name, ownerId: token.ownerId })),
        characterPiles: Object.fromEntries(
          Object.entries(player.characterPiles ?? {}).map(([pile, ids]) => [
            pile,
            // 扣置的堆对别人裁成空数组：不是「发了再让前端别显示」，是根本不下发
            (player.hiddenCharacterPiles ?? []).includes(pile) && (spectator || player.id !== viewerId)
              ? []
              : cards(state, ids),
          ]),
        ),
        characterPileCounts: Object.fromEntries(
          Object.entries(player.characterPiles ?? {}).map(([pile, ids]) => [pile, ids.length]),
        ),
        // 私有区只发给它的主人，别人拿到 null
        privateCards: !spectator && player.id === viewerId
          ? Object.fromEntries((state.privateZones ?? [])
            .filter((zone) => zone.ownerId === viewerId)
            .map((zone) => [zone.id, cards(state, zone.cards)]))
          : null,
        handCount: player.zones.hand.length,
        hand: ownHand,
        faceUpHand: !spectator && player.id === viewerId || hiddenHandOwners.has(player.id)
          ? []
          : cards(state, (state.faceUpHandCards?.[player.id] ?? []).filter((cardId) => player.zones.hand.includes(cardId))),
        sharedHands: !spectator && player.id === viewerId
          ? sharedHandCardSourcesOf(state, viewerId).map((source) => ({
            ownerId: source.ownerId,
            nickname: state.players.find((candidate) => candidate.id === source.ownerId)?.nickname ?? '其他角色',
            cards: cards(state, source.cardIds),
          }))
          : [],
        equipment: cards(state, Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))),
        judgingArea: cards(state, player.zones.judgingArea),
        marks: { ...player.marks },
        distanceFromViewer: !spectator && player.id !== viewerId && player.alive && state.players.find((candidate) => candidate.id === viewerId)?.alive
          ? getDistance(state, viewerId, player.id)
          : null,
        attackRange: player.alive ? getAttackRange(state, player.id) : 0,
      }
    }),
    drawPileCount: state.zones.drawPile.length,
    discardPile: cards(state, state.zones.discardPile),
    processingArea: cards(state, state.zones.processingArea),
    currentPlayerId: state.currentPlayerId,
    turnNumber: state.turnNumber,
    phase: state.phase,
    pendingRequest: structuredClone(pendingRequest),
    requestCards: cards(state, requestCardIds),
    dying: state.dying
      ? { playerId: state.dying.playerId, requiredRecover: 1 - player(state, state.dying.playerId).hp }
      : null,
    damageChain: state.damageChain
      ? { nature: state.damageChain.nature, remainingTargetIds: [...state.damageChain.remainingTargetIds] }
      : null,
    judgment: state.judgment
      ? { playerId: state.judgment.playerId, delayedCard: state.cards[state.judgment.delayedCardId], stage: state.judgment.stage }
      : null,
    // 多目标锦囊统一按 targetIds 下发；单目标（杀）也包成一个元素，客户端只有一种形状要处理
    cardResolution: state.cardResolution
      ? {
          kind: state.cardResolution.kind,
          card: state.cards[state.cardResolution.cardId],
          sourceId: state.cardResolution.sourceId,
          targetIds: state.cardResolution.kind === 'trick'
            ? [...state.cardResolution.targetIds]
            : !state.cardResolution.privateTargets || viewerId === state.cardResolution.sourceId
              || viewerId === state.cardResolution.targetId ? [state.cardResolution.targetId] : [],
          /**
           * 当前正在结算/正在问无懈的那个目标。
           *
           * 多目标锦囊是一个目标一个目标走的，只给 targetIds 的话，
           * 界面和 AI 只能猜「现在是谁」——AI 原来固定读第一个目标，
           * 于是万箭齐发打到第三个人时它按第一个人的敌我关系做判断。
           */
          currentTargetId: state.cardResolution.kind === 'trick'
            ? state.cardResolution.targetIds[state.cardResolution.targetIndex] ?? null
            : !state.cardResolution.privateTargets || viewerId === state.cardResolution.sourceId
              || viewerId === state.cardResolution.targetId ? state.cardResolution.targetId : null,
          stage: state.cardResolution.stage,
        }
      : null,
    legalActions: spectator ? [] : structuredClone(legalPlayActions(state, viewerId)),
    mamaBonds: { ...(state.mamaBonds ?? {}) },
    result: state.result,
    // 晋司马懿【鹰视】：只在 viewerId === 技能拥有者时非空，绝不广播给其他客户端
    drawPileTop: spectator ? [] : cards(state, state.zones.drawPile.slice(0, drawPileTopVisibleCountOf(state, viewerId))),
  }
}

export function buildPlayerView(state: SanguoshaState, viewerId: PlayerId): PlayerView {
  if (!state.players.some((player) => player.id === viewerId)) throw new Error('观察者不属于本局')
  return buildView(state, viewerId, false)
}

/**
 * 严格旁观视角：只包含公开场面，不借用任何在座玩家身份。
 * 固定 viewerId 只为满足协议字段，不会参与距离、请求或合法动作计算。
 */
export function buildSpectatorView(state: SanguoshaState): PlayerView {
  return buildView(state, '__spectator__', true)
}

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}
