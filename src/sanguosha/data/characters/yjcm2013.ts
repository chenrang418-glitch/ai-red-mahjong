import type { CharacterDefinition } from './types'
import { GUOHUAI } from './yjcm2013-guohuai'
import { MANCHONG } from './yjcm2013-manchong'
import { CAOCHONG } from './yjcm2013-caochong'
import { GUANPING } from './yjcm2013-guanping'
import { JIANYONG } from './yjcm2013-jianyong'
import { LIUFENG } from './yjcm2013-liufeng'
import { PANZHANG_MAZHONG } from './yjcm2013-panzhangmazhong'
import { ZHURAN } from './yjcm2013-zhuran'
import { YUFAN } from './yjcm2013-yufan'
import { LIRU } from './yjcm2013-liru'

/**
 * 一将成名 2013。
 *
 * 采用「一将成名 2013 经典成熟版」；曹冲、李儒、朱然采用 2014 官方对
 * 「一将成名 2013」平衡调整后的成熟版，不实现 2013 初版已淘汰的技能文本。
 * 玩法表述和版本锁记录在 `docs/sanguosha-ruleset-v1.md` 的 YJCM2013 一节。
 *
 * 本批 10 / 11：剩余伏皇后未实现。
 */
export const YJCM2013_CHARACTERS: readonly CharacterDefinition[] = [
  GUOHUAI,
  MANCHONG,
  CAOCHONG,
  GUANPING,
  JIANYONG,
  LIUFENG,
  PANZHANG_MAZHONG,
  ZHURAN,
  YUFAN,
  LIRU,
] as const
