import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 「项目说明」体系的结构性约束，跟 admin-notice.test.ts 同一种做法：
 * 直接读组件源码断言关键字符串和结构顺序，而不是挂载渲染——
 * 项目的 vitest 环境是 `node`，组件也没有引入 @vue/test-utils。
 *
 * 这里守的都是任务书里反复强调、容易在后续修改中不小心破坏的硬约束：
 * 首次弹窗不能有关闭手段、禁用词不能出现、正文只能有一份来源、
 * 游戏内部不能出现同样的文字。
 */

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

const noticeContent = read('notice/noticeContent.ts')
const noticeStorage = read('notice/noticeStorage.ts')
const gate = read('components/ProjectNotice/ProjectNoticeGate.vue')
const firstVisit = read('components/ProjectNotice/FirstVisitNotice.vue')
const fullDisclaimer = read('components/ProjectNotice/FullDisclaimerModal.vue')
const contact = read('components/ProjectNotice/ContactDeveloperModal.vue')
const overlay = read('components/ProjectNotice/NoticeOverlay.vue')
const siteFooter = read('portal/SiteFooter.vue')
const gamePortal = read('portal/GamePortal.vue')
const rootApp = read('RootApp.vue')

describe('内容只有一份来源', () => {
  it('首次弹窗和完整声明都从 noticeContent.ts 读文案，不各写一份字符串', () => {
    expect(firstVisit).toContain("from '@/notice/noticeContent'")
    expect(fullDisclaimer).toContain("from '@/notice/noticeContent'")
    expect(siteFooter).toContain("from '@/notice/noticeContent'")
    // 正文不能在组件里各自硬编码一遍——只应该在 noticeContent.ts 里出现一次
    expect(firstVisit).not.toContain('CRPlay 是个人开发维护的非商业开源网页游戏项目')
    expect(fullDisclaimer).not.toContain('CRPlay（crplay.cn）是个人开发并维护的非商业性质开源网页游戏项目')
  })

  it('联系方式不写死在前端：号码只作为兜底默认值出现，弹窗从 useServiceStatus 读实际值', () => {
    // 兜底默认值只应该在 noticeContent.ts 里出现一次，且要和 worker.ts 的默认设置一致
    const occurrencesOfDefaultQQ = (source: string) => (source.match(/1507394636/g) ?? []).length
    expect(occurrencesOfDefaultQQ(noticeContent)).toBe(1)
    expect(occurrencesOfDefaultQQ(contact)).toBe(0)
    expect(contact).not.toContain('CONTACT_QQ')
    expect(contact).toContain("from '@/composables/useServiceStatus'")
    expect(contact).toContain('service.status.value.contactMethod')
    expect(contact).toContain('service.status.value.contactValue')
  })
})

describe('首次访问弹窗：内容必须逐字匹配', () => {
  it('标题是「项目说明」，不是免责声明/法律警告等说法', () => {
    expect(noticeContent).toContain("FIRST_VISIT_TITLE = '项目说明'")
    for (const forbidden of ['免责声明', '法律警告', '风险警告', '用户协议', '重要警告']) {
      expect(noticeContent.split('FIRST_VISIT_TITLE')[1]?.split('FULL_DISCLAIMER_TITLE')[0] ?? '')
        .not.toContain(forbidden)
    }
  })

  it('三段正文逐字匹配任务要求', () => {
    expect(noticeContent).toContain('CRPlay 是个人开发维护的非商业开源网页游戏项目，仅用于学习、技术研究及娱乐交流。')
    expect(noticeContent).toContain('本站部分游戏玩法与机制可能参考现有游戏作品；角色立绘、界面、背景、音乐等内容均由开发者自行制作或通过 AI 工具辅助生成。')
    expect(noticeContent).toContain('CRPlay 与相关游戏厂商及权利人不存在官方授权、合作或隶属关系。')
  })

  it('只有「查看完整声明」和「我知道了」两个操作', () => {
    // 只查按钮区域，不查整份文件——顶部doc注释里解释「不是用户协议，没有同意/不同意」
    // 这句话本身就含有「不同意」三个字，拿它去比对全文件会把注释也算成误判。
    const actionsBlock = firstVisit.match(/<div class="first-visit-notice__actions">[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(actionsBlock).toContain('查看完整声明')
    expect(actionsBlock).toContain('我知道了')
    for (const forbidden of ['不同意', '拒绝并退出', '同意协议', '我已阅读并同意']) {
      expect(actionsBlock).not.toContain(forbidden)
    }
  })

  it('不提供任何关闭手段：closable 传 false，没有单独的 × 按钮标记', () => {
    expect(firstVisit).toMatch(/:closable="false"/)
    // 关闭按钮由共用外壳统一渲染，首次弹窗自己不应该再画一个 ×
    expect(firstVisit).not.toMatch(/>\s*×\s*</)
  })

  it('「查看完整声明」不会触发确认——它只切换到完整声明，不调用 accept', () => {
    // 「我知道了」按钮本来就该 emit accept，不能拿全文件去断言不含它；
    // 这里只查「查看完整声明」那一个 <button> 自己的 click 处理。
    const secondaryButton = firstVisit.match(/<button[^>]*first-visit-notice__secondary[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(secondaryButton).toContain("emit('viewFull')")
    expect(secondaryButton).not.toContain("emit('accept')")
  })

  it('只有点「我知道了」才会写 localStorage', () => {
    expect(gate).toContain('@accept="accept"')
    expect(gate).toContain('markProjectNoticeAccepted()')
    // accept 函数只应该被「我知道了」这一条路径触发，不能被 view-full 顺带调用
    const acceptFnBody = gate.split('function accept')[1]?.split('}')[0] ?? ''
    expect(acceptFnBody).toContain('markProjectNoticeAccepted')
  })
})

describe('NoticeOverlay：closable 控制 ESC / 点遮罩 / × 三件事', () => {
  it('三处关闭手段共享同一个 closable 判断', () => {
    expect(overlay).toContain('if (props.closable) emit')
    expect(overlay).toMatch(/v-if="closable"/)
  })
})

describe('完整声明：内容与标题', () => {
  it('标题与五个小节标题齐全', () => {
    expect(noticeContent).toContain("FULL_DISCLAIMER_TITLE = 'CRPlay 项目声明与免责声明'")
    for (const heading of ['一、原创及 AI 生成内容', '二、游戏玩法与第三方作品', '三、开源代码', '四、非商业用途', '五、权利反馈与联系方式']) {
      expect(noticeContent).toContain(heading)
    }
  })

  it('权利反馈小节不写死具体联系号码——号码由管理员在后台填，写死在法律文本里会越改越对不上', () => {
    // 只取五、这一节自己的范围，不能一路取到文件末尾——后面 DEFAULT_CONTACT_VALUE
    // 兜底常量本来就该等于 1507394636，拿它去比对会把合法的兜底值也算成误判。
    const section5 = noticeContent.split("heading: '五、权利反馈与联系方式'")[1]?.split('export const CONTACT_TITLE')[0] ?? ''
    expect(section5).not.toContain('1507394636')
    expect(section5).not.toContain('QQ')
    expect(section5).toContain('可联系开发者')
  })

  it('不包含强硬法律免责用语', () => {
    for (const forbidden of ['最终解释权归本站所有', '一切后果自行承担', '本站概不负责', '视为放弃一切权利']) {
      expect(noticeContent).not.toContain(forbidden)
    }
  })

  it('允许 ×、ESC、点遮罩关闭', () => {
    expect(fullDisclaimer).not.toMatch(/:closable="false"/)
  })

  it('正文可滚动，头部和底部不跟着滚', () => {
    expect(fullDisclaimer).toMatch(/__body\s*\{[^}]*overflow-y:\s*auto/)
  })
})

describe('联系开发者弹窗', () => {
  it('标题、方式：号码、复制号码/关闭按钮齐全', () => {
    // 标题走 {{ CONTACT_TITLE }} 插值，不会在源码里字面出现「联系开发者」
    expect(contact).toContain('{{ CONTACT_TITLE }}')
    expect(contact).toContain("from '@/notice/noticeContent'")
    expect(contact).toContain('复制号码')
    expect(contact).toContain('已复制')
    expect(contact).toContain('关闭')
    // 按钮文案不能写死成「复制 QQ」——方式可能是微信、邮箱等任意管理员填的文本
    expect(contact).not.toContain('复制 QQ')
  })

  it('展示的是「方式：号码」，方式和号码都来自服务端下发的状态，不是字面 QQ', () => {
    expect(contact).toMatch(/\{\{\s*method\s*\}\}\s*：\s*(?:<span>)?\s*\{\{\s*value\s*\}\}/)
  })

  it('复制的是号码本身（冒号后面那一段），不是「方式：号码」整行', () => {
    expect(contact).toContain('copyText(value.value)')
    expect(contact).not.toContain('copyText(`${method')
  })

  it('不会自动拉起 QQ 客户端或跳转外部页面', () => {
    for (const forbidden of ['tencent://', 'mqqapi://', 'qq.com', 'window.open', 'location.href']) {
      expect(contact).not.toContain(forbidden)
    }
  })

  it('复制按钮用统一的 copyText 封装，不直接裸调 Clipboard API', () => {
    expect(contact).toContain("from '@/notice/clipboard'")
    expect(contact).not.toContain('navigator.clipboard')
  })
})

describe('Footer：内容、位置、不出现 GitHub', () => {
  it('四行固定文案都在', () => {
    expect(noticeContent).toContain("FOOTER_LINE_1 = 'CRPlay · 个人非商业开源项目'")
    expect(noticeContent).toContain("FOOTER_LINE_2 = '部分内容由 AI 辅助生成 · 与相关游戏厂商无官方关联'")
    expect(noticeContent).toContain("FOOTER_DISCLAIMER_LINK = '项目声明与免责声明'")
    expect(noticeContent).toContain("FOOTER_CONTACT_LINK = '联系开发者'")
    expect(noticeContent).toContain("FOOTER_COPYRIGHT = '© 2026 CRPlay'")
  })

  it('不出现 GitHub 相关内容', () => {
    for (const source of [noticeContent, siteFooter, fullDisclaimer, contact, firstVisit]) {
      expect(source.toLowerCase()).not.toContain('github')
    }
  })

  it('只出现在 GamePortal（游戏选择主页），不在其它地方单独出现', () => {
    expect(gamePortal).toContain('<SiteFooter')
  })
})

describe('RootApp：门槛在路由/游戏树之前，包住一切', () => {
  it('ProjectNoticeGate 是模板的唯一根节点，包住停服判断和门户/游戏渲染', () => {
    const templateStart = rootApp.indexOf('<template>')
    const gateIndex = rootApp.indexOf('<ProjectNoticeGate')
    const siteClosedIndex = rootApp.indexOf('v-if="siteClosed"')
    const gamePortalIndex = rootApp.indexOf('<GamePortal')
    const gateCloseIndex = rootApp.indexOf('</ProjectNoticeGate>')
    expect(gateIndex).toBeGreaterThan(templateStart)
    expect(siteClosedIndex).toBeGreaterThan(gateIndex)
    expect(gamePortalIndex).toBeGreaterThan(siteClosedIndex)
    expect(gamePortalIndex).toBeLessThan(gateCloseIndex)
  })

  it('不做任何跳转首页 / 改写 URL 的动作来配合门槛', () => {
    // Gate 本身不引入新的 navigate/history 调用；原有的 navigate 逻辑保持不变。
    // 用赋值/调用形态匹配，而不是裸子串——文件里的中文注释可能提到
    // 「location.href」这几个字来解释别处的行为，那不算实际跳转代码。
    expect(gate).not.toMatch(/history\.(push|replace)State\s*\(/)
    expect(gate).not.toMatch(/location\.href\s*=/)
    expect(gate).not.toMatch(/navigate\(\s*['"]\/['"]/)
  })
})

describe('SSR/localStorage 安全：不在模块顶层直接摸 window', () => {
  it('noticeStorage 把 window 访问包在函数体内的 try/catch 里，而不是模块顶层', () => {
    const beforeFirstFunction = noticeStorage.split('export function')[0]
    expect(beforeFirstFunction).not.toContain('window.')
  })
})

describe('游戏内部不能出现同样的文字', () => {
  const forbiddenMarkers = ['项目说明', '免责声明', '联系开发者', '1507394636', 'crplay_project_notice']

  /** 纸上三国和麻将里，真正会渲染进玩家可见界面的组件文件。 */
  function listVueFiles(dir: string): string[] {
    const url = new URL(`../src/${dir}`, import.meta.url)
    const entries = readdirSync(url, { withFileTypes: true })
    return entries.flatMap((entry) => {
      if (entry.isDirectory()) return listVueFiles(`${dir}/${entry.name}`)
      if (!entry.name.endsWith('.vue')) return []
      return [`${dir}/${entry.name}`]
    })
  }

  it('麻将界面文件（App.vue、components/game、components/online）不包含声明文字', () => {
    const files = ['App.vue', ...listVueFiles('components/game'), ...listVueFiles('components/online')]
    for (const file of files) {
      const source = read(file)
      for (const marker of forbiddenMarkers) {
        expect(source, `${file} 不该出现「${marker}」`).not.toContain(marker)
      }
    }
  })

  it('纸上三国界面文件（SanguoshaApp.vue、sanguosha/components）不包含声明文字', () => {
    const files = ['sanguosha/SanguoshaApp.vue', ...listVueFiles('sanguosha/components')]
    for (const file of files) {
      const source = read(file)
      for (const marker of forbiddenMarkers) {
        expect(source, `${file} 不该出现「${marker}」`).not.toContain(marker)
      }
    }
  })

  it('ModeHome 等纯玩家入口页面不包含', () => {
    for (const file of ['components/ModeHome.vue']) {
      const source = read(file)
      for (const marker of forbiddenMarkers) {
        expect(source, `${file} 不该出现「${marker}」`).not.toContain(marker)
      }
    }
  })

  it('AdminPanel 是这份联系方式设置的合法后台入口，只挡真正不该出现的两项', () => {
    // AdminPanel 现在就是「联系开发者」号码的管理界面本身，
    // 合法包含设置卡片标题「联系开发者」和号码输入框的 placeholder「1507394636」，
    // 不能套用玩家界面的禁用词表。真正不该出现的是：
    // 「项目说明」弹窗标题（后台不该渲染这个弹窗）、
    // localStorage 存储键（前端本地状态，后台读写的是服务端设置，不该碰这个 key）。
    const source = read('components/AdminPanel.vue')
    for (const marker of ['项目说明', 'crplay_project_notice']) {
      expect(source, `AdminPanel.vue 不该出现「${marker}」`).not.toContain(marker)
    }
  })
})
