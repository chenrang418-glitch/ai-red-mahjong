import type { PresentationEventKind } from '../engine/presentation'

export const AI_PACE_MS = { fast: 450, normal: 700, relaxed: 1000 } as const
export const AI_TRIVIAL_STEP_MS = 60
export const AI_PICK_GENERAL_MS = 150

const PRESENTATION_DURATION_MS: Record<PresentationEventKind, number> = {
  death: 1200, dying: 1050, damage: 900, 'lose-hp': 800, judge: 800,
  skill: 700, recover: 700, 'card-use': 620, 'card-response': 620,
  'turn-start': 420, draw: 380, discard: 380, equipment: 380, status: 340,
}

export function presentationDuration(kind: PresentationEventKind, backlog: number): number {
  const scale = backlog > 6 ? 0.52 : backlog >= 4 ? 0.75 : 1
  return Math.max(220, Math.round(PRESENTATION_DURATION_MS[kind] * scale))
}

export function phaseDelay(aiDelayMs: number): number {
  return aiDelayMs <= 0 ? 0 : Math.min(360, Math.max(180, Math.round(aiDelayMs / 2)))
}

/**
 * AI **主动出牌**这一步的停顿。
 *
 * 和响应牌分开算，这是关键：无懈可击、桃、闪这些是被动接话，节奏快反而顺，
 * 而且它们各自的询问窗口有规则约束，不能乱动。真正让人跟不上的是
 * AI 主动出牌——谁对谁用了什么牌、触发了什么技能，是牌桌上信息量最大的一步，
 * 700ms 里牌面刚飞出去就已经进入下一个人的操作了。
 *
 * 所以按整体节奏放慢好几倍，并压一个下限：即使玩家选了「明快」，
 * 主动出牌也不会快到看不清。标准档 700ms → 3080ms。
 */
export function playActionDelay(aiDelayMs: number): number {
  if (aiDelayMs <= 0) return 0
  return Math.min(4_800, Math.max(1_800, Math.round(aiDelayMs * 4.4)))
}
