<script setup lang="ts">
import { computed } from 'vue'
import type { PhysicalCard } from '../engine/types'
import { cardGlossary } from '../glossary'
import { useSgsGlossary } from '../composables/useSgsGlossary'
import { cardArt } from '../assets/cards/manifest'

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
const emit = defineEmits<{ click: [] }>()
const glossary = useSgsGlossary()

const SUIT_TEXT: Record<string, string> = { heart: '♥', diamond: '♦', spade: '♠', club: '♣' }
const RANK_TEXT: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }

const suit = computed(() => (props.card && !props.card.virtual ? SUIT_TEXT[props.card.suit] ?? '' : ''))
const rank = computed(() => {
  if (!props.card || props.card.virtual) return ''
  return RANK_TEXT[props.card.rank] ?? String(props.card.rank)
})
const isRed = computed(() => props.card?.color === 'red')
const label = computed(() => (props.card ? `${props.card.name}${props.card.virtual ? '（虚拟牌）' : ` ${suit.value}${rank.value}`}` : '未知牌'))
const categoryText = computed(() => ({ basic: '基本', trick: '锦囊', equipment: '装备' })[props.card?.category ?? 'basic'])
const art = computed(() => props.card ? cardArt(props.card.name) : null)

function showInfo(): void {
  if (props.card) glossary?.open(cardGlossary(props.card.name))
}
</script>

<template>
  <div class="sgs-card-shell" :class="{ 'sgs-card-shell--compact': compact }">
    <button
      class="sgs-card"
      :class="{ 'sgs-card--selected': selected, 'sgs-card--back': !card, 'sgs-card--compact': compact, 'sgs-card--red': isRed, [`sgs-card--${card?.category ?? 'unknown'}`]: true }"
      type="button"
      :disabled="disabled"
      :aria-label="label"
      @click="emit('click')"
    >
      <template v-if="card">
        <span class="sgs-card__corner">{{ card.virtual ? '虚拟' : `${suit}${rank}` }}</span>
        <span class="sgs-card__art" :style="art ? { backgroundImage: `url(${art})` } : undefined" aria-hidden="true">{{ art ? '' : card.name.slice(0, 1) }}</span>
        <span class="sgs-card__name">{{ card.name }}</span>
        <span class="sgs-card__category">{{ categoryText }}</span>
        <span v-if="card.damageNature" class="sgs-card__nature">{{ card.damageNature === 'fire' ? '火' : '雷' }}</span>
      </template>
      <span v-else class="sgs-card__back">{{ backIndex === null ? '' : backIndex + 1 }}</span>
    </button>
    <button v-if="card" type="button" class="sgs-card__info" :aria-label="`查看${card.name}说明`" @click.stop="showInfo">i</button>
  </div>
</template>

<style scoped>
.sgs-card-shell { position: relative; flex: 0 0 auto; width: 56px; height: 78px; transition: margin .16s ease, transform .16s ease; }
.sgs-card-shell--compact { width: 36px; height: 50px; }
.sgs-card {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  height: 100%;
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
.sgs-card:disabled { cursor: default; filter: saturate(.65) brightness(.86); }
.sgs-card:not(:disabled):hover { transform: translateY(-3px); }
.sgs-card--selected {
  transform: translateY(-12px);
  box-shadow: 0 0 0 2px #e6bb5f, 0 8px 18px rgba(0, 0, 0, .4);
}
.sgs-card--compact { padding: 3px 2px; border-radius: 5px; }
.sgs-card__corner { align-self: flex-start; font-size: 10px; line-height: 1; color: #5c5442; }
.sgs-card--red .sgs-card__corner { color: #a8332a; }
.sgs-card__name { font-size: 14px; font-weight: 800; letter-spacing: -.02em; }
.sgs-card__art { position: absolute; inset: 16px 5px 18px; display: grid; place-items: center; background-position:center;background-size:cover;color: rgba(87,64,33,.12); font: 900 30px/1 KaiTi, serif; }
.sgs-card__category { position: absolute; bottom: 4px; color: #74684f; font-size: 7px; letter-spacing: .12em; }
.sgs-card--compact .sgs-card__name { font-size: 10px; }
.sgs-card--compact .sgs-card__corner { font-size: 8px; }
.sgs-card--compact .sgs-card__art, .sgs-card--compact .sgs-card__category { display: none; }
.sgs-card__nature { font-size: 9px; color: #a8332a; }
.sgs-card__info { position: absolute; z-index: 2; top: 3px; right: 3px; width: 16px; height: 16px; padding: 0; border: 1px solid rgba(70,57,38,.38); border-radius: 50%; background: rgba(250,242,220,.86); color: #5a4a30; font: 700 10px/1 serif; cursor: help; }
.sgs-card-shell--compact .sgs-card__info { top: -3px; right: -3px; width: 14px; height: 14px; font-size: 8px; }
/* 牌背：不放任何牌面信息 */
.sgs-card--back {
  border-color: #4a5a52;
  background: repeating-linear-gradient(135deg, #1c3a30 0 5px, #16302a 5px 10px);
  color: #7f9088;
}
.sgs-card__back { font-size: 12px; font-weight: 700; }

@media (pointer: coarse), (max-width: 820px) {
  .sgs-card-shell { width: 48px; height: 68px; }
  .sgs-card__name { font-size: 13px; }
  .sgs-card-shell--compact { width: 30px; height: 42px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .sgs-card-shell { width: 44px; height: 62px; }
  .sgs-card__name { font-size: 12px; }
}
</style>
