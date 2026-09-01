<script setup lang="ts">
import { computed } from 'vue'
import MahjongTile from './MahjongTile.vue'
import PlayerSeat from './PlayerSeat.vue'
import SeatCountdown from './SeatCountdown.vue'
import type { GameState, Tile } from '@/game/types'

const props = withDefaults(defineProps<{
  state: GameState
  humanId: number
  selectedTileId?: string
  readonly?: boolean
  revealAll?: boolean
  turnTimer?: { seatId: number; startedAt: number; deadlineAt: number; kind: 'turn' | 'ai' } | null
  timerNow?: number
  seatStatus?: Record<number, string>
  bubbles?: Record<number, string>
  // 对局页可按需显示全屏按钮
  fullscreenToggle?: boolean
  immersive?: boolean
}>(), {
  selectedTileId: '',
  readonly: false,
  revealAll: false,
  turnTimer: null,
  timerNow: 0,
  seatStatus: () => ({}),
  bubbles: () => ({}),
  fullscreenToggle: false,
  immersive: false,
})

const emit = defineEmits<{ selectTile: [tile: Tile]; toggleImmersive: [] }>()

const human = computed(() => props.state.players[props.humanId])
const right = computed(() => props.state.players[(props.humanId + 1) % 4])
const top = computed(() => props.state.players[(props.humanId + 2) % 4])
const left = computed(() => props.state.players[(props.humanId + 3) % 4])
const canSelect = computed(() => !props.readonly && props.state.phase === 'playing' && props.state.currentPlayer === props.humanId)
const isHumanTurn = computed(() => props.state.currentPlayer === props.humanId && props.state.phase === 'playing')
const humanDrawTile = computed(() => {
  if (props.state.turnStage !== 'after-draw' || props.state.currentPlayer !== props.humanId) return null
  const latestEvent = props.state.events.at(-1)
  if (latestEvent?.type !== 'draw' || latestEvent.playerId !== props.humanId || !latestEvent.tile) return null
  return human.value.hand.find((tile) => tile.id === latestEvent.tile!.id) ?? null
})
const arrangedHumanHand = computed(() => human.value.hand.filter((tile) => tile.id !== humanDrawTile.value?.id))
// 最后一张弃牌单独高亮：牌河堆满之后，光靠位置很难看出刚打的是哪张。
const lastDiscardId = computed(() => props.state.lastDiscard?.tile.id ?? '')
// 这几类动作值得把提示条也强调一下，普通的摸打就不用了
const STRONG_EVENTS = ['peng', 'ming-gang', 'an-gang', 'bu-gang', 'win', 'draw-game']
const activeCountdown = computed(() => {
  const timer = props.turnTimer
  if (!timer) return null
  const duration = Math.max(1, timer.deadlineAt - timer.startedAt)
  const remaining = Math.max(0, timer.deadlineAt - (props.timerNow || Date.now()))
  return {
    seatId: timer.seatId,
    progress: remaining / duration,
    seconds: remaining / 1000,
    ai: timer.kind === 'ai',
  }
})

function countdownFor(seatId: number) {
  const countdown = activeCountdown.value
  if (!countdown || countdown.seatId !== seatId) return null
  return { progress: countdown.progress, seconds: countdown.seconds, ai: countdown.ai }
}
</script>

<template>
  <div class="table-shell" :class="{ 'my-turn': isHumanTurn }">
    <div class="felt-pattern"></div>

    <PlayerSeat
      class="top-seat"
      :player="top"
      :active="state.currentPlayer === top.id"
      :reveal-hand="revealAll"
      :dealer="state.dealer === top.id"
      :countdown="countdownFor(top.id)"
      :status="seatStatus[top.id] ?? ''"
      :bubble="bubbles[top.id] ?? ''"
    />
    <PlayerSeat
      class="left-seat"
      :player="left"
      :active="state.currentPlayer === left.id"
      :reveal-hand="revealAll"
      :dealer="state.dealer === left.id"
      :countdown="countdownFor(left.id)"
      :status="seatStatus[left.id] ?? ''"
      :bubble="bubbles[left.id] ?? ''"
    />
    <PlayerSeat
      class="right-seat"
      :player="right"
      :active="state.currentPlayer === right.id"
      :reveal-hand="revealAll"
      :dealer="state.dealer === right.id"
      :countdown="countdownFor(right.id)"
      :status="seatStatus[right.id] ?? ''"
      :bubble="bubbles[right.id] ?? ''"
    />

    <!-- 横屏中间行只有六七十像素高，中央区放不下「信息卡＋三层牌河」，
         所以横屏把这条信息提到牌桌顶部横着放，中央只留四家牌河。 -->
    <div class="table-strip">
      <span>第 <b>{{ state.round }}</b> 局</span>
      <span>牌墙 <b>{{ state.wall.length }}</b></span>
      <span>码区 <b>{{ state.maReserve.length }}</b></span>
      <em v-if="state.events.length">{{ state.events.at(-1)?.detail }}</em>
    </div>

    <button
      v-if="fullscreenToggle"
      class="fullscreen-toggle"
      type="button"
      :aria-pressed="immersive"
      :title="immersive ? '退出全屏' : '全屏牌桌'"
      @click="emit('toggleImmersive')"
    >{{ immersive ? '⤢' : '⛶' }}</button>

    <!-- 牌桌中央：四家的弃牌按方位堆在中间，和真牌桌一样 -->
    <div class="table-center">
      <div class="river river-top" data-seat="对家" :class="{ active: state.currentPlayer === top.id }" :aria-label="`${top.name}的牌河`">
        <MahjongTile v-for="tile in top.discards" :key="tile.id" :tile="tile" :class="{ 'just-discarded': tile.id === lastDiscardId }" disabled compact />
      </div>
      <div class="river river-left" data-seat="上家" :class="{ active: state.currentPlayer === left.id }" :aria-label="`${left.name}的牌河`">
        <MahjongTile v-for="tile in left.discards" :key="tile.id" :tile="tile" :class="{ 'just-discarded': tile.id === lastDiscardId }" disabled compact />
      </div>

      <div class="center-info">
        <div class="round-data">
          <span>第 <b>{{ state.round }}</b> 局</span>
          <span>牌墙 <b>{{ state.wall.length }}</b></span>
          <span>码区 <b>{{ state.maReserve.length }}</b></span>
        </div>
        <div
          v-if="state.events.length"
          class="last-action"
          :class="{ strong: STRONG_EVENTS.includes(state.events.at(-1)?.type ?? '') }"
        >{{ state.events.at(-1)?.detail }}</div>
      </div>

      <div class="river river-right" data-seat="下家" :class="{ active: state.currentPlayer === right.id }" :aria-label="`${right.name}的牌河`">
        <MahjongTile v-for="tile in right.discards" :key="tile.id" :tile="tile" :class="{ 'just-discarded': tile.id === lastDiscardId }" disabled compact />
      </div>
      <div class="river river-bottom" data-seat="你" :class="{ active: isHumanTurn }" aria-label="你的牌河">
        <MahjongTile v-for="tile in human.discards" :key="tile.id" :tile="tile" :class="{ 'just-discarded': tile.id === lastDiscardId }" disabled compact />
      </div>
    </div>

    <section class="human-seat" :class="{ active: isHumanTurn }">
      <!-- 贴在手牌框上沿外侧的位置，联机模式往里放聊天按钮。
           挂在这儿而不是固定在屏幕上，手牌框因为碰杠变高时按钮会自己跟着走。 -->
      <slot name="hand-corner" />
      <header>
        <span class="dealer" v-if="state.dealer === human.id">庄</span>
        <strong>{{ human.name }}</strong>
        <SeatCountdown v-if="countdownFor(human.id)" v-bind="countdownFor(human.id)!" />
        <span class="human-points">{{ human.points === null ? `净分 ${human.stats.netPoints >= 0 ? '+' : ''}${human.stats.netPoints}` : `${human.points}分` }}</span>
      </header>
      <transition name="bubble">
        <p v-if="bubbles[human.id]" class="self-bubble">{{ bubbles[human.id] }}</p>
      </transition>
      <div class="hand-row">
        <div class="meld-row" v-if="human.melds.length">
          <div v-for="meld in human.melds" :key="meld.id" class="meld-group">
            <MahjongTile v-for="tile in meld.tiles" :key="tile.id" :tile="tile" compact disabled />
          </div>
        </div>
        <div class="human-hand">
          <MahjongTile
            v-for="tile in arrangedHumanHand"
            :key="tile.id"
            :tile="tile"
            :selected="selectedTileId === tile.id"
            :disabled="!canSelect"
            @select="emit('selectTile', $event)"
          />
          <div v-if="humanDrawTile" class="drawn-tile-slot">
            <small>刚摸</small>
            <MahjongTile
              :tile="humanDrawTile"
              :selected="selectedTileId === humanDrawTile.id"
              :disabled="!canSelect"
              @select="emit('selectTile', $event)"
            />
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.table-shell {
  --human-tile-width: clamp(26px, 5.3cqw, 56px);
  --human-tile-height: clamp(36px, 7.4cqw, 78px);
  --meld-tile-width: clamp(15px, 2.5cqw, 31px);
  --meld-tile-height: clamp(21px, 3.5cqw, 43px);
  --river-tile-width: clamp(15px, 2.2cqw, 26px);
  --river-tile-height: clamp(21px, 3.1cqw, 36px);
  /* 最新弃牌会抬起 2px、外描边 2px、再加一圈发光，这些全画在牌的边界之外。
     .table-center 为了兜住极端牌数是 clip 容器，会沿 padding box 把它们切掉，
     所以中央区的内边距必须至少留出这个余量。 */
  --river-highlight-room: 6px;
  /* 弃牌飞入的起始偏移。手机上中央区只有一百多像素高，46px 会让牌从容器外面飞进来，
     前半段直接被裁掉，所以移动端另给一个小值。 */
  --river-fly-distance: 46px;
  /* 四家牌河都按固定列数、往下加行：列数一旦浮动，打到二十张时左右两堆会把中央撑爆 */
  --river-columns: 12;
  --river-side-columns: 4;
  /* 牌桌高度锁死：牌河堆到二十多张时，中央区不能把对家和自己的手牌挤出屏幕 */
  min-height: var(--table-height, 720px);
  max-height: var(--table-height, 720px);
  position: relative;
  container-type: inline-size;
  display: grid;
  grid-template-columns: clamp(96px, 15cqw, 190px) minmax(0, 1fr) clamp(96px, 15cqw, 190px);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    "top   top    top"
    "strip strip  strip"
    "left  center right"
    "human human  human";
  align-items: start;
  gap: clamp(6px, 1cqw, 14px);
  padding: clamp(8px, 1.2cqw, 20px);
  overflow: hidden;
  border: 1px solid rgba(237, 205, 113, .32);
  border-radius: 26px;
  background: radial-gradient(circle at 50% 42%, #23907a 0, #14705f 42%, #0c4f43 78%, #093a32 100%);
  box-shadow: inset 0 0 90px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06), 0 22px 60px rgba(0,0,0,.4);
  transition: border-color .3s, box-shadow .3s;
}
/* 轮到自己时整张桌子透一层光，比再加一行字更快被看到 */
.table-shell.my-turn { border-color: rgba(243, 202, 105, .6); animation: table-breathe 2.4s ease-in-out infinite; }
.felt-pattern { position: absolute; inset: 0; opacity: .05; background-image: repeating-linear-gradient(45deg, transparent 0 16px, #fff 17px 18px); pointer-events: none; }
.table-center, .table-strip { z-index: 1; min-width: 0; }
/* 座位要压在牌河上面：气泡是从座位里冒出来的，座位低于牌河的话气泡就被牌河盖住了 */
.top-seat, .left-seat, .right-seat, .human-seat { z-index: 3; min-width: 0; }
/* 正在说话的那家再抬一层，气泡才能盖过旁边的座位卡 */
.top-seat:has(.seat-bubble), .left-seat:has(.seat-bubble), .right-seat:has(.seat-bubble) { z-index: 9; }

/* 气泡默认朝正上方冒，但对家已经贴着牌桌上沿，左右两家的上方又正好是对家那张卡，
   一律朝上的话：对家的气泡会被牌桌的 overflow 裁掉，左右两家的会糊在对家卡片上。
   所以三家都改成朝牌桌中央展开——中央那片是空的，谁都不挡谁。 */
.top-seat :deep(.seat-bubble) {
  top: calc(100% - 2px);
  bottom: auto;
  left: 50%;
  right: auto;
  width: max-content;
  max-width: min(260px, 52cqw);
  transform: translateX(-50%);
  border-radius: 3px 12px 12px 12px;
}
.left-seat :deep(.seat-bubble) {
  left: calc(100% - 6px);
  right: auto;
  top: 2px;
  bottom: auto;
  width: max-content;
  max-width: min(230px, 40cqw);
  border-radius: 12px 12px 12px 3px;
}
.right-seat :deep(.seat-bubble) {
  right: calc(100% - 6px);
  left: auto;
  top: 2px;
  bottom: auto;
  width: max-content;
  max-width: min(230px, 40cqw);
  border-radius: 12px 12px 3px 12px;
}
/* 全屏按钮只在横屏出现：那里顶行右侧本来就是空的，也只有横屏值得把侧栏藏起来换空间 */
.fullscreen-toggle { display: none; }
/* 竖屏和桌面用中央那张信息卡，这条横条只在横屏出场 */
.table-strip { grid-area: strip; display: none; }
/* 对家和左右两家一样是方块，居中摆在顶上——横贯一整行既浪费宽度也不对称 */
.top-seat { grid-area: top; justify-self: center; width: auto; min-width: clamp(96px, 15cqw, 190px); max-width: min(46cqw, 460px); }
.left-seat { grid-area: left; align-self: start; }
.right-seat { grid-area: right; align-self: start; }

.table-center {
  grid-area: center;
  align-self: center;
  justify-self: center;
  /* 极端牌数下宁可让中央这块自己滚，也不挤压手牌区；宽度同样不许越界到座位上 */
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  display: grid;
  grid-template-columns: auto minmax(0, auto) auto;
  grid-template-rows: auto auto auto;
  /* 上下两家的牌河横跨整个中央区，左右两家各占一侧——和真牌桌上四堆弃牌的方位一致 */
  grid-template-areas:
    "river-top    river-top    river-top"
    "river-left   center-info  river-right"
    "river-bottom river-bottom river-bottom";
  gap: clamp(4px, .7cqw, 10px);
  padding: max(clamp(6px, .9cqw, 12px), var(--river-highlight-room));
  border-radius: 18px;
  background: rgba(3, 26, 22, .34);
  box-shadow: inset 0 0 34px rgba(0,0,0,.24);
}
.table-center::-webkit-scrollbar { display: none; }
/* 牌河是高亮牌的直接父级，必须放开裁切，抬起和描边才画得出来。
   真正需要兜底滚动的是外面的 .table-center，不在这一层。 */
.river { display: grid; gap: 2px; align-content: start; justify-content: center; overflow: visible; transition: opacity .2s; }
.river :deep(.mahjong-tile.compact) {
  width: var(--river-tile-width);
  height: var(--river-tile-height);
  padding: 1px;
  border-radius: 4px;
}
/* 上下两家横着堆，左右两家竖着堆，牌面朝向和座位方位对应 */
.river-top, .river-bottom {
  grid-template-columns: repeat(var(--river-columns), var(--river-tile-width));
  grid-auto-rows: var(--river-tile-height);
}
.river-top { grid-area: river-top; }
.river-bottom { grid-area: river-bottom; }
.river-left, .river-right {
  grid-template-columns: repeat(var(--river-side-columns), var(--river-tile-width));
  grid-auto-rows: var(--river-tile-height);
}
.river-left { grid-area: river-left; }
.river-right { grid-area: river-right; }
/* 描边 2px + 发光向上外扩约 1.5px + 抬起 2px，合计不到 6px，
   刚好落在 --river-highlight-room 预留的范围内。原来是 12px 模糊、4px 下偏移，
   贴着中央区上边那一行会被切掉一截。 */
.river :deep(.just-discarded) {
  box-shadow: 0 0 0 2px #f3ca69, 0 2px 7px rgba(243, 202, 105, .34);
  transform: translateY(-2px);
}
/* 刚打出的牌从打牌人那一侧飞进牌河。
   之前是凭空出现在牌河里，四家轮得快的时候根本看不清谁打了什么。
   每个牌河朝向不同，起点方向也跟着变，视线自然跟着牌走。 */
.river :deep(.just-discarded) { animation: river-fly .34s cubic-bezier(.22, .68, .3, 1); }
.river-bottom :deep(.just-discarded) { --fly-x: 0; --fly-y: var(--river-fly-distance); }
.river-top :deep(.just-discarded) { --fly-x: 0; --fly-y: calc(-1 * var(--river-fly-distance)); }
.river-left :deep(.just-discarded) { --fly-x: calc(-1 * var(--river-fly-distance)); --fly-y: 0; }
.river-right :deep(.just-discarded) { --fly-x: var(--river-fly-distance); --fly-y: 0; }
@keyframes river-fly {
  from {
    transform: translate(var(--fly-x, 0), var(--fly-y, 0)) scale(1.22);
    opacity: .35;
  }
  60% { opacity: 1; }
  to { transform: translateY(-2px) scale(1); }
}

.center-info {
  grid-area: center-info;
  min-width: clamp(112px, 15cqw, 190px);
  align-self: center;
  padding: clamp(7px, 1cqw, 12px) clamp(8px, 1.1cqw, 14px);
  text-align: center;
  background: linear-gradient(180deg, rgba(6, 36, 30, .96), rgba(3, 24, 20, .96));
  border: 1px solid rgba(245,210,113,.28);
  border-radius: 14px;
  box-shadow: 0 12px 32px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.05);
}
.round-data { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; color: #8ba9a1; font-size: 9px; }
.round-data span { padding: 4px 2px; border-radius: 6px; background: rgba(255,255,255,.04); white-space: nowrap; }
.round-data b { display: block; color: #ecd591; font-size: clamp(12px, 1.3cqw, 15px); font-variant-numeric: tabular-nums; }
.last-action { min-height: 30px; margin-top: 7px; padding: 7px 5px 1px; overflow: hidden; border-top: 1px solid rgba(255,255,255,.1); color: #ffe08a; font-size: clamp(11px, 1.25cqw, 14px); font-weight: 800; line-height: 1.3; text-wrap: balance; animation: action-flash .32s ease; }
/* 碰、杠、胡这种大动作，提示条压一下再弹回来，配合音效和震动一起给反馈 */
.last-action.strong { animation: action-strong .42s cubic-bezier(.2, .8, .3, 1.2); color: #ffd75e; }
@keyframes action-strong {
  0% { transform: scale(.86); opacity: .3; }
  55% { transform: scale(1.06); opacity: 1; }
  100% { transform: scale(1); }
}

.human-seat {
  grid-area: human;
  position: relative;
  min-width: 0;
  padding: clamp(6px, .9cqw, 11px) clamp(8px, 1.2cqw, 14px);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(7, 38, 31, .86), rgba(3, 24, 20, .9));
  border: 1px solid rgba(220,193,113,.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
}
.human-seat.active {
  border-color: #f3ca69;
  box-shadow: 0 0 0 2px rgba(243,202,105,.14), inset 0 1px 0 rgba(255,255,255,.06);
  animation: human-seat-breathe 2.2s ease-in-out infinite;
}
@keyframes human-seat-breathe {
  50% { border-color: #ffe08a; box-shadow: 0 0 0 2px rgba(255,224,138,.2), 0 0 30px rgba(243,202,105,.18), inset 0 1px 0 rgba(255,255,255,.08); }
}
.human-seat header { display: flex; align-items: center; gap: 8px; color: #f8efd4; margin-bottom: 4px; }
.human-seat header strong { font-size: 14px; }
.human-points { margin-left: auto; color: #f3cf75; font-size: 12px; font-variant-numeric: tabular-nums; }
.dealer { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; }
.hand-row { display: flex; align-items: flex-end; gap: clamp(5px, 1cqw, 12px); min-width: 0; }
.meld-row { display: flex; flex-wrap: nowrap; gap: clamp(2px, .6cqw, 8px); flex: 0 0 auto; }
.meld-group { display: flex; gap: 1px; }
.meld-row :deep(.mahjong-tile.compact) { width: var(--meld-tile-width); height: var(--meld-tile-height); padding: 1px; border-radius: 4px; }
.human-hand { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: nowrap; align-items: flex-end; justify-content: center; gap: clamp(1px, .3cqw, 4px); min-height: var(--human-tile-height); padding-top: 9px; }
/* 牌宽是「理想值」，容器塞不下时要能收缩：
   flex 项默认 min-width:auto，会卡在内容宽度不肯再小，
   再加上牌宽 clamp 有 23px 硬下限，320 宽的屏幕上十四张必然溢出，
   最右边那张（通常正是刚摸的）就够不着了。给一个明确的收缩下限即可。 */
.human-hand :deep(.mahjong-tile) {
  flex: 0 1 var(--human-tile-width);
  width: var(--human-tile-width);
  min-width: 17px;
  height: var(--human-tile-height);
  padding: clamp(1px, .28cqw, 3px);
  border-radius: clamp(4px, .62cqw, 7px);
}
/* 手牌是全局点得最多的东西，但十四张铺满屏宽之后单张只有二十几像素，
   比 iOS 建议的 44 小一半。牌面尺寸不能再大了，改成用伪元素把可点范围
   向四周撑开——手指按在两张牌中间的缝里也能选中，视觉上没有任何变化。 */
.human-hand :deep(.mahjong-tile)::after {
  content: '';
  position: absolute;
  left: calc(-1 * var(--hand-hit-x, 3px));
  right: calc(-1 * var(--hand-hit-x, 3px));
  top: calc(-1 * var(--hand-hit-y, 6px));
  bottom: calc(-1 * var(--hand-hit-y, 6px));
}
.human-hand :deep(.mahjong-tile:disabled)::after { content: none; }
.drawn-tile-slot { position: relative; display: flex; margin-left: clamp(4px, 1cqw, 13px); padding-left: clamp(4px, 1cqw, 13px); animation: tile-drawn .3s cubic-bezier(.2, .7, .3, 1); }
/* 摸上来的牌从右上方滑入并轻微下沉，和「刚摸」那个标签一起，
   让人一眼认出这张是新的——十四张排一起，光靠位置很难分辨 */
@keyframes tile-drawn {
  from { transform: translate(14px, -18px) scale(1.14); opacity: .3; }
  to { transform: none; opacity: 1; }
}
.drawn-tile-slot::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 2px; width: 1px; background: rgba(243,202,105,.45); }
.drawn-tile-slot small { position: absolute; z-index: 1; top: -10px; left: 7px; padding: 1px 4px; border-radius: 99px; background: #c49d3e; color: #17211b; font-size: clamp(6px, .7cqw, 8px); font-weight: 800; white-space: nowrap; }
.drawn-tile-slot :deep(.mahjong-tile) { box-shadow: 0 4px 0 #b9ad8c, 0 0 0 2px #efc85f, 0 8px 18px rgba(239,200,95,.2); }
.self-bubble {
  position: absolute;
  z-index: 6;
  left: clamp(8px, 2cqw, 20px);
  bottom: calc(100% - 4px);
  max-width: min(70%, 420px);
  margin: 0;
  padding: 7px 11px;
  border: 1px solid #c8a955;
  border-radius: 12px 12px 12px 3px;
  background: #f5e7bd;
  color: #22301f;
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
  box-shadow: 0 10px 26px rgba(0,0,0,.42);
}
.bubble-enter-active, .bubble-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-enter-from, .bubble-leave-to { opacity: 0; transform: translateY(6px); }
@keyframes action-flash { from { opacity: .25; transform: translateY(-3px); } }
@keyframes table-breathe {
  50% { box-shadow: inset 0 0 90px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06), 0 22px 60px rgba(0,0,0,.4), 0 0 30px rgba(243,202,105,.22); }
}

/* 横屏／矮窗口：高度紧张，牌河压到两行，中央信息收窄 */
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  /* 横屏中央保留四行弃牌列表，并压缩行高 */
  .table-center {
    display: flex;
    flex-direction: column;
    gap: 2px;
    /* 竖向和横向都要够高亮牌外扩，否则贴边那一行的描边被切 */
    padding: max(4px, var(--river-highlight-room)) max(6px, var(--river-highlight-room));
    border: 1px solid rgba(122, 152, 140, .28);
    border-radius: 10px;
    background: rgba(6, 24, 19, .38);
  }
  .table-center .center-info { display: none; }
  .table-center .river {
    order: 5;
    flex: none;
    min-height: 22px;
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 2px;
    padding: 0 0 0 30px;
    position: relative;
  }
  .table-center .river::before {
    content: attr(data-seat);
    position: absolute;
    left: 0; top: 3px;
    color: #74897f; font-size: 8px;
  }
  .table-center .river-bottom { order: 1; }
  .table-center .river-right { order: 2; }
  .table-center .river-top { order: 3; }
  .table-center .river-left { order: 4; }
  .table-shell {
    --human-tile-width: clamp(30px, 4.85cqw, 48px);
    --human-tile-height: clamp(42px, 6.8cqw, 67px);
    --meld-tile-width: clamp(16px, 2.4cqw, 24px);
    --meld-tile-height: clamp(22px, 3.36cqw, 34px);
    --river-tile-width: clamp(14px, 1.95cqw, 21px);
    --river-tile-height: clamp(19px, 2.7cqw, 29px);
    --river-fly-distance: 20px;
    --river-columns: 16;
    --river-side-columns: 10;
    grid-template-columns: clamp(88px, 12.5cqw, 150px) minmax(0, 1fr) clamp(88px, 12.5cqw, 150px);
    gap: 5px;
    padding: 5px;
    border-radius: 15px;
  }
  /* 对家不再横贯整行，缩成和左右两家一样的窄卡片，空出来的那半行给对局信息，
     两者并排一行——比上下各占一行省出三十来像素，全部让给中央牌河。 */
  .table-shell {
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top   strip  fs"
      "left  center right"
      "human human  human";
  }

  .top-seat { justify-self: stretch; align-self: start; min-width: 0; max-width: none; }
  /* 横屏第一行很矮，对家和左家上下只差十几像素：对家气泡再朝下就直接糊在左家头上，
     居中展开还会顶出牌桌左边被裁掉。两家都改成朝右伸进中央空地，再拉开垂直距离。 */
  .top-seat :deep(.seat-bubble) {
    left: calc(100% + 4px);
    right: auto;
    top: 0;
    bottom: auto;
    transform: none;
    max-width: min(240px, 30cqw);
    border-radius: 12px 12px 12px 3px;
  }
  .left-seat :deep(.seat-bubble) {
    left: calc(100% + 4px);
    right: auto;
    top: 50%;
    bottom: auto;
    transform: translateY(-50%);
    max-width: min(240px, 30cqw);
  }
  .right-seat :deep(.seat-bubble) {
    right: calc(100% + 4px);
    left: auto;
    top: 50%;
    bottom: auto;
    transform: translateY(-50%);
    max-width: min(240px, 30cqw);
  }
  /* 横屏中间行只有六七十像素：信息卡挪到上面那条横条，中央只留四家牌河，
     否则内容要 140px 却只有 60px，六成会被裁掉（就是之前牌面散落的原因）。 */
  /* 对局信息做成和座位卡同宽的方块，落在右上角：
     左上是对家、右上是它，两块上下各自对齐左右两家，左右对称。 */
  /* 对局信息：牌桌顶部居中的一块，正压在中央牌河区上方。
     高度必须压住——它每高一点，中间行的牌河就少一点。 */
  .fullscreen-toggle {
    grid-area: fs;
    display: grid;
    place-items: center;
    justify-self: end;
    align-self: start;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 1px solid rgba(245,210,113,.3);
    border-radius: 9px;
    background: rgba(6, 36, 30, .92);
    color: #ecd591;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
  }
  .fullscreen-toggle:hover { border-color: #d3b45e; color: #f3d77f; }
  .table-strip {
    justify-self: center;
    align-self: start;
    display: grid;
    grid-template-columns: repeat(3, auto);
    gap: 2px 4px;
    padding: 4px 8px;
    border: 1px solid rgba(245,210,113,.22);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(6, 36, 30, .92), rgba(3, 24, 20, .92));
    color: #8ba9a1;
    font-size: 8px;
    text-align: center;
  }
  .table-strip span { display: flex; align-items: baseline; justify-content: center; gap: 3px; white-space: nowrap; }
  .table-strip b { color: #ecd591; font-size: 11px; font-variant-numeric: tabular-nums; }
  .table-strip em {
    grid-column: 1 / -1;
    margin-top: 1px;
    padding-top: 3px;
    border-top: 1px solid rgba(255,255,255,.1);
    max-width: 40cqw;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: #ffe08a;
    font-size: 10px;
    font-style: normal;
    font-weight: 800;
  }
  .table-center {
    width: 100%;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas:
      "river-top    river-top"
      "river-left   river-right"
      "river-bottom river-bottom";
    gap: 3px;
    padding: 4px 5px;
    border-radius: 12px;
  }
  .river-left { justify-content: end; }
  .river-right { justify-content: start; }
  .center-info { display: none; }
  /* 左右两家的信息竖着排，别让不可压缩的倒计时和积分把窄卡片撑破 */
  .left-seat :deep(header), .right-seat :deep(header) { flex-wrap: wrap; gap: 2px 5px; }
  .left-seat :deep(.points), .right-seat :deep(.points) { margin-left: 0; }
  .left-seat :deep(.seat-countdown), .right-seat :deep(.seat-countdown) { width: 32px; height: 32px; flex-basis: 32px; }
  .left-seat :deep(.seat-countdown b), .right-seat :deep(.seat-countdown b) { font-size: 13px; }
  /* 副露一多，窄座位就会顶出中间行去压住手牌区；卡片自己封顶，超出的部分在卡片内滚 */
  .left-seat, .right-seat {
    max-height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  .left-seat::-webkit-scrollbar, .right-seat::-webkit-scrollbar { display: none; }
  .top-seat, .left-seat, .right-seat { padding: 5px 6px; gap: 2px; }
  .top-seat :deep(.mahjong-tile.compact), .left-seat :deep(.mahjong-tile.compact), .right-seat :deep(.mahjong-tile.compact) { width: 14px; height: 19px; }
  .top-seat :deep(.hand-count), .left-seat :deep(.hand-count), .right-seat :deep(.hand-count) { padding: 1px 6px; font-size: 8px; }
  .top-seat :deep(.hand-count b), .left-seat :deep(.hand-count b), .right-seat :deep(.hand-count b) { font-size: 11px; }
  .top-seat :deep(.meld-row), .left-seat :deep(.meld-row), .right-seat :deep(.meld-row) { gap: 3px; }
  .top-seat :deep(header), .left-seat :deep(header), .right-seat :deep(header) { flex-wrap: wrap; gap: 2px 5px; }
  .top-seat :deep(.points) { margin-left: 0; }
  .top-seat { max-height: 100%; overflow-y: auto; scrollbar-width: none; }
  .top-seat::-webkit-scrollbar { display: none; }
  .left-seat :deep(.meld-group), .right-seat :deep(.meld-group) { padding-top: 7px; }
  .left-seat :deep(.meld-group small), .right-seat :deep(.meld-group small) { font-size: 6px; }
  .human-seat { padding: 5px 7px; border-radius: 12px; }
  .human-seat header { margin-bottom: 2px; }
  .human-seat header strong { font-size: 12px; }
  .human-points { font-size: 11px; }
  .dealer { width: 18px; height: 18px; font-size: 9px; }
  .human-hand { padding-top: 6px; }
}

/* 竖屏：左右两家收成窄条，中央牌河列数减少，下半屏全部留给手牌 */
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  /* 中央使用四行列表：一行一家，左边固定标出是谁打的。
     原来那套四方位环绕的摆法在手机上每家只剩一条窄缝，看不出谁打了什么。 */
  .table-center {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: max(6px, var(--river-highlight-room)) max(7px, var(--river-highlight-room));
    border: 1px solid rgba(122, 152, 140, .3);
    border-radius: 12px;
    background: rgba(6, 24, 19, .4);
  }
  /* 局数那块搬到页面顶栏了，中央只留弃牌 */
  .table-center .center-info { display: none; }
  .table-center .river {
    order: 5;
    flex: none;
    min-height: 26px;
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 2px;
    padding: 0 0 0 34px;
    position: relative;
  }
  .table-center .river::before {
    content: attr(data-seat);
    position: absolute;
    left: 0;
    top: 4px;
    color: #74897f;
    font-size: 9px;
    letter-spacing: .02em;
  }
  /* 顺序为：你、下家、对家、上家。
     选择器要和上面那条 .table-center .river 同样具体，否则压不过它的 order: 5 */
  .table-center .river-bottom { order: 1; }
  .table-center .river-right { order: 2; }
  .table-center .river-top { order: 3; }
  .table-center .river-left { order: 4; }
  .table-shell {
    --human-tile-width: clamp(23px, 6.5cqw, 38px);
    --human-tile-height: clamp(32px, 9.1cqw, 53px);
    --meld-tile-width: clamp(14px, 3.9cqw, 21px);
    --meld-tile-height: clamp(20px, 5.5cqw, 29px);
    --river-tile-width: clamp(14px, 3.75cqw, 19px);
    --river-tile-height: clamp(19px, 5.2cqw, 26px);
    --river-fly-distance: 20px;
    --river-columns: 10;
    --river-side-columns: 5;
    grid-template-columns: clamp(72px, 21cqw, 104px) minmax(0, 1fr) clamp(72px, 21cqw, 104px);
    /* 四行要和 grid-template-areas 的四行对齐：漏掉一行时，被隐藏的信息条那行
       会把 1fr 全部吃掉，牌河和左右两家就被挤到贴着手牌的位置。 */
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    gap: 5px;
    padding: 7px 6px;
    border-radius: 18px;
  }
  .top-seat { min-width: clamp(96px, 30cqw, 150px); max-width: 70cqw; }
  /* 左右两家跟着中央牌河一起垂直居中，别一个贴顶一个悬空 */
  .left-seat, .right-seat { align-self: center; }
  .left-seat :deep(header), .right-seat :deep(header) { flex-wrap: wrap; gap: 2px 5px; }
  .left-seat :deep(.points), .right-seat :deep(.points) { margin-left: 0; }
  .left-seat :deep(.meld-row), .right-seat :deep(.meld-row) { flex-wrap: wrap; gap: 3px; }
  /* 竖屏中央只有一百八十来像素宽，「左牌河＋信息卡＋右牌河」三栏并排会把信息卡压没。
     改成四行：信息条独占一行，左右两家的牌河并排放在中间，方位感还在，宽度也够了。 */
  .table-center {
    width: 100%;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto auto auto;
    grid-template-areas:
      "center-info  center-info"
      "river-top    river-top"
      "river-left   river-right"
      "river-bottom river-bottom";
    gap: 4px 3px;
    padding: 5px 4px;
    border-radius: 13px;
  }
  .center-info { min-width: 0; padding: 5px 6px; border-radius: 10px; }
  .round-data { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; font-size: 8px; }
  .round-data span { display: flex; align-items: baseline; justify-content: center; gap: 3px; padding: 3px 2px; }
  .round-data b { display: inline; font-size: 12px; }
  .last-action { min-height: 0; margin-top: 5px; padding: 5px 2px 1px; font-size: 12px; }
  .river-left { justify-content: end; }
  .river-right { justify-content: start; }
  .human-seat { padding: 7px 8px; border-radius: 15px; }
  .human-seat header strong { font-size: 13px; }
  .human-points { font-size: 12px; }
  .dealer { width: 20px; height: 20px; font-size: 10px; }
  .hand-row { flex-direction: column; align-items: stretch; gap: 3px; }
  .meld-row { justify-content: center; flex-wrap: wrap; }
  /* 极窄屏塞不下十四张时允许横向滑动，而不是把牌桌撑破 */
  .human-hand { justify-content: center; padding-top: 10px; gap: 0; }
  /* 触屏没有 hover 可以试错，热区给得比桌面端更宽一些 */
  .human-hand :deep(.mahjong-tile) { --hand-hit-x: 4px; --hand-hit-y: 9px; }
  .human-hand::-webkit-scrollbar { display: none; }
  /* 竖屏中央窄，左右两家的气泡朝里展开会正面撞上，所以错开一行、各让一半宽度 */
  .left-seat :deep(.seat-bubble) { max-width: min(150px, 34cqw); top: 0; }
  .right-seat :deep(.seat-bubble) { max-width: min(150px, 34cqw); top: 38px; }
  /* 竖屏用绝对定位挂在右上角，不占 grid 格子——横屏那套 fs 区域保持原样。
     没有它的话，横屏进全屏再转竖屏就找不到退出的地方了。 */
  .fullscreen-toggle {
    display: grid;
    place-items: center;
    position: absolute;
    z-index: 6;
    top: 7px;
    right: 7px;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid rgba(245,210,113,.32);
    border-radius: 8px;
    background: rgba(6, 36, 30, .9);
    color: #ecd591;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  .human-hand :deep(.mahjong-tile) { padding: 2px; border-radius: 5px; }
  .drawn-tile-slot { margin-left: 4px; padding-left: 3px; }
  .self-bubble { left: 8px; max-width: 78%; font-size: 12px; }
}

/* 手机版牌桌的统一布局规则保持在组件样式末尾。 */
@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .felt-pattern, .table-strip, .center-info { display: none !important; }
  .table-shell {
    --human-tile-width: clamp(23px, 6.65cqw, 30px);
    --human-tile-height: clamp(34px, 9.55cqw, 43px);
    --meld-tile-width: clamp(15px, 4cqw, 20px);
    --meld-tile-height: clamp(22px, 5.7cqw, 29px);
    --river-tile-width: clamp(14px, 3.7cqw, 18px);
    --river-tile-height: clamp(20px, 5.2cqw, 26px);
    grid-template-columns: 88px minmax(0, 1fr) 88px;
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top top top"
      "left center right"
      "human human human";
    align-items: center;
    gap: 7px 9px;
    padding: 4px 10px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .table-shell.my-turn { border: 0; box-shadow: none; animation: none; }
  .top-seat, .left-seat, .right-seat {
    overflow: visible;
    border: 1px solid #274038;
    border-radius: 12px;
    background: rgba(7, 29, 24, .76);
    box-shadow: none;
  }
  .top-seat { width: 174px; min-width: 174px; max-width: 174px; min-height: 76px; justify-self: center; align-self: start; }
  .left-seat, .right-seat { width: 88px; min-height: 132px; align-self: center; justify-content: center; }
  .top-seat :deep(header), .left-seat :deep(header), .right-seat :deep(header) { gap: 4px 6px; flex-wrap: wrap; }
  .top-seat :deep(header strong), .left-seat :deep(header strong), .right-seat :deep(header strong) { font-size: 15px; }
  .top-seat :deep(.points), .left-seat :deep(.points), .right-seat :deep(.points) { margin-left: 0; color: #cdb779; font-size: 13px; }
  .top-seat :deep(.hand-count), .left-seat :deep(.hand-count), .right-seat :deep(.hand-count) {
    min-width: 64px; justify-content: center; padding: 3px 10px; border-color: #35524a; font-size: 11px;
  }
  .top-seat :deep(.hand-count b), .left-seat :deep(.hand-count b), .right-seat :deep(.hand-count b) { font-size: 14px; }
  .top-seat :deep(.dealer), .left-seat :deep(.dealer), .right-seat :deep(.dealer) { width: 22px; height: 22px; font-size: 11px; }
  .table-center {
    width: 100%;
    height: min(35dvh, 326px);
    min-height: 205px;
    max-height: 100%;
    align-self: center;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: max(8px, var(--river-highlight-room)) max(9px, var(--river-highlight-room));
    overflow: hidden;
    border: 1px solid rgba(52,82,72,.58);
    border-radius: 12px;
    background: rgba(6,24,19,.46);
    box-shadow: none;
  }
  .table-center .river {
    order: 5;
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 2px;
    /* 顶部这几像素是留给最新弃牌的：它会抬起 2px、外描边 2px、再加一点发光，
       全画在牌的边界之外。这一行本身是 overflow: hidden 的裁切盒（弃牌堆到三四行时
       不能糊到下一家那行去），所以只能在行内把空间留出来，不能改成 visible。 */
    padding: var(--river-highlight-room) 0 0 34px;
    position: relative;
    overflow: hidden;
  }
  .table-center .river::before {
    content: attr(data-seat);
    position: absolute;
    left: 0; top: var(--river-highlight-room);
    width: 30px;
    color: #74897f;
    font-size: 10px;
  }
  .table-center .river-bottom { order: 1; }
  .table-center .river-right { order: 2; }
  .table-center .river-top { order: 3; }
  .table-center .river-left { order: 4; }
  .river :deep(.mahjong-tile.compact) { flex: 0 0 auto; width: var(--river-tile-width); height: var(--river-tile-height); }
  .human-seat {
    margin: 0 -10px;
    padding: 8px 12px 10px;
    border: 0;
    border-top: 1px solid #274038;
    border-radius: 0;
    background: rgba(5,23,18,.96);
    box-shadow: none;
  }
  .human-seat.active { border-color: #4f5f3d; box-shadow: none; }
  .human-seat header { min-height: 26px; margin: 0 0 4px; }
  .human-seat header strong { font-size: 18px; }
  .human-points { font-size: 16px; }
  .human-seat .dealer { width: 23px; height: 23px; font-size: 11px; }
  .hand-row { flex-direction: column; align-items: stretch; gap: 3px; }
  .meld-row { justify-content: center; flex-wrap: nowrap; }
  .human-hand {
    justify-content: center;
    min-height: calc(var(--human-tile-height) + 11px);
    padding-top: 11px;
    gap: 1px;
    overflow: visible;
  }
  .human-hand :deep(.mahjong-tile) { flex: 0 1 var(--human-tile-width); width: var(--human-tile-width); min-width: 17px; height: var(--human-tile-height); padding: 2px; border-radius: 5px; }
  .drawn-tile-slot { margin-left: 5px; padding-left: 5px; }
  .fullscreen-toggle { display: none; }
}

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .table-shell {
    --human-tile-width: clamp(27px, 4.25cqw, 39px);
    --human-tile-height: clamp(39px, 6.1cqw, 56px);
    --river-tile-width: clamp(13px, 2cqw, 18px);
    --river-tile-height: clamp(18px, 2.8cqw, 25px);
    grid-template-columns: 92px minmax(0, 1fr) 92px;
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top top top"
      "left center right"
      "human human human";
    gap: 4px 7px;
    padding: 2px 10px 0;
  }
  .top-seat { width: 150px; min-width: 150px; max-width: 150px; min-height: 54px; padding: 5px 8px; }
  .left-seat, .right-seat { width: 92px; min-height: 116px; padding: 6px 8px; }
  .top-seat :deep(header strong), .left-seat :deep(header strong), .right-seat :deep(header strong) { font-size: 13px; }
  .top-seat :deep(.points), .left-seat :deep(.points), .right-seat :deep(.points) { font-size: 11px; }
  .top-seat :deep(.hand-count), .left-seat :deep(.hand-count), .right-seat :deep(.hand-count) { min-width: 56px; padding: 1px 7px; font-size: 9px; }
  .top-seat :deep(.hand-count b), .left-seat :deep(.hand-count b), .right-seat :deep(.hand-count b) { font-size: 12px; }
  .table-center { height: 126px; min-height: 92px; padding: max(5px, var(--river-highlight-room)) max(7px, var(--river-highlight-room)); gap: 2px; }
  .table-center .river { padding-left: 30px; }
  .table-center .river::before { top: 2px; width: 26px; font-size: 8px; }
  .human-seat {
    min-height: 66px;
    margin: 0 -10px;
    padding: 4px 174px calc(5px + env(safe-area-inset-bottom)) 10px;
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .human-seat header { flex: 0 0 52px; min-height: 0; margin: 0 0 2px; flex-direction: column; align-items: flex-start; gap: 1px; }
  .human-seat header strong { font-size: 13px; }
  .human-points { margin-left: 0; font-size: 12px; }
  .hand-row { flex: 1 1 auto; min-width: 0; flex-direction: row; align-items: flex-end; gap: 6px; }
  .meld-row { flex: 0 0 auto; max-width: 108px; }
  .human-hand { flex-wrap: nowrap; justify-content: center; min-height: var(--human-tile-height); padding-top: 6px; gap: 1px; }
  .drawn-tile-slot { margin-left: 4px; padding-left: 4px; }
}

@media (prefers-reduced-motion: reduce) {
  .last-action { animation: none; }
  .table-shell.my-turn { animation: none; }
  .human-seat.active { animation: none; }
  .bubble-enter-active, .bubble-leave-active { transition: none; }
  .river :deep(.just-discarded) { transform: none; animation: none; }
  .drawn-tile-slot, .last-action, .last-action.strong { animation: none; }
}
</style>
