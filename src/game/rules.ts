// 规则文案。牌桌页和设置页都要用，放在这里免得两边各存一份、改了一处忘另一处。
export interface RuleSection {
  group: string
  items: Array<{ title: string; text: string }>
}

export const RULE_SECTIONS: RuleSection[] = [
  {
    group: '怎么算胡',
    items: [
      { title: '只能自摸', text: '别人打出的牌不能胡，只能自己摸上来。' },
      { title: '红中万能', text: '红中当任何牌用，但不能被碰、被杠。' },
      { title: '七对', text: '七个对子也算胡，前提是没有碰过、杠过。' },
    ],
  },
  {
    group: '怎么算分',
    items: [
      { title: '自摸', text: '三家各付 1 分。' },
      { title: '抓码', text: '固定六码。有红中抓 4 张，无红中抓 6 张；1、5、9 和红中算中码，每中一张三家再各付 1 分。' },
      { title: '杠', text: '暗杠、补杠三家各付 1 分；明杠只有点杠的人付 1 分。杠分当场结算。' },
      { title: '付不起', text: '余额不足时最多付到 0，欠的部分不再追。' },
    ],
  },
  {
    group: '怎么操作',
    items: [
      { title: '抢牌窗口', text: '每次出牌都开一个窗口，你可以碰、杠或过。到点没动作按过处理。' },
      { title: '不会撞车', text: '同一张牌最多只有一家能碰或杠，不存在谁先点谁抢到。' },
      { title: '补杠', text: '刚碰完手上还有第四张，可以直接补杠；暗杠要摸牌后才能开。' },
      { title: '坐庄', text: '投骰最大的先坐庄，之后谁胡谁坐庄，流局留庄。庄家不加倍。' },
    ],
  },
]
