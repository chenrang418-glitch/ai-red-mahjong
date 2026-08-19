import { getReplay } from '../../utils/replay'
import type { ReplayFrame } from '../../utils/replay'
import type { GameState, Tile } from '../../core/types'

const app = getApp()

const SEAT_LABELS: Record<number, string> = { 1: '下家', 2: '对家', 3: '上家' }
// 播放速度：一档比一档快，点一下换下一档
const SPEEDS = [
  { label: '1x', ms: 900 },
  { label: '2x', ms: 450 },
  { label: '4x', ms: 220 },
]

Page({
  data: {
    navTop: 44,
    navHeight: 88,
    menuGap: 100,
    ready: false,
    // 回放才有的上帝视角：把三家的暗牌都翻开
    revealAll: false,
    playing: false,
    speedIndex: 0,
    speedLabel: '1x',
    frameIndex: 0,
    maxIndex: 0,
    round: 1,
    wallCount: 0,
    lastAction: '',
    opponents: [] as Array<Record<string, unknown>>,
    rivers: [] as Array<{ seat: number; who: string; tiles: Tile[] }>,
    myHand: [] as Tile[],
    myMelds: [] as unknown[],
    myName: '你',
    myPoints: '',
  },

  frames: [] as ReplayFrame[],
  playTimer: 0,
  resizeHandler: null as null | (() => void),

  onLoad(query: Record<string, string>) {
    this.syncNav()
    this.resizeHandler = () => this.syncNav()
    wx.onWindowResize(this.resizeHandler)

    const record = query && query.id ? getReplay(query.id) : null
    if (!record || !record.frames.length) {
      wx.showToast({ title: '这场牌谱打不开', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 900)
      return
    }
    this.frames = record.frames
    this.setData({ maxIndex: record.frames.length - 1 })
    this.renderFrame(0)
  },

  onUnload() {
    this.stopPlay()
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

  renderFrame(index: number) {
    const frame = this.frames[index]
    if (!frame) return
    const state = frame.state as GameState
    const me = state.players[0]

    this.setData({
      ready: true,
      frameIndex: index,
      round: state.round,
      wallCount: frame.wallCount,
      lastAction: state.events.length ? state.events[state.events.length - 1].detail : '',
      opponents: [1, 2, 3].map((id) => {
        const player = state.players[id]
        return {
          id,
          name: player.name,
          points: this.pointsText(player.points, player.stats.netPoints),
          handCount: player.hand.length,
          hand: player.hand,
          melds: player.melds,
          isDealer: state.dealer === id,
        }
      }),
      rivers: state.players.map((player, id) => ({
        seat: id,
        who: id === 0 ? '你' : SEAT_LABELS[id],
        tiles: player.discards,
      })),
      myHand: me.hand,
      myMelds: me.melds,
      myName: me.name,
      myPoints: this.pointsText(me.points, me.stats.netPoints),
    })
  },

  pointsText(points: number | null, netPoints: number): string {
    if (points !== null) return `${points}分`
    return `净分 ${netPoints >= 0 ? '+' : ''}${netPoints}`
  },

  toggleReveal() {
    this.setData({ revealAll: !this.data.revealAll })
  },

  stepForward() {
    this.stopPlay()
    this.renderFrame(Math.min(this.data.maxIndex, this.data.frameIndex + 1))
  },

  stepBack() {
    this.stopPlay()
    this.renderFrame(Math.max(0, this.data.frameIndex - 1))
  },

  seekFrame(event: any) {
    this.stopPlay()
    this.renderFrame(Number(event.detail.value))
  },

  togglePlay() {
    if (this.data.playing) return this.stopPlay()
    // 已经在最后一帧就从头放
    if (this.data.frameIndex >= this.data.maxIndex) this.renderFrame(0)
    this.startPlay()
  },

  startPlay() {
    this.stopPlay()
    this.setData({ playing: true })
    const tick = () => {
      const next = this.data.frameIndex + 1
      if (next > this.data.maxIndex) return this.stopPlay()
      this.renderFrame(next)
    }
    this.playTimer = setInterval(tick, SPEEDS[this.data.speedIndex].ms)
  },

  stopPlay() {
    if (this.playTimer) clearInterval(this.playTimer)
    this.playTimer = 0
    if (this.data.playing) this.setData({ playing: false })
  },

  cycleSpeed() {
    const next = (this.data.speedIndex + 1) % SPEEDS.length
    this.setData({ speedIndex: next, speedLabel: SPEEDS[next].label })
    // 正在放就按新速度重开一个计时器
    if (this.data.playing) this.startPlay()
  },

  goBack() {
    wx.navigateBack()
  },
})

export {}
