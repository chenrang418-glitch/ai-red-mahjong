<script setup lang="ts">
import { computed } from 'vue'
import SgsCard from './SgsCard.vue'
import { getCharacter } from '../data/characters/standard'
import type { PlayerPublicView } from '../engine/view'

const props = withDefaults(defineProps<{
  player: PlayerPublicView
  active?: boolean
  selectable?: boolean
  selected?: boolean
  /** 只在结算或自己回合等需要提示时高亮 */
  hint?: string
}>(), { active: false, selectable: false, selected: false, hint: '' })

defineEmits<{ select: [playerId: string] }>()

const IDENTITY_TEXT: Record<string, string> = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' }

const character = computed(() => (props.player.characterId ? getCharacter(props.player.characterId) : undefined))
// 未公开身份在 PlayerView 里就是 null，这里没有任何办法把它显示出来
const identityText = computed(() => (props.player.identity ? IDENTITY_TEXT[props.player.identity] : '？'))
const hpDots = computed(() => Array.from({ length: props.player.maxHp }, (_, index) => index < props.player.hp))
</script>

<template>
  <component
    :is="selectable ? 'button' : 'div'"
    class="sgs-seat"
    :class="{
      'sgs-seat--active': active,
      'sgs-seat--selected': selected,
      'sgs-seat--selectable': selectable,
      'sgs-seat--dead': !player.alive,
      'sgs-seat--chained': player.chained,
    }"
    :type="selectable ? 'button' : undefined"
    @click="selectable && $emit('select', player.id)"
  >
    <header>
      <span class="sgs-seat__identity" :class="`sgs-seat__identity--${player.identity ?? 'hidden'}`">{{ identityText }}</span>
      <strong>{{ player.nickname }}</strong>
      <span v-if="character" class="sgs-seat__general">{{ character.name }}</span>
    </header>

    <div class="sgs-seat__hp" :aria-label="`体力 ${player.hp} / ${player.maxHp}`">
      <i v-for="(filled, index) in hpDots" :key="index" :class="{ filled }"></i>
    </div>

    <div class="sgs-seat__meta">
      <span class="sgs-seat__hand">手牌 {{ player.handCount }}</span>
      <span v-if="player.chained" class="sgs-seat__tag">横置</span>
      <span v-if="!player.alive" class="sgs-seat__tag sgs-seat__tag--dead">阵亡</span>
    </div>

    <div v-if="player.equipment.length" class="sgs-seat__zone">
      <SgsCard v-for="card in player.equipment" :key="card.id" :card="card" compact disabled />
    </div>
    <div v-if="player.judgingArea.length" class="sgs-seat__zone sgs-seat__zone--judge">
      <SgsCard v-for="card in player.judgingArea" :key="card.id" :card="card" compact disabled />
    </div>

    <p v-if="hint" class="sgs-seat__hint">{{ hint }}</p>
  </component>
</template>

<style scoped>
.sgs-seat {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  border: 1px solid #3a4a41;
  border-radius: 11px;
  background: rgba(14, 28, 23, .88);
  color: #e6e0cd;
  font: inherit;
  text-align: left;
}
.sgs-seat--selectable { cursor: pointer; }
.sgs-seat--selectable:hover { border-color: #d3b463; }
.sgs-seat--active { border-color: #e0b95c; box-shadow: 0 0 0 1px rgba(224, 185, 92, .35), 0 0 18px rgba(224, 185, 92, .22); }
.sgs-seat--selected { border-color: #cf5a4c; box-shadow: 0 0 0 2px rgba(207, 90, 76, .5); }
.sgs-seat--dead { opacity: .5; }
.sgs-seat--chained { background: rgba(30, 30, 20, .9); }

header { display: flex; align-items: center; gap: 5px; min-width: 0; }
header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.sgs-seat__general { color: #d9c68d; font-size: 11px; white-space: nowrap; }
.sgs-seat__identity {
  flex: 0 0 auto; padding: 1px 5px; border-radius: 4px;
  background: #2b3831; color: #93a49b; font-size: 9px;
}
.sgs-seat__identity--lord { background: #6a4a1c; color: #ffd98a; }
.sgs-seat__identity--rebel { background: #5c2622; color: #ffb3aa; }
.sgs-seat__identity--loyalist { background: #21432f; color: #a6e0bb; }
.sgs-seat__identity--renegade { background: #3d3151; color: #cbb6ee; }

.sgs-seat__hp { display: flex; gap: 3px; }
.sgs-seat__hp i { width: 8px; height: 8px; border: 1px solid #6c5f3c; border-radius: 50%; }
.sgs-seat__hp i.filled { background: #d7643f; border-color: #d7643f; }

.sgs-seat__meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: #8fa199; font-size: 10px; }
.sgs-seat__tag { padding: 0 4px; border-radius: 3px; background: #2f3a2e; color: #cbbf8d; }
.sgs-seat__tag--dead { background: #402221; color: #e8a79f; }

.sgs-seat__zone { display: flex; flex-wrap: wrap; gap: 2px; }
.sgs-seat__zone--judge { padding-top: 2px; border-top: 1px dashed #3d4b43; }
.sgs-seat__hint { margin: 0; color: #e0b95c; font-size: 10px; }

@media (pointer: coarse), (max-width: 820px) {
  .sgs-seat { padding: 5px 6px; gap: 3px; border-radius: 9px; }
  header strong { font-size: 11px; }
  .sgs-seat__general { font-size: 10px; }
}
</style>
