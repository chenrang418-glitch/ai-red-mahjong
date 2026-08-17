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
      <div class="menu-popover" @click="open = false">
        <slot />
      </div>
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
.menu-mask { position: fixed; inset: 0; z-index: 88; }
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
.menu-popover :deep(button:hover) { border-color: #d3b45e; color: #f3d77f; }
.menu-popover :deep(button.danger) { color: #eba9a2; border-color: #6d3833; }
.menu-popover :deep(.audio-control) { width: 100%; }
.menu-popover :deep(.audio-trigger) { width: 100%; min-height: 44px; text-align: left; justify-content: flex-start; }
.menu-popover :deep(.audio-popover) { right: 0; top: calc(100% + 6px); width: min(310px, calc(100vw - 40px)); }
</style>
