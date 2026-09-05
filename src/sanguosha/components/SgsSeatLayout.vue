<script setup lang="ts">
import { computed } from 'vue'
import SgsSeat from './SgsSeat.vue'
import SgsSeatTimer from './SgsSeatTimer.vue'
import SgsEffectLayer from './SgsEffectLayer.vue'
import SgsActionStage from './SgsActionStage.vue'
import { seatSlotsForPlayerCount } from '../composables/useSgsSeatLayout'
import { displayCharacterName } from '../data/characters/standard'
import type { GameRequest } from '../engine/requests'
import type { StagedEvent } from '../composables/useSgsEventStage'
import type { PresentationEvent } from '../engine/presentation'
import type { PlayerView } from '../engine/view'
import type { SgsSeatTimer as SgsSeatTimerData } from '../online/protocol'
import { seatEffectFor } from '../presentation/effects'

const props = defineProps<{
  view: PlayerView
  request: GameRequest | null
  staged: StagedEvent | null
  stickyMessage: PresentationEvent | null
  busy: boolean
  selectableIds: ReadonlySet<string>
  selectedIds: readonly string[]
  statuses?: Readonly<Record<string, 'online' | 'offline' | 'trustee' | 'connecting'>>
  /** 按 playerId 存的临时聊天气泡，只有联机局会传 */
  bubbles?: Readonly<Record<string, string>>
  /** 按 playerId 存的操作计时，只有联机局会传 */
  timers?: Readonly<Record<string, SgsSeatTimerData>>
  serverNow?: number
}>()
const emit = defineEmits<{ select: [playerId: string] }>()

const event = computed(() => props.staged?.event ?? null)

const ordered = computed(() => {
  const players = props.view.players
  const meIndex = players.findIndex((player) => player.id === props.view.viewerId)
  return Array.from({ length: players.length }, (_, offset) => players[(meIndex + offset) % players.length])
})
const slots = computed(() => seatSlotsForPlayerCount(props.view.players.length))
/**
 * 气泡朝牌桌中央展开。
 *
 * 一律朝上的话，上排那几家的气泡会顶出牌桌被裁掉，左右两家的会糊在邻座卡片上。
 * 中央那片是空的，谁都不挡谁——和麻将当初的结论一样。
 */
function bubbleSide(slot: string): 'up' | 'down' | 'left' | 'right' {
  if (slot === 'self') return 'up'
  if (slot.startsWith('top')) return 'down'
  return slot.startsWith('left') ? 'right' : 'left'
}
/**
 * 谁认了这名角色当「麻麻」。
 *
 * 认亲关系是公开信息，服务端下发在 view.mamaBonds 里；这里只负责翻成武将名。
 * 一个人可以同时是多个牛来的麻麻，所以返回的是列表。
 */
function mamaOwnersOf(playerId: string): string[] {
  return Object.entries(props.view.mamaBonds ?? {})
    .filter(([, mamaId]) => mamaId === playerId)
    .map(([ownerId]) => displayCharacterName(props.view.players, ownerId))
}
const effectFor = (playerId: string) => seatEffectFor(props.staged?.event ?? null, playerId)
</script>

<template>
  <section class="sgs-seat-layout" :class="`sgs-seat-layout--${view.players.length}`">
    <div v-for="(player, index) in ordered" :key="player.id" class="sgs-seat-layout__slot" :class="`sgs-seat-layout__slot--${slots[index]}`">
      <SgsSeat
        :player="player" :viewer-id="view.viewerId" :active="player.id === view.currentPlayerId" :targeting="selectableIds.size > 0"
        :selectable="selectableIds.has(player.id)" :selected="selectedIds.includes(player.id)"
        :threatened="event?.kind === 'card-use' && event.targetIds?.includes(player.id)"
        :effect="effectFor(player.id)" :status="statuses?.[player.id] ?? null"
        :display-name="displayCharacterName(view.players, player.id)" :mama-owners="mamaOwnersOf(player.id)"
        @select="emit('select', $event)"
      />
      <!--
        计时条画在座位卡**外面**（卡下沿），不放卡里。
        卡是 overflow:hidden、内容又是贴底排的，放进去必然压住身份、昵称或装备；
        给它在卡内让出一条的话，计时一出现整张卡的内容还会往下跳一格。
        自己那家不画：手牌上方已经有一条更大的，重复而且会挤到手牌。
      -->
      <SgsSeatTimer
        v-if="timers?.[player.id] && player.id !== view.viewerId"
        class="sgs-seat-layout__timer"
        :timer="timers[player.id]"
        :server-now="serverNow ?? 0"
      />
      <!-- 气泡放在槽位上而不是座位卡里：座位卡是 overflow:hidden 的，放里面会被裁掉 -->
      <transition name="sgs-bubble">
        <p v-if="bubbles?.[player.id]" class="sgs-seat-layout__bubble" :class="`sgs-seat-layout__bubble--${bubbleSide(slots[index])}`">{{ bubbles[player.id] }}</p>
      </transition>
    </div>
    <SgsActionStage :view="view" :staged="staged" :sticky-message="stickyMessage" :request="request" :busy="busy" />
    <SgsEffectLayer :staged="staged" />
  </section>
</template>

<style scoped>
.sgs-seat-layout{position:relative;min-height:0;height:100%;isolation:isolate}.sgs-seat-layout:before{content:'';position:absolute;inset:4% 8% 9%;border:1px solid rgba(193,164,92,.12);border-radius:48%;background:radial-gradient(ellipse at center,rgba(34,79,56,.65),rgba(17,49,35,.45) 58%,transparent 72%);box-shadow:inset 0 0 50px rgba(0,0,0,.28)}.sgs-seat-layout__slot{position:absolute;z-index:2;width:clamp(126px,15vw,190px);height:clamp(92px,18vh,142px)}.sgs-seat-layout__slot--self{left:50%;bottom:0;transform:translateX(-50%);width:clamp(180px,25vw,280px);height:clamp(84px,15vh,120px)}.sgs-seat-layout__slot--right-bottom{right:1%;bottom:5%}.sgs-seat-layout__slot--right-top{right:1%;top:24%}.sgs-seat-layout__slot--top-right{right:21%;top:1%}.sgs-seat-layout__slot--top-center{left:50%;top:0;transform:translateX(-50%)}.sgs-seat-layout__slot--top-left{left:21%;top:1%}.sgs-seat-layout__slot--left-top{left:1%;top:24%}.sgs-seat-layout__slot--left-bottom{left:1%;bottom:5%}
@media(max-width:700px) and (orientation:portrait){.sgs-seat-layout:before{inset:3% 7% 10%}.sgs-seat-layout__slot{width:clamp(82px,23vw,104px);height:clamp(76px,13.5vh,103px)}.sgs-seat-layout__slot--self{width:clamp(150px,44vw,190px);height:82px}.sgs-seat-layout__slot--right-bottom{right:0;bottom:11%}.sgs-seat-layout__slot--right-top{right:0;top:28%}.sgs-seat-layout__slot--top-right{right:17%;top:0}.sgs-seat-layout__slot--top-center{top:0}.sgs-seat-layout__slot--top-left{left:17%;top:0}.sgs-seat-layout__slot--left-top{left:0;top:28%}.sgs-seat-layout__slot--left-bottom{left:0;bottom:11%}.sgs-seat-layout--8 .sgs-seat-layout__slot--top-right{right:4%}.sgs-seat-layout--8 .sgs-seat-layout__slot--top-left{left:4%}}
@media(orientation:landscape) and (max-height:500px){.sgs-seat-layout__slot{width:clamp(104px,15vw,138px);height:clamp(66px,26vh,90px)}.sgs-seat-layout__slot--self{width:160px;height:72px}.sgs-seat-layout__slot--right-top,.sgs-seat-layout__slot--left-top{top:27%}.sgs-seat-layout__slot--top-right{right:20%}.sgs-seat-layout__slot--top-left{left:20%}}

/* 给移动端完整装备和技能留出真实高度；位置仍沿用同一环形槽位。 */
@media(max-width:700px) and (orientation:portrait){.sgs-seat-layout__slot{height:clamp(96px,15.5vh,118px)}.sgs-seat-layout__slot--self{height:106px}}
@media(orientation:landscape) and (max-height:500px){.sgs-seat-layout__slot{height:clamp(82px,27vh,94px)}.sgs-seat-layout__slot--self{height:90px}}

/*
 * 计时条贴在座位卡下沿之外。槽位之间本来就有间距，4px 的条占得下，
 * 也就不会和邻座的卡叠在一起。
 */
/*
 * 一律画在卡**下**沿。上排那几家不能改画到上沿——它们的槽位就贴着牌桌顶边
 * （top:0），往上画会被 `.sgs-table__arena` 的 overflow:hidden 裁掉。
 * 往下画落在牌桌空地上，中央的行动提示在垂直中线附近，两者不重叠。
 */
.sgs-seat-layout__timer { position: absolute; left: 2px; right: 2px; top: calc(100% + 3px); z-index: 7; }

/* 正在说话的那家抬一层，气泡才能盖过邻座 */
.sgs-seat-layout__slot:has(.sgs-seat-layout__bubble) { z-index: 9; }
.sgs-seat-layout__bubble {
  position: absolute; z-index: 10; width: max-content; max-width: min(220px, 46vw); margin: 0;
  padding: 6px 10px; border: 1px solid #c8a955; border-radius: 12px;
  background: #f5e7bd; color: #22301f; font-size: 12px; font-weight: 700; line-height: 1.35;
  overflow-wrap: anywhere; box-shadow: 0 6px 18px rgba(0, 0, 0, .45); pointer-events: none;
}
.sgs-seat-layout__bubble--up { left: 50%; bottom: calc(100% - 2px); transform: translateX(-50%); border-bottom-left-radius: 3px; }
.sgs-seat-layout__bubble--down { left: 50%; top: calc(100% - 2px); transform: translateX(-50%); border-top-left-radius: 3px; }
.sgs-seat-layout__bubble--right { left: calc(100% - 4px); top: 50%; transform: translateY(-50%); border-bottom-left-radius: 3px; }
.sgs-seat-layout__bubble--left { right: calc(100% - 4px); top: 50%; transform: translateY(-50%); border-bottom-right-radius: 3px; }

.sgs-bubble-enter-active, .sgs-bubble-leave-active { transition: opacity .18s ease, transform .18s ease; }
.sgs-bubble-enter-from, .sgs-bubble-leave-to { opacity: 0; }
@media (max-width: 700px) and (orientation: portrait) {
  .sgs-seat-layout__bubble { max-width: min(150px, 42vw); padding: 4px 7px; font-size: 10px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .sgs-seat-layout__bubble { max-width: min(170px, 26vw); padding: 4px 8px; font-size: 10px; }
}
@media (prefers-reduced-motion: reduce) { .sgs-bubble-enter-active, .sgs-bubble-leave-active { transition: none; } }
</style>
