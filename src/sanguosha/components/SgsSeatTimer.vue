<script setup lang="ts">
import { computed } from 'vue'
import type { SgsSeatTimer } from '../online/protocol'

/**
 * 一个座位的操作计时。
 *
 * 放在牌桌上而不是屏幕角落：注意力本来就在牌桌上，时间跑到别处会逼着人来回扫，
 * 而且角落里那一个数字说不清「现在在等谁」。每一家各画各的，一眼就知道轮到谁、
 * 还剩多久。
 *
 * 两个形态：
 * - **窄版**贴在座位卡外沿，**只有进度条没有读秒**。座位卡上本来就挤满了
 *   身份、体力、手牌数、装备、判定区、技能，再塞一个数字必定压到别的信息；
 *   别人家还剩多久是个「快到了 / 还早」的粗判断，一条进度条足够。
 * - **宽版**给自己用，带文字和大字读秒——要自己做决定的那个人才需要精确读数。
 *
 * 本身不定位，由父级决定摆在哪；这样座位卡（overflow:hidden）内部不必给它让位。
 * `serverNow` 由牌桌统一提供（已经用服务器时钟校正过）：八家各自开一个定时器
 * 既浪费又会各走各的，读数对不齐。
 */
const props = withDefaults(defineProps<{
  timer: SgsSeatTimer | null
  serverNow: number
  /** 宽版：给自己手牌上方那条用，带文字说明和大字读秒 */
  wide?: boolean
}>(), { wide: false })

const KIND_LABEL: Record<SgsSeatTimer['kind'], string> = {
  action: '出牌',
  response: '响应',
  claim: '抢答',
  'pick-general': '选将',
}

const totalMs = computed(() => (props.timer ? Math.max(1, props.timer.deadlineAt - props.timer.startedAt) : 1))
const remainingMs = computed(() => (props.timer ? Math.max(0, props.timer.deadlineAt - props.serverNow) : 0))
const seconds = computed(() => Math.ceil(remainingMs.value / 1000))
const ratio = computed(() => Math.min(1, remainingMs.value / totalMs.value))
/*
 * 紧张提示只给真人。AI 的名义窗口只是为了让牌桌上每一家的计时看起来是同一套，
 * 它几乎总是提前答完；给它闪红会让人以为电脑也快超时了。
 */
const urgent = computed(() => !!props.timer && !props.timer.ai && remainingMs.value <= 5_000)
const critical = computed(() => !!props.timer && !props.timer.ai && remainingMs.value <= 3_000)
const label = computed(() => (props.timer ? KIND_LABEL[props.timer.kind] : ''))
</script>

<template>
  <div
    v-if="timer"
    class="sgs-timer"
    :class="{
      'sgs-timer--wide': wide,
      'sgs-timer--ai': timer.ai,
      [`sgs-timer--${timer.kind}`]: true,
      'sgs-timer--urgent': urgent,
      'sgs-timer--critical': critical,
    }"
    role="timer"
    :aria-label="`${label}剩余 ${seconds} 秒`"
  >
    <i class="sgs-timer__track"><em :style="{ transform: `scaleX(${ratio})` }"></em></i>
    <b v-if="wide" class="sgs-timer__label">{{ label }}</b>
    <b v-if="wide" class="sgs-timer__seconds">{{ seconds }}</b>
  </div>
</template>

<style scoped>
/*
 * 不自带定位：窄版由座位槽位摆到卡外，宽版跟着牌桌的栅格走。
 * 之前是绝对定位贴在卡内顶边，为了不压住身份和昵称还得给头部加外边距，
 * 计时一出现整张卡的内容就往下跳一下。
 */
.sgs-timer {
  display: flex; align-items: center; gap: 8px;
  pointer-events: none; font-variant-numeric: tabular-nums;
  /* 局内统一橙色：牌桌上不需要靠颜色区分「这是响应还是出牌」，
     那件事提示语已经说了；颜色只留给「正常 / 快没了」这一个维度。 */
  --timer-color: #ffa53d;
}
.sgs-timer__track {
  flex: 1; min-width: 0; height: 4px; border-radius: 3px;
  background: rgba(6, 12, 9, .72); overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .5);
}
.sgs-timer__track em {
  display: block; height: 100%; border-radius: inherit;
  background: var(--timer-color); transform-origin: left center;
  /* 250ms 一跳，补间刚好抹平台阶又不至于让读数看起来滞后 */
  transition: transform .25s linear;
}
.sgs-timer__seconds {
  flex: none; color: var(--timer-color); font-weight: 800;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .9);
}
.sgs-timer__label { flex: none; color: var(--timer-color); font-size: 11px; font-weight: 700; }

/* 选将是开局前的另一件事，保留自己的颜色 */
.sgs-timer--pick-general { --timer-color: #9fd7ff; }
.sgs-timer--urgent { --timer-color: #ff8a72; }
.sgs-timer--critical { --timer-color: #ff5340; animation: sgs-timer-pulse .7s ease-in-out infinite; }

@keyframes sgs-timer-pulse { 50% { opacity: .45; } }

/* 宽版：自己手牌上方那条，是真正要盯着的那一个 */
.sgs-timer--wide { padding: 3px 10px 5px; }
.sgs-timer--wide .sgs-timer__track { height: 5px; }
.sgs-timer--wide .sgs-timer__seconds { min-width: 22px; text-align: right; font-size: 15px; }

@media (max-width: 700px) and (orientation: portrait) {
  .sgs-timer:not(.sgs-timer--wide) .sgs-timer__track { height: 3px; }
  .sgs-timer--wide { padding: 2px 10px 4px; }
  .sgs-timer--wide .sgs-timer__seconds { font-size: 14px; }
}
@media (orientation: landscape) and (max-height: 500px) {
  /* 横屏高度紧张：宽版压薄一点 */
  .sgs-timer--wide { padding: 1px 10px 3px; }
  .sgs-timer--wide .sgs-timer__track { height: 4px; }
  .sgs-timer--wide .sgs-timer__label { font-size: 10px; }
  .sgs-timer--wide .sgs-timer__seconds { font-size: 13px; }
}
@media (prefers-reduced-motion: reduce) {
  .sgs-timer--critical { animation: none; }
  .sgs-timer__track em { transition: none; }
}
</style>
