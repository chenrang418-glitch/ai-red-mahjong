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

const STORAGE_KEY = 'crplay-sanguosha-audio-v1'
const defaults: SgsAudioSettings = { musicEnabled: true, effectsEnabled: true, vibrateEnabled: true, musicVolume: .45, effectsVolume: .8 }
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
  if (effect === 'button') tone(640, at, .045, .045, 'triangle')
  else if (effect === 'turn') { tone(392, at, .22, .075, 'triangle'); tone(587, at + .12, .32, .06, 'sine') }
  else if (effect === 'slash') { noise(at, .16, .22, 2700); tone(145, at + .06, .18, .12, 'sawtooth') }
  else if (effect === 'dodge') { tone(880, at, .12, .09, 'triangle'); tone(1175, at + .07, .22, .07, 'sine') }
  else if (effect === 'peach' || effect === 'recover') [523,659,784].forEach((f,i)=>tone(f,at+i*.09,.28,.065,'sine'))
  else if (effect === 'wine') { tone(196, at, .18, .08, 'sine'); tone(294, at + .09, .25, .065, 'triangle') }
  else if (effect === 'nanman') { [0,.13,.26].forEach((d,i)=>{ noise(at+d,.09,.2,700); tone(105-i*7,at+d,.15,.11,'sine') }) }
  else if (effect === 'arrows') { [0,.07,.14,.21].forEach((d)=>noise(at+d,.09,.15,3200)); tone(740,at,.3,.045,'sawtooth') }
  else if (effect === 'duel') { noise(at,.11,.2,1400); tone(220,at,.2,.1,'square'); noise(at+.18,.12,.18,1200); tone(185,at+.18,.22,.1,'square') }
  else if (effect === 'counter') [784,659,523].forEach((f,i)=>tone(f,at+i*.055,.18,.065,'triangle'))
  else if (effect === 'chain') { [330,392,466].forEach((f,i)=>{ noise(at+i*.06,.045,.1,2100); tone(f,at+i*.06,.16,.05,'square') }) }
  else if (effect === 'fire') { noise(at,.32,.19,1100); tone(165,at,.38,.07,'sawtooth') }
  else if (effect === 'thunder') { noise(at,.08,.3,5200); tone(78,at+.035,.4,.16,'sine') }
  else if (effect === 'damage') { noise(at,.1,.24,900); tone(110,at,.18,.13,'square') }
  else if (effect === 'skill') { tone(440,at,.18,.06,'triangle'); tone(660,at+.08,.28,.075,'triangle') }
  else if (effect === 'draw') { tone(700,at,.055,.055,'triangle'); noise(at+.025,.07,.08,2500) }
  else if (effect === 'judge') { tone(330,at,.2,.06,'sine'); tone(494,at+.18,.32,.075,'triangle') }
  else if (effect === 'equip') { noise(at,.055,.15,1600); tone(247,at,.22,.08,'triangle') }
  else if (effect === 'dying') { tone(196,at,.3,.09,'sine'); tone(147,at+.24,.42,.09,'sine') }
  else if (effect === 'death') [247,220,165,123].forEach((f,i)=>tone(f,at+i*.13,.4,.075,'sine'))
  else { tone(523,at,.12,.055,'triangle'); tone(392,at+.08,.2,.045,'sine') }
}

// 原创国风氛围：D 宫五声音阶，疏朗弹拨 + 低音持续音；不使用任何外部录音。
const MUSIC_NOTES = [293.66, 392, 440, 523.25, 587.33, 523.25, 440, 392, 329.63, 392, 523.25, 440]
function musicTick(): void {
  if (!context || document.hidden || !sgsAudioSettings.musicEnabled) return
  const at = context.currentTime + .04; const note = MUSIC_NOTES[musicStep % MUSIC_NOTES.length]
  tone(note, at, .72, .055, 'triangle', 'music'); tone(note * 2, at + .018, .34, .018, 'sine', 'music')
  if (musicStep % 4 === 0) tone(73.42, at, 1.6, .025, 'sine', 'music')
  if (musicStep % 6 === 3) tone(880, at + .28, .6, .014, 'sine', 'music')
  musicStep += 1
}
function startMusic(): void {
  if (!active || musicTimer !== null || !sgsAudioSettings.musicEnabled) return
  const audio = ensureContext(); if (!audio || audio.state !== 'running') return
  musicTick(); musicTimer = window.setInterval(musicTick, 920)
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
