<script setup lang="ts">
import { computed } from 'vue'
import { sgsAudio, sgsAudioSettings, sgsVibrationSupported } from '../composables/useSgsAudio'

const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(defineProps<{ hideTrigger?: boolean }>(), { hideTrigger: false })
const soundOn = computed(() => sgsAudioSettings.musicEnabled || sgsAudioSettings.effectsEnabled)
const numberValue = (event: Event) => Number((event.target as HTMLInputElement).value)
function toggle(): void { sgsAudio.buttonFeedback(); open.value = !open.value }
</script>

<template>
  <div class="sgs-audio">
    <button v-if="!props.hideTrigger" type="button" class="sgs-audio__trigger" :aria-expanded="open" aria-label="声音设置" @click="toggle">{{ soundOn ? '声音' : '静音' }}</button>
    <div v-if="open" class="sgs-audio__mask" @click="open = false"></div>
    <section v-if="open" class="sgs-audio__panel" role="dialog" aria-modal="true" aria-label="声音设置">
      <header><strong>声音</strong><button type="button" aria-label="关闭" @click="open = false">×</button></header>

      <section class="sgs-audio__block">
        <div class="sgs-audio__heading">
          <span><b>音效</b><em>音效音量 {{ Math.round(sgsAudioSettings.effectsVolume * 100) }}</em></span>
          <label class="sgs-audio__switch">
            <input aria-label="动作音效" :checked="sgsAudioSettings.effectsEnabled" type="checkbox" @change="sgsAudio.setSetting('effectsEnabled', ($event.target as HTMLInputElement).checked)">
            <i></i>
          </label>
        </div>
        <input aria-label="动作音效音量" class="sgs-audio__slider" :disabled="!sgsAudioSettings.effectsEnabled" :value="sgsAudioSettings.effectsVolume" type="range" min="0" max="1" step="0.01" @input="sgsAudio.setSetting('effectsVolume', numberValue($event))">
      </section>

      <section class="sgs-audio__block">
        <div class="sgs-audio__heading">
          <span><b>背景音乐</b><em>音乐音量 {{ Math.round(sgsAudioSettings.musicVolume * 100) }}</em></span>
          <label class="sgs-audio__switch">
            <input aria-label="背景音乐" :checked="sgsAudioSettings.musicEnabled" type="checkbox" @change="sgsAudio.setSetting('musicEnabled', ($event.target as HTMLInputElement).checked)">
            <i></i>
          </label>
        </div>
        <input aria-label="背景音乐音量" class="sgs-audio__slider" :disabled="!sgsAudioSettings.musicEnabled" :value="sgsAudioSettings.musicVolume" type="range" min="0" max="1" step="0.01" @input="sgsAudio.setSetting('musicVolume', numberValue($event))">
      </section>

      <label class="sgs-audio__toggle">
        <span><b>震动反馈</b><small v-if="!sgsVibrationSupported">当前浏览器不支持（iPhone 系统未开放）</small></span>
        <span class="sgs-audio__switch">
          <input aria-label="震动反馈" :checked="sgsAudioSettings.vibrateEnabled" :disabled="!sgsVibrationSupported" type="checkbox" @change="sgsAudio.setSetting('vibrateEnabled', ($event.target as HTMLInputElement).checked)">
          <i></i>
        </span>
      </label>
    </section>
  </div>
</template>

<style scoped>
.sgs-audio { position: relative; flex: none; min-width: max-content; }
.sgs-audio__trigger { min-height: 28px; padding: 0 10px; border: 1px solid #5d563d; border-radius: 8px; background: #18231d; color: #d8c995; cursor: pointer; font: inherit; font-weight: 700; }
.sgs-audio__panel { letter-spacing: normal; position: absolute; z-index: 92; right: 0; top: calc(100% + 8px); width: 310px; padding: 16px; border: 1px solid var(--ink-line); border-radius: 16px; background: var(--ink-panel-deep); color: var(--ink-text); box-shadow: 0 18px 50px rgba(0, 0, 0, .65); }
.sgs-audio__panel header, .sgs-audio__heading, .sgs-audio__heading > span, .sgs-audio__toggle { display: flex; align-items: center; }
.sgs-audio__panel header { justify-content: space-between; margin-bottom: 10px; }
.sgs-audio__panel header strong { color: #f0d58a; font-size: 16px; }
.sgs-audio__panel header button { width: 30px; height: 30px; padding: 0; border: 1px solid var(--ink-line); border-radius: 50%; background: var(--ink-panel); color: #e8dbc0; cursor: pointer; font-size: 22px; line-height: 1; }
.sgs-audio__block, .sgs-audio__toggle { padding: 12px 0; border-top: 1px solid var(--ink-line); }
.sgs-audio__heading, .sgs-audio__toggle { justify-content: space-between; gap: 14px; }
.sgs-audio__heading { margin-bottom: 10px; }
.sgs-audio__heading > span { flex: 1; justify-content: space-between; }
.sgs-audio__heading b, .sgs-audio__toggle b { color: var(--ink-text-soft); font-size: 12px; }
.sgs-audio__heading em { margin-left: auto; color: var(--accent-gold); font-size: 11px; font-style: normal; }
.sgs-audio__toggle > span:first-child { display: grid; flex: 1; gap: 2px; }
.sgs-audio__toggle small { color: var(--ink-text-muted); font-size: 9px; }
.sgs-audio__switch { position: relative; width: 42px; height: 24px; flex: 0 0 42px; display: inline-block; cursor: pointer; }
.sgs-audio__switch input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.sgs-audio__switch i { position: absolute; inset: 0; border-radius: 99px; background: var(--ink-line); transition: background .2s ease; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .04); }
.sgs-audio__switch i::after { content: ''; position: absolute; width: 20px; height: 20px; top: 2px; left: 2px; border-radius: 50%; background: #e8eee9; box-shadow: 0 2px 5px rgba(0, 0, 0, .35); transition: transform .2s ease; }
.sgs-audio__switch input:checked + i { background: var(--accent-gold); }
.sgs-audio__switch input:checked + i::after { transform: translateX(18px); background: #fff9e7; }
.sgs-audio__switch input:focus-visible + i { outline: 2px solid #f2d477; outline-offset: 2px; }
.sgs-audio__switch input:disabled + i { opacity: .35; }
.sgs-audio__slider { width: 100%; height: 18px; margin: 0; accent-color: var(--accent-gold); cursor: pointer; }
.sgs-audio__slider:disabled { opacity: .32; cursor: default; }
.sgs-audio__mask { display: none; }

@media (max-width: 620px), (pointer: coarse) {
  .sgs-audio__mask { position: fixed; z-index: 91; inset: 0; display: block; background: rgba(0, 0, 0, .52); }
  .sgs-audio__panel { position: fixed; z-index: 92; left: 0; right: 0; top: auto; bottom: 0; width: auto; padding: 0 18px calc(20px + env(safe-area-inset-bottom)); border-right: 0; border-bottom: 0; border-left: 0; border-radius: 20px 20px 0 0; background: var(--ink-panel-deep); animation: sgs-audio-up .24s ease; }
  .sgs-audio__panel header { min-height: 62px; margin: 0 -18px 12px; padding: 0 18px; border-bottom: 1px solid var(--ink-line); }
  .sgs-audio__panel header strong { color: #f3d67c; font-size: 21px; }
  .sgs-audio__panel header button { border: 0; background: transparent; color: var(--ink-text-muted); font-size: 28px; }
  .sgs-audio__block { padding: 0 0 14px; border: 0; }
  .sgs-audio__heading, .sgs-audio__toggle { min-height: 62px; padding: 0 16px; border: 1px solid var(--ink-line); border-radius: 15px; background: var(--ink-panel); }
  .sgs-audio__heading { margin-bottom: 8px; }
  .sgs-audio__heading > span { display: grid; justify-content: start; gap: 3px; }
  .sgs-audio__heading b, .sgs-audio__toggle b { font-size: 18px; }
  .sgs-audio__heading em { margin: 0; color: var(--ink-text-muted); font-size: 12px; }
  .sgs-audio__switch { width: 50px; height: 29px; flex-basis: 50px; }
  .sgs-audio__switch i::after { width: 25px; height: 25px; }
  .sgs-audio__switch input:checked + i::after { transform: translateX(21px); }
  .sgs-audio__slider { height: 26px; }
  .sgs-audio__trigger { padding: 0 8px; font-size: 10px; }
}

@media (orientation: landscape) and (max-height: 500px) {
  .sgs-audio__panel { left: 50%; right: auto; bottom: auto; top: 50%; width: min(480px, 82vw); padding: 0 14px 14px; border: 1px solid var(--ink-line); border-radius: 16px; transform: translate(-50%, -50%); animation: none; }
  .sgs-audio__panel header { min-height: 44px; margin: 0 -14px 9px; padding: 0 14px; }
  .sgs-audio__heading, .sgs-audio__toggle { min-height: 46px; border-radius: 10px; }
  .sgs-audio__heading b, .sgs-audio__toggle b { font-size: 14px; }
  .sgs-audio__block { padding-bottom: 8px; }
  .sgs-audio__slider { height: 18px; }
}

@keyframes sgs-audio-up { from { transform: translateY(100%); } }
@media (prefers-reduced-motion: reduce) { .sgs-audio__panel { animation: none; } }
</style>
