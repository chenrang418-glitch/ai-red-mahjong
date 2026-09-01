import { describe, expect, it } from 'vitest'
import { createRulesetV1Deck } from '@/sanguosha/data/ruleset-v1/deck'
import { ALL_CARD_INFO } from '@/sanguosha/data/ruleset-v1/card-info'

/**
 * 规则页上的牌面说明。
 *
 * 说明和牌堆必须互相对得上：牌堆里有的牌都要有说明（否则玩家看不到它做什么），
 * 说明里也不能出现牌堆里没有的牌（那就是在描述一个不存在的东西）。
 * 「界面上写了但实现里没有」正是任务书点名禁止的情况。
 */

describe('牌面说明', () => {
  const deckNames = new Set(createRulesetV1Deck().map((card) => card.name))
  const infoNames = new Set(ALL_CARD_INFO.map((info) => info.name))

  it('牌堆里的每一种牌都有说明', () => {
    const missing = [...deckNames].filter((name) => !infoNames.has(name))
    expect(missing, `这些牌没有说明：${missing.join('、')}`).toEqual([])
  })

  it('说明里不出现牌堆里没有的牌', () => {
    const extra = [...infoNames].filter((name) => !deckNames.has(name))
    expect(extra, `这些说明对应的牌不在牌堆里：${extra.join('、')}`).toEqual([])
  })

  it('没有重复条目，说明也不能是空的', () => {
    expect(infoNames.size).toBe(ALL_CARD_INFO.length)
    for (const info of ALL_CARD_INFO) {
      expect(info.description.length, `【${info.name}】的说明是空的`).toBeGreaterThan(4)
    }
  })
})
