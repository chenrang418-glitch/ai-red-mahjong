<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import SgsTable from './components/SgsTable.vue'
import SgsRequestDock from './components/SgsRequestDock.vue'
import SgsOnlineHub from './components/SgsOnlineHub.vue'
import SgsGlossarySheet from './components/SgsGlossarySheet.vue'
import SgsArtGallery from './components/SgsArtGallery.vue'
import SgsAudioControl from './components/SgsAudioControl.vue'
import { useLocalSanguosha } from './composables/useLocalSanguosha'
import { provideSgsGlossary } from './composables/useSgsGlossary'
import { getCharacter, ALL_CHARACTERS } from './data/characters/standard'
import { CARD_INFO_SECTIONS } from './data/ruleset-v1/card-info'
import type { GameResponse } from './engine/requests'
import type { AIDifficulty } from './ai'

defineEmits<{ backToPortal: [] }>()

type Screen = 'home' | 'setup' | 'online' | 'playing' | 'rules' | 'art'

const screen = ref<Screen>(new URLSearchParams(window.location.search).has('room') ? 'online' : 'home')
const audioOpen = ref(false)
const game = useLocalSanguosha()
const glossary = provideSgsGlossary()
type AIPace = 'fast' | 'normal' | 'relaxed'
const config = reactive({ playerCount: 5, difficulty: 'normal' as AIDifficulty, aiPace: 'normal' as AIPace })
/**
 * 电脑节奏，整体比原来慢一档（450/700/950 → 700/950/1300）。
 *
 * 原来的「标准」700ms 比表现事件本身还短：一次伤害要播 900ms，
 * AI 已经走下一步了，动画一直在被追着跑。放慢之后两边才对得上。
 */
const AI_PACE_MS: Record<AIPace, number> = { fast: 700, normal: 950, relaxed: 1300 }
const AI_PACE_LABEL: Record<AIPace, string> = { fast: '较快', normal: '标准', relaxed: '悠闲' }

const DIFFICULTY_LABEL: Record<AIDifficulty, string> = { easy: '简单', normal: '标准', hard: '困难' }
// 每人的候选互不重叠，所以人数不能超过已实现的武将数
const maxPlayers = computed(() => Math.min(8, ALL_CHARACTERS.length))
const playerCounts = computed(() => [5, 6, 7, 8].filter((count) => count <= maxPlayers.value))

const result = computed(() => game.view.value?.result ?? null)
const CAMP_LABEL: Record<string, string> = { lord: '主公与忠臣', rebel: '反贼', renegade: '内奸' }
const choosingGeneral = computed(() => game.view.value?.status === 'choosing-general')
const selfSelectOpen = ref(false)
const KINGDOM_LABEL = { shu: '蜀', wei: '魏', wu: '吴', qun: '群' } as const
const characterGroups = computed(() => (Object.keys(KINGDOM_LABEL) as Array<keyof typeof KINGDOM_LABEL>)
  .map((kingdom) => ({ kingdom, label: KINGDOM_LABEL[kingdom], characters: ALL_CHARACTERS.filter((character) => character.kingdom === kingdom) }))
  .filter((group) => group.characters.length))

const IDENTITY_LABEL: Record<string, string> = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' }
const WINNING_IDENTITIES: Record<string, string[]> = {
  lord: ['lord', 'loyalist'], rebel: ['rebel'], renegade: ['renegade'],
}

/** 结算名单：身份全部公开，标出谁赢了。 */
const finalRoster = computed(() => {
  const view = game.view.value
  if (!view || !result.value) return []
  const winners = WINNING_IDENTITIES[result.value.winningCamp] ?? []
  return view.players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    identity: player.identity ?? 'unknown',
    characterName: player.characterId ? getCharacter(player.characterId)?.name ?? '未知' : '未选将',
    alive: player.alive,
    hp: player.hp,
    maxHp: player.maxHp,
    won: winners.includes(player.identity ?? ''),
  }))
})

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
        <span>CRPLAY · 三国杀</span>
        <SgsAudioControl v-model:open="audioOpen" />
      </header>
      <div class="sgs-home__hero">
        <div class="sgs-home__seal" aria-hidden="true">杀</div>
        <p>经典身份局</p>
        <h1>三国杀</h1>
        <small>当前共 {{ ALL_CHARACTERS.length }} 名完整可玩武将、全部装备均已实现，支持单机与好友联机。</small>
      </div>
      <nav aria-label="三国杀模式">
        <button type="button" class="sgs-home__main" @click="screen = 'setup'"><b>单机游戏</b><span>与电脑对战</span></button>
        <button type="button" class="sgs-home__online" @click="screen = 'online'"><b>联机游戏</b><span>创建或加入房间</span></button>
        <button type="button" class="sgs-home__rules" @click="screen = 'rules'"><b>规则</b><span>玩法与武将</span></button>
      </nav>
    </section>

    <section v-else-if="screen === 'setup'" class="sgs-panel">
      <header>
        <button type="button" @click="screen = 'home'">‹</button>
        <h1>单机设置</h1>
      </header>
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
            @click="config.playerCount = count"
          >{{ count }} 人</button>
        </div>
      </div>
      <div role="group" aria-label="电脑节奏">
        <span>电脑节奏</span>
        <div class="sgs-panel__choices">
          <button v-for="(label, value) in AI_PACE_LABEL" :key="value" type="button" :class="{ active: config.aiPace === value }" @click="config.aiPace = value as AIPace">{{ label }}</button>
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
            @click="config.difficulty = value as AIDifficulty"
          >{{ label }}</button>
        </div>
      </div>
      <p class="sgs-panel__note">当前已实现 {{ ALL_CHARACTERS.length }} 名武将，每人随机分配候选。</p>
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
        <button type="button" class="sgs-panel__art-link" @click="screen = 'art'">艺术集</button>
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
          <h2>{{ group.label }}</h2>
          <article v-for="character in group.characters" :key="character.id">
            <b>{{ character.name }}（体力 {{ character.maxHp }}）<small v-if="character.pack === 'entertainment'">自定义</small></b>
            <p v-for="skill in character.skills" :key="skill.id">【{{ skill.name }}】{{ skill.description }}</p>
          </article>
        </section>
      </div>
    </section>

    <section v-else class="sgs-panel sgs-panel--art">
      <header><button type="button" @click="screen = 'rules'">‹</button><h1>武将艺术集</h1></header>
      <div class="sgs-panel__art-scroll"><SgsArtGallery /></div>
    </section>

    <p v-if="game.error.value" class="sgs-app__error" role="alert">{{ game.error.value }}</p>
  </main>

  <div v-if="result" class="sgs-result-backdrop">
    <section class="sgs-result" role="dialog" aria-modal="true">
      <h2>{{ CAMP_LABEL[result.winningCamp] ?? result.winningCamp }}获胜</h2>
      <p>{{ result.reason }}</p>
      <!-- 牌局结束才公开全部身份，这是玩家最想看的一屏 -->
      <ol class="sgs-result__roster">
        <li v-for="player in finalRoster" :key="player.id" :class="{ won: player.won, dead: !player.alive }">
          <span class="sgs-result__identity" :class="`sgs-result__identity--${player.identity}`">{{ IDENTITY_LABEL[player.identity] ?? '？' }}</span>
          <strong>{{ player.nickname }}</strong>
          <small>{{ player.characterName }}</small>
          <em>{{ player.alive ? `存活 ${player.hp}/${player.maxHp}` : '阵亡' }}</em>
        </li>
      </ol>
      <div class="sgs-result__actions">
        <button type="button" class="danger" @click="quit">返回首页</button>
        <button type="button" class="primary" @click="playAgain">再来一局</button>
      </div>
    </section>
  </div>

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
  width: 100%; height: 100dvh; overflow: hidden; color: var(--ink-text);
  /* 三国杀主色是金色，和门户上那张卡片的强调色一致；麻将那边保持红色 */
  background: radial-gradient(circle at 75% 20%, rgba(207, 164, 86, .24), transparent 40%), linear-gradient(150deg, var(--ink-bg-top), var(--ink-bg-bottom));
}
.sgs-home, .sgs-panel {
  width: min(980px, 100%); height: 100%; margin: auto; display: flex; flex-direction: column;
  padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
}
.sgs-home header { display: flex; justify-content: space-between; align-items: center; color: var(--ink-text-muted); font-size: 11px; letter-spacing: .15em; }
.sgs-home header button, .sgs-panel header button {
  min-height: 38px; padding: 0 13px; border: 1px solid var(--ink-line); border-radius: 9px;
  color: var(--ink-text-soft); background: var(--ink-panel-deep); cursor: pointer;
}
.sgs-home__hero { flex: 1; display: grid; place-content: center; justify-items: center; text-align: center; }
.sgs-home__seal {
  width: 88px; height: 88px; display: grid; place-items: center;
  border: 2px solid var(--accent-gold); border-radius: 23px; color: #efc477;
  font: 900 48px/1 STKaiti, KaiTi, serif; transform: rotate(-4deg); box-shadow: 0 0 50px rgba(207, 164, 86, .18);
}
.sgs-home__hero p { margin: 24px 0 8px; color: var(--accent-gold); font-size: 12px; letter-spacing: .18em; }
.sgs-home__hero h1 { margin: 0; font-size: clamp(55px, 10vw, 92px); line-height: 1; letter-spacing: -.08em; }
.sgs-home__hero small { max-width: 560px; margin-top: 22px; color: var(--ink-text-muted); line-height: 1.7; }
.sgs-home nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.sgs-home nav button {
  min-height: 74px; display: grid; align-content: center; gap: 4px;
  border: 1px solid var(--ink-line); border-radius: 15px; color: var(--ink-text-soft); background: rgba(34, 50, 42, .85); cursor: pointer;
}
.sgs-home nav button:disabled { color: #767f7a; cursor: default; }
.sgs-home nav .sgs-home__main { border-color: var(--accent-gold); color: #ffeec0; background: linear-gradient(180deg, var(--accent-gold-fill-top), var(--accent-gold-fill-bottom)); }
/* 三个入口各用一种颜色，暗底上要保证文字对比度，所以底色压暗、字色提亮 */
.sgs-home nav .sgs-home__online { border-color: var(--accent-red); color: #ffd9d2; background: linear-gradient(180deg, var(--accent-red-fill-top), var(--accent-red-fill-bottom)); }
.sgs-home nav .sgs-home__rules { border-color: var(--accent-green); color: #d3f3da; background: linear-gradient(180deg, var(--accent-green-fill-top), var(--accent-green-fill-bottom)); }
.sgs-home nav b { font-size: 16px; }
.sgs-home nav span { font-size: 10px; }

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

.sgs-result-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: rgba(3, 10, 8, .74); }
.sgs-result {
  width: min(380px, 100%); padding: 24px; text-align: center;
  border: 1px solid rgba(226, 191, 98, .38); border-radius: 20px;
  background: linear-gradient(160deg, var(--ink-panel), var(--ink-panel-deep)); box-shadow: 0 26px 70px rgba(0, 0, 0, .55);
}
.sgs-result h2 { margin: 0 0 8px; color: #f3d67c; font-size: 21px; }
.sgs-result__roster { margin: 0 0 16px; padding: 0; list-style: none; display: grid; gap: 5px; max-height: 44dvh; overflow-y: auto; }
.sgs-result__roster li {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 7px 9px; border: 1px solid var(--ink-line); border-radius: 9px; background: rgba(34, 50, 42, .7);
}
.sgs-result__roster li.won { border-color: var(--accent-gold); background: rgba(155, 122, 55, .22); }
.sgs-result__roster li.dead { opacity: .55; }
.sgs-result__roster strong { min-width: 0; overflow: hidden; color: #f7f0df; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; text-shadow: 0 1px 2px rgba(0, 0, 0, .72); }
.sgs-result__roster small { grid-column: 2; color: var(--ink-text-muted); font-size: 11px; }
.sgs-result__roster em { grid-row: 1 / 3; color: var(--ink-text-soft); font-size: 11px; font-style: normal; }
.sgs-result__identity { grid-row: 1 / 3; padding: 2px 6px; border-radius: 5px; background: #2b3831; color: #93a49b; font-size: 10px; }
.sgs-result__identity--lord { background: #6a4a1c; color: #ffd98a; }
.sgs-result__identity--rebel { background: #59326f; color: #e6c8ff; }
.sgs-result__identity--loyalist { background: #21432f; color: #a6e0bb; }
.sgs-result__identity--renegade { background: #762f2b; color: #ffc0b8; }
.sgs-result__actions { display: flex; gap: 8px; }
.sgs-result__actions button { flex: 1; }
.sgs-result__actions .danger { border-color: #b95147; background: linear-gradient(180deg, #a9433a, #7f2d28); color: #fff1ed; }

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
.sgs-result p { margin: 0 0 18px; color: #a3aea5; font-size: 13px; }

@media (max-width: 620px) and (orientation: portrait) {
  .sgs-home nav { grid-template-columns: 1fr; }
  .sgs-home nav button { min-height: 58px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  .sgs-home__seal { width: 58px; height: 58px; font-size: 32px; }
  .sgs-home__hero p { margin-top: 12px; }
  .sgs-home__hero h1 { font-size: 48px; }
  .sgs-home__hero small { margin-top: 8px; }
  .sgs-home nav button { min-height: 54px; }
  .sgs-panel { gap: 10px; }
  .sgs-panel__choices button { min-height: 38px; }
  .primary { min-height: 42px; }
}
</style>
