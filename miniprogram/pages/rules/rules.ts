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
})

export {}
