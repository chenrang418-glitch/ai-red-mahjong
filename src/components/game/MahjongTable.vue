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
  min-height: 720px;
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(237, 205, 113, .35);
  border-radius: 28px;
  background: radial-gradient(circle at 50% 45%, #176957 0, #0e4c40 43%, #07362f 78%, #052b26 100%);
  box-shadow: inset 0 0 80px rgba(0,0,0,.35), 0 18px 60px rgba(0,0,0,.35);
}
.felt-pattern { position: absolute; inset: 0; opacity: .06; background-image: repeating-linear-gradient(45deg, transparent 0 16px, #fff 17px 18px); pointer-events: none; }
.top-seat { position: absolute; top: 16px; left: 50%; max-width: 440px; transform: translateX(-50%); }
.left-seat, .right-seat { position: absolute; top: 34%; width: calc(50% - 146px); max-width: 520px; min-width: 220px; }
.left-seat { left: 16px; }
.right-seat { right: 16px; }
.table-center { position: absolute; z-index: 2; left: 50%; top: 43%; transform: translate(-50%, -50%); width: 196px; min-height: 108px; padding: 13px 15px; text-align: center; background: rgba(4,29,25,.94); border: 1px solid rgba(245,210,113,.32); border-radius: 17px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
.center-brand { display: flex; justify-content: center; align-items: baseline; gap: 7px; color: #d9c07b; font-size: 10px; letter-spacing: 2px; }
.center-brand b { font-size: 16px; color: #fff4d5; letter-spacing: 1px; }
.round-data { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 9px; color: #9ebcb3; font-size: 9px; }
.round-data span { padding: 4px 2px; border-radius: 5px; background: rgba(255,255,255,.035); white-space: nowrap; }
.last-action { margin-top: 8px; padding-top: 7px; overflow: hidden; border-top: 1px solid rgba(255,255,255,.08); color: #f5d57d; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; animation: action-flash .32s ease; }
.human-seat { position: absolute; left: 22px; right: 22px; bottom: 18px; padding: 11px 14px; border-radius: 17px; background: rgba(4,28,24,.8); border: 1px solid rgba(220,193,113,.2); }
.human-seat.active { border-color: #f3ca69; box-shadow: 0 0 0 2px rgba(243,202,105,.13); }
.human-seat header { display: flex; align-items: center; gap: 8px; color: #f8efd4; margin-bottom: 9px; }
.human-seat header span:last-child { margin-left: auto; color: #f3cf75; font-size: 12px; }
.dealer { display: inline-grid; place-items: center; width: 23px; height: 23px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; }
.human-hand { display: flex; align-items: flex-end; gap: 4px; justify-content: center; min-height: 76px; padding-top: 8px; }
.drawn-tile-slot { position: relative; display: flex; margin-left: 13px; padding-left: 13px; }
.drawn-tile-slot::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 2px; width: 1px; background: rgba(243,202,105,.45); }
.drawn-tile-slot small { position: absolute; z-index: 1; top: -12px; left: 17px; padding: 2px 5px; border-radius: 99px; background: #c49d3e; color: #17211b; font-size: 8px; font-weight: 800; white-space: nowrap; }
.drawn-tile-slot :deep(.mahjong-tile) { box-shadow: 0 4px 0 #b9ad8c, 0 0 0 2px #efc85f, 0 8px 18px rgba(239,200,95,.2); }
.human-discards { display: flex; gap: 2px; flex-wrap: wrap; max-width: 320px; min-height: 43px; margin: 8px auto 0; justify-content: center; }
.meld-row { display: flex; gap: 8px; justify-content: center; margin-bottom: 6px; }
.meld-group { display: flex; gap: 1px; }
@keyframes action-flash { from { opacity: .25; transform: translateY(-3px); } }
@media (max-width: 980px) {
  .table-shell { min-height: 760px; }
  .left-seat, .right-seat { top: 29%; width: calc(50% - 125px); transform: scale(.88); transform-origin: left center; }
  .right-seat { transform-origin: right center; }
  .table-center { width: 174px; padding-inline: 10px; }
  .human-hand { justify-content: flex-start; overflow-x: auto; padding: 10px 4px; }
}
</style>
