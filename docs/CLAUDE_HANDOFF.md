# 交接说明：CRPlay（红中麻将 + 三国杀）

更新时间：2026-09-01（用户要求暂停并更新基线时重写）。

## 先做什么

1. 工作目录固定为 `C:\Users\cr\Documents\work\crplay-sanguosha-dev`。
2. `git status --short --branch`。**应当在 `feature/sanguosha` 上，不是 `main`**——
   部署工作流由 `push: branches: [main]` 触发，留在 `main` 上提交推送会直接部署生产。
3. 阅读 `docs/sanguosha-progress.md`（按批次记录了每一步的根因和取舍）和本文件。
4. 未经用户明确同意，不要往生产环境写数据（建测试房间或用户）。

## Git 基线

- 仓库：`https://github.com/chenrang418-glitch/ai-red-mahjong.git`
- `origin/main` = `c672ef4`（`feat(sanguosha): 单机退出确认、结算名单、底部面板封顶`）
- `feature/sanguosha` 与 `main` 一致，**工作树干净，无未提交改动**。
- CI 全绿，已部署。生产 `https://crplay.cn` 实测：`/api/health` 返回 `{"ok":true}`，
  首页标题已是 `CRPlay`。
- 部署方式：

  ```
  git checkout main && git merge --ff-only feature/sanguosha && git push origin main
  git checkout feature/sanguosha
  ```

## 验证基线（2026-09-01 暂停时实测）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 49 文件 / **477 用例** |
| `npx playwright test` | **45 通过**（Chromium 41 + WebKit 4） |
| `npm run sanguosha:soak 250` | 5 人局与 8 人局各 250 局全部完成 |
| `npm run test:online:smoke` | 通过 |
| `npm run typecheck` / `typecheck:online` | 通过 |
| `npm run build` / `build:online` | 通过 |

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
- **武将 25 名**（标准包补齐，**只登记技能完整实现的，没有空壳**）：

  | 势力 | 武将 |
  |---|---|
  | 蜀 | 刘备（主公技激将）、关羽、张飞、诸葛亮、赵云、马超、黄月英 |
  | 魏 | 曹操（主公技护驾）、司马懿、夏侯惇、张辽、许褚、郭嘉、甄姬 |
  | 吴 | 孙权（主公技救援）、甘宁、吕蒙、黄盖、周瑜、大乔、陆逊、孙尚香 |
  | 群 | 华佗、吕布、貂蝉 |

### 引擎里的关键机制

| 机制 | 位置 | 说明 |
|---|---|---|
| 战报 | `engine/log.ts` | `describeEvent(state, event, viewerId)`，**按观看者过滤** |
| 技能发问 | `state.skillResolution` + `SkillHost.askSkill` + `SkillRuntime.resume` | 安全时机向玩家发问 |
| 延后发问队列 | `state.skillQueue` + `startQueued` | 「受到伤害后」的技能：触发抓事实排队，牌局干净了再问 |
| 主公技代打 | `SkillRuntime.surrogateResponders` | 护驾 / 激将 |
| 救援加成 | `SkillRuntime.rescueRecoverBonus` | 孙权【救援】 |
| 转化别名 | `state.cardAliases` + `effectiveCardName` | 延时锦囊的转化（大乔【国色】） |
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
6. **立绘**（基础设施完成，素材 0 / 25，**等用户提供素材**）：
   座位已改为四层结构、满幅立绘 + 文字描边，缺图时自动回退到文字底纹。
   接入规程见 `docs/sanguosha-portraits.md`。
   **不要自己去网上抓立绘**——原型阶段用过的无授权素材已按用户决定全部撤除。
7. **新增角色**（未开始）：标准包 25 名已满，再加要进军争 / 风火林山等扩展包。

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
