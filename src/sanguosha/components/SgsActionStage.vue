<script setup lang="ts">
import { computed } from 'vue'
import type { GameRequest } from '../engine/requests'
import type { StagedEvent } from '../composables/useSgsEventStage'
import type { PlayerView } from '../engine/view'
import { cardGlossary, skillGlossary } from '../glossary'
import { useSgsGlossary } from '../composables/useSgsGlossary'
import { displayCharacterName } from '../data/characters/standard'

const props = defineProps<{ view: PlayerView; staged: StagedEvent | null; request: GameRequest | null; busy: boolean }>()
const event = computed(() => props.staged?.event ?? null)
/** 重要的事件给更大的字号和更强的边框，摸牌这类流水账压小，余光就能分辨轻重。 */
const HEAVY = new Set(['damage', 'lose-hp', 'dying', 'death'])
const weight = computed(() => {
  const kind = event.value?.kind
  if (!kind) return 'light'
  if (HEAVY.has(kind)) return 'heavy'
  if (kind === 'draw' || kind === 'equipment' || kind === 'discard' || kind === 'status') return 'light'
  return 'normal'
})
const glossary = useSgsGlossary()
const PHASE: Record<string, string> = { prepare: '准备阶段', judge: '判定阶段', draw: '摸牌阶段', play: '出牌阶段', discard: '弃牌阶段', finish: '结束阶段' }
const current = computed(() => props.view.players.find((player) => player.id === props.view.currentPlayerId))
const characterName = (playerId?: string) => {
  return playerId ? displayCharacterName(props.view.players, playerId).replace('某角色', '当前角色') : '当前角色'
}
const phaseText = computed(() => `${characterName(current.value?.id)} · ${PHASE[props.view.phase] ?? props.view.phase}`)
const waitingText = computed(() => {
  const request = props.view.pendingRequest
  if (!request) return ''
  const actor = props.view.players.find((player) => player.id === request.playerId)
  if (actor?.id === props.view.viewerId) {
    return props.view.players.reduce((text, player) => text.replaceAll(player.nickname, characterName(player.id)), request.prompt)
  }
  return `正在等待${characterName(actor?.id)}响应`
})
</script>

<template>
  <section class="sgs-action-stage" aria-live="polite">
    <div class="sgs-action-stage__phase"><i></i><strong>{{ phaseText }}</strong></div>
    <div
      v-if="event" :key="event.id" class="sgs-action-stage__event"
      :class="[`sgs-action-stage__event--${event.kind}`, `sgs-action-stage__event--skin-${staged!.skin}`, `sgs-action-stage__event--${weight}`]"
    >
      <span v-if="staged!.chainDepth > 1" class="sgs-action-stage__chain">连环第 {{ staged!.chainDepth }} 张</span>
      <button v-if="event.cardName" type="button" @click="glossary?.open(cardGlossary(event.cardName))">{{ event.cardName }}</button>
      <button v-else-if="event.skillName" type="button" @click="glossary?.open(skillGlossary(event.skillName))">{{ event.skillName }}</button>
      <p>{{ event.text }}</p>
    </div>
    <p v-else class="sgs-action-stage__empty">{{ busy ? '牌局正在推进' : '等待行动' }}</p>
    <p v-if="waitingText" class="sgs-action-stage__waiting">{{ waitingText }}</p>
  </section>
</template>

<style scoped>
.sgs-action-stage{position:absolute;z-index:4;left:50%;top:48%;width:min(310px,38vw);transform:translate(-50%,-50%);display:grid;justify-items:center;gap:6px;text-align:center;pointer-events:none}.sgs-action-stage__phase{display:flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid rgba(185,158,91,.3);border-radius:999px;background:rgba(11,23,18,.8);color:#e9d394;font-size:11px}.sgs-action-stage__phase i{width:6px;height:6px;border-radius:50%;background:#e4bb59;box-shadow:0 0 8px #e4bb59}.sgs-action-stage__event{min-width:190px;padding:9px 13px;border:1px solid rgba(202,176,102,.34);border-radius:12px;background:linear-gradient(150deg,rgba(33,48,39,.94),rgba(12,22,17,.94));box-shadow:0 10px 30px rgba(0,0,0,.34);animation:stage-in .25s ease-out}.sgs-action-stage__event button{pointer-events:auto;min-width:52px;padding:4px 9px;border:1px solid #947a3e;border-radius:7px;background:#4e3c1d;color:#ffe5a5;font-weight:900;cursor:help}.sgs-action-stage__event p{margin:5px 0 0;color:#eee5d0;font-size:12px}.sgs-action-stage__event--damage{border-color:rgba(225,90,73,.55)}.sgs-action-stage__event--recover{border-color:rgba(83,199,127,.55)}.sgs-action-stage__waiting{margin:0;padding:4px 8px;border-radius:6px;background:rgba(80,39,32,.85);color:#ffc0b5;font-size:10px}.sgs-action-stage__empty{margin:0;color:#819188;font-size:10px}@keyframes stage-in{from{opacity:0;transform:translateY(5px)}}@media(max-width:620px){.sgs-action-stage{top:49%;width:min(180px,46vw)}.sgs-action-stage__event{min-width:0;width:100%;padding:6px 8px}.sgs-action-stage__event p{font-size:9px}.sgs-action-stage__phase{font-size:9px;padding:3px 6px}}@media(prefers-reduced-motion:reduce){.sgs-action-stage__event{animation:none}}
/* 轻重分级：伤害类事件放大加重，摸牌装备这类流水账压小，余光就能分辨 */
.sgs-action-stage__event--heavy { padding: 12px 16px; border-width: 2px; box-shadow: 0 12px 34px rgba(0,0,0,.42), 0 0 22px rgba(225,90,73,.22); animation: stage-in-heavy .3s cubic-bezier(.2,1.5,.4,1); }
.sgs-action-stage__event--heavy p { font-size: 13px; font-weight: 700; }
.sgs-action-stage__event--heavy button { font-size: 15px; }
.sgs-action-stage__event--light { padding: 6px 10px; opacity: .82; }
.sgs-action-stage__event--light p { font-size: 11px; }

/* 皮肤 */
.sgs-action-stage__event--skin-strike { border-color: rgba(233,88,70,.7); background: linear-gradient(150deg, rgba(62,32,28,.95), rgba(22,13,11,.95)); }
.sgs-action-stage__event--skin-heal { border-color: rgba(83,199,127,.6); background: linear-gradient(150deg, rgba(28,54,38,.95), rgba(12,26,18,.95)); }
/* 闪：横向抖一下，读起来就是「侧身躲开」 */
.sgs-action-stage__event--skin-dodge { border-color: rgba(214,229,208,.6); animation: stage-dodge .42s ease-out; }
/* 判定：整块翻一次牌 */
.sgs-action-stage__event--skin-judge { border-color: rgba(205,170,240,.5); animation: stage-flip .5s ease-out; transform-style: preserve-3d; }
.sgs-action-stage__event--skin-nullify { border-color: rgba(120,190,235,.62); background: linear-gradient(150deg, rgba(24,44,58,.95), rgba(10,20,28,.95)); }
.sgs-action-stage__chain { padding: 1px 7px; border-radius: 999px; background: rgba(64,120,158,.7); color: #d8f0ff; font-size: 10px; font-weight: 800; }

@keyframes stage-in-heavy { from { opacity: 0; transform: scale(.82); } }
@keyframes stage-dodge { 0%,100% { transform: translateX(0); } 22% { transform: translateX(-11px); } 55% { transform: translateX(9px); } 80% { transform: translateX(-4px); } }
@keyframes stage-flip { from { transform: rotateY(-90deg); opacity: .2; } to { transform: rotateY(0); opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .sgs-action-stage__event--heavy, .sgs-action-stage__event--skin-dodge, .sgs-action-stage__event--skin-judge { animation: none; }
}
</style>
