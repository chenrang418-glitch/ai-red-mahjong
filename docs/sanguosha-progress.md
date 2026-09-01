# CRPlay 三国杀开发进度

> 本文档是持续更新的交接记录。任何后续开发者开始工作前，应先阅读本文档，再核对当前 Git 状态和远端 `main`。

## 当前基线

- 工作目录：`C:\Users\cr\Documents\work\crplay-sanguosha-dev`
- 上游仓库：`https://github.com/chenrang418-glitch/ai-red-mahjong.git`
- **当前分支：`feature/sanguosha`**（Claude 接手时从 `main` 切出，见下方「工作分支与端口」）
- 基线分支：`main`
- 基线提交：`ac5c448d632f5b34ac9da18550107990ba9eda61`
- 基线提交说明：`fix: 堵住牌序与暗牌泄露，修阶段被外围事件重置，补运行时校验`
- 基线获取时间：2026-08-31（Asia/Shanghai）
- 部署限制：本任务只做代码、测试和本地验证，不自动部署生产环境。

### 2026-08-31 23:11 交接快照

- 已执行 `git fetch origin main`；`HEAD` 与 `origin/main` 仍均为 `ac5c448d632f5b34ac9da18550107990ba9eda61`，ahead/behind 为 `0/0`。
- 当前工作树为**有意保留的未提交开发状态**：9 个 tracked 文件被修改，另有 42 个 untracked 文件（本交接文档创建后为 43 个）。不要执行 `git reset --hard`、`git clean`、切换分支或重新 clone 覆盖。
- 没有 commit、push、PR、远端 migration 或生产部署。
- codex 交接时的验证：三国杀 61/61；全量 Vitest 255/255。
- **Claude 接手后的最新验证（见文末「最新测试结果」）：三国杀 78 项；全量 Vitest 266/266；
  Playwright 30/30 已重跑，麻将零回归。**
- Claude 开始前应先阅读 `docs/CLAUDE_HANDOFF.md`、本文档、`docs/sanguosha-architecture.md` 和 `docs/sanguosha-ruleset-v1.md`，再运行 `git status --short --branch`。

## 工作分支与端口（Claude 接手时新增）

这三条是用户点名要处理的风险，已经落实，后续开发必须继续遵守。

1. **留在 `feature/sanguosha`，不要回到 `main`。**
   `.github/workflows/deploy-cloudflare-pages.yml` 是 `push: branches: [main]` 触发的，
   在 `main` 上提交并推送会直接把生产麻将部署出去，而任务书明确禁止自动部署。
   codex 的交接文档里写的是「确认正在 main」，那是接手前的状态，现在以本节为准。

2. **端口必须和生产 checkout 错开。**
   本目录是麻将仓库的第二份 checkout，`work/ai-red-mahjong` 是稳定的生产 checkout。
   Playwright 的 `reuseExistingServer: true` 会连上任何已经占着该端口的 dev server——
   两边同时开着时，测试会静默跑在另一份代码上，而且全绿。已经改开：

   | checkout | dev server | Playwright |
   | --- | --- | --- |
   | `ai-red-mahjong`（生产） | 5180 | 4173 |
   | `crplay-sanguosha-dev`（本项目） | 5190 | **4183** |

3. **不要往全局 CSS 加宽泛选择器。**
   `src/styles/main.css` 现在只由麻将 `App.vue` 加载，跟着麻将 bundle 懒加载；
   `src/styles/root.css` 是门户用的，全局只保留一条 `* { box-sizing }`。
   在门户或三国杀里写 `button {}` / `div {}` 会直接改掉麻将全站的观感。

## 保护边界

- 不重写或重构现有麻将规则、状态机、AI、胡牌/碰杠逻辑和联机协议。
- 保留旧分享链接 `/?room=ABC234` 和 `/#admin` 行为。
- 仅允许为 RootApp、游戏中心、CSS 隔离和 Worker 路由做最小接线。
- 不提交、不推送、不部署，除非用户之后明确要求。
- 单机与联机三国杀必须共用同一纯 TypeScript Engine。
- 联机状态必须服务端权威，并按玩家裁剪隐藏信息。

## 已完成

### 2026-08-31：仓库与基线审计

- 在 `work` 下新建目标目录并从远端克隆最新 `main`。
- 再次执行 `git pull --ff-only origin main`，结果为 `Already up to date`。
- 克隆后工作区洁净。
- 已阅读顶层结构、入口、构建与测试配置、Wrangler 配置、迁移列表、README、第三方声明和主要 E2E 测试；正在继续逐文件审计实现。
- 使用现有 `package-lock.json` 执行 `npm ci`，未升级依赖，审计结果为 0 漏洞。

### 2026-08-31：Phase A 游戏中心与保护性接入

- 新增 `src/RootApp.vue`，顶层统一解析 URL，支持前进、后退和刷新恢复。
- 新增数据驱动的 `src/portal/gameManifest.ts` 与 `GamePortal.vue`。
- 红中麻将和三国杀 App 均使用动态 `import()`；Vite 产物确认麻将、三国杀各自形成独立 chunk，访问门户不会加载完整麻将 App。
- URL 兼容已实现并测试：
  - `/`：游戏中心；
  - `/?game=mahjong`：麻将；
  - 旧 `/?room=ABC234`：自动进入麻将分享流程；
  - `/?game=sanguosha`：三国杀；
  - `/?game=sanguosha&room=ABC234`：由顶层归属三国杀；
  - `/#admin`：仍进入原管理员功能。
- 麻将原 `App.vue` 没有搬迁；只增加 CSS 懒加载和向上返回游戏中心事件。
- 麻将模式首页只新增“返回游戏中心”按钮；管理员“返回游戏”改为显式进入 `?game=mahjong`。
- 新增独立 namespace 门户样式；三国杀占位首页使用 `.sgs-app` namespace，并明确标注尚未可玩，避免假完成。
- 三国杀 manifest 当前暂时显示“开发中”；只有完成真实可玩性后才能改为“可游玩”。

### 2026-08-31：Phase B 第一段规则底座

- 在项目外参考区审计：
  - `wmzy/sanguosha` commit `177ca5f24cd985458fd6e38bb036d45fc414386b`，MIT；研究分层与视图思想，当前未复制源文件。
  - `maxi-max-dev/sanguosha-online` commit `8efcf8815f138a959259fa9ca355b9d12822a636`，未发现明确许可证；只研究事件溯源、DO 与玩家视图架构，没有复制代码。
- 规则资料核对：BWIKI 标准包 108、军争篇 52，以及官方身份模式介绍。
- 新增纯 TypeScript Engine 基础：
  - `types.ts`：玩家、卡牌、手牌/装备/判定区、牌堆/弃牌堆/处理区与可序列化状态；
  - `rng.ts`：统一确定性 `GameRng`，支持 snapshot；
  - `events.ts`：覆盖开局、阶段、用牌、伤害、濒死、死亡、移动和判定的事件总线；
  - `requests.ts`：12 类 Request、穷尽检查和运行时 validation；
  - `skills/types.ts`：11 类技能能力与 subSkill；
  - `modes/identity.ts`：经典 5～8 人身份表与独立胜负判定；
  - `distance.ts`：死亡座次、+1/-1 马、武器与技能修正统一计算；
  - `view.ts`：隐藏他人手牌、未公开身份与牌堆顺序；
  - `game.ts`：`new SanguoshaGame({ seed, setup })`、确定性身份/洗牌/发牌和回放记录骨架。
- `data/ruleset-v1/deck.ts` 已逐张录入 160 张牌，含花色、点数、属性、类别、装备槽和武器范围。
- 第二小节补充 `actions.ts`、`zones.ts` 与 `turn.ts`：合法 action 双重校验、单一移动牌入口、装备替换、牌张守恒检查，以及可序列化/可暂停的六阶段推进；有 pending Request 时禁止推进。
- 第三小节补充 `draw.ts` 与 `damage.ts`：
  - 伤害依次经过 `BeforeDamage`、`DamageCaused`、`DamageInflicted`、扣减体力、`Damaged`、`AfterDamage`；处理器可修改或取消伤害；
  - 体力降至 0 或以下后进入可序列化 `DyingState`，按当前回合角色起的座次顺序生成 `rescue` Request；
  - 桃可救援任意濒死角色，酒仅允许濒死者自救，同一响应者可连续使用多张救援牌；
  - 无人救援后依次结算死亡、公开身份、弃置死亡角色区域、击杀反贼摸三张、主公误杀忠臣弃置手牌和装备、统一胜负判定；
  - 救援响应经过 runtime validation 并写入 decision log，没有 Promise resolver 或等待中的 async 调用栈；
  - 新增统一确定性摸牌入口，牌堆耗尽时使用本局 `GameRng` 重洗弃牌堆。
- 第四小节补充：
  - `PlayerView` 仅返回属于观察者自己的 pending Request，其他玩家只能看到规则公开的濒死角色和所需回复量；
  - `invariants.ts` 统一校验玩家/座次/体力/装备槽/Request/濒死/结算状态及牌张守恒，可直接用于后续 soak 与服务端提交后防线；
  - `phase.ts` 让判定、摸牌、出牌、弃牌阶段产生真实 Engine 行为；摸牌阶段摸两张，超出体力上限时生成可序列化、强制定量的弃牌 Request；
  - `SanguoshaGame.respond()` 已统一分发救援与阶段弃牌响应，两者均验证归属、候选和当前上下文并写入 decision log。
- 第五小节建立第一版可序列化卡牌结算：
  - `engine/cards/basic.ts` 由完整 state 生成当前玩家的 `LegalAction[]`，客户端不自行判断距离、目标或卡牌用途；
  - 打通【杀】→目标私有【闪】Request→闪避或伤害；杀造成濒死时，实体牌保留在处理区，救援/死亡结束后再恢复并收束原结算；
  - 【桃】在受伤时回复一点体力；【酒】每个出牌阶段限一次并只强化下一张杀；回合结束重置杀/酒计数；
  - 装备牌通过统一用牌入口进入明确装备槽，替换的旧装备进入弃牌堆；装备特效仍未实现；
  - 【无中生有】接入完整无懈响应链：按当前回合座次逐人询问，打出【无懈可击】后重新开始响应轮，奇数次取消、偶数次恢复生效；延时锦囊不在使用时开启此窗口；
  - 卡牌结算状态、当前响应 Request、处理区实体牌均可序列化，并加入 invariant 一致性检查；玩家视图公开已使用的牌和目标，但仅向当前响应者发送私有 actionIds。
- 第六小节补齐属性传导和第一版判定区：
  - 火焰/雷电伤害命中横置角色后，按受伤目标之后的座次依次传播相同基础点数并解除相关横置；普通伤害不传播；
  - `state.damageChain` 保存剩余目标。任一传播目标濒死时队列暂停，救援/死亡结束后继续，全部传播完成后才恢复原卡牌结算；
  - 【乐不思蜀】【兵粮寸断】【闪电】使用后直接进入判定区，并限制同名延时锦囊重复放置；兵粮目标由统一距离入口限制为距离 1；
  - 判定阶段按后置先判取出延时锦囊，在翻开判定牌前开启可被再次无懈的响应链；单数次无懈抵消本次延时锦囊，双数次恢复结算；
  - 未被抵消时从牌堆顶亮出实体判定牌并发出 JudgeStart/JudgeResult/JudgeEnd；非红桃乐跳过出牌、非梅花兵粮跳过摸牌；
  - 闪电黑桃 2～9 造成无来源 3 点雷电伤害，否则移动给下一名可放置角色；闪电导致濒死时 `state.judgment` 可序列化暂停并在救援结束后恢复；
  - 乐/兵粮被无懈抵消后弃置；闪电被抵消后不翻判定牌并传给下一名合法角色。
- 新增正式架构文档、ruleset-v1 文档和第三方参考记录。
- 当前这只是底座，尚不能进行完整回合，武将完成度仍为 0/25。

## 基线测试结果

以下结果均在任何功能修改之前获得：

| 命令 | 结果 |
| --- | --- |
| `npm run test:run` | 通过：20 个测试文件、188 个测试 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:online` | 通过 |
| `npm run build` | 通过 |
| `npm run build:online` | 通过，Wrangler dry-run 成功 |
| `npm run test:online:smoke` | 通过 |
| `npm run test:e2e` | 首次运行 Chromium 17/17 通过；WebKit 因本机缺浏览器而未启动 |
| `npx playwright test --project=webkit` | 安装匹配版本 WebKit 后通过：4/4 |

WebKit 的 4 项失败不是产品断言失败，而是本机缺少 Playwright WebKit 可执行文件：

```text
Executable doesn't exist at
C:\Users\cr\AppData\Local\ms-playwright\webkit-2336\Playwright.exe
```

已执行 `npx playwright install webkit` 安装匹配的 WebKit 2336，并重跑 4 项全部通过。因此原始代码基线没有已知测试失败；首次 E2E 非零退出仅由测试运行环境缺件造成。

## Phase A 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:run` | 通过：21 个测试文件、194 个测试（含 6 个 URL 单测） |
| `npm run build` | 通过；门户主 JS 约 88.56 kB，麻将 App 独立 JS chunk 约 122.59 kB，三国杀占位独立 JS chunk 约 1.34 kB |
| `npm run typecheck:online` | 通过 |
| `npm run build:online` | 通过，Wrangler dry-run 成功；未部署 |
| `npm run test:online:smoke` | 通过 |
| `npm run test:e2e` | 通过：30/30（Chromium 26，WebKit 4） |
| `git diff --check` | 通过（仅有 Windows LF/CRLF 提示，无空白错误） |

新增 E2E 覆盖门户 7 种验收尺寸、横向溢出、三张游戏卡、动态入口、前进/后退/刷新、旧房间分享和管理员入口。原麻将响应式与视觉回归用例保持全部通过。

另用真实 Vite 页面检查了 1440×900 与 393×852 门户截图：三张卡片、状态、中文排版与响应式布局正常，没有发现裁切、重叠或页面级滚动；截图仅保存在 Codex 本地可视化目录，未加入仓库。

Phase B 当前新增 9 个测试文件、61 项规则底座与卡牌结算测试。判定时机纠正后的最新合并验证为 **30 个测试文件、255 项全部通过**；`typecheck`、`typecheck:online`、前端 `build`、Worker `build:online` dry-run、麻将联机 smoke 和 `git diff --check` 均通过。未部署。

## 当前仓库要点

- 前端：Vue 3 + TypeScript + Vite，当前由 `src/main.ts` 挂载 `src/RootApp.vue`；原麻将仍完整保留在 `src/App.vue` 并按需加载。
- 麻将单机：`src/game/**`、`src/composables/useMahjongGame.ts`。
- 麻将联机：`server/room-core.ts`、`server/worker.ts`、`src/composables/useOnlineGame.ts`、`src/online/types.ts`。
- Cloudflare：`MahjongRoom` + `MahjongLobby` Durable Objects，D1 migration 已到 `0005_remove_player_stats.sql`。
- Wrangler DO migration tag 当前已到 `v2`；新增三国杀 DO 必须追加新 tag，不能改历史 migration。
- 当前测试脚本会先构建 Worker，Vitest 基线共 188 项。

### 2026-08-31：Claude 接手，逐目标锦囊结算帧 + 8 张即时锦囊

按 `docs/CLAUDE_HANDOFF.md` 里「建议下一开发顺序」的第 1～3 条推进。

**引擎结构**

- `TrickResolutionState` 从单目标 `targetId` 扩成 `targetIds[] + targetIndex`。
  无懈可击取消的是「这张牌对某一个目标的效果」，不是整张牌——
  万箭齐发被一个人无懈掉，其他目标照样要出闪。
- 锦囊效果从硬编码 `if (cardName === '无中生有')` 改成 `applyTrickEffect` 分派。
- 新增 `engine/cards/host.ts`（`CardEngineHost` + 使用/收束/暗槽等共用件）
  和 `engine/cards/tricks.ts`（即时锦囊）；`basic.ts` 只留基本牌并委派，
  正是交接文档里点名要避免的「所有牌塞进 basic.ts」。
- 效果阶段要等人决策时一律写进可序列化的 `resolution.effect`，不用 await 挂起。
- `PlayerView.cardResolution` 改为下发 `targetIds[]`，杀这类单目标牌也包成一个元素，
  客户端只需处理一种形状。

**新实现的即时锦囊（11 张全部完成，均有测试）**

桃园结义、铁索连环、南蛮入侵、万箭齐发、决斗、过河拆桥、顺手牵羊、
五谷丰登、火攻、借刀杀人（无中生有迁移到新框架）。

**即时锦囊层至此完成，ruleset-v1 的锦囊不再有缺口。**

要点：
- 过河拆桥不受距离限制，顺手牵羊受距离 1 限制。
- 拆桥/顺手选目标手牌时，Request 里只给不含牌面信息的暗槽 `hidden:<playerId>:<index>`，
  真实 cardId 只在服务端解析——有测试断言真实 id 不出现在 Request 的任何字段里。
- 南蛮/万箭/决斗/火攻/借刀造成濒死时暂停，救援结束后继续结算剩余目标。
- 五谷丰登在第一个目标结算前一次性亮牌到处理区，整张牌共用这批牌，中途不重新亮。
- 火攻两段结算：目标展示一张手牌（只公开这一张），使用者再决定是否弃同花色牌。
- 借刀杀人两段结算：目标先选受害者，再决定出杀还是交武器；出了杀由受害者响应闪。

**行为变更（有意）**

手上没有无懈可击的玩家不再被询问，少一轮无谓往返。
原「锦囊→无懈→再无懈」用例的中间态断言随之调整为断言最终结果（更强），
不是放宽断言。

### 2026-08-31：装备特效第一批（纯规则修正类）

新增 `engine/equipment.ts`。这一批全部是「不需要额外 Request」的规则修正，
所以现在就能做完整测试，不必等 Request UI。

| 装备 | 效果 |
| --- | --- |
| 仁王盾 | 黑色【杀】完全无效——连闪都不问，直接收牌 |
| 藤甲 | 普通【杀】/南蛮/万箭无效；火焰伤害 +1 |
| 白银狮子 | 受到 >1 点伤害压成 1 点；失去它时回复 1 点 |
| 古锭刀 | 目标没有手牌时，【杀】伤害 +1 |
| 诸葛连弩 | 出牌阶段【杀】次数不受限 |
| 八卦阵 | 需要出【闪】时可改为判定，红色视为出了一张【闪】 |
| 五匹马 | 已经由 `distance.ts` 统一处理，无需单独实现 |

两个接入点值得记住：
- 「完全无效」在 `beginSlash` / 锦囊效果分派处就短路，**不产生任何响应 Request**。
  如果放到伤害阶段再挡，玩家会被要求出一张根本没意义的闪。
- 伤害数值修正 `adjustDamageAmount` 放在技能时机**之前**：装备是牌本身的规则，
  技能仍然可以在随后的 BeforeDamage/DamageCaused/DamageInflicted 里继续改或取消。
  白银狮子的封顶必须排在所有加成之后。
- 失去装备的钩子 `handleEquipmentLost` 在三处调用：被替换、被拆桥、被顺手牵羊。

八卦阵确立了「装备拦截响应」这个模式：它不是手牌，但同样是「打出闪」的一条途径，
所以必须作为一个 actionId 出现在响应请求的合法动作里——
**服务端支持不等于前端点得到**，这是参考项目踩过的坑，有测试专门断言它在 actionIds 中。
同时把判定抽成 `performJudgment(host, playerId, reason)`，
之后司马懿【鬼才】这类改判技能只要挂在 JudgeResult 时机上。

### 2026-09-01：武将/技能系统立起来，蜀 5 将完整实现

**这是剩余部分里最大的架构未知数，现在跑通了。**

新增：
- `data/characters/types.ts`、`data/characters/standard.ts`：武将数据 + 技能说明
  （说明只有一份，规则页直接读它，不维护副本）。
- `engine/skills/runtime.ts`：技能运行时注册表，支持
  触发技（挂事件总线）、锁定技、距离修正、转化技。
- 选将流程：`dealGenerals()` 发候选 + `choose-general` 响应装配武将和体力上限。

**已完整实现的 5 将（技能全部有运行时实现和测试）：**

| 武将 | 技能 | 能力类型 |
| --- | --- | --- |
| 张飞 | 咆哮 | 锁定技（出杀不限次） |
| 马超 | 马术 | 距离修正 |
| 关羽 | 武圣 | 转化技（红牌当杀） |
| 赵云 | 龙胆 | 双向转化技（杀↔闪，含响应阶段） |
| 黄月英 | 集智 + 奇才 | 触发技 + 锁定技（锦囊无距离限制） |

四条被反复验证的设计约束：

1. **技能不自己算距离、不自己判出杀次数。**
   马术走 `distance.ts` 的统一公式，咆哮走和诸葛连弩同一个 `hasUnlimitedSlash` 入口。
2. **转化技必须产出真正的 LegalAction。**
   「关羽的红牌可以当杀」不能靠前端猜——引擎把「用这张红牌当杀打某人」
   作为独立动作发出去，原用途的动作同时保留，**由玩家选用途**。
   写测试时这一点直接把我自己绊了一下：无中生有是红牌，
   关羽手上它同时是「锦囊」和「杀」两条动作，测试必须显式挑用途。
   这正是任务书要的行为。
3. **响应阶段的转化同样要进 actionIds。**
   龙胆把【杀】当【闪】打出，和八卦阵一样必须出现在响应请求的合法动作里。
4. **触发器是运行时代码，不进 GameState。**
   `registerSkillTriggers` 在构造时调用；**Durable Object 恢复后必须重新调用**。

顺带修了一个真 bug：`dealGenerals` 在武将数量不足以分给所有玩家时，
会静默给最后一个人发一份空候选，导致他永远选不了将。现在直接报错。

### 2026-09-01：AI + 无头压测，并借此抓出四个引擎 bug

**压测是这一批真正的产出。**AI 本身只是启发式，但「全 AI 打完整局」这件事
一上来就抓出了四个只有长对局才会暴露的问题：

1. **invariant 漏了两种合法状态**：判定阶段的无懈请求挂在 `state.judgment` 上、
   不在 `cardResolution`；以及我这轮新增的 `awaiting-effect` 阶段本来就可以挂着请求。
   原来的断言把这两种都当成非法。
2. **当前回合角色在自己回合里死掉后，剩下的阶段还在继续跑**——
   摸牌、出牌、弃牌发生在一个死人身上。现在 `advancePhase` 检测到角色已死就直接收束回合。
3. **过河拆桥/顺手牵羊的目标，在问无懈那一轮把最后一张牌当【无懈可击】打了出去**，
   轮到效果结算时身上已经没牌，引擎却发了一个「从零张牌里选一张」的必然非法 Request。
4. `dealGenerals` 在武将不够分时静默发空候选（上一批修的）。

新增
- `ai/belief.ts`：身份推测。**AI 只能读 PlayerView，未公开身份在那里就是 null**，
  所以阵营判断只能靠行为累加怀疑度——打主公加分、救主公减分。
  「困难 AI 偷看身份」在类型层面就做不到。
- `ai/index.ts`：出牌决策 + **对全部 12 种 Request 的响应**，用 assertNever 强制穷尽。
  漏掉任何一种，压测就会卡在那个请求上。
- `ai/soak.ts`：全 AI 无头对局，每一步都跑牌张守恒和 invariant，失败信息带 seed 可精确复现。
- `scripts/sanguosha-soak.mjs` + `npm run sanguosha:soak`：验收前的大批量跑。

补齐到 8 个武将（5～8 人局都能开）：新增甘宁【奇袭】、黄盖【苦肉】、孙尚香【枭姬】。
枭姬直接挂在上一批做的 `handleEquipmentLost` 钩子上，没有另开一套。
苦肉确立了主动技模式：技能自己报告「现在能不能发动」并产出 LegalAction，前端不猜。

压测结果（`npm run sanguosha:soak 150`）：

| 人数 | 局数 | 完成 | 平均回合 | 最长 |
| --- | --- | --- | --- | --- |
| 5 | 150 | 150 | 28 | 90 |
| 8 | 150 | 150 | 27 | 83 |

**已知问题：反贼胜率明显偏高**（5 人局 122/150，8 人局 146/150）。
这是 AI 策略问题不是引擎问题——AI 不会保护主公，也不会针对性集火。
需要在目标估值里加入「主忠方要优先保主公」的权重，属于 AI 调优，留待后续。

### 2026-09-01：Vue 牌桌，单机真正可玩

三国杀在门户里的状态已经从「开发中」改成「可游玩」——**单机能从头打到尾了**。

新增
- `composables/useLocalSanguosha.ts`：单机驱动。**和联机共用同一个 Engine**，
  区别只在于「谁来提交决策」：这里本地 AI 替其他座位，联机那边由 DO 收各家操作。
- `components/SgsCard.vue`：牌。`card` 为空即牌背，
  **牌背路径下 DOM 里不出现任何牌面信息**（牌名、花色、点数、aria-label 都没有）。
- `components/SgsSeat.vue`：座位。别人只显示手牌张数、装备区、判定区，
  未公开身份显示「？」——PlayerView 里本来就是 null，界面想显示也没有。
- `components/SgsRequestDock.vue`：**12 种 Request 每一种都有真正能点的入口**，
  最后还有一个兜底分支：将来新增 Request 却忘了做界面时会显式报出来，而不是静默卡住。
- `components/SgsTable.vue`：牌桌。5～8 人只改 grid 列数，不为每种人数复制结构。
- 单机配置页、选将页、规则页、结算弹窗。规则页的技能说明直接读武将数据，不维护第二份。

浏览器里实测抓到的两个 bug
1. **选将阶段驱动器直接退出**：`advanceUntilHuman` 开头是 `if (status !== 'playing') return`，
   于是 AI 永远轮不到选将，界面停在「其他角色选将中…」；组件又抢先调 `beginPlaying`，
   报「还有玩家没有选将」。现在选将阶段也由驱动器接管，组件不插手。
2. **响应按钮显示成「使用」而不是「打出【闪】」**：卡牌 id 本身含冒号
   （`ruleset-v1:standard:57`），按 `split(':')` 取第二段只拿到 `ruleset-v1`。改成按第一个冒号切。

**已知缺口（没有掩盖）**：战报面板是空的。结构化战报必须由引擎事件生成，
而 PlayerView 目前不下发事件流；按任务书「不要让 UI 自己猜发生了什么」，
我没有用界面推断去伪造日志，而是在面板里如实写明还没接上。

## 下一步

1. 实现**剩余需要 Request 的装备特效**：麒麟弓（弃马）、
   青龙偃月刀（追杀）、贯石斧（弃两张硬吃闪）、寒冰剑（改判为弃牌）、
   方天画戟（最后一张牌可多目标）。
   雌雄双股剑依赖武将性别、丈八蛇矛依赖 ViewAs 转化，要等武将层。
2. 再建立 character/pack 注册；技能没完整实现的武将不要标记为完成。
3. 顺序不要乱：卡牌底座 → 武将 → AI → Vue 牌桌 → Cloudflare 联机。
4. 每完成一个可交接小节，继续更新本文档并执行相关测试。

**已知的规则简化，后续要补**：
- 借刀杀人里目标打出的【杀】没有走完整的出杀流程（不触发武器特效、不计入出杀次数），
  只做了「出杀 → 受害者响应闪 → 伤害」。等装备特效做完之后应该改成复用同一条结算路径。
- 铁索连环目前只实现横置用法，还没有「当两张牌摸」的替代用法。

## 尚未完成

- Phase B 仍缺：选将流程、完整 replay reducer（目前只存 `seed + setup + decisions`，
  还没有能从 decisions 重建整局的 runner）。逐目标锦囊结算帧已完成。
- Phase C 仍缺：**需要 Request 的装备特效**（麒麟弓/青龙/贯石斧/寒冰/方天；
  雌雄双股剑依赖性别数据、丈八蛇矛依赖多张牌转化）。
- 武将：**8/25 完整实现**（蜀 5 + 吴 3）。剩下 17 将未开始。
  注册表里只有技能真正实现完的武将，有测试断言每个登记技能都有运行时实现。
  即时锦囊和延时锦囊已全部实现。
- Phase D～F：AI/soak、Vue 牌桌与全部 Request UI、Cloudflare 联机/重连/DO 集成测试。
- README 和第三方声明仍需在最终范围确定后做最终更新；架构与 ruleset 文档已经建立并持续维护。

## 最新测试结果（Claude 接手后）

在 `feature/sanguosha` 上实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm run test:run` | **325 通过 / 34 个文件**（麻将 188 + 三国杀 131 + 门户 6） |
| `npm run test:sanguosha` | **131 通过 / 13 个文件** |
| `npm run sanguosha:soak 150` | 5 人和 8 人各 150 局全部正常结束 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:online` | 通过 |
| `npm run build` | 通过，产物已按游戏分包（门户 88KB / 麻将 App 122KB） |
| `npm run build:online` | 通过（Wrangler dry-run） |
| `npm run test:online:smoke` | 通过，麻将联机冒烟正常 |
| `npx playwright test` | **36 通过**（Chromium 32 + WebKit 4），麻将原有用例全绿 |

本轮全部验收命令都实际执行过。**没有 commit、没有 push、没有部署**——
工作仍然全部留在 `feature/sanguosha` 的工作区里，等人工验收。

## 2026-09-01 战报 + 技能请求通道 + 魏群四将

### 战报
- 新增 `src/sanguosha/engine/log.ts`：`describeEvent(state, event, viewerId)` 把引擎事件翻成一行战报。
- 按观看者过滤：别人摸到的牌只报张数不报牌名；判定牌、装备、死亡时公开的身份才写出来。
- `useLocalSanguosha` 订阅 10 类事件生成战报，界面不再自己推断。
- 顺带修正 `GainCard` 的 payload 形状——摸牌带的是 `cardIds` 数组，不是单张 `cardId`。

### 技能请求通道（剩余武将的共同前提）
- `SanguoshaState.skillResolution`：技能发问之后的等待状态，**完全可序列化**，DO 休眠后能原样恢复。
- `SkillHost.askSkill({ skillId, ownerId, step, data, build })` + `SkillRuntime.resume(...)`。
- 挂着 Request 时 `advancePhase` 本来就会拒绝推进，所以不需要任何形式的 `await`。
- `DrawPhase` 事件现在可以被技能 `cancel()` 接管，摸牌数交给技能决定。
- `invariants` 增加校验：`skillResolution` 必须指向真实存在的 Request 和玩家。

### 新增武将（8 → 12）
- 甄姬【洛神】、许褚【裸衣】、张辽【突袭】、华佗【青囊】，见 `src/sanguosha/data/characters/wei.ts`。

### 明确没做的部分（不是遗漏）
伤害结算中途发问的技能——曹操【奸雄】、司马懿【反馈】、夏侯惇【刚烈】、郭嘉【遗计】——
还不能实现：在 `Damaged` 事件里挂起会让后续结算和玩家的回答错位（等玩家回答时，
要拿的那张牌可能已经移动了）。需要先让 `resolveDamage` 支持中断续接。
`wei.ts` 顶部的注释记录了这个判断。

### 验证
- `npx vitest run` → 36 文件 / 341 用例通过
- `npm run sanguosha:soak 200` → 5 人局与 8 人局各 200 局全部完成
- `npx playwright test` → 37 通过（Chromium 33 + WebKit 4）
- `npm run typecheck` / `typecheck:online` / `build` / `build:online` 全部通过
- 浏览器实测：许褚开局摸牌阶段弹出【裸衣】选项，点「发动」后手牌 4→5，战报同步记录

## 2026-09-01（第二批）延后发问队列 + 魏四将

### 延后发问队列
上一批留下的缺口：「受到伤害后」触发的技能没法实现，因为在 `Damaged` 事件里当场发问，
玩家的回答会和还没走完的伤害/濒死结算错位。

- `SanguoshaState.skillQueue`：技能在触发时只把需要的事实抓下来排队，可序列化。
- 牌局回到干净状态（无 Request、无濒死、无属性传导、无牌在结算、无判定）时统一放出来。
  收尾点在 `respond` / `act` / `advancePhase` 之后。
- 队列里的前提可能已经失效，所以每个 `startQueued` 都要重新确认，不成立就安静放弃。
- `DamageOptions.cardId`：造成伤害的实体牌现在会传下去，奸雄才定位得到。
  七个伤害入口全部补齐（杀 ×2、南蛮/万箭、借刀、决斗、火攻、闪电）。
- `enterDying` 从伤害流程里抽出来单独导出：技能造成的「失去体力」把人打到 0 时走同一条路。

### 新增武将（12 → 16）
曹操【奸雄】、司马懿【反馈】、夏侯惇【刚烈】、郭嘉【遗计】，见 `wei-damage.ts`。
刚烈的第二问是发给**伤害来源**而不是技能拥有者，`askSkill` 支持这种跨玩家发问。

### 验证
- `npx vitest run` → 37 文件 / 351 用例
- `npm run sanguosha:soak 250` → 5 人局与 8 人局各 250 局全部完成
- `npx playwright test` → 37 通过
- 浏览器实测：新武将确实进入选将池并出现在牌桌上

### 已知未覆盖
遗计的 `distribute-cards` 界面分支只有引擎层单测，没在真实浏览器里点过——
要凑齐「自己是郭嘉且被打」这个局面太靠运气。分支代码本身已经审过。

## 2026-09-01（第三批）AI 阵营判断

### 根因
之前记录的「反贼胜率过高」其实是两个问题叠加：

1. **身份推断从来没有被调用过。** `observeDamage` / `observeRecover` 写好了但
   soak 和单机驱动谁都没挂上事件流，suspicion 永远是全零，整套推断等于没跑。
2. **只有布尔的「是不是敌人」，没有「要保护谁」。** 开局所有 suspicion 都是 0，
   于是**忠臣眼里没有任何敌人**，只能按血量乱打，经常反过来打主公；
   而反贼因为主公身份公开，第一回合就能协同集火。

### 改动
- `hostility(view, suspicion, targetId)` 取代布尔判断，返回带符号的敌意值。
  `PROTECTED` 表示绝不选为目标（自己、自己人、忠臣眼里的主公）。
- 忠臣对未知身份给温和的正向先验——未知的人里反贼占多数，不能开局毫无目标。
- 内奸开局保护主公，主公体力 ≤2 时转而打反贼：内奸要的是最后单挑，不是让反贼提前赢。
- `observeEvent` 挂进 soak 和单机驱动。新增信号：主公打了谁，谁就更像反贼。
- 无懈可击改按「这张锦囊会不会害到我这边」判断，目标是被保护对象时一定拦。
- 群体锦囊按敌意求和，打到自己人明确扣分。

**没有任何一处读隐藏身份**——PlayerView 里那本来就是 null，单测专门守着这条。

### 结果（300 局压测）
| | 改动前 | 改动后 |
|---|---|---|
| 5 人局 主公胜 | 12% | 40% |
| 5 人局 反贼胜 | 85% | 44% |
| 8 人局 反贼胜 | 99% | 79% |

5 人局已经接近真实牌局的分布。**8 人局仍然偏向反贼**，这是结构性的：
4 反贼对 1 主公 + 2 忠臣，而主公技（护驾、激将）还没实现，
主公只多 1 点体力上限，撑不住。要真正拉平得先做主公技，不是继续调权重。

`tests/sanguosha-ai-belief.test.ts` 里的胜率护栏上限刻意留宽，
它是防回归用的，不是精调后的期望值。

### 验证
- `npx vitest run` → 38 文件 / 357 用例
- `npm run sanguosha:soak 300` → 5 人局与 8 人局各 300 局全部完成
- `npx playwright test` → 37 通过

## 2026-09-01（第四批）主公技 + 刘备/孙权

### 代打机制（护驾 / 激将）
主公需要打出【闪】或【杀】而自己打不出时，引擎按座次转问同势力角色。

- `SkillRuntime.surrogateResponders(state, ownerId, requiredCardName)`：技能自己算谁能代打，
  并自己确认「我确实坐主公位」——主公技只在主公位生效，这是规则，不该让引擎猜。
- 询问进度记在结算状态里（`SlashResolutionState.surrogate` 和锦囊 effect 的 `surrogate`），
  完全可序列化，Durable Object 中途休眠也接得上。
- 覆盖两条路径：【杀】的求闪，以及锦囊要求打出牌（决斗、南蛮、万箭）。

### 救援
`SkillRuntime.rescueRecoverBonus`：同势力角色的【桃】对主公多回复一点。

### 新增武将（16 → 18）
刘备【仁德】【激将】、孙权【制衡】【救援】。曹操补上了缺失的主公技【护驾】——
上一批只写了奸雄，严格说是个不完整的武将，这次补齐。

### 压测抓到的问题
主公技代打会在同一个 `seq` 里连着问好几个人，而求闪请求的 id 是 `request-${seq}`，
于是新旧请求撞了同一个 id，触发了「响应后没有推进」的死锁守卫。
请求 id 改成带 `decisions.length`，保证唯一，回放也才对得上。

### 验证
- `npx vitest run` → 39 文件 / 364 用例
- `npm run sanguosha:soak 300` → 5 人局与 8 人局各 300 局全部完成
- `npx playwright test` → 37 通过
- 主公技用例成对验证：坐主公位生效，不坐主公位必须完全没有效果

### 8 人局平衡
主公技上线后 8 人局反贼胜率 79% → 76%。改善有限是意料之中：
主公技只有拿到曹操/刘备/孙权当主公时才生效，18 名武将里只占 3 个。
真正拉平要等武将池补齐，靠调 AI 权重是拉不动的。
