<script setup lang="ts">
import AudioControl from './game/AudioControl.vue'
defineEmits<{ local: []; online: []; rules: []; portal: [] }>()
</script>


<template>
  <main class="mode-home">
    <section class="home">
      <header>
        <button type="button" @click="$emit('portal')">← 返回游戏中心</button>
        <span>CRPLAY · 红中麻将</span>
        <AudioControl />
      </header>

      <div class="home__hero">
        <div class="home__copy"><p>四人红中 · 好牌相逢</p><h1>红中麻将</h1><h2>一桌好牌，一起开怀。</h2><small>红中作癞子，自摸与点炮分开算番。<br>独自练手，或邀好友同桌。</small><div class="home__facts"><span>4 人同桌</span><span>单机练习</span><span>好友联机</span></div></div>
        <div class="home__art" aria-hidden="true"><div class="home__ring"></div><span class="home__tile home__tile--left">二<small>萬</small></span><span class="home__seal">中</span><span class="home__tile home__tile--right">六<small>萬</small></span></div>
      </div>

      <nav aria-label="游戏模式">
        <button type="button" class="home__main" @click="$emit('local')"><em aria-hidden="true">弈</em><b>单机游戏</b><span>与电脑对战 · 随时开局</span><i aria-hidden="true">↗</i></button>
        <button type="button" class="home__online" @click="$emit('online')"><em aria-hidden="true">聚</em><b>联机游戏</b><span>创建或加入房间 · 好友同桌</span><i aria-hidden="true">↗</i></button>
        <button type="button" class="home__rules" @click="$emit('rules')"><em aria-hidden="true">知</em><b>规则</b><span>玩法与算番 · 轻松上手</span><i aria-hidden="true">↗</i></button>
      </nav>
      <footer><span>好牌不怕晚，好局一起玩</span><span>CRPLAY / MAHJONG</span></footer>
    </section>
  </main>
</template>

<style scoped>
.mode-home { width: 100%; height: calc(100dvh - var(--app-viewport-offset, 0px)); overflow: hidden; color: var(--ink-text); background: radial-gradient(ellipse at 75% 30%, #3a5b4970, transparent 50%), linear-gradient(135deg, var(--ink-bg-top), var(--ink-bg-bottom)); }
.home { width: min(1240px, 100%); height: 100%; margin: auto; padding: max(24px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left)); display: flex; flex-direction: column; }
.home > header { flex: none; display: flex; justify-content: space-between; align-items: center; padding-bottom: 18px; border-bottom: 1px solid #d8b77726; color: var(--ink-text-muted); font-size: 10px; letter-spacing: .15em; }
.home > header > button, .home > header :deep(.audio-trigger) { min-height: 38px; padding: 0 13px; border: 1px solid var(--ink-line); border-radius: 9px; background: var(--ink-panel-deep); color: var(--ink-text-soft); font-size: 13px; font-weight: 400; line-height: 1.3; letter-spacing: normal; cursor: pointer; }
.home__hero { flex: 1; min-height: 0; display: grid; grid-template-columns: 1.1fr 1fr; align-items: center; position: relative; }
.home__copy { position: relative; z-index: 1; padding-left: 20px; }
.home__copy > p { margin: 0 0 22px; color: var(--accent-gold); font-size: 12px; letter-spacing: .2em; }
.home__copy h1 { margin: 0; color: #f4ead6; font: 400 clamp(54px, 6.5vw, 88px)/1.2 STKaiti, KaiTi, serif; letter-spacing: .03em; }
.home__copy h2 { margin: 20px 0 16px; color: #e0c89d; font-size: 20px; font-weight: 400; letter-spacing: .15em; }
.home__copy > small { color: var(--ink-text-muted); font-size: 13px; line-height: 1.9; }
.home__facts { display: flex; gap: 18px; margin-top: 30px; color: #c4c8ae; font-size: 11px; }
.home__facts span + span { border-left: 1px solid #d8b77740; padding-left: 18px; }
.home__art { position: relative; height: min(390px, 100%); min-height: 0; }
.home__ring { position: absolute; inset: 4%; border: 1px solid #d8b77730; border-radius: 50%; }
.home__seal, .home__tile { position: absolute; left: 36%; top: 21%; display: grid; align-content: center; justify-items: center; width: 30%; height: auto; aspect-ratio: 3 / 4; border: 1px solid #fff2cd; border-radius: 16px; background: linear-gradient(135deg, #f6efdb, #c5c6a7); box-shadow: 6px 10px 0 #5a7c68, 10px 28px 35px #0004; color: #a34437; font: 400 clamp(50px, 6vw, 85px)/1 STKaiti, KaiTi, serif; transform: rotate(-9deg); }
.home__seal { z-index: 1; }
.home__tile { font-size: 40px; color: #354f43; }
.home__tile small { font-size: 34px; }
.home__tile--left { left: 12%; top: 28%; transform: rotate(-24deg); }
.home__tile--right { left: 61%; top: 30%; transform: rotate(15deg); }
.home nav { flex: none; display: grid; grid-template-columns: 1.1fr 1.1fr 1fr; gap: 14px; }
.home nav button { position: relative; min-width: 0; min-height: 104px; padding: 22px 35px 22px 70px; display: grid; align-content: center; gap: 8px; border: 1px solid #51635a; border-radius: 12px; background: linear-gradient(115deg, #223938, #142629); color: #e5ddcc; cursor: pointer; text-align: left; }
.home nav .home__main { background: linear-gradient(115deg, #e0c48b, #ba9659); color: #24291e; border-color: #efdaa8; }
.home nav .home__rules { background: linear-gradient(115deg, #172a2c, #102023); }
.home nav b { font-size: 19px; font-weight: 600; letter-spacing: .08em; }
.home nav span { font-size: 11px; opacity: .8; }
.home nav em { position: absolute; left: 23px; top: 50%; transform: translateY(-50%); font: 28px/1 STKaiti, KaiTi, serif; opacity: .75; }
.home nav i { position: absolute; top: 20px; right: 18px; font-size: 20px; font-style: normal; opacity: .6; }
.home footer { display: flex; justify-content: space-between; padding-top: 16px; color: #8aa29a; font-size: 10px; letter-spacing: .1em; }
@media (hover: hover) { .home nav button:hover { transform: translateY(-3px); border-color: #f0d6a0; box-shadow: 0 10px 28px #0004; } }
@media (max-width: 700px) and (orientation: portrait) {
  .home { padding: max(16px, env(safe-area-inset-top)) 20px max(16px, env(safe-area-inset-bottom)); }
  .home > header { padding-bottom: 12px; }
  .home > header > span { display: none; }
  .home__hero { display: flex; }
  .home__copy { padding-left: 0; }
  .home__copy h1 { font-size: clamp(45px, 13vw, 70px); }
  .home__copy h2 { font-size: 16px; letter-spacing: .06em; }
  .home__copy > p { font-size: 10px; }
  .home__copy > small { font-size: 12px; }
  .home__art { position: absolute; right: -40px; top: 8%; width: 80%; height: 85%; opacity: .22; }
  .home__facts { gap: 12px; font-size: 10px; margin-top: 24px; }
  .home__facts span + span { padding-left: 12px; }
  .home nav { grid-template-columns: 1fr; gap: 10px; }
  .home nav button { min-height: 76px; padding: 14px 40px 14px 64px; gap: 5px; }
  .home nav b { font-size: 17px; }
  .home nav em { left: 22px; font-size: 25px; }
  .home footer { font-size: 9px; letter-spacing: .04em; }
}
@media (max-height: 700px) and (orientation: portrait) {
  .home__copy > p { margin-bottom: 12px; }
  .home__copy h2 { margin: 12px 0 8px; }
  .home__facts { margin-top: 12px; }
  .home nav button { min-height: 62px; padding-block: 10px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .home { padding: max(10px, env(safe-area-inset-top)) 20px max(10px, env(safe-area-inset-bottom)); }
  .home > header { padding-bottom: 8px; }
  .home__copy { padding-left: 8px; }
  .home__copy > p { margin-bottom: 8px; font-size: 10px; }
  .home__copy h1 { font-size: 45px; }
  .home__copy h2 { margin: 10px 0 0; font-size: 15px; }
  .home__copy > small { display: none; }
  .home__facts { margin-top: 12px; font-size: 10px; }
  .home__tile { font-size: 25px; }
  .home__tile small { font-size: 23px; }
  .home__seal { font-size: 45px; }
  .home nav button { min-height: 65px; padding: 12px 25px 12px 49px; gap: 5px; }
  .home nav b { font-size: 16px; }
  .home nav span { font-size: 9px; }
  .home nav em { left: 15px; font-size: 23px; }
  .home footer { padding-top: 8px; font-size: 9px; }
}
@media (prefers-reduced-motion: reduce) { .home nav button { transition: none; } }
</style>
