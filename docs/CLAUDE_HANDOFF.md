# Claude 接手说明：CRPlay + 三国杀

更新时间：2026-08-31 23:11（Asia/Shanghai）

## 先做什么

1. 工作目录固定为 `C:\Users\cr\Documents\work\crplay-sanguosha-dev`。
2. 先运行 `git status --short --branch`。**应当在 `feature/sanguosha` 上，不是 `main`**——
   Claude 接手时已切出功能分支：部署工作流由 `push: branches: [main]` 触发，
   留在 `main` 上提交推送会直接部署生产麻将。保护全部未提交修改。
3. 阅读：
   - `docs/sanguosha-progress.md`
   - `docs/sanguosha-architecture.md`
   - `docs/sanguosha-ruleset-v1.md`
   - 本文件
4. 不要执行 `git reset --hard`、`git clean`、强制 checkout、commit、push 或部署。
5. 若远端可能变化，只先 `git fetch origin main` 并比较；不要在未提交工作树上直接 pull。

## Git 基线

- 仓库：`https://github.com/chenrang418-glitch/ai-red-mahjong.git`
- 本地分支：`feature/sanguosha`（自 `ac5c448` 切出；原为 `main`）
- `HEAD`：`ac5c448d632f5b34ac9da18550107990ba9eda61`
- `origin/main`：`ac5c448d632f5b34ac9da18550107990ba9eda61`
- ahead/behind：`0/0`
- 基线提交：`fix: 堵住牌序与暗牌泄露，修阶段被外围事件重置，补运行时校验`
- 当前改动全部未提交；创建本文件前为 9 个 tracked 修改、42 个 untracked 文件。

tracked 修改主要是门户最小接线、原 E2E URL 适配、测试脚本和第三方声明。untracked 主要是 `RootApp`、`portal`、完整 `src/sanguosha` 底座、三份原文档及新增测试。

## 已完成范围

### Phase A

- `RootApp.vue`、数据驱动 `GamePortal`、namespace CSS、动态加载。
- URL：`/`、`?game=mahjong`、旧 `?room=`、`?game=sanguosha`、`?game=sanguosha&room=`、`#admin`。
- 原麻将只做顶层接线和返回游戏中心入口，没有重写规则、状态机、AI 或联机协议。
- 三国杀 manifest 仍显示“开发中”，不得提前改成“可游玩”。

### Phase B 当前底座

- 精确 ruleset-v1 160 张牌数据：标准 108 + 军争 52。
- 固定 seed RNG、5～8 人身份表、胜负判断、明确牌区/装备槽、统一距离。
- Event、12 类 Request、LegalAction、PlayerView 隐私裁剪、decision log 骨架、状态 invariant。
- 六阶段推进；摸牌阶段摸 2；弃牌阶段生成强制定量 Request。
- 伤害、回复、濒死、桃/自救酒、死亡、反贼奖励、主公误杀忠臣惩罚。
- 火/雷铁索传播；传播中濒死可暂停并恢复。
- 已接入卡牌：
  - 杀、闪、桃、酒；
  - 装备牌的装入/替换与武器范围（装备特效未实现）；
  - 无中生有、无懈可击链；
  - 乐不思蜀、兵粮寸断、闪电及判定。
- 卡牌、伤害链、濒死和判定均用可序列化 state 恢复，不依赖等待中的 Promise 或 async 调用栈。

## 特别重要的规则决定

- 延时锦囊使用时**直接放入判定区，不开启无懈窗口**。
- 到目标角色判定阶段、翻开判定牌前，才逐人询问无懈。
- 单数次无懈抵消，双数次恢复结算。
- 乐不思蜀/兵粮寸断被抵消后弃置；闪电被抵消后传给下一名合法角色。
- 判定区后置先判。
- 闪电命中为黑桃 2～9、3 点无来源雷电伤害。
- 酒在出牌阶段限一次；增伤被下一张杀消费后也不能再次使用酒。

不要把上述逻辑退回到早期错误版本。规则来源已列在 `docs/sanguosha-ruleset-v1.md`。

## 最新验证基线

| 命令 | 结果 |
| --- | --- |
| `npm run test:sanguosha` | 9 个文件、61 项通过 |
| `npm run test:run` | 30 个文件、255 项通过 |
| `npm run typecheck` | 通过 |
| `npm run typecheck:online` | 通过 |
| `npm run build` | 通过 |
| `npm run build:online` | 通过，仅 Wrangler dry-run |
| `npm run test:online:smoke` | 通过，仍是原麻将联机 smoke |
| `git diff --check` | 通过，仅有 LF/CRLF 提示 |
| `npm run test:e2e` | Phase A 最后一次 30/30；Phase B 后未重跑 |

## 当前真实未完成

- 还不是可玩的三国杀：`SanguoshaApp.vue` 仍是诚实占位页。
- 选将流程和 CharacterPack 未实现；所有玩家 `characterId` 仍为 `null`，武将完成度 0/25。
- 大部分锦囊、装备特效、全部 25 将技能未实现。
- AI、IdentityBelief、soak、单机 Vue 牌桌、全部 Request UI 未实现。
- `SanguoshaRoom`、`SanguoshaLobby`、协议、重连、超时和 DO migration 未实现。
- replay 目前只返回 `rulesetVersion + seed + setup + decisions`；尚无从 decisions 重建整局的 reducer/runner。
- README 尚未改成最终 CRPlay 说明。
- Playwright 尚无真实三国杀牌桌场景，因为 UI 尚未开始。

## 建议下一开发顺序

1. 建立通用的“逐目标锦囊结算帧”，不要继续把所有牌塞进 `engine/cards/basic.ts`。
2. 优先实现并测试：桃园结义、南蛮入侵、万箭齐发；每个目标分别开启无懈/响应，濒死时暂停后继续下一目标。
3. 再实现决斗、过河拆桥、顺手牵羊、铁索连环、火攻、五谷丰登、借刀杀人。
4. 把 decision log 做成可从 seed/setup 重放的 runner；测试中比较最终 state 与事件摘要。
5. 等 Engine 主要卡牌稳定后再建立 CharacterPack 与选将；未实现完整技能的武将不要注册为完成。

## 实现陷阱

- `src/sanguosha/engine/cards/basic.ts` 已同时承载基础牌、装备入口、无中生有与延时锦囊放置，继续增长前应按“基础牌/普通锦囊/延时锦囊/装备”拆分，但不要重构麻将。
- `GameEventBus` 的 handler 是运行时代码；DO 恢复时必须重新注册技能，不能把函数序列化。
- `PlayerView.pendingRequest` 只发送给 request 所属玩家；不要广播 actionIds。
- 其他玩家手牌 card id、牌堆顺序和未公开身份不能进入网络响应或 DOM。
- `state.cardResolution`、`damageChain`、`dying`、`judgment` 的恢复优先级目前为：濒死 → 属性传播 → 判定 → 原卡牌。
- 所有客户端操作最终应只提交 `actionId/baseSeq` 等意图；不要接受客户端上传伤害、摸牌、死亡或胜负结果。

## 参考仓库状态

- 项目外参考目录：`C:\Users\cr\Documents\work\_crplay-sanguosha-references`
- `wmzy/sanguosha`：commit `177ca5f24cd985458fd6e38bb036d45fc414386b`，MIT，仅研究架构，未复制源文件。
- `maxi-max-dev/sanguosha-online`：commit `8efcf8815f138a959259fa9ca355b9d12822a636`，未确认许可证，仅研究架构。
- noname 浅克隆曾卡住并被终止，未读取或复制其 GPL 源码。

## 接手后的最小自检

```powershell
Set-Location 'C:\Users\cr\Documents\work\crplay-sanguosha-dev'
git status --short --branch
npm run test:sanguosha
npm run typecheck
```

若这三步与上方基线不一致，先检查工作树是否被覆盖、是否漏掉 untracked 文件，或者是否错误改变了延时锦囊/判定响应时机。
