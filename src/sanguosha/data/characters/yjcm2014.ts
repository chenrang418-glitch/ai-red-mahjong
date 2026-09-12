import type { CharacterDefinition } from './types'
import { CAOZHEN } from './yjcm2014-caozhen'
import { CHENQUN } from './yjcm2014-chenqun'
import { HANHAO_SHIHUAN } from './yjcm2014-hanhaoshihuan'
import { WUYI } from './yjcm2014-wuyi'
import { ZHOUCANG } from './yjcm2014-zhoucang'
import { ZHANGSONG } from './yjcm2014-zhangsong'
import { SUNLUBAN } from './yjcm2014-sunluban'
import { ZHUHUAN } from './yjcm2014-zhuhuan'
import { GUYONG } from './yjcm2014-guyong'

/**
 * 一将成名 2014。
 *
 * 采用「一将成名经典成熟版 / 当前官网经典形象」；不混入界限突破、国战、
 * 谋 / 势 / 星、移动版强化、十周年重做或斗地主特殊版本。玩法表述和版本锁
 * 记录在 `docs/sanguosha-ruleset-v1.md` 的 YJCM2014 一节。
 *
 * 本批 9 / 11：剩余蔡夫人、沮授未实现。
 */
export const YJCM2014_CHARACTERS: readonly CharacterDefinition[] = [
  CAOZHEN,
  CHENQUN,
  HANHAO_SHIHUAN,
  WUYI,
  ZHOUCANG,
  ZHANGSONG,
  SUNLUBAN,
  ZHUHUAN,
  GUYONG,
] as const
