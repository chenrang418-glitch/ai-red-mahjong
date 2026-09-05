<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import SgsCard from './SgsCard.vue'
import SgsSeatLayout from './SgsSeatLayout.vue'
import SgsRequestDock from './SgsRequestDock.vue'
import SgsSeatTimer from './SgsSeatTimer.vue'
import SgsChatDock from './SgsChatDock.vue'
import SgsAudioControl from './SgsAudioControl.vue'
import { useSgsEventStage } from '../composables/useSgsEventStage'
import { sgsAudio } from '../composables/useSgsAudio'
import type { LegalAction } from '../engine/actions'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { PresentationEvent } from '../engine/presentation'
import type { SgsChatMessage, SgsSeatTimer as SgsSeatTimerData } from '../online/protocol'
import type { PlayerView } from '../engine/view'
import { fixedTargetAction, initialTargetIds } from '../presentation/targetSelection'

const props = withDefaults(defineProps<{
  view: PlayerView
  request: GameRequest | null
  legalActions: readonly LegalAction[]
  busy: boolean
  log: readonly string[]
  presentationEvents?: readonly PresentationEvent[]
  /** 所有正在被等待的座位的计时，只有联机局会传 */
  timers?: readonly SgsSeatTimerData[]
  clockOffsetMs?: number
  /** 自己这个座位是不是托管中；`null` 表示这局没有托管这回事（单机） */
  trustee?: boolean | null
  trusteeBusy?: boolean
  connectionStatuses?: Readonly<Record<string, 'online' | 'offline' | 'trustee' | 'connecting'>>
  /** 只有联机局传聊天；单机不传，右下角那个圆钮就不会出现 */
  chat?: readonly SgsChatMessage[] | null
  selfUserId?: string
  /** 说话那家座位上冒出来的临时气泡，按 playerId 索引 */
  bubbles?: Readonly<Record<string, string>>
}>(), { presentationEvents: () => [], timers: () => [], clockOffsetMs: 0, trustee: null, trusteeBusy: false, connectionStatuses: () => ({}), chat: null, selfUserId: '', bubbles: () => ({}) })
const emit = defineEmits<{ act: [actionId: string]; respond: [response: GameResponse]; quit: []; chat: [text: string]; 'toggle-trustee': [enabled: boolean] }>()

/*
 * —— 牌桌时钟 ——
 *
 * 整桌共用一个心跳：每个座位各开一个定时器既浪费，读数也会各走各的对不齐。
 * 没有任何计时在跑时停表，免得等待开局、结算弹层期间白白重绘牌桌。
 * 后台标签页会被浏览器把定时器节流到 1 秒以上，所以切回前台先纠正一次读数。
 */
const localNow = ref(Date.now())
const serverNow = computed(() => localNow.value + props.clockOffsetMs)
const timerActive = computed(() => props.timers.length > 0)
let clockTimer: number | null = null
function syncClock(): void {
  localNow.value = Date.now()
  if (!timerActive.value || document.hidden) {
    if (clockTimer !== null) window.clearInterval(clockTimer)
    clockTimer = null
    return
  }
  if (clockTimer === null) clockTimer = window.setInterval(() => { localNow.value = Date.now() }, 250)
}
watch(timerActive, syncClock, { immediate: true })
/*
 * 换了新的计时（新请求、新回合）也要重新读一次表。
 * 只靠 250ms 的心跳的话，新计时的第一帧用的是上一次的读数，
 * 一开头就先差半秒；换请求换得密的时候看起来就是「跳一下」。
 */
watch(() => props.timers.map((timer) => `${timer.seatId}:${timer.deadlineAt}`).join(','), () => {
  localNow.value = Date.now()
})

const timersByPlayer = computed(() => Object.fromEntries(
  props.timers.map((timer) => [`seat-${timer.seatId}`, timer] as const),
))
const selfTimer = computed(() => timersByPlayer.value[props.view.viewerId] ?? null)

const selectedCardId = ref<string | null>(null)
const selectedMode = ref<string | null>(null)
const selectedTargetIds = ref<string[]>([])
const logOpen = ref(false)
const audioOpen = ref(false)
const me = computed(() => props.view.players.find((player) => player.id === props.view.viewerId)!)
// 表现事件按到达顺序逐条播放并自带寿命；旧实现直接取最后一条，
// 结果近半数推进不产生事件时箭头会一直挂着，成批到达时首条又被吞掉
const stage = useSgsEventStage(() => props.presentationEvents)
const usableCardIds = computed(() => new Set(props.legalActions.flatMap((action) => action.kind === 'use-card' ? action.cardIds : [])))
const selectedActions = computed(() => props.legalActions.filter((action): action is Extract<LegalAction, { kind: 'use-card' }> => action.kind === 'use-card' && !!selectedCardId.value && action.cardIds.includes(selectedCardId.value)))
const modes = computed(() => [...new Map(selectedActions.value.map((action) => [action.asCardName, action])).values()].map((action) => ({ id: action.asCardName, label: action.asCardName })))
const activeMode = computed(() => selectedMode.value ?? (modes.value.length === 1 ? modes.value[0].id : null))
const modeActions = computed(() => selectedActions.value.filter((action) => !activeMode.value || action.asCardName === activeMode.value))
const requestTargets = computed(() => props.request?.kind === 'choose-targets' ? props.request : null)
const candidateTargetIds = computed(() => new Set(requestTargets.value?.candidateIds ?? modeActions.value.flatMap((action) => action.targetIds)))
/**
 * 当前选中的牌是不是全体锦囊（南蛮入侵、万箭齐发、桃园结义、五谷丰登）。
 *
 * 这类牌的目标由引擎定死，玩家没有可选空间。**但不代表可以点一下就飞出去**——
 * 原来是点击即发，手一抖就是一张牌，用户报的误触就是这个。现在改成
 * 选中时把目标全部预选标红，仍然要按「确定」才真的用出去。
 */
const fixedAction = computed(() => (selectedCardId.value
  ? fixedTargetAction(props.legalActions, selectedCardId.value, activeMode.value ?? undefined)
  : null))
// 目标锁死了就不该再显示成「可点选」：座位上不给准星，点了也不改变什么
const selectableTargetIds = computed(() => (fixedAction.value ? new Set<string>() : candidateTargetIds.value))
const exactAction = computed(() => modeActions.value.find((action) => action.targetIds.length === selectedTargetIds.value.length && action.targetIds.every((id) => selectedTargetIds.value.includes(id))) ?? null)
const standaloneActions = computed(() => props.legalActions.filter((action) => action.kind === 'invoke-skill' || action.kind === 'pass'))

onMounted(() => {
  sgsAudio.prepare(props.presentationEvents)
  document.addEventListener('visibilitychange', syncClock)
})
onBeforeUnmount(() => {
  sgsAudio.stop()
  document.removeEventListener('visibilitychange', syncClock)
  if (clockTimer !== null) window.clearInterval(clockTimer)
  clockTimer = null
})
watch(() => props.presentationEvents.map((event) => event.id), () => {
  sgsAudio.processEvents(props.presentationEvents, props.view.viewerId)
})

watch(() => props.view.seq, () => {
  if (selectedCardId.value && !me.value.hand?.some((card) => card.id === selectedCardId.value)) resetSelection()
})
watch(() => props.request?.id, (id) => {
  selectedTargetIds.value = []
  // 轮到自己响应时把积压的动画快进掉，只留最后一条（通常正是要响应的那张牌）
  if (id) stage.skip()
})

function resetSelection(): void { selectedCardId.value = null; selectedMode.value = null; selectedTargetIds.value = [] }
function toggleCard(cardId: string): void {
  if (selectedCardId.value === cardId) { resetSelection(); return }
  selectedCardId.value = cardId
  selectedMode.value = null
  // 全体锦囊：目标是引擎给的，选中就整套标红，等玩家按确定
  selectedTargetIds.value = initialTargetIds(props.legalActions, cardId)
}
function selectMode(modeId: string): void {
  if (!selectedCardId.value) return
  selectedMode.value = modeId
  selectedTargetIds.value = initialTargetIds(props.legalActions, selectedCardId.value, modeId)
}
function toggleTarget(playerId: string): void {
  // 全体锦囊的目标不是玩家选的，点掉一个会让「确定」永远按不下去
  if (fixedAction.value) return
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
  <div class="sgs-table" :class="{ 'sgs-table--chat': !!chat }">
    <header class="sgs-table__bar">
      <button type="button" class="sgs-table__back" aria-label="退出牌局" @click="emit('quit')">‹</button>
      <span>第 {{ view.turnNumber }} 回合</span><span>牌堆 {{ view.drawPileCount }}</span><span>弃牌 {{ view.discardPile.length }}</span>
      <button
        v-if="trustee !== null"
        type="button"
        class="sgs-table__trustee"
        :class="{ on: trustee }"
        :disabled="trusteeBusy"
        :aria-pressed="trustee"
        @click="emit('toggle-trustee', !trustee)"
      >{{ trusteeBusy ? '…' : trustee ? '取消托管' : '托管' }}</button>
      <SgsAudioControl v-model:open="audioOpen" />
      <button type="button" class="sgs-table__logbtn" @click="logOpen = true">战报</button>
    </header>

    <main class="sgs-table__arena">
      <SgsSeatLayout :view="view" :request="request" :staged="stage.staged.value" :sticky-message="stage.stickyMessage.value" :busy="busy" :selectable-ids="selectableTargetIds" :selected-ids="selectedTargetIds" :statuses="connectionStatuses" :bubbles="bubbles" :timers="timersByPlayer" :server-now="serverNow" @select="toggleTarget" />
      <div v-if="view.processingArea.length" class="sgs-table__processing"><SgsCard v-for="card in view.processingArea" :key="card.id" :card="card" compact disabled /></div>
    </main>

    <!--
      自己的那一条单独放在手牌上方：要做决定的时候眼睛在这里，
      时间就该在这里，不用抬头去屏幕角落找。
    -->
    <SgsSeatTimer v-if="selfTimer" class="sgs-table__selftimer" :timer="selfTimer" :server-now="serverNow" wide />
    <p v-if="trustee" class="sgs-table__trusteebar">托管中，由 AI 代打 · 点上方「取消托管」随时接回</p>

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
        <p class="sgs-table__hint">{{ fixedAction ? `【${fixedAction.asCardName}】的目标已全部选中（${selectedTargetIds.length} 人），点「确定」使用` : candidateTargetIds.size ? `请直接点击牌桌上的目标（已选 ${selectedTargetIds.length}）` : '确认使用这张牌' }}</p>
        <div v-if="modes.length > 1" class="sgs-table__actions"><button v-for="mode in modes" :key="mode.id" type="button" :class="activeMode === mode.id ? 'primary' : 'ghost'" @click="selectMode(mode.id)">当【{{ mode.label }}】使用</button></div>
        <div class="sgs-table__actions"><button type="button" class="ghost" @click="resetSelection">取消</button><button type="button" class="primary" :disabled="!exactAction" @click="confirmTargets">确定</button></div>
      </template>
      <div v-else class="sgs-table__actions"><button v-for="action in standaloneActions" :key="action.id" type="button" :class="action.kind === 'pass' ? 'ghost' : 'primary'" @click="act(action.id)">{{ action.label }}</button></div>
    </section>
    <section v-else class="sgs-table__dock sgs-table__dock--idle"><p>{{ view.pendingRequest ? '正在等待其他角色响应…' : busy ? '其他角色正在思考…' : '等待牌局推进' }}</p></section>

    <SgsChatDock v-if="chat" :messages="chat" :self-user-id="selfUserId" @send="emit('chat', $event)" />

    <div v-if="logOpen" class="sgs-table__mask" @click="logOpen=false"></div><aside v-if="logOpen" class="sgs-table__log" aria-label="战报"><header><strong>历史战报</strong><button type="button" @click="logOpen=false">×</button></header><ol v-if="log.length"><li v-for="(entry,index) in log" :key="index">{{ entry }}</li></ol><p v-else>还没有可显示的记录。</p></aside>
  </div>
</template>

<style scoped>
/*
  和顶栏其余按钮（战报、声音）保持同一套尺寸：28px 高、8px 圆角、11px 字。
  这里原来是个 21px 的胶囊，夹在两个 28px 方角按钮中间明显矮一截。
  「托管中」用金色实底，因为它表示的是一个**正在生效的状态**，不只是个开关。
*/
.sgs-table__trustee{flex:none;min-height:28px;padding:0 10px;border:1px solid #5d563d;border-radius:8px;background:#18231d;color:#d8c995;font-size:11px;font-weight:700;cursor:pointer}
.sgs-table__trustee.on{border-color:var(--accent-gold,#d8b777);background:#5a4520;color:#ffe6ac}
.sgs-table__trustee:disabled{opacity:.55;cursor:progress}
.sgs-table__selftimer{flex:none}
.sgs-table__trusteebar{flex:none;margin:0;padding:4px 10px;border-top:1px solid #d8b77733;background:#2a2415;color:#f0d9a4;font-size:11px;text-align:center}

.sgs-table{height:calc(100dvh - var(--app-viewport-offset, 0px));display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;overflow:hidden;color:#e7e0cc;background:radial-gradient(ellipse at 50% 42%,#315c43 0,#173829 47%,transparent 72%),linear-gradient(150deg,var(--ink-bg-top),var(--ink-bg-bottom))}.sgs-table__bar{display:flex;align-items:center;gap:10px;padding:max(7px,env(safe-area-inset-top)) 12px 5px;color:#98aaa0;font-size:11px}.sgs-table__bar span{white-space:nowrap}.sgs-table__back{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid rgba(90,130,110,.35);border-radius:9px;background:rgba(10,28,23,.78);color:#efe7d2;font-size:20px;cursor:pointer}.sgs-table__logbtn{margin-left:auto;min-height:28px;padding:0 10px;border:1px solid #3f4d45;border-radius:8px;background:#16241e;color:#c3cfc6;cursor:pointer}.sgs-table__arena{position:relative;min-height:0;padding:0 8px;overflow:hidden}.sgs-table__processing{position:absolute;z-index:6;left:50%;top:66%;transform:translate(-50%,-50%);display:flex;gap:3px}.sgs-table__hand{z-index:8;display:flex;justify-content:center;gap:0;min-height:70px;overflow-x:auto;overflow-y:visible;padding:3px 10px 5px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-9px}.sgs-table__hand>:deep(.sgs-card-shell:first-child){margin-left:0}.sgs-table__hand>:deep(.sgs-card-shell:hover),.sgs-table__hand>:deep(.sgs-card-shell:has(.sgs-card--selected)){z-index:2}.sgs-table__dock{z-index:10;display:flex;flex-direction:column;gap:6px;max-height:30dvh;min-height:42px;overflow-y:auto;padding:7px 11px calc(7px + env(safe-area-inset-bottom));border-top:1px solid #46402c;background:linear-gradient(180deg,rgba(24,34,28,.97),rgba(12,20,16,.99))}.sgs-table__dock--idle{color:#8d9c93;font-size:11px}.sgs-table__dock--idle p,.sgs-table__hint{margin:0}.sgs-table__hint{color:#ead99f;font-size:11px;font-weight:700}.sgs-table__actions{display:flex;flex-wrap:wrap;gap:7px}.sgs-table__actions button{min-height:36px;padding:0 13px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700}.primary{border:1px solid #9e7f3c;background:linear-gradient(180deg,#6d5527,#4c3b1a);color:#ffe6a8}.primary:disabled{opacity:.42;cursor:default}.ghost{border:1px solid #3f4d45;background:#16241e;color:#b9c5bd}.sgs-table__mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.6)}.sgs-table__log{position:fixed;z-index:71;right:0;top:var(--app-viewport-offset, 0px);bottom:0;width:min(320px,86vw);display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 14px 14px;border-left:1px solid #3d4b43;background:#101c17}.sgs-table__log header{display:flex;justify-content:space-between}.sgs-table__log header button{border:0;background:transparent;color:#aab7af;font-size:20px}.sgs-table__log ol{flex:1;overflow-y:auto;padding-left:18px;color:#a9b5a9;font-size:12px;line-height:1.7}
@media(max-width:620px) and (orientation:portrait){.sgs-table__bar{gap:6px;font-size:9px;padding-left:6px;padding-right:6px}.sgs-table__bar>span:nth-of-type(1){display:none}.sgs-table__arena{padding:0 2px}.sgs-table__hand{justify-content:flex-start;min-height:66px;padding-left:16px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-11px}.sgs-table__dock{max-height:32dvh;padding-top:6px}}
@media(orientation:landscape) and (max-height:500px){.sgs-table{grid-template-rows:auto minmax(0,1fr) auto auto}.sgs-table__bar{padding-top:max(3px,env(safe-area-inset-top));padding-bottom:2px}.sgs-table__hand{position:absolute;z-index:9;left:50%;bottom:44px;transform:translateX(-50%);width:min(64vw,620px);min-height:58px;padding-bottom:0}.sgs-table__dock{max-height:36dvh;min-height:38px;padding:4px 10px calc(4px + env(safe-area-inset-bottom))}.sgs-table__actions button{min-height:32px}}

.sgs-table__bar :deep(.sgs-audio) { margin-left: auto; }
.sgs-table__bar .sgs-table__logbtn { margin-left: 0; }
/*
 * 有聊天圆钮时给手牌行留出横向空间。
 * 圆钮是 fixed 在右下角的，手牌行横向滚动，牌多了最右一张会滚到圆钮底下点不到。
 */
.sgs-table--chat .sgs-table__hand { padding-right: 62px; }
@media (orientation: landscape) and (max-height: 500px) {
  /* 横屏时手牌是绝对定位的窄条，够不到右边缘，不用让位 */
  .sgs-table--chat .sgs-table__hand { padding-right: 10px; }
}
</style>
