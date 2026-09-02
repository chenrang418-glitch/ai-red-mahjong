<script setup lang="ts">
import { computed, ref } from 'vue'
import { ALL_CHARACTERS } from '../data/characters/standard'
import { characterPortrait } from '../assets/characters/manifest'
import type { CharacterDefinition, Kingdom } from '../data/characters/types'

const selected = ref<CharacterDefinition | null>(null)
const KINGDOMS: readonly { id: Kingdom; label: string }[] = [
  { id: 'shu', label: '蜀' },
  { id: 'wei', label: '魏' },
  { id: 'wu', label: '吴' },
  { id: 'qun', label: '群' },
]
const groups = computed(() => KINGDOMS.map((kingdom) => ({
  ...kingdom,
  characters: ALL_CHARACTERS.filter((character) => character.kingdom === kingdom.id),
})).filter((group) => group.characters.length))
</script>

<template>
  <div class="sgs-art-gallery">
    <section v-for="group in groups" :key="group.id" class="sgs-art-gallery__group">
      <h2>{{ group.label }}</h2>
      <div class="sgs-art-gallery__grid">
        <button v-for="character in group.characters" :key="character.id" type="button" @click="selected = character">
          <img v-if="characterPortrait(character.id)" :src="characterPortrait(character.id)!.src" :alt="`${character.name}立绘`" loading="lazy" decoding="async">
          <span v-else aria-hidden="true">{{ character.name.slice(-1) }}</span>
          <strong>{{ character.name }}</strong>
          <small v-if="character.pack === 'entertainment'">自定义</small>
        </button>
      </div>
    </section>

    <div v-if="selected" class="sgs-art-gallery__backdrop" role="dialog" aria-modal="true" :aria-label="`${selected.name}立绘原图`" @click.self="selected = null">
      <section class="sgs-art-gallery__viewer">
        <header><div><strong>{{ selected.name }}</strong><small>{{ groups.find((group) => group.id === selected!.kingdom)?.label }} · {{ selected.maxHp }} 体力</small></div><button type="button" aria-label="关闭" @click="selected = null">×</button></header>
        <img v-if="characterPortrait(selected.id)" :src="characterPortrait(selected.id)!.src" :alt="`${selected.name}立绘原图`">
        <div v-else class="sgs-art-gallery__missing">暂无立绘</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sgs-art-gallery{display:grid;gap:22px;padding:4px 2px 22px}.sgs-art-gallery__group{display:grid;gap:9px}.sgs-art-gallery__group h2{position:sticky;top:0;z-index:2;margin:0;padding:7px 2px;color:#efd58c;background:#14211bcc;font:800 18px/1.2 KaiTi,serif;backdrop-filter:blur(6px)}.sgs-art-gallery__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.sgs-art-gallery__grid button{position:relative;min-width:0;aspect-ratio:3/4;overflow:hidden;padding:0;border:1px solid #4d4a38;border-radius:12px;background:#18251f;color:#eee4ca;cursor:pointer}.sgs-art-gallery__grid img{width:100%;height:100%;display:block;object-fit:cover;object-position:50% 18%;transition:transform .2s ease}.sgs-art-gallery__grid button:hover img{transform:scale(1.025)}.sgs-art-gallery__grid>button>span{height:100%;display:grid;place-items:center;color:#857550;font:900 54px/1 KaiTi,serif}.sgs-art-gallery__grid strong{position:absolute;left:0;right:0;bottom:0;padding:24px 8px 8px;background:linear-gradient(transparent,rgba(5,11,8,.92));text-align:left;font-size:13px}.sgs-art-gallery__grid small{position:absolute;right:6px;top:6px;padding:2px 5px;border-radius:5px;background:#653e2ce8;color:#ffd4a6;font-size:9px}.sgs-art-gallery__backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:18px;background:rgba(2,7,5,.88)}.sgs-art-gallery__viewer{width:min(720px,100%);height:min(88dvh,960px);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid #806c42;border-radius:18px;background:#101913;box-shadow:0 24px 80px #000}.sgs-art-gallery__viewer header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px}.sgs-art-gallery__viewer header div{display:grid}.sgs-art-gallery__viewer header strong{color:#f2d994;font-size:18px}.sgs-art-gallery__viewer header small{color:#8f9d94}.sgs-art-gallery__viewer header button{width:38px;height:38px;border:0;background:transparent;color:#d8d2c2;font-size:28px}.sgs-art-gallery__viewer>img{width:100%;height:100%;display:block;object-fit:contain;background:#080d0a}.sgs-art-gallery__missing{display:grid;place-items:center;color:#89968e}.sgs-art-gallery__group:nth-child(1) h2{color:#a7d49b}.sgs-art-gallery__group:nth-child(2) h2{color:#a9c6e3}.sgs-art-gallery__group:nth-child(3) h2{color:#e6a19a}.sgs-art-gallery__group:nth-child(4) h2{color:#c6aedc}@media(max-width:620px){.sgs-art-gallery__grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sgs-art-gallery__viewer{height:92dvh}.sgs-art-gallery__group h2{font-size:16px}}@media(orientation:landscape) and (max-height:500px){.sgs-art-gallery__grid{grid-template-columns:repeat(5,minmax(0,1fr))}.sgs-art-gallery__viewer{width:min(92vw,760px);height:94dvh}}@media(prefers-reduced-motion:reduce){.sgs-art-gallery__grid img{transition:none}}
</style>
