# 协作约定（Claude Code / Codex 共同遵守）

这份文件是**当前阶段的工作方式**，优先级高于任何单次提示词里的默认习惯。
仓库里的任何自动化助手——Claude Code、Codex、以及以后接手的其他工具——都按这里执行。

最后更新：2026-09-06。

---

## 一、只在本地开发，不提交部署

**当前阶段所有改动都只在本地进行。**

- **不要 `git push`。**
- **不要触发部署**（不跑 `deploy:online`，不推 main 触发 Actions）。
- 本地提交（`git commit`）可以照常做，用来切分改动、方便回滚。
- 攒够一大段东西之后，由**用户下指令**统一做一轮大更新，一次性推送部署。

不再像之前那样「每完成一个武将就推一次」——那样线上会被零碎更新反复打断。

**例外只有一种**：用户明确说「提交」「部署」「推上去」的时候。
没有这句话，就一直留在本地。

## 二、立绘与语音：保留接口，暂不接入

- 新武将的**立绘暂时不会上传**。代码要照常留好接口：
  `src/sanguosha/assets/characters/manifest.ts` 里的登记项、
  `scripts/prepare-sanguosha-portraits.ps1` 的生成流程都不改。
  素材没到位时，**不要为了让测试变绿而放宽立绘相关的断言**——
  该红就红，它红着正好提醒素材还没接。
- **语音台词同样暂不接入**，接口保留：
  `src/sanguosha/data/character-voice-lines.ts` 对没有语音的武将返回空数组，
  不发请求、不产生 404。新武将默认就走这条路径。
- 用户上传素材之后会通知，届时**直接接入**：跑立绘生成脚本、补 manifest 登记项、
  把武将 id 加进语音清单即可，不需要改别的东西。

## 三、当前阶段在做什么

持续开发新武将，其间穿插：

- 修 bug、优化玩法与界面；
- 不定时接入立绘与语音；
- 更换已有武将的立绘或语音。

以上全部**只在本地执行**，直到用户下达提交部署的指令。

## 四、不变的老规矩

这几条从项目开始就成立，本阶段继续有效：

- **不写来源参考。** 玩法表述以 `docs/sanguosha-ruleset-v1.md` 记录的自研版本为准；
  代码、注释、文档、提交信息里一律不出现第三方厂商的域名、详情页、改版公告、wiki 链接，
  也不出现「官方文本 / 官方裁定 / 逐字核实」这类措辞，或用第三方版本体系给自己定位的句子。
  **提交信息尤其要注意：推上去就改不掉了。**
- 站点声明里「与相关游戏厂商及权利人不存在官方授权、合作或隶属关系」是**保护性**表述，必须保留。
- **不要改麻将**：引擎、界面、Worker、测试，无必要不动。
- **引擎主干不许出现按 `characterId` 的特判**，走技能运行时的钩子接入。
- 每一批武将都要在 `docs/sanguosha-ruleset-v1.md` 里写**版本锁**：
  实现哪几个技能、明确不实现哪些。要偏离那份文本，先改文档再改代码。

## 五、验证口径

改完要跑的东西没变，命令以 `package.json` 为准：

```
npm run typecheck      npm run typecheck:online
npm run test:run       npm run test:e2e       npm run test:online
npm run build          npm run build:online
```

**不得靠删断言、跳过用例、放宽检查来制造通过结果。**
跑不了的验证如实说明原因和影响，不要虚构结果。

## 六、Beta / Production 环境保护

- 默认开发分支为 `dev`；`main` 对应 Production。
- 除非用户明确要求，禁止 push、merge、rebase 改写或以其他方式更新远端 `main`。
- Beta 前端、Worker、D1 和 Durable Objects 必须使用独立资源；Beta Pages 只能绑定 `crplay-beta-api`。
- Beta Worker 只能使用 `crplay-beta-db` 和其自身的 Durable Object namespace，不得复制或连接 Production 数据、Worker、DO 或 Secrets。
- `dev` 推送仅允许触发 `.github/workflows/deploy-cloudflare-beta.yml`。Production 部署仅由现有 main 工作流触发。
- 修改分支前先检查并记录 HEAD、远端基线和工作区状态；不得 reset、clean、覆盖或丢弃用户未提交内容。
- 只提交当前任务明确涉及的文件；工作区内其他既有修改与临时文件必须保持原样，未经用户确认不得批量纳入提交。
