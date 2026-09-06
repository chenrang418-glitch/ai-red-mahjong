import type { CharacterDefinition } from './types'
import { CAOZHI } from './yjcm2011-caozhi'
import { FAZHENG } from './yjcm2011-fazheng'
import { YUJIN } from './yjcm2011-yujin'
import { ZHANGCHUNHUA } from './yjcm2011-zhangchunhua'

/**
 * 一将成名 2011。
 *
 * 这一包按**经典 / 代表性版本**推进，玩法表述和版本锁记录在
 * `docs/sanguosha-ruleset-v1.md` 的 YJCM2011 Version Lock 一节：
 * 每名武将实现哪几个技能、明确**不实现**哪些，都写在那里。
 * 要偏离那份文本，先改文档再改代码。
 *
 * 一个人写完、专项测试过了才加进这个数组——**不放空壳**。
 */
export const YJCM2011_CHARACTERS: readonly CharacterDefinition[] = [
  CAOZHI,
  YUJIN,
  ZHANGCHUNHUA,
  FAZHENG,
] as const
