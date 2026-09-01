import { inject, provide, ref, type InjectionKey, type Ref } from 'vue'
import type { GlossaryEntry } from '../glossary'

export interface SgsGlossaryController {
  entry: Ref<GlossaryEntry | null>
  open(entry: GlossaryEntry | null): void
  close(): void
}

const KEY: InjectionKey<SgsGlossaryController> = Symbol('sgs-glossary')

export function provideSgsGlossary(): SgsGlossaryController {
  const entry = ref<GlossaryEntry | null>(null)
  const controller = { entry, open: (value: GlossaryEntry | null) => { if (value) entry.value = value }, close: () => { entry.value = null } }
  provide(KEY, controller)
  return controller
}

export function useSgsGlossary(): SgsGlossaryController | null {
  return inject(KEY, null)
}
