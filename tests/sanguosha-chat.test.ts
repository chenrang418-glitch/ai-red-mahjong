import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SgsChatDock from '@/sanguosha/components/SgsChatDock.vue'
import { SGS_QUICK_CHAT_EMOJIS, SGS_QUICK_CHAT_MESSAGES, type SgsChatMessage } from '@/sanguosha/online/protocol'

/**
 * 牌桌聊天。
 *
 * 服务端本来就支持聊天（`type: 'chat'`、`SgsChatMessage`、随房间状态广播），
 * 缺的一直只是前端界面。
 *
 * 弹窗内容要点开才存在，SSR 渲染的是初始状态，所以这里只覆盖「入口和数据」；
 * 展开后的收发由浏览器里两个真人对打验证，不在这里假装覆盖。
 */

function message(id: number, userId: string, text: string): SgsChatMessage {
  return { id, userId, nickname: userId === 'me' ? '我' : '对家', text, at: Date.UTC(2026, 8, 1, 3, 4) }
}

async function render(messages: SgsChatMessage[]): Promise<string> {
  return renderToString(createSSRApp(SgsChatDock, { messages, selfUserId: 'me' }))
}

describe('聊天入口', () => {
  it('默认只有右下角的圆钮，弹窗不占屏', async () => {
    const html = await render([])
    expect(html).toContain('sgs-chat__fab')
    expect(html).not.toContain('sgs-chat__sheet')
  })

  it('进房时已有的历史消息不算未读', async () => {
    // 挂载时把当时的条数记作已读，否则一进房间圆钮上就挂着一个红点
    const html = await render([message(1, 'other', '快点快点'), message(2, 'other', '666')])
    expect(html).not.toContain('sgs-chat__fab__badge')
    expect(html).not.toMatch(/<i[^>]*>\s*2\s*<\/i>/)
  })
})

describe('快捷短语', () => {
  it('用户逐条指定的六句都在，顺序也一致', () => {
    expect([...SGS_QUICK_CHAT_MESSAGES]).toEqual(['快点快点', '你会不会玩？', '666', '乐乐', '我是良民', '相信我'])
  })

  it('表情自成一组，且不照抄麻将的麻将牌', () => {
    expect(SGS_QUICK_CHAT_EMOJIS.length).toBeGreaterThanOrEqual(6)
    expect([...SGS_QUICK_CHAT_EMOJIS]).not.toContain('🀄')
    // 短语和表情不能混，界面上是分开两行排的
    for (const emoji of SGS_QUICK_CHAT_EMOJIS) expect([...SGS_QUICK_CHAT_MESSAGES]).not.toContain(emoji)
  })
})

describe('弹窗只装聊天', () => {
  const source = readFileSync(new URL('../src/sanguosha/components/SgsChatDock.vue', import.meta.url), 'utf8')

  it('组件只接聊天数据，不接战报和表现事件', () => {
    expect(source).toContain('SGS_QUICK_CHAT_MESSAGES')
    // 战报有顶栏自己的入口；混在一起时想找一句话要在一堆「谁摸了牌」里翻
    expect(source).not.toContain('presentationEvents')
    expect(source).not.toContain('log')
  })

  it('圆钮固定在右下角，弹窗从下方升起', () => {
    expect(source).toMatch(/\.sgs-chat__fab\s*\{[^}]*position:\s*fixed/)
    expect(source).toMatch(/\.sgs-chat__fab\s*\{[^}]*right:/)
    expect(source).toMatch(/\.sgs-chat__sheet\s*\{[^}]*bottom:\s*0/)
  })
})
