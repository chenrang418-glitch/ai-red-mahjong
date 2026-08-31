<script setup lang="ts">
defineEmits<{ local: []; online: []; portal: [] }>()
</script>

<template>
  <main class="mode-home">
    <section>
      <div class="seal" aria-hidden="true">中</div>
      <h1>红中麻将</h1>
      <nav aria-label="游戏模式">
        <button type="button" @click="$emit('local')">单机模式</button>
        <button class="online" type="button" @click="$emit('online')">联机模式</button>
      </nav>
      <button class="portal-back" type="button" @click="$emit('portal')">← 返回游戏中心</button>
    </section>
  </main>
</template>

<style scoped>
.mode-home { width: 100%; height: 100dvh; display: grid; place-items: center; overflow: hidden; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); color: #f8f0dc; background: radial-gradient(circle at 50% 15%, #24493c 0, transparent 42%), #07130f; }
section { width: min(580px, 100%); text-align: center; }
.seal { width: 74px; height: 74px; margin: 0 auto 24px; display: grid; place-items: center; border: 2px solid #c64e45; border-radius: 20px; color: #dc5b50; font: 900 42px/1 serif; transform: rotate(-5deg); box-shadow: 0 0 32px rgba(198,78,69,.13); }
h1 { margin: 0 0 clamp(34px, 7vh, 64px); font-size: clamp(44px, 8vw, 78px); line-height: 1; letter-spacing: -.08em; }
nav { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
button { min-height: 68px; border: 1px solid rgba(226,195,105,.45); border-radius: 18px; background: linear-gradient(145deg, #ead082, #c9a64f); color: #162019; font-size: 20px; font-weight: 900; cursor: pointer; box-shadow: 0 16px 42px rgba(201,166,79,.15); transition: transform .16s ease, filter .16s ease, box-shadow .16s ease; }
button.online { border-color: rgba(206,83,73,.55); background: linear-gradient(145deg, #c8564c, #94352f); color: #fff3ed; box-shadow: 0 16px 42px rgba(148,53,47,.18); }
button:hover { filter: brightness(1.07); }
button:active { transform: scale(.96); filter: brightness(.92); box-shadow: 0 5px 16px rgba(0,0,0,.28); }
button:focus-visible { outline: 3px solid #f3d67c; outline-offset: 4px; }
.portal-back { min-height: 40px; margin-top: 18px; padding: 7px 14px; border-color: transparent; color: #9cacA5; background: transparent; box-shadow: none; font-size: 12px; }
.portal-back:hover { color: #f3d67c; }
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  section { width: min(430px, 100%); }
  .seal { width: 62px; height: 62px; margin-bottom: 20px; font-size: 35px; }
  h1 { margin-bottom: clamp(32px, 8vh, 62px); font-size: clamp(42px, 14vw, 62px); }
  nav { grid-template-columns: 1fr; gap: 14px; }
  nav button { min-height: 64px; font-size: 19px; }
}
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  section { width: min(680px, 82vw); display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; align-items: center; gap: 12px 28px; }
  .seal { grid-row: 1 / 3; width: 66px; height: 66px; margin: 0; font-size: 37px; }
  h1 { margin: 0; font-size: clamp(34px, 9vh, 52px); text-align: left; }
  nav { gap: 12px; }
  nav button { min-height: 52px; font-size: 17px; }
  .portal-back { grid-column: 2; margin-top: 0; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
