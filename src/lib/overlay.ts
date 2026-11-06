/**
 * 弹层让路判断：Esc 阶梯（设置页返回 / 阅读页返回书架）共用。
 *
 * 目的：把「页面上有 Radix 弹层（Dialog/菜单）自己吃 Esc」的判断收敛到
 * 一处，避免 App 与 ReaderPage 各写一份 querySelector 而口径漂移。
 */

/** 当前是否有弹层打开（帮助面板、更新面板、下拉菜单等）。 */
export function isOverlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="menu"]')
}
