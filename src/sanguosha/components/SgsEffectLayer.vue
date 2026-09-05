<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { StagedEvent } from '../composables/useSgsEventStage'
import { directedTargets, effectOwnerIds } from '../presentation/effects'
import ActionBurst from '../../components/game/ActionBurst.vue'

const props = defineProps<{ staged: StagedEvent | null }>()
const event = computed(() => props.staged?.event ?? null)
const skin = computed(() => props.staged?.skin ?? 'plain')
const burstTone = computed(() => {
  if (event.value?.kind === 'damage' || event.value?.kind === 'lose-hp') return 'strike'
  if (event.value?.kind === 'recover') return 'heal'
  if (event.value?.kind === 'skill') return 'violet'
  if (skin.value === 'nullify') return 'blue'
  return null
})
const root = ref<HTMLElement | null>(null)
const paths = ref<string[]>([])
const floatPositions = ref<Array<{ id: string; x: number; y: number }>>([])
let observer: ResizeObserver | null = null

/**
 * 只有真正指向别人的事件才画箭头。
 *
 * 装备坐骑、对自己用【桃】这类事件的 targetIds 里就是自己，
 * 照画会从座位画一条指向自己的退化曲线，看着像个污点。
 */
const directed = computed(() => {
  const current = event.value
  if (!current?.sourceId) return []
  return directedTargets(current).map((targetId) => ({ sourceId: current.sourceId!, targetId }))
})
const floatText = computed(() => {
  const event = props.staged?.event
  if (!event) return ''
  if (event.kind === 'damage' || event.kind === 'lose-hp') return `-${event.amount ?? 1}`
  if (event.kind === 'recover') return `+${event.amount ?? 1}`
  if (event.kind === 'card-response') return event.cardName ? `【${event.cardName}】` : ''
  if (event.kind === 'skill') return event.skillName ? `【${event.skillName}】` : ''
  if (event.kind === 'judge') return event.cardName ? `【${event.cardName}】` : ''
  if (event.kind === 'card-use' && event.cardName === '无懈可击') return '【无懈可击】'
  if (event.kind === 'death') return '阵亡'
  if (event.kind === 'dying') return '濒死'
  return ''
})

function centerOf(id: string): { x: number; y: number } | null {
  const container = root.value?.parentElement
  const seat = container?.querySelector<HTMLElement>(`[data-seat-id="${CSS.escape(id)}"]`)
  if (!container || !seat) return null
  const outer = container.getBoundingClientRect(), rect = seat.getBoundingClientRect()
  return { x: rect.left - outer.left + rect.width / 2, y: rect.top - outer.top + rect.height / 2 }
}

function floatAnchorOf(id: string): { x: number; y: number } | null {
  const container = root.value?.parentElement
  const seat = container?.querySelector<HTMLElement>(`[data-seat-id="${CSS.escape(id)}"]`)
  if (!container || !seat) return null
  const outer = container.getBoundingClientRect(), rect = seat.getBoundingClientRect()
  return {
    x: Math.max(20, Math.min(outer.width - 20, rect.left - outer.left + rect.width / 2)),
    y: Math.max(22, Math.min(outer.height - 22, rect.top - outer.top + Math.min(32, rect.height * .32))),
  }
}

async function updateGeometry(): Promise<void> {
  await nextTick()
  paths.value = directed.value.flatMap((link) => {
    const source = centerOf(link.sourceId), target = centerOf(link.targetId)
    if (!source || !target) return []
    const lift = Math.max(18, Math.abs(target.x - source.x) * .08)
    return [`M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${Math.min(source.y, target.y) - lift} ${target.x} ${target.y}`]
  })
  floatPositions.value = effectOwnerIds(event.value).flatMap((id) => {
    const point = floatAnchorOf(id)
    return point ? [{ id, ...point }] : []
  })
}

watch(() => event.value?.id, updateGeometry, { immediate: true })
onMounted(() => { observer = new ResizeObserver(updateGeometry); if (root.value?.parentElement) observer.observe(root.value.parentElement); void updateGeometry() })
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="root" class="sgs-effects" aria-hidden="true">
    <template v-if="burstTone">
      <ActionBurst v-for="point in floatPositions" :key="`burst-${event?.id}-${point.id}`" :tone="burstTone" :style="{ left: `${point.x}px`, top: `${point.y}px` }" />
    </template>
    <svg v-if="paths.length" class="sgs-effects__svg" :class="`sgs-effects__svg--${skin}`"><defs><marker id="sgs-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" /></marker></defs><path v-for="(path,index) in paths" :key="`${event?.id}-${index}`" :d="path" class="sgs-effects__path" :class="`sgs-effects__path--${skin}`" marker-end="url(#sgs-arrow)" /></svg>
    <template v-if="floatText">
      <div v-for="point in floatPositions" :key="`${event?.id}-${point.id}`" class="sgs-effects__float sgs-effects__float--positioned" :class="[`sgs-effects__float--${event?.kind}`, `sgs-effects__float--skin-${skin}`]" :style="{ left: `${point.x}px`, top: `${point.y}px` }" :data-effect-target="point.id">{{ floatText }}</div>
      <div v-if="!floatPositions.length" :key="event?.id" class="sgs-effects__float" :class="[`sgs-effects__float--${event?.kind}`, `sgs-effects__float--skin-${skin}`]">{{ floatText }}</div>
    </template>
  </div>
</template>

<style scoped>
.sgs-effects{position:absolute;inset:0;z-index:5;pointer-events:none}.sgs-effects__svg{width:100%;height:100%;overflow:visible}.sgs-effects__path{fill:none;stroke:#ef6f58;stroke-width:3;stroke-linecap:round;stroke-dasharray:10 7;filter:drop-shadow(0 0 4px rgba(239,85,62,.75));animation:sgs-arrow-flow .55s linear 3,sgs-arrow-in .25s ease-out both}.sgs-effects marker path{fill:#ef6f58}.sgs-effects__float{position:absolute;left:50%;top:47%;transform:translate(-50%,-50%);font-size:28px;font-weight:900;color:#ff7968;text-shadow:0 3px 12px #000;animation:sgs-float .7s ease-out both}.sgs-effects__float--recover{color:#69db91}.sgs-effects__float--card-response{color:#f4ecd4;font-size:22px}.sgs-effects__float--skill{color:#d8bdff;font-size:22px}@keyframes sgs-arrow-flow{to{stroke-dashoffset:-17}}@keyframes sgs-arrow-in{from{opacity:0}}@keyframes sgs-float{0%{opacity:0;transform:translate(-50%,-25%) scale(.7)}30%{opacity:1;transform:translate(-50%,-55%) scale(1.12)}100%{opacity:0;transform:translate(-50%,-95%) scale(1)}}@media(prefers-reduced-motion:reduce){.sgs-effects__path{animation:none;stroke-dasharray:none}.sgs-effects__float{animation:none;opacity:1}}
/*
 * 皮肤：不同事件要读起来不一样，否则一串动作在余光里全是同一坨。
 * 浮字动画时长都短于队列给该事件的停留时间，播完不会被下一条截断。
 */
/* 闪：横向连抖，读作「侧身躲开」，不再向上飘 */
.sgs-effects__float--skin-dodge { color: #eaf3e4; font-size: 24px; animation: sgs-dodge .5s ease-out both; }
/* 判定：翻牌亮出来 */
.sgs-effects__float--skin-judge { color: #d9c2ff; font-size: 24px; animation: sgs-judge-flip .7s ease-out both; }
/* 无懈：横向对冲，表现「顶回去」 */
.sgs-effects__float--skin-nullify { color: #9fd8ff; font-size: 24px; animation: sgs-nullify .6s ease-out both; }
/* 伤害类加重：更大、抖一下 */
.sgs-effects__float--skin-strike { font-size: 34px; animation: sgs-strike .8s ease-out both; }
.sgs-effects__float--death, .sgs-effects__float--dying { font-size: 26px; letter-spacing: .2em; }

/* 指向线跟着皮肤换色，红色只留给真正造成伤害的那条 */
.sgs-effects__svg--nullify marker path { fill: #6fb9e8; }
.sgs-effects__svg--heal marker path { fill: #63cd8b; }
.sgs-effects__svg--plain marker path, .sgs-effects__svg--dodge marker path, .sgs-effects__svg--judge marker path { fill: #d8c07f; }
.sgs-effects__path--nullify { stroke: #6fb9e8; filter: drop-shadow(0 0 4px rgba(90,170,225,.7)); }
.sgs-effects__path--heal { stroke: #63cd8b; filter: drop-shadow(0 0 4px rgba(80,200,130,.7)); }
.sgs-effects__path--plain, .sgs-effects__path--dodge, .sgs-effects__path--judge { stroke: #d8c07f; filter: drop-shadow(0 0 4px rgba(210,180,110,.6)); }

@keyframes sgs-dodge { 0% { opacity: 0; transform: translate(-50%,-50%) scale(.8); } 25% { opacity: 1; transform: translate(-70%,-50%) scale(1.02); } 55% { transform: translate(-35%,-50%) scale(1.02); } 78% { transform: translate(-55%,-50%) scale(1); } 100% { opacity: 0; transform: translate(-50%,-50%) scale(.95); } }
@keyframes sgs-judge-flip { 0% { opacity: 0; transform: translate(-50%,-50%) rotateY(-90deg) scale(.8); } 35% { opacity: 1; transform: translate(-50%,-50%) rotateY(0) scale(1.12); } 100% { opacity: 0; transform: translate(-50%,-72%) rotateY(0) scale(1); } }
@keyframes sgs-nullify { 0% { opacity: 0; transform: translate(-75%,-50%) scale(.9); } 40% { opacity: 1; transform: translate(-50%,-50%) scale(1.16); } 62% { transform: translate(-50%,-50%) scale(.98); } 100% { opacity: 0; transform: translate(-25%,-50%) scale(.95); } }
@keyframes sgs-strike { 0% { opacity: 0; transform: translate(-50%,-40%) scale(.6); } 18% { opacity: 1; transform: translate(-50%,-58%) scale(1.12); } 32% { transform: translate(-54%,-58%) scale(1.18); } 46% { transform: translate(-46%,-58%) scale(1.18); } 100% { opacity: 0; transform: translate(-50%,-100%) scale(1); } }

@media (prefers-reduced-motion: reduce) {
  .sgs-effects__float--skin-dodge, .sgs-effects__float--skin-judge,
  .sgs-effects__float--skin-nullify, .sgs-effects__float--skin-strike { animation: none; opacity: 1; }
}
</style>
