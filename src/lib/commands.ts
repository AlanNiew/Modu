/**
 * 极简命令总线：把「菜单里的动作」与「页面里的实现」解耦。
 *
 * 背景：顶部菜单栏改为全局固定后（P1 重构），「文件/阅读/视图/帮助」这些
 * 菜单项要触发的能力分别属于不同页面——加书签/搜索/侧栏在阅读页，导入
 * 在书架。如果把 ReaderPage 的几十个 state 全部提升到 App 才能接菜单，
 * 代价太大；让页面在挂载时注册命令、卸载时注销即可。
 *
 * 约定：
 * - `runCommand` 未注册时返回 false（菜单此时也不该可点，降级为无害 no-op）；
 * - 同 id 重复注册由最后一次生效（页面重复挂载/严格模式重挂载场景安全）；
 * - 清理函数不注销其它所有者的注册。
 *
 * 命令 id 一律使用 `CMD.*` 常量：菜单 spec（lib/menuSpec.ts）与注册方
 * （App / ReaderPage）两侧都对同一常量，裸字符串 typo 不会静默失效。
 */

export type CommandHandler = () => void
export type Unregister = () => void

const registry = new Map<string, CommandHandler>()

/** 全部命令 id 的唯一清单（注册方与菜单 spec 共同引用）。 */
export const CMD = {
  // App 注册：任何视图都能用
  appImportBooks: 'app.importBooks',
  appSettings: 'app.settings',
  appAbout: 'app.about',
  appHelp: 'app.help',
  appCheckUpdate: 'app.checkUpdate',
  appDataDir: 'app.dataDir',
  appQuit: 'app.quit',
  viewFullscreen: 'view.fullscreen',
  viewFontSizeUp: 'view.fontSizeUp',
  viewFontSizeDown: 'view.fontSizeDown',
  // App 注册：主题单选（view.theme.<id>）
  theme: (id: string) => `view.theme.${id}`,
  // ReaderPage 注册：仅阅读视图可用
  readerAddBookmark: 'reader.addBookmark',
  readerToc: 'reader.toc',
  readerBookmarks: 'reader.bookmarks',
  readerSearch: 'reader.search',
  readerSidebar: 'reader.sidebar',
  readerImmersive: 'reader.immersive',
  readerExportAnnotations: 'reader.exportAnnotations',
  readerReload: 'reader.reload',
  readerBack: 'reader.back',
} as const

/** 注册一个命令，返回注销函数。 */
export function registerCommand(id: string, run: CommandHandler): Unregister {
  registry.set(id, run)
  return () => {
    // 只有当当前注册者仍是自己时才注销，避免把后挂载者的注册误删。
    if (registry.get(id) === run) registry.delete(id)
  }
}

/** 合并多个注销函数，方便 `useEffect` 的清理 return 一次性返回。 */
export function unregisterAll(...unregisters: (Unregister | undefined)[]): Unregister {
  return () => {
    for (const fn of unregisters) fn?.()
  }
}

/** 执行命令；返回是否找到注册者。 */
export function runCommand(id: string): boolean {
  const run = registry.get(id)
  if (!run) return false
  run()
  return true
}
