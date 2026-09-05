<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import SgsTable from './components/SgsTable.vue'
import SgsRequestDock from './components/SgsRequestDock.vue'
import SgsOnlineHub from './components/SgsOnlineHub.vue'
import SgsGlossarySheet from './components/SgsGlossarySheet.vue'
import SgsArtGallery from './components/SgsArtGallery.vue'
import SgsAudioControl from './components/SgsAudioControl.vue'
import SgsResultDialog from './components/SgsResultDialog.vue'
import { useLocalSanguosha } from './composables/useLocalSanguosha'
import { provideSgsGlossary } from './composables/useSgsGlossary'
import { useScreenWakeLock } from './composables/useScreenWakeLock'
import { ALL_CHARACTERS } from './data/characters/standard'
import { CARD_INFO_SECTIONS } from './data/ruleset-v1/card-info'
import type { GameResponse } from './engine/requests'
import type { AIDifficulty } from './ai'
import { AI_PACE_MS } from './shared/timing'
import { FACTION_CONFIG, FACTION_ORDER } from './shared/factions'
import SgsHomePortrait from './components/SgsHomePortrait.vue'

defineEmits<{ backToPortal: [] }>()

type Screen = 'home' | 'setup' | 'online' | 'playing' | 'rules' | 'art'

const screen = ref<Screen>(new URLSearchParams(window.location.search).has('room') ? 'online' : 'home')
// 单机选将/对局和整个联机流程（含房间等人）都保持屏幕常亮；返回首页立即释放。
useScreenWakeLock(computed(() => screen.value === 'playing' || screen.value === 'online'))
const audioOpen = ref(false)
/** 艺术集从首页和规则页都进得去，返回键要回到来时那一屏。 */
const artBackTo = ref<Screen>('home')
function openArt(from: Screen): void {
  artBackTo.value = from
  screen.value = 'art'
}
const game = useLocalSanguosha()
const glossary = provideSgsGlossary()
type AIPace = 'fast' | 'normal' | 'relaxed'
const config = reactive({ playerCount: 5, difficulty: 'normal' as AIDifficulty, aiPace: 'normal' as AIPace })
/**
 * 真实出牌保留可读停顿；无牌可出、唯一选项和纯阶段推进由驱动层单独加速。
 */
const AI_PACE_LABEL: Record<AIPace, string> = { fast: '较快', normal: '标准', relaxed: '悠闲' }

const DIFFICULTY_LABEL: Record<AIDifficulty, string> = { easy: '简单', normal: '标准', hard: '困难' }
// 每人的候选互不重叠，所以人数不能超过已实现的武将数
const maxPlayers = computed(() => Math.min(8, ALL_CHARACTERS.length))
const playerCounts = computed(() => [5, 6, 7, 8].filter((count) => count <= maxPlayers.value))

const result = computed(() => game.view.value?.result ?? null)
const choosingGeneral = computed(() => game.view.value?.status === 'choosing-general')
const selfSelectOpen = ref(false)
const characterGroups = computed(() => FACTION_ORDER.map((kingdom) => ({
  kingdom,
  ...FACTION_CONFIG[kingdom],
  characters: ALL_CHARACTERS.filter((character) => character.kingdom === kingdom),
})))



function startMatch(): void {
  selfSelectOpen.value = false
  game.start({ playerCount: config.playerCount, difficulty: config.difficulty, aiDelayMs: AI_PACE_MS[config.aiPace] })
  screen.value = 'playing'
}

function backFromGeneralPick(): void {
  game.abandon()
  selfSelectOpen.value = false
  screen.value = 'setup'
}

const exitConfirmOpen = ref(false)

/** 牌桌上的返回键先问一次——误点一下就把整局丢掉太亏。 */
function requestExit(): void {
  if (game.view.value && !result.value) { exitConfirmOpen.value = true; return }
  quit()
}

function quit(): void {
  exitConfirmOpen.value = false
  game.abandon()
  screen.value = 'home'
}

/** 结算界面直接再开一局，不用退回首页重设一遍。 */
function playAgain(): void {
  game.abandon()
  startMatch()
}

function handleRespond(response: GameResponse): void {
  // 选将结束后的开局由 useLocalSanguosha 驱动，组件不插手——
  // 之前在这里抢着调 beginPlaying，AI 还没选完就触发了「还有玩家没有选将」。
  game.respond(response)
}
</script>

<template>
  <SgsTable
    v-if="screen === 'playing' && game.view.value && !choosingGeneral"
    :view="game.view.value"
    :request="game.myRequest.value"
    :legal-actions="game.legalActions.value"
    :busy="game.busy.value"
    :log="game.log.value"
    :presentation-events="game.presentationEvents.value"
    @act="game.act"
    @respond="handleRespond"
    @quit="requestExit"
  />

  <SgsOnlineHub v-else-if="screen === 'online'" @back="screen = 'home'" />

  <main v-else class="sgs-app">
    <section v-if="screen === 'home'" class="sgs-home">
      <header>
        <button type="button" @click="$emit('backToPortal')">← 返回游戏中心</button>
        <span>CRPLAY · 纸上三国</span>
        <div class="sgs-home__tools">
          <button type="button" class="sgs-home__art" @click="openArt('home')">艺术集</button>
          <SgsAudioControl v-model:open="audioOpen" />
        </div>
      </header>
      <div class="sgs-home__hero">
        <div class="sgs-home__copy">
          <p class="sgs-home__eyebrow"><span></span> 经典身份局 · 群雄共赴</p>
          <h1>纸上三国</h1>
          <h2>方寸之间，风云再起。</h2>
          <small>以谋略会友，以手牌决胜。<br>选一名武将，开启属于你的三国。</small>
          <div class="sgs-home__stats"><span><b>{{ ALL_CHARACTERS.length }}</b> 名武将</span><i></i><span><b>5–8</b> 人身份局</span><i></i><span>单机 · 好友联机</span></div>
        </div>
        <SgsHomePortrait />
      </div>
      <nav aria-label="纸上三国模式">
        <button type="button" class="sgs-home__main" @click="screen = 'setup'"><em aria-hidden="true">弈</em><b>单机游戏</b><span>与电脑对战 · 随时开局</span><i aria-hidden="true">↗</i></button>
        <button type="button" class="sgs-home__online" @click="screen = 'online'"><em aria-hidden="true">聚</em><b>联机游戏</b><span>创建或加入房间 · 与好友过招</span><i aria-hidden="true">↗</i></button>
        <button type="button" class="sgs-home__rules" @click="screen = 'rules'"><em aria-hidden="true">策</em><b>规则</b><span>玩法与武将 · 运筹帷幄</span><i aria-hidden="true">↗</i></button>
      </nav>
      <footer class="sgs-home__footer"><span>一局三国，万般可能</span><span>CRPLAY / PAPER SANGUO</span></footer>
    </section>

    <section v-else-if="screen === 'setup'" class="sgs-panel sgs-panel--setup">
      <header>
        <button type="button" aria-label="返回纸上三国首页" @click="screen = 'home'">‹</button>
        <h1>单机设置</h1>
      </header>
      <p class="sgs-panel__intro">安排你的下一局。选择人数与电脑节奏，再挑选出战武将。</p>
      <!--
        这三行是「带标题的选项组」，不是表单 label。
        原来用 <label> 包着一组 button，会让每个按钮的可访问名都变成整行文字
        （「电脑节奏较快标准悠闲」），读屏用户分不出哪个是哪个。
      -->
      <div role="group" aria-label="人数">
        <span>人数</span>
        <div class="sgs-panel__choices">
          <button
            v-for="count in playerCounts"
            :key="count"
            type="button"
            :class="{ active: config.playerCount === count }"
            :aria-pressed="config.playerCount === count"
            @click="config.playerCount = count"
          >{{ count }} 人</button>
        </div>
      </div>
      <div role="group" aria-label="电脑节奏">
        <span>电脑节奏</span>
        <div class="sgs-panel__choices">
          <button v-for="(label, value) in AI_PACE_LABEL" :key="value" type="button" :class="{ active: config.aiPace === value }" :aria-pressed="config.aiPace === value" @click="config.aiPace = value as AIPace">{{ label }}</button>
        </div>
      </div>
      <div role="group" aria-label="电脑难度">
        <span>电脑难度</span>
        <div class="sgs-panel__choices">
          <button
            v-for="(label, value) in DIFFICULTY_LABEL"
            :key="value"
            type="button"
            :class="{ active: config.difficulty === value }"
            :aria-pressed="config.difficulty === value"
            @click="config.difficulty = value as AIDifficulty"
          >{{ label }}</button>
        </div>
      </div>
      <p class="sgs-panel__note">当前已实现 {{ ALL_CHARACTERS.length }} 名武将，每人随机分配候选。</p>
      <p class="sgs-panel__summary"><b>{{ config.playerCount }} 人 · {{ DIFFICULTY_LABEL[config.difficulty] }}难度 · {{ AI_PACE_LABEL[config.aiPace] }}节奏</b><span>下一步：选择武将</span></p>
      <button type="button" class="primary sgs-panel__start" @click="startMatch">开始</button>
    </section>

    <section v-else-if="screen === 'playing'" class="sgs-panel sgs-panel--choose">
      <header class="sgs-panel__choose-header">
        <button type="button" aria-label="返回单机设置" @click="backFromGeneralPick">‹</button>
        <h1>{{ selfSelectOpen ? '自选武将' : '选择武将' }}</h1>
        <button
          v-if="game.myRequest.value?.kind === 'choose-general' && game.myRequest.value.allCandidates?.length"
          type="button"
          class="sgs-panel__self-select"
          @click="selfSelectOpen = !selfSelectOpen"
        >{{ selfSelectOpen ? '随机候选' : '自选' }}</button>
      </header>
      <SgsRequestDock
        v-if="game.myRequest.value && game.view.value"
        :request="game.myRequest.value"
        :view="game.view.value"
        :show-all-generals="selfSelectOpen"
        @submit="handleRespond"
      />
      <p v-else class="sgs-panel__note">其他角色选将中…</p>
    </section>

    <section v-else-if="screen === 'rules'" class="sgs-panel">
      <header>
        <button type="button" @click="screen = 'home'">‹</button>
        <h1>规则</h1>
        <button type="button" class="sgs-panel__art-link" @click="openArt('rules')">艺术集</button>
      </header>
      <div class="sgs-rules">
        <article>
          <b>身份</b>
          <p>主公开局公开身份。忠臣保护主公，反贼击杀主公，内奸最后与主公单挑取胜。</p>
        </article>
        <article>
          <b>回合</b>
          <p>准备 → 判定 → 摸牌 → 出牌 → 弃牌 → 结束。出牌阶段默认只能使用一张【杀】。</p>
        </article>
        <article>
          <b>距离</b>
          <p>座次距离减进攻马、加防御马；武器决定攻击范围。【杀】只能指定攻击范围内的角色。</p>
        </article>
        <article>
          <b>濒死</b>
          <p>体力降到零进入濒死，依次询问是否使用【桃】；无人相救则阵亡。</p>
        </article>
        <article v-for="section in CARD_INFO_SECTIONS" :key="section.title">
          <b>{{ section.title }}</b>
          <p v-for="card in section.cards" :key="card.name">【{{ card.name }}】{{ card.description }}</p>
        </article>
        <section v-for="group in characterGroups" :key="group.kingdom" class="sgs-rules__kingdom">
          <h2 :style="{ color: group.headingColor }">{{ group.name }}</h2>
          <article v-for="character in group.characters" :key="character.id">
            <b>{{ character.name }}（体力 {{ character.maxHp }}）<small v-if="character.pack === 'entertainment'">自定义</small></b>
            <p v-for="skill in character.skills" :key="skill.id">【{{ skill.name }}】{{ skill.description }}</p>
          </article>
        </section>
      </div>
    </section>

    <section v-else class="sgs-panel sgs-panel--art">
      <header><button type="button" @click="screen = artBackTo">‹</button><h1>武将艺术集</h1></header>
      <div class="sgs-panel__art-scroll"><SgsArtGallery /></div>
    </section>

    <p v-if="game.error.value" class="sgs-app__error" role="alert">{{ game.error.value }}</p>
  </main>

  <!-- 结算弹层和联机共用一个组件，两边的信息量和样式不会再各自漂移 -->
  <SgsResultDialog
    v-if="result && game.view.value"
    :view="game.view.value"
    :result="result"
    @again="playAgain"
    @exit="quit"
  />

  <div v-if="exitConfirmOpen" class="sgs-confirm-backdrop" @click.self="exitConfirmOpen = false">
    <section class="sgs-confirm" role="dialog" aria-modal="true">
      <h2>退出牌局</h2>
      <p>这一局的进度不会保存，确定要退出吗？</p>
      <div class="sgs-confirm__actions">
        <button type="button" @click="exitConfirmOpen = false">继续游戏</button>
        <button type="button" class="danger" @click="quit">退出</button>
      </div>
    </section>
  </div>
  <SgsGlossarySheet :entry="glossary.entry.value" @close="glossary.close" />
</template>

<style scoped>
.sgs-app {
  width: 100%; height: calc(100dvh - var(--app-viewport-offset, 0px)); overflow: hidden; color: var(--ink-text);
  /* 纸上三国主色是金色，和门户上那张卡片的强调色一致；麻将那边保持红色 */
  background: radial-gradient(circle at 75% 20%, rgba(207, 164, 86, .24), transparent 40%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom));
}
.sgs-home, .sgs-panel {
  width: min(980px, 100%); height: 100%; margin: auto; display: flex; flex-direction: column;
  padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
}
.sgs-panel { gap: 16px; }
.sgs-panel header { display: flex; align-items: center; gap: 12px; }
.sgs-panel__choose-header { flex: none; }
.sgs-panel__choose-header h1 { flex: 1; }
.sgs-panel header .sgs-panel__self-select, .sgs-panel header .sgs-panel__art-link { margin-left: auto; color: #f0d68d; border-color: #7e6737; }
.sgs-panel h1 { margin: 0; color: #f0d68d; font-size: 22px; }
.sgs-panel [role="group"] { display: grid; gap: 7px; }
.sgs-panel [role="group"] > span { color: #8f9b90; font-size: 12px; }
.sgs-panel__choices { display: flex; flex-wrap: wrap; gap: 8px; }
.sgs-panel__choices button {
  min-height: 46px; padding: 0 18px; border: 1px solid #3f4d45; border-radius: 10px;
  background: var(--ink-panel-deep); color: var(--ink-text-soft); cursor: pointer; font: inherit;
}
.sgs-panel__choices button.active { border-color: #d3b463; background: #2c2718; color: #f0d68d; }
.sgs-panel__note { margin: 0; color: #7f8a84; font-size: 12px; }
.sgs-panel__start { margin-top: auto; }
/*
 * 选将屏从垂直居中改成靠上。
 *
 * 候选从 3 个涨到最多 10 个之后，居中会让短列表顶上留一大片空、长列表又贴边；
 * 靠上排则两种情况都稳定，长了就在内部滚。
 */
.sgs-panel--choose { justify-content: flex-start; padding-top: max(10px, env(safe-area-inset-top)); overflow-y: auto; }
.sgs-panel--choose h1 { margin-bottom: 2px; font-size: 19px; }
/*
 * 选将屏里让 dock 铺满剩余高度，滚动发生在方框内部。
 *
 * 那个 56dvh 是给牌桌底部面板定的——牌桌上面板必须让出位置给牌局。
 * 选将屏整屏都归它，卡在 56dvh 只会把留白从顶上挪到底下。
 * 这里改成 flex:1 吃满剩余空间，武将多了就在框内滚，
 * 确认按钮靠 dock 自己的 sticky 贴在框底，永远点得到。
 *
 * 注意别把 overflow 挪到里面的网格上：网格是 `grid-auto-rows: 1fr`，
 * 只有在高度自适应时那个 1fr 才等于「对齐到最高的一张」；
 * 一旦网格自己有了确定高度，1fr 会变成平分容器高度，卡片就不再等大了。
 */
.sgs-panel--choose :deep(.sgs-dock) { flex: 1; min-height: 0; max-height: none; }
.primary {
  min-height: 52px; padding: 0 18px; border: 1px solid #9e7f3c; border-radius: 11px;
  background: linear-gradient(180deg, #6d5527, #4c3b1a); color: #ffe6a8; cursor: pointer; font: inherit; font-weight: 800;
}

.sgs-rules { flex: 1; min-height: 0; overflow-y: auto; display: grid; gap: 12px; }
.sgs-rules article { padding: 11px 13px; border: 1px solid #333c35; border-radius: 11px; background: rgba(18, 26, 22, .75); }
.sgs-rules b { display: block; margin-bottom: 4px; color: #e6d29a; font-size: 13px; }
.sgs-rules b small { margin-left: 7px; padding: 2px 5px; border-radius: 5px; background: #57392b; color: #f1bd8d; font-size: 9px; }
.sgs-rules p { margin: 0 0 3px; color: #a3aea5; font-size: 12px; line-height: 1.65; }
.sgs-rules__kingdom { display: grid; gap: 10px; }
.sgs-rules__kingdom h2 { position: sticky; top: 0; z-index: 2; margin: 5px 0 0; padding: 8px 3px; color: #f0d68d; background: #14211be8; font: 800 18px/1 KaiTi, serif; }
.sgs-panel--art { overflow: hidden; }
.sgs-panel__art-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

.sgs-app__error {
  position: fixed; z-index: 40; left: 50%; top: calc(12px + env(safe-area-inset-top)); transform: translateX(-50%);
  width: min(520px, calc(100vw - 24px)); margin: 0; padding: 10px 14px;
  border: 1px solid #a5544a; border-radius: 11px; background: rgba(88, 40, 35, .96); color: #ffd8d2; font-size: 13px; text-align: center;
}


/* 退出确认：居中弹层，和麻将那边同一套观感 */
.sgs-confirm-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 20px; background: rgba(3, 10, 8, .74); }
.sgs-confirm {
  width: min(340px, 100%); padding: 20px; border: 1px solid var(--ink-line); border-radius: 16px;
  background: linear-gradient(160deg, var(--ink-panel), var(--ink-panel-deep)); box-shadow: 0 26px 70px rgba(0, 0, 0, .55);
}
.sgs-confirm h2 { margin: 0 0 8px; color: #f3d67c; font-size: 17px; }
.sgs-confirm p { margin: 0 0 18px; color: var(--ink-text-soft); font-size: 13px; line-height: 1.6; }
.sgs-confirm__actions { display: flex; gap: 8px; }
.sgs-confirm__actions button { flex: 1; min-height: 42px; border-radius: 10px; border: 1px solid var(--ink-line); background: var(--ink-panel-deep); color: var(--ink-text-soft); cursor: pointer; font: inherit; font-weight: 700; }
.sgs-confirm__actions .danger { border-color: var(--accent-red); color: #ffd9d2; background: linear-gradient(180deg, var(--accent-red-fill-top), var(--accent-red-fill-bottom)); }

</style>
<style scoped src="/src/sanguosha/styles/home.css"></style>
<!-- Load after component styles so responsive layout rules have deterministic precedence. -->
<style src="/src/sanguosha/styles/refresh.css"></style>
