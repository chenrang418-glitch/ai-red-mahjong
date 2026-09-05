# 第三方资源说明

本项目的麻将牌 SVG 图像和早期工程结构参考自：

- 项目：[QTprincekin/HongZhongMaJiang](https://github.com/QTprincekin/HongZhongMaJiang)
- 上游 README 声明许可证：MIT

本项目保留这项来源说明。四人对局状态机、红中麻将玩法、离线 AI、积分结算、存档回放和当前用户界面均在本项目中重新实现。

## 纸上三国开发参考

### wmzy/sanguosha

- 项目：[wmzy/sanguosha](https://github.com/wmzy/sanguosha)
- 参考 commit：`177ca5f24cd985458fd6e38bb036d45fc414386b`
- 许可证：MIT
- 上游版权声明：`Copyright (c) 2025 纸上三国项目作者`

本项目研究了其 Engine / data / flows / rules / skills / types / view 的分层方式、身份视图裁剪和测试组织。当前 CRPlay Engine 为独立实现，没有复制其源文件。若后续实质性改编上游代码，必须在本节追加具体文件并保留完整 MIT 许可文本。

### maxi-max-dev/sanguosha-online

- 项目：[maxi-max-dev/sanguosha-online](https://github.com/maxi-max-dev/sanguosha-online)
- 参考 commit：`8efcf8815f138a959259fa9ca355b9d12822a636`
- 仓库根目录未发现明确许可证文件。

仅研究 `seed + decisions`、纯 TypeScript Engine、Cloudflare Worker、一房间一 Durable Object、玩家视图、休眠恢复和无头压测的架构思想；没有复制其源代码。

### Ma Shan Zheng（马善政毛笔楷书）

- 项目：[google/fonts — ofl/mashanzheng](https://github.com/google/fonts/tree/main/ofl/mashanzheng)
- 版本：Version 2.003
- 许可证：SIL Open Font License 1.1
- 上游版权声明：`Copyright 2018 The Ma Shan Zheng Project Authors (https://github.com/googlefonts/mashanzheng)`

用于纸上三国势力角标（`src/sanguosha/assets/fonts/mashanzheng-faction-subset.woff2`）。
原字体只写了「华文行楷」这类本机系统字体，手机上没有、会退成普通字体，因此改为自带。

**该文件是子集**：只保留角标用到的「魏蜀吴群晋神」六个字形，转为 woff2，3.9 KB。
OFL 1.1 允许在保留本声明的前提下嵌入、子集化与再分发；字体本身未被出售，
也未使用 Reserved Font Name（子集内部名称仍为 Ma Shan Zheng，未做改名分发）。
