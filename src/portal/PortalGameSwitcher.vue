<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { GameDefinition } from './gameManifest'
import PortalGlassSurface from './PortalGlassSurface.vue'
import { portalWebGLScene } from './webgl/PortalWebGLScene'

const props = defineProps<{ games: readonly GameDefinition[]; active: number; backdropSelector?: string }>()
const emit = defineEmits<{ select: [index: number] }>()
const switcherRef = ref<HTMLElement | null>(null)
const sliderRef = ref<HTMLElement | null>(null)
const isDragging = ref(false)
const buttonRefs: HTMLButtonElement[] = []
let down = false
let pointerId = -1
let startY = 0
let startSliderY = 0
let maxSliderY = 0
let lastY = 0
let lastTime = 0
let lastPointerX = 0
let lastPointerY = 0
let settleTimer: number | undefined
let lastPointerTarget: number | null = null
let boundsFrame = 0
let settleFrame = 0

function setButtonRef(element: unknown, index: number): void {
  if (element instanceof HTMLButtonElement) buttonRefs[index] = element
}

function pose(y: number, _sx = 1, _sy = 1, animated = false): void {
  const slider = sliderRef.value
  if (!slider) return
  slider.classList.toggle('is-dragging', !animated)
  slider.classList.toggle('is-settling', animated)
  // 位移、拉伸和 WebGL 形变都由这一帧的 pose 共同驱动，避免滑块出现
  // CSS 在前、玻璃在后的错位感。
  slider.style.transform = `translate3d(-50%, ${y}px, 0) scale(${_sx}, ${_sy})`
  if (!boundsFrame) {
    boundsFrame = window.requestAnimationFrame(() => {
      boundsFrame = 0
      portalWebGLScene.refreshSurfaceBounds()
    })
  }
}

function syncLensGesture(y: number, pressed: boolean, pointerX = lastPointerX, pointerY = lastPointerY, velocityY = 0): void {
  const glass = sliderRef.value?.querySelector<HTMLElement>('.portal-glass-surface')
  if (!glass) return
  portalWebGLScene.setSurfacePointerForElement(glass, pointerX, pointerY, pressed, 0, velocityY, 0, y)
}

function cancelSettleAnimation(): void {
  if (settleFrame) window.cancelAnimationFrame(settleFrame)
  settleFrame = 0
}

function maxY(): number {
  const shell = switcherRef.value
  const slider = sliderRef.value
  if (!shell || !slider) return 0
  const shellRect = shell.getBoundingClientRect()
  const baseTop = Number.parseFloat(getComputedStyle(slider).top) || 0
  const sliderBaseCenter = shellRect.top + baseTop + slider.offsetHeight / 2
  const bottomNode = buttonRefs[buttonRefs.length - 1]?.getBoundingClientRect()
  return bottomNode ? Math.max(0, bottomNode.top + bottomNode.height / 2 - sliderBaseCenter) : 0
}

function targetY(index: number): number {
  const shell = switcherRef.value
  const slider = sliderRef.value
  const node = buttonRefs[index]
  if (!shell || !slider || !node) return index === 0 ? 0 : maxSliderY
  const shellRect = shell.getBoundingClientRect()
  const baseTop = Number.parseFloat(getComputedStyle(slider).top) || 0
  const sliderBaseCenter = shellRect.top + baseTop + slider.offsetHeight / 2
  const nodeRect = node.getBoundingClientRect()
  return nodeRect.top + nodeRect.height / 2 - sliderBaseCenter
}

function currentY(): number {
  const transform = sliderRef.value ? getComputedStyle(sliderRef.value).transform : ''
  if (transform && transform !== 'none') {
    const matrix = new DOMMatrixReadOnly(transform)
    return Math.max(0, Math.min(maxSliderY, matrix.m42))
  }
  return props.active === 0 ? 0 : maxSliderY
}

function snap(index: number): void {
  maxSliderY = maxY()
  window.clearTimeout(settleTimer)
  cancelSettleAnimation()
  const from = currentY()
  const to = Math.max(0, Math.min(maxSliderY, targetY(index)))
  const startedAt = performance.now()
  const duration = 240
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    pose(from + (to - from) * eased, 1, 1, true)
    if (progress < 1) settleFrame = window.requestAnimationFrame(tick)
    else {
      settleFrame = 0
      pose(to, 1, 1, true)
      settleTimer = window.setTimeout(() => sliderRef.value?.classList.remove('is-settling'), 40)
    }
  }
  settleFrame = window.requestAnimationFrame(tick)
}

function onDown(event: PointerEvent): void {
  const shell = switcherRef.value
  if (!shell || down) return
  event.stopPropagation()
  cancelSettleAnimation()
  pointerId = event.pointerId
  shell.setPointerCapture(pointerId)
  maxSliderY = maxY()
  startSliderY = currentY()
  startY = lastY = event.clientY
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  lastTime = performance.now()
  down = true
  isDragging.value = false
  pose(startSliderY, 0.92, 1.08)
  syncLensGesture(startSliderY, true, event.clientX, event.clientY)
}

function onMove(event: PointerEvent): void {
  if (!down || event.pointerId !== pointerId) return
  const dy = event.clientY - startY
  if (!isDragging.value) {
    if (Math.abs(dy) < 8) return
    isDragging.value = true
  }
  event.preventDefault()
  event.stopPropagation()
  const now = performance.now()
  const rawY = startSliderY + dy
  const y = rawY < 0 ? rawY * 0.18 : rawY > maxSliderY ? maxSliderY + (rawY - maxSliderY) * 0.18 : rawY
  const velocity = (event.clientY - lastY) / Math.max(1, now - lastTime)
  const stretch = Math.min(1.22, Math.max(1.08, 1.08 + Math.abs(velocity) * 0.05))
  pose(y, 0.98 - Math.min(0.06, Math.abs(velocity) * 0.02), stretch)
  lastPointerX = event.clientX
  lastPointerY = event.clientY
  syncLensGesture(y, true, event.clientX, event.clientY, velocity)
  lastY = event.clientY
  lastTime = now
}

function release(event: PointerEvent): void {
  try { switcherRef.value?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
}

function onUp(event: PointerEvent): void {
  if (!down || event.pointerId !== pointerId) return
  event.stopPropagation()
  const shell = switcherRef.value
  const dy = event.clientY - startY
  const rect = shell?.getBoundingClientRect()
  const projectedY = Math.max(0, Math.min(maxSliderY, startSliderY + dy))
  const firstNode = buttonRefs[0]?.getBoundingClientRect()
  const lastNode = buttonRefs[buttonRefs.length - 1]?.getBoundingClientRect()
  const midpoint = firstNode && lastNode
    ? ((firstNode.top + firstNode.height / 2) + (lastNode.top + lastNode.height / 2)) / 2
    : rect ? rect.top + rect.height / 2 : 0
  const target = !isDragging.value ? (event.clientY < midpoint ? 0 : 1) : projectedY / Math.max(1, maxSliderY) >= 0.5 ? 1 : 0
  down = false
  isDragging.value = false
  release(event)
  syncLensGesture(projectedY, false, event.clientX, event.clientY)
  snap(target)
  lastPointerTarget = target
  if (target !== props.active) emit('select', target)
}

function onCancel(event: PointerEvent): void {
  if (!down || event.pointerId !== pointerId) return
  down = false
  isDragging.value = false
  release(event)
  snap(props.active)
}

function selectByTap(index: number): void {
  if (lastPointerTarget === index) {
    lastPointerTarget = null
    return
  }
  if (index === props.active) return
  snap(index)
  emit('select', index)
}

watch(() => props.active, () => { if (!down) nextTick(() => snap(props.active)) }, { immediate: true })
onBeforeUnmount(() => {
  window.clearTimeout(settleTimer)
  cancelSettleAnimation()
  if (boundsFrame) window.cancelAnimationFrame(boundsFrame)
})
</script>

<template>
  <nav ref="switcherRef" class="portal-switcher portal-switcher--vertical" :class="{ 'is-dragging': isDragging }" aria-label="选择游戏" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onCancel">
    <span class="portal-switcher__track" aria-hidden="true" />
    <span ref="sliderRef" class="portal-switcher__active" aria-hidden="true">
       <PortalGlassSurface class="portal-switcher__active-glass" variant="navLens" :backdrop-selector="backdropSelector" />
    </span>
    <button v-for="(game, index) in games" :key="game.id" :ref="(element) => setButtonRef(element, index)" class="portal-switcher__node" :class="{ 'is-top': index === 0, 'is-bottom': index === 1 }" type="button" :aria-label="game.name" :aria-current="active === index" @click.stop="selectByTap(index)" />
    <span v-if="isDragging" class="portal-switcher__drag-label portal-switcher__drag-label--top" aria-live="polite">{{ games[0]?.name }}</span>
    <span v-if="isDragging" class="portal-switcher__drag-label portal-switcher__drag-label--bottom" aria-live="polite">{{ games[1]?.name }}</span>
  </nav>
</template>
