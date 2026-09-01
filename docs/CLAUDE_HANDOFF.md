# 交接说明：CRPlay + 三国杀

更新时间：2026-09-01，Claude 在 codex 基线上继续更新。

> 这份文件替换了 2026-08-31 那版。旧版里「武将完成度 0/25」「AI 未实现」
> 「单机 Vue 牌桌未实现」等描述都已经过期，不要再按那些结论行动。

## 先做什么

1. 工作目录固定为 `C:\Users\cr\Documents\work\crplay-sanguosha-dev`。
2. `git status --short --branch`。**应当在 `feature/sanguosha` 上，不是 `main`**——
   部署工作流由 `push: branches: [main]` 触发，留在 `main` 上提交推送会直接部署生产。
3. 阅读 `docs/sanguosha-progress.md`（按批次记录了每一步的根因和取舍）和本文件。
4. 未经用户明确同意，不要 commit / push / 部署，也不要往生产环境写数据（建测试房间或用户）。

## Git 基线

- 仓库：`https://github.com/chenrang418-glitch/ai-red-mahjong.git`
- `origin/main` = `7971904`（`feat: 站点更名 CRPlay，全站改用墨绿配色`），CI 全绿，已部署。
- `feature/sanguosha` 与 `main` 一致，工作树干净。
- 部署方式：

  ```
  git checkout main && git merge --ff-only feature/sanguosha && git push origin main
  git checkout feature/sanguosha
  ```

## 验证基线（全部实测通过）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 48 文件 / **463 用例** |
| `npx playwright test` | **43 通过**（Chromium 39 + WebKit 4） |
| `npm run sanguosha:soak 250` | 5 人局与 8 人局各 250 局全部完成 |
| `npm run typecheck` / `npm run typecheck:online` | 通过 |
| `npm run build` / `npm run build:online` | 通过 |

端口约定：麻将目录 dev 5180 / e2e 4173；本目录 dev **5190** / e2e **4183**。
`preview_start` 用 `sgs` 配置，不是 `web`。

## 现状：三国杀单机已经可玩

门户上状态是「可游玩」。单机流程：首页 → 单机游戏 → 设置人数/难度 → 选将 → 牌桌。
12 类 Request 全部有对应 UI，战报可看，退出确认可用，5～8 人局在竖屏/横屏都是一屏。

### 这一轮新增的引擎机制

| 机制 | 位置 | 用途 |
|---|---|---|
| 战报 | `engine/log.ts` | `describeEvent(state, event, viewerId)`，**按观看者过滤**，别人摸的牌只报张数 |
| 技能发问 | `state.skillResolution` + `SkillHost.askSkill` + `SkillRuntime.resume` | 安全时机（回合开始、摸牌阶段、主动技）向玩家发问 |
| 延后发问队列 | `state.skillQueue` + `SkillRuntime.startQueued` | 「受到伤害后」的技能：触发时抓事实排队，等牌局干净了再问 |
| 主公技代打 | `SkillRuntime.surrogateResponders` | 护驾 / 激将，覆盖求闪和锦囊要求打出牌两条路径 |
| 救援加成 | `SkillRuntime.rescueRecoverBonus` | 孙权【救援】 |
| 持久化 | `state.rngState` + `SanguoshaGame.serialize()` / `restore()` | 联机前提，见下 |

所有等待状态都是可序列化的，没有任何 `await 用户点击`。

### 武将 26 名（标准包补齐，只登记技能完整实现的，没有空壳）

| 势力 | 武将 |
|---|---|
| 蜀 | 张飞、马超、关羽、赵云、诸葛亮、黄月英、刘备（主公技激将） |
| 魏 | 甄姬、许褚、张辽、曹操（主公技护驾）、司马懿、夏侯惇、郭嘉 |
| 吴 | 甘宁、吕蒙、黄盖、周瑜、陆逊、大乔、孙尚香、孙权（主公技救援） |
| 群 | 华佗、吕布、貂蝉 |

### AI 阵营判断（这一轮最重要的修复）

原来反贼胜率 85%，根因是两个叠加：

1. `observeDamage` / `observeRecover` 写好了但**谁都没挂上事件流**，suspicion 永远全零，整套推断等于没跑；
2. 只有布尔的「是不是敌人」，没有「要保护谁」。开局 suspicion 全零，于是**忠臣眼里没有任何敌人**，
   只能按血量乱打，经常反过来打主公。

改成带符号的 `hostility()`，`PROTECTED` 表示绝不选为目标。
5 人局主公胜率 12% → 40%，反贼 85% → 44%。
**没有任何一处读隐藏身份**，`tests/sanguosha-ai-belief.test.ts` 专门守着这条。

## 联机：主链路已接线并部署

`server/sanguosha-room-core.ts` + `tests/sanguosha-room-core.test.ts`（16 用例全过）。

已实现：座位管理、大厅准备/加电脑、开局、选将、指令处理
（respond / act / advance / chat / trustee / next-round / leave）、
按玩家过滤的视图与战报、超时由 AI 代打、掉线转托管、重连取消托管、
可序列化定时任务 + 局面指纹（`stageKey`）防止超时误伤新局面、下一局。

已完成 Worker DO、`SGS_ROOMS`/v3、`/api/sanguosha/rooms*`、D1 `0006` 公开目录、
运行时指令校验、`actionId + baseSeq` 去重/防陈旧、Vue 联机大厅与牌桌、断线重连入口。
`tests/sanguosha-worker.test.ts` 通过真实 Miniflare 覆盖创建/列表/动作/重连。

### 联机浏览器验收（已做）
用本地 Worker（`npm run dev:online`）+ 浏览器完整走了一遍：
登录 → 建房 → 加电脑 → 开局 → 选将 → 牌桌 → 断线重连 → 观星界面 → 超时 AI 代打 → 出牌。

**必须用 `127.0.0.1` 而不是 `localhost`**：会话 Cookie 是 SameSite=Lax，
`localhost:5190` → `127.0.0.1:8787` 属于跨站，Cookie 发不出去。

抓到并修掉两个：刷新掉局（房间号没写进 URL）、观星界面上下移动没有任何提示。

### 两个真人的联机（已做）
`tests/sanguosha-worker.test.ts` 里有完整用例：双方各自拿到不同的 PlayerView、
客人也能发指令、都托管之后牌局自己往前走，全程盯着「别人的手牌必须是 null」。

写这个用例时抓到一个**会让联机实际上没法玩**的 bug：服务端原来要求
`baseSeq === version`，而 version 在 AI 每走一步、每条聊天时都会变，
玩家点一下几乎必然被判陈旧。单真人 + AI 恰好躲过，两个真人必现。详见进度文档第十三批。

### 下一步
1. 两个真人的**浏览器**验收还没做过（协议层已有集成测试覆盖，UI 层只验过 1 真人 + 4 AI）。
2. 遗计的 `distribute-cards` 界面分支只有引擎层单测，没在真实浏览器里点过。
3. 扩展包武将 / 更多游戏——需要先和用户确认范围。
4. 用户当前的指令是「持续工作、每完成一部分就提交部署、不用等部署结果」，
   在他说停之前不需要每次都问。

## 之后的优先级

### 装备

**ruleset-v1 的装备全部实现完毕。** 需要发问或需要动结算状态的都在
`src/sanguosha/engine/equipment-requests.ts`：贯石斧、青龙偃月刀、寒冰剑、麒麟弓、
雌雄双股剑、丈八蛇矛、方天画戟。大乔【流离】和貂蝉【离间】也在这个文件里，
因为它们同样要动引擎内部状态（放进武将数据会形成 import 环）。

装备用 `equip:` 前缀的 id 注册进 `registerSkillRuntime`——`getSkillRuntime`
是全局按 id 查的，不依赖武将技能表。

**丈八蛇矛和方天画戟不要按组合枚举成动作**：6 张手牌配 4 个目标就是 60 条，
界面上选中一张牌会冒出 20 个按钮，手机上没法用。现在是「一个按钮 → 选牌 → 选目标」
的两步交互。

### 【杀】的结算管线

多目标（方天画戟）靠 `SlashResolutionState.remainingTargetIds`，
`continueSlash` 是**唯一**的「这个目标结算完了」出口，三条收尾路径全部汇到它。
每个会结束一个目标的装备特效都必须在最后调它——漏掉就是整局卡死，压测抓到过两次。

关键前提：**一个人只能装一把武器**，所以方天画戟和青龙/贯石斧/寒冰剑/麒麟弓
不会同时出现，多目标不必和它们纠缠。

## 已知简化（都在代码注释里标明了，不是遗漏）

- 借刀杀人的【杀】没有走完整的杀结算管线。
- 铁索连环缺「重铸并摸一张牌」的替代用法。
- **8 人局反贼胜率约 76%，已经用实验证明是结构性的**：临时让忠臣直接读到真实身份
  （作弊到底的 AI）再跑 400 局，主公胜率只从 16% 提到 20%。瓶颈既不在目标选择
  也不在身份推断——4 名反贼从第一回合就有公开的集火目标，而主公只多 1 点体力上限。
  **不要再在 AI 权重上调 8 人局平衡**，要改只能动规则层，那属于改玩法，需先与用户确认。
- 遗计的 `distribute-cards` 界面分支只有引擎层单测，没在真实浏览器里点过
  （要凑齐「自己是郭嘉且被打」太靠运气）。分支代码本身审过。
- 延时锦囊的转化已经支持了：`SanguoshaState.cardAliases` 记住每张牌「被当作什么用」，
  `moveCard` 在牌离开结算区域时清掉。
- 貂蝉【离间】用**被弃置的那张牌**作为决斗的载体（引擎没有无实体牌的结算路径）。
  可观察差别只有「那张牌会被当成造成伤害的牌」，曹操【奸雄】可能把它拿走。
- 借刀杀人现在走完整的杀结算（仁王盾挡得住、无双生效、流离转得走），
  不再是之前那套简化流程。
- 丈八蛇矛的两张牌里，`DamageOptions.cardId` 只记主牌，奸雄只拿得走一张。

## 早期规则决定（继续有效，不要退回）

- 延时锦囊使用时**直接放入判定区，不开启无懈窗口**；到目标判定阶段、翻开判定牌前才逐人询问。
- 单数次无懈抵消，双数次恢复结算。
- 乐不思蜀/兵粮寸断被抵消后弃置；闪电被抵消后传给下一名合法角色。判定区后置先判。
- 闪电命中为黑桃 2～9，3 点无来源雷电伤害。
- 酒在出牌阶段限一次；增伤被下一张杀消费后也不能再次使用酒。

## 踩过的坑

- **请求 id 必须唯一。** 主公技代打会在同一个 `seq` 里连着问好几个人，
  `request-${seq}` 会撞 id，触发压测的死锁守卫，回放也会对不上。现在带上了 `decisions.length`。
- **`SanguoshaGame.restore` 必须重新调用 `registerSkillTriggers`。** 处理器是运行时代码，序列化不了。
- **只存 seed 不够。** DO 醒来后会从头推导随机序列，和休眠前发散，所以必须存 `rngState`。
- **dev 环境 HMR 会重复执行武将模块**，`registerSkillRuntime` 拒绝重复注册于是报错卡住。
  这是 dev-only 现象，硬刷新即可。不要为此放宽重复注册的检查——那是条有用的保护。
- **三层验证都要跑**：压测比单测更能抓规则边界的 bug，浏览器又能抓压测抓不到的
  （比如驱动没启动、按钮文案错）。这一轮里三层各自抓到过对方抓不到的问题。
- 不要给全局加宽泛的 CSS 选择器（`button {}` 之类），会改到麻将站的样式。
- 退出/离开确认框的文案是用户明令禁止修改的，不要动。
- **`preview_start` 读的是麻将目录的 `.claude/launch.json`**，配置名要用 `sgs`（5190），
  用 `web` 会起到麻将项目（5180）。这个坑踩过两次。
- **技能注册了不等于用得出来。** 甘宁【奇袭】的 `viewAs` 一直在返回选项，
  而生成动作的地方只处理【杀】，把它全丢了。
  `tests/sanguosha-viewas.test.ts` 现在守着「每种产出的牌名都必须有人消费」。
- `seq` 不是可靠的推进信号：选将这类响应不会 bump seq，判断牌局有没有往前走要看 `decisions`。
- **写联机测试时**：房间状态是**广播**的，不能按「发一条等一条」读；
  业务拒绝会**连发两帧**（error + 权威状态），只读掉 error 的话，
  那份旧状态会在下一次等待里被当成新消息返回，让断言读到过期数据。
- **插入点必须记账**：「成为目标时」的效果结算完会回到 `askSlashInterceptors`，
  不记 `interceptsDone` 的话它会把自己再问一遍。雌雄双股剑的「让对方摸一张」
  不消耗任何东西，压测直接死循环在 20002 步。

## 参考仓库

项目外参考目录：`C:\Users\cr\Documents\work\_crplay-sanguosha-references`。
`wmzy/sanguosha`（MIT）与 `maxi-max-dev/sanguosha-online` 仅研究架构，未复制源文件。
noname / FreeKill 是 GPL，只做规则参考，未读取或复制源码。

## 接手后的最小自检

```powershell
Set-Location 'C:\Users\cr\Documents\work\crplay-sanguosha-dev'
git status --short --branch
npx vitest run
npm run typecheck
```

三步结果应与上方基线一致。不一致时先检查工作树是否被覆盖、是否漏掉 untracked 文件。

## 站点外观（2026-09-01 用户指定）

- 站点叫 **CRPlay**，不再叫「红中麻将」。标签页标题、iOS 主屏名称、站点描述都已改。
- **配色统一定义在 `src/styles/root.css` 的 `:root`**（`--ink-*` / `--accent-*`），
  不要再在组件里写死深色值——以前散在七八处，改一处必然漏别处。
- 底色是墨绿 `#1d332a`，**保留径向渐变的杂色，不要做成纯色块**。
- 三国杀主色是**金色**（和门户卡片的 `#d6aa55` 对齐），麻将主色是**红色**。
- 两个游戏的首页结构 **1:1 对齐**：顶栏 → 居中 hero（印章/小标注/标题/说明）→
  三个入口（金/红/绿）。改一边就要改另一边，`tests/e2e/responsive.spec.ts`
  会在三种视口下逐项比对实际渲染。
- `tests/e2e/portal.spec.ts` 守着「三个页面读到同一个 `--ink-bg-top`」和主文字亮度。
