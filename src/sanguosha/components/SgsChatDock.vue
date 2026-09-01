<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { SGS_QUICK_CHAT_EMOJIS, SGS_QUICK_CHAT_MESSAGES, type SgsChatMessage } from '../online/protocol'

/**
 * 牌桌聊天。仿麻将的做法：右下角一个圆钮，点开从下方升起一张纸。
 *
 * 这里**只有聊天**，战报走顶栏那个入口——两样东西混在一起时，
 * 想找一句话要在一堆「谁摸了牌」里翻。
 */

const props = defineProps<{ messages: readonly SgsChatMessage[]; selfUserId: string }>()
const emit = defineEmits<{ send: [text: string] }>()

const open = ref(false)
const draft = ref('')
const list = ref<HTMLElement | null>(null)
/** 关着的时候来的消息要有提示，否则圆钮和没消息时长得一样。 */
const seenCount = ref(props.messages.length)
const unread = computed(() => Math.max(0, props.messages.length - seenCount.value))

async function scrollToLatest(): Promise<void> {
  await nextTick()
  if (list.value) list.value.scrollTop = list.value.scrollHeight
}

watch(() => props.messages.length, (count) => {
  if (open.value) { seenCount.value = count; void scrollToLatest() }
})

function toggle(): void {
  open.value = !open.value
  if (open.value) { seenCount.value = props.messages.length; void scrollToLatest() }
}

function send(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  emit('send', trimmed)
}

function submit(): void {
  send(draft.value)
  draft.value = ''
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <button class="sgs-chat__fab" type="button" :aria-label="unread ? `聊天，${unread} 条新消息` : '聊天'" @click="toggle">
    聊<i v-if="unread && !open" aria-hidden="true">{{ unread > 9 ? '9+' : unread }}</i>
  </button>

  <div v-if="open" class="sgs-chat__mask" @click="open = false"></div>

  <section v-if="open" class="sgs-chat__sheet" aria-label="牌桌聊天">
    <header>
      <strong>牌桌聊天</strong>
      <button type="button" aria-label="关闭聊天" @click="open = false">×</button>
    </header>

    <div ref="list" class="sgs-chat__list">
      <p v-if="!messages.length" class="sgs-chat__empty">还没有消息，先打个招呼吧。</p>
      <article v-for="message in messages" :key="message.id" :class="{ mine: message.userId === selfUserId }">
        <header><strong>{{ message.nickname }}</strong><time>{{ timeOf(message.at) }}</time></header>
        <p>{{ message.text }}</p>
      </article>
    </div>

    <div class="sgs-chat__quick">
      <button v-for="phrase in SGS_QUICK_CHAT_MESSAGES" :key="phrase" type="button" @click="send(phrase)">{{ phrase }}</button>
      <button v-for="emoji in SGS_QUICK_CHAT_EMOJIS" :key="emoji" type="button" class="emoji" @click="send(emoji)">{{ emoji }}</button>
    </div>

    <form class="sgs-chat__compose" @submit.prevent="submit">
      <input v-model="draft" maxlength="100" placeholder="说点什么…" aria-label="聊天内容">
      <button type="submit">发送</button>
    </form>
  </section>
</template>

<style scoped>
/* 圆钮固定在右下角，压在底部面板之上但让开安全区 */
.sgs-chat__fab {
  position: fixed; z-index: 40;
  right: max(12px, env(safe-area-inset-right));
  bottom: calc(max(12px, env(safe-area-inset-bottom)) + 52px);
  width: 46px; height: 46px; display: grid; place-items: center; padding: 0;
  border: 1px solid #d1af54; border-radius: 50%;
  background: linear-gradient(180deg, #6d5527, #45351a); color: #ffe6a8;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .45); cursor: pointer; font-size: 15px; font-weight: 800;
}
.sgs-chat__fab:active { transform: scale(.94); }
.sgs-chat__fab i {
  position: absolute; right: -2px; top: -2px; min-width: 17px; height: 17px;
  display: grid; place-items: center; padding: 0 4px; border-radius: 999px;
  background: #c8503f; color: #fff; font-size: 10px; font-style: normal; font-weight: 800;
}

.sgs-chat__mask { position: fixed; inset: 0; z-index: 41; background: rgba(0, 0, 0, .55); }

/* 弹窗从下方升起，最高只占一半屏，牌桌仍然看得见 */
.sgs-chat__sheet {
  position: fixed; z-index: 42; left: 50%; bottom: 0;
  transform: translateX(-50%);
  width: min(480px, 100%); max-height: 56dvh;
  display: grid; grid-template-rows: auto minmax(80px, 1fr) auto auto; gap: 9px;
  padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
  border: 1px solid #46402c; border-top-left-radius: 16px; border-top-right-radius: 16px;
  background: linear-gradient(180deg, rgba(26, 37, 30, .99), rgba(13, 22, 17, .99));
  box-shadow: 0 -12px 34px rgba(0, 0, 0, .5);
  animation: sgs-chat-rise .2s ease-out;
}
.sgs-chat__sheet > header { display: flex; justify-content: space-between; align-items: center; color: #efd58c; }
.sgs-chat__sheet > header strong { font-size: 14px; }
.sgs-chat__sheet > header button { min-width: 34px; min-height: 34px; border: 0; background: transparent; color: #aab7af; font-size: 22px; cursor: pointer; }

.sgs-chat__list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; padding-right: 3px; }
.sgs-chat__empty { margin: auto; color: #687e77; font-size: 11px; }
.sgs-chat__list article { max-width: 92%; align-self: flex-start; padding: 7px 9px; border-radius: 4px 10px 10px; background: #14261e; }
.sgs-chat__list article.mine { align-self: flex-end; border-radius: 10px 4px 10px 10px; background: #3a4a2f; }
.sgs-chat__list article header { display: flex; justify-content: space-between; gap: 10px; color: #d8bd6b; font-size: 9px; }
.sgs-chat__list time { color: #667b74; }
.sgs-chat__list article p { margin: 4px 0 0; overflow-wrap: anywhere; color: #cad4cf; font-size: 12px; line-height: 1.45; }

.sgs-chat__quick { display: flex; flex-wrap: wrap; gap: 5px; padding-top: 8px; border-top: 1px solid #29433a; }
.sgs-chat__quick button { min-height: 30px; padding: 5px 8px; border: 1px solid #355248; border-radius: 7px; background: #142f27; color: #c9d1cd; cursor: pointer; font-size: 11px; }
.sgs-chat__quick button.emoji { min-width: 34px; font-size: 15px; }
.sgs-chat__quick button:active { background: #1d3f34; }

.sgs-chat__compose { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.sgs-chat__compose input { min-width: 0; min-height: 40px; padding: 0 10px; border: 1px solid #355248; border-radius: 8px; background: #10261f; color: #f2ebd7; font: inherit; outline: 0; }
.sgs-chat__compose button { min-height: 40px; padding: 0 14px; border: 0; border-radius: 8px; background: #dfbf64; color: #20261e; font-weight: 800; cursor: pointer; }

@keyframes sgs-chat-rise { from { transform: translate(-50%, 14px); opacity: 0; } }

@media (orientation: landscape) and (max-height: 500px) {
  /* 横屏矮屏时纸再高就把牌桌全挡了 */
  .sgs-chat__sheet { max-height: 82dvh; gap: 6px; padding-top: 8px; }
  .sgs-chat__quick { padding-top: 5px; }
  .sgs-chat__fab { width: 40px; height: 40px; bottom: calc(max(8px, env(safe-area-inset-bottom)) + 44px); }
}
@media (prefers-reduced-motion: reduce) { .sgs-chat__sheet { animation: none; } }
</style>
