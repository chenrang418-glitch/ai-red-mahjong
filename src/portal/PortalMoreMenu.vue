<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import FullDisclaimerModal from '@/components/ProjectNotice/FullDisclaimerModal.vue'
import ContactDeveloperModal from '@/components/ProjectNotice/ContactDeveloperModal.vue'
import PortalGlassSurface from './PortalGlassSurface.vue'

const props = defineProps<{ open: boolean; backdropSelector?: string }>()
const emit = defineEmits<{ open: []; close: [] }>()
const showDisclaimer = ref(false)
const showContact = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const morphRef = ref<{ element: HTMLElement | null } | null>(null)
const handleRef = ref<HTMLElement | null>(null)
type DragState = 'idle' | 'press' | 'dragging' | 'settling'
const dragState = ref<DragState>('idle')
const morphPhase = ref<'idle' | 'opening' | 'closing'>('idle')
let pointerId = -1
let startY = 0
let startX = 0
let dragX = 0
let dragY = 0
let settleTimer: number | undefined
let motionFrame = 0
let pendingX = 0
let pendingY = 0
let itemPointerId = -1
let itemElement: HTMLElement | null = null
let itemStartX = 0
let itemStartY = 0
let itemDragX = 0
let itemDragY = 0
let itemDragged = false
let itemResetTimer: number | undefined
let transformFrame = 0

function setMenuItemTransform(element: HTMLElement, x: number, y: number, settling = false): void {
  void x
  void y
  element.style.removeProperty('transform')
  element.classList.toggle('is-liquid-settling', settling)
}

function onMenuButtonDown(event: PointerEvent): void {
  if (itemPointerId !== -1) return
  const element = event.currentTarget as HTMLButtonElement | null
  if (!element || element.disabled) return
  itemPointerId = event.pointerId
  itemElement = element
  itemStartX = event.clientX
  itemStartY = event.clientY
  itemDragX = 0
  itemDragY = 0
  itemDragged = false
  window.clearTimeout(itemResetTimer)
  element.classList.add('is-liquid-pressed')
  try { element.setPointerCapture(itemPointerId) } catch { /* pointer capture is optional */ }
}

function onMenuButtonMove(event: PointerEvent): void {
  if (event.pointerId !== itemPointerId || !itemElement) return
  itemDragX = event.clientX - itemStartX
  itemDragY = event.clientY - itemStartY
  if (Math.hypot(itemDragX, itemDragY) > 5) itemDragged = true
  setMenuItemTransform(itemElement, itemDragX, itemDragY)
}

function onMenuButtonUp(event: PointerEvent): void {
  if (event.pointerId !== itemPointerId) return
  const element = itemElement
  itemPointerId = -1
  itemElement = null
  try { element?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  if (!element) return
  element.dataset.liquidDragged = itemDragged ? 'true' : 'false'
  element.classList.remove('is-liquid-pressed')
  element.classList.add('is-liquid-settling')
  setMenuItemTransform(element, itemDragX * .12, itemDragY * .12, true)
  requestAnimationFrame(() => setMenuItemTransform(element, 0, 0, true))
  itemResetTimer = window.setTimeout(() => {
    element.classList.remove('is-liquid-settling')
    delete element.dataset.liquidDragged
  }, 300)
}

function onMenuButtonClick(event: MouseEvent, action: 'disclaimer' | 'contact'): void {
  const element = event.currentTarget as HTMLElement | null
  if (element?.dataset.liquidDragged === 'true') {
    event.preventDefault()
    return
  }
  if (action === 'disclaimer') showDisclaimer.value = true
  else showContact.value = true
}

function onTriggerClick(event: MouseEvent): void {
  if (props.open) return
  const target = event.currentTarget as HTMLElement | null
  if (target?.dataset.liquidDragged === 'true') {
    event.preventDefault()
    return
  }
  emit('open')
}

function setPanelMotion(x = 0, y = 0, dragging = false, globalScale = 1): void {
  const element = morphRef.value?.element
  if (!element) return
  const length = Math.hypot(x, y)
  const pull = Math.min(1, length / 260)
  // Keep the sheet responsive without the hard, rubbery rotation/scale jump.
  const rotation = Math.max(-3.5, Math.min(3.5, x * .018 + y * .008))
  const scaleX = globalScale + Math.max(-.022, Math.min(.028, x / 1700))
  const scaleY = globalScale + Math.max(-.022, Math.min(.028, y / 1700))
  element.style.transform = `translate3d(${x * .2}px, ${y * .2}px, 0) rotate(${rotation * pull}deg) scale(${scaleX}, ${scaleY})`
  element.classList.toggle('is-dragging', dragging)
}

function cancelTransformAnimation(): void {
  if (transformFrame) window.cancelAnimationFrame(transformFrame)
  transformFrame = 0
}

function animateReturn(x: number, y: number, onDone?: () => void): void {
  cancelTransformAnimation()
  const startedAt = performance.now()
  const duration = Math.max(140, Math.min(220, 120 + Math.hypot(x, y) * .25))
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    setPanelMotion(x * (1 - eased), y * (1 - eased), false, 1)
    if (progress < 1) transformFrame = window.requestAnimationFrame(tick)
    else { transformFrame = 0; setPanelMotion(0, 0, false, 1); onDone?.() }
  }
  transformFrame = window.requestAnimationFrame(tick)
}

function animateOvershoot(lift = 0, onDone?: () => void): void {
  cancelTransformAnimation()
  const startedAt = performance.now()
  const duration = 360
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    const overshoot = Math.sin(Math.PI * eased)
    setPanelMotion(0, lift * overshoot, false, 1 + .045 * overshoot)
    if (progress < 1) transformFrame = window.requestAnimationFrame(tick)
    else { transformFrame = 0; setPanelMotion(0, 0, false, 1); onDone?.() }
  }
  transformFrame = window.requestAnimationFrame(tick)
}

function flushDragMotion(): void {
  motionFrame = 0
  setPanelMotion(pendingX, pendingY, true)
}

function scheduleDragMotion(): void {
  if (!motionFrame) motionFrame = window.requestAnimationFrame(flushDragMotion)
}

function releaseHandle(event: PointerEvent): void {
  try { handleRef.value?.releasePointerCapture(event.pointerId) } catch { /* already released */ }
}

function onHandleDown(event: PointerEvent): void {
  if (!props.open || pointerId !== -1) return
  event.preventDefault()
  event.stopPropagation()
  pointerId = event.pointerId
  handleRef.value?.setPointerCapture(pointerId)
  startY = event.clientY
  startX = event.clientX
  dragX = 0
  dragY = 0
  dragState.value = 'press'
  window.clearTimeout(settleTimer)
  pendingX = 0
  pendingY = 0
  cancelTransformAnimation()
  setPanelMotion(0, 0, true)
}

function onHandleMove(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return
  event.preventDefault()
  dragX = event.clientX - startX
  dragY = event.clientY - startY
  if (Math.hypot(dragX, dragY) > 5) dragState.value = 'dragging'
  pendingX = dragX
  pendingY = dragY
  scheduleDragMotion()
}

function onHandleUp(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return
  event.preventDefault()
  event.stopPropagation()
  pointerId = -1
  releaseHandle(event)
  if (motionFrame) window.cancelAnimationFrame(motionFrame)
  motionFrame = 0
  const didDrag = dragState.value === 'dragging'
  dragState.value = 'settling'
  // Any meaningful drag is a dismiss gesture. Direction is intentionally
  // unrestricted: the sheet returns from the actual release angle, then
  // closes instead of snapping back open.
  const shouldClose = didDrag
  if (shouldClose) {
    // Keep the exact release shape as the first frame of the dismiss motion.
    // Do not run the normal rebound/reset sequence: that creates a visible
    // backward hop before the sheet starts closing.
    setPanelMotion(dragX, dragY, false, .98)
    settleTimer = window.setTimeout(() => {
      dragState.value = 'idle'
      emit('close')
    }, 90)
    return
  }
  animateReturn(dragX * .2, dragY * .2)
  settleTimer = window.setTimeout(() => {
    dragState.value = 'idle'
    setPanelMotion()
    if (shouldClose) emit('close')
  }, shouldClose ? 120 : 340)
}

function onHandleCancel(event: PointerEvent): void {
  if (event.pointerId !== pointerId) return
  pointerId = -1
  releaseHandle(event)
  if (motionFrame) window.cancelAnimationFrame(motionFrame)
  motionFrame = 0
  dragY = 0
  dragState.value = 'settling'
  setPanelMotion()
  settleTimer = window.setTimeout(() => { dragState.value = 'idle'; setPanelMotion() }, 280)
}

watch(() => props.open, (open) => {
  morphPhase.value = open ? 'opening' : 'closing'
  window.setTimeout(() => {
    morphPhase.value = 'idle'
    nextTick(() => setPanelMotion())
  }, 360)
  if (open) animateOvershoot()
  else animateOvershoot(-8)
  if (!open) {
    pointerId = -1
    dragY = 0
    dragState.value = 'idle'
    nextTick(() => { setPanelMotion(); triggerRef.value?.focus() })
  } else nextTick(() => setPanelMotion())
})

onBeforeUnmount(() => {
  window.clearTimeout(settleTimer)
  window.clearTimeout(itemResetTimer)
  if (motionFrame) window.cancelAnimationFrame(motionFrame)
  cancelTransformAnimation()
})
</script>

<template>
  <div class="portal-menu-root" :class="{ 'is-open': props.open, 'is-opening': morphPhase === 'opening', 'is-closing': morphPhase === 'closing' }">
    <div v-if="props.open" class="portal-menu-scrim" aria-hidden="true" @click="emit('close')" />
    <PortalGlassSurface
      ref="morphRef"
      class="portal-menu-morph"
      variant="sheet"
      :backdrop-selector="backdropSelector"
      :role="props.open ? 'dialog' : undefined"
      :aria-label="props.open ? '游戏菜单' : undefined"
      @click="onTriggerClick"
    >
      <button v-if="!props.open" ref="triggerRef" class="portal-menu-trigger" type="button" aria-label="打开游戏菜单">•••</button>
      <div v-if="props.open || morphPhase === 'closing'" class="portal-menu-content">
        <h2>保持好奇，保持开局。</h2>
        <button type="button" :tabindex="props.open ? 0 : -1" @pointerdown="onMenuButtonDown" @pointermove="onMenuButtonMove" @pointerup="onMenuButtonUp" @pointercancel="onMenuButtonUp" @click="onMenuButtonClick($event, 'disclaimer')">项目声明与免责声明</button>
        <button type="button" :tabindex="props.open ? 0 : -1" @pointerdown="onMenuButtonDown" @pointermove="onMenuButtonMove" @pointerup="onMenuButtonUp" @pointercancel="onMenuButtonUp" @click="onMenuButtonClick($event, 'contact')">联系开发者</button>
        <button type="button" class="portal-menu-item--disabled" disabled aria-disabled="true">永久网址 <span>暂未接入</span></button>
        <div
          ref="handleRef"
          class="portal-menu-panel__handle-hit"
          role="separator"
          aria-label="拖动菜单面板"
          @pointerdown="onHandleDown"
          @pointermove="onHandleMove"
          @pointerup="onHandleUp"
          @pointercancel="onHandleCancel"
        ><span class="portal-menu-panel__handle" aria-hidden="true" /></div>
      </div>
    </PortalGlassSurface>
  </div>

  <FullDisclaimerModal v-if="showDisclaimer" @close="showDisclaimer = false" />
  <ContactDeveloperModal v-if="showContact" @close="showContact = false" />
</template>
