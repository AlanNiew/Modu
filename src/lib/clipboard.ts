/**
 * 右键菜单用到的剪贴板/选区小工具。
 *
 * 说明：Tauri 的 WebView 里 `document.execCommand('copy')` 在用户手势内
 * 仍然可用，但 `navigator.clipboard` 更稳（两者都试一遍，谁成功算谁）。
 * 粘贴只能走 clipboard.readText()（execCommand('paste') 在页面里被禁用），
 * 失败时静默返回 false，由调用方决定是否提示。
 */

/** 当前主文档里选中的纯文本（未选中返回空串）。 */
export function selectedText(): string {
  return document.getSelection()?.toString() ?? ''
}

/** 复制一段文本；成功返回 true。 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 权限/上下文问题：退回 execCommand（需要有选区或临时 textarea）
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      return ok
    } catch {
      return false
    }
  }
}

/** 选中当前文档全部内容（潜在坑：会把菜单自己的文本也选进来，调用前已关菜单）。 */
export function selectAll(): void {
  const selection = document.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(document.body)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * 把剪贴板文本插入到当前焦点控件（input/textarea）的光标处。
 * 仅用于表单控件；正文区域不支持粘贴（属只读内容）。
 */
export async function pasteIntoFocused(): Promise<boolean> {
  const active = document.activeElement
  const isField =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  if (!isField) return false
  try {
    const text = await navigator.clipboard.readText()
    if (!text) return false
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? active.value.length
    active.setRangeText(text, start, end, 'end')
    // 让受控组件感知值变化（React 的 onChange 依赖 input 事件）
    active.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  } catch {
    return false
  }
}
