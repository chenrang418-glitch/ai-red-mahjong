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
   * 座位和缩略图用的小图（480×640，约 30~65KB）。
   *
   * 对局里 5~8 个座位同时显示，这个尺寸是按「座位实际渲染尺寸 × 设备像素比」定的，
   * 再大只是白白多传字节。**不要在这里换成高清图**。
   */
  src: string
  /**
   * 艺术集单张查看用的高清图（约 1086×1448 原始分辨率，约 100~270KB）。
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
    desktop: { position: '50% 21%', scale: 1.0 },
    mobile: { position: '50% 19%', scale: 1.15 },
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
  /* 曹丕是半身像，冕旒压着额头，焦点略高才露得出脸 */
  caopi: {
    desktop: { position: '50% 18%', scale: 1.0 },
    mobile: { position: '50% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹丕',
  },
  /* 徐晃是半身像，头盔顶到画面很上方，焦点要压低一点才不会只看到盔缨 */
  xuhuang: {
    desktop: { position: '48% 20%', scale: 1.0 },
    mobile: { position: '48% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·徐晃',
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
  /* 孟获是半身像，脸略偏右，藤甲肩甲很占画面，焦点抬到脸上 */
  menghuo: {
    desktop: { position: '55% 19%', scale: 1.0 },
    mobile: { position: '55% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孟获',
  },
  /* 祝融是动态半身像，脸偏右上，握匕首的手在左边，焦点跟着脸走 */
  zhurong: {
    desktop: { position: '62% 20%', scale: 1.0 },
    mobile: { position: '62% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·祝融',
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

  zhangjiao: {
    desktop: { position: '50% 18%', scale: 1.0 },
    mobile: { position: '50% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张角',
  },

  yuji: {
    desktop: { position: '52% 18%', scale: 1.0 },
    mobile: { position: '52% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·于吉',
  },

  // ── 火包 ──
  dianwei: {
    desktop: { position: '45% 20%', scale: 1.0 },
    mobile: { position: '45% 18%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·典韦',
  },
  xunyu: {
    desktop: { position: '48% 18%', scale: 1.0 },
    mobile: { position: '48% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·荀彧',
  },
  taishici: {
    desktop: { position: '48% 18%', scale: 1.0 },
    mobile: { position: '48% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·太史慈',
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
  yuanshao: {
    desktop: { position: '55% 19%', scale: 1.0 },
    mobile: { position: '55% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·袁绍',
  },
  pangtong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·庞统',
  },
  wolongzhuge: {
    desktop: { position: '50% 18%', scale: 1.0 },
    mobile: { position: '50% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·卧龙诸葛',
  },

  /* 孙坚是半身像，红披风占了两侧，脸在正中偏上一点 */
  sunjian: {
    desktop: { position: '52% 18%', scale: 1.0 },
    mobile: { position: '52% 16%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙坚',
  },
  /* 鲁肃是文士半身像，脸在正中偏上，宽袖占了两侧 */
  lusu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·鲁肃',
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
  /*
   * 奶蛙是一张全身立绘，脑袋只占上面一小块。倍率给得比别人高一点，
   * 否则座位里看到的基本是肚子——焦点对准那张笑脸。
   */
  naiwa: {
    desktop: { position: '52% 15%', scale: 1.25 },
    mobile: { position: '52% 13%', scale: 1.4 },
    credit: '用户提供·奶蛙（原创娱乐武将）',
  },
  /* 牛来是全身立绘，那张张嘴的脸在偏上一点的位置，倍率给高一档才看得清 */
  niulai: {
    desktop: { position: '50% 14%', scale: 1.2 },
    mobile: { position: '50% 12%', scale: 1.35 },
    credit: '用户提供·牛来（原创娱乐武将）',
  },
  /* 许老板是半身立绘，脸在偏上位置，按娱乐包这几张的惯例给一档放大 */
  xulaoban: {
    desktop: { position: '50% 18%', scale: 1.15 },
    mobile: { position: '50% 16%', scale: 1.3 },
    credit: '用户提供·许老板（原创娱乐武将）',
  },
  /* 无亮同样是半身立绘，脸偏上，沿用娱乐包这几张的裁切惯例 */
  wuliang: {
    desktop: { position: '50% 18%', scale: 1.15 },
    mobile: { position: '50% 16%', scale: 1.3 },
    credit: '用户提供·无亮（原创娱乐武将）',
  },
  /* 奕星为上半身文士像，冠帽较高，焦点略微上移 */
  yixing: {
    desktop: { position: '50% 18%', scale: 1.05 },
    mobile: { position: '50% 16%', scale: 1.2 },
    credit: '用户提供·奕星（原创娱乐武将）',
  },
  /* 善水手持器物向前，脸在正中偏上，保留手部动作 */
  shanshui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·善水（原创娱乐武将）',
  },
  /* 贾诩是清瘦文士像，脸在正中略偏上 */
  jiaxu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·贾诩',
  },
  /* 董卓是宽体半身像，脸偏上，冠冕占了顶部一条 */
  dongzhuo: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·董卓',
  },
  pingtoufangkuai: {
    desktop: { position: '43% 30%', scale: 1.0 },
    mobile: { position: '43% 28%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·平头方块',
  },
  /*
   * ── 山包 ──
   * 竖构图半身像，按 docs/sanguosha-portraits.md 的竖构图基准值登记，再对着浏览器复核焦点。
   * **跟着武将逐个加**：这张表和 `allCharacterIds()` 必须一一对应
   * （tests/sanguosha-portrait-manifest.test.ts 钉着），提前给还没注册的武将加一项
   * 会让那条测试直接红掉。经典山包八将现已全部登记。
   */
  zhanghe: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张郃',
  },
  dengai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·邓艾',
  },
  jiangwei: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·姜维',
  },
  liushan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘禅',
  },
  sunce: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙策',
  },
  zhangzhaozhanghong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张昭张纮',
  },
  caiwenji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·蔡文姬',
  },
  zuoci: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·左慈',
  },
  /* ── 神将 ── 竖构图半身像，按规程基准值登记，再对着浏览器复核焦点 */
  shenguanyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神关羽',
  },
  shenlvmeng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神吕蒙',
  },
  shenzhouyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神周瑜',
  },
  shenzhugeliang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神诸葛亮',
  },
  shencaocao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神曹操',
  },
  shenlvbu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神吕布',
  },
  shenzhaoyun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神赵云',
  },
  shensimayi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神司马懿',
  },
  shenliubei: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神刘备',
  },
  shenluxun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神陆逊',
  },
  shenzhangliao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神张辽',
  },
  shenganning: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神甘宁',
  },
  shenguojia: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神郭嘉',
  },
  shenxunyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神荀彧',
  },
  shensunce: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神孙策',
  },
  shentaishici: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神太史慈',
  },
  shenhuatuo: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神华佗',
  },
  shenlusu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神鲁肃',
  },
  shenjiangwei: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神姜维',
  },
  shenmachao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神马超',
  },
  shenzhangjiao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神张角',
  },
  shendianwei: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神典韦',
  },
  shensunquan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神孙权',
  },
  shenhuangzhong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·神黄忠',
  },
  /* ── 一将成名 2011 ── 统一竖构图半身像 */
  caozhi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹植',
  },
  yujin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·于禁',
  },
  zhangchunhua: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张春华',
  },
  fazheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·法正',
  },
  masu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·马谡',
  },
  xushu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·徐庶',
  },
  lingtong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·凌统',
  },
  wuguotai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·吴国太',
  },
  xusheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·徐盛',
  },
  chengong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·陈宫',
  },
  gaoshun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·高顺',
  },
  /* ── 一将成名 2012 ── 统一竖构图半身像 */
  caozhang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹彰',
  },
  zhonghui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·钟会',
  },
  xunyou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·荀攸',
  },
  wangyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·王异',
  },
  liaohua: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·廖化',
  },
  guanxingzhangbao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·关兴张苞',
  },
  madai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·马岱',
  },
  chengpu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·程普',
  },
  handang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·韩当',
  },
  bulianshi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·步练师',
  },
  liubiao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘表',
  },
  huaxiong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·华雄',
  },
  /* ── 一将成名 2013 ── 统一竖构图半身像 */
  guohuai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·郭淮',
  },
  manchong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·满宠',
  },
  caochong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹冲',
  },
  guanping: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·关平',
  },
  jianyong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·简雍',
  },
  liufeng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘封',
  },
  panzhangmazhong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·潘璋马忠',
  },
  zhuran: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·朱然',
  },
  yufan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·虞翻',
  },
  liru: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·李儒',
  },
  fuhuanghou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·伏皇后',
  },
  /* ── 一将成名 2014 ── 统一竖构图半身像 */
  caozhen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹真',
  },
  chenqun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·陈群',
  },
  hanhaoshihuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·韩浩史涣',
  },
  wuyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·吴懿',
  },
  zhoucang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·周仓',
  },
  caifuren: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·蔡夫人',
  },
  caoang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹昂',
  },
  caochun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹纯',
  },
  caorui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹叡',
  },
  caoshuang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹爽',
  },
  caoxiu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·曹休',
  },
  chengyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·程昱',
  },
  chenlin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·陈琳',
  },
  dongbai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·董白',
  },
  dongyun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·董允',
  },
  feiyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·费祎',
  },
  gaolan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·高览',
  },
  gongsunyuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·公孙渊',
  },
  guanyinping: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·关银屏',
  },
  guosi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·郭汜',
  },
  guotufengji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·郭图逢纪',
  },
  guyong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·顾雍',
  },
  haozhao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·郝昭',
  },
  hetaihou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·何太后',
  },
  huangzu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·黄祖',
  },
  jianggan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·蒋干',
  },
  jushou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·沮授',
  },
  lijue: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·李傕',
  },
  lingcao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·凌操',
  },
  liuchen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘谌',
  },
  liuxie: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·刘协',
  },
  luji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·陆绩',
  },
  lvqian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·吕虔',
  },
  mayunlu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·马云騄',
  },
  mizhu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·糜竺',
  },
  panfeng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·潘凤',
  },
  panjun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·潘濬',
  },
  qinmi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·秦宓',
  },
  quanzong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·全琮',
  },
  shamoke: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·沙摩柯',
  },
  shixie: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·士燮',
  },
  sunluban: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙鲁班',
  },
  sunqian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙乾',
  },
  sunxiu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孙休',
  },
  tadun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·蹋顿',
  },
  tianchou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·田畴',
  },
  tianyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·田豫',
  },
  wangji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·王基',
  },
  wangping: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·王平',
  },
  xiahoushi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·夏侯氏',
  },
  xizhicai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·戏志才',
  },
  xujing: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·许靖',
  },
  xushi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·徐氏',
  },
  yangxiu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·杨修',
  },
  yanjun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·严畯',
  },
  yiji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·伊籍',
  },
  yuanshu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·袁术',
  },
  zhangchangpu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张昌蒲',
  },
  zhangni: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张嶷',
  },
  zhangsong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张松',
  },
  zhangxingcai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张星彩',
  },
  zhangxiu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·张绣',
  },
  zhongyao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·钟繇',
  },
  zhoufang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·周鲂',
  },
  zhugejin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛瑾',
  },
  zhugeke: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛恪',
  },
  zhugezhan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛瞻',
  },
  zhuhuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·朱桓',
  },
  zhuzhi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·朱治',
  },
  zumao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·祖茂',
  },
  zhugedan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛诞',
  },
  yuantanyuanshang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·袁谭袁尚',
  },
  guansuo: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·关索',
  },
  zhaoxiang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·赵襄',
  },
  baosanniang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·鲍三娘',
  },
  huaman: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·花鬘',
  },
  zhugeguo: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·诸葛果',
  },
  liyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·李严',
  },
  mengda: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·孟达',
  },
  pengyang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·彭羕',
  },
  xuyou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·许攸',
  },
  yanyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供（GPT 生成）·严颜',
  },
  baoxin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·鲍信',
  },
  beimihu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卑弥呼',
  },
  caimao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·蔡瑁',
  },
  caoteng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹腾',
  },
  caoxi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹羲',
  },
  caoxing: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹性',
  },
  chendeng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陈登',
  },
  chenggongying: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·成公英',
  },
  chengjichengcui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·成济成倅',
  },
  chunyuqiong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·淳于琼',
  },
  dingyuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·丁原',
  },
  donghe: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·董翓',
  },
  duxi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杜袭',
  },
  fanchou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·樊稠',
  },
  gongsunzan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·公孙瓒',
  },
  guanhai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·管亥',
  },
  guohuanghou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·郭皇后',
  },
  guotu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·郭图',
  },
  hanfu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·韩馥',
  },
  hejin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·何进',
  },
  huaxin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·华歆',
  },
  jiangwan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·蒋琬',
  },
  kebineng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·轲比能',
  },
  kongshu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孔淑',
  },
  liangxing: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·梁兴',
  },
  liubian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘辩',
  },
  liupi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘辟',
  },
  liuqi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘琦',
  },
  liuyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘焉',
  },
  lukai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陆凯',
  },
  lukang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陆抗',
  },
  lushi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卢氏',
  },
  luyusheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陆郁生',
  },
  luzhi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卢植',
  },
  lvlingqi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吕玲绮',
  },
  maridi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·马日磾',
  },
  maxiumatie: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·马休马铁',
  },
  miheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·祢衡',
  },
  niufu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·牛辅',
  },
  qianzhao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·牵招',
  },
  qinlang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·秦朗',
  },
  quyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·麹义',
  },
  simahui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·司马徽',
  },
  sunhao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙皓',
  },
  sunshao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙邵',
  },
  taoqian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陶谦',
  },
  wanglang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王朗',
  },
  wangrong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王荣',
  },
  weizi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卫兹',
  },
  wenpin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·文聘',
  },
  wenqin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·文钦',
  },
  wuanguo: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·武安国',
  },
  wujing: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吴景',
  },
  xiahouhui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·夏侯徽',
  },
  xiahouxuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·夏侯玄',
  },
  xinxianying: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·辛宪英',
  },
  xurong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·徐荣',
  },
  yangfu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杨阜',
  },
  yanpu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·阎圃',
  },
  yanrou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·阎柔',
  },
  yuanhuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·袁涣',
  },
  yuanji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·袁姬',
  },
  zhangbao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张宝',
  },
  zhangji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张济',
  },
  zhanglu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张鲁',
  },
  zhangmancheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张曼成',
  },
  zhangqiying: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张琪瑛',
  },
  zhaozhong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·赵忠',
  },
  zhujun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·朱儁',
  },
  zhuling: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·朱灵',
  },
  caiyong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·蔡邕',
  },
  caobao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹豹',
  },
  caojie: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹节',
  },
  caomao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹髦',
  },
  caosong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹嵩',
  },
  caoxiancaohua: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹宪曹华',
  },
  caoyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹宇',
  },
  cenhun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·岑昏',
  },
  chendao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陈到',
  },
  chengbing: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·程秉',
  },
  chenwudongxi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·陈武董袭',
  },
  dengzhi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·邓芝',
  },
  dufuren: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杜夫人',
  },
  duji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杜畿',
  },
  duyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杜预',
  },
  furong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·傅肜',
  },
  guozhao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·郭照',
  },
  heqi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·贺齐',
  },
  huanghao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·黄皓',
  },
  huanshujun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·环淑君',
  },
  huban: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·胡班',
  },
  huojun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·霍峻',
  },
  jiachong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·贾充',
  },
  jikang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·嵇康',
  },
  jin_simayi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·晋司马懿',
  },
  jin_zhangchunhua: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·晋张春华',
  },
  leitong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·雷铜',
  },
  liuba: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘巴',
  },
  liuhong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘宏',
  },
  liuxuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘璿',
  },
  liuyong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘永',
  },
  liuyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·刘虞',
  },
  luotong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·骆统',
  },
  luoxian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·罗宪',
  },
  luzhi_sp: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·鲁芝',
  },
  lvfan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吕范',
  },
  macheng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·马承',
  },
  mamiao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·马邈',
  },
  mayuanyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·马元义',
  },
  panghui: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·庞会',
  },
  panshu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·潘淑',
  },
  puyuan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·蒲元',
  },
  qinghegongzhu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·清河公主',
  },
  ruanji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·阮籍',
  },
  shibao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·石苞',
  },
  simafu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·司马孚',
  },
  simashi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·司马师',
  },
  simazhao: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·司马昭',
  },
  simazhou: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·司马伷',
  },
  sundeng: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙登',
  },
  sunru: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙茹',
  },
  sunyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙翊',
  },
  tangji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·唐姬',
  },
  wangchang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王昶',
  },
  wangjun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王濬',
  },
  wangxiang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王祥',
  },
  wangyuanji: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王元姬',
  },
  wangyun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·王允',
  },
  weiguan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卫瓘',
  },
  wenyang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·文鸯',
  },
  wulan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吴兰',
  },
  wutugu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·兀突骨',
  },
  wuxian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吴苋',
  },
  xiahouba: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·夏侯霸',
  },
  xiahoulingnv: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·夏侯令女',
  },
  xianglang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·向朗',
  },
  xuangongzhu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·宣公主',
  },
  xuelingyun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·薛灵芸',
  },
  xuezong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·薛综',
  },
  xunxu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·荀勖',
  },
  yanghu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·羊祜',
  },
  yanghuiyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·羊徽瑜',
  },
  yangyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杨艳',
  },
  yangzhi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·杨芷',
  },
  zhanghua: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张华',
  },
  zhangliang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张梁',
  },
  zhangling: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张陵',
  },
  zhangrang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张让',
  },
  zhangxun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张勋',
  },
  zhangyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张翼',
  },
  zhangyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张裕',
  },
  zhaotongzhaoguang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·赵统赵广',
  },
  zhaoyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·赵俨',
  },
  zhongyan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·钟琰',
  },
  zhouchu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·周处',
  },
  zhoufei: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·周妃',
  },
  zhouqun: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·周群',
  },
  zhugeshang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·诸葛尚',
  },
  zhujianping: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·朱建平',
  },
  bianfuren: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·卞夫人',
  },
  lvkai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吕凯',
  },
  shiyi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·是仪',
  },
  lvdai: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吕岱',
  },
  fengxi: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·冯熙',
  },
  lvju: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·吕据',
  },
  sunyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙瑜',
  },
  tengyin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·滕胤',
  },
  tenggongzhu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·滕公主',
  },
  sunchen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙綝',
  },
  tengfanglan: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·滕芳兰',
  },
  yuejin: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·乐进',
  },
  lidian: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·李典',
  },
  caohong: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹洪',
  },
  caofang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·曹芳',
  },
  sunluyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙鲁育',
  },
  xunchen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·荀谌',
  },
  zongyu: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·宗预',
  },
  zhangfen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·张奋',
  },
  sunzi_liufang: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·孙资刘放',
  },
  yuechen: {
    desktop: { position: '50% 19%', scale: 1.0 },
    mobile: { position: '50% 17%', scale: 1.15 },
    credit: '用户提供·乐綝',
  },
}

/**
 * **还没拿到立绘的武将。**
 *
 * 素材由用户分批上传，新武将上线时通常还没有图。这份名单让「每名武将都要有立绘」
 * 这条约束仍然成立——只是把「有图」放宽成「有图**或者**明确登记在这里等图」。
 *
 * 两件事因此仍然守得住：
 *
 * - 有人加了新武将却既没给图也没登记，测试照样红；
 * - 图到位之后必须把 id 从这里删掉，否则等于永远不接。
 *
 * 界面本身不看这份名单：缺图时 `characterPortrait` 返回 null，
 * 座位卡安静地回退到文字底纹。
 */
/*
 * 2026-09-15：批量接入了此前"素材目录/项目 portraits 目录找不到"以及
 * "源图比例是 2:3、和流水线要求的 3:4 对不上"的全部立绘（D:\cr\sanguoshalihui
 * 已经补齐/重新生成源图），脚本按角色名生成 480x640 座位图和高清图，
 * 全部移出这份名单、进了上面的 FRAMING。名单暂时清空，新武将上线且立绘
 * 还没到位时再往这里加。
 */
export const PENDING_PORTRAIT_IDS: readonly string[] = [
  // 历史人物第二十三批：素材目录/项目 portraits 目录都还没有对应文件，走 fallback
  'hujinding', 'caoanmin', 'zhaoang', 'xiahoujie', 'shia',
  'gexuan', 'tongyuan', 'zhaozhi', 'liuye', 'chengui',
]

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
