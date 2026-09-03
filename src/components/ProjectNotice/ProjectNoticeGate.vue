<script setup lang="ts">
import { ref } from 'vue'
import FirstVisitNotice from './FirstVisitNotice.vue'
import FullDisclaimerModal from './FullDisclaimerModal.vue'
import { hasAcceptedProjectNotice, markProjectNoticeAccepted } from '@/notice/noticeStorage'

/**
 * 全站首次访问门槛，挂在 `RootApp` 最外层，包住门户和两个游戏的整棵树。
 *
 * **这是这个功能最关键的一点**：默认插槽只在 `accepted` 为真时才会渲染
 * （`<slot v-if="accepted" />`）。Vue 的插槽内容是父组件传进来的一段渲染函数，
 * 子组件不调用它，里面的东西就完全不会挂载——`RootApp` 原来的路由判断、
 * 麻将/三国杀的 `App.vue`/`SanguoshaApp.vue`（它们在 `setup()` 里同步读取
 * `?room=` 决定要不要自动连房间）都在这段插槽里，所以在用户点「我知道了」
 * 之前，它们根本不会实例化，也就谈不上重复建房、误连 WebSocket。
 *
 * 全程不碰 URL：不读、不改、不重定向。`accepted` 变成 true 之后，
 * 插槽内容按它原本该有的样子渲染，用的还是同一个 `window.location.href`。
 */
const accepted = ref(hasAcceptedProjectNotice())
const stage = ref<'first-visit' | 'full-disclaimer'>('first-visit')

function accept(): void {
  markProjectNoticeAccepted()
  accepted.value = true
}
</script>

<template>
  <slot v-if="accepted" />
  <template v-else>
    <!--
      first-visit 和 full-disclaimer 互斥渲染（v-if / v-else），同一时刻只有
      一层遮罩存在——「查看完整声明」不是叠一层新弹窗上去，而是替换当前这层。
      这样不会出现两层半透明黑背景叠加变得更黑的问题，关掉完整声明也是
      单纯切回首次弹窗，不会有多余的开合动画抖一下。
    -->
    <FirstVisitNotice
      v-if="stage === 'first-visit'"
      @accept="accept"
      @view-full="stage = 'full-disclaimer'"
    />
    <FullDisclaimerModal v-else @close="stage = 'first-visit'" />
  </template>
</template>
