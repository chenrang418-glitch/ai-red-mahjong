# 纸上三国 · 全面审查后的改进计划（2026-09-10 起）

这份文档是**给接手的人看的施工单**。审查结论、优先级、每一项的具体做法、
涉及文件、验收标准都写在这里；照着从上往下做即可。

**进度表在最后一节 §15，做完一项就改一行。**

---

## 0. 开工前必须知道的约束

这些是项目所有者的长期要求，**任何一项都不能为了赶进度绕过**：

| 约束 | 说明 |
|---|---|
| 不动麻将 | Mahjong 的 engine / UI / Worker / tests 无必要不得改动 |
| 不提交部署 | 不得 push、不建 PR、不合并、不发布。所有工作只在本地提交 |
| 不虚构 | 不编造文件、接口、函数、配置、命令结果、测试结果 |
| 不写来源参考 | 代码、注释、文档、commit message 一律不得出现第三方厂商域名、详情页、wiki 链接，或「官方文本 / 官方裁定 / 逐字核实 / 规则源锁定」这类措辞 |
| 保留免责声明 | 站点里「与相关游戏厂商及权利人不存在官方授权、合作或隶属关系」是保护性表述，必须保留 |
| 引擎无特判 | 引擎主干不许出现按 `characterId` 的 `if`。能力一律由 skill runtime 钩子声明 |
| 不放水 | 不得删断言、跳过测试、降低检查强度来制造通过结果 |
| 立绘保留接口 | 未上传的立绘登记在 `PENDING_PORTRAIT_IDS`，不允许为了让检查变绿而放松完整性校验 |

### 每完成一项的固定收尾动作

```bash
npx vue-tsc --noEmit                 # 前端类型
npx tsc -p server/tsconfig.json      # Worker 类型
npx vitest run                       # 全量单测（当前基线 206 文件 / 2500 用例）
npx playwright test --project=chromium   # 89 项
git add -A <改动的路径> && git commit    # 本地提交，信息说清「为什么」
```

> WebKit 项目单独跑（`--project=webkit`，5 项）。和 chromium 合并跑时
> 这台机器上 WebKit 浏览器进程会被拖垮，报 `browser.newContext: ... has been closed`，
> 那是环境问题不是代码问题。

### 当前基线（2026-09-10 实测，不要照抄，做之前自己重新测一遍）

```
Commit           c07941c 之后的本地 main（origin/main = 22b42ba，本地领先 45+）
武将             111（standard 25 / wind 8 / fire 8 / forest 8 / mountain 8 /
                 god 24 / yjcm2011 11 / yjcm2012 12 / entertainment 7）
单测             206 文件 / 2500 用例
E2E              chromium 89 / webkit 5
前端包           SanguoshaApp chunk 760 kB（gzip 200 kB）
dist             37 MB（立绘 21 MB / 176 张）
```

---

## 1. 施工顺序总览

按下表从上往下做。**前四项是修 bug 和补漏，必须先做完**；
战绩统计和键盘操作按所有者要求放在最后。

| # | 任务 | 类型 | 规模 | 状态 |
|---|---|---|---|---|
| T1 | 「视为使用」绕过封牌规则 | Bug · 规则错误 | 小 | 见 §15 |
| T2 | 神典韦【摧决】取消不了 | Bug · 同类漏网 | 很小 | 见 §15 |
| T3 | 生产环境不跑不变量 | Bug · 可靠性 | 小 | 见 §15 |
| T4 | 狂骨 / 烈弓 零测试覆盖 | 测试补漏 | 小 | 见 §15 |
| T5 | AI 与提示词字符串强耦合 | 架构脆弱点 | 中 | 见 §15 |
| T6 | 12 名 YJCM2012 武将的 AI | AI 质量 | 大 | 见 §15 |
| T7 | AI 难度分层 | AI 质量 | 中 | 见 §15 |
| T8 | 移动端字号 / 触控 / 无障碍 | UI | 中 | 见 §15 |
| T9 | 前端拆包 | 性能 | 中 | 见 §15 |
| T10 | 旁观 | 新功能 | 大 | 见 §15 |
| T11 | 新手引导 / 教程 | 新功能 | 大 | 见 §15 |
| T12 | 武将筛选 / 搜索 / 收藏 | 新功能 | 中 | 见 §15 |
| T13 | 战绩统计（**倒数第二**） | 新功能 | 中 | 见 §15 |
| T14 | 键盘操作（**最后**） | 新功能 | 中 | 见 §15 |

**明确不做**：复盘 / 回放。

### 交接补充（T6 收尾时记录）

**基线（T6 提交后实测）**

| 检查 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | 通过 |
| `npx tsc -p server/tsconfig.json` | 通过 |
| `npx vitest run` | 211 文件 / 2540 用例全过 |
| `npx playwright test --project=chromium` | 89 通过（3.8 分钟） |
| `npm run build` | `SanguoshaApp-*.js` 765.56 kB（gzip 202.20 kB） |

WebKit 的 E2E 单独跑 5/5 通过，和 chromium 一起跑会报
`browser.newContext: ... has been closed`——是并发环境问题，不是产品缺陷，别去改断言。

**写 AI 测试时踩过的两个坑，接手时别重犯**

1. **断言要落在「选得对不对」，不能落在「有没有发动」。**
   后者在写这些分支之前就已经成立，对任何实现都成立，等于没测。
2. **内奸不是主公的自己人。** 我有两条用例是按「内奸友方」写的，结果红了，
   一查是我的前提错了，AI 本来就对。改断言之前先确认到底是谁错。

**T5 第二步（仍未做）**：`ai/index.ts` 里还有约 40 处按提示词字符串分支的旧逻辑，
需要逐条迁到 `skillId`。`tests/sanguosha-request-skill-identity.test.ts` 已经把
「请求必须带身份」这条红线钉住了，迁移过程不会失去保护。
所有者已排除，不要动。

---

## 2. T1 · 「视为使用」绕过封牌规则

### 现状（已复现，不是推测）

`isCardUseProhibited` 全仓库只在四处被调用：

```
src/sanguosha/engine/cards/basic.ts:71    legalPlayActions 里的 allCardUseBlocked
src/sanguosha/engine/cards/basic.ts:190   legalPlayActions 末尾的 use-card 过滤
src/sanguosha/engine/cards/basic.ts:908   executeUseCardAction
src/sanguosha/engine/damage.ts:138        濒死求桃候选
```

**`useVirtualWine`（`engine/virtual-wine.ts`）和 `beginVirtualSlash`
（`engine/cards/basic.ts` 的 `beginVirtualSlash`）一次都不查。**

复现（一行【离迹】封住曹植的用牌之后）：

```
isCardUseProhibited(state, 曹植, '酒') === true   ← 引擎知道他被封牌
【酒诗】按钮                              照样出现
turnUsage.wineUses                        真的 +1（酒生效了）
```

两条独立的漏：

1. **动作层**：`legalPlayActions` 末尾那道封牌过滤只筛 `use-card` 动作，
   筛不到主动技按钮。已有 `SkillRuntime.activeActionUsesCard` 这个声明位，
   但只有 3 个技能声明了。
2. **执行层**：就算按钮被藏起来，`useVirtualWine` / `beginVirtualSlash`
   仍然可以被别的路径调到（触发技、装备、别的技能），它们自己不查。

### 做法

**第一步 · 执行层收口。** 给这两个入口加封牌检查，并且**返回 boolean**
表示这次「视为使用」是否真的成立：

```ts
// engine/virtual-wine.ts
export function useVirtualWine(host: SkillHost, playerId: PlayerId, sourceSkillId: string): boolean
// engine/cards/basic.ts
export function beginVirtualSlash(host: CardEngineHost, options: {...}): boolean
```

- 进函数第一件事查 `isCardUseProhibited(host.state, <使用者>, '酒' | '杀', { dyingPlayerId: host.state.dying?.playerId ?? null })`。
  **使用者是那个「视为使用」的角色**，不一定是技能拥有者
  （程普【醇醪】让濒死者用酒，检查的是濒死者）。
- 被封就 `return false`，**什么都不做**（不发事件、不改计数）。
- 濒死语境要把 `dyingPlayerId` 传进去：贾诩【完杀】封的是【桃】而不是【酒】，
  但接口口径必须一致，别在这里丢上下文。

**第二步 · 调用方按返回值收尾。** 逐个改（`grep -rn "useVirtualWine\|beginVirtualSlash" src/`）：

- 曹植【酒诗】：**先查能不能用，再翻面**。现在是先 `flipCharacter` 再
  `useVirtualWine`，被封时会白翻一次面。
- 程普【醇醪】：用不出去就**不要移去那张「醇」**，也不要发战报。
- 神姜维【醒魂】、牛来【麻麻】等：用不出去就跳过那一次，继续下一个目标。

**第三步 · 动作层补声明。** 审计脚本已经列出 5 个「有 activeActions 且
静态可见会用牌」的技能，逐个判断**用牌的人是不是拥有者自己**：

| 技能 | 用牌的人 | 该不该声明 |
|---|---|---|
| 曹植【酒诗】 `JIUSHI` | 自己 | ✅ 补 `activeActionUsesCard: true` |
| 神姜维【醒魂】 `XINGHUN` | 自己 | ✅ 补 |
| 陈宫【明策】 `MINGCE` | **别人**（他只是「交给」） | ❌ 不补，注释写明理由 |
| 姜维【挑衅】 `TIAOXIN` | **别人** | ❌ 不补，注释写明理由 |
| 耍剑 `SHUAJIAN` | **别人** | ❌ 不补，注释写明理由 |

### 涉及文件

```
src/sanguosha/engine/virtual-wine.ts
src/sanguosha/engine/cards/basic.ts            (beginVirtualSlash)
src/sanguosha/data/characters/yjcm2011-caozhi.ts     (酒诗)
src/sanguosha/data/characters/yjcm2012-chengpu.ts    (醇醪)
src/sanguosha/data/characters/god-shenjiangwei.ts    (醒魂)
src/sanguosha/data/characters/entertainment-niulai.ts (麻麻，确认后再改)
docs/sanguosha-ruleset-v1.md                   (把「视为使用同样受封牌约束」写成一条通则)
```

### 验收标准

新建 `tests/sanguosha-card-use-prohibition.test.ts`，至少：

1. 一行封牌下，曹植【酒诗】**按钮不出现**；
2. 直接调 `useVirtualWine` 也用不出去（返回 false、`wineUses` 不变、武将牌不翻面）；
3. **反证**：不封牌时上面两条都正常成立（否则断言是空的）；
4. 醇醪救人时若濒死者被封牌，**「醇」不被移去**；
5. 神姜维【醒魂】在被封【杀】时打不出那几张【杀】
   （用曹彰【将驰】的「多摸」分支制造真实的禁令，不要手写 marks 键）；
6. 全量回归 + 压测无新增失败。

---

## 3. T2 · 神典韦【摧决】取消不了

### 现状

`src/sanguosha/data/characters/god-shendianwei.ts:214` 附近：

```ts
timeoutMs: 25_000, optional: true, purpose: 'skill',
cardIds: payable, hiddenCardSlots: [],
min: 1, max: 1,          // ← 和 optional: true 矛盾
```

`optional: true` 只是给界面看的；`validateResponse` 和
`timeout-default.ts` 读的都是 `min`。所以「可以取消」是假的，
而且联机超时会落到没有默认答案的分支。

**全仓库只剩这一处**（用 §14 的审计脚本扫过）。

### 做法

照 韩当【弓骑】改（`yjcm2012-handang.ts` 的 `GONGQI`，是同一个形状的样板）：

1. `min: 1` → `min: 0`，注释写明「可取消的『恰好选 N 张』必须写成 min: 0」；
2. `resume` 里 `if (!cardId)` 的分支改成**留放弃记号**再 return：
   `markDeclinedThisPhase(host.state, ownerId, CUIJUE)`；
3. `activeActions` 开头加 `if (declinedThisPhase(state, ownerId, CUIJUE)) return []`。

> 为什么必须加放弃记号：取消之后场面一点没变，同一条动作会原样重新出现，
> 压测里跑成无限循环。护栏的完整说明见
> `docs/sanguosha-architecture.md` 的「可取消主动技的活锁护栏」一节。

### 验收标准

- 新增 / 扩充 `tests/sanguosha-shendianwei.test.ts`：取消不付代价、
  不消耗次数、但同一阶段不再重复弹出；下一个出牌阶段实例又能发动。
- 神典韦定向压测（至少 5 人 120 局）无死锁。

---

## 4. T3 · 生产环境不跑不变量

### 现状

`assertGameInvariants` / `assertCardConservation` **只在测试和压测里调用**，
联机 Worker 一次都没调（`grep` 确认）。

联机侧本身有很完善的回滚：`server/sanguosha-room-core.ts:1048` 的
`captureRestorePoint` / `restoreTo` / `retryFailedJob`，连 RNG、战报、
表现事件都一起回滚。**但它只对抛出的异常生效**——牌被复制、请求发给死人
这类「不抛错的坏状态」会带着继续跑，直到某一步撞上别的错误才暴露，
那时已经离现场很远了。

### 做法

在 `runJob` 的 try 块**末尾**（成功路径上）加一次校验：

```ts
try {
  changed = this.runJob(due, now) || changed
  this.assertHealthy()     // ← 新增
} catch (cause) {
  this.restoreTo(restorePoint)
  this.retryFailedJob(due, now, cause)
  ...
}
```

`assertHealthy()` 的实现要点：

- `assertGameInvariants(this.state.game)` **每步都跑**——它只扫玩家和请求，很便宜；
- `assertCardConservation` 是 O(全部牌)，约 160 张，其实也不贵，
  但为稳妥起见**按回合末或每 N 步跑一次**，用一个计数器控制；
- 玩家动作入口（`handle` 里的 `respond` / `act`）同样要包一层，
  不能只覆盖定时任务；
- 抛出的错误会走既有的 `restoreTo` + `retryFailedJob`，
  **不要另写一套恢复逻辑**；
- 失败时记一条管理端可见的日志（房间号、seed、回合、阶段、错误信息），
  否则回滚成功但没人知道发生过。

### 验收标准

- 新增 `tests/sanguosha-room-invariants.test.ts`：故意把房间里的牌局改成
  坏状态（例如把一张牌同时塞进两个人手里），跑一步，断言
  **回滚发生了、房间没有卡死、日志里有记录**；
- 既有的 `sanguosha-room-core.test.ts` / `sanguosha-online-stability.test.ts` 全绿；
- 用 `tests/sanguosha-*-soak.test.ts` 里任意一组阵容跑联机路径，确认没有
  因为新校验而变慢到超时（跑之前先记基线耗时）。

---

## 5. T4 · 狂骨 / 烈弓 零测试覆盖

### 现状

5.2 万行测试里，`kuanggu`（魏延【狂骨】）和 `liegong`（黄忠【烈弓】）
**连字符串都没出现过**。两个都是规则敏感的锁定技：

- 狂骨：锁定技，对距离 1 以内的角色造成伤害后，回复等同于伤害点数的体力
- 烈弓：出牌阶段使用【杀】指定目标后，若其手牌数 ≥ 你的体力值或 ≤ 你的攻击范围，你可以令其不能使用【闪】响应

### 做法

各建一个测试文件，参照 `tests/sanguosha-huaxiong.test.ts` 的写法
（`gameAt` + `settle` + 精确发牌）。

**狂骨至少要钉住**：距离恰好 1 触发、距离 2 不触发、伤害点数 = 回复点数、
满血时不回复、失去体力（不是伤害）不触发、被防止的伤害不触发、
锁定技不发问。

**烈弓至少要钉住**：目标手牌数 ≥ 黄忠体力值或 ≤ 黄忠攻击范围时由黄忠选择是否发动；
发动后不可被闪，拒绝发动或两个条件都不满足时照常响应；判据读的是**指定目标那一刻**的
手牌数、多目标时逐个判断。

### 验收标准

两个技能各自的分支都有断言，且**每条「不触发」的断言旁边都有一条
「触发」的反证**——否则那条断言可能是空的。

---

## 6. T5 · AI 与提示词字符串强耦合

### 现状

`src/sanguosha/ai/index.ts`（2474 行）全靠文案匹配分支：

```ts
if (request.prompt.startsWith('【巧变】：获得至多')) { ... }
if (request.prompt.includes('【天义】')) { ... }
```

改一个字，AI 就静默降级到通用兜底，**没有任何测试会红**。

### 做法

**第一步 · 给请求带上技能身份。** `askSkill` 已经知道 `skillId` 和 `step`，
把它们写进请求本身：

```ts
// engine/requests.ts：给请求基类加两个可选字段
skillId?: string
skillStep?: string
```

在 `Game.askSkill`（`engine/game.ts`）里统一回填，**技能不需要各自传**。
群体决定（`group-decision.ts`）同样回填 `tag`。

**第二步 · AI 改按 id 匹配。** 新写的分支一律用
`request.skillId === 'qiaobian' && request.skillStep === 'steal-targets'`。
**旧分支不要一次性全改**——2474 行一起动风险太大。分两批：
先把新武将（T6 要写的那 12 个）全用新写法，再逐个迁移旧的，
每迁移一批跑一次全量。

**第三步 · 加一条防回归的测试。**

```
tests/sanguosha-ai-request-identity.test.ts
```

断言：跑若干局压测，**每一条 kind 为技能类的请求都带 skillId**。
这条能挡住「以后新增技能忘了回填」。

### 验收标准

- 新增字段不破坏序列化（重连测试全绿）；
- AI 行为在迁移前后**不应有可观测差异**：同一 seed 的压测计数应当一致
  （迁移一批就对比一次，差异必须能解释）。

### T5 完成情况

**已完成**：`RequestBase` 加了 `skillId` / `skillStep`；`Game.askSkill` 统一回填；
`GroupDecisionOptions` 加了 `skillId`，三个发起方（解烦、蛊惑声明、蛊惑质疑）都传了；
`tests/sanguosha-request-skill-identity.test.ts` 钉住「每条技能请求都带身份」。

**已完成**：`ai/index.ts` 里既有的技能分支已迁移为按 `skillId` / `skillStep`
识别。少量 `request.prompt` 读取仅发生在技能身份已确认之后，用于提取动态昵称、
阶段或技能选项内容，不再用整句文案判断技能种类。

注意：有几处是**同一个技能的不同步骤**（【驱虎】有两个选目标窗口、
【巧变】有三个），迁移后要用 `skillStep` 区分，不能只看 `skillId`。

---

## 7. T6 · 12 名 YJCM2012 武将的 AI

### 现状

压测计数说明技能都发得动，但 `ai/index.ts` 里
**这 12 个人一条专属分支都没有**（`grep` 结果为 0）。
对比：直谏、驱虎、天义、巧变、魄袭、好施、缔盟、英魂、节命都有手写评分。

后果是具体的：安恤可能把牌送给敌人；追忆可能给敌人回血 + 摸两张；
耀武的来源选择走通用兜底；自守发不发动没有局势判断。

### 做法

按下表逐个补。**先做收益最直接的**（标 ★ 的四个），
其余按顺序。每个技能一条分支 + 一个评分函数，评分函数放在
`ai/index.ts` 已有那批（`haoshiTargetScore` / `yinghunScore` 等）旁边，命名一致。

| 武将 | 技能 | AI 要判断什么 |
|---|---|---|
| ★ 步练师 | 安恤 | **较少者必须是友军**（`hostility <= 0`），较多者优先敌人。非黑桃能多摸一张，但不该为了摸牌把资源送给敌人 |
| ★ 步练师 | 追忆 | 目标只给友军，优先「血少 + 手牌少」的核心友军 |
| ★ 华雄 | 耀武（来源侧） | 自己受伤就选回复，满血选摸牌。注意**做选择的是伤害来源**，评分要用来源的视角 |
| ★ 刘表 | 自守 | 手牌少 / 局势偏守 / 没有好的出牌选择时发动；手上有关键进攻牌时不发动 |
| 韩当 | 弓骑 | 有想打但够不着的目标时才发动；优先弃装备牌（能多一张【杀】），但不能弃掉自己正在用的关键装备 |
| 韩当 | 解烦 | 限定技：场上武器多、且自己缺牌时发动 |
| 廖化 | 当先 | 锁定技，无需决策。但**出牌 AI 要知道自己有两个出牌阶段**，别在第一个阶段就把【杀】用完 |
| 关兴张苞 | 父魂 | 手牌 ≥ 4 且有值得打的目标时才拆两张；打中能拿咆哮，所以第一次的价值更高 |
| 马岱 | 潜袭 | 目标选敌人；弃牌颜色挑对方手里可能更多的那一色 |
| 程普 | 疠火 | 目标是残血敌人时值得付 1 点体力；自己残血时不发动 |
| 程普 | 醇醪 | 存醇：手上【杀】多余时存。救人：只救友军，且优先核心友军 |
| 曹彰 | 将驰 | 已有分支（`jiangchi` 有计数）——确认它是否真的在评分，没有就补 |
| 钟会 | 权计 / 自立 / 排异 | 自立是觉醒，无需决策；排异要挑价值高的「权」和合适的目标 |
| 荀攸 | 奇策 / 智愚 | 奇策：手牌多且能打出好锦囊时；智愚：几乎总是发动 |
| 王异 | 贞烈 / 秘计 | 已有计数，确认评分质量 |

### 验收标准

**不能只看「计数 > 0」**——那在改之前就已经成立了。要断言**质量**：

```
tests/sanguosha-ai-yjcm2012.test.ts
```

- 安恤：构造「友军手牌少 / 敌人手牌多」的局面，断言 AI 选的
  较少者是友军、较多者是敌人；
- 追忆：构造友军和敌人都残血的局面，断言目标是友军；
- 耀武：来源残血时选回复、满血时选摸牌；
- 自守：手上全是废牌时发动、手上有【杀】+ 有目标时不发动。

再跑一轮 8 人轮转 200 局的合并压测，对比改动前后的**胜率分布**：
新武将不应该因为 AI 变聪明而失衡到一边倒（`sanguosha-ai-belief.test.ts`
里那两条胜率断言就是这个用途，跑它即可）。

---

## 8. T7 · AI 难度分层

### 现状

全仓库只有 3 处读 `difficulty`（`ai/index.ts:602-603`、`:1749`、`:1936`），
实质是「给分数加随机噪声」：easy `+rng(7)`、normal `+rng(4)`、hard 无噪声。
没有搜索深度差异，也没有信息利用差异。

### 做法

把难度做成**三个真实不同的策略档**，而不是同一策略加不同噪声：

| 档 | 该怎么表现 |
|---|---|
| 简单 | 只看当前这一步的直接收益；**不用身份推断**（`suspicion` 一律当作未知）；会漏掉明显的连招 |
| 普通 | 现在的行为，保留少量噪声 |
| 困难 | 无噪声；**用满身份推断**；增加两处前瞻：① 出牌阶段按「这一轮能否打死某人」排序，② 濒死时评估「救他值不值」 |

实现上建议给 `AiContext` 加一个 `profile` 对象（`useSuspicion: boolean`、
`noise: number`、`lookahead: boolean`），由 difficulty 映射出来，
评分函数读 `profile` 而不是到处 `if (difficulty === ...)`。

### 验收标准

`tests/sanguosha-ai-difficulty.test.ts`：同一批 seed 下，
**困难档对简单档的胜率显著高于 50%**（例如 100 局里 ≥ 60 局），
且三档的行为计数（技能发动次数、平均回合数）互不相同。

---

## 9. T8 · 移动端字号 / 触控 / 无障碍

### 现状（393×852 实测）

```
可点区域 < 44×44        30 个   返回键 32×32、声音 38×28、战报 49×28、技能芯片 24×13
字号 < 11px             73 处   最小 7px（体力 "4/4"）
只有图标没有可读名字     3 个   身份「？」芯片
横向溢出                 0      ✓
focus-visible            有     ✓
prefers-reduced-motion   有     ✓
```

7–9px 是 `SgsSeat.vue` 在小屏下主动压的（约 line 273-276），
为的是把全部信息塞进座位卡。

### 做法

1. **建立字号下限**。座位卡的最小字号提到 **10px**，主要信息（武将名、体力）
   提到 **12px**。塞不下就**减少默认显示的信息**，不要继续缩字：
   把装备/状态芯片折叠成一个「+N」，点开是一个浮层。
2. **触控目标**。所有真正可点的控件（返回、声音、战报、化身库、词条触发器）
   最小命中区提到 44×44——可以用透明的 `::before` 扩大热区，不必把视觉尺寸做大。
3. **无障碍**。身份「？」芯片补 `aria-label="身份未公开"`；
   所有 `cursor: help` 的词条触发器补 `aria-label="查看词条：XXX"`。
4. 顺手统一：现在 `aria-label` 的分布很不均（`SgsActionStage.vue`、
   `SgsEffectLayer.vue` 是 0）。

### 验收标准

把审查时用的那段量化脚本固化成一个 E2E 用例
（`tests/e2e/sanguosha-a11y.spec.ts`）：

- 393×852 / 932×430 下，**可点区域 < 44×44 的数量为 0**；
- **字号 < 10px 的元素为 0**；
- 无可读名字的按钮为 0；
- 整页仍然不横向滚动。

这条固化之后，以后任何人再把字号压下去都会当场红。

---

## 10. T9 · 前端拆包

### 现状

```
SanguoshaApp chunk   760 kB（gzip 200 kB）
dist                 37 MB（立绘 21 MB / 176 张，单张最大 300 kB）
BGM                  686 kB（由 128 kbps 压至 80 kbps，进牌桌时才拉）
```

门户已经按游戏懒加载（`portal/gameManifest.ts` 的 `loadApp: () => import(...)`），
所以 760 kB 是「进三国杀」这一下的成本。

### 做法

按「什么时候才需要」拆三块：

1. **AI（`src/sanguosha/ai/`，约 2900 行）** — 只有单机需要，联机由服务端跑。
   改成动态 `import()`，在进入单机对局时加载。
2. **武将数据表（`data/characters/`，约 25000 行）** — 进牌桌才需要完整表；
   选将页只需要 id / 名字 / 势力 / 技能名。可以拆出一份轻量索引供选将和
   艺术集用，完整定义按需加载。**注意**：`standard.ts` 里有大量
   `provideXxx` 注入（化身目录、随机技能池、势力查询），拆的时候要保证
   这些注入在引擎第一次用到之前完成，否则会变成静默的空表。
3. **立绘** — 已经是懒下载（`manifest.ts` 用 `import.meta.glob` 只取 URL）。
   但 300 kB 一张偏大，可以再压一档，或加 `loading="lazy"` + 低清占位。

### 验收标准

- `npm run build` 后 SanguoshaApp 主 chunk **< 400 kB**；
- E2E 全绿（拆包最容易踩的就是「注入没来得及跑」，靠 E2E 兜底）；
- 手动确认：选将页不再下载完整武将表（看 network 面板的 chunk 数）。

---

## 11. T10 · 旁观

### 现状

完全没有。但底子很好：`buildPlayerView(state, viewerId)` 已经是严格的
按视角裁剪（只下发自己的 pendingRequest、暗牌只给占位槽）。

### 做法

1. **引擎侧**：加一个「观察者视角」——`buildSpectatorView(state)`，
   等价于「一个不属于任何座位的人」：看得到公开区、战报、体力、装备、
   已公开的身份；**看不到**任何人的手牌、未公开身份、任何 pendingRequest。
   实现上最省事且最安全的做法是复用 `buildPlayerView` 并传一个不存在的
   `viewerId`，然后**加断言确认它确实什么私密信息都没漏**。
2. **房间侧**（`server/sanguosha-room-core.ts`）：座位和观众分开。
   观众不占座位、不参与超时、不影响开局条件、不能 `act` / `respond`。
   房间容量、聊天权限要一并想清楚（建议观众可看不可发，或单独频道）。
3. **UI**：进房时若座位已满，给一个「以观众身份进入」的入口；
   牌桌顶部显示「旁观中」；隐藏所有操作面板。

### 验收标准

- `tests/sanguosha-spectator.test.ts`：观众视角的 JSON **不含**任何
  在座玩家的手牌 id、未公开身份、pendingRequest（逐个断言，不要只看一个字段）；
- 观众进出不影响牌局推进（进出 10 次后牌局状态与不进出时一致）；
- 观众发 `act` / `respond` 被拒绝；
- E2E：满员房间能以观众进入并看到牌桌。

---

## 12. T11 · 新手引导 / 教程

### 现状

完全没有。111 个武将、几十条规则，新玩家进去是懵的。
`SgsGlossarySheet.vue` 有词条系统，但那是「查」不是「教」。

### 做法

分两层，**先做第一层**：

**第一层 · 首次进入的分步提示（成本低、收益大）**
在第一次进牌桌时，用一个轻量的引导层依次高亮：
① 你的手牌区 → ② 体力和身份 → ③ 操作面板 → ④ 战报入口 → ⑤ 结束出牌。
状态存 localStorage，可在设置里重看。**不要做成必须点完的强制流程**。

**第二层 · 教学对局（成本高）**
一局固定种子、固定阵容（建议标准包四人）的脚本化对局，
每一步给出提示并只允许一个正确操作。做之前先确认第一层的反馈。

### 验收标准

- 第一层：E2E 断言首次进入出现引导、点完不再出现、设置里能重置；
- 引导层不阻塞牌局推进（AI 回合照跑）；
- 三档视口下引导层不溢出、整页不滚动。

---

## 13. T12 · 武将筛选 / 搜索 / 收藏（已取消）

> 2026-09-11 用户明确取消。不要在选将界面加入筛选、搜索或收藏；
> 艺术集原有的“寻访武将”不属于此任务，继续保留。

### 现状

选将池有 111 人，没有筛选、没有搜索、没有收藏。
自选池入口在 `SgsHomePortrait.vue` / 选将页（E2E 里有
「选将页可返回、固定显示自定义武将并进入完整自选池」这条用例）。

### 做法

1. **筛选**：按势力（魏蜀吴群神）、体力上限、扩展包、性别。
   数据都在 `CharacterDefinition` 上，不需要新增字段。
2. **搜索**：按武将名和**技能名**搜（技能名更常用——玩家记得「铁骑」
   但不一定记得是谁）。
3. **收藏**：localStorage 存一组 id，收藏的排在最前。
   **不要**做成账号级功能（会牵扯服务端和登录）。

### 验收标准

- E2E：搜「铁骑」能搜到马超；按「吴」筛选后列表里全是吴势力；
  收藏后刷新页面仍然置顶；
- 111 人的列表在手机上滚动不卡（如果卡，加虚拟滚动）。

---

## 14. T13 · 战绩统计（倒数第二做）

### 做法

- 存储：localStorage 起步（单机），字段建议：总局数、胜负、身份分布、
  常用武将、平均回合数。**联机战绩要落服务端**，那是另一件事，
  先只做单机，别把两者混在一起。
- 入口：门户或三国杀首页一个「战绩」按钮。
- 展示：一屏能看完，不要做成大报表。

### 验收标准

- 打完一局后数字正确增加；清除数据后归零；
- 存储读写全部包 try/catch（隐私模式下 localStorage 会抛）。

---

## 15. T14 · 键盘操作（已取消）

> 2026-09-11 用户明确取消。不要新增牌桌快捷键或快捷键设置；
> 弹窗原有的 Esc 关闭等基础可访问性行为不属于快捷键功能，继续保留。

### 现状

`@keydown` / `@keyup` 在三国杀 UI 里**一次都没有**。

### 做法

先定一份键位表，写进这份文档再实现：

| 键 | 行为 |
|---|---|
| `Esc` | 关闭最上层的浮层（词条 / 化身库 / 战报 / 设置） |
| `Enter` | 确认当前请求的默认动作 |
| `空格` | 结束出牌 / 放弃 |
| `1`–`9` | 选中第 N 张手牌 |
| `Tab` | 在座位间移动焦点（选目标时） |

注意：

- 焦点管理要和现有的 `focus-visible` 样式配合（已经有，别推翻）；
- 浮层打开时要**捕获焦点**（focus trap），关闭后焦点还原；
- 移动端不受影响。

### 验收标准

- E2E：用键盘完整打完一个出牌阶段（选牌 → 选目标 → 确认 → 结束）；
- 打开浮层后 `Tab` 不会跑到浮层外面；
- 所有键位可在设置里查看。

---

## 16. 附录 · 复用的审计脚本

审查时用过的两个脚本，以后每加一批武将都值得重跑一遍。
建议固化成测试，别只留在 scratchpad 里。

**① 扫「可取消但取消不了」的请求**

```python
import io, re, glob
for path in glob.glob('src/sanguosha/**/*.ts', recursive=True):
    s = io.open(path, encoding='utf-8').read()
    for m in re.finditer(r'\{[^{}]*optional:\s*true[^{}]*\}', s, re.S):
        blk = m.group(0)
        mm = re.search(r'\bmin:\s*(\d+)', blk)
        if mm and int(mm.group(1)) >= 1:
            print(path, s[:m.start()].count('\n') + 1, mm.group(1))
```

**② 扫「会用牌却没声明 activeActionUsesCard」的主动技**

按 `registerSkillRuntime({...})` 切块，块里同时出现 `activeActions` 和
`executeUseCardAction` / `beginVirtualSlash` / `useVirtualWine` /
`createVirtualTrick` / `instantTrickActions` / `declaredCardActions`
之一，却没有 `activeActionUsesCard`，就报出来。
**报出来之后必须人工判断「用牌的人是不是拥有者自己」**——
陈宫【明策】、姜维【挑衅】是让别人用牌，不该声明。

---

## 17. 进度表

做完一项就把状态改成 `✅ 完成（commit）`，并把实际发现写进「备注」。
**不要提前打勾。**

| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| T1 | 「视为使用」绕过封牌 | ✅ 完成 | 实际有**三个**漏口（还有 `slashUseOptions`），全部收口；两个入口改成返回 boolean，调用方用不出去就不收代价 |
| T2 | 摧决取消不了 | ✅ 完成 | min 1→0 + 放弃记号；既有两条用例原来靠「默认答案恰好等于代价牌」通过，现在明确交代价 |
| T3 | 生产不变量 | ✅ 完成 | 挂在 `afterEngineStep`（所有推进路径的唯一汇合点）；玩家指令原来**没有**回滚护栏，一并补上；守恒按 8 步抽样 |
| T4 | 狂骨 / 烈弓 测试 | ✅ 完成 | 13 条；烈弓的边界表问运行时（没有导出的聚合入口），接线由两条真打一刀的用例兜底 |
| T5 | AI 提示词解耦 | ✅ 本地完成 | 请求已带 `skillId` / `skillStep`，既有技能分支已迁移；动态昵称等仍在身份确认后从提示内容读取。身份回归与 AI 压测通过，尚未提交 |
| T6 | 12 名武将 AI | ✅ 完成（41836ed） | 发不发动补进 `skillActionScore`，怎么选新开一条**按 `skillId` 分发**的入口放在 `decideResponse` 最前面，认不出就原样落回旧链。**只覆盖了一将成名 2012 的 12 人**；曹彰/钟会/荀攸/王异（第一批）仍无专属分支，留给后续。醇醪试过「留一张【杀】自保」，200 局压测发动 166→49，改回全存后 191 |
| T7 | AI 难度分层 | ✅ 本地完成 | 三档参数和回归测试已接入，尚未提交 |
| T8 | 移动端字号 / 触控 / 无障碍 | ✅ 本地完成 | 含横屏座位/手牌布局与底栏抬升避让，尚未提交 |
| T9 | 前端拆包 | ⏸ 暂停 | AI 已按单机入口懒加载，主 chunk 已降至 400 kB 以下；完整武将表拆分按 2026-09-11 用户要求暂不继续。纸上三国 BGM 已由 1.10 MB 压至 686 kB |
| T10 | 旁观 | ✅ 本地完成 | 独立只读观众、隐私裁剪、满员房间入口和重连参数均已接入，尚未提交 |
| T11 | 新手引导 | ✅ 本地完成 | 首次局内聚光引导、局内独立重开入口、局外模拟牌桌与上一步均已完成；新增“详”入口说明，尚未提交 |
| T12 | 武将筛选 / 搜索 / 收藏 | ⏸ 取消 | 2026-09-11 用户明确取消 |
| T13 | 战绩统计 | ⏸ 暂不做 | 2026-09-11 用户明确要求暂停 |
| T14 | 键盘操作 | ⏸ 取消 | 2026-09-11 用户明确取消 |

**明确不做**：复盘 / 回放。

**2026-09-11 补充**：单机牌桌已加入玩家手动 AI 托管；不设空闲倒计时，
不会自动开启，玩家可随时取消。复盘 / 回放与战绩统计均暂不继续。

### 交接补充（T6 收尾时记录）

**基线（T6 提交后实测）**

| 检查 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | 通过 |
| `npx tsc -p server/tsconfig.json` | 通过 |
| `npx vitest run` | 211 文件 / 2540 用例全过 |
| `npx playwright test --project=chromium` | 89 通过（3.8 分钟） |
| `npm run build` | `SanguoshaApp-*.js` 765.56 kB（gzip 202.20 kB） |

WebKit 的 E2E 单独跑 5/5 通过，和 chromium 一起跑会报
`browser.newContext: ... has been closed`——是并发环境问题，不是产品缺陷，别去改断言。

**写 AI 测试时踩过的两个坑，接手时别重犯**

1. **断言要落在「选得对不对」，不能落在「有没有发动」。**
   后者在写这些分支之前就已经成立，对任何实现都成立，等于没测。
2. **内奸不是主公的自己人。** 我有两条用例是按「内奸友方」写的，结果红了，
   一查是我的前提错了，AI 本来就对。改断言之前先确认到底是谁错。

**T5 已收尾**：`ai/index.ts` 不再按技能提示词前缀识别技能；
`tests/sanguosha-request-skill-identity.test.ts` 继续保护「技能请求必须带身份」这条红线。
2026-09-11 本地复核：相关 4 个测试文件、40 条用例全部通过，其中包括 5～8 人局
各 40 局无头压测。
