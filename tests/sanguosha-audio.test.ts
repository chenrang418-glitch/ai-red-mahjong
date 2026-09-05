import { describe, expect, it } from 'vitest'
import { ALL_CARD_INFO } from '@/sanguosha/data/ruleset-v1/card-info'
import { effectForPresentation, SGS_AUDIO_DEFAULTS } from '@/sanguosha/composables/useSgsAudio'
import type { PresentationEvent } from '@/sanguosha/engine/presentation'

function cardEvent(cardName: string, kind: 'card-use' | 'card-response' = 'card-use'): PresentationEvent {
  return { id: `sound-${cardName}`, seq: 1, kind, sourceId: 'p0', targetIds: ['p1'], cardName, text: cardName }
}

describe('纸上三国声音映射', () => {
  it('音乐和动作音效默认均为 100%', () => {
    expect(SGS_AUDIO_DEFAULTS.musicVolume).toBe(1)
    expect(SGS_AUDIO_DEFAULTS.effectsVolume).toBe(1)
  })

  it('规则集里的每一种卡牌都有动作音效', () => {
    for (const card of ALL_CARD_INFO) expect(effectForPresentation(cardEvent(card.name)), card.name).not.toBeNull()
  })

  it('杀、闪、桃和主要锦囊使用不同的辨识音色', () => {
    expect(effectForPresentation(cardEvent('杀'))).toBe('slash')
    expect(effectForPresentation(cardEvent('闪', 'card-response'))).toBe('dodge')
    expect(effectForPresentation(cardEvent('桃'))).toBe('peach')
    expect(effectForPresentation(cardEvent('南蛮入侵'))).toBe('nanman')
    expect(effectForPresentation(cardEvent('万箭齐发'))).toBe('arrows')
    expect(effectForPresentation(cardEvent('无懈可击'))).toBe('counter')
  })

  it('伤害、回血、濒死、死亡、技能和判定都有反馈', () => {
    const event = (kind: PresentationEvent['kind'], nature?: 'normal' | 'fire' | 'thunder'): PresentationEvent => ({ id: kind, seq: 1, kind, nature, text: kind })
    expect(effectForPresentation(event('damage', 'fire'))).toBe('fire')
    expect(effectForPresentation(event('damage', 'thunder'))).toBe('thunder')
    expect(effectForPresentation(event('recover'))).toBe('recover')
    expect(effectForPresentation(event('dying'))).toBe('dying')
    expect(effectForPresentation(event('death'))).toBe('death')
    expect(effectForPresentation(event('skill'))).toBe('skill')
    expect(effectForPresentation(event('judge'))).toBe('judge')
  })
})
