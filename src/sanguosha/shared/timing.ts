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
