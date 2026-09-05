<script setup lang="ts">
import { ref } from 'vue'
import FullDisclaimerModal from '@/components/ProjectNotice/FullDisclaimerModal.vue'
import ContactDeveloperModal from '@/components/ProjectNotice/ContactDeveloperModal.vue'
import { FOOTER_COPYRIGHT, FOOTER_DISCLAIMER_LINK, FOOTER_CONTACT_LINK, FOOTER_LINE_1, FOOTER_LINE_2 } from '@/notice/noticeContent'

/**
 * 游戏中心主页面的底部信息条。
 *
 * 这是除首次访问弹窗以外，**唯一**长期展示项目声明入口的地方——
 * 麻将、纸上三国内部一律不加。两个弹窗组件和首次弹窗里「查看完整声明」
 * 用的是同一份 `FullDisclaimerModal`，内容只维护一份。
 */
const showDisclaimer = ref(false)
const showContact = ref(false)
</script>

<template>
  <footer class="site-footer">
    <p class="site-footer__line1">{{ FOOTER_LINE_1 }}</p>
    <p class="site-footer__line2">{{ FOOTER_LINE_2 }}</p>
    <p class="site-footer__links">
      <button type="button" @click="showDisclaimer = true">{{ FOOTER_DISCLAIMER_LINK }}</button>
      <span aria-hidden="true">·</span>
      <button type="button" @click="showContact = true">{{ FOOTER_CONTACT_LINK }}</button>
    </p>
    <p class="site-footer__copyright">{{ FOOTER_COPYRIGHT }}</p>
  </footer>

  <FullDisclaimerModal v-if="showDisclaimer" @close="showDisclaimer = false" />
  <ContactDeveloperModal v-if="showContact" @close="showContact = false" />
</template>

<style scoped>
/*
 * 弱信息层：不能和上面的游戏选择区抢视觉权重。靠更大的顶部间距、
 * 极淡的分隔线和逐行降低的文字亮度把它和主内容自然分开，
 * 不做成独立卡片、不加厚重背景。
 */
.site-footer {
  flex: none;
  margin-top: clamp(18px, 4vh, 34px);
  padding-top: 14px;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  border-top: 1px solid rgba(61, 83, 71, .5);
  text-align: center;
}

.site-footer p { margin: 0; }

.site-footer__line1 {
  color: var(--ink-text-soft);
  font-size: 12px;
  letter-spacing: .02em;
}
.site-footer__line2 {
  margin-top: 4px;
  color: var(--ink-text-muted);
  font-size: 11px;
}
.site-footer__links {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 11px;
}
.site-footer__links span { color: #4a5850; }
.site-footer__links button {
  padding: 2px 3px;
  border: none;
  background: none;
  color: var(--ink-text-muted);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.site-footer__links button:hover { color: var(--ink-text-soft); }
.site-footer__links button:focus-visible { outline: 2px solid var(--accent-gold); outline-offset: 2px; border-radius: 4px; }

.site-footer__copyright {
  margin-top: 8px;
  color: #4a5850;
  font-size: 10px;
  letter-spacing: .06em;
}

@media (max-width: 820px) and (orientation: portrait) {
  .site-footer { margin-top: 16px; padding-top: 12px; }
}

@media (max-height: 620px) and (orientation: landscape) {
  .site-footer { margin-top: 10px; padding-top: 8px; }
  .site-footer__line1 { font-size: 11px; }
  .site-footer__line2 { display: none; }
  .site-footer__links { margin-top: 5px; }
  .site-footer__copyright { margin-top: 5px; }
}
</style>
