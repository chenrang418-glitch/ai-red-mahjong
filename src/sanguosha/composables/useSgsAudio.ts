import { reactive } from 'vue'
import type { PresentationEvent } from '../engine/presentation'

/**
 * 音效名单。
 *
 * 每种锦囊各有独立音效，**不再有笼统的 `trick` 兜底**——听不出是什么牌
 * 等于没有信息。只播放已登记的成品 MP3，没有文件的事件保持静音。
 *
 * 三处合并是规则要求的，不是省事：
 * - 桃、桃园结义、濒死自救的酒，以及任何实际回复体力 → `recover`
 * - 火杀、雷杀和普通杀的**出牌动作** → `slash`（属性只体现在伤害那一下）
 * - 任何实际扣血 → `damage`，不按普通/火焰/雷电分三种
 */
export type SgsEffect =
  // 界面与流程（只保留已有 MP3 的开局和结算）
  | 'game-start'
  | 'damage' | 'damage-female' | 'recover' | 'dying' | 'dying-female' | 'death' | 'death-female'
  // 基本牌
  | 'slash' | 'dodge' | 'wine'
  // 锦囊
  | 'wuzhong' | 'counter' | 'wugu' | 'nanman' | 'arrows' | 'duel'
  | 'dismantle' | 'snatch' | 'borrowed-sword' | 'fire' | 'chain'
  // 延时锦囊：只在判定真正生效时播
  | 'indulgence' | 'supply-shortage' | 'thunder'
  // 武器和防具共用一声；坐骑单独一声
  | 'equip' | 'equip-mount'
  // 结算
  | 'victory' | 'defeat'

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
 * 只登记**已经做好**的；没登记的效果保持静音，等文件到位再加一行即可，
 * 不需要改任何调用点。用 MP3 不用 WAV：同样的内容 WAV 要大十倍以上
 * （game-start 是 1.3MB 对 29KB），装进前端包不值。
 */
const SAMPLE_URLS: Partial<Record<SgsEffect, readonly string[]>> = {
  slash: [new URL('../assets/audio/slash.mp3', import.meta.url).href],
  dodge: [new URL('../assets/audio/dodge.mp3', import.meta.url).href],
  recover: [new URL('../assets/audio/recover.mp3', import.meta.url).href],
  wine: [new URL('../assets/audio/wine.mp3', import.meta.url).href],
  wuzhong: [new URL('../assets/audio/wuzhong.mp3', import.meta.url).href],
  counter: [new URL('../assets/audio/counter.mp3', import.meta.url).href],
  wugu: [new URL('../assets/audio/wugu.mp3', import.meta.url).href],
  nanman: [new URL('../assets/audio/nanman.mp3', import.meta.url).href],
  arrows: [new URL('../assets/audio/arrows.mp3', import.meta.url).href],
  duel: [new URL('../assets/audio/duel.mp3', import.meta.url).href],
  dismantle: [new URL('../assets/audio/dismantle.mp3', import.meta.url).href],
  snatch: [new URL('../assets/audio/snatch.mp3', import.meta.url).href],
  'borrowed-sword': [new URL('../assets/audio/borrowed-sword.mp3', import.meta.url).href],
  fire: [new URL('../assets/audio/fire.mp3', import.meta.url).href],
  chain: [new URL('../assets/audio/chain.mp3', import.meta.url).href],
  indulgence: [new URL('../assets/audio/indulgence.mp3', import.meta.url).href],
  'supply-shortage': [new URL('../assets/audio/supply-shortage.mp3', import.meta.url).href],
  thunder: [new URL('../assets/audio/thunder.mp3', import.meta.url).href],
  damage: [
    new URL('../assets/audio/damage-01.mp3', import.meta.url).href,
    new URL('../assets/audio/damage-02.mp3', import.meta.url).href,
    new URL('../assets/audio/damage-03.mp3', import.meta.url).href,
    new URL('../assets/audio/damage-04.mp3', import.meta.url).href,
    new URL('../assets/audio/damage-05.mp3', import.meta.url).href,
  ],
  'damage-female': [new URL('../assets/audio/damage-female.mp3', import.meta.url).href],
  dying: [new URL('../assets/audio/dying.mp3', import.meta.url).href],
  'dying-female': [new URL('../assets/audio/dying-female.mp3', import.meta.url).href],
  death: [
    new URL('../assets/audio/death-01.mp3', import.meta.url).href,
    new URL('../assets/audio/death-02.mp3', import.meta.url).href,
    new URL('../assets/audio/death-03.mp3', import.meta.url).href,
    new URL('../assets/audio/death-04.mp3', import.meta.url).href,
  ],
  'death-female': [new URL('../assets/audio/death-female.mp3', import.meta.url).href],
  equip: [new URL('../assets/audio/equip.mp3', import.meta.url).href],
  'equip-mount': [new URL('../assets/audio/equip-mount.mp3', import.meta.url).href],
  victory: [new URL('../assets/audio/victory.mp3', import.meta.url).href],
  defeat: [new URL('../assets/audio/defeat.mp3', import.meta.url).href],
  'game-start': [new URL('../assets/audio/game-start.mp3', import.meta.url).href],
}

const MUSIC_URL = new URL('../assets/audio/paper-sanguo-bgm.mp3', import.meta.url).href

/** 已经解码好的采样。 */
const samples = new Map<SgsEffect, AudioBuffer[]>()
/** 正在下载/解码中的采样。同一个只发一次请求。 */
const loading = new Map<SgsEffect, Promise<void>>()

/**
 * 采样还没就绪时最多等多久（毫秒）。
 *
 * 开局音和采样预热是**同时开始**的：`prepare()` 刚发起解码，`GameStart`
 * 事件就到了。不等的话第一局可能听不到成品——而这恰恰是最该听到的一声。
 * 给一个短上限：等得到就放成品，等不到保持静音，不会把声音拖到几秒之后。
 */
const SAMPLE_WAIT_MS = 900

function loadSample(effect: SgsEffect): Promise<void> | null {
  const urls = SAMPLE_URLS[effect]
  if (!urls || samples.has(effect)) return null
  const existing = loading.get(effect)
  if (existing) return existing
  const audio = ensureContext()
  if (!audio) return null
  const task = Promise.all(urls.map((url) => fetch(url)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
    .then((data) => audio.decodeAudioData(data))))
    .then((buffers) => { samples.set(effect, buffers) })
    // 取不到或解不开就保持静音，不把对局卡住
    .catch(() => undefined)
    .finally(() => { loading.delete(effect) })
  loading.set(effect, task)
  return task
}

/** 预热：进对局时把所有成品音效解码好，免得第一次触发时还在加载。 */
function preloadSamples(): void {
  for (const effect of Object.keys(SAMPLE_URLS) as SgsEffect[]) loadSample(effect)
  loadMusic()
}

/** 立刻放一份已经解码好的采样。没就绪返回 false。 */
function variantIndex(key: string, length: number): number {
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  return Math.abs(hash) % length
}

function playSample(effect: SgsEffect, at: number, variantKey = ''): boolean {
  const buffers = samples.get(effect)
  if (!buffers?.length || !context || !effectsGain) return false
  const source = context.createBufferSource()
  source.buffer = buffers[variantIndex(variantKey || `${at}`, buffers.length)]
  source.connect(effectsGain)
  source.start(at)
  return true
}

/**
 * 采样正在解码时短暂等一下再放。
 *
 * 等到了就放成品；超时或失败保持静音。
 */
function playSampleWhenReady(effect: SgsEffect, variantKey: string): boolean {
  const task = loadSample(effect)
  if (!task) return false
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
  }
  window.setTimeout(finish, SAMPLE_WAIT_MS)
  void task.then(() => {
    if (settled) return
    settled = true
    if (context) playSample(effect, context.currentTime + .01, variantKey)
  })
  return true
}

export const sgsAudioSettings = reactive<SgsAudioSettings>(load())
export const sgsVibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
let context: AudioContext | null = null
let musicGain: GainNode | null = null
let effectsGain: GainNode | null = null
let musicBuffer: AudioBuffer | null = null
let musicLoading: Promise<void> | null = null
let musicSource: AudioBufferSourceNode | null = null
let active = false
const processed = new Set<string>()

function ensureContext(): AudioContext | null {
  if (context) return context
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null
  context = new AudioContextClass()
  musicGain = context.createGain(); effectsGain = context.createGain()
  musicGain.connect(context.destination); effectsGain.connect(context.destination)
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
  if (WEAPONS.includes(name) || ARMORS.includes(name)) return 'equip'
  if (MOUNTS.includes(name)) return 'equip-mount'
  return null
}

/** 事件到音色的映射独立导出，测试可验证全部牌类覆盖，不依赖浏览器音频。 */
export function effectForPresentation(event: PresentationEvent): SgsEffect | null {
  if (event.kind === 'game-start') return 'game-start'
  if (event.kind === 'turn-start' || event.kind === 'skill') return null
  // 属性伤害不分家：火焰、雷电扣血也走同一个 damage。
  // 「这一下是火」由使用【火攻】那张牌的音效表达，不在扣血这一步再分一次。
  if (event.kind === 'damage' || event.kind === 'lose-hp') return event.targetGender === 'female' ? 'damage-female' : 'damage'
  if (event.kind === 'recover') return 'recover'
  if (event.kind === 'draw' || event.kind === 'discard') return null
  if (event.kind === 'judge') {
    // 判定真正命中才播那张延时锦囊的效果音；没命中只留普通判定音
    const delayed = event.judgeReason ? DELAYED_TRICK_EFFECT[event.judgeReason] : undefined
    return delayed && event.judgeHit ? delayed : null
  }
  // LoseEquipment 只表示装备离开装备区，不能倒放成“装备成功”的声音。
  if (event.kind === 'equipment') return null
  if (event.kind === 'dying') return event.targetGender === 'female' ? 'dying-female' : 'dying'
  if (event.kind === 'death') return event.targetGender === 'female' ? 'death-female' : 'death'
  if (event.kind !== 'card-use' && event.kind !== 'card-response') return null
  if (event.cardEffect === false) return null
  return effectForCardName(event.cardName ?? '', event.kind)
}

function play(effect: SgsEffect, delay = 0, variantKey = ''): void {
  if (!sgsAudioSettings.effectsEnabled || document.hidden) return
  const audio = ensureContext(); if (!audio) return
  if (audio.state !== 'running') resume()
  const at = audio.currentTime + .018 + delay
  // 只放已上传并登记的 MP3；未登记的按钮、回合、摸弃牌等保持静音。
  if (playSample(effect, at, variantKey)) return
  // 文件登记了但还在解码：短暂等待，超时则保持静音
  if (SAMPLE_URLS[effect]) playSampleWhenReady(effect, variantKey)
}

function loadMusic(): Promise<void> | null {
  if (musicBuffer || musicLoading) return musicLoading
  const audio = ensureContext()
  if (!audio) return null
  musicLoading = fetch(MUSIC_URL)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
    .then((data) => audio.decodeAudioData(data))
    .then((buffer) => { musicBuffer = buffer })
    .catch(() => undefined)
    .finally(() => { musicLoading = null })
  return musicLoading
}
function startMusic(): void {
  if (!active || musicSource || !sgsAudioSettings.musicEnabled || document.hidden) return
  const audio = ensureContext(); if (!audio || audio.state !== 'running') return
  if (!musicBuffer) {
    const task = loadMusic()
    if (task) void task.then(() => { if (musicBuffer) startMusic() })
    return
  }
  const source = audio.createBufferSource()
  source.buffer = musicBuffer
  source.loop = true
  source.connect(musicGain!)
  source.start()
  musicSource = source
}
function stopMusic(): void {
  if (!musicSource) return
  try { musicSource.stop() } catch { /* 已经停止 */ }
  musicSource.disconnect()
  musicSource = null
}
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
    if (effect) play(effect, Math.min(index * .07, .28), event.id)
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
function buttonFeedback(): void { resume(); vibrate(8) }
function playResult(won: boolean): void {
  active = false
  stopMusic()
  play(won ? 'victory' : 'defeat', 0, won ? 'victory' : 'defeat')
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', resume, { once: true, passive: true })
  const restore = () => { if (document.hidden) stopMusic(); else { resume(); startMusic() } }
  document.addEventListener('visibilitychange', restore); window.addEventListener('pageshow', restore); window.addEventListener('focus', restore)
}

export const sgsAudio = { settings: sgsAudioSettings, setSetting, prepare, processEvents, playResult, stop, resume, buttonFeedback, play, vibrate }
