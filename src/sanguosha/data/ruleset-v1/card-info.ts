/**
 * 牌的效果说明。
 *
 * 和武将技能同一个原则：**说明只写一份，规则页直接读它**，不另外维护副本。
 * 写在这里而不是引擎里，是因为它纯粹是给人看的文本，引擎一行都不读。
 *
 * `tests/sanguosha-card-info.test.ts` 守着两条：
 * 牌堆里的每张牌都要有说明，说明里也不能出现牌堆里没有的牌——
 * 否则规则页迟早和实现对不上，那正是任务书点名禁止的情况。
 */

export interface CardInfo {
  name: string
  description: string
}

export const BASIC_CARD_INFO: readonly CardInfo[] = [
  { name: '杀', description: '出牌阶段对攻击范围内的一名角色使用，目标需打出【闪】，否则受到 1 点伤害。每回合限一张。' },
  { name: '闪', description: '被【杀】或【万箭齐发】指定为目标时打出，抵消其效果。' },
  { name: '桃', description: '出牌阶段对自己使用回复 1 点体力；也可以在任何角色濒死时对其使用。' },
  { name: '酒', description: '出牌阶段限一次，令本回合下一张【杀】伤害 +1；濒死时对自己使用可回复 1 点体力。' },
] as const

export const TRICK_CARD_INFO: readonly CardInfo[] = [
  { name: '无中生有', description: '摸两张牌。' },
  { name: '无懈可击', description: '抵消一张锦囊牌的效果，或抵消另一张【无懈可击】。' },
  { name: '桃园结义', description: '所有存活角色各回复 1 点体力。' },
  { name: '五谷丰登', description: '亮出等同存活人数的牌，从你开始每人依次选走一张。' },
  { name: '南蛮入侵', description: '其他所有角色需打出【杀】，否则受到 1 点伤害。' },
  { name: '万箭齐发', description: '其他所有角色需打出【闪】，否则受到 1 点伤害。' },
  { name: '决斗', description: '与目标轮流打出【杀】，先打不出的一方受到 1 点伤害。' },
  { name: '过河拆桥', description: '弃置一名其他角色的一张牌，不受距离限制。' },
  { name: '顺手牵羊', description: '获得距离 1 以内一名其他角色的一张牌。' },
  { name: '借刀杀人', description: '令一名装备了武器的角色对你指定的另一名角色使用【杀】，否则他将武器交给你。' },
  { name: '火攻', description: '目标展示一张手牌，你弃置一张同花色的手牌即可对其造成 1 点火焰伤害。' },
  { name: '铁索连环', description: '横置或重置一至两名角色；也可以重铸——弃掉它并摸一张牌。' },
  { name: '乐不思蜀', description: '延时锦囊。目标判定，非红桃则跳过其出牌阶段。' },
  { name: '兵粮寸断', description: '延时锦囊。目标判定，非草花则跳过其摸牌阶段。' },
  { name: '闪电', description: '延时锦囊。判定为黑桃 2~9 则受到 3 点雷电伤害，否则移交下家。' },
] as const

export const EQUIPMENT_CARD_INFO: readonly CardInfo[] = [
  // 武器（括号里是攻击范围）
  { name: '诸葛连弩', description: '武器，范围 1。你使用【杀】没有次数限制。' },
  { name: '雌雄双股剑', description: '武器，范围 2。指定异性角色为【杀】的目标后，令其弃一张手牌，或你摸一张牌。' },
  { name: '寒冰剑', description: '武器，范围 2。你的【杀】造成伤害前，可以改为弃置目标的两张牌。' },
  { name: '青釭剑', description: '武器，范围 2。你使用【杀】无视目标的防具。' },
  { name: '古锭刀', description: '武器，范围 2。你对没有手牌的角色使用【杀】时伤害 +1。' },
  { name: '青龙偃月刀', description: '武器，范围 3。你的【杀】被【闪】抵消后，可以立即对同一目标再使用一张【杀】。' },
  { name: '丈八蛇矛', description: '武器，范围 3。你可以将两张手牌当作一张【杀】使用。' },
  { name: '贯石斧', description: '武器，范围 3。你的【杀】被【闪】抵消后，可以弃置两张牌令其依然造成伤害。' },
  { name: '朱雀羽扇', description: '武器，范围 4。你可以将普通【杀】当作火【杀】使用。' },
  { name: '方天画戟', description: '武器，范围 4。你的最后一张手牌当【杀】使用时，可以指定至多三名角色。' },
  { name: '麒麟弓', description: '武器，范围 5。你的【杀】造成伤害后，可以弃置目标装备区里的一匹坐骑。' },
  // 防具
  { name: '八卦阵', description: '防具。需要打出【闪】时可以改为判定，红色即视为打出了【闪】。' },
  { name: '仁王盾', description: '防具。黑色的【杀】对你无效。' },
  { name: '藤甲', description: '防具。普通【杀】、【南蛮入侵】、【万箭齐发】对你无效，但你受到的火焰伤害 +1。' },
  { name: '白银狮子', description: '防具。你每次受到的伤害至多为 1；失去它时回复 1 点体力。' },
  // 坐骑
  { name: '赤兔', description: '进攻马。你计算与其他角色的距离时减 1。' },
  { name: '大宛', description: '进攻马。你计算与其他角色的距离时减 1。' },
  { name: '紫骍', description: '进攻马。你计算与其他角色的距离时减 1。' },
  { name: '绝影', description: '防御马。其他角色计算与你的距离时加 1。' },
  { name: '的卢', description: '防御马。其他角色计算与你的距离时加 1。' },
  { name: '爪黄飞电', description: '防御马。其他角色计算与你的距离时加 1。' },
  { name: '骅骝', description: '防御马。其他角色计算与你的距离时加 1。' },
] as const

/** 规则页按这个顺序分组展示。 */
export const CARD_INFO_SECTIONS: ReadonlyArray<{ title: string; cards: readonly CardInfo[] }> = [
  { title: '基本牌', cards: BASIC_CARD_INFO },
  { title: '锦囊牌', cards: TRICK_CARD_INFO },
  { title: '装备牌', cards: EQUIPMENT_CARD_INFO },
] as const

export const ALL_CARD_INFO: readonly CardInfo[] = [
  ...BASIC_CARD_INFO,
  ...TRICK_CARD_INFO,
  ...EQUIPMENT_CARD_INFO,
] as const
