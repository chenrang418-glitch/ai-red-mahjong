// 花色取值见 core/types.ts 的 Suit：wan / dot / bamboo / zhong
const SUIT_FOLDER: Record<string, string> = { dot: 'bing', bamboo: 'tiao', wan: 'wan' }
const SUIT_TEXT: Record<string, string> = { dot: '筒', bamboo: '条', wan: '万' }

Component({
  properties: {
    tile: { type: Object, value: null },
    // 背面朝上：别人的手牌，或者服务端发来的占位牌
    concealed: { type: Boolean, value: false },
    selected: { type: Boolean, value: false },
    // 刚摸上来的那张，描个金边
    fresh: { type: Boolean, value: false },
    size: { type: String, value: '' },
  },

  data: {
    src: '',
    label: '',
  },

  lifetimes: {
    // observers 只在属性「变化」时触发，组件首次带着初始值挂载并不算变化，
    // 少了这一下，第一手牌会全是空白牌面。
    attached() {
      this.refreshFace()
    },
  },

  observers: {
    'tile, concealed': function () {
      this.refreshFace()
    },
  },

  methods: {
    refreshFace() {
      const tile = this.properties.tile as { suit?: string; rank?: number } | null
      if (!tile || !tile.suit || this.properties.concealed) {
        if (this.data.src || this.data.label) this.setData({ src: '', label: '' })
        return
      }
      const folder = SUIT_FOLDER[tile.suit]
      const src = tile.suit === 'zhong'
        ? '/assets/tiles/zhong.svg'
        : folder ? `/assets/tiles/${folder}-${tile.rank}.svg` : ''
      // 图挂了还有文字兜底，认得出牌面总比一片空白强
      const label = tile.suit === 'zhong' ? '中' : `${tile.rank}${SUIT_TEXT[tile.suit] ?? ''}`
      if (this.data.src !== src || this.data.label !== label) this.setData({ src, label })
    },

    onTap() {
      if (this.properties.concealed) return
      this.triggerEvent('select', { tile: this.properties.tile })
    },
  },
})
