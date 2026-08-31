import { describe, expect, it } from 'vitest'
import { createRulesetV1Deck, rulesetV1DeckSize } from '@/sanguosha/data/ruleset-v1/deck'

describe('ruleset-v1 牌堆', () => {
  const deck = createRulesetV1Deck()

  it('严格由标准 108 + 军争 52 构成', () => {
    expect(rulesetV1DeckSize).toEqual({ standard: 108, maneuvering: 52, total: 160 })
    expect(deck).toHaveLength(160)
    expect(new Set(deck.map((card) => card.id)).size).toBe(160)
  })

  it('四种花色各 40 张，红黑各 80 张', () => {
    const count = (field: 'suit' | 'color', value: string) => deck.filter((card) => card[field] === value).length
    for (const suit of ['spade', 'heart', 'club', 'diamond']) expect(count('suit', suit)).toBe(40)
    expect(count('color', 'red')).toBe(80)
    expect(count('color', 'black')).toBe(80)
  })

  it('类别数量与 160 张军争身份牌堆一致', () => {
    expect(deck.filter((card) => card.category === 'basic')).toHaveLength(85)
    expect(deck.filter((card) => card.category === 'trick')).toHaveLength(50)
    expect(deck.filter((card) => card.category === 'equipment')).toHaveLength(25)
  })

  it('属性杀和军争核心牌数量正确', () => {
    expect(deck.filter((card) => card.name === '杀' && card.damageNature === 'fire')).toHaveLength(5)
    expect(deck.filter((card) => card.name === '杀' && card.damageNature === 'thunder')).toHaveLength(9)
    expect(deck.filter((card) => card.name === '酒')).toHaveLength(5)
    expect(deck.filter((card) => card.name === '火攻')).toHaveLength(3)
    expect(deck.filter((card) => card.name === '铁索连环')).toHaveLength(6)
    expect(deck.filter((card) => card.name === '兵粮寸断')).toHaveLength(2)
  })

  it('装备槽和武器距离数据明确', () => {
    expect(deck.find((card) => card.name === '麒麟弓')).toMatchObject({ equipmentSlot: 'weapon', attackRange: 5 })
    expect(deck.find((card) => card.name === '赤兔')).toMatchObject({ equipmentSlot: 'offensiveHorse' })
    expect(deck.find((card) => card.name === '骅骝')).toMatchObject({ equipmentSlot: 'defensiveHorse' })
    expect(deck.find((card) => card.name === '藤甲')).toMatchObject({ equipmentSlot: 'armor' })
  })
})
