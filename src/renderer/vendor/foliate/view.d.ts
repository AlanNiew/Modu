// vendored foliate-js 的最小类型声明（渲染实例只用到一小部分 API）。

export interface FoliateContents {
  doc: Document
  index: number
  overlayer?: unknown
}

export interface FoliateRenderer extends HTMLElement {
  /** 注入到章节文档 <head> 末尾的 CSS；数组形式为 [before, after] */
  setStyles(styles: string | [string, string]): void
  /** 重新计算列布局（字号/行高变化后调用） */
  render(): void
  getContents(): FoliateContents[]
  /** 滚动到指定锚点：Range/Element（精确到列）或 0..1 分数 */
  scrollToAnchor(anchor: Range | Element | number, select?: boolean): Promise<void>
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  goTo(target: unknown): Promise<void>
  /** 当前页（1 起） */
  readonly page: number
  /** 本章总页数 */
  readonly pages: number
}

export interface FoliateRelocateDetail {
  reason?: string
  index: number
  fraction?: number
  size?: number
  range?: Range
  tocItem?: unknown
}

export interface FoliateView extends HTMLElement {
  book: unknown
  renderer: FoliateRenderer
  lastLocation: unknown
  open(book: unknown): Promise<void>
  init(options: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>
  close(): void
  goTo(target: unknown): Promise<unknown>
  goToFraction(fraction: number): Promise<void>
  next(distance?: number): Promise<void>
  prev(distance?: number): Promise<void>
  goLeft(): Promise<void>
  goRight(): Promise<void>
  getCFI(index: number, range?: Range): string
}

export declare class View extends HTMLElement {}
