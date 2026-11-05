//! 阅读定位（Locator）。
//!
//! 旧版用「像素滚动值」存进度，换字号/窗口大小立刻失准。这里改成
//! 「章节序号 + 章内分数 + 文本锚点」：
//!
//! - `index` / `fraction`：约定恢复的起点，`goTo({ index, anchor: fraction })` 一步到位；
//! - `quote` / `prefix` / `suffix`：v2 起记录当前位置开头的一小段原文，恢复时若
//!   `fraction` 因重排偏了，就用文本锚点把位置拉回原句（与批注同一套定位算法）。
//!
//! v1 数据（只有 index/fraction）仍可解码，读出后按缺省文本锚点处理。

/** 文本锚点：引文 + 前后各一小段上下文，用于重排后重新定位。 */
export interface LocatorAnchor {
  quote: string
  prefix?: string
  suffix?: string
}

export interface ReaderLocatorV1 {
  v: 1
  index: number
  fraction: number
}

export interface ReaderLocatorV2 {
  v: 2
  /** spine 序号（0 起） */
  index: number
  /** 章内相对位置 0..1 */
  fraction: number
  /** 文本锚点：v1 升级上来的数据没有引文，允许缺省 */
  quote?: string
  prefix?: string
  suffix?: string
}

export type ReaderLocator = ReaderLocatorV2

const MAX_QUOTE = 60
const MAX_CONTEXT = 32

function clampFraction(fraction: number): number {
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
}

/** 把文本压成单行并截断：锚点只求「认得出来」，不要求逐字精确。 */
function normalizeAnchorText(text: string | undefined, limit: number): string | undefined {
  if (!text) return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > limit ? flat.slice(0, limit) : flat
}

export function encodeLocator(
  index: number,
  fraction: number,
  anchor?: LocatorAnchor | null,
): string {
  const payload: ReaderLocatorV2 = {
    v: 2,
    index: Math.max(0, Math.round(index)),
    fraction: clampFraction(fraction),
  }
  const quote = normalizeAnchorText(anchor?.quote, MAX_QUOTE)
  if (quote) {
    payload.quote = quote
    const prefix = normalizeAnchorText(anchor?.prefix, MAX_CONTEXT)
    const suffix = normalizeAnchorText(anchor?.suffix, MAX_CONTEXT)
    if (prefix) payload.prefix = prefix
    if (suffix) payload.suffix = suffix
  }
  return JSON.stringify(payload)
}

export function decodeLocator(raw: string | null | undefined): ReaderLocator | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as
      | (Partial<ReaderLocatorV1> & Partial<LocatorAnchor>)
      | null
    if (!parsed) return null
    const version = Number(parsed.v)
    if (version !== 1 && version !== 2) return null
    const index = Number(parsed.index)
    if (!Number.isFinite(index) || index < 0) return null
    const locator: ReaderLocator = {
      v: 2,
      index: Math.round(index),
      fraction: clampFraction(Number(parsed.fraction)),
    }
    const quote = normalizeAnchorText(parsed.quote, MAX_QUOTE)
    if (quote) {
      locator.quote = quote
      const prefix = normalizeAnchorText(parsed.prefix, MAX_CONTEXT)
      const suffix = normalizeAnchorText(parsed.suffix, MAX_CONTEXT)
      if (prefix) locator.prefix = prefix
      if (suffix) locator.suffix = suffix
    }
    return locator
  } catch {
    return null
  }
}
