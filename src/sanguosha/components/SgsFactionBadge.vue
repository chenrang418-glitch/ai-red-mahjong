<script setup lang="ts">
import { computed } from 'vue'
import { factionDefinition, type Faction } from '../shared/factions'

const props = withDefaults(defineProps<{ faction: Faction; variant?: 'battle' | 'pick' }>(), { variant: 'battle' })
const definition = computed(() => factionDefinition(props.faction)!)
const badgeVars = computed(() => ({
  '--faction-color': definition.value.color,
  '--faction-text': definition.value.textColor,
  '--faction-border': definition.value.borderColor,
}))
</script>

<template>
  <span class="sgs-faction-badge" :class="`sgs-faction-badge--${variant}`" :style="badgeVars" :aria-label="`${definition.name}势力`">{{ definition.name }}</span>
</template>

<style scoped>
.sgs-faction-badge {
  box-sizing: border-box; min-width: 24px; height: 22px; display: inline-grid; place-items: center;
  padding: 0 7px; border: 1px solid var(--faction-border); border-radius: 7px;
  background: var(--faction-color); color: var(--faction-text);
  box-shadow: 0 1px 5px rgba(0, 0, 0, .38); font: 600 13px/1 "STXingkai", "华文行楷", "FZShuTi", "方正舒体", KaiTi, cursive;
  letter-spacing: .06em; white-space: nowrap; pointer-events: none;
}
.sgs-faction-badge--pick { font-size: 15px; }
@media (max-width: 820px), (orientation: landscape) and (max-height: 500px) {
  .sgs-faction-badge { min-width: 20px; height: 18px; padding: 0 5px; border-radius: 6px; font-size: 12px; }
  .sgs-faction-badge--pick { font-size: 14px; }
}
</style>
