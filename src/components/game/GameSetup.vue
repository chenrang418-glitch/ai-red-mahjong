<script setup lang="ts">
import { reactive } from 'vue'
import AudioControl from './AudioControl.vue'
import type { AIProfile, Difficulty, MatchConfig, MatchMode, Personality, ThinkingSpeed } from '@/game/types'

defineProps<{ savedGameAvailable: boolean }>()
const emit = defineEmits<{ start: [config: MatchConfig]; resume: []; history: []; rules: [] }>()

const personalityLabels: Record<Personality, string> = {
  fast: '快攻型',
  balanced: '平衡型',
  closed: '七对型',
  'no-zhong': '无红中策略型',
  humanlike: '真人波动型',
}
const difficultyLabels: Record<Difficulty, string> = { beginner: '菜鸡', standard: '凡人', expert: '猿神' }
const speedLabels: Record<ThinkingSpeed, string> = { fast: '闪电', normal: '猴急', slow: '微醺', dreamy: '入梦' }

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
    { personality: 'fast', difficulty: 'beginner', speed: 'fast' },
    { personality: 'balanced', difficulty: 'standard', speed: 'normal' },
    { personality: 'closed', difficulty: 'expert', speed: 'normal' },
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
    <section class="hero">
      <div class="seal">中</div>
      <p class="eyebrow">本地离线 · 光山玩法</p>
      <h1>AI 红中麻将</h1>
      <p class="subtitle">你与三个不看暗牌的离线AI，在浏览器里完整打一场。</p>
      <div class="rule-chips">
        <span>112张</span><span>只能自摸</span><span>支持七对</span><span>六码抓码</span><span>先喊先得</span>
      </div>
    </section>

    <section class="setup-card">
      <div class="card-heading">
        <div><small>NEW MATCH</small><h2>开局设置</h2></div>
        <div class="heading-actions">
          <AudioControl />
          <button class="ghost-button" type="button" @click="emit('rules')">玩法规则</button>
          <button class="ghost-button" type="button" @click="emit('history')">牌谱回放</button>
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

      <section class="ai-guide" aria-label="AI设置说明">
        <div class="guide-title"><span>AI GUIDE</span><strong>选择说明</strong></div>
        <article><b>性格</b><p>快攻重副露，七对专注对子，无红中策略降低红中依赖；平衡型对三者等权，真人波动型会择优但偶尔判断失误。</p></article>
        <article><b>智能</b><p>菜鸡重视眼前牌型，凡人计算有效进张，猿神增加后续摸牌前瞻；所有档位都不会读取其他玩家暗牌。</p></article>
        <article><b>速度</b><p>闪电、猴急、微醺、入梦四档，只控制思考和抢牌等待，不改变智能水平；对局中可随时切换。</p></article>
      </section>

      <div class="players-grid">
        <article v-for="playerId in 4" :key="playerId" class="player-config">
          <header>
            <span class="avatar" :class="{ human: playerId === 1 }">{{ playerId === 1 ? '你' : `AI${playerId - 1}` }}</span>
            <div><strong>{{ playerId === 1 ? '真人玩家' : '离线AI玩家' }}</strong><small>{{ playerId === 1 ? '固定在牌桌下方' : '性格与难度独立设置' }}</small></div>
          </header>
          <label>名称<input v-model="form.names[playerId - 1]" maxlength="8"></label>
          <label v-if="form.mode === 'finite'">初始积分<input v-model.number="form.points[playerId - 1]" type="number" min="1" max="9999"></label>
          <template v-if="playerId > 1">
            <label>性格
              <select v-model="form.profiles[playerId - 2].personality">
                <option v-for="(label, value) in personalityLabels" :key="value" :value="value">{{ label }}</option>
              </select>
            </label>
            <div class="inline-fields">
              <label>智能
                <select v-model="form.profiles[playerId - 2].difficulty">
                  <option v-for="(label, value) in difficultyLabels" :key="value" :value="value">{{ label }}</option>
                </select>
              </label>
              <label>速度
                <select v-model="form.profiles[playerId - 2].speed">
                  <option v-for="(label, value) in speedLabels" :key="value" :value="value">{{ label }}</option>
                </select>
              </label>
            </div>
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
</style>
