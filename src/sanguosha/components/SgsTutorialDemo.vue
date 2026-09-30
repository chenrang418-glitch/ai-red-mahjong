<script setup lang="ts">
import { ref } from 'vue'
import { SGS_TUTORIAL_STEPS } from '../shared/tutorial'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const step = ref(0)

function close(): void {
  step.value = 0
  emit('close')
}
function next(): void {
  if (step.value === SGS_TUTORIAL_STEPS.length - 1) close()
  else step.value += 1
}
</script>

<template>
  <div v-if="open" class="sgs-tutorial-demo__backdrop" @click.self="close">
    <section class="sgs-tutorial-demo" role="dialog" aria-modal="true" aria-label="新手引导模拟对局">
      <header><strong>模拟对局</strong><button type="button" aria-label="关闭新手引导" @click="close">×</button></header>
      <div class="sgs-tutorial-demo__table" :data-step="step">
        <div class="sgs-tutorial-demo__bar"><span>第 3 回合</span><button type="button" :class="{ active: step === 4 }">战报</button></div>
        <div class="sgs-tutorial-demo__arena">
          <div class="sgs-tutorial-demo__enemy enemy-a">魏<br><small>3 / 4</small></div>
          <div class="sgs-tutorial-demo__enemy enemy-b">蜀<br><small>4 / 4</small></div>
          <div class="sgs-tutorial-demo__enemy enemy-c">吴<br><small>2 / 3</small></div>
          <div class="sgs-tutorial-demo__self" :class="{ active: step === 1 }"><b>你的角色</b><span>主公 · ♥♥♥♡</span><small>技能 · 装备 · 状态</small><button type="button" :class="{ active: step === 2 }">详</button></div>
        </div>
        <div class="sgs-tutorial-demo__hand" :class="{ active: step === 0 }"><i>杀</i><i>闪</i><i>桃</i><i>决斗</i></div>
        <div class="sgs-tutorial-demo__dock" :class="{ active: step === 3 || step === 5 }"><span>{{ step === 5 ? '没有牌要出时' : '请选择一张牌或技能' }}</span><button type="button">{{ step === 5 ? '结束出牌' : '确定' }}</button></div>
      </div>
      <aside class="sgs-tutorial-demo__explain" aria-live="polite">
        <small>{{ step + 1 }} / {{ SGS_TUTORIAL_STEPS.length }}</small>
        <strong>{{ SGS_TUTORIAL_STEPS[step].title }}</strong>
        <p>{{ SGS_TUTORIAL_STEPS[step].text }}</p>
        <div>
          <button type="button" class="ghost" @click="close">退出</button>
          <button v-if="step > 0" type="button" class="ghost" @click="step -= 1">上一步</button>
          <button type="button" class="primary" @click="next">{{ step === SGS_TUTORIAL_STEPS.length - 1 ? '完成' : '下一步' }}</button>
        </div>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.sgs-tutorial-demo__backdrop{position:fixed;inset:0;z-index:140;display:grid;place-items:center;padding:14px;background:rgba(2,7,5,.82)}
.sgs-tutorial-demo{width:min(760px,100%);max-height:calc(100dvh - 28px);overflow:auto;border:1px solid #806c42;border-radius:18px;background:#101b17;color:#eee6d2;box-shadow:0 24px 80px #000}
.sgs-tutorial-demo>header{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid #3d4b42}.sgs-tutorial-demo>header strong{color:#f1d68c}.sgs-tutorial-demo>header button{width:38px;height:38px;border:0;background:transparent;color:#ddd4c0;font-size:26px;cursor:pointer}
.sgs-tutorial-demo__table{position:relative;height:min(48dvh,360px);min-height:250px;display:grid;grid-template-rows:auto 1fr auto auto;overflow:hidden;background:radial-gradient(ellipse at 50% 42%,#315c43,#173829 55%,#0d2018)}
.sgs-tutorial-demo__bar{display:flex;justify-content:space-between;padding:8px 10px;color:#aab9af;font-size:11px}.sgs-tutorial-demo__bar button,.sgs-tutorial-demo__dock button{border:1px solid #796434;border-radius:7px;background:#493916;color:#ffe3a0}
.sgs-tutorial-demo__arena{position:relative}.sgs-tutorial-demo__enemy,.sgs-tutorial-demo__self{position:absolute;display:grid;place-items:center;border:1px solid #617268;border-radius:9px;background:#1a2b23;color:#dbc991;font-size:12px}.sgs-tutorial-demo__enemy{width:78px;height:54px}.enemy-a{left:7%;top:18%}.enemy-b{left:50%;top:4%;transform:translateX(-50%)}.enemy-c{right:7%;top:18%}.sgs-tutorial-demo__self{left:5%;bottom:2%;width:115px;height:68px;align-content:center;gap:3px}.sgs-tutorial-demo__self span,.sgs-tutorial-demo__self small{font-size:9px;color:#b9c4bc}.sgs-tutorial-demo__self>button{position:absolute;right:2px;bottom:2px;width:32px;height:28px;border:0;background:transparent;color:#f1d47e;font-weight:900}
.sgs-tutorial-demo__hand{display:flex;justify-content:center;gap:4px;padding:5px}.sgs-tutorial-demo__hand i{width:43px;height:60px;display:grid;place-items:center;border:1px solid #b9a575;border-radius:5px;background:#eee4cc;color:#852f2a;font:700 13px KaiTi,serif;font-style:normal}
.sgs-tutorial-demo__dock{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 12px;border-top:1px solid #51492f;background:#132019;color:#cfbd8d;font-size:11px}.sgs-tutorial-demo__dock button{min-height:32px;padding:0 14px}
.sgs-tutorial-demo__table :is(.sgs-tutorial-demo__bar,.sgs-tutorial-demo__arena,.sgs-tutorial-demo__hand,.sgs-tutorial-demo__dock){transition:filter .15s,opacity .15s}
.sgs-tutorial-demo__table[data-step="0"]>.sgs-tutorial-demo__bar,.sgs-tutorial-demo__table[data-step="0"]>.sgs-tutorial-demo__arena,.sgs-tutorial-demo__table[data-step="0"]>.sgs-tutorial-demo__dock,.sgs-tutorial-demo__table[data-step="1"]>.sgs-tutorial-demo__bar,.sgs-tutorial-demo__table[data-step="1"]>.sgs-tutorial-demo__hand,.sgs-tutorial-demo__table[data-step="1"]>.sgs-tutorial-demo__dock,.sgs-tutorial-demo__table[data-step="2"]>.sgs-tutorial-demo__bar,.sgs-tutorial-demo__table[data-step="2"]>.sgs-tutorial-demo__hand,.sgs-tutorial-demo__table[data-step="2"]>.sgs-tutorial-demo__dock,.sgs-tutorial-demo__table[data-step="3"]>.sgs-tutorial-demo__bar,.sgs-tutorial-demo__table[data-step="3"]>.sgs-tutorial-demo__arena,.sgs-tutorial-demo__table[data-step="3"]>.sgs-tutorial-demo__hand,.sgs-tutorial-demo__table[data-step="4"]>.sgs-tutorial-demo__arena,.sgs-tutorial-demo__table[data-step="4"]>.sgs-tutorial-demo__hand,.sgs-tutorial-demo__table[data-step="4"]>.sgs-tutorial-demo__dock,.sgs-tutorial-demo__table[data-step="5"]>.sgs-tutorial-demo__bar,.sgs-tutorial-demo__table[data-step="5"]>.sgs-tutorial-demo__arena,.sgs-tutorial-demo__table[data-step="5"]>.sgs-tutorial-demo__hand{filter:brightness(.32)}
.sgs-tutorial-demo__table[data-step="1"] .sgs-tutorial-demo__arena::after,.sgs-tutorial-demo__table[data-step="2"] .sgs-tutorial-demo__arena::after{content:'';position:absolute;inset:0;z-index:1;background:rgba(0,0,0,.68);pointer-events:none}.sgs-tutorial-demo__table[data-step="4"] .sgs-tutorial-demo__bar>span{filter:brightness(.32)}
.active{z-index:2;outline:3px solid #f0cd65;outline-offset:2px;box-shadow:0 0 22px rgba(240,205,101,.58)}
.sgs-tutorial-demo__explain{display:grid;gap:7px;padding:12px 14px}.sgs-tutorial-demo__explain small{color:#94a49b;font-size:10px}.sgs-tutorial-demo__explain strong{color:#f0d58a;font-size:16px}.sgs-tutorial-demo__explain p{margin:0;color:#c5d0c9;font-size:12px;line-height:1.5}.sgs-tutorial-demo__explain div{display:flex;justify-content:flex-end;gap:8px}.sgs-tutorial-demo__explain button{min-width:72px;min-height:42px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700}.ghost{border:1px solid #3f4d45;background:#16241e;color:#b9c5bd}.primary{border:1px solid #9e7f3c;background:#5b461f;color:#ffe6a8}
@media(max-width:620px){.sgs-tutorial-demo__table{height:42dvh}.sgs-tutorial-demo__enemy{width:62px;height:47px}.sgs-tutorial-demo__self{width:96px}.sgs-tutorial-demo__explain div{flex-wrap:wrap}}
</style>
