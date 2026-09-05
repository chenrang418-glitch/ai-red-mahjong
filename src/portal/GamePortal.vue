<script setup lang="ts">
import type { GameDefinition } from './gameManifest'
import SiteFooter from './SiteFooter.vue'
import './portal.css'

defineProps<{ games: readonly GameDefinition[] }>()
defineEmits<{ select: [game: GameDefinition] }>()
</script>

<template>
  <main class="game-portal">
    <div class="game-portal__center">
      <section class="game-portal__shell">
        <header class="game-portal__header">
          <div class="game-portal__brand"><span>CR</span><strong>PLAY</strong></div>
          <div>
            <p>和朋友，随时开一局</p>
            <h1>CRPlay 游戏中心</h1>
          </div>
        </header>

        <section class="game-portal__grid" aria-label="游戏列表">
          <button
            v-for="game in games"
            :key="game.id"
            class="game-portal__card"
            :class="{ 'game-portal__card--disabled': !game.enabled }"
            :disabled="!game.enabled"
            :style="{ '--game-accent': game.accent }"
            type="button"
            @click="$emit('select', game)"
          >
            <span class="game-portal__cover" aria-hidden="true">{{ game.cover }}</span>
            <span class="game-portal__copy">
              <small>{{ game.status }}</small>
              <strong>{{ game.name }}</strong>
              <span>{{ game.subtitle }}</span>
            </span>
            <span v-if="game.enabled" class="game-portal__arrow" aria-hidden="true">→</span>
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
