<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useAttrs } from 'vue'
import type { PortalGlassVariant } from './glassPresets'
import { portalWebGLScene } from './webgl/PortalWebGLScene'
import type { PointerSession } from './webgl/glassTypes'

defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ variant: PortalGlassVariant; backdropSelector?: string }>(), { variant: 'primaryButton', backdropSelector: '#portal-glass-live-backdrop' })
const attrs = useAttrs()
const glassRef = ref<HTMLElement | null>(null)
const surfaceId = `portal-glass-${Math.random().toString(36).slice(2)}`
const kind = props.variant === 'navLens' ? 'lens' : props.variant === 'sheet' || props.variant === 'menuButton' ? 'menu' : 'button'
let unregister: (() => void) | undefined
let pointerId = -1
let resetTimer: number | undefined
let lastPointerX = 0
let lastPointerY = 0
let lastPointerTime = 0
const pointerSession: PointerSession = { id: -1, active: false, startX: 0, startY: 0, x: 0, y: 0, prevX: 0, prevY: 0, velocityX: 0, velocityY: 0, dragX: 0, dragY: 0, pressAnchorX: 0, pressAnchorY: 0, dragged: false }

function isLiquidButtonSurface(): boolean {
  const element = glassRef.value
  return kind === 'button' || (kind === 'menu' && Boolean(element && element.offsetWidth < 100))
}

function updatePointer(event: PointerEvent): void {
  const element = glassRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const now = performance.now()
  const trackingPress = pointerSession.active
  const elapsed = Math.max(8, now - lastPointerTime)
  const velocityX = trackingPress ? (event.clientX - lastPointerX) / elapsed : 0
  const velocityY = trackingPress ? (event.clientY - lastPointerY) / elapsed : 0
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastPointerTime = now
  pointerSession.x = event.clientX
  pointerSession.y = event.clientY
  pointerSession.velocityX = velocityX
  pointerSession.velocityY = velocityY
  pointerSession.dragX = event.clientX - pointerSession.startX
  pointerSession.dragY = event.clientY - pointerSession.startY
  if (Math.hypot(pointerSession.dragX, pointerSession.dragY) > 5) pointerSession.dragged = true
  portalWebGLScene.setSurfacePointer(surfaceId, event.clientX, event.clientY, pointerSession.active, velocityX, velocityY, pointerSession.dragX, pointerSession.dragY, pointerSession.pressAnchorX, pointerSession.pressAnchorY)
  element.style.setProperty('--glass-pointer-x', `${((event.clientX - rect.left) / Math.max(1, rect.width)) * 100}%`)
  element.style.setProperty('--glass-pointer-y', `${((event.clientY - rect.top) / Math.max(1, rect.height)) * 100}%`)
}

function releasePointer(): void {
  portalWebGLScene.setSurfacePointer(surfaceId, 0, 0, false, 0, 0, pointerSession.dragX, pointerSession.dragY, pointerSession.pressAnchorX, pointerSession.pressAnchorY)
}
function onSurfacePointerDown(event: PointerEvent): void {
  if (!isLiquidButtonSurface() || pointerId !== -1) return
  event.stopPropagation()
  const element = glassRef.value
  if (!element) return
  pointerId = event.pointerId
  pointerSession.id = event.pointerId
  pointerSession.active = true
  pointerSession.startX = pointerSession.x = pointerSession.prevX = event.clientX
  pointerSession.startY = pointerSession.y = pointerSession.prevY = event.clientY
  pointerSession.velocityX = pointerSession.velocityY = 0
  pointerSession.dragX = pointerSession.dragY = 0
  const rect = element.getBoundingClientRect()
  pointerSession.pressAnchorX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
  pointerSession.pressAnchorY = ((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1
  pointerSession.dragged = false
  updatePointer(event)
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastPointerTime = performance.now()
  window.clearTimeout(resetTimer)
  element.classList.add('is-liquid-pressed')
  // The DOM hit layer stays at its layout size. The WebGL SDF is the only
  // layer allowed to deform the visible glass shape.
  try { element.setPointerCapture(pointerId) } catch { /* pointer capture is optional */ }
}

function onSurfacePointerMove(event: PointerEvent): void {
  if (!isLiquidButtonSurface() || event.pointerId !== pointerId) return
  event.stopPropagation()
}

function onSurfacePointerUp(event: PointerEvent): void {
  if (!isLiquidButtonSurface() || event.pointerId !== pointerId) return
  event.stopPropagation()
  const element = glassRef.value
  pointerId = -1
  pointerSession.active = false
  pointerSession.id = -1
  try { element?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  if (!element) return
  element.dataset.liquidDragged = pointerSession.dragged ? 'true' : 'false'
  element.classList.remove('is-liquid-pressed')
  element.classList.add('is-liquid-settling')
  resetTimer = window.setTimeout(() => {
    element.classList.remove('is-liquid-settling')
    delete element.dataset.liquidDragged
  }, 320)
}
function refreshBackdrop(): Promise<void> { portalWebGLScene.refreshSurfaceBounds(); return Promise.resolve() }

onMounted(() => {
  const element = glassRef.value
  if (!element) return
  unregister = portalWebGLScene.registerSurface(surfaceId, element, kind)
  element.addEventListener('pointermove', (event) => updatePointer(event as PointerEvent))
  element.addEventListener('pointerdown', (event) => updatePointer(event as PointerEvent))
  element.addEventListener('pointerdown', onSurfacePointerDown)
  element.addEventListener('pointermove', onSurfacePointerMove)
  element.addEventListener('pointerup', onSurfacePointerUp)
  element.addEventListener('pointercancel', onSurfacePointerUp)
  element.addEventListener('pointerup', releasePointer)
  element.addEventListener('pointercancel', releasePointer)
})

onBeforeUnmount(() => { window.clearTimeout(resetTimer); unregister?.() })
defineExpose({ refreshBackdrop, element: glassRef })
</script>

<template>
  <div ref="glassRef" v-bind="attrs" class="portal-glass-surface" :class="`portal-glass-surface--${props.variant}`">
    <slot />
  </div>
</template>
