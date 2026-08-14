<script setup lang="ts">
import { computed } from 'vue'
import { tileLabel } from '@/game/tiles'
import type { Tile } from '@/game/types'

const props = withDefaults(defineProps<{
  tile?: Tile
  hidden?: boolean
  selected?: boolean
  disabled?: boolean
  compact?: boolean
}>(), {
  tile: undefined,
  hidden: false,
  selected: false,
  disabled: false,
  compact: false,
})

const emit = defineEmits<{ select: [tile: Tile] }>()

const assets = import.meta.glob('../../assets/MaJong-UI/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const assetUrl = computed(() => {
  if (!props.tile || props.hidden) return ''
  const filename = props.tile.suit === 'zhong'
    ? '红中.svg'
    : `${props.tile.suit === 'dot' ? 'bing' : props.tile.suit === 'bamboo' ? 'tiao' : 'wan'}-${props.tile.rank}.svg`
  return assets[`../../assets/MaJong-UI/${filename}`] ?? ''
})

function choose() {
  if (!props.disabled && props.tile && !props.hidden) emit('select', props.tile)
}
</script>

<template>
  <button
    type="button"
    class="mahjong-tile"
    :class="{ hidden, selected, disabled, compact }"
    :disabled="disabled"
    :aria-label="hidden ? '牌背' : tile ? tileLabel(tile) : '空牌'"
    @click="choose"
  >
    <span v-if="hidden" class="tile-back-mark">中</span>
    <img v-else-if="assetUrl" :src="assetUrl" :alt="tile ? tileLabel(tile) : ''">
    <span v-else-if="tile" class="tile-fallback">{{ tileLabel(tile) }}</span>
  </button>
</template>

<style scoped>
.mahjong-tile {
  width: 46px;
  height: 64px;
  padding: 3px;
  border: 0;
  border-radius: 7px;
  background: linear-gradient(145deg, #fffef2, #e7dfc8);
  box-shadow: 0 4px 0 #b9ad8c, 0 6px 12px rgba(0, 0, 0, .28);
  cursor: pointer;
  transition: transform .14s ease, box-shadow .14s ease, filter .14s ease;
  flex: 0 0 auto;
}
.mahjong-tile img { width: 100%; height: 100%; object-fit: contain; display: block; }
.mahjong-tile:hover:not(.disabled):not(.hidden) { transform: translateY(-7px); }
.mahjong-tile.selected { transform: translateY(-10px); box-shadow: 0 4px 0 #b9ad8c, 0 0 0 3px #f6c85f, 0 12px 20px rgba(0,0,0,.38); }
.mahjong-tile.disabled { cursor: default; filter: saturate(.78); }
.mahjong-tile.hidden {
  background: linear-gradient(145deg, #174f43, #0a2c27);
  border: 2px solid #d4b45d;
  color: rgba(255,255,255,.22);
  cursor: default;
  box-shadow: 0 4px 0 #061d19, 0 6px 10px rgba(0,0,0,.3);
}
.mahjong-tile.compact { width: 31px; height: 43px; padding: 2px; border-radius: 5px; box-shadow: 0 2px 0 #b9ad8c, 0 3px 7px rgba(0,0,0,.25); }
.mahjong-tile.compact.hidden { box-shadow: 0 2px 0 #061d19, 0 3px 7px rgba(0,0,0,.25); }
.tile-back-mark { font: 700 18px/1 serif; }
.compact .tile-back-mark { font-size: 12px; }
.tile-fallback { color: #1d2a26; font-size: 11px; font-weight: 800; }
</style>
