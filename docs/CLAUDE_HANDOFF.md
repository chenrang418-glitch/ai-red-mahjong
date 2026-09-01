# 交接说明：CRPlay + 三国杀

更新时间：2026-09-01，codex 在 Claude 基线上继续更新。

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
- `origin/main` = `17158c9`（`feat(sanguosha): 主公技代打机制 + 刘备/孙权，曹操补上护驾`），CI 全绿，已部署。
- `feature/sanguosha` 的提交基线是 `d76222c`，比 `main` 多一个未部署提交。
- codex 在该提交之上继续完成联机接线，当前是**未提交工作树**；不要 reset/clean，也不要直接切分支。
- 部署方式：

  ```
  git checkout main && git merge --ff-only feature/sanguosha && git push origin main
  git checkout feature/sanguosha
  ```

## 验证基线（全部实测通过）

| 命令 | 结果 |
|---|---|
| `npx vitest run` | 43 文件 / **390 用例** |
| `npx playwright test` | **38 通过**（Chromium 34 + WebKit 4） |
| `npm run sanguosha:soak 150` | 5 人局与 8 人局各 150 局全部完成 |
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

### 武将 8 → 18（只登记技能完整实现的，没有空壳）

| 势力 | 武将 |
|---|---|
| 蜀 | 张飞、马超、关羽、赵云、黄月英、刘备（主公技激将） |
| 魏 | 甄姬、许褚、张辽、曹操（主公技护驾）、司马懿、夏侯惇、郭嘉 |
| 吴 | 甘宁、黄盖、孙尚香、孙权（主公技救援） |
| 群 | 华佗 |

### AI 阵营判断（这一轮最重要的修复）

原来反贼胜率 85%，根因是两个叠加：

1. `observeDamage` / `observeRecover` 写好了但**谁都没挂上事件流**，suspicion 永远全零，整套推断等于没跑；
2. 只有布尔的「是不是敌人」，没有「要保护谁」。开局 suspicion 全零，于是**忠臣眼里没有任何敌人**，
   只能按血量乱打，经常反过来打主公。

改成带符号的 `hostility()`，`PROTECTED` 表示绝不选为目标。
5 人局主公胜率 12% → 40%，反贼 85% → 44%。
**没有任何一处读隐藏身份**，`tests/sanguosha-ai-belief.test.ts` 专门守着这条。

## 联机：主链路已接线，尚未部署

`server/sanguosha-room-core.ts` + `tests/sanguosha-room-core.test.ts`（16 用例全过）。

已实现：座位管理、大厅准备/加电脑、开局、选将、指令处理
（respond / act / advance / chat / trustee / next-round / leave）、
按玩家过滤的视图与战报、超时由 AI 代打、掉线转托管、重连取消托管、
可序列化定时任务 + 局面指纹（`stageKey`）防止超时误伤新局面、下一局。

已完成 Worker DO、`SGS_ROOMS`/v3、`/api/sanguosha/rooms*`、D1 `0006` 公开目录、
运行时指令校验、`actionId + baseSeq` 去重/防陈旧、Vue 联机大厅与牌桌、断线重连入口。
`tests/sanguosha-worker.test.ts` 通过真实 Miniflare 覆盖创建/列表/动作/重连。

### 下一步

1. 用本地 Worker + 两个真实浏览器完成 5 人真人/AI 混合长局，重点点完选将、请求 UI、断线恢复、结束和再来一局。
2. 增加联机超时、托管接管、game-over/rematch 的 Worker 集成测试；当前核心单测有覆盖，但浏览器链路还不完整。
3. 继续剩余 7 将与 5 件装备，不要把未完整角色登记进武将包。
4. 更新管理员房间页，使其能区分/管理三国杀房间（当前麻将管理接口未改）。
5. 未经用户明确同意，不要 commit、push、应用远端 migration 或部署。

## 之后的优先级

### 装备（还有 5 件需要发问）

- **青龙偃月刀 / 贯石斧**：目标闪避之后发问，是安全挂起点，用 `askSkill` 就行。
  装备可以用 `equip:xxx` 这种 id 直接注册进 `registerSkillRuntime`——
  `getSkillRuntime` 是全局按 id 查的，不依赖武将技能表。
- **寒冰剑 / 麒麟弓**：在 `resolveDamage` 之前发问，也是安全点（`basic.ts` 里两处杀的伤害入口）。
- **方天画戟**：需要多目标【杀】，`beginSlash` 目前是单目标，改动较大，建议放最后。

### 武将 18 → 25

需要新机制的：吕布【无双】（要「需要两张闪」的求闪循环）、
貂蝉【离间】（要发起一次决斗）、大乔【流离】（转移【杀】目标）。

## 已知简化（都在代码注释里标明了，不是遗漏）

- 借刀杀人的【杀】没有走完整的杀结算管线。
- 铁索连环缺「重铸并摸一张牌」的替代用法。
- **8 人局反贼胜率仍有 74%~79%。这是结构性的**：主公技只有 3 个武将有，
  武将池补齐之前靠调 AI 权重拉不动，不要在权重上浪费时间。
- 遗计的 `distribute-cards` 界面分支只有引擎层单测，没在真实浏览器里点过
  （要凑齐「自己是郭嘉且被打」太靠运气）。分支代码本身审过。

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
