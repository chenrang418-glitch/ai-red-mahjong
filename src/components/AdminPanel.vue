<script setup lang="ts">
import { computed, ref } from 'vue'
import { resolveApiBase } from '@/composables/useOnlineGame'

// 管理面板没有任何入口链接，只能靠地址栏里的 #admin 打开。
// 真正的门槛是密钥本身：密钥只存在于服务器的 secret 和你输入的这一次会话里，
// 不写进代码、不进 URL、不写 localStorage，关掉标签页就没了。
interface AdminUser {
  userId: string
  nickname: string
  createdAt: number
  lastSeenAt: number
}

interface AdminRoom {
  game: 'mahjong' | 'sanguosha'
  code: string
  phase: 'lobby' | 'playing' | 'finished'
  hostNickname: string
  players: Array<{ nickname: string; kind: string; connected: boolean; trustee: boolean }>
  occupiedSeats: number
  capacity: number
  updatedAt: number
}

interface ServerSettings {
  trusteeDifficulty: 'beginner' | 'standard' | 'expert'
  maintenance: boolean
  maintenanceMessage: string
}

interface AuditEntry {
  action: string
  target: string | null
  detail: string
  createdAt: number
}

const DIFFICULTY_TEXT: Record<ServerSettings['trusteeDifficulty'], string> = {
  beginner: '菜鸡', standard: '凡人', expert: '猿神',
}
const ACTION_TEXT: Record<string, string> = {
  'delete-user': '删除用户',
  'destroy-room': '解散房间',
  'destroy-sanguosha-room': '解散三国杀房间',
  'update-settings': '修改设置',
}

const SESSION_KEY = 'red-mahjong-admin-token'

const token = ref(sessionStorage.getItem(SESSION_KEY) ?? '')
const input = ref('')
const authorized = ref(false)
const users = ref<AdminUser[]>([])
const rooms = ref<AdminRoom[]>([])
const audit = ref<AuditEntry[]>([])
const settings = ref<ServerSettings | null>(null)
const tab = ref<'users' | 'rooms' | 'settings'>('users')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const apiBase = resolveApiBase()

const sortedUsers = computed(() => [...users.value].sort((left, right) => right.lastSeenAt - left.lastSeenAt))

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('authorization', `Bearer ${token.value}`)
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  const payload = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    // 服务器对「密钥不对」和「接口不存在」返回同一个 404，这里也不做区分。
    throw new Error(payload.error || (response.status === 404 ? '密钥不正确，或管理接口未启用' : `服务器返回 ${response.status}`))
  }
  return payload
}

async function unlock() {
  const candidate = input.value.trim()
  if (!candidate) return
  busy.value = true
  error.value = ''
  token.value = candidate
  try {
    await call('/api/admin/session', { method: 'POST' })
    authorized.value = true
    sessionStorage.setItem(SESSION_KEY, candidate)
    input.value = ''
    await loadUsers()
    await loadSettings()
  } catch (cause) {
    token.value = ''
    sessionStorage.removeItem(SESSION_KEY)
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function loadUsers() {
  busy.value = true
  error.value = ''
  try {
    const result = await call<{ users: AdminUser[] }>('/api/admin/users')
    users.value = result.users
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function loadRooms() {
  busy.value = true
  error.value = ''
  try {
    rooms.value = (await call<{ rooms: AdminRoom[] }>('/api/admin/rooms')).rooms
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function loadSettings() {
  try {
    settings.value = await call<ServerSettings>('/api/admin/settings')
    audit.value = (await call<{ entries: AuditEntry[] }>('/api/admin/audit')).entries
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

async function saveSettings() {
  if (!settings.value) return
  await run('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settings.value) }, '设置已保存')
  await loadSettings()
}

async function destroyRoom(room: AdminRoom) {
  const gameName = room.game === 'sanguosha' ? '三国杀' : '红中麻将'
  const warning = room.phase === 'playing'
    ? `${gameName}房间 ${room.code} 正在进行牌局，解散会把里面的人直接踢出去。`
    : `解散${gameName}房间 ${room.code}？`
  if (!window.confirm(`${warning}

此操作不可撤销。`)) return
  const path = room.game === 'sanguosha' ? `/api/admin/sanguosha/rooms/${room.code}` : `/api/admin/rooms/${room.code}`
  await run(path, { method: 'DELETE' }, `已解散${gameName}房间 ${room.code}`)
  await loadRooms()
}

function switchTab(next: 'users' | 'rooms' | 'settings') {
  tab.value = next
  if (next === 'rooms') void loadRooms()
  if (next === 'settings') void loadSettings()
}

async function removeUser(user: AdminUser) {
  if (!window.confirm(`删除「${user.nickname}」？此操作不可撤销。`)) return
  await run(`/api/admin/users/${user.userId}`, { method: 'DELETE' }, `已删除 ${user.nickname}`)
}

async function run(path: string, init: RequestInit, successMessage: string) {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await call(path, init)
    notice.value = successMessage
    await loadUsers()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function lock() {
  authorized.value = false
  token.value = ''
  users.value = []
  sessionStorage.removeItem(SESSION_KEY)
}

function backToGame() {
  const url = new URL(window.location.href)
  url.hash = ''
  url.searchParams.set('game', 'mahjong')
  url.searchParams.delete('room')
  window.location.assign(`${url.pathname}${url.search}`)
}

function formatTime(value: number) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}

// 同一标签页内刷新后免于重新输入；密钥失效就悄悄退回输入框。
async function restoreSession() {
  if (!token.value) return
  busy.value = true
  try {
    await call('/api/admin/session', { method: 'POST' })
    authorized.value = true
    await loadUsers()
  } catch {
    token.value = ''
    sessionStorage.removeItem(SESSION_KEY)
  } finally {
    busy.value = false
  }
}

void restoreSession()
</script>

<template>
  <main class="admin-page">
    <section v-if="!authorized" class="admin-gate">
      <small>RESTRICTED</small>
      <h1>管理入口</h1>
      <p>输入管理密钥。密钥只保存在本标签页，关闭后失效。</p>
      <form @submit.prevent="unlock">
        <input v-model="input" type="password" autocomplete="off" placeholder="管理密钥">
        <button type="submit" :disabled="busy || !input.trim()">{{ busy ? '校验中…' : '进入' }}</button>
      </form>
      <p v-if="error" class="admin-error">{{ error }}</p>
      <a href="#" @click.prevent="backToGame">返回游戏</a>
    </section>

    <template v-else>
      <header class="admin-header">
        <div><small>ADMIN</small><h1>服务器管理</h1></div>
        <div class="admin-actions">
          <button type="button" @click="lock">退出管理</button>
        </div>
      </header>

      <nav class="admin-tabs">
        <button type="button" :class="{ active: tab === 'users' }" @click="switchTab('users')">用户</button>
        <button type="button" :class="{ active: tab === 'rooms' }" @click="switchTab('rooms')">房间</button>
        <button type="button" :class="{ active: tab === 'settings' }" @click="switchTab('settings')">联机设置</button>
      </nav>

      <p v-if="error" class="admin-error">{{ error }}</p>
      <p v-if="notice" class="admin-notice">{{ notice }}</p>

      <div v-if="tab === 'users'" class="admin-table-wrap">
        <div class="table-actions">
          <button type="button" :disabled="busy" @click="loadUsers">刷新</button>
        </div>
        <table class="admin-table">
          <thead>
            <tr><th>昵称</th><th>创建时间</th><th>最后活跃</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="user in sortedUsers" :key="user.userId">
              <td class="nickname">{{ user.nickname }}</td>
              <td class="time">{{ formatTime(user.createdAt) }}</td>
              <td class="time">{{ formatTime(user.lastSeenAt) }}</td>
              <td class="row-actions">
                <button class="danger" type="button" :disabled="busy" @click="removeUser(user)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!users.length && !busy" class="admin-empty">还没有任何用户。</p>
      </div>

      <div v-else-if="tab === 'rooms'" class="admin-table-wrap">
        <div class="table-actions">
          <button type="button" :disabled="busy" @click="loadRooms">刷新</button>
          <span class="table-note">解散会把房间里的人直接踢出去，正在进行的牌局也会中断。</span>
        </div>
        <table class="admin-table">
          <thead>
            <tr><th>游戏</th><th>房间号</th><th>状态</th><th>房主</th><th>座位</th><th>玩家</th><th>最后活动</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="room in rooms" :key="`${room.game}-${room.code}`">
              <td>{{ room.game === 'sanguosha' ? '三国杀' : '红中麻将' }}</td>
              <td class="nickname">{{ room.code }}</td>
              <td><span class="phase" :class="room.phase">{{ room.phase === 'playing' ? '牌局中' : room.phase === 'finished' ? '已结束' : '等待开局' }}</span></td>
              <td>{{ room.hostNickname }}</td>
              <td>{{ room.occupiedSeats }}/{{ room.capacity }}</td>
              <td class="room-players">
                <span v-for="player in room.players" :key="`${room.code}-${player.nickname}`" :class="{ ai: player.kind === 'ai' || player.trustee, offline: player.kind !== 'ai' && !player.connected }">
                  {{ player.nickname }}<i v-if="player.kind === 'ai'">AI</i><i v-else-if="player.trustee">托管</i><i v-else-if="!player.connected">离线</i>
                </span>
              </td>
              <td class="time">{{ formatTime(room.updatedAt) }}</td>
              <td class="row-actions"><button class="danger" type="button" :disabled="busy" @click="destroyRoom(room)">解散</button></td>
            </tr>
          </tbody>
        </table>
        <p v-if="!rooms.length && !busy" class="admin-empty">当前没有任何房间。</p>
      </div>

      <div v-else class="settings-wrap">
        <section class="settings-card" v-if="settings">
          <h2>联机设置</h2>
          <label class="setting-row">
            <span><b>托管 AI 档位</b><small>玩家掉线后接管座位的 AI。玩家自己改不了，只能在这里调。</small></span>
            <select v-model="settings.trusteeDifficulty">
              <option v-for="(text, value) in DIFFICULTY_TEXT" :key="value" :value="value">{{ text }}</option>
            </select>
          </label>
          <label class="setting-row">
            <span><b>维护模式</b><small>开启后停止创建新房间；已经在打的牌局和重连都不受影响。</small></span>
            <input v-model="settings.maintenance" type="checkbox">
          </label>
          <label class="setting-row column">
            <span><b>维护提示文案</b><small>玩家点「创建房间」时看到的话。</small></span>
            <input v-model="settings.maintenanceMessage" maxlength="120" placeholder="服务器正在维护更新…">
          </label>
          <p class="settings-note">房主开房时可以自己选空位 AI 的档位（默认凡人），这里只管托管和维护开关。设置只影响之后新建的房间。</p>
          <button class="primary" type="button" :disabled="busy" @click="saveSettings">保存设置</button>
        </section>

        <section class="settings-card">
          <h2>操作记录</h2>
          <p class="settings-note">删除和解散都不可撤销，这里留个底，方便回头查是什么时候做的。</p>
          <ol class="audit-list">
            <li v-for="(entry, index) in audit" :key="index">
              <b>{{ ACTION_TEXT[entry.action] ?? entry.action }}</b>
              <span>{{ entry.detail }}</span>
              <time>{{ formatTime(entry.createdAt) }}</time>
            </li>
          </ol>
          <p v-if="!audit.length" class="admin-empty">还没有操作记录。</p>
        </section>
      </div>
    </template>
  </main>
</template>

<style scoped>
.admin-page { height: 100dvh; overflow-y: auto; padding: 24px clamp(14px, 4vw, 48px) 60px; color: #f2ecda; background: #091410; }
.admin-gate { width: min(420px, 100%); margin: 12vh auto 0; padding: 28px; border: 1px solid #3a544a; border-radius: 18px; background: #0e241e; text-align: center; }
.admin-gate small { color: #8d7a4a; letter-spacing: .24em; font-size: 10px; }
.admin-gate h1 { margin: 8px 0 6px; font-size: 24px; }
.admin-gate p { margin: 0 0 18px; color: #829791; font-size: 12px; line-height: 1.6; }
.admin-gate form { display: grid; gap: 10px; }
.admin-gate input { padding: 12px; min-height: 46px; border: 1px solid #345048; border-radius: 10px; background: #102821; color: #f2ecda; outline: 0; }
.admin-gate input:focus { border-color: #d7b75d; }
.admin-gate button { min-height: 46px; border: 0; border-radius: 10px; background: #e0c069; color: #20261e; font-weight: 800; cursor: pointer; }
.admin-gate button:disabled { opacity: .5; cursor: default; }
.admin-gate a { display: inline-block; margin-top: 16px; color: #7d938c; font-size: 12px; }
.admin-header { width: min(1100px, 100%); margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.admin-header small { color: #8d7a4a; letter-spacing: .24em; font-size: 10px; }
.admin-header h1 { margin: 4px 0 0; font-size: 22px; }
.admin-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.admin-actions button, .row-actions button { min-height: 40px; padding: 9px 14px; border: 1px solid #35524a; border-radius: 9px; background: #14302a; color: #e4dcc4; cursor: pointer; font-size: 13px; }
.admin-actions button.danger, .row-actions button.danger { border-color: #9a4c45; color: #eba9a2; }
.admin-actions button:disabled, .row-actions button:disabled { opacity: .45; cursor: default; }
.admin-error, .admin-notice { width: min(1100px, 100%); margin: 0 auto 12px; padding: 11px 14px; border-radius: 10px; font-size: 13px; }
.admin-error { border: 1px solid #a4514a; background: #4a2521; color: #ffd6d1; }
.admin-notice { border: 1px solid #3f7052; background: #14301f; color: #bfe6cb; }
.admin-tabs { width: min(1100px, 100%); margin: 0 auto 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.admin-tabs button { min-height: 40px; padding: 9px 16px; border: 1px solid #35524a; border-radius: 10px; background: #14302a; color: #a9bdb6; cursor: pointer; font-size: 13px; }
.admin-tabs button.active { border-color: #d3b45e; color: #f0d68a; background: #1b3a31; }
.table-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2b453d; }
.table-actions button { min-height: 38px; padding: 8px 14px; border: 1px solid #35524a; border-radius: 9px; background: #14302a; color: #e4dcc4; cursor: pointer; font-size: 13px; }
.table-actions button.danger { border-color: #9a4c45; color: #eba9a2; }
.table-note { color: #7f948d; font-size: 12px; }
.phase { padding: 3px 8px; border-radius: 99px; font-size: 11px; border: 1px solid #35524a; color: #9db4ac; }
.phase.playing { border-color: #b3944a; color: #f0d68a; }
.room-players { display: flex; flex-wrap: wrap; gap: 5px; white-space: normal; }
.room-players span { padding: 2px 7px; border: 1px solid #2f4a42; border-radius: 99px; font-size: 11px; color: #cfd8d3; }
.room-players span.ai { color: #9db4ac; border-style: dashed; }
.room-players span.offline { color: #c98f88; }
.room-players i { margin-left: 4px; font-style: normal; font-size: 9px; color: #8ba49c; }
.settings-wrap { width: min(1100px, 100%); margin: auto; display: grid; gap: 14px; }
.settings-card { padding: 18px; border: 1px solid #2b453d; border-radius: 14px; background: #0d211c; }
.settings-card h2 { margin: 0 0 12px; font-size: 17px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid #1b322b; }
.setting-row.column { flex-direction: column; align-items: stretch; }
.setting-row > span { display: grid; gap: 3px; }
.setting-row b { color: #e4dcc4; font-size: 14px; }
.setting-row small { color: #7f948d; font-size: 12px; line-height: 1.6; }
.setting-row select, .setting-row input:not([type=checkbox]) { min-height: 42px; padding: 9px 12px; border: 1px solid #35524a; border-radius: 9px; background: #102821; color: #f2ecda; }
.setting-row input[type=checkbox] { width: 22px; height: 22px; accent-color: #d9b95f; }
.settings-note { margin: 12px 0; color: #7f948d; font-size: 12px; line-height: 1.7; }
.settings-card .primary { min-height: 44px; padding: 11px 20px; border: 0; border-radius: 10px; background: #e0c069; color: #20261e; font-weight: 800; cursor: pointer; }
.audit-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; max-height: 340px; overflow-y: auto; }
.audit-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 9px 11px; border-radius: 9px; background: #122923; font-size: 13px; }
.audit-list b { color: #f0d68a; }
.audit-list span { color: #cfd8d3; overflow-wrap: anywhere; }
.audit-list time { color: #7f948d; font-size: 11px; white-space: nowrap; }
.admin-table-wrap { width: min(1100px, 100%); margin: auto; overflow-x: auto; border: 1px solid #2b453d; border-radius: 14px; background: #0d211c; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 13px; white-space: nowrap; }
.admin-table th { padding: 12px 10px; text-align: left; color: #7f948d; font-size: 11px; font-weight: 700; border-bottom: 1px solid #2b453d; }
.admin-table td { padding: 11px 10px; border-bottom: 1px solid #1b322b; color: #cfd8d3; }
.admin-table tr:last-child td { border-bottom: 0; }
.nickname { color: #f0d68a; font-weight: 700; }
.time { color: #7f948d; font-size: 12px; }
.row-actions { display: flex; gap: 6px; }
.admin-empty { padding: 20px; color: #718880; font-size: 13px; text-align: center; }
@media (max-width: 620px) {
  .admin-page { padding: 16px 10px 40px; }
  .admin-table { font-size: 12px; }
}
</style>
