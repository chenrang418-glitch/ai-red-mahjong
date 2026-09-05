import { RULESET_VERSION, type CardCategory, type DamageNature, type EquipmentSlot, type PhysicalCard, type Rank, type Suit } from '../../engine/types'

/**
 * ruleset-v1 精确牌表。
 *
 * 本项目自研的牌堆组成：标准 108 张 + 军争 52 张，共 160 张。
 * 逐张花色与点数由测试验证，改动这里必须同步改测试。
 */
type Entry = readonly [name: string, suit: Suit, rank: Rank, nature?: DamageNature]

const STANDARD: readonly Entry[] = [
  ['桃园结义', 'heart', 1], ['万箭齐发', 'heart', 1], ['闪', 'heart', 2], ['闪', 'heart', 2],
  ['桃', 'heart', 3], ['五谷丰登', 'heart', 3], ['桃', 'heart', 4], ['五谷丰登', 'heart', 4],
  ['麒麟弓', 'heart', 5], ['赤兔', 'heart', 5], ['桃', 'heart', 6], ['乐不思蜀', 'heart', 6],
  ['桃', 'heart', 7], ['无中生有', 'heart', 7], ['桃', 'heart', 8], ['无中生有', 'heart', 8],
  ['桃', 'heart', 9], ['无中生有', 'heart', 9], ['杀', 'heart', 10], ['杀', 'heart', 10],
  ['杀', 'heart', 11], ['无中生有', 'heart', 11], ['桃', 'heart', 12], ['过河拆桥', 'heart', 12],
  ['闪电', 'heart', 12], ['闪', 'heart', 13], ['爪黄飞电', 'heart', 13],

  ['决斗', 'spade', 1], ['闪电', 'spade', 1], ['雌雄双股剑', 'spade', 2], ['八卦阵', 'spade', 2],
  ['寒冰剑', 'spade', 2], ['过河拆桥', 'spade', 3], ['顺手牵羊', 'spade', 3], ['过河拆桥', 'spade', 4],
  ['顺手牵羊', 'spade', 4], ['青龙偃月刀', 'spade', 5], ['绝影', 'spade', 5], ['乐不思蜀', 'spade', 6],
  ['青釭剑', 'spade', 6], ['杀', 'spade', 7], ['南蛮入侵', 'spade', 7], ['杀', 'spade', 8],
  ['杀', 'spade', 8], ['杀', 'spade', 9], ['杀', 'spade', 9], ['杀', 'spade', 10],
  ['杀', 'spade', 10], ['顺手牵羊', 'spade', 11], ['无懈可击', 'spade', 11], ['过河拆桥', 'spade', 12],
  ['丈八蛇矛', 'spade', 12], ['南蛮入侵', 'spade', 13], ['大宛', 'spade', 13],

  ['诸葛连弩', 'diamond', 1], ['决斗', 'diamond', 1], ['闪', 'diamond', 2], ['闪', 'diamond', 2],
  ['闪', 'diamond', 3], ['顺手牵羊', 'diamond', 3], ['闪', 'diamond', 4], ['顺手牵羊', 'diamond', 4],
  ['闪', 'diamond', 5], ['贯石斧', 'diamond', 5], ['杀', 'diamond', 6], ['闪', 'diamond', 6],
  ['杀', 'diamond', 7], ['闪', 'diamond', 7], ['杀', 'diamond', 8], ['闪', 'diamond', 8],
  ['杀', 'diamond', 9], ['闪', 'diamond', 9], ['杀', 'diamond', 10], ['闪', 'diamond', 10],
  ['闪', 'diamond', 11], ['闪', 'diamond', 11], ['桃', 'diamond', 12], ['方天画戟', 'diamond', 12],
  ['无懈可击', 'diamond', 12], ['杀', 'diamond', 13], ['紫骍', 'diamond', 13],

  ['决斗', 'club', 1], ['诸葛连弩', 'club', 1], ['杀', 'club', 2], ['八卦阵', 'club', 2],
  ['仁王盾', 'club', 2], ['杀', 'club', 3], ['过河拆桥', 'club', 3], ['杀', 'club', 4],
  ['过河拆桥', 'club', 4], ['杀', 'club', 5], ['的卢', 'club', 5], ['杀', 'club', 6],
  ['乐不思蜀', 'club', 6], ['杀', 'club', 7], ['南蛮入侵', 'club', 7], ['杀', 'club', 8],
  ['杀', 'club', 8], ['杀', 'club', 9], ['杀', 'club', 9], ['杀', 'club', 10],
  ['杀', 'club', 10], ['杀', 'club', 11], ['杀', 'club', 11], ['借刀杀人', 'club', 12],
  ['无懈可击', 'club', 12], ['借刀杀人', 'club', 13], ['无懈可击', 'club', 13],
]

const MANEUVERING: readonly Entry[] = [
  ['无懈可击', 'heart', 1], ['火攻', 'heart', 2], ['火攻', 'heart', 3], ['杀', 'heart', 4, 'fire'],
  ['桃', 'heart', 5], ['桃', 'heart', 6], ['杀', 'heart', 7, 'fire'], ['闪', 'heart', 8],
  ['闪', 'heart', 9], ['杀', 'heart', 10, 'fire'], ['闪', 'heart', 11], ['闪', 'heart', 12],
  ['无懈可击', 'heart', 13],

  ['白银狮子', 'club', 1], ['藤甲', 'club', 2], ['酒', 'club', 3], ['兵粮寸断', 'club', 4],
  ['杀', 'club', 5, 'thunder'], ['杀', 'club', 6, 'thunder'], ['杀', 'club', 7, 'thunder'], ['杀', 'club', 8, 'thunder'],
  ['酒', 'club', 9], ['铁索连环', 'club', 10], ['铁索连环', 'club', 11], ['铁索连环', 'club', 12],
  ['铁索连环', 'club', 13],

  ['古锭刀', 'spade', 1], ['藤甲', 'spade', 2], ['酒', 'spade', 3], ['杀', 'spade', 4, 'thunder'],
  ['杀', 'spade', 5, 'thunder'], ['杀', 'spade', 6, 'thunder'], ['杀', 'spade', 7, 'thunder'], ['杀', 'spade', 8, 'thunder'],
  ['酒', 'spade', 9], ['兵粮寸断', 'spade', 10], ['铁索连环', 'spade', 11], ['铁索连环', 'spade', 12],
  ['无懈可击', 'spade', 13],

  ['朱雀羽扇', 'diamond', 1], ['桃', 'diamond', 2], ['桃', 'diamond', 3], ['杀', 'diamond', 4, 'fire'],
  ['杀', 'diamond', 5, 'fire'], ['闪', 'diamond', 6], ['闪', 'diamond', 7], ['闪', 'diamond', 8],
  ['酒', 'diamond', 9], ['闪', 'diamond', 10], ['闪', 'diamond', 11], ['火攻', 'diamond', 12],
  ['骅骝', 'diamond', 13],
]

const BASIC = new Set(['杀', '闪', '桃', '酒'])
const WEAPON_RANGES: Readonly<Record<string, number>> = {
  诸葛连弩: 1, 雌雄双股剑: 2, 寒冰剑: 2, 青釭剑: 2, 古锭刀: 2,
  青龙偃月刀: 3, 丈八蛇矛: 3, 贯石斧: 3, 朱雀羽扇: 4, 方天画戟: 4, 麒麟弓: 5,
}
const ARMORS = new Set(['八卦阵', '仁王盾', '藤甲', '白银狮子'])
const OFFENSIVE_HORSES = new Set(['赤兔', '大宛', '紫骍'])
const DEFENSIVE_HORSES = new Set(['绝影', '的卢', '爪黄飞电', '骅骝'])

function equipmentSlot(name: string): EquipmentSlot | undefined {
  if (name in WEAPON_RANGES) return 'weapon'
  if (ARMORS.has(name)) return 'armor'
  if (OFFENSIVE_HORSES.has(name)) return 'offensiveHorse'
  if (DEFENSIVE_HORSES.has(name)) return 'defensiveHorse'
  return undefined
}

function category(name: string): CardCategory {
  if (BASIC.has(name)) return 'basic'
  return equipmentSlot(name) ? 'equipment' : 'trick'
}

function makeCard(entry: Entry, expansion: PhysicalCard['expansion'], index: number): PhysicalCard {
  const [name, suit, rank, nature] = entry
  const slot = equipmentSlot(name)
  return {
    id: `${RULESET_VERSION}:${expansion}:${index}`,
    ruleset: RULESET_VERSION,
    expansion,
    name,
    suit,
    rank,
    color: suit === 'heart' || suit === 'diamond' ? 'red' : 'black',
    category: category(name),
    ...(nature ? { damageNature: nature } : {}),
    ...(slot ? { equipmentSlot: slot } : {}),
    ...(name in WEAPON_RANGES ? { attackRange: WEAPON_RANGES[name] } : {}),
  }
}

export function createRulesetV1Deck(): PhysicalCard[] {
  return [
    ...STANDARD.map((entry, index) => makeCard(entry, 'standard', index)),
    ...MANEUVERING.map((entry, index) => makeCard(entry, 'maneuvering', index)),
  ]
}

export const rulesetV1DeckSize = { standard: STANDARD.length, maneuvering: MANEUVERING.length, total: STANDARD.length + MANEUVERING.length } as const
