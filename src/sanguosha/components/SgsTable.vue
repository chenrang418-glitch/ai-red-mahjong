<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SgsCard from './SgsCard.vue'
import SgsSeatLayout from './SgsSeatLayout.vue'
import SgsRequestDock from './SgsRequestDock.vue'
import SgsCountdown from './SgsCountdown.vue'
import type { LegalAction } from '../engine/actions'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { PresentationEvent } from '../engine/presentation'
import type { PlayerView } from '../engine/view'

const props = withDefaults(defineProps<{
  view: PlayerView
  request: GameRequest | null
  legalActions: readonly LegalAction[]
  busy: boolean
  log: readonly string[]
  presentationEvents?: readonly PresentationEvent[]
  deadlineAt?: number | null
  connectionStatuses?: Readonly<Record<string, 'online' | 'offline' | 'trustee' | 'connecting'>>
}>(), { presentationEvents: () => [], deadlineAt: null, connectionStatuses: () => ({}) })
const emit = defineEmits<{ act: [actionId: string]; respond: [response: GameResponse]; quit: [] }>()

const selectedCardId = ref<string | null>(null)
const selectedMode = ref<string | null>(null)
const selectedTargetIds = ref<string[]>([])
const logOpen = ref(false)
const me = computed(() => props.view.players.find((player) => player.id === props.view.viewerId)!)
const latestEvent = computed(() => props.presentationEvents.at(-1) ?? null)
const usableCardIds = computed(() => new Set(props.legalActions.flatMap((action) => action.kind === 'use-card' ? action.cardIds : [])))
const selectedActions = computed(() => props.legalActions.filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card' && !!selectedCardId.value && action.cardIds.includes(selectedCardId.value)))
const modes = computed(() => [...new Map(selectedActions.value.map((action) => [action.asCardName, action])).values()].map((action) => ({ id: action.asCardName, label: action.asCardName })))
const activeMode = computed(() => selectedMode.value ?? (modes.value.length === 1 ? modes.value[0].id : null))
const modeActions = computed(() => selectedActions.value.filter((action) => !activeMode.value || action.asCardName === activeMode.value))
const requestTargets = computed(() => props.request?.kind === 'choose-targets' ? props.request : null)
const candidateTargetIds = computed(() => new Set(requestTargets.value?.candidateIds ?? modeActions.value.flatMap((action) => action.targetIds)))
const selectableTargetIds = computed(() => candidateTargetIds.value)
const exactAction = computed(() => modeActions.value.find((action) => action.targetIds.length === selectedTargetIds.value.length && action.targetIds.every((id) => selectedTargetIds.value.includes(id))) ?? null)
const standaloneActions = computed(() => props.legalActions.filter((action) => action.kind === 'invoke-skill' || action.kind === 'pass'))

watch(() => props.view.seq, () => {
  if (selectedCardId.value && !me.value.hand?.some((card) => card.id === selectedCardId.value)) resetSelection()
})
watch(() => props.request?.id, () => { selectedTargetIds.value = [] })

function resetSelection(): void { selectedCardId.value = null; selectedMode.value = null; selectedTargetIds.value = [] }
function toggleCard(cardId: string): void {
  if (selectedCardId.value === cardId) { resetSelection(); return }
  selectedCardId.value = cardId; selectedMode.value = null; selectedTargetIds.value = []
}
function toggleTarget(playerId: string): void {
  if (!candidateTargetIds.value.has(playerId)) return
  const index = selectedTargetIds.value.indexOf(playerId)
  if (index >= 0) { selectedTargetIds.value.splice(index, 1); return }
  const max = requestTargets.value?.max ?? Math.max(1, ...modeActions.value.map((action) => action.targetMax))
  if (selectedTargetIds.value.length >= max) selectedTargetIds.value.shift()
  selectedTargetIds.value.push(playerId)
}
function confirmTargets(): void {
  if (requestTargets.value) {
    if (selectedTargetIds.value.length < requestTargets.value.min || selectedTargetIds.value.length > requestTargets.value.max) return
    emit('respond', { requestId: requestTargets.value.id, playerId: requestTargets.value.playerId, payload: { targetIds: [...selectedTargetIds.value] } })
  } else if (exactAction.value) emit('act', exactAction.value.id)
  resetSelection()
}
function act(actionId: string): void { emit('act', actionId); resetSelection() }
</script>

<template>
  <div class="sgs-table">
    <header class="sgs-table__bar">
      <button type="button" class="sgs-table__back" aria-label="退出牌局" @click="emit('quit')">‹</button>
      <span>第 {{ view.turnNumber }} 回合</span><span>牌堆 {{ view.drawPileCount }}</span><span>弃牌 {{ view.discardPile.length }}</span>
      <SgsCountdown :deadline-at="deadlineAt" />
      <button type="button" class="sgs-table__logbtn" @click="logOpen = true">战报</button>
    </header>

    <main class="sgs-table__arena">
      <SgsSeatLayout :view="view" :request="request" :event="latestEvent" :busy="busy" :selectable-ids="selectableTargetIds" :selected-ids="selectedTargetIds" :statuses="connectionStatuses" @select="toggleTarget" />
      <div v-if="view.processingArea.length" class="sgs-table__processing"><SgsCard v-for="card in view.processingArea" :key="card.id" :card="card" compact disabled /></div>
    </main>

    <section class="sgs-table__hand" aria-label="你的手牌">
      <SgsCard v-for="card in me.hand ?? []" :key="card.id" :card="card" :selected="selectedCardId === card.id" :disabled="!!request || !usableCardIds.has(card.id)" @click="toggleCard(card.id)" />
    </section>

    <section v-if="requestTargets" class="sgs-table__dock">
      <p class="sgs-table__hint">{{ requestTargets.prompt }} · 已选择 {{ selectedTargetIds.length }} / {{ requestTargets.max }}</p>
      <div class="sgs-table__actions"><button v-if="requestTargets.min === 0" type="button" class="ghost" @click="selectedTargetIds=[]; confirmTargets()">跳过</button><button type="button" class="primary" :disabled="selectedTargetIds.length < requestTargets.min" @click="confirmTargets">确定</button></div>
    </section>
    <SgsRequestDock v-else-if="request" :request="request" :view="view" @submit="emit('respond', $event)" />
    <section v-else-if="legalActions.length" class="sgs-table__dock">
      <template v-if="selectedCardId">
        <p class="sgs-table__hint">{{ candidateTargetIds.size ? `请直接点击牌桌上的目标（已选 ${selectedTargetIds.length}）` : '确认使用这张牌' }}</p>
        <div v-if="modes.length > 1" class="sgs-table__actions"><button v-for="mode in modes" :key="mode.id" type="button" :class="activeMode === mode.id ? 'primary' : 'ghost'" @click="selectedMode=mode.id;selectedTargetIds=[]">当【{{ mode.label }}】使用</button></div>
        <div class="sgs-table__actions"><button type="button" class="ghost" @click="resetSelection">取消</button><button type="button" class="primary" :disabled="!exactAction" @click="confirmTargets">确定</button></div>
      </template>
      <div v-else class="sgs-table__actions"><button v-for="action in standaloneActions" :key="action.id" type="button" :class="action.kind === 'pass' ? 'ghost' : 'primary'" @click="act(action.id)">{{ action.label }}</button></div>
    </section>
    <section v-else class="sgs-table__dock sgs-table__dock--idle"><p>{{ view.pendingRequest ? '正在等待其他角色响应…' : busy ? '其他角色正在思考…' : '等待牌局推进' }}</p></section>

    <div v-if="logOpen" class="sgs-table__mask" @click="logOpen=false"></div><aside v-if="logOpen" class="sgs-table__log" aria-label="战报"><header><strong>历史战报</strong><button type="button" @click="logOpen=false">×</button></header><ol v-if="log.length"><li v-for="(entry,index) in log" :key="index">{{ entry }}</li></ol><p v-else>还没有可显示的记录。</p></aside>
  </div>
</template>

<style scoped>
.sgs-table{height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;overflow:hidden;color:#e7e0cc;background:radial-gradient(ellipse at 50% 42%,#315c43 0,#173829 47%,transparent 72%),linear-gradient(150deg,var(--ink-bg-top),var(--ink-bg-bottom))}.sgs-table__bar{display:flex;align-items:center;gap:10px;padding:max(7px,env(safe-area-inset-top)) 12px 5px;color:#98aaa0;font-size:11px}.sgs-table__bar span{white-space:nowrap}.sgs-table__back{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid rgba(90,130,110,.35);border-radius:9px;background:rgba(10,28,23,.78);color:#efe7d2;font-size:20px;cursor:pointer}.sgs-table__logbtn{margin-left:auto;min-height:28px;padding:0 10px;border:1px solid #3f4d45;border-radius:8px;background:#16241e;color:#c3cfc6;cursor:pointer}.sgs-table__arena{position:relative;min-height:0;padding:0 8px;overflow:hidden}.sgs-table__processing{position:absolute;z-index:6;left:50%;top:66%;transform:translate(-50%,-50%);display:flex;gap:3px}.sgs-table__hand{z-index:8;display:flex;justify-content:center;gap:0;min-height:70px;overflow-x:auto;overflow-y:visible;padding:3px 10px 5px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-9px}.sgs-table__hand>:deep(.sgs-card-shell:first-child){margin-left:0}.sgs-table__hand>:deep(.sgs-card-shell:hover),.sgs-table__hand>:deep(.sgs-card-shell:has(.sgs-card--selected)){z-index:2}.sgs-table__dock{z-index:10;display:flex;flex-direction:column;gap:6px;max-height:30dvh;min-height:42px;overflow-y:auto;padding:7px 11px calc(7px + env(safe-area-inset-bottom));border-top:1px solid #46402c;background:linear-gradient(180deg,rgba(24,34,28,.97),rgba(12,20,16,.99))}.sgs-table__dock--idle{color:#8d9c93;font-size:11px}.sgs-table__dock--idle p,.sgs-table__hint{margin:0}.sgs-table__hint{color:#ead99f;font-size:11px;font-weight:700}.sgs-table__actions{display:flex;flex-wrap:wrap;gap:7px}.sgs-table__actions button{min-height:36px;padding:0 13px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700}.primary{border:1px solid #9e7f3c;background:linear-gradient(180deg,#6d5527,#4c3b1a);color:#ffe6a8}.primary:disabled{opacity:.42;cursor:default}.ghost{border:1px solid #3f4d45;background:#16241e;color:#b9c5bd}.sgs-table__mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.6)}.sgs-table__log{position:fixed;z-index:71;right:0;top:0;bottom:0;width:min(320px,86vw);display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 14px 14px;border-left:1px solid #3d4b43;background:#101c17}.sgs-table__log header{display:flex;justify-content:space-between}.sgs-table__log header button{border:0;background:transparent;color:#aab7af;font-size:20px}.sgs-table__log ol{flex:1;overflow-y:auto;padding-left:18px;color:#a9b5a9;font-size:12px;line-height:1.7}
@media(max-width:620px) and (orientation:portrait){.sgs-table__bar{gap:6px;font-size:9px;padding-left:6px;padding-right:6px}.sgs-table__bar>span:nth-of-type(1){display:none}.sgs-table__arena{padding:0 2px}.sgs-table__hand{justify-content:flex-start;min-height:66px;padding-left:16px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-11px}.sgs-table__dock{max-height:32dvh;padding-top:6px}}
@media(orientation:landscape) and (max-height:500px){.sgs-table{grid-template-rows:auto minmax(0,1fr) auto auto}.sgs-table__bar{padding-top:max(3px,env(safe-area-inset-top));padding-bottom:2px}.sgs-table__hand{position:absolute;z-index:9;left:50%;bottom:44px;transform:translateX(-50%);width:min(64vw,620px);min-height:58px;padding-bottom:0}.sgs-table__dock{max-height:36dvh;min-height:38px;padding:4px 10px calc(4px + env(safe-area-inset-bottom))}.sgs-table__actions button{min-height:32px}}
</style>
