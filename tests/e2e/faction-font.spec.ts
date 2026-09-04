import { expect, test } from '@playwright/test'

/**
 * 势力角标的书法字体。
 *
 * 原本字体栈里只有「华文行楷」这类**本机系统字体**：Windows 上装着，电脑端正常显示书法体；
 * iOS / Android 一个都没有，退到 generic cursive，中文下就是普通字体——
 * 用户在手机上看到的就是这个。不是浏览器不兼容，是字体不在设备上。
 *
 * 现在自带一份子集化的 Ma Shan Zheng。这个文件守两件事：
 * 字体确实随包发出去且能加载；以及 unicode-range 框死在六个势力字上，不接管别的文字。
 *
 * 注意 CJK 字形全是全角等宽，**量文字宽度分不出字体**，只能比渲染出来的像素。
 */

test('真实势力角标优先使用自带书法字体且字形不同于系统无衬线', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto('/?game=sanguosha')
  await page.getByRole('button', { name: /单机游戏/ }).click()
  await page.getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.getByRole('heading', { name: '选择武将' })).toBeVisible()
  await expect(page.locator('.sgs-faction-badge').first()).toBeVisible()

  const badge = page.locator('.sgs-faction-badge').first()
  const result = await badge.evaluate(async (element) => {
    await document.fonts.load('400 13px SgsFactionScript', '魏蜀吴群晋神')
    await document.fonts.ready
    const style = getComputedStyle(element)
    const loaded = document.fonts.check('400 13px SgsFactionScript', '魏蜀吴群晋神')

    // CJK 全是全角等宽，量宽度分不出字体，只能比像素
    const render = (family: string, text: string) => {
      const canvas = document.createElement('canvas')
      canvas.width = 64; canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 64, 64)
      ctx.fillStyle = '#000'; ctx.font = `600 48px ${family}`
      ctx.textBaseline = 'top'
      ctx.fillText(text, 4, 4)
      return canvas.toDataURL()
    }
    const differs = (family: string, text: string) => render(family, text) !== render('sans-serif', text)

    return {
      loaded,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      // 角标里的六个字：自带字体应当画得和普通无衬线不一样
      inRange: '魏蜀吴群晋神'.split('').map((char) => differs('SgsFactionScript, sans-serif', char)),
      // unicode-range 之外：必须和普通无衬线画得一模一样，说明没被接管
      outOfRange: '关羽诸葛亮杀闪桃'.split('').map((char) => differs('SgsFactionScript, sans-serif', char)),
    }
  })

  console.log('FONT', JSON.stringify(result))
  expect(result.loaded, '自带的书法字体必须能加载').toBe(true)
  expect(result.fontFamily.split(',')[0].replace(/["']/g, '').trim(), '真实角标的第一优先字体必须是自带字体').toBe('SgsFactionScript')
  expect(result.fontWeight, '真实角标必须请求字体文件实际提供的 400 字重').toBe('400')
  expect(result.inRange, '六个势力字都应由自带的书法字体渲染').toEqual([true, true, true, true, true, true])
  expect(result.outOfRange, 'unicode-range 之外的字不能被这个字体接管').toEqual(new Array(8).fill(false))

  const comparison = await badge.evaluate((element) => {
    const host = document.createElement('div')
    host.dataset.testid = 'faction-font-comparison'
    Object.assign(host.style, {
      position: 'fixed',
      inset: '8px auto auto 8px',
      zIndex: '2147483647',
      display: 'flex',
      gap: '8px',
      padding: '8px',
      background: '#fff',
    })

    const script = element.cloneNode(true) as HTMLElement
    script.dataset.testid = 'faction-font-script'
    script.textContent = '魏蜀吴群晋神'
    const fallback = script.cloneNode(true) as HTMLElement
    fallback.dataset.testid = 'faction-font-sans'
    fallback.style.setProperty('font-family', 'sans-serif', 'important')
    host.append(script, fallback)
    document.body.append(host)

    return {
      scriptFamily: getComputedStyle(script).fontFamily,
      fallbackFamily: getComputedStyle(fallback).fontFamily,
    }
  })

  expect(comparison.scriptFamily.split(',')[0].replace(/["']/g, '').trim()).toBe('SgsFactionScript')
  expect(comparison.fallbackFamily).toBe('sans-serif')

  const scriptPixels = await page.getByTestId('faction-font-script').screenshot()
  const fallbackPixels = await page.getByTestId('faction-font-sans').screenshot()
  expect(scriptPixels.equals(fallbackPixels), '真实角标与强制 sans-serif 副本的截图像素必须不同').toBe(false)
})
