<script setup lang="ts">
/**
 * 「项目说明」体系三个弹窗共用的遮罩 + 卡片外壳。
 *
 * 抽出来是因为背景遮罩、卡片动画、ARIA 属性、ESC/点遮罩关闭这几件事
 * 三个弹窗要做的完全一样，散写三份迟早会有一份漏了 `aria-modal`
 * 或者对不上另外两份的 z-index。这里只处理「怎么是一个弹窗」，
 * 不关心「弹窗里放什么」——正文交给调用方通过插槽传入。
 *
 * `closable=false` 时（首次项目说明）：不渲染右上角关闭按钮，
 * ESC 和点击遮罩都不触发 close，逼用户走「我知道了」按钮完成确认。
 *
 * 尺寸没有钉死成一套：三个弹窗在任务书里给的宽高各不一样（首次说明
 * 460px/75vh，完整声明 640px/80vh 移动端 82vh），所以都做成 prop，
 * 由调用方按各自的规格传入，外壳只负责统一套用。
 */
const props = withDefaults(defineProps<{
  labelledBy: string
  closable?: boolean
  maxWidth: string
  maxHeight?: string
  mobileMaxWidth?: string
  mobileMaxHeight?: string
}>(), {
  closable: true,
  maxHeight: '80vh',
})

const emit = defineEmits<{ close: [] }>()

function onBackdropClick(): void {
  if (props.closable) emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (props.closable && event.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="notice-overlay" @keydown="onKeydown" @click.self="onBackdropClick">
    <section
      class="notice-overlay__panel"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="labelledBy"
      :style="{
        '--notice-max-width': maxWidth,
        '--notice-max-height': maxHeight,
        '--notice-mobile-max-width': mobileMaxWidth ?? `calc(100vw - 40px)`,
        '--notice-mobile-max-height': mobileMaxHeight ?? maxHeight,
      }"
      tabindex="-1"
    >
      <button
        v-if="closable"
        type="button"
        class="notice-overlay__close"
        aria-label="关闭"
        @click="emit('close')"
      >×</button>
      <slot />
    </section>
  </div>
</template>

<style scoped>
/*
 * 视觉上延续站内已有的弹窗语言（.confirm-backdrop / .rules-backdrop 那一套）：
 * 深墨绿卡片、金色强调、轻微上浮进场，而不是另起一套设计系统。
 * 这几个组件在 RootApp 挂载最早期就可能出现，不能依赖只有麻将才加载的
 * main.css，所以样式在这里独立写一份，用的是同一份全局 --ink-* 变量。
 */
.notice-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
  background: rgba(0, 0, 0, .6);
  backdrop-filter: blur(4px);
  animation: notice-veil-in .18s ease-out;
}

.notice-overlay__panel {
  position: relative;
  width: min(var(--notice-max-width), calc(100vw - 40px));
  max-height: var(--notice-max-height);
  display: flex;
  flex-direction: column;
  padding: 26px 26px 22px;
  border: 1px solid rgba(226, 191, 98, .34);
  border-radius: 20px;
  background: linear-gradient(160deg, #14332a, #0b2119);
  box-shadow: 0 26px 70px rgba(0, 0, 0, .55);
  color: var(--ink-text);
  animation: notice-rise-in .2s cubic-bezier(.2, .82, .24, 1);
}

.notice-overlay__close {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid #3a574d;
  border-radius: 50%;
  color: var(--ink-text-soft);
  background: rgba(255, 255, 255, .04);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.notice-overlay__close:hover { border-color: #4d6f62; color: var(--ink-text); }
.notice-overlay__close:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }

@keyframes notice-veil-in { from { opacity: 0; } }
@keyframes notice-rise-in { from { opacity: 0; transform: translateY(10px) scale(.97); } }

@media (prefers-reduced-motion: reduce) {
  .notice-overlay, .notice-overlay__panel { animation: none; }
}

@media (max-width: 480px) {
  .notice-overlay__panel {
    width: min(var(--notice-max-width), var(--notice-mobile-max-width));
    max-height: var(--notice-mobile-max-height);
    padding: 22px 20px 18px;
  }
}
</style>
