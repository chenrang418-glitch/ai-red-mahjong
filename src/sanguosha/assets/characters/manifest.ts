/**
 * 武将立绘资源清单。
 *
 * 一张立绘在座位上要做的事，不是「铺满」而是「把脸放到该在的位置」。
 * 座位在 PC、手机竖屏、手机横屏三档下的宽高比差得很远，同一个焦点不可能都合适，
 * 所以每个武将各存一套 PC 和移动端的裁切参数，**不把具体武将的数值写进
 * `SgsSeat.vue`**——组件只负责把参数变成 CSS 变量。
 *
 * 图片走 `import.meta.glob`：素材目录是 gitignore 的（版权原因，见 .gitignore），
 * 没有图时这里就是一张空表，座位自动回退到原来的国风文字底纹，构建不会失败。
 */

export interface PortraitFraming {
  /** 焦点，直接给 CSS `object-position`。第一个值是脸的横向位置，第二个是纵向。 */
  position: string
  /** 放大倍率。1 = 恰好铺满立绘层；大于 1 用来把脸推到更显眼的尺寸。 */
  scale: number
}

export interface CharacterPortrait {
  /**
   * 座位和缩略图用的小图（360×480，约 20~35KB）。
   *
   * 对局里 5~8 个座位同时显示，这个尺寸是按「座位实际渲染尺寸 × 设备像素比」定的，
   * 再大只是白白多传字节。**不要在这里换成高清图**。
   */
  src: string
  /**
   * 艺术集单张查看用的高清图（1086×1448 原始分辨率，约 80~180KB）。
   *
   * 只在用户点开某一张时才请求，对局和列表都不会加载它，
   * 所以放大分辨率不会加重日常流量；缺高清图时回退到 `src`。
   */
  fullSrc: string
  desktop: PortraitFraming
  /** 手机（竖屏和横屏共用）。座位更矮更窄，通常要比 PC 再放大一点、焦点更靠脸。 */
  mobile: PortraitFraming
  /** 素材出处，便于回溯授权。 */
  credit: string
}

/**
 * 裁切参数与图片分开写：换素材时只改一行 `credit` 和文件，参数仍在这里对照调。
 *
 * 倍率是按「立绘铺满整个座位」调的。座位比原图矮而宽，所以 1.0 就已经是
 * 裁掉上下、露出中段；再往上加才是往脸上推。窄立绘层时期的那套倍率（1.6~3.2）
 * 在满幅下会把脸放到糊，别照抄。
 */
const FRAMING: Readonly<Record<string, Omit<CharacterPortrait, 'src' | 'fullSrc'>>> = {
  // ── 魏 ──
  caocao: {
    desktop: { position: '46% 17%', scale: 1.0 },
    mobile: { position: '46% 15%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹操',
  },
  simayi: {
    desktop: { position: '52% 22%', scale: 1.0 },
    mobile: { position: '52% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·司马懿',
  },
  xiahoudun: {
    desktop: { position: '45% 22%', scale: 1.0 },
    mobile: { position: '45% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·夏侯惇',
  },
  zhangliao: {
    desktop: { position: '60% 20%', scale: 1.0 },
    mobile: { position: '60% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张辽',
  },
  xuchu: {
    desktop: { position: '51% 15%', scale: 1.0 },
    mobile: { position: '51% 13%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·许褚',
  },
  guojia: {
    desktop: { position: '47% 20%', scale: 1.0 },
    mobile: { position: '47% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·郭嘉',
  },
  zhenji: {
    desktop: { position: '55% 22%', scale: 1.0 },
    mobile: { position: '55% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·甄姬',
  },
  // ── 蜀 ──
  liubei: {
    desktop: { position: '50% 17%', scale: 1.0 },
    mobile: { position: '50% 15%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘备',
  },
  guanyu: {
    desktop: { position: '47% 20%', scale: 1.0 },
    mobile: { position: '47% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·关羽',
  },
  zhangfei: {
    desktop: { position: '49% 22%', scale: 1.0 },
    mobile: { position: '49% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张飞',
  },
  zhaoyun: {
    desktop: { position: '50% 22%', scale: 1.0 },
    mobile: { position: '50% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·赵云',
  },
  machao: {
    desktop: { position: '52% 20%', scale: 1.0 },
    mobile: { position: '52% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·马超',
  },
  zhugeliang: {
    desktop: { position: '55% 18%', scale: 1.0 },
    mobile: { position: '55% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛亮',
  },
  huangyueying: {  // 场景图（在造连弩），脸比同批略小
    desktop: { position: '46% 22%', scale: 1.12 },
    mobile: { position: '46% 20%', scale: 1.3 },
    credit: '用户提供（GPT 生成）·黄月英',
  },
  // ── 吴 ──
  sunquan: {
    desktop: { position: '50% 18%', scale: 1.0 },
    mobile: { position: '50% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙权',
  },
  ganning: {
    desktop: { position: '58% 22%', scale: 1.0 },
    mobile: { position: '58% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·甘宁',
  },
  huanggai: {
    desktop: { position: '55% 20%', scale: 1.0 },
    mobile: { position: '55% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·黄盖',
  },
  lvmeng: {
    desktop: { position: '52% 21%', scale: 1.0 },
    mobile: { position: '52% 19%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·吕蒙',
  },
  zhouyu: {
    desktop: { position: '52% 20%', scale: 1.0 },
    mobile: { position: '52% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·周瑜',
  },
  daqiao: {  // 全批里脸最小且最靠右的一张，倍率单独调高
    desktop: { position: '70% 21%', scale: 1.3 },
    mobile: { position: '70% 19%', scale: 1.5 },
    credit: '用户提供（GPT 生成）·大乔',
  },
  sunshangxiang: {  // 动作姿势，脸偏右
    desktop: { position: '62% 24%', scale: 1.1 },
    mobile: { position: '62% 22%', scale: 1.28 },
    credit: '用户提供（GPT 生成）·孙尚香',
  },
  luxun: {
    desktop: { position: '52% 22%', scale: 1.0 },
    mobile: { position: '52% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·陆逊',
  },
  // ── 风包 ──
  weiyan: {
    desktop: { position: '56% 19%', scale: 1.0 },
    mobile: { position: '56% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·魏延',
  },
  huangzhong: {
    desktop: { position: '48% 20%', scale: 1.0 },
    mobile: { position: '48% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·黄忠',
  },
  xiaoqiao: {
    desktop: { position: '55% 22%', scale: 1.0 },
    mobile: { position: '55% 20%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·小乔',
  },
  xiahouyuan: {
    desktop: { position: '55% 20%', scale: 1.0 },
    mobile: { position: '55% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·夏侯渊',
  },

  caoren: {
    desktop: { position: '46% 20%', scale: 1.0 },
    mobile: { position: '46% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹仁',
  },

  zhoutai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·周泰',
  },

  // ── 火包 ──
  dianwei: {
    desktop: { position: '45% 20%', scale: 1.0 },
    mobile: { position: '45% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·典韦',
  },
  pangde: {
    desktop: { position: '48% 18%', scale: 1.0 },
    mobile: { position: '48% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·庞德',
  },
  // 双人构图：两张脸，焦点对准前景那个（文丑），否则小尺寸下两张脸都糊
  yanliangwenchou: {
    desktop: { position: '62% 30%', scale: 1.0 },
    mobile: { position: '62% 28%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·颜良文丑',
  },

  // ── 群 ──
  huatuo: {
    desktop: { position: '53% 20%', scale: 1.05 },
    mobile: { position: '53% 18%', scale: 1.2 },
    credit: '用户提供（GPT 生成）·华佗',
  },
  lvbu: {
    desktop: { position: '55% 20%', scale: 1.0 },
    mobile: { position: '55% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·吕布',
  },
  diaochan: {
    desktop: { position: '58% 24%', scale: 1.0 },
    mobile: { position: '58% 22%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·貂蝉',
  },

  // ── 好友娱乐包 ──
  pingtoufangkuai: {
    desktop: { position: '43% 30%', scale: 1.0 },
    mobile: { position: '43% 28%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·平头方块',
  },
}

const FILES = import.meta.glob<string>('./portraits/*.webp', { eager: true, import: 'default', query: '?url' })
/**
 * 高清图单独一个目录，和小图分开 glob。
 *
 * 这里仍然是 eager：拿到的只是一串 URL 字符串，浏览器要等 `<img>` 真正挂上去
 * 才会去下载，所以「全部登记」不等于「全部下载」。
 */
const FULL_FILES = import.meta.glob<string>('./portraits-full/*.webp', { eager: true, import: 'default', query: '?url' })

function fileFor(characterId: string): string | null {
  return FILES[`./portraits/${characterId}.webp`] ?? null
}

export const CHARACTER_PORTRAITS: Readonly<Record<string, CharacterPortrait>> = Object.fromEntries(
  Object.entries(FRAMING)
    .map(([id, framing]) => {
      const src = fileFor(id)
      if (!src) return null
      const fullSrc = FULL_FILES[`./portraits-full/${id}.webp`] ?? src
      return [id, { ...framing, src, fullSrc }] as const
    })
    .filter((entry): entry is readonly [string, CharacterPortrait] => entry !== null),
)

export function characterPortrait(characterId: string | null): CharacterPortrait | null {
  return characterId ? CHARACTER_PORTRAITS[characterId] ?? null : null
}
