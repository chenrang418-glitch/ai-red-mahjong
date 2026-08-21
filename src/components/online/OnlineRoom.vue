<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AudioControl from '@/components/game/AudioControl.vue'
import MahjongTable from '@/components/game/MahjongTable.vue'
import MahjongTile from '@/components/game/MahjongTile.vue'
import TopbarMenu from '@/components/game/TopbarMenu.vue'
import ChatPanel from './ChatPanel.vue'
import DiceToast from '@/components/game/DiceToast.vue'
import { gameAudio } from '@/composables/useGameAudio'
import { useImmersiveTable } from '@/composables/useImmersiveTable'
import { tileFromFace, tileLabel } from '@/game/tiles'
import type { Tile } from '@/game/types'
import type { OnlinePendingAction, OnlineRoomView, RoomActionDraft, RoomCommand } from '@/online/types'

const props = defineProps<{
  room: OnlineRoomView
  connected: boolean
  pendingAction: OnlinePendingAction | null
  chatBubbles: Record<number, { id: string; text: string }>
}>()
const emit = defineEmits<{ command: [command: RoomCommand]; leave: [] }>()
const { immersive, toggleImmersive } = useImmersiveTable()
const selectedTileId = ref('')
// 手机端多一个「本场积分」页签：积分面板在手机上不常驻
const sideTab = ref<'score' | 'events' | 'chat'>('events')
const audioOpen = ref(false)
const mobileChatOpen = ref(false)
// 手机上积分/记录/聊天都收进同一个抽屉，牌桌才占得满一屏。
// 聊天仍然保留右下角那个圆钮，点它直接开到聊天页。
const compactLayout = ref(false)
let compactQuery: MediaQueryList | null = null
function syncCompact(event: MediaQueryList | MediaQueryListEvent) {
  compactLayout.value = event.matches
  if (!event.matches) mobileChatOpen.value = false
}
onMounted(() => {
  compactQuery = window.matchMedia('(pointer: coarse), (max-width: 820px) and (orientation: portrait), (max-height: 620px) and (orientation: landscape)')
  syncCompact(compactQuery)
  compactQuery.addEventListener('change', syncCompact)
})
onBeforeUnmount(() => compactQuery?.removeEventListener('change', syncCompact))
const showSidePanels = computed(() => !compactLayout.value || mobileChatOpen.value)
function openInfo(tab: 'score' | 'events' | 'chat') {
  sideTab.value = tab
  mobileChatOpen.value = true
}
const clock = ref(Date.now())
let audioMatchId = ''

// —— 服务器时钟校准 ——
// deadlineAt 与 turnTimer 都是服务器时间戳，直接和本地 Date.now() 相减，
// 设备时间不准就会把剩余秒数算错。每个样本恒等于「真实偏移 - 单程延迟」，
// 所以取历次最大值，等价于采用网络延迟最小的那次采样。
const clockOffset = ref(0)
let clockCalibrated = false
const serverClock = computed(() => clock.value + clockOffset.value)

function calibrateClock(serverNow: number) {
  if (!serverNow) return
  const sample = serverNow - Date.now()
  if (!clockCalibrated || sample > clockOffset.value) {
    clockOffset.value = sample
    clockCalibrated = true
  }
}

// 没有任何倒计时要显示时不空转，避免等待开局和结算弹窗期间持续重绘牌桌
const timerActive = computed(() => props.room.deadlineAt !== null || props.room.turnTimer !== null)
let clockTimer: number | null = null

function stopTicking() {
  if (clockTimer === null) return
  window.clearInterval(clockTimer)
  clockTimer = null
}

function syncTicking() {
  clock.value = Date.now()
  if (!timerActive.value || document.hidden) {
    stopTicking()
    return
  }
  if (clockTimer === null) clockTimer = window.setInterval(() => { clock.value = Date.now() }, 250)
}

// 后台标签页会被浏览器把定时器节流到 1 秒以上，切回时先纠正一次读数再恢复节奏
function handleVisibilityChange() {
  syncTicking()
}

watch(() => props.room.serverNow, calibrateClock, { immediate: true })
watch(() => props.connected, (isConnected) => { if (!isConnected) clockCalibrated = false })
watch(timerActive, syncTicking, { immediate: true })
document.addEventListener('visibilitychange', handleVisibilityChange)

onBeforeUnmount(() => {
  stopTicking()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (audioMatchId) gameAudio.stopMatch()
})
watch(() => props.room.game?.currentPlayer, () => { selectedTileId.value = '' })
watch(() => props.room.game, (game) => {
  if (!game) {
    if (audioMatchId) gameAudio.stopMatch()
    audioMatchId = ''
    return
  }
  if (game.matchId !== audioMatchId) {
    audioMatchId = game.matchId
    gameAudio.prepareMatch(game.matchId, game.events, true)
  }
  gameAudio.processEvents(game, props.room.selfSeatId)
}, { immediate: true })
watch(() => props.connected, (connected) => {
  if (!audioMatchId) return
  if (connected) gameAudio.startMusic()
  else gameAudio.stopMusic()
})

const isHost = computed(() => props.room.selfUserId === props.room.hostUserId)
const selfSeat = computed(() => props.room.seats[props.room.selfSeatId])
const human = computed(() => props.room.game?.players[props.room.selfSeatId] ?? null)
const displayedGame = computed(() => {
  const game = props.room.game
  const pending = props.pendingAction
  if (!game || pending?.type !== 'discard') return game
  const player = game.players[props.room.selfSeatId]
  const tile = player.hand.find((candidate) => candidate.id === pending.tileId)
  if (!tile) return game
  const optimistic = structuredClone(game)
  const optimisticPlayer = optimistic.players[props.room.selfSeatId]
  optimisticPlayer.hand = optimisticPlayer.hand.filter((candidate) => candidate.id !== pending.tileId)
  optimisticPlayer.discards.push(structuredClone(tile))
  return optimistic
})
const displayedTrustee = computed(() => props.pendingAction?.type === 'trustee' ? props.pendingAction.enabled : selfSeat.value.trustee)
const selectedTile = computed(() => human.value?.hand.find((tile) => tile.id === selectedTileId.value) ?? null)
const sortedScores = computed(() => props.room.game ? [...props.room.game.players].sort((left, right) => (right.points ?? right.stats.netPoints) - (left.points ?? left.stats.netPoints)) : [])
const claimSeconds = computed(() => props.room.deadlineAt
  ? String(Math.max(0, Math.ceil((props.room.deadlineAt - serverClock.value) / 1000)))
  : '')
const claimProgress = computed(() => {
  if (!props.room.deadlineAt || !props.room.game) return 0
  const remaining = Math.max(0, props.room.deadlineAt - serverClock.value)
  return Math.min(100, (remaining / props.room.game.config.claimWindowMs) * 100)
})
// 座位上直接标出「谁在托管、谁掉线了」，不用再去积分面板里比对。
const seatStatus = computed(() => {
  const result: Record<number, string> = {}
  for (const seat of props.room.seats) {
    if (seat.kind === 'ai') result[seat.seatId] = '房间AI'
    else if (seat.trustee) result[seat.seatId] = 'AI托管'
    else if (!seat.connected) result[seat.seatId] = '离线'
  }
  return result
})

const seatBubbles = computed(() => {
  const result: Record<number, string> = {}
  for (const [seatId, bubble] of Object.entries(props.chatBubbles)) result[Number(seatId)] = bubble.text
  return result
})

const eventTypeLabel: Record<string, string> = {
  'match-start': '整场开始', dice: '投骰', 'round-start': '本局开始', draw: '摸牌',
  discard: '出牌', peng: '碰', 'ming-gang': '明杠', 'an-gang': '暗杠',
  'bu-gang': '补杠', 'claim-pass': '过', win: '胡牌', 'draw-game': '流局',
  'match-over': '整场结束', 'ai-change': 'AI调整',
}

function action(command: RoomActionDraft) {
  emit('command', { ...command, actionId: crypto.randomUUID(), version: props.room.version } as RoomCommand)
}

function selectTile(tile: Tile) {
  if (!props.room.legal.canDiscard) return
  selectedTileId.value = selectedTileId.value === tile.id ? '' : tile.id
}

function discardSelected() {
  if (!selectedTile.value) return
  action({ type: 'discard', tileId: selectedTile.value.id })
  selectedTileId.value = ''
}

function leave() {
  if (window.confirm('离开后你的座位会立即由 AI 接管，牌局继续。用同一个昵称输入房间号还能回来。确定离开吗？')) emit('leave')
}

const shareState = ref<'idle' | 'copied' | 'manual'>('idle')
const shareLink = computed(() => `${location.origin}${location.pathname}#join=${props.room.code}`)
let shareResetTimer: number | null = null

function flashShareState(next: 'copied' | 'manual') {
  shareState.value = next
  if (shareResetTimer !== null) window.clearTimeout(shareResetTimer)
  // 手动复制那条要留久一点，用户得有时间把链接选中
  shareResetTimer = window.setTimeout(() => { shareState.value = 'idle' }, next === 'manual' ? 15000 : 2200)
}

async function shareRoom() {
  const link = shareLink.value
  const text = `来打红中麻将，房间号 ${props.room.code}`
  // 微信、QQ 这些内置浏览器里剪贴板经常是禁的，系统分享反而能用
  if (navigator.share) {
    try {
      await navigator.share({ title: 'AI 红中麻将', text, url: link })
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
  if (leaveToastTimer !== null) window.clearTimeout(leaveToastTimer)
})

// 点过「开始下一局」就把结算弹窗收起来，先回牌桌等其他人，
// 不用盯着一个自己已经点过的弹窗干等。
const nextRoundDismissed = ref(false)

watch(() => props.room.game?.phase, (phase) => {
  if (phase !== 'settlement') nextRoundDismissed.value = false
})

// 服务端说自己已经点过了（比如换了设备重连回来），弹窗也不该再挡着
watch(() => props.room.legal.nextRoundReady, (ready) => {
  if (ready) nextRoundDismissed.value = true
})

function confirmNextRound() {
  nextRoundDismissed.value = true
  emit('command', { type: 'next-round' })
}

function quitRoom() {
  if (!window.confirm('退出后座位立刻换成 AI，你不能再回到这一场，本局战绩也不会计入你名下。确定退出吗？')) return
  emit('leave')
}

// 有人在结算界面退出时，牌桌上方冒一条提示——
// 不然别人只会看到某个座位突然变成了 AI，不知道发生了什么。
const leaveToast = ref('')
let leaveToastTimer: number | null = null
let lastSeenEventId = ''

watch(() => props.room.game?.events, (events) => {
  if (!events?.length) return
  const latest = events[events.length - 1]
  if (latest.id === lastSeenEventId) return
  const first = lastSeenEventId === ''
  lastSeenEventId = latest.id
  // 首次进房不回放历史事件，否则一进来就弹一堆旧提示
  if (first || latest.type !== 'ai-change' || !latest.detail.includes('离开房间')) return
  leaveToast.value = latest.detail
  if (leaveToastTimer !== null) window.clearTimeout(leaveToastTimer)
  leaveToastTimer = window.setTimeout(() => { leaveToast.value = '' }, 4200)
}, { deep: false, immediate: true })

function sendChat(text: string, quick: boolean) {
  emit('command', { type: 'chat', text, quick })
}
</script>

<template>
  <main v-if="room.phase === 'lobby'" class="online-lobby-page" @pointerdown.capture="gameAudio.unlock">
    <header class="lobby-header">
      <button type="button" @click="emit('leave')">← 返回联机大厅</button>
      <div class="lobby-room-code"><small>ROOM CODE</small><strong>{{ room.code }}</strong></div>
      <div class="lobby-header-actions"><AudioControl /><span :class="{ online: connected }">{{ connected ? '已连接' : '重连中…' }}</span></div>
    </header>

    <section class="lobby-card">
      <div class="lobby-heading">
        <div>
          <small>ONLINE ROOM</small>
          <h1>等待开局</h1>
          <p>把房间号或链接发给其他玩家；开局时空位会自动补充 AI。</p>
          <div class="share-row">
            <button class="share-button" type="button" @click="shareRoom">分享房间链接</button>
            <span v-if="shareState === 'copied'" class="share-hint ok">链接已复制，发给朋友即可</span>
            <span v-else-if="shareState === 'manual'" class="share-hint">这个浏览器不给复制，长按下面的链接自己复制</span>
          </div>
          <input v-if="shareState === 'manual'" class="share-link" :value="shareLink" readonly @focus="($event.target as HTMLInputElement).select()">
        </div>
        <div class="lobby-rules"><span>{{ room.settings.mode === 'finite' ? `有限积分 · ${room.settings.initialPoints}分` : '无限模式' }}</span><span>抢牌 {{ room.settings.claimWindowMs / 1000 }} 秒</span><span>操作 30 秒</span></div>
      </div>

      <div class="online-seats">
        <article v-for="seat in room.seats" :key="seat.seatId" :class="[seat.kind, { self: seat.seatId === room.selfSeatId }]">
          <div class="seat-avatar">{{ seat.kind === 'empty' ? '空' : seat.kind === 'ai' ? 'AI' : seat.name.slice(0, 1) }}</div>
          <strong>{{ seat.kind === 'empty' ? '等待加入' : seat.name }}</strong>
          <small v-if="seat.isHost">房主</small>
          <small v-else-if="seat.kind === 'human'">{{ seat.ready ? '已准备' : '未准备' }}</small>
          <small v-else>开局自动补 AI</small>
          <i v-if="seat.kind === 'human'" :class="{ online: seat.connected }">{{ seat.connected ? '在线' : '离线' }}</i>
        </article>
      </div>

      <footer>
        <p v-if="isHost">其他真人准备后即可开局；不足四人的位置自动补 AI。</p>
        <p v-else>准备后等待房主开局。</p>
        <button v-if="isHost" class="start-button" type="button" @click="emit('command', { type: 'start-game' })">开始牌局</button>
        <button v-else class="ready-button" type="button" @click="emit('command', { type: 'ready', ready: !selfSeat.ready })">{{ selfSeat.ready ? '取消准备' : '准备' }}</button>
      </footer>
    </section>
  </main>

  <div v-else-if="room.game" class="game-page online-game-page" :class="{ immersive }" @pointerdown.capture="gameAudio.unlock">
    <header class="topbar">
      <!-- 房间号是联机时最需要念给别人听的信息，手机上原本要横屏才看得到，现在提到顶栏 -->
      <div class="brand">
        <span>中</span>
        <div><strong class="room-code">{{ room.code }}</strong><small>{{ connected ? '联机中' : '重连中…' }}</small></div>
      </div>
      <div class="status-pill" :class="room.game.phase">{{ connected ? room.notice : '连接中断，正在重连…' }}</div>
      <nav>
        <button type="button" :class="{ trustee: displayedTrustee, pending: pendingAction?.type === 'trustee' }" :disabled="!!pendingAction" @click="emit('command', { type: 'trustee', enabled: !selfSeat.trustee })">{{ pendingAction?.type === 'trustee' ? pendingAction.enabled ? '开启托管中…' : '取消托管中…' : selfSeat.trustee ? '取消托管' : 'AI托管' }}</button>
        <button class="mobile-only" type="button" @click="openInfo('score')">战况</button>
        <AudioControl class="desktop-only" />
        <button class="danger desktop-only" type="button" @click="leave">退出房间</button>
        <TopbarMenu class="mobile-only">
          <button type="button" @click="audioOpen = true">声音</button>
          <button class="danger" type="button" @click="leave">退出房间</button>
        </TopbarMenu>
      </nav>
    </header>

    <main class="game-layout">
      <aside v-if="showSidePanels" class="side-panel score-panel">
        <section>
          <div class="section-title">本场积分</div>
          <ol class="ranking">
            <li v-for="(player, index) in sortedScores" :key="player.id">
              <span class="rank">{{ index + 1 }}</span>
              <div><strong>{{ player.name }}</strong><small>{{ room.seats[player.id].trustee ? 'AI托管中' : room.seats[player.id].kind === 'ai' ? '房间AI' : room.seats[player.id].connected ? '真人在线' : '真人离线' }}</small></div>
              <b>{{ player.points === null ? `${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : player.points }}</b>
            </li>
          </ol>
        </section>
        <section>
          <div class="section-title">房间信息</div>
          <div class="room-facts"><span>房间号<b>{{ room.code }}</b></span><span>当前局数<b>{{ room.game.round }}</b></span><span>联机状态<b>{{ connected ? '稳定' : '重连' }}</b></span></div>
        </section>
      </aside>

      <section class="table-column">
        <MahjongTable
          :state="displayedGame!"
          :human-id="room.selfSeatId"
          :selected-tile-id="selectedTileId"
          :readonly="!room.legal.canDiscard || !!pendingAction"
          :reveal-all="room.game.phase === 'settlement' || room.game.phase === 'match-over'"
          :turn-timer="room.turnTimer"
          :timer-now="serverClock"
          :seat-status="seatStatus"
          :bubbles="seatBubbles"
          fullscreen-toggle
          :immersive="immersive"
          @select-tile="selectTile"
          @toggle-immersive="toggleImmersive"
        >
          <template #hand-corner>
            <button class="chat-fab" type="button" @click="openInfo('chat')">聊</button>
          </template>
        </MahjongTable>
        <div class="action-dock">
          <template v-if="pendingAction?.type === 'discard'">
            <span class="waiting-dot"></span><span>出牌已显示，正在等待服务器确认…</span>
          </template>
          <template v-else-if="pendingAction?.type === 'trustee'">
            <span class="waiting-dot"></span><span>{{ pendingAction.enabled ? '正在开启AI托管…' : '正在取消AI托管…' }}</span>
          </template>
          <template v-else-if="selfSeat.trustee">
            <span class="waiting-dot"></span><span>AI 正在托管你的座位</span><button type="button" @click="emit('command', { type: 'trustee', enabled: false })">取消托管</button>
          </template>
          <template v-else-if="room.legal.claimActions.length">
            <div class="claim-clock" role="timer" :aria-label="`抢牌响应剩余 ${claimSeconds} 秒`"><b>{{ claimSeconds }}</b><span>秒内响应</span><i><em :style="{ width: `${claimProgress}%` }"></em></i></div>
            <button v-if="room.legal.claimActions.includes('peng')" class="gold" type="button" @click="action({ type: 'claim', action: 'peng' })">碰</button>
            <button v-if="room.legal.claimActions.includes('ming-gang')" class="red" type="button" @click="action({ type: 'claim', action: 'ming-gang' })">杠</button>
            <button type="button" @click="action({ type: 'pass-claim' })">过</button>
          </template>
          <!-- 倒计时已经画在自己座位的圆环上了，这里不再重复一遍秒数 -->
          <template v-else-if="room.legal.canDiscard">
            <button v-if="room.legal.canWin" class="red" type="button" @click="action({ type: 'win' })">自摸</button>
            <button v-for="face in room.legal.anGangFaces" :key="`an-${face}`" class="gold" type="button" @click="action({ type: 'gang', gangType: 'an-gang', face })">暗杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button v-for="face in room.legal.buGangFaces" :key="`bu-${face}`" class="gold" type="button" @click="action({ type: 'gang', gangType: 'bu-gang', face })">补杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button class="discard-button" type="button" :disabled="!selectedTile" @click="discardSelected">{{ selectedTile ? `打出 ${tileLabel(selectedTile)}` : '出牌' }}</button>
          </template>
          <template v-else><span class="waiting-dot"></span><span>{{ room.notice }}</span></template>
        </div>
      </section>

      <aside v-if="showSidePanels" class="side-panel event-panel online-right-panel" :class="{ 'mobile-open': mobileChatOpen }">
        <header class="side-tabs">
          <button v-if="compactLayout" type="button" :class="{ active: sideTab === 'score' }" @click="sideTab = 'score'">本场积分</button>
          <button type="button" :class="{ active: sideTab === 'events' }" @click="sideTab = 'events'">牌局记录</button>
          <button type="button" :class="{ active: sideTab === 'chat' }" @click="sideTab = 'chat'">聊天</button>
          <button class="drawer-close" type="button" @click="mobileChatOpen = false">×</button>
        </header>
        <ol v-if="sideTab === 'score'" class="ranking drawer-ranking">
          <li v-for="(player, index) in sortedScores" :key="player.id">
            <span class="rank">{{ index + 1 }}</span>
            <strong>{{ player.name }}</strong>
            <small>{{ room.seats[player.id].trustee ? 'AI托管中' : room.seats[player.id].kind === 'ai' ? '房间AI' : room.seats[player.id].connected ? '真人在线' : '真人离线' }}</small>
            <b>{{ player.points === null ? `${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : player.points }}</b>
          </li>
        </ol>
        <div v-else-if="sideTab === 'events'" class="event-list">
          <article v-for="event in [...room.game.events].reverse().slice(0, 24)" :key="event.id"><span>{{ eventTypeLabel[event.type] ?? event.type }}</span><p>{{ event.detail }}</p><small>第{{ event.round }}局</small></article>
        </div>
        <ChatPanel v-else :messages="room.chat" :self-user-id="room.selfUserId" @send="sendChat" />
      </aside>
    </main>

    <div v-if="(room.game.phase === 'settlement' && !nextRoundDismissed) || room.game.phase === 'match-over'" class="result-backdrop">
      <section class="result-card">
        <small>{{ room.game.phase === 'match-over' ? 'MATCH OVER' : 'ROUND RESULT' }}</small>
        <h2>{{ room.game.result?.detail }}</h2>
        <div v-if="room.game.result?.winningTile" class="win-result">
          <div><span>自摸牌</span><b>{{ tileLabel(room.game.result.winningTile) }}</b></div>
          <MahjongTile :tile="room.game.result.winningTile" disabled />
        </div>
        <div v-if="room.game.result?.maTiles.length" class="ma-result">
          <div><span>抓码</span><b>{{ room.game.result.maCount }}码</b></div>
          <MahjongTile v-for="tile in room.game.result.maTiles" :key="tile.id" :tile="tile" disabled />
        </div>
        <ol class="final-scores"><li v-for="player in sortedScores" :key="player.id"><span>{{ player.name }}</span><b>{{ player.points === null ? `净分 ${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : `${player.points}积分` }}</b><small>胡{{ player.stats.wins }} · 杠{{ player.stats.gangCount }} · 码{{ player.stats.maCount }}</small></li></ol>
        <div class="result-actions">
          <template v-if="room.game.phase === 'settlement'">
            <button v-if="room.legal.canQuitRoom" class="quit-button" type="button" @click="quitRoom">退出房间</button>
            <button class="primary" type="button" @click="confirmNextRound">开始下一局</button>
          </template>
          <button v-if="room.game.phase === 'match-over' && room.legal.canReturnToLobby" class="primary" type="button" @click="emit('command', { type: 'return-to-lobby' })">返回房间</button>
        </div>
      </section>
    </div>

    <div v-if="room.game && room.game.phase === 'settlement' && nextRoundDismissed" class="next-round-waiting">
      <span v-if="room.legal.nextRoundWaiting.length">已准备，还在等 {{ room.legal.nextRoundWaiting.join('、') }}</span>
      <span v-else>正在开始下一局…</span>
    </div>

    <transition name="leave-toast">
      <div v-if="leaveToast" class="leave-toast">{{ leaveToast }}</div>
    </transition>

    <AudioControl v-model:open="audioOpen" hide-trigger />
    <DiceToast :state="room.game" />
    <div v-if="mobileChatOpen" class="drawer-mask" @click="mobileChatOpen = false"></div>
  </div>
</template>

<style scoped>
.online-lobby-page { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; padding: clamp(14px, 3vh, 28px) clamp(18px, 6vw, 70px); color: #f5efdd; background: radial-gradient(circle at 15% 0, #24483d, transparent 35%), #091410; }
.lobby-header { width: min(1100px, 100%); margin: auto; display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.lobby-header > button { padding: 9px 12px; border: 1px solid #345047; border-radius: 9px; background: #10251f; color: #d8dfda; cursor: pointer; }
.lobby-room-code { display: grid; text-align: center; }
.lobby-header small { color: #778c85; font-size: 9px; letter-spacing: .2em; }
.lobby-header strong { color: #efd074; font-size: 25px; letter-spacing: .15em; }
.lobby-header > .lobby-header-actions { display: flex; align-items: center; gap: 10px; }
.lobby-header-actions > span, .online-seats i { color: #c97c72; font-size: 10px; font-style: normal; }
.lobby-header-actions > span.online, .online-seats i.online { color: #73c693; }
.lobby-card { width: min(1100px, 100%); margin: 28px auto 0; padding: 26px; border: 1px solid #385248; border-radius: 23px; background: rgba(14,34,29,.94); box-shadow: 0 24px 80px rgba(0,0,0,.3); }
.lobby-heading { display: flex; justify-content: space-between; gap: 20px; }
.share-row { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 11px; }
.share-button { min-height: 40px; padding: 9px 15px; border: 1px solid #b9974a; border-radius: 10px; background: rgba(60, 48, 18, .5); color: #f0d68a; cursor: pointer; font-size: 13px; font-weight: 700; }
.share-button:hover { border-color: #e0c069; }
.share-hint { color: #93a8a0; font-size: 12px; }
.share-hint.ok { color: #7fc79a; }
.share-link { width: min(360px, 100%); margin-top: 8px; padding: 9px 11px; border: 1px solid #35524a; border-radius: 9px; background: #0c1f1a; color: #d9e2dc; font-size: 12px; }
.lobby-heading small { color: #72877f; letter-spacing: .2em; }
.lobby-heading h1 { margin: 3px 0; font-size: 30px; }
.lobby-heading p { color: #82978f; font-size: 12px; }
.lobby-rules { display: flex; flex-wrap: wrap; justify-content: flex-end; align-content: flex-start; gap: 7px; }
.lobby-rules span { padding: 7px 9px; border: 1px solid #355047; border-radius: 99px; color: #d4c18c; font-size: 10px; }
.online-seats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 30px 0; }
.online-seats article { min-height: 190px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; border: 1px dashed #355148; border-radius: 17px; background: #0d241d; }
.online-seats article.self { border-style: solid; border-color: #c4a753; box-shadow: 0 0 0 2px rgba(196,167,83,.1); }
.online-seats article.empty { opacity: .68; }
.seat-avatar { width: 53px; height: 53px; display: grid; place-items: center; border-radius: 17px; background: #24483d; color: #ebce79; font-weight: 900; }
.online-seats article strong { font-size: 14px; }
.online-seats article small { color: #82958f; }
.lobby-card footer { display: flex; align-items: center; justify-content: flex-end; gap: 15px; padding-top: 18px; border-top: 1px solid #2c453d; }
.lobby-card footer p { margin-right: auto; color: #7e938c; font-size: 11px; }
.lobby-card footer button { min-width: 150px; padding: 13px; border: 0; border-radius: 10px; background: #e2c168; color: #20261e; font-weight: 900; cursor: pointer; }
.topbar nav button.trustee { border-color: #bd9c48; color: #f0cf73; }
.topbar nav button.pending { opacity: .78; cursor: wait; }
.room-facts { display: grid; gap: 7px; }
.room-facts span { display: flex; justify-content: space-between; color: #7f948d; font-size: 9px; }
.room-facts b { color: #d9c47e; }
.online-right-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.side-tabs { display: grid; grid-template-columns: 1fr 1fr auto; gap: 4px; margin-bottom: 9px; }
.side-tabs button { padding: 7px 3px; border: 1px solid #2e493f; border-radius: 7px; background: #10261f; color: #81968f; cursor: pointer; font-size: 9px; }
.side-tabs button.active { border-color: #927b3e; color: #edcd71; }
/* 抽屉一打开就得能关掉。原来这个叉号只在竖屏媒体查询里放出来，
   横屏全屏时既点不到叉、外面又没有遮罩可点，只能转屏幕才能退出。 */
.side-tabs .drawer-close { display: none; }
.online-right-panel.mobile-open .side-tabs .drawer-close { display: block; min-width: 34px; }
.chat-fab {
  display: none;
  place-items: center;
  position: absolute;
  z-index: 12;
  right: 2px;
  bottom: calc(100% + 8px);
  width: 42px;
  height: 42px;
  padding: 0;
  border: 1px solid #d1af54;
  border-radius: 50%;
  background: rgba(23, 55, 46, .95);
  color: #f1cf71;
  font-size: 14px;
  font-weight: 900;
  box-shadow: 0 8px 25px rgba(0,0,0,.35);
  cursor: pointer;
}
/* 遮罩跟着抽屉走，横竖屏都有，点一下就能关。颜色比原来淡一档，
   全屏下不至于把整张牌桌盖成一片黑。 */
.drawer-mask { position: fixed; z-index: 31; inset: 0; display: block; background: rgba(0,0,0,.34); }
.mobile-only { display: none; }
.room-code { font-size: 17px; letter-spacing: .12em; color: #f0d68a; font-variant-numeric: tabular-nums; }
.result-actions span { color: #83978f; font-size: 11px; }
.result-actions .waiting-others { color: #d9c489; font-size: 12px; }
/* 退出留在左边，开始下一局推到右下角：两个按钮离得远一点，不容易点错 */
.result-actions .quit-button { margin-right: auto; }
.quit-button { min-height: 42px; padding: 10px 17px; border: 1px solid #8d5049; border-radius: 10px; background: rgba(58, 26, 23, .6); color: #e5a79f; cursor: pointer; font-size: 13px; font-weight: 700; }
.quit-button:hover { border-color: #c2726a; color: #f2bdb5; }
.next-round-waiting { position: fixed; z-index: 33; left: 50%; bottom: max(12px, env(safe-area-inset-bottom)); transform: translateX(-50%); max-width: min(420px, calc(100vw - 24px)); padding: 8px 15px; border: 1px solid #6d5c31; border-radius: 99px; background: rgba(26, 34, 22, .95); color: #ddc68c; font-size: 12px; text-align: center; }
.leave-toast { position: fixed; z-index: 60; top: max(14px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); max-width: min(420px, calc(100vw - 24px)); padding: 11px 18px; border: 1px solid #a8863f; border-radius: 12px; background: rgba(38, 30, 12, .96); color: #f2d9a0; font-size: 13px; font-weight: 700; text-align: center; box-shadow: 0 14px 40px rgba(0,0,0,.45); }
.leave-toast-enter-active, .leave-toast-leave-active { transition: opacity .25s ease, transform .25s ease; }
.leave-toast-enter-from, .leave-toast-leave-to { opacity: 0; transform: translate(-50%, -10px); }
@media (max-width: 800px) {
  .online-seats { grid-template-columns: 1fr 1fr; }
  .lobby-heading { flex-direction: column; }
  .lobby-rules { justify-content: flex-start; }
}
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 700px) {
  .online-lobby-page { padding: max(18px, env(safe-area-inset-top)) 12px max(18px, env(safe-area-inset-bottom)); }
  .lobby-header { flex-wrap: wrap; }
  .lobby-room-code { order: -1; flex-basis: 100%; }
  .lobby-card { padding: 16px; }
  .online-seats { grid-template-columns: 1fr 1fr; gap: 8px; }
  .online-seats article { min-height: 135px; }
  .lobby-card footer { flex-wrap: wrap; }
  .lobby-card footer p { flex-basis: 100%; }
  .lobby-card footer button { width: 100%; }
  /* 聊天只保留右下角这一个入口，顶栏不再重复放一个按钮 */
  /* 原来固定在屏幕上，手牌一多就压住最右边的牌。现在挂在手牌框里、贴着上沿外侧，
     碰杠让手牌框变高时按钮跟着一起走，永远不会压到牌。 */
  /* 圆钮缩小一圈：牌桌是主体，它只是个入口 */
  .chat-fab { display: grid; width: 42px; height: 42px; font-size: 14px; }
  .mobile-only { display: block; }
  .desktop-only { display: none; }
  /* 状态在座位圆环和底部按钮上都有，顶栏这条重复的横幅在竖屏收起来 */
  .status-pill { display: none; }
  .room-code { font-size: 16px; }
  .online-right-panel { display: none; }
  .online-right-panel.mobile-open { position: fixed; z-index: 45; left: 8px; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)); height: min(70dvh, 590px); display: grid; border-color: #715f32; box-shadow: 0 -20px 55px rgba(0,0,0,.5); }


}
</style>
