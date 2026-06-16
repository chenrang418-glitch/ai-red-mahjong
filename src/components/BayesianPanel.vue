<template>
  <div class="bayesian-panel">
    <!-- 标题栏（可折叠） -->
    <div class="panel-header" @click="collapsed = !collapsed">
      <div class="header-left">
        <span class="panel-icon">🧠</span>
        <span class="panel-title">对手读牌分析</span>
        <span v-if="safetyWarnings.length > 0" class="warning-badge">
          {{ safetyWarnings.length }} 张需注意
        </span>
      </div>
      <span class="collapse-icon">{{ collapsed ? '▶' : '▼' }}</span>
    </div>

    <!-- 折叠内容 -->
    <div v-if="!collapsed" class="panel-body">
      <!-- 无数据状态 -->
      <div v-if="!hasData" class="empty-state">
        <span>⏳ 等待对手出牌...</span>
      </div>

      <template v-else>
        <!-- 各对手出牌分析 -->
        <div v-for="opp in opponentAnalyses" :key="opp.id" class="opponent-card">
          <div class="opp-header">
            <span class="opp-name">{{ opp.name }}</span>
            <span v-if="opp.readResult && opp.readResult.missingSuits.length > 0" class="missing-suit-badge">
              缺门: {{ opp.readResult.missingSuits.map(s => formatSuit(s)).join('、') }}
            </span>
          </div>

          <div class="opp-advice" v-if="opp.readResult && opp.readResult.advice">
            <span class="advice-icon">💡</span> {{ opp.readResult.advice }}
          </div>

          <!-- 高阶推测逻辑展示 (置信度 >= 50%) -->
          <template v-if="opp.highConfDeductions && opp.highConfDeductions.length > 0">
            <div class="opp-deductions">
              <div v-for="(deduction, i) in opp.highConfDeductions" :key="i" class="deduction-row">
                <span class="deduction-rule">[{{ deduction.ruleId }}]</span>
                <span class="deduction-desc">{{ deduction.description }}</span>
                <span class="deduction-conf">{{ (deduction.confidence * 100).toFixed(0) }}%</span>
              </div>
            </div>
            
            <!-- 推测的安全牌 -->
            <div class="safe-tiles-area" v-if="opp.safeTiles.length > 0">
              <span class="safe-badge">🔰 推测安全牌:</span>
              <div class="safe-tiles-row">
                <span v-for="(t, i) in opp.safeTiles" :key="i" class="safe-tile-label">{{ t.label }}</span>
              </div>
            </div>
          </template>

          <div class="opp-tiles">
            <div
              v-for="(item, i) in opp.discards"
              :key="i"
              class="tile-entry"
              :class="item.safetyClass"
              :title="`第${item.round}巡打出 | 该牌在对手手里概率 ${(item.posteriorProb * 100).toFixed(0)}%`"
            >
              <span class="tile-label">{{ item.label }}</span>
              <span class="tile-round">R{{ item.round }}</span>
              <span
                v-if="item.isTarget"
                class="target-mark"
                title="这是你的目标牌"
              >🎯</span>
            </div>
          </div>
        </div>

        <!-- 目标牌影响摘要 -->
        <div v-if="targetImpacts.length > 0" class="impact-summary">
          <div class="impact-title">📊 目标牌影响摘要</div>
          <div v-for="impact in targetImpacts" :key="impact.key" class="impact-row">
            <span class="impact-tile">{{ impact.label }}</span>
            <span class="impact-bar-wrap">
              <span
                class="impact-bar"
                :style="{ width: `${Math.min(impact.posteriorProb * 100 * 5, 100)}%` }"
                :class="impact.riskClass"
              ></span>
            </span>
            <span class="impact-desc" :class="impact.riskClass">{{ impact.desc }}</span>
          </div>
        </div>

        <!-- 整体建议 -->
        <div class="advice-row">
          <span class="advice-icon">💡</span>
          <span class="advice-text">{{ adviceText }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { bayesianUpdate } from '@/algorithms/bayesian'
import { analyzeOpponentHand } from '@/algorithms/discardReader'
import { formatTile } from '@/algorithms/deck'
import type { Tile, GameAction } from '@/types'

// 对手类型（与 gameStore 保持一致）
interface Opponent {
  id: number
  name: string
  hand: Tile[]
  melds: any[]
  river: Tile[]
  lastDiscard?: Tile
}

const props = defineProps<{
  opponents: Opponent[]
  history: GameAction[]
  targetTiles: Tile[]
  deckRemaining: number
}>()

// 折叠状态（默认展开）
const collapsed = ref(false)

// 判断是否有数据
const hasData = computed(() =>
  props.opponents.some(o => o.river.length > 0)
)

// 目标牌 key 集合（用于快速判断）
const targetKeySet = computed(() => {
  const s = new Set<string>()
  for (const t of props.targetTiles) {
    s.add(`${t.suit}_${t.number}`)
  }
  return s
})

// 每个对手的出牌分析
const opponentAnalyses = computed(() => {
  return props.opponents.map(opp => {
    // 过滤该对手的出牌记录
    const discardActions = props.history.filter(
      a => a.type === 'discard' && a.fromOpponent === opp.id && a.tile
    )

    const discards = discardActions.map(action => {
      const tile = action.tile!
      const key = `${tile.suit}_${tile.number}`
      const isTarget = targetKeySet.value.has(key)

      // 贝叶斯推断：该牌在对手手里的概率
      const bResult = bayesianUpdate(tile, { type: 'active', round: action.round })
      const prob = bResult.posteriorProb

      // 安全度分类
      let safetyClass = 'safe'
      if (action.round >= 9) safetyClass = 'danger'
      else if (action.round >= 4) safetyClass = 'warn'

      return {
        label: formatTile(tile),
        round: action.round,
        posteriorProb: prob,
        safetyClass,
        isTarget,
      }
    })

    // 调用读牌算法
    const pureDiscards = discardActions.map(a => a.tile!)
    const currentRound = props.history.length > 0 ? props.history[props.history.length - 1].round : 1
    const readResult = analyzeOpponentHand(pureDiscards, opp.melds, currentRound)

    // 提取高置信度推测和安全牌
    const highConfDeductions = readResult.deductions.filter(d => d.confidence >= 0.5)
    const safeTilesMap = new Map<string, string>()
    for (const d of highConfDeductions) {
      if (d.safeTiles) {
        for (const t of d.safeTiles) {
          const key = `${t.suit}_${t.number}`
          safeTilesMap.set(key, formatTile(t))
        }
      }
    }
    const safeTiles = Array.from(safeTilesMap.entries()).map(([k, label]) => ({ key: k, label }))

    return { id: opp.id, name: opp.name, discards, readResult, highConfDeductions, safeTiles }
  }).filter(opp => opp.discards.length > 0)
})

// 目标牌影响摘要（仅显示曾被对手打出过的目标牌）
const targetImpacts = computed(() => {
  const impacts: {
    key: string
    label: string
    posteriorProb: number
    riskClass: string
    desc: string
  }[] = []

  for (const t of props.targetTiles) {
    const key = `${t.suit}_${t.number}`
    const label = formatTile(t)

    // 找到所有对手中打出过该牌的记录
    const actions = props.history.filter(
      a => a.type === 'discard' && a.fromOpponent !== undefined && a.tile &&
        a.tile.suit === t.suit && a.tile.number === t.number
    )

    if (actions.length === 0) continue

    // 取最新的贝叶斯结果
    const latest = actions[actions.length - 1]
    const bResult = bayesianUpdate(t, { type: 'active', round: latest.round })
    const prob = bResult.posteriorProb

    let riskClass = 'impact-low'
    let desc = '✅ 影响很小'
    if (prob > 0.15) {
      riskClass = 'impact-high'
      desc = '⚠️ 注意竞争'
    } else if (prob > 0.05) {
      riskClass = 'impact-mid'
      desc = '🟡 略有影响'
    }

    impacts.push({ key, label, posteriorProb: prob, riskClass, desc })
  }

  return impacts
})

// 需要警告的牌
const safetyWarnings = computed(() =>
  targetImpacts.value.filter(i => i.riskClass !== 'impact-low')
)

// 整体建议文字
const adviceText = computed(() => {
  if (props.targetTiles.length === 0) return '尚未听牌，继续关注对手出牌规律'
  if (safetyWarnings.value.length === 0) return '对手出牌对你的目标牌影响较小，可继续等待'
  return `${safetyWarnings.value.map(w => w.label).join('、')} 受对手出牌影响，摸到概率略低，注意节奏`
})

function formatSuit(suit: string) {
  return { dot: '筒', bamboo: '条', char: '万', red_zhong: '红中' }[suit] || suit
}
</script>

<style scoped>
.bayesian-panel {
  background: var(--color-card);
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  overflow: hidden;
}

/* 标题栏 */
.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s;
}

.panel-header:hover {
  background: var(--color-card-hover);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-icon { font-size: 20px; }

.panel-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.warning-badge {
  font-size: 12px;
  background: rgba(254,202,87,0.2);
  color: var(--color-accent);
  border: 1px solid rgba(254,202,87,0.4);
  border-radius: 12px;
  padding: 2px 10px;
  font-weight: 700;
}

.collapse-icon {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* 面板体 */
.panel-body {
  padding: 12px 14px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty-state {
  font-size: 14px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 12px 0;
}

/* 对手卡片 */
.opponent-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--color-surface);
  border-radius: 8px;
  border: 1px solid var(--color-border);
}

.opp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.opp-name {
  font-size: 14px;
  color: var(--color-text);
  font-weight: 800;
}

.missing-suit-badge {
  font-size: 11px;
  background: rgba(255,107,107,0.1);
  color: var(--color-primary);
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 700;
}

/* 取消的倾向分析 CSS 可以移除或忽略 */

.opp-advice {
  font-size: 12px;
  color: var(--color-text-muted);
  background: rgba(0,0,0,0.15);
  padding: 6px 8px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.4;
}

.opp-tiles {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

/* 高阶推测 */
.opp-deductions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  padding: 8px;
}

.deduction-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.deduction-rule {
  font-weight: 800;
  color: var(--color-accent);
  font-family: 'JetBrains Mono', monospace;
  background: rgba(254, 202, 87, 0.15);
  padding: 1px 4px;
  border-radius: 4px;
}

.deduction-desc {
  color: var(--color-text);
  flex: 1;
}

.deduction-conf {
  font-weight: 700;
  color: var(--color-success);
  font-family: 'JetBrains Mono', monospace;
}

/* 安全牌区域 */
.safe-tiles-area {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  background: rgba(72, 219, 251, 0.1);
  border: 1px solid rgba(72, 219, 251, 0.3);
  padding: 6px 10px;
  border-radius: 6px;
}

.safe-badge {
  font-size: 12px;
  font-weight: 800;
  color: #48dbfb;
}

.safe-tiles-row {
  display: flex;
  gap: 6px;
}

.safe-tile-label {
  font-size: 12px;
  font-weight: 700;
  background: var(--color-success);
  color: #0f0f1a;
  padding: 2px 8px;
  border-radius: 4px;
}

/* 出牌标签 */
.tile-entry {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.tile-entry.safe {
  background: rgba(72,219,251,0.08);
  border-color: rgba(72,219,251,0.2);
  color: var(--color-success);
}

.tile-entry.warn {
  background: rgba(254,202,87,0.08);
  border-color: rgba(254,202,87,0.25);
  color: var(--color-accent);
}

.tile-entry.danger {
  background: rgba(255,107,107,0.08);
  border-color: rgba(255,107,107,0.25);
  color: var(--color-primary);
}

.tile-label { font-weight: 700; }
.tile-round { font-size: 11px; opacity: 0.7; font-family: 'JetBrains Mono', monospace; }
.target-mark { font-size: 12px; }

/* 目标牌影响摘要 */
.impact-summary {
  background: var(--color-surface);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.impact-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-muted);
  letter-spacing: 1px;
  text-transform: uppercase;
  margin-bottom: 4px;
}

.impact-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.impact-tile {
  font-size: 14px;
  font-weight: 800;
  color: var(--color-text);
  min-width: 36px;
}

.impact-bar-wrap {
  flex: 1;
  height: 6px;
  background: rgba(255,255,255,0.05);
  border-radius: 3px;
  overflow: hidden;
}

.impact-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease;
}

.impact-bar.impact-low { background: var(--color-success); }
.impact-bar.impact-mid { background: var(--color-accent); }
.impact-bar.impact-high { background: var(--color-primary); }

.impact-desc {
  font-size: 12px;
  font-weight: 700;
  min-width: 72px;
  text-align: right;
}

.impact-desc.impact-low { color: var(--color-success); }
.impact-desc.impact-mid { color: var(--color-accent); }
.impact-desc.impact-high { color: var(--color-primary); }

/* 建议行 */
.advice-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: rgba(99,102,241,0.06);
  border: 1px solid rgba(99,102,241,0.15);
  border-radius: 8px;
}

.advice-icon { font-size: 16px; flex-shrink: 0; }

.advice-text {
  font-size: 14px;
  color: var(--color-text);
  line-height: 1.6;
  font-weight: 500;
}
</style>
