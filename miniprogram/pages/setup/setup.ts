import { audioSettings, setSetting } from '../../utils/audio'
import { clearActiveGame, readActiveSummary } from '../../utils/persistence'

const app = getApp()

const DIFFICULTY_VALUES = ['beginner', 'standard', 'expert'] as const

Page({
  data: {
    navHeight: 88,
    audioOpen: false,
    resume: null as null | Record<string, unknown>,
    audio: audioSettings,
    menuGap: 100,
    difficultyLabels: ['菜鸡', '凡人', '猿神'],
    // 三个 AI 各调各的档位，想打得轻松就配一个猿神两个菜鸡
    players: [
      { name: '你', human: true, levelIndex: 1 },
      { name: 'AI 东', human: false, levelIndex: 1 },
      { name: 'AI 南', human: false, levelIndex: 1 },
      { name: 'AI 西', human: false, levelIndex: 1 },
    ],
    mode: 'finite',
    initialPoints: 30,
    // 默认 4 秒：短了来不及反应，长了每张牌都要干等
    claimWindowIndex: 2,
    claimWindowLabels: ['2秒', '3秒', '4秒（推荐）', '5秒', '6秒', '7秒'],
  },

  onLoad() {
    this.setData({ navHeight: app.globalData.navHeight, menuGap: app.globalData.menuGap })
  },

  // 从牌桌退回来时存档可能变了，每次进页面重新读
  onShow() {
    this.setData({ resume: readActiveSummary() as unknown as Record<string, unknown> | null })
  },

  continueMatch() {
    wx.redirectTo({ url: '/pages/table/table?resume=1' })
  },

  dropMatch() {
    wx.showModal({
      title: '放弃这局',
      content: '存档会删掉，没法再接着打了。',
      confirmText: '删掉',
      cancelText: '留着',
      success: (result: { confirm: boolean }) => {
        if (!result.confirm) return
        clearActiveGame()
        this.setData({ resume: null })
      },
    })
  },

  goBack() {
    wx.navigateBack()
  },

  openAudio() {
    this.setData({ audioOpen: true })
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

  openRules() {
    wx.navigateTo({ url: '/pages/rules/rules' })
  },

  openReplays() {
    wx.navigateTo({ url: '/pages/replay/replay' })
  },

  pickMode(event: any) {
    this.setData({ mode: event.currentTarget.dataset.value })
  },

  changeClaimWindow(event: any) {
    this.setData({ claimWindowIndex: Number(event.detail.value) })
  },

  // 输入过程中不纠正，让人能删空重打；离开输入框时再收进合法范围
  inputPoints(event: any) {
    this.setData({ initialPoints: event.detail.value })
  },

  normalizePoints() {
    const parsed = Math.round(Number(this.data.initialPoints))
    const safe = Number.isFinite(parsed) && parsed > 0 ? Math.min(9999, parsed) : 30
    this.setData({ initialPoints: safe })
  },

  changeName(event: any) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ [`players[${index}].name`]: event.detail.value })
  },

  changeLevel(event: any) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({ [`players[${index}].levelIndex`]: Number(event.detail.value) })
  },

  incPoints() {
    this.setData({ initialPoints: Math.min(9999, Math.round(Number(this.data.initialPoints) || 0) + 10) })
  },

  decPoints() {
    this.setData({ initialPoints: Math.max(1, Math.round(Number(this.data.initialPoints) || 0) - 10) })
  },

  startGame() {
    // 只保留一份存档，开新局会盖掉上次没打完的
    const existing = readActiveSummary()
    if (existing) {
      wx.showModal({
        title: '开新牌局',
        content: `上次第${existing.round}局还没打完，开新局会把它覆盖掉。`,
        confirmText: '开新局',
        cancelText: '取消',
        success: (result: { confirm: boolean }) => {
          if (result.confirm) this.launch()
        },
      })
      return
    }
    this.launch()
  },

  launch() {
    // 通过 globalData 传给牌桌页：配置是个对象，塞 URL 里既难读又有长度限制
    app.globalData.pendingSetup = {
      mode: this.data.mode,
      initialPoints: Math.max(1, Math.round(Number(this.data.initialPoints)) || 30),
      claimWindowMs: (this.data.claimWindowIndex + 2) * 1000,
      players: this.data.players.map((player: { name: string; human: boolean; levelIndex: number }) => ({
        name: player.name.trim() || (player.human ? '你' : 'AI'),
        human: player.human,
        difficulty: DIFFICULTY_VALUES[player.levelIndex],
      })),
    }
    wx.redirectTo({ url: '/pages/table/table' })
  },

  // 从任何页面转发都落到首页：存档在本地，直接跳内页对收到的人没意义
  onShareAppMessage() {
    return { title: 'AI 红中麻将 · 和三个 AI 打红中', path: '/pages/index/index' }
  },

})

export {}
