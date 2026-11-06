import { CMD } from './commands'
import { THEME_OPTIONS } from '../renderer/theme'
import type { MenuEntry, MenuSectionSpec } from '../components/MenuBar'
import type { ThemeId } from '../renderer/theme'

/**
 * 全局固定菜单栏的声明式配置。
 *
 * 纯数据构建：除了主题单选用 `CMD.theme(id)` 生成命令 id，不需要闭包，
 * App 只负责「注册命令」而不负责「拼菜单」；条目的执行统一由 MenuBar
 * 内部 `runCommand(command)` 完成。
 */
export interface MenuDeps {
  /** 当前在书架视图（导入可用）。 */
  inShelf: boolean
  /** 当前有打开的书（阅读相关菜单可用）。 */
  inReader: boolean
  /** 全屏状态（视图菜单的对勾）。 */
  fullscreen: boolean
  /** 当前主题（主题子菜单的对勾）。 */
  theme: ThemeId
}

const item = (
  id: string,
  label: string,
  opts: { kb?: string; disabled?: boolean; checked?: boolean } = {},
): MenuEntry => ({ kind: 'item', id, label, command: id, ...opts })

export function buildMenuSections({
  inShelf,
  inReader,
  fullscreen,
  theme,
}: MenuDeps): MenuSectionSpec[] {
  const fileEntries: MenuEntry[] = [
    item(CMD.appImportBooks, '导入 EPUB…', { disabled: !inShelf }),
    item(CMD.readerExportAnnotations, '导出批注为 Markdown…', { disabled: !inReader }),
    { kind: 'separator' },
    item(CMD.appDataDir, '打开数据目录'),
    item(CMD.appSettings, '设置…'),
    item(CMD.appQuit, '退出墨读'),
  ]

  const readingEntries: MenuEntry[] = [
    item(CMD.readerAddBookmark, '添加书签', { kb: 'Ctrl+D', disabled: !inReader }),
    item(CMD.readerToc, '打开目录', { disabled: !inReader }),
    item(CMD.readerBookmarks, '书签列表', { disabled: !inReader }),
    item(CMD.readerSearch, '全书搜索', { kb: 'Ctrl+K', disabled: !inReader }),
    { kind: 'separator' },
    item(CMD.readerReload, '重新加载本书', { disabled: !inReader }),
    item(CMD.readerBack, '返回书架', { disabled: !inReader }),
  ]

  const viewEntries: MenuEntry[] = [
    item(CMD.readerSidebar, '收起 / 展开侧栏', { kb: 'Ctrl+B', disabled: !inReader }),
    item(CMD.readerImmersive, '专注阅读（沉浸模式）', { disabled: !inReader }),
    item(CMD.viewFullscreen, '全屏', { kb: 'F11', checked: fullscreen }),
    { kind: 'separator' },
    item(CMD.viewFontSizeUp, '增大字号', { disabled: !inReader }),
    item(CMD.viewFontSizeDown, '减小字号', { disabled: !inReader }),
    { kind: 'separator' },
    {
      kind: 'submenu',
      id: 'view.theme',
      label: '主题',
      items: THEME_OPTIONS.map((option): MenuEntry =>
        item(CMD.theme(option.id), option.label, {
          checked: theme === option.id,
        }),
      ),
    },
  ]

  const helpEntries: MenuEntry[] = [
    item(CMD.appHelp, '快捷键与帮助', { kb: 'F1' }),
    item(CMD.appCheckUpdate, '检查软件更新…'),
    item(CMD.appAbout, '关于墨读'),
  ]

  return [
    { id: 'file', label: '文件', entries: fileEntries },
    { id: 'reading', label: '阅读', entries: readingEntries },
    { id: 'view', label: '视图', entries: viewEntries },
    { id: 'help', label: '帮助', entries: helpEntries },
  ]
}
