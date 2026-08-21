import { RULE_SECTIONS } from '../../utils/rules'

const app = getApp()

Page({
  data: {
    navTop: 44,
    menuGap: 100,
    rules: RULE_SECTIONS,
  },

  onLoad() {
    this.setData({ navTop: app.globalData.navTop, menuGap: app.globalData.menuGap })
  },

  goBack() {
    wx.navigateBack()
  },

  // 从任何页面转发都落到首页：存档在本地，直接跳内页对收到的人没意义
  onShareAppMessage() {
    return { title: 'AI 红中麻将 · 和三个 AI 打红中', path: '/pages/index/index' }
  },

})

export {}
