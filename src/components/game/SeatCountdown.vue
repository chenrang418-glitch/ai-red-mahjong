<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  progress: number
  seconds: number
  ai?: boolean
}>()

const normalizedProgress = computed(() => Math.max(0, Math.min(1, props.progress)))
const dashOffset = computed(() => 100 * (1 - normalizedProgress.value))
</script>

<template>
  <div class="seat-countdown" :class="{ urgent: progress <= 0.25, ai }" :aria-label="`${ai ? 'AI思考' : '操作'}剩余${seconds.toFixed(1)}秒`">
    <svg viewBox="0 0 42 42" aria-hidden="true">
      <circle class="track" cx="21" cy="21" r="16" />
      <circle class="progress" cx="21" cy="21" r="16" :style="{ strokeDashoffset: dashOffset }" />
    </svg>
    <span class="clock-mark">⏱</span>
    <b>{{ seconds.toFixed(1) }}</b>
  </div>
</template>

<style scoped>
.seat-countdown { position: relative; width: 42px; height: 42px; flex: 0 0 42px; display: grid; place-items: center; color: #f5d16f; filter: drop-shadow(0 3px 8px rgba(0,0,0,.35)); }
svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
circle { fill: rgba(4,27,23,.92); stroke-width: 4; }
.track { stroke: rgba(255,255,255,.13); }
.progress { stroke: #eac75f; stroke-linecap: round; stroke-dasharray: 100; transition: stroke-dashoffset .1s linear, stroke .2s; }
.clock-mark { position: absolute; top: 7px; font-size: 10px; line-height: 1; }
b { position: absolute; bottom: 7px; font-size: 8px; line-height: 1; font-variant-numeric: tabular-nums; }
.ai .progress { stroke: #75c8a1; }
.urgent { color: #ff8b7d; animation: timer-pulse .7s ease-in-out infinite alternate; }
.urgent .progress { stroke: #ef6559; }
@keyframes timer-pulse { to { transform: scale(1.06); filter: drop-shadow(0 0 9px rgba(239,101,89,.48)); } }
@media (pointer: coarse), (max-width: 700px), (max-height: 600px) {
  .seat-countdown { width: 34px; height: 34px; flex-basis: 34px; }
  .clock-mark { top: 5px; font-size: 8px; }
  b { bottom: 5px; font-size: 7px; }
}
</style>
