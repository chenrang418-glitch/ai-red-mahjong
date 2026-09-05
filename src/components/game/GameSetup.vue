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
      <p class="setup-intro">安排你的下一局。选择积分模式与电脑难度，即可入座开局。</p>
      <form @submit.prevent="submit">
        <fieldset class="mode-switch">
          <legend>模式</legend>
          <label :class="{ selected: form.mode === 'finite' }"><input v-model="form.mode" type="radio" value="finite"><span>有限积分</span></label>
          <label :class="{ selected: form.mode === 'unlimited' }"><input v-model="form.mode" type="radio" value="unlimited"><span>无限模式</span></label>
        </fieldset>
        <label class="field"><span>昵称</span><input v-model="form.nickname" maxlength="8" autocomplete="nickname"></label>
        <label v-if="form.mode === 'finite'" class="field"><span>初始积分</span><input v-model.number="form.initialPoints" type="number" min="1" max="9999" inputmode="numeric"></label>
        <label class="field"><span>AI 难度</span><select v-model="form.difficulty"><option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option></select></label>
        <p class="setup-summary"><b>4 人 · {{ form.mode === 'finite' ? '有限积分' : '无限模式' }} · {{ difficultyLabels[form.difficulty] }}难度</b><span>下一步：入座开局</span></p>
        <button class="start" type="submit">开始</button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.setup-page { width: 100%; height: calc(100dvh - var(--app-viewport-offset, 0px)); overflow: hidden; color: var(--ink-text); }
#app .setup-card { display: flex; flex-direction: column; gap: 20px; width: min(780px, 100%); height: 100%; margin: auto; padding: max(28px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom)); border: 0; border-radius: 0; background: transparent; box-shadow: none; }
#app .setup-card > header { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin: 0; padding-bottom: 16px; }
h1 { margin: 0; font-size: 22px; }
button { min-height: 38px; border: 1px solid var(--ink-line); border-radius: 9px; background: var(--ink-panel-deep); color: var(--ink-text-soft); cursor: pointer; font: inherit; }
.back { width: 38px; padding: 0; font-size: 24px; }
.tools { display: flex; align-items: center; gap: 8px; }
.tools > button { padding: 0 13px; }
.setup-intro { margin: 0; color: #aebfba; font-size: 13px; line-height: 1.7; }
form { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 14px; }
fieldset { margin: 0; min-width: 0; }
.mode-switch, .field { padding: 12px 20px; border: 1px solid var(--ink-line); border-radius: 14px; background: var(--ink-panel-deep); }
legend, .field > span { color: var(--ink-text-soft); font-size: 13px; }
legend { padding: 0 6px; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mode-switch label { position: relative; min-height: 46px; display: grid; place-items: center; border: 1px solid var(--ink-line); border-radius: 10px; cursor: pointer; }
.mode-switch input { position: absolute; inset: 0; width: 100%; margin: 0; opacity: 0; cursor: pointer; }
.mode-switch label:has(input:focus-visible) { outline: 2px solid #efd29a; outline-offset: 3px; }
.field { display: grid; grid-template-columns: 88px 1fr; gap: 12px; align-items: center; }
input, select { width: 100%; min-width: 0; min-height: 46px; padding: 0 13px; border: 1px solid var(--ink-line); border-radius: 10px; font: inherit; }
.setup-summary { margin: auto 0 0; display: flex; justify-content: space-between; gap: 12px; color: var(--accent-gold); font-size: 13px; }
.setup-summary span { color: var(--ink-text-muted); }
.start { flex: none; min-height: 48px; margin: 0; font-size: 16px; font-weight: 700; }
@media (max-width: 400px) { .tools { gap: 5px; } .tools > button { padding-inline: 9px; } .setup-summary { font-size: 11px; } }
@media (max-height: 700px) {
  #app .setup-card { padding-top: max(12px, env(safe-area-inset-top)); gap: 12px; }
  #app .setup-card > header { padding-bottom: 8px; }
  form { gap: 10px; }
  .mode-switch, .field { padding: 8px 12px; }
  input, select, .mode-switch label { min-height: 40px; }
}
@media (orientation: landscape) and (max-height: 620px) {
  #app .setup-card { width: min(1000px, 100%); gap: 10px; padding-bottom: 12px; }
  form { display: grid; grid-template-columns: 1fr 1fr; align-content: start; gap: 10px 14px; }
  .mode-switch { grid-row: span 2; align-content: center; }
  .field { grid-column: 2; padding: 6px 12px; }
  .setup-summary { align-self: center; flex-direction: column; gap: 4px; }
  .start { grid-column: 2; }
  input, select, .mode-switch label { min-height: 36px; }
}
</style>
