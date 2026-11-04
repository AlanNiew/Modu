//! 阅读定位（Locator）。
//!
//! 旧版用「像素滚动值」存进度，换字号/窗口大小立刻失准。这里改成
//! 「章节序号 + 章内分数」，恢复时交给 foliate renderer 的
//! `goTo({ index, anchor: fraction })` —— 与排版无关，重排后依然正确。
//!
//! 分数来自 paginator relocate 事件：分页模式下
//! `fraction = (page - 1) / (pages - 2)`，正好是 0..1 的章内相对位置。

export interface ReaderLocator {
  /** 结构版本，方便以后加文本锚点而不破坏旧数据 */
  v: 1
  /** spine 序号（0 起） */
  index: number
  /** 章内相对位置 0..1 */
  fraction: number
}

export function encodeLocator(index: number, fraction: number): string {
  const payload: ReaderLocator = {
    v: 1,
    index: Math.max(0, Math.round(index)),
    fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0,
  }
  return JSON.stringify(payload)
}

export function decodeLocator(raw: string | null | undefined): ReaderLocator | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ReaderLocator> | null
    if (!parsed || parsed.v !== 1) return null
    const index = Number(parsed.index)
    const fraction = Number(parsed.fraction)
    if (!Number.isFinite(index) || index < 0) return null
    return {
      v: 1,
      index: Math.round(index),
      fraction: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0,
    }
  } catch {
    return null
  }
}