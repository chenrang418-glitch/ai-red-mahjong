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

export const GOD_CHARACTERS: readonly CharacterDefinition[] = [
  SHENGUANYU,
] as const
