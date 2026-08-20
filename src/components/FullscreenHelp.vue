<script setup lang="ts">
import { computed, ref } from 'vue'

const open = ref(false)

// 已经是「添加到主屏幕」启动的，本来就没有地址栏，不用再教一遍
const installed = computed(() => (
  window.matchMedia('(display-mode: standalone)').matches
  || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
))

// Android Chrome 能直接进全屏，iPhone 的 Safari 从来没开放过这个接口
const canFullscreen = computed(() => typeof document.documentElement.requestFullscreen === 'function')

const isIOS = computed(() => (
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  // iPadOS 13 起 UA 伪装成 Mac，靠触摸点数区分
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
))

async function goFullscreen() {
  try {
    await document.documentElement.requestFullscreen()
    open.value = false
  } catch {
    // 被拒绝就把说明留着，让人自己按步骤来
  }
}
</script>

<template>
  <div v-if="!installed" class="fs-help">
    <button class="fs-trigger" type="button" @click="open = true">全屏</button>

    <Teleport to="body">
      <div v-if="open" class="fs-mask" @click="open = false"></div>
      <section v-if="open" class="fs-card">
        <header><strong>全屏玩</strong><button type="button" @click="open = false">×</button></header>

        <template v-if="canFullscreen">
          <p class="fs-lead">这台设备可以直接进全屏。</p>
          <button class="fs-primary" type="button" @click="goFullscreen">立即全屏</button>
          <p class="fs-note">退出按一下手机的返回键，或者再点一次牌桌右上角的全屏按钮。</p>
        </template>

        <template v-else-if="isIOS">
          <p class="fs-lead">iPhone 的 Safari 不开放网页全屏，但可以把它装到桌面上，启动后就没有地址栏了，和 App 一样。</p>
          <ol class="fs-steps">
            <li>点底部工具栏中间的<b>分享</b>按钮（方框向上箭头）</li>
            <li>往下翻，选<b>添加到主屏幕</b></li>
            <li>右上角点<b>添加</b></li>
            <li>回到桌面，从新出现的图标打开</li>
          </ol>
          <p class="fs-note">用微信里的浏览器打不开这个菜单，得先在 Safari 里打开本站。</p>
        </template>

        <template v-else>
          <p class="fs-lead">把它装到桌面上，启动后就没有地址栏了。</p>
          <ol class="fs-steps">
            <li>点浏览器右上角的<b>菜单</b>（三个点）</li>
            <li>选<b>添加到主屏幕</b>或<b>安装应用</b></li>
            <li>回到桌面，从新出现的图标打开</li>
          </ol>
        </template>
      </section>
    </Teleport>
  </div>
</template>

<style scoped>
.fs-help { position: absolute; right: 0; top: 0; }
.fs-trigger {
  padding: 7px 13px;
  border: 1px solid #345047; border-radius: 99px;
  background: rgba(16, 37, 31, .8); color: #c8bc94;
  font-size: 11px; cursor: pointer;
}
.fs-mask { position: fixed; z-index: 95; inset: 0; background: rgba(0,0,0,.55); }
.fs-card {
  position: fixed; z-index: 96;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 36px));
  max-height: 82dvh;
  overflow-y: auto;
  padding: 20px 22px;
  border: 1px solid #496258; border-radius: 18px;
  background: #10251f;
  box-shadow: 0 22px 60px rgba(0,0,0,.5);
  color: #e9e1ca;
}
.fs-card header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.fs-card header strong { font-size: 16px; color: #f3d67c; }
.fs-card header button { width: 30px; height: 30px; padding: 0; border: 1px solid #3b564d; border-radius: 50%; background: #18342c; color: #e8dbc0; cursor: pointer; }
.fs-lead { margin: 0 0 14px; color: #b9c7c1; font-size: 13px; line-height: 1.7; }
.fs-primary {
  width: 100%; padding: 13px;
  border: 0; border-radius: 12px;
  background: #e5c66d; color: #20261d;
  font-size: 15px; font-weight: 800; cursor: pointer;
}
.fs-steps { margin: 0; padding-left: 20px; display: grid; gap: 9px; }
.fs-steps li { color: #b9c7c1; font-size: 13px; line-height: 1.6; }
.fs-steps b { color: #f0d68a; }
.fs-note { margin: 14px 0 0; color: #74897f; font-size: 11px; line-height: 1.6; }

@media (max-width: 700px) {
  .fs-trigger { padding: 6px 11px; font-size: 10px; }
  .fs-card { padding: 16px 18px; }
}
</style>
