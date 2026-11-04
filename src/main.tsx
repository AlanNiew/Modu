import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import './index.css'
import { applyChromeTheme } from './renderer/theme'
import { useReaderSettings } from './store/settings'

// 首帧之前先注入主题色板：避免「先闪一下深色再变浅色」。
// persist 中间件在模块求值时同步读 localStorage，所以这里拿到的就是上次设置。
applyChromeTheme(useReaderSettings.getState().settings.theme)

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
