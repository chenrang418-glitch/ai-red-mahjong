# Liquid Glass 当前工程状态

## 当前默认实现

- 默认首页继续使用 `simple-liquid-glass@5.3.0` Web Component，但 WebGL 的 backdrop 已改为实时 Canvas，而不是静态背景缓存图。
- `src/portal/PortalBackgroundStage.vue` 永久保留两张背景 `<img>`，并在转场的每个 `requestAnimationFrame` 中把当前 crossfade、横移、轻微 blur 和暗场绘制到 `#portal-glass-live-backdrop`。
- `src/portal/PortalGlassSurface.vue` 的所有实例始终指向同一个 `#portal-glass-live-backdrop`，不再随着游戏状态更换 selector，也不再等待 `stable` 事件刷新 Glass。
- 本轮没有修改麻将、三国杀或联机逻辑。

## Candidate A 试验实现

- 依赖：`@samasante/liquid-glass@0.1.1`、`react@19.2.0`、`react-dom@19.2.0`。
- 入口：`?glass=a`，例如 `http://127.0.0.1:4183/?glass=a`。
- Vue adapter：`src/portal/PortalGlassA.vue`。
- 已接入：首页“开始游戏” CTA；底部游戏切换器的活动玻璃胶囊。
- 暂未接入：右上角菜单按钮、菜单 sheet、其他游戏界面。

Candidate A 仍保留在 `?glass=a` 试验路径，用于比较；本次实时架构修复针对默认 `simple-liquid-glass` WebGL 路径，因为它明确支持直接 Canvas 源的 live 采样。

## 旧路径与新路径

旧路径是混合实现：背景实际在主舞台的两张图片上做 CSS/Web Animations，但 Glass 指向两个静态 cache 图片；切换完成后才改变 `backdrop-selector`，WebGL HTML capture 还会保留上一帧直到新快照就绪。

新路径是：`Background images → RAF Canvas compositor → WebGL Glass → content`。Canvas 是 Glass 的固定 sibling source，转场期间每帧更新；因此黑场、crossfade、位移和轻微 blur 都进入同一实时源。

## 为什么不默认替换

Candidate A 是 React-only 包。为了让它在 Vue 中工作，adapter 会动态加载 React runtime，并在局部节点创建 React root。这样可以把风险限制在首页试验路径，但仍然会增加依赖和浏览器运行时成本；因此当前默认路径继续使用已经具备直接 Canvas live source 能力的实现。

## 可撤回点

删除 `PortalGlassA.vue`，并在 `PortalGlassButton.vue`、`PortalGameSwitcher.vue` 去掉 `?glass=a` 分支，即可撤回 Candidate A 试验。正式依赖是否保留，应在视觉验收后决定；本轮没有提交或部署。

## 已知风险

- SVG displacement filter 在 Safari/Firefox 与低端移动设备上的表现需要真实设备复核。
- React root 与 Vue 页面混用增加了 bundle 和生命周期复杂度。
- Canvas 合成是真实逐帧更新，但它不是方向性 motion blur；当前 blur 是轻量 isotropic blur，用于稳定性能。
- iPhone Safari 的最终效果仍需真机验证；当前直接 Canvas source 走库的 WebGL live path，失败时由库降级，不应宣称 Safari 与 Chromium 完全一致。
- 首页背景图片本身较大，玻璃效果验收不能只看静态截图，应同时检查快速切换、点击 CTA、窄屏和 reduced-motion。
- npm 安装阶段曾遇到 Windows 文件锁 `EBUSY`；已停止本地 Vite 进程后完成依赖安装，未执行破坏性清理。
