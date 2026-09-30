<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { GameDefinition, GameId } from './gameManifest'
import PortalBackgroundStage from './PortalBackgroundStage.vue'
import PortalGameSwitcher from './PortalGameSwitcher.vue'
import PortalGlassButton from './PortalGlassButton.vue'
import PortalMoreMenu from './PortalMoreMenu.vue'
import { portalWebGLScene } from './webgl/PortalWebGLScene'
import './portal.css'

const props = defineProps<{ games: readonly GameDefinition[] }>()
const emit = defineEmits<{ select: [game: GameDefinition] }>()
const playableGames = computed(() => props.games.filter((game): game is GameDefinition & { id: GameId } => game.id === 'mahjong' || game.id === 'sanguosha'))
const initialPortalGame = new URLSearchParams(window.location.search).get('portalGame')
const activeIndex = ref(initialPortalGame === 'sanguosha' ? 1 : 0)
const previousIndex = ref(0)
const transitionSerial = ref(0)
const menuOpen = ref(false)
const webglTextRendered = ref(false)
const portalReady = ref(false)
const portalSweeping = ref(false)
const changing = ref(false)
const glassBackdropSelector = '#portal-glass-live-backdrop'
const pointerStart = ref<{ x: number; y: number } | null>(null)
const game = computed(() => playableGames.value[activeIndex.value] ?? playableGames.value[0])
let contentTransitionTimer: number | undefined
let wheelLockTimer: number | undefined
let unsubscribeWebglAvailability: (() => void) | undefined

onMounted(() => {
  webglTextRendered.value = portalWebGLScene.isAvailable()
  unsubscribeWebglAvailability = portalWebGLScene.onAvailabilityChange((available) => { webglTextRendered.value = available })
  // `portalGame` is only a one-time return hint. Consume it so a browser
  // refresh starts the portal from the default Mahjong entry again.
  if (initialPortalGame === 'mahjong' || initialPortalGame === 'sanguosha') {
    const url = new URL(window.location.href)
    url.searchParams.delete('portalGame')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
})

function onBackgroundStable(_stableGame: GameId): void { /* Glass samples one persistent live canvas throughout the transition. */ }
function onPortalReady(): void { portalReady.value = true; portalSweeping.value = true }
function onPortalSweep(): void { portalSweeping.value = true }

function setActiveGame(index: number): void {
  if (index === activeIndex.value || !playableGames.value[index]) return
  previousIndex.value = activeIndex.value
  transitionSerial.value += 1
  changing.value = true
  window.clearTimeout(contentTransitionTimer)
  contentTransitionTimer = window.setTimeout(() => { changing.value = false }, 260)
  activeIndex.value = index
}

function selectCurrentGame(): void { emit('select', game.value) }

function onPointerDown(event: PointerEvent): void {
  if (!menuOpen.value) pointerStart.value = { x: event.clientX, y: event.clientY }
}

function onPointerUp(event: PointerEvent): void {
  if (pointerStart.value === null || menuOpen.value) return
  const delta = event.clientY - pointerStart.value.y
  const horizontal = Math.abs(event.clientX - pointerStart.value.x)
  pointerStart.value = null
  if (Math.abs(delta) < 56 || Math.abs(delta) < horizontal * 1.2) return
  setActiveGame(delta < 0 ? Math.min(activeIndex.value + 1, playableGames.value.length - 1) : Math.max(activeIndex.value - 1, 0))
}

function onPointerCancel(): void { pointerStart.value = null }

function onWheel(event: WheelEvent): void {
  if (menuOpen.value || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || Math.abs(event.deltaY) < 18) return
  event.preventDefault()
  if (wheelLockTimer !== undefined) return
  setActiveGame(event.deltaY > 0 ? Math.min(activeIndex.value + 1, playableGames.value.length - 1) : Math.max(activeIndex.value - 1, 0))
  wheelLockTimer = window.setTimeout(() => { wheelLockTimer = undefined }, 320)
}

onBeforeUnmount(() => {
  window.clearTimeout(contentTransitionTimer)
  window.clearTimeout(wheelLockTimer)
  unsubscribeWebglAvailability?.()
})
</script>

<template>
  <main class="portal-home" :class="[`portal-theme-${game.id}`, { 'is-content-changing': changing, 'is-webgl-text-rendered': webglTextRendered, 'is-portal-booting': !portalSweeping, 'is-portal-sweeping': portalSweeping && !portalReady }]" @pointerdown="onPointerDown" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @wheel="onWheel" @selectstart.prevent @dragstart.prevent>
    <PortalBackgroundStage :game="game.id" @stable="onBackgroundStable" @sweep="onPortalSweep" @ready="onPortalReady" />
    <header class="portal-topbar"><PortalMoreMenu :open="menuOpen" :backdrop-selector="glassBackdropSelector" @open="menuOpen = true" @close="menuOpen = false" /></header>
    <section class="portal-stage" aria-live="polite">
      <div class="portal-content" :class="{ 'is-changing': changing }">
        <div class="portal-copy">
          <div class="portal-title-slot">
            <h1 v-if="changing" :key="`outgoing-title-${previousIndex}-${transitionSerial}`" class="portal-slot portal-slot--outgoing">{{ playableGames[previousIndex].name }}</h1>
            <h1 :key="`active-title-${game.id}-${transitionSerial}`" class="portal-slot" :class="{ 'portal-slot--incoming': changing }">{{ game.name }}</h1>
          </div>
          <div class="portal-subtitle-slot">
            <p v-if="changing" :key="`outgoing-subtitle-${previousIndex}-${transitionSerial}`" class="portal-slot portal-slot--outgoing">{{ playableGames[previousIndex].subtitle }}</p>
            <p :key="`active-subtitle-${game.id}-${transitionSerial}`" class="portal-slot" :class="{ 'portal-slot--incoming': changing }">{{ game.subtitle }}</p>
          </div>
        </div>
        <PortalGlassButton class="portal-game-action" label="开始游戏" :backdrop-selector="glassBackdropSelector" @click="selectCurrentGame" />
      </div>
    </section>

    <footer class="portal-bottom"><span class="portal-hint">上下滑动切换游戏</span><PortalGameSwitcher :games="playableGames" :active="activeIndex" :backdrop-selector="glassBackdropSelector" @select="setActiveGame" /></footer>
  </main>
</template>
