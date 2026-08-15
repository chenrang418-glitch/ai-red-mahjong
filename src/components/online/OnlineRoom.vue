<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AudioControl from '@/components/game/AudioControl.vue'
import MahjongTable from '@/components/game/MahjongTable.vue'
import MahjongTile from '@/components/game/MahjongTile.vue'
import ChatPanel from './ChatPanel.vue'
import { gameAudio } from '@/composables/useGameAudio'
import { tileFromFace, tileLabel } from '@/game/tiles'
import type { Tile } from '@/game/types'
import type { OnlineRoomView, RoomActionDraft, RoomCommand } from '@/online/types'

const props = defineProps<{ room: OnlineRoomView; connected: boolean }>()
const emit = defineEmits<{ command: [command: RoomCommand]; leave: [] }>()
const selectedTileId = ref('')
const sideTab = ref<'events' | 'chat'>('events')
const mobileChatOpen = ref(false)
const clock = ref(Date.now())
const clockTimer = window.setInterval(() => { clock.value = Date.now() }, 100)
let audioMatchId = ''

onBeforeUnmount(() => {
  window.clearInterval(clockTimer)
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
const selectedTile = computed(() => human.value?.hand.find((tile) => tile.id === selectedTileId.value) ?? null)
const sortedScores = computed(() => props.room.game ? [...props.room.game.players].sort((left, right) => (right.points ?? right.stats.netPoints) - (left.points ?? left.stats.netPoints)) : [])
const claimSeconds = computed(() => props.room.deadlineAt ? Math.max(0, (props.room.deadlineAt - clock.value) / 1000).toFixed(1) : '')
const claimProgress = computed(() => {
  if (!props.room.deadlineAt || !props.room.game) return 0
  const remaining = Math.max(0, props.room.deadlineAt - clock.value)
  return Math.min(100, (remaining / props.room.game.config.claimWindowMs) * 100)
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
  if (window.confirm('离开房间后，断线超过30秒将由AI托管。确定离开吗？')) emit('leave')
}

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
        <div><small>ONLINE ROOM</small><h1>等待开局</h1><p>把房间号分享给其他玩家；开局时空位会自动补充凡人 AI。</p></div>
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

  <div v-else-if="room.game" class="game-page online-game-page" @pointerdown.capture="gameAudio.unlock">
    <header class="topbar">
      <div class="brand"><span>中</span><div><strong>联机红中麻将</strong><small>房间 {{ room.code }}</small></div></div>
      <div class="status-pill" :class="room.game.phase">{{ connected ? room.notice : '连接中断，正在重连…' }}</div>
      <nav>
        <button type="button" :class="{ trustee: selfSeat.trustee }" @click="emit('command', { type: 'trustee', enabled: !selfSeat.trustee })">{{ selfSeat.trustee ? '取消托管' : 'AI托管' }}</button>
        <AudioControl />
        <button class="mobile-chat-button" type="button" @click="mobileChatOpen = true">聊天</button>
        <button class="danger" type="button" @click="leave">退出房间</button>
      </nav>
    </header>

    <main class="game-layout">
      <aside class="side-panel score-panel">
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
          :state="room.game"
          :human-id="room.selfSeatId"
          :selected-tile-id="selectedTileId"
          :readonly="!room.legal.canDiscard"
          :reveal-all="room.game.phase === 'settlement' || room.game.phase === 'match-over'"
          @select-tile="selectTile"
        />
        <div class="action-dock">
          <template v-if="selfSeat.trustee">
            <span class="waiting-dot"></span><span>AI 正在以真人波动型 · 凡人 · 猴急托管</span><button type="button" @click="emit('command', { type: 'trustee', enabled: false })">取消托管</button>
          </template>
          <template v-else-if="room.legal.claimActions.length">
            <div class="claim-clock"><b>{{ claimSeconds }}</b><span>秒内响应</span><i><em :style="{ width: `${claimProgress}%` }"></em></i></div>
            <button v-if="room.legal.claimActions.includes('peng')" class="gold" type="button" @click="action({ type: 'claim', action: 'peng' })">碰</button>
            <button v-if="room.legal.claimActions.includes('ming-gang')" class="red" type="button" @click="action({ type: 'claim', action: 'ming-gang' })">杠</button>
            <button type="button" @click="action({ type: 'pass-claim' })">过</button>
          </template>
          <template v-else-if="room.legal.canDiscard">
            <button v-if="room.legal.canWin" class="red" type="button" @click="action({ type: 'win' })">自摸</button>
            <button v-for="face in room.legal.anGangFaces" :key="`an-${face}`" class="gold" type="button" @click="action({ type: 'gang', gangType: 'an-gang', face })">暗杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button v-for="face in room.legal.buGangFaces" :key="`bu-${face}`" class="gold" type="button" @click="action({ type: 'gang', gangType: 'bu-gang', face })">补杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button class="discard-button" type="button" :disabled="!selectedTile" @click="discardSelected">{{ selectedTile ? `打出 ${tileLabel(selectedTile)}` : '请先选择一张手牌' }}</button>
          </template>
          <template v-else><span class="waiting-dot"></span><span>{{ room.notice }}</span></template>
        </div>
      </section>

      <aside class="side-panel event-panel online-right-panel" :class="{ 'mobile-open': mobileChatOpen }">
        <header class="side-tabs">
          <button type="button" :class="{ active: sideTab === 'events' }" @click="sideTab = 'events'">牌局记录</button>
          <button type="button" :class="{ active: sideTab === 'chat' }" @click="sideTab = 'chat'">聊天</button>
          <button class="drawer-close" type="button" @click="mobileChatOpen = false">×</button>
        </header>
        <div v-if="sideTab === 'events'" class="event-list">
          <article v-for="event in [...room.game.events].reverse().slice(0, 24)" :key="event.id"><span>{{ eventTypeLabel[event.type] ?? event.type }}</span><p>{{ event.detail }}</p><small>第{{ event.round }}局</small></article>
        </div>
        <ChatPanel v-else :messages="room.chat" :self-user-id="room.selfUserId" @send="sendChat" />
      </aside>
    </main>

    <div v-if="room.game.phase === 'settlement' || room.game.phase === 'match-over'" class="result-backdrop">
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
          <button v-if="room.game.phase === 'settlement' && room.legal.canNextRound" class="primary" type="button" @click="emit('command', { type: 'next-round' })">开始下一局</button>
          <span v-else-if="room.game.phase === 'settlement'">等待房主开始下一局</span>
          <button v-if="room.game.phase === 'match-over' && room.legal.canReturnToLobby" class="primary" type="button" @click="emit('command', { type: 'return-to-lobby' })">返回房间</button>
        </div>
      </section>
    </div>

    <button class="chat-fab" type="button" @click="mobileChatOpen = true; sideTab = 'chat'">聊</button>
    <div v-if="mobileChatOpen" class="drawer-mask" @click="mobileChatOpen = false"></div>
  </div>
</template>

<style scoped>
.online-lobby-page { min-height: 100vh; min-height: 100dvh; padding: 28px clamp(18px, 6vw, 70px); color: #f5efdd; background: radial-gradient(circle at 15% 0, #24483d, transparent 35%), #091410; }
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
.room-facts { display: grid; gap: 7px; }
.room-facts span { display: flex; justify-content: space-between; color: #7f948d; font-size: 9px; }
.room-facts b { color: #d9c47e; }
.online-right-panel { display: grid; grid-template-rows: auto minmax(0, 1fr); }
.side-tabs { display: grid; grid-template-columns: 1fr 1fr auto; gap: 4px; margin-bottom: 9px; }
.side-tabs button { padding: 7px 3px; border: 1px solid #2e493f; border-radius: 7px; background: #10261f; color: #81968f; cursor: pointer; font-size: 9px; }
.side-tabs button.active { border-color: #927b3e; color: #edcd71; }
.side-tabs .drawer-close { display: none; }
.mobile-chat-button, .chat-fab, .drawer-mask { display: none; }
.result-actions span { color: #83978f; font-size: 11px; }
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
  .mobile-chat-button, .chat-fab { display: block; }
  .chat-fab { position: fixed; z-index: 32; right: max(12px, env(safe-area-inset-right)); bottom: calc(78px + env(safe-area-inset-bottom)); width: 46px; height: 46px; border: 1px solid #d1af54; border-radius: 50%; background: #17372e; color: #f1cf71; font-weight: 900; box-shadow: 0 8px 25px rgba(0,0,0,.35); }
  .online-right-panel { display: none; }
  .online-right-panel.mobile-open { position: fixed; z-index: 45; left: 8px; right: 8px; bottom: max(8px, env(safe-area-inset-bottom)); height: min(70dvh, 590px); display: grid; border-color: #715f32; box-shadow: 0 -20px 55px rgba(0,0,0,.5); }
  .online-right-panel.mobile-open .side-tabs .drawer-close { display: block; }
  .drawer-mask { position: fixed; z-index: 44; inset: 0; display: block; background: rgba(0,0,0,.58); }
}
</style>
