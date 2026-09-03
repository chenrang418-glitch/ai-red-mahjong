import { readonly, ref } from 'vue'

/**
 * 全站服务状态（维护开关、停服开关、常驻公告）的**唯一**来源。
 *
 * 三个消费方各有各的用法，但读的必须是同一份，否则会出现
 * 「门户说在维护、三国杀大厅说没在维护」这种自相矛盾的界面：
 *
 * - `RootApp`：停服时整站只显示一段红字；有公告时在最顶上挂一条红色横幅。
 * - 麻将大厅、三国杀大厅：把「创建房间」灰掉并改成「维护中」。
 *
 * 状态放在模块级而不是 composable 内部：同一个页面里三处调用只发一次请求，
 * 也不会出现各自轮询各自过期的情况。
 */

export interface ServiceStatus {
  /** 轻维护：只拦「开新房」，已有牌局和重连不受影响。 */
  maintenance: boolean
  maintenanceMessage: string
  /** 重维护：整站停服，玩家只看得到 siteClosedMessage。 */
  siteClosed: boolean
  siteClosedMessage: string
  /** 常驻公告。空字符串表示不显示横幅——**不要给它兜底默认值**。 */
  notice: string
  /** 「联系开发者」弹窗用的联系方式，管理员在后台填。空串时调用方自己兜底。 */
  contactMethod: string
  contactValue: string
}

const EMPTY: ServiceStatus = {
  maintenance: false,
  maintenanceMessage: '',
  siteClosed: false,
  siteClosedMessage: '',
  notice: '',
  contactMethod: '',
  contactValue: '',
}

/** 多久重新拉一次。管理员改了设置之后，已经打开着页面的人也要跟上。 */
const REFRESH_MS = 60_000

const status = ref<ServiceStatus>({ ...EMPTY })
/** 请求发出去过没有。用来区分「确实没在维护」和「还没问过」。 */
const loaded = ref(false)
let inflight: Promise<void> | null = null
let timer: number | null = null
let subscribers = 0

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_ONLINE_API_BASE?.trim().replace(/\/$/, '')
  if (configured) return configured
  // 本地联机必须用 127.0.0.1：会话 Cookie 是 SameSite=Lax，
  // localhost:5190 → 127.0.0.1:8787 属于跨站，Cookie 发不出去
  if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) return 'http://127.0.0.1:8787'
  return window.location.origin
}

function normalize(input: Partial<ServiceStatus>): ServiceStatus {
  return {
    maintenance: input.maintenance === true,
    maintenanceMessage: typeof input.maintenanceMessage === 'string' ? input.maintenanceMessage : '',
    siteClosed: input.siteClosed === true,
    siteClosedMessage: typeof input.siteClosedMessage === 'string' ? input.siteClosedMessage : '',
    notice: typeof input.notice === 'string' ? input.notice : '',
    contactMethod: typeof input.contactMethod === 'string' ? input.contactMethod : '',
    contactValue: typeof input.contactValue === 'string' ? input.contactValue : '',
  }
}

/**
 * 拉一次服务状态。
 *
 * **失败一律按「一切正常」处理**：接口挂了不该顺带把单机游戏也堵死，
 * 更不该在读不到设置时把整站显示成停服。
 */
export async function refreshServiceStatus(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const response = await fetch(`${resolveApiBase()}/api/service`, { credentials: 'include' })
      if (!response.ok) throw new Error(String(response.status))
      status.value = normalize(await response.json() as Partial<ServiceStatus>)
    } catch {
      status.value = { ...EMPTY }
    } finally {
      loaded.value = true
      inflight = null
    }
  })()
  return inflight
}

/**
 * 订阅服务状态。返回的 `stop` 必须在组件卸载时调用——
 * 最后一个订阅者走了才停轮询，否则页面切来切去会留下一堆定时器。
 */
export function useServiceStatus() {
  function start(): void {
    subscribers += 1
    void refreshServiceStatus()
    if (timer === null) {
      timer = window.setInterval(() => { void refreshServiceStatus() }, REFRESH_MS)
    }
  }

  function stop(): void {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  return { status: readonly(status), loaded: readonly(loaded), start, stop, refresh: refreshServiceStatus }
}
