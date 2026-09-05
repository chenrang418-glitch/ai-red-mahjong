import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_CARD_INFO } from '@/sanguosha/data/ruleset-v1/card-info'
import { effectForPresentation, SGS_AUDIO_DEFAULTS } from '@/sanguosha/composables/useSgsAudio'
import { buildPresentationEvent, type PresentationEvent } from '@/sanguosha/engine/presentation'
import { SanguoshaGame } from '@/sanguosha/engine/game'

function cardEvent(cardName: string, kind: 'card-use' | 'card-response' = 'card-use'): PresentationEvent {
  return { id: `sound-${cardName}`, seq: 1, kind, sourceId: 'p0', targetIds: ['p1'], cardName, text: cardName }
}
function judgeEvent(judgeReason: string, judgeHit: boolean): PresentationEvent {
  return { id: `judge-${judgeReason}-${judgeHit}`, seq: 1, kind: 'judge', targetIds: ['p0'], judgeReason, judgeHit, text: judgeReason }
}

/** 延时锦囊的音效由判定事件负责，牌本身不出声，所以不参加「每张牌都有音效」那条。 */
const DELAYED = ['乐不思蜀', '兵粮寸断', '闪电']

describe('纸上三国声音映射', () => {
  it('音乐和动作音效默认均为 100%', () => {
    expect(SGS_AUDIO_DEFAULTS.musicVolume).toBe(1)
    expect(SGS_AUDIO_DEFAULTS.effectsVolume).toBe(1)
  })

  it('除延时锦囊外，规则集里的每一种卡牌都有动作音效', () => {
    for (const card of ALL_CARD_INFO) {
      if (DELAYED.includes(card.name)) continue
      expect(effectForPresentation(cardEvent(card.name)), card.name).not.toBeNull()
    }
  })

  it('每种锦囊各有独立音色，没有笼统的兜底', () => {
    const names = ['无中生有', '无懈可击', '五谷丰登', '南蛮入侵', '万箭齐发', '决斗', '过河拆桥', '顺手牵羊', '借刀杀人', '火攻', '铁索连环']
    const effects = names.map((name) => effectForPresentation(cardEvent(name)))
    expect(effects).toEqual(['wuzhong', 'counter', 'wugu', 'nanman', 'arrows', 'duel', 'dismantle', 'snatch', 'borrowed-sword', 'fire', 'chain'])
    // 全部互不相同：任何两张锦囊听起来一样就等于没有信息
    expect(new Set(effects).size).toBe(names.length)
  })

  it('借刀杀人不会被当成出杀', () => {
    // 它的牌名里带「杀」，用 includes('杀') 匹配就会一直播错
    expect(effectForPresentation(cardEvent('借刀杀人'))).toBe('borrowed-sword')
    expect(effectForPresentation(cardEvent('杀'))).toBe('slash')
  })

  it('火杀、雷杀的出牌动作和普通杀合并为同一个音效', () => {
    expect(effectForPresentation(cardEvent('火杀'))).toBe('slash')
    expect(effectForPresentation(cardEvent('雷杀'))).toBe('slash')
  })

  it('桃、桃园结义、濒死自救的酒都归到回复音', () => {
    expect(effectForPresentation(cardEvent('桃'))).toBe('recover')
    expect(effectForPresentation(cardEvent('桃园结义'))).toBe('recover')
    // 濒死自救的酒走「打出」，出牌阶段助兴的酒走「使用」
    expect(effectForPresentation(cardEvent('酒', 'card-response'))).toBe('recover')
    expect(effectForPresentation(cardEvent('酒', 'card-use'))).toBe('wine')
  })

  it('任何实际扣血都用同一个伤害音，不按属性分三种', () => {
    const event = (kind: PresentationEvent['kind'], nature?: 'normal' | 'fire' | 'thunder'): PresentationEvent => ({ id: `${kind}-${nature}`, seq: 1, kind, nature, text: kind })
    expect(effectForPresentation(event('damage', 'normal'))).toBe('damage')
    expect(effectForPresentation(event('damage', 'fire'))).toBe('damage')
    expect(effectForPresentation(event('damage', 'thunder'))).toBe('damage')
    expect(effectForPresentation(event('lose-hp'))).toBe('damage')
  })

  it('延时锦囊放进判定区时不出声，只有判定真正生效才播', () => {
    for (const name of DELAYED) expect(effectForPresentation(cardEvent(name)), name).toBeNull()
    expect(effectForPresentation(judgeEvent('乐不思蜀', true))).toBe('indulgence')
    expect(effectForPresentation(judgeEvent('兵粮寸断', true))).toBe('supply-shortage')
    expect(effectForPresentation(judgeEvent('闪电', true))).toBe('thunder')
    // 没命中不再播放浏览器合成判定音
    expect(effectForPresentation(judgeEvent('乐不思蜀', false))).toBeNull()
    expect(effectForPresentation(judgeEvent('兵粮寸断', false))).toBeNull()
    expect(effectForPresentation(judgeEvent('闪电', false))).toBeNull()
  })

  it('技能判定这类普通判定不再播放浏览器合成音', () => {
    expect(effectForPresentation({ id: 'j', seq: 1, kind: 'judge', targetIds: ['p0'], judgeReason: '鬼才', judgeHit: false, text: '判定' })).toBeNull()
  })

  it('武器和防具共用装备音，坐骑单独使用坐骑音', () => {
    expect(effectForPresentation(cardEvent('青龙偃月刀'))).toBe('equip')
    expect(effectForPresentation(cardEvent('八卦阵'))).toBe('equip')
    expect(effectForPresentation(cardEvent('赤兔'))).toBe('equip-mount')
  })

  it('失去装备、改判和仅展示牌都不触发牌效', () => {
    expect(effectForPresentation({ id: 'lose-equip', seq: 1, kind: 'equipment', cardName: '八卦阵', text: '失去装备' })).toBeNull()
    expect(effectForPresentation({ ...cardEvent('杀', 'card-response'), cardEffect: false })).toBeNull()
    expect(effectForPresentation({ ...cardEvent('桃', 'card-response'), cardEffect: false })).toBeNull()
  })

  it('按实际生效牌名播放，而不是实体牌原名', () => {
    // 表现事件的 cardName 已经是转化后的有效牌名；例如把桃当杀使用时应听到杀。
    expect(effectForPresentation({ ...cardEvent('杀'), id: 'view-as-peach-to-slash' })).toBe('slash')
  })

  it('女性使用固定受击、濒死和阵亡音，男性使用对应音效池', () => {
    const event = (kind: 'damage' | 'dying' | 'death', targetGender: 'male' | 'female'): PresentationEvent => ({ id: `${kind}-${targetGender}`, seq: 1, kind, targetGender, text: kind })
    expect(effectForPresentation(event('damage', 'male'))).toBe('damage')
    expect(effectForPresentation(event('damage', 'female'))).toBe('damage-female')
    expect(effectForPresentation(event('dying', 'male'))).toBe('dying')
    expect(effectForPresentation(event('dying', 'female'))).toBe('dying-female')
    expect(effectForPresentation(event('death', 'male'))).toBe('death')
    expect(effectForPresentation(event('death', 'female'))).toBe('death-female')
  })

  /*
   * 成品文件和登记表必须一一对应。
   *
   * 少登记一个：文件白做，永远听不到。
   * 多登记一个（或者路径打错一个字母）：取不到就保持静音，
   * 表面上完成接入，实际根本没生效——这种错最难发现，所以钉死。
   */
  it('音效文件和登记表一一对应', () => {
    const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../src/sanguosha/assets/audio')
    const files = readdirSync(directory).filter((name) => name.endsWith('.mp3')).sort()
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/sanguosha/composables/useSgsAudio.ts'), 'utf8')
    const registered = [...source.matchAll(/assets\/audio\/([A-Za-z0-9-]+\.mp3)/g)].map((match) => match[1]).sort()
    expect(registered, '登记的文件名').toEqual(files)
    for (const file of files) expect(statSync(resolve(directory, file)).size, file).toBeGreaterThan(0)
    expect(files).not.toContain('deal.mp3')
  })

  /*
   * 开局音的触发链：引擎发 PlayBegin → 表现层产出 game-start → 映射到开局音。
   *
   * 这条链踩过两个坑，都钉在这里：
   * 1. 不能用「表格挂载时还没有历史事件」去猜——牌局开起来时引擎已经产生了
   *    若干条事件，那个条件永远不成立；
   * 2. 不能复用引擎的 `GameStart`——它在 SanguoshaGame 的构造函数里发，
   *    那时候外部监听器还没挂上，谁都听不到。
   */
  it('开局时表现流的第一条就是开局音事件', () => {
    const events: PresentationEvent[] = []
    const game = new SanguoshaGame({
      seed: 'audio-game-start',
      setup: {
        mode: 'identity',
        generalChoices: 1,
        players: Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, nickname: `玩家${index}`, isHuman: false })),
      },
    })
    for (const name of ['PlayBegin', 'TurnStart'] as const) {
      game.events.on(name, (context) => {
        const built = buildPresentationEvent(game.state, context.event)
        if (built) events.push(built)
      })
    }
    game.dealGenerals()
    for (const request of [...game.state.pendingRequests]) {
      if (request.kind !== 'choose-general') continue
      game.respond({ requestId: request.id, playerId: request.playerId, payload: { characterId: request.candidates[0] } })
    }
    game.start()

    expect(events[0]?.kind, '第一条表现事件').toBe('game-start')
    expect(effectForPresentation(events[0])).toBe('game-start')
    // 而且只响一次
    expect(events.filter((event) => event.kind === 'game-start')).toHaveLength(1)
  })

  /*
   * 开局音**不能被去重逻辑吃掉**。
   *
   * `prepare()` 会把挂载时已有的表现事件全标记成「已处理」，免得重连回到
   * 打了一半的牌局时把历史事件重播一遍。但开局音恰好就在那批初始事件里——
   * 牌局是 `game.start()` 开起来的，表格挂载时它已经在流里了。
   * 少了这一条补偿，开局音一次都响不出来（实际踩到过）。
   */
  it('prepare 收到含开局事件的初始批次时会补放开局音', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/sanguosha/composables/useSgsAudio.ts'), 'utf8')
    const prepare = source.slice(source.indexOf('function prepare('), source.indexOf('function stop('))
    expect(prepare).toContain("existing.some((event) => event.kind === 'game-start')")
    expect(prepare).toContain("play('game-start')")
  })

  it('只保留已有 MP3 的流程音，浏览器合成流程音全部静音', () => {
    const event = (kind: PresentationEvent['kind']): PresentationEvent => ({ id: kind, seq: 1, kind, text: kind })
    expect(effectForPresentation(event('turn-start'))).toBeNull()
    expect(effectForPresentation(event('recover'))).toBe('recover')
    expect(effectForPresentation(event('dying'))).toBe('dying')
    expect(effectForPresentation(event('death'))).toBe('death')
    expect(effectForPresentation(event('skill'))).toBeNull()
    expect(effectForPresentation(event('draw'))).toBeNull()
    expect(effectForPresentation(event('discard'))).toBeNull()
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/sanguosha/composables/useSgsAudio.ts'), 'utf8')
    expect(source).not.toContain('createOscillator')
    expect(source).not.toContain('createBiquadFilter')
  })
})

describe('麻将录制音频', () => {
  it('只接入背景音乐、骰子和胜负结算，不接入发牌音', () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const directory = resolve(root, '../src/assets/audio')
    const files = readdirSync(directory).filter((name) => name.endsWith('.mp3')).sort()
    expect(files).toEqual(['defeat.mp3', 'mahjong-bgm.mp3', 'mahjong-dice.mp3', 'victory.mp3'])
    const source = readFileSync(resolve(root, '../src/composables/useGameAudio.ts'), 'utf8')
    for (const file of files) expect(source, file).toContain(`assets/audio/${file}`)
    expect(source).not.toContain('deal.mp3')
    expect(source).not.toContain("playEffect('button')")
    expect(source).not.toContain("playEffect('turn')")
    expect(source).not.toContain("playEffect('countdown')")
    for (const effect of ['draw', 'discard', 'peng', 'gang']) expect(source).toContain(`effect === '${effect}'`)
    for (const file of files) expect(statSync(resolve(directory, file)).size, file).toBeGreaterThan(0)
  })
})
