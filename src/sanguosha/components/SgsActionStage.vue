<script setup lang="ts">
import { computed } from 'vue'
import type { GameRequest } from '../engine/requests'
import type { PresentationEvent } from '../engine/presentation'
import type { PlayerView } from '../engine/view'
import { cardGlossary, skillGlossary } from '../glossary'
import { useSgsGlossary } from '../composables/useSgsGlossary'

const props = defineProps<{ view: PlayerView; event: PresentationEvent | null; request: GameRequest | null; busy: boolean }>()
const glossary = useSgsGlossary()
const PHASE: Record<string, string> = { prepare: '准备阶段', judge: '判定阶段', draw: '摸牌阶段', play: '出牌阶段', discard: '弃牌阶段', finish: '结束阶段' }
const current = computed(() => props.view.players.find((player) => player.id === props.view.currentPlayerId))
const phaseText = computed(() => `${current.value?.id === props.view.viewerId ? '你的' : `${current.value?.nickname ?? '当前角色'} · ${current.value?.characterId ? '' : ''}`}${PHASE[props.view.phase] ?? props.view.phase}`)
const waitingText = computed(() => {
  const request = props.view.pendingRequest
  if (!request) return ''
  const actor = props.view.players.find((player) => player.id === request.playerId)
  return actor?.id === props.view.viewerId ? request.prompt : `正在等待${actor?.nickname ?? '当前角色'}响应`
})
</script>

<template>
  <section class="sgs-action-stage" aria-live="polite">
    <div class="sgs-action-stage__phase"><i></i><strong>{{ phaseText }}</strong></div>
    <div v-if="event" :key="event.id" class="sgs-action-stage__event" :class="`sgs-action-stage__event--${event.kind}`">
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
</style>
