import { describe, expect, it } from 'vitest'
import { runSoakGame } from '@/sanguosha/ai/soak'

/**
 * 一将成名 2012 第三批 / FINAL 的定向压测，外加**全 12 人**的合并压测。
 *
 * 通用压测从全部武将里随机取阵容，新武将被抽中的概率很低——
 * 「几百局没崩」证明不了他们的技能真的跑过。这里把阵容按住，
 * 让每一局都必然有他们在场，然后按计数器确认技能确实被发动过。
 */

const BATCH_THREE = ['handang', 'bulianshi', 'liubiao', 'huaxiong']
const ALL_TWELVE = [
  'caozhang', 'zhonghui', 'xunyou', 'wangyi',
  'liaohua', 'guanxingzhangbao', 'madai', 'chengpu',
  'handang', 'bulianshi', 'liubiao', 'huaxiong',
]

function runBatch(count: number, playerCount: number, prefix: string, cast: string[]) {
  const filler = ['zhangfei', 'guanyu', 'zhaoyun', 'machao', 'huangzhong', 'sunshangxiang', 'caopi', 'zhenji']
  const characterIds = [...cast]
  while (characterIds.length < playerCount) characterIds.push(filler[characterIds.length - cast.length])
  const results = []
  for (let index = 0; index < count; index += 1) {
    results.push(runSoakGame({
      seed: `${prefix}-${playerCount}-${index}`,
      playerCount,
      characterIds: characterIds.slice(0, playerCount),
    }))
  }
  return results
}

const total = (results: ReturnType<typeof runBatch>, key: string): number =>
  results.reduce((sum, result) => sum + (result.counters[key] ?? 0), 0)

describe('一将成名 2012 第三批压测', () => {
  it('五人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 5, 'yjcm12b3', BATCH_THREE)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('八人局 160 局全部正常结束', () => {
    for (const result of runBatch(160, 8, 'yjcm12b3', BATCH_THREE)) {
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 300_000)

  it('重点混合阵容各 40 局全部正常结束', () => {
    const lineups: Array<[string, string[]]> = [
      // 步练师 × 法正：安恤的转移必须记对「从谁那里得到的」
      ['anxu-enyuan', ['bulianshi', 'fazheng', 'zhangfei', 'zhaoyun']],
      // 步练师 × 曹丕：两个死亡后技能的先后
      ['zhuiyi-xingshang', ['bulianshi', 'caopi', 'guanyu', 'machao']],
      // 刘表 × 廖化：共用的势力计数器 + 两种改阶段的效果
      ['liubiao-liaohua', ['liubiao', 'liaohua', 'zhaoyun', 'huangzhong']],
      // 刘表 × 多势力神将：势力数一路往下掉
      ['liubiao-kingdoms', ['liubiao', 'shenzhaoyun', 'caocao', 'sunquan']],
      // 华雄 × 程普：红色火【杀】
      ['huaxiong-chengpu', ['huaxiong', 'chengpu', 'zhangfei', 'guanyu']],
      // 华雄 × 马岱：颜色禁令只管使用和打出，不影响伤害后的触发
      ['huaxiong-madai', ['huaxiong', 'madai', 'zhaoyun', 'machao']],
      // 华雄 × 徐庶：无言防止的伤害根本走不到「伤害后」
      ['huaxiong-xushu', ['huaxiong', 'xushu', 'huangzhong', 'caopi']],
      // 韩当 × 程普：两条回合级的杀修正叠在一起
      ['handang-chengpu', ['handang', 'chengpu', 'zhangfei', 'zhaoyun']],
      // 韩当 × 关兴张苞：弓骑的 +1 次和咆哮的无限次聚合
      ['handang-gxzb', ['handang', 'guanxingzhangbao', 'guanyu', 'machao']],
      // 韩当 × 高顺：陷阵的定向次数豁免 + 禁酒
      ['handang-gaoshun', ['handang', 'gaoshun', 'huangzhong', 'zhenji']],
    ]
    for (const [name, cast] of lineups) {
      for (const result of runBatch(40, cast.length + 1, `mix12b3-${name}`, cast)) {
        expect(result.finished || result.stalemate, `${name} seed=${result.seed} 没有正常结束`).toBe(true)
      }
    }
  }, 600_000)

  it('四个人的技能确实被跑到了，不是空过', () => {
    const results = runBatch(120, 6, 'yjcm12b3-cover', BATCH_THREE)
    expect(total(results, 'skill:gongqi'), '弓骑至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:jiefan'), '解烦至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:anxu'), '安恤至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zhuiyi'), '追忆至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:zishou'), '自守至少被发动过一次').toBeGreaterThan(0)
    expect(total(results, 'skill:yaowu'), '耀武至少被触发过一次').toBeGreaterThan(0)
    // 宗室是锁定技，不发 SkillActivated，覆盖由单元测试盯
  }, 300_000)
})

/**
 * 按下标轮转取 `size` 个人。
 *
 * **不能直接 `ALL_TWELVE.slice(0, playerCount)`**：那样八人局永远只坐前八个，
 * 第三批四个人一局都上不了场——合并压测就成了「批一批二再跑一遍」。
 */
function rotate(offset: number, size: number): string[] {
  return Array.from({ length: size }, (_, index) => ALL_TWELVE[(offset + index) % ALL_TWELVE.length])
}

describe('一将成名 2012 全 12 人合并压测', () => {
  it('八人局 200 局全部正常结束（每局轮转取八人）', () => {
    for (let index = 0; index < 200; index += 1) {
      const [result] = runBatch(1, 8, `yjcm12all-r${index}`, rotate(index, 8))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('五人局 120 局全部正常结束（每局轮转取五人）', () => {
    for (let index = 0; index < 120; index += 1) {
      const [result] = runBatch(1, 5, `yjcm12all-sub${index}`, rotate(index, 5))
      expect(result.finished || result.stalemate, `seed=${result.seed} 没有正常结束`).toBe(true)
    }
  }, 600_000)

  it('12 个人的技能在合并压测里都真的跑过', () => {
    const results = []
    for (let index = 0; index < 200; index += 1) {
      results.push(...runBatch(1, 8, `yjcm12all-cov${index}`, rotate(index, 8)))
    }
    /*
     * 一次点名 12 个人的代表技能。任何一个为 0 都说明那个人
     * 在合并压测里根本没上过场（或者技能一次都没发动过），
     * 那时「全 12 人合并压测通过」就是句空话。
     */
    for (const [skillId, name] of [
      ['jiangchi', '将驰'], ['quanji', '权计'], ['qice', '奇策'], ['zhenlie', '贞烈'],
      ['dangxian', '当先'], ['fuhun', '父魂'], ['qianxi', '潜袭'], ['chunlao', '醇醪'],
      ['gongqi', '弓骑'], ['anxu', '安恤'], ['zishou', '自守'], ['yaowu', '耀武'],
    ] as Array<[string, string]>) {
      expect(total(results, `skill:${skillId}`), `【${name}】在合并压测里一次都没跑过`).toBeGreaterThan(0)
    }
  }, 900_000)
})
