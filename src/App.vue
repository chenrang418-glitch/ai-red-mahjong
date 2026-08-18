<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AdminPanel from '@/components/AdminPanel.vue'
import ModeHome from '@/components/ModeHome.vue'
import AISettingsDrawer from '@/components/game/AISettingsDrawer.vue'
import AudioControl from '@/components/game/AudioControl.vue'
import GameSetup from '@/components/game/GameSetup.vue'
import MahjongTable from '@/components/game/MahjongTable.vue'
import MahjongTile from '@/components/game/MahjongTile.vue'
import ReplayCenter from '@/components/game/ReplayCenter.vue'
import TopbarMenu from '@/components/game/TopbarMenu.vue'
import OnlineHub from '@/components/online/OnlineHub.vue'
import { gameAudio } from '@/composables/useGameAudio'
import { useImmersiveTable } from '@/composables/useImmersiveTable'
import { useMahjongGame } from '@/composables/useMahjongGame'
import { downloadJson } from '@/game/persistence'
import { countFaces, faceKey, tileFromFace, tileLabel } from '@/game/tiles'
import type { Tile } from '@/game/types'
import { checkWin } from '@/game/win'

const game = useMahjongGame()
const { immersive, toggleImmersive } = useImmersiveTable()
// 分享链接：#join=ABC123 直接进联机大厅并自动进这个房间。
// 用 hash 而不是查询参数，Pages 那边不用额外配路由回退。
function readJoinCode(): string {
  const match = location.hash.match(/^#join=([A-Za-z0-9]{6})$/)
  return match ? match[1].toUpperCase() : ''
}
const pendingJoinCode = ref(readJoinCode())
const appMode = ref<'home' | 'local' | 'online'>(pendingJoinCode.value ? 'online' : 'home')
// 管理面板不在界面上留任何入口，只能在地址栏加 #admin 打开。
// 真正拦人的是服务器上的管理密钥，这个 hash 只是不想让它出现在正常游玩的路径里。
const adminMode = ref(location.hash === '#admin')
const syncAdminMode = () => { adminMode.value = location.hash === '#admin' }
// 别人把链接发过来时页面可能已经开着，所以 hash 变化也要认
function syncJoinCode() {
  const code = readJoinCode()
  if (!code) return
  pendingJoinCode.value = code
  appMode.value = 'online'
}
window.addEventListener('hashchange', syncAdminMode)
window.addEventListener('hashchange', syncJoinCode)
const selectedTileId = ref('')
const settingsOpen = ref(false)
const replayOpen = ref(false)
const rulesOpen = ref(false)
const diceOpen = ref(false)
const clock = ref(Date.now())
let clockTimer: number | null = null
let diceTimer: number | null = null

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
  window.removeEventListener('hashchange', syncJoinCode)
  if (diceTimer !== null) window.clearTimeout(diceTimer)
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
const recentTransfers = computed(() => {
  if (!game.state.value) return []
  return game.state.value.transfers.filter((transfer) => transfer.round === game.state.value!.round).slice(-8).reverse()
})
const sortedRanking = computed(() => {
  if (!game.state.value) return []
  return [...game.state.value.players].sort((a, b) => (b.points ?? b.stats.netPoints) - (a.points ?? a.stats.netPoints))
})

watch(() => game.state.value?.currentPlayer, () => { selectedTileId.value = '' })
watch(() => game.state.value?.matchId, (current, previous) => {
  if (!current || current === previous) return
  diceOpen.value = true
  if (diceTimer !== null) window.clearTimeout(diceTimer)
  diceTimer = window.setTimeout(() => { diceOpen.value = false }, 2600)
})

function selectTile(tile: Tile) {
  selectedTileId.value = selectedTileId.value === tile.id ? '' : tile.id
}

function discardSelected() {
  if (!selectedTile.value) return
  game.humanDiscard(selectedTile.value.id)
  selectedTileId.value = ''
}

function newMatch() {
  if (window.confirm('结束并清除当前未完成牌局，返回开局设置？')) game.abandonMatch()
}

function endMatch() {
  if (window.confirm('确定结束整场牌局并保存当前牌谱？')) game.endMatch()
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
    :saved-game-available="game.savedGameAvailable.value"
    @start="game.startMatch"
    @resume="game.resumeMatch"
    @history="replayOpen = true"
    @rules="rulesOpen = true"
    @back="appMode = 'home'"
  />

  <!-- iOS 只允许在用户手势里恢复音频，所以牌桌上任何一次触摸都顺带解锁一次 -->
  <div v-else class="game-page" :class="{ immersive }" @pointerdown.capture="gameAudio.unlock">
    <header class="topbar">
      <div class="brand"><span>中</span><div><strong>AI 红中麻将</strong><small>本地离线版</small></div></div>
      <div class="status-pill" :class="game.state.value.phase">{{ game.notice.value || game.state.value.events.at(-1)?.detail }}</div>
      <nav>
        <button class="desktop-only" @click="rulesOpen = true">规则</button>
        <button class="desktop-only" @click="replayOpen = true">牌谱</button>
        <button @click="settingsOpen = true">AI设置</button>
        <AudioControl class="desktop-only" />
        <button class="desktop-only" @click="downloadJson(`红中麻将-${game.state.value.matchId}.json`, game.state.value)">导出</button>
        <button class="desktop-only" @click="endMatch">结束</button>
        <button class="danger desktop-only" @click="newMatch">新牌局</button>
        <!-- 竖屏顶栏只留「AI设置」，其余七个按钮收进菜单 -->
        <TopbarMenu class="mobile-only">
          <AudioControl />
          <button @click="rulesOpen = true">玩法规则</button>
          <button @click="replayOpen = true">牌谱回放</button>
          <button @click="downloadJson(`红中麻将-${game.state.value.matchId}.json`, game.state.value)">导出牌局</button>
          <button @click="endMatch">结束整场</button>
          <button class="danger" @click="newMatch">新牌局</button>
        </TopbarMenu>
      </nav>
    </header>

    <main class="game-layout">
      <aside class="side-panel score-panel">
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
        <div class="action-dock">
          <template v-if="game.state.value.phase === 'claiming' && game.humanClaimOption.value">
            <div class="claim-clock"><b>{{ claimSeconds }}</b><span>秒内响应</span><i><em :style="{ width: `${claimProgress}%` }"></em></i></div>
            <button v-if="game.humanClaimOption.value.actions.includes('peng')" class="gold" @click="game.humanClaim('peng')">碰</button>
            <button v-if="game.humanClaimOption.value.actions.includes('ming-gang')" class="red" @click="game.humanClaim('ming-gang')">杠</button>
            <button @click="game.humanPassClaim">过</button>
          </template>
          <template v-else-if="game.isHumanTurn.value && game.state.value.phase === 'playing'">
            <button v-if="canHumanWin" class="red" @click="game.humanWin">自摸</button>
            <button v-for="face in anGangFaces" :key="`an-${face}`" class="gold" @click="game.humanGang('an-gang', face)">暗杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button v-for="face in buGangFaces" :key="`bu-${face}`" class="gold" @click="game.humanGang('bu-gang', face)">补杠 {{ tileLabel(tileFromFace(face)) }}</button>
            <button class="discard-button" :disabled="!selectedTile" @click="discardSelected">{{ selectedTile ? `打出 ${tileLabel(selectedTile)}` : '出牌' }}</button>
          </template>
          <template v-else>
            <span class="waiting-dot"></span><span>{{ game.busy.value ? 'AI正在本地计算' : game.notice.value }}</span>
          </template>
        </div>
      </section>

      <aside class="side-panel event-panel">
        <div class="section-title">牌局记录</div>
        <div class="event-list">
          <article v-for="event in [...game.state.value.events].reverse().slice(0, 24)" :key="event.id">
            <span>{{ eventTypeLabel[event.type] ?? event.type }}</span><p>{{ event.detail }}</p><small>第{{ event.round }}局</small>
          </article>
        </div>
      </aside>
    </main>

    <div v-if="game.error.value" class="error-toast" @click="game.error.value = ''">{{ game.error.value }} ×</div>
    <div v-if="diceOpen" class="dice-toast">
      <small>开局投骰</small><div><span v-for="roll in game.state.value.diceRolls" :key="roll.playerId"><b>{{ game.state.value.players[roll.playerId].name }}</b>{{ roll.dice[0] }} + {{ roll.dice[1] }} = {{ roll.total }}</span></div><strong>{{ game.state.value.players[game.state.value.dealer].name }} 首庄</strong>
    </div>

    <div v-if="game.state.value.phase === 'settlement' || game.state.value.phase === 'match-over'" class="result-backdrop">
      <section class="result-card">
        <small>{{ game.state.value.phase === 'match-over' ? 'MATCH OVER' : 'ROUND RESULT' }}</small>
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
          <button @click="replayOpen = true">查看牌谱</button>
          <button v-if="game.state.value.phase === 'settlement'" class="primary" @click="game.nextRound">{{ game.state.value.result?.type === 'draw' ? '下一局（流局留庄）' : '下一局（赢家坐庄）' }}</button>
          <button v-else class="primary" @click="game.abandonMatch">返回开局</button>
        </div>
      </section>
    </div>

    <AISettingsDrawer :open="settingsOpen" :players="game.state.value.players" @close="settingsOpen = false" @change="game.updateAI" />
  </div>

  <ReplayCenter :open="replayOpen" @close="replayOpen = false" />

  <div v-if="rulesOpen" class="rules-backdrop" @click.self="rulesOpen = false">
    <section class="rules-card">
      <header><h2>红中麻将规则</h2><button @click="rulesOpen = false">×</button></header>
      <div class="rules-grid">
        <article><b>胡牌</b><p>只能自摸；红中为万能牌；支持普通胡与未副露七对；红中不能碰杠。</p></article>
        <article><b>抓码</b><p>固定预留六码。有红中胡抓4张，无红中胡抓6张；1、5、9和红中算码。</p></article>
        <article><b>积分</b><p>自摸向三家各收1分，每码再向三家各收1分；余额不足时最多付到0。</p></article>
        <article><b>杠</b><p>暗杠、补杠三家各付1分；明杠由出牌者付1分。杠分立即结算并保留。</p></article>
        <article><b>抢牌</b><p>每次出牌都先开一个响应窗口。同一张牌最多只有一家能碰或杠（四张同牌凑不出两家各两张），所以不存在抢先冲突。无人可抢或都选择过之后，会短暂停留再由下家摸牌。</p></article>
        <article><b>补杠</b><p>刚碰完手上还留着第四张时，可以直接补杠，不必等下一次摸牌；暗杠仍然要摸牌后才能开。</p></article>
        <article><b>庄家</b><p>四家投骰最高者首庄；后续赢家坐庄，流局留庄；庄家不加倍。</p></article>
        <article><b>AI档位</b><p>只有菜鸡、凡人、猿神三档，对局中可随时切换。做什么牌型由 AI 看着手牌自己定，不用你指定风格。</p></article>
        <article><b>AI差别</b><p>菜鸡算不清牌河里走了几张、常打错牌、有杠就杠；凡人会算离听牌还差几步和有效进张；猿神还会往前多看一步，挑「进完能听得最宽」的打法，牌墙见底时收手保杠分。</p></article>
        <article><b>思考时间</b><p>没有速度档位。孤张一眼就扔，听牌、能胡、能杠这些要算账的地方才明显慢下来。</p></article>
      </div>
    </section>
  </div>
  </template>
</template>
