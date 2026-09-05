import { effectiveCardColor, registerSkillRuntime, type ViewAsOption } from '../../engine/skills/runtime'
import type { CardId, PlayerId, SanguoshaState } from '../../engine/types'
import type { CharacterDefinition } from './types'

/**
 * 林包。**技能文本为本项目自研表述**，* 每个技能的行为以本文件的注释为准。
 *
 * 本文件只放「技能本体足够短、不需要独立状态机」的武将；
 * 需要多步发问或公共机制的（孟获【再起】、祝融、孙坚）各自一个文件。
 */

function playerOf(state: SanguoshaState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.id === playerId)
  if (!found) throw new Error(`玩家不存在：${playerId}`)
  return found
}

// ─────────────────────────────── 徐晃【断粮】 ───────────────────────────────

export const DUANLIANG = 'duanliang'

/**
 * 【断粮】首版原文：
 * 「出牌阶段，你可以将一张黑色的基本牌或装备牌当【兵粮寸断】使用；
 *   你可以对与你距离 2 以内的角色使用【兵粮寸断】。」
 *
 * 两半都**只**通过公共入口表达，引擎主干里不出现 duanliang 或 xuhuang：
 *
 * - 前半是普通转化技，走 `viewAs`。转化出来的【兵粮寸断】此后完全是一张
 *   正常的延时锦囊：判定区唯一性、无懈、改判、跳过摸牌阶段、结算后进弃牌堆，
 *   全部由公共卡牌规则负责，这里一行都不重复实现。
 * - 后半是距离修正，走 `trickDistanceBonus`。【兵粮寸断】的基础距离是 1，
 *   所以加 1 之后正好是「距离 2 以内」。**不是无距离限制**——那是界徐晃。
 *
 * 牌源同时包含手牌区和装备区：技能文本只说「一张黑色的基本牌或装备牌」，
 * 没有限定手牌，就不能擅自只允许手牌。装备区的牌离场时仍然经过统一的
 * 「失去装备」时机（枭姬、白银狮子照常触发），那一步在 `cards/basic.ts`。
 *
 * 「黑色」读 `effectiveCardColor` 而不是 `card.color`：花色修正（小乔【红颜】
 * 这类）必须对断粮同样生效，项目里的花色只有这一个口径。
 */
registerSkillRuntime({
  id: DUANLIANG,
  viewAs(state, ownerId): ViewAsOption[] {
    const owner = playerOf(state, ownerId)
    const sources: CardId[] = [
      ...owner.zones.hand,
      ...Object.values(owner.zones.equipment).filter((cardId): cardId is CardId => Boolean(cardId)),
    ]
    const options: ViewAsOption[] = []
    for (const cardId of sources) {
      const card = state.cards[cardId]
      if (!card) continue
      // 锦囊牌不行，只有基本牌和装备牌
      if (card.category !== 'basic' && card.category !== 'equipment') continue
      if (effectiveCardColor(state, ownerId, cardId) !== 'black') continue
      options.push({ asCardName: '兵粮寸断', cardId, label: `将【${card.name}】当【兵粮寸断】使用` })
    }
    return options
  },
  trickDistanceBonus(_state, _ownerId, _targetId, cardName) {
    return cardName === '兵粮寸断' ? 1 : 0
  },
})

// 孟获两个技能都要接公共机制（牌效果无效、伤害来源改写、摸牌阶段替代），单独一个文件
import { MENGHUO } from './forest-menghuo'
// 祝融复用同一个「牌效果无效」，另加「结算后实体牌归属」和公共拼点
import { ZHURONG } from './forest-zhurong'
// 孙坚是多步发问：发动 → 选目标 → 选模式 → 摸 → 弃，状态全部可序列化
import { SUNJIAN } from './forest-sunjian'
// 鲁肃两个技能都在搬牌：给牌和原子换手牌都走 engine/hand-transfer.ts
import { LUSU } from './forest-lusu'
// 曹丕：行殇接死亡牌认领，放逐复用曹仁那套翻面，颂威挂在判定结果上
import { CAOPI } from './forest-caopi'
// 董卓：酒池是转化技，肉林接条件式闪数，崩坏用公共的减上限，暴虐走统一判定
import { DONGZHUO } from './forest-dongzhuo'
// 贾诩：完杀接使用禁止，帷幕接目标禁止，乱武是可序列化的多人依次结算
import { JIAXU } from './forest-jiaxu'

export const FOREST_CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: 'xuhuang',
    name: '徐晃',
    kingdom: 'wei',
    gender: 'male',
    maxHp: 4,
    pack: 'forest',
    skills: [{
      id: DUANLIANG,
      name: '断粮',
      description: '你可以将一张黑色的基本牌或装备牌当【兵粮寸断】使用；你可以对与你距离 2 以内的角色使用【兵粮寸断】。',
    }],
  },
  MENGHUO,
  ZHURONG,
  SUNJIAN,
  LUSU,
  CAOPI,
  DONGZHUO,
  JIAXU,
] as const
