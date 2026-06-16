<template>
  <div class="eff-panel panel">
    <div class="panel-header">
      <span class="panel-icon">🧮</span>
      <span class="panel-title">有效进张</span>
      <span class="shanten-badge" :class="shantenClass">
        {{ shantenLabel }}
      </span>
    </div>

    <!-- 已胡牌 -->
    <div v-if="shanten <= -1" class="eff-win">
      <div class="eff-win-icon">🎉</div>
      <div class="eff-win-text">已胡牌！</div>
    </div>

    <!-- Phase 1: 纯摸牌有效进张（13张手牌时） -->
    <template v-else-if="effectiveResult">
      <div class="eff-summary">
        <div class="summary-item">
          <span class="summary-label">有效进张</span>
          <span class="summary-value" :class="{ good: effectiveResult.effectiveDraws.length > 10, mid: effectiveResult.effectiveDraws.length > 5 }">
            {{ effectiveResult.effectiveDraws.length }} 种
          </span>
        </div>
        <div class="summary-item">
          <span class="summary-label">总张数</span>
          <span class="summary-value">{{ effectiveResult.totalEffectiveCount }} 张</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">进张率</span>
          <span class="summary-value" :class="rateClass(effectiveResult.acceptanceRate)">
            {{ (effectiveResult.acceptanceRate * 100).toFixed(1) }}%
          </span>
        </div>
      </div>

      <!-- 进张率进度条 -->
      <div class="rate-bar">
        <div class="rate-bar-fill" :class="rateClass(effectiveResult.acceptanceRate)"
          :style="{ width: Math.min(effectiveResult.acceptanceRate * 100, 100) + '%' }"></div>
      </div>

      <!-- 有效进张列表（左右两列） -->
      <div class="eff-grid">
        <div
          v-for="draw in effectiveResult.effectiveDraws"
          :key="draw.tile.id"
          class="eff-item"
        >
          <div class="eff-tile-wrap">
            <TileView :tile="draw.tile" mini />
            <span v-if="draw.isGolden" class="golden-star" title="极佳进张">⭐</span>
            <span class="eff-remaining">×{{ draw.remainingCount }}</span>
          </div>
          <div class="eff-combos">
            <div
              v-for="(combo, ci) in draw.formedCombinations.slice(0, 1)"
              :key="ci"
              class="eff-combo"
            >
              <span class="combo-type">{{ comboLabel(combo.type) }}</span>
              <div class="combo-tiles">
                <TileView
                  v-for="ct in combo.tiles"
                  :key="ct.id"
                  :tile="ct"
                  mini
                  :class="{ ghost: ct.id === combo.drawnTileId }"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Phase 2: 打摸联动（14张手牌时） -->
    <template v-else-if="discardResult">
      <div class="discard-header">
        <span class="discard-hint">推荐打牌（打出后进张最优）</span>
      </div>
      <div class="discard-list">
        <div
          v-for="(opt, i) in discardResult.options.slice(0, 6)"
          :key="opt.discard.id"
          class="discard-item"
          :class="{ best: i === 0 }"
        >
          <div class="discard-tile-wrap">
            <span v-if="i === 0" class="best-tag">最优</span>
            <span v-if="opt.isUpperFeed" class="upper-feed-tag" title="上家可能碰牌，有助于加速摸牌轮次">🚀 喂上家</span>
            <TileView :tile="opt.discard" mini />
          </div>
          <div class="discard-stats">
            <span class="discard-stat">
              <span class="stat-label">向听</span>
              <span class="stat-value">{{ opt.shantenAfter }}</span>
            </span>
            <span class="discard-stat">
              <span class="stat-label">进张</span>
              <span class="stat-value">{{ opt.effectiveCount }}张</span>
            </span>
            <span class="discard-stat">
              <span class="stat-label">进张率</span>
              <span class="stat-value" :class="rateClass(opt.acceptanceRate)">
                {{ (opt.acceptanceRate * 100).toFixed(1) }}%
              </span>
            </span>
          </div>
          <!-- 展开显示进张牌 -->
          <div v-if="i === 0 && opt.effectiveDraws.length > 0" class="discard-draws">
            <TileView
              v-for="d in opt.effectiveDraws.slice(0, 12)"
              :key="d.tile.id"
              :tile="d.tile"
              mini
              :count="d.remainingCount"
              :class="{ 'golden-tile': d.isGolden }"
            />
            <span v-if="opt.effectiveDraws.length > 12" class="more-hint">
              +{{ opt.effectiveDraws.length - 12 }}
            </span>
          </div>
        </div>
      </div>
    </template>

    <!-- 无数据 -->
    <div v-else class="eff-empty">
      <div class="eff-empty-text">等待游戏开始</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import TileView from './TileView.vue'
import type { EffectiveDrawResult, DiscardRecommendation, ShantenResult } from '@/types'

const props = defineProps<{
  shantenResult: ShantenResult
  effectiveResult: EffectiveDrawResult | null
  discardResult: DiscardRecommendation | null
}>()

const shanten = computed(() => props.shantenResult.shanten)

const shantenLabel = computed(() => {
  const s = shanten.value
  if (s <= -1) return '已胡'
  if (s === 0) return '听牌'
  return `${s}向听`
})

const shantenClass = computed(() => {
  const s = shanten.value
  if (s <= -1) return 'win'
  if (s === 0) return 'ready'
  if (s === 1) return 'close'
  return 'far'
})

function rateClass(rate: number): string {
  if (rate >= 0.15) return 'high'
  if (rate >= 0.08) return 'mid'
  return 'low'
}

function comboLabel(type: string): string {
  return { sequence: '顺', triplet: '刻', pair: '对' }[type] || type
}
</script>

<style scoped>
.eff-panel {
  padding: 16px;
  background: var(--color-card);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.panel-icon { font-size: 18px; }

.panel-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.shanten-badge {
  margin-left: auto;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 700;
}
.shanten-badge.win { background: var(--color-gold); color: #1a1a2e; }
.shanten-badge.ready { background: var(--color-success); color: #0f0f1a; }
.shanten-badge.close { background: var(--color-accent); color: #1a1a2e; }
.shanten-badge.far { background: var(--color-text-dim); color: #fff; }

/* 已胡牌 */
.eff-win {
  text-align: center;
  padding: 20px 0;
}
.eff-win-icon { font-size: 48px; margin-bottom: 12px; }
.eff-win-text { font-size: 20px; color: var(--color-gold); font-weight: bold; }

/* 摘要 */
.eff-summary {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.summary-item {
  flex: 1;
  text-align: center;
  padding: 12px 6px;
  background: var(--color-surface);
  border-radius: 8px;
  border: 1px solid var(--color-border);
}
.summary-label {
  display: block;
  font-size: 13px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
  font-weight: 600;
}
.summary-value {
  font-size: 22px;
  font-weight: 800;
  color: var(--color-text);
  font-family: 'JetBrains Mono', monospace;
}
.summary-value.good { color: var(--color-success); }
.summary-value.mid { color: var(--color-accent); }
.summary-value.high { color: var(--color-success); text-shadow: 0 0 8px rgba(72,219,251,0.4); }
.summary-value.low { color: var(--color-danger); }

.rate-bar {
  height: 10px;
  background: var(--color-surface);
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 14px;
}
.rate-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease;
  min-width: 2px;
}
.rate-bar-fill.high { background: linear-gradient(90deg, var(--color-success), #48dbfb); }
.rate-bar-fill.mid { background: linear-gradient(90deg, var(--color-accent), #feca57); }
.rate-bar-fill.low { background: linear-gradient(90deg, var(--color-danger), #ff4757); }

/* 有效进张列表：左右两列 */
.eff-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  max-height: 440px;
  overflow-y: auto;
}
.eff-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  background: var(--color-surface);
  border-radius: 8px;
  border: 1px solid var(--color-border);
  transition: all 0.2s;
  min-width: 0;
}
.eff-item:hover {
  border-color: var(--color-border-light);
}
.eff-tile-wrap {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}
.eff-remaining {
  font-size: 14px;
  color: var(--color-accent);
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
}
.golden-star {
  font-size: 14px;
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
.eff-combos {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex: 1;
}
.eff-combo {
  display: flex;
  align-items: center;
  gap: 4px;
}
.combo-type {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--color-card);
  color: var(--color-text-muted);
  font-weight: 600;
}
.combo-tiles {
  display: flex;
  gap: 2px;
}
.combo-tiles :deep(.tile.ghost) {
  opacity: 0.45;
  border: 1px dashed var(--color-accent);
}

/* Phase 2: 打摸联动 */
.discard-header {
  margin-bottom: 12px;
}
.discard-hint {
  font-size: 14px;
  color: var(--color-text-muted);
  font-weight: 600;
}
.discard-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
}
.discard-item {
  padding: 12px 14px;
  background: var(--color-surface);
  border-radius: 10px;
  border: 1px solid var(--color-border);
  transition: all 0.2s;
}
.discard-item.best {
  border-color: var(--color-success);
  background: linear-gradient(135deg, var(--color-surface), var(--color-card-hover));
}
.discard-tile-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.best-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--color-success);
  color: #0f0f1a;
  font-weight: 800;
}
.upper-feed-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(254, 202, 87, 0.2);
  border: 1px solid var(--color-accent);
  color: var(--color-accent);
  font-weight: 800;
}
.discard-stats {
  display: flex;
  gap: 12px;
  margin-bottom: 4px;
}
.discard-stat {
  display: flex;
  align-items: center;
  gap: 4px;
}
.discard-stat .stat-label {
  font-size: 13px;
  color: var(--color-text-dim);
  font-weight: 600;
}
.discard-stat .stat-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--color-text);
  font-family: 'JetBrains Mono', monospace;
}
.discard-stat .stat-value.high { color: var(--color-success); }
.discard-stat .stat-value.mid { color: var(--color-accent); }
.discard-stat .stat-value.low { color: var(--color-danger); }
.discard-draws {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--color-border);
}
.discard-draws :deep(.tile.golden-tile) {
  box-shadow: 0 0 4px 1px var(--color-gold);
  border-color: var(--color-gold);
}
.more-hint {
  font-size: 11px;
  color: var(--color-text-dim);
  align-self: center;
  padding: 0 4px;
}

/* 空状态 */
.eff-empty {
  text-align: center;
  padding: 20px 0;
}
.eff-empty-text {
  font-size: 14px;
  color: var(--color-text-dim);
}
</style>
