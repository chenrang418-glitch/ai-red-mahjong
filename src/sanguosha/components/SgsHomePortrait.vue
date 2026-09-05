<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ALL_CHARACTERS } from '../data/characters/standard'
import { characterPortrait } from '../assets/characters/manifest'
import { FACTION_CONFIG } from '../shared/factions'

const pool = ALL_CHARACTERS.flatMap((character) => {
  const portrait = characterPortrait(character.id)
  return portrait ? [{ character, portrait }] : []
})
type Entry = (typeof pool)[number]
let remaining: Entry[] = []
let lastId: string | null = null
function takeNext(): Entry | null {
  if (!remaining.length) {
    remaining = [...pool]
    for (let index = remaining.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1))
      ;[remaining[index], remaining[other]] = [remaining[other]!, remaining[index]!]
    }
    // 跨越两轮洗牌时，也不连续展示同一位武将。
    if (remaining.length > 1 && remaining.at(-1)?.character.id === lastId) {
      remaining.unshift(remaining.pop()!)
    }
  }
  const entry = remaining.pop() ?? null
  lastId = entry?.character.id ?? null
  return entry
}
function source(entry: Entry): string {
  return window.matchMedia('(min-width: 701px)').matches ? entry.portrait.fullSrc : entry.portrait.src
}

const first = takeNext()
const current = ref(first ? { ...first, src: source(first) } : null)
const paused = ref(false)
const loading = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
let loadTimeout: ReturnType<typeof setTimeout> | null = null
let pendingImage: HTMLImageElement | null = null
let disposed = false
let generation = 0

function stop(): void {
  generation++
  if (timer !== null) clearTimeout(timer)
  if (loadTimeout !== null) clearTimeout(loadTimeout)
  timer = loadTimeout = null
  if (pendingImage) pendingImage.onload = pendingImage.onerror = null
  pendingImage = null
  loading.value = false
}
function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (!disposed && !paused.value && !document.hidden && pool.length > 1) timer = setTimeout(rotate, 12_000)
}
function rotate(): void {
  if (loading.value || document.hidden || disposed) return
  stop()
  const next = takeNext()
  if (!next) return
  const version = generation
  const src = source(next)
  const image = new Image()
  pendingImage = image
  loading.value = true
  error.value = ''
  function finish(succeeded: boolean): void {
    if (version !== generation || disposed) return
    stop()
    if (succeeded) current.value = { ...next!, src }
    else error.value = '暂时无法切换，请再试一次'
    schedule()
  }
  image.onload = () => { image.decode().then(() => finish(true), () => finish(false)) }
  image.onerror = () => finish(false)
  // 慢网或失败时保留原画面，避免首页出现空白或永久卡在加载中。
  loadTimeout = setTimeout(() => finish(false), 10_000)
  image.src = src
}
function togglePaused(): void {
  paused.value = !paused.value
  if (paused.value) stop()
  else schedule()
}
function visibilityChanged(): void {
  if (document.hidden) stop()
  else schedule()
}
onMounted(() => {
  document.addEventListener('visibilitychange', visibilityChanged)
  schedule()
})
onUnmounted(() => {
  disposed = true
  stop()
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <figure v-if="current" class="sgs-home__portrait" aria-label="武将立绘轮播">
    <div class="sgs-home__orbit" aria-hidden="true"></div>
    <Transition name="sgs-portrait">
      <img :key="current.character.id" :src="current.src" :alt="current.character.name" decoding="async" fetchpriority="high">
    </Transition>
    <figcaption>
      <span>{{ FACTION_CONFIG[current.character.kingdom].name }} · {{ current.character.pack === 'entertainment' ? '自定义武将' : '群雄图鉴' }}</span>
      <strong>{{ current.character.name }}</strong>
      <small>{{ current.character.skills.filter((skill) => !skill.granted).map((skill) => skill.name).join(' · ') }}</small>
    </figcaption>
    <div class="sgs-home__rotation">
      <button type="button" :aria-pressed="paused" @click="togglePaused">{{ paused ? '继续轮播' : '暂停轮播' }}</button>
      <button type="button" :disabled="loading" @click="rotate">{{ loading ? '加载中…' : '换一位' }}</button>
    </div>
    <p v-if="error" class="sgs-home__portrait-error" role="status">{{ error }}</p>
  </figure>
</template>

<style scoped>
/* 控件不跟随手机立绘的透明度变化，保证依然清楚、可点。 */
.sgs-home__rotation { position: absolute; right: 4%; top: 14px; z-index: 2; display: flex; gap: 6px; }
.sgs-home__rotation button { min-height: 32px; padding: 0 10px; border: 1px solid #d8b77740; border-radius: 7px; background: #102124cc; color: #c6cbb6; font-size: 10px; cursor: pointer; }
.sgs-home__rotation button:disabled { opacity: .6; cursor: progress; }
.sgs-home__portrait-error { position: absolute; bottom: 0; right: 4%; color: #e5bf92; font-size: 11px; }
.sgs-portrait-enter-active, .sgs-portrait-leave-active { transition: opacity .65s ease !important; }
.sgs-portrait-enter-from, .sgs-portrait-leave-to { opacity: 0 !important; }
@media (prefers-reduced-motion: reduce) {
  .sgs-portrait-enter-active, .sgs-portrait-leave-active { transition: none !important; }
}
</style>
