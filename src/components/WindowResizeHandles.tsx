import { getCurrentWindow } from '@tauri-apps/api/window'

// @tauri-apps/api 没有导出 ResizeDirection，这里按 API 文档的联合类型手写一份
type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

/**
 * 无边框窗口的缩放热区。
 *
 * `decorations: false` 之后 Windows 不再有原生 NCHITTEST 边框，必须自己
 * 在窗口四边/四角铺一层透明热区，按下时调用 `startResizeDragging(dir)`，
 * 把拖拽交回系统（跟原生边框的手感一致）。
 *
 * 厚度 5px、四角 12×12：够好点，又不挡内容；z-index 高于页面但低于弹层。
 */
const HANDLES: Array<{ direction: ResizeDirection; className: string }> = [
  { direction: 'North', className: 'left-3 right-3 top-0 h-[5px] cursor-n-resize' },
  { direction: 'South', className: 'left-3 right-3 bottom-0 h-[5px] cursor-s-resize' },
  { direction: 'West', className: 'top-3 bottom-3 left-0 w-[5px] cursor-w-resize' },
  { direction: 'East', className: 'top-3 bottom-3 right-0 w-[5px] cursor-e-resize' },
  {
    direction: 'NorthWest',
    className: 'left-0 top-0 h-3 w-3 cursor-nw-resize',
  },
  {
    direction: 'NorthEast',
    className: 'right-0 top-0 h-3 w-3 cursor-ne-resize',
  },
  {
    direction: 'SouthWest',
    className: 'left-0 bottom-0 h-3 w-3 cursor-sw-resize',
  },
  {
    direction: 'SouthEast',
    className: 'right-0 bottom-0 h-3 w-3 cursor-se-resize',
  },
]

export function WindowResizeHandles() {
  const appWindow = getCurrentWindow()

  return (
    <>
      {HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={`fixed z-[100] ${className}`}
          onMouseDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            void appWindow.startResizeDragging(direction)
          }}
        />
      ))}
    </>
  )
}
