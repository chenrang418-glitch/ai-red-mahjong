<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'gold' | 'strike' | 'heal' | 'blue' | 'violet' }>(), { tone: 'gold' })

// 固定方向避免随机布局抖动；粒子仅随公开动作挂载，动画结束后保持透明。
const rays = Array.from({ length: 8 }, (_, index) => {
  const angle = index * Math.PI / 4
  return { '--burst-x': `${Math.cos(angle) * 38}px`, '--burst-y': `${Math.sin(angle) * 30}px`, '--burst-delay': `${index % 3 * 25}ms` }
})
</script>

<template>
  <span class="action-burst" :class="`action-burst--${tone}`" aria-hidden="true">
    <span class="action-burst__ring"></span>
    <i v-for="(ray, index) in rays" :key="index" :style="ray"></i>
  </span>
</template>

<style scoped>
.action-burst { --burst-color: #eac889; position: absolute; width: 0; height: 0; pointer-events: none; z-index: 6; color: var(--burst-color); }
.action-burst--strike { --burst-color: #f79571; }
.action-burst--heal { --burst-color: #82dfb0; }
.action-burst--blue { --burst-color: #9cd9f5; }
.action-burst--violet { --burst-color: #ccb3f4; }
.action-burst__ring { position: absolute; width: 46px; height: 46px; margin: -23px; border: 1px solid currentColor; border-radius: 50%; background: radial-gradient(circle, transparent 35%, currentColor 100%); opacity: 0; animation: burst-ring .5s ease-out both; }
.action-burst i { position: absolute; width: 3px; height: 3px; margin: -1.5px; border-radius: 50%; background: currentColor; box-shadow: 0 0 5px currentColor; opacity: 0; animation: burst-ray .56s cubic-bezier(.16,.65,.3,1) var(--burst-delay) both; }
@keyframes burst-ring { 0% { opacity: .35; transform: scale(.35); } 100% { opacity: 0; transform: scale(1.6); } }
@keyframes burst-ray { 0% { opacity: 0; transform: scale(.5); } 20% { opacity: .85; } 100% { opacity: 0; transform: translate(var(--burst-x), var(--burst-y)) scale(.2); } }
@media (max-width: 700px) { .action-burst i:nth-of-type(n+7) { display: none; } }
@media (prefers-reduced-motion: reduce) { .action-burst { display: none; } .action-burst * { animation: none; } }
</style>
