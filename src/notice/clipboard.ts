/**
 * 复制一段文本到剪贴板，兼容 Clipboard API 不可用的环境。
 *
 * 优先用 `navigator.clipboard`（需要安全上下文，Windows Chrome/Edge 和
 * iPhone Safari 在 https 下都支持）；拿不到就退回 `document.execCommand('copy')`
 * 这条老路径。两条都失败时返回 false，调用方仍然把号码摆在页面上让用户手选，
 * 不能因为复制失败就让联系弹窗整个坏掉。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续尝试下面的兼容方案 */
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    // 挪出可视区域，但不能用 display:none——部分浏览器不选中不可见节点的内容
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
