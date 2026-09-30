<script setup lang="ts">
import PortalGlassSurface from './PortalGlassSurface.vue'

defineProps<{ label: string; compact?: boolean; backdropSelector?: string }>()
const emit = defineEmits<{ click: [] }>()
function onClick(event?: MouseEvent): void {
  event?.stopPropagation()
  const target = event?.currentTarget as HTMLElement | null
  if (target?.dataset.liquidDragged === 'true') {
    event?.preventDefault()
    return
  }
  emit('click')
}
</script>

<template>
  <PortalGlassSurface
    class="portal-glass-button"
    :class="{ 'portal-glass-button--compact': compact }"
    :variant="compact ? 'menuButton' : 'primaryButton'"
    :backdrop-selector="backdropSelector"
    role="button"
    tabindex="0"
    @click="onClick"
    @keydown.enter.prevent="onClick"
    @keydown.space.prevent="onClick"
  ><span>{{ label }}</span></PortalGlassSurface>
</template>
