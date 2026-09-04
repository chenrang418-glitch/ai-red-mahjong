<script setup lang="ts">
import { computed } from 'vue'
import { factionDefinition, type Faction } from '../shared/factions'

const props = withDefaults(defineProps<{ faction: Faction; variant?: 'battle' | 'pick' }>(), { variant: 'battle' })
const definition = computed(() => factionDefinition(props.faction)!)
const badgeVars = computed(() => ({
  '--faction-color': definition.value.color,
  '--faction-text': definition.value.textColor,
  '--faction-border': definition.value.borderColor,
}))
</script>

<template>
  <span class="sgs-faction-badge" :class="`sgs-faction-badge--${variant}`" :style="badgeVars" :aria-label="`${definition.name}势力`">{{ definition.name }}</span>
</template>

<style scoped>
/*
 * 势力角标的书法字体。
 *
 * 原本只写了 "STXingkai" / "华文行楷" / KaiTi 这些**本机系统字体**：
 * Windows 上装着，所以电脑端是书法体；iOS / Android 一个都没有，
 * 退到 generic 的 cursive，中文下就是普通字体——手机上看到的就是这个。
 * 不是浏览器不兼容，是字体压根不在设备上。
 *
 * 所以自带一份。用开源的 Ma Shan Zheng（马善政毛笔楷书，SIL OFL 1.1），
 * 并且**只子集角标真正用到的六个字**「魏蜀吴群晋神」，woff2 之后 3.9 KB。
 * unicode-range 也框死在这六个字上，绝不会影响页面上别的文字。
 *
 * 必须自托管，不能用 Google Fonts CDN——那个域名在国内打不开，
 * 正好对使用者本人失效。
 */
@font-face {
  font-family: "SgsFactionScript";
  src: url("../assets/fonts/mashanzheng-faction-subset.woff2") format("woff2");
  font-weight: 400; font-style: normal;
  /* 字体没到位时先用兜底字体显示，不留空白 */
  font-display: swap;
  unicode-range: U+9B4F, U+8700, U+5434, U+7FA4, U+664B, U+795E;
}

.sgs-faction-badge {
  box-sizing: border-box; min-width: 24px; height: 22px; display: inline-grid; place-items: center;
  padding: 0 7px; border: 1px solid var(--faction-border); border-radius: 7px;
  background: var(--faction-color); color: var(--faction-text);
  box-shadow: 0 1px 5px rgba(0, 0, 0, .38); font: 600 13px/1 "STXingkai", "华文行楷", "FZShuTi", "方正舒体", "SgsFactionScript", KaiTi, cursive;
  letter-spacing: .06em; white-space: nowrap; pointer-events: none;
}
.sgs-faction-badge--pick { font-size: 15px; }
@media (max-width: 820px), (orientation: landscape) and (max-height: 500px) {
  .sgs-faction-badge { min-width: 20px; height: 18px; padding: 0 5px; border-radius: 6px; font-size: 12px; }
  .sgs-faction-badge--pick { font-size: 14px; }
}
</style>
