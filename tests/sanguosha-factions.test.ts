import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import SgsArtGallery from '@/sanguosha/components/SgsArtGallery.vue'
import SgsFactionBadge from '@/sanguosha/components/SgsFactionBadge.vue'
import { ALL_CHARACTERS } from '@/sanguosha/data/characters/standard'
import { FACTION_CONFIG, FACTION_ORDER, type Faction } from '@/sanguosha/shared/factions'

describe('三国杀六势力基础数据', () => {
  it('固定使用魏蜀吴群晋神顺序和唯一颜色配置', () => {
    expect(FACTION_ORDER).toEqual(['wei', 'shu', 'wu', 'qun', 'jin', 'shen'])
    expect(FACTION_ORDER.map((id) => FACTION_CONFIG[id].name)).toEqual(['魏', '蜀', '吴', '群', '晋', '神'])
    expect(Object.fromEntries(FACTION_ORDER.map((id) => [id, FACTION_CONFIG[id].color]))).toEqual({
      wei: '#315A8C', shu: '#3F7D4A', wu: '#A94442', qun: '#666A70', jin: '#75558A', shen: '#C9972F',
    })
  })

  it('当前全部武将都显式拥有且只拥有一个合法势力', () => {
    // **不写死总数**：每加一名武将都要来改一次数字是纯噪音，
    // 而且这条测试要守的是「每个人都有且只有一个合法势力」，不是池子多大。
    expect(ALL_CHARACTERS.length).toBeGreaterThan(0)
    expect(new Set(ALL_CHARACTERS.map((character) => character.id)).size).toBe(ALL_CHARACTERS.length)
    for (const character of ALL_CHARACTERS) {
      expect(Object.prototype.hasOwnProperty.call(character, 'kingdom'), `${character.id} 缺少 kingdom`).toBe(true)
      expect(FACTION_ORDER, `${character.id} 的 kingdom 非法`).toContain(character.kingdom)
      expect(typeof character.kingdom).toBe('string')
    }
  })

  it.each(FACTION_ORDER)('%s 角标从统一配置读取文字和颜色', async (faction) => {
    const html = await renderToString(createSSRApp(SgsFactionBadge, { faction: faction as Faction }))
    expect(html).toContain(`>${FACTION_CONFIG[faction].name}</span>`)
    expect(html).toContain(`--faction-color:${FACTION_CONFIG[faction].color}`)
    expect(html).toContain(`aria-label="${FACTION_CONFIG[faction].name}势力"`)
  })

  it('生产 CSP 允许 Vite 内联的势力字体加载', () => {
    const headers = readFileSync('public/_headers', 'utf8')
    expect(headers).toMatch(/Content-Security-Policy:.*font-src 'self' data:/)
  })
})

describe('规则页和艺术集的势力分类', () => {
  it('艺术集保留六个标题和空阵营，但不在立绘卡片上叠加角标', async () => {
    const html = await renderToString(createSSRApp(SgsArtGallery))
    const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1])
    expect(headings).toEqual(['魏', '蜀', '吴', '群', '晋', '神'])
    expect(html.match(/sgs-art-gallery__group/g)).toHaveLength(6)
    expect(html).not.toContain('sgs-faction-badge')
  })

  it('规则页同样直接读取六势力配置且不隐藏空分组', () => {
    const source = readFileSync('src/sanguosha/SanguoshaApp.vue', 'utf8')
    expect(source).toContain("FACTION_CONFIG, FACTION_ORDER")
    expect(source).toContain('FACTION_ORDER.map')
    expect(source).not.toContain('filter((group) => group.characters.length)')
    expect(source).not.toContain('SgsFactionBadge')
  })

  it('选将卡复用对局的势力角标组件，不维护第二套颜色', () => {
    const source = readFileSync('src/sanguosha/components/SgsRequestDock.vue', 'utf8')
    expect(source).toContain("import SgsFactionBadge from './SgsFactionBadge.vue'")
    expect(source.match(/<SgsFactionBadge/g)).toHaveLength(2)
    expect(source.match(/variant="pick"/g)).toHaveLength(2)
    expect(source).not.toContain('FACTION_CONFIG')
  })
})
