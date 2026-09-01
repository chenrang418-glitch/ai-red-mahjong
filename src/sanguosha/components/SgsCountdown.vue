<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
const props = defineProps<{ deadlineAt: number | null }>()
const now = ref(Date.now()); let timer: number | null = null
const remaining = computed(() => props.deadlineAt ? Math.max(0, Math.ceil((props.deadlineAt - now.value) / 1000)) : null)
function restart(): void { if (timer !== null) window.clearInterval(timer); now.value = Date.now(); if (props.deadlineAt) timer = window.setInterval(() => { now.value = Date.now() }, 250) }
watch(() => props.deadlineAt, restart, { immediate: true }); onBeforeUnmount(() => { if (timer !== null) window.clearInterval(timer) })
</script>
<template><span v-if="remaining !== null" class="sgs-countdown" :class="{ 'sgs-countdown--urgent': remaining <= 5 }">剩余 {{ remaining }}s</span></template>
<style scoped>.sgs-countdown{display:inline-flex;align-items:center;padding:3px 7px;border:1px solid #6f633f;border-radius:999px;background:#2f2a1b;color:#f0d885;font-size:10px;font-variant-numeric:tabular-nums}.sgs-countdown--urgent{border-color:#c8574b;background:#4e2723;color:#ffbbb0;animation:countdown-pulse .8s ease-in-out infinite}@keyframes countdown-pulse{50%{transform:scale(1.06)}}@media(prefers-reduced-motion:reduce){.sgs-countdown--urgent{animation:none}}</style>
