import { expect, test } from '@playwright/test'

const STORAGE_KEY = 'crplay_project_notice_v1'

/**
 * 「项目说明与免责声明」门槛。
 *
 * 全局 playwright.config.ts 已经把 storageState 预置成「已接受」，
 * 好让其余 e2e 用例不用逐个关心这道门槛。这个文件测的正是门槛本身，
 * 所以每个 describe 按需要用 test.use() 把 storageState 改回「未接受」。
 *
 * 最关键的一条约束：门槛必须挡在路由/房间解析之前，但不能改写 URL、
 * 不能丢房间号、不能在验收之后重复触发联机自动加入。
 */

test.describe('全新访问：门槛挡在最前面，且不碰 URL', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('裸首页：显示「项目说明」弹窗，没有任何关闭手段', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()
    await expect(page).toHaveURL('/')
    // 三段正文逐字可见
    await expect(page.getByText('CRPlay 是个人开发维护的非商业开源网页游戏项目')).toBeVisible()
    // 首次弹窗不画 × 关闭按钮
    await expect(page.locator('.notice-overlay__close')).toHaveCount(0)

    // ESC 不关
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()

    // 点遮罩不关
    await page.mouse.click(6, 6)
    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()

    // 底下的游戏中心还没渲染出来
    await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toHaveCount(0)
  })

  test('点「我知道了」：写入 localStorage、弹窗关闭、继续显示首页内容', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '我知道了' }).click()

    await expect(page.getByRole('heading', { name: '项目说明' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toBeVisible()
    await expect(page).toHaveURL('/')

    const stored = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
    expect(stored).toBe('accepted')
  })

  test('「查看完整声明」不算确认：关闭后回到首次弹窗，localStorage 仍未写入', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '查看完整声明' }).click()

    await expect(page.getByRole('heading', { name: 'CRPlay 项目声明与免责声明' })).toBeVisible()
    const storedWhileOpen = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
    expect(storedWhileOpen).toBeNull()

    // 完整声明允许 × 关闭；关掉之后应该回到首次弹窗，而不是直接放行
    await page.locator('.notice-overlay__close').click()
    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()
    const storedAfterClose = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
    expect(storedAfterClose).toBeNull()

    // 这才是真正的确认路径
    await page.getByRole('button', { name: '我知道了' }).click()
    await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toBeVisible()
  })
})

test.describe('全新访问 + 房间分享链接：URL 和房间号必须原样保留', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('麻将房间链接：先看到项目说明，接受后继续进入加入房间流程，URL 不变', async ({ page }) => {
    await page.goto('/?room=ABC234')

    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()
    await expect(page).toHaveURL(/room=ABC234/)
    // 门槛没接受之前，房间加入流程不应该渲染出来
    await expect(page.getByText('加入房间 ABC234')).toHaveCount(0)

    await page.getByRole('button', { name: '我知道了' }).click()

    await expect(page.getByRole('heading', { name: '项目说明' })).toHaveCount(0)
    await expect(page.getByText('加入房间 ABC234')).toBeVisible()
    await expect(page).toHaveURL(/room=ABC234/)
  })

  test('三国杀房间链接：先看到项目说明，接受后继续进入联机身份局，URL 不变', async ({ page }) => {
    await page.goto('/?game=sanguosha&room=ABC234')

    await expect(page.getByRole('heading', { name: '项目说明' })).toBeVisible()
    await expect(page).toHaveURL(/game=sanguosha&room=ABC234/)
    await expect(page.getByText('联机身份局')).toHaveCount(0)

    await page.getByRole('button', { name: '我知道了' }).click()

    await expect(page.getByRole('heading', { name: '项目说明' })).toHaveCount(0)
    await expect(page.getByText('联机身份局')).toBeVisible()
    await expect(page).toHaveURL(/game=sanguosha&room=ABC234/)
  })
})

test.describe('已接受过的访问：门槛不再出现', () => {
  // 用全局 storageState 的默认值（已接受），不用覆盖

  test('直接看到首页，不经过项目说明弹窗', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'CRPlay 游戏中心' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '项目说明' })).toHaveCount(0)
  })
})

test.describe('Footer：完整声明和联系开发者入口', () => {
  test('「项目声明与免责声明」打开可关闭的完整声明弹窗', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '项目声明与免责声明' }).click()

    await expect(page.getByRole('heading', { name: 'CRPlay 项目声明与免责声明' })).toBeVisible()
    for (const heading of ['一、原创及 AI 生成内容', '二、游戏玩法与第三方作品', '三、开源代码', '四、非商业用途', '五、权利反馈与联系方式']) {
      await expect(page.getByText(heading)).toBeVisible()
    }

    await page.locator('.full-disclaimer__close-btn').click()
    await expect(page.getByRole('heading', { name: 'CRPlay 项目声明与免责声明' })).toHaveCount(0)
    // Footer 打开的完整声明关闭后是单纯收起，不会倒回首次弹窗
    await expect(page.getByRole('heading', { name: '项目说明' })).toHaveCount(0)
  })

  test('「联系开发者」展示服务端下发的方式：号码，并且能复制号码本身', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
    await page.goto('/')
    await page.getByRole('button', { name: '联系开发者', exact: true }).click()

    await expect(page.getByRole('heading', { name: '联系开发者' })).toBeVisible()
    const copyButton = page.getByRole('button', { name: '复制号码' })
    await expect(copyButton).toBeVisible()

    await copyButton.click()
    await expect(page.getByRole('button', { name: '已复制' })).toBeVisible()

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText())
    // 复制的应该只是号码本身，不带前面的「方式：」标签
    expect(clipboardText).not.toContain('：')
  })
})
