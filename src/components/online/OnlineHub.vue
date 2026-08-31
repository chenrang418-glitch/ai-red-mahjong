<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import OnlineRoom from './OnlineRoom.vue'
import { useOnlineGame } from '@/composables/useOnlineGame'
import { DEFAULT_ONLINE_SETTINGS, DIFFICULTY_LABELS } from '@/online/types'
import type { OnlineRoomSettings } from '@/online/types'

const props = defineProps<{ joinCode?: string }>()
const emit = defineEmits<{ back: []; joinConsumed: [] }>()
const online = useOnlineGame()
const nickname = ref(online.lastNickname.value)
const manualCode = ref('')
const invitedCode = ref((props.joinCode ?? '').toUpperCase())
const settings = reactive<OnlineRoomSettings>({ ...DEFAULT_ONLINE_SETTINGS, claimWindowMs: 4000 })

watch(() => props.joinCode, (code) => { if (code) invitedCode.value = code.toUpperCase() })

onMounted(async () => {
  if (!online.apiConfigured) return
  const restored = await online.restoreSession()
  if (restored && invitedCode.value) enterInvitedRoom()
})

function consumeInvite() {
  const url = new URL(location.href)
  url.searchParams.delete('room')
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  emit('joinConsumed')
}

function enterInvitedRoom() {
  const code = invitedCode.value
  if (!code) return
  invitedCode.value = ''
  consumeInvite()
  online.joinRoom(code)
}

async function submitNickname() {
  await online.login(nickname.value)
  if (online.session.value && invitedCode.value) enterInvitedRoom()
}

function createRoom() { void online.createRoom({ ...settings, claimWindowMs: 4000 }) }
function leaveRoom() { online.leaveRoom(); void online.refreshRooms() }
function back() { if (online.room.value) leaveRoom(); else emit('back') }
</script>

<template>
  <OnlineRoom
    v-if="online.room.value"
    :room="online.room.value"
    :connected="online.connected.value"
    :pending-action="online.pendingAction.value"
    :chat-bubbles="online.chatBubbles.value"
    @command="online.send"
    @leave="leaveRoom"
  />

  <main v-else class="online-hub">
    <header class="hub-header">
      <button type="button" aria-label="返回首页" @click="back">‹</button>
      <h1>联机大厅</h1>
      <button v-if="online.session.value" type="button" @click="online.logout">退出</button>
      <span v-else></span>
    </header>

    <section v-if="!online.session.value" class="login-panel">
      <strong v-if="invitedCode">加入房间 {{ invitedCode }}</strong>
      <strong v-else>输入昵称</strong>
      <form @submit.prevent="submitNickname">
        <input v-model="nickname" maxlength="12" autocomplete="nickname" aria-label="昵称" placeholder="昵称">
        <button type="submit" :disabled="online.busy.value || !online.apiConfigured">{{ online.busy.value ? '连接中…' : invitedCode ? '加入房间' : '进入大厅' }}</button>
      </form>
    </section>

    <section v-else class="hub-content">
      <div class="actions">
        <article>
          <div class="identity"><span>当前昵称</span><strong>{{ online.session.value.nickname }}</strong></div>
          <h2>创建房间</h2>
          <div class="mode-switch">
            <button type="button" :class="{ active: settings.mode === 'finite' }" @click="settings.mode = 'finite'">有限积分</button>
            <button type="button" :class="{ active: settings.mode === 'unlimited' }" @click="settings.mode = 'unlimited'">无限模式</button>
          </div>
          <label v-if="settings.mode === 'finite'">初始积分<input v-model.number="settings.initialPoints" type="number" min="1" max="9999"></label>
          <label>AI 难度<select v-model="settings.aiDifficulty"><option v-for="(label, value) in DIFFICULTY_LABELS" :key="value" :value="value">{{ label }}</option></select></label>
          <button class="primary" type="button" :disabled="online.busy.value || online.connecting.value || online.maintenance.value.active" @click="createRoom">{{ online.maintenance.value.active ? '维护中' : '创建房间' }}</button>
        </article>

        <article>
          <h2>加入房间</h2>
          <form class="join-form" @submit.prevent="online.joinRoom(manualCode)">
            <input v-model="manualCode" maxlength="6" autocomplete="off" aria-label="房间号" placeholder="6 位房间号" @input="manualCode = manualCode.toUpperCase()">
            <button class="primary" type="submit" :disabled="online.connecting.value">加入</button>
          </form>
        </article>
      </div>

      <article class="directory">
        <header><h2>公开房间</h2><button type="button" @click="online.refreshRooms">刷新</button></header>
        <div class="room-list">
          <section v-for="entry in online.rooms.value" :key="entry.code" :class="['room-row', entry.phase]">
            <div><strong>{{ entry.code }}</strong><span>{{ entry.hostNickname }}</span></div>
            <div><b>{{ entry.occupiedSeats }}/4</b><span>{{ entry.phase === 'lobby' ? '等待中' : '游戏中' }}</span></div>
            <button type="button" :disabled="!entry.joinable || online.connecting.value" @click="online.joinRoom(entry.code)">{{ entry.rejoinable ? '重新进入' : entry.joinable ? '加入' : '不可加入' }}</button>
          </section>
          <p v-if="!online.rooms.value.length">暂无公开房间</p>
        </div>
      </article>
    </section>

  </main>

  <!-- 错误提示挂在房间视图和大厅视图之外：以前它写在大厅的 <main> 里，
       一旦进了房间整段就不渲染，服务端驳回（比如「还有玩家未准备」）在界面上毫无反应。 -->
  <div v-if="online.error.value" class="online-error" role="alert" @click="online.error.value = ''">{{ online.error.value }}</div>
</template>

<style scoped>
.online-hub { width: 100%; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; padding: max(16px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); color: #f5efdd; background: radial-gradient(circle at 10% 0, #21483b, transparent 38%), #081510; }
.hub-header { width: min(1160px, 100%); min-height: 48px; margin: 0 auto 14px; display: grid; grid-template-columns: 80px 1fr 80px; align-items: center; }
.hub-header h1 { margin: 0; color: #f1d078; font-size: 24px; text-align: center; }
button { min-height: 42px; border: 1px solid #345248; border-radius: 10px; background: #112b24; color: #e9dfc4; cursor: pointer; font-weight: 800; }
button:disabled { opacity: .45; cursor: default; }
.hub-header button { padding: 0 12px; }
.hub-header button:first-child { width: 42px; padding: 0; font-size: 27px; }
.login-panel { width: min(430px, 100%); margin: auto; padding: 28px; border: 1px solid rgba(220,187,96,.28); border-radius: 22px; background: #0e241e; }
.login-panel > strong { display: block; margin-bottom: 18px; color: #f1d078; font-size: 25px; }
.login-panel form { display: grid; gap: 12px; }
input, select { width: 100%; min-height: 48px; padding: 0 13px; border: 1px solid #345248; border-radius: 10px; outline: 0; background: #102a23; color: #f5efdd; font-size: 15px; }
.login-panel button, .primary { border: 0; background: linear-gradient(135deg, #efd17c, #c9a54d); color: #172019; }
.hub-content { width: min(1160px, 100%); min-height: 0; flex: 1; margin: 0 auto; display: grid; grid-template-columns: minmax(280px, 340px) 1fr; gap: 14px; }
.actions { min-height: 0; display: grid; gap: 12px; align-content: start; }
.actions article, .directory { padding: 18px; border: 1px solid #304b42; border-radius: 18px; background: rgba(14,35,29,.96); }
h2 { margin: 0 0 13px; font-size: 18px; }
.identity { display: flex; justify-content: space-between; margin-bottom: 16px; color: #8ea29b; font-size: 12px; }
.identity strong { color: #f1d078; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 11px; }
.mode-switch button.active { border-color: #d5b65b; color: #f1d078; background: #1a382f; }
label { display: grid; gap: 5px; margin-top: 10px; color: #8ea29b; font-size: 11px; }
.actions .primary { width: 100%; margin-top: 13px; }
.join-form { display: grid; grid-template-columns: 1fr 76px; gap: 8px; }
.join-form input { text-transform: uppercase; letter-spacing: .12em; }
.directory { min-height: 0; display: flex; flex-direction: column; }
.directory > header { display: flex; align-items: center; justify-content: space-between; }
.directory > header button { padding: 0 12px; }
.room-list { min-height: 0; flex: 1; display: grid; align-content: start; gap: 8px; overflow-y: auto; overscroll-behavior: contain; padding-right: 3px; }
.room-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 96px; align-items: center; gap: 12px; padding: 13px; border: 1px solid #2c483e; border-radius: 12px; background: #102821; }
.room-row.playing { opacity: .62; }
.room-row > div { display: grid; gap: 3px; }
.room-row > div:nth-child(2) { text-align: right; }
.room-row strong { color: #f1d078; font-size: 20px; letter-spacing: .1em; }
.room-row span { color: #8fa49c; font-size: 11px; }
.room-row b { color: #e7ddc2; }
.room-row > button { min-height: 40px; }
.room-list > p { margin: auto; color: #82978f; text-align: center; }
.online-error { position: fixed; z-index: 90; top: calc(12px + env(safe-area-inset-top)); left: 50%; width: min(520px, calc(100vw - 24px)); padding: 12px 16px; transform: translateX(-50%); border: 1px solid #b55249; border-radius: 12px; background: #672f2b; color: #ffe2dd; text-align: center; }
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  .online-hub { padding: max(10px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom)); }
  .hub-header { min-height: 42px; margin-bottom: 8px; }
  .hub-header h1 { font-size: 20px; }
  .login-panel { margin: auto; padding: 20px; }
  .hub-content { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); gap: 8px; }
  .actions { grid-template-columns: 1.2fr .8fr; gap: 8px; }
  .actions article, .directory { padding: 12px; border-radius: 14px; }
  h2 { margin-bottom: 8px; font-size: 16px; }
  .identity { display: none; }
  label { margin-top: 6px; }
  input, select { min-height: 42px; }
  .actions .primary { margin-top: 8px; }
  .actions article:nth-child(2) { display: flex; flex-direction: column; }
  .join-form { grid-template-columns: 1fr; }
  .join-form .primary { margin-top: 0; }
  .room-row { grid-template-columns: minmax(0, 1fr) auto 82px; padding: 10px; }
}
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .online-hub { padding: max(6px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
  .hub-header { min-height: 34px; margin-bottom: 5px; }
  .hub-header h1 { font-size: 18px; }
  .hub-header button { min-height: 32px; }
  .hub-content { grid-template-columns: minmax(330px, 42%) 1fr; gap: 8px; }
  .actions { grid-template-columns: 1.2fr .8fr; gap: 8px; }
  .actions article, .directory { padding: 10px; border-radius: 12px; }
  .identity { display: none; }
  h2 { margin-bottom: 6px; font-size: 15px; }
  .mode-switch { margin-bottom: 5px; }
  .mode-switch button, input, select, .actions .primary { min-height: 34px; }
  label { margin-top: 4px; }
  .join-form { grid-template-columns: 1fr; gap: 5px; }
  .actions .primary { margin-top: 5px; }
  .room-row { padding: 8px 10px; }
}
</style>
