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
}>(), {
  selectedTileId: '',
  readonly: false,
  revealAll: false,
  turnTimer: null,
  timerNow: 0,
})

const emit = defineEmits<{ selectTile: [tile: Tile] }>()

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
  <div class="table-shell">
    <div class="felt-pattern"></div>
    <PlayerSeat class="top-seat" :player="top" :active="state.currentPlayer === top.id" :reveal-hand="revealAll" :dealer="state.dealer === top.id" :countdown="countdownFor(top.id)" />
    <PlayerSeat class="left-seat" :player="left" :active="state.currentPlayer === left.id" :reveal-hand="revealAll" :dealer="state.dealer === left.id" :countdown="countdownFor(left.id)" />
    <PlayerSeat class="right-seat" :player="right" :active="state.currentPlayer === right.id" :reveal-hand="revealAll" :dealer="state.dealer === right.id" :countdown="countdownFor(right.id)" />

    <div class="table-center">
      <div class="center-brand"><b>红中麻将</b></div>
      <div class="round-data">
        <span>第 {{ state.round }} 局</span>
        <span>牌墙 {{ state.wall.length }}</span>
        <span>码区 {{ state.maReserve.length }}</span>
      </div>
      <div class="last-action" v-if="state.events.length">{{ state.events.at(-1)?.detail }}</div>
    </div>

    <section class="human-seat" :class="{ active: state.currentPlayer === human.id }">
      <header>
        <span class="dealer" v-if="state.dealer === human.id">庄</span>
        <strong>{{ human.name }}</strong>
        <SeatCountdown v-if="countdownFor(human.id)" v-bind="countdownFor(human.id)!" />
        <span>{{ human.points === null ? `本场净分 ${human.stats.netPoints >= 0 ? '+' : ''}${human.stats.netPoints}` : `${human.points}积分` }}</span>
      </header>
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
  --human-tile-width: clamp(24px, 4.35cqw, 50px);
  --human-tile-height: clamp(34px, 6.05cqw, 70px);
  --human-compact-width: clamp(15px, 2.45cqw, 30px);
  --human-compact-height: clamp(21px, 3.42cqw, 42px);
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
  border: 1px solid rgba(237, 205, 113, .35);
  border-radius: 28px;
  background: radial-gradient(circle at 50% 45%, #176957 0, #0e4c40 43%, #07362f 78%, #052b26 100%);
  box-shadow: inset 0 0 80px rgba(0,0,0,.35), 0 18px 60px rgba(0,0,0,.35);
}
.felt-pattern { position: absolute; inset: 0; opacity: .06; background-image: repeating-linear-gradient(45deg, transparent 0 16px, #fff 17px 18px); pointer-events: none; }
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
.top-seat :deep(.ai-meta) { grid-area: seat-meta; }
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
  min-height: 112px;
  padding: clamp(9px, 1.2cqw, 13px);
  text-align: center;
  background: rgba(4,29,25,.94);
  border: 1px solid rgba(245,210,113,.32);
  border-radius: 17px;
  box-shadow: 0 10px 30px rgba(0,0,0,.25);
}
.center-brand { display: flex; justify-content: center; align-items: baseline; color: #d9c07b; }
.center-brand b { font-size: clamp(12px, 1.35cqw, 14px); color: #fff4d5; letter-spacing: 1px; }
.round-data { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 8px; color: #9ebcb3; font-size: 9px; }
.round-data span { padding: 4px 2px; border-radius: 5px; background: rgba(255,255,255,.035); white-space: nowrap; }
.last-action { min-height: 34px; margin-top: 8px; padding: 8px 7px 2px; overflow: hidden; border-top: 1px solid rgba(255,255,255,.1); color: #ffe08a; font-size: clamp(12px, 1.35cqw, 14px); font-weight: 800; line-height: 1.3; white-space: normal; text-wrap: balance; animation: action-flash .32s ease; }
.human-seat {
  grid-area: human;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: "human-header human-header" "human-meld human-hand" "human-river human-river";
  align-items: end;
  column-gap: clamp(5px, 1cqw, 12px);
  padding: clamp(7px, 1cqw, 11px) clamp(8px, 1.35cqw, 14px);
  border-radius: 17px;
  background: rgba(4,28,24,.8);
  border: 1px solid rgba(220,193,113,.2);
}
.human-seat.active { border-color: #f3ca69; box-shadow: 0 0 0 2px rgba(243,202,105,.13); }
.human-seat header { grid-area: human-header; display: flex; align-items: center; gap: 8px; color: #f8efd4; margin-bottom: 5px; }
.human-seat header strong { font-size: 15px; }
.human-seat header span:last-child { margin-left: auto; color: #f3cf75; font-size: 12px; }
.dealer { display: inline-grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; }
.human-hand { grid-area: human-hand; min-width: 0; display: flex; flex-wrap: nowrap; align-items: flex-end; gap: clamp(1px, .3cqw, 4px); justify-content: center; min-height: var(--human-tile-height); padding-top: 7px; }
.human-hand :deep(.mahjong-tile) { width: var(--human-tile-width); height: var(--human-tile-height); padding: clamp(1px, .28cqw, 3px); border-radius: clamp(4px, .62cqw, 7px); }
.drawn-tile-slot { position: relative; display: flex; margin-left: clamp(4px, 1cqw, 13px); padding-left: clamp(4px, 1cqw, 13px); }
.drawn-tile-slot::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 2px; width: 1px; background: rgba(243,202,105,.45); }
.drawn-tile-slot small { position: absolute; z-index: 1; top: -10px; left: 7px; padding: 1px 4px; border-radius: 99px; background: #c49d3e; color: #17211b; font-size: clamp(6px, .7cqw, 8px); font-weight: 800; white-space: nowrap; }
.drawn-tile-slot :deep(.mahjong-tile) { box-shadow: 0 4px 0 #b9ad8c, 0 0 0 2px #efc85f, 0 8px 18px rgba(239,200,95,.2); }
.human-discards { grid-area: human-river; display: grid; grid-template-columns: repeat(18, var(--human-compact-width)); grid-auto-rows: var(--human-compact-height); gap: 2px; width: max-content; max-width: 100%; min-height: 0; margin: 6px auto 0; justify-content: center; }
.human-discards :deep(.mahjong-tile.compact), .meld-row :deep(.mahjong-tile.compact) { width: var(--human-compact-width); height: var(--human-compact-height); padding: 1px; border-radius: clamp(3px, .45cqw, 5px); }
.meld-row { grid-area: human-meld; display: flex; flex-wrap: nowrap; gap: clamp(2px, .65cqw, 8px); justify-content: flex-start; margin: 0; padding-top: 7px; }
.meld-group { display: flex; gap: 1px; }
@keyframes action-flash { from { opacity: .25; transform: translateY(-3px); } }

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 600px) {
  .table-shell { --human-tile-width: clamp(28px, 4.55cqw, 44px); --human-tile-height: clamp(39px, 6.35cqw, 62px); --human-compact-width: clamp(17px, 2.55cqw, 25px); --human-compact-height: clamp(24px, 3.57cqw, 35px); gap: 4px; padding: 5px; border-radius: 16px; }
  .top-seat { width: min(80cqw, 680px); --seat-tile-width: clamp(17px, 2.65cqw, 26px); --seat-tile-height: clamp(24px, 3.7cqw, 36px); --discard-columns: 12; }
  .left-seat, .right-seat { --seat-tile-width: clamp(15px, 2.15cqw, 21px); --seat-tile-height: clamp(21px, 3cqw, 29px); }
  .left-seat, .right-seat { --discard-columns: 10; }
  .table-center { min-height: 86px; padding: 7px; border-radius: 11px; }
  .center-brand b { font-size: 11px; }
  .round-data { gap: 2px; margin-top: 5px; font-size: 7px; }
  .round-data span { padding: 3px 1px; }
  .last-action { min-height: 28px; margin-top: 4px; padding: 6px 4px 1px; font-size: 10px; }
  .human-seat { padding: 5px 6px; border-radius: 11px; }
  .human-seat header { margin-bottom: 2px; }
  .human-seat header strong { font-size: 12px; }
  .human-seat header span:last-child { font-size: 10px; }
  .dealer { width: 18px; height: 18px; font-size: 8px; }
  .human-hand { padding-top: 4px; }
  .human-discards { gap: 1px; margin-top: 3px; }
  .meld-row { padding-top: 4px; }
}

@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 700px) {
  .table-shell {
    --human-tile-width: clamp(24px, 6.25cqw, 25px);
    --human-tile-height: clamp(34px, 8.75cqw, 35px);
    --human-compact-width: clamp(16px, 4.4cqw, 18px);
    --human-compact-height: clamp(23px, 6.15cqw, 25px);
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto auto auto auto;
    grid-template-areas:
      "top top"
      "left right"
      "center center"
      "human human";
    align-content: space-between;
    gap: 5px;
    padding: 7px;
    border-radius: 18px;
  }
  .top-seat { width: 100%; display: block; --seat-tile-width: clamp(18px, 4.9cqw, 20px); --seat-tile-height: clamp(25px, 6.85cqw, 28px); --discard-columns: 12; }
  .top-seat :deep(.discard-row) { margin-top: 3px; justify-self: auto; }
  .left-seat, .right-seat { align-self: start; --seat-tile-width: clamp(12px, 3.35cqw, 14px); --seat-tile-height: clamp(17px, 4.7cqw, 20px); --discard-columns: 8; }
  .table-center { width: min(59cqw, 235px); min-height: 108px; padding: 9px; }
  .center-brand b { font-size: 11px; }
  .round-data { margin-top: 7px; font-size: 8px; }
  .last-action { min-height: 37px; margin-top: 6px; padding: 8px 5px 1px; font-size: 14px; }
  .human-seat { grid-template-columns: auto minmax(0, 1fr); padding: 7px; }
  .human-seat header { margin-bottom: 3px; }
  .human-seat header strong { font-size: 14px; }
  .human-seat header span:last-child { font-size: 11px; }
  .dealer { width: 21px; height: 21px; font-size: 10px; }
  .human-hand { padding-top: 5px; }
  .human-discards { gap: 1px; margin-top: 4px; }
  .meld-row { padding-top: 5px; }
}
</style>
