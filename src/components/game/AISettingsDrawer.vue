<script setup lang="ts">
import type { AIProfile, Difficulty, PlayerState } from '@/game/types'

defineProps<{ open: boolean; players: PlayerState[] }>()
const emit = defineEmits<{ close: []; change: [playerId: number, profile: AIProfile] }>()

const difficultyLabels: Record<Difficulty, string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }
const difficultyHints: Record<Difficulty, string> = {
  beginner: '算不清剩几张，常打错牌，有杠就杠',
  standard: '会算向听和进张，打法稳当',
  expert: '会挑听得最宽的那张，牌墙见底会收手',
}

function change(player: PlayerState, value: string) {
  if (!player.ai) return
  emit('change', player.id, { difficulty: value as Difficulty })
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer">
      <header><div><small>LIVE CONFIG</small><h2>AI随时切换</h2></div><button @click="emit('close')">×</button></header>
      <p class="hint">修改从该AI的下一次新决策开始生效，不会偷看其他玩家手牌。</p>
      <div class="quick-guide">只有一个档位要选。<b>做什么牌型</b>由 AI 看着手牌自己定，<b>想多久</b>由这手牌好不好打决定。</div>
      <article v-for="player in players.filter(p => !p.isHuman)" :key="player.id">
        <div class="ai-title"><span>AI{{ player.id }}</span><strong>{{ player.name }}</strong></div>
        <label>智能档位
          <select :value="player.ai?.difficulty" @change="change(player, ($event.target as HTMLSelectElement).value)">
            <option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option>
          </select>
        </label>
        <p class="difficulty-hint" v-if="player.ai">{{ difficultyHints[player.ai.difficulty] }}</p>
      </article>
    </aside>
  </div>
</template>

<style scoped>
.drawer-backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(0,0,0,.48); display: flex; justify-content: flex-end; }
.drawer { width: min(430px, 92vw); height: 100%; overflow: auto; padding: 24px; background: #0d1e1a; border-left: 1px solid #355047; box-shadow: -18px 0 60px rgba(0,0,0,.35); }
header { display: flex; justify-content: space-between; align-items: center; }
header small { color: #728a83; letter-spacing: .18em; }
h2 { margin: 2px 0; }
header button { width: 38px; height: 38px; border-radius: 50%; color: #e9dcb8; background: #1b342d; border: 1px solid #365249; font-size: 23px; cursor: pointer; }
.hint { color: #81968f; font-size: 12px; margin: 11px 0 18px; }
.quick-guide { margin: -7px 0 18px; padding: 9px 11px; border: 1px solid #2c473e; border-radius: 9px; color: #80958e; background: #102820; font-size: 10px; line-height: 1.7; }
.quick-guide b { color: #ddc16e; }
article { margin: 12px 0; padding: 15px; border: 1px solid #29433b; border-radius: 14px; background: #10251f; }
.ai-title { display: flex; align-items: center; gap: 9px; margin-bottom: 10px; }
.ai-title span { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: #24483d; color: #e5c96f; font-size: 11px; font-weight: 800; }
label { display: grid; gap: 5px; color: #81968f; font-size: 10px; margin-top: 8px; }
.difficulty-hint { margin: 8px 0 0; color: #7f948d; font-size: 11px; line-height: 1.6; }
select { width: 100%; padding: 10px; color: #f3ecd8; background: #18322b; border: 1px solid #37574e; border-radius: 8px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
</style>
