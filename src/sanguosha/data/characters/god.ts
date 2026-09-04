import type { CharacterDefinition } from './types'

/**
 * 神将包（神话再临·神）。**一律采用经典版本**，
 * 不混入 OL 重做、移动版、十周年、手杀改版或谋 / 势 / 星 / 骥 版本。
 *
 * 神将按 24 名规划，**分批完成**：每一批都完整可玩、都过专项测试和压测，
 * 不允许先把 24 个空壳注册进池。当前为第一批。
 */

// 神关羽：武神走公共 viewAs + 按载体牌的免距离；武魂用公共 marks + 直接死亡入口
import { SHENGUANYU } from './god-shenguanyu'
// 神吕蒙：涉猎走「取消 DrawPhase」的摸牌阶段替代约定；攻心靠「请求只发给本人」实现看牌隐私
import { SHENLVMENG } from './god-shenlvmeng'
// 神周瑜：琴音复用弃牌溯源账本；业炎是限定技，火焰伤害走统一伤害管线
import { SHENZHOUYU } from './god-shenzhouyu'
// 神诸葛亮：七星用扣置专属牌堆（hiddenCharacterPiles），狂风/大雾用公共临时角色状态
import { SHENCAOCAO } from './god-shencaocao'
import { SHENLVBU } from './god-shenlvbu'
import { SHENSIMAYI } from './god-shensimayi'
import { SHENZHAOYUN } from './god-shenzhaoyun'
import { SHENZHUGELIANG } from './god-shenzhugeliang'

export const GOD_CHARACTERS: readonly CharacterDefinition[] = [
  SHENGUANYU,
  SHENLVMENG,
  SHENZHOUYU,
  SHENZHUGELIANG,
  SHENCAOCAO,
  SHENLVBU,
  SHENZHAOYUN,
  SHENSIMAYI,
] as const
