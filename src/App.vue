<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AdminPanel from '@/components/AdminPanel.vue'
import ModeHome from '@/components/ModeHome.vue'
import AISettingsDrawer from '@/components/game/AISettingsDrawer.vue'
import AudioControl from '@/components/game/AudioControl.vue'
import DiceToast from '@/components/game/DiceToast.vue'
import { RULE_SECTIONS } from '@/game/rules'
import GameSetup from '@/components/game/GameSetup.vue'
import MahjongTable from '@/components/game/MahjongTable.vue'
import MahjongTile from '@/components/game/MahjongTile.vue'
import TopbarMenu from '@/components/game/TopbarMenu.vue'
import OnlineHub from '@/components/online/OnlineHub.vue'
import { gameAudio } from '@/composables/useGameAudio'
import { useImmersiveTable } from '@/composables/useImmersiveTable'
import { useMahjongGame } from '@/composables/useMahjongGame'
import { countFaces, faceKey, tileFromFace, tileLabel } from '@/game/tiles'
import type { Tile } from '@/game/types'
import { checkWin } from '@/game/win'

const game = useMahjongGame()
const { immersive, toggleImmersive } = useImmersiveTable()
// 分享链接只携带公开房间号；身份由同源 HttpOnly Cookie 提供。
function readJoinCode(): string {
  const room = new URLSearchParams(location.search).get('room') ?? ''
  return /^[A-Za-z0-9]{6}$/.test(room) ? room.toUpperCase() : ''
}
const pendingJoinCode = ref(readJoinCode())
const appMode = ref<'home' | 'local' | 'online'>(pendingJoinCode.value ? 'online' : 'home')
// 管理面板不在界面上留任何入口，只能在地址栏加 #admin 打开。
// 真正拦人的是服务器上的管理密钥，这个 hash 只是不想让它出现在正常游玩的路径里。
const adminMode = ref(location.hash === '#admin')
const syncAdminMode = () => { adminMode.value = location.hash === '#admin' }
function syncJoinCode() {
  const code = readJoinCode()
  if (!code) return
  pendingJoinCode.value = code
  appMode.value = 'online'
}
window.addEventListener('hashchange', syncAdminMode)
window.addEventListener('popstate', syncJoinCode)
const selectedTileId = ref('')
const settingsOpen = ref(false)
const rulesOpen = ref(false)
// 手机端积分和牌局记录收进抽屉，牌桌才占得满一屏
const infoOpen = ref(false)
const infoTab = ref<'score' | 'flow' | 'log'>('score')
// 声音弹层的开关放在页面上：挂在菜单里的话，菜单一收起组件就卸载了
const audioOpen = ref(false)
// 退出／重开／结束共用一个居中确认框，联机那边是同一套 .confirm-* 类名。
type ConfirmAction = { title: string; hint: string; confirmText: string; run: () => void }
const confirmAction = ref<ConfirmAction | null>(null)

function askConfirm(action: ConfirmAction) {
  confirmAction.value = action
  gameAudio.vibrate(10)
}

function runConfirm() {
  const action = confirmAction.value
  confirmAction.value = null
  if (!action) return
  gameAudio.vibrate([24, 42, 48])
  action.run()
}

function requestExit() {
  askConfirm({
    title: '退出这局牌？',
    hint: '本局进度不会保留，回到首页后要重新开一局。',
    confirmText: '结束并退出',
    run: () => {
      game.abandonMatch()
      appMode.value = 'home'
    },
  })
}

function returnHomeAfterMatch() {
  game.abandonMatch()
  appMode.value = 'home'
}
// 手机上（横竖屏都算）这两块面板不常驻，点「战况」才出来，牌桌才占得满。
// 条件和 main.css 里那两条手机端媒体查询保持一致。
const compactLayout = ref(false)
let compactQuery: MediaQueryList | null = null
function syncCompact(event: MediaQueryList | MediaQueryListEvent) {
  compactLayout.value = event.matches
  if (!event.matches) infoOpen.value = false
}
onMounted(() => {
  compactQuery = window.matchMedia('(pointer: coarse), (max-width: 820px) and (orientation: portrait), (max-height: 620px) and (orientation: landscape)')
  syncCompact(compactQuery)
  compactQuery.addEventListener('change', syncCompact)
})
onBeforeUnmount(() => compactQuery?.removeEventListener('change', syncCompact))
const showSidePanels = computed(() => !compactLayout.value)
const clock = ref(Date.now())
let clockTimer: number | null = null

// 只有抢牌倒计时在跑时才需要刷新时钟，否则常驻的 100ms 定时器会让整桌牌一直重绘。
function syncTicking() {
  clock.value = Date.now()
  const needsTicking = game.claimDeadline.value !== null && !document.hidden
  if (!needsTicking) {
    if (clockTimer !== null) window.clearInterval(clockTimer)
    clockTimer = null
    return
  }
  if (clockTimer === null) clockTimer = window.setInterval(() => { clock.value = Date.now() }, 100)
}

watch(() => game.claimDeadline.value, syncTicking, { immediate: true })
document.addEventListener('visibilitychange', syncTicking)

onBeforeUnmount(() => {
  if (clockTimer !== null) window.clearInterval(clockTimer)
  document.removeEventListener('visibilitychange', syncTicking)
  window.removeEventListener('hashchange', syncAdminMode)
  window.removeEventListener('popstate', syncJoinCode)
})

const human = computed(() => game.humanPlayer.value)
const humanId = computed(() => human.value?.id ?? 0)
const isAfterDraw = computed(() => game.state.value?.turnStage === 'after-draw')
const canHumanWin = computed(() => !!human.value && !!game.state.value && game.isHumanTurn.value && isAfterDraw.value && checkWin(human.value.hand, human.value.melds).won)
const anGangFaces = computed(() => {
  if (!human.value || !game.state.value || game.state.value.wall.length === 0 || !game.isHumanTurn.value || !isAfterDraw.value) return []
  return [...countFaces(human.value.hand).entries()].filter(([face, count]) => face !== 'zhong' && count === 4).map(([face]) => face)
})
// 补杠不要求刚摸完牌：碰完手上还留着第四张时，可以直接杠。
const buGangFaces = computed(() => {
  if (!human.value || !game.state.value || game.state.value.wall.length === 0 || !game.isHumanTurn.value) return []
  const faces = countFaces(human.value.hand)
  return human.value.melds.filter((meld) => meld.type === 'peng').map((meld) => faceKey(meld.tiles[0])).filter((face) => (faces.get(face) ?? 0) > 0)
})
const selectedTile = computed(() => human.value?.hand.find((tile) => tile.id === selectedTileId.value) ?? null)
const claimSeconds = computed(() => game.claimDeadline.value ? Math.max(0, (game.claimDeadline.value - clock.value) / 1000).toFixed(1) : '')
const claimProgress = computed(() => {
  if (!game.claimDeadline.value || !game.state.value) return 0
  const remaining = Math.max(0, game.claimDeadline.value - clock.value)
  return Math.min(100, (remaining / game.state.value.config.claimWindowMs) * 100)
})
const playerNotice = computed(() => (game.busy.value || game.state.value?.phase === 'claiming') ? '' : game.notice.value)
const showActionDock = computed(() => !!game.state.value && (
  (game.state.value.phase === 'claiming' && !!game.humanClaimOption.value)
  || (game.state.value.phase === 'playing' && game.isHumanTurn.value)
))
const recentTransfers = computed(() => {
  if (!game.state.value) return []
  return game.state.value.transfers.filter((transfer) => transfer.round === game.state.value!.round).slice(-8).reverse()
})
const sortedRanking = computed(() => {
  if (!game.state.value) return []
  return [...game.state.value.players].sort((a, b) => (b.points ?? b.stats.netPoints) - (a.points ?? a.stats.netPoints))
})

watch(() => game.state.value?.currentPlayer, () => { selectedTileId.value = '' })
watch(() => game.isHumanTurn.value && game.state.value?.phase === 'playing', (isMyTurn, wasMyTurn) => {
  if (isMyTurn && !wasMyTurn) gameAudio.turnFeedback()
})
watch(() => !!game.humanClaimOption.value, (available, previous) => {
  if (available && !previous) gameAudio.vibrate([18, 38, 24])
})
let lastClaimCountdownSecond = 0
watch(claimSeconds, (value) => {
  const second = Math.ceil(Number(value))
  if (second >= 1 && second <= 3 && second !== lastClaimCountdownSecond) gameAudio.countdownFeedback()
  lastClaimCountdownSecond = second
})
function selectTile(tile: Tile) {
  gameAudio.vibrate(selectedTileId.value === tile.id ? 7 : 11)
  selectedTileId.value = selectedTileId.value === tile.id ? '' : tile.id
}

function passClaim() {
  gameAudio.vibrate(10)
  game.humanPassClaim()
}

function discardSelected() {
  if (!selectedTile.value) return
  game.humanDiscard(selectedTile.value.id)
  selectedTileId.value = ''
}

function newMatch() {
  askConfirm({ title: '重开一局？', hint: '当前这局的进度不会保留。', confirmText: '重开', run: game.abandonMatch })
}

function endMatch() {
  askConfirm({ title: '结束本场？', hint: '直接跳到本场结算，看四家的最终积分。', confirmText: '结束本场', run: game.endMatch })
}

const transferReason: Record<string, string> = {
  'self-draw': '自摸', ma: '抓码', 'an-gang': '暗杠', 'bu-gang': '补杠', 'ming-gang': '明杠',
}
const eventTypeLabel: Record<string, string> = {
  'match-start': '整场开始', dice: '投骰', 'round-start': '本局开始', draw: '摸牌',
  discard: '出牌', peng: '碰', 'ming-gang': '明杠', 'an-gang': '暗杠',
  'bu-gang': '补杠', 'claim-pass': '过', win: '胡牌', 'draw-game': '流局',
  'match-over': '整场结束', 'ai-change': 'AI调整',
}
const difficultyLabel = { beginner: '菜鸡', standard: '凡人', expert: '猿神' } as const
</script>

<template>
  <AdminPanel v-if="adminMode" />

  <ModeHome v-else-if="appMode === 'home'" @local="appMode = 'local'" @online="appMode = 'online'" />

  <OnlineHub
    v-else-if="appMode === 'online'"
    :join-code="pendingJoinCode"
    @back="appMode = 'home'"
    @join-consumed="pendingJoinCode = ''"
  />

  <template v-else>
  <GameSetup
    v-if="!game.state.value"
    @start="game.startMatch"
    @rules="rulesOpen = true"
    @back="appMode = 'home'"
  />

  <!-- iOS 只允许在用户手势里恢复音频，所以牌桌上任何一次触摸都顺带解锁一次 -->
  <div v-else class="game-page" :class="{ immersive, 'info-open': infoOpen }" @pointerdown.capture="gameAudio.unlock">
    <header class="topbar">
      <div class="brand desktop-only"><span>中</span><div><strong>红中麻将</strong></div></div>
      <!-- 手机端顶栏就是信息栏：局数挪上来，中央位置全让给弃牌区 -->
      <div class="round-bar mobile-only">
        <button class="round-back" type="button" aria-label="返回" @click="requestExit">‹</button>
        <span>第 <b>{{ game.state.value.round }}</b> 局</span>
        <span>牌墙 <b>{{ game.state.value.wall.length }}</b></span>
        <span>码区 <b>{{ game.state.value.maReserve.length }}</b></span>
      </div>
      <div class="status-pill" :class="game.state.value.phase">{{ playerNotice || game.state.value.events.at(-1)?.detail }}</div>
      <nav>
        <button class="desktop-only" @click="rulesOpen = true">规则</button>
        <button class="mobile-only" @click="infoOpen = true">积分</button>
        <button class="desktop-only" @click="settingsOpen = true">AI设置</button>
        <AudioControl class="desktop-only" />
        <button class="desktop-only" @click="endMatch">结束</button>
        <button class="danger desktop-only" @click="newMatch">新牌局</button>
        <!-- 竖屏顶栏只留「AI设置」，其余七个按钮收进菜单 -->
        <TopbarMenu class="mobile-only">
          <button @click="audioOpen = true"><b>声音</b><span>音效设置 ›</span></button>
          <button @click="settingsOpen = true"><b>AI 档位</b><span>对局中可改 ›</span></button>
          <button @click="rulesOpen = true"><b>玩法规则</b><span>›</span></button>
          <button class="danger" @click="requestExit"><b>退出牌局</b><span>›</span></button>
        </TopbarMenu>
      </nav>
    </header>

    <main class="game-layout">
      <aside v-if="showSidePanels" class="side-panel score-panel">
        <section>
          <div class="section-title">积分排名</div>
          <ol class="ranking">
            <li v-for="(player, index) in sortedRanking" :key="player.id">
              <span class="rank">{{ index + 1 }}</span>
              <div><strong>{{ player.name }}</strong><small>{{ player.isHuman || !player.ai ? '真人' : `AI · ${difficultyLabel[player.ai.difficulty]}` }}</small></div>
              <b>{{ player.points === null ? `${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : player.points }}</b>
            </li>
          </ol>
        </section>
        <section>
          <div class="section-title">投骰结果</div>
          <div class="dice-list">
            <div v-for="roll in game.state.value.diceRolls" :key="roll.playerId" :class="{ dealer: roll.playerId === game.state.value.dealer && game.state.value.round === 1 }">
              <span>{{ game.state.value.players[roll.playerId].name }}</span><i>{{ roll.dice[0] }}</i><i>{{ roll.dice[1] }}</i><b>{{ roll.total }}</b>
            </div>
          </div>
        </section>
        <section>
          <div class="section-title">本局积分流水</div>
          <div v-if="recentTransfers.length" class="transfer-list">
            <div v-for="transfer in recentTransfers" :key="transfer.id">
              <span>{{ game.state.value.players[transfer.fromPlayer].name }}</span><em>-{{ transfer.paid }}</em><small>{{ transferReason[transfer.reason] }}</small><span>{{ game.state.value.players[transfer.toPlayer].name }}</span>
            </div>
          </div>
          <p v-else class="empty">本局暂无积分变化</p>
        </section>
      </aside>

      <section class="table-column">
        <MahjongTable
          :state="game.state.value"
          :human-id="humanId"
          :selected-tile-id="selectedTileId"
          :reveal-all="game.state.value.phase === 'settlement' || game.state.value.phase === 'match-over'"
          fullscreen-toggle
          :immersive="immersive"
          @select-tile="selectTile"
          @toggle-immersive="toggleImmersive"
        />
        <div v-if="playerNotice" class="mobile-table-notice mobile-only">{{ playerNotice }}</div>
        <div v-if="showActionDock" class="action-dock">
          <template v-if="game.state.value.phase === 'claiming' && game.humanClaimOption.value">
            <div class="claim-clock"><b>{{ claimSeconds }}</b><span>秒内响应</span><i><em :style="{ width: `${claimProgress}%` }"></em></i></div>
            <button v-if="game.humanClaimOption.value.actions.includes('peng')" class="gold" @click="game.humanClaim('peng')">碰</button>
            <button v-if="game.humanClaimOption.value.actions.includes('ming-gang')" class="red" @click="game.humanClaim('ming-gang')">杠</button>
            <button @click="passClaim">过</button>
          </template>
          <template v-else-if="game.isHumanTurn.value && game.state.value.phase === 'playing'">
            <button v-if="canHumanWin" class="red" @click="game.humanWin">自摸</button>
            <button v-for="face in anGangFaces" :key="`an-${face}`" class="gold" @click="game.humanGang('an-gang', face)">暗杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button v-for="face in buGangFaces" :key="`bu-${face}`" class="gold" @click="game.humanGang('bu-gang', face)">补杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button class="discard-button" :disabled="!selectedTile" @click="discardSelected">{{ selectedTile ? `打出 ${tileLabel(selectedTile)}` : '选一张牌' }}</button>
          </template>
        </div>
      </section>

      <aside v-if="showSidePanels" class="side-panel event-panel">
        <div class="section-title">牌局记录</div>
        <div class="event-list">
          <article v-for="event in [...game.state.value.events].reverse().slice(0, 24)" :key="event.id">
            <span>{{ eventTypeLabel[event.type] ?? event.type }}</span><p>{{ event.detail }}</p><small>第{{ event.round }}局</small>
          </article>
        </div>
      </aside>
    </main>

    <div v-if="infoOpen" class="info-mask" @click="infoOpen = false"></div>
    <aside v-if="infoOpen && compactLayout" class="mobile-info-panel" aria-label="牌局信息">
      <header class="mobile-info-tabs">
        <button :class="{ active: infoTab === 'score' }" @click="infoTab = 'score'">积分排名</button>
        <button :class="{ active: infoTab === 'flow' }" @click="infoTab = 'flow'">本局流水</button>
        <button :class="{ active: infoTab === 'log' }" @click="infoTab = 'log'">牌局记录</button>
        <button class="mobile-info-close" aria-label="关闭" @click="infoOpen = false">×</button>
      </header>
      <div class="mobile-info-body">
        <ol v-if="infoTab === 'score'" class="mobile-ranking">
          <li v-for="(player, index) in sortedRanking" :key="player.id">
            <span>{{ index + 1 }}</span>
            <div><strong>{{ player.name }}</strong><small>胡{{ player.stats.wins }} · 杠{{ player.stats.gangCount }} · 码{{ player.stats.maCount }}</small></div>
            <b>{{ player.points === null ? `${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : `${player.points}分` }}</b>
          </li>
        </ol>
        <div v-else-if="infoTab === 'flow'" class="mobile-flow-list">
          <article v-for="transfer in recentTransfers" :key="transfer.id">
            <b>{{ transferReason[transfer.reason] }}</b>
            <span>{{ game.state.value.players[transfer.fromPlayer].name }} → {{ game.state.value.players[transfer.toPlayer].name }}</span>
            <em>-{{ transfer.paid }}</em>
          </article>
          <p v-if="!recentTransfers.length" class="empty">本局暂无积分变化</p>
        </div>
        <div v-else class="mobile-log-list">
          <article v-for="event in [...game.state.value.events].reverse().slice(0, 30)" :key="event.id">
            <small>第{{ event.round }}局</small><span>{{ event.detail }}</span>
          </article>
        </div>
      </div>
    </aside>
    <div v-if="game.error.value" class="error-toast" @click="game.error.value = ''">{{ game.error.value }} ×</div>
    <AudioControl v-model:open="audioOpen" hide-trigger />
    <DiceToast :state="game.state.value" />

    <div v-if="confirmAction" class="confirm-backdrop" @click.self="confirmAction = null">
      <section class="confirm-card" role="dialog" aria-modal="true" :aria-label="confirmAction.title">
        <h2>{{ confirmAction.title }}</h2>
        <p>{{ confirmAction.hint }}</p>
        <div class="confirm-actions">
          <button class="cancel" type="button" @click="confirmAction = null">取消</button>
          <button class="danger" type="button" @click="runConfirm">{{ confirmAction.confirmText }}</button>
        </div>
      </section>
    </div>

    <div v-if="game.state.value.phase === 'settlement' || game.state.value.phase === 'match-over'" class="result-backdrop">
      <section class="result-card">
        <h2>{{ game.state.value.result?.detail }}</h2>
        <div v-if="game.state.value.result?.winningTile" class="win-result">
          <div><span>自摸牌</span><b>{{ tileLabel(game.state.value.result.winningTile) }}</b></div>
          <MahjongTile :tile="game.state.value.result.winningTile" disabled />
        </div>
        <div v-if="game.state.value.result?.maTiles.length" class="ma-result">
          <div><span>抓码</span><b>{{ game.state.value.result.maCount }}码</b></div>
          <MahjongTile v-for="tile in game.state.value.result.maTiles" :key="tile.id" :tile="tile" disabled />
        </div>
        <ol class="final-scores">
          <li v-for="player in sortedRanking" :key="player.id"><span>{{ player.name }}</span><b>{{ player.points === null ? `净分 ${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : `${player.points}积分` }}</b><small>胡{{ player.stats.wins }} · 杠{{ player.stats.gangCount }} · 码{{ player.stats.maCount }}</small></li>
        </ol>
        <div class="result-actions">
          <button v-if="game.state.value.phase === 'settlement'" class="primary" @click="game.nextRound">{{ game.state.value.result?.type === 'draw' ? '下一局（流局留庄）' : '下一局（赢家坐庄）' }}</button>
          <button v-else class="primary" @click="returnHomeAfterMatch">返回首页</button>
        </div>
      </section>
    </div>

    <AISettingsDrawer :open="settingsOpen" :players="game.state.value.players" @close="settingsOpen = false" @change="game.updateAI" />
  </div>

  <div v-if="rulesOpen" class="rules-backdrop" @click.self="rulesOpen = false">
    <section class="rules-card">
      <header><button class="rules-back" aria-label="返回" @click="rulesOpen = false">‹</button><h2>玩法规则</h2></header>
      <div class="rules-body">
        <section v-for="section in RULE_SECTIONS" :key="section.group" class="rule-group">
          <h3>{{ section.group }}</h3>
          <article v-for="item in section.items" :key="item.title">
            <b>{{ item.title }}</b>
            <p>{{ item.text }}</p>
          </article>
        </section>
      </div>
    </section>
  </div>
  </template>
</template>
