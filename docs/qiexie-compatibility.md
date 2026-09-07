# 挈挟兼容性审计

本文件由 `npx vite-node scripts/qiexie-audit.mts` 生成，请勿手改。

神典韦【挈挟】把武将牌当武器装备时，会借用那张武将牌上的部分技能。
**资格只认结构化元数据**：技能定义里的 `qiexie` 字段，加上运行时的
觉醒 / 限定 / 主公 / 衍生标志。下面「描述提到杀」那一列只是给人看的线索，
运行时不解析任何中文描述——描述改一个字就改变行为的实现是脆的。

## 汇总

| 项 | 数量 |
|---|---|
| 武将总数 | 99 |
| 技能总数 | 207 |
| 可借用 | 7 |
| 声明了但被规则排除 | 0 |
| 描述提到【杀】但未声明 | 42 |
| **有资格却跑不起来** | **0** |

「有资格却跑不起来」必须是 0：那意味着规则上该能借的技能，实际借了没用。

## 可借用的技能

| 技能 | 武将 | 包 | 运行时可用 |
|---|---|---|---|
| 咆哮（paoxiao） | 张飞 | standard | 是 |
| 铁骑（tieji） | 马超 | standard | 是 |
| 武圣（wusheng） | 关羽 | standard | 是 |
| 龙胆（longdan） | 赵云 | standard | 是 |
| 裸衣（luoyi） | 许褚 | standard | 是 |
| 空城（kongcheng） | 诸葛亮 | standard | 是 |
| 流离（liuli） | 大乔 | standard | 是 |

## 声明了 `qiexie` 但被规则排除

（无）

## 描述里提到【杀】、但没有声明可借用

这一节是**待人工判断的清单**，不是缺陷列表：描述里出现「杀」字
不等于这个技能就该被当成武器技能借走。

| 技能 | 武将 | 包 | 备注 |
|---|---|---|---|
| 激将（jijiang） | 刘备 | standard | 主公技 |
| 无双（wushuang） | 吕布 | standard | 未声明 |
| 克己（keji） | 吕蒙 | standard | 未声明 |
| 神速（shensu） | 夏侯渊 | wind | 未声明 |
| 烈弓（liegong） | 黄忠 | wind | 未声明 |
| 猛进（mengjin） | 庞德 | fire | 未声明 |
| 天义（tianyi） | 太史慈 | fire | 未声明 |
| 烈刃（lieren） | 祝融 | forest | 未声明 |
| 肉林（roulin） | 董卓 | forest | 未声明 |
| 乱武（luanwu） | 贾诩 | forest | 限定技 |
| 挑衅（tiaoxin） | 姜维 | mountain | 未声明 |
| 享乐（xiangle） | 刘禅 | mountain | 未声明 |
| 激将（jijiang） | 刘禅 | mountain | 主公技、衍生技 |
| 激昂（jiang） | 孙策 | mountain | 未声明 |
| 悲歌（beige） | 蔡文姬 | mountain | 未声明 |
| 断肠（duanchang） | 蔡文姬 | mountain | 未声明 |
| 武神（wushen） | 神·关羽 | god | 未声明 |
| 龙魂（longhun） | 神·赵云 | god | 未声明 |
| 连破（lianpo） | 神·司马懿 | god | 未声明 |
| 龙怒（longnu） | 神·刘备 | god | 未声明 |
| 笃烈（dulie） | 神·太史慈 | god | 未声明 |
| 神著（shenzhu） | 神·太史慈 | god | 衍生技 |
| 星魂（xinghun） | 神·姜维 | god | 未声明 |
| 天涛（tiantao） | 神·姜维 | god | 未声明 |
| 霆威（tingwei） | 神·马超 | god | 未声明 |
| 权道（quandao） | 神·孙权 | god | 衍生技 |
| 斩决（zhanjue） | 神·黄忠 | god | 未声明 |
| 劫营（jieying-ganning） | 神·甘宁 | god | 未声明 |
| 毅重（yizhong） | 于禁 | yjcm2011 | 未声明 |
| 眩惑（xuanhuo） | 法正 | yjcm2011 | 未声明 |
| 挥泪（huilei） | 马谡 | yjcm2011 | 未声明 |
| 破军（pojun） | 徐盛 | yjcm2011 | 未声明 |
| 明策（mingce） | 陈宫 | yjcm2011 | 未声明 |
| 智迟（zhichi） | 陈宫 | yjcm2011 | 未声明 |
| 陷阵（xianzhen） | 高顺 | yjcm2011 | 未声明 |
| 禁酒（jinjiu） | 高顺 | yjcm2011 | 未声明 |
| 耍剑（shuajian） | 平头方块 | entertainment | 未声明 |
| 发呆（fadai） | 平头方块 | entertainment | 未声明 |
| 麻麻（mama） | 牛来 | entertainment | 未声明 |
| 忍耐（rennai） | 无亮 | entertainment | 未声明 |
| 新政（xinzheng） | 奕星 | entertainment | 未声明 |
| 醉闹（zuinao） | 善水 | entertainment | 未声明 |
