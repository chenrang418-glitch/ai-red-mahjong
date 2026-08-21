<script setup lang="ts">
import { ref } from 'vue'

// 顶栏在手机竖屏上原本要占满一整行按钮，其中大部分是低频操作。
// 这里把它们收进一个菜单，顶栏只留最高频的那一两个。
const open = ref(false)
</script>

<template>
  <div class="topbar-menu">
    <button class="menu-trigger" type="button" :aria-expanded="open" aria-label="更多操作" @click="open = !open">⋯</button>
    <template v-if="open">
      <div class="menu-mask" @click="open = false"></div>
      <section class="menu-popover">
        <header><strong>更多</strong><button type="button" aria-label="关闭" @click="open = false">×</button></header>
        <div class="menu-items" @click="open = false"><slot /></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.topbar-menu { position: relative; flex: 0 0 auto; }
.menu-trigger {
  min-width: 44px;
  min-height: 34px;
  padding: 4px 12px;
  border: 1px solid #2d4a41;
  border-radius: 9px;
  background: linear-gradient(180deg, #143028, #0e2119);
  color: #d8dfda;
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
}
.menu-trigger:hover { border-color: #d3b45e; color: #f3d77f; }
.menu-mask { position: fixed; inset: 0; z-index: 88; background: rgba(0,0,0,.5); }
.menu-popover {
  position: absolute;
  z-index: 89;
  top: calc(100% + 8px);
  right: 0;
  min-width: 176px;
  display: grid;
  gap: 5px;
  padding: 8px;
  border: 1px solid #496258;
  border-radius: 14px;
  background: #10251f;
  box-shadow: 0 18px 45px rgba(0,0,0,.5);
}
.menu-popover > header { display: none; }
.menu-items { display: grid; gap: 5px; }
/* 菜单里的按钮统一撑满，手指点得中 */
.menu-popover :deep(button) {
  width: 100%;
  min-height: 44px;
  padding: 10px 13px;
  border: 1px solid #2d4a41;
  border-radius: 10px;
  background: #14302a;
  color: #e4dcc4;
  cursor: pointer;
  font-size: 14px;
  text-align: left;
}
.menu-popover :deep(button b) { font: inherit; }
.menu-popover :deep(button span) { margin-left: auto; color: #82978f; font-size: 12px; font-weight: 400; }
.menu-popover :deep(button:hover) { border-color: #d3b45e; color: #f3d77f; }
.menu-popover :deep(button.danger) { color: #eba9a2; border-color: #6d3833; }
.menu-popover :deep(.audio-control) { width: 100%; }
.menu-popover :deep(.audio-trigger) { width: 100%; min-height: 44px; text-align: left; justify-content: flex-start; }
.menu-popover :deep(.audio-popover) { right: 0; top: calc(100% + 6px); width: min(310px, calc(100vw - 40px)); }

@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .menu-popover {
    position: fixed;
    z-index: 89;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    min-width: 0;
    padding: 0 0 calc(18px + env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid #355249;
    border-radius: 22px 22px 0 0;
    background: #0c211b;
    animation: menu-up .22s ease;
  }
  .menu-popover > header {
    min-height: 62px;
    padding: 0 18px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid #1d352d;
  }
  .menu-popover > header strong { color: #f3d67c; font-size: 21px; }
  .menu-popover > header button { width: 42px; min-height: 42px; padding: 0; border: 0; background: transparent; color: #8ba49c; font-size: 30px; text-align: center; }
  .menu-items { gap: 10px; padding: 14px 18px 0; }
  .menu-popover .menu-items :deep(button) {
    min-height: 64px;
    display: flex;
    align-items: center;
    padding: 0 18px;
    border: 1px solid #355249;
    border-radius: 15px;
    background: #102a22;
    color: #eee4c8;
    font-size: 18px;
    font-weight: 800;
  }
  .menu-popover .menu-items :deep(button.danger) { border-color: #8d4841; color: #eba9a2; }
  @keyframes menu-up { from { transform: translateY(100%); } }
}

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .menu-popover {
    top: 50%; left: 50%; right: auto; bottom: auto;
    width: min(470px, 72vw);
    padding-bottom: 14px;
    border: 1px solid #355249;
    border-radius: 16px;
    transform: translate(-50%, -50%);
    animation: menu-fade .18s ease;
  }
  .menu-popover > header { min-height: 46px; padding: 0 16px; }
  .menu-popover > header strong { font-size: 18px; }
  .menu-popover > header button { width: 34px; min-height: 34px; font-size: 25px; }
  .menu-items { gap: 7px; padding: 10px 14px 0; }
  .menu-popover .menu-items :deep(button) { min-height: 44px; padding: 0 14px; border-radius: 10px; font-size: 15px; }
  @keyframes menu-fade { from { opacity: 0; transform: translate(-50%, -47%); } }
}
</style>
