<script setup lang="ts">
import { computed } from 'vue'
import MahjongTile from './MahjongTile.vue'
import PlayerSeat from './PlayerSeat.vue'
import type { GameState, Tile } from '@/game/types'

const props = withDefaults(defineProps<{
  state: GameState
  humanId: number
  selectedTileId?: string
  readonly?: boolean
  revealAll?: boolean
}>(), {
  selectedTileId: '',
  readonly: false,
  revealAll: false,
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
</script>

<template>
  <div class="table-shell">
    <div class="felt-pattern"></div>
    <PlayerSeat class="top-seat" :player="top" :active="state.currentPlayer === top.id" :reveal-hand="revealAll" :dealer="state.dealer === top.id" />
    <PlayerSeat class="left-seat" :player="left" :active="state.currentPlayer === left.id" :reveal-hand="revealAll" :dealer="state.dealer === left.id" />
    <PlayerSeat class="right-seat" :player="right" :active="state.currentPlayer === right.id" :reveal-hand="revealAll" :dealer="state.dealer === right.id" />

    <div class="table-center">
      <div class="center-brand"><span>光山</span><b>红中麻将</b></div>
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
  --human-tile-width: clamp(22px, 4.15cqw, 46px);
  --human-tile-height: clamp(31px, 5.78cqw, 64px);
  --human-compact-width: clamp(13px, 2.25cqw, 28px);
  --human-compact-height: clamp(18px, 3.15cqw, 39px);
  min-height: var(--table-height, 720px);
  position: relative;
  container-type: inline-size;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(118px, 17cqw, 190px) minmax(0, 1fr);
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
  width: min(72cqw, 760px);
  --seat-tile-width: clamp(13px, 2.3cqw, 28px);
  --seat-tile-height: clamp(18px, 3.22cqw, 39px);
  --discard-columns: 12;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  grid-template-areas: "seat-header seat-header" "seat-meta seat-meta" "seat-hand seat-river" "seat-meld seat-meld";
  column-gap: clamp(5px, 1cqw, 12px);
}
.top-seat :deep(header) { grid-area: seat-header; }
.top-seat :deep(.ai-meta) { grid-area: seat-meta; }
.top-seat :deep(.concealed-hand) { grid-area: seat-hand; }
.top-seat :deep(.meld-row) { grid-area: seat-meld; }
.top-seat :deep(.discard-row) { grid-area: seat-river; margin-top: 0; justify-self: end; }
.left-seat, .right-seat {
  width: 100%;
  align-self: center;
  --seat-tile-width: clamp(12px, 1.85cqw, 23px);
  --seat-tile-height: clamp(17px, 2.6cqw, 32px);
  --discard-columns: 10;
}
.left-seat { grid-area: left; }
.right-seat { grid-area: right; }
.table-center {
  grid-area: center;
  align-self: center;
  justify-self: center;
  width: clamp(118px, 16cqw, 190px);
  min-height: 92px;
  padding: clamp(9px, 1.2cqw, 13px);
  text-align: center;
  background: rgba(4,29,25,.94);
  border: 1px solid rgba(245,210,113,.32);
  border-radius: 17px;
  box-shadow: 0 10px 30px rgba(0,0,0,.25);
}
.center-brand { display: flex; justify-content: center; align-items: baseline; gap: 7px; color: #d9c07b; font-size: 10px; letter-spacing: 2px; }
.center-brand b { font-size: clamp(13px, 1.6cqw, 16px); color: #fff4d5; letter-spacing: 1px; }
.round-data { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 9px; color: #9ebcb3; font-size: 9px; }
.round-data span { padding: 4px 2px; border-radius: 5px; background: rgba(255,255,255,.035); white-space: nowrap; }
.last-action { margin-top: 8px; padding-top: 7px; overflow: hidden; border-top: 1px solid rgba(255,255,255,.08); color: #f5d57d; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; animation: action-flash .32s ease; }
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
  .table-shell { gap: 4px; padding: 5px; border-radius: 16px; }
  .top-seat { width: min(78cqw, 650px); --discard-columns: 12; }
  .left-seat, .right-seat { --discard-columns: 10; }
  .table-center { min-height: 70px; padding: 6px; border-radius: 11px; }
  .center-brand { gap: 4px; font-size: 7px; }
  .round-data { gap: 2px; margin-top: 5px; font-size: 6px; }
  .round-data span { padding: 3px 1px; }
  .last-action { margin-top: 4px; padding-top: 4px; font-size: 7px; }
  .human-seat { padding: 5px 6px; border-radius: 11px; }
  .human-seat header { margin-bottom: 2px; font-size: 10px; }
  .human-seat header span:last-child { font-size: 9px; }
  .dealer { width: 18px; height: 18px; font-size: 8px; }
  .human-hand { padding-top: 4px; }
  .human-discards { gap: 1px; margin-top: 3px; }
  .meld-row { padding-top: 4px; }
}

@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 700px) {
  .table-shell {
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
  .top-seat { width: 100%; display: block; --discard-columns: 12; }
  .top-seat :deep(.discard-row) { margin-top: 3px; justify-self: auto; }
  .left-seat, .right-seat { align-self: start; --seat-tile-width: clamp(11px, 2.9cqw, 16px); --seat-tile-height: clamp(15px, 4cqw, 22px); --discard-columns: 8; }
  .table-center { width: min(46cqw, 170px); min-height: 72px; padding: 7px; }
  .center-brand { font-size: 8px; }
  .round-data { margin-top: 5px; font-size: 7px; }
  .last-action { margin-top: 4px; padding-top: 4px; font-size: 8px; }
  .human-seat { grid-template-columns: auto minmax(0, 1fr); padding: 6px; }
  .human-seat header { margin-bottom: 3px; }
  .human-hand { padding-top: 5px; }
  .human-discards { gap: 1px; margin-top: 4px; }
  .meld-row { padding-top: 5px; }
}
</style>
