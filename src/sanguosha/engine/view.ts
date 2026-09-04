import type { CardId, GameResult, Identity, Kingdom, PhysicalCard, PlayerId, SanguoshaState, TurnPhase } from './types'
import type { GameRequest } from './requests'
import type { LegalAction } from './actions'
import { legalPlayActions } from './cards/basic'
import { getAttackRange, getDistance } from './distance'
import { effectiveGenderOf, effectiveKingdomOf } from './huashen'
import { ownedSkillIds } from './skills/runtime'
import { skillDisplayName, skillIdsOf } from '../data/characters/standard'

export interface PlayerPublicView {
  id: PlayerId
  seat: number
  nickname: string
  alive: boolean
  identity: Identity | null
  identityHidden: boolean
  characterId: string | null
  kingdom: Kingdom | null
  gender: 'male' | 'female' | null
  characterSkillsDisabled: boolean
  skills: Array<{ id: string; name: string }>
  huashen: {
    activeCharacterId: string | null
    activeSkillId: string | null
    /** 只在化身拥有者自己的视图中出现。 */
    ownedCharacterIds?: string[]
  } | null
  hp: number
  maxHp: number
  chained: boolean
  faceDown: boolean
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
  damageChain: { nature: 'fire' | 'thunder'; remainingTargetIds: PlayerId[] } | null
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
}

function cards(state: SanguoshaState, ids: readonly CardId[]): PhysicalCard[] {
  return ids.map((id) => state.cards[id]).filter((card): card is PhysicalCard => Boolean(card))
}

export function buildPlayerView(state: SanguoshaState, viewerId: PlayerId): PlayerView {
  if (!state.players.some((player) => player.id === viewerId)) throw new Error('观察者不属于本局')
  const pendingRequest = state.pendingRequests.find((request) => request.playerId === viewerId) ?? null
  const requestCardIds = pendingRequest && 'cardIds' in pendingRequest ? pendingRequest.cardIds : []
  return {
    rulesetVersion: state.rulesetVersion,
    seq: state.seq,
    viewerId,
    status: state.status,
    players: state.players.map((player) => {
      const maySeeIdentity = player.id === viewerId || player.identity === 'lord' || player.identityRevealed || state.status === 'game-over'
      const ownHand = player.id === viewerId ? cards(state, player.zones.hand) : null
      const huashen = state.huashen?.owners[player.id]
      return {
        id: player.id,
        seat: player.seat,
        nickname: player.nickname,
        alive: player.alive,
        identity: maySeeIdentity ? player.identity : null,
        identityHidden: !maySeeIdentity,
        characterId: player.characterId,
        kingdom: effectiveKingdomOf(state, player.id) ?? null,
        gender: effectiveGenderOf(state, player.id) ?? null,
        characterSkillsDisabled: Boolean(player.characterSkillsDisabled),
        skills: ownedSkillIds(state, player.id, skillIdsOf).map((id) => ({ id, name: skillDisplayName(state, player.id, id) })),
        huashen: huashen ? {
          activeCharacterId: player.characterSkillsDisabled ? null : huashen.activeCharacterId,
          activeSkillId: player.characterSkillsDisabled ? null : huashen.activeSkillId,
          ...(player.id === viewerId ? { ownedCharacterIds: [...huashen.characterIds] } : {}),
        } : null,
        hp: player.hp,
        maxHp: player.maxHp,
        chained: player.chained,
        faceDown: player.faceDown,
        characterPiles: Object.fromEntries(
          Object.entries(player.characterPiles ?? {}).map(([pile, ids]) => [
            pile,
            // 扣置的堆对别人裁成空数组：不是「发了再让前端别显示」，是根本不下发
            (player.hiddenCharacterPiles ?? []).includes(pile) && player.id !== viewerId
              ? []
              : cards(state, ids),
          ]),
        ),
        characterPileCounts: Object.fromEntries(
          Object.entries(player.characterPiles ?? {}).map(([pile, ids]) => [pile, ids.length]),
        ),
        // 私有区只发给它的主人，别人拿到 null
        privateCards: player.id === viewerId
          ? Object.fromEntries((state.privateZones ?? [])
            .filter((zone) => zone.ownerId === viewerId)
            .map((zone) => [zone.id, cards(state, zone.cards)]))
          : null,
        handCount: player.zones.hand.length,
        hand: ownHand,
        equipment: cards(state, Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))),
        judgingArea: cards(state, player.zones.judgingArea),
        marks: { ...player.marks },
        distanceFromViewer: player.id !== viewerId && player.alive && state.players.find((candidate) => candidate.id === viewerId)?.alive
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
            : [state.cardResolution.targetId],
          /**
           * 当前正在结算/正在问无懈的那个目标。
           *
           * 多目标锦囊是一个目标一个目标走的，只给 targetIds 的话，
           * 界面和 AI 只能猜「现在是谁」——AI 原来固定读第一个目标，
           * 于是万箭齐发打到第三个人时它按第一个人的敌我关系做判断。
           */
          currentTargetId: state.cardResolution.kind === 'trick'
            ? state.cardResolution.targetIds[state.cardResolution.targetIndex] ?? null
            : state.cardResolution.targetId,
          stage: state.cardResolution.stage,
        }
      : null,
    legalActions: structuredClone(legalPlayActions(state, viewerId)),
    mamaBonds: { ...(state.mamaBonds ?? {}) },
    result: state.result,
  }
}

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}
