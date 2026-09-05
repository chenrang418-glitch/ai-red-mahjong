import { reactive } from 'vue'
import type { GameEvent, GameState } from '@/game/types'
import { haptics, vibrationSupported } from './useHaptics'

export { vibrationSupported } from './useHaptics'

const MUSIC_URL = new URL('../assets/audio/mahjong-bgm.mp3', import.meta.url).href
const EFFECT_URLS = {
  dice: new URL('../assets/audio/mahjong-dice.mp3', import.meta.url).href,
  win: new URL('../assets/audio/victory.mp3', import.meta.url).href,
  loss: new URL('../assets/audio/defeat.mp3', import.meta.url).href,
} as const

type AudioSettingKey = 'musicEnabled' | 'effectsEnabled' | 'musicVolume' | 'effectsVolume' | 'vibrateEnabled'

interface GameAudioSettings {
  musicEnabled: boolean
  effectsEnabled: boolean
  musicVolume: number
  effectsVolume: number
  // 震动和声音都算「手感反馈」，放一起管，不用再开一套设置
  vibrateEnabled: boolean
}

const STORAGE_KEY = 'red-mahjong-audio-v1'
const LEGACY_STORAGE_KEY = atob('Z3VhbmdzaGFuLW1haGpvbmctYXVkaW8tdjE=')
const defaults: GameAudioSettings = {
  musicEnabled: true,
  effectsEnabled: true,
  // 默认拉满，进来就听得到；嫌吵可以在声音面板里随时调低，调过一次就会记住。
  musicVolume: 1,
  effectsVolume: 1,
  vibrateEnabled: true,
}

function loadSettings(): GameAudioSettings {
  try {
    const current = localStorage.getItem(STORAGE_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_STORAGE_KEY)
    const saved = JSON.parse(current ?? legacy ?? '{}') as Partial<GameAudioSettings>
    if (legacy) {
      localStorage.setItem(STORAGE_KEY, legacy)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
    return {
      musicEnabled: typeof saved.musicEnabled === 'boolean' ? saved.musicEnabled : defaults.musicEnabled,
      effectsEnabled: typeof saved.effectsEnabled === 'boolean' ? saved.effectsEnabled : defaults.effectsEnabled,
      musicVolume: clampVolume(typeof saved.musicVolume === 'number' ? saved.musicVolume : defaults.musicVolume),
      effectsVolume: clampVolume(typeof saved.effectsVolume === 'number' ? saved.effectsVolume : defaults.effectsVolume),
      vibrateEnabled: typeof saved.vibrateEnabled === 'boolean' ? saved.vibrateEnabled : defaults.vibrateEnabled,
    }
  } catch {
    return { ...defaults }
  }
}

export const gameAudioSettings = reactive<GameAudioSettings>(loadSettings())
haptics.setEnabled(gameAudioSettings.vibrateEnabled)

let context: AudioContext | null = null
let noiseBuffer: AudioBuffer | null = null
let masterGain: GainNode | null = null
let musicGain: GainNode | null = null
let effectsGain: GainNode | null = null
let musicBuffer: AudioBuffer | null = null
let musicLoading: Promise<void> | null = null
let musicSource: AudioBufferSourceNode | null = null
const effectBuffers = new Map<keyof typeof EFFECT_URLS, AudioBuffer>()
let effectsLoading: Promise<void> | null = null
let activeMatchId = ''
const processedEvents = new Set<string>()

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(gameAudioSettings)) } catch { /* 声音设置保存失败不影响对局 */ }
}

function clampVolume(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

function syncGains() {
  if (!context || !masterGain || !musicGain || !effectsGain) return
  const now = context.currentTime
  masterGain.gain.cancelScheduledValues(now)
  musicGain.gain.cancelScheduledValues(now)
  effectsGain.gain.cancelScheduledValues(now)
  masterGain.gain.setValueAtTime(1, now)
  musicGain.gain.setValueAtTime(gameAudioSettings.musicEnabled ? clampVolume(gameAudioSettings.musicVolume) : 0, now)
  effectsGain.gain.setValueAtTime(gameAudioSettings.effectsEnabled ? clampVolume(gameAudioSettings.effectsVolume) : 0, now)
}

function ensureContext(): AudioContext | null {
  if (context) return context
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null
  context = new AudioContextClass()
  masterGain = context.createGain()
  musicGain = context.createGain()
  effectsGain = context.createGain()
  musicGain.connect(masterGain)
  effectsGain.connect(masterGain)
  masterGain.connect(context.destination)
  syncGains()
  noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.16), context.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
  return context
}

// 手机切到别的应用或别的标签页时，浏览器会挂起（iOS 上是 interrupted）音频上下文。
// 回到页面后必须显式恢复并重设增益，否则整局都是哑的——而且这时候
// 不能依赖「音乐正在放」之类的前置条件，音效同样要靠它救回来。
function resumeAudio() {
  const audio = ensureContext()
  if (!audio) return
  if (audio.state === 'running') {
    syncGains()
    return
  }
  void audio.resume().then(() => {
    syncGains()
    if (activeMatchId) startMusic()
  }).catch(() => undefined)
}

function unlock() {
  resumeAudio()
}

function tone(
  frequency: number,
  start: number,
  duration: number,
  volume: number,
  wave: OscillatorType = 'sine',
  channel: 'music' | 'effects' = 'effects',
) {
  if (!context) return
  const output = channel === 'music' ? musicGain : effectsGain
  if (!output) return
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = wave
  oscillator.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain).connect(output)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.03)
}

function noise(start: number, duration: number, volume: number, lowPass = 1700) {
  if (!context || !noiseBuffer || !effectsGain) return
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  source.buffer = noiseBuffer
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(lowPass, start)
  gain.gain.setValueAtTime(Math.max(0.0001, volume), start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  source.connect(filter).connect(gain).connect(effectsGain)
  source.start(start)
  source.stop(start + duration)
}

type EffectName = 'dice' | 'draw' | 'discard' | 'peng' | 'gang' | 'win' | 'loss'

function loadRecordedAudio() {
  const audio = ensureContext()
  if (!audio) return
  if (!musicBuffer && !musicLoading) {
    musicLoading = fetch(MUSIC_URL)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((data) => audio.decodeAudioData(data))
      .then((buffer) => { musicBuffer = buffer })
      .catch(() => undefined)
      .finally(() => { musicLoading = null })
  }
  if (effectBuffers.size < Object.keys(EFFECT_URLS).length && !effectsLoading) {
    effectsLoading = Promise.all(Object.entries(EFFECT_URLS).map(([name, url]) => fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((data) => audio.decodeAudioData(data))
      .then((buffer) => { effectBuffers.set(name as keyof typeof EFFECT_URLS, buffer) })))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => { effectsLoading = null })
  }
}

function playRecordedEffect(effect: EffectName, start: number): boolean {
  if (effect !== 'dice' && effect !== 'win' && effect !== 'loss') return false
  const buffer = effectBuffers.get(effect)
  if (!buffer || !context || !effectsGain) return false
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(effectsGain)
  source.start(start)
  return true
}

function playEffect(effect: EffectName, delay = 0) {
  if (!gameAudioSettings.effectsEnabled || gameAudioSettings.effectsVolume <= 0 || document.hidden) return
  const audio = ensureContext()
  if (!audio) return
  // 上下文被挂起过的话，这里顺手救活并重设增益，下一声就能正常响。
  if (audio.state !== 'running') resumeAudio()
  const start = audio.currentTime + 0.015 + delay
  if (effect === 'dice' || effect === 'win' || effect === 'loss') {
    if (playRecordedEffect(effect, start)) return
    loadRecordedAudio()
    if (effectsLoading) void effectsLoading.then(() => {
      if (context) playRecordedEffect(effect, context.currentTime + 0.01)
    })
    return
  }
  const volume = 1
  if (effect === 'draw') {
    tone(760, start, 0.055, volume * 0.07, 'triangle')
    tone(520, start + 0.035, 0.06, volume * 0.055, 'triangle')
  } else if (effect === 'discard') {
    noise(start, 0.075, volume * 0.22, 1100)
    tone(125, start, 0.09, volume * 0.12, 'sine')
  } else if (effect === 'peng') {
    tone(280, start, 0.1, volume * 0.13, 'square')
    tone(390, start + 0.085, 0.13, volume * 0.12, 'triangle')
  } else if (effect === 'gang') {
    for (let index = 0; index < 3; index += 1) {
      noise(start + index * 0.085, 0.08, volume * 0.2, 850)
      tone(150 - index * 12, start + index * 0.085, 0.11, volume * 0.12, 'square')
    }
  }
}

function startMusic() {
  if (musicSource || !activeMatchId || !gameAudioSettings.musicEnabled || gameAudioSettings.musicVolume <= 0 || document.hidden) return
  const audio = ensureContext()
  if (!audio) return
  if (audio.state !== 'running') { resumeAudio(); return }
  if (!musicBuffer) {
    loadRecordedAudio()
    if (musicLoading) void musicLoading.then(() => { if (musicBuffer) startMusic() })
    return
  }
  const source = audio.createBufferSource()
  source.buffer = musicBuffer
  source.loop = true
  source.connect(musicGain!)
  source.start()
  musicSource = source
}

function stopMusic() {
  if (!musicSource) return
  try { musicSource.stop() } catch { /* 已经停止 */ }
  musicSource.disconnect()
  musicSource = null
}

function setSetting<K extends AudioSettingKey>(key: K, value: GameAudioSettings[K]) {
  gameAudioSettings[key] = (key === 'musicVolume' || key === 'effectsVolume'
    ? clampVolume(value as number)
    : value) as GameAudioSettings[K]
  saveSettings()
  syncGains()
  if (key === 'vibrateEnabled') haptics.setEnabled(Boolean(value))
  if (gameAudioSettings.musicEnabled && gameAudioSettings.musicVolume > 0 && activeMatchId) startMusic()
  else stopMusic()
}

function prepareMatch(matchId: string, existingEvents: GameEvent[] = [], playExisting = false) {
  activeMatchId = matchId
  processedEvents.clear()
  if (!playExisting) for (const event of existingEvents) processedEvents.add(event.id)
  ensureContext()
  syncGains()
  loadRecordedAudio()
  startMusic()
}

function processEvents(state: GameState, listenerPlayerId?: number) {
  const humanId = listenerPlayerId ?? state.players.find((player) => player.isHuman)?.id ?? 0
  const fresh = state.events.filter((event) => !processedEvents.has(event.id))
  fresh.forEach((event, index) => {
    processedEvents.add(event.id)
    const delay = index * 0.09
    // 震动只在自己的动作上给：四家都震手机会一直抖
    const mine = event.playerId === humanId
    if (event.type === 'dice') playEffect('dice', delay)
    else if (event.type === 'draw') {
      playEffect('draw', delay)
      if (mine) vibrate(12)
    }
    else if (event.type === 'discard') {
      playEffect('discard', delay)
      if (mine) vibrate(24)
    } else if (event.type === 'peng') {
      playEffect('peng', delay)
      if (mine) vibrate([0, 36, 45, 36])
    } else if (['ming-gang', 'an-gang', 'bu-gang'].includes(event.type)) {
      playEffect('gang', delay)
      if (mine) vibrate([0, 38, 48, 42, 48, 72])
    } else if (event.type === 'win') {
      playEffect(mine ? 'win' : 'loss', delay)
      // 别人胡牌也震一下，提醒这局结束了
      vibrate(mine ? [0, 55, 65, 55, 65, 110] : 28)
    } else if (event.type === 'draw-game') {
      vibrate(20)
    }
    else if (event.type === 'match-over') {
      const ranking = [...state.players].sort((a, b) => (b.points ?? b.stats.netPoints) - (a.points ?? a.stats.netPoints))
      playEffect(ranking[0]?.id === humanId ? 'win' : 'loss', delay + 0.35)
      vibrate([0, 32, 55, 70])
      window.setTimeout(stopMusic, 1300)
    }
  })
}

function stopMatch() {
  activeMatchId = ''
  processedEvents.clear()
  stopMusic()
}

if (typeof document !== 'undefined') {
  const handleReturn = () => {
    if (document.hidden) {
      stopMusic()
      return
    }
    // 切回来先把上下文救活，再决定要不要续上音乐。
    resumeAudio()
    if (activeMatchId) startMusic()
  }
  document.addEventListener('visibilitychange', handleReturn)
  // iOS 从后台恢复、或从 bfcache 回来时不一定触发 visibilitychange。
  window.addEventListener('pageshow', handleReturn)
  window.addEventListener('focus', handleReturn)
}

// 出牌轻震一下，碰杠胡这种大动作重震。
// 注意：iOS Safari 不支持 navigator.vibrate（Apple 一直没实现，也没有替代 API），
// 所以这个开关在 iPhone 上不会有反应，界面里已经标出来了。
function vibrate(pattern: number | number[]): void {
  haptics.pattern(pattern)
}

function buttonFeedback(): void {
  unlock()
  haptics.light()
}

function turnFeedback(): void {
  haptics.light()
}

function countdownFeedback(): void { /* 浏览器合成提示音已停用 */ }

export const gameAudio = {
  settings: gameAudioSettings,
  setSetting,
  vibrate,
  buttonFeedback,
  turnFeedback,
  countdownFeedback,
  vibrationSupported,
  unlock,
  prepareMatch,
  processEvents,
  stopMatch,
  startMusic,
  stopMusic,
}
