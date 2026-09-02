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
    <section v-if="open" class="sgs-audio__panel" role="dialog" aria-label="声音设置">
      <header><strong>声音与震动</strong><button type="button" aria-label="关闭" @click="open = false">×</button></header>
      <div class="sgs-audio__block">
        <label><span><b>动作音效</b><small>卡牌、技能与伤害</small></span><input :checked="sgsAudioSettings.effectsEnabled" type="checkbox" @change="sgsAudio.setSetting('effectsEnabled', ($event.target as HTMLInputElement).checked)"></label>
        <input aria-label="动作音效音量" :disabled="!sgsAudioSettings.effectsEnabled" :value="sgsAudioSettings.effectsVolume" type="range" min="0" max="1" step="0.01" @input="sgsAudio.setSetting('effectsVolume', numberValue($event))">
      </div>
      <div class="sgs-audio__block">
        <label><span><b>背景音乐</b><small>原创国风五声音阶</small></span><input :checked="sgsAudioSettings.musicEnabled" type="checkbox" @change="sgsAudio.setSetting('musicEnabled', ($event.target as HTMLInputElement).checked)"></label>
        <input aria-label="背景音乐音量" :disabled="!sgsAudioSettings.musicEnabled" :value="sgsAudioSettings.musicVolume" type="range" min="0" max="1" step="0.01" @input="sgsAudio.setSetting('musicVolume', numberValue($event))">
      </div>
      <label class="sgs-audio__toggle"><span><b>震动反馈</b><small>{{ sgsVibrationSupported ? '自己的关键操作与受伤' : '当前浏览器不支持' }}</small></span><input :checked="sgsAudioSettings.vibrateEnabled" :disabled="!sgsVibrationSupported" type="checkbox" @change="sgsAudio.setSetting('vibrateEnabled', ($event.target as HTMLInputElement).checked)"></label>
    </section>
  </div>
</template>

<style scoped>
.sgs-audio{position:relative;flex:none}.sgs-audio__trigger{min-height:28px;padding:0 10px;border:1px solid #5d563d;border-radius:8px;background:#18231d;color:#d8c995;cursor:pointer;font:inherit;font-weight:700}.sgs-audio__panel{position:absolute;z-index:92;right:0;top:calc(100% + 8px);width:310px;padding:15px;border:1px solid #5d563d;border-radius:15px;background:#111e18;color:#e9e0c8;box-shadow:0 18px 50px #000a}.sgs-audio__panel header,.sgs-audio__panel label{display:flex;align-items:center;justify-content:space-between;gap:12px}.sgs-audio__panel header{margin-bottom:10px}.sgs-audio__panel header strong{color:#f0d58a;font-size:16px}.sgs-audio__panel header button{border:0;background:transparent;color:#aeb9b1;font-size:24px}.sgs-audio__block{display:grid;gap:8px;padding:11px 0;border-top:1px solid #2d3c34}.sgs-audio__panel label span{display:grid}.sgs-audio__panel label b{font-size:13px}.sgs-audio__panel label small{color:#82938a;font-size:10px}.sgs-audio__panel input[type=range]{width:100%;accent-color:#c9a954}.sgs-audio__panel input:disabled{opacity:.35}.sgs-audio__toggle{padding-top:11px;border-top:1px solid #2d3c34}.sgs-audio__mask{display:none}@media(max-width:620px){.sgs-audio__mask{position:fixed;z-index:91;inset:0;display:block;background:#0008}.sgs-audio__panel{position:fixed;z-index:92;left:0;right:0;top:auto;bottom:0;width:auto;padding:18px 18px calc(20px + env(safe-area-inset-bottom));border-radius:20px 20px 0 0}.sgs-audio__panel label{min-height:48px}.sgs-audio__trigger{padding:0 8px;font-size:10px}}@media(orientation:landscape) and (max-height:500px){.sgs-audio__panel{left:50%;right:auto;bottom:auto;top:50%;width:min(420px,90vw);transform:translate(-50%,-50%);border-radius:16px;padding:12px}.sgs-audio__block{padding:7px 0}.sgs-audio__panel label{min-height:36px}}
</style>
