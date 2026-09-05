<script setup lang="ts">
import MahjongTile from './MahjongTile.vue'
import SeatCountdown from './SeatCountdown.vue'
import type { PlayerState } from '@/game/types'

// 座位只负责「这个人是谁、什么状态、亮了什么牌」。
// 牌河统一画在牌桌中央（跟真牌桌一样），不再挤在各自的座位块里。
withDefaults(defineProps<{
  player: PlayerState
  active?: boolean
  dealer?: boolean
  revealHand?: boolean
  countdown?: { progress: number; seconds: number; ai: boolean } | null
  status?: string
  bubble?: string
}>(), {
  active: false,
  dealer: false,
  revealHand: false,
  countdown: null,
  status: '',
  bubble: '',
})

const meldLabel: Record<string, string> = {
  peng: '碰',
  'ming-gang': '明杠',
  'an-gang': '暗杠',
  'bu-gang': '补杠',
}

</script>

<template>
  <section class="seat" :class="{ active, urgent: active && countdown && !countdown.ai && countdown.seconds <= 5 }">
    <header>
      <span class="dealer" v-if="dealer">庄</span>
      <strong>{{ player.name }}</strong>
      <SeatCountdown v-if="countdown" v-bind="countdown" />
      <span class="points">{{ player.points === null ? `净 ${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : `${player.points}分` }}</span>
    </header>
    <!-- 牌桌上只标状态（托管中／离线），AI 的性格和档位一律不摆在牌桌上，
         需要查的话在左侧信息栏里看。 -->
    <div class="seat-meta" v-if="status">
      <span class="seat-status">{{ status }}</span>
    </div>

    <!-- 别人的暗牌不画牌背：十三张牌背没有任何信息，只占地方。结算亮牌时才摊开。 -->
    <div v-if="revealHand" class="revealed-hand">
      <MahjongTile v-for="tile in player.hand" :key="tile.id" :tile="tile" disabled compact />
    </div>
    <div v-else class="hand-count"><b>{{ player.hand.length }}</b>张</div>

    <div class="meld-row" v-if="player.melds.length">
      <div v-for="meld in player.melds" :key="meld.id" class="meld-group">
        <small>{{ meldLabel[meld.type] }}</small>
        <MahjongTile v-for="tile in meld.tiles" :key="tile.id" :tile="tile" disabled compact />
      </div>
    </div>

    <transition name="bubble">
      <p v-if="bubble" class="seat-bubble">{{ bubble }}</p>
    </transition>
  </section>
</template>

<style scoped>
.seat {
  --seat-tile-width: 22px;
  --seat-tile-height: 31px;
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: linear-gradient(180deg, rgba(9, 41, 34, .82), rgba(4, 26, 22, .82));
  border: 1px solid rgba(220, 193, 113, .16);
  border-radius: 13px;
  padding: 8px 9px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  transition: border-color .2s, box-shadow .2s;
}
.seat.active {
  border-color: #f3ca69;
  box-shadow: 0 0 0 2px rgba(243,202,105,.16), 0 0 26px rgba(243,202,105,.16);
  animation: seat-breathe .8s ease-out 2;
}
.seat.active.urgent { animation-duration: .75s; }
@keyframes seat-breathe {
  50% {
    border-color: #ffe08a;
    background: linear-gradient(180deg, rgba(24, 70, 57, .92), rgba(6, 34, 28, .9));
    box-shadow: 0 0 0 2px rgba(255,222,133,.26), 0 0 34px rgba(243,202,105,.3);
  }
}
header { display: flex; gap: 6px; align-items: center; min-width: 0; color: #f7f0d9; }
header strong { min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header :deep(.seat-countdown) { margin-left: 2px; }
.points { margin-left: auto; font-size: 12px; color: #f2d27b; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dealer { display: inline-grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; flex: 0 0 auto; }
.seat-meta { display: flex; flex-wrap: wrap; gap: 4px 6px; color: #91aaa2; font-size: 10px; }
.seat-status { color: #e0c273; }
.hand-count {
  align-self: flex-start;
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  padding: 3px 9px;
  border: 1px solid rgba(220, 193, 113, .28);
  border-radius: 99px;
  background: rgba(9, 39, 32, .9);
  color: #9db4ac;
  font-size: 10px;
}
.hand-count b { color: #f0dca2; font-size: 13px; font-variant-numeric: tabular-nums; }
.revealed-hand, .meld-row { display: flex; flex-wrap: wrap; gap: 2px; }
.meld-row { gap: 6px; }
.meld-group { display: flex; gap: 1px; position: relative; padding-top: 9px; }
.meld-group small { position: absolute; top: -2px; left: 0; color: #efce7a; font-size: 9px; }
:deep(.mahjong-tile.compact) {
  width: var(--seat-tile-width);
  height: var(--seat-tile-height);
  padding: 1px;
  border-radius: 4px;
}
:deep(.mahjong-tile.compact .tile-back-mark) { font-size: 10px; }

/* 聊天气泡挂在座位上，牌桌上不用切到聊天面板也知道谁说了话 */
.seat-bubble {
  position: absolute;
  z-index: 6;
  left: 6px;
  right: 6px;
  bottom: calc(100% - 2px);
  margin: 0;
  padding: 7px 10px;
  border: 1px solid #c8a955;
  border-radius: 12px 12px 12px 3px;
  background: #f5e7bd;
  color: #22301f;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
  box-shadow: 0 10px 26px rgba(0,0,0,.42);
}
.bubble-enter-active, .bubble-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-enter-from, .bubble-leave-to { opacity: 0; transform: translateY(6px); }

@media (pointer: coarse), (max-width: 820px), (max-height: 620px) {
  .seat { padding: 6px 7px; gap: 3px; border-radius: 10px; }
  header { gap: 4px; }
  header strong { font-size: 12px; }
  .points { font-size: 11px; }
  .dealer { width: 18px; height: 18px; font-size: 9px; }
  .seat-meta { font-size: 9px; }
  .hand-count { padding: 2px 7px; font-size: 9px; }
  .hand-count b { font-size: 12px; }
  .meld-row { gap: 4px; }
  .meld-group { padding-top: 8px; }
  .meld-group small { font-size: 7px; }
  .seat-bubble { left: 4px; right: 4px; padding: 5px 8px; font-size: 11px; }
}

@media (prefers-reduced-motion: reduce) {
  .seat.active { animation: none; }
  .bubble-enter-active, .bubble-leave-active { transition: none; }
}
</style>
