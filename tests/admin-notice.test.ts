import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 停服页、公告横幅和维护态按钮的**前端契约**。
 *
 * 这几条守的是「改一处必须改另一处」的耦合点：
 *
 * 1. 公告横幅会占掉一条高度，全站每个「撑满一屏」的容器都必须扣掉它，
 *    少扣一处，那个页面在手机上就会多出一条能滚动的空白——
 *    响应式 e2e 专门守着「不许整页滚动」。
 * 2. `--app-viewport-offset` 的默认值**必须是 0px**：没有公告时所有 calc
 *    的结果要和加这个变量之前完全一样，等于对正常情况零影响。
 * 3. 停服拦截不能把管理页一起拦掉，否则开关打开就关不回去了。
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

const rootCss = read('styles/root.css')
const mainCss = read('styles/main.css')
const portalCss = read('portal/portal.css')
const rootApp = read('RootApp.vue')
const navigation = read('portal/navigation.ts')
const serviceStatus = read('composables/useServiceStatus.ts')
const adminPanel = read('components/AdminPanel.vue')
const mahjongHub = read('components/online/OnlineHub.vue')
const sgsHub = read('sanguosha/components/SgsOnlineHub.vue')

const OFFSET = 'var(--app-viewport-offset, 0px)'

describe('视口偏移变量', () => {
  it('默认必须是 0px——没有公告时布局和加这个变量之前完全一致', () => {
    expect(rootCss).toMatch(/--app-viewport-offset:\s*0px/)
  })

  it('每一个撑满一屏的容器都扣掉了偏移，一个都不能漏', () => {
    const surfaces: Array<[string, string]> = [
      ['门户', portalCss],
      ['麻将全局样式', mainCss],
      ['麻将单机设置', read('components/game/GameSetup.vue')],
      ['麻将模式首页', read('components/ModeHome.vue')],
      ['麻将联机大厅', mahjongHub],
      ['麻将联机房间', read('components/online/OnlineRoom.vue')],
      ['三国杀首页', read('sanguosha/SanguoshaApp.vue')],
      ['三国杀联机大厅', sgsHub],
      ['三国杀牌桌', read('sanguosha/components/SgsTable.vue')],
    ]
    for (const [name, source] of surfaces) {
      expect(source, `${name} 没有扣掉公告横幅的高度`).toContain(OFFSET)
    }
  })

  it('全屏抽屉从横幅下面开始，不会被横幅盖住', () => {
    // 这些是 position: fixed; top: 0 的整屏面板，不跟着文档流走，要单独让开
    expect(read('components/online/OnlineRoom.vue')).toContain(`top: ${OFFSET}`)
    expect(read('sanguosha/components/SgsTable.vue')).toContain(`top:${OFFSET}`)
  })

  it('横幅高度由实测写回，不是写死的常数', () => {
    // 公告在手机上会换行，写死高度就会算错，牌桌底下多出一条空白
    expect(rootApp).toContain('ResizeObserver')
    expect(rootApp).toContain("setProperty('--app-viewport-offset'")
    expect(rootApp).toContain("removeProperty('--app-viewport-offset')")
  })
})

describe('停服页', () => {
  it('停服时整屏只剩提示，没有任何进入游戏的入口', () => {
    expect(rootApp).toContain('site-closed')
    expect(rootApp).toContain('siteClosedMessage')
    // v-if 在最前面：停服分支成立时，门户和游戏组件都不会渲染
    expect(rootApp.indexOf('v-if="siteClosed"')).toBeLessThan(rootApp.indexOf('<GamePortal'))
  })

  it('管理页永远放行——停服开关就是在那里关掉的', () => {
    expect(navigation).toContain('export function isAdminRoute')
    expect(rootApp).toContain('!adminRoute.value')
  })

  it('停服文案有兜底，读不到设置时不会显示成一片空白', () => {
    expect(rootApp).toContain("|| '全站正在维护升级，暂时无法访问，请稍后再来。'")
  })
})

describe('常驻公告横幅', () => {
  it('门户和两款游戏共用 RootApp 里的同一条，不各写一份', () => {
    expect(rootApp).toContain('class="admin-notice"')
    expect(rootCss).toContain('.admin-notice')
    for (const [name, source] of [['麻将大厅', mahjongHub], ['三国杀大厅', sgsHub]] as const) {
      expect(source, `${name} 不该自己再画一条公告横幅`).not.toContain('admin-notice')
    }
  })

  it('公告为空时不渲染横幅', () => {
    expect(rootApp).toContain('v-if="notice"')
    // 空字符串就是「不显示」，不能像提示语那样兜底成默认文案
    expect(serviceStatus).toContain("notice: ''")
  })

  it('停服时不再叠一条公告——那一屏本来就是全红的', () => {
    expect(rootApp).toContain("siteClosed.value ? '' : service.status.value.notice.trim()")
  })
})

describe('维护态在两款游戏里表现一致', () => {
  it('三国杀的创建房间会灰成暗色「维护中」，和麻将一样', () => {
    for (const [name, source] of [['麻将', mahjongHub], ['三国杀', sgsHub]] as const) {
      expect(source, `${name} 没有维护中文案`).toContain("'维护中'")
      expect(source, `${name} 维护时没有禁用按钮`).toMatch(/:disabled="[^"]*maintenance/)
      expect(source, `${name} 维护时按钮没有压暗`).toContain('is-maintenance')
      expect(source, `${name} 没有把维护原因告诉玩家`).toMatch(/maintenance[Mm]essage|maintenance\.value\.message/)
    }
  })

  it('两边读的是同一份服务状态，不会一边说维护一边说正常', () => {
    expect(sgsHub).toContain('useServiceStatus')
    expect(read('composables/useOnlineGame.ts')).toContain('refreshServiceStatus')
  })
})

describe('管理页的控件', () => {
  it('三件事各有各的控件，并且说清楚了轻重', () => {
    expect(adminPanel).toContain('全站维护模式')
    expect(adminPanel).toContain('暂停整个网站')
    expect(adminPanel).toContain('常驻公告')
    expect(adminPanel).toContain('停服提示语')
  })

  it('停服开关开着时有明显的提醒，别忘了关', () => {
    expect(adminPanel).toContain('settings-danger')
    expect(adminPanel).toContain('记得维护完关掉这个开关')
  })

  it('公告有所见即所得的预览', () => {
    expect(adminPanel).toContain('notice-preview')
  })
})
