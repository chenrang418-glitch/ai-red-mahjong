<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PresentationEvent } from '../engine/presentation'

const props = defineProps<{ event: PresentationEvent | null }>()
const root = ref<HTMLElement | null>(null)
const path = ref('')
let observer: ResizeObserver | null = null

const directed = computed(() => props.event?.sourceId && props.event.targetIds?.length ? props.event : null)
const floatText = computed(() => {
  const event = props.event
  if (!event) return ''
  if (event.kind === 'damage' || event.kind === 'lose-hp') return `-${event.amount ?? 1}`
  if (event.kind === 'recover') return `+${event.amount ?? 1}`
  if (event.kind === 'card-response') return event.cardName ? `【${event.cardName}】` : ''
  if (event.kind === 'skill') return event.skillName ? `【${event.skillName}】` : ''
  return ''
})

function centerOf(id: string): { x: number; y: number } | null {
  const container = root.value?.parentElement
  const seat = container?.querySelector<HTMLElement>(`[data-seat-id="${CSS.escape(id)}"]`)
  if (!container || !seat) return null
  const outer = container.getBoundingClientRect(), rect = seat.getBoundingClientRect()
  return { x: rect.left - outer.left + rect.width / 2, y: rect.top - outer.top + rect.height / 2 }
}

async function updatePath(): Promise<void> {
  await nextTick()
  const event = directed.value
  if (!event?.sourceId || !event.targetIds?.[0]) { path.value = ''; return }
  const source = centerOf(event.sourceId), target = centerOf(event.targetIds[0])
  if (!source || !target) { path.value = ''; return }
  const lift = Math.max(18, Math.abs(target.x - source.x) * .08)
  path.value = `M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${Math.min(source.y, target.y) - lift} ${target.x} ${target.y}`
}

watch(() => props.event?.id, updatePath, { immediate: true })
onMounted(() => { observer = new ResizeObserver(updatePath); if (root.value?.parentElement) observer.observe(root.value.parentElement); void updatePath() })
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="sgs-effects" aria-hidden="true">
    <svg v-if="path" class="sgs-effects__svg"><defs><marker id="sgs-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" /></marker></defs><path :key="event?.id" :d="path" class="sgs-effects__path" marker-end="url(#sgs-arrow)" /></svg>
    <div v-if="floatText" :key="event?.id" class="sgs-effects__float" :class="`sgs-effects__float--${event?.kind}`">{{ floatText }}</div>
  </div>
</template>

<style scoped>
.sgs-effects{position:absolute;inset:0;z-index:5;pointer-events:none}.sgs-effects__svg{width:100%;height:100%;overflow:visible}.sgs-effects__path{fill:none;stroke:#ef6f58;stroke-width:3;stroke-linecap:round;stroke-dasharray:10 7;filter:drop-shadow(0 0 4px rgba(239,85,62,.75));animation:sgs-arrow-flow .55s linear infinite,sgs-arrow-in .25s ease-out both}.sgs-effects marker path{fill:#ef6f58}.sgs-effects__float{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);font-size:28px;font-weight:900;color:#ff7968;text-shadow:0 3px 12px #000;animation:sgs-float .7s ease-out both}.sgs-effects__float--recover{color:#69db91}.sgs-effects__float--card-response{color:#f4ecd4;font-size:22px}.sgs-effects__float--skill{color:#d8bdff;font-size:22px}@keyframes sgs-arrow-flow{to{stroke-dashoffset:-17}}@keyframes sgs-arrow-in{from{opacity:0}}@keyframes sgs-float{0%{opacity:0;transform:translate(-50%,-25%) scale(.7)}30%{opacity:1;transform:translate(-50%,-55%) scale(1.12)}100%{opacity:0;transform:translate(-50%,-95%) scale(1)}}@media(prefers-reduced-motion:reduce){.sgs-effects__path{animation:none;stroke-dasharray:none}.sgs-effects__float{animation:none;opacity:1}}
</style>
