<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import type { GlossaryEntry } from '../glossary'

const props = defineProps<{ entry: GlossaryEntry | null; timed?: boolean }>()
const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void { if (event.key === 'Escape' && props.entry) emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="entry" class="sgs-glossary-mask" @click.self="emit('close')">
    <aside class="sgs-glossary-sheet" role="dialog" aria-modal="true" :aria-label="`${entry.title}说明`">
      <div class="sgs-glossary-sheet__handle" aria-hidden="true"></div>
      <header><div><strong>{{ entry.title }}</strong><small>{{ entry.subtitle }}</small></div><button type="button" aria-label="关闭说明" @click="emit('close')">×</button></header>
      <p v-if="entry.description">{{ entry.description }}</p>
      <section v-if="entry.skills?.length" class="sgs-glossary-sheet__skills">
        <article v-for="skill in entry.skills" :key="skill.id"><b>【{{ skill.name }}】</b><span>{{ skill.description }}</span></article>
      </section>
      <p v-if="timed" class="sgs-glossary-sheet__timer">联机对局计时仍在继续</p>
    </aside>
  </div>
</template>

<style scoped>
.sgs-glossary-mask { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 6, .5); }
.sgs-glossary-sheet { width: min(390px, calc(100vw - 24px)); max-height: min(560px, 78dvh); overflow-y: auto; padding: 18px; border: 1px solid rgba(214, 177, 89, .45); border-radius: 16px; background: linear-gradient(155deg, #23332b, #101a16); color: #e8e0ca; box-shadow: 0 22px 70px rgba(0,0,0,.55); }
.sgs-glossary-sheet__handle { display: none; width: 40px; height: 4px; margin: -8px auto 12px; border-radius: 3px; background: #66756c; }
header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
header div { display: grid; gap: 3px; } header strong { color: #f2d384; font-size: 20px; } header small { color: #8fa097; }
header button { width: 34px; height: 34px; padding: 0; border: 0; background: transparent; color: #aab7af; font-size: 22px; cursor: pointer; }
p { margin: 16px 0 0; color: #c2ccc5; font-size: 13px; line-height: 1.8; }
.sgs-glossary-sheet__skills { display: grid; gap: 9px; margin-top: 14px; }
.sgs-glossary-sheet__skills article { display: grid; gap: 3px; padding: 10px; border: 1px solid #39483f; border-radius: 10px; background: rgba(10,20,16,.45); }
.sgs-glossary-sheet__skills b { color: #e9ce83; } .sgs-glossary-sheet__skills span { color: #b4c0b8; font-size: 12px; line-height: 1.6; }
.sgs-glossary-sheet__timer { color: #e2aa67; font-size: 11px; }
@media (max-width: 620px) { .sgs-glossary-mask { align-items: end; padding: 0; } .sgs-glossary-sheet { width: 100%; max-height: 72dvh; border-radius: 18px 18px 0 0; padding-bottom: calc(18px + env(safe-area-inset-bottom)); } .sgs-glossary-sheet__handle { display: block; } }
</style>
