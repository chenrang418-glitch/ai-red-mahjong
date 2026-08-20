<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { GameState } from '@/game/types'

const props = defineProps<{ state: GameState | null }>()

// 只有开局那次投骰定首庄，之后是赢家坐庄、流局留庄，引擎也不会再摇。
// 所以只在第一局弹，第二局往后弹出来的其实是第一局的旧点数。
const open = ref(false)
let timer: number | null = null
let shownMatchId = ''

const rolls = computed(() => {
  const state = props.state
  if (!state || !state.diceRolls.length) return []
  return state.diceRolls.map((roll) => ({
    playerId: roll.playerId,
    name: state.players[roll.playerId]?.name ?? `座位${roll.playerId + 1}`,
    first: roll.dice[0],
    second: roll.dice[1],
    total: roll.total,
    dealer: roll.playerId === state.dealer,
  }))
})

const dealerName = computed(() => {
  const state = props.state
  if (!state) return ''
  return state.players[state.dealer]?.name ?? ''
})

watch(() => [props.state?.matchId, props.state?.round, props.state?.diceRolls.length] as const, () => {
  const state = props.state
  if (!state || state.round !== 1 || !state.diceRolls.length) return
  // 同一场只弹一次，重连、状态刷新都不该再弹
  if (shownMatchId === state.matchId) return
  shownMatchId = state.matchId
  open.value = true
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => { open.value = false }, 2800)
}, { immediate: true })

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer)
})

function dismiss() {
  if (timer !== null) window.clearTimeout(timer)
  open.value = false
}
</script>

<template>
  <div v-if="open && rolls.length" class="dice-toast" @click="dismiss">
    <small>开局投骰</small>
    <div class="dice-list">
      <div v-for="roll in rolls" :key="roll.playerId" class="dice-row" :class="{ dealer: roll.dealer }">
        <span class="dice-name">{{ roll.name }}</span>
        <span class="dice-pips"><i>{{ roll.first }}</i><i>{{ roll.second }}</i></span>
        <b>{{ roll.total }}</b>
      </div>
    </div>
    <strong>{{ dealerName }} 首庄</strong>
  </div>
</template>

<style scoped>
.dice-toast {
  position: fixed;
  z-index: 60;
  left: 50%;
  top: 15%;
  transform: translateX(-50%);
  width: min(420px, 88vw);
  padding: 16px 18px;
  display: grid;
  gap: 9px;
  border: 1px solid #927b3e;
  border-radius: 18px;
  background: rgba(13, 35, 29, .97);
  box-shadow: 0 18px 50px rgba(0,0,0,.45);
  animation: dice-in .26s ease;
  cursor: pointer;
}
.dice-toast > small { color: #7d918a; font-size: 10px; letter-spacing: .2em; text-align: center; }
.dice-list { display: grid; gap: 5px; }
.dice-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px;
  border-radius: 9px;
  background: #142e27;
}
/* 首庄那行单独标出来，不然还得自己比大小 */
.dice-row.dealer { background: #2c2a17; }
.dice-name { flex: 1; min-width: 0; color: #e8dfc6; font-size: 13px; }
.dice-pips { display: flex; gap: 5px; }
.dice-pips i {
  width: 22px; height: 22px; line-height: 22px; text-align: center;
  border-radius: 5px; background: #f4efe0;
  color: #1d2b25; font-size: 13px; font-weight: 800; font-style: normal;
  animation: pip-roll .38s ease;
}
.dice-row b { min-width: 24px; text-align: right; color: #f3d67c; font-size: 15px; }
.dice-toast > strong { color: #f3d67c; font-size: 14px; text-align: center; }
@keyframes dice-in { from { opacity: 0; transform: translateX(-50%) translateY(-10px); } }
@keyframes pip-roll { from { transform: rotate(-90deg) scale(.6); } }
@media (prefers-reduced-motion: reduce) {
  .dice-toast, .dice-pips i { animation: none; }
}
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .dice-toast { top: 8%; width: min(360px, 62vw); padding: 10px 12px; gap: 6px; border-radius: 12px; }
  .dice-row { padding: 4px 8px; gap: 7px; }
  .dice-name { font-size: 11px; }
  .dice-pips i { width: 18px; height: 18px; line-height: 18px; font-size: 11px; }
  .dice-row b { font-size: 12px; }
  .dice-toast > strong { font-size: 12px; }
}
</style>
