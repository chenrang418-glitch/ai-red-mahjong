import { reactive } from 'vue'
import type { PresentationEvent } from '../engine/presentation'

/**
 * 音效名单。
 *
 * 每种锦囊各有独立音效，**不再有笼统的 `trick` 兜底**——听不出是什么牌
 * 等于没有信息。没有成品文件的先用合成音占位，接了文件就自动切过去。
 *
 * 三处合并是规则要求的，不是省事：
 * - 桃、桃园结义、濒死自救的酒，以及任何实际回复体力 → `recover`
 * - 火杀、雷杀和普通杀的**出牌动作** → `slash`（属性只体现在伤害那一下）
 * - 任何实际扣血 → `damage`，不按普通/火焰/雷电分三种
 */
export type SgsEffect =
  // 界面与流程
  | 'button' | 'turn' | 'game-start' | 'draw' | 'judge' | 'skill'
  | 'damage' | 'recover' | 'dying' | 'death'
  // 基本牌
  | 'slash' | 'dodge' | 'wine'
  // 锦囊
  | 'wuzhong' | 'counter' | 'wugu' | 'nanman' | 'arrows' | 'duel'
  | 'dismantle' | 'snatch' | 'borrowed-sword' | 'fire' | 'chain'
  // 延时锦囊：只在判定真正生效时播
  | 'indulgence' | 'supply-shortage' | 'thunder'
  // 装备按三类分开
  | 'equip-weapon' | 'equip-mount' | 'equip-armor'

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

/**
 * 成品音效文件。
 *
 * 只登记**已经做好**的；没登记的效果继续用合成音，等文件到位再加一行即可，
 * 不需要改任何调用点。用 MP3 不用 WAV：同样的内容 WAV 要大十倍以上
 * （game-start 是 1.3MB 对 29KB），装进前端包不值。
 */
const SAMPLE_URLS: Partial<Record<SgsEffect, string>> = {
  slash: new URL('../assets/audio/slash.mp3', import.meta.url).href,
  dodge: new URL('../assets/audio/dodge.mp3', import.meta.url).href,
  recover: new URL('../assets/audio/recover.mp3', import.meta.url).href,
  wine: new URL('../assets/audio/wine.mp3', import.meta.url).href,
  counter: new URL('../assets/audio/counter.mp3', import.meta.url).href,
  nanman: new URL('../assets/audio/nanman.mp3', import.meta.url).href,
  arrows: new URL('../assets/audio/arrows.mp3', import.meta.url).href,
  duel: new URL('../assets/audio/duel.mp3', import.meta.url).href,
  fire: new URL('../assets/audio/fire.mp3', import.meta.url).href,
  thunder: new URL('../assets/audio/thunder.mp3', import.meta.url).href,
  'game-start': new URL('../assets/audio/game-start.mp3', import.meta.url).href,
}

/** 已经解码好的采样。 */
const samples = new Map<SgsEffect, AudioBuffer>()
/** 正在下载/解码中的采样。同一个只发一次请求。 */
const loading = new Map<SgsEffect, Promise<void>>()

/**
 * 采样还没就绪时最多等多久（毫秒）。
 *
 * 开局音和采样预热是**同时开始**的：`prepare()` 刚发起解码，`GameStart`
 * 事件就到了。不等的话第一局必定退回合成音——而这恰恰是最该听到成品的那一声。
 * 给一个短上限：等得到就放成品，等不到就退合成音，不会把声音拖到几秒之后。
 */
const SAMPLE_WAIT_MS = 900

function loadSample(effect: SgsEffect): Promise<void> | null {
  const url = SAMPLE_URLS[effect]
  if (!url || samples.has(effect)) return null
  const existing = loading.get(effect)
  if (existing) return existing
  const audio = ensureContext()
  if (!audio) return null
  const task = fetch(url)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
    .then((data) => audio.decodeAudioData(data))
    .then((buffer) => { samples.set(effect, buffer) })
    // 取不到或解不开就一直用合成音，不把对局卡住，也不反复重试刷网络
    .catch(() => undefined)
    .finally(() => { loading.delete(effect) })
  loading.set(effect, task)
  return task
}

/** 预热：进对局时把所有成品音效解码好，免得第一次触发时还在加载。 */
function preloadSamples(): void {
  for (const effect of Object.keys(SAMPLE_URLS) as SgsEffect[]) loadSample(effect)
}

/** 立刻放一份已经解码好的采样。没就绪返回 false。 */
function playSample(effect: SgsEffect, at: number): boolean {
  const buffer = samples.get(effect)
  if (!buffer || !context || !effectsGain) return false
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(effectsGain)
  source.start(at)
  return true
}

/**
 * 采样正在解码时短暂等一下再放。
 *
 * 等到了就放成品并返回 true；超时或失败返回 false，调用方退回合成音。
 */
function playSampleWhenReady(effect: SgsEffect, onFallback: () => void): boolean {
  const task = loadSample(effect)
  if (!task) return false
  let settled = false
  const finish = (ready: boolean): void => {
    if (settled) return
    settled = true
    if (ready && context && playSample(effect, context.currentTime + .01)) return
    onFallback()
  }
  window.setTimeout(() => finish(false), SAMPLE_WAIT_MS)
  void task.then(() => finish(samples.has(effect)))
  return true
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

const WEAPONS = ['诸葛连弩', '雌雄双股剑', '寒冰剑', '青釭剑', '古锭刀', '青龙偃月刀', '丈八蛇矛', '贯石斧', '朱雀羽扇', '方天画戟', '麒麟弓']
const ARMORS = ['八卦阵', '仁王盾', '藤甲', '白银狮子']
const MOUNTS = ['赤兔', '大宛', '紫骍', '绝影', '的卢', '爪黄飞电', '骅骝']

/** 延时锦囊判定命中时才播的那一份。 */
const DELAYED_TRICK_EFFECT: Record<string, SgsEffect> = {
  乐不思蜀: 'indulgence',
  兵粮寸断: 'supply-shortage',
  闪电: 'thunder',
}

/**
 * 牌名到音效。
 *
 * 【杀】写死三个名字而不是 `name.includes('杀')`：那种写法会把**借刀杀人**
 * 也判成出杀（它名字里带「杀」），一直播错音。
 */
function effectForCardName(name: string, kind: 'card-use' | 'card-response'): SgsEffect | null {
  if (name === '杀' || name === '火杀' || name === '雷杀') return 'slash'
  if (name === '闪') return 'dodge'
  if (name === '桃' || name === '桃园结义') return 'recover'
  // 濒死自救的酒走的是「打出」（CardResponded），出牌阶段助兴的酒走「使用」。
  // 前者本质是回复，归到 recover；后者才是 wine。
  if (name === '酒') return kind === 'card-response' ? 'recover' : 'wine'
  if (name === '无中生有') return 'wuzhong'
  if (name === '无懈可击') return 'counter'
  if (name === '五谷丰登') return 'wugu'
  if (name === '南蛮入侵') return 'nanman'
  if (name === '万箭齐发') return 'arrows'
  if (name === '决斗') return 'duel'
  if (name === '过河拆桥') return 'dismantle'
  if (name === '顺手牵羊') return 'snatch'
  if (name === '借刀杀人') return 'borrowed-sword'
  if (name === '火攻') return 'fire'
  if (name === '铁索连环') return 'chain'
  // 延时锦囊**放进判定区时不出声**：那一刻还什么都没发生。
  // 它们的音效由判定事件在真正命中时触发。
  if (name in DELAYED_TRICK_EFFECT) return null
  if (WEAPONS.includes(name)) return 'equip-weapon'
  if (ARMORS.includes(name)) return 'equip-armor'
  if (MOUNTS.includes(name)) return 'equip-mount'
  return null
}

/** 事件到音色的映射独立导出，测试可验证全部牌类覆盖，不依赖浏览器音频。 */
export function effectForPresentation(event: PresentationEvent): SgsEffect | null {
  if (event.kind === 'game-start') return 'game-start'
  if (event.kind === 'turn-start') return 'turn'
  if (event.kind === 'skill') return 'skill'
  // 属性伤害不分家：火焰、雷电扣血也走同一个 damage。
  // 「这一下是火」由使用【火攻】那张牌的音效表达，不在扣血这一步再分一次。
  if (event.kind === 'damage' || event.kind === 'lose-hp') return 'damage'
  if (event.kind === 'recover') return 'recover'
  if (event.kind === 'draw' || event.kind === 'discard') return 'draw'
  if (event.kind === 'judge') {
    // 判定真正命中才播那张延时锦囊的效果音；没命中只留普通判定音
    const delayed = event.judgeReason ? DELAYED_TRICK_EFFECT[event.judgeReason] : undefined
    return delayed && event.judgeHit ? delayed : 'judge'
  }
  if (event.kind === 'equipment') return effectForCardName(event.cardName ?? '', 'card-use') ?? 'equip-weapon'
  if (event.kind === 'dying') return 'dying'
  if (event.kind === 'death') return 'death'
  if (event.kind !== 'card-use' && event.kind !== 'card-response') return null
  return effectForCardName(event.cardName ?? '', event.kind)
}

function play(effect: SgsEffect, delay = 0): void {
  if (!sgsAudioSettings.effectsEnabled || document.hidden) return
  const audio = ensureContext(); if (!audio) return
  if (audio.state !== 'running') resume()
  const at = audio.currentTime + .018 + delay
  // 有成品文件就放文件；没有这个文件才用合成音。
  // 这样接一个新音效只要往 SAMPLE_URLS 加一行，不用碰下面任何一条。
  if (playSample(effect, at)) return
  // 文件登记了但还在解码：短暂等一下，别让第一次触发白白退成合成音
  if (SAMPLE_URLS[effect] && playSampleWhenReady(effect, () => playSynth(effect, at))) return
  playSynth(effect, at)
}

function playSynth(effect: SgsEffect, at: number): void {
  if (effect === 'button') pluck(659, at, .1, .035, 'effects')
  else if (effect === 'turn') { pluck(392, at, .36, .058, 'effects'); pluck(587, at + .13, .42, .048, 'effects') }
  else if (effect === 'game-start') [392, 523, 659, 784].forEach((f, i) => pluck(f, at + i * .11, .5, .055, 'effects'))
  else if (effect === 'slash') { noise(at, .13, .15, 2450); tone(132, at + .045, .2, .085, 'triangle') }
  else if (effect === 'dodge') { pluck(880, at, .2, .065, 'effects'); pluck(1175, at + .075, .28, .048, 'effects') }
  else if (effect === 'recover') [523, 659, 784].forEach((f, i) => pluck(f, at + i * .09, .34, .046, 'effects'))
  else if (effect === 'wine') { tone(196, at, .28, .055, 'sine'); pluck(294, at + .09, .34, .05, 'effects') }
  else if (effect === 'wuzhong') { pluck(587, at, .26, .05, 'effects'); pluck(880, at + .1, .34, .042, 'effects') }
  else if (effect === 'wugu') [523, 587, 659, 784].forEach((f, i) => pluck(f, at + i * .07, .3, .04, 'effects'))
  else if (effect === 'nanman') { [0, .14, .28].forEach((d, i) => { noise(at + d, .075, .13, 620); tone(105 - i * 7, at + d, .2, .075, 'sine') }) }
  else if (effect === 'arrows') { [0, .075, .15, .225].forEach((d) => noise(at + d, .075, .1, 3000)); pluck(740, at, .34, .027, 'effects') }
  else if (effect === 'duel') { noise(at, .09, .13, 1250); tone(220, at, .25, .065, 'triangle'); noise(at + .19, .1, .12, 1100); tone(185, at + .19, .28, .065, 'triangle') }
  else if (effect === 'counter') [784, 659, 523].forEach((f, i) => pluck(f, at + i * .06, .23, .045, 'effects'))
  else if (effect === 'dismantle') { noise(at, .06, .12, 2200); pluck(392, at + .03, .26, .05, 'effects') }
  else if (effect === 'snatch') { pluck(659, at, .18, .05, 'effects'); noise(at + .08, .05, .08, 2600); pluck(494, at + .12, .26, .04, 'effects') }
  else if (effect === 'borrowed-sword') { pluck(330, at, .22, .05, 'effects'); noise(at + .12, .1, .12, 2400); tone(147, at + .14, .22, .07, 'triangle') }
  else if (effect === 'fire') { noise(at, .34, .13, 1050); tone(165, at, .4, .045, 'triangle') }
  else if (effect === 'chain') { [330, 392, 466].forEach((f, i) => { noise(at + i * .065, .035, .065, 1900); pluck(f, at + i * .065, .2, .035, 'effects') }) }
  else if (effect === 'indulgence') { tone(262, at, .34, .05, 'sine'); tone(196, at + .2, .42, .05, 'sine') }
  else if (effect === 'supply-shortage') { tone(220, at, .3, .05, 'sine'); noise(at + .16, .1, .07, 900) }
  else if (effect === 'thunder') { noise(at, .075, .2, 4800); tone(78, at + .035, .46, .11, 'sine') }
  else if (effect === 'damage') { noise(at, .09, .16, 820); tone(110, at, .2, .085, 'triangle') }
  else if (effect === 'skill') { pluck(440, at, .3, .043, 'effects'); pluck(660, at + .09, .38, .055, 'effects') }
  else if (effect === 'draw') { pluck(700, at, .13, .035, 'effects'); noise(at + .025, .055, .05, 2350) }
  else if (effect === 'judge') { tone(330, at, .28, .04, 'sine'); pluck(494, at + .18, .4, .052, 'effects') }
  else if (effect === 'equip-weapon') { noise(at, .045, .09, 1450); pluck(247, at, .3, .052, 'effects') }
  else if (effect === 'equip-armor') { tone(165, at, .3, .06, 'sine'); pluck(330, at + .08, .3, .04, 'effects') }
  else if (effect === 'equip-mount') { [0, .09, .18].forEach((d) => noise(at + d, .05, .07, 1100)); pluck(392, at + .05, .26, .035, 'effects') }
  else if (effect === 'dying') { tone(196, at, .3, .09, 'sine'); tone(147, at + .24, .42, .09, 'sine') }
  else if (effect === 'death') [247, 220, 165, 123].forEach((f, i) => tone(f, at + i * .13, .4, .075, 'sine'))
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
  active = true; processed.clear(); existing.forEach((event) => processed.add(event.id)); ensureContext(); syncGains(); preloadSamples(); startMusic()
  /*
   * 开局音要在这里补一次。
   *
   * 上面那行把挂载时已有的事件全部标记成「已处理」，为的是重连回到打了一半的
   * 牌局时不要把历史事件重播一遍。但**开局音恰好就在那批初始事件里**——
   * 牌局是 `game.start()` 开起来的，表格挂载时 `game-start` 已经在流里了，
   * 于是它每次都被当成历史事件跳过，一次都响不了。
   *
   * 这条事件只在开局产生一次，牌局打一会儿就会滚出保留窗口，
   * 所以「初始批次里有它」本身就等于「这局刚刚开始」。
   */
  if (existing.some((event) => event.kind === 'game-start')) play('game-start')
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
