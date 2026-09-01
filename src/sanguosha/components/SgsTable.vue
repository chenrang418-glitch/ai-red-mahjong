<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SgsCard from './SgsCard.vue'
import SgsSeat from './SgsSeat.vue'
import SgsRequestDock from './SgsRequestDock.vue'
import type { LegalAction } from '../engine/actions'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { PlayerView } from '../engine/view'

/**
 * 牌桌。
 *
 * 布局原则：真人永远在底部，其他人按相对座次环绕。
 * 人数 5～8 只改 grid 的列数，不为每种人数复制一套结构。
 * 手机上核心操作（看手牌、选牌、选目标、确认）都在一屏内，不需要整页滚动。
 */

const props = defineProps<{
  view: PlayerView
  request: GameRequest | null
  legalActions: readonly LegalAction[]
  busy: boolean
  log: readonly string[]
}>()

const emit = defineEmits<{ act: [actionId: string]; respond: [response: GameResponse]; quit: [] }>()

const selectedCardId = ref<string | null>(null)
const logOpen = ref(false)

const me = computed(() => props.view.players.find((player) => player.id === props.view.viewerId)!)
const others = computed(() => {
  // 从自己下家开始按座次绕一圈，这样屏幕上的相对位置和真牌桌一致
  const all = props.view.players
  const mySeat = me.value.seat
  return Array.from({ length: all.length - 1 }, (_, offset) => all[(mySeat + offset + 1) % all.length])
})

/** 当前选中的这张牌能做哪些事。一张牌可能有多种用途，全部列出来让玩家自己选。 */
const actionsForSelected = computed(() => {
  if (!selectedCardId.value) return []
  return props.legalActions.filter((action) => (
    action.kind === 'use-card' && action.cardIds.includes(selectedCardId.value!)
  ))
})

/** 不依赖任何一张手牌的动作：主动技、结束出牌。 */
const standaloneActions = computed(() => props.legalActions.filter((action) => (
  action.kind === 'invoke-skill' || action.kind === 'pass'
)))

const usableCardIds = computed(() => new Set(
  props.legalActions.flatMap((action) => (action.kind === 'use-card' ? action.cardIds : [])),
))

watch(() => props.view.seq, () => {
  // 牌面变了就取消选择，避免把选择残留到下一个局面
  if (selectedCardId.value && !me.value.hand?.some((card) => card.id === selectedCardId.value)) {
    selectedCardId.value = null
  }
})

function toggleCard(cardId: string): void {
  selectedCardId.value = selectedCardId.value === cardId ? null : cardId
}

const seatColumns = computed(() => {
  const count = others.value.length
  if (count <= 3) return count
  return Math.ceil(count / 2)
})
</script>

<template>
  <div class="sgs-table">
    <header class="sgs-table__bar">
      <button type="button" class="sgs-table__back" aria-label="退出牌局" @click="emit('quit')">‹</button>
      <span>第 {{ view.turnNumber }} 回合</span>
      <span>牌堆 {{ view.drawPileCount }}</span>
      <button type="button" class="sgs-table__logbtn" @click="logOpen = true">战报</button>
    </header>

    <section class="sgs-table__others" :style="{ '--seat-columns': seatColumns }">
      <SgsSeat
        v-for="player in others"
        :key="player.id"
        :player="player"
        :active="player.id === view.currentPlayerId"
      />
    </section>

    <section class="sgs-table__center">
      <div v-if="view.processingArea.length" class="sgs-table__processing">
        <SgsCard v-for="card in view.processingArea" :key="card.id" :card="card" compact disabled />
      </div>
      <p v-else class="sgs-table__phase">{{ view.currentPlayerId === view.viewerId ? '你的回合' : '等待其他角色' }} · {{ view.phase }}</p>
    </section>

    <section class="sgs-table__self">
      <SgsSeat :player="me" :active="me.id === view.currentPlayerId" />
      <div class="sgs-table__hand">
        <SgsCard
          v-for="card in me.hand ?? []"
          :key="card.id"
          :card="card"
          :selected="selectedCardId === card.id"
          :disabled="!!request || !usableCardIds.has(card.id)"
          @click="toggleCard(card.id)"
        />
      </div>
    </section>

    <!-- 有待响应的请求时，请求界面优先；否则显示出牌阶段的动作 -->
    <SgsRequestDock
      v-if="request"
      :request="request"
      :view="view"
      @submit="emit('respond', $event)"
    />
    <section v-else-if="legalActions.length" class="sgs-table__dock">
      <template v-if="actionsForSelected.length">
        <p class="sgs-table__hint">选择用途</p>
        <div class="sgs-table__actions">
          <button
            v-for="action in actionsForSelected"
            :key="action.id"
            type="button"
            class="primary"
            @click="emit('act', action.id); selectedCardId = null"
          >{{ action.label }}</button>
        </div>
      </template>
      <div class="sgs-table__actions">
        <button
          v-for="action in standaloneActions"
          :key="action.id"
          type="button"
          :class="action.kind === 'pass' ? 'ghost' : 'primary'"
          @click="emit('act', action.id); selectedCardId = null"
        >{{ action.label }}</button>
      </div>
    </section>
    <section v-else class="sgs-table__dock sgs-table__dock--idle">
      <p>{{ busy ? '其他角色行动中…' : '等待牌局推进' }}</p>
    </section>

    <div v-if="logOpen" class="sgs-table__mask" @click="logOpen = false"></div>
    <aside v-if="logOpen" class="sgs-table__log" aria-label="战报">
      <header><strong>战报</strong><button type="button" @click="logOpen = false">×</button></header>
      <ol v-if="log.length"><li v-for="(entry, index) in log" :key="index">{{ entry }}</li></ol>
      <p v-else class="sgs-table__logempty">还没有可显示的记录。</p>
    </aside>
  </div>
</template>

<style scoped>
.sgs-table {
  height: 100dvh;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto auto;
  overflow: hidden;
  color: #e7e0cc;
  background: radial-gradient(circle at 50% 12%, #2f5741, transparent 58%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom));
}
.sgs-table__bar {
  display: flex; align-items: center; gap: 10px;
  padding: max(8px, env(safe-area-inset-top)) 12px 6px;
  color: #93a49b; font-size: 12px;
}
.sgs-table__bar span { white-space: nowrap; }
.sgs-table__back {
  width: 34px; height: 34px; display: grid; place-items: center; padding: 0;
  border: 1px solid rgba(90, 130, 110, .35); border-radius: 9px;
  background: rgba(10, 28, 23, .78); color: #efe7d2; font-size: 20px; line-height: 1; cursor: pointer;
}
.sgs-table__logbtn {
  margin-left: auto; min-height: 30px; padding: 0 11px;
  border: 1px solid #3f4d45; border-radius: 8px; background: #16241e; color: #c3cfc6; cursor: pointer;
}

.sgs-table__others {
  display: grid;
  grid-template-columns: repeat(var(--seat-columns, 3), minmax(0, 1fr));
  gap: 5px;
  padding: 0 10px;
}
.sgs-table__center {
  display: grid; place-items: center; padding: 6px 10px; min-height: 0; overflow: hidden;
}
.sgs-table__processing { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; }
.sgs-table__phase { margin: 0; color: #7f8f86; font-size: 12px; }

.sgs-table__self { display: grid; gap: 5px; padding: 0 10px 6px; }
.sgs-table__hand {
  display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px;
  scrollbar-width: thin;
}

.sgs-table__dock {
  display: flex; flex-direction: column; gap: 6px;
  /* 同 SgsRequestDock：一张牌可能有很多用途，动作区不能无限长高把牌桌顶出去 */
  max-height: 46dvh; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 8px 11px calc(8px + env(safe-area-inset-bottom));
  border-top: 1px solid #46402c;
  background: linear-gradient(180deg, rgba(24, 34, 28, .97), rgba(12, 20, 16, .99));
}
.sgs-table__dock--idle { color: #7f8f86; font-size: 12px; }
.sgs-table__dock--idle p { margin: 0; }
.sgs-table__hint { margin: 0; color: #e9d9a6; font-size: 12px; font-weight: 700; }
.sgs-table__actions { display: flex; flex-wrap: wrap; gap: 7px; }
.sgs-table__actions button { min-height: 40px; padding: 0 14px; border-radius: 9px; cursor: pointer; font: inherit; font-weight: 700; }
.primary { border: 1px solid #9e7f3c; background: linear-gradient(180deg, #6d5527, #4c3b1a); color: #ffe6a8; }
.ghost { border: 1px solid #3f4d45; background: #16241e; color: #b9c5bd; }

.sgs-table__mask { position: fixed; inset: 0; z-index: 20; background: rgba(0, 0, 0, .6); }
.sgs-table__log {
  position: fixed; z-index: 21; right: 0; top: 0; bottom: 0; width: min(320px, 86vw);
  display: flex; flex-direction: column;
  padding: max(14px, env(safe-area-inset-top)) 14px 14px;
  border-left: 1px solid #3d4b43; background: #101c17;
}
.sgs-table__log header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.sgs-table__log header button { border: 0; background: transparent; color: #9fb0a6; font-size: 20px; cursor: pointer; }
.sgs-table__logempty { color: #7f8f86; font-size: 12px; line-height: 1.7; }
.sgs-table__log ol { flex: 1; margin: 0; padding: 0 0 0 18px; overflow-y: auto; color: #a9b5a9; font-size: 12px; line-height: 1.7; }

@media (orientation: landscape) and (max-height: 500px) {
  .sgs-table__bar { padding-top: max(4px, env(safe-area-inset-top)); font-size: 11px; }
  .sgs-table__others { gap: 4px; }
  .sgs-table__self { gap: 3px; padding-bottom: 3px; }
  .sgs-table__dock { padding: 6px 10px calc(6px + env(safe-area-inset-bottom)); }
  .sgs-table__actions button { min-height: 34px; }
}
</style>
