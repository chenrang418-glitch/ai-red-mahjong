<script setup lang="ts">
defineEmits<{ local: []; online: []; rules: []; portal: [] }>()
</script>

<!--
  首页结构和纸上三国 1:1 对齐：顶栏（返回 + 站点标注）、居中 hero（印章 / 小标注 /
  标题 / 一句说明）、底部三个入口。两个游戏只有主色和文案不同。
  改动之前请对照 src/sanguosha/SanguoshaApp.vue 里的 .sgs-home 部分。
-->
<template>
  <main class="mode-home">
    <section class="home">
      <header>
        <button type="button" @click="$emit('portal')">← 返回游戏中心</button>
        <span>CRPLAY · 红中麻将</span>
      </header>

      <div class="home__hero">
        <div class="home__seal" aria-hidden="true">中</div>
        <p>四人红中麻将</p>
        <h1>红中麻将</h1>
        <small>红中作癞子、自摸与点炮分开算番，支持单机与好友联机。</small>
      </div>

      <nav aria-label="游戏模式">
        <button type="button" class="home__main" @click="$emit('local')"><b>单机游戏</b><span>与电脑对战</span></button>
        <button type="button" class="home__online" @click="$emit('online')"><b>联机游戏</b><span>创建或加入房间</span></button>
        <button type="button" class="home__rules" @click="$emit('rules')"><b>规则</b><span>玩法与算番</span></button>
      </nav>
    </section>
  </main>
</template>

<style scoped>
.mode-home {
  width: 100%; height: calc(100dvh - var(--app-viewport-offset, 0px)); overflow: hidden; color: var(--ink-text);
  /* 麻将主色保持红色 */
  background: radial-gradient(circle at 70% 18%, rgba(190, 90, 76, .26), transparent 44%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom));
}
.home {
  width: min(980px, 100%); height: 100%; margin: auto; display: flex; flex-direction: column;
  padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
}
.home header { display: flex; justify-content: space-between; align-items: center; color: var(--ink-text-muted); font-size: 11px; letter-spacing: .15em; }
.home header button {
  min-height: 38px; padding: 0 13px; border: 1px solid var(--ink-line); border-radius: 9px;
  /* 麻将站有全局按钮样式，这里显式写死字号，才和纸上三国的顶栏按钮一致 */
  color: var(--ink-text-soft); background: var(--ink-panel-deep); cursor: pointer; font-size: 13.3333px;
}
.home header button:hover { border-color: var(--accent-gold); color: var(--ink-text); }

.home__hero { flex: 1; display: grid; place-content: center; justify-items: center; text-align: center; }
.home__seal {
  width: 88px; height: 88px; display: grid; place-items: center;
  border: 2px solid var(--accent-red); border-radius: 23px; color: #f07a67;
  font: 900 48px/1 STKaiti, KaiTi, serif; transform: rotate(-4deg); box-shadow: 0 0 50px rgba(207, 92, 80, .18);
}
.home__hero p { margin: 24px 0 8px; color: var(--accent-gold); font-size: 12px; letter-spacing: .18em; }
.home__hero h1 { margin: 0; font-size: clamp(55px, 10vw, 92px); line-height: 1; letter-spacing: -.08em; }
.home__hero small { max-width: 560px; margin-top: 22px; color: var(--ink-text-muted); line-height: 1.7; }

.home nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.home nav button {
  min-height: 74px; display: grid; align-content: center; gap: 4px;
  border: 1px solid var(--ink-line); border-radius: 15px; color: var(--ink-text-soft); background: rgba(34, 50, 42, .85);
  cursor: pointer; font: inherit; transition: filter .16s ease, transform .16s ease;
}
/* 三个入口的配色和纸上三国一致：金 / 红 / 绿。暗底上底色压暗、字色提亮保对比度 */
.home nav .home__main { border-color: var(--accent-gold); color: #ffeec0; background: linear-gradient(180deg, var(--accent-gold-fill-top), var(--accent-gold-fill-bottom)); }
.home nav .home__online { border-color: var(--accent-red); color: #ffd9d2; background: linear-gradient(180deg, var(--accent-red-fill-top), var(--accent-red-fill-bottom)); }
.home nav .home__rules { border-color: var(--accent-green); color: #d3f3da; background: linear-gradient(180deg, var(--accent-green-fill-top), var(--accent-green-fill-bottom)); }
.home nav button:hover { filter: brightness(1.08); }
.home nav button:active { transform: scale(.97); filter: brightness(.92); }
.home nav button:focus-visible { outline: 3px solid #f3d67c; outline-offset: 3px; }
.home nav b { font-size: 16px; }
.home nav span { font-size: 10px; }

/* 断点和纸上三国逐条对齐，改一边就要改另一边 */
@media (max-width: 620px) and (orientation: portrait) {
  .home nav { grid-template-columns: 1fr; }
  .home nav button { min-height: 58px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .home__seal { width: 58px; height: 58px; font-size: 32px; }
  .home__hero p { margin-top: 12px; }
  .home__hero h1 { font-size: 48px; }
  .home__hero small { margin-top: 8px; }
  .home nav button { min-height: 54px; }
}
@media (prefers-reduced-motion: reduce) { .home nav button { transition: none; } }
</style>
