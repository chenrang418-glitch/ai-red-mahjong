import type { CharacterDefinition } from './types'
import { YUANSHU } from './sp-yuanshu'
import { YANGXIU } from './sp-yangxiu'
import { CHENLIN } from './sp-chenlin'
import { ZHANGXINGCAI } from './sp-zhangxingcai'
import { GUANYINPING } from './sp-guanyinping'
import { CAOANG } from './sp-caoang'
import { HETAIHOU } from './sp-hetaihou'
import { LIUXIE } from './sp-liuxie'
import { MAYUNLU } from './sp-mayunlu'
import { MIZHU } from './sp-mizhu'

/**
 * SP：项目此前未出现过的独立历史人物，采用三国杀 OL 经典/成熟身份技能版本。
 * 不含界限突破、国战、谋/势/星、SP 同人物重复版本、十周年重做、旧版淘汰技能。
 *
 * 本批 10 / 10：袁术、杨修、陈琳、张星彩、关银屏、曹昂、何太后、刘协、
 * 马云騄、糜竺。
 */
export const SP_CHARACTERS: readonly CharacterDefinition[] = [
  YUANSHU,
  YANGXIU,
  CHENLIN,
  ZHANGXINGCAI,
  GUANYINPING,
  CAOANG,
  HETAIHOU,
  LIUXIE,
  MAYUNLU,
  MIZHU,
] as const
