<script setup lang="ts">
import { computed, ref } from 'vue'
import { ALL_CHARACTERS } from '../data/characters/standard'
import { characterPortrait } from '../assets/characters/manifest'
import type { CharacterDefinition } from '../data/characters/types'
import { FACTION_CONFIG, FACTION_ORDER } from '../shared/factions'

const selected = ref<CharacterDefinition | null>(null)
const query = ref('')
const faction = ref('all')
/**
 * 高清图只在点开某一张时才挂上 `<img>`，所以列表和对局都不会去下载它。
 * 大图有几十到一百多 KB，解码前先显示同一张的小图，避免中间闪一块空白。
 */
const fullLoaded = ref(false)
function open(character: CharacterDefinition): void {
  fullLoaded.value = false
  selected.value = character
}
const groups = computed(() => FACTION_ORDER.map((id) => ({
  ...FACTION_CONFIG[id],
  characters: ALL_CHARACTERS.filter((character) => character.kingdom === id
    && (faction.value === 'all' || faction.value === id)
    && character.name.includes(query.value.trim())),
})).filter((group) => group.characters.length > 0 || (faction.value === 'all' && !query.value.trim())))
const resultCount = computed(() => groups.value.reduce((count, group) => count + group.characters.length, 0))
</script>

<template>
  <div class="sgs-art-gallery">
    <div class="sgs-art-gallery__toolbar">
      <label class="sgs-art-gallery__search"><span>寻访武将</span><input v-model="query" type="search" placeholder="搜索武将名称" aria-label="搜索武将名称"></label>
      <div class="sgs-art-gallery__filters" role="group" aria-label="阵营筛选">
        <button type="button" :aria-pressed="faction === 'all'" @click="faction = 'all'">全部</button>
        <button v-for="id in FACTION_ORDER" :key="id" type="button" :aria-pressed="faction === id" @click="faction = id">{{ FACTION_CONFIG[id].name }}</button>
      </div>
      <p aria-live="polite">共 {{ resultCount }} 名武将 · 点击立绘查看大图</p>
    </div>
    <div v-if="!resultCount" class="sgs-art-gallery__empty"><strong>未找到这位武将</strong><p>试试其他名称，或查看全部阵营。</p><button type="button" @click="query = ''; faction = 'all'">重置筛选</button></div>
    <section v-for="group in groups" :key="group.id" class="sgs-art-gallery__group">
      <h2 :style="{ color: group.headingColor }">{{ group.name }}</h2>
      <p v-if="!group.characters.length" class="sgs-art-gallery__unavailable">此阵营暂无可展示武将</p>
      <div class="sgs-art-gallery__grid">
        <button v-for="character in group.characters" :key="character.id" type="button" @click="open(character)">
          <img v-if="characterPortrait(character.id)" :src="characterPortrait(character.id)!.src" :alt="`${character.name}立绘`" loading="lazy" decoding="async">
          <span v-else aria-hidden="true">{{ character.name.slice(-1) }}</span>
          <strong>{{ character.name }}</strong>
          <small v-if="character.pack === 'entertainment'">自定义</small>
        </button>
      </div>
    </section>

    <div v-if="selected" class="sgs-art-gallery__backdrop" role="dialog" aria-modal="true" :aria-label="`${selected.name}立绘原图`" @click.self="selected = null">
      <section class="sgs-art-gallery__viewer">
        <header><div><strong>{{ selected.name }}</strong><small>{{ FACTION_CONFIG[selected.kingdom].name }} · {{ selected.maxHp }} 体力</small></div><button type="button" aria-label="关闭" @click="selected = null">×</button></header>
        <div v-if="characterPortrait(selected.id)" class="sgs-art-gallery__stage">
          <!-- 小图先顶上，高清图解码完再盖上去；两张同焦点，切换时看不出跳变 -->
          <img class="sgs-art-gallery__preview" :src="characterPortrait(selected.id)!.src" :alt="`${selected.name}立绘`" aria-hidden="true">
          <img
            class="sgs-art-gallery__full"
            :class="{ ready: fullLoaded }"
            :src="characterPortrait(selected.id)!.fullSrc"
            :alt="`${selected.name}立绘原图`"
            decoding="async"
            @load="fullLoaded = true"
          >
        </div>
        <div v-else class="sgs-art-gallery__missing">暂无立绘</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sgs-art-gallery__toolbar { display: grid; gap: 12px; padding: 16px; border: 1px solid #385052; border-radius: 14px; background: #102124; }
.sgs-art-gallery__search { display: flex; align-items: center; gap: 14px; color: #e0c89d; font-size: 13px; }
.sgs-art-gallery__search span { flex: none; }
.sgs-art-gallery__search input { width: 100%; min-width: 0; min-height: 40px; padding: 0 12px; border: 1px solid #40585a; border-radius: 8px; background: #0a1b1e; color: #ede4d2; font: inherit; }
.sgs-art-gallery__filters { display: flex; flex-wrap: wrap; gap: 8px; }
.sgs-art-gallery__filters button, .sgs-art-gallery__empty button { min-height: 36px; padding: 0 14px; border: 1px solid #40585a; border-radius: 8px; background: #162d2e; color: #bdcec5; cursor: pointer; }
.sgs-art-gallery__filters button[aria-pressed="true"] { border-color: #d8b777; color: #f4d596; background: #363325; }
.sgs-art-gallery__toolbar p { margin: 0; color: #98aaa7; font-size: 11px; }
.sgs-art-gallery__empty { padding: 40px 16px; text-align: center; color: #d8b777; }
.sgs-art-gallery__empty p { color: #a5b8b0; font-size: 13px; }
.sgs-art-gallery__unavailable { margin: 0; color: #98aaa7; font-size: 12px; }
.sgs-art-gallery{display:grid;gap:22px;padding:4px 2px 22px}.sgs-art-gallery__group{display:grid;gap:9px}.sgs-art-gallery__group h2{position:sticky;top:0;z-index:2;margin:0;padding:7px 2px;color:#efd58c;background:#14211bcc;font:800 18px/1.2 KaiTi,serif;backdrop-filter:blur(6px)}.sgs-art-gallery__grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.sgs-art-gallery__grid button{position:relative;min-width:0;aspect-ratio:3/4;overflow:hidden;padding:0;border:1px solid #4d4a38;border-radius:12px;background:#18251f;color:#eee4ca;cursor:pointer}.sgs-art-gallery__grid img{width:100%;height:100%;display:block;object-fit:cover;object-position:50% 18%;transition:transform .2s ease}.sgs-art-gallery__grid button:hover img{transform:scale(1.025)}.sgs-art-gallery__grid>button>span{height:100%;display:grid;place-items:center;color:#857550;font:900 54px/1 KaiTi,serif}.sgs-art-gallery__grid strong{position:absolute;left:0;right:0;bottom:0;padding:24px 8px 8px;background:linear-gradient(transparent,rgba(5,11,8,.92));text-align:left;font-size:13px}.sgs-art-gallery__grid small{position:absolute;right:6px;top:6px;padding:2px 5px;border-radius:5px;background:#653e2ce8;color:#ffd4a6;font-size:9px}.sgs-art-gallery__backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:18px;background:rgba(2,7,5,.88)}.sgs-art-gallery__viewer{width:min(720px,100%);height:min(88dvh,960px);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid #806c42;border-radius:18px;background:#101913;box-shadow:0 24px 80px #000}.sgs-art-gallery__viewer header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px}.sgs-art-gallery__viewer header div{display:grid}.sgs-art-gallery__viewer header strong{color:#f2d994;font-size:18px}.sgs-art-gallery__viewer header small{color:#8f9d94}.sgs-art-gallery__viewer header button{width:38px;height:38px;border:0;background:transparent;color:#d8d2c2;font-size:28px}.sgs-art-gallery__stage{position:relative;background:#080d0a}.sgs-art-gallery__stage img{position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:contain}.sgs-art-gallery__preview{filter:blur(2px)}.sgs-art-gallery__full{opacity:0;transition:opacity .18s ease}.sgs-art-gallery__full.ready{opacity:1}.sgs-art-gallery__missing{display:grid;place-items:center;color:#89968e}@media(max-width:620px){.sgs-art-gallery__grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sgs-art-gallery__viewer{height:92dvh}.sgs-art-gallery__group h2{font-size:16px}}@media(orientation:landscape) and (max-height:500px){.sgs-art-gallery__grid{grid-template-columns:repeat(5,minmax(0,1fr))}.sgs-art-gallery__viewer{width:min(92vw,760px);height:94dvh}}@media(prefers-reduced-motion:reduce){.sgs-art-gallery__grid img,.sgs-art-gallery__full{transition:none}}
</style>
