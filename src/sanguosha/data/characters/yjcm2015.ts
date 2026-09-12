import type { CharacterDefinition } from './types'
import { CAORUI } from './yjcm2015-caorui'
import { CAOXIU } from './yjcm2015-caoxiu'
import { ZHONGYAO } from './yjcm2015-zhongyao'
import { LIUCHEN } from './yjcm2015-liuchen'
import { XIAHOUSHI } from './yjcm2015-xiahoushi'
import { ZHANGNI } from './yjcm2015-zhangni'
import { SUNXIU } from './yjcm2015-sunxiu'
import { ZHUZHI } from './yjcm2015-zhuzhi'
import { QUANZONG } from './yjcm2015-quanzong'
import { GONGSUNYUAN } from './yjcm2015-gongsunyuan'
import { GUOTU_FENGJI } from './yjcm2015-guotu-fengji'

/**
 * 一将成名 2015。
 *
 * 采用「一将成名经典成熟版 / 三国杀OL 经典规则」；不混入界限突破、国战、
 * 谋 / 势 / 星、SP、移动版强化、十周年重做。玩法表述和版本锁记录在
 * `docs/sanguosha-ruleset-v1.md` 的 YJCM2015 一节。
 *
 * 11 / 11，本包已完成——一将成名 2011～2015 全系列到此收官。
 */
export const YJCM2015_CHARACTERS: readonly CharacterDefinition[] = [
  CAORUI,
  CAOXIU,
  ZHONGYAO,
  LIUCHEN,
  XIAHOUSHI,
  ZHANGNI,
  SUNXIU,
  ZHUZHI,
  QUANZONG,
  GONGSUNYUAN,
  GUOTU_FENGJI,
] as const
