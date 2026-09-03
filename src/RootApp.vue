<script setup lang="ts">
import { computed, onBeforeUnmount, onErrorCaptured, onMounted, ref, shallowRef, watch } from 'vue'
import GamePortal from '@/portal/GamePortal.vue'
import { gameManifest, playableGames, type GameDefinition } from '@/portal/gameManifest'
import { buildGameUrl, buildPortalUrl, isAdminRoute, resolveAppRoute } from '@/portal/navigation'
import { LatestGameLoader } from '@/portal/gameLoader'
import { useServiceStatus } from '@/composables/useServiceStatus'
import ProjectNoticeGate from '@/components/ProjectNotice/ProjectNoticeGate.vue'
import type { Component } from 'vue'

const route = ref(resolveAppRoute(new URL(window.location.href)))
const adminRoute = ref(isAdminRoute(new URL(window.location.href)))

/*
 * 全站停服和常驻公告都在这一层处理，而不是各游戏里各写一份：
 * 门户、麻将、三国杀共用同一个入口，才不会出现「门户说在维护、
 * 三国杀大厅说没在维护」这种自相矛盾的界面。
 */
const service = useServiceStatus()
const noticeEl = ref<HTMLElement | null>(null)
let noticeObserver: ResizeObserver | null = null

/** 管理页永远放行——停服开关就是在那里关掉的。 */
const siteClosed = computed(() => service.status.value.siteClosed && !adminRoute.value)
const notice = computed(() => (siteClosed.value ? '' : service.status.value.notice.trim()))

/**
 * 把横幅的实际高度写回 `--app-viewport-offset`。
 *
 * 不能写死一个常数：公告文案在手机上会换行，写死就会让牌桌高度算错，
 * 手机上直接多出一条可以滚动的空白。没有公告时必须清成 0px，
 * 否则每个 100dvh 的容器都会平白矮一截。
 */
function syncNoticeOffset(): void {
  const height = noticeEl.value?.offsetHeight ?? 0
  document.documentElement.style.setProperty('--app-viewport-offset', `${height}px`)
}
const activeComponent = shallowRef<Component | null>(null)
const loading = ref(false)
const loadError = ref('')
const fatalRuntimeError = ref('')
const gameLoader = new LatestGameLoader<{ default: Component }>(15_000)

const activeGame = computed<GameDefinition | null>(() => {
  if (route.value.kind !== 'game') return null
  return playableGames.get(route.value.gameId) ?? null
})

function syncRoute() {
  const url = new URL(window.location.href)
  route.value = resolveAppRoute(url)
  adminRoute.value = isAdminRoute(url)
  // 从管理页切走时可能刚好赶上停服，重新问一次比等下一次轮询及时
  void service.refresh()
}

function navigate(url: URL) {
  window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`)
  syncRoute()
}

function openGame(game: GameDefinition) {
  if (!game.enabled || !game.loadApp || game.id === 'more') return
  navigate(buildGameUrl(new URL(window.location.href), game.id))
}

function returnToPortal() {
  navigate(buildPortalUrl(new URL(window.location.href)))
}

async function loadActiveGame(game: GameDefinition | null) {
  gameLoader.dispose()
  activeComponent.value = null
  loadError.value = ''
  if (!game?.loadApp) { loading.value = false; return }
  loading.value = true
  const result = await gameLoader.load(game.loadApp)
  if (result.status === 'stale') return
  if (result.status === 'success') activeComponent.value = result.value.default
  else loadError.value = import.meta.env.DEV && result.error instanceof Error
    ? `游戏加载失败：${result.error.message}`
    : '游戏加载失败，请重试。'
  loading.value = false
}

function retryLoad() {
  fatalRuntimeError.value = ''
  void loadActiveGame(activeGame.value)
}

window.addEventListener('popstate', syncRoute)
window.addEventListener('hashchange', syncRoute)

onMounted(() => {
  service.start()
  noticeObserver = new ResizeObserver(syncNoticeOffset)
})

onBeforeUnmount(() => {
  gameLoader.dispose()
  service.stop()
  noticeObserver?.disconnect()
  noticeObserver = null
  document.documentElement.style.removeProperty('--app-viewport-offset')
  window.removeEventListener('popstate', syncRoute)
  window.removeEventListener('hashchange', syncRoute)
})

// 横幅出现或消失时接上/断开测量，并立刻同步一次高度
watch(noticeEl, (el) => {
  noticeObserver?.disconnect()
  if (el) noticeObserver?.observe(el)
  syncNoticeOffset()
})

watch(activeGame, (game) => { void loadActiveGame(game) }, { immediate: true })

onErrorCaptured((cause) => {
  fatalRuntimeError.value = import.meta.env.DEV && cause instanceof Error
    ? `游戏运行异常：${cause.message}`
    : '游戏发生异常，请返回游戏中心后重试。'
  // 返回 false：错误已经转成 RootApp 的受控状态，不再让全局 handler 手动碰 DOM。
  return false
})
</script>

<template>
  <!--
    全站首次访问门槛必须包在最外层、其它一切之前：门户、麻将、三国杀
    的自动建房/加房逻辑都在下面这棵树里，用户点「我知道了」之前
    这棵树根本不会挂载，也就不存在「弹窗还没关就已经在联机了」。
  -->
  <ProjectNoticeGate>
    <!--
      全站停服：整屏只剩管理员那段红字，没有任何进入游戏的入口。
      这和「维护中不能开新房」是两回事，后者只灰掉一个按钮。
    -->
    <main v-if="siteClosed" class="site-closed" role="alert">
      <section>
        <span class="site-closed__brand">CR</span>
        <h1>网站维护中</h1>
        <p>{{ service.status.value.siteClosedMessage || '全站正在维护升级，暂时无法访问，请稍后再来。' }}</p>
        <small>维护结束后刷新页面即可继续游戏。</small>
      </section>
    </main>

    <template v-else>
      <!-- 常驻公告：门户和两款游戏共用这一条，永远在最上方 -->
      <div v-if="notice" ref="noticeEl" class="admin-notice" role="status">
        <span class="admin-notice__tag">公告</span>
        <span>{{ notice }}</span>
      </div>

      <GamePortal v-if="route.kind === 'portal'" :games="gameManifest" @select="openGame" />

      <main v-else-if="loading" class="root-loading" aria-live="polite">
        <span>CR</span>
        <p>正在载入{{ activeGame?.name }}…</p>
      </main>

      <main v-else-if="fatalRuntimeError || loadError || !activeComponent" class="root-error">
        <section role="alert">
          <span>CR</span>
          <h1>游戏发生异常</h1>
          <p>{{ fatalRuntimeError || loadError || '未找到这个游戏。' }}</p>
          <div>
            <button type="button" @click="retryLoad">重新加载</button>
            <button type="button" @click="returnToPortal">返回游戏中心</button>
          </div>
        </section>
      </main>

      <component :is="activeComponent" v-else @back-to-portal="returnToPortal" />
    </template>
  </ProjectNoticeGate>
</template>
