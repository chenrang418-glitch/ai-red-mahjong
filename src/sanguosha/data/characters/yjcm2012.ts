import type { CharacterDefinition } from './types'
import { CAOZHANG } from './yjcm2012-caozhang'
import { GUANXING_ZHANGBAO } from './yjcm2012-guanxingzhangbao'
import { CHENGPU } from './yjcm2012-chengpu'
import { HANDANG } from './yjcm2012-handang'
import { MADAI } from './yjcm2012-madai'
import { LIAOHUA } from './yjcm2012-liaohua'
import { WANGYI } from './yjcm2012-wangyi'
import { XUNYOU } from './yjcm2012-xunyou'
import { ZHONGHUI } from './yjcm2012-zhonghui'

/**
 * 一将成名 2012。
 *
 * 这一包按**经典 / 代表性版本**推进，玩法表述和版本锁记录在
 * `docs/sanguosha-ruleset-v1.md` 的 YJCM2012 一节：
 * 每名武将实现哪几个技能、明确**不实现**哪些，都写在那里。
 * 要偏离那份文本，先改文档再改代码。
 *
 * 一个人写完、专项测试过了才加进这个数组——**不放空壳**。
 */
export const YJCM2012_CHARACTERS: readonly CharacterDefinition[] = [
  CAOZHANG,
  ZHONGHUI,
  XUNYOU,
  WANGYI,
  LIAOHUA,
  GUANXING_ZHANGBAO,
  MADAI,
  CHENGPU,
  HANDANG,
] as const
