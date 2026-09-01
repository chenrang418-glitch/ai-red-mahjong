<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import SgsRequestDock from './SgsRequestDock.vue'
import SgsTable from './SgsTable.vue'
import { useOnlineSanguosha } from '../composables/useOnlineSanguosha'
import { DEFAULT_SGS_ROOM_SETTINGS } from '../online/protocol'

defineEmits<{ back: [] }>()

const online = useOnlineSanguosha()
const nickname = ref(online.lastNickname.value)
const manualCode = ref('')
const settings = reactive({ ...DEFAULT_SGS_ROOM_SETTINGS })
const confirmLeave = ref(false)
const me = computed(() => online.room.value?.seats.find((seat) => seat.isSelf) ?? null)
const isHost = computed(() => online.session.value?.userId === online.room.value?.hostUserId)
const allSeatsFilled = computed(() => online.room.value?.seats.every((seat) => seat.kind !== 'empty') ?? false)
const allHumansReady = computed(() => online.room.value?.seats.every((seat) => seat.kind !== 'human' || seat.ready) ?? false)
const connectionStatuses = computed(() => Object.fromEntries((online.room.value?.seats ?? [])
  .filter((seat) => seat.kind !== 'empty')
  .map((seat) => [`seat-${seat.seatId}`, seat.trustee ? 'trustee' : seat.connected ? 'online' : 'offline'] as const)))

onMounted(() => { void online.restoreSession() })

const shareState = ref<'idle' | 'copied' | 'manual'>('idle')
const shareLink = computed(() => {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('game', 'sanguosha')
  url.searchParams.set('room', online.room.value?.code ?? '')
  return url.toString()
})
let shareResetTimer: number | null = null

function flashShareState(next: 'copied' | 'manual'): void {
  shareState.value = next
  if (shareResetTimer !== null) window.clearTimeout(shareResetTimer)
  // 手动复制那条要留久一点，用户得有时间把链接选中
  shareResetTimer = window.setTimeout(() => { shareState.value = 'idle' }, next === 'manual' ? 15000 : 2200)
}

/** 和麻将同一套：微信、QQ 这些内置浏览器里剪贴板经常是禁的，系统分享反而能用。 */
async function shareRoom(): Promise<void> {
  const code = online.room.value?.code
  if (!code) return
  const link = shareLink.value
  const text = `来打三国杀，房间号 ${code}`
  if (navigator.share) {
    try {
      await navigator.share({ title: '三国杀', text, url: link })
      return
    } catch (cause) {
      // 用户自己取消的不算失败，不用再弹别的
      if (cause instanceof Error && cause.name === 'AbortError') return
    }
  }
  try {
    await navigator.clipboard.writeText(link)
    flashShareState('copied')
  } catch {
    flashShareState('manual')
  }
}

onBeforeUnmount(() => {
  if (shareResetTimer !== null) window.clearTimeout(shareResetTimer)
})
</script>

<template>
  <SgsTable
    v-if="online.room.value?.phase === 'playing' && online.room.value.playerView?.status !== 'choosing-general'"
    :view="online.room.value.playerView!"
    :request="online.room.value.playerView?.pendingRequest ?? null"
    :legal-actions="online.room.value.playerView?.legalActions ?? []"
    :busy="online.room.value.aiThinking || !online.connected.value"
    :log="online.room.value.log"
    :presentation-events="online.room.value.presentationEvents"
    :deadline-at="online.room.value.deadlineAt"
    :connection-statuses="connectionStatuses"
    @act="online.act"
    @respond="online.respond"
    @quit="confirmLeave = true"
  />

  <main v-else class="sgs-online">
    <header class="sgs-online__bar">
      <button type="button" @click="online.room.value ? (confirmLeave = true) : $emit('back')">‹</button>
      <div><strong>联机身份局</strong><small v-if="online.room.value">房间 {{ online.room.value.code }}</small></div>
      <span :class="{ live: online.connected.value }">{{ online.connected.value ? '已连接' : online.connecting.value ? '连接中' : '未连接' }}</span>
      <button v-if="online.session.value && !online.room.value" type="button" class="sgs-online__logout" @click="online.logout">退出</button>
    </header>

    <section v-if="!online.session.value" class="sgs-online__panel sgs-online__login">
      <strong>输入昵称</strong>
      <form @submit.prevent="online.login(nickname)">
        <input v-model="nickname" maxlength="12" autocomplete="nickname" placeholder="昵称" aria-label="昵称">
        <button type="submit" class="primary" :disabled="online.busy.value">{{ online.busy.value ? '登录中…' : '进入大厅' }}</button>
      </form>
    </section>

    <template v-else-if="!online.room.value">
      <!-- 昵称单独成一条，不塞进创建房间卡片里：手机断点会把卡片内容压缩，
           塞在里面就等于手机上看不到自己是谁。和麻将大厅同一个处理。 -->
      <div class="sgs-online__identity">
        <span>当前昵称</span>
        <strong>{{ online.session.value.nickname }}</strong>
      </div>

      <section class="sgs-online__panel sgs-online__create">
        <h1>创建房间</h1>
        <label><span>人数</span><select v-model.number="settings.playerCount"><option v-for="count in [5, 6, 7, 8]" :key="count" :value="count">{{ count }} 人</option></select></label>
        <label><span>AI 难度</span><select v-model="settings.difficulty"><option value="easy">简单</option><option value="normal">标准</option><option value="hard">困难</option></select></label>
        <label><span>操作时间</span><select v-model.number="settings.turnSeconds"><option :value="15">15 秒</option><option :value="30">30 秒</option><option :value="60">60 秒</option></select></label>
        <button type="button" class="primary" :disabled="online.busy.value" @click="online.createRoom(settings)">创建房间</button>
      </section>

      <section class="sgs-online__panel sgs-online__join">
        <h2>加入房间</h2>
        <form @submit.prevent="online.joinRoom(manualCode)">
          <input v-model="manualCode" maxlength="6" autocomplete="off" placeholder="6 位房间号" aria-label="房间号" @input="manualCode = manualCode.toUpperCase()">
          <button type="submit">加入</button>
        </form>
      </section>

      <section class="sgs-online__panel sgs-online__rooms">
        <header><h2>公开房间</h2><button type="button" @click="online.refreshRooms">刷新</button></header>
        <button v-for="entry in online.rooms.value" :key="entry.code" type="button" :disabled="!entry.joinable" @click="online.joinRoom(entry.code)">
          <span><b>{{ entry.code }}</b><small>{{ entry.hostNickname }} · {{ entry.occupiedSeats }}/{{ entry.settings.playerCount }} 人</small></span>
          <em>{{ entry.rejoinable ? '重新进入' : entry.phase === 'lobby' ? '加入' : '进行中' }}</em>
        </button>
        <p v-if="!online.rooms.value.length">暂无公开房间</p>
      </section>
    </template>

    <section v-else-if="online.room.value.phase === 'lobby'" class="sgs-online__panel sgs-online__waiting">
      <div class="sgs-online__code"><small>房间号</small><strong>{{ online.room.value.code }}</strong><button type="button" @click="shareRoom">分享房间链接</button></div>
      <div v-if="shareState !== 'idle'" class="sgs-online__share">
        <span :class="{ ok: shareState === 'copied' }">{{ shareState === 'copied' ? '链接已复制，发给朋友即可' : '这个浏览器不给复制，长按下面的链接自己复制' }}</span>
        <input v-if="shareState === 'manual'" :value="shareLink" readonly @focus="($event.target as HTMLInputElement).select()">
      </div>
      <div class="sgs-online__seats">
        <article v-for="seat in online.room.value.seats" :key="seat.seatId" :class="{ empty: seat.kind === 'empty' }">
          <span>{{ seat.kind === 'empty' ? '空位' : seat.name }}</span>
          <small v-if="seat.kind === 'human'">{{ seat.ready ? '已准备' : '未准备' }}{{ seat.connected ? '' : ' · 离线' }}</small>
          <small v-else-if="seat.kind === 'ai'">电脑 · {{ online.room.value.settings.difficulty }}</small>
          <button v-if="isHost && seat.kind === 'ai'" type="button" @click="online.send({ type: 'remove-ai', seatId: seat.seatId })">移除</button>
        </article>
      </div>
      <div class="sgs-online__actions">
        <button v-if="isHost && !allSeatsFilled" type="button" @click="online.send({ type: 'add-ai' })">添加电脑</button>
        <button v-if="me?.kind === 'human'" type="button" :class="{ primary: !me.ready }" @click="online.send({ type: 'toggle-ready' })">{{ me.ready ? '取消准备' : '准备' }}</button>
        <button v-if="isHost" type="button" class="primary" :disabled="!allSeatsFilled || !allHumansReady" @click="online.send({ type: 'start-game' })">开始游戏</button>
      </div>
    </section>

    <section v-else-if="online.room.value.playerView?.status === 'choosing-general'" class="sgs-online__panel sgs-online__choose">
      <h1>选择武将</h1>
      <SgsRequestDock
        v-if="online.room.value.playerView.pendingRequest"
        :request="online.room.value.playerView.pendingRequest"
        :view="online.room.value.playerView"
        @submit="online.respond"
      />
      <p v-else>等待其他玩家选择…</p>
    </section>

    <section v-else class="sgs-online__panel sgs-online__finished">
      <h1>本局结束</h1>
      <p>{{ online.room.value.playerView?.result?.reason ?? '等待下一局' }}</p>
      <button type="button" class="primary" :disabled="me?.nextRoundReady" @click="online.send({ type: 'next-round' })">{{ me?.nextRoundReady ? '等待其他玩家' : '再来一局' }}</button>
    </section>

    <p v-if="online.error.value" class="sgs-online__error" role="alert">{{ online.error.value }}</p>
  </main>

  <div v-if="confirmLeave" class="sgs-online__mask">
    <section role="dialog" aria-modal="true" class="sgs-online__confirm">
      <h2>离开这个房间？</h2>
      <p>进行中的座位会暂时交给 AI 托管，稍后仍可通过房间号重连。</p>
      <div><button type="button" @click="confirmLeave = false">取消</button><button type="button" class="danger" @click="confirmLeave = false; online.leaveRoom()">离开房间</button></div>
    </section>
  </div>
</template>

<style scoped>
.sgs-online { height: 100dvh; overflow: hidden; display: grid; grid-template-columns: minmax(260px, .8fr) minmax(300px, 1.2fr); grid-template-rows: auto auto 1fr 1fr; gap: 12px; padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); color: var(--ink-text); background: radial-gradient(circle at 70% 10%, rgba(207, 164, 86, .22), transparent 44%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom)); }
.sgs-online__bar { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; }
.sgs-online__bar > button { width: 38px; height: 38px; border: 1px solid #465049; border-radius: 9px; background: #15201a; color: #eee2ca; font-size: 22px; }
.sgs-online__bar div { display: grid; }.sgs-online__bar small { color: #89968e; }.sgs-online__bar > span { margin-left: auto; color: #8f8278; font-size: 12px; white-space: nowrap; }.sgs-online__bar > span.live { color: #79b68d; }
/* 顶栏的 `> button` 是给返回箭头写的，会把这个按钮也锁成 38px 方块，
   所以这里要用同级更具体的选择器才盖得住 */
.sgs-online__bar > button.sgs-online__logout { flex: none; width: auto; height: auto; min-height: 34px; padding: 0 12px; white-space: nowrap; color: #c3b79f; font-size: 13px; }
.sgs-online__bar > button.sgs-online__logout:hover { border-color: var(--accent-gold); color: var(--ink-text); }

/* 昵称条横跨整行，位置和麻将大厅一致 */
.sgs-online__identity { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border: 1px solid #36423a; border-radius: 12px; background: rgba(17, 28, 22, .88); }
.sgs-online__identity span { color: #8ea29b; font-size: 12px; }
.sgs-online__identity strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f1d078; font-size: 15px; }

.sgs-online__share { display: grid; gap: 6px; margin-top: 9px; }
.sgs-online__share span { color: #93a8a0; font-size: 12px; }
.sgs-online__share span.ok { color: #7fc79a; }
.sgs-online__share input { width: min(360px, 100%); min-height: 38px; padding: 0 11px; border: 1px solid #35524a; border-radius: 9px; background: #0c1f1a; color: #d9e2dc; font-size: 12px; }
.sgs-online__panel { min-height: 0; padding: 16px; border: 1px solid #36423a; border-radius: 15px; background: rgba(17, 28, 22, .88); }
.sgs-online__panel h1, .sgs-online__panel h2 { margin: 0 0 12px; color: #efd58c; }.sgs-online__panel h1 { font-size: 21px; }.sgs-online__panel h2 { font-size: 15px; }
.sgs-online__panel form, .sgs-online__panel label { display: flex; gap: 8px; }.sgs-online__panel label { align-items: center; justify-content: space-between; margin: 8px 0; color: #aab4ac; font-size: 13px; }
.sgs-online input, .sgs-online select, .sgs-online button { min-height: 42px; border: 1px solid #465049; border-radius: 9px; background: #15201a; color: #e8dfca; font: inherit; }.sgs-online input { min-width: 0; flex: 1; padding: 0 12px; }.sgs-online select, .sgs-online button { padding: 0 13px; }.sgs-online button { cursor: pointer; }.sgs-online button:disabled { opacity: .45; cursor: default; }.sgs-online .primary { border-color: #a88438; background: #5d471f; color: #ffe8aa; }
.sgs-online__login, .sgs-online__waiting, .sgs-online__choose, .sgs-online__finished { grid-column: 1 / -1; align-self: center; justify-self: center; width: min(680px, 100%); }.sgs-online__login { width: min(430px, 100%); padding: 28px; }.sgs-online__login > strong { display: block; margin-bottom: 18px; color: #efd58c; font-size: 25px; }.sgs-online__login form { display: grid; gap: 12px; }
.sgs-online__create { grid-column: 1; grid-row: 3 / 5; }.sgs-online__join { grid-column: 2; grid-row: 3; }.sgs-online__rooms { grid-column: 2; grid-row: 4; overflow-y: auto; }.sgs-online__rooms header { display: flex; justify-content: space-between; align-items: center; }.sgs-online__rooms > button { width: 100%; display: flex; justify-content: space-between; align-items: center; margin-top: 8px; text-align: left; }.sgs-online__rooms span { display: grid; }.sgs-online__rooms small { color: #849088; }.sgs-online__rooms em { color: #d0b46c; font-style: normal; }
.sgs-online__code { display: flex; align-items: center; gap: 12px; }.sgs-online__code strong { font-size: 25px; letter-spacing: .12em; }.sgs-online__code button { margin-left: auto; }.sgs-online__seats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }.sgs-online__seats article { min-height: 78px; display: grid; align-content: center; gap: 3px; padding: 10px; border: 1px solid #465049; border-radius: 10px; }.sgs-online__seats article.empty { color: #6f7b73; border-style: dashed; }.sgs-online__seats small { color: #89968e; }.sgs-online__seats button { min-height: 28px; margin-top: 4px; }.sgs-online__actions { display: flex; justify-content: flex-end; gap: 8px; }.sgs-online__error { position: fixed; left: 50%; bottom: 18px; z-index: 60; transform: translateX(-50%); margin: 0; padding: 10px 14px; border-radius: 10px; background: #783d36; color: #ffe0db; }
.sgs-online__mask { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 20px; background: rgba(0, 0, 0, .72); }.sgs-online__confirm { width: min(390px, 100%); padding: 20px; border: 1px solid #5b5040; border-radius: 16px; background: #172019; color: #e8dfca; }.sgs-online__confirm h2 { margin-top: 0; }.sgs-online__confirm p { color: #9ba49d; }.sgs-online__confirm div { display: flex; justify-content: flex-end; gap: 8px; }.sgs-online__confirm button { min-height: 42px; padding: 0 14px; border: 1px solid #485249; border-radius: 9px; background: #202a23; color: #e8dfca; }.sgs-online__confirm .danger { border-color: #8d4c43; background: #62362f; }
@media (max-width: 620px) and (orientation: portrait) { .sgs-online { grid-template-columns: 1fr; grid-template-rows: auto auto auto auto minmax(0, 1fr); overflow-y: auto; }.sgs-online__identity { padding: 8px 14px; }.sgs-online__identity span { font-size: 11px; }.sgs-online__identity strong { font-size: 14px; }.sgs-online__bar, .sgs-online__identity, .sgs-online__login, .sgs-online__waiting, .sgs-online__choose, .sgs-online__finished, .sgs-online__create, .sgs-online__join, .sgs-online__rooms { grid-column: 1; grid-row: auto; }.sgs-online__login { padding: 20px; }.sgs-online__seats { grid-template-columns: repeat(2, 1fr); }.sgs-online__actions { flex-wrap: wrap; } }
@media (orientation: landscape) and (max-height: 500px) { .sgs-online { grid-template-rows: auto auto 1fr; }.sgs-online__identity { padding: 5px 12px; }.sgs-online__identity span { font-size: 10px; }.sgs-online__identity strong { font-size: 13px; }.sgs-online__create { grid-row: 3; }.sgs-online__join { display: none; }.sgs-online__rooms { grid-row: 3; }.sgs-online__waiting { max-height: 100%; overflow-y: auto; }.sgs-online__seats { grid-template-columns: repeat(4, 1fr); margin: 8px 0; }.sgs-online__seats article { min-height: 58px; } }
</style>
