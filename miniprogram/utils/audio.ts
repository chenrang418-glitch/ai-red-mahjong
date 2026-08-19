// 音效全部实时合成，不带任何音频文件——小程序包本来就有 2MB 的主包限制，
// 而这些声音用几个振荡器就能出来。网页版那套 Web Audio 的写法在小程序里
// 基本能对上：wx.createWebAudioContext() 提供了 createOscillator / createGain /
// createBuffer 这些同名方法。
import type { GameEvent, GameState } from '../core/types'

type EffectName = 'dice' | 'draw' | 'discard' | 'peng' | 'gang' | 'win' | 'loss' | 'draw-game'
type Wave = 'sine' | 'square' | 'triangle' | 'sawtooth'

const SETTINGS_KEY = 'ai-red-mahjong.audio'

export interface AudioSettings {
  effectsEnabled: boolean
  effectsVolume: number
  musicEnabled: boolean
  musicVolume: number
  // 震动和声音都算「反馈」，放一起管，省得再开一套设置
  vibrateEnabled: boolean
}

const defaults: AudioSettings = {
  effectsEnabled: true,
  effectsVolume: 100,
  musicEnabled: false,
  musicVolume: 100,
  vibrateEnabled: true,
}

export const audioSettings: AudioSettings = loadSettings()

function loadSettings(): AudioSettings {
  try {
    const raw = wx.getStorageSync(SETTINGS_KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) as Partial<AudioSettings> } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

function saveSettings(): void {
  try {
    wx.setStorageSync(SETTINGS_KEY, JSON.stringify(audioSettings))
  } catch {
    // 存不下就算了，这一局照样有声音
  }
}

let context: any = null
let effectGain: any = null
let musicGain: any = null
let musicTimer = 0
let musicStep = 0
let hidden = false
const processedEvents = new Set<string>()

function ensureContext(): any {
  if (context) return context
  // 基础库 2.19 以前没有这个 API，拿不到就整个静音，不影响玩
  if (typeof wx.createWebAudioContext !== 'function') return null
  try {
    context = wx.createWebAudioContext()
    effectGain = context.createGain()
    musicGain = context.createGain()
    effectGain.connect(context.destination)
    musicGain.connect(context.destination)
    syncGains()
  } catch {
    context = null
  }
  return context
}

function syncGains(): void {
  if (!context) return
  effectGain.gain.value = audioSettings.effectsEnabled ? audioSettings.effectsVolume / 100 : 0
  musicGain.gain.value = audioSettings.musicEnabled ? audioSettings.musicVolume / 100 : 0
}

function tone(frequency: number, start: number, duration: number, volume: number, wave: Wave = 'sine', bus: 'effect' | 'music' = 'effect'): void {
  if (!context) return
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = wave
  oscillator.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain)
  gain.connect(bus === 'music' ? musicGain : effectGain)
  oscillator.start(start)
  oscillator.stop(start + duration + 0.03)
}

// 摸牌、打牌那种「咔哒」声用白噪声做，纯振荡器出不来颗粒感。
// 必须过一道低通：全频白噪声高频太扎耳朵，听两下就烦。
function noise(start: number, duration: number, volume: number, lowPass = 1200): void {
  if (!context) return
  const frames = Math.max(1, Math.floor(context.sampleRate * duration))
  const buffer = context.createBuffer(1, frames, context.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let index = 0; index < frames; index += 1) {
    // 尾部衰减，否则听着像一段被剪断的电流声
    channel[index] = (Math.random() * 2 - 1) * (1 - index / frames)
  }
  const source = context.createBufferSource()
  const gain = context.createGain()
  source.buffer = buffer
  gain.gain.setValueAtTime(volume, start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)

  try {
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(lowPass, start)
    source.connect(filter)
    filter.connect(gain)
  } catch {
    // 拿不到滤波器就直连，音量已经压过了，不至于难听到没法听
    source.connect(gain)
  }
  gain.connect(effectGain)
  source.start(start)
}

export function playEffect(effect: EffectName, delay = 0): void {
  if (!audioSettings.effectsEnabled || audioSettings.effectsVolume <= 0 || hidden) return
  const audio = ensureContext()
  if (!audio) return
  const start = audio.currentTime + 0.015 + delay

  if (effect === 'dice') {
    // 骰子是木头撞碗，不是沙沙的白噪声：低通压到 600 上下，配一点中低频
    noise(start, 0.055, 0.09, 620)
    tone(240, start, 0.06, 0.07, 'triangle')
    noise(start + 0.11, 0.05, 0.08, 560)
    tone(210, start + 0.11, 0.06, 0.06, 'triangle')
    noise(start + 0.22, 0.07, 0.1, 700)
    tone(280, start + 0.22, 0.08, 0.07, 'triangle')
  } else if (effect === 'draw') {
    tone(760, start, 0.055, 0.07, 'triangle')
    tone(520, start + 0.035, 0.06, 0.055, 'triangle')
  } else if (effect === 'discard') {
    // 原来 0.22 的宽频噪声太冲，压到 0.1 并砍掉高频，落桌的闷响交给低频那一下
    noise(start, 0.07, 0.1, 750)
    tone(118, start, 0.1, 0.16, 'sine')
    tone(196, start + 0.02, 0.07, 0.05, 'triangle')
  } else if (effect === 'peng') {
    tone(280, start, 0.1, 0.13, 'square')
    tone(390, start + 0.085, 0.13, 0.12, 'triangle')
  } else if (effect === 'gang') {
    for (let index = 0; index < 3; index += 1) {
      noise(start + index * 0.085, 0.075, 0.12, 900)
      tone(150 - index * 12, start + index * 0.085, 0.11, 0.12, 'square')
    }
  } else if (effect === 'win') {
    const notes = [392, 523, 659, 784]
    notes.forEach((frequency, index) => tone(frequency, start + index * 0.12, 0.34, 0.12, 'triangle'))
  } else if (effect === 'loss') {
    const notes = [392, 330, 262, 196]
    notes.forEach((frequency, index) => tone(frequency, start + index * 0.15, 0.38, 0.09, 'sine'))
  } else {
    tone(330, start, 0.22, 0.08, 'sine')
    tone(294, start + 0.14, 0.28, 0.07, 'sine')
  }
}

const musicNotes = [261.63, 293.66, 329.63, 392, 329.63, 440, 392, 293.66, 261.63, 329.63, 392, 293.66]

function scheduleMusicNote(): void {
  if (!context || !audioSettings.musicEnabled || audioSettings.musicVolume <= 0 || hidden) return
  const start = context.currentTime + 0.04
  const frequency = musicNotes[musicStep % musicNotes.length]
  tone(frequency, start, 0.95, 0.075, 'triangle', 'music')
  tone(frequency / 2, start, 1.15, 0.042, 'sine', 'music')
  if (musicStep % 4 === 0) tone(98, start, 0.35, 0.036, 'sine', 'music')
  musicStep += 1
}

export function startMusic(): void {
  if (!audioSettings.musicEnabled) return
  if (!ensureContext() || musicTimer) return
  scheduleMusicNote()
  musicTimer = setInterval(scheduleMusicNote, 1000)
}

export function stopMusic(): void {
  if (musicTimer) clearInterval(musicTimer)
  musicTimer = 0
}

export function setSetting<K extends keyof AudioSettings>(key: K, value: AudioSettings[K]): void {
  audioSettings[key] = value
  saveSettings()
  syncGains()
  if (key === 'musicEnabled') {
    if (audioSettings.musicEnabled) startMusic()
    else stopMusic()
  }
}

// 切到后台就别出声了，回来再接着放——手机上退到桌面还在响很讨厌
export function setHidden(value: boolean): void {
  hidden = value
  if (value) stopMusic()
  else if (audioSettings.musicEnabled) startMusic()
}

export function prepareMatch(events: GameEvent[] = []): void {
  processedEvents.clear()
  for (const event of events) processedEvents.add(event.id)
  if (audioSettings.musicEnabled) startMusic()
}

// 每次状态变化后调一次：把这一批新事件对应的声音放出来。
// 事件 id 记过就不再响，避免重复渲染时又响一遍。
export function processEvents(state: GameState, humanId = 0): void {
  const fresh = state.events.filter((event) => !processedEvents.has(event.id))
  fresh.forEach((event, index) => {
    processedEvents.add(event.id)
    const delay = index * 0.09
    const mine = event.playerId === humanId
    if (event.type === 'dice') playEffect('dice', delay)
    else if (event.type === 'draw') playEffect('draw', delay)
    else if (event.type === 'discard') {
      playEffect('discard', delay)
      if (mine) vibrate('light')
    } else if (event.type === 'peng') {
      playEffect('peng', delay)
      if (mine) vibrate('heavy')
    } else if (event.type === 'ming-gang' || event.type === 'an-gang' || event.type === 'bu-gang') {
      playEffect('gang', delay)
      if (mine) vibrate('heavy')
    } else if (event.type === 'win') {
      playEffect(mine ? 'win' : 'loss', delay)
      vibrate('heavy')
    }
    else if (event.type === 'draw-game') playEffect('draw-game', delay)
    else if (event.type === 'match-over') {
      const ranking = [...state.players].sort((left, right) => (
        (right.points ?? right.stats.netPoints) - (left.points ?? left.stats.netPoints)
      ))
      playEffect(ranking[0] && ranking[0].id === humanId ? 'win' : 'loss', delay + 0.35)
      setTimeout(stopMusic, 1300)
    }
  })
}

// 出牌轻震一下，碰杠胡这种大动作重震。手机上这点反馈比音效还明显。
export function vibrate(strength: 'light' | 'heavy' = 'light'): void {
  if (!audioSettings.vibrateEnabled || hidden) return
  try {
    if (strength === 'heavy') wx.vibrateShort({ type: 'medium' })
    else wx.vibrateShort({ type: 'light' })
  } catch {
    // 部分机型不支持，忽略
  }
}

export function stopMatch(): void {
  processedEvents.clear()
  stopMusic()
}
