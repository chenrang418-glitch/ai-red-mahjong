import type { CharacterDefinition } from './types'

/**
 * 山包（神话再临·山）。**一律采用首版实体扩展的技能文本**，
 * 不混入界限突破、谋攻篇、星将、OL、十周年或移动版改动。
 *
 * 山包的武将技能普遍需要独立状态机（巧变的阶段窗口、屯田的判定链、
 * 挑衅的求杀、放权的额外回合），所以每名武将各自一个文件，
 * 这里只做汇总；不像林包那样留一个「短技能合住」的公共文件。
 */

// 张郃：巧变走公共 offerPhaseSkip 窗口 + 公共 field-move
import { ZHANGHE } from './mountain-zhanghe'
// 邓艾：田用公共 characterPiles，凿险用公共 awakening，急袭用专属牌堆 ViewAs
import { DENGAI } from './mountain-dengai'

export const MOUNTAIN_CHARACTERS: readonly CharacterDefinition[] = [
  ZHANGHE,
  DENGAI,
] as const
