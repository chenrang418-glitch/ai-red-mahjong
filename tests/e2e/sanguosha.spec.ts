import { expect, test, type Page } from '@playwright/test'
import { ALL_CHARACTERS } from '../../src/sanguosha/data/characters/standard'

/**
 * 可选武将总数。**不要在用例里写死数字**——每加一个武将就得改两处，
 * 而且这个数已经被写错过一次（记成 26，实为 25）。
 */
const CHARACTER_COUNT = ALL_CHARACTERS.length
/** 艺术集分组的阵营顺序，和页面上的一致。 */
const FACTION_ORDER = ['wei', 'shu', 'wu', 'qun', 'jin', 'shen'] as const
/** 固定展示在「自定义武将」分区的娱乐武将名。 */
const CUSTOM_CHARACTERS = ALL_CHARACTERS.filter((character) => character.pack === 'entertainment').map((character) => character.name)

/**
 * 纸上三国单机流程的浏览器验收。
 *
 * 重点不是好看，而是两件任务书反复强调的事：
 * 1. 每一步都真的点得到——服务端支持不等于前端有入口。
 * 2. 别人的手牌和未公开身份不能出现在 DOM 里。
 */

const PORTRAIT = { width: 393, height: 852 }
const LANDSCAPE = { width: 852, height: 393 }
const DESKTOP = { width: 1280, height: 800 }
const WIDE_LANDSCAPE = { width: 932, height: 430 }
const REQUIRED_FACTION_VIEWPORTS = [
  PORTRAIT,
  WIDE_LANDSCAPE,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 2880, height: 1800 },
]

async function expectNoPageScroll(page: Page) {
  const scroll = await page.evaluate(() => ({
    bodyHeight: document.body.scrollHeight,
    bodyClient: document.body.clientHeight,
    rootHeight: document.documentElement.scrollHeight,
    rootClient: document.documentElement.clientHeight,
    bodyWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
  }))
  expect(scroll.bodyHeight).toBeLessThanOrEqual(scroll.bodyClient + 1)
  expect(scroll.rootHeight).toBeLessThanOrEqual(scroll.rootClient + 1)
  expect(scroll.bodyWidth).toBeLessThanOrEqual(scroll.bodyClientWidth + 1)
}

/** 从门户一路进到牌桌。 */
async function enterTable(page: Page, playerCount?: number) {
  await page.goto('/?game=sanguosha')
  await expect(page.getByRole('heading', { name: '纸上三国' })).toBeVisible()
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await expect(page.getByRole('heading', { name: '单机设置' })).toBeVisible()
  if (playerCount) await page.getByRole('button', { name: `${playerCount} 人`, exact: true }).click()
  // 明确选最快的一档：默认节奏调慢过一次，测试不该跟着默认值一起变慢
  await page.getByRole('button', { name: '较快', exact: true }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()

  // 选将：候选一定要真的能点
  const general = page.locator('.sgs-dock__general').first()
  const confirmGeneral = page.getByRole('button', { name: '开始游戏', exact: true })
  await expect(general).toBeVisible()
  await expect(general).toContainText('【')
  await expect(confirmGeneral).toBeDisabled()
  await general.click()
  await expect(page.locator('.sgs-table')).toHaveCount(0)
  await expect(confirmGeneral).toBeEnabled()
  await confirmGeneral.click()

  await expect(page.locator('.sgs-table')).toBeVisible({ timeout: 15_000 })
}

/** 用开发阵容固定查看指定武将；该参数不会进入生产构建。 */
async function enterDevLineup(page: Page, lineup: string[]) {
  await page.goto(`/?game=sanguosha&lineup=${lineup.join(',')}`)
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '较快', exact: true }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.locator('.sgs-table')).toBeVisible({ timeout: 15_000 })
}

for (const viewport of [DESKTOP, PORTRAIT, LANDSCAPE, WIDE_LANDSCAPE]) {
  const label = `${viewport.width}x${viewport.height}`

  test(`${label} 单机牌桌一屏可玩`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await enterTable(page)

    await expect(page.locator('.sgs-table__back')).toBeVisible()
    await expect(page.locator('.sgs-table__hand')).toBeVisible()
    // 五人局：自己 + 四个其他角色
    await expect(page.locator('.sgs-seat')).toHaveCount(5)
    await expectNoPageScroll(page)
    expect(errors).toEqual([])
  })
}

for (const viewport of REQUIRED_FACTION_VIEWPORTS) {
  test(`${viewport.width}x${viewport.height} 对局势力角标清晰且不遮挡公开信息`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await enterDevLineup(page, ['caocao', 'liubei', 'sunquan', 'lvbu', 'caiwenji'])
    const seats = page.locator('.sgs-seat')
    await expect(seats).toHaveCount(5)
    await expect(page.locator('.sgs-faction-badge')).toHaveText(['魏', '蜀', '吴', '群', '群'])
    const layout = await seats.evaluateAll((nodes) => nodes.map((seat) => {
      const badge = seat.querySelector('.sgs-faction-badge') as HTMLElement
      const nickname = seat.querySelector('.sgs-seat__header strong') as HTMLElement
      const general = seat.querySelector('.sgs-seat__general') as HTMLElement
      const hp = seat.querySelector('.sgs-seat__hp') as HTMLElement
      const seatRect = seat.getBoundingClientRect()
      const badgeRect = badge.getBoundingClientRect()
      const overlaps = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        return badgeRect.left < rect.right && badgeRect.right > rect.left && badgeRect.top < rect.bottom && badgeRect.bottom > rect.top
      }
      return {
        inside: badgeRect.left >= seatRect.left && badgeRect.right <= seatRect.right && badgeRect.top >= seatRect.top && badgeRect.bottom <= seatRect.bottom,
        blocksInfo: [nickname, general, hp].some(overlaps),
        pointerEvents: getComputedStyle(badge).pointerEvents,
        fontSize: Number.parseFloat(getComputedStyle(badge).fontSize),
      }
    }))
    expect(layout.every((entry) => entry.inside)).toBe(true)
    expect(layout.every((entry) => !entry.blocksInfo)).toBe(true)
    expect(layout.every((entry) => entry.pointerEvents === 'none')).toBe(true)
    expect(layout.every((entry) => entry.fontSize >= 12)).toBe(true)
    await expectNoPageScroll(page)
  })
}

for (const viewport of [PORTRAIT, WIDE_LANDSCAPE, DESKTOP]) {
  test(`${viewport.width}x${viewport.height} 山包后四将高清立绘在牌桌完整加载`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await enterDevLineup(page, ['sunce', 'zhangzhaozhanghong', 'caiwenji', 'zuoci', 'zhanghe'])
    await expect(page.locator('.sgs-seat__general')).toContainText(['孙策', '张昭张纮', '蔡文姬', '左慈', '张郃'])
    const images = page.locator('.sgs-seat__art img')
    await expect(images).toHaveCount(5)
    await expect.poll(async () => images.evaluateAll((nodes) => nodes.every((node) => {
      const image = node as HTMLImageElement
      return image.complete && image.naturalWidth >= 480 && image.naturalHeight >= 640
    }))).toBe(true)
    await expectNoPageScroll(page)
  })
}

test('真人左慈可在手机一屏内查看仅本人可见的化身库', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterDevLineup(page, ['zuoci', 'caocao', 'liubei', 'sunquan', 'caiwenji'])
  // 开局必须先亮出一张化身并声明一个合法技能。
  await page.locator('.sgs-dock__actions .primary').first().click()
  await page.locator('.sgs-dock__actions .primary').first().click()
  const libraryButton = page.getByRole('button', { name: '化身库', exact: true })
  await expect(libraryButton).toHaveCount(1)
  await libraryButton.click()
  const panel = page.getByRole('dialog', { name: '化身库' })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('仅你可见')
  await expect(panel.locator('.sgs-huashen-panel__list article')).toHaveCount(2)
  await expect(panel.locator('article.active')).toContainText('当前化身')
  await expectNoPageScroll(page)
  await page.getByRole('button', { name: '关闭化身库' }).click()
  await expect(panel).toHaveCount(0)
})

test('八人局座位全部可见且不溢出', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await enterTable(page, 8)
  await expect(page.locator('.sgs-seat')).toHaveCount(8)
  const clipped = await page.locator('.sgs-seat').evaluateAll((seats) => seats
    .filter((seat) => seat.scrollHeight > seat.clientHeight + 1)
    .map((seat) => seat.querySelector('.sgs-seat__header strong')?.textContent ?? '未知座位'))
  const clippedSkills = await page.locator('.sgs-seat__skills').evaluateAll((skills) => skills
    .filter((skill) => skill.scrollHeight > skill.clientHeight + 1)
    .map((skill) => skill.textContent ?? ''))
  expect(clipped, '角色卡内容不能被座位高度裁切').toEqual([])
  expect(clippedSkills, '技能名称必须完整显示').toEqual([])
  await expectNoPageScroll(page)
})

test('别人的手牌和未公开身份不出现在 DOM 里', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterTable(page)

  const leak = await page.evaluate(() => {
    const others = [...document.querySelectorAll('.sgs-seat-layout__slot:not(.sgs-seat-layout__slot--self) .sgs-seat')]
    return others.map((seat) => ({
      // 别人座位里只允许出现装备区和判定区的牌，这两处本来就是公开的
      zoneCards: seat.querySelectorAll('.sgs-seat__equipment button, .sgs-seat__judging button').length,
      totalCards: seat.querySelectorAll('.sgs-card').length,
      // 手牌只以数量呈现
      showsHandCount: /手牌\s*\d+/.test(seat.textContent ?? ''),
      identityText: seat.querySelector('.sgs-seat__identity')?.textContent?.trim() ?? '',
    }))
  })

  for (const seat of leak) {
    // 座位里出现的牌一张不多不少都来自公开区域
    expect(seat.totalCards).toBe(0)
    expect(seat.showsHandCount).toBe(true)
  }
  // 至少有一个人的身份还没公开，显示为问号
  expect(leak.some((seat) => seat.identityText === '？')).toBe(true)
})

test('环形座位和词条入口在手机牌桌可用', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterTable(page, 8)
  for (const slot of ['self', 'right-bottom', 'right-top', 'top-right', 'top-center', 'top-left', 'left-top', 'left-bottom']) {
    await expect(page.locator(`.sgs-seat-layout__slot--${slot}`)).toHaveCount(1)
  }
  const self = page.locator('.sgs-seat-layout__slot--self')
  const right = page.locator('.sgs-seat-layout__slot--right-bottom')
  const left = page.locator('.sgs-seat-layout__slot--left-bottom')
  const positions = await Promise.all([self, right, left].map(async (locator) => locator.boundingBox()))
  expect(positions[0]!.y).toBeGreaterThan(positions[1]!.y)
  expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x)
  expect(positions[2]!.x).toBeLessThan(positions[0]!.x)

  const info = page.getByRole('button', { name: /查看.*说明/ }).first()
  const cardMain = info.locator('..').locator('.sgs-card')
  await info.click()
  await expect(page.locator('.sgs-glossary-sheet')).toBeVisible()
  await page.getByRole('button', { name: '关闭说明' }).click()
  await expect(cardMain).toBeVisible()

  await page.locator('.sgs-seat-layout__slot:not(.sgs-seat-layout__slot--self) .sgs-seat__identity').filter({ hasText: '？' }).first().click()
  await expect(page.locator('.sgs-glossary-sheet')).toContainText('身份尚未公开')
  await expect(page.locator('.sgs-glossary-sheet')).not.toContainText(/主公|忠臣|反贼|内奸/)
  await expectNoPageScroll(page)
})

test('真人最终一定拿得到可点的操作', async ({ page }) => {
  // 等待预算必须跟着 AI 节奏走：标准档从 950ms 放慢到 1900ms 之后，
  // 「等到真人能操作」需要的真实时间翻了一倍，CI 上比本地更慢。
  // 全局 30s 的用例超时会先一步把它掐掉，所以这条单独放宽。
  // **放宽的是等待时间，不是断言**——真卡住仍然会失败。
  test.setTimeout(180_000)
  await page.setViewportSize(PORTRAIT)
  await enterTable(page)

  // 不去赌「AI 恰好打我」——真正的不变量是：牌局推进下去，
  // 真人迟早会拿到可以点的东西，要么是自己的回合，要么是需要响应的请求。
  // 只能干等超时才是任务书明令禁止的情况。
  const actionable = page.locator('.sgs-dock button:not([disabled]), .sgs-table__dock .sgs-table__actions button:not([disabled])')
  await expect(actionable.first()).toBeVisible({ timeout: 150_000 })
  await expectNoPageScroll(page)
})

test('规则页的技能说明来自武将数据', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /规则/ }).click()
  await expect(page.getByRole('heading', { name: '规则' })).toBeVisible()
  // 武将技能条目直接由 STANDARD_CHARACTERS 渲染
  await expect(page.locator('.sgs-rules')).toContainText('武圣')
  await expect(page.locator('.sgs-rules')).toContainText('咆哮')
  await expect(page.locator('.sgs-rules__kingdom h2')).toHaveText(['魏', '蜀', '吴', '群', '晋', '神'])
  await expectNoPageScroll(page)
})

test('选将页可返回、固定显示自定义武将并进入完整自选池', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择武将' })).toBeVisible()
  await expect(page.getByText('随机武将池', { exact: true })).toBeVisible()
  await expect(page.getByText('自定义武将', { exact: true })).toBeVisible()
  // 自定义池现在不止一个人，逐个断言会随着新增娱乐武将而反复改；
  // 这里只守「池子里确实有这些自定义武将」
  const customCards = page.locator('.sgs-dock__general--custom')
  await expect(customCards).toHaveCount(CUSTOM_CHARACTERS.length)
  await expect(customCards.locator('.sgs-faction-badge')).toHaveText(CUSTOM_CHARACTERS.map(() => '群'))
  await expect(page.locator('.sgs-dock__general .sgs-faction-badge')).toHaveCount(await page.locator('.sgs-dock__general').count())
  for (const name of CUSTOM_CHARACTERS) {
    // 技能说明可能提到另一名娱乐武将（例如善水的【醉闹】会写到平头方块），
    // 所以只检查卡片标题，不能拿整张卡的全文做包含匹配。
    await expect(customCards.locator(':scope > strong').filter({ hasText: name })).toHaveCount(1)
  }

  await page.getByRole('button', { name: '自选', exact: true }).click()
  await expect(page.getByRole('heading', { name: '自选武将' })).toBeVisible()
  await expect(page.getByText('全部武将', { exact: true })).toBeVisible()
  await expect(page.locator('.sgs-dock__general')).toHaveCount(CHARACTER_COUNT)
  await expect(page.locator('.sgs-dock__general .sgs-faction-badge')).toHaveCount(CHARACTER_COUNT)
  expect(await page.locator('.sgs-dock__general .sgs-faction-badge').evaluateAll((badges) => badges.every((badge) => Number.parseFloat(getComputedStyle(badge).fontSize) >= 14))).toBe(true)
  const badgesFit = await page.locator('.sgs-dock__general').evaluateAll((cards) => cards.every((card) => {
    const badge = card.querySelector('.sgs-faction-badge')!.getBoundingClientRect()
    const name = card.querySelector(':scope > strong')!.getBoundingClientRect()
    const bounds = card.getBoundingClientRect()
    const overlapsName = badge.left < name.right && badge.right > name.left && badge.top < name.bottom && badge.bottom > name.top
    return badge.left >= bounds.left && badge.right <= bounds.right && badge.top >= bounds.top && badge.bottom <= bounds.bottom && !overlapsName
  }))
  expect(badgesFit).toBe(true)

  await page.getByRole('button', { name: '返回单机设置' }).click()
  await expect(page.getByRole('heading', { name: '单机设置' })).toBeVisible()
  await expectNoPageScroll(page)
})

test('艺术集按阵营展示全部立绘并可查看原图', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /规则/ }).click()
  await page.getByRole('button', { name: '艺术集' }).click()
  await expect(page.getByRole('heading', { name: '武将艺术集' })).toBeVisible()
  await expect(page.locator('.sgs-art-gallery__group h2')).toHaveText(['魏', '蜀', '吴', '群', '晋', '神'])
  await expect(page.locator('.sgs-art-gallery .sgs-faction-badge')).toHaveCount(0)
  // 每个阵营分组里的立绘数按数据算，不写死——神将陆续加进来时这里不该再改一次
  for (const [index, kingdom] of FACTION_ORDER.entries()) {
    await expect(page.locator('.sgs-art-gallery__group').nth(index).locator('button'))
      .toHaveCount(ALL_CHARACTERS.filter((character) => character.kingdom === kingdom).length)
  }
  await expect(page.locator('.sgs-art-gallery__grid > button')).toHaveCount(CHARACTER_COUNT)
  // 精确匹配：神诸葛亮进来之后 /诸葛亮/ 会同时命中两个
  await page.getByRole('button', { name: '诸葛亮立绘 诸葛亮', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '诸葛亮立绘原图' })).toBeVisible()
  await expect(page.getByAltText('诸葛亮立绘原图')).toBeVisible()
})

test('声音面板提供音乐、音效和震动设置', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: '声音设置' }).click()
  const panel = page.getByRole('dialog', { name: '声音设置' })
  await expect(panel).toContainText('音效音量 100')
  await expect(panel).toContainText('音乐音量 100')
  await expect(panel).toContainText('背景音乐')
  await expect(panel).toContainText('震动反馈')
  await expect(panel.getByRole('slider', { name: '动作音效音量' })).toHaveValue('1')
  await expect(panel.getByRole('slider', { name: '背景音乐音量' })).toHaveValue('1')
})

test('联机大厅入口在手机上一屏可操作', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.addInitScript(() => localStorage.setItem('red-mahjong.nickname', JSON.stringify('测试昵称')))
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /联机游戏/ }).click()
  await expect(page.getByText('输入昵称', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '昵称' })).toHaveValue('测试昵称')
  await expect(page.getByRole('button', { name: '进入大厅' })).toBeVisible()
  await expectNoPageScroll(page)
})

test('战报由引擎事件生成，且不含别人的手牌牌名', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE)
  await enterTable(page)

  // 等牌局推进出几条记录再看，否则只会看到「牌局开始」
  await page.waitForTimeout(6000)
  await page.getByRole('button', { name: '战报' }).click()
  const log = page.locator('.sgs-table__log')
  await expect(log).toBeVisible()
  // 占位文案不能再出现
  await expect(log).not.toContainText('还没接上')

  const text = (await log.innerText()).trim()
  expect(text.length).toBeGreaterThan(20)
  // 别人摸牌只报数量，不报牌名
  expect(text).not.toMatch(/电脑\d 获得【/)
  await expectNoPageScroll(page)
})

test('带房间号的链接直接进联机界面，而不是回首页', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  // 刷新页面之后掉回首页曾经是个真 bug：房间号只存在 localStorage，没写进 URL，
  // 于是后台还连着房间，用户却看到首页。这里守的是「链接自己就能定位到联机界面」。
  await page.goto('/?game=sanguosha&room=ABC234')
  await expect(page.getByText('联机身份局')).toBeVisible()
  // 不该出现单机首页的入口
  await expect(page.getByRole('button', { name: /单机游戏/ })).toHaveCount(0)
  await expectNoPageScroll(page)
})

test('规则页同时给出牌面说明和武将技能', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /规则/ }).click()
  const rules = page.locator('.sgs-rules')
  // 牌面说明：装备的特效以前完全没写在界面上，玩家无从知晓
  await expect(rules).toContainText('麒麟弓')
  await expect(rules).toContainText('方天画戟')
  await expect(rules).toContainText('无懈可击')
  // 武将技能仍然直接来自武将数据
  await expect(rules).toContainText('武圣')
  await expect(rules).toContainText('离间')
  await expectNoPageScroll(page)
})

test('牌桌返回键先确认，误点不会丢掉整局', async ({ page }) => {
  await page.setViewportSize(PORTRAIT)
  await enterTable(page)

  await page.locator('.sgs-table__back').click()
  const confirm = page.locator('.sgs-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('进度不会保存')

  // 选「继续游戏」要回到原来那局，而不是退出
  await confirm.getByRole('button', { name: '继续游戏' }).click()
  await expect(page.locator('.sgs-confirm')).toHaveCount(0)
  await expect(page.locator('.sgs-seat')).toHaveCount(5)
  await expectNoPageScroll(page)
})

test('底部面板有高度上限，选项再多也不会顶出屏幕', async ({ page }) => {
  // 选将三个长技能、五谷丰登八张牌、遗计的分配表都会把面板撑很高，
  // 没有上限的话整张牌桌会被顶到屏幕下方。
  await page.setViewportSize({ width: 360, height: 640 })
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()

  const dock = page.locator('.sgs-dock')
  await expect(dock).toBeVisible()
  const box = await dock.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { bottom: rect.bottom, viewport: window.innerHeight, canScroll: node.scrollHeight > node.clientHeight || node.scrollHeight === node.clientHeight }
  })
  expect(box.bottom, '面板底边不能超出屏幕').toBeLessThanOrEqual(box.viewport + 1)
  await expectNoPageScroll(page)
})
