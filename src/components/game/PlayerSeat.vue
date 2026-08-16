<script setup lang="ts">
import MahjongTile from './MahjongTile.vue'
import SeatCountdown from './SeatCountdown.vue'
import type { PlayerState } from '@/game/types'

withDefaults(defineProps<{
  player: PlayerState
  active?: boolean
  dealer?: boolean
  revealHand?: boolean
  compact?: boolean
  countdown?: { progress: number; seconds: number; ai: boolean } | null
  // 竖屏时别人的手牌只显示张数：牌背本来就没有信息，省下的宽度留给牌河和自己的手牌。
  handAsCount?: boolean
  status?: string
  bubble?: string
}>(), {
  active: false,
  dealer: false,
  revealHand: false,
  compact: true,
  countdown: null,
  handAsCount: false,
  status: '',
  bubble: '',
})

const meldLabel: Record<string, string> = {
  peng: '碰',
  'ming-gang': '明杠',
  'an-gang': '暗杠',
  'bu-gang': '补杠',
}

const personalityLabel = {
  fast: '快攻型', balanced: '平衡型', closed: '七对型',
  'no-zhong': '无红中策略型', humanlike: '真人波动型',
} as const
const difficultyLabel = { beginner: '菜鸡', standard: '凡人', expert: '猿神' } as const
</script>

<template>
  <section class="seat" :class="{ active }">
    <header>
      <span class="dealer" v-if="dealer">庄</span>
      <strong>{{ player.name }}</strong>
      <SeatCountdown v-if="countdown" v-bind="countdown" />
      <span class="points">{{ player.points === null ? `净 ${player.stats.netPoints >= 0 ? '+' : ''}${player.stats.netPoints}` : `${player.points}分` }}</span>
    </header>
    <div class="seat-meta" v-if="player.ai || status">
      <span v-if="status" class="seat-status">{{ status }}</span>
      <span v-if="player.ai">{{ personalityLabel[player.ai.personality] }} · {{ difficultyLabel[player.ai.difficulty] }}</span>
    </div>
    <div class="concealed-hand" :class="{ counted: handAsCount && !revealHand }">
      <template v-if="handAsCount && !revealHand">
        <span class="hand-count"><b>{{ player.hand.length }}</b>张</span>
      </template>
      <template v-else>
        <MahjongTile
          v-for="tile in player.hand"
          :key="tile.id"
          :tile="tile"
          :hidden="!revealHand"
          disabled
          compact
        />
      </template>
    </div>
    <div class="meld-row" v-if="player.melds.length">
      <div v-for="meld in player.melds" :key="meld.id" class="meld-group">
        <small>{{ meldLabel[meld.type] }}</small>
        <MahjongTile v-for="tile in meld.tiles" :key="tile.id" :tile="tile" disabled compact />
      </div>
    </div>
    <div class="discard-row" aria-label="牌河">
      <MahjongTile v-for="tile in player.discards" :key="tile.id" :tile="tile" disabled compact />
    </div>
    <transition name="bubble">
      <p v-if="bubble" class="seat-bubble">{{ bubble }}</p>
    </transition>
  </section>
</template>

<style scoped>
.seat {
  --seat-tile-width: 25px;
  --seat-tile-height: 35px;
  --discard-columns: 10;
  position: relative;
  min-width: 0;
  background: linear-gradient(180deg, rgba(9, 41, 34, .82), rgba(4, 26, 22, .82));
  border: 1px solid rgba(220, 193, 113, .16);
  border-radius: 14px;
  padding: 9px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  transition: border-color .2s, box-shadow .2s;
}
.seat.active { border-color: #f3ca69; box-shadow: 0 0 0 2px rgba(243,202,105,.16), 0 0 26px rgba(243,202,105,.16); }
header { display: flex; gap: 7px; align-items: center; color: #f7f0d9; }
header strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header :deep(.seat-countdown) { margin-left: 2px; }
.points { margin-left: auto; font-size: 12px; color: #f2d27b; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dealer { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #a52e2b; color: white; font-size: 11px; flex: 0 0 auto; }
.seat-meta { display: flex; flex-wrap: wrap; gap: 4px; color: #91aaa2; font-size: 10px; margin: 2px 0 5px; }
.seat-status { color: #e0c273; }
.concealed-hand, .meld-row { display: flex; flex-wrap: nowrap; gap: 1px; }
.concealed-hand {
  min-width: 0;
  min-height: var(--seat-tile-height);
  max-height: none;
  overflow: visible;
  align-content: flex-start;
}
.concealed-hand.counted { min-height: 0; }
.hand-count {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  padding: 2px 7px;
  border: 1px solid rgba(220, 193, 113, .3);
  border-radius: 99px;
  background: rgba(9, 39, 32, .9);
  color: #9db4ac;
  font-size: 9px;
}
.hand-count b { color: #f0dca2; font-size: 12px; font-variant-numeric: tabular-nums; }
.discard-row {
  display: grid;
  grid-template-columns: repeat(var(--discard-columns), var(--seat-tile-width));
  grid-auto-rows: var(--seat-tile-height);
  gap: 2px;
  width: max-content;
  max-width: 100%;
  min-height: 0;
  margin-top: 6px;
}
.meld-row { margin-top: 5px; gap: clamp(2px, .5vw, 7px); }
.meld-group { display: flex; gap: 1px; position: relative; padding-top: 10px; }
.meld-group small { position: absolute; top: -3px; left: 0; color: #efce7a; font-size: 9px; }
:deep(.mahjong-tile.compact) {
  width: var(--seat-tile-width);
  height: var(--seat-tile-height);
  padding: 1px;
  border-radius: clamp(3px, .4vw, 5px);
}
:deep(.mahjong-tile.compact .tile-back-mark) { font-size: clamp(7px, 1vw, 12px); }

/* 聊天气泡挂在座位上，牌桌上不用切到聊天面板也知道谁说了话 */
.seat-bubble {
  position: absolute;
  z-index: 6;
  left: 8px;
  right: 8px;
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

@media (pointer: coarse), (max-width: 700px), (max-height: 600px) {
  .seat { padding: 5px; border-radius: 9px; }
  header { gap: 4px; }
  header strong { font-size: 11px; }
  .points { font-size: 10px; }
  .dealer { width: 18px; height: 18px; font-size: 8px; }
  .seat-meta { margin: 1px 0 3px; font-size: 8px; }
  .discard-row { gap: 1px; margin-top: 3px; }
  .meld-row { margin-top: 3px; }
  .meld-group { padding-top: 7px; }
  .meld-group small { top: -2px; font-size: 6px; }
  .seat-bubble { left: 4px; right: 4px; padding: 5px 8px; font-size: 11px; }
}

@media (pointer: coarse) and (orientation: portrait), (orientation: portrait) and (max-width: 700px) {
  header strong { font-size: 12px; }
  .points { font-size: 11px; }
  .dealer { width: 20px; height: 20px; font-size: 9px; }
  .seat-meta { font-size: 9px; }
  .meld-group small { font-size: 7px; }
}

@media (prefers-reduced-motion: reduce) {
  .bubble-enter-active, .bubble-leave-active { transition: none; }
}
</style>
