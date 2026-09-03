import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsSeat from '@/sanguosha/components/SgsSeat.vue'
import { characterPortrait, CHARACTER_PORTRAITS } from '@/sanguosha/assets/characters/manifest'
import { SanguoshaGame } from '@/sanguosha/engine/game'
import { allCharacterIds } from '@/sanguosha/data/characters/standard'
import type { GameSetup, Identity } from '@/sanguosha/engine/types'

/**
 * 立绘接入契约。
 *
 * 素材由用户提供，仓库里可以一张都没有。这几条守住的是**接口本身**：
 * 缺图时必须安静地回退到文字底纹（不报错、不白屏），有图时参数必须能下发到 CSS。
 * 一旦有人重构把回退路径弄丢，线上会在没素材的武将上直接开天窗。
 */

function seatProps(characterId: string) {
  const setup: GameSetup = {
    mode: 'identity', generalChoices: 1,
    players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: index === 0 })),
  }
  const game = new SanguoshaGame({ seed: 'portrait-contract', setup })
  const identities: Identity[] = ['lord', 'rebel', 'loyalist', 'rebel', 'renegade']
  game.state.players.forEach((player, index) => {
    player.identity = identities[index]
    player.characterId = characterId
  })
  game.start()
  const view = game.viewFor('p0')
  return { player: view.players.find((candidate) => candidate.id === 'p1')!, viewerId: view.viewerId }
}

describe('缺素材时的回退', () => {
  it('没登记的武将不渲染立绘层，改用文字底纹', async () => {
    // 不写死某个武将：素材是一批批加的，写死谁迟早会因为那个人加了图而失效。
    // 直接找一个当前没登记的 id，加到多少个武将这条都成立。
    const unregistered = allCharacterIds().find((id) => !CHARACTER_PORTRAITS[id]) ?? '__never_registered__'
    expect(characterPortrait(unregistered), `${unregistered} 不该有素材`).toBeNull()
    const html = await renderToString(createSSRApp(SgsSeat, seatProps(unregistered)))
    expect(html).not.toContain('sgs-seat__art')
    expect(html).not.toContain('sgs-seat--has-art')
    // 文字底纹那一层必须还在，否则座位会是一块空白
    expect(html).toContain('sgs-seat__portrait')
  })

  it('characterPortrait 对空值和未知 id 都返回 null，不抛错', () => {
    expect(characterPortrait(null)).toBeNull()
    expect(characterPortrait('这个武将不存在')).toBeNull()
  })
})

describe('登记项的形状', () => {
  it('每名可玩武将都有座位图与独立高清图', () => {
    expect(Object.keys(CHARACTER_PORTRAITS).sort()).toEqual([...allCharacterIds()].sort())
    for (const [id, portrait] of Object.entries(CHARACTER_PORTRAITS)) {
      expect(portrait.fullSrc, `${id} 的艺术集不能回退到座位小图`).not.toBe(portrait.src)
    }
  })

  it('每一项都要同时给出 PC 和移动端两套裁切参数', () => {
    // 只给一套的话，另一档会退回默认值，脸大概率跑到框外
    for (const [id, portrait] of Object.entries(CHARACTER_PORTRAITS)) {
      expect(portrait.src, `${id} 缺少图片`).toBeTruthy()
      for (const device of ['desktop', 'mobile'] as const) {
        expect(portrait[device].position, `${id}.${device} 缺少焦点`).toMatch(/^\d+% \d+%$/)
        expect(portrait[device].scale, `${id}.${device} 倍率不合理`).toBeGreaterThan(0)
        expect(portrait[device].scale, `${id}.${device} 倍率过大，满幅下会把脸放糊`).toBeLessThanOrEqual(2)
      }
      expect(portrait.credit, `${id} 必须写明素材出处，便于回溯授权`).toBeTruthy()
    }
  })
})

describe('座位结构的硬约束', () => {
  const source = readFileSync(new URL('../src/sanguosha/components/SgsSeat.vue', import.meta.url), 'utf8')

  it('立绘层有自己的裁剪容器，缩放的是里面的 img', () => {
    // 直接把 transform 加在座位的直接子元素上，放大溢出会算进 scrollHeight，
    // E2E 的「角色卡内容不能被座位高度裁切」会误判。这个坑踩过一次。
    expect(source).toMatch(/\.sgs-seat__art \{[^}]*overflow: hidden/)
    expect(source).toMatch(/\.sgs-seat__art img \{[^}]*transform: scale\(var\(--art-scale/)
  })

  it('文字靠轻量阴影提亮，不使用会让 iPhone 中文笔画粘连的描边', () => {
    expect(source).not.toContain('-webkit-text-stroke')
    expect(source).toContain('text-shadow: 0 1px 2px #000, 0 0 5px')
    expect(source).toMatch(/\.sgs-seat__shade--art \{ background: none/)
  })

  it('移动端断点覆盖手机横屏', () => {
    // 手机横屏是 932 宽却只有 94px 高的座位，只写 max-width:820px 会漏掉它
    expect(source).toContain('@media (max-width: 820px), (orientation: landscape) and (max-height: 500px)')
  })

  it('阵亡只把立绘变灰，座位信息仍可读', () => {
    expect(source).toMatch(/\.sgs-seat--dead \.sgs-seat__art img \{[^}]*grayscale/)
    // 座位整体不能再加 grayscale，否则身份和血量跟着糊掉
    expect(source).not.toMatch(/\.sgs-seat--dead\{[^}]*grayscale/)
  })
})
