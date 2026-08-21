import { deleteReplay, exportReplay, importReplay, listReplays } from '../../utils/replay'

const app = getApp()

function formatDate(stamp: number): string {
  const date = new Date(stamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

Page({
  data: {
    navTop: 44,
    menuGap: 100,
    replays: [] as Array<Record<string, unknown>>,
  },

  onLoad() {
    this.setData({ navTop: app.globalData.navTop, menuGap: app.globalData.menuGap })
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({
      replays: listReplays().map((item) => ({ ...item, dateText: formatDate(item.completedAt) })),
    })
  },

  goBack() {
    wx.navigateBack()
  },

  openReplay(event: any) {
    wx.navigateTo({ url: `/pages/replay-view/replay-view?id=${event.currentTarget.dataset.id}` })
  },

  // 小程序存不了本地文件，导出就是把牌谱塞进剪贴板，贴到聊天里就能发给别人
  exportOne(event: any) {
    const text = exportReplay(event.currentTarget.dataset.id as string)
    if (!text) return wx.showToast({ title: '这场牌谱丢了', icon: 'none' })
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，粘贴给朋友即可', icon: 'none' }),
    })
  },

  importFromClipboard() {
    wx.getClipboardData({
      success: (result: { data: string }) => {
        const outcome = importReplay(result.data || '')
        wx.showToast({ title: outcome.message, icon: 'none' })
        if (outcome.ok) this.refresh()
      },
    })
  },

  removeOne(event: any) {
    const { id, title } = event.currentTarget.dataset
    wx.showModal({
      title: '删除牌谱',
      content: `「${title}」删了就找不回来了。`,
      confirmText: '删除',
      cancelText: '留着',
      success: (result: { confirm: boolean }) => {
        if (!result.confirm) return
        deleteReplay(id as string)
        this.refresh()
      },
    })
  },

  // 从任何页面转发都落到首页：存档在本地，直接跳内页对收到的人没意义
  onShareAppMessage() {
    return { title: 'AI 红中麻将 · 和三个 AI 打红中', path: '/pages/index/index' }
  },

})

export {}
