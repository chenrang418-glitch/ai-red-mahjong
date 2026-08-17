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
  totalGames: number
  wins: number
  sevenPairs: number
  gangCount: number
  maCount: number
}

const SESSION_KEY = 'red-mahjong-admin-token'

const token = ref(sessionStorage.getItem(SESSION_KEY) ?? '')
const input = ref('')
const authorized = ref(false)
const users = ref<AdminUser[]>([])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const apiBase = resolveApiBase()

const sortedUsers = computed(() => [...users.value].sort((left, right) => right.wins - left.wins || right.totalGames - left.totalGames))

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

async function removeUser(user: AdminUser) {
  if (!window.confirm(`删除「${user.nickname}」？\n\n该玩家的账号和全部对局记录都会被清掉，排行榜上也不再有他。此操作不可撤销。`)) return
  await run(`/api/admin/users/${user.userId}`, { method: 'DELETE' }, `已删除 ${user.nickname}`)
}

async function resetUser(user: AdminUser) {
  if (!window.confirm(`清空「${user.nickname}」的战绩？\n\n账号保留，局数、胜局、七对、杠、码全部归零。`)) return
  await run(`/api/admin/users/${user.userId}/reset`, { method: 'POST' }, `已清空 ${user.nickname} 的战绩`)
}

async function resetLeaderboard() {
  if (!window.confirm('清空所有人的排行榜数据？\n\n账号都保留，但每个人的战绩都会归零。此操作不可撤销。')) return
  await run('/api/admin/leaderboard/reset', { method: 'POST' }, '排行榜已清空')
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
  window.location.hash = ''
  window.location.reload()
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
        <div><small>ADMIN</small><h1>用户与排行榜</h1></div>
        <div class="admin-actions">
          <button type="button" :disabled="busy" @click="loadUsers">刷新</button>
          <button class="danger" type="button" :disabled="busy" @click="resetLeaderboard">清空排行榜</button>
          <button type="button" @click="lock">退出管理</button>
        </div>
      </header>

      <p v-if="error" class="admin-error">{{ error }}</p>
      <p v-if="notice" class="admin-notice">{{ notice }}</p>

      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr><th>昵称</th><th>总局</th><th>胜局</th><th>七对</th><th>杠</th><th>码</th><th>最后活跃</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="user in sortedUsers" :key="user.userId">
              <td class="nickname">{{ user.nickname }}</td>
              <td>{{ user.totalGames }}</td>
              <td>{{ user.wins }}</td>
              <td>{{ user.sevenPairs }}</td>
              <td>{{ user.gangCount }}</td>
              <td>{{ user.maCount }}</td>
              <td class="time">{{ formatTime(user.lastSeenAt) }}</td>
              <td class="row-actions">
                <button type="button" :disabled="busy" @click="resetUser(user)">清空战绩</button>
                <button class="danger" type="button" :disabled="busy" @click="removeUser(user)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!users.length && !busy" class="admin-empty">还没有任何用户。</p>
      </div>
    </template>
  </main>
</template>

<style scoped>
.admin-page { min-height: 100vh; min-height: 100dvh; padding: 24px clamp(14px, 4vw, 48px) 60px; color: #f2ecda; background: #091410; }
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
