<script setup lang="ts">
import { ref } from 'vue'
import { gameAudio, gameAudioSettings } from '@/composables/useGameAudio'

const open = ref(false)

function numberValue(event: Event) {
  return Number((event.target as HTMLInputElement).value)
}

function toggleOpen() {
  gameAudio.unlock()
  open.value = !open.value
}
</script>

<template>
  <div class="audio-control">
    <button class="audio-trigger" type="button" :aria-expanded="open" @click="toggleOpen">
      {{ gameAudioSettings.muted ? '静音' : '声音' }}
    </button>
    <div v-if="open" class="audio-popover">
      <header><strong>声音设置</strong><button type="button" @click="open = false">×</button></header>
      <label class="setting-toggle">
        <span class="setting-copy"><b>总声音</b><small>控制全部音乐与动作音效</small></span>
        <span class="ios-switch">
          <input aria-label="总声音" :checked="!gameAudioSettings.muted" type="checkbox" @change="gameAudio.setSetting('muted', !($event.target as HTMLInputElement).checked)">
          <i></i>
        </span>
      </label>
      <section class="setting-block">
        <div class="setting-heading">
          <span><b>对局音乐</b><em>{{ Math.round(gameAudioSettings.musicVolume * 100) }}%</em></span>
          <label class="ios-switch">
            <input aria-label="对局音乐" :checked="gameAudioSettings.musicEnabled" type="checkbox" @change="gameAudio.setSetting('musicEnabled', ($event.target as HTMLInputElement).checked)">
            <i></i>
          </label>
        </div>
        <input aria-label="对局音乐音量" class="volume-slider" :disabled="gameAudioSettings.muted || !gameAudioSettings.musicEnabled" :value="gameAudioSettings.musicVolume" type="range" min="0" max="1" step="0.01" @input="gameAudio.setSetting('musicVolume', numberValue($event))">
      </section>
      <section class="setting-block">
        <div class="setting-heading">
          <span><b>动作音效</b><em>{{ Math.round(gameAudioSettings.effectsVolume * 100) }}%</em></span>
          <label class="ios-switch">
            <input aria-label="动作音效" :checked="gameAudioSettings.effectsEnabled" type="checkbox" @change="gameAudio.setSetting('effectsEnabled', ($event.target as HTMLInputElement).checked)">
            <i></i>
          </label>
        </div>
        <input aria-label="动作音效音量" class="volume-slider" :disabled="gameAudioSettings.muted || !gameAudioSettings.effectsEnabled" :value="gameAudioSettings.effectsVolume" type="range" min="0" max="1" step="0.01" @input="gameAudio.setSetting('effectsVolume', numberValue($event))">
      </section>
      <p>音乐和音效均在本地生成，不访问网络。</p>
    </div>
  </div>
</template>

<style scoped>
.audio-control { position: relative; flex: 0 0 auto; min-width: max-content; }
.audio-trigger { min-width: 54px; height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border: 1px solid #315248; border-radius: 8px; background: #10251f; color: #e6d8b2; cursor: pointer; font-weight: 700; white-space: nowrap; }
.audio-popover { position: absolute; z-index: 90; top: calc(100% + 9px); right: 0; width: 310px; padding: 16px; border: 1px solid #496258; border-radius: 16px; background: #10251f; box-shadow: 0 18px 45px rgba(0,0,0,.48); color: #e9e1ca; }
header, .setting-toggle, .setting-heading, .setting-heading > span { display: flex; align-items: center; }
header { justify-content: space-between; margin-bottom: 10px; }
header strong { font-size: 15px; }
header button { width: 30px; height: 30px; padding: 0; border: 1px solid #3b564d; border-radius: 50%; background: #18342c; color: #e8dbc0; cursor: pointer; }
.setting-toggle, .setting-block { padding: 12px 0; border-top: 1px solid #2a443b; }
.setting-toggle { justify-content: space-between; gap: 14px; cursor: pointer; }
.setting-copy { display: grid; gap: 2px; }
.setting-copy b, .setting-heading b { color: #c4d0cc; font-size: 12px; }
.setting-copy small { color: #70867f; font-size: 9px; }
.setting-heading { justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.setting-heading > span { flex: 1; justify-content: space-between; }
.setting-heading em { margin-left: auto; color: #d9bd6d; font-size: 11px; font-style: normal; }
.ios-switch { position: relative; width: 42px; height: 24px; flex: 0 0 42px; display: inline-block; cursor: pointer; }
.ios-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.ios-switch i { position: absolute; inset: 0; border-radius: 99px; background: #3a5049; transition: background .2s ease; box-shadow: inset 0 0 0 1px rgba(255,255,255,.04); }
.ios-switch i::after { content: ''; position: absolute; width: 20px; height: 20px; top: 2px; left: 2px; border-radius: 50%; background: #e8eee9; box-shadow: 0 2px 5px rgba(0,0,0,.35); transition: transform .2s ease; }
.ios-switch input:checked + i { background: #d5b652; }
.ios-switch input:checked + i::after { transform: translateX(18px); background: #fff9e7; }
.ios-switch input:focus-visible + i { outline: 2px solid #f2d477; outline-offset: 2px; }
.volume-slider { width: 100%; height: 18px; margin: 0; accent-color: #d8b95f; cursor: pointer; }
.volume-slider:disabled { opacity: .32; cursor: default; }
p { margin: 8px 0 0; color: #738a82; font-size: 9px; line-height: 1.5; }
</style>
