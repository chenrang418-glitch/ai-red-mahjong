<script setup lang="ts">
import { onMounted, ref } from 'vue'
import NoticeOverlay from './NoticeOverlay.vue'
import { FULL_DISCLAIMER_SECTIONS, FULL_DISCLAIMER_TITLE } from '@/notice/noticeContent'

/**
 * 完整的「项目声明与免责声明」。
 *
 * 两个地方会用到同一个组件：
 * 1. 首次访问弹窗里点「查看完整声明」——这时候关闭要回到首次弹窗，
 *    由外层的 `ProjectNoticeGate` 决定 `close` 之后做什么；
 * 2. Footer 里点「项目声明与免责声明」——这时候关闭就是单纯收起弹窗。
 * 组件本身不关心自己是被谁打开的，只管展示内容和把 close 事件交出去，
 * 这样内容和样式只维护一份，不会出现「首次弹窗版」和「Footer 版」文字不一致。
 *
 * 这是用户主动点开的二级信息，所以和首次弹窗相反：允许 ×、ESC、点遮罩关闭。
 */
defineEmits<{ close: [] }>()

const closeButton = ref<HTMLButtonElement | null>(null)
onMounted(() => closeButton.value?.focus())
</script>

<template>
  <NoticeOverlay
    labelled-by="full-disclaimer-title"
    max-width="640px"
    max-height="80vh"
    mobile-max-width="calc(100vw - 24px)"
    mobile-max-height="82vh"
    class="full-disclaimer"
    @close="$emit('close')"
  >
    <header class="full-disclaimer__header">
      <h2 id="full-disclaimer-title">{{ FULL_DISCLAIMER_TITLE }}</h2>
    </header>

    <div class="full-disclaimer__body">
      <section v-for="section in FULL_DISCLAIMER_SECTIONS" :key="section.heading || section.paragraphs[0]">
        <h3 v-if="section.heading">{{ section.heading }}</h3>
        <p v-for="paragraph in section.paragraphs" :key="paragraph">{{ paragraph }}</p>
      </section>
    </div>

    <footer class="full-disclaimer__footer">
      <button ref="closeButton" type="button" class="full-disclaimer__close-btn" @click="$emit('close')">关闭</button>
    </footer>
  </NoticeOverlay>
</template>

<style scoped>
.full-disclaimer :deep(.notice-overlay__panel) { gap: 0; padding-right: 26px; }

.full-disclaimer__header {
  flex: none;
  padding-right: 34px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ink-line);
}
.full-disclaimer__header h2 {
  margin: 0;
  color: #f3d67c;
  font-size: 18px;
  font-weight: 800;
}

.full-disclaimer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 14px;
  padding-right: 4px;
}
.full-disclaimer__body section + section { margin-top: 18px; }
.full-disclaimer__body h3 {
  margin: 0 0 8px;
  color: #e8c96e;
  font-size: 14px;
  font-weight: 700;
}
.full-disclaimer__body p {
  margin: 0 0 10px;
  color: var(--ink-text-soft);
  font-size: 13px;
  line-height: 1.75;
}
.full-disclaimer__body p:last-child { margin-bottom: 0; }

.full-disclaimer__footer {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}
.full-disclaimer__close-btn {
  min-height: 40px;
  padding: 0 20px;
  border: 1px solid #3a574d;
  border-radius: 10px;
  background: #142e26;
  color: #d5e0da;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.full-disclaimer__close-btn:hover { border-color: #4d6f62; }
.full-disclaimer__close-btn:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }
</style>
