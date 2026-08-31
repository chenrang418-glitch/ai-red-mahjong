<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { gameAudio, gameAudioSettings, vibrationSupported } from '@/composables/useGameAudio'

// 手机上这个组件挂在「⋯」菜单里，点一下菜单就收起、组件跟着卸载，
// 弹层还没画出来就没了。所以支持受控：由页面持有开关状态，
// 触发按钮和弹层可以分开放。
const props = withDefaults(defineProps<{ open?: boolean; hideTrigger?: boolean }>(), {
  open: undefined,
  hideTrigger: false,
})
const emit = defineEmits<{ 'update:open': [boolean] }>()

const innerOpen = ref(false)
const open = computed({
  get: () => props.open ?? innerOpen.value,
  set: (value: boolean) => {
    if (props.open === undefined) innerOpen.value = value
    else emit('update:open', value)
  },
})

// 手机上这个组件常常嵌在「⋯」菜单里，弹层跟着按钮定位就会被菜单的宽度和层级坑住
// （310px 的面板塞进 176px 的菜单，右对齐直接跑到屏幕外）。
// 所以手机端把弹层 Teleport 到 body，改成底部抽屉。
const compact = ref(false)
let query: MediaQueryList | null = null
function syncCompact(event: MediaQueryList | MediaQueryListEvent) {
  compact.value = event.matches
}
onMounted(() => {
  query = window.matchMedia('(pointer: coarse), (max-width: 820px) and (orientation: portrait), (max-height: 620px) and (orientation: landscape)')
  syncCompact(query)
  query.addEventListener('change', syncCompact)
})
onBeforeUnmount(() => query?.removeEventListener('change', syncCompact))

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
    <button v-if="!hideTrigger" class="audio-trigger" type="button" :aria-expanded="open" @click="toggleOpen">声音</button>

    <Teleport to="body" :disabled="!compact">
      <div v-if="open && compact" class="audio-mask" @click="open = false"></div>
      <div v-if="open" class="audio-popover" :class="{ sheet: compact }">
        <header><strong>声音</strong><button type="button" @click="open = false">×</button></header>

        <section class="setting-block">
          <div class="setting-heading">
            <span><b>音效</b><em>音效音量 {{ Math.round(gameAudioSettings.effectsVolume * 100) }}</em></span>
            <label class="ios-switch">
              <input aria-label="动作音效" :checked="gameAudioSettings.effectsEnabled" type="checkbox" @change="gameAudio.setSetting('effectsEnabled', ($event.target as HTMLInputElement).checked)">
              <i></i>
            </label>
          </div>
          <input aria-label="动作音效音量" class="volume-slider" :disabled="!gameAudioSettings.effectsEnabled" :value="gameAudioSettings.effectsVolume" type="range" min="0" max="1" step="0.01" @input="gameAudio.setSetting('effectsVolume', numberValue($event))">
        </section>

        <section class="setting-block">
          <div class="setting-heading">
            <span><b>背景音乐</b><em>音乐音量 {{ Math.round(gameAudioSettings.musicVolume * 100) }}</em></span>
            <label class="ios-switch">
              <input aria-label="对局音乐" :checked="gameAudioSettings.musicEnabled" type="checkbox" @change="gameAudio.setSetting('musicEnabled', ($event.target as HTMLInputElement).checked)">
              <i></i>
            </label>
          </div>
          <input aria-label="对局音乐音量" class="volume-slider" :disabled="!gameAudioSettings.musicEnabled" :value="gameAudioSettings.musicVolume" type="range" min="0" max="1" step="0.01" @input="gameAudio.setSetting('musicVolume', numberValue($event))">
        </section>

        <label class="setting-toggle">
          <span class="setting-copy">
            <b>震动反馈</b>
            <small v-if="!vibrationSupported" class="unsupported">当前浏览器不支持（iPhone 上系统未开放）</small>
          </span>
          <span class="ios-switch">
            <input aria-label="震动反馈" :checked="gameAudioSettings.vibrateEnabled" :disabled="!vibrationSupported" type="checkbox" @change="gameAudio.setSetting('vibrateEnabled', ($event.target as HTMLInputElement).checked)">
            <i></i>
          </span>
        </label>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.audio-control { position: relative; flex: 0 0 auto; min-width: max-content; }
.audio-trigger { min-width: 54px; height: 34px; display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border: 1px solid #315248; border-radius: 8px; background: #10251f; color: #e6d8b2; cursor: pointer; font-weight: 700; white-space: nowrap; }
.audio-popover { position: absolute; z-index: 90; top: calc(100% + 9px); right: 0; width: 310px; padding: 16px; border: 1px solid #496258; border-radius: 16px; background: #10251f; box-shadow: 0 18px 45px rgba(0,0,0,.48); color: #e9e1ca; }

/* 手机端：从底部升起的整条，不再跟着按钮定位 */
.audio-popover.sheet {
  position: fixed;
  z-index: 96;
  top: auto;
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  padding: 18px 20px calc(24px + env(safe-area-inset-bottom));
  border-radius: 20px 20px 0 0;
  border-left: 0;
  border-right: 0;
  border-bottom: 0;
  animation: audio-up .24s ease;
}
.audio-mask { position: fixed; z-index: 95; inset: 0; background: rgba(0,0,0,.5); }
@keyframes audio-up { from { transform: translateY(100%); } }

header, .setting-toggle, .setting-heading, .setting-heading > span { display: flex; align-items: center; }
header { justify-content: space-between; margin-bottom: 10px; }
header strong { font-size: 15px; }
header button { width: 30px; height: 30px; padding: 0; border: 1px solid #3b564d; border-radius: 50%; background: #18342c; color: #e8dbc0; cursor: pointer; }
.setting-toggle, .setting-block { padding: 12px 0; border-top: 1px solid #2a443b; }
.setting-toggle { justify-content: space-between; gap: 14px; cursor: pointer; }
.setting-copy { display: grid; gap: 2px; }
.setting-copy b, .setting-heading b { color: #c4d0cc; font-size: 12px; }
.setting-copy small { color: #70867f; font-size: 9px; }
.setting-copy small.unsupported { color: #9d8055; }
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
.ios-switch input:disabled + i { opacity: .35; }
.volume-slider { width: 100%; height: 18px; margin: 0; accent-color: #d8b95f; cursor: pointer; }
.volume-slider:disabled { opacity: .32; cursor: default; }

/* 手机端把字号放大一档，手指点得准 */
@media (pointer: coarse), (max-width: 820px) {
  .audio-popover.sheet { padding: 0 18px calc(20px + env(safe-area-inset-bottom)); background: #0c211b; }
  .audio-popover.sheet header { min-height: 62px; margin: 0 -18px 12px; padding: 0 18px; border-bottom: 1px solid #1d352d; }
  .audio-popover.sheet header strong { color: #f3d67c; font-size: 21px; }
  .audio-popover.sheet header button { border: 0; background: transparent; color: #8ba49c; font-size: 28px; }
  .audio-popover.sheet .setting-copy b, .audio-popover.sheet .setting-heading b { font-size: 18px; }
  .audio-popover.sheet .setting-heading { min-height: 62px; margin: 0 0 8px; padding: 0 16px; border: 1px solid #355249; border-radius: 15px; background: #102a22; }
  .audio-popover.sheet .setting-heading > span { display: grid; justify-content: start; gap: 3px; }
  .audio-popover.sheet .setting-heading em { margin: 0; color: #82978f; font-size: 12px; }
  .audio-popover.sheet .setting-block { padding: 0 0 14px; border: 0; }
  .audio-popover.sheet .setting-toggle { min-height: 62px; margin-top: 2px; padding: 0 16px; border: 1px solid #355249; border-radius: 15px; background: #102a22; }
  .audio-popover.sheet .ios-switch { width: 50px; height: 29px; flex-basis: 50px; }
  .audio-popover.sheet .ios-switch i::after { width: 25px; height: 25px; }
  .audio-popover.sheet .ios-switch input:checked + i::after { transform: translateX(21px); }
  .audio-popover.sheet .volume-slider { height: 26px; }
}

@media (pointer: coarse) and (orientation: landscape), (orientation: landscape) and (max-height: 620px) {
  .audio-popover.sheet {
    top: 50%; left: 50%; right: auto; bottom: auto;
    width: min(500px, 74vw);
    padding: 0 14px 14px;
    border: 1px solid #355249;
    border-radius: 16px;
    transform: translate(-50%, -50%);
    animation: none;
  }
  .audio-popover.sheet header { min-height: 44px; margin: 0 -14px 9px; padding: 0 14px; }
  .audio-popover.sheet header strong { font-size: 18px; }
  .audio-popover.sheet .setting-heading, .audio-popover.sheet .setting-toggle { min-height: 46px; border-radius: 10px; }
  .audio-popover.sheet .setting-heading b, .audio-popover.sheet .setting-copy b { font-size: 14px; }
  .audio-popover.sheet .setting-block { padding-bottom: 8px; }
  .audio-popover.sheet .volume-slider { height: 18px; }
}
</style>
