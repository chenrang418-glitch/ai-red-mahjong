import { reactive } from 'vue'
import type { PresentationEvent } from '../engine/presentation'

export type SgsEffect =
  | 'button' | 'turn' | 'slash' | 'dodge' | 'peach' | 'wine' | 'nanman' | 'arrows'
  | 'duel' | 'counter' | 'chain' | 'fire' | 'thunder' | 'trick' | 'skill'
  | 'damage' | 'recover' | 'draw' | 'judge' | 'equip' | 'dying' | 'death'

type SettingKey = 'musicEnabled' | 'effectsEnabled' | 'vibrateEnabled' | 'musicVolume' | 'effectsVolume'
interface SgsAudioSettings {
  musicEnabled: boolean
  effectsEnabled: boolean
  vibrateEnabled: boolean
  musicVolume: number
  effectsVolume: number
}

// v2 将两路默认音量统一为 100%。换 key 可避免旧版 45% / 80% 默认值继续留在已有设备上。
const STORAGE_KEY = 'crplay-sanguosha-audio-v2'
export const SGS_AUDIO_DEFAULTS: Readonly<SgsAudioSettings> = {
  musicEnabled: true,
  effectsEnabled: true,
  vibrateEnabled: true,
  musicVolume: 1,
  effectsVolume: 1,
}
const defaults = SGS_AUDIO_DEFAULTS
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
function load(): SgsAudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<SgsAudioSettings>
    return {
      musicEnabled: typeof saved.musicEnabled === 'boolean' ? saved.musicEnabled : defaults.musicEnabled,
      effectsEnabled: typeof saved.effectsEnabled === 'boolean' ? saved.effectsEnabled : defaults.effectsEnabled,
      vibrateEnabled: typeof saved.vibrateEnabled === 'boolean' ? saved.vibrateEnabled : defaults.vibrateEnabled,
      musicVolume: clamp(typeof saved.musicVolume === 'number' ? saved.musicVolume : defaults.musicVolume),
      effectsVolume: clamp(typeof saved.effectsVolume === 'number' ? saved.effectsVolume : defaults.effectsVolume),
    }
  } catch { return { ...defaults } }
}

export const sgsAudioSettings = reactive<SgsAudioSettings>(load())
export const sgsVibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
let context: AudioContext | null = null
let musicGain: GainNode | null = null
let effectsGain: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null
let musicTimer: number | null = null
let musicStep = 0
let active = false
const processed = new Set<string>()

function ensureContext(): AudioContext | null {
  if (context) return context
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null
  context = new AudioContextClass()
  musicGain = context.createGain(); effectsGain = context.createGain()
  musicGain.connect(context.destination); effectsGain.connect(context.destination)
  noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * .4), context.sampleRate)
  const data = noiseBuffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
  syncGains()
  return context
}
function syncGains(): void {
  if (!context || !musicGain || !effectsGain) return
  musicGain.gain.setTargetAtTime(sgsAudioSettings.musicEnabled ? sgsAudioSettings.musicVolume : 0, context.currentTime, .03)
  effectsGain.gain.setTargetAtTime(sgsAudioSettings.effectsEnabled ? sgsAudioSettings.effectsVolume : 0, context.currentTime, .02)
}
function resume(): void {
  const audio = ensureContext()
  if (!audio) return
  void audio.resume().then(() => { syncGains(); if (active) startMusic() }).catch(() => undefined)
}
function tone(frequency: number, start: number, duration: number, volume: number, wave: OscillatorType = 'sine', channel: 'music' | 'effects' = 'effects'): void {
  if (!context) return
  const output = channel === 'music' ? musicGain : effectsGain
  if (!output) return
  const oscillator = context.createOscillator(); const gain = context.createGain()
  oscillator.type = wave; oscillator.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(Math.max(.0001, volume), start + .012); gain.gain.exponentialRampToValueAtTime(.0001, start + duration)
  oscillator.connect(gain).connect(output); oscillator.start(start); oscillator.stop(start + duration + .03)
}
function noise(start: number, duration: number, volume: number, lowPass = 1800): void {
  if (!context || !noiseBuffer || !effectsGain) return
  const source = context.createBufferSource(); const filter = context.createBiquadFilter(); const gain = context.createGain()
  source.buffer = noiseBuffer; filter.type = 'lowpass'; filter.frequency.setValueAtTime(lowPass, start)
  gain.gain.setValueAtTime(Math.max(.0001, volume), start); gain.gain.exponentialRampToValueAtTime(.0001, start + duration)
  source.connect(filter).connect(gain).connect(effectsGain); source.start(start); source.stop(start + duration)
}
function pluck(frequency: number, start: number, duration: number, volume: number, channel: 'music' | 'effects' = 'music'): void {
  tone(frequency, start, duration, volume, 'triangle', channel)
  tone(frequency * 2, start + .008, Math.max(.12, duration * .46), volume * .24, 'sine', channel)
  tone(frequency * 1.5, start + .014, Math.max(.1, duration * .32), volume * .1, 'sine', channel)
}

/** 事件到音色的映射独立导出，测试可验证全部牌类覆盖，不依赖浏览器音频。 */
export function effectForPresentation(event: PresentationEvent): SgsEffect | null {
  if (event.kind === 'turn-start') return 'turn'
  if (event.kind === 'skill') return 'skill'
  if (event.kind === 'damage' || event.kind === 'lose-hp') return event.nature === 'fire' ? 'fire' : event.nature === 'thunder' ? 'thunder' : 'damage'
  if (event.kind === 'recover') return 'recover'
  if (event.kind === 'draw' || event.kind === 'discard') return 'draw'
  if (event.kind === 'judge') return 'judge'
  if (event.kind === 'equipment') return 'equip'
  if (event.kind === 'dying') return 'dying'
  if (event.kind === 'death') return 'death'
  if (event.kind !== 'card-use' && event.kind !== 'card-response') return null
  const name = event.cardName ?? ''
  if (name.includes('杀')) return 'slash'
  if (name === '闪') return 'dodge'
  if (name === '桃' || name === '桃园结义') return 'peach'
  if (name === '酒') return 'wine'
  if (name === '南蛮入侵') return 'nanman'
  if (name === '万箭齐发') return 'arrows'
  if (name === '决斗') return 'duel'
  if (name === '无懈可击') return 'counter'
  if (name === '铁索连环') return 'chain'
  if (name === '火攻') return 'fire'
  if (['闪电'].includes(name)) return 'thunder'
  if (['诸葛连弩','雌雄双股剑','寒冰剑','青釭剑','古锭刀','青龙偃月刀','丈八蛇矛','贯石斧','朱雀羽扇','方天画戟','麒麟弓','八卦阵','仁王盾','藤甲','白银狮子','赤兔','大宛','紫骍','绝影','的卢','爪黄飞电','骅骝'].includes(name)) return 'equip'
  return 'trick'
}

function play(effect: SgsEffect, delay = 0): void {
  if (!sgsAudioSettings.effectsEnabled || document.hidden) return
  const audio = ensureContext(); if (!audio) return
  if (audio.state !== 'running') resume()
  const at = audio.currentTime + .018 + delay
  if (effect === 'button') pluck(659, at, .1, .035, 'effects')
  else if (effect === 'turn') { pluck(392, at, .36, .058, 'effects'); pluck(587, at + .13, .42, .048, 'effects') }
  else if (effect === 'slash') { noise(at, .13, .15, 2450); tone(132, at + .045, .2, .085, 'triangle') }
  else if (effect === 'dodge') { pluck(880, at, .2, .065, 'effects'); pluck(1175, at + .075, .28, .048, 'effects') }
  else if (effect === 'peach' || effect === 'recover') [523, 659, 784].forEach((f, i) => pluck(f, at + i * .09, .34, .046, 'effects'))
  else if (effect === 'wine') { tone(196, at, .28, .055, 'sine'); pluck(294, at + .09, .34, .05, 'effects') }
  else if (effect === 'nanman') { [0, .14, .28].forEach((d, i) => { noise(at + d, .075, .13, 620); tone(105 - i * 7, at + d, .2, .075, 'sine') }) }
  else if (effect === 'arrows') { [0, .075, .15, .225].forEach((d) => noise(at + d, .075, .1, 3000)); pluck(740, at, .34, .027, 'effects') }
  else if (effect === 'duel') { noise(at, .09, .13, 1250); tone(220, at, .25, .065, 'triangle'); noise(at + .19, .1, .12, 1100); tone(185, at + .19, .28, .065, 'triangle') }
  else if (effect === 'counter') [784, 659, 523].forEach((f, i) => pluck(f, at + i * .06, .23, .045, 'effects'))
  else if (effect === 'chain') { [330, 392, 466].forEach((f, i) => { noise(at + i * .065, .035, .065, 1900); pluck(f, at + i * .065, .2, .035, 'effects') }) }
  else if (effect === 'fire') { noise(at, .34, .13, 1050); tone(165, at, .4, .045, 'triangle') }
  else if (effect === 'thunder') { noise(at, .075, .2, 4800); tone(78, at + .035, .46, .11, 'sine') }
  else if (effect === 'damage') { noise(at, .09, .16, 820); tone(110, at, .2, .085, 'triangle') }
  else if (effect === 'skill') { pluck(440, at, .3, .043, 'effects'); pluck(660, at + .09, .38, .055, 'effects') }
  else if (effect === 'draw') { pluck(700, at, .13, .035, 'effects'); noise(at + .025, .055, .05, 2350) }
  else if (effect === 'judge') { tone(330, at, .28, .04, 'sine'); pluck(494, at + .18, .4, .052, 'effects') }
  else if (effect === 'equip') { noise(at, .045, .09, 1450); pluck(247, at, .3, .052, 'effects') }
  else if (effect === 'dying') { tone(196,at,.3,.09,'sine'); tone(147,at+.24,.42,.09,'sine') }
  else if (effect === 'death') [247,220,165,123].forEach((f,i)=>tone(f,at+i*.13,.4,.075,'sine'))
  else { tone(523,at,.12,.055,'triangle'); tone(392,at+.08,.2,.045,'sine') }
}

// 原创国风氛围：D 宫五声音阶，古琴式弹拨、箫声长音和低音鼓点；不使用任何外部录音。
const MUSIC_NOTES = [293.66, 392, 440, 523.25, 587.33, 523.25, 440, 392, 329.63, 440, 523.25, 392, 293.66, 329.63, 392, 440]
function musicTick(): void {
  if (!context || document.hidden || !sgsAudioSettings.musicEnabled) return
  const at = context.currentTime + .04; const note = MUSIC_NOTES[musicStep % MUSIC_NOTES.length]
  pluck(note, at, .64, .039)
  if (musicStep % 4 === 0) { tone(73.42, at, 1.7, .018, 'sine', 'music'); tone(146.83, at, .32, .016, 'triangle', 'music') }
  if (musicStep % 8 === 5) tone(note * 2, at + .22, .72, .011, 'sine', 'music')
  musicStep += 1
}
function startMusic(): void {
  if (!active || musicTimer !== null || !sgsAudioSettings.musicEnabled) return
  const audio = ensureContext(); if (!audio || audio.state !== 'running') return
  musicTick(); musicTimer = window.setInterval(musicTick, 780)
}
function stopMusic(): void { if (musicTimer !== null) window.clearInterval(musicTimer); musicTimer = null }
function vibrate(pattern: number | number[]): void {
  if (!sgsAudioSettings.vibrateEnabled || !sgsVibrationSupported || document.hidden) return
  try { navigator.vibrate(pattern) } catch { /* 不支持时静默降级 */ }
}
function hapticFor(event: PresentationEvent, viewerId: string): void {
  const involved = event.sourceId === viewerId || event.targetIds?.includes(viewerId)
  if (!involved) return
  if (event.kind === 'damage' || event.kind === 'lose-hp') vibrate([35, 35, 55])
  else if (event.kind === 'recover') vibrate([18, 28, 18])
  else if (event.kind === 'dying' || event.kind === 'death') vibrate([55, 55, 90])
  else if (event.kind === 'card-response' || event.kind === 'card-use' || event.kind === 'skill') vibrate(18)
}
function processEvents(events: readonly PresentationEvent[], viewerId: string): void {
  const fresh = events.filter((event) => !processed.has(event.id))
  fresh.forEach((event, index) => {
    processed.add(event.id)
    const effect = effectForPresentation(event)
    if (effect) play(effect, Math.min(index * .07, .28))
    hapticFor(event, viewerId)
  })
}
function prepare(existing: readonly PresentationEvent[] = []): void {
  active = true; processed.clear(); existing.forEach((event) => processed.add(event.id)); ensureContext(); syncGains(); startMusic()
}
function stop(): void { active = false; processed.clear(); stopMusic() }
function setSetting<K extends SettingKey>(key: K, value: SgsAudioSettings[K]): void {
  sgsAudioSettings[key] = (key === 'musicVolume' || key === 'effectsVolume' ? clamp(value as number) : value) as SgsAudioSettings[K]
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sgsAudioSettings)) } catch { /* 保存失败不影响对局 */ }
  syncGains(); if (sgsAudioSettings.musicEnabled) { resume(); startMusic() } else stopMusic()
}
function buttonFeedback(): void { resume(); play('button'); vibrate(8) }

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', resume, { once: true, passive: true })
  const restore = () => { if (document.hidden) stopMusic(); else { resume(); startMusic() } }
  document.addEventListener('visibilitychange', restore); window.addEventListener('pageshow', restore); window.addEventListener('focus', restore)
}

export const sgsAudio = { settings: sgsAudioSettings, setSetting, prepare, processEvents, stop, resume, buttonFeedback, play, vibrate }
