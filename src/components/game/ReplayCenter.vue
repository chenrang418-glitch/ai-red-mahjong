<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import MahjongTable from './MahjongTable.vue'
import { deleteReplay, downloadJson, getReplay, listReplays, saveReplay, type ReplayRecord, type ReplaySummary } from '@/game/persistence'
import { placeholderTiles } from '@/game/tiles'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const summaries = ref<ReplaySummary[]>([])
const selected = ref<ReplayRecord | null>(null)
const frameIndex = ref(0)
const loading = ref(false)
const revealAll = ref(false)
const playing = ref(false)
const speed = ref(1)
let playTimer: number | null = null
// 帧里不再保存牌墙和码区的牌面，只有数量；渲染这一帧时补回占位牌，牌桌上的计数才对得上。
const frame = computed(() => {
  const record = selected.value?.frames[frameIndex.value]
  if (!record) return null
  if (record.wallCount === undefined && record.maReserveCount === undefined) return record.state
  return {
    ...record.state,
    wall: placeholderTiles(record.wallCount ?? 0, 'replay-wall'),
    maReserve: placeholderTiles(record.maReserveCount ?? 0, 'replay-ma'),
  }
})
const humanId = computed(() => frame.value?.players.find((player) => player.isHuman)?.id ?? 0)

watch(() => props.open, async (open) => {
  if (!open) { stopPlayback(); return }
  revealAll.value = false
  loading.value = true
  try { summaries.value = await listReplays() } finally { loading.value = false }
})

function stopPlayback() {
  playing.value = false
  if (playTimer !== null) window.clearInterval(playTimer)
  playTimer = null
}

function startPlayback() {
  stopPlayback()
  if (!selected.value || frameIndex.value >= selected.value.frames.length - 1) frameIndex.value = 0
  playing.value = true
  playTimer = window.setInterval(() => {
    if (!selected.value || frameIndex.value >= selected.value.frames.length - 1) { stopPlayback(); return }
    frameIndex.value += 1
  }, 900 / speed.value)
}

function togglePlayback() { if (playing.value) stopPlayback(); else startPlayback() }
function cycleSpeed() {
  speed.value = speed.value === 1 ? 2 : speed.value === 2 ? .5 : 1
  if (playing.value) startPlayback()
}
function step(delta: number) {
  stopPlayback()
  if (!selected.value) return
  frameIndex.value = Math.max(0, Math.min(selected.value.frames.length - 1, frameIndex.value + delta))
}

async function importReplay(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const record = JSON.parse(await file.text()) as ReplayRecord
    if (!record?.id || !record?.title || !Array.isArray(record.frames) || !record.frames.length) throw new Error('格式不正确')
    await saveReplay(record)
    summaries.value = await listReplays()
  } catch (error) {
    window.alert(`导入失败：${error instanceof Error ? error.message : '无法读取牌谱'}`)
  } finally {
    ;(event.target as HTMLInputElement).value = ''
  }
}

onBeforeUnmount(stopPlayback)

async function choose(summary: ReplaySummary) {
  stopPlayback()
  loading.value = true
  try {
    selected.value = await getReplay(summary.id)
    frameIndex.value = 0
  } finally { loading.value = false }
}

async function remove(summary: ReplaySummary) {
  if (!window.confirm(`删除牌谱“${summary.title}”？`)) return
  await deleteReplay(summary.id)
  if (selected.value?.id === summary.id) selected.value = null
  summaries.value = await listReplays()
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(value)
}
</script>

<template>
  <div v-if="open" class="replay-backdrop">
    <section class="replay-modal">
      <header>
        <div><small>LOCAL REPLAYS</small><h2>本地牌谱回放</h2></div>
        <div class="header-actions">
          <label class="reveal-toggle">
            <span><b>明牌模式</b><small>显示四家手牌</small></span>
            <span class="ios-switch">
              <input v-model="revealAll" aria-label="明牌模式" type="checkbox">
              <i></i>
            </span>
          </label>
          <button class="close" @click="emit('close')">×</button>
        </div>
      </header>
      <header class="mobile-replay-head mobile-only">
        <button class="mobile-replay-back" type="button" @click="selected ? (selected = null) : emit('close')">‹</button>
        <strong v-if="!selected">牌谱</strong>
        <div v-else class="mobile-replay-round"><span>第 <b>{{ frame?.round ?? 1 }}</b> 局</span><span>牌墙 <b>{{ frame?.wall.length ?? 0 }}</b></span></div>
        <label v-if="!selected" class="import-button">导入<input type="file" accept="application/json,.json" @change="importReplay"></label>
        <button v-else class="reveal-button" :class="{ active: revealAll }" type="button" @click="revealAll = !revealAll">{{ revealAll ? '明牌中' : '明牌' }}</button>
      </header>
      <div class="replay-layout">
        <aside>
          <p v-if="loading">正在读取本地牌谱…</p>
          <p v-else-if="summaries.length === 0">还没有已完成牌谱。</p>
          <article v-for="summary in summaries" :key="summary.id" :class="{ active: selected?.id === summary.id }" @click="choose(summary)">
            <strong>{{ summary.title }}</strong>
            <small>{{ formatDate(summary.completedAt) }} · {{ summary.frameCount }}步</small>
            <button title="删除" @click.stop="remove(summary)">删除</button>
          </article>
        </aside>
        <main>
          <div v-if="selected && frame" class="viewer">
            <div class="viewer-toolbar">
              <button @click="step(-1)">上一步</button>
              <span>第 {{ frameIndex + 1 }} / {{ selected.frames.length }} 步</span>
              <button @click="step(1)">下一步</button>
              <button @click="downloadJson(`${selected.title}.json`, selected)">导出JSON</button>
            </div>
            <input v-model.number="frameIndex" type="range" min="0" :max="selected.frames.length - 1">
            <MahjongTable :state="frame" :human-id="humanId" readonly :reveal-all="revealAll" />
            <div class="mobile-playback mobile-only">
              <div class="playback-buttons">
                <button type="button" @click="step(-1)">‹</button>
                <button class="play-main" type="button" @click="togglePlayback">{{ playing ? '暂停' : '播放' }}</button>
                <button type="button" @click="step(1)">›</button>
                <button type="button" @click="cycleSpeed">{{ speed }}x</button>
              </div>
              <input v-model.number="frameIndex" type="range" min="0" :max="selected.frames.length - 1" @input="stopPlayback">
              <span>{{ frameIndex + 1 }} / {{ selected.frames.length }}</span>
            </div>
          </div>
          <div v-else class="empty-view">选择左侧牌谱后，可以逐步查看牌桌状态。</div>
        </main>
      </div>
    </section>
  </div>
</template>

<style scoped>
.replay-backdrop { position: fixed; inset: 0; z-index: 50; padding: 18px; background: rgba(0,0,0,.72); }
.replay-modal { height: calc(100vh - 36px); display: flex; flex-direction: column; overflow: hidden; background: #0c1b18; border: 1px solid #3a554d; border-radius: 20px; color: #f5edd8; }
.replay-modal > header { padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 18px; border-bottom: 1px solid #29423b; }
header small { color: #789089; letter-spacing: .18em; }
h2 { margin: 0; font-size: 21px; }
.header-actions, .reveal-toggle { display: flex; align-items: center; }
.header-actions { gap: 13px; }
.reveal-toggle { gap: 11px; padding: 7px 10px; border: 1px solid #314c43; border-radius: 11px; background: #112821; cursor: pointer; }
.reveal-toggle > span:first-child { display: grid; gap: 1px; }
.reveal-toggle b { color: #e8dfc7; font-size: 11px; }
.reveal-toggle small { color: #71877f; font-size: 8px; letter-spacing: 0; }
.ios-switch { position: relative; width: 42px; height: 24px; flex: 0 0 42px; display: inline-block; }
.ios-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.ios-switch i { position: absolute; inset: 0; border-radius: 99px; background: #3a5049; transition: background .2s ease; box-shadow: inset 0 0 0 1px rgba(255,255,255,.04); }
.ios-switch i::after { content: ''; position: absolute; width: 20px; height: 20px; top: 2px; left: 2px; border-radius: 50%; background: #e8eee9; box-shadow: 0 2px 5px rgba(0,0,0,.35); transition: transform .2s ease; }
.ios-switch input:checked + i { background: #d5b652; }
.ios-switch input:checked + i::after { transform: translateX(18px); background: #fff9e7; }
.ios-switch input:focus-visible + i { outline: 2px solid #f2d477; outline-offset: 2px; }
.close { width: 38px; height: 38px; border-radius: 50%; border: 1px solid #3a554d; background: #173129; color: #f4e8c7; font-size: 22px; cursor: pointer; }
.replay-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: 250px 1fr; }
aside { overflow: auto; padding: 12px; border-right: 1px solid #29423b; }
aside > p { padding: 14px; color: #7e948d; font-size: 12px; }
aside article { position: relative; display: grid; gap: 4px; padding: 12px; margin-bottom: 8px; border: 1px solid #29433b; border-radius: 11px; cursor: pointer; }
aside article.active { border-color: #d8b95f; background: rgba(216,185,95,.06); }
aside article small { color: #789089; font-size: 10px; }
aside article button { position: absolute; right: 8px; top: 8px; color: #b98179; border: 0; background: transparent; cursor: pointer; font-size: 10px; }
main { min-width: 0; overflow: auto; padding: 12px; }
.viewer-toolbar { display: flex; gap: 9px; align-items: center; margin-bottom: 8px; }
.viewer-toolbar span { min-width: 120px; text-align: center; color: #dbc879; font-size: 12px; }
.viewer-toolbar button { padding: 8px 11px; border: 1px solid #365249; border-radius: 8px; background: #173129; color: #ede4cc; cursor: pointer; }
.viewer input[type='range'] { width: 100%; margin-bottom: 9px; accent-color: #d7b95f; }
.viewer :deep(.table-shell) { min-height: 660px; }
.empty-view { height: 100%; display: grid; place-items: center; color: #71867f; }
@media (max-width: 800px) { .replay-layout { grid-template-columns: 1fr; } aside { max-height: 150px; border-right: 0; border-bottom: 1px solid #29423b; } .reveal-toggle small { display: none; } }

.mobile-replay-head, .mobile-playback { display: none; }
.import-button input { display: none; }

@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .replay-backdrop { z-index: 70; padding: 0; background: #0b1a15; }
  .replay-modal { height: 100dvh; border: 0; border-radius: 0; background: #0b1a15; }
  .replay-modal > header:not(.mobile-replay-head) { display: none; }
  .replay-modal > .mobile-replay-head {
    flex: none;
    min-height: 58px;
    padding: max(8px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) 6px max(18px, env(safe-area-inset-left));
    display: flex;
    align-items: center;
    gap: 12px;
    border: 0;
  }
  .mobile-replay-back { width: 38px; height: 38px; padding: 0; border: 1px solid #2f4b41; border-radius: 11px; background: transparent; color: #cbd6d0; font-size: 27px; }
  .mobile-replay-head > strong { color: #f3d67c; font-size: 23px; }
  .mobile-replay-round { display: flex; gap: 18px; color: #8ba49c; font-size: 13px; }
  .mobile-replay-round b { color: #f3d67c; font-size: 16px; }
  .import-button, .reveal-button { margin-left: auto; padding: 8px 15px; border: 1px solid #35524a; border-radius: 99px; background: transparent; color: #d9c489; font-size: 13px; }
  .reveal-button.active { border-color: #d3b45e; background: #2c2a17; color: #f3d67c; }
  .replay-layout { display: block; min-height: 0; }
  .replay-layout > aside { height: 100%; max-height: none; overflow-y: auto; padding: 10px 18px calc(20px + env(safe-area-inset-bottom)); border: 0; }
  .replay-layout > aside article { min-height: 112px; margin-bottom: 10px; padding: 16px 18px; border-color: #355249; border-radius: 14px; background: #102a22; }
  .replay-layout > aside article strong { padding-right: 60px; font-size: 18px; }
  .replay-layout > aside article small { font-size: 13px; }
  .replay-layout > aside article button { position: static; width: 62px; min-height: 34px; margin-top: 10px; padding: 5px 10px; border: 1px solid #74423d; border-radius: 99px; color: #d78f86; font-size: 12px; }
  .replay-layout > main { height: 100%; padding: 0; overflow: hidden; }
  .replay-layout > aside:has(+ main .viewer), .replay-layout:has(.viewer) > aside { display: none; }
  .viewer { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .viewer-toolbar, .viewer > input[type='range'] { display: none; }
  .viewer :deep(.table-shell) { flex: 1; width: 100%; min-height: 0; max-height: none; }
  .viewer :deep(.human-seat) { padding-bottom: 8px; }
  .mobile-playback {
    flex: none;
    min-height: 152px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px calc(14px + env(safe-area-inset-bottom));
    border-top: 1px solid #274038;
    background: rgba(9,26,21,.98);
  }
  .playback-buttons { display: grid; grid-template-columns: 54px minmax(0, 1fr) 54px 54px; gap: 8px; }
  .playback-buttons button { min-height: 50px; border: 1px solid #35524a; border-radius: 12px; background: #14302a; color: #e4dcc4; font-size: 19px; font-weight: 800; }
  .playback-buttons .play-main { border: 0; background: #e0c069; color: #20261e; }
  .mobile-playback > input { width: 100%; margin: 0; accent-color: #d7b95f; }
  .mobile-playback > span { text-align: center; color: #7c9189; font-size: 14px; }
}

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .replay-modal > .mobile-replay-head { min-height: 38px; padding: 2px max(12px, env(safe-area-inset-right)) 2px max(12px, env(safe-area-inset-left)); }
  .mobile-replay-back { width: 28px; height: 28px; border-radius: 8px; font-size: 19px; }
  .mobile-replay-head > strong { font-size: 18px; }
  .mobile-replay-round { font-size: 11px; }
  .mobile-replay-round b { font-size: 13px; }
  .import-button, .reveal-button { padding: 4px 12px; font-size: 11px; }
  .replay-layout > aside { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-content: start; gap: 8px; padding: 8px max(14px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); }
  .replay-layout > aside article { min-height: 94px; margin: 0; padding: 12px; }
  .replay-layout > aside article strong { font-size: 14px; }
  .replay-layout > aside article small { font-size: 10px; }
  .viewer { padding-bottom: 76px; }
  .mobile-playback { position: fixed; z-index: 5; left: 0; right: 0; bottom: 0; min-height: 74px; padding: 5px max(10px, env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); display: grid; grid-template-columns: 1fr 180px 40px; align-items: center; gap: 10px; }
  .playback-buttons { grid-template-columns: 44px 1fr 44px 48px; gap: 6px; }
  .playback-buttons button { min-height: 42px; font-size: 15px; }
  .mobile-playback > span { font-size: 12px; }
}
</style>
