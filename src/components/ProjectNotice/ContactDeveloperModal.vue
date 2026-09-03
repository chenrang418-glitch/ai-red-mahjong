<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import NoticeOverlay from './NoticeOverlay.vue'
import { copyText } from '@/notice/clipboard'
import { useServiceStatus } from '@/composables/useServiceStatus'
import { CONTACT_INTRO, CONTACT_TITLE, DEFAULT_CONTACT_METHOD, DEFAULT_CONTACT_VALUE } from '@/notice/noticeContent'

/**
 * 联系方式**不写死在前端**：方式（QQ/微信/邮箱……）和号码都是管理员在
 * 后台填的自由文本，这里只管显示 `/api/service` 下发的当前值。
 * `useServiceStatus` 是全站共用的同一份轮询，`RootApp` 早就在 `start()` 了，
 * 这里再 `start()` 只是增加一个订阅计数、复用同一个定时器，不会重复发请求。
 */
defineEmits<{ close: [] }>()

const service = useServiceStatus()
onMounted(() => service.start())
onBeforeUnmount(() => service.stop())

// 网络还没返回或者管理员从没改过时，用一份和服务端默认值一致的兜底文案，
// 不能让弹窗刚打开时是一片空白
const method = computed(() => service.status.value.contactMethod || DEFAULT_CONTACT_METHOD)
const value = computed(() => service.status.value.contactValue || DEFAULT_CONTACT_VALUE)

const closeButton = ref<HTMLButtonElement | null>(null)
onMounted(() => closeButton.value?.focus())

const copied = ref(false)
let revertTimer: number | null = null

async function handleCopy(): Promise<void> {
  // 只复制冒号后面那一串——号码可能是 QQ、微信号，也可能是邮箱地址，
  // 复制「方式」标签本身对粘贴目标没有意义
  const ok = await copyText(value.value)
  // 复制失败时页面上的号码本来就是可选中文本，用户仍然能手动复制，
  // 这里不需要额外弹错误——按钮保持原样就是最诚实的反馈。
  if (!ok) return
  copied.value = true
  if (revertTimer !== null) window.clearTimeout(revertTimer)
  revertTimer = window.setTimeout(() => { copied.value = false }, 1800)
}

onBeforeUnmount(() => {
  if (revertTimer !== null) window.clearTimeout(revertTimer)
})
</script>

<template>
  <NoticeOverlay
    labelled-by="contact-developer-title"
    max-width="380px"
    max-height="90vh"
    mobile-max-width="calc(100vw - 32px)"
    class="contact-developer"
    @close="$emit('close')"
  >
    <h2 id="contact-developer-title">{{ CONTACT_TITLE }}</h2>
    <p class="contact-developer__intro">{{ CONTACT_INTRO }}</p>
    <p class="contact-developer__value">{{ method }}：<span>{{ value }}</span></p>
    <div class="contact-developer__actions">
      <button type="button" class="contact-developer__copy" :class="{ 'contact-developer__copy--done': copied }" @click="handleCopy">
        {{ copied ? '已复制' : '复制号码' }}
      </button>
      <button ref="closeButton" type="button" class="contact-developer__close" @click="$emit('close')">关闭</button>
    </div>
  </NoticeOverlay>
</template>

<style scoped>
.contact-developer :deep(.notice-overlay__panel) { gap: 0; padding-right: 34px; }

.contact-developer h2 {
  margin: 0 0 10px;
  color: #f3d67c;
  font-size: 17px;
  font-weight: 800;
}
.contact-developer__intro {
  margin: 0 0 16px;
  color: var(--ink-text-soft);
  font-size: 13px;
  line-height: 1.7;
}
.contact-developer__value {
  margin: 0 0 20px;
  padding: 12px 14px;
  border: 1px solid var(--ink-line);
  border-radius: 10px;
  background: var(--ink-panel-deep);
  color: var(--ink-text-muted);
  font-size: 14px;
  word-break: break-all;
}
/* 号码本身要能被用户手选复制，作为 Clipboard API 失败时的兜底 */
.contact-developer__value span { color: var(--ink-text); font-weight: 700; user-select: all; }

.contact-developer__actions {
  display: flex;
  gap: 10px;
}
.contact-developer__actions button {
  flex: 1;
  min-height: 42px;
  border-radius: 11px;
  font-size: 13.5px;
  font-weight: 700;
  cursor: pointer;
}
.contact-developer__copy {
  border: 1px solid #9e7f3c;
  background: linear-gradient(180deg, #6d5527, #4c3b1a);
  color: #ffe6a8;
}
.contact-developer__copy:hover { filter: brightness(1.08); }
.contact-developer__copy--done { border-color: #4d8f63; background: linear-gradient(180deg, #2f6b46, #1f4a32); color: #d8f5e2; }
.contact-developer__close {
  border: 1px solid #3a574d;
  background: #142e26;
  color: #d5e0da;
}
.contact-developer__close:hover { border-color: #4d6f62; }
.contact-developer__actions button:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; }
</style>
