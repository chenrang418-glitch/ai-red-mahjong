<script setup lang="ts">
import FullscreenHelp from '@/components/FullscreenHelp.vue'

defineEmits<{ local: []; online: [] }>()
</script>

<template>
  <main class="mode-home">
    <section class="mode-hero">
      <div class="mode-seal">中</div>
      <FullscreenHelp />
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
.mode-home { height: 100dvh; overflow: hidden; display: grid; align-content: center; gap: clamp(14px, 2.5vh, 30px); padding: clamp(18px, 4vh, 48px) clamp(18px, 6vw, 80px); color: #f6f0df; background: radial-gradient(circle at 10% 0, #28493e 0, transparent 32%), radial-gradient(circle at 90% 100%, #3a2520 0, transparent 29%), #091410; }
.mode-hero { position: relative; width: min(1040px, 100%); margin: auto; padding-right: 60px; }
.mode-hero p { margin: 0 0 8px; color: #d6b765; font-size: 12px; font-weight: 800; letter-spacing: .24em; }
.mode-hero h1 { margin: 0; font-size: clamp(42px, 7vw, 76px); line-height: 1.2; letter-spacing: -.06em; }
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
  /* 一屏放下：标题一块、两张卡等分剩下的高度、底部一行摘要，不出现滚动 */
  .mode-home {
    height: 100dvh;
    align-content: stretch;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 14px;
    padding: max(18px, env(safe-area-inset-top)) 18px calc(14px + env(safe-area-inset-bottom));
  }
  .mode-hero { display: grid; gap: 4px; }
  .mode-hero p { margin: 0; font-size: 10px; }
  /* 标题跟着视口高度缩，矮屏不至于把两张卡挤没 */
  .mode-hero h1 { font-size: clamp(28px, 4.6vh, 38px); line-height: 1.2; }
  .mode-hero > span { margin-top: 2px; font-size: 12px; }
  /* 印章留着：小程序上也有，是整页唯一的装饰 */
  .mode-hero { padding-right: 0; }
  /* 右上角让给「全屏」入口，印章挪到它下面 */
  .mode-seal { display: grid; right: 2px; top: 34px; width: 46px; height: 46px; border-radius: 13px; font-size: 25px; }
  .mode-cards { grid-template-columns: 1fr; grid-auto-rows: 1fr; gap: clamp(8px, 1.4vh, 12px); min-height: 0; }
  /* 尺寸全部跟着视口高度走：矮屏自动收，不靠裁切 */
  .mode-card {
    min-height: 0;
    padding: clamp(10px, 1.7vh, 16px) 16px;
    display: flex; flex-direction: column;
    border-radius: clamp(14px, 2vh, 20px);
    overflow: hidden;
  }
  .mode-card small { font-size: 9px; }
  .mode-icon {
    width: clamp(30px, 4.6vh, 42px); height: clamp(30px, 4.6vh, 42px);
    margin-top: clamp(5px, 1vh, 10px);
    border-radius: 11px;
    font-size: clamp(13px, 2vh, 17px);
  }
  .mode-card h2 { margin: clamp(5px, 1vh, 10px) 0 3px; font-size: clamp(17px, 2.7vh, 22px); }
  /* 描述最多两行，放不下就省略，不许把卡片撑高 */
  .mode-card p {
    min-height: 0; margin: 0;
    font-size: clamp(10px, 1.5vh, 12px); line-height: 1.5;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .mode-card ul { margin: auto 0 clamp(7px, 1.2vh, 12px); padding-top: clamp(6px, 1vh, 10px); gap: 4px; }
  .mode-card li { padding: 3px 7px; font-size: 9px; }
  .mode-card button { padding: clamp(9px, 1.5vh, 12px); font-size: clamp(13px, 2vh, 15px); border-radius: 10px; }
  footer { font-size: 9px; gap: 8px; }
}
</style>
