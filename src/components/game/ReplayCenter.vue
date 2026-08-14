<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MahjongTable from './MahjongTable.vue'
import { deleteReplay, downloadJson, getReplay, listReplays, type ReplayRecord, type ReplaySummary } from '@/game/persistence'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const summaries = ref<ReplaySummary[]>([])
const selected = ref<ReplayRecord | null>(null)
const frameIndex = ref(0)
const loading = ref(false)
const revealAll = ref(false)
const frame = computed(() => selected.value?.frames[frameIndex.value]?.state ?? null)
const humanId = computed(() => frame.value?.players.find((player) => player.isHuman)?.id ?? 0)

watch(() => props.open, async (open) => {
  if (!open) return
  revealAll.value = false
  loading.value = true
  try { summaries.value = await listReplays() } finally { loading.value = false }
})

async function choose(summary: ReplaySummary) {
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
              <button @click="frameIndex = Math.max(0, frameIndex - 1)">上一步</button>
              <span>第 {{ frameIndex + 1 }} / {{ selected.frames.length }} 步</span>
              <button @click="frameIndex = Math.min(selected.frames.length - 1, frameIndex + 1)">下一步</button>
              <button @click="downloadJson(`${selected.title}.json`, selected)">导出JSON</button>
            </div>
            <input v-model.number="frameIndex" type="range" min="0" :max="selected.frames.length - 1">
            <MahjongTable :state="frame" :human-id="humanId" readonly :reveal-all="revealAll" />
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
</style>
