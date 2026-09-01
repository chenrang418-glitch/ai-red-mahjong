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
  src: string
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
const FRAMING: Readonly<Record<string, Omit<CharacterPortrait, 'src'>>> = {
  // 目前没有已登记的立绘：原型阶段用的那批素材没有授权，已按用户决定全部撤除，
  // 等用户提供合法素材后再逐个加回来。加法照抄下面这个模板：
  //
  //   zhaoyun: {
  //     desktop: { position: '52% 20%', scale: 1.0 },   // 竖构图站姿的默认值
  //     mobile:  { position: '52% 18%', scale: 1.15 },  // 座位更矮，焦点上移、倍率高一档
  //     credit:  '<素材出处>',
  //   },
  //
  // position 就是脸在原图里的位置，同时喂给 object-position 和 transform-origin。
  // 横构图原图（宽 > 高）脸通常在中段，用 '40%' 上下的纵向焦点、1.05 / 1.20 的倍率。
  // 数值必须对着浏览器调，经验区间和验收清单见 docs/sanguosha-portraits.md。
}

const FILES = import.meta.glob<string>('./portraits/*.webp', { eager: true, import: 'default', query: '?url' })

function fileFor(characterId: string): string | null {
  return FILES[`./portraits/${characterId}.webp`] ?? null
}

export const CHARACTER_PORTRAITS: Readonly<Record<string, CharacterPortrait>> = Object.fromEntries(
  Object.entries(FRAMING)
    .map(([id, framing]) => {
      const src = fileFor(id)
      return src ? [id, { ...framing, src }] as const : null
    })
    .filter((entry): entry is readonly [string, CharacterPortrait] => entry !== null),
)

export function characterPortrait(characterId: string | null): CharacterPortrait | null {
  return characterId ? CHARACTER_PORTRAITS[characterId] ?? null : null
}
