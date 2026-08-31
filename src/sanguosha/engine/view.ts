import type { CardId, GameResult, Identity, PhysicalCard, PlayerId, SanguoshaState, TurnPhase } from './types'
import type { GameRequest } from './requests'
import type { LegalAction } from './actions'
import { legalPlayActions } from './cards/basic'

export interface PlayerPublicView {
  id: PlayerId
  seat: number
  nickname: string
  alive: boolean
  identity: Identity | null
  identityHidden: boolean
  characterId: string | null
  hp: number
  maxHp: number
  chained: boolean
  faceDown: boolean
  handCount: number
  hand: PhysicalCard[] | null
  equipment: Array<PhysicalCard>
  judgingArea: Array<PhysicalCard>
  marks: Record<string, number>
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
  dying: { playerId: PlayerId; requiredRecover: number } | null
  damageChain: { nature: 'fire' | 'thunder'; remainingTargetIds: PlayerId[] } | null
  judgment: { playerId: PlayerId; delayedCard: PhysicalCard; stage: 'awaiting-nullification' | 'awaiting-damage' } | null
  cardResolution: {
    kind: 'slash' | 'trick'
    card: PhysicalCard
    sourceId: PlayerId
    /** 多目标锦囊会有多个；杀这类单目标牌也包成一个元素，客户端只处理一种形状 */
    targetIds: PlayerId[]
    stage: 'awaiting-dodge' | 'awaiting-dying' | 'awaiting-nullification' | 'awaiting-effect'
  } | null
  legalActions: LegalAction[]
  result: GameResult | null
}

function cards(state: SanguoshaState, ids: readonly CardId[]): PhysicalCard[] {
  return ids.map((id) => state.cards[id]).filter((card): card is PhysicalCard => Boolean(card))
}

export function buildPlayerView(state: SanguoshaState, viewerId: PlayerId): PlayerView {
  if (!state.players.some((player) => player.id === viewerId)) throw new Error('观察者不属于本局')
  return {
    rulesetVersion: state.rulesetVersion,
    seq: state.seq,
    viewerId,
    status: state.status,
    players: state.players.map((player) => {
      const maySeeIdentity = player.id === viewerId || player.identity === 'lord' || player.identityRevealed || state.status === 'game-over'
      const ownHand = player.id === viewerId ? cards(state, player.zones.hand) : null
      return {
        id: player.id,
        seat: player.seat,
        nickname: player.nickname,
        alive: player.alive,
        identity: maySeeIdentity ? player.identity : null,
        identityHidden: !maySeeIdentity,
        characterId: player.characterId,
        hp: player.hp,
        maxHp: player.maxHp,
        chained: player.chained,
        faceDown: player.faceDown,
        handCount: player.zones.hand.length,
        hand: ownHand,
        equipment: cards(state, Object.values(player.zones.equipment).filter((id): id is CardId => Boolean(id))),
        judgingArea: cards(state, player.zones.judgingArea),
        marks: { ...player.marks },
      }
    }),
    drawPileCount: state.zones.drawPile.length,
    discardPile: cards(state, state.zones.discardPile),
    processingArea: cards(state, state.zones.processingArea),
    currentPlayerId: state.currentPlayerId,
    turnNumber: state.turnNumber,
    phase: state.phase,
    pendingRequest: structuredClone(state.pendingRequests.find((request) => request.playerId === viewerId) ?? null),
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
          stage: state.cardResolution.stage,
        }
      : null,
    legalActions: structuredClone(legalPlayActions(state, viewerId)),
    result: state.result,
  }
}

function player(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}
