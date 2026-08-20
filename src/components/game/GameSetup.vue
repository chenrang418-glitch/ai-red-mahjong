<script setup lang="ts">
import { reactive } from 'vue'
import AudioControl from './AudioControl.vue'
import type { AIProfile, Difficulty, MatchConfig, MatchMode } from '@/game/types'

defineProps<{ savedGameAvailable: boolean }>()
const emit = defineEmits<{ start: [config: MatchConfig]; resume: []; history: []; rules: []; back: [] }>()

const difficultyLabels: Record<Difficulty, string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }
const difficultyHints: Record<Difficulty, string> = {
  beginner: '算不清剩几张，常打错牌',
  standard: '会算向听和进张',
  expert: '挑听得最宽的打法',
}

interface SetupForm {
  mode: MatchMode
  claimWindowMs: number
  names: string[]
  points: number[]
  profiles: AIProfile[]
}

const form = reactive<SetupForm>({
  mode: 'finite',
  claimWindowMs: 4000,
  names: ['你', '阿锐', '小稳', '老周'],
  points: [30, 30, 30, 30],
  profiles: [
    { difficulty: 'beginner' },
    { difficulty: 'standard' },
    { difficulty: 'expert' },
  ],
})

function submit() {
  const players = form.names.map((name, id) => ({
    name: name.trim() || (id === 0 ? '你' : `AI ${id}`),
    isHuman: id === 0,
    initialPoints: Math.max(1, Math.floor(form.points[id] || 1)),
    ai: id === 0 ? null : { ...form.profiles[id - 1] },
  }))
  emit('start', { mode: form.mode, claimWindowMs: form.claimWindowMs, players })
}
</script>

<template>
  <main class="setup-page">
    <section class="hero desktop-only">
      <div class="seal">中</div>
      <p class="eyebrow">本地离线 · 红中麻将</p>
      <h1>AI 红中麻将</h1>
      <p class="subtitle desktop-only">你与三个不看暗牌的离线AI，在浏览器里完整打一场。</p>
      <div class="rule-chips">
        <span>112张</span><span>只能自摸</span><span>支持七对</span><span>六码抓码</span><span>红中万能</span>
      </div>
    </section>

    <section class="setup-card">
      <div class="card-heading">
        <div class="heading-title">
          <button class="heading-back mobile-only" type="button" aria-label="返回首页" @click="emit('back')">‹</button>
          <small class="desktop-only">NEW MATCH</small>
          <h2>开局设置</h2>
        </div>
        <div class="heading-actions">
          <button class="ghost-button desktop-only" type="button" @click="emit('back')">返回首页</button>
          <AudioControl />
          <button class="ghost-button" type="button" @click="emit('history')">牌谱</button>
          <button class="ghost-button" type="button" @click="emit('rules')">规则</button>
        </div>
      </div>

      <div class="mode-switch">
        <label :class="{ selected: form.mode === 'finite' }">
          <input v-model="form.mode" type="radio" value="finite">
          <strong>有限积分</strong><span>有人积分归零，整场结束</span>
        </label>
        <label :class="{ selected: form.mode === 'unlimited' }">
          <input v-model="form.mode" type="radio" value="unlimited">
          <strong>无限模式</strong><span>不破产，只记录本场净分</span>
        </label>
      </div>

      <section class="ai-guide desktop-only" aria-label="AI设置说明">
        <div class="guide-title"><span>AI GUIDE</span><strong>三个档位</strong></div>
        <article><b>菜鸡</b><p>算不清牌河里已经走了几张，常常顺手打错牌，有杠就杠，碰牌也不看划不划算。</p></article>
        <article><b>凡人</b><p>会算离听牌还差几步、还能摸到多少张有用的牌，副露前会先掂量值不值。</p></article>
        <article><b>猿神</b><p>在凡人之上还会挑「听得最宽」的那张打，牌墙见底时收手保杠分，也会避开明显在喂给对家的牌。</p></article>
      </section>
      <p class="ai-note desktop-only">打什么牌型由 AI 看着手牌自己定，不用你指定风格；想多久也由这手牌好不好打决定——孤张秒出，听牌和能杠的地方会明显慢下来。所有档位都只看自己的手牌和公开信息，不会偷看别人的暗牌。</p>

      <div class="players-grid">
        <article v-for="playerId in 4" :key="playerId" class="player-config">
          <header>
            <span class="avatar" :class="{ human: playerId === 1 }">{{ playerId === 1 ? '你' : `AI${playerId - 1}` }}</span>
            <div><strong>{{ playerId === 1 ? '真人玩家' : '离线AI玩家' }}</strong><small>{{ playerId === 1 ? '固定在牌桌下方' : '只需选一个档位' }}</small></div>
          </header>
          <label>名称<input v-model="form.names[playerId - 1]" maxlength="8"></label>
          <label v-if="form.mode === 'finite'">初始积分<input v-model.number="form.points[playerId - 1]" type="number" min="1" max="9999"></label>
          <template v-if="playerId > 1">
            <label>智能档位
              <select v-model="form.profiles[playerId - 2].difficulty">
                <option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option>
              </select>
            </label>
            <p class="profile-hint desktop-only">{{ difficultyHints[form.profiles[playerId - 2].difficulty] }}</p>
          </template>
        </article>
      </div>

      <div class="setup-footer">
        <label class="claim-setting">抢牌窗口
          <select v-model.number="form.claimWindowMs">
            <option :value="2000">2秒</option><option :value="3000">3秒</option><option :value="4000">4秒（推荐）</option><option :value="5000">5秒</option><option :value="6000">6秒</option><option :value="7000">7秒</option>
          </select>
        </label>
        <p>四家各投两枚骰子，最高者首庄；平局自动重投。</p>
        <button v-if="savedGameAvailable" class="secondary-button" type="button" @click="emit('resume')">继续上次牌局</button>
        <button class="primary-button" type="button" @click="submit">投骰开局</button>
      </div>
    </section>
  </main>
</template>

<style scoped>
.setup-page { min-height: 100vh; padding: 48px clamp(20px, 5vw, 72px) 70px; background: radial-gradient(circle at 12% 0, #244339 0, transparent 34%), #0b1714; color: #f6f0df; }
.hero { max-width: 1050px; margin: 0 auto 28px; position: relative; }
.seal { position: absolute; right: 3%; top: -12px; width: 86px; height: 86px; display: grid; place-items: center; border: 2px solid #c94f43; color: #c94f43; border-radius: 20px; font: 800 48px/1 serif; transform: rotate(7deg); opacity: .82; }
.eyebrow { color: #d6b765; letter-spacing: .28em; font-size: 12px; font-weight: 700; }
h1 { margin: 7px 0 5px; font: 800 clamp(38px, 6vw, 68px)/1.1 'Microsoft YaHei', sans-serif; letter-spacing: -.05em; }
.subtitle { color: #9fb3ac; font-size: 16px; }
.rule-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.rule-chips span { padding: 6px 10px; border: 1px solid rgba(222,195,116,.23); border-radius: 99px; color: #d7c58d; font-size: 12px; background: rgba(255,255,255,.025); }
.setup-card { max-width: 1120px; margin: auto; padding: 26px; border: 1px solid rgba(222,195,116,.25); border-radius: 24px; background: rgba(16,35,30,.9); box-shadow: 0 24px 80px rgba(0,0,0,.32); }
.card-heading, .setup-footer, .heading-actions { display: flex; align-items: center; gap: 10px; }
.card-heading { justify-content: space-between; margin-bottom: 20px; }
.card-heading small { color: #748a83; letter-spacing: .2em; }
h2 { margin: 2px 0 0; font-size: 24px; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
.mode-switch label { display: grid; grid-template-columns: 25px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 10px; align-items: start; padding: 16px; border: 1px solid #29453d; border-radius: 13px; cursor: pointer; }
.mode-switch label.selected { border-color: #d9b95f; background: rgba(217,185,95,.07); }
.mode-switch input { grid-column: 1; grid-row: 1 / 3; width: 19px; height: 19px; margin: 3px 0 0; padding: 0; accent-color: #d9b95f; }
.mode-switch strong, .mode-switch span { grid-column: 2; min-width: 0; }
.mode-switch strong { font-size: 15px; line-height: 1.4; }
.mode-switch span { color: #849a93; font-size: 11px; line-height: 1.5; }
.ai-guide { display: grid; grid-template-columns: 130px repeat(3, 1fr); gap: 10px; align-items: stretch; margin: 0 0 18px; padding: 11px; border: 1px solid #29453d; border-radius: 14px; background: #0c1e19; }
.guide-title { display: flex; flex-direction: column; justify-content: center; padding: 7px; }
.guide-title span { color: #6d837c; font-size: 9px; letter-spacing: .18em; }
.guide-title strong { color: #e7cf88; font-size: 16px; }
.ai-guide article { padding: 9px 11px; border-left: 1px solid #29453d; }
.ai-guide b { color: #e5c76e; font-size: 12px; }
.ai-guide p { margin: 4px 0 0; color: #82978f; font-size: 10px; line-height: 1.65; }
.ai-note { margin: -10px 0 18px; color: #7f948d; font-size: 11px; line-height: 1.75; }
.profile-hint { margin: 7px 0 0; color: #7f948d; font-size: 10px; line-height: 1.6; }
.players-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px; }
.player-config { padding: 15px; border: 1px solid #29453d; border-radius: 14px; background: #0d211c; }
.player-config header { display: flex; gap: 9px; align-items: center; margin-bottom: 12px; }
.player-config header div { display: grid; }
.player-config header strong { font-size: 13px; }
.player-config header small { color: #748a83; font-size: 10px; }
.avatar { width: 37px; height: 37px; display: grid; place-items: center; border-radius: 11px; background: #24463c; color: #e7cf8a; font-size: 11px; font-weight: 800; }
.avatar.human { background: #8f302d; color: white; }
.player-config label, .claim-setting { display: grid; gap: 4px; color: #7f9690; font-size: 10px; margin-top: 9px; }
input, select { width: 100%; min-width: 0; padding: 9px 10px; color: #f4eedc; background: #122c25; border: 1px solid #315047; border-radius: 8px; outline: 0; }
input:focus, select:focus { border-color: #d7b75d; }
.inline-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.setup-footer { margin-top: 22px; padding-top: 18px; border-top: 1px solid #29453d; }
.setup-footer p { color: #7f948e; font-size: 11px; flex: 1; }
.claim-setting { min-width: 110px; margin: 0; }
button { border: 0; border-radius: 10px; font: 700 13px/1 'Microsoft YaHei'; padding: 12px 18px; cursor: pointer; }
.primary-button { color: #1e251d; background: #e6c76d; box-shadow: 0 8px 24px rgba(230,199,109,.18); }
.secondary-button, .ghost-button { color: #e6d8b2; background: #1a3931; border: 1px solid #315248; }
.ghost-button { background: transparent; }
@media (max-width: 900px) { .players-grid { grid-template-columns: 1fr 1fr; } .ai-guide { grid-template-columns: 1fr; } .guide-title { padding-bottom: 2px; } .ai-guide article { border-left: 0; border-top: 1px solid #29453d; } }
@media (max-width: 620px) { .players-grid, .mode-switch { grid-template-columns: 1fr; } .setup-footer, .card-heading { flex-wrap: wrap; } .setup-footer p { flex-basis: 100%; } .heading-actions { width: 100%; } .heading-actions button { flex: 1; } .seal { display: none; } }

/* 触屏上手指点不准 33px 高的下拉框，开局页的每个控件都放大到能一次点中 */
@media (pointer: coarse) {
  input, select { min-height: 46px; padding: 11px 12px; font-size: 15px; }
  input[type="radio"] { min-height: 0; }
  .mode-switch input { width: 22px; height: 22px; }
  button { min-height: 48px; padding: 13px 18px; font-size: 14px; }
  .player-config label, .claim-setting { gap: 6px; font-size: 12px; margin-top: 12px; }
  .inline-fields { gap: 9px; }
}

/* —— 手机端照小程序：一屏放下，只留操作项 —— */
@media (pointer: coarse), (max-width: 700px) {
  .setup-page { padding: max(10px, env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom)); gap: 0; }
  .setup-card { padding: 0; border: 0; background: transparent; box-shadow: none; }
  .card-heading { margin-bottom: 14px; align-items: center; gap: 10px; }
  .heading-title { display: flex; align-items: center; gap: 10px; }
  .heading-title h2 { margin: 0; font-size: 21px; white-space: nowrap; }
  .heading-back {
    width: 32px; height: 32px; flex: none;
    display: grid; place-items: center; padding: 0;
    border: 1px solid #2f4b41; border-radius: 10px;
    background: #10251f; color: #cbd6d0; font-size: 20px; line-height: 1;
  }
  .heading-actions { gap: 6px; flex: none; }
  .heading-actions .ghost-button { padding: 6px 12px; font-size: 11px; white-space: nowrap; border-radius: 99px; }
  /* 计分方式两块并排，和小程序一样 */
  .mode-switch { grid-template-columns: 1fr 1fr; gap: 10px; }
  .mode-switch label { padding: 14px 15px; gap: 3px; }
  .mode-switch strong { font-size: 16px; }
  .mode-switch span { font-size: 11px; }
  .mode-switch input { display: none; }

  /* 这几块说明加了 .desktop-only 也没用：组件内的 scoped 规则特异性比全局类高，
     得在组件自己的媒体查询里关掉。 */
  .hero, .ai-guide, .ai-note, .profile-hint, .subtitle { display: none !important; }
  .player-config header small { display: none; }

  /* 座位压成一行一个：头像 + 名称 + 档位，和小程序对齐 */
  .players-grid { grid-template-columns: 1fr; gap: 8px; margin-top: 12px; }
  .player-config {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    border-radius: 13px;
  }
  .player-config header { grid-column: 1; margin: 0; }
  .player-config header strong { display: none; }
  .player-config .avatar { width: 34px; height: 34px; font-size: 11px; }
  /* 名称占中间，档位靠右，初始积分在这屏用不着（下面统一设） */
  .player-config label { margin: 0; }
  .player-config label:nth-of-type(1) { grid-column: 2; }
  .player-config label:nth-of-type(2) { display: none; }
  .player-config label:last-of-type { grid-column: 3; }
  .player-config input, .player-config select {
    min-height: 38px; padding: 7px 10px; font-size: 14px;
  }
  .player-config select { min-width: 88px; }

  .setup-footer { margin-top: 16px; }
}
</style>
