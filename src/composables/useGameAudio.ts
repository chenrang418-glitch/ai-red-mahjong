import { reactive } from 'vue'
import type { GameEvent, GameState } from '@/game/types'

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

let context: AudioContext | null = null
let noiseBuffer: AudioBuffer | null = null
let masterGain: GainNode | null = null
let musicGain: GainNode | null = null
let effectsGain: GainNode | null = null
let musicTimer: number | null = null
let musicStep = 0
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
  void audio.resume().then(syncGains).catch(() => undefined)
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

type EffectName = 'dice' | 'draw' | 'discard' | 'peng' | 'gang' | 'win' | 'loss' | 'draw-game'

function playEffect(effect: EffectName, delay = 0) {
  if (!gameAudioSettings.effectsEnabled || gameAudioSettings.effectsVolume <= 0 || document.hidden) return
  const audio = ensureContext()
  if (!audio) return
  // 上下文被挂起过的话，这里顺手救活并重设增益，下一声就能正常响。
  if (audio.state !== 'running') resumeAudio()
  const start = audio.currentTime + 0.015 + delay
  const volume = 1
  if (effect === 'dice') {
    noise(start, 0.08, volume * 0.18, 2300)
    noise(start + 0.1, 0.08, volume * 0.16, 1900)
    noise(start + 0.2, 0.1, volume * 0.2, 1500)
  } else if (effect === 'draw') {
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
  } else if (effect === 'win') {
    ;[392, 523, 659, 784].forEach((frequency, index) => tone(frequency, start + index * 0.12, 0.34, volume * 0.12, 'triangle'))
  } else if (effect === 'loss') {
    ;[392, 330, 262, 196].forEach((frequency, index) => tone(frequency, start + index * 0.15, 0.38, volume * 0.09, 'sine'))
  } else {
    tone(330, start, 0.22, volume * 0.08, 'sine')
    tone(294, start + 0.14, 0.28, volume * 0.07, 'sine')
  }
}

const musicNotes = [261.63, 293.66, 329.63, 392, 329.63, 440, 392, 293.66, 261.63, 329.63, 392, 293.66]

function scheduleMusicNote() {
  if (!context || !gameAudioSettings.musicEnabled || gameAudioSettings.musicVolume <= 0 || document.hidden) return
  const start = context.currentTime + 0.04
  const frequency = musicNotes[musicStep % musicNotes.length]
  tone(frequency, start, 0.95, 0.045, 'triangle', 'music')
  tone(frequency / 2, start, 1.15, 0.025, 'sine', 'music')
  if (musicStep % 4 === 0) tone(98, start, 0.35, 0.022, 'sine', 'music')
  musicStep += 1
}

function startMusic() {
  if (musicTimer !== null || !gameAudioSettings.musicEnabled || gameAudioSettings.musicVolume <= 0) return
  const audio = ensureContext()
  if (!audio) return
  void audio.resume()
  scheduleMusicNote()
  musicTimer = window.setInterval(scheduleMusicNote, 720)
}

function stopMusic() {
  if (musicTimer !== null) window.clearInterval(musicTimer)
  musicTimer = null
}

function setSetting<K extends AudioSettingKey>(key: K, value: GameAudioSettings[K]) {
  gameAudioSettings[key] = (key === 'musicVolume' || key === 'effectsVolume'
    ? clampVolume(value as number)
    : value) as GameAudioSettings[K]
  saveSettings()
  syncGains()
  if (gameAudioSettings.musicEnabled && gameAudioSettings.musicVolume > 0 && activeMatchId) startMusic()
  else stopMusic()
}

function prepareMatch(matchId: string, existingEvents: GameEvent[] = [], playExisting = false) {
  activeMatchId = matchId
  processedEvents.clear()
  if (!playExisting) for (const event of existingEvents) processedEvents.add(event.id)
  ensureContext()
  syncGains()
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
      playEffect('draw-game', delay)
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
export const vibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

function vibrate(pattern: number | number[]): void {
  if (!gameAudioSettings.vibrateEnabled || !vibrationSupported || document.hidden) return
  try {
    navigator.vibrate(pattern)
  } catch {
    // 有的浏览器在没有用户交互前调用会抛错，忽略
  }
}

export const gameAudio = {
  settings: gameAudioSettings,
  setSetting,
  vibrate,
  vibrationSupported,
  unlock,
  prepareMatch,
  processEvents,
  stopMatch,
  startMusic,
  stopMusic,
}
