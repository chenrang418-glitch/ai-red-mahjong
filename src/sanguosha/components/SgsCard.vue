<script setup lang="ts">
import { computed } from 'vue'
import type { PhysicalCard } from '../engine/types'

/**
 * 一张牌。
 *
 * `card` 为空表示牌背——别人的手牌永远走这条路径，
 * DOM 上不能出现任何牌面信息（牌名、花色、点数、aria-label 都不行）。
 */
const props = withDefaults(defineProps<{
  card?: PhysicalCard | null
  selected?: boolean
  disabled?: boolean
  compact?: boolean
  /** 牌背上的编号，只用于让玩家区分「第几张」，不含牌面信息 */
  backIndex?: number | null
}>(), { card: null, selected: false, disabled: false, compact: false, backIndex: null })

const SUIT_TEXT: Record<string, string> = { heart: '♥', diamond: '♦', spade: '♠', club: '♣' }
const RANK_TEXT: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }

const suit = computed(() => (props.card ? SUIT_TEXT[props.card.suit] ?? '' : ''))
const rank = computed(() => {
  if (!props.card) return ''
  return RANK_TEXT[props.card.rank] ?? String(props.card.rank)
})
const isRed = computed(() => props.card?.color === 'red')
const label = computed(() => (props.card ? `${props.card.name} ${suit.value}${rank.value}` : '未知牌'))
</script>

<template>
  <button
    class="sgs-card"
    :class="{ 'sgs-card--selected': selected, 'sgs-card--back': !card, 'sgs-card--compact': compact, 'sgs-card--red': isRed }"
    type="button"
    :disabled="disabled"
    :aria-label="label"
  >
    <template v-if="card">
      <span class="sgs-card__corner">{{ suit }}{{ rank }}</span>
      <span class="sgs-card__name">{{ card.name }}</span>
      <span v-if="card.damageNature" class="sgs-card__nature">{{ card.damageNature === 'fire' ? '火' : '雷' }}</span>
    </template>
    <span v-else class="sgs-card__back">{{ backIndex === null ? '' : backIndex + 1 }}</span>
  </button>
</template>

<style scoped>
.sgs-card {
  position: relative;
  flex: 0 0 auto;
  width: 52px;
  height: 74px;
  padding: 5px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid #8d7a4e;
  border-radius: 7px;
  background: linear-gradient(168deg, #f4ecd8, #e2d5b4);
  color: #22201a;
  cursor: pointer;
  font-family: inherit;
  transition: transform .14s ease, box-shadow .14s ease, filter .14s ease;
}
.sgs-card:disabled { cursor: default; filter: grayscale(.55) brightness(.82); }
.sgs-card:not(:disabled):hover { transform: translateY(-3px); }
.sgs-card--selected {
  transform: translateY(-12px);
  box-shadow: 0 0 0 2px #e6bb5f, 0 8px 18px rgba(0, 0, 0, .4);
}
.sgs-card--compact { width: 34px; height: 48px; padding: 3px 2px; border-radius: 5px; }
.sgs-card__corner { align-self: flex-start; font-size: 10px; line-height: 1; color: #5c5442; }
.sgs-card--red .sgs-card__corner { color: #a8332a; }
.sgs-card__name { font-size: 14px; font-weight: 800; letter-spacing: -.02em; }
.sgs-card--compact .sgs-card__name { font-size: 10px; }
.sgs-card--compact .sgs-card__corner { font-size: 8px; }
.sgs-card__nature { font-size: 9px; color: #a8332a; }
/* 牌背：不放任何牌面信息 */
.sgs-card--back {
  border-color: #4a5a52;
  background: repeating-linear-gradient(135deg, #1c3a30 0 5px, #16302a 5px 10px);
  color: #7f9088;
}
.sgs-card__back { font-size: 12px; font-weight: 700; }

@media (pointer: coarse), (max-width: 820px) {
  .sgs-card { width: 46px; height: 66px; }
  .sgs-card__name { font-size: 13px; }
  .sgs-card--compact { width: 28px; height: 40px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .sgs-card { width: 42px; height: 60px; }
  .sgs-card__name { font-size: 12px; }
}
</style>
