/**
 * 「项目说明与免责声明」的全部展示文案，集中存放在这一个文件里。
 *
 * 首次访问弹窗（节选）和 Footer 打开的完整声明（全文）必须是同一份内容的
 * 两种呈现，不能各写一份——那样迟早会改一处漏一处，两边文字对不上。
 *
 * **联系方式不在这里**：「联系开发者」弹窗展示的号码由管理员在后台填写，
 * 走 `/api/service`（见 `useServiceStatus.ts`），不写死在前端代码里。
 * 声明正文里也不再提具体号码——号码随时可能被管理员改掉，写死在这份
 * 法律文本里只会越改越对不上。
 */

export const FIRST_VISIT_TITLE = '项目说明'

/** 首次访问弹窗正文，逐字对应任务要求，不做任何改写。 */
export const FIRST_VISIT_PARAGRAPHS: readonly string[] = [
  'CRPlay 是个人开发维护的非商业开源网页游戏项目，仅用于学习、技术研究及娱乐交流。',
  '本站部分游戏玩法与机制可能参考现有游戏作品；角色立绘、界面、背景、音乐等内容均由开发者自行制作或通过 AI 工具辅助生成。',
  'CRPlay 与相关游戏厂商及权利人不存在官方授权、合作或隶属关系。',
]

export const FULL_DISCLAIMER_TITLE = 'CRPlay 项目声明与免责声明'

export interface DisclaimerSection {
  /** 没有编号的引言段落用 heading 为空表示，正文按段落数组展示。 */
  heading: string
  paragraphs: readonly string[]
}

/** 完整声明正文，逐字对应任务要求。QQ 号从 CONTACT_QQ 插入，避免两处各写一次。 */
export const FULL_DISCLAIMER_SECTIONS: readonly DisclaimerSection[] = [
  {
    heading: '',
    paragraphs: [
      'CRPlay（crplay.cn）是个人开发并维护的非商业性质开源网页游戏项目，主要用于编程学习、技术研究以及娱乐交流。',
      '本站不提供付费游戏服务，不通过游戏内容、虚拟道具或相关功能进行商业盈利。',
    ],
  },
  {
    heading: '一、原创及 AI 生成内容',
    paragraphs: [
      'CRPlay 的角色立绘、游戏界面、背景、美术素材、音乐及部分其他内容由开发者自行设计、制作或通过人工智能工具辅助生成。',
      '相关 AI 生成或辅助生成内容不代表任何现实人物、组织、游戏厂商或其他权利人的官方作品或立场。',
      '如相关内容与既有作品存在非预期相似，将根据实际情况进行调整、替换或删除。',
    ],
  },
  {
    heading: '二、游戏玩法与第三方作品',
    paragraphs: [
      '本站部分游戏在玩法规则、角色设定、游戏术语或机制设计方面可能参考现有电子游戏、桌面游戏及其他公开作品。',
      'CRPlay 并非相关游戏的官方版本，与相关游戏开发商、发行商、运营商及其他权利人不存在授权、代理、合作、隶属或其他官方关系。',
      '相关游戏名称、角色名称、商标、作品名称以及其他依法受到保护的内容，其相关权利归各自权利人所有。',
      'CRPlay 不主张对第三方依法享有权利的内容拥有所有权。',
    ],
  },
  {
    heading: '三、开源代码',
    paragraphs: [
      'CRPlay 项目代码以开源形式发布。',
      '项目开发过程中可能参考或使用第三方开源项目、开源库及公开代码。相关内容的版权及许可条件归原作者或相应权利人所有，并按照对应开源许可证要求使用。',
    ],
  },
  {
    heading: '四、非商业用途',
    paragraphs: [
      'CRPlay 目前仅作为个人学习、技术研究及非商业娱乐项目运营。',
      '未经相关权利人授权，本站不会将第三方依法享有权利的内容用于商业销售、付费授权或其他未经许可的商业用途。',
    ],
  },
  {
    heading: '五、权利反馈与联系方式',
    paragraphs: [
      '如果相关权利人认为 CRPlay 中的任何内容侵犯其著作权、商标权或其他合法权益，或对项目中的相关内容存在合理异议，可联系开发者。',
      '联系时建议提供涉及内容、相关权利证明及具体诉求，以便进行核实处理。',
      '收到合理的权利主张并核实后，开发者将根据实际情况对相关内容进行删除、替换、修改或采取其他适当处理措施。',
      '本声明不构成对任何第三方合法权利的放弃、限制或否认。',
    ],
  },
]

export const CONTACT_TITLE = '联系开发者'
export const CONTACT_INTRO = '如有项目建议、内容反馈或权利相关问题，可联系开发者。'
/**
 * 服务端还没返回、或者管理员从没保存过设置时的兜底展示值，
 * 必须和 server/worker.ts 里 DEFAULT_SERVER_SETTINGS 的默认值保持一致，
 * 否则弹窗刚打开的一瞬间会闪一个和最终值不一样的号码。
 */
export const DEFAULT_CONTACT_METHOD = 'QQ'
export const DEFAULT_CONTACT_VALUE = '1507394636'

/** Footer 固定文案。 */
export const FOOTER_LINE_1 = 'CRPlay · 个人非商业开源项目'
export const FOOTER_LINE_2 = '部分内容由 AI 辅助生成 · 与相关游戏厂商无官方关联'
export const FOOTER_DISCLAIMER_LINK = '项目声明与免责声明'
export const FOOTER_CONTACT_LINK = '联系开发者'
/** 任务要求的固定文案，不随系统时间计算——避免和验收给出的文字不一致。 */
export const FOOTER_COPYRIGHT = '© 2026 CRPlay'
