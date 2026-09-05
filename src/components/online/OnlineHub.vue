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
      <!-- 昵称从「创建房间」卡片里挪出来单独成一条：原来它写在卡片内部，
           而手机端那两条媒体查询都把它 display:none 了，等于手机上根本看不到自己是谁。 -->
      <div class="identity-bar">
        <span>当前昵称</span>
        <strong>{{ online.session.value.nickname }}</strong>
      </div>

      <article class="create-card">
        <h2>创建房间</h2>
        <div class="mode-switch">
          <button type="button" :class="{ active: settings.mode === 'finite' }" @click="settings.mode = 'finite'">有限积分</button>
          <button type="button" :class="{ active: settings.mode === 'unlimited' }" @click="settings.mode = 'unlimited'">无限模式</button>
        </div>
        <div class="create-fields">
          <label v-if="settings.mode === 'finite'">初始积分<input v-model.number="settings.initialPoints" type="number" min="1" max="9999"></label>
          <label>AI 难度<select v-model="settings.aiDifficulty"><option v-for="(label, value) in DIFFICULTY_LABELS" :key="value" :value="value">{{ label }}</option></select></label>
        </div>
        <button
          class="primary"
          type="button"
          :class="{ 'is-maintenance': online.maintenance.value.active }"
          :disabled="online.busy.value || online.connecting.value || online.maintenance.value.active"
          @click="createRoom"
        >{{ online.maintenance.value.active ? '维护中' : '创建房间' }}</button>
        <p v-if="online.maintenance.value.active" class="hub-maintenance">{{ online.maintenance.value.message }}</p>
      </article>

      <article class="join-card">
        <h2>加入房间</h2>
        <form class="join-form" @submit.prevent="online.joinRoom(manualCode)">
          <input v-model="manualCode" maxlength="6" autocomplete="off" aria-label="房间号" placeholder="6 位房间号" @input="manualCode = manualCode.toUpperCase()">
          <button class="ghost" type="submit" :disabled="online.connecting.value">加入</button>
        </form>
      </article>

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
.hub-maintenance { margin: 6px 0 0; color: #ff9d94; font-size: 12px; line-height: 1.6; }
/* 和纸上三国大厅同一套：维护中的按钮压暗，一眼看出是「不能点」 */
.primary.is-maintenance { border-color: #4a3f3d; background: linear-gradient(180deg, #2a201f, #1b1413); color: #b58e8a; }
.online-hub { width: 100%; height: calc(100dvh - var(--app-viewport-offset, 0px)); display: flex; flex-direction: column; overflow: hidden; padding: max(16px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); color: var(--ink-text); background: radial-gradient(circle at 10% 0, #2f5741, transparent 42%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom)); }
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
/* 大厅按区域排：昵称条横跨顶部，左列创建+加入，右列公开房间占满高度。
   三个断点只换 grid-template-areas 和列宽，卡片本身的样式共用一套。 */
.hub-content {
  width: min(1160px, 100%);
  min-height: 0;
  flex: 1;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  grid-template-rows: auto auto auto minmax(0, 1fr);
  grid-template-areas:
    "identity  directory"
    "create    directory"
    "join      directory"
    ".         directory";
  gap: 12px 14px;
}
.identity-bar { grid-area: identity; }
.create-card { grid-area: create; }
.join-card { grid-area: join; }
.directory { grid-area: directory; }

/* 身份条：存在感低于卡片标题，但横竖屏都在 */
.identity-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border: 1px solid rgba(226, 191, 98, .22);
  border-radius: 99px;
  background: rgba(20, 45, 37, .72);
}
.identity-bar span { color: #8ea29b; font-size: 12px; }
.identity-bar strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f1d078; font-size: 15px; }

.create-card, .join-card, .directory {
  min-width: 0;
  padding: 18px;
  border: 1px solid #304b42;
  border-radius: 18px;
  background: rgba(14, 35, 29, .96);
}
h2 { margin: 0 0 13px; font-size: 18px; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.mode-switch button.active { border-color: #d5b65b; color: #f1d078; background: #1a382f; }
.create-fields { display: grid; gap: 10px; margin-top: 11px; }
label { display: grid; gap: 5px; color: #8ea29b; font-size: 11px; }
.create-card .primary { width: 100%; margin-top: 14px; }
/* 加入房间内容少，顶对齐即可，不要被拉高留一大片空白 */
.join-card { align-self: start; }
.join-form { display: grid; grid-template-columns: minmax(0, 1fr) 88px; gap: 8px; }
.join-form input { text-transform: uppercase; letter-spacing: .12em; }
/* 「加入」是次操作：保留描边不抢「创建房间」的金色主按钮 */
.ghost { border: 1px solid #46685b; background: #16342b; color: #ecd9a2; }
.ghost:hover:not(:disabled) { border-color: #d5b65b; color: #f1d078; }
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
.room-list > p { margin: auto; padding: 24px 0; color: #6d827a; font-size: 13px; text-align: center; }
.online-error { position: fixed; z-index: 90; top: calc(12px + env(safe-area-inset-top)); left: 50%; width: min(520px, calc(100vw - 24px)); padding: 12px 16px; transform: translateX(-50%); border: 1px solid #b55249; border-radius: 12px; background: #672f2b; color: #ffe2dd; text-align: center; }
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  .online-hub { padding: max(10px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom)); }
  .hub-header { min-height: 42px; margin-bottom: 8px; }
  .hub-header h1 { font-size: 20px; }
  .login-panel { margin: auto; padding: 20px; }
  /* 竖屏改成上下堆叠：创建房间是主操作放最上，加入房间只占内容需要的高度，
     剩下的全给公开房间。原来把创建和加入并成一行，加入那格被拉得又窄又高。 */
  .hub-content {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr);
    grid-template-areas: "identity" "create" "join" "directory";
    gap: 8px;
  }
  .identity-bar { padding: 8px 14px; }
  .identity-bar span { font-size: 11px; }
  .identity-bar strong { font-size: 14px; }
  .create-card, .join-card, .directory { padding: 13px; border-radius: 14px; }
  h2 { margin-bottom: 9px; font-size: 16px; }
  input, select { min-height: 44px; }
  .create-fields { grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 9px; }
  .create-card .primary { margin-top: 11px; }
  .room-row { grid-template-columns: minmax(0, 1fr) auto 82px; padding: 10px; }
}
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .online-hub { padding: max(6px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(6px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
  .hub-header { min-height: 34px; margin-bottom: 5px; }
  .hub-header h1 { font-size: 18px; }
  .hub-header button { min-height: 32px; }
  /* 横屏三列并排，公开房间拿最大的一份 */
  .hub-content {
    grid-template-columns: 1.15fr .9fr 2fr;
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      "identity identity identity"
      "create   join     directory";
    gap: 6px 8px;
  }
  .identity-bar { padding: 5px 12px; }
  .identity-bar span { font-size: 10px; }
  .identity-bar strong { font-size: 13px; }
  .create-card, .join-card, .directory { padding: 10px; border-radius: 12px; }
  h2 { margin-bottom: 7px; font-size: 15px; }
  .mode-switch button, input, select, .create-card .primary, .join-form .ghost { min-height: 34px; }
  .create-fields { gap: 6px; margin-top: 6px; }
  .create-card .primary { margin-top: 8px; }
  .join-form { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .room-row { padding: 8px 10px; }
}
</style>
