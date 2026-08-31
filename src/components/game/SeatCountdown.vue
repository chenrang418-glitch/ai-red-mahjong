<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  progress: number
  seconds: number
  ai?: boolean
}>()

const normalizedProgress = computed(() => Math.max(0, Math.min(1, props.progress)))
const dashOffset = computed(() => 100 * (1 - normalizedProgress.value))
const displaySeconds = computed(() => Math.max(0, Math.ceil(props.seconds)))
// AI 的思考时长本来就只有三四秒，按剩余比例判定会让它每次出牌前都闪一次红。
// 只对真人回合按剩余的绝对秒数提示紧张。
const urgent = computed(() => !props.ai && props.seconds <= 5)
</script>

<template>
  <div
    class="seat-countdown"
    :class="{ urgent, ai }"
    role="timer"
    :aria-label="`${ai ? 'AI思考' : '操作'}剩余 ${displaySeconds} 秒`"
  >
    <!-- pathLength 把周长归一化成 100，dashoffset 才能和百分比精确对应，
         否则 r=16 的实际周长是 100.53，环走满时首尾会留下细缝 -->
    <svg viewBox="0 0 42 42" aria-hidden="true">
      <circle class="track" cx="21" cy="21" r="16" pathLength="100" />
      <circle class="progress" cx="21" cy="21" r="16" pathLength="100" :style="{ strokeDashoffset: dashOffset }" />
    </svg>
    <b>{{ displaySeconds }}</b>
  </div>
</template>

<style scoped>
.seat-countdown { position: relative; width: 50px; height: 50px; flex: 0 0 50px; display: grid; place-items: center; color: #f5d16f; filter: drop-shadow(0 3px 8px rgba(0,0,0,.35)); }
svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
circle { fill: rgba(4,27,23,.92); stroke-width: 4; }
.track { stroke: rgba(255,255,255,.13); }
.progress { stroke: #eac75f; stroke-linecap: round; stroke-dasharray: 100; transition: stroke-dashoffset .25s linear, stroke .2s; }
b { position: relative; font-size: 19px; line-height: 1; font-weight: 800; font-variant-numeric: tabular-nums; }
.ai .progress { stroke: #75c8a1; }
.urgent { color: #ff8b7d; animation: timer-pulse .7s ease-in-out infinite alternate; }
.urgent .progress { stroke: #ef6559; }
@keyframes timer-pulse { to { transform: scale(1.06); filter: drop-shadow(0 0 9px rgba(239,101,89,.48)); } }
@media (prefers-reduced-motion: reduce) {
  .urgent { animation: none; }
  .progress { transition: none; }
}
@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .seat-countdown { width: 40px; height: 40px; flex-basis: 40px; }
  b { font-size: 16px; }
}
</style>
