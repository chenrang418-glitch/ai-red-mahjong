<script setup lang="ts">
import type { GameDefinition } from './gameManifest'
import SiteFooter from './SiteFooter.vue'
import './portal.css'
import generalArt from '../sanguosha/assets/characters/portraits/zhugeliang.webp'

defineProps<{ games: readonly GameDefinition[] }>()
defineEmits<{ select: [game: GameDefinition] }>()
</script>

<template>
  <main class="game-portal">
    <div class="game-portal__topline"><span>CR<span class="game-portal__wordmark">PLAY</span></span><span>游玩 · 会友 · 放松</span></div>
    <div class="game-portal__center">
      <section class="game-portal__shell">
        <header class="game-portal__header">
          <div>
            <p>和朋友，随时开一局</p>
            <h1>CRPlay 游戏中心</h1>
            <span class="game-portal__intro">熟悉的玩法，轻松的相聚。选一款，开始这一局。</span>
          </div>
          <span class="game-portal__count">{{ games.filter(game => game.enabled).length }} 款游戏 · 即点即玩</span>
        </header>

        <section class="game-portal__grid" aria-label="游戏列表">
          <button
            v-for="game in games"
            :key="game.id"
            class="game-portal__card"
            :class="[`game-portal__card--${game.id}`, { 'game-portal__card--disabled': !game.enabled }]"
            :disabled="!game.enabled"
            :style="{ '--game-accent': game.accent }"
            type="button"
            @click="$emit('select', game)"
          >
            <span v-if="game.enabled" class="game-portal__scene" aria-hidden="true">
              <img v-if="game.id === 'sanguosha'" :src="generalArt" alt="" decoding="async">
              <span v-else class="game-portal__tiles"><i>二<small>萬</small></i><i>中</i><i>六<small>萬</small></i></span>
              <span class="game-portal__scene-word">{{ game.id === 'sanguosha' ? '谋定而动' : '好牌相逢' }}</span>
            </span>
            <span v-else class="game-portal__cover" aria-hidden="true">{{ game.cover }}</span>
            <span class="game-portal__copy">
              <small>{{ game.status }}</small>
              <strong>{{ game.name }}</strong>
              <span>{{ game.subtitle }}</span>
            </span>
            <span v-if="game.enabled" class="game-portal__arrow" aria-hidden="true">开始游戏 <i>↗</i></span>
          </button>
        </section>
      </section>
    </div>

    <!--
      唯一长期展示「项目声明与免责声明」入口的地方。不要往麻将、纸上三国
      内部加同样的东西——那两处任何界面都不应该出现这段文字。
    -->
    <SiteFooter />
  </main>
</template>
