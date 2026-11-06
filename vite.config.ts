import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const host = process.env.TAURI_DEV_HOST

// 顶层 package.json 的版本，构建时注入为 __APP_VERSION__，
// 「设置 → 关于」直接展示，避免 package.json / tauri.conf.json 双处维护漂移。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

// Tauri 要求固定端口；构建目标按运行平台选择（Windows=WebView2/Chromium）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // 只发 Windows（WebView2/Chromium 内核），统一按 chrome105 基线构建。
    // 不跟随 Tauri 模板的 safari13 分支：esbuild 无法把解构降级到 safari13，
    // 而 vendored foliate 的 tts.js（dynamic import）里含解构语法。
    target: 'chrome105',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
