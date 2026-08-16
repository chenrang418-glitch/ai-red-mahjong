<script setup lang="ts">
import { computed } from 'vue'
import MahjongTile from './MahjongTile.vue'
import PlayerSeat from './PlayerSeat.vue'
import SeatCountdown from './SeatCountdown.vue'
import { useViewport } from '@/composables/useViewport'
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
}>(), {
  selectedTileId: '',
  readonly: false,
  revealAll: false,
  turnTimer: null,
  timerNow: 0,
  seatStatus: () => ({}),
  bubbles: () => ({}),
})

const emit = defineEmits<{ selectTile: [tile: Tile] }>()

const { isPortrait } = useViewport()

const human = computed(() => props.state.players[props.humanId])
const right = computed(() => props.state.players[(props.humanId + 1) % 4])
const top = computed(() => props.state.players[(props.humanId + 2) % 4])
const left = computed(() => props.state.players[(props.humanId + 3) % 4])
const canSelect = computed(() => !props.readonly && props.state.phase === 'playing' && props.state.currentPlayer === props.humanId)
const humanDrawTile = computed(() => {
  if (props.state.turnStage !== 'after-draw' || props.state.currentPlayer !== props.humanId) return null
  const latestEvent = props.state.events.at(-1)
  if (latestEvent?.type !== 'draw' || latestEvent.playerId !== props.humanId || !latestEvent.tile) return null
  return human.value.hand.find((tile) => tile.id === latestEvent.tile!.id) ?? null
})
const arrangedHumanHand = computed(() => human.value.hand.filter((tile) => tile.id !== humanDrawTile.value?.id))
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
  <div class="table-shell" :class="{ portrait: isPortrait }">
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
      :hand-as-count="isPortrait"
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
      :hand-as-count="isPortrait"
      :status="seatStatus[right.id] ?? ''"
      :bubble="bubbles[right.id] ?? ''"
    />

    <div class="table-center">
      <div class="round-data">
        <span>第 <b>{{ state.round }}</b> 局</span>
        <span>牌墙 <b>{{ state.wall.length }}</b></span>
        <span>码区 <b>{{ state.maReserve.length }}</b></span>
      </div>
      <div class="last-action" v-if="state.events.length">{{ state.events.at(-1)?.detail }}</div>
    </div>

    <section class="human-seat" :class="{ active: state.currentPlayer === human.id }">
      <header>
        <span class="dealer" v-if="state.dealer === human.id">庄</span>
        <strong>{{ human.name }}</strong>
        <SeatCountdown v-if="countdownFor(human.id)" v-bind="countdownFor(human.id)!" />
        <span class="human-points">{{ human.points === null ? `本场净分 ${human.stats.netPoints >= 0 ? '+' : ''}${human.stats.netPoints}` : `${human.points}积分` }}</span>
      </header>
      <transition name="bubble">
        <p v-if="bubbles[human.id]" class="self-bubble">{{ bubbles[human.id] }}</p>
      </transition>
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
      <div class="human-discards">
        <MahjongTile v-for="tile in human.discards" :key="tile.id" :tile="tile" compact disabled />
      </div>
    </section>
  </div>
</template>

<style scoped>
.table-shell {
  /* 手牌是玩家全程盯着、还要点的东西，尺寸给足：十四张大约占牌桌宽度的四分之三 */
  --human-tile-width: clamp(26px, 5.3cqw, 56px);
  --human-tile-height: clamp(36px, 7.4cqw, 78px);
  --human-compact-width: clamp(15px, 2.5cqw, 31px);
  --human-compact-height: clamp(21px, 3.5cqw, 43px);
  min-height: var(--table-height, 720px);
  position: relative;
  container-type: inline-size;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(132px, 18cqw, 205px) minmax(0, 1fr);
  grid-template-rows: auto minmax(min-content, 1fr) auto;
  grid-template-areas:
    "top top top"
    "left center right"
    "human human human";
  align-items: start;
  gap: clamp(6px, 1cqw, 14px);
  padding: clamp(10px, 1.4cqw, 22px);
  overflow: hidden;
  border: 1px solid rgba(237, 205, 113, .32);
  border-radius: 28px;
  background:
    radial-gradient(circle at 50% 42%, #1a7461 0, #0f5346 42%, #073730 78%, #042722 100%);
  box-shadow: inset 0 0 90px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.06), 0 22px 60px rgba(0,0,0,.4);
}
.felt-pattern { position: absolute; inset: 0; opacity: .05; background-image: repeating-linear-gradient(45deg, transparent 0 16px, #fff 17px 18px); pointer-events: none; }
.top-seat, .left-seat, .right-seat, .table-center, .human-seat { z-index: 1; }
.top-seat {
  grid-area: top;
  justify-self: center;
  width: min(74cqw, 820px);
  --seat-tile-width: clamp(15px, 2.55cqw, 31px);
  --seat-tile-height: clamp(21px, 3.56cqw, 43px);
  --discard-columns: 12;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "seat-header" "seat-meta" "seat-hand" "seat-meld" "seat-river";
}
.top-seat :deep(header) { grid-area: seat-header; }
.top-seat :deep(.seat-meta) { grid-area: seat-meta; }
.top-seat :deep(.concealed-hand) { grid-area: seat-hand; }
.top-seat :deep(.meld-row) { grid-area: seat-meld; }
.top-seat :deep(.discard-row) { grid-area: seat-river; margin-top: 4px; justify-self: start; }
.left-seat, .right-seat {
  width: 100%;
  align-self: center;
  --seat-tile-width: clamp(13px, 2.05cqw, 25px);
  --seat-tile-height: clamp(18px, 2.87cqw, 35px);
  --discard-columns: 10;
}
.left-seat { grid-area: left; }
.right-seat { grid-area: right; }
.table-center {
  grid-area: center;
  align-self: center;
  justify-self: center;
  width: clamp(132px, 17cqw, 198px);
  min-height: 104px;
  padding: clamp(9px, 1.2cqw, 14px);
  text-align: center;
  background: linear-gradient(180deg, rgba(6, 36, 30, .95), rgba(3, 24, 20, .95));
  border: 1px solid rgba(245,210,113,.28);
  border-radius: 17px;
  box-shadow: 0 12px 32px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.05);
}
.round-data { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; color: #8ba9a1; font-size: 9px; }
.round-data span { padding: 5px 2px; border-radius: 6px; background: rgba(255,255,255,.04); white-space: nowrap; }
.round-data b { display: block; color: #ecd591; font-size: clamp(12px, 1.35cqw, 15px); font-variant-numeric: tabular-nums; }
.last-action { min-height: 34px; margin-top: 9px; padding: 9px 7px 2px; overflow: hidden; border-top: 1px solid rgba(255,255,255,.1); color: #ffe08a; font-size: clamp(12px, 1.35cqw, 15px); font-weight: 800; line-height: 1.35; white-space: normal; text-wrap: balance; animation: action-flash .32s ease; }
.human-seat {
  grid-area: human;
  position: relative;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: "human-header human-header" "human-meld human-hand" "human-river human-river";
  align-items: end;
  column-gap: clamp(5px, 1cqw, 12px);
  padding: clamp(7px, 1cqw, 11px) clamp(8px, 1.35cqw, 14px);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(7, 38, 31, .86), rgba(3, 24, 20, .9));
  border: 1px solid rgba(220,193,113,.2);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
}
.human-seat.active { border-color: #f3ca69; box-shadow: 0 0 0 2px rgba(243,202,105,.14), inset 0 1px 0 rgba(255,255,255,.06); }
.human-seat header { grid-area: human-header; display: flex; align-items: center; gap: 8px; color: #f8efd4; margin-bottom: 5px; }
.human-seat header strong { font-size: 15px; }
.human-points { margin-left: auto; color: #f3cf75; font-size: 12px; font-variant-numeric: tabular-nums; }
.dealer { display: inline-grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; }
.human-hand { grid-area: human-hand; min-width: 0; display: flex; flex-wrap: nowrap; align-items: flex-end; gap: clamp(1px, .3cqw, 4px); justify-content: center; min-height: var(--human-tile-height); padding-top: 9px; }
.human-hand :deep(.mahjong-tile) { width: var(--human-tile-width); height: var(--human-tile-height); padding: clamp(1px, .28cqw, 3px); border-radius: clamp(4px, .62cqw, 7px); }
.drawn-tile-slot { position: relative; display: flex; margin-left: clamp(4px, 1cqw, 13px); padding-left: clamp(4px, 1cqw, 13px); }
.drawn-tile-slot::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 2px; width: 1px; background: rgba(243,202,105,.45); }
.drawn-tile-slot small { position: absolute; z-index: 1; top: -10px; left: 7px; padding: 1px 4px; border-radius: 99px; background: #c49d3e; color: #17211b; font-size: clamp(6px, .7cqw, 8px); font-weight: 800; white-space: nowrap; }
.drawn-tile-slot :deep(.mahjong-tile) { box-shadow: 0 4px 0 #b9ad8c, 0 0 0 2px #efc85f, 0 8px 18px rgba(239,200,95,.2); }
.human-discards { grid-area: human-river; display: grid; grid-template-columns: repeat(18, var(--human-compact-width)); grid-auto-rows: var(--human-compact-height); gap: 2px; width: max-content; max-width: 100%; min-height: 0; margin: 6px auto 0; justify-content: center; }
.human-discards :deep(.mahjong-tile.compact), .meld-row :deep(.mahjong-tile.compact) { width: var(--human-compact-width); height: var(--human-compact-height); padding: 1px; border-radius: clamp(3px, .45cqw, 5px); }
.meld-row { grid-area: human-meld; display: flex; flex-wrap: nowrap; gap: clamp(2px, .65cqw, 8px); justify-content: flex-start; margin: 0; padding-top: 7px; }
.meld-group { display: flex; gap: 1px; }
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

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 600px) {
  .table-shell { --human-tile-width: clamp(30px, 4.85cqw, 48px); --human-tile-height: clamp(42px, 6.8cqw, 67px); --human-compact-width: clamp(17px, 2.55cqw, 25px); --human-compact-height: clamp(24px, 3.57cqw, 35px); gap: 4px; padding: 5px; border-radius: 16px; }
  .top-seat { width: min(80cqw, 680px); --seat-tile-width: clamp(17px, 2.65cqw, 26px); --seat-tile-height: clamp(24px, 3.7cqw, 36px); --discard-columns: 12; }
  .left-seat, .right-seat { --seat-tile-width: clamp(15px, 2.15cqw, 21px); --seat-tile-height: clamp(21px, 3cqw, 29px); --discard-columns: 10; }
  .table-center { min-height: 82px; padding: 7px; border-radius: 11px; }
  .round-data { gap: 2px; font-size: 7px; }
  .round-data span { padding: 3px 1px; }
  .round-data b { font-size: 11px; }
  .last-action { min-height: 26px; margin-top: 5px; padding: 5px 4px 1px; font-size: 11px; }
  .human-seat { padding: 5px 7px; border-radius: 12px; }
  .human-seat header { margin-bottom: 2px; }
  .human-seat header strong { font-size: 12px; }
  .human-points { font-size: 10px; }
  .dealer { width: 18px; height: 18px; font-size: 8px; }
  .human-hand { padding-top: 6px; }
  .human-discards { gap: 1px; margin-top: 3px; }
  .meld-row { padding-top: 4px; }
}

/* 竖屏是完全另一套排布：对家在顶上，上下家压成左右两条窄边，
   中间是牌河和最新动作，下半屏整块留给自己的手牌和操作。 */
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  .table-shell {
    /* 十四张牌加上「刚摸」那一格必须塞进一行，所以宽度直接按容器算，间隙压到零 */
    --human-tile-width: clamp(23px, 6.5cqw, 38px);
    --human-tile-height: clamp(32px, 9.1cqw, 53px);
    --human-compact-width: clamp(15px, 4.1cqw, 22px);
    --human-compact-height: clamp(21px, 5.75cqw, 31px);
    grid-template-columns: clamp(58px, 17cqw, 96px) minmax(0, 1fr) clamp(58px, 17cqw, 96px);
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "top top top"
      "left center right"
      "human human human";
    align-content: stretch;
    gap: 6px;
    padding: 8px 7px;
    border-radius: 20px;
  }
  .top-seat {
    width: 100%;
    --seat-tile-width: clamp(15px, 4cqw, 21px);
    --seat-tile-height: clamp(21px, 5.6cqw, 29px);
    --discard-columns: 12;
  }
  .top-seat :deep(.concealed-hand) { overflow: hidden; }
  .top-seat :deep(.discard-row) { margin-top: 3px; }
  .left-seat, .right-seat {
    align-self: stretch;
    padding: 6px 4px;
    --seat-tile-width: clamp(13px, 3.6cqw, 19px);
    --seat-tile-height: clamp(18px, 5cqw, 26px);
    --discard-columns: 3;
  }
  .left-seat :deep(header), .right-seat :deep(header) { flex-wrap: wrap; gap: 3px; }
  .left-seat :deep(.points), .right-seat :deep(.points) { margin-left: 0; }
  .left-seat :deep(.meld-row), .right-seat :deep(.meld-row) { flex-wrap: wrap; gap: 3px; }
  .left-seat :deep(.discard-row), .right-seat :deep(.discard-row) { margin-inline: auto; }
  .table-center { width: 100%; min-height: 0; align-self: center; padding: 9px 8px; border-radius: 14px; }
  .round-data { font-size: 9px; }
  .round-data b { font-size: 14px; }
  .last-action { min-height: 36px; margin-top: 7px; padding: 7px 5px 1px; font-size: 14px; }
  .human-seat {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "human-header" "human-meld" "human-hand" "human-river";
    align-items: stretch;
    padding: 8px;
    border-radius: 16px;
  }
  .human-seat header { margin-bottom: 4px; }
  .human-seat header strong { font-size: 14px; }
  .human-points { font-size: 12px; }
  .dealer { width: 21px; height: 21px; font-size: 10px; }
  /* 极窄屏（比如 320px）真的塞不下十四张时允许横向滑动，而不是把牌桌撑破 */
  .human-hand { justify-content: center; padding-top: 11px; gap: 0; overflow-x: auto; scrollbar-width: none; }
  .human-hand::-webkit-scrollbar { display: none; }
  .human-hand :deep(.mahjong-tile) { padding: 2px; border-radius: 5px; }
  .drawn-tile-slot { margin-left: 4px; padding-left: 3px; }
  .human-discards { grid-template-columns: repeat(12, var(--human-compact-width)); gap: 2px; margin-top: 6px; }
  .meld-row { justify-content: center; padding-top: 0; padding-bottom: 2px; flex-wrap: wrap; }
  .self-bubble { left: 8px; max-width: 78%; font-size: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .last-action { animation: none; }
  .bubble-enter-active, .bubble-leave-active { transition: none; }
}
</style>
