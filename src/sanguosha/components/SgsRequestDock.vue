<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SgsCard from './SgsCard.vue'
import { getCharacter } from '../data/characters/standard'
import type { GameRequest, GameResponse } from '../engine/requests'
import type { PlayerView } from '../engine/view'
import type { PhysicalCard } from '../engine/types'

/**
 * 所有需要真人做决定的地方，统一在底部这一条里出现。
 *
 * **12 种 Request 每一种都必须有真正能点的入口。**
 * 参考项目踩过的坑就是「服务端支持某种 ask，前端却没有交互」——
 * 那样的规则等于没实现。下面的 v-if 链覆盖了全部 kind，
 * 缺任何一种都会走到最后的兜底分支并显式报出来，而不是静默卡住。
 */

const props = defineProps<{ request: GameRequest; view: PlayerView }>()
const emit = defineEmits<{ submit: [response: GameResponse] }>()

const selectedCards = ref<string[]>([])
const selectedTargets = ref<string[]>([])
const topCards = ref<string[]>([])
const bottomCards = ref<string[]>([])

// 换了一个请求就把上一次的选择清掉，避免把旧选择提交给新请求
watch(() => props.request.id, () => {
  selectedCards.value = []
  selectedTargets.value = []
  topCards.value = []
  bottomCards.value = props.request.kind === 'arrange-cards' ? [...props.request.cardIds] : []
}, { immediate: true })

const me = computed(() => props.view.players.find((player) => player.id === props.view.viewerId))

/** 把 cardId 还原成牌面；暗槽（hidden:*）没有牌面，返回 null 走牌背。 */
function cardOf(cardId: string): PhysicalCard | null {
  if (cardId.startsWith('hidden:')) return null
  const pool: PhysicalCard[] = [
    ...(me.value?.hand ?? []),
    ...props.view.requestCards,
    ...props.view.processingArea,
    ...props.view.discardPile,
    ...props.view.players.flatMap((player) => [...player.equipment, ...player.judgingArea]),
  ]
  return pool.find((card) => card.id === cardId) ?? null
}

/** 多选切换；超过上限时挤掉最早选的那张。 */
function toggleIn(list: string[], value: string, max: number): string[] {
  const index = list.indexOf(value)
  if (index >= 0) return list.filter((entry) => entry !== value)
  const next = list.length >= max ? list.slice(1) : [...list]
  return [...next, value]
}

function toggleCard(value: string, max: number): void { selectedCards.value = toggleIn(selectedCards.value, value, max) }
function toggleTarget(value: string, max: number): void { selectedTargets.value = toggleIn(selectedTargets.value, value, max) }

const cardRequest = computed(() => (props.request.kind === 'choose-cards' ? props.request : null))
const cardChoices = computed(() => {
  const request = cardRequest.value
  if (!request) return []
  return [...request.cardIds, ...request.hiddenCardSlots]
})
const cardCountOk = computed(() => {
  const request = cardRequest.value
  if (!request) return false
  return selectedCards.value.length >= request.min && selectedCards.value.length <= request.max
})

const targetRequest = computed(() => (props.request.kind === 'choose-targets' ? props.request : null))
const targetCountOk = computed(() => {
  const request = targetRequest.value
  if (!request) return false
  return selectedTargets.value.length >= request.min && selectedTargets.value.length <= request.max
})

const arrangeRequest = computed(() => (props.request.kind === 'arrange-cards' ? props.request : null))
const arrangeOk = computed(() => {
  const request = arrangeRequest.value
  if (!request) return false
  return topCards.value.length >= request.minTop
    && topCards.value.length <= request.maxTop
    && topCards.value.length + bottomCards.value.length === request.cardIds.length
})

function moveArrange(cardId: string, destination: 'top' | 'bottom'): void {
  if (destination === 'top') {
    const request = arrangeRequest.value
    if (!request || topCards.value.length >= request.maxTop) return
    bottomCards.value = bottomCards.value.filter((id) => id !== cardId)
    if (!topCards.value.includes(cardId)) topCards.value.push(cardId)
    return
  }
  topCards.value = topCards.value.filter((id) => id !== cardId)
  if (!bottomCards.value.includes(cardId)) bottomCards.value.push(cardId)
}

function shiftArrange(list: 'top' | 'bottom', cardId: string, offset: -1 | 1): void {
  const target = list === 'top' ? topCards.value : bottomCards.value
  const index = target.indexOf(cardId)
  const next = index + offset
  if (index < 0 || next < 0 || next >= target.length) return
  ;[target[index], target[next]] = [target[next], target[index]]
}

// v-for 表达式里的窄化不可靠，这些请求单独收成 computed
const numberChoices = computed(() => {
  if (props.request.kind !== 'choose-number') return []
  const request = props.request
  return Array.from({ length: request.max - request.min + 1 }, (_, index) => request.min + index)
})

const SUIT_TEXT: Record<string, string> = { heart: '♥ 红桃', diamond: '♦ 方块', spade: '♠ 黑桃', club: '♣ 梅花' }
const SUIT_MARK: Record<string, string> = { heart: '♥', diamond: '♦', spade: '♠', club: '♣' }
const RANK_MARK: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }
function rankText(rank: number): string { return RANK_MARK[rank] ?? String(rank) }

function actionLabel(actionId: string): string {
  if (actionId === 'respond-pass') return '放弃'
  if (actionId === 'rescue-pass') return '不救'
  if (actionId === 'invoke-bagua') return '发动【八卦阵】'
  // 卡牌 id 本身含冒号（ruleset-v1:standard:57），只能按第一个冒号切
  const separator = actionId.indexOf(':')
  const cardId = separator >= 0 ? actionId.slice(separator + 1) : ''
  const card = cardId ? cardOf(cardId) : null
  if (card) return `打出【${card.name}】${SUIT_MARK[card.suit] ?? ''}${rankText(card.rank)}`
  return actionId.startsWith('skill:') ? '发动技能' : '使用'
}

function submit(payload: Record<string, unknown>): void {
  emit('submit', { requestId: props.request.id, playerId: props.request.playerId, payload })
}

function nicknameOf(playerId: string): string {
  const player = props.view.players.find((candidate) => candidate.id === playerId)
  const character = player?.characterId ? getCharacter(player.characterId) : undefined
  return character ? `${player!.nickname}（${character.name}）` : player?.nickname ?? playerId
}
</script>

<template>
  <section class="sgs-dock" role="group" :aria-label="request.prompt">
    <p class="sgs-dock__prompt">{{ request.prompt }}</p>

    <!-- 选将 -->
    <template v-if="request.kind === 'choose-general'">
      <div class="sgs-dock__generals">
        <button
          v-for="candidate in request.candidates"
          :key="candidate"
          type="button"
          class="sgs-dock__general"
          @click="submit({ characterId: candidate })"
        >
          <strong>{{ getCharacter(candidate)?.name ?? candidate }}</strong>
          <small>体力 {{ getCharacter(candidate)?.maxHp }}</small>
          <span v-for="skill in getCharacter(candidate)?.skills ?? []" :key="skill.id">
            【{{ skill.name }}】{{ skill.description }}
          </span>
        </button>
      </div>
    </template>

    <!-- 选牌：暗槽只显示牌背，绝不泄露牌面 -->
    <template v-else-if="request.kind === 'choose-cards'">
      <div class="sgs-dock__cards">
        <SgsCard
          v-for="(cardId, index) in cardChoices"
          :key="cardId"
          :card="cardOf(cardId)"
          :back-index="cardOf(cardId) ? null : index"
          :selected="selectedCards.includes(cardId)"
          @click="toggleCard(cardId, request.max)"
        />
      </div>
      <div class="sgs-dock__actions">
        <span class="sgs-dock__count">已选 {{ selectedCards.length }} / {{ request.max }}</span>
        <button v-if="cardRequest && cardRequest.min === 0" type="button" class="ghost" @click="submit({ cardIds: [] })">跳过</button>
        <button type="button" class="primary" :disabled="!cardCountOk" @click="submit({ cardIds: [...selectedCards] })">确定</button>
      </div>
    </template>

    <!-- 选目标 -->
    <template v-else-if="request.kind === 'choose-targets'">
      <div class="sgs-dock__targets">
        <button
          v-for="candidate in request.candidateIds"
          :key="candidate"
          type="button"
          class="sgs-dock__target"
          :class="{ selected: selectedTargets.includes(candidate) }"
          @click="toggleTarget(candidate, request.max)"
        >{{ nicknameOf(candidate) }}</button>
      </div>
      <div class="sgs-dock__actions">
        <button type="button" class="primary" :disabled="!targetCountOk" @click="submit({ targetIds: [...selectedTargets] })">确定</button>
      </div>
    </template>

    <!-- 选项 -->
    <template v-else-if="request.kind === 'choose-option'">
      <div class="sgs-dock__actions">
        <button
          v-for="option in request.options"
          :key="option.id"
          type="button"
          class="primary"
          @click="submit({ optionId: option.id })"
        >{{ option.label }}</button>
      </div>
    </template>

    <!-- 选花色 -->
    <template v-else-if="request.kind === 'choose-suit'">
      <div class="sgs-dock__actions">
        <button
          v-for="suit in request.suits"
          :key="suit"
          type="button"
          class="primary"
          :class="{ red: suit === 'heart' || suit === 'diamond' }"
          @click="submit({ suit })"
        >{{ SUIT_TEXT[suit] ?? suit }}</button>
      </div>
    </template>

    <!-- 选数字 -->
    <template v-else-if="request.kind === 'choose-number'">
      <div class="sgs-dock__actions">
        <button
          v-for="value in numberChoices""
          :key="value"
          type="button"
          class="primary"
          @click="submit({ number: value })"
        >{{ value }}</button>
      </div>
    </template>

    <!-- 打出牌 / 使用牌 / 发动技能 / 濒死救援：都是从 actionIds 里挑一个 -->
    <template v-else-if="request.kind === 'respond-card' || request.kind === 'use-card' || request.kind === 'invoke-skill' || request.kind === 'rescue'">
      <div class="sgs-dock__actions sgs-dock__actions--wrap">
        <button
          v-for="actionId in request.actionIds"
          :key="actionId"
          type="button"
          :class="actionId.endsWith('-pass') ? 'ghost' : 'primary'"
          @click="submit({ actionId })"
        >{{ actionLabel(actionId) }}</button>
      </div>
    </template>

    <!-- 排列牌堆：观星类，上下两栏都要能放 -->
    <template v-else-if="request.kind === 'arrange-cards'">
      <!-- 「点牌面换栏、←→ 同栏调序」不写出来没人猜得到：
           界面上只有 ←→ 是看得见的按钮，玩家会以为那就是上下移动 -->
      <p class="sgs-dock__hint">点牌面在牌堆顶 / 牌堆底之间移动，用 ← → 调整同一栏内的顺序</p>
      <div class="sgs-dock__arrange">
        <div>
          <small>牌堆顶（{{ topCards.length }} / {{ request.maxTop }}）</small>
          <div class="sgs-dock__cards">
            <div v-for="cardId in topCards" :key="cardId" class="sgs-dock__arrange-card">
              <SgsCard :card="cardOf(cardId)" title="移到牌堆底" @click="moveArrange(cardId, 'bottom')" />
              <span><button type="button" aria-label="向前移" @click="shiftArrange('top', cardId, -1)">←</button><button type="button" aria-label="向后移" @click="shiftArrange('top', cardId, 1)">→</button></span>
            </div>
          </div>
        </div>
        <div>
          <small>{{ request.allowBottom ? '牌堆底' : '未选' }}</small>
          <div class="sgs-dock__cards">
            <div v-for="cardId in bottomCards" :key="cardId" class="sgs-dock__arrange-card">
              <SgsCard :card="cardOf(cardId)" title="移到牌堆顶" @click="moveArrange(cardId, 'top')" />
              <span><button type="button" aria-label="向前移" @click="shiftArrange('bottom', cardId, -1)">←</button><button type="button" aria-label="向后移" @click="shiftArrange('bottom', cardId, 1)">→</button></span>
            </div>
          </div>
        </div>
      </div>
      <div class="sgs-dock__actions">
        <button
          type="button"
          class="primary"
          :disabled="!arrangeOk"
          @click="submit({ top: [...topCards], bottom: request.allowBottom ? [...bottomCards] : [] })"
        >确定</button>
      </div>
    </template>

    <!-- 分配牌：每张牌各自选一个接收者 -->
    <template v-else-if="request.kind === 'distribute-cards'">
      <div class="sgs-dock__distribute">
        <div v-for="cardId in request.cardIds" :key="cardId" class="sgs-dock__row">
          <SgsCard :card="cardOf(cardId)" compact disabled />
          <button
            v-for="recipient in request.recipientIds"
            :key="recipient"
            type="button"
            class="sgs-dock__target"
            :class="{ selected: selectedCards.includes(`${cardId}|${recipient}`) }"
            @click="selectedCards = [...selectedCards.filter((entry) => !entry.startsWith(`${cardId}|`)), `${cardId}|${recipient}`]"
          >{{ nicknameOf(recipient) }}</button>
        </div>
      </div>
      <div class="sgs-dock__actions">
        <button
          type="button"
          class="primary"
          :disabled="selectedCards.length < request.min"
          @click="submit({ assignments: selectedCards.map((entry) => ({ cardId: entry.split('|')[0], recipientId: entry.split('|')[1] })) })"
        >确定</button>
      </div>
    </template>

    <!-- 兜底：新增了 Request 类型但忘了做界面时，明确报出来而不是静默卡住 -->
    <template v-else>
      <p class="sgs-dock__missing">这个请求还没有对应界面（{{ (request as GameRequest).kind }}），请反馈这条信息。</p>
    </template>
  </section>
</template>

<style scoped>
.sgs-dock {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 11px calc(9px + env(safe-area-inset-bottom));
  border-top: 1px solid #46402c;
  background: linear-gradient(180deg, rgba(24, 34, 28, .97), rgba(12, 20, 16, .99));
}
.sgs-dock__prompt { margin: 0; color: #e9d9a6; font-size: 13px; font-weight: 700; }
.sgs-dock__hint { margin: 0; color: #93a49b; font-size: 11px; line-height: 1.5; }
.sgs-dock__cards { display: flex; flex-wrap: wrap; gap: 5px; max-height: 30vh; overflow-y: auto; }
.sgs-dock__actions { display: flex; align-items: center; gap: 8px; }
.sgs-dock__actions--wrap { flex-wrap: wrap; }
.sgs-dock__count { margin-right: auto; color: #8fa199; font-size: 11px; }

button { min-height: 40px; padding: 0 14px; border-radius: 9px; cursor: pointer; font: inherit; font-weight: 700; }
.primary { border: 1px solid #9e7f3c; background: linear-gradient(180deg, #6d5527, #4c3b1a); color: #ffe6a8; }
.primary:disabled { opacity: .45; cursor: default; }
.primary.red { color: #ffb9ae; border-color: #9c4a41; background: linear-gradient(180deg, #6d2f29, #4a1f1b); }
.ghost { border: 1px solid #3f4d45; background: #16241e; color: #b9c5bd; }

.sgs-dock__generals { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 3px; }
.sgs-dock__general {
  flex: 0 0 auto; width: 176px; min-height: 0; padding: 9px 10px;
  display: flex; flex-direction: column; gap: 3px; text-align: left;
  border: 1px solid #55492e; border-radius: 11px; background: #1b241d; color: #ded4b8;
}
.sgs-dock__general:hover { border-color: #d3b463; }
.sgs-dock__general strong { color: #f0d68d; font-size: 15px; }
.sgs-dock__general small { color: #8f9b90; font-size: 10px; }
.sgs-dock__general span { color: #a9b5a9; font-size: 10px; line-height: 1.5; }

.sgs-dock__targets, .sgs-dock__distribute { display: flex; flex-wrap: wrap; gap: 6px; }
.sgs-dock__row { display: flex; align-items: center; gap: 5px; width: 100%; }
.sgs-dock__target {
  min-height: 34px; padding: 0 10px; border: 1px solid #3f4d45; border-radius: 8px;
  background: #16241e; color: #cbd6cd; font-size: 12px;
}
.sgs-dock__target.selected { border-color: #cf5a4c; background: #3a201d; color: #ffbdb4; }

.sgs-dock__arrange { display: grid; gap: 6px; }
.sgs-dock__arrange small { color: #8fa199; font-size: 10px; }
.sgs-dock__arrange-card { flex: 0 0 auto; display: grid; justify-items: center; gap: 2px; }
.sgs-dock__arrange-card > span { display: flex; gap: 2px; }
.sgs-dock__arrange-card > span button {
  min-height: 24px; padding: 0 7px; border: 1px solid #3f4d45; border-radius: 6px;
  background: #16241e; color: #cbd6cd; font-size: 11px;
}
.sgs-dock__missing { margin: 0; color: #e9948a; font-size: 12px; }

@media (orientation: landscape) and (max-height: 500px) {
  .sgs-dock { padding: 6px 10px calc(6px + env(safe-area-inset-bottom)); gap: 5px; }
  .sgs-dock__cards { max-height: 22vh; }
  button { min-height: 34px; }
  .sgs-dock__general { width: 150px; padding: 6px 8px; }
}
</style>
