<script setup lang="ts">
import type { AIProfile, Difficulty, PlayerState } from '@/game/types'

defineProps<{ open: boolean; players: PlayerState[] }>()
const emit = defineEmits<{ close: []; change: [playerId: number, profile: AIProfile] }>()

const difficultyLabels: Record<Difficulty, string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }

function change(player: PlayerState, value: string) {
  if (!player.ai) return
  emit('change', player.id, { difficulty: value as Difficulty })
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer">
      <header><div><h2>AI 档位</h2></div><button @click="emit('close')">×</button></header>
      <article v-for="player in players.filter(p => !p.isHuman)" :key="player.id">
        <div class="ai-title"><span>AI{{ player.id }}</span><strong>{{ player.name }}</strong></div>
        <label>智能档位
          <select :value="player.ai?.difficulty" @change="change(player, ($event.target as HTMLSelectElement).value)">
            <option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
      </article>
    </aside>
  </div>
</template>

<style scoped>
.drawer-backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.48); display: flex; justify-content: flex-end; }
.drawer { width: min(430px, 92vw); height: 100%; overflow: auto; padding: 24px; background: #0d1e1a; border-left: 1px solid #355047; box-shadow: -18px 0 60px rgba(0,0,0,.35); }
header { display: flex; justify-content: space-between; align-items: center; }
h2 { margin: 2px 0; }
header button { width: 38px; height: 38px; border-radius: 50%; color: #e9dcb8; background: #1b342d; border: 1px solid #365249; font-size: 23px; cursor: pointer; }
article { margin: 12px 0; padding: 15px; border: 1px solid #29433b; border-radius: 14px; background: #10251f; }
.ai-title { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.ai-title span { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: #24483d; color: #e5c96f; font-size: 11px; font-weight: 800; }
label { display: grid; gap: 5px; color: #81968f; font-size: 10px; margin-top: 8px; }
select { width: 100%; padding: 10px; color: #f3ecd8; background: #18322b; border: 1px solid #37574e; border-radius: 8px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .drawer-backdrop { align-items: flex-end; justify-content: stretch; }
  .drawer { width: 100%; height: auto; max-height: 72dvh; padding: 0 18px calc(20px + env(safe-area-inset-bottom)); overflow: hidden; border: 0; border-top: 1px solid #355249; border-radius: 22px 22px 0 0; background: #0c211b; box-shadow: 0 -18px 50px rgba(0,0,0,.45); }
  header { min-height: 62px; margin: 0 -18px 12px; padding: 0 18px; border-bottom: 1px solid #1d352d; }
  h2 { margin: 0; color: #f3d67c; font-size: 21px; }
  header button { width: 42px; height: 42px; border: 0; background: transparent; color: #8ba49c; font-size: 28px; }
  article { min-height: 64px; margin: 9px 0; padding: 10px 14px; display: grid; grid-template-columns: minmax(0, 1fr) 128px; align-items: center; gap: 12px; border-color: #355249; border-radius: 14px; background: #102a22; }
  .ai-title { margin: 0; }
  .ai-title span { display: none; }
  .ai-title strong { font-size: 17px; }
  label { margin: 0; font-size: 0; }
  select { min-height: 42px; color: #f3d67c; font-size: 15px; text-align: center; }
}

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .drawer-backdrop { align-items: center; justify-content: center; }
  .drawer { width: min(480px, 70vw); max-height: 90dvh; padding: 0 14px 14px; border: 1px solid #355249; border-radius: 16px; }
  header { min-height: 46px; margin: 0 -14px 8px; padding: 0 14px; }
  h2 { font-size: 18px; }
  article { min-height: 48px; margin: 6px 0; grid-template-columns: 1fr 120px; }
  .ai-title strong { font-size: 14px; }
  select { min-height: 34px; font-size: 13px; }
}
</style>
