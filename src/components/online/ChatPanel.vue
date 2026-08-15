<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ChatMessage } from '@/online/types'
import { QUICK_CHAT_EMOJIS, QUICK_CHAT_MESSAGES } from '@/online/types'

const props = defineProps<{ messages: ChatMessage[]; selfUserId: string }>()
const emit = defineEmits<{ send: [text: string, quick: boolean] }>()
const text = ref('')
const list = ref<HTMLElement | null>(null)

watch(() => props.messages.length, async () => {
  await nextTick()
  if (list.value) list.value.scrollTop = list.value.scrollHeight
}, { immediate: true })

function submit() {
  const message = text.value.trim()
  if (!message) return
  emit('send', message, false)
  text.value = ''
}
</script>

<template>
  <section class="chat-panel">
    <div ref="list" class="chat-list">
      <p v-if="!messages.length" class="chat-empty">还没有消息，先打个招呼吧。</p>
      <article v-for="message in messages" :key="message.id" :class="{ mine: message.userId === selfUserId }">
        <header><strong>{{ message.nickname }}</strong><time>{{ new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</time></header>
        <p>{{ message.text }}</p>
      </article>
    </div>

    <div class="quick-chat">
      <button v-for="message in QUICK_CHAT_MESSAGES" :key="message" type="button" @click="emit('send', message, true)">{{ message }}</button>
      <button v-for="emoji in QUICK_CHAT_EMOJIS" :key="emoji" class="emoji" type="button" @click="emit('send', emoji, true)">{{ emoji }}</button>
    </div>

    <form class="chat-compose" @submit.prevent="submit">
      <input v-model="text" maxlength="100" placeholder="说点什么…">
      <button type="submit">发送</button>
    </form>
  </section>
</template>

<style scoped>
.chat-panel { min-height: 0; height: 100%; display: grid; grid-template-rows: minmax(150px, 1fr) auto auto; gap: 9px; }
.chat-list { min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; padding-right: 3px; }
.chat-empty { color: #687e77; font-size: 10px; text-align: center; }
article { max-width: 92%; align-self: flex-start; padding: 8px; border-radius: 4px 10px 10px; background: #102820; }
article.mine { align-self: flex-end; border-radius: 10px 4px 10px 10px; background: #33442d; }
article header { display: flex; justify-content: space-between; gap: 10px; color: #d8bd6b; font-size: 8px; }
article time { color: #667b74; font-weight: 400; }
article p { margin: 4px 0 0; overflow-wrap: anywhere; color: #c5d0cb; font-size: 11px; line-height: 1.45; }
.quick-chat { max-height: 112px; display: flex; flex-wrap: wrap; gap: 5px; overflow-y: auto; padding-top: 8px; border-top: 1px solid #29433a; }
.quick-chat button { padding: 6px 7px; border: 1px solid #355248; border-radius: 7px; background: #142f27; color: #c9d1cd; cursor: pointer; font-size: 9px; }
.quick-chat button.emoji { min-width: 31px; font-size: 14px; }
.chat-compose { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.chat-compose input { min-width: 0; padding: 9px; border: 1px solid #355248; border-radius: 8px; background: #10261f; color: #f2ebd7; outline: 0; }
.chat-compose button { padding: 9px 11px; border: 0; border-radius: 8px; background: #dfbf64; color: #20261e; font-weight: 800; cursor: pointer; }
</style>
