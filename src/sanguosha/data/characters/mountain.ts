import type { CharacterDefinition } from './types'

/**
 * 山包。**技能文本为本项目自研表述**，* 每个技能的行为以本文件的注释为准。
 *
 * 山包的武将技能普遍需要独立状态机（巧变的阶段窗口、屯田的判定链、
 * 挑衅的求杀、放权的额外回合），所以每名武将各自一个文件，
 * 这里只做汇总；不像林包那样留一个「短技能合住」的公共文件。
 */

// 张郃：巧变走公共 offerPhaseSkip 窗口 + 公共 field-move
import { ZHANGHE } from './mountain-zhanghe'
// 邓艾：田用公共 characterPiles，凿险用公共 awakening，急袭用专属牌堆 ViewAs
import { DENGAI } from './mountain-dengai'
// 姜维：挑衅用公共 ask-use-slash，志继觉醒后复用标准诸葛亮的观星
import { JIANGWEI } from './mountain-jiangwei'
// 刘禅：放权复用公共 offerPhaseSkip + 新建的额外回合队列，若愚觉醒后复用刘备的激将
import { LIUSHAN } from './mountain-liushan'
// 孙策：激昂走标准目标事件，魂姿复用觉醒/动态技能，制霸复用公共拼点
import { SUNCE } from './mountain-sunce'
import { ZHANGZHAOZHANGHONG } from './mountain-zhangzhaozhanghong'
import { CAIWENJI } from './mountain-caiwenji'
import { ZUOCI } from './mountain-zuoci'

export const MOUNTAIN_CHARACTERS: readonly CharacterDefinition[] = [
  ZHANGHE,
  DENGAI,
  JIANGWEI,
  LIUSHAN,
  SUNCE,
  ZHANGZHAOZHANGHONG,
  CAIWENJI,
  ZUOCI,
] as const
