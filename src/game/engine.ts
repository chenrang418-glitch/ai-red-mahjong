import { checkWin } from './win'
import {
  countFaces,
  createDeck,
  faceKey,
  isMa,
  nextRandom,
  sameFace,
  shuffleWithState,
  sortTiles,
  tileLabel,
} from './tiles'
import type {
  AIObservation,
  AIProfile,
  ClaimAction,
  ClaimOption,
  GameEvent,
  GameState,
  MatchConfig,
  Meld,
  PlayerState,
  PointTransfer,
  RoundResult,
  Tile,
  WinResult,
} from './types'

const DEFAULT_AI: AIProfile = { difficulty: 'standard' }
const DIFFICULTY_TEXT: Record<AIProfile['difficulty'], string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }
const MAX_RECENT_EVENTS = 50
const MAX_ROUND_TRANSFERS = 24

function emptyStats() {
  return { wins: 0, sevenPairsWins: 0, gangCount: 0, maCount: 0, netPoints: 0 }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class GameEngine {
  state: GameState

  constructor(config: MatchConfig, restoredState?: GameState) {
    if (restoredState) {
      this.state = clone(restoredState)
      return
    }
    if (config.players.length !== 4) throw new Error('必须配置四名玩家')
    const seed = (config.seed ?? Date.now()) >>> 0
    const players: PlayerState[] = config.players.map((setup, id) => ({
      id,
      name: setup.name.trim() || (setup.isHuman ? '玩家' : `AI ${id}`),
      isHuman: setup.isHuman,
      hand: [],
      melds: [],
      discards: [],
      points: config.mode === 'finite' ? Math.max(1, Math.floor(setup.initialPoints)) : null,
      ai: setup.isHuman ? null : clone(setup.ai ?? DEFAULT_AI),
      stats: emptyStats(),
    }))
    this.state = {
      schemaVersion: 1,
      matchId: `match-${Date.now()}-${seed}`,
      config: clone(config),
      phase: 'rolling',
      turnStage: 'must-discard',
      round: 0,
      dealer: 0,
      currentPlayer: 0,
      diceRolls: [],
      players,
      wall: [],
      maReserve: [],
      lastDiscard: null,
      lastDrawn: null,
      claimOptions: [],
      transfers: [],
      events: [],
      result: null,
      seed,
      rngState: seed || 0x6d2b79f5,
    }
    this.addEvent('match-start', '新牌局开始')
    this.rollForDealer()
    this.startRound()
  }

  static restore(state: GameState): GameEngine {
    return new GameEngine(state.config, state)
  }

  snapshot(): GameState {
    return clone(this.state)
  }

  private random(): number {
    const result = nextRandom(this.state.rngState)
    this.state.rngState = result.state
    return result.value
  }

  private randomInt(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1))
  }

  private addEvent(type: GameEvent['type'], detail: string, playerId?: number, tile?: Tile) {
    const at = Date.now()
    this.state.events.push({
      id: `${this.state.matchId}:${this.state.round}:${at}:${type}:${playerId ?? 'system'}:${this.state.events.length}`,
      round: this.state.round,
      type,
      playerId,
      tile: tile ? clone(tile) : undefined,
      detail,
      at,
    })
    if (this.state.events.length > MAX_RECENT_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_RECENT_EVENTS)
    }
  }

  private rollForDealer() {
    let winner = -1
    while (winner < 0) {
      this.state.diceRolls = this.state.players.map((player) => {
        const dice: [number, number] = [this.randomInt(1, 6), this.randomInt(1, 6)]
        return { playerId: player.id, dice, total: dice[0] + dice[1] }
      })
      const highest = Math.max(...this.state.diceRolls.map((roll) => roll.total))
      const leaders = this.state.diceRolls.filter((roll) => roll.total === highest)
      if (leaders.length === 1) winner = leaders[0].playerId
    }
    this.state.dealer = winner
    this.state.currentPlayer = winner
    this.addEvent('dice', `${this.state.players[winner].name}投骰获胜，成为首庄`, winner)
  }

  startRound() {
    if (this.state.phase === 'match-over') throw new Error('整场牌局已经结束')
    this.state.round += 1
    this.state.result = null
    this.state.lastDiscard = null
    this.state.lastDrawn = null
    this.state.claimOptions = []
    this.state.transfers = []
    for (const player of this.state.players) {
      player.hand = []
      player.melds = []
      player.discards = []
    }
    const shuffled = shuffleWithState(createDeck(), this.state.rngState)
    this.state.rngState = shuffled.state
    const deck = shuffled.items
    this.state.maReserve = deck.splice(-6)
    this.state.wall = deck
    for (let pass = 0; pass < 13; pass += 1) {
      for (const player of this.state.players) player.hand.push(this.state.wall.shift()!)
    }
    this.state.players[this.state.dealer].hand.push(this.state.wall.shift()!)
    for (const player of this.state.players) player.hand = sortTiles(player.hand)
    this.state.currentPlayer = this.state.dealer
    this.state.turnStage = 'must-discard'
    this.state.phase = 'playing'
    this.addEvent('round-start', `第${this.state.round}局开始，${this.state.players[this.state.dealer].name}坐庄`, this.state.dealer)
    this.assertTileInvariant()
  }

  updateAI(playerId: number, profile: AIProfile) {
    const player = this.player(playerId)
    if (player.isHuman) throw new Error('真人玩家不能设置AI档位')
    player.ai = clone(profile)
    this.addEvent('ai-change', `${player.name}切换为${DIFFICULTY_TEXT[profile.difficulty]}`, playerId)
  }

  player(playerId: number): PlayerState {
    const player = this.state.players[playerId]
    if (!player) throw new Error(`玩家${playerId}不存在`)
    return player
  }

  winResult(playerId: number): WinResult {
    const player = this.player(playerId)
    return checkWin(player.hand, player.melds)
  }

  anGangFaces(playerId: number): string[] {
    if (this.state.wall.length === 0) return []
    const faces = countFaces(this.player(playerId).hand)
    return [...faces.entries()]
      .filter(([face, count]) => face !== 'zhong' && count === 4)
      .map(([face]) => face)
  }

  buGangFaces(playerId: number): string[] {
    if (this.state.wall.length === 0) return []
    const player = this.player(playerId)
    const handFaces = countFaces(player.hand)
    return player.melds
      .filter((meld) => meld.type === 'peng')
      .map((meld) => faceKey(meld.tiles[0]))
      .filter((face) => face !== 'zhong' && (handFaces.get(face) ?? 0) > 0)
  }

  discard(playerId: number, tileId: string) {
    if (this.state.phase !== 'playing' || this.state.currentPlayer !== playerId) throw new Error('现在不能出牌')
    const player = this.player(playerId)
    const index = player.hand.findIndex((tile) => tile.id === tileId)
    if (index < 0) throw new Error('手牌中没有这张牌')
    const [tile] = player.hand.splice(index, 1)
    player.hand = sortTiles(player.hand)
    player.discards.push(tile)
    this.state.lastDiscard = { playerId, tile }
    this.state.turnStage = 'must-discard'
    this.addEvent('discard', `${player.name}打出${tileLabel(tile)}`, playerId, tile)
    this.state.claimOptions = this.calculateClaimOptions(playerId, tile)
    this.state.phase = 'claiming'
    this.assertTileInvariant()
  }

  private calculateClaimOptions(discarderId: number, tile: Tile): ClaimOption[] {
    if (tile.suit === 'zhong') return []
    const options: ClaimOption[] = []
    for (const player of this.state.players) {
      if (player.id === discarderId) continue
      const count = player.hand.filter((candidate) => sameFace(candidate, tile)).length
      const actions: ClaimAction[] = []
      if (count >= 2) actions.push('peng')
      if (count >= 3 && this.state.wall.length > 0) actions.push('ming-gang')
      if (actions.length > 0) options.push({ playerId: player.id, actions })
    }
    return options
  }

  resolveNoClaim() {
    if (this.state.phase !== 'claiming' || !this.state.lastDiscard) throw new Error('当前没有待处理的弃牌')
    const nextPlayer = (this.state.lastDiscard.playerId + 1) % 4
    this.state.claimOptions = []
    this.state.lastDiscard = null
    this.draw(nextPlayer, false)
  }

  claim(playerId: number, action: ClaimAction) {
    if (this.state.phase !== 'claiming' || !this.state.lastDiscard) throw new Error('当前不能抢牌')
    const option = this.state.claimOptions.find((candidate) => candidate.playerId === playerId)
    if (!option?.actions.includes(action)) throw new Error('该操作不合法')
    const player = this.player(playerId)
    const discarded = this.state.lastDiscard
    const discardPile = this.player(discarded.playerId).discards
    if (discardPile.at(-1)?.id !== discarded.tile.id) throw new Error('弃牌状态不一致')
    discardPile.pop()
    const needed = action === 'peng' ? 2 : 3
    const removed: Tile[] = []
    for (let index = player.hand.length - 1; index >= 0 && removed.length < needed; index -= 1) {
      if (sameFace(player.hand[index], discarded.tile)) removed.push(...player.hand.splice(index, 1))
    }
    if (removed.length !== needed) throw new Error('碰杠牌数量不足')
    const meld: Meld = {
      id: `meld-${this.state.round}-${playerId}-${player.melds.length + 1}`,
      type: action === 'peng' ? 'peng' : 'ming-gang',
      tiles: sortTiles([...removed, discarded.tile]),
      fromPlayer: discarded.playerId,
    }
    player.melds.push(meld)
    this.state.currentPlayer = playerId
    this.state.claimOptions = []
    this.state.lastDiscard = null
    if (action === 'peng') {
      this.state.phase = 'playing'
      this.state.turnStage = 'must-discard'
      this.addEvent('peng', `${player.name}抢先碰${tileLabel(discarded.tile)}`, playerId, discarded.tile)
    } else {
      player.stats.gangCount += 1
      this.addEvent('ming-gang', `${player.name}明杠${tileLabel(discarded.tile)}`, playerId, discarded.tile)
      this.settleGang([discarded.playerId], playerId, 'ming-gang')
      if (!this.matchHasEnded()) this.draw(playerId, true)
    }
    this.assertTileInvariant()
  }

  declareGang(playerId: number, type: 'an-gang' | 'bu-gang', face: string) {
    if (this.state.phase !== 'playing' || this.state.currentPlayer !== playerId) {
      throw new Error('现在不能暗杠或补杠')
    }
    // 暗杠必须摸牌后才能开；补杠只要牌在自己手上就允许，
    // 包括刚碰完还没出牌的时候——否则要白等一圈，中间很可能被别人先胡。
    if (type === 'an-gang' && this.state.turnStage !== 'after-draw') throw new Error('只有摸牌后才能暗杠')
    if (face === 'zhong') throw new Error('红中不能碰或杠')
    const player = this.player(playerId)
    if (type === 'an-gang') {
      if (!this.anGangFaces(playerId).includes(face)) throw new Error('不满足暗杠条件')
      const tiles = player.hand.filter((tile) => faceKey(tile) === face)
      player.hand = player.hand.filter((tile) => faceKey(tile) !== face)
      player.melds.push({ id: `meld-${this.state.round}-${playerId}-${player.melds.length + 1}`, type, tiles })
      this.addEvent('an-gang', `${player.name}暗杠${tileLabel(tiles[0])}`, playerId, tiles[0])
    } else {
      if (!this.buGangFaces(playerId).includes(face)) throw new Error('不满足补杠条件')
      const meld = player.melds.find((candidate) => candidate.type === 'peng' && faceKey(candidate.tiles[0]) === face)!
      const index = player.hand.findIndex((tile) => faceKey(tile) === face)
      const [tile] = player.hand.splice(index, 1)
      meld.type = 'bu-gang'
      meld.tiles.push(tile)
      this.addEvent('bu-gang', `${player.name}补杠${tileLabel(tile)}`, playerId, tile)
    }
    player.hand = sortTiles(player.hand)
    player.stats.gangCount += 1
    this.settleGang(this.state.players.filter((candidate) => candidate.id !== playerId).map((candidate) => candidate.id), playerId, type)
    if (!this.matchHasEnded()) this.draw(playerId, true)
    this.assertTileInvariant()
  }

  private settleGang(payers: number[], winnerId: number, reason: 'an-gang' | 'bu-gang' | 'ming-gang') {
    this.applyTransfers(payers, winnerId, 1, reason)
    if (this.anyBankrupt()) this.finishMatch(`${this.state.players.find((player) => player.points === 0)!.name}因杠分输光`)
  }

  private draw(playerId: number, fromTail: boolean) {
    if (this.state.wall.length === 0) {
      this.finishDraw()
      return
    }
    const tile = fromTail ? this.state.wall.pop()! : this.state.wall.shift()!
    const player = this.player(playerId)
    player.hand.push(tile)
    player.hand = sortTiles(player.hand)
    this.state.currentPlayer = playerId
    this.state.phase = 'playing'
    this.state.turnStage = 'after-draw'
    this.state.lastDrawn = { playerId, tile: clone(tile) }
    const detail = player.isHuman
      ? `${player.name}${fromTail ? '从牌尾补摸到' : '摸到'}${tileLabel(tile)}`
      : `${player.name}${fromTail ? '从牌尾补摸' : '摸牌'}`
    this.addEvent('draw', detail, playerId, tile)
  }

  declareWin(playerId: number) {
    if (
      this.state.phase !== 'playing'
      || this.state.currentPlayer !== playerId
      || this.state.turnStage !== 'after-draw'
    ) throw new Error('本玩法只能摸牌后自摸胡')
    const win = this.winResult(playerId)
    if (!win.won || !win.kind) throw new Error('当前手牌不能胡')
    const winner = this.player(playerId)
    // turnStage 只有摸牌那条路径会置成 after-draw，所以 lastDrawn 一定就是这次自摸的牌。
    // 事件反查只留给升级前就已经存在的老房间（那种状态里没有 lastDrawn）。
    const drawnThisTurn = this.state.lastDrawn?.playerId === playerId ? this.state.lastDrawn.tile : undefined
    const winningTile = drawnThisTurn ?? [...this.state.events]
      .reverse()
      .find((event) => event.round === this.state.round && event.type === 'draw' && event.playerId === playerId && event.tile)
      ?.tile ?? winner.hand.at(-1)
    if (!winningTile) throw new Error('无法确认本次自摸牌')
    const hasRedZhong = winner.hand.some((tile) => tile.suit === 'zhong')
    const drawCount = hasRedZhong ? 4 : 6
    const maTiles = this.state.maReserve.splice(Math.max(0, this.state.maReserve.length - drawCount), drawCount)
    const maCount = maTiles.filter(isMa).length
    const payers = this.state.players.filter((player) => player.id !== playerId).map((player) => player.id)
    this.applyWinTransfers(payers, playerId, maCount)
    winner.stats.wins += 1
    if (win.kind === 'seven-pairs') winner.stats.sevenPairsWins += 1
    winner.stats.maCount += maCount
    this.state.dealer = playerId
    const result: RoundResult = {
      type: 'win',
      winnerId: playerId,
      winKind: win.kind,
      hasRedZhong,
      winningTile: clone(winningTile),
      maTiles: clone(maTiles),
      maCount,
      detail: `${winner.name}${win.kind === 'seven-pairs' ? '七对' : '普通'}自摸${tileLabel(winningTile)}，中${maCount}码`,
    }
    this.state.result = result
    this.addEvent('win', result.detail, playerId)
    if (this.anyBankrupt()) {
      this.state.phase = 'match-over'
      this.addEvent('match-over', '自摸结算后有玩家积分归零，整场结束')
    } else this.state.phase = 'settlement'
    this.assertTileInvariant()
  }

  private applyWinTransfers(payers: number[], winnerId: number, maCount: number) {
    for (const payerId of payers) {
      const payer = this.player(payerId)
      const requested = 1 + maCount
      const paid = this.state.config.mode === 'finite' ? Math.min(payer.points!, requested) : requested
      if (this.state.config.mode === 'finite') {
        payer.points! -= paid
        this.player(winnerId).points! += paid
      }
      payer.stats.netPoints -= paid
      this.player(winnerId).stats.netPoints += paid
      const basePaid = Math.min(1, paid)
      this.pushTransfer(payerId, winnerId, 'self-draw', 1, basePaid)
      if (maCount > 0) this.pushTransfer(payerId, winnerId, 'ma', maCount, Math.max(0, paid - basePaid))
    }
  }

  private applyTransfers(
    payers: number[],
    winnerId: number,
    points: number,
    reason: PointTransfer['reason'],
  ) {
    for (const payerId of payers) {
      const payer = this.player(payerId)
      const paid = this.state.config.mode === 'finite' ? Math.min(payer.points!, points) : points
      if (this.state.config.mode === 'finite') {
        payer.points! -= paid
        this.player(winnerId).points! += paid
      }
      payer.stats.netPoints -= paid
      this.player(winnerId).stats.netPoints += paid
      this.pushTransfer(payerId, winnerId, reason, points, paid)
    }
  }

  private pushTransfer(
    fromPlayer: number,
    toPlayer: number,
    reason: PointTransfer['reason'],
    requested: number,
    paid: number,
  ) {
    this.state.transfers.push({
      id: `transfer-${this.state.round}-${Date.now()}-${fromPlayer}-${toPlayer}-${reason}-${this.state.transfers.length}`,
      round: this.state.round,
      reason,
      fromPlayer,
      toPlayer,
      requested,
      paid,
    })
    if (this.state.transfers.length > MAX_ROUND_TRANSFERS) {
      this.state.transfers.splice(0, this.state.transfers.length - MAX_ROUND_TRANSFERS)
    }
  }

  private anyBankrupt(): boolean {
    return this.state.config.mode === 'finite' && this.state.players.some((player) => player.points === 0)
  }

  private matchHasEnded(): boolean {
    return this.state.phase === 'match-over'
  }

  private finishMatch(detail: string) {
    this.state.phase = 'match-over'
    this.state.claimOptions = []
    this.state.result = { type: 'bankruptcy', maTiles: [], maCount: 0, detail }
    this.addEvent('match-over', detail)
  }

  private finishDraw() {
    this.state.phase = 'settlement'
    this.state.claimOptions = []
    this.state.lastDiscard = null
    this.state.result = { type: 'draw', maTiles: [], maCount: 0, detail: '正常牌墙耗尽，本局流局，杠分保留' }
    this.addEvent('draw-game', this.state.result.detail)
  }

  continueAfterSettlement() {
    if (this.state.phase !== 'settlement') throw new Error('当前不能开始下一局')
    this.startRound()
  }

  endMatchManually() {
    if (this.state.phase === 'setup' || this.state.phase === 'match-over') return
    this.state.phase = 'match-over'
    this.state.claimOptions = []
    this.state.result = { type: 'manual', maTiles: [], maCount: 0, detail: '玩家主动结束整场牌局' }
    this.addEvent('match-over', this.state.result.detail)
  }

  createObservation(playerId: number, legalClaims: ClaimAction[] = []): AIObservation {
    const player = this.player(playerId)
    return {
      playerId,
      hand: clone(player.hand),
      melds: clone(player.melds),
      players: this.state.players.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        handCount: candidate.hand.length,
        melds: clone(candidate.melds),
        discards: clone(candidate.discards),
        points: candidate.points,
        stats: clone(candidate.stats),
      })),
      wallCount: this.state.wall.length,
      maReserveCount: this.state.maReserve.length,
      dealer: this.state.dealer,
      round: this.state.round,
      lastDiscard: clone(this.state.lastDiscard),
      legalDiscards: player.hand.map((tile) => tile.id),
      legalClaims,
      canWin: this.state.turnStage === 'after-draw' && this.winResult(playerId).won,
      anGangFaces: this.state.turnStage === 'after-draw' ? this.anGangFaces(playerId) : [],
      buGangFaces: this.buGangFaces(playerId),
    }
  }

  assertTileInvariant(): true {
    const ids = [
      ...this.state.wall,
      ...this.state.maReserve,
      ...(this.state.result?.maTiles ?? []),
      ...this.state.players.flatMap((player) => [
        ...player.hand,
        ...player.discards,
        ...player.melds.flatMap((meld) => meld.tiles),
      ]),
    ].map((tile) => tile.id)
    if (ids.length !== 112) throw new Error(`牌张守恒失败：当前${ids.length}张，应为112张`)
    if (new Set(ids).size !== 112) throw new Error('牌张守恒失败：出现重复实体牌')
    return true
  }
}
