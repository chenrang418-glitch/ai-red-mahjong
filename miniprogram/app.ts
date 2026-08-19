import './utils/polyfill'

App({
  globalData: {
    // 单机设置页选完之后交给牌桌页，避免塞进 URL 参数
    pendingSetup: null as null | Record<string, unknown>,
    // 自定义导航栏要自己避开状态栏和右上角胶囊，这两个数一次算好给所有页面用
    navTop: 44,
    navHeight: 88,
    menuGap: 100,
  },

  onLaunch() {
    try {
      const menu = wx.getMenuButtonBoundingClientRect()
      const window = wx.getWindowInfo()
      this.globalData.navTop = menu.top
      // 顶栏内容和胶囊上下对齐，高度取胶囊底部再留一点余量
      this.globalData.navHeight = menu.bottom + (menu.top - window.statusBarHeight)
      // 胶囊右边缘到屏幕右侧的距离，顶栏右侧要留出这么宽，不然会被压住
      this.globalData.menuGap = window.windowWidth - menu.left + 8
    } catch {
      // 取不到就用默认值，顶栏挤一点但不会崩
    }
  },
})
