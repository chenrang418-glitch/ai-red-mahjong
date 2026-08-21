const app = getApp()

Page({
  data: {
    navHeight: 88,
  },

  onLoad() {
    this.setData({ navHeight: app.globalData.navHeight })
  },

  onShareAppMessage() {
    return { title: 'AI 红中麻将 · 和三个 AI 打红中', path: '/pages/index/index' }
  },

  startSingle() {
    wx.navigateTo({ url: '/pages/setup/setup' })
  },

  openReplay() {
    wx.navigateTo({ url: '/pages/replay/replay' })
  },
})

export {}
