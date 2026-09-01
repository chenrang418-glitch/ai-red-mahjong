import { getCurrentInstance, onBeforeUnmount, shallowRef, watch } from 'vue'
import type { PresentationEvent, PresentationEventKind } from '../engine/presentation'

/**
 * 表现事件的播放队列。
 *
 * 之前界面直接取 `presentationEvents.at(-1)`，实测跑完整局暴露两个问题：
 *
 * - **48.7% 的推进不产生任何表现事件**（判定、弃牌、阶段流转）。事件 id 不变，
 *   于是「杀」的指向箭头和舞台横幅一直挂在屏幕上，直到下一个带来源和目标的
 *   事件把它顶掉——可能是好几秒之后。事件必须有寿命，播完自己消失。
 * - **5.9% 的推进一次产生多条**，只有最后一条会被渲染。抓到的典型序列是
 *   `damage → dying`：掉血数字恰恰在致死一击时被吞掉，而那正是最该看见的反馈。
 *
 * 所以这里按到达顺序逐条播放，每条播完自动清空。
 *
 * 队列只消费事件，不参与牌局推进——引擎和动画之间是单向的，这条不能破。
 */

export type EventSkin = 'strike' | 'heal' | 'dodge' | 'judge' | 'nullify' | 'plain'

export interface StagedEvent {
  event: PresentationEvent
  skin: EventSkin
  /** 无懈可击连锁的第几环，从 1 起；不在连锁里时为 0。 */
  chainDepth: number
}

/** 每类事件在舞台上停留多久。重要的慢，流水账快。 */
const DURATION: Record<PresentationEventKind, number> = {
  death: 1200,
  dying: 1050,
  damage: 900,
  'lose-hp': 800,
  judge: 800,
  skill: 700,
  recover: 700,
  'card-use': 620,
  'card-response': 620,
  'turn-start': 420,
  draw: 380,
  discard: 380,
  equipment: 380,
  status: 340,
}

/**
 * 积压时的取舍权重：2 绝不丢，1 尽量留，0 可以直接扔。
 *
 * AI 一步只有 450~950ms，而一次可能到达好几条。不丢就会越积越多，
 * 动画和实际牌局脱节——那比现在「只显示最后一条」更糟。
 */
const WEIGHT: Record<PresentationEventKind, 0 | 1 | 2> = {
  death: 2, dying: 2, damage: 2, 'lose-hp': 2, recover: 2,
  judge: 1, skill: 1, 'card-use': 1, 'card-response': 1, 'turn-start': 1,
  draw: 0, discard: 0, equipment: 0, status: 0,
}

/** 超过这个积压条数就开始按权重丢弃。 */
const MAX_BACKLOG = 4

function skinOf(event: PresentationEvent): EventSkin {
  if (event.cardName === '无懈可击') return 'nullify'
  if (event.kind === 'card-response' && event.cardName === '闪') return 'dodge'
  if (event.kind === 'judge') return 'judge'
  if (event.kind === 'damage' || event.kind === 'lose-hp' || event.kind === 'dying' || event.kind === 'death') return 'strike'
  if (event.kind === 'recover') return 'heal'
  return 'plain'
}

export function useSgsEventStage(source: () => readonly PresentationEvent[]) {
  const staged = shallowRef<StagedEvent | null>(null)
  let queue: PresentationEvent[] = []
  let lastSeenId: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function stopTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function compress(): void {
    for (const floor of [0, 1] as const) {
      while (queue.length > MAX_BACKLOG) {
        const index = queue.findIndex((event) => WEIGHT[event.kind] === floor)
        if (index < 0) break
        queue.splice(index, 1)
      }
    }
  }

  function show(event: PresentationEvent): void {
    const skin = skinOf(event)
    // 无懈连锁要能看出打到第几环了，否则一串无懈在界面上完全一样
    const previous = staged.value
    const chainDepth = skin === 'nullify'
      ? (previous?.skin === 'nullify' ? previous.chainDepth + 1 : 1)
      : 0
    staged.value = { event, skin, chainDepth }
    timer = setTimeout(pump, DURATION[event.kind] ?? 500)
  }

  function pump(): void {
    stopTimer()
    const next = queue.shift()
    // 队列空了就清空舞台，箭头和横幅不再赖着不走
    if (!next) { staged.value = null; return }
    show(next)
  }

  /**
   * 立即把积压跳过，只留最后一条。
   *
   * 轮到玩家操作时调用：动画绝不能挡着操作，但最后一条通常正是他要响应的东西
   * （比如别人对他使用的【杀】），所以留下而不是一并清掉。
   */
  function skip(): void {
    if (!queue.length) return
    const last = queue[queue.length - 1]
    queue = []
    stopTimer()
    show(last)
  }

  /**
   * 变更令牌。
   *
   * 不能直接 watch 数组本身：单机是往同一个数组里 push，引用从不变化；
   * 也不能只看长度，联机那份被截在 30 条，满了之后长度就永远是 30。
   * 末条 id 才是真正会变的东西。
   */
  const token = () => {
    const events = source()
    return `${events.length}:${events[events.length - 1]?.id ?? ''}`
  }

  watch(token, () => {
    const events = source()
    if (lastSeenId === null) {
      // 首次看到（含联机重连时一次性拿到整段历史）：只认最后一条，不回放 30 条
      const last = events[events.length - 1]
      lastSeenId = last?.id ?? null
      if (last) { stopTimer(); show(last) }
      return
    }
    const seenIndex = events.findIndex((event) => event.id === lastSeenId)
    // 找不到说明旧事件已经被上限截掉了，此时只取末尾一小段，不整段重放
    const incoming = seenIndex >= 0 ? events.slice(seenIndex + 1) : events.slice(-MAX_BACKLOG)
    if (!incoming.length) return
    lastSeenId = incoming[incoming.length - 1].id
    queue.push(...incoming)
    compress()
    if (timer === null) pump()
    // 同步刷新：动画不该比事件慢一个 tick，处理器本身只是给一个 shallowRef 赋值
  }, { immediate: true, flush: 'sync' })

  if (getCurrentInstance()) onBeforeUnmount(stopTimer)

  return { staged, skip, stop: stopTimer }
}
