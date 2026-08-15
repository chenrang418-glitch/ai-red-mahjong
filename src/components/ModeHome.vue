<script setup lang="ts">
defineEmits<{ local: []; online: [] }>()
</script>

<template>
  <main class="mode-home">
    <section class="mode-hero">
      <div class="mode-seal">中</div>
      <p>四人红中麻将 · 浏览器直接游玩</p>
      <h1>AI 红中麻将</h1>
      <span>选择一种方式开局，单机与联机数据相互独立。</span>
    </section>

    <section class="mode-cards" aria-label="游戏模式">
      <article class="mode-card local-card">
        <small>LOCAL MATCH</small>
        <div class="mode-icon">单</div>
        <h2>单机游戏</h2>
        <p>你与三个离线 AI 对局，保留现有存档、牌谱、声音和全部 AI 设置。</p>
        <ul><li>无需联网</li><li>支持继续上次牌局</li><li>AI 档位自由调整</li></ul>
        <button type="button" @click="$emit('local')">进入单机游戏</button>
      </article>

      <article class="mode-card online-card">
        <small>ONLINE MODE</small>
        <div class="mode-icon">联</div>
        <h2>联机模式</h2>
        <p>使用房间号与其他玩家实时对局，支持断线重连、AI 托管、聊天和排行榜。</p>
        <ul><li>最多四名真人</li><li>空位自动补 AI</li><li>昵称直接登录</li></ul>
        <button type="button" @click="$emit('online')">进入联机游戏</button>
      </article>
    </section>

    <footer><span>112 张</span><span>只能自摸</span><span>支持七对</span><span>六码抓码</span></footer>
  </main>
</template>

<style scoped>
.mode-home { min-height: 100vh; min-height: 100dvh; display: grid; align-content: center; gap: 30px; padding: 48px clamp(18px, 6vw, 80px); color: #f6f0df; background: radial-gradient(circle at 10% 0, #28493e 0, transparent 32%), radial-gradient(circle at 90% 100%, #3a2520 0, transparent 29%), #091410; }
.mode-hero { position: relative; width: min(1040px, 100%); margin: auto; }
.mode-hero p { margin: 0 0 8px; color: #d6b765; font-size: 12px; font-weight: 800; letter-spacing: .24em; }
.mode-hero h1 { margin: 0; font-size: clamp(42px, 7vw, 76px); line-height: 1; letter-spacing: -.06em; }
.mode-hero > span { display: block; margin-top: 13px; color: #91a69f; }
.mode-seal { position: absolute; right: 2%; top: 0; width: 88px; height: 88px; display: grid; place-items: center; border: 2px solid #bd4b43; border-radius: 22px; color: #d1584e; font: 800 50px/1 serif; transform: rotate(7deg); }
.mode-cards { width: min(1040px, 100%); margin: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.mode-card { position: relative; min-height: 360px; padding: 28px; overflow: hidden; border: 1px solid #345047; border-radius: 25px; background: rgba(14, 34, 29, .94); box-shadow: 0 24px 80px rgba(0,0,0,.3); }
.mode-card::after { content: ''; position: absolute; right: -60px; bottom: -70px; width: 210px; height: 210px; border-radius: 50%; background: rgba(224, 194, 105, .05); }
.online-card { border-color: #6b4c45; background: linear-gradient(145deg, rgba(24,42,35,.96), rgba(38,27,24,.96)); }
.mode-card small { color: #758b84; font-size: 10px; font-weight: 800; letter-spacing: .22em; }
.mode-icon { width: 55px; height: 55px; margin-top: 30px; display: grid; place-items: center; border-radius: 17px; background: #23463b; color: #ebce76; font-size: 20px; font-weight: 900; }
.online-card .mode-icon { background: #6e332e; color: #ffe0dc; }
.mode-card h2 { margin: 16px 0 8px; font-size: 28px; }
.mode-card p { min-height: 46px; margin: 0; color: #98aaa4; font-size: 13px; line-height: 1.7; }
.mode-card ul { display: flex; flex-wrap: wrap; gap: 7px; margin: 19px 0 26px; padding: 0; list-style: none; }
.mode-card li { padding: 6px 9px; border: 1px solid #2f4c43; border-radius: 99px; color: #c8bc94; font-size: 10px; }
.mode-card button { position: relative; z-index: 1; width: 100%; padding: 14px; border: 0; border-radius: 12px; background: #e5c66d; color: #20261d; font-weight: 900; cursor: pointer; }
.online-card button { background: #b84c43; color: white; }
footer { display: flex; justify-content: center; flex-wrap: wrap; gap: 10px; color: #6f847d; font-size: 10px; }
footer span + span::before { content: '·'; margin-right: 10px; }
@media (max-width: 700px) {
  .mode-home { align-content: start; gap: 23px; padding-top: max(34px, env(safe-area-inset-top)); padding-bottom: max(32px, env(safe-area-inset-bottom)); }
  .mode-seal { display: none; }
  .mode-hero h1 { font-size: 44px; }
  .mode-cards { grid-template-columns: 1fr; }
  .mode-card { min-height: 0; padding: 22px; }
  .mode-icon { margin-top: 18px; }
  .mode-card p { min-height: 0; }
}
</style>
