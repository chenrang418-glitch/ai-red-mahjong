# 三国杀技术架构

## 总体原则

CRPlay 顶层由 `RootApp.vue` 管理，红中麻将仍保留在原 `App.vue`。游戏入口由 `portal/gameManifest.ts` 数据驱动，具体游戏通过动态 `import()` 加载。三国杀代码位于 `src/sanguosha/`，不引入第二套前端框架。

```text
RootApp
├── GamePortal
├── Mahjong App（原 App.vue，动态加载）
└── Sanguosha App（动态加载）
    ├── Vue UI
    ├── Browser Local Controller
    ├── Online Controller
    └── 纯 TypeScript Engine
        └── SanguoshaRoom Durable Object（同一引擎）
```

## URL 与游戏中心

- `/`：游戏中心。
- `/?game=mahjong`：红中麻将。
- `/?room=ABC234`：旧麻将分享链接，兼容为麻将。
- `/?game=sanguosha`：三国杀。
- `/?game=sanguosha&room=ABC234`：三国杀房间。
- `/#admin`：原麻将管理员入口，优先级最高。

顶层导航由 `portal/navigation.ts` 的纯函数解析，不引入 Vue Router。`RootApp` 监听 `popstate` 与 `hashchange`，保证前进、后退和刷新恢复。

## Engine

`src/sanguosha/engine/` 不依赖 Vue、DOM、浏览器存储、网络或 Cloudflare API。入口为 `new SanguoshaGame({ seed, setup })`。浏览器单机、AI、Worker、测试和重放必须调用同一 Engine。

当前基础模块：

- `types.ts`：真实牌局状态、玩家、牌、明确装备槽与牌区。
- `rng.ts`：基于字符串 seed 的确定性随机源；洗牌、身份、AI 和随机技能统一使用。
- `events.ts`：按优先级注册的时机事件总线。
- `requests.ts`：12 类 discriminated union、穷尽检查和运行时响应校验。
- `modes/identity.ts`：5～8 人身份表与独立胜负判定。
- `distance.ts`：座次、死亡玩家、坐骑、武器和技能修正的统一入口。
- `view.ts`：按 viewer 裁剪手牌、身份和牌堆顺序。
- `draw.ts`：确定性摸牌与弃牌堆重洗。
- `damage.ts`：伤害时机、可序列化濒死救援、死亡奖惩和胜负收束。
- `phase.ts`：阶段进入行为、摸牌和弃牌 Request。
- `cards/basic.ts`：合法出牌、基础牌/装备入口、杀闪结算和无懈响应链。
- `judgment.ts`：判定牌、延时锦囊、阶段跳过和闪电伤害恢复点。
- `invariants.ts`：供单测、soak 与服务端动作提交后调用的全状态约束。
- `game.ts`：确定性初始化、统一响应入口与回放记录骨架。

Engine 已能完成 5～8 人身份局，包含选将、阶段推进、摸牌/弃牌、伤害/濒死/死亡、属性传播、核心牌、无懈链、判定区、64 名完整登记武将、AI 与回放/持久化。剩余边界以 ruleset 文档为准。

## Event

事件名称覆盖开局、回合、六阶段、用牌、目标、响应、伤害、回复、濒死、死亡、移动牌和判定。技能通过 Event handler 接入，不在核心 `game.ts` 堆积武将名判断。

事件处理器是可信 TypeScript 模块中的运行时代码；任何等待玩家的状态不能保存在 handler 调用栈中，必须转成可序列化 Request。

## Request

当前统一类型：

- `choose-general`
- `choose-cards`
- `choose-targets`
- `choose-option`
- `choose-suit`
- `choose-number`
- `use-card`
- `respond-card`
- `invoke-skill`
- `arrange-cards`
- `distribute-cards`
- `rescue`

Engine 生成候选和合法 `actionId`；客户端只展示并提交选择。`validateResponse` 检查 request、玩家和候选集合。其他玩家未知手牌使用 `hiddenCardSlots`，真实 card id 不进入视图。

濒死流程保存在 `state.dying`，当前救援者同时对应唯一 `rescue` Request。每次响应都重新校验 request/player/actionId，合法后写入 `decisions`；因此浏览器刷新或 Durable Object 休眠后可以从状态继续，不依赖未完成 Promise。

卡牌使用期间的 `state.cardResolution` 保存实体牌、来源、目标、阶段和 requestId。【杀】等待闪或嵌套濒死流程时、锦囊等待多轮无懈时，都能完整 JSON 序列化。响应完成后由显式 `resumeCardResolution` 继续，不保留 async 调用栈。

属性传播由 `state.damageChain` 保存剩余座次目标；闪电伤害暂停点由 `state.judgment` 保存。恢复顺序固定为“濒死 → 属性传播 → 判定 → 原卡牌”，避免 Durable Object 唤醒后依赖调用栈。

延时锦囊使用时只完成“放入判定区”；到目标角色判定阶段、翻开判定牌前，`state.judgment` 进入 `awaiting-nullification` 并生成逐人响应 Request。无懈链结束后才翻牌；闪电被抵消时按合法座次传递，乐与兵粮被抵消时弃置。

后续每新增一种 Request，必须同时补 Engine、AI、Vue、validation、单测与 E2E；UI 使用穷尽 switch，不能静默回退到第一个 action。

## Skill

`engine/skills/types.ts` 已定义 trigger、active、view-as、filter、prohibit、target-mod、distance、max-cards、locked、limited、lord 能力。复杂技能允许主技能组合内部 subSkill。

后续武将技能放在 `data/characters/` 与 `engine/skills/`，不得把武将特例写进 `game.ts`。

## AI

AI 只接收 `PlayerView + LegalAction[]`，不接触完整 state。身份判断使用事件驱动的 belief/suspicion；难度只改变评估质量和随机失误，不偷看身份与手牌。`sanguosha:soak` 使用相同 AI 无渲染跑完整局。

## PlayerView

`buildPlayerView` 当前隐藏：

- 其他角色的真实手牌与 card id；
- 未公开身份；
- 牌堆顺序。

公开装备、判定区、弃牌堆、处理区、血量和手牌数量。主公身份、自身身份、死亡后身份和结算身份按规则公开。左慈的未亮出化身只存在服务端完整状态与拥有者视图；旁观者视图只含当前公开化身和当前获得技能。Worker 禁止序列化完整 state 广播。

视图只附带分配给 `viewerId` 的 `pendingRequest`；其他玩家看不到 request id、候选牌或合法 action。公开 `dying` 仅包含濒死角色和所需回复量，以支持刷新/重连恢复 UI。

## Replay

回放最小记录：

```json
{
  "rulesetVersion": "ruleset-v1",
  "seed": "...",
  "setup": {},
  "decisions": []
}
```

相同 ruleset、seed、setup 与 decisions 必须得到相同结果。允许后续增加 checkpoint，但 checkpoint 不能成为规则真相来源。

## Cloudflare 与 Durable Object

`SanguoshaRoom` 通过独立 `SGS_ROOMS` binding 和 `/api/sanguosha/*` 路由提供联机，麻将 `/api/*` 保持原行为。会话复用现有 opaque HttpOnly Cookie；公开目录复用 `MahjongLobby` 的轻量更新通知。待操作 Request、deadline、decision log、AI 随机源与托管状态全部持久化，DO 休眠恢复不依赖 Promise resolver、长 async 调用栈或普通定时器。

线上命令必须带 `actionId + baseSeq`，经运行时 parser 后才进入协调器；重复和陈旧动作会被拒绝。Worker 只广播按连接用户构造的 `PlayerView`。

### Presentation 与牌桌 V2

规则事件通过 `engine/presentation.ts` 转成公开的 `PresentationEvent`。单机直接订阅同一套 EventBus；联机房间按观看者过滤后把最近 30 条事件写入 Durable Object 状态，重连时随 `SgsRoomView.presentationEvents` 恢复。表现事件只包含公开的来源、目标、牌名、技能名、伤害性质与数值，不包含他人手牌、暗身份或牌堆顺序。动画只消费事件，不参与规则推进。

`PlayerView.players[].distanceFromViewer` 和 `attackRange` 均由 `getDistance()` / `getAttackRange()` 生成，Vue 不重新实现距离。`SgsSeatLayout` 以观察者为底部，从下家起按顺时针映射至 5～8 人固定槽位；`SgsEffectLayer` 从座位 DOM 读取响应式坐标并绘制 SVG 指向。

武将势力沿用强类型必填字段 `CharacterDefinition.kingdom`。魏、蜀、吴、群、晋、神的唯一枚举、固定顺序和视觉配置在 `shared/factions.ts`；对局、词条、规则页和艺术集不得再维护局部势力映射。完整接入约束见 `docs/sanguosha-factions.md`。

局内词条由 `ALL_CARD_INFO`、`STANDARD_CHARACTERS` 和身份/规则词条生成。`SgsCard` 使用并列的牌面按钮与 info 按钮，避免嵌套 button；因此 disabled 的装备、判定牌和处理区牌仍可查说明，同时不改变牌面主体的选择语义。

Wrangler DO migration 已追加到 tag `v3`；D1 migration 已追加到 `0006_sanguosha_room_directory.sql`。历史 migration 未修改。

## 扩展武将包

`CharacterPack` 只注册已完整实现的 characters 与 skills；标准、风、火、林、山五包目前均已完成，不注册界限突破或其他版本空壳。

## 扩展新游戏

新增游戏应：

1. 新建独立 App；
2. 使用自身 namespace 样式；
3. 在 `gameManifest.ts` 注册定义与动态 loader；
4. 在顶层 `GameId` 注册 URL id；
5. 补门户、刷新与溢出测试。

不需要改写 GamePortal 卡片模板。


## 回合调度：正常回合与额外回合（2026-09-04）

回合归属由**两个**字段共同决定，不能合并：

- `currentPlayerId`：当前回合是谁的。额外回合期间指向插队的那个人。
- `normalTurnPlayerId`：正常座次游标。**只有正常回合会推进它。**

`state.extraTurns` 是先进先出的额外回合队列（刘禅【放权】排进去）。
`turn.ts` 的 `nextTurnEntry` 先取队列，取不到才按座次往下数：

```
正常回合 A 结束
  ↓ 队列里有 C
额外回合 C（normalTurnPlayerId 仍然停在 A）
  ↓ 队列空了
正常回合 B（从 A 往后数，不是从 C 往后数）
```

合成一个字段的话，B 的正常回合会被直接吃掉——这是整套调度里最要紧的不变量，
`tests/sanguosha-liushan.test.ts` 的「额外回合的调度不变量」一组钉着它。

额外回合是**完整回合**：六个阶段、翻面跳过、觉醒、「回合限一次」重置全部照常，
因为它和正常回合走的是同一个 `beginTurn`。

## 阶段的开始：`PhaseStart` 由阶段引擎发出（2026-09-04）

`turn.ts` 的 `advancePhase` **只推进阶段指针并返回 boolean**，不发 `PhaseStart`。
阶段真正开始之前还有一个可挂起的公共窗口——「付代价跳过这个阶段」
（`SkillRuntime.offerPhaseSkip`，张郃【巧变】和刘禅【放权】在用）。

```
advancePhase（推进指针，发 PhaseEnd/TurnEnd/TurnStart）
  ↓
beginPhaseEntry（逐个问技能要不要跳过，可挂起）
  ↓ 没人跳过
PhaseStart → enterCurrentPhase（跑阶段内容）
  ↓ 有人跳过
skipPhase + 直接进入下一个阶段（不发 PhaseStart，不跑阶段内容）
```

在窗口挂起期间发 `PhaseStart`，会让挂在阶段上的技能（英魂、崩坏、观星）
在一个**最终被跳过的阶段**里错误触发。

## 神将用到的公共机制（2026-09-04）

神将的技能大多需要「一块只有自己看得见的牌」「一个挂在别人身上、到某个时机消失的状态」
这类东西。这些都做成**不认武将 id 的公共机制**，引擎主干里没有按 `characterId` 的分支。

### 扣置的武将专属牌堆

`player.characterPiles` 本来就是公开的专属牌堆（周泰的「创」、田丰的「义」）。
在 `player.hiddenCharacterPiles` 里登记堆名，`buildPlayerView` 就只给拥有者下发牌面，
其他人拿到空数组，另外统一给一份 `characterPileCounts` 张数。张数是公开信息，牌面不是。

神诸葛亮的「星」用的就是这个。星是**真实移动**进去的，计入牌张守恒，不计入手牌，
也不影响手牌上限。换星是原子操作：等量手牌与等量星同时互换，
**全程不派发 `LoseCard` / `GainCard`**——否则屯田、枭姬、行殇、固政会被错误触发。

### 临时角色状态 `engine/target-state.ts`

和 `player.marks`（纯计数）互补：这里是**带失效时机的具名状态**，而且参与伤害结算。

- 状态自己带失效条件（目前只有 `source-next-turn-start`），由 `turn.ts` 在每个回合开始时
  统一调 `expireTargetStates` 清理，**技能不各自注册清理**——散着写迟早漏一个。
- 伤害修正统一走 `applyTargetStateDamage`，挂在 `damage.ts` 的统一管线上，
  所以杀、决斗、南蛮、万箭、铁索传导、业炎自动全都覆盖到，不用逐张牌特判。
- 角色死亡时 `clearTargetStatesOf` 既收掉挂在他身上的，也收掉**由他施加的**——
  施加者死了就再也不会有「他的下一个回合」，留着等于永久生效。

### 两条容易踩的时序纪律

- **开局技能在第一个回合开始之前跑完**：`game.start()` 里 `initializeGameSkills` 排在
  `startPlaying` 之前。反过来的话，动公共牌堆的 `onGameStart` 会和第一个准备阶段抢牌
  （观星记下牌堆顶五张 → 七星把牌堆顶七张拿走 → 观星按旧快照写回 → 同一张牌出现在两个区域）。
- **判定不能嵌套**：`state.judgment` / `state.retrial` 各只有一个槽位，
  闪电还会把 `judgment` 占成 `awaiting-damage` 当书签。要在结算中途开判定，
  先看槽位，占着就 `queueSkill` 让路，等场面干净再跑。
