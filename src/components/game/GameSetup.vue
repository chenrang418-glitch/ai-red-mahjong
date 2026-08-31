<script setup lang="ts">
import { reactive } from 'vue'
import AudioControl from './AudioControl.vue'
import type { Difficulty, MatchConfig, MatchMode } from '@/game/types'

const emit = defineEmits<{ start: [config: MatchConfig]; rules: []; back: [] }>()
const difficultyLabels: Record<Difficulty, string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }
const form = reactive({ mode: 'finite' as MatchMode, nickname: '你', initialPoints: 30, difficulty: 'standard' as Difficulty })

function submit() {
  const initialPoints = Math.min(9999, Math.max(1, Math.round(Number(form.initialPoints) || 30)))
  emit('start', {
    mode: form.mode,
    claimWindowMs: 4000,
    players: Array.from({ length: 4 }, (_, id) => ({
      name: id === 0 ? form.nickname.trim().slice(0, 8) || '你' : `AI ${id}`,
      isHuman: id === 0,
      initialPoints,
      ai: id === 0 ? null : { difficulty: form.difficulty },
    })),
  })
}
</script>

<template>
  <main class="setup-page">
    <section class="setup-card">
      <header>
        <button class="back" type="button" aria-label="返回首页" @click="emit('back')">‹</button>
        <h1>单机设置</h1>
        <div class="tools"><AudioControl /><button type="button" @click="emit('rules')">规则</button></div>
      </header>
      <form @submit.prevent="submit">
        <fieldset class="mode-switch">
          <legend>模式</legend>
          <label :class="{ selected: form.mode === 'finite' }"><input v-model="form.mode" type="radio" value="finite"><span>有限积分</span></label>
          <label :class="{ selected: form.mode === 'unlimited' }"><input v-model="form.mode" type="radio" value="unlimited"><span>无限模式</span></label>
        </fieldset>
        <label class="field"><span>昵称</span><input v-model="form.nickname" maxlength="8" autocomplete="nickname"></label>
        <label v-if="form.mode === 'finite'" class="field"><span>初始积分</span><input v-model.number="form.initialPoints" type="number" min="1" max="9999" inputmode="numeric"></label>
        <label class="field"><span>AI 难度</span><select v-model="form.difficulty"><option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <button class="start" type="submit">开始</button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.setup-page { width: 100%; height: 100dvh; display: grid; place-items: center; overflow: hidden; padding: max(18px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); background: radial-gradient(circle at 50% 0, #1d4035, transparent 42%), #081510; color: #f6f0df; }
.setup-card { width: min(520px, 100%); padding: 28px; border: 1px solid rgba(220,187,96,.25); border-radius: 24px; background: rgba(13,34,28,.96); box-shadow: 0 24px 70px rgba(0,0,0,.35); }
header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin-bottom: 24px; }
h1 { margin: 0; color: #f2d47c; font-size: 26px; }
button { min-height: 44px; border: 1px solid #345248; border-radius: 11px; background: #112b24; color: #e8dfc7; cursor: pointer; font-weight: 800; }
.back { width: 44px; padding: 0; font-size: 28px; }
.tools { display: flex; align-items: center; gap: 8px; }
.tools > button { padding: 0 13px; }
form { display: grid; gap: 15px; }
fieldset { margin: 0; padding: 0; border: 0; }
legend, .field > span { margin-bottom: 7px; color: #94a9a1; font-size: 12px; font-weight: 700; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mode-switch legend { grid-column: 1 / -1; }
.mode-switch label { position: relative; min-height: 52px; display: grid; place-items: center; border: 1px solid #345248; border-radius: 12px; background: #102821; cursor: pointer; }
.mode-switch label.selected { border-color: #d8b95f; background: rgba(216,185,95,.11); color: #f2d47c; }
.mode-switch input { position: absolute; inset: 0; width: 100%; margin: 0; opacity: 0; }
.field { display: grid; }
input, select { width: 100%; min-height: 48px; padding: 0 13px; border: 1px solid #345248; border-radius: 11px; outline: 0; background: #102821; color: #f6f0df; font-size: 15px; }
input:focus, select:focus { border-color: #d8b95f; }
.start { min-height: 54px; margin-top: 8px; border: 0; background: linear-gradient(135deg, #f0d27e, #cda84d); color: #172019; font-size: 18px; box-shadow: 0 10px 28px rgba(205,168,77,.2); }
@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 820px) {
  .setup-page { place-items: stretch; padding: max(14px, env(safe-area-inset-top)) 18px max(16px, env(safe-area-inset-bottom)); }
  .setup-card { width: 100%; margin: auto 0; padding: 0; border: 0; background: transparent; box-shadow: none; }
  header { margin-bottom: 22px; }
  h1 { font-size: 23px; }
  form { gap: 17px; }
  input, select { min-height: 52px; font-size: 16px; }
  .mode-switch label { min-height: 58px; }
  .start { min-height: 58px; }
}
@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .setup-page { padding: max(8px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); }
  .setup-card { width: min(760px, 100%); padding: 14px 18px; }
  header { margin-bottom: 10px; }
  h1 { font-size: 20px; }
  form { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 12px; align-items: end; }
  .mode-switch { grid-column: 1 / 3; }
  .mode-switch label { min-height: 42px; }
  .field input, .field select { min-height: 42px; }
  .start { min-height: 44px; margin: 0; }
}
</style>
