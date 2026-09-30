export const SGS_TUTORIAL_KEY = 'crplay.sanguosha.tutorial-v1'

export const SGS_TUTORIAL_STEPS = [
  { target: 'hand', title: '你的手牌', text: '点击手牌选中它；能使用的牌会保持明亮。' },
  { target: 'self', title: '角色状态', text: '这里能看到你的体力、身份、技能和装备。' },
  { target: 'details', title: '角色详情', text: '手机上点击角色右下角的“详”，可以集中查看武将信息、技能、装备与其他公开状态。' },
  { target: 'dock', title: '操作面板', text: '需要响应或选择目标时，按钮都会集中在下方。' },
  { target: 'log', title: '查看战报', text: '错过刚才发生的事，可以随时打开右上角战报。' },
  { target: 'dock', title: '结束出牌', text: '没有牌要出时，在操作面板选择结束出牌或放弃。' },
] as const
