<script setup lang="ts">
defineEmits<{ backToPortal: [] }>()
</script>

<template>
  <main class="sgs-app">
    <section class="sgs-home">
      <header>
        <button type="button" @click="$emit('backToPortal')">← 返回游戏中心</button>
        <span>CRPLAY · 三国杀</span>
      </header>
      <div class="sgs-home__hero">
        <div class="sgs-home__seal" aria-hidden="true">杀</div>
        <p>经典身份局 · 规则引擎优先</p>
        <h1>三国杀</h1>
        <small>Phase A 平台接入已完成，规则引擎正在建设。本页不会伪装成已可游玩的版本。</small>
      </div>
      <nav aria-label="三国杀模式">
        <button type="button" disabled><b>单机游戏</b><span>开发中</span></button>
        <button type="button" disabled><b>联机游戏</b><span>开发中</span></button>
        <button type="button" disabled><b>规则</b><span>待 ruleset-v1 完成</span></button>
      </nav>
    </section>
  </main>
</template>

<style scoped>
.sgs-app { width: 100%; height: 100dvh; overflow: hidden; color: #f4ead6; background: radial-gradient(circle at 75% 20%, rgba(132,42,32,.28), transparent 35%), linear-gradient(150deg, #171713, #090d0b); }
.sgs-home { width: min(980px, 100%); height: 100%; margin: auto; display: flex; flex-direction: column; padding: max(22px, env(safe-area-inset-top)) max(22px, env(safe-area-inset-right)) max(22px, env(safe-area-inset-bottom)) max(22px, env(safe-area-inset-left)); }
.sgs-home header { display: flex; justify-content: space-between; align-items: center; color: #887d69; font-size: 11px; letter-spacing: .15em; }
.sgs-home header button { min-height: 38px; padding: 0 13px; border: 1px solid #4a453a; border-radius: 9px; color: #d7c8aa; background: #171c18; cursor: pointer; }
.sgs-home__hero { flex: 1; display: grid; place-content: center; justify-items: center; text-align: center; }
.sgs-home__seal { width: 88px; height: 88px; display: grid; place-items: center; border: 2px solid #af4437; border-radius: 23px; color: #cc5546; font: 900 48px/1 STKaiti, KaiTi, serif; transform: rotate(-4deg); box-shadow: 0 0 50px rgba(175,68,55,.13); }
.sgs-home__hero p { margin: 24px 0 8px; color: #b19d79; font-size: 12px; letter-spacing: .18em; }
.sgs-home__hero h1 { margin: 0; font-size: clamp(55px, 10vw, 92px); line-height: 1; letter-spacing: -.08em; }
.sgs-home__hero small { max-width: 560px; margin-top: 22px; color: #7f8a84; line-height: 1.7; }
.sgs-home nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.sgs-home nav button { min-height: 74px; display: grid; align-content: center; gap: 4px; border: 1px solid #3b443f; border-radius: 15px; color: #767f7a; background: rgba(18,26,22,.85); }
.sgs-home nav b { font-size: 16px; }
.sgs-home nav span { font-size: 10px; }
@media (max-width: 620px) and (orientation: portrait) { .sgs-home nav { grid-template-columns: 1fr; } .sgs-home nav button { min-height: 58px; } }
@media (max-height: 500px) and (orientation: landscape) { .sgs-home__seal { width: 58px; height: 58px; font-size: 32px; } .sgs-home__hero p { margin-top: 12px; } .sgs-home__hero h1 { font-size: 48px; } .sgs-home__hero small { margin-top: 8px; } .sgs-home nav button { min-height: 54px; } }
</style>
