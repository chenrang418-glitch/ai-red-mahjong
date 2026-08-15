<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import OnlineRoom from './OnlineRoom.vue'
import { useOnlineGame } from '@/composables/useOnlineGame'
import { DEFAULT_ONLINE_SETTINGS } from '@/online/types'
import type { OnlineRoomSettings } from '@/online/types'

const emit = defineEmits<{ back: [] }>()
const online = useOnlineGame()
const nickname = ref('')
const joinCode = ref('')
const settings = reactive<OnlineRoomSettings>({ ...DEFAULT_ONLINE_SETTINGS })

onMounted(() => {
  if (online.apiConfigured) void online.refreshLeaderboard()
})

function submitNickname() {
  void online.login(nickname.value)
}

function createRoom() {
  void online.createRoom({ ...settings })
}

function leaveRoom() {
  online.leaveRoom()
  void online.refreshRooms()
}

function back() {
  if (online.room.value) leaveRoom()
  else emit('back')
}
</script>

<template>
  <OnlineRoom
    v-if="online.room.value"
    :room="online.room.value"
    :connected="online.connected.value"
    @command="online.send"
    @leave="leaveRoom"
  />

  <main v-else class="online-hub">
    <header class="hub-header">
      <button type="button" @click="back">← 返回模式选择</button>
      <div><span>中</span><div><strong>联机模式</strong><small>AI 红中麻将</small></div></div>
      <button v-if="online.session.value" type="button" @click="online.logout">退出昵称</button>
    </header>

    <section v-if="!online.apiConfigured" class="server-notice">
      <strong>联机服务器尚未配置</strong>
      <p>本地开发请同时运行联机服务器；生产环境需要设置 <code>VITE_ONLINE_API_BASE</code>。</p>
    </section>

    <section class="hub-grid" :class="{ logged: online.session.value }">
      <article v-if="!online.session.value" class="login-card hub-card">
        <small>NICKNAME LOGIN</small>
        <h1>输入昵称</h1>
        <p>第一次使用会自动注册；之后输入相同昵称即可继续累计排行榜数据。页面刷新后需要重新输入。</p>
        <form @submit.prevent="submitNickname">
          <label>昵称<input v-model="nickname" maxlength="12" autocomplete="off" placeholder="例如：齐天大圣A123"></label>
          <button type="submit" :disabled="online.busy.value || !online.apiConfigured">{{ online.busy.value ? '连接中…' : '进入联机大厅' }}</button>
        </form>
        <div class="privacy-note">不使用密码、手机号或验证码；浏览器不会保存登录密钥。</div>
      </article>

      <template v-else>
        <article class="hub-card room-action-card">
          <small>CREATE ROOM</small>
          <h2>创建房间</h2>
          <div class="online-mode-switch">
            <label :class="{ selected: settings.mode === 'finite' }"><input v-model="settings.mode" type="radio" value="finite"><strong>有限积分</strong><span>有人归零整场结束</span></label>
            <label :class="{ selected: settings.mode === 'unlimited' }"><input v-model="settings.mode" type="radio" value="unlimited"><strong>无限模式</strong><span>只记录本场净分</span></label>
          </div>
          <div class="create-fields">
            <label v-if="settings.mode === 'finite'">统一初始积分<input v-model.number="settings.initialPoints" type="number" min="1" max="9999"></label>
            <label>抢牌窗口<select v-model.number="settings.claimWindowMs"><option :value="2000">2秒</option><option :value="3000">3秒</option><option :value="4000">4秒（推荐）</option><option :value="5000">5秒</option><option :value="6000">6秒</option><option :value="7000">7秒</option></select></label>
          </div>
          <p>普通操作限时固定30秒；空位开局时自动补充凡人AI。</p>
          <button class="primary" type="button" :disabled="online.busy.value" @click="createRoom">{{ online.busy.value ? '创建中…' : '创建新房间' }}</button>
        </article>

        <article class="hub-card room-action-card join-card">
          <small>JOIN ROOM</small>
          <h2>加入房间</h2>
          <p>可以从下方房间列表直接加入，也可以输入6位房间号。</p>
          <form @submit.prevent="online.joinRoom(joinCode)">
            <label>房间号<input v-model="joinCode" maxlength="6" autocomplete="off" placeholder="例如：7K9M2Q" @input="joinCode = joinCode.toUpperCase()"></label>
            <button class="primary" type="submit">加入房间</button>
          </form>
          <div class="login-user"><span>当前昵称</span><strong>{{ online.session.value.nickname }}</strong></div>
        </article>
      </template>

      <article v-if="online.session.value" class="hub-card room-directory-card">
        <header>
          <div><small>OPEN ROOMS</small><h2>可加入的房间</h2></div>
          <button type="button" @click="online.refreshRooms">刷新房间</button>
        </header>
        <div v-if="online.rooms.value.length" class="room-directory-list">
          <section v-for="entry in online.rooms.value" :key="entry.code" class="room-directory-row">
            <div class="room-directory-main">
              <div><strong>房间 {{ entry.code }}</strong><span>房主：{{ entry.hostNickname }}</span></div>
              <div class="room-directory-players">
                <span v-for="player in entry.players" :key="`${entry.code}-${player.nickname}`" :class="{ offline: !player.connected }">
                  {{ player.nickname }}<i v-if="player.isHost">房主</i><i v-else-if="!player.connected">离线</i>
                </span>
                <span v-for="seat in entry.availableSeats" :key="`${entry.code}-empty-${seat}`" class="empty-seat">空位</span>
              </div>
            </div>
            <div class="room-directory-rules">
              <span>{{ entry.settings.mode === 'finite' ? `有限积分 ${entry.settings.initialPoints}分` : '无限模式' }}</span>
              <span>抢牌 {{ entry.settings.claimWindowMs / 1000 }}秒</span>
              <b>{{ entry.occupiedSeats }}/4 人</b>
            </div>
            <button class="primary" type="button" :disabled="entry.availableSeats === 0" @click="online.joinRoom(entry.code)">
              {{ entry.availableSeats === 0 ? '房间已满' : '加入房间' }}
            </button>
          </section>
        </div>
        <p v-else class="empty-ranking">暂时没有可加入的房间，可以创建新房间或输入房间号。</p>
      </article>

      <article class="hub-card leaderboard-card">
        <header><div><small>LEADERBOARD</small><h2>胜局排行榜</h2></div><button type="button" @click="online.refreshLeaderboard">刷新</button></header>
        <div class="leaderboard-head"><span>名次 / 昵称</span><span>胜局</span><span>总局</span><span>胜率</span><span>七对</span><span>杠</span><span>码</span></div>
        <ol v-if="online.leaderboard.value.length">
          <li v-for="(entry, index) in online.leaderboard.value" :key="entry.userId">
            <span><i>{{ index + 1 }}</i><strong>{{ entry.nickname }}</strong></span>
            <b>{{ entry.wins }}</b><em>{{ entry.totalGames }}</em><em>{{ (entry.winRate * 100).toFixed(1) }}%</em><em>{{ entry.sevenPairs }}</em><em>{{ entry.gangCount }}</em><em>{{ entry.maCount }}</em>
          </li>
        </ol>
        <p v-else class="empty-ranking">还没有已结算的联机牌局。</p>
      </article>
    </section>

    <div v-if="online.error.value" class="online-error" @click="online.error.value = ''">{{ online.error.value }} ×</div>
  </main>
</template>

<style scoped>
.online-hub { min-height: 100vh; min-height: 100dvh; padding: 24px clamp(16px, 5vw, 64px) 50px; color: #f5efdd; background: radial-gradient(circle at 10% 0, #24483d 0, transparent 35%), #091410; }
.hub-header { width: min(1180px, 100%); margin: auto; display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.hub-header > button { padding: 9px 12px; border: 1px solid #345047; border-radius: 9px; background: #10251f; color: #d8dfda; cursor: pointer; }
.hub-header > div { display: flex; align-items: center; gap: 10px; }
.hub-header > div > span { width: 40px; height: 40px; display: grid; place-items: center; border: 2px solid #b94a42; border-radius: 11px; color: #d45a51; font: 800 23px/1 serif; transform: rotate(-4deg); }
.hub-header > div > div { display: grid; }
.hub-header strong { font-size: 15px; }
.hub-header small { color: #748981; font-size: 9px; letter-spacing: .14em; }
.server-notice { width: min(1180px, 100%); margin: 22px auto 0; padding: 13px 16px; border: 1px solid #8d5e34; border-radius: 11px; background: #38291c; }
.server-notice p { margin: 4px 0 0; color: #c6a981; font-size: 11px; }
.hub-grid { width: min(1180px, 100%); margin: 25px auto 0; display: grid; grid-template-columns: minmax(300px, 410px) minmax(0, 1fr); gap: 16px; align-items: start; }
.hub-grid.logged { grid-template-columns: 1fr 1fr; }
.hub-card { padding: 24px; border: 1px solid #345047; border-radius: 20px; background: rgba(14,34,29,.94); box-shadow: 0 20px 60px rgba(0,0,0,.25); }
.hub-card > small, .hub-card header small { color: #748981; font-size: 9px; font-weight: 800; letter-spacing: .2em; }
.hub-card h1, .hub-card h2 { margin: 4px 0 8px; }
.hub-card p { color: #849991; font-size: 11px; line-height: 1.7; }
.hub-card label { display: grid; gap: 5px; color: #80958e; font-size: 10px; }
.hub-card input, .hub-card select { width: 100%; min-width: 0; padding: 11px; border: 1px solid #355148; border-radius: 9px; background: #112a22; color: #f4eedc; outline: 0; }
.hub-card button.primary, .login-card form button { padding: 12px 15px; border: 0; border-radius: 9px; background: #e2c168; color: #20261e; font-weight: 900; cursor: pointer; }
.hub-card button:disabled { opacity: .48; cursor: default; }
.login-card form { display: grid; gap: 12px; margin-top: 22px; }
.privacy-note, .login-user { margin-top: 17px; padding: 11px; border-radius: 9px; background: #10261f; color: #71867f; font-size: 9px; }
.online-mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 17px 0; }
.online-mode-switch label { grid-template-columns: auto 1fr; padding: 11px; border: 1px solid #304b42; border-radius: 10px; cursor: pointer; }
.online-mode-switch label.selected { border-color: #bfa451; background: rgba(191,164,81,.06); }
.online-mode-switch input { grid-row: 1 / 3; width: auto; padding: 0; accent-color: #d8b95f; }
.online-mode-switch strong, .online-mode-switch span { grid-column: 2; }
.online-mode-switch span { color: #738780; font-size: 8px; }
.create-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.room-action-card > button.primary { width: 100%; margin-top: 10px; }
.join-card form { display: grid; gap: 10px; margin-top: 25px; }
.join-card input { text-transform: uppercase; letter-spacing: .22em; font-size: 18px; font-weight: 900; }
.login-user { display: flex; justify-content: space-between; }
.login-user strong { color: #ebcb72; }
.room-directory-card { grid-column: 1 / 3; min-width: 0; }
.room-directory-card header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.room-directory-card header button { padding: 7px 10px; border: 1px solid #355148; border-radius: 8px; background: #10261f; color: #b9c4bf; cursor: pointer; }
.room-directory-list { display: grid; gap: 9px; margin-top: 16px; }
.room-directory-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 112px; gap: 14px; align-items: center; padding: 14px; border: 1px solid #29443b; border-radius: 12px; background: #10261f; }
.room-directory-main > div:first-child { display: flex; align-items: baseline; gap: 10px; }
.room-directory-main > div:first-child span { color: #80958e; font-size: 9px; }
.room-directory-players { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.room-directory-players > span { padding: 5px 7px; border-radius: 7px; background: #1a392f; color: #dfe7e2; font-size: 9px; }
.room-directory-players > span.offline { opacity: .58; }
.room-directory-players > span.empty-seat { border: 1px dashed #3a574e; background: transparent; color: #71867f; }
.room-directory-players i { margin-left: 5px; color: #d9bc67; font-style: normal; font-size: 7px; }
.room-directory-rules { display: grid; gap: 4px; color: #81968f; font-size: 9px; text-align: right; }
.room-directory-rules b { color: #e4c66f; font-size: 11px; }
.room-directory-row > button.primary { width: 100%; }
.leaderboard-card { grid-column: 2; grid-row: 1 / span 2; min-width: 0; }
.hub-grid.logged .leaderboard-card { grid-column: 1 / 3; grid-row: auto; }
.leaderboard-card header { display: flex; justify-content: space-between; align-items: center; }
.leaderboard-card header button { padding: 7px 10px; border: 1px solid #355148; border-radius: 8px; background: #10261f; color: #b9c4bf; cursor: pointer; }
.leaderboard-head, .leaderboard-card li { display: grid; grid-template-columns: minmax(120px, 1.6fr) repeat(6, minmax(42px, .55fr)); gap: 5px; align-items: center; }
.leaderboard-head { padding: 10px 8px 7px; color: #667b74; font-size: 8px; text-align: center; }
.leaderboard-head span:first-child { text-align: left; }
.leaderboard-card ol { max-height: 440px; margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.leaderboard-card li { padding: 9px 8px; border-top: 1px solid #263f37; font-size: 11px; text-align: center; }
.leaderboard-card li > span { display: flex; align-items: center; gap: 8px; text-align: left; }
.leaderboard-card li i { width: 23px; height: 23px; display: grid; place-items: center; border-radius: 50%; background: #1b3930; color: #d6bb69; font-style: normal; font-size: 9px; }
.leaderboard-card li b { color: #efcf72; }
.leaderboard-card li em { color: #8fa29b; font-style: normal; }
.empty-ranking { padding: 35px 0; text-align: center; }
.online-error { position: fixed; z-index: 90; left: 50%; bottom: 20px; transform: translateX(-50%); padding: 11px 15px; border: 1px solid #ad5148; border-radius: 10px; background: #542925; color: #ffd8d3; cursor: pointer; font-size: 12px; }
@media (max-width: 800px) {
  .hub-grid, .hub-grid.logged { grid-template-columns: 1fr; }
  .room-directory-card, .leaderboard-card, .hub-grid.logged .leaderboard-card { grid-column: 1; grid-row: auto; }
  .room-directory-row { grid-template-columns: 1fr auto; }
  .room-directory-main { grid-column: 1 / 3; }
}
@media (max-width: 560px) {
  .online-hub { padding: max(16px, env(safe-area-inset-top)) 11px max(35px, env(safe-area-inset-bottom)); }
  .hub-header { flex-wrap: wrap; }
  .hub-header > div { order: -1; flex-basis: 100%; justify-content: center; }
  .hub-card { padding: 17px; }
  .online-mode-switch, .create-fields { grid-template-columns: 1fr; }
  .room-directory-row { grid-template-columns: 1fr; }
  .room-directory-main { grid-column: 1; }
  .room-directory-rules { grid-template-columns: repeat(3, auto); text-align: left; }
  .room-directory-row > button.primary { width: 100%; }
  .leaderboard-card { overflow-x: auto; }
  .leaderboard-head, .leaderboard-card ol { min-width: 570px; }
}
</style>
