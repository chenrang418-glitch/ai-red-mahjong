<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GameId } from './gameManifest'
import mahjongDesktop from '../assets/portal-backgrounds/mahjong-desktop.png'
import mahjongMobile from '../assets/portal-backgrounds/mahjong-mobile.png'
import sanguoDesktop from '../assets/portal-backgrounds/sanguo-desktop.png'
import sanguoMobile from '../assets/portal-backgrounds/sanguo-mobile.png'
import { portalWebGLScene } from './webgl/PortalWebGLScene'

const props = defineProps<{ game: GameId }>()
const emit = defineEmits<{ stable: [game: GameId]; sweep: []; ready: [] }>()
const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const isAvailable = ref(true)
const isReady = ref(false)
const isSweeping = ref(false)
const debug = ref(false)
const debugText = ref('')
const sources = { mahjong: { desktop: mahjongDesktop, mobile: mahjongMobile }, sanguosha: { desktop: sanguoDesktop, mobile: sanguoMobile } }
let mediaQuery: MediaQueryList | undefined
let debugTimer: number | undefined
let sweepTimer: number | undefined
let sweepFrame: number | undefined
let unsubscribeAvailability: (() => void) | undefined
const SWEEP_DURATION = 1800

function isMobile(): boolean { return window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches }
function sourcePair(): [string, string] { const mobile = isMobile(); return [mobile ? sources.mahjong.mobile : sources.mahjong.desktop, mobile ? sources.sanguosha.mobile : sources.sanguosha.desktop] }
function updateDebug(): void { const info = portalWebGLScene.debugInfo(); debugText.value = `${info.renderer} · ${info.fps || '--'} FPS · DPR ${info.dpr.toFixed(2)} · textures ${info.textures} · draws ${info.draws} · surfaces ${info.surfaces} · progress ${info.progress.toFixed(2)} · glass ${info.glassMaterial}/${info.glassDebug} · liquid nodes ${info.liquidNodes} · area ${info.liquidArea.toFixed(3)} · pressure ${info.liquidPressure.toFixed(2)} · dt ${(info.liquidTimestep * 1000).toFixed(2)}ms` }
function handleViewportChange(): void { void portalWebGLScene.preload(sourcePair()) }
function startSweepClock(): void {
  window.cancelAnimationFrame(sweepFrame ?? 0)
  const startedAt = performance.now()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const targets = ['#portal-glass-live-backdrop', '.portal-topbar', '.portal-stage', '.portal-bottom']
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .filter((element): element is HTMLElement => element !== null)
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
  const clipRectangleToDiagonal = (c: number): Array<[number, number]> => {
    const corners: Array<[number, number]> = [[0, 0], [viewportWidth, 0], [viewportWidth, viewportHeight], [0, viewportHeight]]
    const points: Array<[number, number]> = []
    for (let index = 0; index < corners.length; index += 1) {
      const current = corners[index]
      const next = corners[(index + 1) % corners.length]
      const currentInside = current[0] + current[1] >= c
      const nextInside = next[0] + next[1] >= c
      if (currentInside !== nextInside) {
        const currentValue = current[0] + current[1]
        const nextValue = next[0] + next[1]
        const ratio = (c - currentValue) / (nextValue - currentValue)
        points.push([current[0] + (next[0] - current[0]) * ratio, current[1] + (next[1] - current[1]) * ratio])
      }
      if (nextInside) points.push(next)
    }
    return points
  }
  const applyClip = (progress: number): void => {
    const diagonal = (viewportWidth + viewportHeight + 2) * (1 - progress) - 1
    for (const target of targets) {
      if (progress >= 1) {
        target.element.style.setProperty('clip-path', 'none', 'important')
        continue
      }
      const points = clipRectangleToDiagonal(diagonal)
      if (points.length === 0) {
        target.element.style.setProperty('clip-path', 'polygon(100% 100%, 100% 100%, 100% 100%)', 'important')
        continue
      }
      const localPoints = points.map(([x, y]) => `${(x - target.rect.left).toFixed(2)}px ${(y - target.rect.top).toFixed(2)}px`)
      target.element.style.setProperty('clip-path', `polygon(${localPoints.join(', ')})`, 'important')
    }
  }
  const tick = (now: number): void => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / SWEEP_DURATION))
    applyClip(progress)
    if (progress < 1) sweepFrame = window.requestAnimationFrame(tick)
  }
  sweepFrame = window.requestAnimationFrame(tick)
}

onMounted(async () => {
  debug.value = import.meta.env.DEV && new URLSearchParams(window.location.search).get('webglDebug') === '1'
  if (stageRef.value && canvasRef.value) portalWebGLScene.mount(canvasRef.value, stageRef.value)
  isAvailable.value = portalWebGLScene.isAvailable()
  unsubscribeAvailability = portalWebGLScene.onAvailabilityChange((available) => {
    isAvailable.value = available
    isReady.value = available && portalWebGLScene.isAvailable()
    if (!available) isSweeping.value = false
  })
  // 场景是单例，首次绘制必须直接对齐当前游戏，不能继承上一次页面的进度。
  portalWebGLScene.setGame(props.game, true)
  await portalWebGLScene.preload(sourcePair())
  isAvailable.value = portalWebGLScene.isAvailable()
  // 等 WebGL 至少完成一帧真实绘制后再淡入，避免把未初始化的黑色画布露出来。
  if (isAvailable.value) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    isReady.value = portalWebGLScene.isAvailable()
    if (isReady.value) {
      isSweeping.value = true
      emit('sweep')
      startSweepClock()
      await new Promise<void>((resolve) => { sweepTimer = window.setTimeout(resolve, SWEEP_DURATION) })
      isSweeping.value = false
    }
  }
  emit('stable', props.game)
  emit('ready')
  mediaQuery = window.matchMedia('(max-width: 700px) and (orientation: portrait)')
  mediaQuery.addEventListener('change', handleViewportChange)
  if (debug.value) { updateDebug(); debugTimer = window.setInterval(updateDebug, 500) }
})

watch(() => props.game, (game) => { portalWebGLScene.setGame(game); window.setTimeout(() => emit('stable', game), 350) })
onBeforeUnmount(() => { unsubscribeAvailability?.(); mediaQuery?.removeEventListener('change', handleViewportChange); window.clearInterval(debugTimer); window.clearTimeout(sweepTimer); window.cancelAnimationFrame(sweepFrame ?? 0); portalWebGLScene.dispose() })
</script>

<template>
  <div ref="stageRef" id="portal-glass-backdrop" class="portal-background-stage" :class="[{ 'is-webgl-fallback': !isAvailable, 'is-webgl-ready': isReady, 'is-webgl-sweeping': isSweeping }, `is-game-${props.game}`]" aria-hidden="true">
    <canvas id="portal-glass-live-backdrop" ref="canvasRef" class="portal-live-backdrop" />
    <canvas id="portal-liquid-debug" class="portal-liquid-debug" />
    <img class="portal-background-layer portal-background-layer--mahjong" :src="isMobile() ? sources.mahjong.mobile : sources.mahjong.desktop" alt="" draggable="false" />
    <img class="portal-background-layer portal-background-layer--sanguosha" :src="isMobile() ? sources.sanguosha.mobile : sources.sanguosha.desktop" alt="" draggable="false" />
    <output v-if="debug" class="portal-webgl-debug">{{ debugText }}</output>
  </div>
</template>
