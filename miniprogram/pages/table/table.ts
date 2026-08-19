import { GameEngine } from '../../core/engine'
import { decideClaim, decideTurn, estimateThinkMs } from '../../core/ai'
import { tileLabel } from '../../core/tiles'
import type { AIProfile, ClaimAction, Difficulty, GameState, Tile } from '../../core/types'
import { audioSettings, prepareMatch, processEvents, setHidden, setSetting, stopMatch } from '../../utils/audio'
import { clearActiveGame, loadActiveGame, saveActiveGame } from '../../utils/persistence'
import { appendActiveFrame, clearActiveReplay, finishActiveReplay } from '../../utils/replay'

const DIFFICULTY_VALUES: Difficulty[] = ['beginner', 'standard', 'expert']

interface MatchSetup {
  mode: 'finite' | 'unlimited'
  initialPoints: number
  claimWindowMs: number
  players: Array<{ name: string; human: boolean; difficulty: Difficulty }>
}

const app = getApp()

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 出牌之后停一下再让下一家动，不然四家会像连珠炮一样刷过去，看不清谁打了什么
function pacing(): number {
  return 260 + Math.floor(Math.random() * 220)
}

// 三家对手在牌桌上的位置：座位 1 是下家，2 是对家，3 是上家
const SEAT_LABELS: Record<number, string> = { 1: '下家', 2: '对家', 3: '上家' }

const CLAIM_LABELS: Record<string, string> = {
  peng: '碰',
  'ming-gang': '杠',
  win: '胡',
}

Page({
  data: {
    ready: false,
    phase: '',
    round: 1,
    wallCount: 0,
    maCount: 0,
    notice: '',
    opponents: [] as Array<Record<string, unknown>>,
    rivers: [] as Array<{ seat: number; who: string; tiles: Tile[] }>,
    myHand: [] as Tile[],
    drawnTile: null as Tile | null,
    myMelds: [] as unknown[],
    myPoints: '',
    myName: '你',
    isMyTurn: false,
    selectedTileId: '',
    selectedLabel: '',
    canWin: false,
    anGangFaces: [] as string[],
    buGangFaces: [] as string[],
    claimActions: [] as Array<{ action: string; label: string }>,
    claimSeconds: 0,
    claimProgress: 100,
    diceOpen: false,
    diceRolls: [] as Array<Record<string, unknown>>,
    dealerName: '',
    aiPanelOpen: false,
    aiSeats: [] as Array<{ id: number; name: string; levelIndex: number }>,
    difficultyLabels: ['菜鸡', '凡人', '猿神'],
    moreOpen: false,
    audioOpen: false,
    audio: audioSettings,
    result: null as null | Record<string, unknown>,
    resultScores: [] as Array<Record<string, unknown>>,
    lastAction: '',
    panelOpen: false,
    panelTab: 'score',
    ranking: [] as Array<Record<string, unknown>>,
    transfers: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
    navTop: 44,
    navHeight: 88,
    menuGap: 100,
  },

  engine: null as GameEngine | null,
  runToken: 0,
  resizeHandler: null as null | (() => void),
  claimTicker: 0,
  diceTimer: 0,

  onLoad(query: Record<string, string>) {
    this.syncNav()
    // 横竖屏一转，胶囊的位置就变了，顶栏得重新让位
    this.resizeHandler = () => this.syncNav()
    wx.onWindowResize(this.resizeHandler)
    // 打牌时别熄屏——想一步的功夫屏幕就黑了很烦
    try {
      wx.setKeepScreenOn({ keepScreenOn: true })
    } catch {
      // 不支持就算了
    }

    if (query && query.resume === '1' && this.resumeMatch()) return

    const setup = app.globalData.pendingSetup
    if (!setup) {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    app.globalData.pendingSetup = null
    this.startMatch(setup as MatchSetup)
  },

  // 从存档接着打。牌局状态是一整份 GameState，交给引擎自己恢复。
  resumeMatch(): boolean {
    const saved = loadActiveGame()
    if (!saved) return false
    try {
      this.engine = GameEngine.restore(saved.state)
    } catch {
      // 存档结构对不上（比如旧版本留下的），别卡在这儿
      clearActiveGame()
      return false
    }
    // 把已有事件标记成放过了，否则一进来会把整局的声音重放一遍
    prepareMatch(saved.state.events)
    this.sync()
    this.runToken += 1
    void this.advance(this.runToken)
    return true
  },

  onShow() {
    setHidden(false)
    // 从声音页回来，开关状态可能改过了
    this.setData({ audio: { ...audioSettings } })
  },

  onHide() {
    // 退到后台不该继续响
    setHidden(true)
  },

  onUnload() {
    // 页面走了就把还在跑的 AI 流程作废，免得它继续往一个已经销毁的页面 setData
    stopMatch()
    try {
      wx.setKeepScreenOn({ keepScreenOn: false })
    } catch {
      // 忽略
    }
    this.runToken += 1
    this.engine = null
    this.clearClaimCountdown()
    if (this.diceTimer) clearTimeout(this.diceTimer)
    if (this.resizeHandler) wx.offWindowResize(this.resizeHandler)
  },

  syncNav() {
    try {
      const menu = wx.getMenuButtonBoundingClientRect()
      const win = wx.getWindowInfo()
      this.setData({
        navTop: menu.top,
        navHeight: menu.bottom + (menu.top - win.statusBarHeight),
        menuGap: win.windowWidth - menu.left + 8,
      })
    } catch {
      this.setData({ navTop: app.globalData.navTop, navHeight: app.globalData.navHeight, menuGap: app.globalData.menuGap })
    }
  },

  startMatch(setup: MatchSetup) {
    const points = setup.mode === 'finite' ? setup.initialPoints : 0
    this.engine = new GameEngine({
      mode: setup.mode,
      claimWindowMs: setup.claimWindowMs,
      players: setup.players.map((player) => ({
        name: player.name,
        isHuman: player.human,
        initialPoints: points,
        ai: player.human ? null : { difficulty: player.difficulty },
      })),
    })
    clearActiveReplay()
    this.engine.startRound()
    prepareMatch()
    this.sync()
    this.showDice()
    this.runToken += 1
    void this.advance(this.runToken)
  },

  // 只有开局那次投骰定首庄，之后是赢家坐庄、流局留庄，引擎也不会再摇。
  // 所以第二局往后弹出来的其实是第一局的旧点数，没意义。
  showDice() {
    const engine = this.engine
    if (!engine) return
    const state = engine.state
    if (state.round !== 1 || !state.diceRolls.length) return
    this.setData({
      diceOpen: true,
      dealerName: state.players[state.dealer].name,
      diceRolls: state.diceRolls.map((roll: { playerId: number; dice: [number, number]; total: number }) => ({
        playerId: roll.playerId,
        name: state.players[roll.playerId].name,
        first: roll.dice[0],
        second: roll.dice[1],
        total: roll.total,
        isDealer: roll.playerId === state.dealer,
      })),
    })
    if (this.diceTimer) clearTimeout(this.diceTimer)
    this.diceTimer = setTimeout(() => this.setData({ diceOpen: false }), 2800)
  },

  closeDice() {
    if (this.diceTimer) clearTimeout(this.diceTimer)
    this.diceTimer = 0
    this.setData({ diceOpen: false })
  },

  openRules() {
    this.setData({ moreOpen: false })
    wx.navigateTo({ url: '/pages/rules/rules' })
  },

  // 对局中随时改 AI 档位：开局选错了不用重开一局
  openAIPanel() {
    const engine = this.engine
    if (!engine) return
    const state = engine.state
    this.setData({
      moreOpen: false,
    audioOpen: false,
      aiPanelOpen: true,
      aiSeats: state.players
        .filter((player: { isHuman: boolean }) => !player.isHuman)
        .map((player: { id: number; name: string; ai: AIProfile | null }) => ({
          id: player.id,
          name: player.name,
          levelIndex: DIFFICULTY_VALUES.indexOf(player.ai?.difficulty ?? 'standard'),
        })),
    })
  },

  closeAIPanel() {
    this.setData({ aiPanelOpen: false })
  },

  changeSeatLevel(event: any) {
    const engine = this.engine
    if (!engine) return
    const index = Number(event.currentTarget.dataset.index)
    const seatId = Number(event.currentTarget.dataset.seat)
    const levelIndex = Number(event.detail.value)
    engine.updateAI(seatId, { difficulty: DIFFICULTY_VALUES[levelIndex] })
    this.setData({ [`aiSeats[${index}].levelIndex`]: levelIndex })
    wx.showToast({ title: `${this.data.aiSeats[index].name} 改为${this.data.difficultyLabels[levelIndex]}`, icon: 'none' })
  },

  // 把引擎状态投影成页面要用的那点数据。整个 GameState 带着牌墙，
  // 直接 setData 又大又没用，这里只挑看得见的部分。
  sync() {
    const engine = this.engine
    if (!engine) return
    const state: GameState = engine.snapshot()
    const me = state.players[0]
    // 这一批新事件对应的声音在这里放，事件 id 记过就不会重复响
    processEvents(state, 0)
    // 每次状态变化都存一份：小程序随时可能被切走或杀掉，没有可靠的「退出前保存」时机
    appendActiveFrame(state.matchId, state)
    if (state.phase === 'match-over') {
      clearActiveGame()
      // 整场打完才归档，中途退出的局不进牌谱
      finishActiveReplay(state.matchId, state)
    } else {
      saveActiveGame(state)
    }

    const opponents = [1, 2, 3].map((id) => {
      const player = state.players[id]
      return {
        id,
        seat: SEAT_LABELS[id],
        name: player.name,
        points: this.pointsText(player.points, player.stats.netPoints),
        handCount: player.hand.length,
        melds: player.melds,
        isCurrent: state.currentPlayer === id,
        isDealer: state.dealer === id,
      }
    })

    const mine = state.claimOptions.find((option) => option.playerId === 0)
    const myTurn = state.phase === 'playing' && state.currentPlayer === 0
    // 刚摸的那张不混进手牌，单独摆到右边——十四张挤在一起根本认不出哪张是新的
    const drawn = this.findDrawnTile(state)
    const hand = drawn ? me.hand.filter((tile) => tile.id !== drawn.id) : me.hand

    this.setData({
      ready: true,
      phase: state.phase,
      round: state.round,
      wallCount: state.wall.length,
      maCount: state.maReserve.length,
      opponents,
      rivers: state.players.map((player, id) => ({
        seat: id,
        who: id === 0 ? '你' : SEAT_LABELS[id],
        tiles: player.discards,
      })),
      myHand: hand,
      drawnTile: drawn,
      myMelds: me.melds,
      myName: me.name,
      myPoints: this.pointsText(me.points, me.stats.netPoints),
      isMyTurn: myTurn,
      selectedTileId: myTurn ? this.data.selectedTileId : '',
      selectedLabel: myTurn ? this.data.selectedLabel : '',
      canWin: myTurn && this.canDeclareWin(),
      anGangFaces: myTurn ? engine.anGangFaces(0) : [],
      buGangFaces: myTurn ? engine.buGangFaces(0) : [],
      claimActions: mine
        ? mine.actions.map((action) => ({ action, label: CLAIM_LABELS[action] ?? action }))
        : [],
      result: state.result as unknown as Record<string, unknown> | null,
      resultScores: state.result ? this.buildRanking(state) : [],
      lastAction: state.events.length ? state.events[state.events.length - 1].detail : '',
      ranking: this.buildRanking(state),
      transfers: this.buildTransfers(state),
      // 记录按倒序看，最新的在最上面；留 40 条够回溯这一局了
      events: [...state.events].reverse().slice(0, 40).map((event: { id: string; round: number; detail: string }) => ({
        id: event.id,
        round: event.round,
        detail: event.detail,
      })),
    })
  },

  findDrawnTile(state: GameState): Tile | null {
    if (state.turnStage !== 'after-draw' || state.currentPlayer !== 0) return null
    const latest = state.events[state.events.length - 1]
    if (!latest || latest.type !== 'draw' || latest.playerId !== 0 || !latest.tile) return null
    return state.players[0].hand.find((tile) => tile.id === latest.tile!.id) ?? null
  },

  buildRanking(state: GameState) {
    return state.players
      .map((player) => ({
        id: player.id,
        name: player.name,
        isHuman: player.isHuman,
        score: player.points === null ? player.stats.netPoints : player.points,
        text: this.pointsText(player.points, player.stats.netPoints),
        wins: player.stats.wins,
        gangCount: player.stats.gangCount,
        maCount: player.stats.maCount,
      }))
      .sort((left, right) => right.score - left.score)
  },

  buildTransfers(state: GameState) {
    const reasons: Record<string, string> = {
      'self-draw': '自摸',
      ma: '抓码',
      'an-gang': '暗杠',
      'bu-gang': '补杠',
      'ming-gang': '明杠',
    }
    return state.transfers
      .filter((transfer) => transfer.round === state.round)
      .slice(-30)
      .reverse()
      .map((transfer) => ({
        id: transfer.id,
        reason: reasons[transfer.reason] ?? transfer.reason,
        from: state.players[transfer.fromPlayer].name,
        to: state.players[transfer.toPlayer].name,
        paid: transfer.paid,
        // 想给却给不出来的那部分要标出来，不然分对不上会以为是算错了
        short: transfer.requested > transfer.paid ? transfer.requested - transfer.paid : 0,
      }))
  },

  openPanel() {
    this.setData({ panelOpen: true })
  },

  closePanel() {
    this.setData({ panelOpen: false })
  },

  switchPanelTab(event: any) {
    this.setData({ panelTab: event.currentTarget.dataset.tab })
  },

  openMore() {
    this.setData({ moreOpen: true })
  },

  closeMore() {
    this.setData({ moreOpen: false })
  },

  openAudio() {
    this.setData({ moreOpen: false, audioOpen: true })
  },

  closeAudio() {
    this.setData({ audioOpen: false })
  },

  toggleAudio(event: any) {
    const key = event.currentTarget.dataset.key as 'effectsEnabled' | 'musicEnabled' | 'vibrateEnabled'
    setSetting(key, !audioSettings[key])
    this.setData({ audio: { ...audioSettings } })
  },

  changeVolume(event: any) {
    const key = event.currentTarget.dataset.key as 'effectsVolume' | 'musicVolume'
    setSetting(key, Number(event.detail.value))
    this.setData({ audio: { ...audioSettings } })
  },

  pointsText(points: number | null, netPoints: number): string {
    if (points !== null) return `${points}分`
    return `净分 ${netPoints >= 0 ? '+' : ''}${netPoints}`
  },

  canDeclareWin(): boolean {
    try {
      return this.engine!.winResult(0).won
    } catch {
      return false
    }
  },

  async advance(token: number) {
    const engine = this.engine
    if (!engine || token !== this.runToken) return
    const state = engine.state

    if (state.phase === 'claiming') return this.runClaimWindow(token)
    if (state.phase !== 'playing') return

    const player = state.players[state.currentPlayer]
    if (player.isHuman) {
      this.setData({
        notice: state.turnStage === 'after-draw' ? '你摸到牌了，可以胡、杠或出牌' : '轮到你出牌',
      })
      return
    }

    this.setData({ notice: `${player.name}正在思考…` })
    // AIProfile 只有档位一个字段，浅拷贝就够；小程序里没有 structuredClone
    const profile: AIProfile = { ...player.ai! }
    await wait(estimateThinkMs(engine.createObservation(player.id), profile, state.events.length))
    if (this.engine !== engine || token !== this.runToken || engine.state.phase !== 'playing') return

    try {
      const decision = decideTurn(engine.createObservation(player.id), profile)
      if (decision.action === 'win') engine.declareWin(player.id)
      else if (decision.action === 'an-gang' || decision.action === 'bu-gang') {
        engine.declareGang(player.id, decision.action, decision.face)
      } else if ('tileId' in decision) engine.discard(player.id, decision.tileId)
      this.sync()
      await wait(pacing())
      await this.advance(token)
    } catch (cause) {
      this.setData({ notice: cause instanceof Error ? cause.message : String(cause) })
    }
  },

  // 有人打出一张牌，其他家可以碰杠胡。AI 自己想，真人这边等他点按钮。
  async runClaimWindow(token: number) {
    const engine = this.engine
    if (!engine || token !== this.runToken) return
    const state = engine.state

    if (!state.claimOptions.length) {
      engine.resolveNoClaim()
      this.sync()
      return this.advance(token)
    }

    this.setData({ notice: '等待各家响应…' })
    this.sync()

    // 倒计时从这一刻起算，而不是等 AI 想完——AI 慢不该占用玩家的反应时间
    const mine = state.claimOptions.some((option: { playerId: number }) => option.playerId === 0)
    if (mine) this.startClaimCountdown(token, Date.now() + state.config.claimWindowMs)

    for (const option of state.claimOptions) {
      if (option.playerId === 0) continue
      const player = state.players[option.playerId]
      const profile: AIProfile = { ...player.ai! }
      const plan = decideClaim(
        engine.createObservation(option.playerId, option.actions),
        profile,
        state.config.claimWindowMs,
      )
      if (plan.action === 'pass') continue
      await wait(plan.delayMs)
      if (this.engine !== engine || token !== this.runToken || engine.state.phase !== 'claiming') return
      engine.claim(option.playerId, plan.action)
      this.sync()
      await wait(pacing())
      return this.advance(token)
    }

    // AI 都不要这张。轮到真人就等他点，没真人的份就直接过。
    if (!mine) {
      this.clearClaimCountdown()
      engine.resolveNoClaim()
      this.sync()
      return this.advance(token)
    }
    this.setData({ notice: '这张牌你可以要' })
  },

  startClaimCountdown(token: number, deadline: number) {
    this.clearClaimCountdown()
    const total = Math.max(1, deadline - Date.now())
    const tick = () => {
      if (token !== this.runToken || !this.engine || this.engine.state.phase !== 'claiming') {
        this.clearClaimCountdown()
        return
      }
      const remaining = Math.max(0, deadline - Date.now())
      const progress = Math.round((remaining / total) * 100)
      // 秒数没变就只更新环，少一次不必要的 setData
      const seconds = Math.ceil(remaining / 1000)
      const patch: Record<string, number> = {}
      if (progress !== this.data.claimProgress) patch.claimProgress = progress
      if (seconds !== this.data.claimSeconds) patch.claimSeconds = seconds
      if (Object.keys(patch).length) this.setData(patch)
      if (remaining > 0) return
      // 时间到了当作过牌，牌局接着走
      this.clearClaimCountdown()
      this.passClaim()
    }
    tick()
    this.claimTicker = setInterval(tick, 60)
  },

  clearClaimCountdown() {
    if (this.claimTicker) clearInterval(this.claimTicker)
    this.claimTicker = 0
    if (this.data.claimSeconds) this.setData({ claimSeconds: 0, claimProgress: 100 })
  },

  selectTile(event: any) {
    if (!this.data.isMyTurn) return
    const tile = event.detail.tile as Tile
    const clear = this.data.selectedTileId === tile.id
    this.setData({
      selectedTileId: clear ? '' : tile.id,
      // 按钮上写明打的是哪张，省得手一抖打错
      selectedLabel: clear ? '' : tileLabel(tile),
    })
  },

  discardSelected() {
    const engine = this.engine
    if (!engine || !this.data.selectedTileId) return
    try {
      engine.discard(0, this.data.selectedTileId)
      this.setData({ selectedTileId: '', selectedLabel: '' })
      this.sync()
      void this.advance(this.runToken)
    } catch (cause) {
      this.toast(cause, '这张打不出去')
    }
  },

  declareWin() {
    const engine = this.engine
    if (!engine) return
    try {
      engine.declareWin(0)
      this.sync()
    } catch (cause) {
      this.toast(cause, '现在还胡不了')
    }
  },

  declareGang(event: any) {
    const engine = this.engine
    if (!engine) return
    const { type, face } = event.currentTarget.dataset
    try {
      engine.declareGang(0, type, face)
      this.sync()
      void this.advance(this.runToken)
    } catch (cause) {
      this.toast(cause, '杠不了')
    }
  },

  claimTile(event: any) {
    const engine = this.engine
    if (!engine) return
    this.clearClaimCountdown()
    const action = event.currentTarget.dataset.action as ClaimAction
    try {
      engine.claim(0, action)
      this.sync()
      void this.advance(this.runToken)
    } catch (cause) {
      this.toast(cause, '抢不了这张')
    }
  },

  passClaim() {
    const engine = this.engine
    if (!engine || engine.state.phase !== 'claiming') return
    this.clearClaimCountdown()
    engine.resolveNoClaim()
    this.sync()
    void this.advance(this.runToken)
  },

  nextRound() {
    const engine = this.engine
    if (!engine) return
    engine.continueAfterSettlement()
    this.sync()
    this.runToken += 1
    void this.advance(this.runToken)
  },

  // 有限积分要分光、无限模式压根不会结束，正常玩到不了 match-over，
  // 光靠「打完整场才归档」的话牌谱永远是空的。所以退出时让人自己选。
  quitMatch() {
    this.setData({ moreOpen: false })
    // 整场已经结束（自然打完或刚点过「结束对局」），没什么可保留的，直接走。
    // 结算弹窗上的「返回首页」也走这里，不该再问一遍。
    const engine = this.engine
    if (!engine || engine.state.phase === 'match-over') {
      wx.redirectTo({ url: '/pages/index/index' })
      return
    }
    wx.showActionSheet({
      itemList: ['保留对局，下次接着打', '结束对局，存进牌谱'],
      success: (result: { tapIndex: number }) => {
        if (result.tapIndex === 0) {
          wx.redirectTo({ url: '/pages/index/index' })
          return
        }
        if (result.tapIndex === 1) this.finishMatch()
      },
      fail: () => {
        // 用户点了取消，什么都不做
      },
    })
  },

  // 主动结束整场：引擎给出最终结算，sync 那边顺势把牌谱归档、存档清掉
  finishMatch() {
    const engine = this.engine
    if (!engine) return wx.redirectTo({ url: '/pages/index/index' })
    this.runToken += 1
    this.clearClaimCountdown()
    engine.endMatchManually()
    this.sync()
  },

  onShareAppMessage() {
    const engine = this.engine
    return {
      title: engine ? `我在打第${engine.state.round}局红中麻将，${this.data.myPoints}` : 'AI 红中麻将',
      path: '/pages/index/index',
    }
  },

  onShareTimeline() {
    return { title: 'AI 红中麻将 · 和三个 AI 打红中' }
  },

  toast(cause: unknown, fallback: string) {
    wx.showToast({
      title: cause instanceof Error ? cause.message : fallback,
      icon: 'none',
    })
  },
})
