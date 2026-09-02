# 交接说明：CRPlay（红中麻将 + 三国杀）

更新时间：2026-09-02（用户额度将尽，交接给 codex 时更新）。

## 先做什么

1. 工作目录固定为 `C:\Users\cr\Documents\work\crplay-sanguosha-dev`。
2. `git status --short --branch`。**应当在 `feature/sanguosha` 上，不是 `main`**——
   部署工作流由 `push: branches: [main]` 触发，留在 `main` 上提交推送会直接部署生产。
3. 阅读 `docs/sanguosha-progress.md`（按批次记录了每一步的根因和取舍）和本文件。
4. 未经用户明确同意，不要往生产环境写数据（建测试房间或用户）。

## Git 基线

- 仓库：`https://github.com/chenrang418-glitch/ai-red-mahjong.git`
- `origin/main` 已包含好友娱乐武将“平头方块”，部署提交为 `3787535`。
- `feature/sanguosha` 继续包含后续扩展武将提交；最新一条以 `git log --oneline -1` 为准。
  **push 前先跑三层验证。**
- CI 全绿，已部署。生产 `https://crplay.cn` 实测：`/api/health` 返回 `{"ok":true}`，
  首页标题已是 `CRPlay`。
- 部署方式：

  ```
  git checkout main && git merge --ff-only feature/sanguosha && git push origin main
  git checkout feature/sanguosha
  ```

## 验证基线（2026-09-02 扩包完成后实测）

| 命令 | 结果 |
|---|---|
| `npm test` | 67 文件 / **621 用例 + 1 todo** |
| `npx playwright test` | **46 通过**（Chromium 42 + WebKit 4） |
| `npm run sanguosha:soak -- 200` | 5 人局与 8 人局各 200 局全部完成 |
| `npm run test:online:smoke` | 通过 |
| `npm run typecheck` / `typecheck:online` | 通过 |
| `npm run build` / `build:online` | 通过（Worker dry-run 通过） |

规模：三国杀引擎约 5000 行，测试约 8300 行。

端口约定：麻将目录 dev 5180 / e2e 4173；本目录 dev **5190** / e2e **4183**。
`preview_start` 读的是**麻将目录**的 `.claude/launch.json`，配置名要用 `sgs`（5190），
用 `web` 会起到麻将项目（5180）。这个坑踩过两次。

## 已完成的范围

### 三国杀规则引擎：ruleset-v1 全部实现

- **牌**：标准包 108 + 军争 52 = 160 张，全部结算完毕。
- **装备**：**全部实现**。需要发问或要动结算状态的都在
  `src/sanguosha/engine/equipment-requests.ts`——贯石斧、青龙偃月刀（闪抵消后）、
  寒冰剑（伤害前，替代伤害）、麒麟弓（伤害后，走延后队列）、
  雌雄双股剑（指定目标后、求闪前）、丈八蛇矛、方天画戟。
- **武将 33 名**（**只登记运行时完整实现的，没有空壳**）：

  标准包 25 名：

  | 势力 | 武将 |
  |---|---|
  | 蜀 | 刘备（主公技激将）、关羽、张飞、诸葛亮、赵云、马超、黄月英 |
  | 魏 | 曹操（主公技护驾）、司马懿、夏侯惇、张辽、许褚、郭嘉、甄姬 |
  | 吴 | 孙权（主公技救援）、甘宁、吕蒙、黄盖、周瑜、大乔、陆逊、孙尚香 |
  | 群 | 华佗、吕布、貂蝉 |

  扩展包 7 名（2026-09-02 新增）：

  | 包 | 武将 | 技能 | 文件 |
  |---|---|---|---|
  | 风 | 魏延 | 狂骨（经典风包版：锁定技，对距离 1 以内造成伤害后回等量体力） | `data/characters/wind.ts` |
  | 风 | 黄忠 | 烈弓（经典风包版：锁定技，手牌数 ≤ 己方体力值或 ≥ 己方体力上限则不可闪） | `data/characters/wind.ts` |
  | 火 | 典韦 | 强袭（经典火包版：出牌阶段限一次，失去 1 体力或弃武器，对攻击范围内 1 人造成 1 伤害） | `data/characters/fire.ts` |
  | 火 | 庞德 | 马术（复用马超）+ 猛进（杀被闪抵消后，弃自己一张牌，弃对方一张牌） | `data/characters/fire.ts` |
  | 火 | 颜良文丑 | 双雄（摸牌阶段改判定并获得判定牌，本回合异色手牌当决斗） | `data/characters/fire.ts` |
  | 风 | 小乔 | 天香（伤害转移）+ 红颜（统一有效花色入口） | `data/characters/wind.ts` |
  | 风 | 夏侯渊 | 神速（跳判定摸牌或弃装备跳出牌，使用无距离虚拟杀） | `data/characters/wind.ts` |

  好友娱乐包 1 名：平头方块（群，4 体力），【耍剑】【发呆】，位于
  `data/characters/entertainment.ts`。项目和 UI 中只使用这两个中性技能名。

  **一律采用经典风/火包版本，不混界限突破版**，每个技能的注释里都写明了这一条。

### 扩展包架构（2026-09-02 建立）

- `data/characters/types.ts` 的 `CharacterPack = 'standard' | 'wind' | 'fire' | 'entertainment'`，
  每个 `CharacterDefinition` 必须声明 `pack`。
- `STANDARD_CHARACTERS` **只保留标准包**；对外的单一入口是同文件里的
  `ALL_CHARACTERS`（标准 + 风 + 火 + 好友娱乐）与 `allCharacterIds()`。
  UI、词条、立绘、AI、测试全部读 `ALL_CHARACTERS`，**不要再直接读 `STANDARD_CHARACTERS`**。
- 新增一个包就加一个 `data/characters/<pack>.ts`，在 `standard.ts` 里并进 `ALL_CHARACTERS`。
- `tests/sanguosha-packs.test.ts` 里有**空壳探测**：每个注册的技能 id 都必须能取到运行时。
  它需要 `import '@/sanguosha/engine/game'` 来触发注册的副作用，别把这行删了。
- 首页文案和选将页的计数都读 `ALL_CHARACTERS.length`，**不要再写死数字**（写死过 25，错过一次）。

### 引擎里的关键机制

| 机制 | 位置 | 说明 |
|---|---|---|
| 战报 | `engine/log.ts` | `describeEvent(state, event, viewerId)`，**按观看者过滤** |
| 技能发问 | `state.skillResolution` + `SkillHost.askSkill` + `SkillRuntime.resume` | 安全时机向玩家发问 |
| 延后发问队列 | `state.skillQueue` + `startQueued` | 「受到伤害后」的技能：触发抓事实排队，牌局干净了再问 |
| 主公技代打 | `SkillRuntime.surrogateResponders` | 护驾 / 激将 |
| 救援加成 | `SkillRuntime.rescueRecoverBonus` | 孙权【救援】 |
| 转化别名 | `state.cardAliases` + `effectiveCardName` | 延时锦囊的转化（大乔【国色】） |
| 有效花色 | `SkillRuntime.cardSuit` + `effectiveCardSuit` | 红颜统一影响判定、火攻和牌张颜色规则 |
| 虚拟杀 | `SkillHost.beginVirtualSlash` | 神速、耍剑共用完整杀/响应/伤害管线 |
| 持久化 | `state.rngState` + `serialize()` / `restore()` | DO 休眠恢复 |

**所有等待状态都是可序列化的，没有任何 `await 用户点击`。**

### 【杀】的结算管线（改动前必读）

多目标（方天画戟）靠 `SlashResolutionState.remainingTargetIds`，
`continueSlash` 是**唯一**的「这个目标结算完了」出口，三条收尾路径全部汇到它。
每个会结束一个目标的装备特效都必须在最后调它——**漏掉就是整局卡死，压测抓到过两次**。

关键前提：**一个人只能装一把武器**，所以方天画戟和青龙/贯石斧/寒冰剑/麒麟弓
不会同时出现，多目标不必和它们纠缠。

借刀杀人现在也走完整管线（仁王盾挡得住、无双生效、流离转得走）。

### AI

- `hostility(view, suspicion, targetId)` 返回带符号的敌意，`PROTECTED` 表示绝不选为目标。
- `observeEvent` 挂在事件流上更新身份推断。
- **AI 只读 `PlayerView`，不碰隐藏身份**——那在 `PlayerView` 里本来就是 null，
  `tests/sanguosha-ai-belief.test.ts` 守着这条。

### 联机

- `server/sanguosha-room-core.ts`（纯逻辑，可脱离 Miniflare 单测）
  + Worker DO `SanguoshaRoom` + `SGS_ROOMS`/migration v3 + `/api/sanguosha/rooms*`。
- 座位、大厅、选将、指令、按玩家过滤的视图与战报、超时 AI 代打、掉线托管、
  重连、再来一局，全部实现并有测试。
- **1 真人 + 4 AI** 和 **2 真人** 两条路径都在真实浏览器里走过。

### 站点外观（用户指定，改动前必读）

- 站点叫 **CRPlay**，不再叫「红中麻将」。
- **配色统一定义在 `src/styles/root.css` 的 `:root`**（`--ink-*` / `--accent-*`）。
  不要再在组件里写死深色值——以前散在七八处，改一处必然漏别处。
- 底色是墨绿 `#1d332a`，**保留径向渐变的杂色，不要做成纯色块**。
- 三国杀主色是**金色**（和门户卡片的 `#d6aa55` 对齐），麻将主色是**红色**。
- 两个游戏的首页结构 **1:1 对齐**：顶栏 → 居中 hero（印章/小标注/标题/说明）→
  三个入口（金/红/绿）。改一边就要改另一边。
- `tests/e2e/responsive.spec.ts` 在三种视口下逐项比对两边的实际渲染；
  `tests/e2e/portal.spec.ts` 守着配色变量和主文字亮度。

## 用户当前的待办清单（2026-09-01 给出）

按用户原话排的优先级。1~5 已完成，6、7 待做：

1. ~~单机退出结算界面~~ ✅ 已完成（退出确认 + 结算名单 + 再来一局）
2. ~~选角色界面竖屏超出屏幕~~ ✅ 已完成（底部面板封顶 + 内部滚动）
3. ~~对局中选项多时超出屏幕下方~~ ✅ 同上，根因是同一个
4. ~~局内词条查看~~ ✅ 已完成（codex 做的 `glossary/index.ts` + `SgsGlossarySheet`，
   直接读现有单一数据源，没有跳规则页）
5. ~~动画~~ ✅ 已完成（`useSgsEventStage` 事件队列 + 轻重分级 + 专属皮肤）。
   **飞牌轨迹经用户明确指示暂不做**——目前出牌只表现为中央公开牌和 SVG 指向，
   没有「从牌堆/座位飞入」的完整轨迹。
6. ~~立绘~~ ✅ **标准包 25 / 25 已全部接入**（2026-09-02，用户用 GPT 生成并提供）。
   座位四层结构、满幅立绘 + 文字描边；缺图时自动回退到文字底纹。
   再加武将照 `docs/sanguosha-portraits.md` 做。
   **不要自己去网上抓立绘**——原型阶段用过的无授权素材已按用户决定全部撤除。

7. ~~新增角色~~ ✅ 经典扩展目标 32 名已完成；另有好友娱乐武将 1 名，当前总池 33 名。

## 扩包到 32 名（已完成）

用户的方案是从 25 扩到 **32 名**，新增 7 名：典韦、魏延、庞德、黄忠、颜良文丑、小乔、夏侯渊。
**7 名均已完成**：典韦、魏延、庞德、黄忠、颜良文丑、小乔、夏侯渊。

| 武将 | 技能 | 实现方式 |
|---|---|---|
| 颜良文丑（火） | 双雄 | 判定颜色写入回合 mark，异色转化统一走 `SkillRuntime.viewAs`，回合结束清除 |
| 小乔（风） | 天香、红颜 | 红颜走统一有效花色；天香在伤害时取消并排队，牌结算干净后以可序列化请求完成转移 |
| 夏侯渊（风） | 神速 | 判定阶段可取消恢复，公共虚拟杀复用完整管线，第二段结算后由阶段状态机进入弃牌阶段 |

**用户明确的纪律：每完成一个武将 → 单测 → 全量回归 + 压测 → 再进入下一个。**
不允许攒一批一起提交。

三条硬约束（用户反复强调过）：

1. **不许写空壳**：技能没实现完就不登记这个武将。
2. **不许为单个武将开特判分支**：共用的时机要抽成公共入口。
   本轮抽出来的两个可以直接复用：
   - `SkillRuntime.slashUndodgeable(state, ownerId, targetId)`：锁定技造成的「不可被闪响应」，
     结果落到 `resolution.noDodge`，铁骑和烈弓共用。
   - `basic.ts` 里 `finishDodgedSlash` 的 **「杀被闪抵消后」时机链**：
     贯石斧/青龙偃月刀和庞德猛进都挂在这条链上，再加同类技能只需往数组里加一项。
3. **AI 必须会用新技能**：`ai/index.ts` 的 `decidePlayAction` 现在会评估 `invoke-skill`
   （`skillActionScore`）。加了主动技就要顺手给它一个评分，否则 AI 永远不发动——
   这个洞之前存在过，补上之后 5 人局主公胜率从 16% 涨到 41%。

### 立绘现状

**用户已上传全部 7 名新武将的立绘素材**，7 张里 6 张已转好并登记裁切参数
（魏延、黄忠、庞德、颜良文丑、小乔、夏侯渊），放在
`src/sanguosha/assets/characters/portraits/`，1086×1448、3:4、≤40KB。
7 名扩展武将均已登记，对应立绘已自动生效，不需要再找素材。
颜良文丑是双人构图，焦点参数已经对准前景那张脸。

> **绝对不要自己去网上抓立绘。** 只用用户提供的素材。原型阶段用过的无授权素材
> 已按用户决定全部撤除，也从未提交。

### 需要向用户确认的一个点

庞德【猛进】我实现的是**经典火包原文**：「弃置一张牌，然后弃置该角色的一张牌」——
**带自弃代价**。用户在方案里的描述是「可以弃置该目标区域内的一张合法牌」，没提代价。
我按规则原文做了（用户当时刚确认「典韦按经典火包版」）。
若用户要去掉代价，改动在 `engine/equipment-requests.ts` 的 `askMengjin`，
删掉中间那一步即可，`tests/sanguosha-pangde.test.ts` 里有两条相应用例要跟着改。

## 标准包尚缺的技能

**司马懿【鬼才】还没实现**，所以他目前只有【反馈】。
这不是有意简化——郭嘉【天妒】和马超【铁骑】原来也漏了，已于 2026-09-02 补上。

鬼才要求判定能中途挂起，而 `performJudgment` 和延时锦囊的判定都是全同步的。
要做就得把判定改成可续接的状态机，刚烈、洛神、八卦阵、四种延时锦囊全部要跟着改。
**做完顺带解锁张角【鬼道】**（同一个改判机制）。缺口用 `it.todo` 留在
`tests/sanguosha-standard-gap-skills.test.ts` 里。

> 给已有武将补技能之前，**先查一遍谁在测试里被当成「无技能填充角色」**。
> 加铁骑时马超正是那个角色，一次改动让 4 个文件 25 条测试变红。
> 现在填充统一用张飞（咆哮是纯被动，不产生请求）。

## 已知简化（都在代码注释里标明了，不是遗漏）

- **8 人局反贼胜率约 76%，已用实验证明是结构性的**：临时让忠臣直接读到真实身份
  （作弊到底的 AI）再跑 400 局，主公胜率只从 16% 提到 20%。瓶颈既不在目标选择
  也不在身份推断——4 名反贼从第一回合就有公开的集火目标，主公只多 1 点体力上限。
  **不要再在 AI 权重上调 8 人局平衡**；要改只能动规则层，那属于改玩法，需先与用户确认。
- 貂蝉【离间】用被弃置的那张牌作为决斗的载体（引擎没有无实体牌的结算路径）。
  可观察差别只有「那张牌会被当成造成伤害的牌」，曹操【奸雄】可能把它拿走。
- 丈八蛇矛的两张牌里，`DamageOptions.cardId` 只记主牌，奸雄只拿得走一张。

## 早期规则决定（继续有效，不要退回）

- 延时锦囊使用时**直接放入判定区，不开启无懈窗口**；到目标判定阶段、翻开判定牌前才逐人询问。
- 单数次无懈抵消，双数次恢复结算。
- 乐不思蜀/兵粮寸断被抵消后弃置；闪电被抵消后传给下一名合法角色。判定区后置先判。
- 闪电命中为黑桃 2～9，3 点无来源雷电伤害。
- 酒在出牌阶段限一次；增伤被下一张杀消费后也不能再次使用酒。

## 踩过的坑（按被坑次数排）

- **`preview_start` 用 `sgs` 配置**，不是 `web`。踩过两次。
- **技能注册了不等于用得出来。** 甘宁【奇袭】的 `viewAs` 一直在返回选项，
  而生成动作的地方只处理【杀】，把它全丢了。
  `tests/sanguosha-viewas.test.ts` 现在守着「每种产出的牌名都必须有人消费」。
- **多出口的状态机漏出口 = 整局卡死。** 方天画戟那一批压测抓到两次，
  所以 `continueSlash` 现在是唯一出口，`dealSlashDamage` 自己负责收尾。
- **插入点必须记账**：「成为目标时」的效果结算完会回到 `askSlashInterceptors`，
  不记 `interceptsDone` 的话它会把自己再问一遍。雌雄双股剑的「让对方摸一张」
  不消耗任何东西，压测直接死循环在 20002 步。
- **底部面板必须封顶**：选项一多就把牌桌顶出屏幕，用户报过。
- **联机的陈旧检查不能用 `baseSeq !== version`**：version 在 AI 每走一步、
  每条聊天时都会变，玩家点一下几乎必然被判陈旧。单真人 + AI 恰好躲过，两个真人必现。
- **写联机测试时**：房间状态是**广播**的，不能按「发一条等一条」读；
  业务拒绝会**连发两帧**（error + 权威状态），只读掉 error 会让后续断言读到过期数据。
- **`SanguoshaGame.restore` 必须重新调用 `registerSkillTriggers`。** 处理器序列化不了。
- **只存 seed 不够**，DO 醒来会从头推导随机序列，必须存 `rngState`。
- **dev 环境 HMR 会重复执行武将模块**，`registerSkillRuntime` 拒绝重复注册于是报错卡住。
  dev-only，硬刷新即可。不要为此放宽重复注册的检查。
- **`seq` 不是可靠的推进信号**：选将这类响应不会 bump seq，判断牌局有没有往前走要看 `decisions`。
- **联机本地调试要用 `127.0.0.1` 而不是 `localhost`**：会话 Cookie 是 SameSite=Lax，
  `localhost:5190` → `127.0.0.1:8787` 属于跨站，Cookie 发不出去。
- 不要给全局加宽泛的 CSS 选择器（`button {}` 之类），会改到麻将站的样式。
- 麻将的退出/离开确认框文案是用户明令禁止修改的，不要动。

## 三层验证都要跑

压测比单测更能抓规则边界的 bug；浏览器又能抓压测抓不到的（驱动没启动、按钮文案错、
面板顶出屏幕）；SSR 渲染测试能覆盖「浏览器里靠运气凑不出来的局面」。
这一轮里三层各自抓到过对方抓不到的问题。

## 接手后的最小自检

```powershell
Set-Location 'C:\Users\cr\Documents\work\crplay-sanguosha-dev'
git status --short --branch
npx vitest run
npm run typecheck
```

三步结果应与上方基线一致。不一致时先检查工作树是否被覆盖、是否漏掉 untracked 文件。

## 参考仓库

项目外参考目录：`C:\Users\cr\Documents\work\_crplay-sanguosha-references`。
`wmzy/sanguosha`（MIT）与 `maxi-max-dev/sanguosha-online` 仅研究架构，未复制源文件。
noname / FreeKill 是 GPL，只做规则参考，未读取或复制源码。
