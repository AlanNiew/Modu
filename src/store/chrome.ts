import { create } from 'zustand'

/** chrome 默认标题字面量：初始态与 App 的视图复位共用一份。 */
export const DEFAULT_CHROME_TITLE = '墨读'
export const DEFAULT_CHROME_SUBTITLE = '图书馆'

/**
 * 标题栏内容状态：支撑「全局固定标题栏」模型（P1 重构）。
 *
 * 之前的模型是各页面自己渲染 TitleBar 并把菜单图标塞进 `actions`；
 * 现在标题栏在 App 里只渲染一次，页面只负责把「该展示什么标题/章节/
 * 是否沉浸」写进这里。书架和设置的标题由 App 在视图切换时重置，
 * Reader 页持续更新章节副标题；设置页的标题在 App 渲染层按视图覆盖，
 * chrome store 不感知视图，返回阅读时无需恢复数据。
 */
interface ChromeState {
  title: string
  subtitle: string | null
  /** 阅读页进入沉浸模式时为 true：App 隐藏整个标题栏。 */
  immersive: boolean
  set: (partial: Partial<Pick<ChromeState, 'title' | 'subtitle' | 'immersive'>>) => void
  /** 恢复一组默认值（书架/退出沉浸等场景）。 */
  reset: (title: string, subtitle: string | null) => void
}

export const useChromeStore = create<ChromeState>((set) => ({
  title: DEFAULT_CHROME_TITLE,
  subtitle: DEFAULT_CHROME_SUBTITLE,
  immersive: false,
  set: (partial) => set(partial),
  reset: (title, subtitle) => set({ title, subtitle, immersive: false }),
}))
