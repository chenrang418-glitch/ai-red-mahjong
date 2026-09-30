<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { SGS_TUTORIAL_KEY, SGS_TUTORIAL_STEPS } from '../shared/tutorial'

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

/*
 * `timer.seatId` 是座位序号，不是 playerId 本身——联机那边引擎的 playerId
 * 恰好就是 `seat-N`，单机是 `p0`/`p1`，两边格式不一样。按 `view.players[].seat`
 * 找到这个座位真正的 playerId 再建索引，两种模式都能对上；
 * 不能像以前那样直接拼 `seat-${seatId}` 当 key，单机会全部落空。
 */
const timersByPlayer = computed(() => {
  const playerIdBySeat = new Map(props.view.players.map((player) => [player.seat, player.id]))
  const entries: Array<[string, SgsSeatTimerData]> = []
  for (const timer of props.timers) {
    const playerId = playerIdBySeat.get(timer.seatId)
    if (playerId) entries.push([playerId, timer])
  }
  return Object.fromEntries(entries)
})
const selfTimer = computed(() => timersByPlayer.value[props.view.viewerId] ?? null)

const selectedCardId = ref<string | null>(null)
const selectedMode = ref<string | null>(null)
const selectedTargetIds = ref<string[]>([])
const logOpen = ref(false)
const audioOpen = ref(false)
const tableRoot = ref<HTMLElement | null>(null)
const dockInset = ref(50)
let dockObserver: ResizeObserver | null = null
const tutorialStep = ref(-1)
const tutorialSpotlight = ref<{ top: number; left: number; right: number; bottom: number; width: number; height: number } | null>(null)
const tutorialClass = computed(() => tutorialStep.value >= 0 ? `sgs-table--tutorial-${tutorialStep.value}` : '')
const tutorialShades = computed(() => {
  const spot = tutorialSpotlight.value
  if (!spot) return []
  return [
    { left: '0', top: '0', right: '0', height: `${spot.top}px` },
    { left: '0', top: `${spot.bottom}px`, right: '0', bottom: '0' },
    { left: '0', top: `${spot.top}px`, width: `${spot.left}px`, height: `${spot.height}px` },
    { left: `${spot.right}px`, top: `${spot.top}px`, right: '0', height: `${spot.height}px` },
  ]
})

function syncTutorialSpotlight(): void {
  if (tutorialStep.value < 0) { tutorialSpotlight.value = null; return }
  const root = tableRoot.value
  const selectors = ['.sgs-table__hand', '.sgs-seat-layout__slot--self', '.sgs-seat-layout__slot--self', ':scope > .sgs-table__dock, :scope > .sgs-dock', '.sgs-table__logbtn', ':scope > .sgs-table__dock, :scope > .sgs-dock']
  const target = tutorialStep.value === 2
    ? root?.querySelector<HTMLElement>('.sgs-seat-layout__slot--self .sgs-seat__details-button') ?? root?.querySelector<HTMLElement>('.sgs-seat-layout__slot--self')
    : root?.querySelector<HTMLElement>(selectors[tutorialStep.value])
  if (!target) { tutorialSpotlight.value = null; return }
  const rect = target.getBoundingClientRect()
  const padding = 5
  const left = Math.max(0, rect.left - padding)
  const top = Math.max(0, rect.top - padding)
  const right = Math.min(window.innerWidth, rect.right + padding)
  const bottom = Math.min(window.innerHeight, rect.bottom + padding)
  tutorialSpotlight.value = { top, left, right, bottom, width: right - left, height: bottom - top }
}

function tutorialWasSeen(): boolean {
  try { return window.localStorage.getItem(SGS_TUTORIAL_KEY) === 'done' } catch { return false }
}
function openTutorial(): void {
  if (props.view.spectator) return
  audioOpen.value = false
  tutorialStep.value = 0
}
function finishTutorial(): void {
  tutorialStep.value = -1
  try { window.localStorage.setItem(SGS_TUTORIAL_KEY, 'done') } catch { /* 隐私模式下仍可正常打牌 */ }
}
function nextTutorial(): void {
  if (tutorialStep.value >= SGS_TUTORIAL_STEPS.length - 1) finishTutorial()
  else tutorialStep.value += 1
}
function previousTutorial(): void {
  tutorialStep.value = Math.max(0, tutorialStep.value - 1)
}
let observedDock: HTMLElement | null = null

function syncDockInset(): void {
  const root = tableRoot.value
  const dock = observedDock
  if (!root || !dock) return
  /*
   * 手牌是相对整张牌桌定位的，真正需要避开的距离是「牌桌底边到
   * 操作栏顶边」，不只是操作栏自身的 height。这样轮到自己出牌时，
   * 请求栏/出牌栏替换并升高，或底部安全区发生变化，都不会漏算。
   */
  const rootRect = root.getBoundingClientRect()
  const dockRect = dock.getBoundingClientRect()
  dockInset.value = Math.max(0, Math.ceil(rootRect.bottom - dockRect.top)) + 6
  syncTutorialSpotlight()
}

function observeDockHeight(): void {
  void nextTick(() => {
    const dock = tableRoot.value?.querySelector<HTMLElement>(':scope > .sgs-table__dock, :scope > .sgs-dock') ?? null
    dockObserver?.disconnect()
    observedDock = dock
    if (!dock || !tableRoot.value) return
    syncDockInset()
    dockObserver?.observe(dock)
    dockObserver?.observe(tableRoot.value)
    // v-if 替换底栏后，下一帧才是浏览器最终排版的位置。
    window.requestAnimationFrame(syncDockInset)
  })
}
const me = computed(() => props.view.players.find((player) => player.id === props.view.viewerId) ?? null)
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
  dockObserver = new ResizeObserver(syncDockInset)
  observeDockHeight()
  if (!props.view.spectator && !tutorialWasSeen()) tutorialStep.value = 0
  window.addEventListener('sgs:restart-tutorial', openTutorial)
  window.addEventListener('resize', syncTutorialSpotlight)
  window.visualViewport?.addEventListener('resize', syncTutorialSpotlight)
})
onBeforeUnmount(() => {
  sgsAudio.stop()
  document.removeEventListener('visibilitychange', syncClock)
  if (clockTimer !== null) window.clearInterval(clockTimer)
  clockTimer = null
  dockObserver?.disconnect()
  dockObserver = null
  window.removeEventListener('sgs:restart-tutorial', openTutorial)
  window.removeEventListener('resize', syncTutorialSpotlight)
  window.visualViewport?.removeEventListener('resize', syncTutorialSpotlight)
  observedDock = null
})
watch(() => [props.request?.id, props.view.seq, props.legalActions.length], observeDockHeight, { flush: 'post' })
watch(tutorialStep, () => void nextTick(() => window.requestAnimationFrame(syncTutorialSpotlight)), { flush: 'post' })
watch(() => props.presentationEvents.map((event) => event.id), () => {
  sgsAudio.processEvents(props.presentationEvents, props.view.viewerId)
})
watch(() => props.view.result, (result, previous) => {
  if (result && !previous) sgsAudio.playResult(result.winnerIds.includes(props.view.viewerId))
})

watch(() => props.view.seq, () => {
  if (selectedCardId.value && !me.value?.hand?.some((card) => card.id === selectedCardId.value)
    && !me.value?.sharedHands.some((hand) => hand.cards.some((card) => card.id === selectedCardId.value))) resetSelection()
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
  <div ref="tableRoot" class="sgs-table" :class="[{ 'sgs-table--chat': !!chat }, tutorialClass]" :style="{ '--sgs-dock-inset': `${dockInset}px` }">
    <header class="sgs-table__bar">
      <button type="button" class="sgs-table__back" aria-label="退出牌局" @click="emit('quit')">‹</button>
      <span>第 {{ view.turnNumber }} 回合</span><span>牌堆 {{ view.drawPileCount }}</span><span>弃牌 {{ view.discardPile.length }}</span>
      <span v-if="view.spectator" class="sgs-table__spectating">旁观中</span>
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
      <button v-if="!view.spectator" type="button" class="sgs-table__guide" @click="openTutorial">引导</button>
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

    <section v-if="me && !view.spectator" class="sgs-table__hand" aria-label="你的手牌">
      <SgsCard v-for="card in me.hand ?? []" :key="card.id" :card="card" :selected="selectedCardId === card.id" :disabled="!!request || !usableCardIds.has(card.id)" @click="toggleCard(card.id)" />
    </section>
    <section v-for="shared in me?.sharedHands ?? []" :key="shared.ownerId" class="sgs-table__shared-hand" :aria-label="`${shared.nickname}共享给你的手牌`">
      <span class="sgs-table__shared-label">好施 · {{ shared.nickname }}共享</span>
      <SgsCard v-for="card in shared.cards" :key="card.id" :card="card" :selected="selectedCardId === card.id" :disabled="!!request || !usableCardIds.has(card.id)" @click="toggleCard(card.id)" />
    </section>

    <section v-if="view.spectator" class="sgs-table__dock sgs-table__dock--idle"><p>旁观中 · 仅显示公开牌局信息</p></section>
    <section v-else-if="requestTargets" class="sgs-table__dock">
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

    <div v-for="(shade, index) in tutorialShades" :key="index" class="sgs-table__tutorial-shade" :style="shade" aria-hidden="true"></div>
    <aside v-if="tutorialStep >= 0" class="sgs-table__tutorial" role="status" aria-live="polite">
      <small>{{ tutorialStep + 1 }} / {{ SGS_TUTORIAL_STEPS.length }}</small>
      <strong>{{ SGS_TUTORIAL_STEPS[tutorialStep].title }}</strong>
      <p>{{ SGS_TUTORIAL_STEPS[tutorialStep].text }}</p>
      <div><button type="button" class="ghost" @click="finishTutorial">跳过</button><button v-if="tutorialStep > 0" type="button" class="ghost" @click="previousTutorial">上一步</button><button type="button" class="primary" @click="nextTutorial">{{ tutorialStep === SGS_TUTORIAL_STEPS.length - 1 ? '完成' : '下一步' }}</button></div>
    </aside>

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
.sgs-table__spectating{padding:3px 8px;border:1px solid #a78945;border-radius:999px;color:#ecd38c;font-weight:700}
.sgs-table__guide{min-height:28px;padding:0 10px;border:1px solid #5d563d;border-radius:8px;background:#18231d;color:#d8c995;font-size:11px;cursor:pointer}
.sgs-table__tutorial-shade{position:fixed;z-index:55;background:rgba(0,0,0,.62);pointer-events:none}
.sgs-table__tutorial{position:fixed;z-index:65;left:50%;top:calc(var(--app-viewport-offset, 0px) + 48px);width:min(350px,calc(100vw - 24px));transform:translateX(-50%);display:grid;gap:7px;padding:12px 14px;border:1px solid var(--accent-gold);border-radius:13px;background:rgba(14,28,22,.97);box-shadow:0 12px 34px rgba(0,0,0,.55);pointer-events:none}
.sgs-table__tutorial small{color:var(--ink-text-muted);font-size:10px}
.sgs-table__tutorial strong{color:#f0d58a;font-size:16px}
.sgs-table__tutorial p{margin:0;color:var(--ink-text-soft);font-size:12px;line-height:1.5}
.sgs-table__tutorial div{display:flex;justify-content:flex-end;gap:8px;pointer-events:auto}
.sgs-table__tutorial button{min-width:72px;min-height:44px}
.sgs-table--tutorial-0 .sgs-table__hand,.sgs-table--tutorial-1 :deep(.sgs-seat-layout__slot--self),.sgs-table--tutorial-2 :deep(.sgs-seat__details-button),.sgs-table--tutorial-3>.sgs-table__dock,.sgs-table--tutorial-3>.sgs-dock,.sgs-table--tutorial-4 .sgs-table__logbtn,.sgs-table--tutorial-5>.sgs-table__dock,.sgs-table--tutorial-5>.sgs-dock{outline:3px solid #f0cd65;outline-offset:2px;box-shadow:0 0 22px rgba(240,205,101,.58)}
.sgs-table__selftimer{flex:none}
.sgs-table__trusteebar{flex:none;margin:0;padding:4px 10px;border-top:1px solid #d8b77733;background:#2a2415;color:#f0d9a4;font-size:11px;text-align:center}

.sgs-table{position:relative;height:calc(100dvh - var(--app-viewport-offset, 0px));display:grid;grid-template-rows:auto minmax(0,1fr) auto auto;overflow:hidden;color:#e7e0cc;background:radial-gradient(ellipse at 50% 42%,#315c43 0,#173829 47%,transparent 72%),linear-gradient(150deg,var(--ink-bg-top),var(--ink-bg-bottom))}.sgs-table__bar{display:flex;align-items:center;gap:10px;padding:max(7px,env(safe-area-inset-top)) 12px 5px;color:#98aaa0;font-size:11px}.sgs-table__bar span{white-space:nowrap}.sgs-table__back{width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid rgba(90,130,110,.35);border-radius:9px;background:rgba(10,28,23,.78);color:#efe7d2;font-size:20px;cursor:pointer}.sgs-table__logbtn{margin-left:auto;min-height:28px;padding:0 10px;border:1px solid #3f4d45;border-radius:8px;background:#16241e;color:#c3cfc6;cursor:pointer}.sgs-table__arena{position:relative;min-height:0;padding:0 8px;overflow:hidden}.sgs-table__processing{position:absolute;z-index:6;left:50%;top:66%;transform:translate(-50%,-50%);display:flex;gap:3px}.sgs-table__hand{z-index:8;display:flex;justify-content:center;gap:0;min-height:70px;overflow-x:auto;overflow-y:visible;padding:3px 10px 5px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-9px}.sgs-table__hand>:deep(.sgs-card-shell:first-child){margin-left:0}.sgs-table__hand>:deep(.sgs-card-shell:hover),.sgs-table__hand>:deep(.sgs-card-shell:has(.sgs-card--selected)){z-index:2}.sgs-table__dock{z-index:10;display:flex;flex-direction:column;gap:6px;max-height:30dvh;min-height:42px;overflow-y:auto;padding:7px 11px calc(7px + env(safe-area-inset-bottom));border-top:1px solid #46402c;background:linear-gradient(180deg,rgba(24,34,28,.97),rgba(12,20,16,.99))}.sgs-table__dock--idle{color:#8d9c93;font-size:11px}.sgs-table__dock--idle p,.sgs-table__hint{margin:0}.sgs-table__hint{color:#ead99f;font-size:11px;font-weight:700}.sgs-table__actions{display:flex;flex-wrap:wrap;gap:7px}.sgs-table__actions button{min-height:36px;padding:0 13px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700}.primary{border:1px solid #9e7f3c;background:linear-gradient(180deg,#6d5527,#4c3b1a);color:#ffe6a8}.primary:disabled{opacity:.42;cursor:default}.ghost{border:1px solid #3f4d45;background:#16241e;color:#b9c5bd}.sgs-table__mask{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.6)}.sgs-table__log{position:fixed;z-index:71;right:0;top:var(--app-viewport-offset, 0px);bottom:0;width:min(320px,86vw);display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top)) 14px 14px;border-left:1px solid #3d4b43;background:#101c17}.sgs-table__log header{display:flex;justify-content:space-between}.sgs-table__log header button{border:0;background:transparent;color:#aab7af;font-size:20px}.sgs-table__log ol{flex:1;overflow-y:auto;padding-left:18px;color:#a9b5a9;font-size:12px;line-height:1.7}
@media(max-width:620px) and (orientation:portrait){.sgs-table__bar{gap:6px;font-size:9px;padding-left:6px;padding-right:6px}.sgs-table__bar>span:nth-of-type(1){display:none}.sgs-table__arena{padding:0 2px}.sgs-table__hand{justify-content:flex-start;min-height:66px;padding-left:16px}.sgs-table__hand>:deep(.sgs-card-shell){margin-left:-11px}.sgs-table__dock{max-height:32dvh;padding-top:6px}}
@media(orientation:landscape) and (max-height:500px){.sgs-table{grid-template-rows:auto minmax(0,1fr) auto auto}.sgs-table__bar{padding-top:max(3px,env(safe-area-inset-top));padding-bottom:2px}.sgs-table__hand{position:absolute;z-index:9;left:calc(50% + 6px);right:6px;bottom:var(--sgs-dock-inset,50px);transform:none;width:auto;justify-content:flex-start;min-height:58px;padding:0 8px}.sgs-table__dock{max-height:36dvh;min-height:38px;padding:4px 10px calc(4px + env(safe-area-inset-bottom))}.sgs-table__actions button{min-height:32px}}

.sgs-table__bar :deep(.sgs-audio) { margin-left: auto; }
.sgs-table__bar .sgs-table__logbtn { margin-left: 0; }
/*
 * 有聊天圆钮时给手牌行留出横向空间。
 * 圆钮是 fixed 在右下角的，手牌行横向滚动，牌多了最右一张会滚到圆钮底下点不到。
 */
.sgs-table--chat .sgs-table__hand { padding-right: 62px; }
@media (max-width: 820px), (orientation: landscape) and (max-height: 500px) {
  .sgs-table__bar { font-size: 10px; }
  .sgs-table__back,
  .sgs-table__trustee,
  .sgs-table__guide,
  .sgs-table__logbtn,
  .sgs-table__log header button { position: relative; }
  .sgs-table__back::before,
  .sgs-table__trustee::before,
  .sgs-table__guide::before,
  .sgs-table__logbtn::before,
  .sgs-table__log header button::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }
  .sgs-table__actions button { min-height: 44px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  /* 横屏时手牌是绝对定位的窄条，够不到右边缘，不用让位 */
  .sgs-table--chat .sgs-table__hand { padding-right: 10px; }
}
.sgs-table__shared-hand { display:flex; align-items:center; justify-content:center; gap:4px; min-height:52px; overflow-x:auto; padding:2px 10px; border-top:1px solid rgba(210,185,112,.22); background:rgba(30,38,28,.88); }
.sgs-table__shared-label { flex:none; color:#e7d59b; font-size:10px; font-weight:700; }
</style>
