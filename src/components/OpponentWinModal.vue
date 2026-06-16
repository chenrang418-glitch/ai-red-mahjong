<template>
  <transition name="modal-fade">
    <div v-if="visible" class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-content">
        <!-- 胡牌头部 -->
        <div class="win-header">
          <div class="win-icon">{{ data.isSelfDraw ? '🎊' : '💥' }}</div>
          <div class="win-title">
            {{ opponentName }} {{ data.isSelfDraw ? '自摸胡牌！' : '胡牌！' }}
          </div>
          <div class="win-subtitle">
            {{ data.isSelfDraw ? '摸到目标牌，自摸成功' : '点炮胡牌' }}
            <span v-if="scoringInfo && !scoringInfo.hasRedZhong" class="no-zhong-badge">
              无红中 +2马
            </span>
          </div>
        </div>

        <!-- 副露展示 -->
        <div v-if="melds.length > 0" class="melds-area">
          <div class="area-label">副露</div>
          <div class="melds-row">
            <div v-for="(meld, i) in melds" :key="i" class="meld-group">
              <span class="meld-type-tag" :class="meld.type">
                {{ meldLabel(meld.type) }}
              </span>
              <div class="meld-tiles-row">
                <TileView
                  v-for="j in getMeldTileCount(meld.type)"
                  :key="j"
                  :tile="meld.tile"
                  mini
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 手牌展示 -->
        <div class="hand-area">
          <div class="area-label">手牌</div>
          <div class="hand-tiles-row">
            <TileView
              v-for="tile in data.tiles"
              :key="tile.id"
              :tile="tile"
            />
          </div>
        </div>

        <!-- 抓马展示与记分总计（仅记分模式） -->
        <div v-if="scoringInfo" class="bonus-area">
          <template v-if="scoringInfo.bonusDrawTiles && scoringInfo.bonusDrawTiles.length > 0">
            <div class="area-label">
              🐴 抓马
              <span class="bonus-count">共 {{ scoringInfo?.bonusDrawCount }} 个</span>
              <span v-if="scoringInfo?.streak && scoringInfo.streak > 1" class="streak-badge">
                🔥 {{ scoringInfo.streak }}连胜
              </span>
            </div>
            <div class="bonus-tiles-row">
              <div
                v-for="(tile, i) in scoringInfo.bonusDrawTiles"
                :key="i"
                class="bonus-tile-wrap"
                :class="{ hit: isHitTile(tile) }"
              >
                <TileView :tile="tile" />
                <span v-if="isHitTile(tile)" class="hit-badge">+{{ getHitTileScore(tile) }}</span>
              </div>
            </div>
          </template>
          <template v-else>
            <div class="area-label">
              🐴 无马可抓（牌堆已空）
            </div>
          </template>
          <!-- 胡牌类型（红中杠麻专用） -->
          <div v-if="scoringInfo?.huTypeName" class="hu-type-badge">
            {{ scoringInfo.huTypeName }}
            <span v-if="scoringInfo?.scoreMultiplier && scoringInfo.scoreMultiplier > 1" class="multiplier">×{{ scoringInfo.scoreMultiplier }}</span>
          </div>

          <!-- 得分总计 -->
          <div class="score-summary">
            <!-- 红中杠麻计分 -->
            <template v-if="scoringInfo?.baseScore !== undefined">
              <div class="score-line">
                <span class="score-label">底分</span>
                <span class="score-val">{{ scoringInfo?.baseScore }}</span>
              </div>
              <div class="score-line">
                <span class="score-label">抓马得分</span>
                <span class="score-val hit">+{{ scoringInfo?.bonusScore }}</span>
              </div>
              <div v-if="scoringInfo?.redZhongBonus && scoringInfo.redZhongBonus > 0" class="score-line">
                <span class="score-label">红中加成 ({{ scoringInfo?.redZhongCount }}个)</span>
                <span class="score-val hit">+{{ scoringInfo?.redZhongBonus }}</span>
              </div>
            </template>
            <!-- 传统红中麻将计分 -->
            <template v-else>
              <div class="score-line">
                <span class="score-label">底分</span>
                <span class="score-val">10</span>
              </div>
              <div v-if="scoringInfo?.hitCount !== undefined && scoringInfo.hitCount > 0" class="score-line">
                <span class="score-label">命中 {{ scoringInfo?.hitCount }} 马</span>
                <span class="score-val hit">+{{ (scoringInfo?.hitCount || 0) * 10 }}</span>
              </div>
            </template>
            <div class="score-line total">
              <span class="score-label">单家扣分</span>
              <span class="score-val">{{ scoringInfo?.winnerTotal ? Math.floor(scoringInfo.winnerTotal / 3) : 0 }}</span>
            </div>
            <div class="score-line total winner">
              <span class="score-label">赢家总得</span>
              <span class="score-val big">+{{ scoringInfo?.winnerTotal || 0 }}</span>
            </div>
          </div>
        </div>

        <!-- 控制按钮组 -->
        <div class="modal-actions-row">
          <button class="close-btn replay-ai-btn" @click="$emit('request-god-view')">
            🤖 AI 上帝复盘
          </button>
          <button class="close-btn" @click="$emit('close')">
            确认
          </button>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import type { Tile, Meld } from '@/types'
import { TileSuit } from '@/types'
import TileView from './TileView.vue'

const props = defineProps<{
  visible: boolean
  data: {
    opponentId: number
    tiles: Tile[]
    isSelfDraw: boolean
  }
  opponentName: string
  melds: Meld[]
  scoringInfo?: {
    bonusDrawCount: number
    bonusDrawTiles: Tile[]
    hitCount: number
    hasRedZhong: boolean
    winnerTotal: number
    streak: number
    // 红中杠麻扩展字段
    huType?: string
    huTypeName?: string
    redZhongCount?: number
    scoreMultiplier?: number
    baseScore?: number
    bonusScore?: number
    redZhongBonus?: number
  }
}>()

defineEmits<{
  close: []
  'request-god-view': []
}>()

function meldLabel(type: string): string {
  return { pong: '碰', exposed_gang: '明杠', concealed_gang: '暗杠', red_zhong_gang: '红中杠' }[type] || type
}

function getMeldTileCount(type: string): number {
  if (type === 'red_zhong_gang') return 1
  if (type === 'concealed_gang') return 4
  return 3
}

function isHitTile(tile: Tile): boolean {
  if (props.scoringInfo?.huType) {
    // 红中杠麻模式：一码全中（非红中）
    return tile.suit !== TileSuit.RED_ZHONG
  }
  // 传统红中模式：1、5、9、红中为马
  if (tile.suit === TileSuit.RED_ZHONG) return true
  if (tile.number === 1 || tile.number === 5 || tile.number === 9) return true
  return false
}

function getHitTileScore(tile: Tile): number {
  if (props.scoringInfo?.huType) {
    if (tile.suit === TileSuit.RED_ZHONG || tile.number === null) return 0
    let base = 0
    switch (tile.number) {
      case 1: base = 100; break
      case 2: base = 20; break
      case 3: base = 30; break
      default: base = tile.number * 10; break
    }
    return base * (props.scoringInfo.scoreMultiplier || 1)
  }
  return 10
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-content {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 16px;
  padding: 28px;
  min-width: 420px;
  max-width: 640px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: modal-pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes modal-pop {
  from { opacity: 0; transform: scale(0.85) translateY(20px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* 胡牌头部 */
.win-header { text-align: center; }

.win-icon {
  font-size: 44px;
  margin-bottom: 6px;
  animation: bounce 0.6s ease-in-out;
}

@keyframes bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-12px); }
}

.win-title {
  font-size: 20px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--color-primary), var(--color-gold));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.win-subtitle {
  font-size: 13px;
  color: var(--color-text-muted);
  margin-top: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.no-zhong-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent);
  background: rgba(247, 201, 72, 0.12);
  padding: 2px 8px;
  border-radius: 8px;
}

/* 区域标签 */
.area-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--color-text-muted);
  letter-spacing: 1.2px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.bonus-count {
  font-size: 11px;
  color: var(--color-accent);
  font-weight: 600;
}

.streak-badge {
  font-size: 11px;
  font-weight: 700;
  color: #ff6b6b;
  background: rgba(255, 107, 107, 0.12);
  padding: 1px 8px;
  border-radius: 8px;
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* 副露 */
.melds-area, .hand-area, .bonus-area {
  padding: 10px 14px;
  background: var(--color-card);
  border-radius: 10px;
  border: 1px solid var(--color-border);
}

.melds-row { display: flex; flex-wrap: wrap; gap: 10px; }

.meld-group { display: flex; flex-direction: column; gap: 3px; }

.meld-type-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  text-align: center;
  font-weight: 600;
}

.meld-type-tag.pong { background: var(--color-success); color: #0f0f1a; }
.meld-type-tag.exposed_gang { background: var(--color-accent); color: #1a1a2e; }
.meld-type-tag.concealed_gang { background: var(--color-primary); color: #fff; }

.meld-tiles-row { display: flex; gap: 2px; }

/* 手牌 */
.hand-tiles-row {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  justify-content: center;
}

/* 抓马 */
.bonus-area {
  border-color: rgba(247, 201, 72, 0.3);
  background: rgba(247, 201, 72, 0.04);
}

.bonus-tiles-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-bottom: 10px;
}

.bonus-tile-wrap {
  position: relative;
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 2px;
  transition: all 0.2s;
}

.bonus-tile-wrap.hit {
  border-color: var(--color-gold);
  background: rgba(247, 201, 72, 0.1);
  box-shadow: 0 0 12px rgba(247, 201, 72, 0.3);
}

.hit-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  font-size: 10px;
  font-weight: 800;
  color: #fff;
  background: var(--color-gold);
  padding: 1px 5px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

/* 胡牌类型徽章 */
.hu-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: linear-gradient(135deg, rgba(247,201,72,0.2), rgba(255,94,94,0.1));
  border: 1px solid rgba(247,201,72,0.3);
  border-radius: 20px;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-accent);
  margin-bottom: 10px;
}

.hu-type-badge .multiplier {
  font-size: 16px;
  color: var(--color-primary);
}

/* 得分汇总 */
.score-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-border);
}

.score-line {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.score-label { color: var(--color-text-muted); }

.score-val {
  font-weight: 700;
  font-family: 'JetBrains Mono', monospace;
  color: var(--color-text);
}

.score-val.hit { color: var(--color-gold); }

.score-line.total {
  padding-top: 4px;
  border-top: 1px solid var(--color-border);
}

.score-line.winner .score-label {
  font-weight: 700;
  color: var(--color-text);
}

.score-val.big {
  font-size: 20px;
  font-weight: 800;
  color: var(--color-success);
}

/* 控制按钮组 */
.modal-actions-row {
  display: flex;
  justify-content: center;
  gap: 16px;
  width: 100%;
  margin-top: 8px;
}

.close-btn {
  padding: 12px 28px;
  font-size: 15px;
  font-weight: 700;
  border: none;
  border-radius: 10px;
  background: var(--color-border-light);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  align-self: center;
}

.close-btn:hover {
  background: var(--color-border);
  color: var(--color-text);
  transform: translateY(-2px);
}

.replay-ai-btn {
  background: linear-gradient(135deg, #8b5cf6, #ec4899);
  color: #fff;
  box-shadow: 0 4px 16px rgba(139, 92, 246, 0.35);
  position: relative;
  overflow: hidden;
}

.replay-ai-btn:hover {
  background: linear-gradient(135deg, #9b6bf7, #f45fa9);
  transform: translateY(-2px) scale(1.03);
  box-shadow: 0 8px 24px rgba(139, 92, 246, 0.5), 0 0 12px rgba(236, 72, 153, 0.3);
}

.replay-ai-btn::after {
  content: '';
  position: absolute;
  top: -50%; left: -50%;
  width: 200%; height: 200%;
  background: linear-gradient(to right, transparent, rgba(255,255,255,0.15), transparent);
  transform: rotate(30deg);
  animation: shine 3s infinite;
}

@keyframes shine {
  0% { transform: translate(-30%, -30%) rotate(30deg); }
  100% { transform: translate(130%, 130%) rotate(30deg); }
}

/* 过渡动画 */
.modal-fade-enter-active,
.modal-fade-leave-active { transition: opacity 0.3s ease; }
.modal-fade-enter-from,
.modal-fade-leave-to { opacity: 0; }

@media (max-width: 480px) {
  .modal-content { min-width: auto; margin: 16px; padding: 16px; }
}
</style>
