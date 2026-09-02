<script setup lang="ts">
import { computed, onBeforeUnmount, onErrorCaptured, ref, shallowRef, watch } from 'vue'
import GamePortal from '@/portal/GamePortal.vue'
import { gameManifest, playableGames, type GameDefinition } from '@/portal/gameManifest'
import { buildGameUrl, buildPortalUrl, resolveAppRoute } from '@/portal/navigation'
import type { Component } from 'vue'

const route = ref(resolveAppRoute(new URL(window.location.href)))
const activeComponent = shallowRef<Component | null>(null)
const loading = ref(false)
const loadError = ref('')
let loadRevision = 0
let loadTimer: number | null = null

const activeGame = computed<GameDefinition | null>(() => {
  if (route.value.kind !== 'game') return null
  return playableGames.get(route.value.gameId) ?? null
})

function syncRoute() {
  route.value = resolveAppRoute(new URL(window.location.href))
}

function navigate(url: URL) {
  window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`)
  syncRoute()
}

function openGame(game: GameDefinition) {
  if (!game.enabled || !game.loadApp || game.id === 'more') return
  navigate(buildGameUrl(new URL(window.location.href), game.id))
}

function returnToPortal() {
  navigate(buildPortalUrl(new URL(window.location.href)))
}

async function loadActiveGame(game: GameDefinition | null) {
  const revision = ++loadRevision
  if (loadTimer !== null) window.clearTimeout(loadTimer)
  activeComponent.value = null
  loadError.value = ''
  if (!game?.loadApp) return
  loading.value = true
  try {
    const timeout = new Promise<never>((_, reject) => {
      loadTimer = window.setTimeout(() => reject(new Error('游戏资源加载超时')), 15_000)
    })
    const module = await Promise.race([game.loadApp(), timeout])
    if (revision === loadRevision) activeComponent.value = module.default
  } catch (cause) {
    if (revision === loadRevision) {
      loadError.value = import.meta.env.DEV && cause instanceof Error
        ? `游戏加载失败：${cause.message}`
        : '游戏加载失败，请重试。'
    }
  } finally {
    if (loadTimer !== null) window.clearTimeout(loadTimer)
    loadTimer = null
    if (revision === loadRevision) loading.value = false
  }
}

function retryLoad() {
  void loadActiveGame(activeGame.value)
}

window.addEventListener('popstate', syncRoute)
window.addEventListener('hashchange', syncRoute)
onBeforeUnmount(() => {
  if (loadTimer !== null) window.clearTimeout(loadTimer)
  window.removeEventListener('popstate', syncRoute)
  window.removeEventListener('hashchange', syncRoute)
})

watch(activeGame, (game) => { void loadActiveGame(game) }, { immediate: true })

onErrorCaptured((cause) => {
  loadError.value = import.meta.env.DEV && cause instanceof Error
    ? `游戏运行异常：${cause.message}`
    : '游戏发生异常，请返回游戏中心后重试。'
  return false
})
</script>

<template>
  <GamePortal v-if="route.kind === 'portal'" :games="gameManifest" @select="openGame" />

  <main v-else-if="loading" class="root-loading" aria-live="polite">
    <span>CR</span>
    <p>正在载入{{ activeGame?.name }}…</p>
  </main>

  <main v-else-if="loadError || !activeComponent" class="root-error">
    <section role="alert">
      <span>CR</span>
      <h1>游戏发生异常</h1>
      <p>{{ loadError || '未找到这个游戏。' }}</p>
      <div>
        <button type="button" @click="retryLoad">重新加载</button>
        <button type="button" @click="returnToPortal">返回游戏中心</button>
      </div>
    </section>
  </main>

  <component :is="activeComponent" v-else @back-to-portal="returnToPortal" />
</template>
