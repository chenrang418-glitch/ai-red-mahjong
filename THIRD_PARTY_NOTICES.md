# 第三方资源说明

本项目的麻将牌 SVG 图像和早期工程结构参考自：

- 项目：[QTprincekin/HongZhongMaJiang](https://github.com/QTprincekin/HongZhongMaJiang)
- 上游 README 声明许可证：MIT

本项目保留这项来源说明。四人对局状态机、红中麻将玩法、离线 AI、积分结算、存档回放和当前用户界面均在本项目中重新实现。

## 三国杀开发参考

### wmzy/sanguosha

- 项目：[wmzy/sanguosha](https://github.com/wmzy/sanguosha)
- 参考 commit：`177ca5f24cd985458fd6e38bb036d45fc414386b`
- 许可证：MIT
- 上游版权声明：`Copyright (c) 2025 三国杀项目作者`

本项目研究了其 Engine / data / flows / rules / skills / types / view 的分层方式、身份视图裁剪和测试组织。当前 CRPlay Engine 为独立实现，没有复制其源文件。若后续实质性改编上游代码，必须在本节追加具体文件并保留完整 MIT 许可文本。

### maxi-max-dev/sanguosha-online

- 项目：[maxi-max-dev/sanguosha-online](https://github.com/maxi-max-dev/sanguosha-online)
- 参考 commit：`8efcf8815f138a959259fa9ca355b9d12822a636`
- 仓库根目录未发现明确许可证文件。

仅研究 `seed + decisions`、纯 TypeScript Engine、Cloudflare Worker、一房间一 Durable Object、玩家视图、休眠恢复和无头压测的架构思想；没有复制其源代码。

### 规则数据资料

`ruleset-v1` 的标准包与军争篇逐张牌表依据三国杀 BWIKI 对应页面核对。该事实数据在本项目中按自身 TypeScript 数据结构重新录入；页面链接与版本边界见 `docs/sanguosha-ruleset-v1.md`。
