<script setup lang="ts">
import { onMounted, ref } from 'vue'
import NoticeOverlay from './NoticeOverlay.vue'
import { FIRST_VISIT_PARAGRAPHS, FIRST_VISIT_TITLE } from '@/notice/noticeContent'

/**
 * 全站首次访问的门槛弹窗。
 *
 * 不是用户协议，所以只有一个「我知道了」——没有「同意/不同意」，
 * 也不提供任何关闭手段（没有 ×、ESC 不关、点遮罩不关）：这三条都由
 * `NoticeOverlay` 的 `closable=false` 统一挡掉，这里不用重复判断。
 *
 * 「查看完整声明」只是跳去看更详细的版本，**不代表已经确认**——
 * 点它不会触发 accept，真正记进 localStorage 的只有「我知道了」。
 */
defineEmits<{ accept: []; viewFull: [] }>()

const primaryButton = ref<HTMLButtonElement | null>(null)
// 弹窗一出现焦点就落在主按钮上，键盘用户不用先 Tab 一轮才够得到「我知道了」
onMounted(() => primaryButton.value?.focus())
</script>

<template>
  <NoticeOverlay
    labelled-by="first-visit-notice-title"
    :closable="false"
    max-width="460px"
    max-height="75vh"
    mobile-max-width="calc(100vw - 32px)"
    mobile-max-height="75vh"
    class="first-visit-notice"
  >
    <h2 id="first-visit-notice-title">{{ FIRST_VISIT_TITLE }}</h2>
    <div class="first-visit-notice__body">
      <p v-for="paragraph in FIRST_VISIT_PARAGRAPHS" :key="paragraph">{{ paragraph }}</p>
    </div>
    <div class="first-visit-notice__actions">
      <button type="button" class="first-visit-notice__secondary" @click="$emit('viewFull')">查看完整声明</button>
      <button ref="primaryButton" type="button" class="first-visit-notice__primary" @click="$emit('accept')">我知道了</button>
    </div>
  </NoticeOverlay>
</template>

<style scoped>
.first-visit-notice :deep(.notice-overlay__panel) { gap: 0; }

.first-visit-notice h2 {
  margin: 0 0 14px;
  color: #f3d67c;
  font-size: 19px;
  font-weight: 800;
  text-align: center;
}

.first-visit-notice__body {
  overflow-y: auto;
  min-height: 0;
}
.first-visit-notice__body p {
  margin: 0 0 12px;
  color: var(--ink-text-soft);
  font-size: 13.5px;
  line-height: 1.75;
}
.first-visit-notice__body p:last-child { margin-bottom: 0; }

.first-visit-notice__actions {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  margin-top: 20px;
}

/* 「查看完整声明」是次级操作：文字按钮，不和主按钮抢视觉权重 */
.first-visit-notice__secondary {
  padding: 8px 4px;
  border: none;
  background: none;
  color: var(--ink-text-muted);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.first-visit-notice__secondary:hover { color: var(--ink-text-soft); }
.first-visit-notice__secondary:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; border-radius: 4px; }

.first-visit-notice__primary {
  min-height: 42px;
  padding: 0 22px;
  border: 1px solid #9e7f3c;
  border-radius: 11px;
  background: linear-gradient(180deg, #6d5527, #4c3b1a);
  color: #ffe6a8;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
}
.first-visit-notice__primary:hover { filter: brightness(1.08); }
.first-visit-notice__primary:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }

@media (max-width: 480px) {
  .first-visit-notice__actions { justify-content: space-between; gap: 10px; }
  .first-visit-notice__primary { flex: 1; }
  .first-visit-notice__secondary { flex: none; }
}

/* 极窄屏两个按钮才竖排；宽度足够时不会被强行拆行 */
@media (max-width: 340px) {
  .first-visit-notice__actions { flex-direction: column-reverse; align-items: stretch; }
  .first-visit-notice__secondary { text-align: center; }
}
</style>
